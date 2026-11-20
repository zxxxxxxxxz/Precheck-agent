import type {ChecklistRow,CrossFileCheck} from '@hsbc/contracts/review-checklist';

/** Resolve textual alternatives even when the provisional highest-score value
 * happens to match the counterpart. Exact amounts/dates are not semantic jobs. */
export function needsSemanticAnalysis(check:CrossFileCheck):boolean {
  return !!check.semanticEligible&&!check.semantic&&(check.outcome!=='consistent'||
    check.sources.some(s=>s.displaySelection&&s.displaySelection.reason!=='equivalent'));
}

/** Only a server-authorized terminal failure can restart. Unknown calls and
 * exhausted attempts stay blocked, including after remounting the page. */
export function nextSemanticAction(check:CrossFileCheck):'start'|'retry'|undefined {
  if(!check.semanticEligible)return;
  if(check.semantic?.state==='failed'&&check.semantic.canRetry)return 'retry';
  if(needsSemanticAnalysis(check))return 'start';
}

/** The same cross-file group may appear under several fields. Schedule it once,
 * with an actual owning row; changing selection or filters does not change scope. */
export function semanticTasks(rows:ChecklistRow[]):Array<{check:CrossFileCheck;fieldId:string}> {
  return [...new Map(rows.flatMap(row=>(row.crossChecks??[]).filter(c=>c.semanticEligible)
    .map(check=>[check.id,{check,fieldId:row.fieldId}] as const))).values()];
}
