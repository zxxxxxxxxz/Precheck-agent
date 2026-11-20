import {gapDecision} from './field-gap-guidance.ts';
import {corporateFieldDecision} from './corporate-field-decision.ts';
import {CORPORATE_CUSTOMER_ADDRESS_CHECK,fixedComparisonValue,type ChecklistRow,type CrossFileCheck} from '@hsbc/contracts/review-checklist';
import type {ReviewState} from '@hsbc/contracts/review';
import {fieldDisposition} from './field-disposition.ts';
import {reviewReasonLabels} from './presentation.ts';
import {focusedSourceReading} from './cross-file-presentation.ts';
import {decimalKey} from './field-amount-reading.ts';
import {focusKind,type FieldFocus} from './field-focused-reading.ts';
import {sourceIsPendingBusinessValue,withScopedCheckReading} from './field-desk-checks.ts';
import {automaticFieldComparison} from './field-automatic-comparison.ts';
import {fieldConfirmationConditions,type FieldCondition} from './field-confirmation-conditions.ts';

export interface DecisionStep {label:string;note:string;tone:'neutral'|'pass'|'attention'|'pending'}
export interface FieldDecision {literal:DecisionStep;conclusion:DecisionStep;action:DecisionStep;conditions?:FieldCondition[];comparisons?:DecisionStep[];workflow?:FieldCondition[]}
const step=(label:string,note:string,tone:DecisionStep['tone']='neutral'):DecisionStep=>({label,note,tone});
const textKey=(value:string)=>value.normalize('NFKC').trim().replace(/\s+/gu,' ').toUpperCase();
const currencyNames:Record<string,string>={RMB:'CNY',人民币:'CNY',人民幣:'CNY',美元:'USD',美金:'USD','US$':'USD',港币:'HKD',港幣:'HKD',港元:'HKD','HK$':'HKD',欧元:'EUR',歐元:'EUR',英镑:'GBP',英鎊:'GBP',日元:'JPY',新加坡元:'SGD',NTD:'TWD','NT$':'TWD',新台币:'TWD',新臺幣:'TWD',新台幣:'TWD',台币:'TWD',臺幣:'TWD'};
function dateKey(raw:string):string|undefined {
  const value=raw.normalize('NFKC').trim();
  const numeric=/^(\d{4})[-/.年]\s*(\d{1,2})[-/.月]\s*(\d{1,2})日?$/u.exec(value);
  const roc=/^(?:民国|民國)\s*(\d{1,3})\s*年\s*(\d{1,2})\s*月\s*(\d{1,2})\s*日$/u.exec(value);
  const english=/^(\d{1,2})\s+([a-z]+)\s+(\d{4})$/iu.exec(value);
  const months=['january','february','march','april','may','june','july','august','september','october','november','december'];
  const month=english?months.findIndex(m=>m===english[2]!.toLowerCase()||m.slice(0,3)===english[2]!.toLowerCase())+1:0;
  const parts=roc&&+roc[1]!>0?[+roc[1]!+1911,+roc[2]!,+roc[3]!]:numeric?[+numeric[1]!,+numeric[2]!,+numeric[3]!]:english&&month?[+english[3]!,month,+english[1]!]:undefined;
  if(!parts)return undefined;
  const [y,m,d]=parts as [number,number,number],date=new Date(Date.UTC(y,m-1,d));
  return date.getUTCFullYear()===y&&date.getUTCMonth()===m-1&&date.getUTCDate()===d?`${y}-${m}-${d}`:undefined;
}

