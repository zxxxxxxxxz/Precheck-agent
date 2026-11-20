import type { Pool, PoolClient } from 'pg';
import { z } from 'zod';
import { DocumentBundleSchema, DocumentPageArtifactSchema, DocumentFieldObservationSchema, type DocumentBundle } from '@hsbc/contracts/documents';
import { FullTextTranslationCommandSchema, FieldTranslationTargetsQuerySchema, type FieldTranslationSource, DocumentTranslationHistoryQuerySchema, DocumentTranslationCommandSchema, DocumentTranslationAcceptedSchema, DocumentTranslationTargetsSchema, DocumentTranslationViewSchema, DocumentTranslationListSchema, DocumentTranslatedSegmentSchema, TRANSLATION_LIMITS, type DocumentTranslationView } from '@hsbc/contracts/document-translation';
import { transaction } from '../../../infrastructure/database/client.js';
import { idempotent } from '../../../infrastructure/database/idempotency.js';
import { ServiceError } from '../../../infrastructure/integrations/http.js';
import { AppError } from '../../../shared/errors.js';
import type { Actor } from '../../identity/types.js';
import { authorizeCase, isEligibleMaker } from '../../cases/authorization.js';
import type { DocumentRuntimeConfig } from '../config.js';
import { TRANSLATION_GLOSSARY_VERSION, fieldTranslationPromptVersion, translateSegment, type TranslationChat } from './model.js';
import { sourceFingerprint, translationHash, translationSource, translationTargets, type TranslationSegmentSource } from './source.js';
import { translationDispatch } from './ledger.js';
import {DocxSourceDocumentSchema} from '@hsbc/contracts/docx';
import {sha256} from '../../../document/evidence.js';
import {fieldTranslationBundle} from './field-source.js';

export interface TranslationJob {
  id: string; case_id: string; document_version_id: string; expected_revision: number; account_id: string;
  person_id: string; auth_version: number; state: string; validity: string; input: Record<string, any>;
  error_code: string | null; created_at: Date;
}
interface TranslationSnapshot {
  fieldSources?: FieldTranslationSource[];
  scope?: 'full_text';
  referenceRoundId?:string; frozenSnapshotHash?:string;
  caseRevision: number; reviewReleaseId: string | null; parseRevision: string; directoryRevision: number;
  sourceSha256: string; sourceFingerprint: string; model: string; modelRevision: string;
  promptVersion: string; glossaryVersion: string; targetLanguage: 'zh-CN'; segments: TranslationSegmentSource[];
}
const querySchema = z.strictObject({ referenceRoundId:z.uuid().optional(), parseRevision: z.uuid().optional(), offset: z.coerce.number().int().min(0).max(100000).default(0),
  limit: z.coerce.number().int().min(1).max(100).default(50), fullSource:z.enum(['true','false']).transform(value=>value==='true').optional() });

