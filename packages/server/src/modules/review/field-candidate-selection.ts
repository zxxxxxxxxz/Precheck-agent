import {addressMeaningKey} from './address-equivalence.js';
import type {ChecklistCandidate,CrossFileValue} from '@hsbc/contracts/review-checklist';
import type {ReviewFieldDefinition} from '@hsbc/contracts/review-config';
import {normalizeReviewValue} from './normalization.js';

/** Resolve the final extraction within one document/object/field only.
 * Object attribution and source validation remain the caller's responsibility;
 * legitimate list members are never ranked as competing candidates. */
export function fieldCandidateSelection(candidates:ChecklistCandidate[],field:ReviewFieldDefinition):CrossFileValue['displaySelection'] {
  if(field.valueMultiplicity!=='single'||new Set(candidates.map(c=>c.documentId)).size>1)return;
  const present=candidates.filter((c):c is ChecklistCandidate&{value:string}=>Boolean(c.value?.trim()));
  if(present.length<2)return;
  const score=(c:ChecklistCandidate)=>typeof c.confidence==='number'&&Number.isFinite(c.confidence)&&c.confidence>=0&&c.confidence<=1?c.confidence:-1;
  const key=(value:string)=>{
    if(field.objectRole==='corporate_guarantee'&&/地址|address/iu.test(field.label)){const address=addressMeaningKey(value);if(address)return address;}
    const type=field.valueKind==='date'?'date':field.type;
    const normalized=normalizeReviewValue(value,type,{...(field.currency?{currency:field.currency}:{})});
    if(['date','amount','currency'].includes(type)&&normalized.status==='normalized')
      return JSON.stringify([type,normalized.value,normalized.currency]);
    // Preserve words, punctuation, conditions and identifiers. Formatting alone
    // may be collapsed; fuzzy similarity cannot establish semantic agreement.
    return value.normalize('NFKC').trim().replace(/\s+/gu,' ').toLocaleUpperCase();
  };
  const groups=new Map<string,typeof present>();
  for(const candidate of present){const k=key(candidate.value);groups.set(k,[...(groups.get(k)??[]),candidate]);}
  const representatives=[...groups.values()].map(group=>group.reduce((best,c)=>score(c)>score(best)?c:best));
  const max=Math.max(...representatives.map(score));
  const leaders=representatives.filter(c=>score(c)===max);
  const reason=groups.size===1?'equivalent':max>=0&&leaders.length===1?'highest_confidence':'unresolved';
  const selected=reason==='unresolved'?representatives:reason==='equivalent'?[representatives[0]!]:leaders;
  return {values:selected.map(c=>c.value),reason,candidateIds:selected.map(c=>c.id)};
}
