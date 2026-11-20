import {assessMailCompletion} from './mail-completion.js';
import {consolidateCorporateFollowUps} from './corporate-followups.js';
import {assessMailRows} from './mail-assessment.js';
import type {ReviewConfigRelease,ReviewRule} from '@hsbc/contracts/review-config';
import {MAIL_TEMPLATE_VERSION,type DeliverySnapshot,type DeliveryRound,type MailBody,type MailRow,type MailCell,type AnalysisEvidence} from '@hsbc/contracts/review-delivery';
import type {ReviewRun,ReviewEvidence} from '@hsbc/contracts/review';
import {reviewHash} from '../review/service.js';
import {mailDocumentGroup,mailRuleLabel} from './mail-presentation.js';

export interface MailSourceRun extends DeliveryRound {
  formalReview?:{id:string;state:string;resultHash:string};
  formalEvidence?:AnalysisEvidence[];
  snapshot:DeliverySnapshot|null;configuration:ReviewConfigRelease|null;results:ReviewRun['results'];
  issues:Array<{id:string;ruleId:string;scopeId:string;status:string}>;
  replies:Array<{id:string;issueId:string;text:string;externalAuthor:string;receivedAt:string}>;
}
export function mailAction(outcome:string|null,reason?:string):string {
  if(outcome==='blocked'&&['manual_review_required','business_rule_confirmation_required','reference_list_required'].includes(reason??''))return '此项需要人工核对或确认适用口径，请按规则要求确认并提供相应依据。';
  switch(outcome){
    case 'fail':return '检查发现差异，请核对并更正相关文件或补充依据后重新检查。';
    case 'blocked':return '检查依据不足或前置条件未满足，请补充所需材料／信息后重新检查。';
    case 'needs_review':case 'manual_review':return '此项需要人工核对，请按规则要求确认并提供相应依据。';
    case 'pass':return '本次程序检查未发现差异；必要人工核对和问题处置仍以对应记录为准。';
    case 'not_applicable':return '本轮记录为不适用，请结合适用条件核对。';
    default:return '尚无有效检查结果，不能据此认定问题已经解决。';
  }
}
const evidenceKey=(e:ReviewEvidence)=>JSON.stringify(e);
const manualReasons=new Set(['manual_review_required','business_rule_confirmation_required','reference_list_required']);
/** Describe only facts actually referenced by this frozen finding, never nearby objects. */
export function specificMailAction(run:MailSourceRun,result:ReviewRun['results'][number]|undefined,rule:ReviewRule|undefined):string {
  return composeMailAction(run,result,rule);
}
function composeMailAction(run:MailSourceRun,result:ReviewRun['results'][number]|undefined,rule:ReviewRule|undefined,concise=false,group?:string):string {
  if(run.state!=='ready'||run.validity!=='current'||!result)return mailAction(null);
  const facts=(rule?.inputs??[]).map(id=>{
    const matching=run.snapshot?.facts.filter(f=>f.fieldId===id&&result.evidenceIds.includes(`fact:${f.factId}:${f.version}`))??[];
    const fact=matching.length===1?matching[0]:undefined;
    return {label:run.configuration?.manifest.fields.find(f=>f.id===id)?.label??run.configuration?.manifest.materials.find(m=>`material:${m.id}`===id)?.label??'所需核对信息',fact};
  });
  const present=facts.filter(x=>x.fact?.state==='present'&&x.fact.rawValue!==null);
  const context=present.map(({label,fact})=>`${label}：${String(fact!.rawValue)}${fact!.currency?` ${fact!.currency}`:''}`).join('；');
  if(rule?.operator==='date_order'&&result.outcome==='fail'&&facts.length===2&&present.length===2){
    return `${context}。${facts[1]!.label}不得早于${facts[0]!.label}，请核实并更正相关文件或补充有效依据。`;
  }
  const missing=facts.filter(x=>!x.fact||['missing','uncertain'].includes(x.fact.state)).map(x=>x.label);
  const needsInput=result.outcome==='blocked'&&!manualReasons.has(result.reasonCode)&&missing.length>0;
  const action=needsInput
    ?`${concise?'':'检查依据不足，'}请补充或确认${[...new Set(missing)].join('、')}后重新检查。`
    :concise&&result.outcome==='pass'?(context?'':'本项检查未发现差异。')
    :concise&&result.outcome==='not_applicable'?'本轮不适用。'
    :concise&&(manualReasons.has(result.reasonCode)||['needs_review','manual_review'].includes(result.outcome))?'请人工核对并确认。'
    :mailAction(result.outcome,result.reasonCode);
  return [context?`${context}。`:concise&&!needsInput?`${mailRuleLabel(rule?.label??'检查要求待核对',group)}：`:'',action].filter(Boolean).join(concise?'':'\n');
}
/** Only explicit one-to-one confirmations may connect objects across immutable rounds.
 * Conflicting chains are kept separate; matching labels are never identity evidence. */
