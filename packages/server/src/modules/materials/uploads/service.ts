import {materialListIds} from '../review-scope.js';
import {assertRoundRequest} from '../../review/round-boundary.js';
import type { ClaimedWork } from '../../../infrastructure/jobs/types.js';
import { randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { z } from 'zod';
import { DraftSourceSchema } from '@hsbc/contracts/draft';
import { AppError } from '../../../shared/errors.js';
import { audit } from '../../audit/events.js';
import { authorizeCase } from '../../cases/authorization.js';
import { hasGrant } from '../../identity/authorization.js';
import { inputHash } from '../../../infrastructure/database/idempotency.js';
import { transaction } from '../../../infrastructure/database/client.js';
import { type Actor } from '../../identity/types.js';
import { OssObjectStore, type ObjectStore, type UploadConfig } from '../../../infrastructure/integrations/oss.js';
import { ServiceError } from '../../../infrastructure/integrations/http.js';
import { parseRange, verifyPdf } from './pdf.js';
import { verifyDocx } from '../../../document/docx.js';
import { DocxError } from '../../../document/docx-zip.js';
import {DRAFT_ATTACHMENT_LIMITS, DraftAttachmentMimeSchema} from '@hsbc/contracts/draft-attachment';
import { assertOpenDraft, authorizeDraft } from '../../cases/draft-state.js';
import {verifyImage} from './image.js';

export const DOCX_MIME='application/vnd.openxmlformats-officedocument.wordprocessingml.document';
export const MaterialSource = DraftSourceSchema;
export type MaterialParseStatusProjection=(caseRow:{configuration_release_id?:string|null},document:{parse_status:string;current_parse_job_id?:string|null;source_format?:string|null})=>string;

const UploadCommon = z.strictObject({ expectedRevision: z.number().int().positive(),
  filename: z.string().trim().min(1).max(255).refine(value => !/[\x00-\x1f\x7f/\\]/.test(value)),
  size: z.number().int().positive(), idempotencyKey: z.string().min(8).max(200),source:MaterialSource.optional() });
export const UploadRequest = z.discriminatedUnion('purpose',[
  UploadCommon.extend({purpose:z.literal('case_document'),caseId:z.uuid(),roundId:z.uuid().optional(),mimeType:z.enum(['application/pdf',DOCX_MIME,'image/jpeg','image/png'])}),
  UploadCommon.extend({purpose:z.literal('draft_attachment'),draftId:z.uuid(),mimeType:DraftAttachmentMimeSchema}),
]);
type UploadRow = {
  round_id:string|null; id: string; case_id: string|null; draft_id:string|null; account_id: string; person_id: string; auth_version: number; expected_revision: number;
  filename: string; expected_size: string; object_key: string; oss_version_id: string | null; mime_type?:string;
  state: 'issued'|'verifying'|'registered'|'rejected'|'expired'|'canceled'; request_hash: string;
  error_code: string | null; document_version_id: string | null; expires_at: Date; created_at: Date;
  source_kind: 'maker'|'external_rm'|'unknown'; source_label: string|null;
};
const actorOf = (row: UploadRow): Actor => ({ accountId: row.account_id, personId: row.person_id, authVersion: row.auth_version });
const snapshot = (row: UploadRow) => ({ roundId:row.round_id??null,id: row.id, caseId: row.case_id, state: row.state, filename: row.filename,
  ...(row.draft_id?{draftId:row.draft_id,attachmentId:row.state==='registered'?row.id:undefined}:{}),
  expiresAt: row.expires_at.toISOString(), errorCode: row.error_code ?? undefined, documentVersionId: row.document_version_id ?? undefined,
  source:{kind:row.source_kind??'unknown',...(row.source_label?{label:row.source_label}:{})} });
export class UploadService {
  readonly store: ObjectStore;
  constructor(readonly pool: Pool, readonly config: UploadConfig, store?: ObjectStore,
    private readonly onRegistered?: (db:PoolClient,actor:Actor,caseRow:any,documentId:string)=>Promise<void>,
    private readonly materialParseStatus?:MaterialParseStatusProjection) { this.store = store ?? new OssObjectStore(config); }
  private async session(client: PoolClient, id: string, actor?: Actor, lock = false): Promise<UploadRow> {
    const row = (await client.query(`SELECT * FROM business.upload_sessions WHERE id=$1 ${lock ? 'FOR UPDATE' : ''}`, [id])).rows[0] as UploadRow | undefined;
    if (!row || actor && row.person_id !== actor.personId) throw new AppError(404, 'upload_not_found');
    return row;
  }
  private async authorizedSession(client: PoolClient, actor: Actor, id: string, action: string, lock = false) {
    const preliminary = await this.session(client, id, actor);
    const caseRow = preliminary.draft_id ? await authorizeDraft(client,actor,preliminary.draft_id,lock) : await authorizeCase(client, actor, preliminary.case_id!, action, lock);
    if(preliminary.draft_id&&action!=='case:read'&&caseRow.status!=='open')throw new AppError(409,'draft_closed');
    if(!preliminary.draft_id&&action!=='case:read')await assertRoundRequest(client,caseRow,preliminary.round_id??undefined,{draft:true});
    const row = lock ? await this.session(client, id, actor, true) : preliminary;
    return { row, caseRow };
  }
  private limit(mimeType?:string){return mimeType===DOCX_MIME?this.config.maxDocxBytes??DRAFT_ATTACHMENT_LIMITS.docxBytes:mimeType?.startsWith('image/')?DRAFT_ATTACHMENT_LIMITS.imageBytes:this.config.maxBytes;}
  async issue(actor: Actor, input: unknown) {
    const parsed = UploadRequest.safeParse(input); if (!parsed.success) throw new AppError(400, 'invalid_upload_request');
    const request = parsed.data;
    const docx=request.mimeType===DOCX_MIME,draftUpload=request.purpose==='draft_attachment';
    if(docx&&!draftUpload&&!this.config.docxEnabled)throw new AppError(409,'docx_capability_disabled');
    const extension=request.mimeType==='image/jpeg'?'jpg':request.mimeType==='image/png'?'png':docx?'docx':'pdf';
    if(!(extension==='jpg'?/\.jpe?g$/i:new RegExp(`\\.${extension}$`,'i')).test(request.filename))throw new AppError(400,'upload_extension_mismatch');
    if (request.size > this.limit(request.mimeType)) throw new AppError(413, 'upload_size_exceeded');
    if (!this.config.enabled) throw new AppError(503, 'upload_unavailable');
    return transaction(this.pool, async client => {
      const caseRow = draftUpload ? await authorizeDraft(client,actor,request.draftId) : await authorizeCase(client, actor, request.caseId, 'material:upload');
      if(!draftUpload)await assertRoundRequest(client,caseRow,request.roundId,{draft:true});
      if(draftUpload&&caseRow.status!=='open')throw new AppError(409,'draft_closed');
      if(!draftUpload&&caseRow.revision !== request.expectedRevision) throw new AppError(409, 'case_revision_conflict');
      const hash = inputHash(request);
      const existing = (await client.query('SELECT * FROM business.upload_sessions WHERE account_id=$1 AND idempotency_key=$2', [actor.accountId, request.idempotencyKey])).rows[0] as UploadRow | undefined;
      if (existing) {
        if (existing.request_hash !== hash) throw new AppError(409, 'idempotency_conflict');
        if (existing.state !== 'issued') return snapshot(existing);
        if (existing.expires_at.getTime() <= Date.now()) throw new AppError(409, 'upload_expired');
        const signed = await this.store.sign(existing.object_key, Number(existing.expected_size), existing.expires_at,existing.mime_type??'application/pdf');
        await client.query('UPDATE business.upload_sessions SET expires_at=LEAST(expires_at,$2) WHERE id=$1',[existing.id,signed.expiresAt]);
        return { ...snapshot(existing), ...signed };
      }
      if(draftUpload){
        assertOpenDraft(caseRow as any,request.expectedRevision);
        const totals=(await client.query(`SELECT count(*) AS count,COALESCE(sum(u.expected_size),0) AS size FROM business.upload_sessions u LEFT JOIN business.draft_attachments a ON a.id=u.id
          WHERE u.draft_id=$1 AND u.state IN ('issued','verifying','registered') AND (a.id IS NULL OR a.state='active')`,[request.draftId])).rows[0];
        if(Number(totals.count)>=DRAFT_ATTACHMENT_LIMITS.count||Number(totals.size)+request.size>DRAFT_ATTACHMENT_LIMITS.totalBytes)throw new AppError(413,'draft_attachment_budget_exceeded');
      }
      const id = randomUUID(), key = `${this.config.prefix}uploads/${id}/${randomUUID()}.${extension}`;
      const signed = await this.store.sign(key, request.size, new Date(Date.now() + this.config.ttlSeconds * 1000), request.mimeType);
      await client.query(`INSERT INTO business.upload_sessions(id,case_id,account_id,person_id,auth_version,expected_revision,filename,expected_size,object_key,state,idempotency_key,request_hash,expires_at,mime_type,source_kind,source_label,draft_id,round_id)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,'issued',$10,$11,$12,$13,$14,$15,$16,$17)`,
      [id, draftUpload?null:request.caseId, actor.accountId, actor.personId, actor.authVersion, request.expectedRevision, request.filename, request.size, key, request.idempotencyKey, hash, signed.expiresAt,request.mimeType,request.source?.kind??'unknown',request.source?.label??null,draftUpload?request.draftId:null,draftUpload?null:request.roundId??null]);
      const owner:Record<string,string>=draftUpload?{draftId:request.draftId}:{caseId:request.caseId};
      await audit(client, { actorId: actor.accountId, targetId: id, action: 'upload:issue', details: owner });
      return { id, ...owner, state: 'issued' as const, ...signed };
    });
  }
  async get(actor: Actor, id: string) {
    return transaction(this.pool, async client => { const { row } = await this.authorizedSession(client, actor, id, 'case:read'); return snapshot(row); });
  }
  private async enqueue(client: PoolClient, row: UploadRow, versionId: string) {
    await client.query("UPDATE business.upload_sessions SET state='verifying',oss_version_id=$2,updated_at=now() WHERE id=$1", [row.id,versionId]);
    const id = randomUUID();
    const work = (await client.query(`INSERT INTO business.work_items(id,owner_type,owner_id,kind,queue) VALUES($1,'UploadSession',$2,'verify_pdf','document')
      ON CONFLICT(owner_type,owner_id,kind) DO UPDATE SET owner_id=EXCLUDED.owner_id RETURNING id`, [id,row.id])).rows[0];
    await client.query("INSERT INTO business.outbox(id,work_item_id,event_type,owner_id) VALUES($1,$2,'work.available',$3) ON CONFLICT(work_item_id,event_type) DO NOTHING", [randomUUID(),work.id,row.id]);
  }
  async complete(actor: Actor, id: string, requestedVersion?: string) {
    const row = await transaction(this.pool, async client => {
      const { row, caseRow } = await this.authorizedSession(client, actor, id, 'material:upload');
      if (row.state !== 'issued') return row;
      if (!row.draft_id&&caseRow.revision !== row.expected_revision) throw new AppError(409, 'case_revision_conflict');
      return row;
    });
    if (row.state !== 'issued') {
      if (requestedVersion && row.oss_version_id && row.oss_version_id !== requestedVersion) throw new AppError(409, 'upload_version_conflict');
      return snapshot(row);
    }
    const metadata = await this.store.head(row.object_key, requestedVersion);
    if (metadata.size !== Number(row.expected_size) || metadata.size > this.limit(row.mime_type)) throw new AppError(400, 'upload_size_mismatch');
    if (metadata.lastModified.getTime() > row.expires_at.getTime() + 30_000) throw new AppError(409, 'upload_expired');
    return transaction(this.pool, async client => {
      const { row: current, caseRow } = await this.authorizedSession(client, actor, id, 'material:upload', true);
      if (current.state !== 'issued') {
        if (current.oss_version_id && current.oss_version_id !== metadata.versionId) throw new AppError(409, 'upload_version_conflict');
        return snapshot(current);
      }
      if (!current.draft_id&&caseRow.revision !== current.expected_revision) throw new AppError(409, 'case_revision_conflict');
      await this.enqueue(client, current, metadata.versionId);
      await audit(client,{actorId:actor.accountId,targetId:id,action:'upload:complete'});
      return snapshot({ ...current, state: 'verifying', oss_version_id: metadata.versionId });
    });
  }
  async cancel(actor: Actor, id: string) {
    return transaction(this.pool, async client => {
      const { row } = await this.authorizedSession(client,actor,id,'material:upload',true);
      if (row.state === 'registered') throw new AppError(409,'upload_already_registered');
      if (['canceled','rejected','expired'].includes(row.state)) return snapshot(row);
      await client.query("UPDATE business.upload_sessions SET state='canceled',updated_at=now() WHERE id=$1",[id]);
      await client.query("UPDATE business.work_items SET state='canceled',epoch=epoch+1,lease_until=NULL,updated_at=now() WHERE owner_type='UploadSession' AND owner_id=$1 AND state IN ('pending','running')",[id]);
      await audit(client,{actorId:actor.accountId,targetId:id,action:'upload:cancel'});
      return snapshot({...row,state:'canceled'});
    });
  }
  async materials(actor: Actor, caseId: string,selected?:string|'legacy') {
    return transaction(this.pool,async client=>{
      const caseRow=await authorizeCase(client,actor,caseId,'case:read',false);
      const roundId=selected==='legacy'?null:selected??caseRow.current_round_id??null;
      if(roundId&&!(await client.query('SELECT 1 FROM business.review_rounds WHERE id=$1 AND case_id=$2',[roundId,caseId])).rowCount)throw new AppError(404,'review_round_not_found');
      const empty=caseRow.review_rounds_enabled&&!roundId&&selected!=='legacy';
      const canRead=await hasGrant(client,actor.personId,'evidence:read',caseId);
      // API-only projection. Worker verification never reads the auth schema.
      const rows=(await client.query(`SELECT d.*,p.display_name AS uploaded_by_name,q.number AS uploaded_round_number FROM business.document_versions d
        LEFT JOIN business.document_versions origin ON origin.id=d.source_document_version_id
        LEFT JOIN business.review_rounds q ON q.id=coalesce(origin.round_id,d.round_id)
        LEFT JOIN auth.people p ON p.id=d.uploaded_by WHERE d.case_id=$1 AND d.round_id IS NOT DISTINCT FROM $2::uuid AND NOT $3::boolean ORDER BY d.created_at DESC,d.id`,[caseId,roundId,!!empty])).rows;
      const included=await materialListIds(client,caseId,roundId);
      return {items:rows.filter(row=>included===null||included.includes(row.id)).map(row=>({roundId:row.round_id??null,uploadedRoundNumber:row.uploaded_round_number??null,historySourceDocumentId:row.source_document_version_id??null,id:row.id,filename:row.filename,size:Number(row.size),sha256:row.sha256,ossVersionId:row.oss_version_id,
        format:row.source_format??'pdf',pageCount:row.page_count,createdAt:row.created_at.toISOString(),uploadedBy:row.uploaded_by,uploadedByName:row.uploaded_by_name??null,
        source:{kind:row.source_kind??'unknown',...(row.source_label?{label:row.source_label}:{})},parseStatus:this.materialParseStatus?.(caseRow,row)??row.parse_status,allowed_actions:canRead?['evidence:read']:[]}))};
    });
  }
  async content(actor: Actor, caseId: string, id: string, rangeHeader?: string) {
    const row = await transaction(this.pool,async client=>{
      await authorizeCase(client,actor,caseId,'evidence:read',false);
      const row=(await client.query(`SELECT d.* FROM business.document_versions d JOIN business.upload_sessions u ON u.id=d.upload_session_id
        WHERE d.id=$1 AND d.case_id=$2 AND u.state='registered' AND u.document_version_id=d.id`,[id,caseId])).rows[0];
      if (!row) throw new AppError(404,'material_not_found'); return row;
    });
    const range=parseRange(rangeHeader,Number(row.size));
    const bytes=await this.store.read(row.object_key,row.oss_version_id,range?range.end-range.start+1:this.config.maxBytes,range);
    await transaction(this.pool,async client=>{await authorizeCase(client,actor,caseId,'evidence:read',false);
      await audit(client,{actorId:actor.accountId,targetId:id,action:'evidence:read',details:{ranged:Boolean(range)}});});
    return {bytes,filename:row.filename,size:Number(row.size),range,mimeType:row.source_format==='docx'?DOCX_MIME:row.source_format==='png'?'image/png':row.source_format==='jpg'?'image/jpeg':'application/pdf'};
  }
  async claim(workId?: string): Promise<ClaimedWork | undefined> {
    const r=await this.pool.query(`UPDATE business.work_items SET state='running',attempts=attempts+1,epoch=epoch+1,lease_until=now()+interval '90 seconds',updated_at=now()
      WHERE id=(SELECT id FROM business.work_items WHERE kind='verify_pdf' AND owner_type='UploadSession' AND available_at<=now()
        AND (state='pending' OR state='running' AND lease_until<now()) AND ($1::uuid IS NULL OR id=$1)
        ORDER BY available_at FOR UPDATE SKIP LOCKED LIMIT 1) RETURNING *`,[workId??null]); return r.rows[0];
  }
  async verifyWork(work: ClaimedWork) {
    const row=(await this.pool.query('SELECT * FROM business.upload_sessions WHERE id=$1',[work.owner_id])).rows[0] as UploadRow|undefined;
    if (!row) return this.failWork(work,new ServiceError('upload_not_found'));
    try {
      if (work.attempts > work.max_attempts) throw new ServiceError('work_attempts_exhausted');
      await transaction(this.pool,async client=>{
        const {caseRow}=await this.authorizedSession(client,actorOf(row),row.id,'material:upload');
        if (!row.draft_id&&caseRow.revision!==row.expected_revision) throw new AppError(409,'case_revision_conflict');
      });
      if (row.state!=='verifying' || !row.oss_version_id) throw new ServiceError('upload_canceled');
      const docx=row.mime_type===DOCX_MIME,maxBytes=this.limit(row.mime_type);
      const metadata=await this.store.head(row.object_key,row.oss_version_id);
      if (metadata.size!==Number(row.expected_size) || metadata.size>maxBytes) throw new ServiceError('upload_size_mismatch');
      const bytes=await this.store.read(row.object_key,row.oss_version_id,maxBytes);
      if (bytes.length!==metadata.size) throw new ServiceError('upload_size_mismatch');
      if(docx&&!row.draft_id&&!this.config.docxEnabled)throw new ServiceError('docx_capability_disabled');
      const verified=docx?await verifyDocx(bytes,{maxInputBytes:maxBytes}):row.mime_type?.startsWith('image/')?await verifyImage(bytes,row.mime_type):await verifyPdf(bytes,this.config);
      await transaction(this.pool,async client=>{
        const actor=actorOf(row), {caseRow}=await this.authorizedSession(client,actor,row.id,'material:upload',true);
        const current=await this.session(client,row.id,undefined,true);
        const lease=(await client.query('SELECT * FROM business.work_items WHERE id=$1 FOR UPDATE',[work.id])).rows[0];
        if (!lease || lease.state!=='running' || lease.epoch!==work.epoch || lease.lease_until.getTime()<=Date.now()) return;
        if (current.state!=='verifying' || current.oss_version_id!==row.oss_version_id) throw new ServiceError('upload_canceled');
        if (!row.draft_id&&caseRow.revision!==row.expected_revision) throw new AppError(409,'case_revision_conflict');
        if(row.draft_id){
          await client.query('INSERT INTO business.draft_attachments(id,draft_id,sha256,page_count) VALUES($1,$2,$3,$4)',[row.id,row.draft_id,verified.sha256,verified.pageCount]);
          await client.query("UPDATE business.upload_sessions SET state='registered',updated_at=now() WHERE id=$1",[row.id]);
          await client.query("UPDATE business.work_items SET state='succeeded',lease_until=NULL,updated_at=now() WHERE id=$1",[work.id]);
          await client.query('INSERT INTO business.inbox(work_item_id,epoch) VALUES($1,$2)',[work.id,work.epoch]);
          await audit(client,{actorId:row.account_id,targetId:row.id,action:'draft.attachment_registered',details:{draftId:row.draft_id}});
          return;
        }
        const documentId=randomUUID();
        await client.query(`INSERT INTO business.document_versions(id,case_id,upload_session_id,filename,size,sha256,page_count,object_key,oss_version_id,uploaded_by,source_format,source_kind,source_label,round_id)
          VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,[documentId,row.case_id,row.id,row.filename,verified.size,verified.sha256,verified.pageCount,row.object_key,row.oss_version_id,row.person_id,docx?'docx':row.mime_type==='image/png'?'png':row.mime_type==='image/jpeg'?'jpg':'pdf',row.source_kind??'unknown',row.source_label??null,row.round_id??null]);
        await client.query('INSERT INTO business.parse_intents(document_version_id) VALUES($1)',[documentId]);
        await client.query("UPDATE business.upload_sessions SET state='registered',document_version_id=$2,updated_at=now() WHERE id=$1",[row.id,documentId]);
        await this.onRegistered?.(client,actor,caseRow,documentId);
        await client.query("UPDATE business.work_items SET state='succeeded',lease_until=NULL,updated_at=now() WHERE id=$1",[work.id]);
        await client.query('INSERT INTO business.inbox(work_item_id,epoch) VALUES($1,$2) ON CONFLICT DO NOTHING',[work.id,work.epoch]);
        await client.query("INSERT INTO business.outbox(id,event_type,owner_id) VALUES($1,'material.registered',$2)",[randomUUID(),documentId]);
        await audit(client,{actorId:row.account_id,targetId:documentId,action:'material:register',details:{caseId:row.case_id!,pageCount:verified.pageCount??'not_applicable'}});
      });
    } catch(error) { await this.failWork(work,error); }
  }
  private async failWork(work:ClaimedWork,error:unknown) {
    const retry=error instanceof ServiceError && error.retryable && work.attempts<work.max_attempts;
    const code=error instanceof ServiceError||error instanceof AppError||error instanceof DocxError?error.code:'upload_verification_failed';
    const delay=error instanceof ServiceError && error.retryAfterMs!==undefined?error.retryAfterMs:Math.min(30_000,1000*2**Math.min(work.attempts,5));
    await transaction(this.pool,async client=>{
      // Same upload -> work lock order as cancellation/registration.
      await client.query('SELECT id FROM business.upload_sessions WHERE id=$1 FOR UPDATE',[work.owner_id]);
      const r=await client.query(`UPDATE business.work_items SET state=$3,error_code=$4,lease_until=NULL,available_at=now()+$5*interval '1 millisecond',updated_at=now()
        WHERE id=$1 AND epoch=$2 AND state='running' AND lease_until>now() RETURNING id`,[work.id,work.epoch,retry?'pending':'rejected',code,delay]);
      if (r.rowCount && !retry) await client.query("UPDATE business.upload_sessions SET state='rejected',error_code=$2,updated_at=now() WHERE id=$1 AND state='verifying'",[work.owner_id,code]);
    });
  }
  /** Every operation is bounded and only considers application-tracked keys. */
  async reconcile() {
    if (!this.config.enabled) return;
    // Rotate inspected sessions while they wait for the orphan grace period. An
    // old batch with no object must not starve later lost-complete notifications.
    const issued=(await this.pool.query("SELECT * FROM business.upload_sessions WHERE state='issued' AND expires_at<now() ORDER BY updated_at,expires_at,id LIMIT 20")).rows as UploadRow[];
    for(const row of issued) {
      try { await this.complete(actorOf(row),row.id); }
      catch(error) {
        const notFound=error instanceof ServiceError && error.code==='oss_not_found';
        const expired=notFound && row.expires_at.getTime()+this.config.orphanGraceSeconds*1000<Date.now();
        const invalid=error instanceof AppError && [400,401,403,404,409,413].includes(error.status);
        if(expired||invalid) await this.pool.query("UPDATE business.upload_sessions SET state=$2,error_code=$3,updated_at=now() WHERE id=$1 AND state='issued'",[row.id,expired?'expired':'rejected',expired?'upload_expired':(error as AppError).code]);
        else await this.pool.query("UPDATE business.upload_sessions SET updated_at=now() WHERE id=$1 AND state='issued'",[row.id]);
      }
    }
    const orphanRows=(await this.pool.query(`SELECT id FROM business.upload_sessions WHERE state IN ('registered','canceled','rejected','expired')
      AND expires_at+($1*interval '1 second')<now() AND (cleanup_checked_at IS NULL OR cleanup_checked_at<now()-interval '1 day')
      ORDER BY cleanup_checked_at NULLS FIRST LIMIT 10`,[this.config.orphanGraceSeconds])).rows;
    for(const item of orphanRows) {
      await transaction(this.pool,async client=>{
        const row=await this.session(client,item.id,undefined,true);
        if(!['registered','canceled','rejected','expired'].includes(row.state) || row.expires_at.getTime()+this.config.orphanGraceSeconds*1000>=Date.now()) return;
        const versions=await this.store.versions(row.object_key);
        for(const object of versions) {
          const reference=await client.query(`SELECT 1 FROM business.document_versions WHERE object_key=$1 AND oss_version_id=$2
            UNION ALL SELECT 1 FROM business.draft_attachments a JOIN business.upload_sessions u ON u.id=a.id WHERE u.object_key=$1 AND u.oss_version_id=$2`,[row.object_key,object.versionId]);
          if(!reference.rowCount) await this.store.deleteVersion(row.object_key,object.versionId);
        }
        await client.query('UPDATE business.upload_sessions SET cleanup_checked_at=now() WHERE id=$1',[row.id]);
      });
    }
  }
}
