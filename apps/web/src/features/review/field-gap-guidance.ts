import {fixedComparisonValue,type ChecklistRow,type CrossFileCheck,type CrossFileValue} from '@hsbc/contracts/review-checklist';

// Compatibility names for older configurations whose missing-source placeholder
// has no field label. These are reading hints, never adopted facts or outcomes.
const businessLabels:Record<string,string>={
  cgt_limited:'担保责任范围（有限额／无限额）',pg_limited:'担保责任范围（有限额／无限额）',
  cgt_user_required_amount:'用户要求的担保金额',cgt_user_required_currency:'用户要求的担保币种',
  pg_required_amount:'用户要求的担保金额及币种',
};
const counterpartLabels:Record<string,string>={cgt_customer_official_address:'客户官方注册文件中的地址',cgt_identity_details:'身份证明信息',
  cgt_facility_parties:'授信函',pg_facility_parties:'授信函'};
export function isBusinessSource(source:CrossFileValue){
  return !source.documentId&&(source.state==='pending_confirmation'||!!businessLabels[source.fieldId]||source.filename==='待确认的业务值');
}
export function sourceGap(source:CrossFileValue){
  if(fixedComparisonValue(source.fieldId)!==undefined||!['missing','pending_confirmation'].includes(source.state))return;
  // A placeholder for a missing counterpart may carry no field label, or only the field's internal id.
  const unnamed=source.label==='对应银行要求的字段'||source.label===source.fieldId;
  const label=businessLabels[source.fieldId]??(unnamed?counterpartLabels[source.fieldId]:source.label)??source.label;
  if(source.fieldId==='cgt_customer_official_address'&&source.missingText)return {kind:'confirmation' as const,label,summary:source.missingText,action:'请客户经理确认客户地址有效，并记录确认依据。'};
  if(isBusinessSource(source))return {kind:'confirmation' as const,label,summary:`${label}：尚未确认`,action:
    source.fieldId==='cgt_customer_official_address'?'请客户经理确认客户地址有效，并记录确认依据。':
    /^(?:cgt|pg)_limited$/u.test(source.fieldId)?'请核对保证书责任条款，确认是有限额还是无限额担保。':
    /^(?:cgt_user_required_(?:amount|currency)|pg_required_amount)$/u.test(source.fieldId)?'请确认保证书所列金额是否可接受；如有最低金额要求，请填写要求金额及币种。':`请填写或确认“${label}”，并记录依据。`};
  if(source.documentId)return {kind:'information' as const,label,summary:`${source.filename}：未取得“${label}”`,action:`请查看${source.filename}中的“${label}”：原文有值时更正取值或重新提取；原文确未载明时，按下方规则补充依据或记录人工确认。`};
  const filename=['对应材料','本项依据','',source.fieldId].includes(source.filename)?counterpartLabels[source.fieldId]??`载有“${label}”的对照文件`:source.filename;
  const existing=source.warnings.find(w=>/已有.*材料/u.test(w));
  return {kind:'document' as const,label,summary:source.missingText??(existing?`${filename}：${existing}`:`尚无可用于核对的${filename}`),action:
    existing?`请检查${filename}的材料归属，将其关联到本次核对的主体。`:`请在本轮材料中补充${filename}；已上传时请检查文件分类和材料归属。`};
}

/** Only enrich placeholder names from the same object and role. */
export function namedCheckSources(checks:CrossFileCheck[],row:ChecklistRow,rows:ChecklistRow[]):CrossFileCheck[]{
  return checks.map(check=>({...check,sources:check.sources.map(source=>{
    const related=rows.find(r=>r.fieldId===source.fieldId&&r.objectId===row.objectId&&r.objectRole===row.objectRole);
    const business=isBusinessSource(source);
    if(source.fieldId==='cgt_identity_details'&&!source.documentId){
      const person=[21,22,23].includes(check.bankRule?.row??0)?'见证人':'签署人';
      return {...source,label:`${person}身份证明信息`,filename:`${person}身份证明文件`};
    }
    return {...source,label:businessLabels[source.fieldId]??counterpartLabels[source.fieldId]??related?.label??source.label,
      filename:business?'待确认信息':!source.documentId&&['对应材料','本项依据',''].includes(source.filename)?related?.materialTypes.map(m=>m.label).join(' / ')||source.filename:source.filename};
  })}));
}
export function checkGaps(check:CrossFileCheck){
  if(check.outcome==='not_applicable')return [];
  return check.sources.flatMap(source=>{
    // The personal borrower check accepts either source, not both.
    if(check.bankRule?.reference.startsWith('SRC-PG/')&&check.bankRule.row===6&&
      ['pg_facility_parties','pg_registration_customer_name'].includes(source.fieldId)&&!source.documentId&&source.state==='missing'&&
      check.sources.some(s=>s.fieldId!==source.fieldId&&['pg_facility_parties','pg_registration_customer_name'].includes(s.fieldId)&&s.state==='available'&&s.values.length))return [];
    const gap=sourceGap(source);return gap?[gap]:[];
  });
}
export function gapDecision(checks:CrossFileCheck[]){
  const gaps=checks.flatMap(checkGaps);
  if(!gaps.length)return;
  const documents=gaps.some(g=>g.kind==='document'),information=gaps.some(g=>g.kind==='information');
  return {label:documents?'缺少对照文件':information?'缺少字段信息':'需人工确认',
    note:[...new Set(gaps.map(g=>g.summary))].join('；'),
    action:documents?'补充对照文件':information?'核对并补全字段':'确认本项业务要求',
    instructions:[...new Set(gaps.map(g=>g.action))].join(' ')};
}
