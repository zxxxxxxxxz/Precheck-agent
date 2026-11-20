import { z } from 'zod';
import { SignatureRequirementSchema, SignatureEvaluationInputSchema } from './signature-review.js';

export interface ReviewRequirementPolicy {version:'review-requirements-v1';chineseVersionRequired:boolean;corporatePreReview?:'bank-scope-v1';bankWorkbookOnly?:boolean;
  /** The system's own conclusions count in the results of runs frozen with this policy: a rule whose judgement chain
   * concluded is recorded as satisfied or not satisfied instead of waiting for a person, and a sole subject owns the
   * adopted files of its role. Absent on earlier runs, which keep their original results. */
  systemJudgement?:'v1'}

const id = z.string().regex(/^[a-z][a-z0-9_.:-]{0,127}$/);
const sha = z.string().regex(/^[a-f0-9]{64}$/);
const ExtractionRecipeSchema=z.strictObject({version:id,model:z.string().min(1).max(200).nullable(),promptSha256:sha,mode:z.enum(['deterministic','private_candidate_filter','manual','cloud_grounded_extract'])});
export const GuaranteeTypeSchema = z.enum(['account_charge','personal_guarantee','corporate_guarantee','sblc','mortgage']);
export const ReviewFactSchema = z.strictObject({
  value: z.union([z.string().max(20000),z.boolean(),z.null()]),
  state: z.enum(['present','missing','uncertain','redacted','unreadable','not_applicable','blank']),
  evidenceIds: z.array(z.string().min(1).max(200)).max(1000).default([]),
  objectId:z.string().min(1).max(200).optional(),
  sameEntityIds:z.array(z.string().min(1).max(200)).max(100).optional(),
  differentEntityIds:z.array(z.string().min(1).max(200)).max(100).optional(),
});
export const ReviewFactsSchema = z.record(id,ReviewFactSchema);
export type ReviewFacts = z.infer<typeof ReviewFactsSchema>;
export const RuleOutcomeSchema = z.enum(['pass','fail','blocked','not_applicable']);
export const RuleEvaluationSchema = z.strictObject({ruleId:id,outcome:RuleOutcomeSchema,reasonCode:id,details:z.strictObject({expiryDate:z.string().regex(/^\d{4}-\d{2}-\d{2}$/)}).optional(),evidenceIds:z.array(z.string().min(1).max(200)).max(4000)});
export type RuleEvaluation = z.infer<typeof RuleEvaluationSchema>;
export const RuleTestSchema = z.strictObject({id,kind:z.enum(['normal','abnormal','boundary','missing_input']),synthetic:z.literal(true),facts:ReviewFactsSchema,expected:RuleOutcomeSchema});
export const ReviewFieldDefinitionSchema = z.strictObject({
  id,label:z.string().trim().min(1).max(200),type:z.enum(['text','amount','date','currency']),aliases:z.array(z.string().trim().min(1).max(200)).min(1).max(100),
  objectKind:z.enum(['party','financing','guarantee','collateral','policy','signatory']),objectRole:id.max(100).optional(),semanticDefinition:z.string().trim().min(1).max(4000),
  taxonomyIds:z.array(id).min(1).max(200).optional(),
  valueKind:z.enum(['party_name','identifier','address','amount','date','currency','text']).optional(),
  partyKinds:z.array(z.enum(['person','organization'])).min(1).max(2).optional(),
  valueMultiplicity:z.enum(['single','entities','clauses']).optional(),
  requireLabel:z.boolean().optional(),excludedLabels:z.array(z.string().min(1).max(200)).max(100).optional(),
  // Opt-in, immutable configuration semantics; absent preserves legacy extraction.
  roleEvidence:z.strictObject({version:z.enum(['source-role-v1','source-role-v2']),role:id,
    labels:z.array(z.string().trim().min(1).max(160)).min(1).max(40),
    genericLabels:z.array(z.string().trim().min(1).max(160)).max(20),
    headings:z.array(z.string().trim().min(1).max(160)).max(30),
    otherHeadings:z.array(z.string().trim().min(1).max(160)).max(40),
    declarationTerms:z.array(z.string().trim().min(1).max(160)).max(20),
  }).optional(),
  partyNameSection:z.strictObject({headings:z.array(z.string().min(1).max(200)).min(1).max(30),otherHeadings:z.array(z.string().min(1).max(200)).max(30)}).optional(),
  unit:z.string().min(1).max(80).nullable().default(null),currency:z.string().regex(/^[A-Z]{3}$/).nullable().default(null),
  requiredDetection:z.boolean(),requiredValue:z.boolean(),sourceIds:z.array(id).min(1),
  recipe:ExtractionRecipeSchema,
}).superRefine((field,ctx)=>{
  if(field.roleEvidence&&(field.valueKind!=='party_name'||field.recipe.mode!=='cloud_grounded_extract'||!field.requireLabel||
    [...field.roleEvidence.labels,...field.roleEvidence.genericLabels].some(label=>!field.aliases.includes(label)))){
    ctx.addIssue({code:'custom',path:['roleEvidence'],message:'Role evidence requires a cloud party field and its explicit source aliases'});
  }
});
export type ReviewFieldDefinition = z.infer<typeof ReviewFieldDefinitionSchema>;
/** Reviewed implementations only. A draft may choose a recipe, never invent one.
 * Semantic definitions stay in the immutable release; these hashes bind the
 * implementation/prompt template used to interpret those definitions. */
