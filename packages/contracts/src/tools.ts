import { z } from 'zod';
import { ResourceScopeSchema } from './identity.js';

const scoped = ResourceScopeSchema.extend({ taskId: z.string().min(1).max(128) });
export const toolSchemas = {
  parse_document: scoped.extend({ documentVersionId: z.string().min(1), idempotencyKey: z.string().min(1).max(128) }).strict(),
  extract_fields: scoped.extend({ documentVersionId: z.string().min(1), parseRevision: z.string().min(1), fields: z.array(z.string().min(1)).min(1) }).strict(),
  search_evidence: scoped.extend({ query: z.string().min(1).max(2000), documentVersionIds: z.array(z.string().min(1)).min(1) }).strict(),
  get_evidence: scoped.extend({ evidenceRef: z.string().min(1) }).strict(),
  get_redacted_evidence: scoped.extend({ evidenceRef: z.string().min(1), policyVersion: z.string().min(1) }).strict(),
  compare_document_versions: scoped.extend({ beforeVersionId: z.string().min(1), afterVersionId: z.string().min(1) }).strict(),
  get_rule: scoped.extend({ ruleVersion: z.string().min(1), ruleId: z.string().min(1) }).strict(),
  get_evaluation: scoped.extend({ evaluationId: z.string().min(1) }).strict(),
  get_tool_job: scoped.extend({ jobId: z.string().min(1) }).strict(),
} as const;
export type ToolName = keyof typeof toolSchemas;
export const p0Tools = ['get_evidence', 'parse_document', 'get_tool_job'] as const;
export type P0ToolName = typeof p0Tools[number];
export type ToolInput<T extends ToolName> = z.infer<(typeof toolSchemas)[T]>;
