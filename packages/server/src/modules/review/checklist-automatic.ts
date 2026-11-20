import type {ChecklistRow} from '@hsbc/contracts/review-checklist';
import type {AutomaticReviewCheck,FrozenFieldReview} from '@hsbc/contracts/field-verification';

/** Display the same independently grounded result used by pre-review. A source
 * presence check must never complete a broader bank comparison. */
export function projectChecklistAutomatic(rows:ChecklistRow[],automatic:{fields:FrozenFieldReview[];checks:AutomaticReviewCheck[];sourceGaps?:Array<{rowId:string;reasons:string[]}>}):ChecklistRow[]{
 const verified=new Map(automatic.fields.map(f=>[f.id,f.verification]));
 return rows.map(row=>{
  const verification=row.verification?.validity==='current'?row.verification:verified.get(row.id)??row.verification;
  const crossChecks=row.crossChecks?.map(check=>{
   const bank=check.bankRule;if(!bank||check.valueBasis==='extracted')return check;
   const prefix=bank.reference.startsWith('SRC-CGT/')?'cgt':bank.reference.startsWith('SRC-PG/')?'pg':undefined;
   const completed=automatic.checks.find(c=>c.fieldId===row.fieldId&&c.objectId===row.objectId&&c.ruleIds.includes(`${prefix}_bank_${bank.row}`)&&['done','open'].includes(c.status));
   if(!completed)return check;
   return {...check,outcome:completed.status==='open'?'different' as const:completed.item.meaning==='not_applicable'?'not_applicable' as const:'consistent' as const,reason:completed.reason,
    sources:check.sources.map(source=>{
     const grounded=source.documentId&&source.values.length&&source.values.every(value=>completed.item.sources.some(s=>s.kind==='original'&&s.value===value&&source.evidence.some(e=>JSON.stringify(e)===JSON.stringify(s.evidence))));
     return grounded?{...source,state:'available' as const,warnings:[]}:source;
    })};
  });
  const gap=!crossChecks?.length&&verification?.validity!=='current'?automatic.sourceGaps?.find(g=>g.rowId===row.id):undefined;
  return {...row,verification,crossChecks,...(gap?{reason:gap.reasons.join('\n')}:{} )};
 });
}
