import {randomUUID} from 'node:crypto';
import {suppliedFieldValues} from '../review/field-supply.js';
import type {FastifyInstance} from 'fastify';
import type {Pool,PoolClient} from 'pg';
import {z} from 'zod';
import {ApplyCaseAssistProposalSchema,CancelCaseAssistProposalSchema,CaseAssistLegalOutputSchema,CaseAssistModelOutputSchema,CaseAssistTurnRequestSchema,
  type CaseAssistCard,type CaseAssistFieldValueBody,type CaseAssistProposalView,type CaseAssistTarget,type CaseAssistTurnView,type CaseAssistantState,type CaseAssistIntent} from '@hsbc/contracts/case-assistant';
import {guidanceTextKey,type SemanticGuidanceBody} from '@hsbc/contracts/review-guidance';
import type {ModelResult} from '@hsbc/contracts/model';
import {AppError} from '../../shared/errors.js';
import {audit} from '../audit/events.js';
import {authorizeCase} from '../cases/authorization.js';
import {transaction,type DB} from '../../infrastructure/database/client.js';
import type {Actor} from '../identity/types.js';
import type {Auth} from '../identity/auth.js';
import type {ClaimedWork} from '../../infrastructure/jobs/types.js';
import type {NerClient} from '../../infrastructure/integrations/inference.js';
import {ModelExecutionError} from '../../model/gateway.js';
import {reviewHash,type ReviewService} from '../review/service.js';
import {getPublished} from '../review/configuration.js';
import {guidanceRefs,loadCaseGuidance,validateGuidanceBody} from '../review/guidance.js';
import {reserveMicros} from '../intake/config.js';
import {evidenceFromBundle} from '../review-delivery/semantic.js';
import {runCaseAssistant} from '../../agents/case-assistant/runner.js';
import {caseAssistCapability,caseAssistProfileHash,type CaseAssistConfig} from './config.js';
import {CASE_ASSIST_DOCUMENT_BLOCK,buildCaseAssistContext,caseAssistBlocks,rowStatus,type CaseAssistContext,type CaseAssistHistoryTurn} from './context.js';
import {documentQuotes,locateQuote,openDocument,sourceQuote,type CaseAssistDocumentReader} from './document.js';
import {LEGAL_BASELINE_DRAFT,legalBlocks,legalMaterials,legalReply,type LegalContext} from './legal-opinion.js';

type TurnRow={id:string;conversation_id:string;case_id:string;client_turn_id:string;mode:'chat'|'legal_opinion';text:string;page:unknown;context:CaseAssistContext&{legal?:LegalContext};context_hash:string;
  account_id:string;person_id:string;auth_version:number;session_key:string|null;case_revision:number;round_id:string|null;state:CaseAssistTurnView['state'];reply:CaseAssistTurnView['reply'];error_code:string|null;created_at:Date};
const iso=(v:Date|string)=>new Date(v).toISOString();
const actorOf=(t:TurnRow):Actor=>({accountId:t.account_id,personId:t.person_id,authVersion:t.auth_version,...(t.session_key?{sessionKey:t.session_key}:{})});
const clip=(value:string,size:number)=>value.length>size?value.slice(0,size):value;
const PROPOSAL_TTL_MINUTES=120;
const proposalStateLabels:Record<string,string>={pending:'待确认',applied:'已记为本案规则',canceled:'未采用',superseded:'已被后面的建议替代',stale:'已失效',expired:'已过期'};

export class CaseAssistantService {
  private active=new Set<AbortController>();private stopping=false;
  constructor(readonly pool:Pool,readonly reviews:Pick<ReviewService,'state'|'checklist'|'saveGuidance'|'supplyFieldValue'>,readonly config?:CaseAssistConfig,
    readonly options:{fetcher?:typeof fetch;ner?:Pick<NerClient,'entities'>;documents?:CaseAssistDocumentReader}={}){}
  stop(){this.stopping=true;for(const c of this.active)c.abort();}
  capability(){return caseAssistCapability(this.config);}

