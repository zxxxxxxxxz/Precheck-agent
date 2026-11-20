import {setImmediate} from 'node:timers/promises';
import { finalizeFieldSourceCoverage } from './field-source-coverage.js';
import {recoverRmSourceFields} from './rm-source-fields.js';
import {recoverGuaranteeSourceFields} from './guarantee-source-fields.js';
import {scopeCorporateArticlesQuorum} from '@hsbc/contracts/corporate-requirements';
import {UPLOAD_CLASSIFICATION_VERSION,SAVED_MATERIAL_FIELD_INSTRUCTIONS,CONTENT_CLASSIFICATION_VERSION,CONTENT_CLASSIFICATION_SHA256,usesContentClassification,fixedMaterialType,scopedClassificationManifest,assertFixedClassification} from './content-classification.js';
import {contentClassificationProtocol} from './content-classification-protocol.js';
import { createHash,randomUUID } from 'node:crypto';
import {ZodError} from 'zod';
import type { Pool,PoolClient } from 'pg';
import type { DocxSourceDocument } from '@hsbc/contracts/docx';
import {DOCUMENT_DOCX_VERSION,DOCUMENT_DOCX_SCHEMA,DOCUMENT_DOCX_INSTRUCTIONS,DOCUMENT_DOCX_PROMPT_SHA256,DocumentDocxOutputSchema,DocumentDocxFieldsOutputSchema,documentDocxInput,validateDocumentDocxOutput} from './docx-extraction-contract.js';
import type { DocumentBundle,DocumentPageArtifact } from '@hsbc/contracts/documents';
import { ModelProfileSchema,ModelResultSchema } from '@hsbc/contracts/model';
import type { ReviewConfigManifest } from '@hsbc/contracts/review-config';
import { transaction } from '../../infrastructure/database/client.js';
import { ModelGateway,ModelExecutionError } from '../../model/gateway.js';
import { audit } from '../audit/events.js';
import { PrivacyProjectionService,PrivateIntakeProjectionSchema,PRIVACY_PREPARE_VERSION,PRIVACY_DOCUMENT_TERMS_VERSION,LEGACY_FRAGMENT_PREPARE_VERSION,splitPrivacyBlocks,type PrivacyProjectionOptions } from '../intake/privacy-projection.js';
import { proposeIntakeEntities } from '../intake/intake-v2-model.js';
import { DOCUMENT_CLOUD_VERSION,DOCUMENT_CLOUD_SCHEMA,DOCUMENT_CLOUD_PROMPT_SHA256,DocumentCloudOutputSchema,DocumentCloudFieldsOutputSchema,documentCloudInput,documentPublicTemplateDigests,validateDocumentCloudOutput } from './cloud-extraction-contract.js';
import { AzureDocumentExtractionAdapter,documentCloudBody,DOCUMENT_CLOUD_V1_PROTOCOL,type DocumentCloudProtocol } from './cloud-extraction-model.js';
import { DOCUMENT_CLOUD_V2_VERSION,DOCUMENT_CLOUD_V2_SCHEMA,DOCUMENT_CLOUD_V2_INSTRUCTIONS,DOCUMENT_CLOUD_V2_PROMPT_SHA256,
  DocumentCloudV2OutputSchema,DocumentCloudV2FieldsOutputSchema,validateDocumentCloudV2Output,documentCompletionTargets,documentCompletionInput,mergeDocumentCompletion } from './cloud-extraction-v2-contract.js';
import { DocumentExtractionLedger,type UnknownCompletionFirstPass } from './cloud-extraction-ledger.js';
import {documentCloudExecutionConfig,type DocumentCloudConfig } from './cloud-extraction-config.js';
import { configHash } from '../review/opa.js';
import { ServiceError } from '../../infrastructure/integrations/http.js';
import { NerClient } from '../../infrastructure/integrations/inference.js';
import { documentNerWithCapacity } from './ner-capacity.js';
import { structureInsuranceTableRows } from './insurance-table-structure.js';
import { recoverTablePartyRoles } from './table-party-role.js';
import { recoverExplicitPartyRoles } from './explicit-party-role.js';
import { augmentAuthorizationSources } from './authorization-source-evidence.js';
import { correctClauseSources } from './clause-source-correction.js';
import { associateSigningSubjectNames } from '../company-identity/signing-subject-names.js';
import { associateBilingualNames } from './bilingual-name-groups.js';
import { recoverDirectorNoticeFields } from './director-notice-fields.js';
import { recoverAnnualReturnFields } from './annual-return-fields.js';
import { rejectContradictedHeaderNames } from '../company-identity/ocr-name-consistency.js';
import { DOCUMENT_DICTIONARY_PROTOCOL_VERSION, documentDictionaryProtocol, assertDocumentDictionaryReferences, restoreLegacyDictionaryReferences } from './cloud-dictionary.js';

