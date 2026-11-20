import { checkHostedPolicy, hostedDispatchRecord, qwenRequestBody } from './qwen-hosting.js';
import type pg from 'pg';
import { createHash } from 'node:crypto';
import { acquirePrivateInferenceFromPool } from './private-inference-queue.js';
import { z } from 'zod';
import { OcrParseResultSchema } from '../../document/ocr-client.js';
import { BoundedHttpClient, ServiceError, type ServiceConfig } from './http.js';

export class OcrInferenceClient {
  private http: BoundedHttpClient;
  constructor(config: ServiceConfig) { this.http = new BoundedHttpClient(config, 'ocr'); }
  async parse(image: Uint8Array, options: { returnWordBox?: boolean; signal?: AbortSignal } = {}) {
    if (!image.length || image.length > 10 * 1024 * 1024) throw new ServiceError('ocr_invalid_image_size');
    const form = new FormData(); form.set('file', new Blob([new Uint8Array(image)], { type: 'image/png' }), 'synthetic.png');
    if (options.returnWordBox) form.set('return_word_box', 'true');
    const result = await this.http.request('/v1/ocr', OcrParseResultSchema, { form, signal: options.signal, maxBytes: 20 * 1024 * 1024 });
    if (options.returnWordBox && result.pages.some(page => !page.word_ocr)) throw new ServiceError('ocr_word_result_missing');
    return result;
  }
}
const NerEntitySchema=z.object({text:z.string(),confidence:z.number().min(0).max(1),start:z.number().int().nonnegative().optional(),end:z.number().int().nonnegative().optional()});
const NerSchema = z.object({ entities: z.record(z.string(), z.array(NerEntitySchema)),offset_unit:z.literal('unicode_code_point').optional() });
export class NerClient {
  private http: BoundedHttpClient;
  constructor(config: ServiceConfig) { this.http = new BoundedHttpClient(config, 'ner'); }
  async classify(text: string, labels: string[], options: { signal?: AbortSignal } = {}) {
    // UTF-8 bytes give a conservative ceiling for the deployed tokenizer, not an
    // asserted token count. The service retains its own exact 3800-token check.
    if (!text || Buffer.byteLength(text,'utf8') > 1500 || !labels.length || labels.length > 32 || labels.some(label=>!label.trim()||Buffer.byteLength(label,'utf8')>128)) throw new ServiceError('ner_invalid_input');
    const schema=z.strictObject({label:z.strictObject({label:z.string().min(1),confidence:z.number().min(0).max(1)})});
    const result=await this.http.request('/v1/classify',schema,{body:{text,labels,word_splitter:/[\u3400-\u9fff]/u.test(text)?'char':'whitespace'},signal:options.signal});
    if(!labels.includes(result.label.label))throw new ServiceError('ner_invalid_response');
    return result;
  }
  async entities(text: string, labels: string[], options: { wordSplitter?: 'whitespace' | 'char'; includeSpans?:boolean; signal?: AbortSignal } = {}) {
    if (!text || text.length > 20_000 || !labels.length || labels.length > 64 || labels.some(label => !label.trim() || label.length > 128)) throw new ServiceError('ner_invalid_input');
    const result = await this.http.request('/v1/entities', NerSchema, { body: { text, labels, word_splitter: options.wordSplitter ?? 'whitespace',...(options.includeSpans?{include_spans:true}:{}) }, signal: options.signal });
    if (Object.keys(result.entities).some(label => !labels.includes(label))) throw new ServiceError('ner_invalid_response');
    if(options.includeSpans){
      if(result.offset_unit!=='unicode_code_point')throw new ServiceError('ner_span_invalid');
      const points=[...text];
      for(const values of Object.values(result.entities))for(const value of values){
        if(value.start===undefined||value.end===undefined||value.start>=value.end||value.end>points.length||
          points.slice(value.start,value.end).join('')!==value.text)throw new ServiceError('ner_span_invalid');
      }
    }
    return result;
  }
}
/** Query a configured immutable release only. Callers cannot supply policy paths or URLs. */
export class OpaClient {
  private http: BoundedHttpClient;
  constructor(config: ServiceConfig, private releases: ReadonlyMap<string, string>) {
    this.http = new BoundedHttpClient(config, 'opa');
    for (const path of releases.values()) if (!/^\/v1\/data\/hsbc\/releases\/[a-zA-Z0-9_/-]+\/decision$/.test(path)) throw new ServiceError('opa_invalid_configuration');
  }
  async evaluate<T>(release: string, input: unknown, resultSchema: z.ZodType<T>, signal?: AbortSignal): Promise<T> {
    const path = this.releases.get(release);
    if (!path) throw new ServiceError('opa_release_unavailable');
    const response = await this.http.request(path, z.object({ result: resultSchema }), { body: { input }, signal });
    return response.result;
  }
}
const ChatSchema = z.object({ id: z.string().min(1), model: z.string().min(1), choices: z.array(z.object({
  finish_reason: z.enum(['stop', 'length', 'content_filter']), message: z.object({ role: z.literal('assistant'), content: z.string().nullable(), tool_calls: z.array(z.unknown()).optional() }),
})).length(1), usage: z.object({ prompt_tokens: z.number().int().nonnegative(), completion_tokens: z.number().int().nonnegative(), total_tokens: z.number().int().nonnegative() })
  .refine(value=>value.total_tokens===value.prompt_tokens+value.completion_tokens) });
