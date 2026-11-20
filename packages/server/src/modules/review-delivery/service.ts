import {formalRecord} from '../formal-review/records.js';
import {assertCheckerInputsMutable,invalidateCheckerContent,checkerCorrectionActive} from '../review-checker/access.js';
import {randomUUID} from 'node:crypto';
import type {Pool} from 'pg';
import type {FastifyInstance} from 'fastify';
import {z} from 'zod';
import {MailCommandSchema,mailContent,type DeliveryState,type MailDraft} from '@hsbc/contracts/review-delivery';
import {transaction,type DB} from '../../infrastructure/database/client.js';
import {idempotent} from '../../infrastructure/database/idempotency.js';
import {AppError} from '../../shared/errors.js';
import {authorizeCase,canEditReview} from '../cases/authorization.js';
import {hasGrant} from '../identity/authorization.js';
import type {Actor} from '../identity/types.js';
import type {Auth} from '../identity/auth.js';
import {audit} from '../audit/events.js';
import {getPublished} from '../review/configuration.js';
import {reviewHash} from '../review/service.js';
import {buildMail,mailObjectAliases,type MailSourceRun} from './mail.js';

const outputActions=['report:read','report:generate','report:export'] as const;
const iso=(value:Date|string)=>new Date(value).toISOString();
export class ReviewDeliveryService {
  constructor(readonly pool:Pool){}
  private async authorize(db:DB,actor:Actor,caseId:string,action:string,write=false){
    const c=await authorizeCase(db,actor,caseId,'evidence:read',write);
    if(!await hasGrant(db,actor.personId,action,caseId))throw new AppError(403,'permission_denied');
    if(write){
      await assertCheckerInputsMutable(db,c);
      if(c.closed_at)throw new AppError(409,'case_closed');
      if(!await canEditReview(db,c,actor.personId))throw new AppError(403,'maker_assignment_required');
      if(c.scenario!=='overseas_loan')throw new AppError(409,'scenario_confirmation_required');
    }
    return c;
  }
  private async source(db:DB,caseId:string,runId:string,replyIds:string[]){
    const selected=(await db.query('SELECT * FROM business.review_runs WHERE id=$1 AND case_id=$2',[runId,caseId])).rows[0];
    if(!selected)throw new AppError(404,'review_run_not_found');
    if(reviewHash(selected.snapshot)!==selected.snapshot_hash)throw new AppError(409,'review_snapshot_corrupt');
    let rows:any[];
    if(selected.round_id){
      const round=(await db.query('SELECT * FROM business.review_rounds WHERE id=$1 AND case_id=$2',[selected.round_id,caseId])).rows[0];
      if(!round||round.run_id!==runId)throw new AppError(409,'delivery_round_run_mismatch');
      rows=(await db.query(`SELECT r.*,q.id AS source_round_id,q.number AS source_round_number,q.state AS source_round_state
        FROM business.review_rounds q LEFT JOIN business.review_runs r ON r.id=q.run_id
        WHERE q.case_id=$1 AND q.number<=$2 AND q.submitted_at IS NOT NULL ORDER BY q.number`,[caseId,round.number])).rows;
    }else rows=[selected];
    const runIds=rows.map(r=>r.id).filter(Boolean);
    const issues=(await db.query(`SELECT i.*,f.run_id FROM business.review_issues i JOIN business.review_findings f ON f.id=i.latest_finding_id
      WHERE i.case_id=$1 AND (i.round_id=ANY($2::uuid[]) OR i.round_id IS NULL AND f.run_id=ANY($3::uuid[])) ORDER BY i.id`,[caseId,rows.map(r=>r.source_round_id).filter(Boolean),runIds])).rows;
    const replies=(await db.query(`SELECT id,issue_id,round_id,details,created_at FROM business.review_events WHERE case_id=$1 AND kind='external_reply'
      AND issue_id=ANY($2::uuid[]) ORDER BY created_at,id`,[caseId,issues.map(i=>i.id)])).rows;
    if(replyIds.some(id=>!replies.some(r=>r.id===id)))throw new AppError(422,'delivery_reply_scope_invalid');
    const sources:MailSourceRun[]=[];
    for(const row of rows){
      if(row.id&&reviewHash(row.snapshot)!==row.snapshot_hash)throw new AppError(409,'review_snapshot_corrupt');
      const formal=row.id?await formalRecord(db,row.id):null;
      const configuration=row.id?structuredClone(await getPublished(db,row.configuration_release_id)):null;
      if(configuration&&formal)configuration.manifest.rules.push(...configuration.manifest.rules.map(r=>({...r,id:`formal:${r.id}`,label:`正式审核 · ${r.label}`})));
      const ownIssues=issues.filter(i=>row.source_round_id?i.round_id===row.source_round_id:i.run_id===row.id);
      sources.push({...formal?{formalReview:{id:formal.job.id,state:formal.job.state,resultHash:reviewHash(formal.results)},formalEvidence:formal.input.evidence}:{},roundId:row.source_round_id??null,roundNumber:row.source_round_number??null,runId:row.id??null,
        label:row.source_round_number?`第 ${row.source_round_number} 轮`:'历史检查（无业务轮次）',state:row.state??row.source_round_state,validity:row.validity??'stale',
        snapshot:row.snapshot??null,configuration,results:[...(row.results??[]),...(formal?.findings??[])] as any,
        issues:ownIssues.map(i=>({id:i.id,ruleId:i.rule_id,scopeId:i.scope_id,status:i.status})),
        replies:replies.filter(r=>ownIssues.some(i=>i.id===r.issue_id)).map(r=>({id:r.id,issueId:r.issue_id,text:r.details.text,
          externalAuthor:r.details.externalAuthor,receivedAt:r.details.receivedAt}))});
    }
    const docs=(await db.query('SELECT id,filename FROM business.document_versions WHERE case_id=$1',[caseId])).rows;
    const names=Object.fromEntries(docs.map(d=>[d.id,d.filename]));
    const caseRow=(await db.query('SELECT title,reference FROM business.cases WHERE id=$1',[caseId])).rows[0];
    const caseLabel=caseRow?.reference?.trim()||caseRow?.title?.trim()||'预审案件';
    // Reuse the user's saved comparison confirmations. These are object links,
    // not model conclusions; no name matching or new business-round model.
    const confirmations=(await db.query(`SELECT j.person_id,j.auth_version,p.auth_version AS current_auth,p.enabled,p.must_change,s.body,s.body_hash
      FROM business.review_analysis_jobs j JOIN business.review_analysis_snapshots s ON s.job_id=j.id
      JOIN business.principals p ON p.account_id=j.account_id AND p.person_id=j.person_id
      WHERE j.case_id=$1 AND j.kind='comparison' AND j.state IN ('ready','partial') ORDER BY j.created_at DESC,j.id DESC`,[caseId])).rows;
    const pairs:Array<{before:string;after:string}>=[],seenPairs=new Set<string>();
    for(const confirmation of confirmations){const input=confirmation.body;
      if(!Array.isArray(input.runIds)||input.runIds.length!==2||!input.runIds.every((id:string)=>runIds.includes(id)))continue;
      if(reviewHash(input)!==confirmation.body_hash)throw new AppError(409,'delivery_integrity_failed');
      if(!confirmation.enabled||confirmation.must_change||confirmation.auth_version!==confirmation.current_auth||
        !await hasGrant(db,confirmation.person_id,'review:analyze',caseId)||!await hasGrant(db,confirmation.person_id,'evidence:read',caseId))continue;
      const pairKey=JSON.stringify(input.runIds);if(seenPairs.has(pairKey))continue;seenPairs.add(pairKey);pairs.push(...input.objectPairs);
    }
    const aliases=mailObjectAliases(sources,pairs);
    // Track replies and dispositions even when they are intentionally omitted from external copy.
    return {selected,sources,names,caseLabel,aliases,sourceHash:reviewHash({caseLabel,sources,aliases,names:docs.filter(d=>sources.some(s=>s.snapshot?.materials.some(m=>m.documentVersionId===d.id))).sort((a,b)=>a.id.localeCompare(b.id)),replyIds:[...replyIds].sort()})};
  }
  async checkerMailCurrent(db:DB,c:any,id:string){
    const row=(await db.query('SELECT * FROM business.review_mail_drafts WHERE id=$1 AND case_id=$2',[id,c.id])).rows[0];
    return !!row&&(await this.draftStatus(db,c,row)).validity==='current';
  }
  private async draftStatus(db:DB,c:any,row:any):Promise<Pick<MailDraft,'validity'|'staleReasons'|'checkerConfirmation'|'checkerPending'>>{
    const reasons:string[]=[];
    try{const source=await this.source(db,c.id,row.run_id,row.included_reply_ids);
      if(source.selected.validity!=='current'||source.selected.state!=='ready')reasons.push('审核结果已失效或未完成');
      if(source.sourceHash!==row.source_hash)reasons.push('检查结果、问题处置或外部回复已有更新');
    }catch(error){if(!(error instanceof AppError))throw error;reasons.push('来源记录暂不可核验');}
    if(reasons.length)return {validity:'stale',staleReasons:reasons};
    const latest=(await db.query('SELECT id FROM business.review_runs WHERE case_id=$1 AND round_id IS NOT DISTINCT FROM $2::uuid ORDER BY created_at DESC,id DESC LIMIT 1',[c.id,c.current_round_id??null])).rows[0];
    const validity=(row.round_id??null)===(c.current_round_id??null)&&latest?.id===row.run_id?'current' as const:'history' as const;
    const confirmation=(await db.query("SELECT id,number,decided_at,validity FROM business.checker_submissions WHERE case_id=$1 AND state='confirmed' AND snapshot->'mail'->>'id'=$2 AND snapshot->'mail'->>'body_hash'=$3 ORDER BY number DESC LIMIT 1",[c.id,row.id,row.body_hash])).rows[0];
    const pending=validity==='current'?(await db.query("SELECT id,number,created_at FROM business.checker_submissions WHERE case_id=$1 AND state='submitted' AND validity='current' AND snapshot->'mail'->>'id'=$2 AND snapshot->'mail'->>'body_hash'=$3 ORDER BY number DESC LIMIT 1",[c.id,row.id,row.body_hash])).rows[0]:null;
    return {validity,staleReasons:[],...(pending?{checkerPending:{submissionId:pending.id,submissionNumber:pending.number,submittedAt:iso(pending.created_at)}}:{}),...(confirmation?{checkerConfirmation:{submissionId:confirmation.id,submissionNumber:confirmation.number,confirmedAt:iso(confirmation.decided_at),validity:confirmation.validity==='current'&&validity==='current'?'current' as const:'history' as const}}:{})};
  }
  async state(actor:Actor,caseId:string):Promise<DeliveryState>{return transaction(this.pool,async db=>{
    const c=await authorizeCase(db,actor,caseId,'case:read',false),allowedActions:string[]=[];
    if(await hasGrant(db,actor.personId,'evidence:read',caseId))for(const a of outputActions)if(await hasGrant(db,actor.personId,a,caseId)&&
      (a!=='report:generate'||!c.closed_at&&await canEditReview(db,c,actor.personId)))allowedActions.push(a);
    if((await db.query("SELECT 1 FROM business.checker_submissions WHERE case_id=$1 AND state='submitted' AND validity='current' LIMIT 1",[caseId])).rowCount){const i=allowedActions.indexOf('report:generate');if(i>=0)allowedActions.splice(i,1);}
    const runs=(await db.query(`SELECT r.id,r.round_id,q.number,r.state,r.validity,r.created_at FROM business.review_runs r
      LEFT JOIN business.review_rounds q ON q.id=r.round_id WHERE r.case_id=$1 ORDER BY r.created_at DESC,r.id DESC LIMIT 100`,[caseId])).rows.map(r=>({id:r.id,roundId:r.round_id,roundNumber:r.number,state:r.state,validity:r.validity,createdAt:iso(r.created_at)}));
    const drafts:DeliveryState['drafts']=[];
    if(allowedActions.includes('report:read'))for(const row of (await db.query('SELECT * FROM business.review_mail_drafts WHERE case_id=$1 ORDER BY version DESC LIMIT 50',[caseId])).rows){
      drafts.push({id:row.id,caseId,runId:row.run_id,roundId:row.round_id,version:row.version,format:row.format,createdAt:iso(row.created_at),...await this.draftStatus(db,c,row)});
    }
    const replies=allowedActions.includes('report:generate')&&allowedActions.includes('report:read')?(await db.query(`SELECT id,issue_id,round_id,details FROM business.review_events
      WHERE case_id=$1 AND kind='external_reply' ORDER BY created_at DESC,id DESC LIMIT 1000`,[caseId])).rows.map(r=>({id:r.id,issueId:r.issue_id,roundId:r.round_id,text:r.details.text,externalAuthor:r.details.externalAuthor,receivedAt:r.details.receivedAt})):[];
    return {caseId,revision:c.revision,allowedActions,runs,drafts,replies};
  });}
  async generateMail(actor:Actor,caseId:string,raw:unknown){const input=MailCommandSchema.parse(raw);return transaction(this.pool,async db=>{
    const c=await this.authorize(db,actor,caseId,'report:generate',true);
    if(!await hasGrant(db,actor.personId,'report:read',caseId))throw new AppError(403,'permission_denied');
    return idempotent(db,actor,`review.mail:${caseId}`,input.idempotencyKey,input,async()=>{
      if(c.revision!==input.expectedRevision)throw new AppError(409,'stale_revision');
      const {selected,sources,names,caseLabel,sourceHash,aliases}=await this.source(db,caseId,input.runId,input.replyIds);
      if(selected.state!=='ready'||selected.validity!=='current')throw new AppError(409,'delivery_result_not_ready');
      const body=buildMail(caseLabel,sources,new Set(input.replyIds),names,aliases);
      const version=Number((await db.query('SELECT coalesce(max(version),0)+1 AS next FROM business.review_mail_drafts WHERE case_id=$1',[caseId])).rows[0].next),id=randomUUID();
      await db.query(`INSERT INTO business.review_mail_drafts(id,case_id,run_id,round_id,version,format,source_hash,body,body_hash,included_reply_ids,created_by)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,[id,caseId,input.runId,selected.round_id,version,input.format,sourceHash,JSON.stringify(body),reviewHash(body),input.replyIds,actor.personId]);
      await invalidateCheckerContent(db,caseId);
      await db.query("INSERT INTO business.contributions(id,case_id,person_id,kind) VALUES($1,$2,$3,$4)",[randomUUID(),caseId,actor.personId,checkerCorrectionActive(c,actor.personId)?'checker_correction':'mail_preparation']);
      await audit(db,{actorId:actor.accountId,targetId:caseId,action:'review.mail_generated',details:{draftId:id,version,runId:input.runId,format:input.format}});
      return {id,version};
    });
  });}
  async mail(actor:Actor,caseId:string,id:string):Promise<MailDraft>{return transaction(this.pool,async db=>{
    const c=await this.authorize(db,actor,caseId,'report:read'),row=(await db.query('SELECT * FROM business.review_mail_drafts WHERE id=$1 AND case_id=$2',[id,caseId])).rows[0];
    if(!row)throw new AppError(404,'delivery_draft_not_found');if(reviewHash(row.body)!==row.body_hash)throw new AppError(409,'delivery_integrity_failed');
    return {id,caseId,runId:row.run_id,roundId:row.round_id,version:row.version,format:row.format,createdAt:iso(row.created_at),body:row.body,
      includedReplyIds:row.included_reply_ids,canCopy:await hasGrant(db,actor.personId,'report:export',caseId),...await this.draftStatus(db,c,row)};
  });}
  async copyMail(actor:Actor,caseId:string,id:string){
    const draft=await this.mail(actor,caseId,id);
    return transaction(this.pool,async db=>{await this.authorize(db,actor,caseId,'report:export');await this.authorize(db,actor,caseId,'report:read');
      const current=await this.draftStatus(db,(await db.query('SELECT * FROM business.cases WHERE id=$1',[caseId])).rows[0],(await db.query('SELECT * FROM business.review_mail_drafts WHERE id=$1 AND case_id=$2',[id,caseId])).rows[0]);
      const body={...draft.body,notice:[current.validity==='stale'?'历史草稿：来源已有更新，仅供回查。':current.validity==='history'?'历史轮次草稿，仅适用于所列轮次。':'',draft.body.notice].filter(Boolean).join('\n')};
      await audit(db,{actorId:actor.accountId,targetId:caseId,action:'review.mail_copied',details:{draftId:id,validity:current.validity}});
      return {...mailContent(body,draft.format),validity:current.validity};
    });
  }
}

export function registerReviewDeliveryRoutes(app:FastifyInstance,auth:Auth,service:ReviewDeliveryService){
  const base='/api/cases/:caseId/review-delivery',params=(r:any)=>z.object({caseId:z.uuid(),id:z.uuid().optional()}).parse(r.params);
  app.get(base,async request=>service.state(await auth.requireSession(request),params(request).caseId));
  app.post(`${base}/mail`,async(request,reply)=>reply.code(201).send(await service.generateMail(await auth.checkWrite(request),params(request).caseId,request.body)));
  app.get(`${base}/mail/:id`,async request=>{const p=params(request);return service.mail(await auth.requireSession(request),p.caseId,p.id!);});
  app.post(`${base}/mail/:id/copy`,async request=>{const p=params(request);return service.copyMail(await auth.checkWrite(request),p.caseId,p.id!);});
}
