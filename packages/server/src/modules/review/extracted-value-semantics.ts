import type {CrossFileCheck} from '@hsbc/contracts/review-checklist';
import type {ReviewConfigManifest} from '@hsbc/contracts/review-config';
import type {AnalysisEvidence,SemanticItem} from '@hsbc/contracts/review-delivery';
import {inputHash} from '../../infrastructure/database/idempotency.js';

// Older published manifests stored some identifiers as generic text.
const identifierLabel=/编号|号码|证件|身份证|护照|登记号|注册号|账号|帳號|\b(?:number|identifier|passport|reference\s*(?:no|number))\b/iu;
const personalTextCheck=(check:CrossFileCheck)=>check.bankRule?.reference.startsWith('SRC-PG/')&&
  [5,6,13,23,26,29,31,32,34].includes(check.bankRule.row)&&check.method==='text';
/** A bank row the workbook leaves to a person still states what to look for. Where the value was read and no executable
 * check covers the row, the read value is compared with that text, so the reviewer starts from a stated conclusion.
 * The comparison keeps returning `manual` for what only a person can decide. */
export const judgeableManualRow=(check:CrossFileCheck)=>check.valueBasis==='extracted'&&check.method==='manual'&&!check.bankExecution&&!check.checklistRule&&
  !!check.bankRule&&`${check.bankRule.requirement}${check.bankRule.notice}`.trim().length>0;
export function semanticEligible(check:CrossFileCheck,manifest:ReviewConfigManifest):boolean {
  if(personalTextCheck(check))return check.outcome==='manual'&&
    new Set(check.sources.flatMap(s=>s.documentId?[s.documentId]:[])).size>=2&&
    check.sources.every(s=>s.documentId&&s.state==='available'&&s.values.length>0&&!s.warnings.length);
  if(check.valueBasis==='extracted')return check.outcome!=='not_applicable'&&
    (check.method==='text'||!!check.checklistRule||judgeableManualRow(check))&&check.sources.length>0&&
    check.sources.every(s=>s.state==='available'&&s.values.length>0&&!s.warnings.length)&&
    (!!check.checklistRule||judgeableManualRow(check)||new Set(check.sources.flatMap(s=>s.documentId?[s.documentId]:[])).size>=2);
  if(check.bankRule)return false;
  if(!['text','equal','manual'].includes(check.method)||check.outcome==='not_applicable')return false;
  const fields=check.fieldIds.map(id=>manifest.fields.find(f=>f.id===id));
  // Mixed amount/date/identifier groups remain business checks; their narrative
  // portions can be analyzed without replacing the deterministic outcome.
  return fields.some(f=>f?.type==='text'&&f.valueKind!=='identifier'&&!identifierLabel.test(f.label))&&
    new Set(check.sources.filter(s=>s.documentId&&s.values.length).map(s=>s.documentId)).size>=2;
}
export const EXTRACTED_VALUE_REQUIREMENT=`按给定银行要求核对 CURRENT 的提取值。提取值是本次比较的依据，无须回查原文定位、提取覆盖或来源质量警告。不得新增银行未要求的条件。银行要求用英文书写不代表提取值必须含英文原句；中英文同义表达均可满足。明确允许做某事与不限制做该事可以同义；没有逐字写出银行句式不构成缺口。
同一文件、同一对象、同一字段的多个单值候选，先理解是否同义（包括繁简体、语言、简称和格式）。同义时按一个含义核对；不同义时采用系统标出的最高置信度候选。置信度相同且含义不同、没有可比较的置信度时才保留人工选择。不要把多个真实名单成员、条款、角色或不同文件的值当作竞争候选删掉。不得把不同金额、币种、编号、日期说成同义，不换汇。
这是已标注角色的字段含义核对；未创建案件主体对象不是比较的前置条件，也不代表字段角色不明确。名称核对允许同一英文全称与附带中译名等价，不要求再证明法律身份。
只判断本条银行要求；银行明确要求的人工业务决定、无法从取值确定的适用条件仍保留。有值不等于符合要求。不同文件的差异是比较对象，不是同一提取版本内部矛盾。必须引用各参与文件的提取值，不编造原文。结论仅限本条，不表示整案通过。`;
export function crossFileHash(check:CrossFileCheck){
  const {semantic,...source}=check;
  const ordered=(value:unknown):unknown=>Array.isArray(value)?value.map(ordered):value&&typeof value==='object'?Object.fromEntries(Object.entries(value).filter(([,v])=>v!==undefined).sort(([a],[b])=>a.localeCompare(b)).map(([k,v])=>[k,ordered(v)])):value;
  return inputHash(ordered(source));
}
export const CROSS_FILE_REQUIREMENT=`比较指定字段在各份原文中的含义，包括不同语言、繁简体、音译、缩写、换行及双语名称。语言不同或多附一份译名本身不是实质差异。逐一说明对应关系，只根据原文中的明确双语并列、共同名称及上下文判断；相似发音或猜测译名不足以确认对应。
这是文件取值的语义比较，不是法律主体身份确认：可以判断两个表述含义相同，同时保留主体归属、同名个人、总分行接受条件及人工确认要求。未确认主体归属本身不妨碍描述文字含义，但不得据此断言同一主体、同一担保或授权有效。
对地址保留室、楼层、门牌、地区及地址用途；对姓名名单逐人对应并保留增减和任免时间；对银行保留分行；对法律保留法域与管辖；对责任、授权、文书引用保留否定、限额、利息、例外、共同签署、日期、版本和生效条件。不得合并不同角色、编号体系或任免事件。金额、币种、日期、证件及注册编号必须精确核对，不得以语义相近消除差异，不自动换汇。
只比较 suppliedValues 指定的方面，值仅为提取线索，依据必须是完整原文。不得把整段多角色条款当成一个名称。每个来源的每个候选均须核对，不能只挑选相同的一条。原文不足、候选冲突或无法对应时返回 insufficient 或 manual。结论只针对这些来源，不是整案通过。`;

