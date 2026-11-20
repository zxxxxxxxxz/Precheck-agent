import {gapDecision} from './field-gap-guidance.ts';
import {CORPORATE_CUSTOMER_ADDRESS_CHECK,type ChecklistRow,type CrossFileCheck} from '@hsbc/contracts/review-checklist';
import type {ReviewState} from '@hsbc/contracts/review';
import type {FieldFocus} from './field-focused-reading.ts';
import {fieldLiteralDecision,decisionStep as step,type DecisionStep} from './field-literal.ts';
import {fieldMeaningDecision} from './field-meaning.ts';
export {fieldLiteralDecision} from './field-literal.ts';
export type {DecisionStep} from './field-literal.ts';
export interface FieldDecision {literal:DecisionStep;conclusion:DecisionStep;action:DecisionStep}

/** Shared across every field. This projects existing results; it never writes a decision. */
export function corporateFieldDecision(row:ChecklistRow,state:ReviewState,checks:CrossFileCheck[],focus:FieldFocus):FieldDecision {
  const literal=fieldLiteralDecision(checks,focus);
  const run=state.runs[0],owner=state.objects.find(o=>o.objectId===row.objectId);
  const stale=!!run&&(run.validity!=='current'||run.state==='stale'||run.configurationReleaseId!==state.configurationReleaseId);
  const results=run?.results.filter(r=>r.scopeId===row.objectId&&row.rules.some(rule=>rule.id===r.ruleId))??[];
  const complete=row.rules.length>0&&row.rules.every(rule=>results.some(r=>r.ruleId===rule.id));
  const ready=run?.state==='ready'&&!stale;
  const history=state.readOnly?'历史结果，仅供回查':'保留审查记录';
  const currentBank=!state.readOnly&&checks.length>0&&checks.every(c=>c.bankExecution||c.valueBasis==='extracted');
  if(stale&&!currentBank)return {literal,conclusion:step('结论待更新','依据或配置已变化，旧结果仅供回查','pending'),action:step(state.readOnly?'只读回查':'重新检查','旧结果不计入本次通过','pending')};
  if(checks.some(check=>check.id.endsWith(`:${CORPORATE_CUSTOMER_ADDRESS_CHECK}`)&&check.sources.some(source=>source.missingText)))return {
    literal:step('无法直接判定','缺少客户官方注册文件作交叉核对','pending'),
    conclusion:step('证据与规则已定位','不代替法律或人工判断','pending'),
    action:step('请客户经理确认地址有效','核对客户官方注册文件；无地址可供核对时记录客户经理确认依据','pending')};
  if(ready&&results.some(r=>r.outcome==='fail'))return {literal,conclusion:row.crossChecks?.length?fieldMeaningDecision(row.crossChecks,focus):step('规则冲突','有效检查结果未满足本项规则','attention'),action:step('处理未通过事项',state.readOnly?'历史结果，仅供回查':'核对差异后更正或记录处置','attention')};
  if(ready&&complete&&results.every(r=>r.outcome==='not_applicable'))return {literal,conclusion:step('不适用','本项适用条件不成立'),action:step('本项不启用',history)};
  if(ready&&complete&&owner?.validity==='current'&&results.every(r=>['pass','not_applicable'].includes(r.outcome)))return {
    literal:literal.label==='已取得字段值'?step('未发现实质差异','已按规则基准完成检查'):literal,
    conclusion:row.crossChecks?.length?fieldMeaningDecision(row.crossChecks,focus):step('符合检查规则','证据满足本项适用规则要求','pass'),action:step('通过本项检查',history,'pass')};
  if(row.status==='not_applicable'&&!results.some(r=>r.outcome!=='not_applicable'))return {
    literal:step('本路径不适用','字段仍保留在完整清单'),conclusion:step('不适用','本项已有不适用记录'),action:step('本项不启用',history)};
  if(!state.readOnly&&checks.some(c=>c.semantic&&['failed','unavailable'].includes(c.semantic.state)))return {
    literal,conclusion:fieldMeaningDecision(checks,focus),action:step('查看自动核对未完成原因','自动核对未取得有效结果，请检查任务失败或无法核对的原因','pending')};
  if(!state.readOnly&&checks.some(c=>c.semantic?.state==='pending'||c.sources.some(s=>s.state==='processing')))return {
    literal,conclusion:fieldMeaningDecision(checks,focus),action:step('等待核对完成','正在处理已收到的材料，完成后自动更新本项结果','pending')};
  const gap=gapDecision(checks);
  if(!state.readOnly&&gap&&!checks.some(c=>c.outcome==='different'||c.sources.some(s=>s.state==='uncertain')))return {
    literal,conclusion:fieldMeaningDecision(checks,focus),action:step(gap.action,gap.instructions,'pending')};
  if(!state.readOnly&&row.documentScope?.included&&!row.crossChecks?.length&&row.sourceValues?.some(s=>s.values.length)&&row.verification?.validity!=='current')return {
    literal,conclusion:step('提取值待核验','已有提取结果，尚未完成与当前版本原文的核对','pending'),
    action:step('核对提取值与原文','查看原文中的对应栏位；有值但未完成核验不代表缺文件','pending')};
  if(currentBank){
    const conclusion=fieldMeaningDecision(checks,focus),notice=checks.some(c=>c.reviewItems?.some(i=>i.kind==='notice'));
    const action=checks.every(c=>['consistent','not_applicable'].includes(c.outcome))?step(notice?'查看条款提醒':'本项检查已完成',notice?'提醒已列出；相关条件按业务环节处理':'字段或材料更新后自动重新检查','pass'):
      checks.some(c=>c.outcome==='different')?step('处理检查发现的问题','请查看具体缺项或差异','attention'):
      checks.some(c=>c.outcome==='insufficient')?step('补全检查输入','查看具体缺少的字段或识别结果','pending'):step('完成本项人工确认',[...new Set(checks.filter(c=>c.outcome==='manual').flatMap(c=>[c.reason,...c.manualReasons]))].join('；')||'请按下方银行要求记录判断及依据','pending');
    return {literal,conclusion,action};
  }
  const conclusion=fieldMeaningDecision(row.crossChecks??[],focus);
  let action=step('待完成业务检查','尚无本项完整有效的通过记录','pending');
  if(!owner||owner.validity!=='current')action=step('确认材料归属','确认对应主体及本笔担保','pending');
  else if(conclusion.tone==='attention')action=step('核对差异','确认是否需要更正或补充依据','attention');
  else if(conclusion.label==='证据不足')action=step('暂停相关检查','补齐对应依据前不计入通过','pending');
  else if(conclusion.tone==='pending'||row.crossChecks?.some(c=>c.manualReasons.length||c.reviewItems?.length))action=step('保留人工判断','不自动标记通过','pending');
  if(ready&&results.some(r=>r.outcome==='blocked'))action=step('检查受阻','存在未确认输入或适用条件','pending');
  if(run&&['pending','running'].includes(run.state))action=step('等待检查完成','本轮检查尚未结束','pending');
  if(run&&['failed','canceled'].includes(run.state))action=step('重新检查','本轮检查未完成，不能视为通过','pending');
  if(state.readOnly)action=step('只读回查','当前轮次不可修改');
  return {literal,conclusion,action};
}
