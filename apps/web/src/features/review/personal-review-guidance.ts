import {sourceGap} from './field-gap-guidance.ts';
import type {ChecklistRow} from '@hsbc/contracts/review-checklist';

export function personalInputIds(fieldId:string):string[]{
  return ({pg_field_7:['pg_required_amount'],pg_field_11:['pg_taiwan_law','pg_bank_signed'],
    pg_field_12:['pg_guarantor_signed'],pg_field_14:['pg_identity_confirmed'],pg_field_37:['pg_legal_route']} as Record<string,string[]>)[fieldId]??[];
}

/** Describe an actionable gap; extraction failure is not a customer requirement. */
export function personalReviewGuidance(row:ChecklistRow):string[]{
  const checks=row.crossChecks??[];
  const pending=checks.filter(c=>!['consistent','not_applicable'].includes(c.outcome));
  const messages=pending.flatMap(check=>check.sources.flatMap(source=>{
    if(source.fieldId==='pg_registration_customer_name'&&source.state==='missing'&&!source.documentId)return [];
    if(source.state==='processing')return [`${source.filename}：仍在提取，完成后会自动继续核对。`];
    const gap=sourceGap(source);
    if(gap)return [`${gap.summary}。${gap.action}`];
    if(source.state==='uncertain'||source.warnings.length)return [`${source.filename}的“${source.label}”未通过原文核验，请查看对应原文并更正取值或重新解析；无需重复上传已有文件。`];
    return [];
  }));
  for(const check of pending){
    if(check.semantic?.state==='pending')messages.push('正在自动核对文字含义，完成后会更新结果。');
    else if(check.semanticEligible&&!check.semantic)messages.push('本项需核对文字含义；自动核对结果及服务状态见上方提示。');
    else if(['failed','unavailable'].includes(check.semantic?.state??''))messages.push('文字含义核对未完成，请查看上方服务提示；已有材料和已完成结果保留。');
    else if(check.outcome==='manual')messages.push(check.reason);
    else if(check.outcome==='different')messages.push(`请处理本项差异：${check.reason}`);
  }
  return [...new Set(messages)];
}
