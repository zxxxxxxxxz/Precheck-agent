import { z } from 'zod';

export const ProcessingAccessCommandSchema = z.strictObject({
  expectedRevision: z.number().int().positive(),
  idempotencyKey: z.string().min(8).max(200),
  reason: z.string().trim().min(1).max(500),
});
export const ProcessingAccessRequestSchema = ProcessingAccessCommandSchema.extend({
  dataClass: z.literal('public_synthetic'),
  declared: z.literal(true),
  includeFutureMaterials: z.boolean(),
  durationDays: z.number().int().min(1).max(30),
});
export interface ProcessingPolicySummary {
  mode: 'demo'; id: string; version: string; hash: string; expiresAt: string; available: boolean; dataClass: 'public_synthetic';
}
export const ProcessingAccessDecisionSchema = ProcessingAccessCommandSchema.extend({
  requestId: z.uuid(), requestVersion: z.number().int().positive(),
  decision: z.enum(['approve', 'reject', 'revoke']),
});
export const ProcessingAccessWithdrawSchema = ProcessingAccessCommandSchema.extend({
  requestId: z.uuid(), requestVersion: z.number().int().positive(),
});
export const ProcessingAccessInboxQuerySchema = z.strictObject({
  status: z.enum(['pending', 'approved']).default('pending'),
  page: z.coerce.number().int().min(1).max(10000).default(1),
});
export interface ProcessingAccessRequest {
  id: string; version: number; status: 'pending'|'approved'|'rejected'|'revoked'|'withdrawn';
  effectiveStatus: 'pending'|'approved'|'rejected'|'revoked'|'withdrawn'|'expired'|'changed';
  requestedAt: string; expiresAt: string; includeFutureMaterials: boolean;
  documentCount: number; reason: string; decisionReason: string|null;
  requesterName: string; deciderName: string|null;
  canApprove: boolean; canReject: boolean; canRevoke: boolean; canWithdraw: boolean;
}
export interface ProcessingAccessInboxItem extends ProcessingAccessRequest {
  caseId: string; caseTitle: string; caseReference: string|null; caseRevision: number;
}
export interface ProcessingAccessInbox {
  policy?: ProcessingPolicySummary;
  items: ProcessingAccessInboxItem[]; total: number; page: number; pageSize: number;
}
export interface ProcessingAccessState {
  available: boolean; managedEnabled: boolean; dataClass: 'public_synthetic';
  policyExpiresAt: string|null; configurationReady: boolean;
  revision: number; registeredCount: number; authorizedCount: number; resumableCount: number;
  coversFutureMaterials: boolean; requests: ProcessingAccessRequest[];
  eligibleApproverCount: number;
  policy?: ProcessingPolicySummary;
  declaration?: {id: string; status: 'active'|'expired'|'changed'|'revoked'; declaredAt: string};
  allowedActions: ('request'|'resume')[];
}