/** Literal reading is independent of semantic advice and business approval. */
export function fieldLiteralDecision(checks:CrossFileCheck[],focus:FieldFocus):DecisionStep {
  const kind=focusKind(focus);
  const entries=checks.flatMap(check=>check.sources.filter(s=>fixedComparisonValue(s.fieldId)===undefined&&!sourceIsPendingBusinessValue(s))
    .map(source=>({source,values:focusedSourceReading(check,source,focus).values})));
  if(entries.some(e=>e.source.state==='processing'))return step('正在提取','字段提取完成后更新对照结果','pending');
  if(!entries.length||entries.some(e=>!e.values.length))return step('无完整可比取值',gapDecision(checks)?.note??'尚未取得本项可比较的值，请查看对应原文','pending');
  if(new Set(entries.flatMap(e=>e.source.documentId?[e.source.documentId]:[])).size<2)
    return step('已取得字段值','当前仅有单份文件取值，需结合适用规则核对');
  const key=(value:string)=>kind==='amount'?decimalKey(value):kind==='date'?dateKey(value):kind==='currency'?
    currencyNames[textKey(value)]??(/^(?:USD|HKD|CNY|EUR|GBP|JPY|SGD|AUD|CAD|CHF|NZD|TWD)$/u.test(textKey(value))?textKey(value):undefined):textKey(value);
  const values=entries.map(e=>[...new Set(e.values.map(key))].sort());
  if(values.some(v=>v.includes(undefined)||kind!=='text'&&v.length!==1))return step('取值尚未明确','取值存在歧义，需核实原文及其表达格式','pending');
  const same=new Set(values.map(v=>JSON.stringify(v))).size===1;
  if(!same)return step(kind==='amount'?'金额数字不同':kind==='currency'?'币种不同':kind==='date'?'日期不同':'字面不一致','取值或表述存在差异，需结合原文核对');
  return step(kind==='amount'?'金额数字相同':kind==='currency'?'币种相同':kind==='date'?'日期相同':'字面一致',
    kind==='amount'?'按相同数量级比较后数值一致；币种另行核对':kind==='date'?'按年月日核对，所指日期一致':kind==='currency'?'币种名称或代码对应同一货币':'统一字符格式后，文字内容一致');
}

function comparisonConclusion(check:CrossFileCheck):DecisionStep {
  if(check.outcome==='not_applicable')return step('不适用','按当前适用条件，本项无需进行检查');
  if(check.sources.some(s=>s.state==='processing'))return step('等待提取完成','字段尚在提取，待依据齐备后核对','pending');
  if(check.sources.some(s=>['missing','uncertain'].includes(s.state)))return step('证据不足','原文依据缺失或存疑，暂无法确认含义','pending');
  const semantic=check.semantic;
  if(semantic){
    if(semantic.state==='pending')return step('语义核对中','正在核对对应原文的具体含义','pending');
    if(semantic.state!=='complete'||semantic.simulated||!semantic.citations.length||semantic.citations.some(c=>!c.evidence.length))
      return step('语义尚未确认',semantic.simulated?'当前结果仅供演示，需取得正式核对结论':'尚无完整且可追溯原文的核对结论','pending');
    if(semantic.outcome==='consistent'){
      // Name the confirmed rule the conclusion relied on, so reviewers can retire it if it was wrong.
      const rules=(semantic.appliedGuidance??[]).map(ref=>check.guidance?.find(g=>g.ref===ref)?.label).filter((label):label is string=>!!label);
      return rules.length?step('语义一致',`依据${rules.join('、')}；结合原文证据，业务条件另行确认`,'pass'):step('语义一致','结合原文证据，业务条件另行确认','pass');
    }
    if(semantic.outcome==='different')return step('语义存在差异','对应原文含义不同，需确认差异及影响','attention');
    return step(semantic.outcome==='insufficient'?'语义依据不足':'语义条件待确认',semantic.reason||`需核实「${check.label}」的原文对应关系`,'pending');
  }
  if(['insufficient','single_source'].includes(check.outcome))return step('证据不足','缺少完整对照依据，暂无法确认含义','pending');
  if(check.method!=='manual'&&check.outcome==='consistent')return step(check.method==='text'?'表述一致':'符合对照规则','本项对照成立，业务条件另行确认','pass');
  if(check.method!=='manual'&&check.outcome==='different')return step('对照存在差异',check.reason,'attention');
  return step('待确认具体条件',check.reason||`请核实「${check.label}」的适用条件`,'pending');
}

