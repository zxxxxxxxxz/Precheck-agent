import {extractionNoticeText,fieldExtractionNoticeDetail} from './extraction-notice.tsx';
import {INSURANCE_MATERIAL_TYPES, INSURANCE_REQUIREMENTS, SYNTHETIC_INSURANCE_FIELD_IDS, type InsuranceRequirement} from '@hsbc/contracts/insurance-fields';
import type {DocumentFieldObservation, FieldsResponse, LogicalDocument} from './types.ts';
import {fieldRowState, presentationFieldObservation, requiresFieldSemanticFilter, visibleDocumentFields} from './presentation.ts';
import {documentMaterialScope} from './material-scope.ts';

export interface InsuranceRequirementRow {
  requirement:InsuranceRequirement;
  fields:DocumentFieldObservation[];
  status:'extracted'|'absent'|'unsupported'|'review'|'pending'|'not_applicable';
  label:string;
  detail:string;
}
export function isInsuranceDocument(directory:readonly LogicalDocument[],materialType?:string|null):boolean {
  if(materialType)return INSURANCE_MATERIAL_TYPES.some(type=>type===materialType);
  return directory.some(document=>INSURANCE_MATERIAL_TYPES.some(type=>type===document.labelId));
}
export function isSyntheticInsuranceField(id:string):boolean {
  return SYNTHETIC_INSURANCE_FIELD_IDS.some(field=>field===id);
}
export function insuranceFieldSourceLabel(field:Pick<DocumentFieldObservation,'pageNumbers'>,directory:readonly LogicalDocument[]):string {
  return [...new Set(directory.filter(document=>document.pageNumbers.some(page=>field.pageNumbers.includes(page))).map(document=>
    document.labelId==='insurance_application'?'投保申请（拟投保）':document.labelId==='insurance_terms'?'保险条款':
      document.labelId==='insurance_product_description'?'产品说明':document.label??'文种待核对'))].join('、');
}

/** This is a view of separate observations. Never combine their IDs, evidence,
 * dates, or proposed/issued values into an adoptable manufactured fact. */
export function insuranceRequirementRows(response:FieldsResponse,directory:readonly LogicalDocument[]):InsuranceRequirementRow[] {
  const scope=documentMaterialScope(response,undefined,directory);
  if(scope&&scope.status!=='resolved')return [];
  const types=new Set(scope?.taxonomyId?[scope.taxonomyId]:[]);
  const completeClassification=scope?.status==='resolved';
  return INSURANCE_REQUIREMENTS.filter(requirement=>{
    // This panel is file-specific, not the case-wide insurance checklist.
    const definitions=response.fieldCapabilities?.filter(field=>requirement.fieldIds.some(id=>id===field.id));
    return !!definitions?.some(field=>!field.taxonomyIds?.length||field.taxonomyIds.includes(scope!.taxonomyId!));
  }).map(requirement=>{
    const configured=response.fieldCapabilities?.filter(field=>requirement.fieldIds.some(id=>id===field.id));
    const canonical=configured?.find(field=>field.id===requirement.id);
    const definitions=canonical?[canonical]:configured;
    const relevant=definitions?.filter(field=>!completeClassification||!field.taxonomyIds?.length||field.taxonomyIds.some(type=>types.has(type)));
    const ids=canonical?[canonical.id]:requirement.fieldIds;
    const fields=visibleDocumentFields(response,undefined,directory).filter(field=>ids.some(id=>id===field.fieldId))
      .map(field=>presentationFieldObservation(field,requiresFieldSemanticFilter(field.fieldId,response)));
    const row={requirement,fields};
    if(configured&&!configured.length)return {...row,status:'unsupported' as const,label:'尚未实现',detail:'当前识别配置尚未覆盖这一项。'};
    if(relevant?.length===0){
      if(requirement.id==='insurance_payment_evidence')return {...row,status:'review' as const,label:'待人工核对',detail:'本文件不是独立支付凭证，请核对其他材料及对应编号。'};
      if(!canonical)return {...row,status:'unsupported' as const,label:'尚未实现',detail:'已有相关字段，但当前识别配置尚未覆盖这份材料的文种。'};
      return {...row,status:'not_applicable' as const,label:'本文件不适用',detail:'此项需在对应的保险交易材料中查找。'};
    }
    if(relevant?.some(field=>field.mode==='manual'))return {...row,status:'review' as const,label:'在信息核对中判断',detail:'这一项由人工查看原件并确认。'};
    const hasValue=fields.some(field=>field.candidates.length>0||field.rawValue);
    const states=fields.map(field=>({field,state:fieldRowState(field,field.coverageGaps,requiresFieldSemanticFilter(field.fieldId,response))}));
    const incomplete=states.some(({state})=>state.tone==='warning');
    const issues=[...new Set(states.filter(({state})=>state.tone==='warning').map(({field,state})=>extractionNoticeText(state,{hasValue:Boolean(field.rawValue)||field.candidates.length>0,detail:fieldExtractionNoticeDetail(field)})).filter(Boolean))];
    if(hasValue)return {...row,status:incomplete?'review' as const:'extracted' as const,label:incomplete?'已提取 · 待人工核对':'已提取',detail:issues.join('；')};
    const absent=completeClassification&&fields.length>0&&fields.every(field=>field.status==='not_found'&&field.semanticFilter?.state==='completed'&&field.extractionCoverage?.state==='complete'&&
      !['failed','unknown'].includes(field.extractionCoverage.completion));
    if(absent)return {...row,status:'absent' as const,label:'原文未见',detail:requirement.id==='insurance_payment_evidence'?'当前文件未找到有依据的支付凭证；还需检查独立材料。':'本轮已检查当前文件的适用内容，未找到有依据的值。'};
    if(!completeClassification||fields.some(field=>field.status==='uncertain'||field.semanticFilter?.state==='failed'||field.extractionCoverage?.completion==='unknown'||field.extractionCoverage?.completion==='failed'))
      return {...row,status:'review' as const,label:'待人工核对',detail:'本轮提取未完成，不能据此判断原文没有该项。'};
    return {...row,status:'pending' as const,label:response.fieldCapabilities?'待提取':'待核对配置',detail:response.fieldCapabilities?'当前配置已支持，尚无完整提取结果。':'尚未取得字段配置，暂不能判断是否支持。'};
  });
}

export function insuranceSupportingFieldIds():Set<string> {
  return new Set([...INSURANCE_REQUIREMENTS.flatMap(row=>[...row.fieldIds]),...SYNTHETIC_INSURANCE_FIELD_IDS]);
}

/** A matching policy reference is only a candidate link, never payment proof.
 * The MTG workbook explicitly compares the canonical application reference to the invoice policy/endorsement reference; legacy unlabeled numbers remain excluded. */
export function paymentReferenceMatch(insurance:readonly DocumentFieldObservation[],receipt:readonly DocumentFieldObservation[]):'matching'|'different'|'unknown' {
  const references=(fields:readonly DocumentFieldObservation[],ids:string[])=>fields.filter(field=>ids.includes(field.fieldId)&&field.semanticFilter?.state==='completed')
    .flatMap(field=>field.candidates.filter(candidate=>candidate.anchorIds.length).map(candidate=>candidate.rawValue.normalize('NFKC').trim())).filter(Boolean);
  const expected=references(insurance,['insurance_application_reference','policy_number']),actual=references(receipt,['invoice_policy_reference','payment_policy_reference']);
  if(new Set(expected).size!==1||new Set(actual).size!==1)return 'unknown';
  return actual[0]===expected[0]?'matching':'different';
}
