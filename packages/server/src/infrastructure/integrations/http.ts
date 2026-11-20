import { z } from 'zod';

/** Deliberately contains no vendor body, URL, token, or original Error cause. */
export class ServiceError extends Error {
  constructor(readonly code: string, readonly retryable = false, readonly retryAfterMs?: number) { super(code); }
}
export interface ServiceConfig { baseUrl: string; token: string; timeoutMs?: number; allowHttp?: boolean; hostedQwen?: import('./qwen-hosting.js').HostedQwenPolicy }
export function retryAfter(value: string | null, now = Date.now()): number | undefined {
  if (!value) return undefined;
  const milliseconds = /^\d+(\.\d+)?$/.test(value) ? Number(value) * 1000 : Date.parse(value) - now;
  return Number.isFinite(milliseconds) ? Math.max(0, Math.min(milliseconds, 300_000)) : undefined;
}
export class BoundedHttpClient {
  readonly base: string;
  constructor(private config: ServiceConfig, private name: string) {
    const url = new URL(config.baseUrl);
    if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.search || url.hash ||
      (url.protocol === 'http:' && !config.allowHttp && !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname))) throw new ServiceError(`${name}_invalid_configuration`);
    if (!config.token || (config.timeoutMs ?? 30_000) <= 0) throw new ServiceError(`${name}_invalid_configuration`);
    this.base = url.href.replace(/\/$/, '');
  }
  async request<T>(path: string, schema: z.ZodType<T>, options: { body?: unknown; form?: FormData; signal?: AbortSignal; maxBytes?: number } = {}): Promise<T> {
    if (!path.startsWith('/') || path.includes('..') || path.includes('?') || path.includes('#')) throw new ServiceError(`${this.name}_invalid_path`);
    const deadline = AbortSignal.timeout(this.config.timeoutMs ?? 30_000);
    const signal = options.signal ? AbortSignal.any([deadline, options.signal]) : deadline;
    try {
      const response = await fetch(`${this.base}${path}`, {
        method: options.body !== undefined || options.form ? 'POST' : 'GET', redirect: 'error', signal,
        headers: { Authorization: `Bearer ${this.config.token}`, ...(options.body !== undefined ? { 'Content-Type': 'application/json' } : {}) },
        body: options.form ?? (options.body !== undefined ? JSON.stringify(options.body) : undefined),
      });
      if (!response.ok) {
        await response.body?.cancel();
        const code = [401, 403].includes(response.status) ? 'authorization_failed' : response.status === 429 || response.status === 503 ? 'busy' : response.status >= 500 ? 'unavailable' : 'request_rejected';
        throw new ServiceError(`${this.name}_${code}`, response.status === 429 || response.status >= 500, retryAfter(response.headers.get('retry-after')));
      }
      const maxBytes = options.maxBytes ?? 4 * 1024 * 1024;
      if (Number(response.headers.get('content-length')) > maxBytes) { await response.body?.cancel(); throw new ServiceError(`${this.name}_response_too_large`); }
      const chunks: Uint8Array[] = []; let size = 0;
      if (!response.body) throw new ServiceError(`${this.name}_invalid_response`);
      for await (const chunk of response.body) {
        size += chunk.byteLength;
        if (size > maxBytes) throw new ServiceError(`${this.name}_response_too_large`);
        chunks.push(chunk);
      }
      let decoded: unknown;
      try { decoded = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw new ServiceError(`${this.name}_invalid_response`); }
      const parsed = schema.safeParse(decoded);
      if (!parsed.success) throw new ServiceError(`${this.name}_invalid_response`);
      return parsed.data;
    } catch (error) {
      if (error instanceof ServiceError) throw error;
      if (options.signal?.aborted) throw new ServiceError(`${this.name}_canceled`);
      if (deadline.aborted) throw new ServiceError(`${this.name}_timeout`, true);
      throw new ServiceError(`${this.name}_transport_error`, true);
    }
  }
}
