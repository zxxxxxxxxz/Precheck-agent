import {isPersonalWorkbookField} from './personal-bank-support.ts';
import {fixedComparisonValue,type ChecklistRow,type ChecklistStatus} from '@hsbc/contracts/review-checklist';
import type {SemanticItem} from '@hsbc/contracts/review-delivery';
import {corporateFieldSection,isCorporateSectionHeading} from '@hsbc/contracts/corporate-requirements';
import {checklistFieldLabel,personalChecklistSection} from './personal-field-presentation.ts';

export interface FieldFilters {text?:string;type?:string;object?:string;status?:ChecklistStatus;document?:string}
/** Hide auxiliary inputs as standalone cards only; keep the full rows for rule comparisons. */
export const isStandaloneChecklistField=(fieldId:string)=>isPersonalWorkbookField(fieldId)&&!isCorporateSectionHeading(fieldId)
  &&fixedComparisonValue(fieldId)===undefined
  &&fieldId!=='review_business_date'&&fieldId!=='cgt_translation_required'&&fieldId!=='cgt_identity_details';
export function filterChecklist(rows:ChecklistRow[],filters:FieldFilters,names:Record<string,string>={}) {
  const text=filters.text?.trim().toLocaleLowerCase();
  return rows.filter(row=>row.documentScope?.included!==false&&isStandaloneChecklistField(row.fieldId)&&(!filters.type||row.guaranteeTypes.includes(filters.type))
    &&(!filters.object||(row.objectId??'pending')===filters.object)
    &&(!filters.status||row.status===filters.status)
    &&(!filters.document||[...[...row.candidates,...(!row.objectId?row.unassignedCandidates??[]:[])].flatMap(c=>c.evidence),...(row.fact?.evidence??[])].some(e=>e.documentVersionId===filters.document))
    &&(!text||[row.label,checklistFieldLabel(row),row.objectLabel,row.definition,...row.materialTypes.map(m=>m.label),...[...row.candidates,...(!row.objectId?row.unassignedCandidates??[]:[])].map(c=>c.value??''),row.fact?.rawValue??'',...[...[...row.candidates,...(!row.objectId?row.unassignedCandidates??[]:[])].flatMap(c=>c.evidence),...(row.fact?.evidence??[])].map(e=>names[e.documentVersionId]??'')].join(' ').toLocaleLowerCase().includes(text)));
}
/** Derive selection from visible rows on every render, including async refreshes. */
export function visibleSelection<T extends {id:string}>(items:T[],selected?:string|null):T|undefined {
  return items.find(item=>item.id===selected)??items[0];
}
export function checklistGroups(rows:ChecklistRow[]) {
  const groups=new Map<string,{key:string;label:string;rows:ChecklistRow[]}>();
  for(const row of rows){
    if(!isStandaloneChecklistField(row.fieldId))continue;
    // A field can depend on several materials. Keep that combination intact, once.
    const section=corporateFieldSection(row.fieldId)??personalChecklistSection(row.fieldId);
    const key=(row.materialTypes.map(m=>m.id).sort().join('|')||'__rules')+(section?`:${section.id}`:'');
    const group=groups.get(key)??{key,label:[row.materialTypes.map(m=>m.label).join(' / ')||'跨材料及规则核对',section?.label].filter(Boolean).join(' · '),rows:[]};
    group.rows.push(row);groups.set(key,group);
  }
  return [...groups.values()];
}
export function fieldSemanticItems(items:SemanticItem[],row:ChecklistRow) {
  // Unknown object attribution must never receive another object's suggestion.
  return row.objectId?items.filter(i=>i.objectId===row.objectId&&(i.fieldIds.includes(row.fieldId)||row.rules.some(r=>r.id===i.ruleId))):[];
}
