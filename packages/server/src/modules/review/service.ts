import {automaticMaterialObjects,confirmedSubjectObjects,subjectCandidates} from './automatic-attribution.js';
import {FIELD_ACCEPTANCE_POLICIES} from './automatic-fields.js';
import {ConfirmSubjectsSchema,SUBJECT_ROLES,type ConfirmedSubject,type SubjectConfirmationState,type SubjectRole,type SubjectWorkState} from '@hsbc/contracts/review-subjects';
import {withChecklistDocumentScope} from './checklist-scope.js';
import {extraBankRequirementDisabled,systemJudgementEnabled} from './requirement-policy.js';
import {resolveSystemJudgement,type ResultResolution} from './result-resolution.js';
import {preparePersonalChecklist} from './personal-checklist.js';
import {currentRequirementPolicy,translationRequirementDisabled} from './requirement-policy.js';
import {projectCorporateScopeFields,mergeCorporateScopeChecks} from './corporate-pre-review-scope.js';
import {projectChecklistAutomatic} from './checklist-automatic.js';
import {automaticReview} from './automatic-review.js';
import {reviewedCorporateRuleInputs} from './reviewed-rule-inputs.js';
import {corporateReviewedChecks} from './corporate-reviewed-checks.js';
import {corporateMaterialChecks} from './corporate-material-checks.js';
import type {ReviewedRuleInputs,AutomaticReviewCheck} from '@hsbc/contracts/field-verification';
import {DOCUMENT_CLASSIFICATION_PROJECTION} from './classification-projection.js';
import {fixedMaterialType} from '../documents/content-classification.js';

