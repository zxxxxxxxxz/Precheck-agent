import {
  AgentCard, Task, TaskState, SendMessageRequest, SendMessageResponse, Role,
  type GetTaskRequest, type CancelTaskRequest,
} from '@a2a-js/sdk';
import { ServerCallContext, type A2ARequestHandler } from '@a2a-js/sdk/server';
import { RestRequestMalformedError, RestTaskNotFoundError, RestUnsupportedOperationError,
  A2AError, RestVersionNotSupportedError, restStatusFor, toRestErrorBody } from '@a2a-js/sdk/errors';
import { setTimeout as delay } from 'node:timers/promises';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { ResourceScopeSchema, type ServiceIdentity } from '@hsbc/contracts/identity';
import { AccessDenied } from '../auth/access.js';
import type { AgentTaskPort, AgentTaskRecord, ProtocolAuthorizer } from './ports.js';

const states = {
  submitted: TaskState.TASK_STATE_SUBMITTED, working: TaskState.TASK_STATE_WORKING,
  'input-required': TaskState.TASK_STATE_INPUT_REQUIRED, completed: TaskState.TASK_STATE_COMPLETED,
  failed: TaskState.TASK_STATE_FAILED, canceled: TaskState.TASK_STATE_CANCELED,
};
/** SDK 1.3 has no deadline subclass; use its public error base and standard REST status. */
export class A2AWaitDeadline extends A2AError {
  override readonly reason = 'DEADLINE_EXCEEDED';
  readonly transport = 'rest';
  readonly statusCode = 504;
  constructor(readonly taskId: string) {
    super({ message: `Wait deadline exceeded; query accepted task ${taskId}`, metadata: { taskId } });
  }
}
export function projectA2ATask(record: AgentTaskRecord): Task {
  return Task.fromJSON({ id: record.id, contextId: record.contextId,
    status: { state: states[record.state], timestamp: record.updatedAt },
    metadata: { caseId: record.caseId, revision: record.revision, cancelRequested: record.cancelRequested ?? false },
    artifacts: (record.artifactRefs ?? []).map((ref, i) => ({ artifactId: `${record.id}-${i}`, parts: [{ data: { artifactRef: ref } }] })),
  });
}
export function p0AgentCard(baseUrl: string): AgentCard {
  return AgentCard.fromJSON({ name: 'P0 synthetic document agent', version: '0.0.1',
    description: 'Synthetic protocol and durable workflow experiment; no banking decisions.',
    supportedInterfaces: [{ url: `${baseUrl}/internal/a2a`, protocolBinding: 'HTTP+JSON', protocolVersion: '1.0' }],
    capabilities: { streaming: false, pushNotifications: false },
    defaultInputModes: ['text/plain'], defaultOutputModes: ['application/json'],
    securitySchemes: { bearer: { httpAuthSecurityScheme: { scheme: 'bearer', bearerFormat: 'JWT' } } },
    securityRequirements: [{ schemes: { bearer: { list: [] } } }],
    skills: [{ id: 'p0-durable-task', name: 'P0 durable task', description: 'Exercises durable dispatch and human waiting.', tags: ['synthetic'] }],
  });
}
/** Uses only SDK public contracts/codecs. HTTP glue is intentionally Fastify-specific. */
export function createA2ARequestHandler(card: AgentCard, authorizer: ProtocolAuthorizer, tasks: AgentTaskPort,
  options: { waitTimeoutMs?: number; pollIntervalMs?: number } = {}): A2ARequestHandler {
  const identity = (context: ServerCallContext) => {
    const value = context.state.get('p0.identity') as ServiceIdentity | undefined;
    if (!value) throw new AccessDenied('authentication_required', 401);
    return value;
  };
  const unsupported = async (): Promise<never> => { throw new RestUnsupportedOperationError(); };
  const lookup = async (params: GetTaskRequest | CancelTaskRequest, context: ServerCallContext, cancel: boolean) => {
    if (params.tenant) throw new RestRequestMalformedError();
    const scope = await authorizer.authorize(identity(context), cancel ? 'a2a:cancel' : 'a2a:get');
    let record = await tasks.get(params.id, scope);
    if (!record) throw new RestTaskNotFoundError();
    await authorizer.authorize(identity(context), cancel ? 'a2a:cancel' : 'a2a:get', { caseId: record.caseId, revision: record.revision, taskId: record.id });
    if (cancel) record = await tasks.requestCancel(params.id, scope);
    if (!record) throw new RestTaskNotFoundError();
    return projectA2ATask(record);
  };
  return {
    getAgentCard: async () => card,
    getAuthenticatedExtendedAgentCard: unsupported,
    async sendMessage(params, context) {
      const message = params.message;
      if (!message?.messageId || message.role !== Role.ROLE_USER || message.taskId || message.contextId || params.tenant ||
          !message.parts.length || message.parts.some(p => p.content?.$case !== 'text') ||
          params.configuration?.taskPushNotificationConfig) {
        throw new RestRequestMalformedError();
      }
      const parsed = ResourceScopeSchema.safeParse(message.metadata);
      if (!parsed.success) throw new RestRequestMalformedError();
      const scope = await authorizer.authorize(identity(context), 'a2a:send', parsed.data);
      const input = message.parts.map(p => p.content?.value).join('\n');
      if (input.length > 8000) throw new RestRequestMalformedError();
      let record = await tasks.submit({ messageId: message.messageId, scope, input });
      if (params.configuration?.returnImmediately) return projectA2ATask(record);
      const deadline = Date.now() + (options.waitTimeoutMs ?? 30_000);
      const signal = context.state.get('p0.waitSignal') as AbortSignal | undefined;
      while (record.state === 'submitted' || record.state === 'working') {
        if (Date.now() >= deadline) throw new A2AWaitDeadline(record.id);
        await delay(Math.min(options.pollIntervalMs ?? 100, Math.max(1, deadline - Date.now())), undefined, { signal });
        const current = await authorizer.authorize(identity(context), 'a2a:send', { caseId: record.caseId, revision: record.revision, taskId: record.id });
        const next = await tasks.get(record.id, current);
        if (!next) throw new RestTaskNotFoundError();
        record = next;
      }
      return projectA2ATask(record);
    },
    getTask: (params, context) => lookup(params, context, false),
    cancelTask: (params, context) => lookup(params, context, true),
    async *sendMessageStream() { throw new RestUnsupportedOperationError(); },
    async *resubscribe() { throw new RestUnsupportedOperationError(); },
    listTasks: unsupported, createTaskPushNotificationConfig: unsupported, getTaskPushNotificationConfig: unsupported,
    listTaskPushNotificationConfigs: unsupported, deleteTaskPushNotificationConfig: unsupported,
  };
}

