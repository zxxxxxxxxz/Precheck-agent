import type {SignatureInformationCheck,SignatureDateRecord} from '@hsbc/contracts/signature-information';
// These material types do not use a separate signature-information panel.
// Include equivalent taxonomy IDs used by personal, mixed and mortgage cases.
const materialsWithoutSignaturePanel=new Set([
 'cgt_incorporation','cgt_annual','cgt_change','cgt_facility','cgt_articles','cgt_rm','cgt_legal',
 'pg_identity','pg_registration','pg_facility','pg_note','shared_facility','facility_letter','company_articles','pg_rm',
]);
export function showsSignatureInformationPanel(materialType:string|null|undefined):boolean {
 return !!materialType&&!materialsWithoutSignaturePanel.has(materialType);
}
export const signatureDateLabels:Record<SignatureDateRecord['kind'],string>={document_signing:'文件签署日期',person_signing:'该签名对应日期',location_signing:'该位置签署日期',resolution:'决议日期',authorization_from:'授权生效日',authorization_until:'授权截止日',other:'其他日期'};
export const signatureCheckLabels:Record<SignatureInformationCheck['status'],string>={satisfied:'满足当前已确认要求',needs_confirmation:'依据不足 / 待核对',not_satisfied:'有依据支持的不满足',not_applicable:'不适用'};
const reasons:Record<string,string>={authorization_missing:'尚未关联授权依据',authorization_unconfirmed:'授权待人工核对',authorization_scope_mismatch:'授权主体或文书范围不符',authorized_person_mismatch:'签署人或职务不在授权范围内',authorization_date_unknown:'缺少明确对应的签署日期或授权期间',authorization_dates_conflict:'授权起止日期矛盾',authorization_outside_period:'签署日期不在已确认授权期间内',authorization_amount_unknown:'授权金额、交易金额、币种或依据不完整',authorization_currency_mismatch:'币种不同，无法直接比较',authorization_amount_exceeded:'交易金额超过已确认授权上限',authorization_transaction_unknown:'交易范围或依据不完整',authorization_transaction_outside_scope:'交易不在授权范围内',authorization_conflict:'关联授权存在冲突',requirement_unconfirmed:'要求尚未确认适用',signing_location_unconfirmed:'签署位置尚未确认',combination_unconfirmed:'签署组合尚未明确',signature_combination_not_satisfied:'不满足已确认的签署组合',distinct_signers_required:'该组合需要不同人员',stamp_count_requires_explicit_rule:'印章数量要求需要进一步明确',evidence_or_coverage_incomplete:'人员、重叠区域、授权或核对范围尚未明确',required_stamp_not_found:'已完整核对适用位置，未找到要求的印章',required_signers_not_found:'已完整核对适用位置，未找到足够的符合要求人员',date_rules_conflict:'适用日期规则相互冲突，需要先核对规则依据',date_rule_unconfirmed:'日期规则或依据尚未确认',date_missing_or_conflicting:'日期缺失、无法对应或来源冲突',required_date_blank:'该日期按已确认要求应填写，但原文留空',date_should_be_blank:'该日期按已确认要求应留空',date_relation_not_satisfied:'日期不符合已确认的先后或同日规则',entry_unconfirmed:'证据类型、人员对应或用途尚待核对',published_requirement_scope_unconfirmed:'已发布签署要求尚未关联主体、位置及证据',source_not_available:'要求适用，但原件依据尚不可用',requirement_complexity_limit:'组合范围较大，需人工核对'};
export const signatureReason=(code:string)=>reasons[code]??'需核对原文与适用要求';
/** Export exactly the versioned projection displayed in case review, not a separate recalculation. */
export function downloadSignatureInformation(value:unknown,filename='签署核对记录.json') {const url=URL.createObjectURL(new Blob([JSON.stringify(value,null,2)],{type:'application/json'}));const a=document.createElement('a');a.href=url;a.download=filename;a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);}
