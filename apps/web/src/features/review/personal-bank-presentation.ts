import {gapDecision} from './field-gap-guidance.ts';
import {personalBankContent} from '@hsbc/contracts/personal-bank-comparison';
import {PERSONAL_RULE_ROWS,PERSONAL_CHECKLIST_INTRO,PERSONAL_CHECKLIST_ROWS} from '@hsbc/contracts/personal-requirements';
import type {CrossFileCheck,ChecklistRow} from '@hsbc/contracts/review-checklist';
import type {ReviewState} from '@hsbc/contracts/review';
import {fieldLiteralDecision,type FieldDecision,type DecisionStep} from './field-decision.ts';
import {fieldConfirmationConditions} from './field-confirmation-conditions.ts';
import {fieldDisposition} from './field-disposition.ts';

/** Display bank source wording; model-only guidance is not part of the bank original. */
export function personalBankDisplayCheck(check:CrossFileCheck):CrossFileCheck {
 if(!check.bankRule)return check;
 const legal=/^pg_legal_(intro|checklist)_(\d+)$/u.exec(check.bankRule.primaryFieldId);
 const source=legal?(legal[1]==='intro'?PERSONAL_CHECKLIST_INTRO:PERSONAL_CHECKLIST_ROWS)[Number(legal[2])-1]:undefined;
 if(source)return {...check,bankRule:{...check.bankRule,requirement:source.text,notice:''}};
 const bank=check.bankRule.row===43?PERSONAL_RULE_ROWS.find(r=>r.row===43):undefined;
 return bank?{...check,bankRule:{...check.bankRule,requirement:bank.requirement,notice:bank.notice}}:check;
}

const step=(label:string,note:string,tone:DecisionStep['tone']='neutral'):DecisionStep=>({label,note,tone});

/** The same disposition/workflow separation as the corporate desk, with only
 * the personal workbook's directional checks supplying the business result. */
