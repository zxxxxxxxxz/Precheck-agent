import {crossFileEvidence,extractedValueEvidence} from './cross-file-evidence.js';
import type {ChecklistRow,CrossFileCheck} from '@hsbc/contracts/review-checklist';
import {crossFileHash,crossFileSemanticItem,applyCrossFileSemantic,crossFileSuppliedValues} from '../review/cross-file-semantics.js';
import type {ReviewService} from '../review/service.js';
import {randomUUID} from 'node:crypto';
import type {Pool,PoolClient} from 'pg';
import type {FastifyInstance} from 'fastify';
import {z} from 'zod';
import {AnalysisCommandSchema,ComparisonCommandSchema,DeliveryCommandSchema,type AnalysisBody,type AnalysisJob,type AnalysisState,type AnalysisEvidence,type ComparisonCommand,type DeliveryRound,type SemanticItem,type MaterialChange} from '@hsbc/contracts/review-delivery';
import type {DocumentBundle} from '@hsbc/contracts/documents';
import type {ReviewRun} from '@hsbc/contracts/review';
import {transaction} from '../../infrastructure/database/client.js';
import {idempotent} from '../../infrastructure/database/idempotency.js';
import {QwenClient} from '../../infrastructure/integrations/inference.js';
import {ServiceError} from '../../infrastructure/integrations/http.js';
import {AppError} from '../../shared/errors.js';
import type {Actor} from '../identity/types.js';
import type {Auth} from '../identity/auth.js';
import {assertActor,hasGrant} from '../identity/authorization.js';
import {authorizeCase,canEditReview,canOwnReviewResult} from '../cases/authorization.js';
import {audit} from '../audit/events.js';
import type {DocumentService} from '../documents/service.js';
import {getPublished} from '../review/configuration.js';
import {reviewHash,type ReviewSnapshot} from '../review/service.js';
import {ANALYSIS_VERSION,SEMANTIC_CATALOG,evidenceFromBundle,semanticChecklist} from './semantic.js';
import {matchMaterials,materialChanges,reviewResultChanges} from './comparison.js';
import {analyzeEvidence,EXTRACTED_VALUE_PROMPT_VERSION,ASSIST_PROMPT_VERSION,CROSS_FILE_GUIDED_PROMPT_VERSION,CROSS_FILE_PROMPT_VERSION,type ReviewAssistConfig,type AssistChat} from './model.js';
import {analysisDispatch} from './ledger.js';
import {analysisItems,analysisProgress,deferBeyondBatch,followupBatch,initialBatch,isDeferred,retryableItems,type AnalysisBatch} from './batches.js';

interface StoredInput {crossFile?:{roundId:string|null;configurationReleaseId:string|null;fieldId:string;checkHash:string;check:CrossFileCheck};runIds:string[];body:AnalysisBody;modelVersion:string|null;objectPairs:ComparisonCommand['objectPairs'];materialGroups:ComparisonCommand['materialGroups'];batch?:AnalysisBatch}
interface AnalysisRow {id:string;case_id:string;kind:'semantic'|'comparison';account_id:string;person_id:string;auth_version:number;session_key:string|null;expected_revision:number;input_hash:string;source_hash:string;state:AnalysisJob['state'];error_code:string|null;created_at:Date}
interface AnalysisWork {id:string;owner_id:string;epoch:number}
const iso=(v:Date|string)=>new Date(v).toISOString();
const actorOf=(j:AnalysisRow):Actor=>({accountId:j.account_id,personId:j.person_id,authVersion:j.auth_version,...(j.session_key?{sessionKey:j.session_key}:{})});
const runView=(r:any):ReviewRun=>({id:r.id,caseRevision:r.case_revision,configurationReleaseId:r.configuration_release_id,snapshotHash:r.snapshot_hash,state:r.state,validity:r.validity,errorCode:r.error_code,createdAt:iso(r.created_at),results:r.results,executionReceipts:[]});
const roundView=(r:any):DeliveryRound=>({roundId:r.round_id??null,roundNumber:r.round_number??null,runId:r.id,state:r.state,validity:r.validity,label:r.round_number?`第 ${r.round_number} 轮`:'历史检查（无业务轮次）',snapshotHash:r.snapshot_hash,configurationReleaseId:r.configuration_release_id,manifestHash:r.snapshot.manifestHash,packageHash:r.snapshot.packageHash});

