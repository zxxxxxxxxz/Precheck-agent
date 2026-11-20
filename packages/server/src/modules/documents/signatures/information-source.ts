import {reviewMaterials} from '../../review/material-scope.js';
import {materialListIds} from '../../materials/review-scope.js';
import {createHash} from 'node:crypto';
import {DocumentBundleSchema, DocumentPageArtifactSchema, type DocumentBundle} from '@hsbc/contracts/documents';
import {SignatureObservationSchema} from '@hsbc/contracts/signature-review';
import type {ReviewObject,ReviewFact,ReviewEvidence} from '@hsbc/contracts/review';
import type {ReviewConfigManifest,ReviewFieldDefinition} from '@hsbc/contracts/review-config';
import type {SignatureInformationCandidate} from '@hsbc/contracts/signature-information';
import type {DB} from '../../../infrastructure/database/client.js';
import {AppError} from '../../../shared/errors.js';
import {automaticSignatureInformation} from './automatic-information.js';

/** Both the signature panel and field projection read the same immutable sources. */
export function automaticSignaturesFromContext(context:Awaited<ReturnType<typeof signatureSourceContext>>){
  return automaticSignatureInformation({documentId:context.doc.id,parseRevision:context.parse.id,sourceSha256:context.doc.sha256,
    directoryRevision:context.directoryRevision,pages:context.sourcePages,expectedPages:context.pages.map(p=>p.pageNumber),observations:context.sourceObservations});
}

export function signatureInformationHash(value:unknown):string{
  const sort=(v:any):any=>Array.isArray(v)?v.map(sort):v&&typeof v==='object'?Object.fromEntries(Object.keys(v).sort().filter(k=>v[k]!==undefined).map(k=>[k,sort(v[k])])):v;
  return createHash('sha256').update(JSON.stringify(sort(value))).digest('hex');
}
export async function signatureStorageAvailable(db:DB){return Boolean((await db.query("SELECT to_regclass('business.signature_information_records') IS NOT NULL AS available")).rows[0].available);}

/** Round-scoped business dependencies; signature edits themselves are not dependencies. */
export async function signatureDependencies(db:DB,c:any,roundId:string|null){
  const objects=(await db.query('SELECT DISTINCT ON(object_id) * FROM business.review_object_versions WHERE case_id=$1 AND round_id IS NOT DISTINCT FROM $2::uuid ORDER BY object_id,version DESC',[c.id,roundId])).rows.map(r=>({...r.body,objectId:r.object_id,version:r.version,validity:r.validity,confirmedBy:r.confirmed_by,caseRevision:r.case_revision} as ReviewObject));
  const facts=(await db.query('SELECT DISTINCT ON(fact_id) * FROM business.review_fact_versions WHERE case_id=$1 AND round_id IS NOT DISTINCT FROM $2::uuid ORDER BY fact_id,version DESC',[c.id,roundId])).rows.map(r=>({...r.body,factId:r.fact_id,version:r.version,validity:r.validity,confirmedBy:r.confirmed_by,caseRevision:r.case_revision} as ReviewFact));
  const materials=await reviewMaterials(db,c.id,roundId);
  const documents=(await db.query(`SELECT d.id,d.sha256,d.current_parse_job_id,d.parse_status,
    (SELECT max(directory_revision) FROM business.document_artifacts WHERE job_id=d.current_parse_job_id) AS directory_revision,
    (SELECT jsonb_build_object('id',j.id,'state',j.state,'validity',j.validity,'result',j.result) FROM business.document_jobs j WHERE j.document_version_id=d.id AND j.kind='extract_fields' ORDER BY j.created_at DESC,j.id DESC LIMIT 1) AS extraction
    FROM business.document_versions d WHERE d.case_id=$1 AND d.round_id IS NOT DISTINCT FROM $2::uuid ORDER BY d.id`,[c.id,roundId])).rows;
  const included=await materialListIds(db,c.id,roundId);
  return {objects,facts,materials,documents:documents.filter(d=>included===null||included.includes(d.id))};
}

