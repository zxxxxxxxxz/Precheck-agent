import type {AutomaticReviewCheck,FrozenFieldReview} from '@hsbc/contracts/field-verification';
import {fieldReviewStatus} from '@hsbc/contracts/field-verification';
import type {ReviewConfigManifest,ReviewRequirementPolicy} from '@hsbc/contracts/review-config';
import {CORPORATE_WORKBOOK_SHA256,CORPORATE_CHECKLIST_SHA256} from '@hsbc/contracts/corporate-requirements';
import {corporateBankScope,projectRequirementAction} from './requirement-policy.js';
import {uniqueSources,type CorporateCheckContext,type CorporateSource} from './corporate-check-sources.js';

/** Classify the complete selected wording, with current effectiveness taking
 * priority over future reminders. Unknown wording remains a real review task. */
export function corporateConditionKind(values:string[]):'current'|'notice'|'uncertain'{
 const clauses=values.flatMap(v=>v.normalize('NFKC').split(/[。；\n]/u).map(s=>s.replace(/\s+/gu,''))).filter(Boolean);
 if(!clauses.length)return 'uncertain';
 const current=/(?:仅在|只有|须在).{0,100}(?:方可生效|才生效|才能生效)|尚待完成.{0,20}生效|未完成.{0,40}(?:不得生效|不生效)|(?:本保证|保证书).{0,30}(?:尚未生效|未生效)|guarantee.{0,60}noteffectiveuntil/iu;
 if(clauses.some(s=>current.test(s)&&!/(?:无|没有)尚待完成|该生效条件已满足|thisconditionhasbeensatisfied/iu.test(s)))return 'current';
 // A signature/approval keyword alone cannot turn an unresolved execution
 // requirement into a future reminder. Keep ambiguous timing with the system.
 if(clauses.some(s=>/尚未|尚待|未完成|未满足|outstanding|notyet/iu.test(s)&&/签署|签名|授权|批准|登记|生效|execution|registration|approval/iu.test(s)&&!/启用|未来|后续|变更|无尚待完成|没有尚待完成|drawdown|future|subsequent/iu.test(s)))return 'uncertain';
 const known=/后续|启用|未来|变更|改变|重新(?:核对|审查)|再次审阅|一般法律|破产|清盘|衡平|法院裁量|检索|查询时点|签名|笔迹|真伪|真实签署|合成输入|内部批准|银行法务|GRM\(b\)|本律师意见不构成|(?:不作为|不构成).{0,25}(?:前提|事实来源)|无尚待完成|该生效条件已满足|future|subsequent|changes?|drawdown|insolvency|authenticity|bank.?sinternalapproval|thisconditionhasbeensatisfied/iu;
 // A factual-review statement is background, not a new completion condition.
 return clauses.every(s=>known.test(s)||/^已审阅.+不以概括.+代替核查$/u.test(s))?'notice':'uncertain';
}

/** Category-wide execution, with no case number, filename, address, or fixture
 * reference IDs. Readable pending sources may describe conditions; they never
 * become adopted facts or a fabricated signature/approval confirmation. */
