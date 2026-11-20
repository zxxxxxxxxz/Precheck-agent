import { z } from 'zod';
import type { ProcessingPolicySummary } from './document-processing-access.js';
import { GuaranteeTypeSchema } from './review-config.js';

export const CASE_FIELD_LIMITS = { title: 200, reference: 100, background: 5000 } as const;
export const CASE_JURISDICTIONS = [
  {value: 'CN', label: '中国内地'}, {value: 'HK', label: '中国香港'},
  {value: 'MO', label: '中国澳门'}, {value: 'TW', label: '中国台湾'},
  {value: 'SG', label: '新加坡'}, {value: 'GB', label: '英国'},
  {value: 'US', label: '美国'}, {value: 'AU', label: '澳大利亚'},
  {value: 'CA', label: '加拿大'}, {value: 'NZ', label: '新西兰'},
  {value: 'JP', label: '日本'}, {value: 'KR', label: '韩国'},
  {value: 'DE', label: '德国'}, {value: 'FR', label: '法国'},
  {value: 'CH', label: '瑞士'}, {value: 'VG', label: '英属维尔京群岛'},
  {value: 'KY', label: '开曼群岛'}, {value: 'BM', label: '百慕大'},
] as const;
export const CASE_CURRENCIES = [
  {value: 'CNY', label: 'CNY 人民币'}, {value: 'HKD', label: 'HKD 港元'},
  {value: 'USD', label: 'USD 美元'}, {value: 'EUR', label: 'EUR 欧元'},
  {value: 'GBP', label: 'GBP 英镑'}, {value: 'SGD', label: 'SGD 新加坡元'},
  {value: 'JPY', label: 'JPY 日元'}, {value: 'AUD', label: 'AUD 澳大利亚元'},
  {value: 'CAD', label: 'CAD 加拿大元'}, {value: 'CHF', label: 'CHF 瑞士法郎'},
  {value: 'NZD', label: 'NZD 新西兰元'}, {value: 'TWD', label: 'TWD 新台币'},
  {value: 'MOP', label: 'MOP 澳门元'}, {value: 'KRW', label: 'KRW 韩元'},
] as const;
// Both manual entry and the assistant write the same optional case metadata.
export const CaseDetailsSchema = z.object({
  customerNumber: z.string().trim().max(100, '客户号不能超过 100 字'),
  jurisdiction: z.enum(CASE_JURISDICTIONS.map(option => option.value)).nullable(),
  // Omission supports older clients; null explicitly clears the selected currency.
  guaranteeCurrency: z.enum(CASE_CURRENCIES.map(option => option.value)).nullable().optional(),
  // Decimal text preserves large amounts and customer identifiers retain leading zeroes.
  guaranteeAmount: z.string().regex(/^(?:0|[1-9]\d{0,17})(?:\.\d{1,2})?$/, '请输入非负金额，最多 18 位整数、2 位小数').nullable(),
}).strict();
export type CaseDetails = z.infer<typeof CaseDetailsSchema>;
export const emptyCaseDetails = (): CaseDetails => ({customerNumber: '', jurisdiction: null, guaranteeAmount: null, guaranteeCurrency: null});
export const DraftFieldSchema = z.enum(['scenario', 'title', 'reference', 'background']);
export type DraftField = z.infer<typeof DraftFieldSchema>;
export const IntakeDetailFieldSchema = z.enum(['customerNumber', 'jurisdiction', 'guaranteeCurrency', 'guaranteeAmount', 'guaranteeTypes']);
export const IntakeFieldSchema = z.enum([...DraftFieldSchema.options, ...IntakeDetailFieldSchema.options]);
export type IntakeField = z.infer<typeof IntakeFieldSchema>;
export const DraftGuaranteeTypesSchema = z.array(GuaranteeTypeSchema).max(5).refine(types => new Set(types).size === types.length);
export type DraftGuaranteeTypes = z.infer<typeof DraftGuaranteeTypesSchema>;

