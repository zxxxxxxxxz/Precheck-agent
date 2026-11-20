import {randomUUID} from 'node:crypto';
import {SignatureInformationCommandSchema,SignatureInformationStateSchema,emptySignatureInformation,type SignatureInformationState,type SignatureInformationProjection,type SignatureInformationSummary} from '@hsbc/contracts/signature-information';
import type {ReviewConfigManifest} from '@hsbc/contracts/review-config';
import type {Actor} from '../../identity/types.js';
import type {DB} from '../../../infrastructure/database/client.js';
import type {DocumentReviewPort} from '../ports.js';
import {authorizeCase} from '../../cases/authorization.js';
import {assertRoundRequest,assertDocumentRound} from '../../review/round-boundary.js';
import {idempotent} from '../../../infrastructure/database/idempotency.js';
import {audit} from '../../audit/events.js';
import {AppError} from '../../../shared/errors.js';
import {normalizeDate} from '../../review/normalization.js';
import {signatureRequirements} from './requirements.js';
import {evaluateSignatureInformation} from './information-evaluation.js';
import {automaticSignaturesFromContext,signatureInformationHash,signatureStorageAvailable,signatureSourceContext,signatureInformationCandidates,signatureDependencies,validateSignatureEvidence} from './information-source.js';

type Context=Awaited<ReturnType<typeof signatureSourceContext>>;
function assertState(state:SignatureInformationState,context:Context,manifest:ReviewConfigManifest|null){
  const error=(code='signature_information_scope_invalid'):never=>{throw new AppError(422,code);};
  for(const items of Object.values(state))if(new Set(items.map(item=>item.id)).size!==items.length)error('signature_information_duplicate_id');
  const logical=(id:string)=>context.bundle.logicalDocuments.find(d=>d.id===id);
  const object=(id:string|null,kinds:string[])=>context.deps.objects.find(o=>o.objectId===id&&o.validity==='current'&&kinds.includes(o.kind)&&o.evidence.length>0);
  const geometry=(box:any,page:any)=>{if(box&&(!page||box.x+box.width>page.width||box.y+box.height>page.height))error('signature_geometry_outside_page');};
  for(const location of state.locations){
    const document=logical(location.logicalDocumentId),page=context.pages.find(p=>p.pageNumber===location.pageNumber);
    if(!document||!document.pageNumbers.includes(location.pageNumber)||!page)error();geometry(location.box,page);
    if(location.fieldId&&!manifest?.fields.some(f=>f.id===location.fieldId))error();
  }
  const boxes=new Set<string>();
  for(const entry of state.entries){
    const location=state.locations.find(l=>l.id===entry.locationId);if(!location)error();
    const page=context.pages.find(p=>p.pageNumber===location!.pageNumber);geometry(entry.box,page);
    if(entry.box&&location!.box){const b=entry.box,p=location!.box;if(b.x<p.x||b.y<p.y||b.x+b.width>p.x+p.width||b.y+b.height>p.y+p.height)error('signature_child_outside_location');}
    if(entry.duplicateOf){const original=state.entries.find(e=>e.id===entry.duplicateOf),originalLocation=state.locations.find(l=>l.id===original?.locationId);
      if(!original||original.id===entry.id||original.duplicateOf||!originalLocation||originalLocation.pageNumber!==location!.pageNumber||originalLocation.logicalDocumentId!==location!.logicalDocumentId||!entry.note.trim())error('signature_duplicate_reference_invalid');}
    if(entry.box&&entry.status!=='excluded'&&!entry.duplicateOf){const key=JSON.stringify([location!.pageNumber,entry.box,entry.kind]);if(boxes.has(key))error('signature_duplicate_region');boxes.add(key);}
    if(entry.kind==='stamp'&&entry.personId)error('signature_stamp_person_invalid');
    if(entry.identityConfirmed){
      if(entry.additionalRoles?.length&&!entry.evidence.length)error('signature_identity_not_confirmed');
      if(entry.status!=='confirmed'||!object(entry.subjectId,['party']))error('signature_identity_not_confirmed');
      if(entry.kind==='stamp'){if(entry.personId)error('signature_stamp_person_invalid');}
      else {const person=object(entry.personId,['signatory','party']);if(!person||entry.capacity==='unknown'||person.kind==='party'&&(entry.capacity!=='self'||person.objectId!==entry.subjectId||!entry.evidence.length||!!person.companyNameSelection)||(person.role!==entry.role&&!entry.evidence.length))error('signature_identity_not_confirmed');}
    }
    if(entry.authorizationIds.some(id=>!state.authorizations.some(a=>a.id===id)))error();
    if(entry.sourceObservationId){/* a legacy observation is provenance, not a new model receipt */
      if(!context.observationSources.some((o:{id:string;pageNumber:number})=>o.id===entry.sourceObservationId&&o.pageNumber===location!.pageNumber))error('signature_observation_reference_invalid');
      if(entry.status!=='excluded'&&!entry.duplicateOf&&state.entries.some(e=>e.id!==entry.id&&e.status!=='excluded'&&!e.duplicateOf&&e.sourceObservationId===entry.sourceObservationId))error('signature_duplicate_region');
    }
  }
  for(const authority of state.authorizations){
    if(!object(authority.subjectId,['party'])||authority.personIds.some(id=>!object(id,['signatory','party']))||authority.logicalDocumentIds.some(id=>!logical(id)))error('signature_authority_scope_invalid');
    if(authority.status==='confirmed'&&!authority.evidence.length)error('signature_authorization_evidence_required');
  }
  const selector=(d:{kind:string;targetType:string;targetId:string})=>{
    const exists=d.targetType==='document'?!!logical(d.targetId):d.targetType==='location'?state.locations.some(l=>l.id===d.targetId):d.targetType==='entry'?state.entries.some(e=>e.id===d.targetId):state.authorizations.some(a=>a.id===d.targetId);
    if(!exists)error('signature_date_target_invalid');
    if(d.kind==='document_signing'&&d.targetType!=='document'||d.kind==='person_signing'&&d.targetType!=='entry'||d.kind==='location_signing'&&d.targetType!=='location'||d.kind.startsWith('authorization_')&&d.targetType!=='authorization')error('signature_date_kind_scope_mismatch');
  };
  for(const date of state.dates){if(date.targetId)selector({...date,targetId:date.targetId});else if(date.status==='confirmed')error('signature_date_target_invalid');if(date.status==='confirmed'&&!date.evidence.length)error('signature_date_evidence_required');date.normalizedValue=date.rawValue.trim()?normalizeDate(date.rawValue,date.calendar).value:null;}
  for(const rule of state.dateRules){selector(rule.left);if(rule.right)selector(rule.right);if(!['required','blank'].includes(rule.operation)&&!rule.right)error('signature_date_comparison_required');if(rule.status==='confirmed'&&!rule.evidence.length)error('signature_date_rule_evidence_required');}
  const candidates=signatureRequirements(context.bundle,manifest?.signatureRequirements??[]);
  for(const scoped of state.requirements){
    const document=logical(scoped.logicalDocumentId),subject=object(scoped.subjectId,['party']);
    if(!document||!subject||subject.role!==scoped.requirement.subjectRole||!scoped.requirement.taxonomyIds.includes(document.labelId??''))error('signature_requirement_subject_invalid');
    if(scoped.locationIds.some(id=>!state.locations.some(l=>l.id===id&&l.logicalDocumentId===scoped.logicalDocumentId))||new Set(scoped.locationIds).size!==scoped.locationIds.length)error('signature_requirement_location_invalid');
    if(scoped.entryIds.some(id=>!state.entries.some(e=>e.id===id&&scoped.locationIds.includes(e.locationId))))error('signature_requirement_entry_invalid');
    const source=candidates.find(r=>r.requirement.id===scoped.sourceRequirementId);
    if(scoped.sourceRequirementId&&!source)error('signature_requirement_source_invalid');
    if(source?.source==='published_configuration'&&(signatureInformationHash(scoped.requirement)!==signatureInformationHash(source.requirement)||!scoped.mandatory||scoped.status==='excluded'))error('signature_published_requirement_changed');
    if(scoped.status==='confirmed'&&source?.source!=='published_configuration'&&!scoped.evidence.length)error('signature_requirement_evidence_required');
  }
}