export async function signatureSourceContext(db:DB,c:any,documentId:string,parseRevision?:string,dependencies?:Awaited<ReturnType<typeof signatureDependencies>>,historicalDirectoryRevision?:number){
  const doc=(await db.query(`SELECT d.* FROM business.document_versions d JOIN business.upload_sessions u ON u.id=d.upload_session_id
    WHERE d.id=$1 AND d.case_id=$2 AND u.state='registered' AND u.document_version_id=d.id`,[documentId,c.id])).rows[0];
  if(!doc)throw new AppError(404,'material_not_found');
  const parse=(await db.query("SELECT * FROM business.document_jobs WHERE id=$1 AND document_version_id=$2 AND case_id=$3 AND kind='parse_document'",[parseRevision??doc.current_parse_job_id,documentId,c.id])).rows[0];
  if(!parse)throw new AppError(409,'parse_not_available');
  const artifact=(await db.query('SELECT body,directory_revision FROM business.document_artifacts WHERE job_id=$1 AND ($2::integer IS NULL OR directory_revision=$2) ORDER BY directory_revision DESC LIMIT 1',[parse.id,historicalDirectoryRevision??null])).rows[0];
  if(!artifact)throw new AppError(409,'index_not_ready');
  const decoded=DocumentBundleSchema.safeParse(artifact.body);
  if(!decoded.success)throw new AppError(409,'signature_source_incomplete');
  const bundle=decoded.data,directoryRevision=Number(artifact.directory_revision);
  if(bundle.scope.caseId!==c.id||bundle.scope.documentVersionId!==documentId||bundle.scope.parseRevision!==parse.id||bundle.scope.sourceSha256!==doc.sha256)throw new AppError(409,'signature_source_mismatch');
  const latest=(await db.query("SELECT id,state,result,configuration_release_id FROM business.document_jobs WHERE document_version_id=$1 AND kind='extract_fields' AND validity='current' AND input->>'parseRevision'=$2 AND input->>'directoryRevision'=$3 ORDER BY created_at DESC,id DESC LIMIT 1",[documentId,parse.id,String(directoryRevision)])).rows[0];
  const complete=latest&&['ready','partial'].includes(latest.state)&&Array.isArray(latest.result?.items);
  const fields=complete?latest.result.items:latest?[]:parse.result?.fieldFilter?.directoryRevision===directoryRevision?parse.result.fieldFilter.items:bundle.fields;
  const anchors=[...bundle.anchors,...(complete?latest.result.anchors??[]:[])];
  const pageRows=(await db.query('SELECT page_number,image_sha256,body FROM business.document_pages WHERE job_id=$1 ORDER BY page_number',[parse.id])).rows;
  const pages=pageRows.map(r=>{const page=r.body?.page;if(!page||!Number.isFinite(page.width)||!Number.isFinite(page.height)||page.width<=0||page.height<=0)throw new AppError(409,'signature_source_incomplete');return {pageNumber:r.page_number,width:page.width,height:page.height,imageSha256:r.image_sha256};});
  const sourcePages=pageRows.flatMap(r=>{const parsed=DocumentPageArtifactSchema.safeParse(r.body);return parsed.success&&parsed.data.imageSha256===r.image_sha256&&parsed.data.page.page_number===r.page_number?[parsed.data]:[];});
  const observations=(await db.query("SELECT r.body FROM business.signature_page_receipts r JOIN business.document_jobs j ON j.id=r.job_id WHERE j.document_version_id=$1 AND j.kind='review_signatures' AND j.validity='current' AND j.input->>'parseRevision'=$2 AND j.input->>'directoryRevision'=$3",[documentId,parse.id,String(directoryRevision)])).rows;
  const observationSources=observations.flatMap(r=>(r.body?.observations??[]).filter((o:any)=>o.sourceSha256===doc.sha256&&o.parseRevision===parse.id&&pages.some(p=>p.pageNumber===o.pageNumber&&p.imageSha256===o.imageSha256)).map((o:any)=>({id:o.id,pageNumber:o.pageNumber})));
  const observationIds=observationSources.map((o:{id:string})=>o.id);
  const sourceObservations=observations.flatMap(r=>(r.body?.observations??[]).flatMap((raw:unknown)=>{const parsed=SignatureObservationSchema.safeParse(raw);return parsed.success&&observationIds.includes(parsed.data.id)?[parsed.data]:[];}));
  const deps=dependencies??await signatureDependencies(db,c,doc.round_id??null);
  const input={documentId,sourceSha256:doc.sha256,parseRevision:parse.id,directoryRevision,roundId:doc.round_id??null,configurationReleaseId:c.configuration_release_id??null,
    artifactHash:signatureInformationHash(bundle),extractionHash:signatureInformationHash(latest??null),pages,objects:deps.objects,factVersions:deps.facts.map(f=>({factId:f.factId,version:f.version})),dependenciesHash:signatureInformationHash(deps)};
  return {doc,parse,bundle,directoryRevision,fields,anchors,pages,sourcePages,sourceObservations,observationIds,observationSources,deps,input,inputHash:signatureInformationHash(input)};
}

