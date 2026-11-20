import type {AutomaticReviewCheck,ReviewedRuleInputs} from '@hsbc/contracts/field-verification';
import type {ChecklistRow} from '@hsbc/contracts/review-checklist';
import type {ReviewConfigManifest,ReviewFacts} from '@hsbc/contracts/review-config';
import {CORPORATE_WORKBOOK_SHA256} from '@hsbc/contracts/corporate-requirements';
import {originalTextKey} from './field-review-original.js';

// Each entry covers the complete comparison specified by that workbook row.
// Legal acceptability, signature authenticity and amount acceptance are absent.
const comparisons:Record<number,string[][]>={
 11:[['cgt_field_10','cgt_field_43']],
 12:[['cgt_field_11','cgt_field_60','cgt_field_41'],['cgt_field_9','cgt_field_61','cgt_field_42']],
 14:[['cgt_field_14','cgt_field_9','cgt_field_61']],
 19:[['cgt_field_19','cgt_authorization_reference_date']],
 27:[['cgt_field_24','cgt_field_9','cgt_field_61']],
 29:[['cgt_field_26','cgt_field_4']],30:[['cgt_field_27','cgt_field_7']],
 42:[['cgt_field_32','cgt_field_9']],43:[['cgt_field_33','cgt_field_6']],
 44:[['cgt_field_34','cgt_field_7']],45:[['cgt_field_35','cgt_field_4']],
 52:[['cgt_field_41','cgt_field_11','cgt_field_60']],53:[['cgt_field_42','cgt_field_9','cgt_field_61']],
 54:[['cgt_field_43','cgt_field_10']],59:[['cgt_field_49','cgt_field_11','cgt_field_60']],
 60:[['cgt_field_50','cgt_field_9','cgt_field_61']],65:[['cgt_field_60','cgt_field_11']],
 66:[['cgt_field_61','cgt_field_9']],70:[['cgt_field_63','cgt_field_9','cgt_field_61']],
};
const primary:Record<number,string>={7:'cgt_field_6',46:'cgt_field_36',47:'cgt_field_37',48:'cgt_field_38'};
const key=(v:unknown)=>typeof v==='string'?originalTextKey(v).toUpperCase():v;

/** Executes narrowly specified checks on the same verified inputs used by OPA.
 * Frozen alongside its unchanged policy receipt, with all actual dependencies. */
