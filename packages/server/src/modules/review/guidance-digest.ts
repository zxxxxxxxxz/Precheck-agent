import {randomUUID} from 'node:crypto';
import type {DB} from '../../infrastructure/database/client.js';
import {audit} from '../audit/events.js';
import type {Actor} from '../identity/types.js';
import type {ReviewConfigManifest} from '@hsbc/contracts/review-config';
import type {ChecklistRow} from '@hsbc/contracts/review-checklist';
import {GuidanceDigestBodySchema,guidanceTextKey,type CaseGuidance,type GuidanceDigestBody,type GuidanceDigestEntry,type GuidanceDigestView} from '@hsbc/contracts/review-guidance';
import {configHash} from './opa.js';
import {guidanceRefs,loadCaseGuidance} from './guidance.js';

/** How often each case rule was actually relied on by a frozen run and by legal-opinion answers. */
export function guidanceUsage(snapshot:{crossFileChecklist?:Array<Pick<ChecklistRow,'crossChecks'>>}|null,legalLabels:string[],guidance:CaseGuidance[]){
  const usage=new Map<string,number>();
  for(const check of (snapshot?.crossFileChecklist??[]).flatMap(r=>r.crossChecks??[]))for(const ref of check.semantic?.appliedGuidance??[])
    if(ref.startsWith('case:'))usage.set(ref.slice(5),(usage.get(ref.slice(5))??0)+1);
  for(const label of legalLabels){const g=guidance.find(g=>g.label===label);if(g)usage.set(g.id,(usage.get(g.id)??0)+1);}
  return usage;
}

/** Deterministic digest: dedupe against the base release and suggest a disposition. No model call. */
export function buildGuidanceDigest(manifest:ReviewConfigManifest,guidance:CaseGuidance[],usage:Map<string,number>,runId:string|null,includeUnused:boolean):GuidanceDigestBody {
  const active=guidance.filter(g=>g.status==='active'),unpublished=new Set(guidanceRefs(manifest,active).filter(r=>r.source==='case').map(r=>r.ref.slice(5)));
  const candidates=active.filter(g=>unpublished.has(g.id));
  const entries:GuidanceDigestEntry[]=[],unused:GuidanceDigestBody['unused']=[];
  for(const g of candidates){
    const count=usage.get(g.id)??0;
    if(!count&&!includeUnused){unused.push({guidanceId:g.id,label:g.label,statement:g.statement});continue;}
    const keys=new Set(g.expressions.map(guidanceTextKey));
    const related=(manifest.semanticGuidance??[]).findIndex(e=>e.kind===g.kind&&(e.expressions.some(x=>keys.has(guidanceTextKey(x)))||g.fieldIds.length>0&&e.fieldIds.some(id=>g.fieldIds.includes(id))&&!e.expressions.length&&!g.expressions.length));
    const disposition:GuidanceDigestEntry['disposition']=g.kind==='focus_note'?'case_only':related>=0?'merge':'adopt';
    const reason=disposition==='case_only'?'重点提示只针对本案材料，不建议纳入规则中心。':
      disposition==='merge'?`与规则中心口径 G-${related+1} 的范围或表述重叠，建议核对后合并为一条。`:
      g.kind==='name_equivalence'?'具体主体的名称写法；纳入后，同一主体再次出现的案件可直接沿用。':
      g.kind==='legal_baseline'?'法律意见书核对底线，纳入后作为后续案件的提示依据。':'通用的表述差异口径，纳入后适用于选用该版本的后续案件。';
    entries.push({guidanceId:g.id,label:g.label,body:{kind:g.kind,statement:g.statement,fieldIds:g.fieldIds,expressions:g.expressions},usedInRunIds:count&&runId?[runId]:[],appliedCheckCount:count,
      disposition,relatedEntryId:related>=0?manifest.semanticGuidance![related]!.id:null,reason:count?reason:`尚未在预审结论中使用。${reason}`,suggestedStatement:g.statement,method:'deterministic'});
  }
  return GuidanceDigestBodySchema.parse({version:'guidance-digest.v1',baseReleaseId:manifest.releaseId,entries,unused,
    limitations:['整理结果按口径内容和使用记录自动生成；采纳前请核对口径是否适用于其他案件。']});
}

