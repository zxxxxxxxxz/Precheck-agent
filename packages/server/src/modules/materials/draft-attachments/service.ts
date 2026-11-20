import {createHash,randomUUID} from 'node:crypto';
import type {FastifyInstance} from 'fastify';
import type {Pool,PoolClient} from 'pg';
import {z} from 'zod';
import {DRAFT_ATTACHMENT_LIMITS,DraftAttachmentBlockSchema,DraftAttachmentSchema,type DraftAttachmentBlock} from '@hsbc/contracts/draft-attachment';
import { AppError } from '../../../shared/errors.js';
import { audit } from '../../audit/events.js';
import { authorizeCase } from '../../cases/authorization.js';
import { idempotent } from '../../../infrastructure/database/idempotency.js';
import { transaction, type DB } from '../../../infrastructure/database/client.js';
import { type Actor } from '../../identity/types.js';
import type {Auth} from '../../identity/auth.js';
import {OssObjectStore,type ObjectStore,type UploadConfig} from '../../../infrastructure/integrations/oss.js';
import {OcrInferenceClient} from '../../../infrastructure/integrations/inference.js';
import {ServiceError,type ServiceConfig} from '../../../infrastructure/integrations/http.js';
import {parseRange} from '../uploads/pdf.js';
import {imageForOcr} from '../uploads/image.js';
import { authorizeDraft } from '../../cases/draft-state.js';
import {parseAttachmentLocal} from './parser.js';

export const DRAFT_ATTACHMENT_PARSER_VERSION='draft-attachment-text-v1';
const DOCX='application/vnd.openxmlformats-officedocument.wordprocessingml.document';
const ExtractionSchema=z.strictObject({blocks:z.array(DraftAttachmentBlockSchema).max(100000),coverageGaps:z.array(z.string().max(150)).max(1000)});
export type DraftAttachmentExtraction=z.infer<typeof ExtractionSchema>;
type ParseOptions={signal?:AbortSignal;beforeStep?:()=>Promise<unknown>};
const rowsSql=`SELECT u.*,a.id AS attachment_id,a.sha256,a.page_count,a.state AS attachment_state,a.parse_state,a.parse_epoch,a.parse_lease_until,a.parser_version,a.extraction_result,a.parse_error_code,a.created_case_material_id,a.draft_id AS original_draft_id
 FROM business.upload_sessions u LEFT JOIN business.draft_attachments a ON a.id=u.id`;

export async function validateDraftAttachmentIds(db:DB,actor:Actor,draftId:string,ids:string[]){
  if(ids.length>DRAFT_ATTACHMENT_LIMITS.count||new Set(ids).size!==ids.length||ids.some(id=>!z.uuid().safeParse(id).success))throw new AppError(422,'invalid_draft_attachments');
  const draft=await authorizeDraft(db,actor,draftId);if(draft.status!=='open')throw new AppError(409,'draft_closed');
  const rows=ids.length?(await db.query(`SELECT a.id,a.sha256 FROM business.draft_attachments a JOIN business.upload_sessions u ON u.id=a.id
    WHERE a.id=ANY($1::uuid[]) AND a.draft_id=$2 AND a.state='active' AND u.state='registered' AND u.draft_id=$2`,[ids,draftId])).rows:[];
  if(rows.length!==ids.length)throw new AppError(409,'attachment_not_ready');
  return ids.map(id=>rows.find(row=>row.id===id)! as {id:string;sha256:string});
}

/** Called with the draft locked, in its closing transaction. Originals and history are retained. */
export async function cancelDraftAttachments(db:DB,draftId:string){
  const rows=(await db.query("UPDATE business.upload_sessions SET state='canceled',updated_at=now() WHERE draft_id=$1 AND state IN ('issued','verifying') RETURNING id",[draftId])).rows;
  if(rows.length)await db.query("UPDATE business.work_items SET state='canceled',epoch=epoch+1,lease_until=NULL,updated_at=now() WHERE owner_type='UploadSession' AND owner_id=ANY($1::uuid[]) AND state IN ('pending','running')",[rows.map(row=>row.id)]);
  await db.query("UPDATE business.draft_attachments SET parse_state='failed',parse_error_code='draft_closed',parse_epoch=parse_epoch+1,parse_lease_until=NULL WHERE draft_id=$1 AND parse_state='running'",[draftId]);
}