export const REVIEW_EXTRACTION_RECIPES = Object.freeze([
  {version:'azure-grounded-docx-v1',model:'gpt-6-astra',promptSha256:'29160de5f07b0de042c7ec05679b9d3f969db785301f9236934799012966f608',modes:['cloud_grounded_extract'],scopes:['synthetic'],reference:'repo:packages/server/src/modules/documents/docx-extraction-contract.ts#DOCUMENT_DOCX_INSTRUCTIONS'},
  {version:'azure-grounded-fields-v2',model:'gpt-6-astra',promptSha256:'ed1cc9e37b8cf6c8fd1a766d04f58b2fa988c8e0f3559721350ca98a647d8314',modes:['cloud_grounded_extract'],scopes:['synthetic'],reference:'repo:packages/server/src/modules/documents/cloud-extraction-v2-contract.ts#DOCUMENT_CLOUD_V2_INSTRUCTIONS'},
  {version:'azure-grounded-fields-v1',model:'gpt-6-astra',promptSha256:'e4523c21682b971346e9b888a1cb2a2580c15d8ef490d82d5863af7b283d16d7',modes:['cloud_grounded_extract'],scopes:['synthetic'],reference:'repo:packages/server/src/modules/documents/cloud-extraction-contract.ts#DOCUMENT_CLOUD_INSTRUCTIONS'},
  {version:'synthetic_mortgage_fields_v1',model:null,promptSha256:'5873f1f7f214255bd7a14474b30a188ac7fffc49a33b386b0078b6a21c64e444',modes:['deterministic','manual'],scopes:['synthetic'],reference:'repo:infra/opa/review/synthetic-recipe.txt'},
  {version:'p3-label-normalize-v1',model:null,promptSha256:'feb8015453db05e858e9eafe254a55cff5d9d33d979df010c39c13a7d4f894d9',modes:['deterministic'],scopes:['synthetic','bank'],reference:'repo:infra/opa/review/p3-label-normalize-v1.txt'},
  {version:'p3-manual-evidence-v1',model:null,promptSha256:'b74df182eccac55cd37762b3b4a1ac03db39ac020836087b1310d01252d143af',modes:['manual'],scopes:['synthetic','bank'],reference:'repo:infra/opa/review/p3-manual-evidence-v1.txt'},
  {version:'qwen-role-filter-v1',model:'Qwen/Qwen3.5-9B',promptSha256:'96aa4c27036b020b5c7121d59c63d1af7c9e71a83454495cb33ff2b2fd1c49a7',modes:['private_candidate_filter'],scopes:['synthetic','bank'],reference:'repo:packages/server/src/modules/documents/field-filter.ts#instruction'},
].map(recipe=>Object.freeze({...recipe,modes:Object.freeze(recipe.modes),scopes:Object.freeze(recipe.scopes)})));
export function isSupportedReviewRecipe(recipe:ReviewFieldDefinition['recipe'],scope:'synthetic'|'bank'):boolean {
  return REVIEW_EXTRACTION_RECIPES.some(known=>known.version===recipe.version&&known.model===recipe.model&&known.promptSha256===recipe.promptSha256&&known.modes.includes(recipe.mode)&&known.scopes.includes(scope));
}
export const RuleConditionSchema = z.strictObject({fieldId:id,equals:z.union([z.string(),z.boolean()])});
const ObjectScopeSchema = z.strictObject({kind:z.enum(['party','financing','guarantee','collateral','policy','signatory']),role:id});
export const ReviewRuleSchema = z.strictObject({
  id,label:z.string().trim().min(1).max(300),operator:z.enum(['present','equal','minimum','range_covers','set_covers','date_order','blank','same_entity','currency_is','minimum_in_currency','manual_review','minimum_ratio','ltv_maximum','date_after','calendar_year_minimum','anniversary_notice']),
  description:z.string().max(8000).optional(),
  manualReason:z.enum(['manual_review_required','business_rule_confirmation_required','reference_list_required']).optional(),
  factor:z.string().regex(/^(?:0|[1-9]\d{0,3})(?:\.\d{1,6})?$/).optional(),
  currency:z.string().regex(/^[A-Z]{3}$/).optional(),
  inputs:z.array(id).min(1).max(5),objectScope:ObjectScopeSchema.optional(),applicability:RuleConditionSchema.optional(),requiredParameters:z.array(id).max(100).default([]),
  sourceIds:z.array(id).min(1),sourceDirectionConfirmed:z.boolean(),tests:z.array(RuleTestSchema).min(4).max(100),
});
export type ReviewRule = z.infer<typeof ReviewRuleSchema>;
/** Reviewer judgement wording. It informs semantic comparison only; OPA never reads it. */
export const SemanticGuidanceKindSchema = z.enum(['name_equivalence','wording_tolerance','legal_baseline','focus_note']);
export const SemanticGuidanceBodySchema = z.strictObject({
  kind:SemanticGuidanceKindSchema,statement:z.string().trim().min(4).max(500),
  fieldIds:z.array(id).max(20),expressions:z.array(z.string().trim().min(1).max(300)).max(10),
});
export const ConfigSemanticGuidanceSchema = SemanticGuidanceBodySchema.extend({
  id,sourceIds:z.array(id).min(1),
  origin:z.strictObject({caseId:z.uuid(),guidanceId:z.uuid(),digestId:z.uuid()}).optional(),
});
export type ConfigSemanticGuidance = z.infer<typeof ConfigSemanticGuidanceSchema>;
export const SignatureRuleTestSchema = z.strictObject({
  id,requirementId:id,kind:z.enum(['normal','abnormal','boundary','missing_input']),synthetic:z.literal(true),
  input:SignatureEvaluationInputSchema,expected:RuleOutcomeSchema,
});
export const ReviewConfigManifestSchema = z.strictObject({
  schemaVersion:z.literal('review-config.v1'),releaseId:z.string().regex(/^[a-z][a-z0-9_]{0,63}$/),label:z.string().trim().min(1).max(200),
  scope:z.enum(['synthetic','bank']),scenario:z.literal('overseas_loan'),guaranteeTypes:z.array(GuaranteeTypeSchema).min(1),
  bankApprovalRef:z.string().trim().min(1).max(300).nullable().default(null),
  sources:z.array(z.strictObject({id,reference:z.string().trim().min(1).max(500),sha256:sha,guaranteeType:GuaranteeTypeSchema,
    disposition:z.enum(['confirmed','candidate','excluded','manual']),reason:z.string().trim().min(1).max(1000),approvalRef:z.string().trim().min(1).max(300).nullable().default(null)})).min(1).max(2000),
  taxonomy:z.array(z.strictObject({id,label:z.string().trim().min(1).max(200),keywords:z.array(z.string().trim().min(1).max(200)).min(1),sourceIds:z.array(id).min(1)})).min(1).max(200),
  materials:z.array(z.strictObject({id,label:z.string().trim().min(1).max(200),taxonomyId:id,required:z.boolean(),objectScope:ObjectScopeSchema.optional(),applicability:RuleConditionSchema.optional(),sourceIds:z.array(id).min(1)})).min(1).max(200),
  fields:z.array(ReviewFieldDefinitionSchema).min(1).max(500),rules:z.array(ReviewRuleSchema).min(1).max(500),
  // Explicit immutable opt-in: absence preserves historical source-only DOCX.
  docxExtraction:ExtractionRecipeSchema.optional(),
  documentClassification:z.literal('content-first-v1').optional(),
  signatureRequirements:z.array(SignatureRequirementSchema).min(1).max(200).optional(),
  signatureTests:z.array(SignatureRuleTestSchema).min(4).max(2000).optional(),
  // Optional and absent by default, so existing manifest hashes are unchanged.
  semanticGuidance:z.array(ConfigSemanticGuidanceSchema).min(1).max(200).optional(),
  parameters:z.record(id,z.union([z.string().max(1000),z.boolean(),z.null()])).default({}),
  compatibility:z.strictObject({documentSchema:z.literal('p2.v2'),factsSchema:z.enum(['review-facts.v1','review-facts.v2']),executorVersion:z.enum(['p3-deterministic-v1','p3-deterministic-v2','p3-deterministic-v3']),signatureExecutorVersion:z.literal('signature-requirements-v1').optional()}),
});
export type ReviewConfigManifest = z.infer<typeof ReviewConfigManifestSchema>;
/** Explicit rollout scopes; historical manifests without the marker remain unchanged. */
export function supportsContentClassification(types:readonly string[]):boolean {
  return types.length===1&&types[0]==='corporate_guarantee'||
    types.length===2&&types.includes('corporate_guarantee')&&types.includes('personal_guarantee');
}
export interface ConfigValidation { valid:boolean; issues:Array<{code:string;path:string}> }
export const OpaReceiptSchema=z.strictObject({releaseId:z.string(),packageHash:sha,executorVersion:z.enum(['p3-deterministic-v1','p3-deterministic-v2','p3-deterministic-v3']),results:z.array(RuleEvaluationSchema)});
export type OpaReceipt=z.infer<typeof OpaReceiptSchema>;
export interface ReviewConfigRelease {
  releaseId:string;status:'published';manifest:ReviewConfigManifest;manifestHash:string;packageHash:string;policySha256:string;
  documentConfigurationId:string;trialHash:string;approvalHash:string;publishedAt:string;
}
export interface ReviewConfigView {
  id:string;revision:number;status:'draft'|'validated'|'trial_passed'|'approved'|'published';authorPersonId:string;
  manifestHash:string;manifest:ReviewConfigManifest;validation:ConfigValidation;
  trial:{passed:boolean;receiptHash:string;results:Array<{ruleId:string;testId:string;expected:z.infer<typeof RuleOutcomeSchema>;actual:z.infer<typeof RuleOutcomeSchema>;passed:boolean}>}|null;
  approval:{personId:string;hash:string}|null;releaseId:string|null;allowed_actions:string[];
}

