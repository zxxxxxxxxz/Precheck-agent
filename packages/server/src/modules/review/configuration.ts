import { createHash, randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { isCaseConfigurationEnabled, type CaseConfigurationOptions, type CaseReviewSelection } from '@hsbc/contracts/draft';
import { GuaranteeTypeSchema, ReviewConfigManifestSchema, isSupportedReviewRecipe, supportsContentClassification, type ReviewConfigManifest, type ReviewConfigRelease, type ReviewConfigView, type ConfigValidation } from '@hsbc/contracts/review-config';
import { DocumentEngineConfigSchema, type DocumentEngineConfig } from '@hsbc/contracts/documents';
import { AdoptGuidanceDigestSchema, COMPARISON_GUIDANCE_KINDS, DeclineGuidanceDigestSchema, GuidanceDigestBodySchema, guidanceContentKey, guidanceTextKey, type GuidanceDigestView } from '@hsbc/contracts/review-guidance';
import { DIGEST_SELECT, digestView } from './guidance-digest.js';
import { AppError } from '../../shared/errors.js';
import { audit } from '../audit/events.js';
import { hasGrant, requireGrant } from '../identity/authorization.js';
import { authorizeCase, requireCaseCreator } from '../cases/authorization.js';
import { idempotent } from '../../infrastructure/database/idempotency.js';
import { transaction, type DB } from '../../infrastructure/database/client.js';
import { type Actor } from '../identity/types.js';
import { configHash, createRulePackage, type RuleExecutor } from './opa.js';
import { validateSignatureConfiguration, runSignatureTrials } from './signature-configuration.js';

const commands=z.strictObject({expectedRevision:z.number().int().positive(),idempotencyKey:z.string().min(8).max(200)});
const createCommand=z.strictObject({manifest:ReviewConfigManifestSchema,idempotencyKey:z.string().min(8).max(200)});
const saveCommand=commands.extend({manifest:ReviewConfigManifestSchema});
const actions=['rule:read','rule:propose','rule:trial','rule:approve','rule:publish'] as const;
type DraftRow={id:string;revision:number;status:ReviewConfigView['status'];author_person_id:string;manifest:ReviewConfigManifest;manifest_hash:string;validation:ConfigValidation;trial_id:string|null;approval_id:string|null;release_id:string|null};

/** Approval replays the small deterministic signature suite against its fixed manifest. */
export function signatureTrialReceiptMatches(manifest:ReviewConfigManifest,receipt:any):boolean {
  const expected=runSignatureTrials(manifest);
  const expectedIds=new Set(expected.results.map(row=>row.ruleId));
  const results=Array.isArray(receipt?.results)?receipt.results.filter((row:any)=>expectedIds.has(row.ruleId)):[];
  return configHash(expected.receipts)===configHash(receipt?.signatureReceipts??[])&&configHash(expected.results)===configHash(results);
}

export function validateReviewConfig(raw:ReviewConfigManifest):ConfigValidation {
  const m=ReviewConfigManifestSchema.parse(raw),issues:ConfigValidation['issues']=validateSignatureConfiguration(m);
  const add=(code:string,path:string)=>issues.push({code,path});
  const v3=m.compatibility.executorVersion==='p3-deterministic-v3';
  const v2=v3||m.compatibility.executorVersion==='p3-deterministic-v2';
  if(m.compatibility.factsSchema!==(v2?'review-facts.v2':'review-facts.v1'))add('executor_facts_incompatible','compatibility');
  const unique=(values:{id:string}[],path:string)=>{const seen=new Set<string>();for(const item of values){if(seen.has(item.id))add('duplicate_id',`${path}.${item.id}`);seen.add(item.id);}};
  for(const key of ['sources','taxonomy','materials','fields','rules'] as const)unique(m[key],key);
  if(m.semanticGuidance)unique(m.semanticGuidance,'semanticGuidance');
  const sources=new Map(m.sources.map(source=>[source.id,source])),fields=new Map(m.fields.map(field=>[field.id,field]));
  const knownFact=(id:string)=>fields.has(id)||m.materials.some(material=>`material:${material.id}`===id);
  for(const type of GuaranteeTypeSchema.options)if(!m.sources.some(source=>source.guaranteeType===type))add('source_disposition_missing',`sources.${type}`);
  if(m.scope==='bank'&&!m.bankApprovalRef)add('bank_scope_unconfirmed','bankApprovalRef');
  if(new Set(m.guaranteeTypes).size!==m.guaranteeTypes.length)add('duplicate_guarantee_type','guaranteeTypes');
  const contentFirst=m.documentClassification==='content-first-v1'&&supportsContentClassification(m.guaranteeTypes);
  if(m.documentClassification&&(!contentFirst||!m.fields.some(f=>f.recipe.mode==='cloud_grounded_extract')||m.fields.some(f=>f.recipe.mode==='cloud_grounded_extract'&&f.recipe.version!=='azure-grounded-fields-v2')))add('classification_recipe_unsupported','documentClassification');
  const personalDocxScope=contentFirst||m.guaranteeTypes.includes('personal_guarantee')&&m.guaranteeTypes.every(type=>['personal_guarantee','corporate_guarantee'].includes(type));
  if(m.docxExtraction&&(!isSupportedReviewRecipe(m.docxExtraction,m.scope)||m.docxExtraction.version!=='azure-grounded-docx-v1'||!personalDocxScope||!v3))add('docx_recipe_unsupported','docxExtraction');
  for(const field of m.fields)if(field.recipe.version==='azure-grounded-docx-v1'||!isSupportedReviewRecipe(field.recipe,m.scope))add('field_recipe_unsupported',`fields.${field.id}.recipe`);
  for(const field of m.fields){
    if(field.recipe.mode==='cloud_grounded_extract'&&!field.taxonomyIds?.length)add('field_material_scope_required',`fields.${field.id}.taxonomyIds`);
    if(field.recipe.mode==='cloud_grounded_extract'&&!field.valueKind)add('field_value_kind_required',`fields.${field.id}.valueKind`);
    if(field.taxonomyIds&&(new Set(field.taxonomyIds).size!==field.taxonomyIds.length||field.taxonomyIds.some(id=>!m.taxonomy.some(type=>type.id===id))))add('field_material_scope_invalid',`fields.${field.id}.taxonomyIds`);
  }
  for(const key of ['taxonomy','materials','fields','rules','semanticGuidance'] as const)for(const item of m[key]??[])for(const ref of item.sourceIds){
    const source=sources.get(ref);
    if(!source)add('source_reference_missing',`${key}.${item.id}`);
    else if(source.disposition==='excluded'||source.disposition==='manual')add('source_not_executable',`${key}.${item.id}`);
    else if(!m.guaranteeTypes.includes(source.guaranteeType))add('guarantee_source_scope_mismatch',`${key}.${item.id}`);
    else if(m.scope==='bank'&&(source.disposition!=='confirmed'||!source.approvalRef||source.sha256==='0'.repeat(64)))add('bank_source_unconfirmed',`${key}.${item.id}`);
  }
  for(const material of m.materials){
    if(material.objectScope&&!v3)add('object_scope_version_unsupported',`materials.${material.id}`);
    if(!m.taxonomy.some(t=>t.id===material.taxonomyId))add('taxonomy_reference_missing',`materials.${material.id}`);
    if(material.applicability&&!knownFact(material.applicability.fieldId))add('condition_reference_missing',`materials.${material.id}`);
  }
  const arity={present:1,blank:1,equal:2,minimum:2,date_order:2,range_covers:4,set_covers:2,same_entity:2,currency_is:3,minimum_in_currency:4,manual_review:1,minimum_ratio:4,ltv_maximum:5,date_after:2,calendar_year_minimum:2,anniversary_notice:1};
  for(const rule of m.rules){
    const path=`rules.${rule.id}`;
    if(rule.objectScope&&!v3)add('object_scope_version_unsupported',path);
    for(const material of m.materials.filter(item=>rule.inputs.includes(`material:${item.id}`)||rule.applicability?.fieldId===`material:${item.id}`))if(material.objectScope&&configHash(material.objectScope)!==configHash(rule.objectScope??null))add('material_object_scope_mismatch',path);
    if(!v3&&(['manual_review','minimum_ratio','ltv_maximum','date_after','calendar_year_minimum','anniversary_notice'].includes(rule.operator)||rule.factor!==undefined||rule.manualReason!==undefined||rule.inputs.length>4))add('operator_version_unsupported',path);
    if(rule.manualReason!==undefined&&rule.operator!=='manual_review')add('manual_reason_unexpected',path);
    if(rule.factor!==undefined&&rule.operator!=='minimum_ratio'||rule.operator==='minimum_ratio'&&(!rule.factor||Number(rule.factor)<=0))add('ratio_factor_invalid',path);
    if(!v2&&(['same_entity','currency_is','minimum_in_currency'].includes(rule.operator)||rule.currency))add('operator_version_unsupported',path);
    if(rule.inputs.length!==arity[rule.operator])add('rule_arity_invalid',path);
    for(const input of rule.inputs)if(!knownFact(input))add('field_reference_missing',path);
    if(rule.applicability&&!knownFact(rule.applicability.fieldId))add('condition_reference_missing',path);
    if(!rule.sourceDirectionConfirmed)add('rule_direction_unconfirmed',path);
    for(const required of rule.requiredParameters)if(m.parameters[required]===null||m.parameters[required]===undefined)add('parameter_missing',`${path}.${required}`);
    const definitions=rule.inputs.map(input=>fields.get(input));
    if(['minimum_ratio','ltv_maximum'].includes(rule.operator)){
      if(definitions.slice(0,2).some(field=>field?.type!=='amount'||field.unit!=='currency')||definitions.slice(2,4).some(field=>field?.type!=='currency'))add('currency_amount_fields_required',path);
      if(definitions[0]?.objectKind!==definitions[2]?.objectKind||definitions[1]?.objectKind!==definitions[3]?.objectKind||definitions[0]?.objectRole!==definitions[2]?.objectRole||definitions[1]?.objectRole!==definitions[3]?.objectRole)add('currency_object_scope_mismatch',path);
      if(rule.operator==='ltv_maximum'&&(definitions[4]?.type!=='amount'||definitions[4]?.unit!=='percent'))add('ltv_threshold_invalid',path);
    }
    if(['date_after','calendar_year_minimum','anniversary_notice'].includes(rule.operator)&&definitions.some(field=>field?.type!=='date'))add('date_fields_required',path);
    if(rule.operator==='same_entity'&&definitions.some(field=>field?.objectKind!=='party'||field.type!=='text'))add('identity_party_fields_required',path);
    if(['currency_is','minimum_in_currency'].includes(rule.operator)&&!rule.currency)add('rule_currency_required',path);
    if(rule.currency&&!['currency_is','minimum_in_currency'].includes(rule.operator))add('rule_currency_unexpected',path);
    if(rule.operator==='currency_is'&&definitions.some(field=>field?.type!=='currency'))add('currency_fields_required',path);
    if(rule.operator==='minimum_in_currency'){
      if(definitions.slice(0,2).some(field=>field?.type!=='amount')||definitions.slice(2).some(field=>field?.type!=='currency'))add('currency_amount_fields_required',path);
      if(definitions.slice(0,2).some(field=>!field?.unit||field.currency!==rule.currency)||new Set(definitions.slice(0,2).map(field=>field?.unit)).size!==1)add('unit_or_currency_incompatible',path);
      if(definitions[0]?.objectKind!==definitions[2]?.objectKind||definitions[1]?.objectKind!==definitions[3]?.objectKind||definitions[0]?.objectRole!==definitions[2]?.objectRole||definitions[1]?.objectRole!==definitions[3]?.objectRole)add('currency_object_scope_mismatch',path);
    }
    if(['minimum','range_covers','date_order','equal','set_covers'].includes(rule.operator)){
      if(definitions.some(field=>!field)||new Set(definitions.map(field=>field?.type)).size!==1)add('field_type_incompatible',path);
      if(rule.operator==='minimum'&&definitions.some(field=>field?.type!=='amount'))add('numeric_fields_required',path);
      if(rule.operator==='date_order'&&definitions.some(field=>field?.type!=='date'))add('date_fields_required',path);
      if(rule.operator==='set_covers'&&definitions.some(field=>field?.type!=='text'))add('set_text_fields_required',path);
      if(rule.operator==='range_covers'&&definitions.some(field=>!field||!['amount','date'].includes(field.type)))add('range_fields_required',path);
      const personCounts=v3&&rule.operator==='minimum'&&definitions.every(field=>field?.type==='amount'&&field.unit==='persons'&&field.currency===null);
      if(!personCounts&&definitions.some(field=>field?.type==='amount')&&(definitions.some(field=>!field?.unit||!field.currency)||new Set(definitions.map(field=>`${field?.unit}:${field?.currency}`)).size!==1))add('unit_or_currency_incompatible',path);
    }
    unique(rule.tests,`${path}.tests`);
    for(const kind of ['normal','abnormal','boundary','missing_input'])if(!rule.tests.some(test=>test.kind===kind))add('rule_test_kind_missing',`${path}.${kind}`);
    for(const test of rule.tests){
      if(rule.operator==='manual_review'?test.expected!=='blocked':rule.operator==='anniversary_notice'?(!['pass','blocked'].includes(test.expected)||test.kind==='missing_input'&&test.expected!=='blocked'):test.kind==='normal'&&test.expected!=='pass'||test.kind==='abnormal'&&test.expected!=='fail'||test.kind==='missing_input'&&!['blocked','fail'].includes(test.expected))add('rule_test_expectation_invalid',`${path}.tests.${test.id}`);
      for(const key of Object.keys(test.facts))if(!knownFact(key))add('test_fact_unknown',`${path}.tests.${test.id}`);
    }
  }
  // Semantic wording informs comparison only. It may not reach exact values or identifiers.
  for(const entry of m.semanticGuidance??[]){
    const path=`semanticGuidance.${entry.id}`,targets=entry.fieldIds.map(id=>fields.get(id));
    if(targets.some(field=>!field))add('guidance_field_unknown',path);
    if(new Set(entry.fieldIds).size!==entry.fieldIds.length||new Set(entry.expressions.map(guidanceTextKey)).size!==entry.expressions.length)add('guidance_duplicate_scope',path);
    if(COMPARISON_GUIDANCE_KINDS.includes(entry.kind)&&targets.some(field=>field&&(field.type!=='text'||field.valueKind==='identifier')))add('guidance_exact_field',path);
    if(entry.kind==='name_equivalence'&&entry.expressions.length<2)add('guidance_expressions_required',path);
    if(entry.kind==='wording_tolerance'&&!entry.fieldIds.length&&!entry.expressions.length||entry.kind==='focus_note'&&!entry.fieldIds.length)add('guidance_scope_required',path);
  }
  if(m.semanticGuidance&&new Set(m.semanticGuidance.map(guidanceContentKey)).size!==m.semanticGuidance.length)add('guidance_duplicate_content','semanticGuidance');
  // A material condition and its dedicated presence rule must agree.
  for(const material of m.materials)for(const rule of m.rules.filter(rule=>rule.inputs.includes(`material:${material.id}`)))if(configHash(material.applicability??null)!==configHash(rule.applicability??null))add('applicability_conflict',`materials.${material.id}`);
  return {valid:issues.length===0,issues};
}
export function documentConfigurationFor(manifest:ReviewConfigManifest):DocumentEngineConfig {
  const cloud=manifest.fields.some(field=>field.recipe.mode==='cloud_grounded_extract');
  return DocumentEngineConfigSchema.parse({...(manifest.documentClassification?{classificationMode:manifest.documentClassification}:{}),version:manifest.releaseId,taxonomyVersion:`${manifest.releaseId}.taxonomy`,fieldDictionaryVersion:`${manifest.releaseId}.fields`,
    taxonomy:manifest.taxonomy.map(({id,label,keywords})=>({id,label,keywords})),fields:manifest.fields.map(({id,label,aliases,type,recipe})=>({id,label,aliases,type,...(recipe.mode==='cloud_grounded_extract'?{candidateExtraction:'cloud' as const}:(cloud||manifest.guaranteeTypes.includes('personal_guarantee'))&&recipe.mode==='manual'?{candidateExtraction:'manual' as const}:{})}))});
}
export async function getPublished(db:DB,releaseId:string):Promise<ReviewConfigRelease> {
  const row=(await db.query('SELECT * FROM business.review_config_releases WHERE release_id=$1',[releaseId])).rows[0];
  if(!row)throw new AppError(409,'review_config_not_published');
  const manifest=ReviewConfigManifestSchema.parse(row.manifest),built=createRulePackage(manifest);
  if(!validateReviewConfig(manifest).valid||configHash(manifest)!==row.manifest_hash||manifest.releaseId!==releaseId||built.packageHash!==row.package_hash||built.policySha256!==row.policy_sha256||built.source!==row.policy_source||configHash(row.publication_receipt)!==row.publication_hash||row.publication_receipt.releaseId!==releaseId||row.publication_receipt.packageHash!==built.packageHash||row.publication_receipt.executorVersion!==manifest.compatibility.executorVersion)throw new AppError(409,'review_config_integrity_failed');
  return {releaseId,status:'published',manifest,manifestHash:row.manifest_hash,packageHash:row.package_hash,policySha256:row.policy_sha256,
    documentConfigurationId:row.document_configuration_id,trialHash:row.trial_hash,approvalHash:row.approval_hash,publishedAt:new Date(row.published_at).toISOString()};
}
export async function listPublished(db:DB){
  const rows=(await db.query('SELECT release_id FROM business.review_config_releases ORDER BY published_at DESC,release_id LIMIT 200')).rows;
  const result=[];for(const row of rows){const release=await getPublished(db,row.release_id);result.push({releaseId:release.releaseId,label:release.manifest.label,scope:release.manifest.scope,guaranteeTypes:release.manifest.guaranteeTypes,manifestHash:release.manifestHash});}return result;
}
export async function getDocumentConfiguration(db:DB,releaseId:string):Promise<DocumentEngineConfig>{
  const release=await getPublished(db,releaseId),expected=documentConfigurationFor(release.manifest);
  const row=(await db.query('SELECT manifest,sha256 FROM business.document_configurations WHERE id=$1',[release.documentConfigurationId])).rows[0];
  if(!row)throw new AppError(409,'configuration_not_found');
  const config=DocumentEngineConfigSchema.parse(row.manifest),hash=createHash('sha256').update(JSON.stringify(config)).digest('hex');
  if(row.sha256!==hash||configHash(config)!==configHash(expected))throw new AppError(409,'configuration_hash_mismatch');return config;
}

/** Creation may reuse published releases without granting rule-authoring or approval rights. */
export async function caseConfigurationOptions(db:DB,actor:Actor):Promise<CaseConfigurationOptions> {
  await requireCaseCreator(db,actor);
  if(!await hasGrant(db,actor.personId,'case:configure'))return {canSelect:false,reason:'permission_required',items:[]};
  const rows=(await db.query("SELECT release_id FROM business.review_config_releases WHERE manifest->>'scenario'='overseas_loan' ORDER BY published_at DESC,release_id")).rows;
  const items:CaseConfigurationOptions['items']=[];
  for(const row of rows){
    const release=await getPublished(db,row.release_id);
    if(!isCaseConfigurationEnabled(release.manifest.guaranteeTypes))continue;
    items.push({releaseId:release.releaseId,label:release.manifest.label,scope:release.manifest.scope,
      guaranteeTypes:release.manifest.guaranteeTypes,publishedAt:release.publishedAt,requiresProcessing:release.manifest.fields.some(field=>field.recipe.mode==='cloud_grounded_extract'),
      materials:release.manifest.materials.map(material=>({id:material.id,label:material.label,
        ...(material.objectScope?{objectRole:material.objectScope.role}:{}),required:material.required,conditional:!!material.applicability}))});
  }
  return {canSelect:true,items};
}

/** Called on the creation transaction, after its first round and before attachment adoption. */
export async function initializeCaseConfiguration(db:DB,actor:Actor,caseId:string,selection:CaseReviewSelection):Promise<void> {
  const c=await authorizeCase(db,actor,caseId,'case:configure');
  const release=await getPublished(db,selection.releaseId),manifest=release.manifest;
  if(manifest.scenario!==c.scenario||manifest.scope!==selection.scope)throw new AppError(422,'review_configuration_scenario_mismatch');
  if([...manifest.guaranteeTypes].sort().join()!==[...selection.guaranteeTypes].sort().join())throw new AppError(422,'review_guarantee_types_mismatch');
  if(!isCaseConfigurationEnabled(manifest.guaranteeTypes))throw new AppError(409,'review_config_not_published');
  await getDocumentConfiguration(db,release.releaseId);
  if(c.configuration_release_id||c.revision!==1)throw new AppError(409,'review_configuration_already_initialized');
  await db.query('UPDATE business.cases SET configuration_release_id=$2 WHERE id=$1',[caseId,release.releaseId]);
  if(c.current_round_id)await db.query('UPDATE business.review_rounds SET configuration_release_id=$2 WHERE id=$1',[c.current_round_id,release.releaseId]);
  const details={releaseId:release.releaseId,manifestHash:release.manifestHash,reason:'建案时使用已发布配置'};
  await db.query('INSERT INTO business.review_events(id,case_id,round_id,case_revision,kind,actor_person_id,account_id,details) VALUES($1,$2,$3,$4,$5,$6,$7,$8)',
    [randomUUID(),caseId,c.current_round_id??null,c.revision,'configuration_bound',actor.personId,actor.accountId,JSON.stringify(details)]);
  await audit(db,{actorId:actor.accountId,targetId:caseId,action:'review.configuration_bound',details});
}

export class ReviewConfigService {
  constructor(readonly pool:Pool,readonly executor:RuleExecutor){}
  getPublished=getPublished;
  getDocumentConfiguration=getDocumentConfiguration;
  listPublished=listPublished;
  private async row(db:DB,id:string,lock=true):Promise<DraftRow>{
    const row=(await db.query(`SELECT * FROM business.review_config_drafts WHERE id=$1 ${lock?'FOR UPDATE':''}`,[id])).rows[0];
    if(!row)throw new AppError(404,'review_config_not_found');
    row.manifest=ReviewConfigManifestSchema.parse(row.manifest);
    if(configHash(row.manifest)!==row.manifest_hash)throw new AppError(409,'review_config_integrity_failed');return row;
  }
  private check(row:DraftRow,revision:number){if(row.revision!==revision)throw new AppError(409,'stale_revision');}
  private async view(db:DB,actor:Actor,row:DraftRow):Promise<ReviewConfigView>{
    const trial=row.trial_id?(await db.query('SELECT passed,receipt,receipt_hash FROM business.review_config_trials WHERE id=$1',[row.trial_id])).rows[0]:null;
    const approval=row.approval_id?(await db.query('SELECT person_id,approval_hash FROM business.review_config_approvals WHERE id=$1',[row.approval_id])).rows[0]:null;
    const contributor=Boolean((await db.query('SELECT 1 FROM business.review_config_revisions WHERE draft_id=$1 AND editor_person_id=$2 LIMIT 1',[row.id,actor.personId])).rowCount);
    const allowed:string[]=[];
    for(const action of actions)if(await hasGrant(db,actor.personId,action)){
      if(action==='rule:read'||row.status!=='published'&&(action==='rule:propose'||action==='rule:trial'&&row.validation.valid||action==='rule:approve'&&row.status==='trial_passed'&&!contributor||action==='rule:publish'&&row.status==='approved'))allowed.push(action);
    }
    return {id:row.id,revision:row.revision,status:row.status,authorPersonId:row.author_person_id,manifestHash:row.manifest_hash,manifest:row.manifest,validation:row.validation,
      trial:trial?{passed:trial.passed,receiptHash:trial.receipt_hash,results:trial.receipt.results}:null,approval:approval?{personId:approval.person_id,hash:approval.approval_hash}:null,releaseId:row.release_id,allowed_actions:allowed};
  }
  async list(actor:Actor){return transaction(this.pool,async db=>{await requireGrant(db,actor,'rule:read');const rows=(await db.query('SELECT id FROM business.review_config_drafts ORDER BY updated_at DESC LIMIT 200')).rows;const items=[];for(const row of rows)items.push(await this.view(db,actor,await this.row(db,row.id,false)));return {items,allowed_actions:await this.allowed(db,actor)};});}
  private async allowed(db:DB,actor:Actor){const result:string[]=[];for(const action of actions)if(await hasGrant(db,actor.personId,action))result.push(action);return result;}
  async get(actor:Actor,id:string){return transaction(this.pool,async db=>{await requireGrant(db,actor,'rule:read');return this.view(db,actor,await this.row(db,id,false));});}
  async create(actor:Actor,raw:unknown){const input=createCommand.parse(raw);return transaction(this.pool,async db=>{
    await requireGrant(db,actor,'rule:propose');
    const receipt=await idempotent(db,actor,'review_config.create',input.idempotencyKey,input,async()=>{
      const id=randomUUID(),hash=configHash(input.manifest),validation=validateReviewConfig(input.manifest);
      await db.query('INSERT INTO business.review_config_drafts(id,author_person_id,manifest,manifest_hash,validation) VALUES($1,$2,$3,$4,$5)',[id,actor.personId,JSON.stringify(input.manifest),hash,JSON.stringify(validation)]);
      await db.query('INSERT INTO business.review_config_revisions(draft_id,revision,editor_person_id,manifest,manifest_hash) VALUES($1,1,$2,$3,$4)',[id,actor.personId,JSON.stringify(input.manifest),hash]);
      await audit(db,{actorId:actor.accountId,targetId:id,action:'review_config.created',details:{manifestHash:hash,scope:input.manifest.scope}});return {id};
    });return this.view(db,actor,await this.row(db,receipt.id));
  });}
  async save(actor:Actor,id:string,raw:unknown){const input=saveCommand.parse(raw);return transaction(this.pool,async db=>{
    await requireGrant(db,actor,'rule:propose');const row=await this.row(db,id);
    await idempotent(db,actor,`review_config.save:${id}`,input.idempotencyKey,input,async()=>{
      this.check(row,input.expectedRevision);if(row.status==='published')throw new AppError(409,'review_config_immutable');
      const hash=configHash(input.manifest),validation=validateReviewConfig(input.manifest);
      await db.query('INSERT INTO business.review_config_revisions(draft_id,revision,editor_person_id,manifest,manifest_hash) VALUES($1,$2,$3,$4,$5)',[id,row.revision+1,actor.personId,JSON.stringify(input.manifest),hash]);
      await db.query("UPDATE business.review_config_drafts SET revision=revision+1,status='draft',manifest=$2,manifest_hash=$3,validation=$4,trial_id=NULL,approval_id=NULL,updated_at=now() WHERE id=$1",[id,JSON.stringify(input.manifest),hash,JSON.stringify(validation)]);
      await audit(db,{actorId:actor.accountId,targetId:id,action:'review_config.revised',details:{revision:row.revision+1,manifestHash:hash}});return {id};
    });return this.view(db,actor,await this.row(db,id));
  });}
  async validate(actor:Actor,id:string,raw:unknown){const input=commands.parse(raw);return transaction(this.pool,async db=>{
    await requireGrant(db,actor,'rule:propose');const row=await this.row(db,id);
    await idempotent(db,actor,`review_config.validate:${id}`,input.idempotencyKey,input,async()=>{
      this.check(row,input.expectedRevision);const validation=validateReviewConfig(row.manifest);
      if(row.status!=='published')await db.query("UPDATE business.review_config_drafts SET validation=$2,status=CASE WHEN status='draft' AND $3 THEN 'validated' ELSE status END,updated_at=now() WHERE id=$1",[id,JSON.stringify(validation),validation.valid]);
      await audit(db,{actorId:actor.accountId,targetId:id,action:'review_config.validated',details:{valid:validation.valid,count:validation.issues.length}});return {id};
    });return this.view(db,actor,await this.row(db,id));
  });}
  async trial(actor:Actor,id:string,raw:unknown){
    const input=commands.parse(raw);
    const prepared=await transaction(this.pool,async db=>{await requireGrant(db,actor,'rule:trial');const row=await this.row(db,id);this.check(row,input.expectedRevision);
      if(row.status==='published')throw new AppError(409,'review_config_immutable');
      if(!validateReviewConfig(row.manifest).valid)throw new AppError(422,'review_config_invalid');
      const previous=(await db.query('SELECT input_hash,result FROM business.command_receipts WHERE receipt_key=$1',[`${actor.accountId}:review_config.trial:${id}:${input.idempotencyKey}`])).rows[0];
      if(previous){if(previous.input_hash!==createHash('sha256').update(JSON.stringify(input)).digest('hex'))throw new AppError(409,'idempotency_conflict');return {row,replayed:true};}return {row,replayed:false};});
    if(prepared.replayed)return this.get(actor,id);
    const row=prepared.row,trial=await this.trialRecord(row,()=>transaction(this.pool,async db=>{await requireGrant(db,actor,'rule:trial');const current=await this.row(db,id);this.check(current,input.expectedRevision);if(current.status==='published')throw new AppError(409,'review_config_immutable');}));
    return transaction(this.pool,async db=>{await requireGrant(db,actor,'rule:trial');const current=await this.row(db,id);this.check(current,input.expectedRevision);
      await idempotent(db,actor,`review_config.trial:${id}`,input.idempotencyKey,input,async()=>{
        if(current.status==='published')throw new AppError(409,'review_config_immutable');
        await this.saveTrial(db,actor,row,trial);return {id};
      });return this.view(db,actor,await this.row(db,id));});
  }
  /** Runs every rule fixture against the exact built package; `between` re-checks the caller's fence. */
  private async trialRecord(row:DraftRow,between:()=>Promise<void>){
    const built=createRulePackage(row.manifest),release={...built,manifest:row.manifest},results:NonNullable<ReviewConfigView['trial']>['results']=[],receipts=[];
    const fixtures=row.manifest.rules.flatMap(rule=>rule.tests.map(test=>({rule,test})));
    const batched=this.executor.evaluateBatch?await this.executor.evaluateBatch(release,fixtures.map(({rule,test})=>({facts:test.facts,ruleIds:[rule.id]}))):null;
    for(const [index,{rule,test}] of fixtures.entries()){
      await between();
      const receipt=batched?.[index]??await this.executor.evaluate(release,test.facts,undefined,[rule.id]);
      if(receipt.releaseId!==row.manifest.releaseId||receipt.packageHash!==built.packageHash||receipt.executorVersion!==row.manifest.compatibility.executorVersion||receipt.results.length!==1||receipt.results[0]?.ruleId!==rule.id)throw new AppError(409,'review_config_trial_invalid');
      const actual=receipt.results.find(result=>result.ruleId===rule.id)!.outcome;
      results.push({ruleId:rule.id,testId:test.id,expected:test.expected,actual,passed:actual===test.expected});receipts.push(receipt);
    }
    const signatureTrial=runSignatureTrials(row.manifest);results.push(...signatureTrial.results);
    const passed=results.length>0&&results.every(result=>result.passed),record={manifestHash:row.manifest_hash,packageHash:built.packageHash,policySha256:built.policySha256,results,receipts,...(signatureTrial.receipts.length?{signatureReceipts:signatureTrial.receipts}:{})},receiptHash=configHash(record);
    return {built,passed,record,receiptHash};
  }
  private async saveTrial(db:DB,actor:Actor,row:DraftRow,trial:Awaited<ReturnType<ReviewConfigService['trialRecord']>>){
    const trialId=randomUUID();await db.query('INSERT INTO business.review_config_trials(id,draft_id,draft_revision,manifest_hash,package_hash,policy_sha256,passed,receipt,receipt_hash,actor_person_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)',[trialId,row.id,row.revision,row.manifest_hash,trial.built.packageHash,trial.built.policySha256,trial.passed,JSON.stringify(trial.record),trial.receiptHash,actor.personId]);
    await db.query("UPDATE business.review_config_drafts SET status=$2,trial_id=$3,approval_id=NULL,updated_at=now() WHERE id=$1",[row.id,trial.passed?'trial_passed':'validated',trialId]);
    await audit(db,{actorId:actor.accountId,targetId:row.id,action:'review_config.trial_completed',details:{passed:trial.passed,receiptHash:trial.receiptHash}});
  }
  async approve(actor:Actor,id:string,raw:unknown){const input=commands.parse(raw);return transaction(this.pool,async db=>{
    await requireGrant(db,actor,'rule:approve');const row=await this.row(db,id);
    await idempotent(db,actor,`review_config.approve:${id}`,input.idempotencyKey,input,async()=>{
      this.check(row,input.expectedRevision);
      if(row.author_person_id===actor.personId||(await db.query('SELECT 1 FROM business.review_config_revisions WHERE draft_id=$1 AND editor_person_id=$2',[id,actor.personId])).rowCount)throw new AppError(403,'review_config_self_approval');
      if(row.status==='approved')return {id};
      await this.approveRow(db,actor,row);return {id};
    });return this.view(db,actor,await this.row(db,id));
  });}
  /** Shared approval write. Author separation is checked by callers; digest adoption documents its exception. */
  private async approveRow(db:DB,actor:Actor,row:DraftRow){
    if(row.status!=='trial_passed'||!row.trial_id||!validateReviewConfig(row.manifest).valid)throw new AppError(409,'review_config_trial_required');
    const trial=(await db.query('SELECT * FROM business.review_config_trials WHERE id=$1',[row.trial_id])).rows[0];
    if(!trial?.passed||!signatureTrialReceiptMatches(row.manifest,trial.receipt)||trial.manifest_hash!==row.manifest_hash||trial.draft_revision!==row.revision||configHash(trial.receipt)!==trial.receipt_hash||!trial.receipt.receipts?.every((receipt:any)=>receipt.releaseId===row.manifest.releaseId&&receipt.packageHash===trial.package_hash&&receipt.executorVersion===row.manifest.compatibility.executorVersion))throw new AppError(409,'review_config_trial_invalid');
    const approvalId=randomUUID(),approvalHash=configHash({draftId:row.id,revision:row.revision,manifestHash:row.manifest_hash,trialHash:trial.receipt_hash,personId:actor.personId});
    await db.query('INSERT INTO business.review_config_approvals(id,draft_id,draft_revision,person_id,manifest_hash,trial_id,approval_hash) VALUES($1,$2,$3,$4,$5,$6,$7)',[approvalId,row.id,row.revision,actor.personId,row.manifest_hash,row.trial_id,approvalHash]);
    await db.query("UPDATE business.review_config_drafts SET status='approved',approval_id=$2,updated_at=now() WHERE id=$1",[row.id,approvalId]);
    await audit(db,{actorId:actor.accountId,targetId:row.id,action:'review_config.approved',details:{approvalHash}});
  }
  async publish(actor:Actor,id:string,raw:unknown){const input=commands.parse(raw);
    const prepared=await transaction(this.pool,async db=>{await requireGrant(db,actor,'rule:publish');const row=await this.row(db,id);this.check(row,input.expectedRevision);if(!['approved','published'].includes(row.status))throw new AppError(409,'review_config_approval_required');return row;});
    const builtPackage=createRulePackage(prepared.manifest);
    // Reconfirm the actual loaded package after approval. An old successful trial
    // cannot publish a package that was removed or replaced in the meantime.
    const publicationReceipt=prepared.status==='published'?null:await this.executor.evaluate({...builtPackage,manifest:prepared.manifest},prepared.manifest.rules[0]!.tests[0]!.facts);
    return transaction(this.pool,async db=>{
    await requireGrant(db,actor,'rule:publish');const row=await this.row(db,id);
    await idempotent(db,actor,`review_config.publish:${id}`,input.idempotencyKey,input,async()=>{
      this.check(row,input.expectedRevision);if(row.status==='published')return {id};
      await this.publishRow(db,actor,row,publicationReceipt);return {id};
    });return this.view(db,actor,await this.row(db,id));
  });}
  // ---- Case guidance digests -------------------------------------------------
  /** The person who submitted a digest is its draft author and can never approve it. */
  private async digestActions(db:DB,actor:Actor,row:{state:string;person_id:string}){
    const approve=await hasGrant(db,actor.personId,'rule:approve'),publish=await hasGrant(db,actor.personId,'rule:publish'),own=row.person_id===actor.personId;
    return row.state==='ready'&&!own?[...(approve&&publish?['adopt']:[]),...(approve?['decline']:[])]:[];
  }
  async listGuidanceDigests(actor:Actor):Promise<{items:GuidanceDigestView[]}>{return transaction(this.pool,async db=>{
    await requireGrant(db,actor,'rule:read');
    const rows=(await db.query(`${DIGEST_SELECT} ORDER BY CASE WHEN d.state='ready' THEN 0 ELSE 1 END,d.created_at DESC LIMIT 100`)).rows;
    const items=[];for(const r of rows)items.push(digestView(r,await this.digestActions(db,actor,r)));return {items};
  });}
  /** Follows releases created from earlier digests so adoption builds on the newest successor. */
  private async latestSuccessor(db:DB,releaseId:string){
    let current=releaseId;
    for(let n=0;n<50;n++){
      const next=(await db.query('SELECT r.release_id FROM business.review_config_releases r JOIN business.review_config_drafts d ON d.id=r.draft_id WHERE d.based_on_release_id=$1 ORDER BY r.published_at DESC LIMIT 1',[current])).rows[0];
      if(!next)break;current=next.release_id;
    }
    return getPublished(db,current);
  }
  private async adoptionStep(digestId:string,patch:Record<string,unknown>){
    await this.pool.query("UPDATE business.review_guidance_digests SET adoption=coalesce(adoption,'{}'::jsonb)||$2::jsonb,updated_at=now() WHERE id=$1",[digestId,JSON.stringify(patch)]);
  }
  /**
   * One action by a person holding both approval and publication grants: build a successor
   * configuration with the selected case rules, then validate, trial, approve and publish it.
   * The draft is authored by the person who submitted the digest; that person can never adopt it,
   * so author/approver separation holds exactly as for manual drafts.
   * Each completed step is recorded, so a repeated request resumes instead of duplicating.
   */
  async adoptGuidanceDigest(actor:Actor,digestId:string,raw:unknown):Promise<GuidanceDigestView>{
    const input=AdoptGuidanceDigestSchema.parse(raw),requestHash=configHash({guidanceIds:[...input.guidanceIds].sort(),statements:input.statements,label:input.label??null});
    const staged=await transaction(this.pool,async db=>{
      await requireGrant(db,actor,'rule:approve');await requireGrant(db,actor,'rule:publish');
      const d=(await db.query('SELECT * FROM business.review_guidance_digests WHERE id=$1 FOR UPDATE',[digestId])).rows[0];
      if(!d)throw new AppError(404,'guidance_digest_not_found');
      if(d.state==='adopted')return {done:true as const};
      if(d.person_id===actor.personId)throw new AppError(403,'review_config_self_approval');
      if(d.state!=='ready')throw new AppError(409,'guidance_digest_not_ready');
      if(configHash(d.body)!==d.body_hash)throw new AppError(409,'guidance_digest_integrity_failed');
      if(d.adoption?.draftId){if(d.adoption.requestHash!==requestHash)throw new AppError(409,'guidance_digest_adoption_in_progress');return {done:false as const,draftId:d.adoption.draftId as string};}
      const body=GuidanceDigestBodySchema.parse(d.body),entries=input.guidanceIds.map(id=>body.entries.find(e=>e.guidanceId===id));
      if(entries.some(e=>!e)||new Set(input.guidanceIds).size!==input.guidanceIds.length)throw new AppError(422,'guidance_digest_entry_unknown');
      if(Object.keys(input.statements).some(id=>!input.guidanceIds.includes(id)))throw new AppError(422,'guidance_digest_entry_unknown');
      const base=await this.latestSuccessor(db,d.base_release_id),c=(await db.query('SELECT case_number FROM business.cases WHERE id=$1',[d.case_id])).rows[0];
      const manifest=structuredClone(base.manifest) as ReviewConfigManifest,root=base.releaseId.replace(/_gd\d+$/,'').slice(0,56);
      let n=Number(/_gd(\d+)$/.exec(base.releaseId)?.[1]??0)+1,releaseId=`${root}_gd${n}`;
      while((await db.query("SELECT 1 FROM business.review_config_releases WHERE release_id=$1 UNION ALL SELECT 1 FROM business.review_config_drafts WHERE manifest->>'releaseId'=$1",[releaseId])).rowCount)releaseId=`${root}_gd${++n}`;
      manifest.releaseId=releaseId;manifest.label=input.label??`${base.manifest.label.replace(/ · 案件口径 v\d+$/,'').slice(0,180)} · 案件口径 v${n}`;
      const sourceId=`case_guidance_${digestId.slice(0,8)}`;
      manifest.sources.push({id:sourceId,reference:`案件 ${c?.case_number??d.case_id} 口径整理 ${digestId}`,sha256:d.body_hash,guaranteeType:manifest.guaranteeTypes[0]!,disposition:'confirmed',
        reason:'规则审批人采纳的案件判断口径；仅用于语义核对与法律意见书提示，不改变确定性规则。',approvalRef:`guidance-digest:${digestId}`});
      const ids=new Set((manifest.semanticGuidance??[]).map(e=>e.id));
      const added=entries.map(e=>{let id=`g_${e!.guidanceId.replaceAll('-','').slice(0,12)}`;while(ids.has(id))id=`${id}_x`;ids.add(id);
        return {id,...e!.body,statement:input.statements[e!.guidanceId]??e!.suggestedStatement,sourceIds:[sourceId],origin:{caseId:d.case_id,guidanceId:e!.guidanceId,digestId}};});
      manifest.semanticGuidance=[...(manifest.semanticGuidance??[]),...added];
      const parsed=ReviewConfigManifestSchema.parse(manifest),validation=validateReviewConfig(parsed);
      if(!validation.valid)throw new AppError(422,'guidance_digest_config_invalid');
      const id=randomUUID(),hash=configHash(parsed);
      // Content comes from the submitter's case rules; the adopter only selects and approves it.
      await db.query("INSERT INTO business.review_config_drafts(id,author_person_id,manifest,manifest_hash,validation,status,origin,origin_ref,based_on_release_id) VALUES($1,$2,$3,$4,$5,'validated','guidance_digest',$6,$7)",[id,d.person_id,JSON.stringify(parsed),hash,JSON.stringify(validation),digestId,base.releaseId]);
      await db.query('INSERT INTO business.review_config_revisions(draft_id,revision,editor_person_id,manifest,manifest_hash) VALUES($1,1,$2,$3,$4)',[id,d.person_id,JSON.stringify(parsed),hash]);
      await db.query("UPDATE business.review_guidance_digests SET adoption=$2,updated_at=now() WHERE id=$1",[digestId,JSON.stringify({requestHash,draftId:id,releaseId,baseReleaseId:base.releaseId,step:'drafted',errorCode:null,entryIds:added.map(e=>e.id)})]);
      await audit(db,{actorId:actor.accountId,targetId:id,action:'review_config.created_from_guidance',details:{digestId,baseReleaseId:base.releaseId,releaseId,entryCount:added.length}});
      return {done:false as const,draftId:id};
    });
    if(!staged.done){
      const draftId=staged.draftId;
      try{
        let row=await transaction(this.pool,db=>this.row(db,draftId,false));
        if(row.status==='validated'){
          const trial=await this.trialRecord(row,async()=>{});
          await transaction(this.pool,async db=>{const current=await this.row(db,draftId);if(current.revision!==row.revision||current.status!=='validated')throw new AppError(409,'stale_revision');await this.saveTrial(db,actor,current,trial);});
          if(!trial.passed)throw new AppError(409,'review_config_trial_failed');
          await this.adoptionStep(digestId,{step:'trial_passed',errorCode:null});
          row=await transaction(this.pool,db=>this.row(db,draftId,false));
        }
        if(row.status==='trial_passed'){
          await transaction(this.pool,async db=>{await requireGrant(db,actor,'rule:approve');
            if((await db.query('SELECT 1 FROM business.review_config_revisions WHERE draft_id=$1 AND editor_person_id=$2',[draftId,actor.personId])).rowCount)throw new AppError(403,'review_config_self_approval');
            await this.approveRow(db,actor,await this.row(db,draftId));});
          await this.adoptionStep(digestId,{step:'approved',errorCode:null});
          row=await transaction(this.pool,db=>this.row(db,draftId,false));
        }
        if(row.status==='approved'){
          const built=createRulePackage(row.manifest),receipt=await this.executor.evaluate({...built,manifest:row.manifest},row.manifest.rules[0]!.tests[0]!.facts);
          await transaction(this.pool,async db=>{
            await requireGrant(db,actor,'rule:publish');await this.publishRow(db,actor,await this.row(db,draftId),receipt);
            await db.query("UPDATE business.review_guidance_digests SET state='adopted',decided_by=$2,decided_at=now(),adoption=adoption||$3::jsonb,updated_at=now() WHERE id=$1",[digestId,actor.personId,JSON.stringify({step:'published',errorCode:null})]);
            await audit(db,{actorId:actor.accountId,targetId:digestId,action:'review.guidance_digest_adopted',details:{draftId,releaseId:row.manifest.releaseId}});
          });
        }
      }catch(error){await this.adoptionStep(digestId,{errorCode:error instanceof AppError?error.code:'guidance_digest_adoption_failed'});throw error;}
    }
    return transaction(this.pool,async db=>{const r=(await db.query(`${DIGEST_SELECT} WHERE d.id=$1`,[digestId])).rows[0];return digestView(r,await this.digestActions(db,actor,r));});
  }
  async declineGuidanceDigest(actor:Actor,digestId:string,raw:unknown):Promise<GuidanceDigestView>{
    const input=DeclineGuidanceDigestSchema.parse(raw);
    return transaction(this.pool,async db=>{
      await requireGrant(db,actor,'rule:approve');
      const d=(await db.query('SELECT state,adoption,person_id FROM business.review_guidance_digests WHERE id=$1 FOR UPDATE',[digestId])).rows[0];
      if(!d)throw new AppError(404,'guidance_digest_not_found');
      if(d.person_id===actor.personId)throw new AppError(403,'review_config_self_approval');
      if(d.state==='ready'&&d.adoption?.draftId)throw new AppError(409,'guidance_digest_adoption_in_progress');
      if(d.state==='ready'){await db.query("UPDATE business.review_guidance_digests SET state='declined',decided_by=$2,decided_at=now(),decision_reason=$3,updated_at=now() WHERE id=$1",[digestId,actor.personId,input.reason]);
        await audit(db,{actorId:actor.accountId,targetId:digestId,action:'review.guidance_digest_declined',details:{}});}
      else if(d.state!=='declined')throw new AppError(409,'guidance_digest_not_ready');
      const r=(await db.query(`${DIGEST_SELECT} WHERE d.id=$1`,[digestId])).rows[0];return digestView(r,await this.digestActions(db,actor,r));
    });
  }
  /** Re-verifies trial, approval and the loaded package before inserting the immutable release. */
  private async publishRow(db:DB,actor:Actor,row:DraftRow,publicationReceipt:Awaited<ReturnType<RuleExecutor['evaluate']>>|null){
      const id=row.id;
      if(row.status!=='approved'||!row.approval_id||!row.trial_id||!validateReviewConfig(row.manifest).valid)throw new AppError(409,'review_config_approval_required');
      const approval=(await db.query('SELECT * FROM business.review_config_approvals WHERE id=$1',[row.approval_id])).rows[0],trial=(await db.query('SELECT * FROM business.review_config_trials WHERE id=$1',[row.trial_id])).rows[0],built=createRulePackage(row.manifest);
      const hash=configHash({draftId:id,revision:row.revision,manifestHash:row.manifest_hash,trialHash:trial?.receipt_hash,personId:approval?.person_id});
      if(!approval||!trial?.passed||!signatureTrialReceiptMatches(row.manifest,trial.receipt)||approval.trial_id!==trial.id||approval.manifest_hash!==row.manifest_hash||approval.draft_revision!==row.revision||approval.approval_hash!==hash||trial.manifest_hash!==row.manifest_hash||trial.package_hash!==built.packageHash||trial.policy_sha256!==built.policySha256||configHash(trial.receipt)!==trial.receipt_hash||!trial.receipt.receipts?.every((receipt:any)=>receipt.releaseId===row.manifest.releaseId&&receipt.packageHash===built.packageHash&&receipt.executorVersion===row.manifest.compatibility.executorVersion))throw new AppError(409,'review_config_approval_invalid');
      const documentConfig=documentConfigurationFor(row.manifest),documentId=`review:${row.manifest.releaseId}`,documentHash=createHash('sha256').update(JSON.stringify(documentConfig)).digest('hex');
      await db.query('INSERT INTO business.document_configurations(id,sha256,manifest,synthetic) VALUES($1,$2,$3,$4)',[documentId,documentHash,JSON.stringify(documentConfig),row.manifest.scope==='synthetic']);
      if(!publicationReceipt||publicationReceipt.releaseId!==row.manifest.releaseId||publicationReceipt.packageHash!==built.packageHash||publicationReceipt.executorVersion!==row.manifest.compatibility.executorVersion)throw new AppError(409,'review_config_package_unavailable');
      await db.query('INSERT INTO business.review_config_releases(release_id,draft_id,draft_revision,manifest,manifest_hash,package_hash,policy_sha256,policy_source,document_configuration_id,trial_hash,approval_hash,publication_receipt,publication_hash,published_by) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)',[row.manifest.releaseId,id,row.revision,JSON.stringify(row.manifest),row.manifest_hash,built.packageHash,built.policySha256,built.source,documentId,trial.receipt_hash,approval.approval_hash,JSON.stringify(publicationReceipt),configHash(publicationReceipt),actor.personId]);
      await db.query("UPDATE business.review_config_drafts SET status='published',release_id=$2,updated_at=now() WHERE id=$1",[id,row.manifest.releaseId]);
      await audit(db,{actorId:actor.accountId,targetId:id,action:'review_config.published',details:{releaseId:row.manifest.releaseId,manifestHash:row.manifest_hash,packageHash:built.packageHash}});
  }
}
type ConfigAuth={requireSession(request:FastifyRequest):Promise<Actor>;checkWrite(request:FastifyRequest):Promise<Actor>};
export function registerReviewConfigRoutes(app:FastifyInstance,_pool:Pool,auth:ConfigAuth,service:ReviewConfigService){
  const path=(request:FastifyRequest)=>z.strictObject({id:z.uuid()}).parse(request.params).id;
  app.get('/api/review-configs',async request=>service.list(await auth.requireSession(request)));
  app.get('/api/review-configs/guidance-digests',async request=>service.listGuidanceDigests(await auth.requireSession(request)));
  const digest=(request:FastifyRequest)=>z.strictObject({digestId:z.uuid()}).parse(request.params).digestId;
  app.post('/api/review-configs/guidance-digests/:digestId/adopt',async request=>service.adoptGuidanceDigest(await auth.checkWrite(request),digest(request),request.body));
  app.post('/api/review-configs/guidance-digests/:digestId/decline',async request=>service.declineGuidanceDigest(await auth.checkWrite(request),digest(request),request.body));
  // A full workbook includes grounded definitions and four fixtures per rule.
  // Keep the larger bound local to authenticated configuration writes.
  app.post('/api/review-configs',{bodyLimit:2*1024*1024},async request=>service.create(await auth.checkWrite(request),request.body));
  app.get('/api/review-configs/:id',async request=>service.get(await auth.requireSession(request),path(request)));
  app.put('/api/review-configs/:id',{bodyLimit:2*1024*1024},async request=>service.save(await auth.checkWrite(request),path(request),request.body));
  for(const action of ['validate','trial','approve','publish'] as const)app.post(`/api/review-configs/:id/${action}`,async request=>service[action](await auth.checkWrite(request),path(request),request.body));
  app.get('/api/review-configs/:id/package',async request=>{const value=await service.get(await auth.requireSession(request),path(request));return {...createRulePackage(value.manifest),configuration:value.manifest,manifestHash:value.manifestHash};});
}
