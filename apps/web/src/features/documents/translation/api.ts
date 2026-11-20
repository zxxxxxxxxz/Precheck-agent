import {FullTextTranslationCommandSchema, type FullTextTranslationCommand, FieldTranslationTargetsQuerySchema, type FieldTranslationSource, DocumentTranslationAcceptedSchema, DocumentTranslationCommandSchema, DocumentTranslationListSchema, DocumentTranslationTargetsSchema, DocumentTranslationViewSchema, type DocumentTranslationCommand} from '@hsbc/contracts/document-translation';
import {api} from '../../../api.ts';

export const translationBase = (caseId: string, documentId: string) => `/api/cases/${encodeURIComponent(caseId)}/documents/${encodeURIComponent(documentId)}/translations`;
export const translationApi = {
  async fieldTargets(base:string, parseRevision:string, expectedDirectoryRevision:number, fieldSources:FieldTranslationSource[], signal?:AbortSignal, referenceRoundId?:string) {
    return DocumentTranslationTargetsSchema.parse(await api(`${base}/field-targets`, {method:'POST',signal,
      body:FieldTranslationTargetsQuerySchema.parse({parseRevision,expectedDirectoryRevision,fieldSources,...(referenceRoundId?{referenceRoundId}:{})})}));
  },
  async targets(base: string, parseRevision: string, offset: number, signal?: AbortSignal, referenceRoundId?:string, fullSource=false) {
    return DocumentTranslationTargetsSchema.parse(await api(`${base}/targets?${new URLSearchParams({parseRevision, offset: String(offset), limit: '50',...(referenceRoundId?{referenceRoundId}:{}),...(fullSource?{fullSource:'true'}:{})})}`, {signal}));
  },
  async history(base: string, parseRevision: string, signal?: AbortSignal, chunkIds?: string[], scope?: 'full_text' | 'selection') {
    return DocumentTranslationListSchema.parse(await api(`${base}?${new URLSearchParams({parseRevision, limit: '10', ...(chunkIds ? {chunkIds: JSON.stringify(chunkIds)} : {}), ...(scope ? {scope} : {})})}`, {signal}));
  },
  async get(base: string, jobId: string, signal?: AbortSignal) {
    return DocumentTranslationViewSchema.parse(await api(`${base}/${encodeURIComponent(jobId)}`, {signal}));
  },
  async create(base: string, command: DocumentTranslationCommand, signal?: AbortSignal) {
    return DocumentTranslationAcceptedSchema.parse(await api(base, {method: 'POST', body: DocumentTranslationCommandSchema.parse(command), signal}));
  },
  async createFullText(base: string, command: FullTextTranslationCommand, signal?: AbortSignal) {
    return DocumentTranslationAcceptedSchema.parse(await api(`${base}/full-text`, {method: 'POST', body: FullTextTranslationCommandSchema.parse(command), signal}));
  },
  async cancel(jobId: string, signal?: AbortSignal) {
    await api(`/api/tool-jobs/${encodeURIComponent(jobId)}/cancel`, {method: 'POST', signal});
  },
};