/** Actual supplied workbook identities; none is an executable or approved bank rule. */
export const REVIEW_BANK_SOURCE_REFERENCES=Object.freeze([
  {id:'src_ar',guaranteeType:'account_charge',sha256:'5680f0a9fd9f34ad764eff5afe2ebc144683d8df5eac727b3d9b0de9d387ae45',registerId:'SRC-AR'},
  {id:'src_pg',guaranteeType:'personal_guarantee',sha256:'7ff0e8290b35efef5d73a95ec683fe4767d77d96ea80c3ede216d8e8c2dbe300',registerId:'SRC-PG'},
  {id:'src_cgt',guaranteeType:'corporate_guarantee',sha256:'4f0658a1277bcfe6e6e436c2018060eb5dfb2dbc57d73a9c4a2e63fc84292128',registerId:'SRC-CGT'},
  {id:'src_sblc',guaranteeType:'sblc',sha256:'ce50b7c89aa446311e0b7f224b0f4f3d5196a61ac5441f36e68b8fe99107fcaa',registerId:'SRC-SBLC'},
  {id:'src_mtg',guaranteeType:'mortgage',sha256:'a0f8cb9b3216f915710db06d098d6a695b5391bdc04566d784e6317e8acb4caa',registerId:'SRC-MTG'},
] as const);

