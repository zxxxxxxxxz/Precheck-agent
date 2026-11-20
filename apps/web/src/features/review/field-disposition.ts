import {fieldReviewStatus,isVerifiedSourceFact,type FieldVerification} from '@hsbc/contracts/field-verification';
import type {FieldDecision,DecisionStep} from './field-decision.ts';
import type {FieldCondition} from './field-confirmation-conditions.ts';

/** Mockup dispositions are read-only projections, never issue or email writes. */
export function fieldDisposition(conclusion:DecisionStep,conditions:FieldCondition[]):DecisionStep {
  const pending=conditions.filter(condition=>condition.kind!=='workflow');
  const specific=(items:FieldCondition[])=>items.length?`${items[0]!.kind==='evidence'||items[0]!.kind==='processing'?`${items[0]!.label}：`:''}${items[0]!.detail}${items.length>1?` 其余 ${items.length-1} 项条件需一并核实`:''}`:'';
  if(conclusion.tone==='attention')return {label:'进入未解决事项',note:conclusion.note||specific(pending),tone:'attention'};
  const evidence=pending.filter(condition=>condition.kind==='evidence'||condition.kind==='processing');
  if(evidence.length)return {label:'暂停相关检查',note:specific(evidence),tone:'pending'};
  const manual=pending.filter(condition=>condition.kind==='confirmation');
  if(manual.length)return {label:'需人工确认',note:specific(manual),tone:'pending'};
  if(conclusion.tone==='pass')return {label:'无需修改',note:'本项文件对照未发现需更正内容，业务适用性仍须核实',tone:'pass'};
  return {label:'暂停相关检查',note:conclusion.note,tone:'pending'};
}

/** Saved field comparisons have the same disposition vocabulary, without
 * promoting their status to adoption or approval of business rules. */
export function verifiedFieldDecision(record:FieldVerification,business?:FieldDecision):FieldDecision {
  const step=(label:string,note:string,tone:DecisionStep['tone']='neutral'):DecisionStep=>({label,note,tone});
  if(record.validity!=='current')return {literal:step('保留上次取值','材料或案件信息已变更，原取值仅供回查'),conclusion:step('结论待更新','原核对依据已失效，需重新确认当前结论','pending'),action:step('暂停相关检查','需依据当前材料重新核对并确认结果','pending')};
  if(business?.conclusion.label==='规则冲突')return business;
  if(['confirmed','consistent'].includes(record.status)&&business?.action.label==='通过本项检查'&&!record.actions.length)return business;
  const conditions:FieldCondition[]=record.actions.map((detail,index)=>({id:`verification:${index}`,kind:'confirmation',label:'需确认的具体条件',detail}));
  conditions.push(...(business?.conditions??[]).filter(condition=>condition.id.startsWith('blocked:')));
  if(record.status==='not_applicable'&&!conditions.length)return {literal:step('本路径不适用','依据核对记录，本项不适用于当前业务'),conclusion:step('不适用',record.reason),action:step('本轮不启用','本项无需跟进，适用条件变更后应重新评估')};
  // Literal equality remains visible even when the saved business meaning is pending.
  const sourceFact=isVerifiedSourceFact(record);
  const singleObserved=record.sources.filter(source=>source.comparisonKey!==null).length===1&&record.sources.some(source=>source.comparisonKey==='observed-fact');
  const reading=singleObserved&&!sourceFact?'pending':fieldReviewStatus({...record,meaning:'consistent'});
  const literal=step(sourceFact?'原文事实已核实':reading==='confirmed'?'字面一致':reading==='consistent'?'字面不一致':record.sources.some(source=>source.value.trim())?'已取得字段值':'无可比对文本',
    sourceFact?'已核实本字段对应的原文事实':reading==='confirmed'?'提取内容与对应原文一致':reading==='consistent'?'对应原文表述不同，需结合具体含义判断':record.sources.length?'已取得原文依据，具体取值仍需核实':'对应材料不完整，暂无法开展对照');
  const conclusion=step(sourceFact?'事实已核实':record.status==='confirmed'?'表述一致':record.status==='consistent'?'语义一致':record.status==='different'?'存在实质差异':'具体条件待确认',record.reason,['confirmed','consistent'].includes(record.status)?'pass':record.status==='different'?'attention':'pending');
  if(record.status==='pending'&&!conditions.length)conditions.push({id:'verification:reason',kind:record.sources.length?'confirmation':'evidence',label:record.sources.length?'核实原文对应关系':'补齐核对依据',detail:record.reason});
  const action=fieldDisposition(conclusion,conditions);
  if(sourceFact&&action.label==='无需修改')action.note='本项原文事实已核实；业务规则结果另行确认。';
  return {literal,conclusion,action,conditions};
}
