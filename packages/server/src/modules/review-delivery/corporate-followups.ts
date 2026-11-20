import type {MailRow} from '@hsbc/contracts/review-delivery';
import {CORPORATE_WORKBOOK_SHA256} from '@hsbc/contracts/corporate-requirements';
import type {MailSourceRun} from './mail.js';

const identityFields=new Map([[16,'cgt_field_16'],[17,'cgt_field_17'],[18,'cgt_field_18'],[21,'cgt_field_21'],[22,'cgt_field_22'],[23,'cgt_field_23'],[32,'cgt_field_29']].map(([n,f])=>[`cgt_bank_${n}`,String(f)]));
const signatures=new Set(['cgt_bank_15','cgt_bank_20','cgt_bank_33','cgt_bank_34','cgt_resolution_signatures','cgt_witness_signature']);
const unique=(values:string[])=>[...new Set(values.filter(Boolean))];

/** One request can support several still-pending checks. This changes only a
 * newly generated single-round summary: raw actions, findings, replies, evidence
 * and completion assessments remain intact. Historical comparison stays separate.
 */
export function consolidateCorporateFollowUps(rows:MailRow[],runs:MailSourceRun[]){
 if(runs.length!==1)return;
 const run=runs[0]!,manifest=run.configuration?.manifest;
 if(!manifest||run.state!=='ready'||run.validity!=='current')return;
 const scopes=new Map<string,MailRow[]>();
 for(const row of rows)scopes.set(row.objectId,[...(scopes.get(row.objectId)??[]),row]);
 for(const [objectId,own] of scopes){
  const scope=run.snapshot?.reviewedInputs?.find(s=>s.scopeId===objectId&&s.policyVersion==='reviewed-rule-inputs-v1'&&s.configurationReleaseId===run.configuration?.releaseId);
  if(!scope)continue;
  const pending=(r:MailRow)=>r.cells.length===1&&r.cells[0]?.assessment?.tone==='confirm'&&r.cells[0].outcome==='blocked';
  const supported=(id:string,field:string)=>{
   const rule=manifest.rules.find(r=>r.id===id),source=id.replace('cgt_bank_','cgt_rule_source_');
   return rule?.operator==='manual_review'&&rule.objectScope?.role==='corporate_guarantee'&&rule.inputs.join(',')===field&&rule.sourceDirectionConfirmed&&rule.sourceIds.length===1&&rule.sourceIds[0]===source&&
    manifest.sources.some(s=>s.id===source&&s.sha256===CORPORATE_WORKBOOK_SHA256&&['candidate','confirmed'].includes(s.disposition))&&scope.inputs[field]?.fact.state==='present';
  };
  const identity=own.filter(r=>identityFields.has(r.ruleId));
  const relatedSignatures=own.filter(r=>signatures.has(r.ruleId));
  // Do not absorb an adverse or incomplete signature check, an unsupported rule,
  // a missing identity input, or a customer's bespoke identity follow-up.
  const identityMaterial=scope.inputs['material:cgt_identity']?.fact;
  if(identityMaterial?.state==='present'&&identityMaterial.value===false&&identity.length===identityFields.size&&new Set(identity.map(r=>r.ruleId)).size===identityFields.size&&identity.every(r=>pending(r)&&supported(r.ruleId,identityFields.get(r.ruleId)!)&&r.consolidationKey===JSON.stringify([identityFields.get(r.ruleId)]))&&
   relatedSignatures.every(r=>r.cells[0]?.assessment?.tone==='done'||pending(r)&&r.consolidationKey?.startsWith('corporate-manual:'))){
   const signature=relatedSignatures.filter(pending),group=[...identity,...signature];
   const signatureNotes=unique(signature.map(r=>r.cells[0]!.summary??r.cells[0]!.action));
   const message=['身份与见证资料：已定位保证书与决议中的相关记载；本轮材料清单未包含对应的身份证明文件。请一次提供或定位签署人、见证人的身份证明及地址依据，供系统继续核对签署人姓名／地址／证件、见证人姓名／地址／证件，以及决议授权签字人姓名。',
    '同一人员同一份资料只需提供一次；法律意见引用的相同身份资料也复用，不需重复补交。',...signatureNotes].join('\n');
   const key=JSON.stringify(['corporate-followup-v1','identity',group.map(r=>r.key).sort()]);
   for(const row of group){row.documentGroup='身份与见证资料';row.consolidationKey=key;row.cells[0]!.summary=message;}
  }
  const amount=run.snapshot?.automaticChecks?.find(c=>c.status==='confirm'&&(c.objectId??'unconfirmed:corporate_guarantee')===objectId&&c.ruleIds.length===2&&c.ruleIds.includes('cgt_bank_13')&&c.ruleIds.includes('cgt_amount_minimum'));
  if(amount)for(const row of own.filter(r=>amount.ruleIds.includes(r.ruleId)&&pending(r)&&r.consolidationKey===JSON.stringify(['automatic',[amount.id]])))row.cells[0]!.summary=amount.reason;
  const firm=own.find(r=>r.ruleId==='cgt_bank_37'),rule=manifest.rules.find(r=>r.id==='cgt_bank_37');
  if(firm&&pending(firm)&&supported(firm.ruleId,'cgt_legal_firm')&&firm.cells[0]!.summary===`${firm.ruleLabel}：${rule?.description}`)
   firm.cells[0]!.summary='律所认可记录：已定位法律意见中的出具方及所述服务范围。请提供或定位银行认可该律所、且认可范围覆盖本次保证审查的记录；律所自己的业务范围说明不能代替银行认可记录。';
 }
}