/** Explicit synthetic candidate only. It is never published by constructing it. */
export function createLegacySyntheticReviewConfigManifest(releaseId='synthetic_mortgage_v1'):ReviewConfigManifest {
  const sourceIds=['synthetic_mortgage'];
  const fact=(value:string|boolean|null,state:z.infer<typeof ReviewFactSchema>['state']='present')=>({value,state,evidenceIds:[]});
  const field=(id:string,label:string,type:ReviewFieldDefinition['type'],objectKind:ReviewFieldDefinition['objectKind'],aliases:string[],semanticDefinition:string):ReviewFieldDefinition=>({
    id,label,type,objectKind,...(['borrower','mortgagor'].includes(id)?{objectRole:id}:{}),aliases,semanticDefinition,unit:type==='amount'?'currency':null,currency:type==='amount'?'USD':null,
    requiredDetection:true,requiredValue:id!=='unused_endorsement',sourceIds,
    recipe:{version:'synthetic_mortgage_fields_v1',model:null,promptSha256:'5873f1f7f214255bd7a14474b30a188ac7fffc49a33b386b0078b6a21c64e444',mode:objectKind==='party'||id==='unused_endorsement'||id.endsWith('_perils')?'manual':'deterministic'},
  });
  const fields=[
    field('borrower','借款人','text','party',['Borrower','借款人'],'Synthetic chain borrower; manual object/role confirmation required.'),
    field('mortgagor','抵押人','text','party',['Mortgagor','抵押人'],'Synthetic first chain assumes borrower-owned collateral; third-party collateral is outside this subset.'),
    field('facility_reference','授信编号','text','financing',['Facility Reference','授信编号'],'Identifier of the current facility letter.'),
    field('mortgage_facility_reference','抵押对应授信编号','text','guarantee',['Secured Facility Reference','抵押对应授信编号'],'Facility reference explicitly secured by this mortgage.'),
    field('mortgage_reference','抵押编号','text','guarantee',['Mortgage Reference','抵押编号'],'Identifier of the mortgage instrument.'),
    field('policy_mortgage_reference','保单对应抵押编号','text','policy',['Insured Mortgage Reference','保单对应抵押编号'],'Mortgage reference explicitly covered by this policy.'),
    field('facility_amount','授信金额','amount','financing',['Facility Amount','授信金额'],'Current facility principal limit, excluding fees and premiums; synthetic USD only.'),
    field('secured_amount','担保金额','amount','guarantee',['Secured Amount','担保金额'],'Mortgage secured principal amount; synthetic threshold is one times the facility limit.'),
    field('insured_amount','保险金额','amount','policy',['Insured Amount','保险金额'],'Coverage amount for linked collateral; synthetic threshold is one times the facility principal.'),
    field('facility_currency','授信币种','currency','financing',['Facility Currency','授信币种'],'ISO currency of current facility principal.'),
    field('mortgage_currency','抵押币种','currency','guarantee',['Mortgage Currency','抵押币种'],'ISO currency of secured mortgage amount.'),
    field('policy_currency','保险币种','currency','policy',['Policy Currency','保险币种'],'ISO currency of insurance coverage amount.'),
    field('facility_start','授信开始日期','date','financing',['Facility Start','授信开始日期'],'Frozen contractual facility start date, inclusive in this synthetic subset.'),
    field('facility_maturity','授信到期日期','date','financing',['Facility Maturity','授信到期日期'],'Frozen final repayment date, inclusive in this synthetic subset.'),
    field('policy_start','保险开始日期','date','policy',['Policy Start','保险开始日期'],'Effective policy coverage start date.'),
    field('policy_end','保险结束日期','date','policy',['Policy End','保险结束日期'],'Effective policy coverage end date.'),
    field('unused_endorsement','未使用背书栏','text','signatory',['Unused Endorsement','未使用背书栏'],'Synthetic example explicitly required blank; manual inspection only, not a bank requirement.'),
    field('insured_perils','已承保风险集合','text','policy',['Insured Perils JSON','已承保风险集合 JSON'],'Synthetic manually confirmed canonical JSON array of distinct nonempty strings; never split free text into a set.'),
    field('required_perils','要求风险集合','text','policy',['Required Perils JSON','要求风险集合 JSON'],'Synthetic test-only required perils as a manually confirmed canonical JSON string array, not a bank-approved coverage list.'),
  ];
  const rule=(id:string,label:string,operator:ReviewRule['operator'],inputs:string[],normal:Array<string|boolean|null>,abnormal:Array<string|boolean|null>,boundary:Array<string|boolean|null>):ReviewRule=>({
    id,label,operator,inputs,sourceIds,sourceDirectionConfirmed:true,requiredParameters:[],tests:(['normal','abnormal','boundary','missing_input'] as const).map(kind=>{
      const values=kind==='abnormal'?abnormal:kind==='boundary'?boundary:normal;
      const facts=Object.fromEntries(inputs.map((key,index)=>[key,kind==='missing_input'&&index===0?fact(null,'missing'):fact(values[index]!,operator==='blank'&&values[index]===null?'blank':'present')]));
      return {id:kind,kind,synthetic:true as const,facts,expected:kind==='abnormal'?'fail':kind==='missing_input'?operator==='present'?'fail':'blocked':'pass'};
    }),
  });
  const rules=[
    ...['facility','mortgage','policy'].map(material=>rule(`material_${material}`,`合成材料要求：${material}`,'present',[`material:${material}`],[true],[false],[true])),
    rule('borrower_mortgagor','借款人与抵押人对应','equal',['borrower','mortgagor'],['Synthetic Borrower Ltd','Synthetic Borrower Ltd'],['Synthetic Borrower Ltd','Synthetic Other Ltd'],['Synthetic A','Synthetic A']),
    rule('facility_reference_match','抵押对应授信编号','equal',['mortgage_facility_reference','facility_reference'],['SYN-F-001','SYN-F-001'],['SYN-F-002','SYN-F-001'],['SYN-1','SYN-1']),
    rule('mortgage_reference_match','保单对应抵押编号','equal',['policy_mortgage_reference','mortgage_reference'],['SYN-M-001','SYN-M-001'],['SYN-M-002','SYN-M-001'],['SYN-1','SYN-1']),
    rule('mortgage_currency_match','抵押与授信币种','equal',['mortgage_currency','facility_currency'],['USD','USD'],['EUR','USD'],['USD','USD']),
    rule('policy_currency_match','保险与抵押币种','equal',['policy_currency','mortgage_currency'],['USD','USD'],['EUR','USD'],['USD','USD']),
    rule('secured_minimum','担保金额覆盖授信金额','minimum',['secured_amount','facility_amount'],['120','100'],['90','100'],['100','100']),
    rule('coverage_minimum','保险金额覆盖授信金额','minimum',['insured_amount','facility_amount'],['150','100'],['90','100'],['100','100']),
    rule('facility_date_order','授信起止顺序','date_order',['facility_start','facility_maturity'],['2026-01-01','2026-12-31'],['2027-01-01','2026-12-31'],['2026-01-01','2026-01-01']),
    rule('policy_period_coverage','保险期间覆盖授信期间','range_covers',['policy_start','policy_end','facility_start','facility_maturity'],['2025-12-01','2027-01-31','2026-01-01','2026-12-31'],['2026-02-01','2026-12-31','2026-01-01','2026-12-31'],['2026-01-01','2026-12-31','2026-01-01','2026-12-31']),
    rule('unused_endorsement_blank','未使用背书栏留空','blank',['unused_endorsement'],[null],['Synthetic written endorsement'],[null]),
    rule('perils_coverage','合成风险集合覆盖','set_covers',['insured_perils','required_perils'],['["fire","flood"]','["fire"]'],['["fire"]','["flood"]'],['["fire"]','["fire"]']),
  ];
  return ReviewConfigManifestSchema.parse({schemaVersion:'review-config.v1',releaseId,label:'合成抵押融资规则候选',scope:'synthetic',scenario:'overseas_loan',guaranteeTypes:['mortgage'],bankApprovalRef:null,
    sources:[{id:'synthetic_mortgage',reference:'repo:infra/opa/review/synthetic-source.txt',sha256:'3edda484398c4b4bba8216674ab85d53a2c99e1112c7100a2463d9f5dbd5629e',guaranteeType:'mortgage',disposition:'candidate',reason:'Synthetic engineering fixture including synthetic blank/set examples; not bank approval or a workbook rule mapping',approvalRef:null},
      ...REVIEW_BANK_SOURCE_REFERENCES.map(source=>({id:source.id,reference:`repo:docs/p3/review-source-dispositions.json#${source.registerId}`,sha256:source.sha256,guaranteeType:source.guaranteeType,disposition:source.guaranteeType==='mortgage'?'candidate':'manual',reason:source.guaranteeType==='mortgage'?'Actual source rows registered; atomic mapping and bank confirmation pending; executable fixture does not reference these rows':'Actual source rows registered; outside first executable chain, manual review and bank confirmation required',approvalRef:null}))],
    taxonomy:[{id:'facility_letter',label:'授信函',keywords:['Facility Letter','授信函'],sourceIds},{id:'mortgage_contract',label:'抵押合同',keywords:['Mortgage Contract','抵押合同'],sourceIds},{id:'insurance_policy',label:'保单',keywords:['Insurance Policy','保单'],sourceIds}],
    materials:[{id:'facility',label:'授信函',taxonomyId:'facility_letter',required:true,sourceIds},{id:'mortgage',label:'抵押合同',taxonomyId:'mortgage_contract',required:true,sourceIds},{id:'policy',label:'保单',taxonomyId:'insurance_policy',required:true,sourceIds}],
    fields,rules,parameters:{},compatibility:{documentSchema:'p2.v2',factsSchema:'review-facts.v1',executorVersion:'p3-deterministic-v1'}});
}

