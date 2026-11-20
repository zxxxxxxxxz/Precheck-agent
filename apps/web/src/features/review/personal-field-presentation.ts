import type {ChecklistRow, CrossFileCheck} from '@hsbc/contracts/review-checklist';
import {PERSONAL_FIELDS} from '@hsbc/contracts/personal-requirements';

/** Reading labels only: published field IDs, definitions and rules stay intact. */
export function checklistFieldLabel(row:ChecklistRow) {
  const field=PERSONAL_FIELDS.find(field=>field.id===row.fieldId);
  if(!field||row.label!==field.label.replace(/\n/g,' '))return row.label;
  if(['pg_field_19','pg_field_20','pg_field_35'].includes(row.fieldId)&&!row.rules.some(rule=>/^pg_bank_(?:21|22|38)$/.test(rule.id)&&/^留空(?:\s|$)/u.test(rule.text.trim())))return row.label;
  const labels:Record<string,string>={pg_field_8:'新本票提交周期',pg_field_9:'保证书适用法律',pg_field_18:'本票签发日',pg_field_19:'给付日（应留空）',pg_field_20:'给付金额（应留空）',pg_field_24:'本票准据法',pg_field_27:'授权书签署日',pg_field_29:'授权书适用法律',pg_field_35:'背书人（应留空）'};
  return labels[row.fieldId]??(field.meaning||row.label);
}

export function personalChecklistSection(fieldId:string) {
  if(fieldId==='pg_field_37')return {id:'pg-legal-full-text',label:'法律意见全文'};
  if(['pg_legal_route','pg_legal_firm','pg_legal_intro_1','pg_legal_intro_2','pg_legal_intro_6'].includes(fieldId))return {id:'pg-legal-basic',label:'基本信息与使用范围'};
  if(['pg_legal_references','pg_legal_intro_3'].includes(fieldId))return {id:'pg-legal-documents',label:'主体与审阅文件'};
  if(/^pg_legal_checklist_\d+(?:_applicable)?$/u.test(fieldId))return {id:'pg-legal-conclusions',label:'法律结论（按 Checklist 核对）'};
  if(['pg_legal_conditions','pg_legal_intro_4','pg_legal_intro_5'].includes(fieldId))return {id:'pg-legal-conditions',label:'假设、保留与后续事项'};
  const groups:Array<[string,string,string[]]>=[
    ['parties','主体与担保责任',['4','5','6','7','8']],
    ['signing','法律与签署',['9','10','11','12']],
    ['identity','担保人身份与地址',['13','14','15']],
    ['note-terms','金额、日期与留空栏',['17','18','19','20','21','24']],
    ['note-signing','发票人签署与地址',['22','23']],
    ['authorization-terms','授权范围与日期',['26','27','28','29']],
    ['authorization-person','立书人身份与签署',['30','31','32','33','34','35']],
  ];
  const group=groups.find(([, , ids])=>ids.some(id=>fieldId===`pg_field_${id}`));
  return group?{id:`pg-${group[0]}`,label:group[1]}:undefined;
}

/** Partition by field identity, never by similar values or filenames. */
export function personalComparisonSides(checks:CrossFileCheck[],fieldId:string) {
  const sources=[...new Map(checks.flatMap(check=>check.sources.map(source=>({check,source}))).map(item=>[item.source.id,item])).values()];
  return {primary:sources.filter(({source})=>source.fieldId===fieldId),references:sources.filter(({source})=>source.fieldId!==fieldId)};
}