function evaluated(state:SignatureInformationState,context:Context,manifest:ReviewConfigManifest|null){
  const evaluation=evaluateSignatureInformation(state);
  for(const requirement of manifest?.signatureRequirements??[]){
    for(const logical of context.bundle.logicalDocuments.filter(d=>requirement.taxonomyIds.includes(d.labelId??''))){
      const subjects=context.deps.objects.filter(o=>o.validity==='current'&&o.kind==='party'&&o.role===requirement.subjectRole);
      for(const subject of subjects.length?subjects:[null]){
        if(subject&&state.requirements.some(r=>r.sourceRequirementId===requirement.id&&r.logicalDocumentId===logical.id&&r.subjectId===subject.objectId&&r.status!=='excluded'))continue;
        evaluation.checks.push({id:`unassigned:${logical.id}:${requirement.id}:${subject?.objectId??'unknown'}`,label:requirement.label+(subject?` · ${subject.label}`:''),requirementId:requirement.id,locationId:null,entryIds:[],status:'needs_confirmation',mandatory:true,reasons:['published_requirement_scope_unconfirmed'],evidence:[]});
        evaluation.counts.pending++;evaluation.blocking=true;
      }
    }
  }
  return evaluation;
}

export async function readSignatureInformation(db:DB,actor:Actor,caseId:string,documentId:string,review:DocumentReviewPort,parseRevision?:string,recordId?:string):Promise<SignatureInformationProjection>{
  const c=await authorizeCase(db,actor,caseId,'evidence:read',false);
  const available=await signatureStorageAvailable(db),published=c.configuration_release_id?await review.getPublished(db,c.configuration_release_id):null;
  const history=available?(await db.query('SELECT id,version,created_at,actor_id,reason FROM business.signature_information_records WHERE document_version_id=$1 ORDER BY version DESC LIMIT 100',[documentId])).rows:[];
  const record=available?(await db.query('SELECT * FROM business.signature_information_records WHERE document_version_id=$1 AND ($2::uuid IS NULL OR id=$2) ORDER BY version DESC LIMIT 1',[documentId,recordId??null])).rows[0]:null;
  if(recordId&&!record)throw new AppError(404,'signature_information_not_found');
  const context=await signatureSourceContext(db,c,documentId,recordId&&record?record.parse_revision:parseRevision,undefined,recordId&&record?Number(record.directory_revision):undefined);
  if(record&&(signatureInformationHash(record.body)!==record.body_hash||signatureInformationHash(record.input)!==record.input_hash))throw new AppError(409,'signature_information_integrity_failed');
  const state=record?SignatureInformationStateSchema.parse(record.body):emptySignatureInformation();
  const historical=!!recordId||context.doc.current_parse_job_id!==context.parse.id||(context.doc.round_id??null)!==(c.current_round_id??null);
  const stale=!!record&&record.input_hash!==context.inputHash;
  let readOnly=historical||!available;
  if(!readOnly)try{await authorizeCase(db,actor,caseId,'field:correct',false);await assertDocumentRound(db,c,documentId);}catch(error){if(!(error instanceof AppError))throw error;readOnly=true;}
  const evaluation=historical&&record?record.evaluation:evaluated(state,context,published?.manifest??null);
  return {schemaVersion:'signature-information.v1',caseId,documentId,parseRevision:context.parse.id,directoryRevision:context.directoryRevision,sourceSha256:context.doc.sha256,roundId:context.doc.round_id??null,caseRevision:c.revision,inputHash:context.inputHash,version:record?.version??0,recordId:record?.id??null,validity:stale?'stale':'current',readOnly,storageAvailable:available,
    locations:context.bundle.logicalDocuments.map(d=>({id:d.id,label:published?.manifest.taxonomy.find(t=>t.id===d.labelId)?.label??d.labelId??'未分类文书',taxonomyId:d.labelId,pageNumbers:d.pageNumbers})),pages:context.pages,objects:historical&&record?.input.objects?record.input.objects:context.deps.objects,candidates:signatureInformationCandidates(context,published?.manifest??null),requirementCandidates:signatureRequirements(context.bundle,published?.manifest.signatureRequirements??[]),state,evaluation,
    automatic:recordId?undefined:automaticSignaturesFromContext(context),
    history:history.map(r=>({id:r.id,version:r.version,createdAt:r.created_at.toISOString(),actorId:r.actor_id,reason:r.reason}))};
}