/** Shared across every field. This projects existing results; it never writes a decision. */
function evaluateFieldDecision(row:ChecklistRow,state:ReviewState,checks:CrossFileCheck[],focus:FieldFocus):FieldDecision {
  const literal=fieldLiteralDecision(checks,focus);
  const run=state.runs[0],owner=state.objects.find(o=>o.objectId===row.objectId);
  const stale=!!run&&(run.validity!=='current'||run.state==='stale'||run.configurationReleaseId!==state.configurationReleaseId);
  const results=run?.results.filter(r=>r.scopeId===row.objectId&&row.rules.some(rule=>rule.id===r.ruleId))??[];
  const complete=row.rules.length>0&&row.rules.every(rule=>results.some(r=>r.ruleId===rule.id));
  const ready=run?.state==='ready'&&!stale;
  const history=state.readOnly?'历史轮次结论，仅供查阅与复核':'本项结论供复核查阅，不代表最终业务批准';
  if(stale)return {literal,conclusion:step('结论待更新','审核依据或适用规则已变更，需重新核对','pending'),action:step('暂停相关检查','原结论已失效，需依据当前材料重新检查','pending')};
  if(checks.some(check=>check.id.endsWith(`:${CORPORATE_CUSTOMER_ADDRESS_CHECK}`)&&check.sources.some(source=>source.missingText)))return {
    literal:step('无法直接判定','缺少客户官方注册文件作交叉核对','pending'),
    conclusion:step('证据与规则已定位','地址已提取，但缺少客户注册文件作交叉核对。按规则转客户经理确认地址有效。','pending'),
    action:step('保留人工判断','不自动标记通过','pending')};
  if(ready&&results.some(r=>r.outcome==='fail')){
    const conditions=results.filter(r=>r.outcome==='fail').map(result=>{
      const rule=row.rules.find(rule=>rule.id===result.ruleId)!;
      return {id:`result:${result.ruleId}`,kind:'confirmation' as const,label:rule.label,detail:reviewReasonLabels[result.reasonCode]??rule.text};
    });
    return {literal,conclusion:step('规则冲突','当前检查结果未满足本项规则要求','attention'),action:fieldDisposition(step('规则冲突',conditions.map(c=>`${c.label}：${c.detail}`).join('；'),'attention'),conditions),conditions};
  }
  if(ready&&complete&&results.every(r=>r.outcome==='not_applicable'))return {literal,conclusion:step('不适用','按当前适用条件，本项无需进行检查'),action:step('本轮不启用',history)};
  if(ready&&complete&&owner?.validity==='current'&&results.every(r=>['pass','not_applicable'].includes(r.outcome))){
    const acceptedDifference=['字面不一致','金额数字不同','币种不同','日期不同'].includes(literal.label);
    return {literal:literal.label==='已取得字段值'?step('未发现实质差异','已对照适用规则完成核查'):literal,
      conclusion:step(acceptedDifference?'规则允许差异':'语义一致','现有依据符合本项适用规则要求','pass'),
      action:step(acceptedDifference?'无需修改':'通过本项检查',acceptedDifference?'差异满足本项适用规则；'+history:history,'pass')};
  }
  if(row.status==='not_applicable'&&!results.some(r=>r.outcome!=='not_applicable'))return {
    literal:step('本路径不适用','当前业务路径不涉及本项核对'),conclusion:step('不适用','已记录本项不适用结论'),action:step('本轮不启用',history)};
  const original=(row.crossChecks??[]).map(check=>withScopedCheckReading(check,focusKind(focus)));
  const knownSources=new Set(original.flatMap(check=>check.sources.map(source=>source.id)));
  const additional=checks.map(check=>({...check,reason:'',manualReasons:[],sources:check.sources.filter(source=>!knownSources.has(source.id))})).filter(check=>check.sources.length);
  const conditions=fieldConfirmationConditions(row,state,[...original,...additional]);
  if(ready)for(const result of results.filter(result=>result.outcome==='blocked')){
    const rule=row.rules.find(rule=>rule.id===result.ruleId)!;
    conditions.push({id:`blocked:${result.ruleId}`,kind:'confirmation',label:`确认${rule.label}的检查条件`,detail:[reviewReasonLabels[result.reasonCode],rule.text].filter(Boolean).join('；')||`「${rule.label}」尚无完整检查依据。`});
  }
  const automatic=automaticFieldComparison(checks,focus,literal,original);
  const assessments=original.map(comparisonConclusion);
  const comparisons=original.flatMap((check,index)=>check.method!=='manual'&&['consistent','different'].includes(check.outcome)||check.semantic?
    [{...assessments[index]!,note:check.semantic?.reason??check.reason}]:[]);
  if(automatic)comparisons.unshift(automatic);
  // Successful file readings survive unresolved business conditions. A real
  // discrepancy or failed evidence check remains visible and never becomes approval.
  const attention=assessments.find(s=>s.tone==='attention');
  const meaning=original.some(c=>c.semantic)?assessments.find((_,i)=>!!original[i]!.semantic):undefined;
  const conclusive=assessments.find(s=>s.tone==='pass');
  const uncertain=assessments.find(s=>s.label==='证据不足'||s.label==='等待提取完成');
  let conclusion=attention??meaning??uncertain??conclusive??automatic??assessments[0]??
    step('尚无可核对取值',`尚未取得「${row.label}」的可靠取值，需补齐核对依据`,'pending');
  // Automatic scalar reading includes legacy compound fields and its own source
  // quality gate. Pending manual placeholders are not missing file evidence.
  if(!attention&&!meaning&&automatic&&automatic.tone!=='pending'&&!original.some(c=>c.sources.some(s=>s.state==='missing'||s.state==='uncertain'||s.state==='processing')))
    conclusion=conclusive??automatic;
  const completedComparisons=comparisons.filter(result=>result.tone==='pass').length;
  if(!attention&&completedComparisons&&(uncertain||meaning?.tone==='pending'||automatic?.tone==='pending'))
    conclusion=step('已完成部分自动核对',`${completedComparisons} 项对照成立；${meaning?.tone==='pending'?'其余语义核对待完成':'其余来源依据尚待核实'}`,'pending');
  if(ready&&results.some(r=>r.outcome==='blocked')&&!comparisons.some(c=>c.tone==='pass'))conclusion=step('检查条件未齐备','需补齐相关取值或确认适用条件后继续检查','pending');
  if(conclusion.tone==='pass'&&/业务条件另行确认/u.test(conclusion.note))conclusion={...conclusion,note:conditions.length?'已完成本项内容核对，尚需确认相关适用条件':'已完成本项内容核对，待预审确认适用规则结果'};
  if(!conditions.some(c=>c.kind!=='workflow')&&conclusion.tone!=='pass'&&conclusion.tone!=='attention')
    conditions.push({id:'comparison-requirement',kind:conclusion.tone==='pending'?'evidence':'confirmation',label:conclusion.label,detail:conclusion.note});
  // Disposition describes the check; workflow state is rendered separately below.
  const action=fieldDisposition(conclusion,conditions);

  return {literal,conclusion,action,conditions,comparisons};
}

