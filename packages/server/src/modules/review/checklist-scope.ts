import type {ChecklistRow} from '@hsbc/contracts/review-checklist';
import type {ReviewConfigManifest} from '@hsbc/contracts/review-config';
import type {ReviewState} from '@hsbc/contracts/review';
import type {ChecklistInputDocument} from './checklist.js';

/** Scope work to supplied document types, never to extraction success. A blank,
 * failed or queued field still needs checking. Missing counterpart dependencies
 * stay in rows, but do not create standalone tasks for absent document types. */
export function withChecklistDocumentScope(rows:ChecklistRow[],documents:ChecklistInputDocument[],manifest:ReviewConfigManifest,state?:ReviewState):ChecklistRow[]{
  const compared=new Set(rows.flatMap(row=>row.crossChecks?.flatMap(c=>c.fieldIds)??[]));
  return rows.map(row=>{
    // Corporate and personal guarantees follow the same rule: only fields of files supplied in this round are checked now.
    if(row.objectRole!=='corporate_guarantee'&&row.objectRole!=='personal_guarantee')return row;
    const definition=manifest.fields.find(f=>f.id===row.fieldId);
    const bankField=definition?.sourceIds.some(id=>/^(?:cgt|pg)_field_source_\d+$/.test(id)||/^(?:cgt|pg)_checklist(?:_|$)/.test(id));
    const guarantee=['corporate_guarantee','personal_guarantee'].includes(row.objectRole??'');
    // Supplemental extraction (e.g. facility pricing) is available in the reader,
    // but is not a new bank comparison merely because it has a configured field.
    const auxiliary=['cgt_amount','cgt_currency','cgt_limited','cgt_user_required_amount','cgt_user_required_currency'].includes(row.fieldId);
    const inBankScope=!auxiliary&&(!guarantee||bankField||compared.has(row.fieldId));
    const owner=state?.objects.find(o=>o.objectId===row.objectId);
    const documentIds=documents.filter(d=>d.taxonomyIds.some(type=>row.materialTypes.some(m=>m.id===type))&&(!state||
      (row.objectId?owner?.evidence.some(e=>e.documentVersionId===d.id):!state.objects.some(o=>o.kind===definition?.objectKind&&(!row.objectRole||o.role===row.objectRole)&&o.evidence.some(e=>e.documentVersionId===d.id))))).map(d=>d.id);
    return {...row,documentScope:{included:!!inBankScope&&documentIds.length>0,documentIds}};
  });
}
