import { McpServer } from '@modelcontextprotocol/server';
import { NodeStreamableHTTPServerTransport } from '@modelcontextprotocol/node';
import { hostHeaderValidation } from '@modelcontextprotocol/fastify';
import type { FastifyInstance } from 'fastify';
import { p0Tools, toolSchemas, type P0ToolName, type ToolInput } from '@hsbc/contracts/tools';
import { AccessDenied } from '../auth/access.js';
import type { ProtocolAuthorizer, ToolPort } from './ports.js';

export async function registerP0MCP(app: FastifyInstance, options: {
  authorizer: ProtocolAuthorizer; tools: ToolPort; allowedHosts?: string[];
}) {
  await app.register(async scoped => {
    scoped.addHook('onRequest', hostHeaderValidation(options.allowedHosts ?? ['127.0.0.1', 'localhost', '[::1]']));
    scoped.addHook('onRequest', async request => {
      if (request.headers.origin) throw new AccessDenied('browser_origin_not_allowed');
    });
    scoped.post('/internal/mcp', async (request, reply) => {
      const identity = await options.authorizer.authenticate(request.headers.authorization);
      await options.authorizer.authorize(identity, 'mcp:connect');
      const server = new McpServer({ name: 'p0-business-tools', version: '0.0.1' });
      for (const name of p0Tools) {
        server.registerTool(name, { description: `P0 synthetic ${name}`, inputSchema: toolSchemas[name] }, async (raw: unknown) => {
          try {
            const input = toolSchemas[name].parse(raw) as ToolInput<P0ToolName>;
            const scope = await options.authorizer.authorize(identity, name, input);
            const result = await options.tools.call(name, input, scope);
            return { content: [{ type: 'text' as const, text: JSON.stringify(result) }], structuredContent: result };
          } catch (error) {
            return { isError: true, content: [{ type: 'text' as const, text: error instanceof AccessDenied ? error.code : 'tool_failed' }] };
          }
        });
      }
      const transport = new NodeStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
      await server.connect(transport);
      reply.hijack();
      reply.raw.once('close', () => { void transport.close(); void server.close(); });
      await transport.handleRequest(request.raw, reply.raw, request.body);
    });
    scoped.route({ method: ['GET', 'DELETE'], url: '/internal/mcp', handler: async (request, reply) => {
      const identity = await options.authorizer.authenticate(request.headers.authorization);
      await options.authorizer.authorize(identity, 'mcp:connect');
      return reply.code(405).header('allow', 'POST').send({ error: 'stateless_transport' });
    } });
  });
}
