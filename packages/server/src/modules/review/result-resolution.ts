import type {ChecklistRow,CrossFileCheck} from '@hsbc/contracts/review-checklist';
import type {AutomaticReviewCheck,FrozenFieldReview} from '@hsbc/contracts/field-verification';
import type {ReviewConfigManifest,ReviewRequirementPolicy} from '@hsbc/contracts/review-config';
import {systemJudgementEnabled} from './requirement-policy.js';

export const SYSTEM_JUDGEMENT_VERSION='system-judgement-v1' as const;
/** Kept beside a resolved result: what the rule engine returned and which checks decided it. */
export interface ResultResolution {version:typeof SYSTEM_JUDGEMENT_VERSION;engineOutcome:string;engineReasonCode:string;checkIds:string[]}
interface EngineResult {ruleId:string;scopeId:string;outcome:string;reasonCode:string}
interface FrozenJudgement {
  requirementPolicy?:ReviewRequirementPolicy;
  crossFileChecklist?:Array<Pick<ChecklistRow,'id'|'fieldId'|'crossChecks'>>;
  fieldReviews?:FrozenFieldReview[];
  automaticChecks?:AutomaticReviewCheck[];
  objects?:Array<{objectId:string;role?:string}>;
}

/** What the judgement chain concluded for one check; null while it is still open. A model comparison counts only
 * when it actually ran to completion, and a difference found by either the literal or the model comparison stands. */
export function checkConclusion(check:CrossFileCheck):'consistent'|'different'|'not_applicable'|null {
  if(check.outcome==='not_applicable')return 'not_applicable';
  const semantic=check.semantic&&check.semantic.state==='complete'&&!check.semantic.simulated?check.semantic.outcome:null;
  if(check.outcome==='different'||semantic==='different')return 'different';
  if(check.outcome==='consistent')return 'consistent';
  return semantic==='consistent'&&['manual','single_source','insufficient'].includes(check.outcome)&&!check.sourceQualityBlocked?'consistent':null;
}

/** A check that is not attached to a subject belongs to the case, to the not yet confirmed subject, or to the only
 * subject of the rule's role: with one guarantor in the run, what its files show can be about no one else. */
const scopeMatches=(objectId:string|null,scopeId:string,sole:string|null)=>objectId===null?scopeId==='case'||scopeId.startsWith('unconfirmed:')||scopeId===sole:objectId===scopeId;
const bankRuleId=(fieldId:string,row:number)=>`${fieldId.startsWith('pg_')?'pg':'cgt'}_bank_${row}`;

/** A rule the engine can only hand to a person, or could not evaluate for want of an adopted value, is recorded as
 * satisfied or not satisfied once the system's own checks of that rule have all concluded: the checks of its judgement
 * chain, and the automatic checks frozen with the run that name the rule (for example, that a required field was
 * verified to have a value in the original text). The engine's own answer is kept in `resolution`.
 *
 * A model that found no value for a field is not evidence that the file leaves it blank: it may not have been shown the
 * value (redaction can swallow a label together with what follows it). A required field without a value therefore stays
 * as the engine returned it, for a person to look at.
 *
 * Nothing else is resolved: unknown applicability and reference lists stay as the engine returned them, an automatic
 * check that found a problem or needs confirmation keeps the rule open, and so does a person's current non-consistent
 * conclusion on the row. */
export function resolveSystemJudgement<T extends EngineResult>(results:T[],snapshot:FrozenJudgement,manifest:ReviewConfigManifest):Array<T&{resolution?:ResultResolution}> {
  if(!systemJudgementEnabled(snapshot.requirementPolicy))return results;
  const ruleIds=new Set(manifest.rules.map(rule=>rule.id));
  const soleSubject=(ruleId:string)=>{
    const role=manifest.rules.find(rule=>rule.id===ruleId)?.objectScope?.role,own=role?(snapshot.objects??[]).filter(object=>object.role===role):[];
    return own.length===1?own[0]!.objectId:null;
  };
  const byRule=new Map<string,Array<{rowId:string;check:CrossFileCheck}>>();
  for(const row of snapshot.crossFileChecklist??[])for(const check of row.crossChecks??[]){
    // A bank workbook row decides the rule of that row; a legal opinion checklist item names its own rule.
    const ids=[...(check.bankRule?[bankRuleId(row.fieldId,check.bankRule.row)]:[]),...(check.checklistRule?[check.checklistRule.id]:[])];
    for(const id of new Set(ids))if(ruleIds.has(id))byRule.set(id,[...(byRule.get(id)??[]),{rowId:row.id,check}]);
  }
  const automatic=new Map<string,AutomaticReviewCheck[]>();
  for(const check of snapshot.automaticChecks??[])for(const id of new Set(check.ruleIds))if(ruleIds.has(id))automatic.set(id,[...(automatic.get(id)??[]),check]);
  const humanOpen=new Set((snapshot.fieldReviews??[]).filter(review=>review.verification.validity==='current'&&!review.verification.origin&&review.verification.meaning!=='consistent').map(review=>review.id));
  return results.map(result=>{
    if(result.outcome!=='blocked'||!['manual_review_required','input_insufficient'].includes(result.reasonCode))return result;
    // A value the engine found missing is settled only by an automatic check of that rule; a judgement chain alone
    // settles the rules the engine hands to a person.
    const sole=soleSubject(result.ruleId);
    const checks=result.reasonCode==='manual_review_required'?(byRule.get(result.ruleId)??[]).filter(entry=>scopeMatches(entry.check.objectId,result.scopeId,sole)):[];
    const concluded=checks.map(entry=>({...entry,conclusion:checkConclusion(entry.check)})).filter(entry=>entry.conclusion!=='not_applicable');
    const verified=(automatic.get(result.ruleId)??[]).filter(check=>scopeMatches(check.objectId,result.scopeId,sole));
    if(!concluded.length&&!verified.length)return result;
    const resolution:ResultResolution={version:SYSTEM_JUDGEMENT_VERSION,engineOutcome:result.outcome,engineReasonCode:result.reasonCode,checkIds:[...concluded.map(entry=>entry.check.id),...verified.map(check=>check.id)].sort()};
    if(concluded.some(entry=>entry.conclusion==='different'))return {...result,outcome:'fail',reasonCode:'system_check_different',resolution};
    const rowIds=[...concluded.map(entry=>entry.rowId),...verified.map(check=>check.item.rowId)];
    if(concluded.every(entry=>entry.conclusion==='consistent')&&verified.every(check=>check.status==='done')&&!rowIds.some(id=>humanOpen.has(id)))return {...result,outcome:'pass',reasonCode:'system_check_satisfied',resolution};
    return result;
  });
}