export async function saveSignatureInformation(db:DB,actor:Actor,caseId:string,documentId:string,review:DocumentReviewPort,raw:unknown){
  const input=SignatureInformationCommandSchema.parse(raw),c=await authorizeCase(db,actor,caseId,'field:correct');
  await assertRoundRequest(db,c,input.roundId,{draft:true});await assertDocumentRound(db,c,documentId);
  if(!await signatureStorageAvailable(db))throw new AppError(409,'signature_information_storage_unavailable');
  return idempotent(db,actor,`document.signature-information:${documentId}`,input.idempotencyKey,input,async()=>{
    if(c.revision!==input.expectedRevision)throw new AppError(409,'stale_revision');
    const context=await signatureSourceContext(db,c,documentId,input.parseRevision);
    if(context.doc.current_parse_job_id!==input.parseRevision||context.directoryRevision!==input.expectedDirectoryRevision||context.inputHash!==input.expectedInputHash)throw new AppError(409,'stale_signature_information');
    const previous=(await db.query('SELECT version,body FROM business.signature_information_records WHERE document_version_id=$1 ORDER BY version DESC LIMIT 1',[documentId])).rows[0];
    if((previous?.version??0)!==input.expectedVersion)throw new AppError(409,'stale_signature_information');
    const published=c.configuration_release_id?await review.getPublished(db,c.configuration_release_id):null;
    const state=SignatureInformationStateSchema.parse(input.state);
    if(previous){const prior=SignatureInformationStateSchema.parse(previous.body);for(const key of Object.keys(prior) as (keyof SignatureInformationState)[]){if(prior[key].some(old=>!state[key].some(next=>next.id===old.id)))throw new AppError(422,'signature_history_record_removal_forbidden');}}
    assertState(state,context,published?.manifest??null);
    const evidence=[...state.locations,...state.entries,...state.dates,...state.authorizations,...state.requirements,...state.dateRules].flatMap(r=>r.evidence);
    evidence.push(...state.requirements.flatMap(r=>r.transaction.evidence));
    const linkedIds=new Set([...state.entries.flatMap(e=>[e.personId,e.subjectId]),...state.authorizations.flatMap(a=>[a.subjectId,...a.personIds])]);
    evidence.push(...context.deps.objects.filter(o=>linkedIds.has(o.objectId)).flatMap(o=>o.evidence));
    await validateSignatureEvidence(db,caseId,c.current_round_id??null,evidence);
    const id=randomUUID(),version=input.expectedVersion+1,evaluation=evaluated(state,context,published?.manifest??null);
    await db.query('INSERT INTO business.signature_information_records(id,case_id,document_version_id,round_id,parse_revision,directory_revision,version,input_hash,input,body,body_hash,evaluation,actor_id,reason) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)',
      [id,caseId,documentId,c.current_round_id??null,input.parseRevision,context.directoryRevision,version,context.inputHash,JSON.stringify(context.input),JSON.stringify(state),signatureInformationHash(state),JSON.stringify(evaluation),actor.personId,input.reason]);
    if(!review.signatureInformationChanged)throw new AppError(409,'signature_review_integration_unavailable');
    await review.signatureInformationChanged(db,c,actor,{documentId,recordId:id,version,reason:input.reason});
    await audit(db,{actorId:actor.accountId,targetId:documentId,action:'document:signature_information_saved',details:{recordId:id,version}});
    return {recordId:id,version,revision:c.revision};
  });
}

