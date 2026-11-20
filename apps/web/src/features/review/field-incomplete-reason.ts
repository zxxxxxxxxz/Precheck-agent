import type {ChecklistRow} from '@hsbc/contracts/review-checklist';
import type {ReviewState} from '@hsbc/contracts/review';
import {checklistReviewStatus} from './field-review-status.ts';

export const incompleteReasonLabels={failed:'自动核对失败',unavailable:'无法自动核对',uncertain:'提取结果待核实',missing_value:'缺少字段值',source_verification:'原文核验未完成',insufficient:'核对依据不足'};
export type IncompleteReason=keyof typeof incompleteReasonLabels;

/** Display one primary blocker per incomplete field so the breakdown adds up.
 * This does not alter stored decisions, status precedence or task scheduling. */
export function fieldIncompleteReason(row:ChecklistRow,state:ReviewState):IncompleteReason|undefined {
  if(checklistReviewStatus(row,state)!=='incomplete')return;
  const checks=row.crossChecks??[];
  if(checks.some(check=>check.semantic?.state==='failed'))return 'failed';
  if(checks.some(check=>check.semantic?.state==='unavailable'))return 'unavailable';
  const sources=checks.length?checks.filter(check=>check.outcome!=='not_applicable').flatMap(check=>check.sources):row.sourceValues??[];
  if(sources.some(source=>source.state==='uncertain'||source.state==='available'&&source.warnings.length))return 'uncertain';
  if(sources.some(source=>source.state==='missing'))return 'missing_value';
  if(!checks.length&&sources.some(source=>source.values.length))return 'source_verification';
  return 'insufficient';
}

export function incompleteFieldCounts(rows:ChecklistRow[],state:ReviewState){
  const counts:Record<IncompleteReason,number>={failed:0,unavailable:0,uncertain:0,missing_value:0,source_verification:0,insufficient:0};
  for(const row of rows){const reason=fieldIncompleteReason(row,state);if(reason)counts[reason]++;}
  return counts;
}
