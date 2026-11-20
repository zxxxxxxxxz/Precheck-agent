import {corporateOpinionChecks} from './corporate-opinion-checks.js';
import {corporatePreReviewChecks,mergeCorporateScopeChecks} from './corporate-pre-review-scope.js';
import {corporateSignatureChecks,type CorporateSignatureOriginal} from './corporate-signature-checks.js';
import {addressMeaningKey} from './address-equivalence.js';
import {currentRequirementPolicy,translationRequirementDisabled} from './requirement-policy.js';
import type {AutomaticReviewCheck,ReviewedRuleInputs} from '@hsbc/contracts/field-verification';
import {createHash} from 'node:crypto';
import type {ChecklistRow} from '@hsbc/contracts/review-checklist';
import type {ReviewConfigManifest,ReviewFacts,ReviewRequirementPolicy} from '@hsbc/contracts/review-config';
import {CORPORATE_WORKBOOK_SHA256} from '@hsbc/contracts/corporate-requirements';
import type {DB} from '../../infrastructure/database/client.js';
import type {ChecklistInputDocument} from './checklist.js';
import {corporateCheckSources,corporatePageStatements,corporateNameKey,corporateTextKey,uniqueSources,type CorporateSource,type CorporateCheckContext} from './corporate-check-sources.js';
import {normalizeDate} from './normalization.js';
import {corporateDirectorChecks} from './corporate-director-checks.js';

// Bank-supplied blank GRM certificate, not a customer specimen or a legal approval.
export const CORPORATE_RM_TEMPLATE_SHA256='6eee9b24e9d1c29ed9a43b71f449d59c873d02cf346955b9b22f650c3472769b';
// Normalized clause digests keep the supplied document's text out of source
// control. Its immutable file hash above identifies the comparison reference.
export const CORPORATE_RM_CLAUSE_HASHES=Object.freeze([
 'fced343d49952674499b38726c89ece3b39fe8b8f0fb1ee4f4fb0ec77d66ce6e',
 'a5a327e3cc36222aaa05400ddb1f7a2a54f239968bf87b7f753986127cb1da46',
 '759d947b99fb799b083cd62d14d2a60a400ca85f552d1d7e71f4535ff27ff0ab',
 '649f69515100c2c46753405d2e213492635b6a86e0ac403bb118ea2c574b2508',
 'ad489d4e5039faf1c1e6a9966b1023ca27ce9a96f9818e736912919e01b48aaf',
]);
export type CorporateCheckResult={status:AutomaticReviewCheck['status'];reason:string;sources:CorporateSource[];ruleIds?:string[];execution?:AutomaticReviewCheck['execution']};
const text=(sources:CorporateSource[])=>sources.map(s=>s.value).join('\n');
const same=(a:string,b:string)=>corporateNameKey(a)===corporateNameKey(b);
const distinct=(values:string[])=>[...new Set(values)];
const dates=(s:string)=>distinct((s.match(/\b\d{1,2}\s+(?:January|February|March|April|May|June|July|August|September|October|November|December)\s+\d{4}\b|\b\d{4}-\d{1,2}-\d{1,2}\b|\d{4}年\s*\d{1,2}月\s*\d{1,2}日/giu)??[]).flatMap(d=>{const n=normalizeDate(d);return n.value?[n.value]:[];}));
const refs=(s:string)=>distinct(s.match(/\b[A-Z]{2,}[0-9]*-[A-Z0-9]+-[A-Z0-9]+\b/gu)??[]);
const clauseKey=(s:string)=>corporateTextKey(s).replace(/\[(?:NOT )?SELECTED\]/gu,'').replace(/[\s;；,.，。:：]/gu,'');
export function compareCorporateRmClauses(value:string,referenceHashes:ReadonlyArray<string>=CORPORATE_RM_CLAUSE_HASHES){
 value=originalClauseLayout(value);
 const chunks=[...value.matchAll(/\(([a-e])\)\s*([\s\S]*?)(?=\[(?:NOT )?SELECTED\]|\([a-e]\)|$)/giu)];
 const mismatches:string[]=[];
 for(let i=0;i<5;i++){
  const letter=String.fromCharCode(97+i),found=chunks.filter(c=>c[1]!.toLowerCase()===letter);
  const actual=found[0]?.[2]?.replace(/\b(?:OR|AND)\s*;?\s*$/u,'')??'';
  const connector=i===0?/\bOR\s*;?\s*$/u:i===1?/\bAND\s*;?\s*$/u:undefined;
  if(found.length!==1||connector&&!connector.test(found[0]?.[2]??'')||createHash('sha256').update(clauseKey(actual)).digest('hex')!==referenceHashes[i])mismatches.push(letter);
 }
 // Unexpected substantive text outside the five clauses must not disappear.
 const prefix=value.slice(0,chunks[0]?.index??value.length).replace(/I certify that\s*:/iu,'').replace(/\[(?:NOT )?SELECTED\]/gu,'').trim();
 if(prefix||!/^I certify that\s*:/iu.test(value)||referenceHashes.length!==5)mismatches.push('前言');
 return {equal:mismatches.length===0,mismatches};
}
const originalClauseLayout=(value:string)=>value.replace(/\s+/gu,' ').trim();

