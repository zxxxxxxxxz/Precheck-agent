import type {MailRow,MailCell} from '@hsbc/contracts/review-delivery';
import {corporateBankScope,projectRequirementAction} from '../review/requirement-policy.js';
import {CORPORATE_WORKBOOK_SHA256} from '@hsbc/contracts/corporate-requirements';
import type {MailSourceRun} from './mail.js';

/** v5 distinguishes a business decision from an unfinished calculation/extraction.
 * Raw findings, issues and their dispositions remain available in the saved rows. */
export function assessMailCompletion(rows:MailRow[],runs:MailSourceRun[],aliases:Record<string,string>={}){
 const same=(a:string|null,b:string)=>a===null?b.startsWith('unconfirmed:')||b.startsWith('unassigned:'):(aliases[a]??a)===(aliases[b]??b);
 for(const row of rows)row.cells.forEach((cell,index)=>{
  const run=runs[index]!,rule=run.configuration?.manifest.rules.find(r=>r.id===row.ruleId);
  const result=run.results.find(r=>r.ruleId===row.ruleId&&same(r.scopeId,row.objectId));
  const signatureDependencies:Record<string,string[]>={cgt_resolution_signatures:['cgt_field_30'],cgt_witness_signature:['cgt_field_20']};
  const fields=(run.snapshot?.fieldReviews??[]).filter(f=>same(f.objectId,row.objectId)&&(rule?.inputs.includes(f.fieldId)||rule?.applicability?.fieldId===f.fieldId||signatureDependencies[row.ruleId]?.includes(f.fieldId)||row.ruleId===`field:${f.fieldId}`));
  const set=(tone:NonNullable<MailCell['assessment']>['tone'],label:string,message:string)=>{
   cell.assessment={tone,label};cell.action=cell.summary=message;delete cell.fieldReviewText;
  };
  if(run.state!=='ready'||run.validity!=='current'||!cell.outcome){set('incomplete','检查未完成',`${row.ruleLabel}：尚无当前有效的检查结果，需完成检查后再生成反馈。`);return;}
  // Established failures cannot be hidden by a successful secondary check.
  if(cell.outcome==='fail'||fields.some(f=>f.verification.validity==='current'&&f.verification.status==='different'))return;
  if(fields.some(f=>f.verification.validity!=='current')){
   set('incomplete','检查未完成',`${row.ruleLabel}：相关字段尚未完成有效核对，原核对依据已变化，需按当前材料重新检查。`);return;
  }
  if(row.ruleId.startsWith('signature:')){
   const check=run.snapshot?.signatureInformation?.find(s=>s.documentId===row.objectId)?.evaluation.checks.find(c=>`signature:${c.id}`===row.ruleId);
   if(check?.reasons.includes('requirement_complexity_limit'))set('incomplete','检查未完成',`${row.ruleLabel}：系统尚未完成签署组合计算，需完成检查后再生成反馈。`);
   return;
  }
  if(row.ruleId.startsWith('formal:'))return;
  const automatic=(run.snapshot?.automaticChecks??[]).filter(c=>c.ruleIds.includes(row.ruleId)&&same(c.objectId,row.objectId));
  if(automatic.length){
   for(const evidence of automatic.flatMap(c=>c.execution?.evidence??[]))if(!row.evidence.some(e=>JSON.stringify(e)===JSON.stringify(evidence)))row.evidence.push(evidence);
   for(const source of automatic.flatMap(c=>c.item.sources)){
    if(!row.evidence.some(e=>JSON.stringify(e)===JSON.stringify(source.evidence)))row.evidence.push(source.evidence);
    if(!row.documentIds.includes(source.evidence.documentVersionId)){row.documentIds.push(source.evidence.documentVersionId);row.documentLabels.push(source.filename);}
   }
   const status=automatic.some(c=>c.status==='open')?'open':automatic.some(c=>c.status==='confirm')?'confirm':automatic.some(c=>c.status==='incomplete')?'incomplete':'done';
   const messages=[...new Set(automatic.filter(c=>c.status===status).map(c=>c.reason))];
   set(status,{open:'发现问题：需处理',confirm:'需要人工判断',incomplete:'检查未完成',done:'自动核对完成'}[status],`${row.ruleLabel}：${messages.join('；')}`);
   // Exact source rule IDs and object boundaries are retained; the two inverse
   // checks for the same bank comparison may share one explanatory row.
   row.consolidationKey=JSON.stringify(['automatic',automatic.map(c=>c.id)]);
   const tasks=automatic.map(c=>c.task);
   if(tasks.every(t=>t&&t.kind===tasks[0]!.kind&&t.group===tasks[0]!.group)){
    const task=tasks[0]!;
    row.documentGroup=task.kind==='system'?'系统检查':task.kind==='bank'?'银行内部核对':task.kind==='notice'?'条件提示':task.group==='identity'?'身份与见证资料':task.group==='references'?'法律意见引用材料':row.documentGroup;
    row.consolidationKey=JSON.stringify(['corporate-bank-scope-v1',task.kind,task.group]);
    cell.summary=messages.join('；');
   }
   if(status==='confirm'&&automatic.every(c=>c.objectId===null&&c.reason==='请先确认本项材料所属的担保人及对应原文位置。')){
    row.documentGroup='材料归属';row.consolidationKey='material-ownership';
    cell.summary=cell.action='请确认本轮材料对应的担保人及原文位置，随后重新预审，继续自动核对相关字段。';
   }
   return;
  }
  // A recorded, current human judgment with concrete follow-up is not a system
  // extraction gap. Keep its actual explanation instead of replacing it with
  // "please confirm" or losing it behind a blocked raw calculation.
  const humanPending=fields.filter(f=>f.verification.validity==='current'&&!f.verification.origin&&
   f.verification.meaning==='pending'&&f.verification.sources.length&&f.verification.actions.length);
  const corporate=run.configuration?.manifest.fields.some(f=>f.objectRole==='corporate_guarantee'&&humanPending.some(p=>p.fieldId===f.id));
  if(corporate&&humanPending.length&&(rule?.operator==='manual_review'||row.ruleId.startsWith('field:')||humanPending.some(f=>rule?.applicability?.fieldId===f.fieldId||signatureDependencies[row.ruleId]?.includes(f.fieldId)))){
   const messages=[...new Set(humanPending.flatMap(f=>[f.verification.reason,...f.verification.actions]).map(text=>projectRequirementAction(text,run.snapshot?.requirementPolicy)))];
   set('confirm','需要人工判断',messages.join('\n'));
   const actions=[...new Set(humanPending.flatMap(f=>f.verification.actions).map(text=>projectRequirementAction(text,run.snapshot?.requirementPolicy)))].sort();
   const documents=[...new Set(humanPending.flatMap(f=>f.verification.sources.map(s=>s.evidence.documentVersionId)))].sort();
   row.documentGroup='人工核验';
   row.consolidationKey='corporate-manual:'+JSON.stringify([humanPending.map(f=>f.objectId),actions,documents]);
   return;
  }
  // A successful calculation already validated the rule's actual inputs. A
  // separate, pending field-display comparison must not undo that receipt.
  const reviewedScope=run.snapshot?.reviewedInputs?.find(s=>same(s.scopeId==='unconfirmed:corporate_guarantee'?null:s.scopeId,row.objectId)&&s.configurationReleaseId===run.configuration?.releaseId);
  if(reviewedScope&&['pass','not_applicable'].includes(cell.outcome)){
   set('done',cell.outcome==='pass'?'规则核对完成':'不适用',`${row.ruleLabel}：${cell.outcome==='pass'?'已按本轮有效输入完成规则核对。':'本轮有效输入表明此项不适用。'}${cell.issueIds.length?'问题处置仍以对应记录为准。':''}`);return;
  }
  if(row.ruleId.startsWith('field:')&&reviewedScope?.inputs[row.ruleId.slice(6)]){
   set('done','已接入规则核对',`${row.ruleLabel}：已复核所选原文并接入本轮规则输入。`);return;
  }
  if(fields.some(f=>f.verification.validity!=='current'||f.verification.status==='pending'&&f.verification.pendingKind!=='manual')){
   set('incomplete','检查未完成',`${row.ruleLabel}：相关字段尚未完成有效核对，需完成来源核验后重新检查。`);
   if(corporateBankScope(run.snapshot?.requirementPolicy)&&signatureDependencies[row.ruleId]&&fields.some(f=>f.verification.recordId.startsWith('corporate-bank-scope-v1:')&&f.verification.pendingKind==='incomplete')){
    row.documentGroup='系统检查';row.consolidationKey=JSON.stringify(['corporate-bank-scope-v1','system','signature']);
    cell.summary='系统仍需完成签署有无、人员、人数及授权组合检查；仅凭姓名或真实性待核备注不能得出结果。不要求客户鉴定笔迹或签名真伪。';
   }
   return;
  }
  if(row.ruleId.startsWith('field:')){
   const field=fields[0],v=field?.verification;
   if(v?.validity==='current'&&['confirmed','consistent','not_applicable'].includes(v.status))return;
   if(v?.origin==='automatic'&&v.pendingKind==='manual'){set('confirm','需要人工判断',`${row.ruleLabel}：请按对应银行要求完成业务判断。`);return;}
   set('incomplete','检查未完成',`${row.ruleLabel}：字段核对尚未完成，需完成来源核验后再判断。`);return;
  }
  if(['pass','not_applicable'].includes(cell.outcome))return;
  const current=fields.filter(f=>f.verification.validity==='current');
  const manualReason=['manual_review_required','business_rule_confirmation_required','reference_list_required'].includes(result?.reasonCode??'');
  const grounded=!!result?.evidenceIds.length||current.some(f=>f.verification.sources.length&&f.verification.status!=='pending');
  // These requirements describe computations/comparisons, not a discretionary
  // human decision. An old manual-review placeholder must not become a customer
  // task merely because its source field is now available.
  if(reviewedScope&&rule?.operator==='manual_review'&&rule.sourceIds.length===1&&rule.sourceIds[0]===row.ruleId.replace('cgt_bank_','cgt_rule_source_')&&
   run.configuration?.manifest.sources.some(s=>s.id===rule.sourceIds[0]&&s.sha256===CORPORATE_WORKBOOK_SHA256)&&
   ['cgt_bank_4','cgt_bank_5','cgt_bank_8','cgt_bank_9','cgt_bank_10','cgt_bank_28','cgt_bank_31','cgt_bank_49','cgt_bank_55','cgt_bank_61','cgt_bank_62'].includes(row.ruleId)){
   set('incomplete','检查未完成',`${row.ruleLabel}：已核对材料中的取值，系统尚未完成本项所需的完整业务比对；此项不作为人工待确认或补件要求。`);return;
  }
  if(rule?.operator==='manual_review'&&manualReason&&grounded){
   set('confirm','需要人工判断',`${row.ruleLabel}：${rule.description??'请按本项业务要求判断，并记录依据。'}`);return;
  }
  set('incomplete','检查未完成',`${row.ruleLabel}：尚未取得完整、有效的检查输入；请先完成材料处理、原文定位及适用范围核验。`);
 });
}
