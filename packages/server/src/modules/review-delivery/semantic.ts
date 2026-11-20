import type {ReviewConfigRelease} from '@hsbc/contracts/review-config';
import type {DocumentBundle} from '@hsbc/contracts/documents';
import type {AnalysisEvidence,SemanticItem} from '@hsbc/contracts/review-delivery';
import {buildRuleInstances,reviewHash,type ReviewSnapshot} from '../review/service.js';
import {sourceReferences} from '../documents/translations/source.js';
import {corporateBankScope,CORPORATE_PRE_REVIEW_BOUNDARY} from '../review/requirement-policy.js';

export const ANALYSIS_VERSION='review-assistance.v8';
/** Selection only: the requirement itself always comes from the published bank release. */
export const SEMANTIC_CATALOG:Record<string,{kind:SemanticItem['kind'];extraFields:string[];boundary:string}>={
  cgt_bank_4:{kind:'identity',extraFields:['cgt_field_26','cgt_field_35'],boundary:'总行／分行仅列明规则与证据，接受与否保留人工判断。'},
  cgt_bank_8:{kind:'identity',extraFields:['cgt_field_27','cgt_field_34'],boundary:'名称相似或翻译相近不建立主体同一性。'},
  cgt_bank_10:{kind:'identity',extraFields:['cgt_field_24','cgt_field_42','cgt_field_61','cgt_field_63'],boundary:'多担保人逐一核对，主体归属须有确认记录。'},
  cgt_bank_13:{kind:'liability',extraFields:['cgt_limited','cgt_amount','cgt_currency','cgt_required_amount','cgt_required_currency'],boundary:'区别限额、无限额、条件和例外；不能以未填写金额推定无限额。'},
  cgt_bank_7:{kind:'value',extraFields:['cgt_field_19','cgt_field_25','cgt_authorization_date','review_business_date'],boundary:'核对日期及适用事件；授权是否有效仍需人工判断。'},
  cgt_bank_15:{kind:'authorization',extraFields:['cgt_field_29','cgt_field_30','cgt_field_31','cgt_field_64','cgt_field_65'],boundary:'分析授权及共同签署条件，不验证签名真实性，不取消原人工要求。'},
  cgt_bank_32:{kind:'identity',extraFields:['cgt_identity_details','cgt_field_16','cgt_field_18'],boundary:'授权签字人名称须与身份证明对应，不以名称相似建立身份或授权。'},
  cgt_bank_33:{kind:'authorization',extraFields:['cgt_field_29','cgt_field_44','cgt_field_64','cgt_jurisdiction','cgt_resolution_kind','cgt_charter_minimum'],boundary:'只分析名单、人数及条件；香港董事会例外不得套用股东会，不验证实际签署真伪。'},
  pg_bank_4:{kind:'identity',extraFields:['pg_field_21','pg_field_26'],boundary:'总分行接受条件必须以已发布规则和原文为依据。'},
  pg_bank_5:{kind:'identity',extraFields:['pg_field_13','pg_field_28','pg_field_31','pg_field_40'],boundary:'同名个人仍可能为不同主体；证件归属及对象确认不可省略。'},
  pg_bank_7:{kind:'value',extraFields:['pg_limited'],boundary:'金额币种及条件与程序检查并列，模型不能覆盖已确认数值。'},
  pg_bank_8:{kind:'value',extraFields:['pg_field_10','pg_field_18'],boundary:'完整保留本票更新期限及条件，依已发布规则提醒人工判断，不自行决定更新日期。'},
  pg_bank_10:{kind:'value',extraFields:['pg_taiwan_law','pg_field_9'],boundary:'日期须连同其限制的事件和期限解释；审核日来自固定快照，台湾法是否适用须确认，不猜测。'},
  pg_bank_19:{kind:'value',extraFields:['pg_field_7','pg_field_17'],boundary:'核对本票与担保金额、币种及适用条件，不判断票据真伪。'},
};
// These describe the rendered-page mapping, not lost native text. Only verified
// OOXML anchors can use this path. Missing notes, hidden/unsupported content and
// mapping budgets remain blocking; visual execution is still a manual check.
const sourceOnlyWarnings=new Set(['visible_sequence_not_mapped','source_structure_only','repeated_source_sequence','preview_geometry_unavailable','source_visibility_not_visually_verified',
  'source_to_preview_mapping_not_established','source_visibility_is_markup_only','docx_preview_disabled','source_mapping_incomplete']);
