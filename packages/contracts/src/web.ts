import { z } from 'zod';

export const WebActionSchema = z.enum([
  'case:read', 'case:create', 'case:close', 'case:start', 'case:configure', 'case:assign', 'material:upload', 'material:adopt',
  'evidence:read', 'field:correct', 'finding:decide', 'translation:request', 'translation:read',
  'translation:correct', 'translation:check', 'maker:submit', 'checker:correct', 'checker:confirm',
  'consultation:request', 'exception:request', 'exception:decide', 'report:generate', 'report:read', 'report:export',
  'rule:read', 'rule:propose', 'rule:trial', 'rule:approve', 'rule:publish',
  'account:manage', 'permission:manage', 'audit:read', 'system:status',
]);
export type WebAction = z.infer<typeof WebActionSchema>;
export const PageContractSchema = z.object({
  id: z.string().min(1), path: z.string().startsWith('/'), title: z.string().min(1),
  menu: z.enum(['workbench', 'cases', 'rules', 'system']).optional(),
  authentication: z.enum(['public', 'authenticated']),
  requiresAny: z.array(WebActionSchema), states: z.array(z.string().min(1)).min(1),
}).strict();
export type PageContract = z.infer<typeof PageContractSchema>;

const page = (id: string, path: string, title: string, requiresAny: WebAction[], states: string[], menu?: PageContract['menu']): PageContract =>
  PageContractSchema.parse({ id, path, title, requiresAny, states, menu, authentication: id === 'login' ? 'public' : 'authenticated' });

/** Menu visibility is a presentation hint. Every API read/write rechecks current authorization. */
export const webPages: readonly PageContract[] = [
  page('login', '/login', '登录', [], ['ready', 'invalid_credentials', 'rate_limited', 'account_unavailable', 'password_change_required', 'oidc_disabled', 'oidc_failed']),
  page('password', '/account/password', '修改密码', [], ['ready', 'submitting', 'failed']),
  page('workbench', '/workbench', '工作台', [], ['ready', 'empty', 'unassigned', 'loading', 'failed'], 'workbench'),
  page('cases', '/cases', '案件', ['case:read'], ['ready', 'empty', 'no_matches', 'partial', 'failed'], 'cases'),
  page('new-case', '/cases/new', '新建案件', ['case:create'], ['ready', 'invalid_input', 'unsupported_scenario', 'assignment_required', 'submitting', 'failed']),
  page('overview', '/cases/:caseId/overview', '概览', ['case:read'], ['snapshot_pending', 'not_started', 'running', 'waiting_human', 'cloud_incomplete', 'review_confirmed', 'stale']),
  page('materials', '/cases/:caseId/materials', '材料与版本', ['case:read'], ['uploading', 'verifying', 'registered', 'parsing', 'partial_failure', 'version_pending', 'historical']),
  page('review', '/cases/:caseId/review', '审核工作台', ['case:read'], ['empty', 'locating', 'location_failed', 'ambiguous', 'not_found', 'not_applicable', 'uncertain', 'unsaved', 'conflict', 'stale', 'translation_pending', 'translation_running', 'reference_translation', 'translation_failed']),
  page('collaboration', '/cases/:caseId/collaboration', '协作与复核', ['case:read'], ['unassigned', 'pending', 'correcting', 'submitted', 'stale', 'independence_conflict', 'incomplete']),
  page('reports', '/cases/:caseId/reports', '报告与记录', ['report:read'], ['empty', 'generating', 'failed', 'draft', 'current_confirmed', 'historical', 'stale', 'forbidden']),
  page('rules', '/rules', '规则中心', ['rule:read'], ['draft', 'tests_failed', 'approval_pending', 'returned', 'approved', 'published', 'historical'], 'rules'),
  page('rule', '/rules/:ruleId', '规则详情', ['rule:read'], ['draft', 'tests_failed', 'approval_pending', 'returned', 'approved', 'published', 'historical', 'independence_conflict', 'conflict']),
  page('accounts', '/system/accounts', '账号管理', ['account:manage'], ['ready', 'confirmation_required', 'session_revoked', 'failed'], 'system'),
  page('permissions', '/system/permissions', '权限管理', ['permission:manage'], ['ready', 'confirmation_required', 'conflict', 'failed'], 'system'),
  page('audit', '/system/audit', '操作审计', ['audit:read'], ['ready', 'empty', 'failed'], 'system'),
  page('status', '/system/status', '运行状态', ['system:status'], ['ready', 'partial', 'failed'], 'system'),
];

