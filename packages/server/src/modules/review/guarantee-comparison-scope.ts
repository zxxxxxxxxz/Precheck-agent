import type {ChecklistRow} from '@hsbc/contracts/review-checklist';
import type {ReviewConfigManifest,ReviewRule} from '@hsbc/contracts/review-config';
import type {ReviewState} from '@hsbc/contracts/review';
import type {ChecklistInputDocument} from './checklist.js';

export const isGuaranteeComparisonRow=(row:ChecklistRow)=>['corporate_guarantee','personal_guarantee'].includes(row.objectRole??'');

export function comparisonDocuments(row:ChecklistRow,documents:ChecklistInputDocument[],state:ReviewState) {
  if(!row.objectId)return documents;
  const owner=state.objects.find(o=>o.objectId===row.objectId&&o.validity==='current');
  return documents.filter(d=>owner?.evidence.some(e=>e.documentVersionId===d.id&&e.parseRevision===d.parseRevision&&e.directoryRevision===d.directoryRevision));
}

/** Conditions use current explicit facts / file ownership, never names or OCR guesses. */
export function comparisonCondition(condition:NonNullable<ReviewRule['applicability']>,row:ChecklistRow,rows:ChecklistRow[],documents:ChecklistInputDocument[],manifest:ReviewConfigManifest,state:ReviewState):boolean|undefined {
  if(condition.fieldId.startsWith('material:')) {
    const material=manifest.materials.find(m=>`material:${m.id}`===condition.fieldId);
    if(!material)return undefined;
    const own=comparisonDocuments(row,documents,state);
    if(own.some(d=>d.taxonomyIds.includes(material.taxonomyId)))return condition.equals===true;
    if(documents.some(d=>d.unclassified||d.taxonomyIds.includes(material.taxonomyId)))return undefined;
    return condition.equals===false;
  }
  const fact=rows.find(r=>r.fieldId===condition.fieldId&&r.objectId===row.objectId&&r.objectRole===row.objectRole)?.fact;
  if(!fact||fact.validity!=='current'||fact.state!=='present'||fact.normalization.status==='pending')return undefined;
  return String(fact.normalizedValue??fact.rawValue)===String(condition.equals);
}

/** Optional/conditional absent files are not missing prerequisites of a comparison.
 * Required-material checks remain in the bank configuration. Supplied optional
 * files still participate, including missing or uncertain fields within them. */
export function fixedComparisonScope(fields:string[],row:ChecklistRow,rows:ChecklistRow[],documents:ChecklistInputDocument[],manifest:ReviewConfigManifest,state:ReviewState) {
  const pending:string[]=[];
  const scoped=fields.filter(id=>{
    const definition=manifest.fields.find(f=>f.id===id)!;
    const related=rows.find(r=>r.fieldId===id&&r.objectId===row.objectId&&r.objectRole===row.objectRole);
    if(related?.fact)return true;
    const types=definition.taxonomyIds??[];
    // Do not hide an ownership gap when the counterpart is actually supplied.
    if(documents.some(d=>d.unclassified||d.taxonomyIds.some(t=>types.includes(t))))return true;
    const materials=manifest.materials.filter(m=>types.includes(m.taxonomyId));
    if(!materials.length)return true;
    return materials.some(material=>{
      if(!material.required)return false;
      if(!material.applicability)return true;
      const applicable=comparisonCondition(material.applicability,row,rows,documents,manifest,state);
      if(applicable===undefined)pending.push(`${material.label}是否适用尚待确认。`);
      return applicable===true;
    });
  });
  return {fields:scoped,pending:[...new Set(pending)]};
}