const programDependencies:Record<string,string[]>={cgt_bank_13:['cgt_amount_minimum'],cgt_bank_7:['cgt_signing_authorized','cgt_field_6_not_future'],pg_bank_19:['pg_note_amount_ceiling']};
/** Complete chunks and all dependency references are retained; no keyword snippets or punctuation normalization. */
export function evidenceFromBundle(bundle:DocumentBundle,filename:string,materialTypeConfirmed=false):AnalysisEvidence[]{
  return bundle.chunks.map(chunk=>{
    const source=sourceReferences(bundle,chunk);
    const allGaps=[...bundle.coverageGaps,...chunk.coverageGaps];
    const verifiedNative=bundle.scope.sourceFormat==='docx'&&source.sourceNodeIds.length>0;
    const nativeOnly=Boolean(verifiedNative&&allGaps.some(g=>sourceOnlyWarnings.has(g)));
    const gaps=allGaps.filter(g=>!(verifiedNative&&sourceOnlyWarnings.has(g))&&!(materialTypeConfirmed&&g==='logical_directory_requires_confirmation'));
    if(chunk.unresolvedReferences.length||chunk.dependencyIds.some(id=>!bundle.chunks.some(c=>c.id===id)))gaps.push('引用未完整解析');
    const common={documentVersionId:bundle.scope.documentVersionId,parseRevision:bundle.scope.parseRevision,directoryRevision:Number(bundle.directoryRevision)};
    return {id:reviewHash([bundle.scope.documentVersionId,bundle.scope.parseRevision,bundle.directoryRevision,chunk.id]),documentId:common.documentVersionId,
      filename,parseRevision:common.parseRevision,directoryRevision:common.directoryRevision,text:chunk.text,sha256:chunk.textSha256,
      locations:source.sourceNodeIds.length?source.sourceNodeIds.map(sourceNodeId=>({...common,sourceNodeId})):source.anchorIds.map(anchorId=>({...common,anchorId})),
      warnings:[...new Set(gaps)],...(nativeOnly?{sourceNotes:['按已核验的 Word 原生段落读取；页面外观、遮挡和签署真实性仍需人工核对。']}:{}),referenceTranslations:[]};
  });
}
export function semanticChecklist(snapshot:ReviewSnapshot,release:ReviewConfigRelease,results:Array<{ruleId:string;scopeId:string;outcome:string}>,evidence:AnalysisEvidence[],modelEnabled:boolean):SemanticItem[]{
  const instances=buildRuleInstances(snapshot,release);
  return instances.flatMap(instance=>instance.ruleIds.map(ruleId=>{
    const rule=release.manifest.rules.find(r=>r.id===ruleId)!,entry=SEMANTIC_CATALOG[ruleId],object=snapshot.objects.find(o=>o.objectId===instance.scopeId),fields=[...new Set([...rule.inputs,...(entry?.extraFields??[])])];
    const documents=new Set(object?.evidence.map(e=>e.documentVersionId)??[]);
    // Only receipt-bound facts on the explicitly resolved scope can contribute documents.
    for(const field of fields){const ids=instance.facts[field]?.evidenceIds??[];for(const f of snapshot.facts)if(ids.includes(`fact:${f.factId}:${f.version}`))for(const e of f.evidence)documents.add(e.documentVersionId);}
    const relevant=evidence.filter(e=>documents.has(e.documentId)),problems:string[]=[];
    if(!object||object.validity!=='current')problems.push('对象归属未确认');
    if(rule.inputs.some(f=>!['present','blank'].includes(instance.facts[f]?.state??'missing')))problems.push('规则所需事实尚未完整确认');
    if(rule.applicability&&(instance.facts[rule.applicability.fieldId]?.state!=='present'||instance.facts[rule.applicability.fieldId]?.value!==rule.applicability.equals))problems.push(instance.facts[rule.applicability.fieldId]?.state==='present'?'本轮明确不适用，未执行此项语义核对':'规则适用条件尚未确认');
    if(!relevant.length||[...documents].some(id=>!relevant.some(e=>e.documentId===id)))problems.push('缺少可定位的完整原文');
    if(relevant.some(e=>e.warnings.length))problems.push('解析或引用不完整');
    if(relevant.reduce((n,e)=>n+e.text.length,0)>48000)problems.push('完整原文超出本批分析上限，需人工核对');
    if(!modelEnabled)problems.push('私有语义分析未启用');
    const supported=Boolean(entry)&&['corporate_guarantee','personal_guarantee'].includes(object?.role??'');
    const scopeBoundary=corporateBankScope(snapshot.requirementPolicy)&&rule.objectScope?.role==='corporate_guarantee'?CORPORATE_PRE_REVIEW_BOUNDARY:'';
    return {id:reviewHash([ruleId,instance.scopeId]),ruleId,ruleLabel:rule.label,ruleText:[rule.description??rule.label,scopeBoundary].filter(Boolean).join('\n'),
      ruleSources:rule.sourceIds.map(id=>release.manifest.sources.find(s=>s.id===id)?.reference??id),objectId:instance.scopeId,objectLabel:object?.label??'对象待确认',
      kind:entry?.kind??'outside_scope',fieldIds:fields,confirmedInputs:fields.map(fieldId=>({fieldId,label:release.manifest.fields.find(f=>f.id===fieldId)?.label??fieldId,state:instance.facts[fieldId]?.state??'missing',value:instance.facts[fieldId]?.value??null})),programChecks:results.filter(r=>r.scopeId===instance.scopeId&&[ruleId,...(programDependencies[ruleId]??[])].includes(r.ruleId)).map(r=>({ruleId:r.ruleId,outcome:r.outcome})),originalOutcome:results.find(r=>r.ruleId===ruleId&&r.scopeId===instance.scopeId)?.outcome??'unfinished',
      outcome:problems.length?'insufficient':'manual',state:supported&&!problems.length?'pending':'unavailable',reason:!supported?'未纳入首批语义范围；保留原检查及人工要求。':problems.join('；')||'等待辅助语义分析',
      limitations:[entry?.boundary??'沿用原检查要求。','仅为辅助分析，不替代程序检查、人工决定或正式云审核。'],evidenceIds:relevant.map(e=>e.id),citations:[],method:'not_run',simulated:false} satisfies SemanticItem;
  }));
}