export function corporateMeetingCheck(sources:CorporateSource[],businessDate:string):CorporateCheckResult{
 const value=text(sources),found=dates(value);
 if(found.length!==1)return {status:'confirm',reason:found.length?'会议记录出现多个不同日期，请确认本次会议日期。':'会议原文未明确记载可识别的日期，请补全会议日期。',sources};
 // Old published fields combine date, time and venue; newer fields are separate.
 const place=value.replace(/\b\d{1,2}\s+[A-Za-z]+\s+\d{4}\b|\d{4}年\s*\d{1,2}月\s*\d{1,2}日|\d{4}-\d{1,2}-\d{1,2}/gu,'')
  .replace(/\b\d{1,2}:\d{2}(?:\s*[–—-]\s*\d{1,2}:\d{2})?\b/gu,'').replace(/\b(?:Hong\s+Kong\s+time|HKT|UTC|Time|Date|Place|Venue|Meeting|at|on)\b/giu,'').replace(/[\s:：,，;；–—-]/gu,'');
 if(found[0]!>businessDate)return {status:'open',reason:`会议日期 ${found[0]} 晚于审核基准日 ${businessDate}，请更正。`,sources};
 if(place.length<4||/^(?:notprovided|notspecified|tobeconfirmed|unknown|未填写|未填寫|待定)$/iu.test(place))return {status:'open',reason:'已核对会议日期，但会议地点为空或仅有标签，请补全地点。',sources};
 return {status:'done',reason:'已核对会议日期不晚于审核基准日，会议地点有完整取值；原文未列具体时刻不作为缺项。',sources};
}

/** At least one substantial, grounded prose passage per foreign document. Keep
 * evidence for EVERY reported file; do not truncate a long first document and
 * accidentally lose the provenance for the rest of the missing translations. */
export function corporateForeignMaterials(c:Pick<CorporateCheckContext,'pages'>){
 const found=new Map<string,{filename:string;sources:CorporateSource[];embeddedChinese:boolean}>();
 for(const p of c.pages){
  if(!p.trusted||p.document.taxonomyIds.every(t=>['cgt_translation','cgt_annual','cgt_change'].includes(t)))continue;
  const words=(p.text.match(/\b[A-Za-z]{2,}\b/gu)?.length??0),han=(p.text.match(/\p{Script=Han}/gu)?.length??0);
  if(words<40||han>=30||!(/\b(?:shall|hereby|certify|certification|guarantee|resolved|incorporated|articles)\b/iu.test(p.text)))continue;
  const best=[...p.sources].sort((a,b)=>b.quote.length-a.quote.length).find(s=>(s.quote.match(/\b[A-Za-z]{2,}\b/gu)?.length??0)>=15&&!/\p{Script=Han}/u.test(s.quote));
  if(best&&!found.has(p.document.id)){
   const chinese=c.pages.find(other=>other.document.id===p.document.id&&other.trusted&&(other.text.match(/\p{Script=Han}/gu)?.length??0)>=80);
   const chineseSource=chinese?.sources.find(s=>(s.quote.match(/\p{Script=Han}/gu)?.length??0)>=40);
   found.set(p.document.id,{filename:p.document.filename,sources:[best,...(chineseSource?[chineseSource]:[])],embeddedChinese:!!chineseSource});
  }
 }
 return [...found.values()];
}