export function crossFileSemanticItem(check:CrossFileCheck,evidence:AnalysisEvidence[]):SemanticItem {
  const ids=new Set(check.sources.flatMap(s=>s.documentId?[s.documentId]:[]));
  const relevant=evidence.filter(e=>ids.has(e.documentId));
  const extracted=check.valueBasis==='extracted';
  const problems:string[]=[];
  if(check.sources.some(s=>s.state!=='available'||!s.values.length||s.warnings.length))problems.push('部分来源缺失或尚不能可靠核验，请先处理对应文件。');
  if([...ids].some(id=>!relevant.some(e=>e.documentId===id))||relevant.some(e=>e.warnings.length))problems.push(extracted?'缺少当前版本的提取值。':'缺少完整、可定位的原文或引用。');
  if(relevant.reduce((n,e)=>n+e.text.length,0)>48000)problems.push(extracted?'提取值超出本次分析范围，需人工核对。':'完整原文超出本次分析范围，需人工核对。');
  const requirement=check.checklistRule?.text??(check.bankRule?`${check.bankRule.requirement}\n${check.bankRule.notice}`:'');
  return {id:crossFileHash(check),ruleId:check.id,ruleLabel:check.label,ruleText:extracted?`${EXTRACTED_VALUE_REQUIREMENT}\n银行要求：${requirement}`:CROSS_FILE_REQUIREMENT,ruleSources:check.checklistRule?.sources??(check.bankRule?[check.bankRule.reference]:[]),objectId:check.objectId??'unassigned',objectLabel:'文件表述含义核对',
    kind:'value',fieldIds:check.fieldIds,confirmedInputs:[],programChecks:[],originalOutcome:'unfinished',outcome:'insufficient',state:problems.length?'unavailable':'pending',reason:problems.join('；')||(extracted?'等待 AI 按银行要求核对提取值。':'等待 AI 核对原文含义。'),
    limitations:extracted?check.manualReasons.filter(reason=>!/^对象归属尚未确认/u.test(reason)):check.manualReasons,evidenceIds:relevant.map(e=>e.id),citations:[],method:'not_run',simulated:false};
}

export function applyCrossFileSemantic(check:CrossFileCheck,item:SemanticItem,evidence:AnalysisEvidence[],jobId:string):CrossFileCheck {
  if(check.bankRule&&check.valueBasis!=='extracted'&&!(personalTextCheck(check)&&check.semanticEligible))return check;
  const semantic:NonNullable<CrossFileCheck['semantic']>={jobId,state:item.state,outcome:item.outcome,reason:item.reason,simulated:item.simulated,
    citations:item.citations.flatMap(c=>{const e=evidence.find(e=>e.id===c.evidenceId);return e&&e.text.includes(c.quote)?[{filename:e.filename,quote:c.quote,evidence:e.locations}]:[];})};
  // Only homogeneous textual comparisons can replace literal equality. Compound
  // legal/amount/date checks keep their business outcome and show advice alongside.
  const covered=evidence.every(e=>item.citations.some(c=>evidence.some(source=>(check.valueBasis==='extracted'?source.documentId===e.documentId:source.id===e.id)&&source.id===c.evidenceId&&source.text.includes(c.quote))))&&evidence.length>0&&
    (!personalTextCheck(check)||check.sources.every(s=>s.evidence.length>0&&s.evidence.every(ref=>evidence.some(e=>e.locations.some(location=>
      location.documentVersionId===ref.documentVersionId&&location.parseRevision===ref.parseRevision&&location.directoryRevision===ref.directoryRevision&&
      (ref.anchorId?location.anchorId===ref.anchorId:ref.sourceNodeId&&location.sourceNodeId===ref.sourceNodeId))))));
  const extracted=check.valueBasis==='extracted'&&(check.method==='text'||!!check.checklistRule||judgeableManualRow(check));
  const replace=item.state==='complete'&&!item.simulated&&(covered||extracted&&['insufficient','manual'].includes(item.outcome))&&(check.method==='text'||extracted)&&check.sources.every(s=>s.documentId&&s.state==='available'&&!s.warnings.length)&&
    !['single_source','not_applicable','insufficient'].includes(check.outcome);
  return {...check,semantic,...(replace?{outcome:item.outcome,reason:`AI 语义核对：${item.reason}`}:{})};
}