export function corporatePreReviewChecks(c:CorporateCheckContext,m:ReviewConfigManifest,scopeId:string,policy:ReviewRequirementPolicy|undefined):AutomaticReviewCheck[]{
 if(!corporateBankScope(policy))return [];
 const checks:AutomaticReviewCheck[]=[];
 const sources=(field:string)=>c.reviewed?.get(field)??c.values(field);
 const present=(field:string,value?:string|boolean)=>c.facts[field]?.state==='present'&&(value===undefined||c.facts[field]?.value===value);
 const allowed=(id:string,field:string)=>{
  const r=m.rules.find(r=>r.id===id);
  return !!r&&r.objectScope?.role==='corporate_guarantee'&&r.operator==='manual_review'&&r.inputs.length===1&&r.inputs[0]===field&&!r.requiredParameters.length&&r.sourceDirectionConfirmed&&
   (!r.applicability||present(r.applicability.fieldId,r.applicability.equals))&&r.sourceIds.includes(id==='cgt_legal_checklist_3_review'?'cgt_checklist':id.replace('cgt_bank_','cgt_rule_source_'))&&r.sourceIds.every(id=>m.sources.some(s=>s.id===id&&s.sha256===(id==='cgt_checklist'?CORPORATE_CHECKLIST_SHA256:CORPORATE_WORKBOOK_SHA256)&&['candidate','confirmed'].includes(s.disposition)));
 };
 const emit=(id:string,field:string,status:AutomaticReviewCheck['status'],kind:NonNullable<AutomaticReviewCheck['task']>['kind'],group:string,reason:string,proof:CorporateSource[])=>{
  const row=c.own.find(r=>r.fieldId===field),all=uniqueSources(proof);
  if(!row||row.verification?.meaning==='different'||!allowed(id,field)||all.length>40)return;
  // A current, explicit bank-rule judgment is authoritative; source extraction
  // alone is not a judgment on an internal bank list or a legal condition.
  if(status!=='done'&&row.verification?.scope==='bank_rule'&&row.verification.validity==='current'&&['consistent','not_applicable'].includes(row.verification.meaning))return;
  checks.push({id:`corporate-bank-scope-v1:${scopeId}:${id}`,fieldId:field,objectId:row.objectId,ruleIds:[id],status,reason,task:{kind,group},
   execution:{version:'corporate-bank-scope-v1',referenceHashes:[CORPORATE_WORKBOOK_SHA256,...(id==='cgt_legal_checklist_3_review'?[CORPORATE_CHECKLIST_SHA256]:[])],evidence:[]},
   item:{rowId:row.id,fieldId:field,objectId:row.objectId,scope:'bank_rule',meaning:status==='done'?'consistent':'pending',reason,actions:status==='confirm'?[reason]:[],sources:all}});
 };
 // The existing source-backed bank-rule save is the acceptance channel. A
 // source-only confirmation or stale receipt cannot substitute for it.
 for(const [n,field] of [[9,'cgt_field_8'],[17,'cgt_field_17'],[21,'cgt_field_21'],[22,'cgt_field_22'],[23,'cgt_field_23'],[15,'cgt_field_15'],[20,'cgt_field_20'],[33,'cgt_field_30'],[34,'cgt_field_31'],[37,'cgt_legal_firm']] as const){
  const row=c.own.find(r=>r.fieldId===field),v=row?.verification,proof=sources(field);
  if(v?.validity==='current'&&!v.origin&&v.scope==='bank_rule'&&v.meaning==='consistent'&&proof.length)
   emit(`cgt_bank_${n}`,field,'done',n===37?'bank':'customer',n===37?'law-firm':`accepted:${n}`,
    '已复核当前人工银行规则确认及其原文依据，采用本项已记录的确认／澄清结果；不追加原规则以外的证明文件、真实性鉴定或独立批复。',proof);
 }
 const identity=[16,17,18,21,22,23,32],fields=[16,17,18,21,22,23,29];
 for(let i=0;i<identity.length;i++){
  const n=identity[i]!,field=`cgt_field_${fields[i]}`,proof=sources(field);
  if(!present('material:cgt_identity',false)||!proof.length)continue;
  const action=n===17?'签署人地址缺少证明时，可由客户经理合理澄清。':n>=21&&n<=23?'见证人姓名、地址、证件缺少证明时，可由客户经理确认。':'签署人及授权签字人的姓名、证件应与对应身份证明核对，请提供或定位该证明。';
  emit(`cgt_bank_${n}`,field,'confirm','customer','identity',`已定位文书记载；本轮清单未提供对应身份证明。${action}同一份资料只提交一次，不要求签名真伪鉴定。`,proof);
 }
 for(const [n,field] of [[15,'cgt_field_15'],[20,'cgt_field_20'],[33,'cgt_field_30'],[34,'cgt_field_31']] as const){
  const row=c.own.find(r=>r.fieldId===field);
  if(row?.verification?.meaning!=='pending')continue;
  emit(`cgt_bank_${n}`,field,'incomplete','system','signature','系统仍需完成签署有无、人员、人数及授权组合检查；仅凭姓名或真实性待核备注不能得出结果。不要求客户鉴定笔迹或签名真伪。',sources(field));
 }
 const legal=c.current.filter(d=>d.taxonomyIds.includes('cgt_legal'));
 const legalProof=c.values('cgt_legal_checklist_1','cgt_legal');
 const routeRow=c.own.find(r=>r.fieldId==='cgt_legal_route');
 const routeMissing=!routeRow?.fact&&(!c.facts.cgt_legal_route||['missing','uncertain'].includes(c.facts.cgt_legal_route.state));
 if(present('material:cgt_legal',true)&&legal.length===1&&c.coverage.get(legal[0]!.id)&&legalProof.length&&
  (routeMissing||present('cgt_legal_route','opinion')||present('cgt_legal_route','rm')&&present('material:cgt_rm',true))&&
  (!present('cgt_rm_option','b')||present('material:cgt_lawyer_confirmation',true)))
  emit('cgt_bank_36','cgt_legal_route','done','notice','legal-route','已核对法律意见材料已提供；RM 选择 b 时的律师意见／邮件配套亦按材料清单核对。不默认追加独立内部批复附件，律所认可和意见内容分别检查。',[...legalProof,...c.values('cgt_field_36','cgt_rm')]);
 // Carry the accepted opinion route through its dependent material checks.
 // Never silently satisfy an explicitly selected waiver or an absent RM.
 const route=checks.find(check=>check.ruleIds.includes('cgt_bank_36')&&check.status==='done');
 if(route&&(routeMissing||present('cgt_legal_route','opinion'))){
  for(const [type,choice] of [['legal','opinion'],['rm','rm'],['waiver','waiver']] as const){
   const rule=m.rules.find(r=>r.id===`cgt_${type}_required`);
   if(!rule||rule.operator!=='present'||rule.objectScope?.role!=='corporate_guarantee'||rule.inputs.join(',')!==`material:cgt_${type}`||rule.applicability?.fieldId!=='cgt_legal_route'||rule.applicability.equals!==choice||rule.requiredParameters.length||!rule.sourceDirectionConfirmed||rule.sourceIds.length!==1||rule.sourceIds[0]!== (type==='waiver'?'cgt_rule_source_36':'cgt_materials')||!rule.sourceIds.every(id=>m.sources.some(s=>s.id===id&&s.sha256===CORPORATE_WORKBOOK_SHA256)))continue;
   checks.push({...route,id:`${route.id}:${type}`,ruleIds:[rule.id],reason:type==='legal'?'已复核本公司担保的法律意见原文及材料清单，法律意见书已提供。':'已按已提供的法律意见路径完成材料适用性检查，不另要求简化路径证明或法律意见豁免批准。'});
  }
 }
 const firm=sources('cgt_legal_firm');
 if(firm.length)emit('cgt_bank_37','cgt_legal_firm','confirm','bank','law-firm','已定位出具律所及其所述服务范围；请银行内部提供认可名单或确认认可范围是否覆盖本次保证审查，不作为客户补件。',firm);
 for(const [id,field] of [['cgt_bank_38','cgt_legal_references'],['cgt_legal_checklist_3_review','cgt_legal_checklist_3']] as const){
  const row=c.own.find(r=>r.fieldId===field),proof=sources(field);
  if(row?.verification?.meaning!=='pending')continue;
  const actions=row.verification.actions.filter(a=>/^请定位或补充/u.test(a)).map(a=>projectRequirementAction(a,policy).split(/[。]/u)[0]!).filter(Boolean);
  actions.push(...row.verification.actions.filter(a=>/日期|签署日|版本/u.test(a)&&/不一致|不符|不同|差异|冲突/u.test(a)&&!/独立出具日期|RM.{0,12}实际出具日期/u.test(a)).map(a=>projectRequirementAction(a,policy)));
  const detail=actions.length?[...new Set(actions)].join('；'):'请逐项定位法律意见实际引用而尚未找到的文件，或说明具体日期／版本差异。';
  if(detail.length>1000)continue; // Keep the existing detailed record, never truncate a real discrepancy.
  emit(id,field,proof.length?'confirm':'incomplete',proof.length?'customer':'system','references',proof.length?`${detail}。仅核对实际引用文件及其对应内容，不使用固定附件编号清单，不新增 RM 独立出具日期要求；如原文引用的日期与文件不匹配，仍需列明具体差异。`:'引用材料原文尚未完成定位，需系统继续核对，不能据此要求客户补件。',proof);
 }
 const conditions=sources('cgt_legal_conditions'),kind=corporateConditionKind(conditions.map(s=>s.value));
 const full=legal.length===1&&c.coverage.get(legal[0]!.id)&&conditions.length>0;
 const excerpt=[...new Set(conditions.map(s=>s.value.replace(/\s+/gu,' ')))].join('\n').slice(0,1300);
 emit('cgt_bank_39','cgt_legal_conditions',!full||kind==='uncertain'?'incomplete':kind==='notice'?'done':'confirm',!full||kind==='uncertain'?'system':kind==='notice'?'notice':'customer','conditions',
  !full?'系统尚未完成法律条件原文核验，不转为客户补件。':kind==='notice'?`已提取材料中的条件提示，不要求本次预审完成全部放款启用、未来变更或真实性鉴定事项。原文条件保留供相应业务环节注意（不构成银行批准）：\n${excerpt}`:
   `${kind==='current'?'材料明确涉及当前生效条件，请核对具体条款':'系统尚未确定条款的适用时点，需继续核对原文，不作为客户补件'}；不能仅按后续提醒处理，也不默认索取无变化声明。\n${excerpt}`,conditions);
 return checks;
}

