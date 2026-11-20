import type {FormalCheck,FormalResult} from '@hsbc/contracts/formal-review';
import type {AnalysisEvidence} from '@hsbc/contracts/review-delivery';
import type {ReviewConfigRelease} from '@hsbc/contracts/review-config';
import {buildRuleInstances,reviewHash,type ReviewSnapshot} from '../review/service.js';
import {AppError} from '../../shared/errors.js';
export function formalChecklist(snapshot:ReviewSnapshot,release:ReviewConfigRelease,results:any[],evidence:AnalysisEvidence[]):FormalCheck[]{
 const checks=buildRuleInstances(snapshot,release).flatMap(instance=>instance.ruleIds.map(ruleId=>{
  const rule=release.manifest.rules.find(r=>r.id===ruleId)!,object=snapshot.objects.find(o=>o.objectId===instance.scopeId);
  const program=results.filter(r=>r.ruleId===ruleId&&r.scopeId===instance.scopeId);
  if(program.length!==1)throw new AppError(409,'formal_program_coverage_incomplete');
  const docs=new Set(object?.evidence.map(e=>e.documentVersionId)??[]);
  for(const field of rule.inputs)for(const fact of snapshot.facts)if(instance.facts[field]?.evidenceIds.includes(`fact:${fact.factId}:${fact.version}`))for(const e of fact.evidence)docs.add(e.documentVersionId);
  const sources=evidence.filter(e=>docs.has(e.documentId));
  const gaps:string[]=[];
  if(!object&&instance.scopeId!=='case')gaps.push('对象尚未确认');
  if(!rule.sourceDirectionConfirmed)gaps.push('业务口径尚未确认');
  if(rule.manualReason&&rule.manualReason!=='manual_review_required')gaps.push('仍缺参考名单或业务依据');
  if(!sources.length||[...docs].some(id=>!sources.some(e=>e.documentId===id)))gaps.push('缺少可定位的完整原文');
  if(sources.some(e=>e.warnings.length))gaps.push('原文解析或必要引用不完整');
  return {id:reviewHash([ruleId,instance.scopeId]),ruleId,objectId:instance.scopeId,objectLabel:object?.label??'对象待确认',label:rule.label,requirement:rule.description??rule.label,
   sourceReferences:rule.sourceIds.map(id=>release.manifest.sources.find(s=>s.id===id)?.reference??id),method:!rule.sourceDirectionConfirmed||rule.manualReason&&rule.manualReason!=='manual_review_required'?'business_confirmation':rule.operator==='manual_review'?'cloud_and_human':'program',
   programOutcome:program[0].outcome,evidenceIds:sources.map(e=>e.id),gaps,sourceDirectionConfirmed:rule.sourceDirectionConfirmed===true,
   confirmedInputs:rule.inputs.map(id=>({field:id,state:instance.facts[id]?.state??'missing',value:instance.facts[id]?.value??null}))} satisfies FormalCheck;
 }));
 if(checks.length!==results.length)throw new AppError(409,'formal_program_coverage_incomplete');
 return checks;
}
export function formalProgramResult(check:FormalCheck):Omit<FormalResult,'id'>|null {
 if(check.method!=='program')return null;
 return {checkId:check.id,outcome:check.programOutcome==='pass'||check.programOutcome==='not_applicable'?'no_issue':check.programOutcome==='fail'?'issue':'insufficient',
  reason:'沿用本轮程序规则结果；未重复调用云模型。程序失败或依据不足仍须按原检查处理。',citations:[]};
}
/** Keep formal observations separate from immutable OPA results, using the existing disposition UI. */
export function formalFindings(checks:FormalCheck[],results:FormalResult[]){return results.filter(r=>r.outcome!=='no_issue'&&checks.find(c=>c.id===r.checkId)?.method!=='program').map(r=>{
 const check=checks.find(c=>c.id===r.checkId)!;
 return {evaluationId:r.id,ruleId:`formal:${check.ruleId}`,scopeId:check.objectId,outcome:'blocked',reasonCode:r.outcome==='insufficient'?'formal_evidence_required':check.sourceDirectionConfirmed&&check.gaps.length===0?'manual_review_required':'business_rule_confirmation_required',
  evidenceIds:[],formal:true,formalReason:r.reason,formalCheckId:check.id,formalEvidenceIds:check.evidenceIds};
});}
