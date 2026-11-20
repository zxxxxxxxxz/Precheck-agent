import type {ChecklistRow} from '@hsbc/contracts/review-checklist';
import {PERSONAL_FIELDS,personalLegalItem,PERSONAL_RETIRED_INPUTS} from '@hsbc/contracts/personal-requirements';
const workbookFields=new Set<string>(PERSONAL_FIELDS.map(f=>f.id));
/** Bank rows are the task list. Reference extractions and internal inputs remain
 * available inside their bank item, not counted as additional bank requirements. */
export const isPersonalWorkbookField=(id:string)=>!id.startsWith('pg_')||workbookFields.has(id)||personalLegalItem(id)||personalSupportParent(id)===undefined;
const parents:Record<string,string>={
 pg_required:'pg_field_4',pg_note_required:'pg_field_17',pg_authorization_required:'pg_field_26',pg_identity_required:'pg_field_40',
 pg_legal_route:'pg_field_37',pg_limited:'pg_field_7',pg_taiwan_law:'pg_field_9',pg_bank_signed:'pg_field_11',pg_guarantor_signed:'pg_field_12',pg_translation_required:'pg_field_4',
 pg_identity_confirmed:'pg_field_14',pg_verified_identity_number:'pg_field_14',pg_required_amount:'pg_field_7',pg_guarantee_currency:'pg_field_7',pg_note_currency:'pg_field_17',pg_required_currency:'pg_field_7',
 pg_facility_parties:'pg_field_6',pg_identity_name:'pg_field_13',pg_identity_number:'pg_field_14',pg_identity_address:'pg_field_15',
 pg_approval_parties:'pg_field_6',pg_approval_required_amount:'pg_field_7',pg_approval_conditions:'pg_field_37',
};
export function personalSupportParent(fieldId:string):string|undefined {
 if(workbookFields.has(fieldId)||personalLegalItem(fieldId)||fieldId==='pg_yes'||PERSONAL_RETIRED_INPUTS.has(fieldId))return;
 return parents[fieldId]??(fieldId.startsWith('pg_legal_')?'pg_field_37':undefined);
}
export function personalBankSupportRows(row:ChecklistRow,rows:ChecklistRow[]){
 return rows.filter(other=>other.objectId===row.objectId&&other.objectRole===row.objectRole&&personalSupportParent(other.fieldId)===row.fieldId);
}