import {withPersonalLegalChecks} from './personal-legal-checks.js';
import {canInspectPersonalWorkbook} from './personal-workbook-source.js';
import type {FrozenFieldReview} from '@hsbc/contracts/field-verification';
import {materialPreparation} from './material-preparation.js';
import {canInspectScopedSource} from './scoped-source-readings.js';
import {canInspectPersonalName} from './personal-name-source.js';
import {personalFieldReviewItems} from './personal-field-review.js';
import {reviewPins} from './field-verification.js';
import {SaveFieldReviewSchema} from '@hsbc/contracts/field-verification';
import {SupplyFieldValueSchema,WithdrawFieldValueSchema} from '@hsbc/contracts/review-field-supply';
import {fieldIsEmpty,suppliedFieldValues,verifySuppliedQuote,withSuppliedFields} from './field-supply.js';
import {validateFieldReview,savedFieldReview,projectFieldReview,correctedFieldDisplay,pinnedFieldCorrections,fieldReviewBasis,fieldReviewFactBasis} from './field-verification.js';
import {withUploadDateBaselines} from './date-sources.js';
import {personalAutomaticReview} from './personal-automatic-review.js';
import {withCrossFileChecks} from './cross-file.js';
import {canReadPeople,guidanceRefs,loadCaseGuidance,validateGuidanceBody} from './guidance.js';
import {DIGEST_SELECT,digestView,recordGuidanceDigest} from './guidance-digest.js';
import {RetireCaseGuidanceSchema,SaveCaseGuidanceSchema,guidanceContentKey,type CaseGuidance,type GuidanceRef} from '@hsbc/contracts/review-guidance';
import {automaticSignaturesFromContext,signatureSourceContext} from '../documents/signatures/information-source.js';
import type {ChecklistRow} from '@hsbc/contracts/review-checklist';
import {selectEvidenceMaterial,sameLogicalExtent} from './material-selection.js';
import {materialProjection,reviewMaterials} from './material-scope.js';
import {materialMembership,materialListIds,usesFileListScope,fixedMaterialSnapshot,currentMaterialDecisions} from '../materials/review-scope.js';
import {signatureInformationSummaries,assertSignatureInformationSnapshot} from '../documents/signatures/information.js';
import type {SignatureInformationSummary} from '@hsbc/contracts/signature-information';
import {assertCheckerCorrection,invalidateCheckerContent,checkerCorrectionActive} from '../review-checker/access.js';
import {buildChecklist,type ChecklistInputDocument} from './checklist.js';
import type {ReviewChecklist} from '@hsbc/contracts/review-checklist';
import {assertRoundInputsOpen,assertRoundRequest,assertDocumentRound,assertNoInputWork,currentRound,roundInputWork,ROUND_INPUT_ACTIONS} from './round-boundary.js';
import {deriveCorporateFacts} from './corporate-facts.js';
import {derivePersonalFacts} from './personal-facts.js';
import {PERSONAL_DERIVED_FIELDS,PERSONAL_FACT_OPTIONS} from '@hsbc/contracts/personal-requirements';
import {reviewEvidenceBelongsToObject,pendingReviewMaterials,pendingMaterialForType,type PendingReviewMaterial} from './material-readiness.js';
import {verifyTablePartyCandidate} from '../documents/table-party-role.js';
import { createHash,randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import type { Pool, PoolClient } from 'pg';
import { z } from 'zod';
import { reviewEvidenceInScope,reviewScopeWholePages,ReviewMaterialScopeSchema,ReviewCommandSchema,ReviewObjectSchema,ReviewFactSchema,ReviewMaterialSchema,ReviewReplySchema,type ReviewEvidence,type ReviewFact,type ReviewObject,type ReviewMaterial,type ReviewMaterialSource,type ReviewMaterialDetail,type ReviewState } from '@hsbc/contracts/review';
import { GuaranteeTypeSchema,OpaReceiptSchema,type ReviewConfigRelease,type ReviewFacts,type OpaReceipt,type RuleEvaluation,type ReviewFieldDefinition } from '@hsbc/contracts/review-config';
import { type DocumentFieldObservation,candidateAdoptionValue,candidateRequiredEvidenceGroups,DocumentFieldCandidateSchema,DocumentPageArtifactSchema,DocumentLogicalDocumentSchema,DocumentFieldObservationSchema,AuthorizationSourceBindingSchema,SourceCorrectionBindingSchema } from '@hsbc/contracts/documents';
import type { Auth } from '../identity/auth.js';
import { AppError } from '../../shared/errors.js';
import { audit } from '../audit/events.js';
import { authorizeCase, isEligibleMaker, canEditReview } from '../cases/authorization.js';
import { hasGrant } from '../identity/authorization.js';
import { idempotent } from '../../infrastructure/database/idempotency.js';
import { transaction, type DB } from '../../infrastructure/database/client.js';
import { type Actor } from '../identity/types.js';
import type { ClaimedWork } from '../../infrastructure/jobs/types.js';
import { getPublished } from './configuration.js';
import { normalizeReviewValue } from './normalization.js';
import type { DocumentExtractionPort } from './ports.js';
import { validateCompanyNameSelection } from '../company-identity/service.js';
import {verifyAuthorizationSourceCandidate} from '../documents/authorization-source-evidence.js';
import {verifySourceCorrectionCandidate} from '../documents/clause-source-correction.js';

export interface ReviewExecutor {evaluate(release:ReviewConfigRelease,facts:ReviewFacts,signal?:AbortSignal,ruleIds?:string[]):Promise<OpaReceipt>;evaluateBatch?(release:ReviewConfigRelease,fixtures:Array<{facts:ReviewFacts;ruleIds:string[]}>,signal?:AbortSignal):Promise<OpaReceipt[]>}
/** Source checks that concern one cited location only. A value failing one of them is left out of the run; it does not undo the start. */
export const DEMOTABLE_EVIDENCE_CODES:readonly string[]=['evidence_anchor_invalid','evidence_outside_material_scope','source_node_invalid','source_node_not_visible','source_node_requires_docx'];
export interface ReviewSnapshot {requirementPolicy?:import('@hsbc/contracts/review-config').ReviewRequirementPolicy;
  /** Automatic values left out of this run because their cited source could not be located inside the adopted material. */
  demotedAutomatic?:Array<{kind:'fact';fieldId:string;objectId:string|null;code:string}>;reviewedInputs?:ReviewedRuleInputs[];automaticChecks?:AutomaticReviewCheck[];/** Judgement rules in force when the run started; absent when none. */guidance?:GuidanceRef[];fieldReviews?:FrozenFieldReview[];crossFileChecklist?:Array<Pick<ChecklistRow,'id'|'fieldId'|'crossChecks'>>;materialScope?:'file-list';signatureInformation?:SignatureInformationSummary[];schemaVersion:'p3-review.v1'|'p3-review.v2';roundId?:string;roundNumber?:number;caseId:string;caseRevision:number;businessDate:string;configurationReleaseId:string;manifestHash:string;packageHash:string;objects:ReviewObject[];facts:ReviewFact[];materials:ReviewMaterial[];pendingMaterials?:PendingReviewMaterial[]}
type RunRow={round_id:string|null;id:string;case_id:string;case_revision:number;configuration_release_id:string;snapshot:ReviewSnapshot;snapshot_hash:string;account_id:string;person_id:string;auth_version:number;session_key:string|null;state:string;validity:string;error_code:string|null;results:any[];created_at:Date};
const ACTIONS=['case:configure','case:start','material:adopt','field:correct','finding:decide'];
export function reviewHash(value:unknown):string {const ordered=(v:any):any=>Array.isArray(v)?v.map(ordered):v&&typeof v==='object'?Object.fromEntries(Object.keys(v).sort().filter(k=>v[k]!==undefined).map(k=>[k,ordered(v[k])])):v;return createHash('sha256').update(JSON.stringify(ordered(value))).digest('hex');}
const inputHash=reviewHash;
const currentObjects=`SELECT DISTINCT ON(object_id) * FROM business.review_object_versions WHERE case_id=$1 AND round_id IS NOT DISTINCT FROM $2::uuid ORDER BY object_id,version DESC`;
const currentFacts=`SELECT DISTINCT ON(fact_id) * FROM business.review_fact_versions WHERE case_id=$1 AND round_id IS NOT DISTINCT FROM $2::uuid ORDER BY fact_id,version DESC`;
const objectView=(r:any):ReviewObject=>({...r.body,objectId:r.object_id,version:r.version,confirmedBy:r.confirmed_by,caseRevision:r.case_revision,validity:r.validity});
const factView=(r:any):ReviewFact=>({...r.body,factId:r.fact_id,version:r.version,confirmedBy:r.confirmed_by,caseRevision:r.case_revision,validity:r.validity});
const evidenceIds=(evidence:ReviewEvidence[])=>evidence.map(e=>`${e.documentVersionId}:${e.parseRevision}:${e.anchorId??e.sourceNodeId}`);
function actorOf(run:RunRow):Actor{return {accountId:run.account_id,personId:run.person_id,authVersion:run.auth_version,...(run.session_key?{sessionKey:run.session_key}:{})};}
export function effectiveReviewMaterials(materials:ReviewMaterial[],businessDate:string):ReviewMaterial[]{
  const eligible=materials.filter(m=>m.operation!=='reject'&&(!m.relation?.effectiveDate||m.relation.effectiveDate<=businessDate));
  return eligible.filter(m=>!eligible.some(next=>next.relation?.kind==='replacement'&&next.relation.predecessorDocumentVersionId===m.documentVersionId)).map(m=>({...m,operation:'adopt'}));
}

/** Called from P2 mutations inside their existing transaction. Historical versions and evidence are retained. */
export async function invalidateReviewDependencies(db:DB,caseId:string,input:{documentVersionId?:string;parseRevision?:string;logicalDocumentId?:string|null;reason:string}){
  const c=(await db.query('SELECT * FROM business.cases WHERE id=$1',[caseId])).rows[0];
  if(c)await assertRoundInputsOpen(db,c);
  if(!input.documentVersionId&&!input.parseRevision)throw new AppError(422,'review_dependency_required');
  const evidenceMatches=(e:any)=>Boolean(input.documentVersionId&&e.documentVersionId===input.documentVersionId||input.parseRevision&&e.parseRevision===input.parseRevision)&&(!('logicalDocumentId' in input)||!e.materialScope||e.materialScope.logicalDocumentId===input.logicalDocumentId);
  for(const table of ['review_fact_versions','review_object_versions']){
    const rows=(await db.query(`SELECT id,body FROM business.${table} WHERE case_id=$1 AND round_id IS NOT DISTINCT FROM $2::uuid AND validity='current'`,[caseId,c?.current_round_id??null])).rows;
    const ids=rows.filter(r=>(r.body.evidence??[]).some(evidenceMatches)).map(r=>r.id);
    if(ids.length)await db.query(`UPDATE business.${table} SET validity='stale' WHERE id=ANY($1::uuid[])`,[ids]);
  }
  const runs=(await db.query("SELECT id,snapshot FROM business.review_runs WHERE case_id=$1 AND round_id IS NOT DISTINCT FROM $2::uuid AND validity='current'",[caseId,c.current_round_id??null])).rows;
  const ids=runs.filter(r=>[...r.snapshot.materials,...(r.snapshot.pendingMaterials??[]),...(r.snapshot.fieldReviews??[]).flatMap((f:FrozenFieldReview)=>f.verification.sources.map(s=>s.evidence))].some(evidenceMatches)).map(r=>r.id);
  if(ids.length){
    await db.query("UPDATE business.review_runs SET validity='stale',state=CASE WHEN state IN ('pending','running') THEN 'stale' ELSE state END,updated_at=now() WHERE id=ANY($1::uuid[])",[ids]);
    await db.query("UPDATE business.work_items SET state='canceled',epoch=epoch+1,lease_until=NULL WHERE owner_type='Workflow' AND owner_id=ANY($1::uuid[]) AND state IN ('pending','running')",[ids]);
    await db.query("UPDATE business.review_issues SET validity='stale',updated_at=now() WHERE case_id=$1 AND latest_finding_id IN(SELECT id FROM business.review_findings WHERE run_id=ANY($2::uuid[]))",[caseId,ids]);
  }
}

/** What one verification pass has read. The evidence of a run cites the same few files hundreds of times, so each
 * file's current state, directory with anchors, projection and native source is read once per pass instead of once per
 * citation. A pass is one sequence of calls inside one transaction; nothing is kept from one pass to the next, so every
 * fence still checks against what the database holds at that moment. */
export interface EvidenceReads {materials?:ReviewMaterial[];current:Map<string,Promise<void>>;artifacts:Map<string,Promise<any>>;projections:Map<string,Promise<Awaited<ReturnType<typeof materialProjection>>>>;sources:Map<string,Promise<any>>}
export const evidenceReads=():EvidenceReads=>({current:new Map(),artifacts:new Map(),projections:new Map(),sources:new Map()});

/** A rule runs in an explicit object scope. Only explicitly linked objects can supply cross-document facts. */
export function buildRuleInstances(snapshot:ReviewSnapshot,release:ReviewConfigRelease){
  const v3=release.manifest.compatibility.executorVersion==='p3-deterministic-v3';
  const v2=v3||release.manifest.compatibility.executorVersion==='p3-deterministic-v2';
  const instances:Array<{scopeId:string;facts:ReviewFacts;ruleIds:string[];inputHashes:Record<string,string>}>=[];
  const objects=snapshot.objects.filter(o=>(o as any).validity!=='stale');
  const fieldDefs=new Map(release.manifest.fields.map(f=>[f.id,f]));
  const scopes=new Map<string,{object:ReviewObject|null;rules:string[]}>();
  for(const rule of release.manifest.rules){if(translationRequirementDisabled(rule.id,snapshot.requirementPolicy)||extraBankRequirementDisabled(rule.id,snapshot.requirementPolicy))continue;const primary=rule.inputs.map(id=>fieldDefs.get(id)).find(Boolean);
    const scopedObjects=v3&&rule.objectScope&&['personal_guarantee','corporate_guarantee'].includes(rule.objectScope.role)?snapshot.objects:objects;
    const primaryObjects=rule.objectScope?scopedObjects.filter(o=>o.kind===rule.objectScope!.kind&&o.role===rule.objectScope!.role):primary?objects.filter(o=>o.kind===primary.objectKind&&(!primary.objectRole||o.role===primary.objectRole)):[];
    // Every explicitly confirmed applicable object gets an instance, including missing facts.
    const matches=primaryObjects;
    if(!primary&&!rule.objectScope){const scope=scopes.get('case')??{object:null,rules:[]};scope.rules.push(rule.id);scopes.set('case',scope);}
    else if(!matches.length){const key=`unconfirmed:${rule.objectScope?.role??primary!.objectKind}`,scope=scopes.get(key)??{object:null,rules:[]};scope.rules.push(rule.id);scopes.set(key,scope);}
    else for(const object of matches){const scope=scopes.get(object.objectId)??{object,rules:[]};scope.rules.push(rule.id);scopes.set(object.objectId,scope);}
  }
  for(const [scopeId,scope] of scopes){
    const reachable=new Set<string>();if(scope.object){const queue=[scope.object.objectId];while(queue.length){const id=queue.shift()!;if(reachable.has(id))continue;reachable.add(id);for(const relation of objects.find(o=>o.objectId===id)?.relations??[])queue.push(relation.targetObjectId);}}
    const facts:ReviewFacts={};
    for(const definition of release.manifest.fields){
      if(v3&&definition.id==='review_business_date'){
        facts[definition.id]={value:snapshot.businessDate,state:'present',evidenceIds:[`case:${snapshot.caseId}:business-date:${snapshot.businessDate}`]};
        continue;
      }
      const matches=(o:ReviewObject)=>o.kind===definition.objectKind&&(!definition.objectRole||o.role===definition.objectRole);
      const candidates=objects.filter(o=>reachable.has(o.objectId)&&matches(o));
      const own=scope.object&&matches(scope.object)?[scope.object]:candidates;
      const values=snapshot.facts.filter(f=>own.some(o=>o.objectId===f.objectId)&&f.fieldId===definition.id);
      if(own.length!==1||values.length!==1||own[0]!.validity==='stale'){facts[definition.id]={value:null,state:'uncertain',evidenceIds:values.flatMap(v=>evidenceIds(v.evidence))};continue;}
      const f=values[0]!,state=f.validity==='stale'||f.normalization.status==='pending'||!reviewEvidenceBelongsToObject(own[0]!,f.evidence)||Boolean(f.definitionHash&&f.definitionHash!==inputHash(definition))?'uncertain':f.state==='pending'?'uncertain':f.state==='expected_blank'?'blank':f.state;
      // A facility extraction is evidence, not the user's confirmed amount
      // requirement (CGT row 13). Protect new runs of older pinned manifests too.
      // Runs frozen with the system-judgement policy take the facility letter's stated amount as the comparison figure.
      if(!systemJudgementEnabled(snapshot.requirementPolicy)&&definition.objectRole==='corporate_guarantee'&&f.automaticAdoption&&release.manifest.rules.some(r=>r.id==='cgt_amount_minimum'&&[r.inputs[1],r.inputs[3]].includes(definition.id))){
        facts[definition.id]={value:null,state:'uncertain',evidenceIds:evidenceIds(f.evidence)};continue;
      }
      facts[definition.id]={value:state==='present'?f.normalizedValue:state==='blank'?'':null,state,evidenceIds:[`fact:${f.factId}:${f.version}`,...evidenceIds(f.evidence)]};
      if(v2){const object=own[0]!;const currentIdentity=(kind:string)=>object.relations.filter(relation=>relation.kind===kind&&object.kind==='party'&&object.evidence.length>0&&objects.some(target=>target.objectId===relation.targetObjectId&&target.kind==='party'&&target.version===relation.targetVersion&&target.evidence.length>0)).map(relation=>relation.targetObjectId);
        Object.assign(facts[definition.id]!,{objectId:object.objectId,sameEntityIds:currentIdentity('same_entity'),differentEntityIds:currentIdentity('different_entity')});
        facts[definition.id]!.evidenceIds.push(`object:${object.objectId}:${object.version}`,...evidenceIds(object.evidence));
      }
    }
    const reviewed=snapshot.reviewedInputs?.filter(r=>r.scopeId===scopeId&&r.configurationReleaseId===release.releaseId&&r.policyVersion==='reviewed-rule-inputs-v1');
    const reviewedScope=reviewed?.length===1?reviewed[0]:undefined;
    if(reviewedScope)for(const [id,input] of Object.entries(reviewedScope.inputs)){
      if(!id.startsWith('material:')&&facts[id]?.state==='uncertain'&&!snapshot.facts.some(f=>f.objectId===scopeId&&f.fieldId===id))facts[id]=input.fact;
    }
    if(v3&&scope.object?.role==='personal_guarantee')derivePersonalFacts(facts,snapshot.facts.filter(f=>f.objectId===scope.object!.objectId));
    if(v3&&(scope.object?.role==='corporate_guarantee'||reviewedScope?.role==='corporate_guarantee')&&release.manifest.sources.some(s=>s.id==='cgt_confirmed_execution'))deriveCorporateFacts(facts);
    for(const material of release.manifest.materials){
      const adopted=snapshot.materials.filter(m=>m.operation==='adopt'&&m.documentTypeId===material.taxonomyId);
      if(!material.objectScope){const pending=snapshot.materialScope==='file-list'&&!adopted.length?(snapshot.pendingMaterials??[]).filter(m=>pendingMaterialForType(m,material.taxonomyId)):[];facts[`material:${material.id}`]={value:pending.length?null:adopted.length>0,state:pending.length?'uncertain':'present',evidenceIds:[...adopted,...pending].map(m=>`document:${m.documentVersionId}`)};continue;}
      // Scoped documents require explicit evidence on this business object.
      // A document belonging to another guarantor cannot satisfy this guarantor.
      const matching=scope.object?.kind===material.objectScope.kind&&scope.object.role===material.objectScope.role&&scope.object.validity!=='stale';
      const claims=(o:ReviewObject,m:ReviewMaterial)=>o.evidence.some(e=>e.documentVersionId===m.documentVersionId&&e.parseRevision===m.parseRevision&&(!e.materialScope||e.materialScope.logicalDocumentId===m.logicalDocumentId));
      // With a single subject of this role, an adopted file of the role that no subject cites can only be that subject's.
      // Two or more subjects keep needing explicit evidence, so one guarantor's file never satisfies another.
      const sole=systemJudgementEnabled(snapshot.requirementPolicy)&&matching&&objects.filter(o=>o.kind===material.objectScope!.kind&&o.role===material.objectScope!.role).length===1;
      const own=matching?adopted.filter(m=>claims(scope.object!,m)||sole&&!objects.some(o=>claims(o,m))):[];
      const unassigned=adopted.some(m=>!objects.some(o=>o.kind===material.objectScope!.kind&&o.role===material.objectScope!.role&&o.evidence.some(e=>e.documentVersionId===m.documentVersionId&&e.parseRevision===m.parseRevision&&(!e.materialScope||e.materialScope.logicalDocumentId===m.logicalDocumentId))));
      const pending=(snapshot.pendingMaterials??[]).filter(m=>pendingMaterialForType(m,material.taxonomyId));
      const uncertain=!matching||(!own.length&&(unassigned||pending.length>0));
      facts[`material:${material.id}`]={value:uncertain?null:own.length>0,state:uncertain?'uncertain':'present',evidenceIds:[...own,...(!own.length?pending:[])].map(m=>`document:${m.documentVersionId}`)};
    }
    if(reviewedScope)for(const [id,input] of Object.entries(reviewedScope.inputs))if(id.startsWith('material:')&&(facts[id]?.state==='uncertain'||id==='material:cgt_lawyer_confirmation'&&facts[id]?.value===false&&input.fact.value===true))facts[id]=input.fact;
    const inputHashes:Record<string,string>={};for(const ruleId of scope.rules){const rule=release.manifest.rules.find(r=>r.id===ruleId)!;const inputs=[...rule.inputs,...(rule.applicability?[rule.applicability.fieldId]:[])];
      const dependentFacts=snapshot.facts.filter(f=>inputs.includes(f.fieldId)&&reachable.has(f.objectId));const documentIds=new Set(dependentFacts.flatMap(f=>f.evidence.map(e=>e.documentVersionId)));
      const materialTypes=release.manifest.materials.filter(m=>inputs.includes(`material:${m.id}`)).map(m=>m.taxonomyId);
      for(const e of [...(reviewedScope?.bindingEvidence??[]),...inputs.flatMap(id=>reviewedScope?.inputs[id]?.evidence??[])])documentIds.add(e.documentVersionId);
      const materialDependencies=snapshot.materials.filter(m=>documentIds.has(m.documentVersionId)||materialTypes.includes(m.documentTypeId));
      inputHashes[ruleId]=inputHash({manifestHash:release.manifestHash,packageHash:release.packageHash,businessDate:snapshot.businessDate,scopeId,rule,fieldDefinitions:release.manifest.fields.filter(f=>inputs.includes(f.id)),materialDependencies,inputs:Object.fromEntries(inputs.map(id=>[id,facts[id]??null])),...(v2?{objectDependencies:objects.filter(object=>reachable.has(object.objectId)).map(object=>({objectId:object.objectId,version:object.version,kind:object.kind,role:object.role,relations:object.relations,evidence:object.evidence}))}:{})});}
    instances.push({scopeId,facts,ruleIds:scope.rules,inputHashes});
  }
  return instances;
}

function configurationView(release:ReviewConfigRelease|null):ReviewState['configuration'] {return release?{releaseId:release.releaseId,label:release.manifest.label,fields:release.manifest.fields.map(({id,label,type,objectKind,objectRole,unit,currency})=>({id,label,type,objectKind,...(objectRole?{objectRole}:{}),unit,currency})),taxonomy:release.manifest.taxonomy.map(({id,label})=>({id,label})),materials:release.manifest.materials.map(({id,label,taxonomyId,objectScope})=>({id,label,taxonomyId,...(objectScope?{objectRole:objectScope.role}:{})})),rules:release.manifest.rules.map(({id,label,description,sourceIds,inputs})=>({id,label,...(description?{description}:{}),sourceReferences:sourceIds.map(id=>release.manifest.sources.find(s=>s.id===id)!.reference),inputFieldIds:inputs.filter(id=>release.manifest.fields.some(f=>f.id===id))}))}:null;}

export async function advanceReviewRevision(db:DB,c:any){await db.query('UPDATE business.cases SET revision=revision+1,updated_at=now() WHERE id=$1',[c.id]);c.revision++;
    await db.query("UPDATE business.review_runs SET validity='stale',state=CASE WHEN state IN ('pending','running') THEN 'stale' ELSE state END,updated_at=now() WHERE case_id=$1 AND round_id IS NOT DISTINCT FROM $2::uuid AND validity='current'",[c.id,c.current_round_id??null]);
    await db.query("UPDATE business.work_items SET state='canceled',epoch=epoch+1,lease_until=NULL WHERE owner_type='Workflow' AND kind='p3_review' AND owner_id IN(SELECT id FROM business.review_runs WHERE case_id=$1 AND round_id IS NOT DISTINCT FROM $2::uuid) AND state IN ('pending','running')",[c.id,c.current_round_id??null]);
    await db.query("UPDATE business.review_issues SET validity='stale',updated_at=now() WHERE case_id=$1 AND round_id IS NOT DISTINCT FROM $2::uuid",[c.id,c.current_round_id??null]);
  }

export async function signatureInformationChanged(db:DB,c:any,actor:Actor,input:{documentId:string;recordId:string;version:number;reason:string}){
  await advanceReviewRevision(db,c);
  await db.query('INSERT INTO business.contributions(id,case_id,person_id,kind) VALUES($1,$2,$3,$4)',[randomUUID(),c.id,actor.personId,checkerCorrectionActive(c,actor.personId)?'checker_correction':'signature_information']);
  await invalidateCheckerContent(db,c.id);
  await db.query('INSERT INTO business.review_events(id,case_id,case_revision,kind,actor_person_id,account_id,details,round_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8)',[randomUUID(),c.id,c.revision,'signature_information_saved',actor.personId,actor.accountId,JSON.stringify({...input,...(checkerCorrectionActive(c,actor.personId)?{reviewRole:'checker'}:{})}),c.current_round_id??null]);
}

/** Default off. When on, files are attached to subjects only after the reviewer confirms the round's subjects. */
export function subjectConfirmationEnabled(env:NodeJS.ProcessEnv=process.env):boolean {
  const value=env.P4_SUBJECT_CONFIRMATION_ENABLED;
  if(value===undefined||value==='false')return false;
  if(value!=='true')throw new Error('subject_confirmation_flag_invalid');
  return true;
}
export class ReviewService {
  private stopping=false;private active=new Set<AbortController>();private leaseSeconds:number;
  constructor(readonly pool:Pool,readonly executor:ReviewExecutor,readonly options:{leaseSeconds?:number;documents?:DocumentExtractionPort;crossFileAnalysis?:(db:PoolClient,actor:Actor,caseId:string,roundId:string|null,rows:ChecklistRow[])=>Promise<ChecklistRow[]>;execute?:(invoke:()=>Promise<void>,snapshot:ReviewSnapshot,work:ClaimedWork)=>Promise<void>;
    /** Files are attached to subjects only after the reviewer confirmed who the round's subjects are. */
    subjectConfirmation?:boolean}={}){this.leaseSeconds=options.leaseSeconds??60;if(this.leaseSeconds<10||this.leaseSeconds>300)throw new Error('invalid_review_lease');}
  stop(){this.stopping=true;for(const controller of this.active)controller.abort();}
  private async maker(db:DB,actor:Actor,caseId:string,action:string){const c=await authorizeCase(db,actor,caseId,action);if(['field:correct','finding:decide','case:start'].includes(action)&&c.maker_person_id!==actor.personId)await assertCheckerCorrection(db,c,actor.personId);else if(c.maker_person_id!==actor.personId||!await isEligibleMaker(db,actor.personId,caseId))throw new AppError(403,'maker_assignment_required');if(c.scenario!=='overseas_loan')throw new AppError(409,'scenario_confirmation_required');return c;}
  private async release(db:DB,id:string|null){if(!id)throw new AppError(409,'review_configuration_required');return getPublished(db,id);}
  private async scope(db:DB,caseId:string){const c=(await db.query('SELECT review_rounds_enabled,current_round_id FROM business.cases WHERE id=$1',[caseId])).rows[0];return {roundId:c?.current_round_id??null,empty:!!c?.review_rounds_enabled&&!c.current_round_id};}
  private async values(db:DB,caseId:string,selected?:string|null){
    const scope=selected===undefined?await this.scope(db,caseId):{roundId:selected,empty:false};
    if(scope.empty)return {objects:[],facts:[],materials:[]};
    const values={objects:(await db.query(currentObjects,[caseId,scope.roundId])).rows.map(objectView),facts:(await db.query(currentFacts,[caseId,scope.roundId])).rows.map(factView),materials:await reviewMaterials(db,caseId,scope.roundId)};
    const c=(await db.query(`SELECT c.id,c.revision,c.configuration_release_id,c.current_round_id,c.closed_at,r.state AS round_state
      FROM business.cases c LEFT JOIN business.review_rounds r ON r.id=c.current_round_id WHERE c.id=$1`,[caseId])).rows[0];
    // Automatic associations are current draft projections, never mutations of
    // saved identities or old/submitted rounds. All callers retain their DB transaction.
    if(c&&!c.closed_at&&scope.roundId&&scope.roundId===c.current_round_id&&c.round_state==='draft'&&c.configuration_release_id){
      const release=await this.release(db,c.configuration_release_id);
      const documents=await this.checklistDocuments(db,{caseId,roundId:scope.roundId,readOnly:false,materials:values.materials});
      const projection={caseId,roundId:scope.roundId,revision:c.revision,objects:values.objects};
      values.objects=this.options.subjectConfirmation
        ?confirmedSubjectObjects(release.manifest,projection,documents,(await this.confirmedSubjects(db,caseId,scope.roundId))?.subjects??[])
        :automaticMaterialObjects(release.manifest,projection,documents);
    }
    return values;
  }
  private async event(db:DB,actor:Actor,c:any,kind:string,details:Record<string,unknown>,issueId?:string){await db.query('INSERT INTO business.review_events(id,case_id,case_revision,kind,issue_id,actor_person_id,account_id,details,round_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)',[randomUUID(),c.id,c.revision,kind,issueId??null,actor.personId,actor.accountId,JSON.stringify({...details,...(checkerCorrectionActive(c,actor.personId)?{reviewRole:'checker'}:{})}),c.current_round_id??null]);await audit(db,{actorId:actor.accountId,targetId:c.id,action:`review.${kind}`,details:{revision:c.revision}});}
  private advance(db:DB,c:any){return advanceReviewRevision(db,c);}
  async state(actor:Actor,caseId:string,selected?:string|'legacy'):Promise<ReviewState>{return transaction(this.pool,async db=>{const c=await authorizeCase(db,actor,caseId,'case:read',false);return this.stateIn(db,actor,c,selected);});}
  async checklist(actor:Actor,caseId:string,selected?:string|'legacy'):Promise<ReviewChecklist>{return transaction(this.pool,async db=>{
    await db.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ');
    return this.checklistIn(db,actor,caseId,selected);
  });}
  /** Reuse checklist validity and frozen-round semantics in the case route's
   * existing transaction. Skip cases with no human field-review receipt. */
  async reviewedFields(db:PoolClient,actor:Actor,caseId:string):Promise<ChecklistRow[]>{
    const c=await authorizeCase(db,actor,caseId,'evidence:read',false);
    if(c.review_rounds_enabled&&!c.current_round_id)return [];
    if(!await savedFieldReview(db,caseId,c.current_round_id??null,c.revision))return [];
    return (await this.checklistIn(db,actor,caseId)).rows;
  }
  private async checklistIn(db:PoolClient,actor:Actor,caseId:string,selected?:string|'legacy'):Promise<ReviewChecklist>{
    const c=await authorizeCase(db,actor,caseId,'evidence:read',false),state=await this.stateIn(db,actor,c,selected,'checklist');
    const release=state.configurationReleaseId?await this.release(db,state.configurationReleaseId):null;
    const docs=await this.checklistDocuments(db,state,true);
    // The checklist needs derived facts, but not the workspace's signature and
    // material-detail panels. Derive from these same documents once, before
    // display corrections, as the full state projection does.
    if(!state.readOnly&&release)state.facts.push(...buildChecklist(release.manifest,state,docs,!state.readOnly).flatMap(row=>row.fact?.automaticAdoption?[row.fact]:[]));
    const fieldRecord=await savedFieldReview(db,caseId,state.roundId??null,state.revision);
    const displayDocs=docs.map(d=>({...d,fields:correctedFieldDisplay(d.fields,fieldRecord?pinnedFieldCorrections(fieldRecord.details.input,state.configurationReleaseId,d):[])}));
    let rows=release?buildChecklist(release.manifest,state,displayDocs,!state.readOnly):[];
    let frozen:ReviewSnapshot|undefined;
    if(state.readOnly){
      frozen=state.runs[0]?(await db.query('SELECT snapshot FROM business.review_runs WHERE id=$1 AND case_id=$2',[state.runs[0].id,caseId])).rows[0]?.snapshot as ReviewSnapshot|undefined:undefined;
      if(release&&frozen?.requirementPolicy?.bankWorkbookOnly)rows=buildChecklist(release.manifest,state,displayDocs,true);
      rows=rows.map(row=>({...row,crossChecks:frozen?.crossFileChecklist?.find(r=>r.id===row.id)?.crossChecks}));
    }else if(release){rows=rows.filter(row=>!translationRequirementDisabled(row.fieldId,currentRequirementPolicy()));rows=await withPersonalLegalChecks(db,withCrossFileChecks(release.manifest,state,displayDocs,rows),release.manifest,displayDocs);rows=await preparePersonalChecklist(db,rows,release.manifest,state);if(this.options.crossFileAnalysis)rows=await this.options.crossFileAnalysis(db,actor,caseId,state.roundId??null,rows);}
    if(frozen?.fieldReviews)rows=rows.map(row=>({...row,verification:frozen.fieldReviews!.find(f=>f.id===row.id&&f.fieldId===row.fieldId&&f.objectId===row.objectId)?.verification}));
    else if(release){
      rows=await this.projectSavedFieldReview(db,state,release,rows,docs,fieldRecord);
      const current=state.runs.find(r=>r.state==='ready'&&r.validity==='current'&&r.caseRevision===state.revision);
      if(current){
        const snapshot=(await db.query('SELECT snapshot FROM business.review_runs WHERE id=$1 AND case_id=$2',[current.id,caseId])).rows[0]?.snapshot as ReviewSnapshot|undefined;
        if(snapshot?.automaticChecks)rows=rows.map(row=>{
          const saved=snapshot.fieldReviews?.find(f=>f.id===row.id&&f.fieldId===row.fieldId&&f.objectId===row.objectId)?.verification;
          return saved?.recordId.startsWith('corporate-bank-scope-v1:')||row.verification?.validity!=='current'?{...row,verification:saved??row.verification}:row;
        });
      }
    }
    rows=rows.filter(row=>!translationRequirementDisabled(row.fieldId,state.readOnly?frozen?.requirementPolicy:currentRequirementPolicy()));
    if(!state.readOnly&&release)rows=projectChecklistAutomatic(rows,await automaticReview(db,rows,release.manifest,Object.fromEntries(docs.map(d=>[d.id,d.filename])),state.revision,c.updated_at.toISOString()));
    rows=withUploadDateBaselines(rows,docs,state);
    if(release&&(!state.readOnly||frozen?.requirementPolicy?.bankWorkbookOnly))rows=withChecklistDocumentScope(rows,displayDocs,release.manifest,state);
    return {caseId,caseRevision:state.revision,roundId:state.roundId??null,roundNumber:state.roundNumber??null,configurationReleaseId:state.configurationReleaseId,
      readOnly:!!state.readOnly,rows,documents:docs.map(({fields,taxonomyIds,sourceNodes,unclassified,projectionCurrent,availableAnchorIds,sourceHash,invalidFieldIds,authorizationSignatures,uploadedAt,sourcePages,readingPages,readingAnchors,readingSourceSha256,logicalScopes,anchorPlacements,...d})=>d)};
  }
  private async projectSavedFieldReview(db:DB,state:ReviewState,release:ReviewConfigRelease,rows:ChecklistRow[],docs:ChecklistInputDocument[],fieldRecord:Awaited<ReturnType<typeof savedFieldReview>>){
    if(fieldRecord){
      let legacyFacts:Record<string,boolean>|undefined;
      if(!fieldRecord.details.basis){
        // Old receipts have no per-row digest. Reconstruct persisted business
        // inputs at their original revision; never rewrite the event or rebase it.
        const params=[state.caseId,state.roundId??null,fieldRecord.case_revision];
        const objects=(await db.query('SELECT DISTINCT ON(object_id) * FROM business.review_object_versions WHERE case_id=$1 AND round_id IS NOT DISTINCT FROM $2::uuid AND case_revision<=$3 ORDER BY object_id,version DESC',params)).rows.map(objectView);
        const facts=(await db.query('SELECT DISTINCT ON(fact_id) * FROM business.review_fact_versions WHERE case_id=$1 AND round_id IS NOT DISTINCT FROM $2::uuid AND case_revision<=$3 ORDER BY fact_id,version DESC',params)).rows.map(factView);
        legacyFacts=Object.fromEntries(rows.map(row=>[row.id,fieldReviewFactBasis(row,{objects,facts},release.manifest)===fieldReviewFactBasis(row,state,release.manifest)]));
      }
      rows=projectFieldReview(rows,fieldRecord,docs,state.configurationReleaseId,state.revision,{basis:fieldReviewBasis(rows,docs,state,release.manifest,fieldRecord.details.input),legacyFacts});
    }
    return state.readOnly?rows:personalAutomaticReview(db,rows,release.manifest,Object.fromEntries(docs.map(d=>[d.id,d.filename])),state.revision);
  }
  /** Current raw comparison inputs, using the caller's transaction and authorization. */
  async crossFileContext(db:DB,actor:Actor,caseId:string){
    const c=await authorizeCase(db,actor,caseId,'evidence:read',false),state=await this.stateIn(db,actor,c);
    const release=state.configurationReleaseId?await this.release(db,state.configurationReleaseId):null;
    const docs=await this.checklistDocuments(db,state,true);
    const record=release?.manifest.guaranteeTypes.includes('personal_guarantee')?await savedFieldReview(db,caseId,state.roundId??null,state.revision):null;
    const displayDocs=record?docs.map(d=>({...d,fields:correctedFieldDisplay(d.fields,pinnedFieldCorrections(record.details.input,state.configurationReleaseId,d))})):docs;
    let rows=release?await withPersonalLegalChecks(db,withCrossFileChecks(release.manifest,state,docs,buildChecklist(release.manifest,state,docs,!state.readOnly)),release.manifest,docs):[];
    if(release){
      if(record){const corrected=await withPersonalLegalChecks(db,withCrossFileChecks(release.manifest,state,displayDocs,buildChecklist(release.manifest,state,displayDocs,!state.readOnly)),release.manifest,displayDocs);rows=rows.map(row=>row.objectRole==='personal_guarantee'?corrected.find(other=>other.id===row.id)??row:row);}
      rows=await preparePersonalChecklist(db,rows,release.manifest,state);
    }
    if(release&&!state.readOnly)rows=withChecklistDocumentScope(rows,docs,release.manifest,state);
    return {state,rows};
  }
  private async checklistDocuments(db:DB,state:Pick<ReviewState,'caseId'|'roundId'|'readOnly'|'roundsEnabled'|'legacyView'|'materials'>,includeDateSources=false):Promise<ChecklistInputDocument[]> {
    const caseId=state.caseId;
    const docs:ChecklistInputDocument[]=[];
    // Reviewer-confirmed values for fields the extraction left empty; pinned to the parse they were read from.
    const supplied=await suppliedFieldValues(db,caseId,state.roundId??null);
    const frozenPending:PendingReviewMaterial[]=state.readOnly?(await fixedMaterialSnapshot(db,caseId,state.roundId??null))?.pendingMaterials??[]:[];
    const empty=state.roundsEnabled&&!state.roundId&&!state.legacyView;
    const included=empty?[]:await materialListIds(db,caseId,state.roundId??null);
    const rows=empty?[]:(await db.query(`SELECT d.id,d.filename,d.parse_status,d.current_parse_job_id,d.created_at,d.sha256 FROM business.document_versions d
      JOIN business.upload_sessions u ON u.id=d.upload_session_id WHERE d.case_id=$1 AND d.round_id IS NOT DISTINCT FROM $2::uuid
      AND u.state='registered' AND u.document_version_id=d.id ORDER BY d.id`,[caseId,state.roundId??null])).rows;
    for(const row of rows){
      if(included!==null&&!included.includes(row.id))continue;
      const choices=state.materials.filter(m=>m.documentVersionId===row.id),adopted=choices.filter(m=>m.operation==='adopt');
      // Submitted rounds expose only pinned evidence, never a newer parse or projection.
      if(state.readOnly&&!adopted.length){
        const pending=frozenPending.find(p=>p.documentVersionId===row.id);
        if(pending)docs.push({id:row.id,filename:row.filename,parseRevision:null,directoryRevision:null,state:pending.processingState,adopted:false,projectionCurrent:false,
          taxonomyIds:pending.taxonomyIds,unclassified:pending.unclassified,fields:[],sourceNodes:{}});
        continue;
      }
      const pin=adopted[0],parseId=pin?.parseRevision??row.current_parse_job_id;
      const artifact=parseId?(await db.query(`SELECT jsonb_build_object(${DOCUMENT_CLASSIFICATION_PROJECTION},'fields',body->'fields',
        'anchors',body->'anchors','sourceAnchors',body->'sourceAnchors') AS body,sha256,directory_revision FROM business.document_artifacts WHERE job_id=$1
        AND ($2::integer IS NULL OR directory_revision=$2) ORDER BY directory_revision DESC LIMIT 1`,[parseId,pin?.directoryRevision??null])).rows[0]:null;
      if(pin?.artifactHash&&artifact?.sha256!==pin.artifactHash)throw new AppError(409,'review_material_reconfirmation_required');
      const projection=parseId&&artifact?await this.projection(db,row.id,parseId,artifact.directory_revision,pin?pin.projectionJobId:undefined):null;
      const latestProjection=!state.readOnly&&pin&&parseId&&artifact?await this.projection(db,row.id,parseId,artifact.directory_revision):projection;
      const projectionCurrent=!pin||adopted.every(material=>material.parseRevision===parseId&&material.directoryRevision===(artifact?.directory_revision??null)&&material.projectionHash===latestProjection?.hash&&material.projectionJobId===latestProjection?.jobId);
      const processing=!state.readOnly&&parseId?(await db.query("SELECT state FROM business.document_jobs WHERE document_version_id=$1 AND kind='extract_fields' AND validity='current' AND input->>'parseRevision'=$2 ORDER BY created_at DESC,id DESC LIMIT 1",[row.id,parseId])).rows[0]?.state:null;
      if(state.readOnly&&!projectionCurrent)throw new AppError(409,'review_projection_changed');
      const body=artifact?.body;
      const observations=projection?.items.length?projection.items:body?.fields??[];
      // A malformed legacy receipt must neither become usable nor block the
      // entire case read/command response. Keep the doubt on the affected field.
      const invalidFieldIds:string[]=[],fields:DocumentFieldObservation[]=[];
      for(const observation of Array.isArray(observations)?observations:[null]){
        const parsed=DocumentFieldObservationSchema.safeParse(observation);
        if(parsed.success)fields.push(parsed.data);
        else invalidFieldIds.push(typeof observation?.fieldId==='string'?observation.fieldId:'*');
      }
      const logicals=body?.logicalDocuments??[];
      let authorizationSignatures:ChecklistInputDocument['authorizationSignatures'];
      let sourcePages:ChecklistInputDocument['sourcePages']=body?.pages;
      if(includeDateSources&&!state.readOnly&&parseId&&artifact&&logicals.some((l:any)=>['cgt_resolution','cgt_guarantee','cgt_incorporation'].includes(l.labelId))){
        try{
          const context=await signatureSourceContext(db,{id:caseId},row.id,parseId,undefined,artifact.directory_revision);
          sourcePages=context.sourcePages;
          const resolutions=context.bundle.logicalDocuments.filter(l=>['cgt_resolution','cgt_guarantee'].includes(l.labelId??'')&&['candidate','confirmed'].includes(l.status));
          const pages=(resolutions.length===1?[...new Set(resolutions[0]!.pageNumbers)]:[])
            .filter(page=>context.bundle.logicalDocuments.filter(l=>l.pageNumbers.includes(page)).every(l=>l.labelId===resolutions[0]?.labelId));
          authorizationSignatures={automatic:automaticSignaturesFromContext(context),pages,sourceSha256:context.doc.sha256};
        }catch(error){
          // Incomplete source artifacts remain missing evidence, not a failed case read.
          if(!(error instanceof AppError)||!['parse_not_available','index_not_ready','signature_source_incomplete','signature_source_mismatch'].includes(error.code))throw error;
        }
      }
      let readingPages:ChecklistInputDocument['readingPages'];
      if(includeDateSources&&!state.readOnly&&projectionCurrent&&parseId&&fields.some(f=>(canInspectPersonalWorkbook(f)||f.candidates.length&&(canInspectPersonalName(f)||canInspectScopedSource(f)&&f.extractionCoverage?.reasonCodes.some(code=>['cloud_field_source_assembly_uncertain','cloud_field_source_assembly_elsewhere','cloud_field_source_unverified'].includes(code))))&&new Set(f.extractionCoverage!.reviewedPageNumbers).size>=(body?.pageCount??Infinity))){
        // Bound this read-only diagnosis; incomplete page sets never prove a scope.
        const pages=(await db.query(`WITH size AS (SELECT sum(octet_length(body::text)) AS bytes FROM business.document_pages WHERE job_id=$1)
          SELECT body FROM business.document_pages,size WHERE job_id=$1 AND size.bytes<=10000000 ORDER BY page_number`,[parseId])).rows.map(r=>r.body);
        const parsedPages=pages.map(page=>DocumentPageArtifactSchema.safeParse(page));
        if(pages.length===body?.pageCount&&parsedPages.every(result=>result.success))readingPages=parsedPages.flatMap(result=>result.success?[result.data]:[]);
      }
      const documentFields=withSuppliedFields(fields,supplied,{id:row.id,parseRevision:parseId??null,directoryRevision:artifact?.directory_revision??null});
      const logicalScopes:NonNullable<ChecklistInputDocument['logicalScopes']>=logicals.filter((logical:any)=>adopted.some(m=>!m.logicalDocumentId||m.logicalDocumentId===logical.id)).map((logical:any)=>({id:logical.id,pageNumbers:logical.pageNumbers??[],
        regionIds:logical.regionIds??[],...(logical.sourceNodeIds?{sourceNodeIds:logical.sourceNodeIds}:{}),wholePageNumbers:reviewScopeWholePages(logical,logicals),
        ...(adopted.some(m=>m.logicalDocumentId===logical.id)?{materialScope:{logicalDocumentId:logical.id}}:{})}));
      // Where candidate evidence sits, so automatic attribution applies the same scope check as starting a review.
      const cited=!state.readOnly&&logicalScopes.some(scope=>scope.materialScope)?new Set(documentFields.flatMap(f=>f.candidates.flatMap(c=>candidateRequiredEvidenceGroups(c).flat()))):new Set<string>();
      const anchorPlacements=new Map<string,{page_number:number;block_ids:string[]}>();
      for(const a of [...(body?.anchors??[]),...(projection?.anchors??[])])if(cited.has(a.anchor_id)&&a.document_version_id===row.id&&a.parse_revision===parseId&&!anchorPlacements.has(a.anchor_id))anchorPlacements.set(a.anchor_id,{page_number:a.page_number,block_ids:a.block_ids??[]});
      docs.push({id:row.id,filename:row.filename,parseRevision:parseId??null,directoryRevision:artifact?.directory_revision??null,
        logicalScopes,anchorPlacements,
        uploadedAt:row.created_at?.toISOString(),authorizationSignatures,readingSourceSha256:row.sha256,sourcePages:sourcePages??readingPages,readingPages,readingAnchors:readingPages?[...(body?.anchors??[]),...(projection?.anchors??[])]:undefined,
        state:state.readOnly?'ready':processing??row.parse_status,adopted:adopted.length>0,projectionCurrent,
        taxonomyIds:artifact?.body.classificationMode==='content-first-v1'?(fixedMaterialType(artifact.body)?[fixedMaterialType(artifact.body)!]:[]):[...new Set<string>(adopted.length?adopted.map(m=>m.documentTypeId):logicals.flatMap((l:any)=>l.labelId?[l.labelId]:[]))],
        unclassified:artifact?.body.classificationMode==='content-first-v1'?!fixedMaterialType(artifact.body):choices.some(m=>!m.logicalDocumentId)?false:!logicals.length||logicals.some((l:any)=>!l.labelId&&!choices.some(m=>m.logicalDocumentId===l.id)),
        fields:documentFields,
        invalidFieldIds,
        availableAnchorIds:[...new Set([...(body?.anchors??[]),...(projection?.anchors??[]),...(projection?.sourceAnchors??body?.sourceAnchors??[])].filter((a:any)=>a.document_version_id===row.id&&a.parse_revision===parseId).map((a:any)=>a.anchor_id))] as string[],
        sourceHash:projection?.hash??artifact?.sha256,
        sourceNodes:Object.fromEntries((projection?.sourceAnchors??body?.sourceAnchors??[]).map((a:any)=>[a.anchor_id,a.sourceNodeId]))});
    }
    return docs;
  }
  private async stateIn(db:DB,actor:Actor,original:any,selected?:string|'legacy',view:'full'|'checklist'='full'):Promise<ReviewState>{
    const c={...original},roundId=selected==='legacy'?null:selected??c.current_round_id??null;
    const round=roundId?(await db.query('SELECT * FROM business.review_rounds WHERE id=$1 AND case_id=$2',[roundId,c.id])).rows[0]:null;
    if(roundId&&!round)throw new AppError(404,'review_round_not_found');
    const empty=c.review_rounds_enabled&&!roundId&&selected!=='legacy';
    const readOnly=!!c.closed_at||checkerCorrectionActive(c)&&c.checker_person_id!==actor.personId||!!c.review_rounds_enabled&&(empty||roundId!==c.current_round_id||round?.state!=='draft');
    if(round){c.configuration_release_id=round.configuration_release_id;c.review_business_date=round.business_date;}
    else if(selected==='legacy'&&c.review_rounds_enabled){c.configuration_release_id=c.legacy_review_context?.configurationReleaseId??null;c.review_business_date=c.legacy_review_context?.businessDate??null;}
    let values=empty?{objects:[],facts:[],materials:[]}:await this.values(db,c.id,roundId);const allowedActions:string[]=[];
    if(readOnly&&round?.run_id){const frozen=(await db.query('SELECT snapshot FROM business.review_runs WHERE id=$1',[round.run_id])).rows[0]?.snapshot;if(frozen)values={objects:frozen.objects,facts:frozen.facts,materials:frozen.materials};}
    if(await canEditReview(db,c,actor.personId))for(const action of ACTIONS.filter(a=>c.maker_person_id===actor.personId||['field:correct','finding:decide','case:start'].includes(a)))if(!c.closed_at&&(!readOnly||action==='finding:decide'&&roundId===c.current_round_id&&['submitted','locked'].includes(round?.state))&&await hasGrant(db,actor.personId,action,c.id))allowedActions.push(action);
    if(!readOnly&&this.options.documents&&c.maker_person_id===actor.personId&&await isEligibleMaker(db,actor.personId,c.id)&&await hasGrant(db,actor.personId,'document:parse',c.id))allowedActions.push('document:parse');
    if((await db.query("SELECT 1 FROM business.checker_submissions WHERE case_id=$1 AND state='submitted' AND validity='current' LIMIT 1",[c.id])).rowCount)allowedActions.splice(0,allowedActions.length);
    const runs=(await db.query('SELECT * FROM business.review_runs WHERE case_id=$1 AND round_id IS NOT DISTINCT FROM $2::uuid AND NOT $3::boolean ORDER BY created_at DESC,id DESC LIMIT 100',[c.id,roundId,empty])).rows.map(r=>({id:r.id,caseRevision:r.case_revision,configurationReleaseId:r.configuration_release_id,snapshotHash:r.snapshot_hash,state:r.state,validity:r.validity,errorCode:r.error_code,createdAt:r.created_at.toISOString(),results:r.results,executionReceipts:r.results.flatMap((result:any)=>result.execution?[{evaluationId:result.evaluationId,scopeId:result.scopeId,...result.execution,reusedFrom:result.reusedFrom}]:[])}));
    if(round?.state==='draft'&&runs.some(r=>r.validity==='current'&&['pending','running'].includes(r.state)))allowedActions.splice(0,allowedActions.length);
    const issues=(await db.query('SELECT i.*,f.receipt FROM business.review_issues i JOIN business.review_findings f ON f.id=i.latest_finding_id WHERE i.case_id=$1 AND i.round_id IS NOT DISTINCT FROM $2::uuid AND NOT $3::boolean ORDER BY i.created_at,i.id',[c.id,roundId,empty])).rows.map(r=>({issueId:r.id,version:r.version,ruleId:r.rule_id,scopeId:r.scope_id,status:r.status,validity:r.validity,latestFindingId:r.latest_finding_id,outcome:r.receipt.result.outcome,reasonCode:r.receipt.result.reasonCode,evidenceIds:r.receipt.result.evidenceIds,caseRevision:r.case_revision}));
    const history=(await db.query('SELECT * FROM business.review_events WHERE case_id=$1 AND round_id IS NOT DISTINCT FROM $2::uuid AND NOT $3::boolean ORDER BY created_at DESC,id DESC LIMIT 200',[c.id,roundId,empty])).rows.map(r=>({id:r.id,kind:r.kind,caseRevision:r.case_revision,actorPersonId:r.actor_person_id,createdAt:r.created_at.toISOString(),details:r.kind==='field_review_saved'?{reason:r.details.reason,itemCount:r.details.itemCount,correctionCount:r.details.correctionCount}:{...r.details,...(r.issue_id?{issueId:r.issue_id}:{})}}));
    const release=c.configuration_release_id?await this.release(db,c.configuration_release_id):null;
    const configuration=configurationView(release);
    const availableConfigurations=allowedActions.includes('case:configure')?(await db.query("SELECT release_id,manifest->>'label' AS label,manifest->'guaranteeTypes' AS guarantee_types,manifest->>'scope' AS scope,published_at FROM business.review_config_releases ORDER BY published_at DESC LIMIT 100")).rows.map(r=>({releaseId:r.release_id,label:r.label,guaranteeTypes:r.guarantee_types,scope:r.scope,publishedAt:r.published_at.toISOString()})):[];
    const supplements=(await db.query('SELECT * FROM business.review_supplements WHERE case_id=$1 AND round_id IS NOT DISTINCT FROM $2::uuid AND NOT $3::boolean ORDER BY created_at DESC LIMIT 100',[c.id,roundId,empty])).rows.map(r=>({id:r.id,issueId:r.issue_id,documentVersionId:r.document_version_id,parseRevision:r.parse_revision,fieldIds:r.field_ids,state:r.state,jobId:r.job_id,errorCode:r.error_code,createdAt:r.created_at.toISOString()}));
    const factRecords=(await db.query(`SELECT v.fact_id,v.version,v.body ? 'candidateRef' AS automatic,v.confirmed_by,${await canReadPeople(db)?'(SELECT display_name FROM auth.people WHERE id=v.confirmed_by)':'NULL'} AS confirmed_by_name,v.created_at,v.case_revision,
      EXISTS(SELECT 1 FROM business.review_events e WHERE e.case_id=v.case_id AND e.kind IN ('fact_confirmed','fact_corrected') AND e.details->>'factId'=v.fact_id::text AND e.details->>'version'=v.version::text) AS recorded
      FROM business.review_fact_versions v WHERE v.case_id=$1 AND v.round_id IS NOT DISTINCT FROM $2::uuid AND NOT $3::boolean ORDER BY v.case_revision DESC LIMIT 2000`,[c.id,roundId,empty])).rows.map(r=>({factId:r.fact_id,version:r.version,origin:r.automatic?'automatic_candidate' as const:r.recorded?'manual' as const:'unknown' as const,confirmedBy:r.confirmed_by,...(r.confirmed_by_name?{confirmedByName:r.confirmed_by_name}:{}),confirmedAt:r.created_at.toISOString(),caseRevision:r.case_revision}));
    const signatureInformation=empty||view==='checklist'?[]:readOnly&&round?.run_id?(await db.query('SELECT snapshot FROM business.review_runs WHERE id=$1 AND case_id=$2',[round.run_id,c.id])).rows[0]?.snapshot?.signatureInformation??[]:await signatureInformationSummaries(db,c,roundId,release?.manifest??null);
    const materialSources:ReviewMaterialSource[]=[],materialDetails:ReviewMaterialDetail[]=[];
    if(view==='full'&&!empty&&await hasGrant(db,actor.personId,'evidence:read',c.id)){
      const documents=(await db.query(`SELECT d.* FROM business.document_versions d JOIN business.upload_sessions u ON u.id=d.upload_session_id WHERE d.case_id=$1 AND d.round_id IS NOT DISTINCT FROM $2::uuid AND u.state='registered' AND u.document_version_id=d.id`,[c.id,roundId])).rows;
      for(const document of documents){
        const source=await this.materialSource(db,document);materialSources.push(source);
        for(const material of values.materials.filter(m=>m.documentVersionId===document.id)){
          const artifact=material.parseRevision?(await db.query(`SELECT body->'logicalDocuments' AS logical_documents FROM business.document_artifacts WHERE job_id=$1 AND directory_revision=$2`,[material.parseRevision,material.directoryRevision])).rows[0]:null;
          const logical=artifact?.logical_documents?.find((d:any)=>d.id===material.logicalDocumentId);
          const changed=['parseRevision','directoryRevision','artifactHash','sourceStructureHash','projectionHash','projectionJobId'].some(key=>material[key as keyof ReviewMaterial]!==source[key as keyof ReviewMaterialSource]);
          materialDetails.push({documentVersionId:material.documentVersionId,logicalDocumentId:material.logicalDocumentId,caseRevision:material.caseRevision,pageNumbers:logical?.pageNumbers??[],regionIds:logical?.regionIds??[],...(logical?.sourceNodeIds?{sourceNodeIds:logical.sourceNodeIds}:{}),...(logical?{wholePageNumbers:reviewScopeWholePages(logical,artifact.logical_documents)}:{}),updateState:readOnly||!changed?'current':!source.ready?'processing':material.logicalDocumentId&&(!logical||!sameLogicalExtent(logical,source.scopes.find(scope=>scope.id===material.logicalDocumentId)))?'scope_missing':'available'});
        }
      }
    }
    const scopeIds=empty?[]:await materialListIds(db,c.id,roundId);
    const guidance=await loadCaseGuidance(db,c.id);
    const state:ReviewState={...(guidance.length?{guidance}:{}),...(scopeIds!==null?{materialScope:'file-list' as const,materialCount:scopeIds.length}:{}),materialSources,materialDetails,signatureInformation,roundId,roundNumber:round?.number??null,roundsEnabled:!!c.review_rounds_enabled,legacyView:selected==='legacy',readOnly,guaranteeTypes:release?.manifest.guaranteeTypes??[],factRecords,caseId:c.id,revision:c.revision,configurationReleaseId:c.configuration_release_id??null,businessDate:c.review_business_date??null,...values,runs,issues,history,supplements,allowedActions,configuration,availableConfigurations};
    if(view==='full'&&!readOnly&&release&&await hasGrant(db,actor.personId,'evidence:read',c.id)){
      const documents=await this.checklistDocuments(db,state);
      state.facts.push(...buildChecklist(release.manifest,state,documents).flatMap(row=>row.fact?.automaticAdoption?[row.fact]:[]));
    }
    if(view==='full' && release && !readOnly){
      const pendingMaterials=await pendingReviewMaterials(db,c.id,values.materials,roundId);
      const snapshot:ReviewSnapshot={requirementPolicy:currentRequirementPolicy(),schemaVersion:'p3-review.v2',caseId:c.id,caseRevision:c.revision,
        businessDate:state.businessDate??'',configurationReleaseId:release.releaseId,manifestHash:release.manifestHash,
        packageHash:release.packageHash,...values,materialScope:state.materialScope,pendingMaterials};
      state.materialPreparation=materialPreparation(release.manifest,values.objects,buildRuleInstances(snapshot,release),snapshot.requirementPolicy);
    }
    return state;
  }
  private async command(actor:Actor,caseId:string,action:string,operation:string,input:z.infer<typeof ReviewCommandSchema>,fn:(db:PoolClient,c:any)=>Promise<void>){return transaction(this.pool,async db=>{
    const c=await this.maker(db,actor,caseId,action);
    await idempotent(db,actor,`review.${operation}:${caseId}`,input.idempotencyKey,input,async()=>{
      if(c.revision!==input.expectedRevision)throw new AppError(409,'stale_revision');
      await assertRoundRequest(db,c,input.roundId,{draft:(ROUND_INPUT_ACTIONS as readonly string[]).includes(action)});
      await fn(db,c);
      if(['field:correct','material:adopt','finding:decide','case:configure','case:start','document:parse'].includes(action)){
        await db.query('INSERT INTO business.contributions(id,case_id,person_id,kind) VALUES($1,$2,$3,$4)',[randomUUID(),caseId,actor.personId,checkerCorrectionActive(c,actor.personId)?'checker_correction':`review_${operation.split(':')[0]}`]);
        await invalidateCheckerContent(db,caseId);
      }
      if(['field:correct','finding:decide','case:start'].includes(action)&&c.maker_person_id!==actor.personId){
        await this.event(db,actor,c,'checker_correction',{reason:input.reason,reviewRole:'checker'});
      }
      return {revision:c.revision};
    });
    return this.stateIn(db,actor,(await db.query('SELECT * FROM business.cases WHERE id=$1',[caseId])).rows[0]);
  });}
  async saveFieldReview(actor:Actor,caseId:string,raw:unknown){
    const input=SaveFieldReviewSchema.parse(raw);
    if(input.items.some(item=>item.scope==='bank_rule'))throw new AppError(422,'bank_review_server_generated_only');
    return this.command(actor,caseId,'field:correct','field_review',input,async(db,c)=>{
      if(input.configurationReleaseId!==c.configuration_release_id)throw new AppError(409,'field_review_configuration_changed');
      await assertNoInputWork(db,c,c.current_round_id??null);
      const state=await this.stateIn(db,actor,c),release=await this.release(db,c.configuration_release_id),docs=await this.checklistDocuments(db,state,true);
      const rows=await withPersonalLegalChecks(db,withCrossFileChecks(release.manifest,state,docs,buildChecklist(release.manifest,state,docs,!state.readOnly)),release.manifest,docs);
      await validateFieldReview(db,input,docs,rows);
      await this.advance(db,c);
      await this.event(db,actor,c,'field_review_saved',{input,basis:fieldReviewBasis(rows,docs,state,release.manifest,input),reason:input.reason,itemCount:input.items.length,correctionCount:input.corrections.length});
    });
  }
  private async confirmedSubjects(db:DB,caseId:string,roundId:string|null):Promise<{confirmedAt:string;subjects:ConfirmedSubject[]}|null>{
    const row=(await db.query("SELECT details,created_at FROM business.review_events WHERE case_id=$1 AND round_id IS NOT DISTINCT FROM $2::uuid AND kind='subjects_confirmed' ORDER BY created_at DESC,id DESC LIMIT 1",[caseId,roundId])).rows[0];
    return row?{confirmedAt:new Date(row.created_at).toISOString(),subjects:row.details.subjects as ConfirmedSubject[]}:null;
  }
  /** Who the round's subjects may be, and what the reviewer has confirmed so far. Reads only. */
  async subjects(actor:Actor,caseId:string,selected?:string|'legacy'):Promise<SubjectConfirmationState>{return transaction(this.pool,async db=>{
    // Signature summaries and per-file material details are not needed here; the checklist view keeps the read short,
    // since every read of one person waits for that person's earlier reads to finish.
    const c=await authorizeCase(db,actor,caseId,'case:read',false),state=await this.stateIn(db,actor,c,selected,'checklist');
    if(!state.configurationReleaseId||!this.options.subjectConfirmation)return {editable:false,roles:[],confirmed:null,candidates:[]};
    const release=await this.release(db,state.configurationReleaseId),active=SUBJECT_ROLES.filter(role=>release.manifest.guaranteeTypes.includes(role as SubjectRole));
    const documents=await this.checklistDocuments(db,state);
    const editable=!state.readOnly&&!c.closed_at&&active.length>0&&state.allowedActions.includes('field:correct');
    return {editable,roles:active,confirmed:await this.confirmedSubjects(db,caseId,state.roundId??null),candidates:state.readOnly?[]:subjectCandidates(release.manifest,documents),
      revision:c.revision,inProgress:editable?await roundInputWork(db,caseId,c.current_round_id??null):[]};
  });}
  /** What still runs in the current round, for a dialog waiting to confirm subjects. Cheap enough to poll. */
  async subjectWork(actor:Actor,caseId:string):Promise<SubjectWorkState>{return transaction(this.pool,async db=>{
    const c=await authorizeCase(db,actor,caseId,'case:read',false);
    return {revision:c.revision,inProgress:this.options.subjectConfirmation?await roundInputWork(db,caseId,c.current_round_id??null):[]};
  });}
  /** Records the reviewer's decision on the round's subjects. Files are attached and compared from this decision on. */
  async confirmSubjects(actor:Actor,caseId:string,raw:unknown){
    const input=ConfirmSubjectsSchema.parse(raw);
    return this.command(actor,caseId,'field:correct','subjects',input,async(db,c)=>{
      await assertRoundRequest(db,c,input.roundId,{draft:true});await assertNoInputWork(db,c,c.current_round_id??null);
      const release=await this.release(db,c.configuration_release_id);
      if(input.subjects.some(subject=>!release.manifest.guaranteeTypes.includes(subject.role)))throw new AppError(422,'subject_role_not_in_configuration');
      const seen=new Set<string>();
      // One writing names one subject of a role: the same writing under two subjects could not attach a file to either.
      for(const subject of input.subjects)for(const name of new Set(subject.names.map(value=>value.normalize('NFKC').toUpperCase().replace(/\s+/gu,' ').trim()))){
        const id=`${subject.role}\u0000${name}`;if(seen.has(id))throw new AppError(422,'subject_name_duplicate');seen.add(id);
      }
      const previous=(await this.confirmedSubjects(db,caseId,c.current_round_id??null))?.subjects??[];
      // A subject keeps its identity across re-confirmation while its role and label stay the same.
      const subjects:ConfirmedSubject[]=input.subjects.map(subject=>({id:previous.find(old=>old.role===subject.role&&old.label===subject.label)?.id??randomUUID(),role:subject.role,label:subject.label,names:[...new Set([subject.label,...subject.names])]}));
      await this.advance(db,c);
      await this.event(db,actor,c,'subjects_confirmed',{subjects,reason:input.reason});
    });
  }
  /** Fills one field the extraction left empty in one file, from a passage of that file. Never overrides an extracted value. */
  async supplyFieldValue(actor:Actor,caseId:string,raw:unknown,options:{origin?:'assistant'|'manual';within?:(db:PoolClient,c:any)=>Promise<void>}={}){
    const input=SupplyFieldValueSchema.parse(raw);
    return this.command(actor,caseId,'field:correct',`field_supply:${input.documentId}:${input.fieldId}`,input,async(db,c)=>{
      await assertRoundRequest(db,c,input.roundId,{draft:true});await assertNoInputWork(db,c,c.current_round_id??null);
      const release=await this.release(db,c.configuration_release_id);
      if(!release.manifest.fields.some(field=>field.id===input.fieldId))throw new AppError(422,'field_not_in_configuration');
      const state=await this.stateIn(db,actor,c),doc=(await this.checklistDocuments(db,state)).find(item=>item.id===input.documentId);
      if(!doc||!doc.parseRevision||!doc.directoryRevision)throw new AppError(409,'field_value_document_unavailable');
      if(doc.parseRevision!==input.evidence.parseRevision||doc.directoryRevision!==input.evidence.directoryRevision)throw new AppError(409,'field_value_source_changed');
      if(!input.replace&&!fieldIsEmpty(doc.fields,input.fieldId))throw new AppError(409,'field_value_present');
      const page=await verifySuppliedQuote(db,input);
      await this.advance(db,c);
      await this.event(db,actor,c,'field_value_supplied',{documentId:input.documentId,fieldId:input.fieldId,value:input.value,quote:input.quote,evidence:input.evidence,page,
        parseRevision:doc.parseRevision,directoryRevision:doc.directoryRevision,configurationReleaseId:c.configuration_release_id,origin:options.origin??'manual',reason:input.reason,
        ...(input.replace?{replace:true}:{})});
      await options.within?.(db,c);
    });
  }
  async withdrawFieldValue(actor:Actor,caseId:string,raw:unknown){
    const input=WithdrawFieldValueSchema.parse(raw);
    return this.command(actor,caseId,'field:correct',`field_withdraw:${input.documentId}:${input.fieldId}`,input,async(db,c)=>{
      await assertRoundRequest(db,c,input.roundId,{draft:true});await assertNoInputWork(db,c,c.current_round_id??null);
      if(!(await suppliedFieldValues(db,caseId,c.current_round_id??null)).some(item=>item.documentId===input.documentId&&item.fieldId===input.fieldId))throw new AppError(409,'field_value_not_supplied');
      await this.advance(db,c);
      await this.event(db,actor,c,'field_value_withdrawn',{documentId:input.documentId,fieldId:input.fieldId,reason:input.reason});
    });
  }
  async verifyPersonalFields(actor:Actor,caseId:string,raw:unknown){
    const command=ReviewCommandSchema.extend({rowId:z.string().min(1).max(500).optional()}).strict().parse(raw);
    return this.command(actor,caseId,'field:correct','personal_field_review',command,async(db,c)=>{
      await assertNoInputWork(db,c,c.current_round_id??null);
      const state=await this.stateIn(db,actor,c),release=await this.release(db,c.configuration_release_id);
      if(!release.manifest.guaranteeTypes.includes('personal_guarantee'))throw new AppError(422,'personal_guarantee_required');
      const docs=await this.checklistDocuments(db,state,true),prior=await savedFieldReview(db,caseId,state.roundId??null);
      const corrections=prior?docs.flatMap(d=>pinnedFieldCorrections(prior.details.input,state.configurationReleaseId,d)):[];
      const displayDocs=docs.map(d=>({...d,fields:correctedFieldDisplay(d.fields,corrections.filter(c=>c.documentId===d.id))}));
      let rows=await withPersonalLegalChecks(db,withCrossFileChecks(release.manifest,state,displayDocs,buildChecklist(release.manifest,state,displayDocs,!state.readOnly)),release.manifest,displayDocs);
      rows=await preparePersonalChecklist(db,rows,release.manifest,state);
      if(this.options.crossFileAnalysis)rows=await this.options.crossFileAnalysis(db,actor,caseId,state.roundId??null,rows);
      const selected=command.rowId?rows.filter(row=>row.id===command.rowId&&row.objectRole==='personal_guarantee'):rows;
      if(!selected.length)throw new AppError(409,'field_review_row_changed');
      const {rowId,...base}=command;
      const input=SaveFieldReviewSchema.parse({...base,configurationReleaseId:release.releaseId,pins:reviewPins(docs),
        items:await personalFieldReviewItems(db,selected,release.manifest,Object.fromEntries(docs.map(d=>[d.id,d.filename]))),corrections,
        provenance:{kind:'source_review',method:'personal_bank_workbook_v1',reference:'SRC-PG'}});
      await validateFieldReview(db,input,docs,rows);
      const basis=fieldReviewBasis(rows,docs,state,release.manifest,input);
      // Preserve other guarantees in mixed cases, including stale dependencies.
      // Never rebase an earlier record merely because another field was saved.
      if(prior){
        const ids=new Set(input.items.map(i=>i.rowId));
        for(const item of prior.details.input.items.filter(i=>!ids.has(i.rowId))){
          input.items.push(item);basis.rows[item.rowId]=prior.details.basis?.rows[item.rowId]??'legacy-unverified';
        }
      }
      SaveFieldReviewSchema.parse(input);
      await this.advance(db,c);
      await this.event(db,actor,c,'field_review_saved',{input,basis,reason:command.reason,itemCount:input.items.length,correctionCount:input.corrections.length});
    });
  }
  async bindConfiguration(actor:Actor,caseId:string,raw:unknown){const input=ReviewCommandSchema.extend({releaseId:z.string().min(1).max(100),guaranteeTypes:z.array(GuaranteeTypeSchema).max(5).optional()}).parse(raw);return this.command(actor,caseId,'case:configure','configuration',input,async(db,c)=>{const release=await this.release(db,input.releaseId);
    if(input.guaranteeTypes?.length&&(new Set(input.guaranteeTypes).size!==input.guaranteeTypes.length||[...input.guaranteeTypes].sort().join()!==[...release.manifest.guaranteeTypes].sort().join()))throw new AppError(422,'review_guarantee_types_mismatch');
    if(release.manifest.scenario!==c.scenario)throw new AppError(422,'review_configuration_scenario_mismatch');
    if(c.configuration_release_id===release.releaseId)return;
    const round=await currentRound(db,c);
    if(round&&round.number>1){
      const current=await this.release(db,c.configuration_release_id);
      if([...current.manifest.guaranteeTypes].sort().join()!==[...release.manifest.guaranteeTypes].sort().join())throw new AppError(409,'review_guarantee_types_locked');
    }
    await this.advance(db,c);
    const fields=new Map(release.manifest.fields.map(f=>[f.id,inputHash(f)]));for(const fact of (await db.query("SELECT id,field_id,body FROM business.review_fact_versions WHERE case_id=$1 AND round_id IS NOT DISTINCT FROM $2::uuid AND validity='current'",[caseId,c.current_round_id??null])).rows)if(fields.get(fact.field_id)!==fact.body.definitionHash)await db.query("UPDATE business.review_fact_versions SET validity='stale' WHERE id=$1",[fact.id]);
    await db.query('UPDATE business.cases SET configuration_release_id=$2 WHERE id=$1',[caseId,release.releaseId]);c.configuration_release_id=release.releaseId;if(c.current_round_id)await db.query('UPDATE business.review_rounds SET configuration_release_id=$2 WHERE id=$1',[c.current_round_id,release.releaseId]);await this.event(db,actor,c,'configuration_bound',{releaseId:release.releaseId,manifestHash:release.manifestHash,reason:input.reason});});}
  /** A confirmed judgement rule for this case. It changes semantic comparison inputs, so current results become stale. */
  async saveGuidance(actor:Actor,caseId:string,raw:unknown,options:{origin?:CaseGuidance['origin'];within?:(db:PoolClient,c:any,guidanceId:string)=>Promise<void>}={}){
    const input=SaveCaseGuidanceSchema.parse(raw);
    return this.command(actor,caseId,'finding:decide',`guidance:${input.replaces??'new'}`,input,async(db,c)=>{
      await assertRoundRequest(db,c,input.roundId,{draft:true});await assertRoundInputsOpen(db,c);
      const release=await this.release(db,c.configuration_release_id),body={kind:input.kind,statement:input.statement,fieldIds:input.fieldIds,expressions:input.expressions};
      validateGuidanceBody(release.manifest,body);
      const existing=await loadCaseGuidance(db,caseId),active=existing.filter(g=>g.status==='active');
      const replaced=input.replaces?active.find(g=>g.id===input.replaces):undefined;
      if(input.replaces&&!replaced)throw new AppError(409,'guidance_not_active');
      if(active.some(g=>g.id!==replaced?.id&&guidanceContentKey(g)===guidanceContentKey(body)))throw new AppError(409,'guidance_duplicate');
      if(active.length-(replaced?1:0)>=50)throw new AppError(409,'guidance_limit_reached');
      await this.advance(db,c);
      const id=randomUUID(),number=(existing.at(-1)?.number??0)+1;
      const origin=options.origin??{kind:'manual' as const,...(input.quote?{quote:input.quote}:{})};
      if(replaced)await db.query("UPDATE business.case_review_guidance SET status='retired',retired_by=$2,retired_account_id=$3,retired_at=now(),retire_reason=$4 WHERE id=$1 AND status='active'",[replaced.id,actor.personId,actor.accountId,`由本案规则 #${number} 替换`]);
      await db.query('INSERT INTO business.case_review_guidance(id,case_id,number,kind,body,body_hash,origin,supersedes,round_id,case_revision,created_by,account_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)',
        [id,caseId,number,body.kind,JSON.stringify(body),inputHash(body),JSON.stringify(origin),replaced?.id??null,c.current_round_id??null,c.revision,actor.personId,actor.accountId]);
      await this.event(db,actor,c,'guidance_saved',{guidanceId:id,number,kind:body.kind,statement:body.statement,replaces:replaced?.id??null,origin:origin.kind,reason:input.reason});
      if(options.within)await options.within(db,c,id);
    });
  }
  async retireGuidance(actor:Actor,caseId:string,guidanceId:string,raw:unknown){
    const input=RetireCaseGuidanceSchema.parse(raw);
    return this.command(actor,caseId,'finding:decide',`guidance-retire:${guidanceId}`,input,async(db,c)=>{
      await assertRoundRequest(db,c,input.roundId,{draft:true});await assertRoundInputsOpen(db,c);
      const row=(await db.query("SELECT number FROM business.case_review_guidance WHERE id=$1 AND case_id=$2 AND status='active' FOR UPDATE",[guidanceId,caseId])).rows[0];
      if(!row)throw new AppError(409,'guidance_not_active');
      await this.advance(db,c);
      await db.query("UPDATE business.case_review_guidance SET status='retired',retired_by=$2,retired_account_id=$3,retired_at=now(),retire_reason=$4 WHERE id=$1",[guidanceId,actor.personId,actor.accountId,input.reason]);
      await this.event(db,actor,c,'guidance_retired',{guidanceId,number:row.number,reason:input.reason});
    });
  }
  /** Explicit request (e.g. from the case assistant) to summarize this case's rules for the rule centre. */
  async requestGuidanceDigest(actor:Actor,caseId:string,raw:unknown){
    ReviewCommandSchema.pick({idempotencyKey:true}).parse(raw);
    return transaction(this.pool,async db=>{
      const c=await authorizeCase(db,actor,caseId,'case:read',true);
      if(!await hasGrant(db,actor.personId,'finding:decide',caseId))throw new AppError(403,'permission_denied');
      const release=await this.release(db,c.configuration_release_id);
      const run=(await db.query("SELECT id,round_id,snapshot,snapshot_hash FROM business.review_runs WHERE case_id=$1 AND state='ready' AND validity='current' ORDER BY created_at DESC LIMIT 1",[caseId])).rows[0];
      if(run&&inputHash(run.snapshot)!==run.snapshot_hash)throw new AppError(409,'review_snapshot_corrupt');
      const id=await recordGuidanceDigest(db,actor,{caseId,roundId:run?.round_id??c.current_round_id??null,runId:run?.id??null,snapshot:run?.snapshot??null,manifest:release.manifest,trigger:'manual'});
      if(!id)throw new AppError(409,'guidance_digest_nothing_to_propose');
      return digestView((await db.query(`${DIGEST_SELECT} WHERE d.id=$1`,[id])).rows[0],[]);
    });
  }
  async guidanceDigests(actor:Actor,caseId:string){return transaction(this.pool,async db=>{
    await authorizeCase(db,actor,caseId,'case:read',false);
    return {items:(await db.query(`${DIGEST_SELECT} WHERE d.case_id=$1 ORDER BY d.created_at DESC LIMIT 20`,[caseId])).rows.map(r=>digestView(r,[]))};
  });}
  /** Shared source validation, called within the caller's authorized case transaction. */
  /** `reads` is shared by the calls of one verification pass (see `EvidenceReads`); left out, every call reads afresh. */
  async validateEvidence(db:DB,caseId:string,evidence:ReviewEvidence[],reads:EvidenceReads=evidenceReads()){
    const once=<T>(seen:Map<string,Promise<T>>,key:string,read:()=>Promise<T>)=>{let value=seen.get(key);if(!value){value=read();seen.set(key,value);}return value;};
    const materials=reads.materials??=(await this.values(db,caseId)).materials.filter(m=>m.operation==='adopt');
    for(const e of evidence){
      const material=selectEvidenceMaterial(materials,e);
      await once(reads.current,JSON.stringify([material.documentVersionId,material.logicalDocumentId,material.parseRevision,material.directoryRevision,material.projectionJobId,material.projectionHash]),()=>this.assertCurrentMaterials(db,caseId,[material]));
      const artifact=e.directoryRevision!==null?await once(reads.artifacts,JSON.stringify([e.parseRevision,e.directoryRevision]),async()=>(await db.query('SELECT body FROM business.document_artifacts WHERE job_id=$1 AND directory_revision=$2',[e.parseRevision,e.directoryRevision])).rows[0]):null;
      const directory=artifact?.body.logicalDocuments??[],found=material.logicalDocumentId?directory.find((d:any)=>d.id===material.logicalDocumentId):null;
      const logical=found?{...found,wholePageNumbers:reviewScopeWholePages(found,directory)}:null;
      if(e.materialScope&&material.logicalDocumentId&&!logical)throw new AppError(409,'review_material_scope_changed');
      if(e.anchorId){
        if(e.directoryRevision===null)throw new AppError(422,'anchor_directory_required');
        const projection=await once(reads.projections,JSON.stringify([e.documentVersionId,e.parseRevision,e.directoryRevision,material.projectionJobId]),()=>this.projection(db,e.documentVersionId,e.parseRevision,e.directoryRevision!,material.projectionJobId));
        const anchor=[...(artifact?.body.anchors??[]),...projection.anchors].find((a:any)=>a.anchor_id===e.anchorId&&a.document_version_id===e.documentVersionId&&a.parse_revision===e.parseRevision);
        if(!anchor)throw new AppError(422,'evidence_anchor_invalid');
        if(e.materialScope&&logical&&!reviewEvidenceInScope(logical,anchor))throw new AppError(422,'evidence_outside_material_scope');
      }
      if(e.sourceNodeId){
        if(material.sourceFormat!=='docx')throw new AppError(422,'source_node_requires_docx');
        const source=await once(reads.sources,String(e.parseRevision),async()=>(await db.query('SELECT body FROM business.document_sources WHERE job_id=$1',[e.parseRevision])).rows[0]),node=source?.body.nodes?.find((n:any)=>n.id===e.sourceNodeId);
        if(!node)throw new AppError(422,'source_node_invalid');
        if(node.excludedFromVisibleFacts||node.visibility!=='visible')throw new AppError(422,'source_node_not_visible');
        if(e.materialScope&&logical&&!reviewEvidenceInScope(logical,undefined,e.sourceNodeId))throw new AppError(422,'evidence_outside_material_scope');
      }
    }
  }

  async confirmObject(actor:Actor,caseId:string,raw:unknown){const input=ReviewCommandSchema.extend(ReviewObjectSchema.shape).parse(raw);return this.command(actor,caseId,'field:correct','object',input,async(db,c)=>{
    await this.release(db,c.configuration_release_id);await this.validateEvidence(db,caseId,input.evidence);const objects=(await this.values(db,caseId)).objects;
    const old=input.objectId?objects.find(o=>o.objectId===input.objectId):undefined;if(input.objectId&&!old)throw new AppError(404,'review_object_not_found');
    if(input.companyNameSelection){
      if(input.kind!=='party'||!input.evidence.length)throw new AppError(422,'company_name_evidence_required');
      await validateCompanyNameSelection(db,caseId,c.revision,input.companyNameSelection,input.label);
    }
    // Existing name provenance stays frozen when unrelated object relations are edited.
    // A changed label without a new explicit selection is a manual correction.
    const adoptedName=input.companyNameSelection??(input.kind==='party'&&old?.label===input.label?old.companyNameSelection:undefined);
    const objectId=old?.objectId??randomUUID();if(input.relations.some(r=>r.targetObjectId===objectId||!objects.some(o=>o.objectId===r.targetObjectId)))throw new AppError(422,'object_relation_invalid');
    for(const relation of input.relations.filter(relation=>['same_entity','different_entity'].includes(relation.kind))){
      const target=objects.find(object=>object.objectId===relation.targetObjectId)!;
      if(input.kind!=='party'||target.kind!=='party')throw new AppError(422,'identity_party_objects_required');
      if(relation.kind==='same_entity'&&adoptedName&&target.companyNameSelection&&adoptedName.lei!==target.companyNameSelection.lei)throw new AppError(422,'identity_registration_conflict');
      if(!input.evidence.length||!target.evidence.length||target.validity!=='current')throw new AppError(422,'identity_evidence_required');
      if(relation.targetVersion!==undefined&&relation.targetVersion!==target.version)throw new AppError(409,'identity_target_version_stale');
      const opposite=relation.kind==='same_entity'?'different_entity':'same_entity';
      if(input.relations.some(other=>other.targetObjectId===target.objectId&&other.kind===opposite)||target.relations.some(other=>other.targetObjectId===objectId&&other.kind===opposite&&other.targetVersion===old?.version))throw new AppError(422,'identity_relation_conflict');
      relation.targetVersion=target.version;
    }
    await this.advance(db,c);const {expectedRevision,idempotencyKey,reason,roundId,...objectInput}=input;const body=ReviewObjectSchema.parse({...objectInput,...(adoptedName?{companyNameSelection:adoptedName}:{})});delete body.objectId;
    const version=old?.automaticAttribution?1:(old?.version??0)+1;
    await db.query('INSERT INTO business.review_object_versions(id,object_id,case_id,version,case_revision,body,confirmed_by,account_id,reason,round_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)',[randomUUID(),objectId,caseId,version,c.revision,JSON.stringify(body),actor.personId,actor.accountId,input.reason,c.current_round_id??null]);
    await this.event(db,actor,c,'object_confirmed',{objectId,version,reason:input.reason});
  });}
  async confirmFact(actor:Actor,caseId:string,raw:unknown){const input=ReviewCommandSchema.extend(ReviewFactSchema.shape).parse(raw);return this.command(actor,caseId,'field:correct','fact',input,async(db,c)=>{
    const release=await this.release(db,c.configuration_release_id),definition=release.manifest.fields.find(f=>f.id===input.fieldId);if(!definition)throw new AppError(422,'field_not_in_configuration');
    if(release.manifest.compatibility.executorVersion==='p3-deterministic-v3'&&input.fieldId==='review_business_date')throw new AppError(422,'review_business_date_readonly');
    if(definition.objectRole==='personal_guarantee'&&(PERSONAL_DERIVED_FIELDS as readonly string[]).includes(input.fieldId))throw new AppError(422,'review_derived_field_readonly');
    if(definition.objectRole==='personal_guarantee'&&input.state==='present'&&PERSONAL_FACT_OPTIONS[input.fieldId]&&!PERSONAL_FACT_OPTIONS[input.fieldId]!.some(option=>option.value===input.rawValue))throw new AppError(422,'personal_fact_option_invalid');
    if(definition.objectRole==='corporate_guarantee'&&['cgt_yes','cgt_rm_valid_option','cgt_resolution_minimum'].includes(input.fieldId))throw new AppError(422,'review_derived_field_readonly');
    const values=await this.values(db,caseId),object=values.objects.find(o=>o.objectId===input.objectId);if(!object||object.kind!==definition.objectKind||definition.objectRole&&object.role!==definition.objectRole||object?.validity==='stale')throw new AppError(422,'field_object_mismatch');
    // Independent user requirement; the author and reason remain audited.
    const personalAmountInput=definition.objectRole==='personal_guarantee'&&definition.id==='pg_required_amount'&&definition.recipe.mode==='manual'&&input.state==='present'&&!input.candidateRef;
    if(input.state!=='pending'&&!input.evidence.length&&!personalAmountInput)throw new AppError(422,'fact_evidence_required');
    if(input.state==='present'&&!input.rawValue?.trim())throw new AppError(422,'present_value_required');
    if(input.state!=='present'&&input.rawValue!==null&&input.rawValue!=='')throw new AppError(422,'non_present_value_forbidden');
    await this.validateEvidence(db,caseId,input.evidence);
    if(!reviewEvidenceBelongsToObject(object,input.evidence))throw new AppError(422,'fact_evidence_object_mismatch');
    if(input.candidateRef)await this.validateCandidate(db,caseId,input,definition.objectRole,release.manifestHash,release.manifest.fields);
    const old=input.factId?values.facts.find(f=>f.factId===input.factId):values.facts.find(f=>f.objectId===input.objectId&&f.fieldId===input.fieldId);
    if(input.factId&&!old)throw new AppError(404,'review_fact_not_found');if(old&&(old.objectId!==input.objectId||old.fieldId!==input.fieldId))throw new AppError(422,'fact_identity_immutable');
    const normal=normalizeReviewValue(input.state==='present'?input.rawValue:null,definition.type,{currency:input.currency??(definition.recipe.mode==='cloud_grounded_extract'?undefined:definition.currency??undefined),unit:input.unit??(definition.unit==='currency'?undefined:definition.unit??undefined),calendar:input.calendar,
      literalDateClock:definition.recipe.mode==='cloud_grounded_extract'&&definition.recipe.version==='azure-grounded-fields-v2',integerCount:release.manifest.compatibility.executorVersion==='p3-deterministic-v3'&&definition.unit==='persons'&&definition.currency===null});
    if(definition.type==='amount'&&definition.currency&&normal.currency&&normal.currency!==definition.currency){normal.value=null;normal.status='pending';normal.reasonCode='field_currency_mismatch';}
    const {value,...normalization}=normal,factId=old?.factId??randomUUID();await this.advance(db,c);const {expectedRevision,idempotencyKey,reason,roundId,...factInput}=input;const body={...ReviewFactSchema.parse(factInput),normalizedValue:value,normalization,definitionHash:inputHash(definition)};delete body.factId;
    await db.query('INSERT INTO business.review_fact_versions(id,fact_id,case_id,object_id,field_id,version,case_revision,body,confirmed_by,account_id,reason,round_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)',[randomUUID(),factId,caseId,input.objectId,input.fieldId,(old?.version??0)+1,c.revision,JSON.stringify(body),actor.personId,actor.accountId,input.reason,c.current_round_id??null]);
    await db.query('INSERT INTO business.contributions(id,case_id,person_id,kind) VALUES($1,$2,$3,$4)',[randomUUID(),caseId,actor.personId,checkerCorrectionActive(c,actor.personId)?'checker_correction':'fact_correction']);
    await this.event(db,actor,c,'fact_confirmed',{factId,version:(old?.version??0)+1,fieldId:input.fieldId,objectId:input.objectId,reason:input.reason});
  });}
  private async validateCandidate(db:DB,caseId:string,input:z.infer<typeof ReviewFactSchema>,objectRole?:string|null,configurationHash?:string,definitions?:ReviewFieldDefinition[]){
    const evidence=input.evidence[0];if(!evidence)throw new AppError(422,'candidate_evidence_required');const material=selectEvidenceMaterial((await this.values(db,caseId)).materials,evidence);
    if(!material||material.projectionHash!==input.candidateRef!.projectionHash)throw new AppError(409,'candidate_projection_stale');
    const projection=await this.projection(db,evidence.documentVersionId,evidence.parseRevision,evidence.directoryRevision,material.projectionJobId);if(projection.hash!==material.projectionHash)throw new AppError(409,'candidate_projection_stale');
    const field=projection.items.find((f:any)=>f.id===input.candidateRef!.observationId&&f.fieldId===input.fieldId),filter=field?.semanticFilter;
    const candidate=filter?.originalCandidates?.find((v:any)=>v.candidateId===input.candidateRef!.candidateId),decision=filter?.decisions?.find((v:any)=>v.candidateId===input.candidateRef!.candidateId);
    if(filter?.state!=='completed'||decision?.decision!=='selected'||!candidate||candidateAdoptionValue(candidate)!==input.rawValue)throw new AppError(422,'candidate_not_verified');
    if(candidate.roleEvidence&&(filter.version!=='azure-grounded-fields-v2'||candidate.roleEvidence.role!==objectRole))throw new AppError(422,'candidate_not_verified');
    if(candidate.authorizationEvidence){
      const {candidateId:_,...body}=candidate,checked=DocumentFieldCandidateSchema.safeParse(body),proof=candidate.authorizationEvidence;
      if(!checked.success||filter.version!=='azure-grounded-fields-v2'||proof.targetFieldId!==input.fieldId||
        proof.binding.documentVersionId!==material.documentVersionId||proof.binding.parseRevision!==material.parseRevision||
        proof.binding.sourceSha256!==material.sourceSha256||proof.binding.configurationSha256!==configurationHash||
        !projection.authorizationSource||inputHash(proof.binding)!==inputHash(projection.authorizationSource)||
        proof.sources.some((source:any)=>createHash('sha256').update(source.quote).digest('hex')!==source.textSha256)||
        proof.sourceCandidateIds.some((id:string)=>!projection.items.some((item:any)=>item.fieldId===proof.binding.scopeFieldId&&item.semanticFilter?.originalCandidates?.some((origin:any)=>
          origin.candidateId===id&&!origin.authorizationEvidence&&item.semanticFilter.decisions?.some((choice:any)=>choice.candidateId===id&&choice.decision==='selected')))))
        throw new AppError(422,'candidate_not_verified');
      const artifact=(await db.query('SELECT body FROM business.document_artifacts WHERE job_id=$1 AND directory_revision=$2',[material.parseRevision,material.directoryRevision])).rows[0];
      const directory=z.array(DocumentLogicalDocumentSchema).safeParse(artifact?.body?.logicalDocuments);
      const logical=directory.success?directory.data.find(item=>item.id===proof.logicalDocumentId):undefined;
      if(!logical||material.logicalDocumentId&&material.logicalDocumentId!==logical.id)throw new AppError(422,'candidate_not_verified');
      const pageRows=(await db.query('SELECT body FROM business.document_pages WHERE job_id=$1 AND page_number=ANY($2::int[]) ORDER BY page_number',[material.parseRevision,logical.pageNumbers])).rows;
      const pages=z.array(DocumentPageArtifactSchema).safeParse(pageRows.map(row=>row.body)),items=z.array(DocumentFieldObservationSchema).safeParse(projection.items);
      const binding=AuthorizationSourceBindingSchema.safeParse(projection.authorizationSource);
      if(!pages.success||!items.success||!binding.success||!definitions||
        !verifyAuthorizationSourceCandidate({fields:items.data,definitions,pages:pages.data,logicalDocuments:directory.success?directory.data:[],
          anchors:[...(artifact?.body?.anchors??[]),...projection.anchors],binding:binding.data,
          targetFields:{scope:binding.data.scopeFieldId,signingConditions:binding.data.signingConditionsFieldId}},candidate.candidateId,body))
        throw new AppError(422,'candidate_not_verified');
    }
    if(candidate.sourceCorrectionEvidence){
      const {candidateId:_,...body}=candidate,checked=DocumentFieldCandidateSchema.safeParse(body),proof=candidate.sourceCorrectionEvidence;
      if(!checked.success||filter.version!=='azure-grounded-fields-v2'||proof.targetFieldId!==input.fieldId||
        proof.binding.documentVersionId!==material.documentVersionId||proof.binding.parseRevision!==material.parseRevision||
        proof.binding.sourceSha256!==material.sourceSha256||proof.binding.configurationSha256!==configurationHash||
        !projection.sourceCorrection||inputHash(proof.binding)!==inputHash(projection.sourceCorrection))
        throw new AppError(422,'candidate_not_verified');
      const artifact=(await db.query('SELECT body FROM business.document_artifacts WHERE job_id=$1 AND directory_revision=$2',[material.parseRevision,material.directoryRevision])).rows[0];
      const directory=z.array(DocumentLogicalDocumentSchema).safeParse(artifact?.body?.logicalDocuments);
      const logical=directory.success?directory.data.find(item=>item.id===proof.logicalDocumentId):undefined;
      if(!logical||material.logicalDocumentId&&material.logicalDocumentId!==logical.id)throw new AppError(422,'candidate_not_verified');
      const pageRows=(await db.query('SELECT body FROM business.document_pages WHERE job_id=$1 AND page_number=ANY($2::int[]) ORDER BY page_number',[material.parseRevision,logical.pageNumbers])).rows;
      const pages=z.array(DocumentPageArtifactSchema).safeParse(pageRows.map(row=>row.body)),items=z.array(DocumentFieldObservationSchema).safeParse(projection.items);
      const binding=SourceCorrectionBindingSchema.safeParse(projection.sourceCorrection);
      if(!pages.success||!items.success||!binding.success||!definitions||
        !verifySourceCorrectionCandidate({fields:items.data,definitions,pages:pages.data,logicalDocuments:directory.success?directory.data:[],
          anchors:[...(artifact?.body?.anchors??[]),...projection.anchors],binding:binding.data},candidate.candidateId,body))
        throw new AppError(422,'candidate_not_verified');
    }
    if(candidate.tablePartyEvidence){
      const {candidateId:_,...body}=candidate,checked=DocumentFieldCandidateSchema.safeParse(body),proof=candidate.tablePartyEvidence;
      if(!checked.success||filter.version!=='azure-grounded-fields-v2'||proof.targetFieldId!==input.fieldId||
        proof.binding.documentVersionId!==material.documentVersionId||proof.binding.parseRevision!==material.parseRevision||
        proof.binding.sourceSha256!==material.sourceSha256||proof.binding.configurationSha256!==configurationHash||
        !projection.tablePartySource||inputHash(proof.binding)!==inputHash(projection.tablePartySource))
        throw new AppError(422,'candidate_not_verified');
      const artifact=(await db.query('SELECT body FROM business.document_artifacts WHERE job_id=$1 AND directory_revision=$2',[material.parseRevision,material.directoryRevision])).rows[0];
      const directory=z.array(DocumentLogicalDocumentSchema).safeParse(artifact?.body?.logicalDocuments);
      const logical=directory.success?directory.data.find(item=>item.id===proof.logicalDocumentId):undefined;
      if(!logical||material.logicalDocumentId&&material.logicalDocumentId!==logical.id)throw new AppError(422,'candidate_not_verified');
      const pageRows=(await db.query('SELECT body FROM business.document_pages WHERE job_id=$1 AND page_number=ANY($2::int[]) ORDER BY page_number',[material.parseRevision,logical.pageNumbers])).rows;
      const pages=z.array(DocumentPageArtifactSchema).safeParse(pageRows.map(row=>row.body)),items=z.array(DocumentFieldObservationSchema).safeParse(projection.items);
      const binding=SourceCorrectionBindingSchema.safeParse(projection.tablePartySource);
      if(!pages.success||!items.success||!binding.success||!definitions||
        !verifyTablePartyCandidate({fields:items.data,definitions,pages:pages.data,logicalDocuments:directory.success?directory.data:[],
          anchors:[...(artifact?.body?.anchors??[]),...projection.anchors],binding:binding.data},candidate.candidateId,body))
        throw new AppError(422,'candidate_not_verified');
    }
    if(filter.version==='azure-grounded-docx-v1'){
      if(material.sourceFormat!=='docx'||field.documentVersionId!==material.documentVersionId||field.parseRevision!==material.parseRevision)throw new AppError(422,'candidate_not_verified');
      const artifact=(await db.query('SELECT body FROM business.document_artifacts WHERE job_id=$1 AND directory_revision=$2',[material.parseRevision,material.directoryRevision])).rows[0];
      const source=(await db.query('SELECT body FROM business.document_sources WHERE job_id=$1',[material.parseRevision])).rows[0]?.body;
      const anchors=projection.sourceAnchors??artifact?.body?.sourceAnchors??[];
      const located=anchors.filter((a:any)=>decision.anchorIds.includes(a.anchor_id)&&a.document_version_id===material.documentVersionId&&a.parse_revision===material.parseRevision);
      if(!source||source.sourceSha256!==material.sourceSha256||located.length!==new Set(decision.anchorIds).size||
        input.evidence.some(e=>e.documentVersionId!==material.documentVersionId||e.parseRevision!==material.parseRevision||e.directoryRevision!==material.directoryRevision||e.anchorId||!located.some((a:any)=>a.sourceNodeId===e.sourceNodeId))||
        located.some((a:any)=>!input.evidence.some(e=>e.sourceNodeId===a.sourceNodeId)||!source.nodes.some((n:any)=>n.id===a.sourceNodeId&&!n.excludedFromVisibleFacts&&n.visibility==='visible'&&n.part===a.part&&n.path===a.path)))throw new AppError(422,'candidate_evidence_mismatch');
      if(candidateRequiredEvidenceGroups(candidate).some(group=>!group.some(id=>located.some((a:any)=>a.anchor_id===id))))throw new AppError(422,'candidate_evidence_mismatch');
      return;
    }
    if(input.evidence.some(e=>e.documentVersionId!==evidence.documentVersionId||!e.anchorId||!decision.anchorIds.includes(e.anchorId)))throw new AppError(422,'candidate_evidence_mismatch');
    if(candidateRequiredEvidenceGroups(candidate).some(group=>!group.some(id=>input.evidence.some(e=>e.anchorId===id))))throw new AppError(422,'candidate_evidence_mismatch');
  }
  private projection=materialProjection;
  async removeMaterials(actor:Actor,caseId:string,raw:unknown){
    const input=ReviewCommandSchema.extend({documentVersionIds:z.array(z.uuid()).min(1).max(2000)}).parse(raw);
    if(new Set(input.documentVersionIds).size!==input.documentVersionIds.length)throw new AppError(422,'duplicate_material_ids');
    return this.command(actor,caseId,'material:adopt','materials-remove',input,async(db,c)=>{
      const membership=await materialMembership(db,caseId,c.current_round_id??null);
      const documents=input.documentVersionIds.map(id=>membership.documents.find(d=>d.id===id));
      if(documents.some(d=>!d))throw new AppError(409,'material_not_in_current_list');
      for(const document of documents)await assertDocumentRound(db,c,document!.id);
      await this.advance(db,c);
      for(const document of documents){
        await invalidateReviewDependencies(db,caseId,{documentVersionId:document!.id,reason:'material_removed'});
        // No source bytes or historical receipts are deleted. Fence only work
        // producing inputs for these files, inside the case-locked transaction.
        const jobs=(await db.query(`UPDATE business.document_jobs SET state='canceled',validity='stale',updated_at=now()
          WHERE case_id=$1 AND document_version_id=$2 AND round_id IS NOT DISTINCT FROM $3::uuid
          AND state IN ('pending','running') AND required_action<>'evidence:read' RETURNING id`,[caseId,document!.id,c.current_round_id??null])).rows.map(r=>r.id);
        const supplements=(await db.query(`UPDATE business.review_supplements SET state='canceled',updated_at=now()
          WHERE case_id=$1 AND document_version_id=$2 AND round_id IS NOT DISTINCT FROM $3::uuid AND state IN ('pending','running') RETURNING id`,[caseId,document!.id,c.current_round_id??null])).rows.map(r=>r.id);
        await db.query("UPDATE business.work_items SET state='canceled',epoch=epoch+1,lease_until=NULL,updated_at=now() WHERE owner_id=ANY($1::uuid[]) AND state IN ('pending','running')",[[...jobs,...supplements]]);
        const previous=membership.decisions.find(m=>m.documentVersionId===document!.id);
        await this.materialEvent(db,actor,c,{documentVersionId:document!.id,documentTypeId:previous?.documentTypeId??'unclassified',logicalDocumentId:null,operation:'reject',
          sourceFormat:document!.source_format,sourceSha256:document!.sha256,parseRevision:null,directoryRevision:null,artifactHash:null,sourceStructureHash:null,
          projectionHash:null,projectionJobId:null,relation:{kind:'original'},caseRevision:c.revision},input.reason);
      }
      await this.event(db,actor,c,'materials_removed',{documentVersionIds:input.documentVersionIds,reason:input.reason});
    });
  }
  private async materialSource(db:DB,document:any):Promise<ReviewMaterialSource> {
    const parseRevision=document.current_parse_job_id as string|null;
    const artifact=parseRevision?(await db.query(`SELECT directory_revision,body->'logicalDocuments' AS logical_documents,sha256 FROM business.document_artifacts WHERE job_id=$1 ORDER BY directory_revision DESC LIMIT 1`,[parseRevision])).rows[0]:null;
    const source=parseRevision?(await db.query('SELECT sha256 FROM business.document_sources WHERE job_id=$1',[parseRevision])).rows[0]:null;
    const projection=parseRevision?await this.projection(db,document.id,parseRevision,artifact?.directory_revision??null):{hash:null,jobId:null,ready:false};
    const version={documentVersionId:document.id as string,parseRevision,directoryRevision:artifact?.directory_revision??null,artifactHash:artifact?.sha256??null,sourceStructureHash:source?.sha256??null,projectionHash:projection.hash,projectionJobId:projection.jobId};
    return {...version,filename:document.filename,snapshotHash:inputHash(version),ready:Boolean((artifact||source)&&projection.ready),scopes:(artifact?.logical_documents??[]).map((d:any)=>({id:d.id,pageNumbers:d.pageNumbers??[],regionIds:d.regionIds??[],...(d.sourceNodeIds?{sourceNodeIds:d.sourceNodeIds}:{})}))};
  }
  async material(actor:Actor,caseId:string,raw:unknown){
    const input=ReviewCommandSchema.extend(ReviewMaterialSchema.shape).parse(raw);
    return this.command(actor,caseId,'material:adopt','material',input,async(db,c)=>{
      const release=await this.release(db,c.configuration_release_id);
      if(!release.manifest.taxonomy.some(t=>t.id===input.documentTypeId))throw new AppError(422,'material_type_not_in_configuration');
      const document=(await db.query(`SELECT d.* FROM business.document_versions d JOIN business.upload_sessions u ON u.id=d.upload_session_id WHERE d.id=$1 AND d.case_id=$2 AND u.state='registered' AND u.document_version_id=d.id`,[input.documentVersionId,caseId])).rows[0];
      if(!document)throw new AppError(404,'material_not_found');
      await assertDocumentRound(db,c,document.id,{allowRemoved:true});
      const materials=(await db.query(currentMaterialDecisions,[caseId,c.current_round_id??null])).rows.map(row=>row.body as ReviewMaterial);
      const sameFile=materials.filter(m=>m.documentVersionId===document.id);
      const target=input.target?sameFile.find(m=>m.logicalDocumentId===input.target!.logicalDocumentId&&m.caseRevision===input.target!.caseRevision):undefined;
      if(input.target&&!target)throw new AppError(409,'review_material_target_stale');
      if(['edit','refresh'].includes(input.intent??'')&&!target)throw new AppError(422,'review_material_target_required');
      if(input.target&&!['edit','refresh'].includes(input.intent??''))throw new AppError(422,'review_material_target_invalid');
      if(input.intent==='add_scope'&&input.target)throw new AppError(422,'review_material_target_invalid');
      const scope=input.logicalDocumentId??null;
      const existing=sameFile.find(m=>m.logicalDocumentId===scope);
      if(input.intent==='refresh'&&(target!.operation!=='adopt'||input.operation!=='adopt'||scope!==target!.logicalDocumentId||input.documentTypeId!==target!.documentTypeId||inputHash(input.relation??{kind:'original'})!==inputHash(target!.relation??{kind:'original'})))throw new AppError(422,'review_material_refresh_settings_changed');
      if(input.intent==='add_scope'&&existing?.operation==='adopt'||target&&scope!==target.logicalDocumentId&&existing?.operation==='adopt')throw new AppError(409,'review_material_scope_exists');
      if(!target&&!existing&&sameFile.some(m=>m.operation==='adopt')&&input.intent!=='add_scope')throw new AppError(409,'review_material_add_scope_required');
      const latest=await this.materialSource(db,document);
      // Editing settings preserves the selected source. Only refresh/adopt can change source pins.
      const fixed=input.intent==='edit'?target!:latest;
      if(input.intent!=='edit'){
        if(input.intent&&!input.expectedSourceHash)throw new AppError(422,'review_material_source_required');
        if(input.expectedSourceHash&&input.expectedSourceHash!==latest.snapshotHash)throw new AppError(409,'review_material_source_changed');
        if(input.operation==='adopt'&&!latest.ready)throw new AppError(409,'material_evidence_not_ready');
      }
      const artifact=fixed.parseRevision?(await db.query('SELECT body FROM business.document_artifacts WHERE job_id=$1 AND directory_revision=$2',[fixed.parseRevision,fixed.directoryRevision])).rows[0]:null;
      if(input.operation==='adopt'&&artifact?.body.classificationMode==='content-first-v1'&&fixedMaterialType(artifact.body)!==input.documentTypeId)throw new AppError(409,'document_cloud_classification_conflict');
      if(input.operation==='adopt'&&scope&&(/^(display:|directory-view:)/.test(scope)||!artifact?.body.logicalDocuments.some((d:any)=>d.id===scope)))throw new AppError(422,input.intent==='refresh'?'review_material_scope_changed':'logical_document_invalid');
      if(input.intent==='refresh'&&scope){
        const previous=(await db.query('SELECT body FROM business.document_artifacts WHERE job_id=$1 AND directory_revision=$2',[target!.parseRevision,target!.directoryRevision])).rows[0]?.body.logicalDocuments?.find((d:any)=>d.id===scope);
        if(!previous||!sameLogicalExtent(previous,latest.scopes.find(d=>d.id===scope)))throw new AppError(422,'review_material_scope_changed');
      }
      const relationChanged=!target||inputHash(input.relation??{kind:'original'})!==inputHash(target.relation??{kind:'original'});
      if(input.operation==='adopt'&&input.intent!=='refresh'&&relationChanged&&input.relation&&input.relation.kind!=='original'){
        const prior=materials.find(m=>m.documentVersionId===input.relation!.predecessorDocumentVersionId&&m.operation==='adopt');
        if(!prior||prior.documentVersionId===document.id)throw new AppError(422,'material_predecessor_required');
        if(!input.relation.effectiveDate)throw new AppError(422,'material_effective_date_required');
        if(normalizeReviewValue(input.relation.effectiveDate,'date').value!==input.relation.effectiveDate||prior.relation?.effectiveDate&&input.relation.effectiveDate<prior.relation.effectiveDate)throw new AppError(422,'material_effective_date_invalid');
        if(input.relation.kind==='amendment'){
          if(!input.relation.sequence||input.relation.sequence!==(prior.relation?.sequence??0)+1)throw new AppError(422,'amendment_sequence_gap');
          if(materials.some(m=>m.operation==='adopt'&&m!==target&&m!==existing&&m.relation?.predecessorDocumentVersionId===prior.documentVersionId&&m.relation?.sequence===input.relation!.sequence))throw new AppError(409,'amendment_sequence_conflict');
        }
      }
      await this.advance(db,c);
      if(target&&scope!==target.logicalDocumentId){
        await this.materialEvent(db,actor,c,{...target,operation:'reject',caseRevision:c.revision},input.reason);
        await invalidateReviewDependencies(db,caseId,{documentVersionId:document.id,logicalDocumentId:target.logicalDocumentId,reason:'material_scope_changed'});
      }
      if(input.operation==='adopt'&&input.intent!=='refresh'&&relationChanged&&input.relation?.kind==='replacement'){
        for(const prior of materials.filter(m=>m.documentVersionId===input.relation!.predecessorDocumentVersionId&&m.operation==='adopt'))await this.materialEvent(db,actor,c,{...prior,operation:'superseded',caseRevision:c.revision},input.reason);
      }
      if(input.operation==='reject'||input.intent==='refresh'||input.intent==='edit')await invalidateReviewDependencies(db,caseId,{documentVersionId:document.id,logicalDocumentId:scope,reason:input.operation==='reject'?'material_rejected':'material_source_confirmed'});
      const material:ReviewMaterial={documentVersionId:document.id,documentTypeId:input.documentTypeId,logicalDocumentId:scope,operation:input.operation,sourceFormat:document.source_format,sourceSha256:document.sha256,parseRevision:fixed.parseRevision,directoryRevision:fixed.directoryRevision,artifactHash:fixed.artifactHash,sourceStructureHash:fixed.sourceStructureHash,projectionHash:fixed.projectionHash,projectionJobId:fixed.projectionJobId,relation:input.relation??{kind:'original'},caseRevision:c.revision};
      await this.materialEvent(db,actor,c,material,input.reason);
      await this.event(db,actor,c,input.intent==='refresh'?'material_source_confirmed':`material_${input.operation}`,{documentVersionId:document.id,logicalDocumentId:scope,previousScope:target?.logicalDocumentId,previousRevision:target?.caseRevision,parseRevision:fixed.parseRevision,reason:input.reason});
    });
  }
  private async materialEvent(db:DB,actor:Actor,c:any,material:ReviewMaterial,reason:string){await db.query('INSERT INTO business.review_material_events(id,case_id,document_version_id,case_revision,body,actor_person_id,account_id,reason,round_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)',[randomUUID(),c.id,material.documentVersionId,c.revision,JSON.stringify(material),actor.personId,actor.accountId,reason,c.current_round_id??null]);}
  private async accept(db:PoolClient,actor:Actor,c:any){
    // Only an explicit start creates a frozen review; corrections never grant or trigger execution.
    await this.maker(db,actor,c.id,'case:start');const release=await this.release(db,c.configuration_release_id),values=await this.values(db,c.id);
    if(!c.review_business_date)throw new AppError(409,'review_business_date_required');
    const round=await currentRound(db,c),fileList=await usesFileListScope(db,c.id,c.current_round_id??null);const materials=fileList?values.materials.filter(m=>m.operation==='adopt'):effectiveReviewMaterials(values.materials,c.review_business_date),factRows=(await db.query('SELECT * FROM business.review_fact_versions WHERE case_id=$1 AND round_id IS NOT DISTINCT FROM $2::uuid ORDER BY fact_id,version DESC',[c.id,c.current_round_id??null])).rows;
    const factVersions=new Map<string,ReviewFact[]>();for(const row of factRows){const fact=factView(row);factVersions.set(fact.factId,[...(factVersions.get(fact.factId)??[]),fact]);}
    const facts=[...factVersions.values()].map(versions=>{const latest=versions[0]!;return latest.evidence.every(e=>materials.some(m=>m.documentVersionId===e.documentVersionId&&m.parseRevision===e.parseRevision&&m.directoryRevision===e.directoryRevision))?latest:{...latest,validity:'stale' as const};});
    const snapshot:ReviewSnapshot={requirementPolicy:currentRequirementPolicy(),...(fileList?{materialScope:'file-list' as const}:{}),schemaVersion:round?'p3-review.v2':'p3-review.v1',...(round?{roundId:round.id,roundNumber:round.number}:{}),caseId:c.id,caseRevision:c.revision,businessDate:c.review_business_date,configurationReleaseId:release.releaseId,manifestHash:release.manifestHash,packageHash:release.packageHash,objects:values.objects,facts,materials};
    const guidance=await loadCaseGuidance(db,c.id),refs=guidanceRefs(release.manifest,guidance);
    if(refs.length)snapshot.guidance=refs;
    const inputState={caseId:c.id,revision:c.revision,configurationReleaseId:release.releaseId,roundId:round?.id??null,businessDate:c.review_business_date,readOnly:false,objects:values.objects,facts,materials,
      ...(guidance.length?{guidance}:{}),...(fileList?{materialScope:'file-list' as const}:{})} as ReviewState;
    const documents=await this.checklistDocuments(db,inputState,true);
    const fieldRecord=await savedFieldReview(db,c.id,round?.id??null,c.revision);
    const displayDocuments=documents.map(d=>({...d,fields:correctedFieldDisplay(d.fields,fieldRecord?pinnedFieldCorrections(fieldRecord.details.input,release.releaseId,d):[])}));
    const checklist=buildChecklist(release.manifest,inputState,displayDocuments,true).filter(row=>!translationRequirementDisabled(row.fieldId,snapshot.requirementPolicy));
    // One automatic value whose cited source cannot be located inside its adopted material is left out of this run and
    // recorded. Changed sources, artifacts and hashes still stop the start: those are checked for everything that is kept.
    const demoted:NonNullable<ReviewSnapshot['demotedAutomatic']>=[],reads=evidenceReads();
    for(const row of checklist){
      if(!row.fact?.automaticAdoption)continue;
      try{await this.validateEvidence(db,c.id,row.fact.evidence,reads);facts.push(row.fact);}
      catch(error){
        if(!(error instanceof AppError)||!DEMOTABLE_EVIDENCE_CODES.includes(error.code))throw error;
        demoted.push({kind:'fact',fieldId:row.fieldId,objectId:row.objectId,code:error.code});
        row.fact=null;row.status='pending_confirmation';row.reason='提取依据无法在当前采用的材料范围内定位，本轮未自动采用，请核对原文。';
      }
    }
    if(demoted.length)snapshot.demotedAutomatic=demoted;
    let crossRows=await withPersonalLegalChecks(db,withCrossFileChecks(release.manifest,inputState,displayDocuments,checklist),release.manifest,displayDocuments);
    crossRows=withChecklistDocumentScope(crossRows,displayDocuments,release.manifest,inputState);
    crossRows=await preparePersonalChecklist(db,crossRows,release.manifest,inputState);
    if(this.options.crossFileAnalysis)crossRows=await this.options.crossFileAnalysis(db,actor,c.id,round?.id??null,crossRows);
    const verifiedRows=await this.projectSavedFieldReview(db,inputState,release,crossRows,documents,fieldRecord);
    snapshot.reviewedInputs=await reviewedCorporateRuleInputs(db,verifiedRows,release.manifest,inputState,documents);
    snapshot.fieldReviews=verifiedRows.flatMap(({id,fieldId,label,objectId,objectLabel,materialTypes,verification})=>verification?[{id,fieldId,label,objectId,objectLabel,materialTypes,verification}]:[]);
    const automatic=await automaticReview(db,verifiedRows,release.manifest,Object.fromEntries(documents.map(d=>[d.id,d.filename])),c.revision,c.updated_at.toISOString());
    const automaticIds=new Set(automatic.fields.map(f=>f.id));
    snapshot.fieldReviews=[...snapshot.fieldReviews.filter(f=>!automaticIds.has(f.id)),...automatic.fields];
    const instances=buildRuleInstances(snapshot,release);
    const reviewedChecks=[...corporateReviewedChecks(verifiedRows,release.manifest,snapshot.reviewedInputs,c.review_business_date,instances),
      ...await corporateMaterialChecks(db,verifiedRows,release.manifest,snapshot.reviewedInputs,documents,c.review_business_date,instances,snapshot.requirementPolicy,
        this.options.documents?.reviewOriginalPdf?document=>this.options.documents!.reviewOriginalPdf!(db,actor,c.id,document.id,document.parseRevision!):undefined)];
    snapshot.automaticChecks=mergeCorporateScopeChecks(automatic.checks,reviewedChecks);
    snapshot.fieldReviews=projectCorporateScopeFields(snapshot.fieldReviews,snapshot.automaticChecks);
    snapshot.crossFileChecklist=crossRows.map(({id,fieldId,crossChecks})=>({id,fieldId,crossChecks}));
    if(fileList||release.manifest.compatibility.executorVersion==='p3-deterministic-v3'&&release.manifest.guaranteeTypes.some(type=>type==='corporate_guarantee'||type==='personal_guarantee')){
      snapshot.pendingMaterials=await pendingReviewMaterials(db,c.id,values.materials,c.current_round_id??null);
    }
    const signatureInformation=await signatureInformationSummaries(db,c,c.current_round_id??null,release.manifest);
    if(signatureInformation.length)snapshot.signatureInformation=signatureInformation;
    await this.assertCurrentMaterials(db,c.id,materials);
    await this.verifySnapshot(db,snapshot);
    const hash=inputHash(snapshot),existing=(await db.query('SELECT id,state FROM business.review_runs WHERE case_id=$1 AND case_revision=$2 AND snapshot_hash=$3',[c.id,c.revision,hash])).rows[0];
    if(existing){if(['failed','canceled','stale'].includes(existing.state)){
      await db.query("UPDATE business.review_runs SET state='pending',validity='current',error_code=NULL,account_id=$2,person_id=$3,auth_version=$4,session_key=$5,updated_at=now() WHERE id=$1",[existing.id,actor.accountId,actor.personId,actor.authVersion,actor.sessionKey??null]);
      const work=(await db.query("UPDATE business.work_items SET state='pending',epoch=epoch+1,lease_until=NULL,error_code=NULL,available_at=now(),updated_at=now() WHERE owner_type='Workflow' AND kind='p3_review' AND owner_id=$1 RETURNING id",[existing.id])).rows[0];
      await db.query('UPDATE business.outbox SET dispatched_at=NULL WHERE work_item_id=$1',[work.id]);await this.event(db,actor,c,'check_retry_requested',{runId:existing.id,snapshotHash:hash});
    }return existing.id;}
    // A changed readiness snapshot can exist at the same case revision (for
    // example a parse finishes asynchronously). Only the new check is current;
    // keep old receipts/history, but fence their workers and obsolete issues.
    await db.query("UPDATE business.review_runs SET validity='stale',state=CASE WHEN state IN ('pending','running') THEN 'stale' ELSE state END,updated_at=now() WHERE case_id=$1 AND round_id IS NOT DISTINCT FROM $2::uuid AND validity='current'",[c.id,c.current_round_id??null]);
    await db.query("UPDATE business.work_items SET state='canceled',epoch=epoch+1,lease_until=NULL WHERE owner_type='Workflow' AND kind='p3_review' AND owner_id IN(SELECT id FROM business.review_runs WHERE case_id=$1 AND round_id IS NOT DISTINCT FROM $2::uuid AND validity='stale') AND state IN ('pending','running')",[c.id,c.current_round_id??null]);
    await db.query("UPDATE business.review_issues SET validity='stale',updated_at=now() WHERE case_id=$1 AND round_id IS NOT DISTINCT FROM $2::uuid",[c.id,c.current_round_id??null]);
    const id=randomUUID(),workId=randomUUID();await db.query('INSERT INTO business.review_runs(id,case_id,case_revision,configuration_release_id,snapshot,snapshot_hash,account_id,person_id,auth_version,session_key,round_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)',[id,c.id,c.revision,release.releaseId,JSON.stringify(snapshot),hash,actor.accountId,actor.personId,actor.authVersion,actor.sessionKey??null,c.current_round_id??null]);
    await db.query("INSERT INTO business.work_items(id,owner_type,owner_id,kind,queue) VALUES($1,'Workflow',$2,'p3_review','workflow')",[workId,id]);
    await db.query("INSERT INTO business.outbox(id,work_item_id,event_type,owner_id) VALUES($1,$2,'work.available',$3)",[randomUUID(),workId,id]);
    await this.event(db,actor,c,'check_requested',{runId:id,snapshotHash:hash,configurationReleaseId:release.releaseId});return id;
  }
  async start(actor:Actor,caseId:string,raw:unknown){
    const input=ReviewCommandSchema.extend({reason:ReviewCommandSchema.shape.reason.default('按当前轮次材料自动开始预审'),businessDate:z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional()}).parse(raw);
    if(input.businessDate&&normalizeReviewValue(input.businessDate,'date').value!==input.businessDate)throw new AppError(422,'review_business_date_invalid');
    return this.command(actor,caseId,'case:start','start',input,async(db,c)=>{
      const round=await assertRoundRequest(db,c,input.roundId,{draft:true});if(round){await assertNoInputWork(db,c,round.id);await assertRoundInputsOpen(db,c);}
      // Compute inside the idempotent transaction: retries retain the first
      // accepted date, even across midnight. Explicit legacy dates still work.
      const businessDate=input.businessDate??new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Shanghai',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date());
      if(c.review_business_date&&c.review_business_date!==businessDate)await this.advance(db,c);
      await db.query('UPDATE business.cases SET review_business_date=$2 WHERE id=$1',[c.id,businessDate]);c.review_business_date=businessDate;
      const runId=await this.accept(db,actor,c);
      if(round)await db.query("UPDATE business.review_rounds SET business_date=$2,configuration_release_id=$3,run_id=$4,locked_revision=$5,submitted_at=now() WHERE id=$1",[round.id,businessDate,c.configuration_release_id,runId,c.revision]);
    });
  }
  async confirmRound(actor:Actor,caseId:string,roundId:string,raw:unknown){
    const input=ReviewCommandSchema.extend({runId:z.uuid(),snapshotHash:z.string().regex(/^[a-f0-9]{64}$/)}).parse({...z.record(z.string(),z.unknown()).parse(raw),roundId});
    return this.command(actor,caseId,'case:start',`confirm-round:${roundId}`,input,async(db,c)=>{
      const round=await assertRoundRequest(db,c,roundId,{draft:true});
      await assertNoInputWork(db,c,roundId);
      const run=(await db.query('SELECT * FROM business.review_runs WHERE id=$1 AND case_id=$2',[input.runId,caseId])).rows[0] as RunRow|undefined;
      if(!run||round?.run_id!==run.id||run.state!=='ready'||run.validity!=='current'||run.snapshot_hash!==input.snapshotHash||run.case_revision!==round.locked_revision)throw new AppError(409,'review_round_confirmation_stale');
      if(inputHash(run.snapshot)!==run.snapshot_hash)throw new AppError(409,'review_snapshot_corrupt');
      await this.validateCheckerSnapshot(db,run.snapshot);
      const pending=await pendingReviewMaterials(db,c.id,(await this.values(db,c.id,roundId)).materials,roundId);
      if(run.snapshot.pendingMaterials&&inputHash(pending)!==inputHash(run.snapshot.pendingMaterials))throw new AppError(409,'review_round_confirmation_stale');
      await db.query("UPDATE business.review_rounds SET state='submitted' WHERE id=$1",[roundId]);
      await db.query('UPDATE business.cases SET revision=revision+1,updated_at=now() WHERE id=$1',[caseId]);c.revision++;
      await this.event(db,actor,c,'round_result_confirmed',{roundId,runId:run.id,snapshotHash:run.snapshot_hash,checkerRequired:true,reason:input.reason});
      // Case rules relied on by this frozen run are summarized for the rule centre.
      // A digest failure never blocks the confirmation itself.
      await db.query('SAVEPOINT guidance_digest');
      try{await recordGuidanceDigest(db,actor,{caseId,roundId,runId:run.id,snapshot:run.snapshot,manifest:(await this.release(db,run.configuration_release_id)).manifest,trigger:'round_confirmed'});await db.query('RELEASE SAVEPOINT guidance_digest');}
      catch{await db.query('ROLLBACK TO SAVEPOINT guidance_digest');}
    });
  }
  async retryRound(actor:Actor,caseId:string,roundId:string,raw:unknown){
    const input=ReviewCommandSchema.parse({...z.record(z.string(),z.unknown()).parse(raw),roundId});
    return this.command(actor,caseId,'case:start',`retry-round:${roundId}`,input,async(db,c)=>{
      const round=await currentRound(db,c);if(!round||!['draft','locked'].includes(round.state)||!round.run_id)throw new AppError(409,'review_round_not_submitted');
      const run=(await db.query('SELECT * FROM business.review_runs WHERE id=$1 FOR UPDATE',[round.run_id])).rows[0] as RunRow;
      if(!['failed','canceled','stale'].includes(run.state))throw new AppError(409,'review_round_retry_unavailable');
      if(round.state==='draft'&&run.case_revision!==c.revision)throw new AppError(409,'review_round_confirmation_stale');
      await assertNoInputWork(db,c,roundId);if(inputHash(run.snapshot)!==run.snapshot_hash)throw new AppError(409,'review_snapshot_corrupt');
      await this.verifySnapshot(db,run.snapshot);
      await db.query("UPDATE business.review_runs SET state='pending',validity='current',error_code=NULL,account_id=$2,person_id=$3,auth_version=$4,session_key=$5,updated_at=now() WHERE id=$1",[run.id,actor.accountId,actor.personId,actor.authVersion,actor.sessionKey??null]);
      const work=(await db.query("UPDATE business.work_items SET state='pending',epoch=epoch+1,lease_until=NULL,error_code=NULL,available_at=now(),updated_at=now() WHERE owner_type='Workflow' AND kind='p3_review' AND owner_id=$1 RETURNING id",[run.id])).rows[0];
      if(!work)throw new AppError(409,'review_work_missing');await db.query('UPDATE business.outbox SET dispatched_at=NULL WHERE work_item_id=$1',[work.id]);
      await this.event(db,actor,c,'check_retry_requested',{runId:run.id,roundId,snapshotHash:run.snapshot_hash,reason:input.reason});
    });
  }
  async cancelRound(actor:Actor,caseId:string,roundId:string,raw:unknown){
    const input=ReviewCommandSchema.parse({...z.record(z.string(),z.unknown()).parse(raw),roundId});
    const runId=await transaction(this.pool,async db=>{const c=await this.maker(db,actor,caseId,'case:start');const round=await assertRoundRequest(db,c,roundId);if(!round?.run_id)throw new AppError(409,'review_round_not_submitted');return round.run_id;});
    return this.cancel(actor,caseId,runId,input);
  }
  async run(actor:Actor,caseId:string,runId:string){return transaction(this.pool,async db=>{await authorizeCase(db,actor,caseId,'evidence:read',false);const run=(await db.query('SELECT * FROM business.review_runs WHERE id=$1 AND case_id=$2',[runId,caseId])).rows[0] as RunRow|undefined;if(!run)throw new AppError(404,'review_run_not_found');if(inputHash(run.snapshot)!==run.snapshot_hash)throw new AppError(409,'review_snapshot_corrupt');
    const findings=(await db.query('SELECT id,rule_id,scope_id,input_hash,receipt,reused_from FROM business.review_findings WHERE run_id=$1 ORDER BY scope_id,rule_id',[run.id])).rows;
    return {id:run.id,caseId,caseRevision:run.case_revision,configurationReleaseId:run.configuration_release_id,state:run.state,validity:run.validity,snapshotHash:run.snapshot_hash,snapshot:run.snapshot,configuration:configurationView(await this.release(db,run.configuration_release_id)),results:run.results,findings:findings.map(f=>({evaluationId:f.id,ruleId:f.rule_id,scopeId:f.scope_id,inputHash:f.input_hash,receipt:f.receipt,reusedFrom:f.reused_from}))};
  });}
  async validateCheckerSnapshot(db:DB,snapshot:ReviewSnapshot){
    const c=(await db.query('SELECT * FROM business.cases WHERE id=$1',[snapshot.caseId])).rows[0];
    const signatures=await signatureInformationSummaries(db,c,snapshot.roundId??null,(await this.release(db,snapshot.configurationReleaseId)).manifest);
    assertSignatureInformationSnapshot(signatures,snapshot.signatureInformation);
    const reads=evidenceReads();
    await this.verifySnapshot(db,snapshot,reads);
    await this.assertFileListSnapshot(db,snapshot);
    await this.assertCurrentMaterials(db,snapshot.caseId,snapshot.materials);
    for(const fact of snapshot.facts)await this.validateEvidence(db,snapshot.caseId,fact.evidence,reads);
  }
  private async verifySnapshot(db:DB,snapshot:ReviewSnapshot,reads:EvidenceReads=evidenceReads()){
    if(snapshot.schemaVersion==='p3-review.v2'&&(!snapshot.roundId||!Number.isInteger(snapshot.roundNumber)||snapshot.roundNumber!<1))throw new AppError(409,'review_snapshot_corrupt');
    for(const object of snapshot.objects.filter(o=>o.automaticAttribution)){
      const attribution=object.automaticAttribution!;
      if(object.confirmedBy!==null||attribution.policyVersion!=='source-party-attribution-v1'||!attribution.basis.length||!attribution.candidateIds.length||
        !attribution.sourceHashes.length||inputHash([attribution.candidateIds,object.evidence,attribution.sourceHashes])!==attribution.inputHash||
        !attribution.basis.every(e=>object.evidence.some(source=>inputHash(e)===inputHash(source))))throw new AppError(409,'review_snapshot_corrupt');
      await this.validateEvidence(db,snapshot.caseId,object.evidence,reads);
    }
    // Field comparisons can precede business material adoption. Their original
    // source versions must still be current when this run executes or is confirmed.
    const fieldSources=new Map((snapshot.fieldReviews??[]).filter(f=>f.verification.validity==='current').flatMap(f=>f.verification.sources.map(s=>[JSON.stringify(s.evidence),s.evidence] as const)));
    for(const check of snapshot.automaticChecks??[])for(const evidence of [...check.item.sources.map(s=>s.evidence),...(check.execution?.evidence??[])]){
      if(check.execution&&!snapshot.materials.some(m=>m.operation==='adopt'&&m.documentVersionId===evidence.documentVersionId&&m.parseRevision===evidence.parseRevision&&m.directoryRevision===evidence.directoryRevision))throw new AppError(409,'review_snapshot_corrupt');
      fieldSources.set(JSON.stringify(evidence),evidence);
    }
    for(const scope of snapshot.reviewedInputs??[]){
      const reviews=(snapshot.fieldReviews??[]).filter(f=>f.objectId===(scope.scopeId.startsWith('unconfirmed:')?null:scope.scopeId)&&f.verification.validity==='current'&&!f.verification.origin&&f.verification.meaning==='consistent');
      const permitted=new Set(reviews.flatMap(f=>f.verification.sources.filter(s=>s.kind==='original'&&s.comparisonKey!==null).map(s=>JSON.stringify(s.evidence))));
      if(scope.policyVersion!=='reviewed-rule-inputs-v1'||scope.role!=='corporate_guarantee'||scope.configurationReleaseId!==snapshot.configurationReleaseId||
        !scope.bindingEvidence.length||scope.documentIds.some(id=>!snapshot.materials.some(m=>m.documentVersionId===id&&m.operation==='adopt'))||
        [...scope.bindingEvidence,...Object.values(scope.inputs).flatMap(i=>i.evidence)].some(e=>!permitted.has(JSON.stringify(e)))||
        Object.values(scope.inputs).some(i=>i.recordIds.some(id=>!reviews.some(f=>f.verification.recordId===id))))throw new AppError(409,'reviewed_rule_input_invalid');
    }
    for(const source of fieldSources.values()){
      const row=(await db.query('SELECT d.current_parse_job_id,d.round_id,(SELECT max(directory_revision) FROM business.document_artifacts a WHERE a.job_id=d.current_parse_job_id) AS directory_revision FROM business.document_versions d WHERE d.id=$1 AND d.case_id=$2',[source.documentVersionId,snapshot.caseId])).rows[0];
      if(!row||row.current_parse_job_id!==source.parseRevision||(row.round_id??null)!==(snapshot.roundId??null)||row.directory_revision!==source.directoryRevision)throw new AppError(409,'review_source_changed');
    }
    for(const fact of snapshot.facts.filter(f=>f.automaticAdoption)){
      if(fact.confirmedBy!==null||!FIELD_ACCEPTANCE_POLICIES.includes(fact.automaticAdoption!.policyVersion)||!fact.evidence.length||
        !fact.evidence.every(e=>snapshot.materials.some(m=>m.operation==='adopt'&&m.documentVersionId===e.documentVersionId&&m.parseRevision===e.parseRevision&&m.directoryRevision===e.directoryRevision)))throw new AppError(409,'review_snapshot_corrupt');
      await this.validateEvidence(db,snapshot.caseId,fact.evidence,reads);
    }
    for(const material of snapshot.pendingMaterials??[]){
      const row=(await db.query('SELECT sha256,round_id FROM business.document_versions WHERE id=$1 AND case_id=$2',[material.documentVersionId,snapshot.caseId])).rows[0];
      if(!row||row.sha256!==material.sourceSha256||(row.round_id??null)!==(snapshot.roundId??null))throw new AppError(409,'review_source_changed');
    }
    for(const material of snapshot.materials){
      const row=(await db.query('SELECT sha256,round_id FROM business.document_versions WHERE id=$1 AND case_id=$2',[material.documentVersionId,snapshot.caseId])).rows[0];if(!row||row.sha256!==material.sourceSha256||(row.round_id??null)!==(snapshot.roundId??null))throw new AppError(409,'review_source_changed');
      if(material.directoryRevision!==null){const artifact=(await db.query('SELECT sha256 FROM business.document_artifacts WHERE job_id=$1 AND directory_revision=$2',[material.parseRevision,material.directoryRevision])).rows[0];if(!artifact||artifact.sha256!==material.artifactHash)throw new AppError(409,'review_artifact_changed');}
      if(material.sourceStructureHash){const source=(await db.query('SELECT sha256 FROM business.document_sources WHERE job_id=$1',[material.parseRevision])).rows[0];if(source?.sha256!==material.sourceStructureHash)throw new AppError(409,'review_source_structure_changed');}
      if(material.parseRevision&&material.projectionHash){const projection=await this.projection(db,material.documentVersionId,material.parseRevision,material.directoryRevision,material.projectionJobId);if(projection.hash!==material.projectionHash||projection.jobId!==material.projectionJobId)throw new AppError(409,'review_projection_changed');}
    }
  }
  private async assertFileListSnapshot(db:DB,snapshot:ReviewSnapshot){
    if(snapshot.materialScope!=='file-list')return;
    const ids=(await materialMembership(db,snapshot.caseId,snapshot.roundId??null)).documents.map(d=>d.id).sort();
    const expected=[...new Set([...snapshot.materials,...(snapshot.pendingMaterials??[])].map(m=>m.documentVersionId))].sort();
    if(inputHash(ids)!==inputHash(expected))throw new AppError(409,'review_source_changed');
  }
  private async assertCurrentMaterials(db:DB,caseId:string,materials:ReviewMaterial[]){
    for(const material of materials){const current=(await db.query('SELECT current_parse_job_id FROM business.document_versions WHERE id=$1 AND case_id=$2',[material.documentVersionId,caseId])).rows[0];
      if(!current||current.current_parse_job_id!==material.parseRevision)throw new AppError(409,'review_material_reconfirmation_required');
      const artifact=(await db.query('SELECT directory_revision FROM business.document_artifacts WHERE job_id=$1 ORDER BY directory_revision DESC LIMIT 1',[material.parseRevision])).rows[0];
      if((artifact?.directory_revision??null)!==material.directoryRevision)throw new AppError(409,'review_material_reconfirmation_required');
      if(material.parseRevision){const projection=await this.projection(db,material.documentVersionId,material.parseRevision,material.directoryRevision);if(projection.jobId!==material.projectionJobId||projection.hash!==material.projectionHash)throw new AppError(409,'review_material_reconfirmation_required');}
    }
  }
  private async issue(db:DB,caseId:string,issueId:string,revision:number,version:number){const issue=(await db.query('SELECT i.*,f.receipt FROM business.review_issues i JOIN business.review_findings f ON f.id=i.latest_finding_id WHERE i.id=$1 AND i.case_id=$2 FOR UPDATE OF i',[issueId,caseId])).rows[0];if(!issue)throw new AppError(404,'review_issue_not_found');const c=(await db.query('SELECT * FROM business.cases WHERE id=$1',[caseId])).rows[0],round=await currentRound(db,c);if((issue.round_id??null)!==(c.current_round_id??null)||issue.validity!=='current'||issue.case_revision!==(round?.locked_revision??revision)||issue.version!==version)throw new AppError(409,'stale_issue');return issue;}
  async reply(actor:Actor,caseId:string,issueId:string,raw:unknown){const input=ReviewCommandSchema.extend({...ReviewReplySchema.shape,expectedIssueVersion:z.number().int().positive()}).parse(raw);return this.command(actor,caseId,'finding:decide',`reply:${issueId}`,input,async(db,c)=>{const issue=await this.issue(db,caseId,issueId,c.revision,input.expectedIssueVersion);await db.query('UPDATE business.review_issues SET version=version+1,updated_at=now() WHERE id=$1',[issueId]);await this.event(db,actor,c,'external_reply',{findingId:issue.latest_finding_id,text:input.text,externalAuthor:input.externalAuthor,externalRole:input.externalRole,channel:input.channel,receivedAt:input.receivedAt,recordedBy:actor.personId,recordedAccountId:actor.accountId,reason:input.reason},issueId);});}
  async decide(actor:Actor,caseId:string,issueId:string,raw:unknown){const input=ReviewCommandSchema.extend({disposition:z.enum(['resolved','reopened','acknowledged']),expectedIssueVersion:z.number().int().positive()}).parse(raw);return this.command(actor,caseId,'finding:decide',`decide:${issueId}`,input,async(db,c)=>{const issue=await this.issue(db,caseId,issueId,c.revision,input.expectedIssueVersion);if(input.disposition==='resolved'&&!['pass','not_applicable'].includes(issue.receipt.result.outcome))throw new AppError(409,'issue_not_resolved_by_current_facts');await db.query('UPDATE business.review_issues SET status=$2,version=version+1,updated_at=now() WHERE id=$1',[issueId,input.disposition==='reopened'?'open':input.disposition]);await this.event(db,actor,c,'issue_decided',{findingId:issue.latest_finding_id,disposition:input.disposition,reason:input.reason},issueId);});}
  async cancel(actor:Actor,caseId:string,runId:string,raw:unknown){const input=ReviewCommandSchema.parse(raw);return this.command(actor,caseId,'case:start',`cancel:${runId}`,input,async(db,c)=>{const run=(await db.query('SELECT id,round_id FROM business.review_runs WHERE id=$1 AND case_id=$2 FOR UPDATE',[runId,caseId])).rows[0];if(!run)throw new AppError(404,'review_run_not_found');if((run.round_id??null)!==(c.current_round_id??null))throw new AppError(409,'review_round_not_current');await db.query("UPDATE business.review_runs SET state='canceled',validity='stale',updated_at=now() WHERE id=$1 AND state IN ('pending','running')",[runId]);await db.query("UPDATE business.work_items SET state='canceled',epoch=epoch+1,lease_until=NULL WHERE owner_type='Workflow' AND owner_id=$1 AND state IN ('pending','running')",[runId]);await this.event(db,actor,c,'check_canceled',{runId,reason:input.reason});});}
  async supplement(actor:Actor,caseId:string,issueId:string,raw:unknown){
    if(!this.options.documents)throw new AppError(409,'supplement_unavailable');
    const input=ReviewCommandSchema.extend({expectedIssueVersion:z.number().int().positive(),materialScope:ReviewMaterialScopeSchema.optional(),documentVersionId:z.uuid(),fieldIds:z.array(z.string().min(1).max(200)).min(1).max(50)}).parse(raw);
    if(new Set(input.fieldIds).size!==input.fieldIds.length)throw new AppError(422,'duplicate_supplement_fields');
    return this.command(actor,caseId,'document:parse',`supplement:${issueId}`,input,async(db,c)=>{
      const issue=await this.issue(db,caseId,issueId,c.revision,input.expectedIssueVersion);if(issue.receipt.result.outcome!=='blocked')throw new AppError(409,'supplement_requires_input_gap');
      const finding=(await db.query('SELECT r.* FROM business.review_findings f JOIN business.review_runs r ON r.id=f.run_id WHERE f.id=$1',[issue.latest_finding_id])).rows[0] as RunRow;
      const release=await this.release(db,finding.configuration_release_id),rule=release.manifest.rules.find(r=>r.id===issue.rule_id)!;
      const instance=buildRuleInstances(finding.snapshot,release).find(i=>i.scopeId===issue.scope_id);
      if(!instance||input.fieldIds.some(id=>!rule.inputs.includes(id)||!release.manifest.fields.some(f=>f.id===id)||instance.facts[id]?.state==='present'))throw new AppError(422,'supplement_fields_outside_gap');
      const matches=finding.snapshot.materials.filter(m=>m.documentVersionId===input.documentVersionId&&m.operation==='adopt'&&(!input.materialScope||m.logicalDocumentId===input.materialScope.logicalDocumentId));if(matches.length>1)throw new AppError(409,'review_material_scope_required');const material=matches[0];if(!material?.parseRevision)throw new AppError(422,'supplement_material_not_in_snapshot');
      const document=(await db.query('SELECT current_parse_job_id FROM business.document_versions WHERE id=$1 AND case_id=$2',[material.documentVersionId,caseId])).rows[0];if(document?.current_parse_job_id!==material.parseRevision)throw new AppError(409,'stale_parse_revision');
      const keys=input.fieldIds.map(fieldId=>inputHash({caseId,ruleId:issue.rule_id,scopeId:issue.scope_id,documentVersionId:material.documentVersionId,parseRevision:material.parseRevision,fieldId}));
      if((await db.query('SELECT 1 FROM business.review_supplement_gaps WHERE gap_key=ANY($1::text[]) LIMIT 1',[keys])).rowCount)throw new AppError(409,'supplement_budget_exhausted');
      const id=randomUUID(),workId=randomUUID();await db.query('INSERT INTO business.review_supplements(id,case_id,issue_id,document_version_id,parse_revision,field_ids,expected_revision,account_id,person_id,auth_version,session_key) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)',[id,caseId,issueId,material.documentVersionId,material.parseRevision,input.fieldIds,c.revision,actor.accountId,actor.personId,actor.authVersion,actor.sessionKey??null]);
      for(const key of keys)await db.query('INSERT INTO business.review_supplement_gaps(gap_key,request_id) VALUES($1,$2)',[key,id]);
      await db.query("INSERT INTO business.work_items(id,owner_type,owner_id,kind,queue) VALUES($1,'Workflow',$2,'p3_supplement','workflow')",[workId,id]);await db.query("INSERT INTO business.outbox(id,work_item_id,event_type,owner_id) VALUES($1,$2,'work.available',$3)",[randomUUID(),workId,id]);
      await this.event(db,actor,c,'supplement_requested',{requestId:id,fieldIds:input.fieldIds,documentVersionId:material.documentVersionId,parseRevision:material.parseRevision,reason:input.reason},issueId);
    });
  }
  private async supplementFence(db:DB,row:any,work:ClaimedWork){
    const actor:Actor={accountId:row.account_id,personId:row.person_id,authVersion:row.auth_version,...(row.session_key?{sessionKey:row.session_key}:{})};const c=await this.maker(db,actor,row.case_id,'document:parse');
    if(c.revision!==row.expected_revision)throw new AppError(409,'stale_revision');const document=(await db.query('SELECT current_parse_job_id FROM business.document_versions WHERE id=$1 AND case_id=$2',[row.document_version_id,row.case_id])).rows[0];if(document?.current_parse_job_id!==row.parse_revision)throw new AppError(409,'stale_parse_revision');
    if(!(await db.query("SELECT 1 FROM business.work_items WHERE id=$1 AND epoch=$2 AND state='running' AND lease_until>now() FOR UPDATE",[work.id,work.epoch])).rowCount)throw new AppError(409,'lease_lost');return {actor,c};
  }
  private async processSupplement(row:any,work:ClaimedWork){
    try{
      if(this.stopping)throw new AppError(409,'worker_stopping');if(!this.options.documents)throw new AppError(409,'supplement_unavailable');
      const {actor}=await transaction(this.pool,async db=>{const result=await this.supplementFence(db,row,work);await db.query("UPDATE business.review_supplements SET state='running',updated_at=now() WHERE id=$1",[row.id]);return result;});
      // Domain extraction owns its own transaction; never invoke it while retaining the case lock.
      const accepted=await this.options.documents.extract(actor,row.case_id,row.document_version_id,{expectedRevision:row.expected_revision,parseRevision:row.parse_revision,idempotencyKey:`review-supplement:${row.id}`,reason:'Explicit review evidence-gap extraction',fieldIds:row.field_ids});
      await transaction(this.pool,async db=>{const {c}=await this.supplementFence(db,row,work);await db.query("UPDATE business.review_supplements SET state='requested',job_id=$2,error_code=NULL,updated_at=now() WHERE id=$1",[row.id,accepted.jobId]);await db.query("UPDATE business.work_items SET state='succeeded',lease_until=NULL,updated_at=now() WHERE id=$1 AND epoch=$2",[work.id,work.epoch]);await this.event(db,actor,c,'supplement_dispatched',{requestId:row.id,jobId:accepted.jobId},row.issue_id);});
    }catch(error){const code=this.stopping?'worker_stopping':error instanceof AppError?error.code:'supplement_dispatch_failed';await transaction(this.pool,async db=>{const changed=await db.query("UPDATE business.work_items SET state=$3,error_code=$4,lease_until=NULL,updated_at=now() WHERE id=$1 AND epoch=$2 AND state='running' AND lease_until>now() RETURNING id",[work.id,work.epoch,this.stopping?'pending':'rejected',code]);if(changed.rowCount)await db.query('UPDATE business.review_supplements SET state=$2,error_code=$3,updated_at=now() WHERE id=$1',[row.id,this.stopping?'pending':'failed',code]);});}
  }
  async claim(workId?:string):Promise<ClaimedWork|undefined>{
    if(this.stopping)return undefined;
    return (await this.pool.query(`UPDATE business.work_items SET state='running',attempts=attempts+1,epoch=epoch+1,lease_until=now()+$2*interval '1 second',updated_at=now()
      WHERE id=(SELECT w.id FROM business.work_items w WHERE w.owner_type='Workflow' AND (w.kind='p3_review' AND EXISTS(SELECT 1 FROM business.review_runs r WHERE r.id=w.owner_id AND r.validity='current' AND r.state IN ('pending','running'))
      OR w.kind='p3_supplement' AND EXISTS(SELECT 1 FROM business.review_supplements s WHERE s.id=w.owner_id AND s.state IN ('pending','running'))) AND w.available_at<=now() AND (w.state='pending' OR w.state='running' AND w.lease_until<now())
      AND ($1::uuid IS NULL OR w.id=$1) ORDER BY w.available_at,w.id FOR UPDATE OF w SKIP LOCKED LIMIT 1) RETURNING *`,[workId??null,this.leaseSeconds])).rows[0];
  }
  private async fence(db:DB,run:RunRow,work:ClaimedWork){
    if(this.stopping)throw new AppError(409,'worker_stopping');const c=await this.maker(db,actorOf(run),run.case_id,'case:start');
    const round=await currentRound(db,c);if(run.round_id?round?.id!==run.round_id||!['draft','locked'].includes(round.state)||round.run_id!==run.id||round.locked_revision!==run.case_revision||round.configuration_release_id!==run.configuration_release_id:c.review_rounds_enabled||c.revision!==run.case_revision||c.configuration_release_id!==run.configuration_release_id)throw new AppError(409,'stale_revision');
    const row=(await db.query("SELECT id FROM business.review_runs WHERE id=$1 AND validity='current' AND state IN ('pending','running') FOR UPDATE",[run.id])).rows[0];if(!row)throw new AppError(409,'stale_review_run');
    const lease=(await db.query("SELECT id FROM business.work_items WHERE id=$1 AND epoch=$2 AND owner_id=$3 AND state='running' AND lease_until>now() FOR UPDATE",[work.id,work.epoch,run.id])).rows[0];if(!lease)throw new AppError(409,'lease_lost');
    if(inputHash(run.snapshot)!==run.snapshot_hash||(run.round_id??null)!==(run.snapshot.roundId??null))throw new AppError(409,'review_snapshot_corrupt');
    if(!run.snapshot.pendingMaterials&&run.snapshot.objects.some(object=>object.role==='corporate_guarantee'||object.role==='personal_guarantee'))throw new AppError(409,'review_material_reconfirmation_required');
    await this.verifySnapshot(db,run.snapshot);await this.assertFileListSnapshot(db,run.snapshot);await this.assertCurrentMaterials(db,run.case_id,run.snapshot.materials);
    if(run.snapshot.pendingMaterials&&inputHash(await pendingReviewMaterials(db,run.case_id,(await this.values(db,run.case_id,run.round_id??null)).materials,run.round_id??null))!==inputHash(run.snapshot.pendingMaterials))throw new AppError(409,'review_material_reconfirmation_required');
    return c;
  }
  async verifyWorkSnapshot(work:ClaimedWork,snapshot:ReviewSnapshot):Promise<{snapshotHash:string;documentVersionIds:string[];projectionJobIds:string[]}>{
    return transaction(this.pool,async db=>{const run=(await db.query('SELECT * FROM business.review_runs WHERE id=$1',[work.owner_id])).rows[0] as RunRow|undefined;if(!run)throw new AppError(404,'review_run_not_found');
      if(inputHash(snapshot)!==run.snapshot_hash)throw new AppError(409,'review_snapshot_mismatch');await this.fence(db,run,work);
      const body={snapshotHash:run.snapshot_hash,documentVersionIds:[...new Set([...run.snapshot.materials,...(run.snapshot.pendingMaterials??[])].map(m=>m.documentVersionId))].sort(),projectionJobIds:[...new Set(run.snapshot.materials.flatMap(m=>m.projectionJobId?[m.projectionJobId]:[]))].sort()};
      await db.query('INSERT INTO business.review_document_receipts(run_id,snapshot_hash,body) VALUES($1,$2,$3) ON CONFLICT(run_id) DO NOTHING',[run.id,run.snapshot_hash,JSON.stringify(body)]);
      const stored=(await db.query('SELECT snapshot_hash,body FROM business.review_document_receipts WHERE run_id=$1',[run.id])).rows[0];if(stored.snapshot_hash!==run.snapshot_hash||inputHash(stored.body)!==inputHash(body))throw new AppError(409,'review_document_receipt_mismatch');return body;
    });
  }
  async processWork(work:ClaimedWork):Promise<void>{
    const supplement=(await this.pool.query('SELECT * FROM business.review_supplements WHERE id=$1',[work.owner_id])).rows[0];if(supplement){await this.processSupplement(supplement,work);return;}
    const run=(await this.pool.query('SELECT * FROM business.review_runs WHERE id=$1',[work.owner_id])).rows[0] as RunRow|undefined;if(!run)return;
    const controller=new AbortController();this.active.add(controller);
    let heartbeatBusy=false;
    const timer=setInterval(()=>{if(heartbeatBusy)return;heartbeatBusy=true;void this.pool.query("UPDATE business.work_items SET lease_until=now()+$3*interval '1 second' WHERE id=$1 AND epoch=$2 AND state='running' AND lease_until>now() RETURNING id",[work.id,work.epoch,this.leaseSeconds]).then(r=>{if(!r.rowCount)controller.abort();}).catch(()=>controller.abort()).finally(()=>{heartbeatBusy=false;});},Math.max(1000,this.leaseSeconds*1000/3));timer.unref();
    try{
      const release=await transaction(this.pool,async db=>{await this.fence(db,run,work);await db.query("UPDATE business.review_runs SET state='running',updated_at=now() WHERE id=$1",[run.id]);return this.release(db,run.configuration_release_id);});
      if(release.manifestHash!==run.snapshot.manifestHash||release.packageHash!==run.snapshot.packageHash)throw new AppError(409,'review_configuration_changed');
      let results:Array<{ruleId:string;scopeId:string;outcome:string;reasonCode:string;details?:{expiryDate:string};evidenceIds:string[];reusedFrom:string|null;inputHash:string;receipt:OpaReceipt;evaluationId?:string;resolution?:ResultResolution}>=[];
      const invoke=async()=>{
        const planned:Array<{instance:ReturnType<typeof buildRuleInstances>[number];pending:string[]}>=[];
        for(const instance of buildRuleInstances(run.snapshot,release)){
          if(controller.signal.aborted)throw new AppError(409,'review_canceled');
          await transaction(this.pool,db=>this.fence(db,run,work));
          const pending:string[]=[];
          for(const ruleId of instance.ruleIds){const old=run.round_id?undefined:(await this.pool.query(`SELECT f.* FROM business.review_findings f JOIN business.review_runs r ON r.id=f.run_id
            WHERE r.round_id IS NULL AND f.case_id=$1 AND f.scope_id=$2 AND f.rule_id=$3 AND f.input_hash=$4 AND r.state='ready' AND r.configuration_release_id=$5 ORDER BY f.created_at DESC LIMIT 1`,[run.case_id,instance.scopeId,ruleId,instance.inputHashes[ruleId],release.releaseId])).rows[0];
            if(old){const receipt=OpaReceiptSchema.parse(old.receipt.engine);const result=receipt.results.find(r=>r.ruleId===ruleId);if(!result||receipt.releaseId!==release.releaseId||receipt.packageHash!==release.packageHash||receipt.executorVersion!==release.manifest.compatibility.executorVersion)throw new AppError(409,'review_reuse_receipt_invalid');results.push({...result,scopeId:instance.scopeId,reusedFrom:old.id,inputHash:instance.inputHashes[ruleId]!,receipt});}
            else pending.push(ruleId);
          }
          if(!pending.length)continue;
          planned.push({instance,pending});
        }
        // One OPA evaluation can cover every object without dropping per-rule receipts.
        // Authorization is checked during planning, after execution and again at commit.
        const batch=this.executor.evaluateBatch&&planned.length?await this.executor.evaluateBatch(release,planned.map(({instance,pending})=>({facts:instance.facts,ruleIds:pending})),controller.signal):null;
        if(batch&&batch.length!==planned.length)throw new AppError(409,'review_execution_receipt_mismatch');
        for(const [index,{instance,pending}] of planned.entries()){
          if(controller.signal.aborted)throw new AppError(409,'review_canceled');
          await transaction(this.pool,db=>this.fence(db,run,work));
          const receipt=OpaReceiptSchema.parse(batch?batch[index]:await this.executor.evaluate(release,instance.facts,controller.signal,pending));
          if(receipt.releaseId!==release.releaseId||receipt.packageHash!==release.packageHash||receipt.executorVersion!==release.manifest.compatibility.executorVersion||receipt.results.length!==pending.length||new Set(receipt.results.map(r=>r.ruleId)).size!==pending.length||receipt.results.some(r=>!pending.includes(r.ruleId)))throw new AppError(409,'review_execution_receipt_mismatch');
          for(const result of receipt.results)results.push({...result,scopeId:instance.scopeId,reusedFrom:null,inputHash:instance.inputHashes[result.ruleId]!,receipt});
        }
      };
      if(this.options.execute)await this.options.execute(invoke,run.snapshot,work);else await invoke();
      if(!results.length)throw new AppError(409,'review_empty_execution');
      // The engine's receipts stay as they were returned; a rule decided by the frozen judgement chain records that beside them.
      results=resolveSystemJudgement(results,run.snapshot,release.manifest);
      await transaction(this.pool,async db=>{
        const c=await this.fence(db,run,work);
        for(const item of results){const id=randomUUID(),result:RuleEvaluation={ruleId:item.ruleId,outcome:item.outcome as RuleEvaluation['outcome'],reasonCode:item.reasonCode,...(item.details?{details:item.details}:{}),evidenceIds:item.evidenceIds};item.evaluationId=id;
          await db.query('INSERT INTO business.review_findings(id,run_id,case_id,case_revision,rule_id,scope_id,input_hash,receipt,reused_from) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)',[id,run.id,run.case_id,run.case_revision,item.ruleId,item.scopeId,item.inputHash,JSON.stringify({result,engine:item.receipt,...(item.resolution?{resolution:item.resolution}:{})}),item.reusedFrom]);
          const previous=(await db.query('SELECT * FROM business.review_issues WHERE case_id=$1 AND rule_id=$2 AND scope_id=$3 AND round_id IS NOT DISTINCT FROM $4::uuid FOR UPDATE',[run.case_id,item.ruleId,item.scopeId,run.round_id??null])).rows[0];
          if(previous){const status=['fail','blocked'].includes(item.outcome)?'open':previous.status==='resolved'?'resolved':'open';await db.query("UPDATE business.review_issues SET latest_finding_id=$2,case_revision=$3,validity='current',status=$4,version=version+1,updated_at=now() WHERE id=$1",[previous.id,id,run.case_revision,status]);await this.event(db,actorOf(run),c,'issue_rechecked',{findingId:id,previousFindingId:previous.latest_finding_id,outcome:item.outcome,reusedFrom:item.reusedFrom},previous.id);}
          else if(['fail','blocked'].includes(item.outcome)){const issueId=randomUUID();await db.query('INSERT INTO business.review_issues(id,case_id,rule_id,scope_id,latest_finding_id,case_revision,round_id) VALUES($1,$2,$3,$4,$5,$6,$7)',[issueId,run.case_id,item.ruleId,item.scopeId,id,run.case_revision,run.round_id??null]);await this.event(db,actorOf(run),c,'issue_opened',{findingId:id,outcome:item.outcome},issueId);}
        }
        const view=results.map(({receipt,inputHash,...result})=>({...result,execution:{actualReleaseId:receipt.releaseId,actualPackageHash:receipt.packageHash,executorVersion:receipt.executorVersion}}));
        await db.query("UPDATE business.review_runs SET state='ready',results=$2,error_code=NULL,updated_at=now() WHERE id=$1",[run.id,JSON.stringify(view)]);
        await db.query("UPDATE business.work_items SET state='succeeded',lease_until=NULL,updated_at=now() WHERE id=$1 AND epoch=$2",[work.id,work.epoch]);
        await db.query('INSERT INTO business.inbox(work_item_id,epoch) VALUES($1,$2) ON CONFLICT(work_item_id) DO UPDATE SET epoch=EXCLUDED.epoch,completed_at=now()',[work.id,work.epoch]);
        await this.event(db,actorOf(run),c,'check_completed',{runId:run.id,resultCount:results.length,reusedCount:results.filter(r=>r.reusedFrom).length});
      });
    }catch(error){
      const code=this.stopping?'worker_stopping':error instanceof AppError?error.code:'review_execution_failed';
      const stale=['stale_revision','stale_review_run','identity_revoked','permission_denied','maker_assignment_required','checker_assignment_required','checker_not_independent_or_authorized','checker_correction_not_authorized','checker_correction_required','checker_correction_in_progress','review_canceled','review_projection_changed','review_material_reconfirmation_required','worker_stopping'].includes(code);
      await transaction(this.pool,async db=>{
        const changed=await db.query("UPDATE business.work_items SET state=$3,error_code=$4,lease_until=NULL,updated_at=now() WHERE id=$1 AND epoch=$2 AND state='running' AND lease_until>now() RETURNING id",[work.id,work.epoch,this.stopping?'pending':stale?'canceled':'rejected',code]);
        if(changed.rowCount)await db.query("UPDATE business.review_runs SET state=$2,validity=$3,error_code=$4,updated_at=now() WHERE id=$1 AND state IN ('pending','running')",[run.id,this.stopping?'pending':stale?'stale':'failed',!this.stopping&&stale?'stale':'current',code]);
      });
    }finally{clearInterval(timer);this.active.delete(controller);controller.abort();}
  }
}

export function registerReviewRoutes(app:FastifyInstance,_pool:Pool,auth:Auth,service:ReviewService,options:{reviewEnabled?:boolean}={}){
  const caseId=(request:any)=>z.uuid().parse(request.params.caseId),base='/api/cases/:caseId/review';
  const visible=(state:ReviewState)=>options.reviewEnabled===false?{...state,allowedActions:state.allowedActions.filter(action=>action==='case:configure')}:state;
  app.get(`${base}/subjects/work`,async request=>service.subjectWork(await auth.requireSession(request),caseId(request)));
  app.get(`${base}/subjects`,async request=>service.subjects(await auth.requireSession(request),caseId(request),z.object({roundId:z.union([z.uuid(),z.literal('legacy')]).optional()}).parse(request.query).roundId));
  app.get(base,async request=>visible(await service.state(await auth.requireSession(request),caseId(request),z.object({roundId:z.union([z.uuid(),z.literal('legacy')]).optional()}).parse(request.query).roundId)));
  app.post(`${base}/configuration`,async request=>visible(await service.bindConfiguration(await auth.checkWrite(request),caseId(request),request.body)));
  if(options.reviewEnabled===false)return;
  app.get(`${base}/checklist`,async request=>service.checklist(await auth.requireSession(request),caseId(request),z.object({roundId:z.union([z.uuid(),z.literal('legacy')]).optional()}).parse(request.query).roundId));
  app.post(`${base}/personal-field-verifications`,async request=>service.verifyPersonalFields(await auth.checkWrite(request),caseId(request),request.body));
  app.post(`${base}/field-verifications`,{bodyLimit:4*1024*1024},async request=>service.saveFieldReview(await auth.checkWrite(request),caseId(request),request.body));
  app.get(`${base}/history`,async request=>(await service.state(await auth.requireSession(request),caseId(request),z.object({roundId:z.union([z.uuid(),z.literal('legacy')]).optional()}).parse(request.query).roundId)).history);
  app.get(`${base}/runs/:runId`,async request=>service.run(await auth.requireSession(request),caseId(request),z.uuid().parse((request.params as any).runId)));
  const posts:Array<[string,(actor:Actor,id:string,body:unknown)=>Promise<ReviewState>]>= [['objects',service.confirmObject.bind(service)],['facts',service.confirmFact.bind(service)],['field-values',(actor,id,body)=>service.supplyFieldValue(actor,id,body)],['subjects',service.confirmSubjects.bind(service)],['field-values/withdraw',service.withdrawFieldValue.bind(service)],['materials',service.material.bind(service)],['start',service.start.bind(service)]];
  app.post(`${base}/materials/remove`,async request=>service.removeMaterials(await auth.checkWrite(request),caseId(request),request.body));
  app.post(`${base}/guidance`,async request=>service.saveGuidance(await auth.checkWrite(request),caseId(request),request.body));
  app.post(`${base}/guidance/digest`,async request=>service.requestGuidanceDigest(await auth.checkWrite(request),caseId(request),request.body));
  app.get(`${base}/guidance/digests`,async request=>service.guidanceDigests(await auth.requireSession(request),caseId(request)));
  app.post(`${base}/guidance/:guidanceId/retire`,async request=>service.retireGuidance(await auth.checkWrite(request),caseId(request),z.uuid().parse((request.params as any).guidanceId),request.body));
  for(const [path,handler] of posts)app.post(`${base}/${path}`,async request=>handler(await auth.checkWrite(request),caseId(request),request.body));
  for(const action of ['reply','decide'] as const)app.post(`${base}/issues/:issueId/${action}`,async request=>service[action](await auth.checkWrite(request),caseId(request),z.uuid().parse((request.params as any).issueId),request.body));
  app.post(`${base}/issues/:issueId/supplement`,async request=>service.supplement(await auth.checkWrite(request),caseId(request),z.uuid().parse((request.params as any).issueId),request.body));
  app.post(`${base}/runs/:runId/cancel`,async request=>service.cancel(await auth.checkWrite(request),caseId(request),z.uuid().parse((request.params as any).runId),request.body));
}
