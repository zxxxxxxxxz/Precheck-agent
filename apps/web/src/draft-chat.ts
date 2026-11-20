import {GUARANTEE_LABELS} from '@hsbc/contracts/mixed-guarantee';
import {AbstractChatProvider, XRequest, type SSEOutput, type TransformMessage, type XRequestOptions} from '@ant-design/x-sdk';
import {z} from 'zod';
import {CASE_JURISDICTIONS, CASE_CURRENCIES, CaseDraftSchema, IntakeFieldSchema, CASE_FIELD_LIMITS, type IntakeField} from '@hsbc/contracts/draft';
import {ApiError, sessionStream} from './api.ts';

const CandidateSchema = z.object({candidateId: z.uuid(), field: IntakeFieldSchema, value: z.string().max(CASE_FIELD_LIMITS.background), sourceRefs: z.array(z.string().max(600)).optional()});
const SuggestionSchema = z.object({questions: z.array(z.object({field: IntakeFieldSchema, code: z.enum(['missing', 'ambiguous', 'unsupported_scenario', 'use_form'])})).max(8), candidates: z.array(CandidateSchema).max(9)});
export const ReplyBlockSchema = z.object({id: z.string().max(200), text: z.string().max(20_000), sourceRefs: z.array(z.string().max(600)).default([])});
export const IntakeStepSchema = z.object({key: z.enum(['attachments', 'privacy', 'organizing', 'filling']), title: z.string().max(100), status: z.enum(['pending', 'running', 'completed', 'failed']), summary: z.string().max(1000).optional(), durationMs: z.number().nonnegative().optional()});
export const IntakeEventSchema = z.object({
  seq: z.number().int().nonnegative(), turnId: z.uuid(), requestId: z.uuid(), draftRevision: z.number().int().positive(),
  type: z.enum(['stage', 'suggestion', 'step', 'assistant_delta', 'draft_updated', 'completed', 'failed', 'canceled']),
  stage: z.enum(['organizing', 'privacy_check', 'generating', 'ready']).optional(), suggestion: SuggestionSchema.optional(), errorCode: z.string().max(100).optional(),
  step: IntakeStepSchema.optional(), block: ReplyBlockSchema.optional(), draft: CaseDraftSchema.optional(),
  appliedFields: z.array(IntakeFieldSchema).optional(), conflictFields: z.array(IntakeFieldSchema).optional(), baseRevision: z.number().int().positive().optional(), resultRevision: z.number().int().positive().optional(),
});
export type DraftSuggestion = z.infer<typeof SuggestionSchema>;
export type IntakeEvent = z.infer<typeof IntakeEventSchema>;
export type IntakeStep = z.infer<typeof IntakeStepSchema>;
export type ReplyBlock = z.infer<typeof ReplyBlockSchema>;
export interface DraftTurn {
  id: string; clientTurnId: string; draftId: string; draftRevision: number; resultRevision?: number | null;
  status: 'pending' | 'running' | 'ready' | 'failed' | 'canceled' | 'unknown' | 'stale';
  text: string; events: IntakeEvent[]; suggestion?: DraftSuggestion | null; errorCode?: string; createdAt: string;
  replyBlocks?: ReplyBlock[]; questions?: string[]; attachmentIds?: string[]; appliedFields?: IntakeField[]; conflictFields?: IntakeField[];
}
export interface IntakeMessage {role: 'user' | 'assistant'; content: string; turnId: string; requestId: string; draftRevision: number; suggestion?: DraftSuggestion; seq?: number; replyBlocks?: ReplyBlock[]; steps?: IntakeStep[]; appliedFields?: IntakeField[]; conflictFields?: IntakeField[]; resultRevision?: number; terminal?: boolean; connectionNotice?: string}
export interface IntakeRequest {turnId: string; clientTurnId: string; text: string; draftRevision: number; after: number; resume?: IntakeMessage}
export const fieldLabels: Record<IntakeField, string> = {scenario: '业务场景', title: '案件标题', reference: '参考标识', background: '背景说明', customerNumber: '客户号', jurisdiction: '司法管辖地', guaranteeCurrency: '币种', guaranteeAmount: '担保金额', guaranteeTypes: '担保类型'};
const stages = {organizing: '正在整理信息', privacy_check: '正在处理隐私信息', generating: '正在整理回复', ready: '已整理完成'};
export const intakeErrorText: Record<string, string> = {model_result_not_committed: '模型已完成处理，但本轮结果未能安全保存，表单未更新。请核对后重新发送。',
  egress_denied: '本轮未通过隐私或模型结果校验，未写入案件信息。请核对输入或联系管理员检查处理记录。',
  budget_exhausted: '本轮可用处理预算已用完，请减少内容或联系管理员调整额度。',
  input_budget_exhausted: '所选内容超过本轮处理容量，请减少附件或分次补充。',
  assistant_configuration_required: '建案助手尚未就绪，请联系管理员检查模型配置；可继续手动填写。',
  attachment_parser_unavailable: '附件读取服务暂不可用，请稍后重试或手动填写，原件已保留。',
  attachment_text_empty: '附件未读出可用文字，请上传清晰、可读取的原件，或直接描述案件。',
  attachment_coverage_incomplete: '附件内容未能完整读取，本轮没有回填。请核对原件或拆分文件后重试。',
  call_budget_exhausted: '本轮模型调用额度已用完，请减少输入或联系管理员调整额度。',
  invalid_output: '模型回复未通过结构校验，本轮没有回填。请稍后重试或手动填写。',
  truncated: '模型回复不完整，本轮没有回填。请减少内容后重试。',
  refused: '模型未能处理此轮内容，请调整描述后重试或手动填写。',
  stale_draft_revision: '草稿已被更新，本轮结果没有写入。请核对最新案件信息。',
  model_capability_disabled: '建案模型暂未启用，请联系管理员；可继续手动填写。',
  provider_rejected: '模型服务未接受本轮请求，请稍后重试；若持续发生，请联系管理员。',
  provider_drift: '模型服务配置与已核准配置不一致，请联系管理员核对配置。',
  timeout: '本轮处理超时，可减少输入内容后重试，或继续手动填写。',
privacy_projection_failed: '隐私处理未通过，本轮信息没有发送给云端模型。请核对内容后重试。', privacy_scan_failed: '隐私校验未通过，请核对输入内容后重试。', attachment_parse_failed: '附件读取失败。可保留原件并手动填写，或重新上传可读取的文件。', input_budget_exceeded: '本轮信息超过处理容量，请减少所选附件或分次补充。', model_unavailable: '建案助手暂不可用，可继续手动填写。', capability_disabled: '建案助手暂不可用，可继续手动填写。', execution_unknown: '本轮结果尚不确定，请重新连接查看状态，勿重复发送。'};
export function fieldValueText(field: IntakeField, value: string): string {
  if (field === 'scenario' && value === 'overseas_loan') return '境外贷款';
  if (field === 'jurisdiction') return CASE_JURISDICTIONS.find(option => option.value === value)?.label ?? value;
  if (field === 'guaranteeCurrency') return CASE_CURRENCIES.find(option => option.value === value)?.label ?? value;
  if (field === 'guaranteeTypes') {
    try { const types: unknown = JSON.parse(value); if (Array.isArray(types) && types.every(type => typeof type === 'string')) return types.map(type => GUARANTEE_LABELS[type] ?? type).join('、'); } catch { /* Preserve historical unknown values for review. */ }
  }
  return value;
}
export function questionText(question: DraftSuggestion['questions'][number]) {
  if (question.code === 'unsupported_scenario') return '当前仅支持境外贷款，请核对业务场景。';
  if (question.code === 'use_form') return `请直接在案件信息中填写${fieldLabels[question.field]}。`;
  return question.code === 'ambiguous' ? `${fieldLabels[question.field]}有不明确的信息，请补充或直接填写。` : `请补充${fieldLabels[question.field]}。`;
}
export function turnStatusText(turn: DraftTurn) {
  const reply = turn.replyBlocks?.map(block => block.text).join('\n\n');
  const status = turn.errorCode && intakeErrorText[turn.errorCode] || ({pending: '等待整理信息', running: '正在整理信息', ready: '已整理完成，请核对案件信息。', failed: '本次未能完成整理，可继续填写案件信息或稍后重试。', canceled: '已取消，草稿内容保留。', unknown: '处理结果尚不确定，请重新连接；不要重复发送。', stale: '草稿已更新，此轮结果未写入。'})[turn.status];
  return reply ? ['failed', 'canceled', 'stale', 'unknown'].includes(turn.status) ? `${reply}\n\n${status}` : reply : status;
}
export function turnMessage(turn: DraftTurn): IntakeMessage {
  const steps = new Map<string, IntakeStep>();
  for (const event of turn.events ?? []) if (event.step) steps.set(event.step.key, event.step);
  return {role: 'assistant', content: turnStatusText(turn), turnId: turn.id, requestId: turn.clientTurnId, draftRevision: turn.draftRevision, seq: Math.max(0, ...turn.events.map(event => event.seq)), suggestion: turn.suggestion ?? undefined, replyBlocks: turn.replyBlocks, steps: settleSteps([...steps.values()], ['failed', 'canceled', 'stale', 'unknown'].includes(turn.status)), appliedFields: turn.appliedFields, conflictFields: turn.conflictFields, resultRevision: turn.resultRevision ?? undefined, terminal: !['pending', 'running'].includes(turn.status)};
}
function settleSteps(steps: IntakeStep[] | undefined, failed: boolean) {return failed ? steps?.map(step => step.status === 'running' || step.status === 'pending' ? {...step, status: 'failed' as const, summary: '本轮已停止，未继续处理。'} : step) : steps;}
/** A transport failure must not replace the newest reply and durable cursor with the initial snapshot. */
export function intakeRequestFallback(input: Partial<IntakeRequest>, error: Error, latest?: IntakeMessage): IntakeMessage {
  const prior = latest?.turnId === input.turnId ? latest : input.resume;
  return {...prior, role: 'assistant', content: prior?.content ?? '正在核对处理状态', turnId: input.turnId!, requestId: input.clientTurnId!, draftRevision: input.draftRevision!, connectionNotice: error.name === 'AbortError' ? '已停止接收，正在核对处理状态。' : '连接中断，正在查询处理结果。也可重新连接；请勿重复发送。'};
}
const terminalEvent = (event: IntakeEvent) => ['completed', 'failed', 'canceled'].includes(event.type);
function pause(ms: number, signal?: AbortSignal | null) {return new Promise<void>((resolve, reject) => {if (signal?.aborted) {reject(new DOMException('Aborted', 'AbortError')); return;} const stop = () => {clearTimeout(timer); reject(new DOMException('Aborted', 'AbortError'));}; const timer = setTimeout(() => {signal?.removeEventListener('abort', stop); resolve();}, ms); signal?.addEventListener('abort', stop, {once: true});});}
const intakeReadTimeoutMs = 30_000;
/** The deadline measures actual transport activity, including heartbeats, not business events. */
async function readWithDeadline<T>(operation: Promise<T>, connection: AbortController): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let stop: (() => void) | undefined;
  try {
    return await Promise.race([operation, new Promise<never>((_resolve, reject) => {
      stop = () => reject(connection.signal.reason ?? new DOMException('Aborted', 'AbortError'));
      if (connection.signal.aborted) {stop(); return;}
      connection.signal.addEventListener('abort', stop, {once: true});
      timer = setTimeout(() => connection.abort(new DOMException('Stream idle timeout', 'TimeoutError')), intakeReadTimeoutMs);
    })]);
  } finally {clearTimeout(timer); if (stop) connection.signal.removeEventListener('abort', stop);}
}
/** Reopen only the persisted event GET. A normal server lease ending never repeats the turn POST. */
export function resumableIntakeStream(draftId: string, input: IntakeRequest, signal?: AbortSignal | null, connection?: (interrupted: boolean) => void): Response {
  const controller = new AbortController();
  const abort = () => controller.abort(); signal?.addEventListener('abort', abort, {once: true}); if (signal?.aborted) controller.abort();
  let seq = Math.max(0, input.after), stopped = false;
  return new Response(new ReadableStream<Uint8Array>({
    async start(target) {
      const encoder = new TextEncoder(); let failures = 0;
      try {
        while (!controller.signal.aborted && !stopped) {
          const lease = new AbortController();
          const abortLease = () => lease.abort();
          controller.signal.addEventListener('abort', abortLease, {once: true});
          try {
            const response = await readWithDeadline(sessionStream(`/api/case-drafts/${draftId}/turns/${input.turnId}/events?after=${seq}`, lease.signal), lease);
            const reader = response.body!.getReader(), decoder = new TextDecoder(); let buffer = '';
            try {
              while (!stopped) {
                const chunk = await readWithDeadline(reader.read(), lease); if (chunk.done) break;
                // XStream filters comment-only frames. Emit a non-business control frame,
                // with no id/seq, only when a real byte/frame arrived from the server.
                connection?.(false); failures = 0;
                buffer += decoder.decode(chunk.value, {stream: true}).replace(/\r\n/g, '\n');
                let boundary: number;
                while ((boundary = buffer.indexOf('\n\n')) >= 0) {
                  const packet = buffer.slice(0, boundary); buffer = buffer.slice(boundary + 2);
                  const raw = packet.split('\n').filter(line => line.startsWith('data:')).map(line => line.slice(5).trimStart()).join('\n');
                  if (!raw || packet.split('\n').some(line => /^event:\s*keepalive\s*$/.test(line))) {target.enqueue(encoder.encode('event: keepalive\ndata: {}\n\n')); continue;}
                  let parsed: ReturnType<typeof IntakeEventSchema.safeParse>; try {parsed = IntakeEventSchema.safeParse(JSON.parse(raw));} catch {continue;}
                  if (!parsed.success) continue;
                  const event = parsed.data;
                  if (event.turnId !== input.turnId || event.requestId !== input.clientTurnId || event.draftRevision !== input.draftRevision || event.seq <= seq) continue;
                  seq = event.seq; failures = 0;
                  target.enqueue(encoder.encode(`id: ${seq}\nevent: intake\ndata: ${JSON.stringify(event)}\n\n`));
                  if (terminalEvent(event)) {stopped = true; break;}
                }
              }
            } finally {await reader.cancel().catch(() => undefined);}
            if (!stopped) await pause(350, controller.signal);
          } catch (failure) {
            if (controller.signal.aborted || failure instanceof ApiError && [401, 403, 404].includes(failure.status)) throw failure;
            connection?.(true); if (++failures > 5) throw failure;
            await pause(Math.min(1000 * 2 ** (failures - 1), 8000), controller.signal);
          } finally {lease.abort(); controller.signal.removeEventListener('abort', abortLease);}
        }
        if (!controller.signal.aborted) target.close(); else target.error(new DOMException('Aborted', 'AbortError'));
      } catch (error) {target.error(error);}
      finally {signal?.removeEventListener('abort', abort);}
    },
    cancel() {stopped = true; controller.abort(); signal?.removeEventListener('abort', abort);},
  }), {headers: {'Content-Type': 'text/event-stream'}});
}
class IntakeProvider extends AbstractChatProvider<IntakeMessage, IntakeRequest, SSEOutput> {
  private resume?: IntakeMessage;
  constructor(draftId: string, private readonly accept: (turnId: string) => boolean, private readonly onEvent?: (event: IntakeEvent) => void, connection?: (interrupted: boolean) => void) {
    // XRequest 2.9 measures parsed business chunks and retains its timeout flag
    // across run(). The transport above owns idle deadlines, retries and cleanup.
    super({request: XRequest<IntakeRequest, SSEOutput, IntakeMessage>(`/api/case-drafts/${draftId}/turns`, {manual: true, fetch: async (_url, options) => {const input = JSON.parse(String(options.body)) as IntakeRequest; if (!z.uuid().safeParse(input.turnId).success) throw new Error('invalid_turn'); return resumableIntakeStream(draftId, input, options.signal, connection);}})});
  }
  transformParams(params: Partial<IntakeRequest>, _options: XRequestOptions<IntakeRequest, SSEOutput, IntakeMessage>): IntakeRequest {this.resume = params.resume; return {turnId: params.turnId!, clientTurnId: params.clientTurnId!, draftRevision: params.draftRevision!, after: params.after ?? 0, text: ''};}
  transformLocalMessage(params: Partial<IntakeRequest>): IntakeMessage {return {role: 'user', content: params.text ?? '', turnId: params.turnId!, requestId: params.clientTurnId!, draftRevision: params.draftRevision!};}
  transformMessage({originMessage, chunk}: TransformMessage<IntakeMessage, SSEOutput>): IntakeMessage {
    const prior = originMessage?.seq ? originMessage : this.resume ?? originMessage ?? {role: 'assistant', content: '正在恢复对话', turnId: '', requestId: '', draftRevision: 0};
    if (chunk?.event !== 'intake' || typeof chunk.data !== 'string') return prior;
    let value: unknown; try {value = JSON.parse(chunk.data);} catch {return prior;}
    const parsed = IntakeEventSchema.safeParse(value); if (!parsed.success) return prior;
    const event = parsed.data;
    if (!this.accept(event.turnId) || prior.turnId && event.turnId !== prior.turnId || prior.requestId && event.requestId !== prior.requestId || prior.draftRevision && event.draftRevision !== prior.draftRevision || event.seq <= (prior.seq ?? -1)) return prior;
    this.onEvent?.(event);
    const replyBlocks = event.block ? [...(prior.replyBlocks ?? []).filter(block => block.id !== event.block!.id), event.block] : prior.replyBlocks;
    const steps = event.step ? [...(prior.steps ?? []).filter(step => step.key !== event.step!.key), event.step] : prior.steps;
    let content = replyBlocks?.length ? replyBlocks.map(block => block.text).join('\n\n') : event.type === 'stage' && event.stage ? stages[event.stage] : prior.content;
    if (event.type === 'failed') content = intakeErrorText[event.errorCode ?? ''] ?? '本次未能完成整理，已保留草稿和原件。可稍后重试或手动填写。';
    if (event.type === 'canceled') content = '已取消，草稿内容保留。';
    return {...prior, role: 'assistant', content, connectionNotice: undefined, turnId: event.turnId, requestId: event.requestId, draftRevision: event.draftRevision, seq: event.seq, suggestion: event.suggestion ?? prior.suggestion, replyBlocks, steps: settleSteps(steps, event.type === 'failed' || event.type === 'canceled'), appliedFields: event.appliedFields ?? prior.appliedFields, conflictFields: event.conflictFields ?? prior.conflictFields, resultRevision: event.resultRevision ?? prior.resultRevision, terminal: terminalEvent(event)};
  }
}
export function createIntakeProvider(draftId: string, accept: (turnId: string) => boolean, onEvent?: (event: IntakeEvent) => void, connection?: (interrupted: boolean) => void) {return new IntakeProvider(draftId, accept, onEvent, connection);}