  /** Cloud egress is limited to listed cases or cases bound to a synthetic-scope configuration. */
  private async availability(db:DB,c:any):Promise<{available:boolean;reason:string|null}>{
    const base=caseAssistCapability(this.config);if(!base.available)return {available:false,reason:base.reason};
    const scope=this.config!.policy.caseScope;
    if(scope.kind==='listed')return scope.caseIds.includes(c.id)?{available:true,reason:null}:{available:false,reason:'case_assistant_case_not_authorized'};
    if(!c.configuration_release_id)return {available:false,reason:'review_configuration_required'};
    const release=(await db.query("SELECT manifest->>'scope' AS scope FROM business.review_config_releases WHERE release_id=$1",[c.configuration_release_id])).rows[0];
    return release?.scope==='synthetic'?{available:true,reason:null}:{available:false,reason:'case_assistant_case_not_authorized'};
  }
  private turnView(r:TurnRow&{round_number?:number|null}):CaseAssistTurnView{
    return {id:r.id,clientTurnId:r.client_turn_id,mode:r.mode,text:r.text,state:r.state,createdAt:iso(r.created_at),caseRevision:r.case_revision,roundId:r.round_id,roundNumber:r.round_number??null,reply:r.reply,errorCode:r.error_code};
  }
  private proposalView(p:any):CaseAssistProposalView{
    const expired=p.state==='pending'&&Date.parse(iso(p.expires_at))<=Date.now();
    return {id:p.id,state:expired?'expired':p.state,kind:p.kind,body:p.body,contentHash:p.content_hash,caseRevision:p.case_revision,expiresAt:iso(p.expires_at),guidanceId:p.guidance_id,notes:p.notes??[]};
  }
  private async view(db:DB,actor:Actor,c:any):Promise<CaseAssistantState>{
    const a=await this.availability(db,c);
    const conversation=(await db.query('SELECT id FROM business.case_assistant_conversations WHERE case_id=$1 AND person_id=$2',[c.id,actor.personId])).rows[0];
    const turns=conversation?(await db.query(`SELECT * FROM (SELECT t.*,r.number AS round_number FROM business.case_assistant_turns t LEFT JOIN business.review_rounds r ON r.id=t.round_id
      WHERE t.conversation_id=$1 ORDER BY t.created_at DESC,t.id DESC LIMIT 30) x ORDER BY created_at,id`,[conversation.id])).rows:[];
    // Every card of a shown message is read, however many proposals the conversation has collected since.
    const proposals=conversation&&turns.length?(await db.query('SELECT * FROM business.case_assistant_proposals WHERE conversation_id=$1 AND turn_id=ANY($2::uuid[]) ORDER BY created_at DESC',[conversation.id,turns.map(t=>t.id)])).rows:[];
    // Whether a filled value is still in place is read from the review record, so the card shows the same after a reload.
    const supplied=new Map<string|null,Awaited<ReturnType<typeof suppliedFieldValues>>>();
    for(const p of proposals)if(p.kind==='field_value'&&p.state==='applied'&&!supplied.has(p.round_id??null))supplied.set(p.round_id??null,await suppliedFieldValues(db,c.id,p.round_id??null));
    const inPlace=(p:any)=>p.kind==='field_value'&&p.state==='applied'?{inPlace:Boolean(supplied.get(p.round_id??null)?.some(v=>v.documentId===p.body.documentId&&v.fieldId===p.body.fieldId&&v.value===p.body.value))}:{};
    return {caseId:c.id,available:a.available,reason:a.reason,model:a.available?this.config!.model:null,conversationId:conversation?.id??null,
      turns:turns.map(t=>this.turnView(t)),proposals:proposals.map(p=>({...this.proposalView(p),...inPlace(p)}) as CaseAssistProposalView),allowedActions:a.available&&!c.closed_at?['assistant:ask']:[]};
  }
  async state(actor:Actor,caseId:string):Promise<CaseAssistantState>{return transaction(this.pool,async db=>this.view(db,actor,await authorizeCase(db,actor,caseId,'evidence:read',false)));}

  private async existing(db:DB,caseId:string,actor:Actor,input:z.infer<typeof CaseAssistTurnRequestSchema>){
    const row=(await db.query(`SELECT t.* FROM business.case_assistant_turns t JOIN business.case_assistant_conversations c ON c.id=t.conversation_id
      WHERE c.case_id=$1 AND c.person_id=$2 AND t.client_turn_id=$3`,[caseId,actor.personId,input.clientTurnId])).rows[0] as TurnRow|undefined;
    if(row&&(row.text!==input.text||row.mode!==input.mode))throw new AppError(409,'assistant_turn_conflict');
    return row;
  }
  /** Context is read through the review service with the sender's own authorization, then frozen. */
  async createTurn(actor:Actor,caseId:string,raw:unknown):Promise<CaseAssistTurnView>{
    const input=CaseAssistTurnRequestSchema.parse(raw);
    const replay=await transaction(this.pool,async db=>{
      const c=await authorizeCase(db,actor,caseId,'evidence:read',false);const old=await this.existing(db,caseId,actor,input);if(old)return old;
      if(c.closed_at)throw new AppError(409,'case_closed');const a=await this.availability(db,c);if(!a.available)throw new AppError(409,a.reason!);
      return null;
    });
    if(replay)return this.turnView(replay);
    const roundId=input.page.roundId??undefined;
    const [state,checklist]=await Promise.all([this.reviews.state(actor,caseId,roundId),this.reviews.checklist(actor,caseId,roundId)]);
    return transaction(this.pool,async db=>{
      const c=await authorizeCase(db,actor,caseId,'evidence:read',true);
      const old=await this.existing(db,caseId,actor,input);if(old)return this.turnView(old);
      const a=await this.availability(db,c);if(!a.available)throw new AppError(409,a.reason!);
      const release=state.configurationReleaseId?await getPublished(db,state.configurationReleaseId):null;
      const conversation=(await db.query(`INSERT INTO business.case_assistant_conversations(id,case_id,person_id,account_id) VALUES($1,$2,$3,$4)
        ON CONFLICT(case_id,person_id) DO UPDATE SET updated_at=now() RETURNING id`,[randomUUID(),caseId,actor.personId,actor.accountId])).rows[0].id as string;
      // A message nobody picked up, or whose processing lost its lease long ago, must not lock the conversation for good.
      await this.abandonStaleTurns(db,conversation);
      if((await db.query("SELECT 1 FROM business.case_assistant_turns WHERE conversation_id=$1 AND state IN ('pending','running')",[conversation])).rowCount)throw new AppError(409,'assistant_turn_active');
      if(Number((await db.query("SELECT count(*) AS n FROM business.case_assistant_turns WHERE person_id=$1 AND created_at>now()-interval '10 minutes'",[actor.personId])).rows[0].n)>=20)throw new AppError(429,'assistant_rate_limited');
      const history=await this.history(db,conversation);
      // The open file is read here, with the sender's access, and frozen with the turn like every other input.
      const document=input.mode==='chat'&&input.page.documentId&&this.options.documents
        ?await openDocument(db,actor,caseId,input.page.documentId,state,checklist,this.options.documents,evidenceFromBundle):undefined;
      const context:CaseAssistContext&{legal?:LegalContext}=buildCaseAssistContext({caseLabel:c.case_number??'当前案件',state,checklist,refs:release?guidanceRefs(release.manifest,state.guidance):[],page:input.page,history,
        ...(document?{document}:{})});
      if(input.mode==='legal_opinion'){
        if(!this.options.documents)throw new AppError(409,'assistant_legal_unavailable');
        context.legal=await legalMaterials(db,actor,caseId,state,this.options.documents,evidenceFromBundle);
      }
      const id=randomUUID(),workId=randomUUID();
      const row=(await db.query(`INSERT INTO business.case_assistant_turns(id,conversation_id,case_id,client_turn_id,mode,text,page,context,context_hash,account_id,person_id,auth_version,session_key,case_revision,round_id,state)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,'pending') RETURNING *`,[id,conversation,caseId,input.clientTurnId,input.mode,input.text,JSON.stringify(input.page),JSON.stringify(context),reviewHash(context),
        actor.accountId,actor.personId,actor.authVersion,actor.sessionKey??null,c.revision,checklist.roundId])).rows[0] as TurnRow;
      await db.query("INSERT INTO business.work_items(id,owner_type,owner_id,kind,queue,max_attempts) VALUES($1,'Workflow',$2,'case_assist','workflow',1)",[workId,id]);
      await db.query("INSERT INTO business.outbox(id,work_item_id,event_type,owner_id) VALUES($1,$2,'case_assist_requested',$3)",[randomUUID(),workId,id]);
      await audit(db,{actorId:actor.accountId,targetId:caseId,action:'case_assistant.turn_created',details:{turnId:id,mode:input.mode,caseRevision:c.revision}});
      return this.turnView(row);
    });
  }