/** The same stored projection feeds case review, checker snapshots and exports. */
export async function signatureInformationSummaries(db:DB,c:any,roundId:string|null,manifest:ReviewConfigManifest|null=null):Promise<SignatureInformationSummary[]>{
  const available=await signatureStorageAvailable(db);
  const records=available?(await db.query('SELECT DISTINCT ON(r.document_version_id) r.*,d.filename FROM business.signature_information_records r JOIN business.document_versions d ON d.id=r.document_version_id WHERE r.case_id=$1 AND r.round_id IS NOT DISTINCT FROM $2::uuid ORDER BY r.document_version_id,r.version DESC',[c.id,roundId])).rows:[];
  const dependencies=await signatureDependencies(db,c,roundId),result:SignatureInformationSummary[]=[];
  for(const r of records){
    if(signatureInformationHash(r.body)!==r.body_hash||signatureInformationHash(r.input)!==r.input_hash)throw new AppError(409,'signature_information_integrity_failed');
    let current=false;try{const context=await signatureSourceContext(db,c,r.document_version_id,undefined,dependencies);current=context.inputHash===r.input_hash;}catch(error){if(!(error instanceof AppError))throw error;}
    result.push({documentId:r.document_version_id,filename:r.filename,recordId:r.id,version:r.version,inputHash:r.input_hash,validity:current?'current':'stale',state:SignatureInformationStateSchema.parse(r.body),evaluation:r.evaluation});
  }
  for(const document of dependencies.documents){
    if(records.some(r=>r.document_version_id===document.id))continue;
    // An empty, unrecorded signature state only produces configured checks.
    // Inspect its directory before loading/hashing whole bundles and pages.
    // Missing sources still enter the existing mandatory-gap fallback below.
    const directory=document.current_parse_job_id?(await db.query("SELECT body->'logicalDocuments' AS logical_documents FROM business.document_artifacts WHERE job_id=$1 ORDER BY directory_revision DESC LIMIT 1",[document.current_parse_job_id])).rows[0]:null;
    const applicable=dependencies.materials.some(m=>m.documentVersionId===document.id&&m.operation==='adopt'&&manifest?.signatureRequirements?.some(r=>r.taxonomyIds.includes(m.documentTypeId)));
    if(!applicable&&Array.isArray(directory?.logical_documents)&&!directory.logical_documents.some((logical:{labelId?:string})=>manifest?.signatureRequirements?.some(requirement=>requirement.taxonomyIds.includes(logical?.labelId??''))))continue;
    try{
      const context=await signatureSourceContext(db,c,document.id,undefined,dependencies),state=emptySignatureInformation(),evaluation=evaluated(state,context,manifest);
      if(evaluation.checks.length)result.push({documentId:document.id,filename:context.doc.filename,recordId:`unrecorded:${document.id}`,version:0,inputHash:context.inputHash,validity:'current',state,evaluation});
    }catch(error){if(!(error instanceof AppError))throw error;
      const applicable=dependencies.materials.some(m=>m.documentVersionId===document.id&&m.operation==='adopt'&&manifest?.signatureRequirements?.some(r=>r.taxonomyIds.includes(m.documentTypeId)));
      if(applicable)result.push({documentId:document.id,filename:'待核对材料',recordId:`unrecorded:${document.id}`,version:0,inputHash:signatureInformationHash(document),validity:'stale',state:emptySignatureInformation(),evaluation:{checks:[{id:`unreadable:${document.id}`,label:'签署要求尚无可核对原件',requirementId:null,locationId:null,entryIds:[],status:'needs_confirmation',mandatory:true,reasons:['source_not_available'],evidence:[]}],counts:{signatures:0,people:0,satisfied:0,pending:1},blocking:true}});
    }
  }
  return result.sort((a,b)=>a.documentId.localeCompare(b.documentId));
}

/** Checker consumes exactly the frozen record set and cannot waive mandatory gaps. */
export function assertSignatureInformationSnapshot(current:SignatureInformationSummary[],frozen:SignatureInformationSummary[]=[]){
  if(signatureInformationHash(current)!==signatureInformationHash(frozen)||current.some(s=>s.validity!=='current'||s.evaluation.blocking))throw new AppError(409,'signature_information_requires_review');
}
