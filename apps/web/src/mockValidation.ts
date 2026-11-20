import {MockValidationRunSchema, MockValidationRunSummarySchema} from '@hsbc/contracts/mock-validation';
import type {MockValidationRun, MockValidationRunSummary} from '@hsbc/contracts/mock-validation';
import {ApiError} from './api.ts';
export type {MockValidationRun, MockValidationRunSummary};
export function scopedMockRuns(items: readonly unknown[], documentId: string, parseRevision: string): MockValidationRunSummary[] {
  return items.flatMap(item => {const parsed = MockValidationRunSummarySchema.safeParse(item); return parsed.success && parsed.data.documentVersionId === documentId && parsed.data.sourceParseRevision === parseRevision ? [parsed.data] : [];});
}
export function validateMockRun(value: unknown, documentId: string, parseRevision: string, sourceSha256: string, runId: string): MockValidationRun {
  const parsed = MockValidationRunSchema.safeParse(value);
  if (!parsed.success || parsed.data.id !== runId || parsed.data.documentVersionId !== documentId || parsed.data.sourceParseRevision !== parseRevision || parsed.data.sourceSha256 !== sourceSha256 || (parsed.data.result && parsed.data.result.ocrInputSha256 !== parsed.data.mockImageSha256)) throw new ApiError(409, 'mock_scope_mismatch', '样本验证版本不一致，请重新查询。');
  return parsed.data;
}
export const mockStatusLabels: Record<MockValidationRunSummary['status'], string> = {pending:'待处理', running:'正在验证', ready:'验证完成', partial:'部分完成', failed:'验证失败', stale:'已失效', canceled:'已取消'};