  /** The last answered turns, with the fields each one pointed at and any rule it proposed. */
  private async history(db:DB,conversation:string):Promise<CaseAssistHistoryTurn[]>{
    const turns=(await db.query("SELECT id,text,reply FROM business.case_assistant_turns WHERE conversation_id=$1 AND state='ready' ORDER BY created_at DESC,id DESC LIMIT 6",[conversation])).rows.reverse();
    if(!turns.length)return [];
    const proposals=new Map<string,{state:string;statement:string|null}>((await db.query(`SELECT turn_id,CASE WHEN state='pending' AND expires_at<=now() THEN 'expired' ELSE state END AS state,body->>'statement' AS statement
      FROM business.case_assistant_proposals WHERE turn_id=ANY($1::uuid[]) AND kind='guidance'`,[turns.map(r=>r.id)])).rows.map(r=>[r.turn_id,r]));
    return turns.map(r=>{
      const cards=(r.reply?.cards??[]) as CaseAssistCard[],proposal=proposals.get(r.id);
      const targets=[...new Set(cards.flatMap(card=>card.kind==='targets'||card.kind==='choices'?card.items.map(item=>item.rowId):[]))].slice(0,5);
      return {user:r.text as string,assistant:(r.reply?.text as string|undefined)??'',...(targets.length?{targets}:{}),
        ...(proposal?.statement?{proposal:`${proposal.statement}（${proposalStateLabels[proposal.state]??proposal.state}）`}:{})};
    });
  }
  private async proposal(db:DB,actor:Actor,caseId:string,id:string){
    const p=(await db.query(`SELECT p.*,c.person_id FROM business.case_assistant_proposals p JOIN business.case_assistant_conversations c ON c.id=p.conversation_id WHERE p.id=$1 AND p.case_id=$2`,[id,caseId])).rows[0];
    if(!p||p.person_id!==actor.personId)throw new AppError(404,'assistant_proposal_not_found');return p;
  }
  /** Saves through the review command; the proposal is consumed in that same transaction. */
  async applyProposal(actor:Actor,caseId:string,id:string,raw:unknown):Promise<CaseAssistantState>{
    const input=ApplyCaseAssistProposalSchema.parse(raw);
    const p=await transaction(this.pool,async db=>{await authorizeCase(db,actor,caseId,'evidence:read',false);return this.proposal(db,actor,caseId,id);});
    const replay=p.state==='applied';
    if(!replay){
      if(p.state!=='pending')throw new AppError(409,'assistant_proposal_not_pending');
      if(Date.parse(iso(p.expires_at))<=Date.now())throw new AppError(409,'assistant_proposal_expired');
    }
    if(p.content_hash!==input.contentHash)throw new AppError(409,'assistant_proposal_changed');
    const consume=async(db:PoolClient,c:any,guidanceId:string|null)=>{
      if(c.configuration_release_id!==p.configuration_release_id)throw new AppError(409,'assistant_proposal_stale');
      const updated=await db.query("UPDATE business.case_assistant_proposals SET state='applied',guidance_id=$2,decided_by=$3,decided_at=now() WHERE id=$1 AND state='pending' AND expires_at>now() AND content_hash=$4 RETURNING id",[p.id,guidanceId,actor.personId,input.contentHash]);
      if(!updated.rowCount)throw new AppError(409,'assistant_proposal_not_pending');
      await audit(db,{actorId:actor.accountId,targetId:caseId,action:'case_assistant.proposal_applied',details:{proposalId:p.id,kind:p.kind,...(guidanceId?{guidanceId}:{})}});
    };
    const command={expectedRevision:input.expectedRevision,idempotencyKey:input.idempotencyKey,...(p.round_id?{roundId:p.round_id}:{})};
    let save:()=>Promise<unknown>;
    if(p.kind==='field_value'){
      // The review command re-checks the file, the passage and that the field is still empty.
      const value=p.body as CaseAssistFieldValueBody;
      save=()=>this.reviews.supplyFieldValue(actor,caseId,{...command,reason:'经案件助手找到并由经办人确认的字段取值',documentId:value.documentId,fieldId:value.fieldId,value:value.value,quote:value.quote,evidence:value.evidence,...(value.replaces?.length?{replace:true}:{})},
        {origin:'assistant',within:(db,c)=>consume(db,c,null)});
    }else{
      const body=p.body as SemanticGuidanceBody&{quote:string;replaces:string|null};
      save=()=>this.reviews.saveGuidance(actor,caseId,{...command,reason:'经案件助手确认的判断口径',
        kind:body.kind,statement:input.statement??body.statement,fieldIds:body.fieldIds,expressions:body.expressions,quote:body.quote,...(body.replaces?{replaces:body.replaces}:{})},
        {origin:{kind:'assistant',quote:body.quote,proposalId:p.id},within:consume});
    }
    // An applied proposal only answers a replay of the original command.
    if(replay)try{await save();}catch(error){if(error instanceof AppError)throw new AppError(409,'assistant_proposal_not_pending');throw error;}
    else await save();
    return this.state(actor,caseId);
  }
  async cancelProposal(actor:Actor,caseId:string,id:string,raw:unknown):Promise<CaseAssistantState>{
    CancelCaseAssistProposalSchema.parse(raw);
    return transaction(this.pool,async db=>{
      const c=await authorizeCase(db,actor,caseId,'evidence:read',true),p=await this.proposal(db,actor,caseId,id);
      if(p.state==='pending')await db.query("UPDATE business.case_assistant_proposals SET state='canceled',decided_by=$2,decided_at=now() WHERE id=$1 AND state='pending'",[id,actor.personId]);
      else if(p.state!=='canceled')throw new AppError(409,'assistant_proposal_not_pending');
      return this.view(db,actor,c);
    });
  }

