import { createHash } from 'node:crypto';
import { z } from 'zod';
import { CompanyLookupQuerySchema, CompanyRecordSchema, type CompanyLookupQuery, type CompanyRecord } from '@hsbc/contracts/company-identity';
import { normalizeCompanyName } from './normalization.js';

export const GLEIF_CLIENT_VERSION = 'gleif-jsonapi-v1';
export const GLEIF_ORIGIN = 'https://api.gleif.org';
const NullableText = z.string().max(2000).nullish();
const Name = z.object({ name: z.string().min(1).max(300), language: NullableText, type: NullableText });
const RecordSchema = z.object({ id: z.string(), type: z.literal('lei-records'), attributes: z.object({
  lei: z.string(), entity: z.object({
    legalName: Name, otherNames: z.array(Name).max(100).optional(), transliteratedOtherNames: z.array(Name).max(100).optional(),
    jurisdiction: NullableText, registeredAt: z.object({ id: NullableText }).nullish(), registeredAs: NullableText, status: NullableText,
  }), registration: z.object({ status: NullableText, lastUpdateDate: NullableText }).nullish(),
}) });
const EnvelopeSchema = z.object({
  data: z.union([z.array(RecordSchema).max(10), RecordSchema]),
  meta: z.object({
    goldenCopy: z.object({ publishDate: NullableText }).optional(),
    pagination: z.object({ total: z.number().int().nonnegative(), lastPage: z.number().int().positive().optional() }).optional(),
  }).optional(), links: z.object({ next: z.unknown().optional() }).nullish(),
});
export class CompanyLookupError extends Error {
  constructor(readonly code: string) { super(code); }
}
export interface GleifResult {
  records: CompanyRecord[]; truncated: boolean; responseHash: string; sourceDataVersion: string | null;
}
/** Parameters are encoded individually; neither a caller nor returned links can choose a host/path. */
export function gleifQueryUrl(raw: CompanyLookupQuery): URL {
  const query = CompanyLookupQuerySchema.parse(raw);
  if (query.lei) return new URL(`/api/v1/lei-records/${query.lei}`, GLEIF_ORIGIN);
  const url = new URL('/api/v1/lei-records', GLEIF_ORIGIN);
  url.searchParams.set('filter[entity.legalName]', normalizeCompanyName(query.name).normalizedName);
  if (query.jurisdiction) url.searchParams.set('filter[entity.jurisdiction]', query.jurisdiction);
  if (query.registrationAuthority) url.searchParams.set('filter[entity.registeredAt]', query.registrationAuthority);
  if (query.registrationNumber) url.searchParams.set('filter[entity.registeredAs]', query.registrationNumber);
  url.searchParams.set('page[size]', String(query.maxCandidates));
  url.searchParams.set('page[number]', '1');
  return url;
}
export function parseGleifResponse(raw: unknown, query: CompanyLookupQuery, responseHash: string): GleifResult {
  const parsed = EnvelopeSchema.safeParse(raw);
  if (!parsed.success) throw new CompanyLookupError('company_lookup_invalid_response');
  const envelope = parsed.data, data = Array.isArray(envelope.data) ? envelope.data : [envelope.data];
  if (data.length > query.maxCandidates) throw new CompanyLookupError('company_lookup_invalid_response');
  const records = data.map(row => {
    if (row.id !== row.attributes.lei || query.lei && row.id !== query.lei) throw new CompanyLookupError('company_lookup_invalid_response');
    const { entity, registration } = row.attributes, matchBasis: string[] = [], conflicts: string[] = [];
    const aliases = [...entity.otherNames ?? [], ...entity.transliteratedOtherNames ?? []]
      .map(value => ({ name: value.name, language: value.language ?? null, type: value.type ?? null }));
    if (query.lei === row.id) matchBasis.push('lei_exact');
    if ([entity.legalName.name, ...aliases.map(alias => alias.name)].some(value => normalizeCompanyName(value).comparisonKey === normalizeCompanyName(query.name).comparisonKey)) matchBasis.push('name_format_equal');
    else conflicts.push('name_differs');
    for (const [label, expected, actual] of [
      ['jurisdiction', query.jurisdiction, entity.jurisdiction],
      ['registration_authority', query.registrationAuthority, entity.registeredAt?.id],
      ['registration_number', query.registrationNumber, entity.registeredAs],
    ] as const) if (expected) {
      if (expected === actual) matchBasis.push(`${label}_exact`);
      else conflicts.push(`${label}_${actual ? 'conflict' : 'missing'}`);
    }
    const result = CompanyRecordSchema.safeParse({
      lei: row.id, legalName: entity.legalName.name, language: entity.legalName.language ?? null, aliases,
      jurisdiction: entity.jurisdiction ?? null, registrationAuthority: entity.registeredAt?.id ?? null,
      registrationNumber: entity.registeredAs ?? null, entityStatus: entity.status ?? null,
      leiRegistrationStatus: registration?.status ?? null, recordUpdatedAt: registration?.lastUpdateDate ?? null,
      matchBasis, conflicts, sourceUrl: `${GLEIF_ORIGIN}/api/v1/lei-records/${row.id}`,
    });
    if (!result.success) throw new CompanyLookupError('company_lookup_invalid_response');
    return result.data;
  });
  if (new Set(records.map(record => record.lei)).size !== records.length) throw new CompanyLookupError('company_lookup_invalid_response');
  // No pagination is followed. Absence of count metadata is explicitly incomplete for search responses.
  const truncated = !query.lei && (envelope.meta?.pagination === undefined ||
    envelope.meta.pagination.total > records.length || Boolean(envelope.links?.next));
  return { records, truncated, responseHash, sourceDataVersion: envelope.meta?.goldenCopy?.publishDate ?? null };
}
export class GleifClient {
  constructor(readonly options: { fetcher?: typeof fetch; timeoutMs?: number; maxResponseBytes?: number } = {}) {}
  async lookup(query: CompanyLookupQuery, signal?: AbortSignal): Promise<GleifResult> {
    const url = gleifQueryUrl(query);
    const timeout = this.options.timeoutMs ?? 10000, maximum = this.options.maxResponseBytes ?? 256 * 1024;
    if (!Number.isInteger(timeout) || timeout < 100 || timeout > 10000 || maximum < 1024 || maximum > 512 * 1024) throw new CompanyLookupError('company_lookup_limits_invalid');
    const abort = AbortSignal.any([AbortSignal.timeout(timeout), ...signal ? [signal] : []]);
    try {
      const response = await (this.options.fetcher ?? fetch)(url, { method: 'GET', redirect: 'manual', signal: abort,
        headers: { accept: 'application/vnd.api+json', 'user-agent': `crossborder-company-lookup/${GLEIF_CLIENT_VERSION}` } });
      if (response.status === 404 && query.lei) return { records: [], truncated: false, responseHash: createHash('sha256').update('GLEIF:404').digest('hex'), sourceDataVersion: null };
      if (response.status === 429) throw new CompanyLookupError('company_lookup_rate_limited');
      if (response.status >= 300 && response.status < 400) throw new CompanyLookupError('company_lookup_redirect_blocked');
      if (!response.ok) throw new CompanyLookupError('company_lookup_provider_unavailable');
      if (!/application\/(?:vnd\.api\+)?json/iu.test(response.headers.get('content-type') ?? '')) throw new CompanyLookupError('company_lookup_invalid_response');
      if (Number(response.headers.get('content-length') ?? 0) > maximum || !response.body) throw new CompanyLookupError('company_lookup_response_too_large');
      const reader = response.body.getReader(), chunks: Uint8Array[] = []; let bytes = 0;
      try {
        for (;;) {
          abort.throwIfAborted(); const part = await reader.read(); if (part.done) break;
          bytes += part.value.byteLength; if (bytes > maximum) throw new CompanyLookupError('company_lookup_response_too_large');
          chunks.push(part.value);
        }
      } finally { await reader.cancel().catch(() => undefined); }
      const body = Buffer.concat(chunks); let data: unknown;
      try { data = JSON.parse(body.toString('utf8')); } catch { throw new CompanyLookupError('company_lookup_invalid_response'); }
      return parseGleifResponse(data, query, createHash('sha256').update(body).digest('hex'));
    } catch (error) {
      if (error instanceof CompanyLookupError) throw error;
      throw new CompanyLookupError(abort.aborted ? 'company_lookup_timeout' : 'company_lookup_transport_unavailable');
    }
  }
}