export class ReviewAnalysisService {
  private active=new Set<AbortController>();private stopping=false;private client?:AssistChat;
  constructor(readonly pool:Pool,readonly documents:Pick<DocumentService,'reviewBundle'|'translation'>,readonly config?:ReviewAssistConfig,client?:AssistChat,readonly reviews?:Pick<ReviewService,'crossFileContext'>){this.client=client??(config?new QwenClient(config.service,config.model,pool):undefined);}
  stop(){this.stopping=true;for(const c of this.active)c.abort();}
  private modelVersion(){return this.config?reviewHash([this.config.model,this.config.modelRevision,ASSIST_PROMPT_VERSION]):null;}
  /** Guided checks use their own prompt version; unguided saved results remain valid. */
  private crossFileModelVersion(guided=false){return this.config?reviewHash([this.config.model,this.config.modelRevision,guided?CROSS_FILE_GUIDED_PROMPT_VERSION:CROSS_FILE_PROMPT_VERSION]):null;}
  private crossFileVersionFor(check:Pick<CrossFileCheck,'guidance'|'valueBasis'>){return check.valueBasis==='extracted'?(this.config?reviewHash([this.config.model,this.config.modelRevision,EXTRACTED_VALUE_PROMPT_VERSION]):null):this.crossFileModelVersion(Boolean(check.guidance?.length));}
  private async authorize(db:PoolClient,actor:Actor,caseId:string,write=false){
    const c=await authorizeCase(db,actor,caseId,'evidence:read',write);
    if(write){if(!await hasGrant(db,actor.personId,'review:analyze',caseId))throw new AppError(403,'permission_denied');
      if(c.closed_at)throw new AppError(409,'case_closed');if(c.scenario!=='overseas_loan')throw new AppError(409,'scenario_confirmation_required');
      if(!await canEditReview(db,c,actor.personId))throw new AppError(403,'maker_assignment_required');}
    return c;
  }
  private async runs(db:PoolClient,caseId:string,ids:string[]){
    const rows=[];for(const id of ids){const r=(await db.query('SELECT r.*,q.number AS round_number,q.run_id AS round_run FROM business.review_runs r LEFT JOIN business.review_rounds q ON q.id=r.round_id WHERE r.id=$1 AND r.case_id=$2',[id,caseId])).rows[0];
      if(!r)throw new AppError(404,'review_run_not_found');if(reviewHash(r.snapshot)!==r.snapshot_hash||r.round_id&&r.round_run!==r.id)throw new AppError(409,'review_snapshot_corrupt');rows.push(r);}
    return rows;
  }
  private async source(db:PoolClient,caseId:string,ids:string[]){
    const runs=await this.runs(db,caseId,ids);
    const issues=(await db.query(`SELECT i.id,i.rule_id AS "ruleId",i.scope_id AS "scopeId",i.status,i.version,f.run_id AS "runId" FROM business.review_issues i JOIN business.review_findings f ON f.id=i.latest_finding_id
      WHERE i.case_id=$1 AND f.run_id=ANY($2::uuid[]) ORDER BY i.id`,[caseId,ids])).rows;
    const pins=runs.flatMap(r=>(r.snapshot as ReviewSnapshot).materials);
    const versions=(await db.query(`SELECT d.id,d.sha256,d.current_parse_job_id,p.state,p.validity,
      (SELECT max(directory_revision) FROM business.document_artifacts WHERE job_id=d.current_parse_job_id) AS directory_revision
      FROM business.document_versions d LEFT JOIN business.document_jobs p ON p.id=d.current_parse_job_id WHERE d.case_id=$1 AND d.id=ANY($2::uuid[]) ORDER BY d.id`,[caseId,pins.map(p=>p.documentVersionId)])).rows;
    const altered=pins.some(p=>{const d=versions.find(d=>d.id===p.documentVersionId);return !d||d.sha256!==p.sourceSha256||d.current_parse_job_id!==p.parseRevision||Number(d.directory_revision)!==Number(p.directoryRevision);});
    return {runs,issues,altered,hash:reviewHash({runs:runs.map(r=>({id:r.id,hash:r.snapshot_hash,state:r.state,validity:r.validity,results:r.results})),issues,versions})};
  }
  async evidenceForRuns(db:PoolClient,actor:Actor,caseId:string,runs:any[]){
    const pins=new Map<string,ReviewSnapshot['materials'][number]>();for(const r of runs)for(const m of (r.snapshot as ReviewSnapshot).materials)if(m.operation==='adopt')pins.set(m.documentVersionId,m);
    const names=Object.fromEntries((await db.query('SELECT id,filename FROM business.document_versions WHERE case_id=$1',[caseId])).rows.map(r=>[r.id,r.filename]));
    const bundles=new Map<string,DocumentBundle>(),evidence:AnalysisEvidence[]=[],limitations:string[]=[];
    for(const [id,pin] of pins){try{const bundle=await this.documents.reviewBundle(db,actor,caseId,pin);const items=evidenceFromBundle(bundle,names[id]??'关联材料',true).map(e=>({...e,roundId:runs.find(r=>(r.snapshot as ReviewSnapshot).materials.some(m=>m.documentVersionId===id))?.round_id??null}));bundles.set(id,bundle);evidence.push(...items);}
      catch(e){if(!(e instanceof AppError))throw e;limitations.push(`材料 ${names[id]??id.slice(0,8)}：原文不可完整核验（${e.code}）`);}}
    // Reuse stored reference translations only when their complete original text and pinned parse agree.
    const translations=(await db.query(`SELECT s.body,s.body_hash,j.id,j.document_version_id,j.expected_revision,j.input FROM business.document_translation_segments s JOIN business.document_jobs j ON j.id=s.job_id
      WHERE j.case_id=$1 AND j.document_version_id=ANY($2::uuid[]) AND j.state IN ('ready','partial') ORDER BY j.created_at DESC`,[caseId,[...pins.keys()]])).rows;
    const views=new Map<string,Awaited<ReturnType<DocumentService['translation']>>|null>();
    for(const e of evidence){const t=translations.find(t=>t.document_version_id===e.documentId&&t.input.parseRevision===e.parseRevision&&Number(t.input.directoryRevision)===e.directoryRevision&&t.body.sourceSha256===e.sha256&&t.body.sourceText===e.text);
      if(!t)continue;
      if(!views.has(t.id))try{views.set(t.id,await this.documents.translation(actor,caseId,e.documentId,t.id,db));}catch(error){if(!(error instanceof AppError))throw error;views.set(t.id,null);limitations.push(`材料 ${e.filename} 的已存参考译文未通过来源核验，暂不展示。`);}
      const view=views.get(t.id),segment=view?.items.find(s=>s.sourceSha256===e.sha256&&s.sourceText===e.text&&typeof s.translatedText==='string'&&s.translatedText.trim());
      if(view&&segment)e.referenceTranslations.push({text:segment.translatedText!,jobId:t.id,status:[segment.simulated?'模拟参考译文，仅用于工程验证':'',view.validity==='stale'?'历史参考译文：原文字段相同，但原任务已过期，需重新核对':segment.status==='ready'?'已保存的参考译文，未替代正式材料':'参考译文待核对'].filter(Boolean).join('；')});
    }
    return {bundles,evidence,limitations,names};
  }
  private async submitted(db:PoolClient,caseId:string){return (await db.query(`SELECT q.id,q.number,q.submitted_at,q.run_id,r.state,r.validity FROM business.review_rounds q
    JOIN business.review_runs r ON r.id=q.run_id AND r.case_id=q.case_id AND r.round_id=q.id
    WHERE q.case_id=$1 AND q.state<>'discarded' AND q.submitted_at IS NOT NULL ORDER BY q.number DESC`,[caseId])).rows;}
  async state(actor:Actor,caseId:string):Promise<AnalysisState>{return transaction(this.pool,async db=>{
    const c=await this.authorize(db,actor,caseId),allowedActions:string[]=[];try{await this.authorize(db,actor,caseId,true);allowedActions.push('review:analyze');}catch(e){if(!(e instanceof AppError))throw e;}
    const rounds=await this.submitted(db,caseId),latest=rounds.slice(0,2),jobs=(await db.query("SELECT j.id,j.kind,j.state,j.created_at,s.body->'runIds' AS run_ids FROM business.review_analysis_jobs j JOIN business.review_analysis_snapshots s ON s.job_id=j.id WHERE j.case_id=$1 ORDER BY j.created_at DESC,j.id DESC LIMIT 50",[caseId])).rows;
    const excludedRounds=(await db.query(`SELECT q.id AS "roundId",q.number AS "roundNumber",
      CASE WHEN q.state='discarded' THEN 'discarded' ELSE 'no_result' END AS reason
      FROM business.review_rounds q WHERE q.case_id=$1 AND NOT (q.id=ANY($2::uuid[])) ORDER BY q.number DESC`,[caseId,rounds.map(r=>r.id)])).rows;
    let comparison:AnalysisState['comparison']=null;
    if(latest.length===2&&latest.every(r=>r.run_id)){
      const runs=await this.runs(db,caseId,[latest[1]!.run_id,latest[0]!.run_id]),before=runs[0]!.snapshot as ReviewSnapshot,after=runs[1]!.snapshot as ReviewSnapshot;
      const names=Object.fromEntries((await db.query('SELECT id,filename FROM business.document_versions WHERE case_id=$1',[caseId])).rows.map(r=>[r.id,r.filename]));
      const saved=(await db.query(`SELECT s.body,s.body_hash FROM business.review_analysis_jobs j JOIN business.review_analysis_snapshots s ON s.job_id=j.id
        WHERE j.case_id=$1 AND j.kind='comparison' AND j.state IN ('ready','partial') AND j.account_id=$2 AND j.auth_version=$3
        AND s.body->'runIds'=to_jsonb($4::uuid[]) ORDER BY j.created_at DESC,j.id DESC LIMIT 1`,[caseId,actor.accountId,actor.authVersion,runs.map(r=>r.id)])).rows[0];
      if(saved&&reviewHash(saved.body)!==saved.body_hash)throw new AppError(409,'delivery_integrity_failed');
      const objectPairs=saved?.body.objectPairs??[],materialGroups=saved?.body.materialGroups??[];
      comparison={beforeRoundId:latest[1]!.id,afterRoundId:latest[0]!.id,objectPairs,materialGroups,matches:matchMaterials(before,after,objectPairs,materialGroups),beforeObjects:before.objects.map(o=>({id:o.objectId,label:o.label,role:o.role})),afterObjects:after.objects.map(o=>({id:o.objectId,label:o.label,role:o.role})),documents:[...before.materials.filter(m=>m.operation==='adopt').map(m=>({id:m.documentVersionId,label:names[m.documentVersionId]??'上一轮材料',side:'before' as const})),...after.materials.filter(m=>m.operation==='adopt').map(m=>({id:m.documentVersionId,label:names[m.documentVersionId]??'本轮材料',side:'after' as const}))]};
    }
    return {caseId,revision:c.revision,modelEnabled:Boolean(this.config),allowedActions,excludedRounds,rounds:rounds.map(r=>({roundId:r.id,roundNumber:r.number,runId:r.run_id,state:r.state??'missing',validity:r.validity??'stale',label:`第 ${r.number} 轮`,submittedAt:iso(r.submitted_at)})),jobs:jobs.map(j=>({id:j.id,kind:j.kind,state:j.state,createdAt:iso(j.created_at),runIds:j.run_ids})),comparison};
  });}
  private async crossFileSource(db:PoolClient,actor:Actor,caseId:string,checkId:string,fieldId:string){
    if(!this.reviews)throw new AppError(409,'review_assist_unavailable');
    const context=await this.reviews.crossFileContext(db,actor,caseId);
    const check=context.rows.find(r=>r.fieldId===fieldId&&r.crossChecks?.some(c=>c.id===checkId))?.crossChecks?.find(c=>c.id===checkId);
    if(!check?.semanticEligible||context.state.readOnly)throw new AppError(409,'cross_file_analysis_unavailable');
    const ids=new Set(check.sources.flatMap(s=>s.documentId?[s.documentId]:[]));
    const pins=[...new Map(context.state.materials.filter(m=>m.operation==='adopt'&&ids.has(m.documentVersionId)).map(m=>[m.documentVersionId,m])).values()];
    return {...context,check,pins,hash:reviewHash({roundId:context.state.roundId,release:context.state.configurationReleaseId,check,pins})};
  }
  /** `rerunOf` is the settled job whose result the reviewer asked to check again. It must be the latest job for the
   * current check; a newer or still running job is returned instead, so two pages or people never start two reruns. */
  async createCrossFile(actor:Actor,caseId:string,raw:unknown){
    const input=DeliveryCommandSchema.extend({checkId:z.string().min(1).max(500),fieldId:z.string().min(1).max(200),rerunOf:z.uuid().optional()}).parse(raw);
    return transaction(this.pool,async db=>{
      const c=await this.authorize(db,actor,caseId,true);
      if(!this.config)throw new AppError(409,'review_assist_unavailable');
      return idempotent(db,actor,`review.cross-file:${caseId}`,input.idempotencyKey,input,async()=>{
        if(c.revision!==input.expectedRevision)throw new AppError(409,'stale_revision');
        const source=await this.crossFileSource(db,actor,caseId,input.checkId,input.fieldId);
        if(input.rerunOf){
          const checkHash=crossFileHash(source.check),roundId=source.state.roundId??null;
          const rerun=(await db.query(`SELECT j.state,s.body->'crossFile' AS cross_file FROM business.review_analysis_jobs j JOIN business.review_analysis_snapshots s ON s.job_id=j.id WHERE j.id=$1 AND j.case_id=$2`,[input.rerunOf,caseId])).rows[0];
          if(!rerun?.cross_file||rerun.cross_file.checkHash!==checkHash||(rerun.cross_file.roundId??null)!==roundId)throw new AppError(409,'analysis_source_stale');
          if(['pending','running'].includes(rerun.state))return {id:input.rerunOf,reused:true};
          const newer=(await db.query(`SELECT j.id FROM business.review_analysis_jobs j JOIN business.review_analysis_snapshots s ON s.job_id=j.id
            WHERE j.case_id=$1 AND j.id<>$2 AND s.body->'crossFile'->>'checkHash'=$3 AND s.body->'crossFile'->>'roundId' IS NOT DISTINCT FROM $4
            AND j.created_at>(SELECT created_at FROM business.review_analysis_jobs WHERE id=$2) ORDER BY j.created_at DESC,j.id DESC LIMIT 1`,[caseId,input.rerunOf,checkHash,roundId])).rows[0];
          if(newer)return {id:newer.id,reused:true};
        }
        // A rerun starts its own job family, so its retry budget is separate from the result it replaces.
        const inputHash=reviewHash({source:source.hash,model:this.crossFileVersionFor(source.check),version:ANALYSIS_VERSION,...(input.rerunOf?{rerunOf:input.rerunOf}:{})});
        const old=(await db.query('SELECT id FROM business.review_analysis_jobs WHERE case_id=$1 AND input_hash=$2 AND account_id=$3 AND auth_version=$4 ORDER BY created_at DESC LIMIT 1',[caseId,inputHash,actor.accountId,actor.authVersion])).rows[0];
        if(old)return {id:old.id,reused:true};
        if((await db.query(`SELECT 1 FROM business.review_analysis_calls call JOIN business.review_analysis_jobs job ON job.id=call.job_id
          JOIN business.review_analysis_snapshots snapshot ON snapshot.job_id=job.id
          WHERE job.case_id=$1 AND job.source_hash=$2 AND snapshot.body->>'modelVersion'=$3 AND call.state='unknown' LIMIT 1`,[caseId,source.hash,this.crossFileVersionFor(source.check)])).rowCount)throw new AppError(409,'review_assist_call_unknown');
        if(Number((await db.query("SELECT count(*) AS n FROM business.review_analysis_jobs WHERE case_id=$1 AND state IN ('pending','running')",[caseId])).rows[0].n)>=4)throw new AppError(429,'analysis_queue_full');
        const evidence:AnalysisEvidence[]=source.check.valueBasis==='extracted'?extractedValueEvidence(source.check):[];
        for(const pin of source.check.valueBasis==='extracted'?[]:source.pins){
          try{const bundle=await this.documents.reviewBundle(db,actor,caseId,pin);evidence.push(...crossFileEvidence(bundle,source.check.sources.find(s=>s.documentId===pin.documentVersionId)!.filename,source.check));}
          catch(e){if(!(e instanceof AppError)||e.status===403)throw e;}
        }
        const item=crossFileSemanticItem(source.check,evidence),id=randomUUID(),workId=randomUUID();
        const body:AnalysisBody={version:ANALYSIS_VERSION,purpose:'assistance',kind:'semantic',runs:[],evidence,items:[item],changes:[],resultChanges:[],limitations:[],modelVersion:this.crossFileVersionFor(source.check)};
        const frozen:StoredInput={runIds:[],body,modelVersion:this.crossFileVersionFor(source.check),objectPairs:[],materialGroups:[],crossFile:{roundId:source.state.roundId??null,configurationReleaseId:source.state.configurationReleaseId,fieldId:input.fieldId,checkHash:crossFileHash(source.check),check:source.check},batch:initialBatch(body,id,inputHash)};
        await db.query("INSERT INTO business.review_analysis_jobs(id,case_id,kind,account_id,person_id,auth_version,session_key,expected_revision,input_hash,source_hash,state) VALUES($1,$2,'semantic',$3,$4,$5,$6,$7,$8,$9,'pending')",[id,caseId,actor.accountId,actor.personId,actor.authVersion,actor.sessionKey??null,c.revision,inputHash,source.hash]);
        await db.query('INSERT INTO business.review_analysis_snapshots(job_id,body,body_hash) VALUES($1,$2,$3)',[id,JSON.stringify(frozen),reviewHash(frozen)]);
        await db.query("INSERT INTO business.work_items(id,owner_type,owner_id,kind,queue,max_attempts) VALUES($1,'Workflow',$2,'review_analysis','workflow',3)",[workId,id]);
        await db.query("INSERT INTO business.outbox(id,work_item_id,event_type,owner_id) VALUES($1,$2,'review_analysis_requested',$3)",[randomUUID(),workId,id]);
        await audit(db,{actorId:actor.accountId,targetId:caseId,action:'review.cross_file_analysis_requested',details:{jobId:id,checkId:source.check.id,...(input.rerunOf?{rerunOf:input.rerunOf}:{})}});
        return {id,reused:false};
      });
    });
  }
  /** Reuse only exact source/config/model matches. Historical runs keep their frozen projection. */
  async projectCrossFile(db:PoolClient,actor:Actor,caseId:string,roundId:string|null,rows:ChecklistRow[]):Promise<ChecklistRow[]>{
    if(!this.config)return rows;
    const hashes=new Set(rows.flatMap(r=>r.crossChecks??[]).map(crossFileHash));
    const c=await this.authorize(db,actor,caseId),saved=(await db.query(`SELECT j.*,s.body AS input,s.body_hash FROM business.review_analysis_jobs j JOIN business.review_analysis_snapshots s ON s.job_id=j.id
      WHERE j.case_id=$1 AND s.body->'crossFile'->>'roundId' IS NOT DISTINCT FROM $2
      AND s.body->'crossFile'->>'checkHash'=ANY($3::text[]) AND s.body->>'modelVersion'=ANY($4::text[]) ORDER BY j.created_at DESC,j.id DESC`,[caseId,roundId,[...hashes],[this.crossFileModelVersion(false),this.crossFileModelVersion(true),this.crossFileVersionFor({valueBasis:'extracted'})]])).rows;
    const matches=new Map<string,{item:SemanticItem;evidence:AnalysisEvidence[];jobId:string;canRetry:boolean}>();
    for(const j of saved){
      const input=j.input as StoredInput,key=crossFileHash(input.crossFile!.check);
      if(matches.has(key)||!hashes.has(key)||input.modelVersion!==this.crossFileVersionFor(input.crossFile!.check)||input.body.version!==ANALYSIS_VERSION||input.crossFile!.configurationReleaseId!==c.configuration_release_id)continue;
      if(reviewHash(input)!==j.body_hash)throw new AppError(409,'delivery_integrity_failed');
      if(!await this.principalCurrent(db,c,j))continue;
      const body=await this.body(db,j.id,input),item=body.items[0];if(!item)continue;
      const displayed=['failed','canceled'].includes(j.state)&&item.state==='pending'?{...item,state:'failed' as const,reason:'AI 核对未完成，请检查任务状态。'}:item;
      const family=displayed.state==='failed'?await this.family(db,j,input):undefined;
      const canRetry=!!family&&!family.unknown&&!family.nextJobId&&j.state!=='canceled'&&
        ['ready','partial','failed'].includes(j.state)&&j.account_id===actor.accountId&&j.auth_version===actor.authVersion&&
        retryableItems(body,family.batch).length>0;
      matches.set(key,{item:displayed,evidence:body.evidence,jobId:j.id,canRetry});
    }
    return rows.map(row=>({...row,crossChecks:row.crossChecks?.map(check=>{const saved=matches.get(crossFileHash(check));if(!saved)return check;
      const projected=applyCrossFileSemantic(check,saved.item,saved.evidence,saved.jobId);
      return {...projected,semantic:projected.semantic?{...projected.semantic,canRetry:saved.canRetry}:undefined};})}));
  }
  async create(actor:Actor,caseId:string,kind:'semantic'|'comparison',raw:unknown){
    const input=kind==='semantic'?AnalysisCommandSchema.parse(raw):ComparisonCommandSchema.parse(raw);
    if(input.retryOf)return this.followup(actor,caseId,input.retryOf,'retry',{expectedRevision:input.expectedRevision,idempotencyKey:input.idempotencyKey},{kind,input});
    return transaction(this.pool,async db=>{
      const c=await this.authorize(db,actor,caseId,true);
      return idempotent(db,actor,`review.analysis:${caseId}:${kind}`,input.idempotencyKey,input,async()=>{
        if(c.revision!==input.expectedRevision)throw new AppError(409,'stale_revision');
        let ids:string[],pairs:ComparisonCommand['objectPairs']=[],groups:ComparisonCommand['materialGroups']=[];
        if('runId'in input)ids=[input.runId];else{
          const rounds=await this.submitted(db,caseId);const a=rounds.find(r=>r.id===input.beforeRoundId),b=rounds.find(r=>r.id===input.afterRoundId);
          if(!a||!b||a.number>=b.number||!a.run_id||!b.run_id)throw new AppError(409,'comparison_rounds_unavailable');
          ids=[a.run_id,b.run_id];pairs=input.objectPairs;groups=input.materialGroups;
        }
        const source=await this.source(db,caseId,ids);
        if((source.runs.at(-1)?.round_id??null)!==(c.current_round_id??null))throw new AppError(409,'analysis_source_stale');
        if(kind==='semantic'&&(source.runs[0]!.state!=='ready'||source.runs[0]!.validity!=='current'||source.altered))throw new AppError(409,'delivery_result_not_ready');
        const prepared=await this.evidenceForRuns(db,actor,caseId,source.runs),body:AnalysisBody={version:ANALYSIS_VERSION,purpose:'assistance',kind,runs:source.runs.map(roundView),evidence:prepared.evidence,items:[],changes:[],resultChanges:[],limitations:prepared.limitations,modelVersion:this.modelVersion()};
        if(kind==='semantic')body.items=semanticChecklist(source.runs[0]!.snapshot,await getPublished(db,source.runs[0]!.configuration_release_id),source.runs[0]!.results,prepared.evidence,Boolean(this.config));
        else{
          const before=source.runs[0]!,after=source.runs[1]!,matches=matchMaterials(before.snapshot,after.snapshot,pairs,groups);
          body.changes=materialChanges(matches,before.snapshot,after.snapshot,prepared.bundles,prepared.evidence,Boolean(this.config));
          body.resultChanges=reviewResultChanges(runView(before),runView(after),pairs,source.issues);
          const latestRelease=await getPublished(db,after.configuration_release_id);
          body.resultChanges=body.resultChanges.map(change=>({...change,ruleLabel:latestRelease.manifest.rules.find(r=>r.id===change.ruleId)?.label??change.ruleId,
            objectLabels:[...new Set([before.snapshot.objects.find((o:any)=>o.objectId===change.beforeObjectId)?.label,after.snapshot.objects.find((o:any)=>o.objectId===change.afterObjectId)?.label].filter((s):s is string=>Boolean(s)))]}));
          for(const r of source.runs){const config=await getPublished(db,r.configuration_release_id);for(const change of body.changes){const ids=new Set([...change.before,...change.after]);const fields=(r.snapshot as ReviewSnapshot).facts.filter(f=>f.evidence.some(e=>ids.has(e.documentVersionId))).map(f=>f.fieldId);
            change.affectedRuleIds=[...new Set([...change.affectedRuleIds,...config.manifest.rules.filter(rule=>rule.inputs.some(id=>fields.includes(id)||config.manifest.materials.some(m=>id===`material:${m.id}`&&(r.snapshot as ReviewSnapshot).materials.some(d=>ids.has(d.documentVersionId)&&d.documentTypeId===m.taxonomyId)))).map(rule=>rule.id)])];}}
          if(source.runs.some(r=>r.state!=='ready'||r.validity!=='current'))body.limitations.push('所选最近轮次的检查未完成或已失效；材料仍可比较，审核结果不可据此认定完成。');
          if(!body.changes.length)body.limitations.push('两轮没有可比较的已采用材料；不代表没有变化。');
        }
        deferBeyondBatch(body);
        const frozen:StoredInput={runIds:ids,body,modelVersion:this.modelVersion(),objectPairs:pairs,materialGroups:groups},inputHash=reviewHash({kind,sourceHash:source.hash,modelVersion:frozen.modelVersion,pairs,groups,version:ANALYSIS_VERSION,referenceTranslations:body.evidence.map(e=>({id:e.id,translations:e.referenceTranslations}))});
        const previous=(await db.query('SELECT * FROM business.review_analysis_jobs WHERE case_id=$1 AND input_hash=$2 ORDER BY created_at DESC',[caseId,inputHash])).rows as AnalysisRow[];
        const own=previous.filter(j=>j.account_id===actor.accountId&&j.auth_version===actor.authVersion);
        if(own.length){const family=await this.family(db,own[0]!,await this.snapshot(db,own[0]!.id));return {id:family.nextJobId??own[0]!.id,reused:true};}
        if(previous.length&&(await db.query("SELECT 1 FROM business.review_analysis_calls WHERE job_id=ANY($1::uuid[]) AND state='unknown' LIMIT 1",[previous.map(j=>j.id)])).rowCount)throw new AppError(409,'review_assist_call_unknown');
        if(Number((await db.query("SELECT count(*) AS n FROM business.review_analysis_jobs WHERE case_id=$1 AND state IN ('pending','running')",[caseId])).rows[0].n)>=4)throw new AppError(429,'analysis_queue_full');
        const id=randomUUID(),workId=randomUUID();
        frozen.batch=initialBatch(body,id,inputHash);
        await db.query("INSERT INTO business.review_analysis_jobs(id,case_id,kind,account_id,person_id,auth_version,session_key,expected_revision,input_hash,source_hash,state) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'pending')",[id,caseId,kind,actor.accountId,actor.personId,actor.authVersion,actor.sessionKey??null,c.revision,inputHash,source.hash]);
        await db.query('INSERT INTO business.review_analysis_snapshots(job_id,body,body_hash) VALUES($1,$2,$3)',[id,JSON.stringify(frozen),reviewHash(frozen)]);
        await db.query("INSERT INTO business.work_items(id,owner_type,owner_id,kind,queue,max_attempts) VALUES($1,'Workflow',$2,'review_analysis','workflow',3)",[workId,id]);
        await db.query("INSERT INTO business.outbox(id,work_item_id,event_type,owner_id) VALUES($1,$2,'review_analysis_requested',$3)",[randomUUID(),workId,id]);
        await audit(db,{actorId:actor.accountId,targetId:caseId,action:'review.analysis_requested',details:{jobId:id,kind,runCount:ids.length}});return {id,reused:false};
      });
    });
  }
  private async snapshot(db:PoolClient,id:string):Promise<StoredInput>{const s=(await db.query('SELECT * FROM business.review_analysis_snapshots WHERE job_id=$1',[id])).rows[0];
    if(!s||reviewHash(s.body)!==s.body_hash)throw new AppError(409,'delivery_integrity_failed');return s.body;}
  private async body(db:PoolClient,id:string,input:StoredInput){
    const rows=(await db.query('SELECT * FROM business.review_analysis_items WHERE job_id=$1',[id])).rows;
    for(const r of rows)if(reviewHash(r.body)!==r.body_hash)throw new AppError(409,'delivery_integrity_failed');
    return {...input.body,items:input.body.items.map(i=>rows.find(r=>r.item_id===i.id)?.body??i),changes:input.body.changes.map(i=>rows.find(r=>r.item_id===i.id)?.body??i)} as AnalysisBody;
  }
  private async family(db:PoolClient,j:AnalysisRow,input:StoredInput){
    const rootId=input.batch?.rootId??j.id,rootInputHash=input.batch?.rootInputHash??j.input_hash;
    const rows=(await db.query(`SELECT j.id,s.body->'batch' AS batch FROM business.review_analysis_jobs j JOIN business.review_analysis_snapshots s ON s.job_id=j.id
      WHERE j.case_id=$1 AND j.account_id=$2 AND j.auth_version=$3 AND (j.input_hash=$4 OR s.body->'batch'->>'rootId'=$5)
      ORDER BY COALESCE((s.body->'batch'->>'number')::integer,1) DESC,j.created_at DESC,j.id DESC`,[j.case_id,j.account_id,j.auth_version,rootInputHash,rootId])).rows;
    const batch=input.batch??initialBatch(input.body,rootId,rootInputHash,rows.filter(r=>!r.batch).length||1);
    const unknown=Boolean((await db.query("SELECT 1 FROM business.review_analysis_calls WHERE job_id=ANY($1::uuid[]) AND state='unknown' LIMIT 1",[rows.map(r=>r.id)])).rowCount);
    return {batch,unknown,nextJobId:rows[0]?.id!==j.id?rows[0]?.id??null:null};
  }
  private async principalCurrent(db:PoolClient,c:any,j:AnalysisRow){
    const principal=(await db.query('SELECT enabled,must_change,auth_version,business_role FROM business.principals WHERE account_id=$1 AND person_id=$2',[j.account_id,j.person_id])).rows[0];
    return !(!await canOwnReviewResult(db,c,j.person_id)||!principal?.enabled||principal.must_change||principal.auth_version!==j.auth_version||principal.business_role!=='BCO'||!await hasGrant(db,j.person_id,'review:analyze',j.case_id)||!await hasGrant(db,j.person_id,'evidence:read',j.case_id)||!await hasGrant(db,j.person_id,'case:read',j.case_id));
  }
  private async validity(db:PoolClient,c:any,j:AnalysisRow,input:StoredInput):Promise<AnalysisJob['validity']>{
    if(!await this.principalCurrent(db,c,j))return 'stale';
    if(input.crossFile){
      if(input.modelVersion!==this.crossFileVersionFor(input.crossFile.check)||input.body.version!==ANALYSIS_VERSION)return 'stale';
      try{return (await this.crossFileSource(db,actorOf(j),j.case_id,input.crossFile.check.id,input.crossFile.fieldId)).hash===j.source_hash?'current':'stale';}
      catch(e){if(e instanceof AppError)return 'stale';throw e;}
    }
    const source=await this.source(db,c.id,input.runIds);
    if(source.hash!==j.source_hash||source.altered||input.modelVersion!==this.modelVersion()||input.body.version!==ANALYSIS_VERSION)return 'stale';
    if(source.runs.some(r=>r.validity!=='current'))return 'stale';
    const last=source.runs.at(-1)!;return (last.round_id??null)===(c.current_round_id??null)?'current':'history';
  }
  async get(actor:Actor,caseId:string,id:string):Promise<AnalysisJob>{return transaction(this.pool,async db=>{
    const c=await this.authorize(db,actor,caseId),j=(await db.query('SELECT * FROM business.review_analysis_jobs WHERE id=$1 AND case_id=$2',[id,caseId])).rows[0] as AnalysisRow|undefined;
    if(!j)throw new AppError(404,'analysis_not_found');const input=await this.snapshot(db,id),body=await this.body(db,id,input),validity=await this.validity(db,c,j,input);
    const own=actor.accountId===j.account_id&&actor.authVersion===j.auth_version,write=own&&!c.closed_at&&await canEditReview(db,c,actor.personId)&&await hasGrant(db,actor.personId,'review:analyze',caseId);
    const {batch,unknown,nextJobId}=await this.family(db,j,input),terminal=['ready','partial','failed','canceled'].includes(j.state);
    const canFollow=write&&validity==='current'&&!unknown&&!nextJobId&&terminal;
    return {id,caseId,kind:j.kind,state:j.state,validity,errorCode:unknown&&!['pending','running'].includes(j.state)?'review_assist_call_unknown':j.error_code,createdAt:iso(j.created_at),body,
      canCancel:Boolean(write&&validity==='current'&&['pending','running'].includes(j.state)),canRetry:Boolean(canFollow&&retryableItems(body,batch).length),
      canContinue:Boolean(canFollow&&validity==='current'&&analysisItems(body).some(isDeferred)&&!retryableItems(body,batch).some(i=>i.state==='pending')),
      nextJobId,progress:analysisProgress(body,batch),simulated:analysisItems(body).some(i=>i.simulated)};
  });}
  async cancel(actor:Actor,caseId:string,id:string){return transaction(this.pool,async db=>{
    const c=await this.authorize(db,actor,caseId,true);const j=(await db.query('SELECT * FROM business.review_analysis_jobs WHERE id=$1 AND case_id=$2 FOR UPDATE',[id,caseId])).rows[0];
    if(!j)throw new AppError(404,'analysis_not_found');if(j.account_id!==actor.accountId)throw new AppError(403,'permission_denied');
    if(await this.validity(db,c,j,await this.snapshot(db,id))!=='current')throw new AppError(409,'analysis_source_stale');
    if(['pending','running'].includes(j.state)){await db.query("UPDATE business.review_analysis_jobs SET state='canceled',error_code='analysis_canceled',updated_at=now() WHERE id=$1",[id]);
      await db.query("UPDATE business.work_items SET state='canceled',epoch=epoch+1,lease_until=NULL WHERE owner_id=$1 AND kind='review_analysis'",[id]);
      await audit(db,{actorId:actor.accountId,targetId:caseId,action:'review.analysis_canceled',details:{jobId:id}});}
    return {id};
  });}
  async retry(actor:Actor,caseId:string,id:string,raw:unknown){
    return this.followup(actor,caseId,id,'retry',raw);
  }
  async continue(actor:Actor,caseId:string,id:string,raw:unknown){
    return this.followup(actor,caseId,id,'continue',raw);
  }
  private async followup(actor:Actor,caseId:string,parentId:string,action:'continue'|'retry',raw:unknown,requested?:{kind:'semantic'|'comparison';input:z.infer<typeof AnalysisCommandSchema>|ComparisonCommand}){
    const command=DeliveryCommandSchema.parse(raw),notAllowed=action==='continue'?'analysis_continue_not_allowed':'analysis_retry_not_allowed';
    return transaction(this.pool,async db=>{
      const c=await this.authorize(db,actor,caseId,true);
      return idempotent(db,actor,`review.analysis.${action}:${caseId}:${parentId}`,command.idempotencyKey,{...command,...(requested?{requested}:{})},async()=>{
        if(c.revision!==command.expectedRevision)throw new AppError(409,'stale_revision');
        const j=(await db.query('SELECT * FROM business.review_analysis_jobs WHERE id=$1 AND case_id=$2 FOR UPDATE',[parentId,caseId])).rows[0] as AnalysisRow|undefined;
        if(!j)throw new AppError(404,'analysis_not_found');
        if(j.account_id!==actor.accountId||j.auth_version!==actor.authVersion)throw new AppError(403,'permission_denied');
        const input=await this.snapshot(db,parentId),body=await this.body(db,parentId,input),validity=await this.validity(db,c,j,input);
        if(requested){const request=requested.input;
          if(requested.kind!==j.kind||('runId'in request?request.runId!==input.runIds[0]:request.beforeRoundId!==input.body.runs[0]?.roundId||request.afterRoundId!==input.body.runs[1]?.roundId||reviewHash([request.objectPairs,request.materialGroups])!==reviewHash([input.objectPairs,input.materialGroups])))throw new AppError(409,notAllowed);
        }
        if(validity!=='current')throw new AppError(409,'analysis_source_stale');
        const family=await this.family(db,j,input);
        // A case lock serializes requests with different idempotency keys too. Old pages follow the saved chain.
        if(family.nextJobId)return {id:family.nextJobId,reused:true};
        if(family.unknown||!['ready','partial','failed','canceled'].includes(j.state))throw new AppError(409,notAllowed);
        if(action==='continue'&&retryableItems(body,family.batch).some(i=>i.state==='pending'))throw new AppError(409,notAllowed);
        const next=followupBatch(body,family.batch,parentId,action);
        if(!next.batch.itemIds.length)throw new AppError(409,notAllowed);
        if(Number((await db.query("SELECT count(*) AS n FROM business.review_analysis_jobs WHERE case_id=$1 AND state IN ('pending','running')",[caseId])).rows[0].n)>=4)throw new AppError(429,'analysis_queue_full');
        const id=randomUUID(),workId=randomUUID(),frozen:StoredInput={...input,body:next.body,batch:next.batch};
        const inputHash=reviewHash({parentId,action,sourceHash:j.source_hash,batch:next.batch});
        await db.query("INSERT INTO business.review_analysis_jobs(id,case_id,kind,account_id,person_id,auth_version,session_key,expected_revision,input_hash,source_hash,state) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'pending')",[id,caseId,j.kind,actor.accountId,actor.personId,actor.authVersion,actor.sessionKey??null,c.revision,inputHash,j.source_hash]);
        await db.query('INSERT INTO business.review_analysis_snapshots(job_id,body,body_hash) VALUES($1,$2,$3)',[id,JSON.stringify(frozen),reviewHash(frozen)]);
        await db.query("INSERT INTO business.work_items(id,owner_type,owner_id,kind,queue,max_attempts) VALUES($1,'Workflow',$2,'review_analysis','workflow',3)",[workId,id]);
        await db.query("INSERT INTO business.outbox(id,work_item_id,event_type,owner_id) VALUES($1,$2,'review_analysis_requested',$3)",[randomUUID(),workId,id]);
        await audit(db,{actorId:actor.accountId,targetId:caseId,action:action==='continue'?'review.analysis_continued':'review.analysis_retried',details:{jobId:id,parentJobId:parentId,batchNumber:next.batch.number,itemCount:next.batch.itemIds.length}});
        return {id,reused:false};
      });
    });
  }
  async claim(workId?:string):Promise<AnalysisWork|undefined>{
    if(this.stopping)return;
    return (await this.pool.query(`UPDATE business.work_items SET state='running',epoch=epoch+1,attempts=attempts+1,lease_until=now()+interval '180 seconds',updated_at=now()
      WHERE id=(SELECT w.id FROM business.work_items w JOIN business.review_analysis_jobs j ON j.id=w.owner_id WHERE w.owner_type='Workflow' AND w.kind='review_analysis'
      AND j.state IN ('pending','running') AND w.available_at<=now() AND (w.state='pending' OR w.state='running' AND w.lease_until<now()) AND ($1::uuid IS NULL OR w.id=$1)
      ORDER BY w.available_at,w.id FOR UPDATE OF w SKIP LOCKED LIMIT 1) RETURNING *`,[workId??null])).rows[0];
  }
  /** `source` re-reads the analysed sources, which rebuilds the case checklist (seconds on a large case) while the case
   * and its owner are locked. Each attempt checks them when it starts and before it stores or completes; the steps in
   * between check authorization, revision, job, lease and principal only, so the owner's own pages are not held up. */
  private async fence(db:PoolClient,j:AnalysisRow,input:StoredInput,work:AnalysisWork,source=true){
    if(this.stopping)throw new AppError(409,'worker_stopping');const c=await this.authorize(db,actorOf(j),j.case_id,true);
    if(c.revision!==j.expected_revision)throw new AppError(409,'stale_revision');
    const row=(await db.query("SELECT id FROM business.review_analysis_jobs WHERE id=$1 AND state IN ('pending','running') FOR UPDATE",[j.id])).rows[0];
    if(!row)throw new AppError(409,'analysis_canceled');
    const lease=(await db.query("SELECT id FROM business.work_items WHERE id=$1 AND owner_id=$2 AND epoch=$3 AND state='running' AND lease_until>now() FOR UPDATE",[work.id,j.id,work.epoch])).rows[0];
    if(!lease)throw new AppError(409,'lease_lost');
    if(!source){if(!await this.principalCurrent(db,c,j))throw new AppError(409,'analysis_source_stale');return;}
    if(await this.validity(db,c,j,input)==='stale')throw new AppError(409,'analysis_source_stale');
  }
  async processWork(work:AnalysisWork){
    const j=(await this.pool.query('SELECT * FROM business.review_analysis_jobs WHERE id=$1',[work.owner_id])).rows[0] as AnalysisRow|undefined;if(!j)return;
    const controller=new AbortController();this.active.add(controller);let input:StoredInput|undefined;
    const timer=setInterval(()=>{void this.pool.query("UPDATE business.work_items SET lease_until=now()+interval '180 seconds' WHERE id=$1 AND epoch=$2 AND state='running' AND lease_until>now() RETURNING id",[work.id,work.epoch]).then(r=>{if(!r.rowCount)controller.abort();}).catch(()=>controller.abort());},30000);timer.unref();
    try{
      const prepared=await transaction(this.pool,async db=>{input=await this.snapshot(db,j.id);await this.fence(db,j,input,work);await db.query("UPDATE business.review_analysis_jobs SET state='running',updated_at=now() WHERE id=$1",[j.id]);return {input,body:await this.body(db,j.id,input)};});
      const next=[...prepared.body.items,...prepared.body.changes].find(i=>i.state==='pending');
      if(next){
        let output:SemanticItem|MaterialChange;
        try{
          if(!this.config||!this.client)throw new ServiceError('review_assist_unavailable');
          const ids='ruleId'in next?next.evidenceIds:[...next.beforeEvidenceIds,...next.afterEvidenceIds],evidence=prepared.body.evidence.filter(e=>ids.includes(e.id));
          let dispatched=false;const durable=analysisDispatch(this.pool,j.id,next.id,db=>this.fence(db,j,prepared.input,work,false));
          const result=await analyzeEvidence({evidence,requirement:prepared.input.crossFile?{kind:'semantic',comparisonScope:prepared.input.crossFile.check.valueBasis==='extracted'?'extracted_values':'field_meaning',bankRuleScope:prepared.input.crossFile.check.valueBasis!=='extracted'&&prepared.input.crossFile.check.bankRule?'personal_workbook_field':undefined,text:'ruleText'in next?next.ruleText:'',suppliedValues:prepared.input.crossFile.check.valueBasis==='extracted'?prepared.input.crossFile.check.sources.map(({fieldId,label,documentId})=>({fieldId,label,documentId})):crossFileSuppliedValues(prepared.input.crossFile.check),boundaries:next.limitations,
              ...(prepared.input.crossFile.check.valueBasis!=='extracted'&&prepared.input.crossFile.check.guidance?.length?{caseGuidance:prepared.input.crossFile.check.guidance.map(({ref,label,kind,statement,fieldIds,expressions})=>({ref,label,kind,statement,fieldIds,expressions}))}:{})}:'ruleId'in next?{kind:'semantic',ruleId:next.ruleId,text:next.ruleText,sources:next.ruleSources,objectId:next.objectId,objectLabel:next.objectLabel,confirmedInputs:next.confirmedInputs,boundaries:next.limitations,originalProgramOutcome:next.originalOutcome,programChecks:next.programChecks}:{kind:'comparison',beforeIds:next.beforeEvidenceIds,afterIds:next.afterEvidenceIds,affectedRuleIds:next.affectedRuleIds},
            config:this.config,client:this.client,job:j,signal:controller.signal,authorize:()=>transaction(this.pool,async db=>{await this.fence(db,j,prepared.input,work,false);}),dispatch:async(body,start)=>{dispatched=true;return durable(body,start);}});
          if(!dispatched)throw new ServiceError('review_assist_dispatch_unrecorded');
          if('ruleId'in next){
            // Identity resemblance is never proof; these catalog entries retain a human decision even if wording is equivalent.
            const identity=next.kind==='identity'&&result.outcome==='consistent';
            output={...next,state:'complete',outcome:identity?'manual':result.outcome,reason:identity?`${result.reason}；主体同一性仍须依据确认记录人工核对。`:result.reason,
              citations:result.citations,limitations:[...next.limitations,...result.limitations],method:'model',simulated:result.simulated,
              ...(!identity&&result.appliedGuidance?.length?{appliedGuidance:result.appliedGuidance}:{})};
          }else output={...next,state:'complete',classification:result.outcome==='insufficient'||result.outcome==='manual'?'unknown':result.classification,reason:result.reason,citations:result.citations,limitations:[...next.limitations,...result.limitations],simulated:result.simulated};
        }catch(e){
          if(controller.signal.aborted||e instanceof AppError)throw e;
          const code=e instanceof ServiceError?e.code:'review_assist_invalid_output';
          output={...next,state:'failed',reason:`辅助分析未完成（${code}），不能据此判断一致或无变化。`,...('ruleId'in next?{outcome:'insufficient' as const}: {classification:'unknown' as const})};
        }
        // The completion step below checks the sources again before the job can finish.
        await transaction(this.pool,async db=>{await this.fence(db,j,prepared.input,work,false);controller.signal.throwIfAborted();await db.query('INSERT INTO business.review_analysis_items(job_id,item_id,body,body_hash) VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING',[j.id,next.id,JSON.stringify(output),reviewHash(output)]);});
      }
      await transaction(this.pool,async db=>{
        await this.fence(db,j,prepared.input,work);const body=await this.body(db,j.id,prepared.input),items=[...body.items,...body.changes];
        if(items.some(i=>i.state==='pending')){await db.query("UPDATE business.work_items SET state='pending',lease_until=NULL,available_at=now()+interval '1 second' WHERE id=$1 AND epoch=$2",[work.id,work.epoch]);return;}
        const partial=items.some(i=>i.state==='failed'||i.state==='unavailable'&&(!('kind'in i)||i.kind!=='outside_scope'))||body.limitations.length>0;
        await db.query('UPDATE business.review_analysis_jobs SET state=$2,updated_at=now() WHERE id=$1',[j.id,partial?'partial':'ready']);
        await db.query("UPDATE business.work_items SET state='succeeded',lease_until=NULL,updated_at=now() WHERE id=$1 AND epoch=$2",[work.id,work.epoch]);
        await db.query('INSERT INTO business.inbox(work_item_id,epoch) VALUES($1,$2) ON CONFLICT(work_item_id) DO UPDATE SET epoch=EXCLUDED.epoch,completed_at=now()',[work.id,work.epoch]);
        await audit(db,{actorId:j.account_id,targetId:j.case_id,action:'review.analysis_completed',details:{jobId:j.id,state:partial?'partial':'ready',count:items.length}});
      });
    }catch(e){const code=e instanceof AppError?e.code:'review_assist_failed';
      await transaction(this.pool,async db=>{const r=await db.query("UPDATE business.work_items SET state=$3,error_code=$4,lease_until=NULL WHERE id=$1 AND epoch=$2 AND state='running' AND lease_until>now() RETURNING id",[work.id,work.epoch,this.stopping?'pending':'rejected',code]);
        if(r.rowCount)await db.query("UPDATE business.review_analysis_jobs SET state=$2,error_code=$3,updated_at=now() WHERE id=$1 AND state IN ('pending','running')",[j.id,this.stopping?'pending':'failed',code]);});
    }finally{clearInterval(timer);this.active.delete(controller);controller.abort();}
  }
}