export const DraftSourceSchema = z.object({
  kind: z.enum(['maker', 'external_rm', 'unknown']),
  label: z.string().trim().max(200).optional(),
}).strict();
export const CaseDraftFieldsSchema = z.object({
  scenario: z.literal('overseas_loan').nullable(),
  title: z.string().trim().max(CASE_FIELD_LIMITS.title),
  reference: z.string().trim().max(CASE_FIELD_LIMITS.reference),
  background: z.string().trim().max(CASE_FIELD_LIMITS.background),
}).strict();
export const CaseCreationFieldsSchema = CaseDraftFieldsSchema.extend({
  scenario: z.literal('overseas_loan'),
});
export const DraftCommandSchema = z.object({
  expectedRevision: z.number().int().positive(), idempotencyKey: z.string().min(1).max(128),
}).strict();
export const SaveCaseDraftSchema = DraftCommandSchema.extend({ fields: CaseDraftFieldsSchema, source: DraftSourceSchema, details: CaseDetailsSchema.optional(), guaranteeTypes: DraftGuaranteeTypesSchema.optional(), touchedFields:z.array(IntakeFieldSchema).max(9).optional() });
export const ApplyDraftSuggestionSchema = DraftCommandSchema.extend({
  turnId: z.uuid(), candidateIds: z.array(z.uuid()).min(1).max(9),
});
export const CaseReviewSelectionSchema = z.strictObject({
  releaseId: z.string().trim().min(1).max(100),
  guaranteeTypes: z.array(GuaranteeTypeSchema).min(1).max(5).refine(types => new Set(types).size === types.length),
  scope: z.enum(['synthetic', 'bank']),
});
export type CaseReviewSelection = z.infer<typeof CaseReviewSelectionSchema>;
// 新建案件可匹配的规则范围；历史案件仍使用原先绑定的发布版本。
const caseConfigurationGuaranteeTypes: readonly string[] = [
  'corporate_guarantee',
  'personal_guarantee',
  // 'mortgage', // 抵押融资规则暂缓启用，后续确认需要时再恢复。
  'account_charge',
  'sblc',
];
export function isCaseConfigurationEnabled(guaranteeTypes: readonly string[]): boolean {
  return guaranteeTypes.length > 0 && guaranteeTypes.every(type => caseConfigurationGuaranteeTypes.includes(type));
}
export interface CaseConfigurationOption extends CaseReviewSelection {
  label: string; publishedAt: string; requiresProcessing?: boolean;
  materials?: Array<{id: string; label: string; objectRole?: string; required: boolean; conditional: boolean}>;
}
export interface CaseConfigurationOptions {
  processingPolicy?: ProcessingPolicySummary;
  canSelect: boolean; reason?: 'permission_required' | 'configuration_unavailable'; items: CaseConfigurationOption[];
}
export const CreateCaseFromDraftSchema = DraftCommandSchema.extend({
  draftId: z.uuid(), createReviewRound:z.boolean().optional(), reviewConfiguration: CaseReviewSelectionSchema.optional(),
});
export type CaseDraftFields = z.infer<typeof CaseDraftFieldsSchema>;
export type DraftSource = z.infer<typeof DraftSourceSchema>;
export type DraftFieldState = 'empty' | 'manual' | 'accepted' | 'assistant';
export const DraftFieldSourceSchema=z.discriminatedUnion('kind',[
  z.object({kind:z.literal('system_default')}).strict(),
  z.object({kind:z.literal('manual'),personId:z.uuid(),accountId:z.uuid()}).strict(),
  z.object({kind:z.literal('suggestion'),turnId:z.uuid(),candidateId:z.uuid(),personId:z.uuid(),accountId:z.uuid(),sourceRefs:z.array(z.string()).max(100).optional()}).strict(),
  z.object({kind:z.literal('assistant'),turnId:z.uuid(),candidateId:z.uuid(),personId:z.uuid(),accountId:z.uuid(),sourceRefs:z.array(z.string()).max(100)}).strict(),
]);
export const DraftFieldSourcesSchema=z.object({scenario:DraftFieldSourceSchema.optional(),title:DraftFieldSourceSchema.optional(),reference:DraftFieldSourceSchema.optional(),background:DraftFieldSourceSchema.optional(),customerNumber:DraftFieldSourceSchema.optional(),jurisdiction:DraftFieldSourceSchema.optional(),guaranteeCurrency:DraftFieldSourceSchema.optional(),guaranteeAmount:DraftFieldSourceSchema.optional(),guaranteeTypes:DraftFieldSourceSchema.optional()}).strict();
export interface CaseDraft {
  details?: CaseDetails;
  guaranteeTypes?: DraftGuaranteeTypes;
  id: string; ownerPersonId: string; revision: number;
  fields: CaseDraftFields; fieldStates: Record<DraftField, DraftFieldState> & Partial<Record<IntakeField, DraftFieldState>>; fieldSources:z.infer<typeof DraftFieldSourcesSchema>; source: DraftSource;
  status: 'open' | 'created' | 'discarded'; createdCaseId: string | null;
  createdAt: string; updatedAt: string;
}
export const CaseDraftSchema = z.object({
  details: CaseDetailsSchema.optional(),
  guaranteeTypes: DraftGuaranteeTypesSchema.optional(),
  id: z.uuid(), ownerPersonId: z.uuid(), revision: z.number().int().positive(),
  fields: CaseDraftFieldsSchema,
  fieldSources: DraftFieldSourcesSchema,
  fieldStates: z.object({scenario:z.enum(['empty','manual','accepted','assistant']),title:z.enum(['empty','manual','accepted','assistant']),reference:z.enum(['empty','manual','accepted','assistant']),background:z.enum(['empty','manual','accepted','assistant']),customerNumber:z.enum(['empty','manual','accepted','assistant']).optional(),jurisdiction:z.enum(['empty','manual','accepted','assistant']).optional(),guaranteeCurrency:z.enum(['empty','manual','accepted','assistant']).optional(),guaranteeAmount:z.enum(['empty','manual','accepted','assistant']).optional(),guaranteeTypes:z.enum(['empty','manual','accepted','assistant']).optional()}).strict(),
  source: DraftSourceSchema, status: z.enum(['open','created','discarded']), createdCaseId:z.uuid().nullable(),
  createdAt:z.iso.datetime(), updatedAt:z.iso.datetime(),
}).strict();
export const emptyCaseDraftFields = (): CaseDraftFields => ({ scenario: 'overseas_loan', title: '', reference: '', background: '' });