export function personalBankDecision(row:ChecklistRow,readOnly:boolean,state?:ReviewState):FieldDecision {
  const checks=(row.crossChecks??[]).filter(check=>check.bankRule);
  const usableChecks=checks.map(check=>check.bankRule?.row===6?{...check,sources:check.sources.filter(source=>
    !(['pg_facility_parties','pg_registration_customer_name'].includes(source.fieldId)&&source.state==='missing'&&!source.documentId&&!source.values.length&&
      check.sources.some(other=>other.fieldId!==source.fieldId&&['pg_facility_parties','pg_registration_customer_name'].includes(other.fieldId)&&!!other.documentId)))}:check);
  const content=checks.map(check=>check.bankRule?.content??personalBankContent(check)).find(Boolean);
  let literal=content?.status==='same'?fieldLiteralDecision(usableChecks,{fieldId:row.fieldId,label:row.label}):content?step(content.status==='ownership_required'?'各份取值分别列示':content.label,content.reason,
    ['partial','incomplete','ambiguous','ownership_required','blank_unconfirmed'].includes(content.status)?'pending':
    content.status==='different'?'attention':'neutral'):fieldLiteralDecision(usableChecks,{fieldId:row.fieldId,label:row.label});
  if(content?.status==='same'&&literal.label==='字面不一致')literal.note='名称写法不同；名称对照结果见下一步';
  if(content?.status==='same'&&checks.some(check=>[26,32].includes(check.bankRule!.row)))literal=step('适用法律一致','两份文件的适用法律指向同一法域；文书名称不同不构成法律差异',content.evidencePending?'neutral':'pass');
  const amountEquality=checks.find(check=>check.bankRule?.row===19);
  if(amountEquality?.outcome==='consistent')literal=step('金额及币种一致','各份原文已核验；统一金额写法后，数额和币种均相同','pass');
  else if(amountEquality?.outcome==='different')literal=step('金额或币种不同',amountEquality.reason,'attention');
  const semanticMatches=checks.filter(check=>check.semantic?.state==='complete'&&!check.semantic.simulated&&check.semantic.outcome==='consistent'&&check.semantic.citations.length&&check.semantic.citations.every(c=>c.evidence.length));
  if(semanticMatches.length&&checks.every(check=>['consistent','not_applicable'].includes(check.outcome)))literal=step('文字不同，含义一致','已按本条指定取值核对含义；具体依据见规则核对结果','pass');
  const allConditions=fieldConfirmationConditions({...row,rules:row.rules??[]},state??{objects:[]} as unknown as ReviewState,usableChecks);
  const workflow=allConditions.filter(c=>c.kind==='workflow');
  const conditions=allConditions.filter(c=>c.kind!=='workflow');
  const different=checks.some(check=>check.outcome==='different');
  const inactive=checks.length>0&&checks.every(check=>check.outcome==='not_applicable');
  const complete=checks.length>0&&checks.every(check=>['consistent','not_applicable'].includes(check.outcome));
  let conclusion=different?step('发现差异','银行指定的对应取值未满足本条要求','attention'):
    inactive?step('不适用','本项适用条件不成立'):
    complete?step('符合本条要求','本条要求已核对，材料变更后会重新核对','pass'):
    content?.status==='same'?step(content.label,content.evidencePending?'名称对照一致；原文来源仍须核实':content.reason):
    content?.status==='partial'?step('法律名称一致，条款待核实',content.reason,'pending'):
    conditions.some(c=>c.kind==='evidence'||c.kind==='processing')?step('证据不足','具体缺项和来源疑问见下方','pending'):
    content?.status==='ownership_required'?step('人员对应关系待核实','须对应同一担保人及本笔担保后核对，不能混合不同人的取值','pending'):
    step('需核对具体条件',checks.map(c=>c.reason).join('；')||'按个人担保要求核对原文','pending');
  const saved=row.verification;
  if(!checks.length)literal=saved?.validity==='current'&&saved.scope==='source_check'&&saved.status==='confirmed'?
    step('取值与原文一致','本项提取值已逐一定位到对应原文','pass'):
    step('原文取值待核实','核对提取文字及其原文是否完整对应','pending');
  if(saved?.validity==='stale'){
    conclusion=step('待重新核对','上次保存的依据已变化','pending');
    conditions.unshift({id:'saved:stale',kind:'evidence',label:'更新核对依据',detail:'上次保存的依据已变化，请重新核对当前材料。'});
  }else if(saved?.validity==='current'){
    if(saved.status==='different')conclusion=step('发现差异',saved.reason||'已保存本项差异','attention');
    else if(!different&&saved.status!=='pending'&&!(saved.scope==='source_check'&&checks.length&&!complete))conclusion=saved.status==='not_applicable'?step('不适用',saved.reason):step(saved.scope==='source_check'?'原文取值已核实':saved.origin==='automatic'?'自动核对一致':'核对已保存',saved.reason||'已按本项要求核对','pass');
    if(saved.status==='pending')for(const [i,detail] of (saved.actions??[]).entries())conditions.push({id:`saved:${i}`,kind:'confirmation',label:saved.origin==='automatic'?'待处理事项':'已保存待办',detail});
  }
  let action=fieldDisposition(conclusion,conditions);
  if(complete&&action.label==='无需修改')action={...action,note:'本条要求已核对，无需更正。'};
  const evidence=conditions.filter(c=>c.kind==='evidence'||c.kind==='processing');
  if(action.label==='暂停相关检查'&&evidence.length)action={...action,note:`${evidence[0]!.label}；具体原因见下方。`};
  if(inactive||saved?.validity==='current'&&saved.status==='not_applicable'&&!different)action=step('本轮不启用','本项不计入通过');
  if(saved?.validity==='current')workflow.push({id:'saved',kind:'workflow',label:saved.origin==='automatic'?saved.status==='pending'?'自动核对待完成':'已自动核对':'核对记录已保存',detail:saved.origin==='automatic'?'按当前材料自动计算；材料变更后重新核对。':saved.status==='pending'?'已保存待办，仍须处理上述具体条件。':'保留本项核对记录供回查。'});
  const gap=gapDecision(usableChecks);
  if(!readOnly&&gap&&!different&&!complete&&saved?.validity!=='stale'&&(!saved||saved.origin==='automatic'||saved.scope==='source_check')&&!checks.some(c=>c.semantic&&['pending','failed','unavailable'].includes(c.semantic.state)||c.sources.some(s=>s.state==='processing'||s.state==='uncertain'))){
    conclusion=step(gap.label,gap.note,'pending');
    action=step(gap.action,gap.instructions,'pending');
  }
  if(readOnly)workflow.push({id:'readonly',kind:'workflow',label:'只读回查',detail:'当前轮次不可修改。'});
  return {literal,conclusion,action,conditions,workflow};
}