export async function registerP0A2A(app: FastifyInstance, options: {
  baseUrl: string; authorizer: ProtocolAuthorizer; tasks: AgentTaskPort;
  waitTimeoutMs?: number; pollIntervalMs?: number;
}) {
  const card = p0AgentCard(options.baseUrl);
  const handler = createA2ARequestHandler(card, options.authorizer, options.tasks, options);
  const context = async (request: FastifyRequest, discover = false) => {
    const authenticated = await options.authorizer.authenticate(request.headers.authorization);
    if (discover) await options.authorizer.authorize(authenticated, 'a2a:discover');
    const version = request.headers['a2a-version'];
    if (!discover && version !== '1.0') throw new RestVersionNotSupportedError();
    return new ServerCallContext({ requestedVersion: '1.0',
      user: { isAuthenticated: true, userName: authenticated.serviceId },
      state: new Map([['p0.identity', authenticated]]),
    });
  };
  const wrap = (operation: (request: FastifyRequest, reply: FastifyReply) => Promise<unknown>) =>
    async (request: FastifyRequest, reply: FastifyReply) => {
      try { reply.type('application/a2a+json'); return await operation(request, reply); }
      catch (error) {
        if (reply.raw.destroyed) return;
        if (error instanceof AccessDenied) return reply.code(error.statusCode).send({ error: error.code });
        if (error instanceof A2AWaitDeadline) {
          const body = toRestErrorBody(error, 504);
          body.error.status = 'DEADLINE_EXCEEDED';
          return reply.code(504).header('x-a2a-task-id', error.taskId).header('location', `/internal/a2a/tasks/${encodeURIComponent(error.taskId)}`).send(body);
        }
        const status = restStatusFor(error);
        return reply.code(status).send(toRestErrorBody(error, status));
      }
    };
  if (!app.hasContentTypeParser('application/a2a+json')) {
    const json = app.getDefaultJsonParser('error', 'error');
    app.addContentTypeParser('application/a2a+json', { parseAs: 'string' }, (request, body, done) => {
      if (body === '') { done(null, {}); return; }
      json(request, String(body), done);
    });
  }
  app.get('/internal/a2a/.well-known/agent-card.json', wrap(async request => {
    await context(request, true); return AgentCard.toJSON(await handler.getAgentCard());
  }));
  app.post('/internal/a2a/message::send', wrap(async (request, reply) => {
    const ctx = await context(request);
    const abort = new AbortController();
    const closed = () => { if (!reply.raw.writableEnded) abort.abort(); };
    reply.raw.once('close', closed);
    ctx.state.set('p0.waitSignal', abort.signal);
    try {
      const task = await handler.sendMessage(SendMessageRequest.fromJSON(request.body), ctx) as Task;
      return SendMessageResponse.toJSON({ payload: { $case: 'task', value: task } });
    } finally { reply.raw.off('close', closed); }
  }));
  app.get('/internal/a2a/tasks/:id', wrap(async request => {
    const ctx = await context(request);
    const query = request.query as Record<string, unknown>;
    if (query.historyLength !== undefined && (!/^\d+$/.test(String(query.historyLength)))) throw new RestRequestMalformedError();
    return Task.toJSON(await handler.getTask({ id: (request.params as { id: string }).id, tenant: '' }, ctx));
  }));
  app.post('/internal/a2a/tasks/:id([^:]+)::cancel', { onRequest: async request => {
    // The official REST client sends Content-Type: application/json on a bodyless cancel.
    // Fastify rejects empty JSON before the handler; normalize only this bodyless operation.
    if (request.headers['content-length'] === '0' && !request.headers['transfer-encoding']) delete request.headers['content-type'];
  } }, wrap(async request => {
    const ctx = await context(request);
    return Task.toJSON(await handler.cancelTask({ id: (request.params as { id: string }).id, tenant: '', metadata: undefined }, ctx));
  }));
}