export type QwenDispatch = <T>(body:unknown,start:()=>Promise<T>)=>Promise<T>;
export interface QwenJsonSchema { name: string; schema: Record<string, unknown>; }
/** Validated accounting metadata only; never contains model text or tool arguments. */
export interface QwenReceipt {
  requestId: string; model: string;
  usage: { prompt_tokens: number; completion_tokens: number; total_tokens: number };
}
export interface QwenChatOptions {maxTokens?:number;disableThinking?:boolean;jsonObject?:boolean;jsonSchema?:QwenJsonSchema;dispatch?:QwenDispatch;beforeSend?:(body:unknown)=>Promise<void>;onReceipt?:(receipt:QwenReceipt)=>Promise<void>;queueWaitMs?:number}
export interface PrivateQwenImage {bytes:Uint8Array;sha256:string;width:number;height:number}
export class QwenClient {
  private http: BoundedHttpClient;
  readonly simulated = false;
  constructor(private config: ServiceConfig, readonly model: string, private pool: pg.Pool) {
    if(config.hostedQwen)checkHostedPolicy(config.hostedQwen,config.baseUrl,model);
    else if(new URL(config.baseUrl).hostname.endsWith('.maas.aliyuncs.com'))throw new ServiceError('qwen_hosted_policy_denied');
    // OpenAI-compatible deployment configuration commonly ends in /v1.
    this.http = new BoundedHttpClient({...config,baseUrl:config.baseUrl.replace(/\/v1\/?$/,'')}, 'qwen');
  }
  async chat(messages: { role: 'system' | 'user' | 'assistant'; content: string }[], signal?: AbortSignal, options: QwenChatOptions = {}) {
    if (!messages.length || messages.length > 50 || messages.some(m => typeof m.content !== 'string' || !m.content || m.content.length > 20_000)) throw new ServiceError('qwen_invalid_input');
    return this.run(messages, 'text', signal, options);
  }
  /** Private-only byte input. External image URLs and arbitrary multimodal parts
   * are intentionally not representable by this port. */
  async vision(prompt:string, image:PrivateQwenImage, signal:AbortSignal|undefined, options:QwenChatOptions & {dispatch:QwenDispatch}) {
    const bytes=Buffer.from(image.bytes);
    if(!prompt||prompt.length>12000||bytes.length<24||bytes.length>10*1024*1024||
      bytes.subarray(0,8).toString('hex')!=='89504e470d0a1a0a'||!Number.isInteger(image.width)||!Number.isInteger(image.height)||
      image.width<1||image.height<1||image.width*image.height>16_000_000||bytes.readUInt32BE(16)!==image.width||bytes.readUInt32BE(20)!==image.height||
      createHash('sha256').update(bytes).digest('hex')!==image.sha256||typeof options.dispatch!=='function') throw new ServiceError('qwen_invalid_image');
    const messages=[{role:'user',content:[{type:'text',text:prompt},{type:'image_url',image_url:{url:`data:image/png;base64,${bytes.toString('base64')}`}}]}];
    return this.run(messages, 'vision', signal, options);
  }
  private async run(messages:unknown[],kind:'text'|'vision',signal:AbortSignal|undefined,options:QwenChatOptions) {
    if (options.jsonObject && options.jsonSchema) throw new ServiceError('qwen_invalid_input');
    const maxTokens=options.maxTokens??1024;if(!Number.isInteger(maxTokens)||maxTokens<1||maxTokens>2048)throw new ServiceError('qwen_invalid_output_budget');
    signal?.throwIfAborted();
    // A session-level PG lock spans the actual HTTP operation, across processes.
    let connection:pg.PoolClient|undefined,releaseLock:(()=>Promise<void>)|undefined; let destroy = false;
    const canceled = new AbortController();
    const onError = () => { destroy = true; canceled.abort(); };

    try {
      const lease=await acquirePrivateInferenceFromPool(this.pool,kind,signal?AbortSignal.any([signal,canceled.signal]):canceled.signal,{waitMs:options.queueWaitMs});
      connection=lease.connection;releaseLock=lease.release;connection.on('error',onError);
      const body=qwenRequestBody(this.model,messages,{...options,maxTokens},Boolean(this.config.hostedQwen));
      const dispatchRecord=hostedDispatchRecord(this.config,this.model,body);
      await options.beforeSend?.(body);signal?.throwIfAborted();
      const start=()=>{hostedDispatchRecord(this.config,this.model,body);return this.http.request('/v1/chat/completions', ChatSchema, { body, signal: signal ? AbortSignal.any([signal, canceled.signal]) : canceled.signal });};
      const response = options.dispatch?await options.dispatch(dispatchRecord,start):await start();
      // A complete, validated response is billable even when its output is
      // refused, truncated or unusable. Retain it before semantic validation.
      await options.onReceipt?.({ requestId: response.id, model: response.model, usage: { ...response.usage } });
      if (response.model !== this.model) throw new ServiceError('qwen_model_drift');
      const choice = response.choices[0];
      if (choice.finish_reason !== 'stop') throw new ServiceError(choice.finish_reason === 'length' ? 'qwen_truncated' : 'qwen_refused');
      if (choice.message.tool_calls?.length || !choice.message.content) throw new ServiceError('qwen_unsupported_output');
      return { requestId: response.id, model: response.model, text: choice.message.content, usage: response.usage, simulated: false as const };
    } catch(error) {
      if(!releaseLock)destroy=true; // A failed queue cleanup must not return a locked session.
      throw error;
    } finally {
      if (releaseLock) { try { await releaseLock(); } catch { destroy = true; } }
      connection?.removeListener('error', onError); connection?.release(destroy);
    }
  }
}