  /** Pending for two minutes without being claimed, or running with a lease that expired two minutes ago, means nothing is
   * working on the message. It is marked failed so the sender can ask again; a late worker is fenced by the state check. */
  private async abandonStaleTurns(db:DB,conversationId:string){
    const stale=(await db.query(`UPDATE business.case_assistant_turns t SET state='failed',error_code='assistant_turn_abandoned',updated_at=now()
      WHERE t.conversation_id=$1 AND t.state IN ('pending','running') AND NOT EXISTS(SELECT 1 FROM business.work_items w WHERE w.owner_type='Workflow' AND w.kind='case_assist' AND w.owner_id=t.id
        AND (w.state='pending' AND w.created_at>now()-interval '2 minutes' OR w.state='running' AND w.lease_until>now()-interval '2 minutes')) RETURNING t.id`,[conversationId])).rows.map(r=>r.id as string);
    if(stale.length)await db.query("UPDATE business.work_items SET state='canceled',epoch=epoch+1,lease_until=NULL,updated_at=now() WHERE owner_type='Workflow' AND kind='case_assist' AND owner_id=ANY($1::uuid[]) AND state IN ('pending','running')",[stale]);
  }
  /** The sender stops waiting for a message that has not been answered yet. A reply that arrives afterwards is discarded. */
  async cancelTurn(actor:Actor,caseId:string,turnId:string):Promise<CaseAssistantState>{
    return transaction(this.pool,async db=>{
      const c=await authorizeCase(db,actor,caseId,'evidence:read',true);
      const turn=(await db.query('SELECT state,person_id FROM business.case_assistant_turns WHERE id=$1 AND case_id=$2 FOR UPDATE',[turnId,caseId])).rows[0];
      if(!turn||turn.person_id!==actor.personId)throw new AppError(404,'assistant_turn_not_found');
      if(['pending','running'].includes(turn.state)){
        await db.query("UPDATE business.case_assistant_turns SET state='canceled',error_code='assistant_turn_canceled',updated_at=now() WHERE id=$1",[turnId]);
        await db.query("UPDATE business.work_items SET state='canceled',epoch=epoch+1,lease_until=NULL,updated_at=now() WHERE owner_type='Workflow' AND kind='case_assist' AND owner_id=$1 AND state IN ('pending','running')",[turnId]);
      }
      return this.view(db,actor,c);
    });
  }
  async claim(workId?:string):Promise<ClaimedWork|undefined>{
    if(this.stopping)return;
    return (await this.pool.query(`UPDATE business.work_items SET state='running',epoch=epoch+1,attempts=attempts+1,lease_until=now()+interval '180 seconds',updated_at=now()
      WHERE id=(SELECT w.id FROM business.work_items w JOIN business.case_assistant_turns t ON t.id=w.owner_id WHERE w.owner_type='Workflow' AND w.kind='case_assist'
      AND t.state IN ('pending','running') AND w.available_at<=now() AND (w.state='pending' OR w.state='running' AND w.lease_until<now()) AND ($1::uuid IS NULL OR w.id=$1)
      ORDER BY w.available_at,w.id FOR UPDATE OF w SKIP LOCKED LIMIT 1) RETURNING *`,[workId??null])).rows[0];
  }
  private async fence(db:PoolClient,t:TurnRow,work:ClaimedWork){
    if(this.stopping)throw new AppError(409,'worker_stopping');
    const c=await authorizeCase(db,actorOf(t),t.case_id,'evidence:read',true),a=await this.availability(db,c);
    if(!a.available)throw new AppError(409,a.reason!);
    const row=(await db.query("SELECT id FROM business.case_assistant_turns WHERE id=$1 AND state IN ('pending','running') FOR UPDATE",[t.id])).rows[0];
    if(!row)throw new AppError(409,'assistant_turn_canceled');
    if(!(await db.query("SELECT id FROM business.work_items WHERE id=$1 AND owner_id=$2 AND epoch=$3 AND state='running' AND lease_until>now() FOR UPDATE",[work.id,t.id,work.epoch])).rowCount)throw new AppError(409,'lease_lost');
    return c;
  }
  async processWork(work:ClaimedWork){
    const t=(await this.pool.query('SELECT * FROM business.case_assistant_turns WHERE id=$1',[work.owner_id])).rows[0] as TurnRow|undefined;if(!t)return;
    const controller=new AbortController();this.active.add(controller);let callId:string|undefined;
    const timer=setInterval(()=>{void this.pool.query("UPDATE business.work_items SET lease_until=now()+interval '180 seconds' WHERE id=$1 AND epoch=$2 AND state='running' AND lease_until>now() RETURNING id",[work.id,work.epoch]).then(r=>{if(!r.rowCount)controller.abort();}).catch(()=>controller.abort());},30000);timer.unref();
    try{
      await transaction(this.pool,async db=>{
        await this.fence(db,t,work);
        if(reviewHash(t.context)!==t.context_hash)throw new AppError(409,'assistant_context_corrupt');
        // A recorded call is never resent: its result is either unknown or was already returned.
        if((await db.query('SELECT 1 FROM business.case_assistant_calls WHERE turn_id=$1',[t.id])).rowCount)throw new ModelExecutionError('execution_unknown');
        await db.query("UPDATE business.case_assistant_turns SET state='running',updated_at=now() WHERE id=$1",[t.id]);
      });
      const config=this.config!;
      const blocks=t.mode==='legal_opinion'?legalBlocks(t.context,t.text):caseAssistBlocks(t.context,t.text);
      // Only whole passages of the open file may be left out when they cannot be protected.
      const isolatable=t.mode==='chat'?blocks.filter(b=>CASE_ASSIST_DOCUMENT_BLOCK.test(b.id)).map(b=>b.id):[];
      await runCaseAssistant({job:{id:t.id,case_id:t.case_id,case_revision:t.case_revision,auth_version:t.auth_version},mode:t.mode,config,signal:controller.signal,fetcher:this.options.fetcher,ner:this.options.ner,blocks,isolatable,
        hooks:{
          authorize:()=>transaction(this.pool,async db=>{await this.fence(db,t,work);}),
          reserve:payload=>transaction(this.pool,async db=>{
            await this.fence(db,t,work);controller.signal.throwIfAborted();
            await db.query('SELECT pg_advisory_xact_lock(hashtext($1))',[`case-assist-budget:${config.policy.budgetId}`]);
            if((await db.query('SELECT 1 FROM business.case_assistant_calls WHERE turn_id=$1',[t.id])).rowCount)throw new ModelExecutionError('execution_unknown');
            let reserved:number;try{reserved=reserveMicros(config,Buffer.byteLength(payload.body));}catch(error){
              if(error instanceof Error&&['input_budget_exhausted','call_budget_exhausted'].includes(error.message))throw new ModelExecutionError(error.message as 'input_budget_exhausted'|'call_budget_exhausted');throw error;
            }
            // Purpose-bound accounting lives in this ledger only; the shared intake budget table
            // is reconciled against intake calls and must not carry assistant reservations.
            const totals=(await db.query(`SELECT coalesce(sum(reserved_micros),0)::text AS total,
              coalesce(sum(reserved_micros) FILTER (WHERE (created_at AT TIME ZONE 'UTC')::date=(now() AT TIME ZONE 'UTC')::date),0)::text AS today,
              count(*) FILTER (WHERE created_at>now()-interval '1 minute')::int AS recent FROM business.case_assistant_calls WHERE policy_hash=$1`,[reviewHash(config.policy)])).rows[0];
            if(Number(totals.total)+reserved>config.policy.totalBudgetMicros||Number(totals.today)+reserved>config.dailyBudgetMicros||totals.recent>=config.requestsPerMinute)throw new ModelExecutionError('budget_exhausted');
            callId=randomUUID();
            await db.query("INSERT INTO business.case_assistant_calls(id,turn_id,payload_hash,policy_hash,profile_hash,reserved_micros,state) VALUES($1,$2,$3,$4,$5,$6,'unknown')",[callId,t.id,payload.payloadHash,reviewHash(config.policy),caseAssistProfileHash(config),reserved]);
            await audit(db,{actorId:t.account_id,targetId:t.case_id,action:'case_assistant.egress_reserved',details:{callId,turnId:t.id,payloadHash:payload.payloadHash,reservedMicros:reserved}});
            return {payloadHash:payload.payloadHash,endpoint:config.endpoint,policyVersion:config.policy.version,receiptId:callId};
          }),
          dispatch:async start=>{await transaction(this.pool,async db=>{await this.fence(db,t,work);});controller.signal.throwIfAborted();return start();},
          returned:async returned=>{if(!callId)throw new ModelExecutionError('execution_unknown');await this.pool.query("UPDATE business.case_assistant_calls SET response=$2 WHERE id=$1 AND state='unknown'",[callId,JSON.stringify({returned})]);},
          save:async(result:ModelResult)=>{if(!callId)return;
            if(result.status==='completed')await this.pool.query("UPDATE business.case_assistant_calls SET state='completed',response=coalesce(response,'{}'::jsonb)||$2::jsonb,completed_at=now() WHERE id=$1 AND state='unknown'",[callId,JSON.stringify({usage:result.usage,actualModel:result.actualModel})]);
            else if(result.error.code!=='execution_unknown')await this.pool.query("UPDATE business.case_assistant_calls SET state='failed',response=coalesce(response,'{}'::jsonb)||$2::jsonb,error_code=$3,completed_at=now() WHERE id=$1 AND state='unknown'",[callId,JSON.stringify({result}),result.error.code]);},
        },
        complete:async(restored,sourceRef,withheld)=>{
          const release=t.context.configurationReleaseId?await transaction(this.pool,db=>getPublished(db,t.context.configurationReleaseId!)):null;
          const reply=t.mode==='legal_opinion'?legalReply(t.context.legal,CaseAssistLegalOutputSchema.parse(restored),sourceRef):null;
          await transaction(this.pool,async db=>{
            await this.fence(db,t,work);
            const chat=reply?null:await this.chatReply(db,t,CaseAssistModelOutputSchema.parse(restored),release?.manifest??null,sourceRef,withheld);
            const value=reply??chat!;
            await db.query("UPDATE business.case_assistant_turns SET state='ready',reply=$2,reply_hash=$3,error_code=NULL,updated_at=now() WHERE id=$1",[t.id,JSON.stringify(value),reviewHash(value)]);
            await db.query("UPDATE business.work_items SET state='succeeded',lease_until=NULL,updated_at=now() WHERE id=$1 AND epoch=$2",[work.id,work.epoch]);
            await db.query('INSERT INTO business.inbox(work_item_id,epoch) VALUES($1,$2) ON CONFLICT(work_item_id) DO UPDATE SET epoch=EXCLUDED.epoch,completed_at=now()',[work.id,work.epoch]);
            await audit(db,{actorId:t.account_id,targetId:t.case_id,action:'case_assistant.turn_completed',details:{turnId:t.id,intent:value.intent,cards:value.cards.map(c=>c.kind).join(',')}});
          });
        }});
    }catch(e){
      const code=this.stopping?'worker_stopping':e instanceof AppError||e instanceof ModelExecutionError?e.code:'assistant_failed';
      await transaction(this.pool,async db=>{
        const unknown=(await db.query("SELECT 1 FROM business.case_assistant_calls WHERE turn_id=$1 AND state='unknown'",[t.id])).rowCount;
        const lease=await db.query("UPDATE business.work_items SET state=$3,error_code=$4,lease_until=NULL WHERE id=$1 AND epoch=$2 AND state='running' RETURNING id",[work.id,work.epoch,this.stopping?'pending':'rejected',code]);
        if(lease.rowCount&&!this.stopping)await db.query("UPDATE business.case_assistant_turns SET state=$2,error_code=$3,updated_at=now() WHERE id=$1 AND state IN ('pending','running')",[t.id,unknown||code==='execution_unknown'?'unknown':'failed',unknown?'execution_unknown':code]);
      });
    }finally{clearInterval(timer);this.active.delete(controller);controller.abort();}
  }