/** Classify configured field semantics only for presentation, never as adopted facts/rules. */
export function signatureFieldKind(field:Pick<ReviewFieldDefinition,'label'|'type'|'objectKind'|'semanticDefinition'>):Pick<SignatureInformationCandidate,'kind'|'dateKind'>|null{
  const text=field.label+' '+field.semanticDefinition;
  if(field.type==='date'){
    if(/贷款期限|贷款到期|贷款起始|loan.term|loan.maturity|facility.maturity/i.test(field.label))return null;
    if(/决议|決議|resolution|board.*dated/i.test(text))return {kind:'date',dateKind:'resolution'};
    if(/授权|授權|authori[sz]/i.test(text))return {kind:'date',dateKind:/截止|到期|届满|expiry|until|end/i.test(text)?'authorization_until':/生效|起始|effective|from|start/i.test(text)?'authorization_from':'other'};
    if(/签署|签字|簽署|簽字|签置|execution|signed|signing/i.test(text))return {kind:'date',dateKind:/签署人|签字人|簽署人|每位|per.signer|individual.sign/i.test(text)?'person_signing':'document_signing'};
    return null;
  }
  // Generic semantic instructions often mention every candidate's name and signatures.
  // Applicability comes from this field's own label/type, never those boilerplate words.
  const label=field.label;
  if(/金额|金额|币种|地址|辦事處|办事处|号码|编号|身份证|identification|address|office|amount|currency|jurisdiction/i.test(label)||(field.type==='amount'||field.type==='currency'))return null;
  if(!/签署|签字|签名|簽署|簽字|授权|授權|见证|見證|signator|signature|authori[sz]|witness/i.test(label)&&field.objectKind!=='signatory')return null;
  if(/姓名|名称|名稱|\bname\b/i.test(label))return {kind:field.objectKind==='signatory'||/签署人|签字人|见证人|見證人|signatory|witness/i.test(label)?'person':'subject',dateKind:null};
  if(/职务|職務|title|capacity|position|role/i.test(label))return {kind:'role',dateKind:null};
  if(/授权|授權|authori[sz]/i.test(label))return {kind:'authorization',dateKind:null};
  return null;
}
export function signatureInformationCandidates(context:Awaited<ReturnType<typeof signatureSourceContext>>,manifest:ReviewConfigManifest|null):SignatureInformationCandidate[]{
  const result:SignatureInformationCandidate[]=[],definitions=manifest?.fields??[];
  for(const field of context.fields){
    const definition=definitions.find(d=>d.id===field.fieldId);if(!definition)continue;
    const semantics=signatureFieldKind(definition);if(!semantics)continue;
    for(const candidate of field.candidates??[]){
      const anchors=context.anchors.filter(a=>candidate.anchorIds?.includes(a.anchor_id)&&a.document_version_id===context.doc.id&&a.parse_revision===context.parse.id);
      const logicalIds=[...new Set(anchors.flatMap(a=>context.bundle.chunks.filter(c=>c.anchorIds.includes(a.anchor_id)).map(c=>c.logicalDocumentId).filter((id):id is string=>!!id)))];
      const evidence:ReviewEvidence[]=anchors.map(a=>({documentVersionId:context.doc.id,parseRevision:context.parse.id,directoryRevision:context.directoryRevision,anchorId:a.anchor_id}));
      const normalized=(value:string)=>value.normalize('NFKC').trim().replace(/\s+/g,' ').toLowerCase();
      const value=candidate.rawValue??candidate.value??null;
      const suggestedObjectIds=(semantics.kind==='person'||semantics.kind==='subject')&&typeof value==='string'?context.deps.objects.filter(o=>o.validity==='current'&&o.kind===definition.objectKind&&(!definition.objectRole||o.role===definition.objectRole)&&normalized(o.label)===normalized(value)&&o.evidence.some(e=>e.documentVersionId===context.doc.id&&e.parseRevision===context.parse.id&&e.directoryRevision===context.directoryRevision&&!!e.anchorId&&anchors.some(a=>a.anchor_id===e.anchorId))).map(o=>o.objectId):[];
      result.push({id:`candidate:${field.id}:${candidate.id}`,fieldId:field.fieldId,label:definition.label,value:candidate.rawValue??candidate.value??null,normalizedValue:candidate.normalizedValue??null,...semantics,logicalDocumentId:logicalIds.length===1?logicalIds[0]??null:null,pageNumbers:[...new Set(anchors.map(a=>a.page_number))],evidence,origin:'automatic_candidate',candidateId:candidate.id,factId:null,objectId:null,suggestedObjectIds});
    }
  }
  // Original parser signature context is useful even without a field release or vision job.
  // It remains a candidate: context proximity never assigns a person or a date owner.
  for(const signature of context.bundle.signatures??[]){
    const anchors=context.anchors.filter(a=>signature.anchorIds.includes(a.anchor_id)&&a.document_version_id===context.doc.id&&a.parse_revision===context.parse.id&&a.page_number===signature.pageNumber);
    if(!anchors.length)continue;
    const evidence:ReviewEvidence[]=anchors.map(a=>({documentVersionId:context.doc.id,parseRevision:context.parse.id,directoryRevision:context.directoryRevision,anchorId:a.anchor_id}));
    const logicalIds=[...new Set(anchors.flatMap(a=>context.bundle.chunks.filter(c=>c.anchorIds.includes(a.anchor_id)).map(c=>c.logicalDocumentId).filter((id):id is string=>!!id)))];
    for(const [component,kind,label,dateKind] of [['name','person','签署栏打印姓名',null],['title','role','签署栏职务',null],['date','date','签署栏日期（用途待核对）','location_signing']] as const){
      const value=signature[component];if(!value)continue;
      result.push({id:`signature-context:${signature.id}:${component}`,fieldId:`signature-context:${component}`,label,value,normalizedValue:null,kind,dateKind,logicalDocumentId:logicalIds.length===1?logicalIds[0]!:null,pageNumbers:[signature.pageNumber],evidence,origin:'automatic_candidate',candidateId:signature.id,factId:null,objectId:null});
    }
  }
  for(const fact of context.deps.facts.filter(f=>f.validity==='current'&&f.evidence.some(e=>e.documentVersionId===context.doc.id&&e.parseRevision===context.parse.id))){
    const definition=definitions.find(d=>d.id===fact.fieldId);if(!definition)continue;const semantics=signatureFieldKind(definition);if(!semantics)continue;
    const own=fact.evidence.filter(e=>e.documentVersionId===context.doc.id&&e.parseRevision===context.parse.id);
    const anchors=context.anchors.filter(a=>own.some(e=>e.anchorId===a.anchor_id));
    const logicalIds=[...new Set(anchors.flatMap(a=>context.bundle.chunks.filter(c=>c.anchorIds.includes(a.anchor_id)).map(c=>c.logicalDocumentId).filter((id):id is string=>!!id)))];
    result.push({id:`fact:${fact.factId}:${fact.version}`,fieldId:fact.fieldId,label:definition.label,value:fact.rawValue,normalizedValue:typeof fact.normalizedValue==='string'?fact.normalizedValue:null,...semantics,logicalDocumentId:logicalIds.length===1?logicalIds[0]??null:null,pageNumbers:[...new Set(anchors.map(a=>a.page_number))],evidence:own,origin:'adopted_fact',candidateId:fact.candidateRef?.candidateId??null,factId:fact.factId,objectId:fact.objectId});
  }
  return result;
}