export class DocumentTranslationService {
  constructor(private pool: Pool, private config: DocumentRuntimeConfig, private client?: TranslationChat) {}
  private enabled() { if (!this.config.translation || !this.config.reader) throw new AppError(409, 'document_translation_unavailable'); }
  private async context(db: PoolClient, actor: Actor, caseId: string, documentId: string, parseRevision?: string, write = false, referenceRoundId?:string, fieldSources?:FieldTranslationSource[]) {
    if (!this.config.reader) throw new AppError(409, 'capability_disabled');
    const c = await authorizeCase(db, actor, caseId, write ? referenceRoundId ? 'document:translate' : 'document:parse' : 'evidence:read', write);
    if (write) await authorizeCase(db, actor, caseId, 'evidence:read', false);
    const doc = (await db.query(`SELECT d.* FROM business.document_versions d JOIN business.upload_sessions u ON u.id=d.upload_session_id
      WHERE d.case_id=$1 AND d.id=$2 AND u.state='registered' AND u.document_version_id=d.id ${write ? 'FOR UPDATE OF d' : ''}`, [caseId, documentId])).rows[0];
    if (!doc) throw new AppError(404, 'material_not_found');
    let pin:any, frozenFacts:any[]|undefined, frozenSnapshotHash:string|undefined;
    if(referenceRoundId){
      if(doc.round_id!==referenceRoundId)throw new AppError(409,'translation_round_mismatch');
      const frozen=(await db.query(`SELECT r.configuration_release_id,r.state,v.snapshot,v.snapshot_hash FROM business.review_rounds r
        JOIN business.review_runs v ON v.id=r.run_id AND v.case_id=r.case_id WHERE r.id=$1 AND r.case_id=$2`,[referenceRoundId,caseId])).rows[0];
      if(!frozen||!['submitted','locked'].includes(frozen.state)||translationHash(frozen.snapshot)!==frozen.snapshot_hash)throw new AppError(409,'translation_round_not_frozen');
      pin=frozen.snapshot.materials.find((m:any)=>m.operation==='adopt'&&m.documentVersionId===documentId&&m.parseRevision===parseRevision);
      if(!pin||!pin.artifactHash||pin.sourceSha256!==doc.sha256)throw new AppError(409,'translation_frozen_source_mismatch');
      if(write&&(c.maker_person_id!==actor.personId||!await isEligibleMaker(db,actor.personId,caseId)))throw new AppError(403,'maker_assignment_required');
      frozenFacts=frozen.snapshot.facts;c.configuration_release_id=frozen.configuration_release_id;frozenSnapshotHash=frozen.snapshot_hash;
    }
    const parse = (await db.query("SELECT * FROM business.document_jobs WHERE id=$1 AND case_id=$2 AND document_version_id=$3 AND kind='parse_document'", [parseRevision ?? doc.current_parse_job_id, caseId, documentId])).rows[0];
    if (!parse) throw new AppError(409, 'parse_not_available');
    let { bundle, directoryRevision } = await this.bundle(db, parse.id, pin?.directoryRevision);
    if(pin){const row=(await db.query('SELECT sha256 FROM business.document_artifacts WHERE job_id=$1 AND directory_revision=$2',[parse.id,pin.directoryRevision])).rows[0];if(row?.sha256!==pin.artifactHash)throw new AppError(409,'translation_frozen_source_mismatch');}
    if (bundle.scope.caseId !== caseId || bundle.scope.documentVersionId !== documentId || bundle.scope.parseRevision !== parse.id ||
        bundle.scope.sourceSha256 !== doc.sha256 || bundle.directoryRevision !== String(directoryRevision)) throw new AppError(409, 'translation_source_integrity_failed');
    let fieldSelection: ReturnType<typeof fieldTranslationBundle>['selected'] = [];
    if (fieldSources?.length) {
      const projection = pin && (!pin.projectionJobId || pin.projectionJobId === parse.id) ? undefined : (await db.query(`SELECT result FROM business.document_jobs WHERE document_version_id=$1
        AND kind='extract_fields' AND (($4::uuid IS NULL AND validity='current' AND state IN ('ready','partial')) OR id=$4)
        AND input->>'parseRevision'=$2 AND input->>'directoryRevision'=$3 ORDER BY created_at DESC,id DESC LIMIT 1`,
        [documentId, parse.id, String(directoryRevision), pin?.projectionJobId ?? null])).rows[0]?.result;
      if (pin?.projectionHash) {
        const items = projection?.items ?? (parse.result?.fieldFilter?.directoryRevision === directoryRevision ? parse.result.fieldFilter.items : []);
        if (translationHash({items, anchors:projection?.anchors ?? [], sourceAnchors:projection?.sourceAnchors ?? []}) !== pin.projectionHash) throw new AppError(409,'translation_frozen_source_mismatch');
      }
      bundle = DocumentBundleSchema.parse({...bundle,
        anchors:[...new Map([...bundle.anchors,...(projection?.anchors??[])].map(a=>[a.anchor_id,a])).values()],
        sourceAnchors:[...new Map([...(bundle.sourceAnchors??[]),...(projection?.sourceAnchors??[])].map(a=>[a.anchor_id,a])).values()]});
      const pageNumbers = [...new Set(fieldSources.flatMap(source => bundle.anchors.filter(a=>a.anchor_id===source.anchorId).map(a=>a.page_number)))];
      const rows = pageNumbers.length ? (await db.query(`SELECT body FROM business.document_pages WHERE job_id=$1 AND page_number=ANY($2::integer[]) AND octet_length(body::text)<=67108864`,[parse.id,pageNumbers])).rows : [];
      let native;
      if (fieldSources.some(source=>source.sourceNodeId)) {
        const row=(await db.query('SELECT body,sha256 FROM business.document_sources WHERE job_id=$1 AND octet_length(body::text)<=67108864',[parse.id])).rows[0];
        if (!row) throw new AppError(409,'translation_source_integrity_failed');
        native=DocxSourceDocumentSchema.parse(row.body);
        if (sha256(JSON.stringify(native))!==row.sha256) throw new AppError(409,'translation_source_integrity_failed');
      }
      const scoped = fieldTranslationBundle(bundle, fieldSources, rows.map(r=>DocumentPageArtifactSchema.parse(r.body)), native);
      bundle = scoped.bundle; fieldSelection = scoped.selected;
    }
    return { c, doc, parse, bundle, directoryRevision, frozenSnapshotHash, frozenFacts, pin, fieldSelection };
  }
  private async bundle(db: PoolClient, parseId: string, directory?:number) {
    const row = (await db.query(`SELECT directory_revision,octet_length(body::text) AS bytes,
      CASE WHEN octet_length(body::text)<=67108864 THEN body ELSE NULL END AS body
      FROM business.document_artifacts WHERE job_id=$1 AND ($2::integer IS NULL OR directory_revision=$2) ORDER BY directory_revision DESC LIMIT 1`, [parseId,directory??null])).rows[0];
    if (!row) throw new AppError(409, 'index_not_ready');
    if (!row.body) throw new AppError(422, 'document_aggregate_budget_exceeded');
    return { bundle: DocumentBundleSchema.parse(row.body), directoryRevision: Number(row.directory_revision) };
  }
  async fieldTargets(actor:Actor, caseId:string, documentId:string, raw:unknown) {
    const query=FieldTranslationTargetsQuerySchema.parse(raw);
    return transaction(this.pool,async db=>{
      const context=await this.context(db,actor,caseId,documentId,query.parseRevision,false,query.referenceRoundId,query.fieldSources);
      const {c,doc,parse,bundle,directoryRevision,fieldSelection}=context;
      if(directoryRevision!==query.expectedDirectoryRevision)throw new AppError(409,'stale_directory_revision');
      const targets=translationTargets(bundle,[],{offset:bundle.chunks.length-fieldSelection.length,limit:fieldSelection.length}).map(target=>
        ({...target,recommended:true,fieldSource:fieldSelection.find(item=>item.chunk.id===target.chunkId)!.selection}));
      let canCreate=false;
      if(this.config.translation&&(!this.config.requireReviewConfiguration||c.configuration_release_id)&&doc.current_parse_job_id===parse.id&&['ready','partial'].includes(parse.state)) {
        try {await this.context(db,actor,caseId,documentId,parse.id,true,query.referenceRoundId);canCreate=true;}catch(error){if(!(error instanceof AppError))throw error;}
      }
      return DocumentTranslationTargetsSchema.parse({schemaVersion:'document-translation.v1',caseRevision:c.revision,parseRevision:parse.id,directoryRevision,
        enabled:Boolean(this.config.translation),canCreate,limits:TRANSLATION_LIMITS,items:targets,total:targets.length,nextOffset:null});
    });
  }
  async targets(actor: Actor, caseId: string, documentId: string, raw: unknown) {
    const query = querySchema.parse(raw);
    return transaction(this.pool, async db => {
      const { c, doc, parse, bundle, directoryRevision, frozenFacts, pin } = await this.context(db, actor, caseId, documentId, query.parseRevision, false, query.referenceRoundId);
      const latest = pin&&(pin.projectionJobId===parse.id||!pin.projectionJobId)?null:(await db.query(`SELECT id,result,result->'items' AS items FROM business.document_jobs WHERE document_version_id=$1
        AND kind='extract_fields' AND (($4::uuid IS NULL AND validity='current' AND state IN ('ready','partial')) OR id=$4) AND input->>'parseRevision'=$2
        AND input->>'directoryRevision'=$3 ORDER BY created_at DESC,id DESC LIMIT 1`, [documentId, parse.id, String(directoryRevision),pin?.projectionJobId??null])).rows[0];
      const initial = parse.result?.fieldFilter?.directoryRevision === directoryRevision ? parse.result.fieldFilter.items : undefined;
      if(pin?.projectionHash){const items=latest?.items??initial??[];
        if(translationHash({items,anchors:latest?.result?.anchors??[],sourceAnchors:latest?.result?.sourceAnchors??[]})!==pin.projectionHash)throw new AppError(409,'translation_frozen_source_mismatch');}
      const fields = pin&&!pin.projectionJobId?bundle.fields:latest?.items ?? initial ?? bundle.fields;
      const facts=frozenFacts??(await db.query(`SELECT DISTINCT ON(fact_id) body,validity FROM business.review_fact_versions WHERE case_id=$1 AND round_id IS NOT DISTINCT FROM $2::uuid ORDER BY fact_id,version DESC`,[caseId,doc.round_id??null])).rows.map(r=>({...r.body,validity:r.validity}));
      const confirmedEvidence=facts.filter(f=>f.validity==='current').map(f=>({fieldId:f.fieldId,anchorIds:(f.evidence??[]).filter((e:any)=>e.documentVersionId===documentId&&e.parseRevision===parse.id&&e.directoryRevision===directoryRevision).flatMap((e:any)=>e.anchorId?[e.anchorId]:(bundle.sourceAnchors??[]).filter(a=>a.sourceNodeId===e.sourceNodeId).map(a=>a.anchor_id))}));
      const targets = translationTargets(bundle, z.array(DocumentFieldObservationSchema).parse(fields), query,confirmedEvidence,{anchors:latest?.result?.anchors??[],sourceAnchors:latest?.result?.sourceAnchors??[]});
      let canCreate = false;
      if (this.config.translation && (!this.config.requireReviewConfiguration || c.configuration_release_id) && doc.current_parse_job_id === parse.id && ['ready', 'partial'].includes(parse.state)) {
        try { await this.context(db,actor,caseId,documentId,parse.id,true,query.referenceRoundId); canCreate = true; } catch (error) { if (!(error instanceof AppError)) throw error; }
      }
      return DocumentTranslationTargetsSchema.parse({ schemaVersion: 'document-translation.v1', caseRevision: c.revision, parseRevision: parse.id, directoryRevision,
        enabled: Boolean(this.config.translation), canCreate, limits: TRANSLATION_LIMITS,
        items: targets, total: bundle.chunks.length,
        nextOffset: query.offset + query.limit < bundle.chunks.length ? query.offset + query.limit : null });
    });
  }
  async create(actor: Actor, caseId: string, documentId: string, raw: unknown,
    accept: (db: PoolClient, c: any, doc: any, input: Record<string, unknown>) => Promise<{ jobId: string; status: string }>, fullText = false) {
    this.enabled(); const input = fullText ? FullTextTranslationCommandSchema.parse(raw) : DocumentTranslationCommandSchema.parse(raw);
    const fieldSources = fullText ? undefined : DocumentTranslationCommandSchema.parse(input).fieldSources;
    return transaction(this.pool, async db => {
      const { c, doc, parse, bundle, directoryRevision, frozenSnapshotHash, fieldSelection } = await this.context(db, actor, caseId, documentId, input.parseRevision, true,input.referenceRoundId,fieldSources);
      if (c.revision !== input.expectedRevision) throw new AppError(409, 'stale_revision');
      if (doc.current_parse_job_id !== parse.id) throw new AppError(409, 'stale_parse_revision');
      if (directoryRevision !== input.expectedDirectoryRevision) throw new AppError(409, 'stale_directory_revision');
      if (!['ready', 'partial'].includes(parse.state)) throw new AppError(409, 'parse_not_ready');
      return idempotent(db, actor, `document.translation${fullText ? '.full-text' : ''}:${documentId}`, input.idempotencyKey, input, async () => {
        // Canonical source order makes clicking the same set in another order reusable.
        const allowedChunks = fieldSources ? fieldSelection.map(item => item.chunk) : bundle.chunks;
        const requested = fullText ? undefined : DocumentTranslationCommandSchema.parse(input).chunkIds;
        const chunkIds = allowedChunks.filter(chunk => !requested || requested.includes(chunk.id)).map(chunk => chunk.id);
        if (requested && chunkIds.length !== requested.length) throw new AppError(422, 'translation_chunk_not_found');
        const segments = chunkIds.flatMap(id => { const result = translationSource(bundle, id);
          if (result.reasonCodes.length) { if (fullText) return []; throw new AppError(422, result.reasonCodes[0]!); } return [result.segment]; });
        if (!segments.length) throw new AppError(422, 'translation_no_available_source');
        const model = this.config.translation!;
        const snapshot: TranslationSnapshot = { ...(fullText ? {scope: 'full_text'} : {}), ...(fieldSources ? {fieldSources: fieldSelection.filter(item => chunkIds.includes(item.chunk.id)).map(item => item.selection)} : {}), ...(input.referenceRoundId?{referenceRoundId:input.referenceRoundId,frozenSnapshotHash}:{}), caseRevision: c.revision, reviewReleaseId: c.configuration_release_id ?? null,
          parseRevision: parse.id, directoryRevision, sourceSha256: doc.sha256, sourceFingerprint: sourceFingerprint(bundle, segments.map(segment => segment.chunkId)),
          model: model.model, modelRevision: model.modelRevision, promptVersion: fieldTranslationPromptVersion(Boolean(fieldSources)),
          glossaryVersion: TRANSLATION_GLOSSARY_VERSION, targetLanguage: 'zh-CN', segments };
        if (Buffer.byteLength(JSON.stringify(snapshot)) > 64 * 1024 * 1024) throw new AppError(422, 'translation_full_text_budget_exceeded');
        const hash = translationHash(snapshot);
        const previous = (await db.query(`SELECT j.* FROM business.document_translation_snapshots s JOIN business.document_jobs j ON j.id=s.job_id
          WHERE j.case_id=$1 AND j.document_version_id=$2 AND s.input_hash=$3 AND j.validity='current' ORDER BY j.created_at DESC,j.id DESC`, [caseId, documentId, hash])).rows as TranslationJob[];
        const activeFullText = fullText && previous.find(j => ['pending', 'running'].includes(j.state) && j.account_id === actor.accountId && j.auth_version === actor.authVersion);
        if (activeFullText) return DocumentTranslationAcceptedSchema.parse({jobId: activeFullText.id, status: activeFullText.state, reused: true});
        const reusable = previous.find(j => j.state === 'ready') ?? previous.find(j => j.account_id === actor.accountId && j.auth_version === actor.authVersion);
        if (reusable && !input.retryOf) return DocumentTranslationAcceptedSchema.parse({ jobId: reusable.id, status: reusable.state, reused: true });
        if (input.retryOf) {
          const old = previous.find(j => j.id === input.retryOf && j.account_id === actor.accountId && j.auth_version === actor.authVersion);
          if (!old || !['failed', 'canceled', 'partial'].includes(old.state)) throw new AppError(409, 'translation_retry_not_allowed');
          if (previous.length >= 3) throw new AppError(409, 'translation_retry_budget_exceeded');
        }
        if (previous.some(job => job.error_code === 'translation_call_unknown') || previous.length && (await db.query("SELECT 1 FROM business.document_translation_calls WHERE job_id=ANY($1::uuid[]) AND state='unknown' LIMIT 1", [previous.map(j => j.id)])).rowCount)
          throw new AppError(409, 'translation_call_unknown');
        const active = Number((await db.query("SELECT count(*) AS n FROM business.document_jobs WHERE case_id=$1 AND kind='translate_document' AND state IN ('pending','running') AND validity='current'", [caseId])).rows[0].n);
        if (active >= 4) throw new AppError(429, 'translation_queue_full');
        const accepted = await accept(db, c, doc, { ...(fullText ? {scope: 'full_text'} : {}), parseRevision: parse.id, directoryRevision, inputSha256: hash, reason: input.reason,...(input.referenceRoundId?{referenceRoundId:input.referenceRoundId}: {}) });
        await db.query('INSERT INTO business.document_translation_snapshots(job_id,input_hash,body) VALUES($1,$2,$3)', [accepted.jobId, hash, JSON.stringify(snapshot)]);
        return DocumentTranslationAcceptedSchema.parse({ jobId: accepted.jobId, status: accepted.status, reused: false });
      });
    });
  }
  private async snapshot(db: PoolClient, job: TranslationJob): Promise<TranslationSnapshot> {
    const row = (await db.query('SELECT input_hash,body FROM business.document_translation_snapshots WHERE job_id=$1', [job.id])).rows[0];
    if (!row || translationHash(row.body) !== row.input_hash || row.input_hash !== job.input.inputSha256)
      throw new AppError(409, 'translation_snapshot_integrity_failed');
    return row.body as TranslationSnapshot;
  }
  private current(snapshot: TranslationSnapshot, context: { c: any; doc: any; bundle: DocumentBundle; directoryRevision: number }): boolean {
    const { c, doc, bundle, directoryRevision } = context, config = this.config.translation;
    return (!!snapshot.referenceRoundId||snapshot.caseRevision === c.revision) && snapshot.reviewReleaseId === (c.configuration_release_id ?? null) &&
      snapshot.parseRevision === doc.current_parse_job_id && snapshot.directoryRevision === directoryRevision && snapshot.sourceSha256 === doc.sha256 &&
      snapshot.promptVersion === fieldTranslationPromptVersion(Boolean(snapshot.fieldSources)) && snapshot.glossaryVersion === TRANSLATION_GLOSSARY_VERSION &&
      (!config || snapshot.model === config.model && snapshot.modelRevision === config.modelRevision) &&
      snapshot.segments.every(segment=>bundle.chunks.some(chunk=>chunk.id===segment.chunkId)) &&
      snapshot.sourceFingerprint === sourceFingerprint(bundle, snapshot.segments.map(segment => segment.chunkId));
  }
  private async items(db: PoolClient, job: TranslationJob, snapshot: TranslationSnapshot) {
    const rows = (await db.query('SELECT chunk_id,body,body_hash FROM business.document_translation_segments WHERE job_id=$1', [job.id])).rows;
    const items = rows.map(row => {
      if (translationHash(row.body) !== row.body_hash) throw new AppError(409, 'translation_result_integrity_failed');
      const item = DocumentTranslatedSegmentSchema.parse(row.body), source = snapshot.segments.find(segment => segment.chunkId === row.chunk_id);
      if (!source || item.chunkId !== row.chunk_id || item.sourceSha256 !== source.sourceSha256 || item.contextSha256 !== source.contextSha256 ||
          item.sourceText !== source.sourceText || translationHash(item.source) !== translationHash(source.source)) throw new AppError(409, 'translation_result_integrity_failed');
      return item;
    });
    return snapshot.segments.flatMap(source => items.filter(item => item.chunkId === source.chunkId));
  }
  async get(actor: Actor, caseId: string, documentId: string, jobId: string, existingDb?: PoolClient): Promise<DocumentTranslationView> {
    const read = async (db: PoolClient) => {
      await authorizeCase(db, actor, caseId, 'evidence:read', false);
      const job = (await db.query("SELECT * FROM business.document_jobs WHERE id=$1 AND case_id=$2 AND document_version_id=$3 AND kind='translate_document'", [jobId, caseId, documentId])).rows[0] as TranslationJob | undefined;
      if (!job) throw new AppError(404, 'translation_not_found');
      const snapshot = await this.snapshot(db, job);
      let context;
      try { context = await this.context(db, actor, caseId, documentId, snapshot.parseRevision,false,snapshot.referenceRoundId,snapshot.fieldSources); }
      catch (error) {
        if (!snapshot.fieldSources || !(error instanceof AppError) || !['translation_source_integrity_failed','translation_quote_not_in_source'].includes(error.code)) throw error;
        // A removed/changed projection makes this a historical receipt, not a
        // failure to read every translation in the document's history.
        context = await this.context(db,actor,caseId,documentId,snapshot.parseRevision,false,snapshot.referenceRoundId);
      }
      let current = false;
      try { current = job.validity === 'current' && this.current(snapshot, context); } catch (error) { if (!(error instanceof AppError)) throw error; }
      let canCancel = false;
      if (current && job.account_id === actor.accountId && job.person_id === actor.personId && ['pending', 'running'].includes(job.state)) {
        try { await this.context(db,actor,caseId,documentId,snapshot.parseRevision,true,snapshot.referenceRoundId,snapshot.fieldSources); canCancel = true; } catch (error) { if (!(error instanceof AppError)) throw error; }
      }
      const items = await this.items(db, job, snapshot);
      const unknown = job.error_code === 'translation_call_unknown' || Boolean((await db.query("SELECT 1 FROM business.document_translation_calls WHERE job_id=$1 AND state='unknown' LIMIT 1", [job.id])).rowCount);
      let canRetry = false;
      if (current && this.config.translation && job.account_id === actor.accountId && job.person_id === actor.personId && job.auth_version === actor.authVersion && ['failed', 'canceled', 'partial'].includes(job.state)) {
        try {
          await this.context(db,actor,caseId,documentId,snapshot.parseRevision,true,snapshot.referenceRoundId,snapshot.fieldSources);
          const previous = (await db.query(`SELECT j.id FROM business.document_jobs j JOIN business.document_translation_snapshots s ON s.job_id=j.id
            WHERE j.case_id=$1 AND j.document_version_id=$2 AND s.input_hash=$3 AND j.validity='current'`, [caseId, documentId, job.input.inputSha256])).rows;
          const uncertain = (await db.query("SELECT 1 FROM business.document_translation_calls WHERE job_id=ANY($1::uuid[]) AND state='unknown' LIMIT 1", [previous.map(row => row.id)])).rowCount;
          canRetry = previous.length < 3 && !uncertain && !unknown;
        } catch (error) { if (!(error instanceof AppError)) throw error; }
      }
      return DocumentTranslationViewSchema.parse({ schemaVersion: 'document-translation.v1', jobId, caseId, documentId,
        ...(snapshot.fieldSources?{fieldSources:snapshot.fieldSources}:{}),
        ...(snapshot.scope ? {scope: snapshot.scope} : {}),
        caseRevision: snapshot.caseRevision, parseRevision: snapshot.parseRevision, directoryRevision: snapshot.directoryRevision,
        sourceCurrent: this.current({...snapshot,caseRevision:context.c.revision,reviewReleaseId:context.c.configuration_release_id??null},context),...(snapshot.referenceRoundId?{referenceRoundId:snapshot.referenceRoundId}:{}),
        status: current ? job.state : 'stale', validity: current ? 'current' : 'stale', purpose: 'reference', targetLanguage: 'zh-CN', reviewState: 'unreviewed',
        errorCode: unknown && !['pending', 'running'].includes(job.state) ? 'translation_call_unknown' : job.error_code,
        progress: { completedSegments: items.length, totalSegments: snapshot.segments.length }, items,
        chunkIds: snapshot.segments.map(segment => segment.chunkId), canCancel, canRetry,
        createdAt: job.created_at.toISOString(), modelRevision: snapshot.modelRevision, promptVersion: snapshot.promptVersion, glossaryVersion: snapshot.glossaryVersion });
    };
    return existingDb ? read(existingDb) : transaction(this.pool, read);
  }
  async list(actor: Actor, caseId: string, documentId: string, raw: unknown) {
    const query = DocumentTranslationHistoryQuerySchema.parse(raw);
    const ids = await transaction(this.pool, async db => {
      if (!this.config.reader) throw new AppError(409, 'capability_disabled');
      await authorizeCase(db, actor, caseId, 'evidence:read', false);
      const document = (await db.query(`SELECT d.id FROM business.document_versions d JOIN business.upload_sessions u ON u.id=d.upload_session_id
        WHERE d.id=$1 AND d.case_id=$2 AND u.state='registered' AND u.document_version_id=d.id`, [documentId, caseId])).rows[0];
      if (!document) throw new AppError(404, 'material_not_found');
      return (await db.query(`SELECT j.id FROM business.document_jobs j WHERE case_id=$1 AND document_version_id=$2 AND kind='translate_document'
        AND ($3::text IS NULL OR input->>'parseRevision'=$3)
        AND ($5::text[] IS NULL OR EXISTS (SELECT 1 FROM business.document_translation_snapshots s,
          jsonb_array_elements(s.body->'segments') segment WHERE s.job_id=j.id AND segment->>'chunkId'=ANY($5::text[])))
        AND ($6::text IS NULL OR COALESCE(input->>'scope','selection')=$6)
        ORDER BY created_at DESC,id DESC LIMIT $4`, [caseId, documentId, query.parseRevision ?? null, query.limit, query.chunkIds ?? null, query.scope ?? null])).rows.map(row => row.id as string);
    });
    const items = []; for (const id of ids) items.push(await this.get(actor, caseId, documentId, id));
    return DocumentTranslationListSchema.parse({ items });
  }
  async fence(db: PoolClient, job: TranslationJob) {
    this.enabled();
    const snapshot = await this.snapshot(db, job);
    const actor = { accountId: job.account_id, personId: job.person_id, authVersion: job.auth_version };
    const context = await this.context(db, actor, job.case_id, job.document_version_id, snapshot.parseRevision,true,snapshot.referenceRoundId,snapshot.fieldSources);
    if(snapshot.frozenSnapshotHash&&context.frozenSnapshotHash!==snapshot.frozenSnapshotHash)throw new AppError(409,'translation_frozen_source_mismatch');
    if (!this.current(snapshot, context)) throw new AppError(409, 'stale_translation_source');
  }
  /** Reuse compatible durable output, or wait for older work without resending its in-flight call. */
  private async reuseSegment(db: PoolClient, job: TranslationJob, snapshot: TranslationSnapshot, source: TranslationSegmentSource) {
    const candidates = (await db.query(`SELECT j.* FROM business.document_jobs j
      JOIN business.document_translation_snapshots s ON s.job_id=j.id
      WHERE j.case_id=$1 AND j.document_version_id=$2 AND j.kind='translate_document' AND j.validity='current'
        AND (j.created_at,j.id)<(SELECT created_at,id FROM business.document_jobs WHERE id=$3) AND j.input->>'parseRevision'=$4
        AND EXISTS (SELECT 1 FROM jsonb_array_elements(s.body->'segments') segment WHERE segment->>'chunkId'=$5)
      ORDER BY j.created_at DESC,j.id DESC`, [job.case_id, job.document_version_id, job.id, snapshot.parseRevision, source.chunkId])).rows as TranslationJob[];
    let waiting = false, unknown = false;
    for (const candidate of candidates) {
      const previous = await this.snapshot(db, candidate);
      const {scope: _scope, segments: _segments, sourceFingerprint: _fingerprint, ...identity} = previous;
      const {scope: _currentScope, segments: _currentSegments, sourceFingerprint: _currentFingerprint, ...currentIdentity} = snapshot;
      if (translationHash(identity) !== translationHash(currentIdentity) ||
          translationHash(previous.segments.find(segment => segment.chunkId === source.chunkId)) !== translationHash(source)) continue;
      const item = (await this.items(db, candidate, previous)).find(item => item.chunkId === source.chunkId && item.translatedText?.trim());
      if (item) return {item, waiting: false};
      if (['pending', 'running'].includes(candidate.state)) waiting = true;
      else if ((await db.query("SELECT 1 FROM business.document_translation_calls WHERE job_id=$1 AND chunk_id=$2 AND state='unknown'", [candidate.id, source.chunkId])).rowCount) unknown = true;
    }
    if (unknown) throw new ServiceError('translation_call_unknown');
    return {item: undefined, waiting};
  }
  async process(job: TranslationJob, signal: AbortSignal, fence: (db: PoolClient) => Promise<void>,
    finish: (db: PoolClient, state: 'ready' | 'partial', result: unknown) => Promise<void>, yieldWork: (db: PoolClient) => Promise<void>) {
    this.enabled(); if (!this.client) throw new ServiceError('document_translation_unavailable');
    const prepared = await transaction(this.pool, async db => { await fence(db); const snapshot = await this.snapshot(db, job); return { snapshot, items: await this.items(db, job, snapshot) }; });
    const next = prepared.snapshot.segments.find(segment => !prepared.items.some(item => item.chunkId === segment.chunkId));
    if (next) {
      const reused = prepared.snapshot.scope === 'full_text' ? await transaction(this.pool, async db => {
        await fence(db); return this.reuseSegment(db, job, prepared.snapshot, next);
      }) : undefined;
      if (reused?.waiting) {
        await transaction(this.pool, async db => { await fence(db); await yieldWork(db);
          await db.query("UPDATE business.work_items SET available_at=now()+interval '2 seconds' WHERE owner_id=$1 AND state='pending'", [job.id]); });
        return;
      }
      let dispatched = false;
      const durable = translationDispatch(this.pool, job.id, next.chunkId, fence);
      const item = reused?.item ?? await translateSegment({ source: next, config: this.config.translation!, client: this.client, job, signal,
        authorize: () => transaction(this.pool, fence), dispatch: async (body, start) => { dispatched = true; return durable(body, start); } });
      if (!reused?.item && !dispatched) throw new ServiceError('translation_dispatch_unrecorded');
      signal.throwIfAborted();
      await transaction(this.pool, async db => { await fence(db); signal.throwIfAborted();
        await db.query('INSERT INTO business.document_translation_segments(job_id,chunk_id,body,body_hash) VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING', [job.id, next.chunkId, JSON.stringify(item), translationHash(item)]);
      });
    }
    await transaction(this.pool, async db => {
      await fence(db); signal.throwIfAborted(); const items = await this.items(db, job, prepared.snapshot);
      if (items.length < prepared.snapshot.segments.length) { await yieldWork(db); return; }
      await finish(db, items.every(item => item.status === 'ready') ? 'ready' : 'partial', { translationJobId: job.id });
    });
  }
}
