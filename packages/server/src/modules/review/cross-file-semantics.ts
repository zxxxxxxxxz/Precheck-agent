import {semanticEligible as extractedEligible,crossFileSemanticItem as extractedItem,applyCrossFileSemantic as applyExtracted} from './extracted-value-semantics.js';
export {EXTRACTED_VALUE_REQUIREMENT} from './extracted-value-semantics.js';
import {crossFileSourceReading} from '@hsbc/contracts/personal-bank-comparison';
import type {CrossFileCheck} from '@hsbc/contracts/review-checklist';
import type {ReviewConfigManifest} from '@hsbc/contracts/review-config';
import type {AnalysisEvidence,SemanticItem} from '@hsbc/contracts/review-delivery';
import {inputHash} from '../../infrastructure/database/idempotency.js';
import {verifiedAppliedGuidance} from './guidance.js';

// Older published manifests stored some identifiers as generic text.
const identifierLabel=/编号|号码|证件|身份证|护照|登记号|注册号|账号|帳號|\b(?:number|identifier|passport|reference\s*(?:no|number))\b/iu;
function comparisonSources(check:CrossFileCheck){
  // Row 6 permits either name reference; an absent optional registration
  // document must not disable a complete facility-letter comparison.
  return check.sources.filter(s=>!(check.bankRule?.row===6&&s.fieldId==='pg_registration_customer_name'&&
    !s.documentId&&!s.values.length&&s.state==='missing'));
}
export function crossFileSuppliedValues(check:CrossFileCheck){
  return comparisonSources(check).map(source=>{
    const reading=check.bankRule?crossFileSourceReading(check,source):source;
    return {fieldId:source.fieldId,label:reading.label,sourceLabel:source.label,filename:source.filename,documentId:source.documentId,values:reading.values};
  });
}
export function semanticEligible(check:CrossFileCheck,manifest:ReviewConfigManifest):boolean {
  if(check.valueBasis==='extracted')return extractedEligible(check,manifest);
  if(!['text','equal','manual'].includes(check.method)||check.outcome==='not_applicable')return false;
  if(check.bankRule&&check.method!=='text')return false;
  const fields=check.fieldIds.map(id=>manifest.fields.find(f=>f.id===id));
  // Mixed amount/date/identifier groups remain business checks; their narrative
  // portions can be analyzed without replacing the deterministic outcome.
  return fields.some(f=>f?.type==='text'&&f.valueKind!=='identifier'&&!identifierLabel.test(f.label))&&
    new Set(check.sources.filter(s=>s.documentId&&s.values.length).map(s=>s.documentId)).size>=2;
}
export function crossFileHash(check:CrossFileCheck){
  const {semantic,...source}=check;
  const ordered=(value:unknown):unknown=>Array.isArray(value)?value.map(ordered):value&&typeof value==='object'?Object.fromEntries(Object.entries(value).filter(([,v])=>v!==undefined).sort(([a],[b])=>a.localeCompare(b)).map(([k,v])=>[k,ordered(v)])):value;
  return inputHash(ordered(check.bankRule&&check.valueBasis!=='extracted'?{version:'personal-bank-field.v4',...source}:source));
}
export const CROSS_FILE_REQUIREMENT=`比较指定字段在各份原文中的含义，包括不同语言、繁简体、音译、缩写、换行及双语名称。语言不同或多附一份译名本身不是实质差异。逐一说明对应关系，只根据原文中的明确双语并列、共同名称及上下文判断；相似发音或猜测译名不足以确认对应。
这是文件取值的语义比较，不是法律主体身份确认：可以判断两个表述含义相同，同时保留主体归属、同名个人、总分行接受条件及人工确认要求。未确认主体归属本身不妨碍描述文字含义，但不得据此断言同一主体、同一担保或授权有效。
对地址保留室、楼层、门牌、地区及地址用途；对姓名名单逐人对应并保留增减和任免时间；对银行保留分行；对法律保留法域与管辖；对责任、授权、文书引用保留否定、限额、利息、例外、共同签署、日期、版本和生效条件。不得合并不同角色、编号体系或任免事件。金额、币种、日期、证件及注册编号必须精确核对，不得以语义相近消除差异，不自动换汇。
只比较 suppliedValues 指定的方面，值仅为提取线索，依据必须是完整原文。不得把整段多角色条款当成一个名称。每个来源的每个候选均须核对，不能只挑选相同的一条。原文不足、候选冲突或无法对应时返回 insufficient 或 manual。结论只针对这些来源，不是整案通过。`;

/** Appended only when confirmed rules apply, so unguided checks keep their prompt version. */
export const CROSS_FILE_GUIDANCE_REQUIREMENT=`caseGuidance 列出银行审核人员针对本案确认、或规则中心已发布的判断口径。它们是可信的业务口径输入，不是原文引文。
仅当某条口径的字段范围和所列表述与本次比较的取值明确对应时才可采用；口径可以说明两个表述指向同一含义（例如名称等同、可接受的表述差异），但不能消除金额、币种、日期、证件或注册编号、否定、限额、条件、角色或主体归属的差异，也不能弥补原文缺失、无法定位或来源冲突。
采用某条口径时，在 appliedGuidance 中列出其 ref，并在 reason 中写明“依据<label>”；未采用的不得列出，不得编造 ref。无论是否采用口径，结论仍须逐份引用原文。`;