function sourceComparison(c:CorporateCheckContext,fieldId:string,leftType:string,rightType:string):CorporateCheckResult|undefined{
 const left=c.values(fieldId,leftType),right=c.values(fieldId,rightType);if(!left.length||!right.length)return;
 const equality=left.every(l=>right.some(r=>same(l.value,r.value)))&&right.every(r=>left.some(l=>same(l.value,r.value)));
 const reviewed=c.own.find(r=>r.fieldId===fieldId)?.verification;
 const accepted=reviewed?.scope==='cross_file'&&reviewed.meaning==='consistent'&&left.length===right.length;
 return {status:equality||accepted?'done':'confirm',reason:equality?'已逐个比对保证书与授信函中的对应主体，名称一致。':accepted?'已复核两份材料的全部对应主体及当前人工跨文件一致性记录，保留已核对的名称对应关系。':'保证书与授信函所列主体名称不一致，请判断差异是否可接受。',sources:[...left,...right]};
}

/** Executes the remaining workbook comparisons against current originals. A
 * missing benchmark/document is reported only after inspecting its actual input
 * or the closed inventory; failed reading remains a system gap. */
export async function corporateMaterialChecks(db:DB,rows:ChecklistRow[],manifest:ReviewConfigManifest,scopes:ReviewedRuleInputs[],documents:ChecklistInputDocument[],businessDate:string,instances:Array<{scopeId:string;facts:ReviewFacts}>,policy:ReviewRequirementPolicy=currentRequirementPolicy(),signatureOriginal?:CorporateSignatureOriginal):Promise<AutomaticReviewCheck[]>{
 const checks:AutomaticReviewCheck[]=[];
 const supported=(id:string,field:string,source:string,operator='manual_review')=>{
  const r=manifest.rules.find(r=>r.id===id);
  return !!r&&r.operator===operator&&r.inputs.length===1&&r.inputs[0]===field&&r.objectScope?.role==='corporate_guarantee'&&!r.requiredParameters.length&&r.sourceDirectionConfirmed&&r.sourceIds.length===1&&r.sourceIds[0]===source&&manifest.sources.some(s=>s.id===source&&s.sha256===CORPORATE_WORKBOOK_SHA256&&['candidate','confirmed'].includes(s.disposition));
 };
 for(const scope of scopes){
  if(scope.policyVersion!=='reviewed-rule-inputs-v1'||scope.configurationReleaseId!==manifest.releaseId)continue;
  const facts=instances.find(i=>i.scopeId===scope.scopeId)?.facts;if(!facts)continue;
  const c=await corporateCheckSources(db,rows,scope,documents,facts);
  checks.push(...corporateOpinionChecks(c,manifest,scope.scopeId));
  const emit=(number:number,field:string,result:CorporateCheckResult|undefined)=>{
   const id=`cgt_bank_${number}`,row=c.own.find(r=>r.fieldId===field),rule=manifest.rules.find(r=>r.id===id);
   if(!row||!result||!result.sources.length||!supported(id,field,`cgt_rule_source_${number}`)||rule?.applicability&&facts[rule.applicability.fieldId]?.value!==rule.applicability.equals)return;
   const dependencies:Record<string,[string[],string,string]>={cgt_bank_55:[['cgt_field_44'],'cgt_rule_source_55','manual_review'],cgt_bank_61:[['cgt_field_51','cgt_field_54'],'cgt_rule_source_61','manual_review'],cgt_bank_62:[['cgt_field_56','cgt_field_58'],'cgt_rule_source_62','manual_review'],cgt_field_56_required:[['cgt_field_56'],'cgt_field_source_56','present']};
   const ruleIds=(result.ruleIds??[id]).filter(other=>{
    const dependency=dependencies[other],candidate=manifest.rules.find(r=>r.id===other);
    return (other===id||dependency&&dependency[0].some(field=>supported(other,field,dependency[1],dependency[2])))&&(!candidate?.applicability||facts[candidate.applicability.fieldId]?.value===candidate.applicability.equals);
   });
   const sources=uniqueSources(result.sources),reason=result.reason;
   if(sources.length>40||!ruleIds.length)return;
   checks.push({id:`corporate-material-v1:${scope.scopeId}:${id}`,objectId:row.objectId,fieldId:field,ruleIds,status:result.status,reason,execution:result.execution??{version:'corporate-material-v1',referenceHashes:[CORPORATE_WORKBOOK_SHA256,...(number===49?[CORPORATE_RM_TEMPLATE_SHA256]:[])],evidence:[]},
    item:{rowId:row.id,objectId:row.objectId,fieldId:field,scope:'bank_rule',meaning:result.status==='done'?'consistent':result.status==='open'?'different':'pending',reason,actions:result.status==='done'?[]:[reason],sources}});
  };
  emit(4,'cgt_field_4',sourceComparison(c,'cgt_field_4','cgt_guarantee','cgt_facility'));
  emit(8,'cgt_field_7',sourceComparison(c,'cgt_field_7','cgt_guarantee','cgt_facility'));
  const guarantor=c.values('cgt_field_9','cgt_guarantee'),official=c.values('cgt_field_61','cgt_incorporation'),obligation=c.values('cgt_required','cgt_facility');
  if(guarantor.length&&official.length&&obligation.length){
   const matches=guarantor.every(g=>official.some(o=>same(g.value,o.value))&&obligation.some(o=>corporateNameKey(o.value).includes(corporateNameKey(g.value))&&/出具.{0,100}(?:公司保证|公司保證|公司担保|公司擔保)|corporate guarantee (?:from|by|provided by)/iu.test(o.value)&&!/(?:无需|無需|不需|\bnot\b|\bno\b)/iu.test(o.value)));
   emit(10,'cgt_field_9',{status:matches?'done':'confirm',reason:matches?'已核对授信函的明确公司保证义务、保证书担保人及官方注册名称，三者对应一致。':'授信函公司保证义务、保证书担保人或官方注册名称存在不一致，请核对对应主体。',sources:[...guarantor,...official,...obligation]});
  }
  const bankAddress=c.values('cgt_field_13','cgt_guarantee'),bank=c.values('cgt_field_4','cgt_facility');
  if(bankAddress.length&&bank.length){
   const addressPattern=/银\s*行\s*地\s*址\s*为\s*([^。；;]+)[。；;]/u;
   const located=corporatePageStatements(c.pages,'cgt_facility',addressPattern);
   const pageValues=c.pages.filter(p=>p.trusted&&p.document.taxonomyIds.includes('cgt_facility')&&located.some(s=>s.page===p.number&&s.evidence.documentVersionId===p.document.id)).flatMap(p=>{const m=addressPattern.exec(p.text);return m?[m[1]!]:[];});
   const reference=c.values('cgt_field_13','cgt_facility'),values=[...reference.map(s=>s.value),...pageValues];
   const equal=sourceComparison(c,'cgt_field_4','cgt_guarantee','cgt_facility')?.status==='done'&&values.length>0&&bankAddress.every(a=>values.every(b=>same(a.value,b)||!!addressMeaningKey(a.value)&&addressMeaningKey(a.value)===addressMeaningKey(b)));
   const facilityPages=c.pages.filter(p=>p.document.taxonomyIds.includes('cgt_facility'));
   const complete=facilityPages.length>0&&facilityPages.every(p=>c.coverage.get(p.document.id));
   if(values.length||complete)emit(5,'cgt_field_13',{status:equal?'done':'confirm',reason:equal?'已核对保证书银行与授信函贷款人对应，银行地址的地区、道路、门牌、楼座及楼层一致；中英文表述不构成差异。':values.length?'已定位并比对保证书与授信函银行地址，当前尚未确定所有地址组成是否一致；需进一步核对差异，不能记为材料缺失。':'保证书已填写银行地址；当前授信材料没有已核对的对应银行地址依据，请确认该地址属于所列银行或认可分支行。',sources:[...bankAddress,...bank,...reference,...located]});
  }
  const borrower=c.values('cgt_field_7','cgt_guarantee'),address=c.values('cgt_field_8','cgt_guarantee');
  if(borrower.length&&address.length&&scope.inputs['material:cgt_guarantee']){
   const officialAddress=c.values('cgt_field_8').filter(s=>c.current.some(d=>d.id===s.evidence.documentVersionId&&d.taxonomyIds.some(t=>['cgt_incorporation','cgt_annual'].includes(t))));
   const officialNames=c.values('cgt_field_7').filter(s=>c.current.some(d=>d.id===s.evidence.documentVersionId&&d.taxonomyIds.some(t=>['cgt_incorporation','cgt_annual'].includes(t))));
   const linked=officialAddress.filter(a=>officialNames.some(n=>n.evidence.documentVersionId===a.evidence.documentVersionId&&borrower.some(b=>same(b.value,n.value))));
   // A closed adopted pack and its explicitly matched guarantor identity do not
   // turn the guarantor's registration into a borrower's address certificate.
   const closed=Object.keys(scope.inputs).some(id=>id.startsWith('material:')&&scope.inputs[id]?.fact.value===false)&&documents.every(d=>d.adopted&&d.projectionCurrent&&!d.unclassified);
   if(linked.length||closed)emit(9,'cgt_field_8',{status:linked.length&&address.every(a=>linked.some(b=>same(a.value,b.value)))?'done':'confirm',reason:linked.length?'已比对保证书客户地址与同名借款人的官方登记地址；'+(address.every(a=>linked.some(b=>same(a.value,b.value)))?'结果一致。':'地址不一致，请客户经理确认有效地址并处理差异。'):'保证书客户地址已有原文；本轮未取得与该借款人对应的官方登记地址依据。按本项规则，请客户经理确认地址有效，或补充该借款人的官方地址证明；不能用担保公司的地址代替。',sources:[...borrower,...address,...linked]});
  }
  const meeting=[...c.values('cgt_field_25','cgt_resolution'),...c.values('cgt_meeting_place','cgt_resolution')];
  if(meeting.length)emit(28,'cgt_field_25',corporateMeetingCheck(meeting,businessDate));
  const reference=c.values('cgt_field_28','cgt_resolution'),facility=c.values('cgt_facility_reference','cgt_facility').length?c.values('cgt_facility_reference','cgt_facility'):
   [...c.values('cgt_facility_name','cgt_facility'),...c.values('cgt_facility_issue_date','cgt_facility'),...c.values('cgt_facility_number','cgt_facility')];
  if(reference.length&&facility.length){
   const a=text(reference),b=text(facility),ad=dates(a),bd=dates(b),ar=refs(a),br=refs(b),dateEqual=ad.length===1&&bd.length===1&&ad[0]===bd[0],refEqual=ar.length===1&&br.length===1&&ar[0]===br[0];
   const title=(all:string,reference:string|undefined)=>reference?all.slice(0,all.indexOf(reference)).trim().replace(/\s*[（(][^()（）]*(?:号码|編號|编号|Number|No\.?|Reference)\s*[:：]?\s*$/iu,'').trim():undefined;
   const titleA=title(a,ar[0]),titleB=c.values('cgt_facility_name','cgt_facility').length===1?c.values('cgt_facility_name','cgt_facility')[0]!.value:title(b,br[0]);
   const titleEqual=!!titleA&&!!titleB&&same(titleA,titleB);
   const aliases=new Set(['FACILITYOFFERLETTER','FACILITYLETTER','授信函']);
   const titleKey=(value:string|undefined)=>value==='银行授信'&&/授信函号码|授信函編號|授信函编号/u.test(b)?'授信函':value?corporateNameKey(value):'';
   const bilingual=!titleEqual&&dateEqual&&refEqual&&aliases.has(titleKey(titleA))&&aliases.has(titleKey(titleB))&&new Set(facility.map(s=>s.evidence.documentVersionId)).size===1;
   emit(31,'cgt_field_28',{status:dateEqual&&refEqual&&(titleEqual||bilingual)?'done':'confirm',reason:`已比对决议所引授信函与提供的授信函：${refEqual?'编号一致':ar.length&&br.length?'编号不同':'缺少可一一对应的完整编号'}；${dateEqual?'出具日期一致':ad.length&&bd.length?'日期不同':'缺少明确唯一的出具日期'}；${titleEqual?'名称一致。':bilingual?'名称为同类授信函的中英文称谓，已按唯一编号、出具日及已采用的材料类型对应；无需重复确认名称。':'名称或版本表述不同，请确认是否同一授信函及版本。'}`,sources:[...reference,...facility]});
  }
  const clauses=c.values('cgt_rm_clauses','cgt_rm');
  if(clauses.length){const result=compareCorporateRmClauses(text(clauses));emit(49,'cgt_field_36',{status:result.equal?'done':'open',reason:result.equal?'已将 RM 证明的 a～e 条逐字与银行提供的标准模板比较，仅忽略排版、标点及选项勾选标记，条款一致；不代表所述法务批准或签署事实已获核实。':`RM 证明与银行提供标准模板的 ${result.mismatches.join('、')} 条内容不一致或缺失，请按标准格式修订或提供获准版本。`,sources:clauses});}
  for(const [number,field,result] of await corporateDirectorChecks(c,businessDate))emit(number,field,result);
  // The workbook explicitly requires Chinese versions of foreign-language
  // materials. Detect substantive English prose, not English names/IDs in forms.
  const english=corporateForeignMaterials(c);
  const translation=scope.inputs['material:cgt_translation']?.fact;
  const translationDecision=c.own.find(r=>r.fieldId==='cgt_translation_required')?.fact,required=facts.cgt_translation_required;
  const explicitVeto=translationDecision&&(required?.state!=='present'||required.value!=='yes')||required?.state==='present'&&required.value==='no';
  if(!translationRequirementDisabled('cgt_translation_review',policy)&&english.length&&translation?.state==='present'&&!explicitVeto){
   const source=uniqueSources(english.flatMap(p=>p.sources)),missing=translation.value===false?english.filter(p=>!p.embeddedChinese):[];
   const reason=missing.length?`已检查材料语言和本轮文件清单，以下外文材料尚无对应中文版本：${distinct(missing.map(p=>p.filename)).join('、')}。请补充对应版本并核对翻译完整性；参考机器译文不能代替认可版本。${english.some(p=>p.embeddedChinese)?'另有文件内附中文页，请核对其覆盖及认可范围，不重复索取已有中文页。':''}`:'已识别外文材料及对应中文材料或文件内附中文页；请核对逐份对应版本及翻译内容，存在中文页不等于译文完整或已认可。';
   const rules=[['cgt_translation_required','material:cgt_translation','present'],['cgt_translation_review','cgt_translation_required','manual_review']] as const;
   const ruleIds=rules.filter(([id,field,op])=>supported(id,field,'cgt_translation',op)).map(([id])=>id);
   const row=c.own.find(r=>r.fieldId==='cgt_translation_required');
   if(row&&source.length&&source.length<=40&&reason.length<=1500&&ruleIds.length)checks.push({id:`corporate-material-v1:${scope.scopeId}:translation`,fieldId:row.fieldId,objectId:row.objectId,ruleIds,status:missing.length?'open':'confirm',reason,execution:{version:'corporate-translation-inventory-v1',referenceHashes:[CORPORATE_WORKBOOK_SHA256],evidence:[]},item:{rowId:row.id,fieldId:row.fieldId,objectId:row.objectId,scope:'bank_rule',meaning:missing.length?'different':'pending',reason,actions:[reason],sources:source}});
  }
  const scoped=mergeCorporateScopeChecks(mergeCorporateScopeChecks(checks,corporatePreReviewChecks(c,manifest,scope.scopeId,policy)),await corporateSignatureChecks(c,manifest,scope.scopeId,policy,checks,signatureOriginal));
  checks.splice(0,checks.length,...scoped);
 }
 return checks;
}