export function mergeCorporateScopeChecks(prior:AutomaticReviewCheck[],next:AutomaticReviewCheck[]):AutomaticReviewCheck[]{
 let result=[...prior];
 for(const check of next){
  const applicable=check.ruleIds.filter(id=>!result.some(p=>p.objectId===check.objectId&&p.ruleIds.includes(id)&&(p.status==='open'||check.status==='incomplete'&&p.status==='done')));
  if(!applicable.length)continue;
  result=result.flatMap(p=>p.objectId!==check.objectId?[p]:p.ruleIds.filter(id=>!applicable.includes(id)).length?[{...p,ruleIds:p.ruleIds.filter(id=>!applicable.includes(id))}]:[]);
  result.push({...check,ruleIds:applicable});
 }
 return result;
}

export function projectCorporateScopeFields(fields:FrozenFieldReview[],checks:AutomaticReviewCheck[]):FrozenFieldReview[]{
 return fields.map(field=>{
  const check=checks.find(c=>c.execution?.version==='corporate-bank-scope-v1'&&c.fieldId===field.fieldId&&c.objectId===field.objectId);
  if(!check||field.verification.validity!=='current'||field.verification.meaning==='different'||checks.some(c=>c.objectId===field.objectId&&c.fieldId===field.fieldId&&c.status==='open'))return field;
  return {...field,verification:{...field.verification,...check.item,status:fieldReviewStatus(check.item),origin:'automatic',pendingKind:check.status==='incomplete'?'incomplete':'manual',recordId:check.id}};
 });
}
