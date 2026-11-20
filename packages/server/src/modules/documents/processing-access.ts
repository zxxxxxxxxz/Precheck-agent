import {assertRoundInputsOpen} from '../review/round-boundary.js';
import { randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { ProcessingAccessRequestSchema, ProcessingAccessDecisionSchema, ProcessingAccessWithdrawSchema, ProcessingAccessInboxQuerySchema, type ProcessingAccessState, type ProcessingAccessRequest, type ProcessingAccessInbox } from '@hsbc/contracts/document-processing-access';
import type { DocumentCloudConfig } from './cloud-extraction-config.js';
import type { DocumentReviewPort } from './ports.js';
import type { Actor } from '../identity/types.js';
import { hasGrant, requireGrant, requireBusinessRole, lockPersons } from '../identity/authorization.js';
import { authorizeCase } from '../cases/authorization.js';
import { audit } from '../audit/events.js';
import { transaction } from '../../infrastructure/database/client.js';
import { idempotent } from '../../infrastructure/database/idempotency.js';
import { AppError } from '../../shared/errors.js';

import {processingPolicyHash, policyLive, processingPolicySummary, currentPolicyDeclaration, policyProcessingPermit, demoPolicyProcessingPermit, type PolicyPermit, type DemoPolicyPermit} from './processing-policy.js';
export {processingPolicyHash} from './processing-policy.js';

type AccessRow = {
  id:string;case_id:string;version:number;state:ProcessingAccessRequest['status'];policy_hash:string;configuration_release_id:string;
  requester_account_id:string;requester_person_id:string;requester_auth_version:number;request_reason:string;
  include_future_materials:boolean;documents:{id:string;sha256:string}[];expires_at:Date;created_at:Date;
  decider_account_id:string|null;decider_person_id:string|null;decider_auth_version:number|null;decision_reason:string|null;
  approval_access_basis:'case'|'request'; requester_name?:string; decider_name?:string;
};
export type ProcessingPermit = DemoPolicyPermit|PolicyPermit|{kind:'static'}|{kind:'case';id:string;version:number;policyHash:string};
/** Take person fences before the case lock, matching identity revocation's lock order. */
export async function lockProcessingAuthority(db:PoolClient,actorPersonId:string,permit?:ProcessingPermit) {
  const row=permit?.kind==='case'?(await db.query('SELECT requester_person_id,decider_person_id FROM business.document_processing_access WHERE id=$1',[permit.id])).rows[0]:undefined;
  const declaration=permit?.kind==='policy'?(await db.query("SELECT actor_person_id FROM business.review_events WHERE id=$1 AND kind='processing_policy_declared'",[permit.id])).rows[0]:undefined;
  await lockPersons(db,[actorPersonId,...(row?[row.requester_person_id,row.decider_person_id].filter(Boolean):[]),...(declaration?[declaration.actor_person_id]:[])]);
}
export const staticProcessingAllowed=(config:DocumentCloudConfig|undefined,caseId:string,documentId:string)=>Boolean(policyLive(config)&&config!.cloud.policy.caseIds.includes(caseId)&&config!.cloud.policy.documentIds.includes(documentId));

async function currentAuthority(db:PoolClient,row:AccessRow,c:{maker_person_id:string;configuration_release_id?:string|null},config:DocumentCloudConfig) {
  if(!config.caseAuthorization||!policyLive(config)||row.state!=='approved'||row.expires_at.getTime()<=Date.now()||
    row.policy_hash!==processingPolicyHash(config)||row.configuration_release_id!==c.configuration_release_id||row.requester_person_id!==c.maker_person_id)return false;
  const principals=(await db.query('SELECT account_id,person_id,enabled,must_change,auth_version,business_role FROM business.principals WHERE account_id=ANY($1::uuid[])',[[row.requester_account_id,row.decider_account_id]])).rows;
  const valid=(accountId:string|null,personId:string|null,version:number|null)=>principals.some(p=>p.account_id===accountId&&p.person_id===personId&&p.enabled&&!p.must_change&&p.business_role==='BCO'&&p.auth_version===version);
  return valid(row.requester_account_id,row.requester_person_id,row.requester_auth_version)&&valid(row.decider_account_id,row.decider_person_id,row.decider_auth_version)&&
    await hasGrant(db,row.requester_person_id,'case:configure',row.case_id)&&await hasGrant(db,row.requester_person_id,'maker',row.case_id)&&
    await hasGrant(db,row.decider_person_id!,'document:authorize',row.case_id)&&
    (row.approval_access_basis==='request'||await hasGrant(db,row.decider_person_id!,'case:read',row.case_id));
}

/** Run in the caller's case transaction. A pinned case grant never falls back to another grant or a static permit. */
export async function documentProcessingPermit(db:PoolClient,config:DocumentCloudConfig|undefined,c:{id:string;maker_person_id:string;configuration_release_id?:string|null},document:{id:string;sha256:string;source_format?:string},pinned?:ProcessingPermit):Promise<ProcessingPermit|undefined> {
  if(!config||!policyLive(config))return;
  if(pinned&&!['static','case','policy','demo_policy'].includes(pinned.kind))return;
  if(pinned?.kind==='demo_policy')return demoPolicyProcessingPermit(db,config,c,document,pinned);
  if(pinned?.kind==='policy')return policyProcessingPermit(db,config,c,document,pinned);
  if(!pinned&&config.policyReuse)return demoPolicyProcessingPermit(db,config,c,document);
  if(pinned?.kind!=='case'&&staticProcessingAllowed(config,c.id,document.id))return {kind:'static'};
  if(pinned?.kind==='static'||!config.caseAuthorization||document.source_format!=='pdf')return;
  const row=(await db.query("SELECT * FROM business.document_processing_access WHERE case_id=$1 AND state='approved'",[c.id])).rows[0] as AccessRow|undefined;
  if(!row||pinned?.kind==='case'&&(pinned.id!==row.id||pinned.version!==row.version||pinned.policyHash!==row.policy_hash)||!await currentAuthority(db,row,c,config))return;
  if(!row.include_future_materials&&!row.documents.some(d=>d.id===document.id&&d.sha256===document.sha256))return;
  return {kind:'case',id:row.id,version:row.version,policyHash:row.policy_hash};
}

export class DocumentProcessingAccess {
  constructor(private readonly pool:Pool,private readonly config:DocumentCloudConfig|undefined,private readonly review:DocumentReviewPort){}
  policySummary=()=>processingPolicySummary(this.config);
  private async manifest(db:PoolClient,c:any) {
    if(!c.configuration_release_id)return;
    return (await this.review.getPublished(db,c.configuration_release_id)).manifest;
  }
  private async documents(db:PoolClient,caseId:string) {
    return (await db.query(`SELECT d.id,d.sha256,d.source_format,d.parse_status,d.current_parse_job_id,d.round_id FROM business.document_versions d
      JOIN business.upload_sessions u ON u.id=d.upload_session_id AND u.document_version_id=d.id AND u.state='registered'
      WHERE d.case_id=$1 ORDER BY d.id`,[caseId])).rows;
  }
  private async effective(db:PoolClient,row:AccessRow,c:any):Promise<ProcessingAccessRequest['effectiveStatus']> {
    if(['rejected','revoked','withdrawn'].includes(row.state))return row.state;
    if(row.expires_at.getTime()<=Date.now()||!policyLive(this.config))return 'expired';
    if(!this.config?.caseAuthorization||row.policy_hash!==processingPolicyHash(this.config)||row.configuration_release_id!==c.configuration_release_id||row.requester_person_id!==c.maker_person_id)return 'changed';
    if(row.state==='approved'&&!await currentAuthority(db,row,c,this.config))return 'changed';
    return row.state;
  }
  private async approverCount(db:PoolClient,c:{id:string;maker_person_id:string}) {
    return Number((await db.query(`SELECT count(DISTINCT p.person_id) AS count FROM business.principals p
      WHERE p.enabled AND NOT p.must_change AND p.business_role='BCO' AND p.person_id<>$2
      AND EXISTS(SELECT 1 FROM business.access_grants g WHERE g.person_id=p.person_id AND NOT g.revoked
        AND g.action='document:authorize' AND (g.case_id IS NULL OR g.case_id=$1))`,[c.id,c.maker_person_id])).rows[0].count);
  }
  private async present(db:PoolClient,row:AccessRow,c:any,actor:Actor,canDecide:boolean,canWithdraw=false):Promise<ProcessingAccessRequest> {
    const effectiveStatus=await this.effective(db,row,c);
    const independent=canDecide&&row.requester_person_id!==actor.personId&&c.maker_person_id!==actor.personId;
    return {id:row.id,version:row.version,status:row.state,effectiveStatus,requestedAt:row.created_at.toISOString(),expiresAt:row.expires_at.toISOString(),
      includeFutureMaterials:row.include_future_materials,documentCount:row.documents.length,reason:row.request_reason,decisionReason:row.decision_reason,
      requesterName:row.requester_name??'已记录申请人',deciderName:row.decider_name??null,
      canApprove:!this.config?.policyReuse&&independent&&effectiveStatus==='pending',canReject:independent&&row.state==='pending',canRevoke:canDecide&&row.state==='approved',
      canWithdraw:canWithdraw&&row.state==='pending'};
  }
  /** Only request metadata is visible through document:authorize. Never grants case/evidence read access. */
  async inbox(actor:Actor,raw:unknown):Promise<ProcessingAccessInbox> {
    const input=ProcessingAccessInboxQuerySchema.parse(raw),pageSize=20;
    return transaction(this.pool,async db=>{
      await requireBusinessRole(db,actor);
      const policy=this.policySummary();
      if(!this.config?.caseAuthorization||policy&&input.status==='pending')return {items:[],total:0,page:input.page,pageSize,...(policy?{policy}:{})};
      const from=`FROM business.document_processing_access a JOIN business.cases c ON c.id=a.case_id
        WHERE a.state=$2 AND a.requester_person_id<>$1 AND c.maker_person_id<>$1
        AND EXISTS(SELECT 1 FROM business.access_grants g WHERE g.person_id=$1 AND g.action='document:authorize'
          AND NOT g.revoked AND (g.case_id IS NULL OR g.case_id=a.case_id))`;
      const total=Number((await db.query(`SELECT count(*) AS count ${from}`,[actor.personId,input.status])).rows[0].count);
      const rows=(await db.query(`SELECT a.*,c.title,c.reference,c.revision,c.maker_person_id,c.configuration_release_id AS current_configuration,
        (SELECT display_name FROM auth.people WHERE id=a.requester_person_id) AS requester_name,
        (SELECT display_name FROM auth.people WHERE id=a.decider_person_id) AS decider_name
        ${from} ORDER BY a.created_at,a.id LIMIT $3 OFFSET $4`,[actor.personId,input.status,pageSize,(input.page-1)*pageSize])).rows;
      const items=[];
      for(const row of rows)items.push({...await this.present(db,row,{maker_person_id:row.maker_person_id,configuration_release_id:row.current_configuration},actor,true),
        caseId:row.case_id,caseTitle:row.title,caseReference:row.reference,caseRevision:row.revision});
      return {items,total,page:input.page,pageSize,...(policy?{policy}:{})};
    });
  }
  async state(actor:Actor,caseId:string):Promise<ProcessingAccessState> {
    return transaction(this.pool,async db=>{
      const c=await authorizeCase(db,actor,caseId,'case:read');
      const docs=await this.documents(db,caseId),manifest=await this.manifest(db,c);
      const configurationReady=manifest?.scope==='synthetic'&&manifest.fields.some(f=>f.recipe.mode==='cloud_grounded_extract')===true;
      const available=policyLive(this.config),managedEnabled=!!this.config?.caseAuthorization;
      let inputsOpen=true;try{await assertRoundInputsOpen(db,c);}catch(error){if(!(error instanceof AppError))throw error;inputsOpen=false;}
      const canManage=c.maker_person_id===actor.personId&&await hasGrant(db,actor.personId,'case:configure',caseId)&&await hasGrant(db,actor.personId,'maker',caseId);
      const canRequest=inputsOpen&&canManage;
      const canDecide=await hasGrant(db,actor.personId,'document:authorize',caseId);
      const eligibleApproverCount=!this.config?.policyReuse&&managedEnabled&&canRequest?await this.approverCount(db,c):0;
      const requests:ProcessingAccessRequest[]=[];
      // No table access while disabled makes the compatibility build safe before migration.
      const rows=managedEnabled?(await db.query(`SELECT a.*,r.display_name AS requester_name,d.display_name AS decider_name
        FROM business.document_processing_access a LEFT JOIN auth.people r ON r.id=a.requester_person_id
        LEFT JOIN auth.people d ON d.id=a.decider_person_id WHERE a.case_id=$1 ORDER BY a.created_at DESC LIMIT 30`,[caseId])).rows:[];
      for(const row of rows)requests.push(await this.present(db,row,c,actor,canDecide,canRequest));
      let authorizedCount=0,resumableCount=0;
      for(const doc of docs){if(configurationReady&&await documentProcessingPermit(db,this.config,c,doc)){
        authorizedCount++;
        if(inputsOpen&&(doc.round_id??null)===(c.current_round_id??null)&&!doc.current_parse_job_id&&['parked','capability_disabled','configuration_required'].includes(doc.parse_status))resumableCount++;
      }}
      const policy=this.policySummary(),declaration=policy?await currentPolicyDeclaration(db,this.config,c):undefined;
      return {...(policy?{policy,declaration}:{}),available,managedEnabled,dataClass:'public_synthetic',policyExpiresAt:this.config?.cloud.policy.expiresAt??null,configurationReady,revision:c.revision,
        registeredCount:docs.length,authorizedCount,resumableCount,coversFutureMaterials:policy?available&&configurationReady:requests.some(r=>r.effectiveStatus==='approved'&&r.includeFutureMaterials),requests,eligibleApproverCount,
        allowedActions:[...(!policy&&available&&managedEnabled&&configurationReady&&canRequest?['request' as const]:[]),...(resumableCount>0&&await hasGrant(db,actor.personId,'document:parse',caseId)?['resume' as const]:[])]};
    });
  }
  async request(actor:Actor,caseId:string,raw:unknown) {
    const input=ProcessingAccessRequestSchema.parse(raw);
    return transaction(this.pool,async db=>{
      const c=await authorizeCase(db,actor,caseId,'case:configure');
      if(c.revision!==input.expectedRevision)throw new AppError(409,'stale_revision');
      if(this.config?.policyReuse)throw new AppError(409,'processing_policy_automatic');
      if(!this.config?.caseAuthorization||!policyLive(this.config))throw new AppError(409,'processing_access_unavailable');
      const manifest=await this.manifest(db,c);
      if(manifest?.scope!=='synthetic'||!manifest.fields.some(f=>f.recipe.mode==='cloud_grounded_extract'))throw new AppError(409,'processing_access_configuration_required');
      return idempotent(db,actor,`processing-access.request:${caseId}`,input.idempotencyKey,input,async()=>{
        await db.query("UPDATE business.document_processing_access SET state='revoked',version=version+1,revoked_at=now() WHERE case_id=$1 AND state='pending' AND (expires_at<=now() OR policy_hash<>$2 OR configuration_release_id<>$3 OR requester_person_id<>$4)",[caseId,processingPolicyHash(this.config!),c.configuration_release_id,actor.personId]);
        if((await db.query("SELECT 1 FROM business.document_processing_access WHERE case_id=$1 AND state='pending'",[caseId])).rowCount)throw new AppError(409,'processing_access_pending');
        if(!await this.approverCount(db,c))throw new AppError(409,'processing_access_no_approver');
        const docs=(await this.documents(db,caseId)).filter(d=>d.source_format==='pdf').map(d=>({id:d.id,sha256:d.sha256}));
        if(!docs.length&&!input.includeFutureMaterials)throw new AppError(422,'processing_access_empty_scope');
        const id=randomUUID(),expiresAt=new Date(Math.min(Date.now()+input.durationDays*86400000,Date.parse(this.config!.cloud.policy.expiresAt)));
        await db.query(`INSERT INTO business.document_processing_access(id,case_id,state,policy_hash,configuration_release_id,requester_account_id,requester_person_id,requester_auth_version,request_reason,include_future_materials,documents,expires_at)
          VALUES($1,$2,'pending',$3,$4,$5,$6,$7,$8,$9,$10,$11)`,[id,caseId,processingPolicyHash(this.config!),c.configuration_release_id,actor.accountId,actor.personId,actor.authVersion,input.reason,input.includeFutureMaterials,JSON.stringify(docs),expiresAt]);
        await audit(db,{actorId:actor.accountId,targetId:id,action:'document:processing_access_requested',details:{caseId,documentCount:docs.length,includeFutureMaterials:input.includeFutureMaterials,dataClass:'public_synthetic'}});
        return {id,status:'pending',version:1};
      });
    });
  }
  async withdraw(actor:Actor,caseId:string,raw:unknown) {
    const input=ProcessingAccessWithdrawSchema.parse(raw);
    return transaction(this.pool,async db=>{
      const c=await authorizeCase(db,actor,caseId,'case:configure');
      if(c.revision!==input.expectedRevision)throw new AppError(409,'stale_revision');
      if(!this.config?.caseAuthorization)throw new AppError(409,'processing_access_unavailable');
      return idempotent(db,actor,`processing-access.withdraw:${caseId}`,input.idempotencyKey,input,async()=>{
        const row=(await db.query('SELECT * FROM business.document_processing_access WHERE id=$1 AND case_id=$2 FOR UPDATE',[input.requestId,caseId])).rows[0] as AccessRow|undefined;
        if(!row)throw new AppError(404,'processing_access_not_found');
        if(row.state!=='pending'||row.version!==input.requestVersion)throw new AppError(409,'processing_access_conflict');
        await db.query(`UPDATE business.document_processing_access SET state='withdrawn',version=version+1,
          decider_account_id=$2,decider_person_id=$3,decider_auth_version=$4,decision_reason=$5,decided_at=now()
          WHERE id=$1`,[row.id,actor.accountId,actor.personId,actor.authVersion,input.reason]);
        await audit(db,{actorId:actor.accountId,targetId:row.id,action:'document:processing_access_withdrawn',details:{caseId,reason:input.reason}});
        return {id:row.id,status:'withdrawn',version:row.version+1};
      });
    });
  }
  async decide(actor:Actor,caseId:string,raw:unknown,requestOnly=false) {
    const input=ProcessingAccessDecisionSchema.parse(raw);
    if(this.config?.policyReuse&&input.decision==='approve')throw new AppError(409,'processing_policy_automatic');
    return transaction(this.pool,async db=>{
      // Acquire every authority fence before the case lock (including requester revocation).
      const authority=this.config?.caseAuthorization?(await db.query('SELECT requester_person_id,decider_person_id FROM business.document_processing_access WHERE id=$1 AND case_id=$2',[input.requestId,caseId])).rows[0]:undefined;
      await lockPersons(db,[actor.personId,...(authority?[authority.requester_person_id,authority.decider_person_id].filter(Boolean):[])]);
      await requireGrant(db,actor,'document:authorize',caseId);
      const c=requestOnly?(await db.query('SELECT * FROM business.cases WHERE id=$1 FOR UPDATE',[caseId])).rows[0]:await authorizeCase(db,actor,caseId,'case:read');
      if(!c)throw new AppError(404,'processing_access_not_found');
      if(c.revision!==input.expectedRevision)throw new AppError(409,'stale_revision');
      if(!this.config?.caseAuthorization)throw new AppError(409,'processing_access_unavailable');
      return idempotent(db,actor,`processing-access.decide:${caseId}`,input.idempotencyKey,input,async()=>{
        const row=(await db.query('SELECT * FROM business.document_processing_access WHERE id=$1 AND case_id=$2 FOR UPDATE',[input.requestId,caseId])).rows[0] as AccessRow|undefined;
        if(!row)throw new AppError(404,'processing_access_not_found');
        if(row.version!==input.requestVersion)throw new AppError(409,'processing_access_conflict');
        if(input.decision==='revoke'){
          if(row.state!=='approved')throw new AppError(409,'processing_access_conflict');
          await db.query("UPDATE business.document_processing_access SET state='revoked',version=version+1,revoked_at=now() WHERE id=$1",[row.id]);
        }else{
          if(row.state!=='pending')throw new AppError(409,'processing_access_conflict');
          if(row.requester_person_id===actor.personId||c.maker_person_id===actor.personId)throw new AppError(403,'processing_access_self_approval');
          if(input.decision==='approve'){
            if(await this.effective(db,row,c)!=='pending')throw new AppError(409,'processing_access_changed');
            const docs=(await this.documents(db,caseId)).filter(d=>d.source_format==='pdf').map(d=>({id:d.id,sha256:d.sha256}));
            if(JSON.stringify(docs)!==JSON.stringify(row.documents))throw new AppError(409,'processing_access_materials_changed');
            const p=(await db.query('SELECT * FROM business.principals WHERE account_id=$1',[row.requester_account_id])).rows[0];
            if(!p?.enabled||p.must_change||p.business_role!=='BCO'||p.auth_version!==row.requester_auth_version||!await hasGrant(db,row.requester_person_id,'case:configure',caseId)||!await hasGrant(db,row.requester_person_id,'maker',caseId))throw new AppError(409,'processing_access_changed');
            await db.query("UPDATE business.document_processing_access SET state='revoked',version=version+1,revoked_at=now() WHERE case_id=$1 AND state='approved'",[caseId]);
          }
          await db.query(`UPDATE business.document_processing_access SET state=$2,version=version+1,decider_account_id=$3,decider_person_id=$4,decider_auth_version=$5,decision_reason=$6,decided_at=now(),approval_access_basis=$7 WHERE id=$1`,
            [row.id,input.decision==='approve'?'approved':'rejected',actor.accountId,actor.personId,actor.authVersion,input.reason,requestOnly?'request':'case']);
        }
        await audit(db,{actorId:actor.accountId,targetId:row.id,action:`document:processing_access_${input.decision}`,details:{caseId,reason:input.reason}});
        return {id:row.id,status:input.decision==='approve'?'approved':input.decision==='reject'?'rejected':'revoked',version:row.version+1};
      });
    });
  }
}