export async function validateSignatureEvidence(db:DB,caseId:string,roundId:string|null,evidence:ReviewEvidence[]){
  const cache=new Map<string,Awaited<ReturnType<typeof signatureSourceContext>>>();
  const c=(await db.query('SELECT * FROM business.cases WHERE id=$1',[caseId])).rows[0];
  for(const e of evidence){
    const key=e.documentVersionId+':'+e.parseRevision;
    let context=cache.get(key);if(!context){context=await signatureSourceContext(db,c,e.documentVersionId,e.parseRevision);cache.set(key,context);}
    if((context.doc.round_id??null)!==roundId||context.doc.current_parse_job_id!==e.parseRevision||context.directoryRevision!==e.directoryRevision)throw new AppError(409,'signature_evidence_stale');
    if(e.anchorId&&!context.anchors.some(a=>a.anchor_id===e.anchorId&&a.document_version_id===e.documentVersionId&&a.parse_revision===e.parseRevision))throw new AppError(422,'signature_evidence_invalid');
    if(e.sourceNodeId){const source=(await db.query('SELECT body FROM business.document_sources WHERE job_id=$1',[e.parseRevision])).rows[0];if(!source?.body.nodes?.some((n:any)=>n.id===e.sourceNodeId&&n.visibility==='visible'&&!n.excludedFromVisibleFacts))throw new AppError(422,'signature_evidence_invalid');}
  }
}