/** Records one digest per distinct input; returns null when there is nothing to propose. */
export async function recordGuidanceDigest(db:DB,actor:Actor,input:{caseId:string;roundId:string|null;runId:string|null;snapshot:{crossFileChecklist?:Array<Pick<ChecklistRow,'crossChecks'>>}|null;manifest:ReviewConfigManifest;trigger:'round_confirmed'|'manual'}):Promise<string|null>{
  const guidance=await loadCaseGuidance(db,input.caseId);
  const legal=(await db.query("SELECT reply FROM business.case_assistant_turns WHERE case_id=$1 AND mode='legal_opinion' AND state='ready' AND round_id IS NOT DISTINCT FROM $2::uuid",[input.caseId,input.roundId])).rows
    .flatMap(r=>(r.reply?.cards??[]).flatMap((c:any)=>c.kind==='legal'?c.points.map((p:any)=>p.baselineLabel).filter(Boolean):[]));
  const body=buildGuidanceDigest(input.manifest,guidance,guidanceUsage(input.snapshot,legal,guidance),input.runId,input.trigger==='manual');
  if(!body.entries.length)return null;
  const inputHash=configHash({caseId:input.caseId,runId:input.runId,base:body.baseReleaseId,entries:body.entries.map(e=>[e.guidanceId,e.body,e.appliedCheckCount])});
  const existing=(await db.query('SELECT id FROM business.review_guidance_digests WHERE case_id=$1 AND input_hash=$2',[input.caseId,inputHash])).rows[0];
  if(existing)return existing.id;
  const id=randomUUID();
  await db.query(`INSERT INTO business.review_guidance_digests(id,case_id,round_id,run_id,base_release_id,trigger,input_hash,state,body,body_hash,account_id,person_id,auth_version,session_key)
    VALUES($1,$2,$3,$4,$5,$6,$7,'ready',$8,$9,$10,$11,$12,$13)`,[id,input.caseId,input.roundId,input.runId,body.baseReleaseId,input.trigger,inputHash,JSON.stringify(body),configHash(body),actor.accountId,actor.personId,actor.authVersion,actor.sessionKey??null]);
  await audit(db,{actorId:actor.accountId,targetId:input.caseId,action:'review.guidance_digest_recorded',details:{digestId:id,trigger:input.trigger,entryCount:body.entries.length}});
  return id;
}

export function digestView(r:any,allowedActions:string[]):GuidanceDigestView {
  if(r.body&&configHash(r.body)!==r.body_hash)throw new Error('guidance_digest_integrity_failed');
  return {id:r.id,caseId:r.case_id,caseNumber:r.case_number??null,caseTitle:r.case_title??'',roundId:r.round_id,roundNumber:r.round_number??null,runId:r.run_id,baseReleaseId:r.base_release_id,
    trigger:r.trigger,state:r.state,body:r.body?GuidanceDigestBodySchema.parse(r.body):null,errorCode:r.error_code,createdAt:new Date(r.created_at).toISOString(),
    adoption:r.adoption?{draftId:r.adoption.draftId??null,releaseId:r.adoption.releaseId??null,step:r.adoption.step??null,errorCode:r.adoption.errorCode??null,entryIds:r.adoption.entryIds??[]}:null,allowedActions};
}
export const DIGEST_SELECT=`SELECT d.*,c.case_number,c.title AS case_title,q.number AS round_number FROM business.review_guidance_digests d JOIN business.cases c ON c.id=d.case_id LEFT JOIN business.review_rounds q ON q.id=d.round_id`;