import { documentProcessingPermit, type ProcessingPermit } from './processing-access.js';

const digest=(value:unknown)=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
export interface DocumentCloudJob {id:string;case_id:string;document_version_id:string;expected_revision:number;account_id:string;person_id:string;auth_version:number;input?:{processingPermit?:ProcessingPermit}}
export interface DocumentCloudRun {
  loadPageImage?:(page:DocumentPageArtifact)=>Promise<Uint8Array>;
  pool:Pool;config:DocumentCloudConfig;job:DocumentCloudJob;bundle:DocumentBundle;pages:DocumentPageArtifact[];
  manifest:ReviewConfigManifest;source?:DocxSourceDocument;fence:(db:PoolClient)=>Promise<void>;signal:AbortSignal;fetcher?:typeof fetch;
  classificationOnly?:boolean;
  uploadClassification?:boolean;
  fixedClassification?:DocumentBundle['logicalDocuments'];
  requireSavedClassification?:boolean;
  onClassified?:(directory:DocumentBundle['logicalDocuments'])=>Promise<DocumentBundle>;
}
/** Document jobs own authorization, the immutable input and final write transaction. */
export async function runDocumentCloudExtraction(run:DocumentCloudRun) {
  if(!run.uploadClassification&&!usesContentClassification(run.manifest))return runDocumentCloudPhase(run);
  let bundle=run.bundle;
  const directory=bundle.logicalDocuments.filter(d=>!d.id.startsWith('source-document:'));
  const manual=directory.length>0&&directory.every(d=>d.source==='manual');
  if(!manual&&!run.requireSavedClassification){
    const classification=await runDocumentCloudPhase({...run,classificationOnly:true});
    bundle=run.onClassified?await run.onClassified(classification.logicalDocuments):{...bundle,classificationMode:CONTENT_CLASSIFICATION_VERSION,logicalDocuments:classification.logicalDocuments};
    if(!fixedMaterialType(bundle))return classification;
  }else if(!fixedMaterialType(bundle)||!run.uploadClassification&&!manual&&bundle.classificationMode!==CONTENT_CLASSIFICATION_VERSION){
    throw new ServiceError('document_cloud_classification_conflict');
  }
  const manifest=scopedClassificationManifest(run.manifest,bundle);
  if(!manifest.fields.length)return {logicalDocuments:bundle.logicalDocuments,fields:[],anchors:[],receipt:{version:CONTENT_CLASSIFICATION_VERSION,inputHash:digest(bundle.scope),model:null,provider:null,usage:null,completion:'not_needed' as const}};
  return runDocumentCloudPhase({...run,bundle,manifest,fixedClassification:bundle.logicalDocuments});
}
async function runDocumentCloudPhase(run:DocumentCloudRun) {
  const {pool,job,bundle,pages,manifest,signal}=run,policy=run.config.cloud.policy;
  const classificationOnly=run.classificationOnly===true,contentFirst=run.uploadClassification===true||usesContentClassification(manifest),fieldsOnly=run.uploadClassification===true&&!!run.fixedClassification;
  const snapshotTable=classificationOnly?'business.document_classification_inputs':'business.document_model_snapshots';
  let config=run.config;
  const allowed=async(db:PoolClient)=>{
    if(manifest.scope!=='synthetic')return false;
    const permit=job.input?.processingPermit;
    if(!permit||permit.kind==='static')return policy.caseIds.includes(job.case_id)&&policy.documentIds.includes(job.document_version_id)&&Date.parse(policy.expiresAt)>Date.now();
    const c=(await db.query('SELECT id,maker_person_id,configuration_release_id FROM business.cases WHERE id=$1',[job.case_id])).rows[0];
    const doc=(await db.query('SELECT id,sha256,source_format FROM business.document_versions WHERE id=$1 AND case_id=$2',[job.document_version_id,job.case_id])).rows[0];
    return !!c&&!!doc&&!!await documentProcessingPermit(db,run.config,c,doc,permit);
  };
  const fence=async(db:PoolClient)=>{
    await run.fence(db);signal.throwIfAborted();
    if(!await allowed(db))throw new ModelExecutionError('egress_denied');
  };
  await transaction(pool,fence);
  const definitions=manifest.fields.filter(field=>field.recipe.mode==='cloud_grounded_extract');
  const native=bundle.scope.sourceFormat==='docx';
  const v2=!native&&definitions.length>0&&definitions.every(field=>field.recipe.version===DOCUMENT_CLOUD_V2_VERSION);
  if(!run.uploadClassification&&contentFirst&&!native&&!v2)throw new ModelExecutionError('profile_version_mismatch');
  // Word files are read with the same output capacity and reasoning setting as the current PDF protocol. Without it a long
  // instrument timed out and a clause-heavy one was cut off, and the whole file was left without any field.
  const nativeOutput=native&&!!config.v2Output;
  config=documentCloudExecutionConfig(config,v2||nativeOutput);
  if(classificationOnly)config={...config,cloud:{...config.cloud,maxOutputTokens:4096}};
  const outputIdentity=v2||nativeOutput?{version:'document-output.v1',maxOutputTokens:config.cloud.maxOutputTokens,reasoningEffort:config.cloud.reasoningEffort??null}:undefined;
  const version=native?DOCUMENT_DOCX_VERSION:v2?DOCUMENT_CLOUD_V2_VERSION:DOCUMENT_CLOUD_VERSION,promptHash=native?DOCUMENT_DOCX_PROMPT_SHA256:v2?DOCUMENT_CLOUD_V2_PROMPT_SHA256:DOCUMENT_CLOUD_PROMPT_SHA256;
  if((native?[manifest.docxExtraction]:definitions.map(field=>field.recipe)).some(recipe=>!recipe||recipe.version!==version||recipe.promptSha256!==promptHash||recipe.model!==config.cloud.model))throw new ModelExecutionError('profile_version_mismatch');
  if(native&&!run.source)throw new ModelExecutionError('capability_unsupported');
  const nerSourceSpans=(v2||native)&&config.nerSourceSpans===true;
  const recovery=await transaction(pool,async db=>{
    await fence(db);
    return (await db.query('SELECT mode FROM business.document_parse_recoveries WHERE job_id=$1 ORDER BY created_at DESC,id DESC LIMIT 1',[job.id])).rows[0] as {mode:'prepare'|'cached'}|undefined;
  });
  const cachedRecovery=recovery?.mode==='cached';
  // Source-span preparation reads role words, form boxes and the code-owned field dictionary as public (v8).
  const privacyVersion=cachedRecovery?LEGACY_FRAGMENT_PREPARE_VERSION:nerSourceSpans?PRIVACY_DOCUMENT_TERMS_VERSION:PRIVACY_PREPARE_VERSION;
  const nativeInput=native?documentDocxInput(bundle,run.source!,manifest,classificationOnly):undefined;
  const input=nativeInput??documentCloudInput(bundle,pages,manifest,classificationOnly);
  const fieldCoverageIdentity=v2?{version:'document-field-coverage.v1',requiredFieldRefs:input.fields.map(field=>field.ref)}:undefined;
  const inputHash=(contentFirst?configHash:digest)({...(run.uploadClassification?{uploadClassification:UPLOAD_CLASSIFICATION_VERSION,fieldsOnly}:{}),...(contentFirst?{classificationProtocol:CONTENT_CLASSIFICATION_SHA256,dictionaryProtocol:DOCUMENT_DICTIONARY_PROTOCOL_VERSION,classificationOnly,fixedClassification:run.fixedClassification??null}:{}),scope:bundle.scope,manifest,blocks:input.blocks,privacyVersion,...(outputIdentity?{output:outputIdentity}:{}),...(fieldCoverageIdentity?{fieldCoverage:fieldCoverageIdentity}:{})});
  const ledger=new DocumentExtractionLedger(pool,job,config,fence,signal,contentFirst?3:v2?2:1,!!recovery);
  let privacyOrdinal=0;
  const privacyOptions:PrivacyProjectionOptions={nerSourceSpans,sourceVocabulary:nerSourceSpans?'document_roles_v2':'document_roles_v1',maxPrepareRefinementPasses:8,allowGroundedOpaqueUnions:true,publicTemplateDigests:documentPublicTemplateDigests(input,{codeOwnedContent:nerSourceSpans}),ner:documentNerWithCapacity(new NerClient(config.ner)),maxSourceBytes:config.maxSourceBytes,maxCalls:config.maxPrivacyCalls,
    proposeEntities:async(blocks,localSignal,context)=>{
      const ordinal=privacyOrdinal++;
      const invoke=(parts:typeof blocks,correction:boolean,part?:number)=>ledger.run(`${recovery?'repair-v7:':''}${classificationOnly?'classify:':''}redact:${ordinal}:${part===undefined?'initial':`correction:${part}`}`,{blocks:parts,context,correction,privacyVersion,...(correction?{selection:'original-word-spans-v1'}:{})},'private',hooks=>
        proposeIntakeEntities(parts,config.local,pool,localSignal??signal,{
          dispatch:async(body,start)=>{await hooks.reserve(JSON.stringify(body));return hooks.dispatch(start);},
          onResult:receipt=>hooks.receipt(receipt.usage),
        },{trustedSourceContext:context?.filter(block=>parts.some(part=>part.id===block.id)),sourceCorrection:correction,sourceSelection:correction})).catch(error=>{
          if(error instanceof ModelExecutionError&&error.diagnostic==='qwen_busy')throw new ServiceError('qwen_busy',true,2000);
          throw error;
        });
      try{return await invoke(blocks,false);}
      catch(error){
        if(!(error instanceof ModelExecutionError))throw error;
        const sourceRejected=error.code==='invalid_output'&&['local_output_source','local_output_source_ambiguous'].includes(error.diagnostic??'');
        const truncated=error.code==='truncated'&&error.diagnostic==='qwen_truncated';
        // The local redaction model ran out of time on this passage. The ledger closes such a call only when it stayed on
        // this machine; its smaller parts are then new local calls with their own receipts.
        const timedOut=error.code==='timeout'&&error.diagnostic==='qwen_timeout';
        if(!sourceRejected&&!truncated&&!timedOut)throw error;
        // Only these failures permit one bounded split.
        // Each child has its own durable receipt; the same dispatch is never replayed.
        const parts=splitPrivacyBlocks(blocks,1000);
        if(parts.length>4)throw new ModelExecutionError('input_budget_exhausted');
        const entities=[];
        for(const [index,part] of parts.entries())entities.push(...(await invoke(part,sourceRejected,index+1)).entities);
        return {entities};
      }
    }};
  const privacy=new PrivacyProjectionService(privacyOptions);
  const previous=await transaction(pool,async db=>{
    await fence(db);
    const row=(await db.query(`SELECT input_hash,projection_hash,projection FROM ${snapshotTable} WHERE job_id=$1`,[job.id])).rows[0];
    const projection=row?PrivateIntakeProjectionSchema.parse(row.projection):null;
    if(row&&(row.input_hash!==inputHash||projection?.redactionVersion!==privacyVersion||projection.sourceManifestHash!==digest(input.blocks)||projection.scopeId!==`${bundle.scope.documentVersionId}:${bundle.scope.parseRevision}`||row.projection_hash!==configHash(projection)))throw new ModelExecutionError('execution_unknown');
    return projection;
  });
  if(cachedRecovery&&!previous)throw new ModelExecutionError('execution_unknown');
  const projection=previous??await privacy.prepare({scopeId:`${bundle.scope.documentVersionId}:${bundle.scope.parseRevision}`,blocks:input.blocks},signal).catch(error=>{
    if(error instanceof ZodError)throw new ModelExecutionError('invalid_output',false,'privacy_mask_mapping');
    throw error;
  });
  const dictionaryProtocol=contentFirst&&!cachedRecovery?documentDictionaryProtocol(input,projection,fieldsOnly):undefined;
  if(!cachedRecovery&&!dictionaryProtocol)assertDocumentDictionaryReferences(input,projection);
  if(projection.withheldSources?.length)throw new ModelExecutionError('egress_denied');
  if(!previous)await transaction(pool,async db=>{
    await fence(db);
    await db.query(`INSERT INTO ${snapshotTable}(job_id,input_hash,projection_hash,projection) VALUES($1,$2,$3,$4)`,
      [job.id,inputHash,configHash(projection),JSON.stringify(projection)]);
  });
  const evidencePackageRef=`document-projection:${inputHash}`,profileVersion=`${version}:${policy.version}`;
  const profile=ModelProfileSchema.parse({id:'document_cloud',version:profileVersion,provider:'azure-openai',locality:'cloud',model:config.cloud.model,
    allowedActualProviders:['azure-openai'],allowedActualModels:policy.actualModels,capabilities:['text','json_schema'],allowedTasks:['extract_fields'],
    adapterId:version,fallback:'disabled'});
  const protocol:DocumentCloudProtocol=classificationOnly?contentClassificationProtocol(input,projection):native?{version,schema:DOCUMENT_DOCX_SCHEMA,instructions:DOCUMENT_DOCX_INSTRUCTIONS,outputSchema:DocumentDocxOutputSchema,requiredFieldRefs:input.fields.map(f=>f.ref)}:v2?{version,schema:DOCUMENT_CLOUD_V2_SCHEMA,instructions:DOCUMENT_CLOUD_V2_INSTRUCTIONS,outputSchema:DocumentCloudV2OutputSchema,requiredFieldRefs:fieldCoverageIdentity!.requiredFieldRefs}:{...DOCUMENT_CLOUD_V1_PROTOCOL};
  if(dictionaryProtocol)protocol.instructions+=dictionaryProtocol.instructions;
  if(fieldsOnly){
    const type=input.taxonomy.find(t=>t.definition.id===fixedMaterialType(bundle))!;
    protocol.savedMaterial={typeRef:type.ref,label:type.definition.label};
    protocol.instructions=SAVED_MATERIAL_FIELD_INSTRUCTIONS+'\n'+(native?'Source units are visible Word paragraphs or table rows (cells separated by tabs), never pages.':'Source units are original document pages.')+'\n'+protocol.instructions.split('\n').slice(native?2:v2?1:2).join('\n');
    protocol.outputSchema=native?DocumentDocxFieldsOutputSchema:v2?DocumentCloudV2FieldsOutputSchema:DocumentCloudFieldsOutputSchema;
  }else if(run.fixedClassification){const type=fixedMaterialType(bundle)!;const ref=input.taxonomy.find(t=>t.definition.id===type)!.ref;protocol.instructions+='\nThe saved material type is '+ref+'. Keep that type for every source unit. This extraction cannot reclassify the file. If content conflicts, return uncertain fields; never invent values. All original units are supplied.';}
  const callSeed=(requestProtocol:DocumentCloudProtocol,extraSeed?:unknown,requestProjection=projection)=>({inputHash,projectionHash:digest(requestProjection),profile,...(outputIdentity?{output:outputIdentity}:{}),...(fieldCoverageIdentity?{fieldCoverage:{...fieldCoverageIdentity,activeFieldRefs:requestProtocol.completionTargetRefs??fieldCoverageIdentity.requiredFieldRefs}}:{}),...(extraSeed?{completion:extraSeed}:{})});
  const invoke=async(stepKey:string,requestProtocol:DocumentCloudProtocol,seed:unknown,requestProjection=projection,requestPrivacy=privacy)=>{
  const result=ModelResultSchema.parse(await ledger.run(stepKey,seed,'cloud',async hooks=>{
    if(cachedRecovery)throw new ModelExecutionError('fresh_parse_required');
    const adapter=new AzureDocumentExtractionAdapter(config.cloud,requestProjection,{caseId:job.case_id,revision:job.expected_revision,taskId:job.id,evidencePackageRef},hooks,run.fetcher,requestProtocol);
    const gateway=new ModelGateway({profiles:[profile],adapters:new Map([[version,adapter]]),outputSchemas:new Map([[requestProtocol.schema,requestProtocol.outputSchema]]),
      authorization:{
        authorize:async(identity,request)=>transaction(pool,async db=>{
          await fence(db);
          if(identity.kind!=='human'||identity.accountId!==job.account_id||identity.personId!==job.person_id||request.scopeType!=='case'||
            request.caseId!==job.case_id||request.revision!==job.expected_revision||request.taskId!==job.id||request.evidencePackageRef!==evidencePackageRef)return null;
          return {scopeType:'case',caseId:job.case_id,revision:job.expected_revision,evidencePackageRef,taskId:job.id,messageBundleRef:inputHash,
            profileId:profile.id,profileVersion:profile.version,evidenceClass:'redacted',authorizationVersion:job.auth_version};
        }),
        authorizeEgress:async()=>transaction(pool,async db=>{await fence(db);return true;}),
        authorizePayload:async(_identity,_request,_grant,_profile,payload)=>{
          await requestPrivacy.validateOutbound(payload,requestProjection,config.cloud,documentCloudBody(requestProjection,config.cloud,requestProtocol),signal,requestProtocol.schema);
          return hooks.reserve(payload.body);
        },
      }});
    const result=await gateway.generate({scopeType:'case',caseId:job.case_id,revision:job.expected_revision,evidencePackageRef,requestId:job.id,
      attemptId:randomUUID(),taskId:job.id,taskType:'extract_fields',modelProfileId:profile.id,profileVersion:profile.version,messageBundleRef:inputHash,
      outputSchemaRef:requestProtocol.schema,requiredCapabilities:['text','json_schema'],timeoutMs:v2||native?config.cloud.timeoutMs:Math.min(config.cloud.timeoutMs,120000),attempt:1,maxAttempts:1},
      {kind:'human',accountId:job.account_id,personId:job.person_id,sessionId:job.id},signal);
    if(result.status!=='completed')throw new ModelExecutionError(result.error.code,result.error.retryable,result.error.diagnostic);
    return result;
  }));
  if(result.status!=='completed'||result.scopeType!=='case'||result.caseId!==job.case_id||result.revision!==job.expected_revision||
    result.taskId!==job.id||result.evidencePackageRef!==evidencePackageRef||result.profileId!==profile.id||result.profileVersion!==profile.version||
    result.simulated||result.actualProvider!=='azure-openai'||!policy.actualModels.includes(result.actualModel))throw new ModelExecutionError('provider_drift');
  // The adapter already parses fresh v2 output with this schema. Reapply it
  // after JSONB recovery to restore that same key order before seed hashing.
  return v2||native?{...result,structured:requestProtocol.outputSchema.parse(result.structured)}:result;
  };
  const firstSeed=callSeed(protocol),result=await invoke(classificationOnly?'classify:content:v1':native?'extract:docx:v1':v2?'extract:v2':'extract',protocol,firstSeed);
  // Let pending commits and lease/authorization callbacks drain before CPU work.
  await setImmediate();signal.throwIfAborted();
  const completedResponseHashes=[digest(result.structured)];
  const checkedOutput=dictionaryProtocol?dictionaryProtocol.restoreOutput(result.structured):cachedRecovery?restoreLegacyDictionaryReferences(result.structured,input,projection):result.structured;
  let validated=nativeInput?validateDocumentDocxOutput(checkedOutput,nativeInput,projection,bundle,fieldsOnly,run.uploadClassification===true&&classificationOnly):v2?validateDocumentCloudV2Output(checkedOutput,input,projection,bundle,fieldsOnly):validateDocumentCloudOutput(checkedOutput,input,projection,bundle,fieldsOnly);
  if(classificationOnly)return {...validated,logicalDocuments:validated.logicalDocuments as DocumentBundle['logicalDocuments'],receipt:{version:CONTENT_CLASSIFICATION_VERSION,inputHash,model:result.actualModel,provider:result.actualProvider,usage:result.usage,completion:'not_needed' as const}};
  if(run.fixedClassification){assertFixedClassification(run.fixedClassification,validated.logicalDocuments);}
  let completion:'not_needed'|'completed'|'failed'|'unknown'='not_needed',completionError:string|undefined;
  let retainedUnknown:UnknownCompletionFirstPass|undefined;
  let completionUsage:typeof result.usage=null;
  let completionScope:{sourceIds:string[];reasonCodes:string[]}|undefined;
  if(v2){
    const targets=documentCompletionTargets(input,validated.fields,validated.logicalDocuments),stepKey='complete:v2';
    if(targets.length){
      let completionSeed:unknown;
      try{
        const narrowed=documentCompletionInput(input,projection,validated,targets);
        completionScope={sourceIds:narrowed.sourceIds,reasonCodes:narrowed.reasonCodes};
        const completionPrivacy=new PrivacyProjectionService({...privacyOptions,publicTemplateDigests:narrowed.publicTemplateDigests});
        const completionProtocol={...protocol,completionTargetRefs:targets};
        completionSeed=callSeed(completionProtocol,{targets,sourceIds:narrowed.sourceIds,inputHash:digest(narrowed.input.blocks),firstResultHash:digest(result.structured),version},narrowed.projection);
        const second=await invoke(stepKey,completionProtocol,completionSeed,narrowed.projection,completionPrivacy);
        completionUsage=second.usage;
        await setImmediate();signal.throwIfAborted();
        const checked=validateDocumentCloudV2Output(dictionaryProtocol?dictionaryProtocol.restoreOutput(second.structured):second.structured,narrowed.input,narrowed.projection,bundle,fieldsOnly);
        if(run.fixedClassification)assertFixedClassification(run.fixedClassification,checked.logicalDocuments);
        completedResponseHashes.push(digest(second.structured));
        validated=mergeDocumentCompletion(validated,checked,input);completion='completed';
      }catch(error){
        const retainable=error instanceof ModelExecutionError&&['invalid_output','truncated','refused','provider_rejected','budget_exhausted','input_budget_exhausted','call_budget_exhausted','daily_budget_exhausted','request_budget_exhausted','rate_limited','fresh_parse_required'].includes(error.code);
        if(error instanceof ModelExecutionError&&error.code==='execution_unknown'&&completionSeed){
          const expected={inputHash,projectionHash:configHash(projection),firstSeed,completionSeed,firstResponse:result};
          if(!await ledger.firstPassMayBeRetainedAfterUnknown(expected))throw error;
          retainedUnknown=expected;completion='unknown';
        }else{
          if(!retainable||!await ledger.completionMayBeRetained(stepKey))throw error;
          completion='failed';
        }
        completionError=(error as ModelExecutionError).code;
        validated={...validated,fields:validated.fields.map(field=>targets.some(ref=>input.fields.find(item=>item.ref===ref)?.definition.id===field.fieldId)?{
          ...field,extractionCoverage:{reviewedPageNumbers:field.extractionCoverage?.reviewedPageNumbers??[],state:'incomplete' as const,completion,
            reasonCodes:[...new Set([...(field.extractionCoverage?.reasonCodes??[]),'cloud_completion_incomplete'])]},
          coverageGaps:[...new Set([...field.coverageGaps,'cloud_completion_incomplete'])],
        }:field)};
      }
    }else validated={...validated,fields:validated.fields.map(field=>({...field,extractionCoverage:field.extractionCoverage?{...field.extractionCoverage,completion:'not_needed' as const}:undefined}))};
  }
  await setImmediate();signal.throwIfAborted();
  if(v2)validated={...validated,...recoverExplicitPartyRoles({fields:validated.fields,definitions:input.fields.map(field=>field.definition),
    logicalDocuments:validated.logicalDocuments,pages:input.pages.map(page=>page.page),anchors:validated.anchors})};
  const sourceCorrection=v2?{documentVersionId:bundle.scope.documentVersionId,parseRevision:bundle.scope.parseRevision,
    sourceSha256:bundle.scope.sourceSha256,inputSha256:inputHash,configurationSha256:configHash(manifest),responseSha256s:completedResponseHashes}:undefined;
  if(sourceCorrection)validated={...validated,...correctClauseSources({fields:validated.fields,definitions:input.fields.map(field=>field.definition),
    logicalDocuments:validated.logicalDocuments,pages:input.pages.map(page=>page.page),anchors:validated.anchors,binding:sourceCorrection})};
  await setImmediate();signal.throwIfAborted();
  const tablePartySource=sourceCorrection;
  if(tablePartySource)validated={...validated,...recoverTablePartyRoles({fields:validated.fields,definitions:input.fields.map(field=>field.definition),
    logicalDocuments:validated.logicalDocuments,pages:input.pages.map(page=>page.page),anchors:validated.anchors,binding:tablePartySource})};
  const authorizationSource=sourceCorrection?{...sourceCorrection,scopeFieldId:'authorization_scope',signingConditionsFieldId:'authorization_signing_conditions'}:undefined;
  if(authorizationSource)validated={...validated,...augmentAuthorizationSources({fields:validated.fields,definitions:input.fields.map(field=>field.definition),
    logicalDocuments:validated.logicalDocuments,pages:input.pages.map(page=>page.page),anchors:validated.anchors,binding:authorizationSource,
    targetFields:{scope:'authorization_scope',signingConditions:'authorization_signing_conditions'}})};
  const insuranceTableStructure=sourceCorrection?structureInsuranceTableRows({fields:validated.fields,definitions:input.fields.map(field=>field.definition),
    logicalDocuments:validated.logicalDocuments,pages:input.pages.map(page=>page.page),anchors:validated.anchors,binding:sourceCorrection}):undefined;
  if(insuranceTableStructure)validated={...validated,fields:insuranceTableStructure.fields,anchors:insuranceTableStructure.anchors};
  const companyNameConsistency=v2?rejectContradictedHeaderNames({fields:validated.fields,definitions:input.fields.map(field=>field.definition),
    pages:input.pages.map(page=>page.page),logicalDocuments:validated.logicalDocuments,anchors:validated.anchors}):undefined;
  if(companyNameConsistency)validated={...validated,fields:companyNameConsistency.fields,anchors:companyNameConsistency.anchors};
  if(v2)validated={...validated,...await recoverDirectorNoticeFields({fields:validated.fields,definitions:input.fields.map(field=>field.definition),
    pages:input.pages.map(page=>page.page),logicalDocuments:validated.logicalDocuments,anchors:validated.anchors,loadImage:run.loadPageImage})};
  if(v2)validated={...validated,...await recoverAnnualReturnFields({fields:validated.fields,definitions:input.fields.map(field=>field.definition),
    pages:input.pages.map(page=>page.page),logicalDocuments:validated.logicalDocuments,anchors:validated.anchors,loadImage:run.loadPageImage})};
  if(v2)validated={...validated,...recoverGuaranteeSourceFields({fields:validated.fields,definitions:input.fields.map(field=>field.definition),
    pages:input.pages.map(page=>page.page),logicalDocuments:validated.logicalDocuments,anchors:validated.anchors})};
  validated={...validated,fields:validated.fields.map(scopeCorporateArticlesQuorum)};
  if(v2)validated={...validated,...recoverRmSourceFields({fields:validated.fields,definitions:input.fields.map(field=>field.definition),
    pages:input.pages.map(page=>page.page),logicalDocuments:validated.logicalDocuments,anchors:validated.anchors})};
  // Display associations run after both call decisions; they cannot change a
  // durable completion request seed or the model's original candidates.
  const companySigningNames=v2?associateSigningSubjectNames({fields:validated.fields,definitions:input.fields.map(field=>field.definition),
    pages:input.pages.map(page=>page.page),logicalDocuments:validated.logicalDocuments,anchors:validated.anchors}):undefined;
  if(companySigningNames)validated={...validated,fields:companySigningNames.fields,anchors:companySigningNames.anchors};
  if(v2)validated={...validated,...associateBilingualNames({fields:validated.fields,definitions:input.fields.map(field=>field.definition),
    pages:input.pages.map(page=>page.page),logicalDocuments:validated.logicalDocuments,anchors:validated.anchors})};
  if(v2)validated={...validated,fields:finalizeFieldSourceCoverage({fields:validated.fields,definitions:input.fields.map(field=>field.definition),
    pages:input.pages.map(page=>page.page),logicalDocuments:validated.logicalDocuments,anchors:validated.anchors})};
  await transaction(pool,async db=>{
    await fence(db);
    if(retainedUnknown){if(!await ledger.firstPassMayBeRetainedAfterUnknown(retainedUnknown,db))throw new ModelExecutionError('execution_unknown');}
    else if(v2||native)await ledger.assertNoUnknownCalls(db);
    await audit(db,{actorId:job.account_id,targetId:job.id,action:'document.model_extraction_validated',
      details:{inputHash,cachedRecovery,model:result.actualModel,fieldCount:validated.fields.length,candidateCount:validated.fields.reduce((n,field)=>n+field.candidates.length,0)}});
  });
  return {...validated,logicalDocuments:run.fixedClassification??validated.logicalDocuments as DocumentBundle['logicalDocuments'],...(nativeInput?{sourceAnchors:(validated as ReturnType<typeof validateDocumentDocxOutput>).sourceAnchors}:{}),receipt:{version,inputHash,...(nativeInput?{sourceFingerprint:nativeInput.source.contentFingerprint,sourceUnitCount:nativeInput.units.length,sourceCoverageGaps:nativeInput.sourceGaps}:{}),model:result.actualModel,provider:result.actualProvider,usage:result.usage,
    ...(v2?{completion,completionUsage,authorizationSource,sourceCorrection,tablePartySource,insuranceTableStructure:insuranceTableStructure?.receipt,
      companySigningNames:companySigningNames?.receipt,companyNameConsistency:companyNameConsistency?.receipt,
      ...('materialCitationChecks'in validated?{materialCitationChecks:validated.materialCitationChecks}:{}),
      ...(completionScope?{completionScope}:{}),...(completionError?{completionError}:{})}:{})}};
}