export function crossFileSemanticItem(check:CrossFileCheck,evidence:AnalysisEvidence[]):SemanticItem {
  if(check.valueBasis==='extracted')return extractedItem(check,evidence);
  const ids=new Set(check.sources.flatMap(s=>s.documentId?[s.documentId]:[]));
  const relevant=evidence.filter(e=>ids.has(e.documentId));
  const problems:string[]=[];
  if(comparisonSources(check).some(s=>s.state!=='available'||!s.values.length||s.warnings.length))problems.push('部分来源缺失或尚不能可靠核验，请先处理对应文件。');
  if([...ids].some(id=>!relevant.some(e=>e.documentId===id))||relevant.some(e=>e.warnings.length))problems.push('缺少完整、可定位的原文或引用。');
  if(relevant.reduce((n,e)=>n+e.text.length,0)>48000)problems.push('完整原文超出本次分析范围，需人工核对。');
  const bankScope=check.bankRule?.row===6?'本项只核对主债务人／借款人名称。授信函与客户官方注册文件是“或”的可替代对照依据：授信函已有完整客户名称时，不得再因缺官方注册文件而判证据不足；若未提供授信函，仍保留原表要求的人工提示。公司注册地等背景描述不属于名称差异。':
    check.bankRule&&[26,32].includes(check.bankRule.row)?'本项只核对适用法律及法域是否一致；不是逐字比较整段条款。相同法域的补充法令、规章和银行惯例表述不构成适用法律差异；但否定、例外或另一个法域必须保留。':
    check.bankRule&&[15,25,37].includes(check.bankRule.row)?'多位担保人须按姓名或原文明确的对应关系逐人比较地址；不同人的地址不同不是差异。缺身份证明仍须明确指出，不能用另一人的地址代替。':'';
  const ruleText=check.bankRule?`${CROSS_FILE_REQUIREMENT}\n本次仅核对个人担保银行原表的以下一条要求，不扩展到其他项目：\n${check.bankRule.requirement}\n处理说明：${check.bankRule.notice}\n核对范围：${bankScope}`:CROSS_FILE_REQUIREMENT;
  return {id:crossFileHash(check),ruleId:check.id,ruleLabel:check.label,ruleText,ruleSources:[],objectId:check.objectId??'unassigned',objectLabel:'文件表述含义核对',
    kind:'value',fieldIds:check.fieldIds,confirmedInputs:[],programChecks:[],originalOutcome:'unfinished',outcome:'insufficient',state:problems.length?'unavailable':'pending',reason:problems.join('；')||'等待 AI 核对原文含义。',
    limitations:check.manualReasons,evidenceIds:relevant.map(e=>e.id),citations:[],method:'not_run',simulated:false};
}

export function applyCrossFileSemantic(check:CrossFileCheck,item:SemanticItem,evidence:AnalysisEvidence[],jobId:string):CrossFileCheck {
  if(check.valueBasis==='extracted')return applyExtracted(check,item,evidence,jobId);
  const applied=item.state==='complete'&&item.outcome==='consistent'?verifiedAppliedGuidance(check,item.appliedGuidance):[];
  const semantic:NonNullable<CrossFileCheck['semantic']>={jobId,state:item.state,outcome:item.outcome,reason:item.reason,simulated:item.simulated,
    citations:item.citations.flatMap(c=>{const e=evidence.find(e=>e.id===c.evidenceId);return e&&e.text.includes(c.quote)?[{filename:e.filename,quote:c.quote,evidence:e.locations}]:[];}),
    ...(applied.length?{appliedGuidance:applied}:{})};
  // Only homogeneous textual comparisons can replace literal equality. Compound
  // legal/amount/date checks keep their business outcome and show advice alongside.
  const bankCovered=!check.bankRule||check.semanticEligible===true&&comparisonSources(check).every(s=>
    semantic.citations.some(c=>c.evidence.some(e=>s.evidence.some(ref=>JSON.stringify(ref)===JSON.stringify(e)))));
  const personalCovered=!check.bankRule?.reference.startsWith('SRC-PG/')||comparisonSources(check).every(s=>s.evidence.length>0&&s.evidence.every(ref=>semantic.citations.some(c=>c.evidence.some(e=>JSON.stringify(ref)===JSON.stringify(e)))));
  const replace=bankCovered&&personalCovered&&item.state==='complete'&&!item.simulated&&check.method==='text'&&comparisonSources(check).every(s=>s.documentId&&s.state==='available'&&!s.warnings.length)&&
    !['single_source','not_applicable','insufficient'].includes(check.outcome);
  return {...check,semantic,...(replace?{outcome:item.outcome,reason:`AI 语义核对：${item.reason}`}:{})};
}