export const webMenus = [
  { id: 'workbench', title: '工作台', path: '/workbench' },
  { id: 'cases', title: '案件', path: '/cases' },
  { id: 'rules', title: '规则中心', path: '/rules' },
  { id: 'system', title: '系统管理', children: ['/system/accounts', '/system/permissions', '/system/audit', '/system/status'] },
] as const;

export const CaseMutationActionSchema = WebActionSchema.extract([
  'case:start', 'case:assign', 'material:upload', 'material:adopt', 'field:correct', 'finding:decide',
  'translation:request', 'translation:correct', 'translation:check', 'maker:submit', 'checker:correct', 'checker:confirm',
  'consultation:request', 'exception:request', 'exception:decide', 'report:generate', 'report:export',
]);
export const CaseActionRequestSchema = z.object({
  caseId: z.string().min(1), expectedRevision: z.number().int().positive(),
  action: CaseMutationActionSchema, idempotencyKey: z.string().min(1),
  reason: z.string().trim().min(1).optional(), evidenceRefs: z.array(z.string().min(1)).default([]),
}).strict().superRefine((request, ctx) => {
  const reasonRequired: WebAction[] = ['case:assign', 'material:adopt', 'field:correct', 'finding:decide',
    'translation:correct', 'checker:correct', 'exception:request', 'exception:decide'];
  if (reasonRequired.includes(request.action) && !request.reason) ctx.addIssue({ code: 'custom', path: ['reason'], message: 'A reason is required for this action' });
  if (['field:correct', 'translation:correct', 'finding:decide'].includes(request.action) && request.evidenceRefs.length === 0) {
    ctx.addIssue({ code: 'custom', path: ['evidenceRefs'], message: 'Corrections and finding decisions require source evidence' });
  }
});
export const CaseCapabilitiesSchema = z.object({
  caseId: z.string().min(1), revision: z.number().int().positive(),
  allowedActions: z.array(WebActionSchema),
  deniedActions: z.array(z.object({ action: WebActionSchema, reasonCode: z.string().min(1) }).strict()),
}).strict();

export const webInteractionPolicy = {
  reviewStartsOn: 'explicit_case_start',
  uploadEffect: 'preparse_only',
  translationStartsOn: ['explicit_request', 'authorized_started_review_pre_generation'],
  fieldEdits: 'explicit_save_with_reason_and_evidence',
  humanDecisions: 'authenticated_business_api_with_current_revision',
  backgroundReadsExtendSession: false,
  technicalAdminHasImplicitEvidenceAccess: false,
  autoSendEmail: false,
  browserMayResumeLangGraph: false,
  reviewConfirmedMeaning: 'document_review_confirmed_only',
} as const;

export const HsbcAssetSchema = z.object({
  id: z.enum(['logo', 'colors', 'typography', 'spacing', 'status-colors', 'icons-motion', 'components']),
  authority: z.literal('HSBC Create'), status: z.literal('awaiting_bank_confirmation'),
  source: z.literal('docs/frontend-and-interaction-design.md#2-hsbc-create-全局唯一主题标准'),
  approvedVersion: z.null(), approvedAssetRef: z.null(),
}).strict();
export const hsbcAssets = HsbcAssetSchema.shape.id.options.map(id => HsbcAssetSchema.parse({
  id, authority: 'HSBC Create', status: 'awaiting_bank_confirmation',
  source: 'docs/frontend-and-interaction-design.md#2-hsbc-create-全局唯一主题标准',
  approvedVersion: null, approvedAssetRef: null,
}));