export function mailObjectAliases(runs:MailSourceRun[],pairs:Array<{before:string;after:string}>):Record<string,string>{
  const graph=new Map<string,Set<string>>();
  for(const {before,after} of pairs){const a=runs.flatMap(r=>r.snapshot?.objects??[]).find(o=>o.objectId===before),b=runs.flatMap(r=>r.snapshot?.objects??[]).find(o=>o.objectId===after);
    if(!a||!b||a.kind!==b.kind||a.role!==b.role)continue;
    for(const [x,y] of [[before,after],[after,before]] as const){if(!graph.has(x))graph.set(x,new Set());graph.get(x)!.add(y);}}
  const aliases:Record<string,string>={},seen=new Set<string>();
  for(const start of graph.keys()){if(seen.has(start))continue;const members=new Set<string>(),pending=[start];
    while(pending.length){const id=pending.pop()!;if(members.has(id))continue;members.add(id);seen.add(id);pending.push(...(graph.get(id)??[]));}
    if(runs.some(r=>(r.snapshot?.objects.filter(o=>members.has(o.objectId)).length??0)>1))continue;
    const key=[...members].sort()[0]!;for(const id of members)aliases[id]=key;
  }return aliases;
}
export function buildMail(caseLabel:string,runs:MailSourceRun[],selectedReplyIds:Set<string>,names:Record<string,string>,aliases:Record<string,string>={}):MailBody {
  const rows=new Map<string,MailRow>();
  const keys=runs.map(run=>new Map(run.results.map(result=>{
    const rule=run.configuration?.manifest.rules.find(r=>r.id===result.ruleId);
    // A changed rule is deliberately a separate row; its old conclusion is not transferred.
    const key=reviewHash({rule:rule??result.ruleId,scopeId:aliases[result.scopeId]??result.scopeId});
    return [key,{result,rule}];
  })));
  keys.forEach((entries,index)=>entries.forEach(({result,rule},key)=>{
    const run=runs[index]!;
    if(rows.has(key))return;
    const object=run.snapshot?.objects.find(o=>o.objectId===result.scopeId);
    rows.set(key,{key,ruleId:result.ruleId,objectId:result.scopeId,objectLabel:object?.label??'对象待确认',
      documentGroup:mailDocumentGroup(run.configuration?.manifest,rule),
      documentIds:[],documentLabels:[],documentTypes:[],ruleLabel:rule?.label??'检查要求待核对',sourceReferences:rule?.sourceIds.map(id=>run.configuration!.manifest.sources.find(s=>s.id===id)?.reference).filter((s):s is string=>!!s)??[],evidence:[],cells:[]});
  }));
  for(const [key,row] of rows){
    const evidence=new Map<string,ReviewEvidence>(),documentIds=new Set<string>();
    row.cells=runs.map((run,index):MailCell=>{
      const entry=keys[index]!.get(key),result=entry?.result,rule=entry?.rule;
      const issues=run.issues.filter(i=>i.ruleId===row.ruleId&&i.scopeId===result?.scopeId);
      const replies=run.replies.filter(r=>selectedReplyIds.has(r.id)&&issues.some(i=>i.id===r.issueId));
      const ids=new Set(result?.evidenceIds??[]);
      for(const fact of run.snapshot?.facts??[])if(rule?.inputs.includes(fact.fieldId)&&ids.has(`fact:${fact.factId}:${fact.version}`))for(const e of fact.evidence){evidence.set(evidenceKey(e),e);documentIds.add(e.documentVersionId);}
      for(const material of run.snapshot?.materials??[])if(ids.has(`document:${material.documentVersionId}`))documentIds.add(material.documentVersionId);
      const formal=result as typeof result & {formal?:boolean;formalReason?:string;formalEvidenceIds?:string[]};
      for(const source of run.formalEvidence??[])if(formal?.formalEvidenceIds?.includes(source.id))for(const location of source.locations){evidence.set(evidenceKey(location),location);documentIds.add(location.documentVersionId);}
      const valid=run.state==='ready'&&run.validity==='current';
      return {runId:run.runId,roundId:run.roundId,roundNumber:run.roundNumber,outcome:valid?result?.outcome??null:null,
        manualConfirmation:!!formal?.formal||!!rule&&(rule.operator==='manual_review'||manualReasons.has(result?.reasonCode??'')),
        action:[valid&&formal?.formal&&formal.formalReason?`正式审核提示（待人工核对）：${formal.formalReason}`:'',specificMailAction(run,result,rule)].filter(Boolean).join('\n'),reply:replies.map(r=>`${r.externalAuthor}（${r.receivedAt}）：${r.text}`).join('\n'),
        summary:[valid&&formal?.formal&&formal.formalReason?`正式审核提示（待人工核对）：${formal.formalReason}`:'',composeMailAction(run,result,rule,true,row.documentGroup)].filter(Boolean).join('\n'),
        issueIds:issues.map(i=>i.id),replyIds:replies.map(r=>r.id),issueStatus:issues.some(i=>i.status==='open')?'open':issues[0]?.status??null};
    });
    row.evidence=[...evidence.values()];row.documentIds=[...documentIds];row.documentLabels=row.documentIds.map(id=>names[id]??'关联材料');
    const types=new Set<string>();
    for(const run of runs){
      const rule=run.configuration?.manifest.rules.find(r=>r.id===row.ruleId),manifest=run.configuration?.manifest;
      for(const material of run.snapshot?.materials??[])if(documentIds.has(material.documentVersionId))types.add(manifest?.taxonomy.find(t=>t.id===material.documentTypeId)?.label??'关联材料');
      for(const requirement of manifest?.materials??[])if(rule?.inputs.includes(`material:${requirement.id}`))types.add(requirement.label);
    }
    row.documentTypes=[...types];
    if(!row.documentLabels.length)for(const run of runs){const rule=run.configuration?.manifest.rules.find(r=>r.id===row.ruleId);for(const material of run.configuration?.manifest.materials??[])if(rule?.inputs.includes(`material:${material.id}`)&&!row.documentLabels.includes(material.label))row.documentLabels.push(material.label);}
  }
  // Signature checks are the same frozen version used by the case review and Checker.
  // Only customer-facing actions are copied; internal notes and identity details stay in the snapshot.
  const signatureKeys=new Set(runs.flatMap(run=>(run.snapshot?.signatureInformation??[]).flatMap(s=>s.evaluation.checks.filter(c=>s.validity==='stale'||!['satisfied','not_applicable'].includes(c.status)).map(c=>JSON.stringify([s.documentId,c.id])))));
  for(const key of signatureKeys){const [documentId,checkId]=JSON.parse(key),known=runs.flatMap(run=>run.snapshot?.signatureInformation??[]).find(s=>s.documentId===documentId),check=known?.evaluation.checks.find(c=>c.id===checkId);if(!known||!check)continue;
    const documentGroup=runs.flatMap(run=>{const material=run.snapshot?.materials.find(item=>item.documentVersionId===documentId);return material?run.configuration?.manifest.taxonomy.filter(type=>type.id===material.documentTypeId).map(type=>type.label)??[]:[];});
    rows.set('signature:'+key,{key:'signature:'+key,ruleId:'signature:'+checkId,objectId:documentId,objectLabel:'签署与授权核对',documentGroup:new Set(documentGroup).size===1?documentGroup[0]:undefined,documentIds:[documentId],documentLabels:[names[documentId]??known.filename],ruleLabel:check.label,sourceReferences:[],evidence:check.evidence,cells:runs.map(run=>{
      const summary=run.snapshot?.signatureInformation?.find(s=>s.documentId===documentId),current=summary?.evaluation.checks.find(c=>c.id===checkId),valid=run.state==='ready'&&run.validity==='current'&&summary?.validity==='current';
      const status=valid?current?.status:null,outcome=status==='satisfied'?'pass':status==='not_applicable'?'not_applicable':status==='not_satisfied'?'fail':status==='needs_confirmation'?'blocked':null;
      const action=status==='satisfied'?'已满足当前已确认的签署要求；仍需案件复核。':status==='not_applicable'?'此签署要求不适用。':status==='not_satisfied'?'请按已确认要求补充或更正签署、授权或日期信息，并提交原文依据。':'请核对签署位置、人员、授权及日期，并补充缺失或冲突的原文依据。';
      return {runId:run.runId,roundId:run.roundId,roundNumber:run.roundNumber,outcome,manualConfirmation:status==='needs_confirmation',action,reply:'',issueIds:[],replyIds:[],issueStatus:null};})});
  }
  const assessedRows=[...rows.values()];
  assessMailRows(assessedRows,runs,names,aliases);
  assessMailCompletion(assessedRows,runs,aliases);
  consolidateCorporateFollowUps(assessedRows,runs);
  const latest=runs.at(-1)!;
  const fieldReviewSummary=latest.snapshot?.fieldReviews?.reduce((counts,field)=>{counts[latest.state==='ready'&&latest.validity==='current'&&field.verification.validity==='current'?field.verification.status:'pending']++;return counts;},{confirmed:0,consistent:0,different:0,pending:0,not_applicable:0});
  return {...(fieldReviewSummary?{fieldReviewSummary}:{}),subject:`[预审反馈]-${caseLabel} · ${latest.label}`,caseLabel,
    notice:['本邮件为预审草稿，仅适用于所列材料和检查范围。参考译文未经人工核对，不替代正式材料要求；预审结果不代表最终业务批准。',
      ...latest.snapshot?.automaticChecks?.filter(c=>c.task?.kind==='notice'&&c.task.group==='conditions'&&c.status==='done').map(c=>`条件提示：${c.reason}`)??[]].join('\n'),
    rounds:runs.map(({roundId,roundNumber,runId,state,validity,label})=>({roundId,roundNumber,runId,state,validity,label})),rows:assessedRows,documentRounds:Object.fromEntries([...runs].reverse().flatMap(r=>(r.snapshot?.materials??[]).map(m=>[m.documentVersionId,r.roundId]))),totalChecks:latest.results.length+(latest.snapshot?.signatureInformation??[]).reduce((n,s)=>n+s.evaluation.checks.length,0),templateVersion:MAIL_TEMPLATE_VERSION};
}
