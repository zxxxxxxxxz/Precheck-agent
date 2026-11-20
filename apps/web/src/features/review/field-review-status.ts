import {isBusinessSource,sourceGap} from './field-gap-guidance.ts';
import {needsSemanticAnalysis} from './cross-file-semantic-queue.ts';
import {wordingDiffers} from './field-meaning.ts';
import type {FieldReviewStatus} from '@hsbc/contracts/field-verification';
import {CORPORATE_CUSTOMER_ADDRESS_CHECK,type ChecklistRow} from '@hsbc/contracts/review-checklist';
import type {ReviewState} from '@hsbc/contracts/review';

export const fieldReviewLabels:Record<FieldReviewStatus,string>={confirmed:'已确认',consistent:'一致',different:'有差异',pending:'待确认',not_applicable:'不适用'};
export type ChecklistReviewStatus=FieldReviewStatus|'checking'|'incomplete'|'missing_material';
export const checklistStatusNames:Record<ChecklistReviewStatus,string>={...fieldReviewLabels,pending:'需人工确认',checking:'核对中',incomplete:'核对未完成',missing_material:'缺少对照文件'};
export function hasCustomerAddressBusinessCheck(row:ChecklistRow){return !!row.crossChecks?.some(check=>check.id.endsWith(`:${CORPORATE_CUSTOMER_ADDRESS_CHECK}`));}
export function checklistReviewStatus(row:ChecklistRow,state:ReviewState):ChecklistReviewStatus{
 // Read-only rows carry the frozen review, not a new reviewer's empty checklist.
 // A saved receipt (including pending/stale) must win over comparison fallbacks.
 if(state.readOnly&&row.verification)return row.verification.validity!=='current'?'pending':
  row.verification.status==='pending'&&row.verification.pendingKind==='incomplete'?'incomplete':row.verification.status;
 if(row.objectRole==='personal_guarantee'&&row.fieldId==='pg_required_amount'&&
   row.fact?.validity==='current'&&!row.fact.automaticAdoption&&row.fact.state==='present'&&row.fact.normalization.status==='normalized')return 'confirmed';
 if(row.documentScope||state.readOnly&&row.crossChecks?.length){
  const v=row.verification,checks=row.crossChecks??[],sources=checks.length?checks.filter(c=>c.outcome!=='not_applicable').flatMap(c=>c.sources):row.sourceValues??[];
  const verifiedStatus=v?.status==='pending'&&v.pendingKind==='incomplete'?'incomplete':v?.status;
  if(v?.validity==='current'&&!v.origin&&v.scope==='bank_rule')return v.status;
  if(checks.some(c=>c.outcome==='different'&&(!c.semanticEligible||c.semantic?.state==='complete'))||!checks.some(c=>c.valueBasis==='extracted')&&v?.validity==='current'&&v.meaning==='different')return 'different';
  if(checks.length&&checks.every(c=>c.outcome==='not_applicable'))return 'not_applicable';
  if(!checks.length&&v?.validity==='current')return verifiedStatus!;
  if(checks.some(c=>c.semantic?.state==='pending'||needsSemanticAnalysis(c))||sources.some(s=>s.state==='processing'))return 'checking';
  if(checks.some(c=>['failed','unavailable'].includes(c.semantic?.state??''))||sources.some(s=>s.state==='uncertain'||s.state==='available'&&s.warnings.length))return 'incomplete';
  if(sources.some(s=>sourceGap(s)?.kind==='document'))return 'missing_material';
  if(sources.some(s=>sourceGap(s)?.kind==='information'))return 'incomplete';
  if(sources.some(s=>isBusinessSource(s)&&['missing','pending_confirmation'].includes(s.state)))return 'pending';
  if(checks.some(c=>['insufficient','single_source'].includes(c.outcome)))return 'incomplete';
  if(checks.some(c=>c.outcome==='manual'))return 'pending';
  // A passed single-document requirement, date order or minimum is confirmed.
  // Reserve consistency for equivalent wording in an actual value comparison;
  // different values in a passing inequality are not semantic equivalence.
  if(checks.length&&checks.every(c=>['consistent','not_applicable'].includes(c.outcome)))return checks.some(c=>
   c.outcome==='consistent'&&(c.method==='text'||c.method==='equal'||c.comparisons?.length)&&
   wordingDiffers(c,{fieldId:row.fieldId,label:row.label}))?'consistent':'confirmed';
  if(v?.validity==='current')return verifiedStatus!;
  if(row.fact?.validity==='current'&&row.fact.state==='not_applicable')return 'not_applicable';
  return sources.some(s=>s.state==='pending_confirmation')?'pending':'incomplete';
 }
 if(hasCustomerAddressBusinessCheck(row))return 'pending';
 if(row.verification)return row.verification.validity==='current'?row.verification.status:'pending';
 return row.fact?.validity==='current'&&row.fact.state==='not_applicable'?'not_applicable':'pending';
}
export function checklistReviewLabel(row:ChecklistRow,state:ReviewState){return row.documentScope?checklistStatusNames[checklistReviewStatus(row,state)]:hasCustomerAddressBusinessCheck(row)?'待人工判断':checklistStatusNames[checklistReviewStatus(row,state)];}
