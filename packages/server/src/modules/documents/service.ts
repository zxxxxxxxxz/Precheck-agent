import {SUPPLEMENTAL_MATERIAL_ID,supplementalTaxonomy} from '@hsbc/contracts/case-supplement';
import type {DB} from '../../infrastructure/database/client.js';
import {documentProcessingError} from './processing-failure.js';
import {configHash} from '../review/opa.js';
import {fixedMaterialType,UPLOAD_CLASSIFICATION_VERSION} from './content-classification.js';
import {fieldDisplayCorrections,correctedFieldDisplay} from '../review/field-verification.js';
import {suppliedFieldValues,withSuppliedFields} from '../review/field-supply.js';
import {automaticSignaturesFromContext,signatureSourceContext} from './signatures/information-source.js';
import {isSourceSignatureField,projectSignatureFields} from './signatures/field-presentation.js';
import {reconcileSourceOverlaps} from './source-candidate-overlap.js';
import {projectTableRecords, supportsTableRecords} from './table-records.js';
import {assertRoundRequest,assertDocumentRound} from '../review/round-boundary.js';
import {materialMembership} from '../materials/review-scope.js';
import { createHash, randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { z } from 'zod';
import { DOCUMENT_PAGE_LIMIT } from '@hsbc/contracts/document-limits';
import {projectGuaranteeMoney} from './guarantee-money-presentation.js';
import { presentDocumentFields } from '@hsbc/contracts/document-presentation';
import { associateBilingualNames } from './bilingual-name-groups.js';
import { DocumentBundleSchema, DocumentFieldObservationSchema, DocumentLogicalDocumentSchema, DocumentPageArtifactSchema, DocumentEngineConfigSchema, DocumentScopeSchema, type DocumentBundle, type DocumentPageArtifact, type DocumentScope } from '@hsbc/contracts/documents';
import { AppError } from '../../shared/errors.js';
import { audit } from '../audit/events.js';
import { authorizeCase } from '../cases/authorization.js';
import { idempotent, inputHash } from '../../infrastructure/database/idempotency.js';
import { transaction } from '../../infrastructure/database/client.js';
import { type Actor } from '../identity/types.js';
import { ServiceError } from '../../infrastructure/integrations/http.js';
import type { ObjectStore, UploadConfig } from '../../infrastructure/integrations/oss.js';
import { OcrInferenceClient, NerClient, QwenClient } from '../../infrastructure/integrations/inference.js';
import type { ClaimedWork } from '../../infrastructure/jobs/types.js';
import { processPageIsolated, deriveDocument, deriveClassifiedDocument, extractFieldObservations, searchEvidenceFromCandidates, compareDocumentVersions, reviseLogicalDirectory, SYNTHETIC_DOCUMENT_CONFIG } from './engine/index.js';
import type { DocumentRuntimeConfig } from './config.js';
import { persistDocumentIndex, documentIndexCandidates } from './search-index.js';
import { DocxSourceDocumentSchema, DocxConversionManifestSchema, type DocxSourceDocument, type DocxConversionManifest } from '@hsbc/contracts/docx';
import { parseDocx } from '../../document/docx.js';
import { convertDocx } from '../../document/docx-convert.js';
import { DocxError } from '../../document/docx-zip.js';
import { addSourceEvidence, mapSourceEvidence, SourceMappingSchema } from './source-evidence.js';
import { validateAnchorSource } from '../../document/evidence.js';
import { validatePolygon } from '../../document/geometry.js';
import { safeDocumentEngineErrorCode } from './engine/errors.js';
import { CLOUD_DIRECTORY_POLICY, DIRECTORY_POLICY, displayLogicalDirectory, type DirectoryPage } from './engine/directory.js';
import { filterFieldsByRecipe, projectFieldCandidates, FIELD_FILTER_PROMPT_SHA256, FIELD_FILTER_VERSION } from './field-filter.js';
import { isSupportedReviewRecipe, type ReviewConfigManifest } from '@hsbc/contracts/review-config';
import { durableFieldFilterChat, FIELD_FILTER_DURABLE_CALL_LIMIT } from './field-filter-ledger.js';
import type { DocumentReviewPort } from './ports.js';
import {DOCUMENT_DOCX_VERSION,applyDocxClassification} from './docx-extraction-contract.js';
import { runDocumentCloudExtraction } from './cloud-extraction.js';
import { DOCUMENT_CLOUD_VERSION } from './cloud-extraction-contract.js';
import { DOCUMENT_CLOUD_V2_VERSION } from './cloud-extraction-v2-contract.js';
import { documentRecoveryAvailability } from './recovery.js';
import { ModelExecutionError } from '../../model/gateway.js';
import { SignatureReviewService } from './signatures/service.js';
import { assertOcrMarkPage, ocrMarkPagesForBundle } from './ocr-marks.js';
import { PrivateSignatureVision, SIGNATURE_VISION_PROMPT_VERSION } from '../../infrastructure/integrations/signature-vision.js';
import { fieldApplicability } from './field-applicability.js';
import { ModelDiagnosticSchema } from '@hsbc/contracts/model';
import { REGION_OCR_VERSION } from '@hsbc/contracts/document-region-ocr';
import { augmentDocumentRegions } from './region-ocr-augmentation.js';
import { DocumentRegionOcrLedger } from './region-ocr-ledger.js';
import { DocumentProcessingAccess, documentProcessingPermit, lockProcessingAuthority, type ProcessingPermit } from './processing-access.js';
import { DocumentTranslationService } from './translations/service.js';
import type { TranslationChat } from './translations/model.js';

const digest = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
const MAX_BUNDLE_BYTES=64*1024*1024;
const command = z.strictObject({ roundId:z.uuid().optional(), expectedRevision: z.number().int().positive(), idempotencyKey: z.string().min(8).max(200), reason: z.string().trim().min(1).max(500) });
const compareCommand = z.strictObject({ expectedRevision: z.number().int().positive(), idempotencyKey: z.string().min(8).max(200), beforeDocumentId: z.uuid(), afterDocumentId: z.uuid(), beforeParseRevision: z.uuid(), afterParseRevision: z.uuid() });
type Job = { id:string; case_id:string; document_version_id:string; kind:string; account_id:string; person_id:string; auth_version:number; expected_revision:number; required_action:string; configuration_release_id:string; state:string; validity:string; input:Record<string,any>; result:any; error_code:string|null; completed_pages:number; total_pages:number|null; created_at:Date };
const authoritySchema=z.strictObject({id:z.uuid(),serviceId:z.string().min(1),action:z.enum(['parse_document','extract_fields','search_evidence','get_evidence','compare_document_versions','get_tool_job']),caseRevision:z.number().int().positive()});
export type DocumentActor=Actor & {documentAuthority?:z.infer<typeof authoritySchema>};
const actorOf = (job:Job):DocumentActor => ({accountId:job.account_id, personId:job.person_id, authVersion:job.auth_version,
  ...(job.input._documentAuthority?{documentAuthority:authoritySchema.parse(job.input._documentAuthority)}:{})});
const projection = (job:Job) => ({ id:job.id, jobId:job.id, status:job.state, validity:job.validity, result:job.result, errorCode:job.error_code, progress:{completedPages:job.completed_pages,totalPages:job.total_pages} });
/** Called only after resolving the immutable published manifest in accept(). */
export function regionOcrAdmissionVersion(enabled:boolean|undefined,kind:string,source:unknown,manifest:ReviewConfigManifest|undefined){
  const cloudFields=manifest?.fields.filter(field=>field.recipe.mode==='cloud_grounded_extract')??[];
  return enabled&&kind==='parse_document'&&source==='explicit'&&cloudFields.length>0&&
    cloudFields.every(field=>field.recipe.version===DOCUMENT_CLOUD_V2_VERSION)?REGION_OCR_VERSION:undefined;
}

/** Formal P2 persistence. All owner writes use the P1 transaction and lease fence. */
export class DocumentService {
  /** Read an already adopted original through the caller's transaction. No
   * extraction job, source artifact, confirmation or history is rewritten. */
  async reviewOriginalPdf(db:DB,actor:Actor,caseId:string,documentId:string,parseRevision:string):Promise<Uint8Array|undefined>{
    await authorizeCase(db,actor,caseId,'evidence:read',false);
    const doc=(await db.query(`SELECT d.* FROM business.document_versions d
      JOIN business.document_jobs j ON j.id=d.current_parse_job_id AND j.document_version_id=d.id
      JOIN business.upload_sessions u ON u.id=d.upload_session_id AND u.document_version_id=d.id
      WHERE d.id=$1 AND d.case_id=$2 AND j.id=$3 AND j.kind='parse_document' AND u.state='registered'`,[documentId,caseId,parseRevision])).rows[0];
    if(!doc)return undefined;
    const bytes=await this.store.read(doc.object_key,doc.oss_version_id,this.upload.maxBytes);
    if(digest(bytes)!==doc.sha256)throw new ServiceError('signature_original_integrity_failed');
    return Buffer.from(bytes).subarray(0,5).toString()==='%PDF-'?bytes:undefined;
  }

  private readonly signatures:SignatureReviewService;
  readonly processingAccess:DocumentProcessingAccess;
  private readonly translations:DocumentTranslationService;
  private stopping=false;
  private active=new Set<AbortController>();
  private readonly ocr?: Pick<OcrInferenceClient,'parse'>;
  private readonly ner?: NerClient;
  private readonly fieldFilter?: Pick<QwenClient,'chat'|'model'>;
  private readonly aggregateByteLimit:number;
  private readonly docxConverter:(bytes:Uint8Array,options:{signal:AbortSignal})=>Promise<{pdf:Buffer;manifest:DocxConversionManifest}>;
  constructor(readonly pool:Pool, readonly store:ObjectStore, readonly upload:UploadConfig, readonly config:DocumentRuntimeConfig, limits:{maxAggregateBytes?:number;docxConverter?:(bytes:Uint8Array,options:{signal:AbortSignal})=>Promise<{pdf:Buffer;manifest:DocxConversionManifest}>;fieldFilter?:Pick<QwenClient,'chat'|'model'>;signatureVision?:Pick<PrivateSignatureVision,'reviewPage'>;ocr?:Pick<OcrInferenceClient,'parse'>;translationClient?:TranslationChat}={}, private readonly review:DocumentReviewPort) {
    this.processingAccess=new DocumentProcessingAccess(pool,config.cloudExtraction,review);
    const vision=config.signatureVision;
    this.signatures=new SignatureReviewService(pool,store,config,review,limits.signatureVision??(vision?new PrivateSignatureVision(new QwenClient(vision.service,vision.model,pool),{enabled:true,modelRevision:vision.modelRevision}):undefined),SIGNATURE_VISION_PROMPT_VERSION);
    this.translations=new DocumentTranslationService(pool,config,limits.translationClient??(config.translation?new QwenClient(config.translation.service,config.translation.model,pool):undefined));
    this.aggregateByteLimit=limits.maxAggregateBytes??MAX_BUNDLE_BYTES;
    if(!Number.isSafeInteger(this.aggregateByteLimit)||this.aggregateByteLimit<1||this.aggregateByteLimit>MAX_BUNDLE_BYTES)throw new Error('invalid_document_aggregate_budget');
    if(config.ocr)this.ocr=limits.ocr??new OcrInferenceClient(config.ocr);
    if(config.ner)this.ner=new NerClient(config.ner);
    if(config.fieldFilter)this.fieldFilter=limits.fieldFilter??new QwenClient(config.fieldFilter.service,config.fieldFilter.model,pool);
    this.docxConverter=limits.docxConverter??((bytes,options)=>convertDocx(bytes,{...options,mode:'production',budgets:{maxPreviewPages:this.config.maxPages}}));
  }
  private enabled(){ if(!this.config.enabled)throw new AppError(409,'capability_disabled'); }
  private capability(name:'reader'|'directory'|'search'|'comparison'){if(!this.config[name])throw new AppError(409,'capability_disabled');}
  /** Current prerequisites are a read projection; binding configuration never queues parsing or rewrites history. */
  materialParseStatus(caseRow:{configuration_release_id?:string|null},document:{parse_status:string;current_parse_job_id?:string|null;source_format?:string|null}):string {
    if(document.current_parse_job_id||
      !['capability_disabled','configuration_required','parked'].includes(document.parse_status))return document.parse_status;
    if(this.config.requireReviewConfiguration&&!caseRow.configuration_release_id)return 'configuration_required';
    return document.parse_status==='configuration_required'?'capability_disabled':document.parse_status;
  }
  stop(){this.stopping=true;for(const controller of this.active)controller.abort();}
  private async document(db:PoolClient,caseId:string,id:string,lock=false){
    const row=(await db.query(`SELECT d.* FROM business.document_versions d JOIN business.upload_sessions u ON u.id=d.upload_session_id
      WHERE d.id=$1 AND d.case_id=$2 AND u.state='registered' AND u.document_version_id=d.id ${lock?'FOR UPDATE OF d':''}`,[id,caseId])).rows[0];
    if(!row)throw new AppError(404,'material_not_found');return row;
  }
  /** Locks the server-owned delegation through the protected database operation. */
  private async authority(db:PoolClient,actor:DocumentActor,caseRow:any,documentIds:string[]){
    if(!actor.documentAuthority)return;
    const a=authoritySchema.parse(actor.documentAuthority);
    const d=(await db.query('SELECT * FROM business.lock_document_delegation($1)',[a.id])).rows[0];
    if(!d||d.revoked||d.expires_at.getTime()<=Date.now()||d.service_id!==a.serviceId||d.account_id!==actor.accountId||
      d.person_id!==actor.personId||d.auth_version!==actor.authVersion||d.case_id!==caseRow.id||d.case_revision!==caseRow.revision||
      a.caseRevision!==caseRow.revision||!d.actions.includes(a.action)||documentIds.some(id=>!d.document_ids.includes(id)))throw new AppError(403,'scope_denied');
  }
  async recheckToolAuthority(actor:DocumentActor,caseId:string,documentIds:string[]){
    if(!actor.documentAuthority)throw new AppError(403,'scope_denied');
    return transaction(this.pool,async db=>{
      const action=['parse_document','extract_fields'].includes(actor.documentAuthority!.action)?'document:parse':'evidence:read';
      const c=await authorizeCase(db,actor,caseId,action,false);await this.authority(db,actor,c,documentIds);
    });
  }
  private async pinnedConfiguration(db:PoolClient,releaseId:string){
    const row=(await db.query('SELECT sha256,manifest FROM business.document_configurations WHERE id=$1',[releaseId])).rows[0];
    if(!row)throw new AppError(409,'configuration_not_found');
    const config=DocumentEngineConfigSchema.parse(row.manifest);
    // Schema parsing restores deterministic key order after JSONB serialization.
    if(digest(JSON.stringify(config))!==row.sha256)throw new AppError(409,'configuration_hash_mismatch');
    return config;
  }
  private async invalidateDerived(db:PoolClient,caseId:string,parseRevision:string){
    await this.review.invalidateDependencies(db,caseId,{parseRevision,reason:'document_dependency_changed'});
    const stale=await db.query("UPDATE business.document_jobs SET validity='stale',state=CASE WHEN state IN ('pending','running') THEN 'stale' ELSE state END WHERE case_id=$1 AND kind IN ('extract_fields','compare_document_versions','review_signatures','translate_document') AND (input->>'parseRevision'=$2 OR input->>'beforeParseRevision'=$2 OR input->>'afterParseRevision'=$2) RETURNING id",[caseId,parseRevision]);
    if(stale.rowCount)await db.query("UPDATE business.work_items SET state='canceled',epoch=epoch+1,lease_until=NULL WHERE owner_type='DocumentJob' AND owner_id=ANY($1::uuid[]) AND state IN ('pending','running')",[stale.rows.map(r=>r.id)]);
  }
  private async parseState(db:PoolClient,job:Job,state:string){
    if(job.kind!=='parse_document')return;
    await db.query('UPDATE business.document_versions SET parse_status=$2 WHERE current_parse_job_id=$1',[job.id,state]);
    await db.query('UPDATE business.parse_intents SET state=$2 WHERE document_version_id IN (SELECT id FROM business.document_versions WHERE current_parse_job_id=$1)',[job.id,state]);
  }
  private async configuration(db:PoolClient,caseRow:any){
    if(caseRow.configuration_release_id){
      const release=await this.review.getPublished(db,caseRow.configuration_release_id);
      await this.pinnedConfiguration(db,release.documentConfigurationId);
      return release.documentConfigurationId;
    }
    if(this.config.requireReviewConfiguration)throw new AppError(409,'review_configuration_required');
    const id='p2-synthetic-v1', body=JSON.stringify(SYNTHETIC_DOCUMENT_CONFIG), hash=digest(body);
    await db.query('INSERT INTO business.document_configurations(id,sha256,manifest) VALUES($1,$2,$3) ON CONFLICT DO NOTHING',[id,hash,body]);
    if((await db.query('SELECT sha256 FROM business.document_configurations WHERE id=$1',[id])).rows[0]?.sha256!==hash)throw new AppError(409,'configuration_hash_mismatch');
    return id;
  }
  private async accept(db:PoolClient,actor:DocumentActor,caseRow:any,document:any,kind:Job['kind'],requiredAction:string,input:Record<string,unknown>){
    if(requiredAction!=='evidence:read'&&!(kind==='translate_document'&&requiredAction==='document:translate'))await assertDocumentRound(db,caseRow,document.id);
    const id=randomUUID(), workId=randomUUID(), release=await this.configuration(db,caseRow);
    let regionOcrVersion:typeof REGION_OCR_VERSION|undefined;
    let personalDocxSourceOnly=false;
    let docxExtractionDeferred:string|undefined;
    let uploadClassification=false;
    let processingPermit:ProcessingPermit|undefined;
    if(['parse_document','extract_fields'].includes(kind)){
      const manifest=await this.reviewManifest(db,release);
      regionOcrVersion=regionOcrAdmissionVersion(this.config.regionOcr,kind,input.source,manifest);
      personalDocxSourceOnly=kind==='parse_document'&&document.source_format==='docx'&&manifest?.guaranteeTypes.length===1&&manifest.guaranteeTypes[0]==='personal_guarantee'&&!manifest.docxExtraction;
      // Historical releases preserve source-only reading; only an explicitly
      // versioned native recipe may enter the unchanged model authorization gate.
      if(manifest?.fields.some(field=>field.recipe.mode==='cloud_grounded_extract')&&!personalDocxSourceOnly){
        const cloud=this.config.cloudExtraction;
        processingPermit=cloud&&manifest.scope==='synthetic'?await documentProcessingPermit(db,cloud,caseRow,document):undefined;
        const blocked=!cloud?'document_cloud_unavailable':!processingPermit?'document_cloud_scope_denied':
          document.source_format==='docx'&&manifest.docxExtraction?.version!==DOCUMENT_DOCX_VERSION?'document_cloud_format_unsupported':undefined;
        if(blocked){
          // Pin local Word reading to this job; later authorization needs a new command.
          if(kind==='parse_document'&&document.source_format==='docx'&&this.config.docx){
            docxExtractionDeferred=blocked;regionOcrVersion=undefined;processingPermit=undefined;
          }else throw new AppError(blocked==='document_cloud_scope_denied'?403:409,blocked);
        }else uploadClassification=true;
      }
    }
    await this.authority(db,actor,caseRow,kind==='compare_document_versions'?[String(input.beforeDocumentId),String(input.afterDocumentId)]:[document.id]);
    const boundInput={...input,...(uploadClassification?{materialClassification:UPLOAD_CLASSIFICATION_VERSION}:{}),...(processingPermit?{processingPermit}:{}),...(personalDocxSourceOnly?{personalDocxSourceOnly:true}:{}),...(docxExtractionDeferred?{docxExtractionDeferred}:{}),...(regionOcrVersion?{regionOcrVersion}:{}),...(this.config.fieldFilter&&!docxExtractionDeferred?{fieldFilterVersion:'qwen-role-filter-v1'}:{}),...(actor.documentAuthority?{_documentAuthority:authoritySchema.parse(actor.documentAuthority)}:{})};
    await db.query(`INSERT INTO business.document_jobs(id,case_id,document_version_id,kind,account_id,person_id,auth_version,expected_revision,required_action,configuration_release_id,input,total_pages,round_id)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,[id,caseRow.id,document.id,kind,actor.accountId,actor.personId,actor.authVersion,caseRow.revision,requiredAction,release,JSON.stringify(boundInput),document.page_count,document.round_id??null]);
    if(processingPermit?.kind==='demo_policy')await audit(db,{targetId:id,action:'document:demo_policy_applied',details:{
      caseId:caseRow.id,documentId:document.id,policyId:processingPermit.policyId,policyVersion:processingPermit.policyVersion,
      policyHash:processingPermit.policyHash,configurationReleaseId:processingPermit.configurationReleaseId,dataClass:'public_synthetic',
    }});
    await db.query("INSERT INTO business.work_items(id,owner_type,owner_id,kind,queue) VALUES($1,'DocumentJob',$2,$3,'document')",[workId,id,kind]);
    await db.query("INSERT INTO business.outbox(id,work_item_id,event_type,owner_id) VALUES($1,$2,'work.available',$3)",[randomUUID(),workId,id]);
    if(kind==='parse_document'){
      if(document.current_parse_job_id){
        await db.query("UPDATE business.document_jobs SET validity='superseded',state=CASE WHEN state IN ('pending','running') THEN 'canceled' ELSE state END,updated_at=now() WHERE id=$1",[document.current_parse_job_id]);
        await this.invalidateDerived(db,caseRow.id,document.current_parse_job_id);
        await db.query("UPDATE business.work_items SET state='canceled',epoch=epoch+1,lease_until=NULL WHERE owner_type='DocumentJob' AND owner_id=$1 AND state IN ('pending','running')",[document.current_parse_job_id]);
      }
      await db.query("UPDATE business.document_versions SET current_parse_job_id=$2,parse_status='pending' WHERE id=$1",[document.id,id]);
      await db.query("UPDATE business.parse_intents SET state='pending' WHERE document_version_id=$1",[document.id]);
    }
    await audit(db,{actorId:actor.accountId,targetId:id,action:`document:${kind}`,details:{caseId:caseRow.id,documentId:document.id}});
    return {jobId:id,status:'pending',parseRevision:kind==='parse_document'?id:undefined};
  }
  /** Called inside the exact material-registration transaction. */
  async registered(db:PoolClient,actor:DocumentActor,caseRow:any,documentId:string){
    if(!this.config.enabled||caseRow.scenario!=='overseas_loan')return;
    const doc=await this.document(db,caseRow.id,documentId,true);
    if(this.config.requireReviewConfiguration&&!caseRow.configuration_release_id){
      await db.query("UPDATE business.document_versions SET parse_status='configuration_required' WHERE id=$1",[documentId]);
      await db.query("UPDATE business.parse_intents SET state='configuration_required' WHERE document_version_id=$1",[documentId]);
      return;
    }
    if(!this.config.automatic)return;
    // Original-file verification has succeeded. A missing extraction prerequisite
    // must not roll back the original or weaken the explicit parsing authorization.
    await db.query('SAVEPOINT automatic_material_parse');
    try {
      await this.accept(db,actor,caseRow,doc,'parse_document','material:upload',{source:'registration'});
    } catch(error) {
      if(!(error instanceof AppError)||!['document_cloud_unavailable','document_cloud_scope_denied','document_cloud_format_unsupported'].includes(error.code))throw error;
      await db.query('ROLLBACK TO SAVEPOINT automatic_material_parse');
      await db.query("UPDATE business.document_versions SET parse_status='capability_disabled' WHERE id=$1",[documentId]);
      await db.query("UPDATE business.parse_intents SET state='capability_disabled' WHERE document_version_id=$1",[documentId]);
      await audit(db,{actorId:actor.accountId,targetId:documentId,action:'document:automatic_parse_deferred',details:{caseId:caseRow.id,code:error.code}});
    }
    await db.query('RELEASE SAVEPOINT automatic_material_parse');
  }
  private processingResumeCursor?:string;
  /** Resume only never-started registrations, using their original uploader's live authority. */
  async reconcileProcessing(){
    const cloud=this.config.cloudExtraction;
    if(!this.config.enabled||!this.config.automatic||!cloud?.policyReuse||Date.parse(cloud.cloud.policy.expiresAt)<=Date.now())return;
    const limit=100;
    const candidates=(await this.pool.query(`SELECT d.id,u.case_id,u.account_id,u.person_id,u.auth_version
      FROM business.document_versions d JOIN business.upload_sessions u ON u.id=d.upload_session_id AND u.document_version_id=d.id AND u.case_id=d.case_id AND u.state='registered'
      JOIN business.cases c ON c.id=d.case_id
      JOIN business.principals p ON p.account_id=u.account_id AND p.person_id=u.person_id AND p.auth_version=u.auth_version
      JOIN business.review_config_releases r ON r.release_id=c.configuration_release_id
      WHERE d.current_parse_job_id IS NULL AND d.parse_status IN ('parked','capability_disabled','configuration_required')
      AND (d.source_format IN ('pdf','jpg','png') OR (d.source_format='docx' AND $4::boolean))
      AND (d.source_format='docx' OR d.page_count<=$1) AND d.round_id IS NOT DISTINCT FROM c.current_round_id
      AND c.scenario='overseas_loan' AND c.closed_at IS NULL AND c.maker_person_id=u.person_id AND p.enabled AND NOT p.must_change AND p.business_role='BCO'
      AND r.manifest->>'scope'='synthetic' AND EXISTS(SELECT 1 FROM jsonb_array_elements(r.manifest->'fields') f WHERE f->'recipe'->>'mode'='cloud_grounded_extract')
      AND (NOT c.review_rounds_enabled OR EXISTS(SELECT 1 FROM business.review_rounds q WHERE q.id=c.current_round_id AND q.case_id=c.id AND q.state='draft'))
      AND ($2::uuid IS NULL OR d.id>$2::uuid) ORDER BY d.id LIMIT $3`,[this.config.maxPages,this.processingResumeCursor??null,limit,Boolean(this.config.docx)])).rows;
    this.processingResumeCursor=candidates.length===limit?candidates.at(-1)!.id:undefined;
    for(const row of candidates){
      try{await transaction(this.pool,async db=>{
        const actor={accountId:row.account_id,personId:row.person_id,authVersion:row.auth_version};
        const c=await authorizeCase(db,actor,row.case_id,'material:upload');
        const doc=await this.document(db,c.id,row.id,true);
        if(doc.current_parse_job_id||!['parked','capability_disabled','configuration_required'].includes(doc.parse_status))return;
        await this.registered(db,actor,c,doc.id);
      });}catch(error){
        // A removed material, closed round or revoked uploader stays deferred.
        if(!(error instanceof AppError)||error.status<400||error.status>=500)throw error;
      }
    }
  }
  async parse(actor:DocumentActor,caseId:string,documentId:string,raw:unknown){
    this.enabled();const input=command.parse(raw);
    return transaction(this.pool,async db=>{
      const c=await authorizeCase(db,actor,caseId,'document:parse');await assertRoundRequest(db,c,input.roundId,{draft:true});await assertDocumentRound(db,c,documentId);
      await this.authority(db,actor,c,[documentId]);
      if(c.revision!==input.expectedRevision)throw new AppError(409,'stale_revision');
      if(c.scenario!=='overseas_loan')throw new AppError(409,'scenario_confirmation_required');
      return idempotent(db,actor,`document.parse:${documentId}`,input.idempotencyKey,input,async()=>{
        const doc=await this.document(db,caseId,documentId,true);
        if(doc.source_format==='docx'&&!this.config.docx)throw new AppError(409,'docx_capability_disabled');
        if(doc.page_count>this.config.maxPages)throw new AppError(422,'document_page_limit');
        return this.accept(db,actor,c,doc,'parse_document','document:parse',{reason:input.reason,source:'explicit'});
      });
    });
  }
  async resumeProcessing(actor:DocumentActor,caseId:string,raw:unknown){
    this.enabled();const input=command.parse(raw);
    return transaction(this.pool,async db=>{
      const c=await authorizeCase(db,actor,caseId,'document:parse');await assertRoundRequest(db,c,input.roundId,{draft:true});
      if(c.revision!==input.expectedRevision)throw new AppError(409,'stale_revision');
      return idempotent(db,actor,`document.resume:${caseId}`,input.idempotencyKey,input,async()=>{
        const candidates=(await db.query(`SELECT d.* FROM business.document_versions d JOIN business.upload_sessions u ON u.id=d.upload_session_id AND u.document_version_id=d.id AND u.state='registered'
          WHERE d.case_id=$1 AND d.round_id IS NOT DISTINCT FROM $2::uuid AND d.source_format='pdf' AND d.current_parse_job_id IS NULL AND d.parse_status IN ('parked','capability_disabled','configuration_required') ORDER BY d.id FOR UPDATE OF d`,[caseId,c.current_round_id??null])).rows;
        const jobs=[];
        for(const doc of candidates){
          if(doc.page_count>this.config.maxPages||!await documentProcessingPermit(db,this.config.cloudExtraction,c,doc))continue;
          jobs.push(await this.accept(db,actor,c,doc,'parse_document','document:parse',{reason:input.reason,source:'explicit'}));
        }
        if(!jobs.length)throw new AppError(409,'processing_access_nothing_to_resume');
        await audit(db,{actorId:actor.accountId,targetId:caseId,action:'document:processing_resumed',details:{count:jobs.length,reason:input.reason}});
        return {count:jobs.length};
      });
    });
  }
  async recover(actor:DocumentActor,caseId:string,documentId:string,raw:unknown){
    this.enabled();const input=command.extend({parseRevision:z.uuid()}).parse(raw);
    return transaction(this.pool,async db=>{
      // The existing job retains its owner and authorization fence. A recovery
      // request cannot renew an expired grant or impersonate a different owner.
      const prior=(await db.query('SELECT * FROM business.document_jobs WHERE id=$1 AND case_id=$2 AND document_version_id=$3',[input.parseRevision,caseId,documentId])).rows[0] as Job|undefined;
      if(!prior)throw new AppError(404,'parse_not_available');
      await lockProcessingAuthority(db,prior.person_id,prior.input.processingPermit);
      const c=await authorizeCase(db,actor,caseId,'document:parse');
      await assertRoundRequest(db,c,input.roundId,{draft:true});
      await assertDocumentRound(db,c,documentId);
      await this.authority(db,actor,c,[documentId]);
      if(c.revision!==input.expectedRevision||c.revision!==prior.expected_revision)throw new AppError(409,'stale_revision');
      if(actor.accountId!==prior.account_id||actor.personId!==prior.person_id||actor.authVersion!==prior.auth_version)throw new AppError(403,'recovery_owner_changed');
      await authorizeCase(db,actorOf(prior),caseId,prior.required_action);
      await this.authority(db,actorOf(prior),c,[documentId]);
      return idempotent(db,actor,`document.recover:${documentId}`,input.idempotencyKey,input,async()=>{
        const doc=await this.document(db,caseId,documentId,true);
        const job=(await db.query('SELECT * FROM business.document_jobs WHERE id=$1 FOR UPDATE',[prior.id])).rows[0] as Job;
        if(job.kind!=='parse_document'||job.validity!=='current'||doc.current_parse_job_id!==job.id)throw new AppError(409,'stale_parse_revision');
        if(job.state!=='failed')throw new AppError(409,'recovery_not_failed');
        if(await this.configuration(db,c)!==job.configuration_release_id)throw new AppError(409,'configuration_hash_mismatch');
        if(job.input.processingPermit&&!await documentProcessingPermit(db,this.config.cloudExtraction,c,doc,job.input.processingPermit))throw new AppError(403,'document_cloud_scope_denied');
        if((await db.query("SELECT 1 FROM business.work_items WHERE owner_type='DocumentJob' AND owner_id=$1 AND state IN ('pending','running')",[job.id])).rowCount)throw new AppError(409,'recovery_already_queued');
        const availability=await documentRecoveryAvailability(db,job.id);
        if(!availability.available)throw new AppError(409,availability.reason);
        const recoveryId=randomUUID();
        const work=(await db.query("UPDATE business.work_items SET state='pending',attempts=0,epoch=epoch+1,lease_until=NULL,available_at=now(),error_code=NULL,updated_at=now() WHERE owner_type='DocumentJob' AND owner_id=$1 AND kind='parse_document' AND state='rejected' RETURNING id",[job.id])).rows[0];
        if(!work)throw new AppError(409,'recovery_not_failed');
        const workId=work.id;
        await db.query('INSERT INTO business.document_parse_recoveries(id,job_id,work_item_id,requested_by,previous_error_code,mode) VALUES($1,$2,$3,$4,$5,$6)',[recoveryId,job.id,workId,actor.accountId,job.error_code,availability.mode]);
        await db.query("INSERT INTO business.outbox(id,work_item_id,event_type,owner_id) VALUES($1,$2,'work.available',$3) ON CONFLICT(work_item_id,event_type) DO UPDATE SET dispatched_at=NULL",[randomUUID(),workId,job.id]);
        await db.query("UPDATE business.document_jobs SET state='pending',error_code=NULL,updated_at=now() WHERE id=$1",[job.id]);
        await this.parseState(db,job,'pending');
        await audit(db,{actorId:actor.accountId,targetId:job.id,action:'document:recovery_requested',details:{recoveryId,previousErrorCode:job.error_code??'unknown',mode:availability.mode,reason:input.reason}});
        return {jobId:job.id,parseRevision:job.id,status:'pending',recoveryId};
      });
    });
  }
  /** List-entry catch-up only admits originals that have never had a parse job.
   * The case lock serializes tabs, uploads and explicit parse requests. */
  async ensureMaterialProcessing(actor:DocumentActor,caseId:string,raw:unknown){
    const input=z.strictObject({roundId:z.uuid().optional(),expectedRevision:z.number().int().positive()}).parse(raw);
    return transaction(this.pool,async db=>{
      const c=await authorizeCase(db,actor,caseId,'document:parse');
      await assertRoundRequest(db,c,input.roundId,{draft:true});
      if(c.revision!==input.expectedRevision)throw new AppError(409,'stale_revision');
      const started:string[]=[],deferred:{documentId:string;code:string}[]=[];
      if(!this.config.enabled||!this.config.automatic)return {started,deferred};
      if(this.config.requireReviewConfiguration&&!c.configuration_release_id)return {started,deferred};
      const {documents}=await materialMembership(db,caseId,c.current_round_id??null);
      for(const candidate of documents){
        const doc=await this.document(db,caseId,candidate.id,true);
        if(doc.current_parse_job_id||!['parked','capability_disabled','configuration_required'].includes(doc.parse_status))continue;
        if((await db.query("SELECT 1 FROM business.document_jobs WHERE document_version_id=$1 AND kind='parse_document' LIMIT 1",[doc.id])).rowCount)continue;
        await db.query('SAVEPOINT material_list_parse');
        try{
          if(doc.source_format==='docx'&&!this.config.docx)throw new AppError(409,'docx_capability_disabled');
          if(doc.page_count>this.config.maxPages)throw new AppError(422,'document_page_limit');
          await this.accept(db,actor,c,doc,'parse_document','document:parse',{source:'material_list'});
          // A prior review can include this original as an unparsed/pending
          // material. Its frozen result must no longer be treated as current.
          await this.review.invalidateDependencies(db,caseId,{documentVersionId:doc.id,reason:'document_dependency_changed'});
          started.push(doc.id);
        }catch(error){
          if(!(error instanceof AppError)||!['document_cloud_unavailable','document_cloud_scope_denied','document_cloud_format_unsupported','docx_capability_disabled','document_page_limit'].includes(error.code))throw error;
          await db.query('ROLLBACK TO SAVEPOINT material_list_parse');
          deferred.push({documentId:doc.id,code:error.code});
        }
        await db.query('RELEASE SAVEPOINT material_list_parse');
      }
      return {started,deferred};
    });
  }
  async processing(actor:DocumentActor,caseId:string,documentId:string){
    return transaction(this.pool,async db=>{
      const caseRow=await authorizeCase(db,actor,caseId,'case:read',false);const doc=await this.document(db,caseId,documentId);
      if(!this.config.reader)return {documentId,presentation:undefined,recovery:undefined,errorDiagnostic:undefined,status:'capability_disabled',jobId:null,parseRevision:null,progress:{completedPages:0,totalPages:doc.page_count},errorCode:null,allowed_actions:[] as string[],history:[]};
      const history=(await db.query("SELECT * FROM business.document_jobs WHERE document_version_id=$1 AND kind='parse_document' ORDER BY created_at DESC LIMIT 100",[documentId])).rows as Job[];
      const job=history.find(j=>j.id===doc.current_parse_job_id);
      const deferred=!job&&doc.parse_status==='capability_disabled'?(await db.query("SELECT details->>'code' AS code FROM business.audit_events WHERE target_id=$1 AND action='document:automatic_parse_deferred' ORDER BY created_at DESC LIMIT 1",[documentId])).rows[0]:undefined;
      const restoredAuthorization=deferred?.code==='document_cloud_scope_denied'&&!!await documentProcessingPermit(db,this.config.cloudExtraction,caseRow,doc);
      const allowed:string[]=[];
      for(const action of ['document:parse','document:classify']){
        if(action==='document:parse'&&this.config.requireReviewConfiguration&&!caseRow.configuration_release_id)continue;
        if(action==='document:parse'?this.config.enabled:this.config.directory)try{const writable=await authorizeCase(db,actor,caseId,action,false);await assertDocumentRound(db,writable,documentId);allowed.push(action);}catch(error){if(!(error instanceof AppError))throw error;}
      }
      const failureDiagnostic=job?.state==='failed'?ModelDiagnosticSchema.safeParse((await db.query("SELECT details->>'diagnostic' AS diagnostic FROM business.audit_events WHERE target_id=$1 AND action='document:processing_failed' ORDER BY created_at DESC,id DESC LIMIT 1",[job.id])).rows[0]?.diagnostic):undefined;
      let recovery:Awaited<ReturnType<typeof documentRecoveryAvailability>>|undefined;
      if(job?.state==='failed'&&allowed.includes('document:parse')){
        recovery=job.validity!=='current'||job.expected_revision!==caseRow.revision?{available:false,reason:'stale_parse_revision'}:
          job.account_id!==actor.accountId||job.auth_version!==actor.authVersion?{available:false,reason:'recovery_owner_changed'}:
          job.input.processingPermit&&!await documentProcessingPermit(db,this.config.cloudExtraction,caseRow,doc,job.input.processingPermit)?{available:false,reason:'document_cloud_scope_denied'}:
          await documentRecoveryAvailability(db,job.id);
      }
      // Read-only progress metadata. Do not run extraction or expose source text on a status request.
      const preview=job?(await db.query('SELECT state,error_code,page_count FROM business.document_previews WHERE job_id=$1',[job.id])).rows[0]:undefined;
      const sourceAvailable=job?Boolean((await db.query('SELECT 1 FROM business.document_sources WHERE job_id=$1',[job.id])).rowCount):false;
      const artifact=job?(await db.query(`SELECT directory_revision,
        COALESCE(body->'coverageGaps','[]'::jsonb) AS coverage_gaps, jsonb_path_query_array(body, '$.fields[*].coverageGaps[*]') ||
        jsonb_path_query_array(body, '$.fields[*].semanticFilter.reasonCodes[*]') || jsonb_path_query_array(body, '$.fields[*].extractionCoverage.reasonCodes[*]') ||
        CASE WHEN jsonb_path_exists(body, '$.fields[*].extractionCoverage ? (@.completion == "failed" || @.completion == "unknown")')
          THEN '["cloud_completion_incomplete"]'::jsonb ELSE '[]'::jsonb END AS field_gaps
        FROM business.document_artifacts WHERE job_id=$1 ORDER BY directory_revision DESC LIMIT 1`,[job.id])).rows[0]:undefined;
      const extraction=artifact?(await db.query(`SELECT state,error_code,result->'cloudExtraction'->>'version' AS extraction_version,
        COALESCE(result->'coverageGaps','[]'::jsonb) || jsonb_path_query_array(COALESCE(result,'{}'::jsonb), '$.items[*].coverageGaps[*]') ||
        jsonb_path_query_array(COALESCE(result,'{}'::jsonb), '$.items[*].semanticFilter.reasonCodes[*]') ||
        jsonb_path_query_array(COALESCE(result,'{}'::jsonb), '$.items[*].extractionCoverage.reasonCodes[*]') ||
        CASE WHEN result->'cloudExtraction'->>'completion' IN ('failed','unknown') OR jsonb_path_exists(COALESCE(result,'{}'::jsonb), '$.items[*].extractionCoverage ? (@.completion == "failed" || @.completion == "unknown")')
          THEN '["cloud_completion_incomplete"]'::jsonb ELSE '[]'::jsonb END AS coverage_gaps FROM business.document_jobs WHERE document_version_id=$1 AND kind='extract_fields' AND validity='current'
        AND input->>'parseRevision'=$2 AND input->>'directoryRevision'=$3 ORDER BY created_at DESC,id DESC LIMIT 1`,[documentId,job!.id,String(artifact.directory_revision)])).rows[0]:undefined;
      // Diagnostics are codes only: qualified reference labels can contain original text.
      const codes:unknown[]=[...(artifact?.coverage_gaps??[]),...(extraction?.coverage_gaps??artifact?.field_gaps??[])];
      const coverageGaps=[...new Set(codes.map(value=>typeof value==='string'&&/^page_not_processed:[1-9]\d*$/.test(value)?value:
        typeof value==='string'&&/^[a-z][a-z0-9_]*(?::|$)/.test(value)?value.split(':')[0]!:'unclassified'))];
      const sourceOnly=!!(job?.input?.personalDocxSourceOnly||job?.input?.docxExtractionDeferred)&&extraction?.extraction_version!==DOCUMENT_DOCX_VERSION;
      const presentation={...(artifact?{coverageGaps}:{}),sourceAvailable,sourceOnly,
        preview:preview?{status:preview.state,errorCode:preview.error_code,pageCount:preview.page_count}:null,
        hasFieldArtifact:!!artifact,extraction:extraction?{status:extraction.state,errorCode:extraction.error_code}:sourceOnly&&job?.input?.docxExtractionDeferred?{status:'capability_disabled',errorCode:String(job.input.docxExtractionDeferred)}:null};
      return {documentId,presentation,recovery,...(failureDiagnostic?.success?{errorDiagnostic:failureDiagnostic.data}:{}),status:job?.state??(restoredAuthorization?'parked':this.materialParseStatus(caseRow,doc)),jobId:job?.id??null,parseRevision:job?.id??null,
        progress:{completedPages:job?.completed_pages??0,totalPages:job?.total_pages??doc.page_count},errorCode:job?.error_code??(restoredAuthorization?null:deferred?.code??null),allowed_actions:allowed,
        history:history.map(j=>({parseRevision:j.id,createdAt:j.created_at.toISOString(),status:j.state,validity:j.validity,caseRevision:j.expected_revision}))};
    });
  }
  private async readParse(db:PoolClient,actor:DocumentActor,caseId:string,documentId:string,parseRevision?:string){
    const c=await authorizeCase(db,actor,caseId,'evidence:read',false);await this.authority(db,actor,c,[documentId]);const doc=await this.document(db,caseId,documentId);
    const id=parseRevision??doc.current_parse_job_id;
    const job=(await db.query("SELECT * FROM business.document_jobs WHERE id=$1 AND document_version_id=$2 AND case_id=$3 AND kind='parse_document'",[id,documentId,caseId])).rows[0] as Job|undefined;
    if(!job)throw new AppError(409,'parse_not_available');return {doc,job};
  }
  private async latestBundle(db:PoolClient,jobId:string){
    const row=(await db.query(`SELECT id,directory_revision,octet_length(body::text) AS aggregate_bytes,
      CASE WHEN octet_length(body::text)<=$2 THEN body ELSE NULL END AS body
      FROM business.document_artifacts WHERE job_id=$1 ORDER BY directory_revision DESC LIMIT 1`,[jobId,this.aggregateByteLimit])).rows[0];
    if(!row)throw new AppError(409,'index_not_ready');
    this.aggregateBudget(row.aggregate_bytes);return {row,bundle:DocumentBundleSchema.parse(row.body)};
  }
  /** Read an exact review-pinned artifact on the caller's transaction. Never substitutes a newer parse. */
  async reviewBundle(db:PoolClient,actor:DocumentActor,caseId:string,pin:{documentVersionId:string;parseRevision:string|null;directoryRevision:number|null;artifactHash:string|null;sourceSha256:string}){
    if(!pin.parseRevision||!pin.directoryRevision||!pin.artifactHash)throw new AppError(409,'review_evidence_unavailable');
    const {doc,job}=await this.readParse(db,actor,caseId,pin.documentVersionId,pin.parseRevision);
    const row=(await db.query(`SELECT sha256,octet_length(body::text) AS aggregate_bytes,
      CASE WHEN octet_length(body::text)<=$3 THEN body ELSE NULL END AS body FROM business.document_artifacts
      WHERE job_id=$1 AND directory_revision=$2`,[job.id,pin.directoryRevision,this.aggregateByteLimit])).rows[0];
    if(!row||row.sha256!==pin.artifactHash||doc.sha256!==pin.sourceSha256)throw new AppError(409,'review_evidence_changed');
    this.aggregateBudget(row.aggregate_bytes);const bundle=DocumentBundleSchema.parse(row.body);
    if(bundle.scope.caseId!==caseId||bundle.scope.documentVersionId!==doc.id||bundle.scope.parseRevision!==job.id||bundle.scope.sourceSha256!==doc.sha256||bundle.directoryRevision!==String(pin.directoryRevision))throw new AppError(409,'review_evidence_changed');
    return bundle;
  }
  /** The current parse as the reader shows it, on the caller's transaction and with the caller's own document access. */
  async readerBundle(db:PoolClient,actor:DocumentActor,caseId:string,documentId:string){
    this.capability('reader');
    const {doc,job}=await this.readParse(db,actor,caseId,documentId),{bundle}=await this.latestBundle(db,job.id);
    if(bundle.scope.caseId!==caseId||bundle.scope.documentVersionId!==doc.id||bundle.scope.parseRevision!==job.id)throw new AppError(409,'review_evidence_changed');
    return {bundle,filename:String(doc.filename)};
  }
  private aggregateBudget(value:unknown){
    const bytes=Number(value);
    if(!Number.isSafeInteger(bytes)||bytes<0||bytes>this.aggregateByteLimit)throw new AppError(422,'document_aggregate_budget_exceeded');
  }
  private async aggregatePages(db:Pool|PoolClient,jobId:string){
    // A materialized budget and CASE share one snapshot: over-budget JSON never crosses into Node.
    const rows=(await db.query(`WITH budget AS MATERIALIZED (
      SELECT coalesce(sum(octet_length(body::text)),0) AS aggregate_bytes FROM business.document_pages WHERE job_id=$1
    ) SELECT p.page_number,b.aggregate_bytes,CASE WHEN b.aggregate_bytes<=$2 THEN p.body ELSE NULL END AS body
      FROM budget b LEFT JOIN business.document_pages p ON p.job_id=$1 ORDER BY p.page_number`,[jobId,this.aggregateByteLimit])).rows;
    this.aggregateBudget(rows[0].aggregate_bytes);
    return rows.filter(r=>r.page_number!==null).map(r=>DocumentPageArtifactSchema.parse(r.body));
  }
  private async directoryPages(db:PoolClient,jobId:string,bundle:DocumentBundle):Promise<DirectoryPage[]>{
    // Read only canonical IDs and bounded possible titles. Full page OCR, provider
    // responses and images are not transferred to derive a navigation projection.
    const rows=(await db.query(`WITH projections AS MATERIALIZED (
      SELECT p.page_number,jsonb_build_object('pageNumber',p.page_number,'scope',p.body->'scope','regionIds',p.body->'canonicalRegionIds',
        'headings',coalesce((SELECT jsonb_agg(jsonb_build_object('regionId',r->>'region_id','text',r->>'raw_text','textSha256',r->>'raw_text_sha256'))
          FROM jsonb_array_elements(p.body->'regions') r WHERE r->>'kind'='text'
          AND char_length(r->>'raw_text') BETWEEN 1 AND 160 AND (p.body->'canonicalRegionIds') ? (r->>'region_id')),'[]'::jsonb)) AS body
      FROM business.document_pages p WHERE p.job_id=$1 AND p.page_number=ANY($3::integer[])
    ),budget AS MATERIALIZED (SELECT coalesce(sum(octet_length(body::text)),0) AS bytes FROM projections)
    SELECT p.page_number,b.bytes,CASE WHEN b.bytes<=$2 THEN p.body ELSE NULL END AS body
      FROM budget b LEFT JOIN projections p ON true ORDER BY p.page_number`,[jobId,this.aggregateByteLimit,bundle.indexManifest.indexedPageNumbers])).rows;
    this.aggregateBudget(rows[0].bytes);
    const schema=z.strictObject({pageNumber:z.number().int().positive(),scope:DocumentScopeSchema,regionIds:z.array(z.string().min(1).max(200)),
      headings:z.array(z.strictObject({regionId:z.string().min(1).max(200),text:z.string().min(1).max(320),textSha256:z.string().regex(/^[a-f0-9]{64}$/)}))});
    return rows.filter(row=>row.page_number!==null).map(row=>{
      const value=schema.parse(row.body);
      if(JSON.stringify(value.scope)!==JSON.stringify(bundle.scope)||value.headings.some(heading=>digest(heading.text)!==heading.textSha256))throw new AppError(409,'evidence_integrity_failed');
      return {pageNumber:value.pageNumber,regionIds:value.regionIds,headings:value.headings.map(({textSha256:_sha,...heading})=>heading)};
    });
  }
  async pages(actor:DocumentActor,caseId:string,documentId:string,parseRevision?:string){
    this.capability('reader');
    return transaction(this.pool,async db=>{
      const {job}=await this.readParse(db,actor,caseId,documentId,parseRevision);
      const rows=(await db.query(`SELECT page_number,body->'page' AS page,body->'status' AS status,body->'coverageGaps' AS gaps FROM business.document_pages WHERE job_id=$1 ORDER BY page_number`,[job.id])).rows;
      return {items:rows.map(r=>({pageNumber:r.page_number,width:r.page.width,height:r.page.height,pageAssetId:r.page.page_asset_id,status:r.status,coverageGaps:r.gaps})),parseRevision:job.id,totalPages:job.total_pages};
    });
  }
  async source(actor:DocumentActor,caseId:string,documentId:string,parseRevision?:string){
    this.capability('reader');
    return transaction(this.pool,async db=>{
      const {doc,job}=await this.readParse(db,actor,caseId,documentId,parseRevision);
      if(doc.source_format!=='docx')throw new AppError(404,'source_structure_not_applicable');
      const row=(await db.query('SELECT octet_length(body::text) AS bytes,CASE WHEN octet_length(body::text)<=$2 THEN body ELSE NULL END AS body,sha256 FROM business.document_sources WHERE job_id=$1',[job.id,this.aggregateByteLimit])).rows[0];
      if(!row)throw new AppError(409,'source_structure_not_ready');
      this.aggregateBudget(row.bytes);
      const source=DocxSourceDocumentSchema.parse(row.body);
      if(source.sourceSha256!==doc.sha256||digest(JSON.stringify(source))!==row.sha256)throw new AppError(409,'source_integrity_failed');
      const preview=(await db.query('SELECT * FROM business.document_previews WHERE job_id=$1',[job.id])).rows[0];
      const mappings=z.array(SourceMappingSchema).parse((await db.query('SELECT body FROM business.document_source_mappings WHERE job_id=$1',[job.id])).rows[0]?.body??mapSourceEvidence(source,[]));
      return {schemaVersion:'p2.docx.v1',parseRevision:job.id,source,preview:preview?{id:preview.id,status:preview.state,manifest:preview.manifest,coverageGaps:preview.coverage_gaps,pageCount:preview.page_count,errorCode:preview.error_code}:null,mappings};
    });
  }
  async sourceNode(actor:DocumentActor,caseId:string,documentId:string,nodeId:string,parseRevision?:string){
    const data=await this.source(actor,caseId,documentId,parseRevision),node=data.source.nodes.find(n=>n.id===nodeId);
    if(!node)throw new AppError(404,'source_node_not_found');
    return {schemaVersion:data.schemaVersion,parseRevision:data.parseRevision,sourceSha256:data.source.sourceSha256,node,mapping:data.mappings.find((m:any)=>m.sourceNodeId===nodeId),preview:data.preview};
  }
  async page(actor:DocumentActor,caseId:string,documentId:string,pageNumber:number,parseRevision?:string){
    this.capability('reader');
    return transaction(this.pool,async db=>{
      const {doc,job}=await this.readParse(db,actor,caseId,documentId,parseRevision);
      const row=(await db.query('SELECT body,page_asset_id,image_sha256 FROM business.document_pages WHERE job_id=$1 AND page_number=$2',[job.id,pageNumber])).rows[0];
      if(!row)throw new AppError(409,'page_not_ready');
      const page=DocumentPageArtifactSchema.parse(row.body);
      if(page.ocrMarks){
        if(page.scope.caseId!==caseId||page.scope.documentVersionId!==documentId||page.scope.parseRevision!==job.id||page.scope.sourceSha256!==doc.sha256||page.page.page_number!==pageNumber||page.page.page_asset_id!==row.page_asset_id||page.imageSha256!==row.image_sha256)throw new AppError(409,'ocr_mark_evidence_integrity_failed');
        if(doc.source_format==='docx'){
          const preview=(await db.query('SELECT id,pdf_sha256 FROM business.document_previews WHERE job_id=$1',[job.id])).rows[0];
          if(!preview?.pdf_sha256||page.scope.sourceFormat!=='docx'||page.scope.previewRevision!==preview.id||page.scope.previewSha256!==preview.pdf_sha256||page.page.source_sha256!==preview.pdf_sha256)throw new AppError(409,'ocr_mark_evidence_integrity_failed');
        }else if(page.scope.sourceFormat!==(doc.source_format==='pdf'?undefined:doc.source_format)||page.scope.previewRevision||page.scope.previewSha256||page.page.source_sha256!==doc.sha256)throw new AppError(409,'ocr_mark_evidence_integrity_failed');
        try{assertOcrMarkPage(page);}catch{throw new AppError(409,'ocr_mark_evidence_integrity_failed');}
      }
      return page;
    });
  }
  /** Resolve page and derived field anchors within one authorized, immutable parse. */
  async evidence(actor:DocumentActor,caseId:string,documentId:string,pageNumber:number,anchorId:string,parseRevision?:string){
    this.capability('reader');
    return transaction(this.pool,async db=>{
      const {doc,job}=await this.readParse(db,actor,caseId,documentId,parseRevision);
      const row=(await db.query('SELECT body,page_asset_id,image_sha256 FROM business.document_pages WHERE job_id=$1 AND page_number=$2',[job.id,pageNumber])).rows[0];
      if(!row)throw new AppError(409,'page_not_ready');
      const page=DocumentPageArtifactSchema.parse(row.body);
      try{assertOcrMarkPage(page);}catch{throw new AppError(409,'ocr_mark_evidence_integrity_failed');}
      const expected:DocumentScope={caseId,caseRevision:job.expected_revision,configurationReleaseId:job.configuration_release_id,documentVersionId:documentId,parseRevision:job.id,sourceSha256:doc.sha256};
      if(doc.source_format==='jpg'||doc.source_format==='png')expected.sourceFormat=doc.source_format;
      if(doc.source_format==='docx'){
        const preview=(await db.query('SELECT id,pdf_sha256 FROM business.document_previews WHERE job_id=$1',[job.id])).rows[0];
        if(!preview?.pdf_sha256)throw new AppError(409,'evidence_integrity_failed');
        expected.sourceFormat='docx';expected.previewRevision=preview.id;expected.previewSha256=preview.pdf_sha256;
      }
      if(JSON.stringify(page.scope)!==JSON.stringify(expected)||page.page.document_version_id!==documentId||page.page.parse_revision!==job.id||
        page.page.page_number!==pageNumber||page.page.page_asset_id!==row.page_asset_id||page.imageSha256!==row.image_sha256||
        page.page.source_sha256!==(expected.previewSha256??expected.sourceSha256))throw new AppError(409,'evidence_integrity_failed');
      let bundle:DocumentBundle|undefined;
      try{bundle=(await this.latestBundle(db,job.id)).bundle;}catch(error){
        // A completed page remains readable while the document aggregate is pending.
        if(!(error instanceof AppError&&error.code==='index_not_ready'))throw error;
      }
      if(bundle&&JSON.stringify(bundle.scope)!==JSON.stringify(expected))throw new AppError(409,'evidence_integrity_failed');
      const anchor=bundle?.anchors.find(a=>a.anchor_id===anchorId)??page.anchors.find(a=>a.anchor_id===anchorId);
      if(!anchor||anchor.page_number!==pageNumber)throw new AppError(404,'evidence_not_found');
      const regions=page.regions.filter(r=>anchor.block_ids.includes(r.region_id));
      try{
        if(new Set(regions.map(r=>r.region_id)).size!==regions.length||new Set(anchor.block_ids).size!==regions.length||
          anchor.text_span_refs.some(span=>!anchor.block_ids.includes(span.block_id)))throw new Error('missing_evidence_region');
        for(const region of regions){
          if(region.page_asset_id!==page.page.page_asset_id||region.document_version_id!==documentId||region.parse_revision!==job.id||
            (region.raw_text===null?region.raw_text_sha256!==null:digest(region.raw_text)!==region.raw_text_sha256))throw new Error('stale_evidence_region');
          region.polygons.forEach(p=>validatePolygon(p,page.page.width,page.page.height));
        }
        validateAnchorSource(anchor,page.page,regions);
      }catch{throw new AppError(409,'evidence_integrity_failed');}
      return {anchor,regions,coverageGaps:[...new Set([...page.coverageGaps,...(bundle?.coverageGaps??[])])],scope:page.scope};
    });
  }
  async image(actor:DocumentActor,caseId:string,documentId:string,pageNumber:number,parseRevision?:string){
    this.capability('reader');
    const row=await transaction(this.pool,async db=>{
      const {job}=await this.readParse(db,actor,caseId,documentId,parseRevision);
      const r=(await db.query('SELECT image_key,image_version_id,image_sha256 FROM business.document_pages WHERE job_id=$1 AND page_number=$2',[job.id,pageNumber])).rows[0];
      if(!r)throw new AppError(409,'page_not_ready');return r;
    });
    const bytes=await this.store.read(row.image_key,row.image_version_id,this.config.maxPageBytes);
    if(digest(bytes)!==row.image_sha256)throw new AppError(409,'page_integrity_failed');
    await transaction(this.pool,async db=>{await this.readParse(db,actor,caseId,documentId,parseRevision);});return bytes;
  }
  async artifact(actor:DocumentActor,caseId:string,documentId:string,kind:'directory'|'fields'|'signatures',parseRevision?:string,signatureReviewId?:string){
    this.capability('reader');
    return transaction(this.pool,async db=>{
      const {doc,job}=await this.readParse(db,actor,caseId,documentId,parseRevision),{row,bundle}=await this.latestBundle(db,job.id);
      const common={parseRevision:job.id,directoryRevision:row.directory_revision,anchors:bundle.anchors,sourceAnchors:bundle.sourceAnchors??[],coverageGaps:bundle.coverageGaps};
      if(kind==='directory'){
        const config=await this.pinnedConfiguration(db,job.configuration_release_id),directory=bundle.logicalDocuments.filter(d=>!d.id.startsWith('source-document:'));
        const preserveClassification=bundle.classificationMode==='content-first-v1'||[DOCUMENT_CLOUD_VERSION,DOCUMENT_CLOUD_V2_VERSION,DOCUMENT_DOCX_VERSION].includes(job.result?.cloudExtraction?.version);
        const storedOnly=preserveClassification||directory.some(document=>document.source==='manual')||bundle.coverageGaps.some(gap=>['preview_revision_or_visibility_review_required','preview_unavailable_source_review_required'].includes(gap));
        const directoryDisplay=displayLogicalDirectory(bundle,storedOnly?[]:await this.directoryPages(db,job.id,bundle),config,{preserveClassification});
        return {...common,directory,directoryDisplay,directoryDisplayPolicy:preserveClassification?CLOUD_DIRECTORY_POLICY:DIRECTORY_POLICY,taxonomy:[...config.taxonomy.filter(t=>t.id!==SUPPLEMENTAL_MATERIAL_ID),supplementalTaxonomy],revision:row.directory_revision};
      }
      if(kind==='fields'){
        // Filtering is an explicit durable command, never an inference call on GET.
        // A directory revision invalidates the previous projection without changing OCR artifacts.
        const latest=(await db.query(`SELECT id,state,error_code,configuration_release_id,result,result->'items' AS items FROM business.document_jobs
          WHERE document_version_id=$1 AND kind='extract_fields' AND validity='current'
          AND input->>'parseRevision'=$2 AND input->>'directoryRevision'=$3
          ORDER BY created_at DESC,id DESC LIMIT 1`,[documentId,job.id,String(row.directory_revision)])).rows[0];
        const completed=latest&&['ready','partial'].includes(latest.state)&&Array.isArray(latest.items);
        const initial=job.result?.fieldFilter?.directoryRevision===row.directory_revision?job.result.fieldFilter.items:undefined;
        const source=completed?z.array(DocumentFieldObservationSchema).parse(latest.items):!latest&&Array.isArray(initial)?z.array(DocumentFieldObservationSchema).parse(initial):bundle.fields;
        const recipes=await this.semanticFieldRecipes(db,latest?.configuration_release_id??job.configuration_release_id);
        const filterFieldIds=recipes?.map(field=>field.id);
        const legacyRequired=Boolean(this.config.fieldFilter||initial||source.some(field=>field.semanticFilter)||latest&&!completed);
        // A value the reviewer confirmed for an empty field is shown as this file's value, pinned to this parse.
        const items=withSuppliedFields(projectFieldCandidates(source,bundle.fields,filterFieldIds,legacyRequired,latest?.state==='failed'),await suppliedFieldValues(db,caseId,doc.round_id??null),{id:documentId,parseRevision:job.id,directoryRevision:row.directory_revision});
        const manifest=await this.reviewManifest(db,latest?.configuration_release_id??job.configuration_release_id);
        const caseRow=await authorizeCase(db,actor,caseId,'case:read',false);
        const bound=caseRow.configuration_release_id?await this.review.getPublished(db,caseRow.configuration_release_id):undefined;
        const configuration={releaseId:manifest?.releaseId??null,label:manifest?.label??null,
          currentReleaseId:bound?.releaseId??null,currentLabel:bound?.manifest.label??null,
          matchesCurrent:!!bound&&(!latest||!!completed)&&bound.documentConfigurationId===(latest?.configuration_release_id??job.configuration_release_id)};
        const titlePage=manifest&&bundle.scope?.sourceFormat!=='docx'?(await db.query('SELECT body FROM business.document_pages WHERE job_id=$1 AND page_number=1 AND octet_length(body::text)<=$2',[job.id,this.aggregateByteLimit])).rows[0]?.body:undefined;
        const parsedTitlePage=DocumentPageArtifactSchema.safeParse(titlePage);
        const titleEvidence=parsedTitlePage.success?{page:parsedTitlePage.data,taxonomy:(await this.pinnedConfiguration(db,job.configuration_release_id)).taxonomy}:undefined;
        const applicability=fieldApplicability(bundle,manifest?.fields,row.directory_revision,items,titleEvidence);
        const sourceOnly=Boolean((job.input?.personalDocxSourceOnly||job.input?.docxExtractionDeferred)&&!(completed&&latest.result?.cloudExtraction?.version===DOCUMENT_DOCX_VERSION));
        const fieldCapabilities=manifest?.fields.map(field=>({id:field.id,taxonomyIds:field.taxonomyIds,mode:field.recipe.mode==='manual'||sourceOnly&&field.recipe.mode==='cloud_grounded_extract'?'manual' as const:'automatic' as const}));
        const filterEnabled=(!sourceOnly||!!bound?.manifest.docxExtraction)&&(filterFieldIds===undefined?legacyRequired:Boolean((bound?.manifest.fields??recipes)?.some(field=>field.recipe.mode==='cloud_grounded_extract'?this.config.cloudExtraction:field.recipe.mode==='private_candidate_filter'?this.fieldFilter:false)));
        const fieldAnchors=completed?latest.result.anchors??common.anchors:common.anchors;
        const needsSourceView=manifest?.fields.some(definition=>items.some(field=>field.fieldId===definition.id && field.semanticFilter?.state==='completed' &&
          (field.candidates.length>1 || supportsTableRecords(definition)&&field.candidates.length>0))) && !sourceOnly;
        const viewPages=needsSourceView?await this.aggregatePages(db,job.id).catch(error=>{
            // Optional historical display proof must not make a previously
            // readable field response fail when page evidence exceeds budget.
            if(error instanceof AppError && error.code==='document_aggregate_budget_exceeded')return [];
            throw error;
          }):[];
        const nameView=needsSourceView && manifest
          ? associateBilingualNames({fields:items,definitions:manifest.fields,pages:viewPages,logicalDocuments:bundle.logicalDocuments,anchors:fieldAnchors})
          : {fields:items,anchors:fieldAnchors};
        const tableView=projectTableRecords({fields:presentDocumentFields(nameView.fields).map(field=>reconcileSourceOverlaps(field,nameView.anchors,viewPages)),definitions:manifest?.fields??[],pages:viewPages,logicalDocuments:bundle.logicalDocuments,anchors:nameView.anchors});
        const signatureView=!sourceOnly&&manifest?.fields.some(isSourceSignatureField)&&bundle.scope.sourceFormat!=='docx'&&bundle.logicalDocuments.some(d=>['cgt_resolution','cgt_guarantee','pg_guarantee','pg_note'].includes(d.labelId??''))
          ? projectSignatureFields(tableView.fields,manifest.fields,bundle.logicalDocuments,automaticSignaturesFromContext(await signatureSourceContext(db,caseRow,documentId,job.id,undefined,row.directory_revision)))
          : tableView.fields;
        const moneyView=projectGuaranteeMoney(signatureView,tableView.anchors,bundle,parsedTitlePage.success?parsedTitlePage.data:undefined,manifest?.fields.filter(f=>f.recipe.mode==='manual').map(f=>f.id)??[]);
    const fieldCorrections=await fieldDisplayCorrections(db,caseId,doc.round_id??null,caseRow.configuration_release_id,{id:documentId,parseRevision:job.id,directoryRevision:row.directory_revision,fields:source});
        return {...common,configuration,...(sourceOnly?{sourceOnly:'docx' as const}:{}),anchors:moneyView.anchors,...(completed?{sourceAnchors:latest.result.sourceAnchors??common.sourceAnchors}:{}),items,presentationItems:correctedFieldDisplay(moneyView.fields,fieldCorrections),fieldCorrections,filterEnabled,applicability,...(fieldCapabilities?{fieldCapabilities}:{}),...(filterFieldIds===undefined?{}:{filterFieldIds}),...(latest?{filterJob:{id:latest.id,status:latest.state,errorCode:latest.error_code}}:{})};
      }
      const markPageSources=bundle.ocrMarkPages?.length?(await db.query('SELECT page_number,page_asset_id,image_sha256 FROM business.document_pages WHERE job_id=$1',[job.id])).rows:[];
      if(bundle.ocrMarkPages?.length&&(bundle.scope.caseId!==caseId||bundle.scope.documentVersionId!==documentId||bundle.scope.parseRevision!==job.id||bundle.scope.sourceSha256!==doc.sha256))throw new AppError(409,'ocr_mark_evidence_integrity_failed');
      if(bundle.ocrMarkPages?.length&&doc.source_format==='docx'){
        const preview=(await db.query('SELECT id,pdf_sha256 FROM business.document_previews WHERE job_id=$1',[job.id])).rows[0];
        if(!preview?.pdf_sha256||bundle.scope.sourceFormat!=='docx'||bundle.scope.previewRevision!==preview.id||bundle.scope.previewSha256!==preview.pdf_sha256)throw new AppError(409,'ocr_mark_evidence_integrity_failed');
      }
      let ocrMarkPages;try{ocrMarkPages=ocrMarkPagesForBundle(bundle,markPageSources);}catch{throw new AppError(409,'ocr_mark_evidence_integrity_failed');}
      return {...common,items:bundle[kind],ocrMarkPages,review:await this.signatures.read(db,actor,caseId,documentId,bundle,row.directory_revision,signatureReviewId)};
    });
  }
  async checkSignatures(actor:DocumentActor,caseId:string,documentId:string,raw:unknown){
    if(actor.documentAuthority)throw new AppError(403,'scope_denied');
    return this.signatures.check(actor,caseId,documentId,raw,(db,c,doc,input)=>this.accept(db,actor,c,doc,'review_signatures','document:parse',input));
  }
  async fieldTranslationTargets(actor:DocumentActor,caseId:string,documentId:string,query:unknown){
    return this.translations.fieldTargets(actor,caseId,documentId,query);
  }
  async translationTargets(actor:DocumentActor,caseId:string,documentId:string,query:unknown){
    if(actor.documentAuthority)throw new AppError(403,'scope_denied');
    return this.translations.targets(actor,caseId,documentId,query);
  }
  async translate(actor:DocumentActor,caseId:string,documentId:string,raw:unknown){
    if(actor.documentAuthority)throw new AppError(403,'scope_denied');
    return this.translations.create(actor,caseId,documentId,raw,(db,c,doc,input)=>this.accept(db,actor,c,doc,'translate_document',input.referenceRoundId?'document:translate':'document:parse',input));
  }
  async translateFullText(actor:DocumentActor,caseId:string,documentId:string,raw:unknown){
    if(actor.documentAuthority)throw new AppError(403,'scope_denied');
    return this.translations.create(actor,caseId,documentId,raw,(db,c,doc,input)=>this.accept(db,actor,c,doc,'translate_document',input.referenceRoundId?'document:translate':'document:parse',input),true);
  }
  async translation(actor:DocumentActor,caseId:string,documentId:string,jobId:string,existingDb?:PoolClient){
    if(actor.documentAuthority)throw new AppError(403,'scope_denied');
    return this.translations.get(actor,caseId,documentId,jobId,existingDb);
  }
  async translationList(actor:DocumentActor,caseId:string,documentId:string,query:unknown){
    if(actor.documentAuthority)throw new AppError(403,'scope_denied');
    return this.translations.list(actor,caseId,documentId,query);
  }
  async confirmSignature(actor:DocumentActor,caseId:string,documentId:string,raw:unknown){
    if(actor.documentAuthority)throw new AppError(403,'scope_denied');
    return this.signatures.confirm(actor,caseId,documentId,raw);
  }
  signatureInformation(actor:DocumentActor,caseId:string,documentId:string,parseRevision?:string,recordId?:string){
    if(actor.documentAuthority)throw new AppError(403,'scope_denied');
    return this.signatures.information(actor,caseId,documentId,parseRevision,recordId);
  }
  saveSignatureInformation(actor:DocumentActor,caseId:string,documentId:string,raw:unknown){
    if(actor.documentAuthority)throw new AppError(403,'scope_denied');
    return this.signatures.saveInformation(actor,caseId,documentId,raw);
  }
  async reviseDirectory(actor:DocumentActor,caseId:string,documentId:string,raw:unknown){
    this.capability('directory');
    const input=command.extend({parseRevision:z.uuid(),expectedDirectoryRevision:z.number().int().positive(),logicalDocuments:z.array(DocumentLogicalDocumentSchema).min(1).max(1000),continueExtraction:z.boolean().optional()}).parse(raw);
    if(input.continueExtraction)this.enabled();
    // The preliminary read permits bounded derivation without retaining a DB transaction over OSS.
    const prepared=await transaction(this.pool,async db=>{
      const c=await authorizeCase(db,actor,caseId,'document:classify',false);await assertRoundRequest(db,c,input.roundId,{draft:true});await assertDocumentRound(db,c,documentId);
      if(c.revision!==input.expectedRevision)throw new AppError(409,'stale_revision');
      const receipt=(await db.query('SELECT input_hash,result FROM business.command_receipts WHERE receipt_key=$1',[`${actor.accountId}:document.directory:${documentId}:${input.idempotencyKey}`])).rows[0];
      if(receipt){if(receipt.input_hash!==inputHash(input))throw new AppError(409,'idempotency_conflict');return {receipt:receipt.result};}
      const {doc,job}=await this.readParse(db,actor,caseId,documentId,input.parseRevision);
      if(doc.current_parse_job_id!==job.id)throw new AppError(409,'stale_parse_revision');
      const {row,bundle}=await this.latestBundle(db,job.id);
      if(row.directory_revision!==input.expectedDirectoryRevision)throw new AppError(409,'stale_directory_revision');
      const pages=await this.aggregatePages(db,job.id);
      return {job,bundle,pages,config:await this.pinnedConfiguration(db,job.configuration_release_id)};
    });
    if('receipt'in prepared)return prepared.receipt as {directory:DocumentBundle['logicalDocuments'];revision:number;directoryRevision:number;parseRevision:string;extraction?:{jobId:string;status:string}};
    let bundle=reviseLogicalDirectory(prepared.bundle,input.logicalDocuments,{expectedDirectoryRevision:String(input.expectedDirectoryRevision),pages:prepared.pages,config:prepared.config,reason:input.reason});
    if(bundle.scope.sourceFormat==='docx'){
      const source=await this.source(actor,caseId,documentId,input.parseRevision);
      bundle=addSourceEvidence(source.source,bundle.scope,prepared.config,source.preview?.coverageGaps??[],prepared.pages,bundle).bundle;
    }
    if(fixedMaterialType(bundle)===SUPPLEMENTAL_MATERIAL_ID)bundle={...bundle,fields:[]};
    const bytes=Buffer.from(JSON.stringify(bundle)),key=`${this.upload.prefix}derived/${prepared.job.id}/directory-${randomUUID()}.json`, object=await this.put(key,bytes,'application/json',MAX_BUNDLE_BYTES);
    return transaction(this.pool,async db=>{
      const c=await authorizeCase(db,actor,caseId,'document:classify');await assertRoundRequest(db,c,input.roundId,{draft:true});await assertDocumentRound(db,c,documentId);
      if(input.continueExtraction)await authorizeCase(db,actor,caseId,'document:parse',false);
      if(c.revision!==input.expectedRevision)throw new AppError(409,'stale_revision');
      return idempotent(db,actor,`document.directory:${documentId}`,input.idempotencyKey,input,async()=>{
        const doc=await this.document(db,caseId,documentId,true);
        if(doc.current_parse_job_id!==input.parseRevision)throw new AppError(409,'stale_parse_revision');
        const {row}=await this.latestBundle(db,input.parseRevision);
        if(row.directory_revision!==input.expectedDirectoryRevision)throw new AppError(409,'stale_directory_revision');
        const revision=row.directory_revision+1;
        await db.query('INSERT INTO business.document_artifacts(id,job_id,directory_revision,body,object_key,oss_version_id,sha256,created_by,reason) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)',[randomUUID(),input.parseRevision,revision,JSON.stringify(bundle),key,object.versionId,digest(bytes),actor.personId,input.reason]);
        await persistDocumentIndex(db,bundle,revision);
        await this.invalidateDerived(db,caseId,input.parseRevision);
        await db.query("INSERT INTO business.contributions(id,case_id,person_id,kind) VALUES($1,$2,$3,'document_classification')",[randomUUID(),caseId,actor.personId]);
        await audit(db,{actorId:actor.accountId,targetId:documentId,action:'document:classify',details:{directoryRevision:revision}});
        // Commit the new directory and its durable continuation together. A failed
        // admission rolls both back; receipt replay never queues another task.
        let extraction;
        if(input.continueExtraction&&fixedMaterialType(bundle)!==SUPPLEMENTAL_MATERIAL_ID){
          const configuration=await this.configuration(db,c),target=await this.pinnedConfiguration(db,configuration);
          const supplement=digest(JSON.stringify(prepared.config.fields))!==digest(JSON.stringify(target.fields));
          const accepted=await this.accept(db,actor,c,doc,'extract_fields','document:parse',{parseRevision:input.parseRevision,directoryRevision:revision,mode:supplement?'supplement_fields':'filter_only',reason:input.reason});
          extraction={jobId:accepted.jobId,status:accepted.status};
        }
        return {directory:bundle.logicalDocuments,revision,directoryRevision:revision,parseRevision:input.parseRevision,...(extraction?{extraction}:{})};
      });
    });
  }
  async search(actor:DocumentActor,caseId:string,raw:unknown){
    this.capability('search');
    const input=z.strictObject({documentId:z.uuid(),parseRevision:z.uuid(),query:z.string().trim().min(1).max(2000),filter:z.strictObject({logicalDocumentId:z.string().min(1).max(200).optional(),pageNumbers:z.array(z.number().int().positive()).max(DOCUMENT_PAGE_LIMIT).optional()}).optional(),expectedRevision:z.number().int().positive().optional()}).parse(raw);
    return transaction(this.pool,async db=>{
      const {job}=await this.readParse(db,actor,caseId,input.documentId,input.parseRevision),{row,bundle}=await this.latestBundle(db,job.id);
      if(input.expectedRevision!==undefined&&input.expectedRevision!==bundle.scope.caseRevision)throw new AppError(409,'stale_revision');
      const candidates=await documentIndexCandidates(db,bundle,row.directory_revision,input.query,input.filter);
      return searchEvidenceFromCandidates(bundle,input.query,{scope:bundle.scope,maxChunks:20,maxCharacters:30000,maxDependencyDepth:8},candidates);
    });
  }
  async compare(actor:DocumentActor,caseId:string,raw:unknown){
    this.capability('comparison');const input=compareCommand.parse(raw);
    return transaction(this.pool,async db=>{
      const c=await authorizeCase(db,actor,caseId,'evidence:read');
      await this.authority(db,actor,c,[input.beforeDocumentId,input.afterDocumentId]);
      if(c.revision!==input.expectedRevision)throw new AppError(409,'stale_revision');
      return idempotent(db,actor,`document.compare:${caseId}`,input.idempotencyKey,input,async()=>{
        const before=await this.readParse(db,actor,caseId,input.beforeDocumentId,input.beforeParseRevision);
        const after=await this.readParse(db,actor,caseId,input.afterDocumentId,input.afterParseRevision);
        const beforeArtifact=await this.latestBundle(db,before.job.id),afterArtifact=await this.latestBundle(db,after.job.id);
        return this.accept(db,actor,c,after.doc,'compare_document_versions','evidence:read',{...input,beforeDirectoryRevision:beforeArtifact.row.directory_revision,afterDirectoryRevision:afterArtifact.row.directory_revision});
      });
    });
  }
  async extract(actor:DocumentActor,caseId:string,documentId:string,raw:unknown){
    this.enabled();const input=command.extend({parseRevision:z.uuid(),fieldIds:z.array(z.string().min(1).max(200)).min(1).max(100).optional()}).parse(raw);
    return transaction(this.pool,async db=>{
      const c=await authorizeCase(db,actor,caseId,'document:parse');await assertRoundRequest(db,c,input.roundId,{draft:true});await assertDocumentRound(db,c,documentId);
      await this.authority(db,actor,c,[documentId]);
      if(c.revision!==input.expectedRevision)throw new AppError(409,'stale_revision');
      return idempotent(db,actor,`document.extract:${documentId}`,input.idempotencyKey,input,async()=>{
        const {doc,job}=await this.readParse(db,actor,caseId,documentId,input.parseRevision),{row}=await this.latestBundle(db,job.id);
        if(doc.current_parse_job_id!==job.id)throw new AppError(409,'stale_parse_revision');
        const configuration=await this.configuration(db,c),original=await this.pinnedConfiguration(db,job.configuration_release_id),target=await this.pinnedConfiguration(db,configuration);
        if((this.config.fieldFilter||this.config.cloudExtraction)&&!input.fieldIds){
          const pending=(await db.query(`SELECT id,state FROM business.document_jobs WHERE document_version_id=$1 AND kind='extract_fields'
            AND validity='current' AND state IN ('pending','running') AND input->>'parseRevision'=$2
            AND input->>'directoryRevision'=$3 AND configuration_release_id=$4 AND expected_revision=$5
            ORDER BY created_at DESC LIMIT 1`,[documentId,job.id,String(row.directory_revision),configuration,c.revision])).rows[0];
          if(pending)return {jobId:pending.id,status:pending.state};
        }
        if(input.fieldIds&&(new Set(input.fieldIds).size!==input.fieldIds.length||input.fieldIds.some(id=>!target.fields.some(field=>field.id===id))))throw new AppError(422,'extraction_field_not_in_configuration');
        const supplement=digest(JSON.stringify(original.fields))!==digest(JSON.stringify(target.fields));
        return this.accept(db,actor,c,doc,'extract_fields','document:parse',{parseRevision:job.id,directoryRevision:row.directory_revision,mode:supplement?'supplement_fields':'filter_only',...(input.fieldIds?{fieldIds:input.fieldIds}:{}),reason:input.reason});
      });
    });
  }
  async job(actor:DocumentActor,jobId:string){
    this.capability('reader');
    return transaction(this.pool,async db=>{
      const job=(await db.query('SELECT * FROM business.document_jobs WHERE id=$1',[jobId])).rows[0] as Job|undefined;
      if(!job)throw new AppError(404,'tool_job_not_found');
      if(job.kind==='translate_document'&&actor.documentAuthority)throw new AppError(403,'scope_denied');
      await authorizeCase(db,actor,job.case_id,'evidence:read',false);
      if(job.person_id!==actor.personId)throw new AppError(404,'tool_job_not_found');
      const c=await authorizeCase(db,actor,job.case_id,'evidence:read',false);
      await this.authority(db,actor,c,job.kind==='compare_document_versions'?[job.input.beforeDocumentId,job.input.afterDocumentId]:[job.document_version_id]);
      if(job.kind==='translate_document'){
        const result=await this.translations.get(actor,job.case_id,job.document_version_id,job.id,db);
        return {...projection(job),status:result.status,validity:result.validity,result};
      }
      const progress=(await db.query(`SELECT count(*)::int AS dispatched,count(*) FILTER(WHERE state='completed')::int AS completed,
        count(*) FILTER(WHERE state='unknown')::int AS unknown,count(*) FILTER(WHERE state='failed')::int AS failed
        FROM business.field_filter_calls WHERE job_id=$1`,[job.id])).rows[0];
      return {...projection(job),fieldFilterProgress:{...progress,callLimit:FIELD_FILTER_DURABLE_CALL_LIMIT}};
    });
  }
  async cancel(actor:DocumentActor,jobId:string){
    return transaction(this.pool,async db=>{
      const job=(await db.query('SELECT * FROM business.document_jobs WHERE id=$1',[jobId])).rows[0] as Job|undefined;
      if(!job||job.person_id!==actor.personId)throw new AppError(404,'tool_job_not_found');
      if(job.kind==='translate_document'&&actor.documentAuthority)throw new AppError(403,'scope_denied');
      const writable=await authorizeCase(db,actor,job.case_id,job.required_action);if(job.required_action!=='evidence:read'&&!(job.kind==='translate_document'&&job.required_action==='document:translate'&&job.input.referenceRoundId))await assertDocumentRound(db,writable,job.document_version_id);
      if(job.kind==='translate_document')await this.translations.fence(db,job);
      const work=await db.query("UPDATE business.work_items SET state='canceled',epoch=epoch+1,lease_until=NULL WHERE owner_type='DocumentJob' AND owner_id=$1 AND state IN ('pending','running') RETURNING id",[jobId]);
      if(work.rowCount){await db.query("UPDATE business.document_jobs SET state='canceled',updated_at=now() WHERE id=$1",[jobId]);await this.parseState(db,job,'canceled');}
      return {jobId,status:work.rowCount?'canceled':job.state};
    });
  }
  async claim(workId?:string):Promise<ClaimedWork|undefined>{
    if((!this.config.enabled&&!this.config.comparison&&!this.config.translation)||this.stopping)return undefined;
    const result=await this.pool.query(`UPDATE business.work_items SET state='running',attempts=attempts+1,epoch=epoch+1,lease_until=now()+$2*interval '1 second',updated_at=now()
      WHERE id=(SELECT w.id FROM business.work_items w JOIN business.document_jobs j ON j.id=w.owner_id WHERE owner_type='DocumentJob' AND j.validity='current' AND available_at<=now()
      AND ((j.kind IN ('parse_document','extract_fields','review_signatures') AND $3::boolean) OR (j.kind='compare_document_versions' AND $4::boolean) OR (j.kind='translate_document' AND $6::boolean))
      AND ($5::boolean OR j.kind='translate_document' OR EXISTS(SELECT 1 FROM business.document_versions d WHERE d.id=j.document_version_id AND d.source_format IN ('pdf','jpg','png')))
      AND (w.state='pending' OR w.state='running' AND lease_until<now()) AND ($1::uuid IS NULL OR w.id=$1) ORDER BY available_at FOR UPDATE OF w SKIP LOCKED LIMIT 1) RETURNING *`,[workId??null,this.config.leaseSeconds,this.config.enabled,this.config.comparison,Boolean(this.config.docx),Boolean(this.config.translation)]);
    return result.rows[0];
  }
  private async fence(db:PoolClient,job:Job,work:ClaimedWork){
    if(this.stopping)throw new AppError(409,'worker_stopping');
    await lockProcessingAuthority(db,job.person_id,job.input.processingPermit);
    const actor=actorOf(job),c=await authorizeCase(db,actor,job.case_id,job.required_action);if(job.required_action!=='evidence:read'&&!(job.kind==='translate_document'&&job.required_action==='document:translate'&&job.input.referenceRoundId))await assertDocumentRound(db,c,job.document_version_id);
    await this.authority(db,actor,c,job.kind==='compare_document_versions'?[job.input.beforeDocumentId,job.input.afterDocumentId]:[job.document_version_id]);
    if(c.revision!==job.expected_revision&&!(job.kind==='translate_document'&&job.input.referenceRoundId))throw new AppError(409,'stale_revision');
    const doc=await this.document(db,job.case_id,job.document_version_id,true);
    if(job.input.processingPermit&&!await documentProcessingPermit(db,this.config.cloudExtraction,c,doc,job.input.processingPermit))throw new AppError(403,'document_cloud_scope_denied');
    if(job.kind==='parse_document'&&doc.current_parse_job_id!==job.id)throw new AppError(409,'stale_parse_revision');
    if(['extract_fields','review_signatures','translate_document'].includes(job.kind)&&doc.current_parse_job_id!==job.input.parseRevision)throw new AppError(409,'stale_parse_revision');
    if(job.kind==='review_signatures')await this.signatures.fence(db,job);
    if(job.kind==='translate_document')await this.translations.fence(db,job);
    const current=(await db.query('SELECT validity FROM business.document_jobs WHERE id=$1',[job.id])).rows[0];
    if(current?.validity!=='current')throw new AppError(409,'stale_job');
    const lease=(await db.query("SELECT id FROM business.work_items WHERE id=$1 AND epoch=$2 AND state='running' AND lease_until>now() FOR UPDATE",[work.id,work.epoch])).rows[0];
    if(!lease)throw new AppError(409,'lease_lost');return doc;
  }
  private async put(key:string,bytes:Buffer,type:'image/png'|'application/json'|'application/pdf',maxBytes=this.config.maxPageBytes){
    if(bytes.length>maxBytes)throw new ServiceError('derived_object_too_large');
    if(!this.store.put)throw new ServiceError('derived_storage_unavailable');
    return this.store.put(key,bytes,type);
  }
  private async prepareDocx(job:Job,work:ClaimedWork,bytes:Buffer,signal:AbortSignal){
    if(!this.config.docx)throw new ServiceError('docx_capability_disabled');
    let sourceRow=(await this.pool.query('SELECT body,sha256 FROM business.document_sources WHERE job_id=$1',[job.id])).rows[0];
    if(!sourceRow){
      const source=await parseDocx(bytes),body=Buffer.from(JSON.stringify(source)),key=`${this.upload.prefix}derived/${job.id}/source-${randomUUID()}.json`;
      const stored=await this.put(key,body,'application/json',MAX_BUNDLE_BYTES);
      await transaction(this.pool,async db=>{await this.fence(db,job,work);await db.query('INSERT INTO business.document_sources(job_id,body,object_key,oss_version_id,sha256) VALUES($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING',[job.id,JSON.stringify(source),key,stored.versionId,digest(body)]);});
      sourceRow={body:source,sha256:digest(body)};
    }
    const source=DocxSourceDocumentSchema.parse(sourceRow.body);
    if(source.sourceSha256!==digest(bytes)||digest(JSON.stringify(source))!==sourceRow.sha256)throw new ServiceError('source_integrity_failed');
    let preview=(await this.pool.query('SELECT * FROM business.document_previews WHERE job_id=$1',[job.id])).rows[0];
    if(!preview){
      await transaction(this.pool,db=>this.fence(db,job,work));
      let converted:Awaited<ReturnType<typeof this.docxConverter>>|undefined,code:string|undefined;
      if(this.config.docxPreview){
        try{converted=await this.docxConverter(bytes,{signal});}
        catch(error){signal.throwIfAborted();if(error instanceof ServiceError||error instanceof DocxError)code=error.code;else throw error;}
      }else code='docx_preview_disabled';
      signal.throwIfAborted();
      const id=randomUUID();
      if(converted){
        converted.manifest=DocxConversionManifestSchema.parse(converted.manifest);
        if(converted.manifest.pageCount>this.config.maxPages)throw new ServiceError('document_page_limit');
        if(converted.manifest.sourceSha256!==source.sourceSha256||converted.manifest.pdfSha256!==digest(converted.pdf))throw new ServiceError('preview_integrity_failed');
        const key=`${this.upload.prefix}derived/${job.id}/preview-${id}.pdf`,stored=await this.put(key,converted.pdf,'application/pdf',50*1024*1024);
        const manifest=converted.manifest,gaps=manifest.coverageGaps;
        await transaction(this.pool,async db=>{await this.fence(db,job,work);await db.query(`INSERT INTO business.document_previews(job_id,id,state,manifest,coverage_gaps,pdf_key,pdf_version_id,pdf_sha256,page_count)
          VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT DO NOTHING`,[job.id,id,gaps.length?'partial':'ready',JSON.stringify(manifest),JSON.stringify(gaps),key,stored.versionId,manifest.pdfSha256,manifest.pageCount]);
          await db.query('UPDATE business.document_jobs SET total_pages=$2 WHERE id=$1',[job.id,manifest.pageCount]);});
      }else{
        await transaction(this.pool,async db=>{await this.fence(db,job,work);await db.query('INSERT INTO business.document_previews(job_id,id,state,coverage_gaps,error_code) VALUES($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING',[job.id,id,this.config.docxPreview?'failed':'unavailable',JSON.stringify([code??'docx_conversion_failed']),code]);});
      }
      preview=(await this.pool.query('SELECT * FROM business.document_previews WHERE job_id=$1',[job.id])).rows[0];
    }
    if(!preview.pdf_key)return {source,preview,bytes:null};
    const pdf=await this.store.read(preview.pdf_key,preview.pdf_version_id,50*1024*1024);
    if(digest(pdf)!==preview.pdf_sha256)throw new ServiceError('preview_integrity_failed');
    return {source,preview,bytes:pdf};
  }
  async processWork(work:ClaimedWork){
    const job=(await this.pool.query('SELECT * FROM business.document_jobs WHERE id=$1',[work.owner_id])).rows[0] as Job|undefined;
    if(!job)return;
    const controller=new AbortController();this.active.add(controller);let renewing=false;
    const timer=setInterval(()=>{
      if(renewing)return;renewing=true;
      void this.pool.query("UPDATE business.work_items SET lease_until=now()+$3*interval '1 second' WHERE id=$1 AND epoch=$2 AND state='running' AND lease_until>now() RETURNING id",[work.id,work.epoch,this.config.leaseSeconds])
        .then(async r=>{if(!r.rowCount)controller.abort(new AppError(409,'lease_lost'));else await transaction(this.pool,db=>this.fence(db,job,work));}).catch(error=>controller.abort(documentProcessingError(error))).finally(()=>{renewing=false;});
    },10000);
    try{
      if(work.attempts>work.max_attempts)throw new ServiceError('work_attempts_exhausted');
      const doc=await transaction(this.pool,async db=>{const d=await this.fence(db,job,work);await db.query("UPDATE business.document_jobs SET state='running',updated_at=now() WHERE id=$1",[job.id]);await this.parseState(db,job,'running');return d;});
      if(job.kind==='review_signatures'){await this.signatures.process(job,controller.signal,async db=>{await this.fence(db,job,work);},(db,state,result)=>this.finish(db,job,work,state,result),async db=>{await db.query("UPDATE business.work_items SET state='pending',attempts=0,lease_until=NULL,available_at=now(),updated_at=now() WHERE id=$1 AND epoch=$2",[work.id,work.epoch]);});return;}
      if(job.kind==='translate_document'){await this.translations.process(job,controller.signal,async db=>{await this.fence(db,job,work);},(db,state,result)=>this.finish(db,job,work,state,result),async db=>{await db.query("UPDATE business.work_items SET state='pending',attempts=0,lease_until=NULL,available_at=now(),updated_at=now() WHERE id=$1 AND epoch=$2",[work.id,work.epoch]);});return;}
      if(job.kind!=='parse_document'){await this.processDerived(job,work,controller.signal);return;}
      const pinnedConfig=await transaction(this.pool,db=>this.pinnedConfiguration(db,job.configuration_release_id));
      const engineConfig=job.input.materialClassification===UPLOAD_CLASSIFICATION_VERSION?{...pinnedConfig,classificationMode:'content-first-v1' as const}:pinnedConfig;
      const bytes=await this.store.read(doc.object_key,doc.oss_version_id,this.upload.maxBytes);
      if(digest(bytes)!==doc.sha256)throw new ServiceError('original_integrity_failed');
      if(doc.page_count>this.config.maxPages)throw new ServiceError('document_page_limit');
      const scope:DocumentScope={caseId:job.case_id,caseRevision:job.expected_revision,configurationReleaseId:job.configuration_release_id,documentVersionId:doc.id,parseRevision:job.id,sourceSha256:doc.sha256};
      if(doc.source_format==='jpg'||doc.source_format==='png')scope.sourceFormat=doc.source_format;
      const docx=doc.source_format==='docx'?await this.prepareDocx(job,work,bytes,controller.signal):undefined;
      const pageBytes=docx?.bytes??bytes,pageCount:number=docx?docx.preview.page_count??0:doc.page_count;
      if(pageCount>this.config.maxPages)throw new ServiceError('document_page_limit');
      if(docx){scope.sourceFormat='docx';if(docx.bytes){scope.previewRevision=docx.preview.id;scope.previewSha256=docx.preview.pdf_sha256;}}
      const existing=(await this.pool.query('SELECT page_number FROM business.document_pages WHERE job_id=$1',[job.id])).rows.map(r=>r.page_number as number);
      const pageNumber=Array.from({length:pageCount},(_,i)=>i+1).find(n=>!existing.includes(n));
      if(pageNumber!==undefined){
        // Recheck after fetching bytes, immediately before any model invocation.
        await transaction(this.pool,db=>this.fence(db,job,work));
        const authorizeCall=()=>transaction(this.pool,db=>this.fence(db,job,work));
        const ocr=this.ocr?{parse:async(image:Uint8Array,options:{returnWordBox:true;signal?:AbortSignal})=>{await authorizeCall();return this.ocr!.parse(image,options);}}:undefined;
        const ner=this.ner?{
          classify:async(text:string,labels:string[],options?:{signal?:AbortSignal})=>{await authorizeCall();return this.ner!.classify(text,labels,options);},
          entities:async(text:string,labels:string[],options?:{wordSplitter?:'whitespace'|'char';signal?:AbortSignal})=>{await authorizeCall();return this.ner!.entities(text,labels,options);},
        }:undefined;
        // Native extraction and deferred local reading skip derivative OCR/NER.
        // Other legacy Word configurations retain their existing page clues.
        const nativeDocx=Boolean(docx&&(job.input.docxExtractionDeferred||(await transaction(this.pool,db=>this.reviewManifest(db,job.configuration_release_id)))?.docxExtraction?.version===DOCUMENT_DOCX_VERSION));
        const processed=await processPageIsolated(pageBytes,pageNumber,{scope,config:engineConfig,ocr:nativeDocx?undefined:ocr,ner:nativeDocx?undefined:ner,signal:controller.signal});
        controller.signal.throwIfAborted();
        const {png,...artifact}=processed;
        let body=DocumentPageArtifactSchema.parse(artifact);
        if(job.input.regionOcrVersion===REGION_OCR_VERSION){
          const ledger=new DocumentRegionOcrLedger(this.pool,{id:job.id,document_version_id:job.document_version_id,total_pages:pageCount},
            async db=>{await this.fence(db,job,work);});
          body=await augmentDocumentRegions({page:body,png,signal:controller.signal,
            execute:(request,image,signal)=>ledger.execute(body.page,request,image,this.config.regionOcr?ocr:undefined,signal)});
        }
        const json=Buffer.from(JSON.stringify(body));
        if(png.length>this.config.maxPageBytes||json.length>this.config.maxPageBytes)throw new ServiceError('derived_object_too_large');
        if(docx)await this.checkDocxArtifacts(job.id,png.length+json.length);
        const base=`${this.upload.prefix}derived/${job.id}/p${pageNumber}/e${work.epoch}-${randomUUID()}`;
        const image=await this.put(`${base}.png`,png,'image/png'),stored=await this.put(`${base}.json`,json,'application/json');
        await transaction(this.pool,async db=>{
          await this.fence(db,job,work);
          await db.query(`INSERT INTO business.document_pages(job_id,page_number,page_asset_id,body,image_key,image_version_id,image_sha256,json_key,json_version_id,json_sha256,stored_bytes)
            VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) ON CONFLICT(job_id,page_number) DO NOTHING`,[job.id,pageNumber,body.page.page_asset_id,JSON.stringify(body),`${base}.png`,image.versionId,digest(png),`${base}.json`,stored.versionId,digest(json),png.length+json.length]);
          await db.query('UPDATE business.document_jobs SET completed_pages=(SELECT count(*) FROM business.document_pages WHERE job_id=$1),updated_at=now() WHERE id=$1',[job.id]);
        });
      }
      const count=Number((await this.pool.query('SELECT count(*) AS count FROM business.document_pages WHERE job_id=$1',[job.id])).rows[0].count);
      if(count<pageCount){
        await transaction(this.pool,async db=>{await this.fence(db,job,work);await db.query("UPDATE business.work_items SET state='pending',attempts=0,lease_until=NULL,available_at=now(),updated_at=now() WHERE id=$1 AND epoch=$2",[work.id,work.epoch]);});return;
      }
      const pages=pageCount?await this.aggregatePages(this.pool,job.id):[];
      let bundle=pageCount?deriveDocument(pages,{scope,config:engineConfig,pageCount,directoryRevision:'1'}):undefined;
      const sourceEvidence=docx?addSourceEvidence(docx.source,scope,engineConfig,docx.preview.coverage_gaps,pages,bundle):undefined;
      if(sourceEvidence)bundle=sourceEvidence.bundle;
      if(!bundle)throw new ServiceError('document_no_source');
      let classificationCheckpoint=false;
      const onClassified=async(directory:DocumentBundle['logicalDocuments'])=>{
        let classified=docx?applyDocxClassification(bundle!,directory):deriveClassifiedDocument(pages,{scope,config:engineConfig,pageCount,directoryRevision:'1'},directory);
        classified={...classified,classificationMode:'content-first-v1'};
        const existing=await transaction(this.pool,async db=>{await this.fence(db,job,work);return (await db.query('SELECT body FROM business.document_artifacts WHERE job_id=$1 AND directory_revision=1',[job.id])).rows[0];});
        if(existing){if(configHash(existing.body.logicalDocuments)!==configHash(classified.logicalDocuments))throw new AppError(409,'document_cloud_classification_conflict');classificationCheckpoint=true;return DocumentBundleSchema.parse(existing.body);}
        const bytes=Buffer.from(JSON.stringify(classified)),objectKey=`${this.upload.prefix}derived/${job.id}/classification-${randomUUID()}.json`;
        const object=await this.put(objectKey,bytes,'application/json',MAX_BUNDLE_BYTES);
        await transaction(this.pool,async db=>{
          await this.fence(db,job,work);
          await db.query('INSERT INTO business.document_artifacts(id,job_id,directory_revision,body,object_key,oss_version_id,sha256,created_by) VALUES($1,$2,1,$3,$4,$5,$6,$7) ON CONFLICT DO NOTHING',[randomUUID(),job.id,JSON.stringify(classified),objectKey,object.versionId,digest(bytes),job.person_id]);
          await persistDocumentIndex(db,classified,1);
        });
        classificationCheckpoint=true;return classified;
      };
      if(docx&&job.input.docxExtractionDeferred){
        bundle={...bundle,status:'partial',coverageGaps:[...new Set([...bundle.coverageGaps,String(job.input.docxExtractionDeferred)])],
          fields:bundle.fields.map(field=>({...field,status:'uncertain',rawValue:null,normalizedValue:null,candidates:[],anchorIds:[],pageNumbers:[]}))};
      }
      const cloud=docx&&(job.input?.personalDocxSourceOnly||job.input?.docxExtractionDeferred)?undefined:await this.cloudFields(bundle,pages,job,work,controller.signal,docx?.source,onClassified);
      const finalDirectoryRevision=classificationCheckpoint?2:1;
      if(cloud){
        bundle=docx?applyDocxClassification(bundle,cloud.logicalDocuments):deriveClassifiedDocument(pages,{scope,config:engineConfig,pageCount,directoryRevision:String(finalDirectoryRevision)},cloud.logicalDocuments);
        if(classificationCheckpoint)bundle={...bundle,classificationMode:'content-first-v1',directoryRevision:String(finalDirectoryRevision),indexManifest:{...bundle.indexManifest,directoryRevision:String(finalDirectoryRevision)}};
        if('sourceAnchors' in cloud)bundle.sourceAnchors=cloud.sourceAnchors;
        bundle={...bundle,anchors:[...new Map([...bundle.anchors,...cloud.anchors].map(anchor=>[anchor.anchor_id,anchor])).values()]};
      }
      // OCR observations remain immutable; validated model fields are a separate projection.
      let filteredFields=this.fieldFilter&&!job.input.docxExtractionDeferred?await this.filterFields(bundle,pages,job,work,controller.signal):undefined;
      if(cloud)filteredFields=(filteredFields??bundle.fields).map(field=>cloud.fields.find(item=>item.fieldId===field.fieldId)??field);
      if(classificationCheckpoint&&!bundle.classificationMode)throw new AppError(409,'document_cloud_classification_conflict');
      const finalBundle=bundle,body=Buffer.from(JSON.stringify(bundle)),key=`${this.upload.prefix}derived/${job.id}/bundle-${randomUUID()}.json`;
      if(docx)await this.checkDocxArtifacts(job.id,body.length);
      const stored=await this.put(key,body,'application/json',MAX_BUNDLE_BYTES);
      await transaction(this.pool,async db=>{
        await this.fence(db,job,work);
        if(classificationCheckpoint){const latest=(await db.query('SELECT max(directory_revision) AS revision FROM business.document_artifacts WHERE job_id=$1',[job.id])).rows[0];if(Number(latest.revision)!==1)throw new AppError(409,'stale_directory_revision');}
        await db.query('INSERT INTO business.document_artifacts(id,job_id,directory_revision,body,object_key,oss_version_id,sha256,created_by) VALUES($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT DO NOTHING',[randomUUID(),job.id,finalDirectoryRevision,JSON.stringify(finalBundle),key,stored.versionId,digest(body),job.person_id]);
        if(sourceEvidence)await db.query('INSERT INTO business.document_source_mappings(job_id,preview_id,body) VALUES($1,$2,$3) ON CONFLICT DO NOTHING',[job.id,docx!.preview.id,JSON.stringify(sourceEvidence.mappings)]);
        await persistDocumentIndex(db,finalBundle,finalDirectoryRevision);
        const partial=classificationCheckpoint&&!fixedMaterialType(finalBundle)||finalBundle.status!=='ready'||['failed','unknown'].includes(cloud?.receipt.completion??'')||filteredFields?.some(field=>field.semanticFilter&&field.semanticFilter.state!=='completed');
        await this.finish(db,job,work,partial?'partial':'ready',{parseRevision:job.id,indexManifestId:finalBundle.indexManifest.id,directoryRevision:finalDirectoryRevision,coverageGaps:finalBundle.coverageGaps,
          ...(filteredFields?{fieldFilter:{version:cloud?cloud.receipt.version:'qwen-role-filter-v1',directoryRevision:finalDirectoryRevision,items:filteredFields}}:{}),
          ...(cloud?{cloudExtraction:cloud.receipt}:{})});
      });
    }catch(error){if(!this.stopping)await this.fail(job,work,error);}finally{clearInterval(timer);controller.abort();this.active.delete(controller);}
  }
  private async checkDocxArtifacts(jobId:string,additionalBytes:number){
    const row=(await this.pool.query(`SELECT coalesce((SELECT sum(stored_bytes) FROM business.document_pages WHERE job_id=$1),0)
      +coalesce((SELECT octet_length(body::text) FROM business.document_sources WHERE job_id=$1),0)
      +coalesce((SELECT (manifest->>'pdfBytes')::bigint FROM business.document_previews WHERE job_id=$1),0) AS bytes`,[jobId])).rows[0];
    if(Number(row.bytes)+additionalBytes>256*1024*1024)throw new ServiceError('docx_artifact_budget_exceeded');
  }
  private async reviewManifest(db:PoolClient,configurationReleaseId:string){
    return this.review.getManifestForDocumentConfiguration(db,configurationReleaseId);
  }
  private async semanticFieldRecipes(db:PoolClient,configurationReleaseId:string){
    const manifest=await this.reviewManifest(db,configurationReleaseId);
    if(!manifest)return undefined;
    const selected=manifest.fields.filter(field=>['private_candidate_filter','cloud_grounded_extract'].includes(field.recipe.mode));
    if(selected.some(field=>!isSupportedReviewRecipe(field.recipe,manifest.scope)))throw new AppError(409,'field_filter_recipe_mismatch');
    return selected;
  }
  private async privateFieldRecipes(db:PoolClient,configurationReleaseId:string){
    return (await this.semanticFieldRecipes(db,configurationReleaseId))?.filter(field=>field.recipe.mode==='private_candidate_filter');
  }
  private async cloudFields(bundle:DocumentBundle,pages:DocumentPageArtifact[],job:Job,work:ClaimedWork,signal:AbortSignal,source?:z.infer<typeof DocxSourceDocumentSchema>,onClassified?:(directory:DocumentBundle['logicalDocuments'])=>Promise<DocumentBundle>){
    const manifest=await transaction(this.pool,db=>this.reviewManifest(db,job.configuration_release_id));
    if(!manifest?.fields.some(field=>field.recipe.mode==='cloud_grounded_extract'))return undefined;
    if(!this.config.cloudExtraction)throw new AppError(409,'document_cloud_unavailable');
    let classifiedRevision:string|undefined;
    const result=await runDocumentCloudExtraction({pool:this.pool,config:this.config.cloudExtraction,job,bundle,pages,manifest,signal,source,requireSavedClassification:job.kind==='extract_fields',uploadClassification:job.input.materialClassification===UPLOAD_CLASSIFICATION_VERSION,
      ...(onClassified?{onClassified:async(directory:DocumentBundle['logicalDocuments'])=>{const saved=await onClassified(directory);classifiedRevision=saved.directoryRevision;return saved;}}:{}),
      loadPageImage:async page=>{
        // Extraction uses its job authorization, independently of the reader UI switch.
        const row=await transaction(this.pool,async db=>{
          await this.fence(db,job,work);signal.throwIfAborted();
          if(page.scope.documentVersionId!==job.document_version_id||page.scope.parseRevision!==bundle.scope.parseRevision||page.scope.sourceSha256!==bundle.scope.sourceSha256)throw new AppError(409,'page_integrity_failed');
          return (await db.query('SELECT page_asset_id,image_key,image_version_id,image_sha256 FROM business.document_pages WHERE job_id=$1 AND page_number=$2',[bundle.scope.parseRevision,page.page.page_number])).rows[0];
        });
        if(!row||row.page_asset_id!==page.page.page_asset_id||row.image_sha256!==page.imageSha256)throw new AppError(409,'page_integrity_failed');
        const bytes=await this.store.read(row.image_key,row.image_version_id,this.config.maxPageBytes);
        signal.throwIfAborted();if(digest(bytes)!==page.imageSha256)throw new AppError(409,'page_integrity_failed');return bytes;
      },
      fence:async db=>{await this.fence(db,job,work);if(job.kind==='extract_fields')await this.filterDirectoryFence(db,job);
        if(classifiedRevision){const latest=(await db.query('SELECT max(directory_revision) AS revision FROM business.document_artifacts WHERE job_id=$1',[job.id])).rows[0];if(String(latest.revision)!==classifiedRevision)throw new AppError(409,'stale_directory_revision');}}});
    // Re-extraction cannot contradict a user's saved classification or alter its directory.
    for(const manual of bundle.logicalDocuments.filter(item=>item.source==='manual')){
      if(result.logicalDocuments.some(item=>(item.pageNumbers.some(page=>manual.pageNumbers.includes(page))||item.sourceNodeIds?.some(id=>manual.sourceNodeIds?.includes(id)))&&item.labelId!==manual.labelId))throw new AppError(409,'document_cloud_classification_conflict');
    }
    return result;
  }
  private async filterFields(bundle:DocumentBundle,pages:DocumentPageArtifact[],job:Job,work:ClaimedWork,signal:AbortSignal){
    const client=this.fieldFilter!;
    const fence=async(db:PoolClient)=>{
      await this.fence(db,job,work);
      if(job.kind==='extract_fields')await this.filterDirectoryFence(db,job);
    };
    const beforeSend=async()=>{await transaction(this.pool,fence);};
    await beforeSend();
    const definitions=await transaction(this.pool,async db=>{
      const selected=await this.privateFieldRecipes(db,job.configuration_release_id);
      if(!selected)return undefined;
      if(selected.some(field=>field.recipe.version!==FIELD_FILTER_VERSION||field.recipe.promptSha256!==FIELD_FILTER_PROMPT_SHA256||field.recipe.model!==client.model))throw new AppError(409,'field_filter_recipe_mismatch');
      return Object.fromEntries(selected.map(field=>[field.id,field.semanticDefinition]));
    });
    const chat=durableFieldFilterChat(this.pool,job.id,client.model,client.chat.bind(client),fence);
    const fields=await filterFieldsByRecipe(bundle,pages,chat,{signal,beforeSend,model:client.model,definitions});
    signal.throwIfAborted();
    return fields;
  }
  private async filterDirectoryFence(db:PoolClient,job:Job){
    const latest=(await db.query('SELECT directory_revision FROM business.document_artifacts WHERE job_id=$1 ORDER BY directory_revision DESC LIMIT 1',[job.input.parseRevision])).rows[0];
    if(latest?.directory_revision!==job.input.directoryRevision)throw new AppError(409,'stale_directory_revision');
  }
  private async processDerived(job:Job,work:ClaimedWork,signal:AbortSignal){
    if(job.kind==='extract_fields'){
      const prepared=await transaction(this.pool,async db=>{
        await this.fence(db,job,work);
        const {row,bundle}=await this.latestBundle(db,job.input.parseRevision);
        if(row.directory_revision!==job.input.directoryRevision)throw new AppError(409,'stale_directory_revision');
        const pages=await this.aggregatePages(db,job.input.parseRevision);
        if(job.input.mode!=='supplement_fields')return {bundle,pages};
        const config=await this.pinnedConfiguration(db,job.configuration_release_id),extracted=extractFieldObservations(pages,{scope:bundle.scope,config});
        let next:DocumentBundle={...bundle,fields:extracted.fields,anchors:[...new Map([...bundle.anchors,...extracted.anchors].map(anchor=>[anchor.anchor_id,anchor])).values()]};
        if(bundle.scope.sourceFormat==='docx'){
          const row=(await db.query('SELECT body FROM business.document_sources WHERE job_id=$1',[job.input.parseRevision])).rows[0];
          if(!row)throw new AppError(409,'document_source_missing');
          next=addSourceEvidence(DocxSourceDocumentSchema.parse(row.body),bundle.scope,config,bundle.coverageGaps,pages,next).bundle;
        }
        return {bundle:next,pages};
      });
      if(fixedMaterialType(prepared.bundle)===SUPPLEMENTAL_MATERIAL_ID){
        await transaction(this.pool,async db=>{await this.fence(db,job,work);await this.filterDirectoryFence(db,job);await this.finish(db,job,work,'ready',{items:[],anchors:prepared.bundle.anchors,parseRevision:job.input.parseRevision,directoryRevision:job.input.directoryRevision,coverageGaps:prepared.bundle.coverageGaps});});return;
      }
      const selected=Array.isArray(job.input.fieldIds)?new Set<string>(job.input.fieldIds):null;
      const selectedBundle=selected?{...prepared.bundle,fields:prepared.bundle.fields.filter(field=>selected.has(field.fieldId))}:prepared.bundle;
      const nativeSource=prepared.bundle.scope.sourceFormat==='docx'?DocxSourceDocumentSchema.parse((await this.pool.query('SELECT body FROM business.document_sources WHERE job_id=$1',[job.input.parseRevision])).rows[0]?.body):undefined;
      const cloud=await this.cloudFields(prepared.bundle,prepared.pages,job,work,signal,nativeSource);
      let extracted=this.fieldFilter?await this.filterFields(selectedBundle,prepared.pages,job,work,signal):selectedBundle.fields;
      if(cloud)extracted=extracted.map(field=>cloud.fields.find(item=>item.fieldId===field.fieldId)??field);
      let fields=extracted;
      if(selected){
        const prior=(await this.pool.query(`SELECT result->'items' AS items FROM business.document_jobs WHERE id<>$1 AND document_version_id=$2 AND configuration_release_id=$3 AND kind='extract_fields' AND validity='current' AND state IN ('ready','partial') AND input->>'parseRevision'=$4 AND input->>'directoryRevision'=$5 ORDER BY created_at DESC,id DESC LIMIT 1`,[job.id,job.document_version_id,job.configuration_release_id,job.input.parseRevision,String(job.input.directoryRevision)])).rows[0];
        const previous=prior?.items?z.array(DocumentFieldObservationSchema).parse(prior.items):[];
        const recipes=await transaction(this.pool,db=>this.semanticFieldRecipes(db,job.configuration_release_id));
        fields=projectFieldCandidates(prepared.bundle.fields.map(field=>extracted.find(item=>item.fieldId===field.fieldId)??previous.find(item=>item.fieldId===field.fieldId)??field),prepared.bundle.fields,recipes?.map(field=>field.id),Boolean(this.fieldFilter||this.config.cloudExtraction));
      }
      await transaction(this.pool,async db=>{
        await this.fence(db,job,work);
        await this.filterDirectoryFence(db,job);
        const partial=prepared.bundle.status!=='ready'||['failed','unknown'].includes(cloud?.receipt.completion??'')||fields.some(field=>field.semanticFilter&&field.semanticFilter.state!=='completed'||field.status==='uncertain');
        await this.finish(db,job,work,partial?'partial':'ready',{items:fields,anchors:[...new Map([...prepared.bundle.anchors,...(cloud?.anchors??[])].map(anchor=>[anchor.anchor_id,anchor])).values()],sourceAnchors:cloud&&'sourceAnchors'in cloud?cloud.sourceAnchors:prepared.bundle.sourceAnchors??[],parseRevision:job.input.parseRevision,directoryRevision:job.input.directoryRevision,coverageGaps:prepared.bundle.coverageGaps,...(cloud?{cloudExtraction:cloud.receipt}:{})});
      });
      return;
    }
    await transaction(this.pool,async db=>{
      await this.fence(db,job,work);
      if(job.kind==='extract_fields'){
        const parsed=await this.readParse(db,actorOf(job),job.case_id,job.document_version_id,job.input.parseRevision),{row,bundle}=await this.latestBundle(db,parsed.job.id);
        if(row.directory_revision!==job.input.directoryRevision)throw new AppError(409,'stale_directory_revision');
        await this.finish(db,job,work,bundle.status==='ready'?'ready':'partial',{items:bundle.fields,anchors:bundle.anchors,parseRevision:parsed.job.id,directoryRevision:row.directory_revision,coverageGaps:bundle.coverageGaps});
      }else{
        const before=await this.readParse(db,actorOf(job),job.case_id,job.input.beforeDocumentId,job.input.beforeParseRevision),after=await this.readParse(db,actorOf(job),job.case_id,job.input.afterDocumentId,job.input.afterParseRevision);
        const a=await this.latestBundle(db,before.job.id),b=await this.latestBundle(db,after.job.id);
        if(a.row.directory_revision!==job.input.beforeDirectoryRevision||b.row.directory_revision!==job.input.afterDirectoryRevision)throw new AppError(409,'stale_directory_revision');
        const result=compareDocumentVersions(a.bundle,b.bundle);await this.finish(db,job,work,result.status==='partial'?'partial':'ready',{
          ...result,beforeChunks:a.bundle.chunks,afterChunks:b.bundle.chunks,beforeAnchors:a.bundle.anchors,afterAnchors:b.bundle.anchors,
        });
      }
    });
  }
  private async finish(db:PoolClient,job:Job,work:ClaimedWork,state:'ready'|'partial',result:unknown){
    if(job.kind==='extract_fields')await this.review.invalidateDependencies(db,job.case_id,{documentVersionId:job.document_version_id,reason:'field_projection_replaced'});
    await db.query('UPDATE business.document_jobs SET state=$2,result=$3,error_code=NULL,updated_at=now() WHERE id=$1',[job.id,state,JSON.stringify(result)]);
    await this.parseState(db,job,state);
    await db.query("UPDATE business.work_items SET state='succeeded',lease_until=NULL,updated_at=now() WHERE id=$1 AND epoch=$2",[work.id,work.epoch]);
    await db.query('INSERT INTO business.inbox(work_item_id,epoch) VALUES($1,$2) ON CONFLICT(work_item_id) DO NOTHING',[work.id,work.epoch]);
    await audit(db,{actorId:job.account_id,targetId:job.id,action:'document:completed',details:{state}});
  }
  private async fail(job:Job,work:ClaimedWork,error:unknown){
    error=documentProcessingError(error);
    const code=error instanceof AppError||error instanceof ServiceError||error instanceof DocxError||error instanceof ModelExecutionError?error.code:safeDocumentEngineErrorCode(error)??'document_processing_failed';
    await transaction(this.pool,async db=>{
      await db.query('SELECT id FROM business.cases WHERE id=$1 FOR UPDATE',[job.case_id]);
      await db.query('SELECT id FROM business.document_versions WHERE id=$1 FOR UPDATE',[job.document_version_id]);
      // Capacity contention is not an execution failure. Keep previous genuine
      // failures, but refund this claim while the original queue deadline holds.
      const capacityWait=error instanceof ServiceError&&['qwen_busy','ocr_busy'].includes(error.code)&&error.retryable&&Boolean((await db.query(
        "SELECT created_at>statement_timestamp()-interval '30 minutes' AS allowed FROM business.document_jobs WHERE id=$1",[job.id])).rows[0]?.allowed);
      const rateWait=error instanceof ModelExecutionError&&error.code==='rate_limited'&&error.retryable;
      // The privacy check itself could not run because its service was busy or unreachable. Nothing left the system,
      // so the file is tried again within its attempts instead of being failed for good.
      const privacyWait=error instanceof ModelExecutionError&&error.code==='egress_denied'&&error.diagnostic==='privacy_ner_unavailable';
      const retry=capacityWait||(error instanceof ServiceError&&error.retryable||rateWait||privacyWait)&&work.attempts<work.max_attempts;
      const delay=capacityWait?Math.max(1000,Math.min(30_000,error instanceof ServiceError?error.retryAfterMs??2000:2000)):rateWait?60_000:privacyWait?20_000:5000;
      const r=await db.query("UPDATE business.work_items SET state=$3,error_code=$4,attempts=GREATEST(attempts-$5,0),lease_until=NULL,available_at=now()+$6*interval '1 millisecond',updated_at=now() WHERE id=$1 AND epoch=$2 AND state='running' AND lease_until>now() RETURNING id",[work.id,work.epoch,retry?'pending':'rejected',code,capacityWait?1:0,delay]);
      if(!r.rowCount)return;
      const state=retry?'pending':code.startsWith('stale_')?'stale':'failed';
      await db.query("UPDATE business.document_jobs SET state=$2,validity=CASE WHEN $2='stale' THEN 'stale' ELSE validity END,error_code=$3,updated_at=now() WHERE id=$1",[job.id,state,code]);
      await this.parseState(db,job,state);
      const diagnostic=ModelDiagnosticSchema.safeParse(error instanceof ModelExecutionError?error.diagnostic:undefined);
      await audit(db,{actorId:job.account_id,targetId:job.id,action:'document:processing_failed',result:state,
        details:{code,...(diagnostic.success?{diagnostic:diagnostic.data}:{}),retry}});
    });
  }
}
