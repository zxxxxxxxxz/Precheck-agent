import {randomUUID} from 'node:crypto';
import type {Pool,PoolClient} from 'pg';
import {AddHistoricalMaterialsSchema,type HistoricalMaterials,type AddedHistoricalMaterials} from '@hsbc/contracts/material-history';
import type {Actor} from '../identity/types.js';
import {authorizeCase} from '../cases/authorization.js';
import {transaction} from '../../infrastructure/database/client.js';
import {idempotent,inputHash} from '../../infrastructure/database/idempotency.js';
import {AppError} from '../../shared/errors.js';
import {assertRoundRequest} from '../review/round-boundary.js';
import {advanceReviewRevision} from '../review/service.js';
import {invalidateCheckerContent} from '../review-checker/access.js';
import {audit} from '../audit/events.js';
import {materialListIds,materialMembership,fixedMaterialSnapshot} from './review-scope.js';

async function candidates(db:PoolClient,c:any,roundId:string):Promise<HistoricalMaterials> {
  const target=(await db.query('SELECT number FROM business.review_rounds WHERE case_id=$1 AND id=$2',[c.id,roundId])).rows[0];
  if(!target)throw new AppError(404,'review_round_not_found');
  const rounds=(await db.query("SELECT id FROM business.review_rounds WHERE case_id=$1 AND number<$2 AND state='locked' ORDER BY number DESC",[c.id,target.number])).rows;
  const current=await materialMembership(db,c.id,roundId),present=new Set(current.documents.map(d=>d.source_document_version_id??d.id));
  const items:HistoricalMaterials['items']=[],seen=new Set<string>();
  for(const round of rounds){
    const included=await materialListIds(db,c.id,round.id),snapshot=await fixedMaterialSnapshot(db,c.id,round.id);
    const rows=(await db.query(`SELECT d.*,origin.id AS origin_id,origin.round_id AS origin_round,q.number AS origin_number
      FROM business.document_versions d JOIN business.upload_sessions u ON u.id=d.upload_session_id
      JOIN business.document_versions origin ON origin.id=coalesce(d.source_document_version_id,d.id)
      JOIN business.review_rounds q ON q.id=origin.round_id AND q.state='locked'
      WHERE d.case_id=$1 AND d.round_id=$2 AND u.state='registered' AND u.document_version_id=d.id ORDER BY d.created_at,d.id`,[c.id,round.id])).rows;
    for(const row of rows){
      if(included!==null&&!included.includes(row.id)||seen.has(row.origin_id))continue;
      seen.add(row.origin_id);
      items.push({id:row.id,sourceDocumentVersionId:row.origin_id,sourceRoundId:row.origin_round,uploadedRoundNumber:row.origin_number,
        filename:row.filename,size:Number(row.size),pageCount:row.page_count,format:row.source_format??'pdf',
        taxonomyIds:[...new Set<string>((snapshot?.materials??[]).filter((m:any)=>m.documentVersionId===row.id&&m.operation==='adopt').map((m:any)=>m.documentTypeId))],alreadyInCurrent:present.has(row.origin_id)});
    }
  }
  return {items};
}

export class MaterialHistoryService {
  constructor(private pool:Pool,private onRegistered?:(db:PoolClient,actor:Actor,c:any,id:string)=>Promise<void>){}
  async list(actor:Actor,caseId:string,roundId:string){return transaction(this.pool,async db=>{
    const c=await authorizeCase(db,actor,caseId,'case:read',false);return candidates(db,c,roundId);
  });}
  async add(actor:Actor,caseId:string,raw:unknown):Promise<AddedHistoricalMaterials>{
    const parsed=AddHistoricalMaterialsSchema.safeParse(raw);if(!parsed.success)throw new AppError(400,'invalid_historical_materials');
    const input=parsed.data;
    return transaction(this.pool,async db=>{
      const c=await authorizeCase(db,actor,caseId,'material:upload');
      await authorizeCase(db,actor,caseId,'material:adopt',false);
      await authorizeCase(db,actor,caseId,'evidence:read',false);
      await assertRoundRequest(db,c,input.roundId,{draft:true});
      return idempotent(db,actor,`materials.history:${caseId}`,input.idempotencyKey,input,async()=>{
        if(c.revision!==input.expectedRevision)throw new AppError(409,'case_revision_conflict');
        const available=(await candidates(db,c,input.roundId)).items;
        const selected=input.documentVersionIds.map(id=>available.find(row=>row.id===id));
        if(selected.some(row=>!row))throw new AppError(409,'historical_material_unavailable');
        if(selected.some(row=>row!.alreadyInCurrent))throw new AppError(409,'historical_material_already_added');
        await advanceReviewRevision(db,c);await invalidateCheckerContent(db,c.id);
        const ids:string[]=[];
        for(const item of selected){
          const source=(await db.query('SELECT d.*,u.mime_type FROM business.document_versions d JOIN business.upload_sessions u ON u.id=d.upload_session_id WHERE d.id=$1 AND d.case_id=$2 AND u.state=\'registered\' AND u.document_version_id=d.id',[item!.sourceDocumentVersionId,c.id])).rows[0];
          if(!source)throw new AppError(409,'historical_material_unavailable');
          const id=randomUUID(),uploadId=randomUUID();ids.push(id);
          await db.query(`INSERT INTO business.upload_sessions(id,case_id,round_id,account_id,person_id,auth_version,expected_revision,filename,expected_size,object_key,oss_version_id,state,idempotency_key,request_hash,expires_at,mime_type,source_kind,source_label,document_version_id,source_document_version_id)
            VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'registered',$12,$13,now(),$14,$15,$16,$17,$18)`,
            [uploadId,c.id,input.roundId,actor.accountId,actor.personId,actor.authVersion,c.revision,source.filename,source.size,source.object_key,source.oss_version_id,`history:${uploadId}`,inputHash({source:source.id,round:input.roundId}),source.mime_type,source.source_kind,source.source_label,id,source.id]);
          await db.query(`INSERT INTO business.document_versions(id,case_id,round_id,upload_session_id,filename,size,sha256,page_count,object_key,oss_version_id,uploaded_by,source_format,source_kind,source_label,source_document_version_id,created_at)
            VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)`,
            [id,c.id,input.roundId,uploadId,source.filename,source.size,source.sha256,source.page_count,source.object_key,source.oss_version_id,source.uploaded_by,source.source_format,source.source_kind,source.source_label,source.id,source.created_at]);
          await db.query('INSERT INTO business.parse_intents(document_version_id) VALUES($1)',[id]);
          await this.onRegistered?.(db,actor,c,id);
          await db.query("INSERT INTO business.outbox(id,event_type,owner_id) VALUES($1,'material.registered',$2)",[randomUUID(),id]);
        }
        await db.query("INSERT INTO business.review_events(id,case_id,round_id,case_revision,kind,actor_person_id,account_id,details) VALUES($1,$2,$3,$4,'historical_materials_added',$5,$6,$7)",[randomUUID(),c.id,input.roundId,c.revision,actor.personId,actor.accountId,JSON.stringify({documentVersionIds:ids,sourceDocumentVersionIds:selected.map(row=>row!.sourceDocumentVersionId)})]);
        await audit(db,{actorId:actor.accountId,targetId:c.id,action:'material.history_added',details:{roundId:input.roundId,count:ids.length}});
        return {documentVersionIds:ids,revision:c.revision};
      });
    });
  }
}