/** v2 makes identity and the no-FX USD scope explicit without changing published v1 operators. */
export function createSyntheticReviewConfigManifest(releaseId='synthetic_mortgage_v2'):ReviewConfigManifest {
  const manifest=createLegacySyntheticReviewConfigManifest(releaseId);
  manifest.label='合成抵押融资规则候选 v2';
  manifest.compatibility={documentSchema:'p2.v2',factsSchema:'review-facts.v2',executorVersion:'p3-deterministic-v2'};
  Object.assign(manifest.sources[0]!,{reference:'repo:infra/opa/review/synthetic-source-v2.txt',sha256:'bd1d5c1e8846707a8bed75e20003787e56d7e19eb13ca723722b454af2eaf497'});
  const identity=manifest.rules.find(rule=>rule.id==='borrower_mortgagor')!;identity.operator='same_entity';identity.label='借款人与抵押人为同一主体（人工身份确认）';
  for(const fixture of identity.tests){
    Object.assign(fixture.facts.borrower!,{objectId:'synthetic-borrower',sameEntityIds:fixture.kind==='abnormal'?[]:['synthetic-mortgagor'],differentEntityIds:fixture.kind==='abnormal'?['synthetic-mortgagor']:[]});
    Object.assign(fixture.facts.mortgagor!,{objectId:'synthetic-mortgagor',sameEntityIds:[],differentEntityIds:[]});
  }
  const present=(value:string):ReviewFacts[string]=>({value,state:'present',evidenceIds:[]});
  for(const [id,currencyField] of [['secured_minimum','mortgage_currency'],['coverage_minimum','policy_currency']] as const){
    const rule=manifest.rules.find(rule=>rule.id===id)!;rule.operator='minimum_in_currency';rule.currency='USD';rule.inputs.push(currencyField,'facility_currency');
    for(const fixture of rule.tests){fixture.facts[currencyField]=present('USD');fixture.facts.facility_currency=present('USD');}
  }
  const currencyInputs=['policy_currency','mortgage_currency','facility_currency'];
  manifest.rules.push({id:'usd_scope',label:'首链金额币种均为 USD（不换汇）',operator:'currency_is',currency:'USD',inputs:currencyInputs,sourceIds:['synthetic_mortgage'],sourceDirectionConfirmed:true,requiredParameters:[],tests:(['normal','abnormal','boundary','missing_input'] as const).map(kind=>({id:kind,kind,synthetic:true,facts:Object.fromEntries(currencyInputs.map((id,index)=>[id,kind==='missing_input'&&index===0?{value:null,state:'missing',evidenceIds:[]}:present(kind==='abnormal'?'EUR':'USD')])),expected:kind==='abnormal'?'fail':kind==='missing_input'?'blocked':'pass'}))});
  return ReviewConfigManifestSchema.parse(manifest);
}