/** Register originals in the creation transaction; processing uses the same admission as later uploads. */
export async function adoptDraftAttachments(db:PoolClient,actor:Actor,draftId:string,caseId:string,
  onRegistered?:(db:PoolClient,actor:Actor,caseRow:any,documentId:string)=>Promise<void>){
  if((await db.query("SELECT 1 FROM business.upload_sessions WHERE draft_id=$1 AND state IN ('issued','verifying') LIMIT 1",[draftId])).rowCount)throw new AppError(409,'draft_uploads_pending');
  const rows=(await db.query(`${rowsSql.replace('LEFT JOIN','JOIN')} WHERE a.draft_id=$1 AND a.state='active' ORDER BY u.id FOR UPDATE OF u,a`,[draftId])).rows;
  if(!rows.length){
    // A replay may have already moved these exact originals into this case.
    // Empty, removed, canceled and failed uploads cannot satisfy new creation.
    const adopted=await db.query(`SELECT 1 FROM business.draft_attachments a JOIN business.document_versions d ON d.id=a.created_case_material_id
      WHERE a.draft_id=$1 AND a.state='adopted' AND d.case_id=$2 LIMIT 1`,[draftId,caseId]);
    if(!adopted.rowCount)throw new AppError(409,'draft_materials_required');
  }
  const caseRow=(await db.query('SELECT * FROM business.cases WHERE id=$1',[caseId])).rows[0],roundId=caseRow?.current_round_id??null;
  for(const row of rows){
    if(row.state!=='registered'||!row.oss_version_id)throw new AppError(409,'attachment_not_ready');
    const documentId=randomUUID(),format=row.mime_type===DOCX?'docx':row.mime_type==='image/jpeg'?'jpg':row.mime_type==='image/png'?'png':'pdf';
    await db.query(`INSERT INTO business.document_versions(id,case_id,upload_session_id,filename,size,sha256,page_count,object_key,oss_version_id,uploaded_by,source_format,source_kind,source_label,round_id)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,[documentId,caseId,row.id,row.filename,row.expected_size,row.sha256,row.page_count,row.object_key,row.oss_version_id,row.person_id,format,row.source_kind,row.source_label,roundId]);
    await db.query('INSERT INTO business.parse_intents(document_version_id) VALUES($1)',[documentId]);
    await db.query('UPDATE business.upload_sessions SET case_id=$2,draft_id=NULL,document_version_id=$3,expected_revision=1,round_id=$4,updated_at=now() WHERE id=$1',[row.id,caseId,documentId,roundId]);
    await db.query("UPDATE business.draft_attachments SET state='adopted',created_case_material_id=$2,parse_epoch=parse_epoch+1,parse_lease_until=NULL,parse_state=CASE WHEN parse_state='running' THEN 'failed' ELSE parse_state END,parse_error_code=CASE WHEN parse_state='running' THEN 'draft_closed' ELSE parse_error_code END WHERE id=$1",[row.id,documentId]);
    await onRegistered?.(db,actor,caseRow,documentId);
    await audit(db,{actorId:actor.accountId,targetId:documentId,action:'draft.attachment_attached',details:{draftId,attachmentId:row.id,caseId}});
  }
}

export class DraftAttachmentService{
  readonly store:ObjectStore;private readonly ocr?:OcrInferenceClient;
  constructor(private pool:Pool,private upload:UploadConfig,store?:ObjectStore,options:{ocr?:ServiceConfig}={}){this.store=store??new OssObjectStore(upload);if(options.ocr)this.ocr=new OcrInferenceClient(options.ocr);}
  private async row(db:DB,actor:Actor,draftId:string,id:string,write=false){
    const draft=await authorizeDraft(db,actor,draftId,write);
    if(write&&draft.status!=='open')throw new AppError(409,'draft_closed');
    const row=(await db.query(`${rowsSql} WHERE u.id=$1 AND (u.draft_id=$2 OR a.draft_id=$2)`,[id,draftId])).rows[0];
    if(!row)throw new AppError(404,'attachment_not_found');
    if(row.created_case_material_id)await authorizeCase(db,actor,row.case_id,'evidence:read',false);
    return row;
  }
  async list(actor:Actor,draftId:string){return transaction(this.pool,async db=>{
    const draft=await authorizeDraft(db,actor,draftId,false);
    if(draft.status==='created')await authorizeCase(db,actor,draft.created_case_id!,'case:read',false);
    const rows=(await db.query(`${rowsSql} WHERE u.draft_id=$1 OR a.draft_id=$1 ORDER BY u.created_at,u.id`,[draftId])).rows;
    return {items:rows.map(row=>DraftAttachmentSchema.parse({id:row.id,uploadId:row.id,draftId,filename:row.filename,size:Number(row.expected_size),mimeType:row.mime_type,
      state:row.attachment_state==='removed'?'removed':row.attachment_state==='adopted'?'adopted':row.state,parseState:row.parse_state??'idle',errorCode:row.error_code,parseErrorCode:row.parse_error_code??null,
      sha256:row.sha256??null,pageCount:row.page_count??null,createdCaseMaterialId:row.created_case_material_id??null,source:{kind:row.source_kind,...(row.source_label?{label:row.source_label}:{})},createdAt:new Date(row.created_at).toISOString()}))};
  });}
  async content(actor:Actor,draftId:string,id:string,rangeHeader?:string){
    const row=await transaction(this.pool,db=>this.row(db,actor,draftId,id));
    if(row.state!=='registered'||!row.attachment_id||row.attachment_state==='removed')throw new AppError(409,'attachment_not_ready');
    const range=parseRange(rangeHeader,Number(row.expected_size)),max=row.mime_type===DOCX?DRAFT_ATTACHMENT_LIMITS.docxBytes:row.mime_type.startsWith('image/')?DRAFT_ATTACHMENT_LIMITS.imageBytes:DRAFT_ATTACHMENT_LIMITS.pdfBytes;
    let bytes:Buffer;
    try{bytes=await this.store.read(row.object_key,row.oss_version_id,range?range.end-range.start+1:max,range);}
    catch(error){if(error instanceof ServiceError)throw new AppError(error.code==='oss_not_found'?409:error.retryable?503:400,error.code);throw error;}
    await transaction(this.pool,async db=>{const current=await this.row(db,actor,draftId,id);if(current.attachment_state==='removed')throw new AppError(409,'attachment_removed');await audit(db,{actorId:actor.accountId,targetId:id,action:'draft.attachment_read'});});
    return {bytes,filename:row.filename,mimeType:row.mime_type,size:Number(row.expected_size),range};
  }
  async remove(actor:Actor,draftId:string,id:string,key:string,cancelTurns?:(db:DB,draftId:string)=>Promise<void>){
    await transaction(this.pool,async db=>{
      const row=await this.row(db,actor,draftId,id,true);
      await idempotent(db,actor,`draft.attachment.remove:${id}`,key,{},async()=>{
        if(row.attachment_state==='removed'||row.state==='canceled')return {id};
        if(row.attachment_state==='adopted')throw new AppError(409,'draft_closed');
        if(row.attachment_id)await db.query("UPDATE business.draft_attachments SET state='removed',parse_epoch=parse_epoch+1,parse_lease_until=NULL,parse_state=CASE WHEN parse_state='running' THEN 'failed' ELSE parse_state END,parse_error_code=CASE WHEN parse_state='running' THEN 'attachment_removed' ELSE parse_error_code END WHERE id=$1",[id]);
        else await db.query("UPDATE business.upload_sessions SET state='canceled',updated_at=now() WHERE id=$1",[id]);
        await db.query("UPDATE business.work_items SET state='canceled',epoch=epoch+1,lease_until=NULL,updated_at=now() WHERE owner_type='UploadSession' AND owner_id=$1 AND state IN ('pending','running')",[id]);
        await cancelTurns?.(db,draftId);await db.query('UPDATE business.case_drafts SET revision=revision+1,updated_at=now() WHERE id=$1',[draftId]);
        await audit(db,{actorId:actor.accountId,targetId:id,action:'draft.attachment_removed',details:{draftId}});return {id};
      });
    });
    return this.list(actor,draftId);
  }
  async parseAttachments(actor:Actor,draftId:string,ids:string[],options:ParseOptions={}):Promise<DraftAttachmentExtraction>{
    await transaction(this.pool,db=>validateDraftAttachmentIds(db,actor,draftId,ids));
    const result:DraftAttachmentExtraction={blocks:[],coverageGaps:[]};
    for(const id of ids){const parsed=await this.parseAttachment(actor,draftId,id,options);result.blocks.push(...parsed.blocks);result.coverageGaps.push(...parsed.coverageGaps.map(gap=>`${id}:${gap}`));}
    await options.beforeStep?.();await transaction(this.pool,db=>validateDraftAttachmentIds(db,actor,draftId,ids));return result;
  }
  async parseAttachment(actor:Actor,draftId:string,id:string,options:ParseOptions={}):Promise<DraftAttachmentExtraction>{
    const controller=new AbortController();options={...options,signal:options.signal?AbortSignal.any([options.signal,controller.signal]):controller.signal};
    options.signal?.throwIfAborted();await options.beforeStep?.();
    const row=await transaction(this.pool,async db=>{
      await validateDraftAttachmentIds(db,actor,draftId,[id]);
      const current=await this.row(db,actor,draftId,id,true);
      if(current.parse_state==='ready'&&current.parser_version===DRAFT_ATTACHMENT_PARSER_VERSION)return current;
      if(current.parse_state==='running'&&new Date(current.parse_lease_until).getTime()>Date.now())throw new AppError(409,'attachment_parse_busy');
      const claimed=(await db.query("UPDATE business.draft_attachments SET parse_state='running',parse_epoch=parse_epoch+1,parse_lease_until=now()+interval '90 seconds',parse_error_code=NULL WHERE id=$1 RETURNING parse_epoch",[id])).rows[0];
      return {...current,parse_state:'running',parse_epoch:claimed.parse_epoch};
    });
    if(row.parse_state==='ready')return ExtractionSchema.parse(row.extraction_result);
    const fence=async()=>{
      options.signal?.throwIfAborted();await options.beforeStep?.();
      await transaction(this.pool,async db=>{
        await validateDraftAttachmentIds(db,actor,draftId,[id]);
        const update=await db.query("UPDATE business.draft_attachments SET parse_lease_until=now()+interval '90 seconds' WHERE id=$1 AND parse_epoch=$2 AND parse_state='running' AND parse_lease_until>clock_timestamp()",[id,row.parse_epoch]);
        if(!update.rowCount)throw new AppError(409,'attachment_parse_stale');
      });
    };
    // Shorter than the parent model-work lease: a dead worker cannot strand the cache on recovery.
    let beating=false;const heartbeat=setInterval(()=>{if(beating)return;beating=true;void fence().catch(()=>controller.abort()).finally(()=>{beating=false;});},15000);heartbeat.unref();
    try{
      await fence();const bytes=await this.store.read(row.object_key,row.oss_version_id,Number(row.expected_size));
      if(bytes.length!==Number(row.expected_size)||createHash('sha256').update(bytes).digest('hex')!==row.sha256)throw new ServiceError('attachment_hash_mismatch');
      const result:DraftAttachmentExtraction={blocks:[],coverageGaps:[]};let characters=0;
      const append=(text:string,locator:{pageNumber?:number;nodeId?:string})=>{
        if(!text.trim())return;characters+=text.length;if(characters>DRAFT_ATTACHMENT_LIMITS.extractedCharacters)throw new ServiceError('attachment_text_budget');
        for(let offset=0;offset<text.length;offset+=12000)result.blocks.push({id:`${id}:${locator.nodeId??`p${locator.pageNumber??1}`}:${offset}`,text:text.slice(offset,offset+12000),source:{attachmentId:id,sha256:row.sha256,...locator}});
      };
      const ocr=async(png:Uint8Array,pageNumber:number)=>{
        if(!this.ocr)throw new ServiceError('attachment_ocr_unavailable');await fence();
        const response=await this.ocr.parse(png,{returnWordBox:true,signal:options.signal});
        if(response.pages.length!==1)throw new ServiceError('attachment_ocr_invalid_pages');
        const page=response.pages[0]!;append(page.markdown.trim()||page.word_ocr?.rec_texts.join('\n')||'',{pageNumber});
      };
      if(row.mime_type===DOCX){
        const extracted=await parseAttachmentLocal(bytes,{kind:'docx',attachmentId:id,signal:options.signal});
        for(const block of extracted.blocks)append(block.text,{nodeId:block.nodeId});result.coverageGaps.push(...extracted.coverageGaps);
      }else if(row.mime_type.startsWith('image/'))await ocr(await imageForOcr(bytes,row.mime_type,options.signal),1);
      else for(let pageNumber=1;pageNumber<=row.page_count;pageNumber++){
        await fence();const extracted=await parseAttachmentLocal(bytes,{kind:'pdf',attachmentId:id,pageNumber,signal:options.signal});
        for(const block of extracted.blocks)append(block.text,{pageNumber});
        result.coverageGaps.push(...extracted.coverageGaps);
        if(extracted.png)await ocr(extracted.png,pageNumber);
      }
      result.coverageGaps=[...new Set(result.coverageGaps)];if(!result.blocks.length)result.coverageGaps.push('no_readable_text');
      ExtractionSchema.parse(result);await fence();
      await transaction(this.pool,async db=>{
        await validateDraftAttachmentIds(db,actor,draftId,[id]);
        const committed=await db.query("UPDATE business.draft_attachments SET parse_state='ready',parser_version=$3,extraction_result=$4,parse_lease_until=NULL WHERE id=$1 AND parse_epoch=$2 AND state='active' AND parse_state='running' AND parse_lease_until>clock_timestamp()",[id,row.parse_epoch,DRAFT_ATTACHMENT_PARSER_VERSION,JSON.stringify(result)]);
        if(!committed.rowCount)throw new AppError(409,'attachment_parse_stale');
        await audit(db,{actorId:actor.accountId,targetId:id,action:'draft.attachment_read_completed',details:{blocks:result.blocks.length}});
      });
      return result;
    }catch(error){
      const code=error instanceof ServiceError||error instanceof AppError?error.code:options.signal?.aborted?'attachment_canceled':'attachment_parse_failed';
      await this.pool.query("UPDATE business.draft_attachments SET parse_state='failed',parse_error_code=$3,parse_lease_until=NULL WHERE id=$1 AND parse_epoch=$2 AND parse_state='running'",[id,row.parse_epoch,code]);
      throw error instanceof AppError?error:new AppError(422,code);
    }finally{clearInterval(heartbeat);}
  }
}

export function registerDraftAttachmentRoutes(http:FastifyInstance,service:DraftAttachmentService,auth:Auth,cancelTurns?:(db:DB,draftId:string)=>Promise<void>){
  const ids=(request:any)=>({draftId:z.uuid().parse(request.params.draftId),attachmentId:request.params.attachmentId?z.uuid().parse(request.params.attachmentId):undefined});
  http.get('/api/case-drafts/:draftId/attachments',async(request,reply)=>{reply.header('Cache-Control','private, no-store');return service.list(await auth.requireSession(request),ids(request).draftId);});
  http.post('/api/case-drafts/:draftId/attachments/:attachmentId/remove',async(request,reply)=>{const body=z.strictObject({idempotencyKey:z.string().min(1).max(128)}).parse(request.body),path=ids(request);reply.header('Cache-Control','private, no-store');return service.remove(await auth.checkWrite(request),path.draftId,path.attachmentId!,body.idempotencyKey,cancelTurns);});
  http.get('/api/case-drafts/:draftId/attachments/:attachmentId/content',async(request,reply)=>{
    const path=ids(request),result=await service.content(await auth.requireSession(request),path.draftId,path.attachmentId!,request.headers.range);
    reply.header('Content-Type',result.mimeType).header('Cache-Control','private, no-store').header('X-Content-Type-Options','nosniff').header('Accept-Ranges','bytes');
    reply.header('Content-Disposition',`attachment; filename="attachment"; filename*=UTF-8''${encodeURIComponent(result.filename).replace(/'/g,'%27')}`);
    if(result.range)reply.code(206).header('Content-Range',`bytes ${result.range.start}-${result.range.end}/${result.size}`);
    return reply.header('Content-Length',result.bytes.length).send(result.bytes);
  });
}
