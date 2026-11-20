import { z } from 'zod';
import { IntakeFieldSchema, type IntakeField } from '@hsbc/contracts/draft';
import { IntakeAssistantOutputSchema, type IntakeReplyBlock } from '@hsbc/contracts/intake';
import { ModelExecutionError } from '../../model/gateway.js';

export const INTAKE_FIELD_NOTICE_ID = 'intake-field-validation-notice';

// Validate the envelope and conversation strictly, then assess each field on its
// own. The published result still uses the unchanged strict output contract.
export const IntakeOutputEnvelopeSchema = z.strictObject({
  replyBlocks: IntakeAssistantOutputSchema.shape.replyBlocks,
  fieldSuggestions: z.array(z.unknown()).max(9),
  questions: IntakeAssistantOutputSchema.shape.questions,
}).refine(value => new Set(value.replyBlocks.map(block => block.id)).size === value.replyBlocks.length);

export function intakeModelReplyLimit(hasWithheldSources: boolean) {
  // One slot for field feedback, plus the existing attachment coverage notice.
  return hasWithheldSources ? 10 : 11;
}

const fieldLabels: Record<IntakeField, string> = {
  scenario: '业务场景', title: '案件名称', reference: '参考编号', background: '案件背景',
  customerNumber: '客户号', jurisdiction: '适用法域', guaranteeCurrency: '保证币种',
  guaranteeAmount: '保证金额', guaranteeTypes: '担保类型',
};
const reasons = {
  invalid_format: '格式或选项不符合填写要求',
  duplicate_field: '同一字段出现多条建议，无法确定采用哪一条',
  intake_output_refs: '引用的材料位置无效或不可用于填写',
  intake_output_scenario_source: '引用材料未明确支持该业务场景',
  intake_output_reference_source: '引用材料未能验证该项取值',
  intake_output_number_source: '数字与引用材料不一致',
  intake_output_restored_schema: '还原后的取值不符合填写要求',
} as const;
export type IntakeFieldIssue = { field: IntakeField | null; reason: keyof typeof reasons };

export function intakeSuggestedField(raw: unknown): IntakeField | null {
  const parsed = IntakeFieldSchema.safeParse(raw && typeof raw === 'object' && 'field' in raw ? raw.field : undefined);
  return parsed.success ? parsed.data : null;
}

export function recoverableIntakeFieldError(error: unknown): IntakeFieldIssue['reason'] | undefined {
  if (!(error instanceof ModelExecutionError) || error.code !== 'invalid_output') return;
  switch (error.diagnostic) {
    case 'intake_output_refs': case 'intake_output_scenario_source': case 'intake_output_reference_source':
    case 'intake_output_number_source': case 'intake_output_restored_schema': return error.diagnostic;
  }
}

/** Only fixed labels/reasons are published; rejected values and refs are omitted. */
export function intakeFieldNotice(issues: readonly IntakeFieldIssue[]): IntakeReplyBlock | undefined {
  if (!issues.length) return;
  const lines = [...new Set(issues.map(issue => `${issue.field ? fieldLabels[issue.field] : '未识别字段'}：${reasons[issue.reason]}。`))];
  return { id: INTAKE_FIELD_NOTICE_ID, sourceRefs: [], text:
    `以下字段建议未自动填写，表单中已有内容保持不变；其他通过校验的建议继续处理。\n${lines.join('\n')}\n请核对后按需手动填写。` };
}