export function corporateReviewedChecks(rows:ChecklistRow[],manifest:ReviewConfigManifest,scopes:ReviewedRuleInputs[],businessDate:string,instances?:Array<{scopeId:string;facts:ReviewFacts}>):AutomaticReviewCheck[]{
 const checks:AutomaticReviewCheck[]=[];
 for(const scope of scopes){
  if(scope.policyVersion!=='reviewed-rule-inputs-v1'||scope.configurationReleaseId!==manifest.releaseId)continue;
  const objectId=scope.scopeId==='unconfirmed:corporate_guarantee'?null:scope.scopeId;
  const own=rows.filter(r=>r.objectId===objectId&&r.objectRole==='corporate_guarantee');
  const effective=instances?.find(i=>i.scopeId===scope.scopeId)?.facts;
  const value=(id:string)=>{const fact=instances?effective?.[id]:scope.inputs[id]?.fact;return fact?.state==='present'?fact.value:null;};
  for(const number of [...Object.keys(comparisons).map(Number),7,46,47,48]){
   const groups=comparisons[number],fieldId=primary[number]??groups![0]![0]!,rule=manifest.rules.find(r=>r.id===`cgt_bank_${number}`);
   const row=own.find(r=>r.fieldId===fieldId),sourceId=`cgt_rule_source_${number}`;
   if(!row||!rule||rule.operator!=='manual_review'||rule.inputs.length!==1||rule.inputs[0]!==fieldId||rule.objectScope?.role!=='corporate_guarantee'||rule.requiredParameters.length||!rule.sourceDirectionConfirmed||
    rule.sourceIds.length!==1||rule.sourceIds[0]!==sourceId||!manifest.sources.some(s=>s.id===sourceId&&s.sha256===CORPORATE_WORKBOOK_SHA256&&s.guaranteeType==='corporate_guarantee'&&['candidate','confirmed'].includes(s.disposition)))continue;
   if(rule.applicability&&value(rule.applicability.fieldId)!==rule.applicability.equals)continue;
   const ids=groups?.flat()??(number===7?['cgt_field_6','cgt_authorization_date']:number===46?['cgt_rm_option','material:cgt_lawyer_confirmation']:[fieldId]);
   if(ids.some(id=>value(id)===null||value(id)===undefined))continue;
   if(ids.some(id=>!scope.inputs[id]||value(id)!==scope.inputs[id]!.fact.value))continue;
   let passed:boolean;
   if(groups)passed=groups.every(ids=>new Set(ids.map(id=>key(value(id)))).size===1||
    // A current human cross-file address comparison may explicitly accept a
    // formatting difference. Reuse it only when it covers both verified values.
    [11,54].includes(number)&&own.some(r=>r.verification?.validity==='current'&&!r.verification.origin&&r.verification.scope==='cross_file'&&r.verification.meaning==='consistent'&&
     ids.every(id=>r.verification!.sources.some(s=>s.kind==='original'&&s.comparisonKey!==null&&key(s.value)===key(value(id))&&scope.inputs[id]!.evidence.some(e=>JSON.stringify(e)===JSON.stringify(s.evidence))))));
   else if(number===7)passed=String(value('cgt_authorization_date'))<=String(value(fieldId))&&String(value(fieldId))<=businessDate;
   else if(number===46)passed=value('cgt_rm_option')==='a'||value('cgt_rm_option')==='b'&&value('material:cgt_lawyer_confirmation')===true;
   else passed=String(value(fieldId)).trim().length>0;
   const refs=ids.flatMap(id=>scope.inputs[id]!.evidence),sources=own.flatMap(r=>r.verification?.sources??[]).filter(s=>s.kind==='original'&&s.comparisonKey!==null&&refs.some(e=>JSON.stringify(e)===JSON.stringify(s.evidence)));
   if(!sources.length)continue;
   const date=number===7||number===19||number===43;
   const status=passed?'done':date||number===46?'open':'confirm';
   const reason=passed?number===46?'客户经理证明已选定有效选项；对应公司担保的律师意见／确认材料已提供，法律批准另项核验。':
    number===7?'保证书日期不早于授权文件签署日，且不晚于本轮审核基准日。':number===47||number===48?'已从当前核对记录定位并验证原文，本项必填内容完整。':'已用当前有效原文逐一比较本项要求的全部对应字段，结果一致。':
    date?'对应日期不符合本项顺序或一致性要求，请核对更正。':number===46?'选项或相应律师意见／确认材料未满足要求。':'已核对的对应字段文字不同，需判断差异是否可接受。';
   checks.push({id:`reviewed-inputs-v1:${scope.scopeId}:${rule.id}`,fieldId,objectId,ruleIds:[rule.id],status,reason,
    item:{rowId:row.id,fieldId,objectId,scope:'bank_rule',meaning:passed?'consistent':status==='open'?'different':'pending',reason,actions:passed?[]:[reason],sources:[...new Map(sources.map(s=>[JSON.stringify(s),s])).values()]}});
  }
  const amountRule=manifest.rules.find(r=>r.id==='cgt_amount_minimum'),bankAmount=manifest.rules.find(r=>r.id==='cgt_bank_13'),amountRow=own.find(r=>r.fieldId==='cgt_field_12');
  if(amountRow&&amountRule?.operator==='minimum_ratio'&&['cgt_amount,cgt_required_amount,cgt_currency,cgt_required_currency','cgt_amount,cgt_user_required_amount,cgt_currency,cgt_user_required_currency'].includes(amountRule.inputs.join(','))&&
   bankAmount?.operator==='manual_review'&&bankAmount.inputs.join(',')==='cgt_field_12'&&[amountRule,bankAmount].every(r=>r.sourceDirectionConfirmed&&r.sourceIds.every(id=>manifest.sources.some(s=>s.id===id&&s.sha256===CORPORATE_WORKBOOK_SHA256)))&&
   value('cgt_limited')==='limited'&&['cgt_amount','cgt_currency'].every(id=>value(id)!==null&&value(id)===scope.inputs[id]?.fact.value)&&value(amountRule.inputs[1]!)===null&&value(amountRule.inputs[3]!)===null){
   const refs=['cgt_amount','cgt_currency'].flatMap(id=>scope.inputs[id]?.evidence??[]),sources=own.flatMap(r=>r.verification?.sources??[]).filter(s=>s.kind==='original'&&s.comparisonKey!==null&&refs.some(e=>JSON.stringify(e)===JSON.stringify(s.evidence)));
   const reason=`保证书金额已核对为 ${value('cgt_currency')} ${value('cgt_amount')}；尚无明确的本次最低担保金额确认。请确认该金额可接受，或提供用于比较的金额及币种。`;
   checks.push({id:`reviewed-inputs-v1:${scope.scopeId}:amount-acceptance`,fieldId:amountRow.fieldId,objectId,ruleIds:[amountRule.id,bankAmount.id],status:'confirm',reason,
    item:{rowId:amountRow.id,fieldId:amountRow.fieldId,objectId,scope:'bank_rule',meaning:'pending',reason,actions:[reason],sources}});
  }
 }
 return checks;
}
