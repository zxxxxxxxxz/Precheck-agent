export * from '@hsbc/contracts/field-focused-reading';
import {focusedChecks as readFocusedChecks,type FieldFocus} from '@hsbc/contracts/field-focused-reading';
import {comparisonSource,type CrossFileCheck} from '@hsbc/contracts/review-checklist';

/** Fixed rule inputs cannot carry legacy material evidence into the reading desk. */
export function focusedChecks(checks:CrossFileCheck[],field:FieldFocus):CrossFileCheck[] {
  return checks.flatMap(check=>{
    const normalized={...check,sources:check.sources.map(comparisonSource)};
    // Bank checks already define their counterparts, including an empty side.
    // A second generic aspect filter must not hide the required comparison.
    return check.bankRule?[normalized]:readFocusedChecks([normalized],field);
  });
}