export function registerReviewAnalysisRoutes(app:FastifyInstance,auth:Auth,service:ReviewAnalysisService){
  const base='/api/cases/:caseId/review-delivery/analysis',path=(r:any)=>z.object({caseId:z.uuid(),id:z.uuid().optional()}).parse(r.params);
  app.get(base,async r=>service.state(await auth.requireSession(r),path(r).caseId));
  app.post(`${base}/cross-file`,async(r,reply)=>reply.code(202).send(await service.createCrossFile(await auth.checkWrite(r),path(r).caseId,r.body)));
  for(const kind of ['semantic','comparison'] as const)app.post(`${base}/${kind}`,async(r,reply)=>reply.code(202).send(await service.create(await auth.checkWrite(r),path(r).caseId,kind,r.body)));
  app.get(`${base}/:id`,async r=>{const p=path(r);return service.get(await auth.requireSession(r),p.caseId,p.id!);});
  app.post(`${base}/:id/cancel`,async r=>{const p=path(r);return service.cancel(await auth.checkWrite(r),p.caseId,p.id!);});
  app.post(`${base}/:id/retry`,async(r,reply)=>{const p=path(r);return reply.code(202).send(await service.retry(await auth.checkWrite(r),p.caseId,p.id!,r.body));});
  app.post(`${base}/:id/continue`,async(r,reply)=>{const p=path(r);return reply.code(202).send(await service.continue(await auth.checkWrite(r),p.caseId,p.id!,r.body));});
}