  /** Maps refs to frozen rows, validates rule candidates and stores at most one pending proposal. */
  private async chatReply(db:DB,t:TurnRow,output:z.infer<typeof CaseAssistModelOutputSchema>,manifest:Awaited<ReturnType<typeof getPublished>>['manifest']|null,
    sourceRef:(wire:string)=>string,withheld:readonly string[]){
    const context=t.context,notes:string[]=[],cards:CaseAssistCard[]=[];
    const target=(ref:string):CaseAssistTarget|null=>{const row=context.rows.find(r=>r.ref===ref);return row?{rowId:row.rowId,fieldId:row.fieldId,label:row.label,objectLabel:row.objectLabel,status:row.status,roundId:context.roundId,evidence:row.evidence}:null;};
    const targets=output.targets.map(target).filter((v):v is CaseAssistTarget=>!!v);
    if(targets.length<output.targets.length)notes.push('部分字段编号无效，已忽略。');
    let intent:CaseAssistIntent=output.intent;
    if(intent==='clarify'&&output.question&&targets.length)cards.push({kind:'choices',question:output.question,items:targets});
    else if(targets.length)cards.push({kind:'targets',items:targets});
    const quotes=documentQuotes(context.document,output.quotes,sourceRef,notes);if(quotes)cards.push(quotes);
    if(context.document){
      notes.push(...context.document.limitations);
      if(withheld.length)notes.push(`当前文件有 ${withheld.length} 段原文未能通过隐私处理，没有提供给助手。`);
    }
    if(output.ruleCandidate&&intent!=='unsupported'){
      const proposal=await this.ruleProposal(db,t,output.ruleCandidate,manifest,notes);
      if(proposal){intent='feedback_rule';cards.push({kind:'proposal',proposalId:proposal});}
    }
    if(output.fieldValues.length&&intent!=='unsupported'&&intent!=='feedback_rule'){
      const seen=new Set<string>();
      for(const candidate of output.fieldValues){
        if(seen.has(candidate.fieldRef))continue;seen.add(candidate.fieldRef);
        const proposal=await this.fieldValueProposal(db,t,candidate,manifest,sourceRef,notes);
        if(proposal){intent='fill_field';cards.push({kind:'proposal',proposalId:proposal});}
      }
    }
    if(intent==='rule_summary'){
      const active=(await loadCaseGuidance(db,t.case_id)).filter(g=>g.status==='active');
      const pending=(await db.query("SELECT id FROM business.case_assistant_proposals WHERE conversation_id=$1 AND state='pending' AND expires_at>now()",[t.conversation_id])).rows.map(r=>r.id);
      cards.push({kind:'rules',active,releaseCount:context.rules.filter(r=>r.ref.startsWith('G')).length,pendingProposalIds:pending,nextRunLabels:[...context.rules.filter(r=>r.ref.startsWith('G')).map(r=>r.label),...active.map(g=>g.label)]});
    }
    if(intent==='rule_digest')cards.push({kind:'action',action:'rule_digest',label:'整理本案口径并提交规则中心'});
    if(intent==='legal_opinion')cards.push({kind:'action',action:'legal_opinion',label:'生成法律意见书要点'});
    return {intent,text:output.reply,cards,notes};
  }
  /** A value is proposed only for an empty field of the open file, from a passage that contains it verbatim. */
  private async fieldValueProposal(db:DB,t:TurnRow,candidate:z.infer<typeof CaseAssistModelOutputSchema>['fieldValues'][number],manifest:Awaited<ReturnType<typeof getPublished>>['manifest']|null,
    sourceRef:(wire:string)=>string,notes:string[]):Promise<string|null>{
    const context=t.context,document=context.document;
    if(context.readOnly){notes.push('当前轮次只读，不能填入字段。');return null;}
    if(!manifest||!document?.chunks.length){notes.push('需要先在阅读页打开有原文的文件，才能把找到的取值填入字段。');return null;}
    const row=context.rows.find(r=>r.ref===candidate.fieldRef);
    if(!row||!manifest.fields.some(field=>field.id===row.fieldId)){notes.push('要填入的字段编号无效，已忽略。');return null;}
    let local:string|undefined;try{local=sourceRef(candidate.sourceRef);}catch{local=undefined;}
    const chunk=document.chunks.find(c=>c.blockId===local);
    // The quote and the value are cut from the file's own text, so a model's spacing never ends up in a field.
    const quote=chunk?sourceQuote(chunk.text,candidate.quote):null,value=quote?sourceQuote(quote,candidate.value):null;
    if(!chunk||!quote||!value){notes.push('要填入的取值没有逐字出现在当前文件的原文里，已忽略。');return null;}
    candidate={...candidate,quote,value:value.trim()};
    if(/<\/?[a-zA-Z][^>]*>/.test(candidate.value)){notes.push('要填入的取值里带有表格或版式标记，已忽略；请指明要填入的具体文字。');return null;}
    const evidence=locateQuote(chunk,candidate.quote);
    if(!evidence?.anchorId){notes.push('这份文件的原文位置暂不支持直接填入，请在页面原有入口处理。');return null;}
    // A field that already has values is corrected, not filled: the card shows what would be replaced.
    const current=[...new Set(document.fields.filter(field=>context.rows.find(r=>r.rowId===field.rowId)?.fieldId===row.fieldId).flatMap(field=>field.values))];
    if(current.length===1&&current[0]===candidate.value){notes.push(`${row.label}在这份文件里的取值已经是这一项，无需更正。`);return null;}
    const body:CaseAssistFieldValueBody={documentId:document.documentId,filename:document.filename,fieldId:row.fieldId,rowId:row.rowId,fieldLabel:row.label,objectLabel:row.objectLabel,value:candidate.value,quote:candidate.quote,evidence,...(current.length?{replaces:current}:{})};
    const id=randomUUID();
    await db.query("UPDATE business.case_assistant_proposals SET state='superseded',decided_at=now() WHERE conversation_id=$1 AND state='pending' AND kind='field_value' AND turn_id<>$2 AND body->>'documentId'=$3 AND body->>'fieldId'=$4",[t.conversation_id,t.id,body.documentId,body.fieldId]);
    await db.query(`INSERT INTO business.case_assistant_proposals(id,conversation_id,turn_id,case_id,kind,body,content_hash,notes,case_revision,round_id,configuration_release_id,state,expires_at)
      VALUES($1,$2,$3,$4,'field_value',$5,$6,'[]',$7,$8,$9,'pending',now()+$10*interval '1 minute')`,[id,t.conversation_id,t.id,t.case_id,JSON.stringify(body),reviewHash(body),t.case_revision,context.roundId,context.configurationReleaseId,PROPOSAL_TTL_MINUTES]);
    return id;
  }
  private async ruleProposal(db:DB,t:TurnRow,candidate:NonNullable<z.infer<typeof CaseAssistModelOutputSchema>['ruleCandidate']>,manifest:Awaited<ReturnType<typeof getPublished>>['manifest']|null,notes:string[]):Promise<string|null>{
    const context=t.context;
    if(context.readOnly){notes.push('当前轮次只读，口径需在可编辑的轮次中确认。');return null;}
    if(!manifest){notes.push('案件尚未绑定审核配置，暂不能形成口径。');return null;}
    const rows=candidate.fieldRefs.map(ref=>context.rows.find(r=>r.ref===ref)).filter((r):r is CaseAssistContext['rows'][number]=>!!r);
    // Wording must come from the user's message or the compared values, never be invented.
    const corpus=[t.text,...context.rows.flatMap(r=>r.values.map(v=>v.text))].map(guidanceTextKey);
    const expressions=[...new Map(candidate.expressions.map(e=>[guidanceTextKey(e),e.trim()])).values()].filter(e=>corpus.some(text=>text.includes(guidanceTextKey(e))));
    if(expressions.length<candidate.expressions.length)notes.push('部分表述未在你的消息或字段取值中出现，已从口径中去除。');
    const replaced=candidate.replaces?context.rules.find(r=>r.ref===candidate.replaces&&r.guidanceId):undefined;
    if(candidate.replaces&&!replaced)notes.push('要替换的口径不是本案规则，已作为新口径提出。');
    const body:SemanticGuidanceBody={kind:candidate.kind,statement:candidate.statement,fieldIds:[...new Set(rows.map(r=>r.fieldId))],expressions};
    try{validateGuidanceBody(manifest,body);}catch(error){
      if(!(error instanceof AppError))throw error;
      notes.push({guidance_exact_field:'金额、币种、日期和编号需逐字核对，不能形成放宽口径。',guidance_expressions_required:'名称等同至少需要两个在原文或你的消息中出现的写法。',guidance_scope_required:'需要说明适用的字段或表述。'}[error.code]??'未能形成可保存的口径。');
      return null;
    }
    const proposal={...body,quote:clip(t.text,2000),replaces:replaced?.guidanceId??null,replacesLabel:replaced?.label??null,
      fieldLabels:rows.map(r=>`${r.label}（${r.objectLabel}）`)};
    const id=randomUUID();
    await db.query("UPDATE business.case_assistant_proposals SET state='superseded',decided_at=now() WHERE conversation_id=$1 AND state='pending' AND kind='guidance'",[t.conversation_id]);
    await db.query(`INSERT INTO business.case_assistant_proposals(id,conversation_id,turn_id,case_id,kind,body,content_hash,notes,case_revision,round_id,configuration_release_id,state,expires_at)
      VALUES($1,$2,$3,$4,'guidance',$5,$6,$7,$8,$9,$10,'pending',now()+$11*interval '1 minute')`,[id,t.conversation_id,t.id,t.case_id,JSON.stringify(proposal),reviewHash(proposal),JSON.stringify(notes),t.case_revision,context.roundId,context.configurationReleaseId,PROPOSAL_TTL_MINUTES]);
    return id;
  }
}

export function registerCaseAssistantRoutes(app:FastifyInstance,auth:Pick<Auth,'requireSession'|'checkWrite'>,service:CaseAssistantService){
  const base='/api/cases/:caseId/assistant',path=(r:any)=>z.object({caseId:z.uuid(),id:z.uuid().optional()}).parse(r.params);
  app.get(base,async r=>service.state(await auth.requireSession(r),path(r).caseId));
  app.post(`${base}/turns`,async(r,reply)=>reply.code(202).send(await service.createTurn(await auth.checkWrite(r),path(r).caseId,r.body)));
  app.post(`${base}/turns/:id/cancel`,async r=>{const p=path(r);return service.cancelTurn(await auth.checkWrite(r),p.caseId,p.id!);});
  app.post(`${base}/proposals/:id/apply`,async r=>{const p=path(r);return service.applyProposal(await auth.checkWrite(r),p.caseId,p.id!,r.body);});
  app.post(`${base}/proposals/:id/cancel`,async r=>{const p=path(r);return service.cancelProposal(await auth.checkWrite(r),p.caseId,p.id!,r.body);});
}
export {LEGAL_BASELINE_DRAFT,rowStatus};