/** Keep workflow prerequisites out of the three-step disposition for every field. */
export function fieldDecision(row:ChecklistRow,state:ReviewState,checks:CrossFileCheck[],focus:FieldFocus):FieldDecision {
  if(row.objectRole==='corporate_guarantee'&&row.documentScope)return corporateFieldDecision(row,state,checks,focus);
  const decision=evaluateFieldDecision(row,state,checks,focus),run=state.runs[0];
  if(decision.action.label==='本轮不启用')return {...decision,workflow:[]};
  const workflow=(decision.conditions??[]).filter(c=>c.kind==='workflow');
  const owner=state.objects.find(o=>o.objectId===row.objectId);
  if(!state.readOnly&&(!owner||owner.validity!=='current')&&!workflow.some(c=>c.id==='ownership'))
    workflow.push({id:'ownership',kind:'workflow',label:owner?'重新确认材料归属':'确认材料归属',detail:'确认文件对应的主体及本笔业务；文件取值对照保留。'});
  const stale=!!run&&(run.validity!=='current'||run.state==='stale'||run.configurationReleaseId!==state.configurationReleaseId);
  const task=state.readOnly?['只读回查','当前轮次不可修改；处置仅反映该轮记录。']:
    stale?['重新检查','依据或配置已变化，完成当前条件后重新开始预审。']:
    run&&['failed','canceled'].includes(run.state)?['重新检查','本轮检查未完成；排除失败原因后重新开始预审。']:
    run&&['pending','running'].includes(run.state)?['等待检查完成','本轮预审正在执行，完成后更新规则结果。']:
    !run?['开始预审','完成必要条件后，点击页面上方“开始预审”，保存本轮对照并生成规则结果。']:undefined;
  if(task)workflow.push({id:'review-run',kind:'workflow',label:task[0]!,detail:task[1]!});
  return {...decision,conditions:decision.conditions?.filter(c=>c.kind!=='workflow'),workflow};
}
