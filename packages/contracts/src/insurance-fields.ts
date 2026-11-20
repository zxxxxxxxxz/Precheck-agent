import {createSyntheticReviewConfigManifest, ReviewConfigManifestSchema, REVIEW_EXTRACTION_RECIPES, type ReviewConfigManifest, type ReviewFieldDefinition} from './review-config.js';

export const INSURANCE_MATERIAL_TYPES = ['insurance_policy', 'insurance_application', 'insurance_confirmation', 'insurance_terms', 'insurance_product_description'] as const;
export const SYNTHETIC_INSURANCE_FIELD_IDS = ['unused_endorsement', 'insured_perils', 'required_perils'] as const;
const transactionTypes = ['insurance_policy', 'insurance_application', 'insurance_confirmation'];

/** Requirement rows, not approved review rules. C55:C56 are children of C54. */
export const INSURANCE_REQUIREMENTS = [
  {id:'insurance_company',label:'保险公司',row:53,fieldIds:['insurance_company','insurer']},
  {id:'insurance_subject',label:'保险标的',row:54,fieldIds:['insurance_subject']},
  {id:'insurance_risk_location',label:'风险所在地',row:55,parentId:'insurance_subject',fieldIds:['insurance_risk_location']},
  {id:'insurance_property',label:'被保险物',row:56,parentId:'insurance_subject',fieldIds:['insurance_property']},
  {id:'insurance_period',label:'保险期限',row:57,fieldIds:['insurance_period','policy_start','policy_end','proposed_start','proposed_end']},
  {id:'insurance_policyholder',label:'投保人',row:58,fieldIds:['insurance_policyholder','policyholder','insurance_applicant']},
  {id:'insurance_insured_party',label:'被保险人',row:59,fieldIds:['insurance_insured_party','insured_party','proposed_insured']},
  {id:'insurance_beneficiary',label:'受益人',row:60,fieldIds:['insurance_beneficiary']},
  {id:'insurance_coverage',label:'保险范围',row:61,fieldIds:['insurance_coverage']},
  {id:'insurance_special_clauses',label:'附加特别条款',row:62,fieldIds:['insurance_special_clauses']},
  {id:'insurance_sum_insured',label:'保险金额',row:63,fieldIds:['insurance_sum_insured','insured_amount','proposed_insured_amount']},
  {id:'insurance_application_reference',label:'投保单号',row:64,fieldIds:['insurance_application_reference','insurance_application_number']},
  {id:'insurance_payment_evidence',label:'保费支付凭证',row:65,fieldIds:['insurance_payment_evidence']},
] as const;

export type InsuranceRequirement = typeof INSURANCE_REQUIREMENTS[number];
export interface DocumentFieldCapability {id:string;taxonomyIds?:string[];mode:'automatic'|'manual'}

/** The registered cloud recipe currently accepts controlled synthetic releases.
 * Do not broaden its approved data scope or change another guarantee's fields. */
export function canUpdateMortgageInsuranceFields(manifest:ReviewConfigManifest):boolean {
  return manifest.scope==='synthetic'&&manifest.guaranteeTypes.length===1&&manifest.guaranteeTypes[0]==='mortgage';
}

/** Formal configuration creation uses this template; historical fixtures keep
 * using their original factory and retain their original rule/field IDs. */
export function createMortgageReviewConfigManifest(releaseId:string):ReviewConfigManifest {
  const manifest=createInsuranceExtractionCandidate(createSyntheticReviewConfigManifest(releaseId),releaseId);
  manifest.label='抵押融资配置';
  return manifest;
}

/** Existing manifests/receipts are immutable. This builds a new unpublished
 * extraction candidate, retaining the independent approval/publication flow. */
export function createInsuranceExtractionCandidate(base:ReviewConfigManifest, releaseId:string):ReviewConfigManifest {
  if(!canUpdateMortgageInsuranceFields(base))throw new Error('insurance_candidate_requires_mortgage_synthetic_base');
  const manifest=structuredClone(base);
  manifest.releaseId=releaseId;
  manifest.bankApprovalRef=null;
  const sourceId='insurance_fields_mtg_20261021';
  const source:ReviewConfigManifest['sources'][number]={id:sourceId,reference:'SRC-MTG/提取信息!C53:G65',sha256:'a0f8cb9b3216f915710db06d098d6a695b5391bdc04566d784e6317e8acb4caa',guaranteeType:'mortgage',disposition:'candidate',reason:'保险提取字段来源映射；仅用于受控样本验证，未批准银行自动审核规则。',approvalRef:null};
  const existingSource=manifest.sources.find(item=>item.id===sourceId);
  if(existingSource&&(existingSource.sha256!==source.sha256||existingSource.reference!==source.reference||existingSource.guaranteeType!==source.guaranteeType))throw new Error('insurance_source_conflict');
  if(!existingSource)manifest.sources.push(source);
  const removed=new Set<string>(SYNTHETIC_INSURANCE_FIELD_IDS);
  manifest.fields=manifest.fields.filter(field=>!removed.has(field.id));
  manifest.rules=manifest.rules.filter(rule=>!(['unused_endorsement_blank','perils_coverage'].includes(rule.id)&&rule.inputs.every(id=>removed.has(id))));
  if(manifest.rules.some(rule=>[...rule.inputs,...rule.tests.flatMap(test=>Object.keys(test.facts)),rule.applicability?.fieldId??''].some(id=>removed.has(id)))||manifest.materials.some(material=>removed.has(material.applicability?.fieldId??'')))throw new Error('insurance_candidate_has_dependent_test_rule');
  const taxonomies=[
    {id:'insurance_policy',label:'保单／保险合同',keywords:['保单','保险合同','Insurance Policy','Insurance Contract']},
    {id:'insurance_application',label:'保险投保申请',keywords:['投保单','投保申请','Insurance Application','Insurance Proposal']},
    {id:'insurance_confirmation',label:'保险确认函',keywords:['保险确认函','Insurance Confirmation']},
    {id:'insurance_terms',label:'保险条款／附加条款',keywords:['保险条款','附加条款','Insurance Terms','Policy Wording']},
    {id:'insurance_product_description',label:'保险产品说明',keywords:['保险产品说明','Insurance Product Description']},
    {id:'invoice',label:'发票',keywords:['发票','Invoice']},
    {id:'premium_payment_receipt',label:'保费支付凭证',keywords:['保费收据','保费支付凭证','保险费收据','Premium Receipt','Premium Payment Receipt','Payment Advice']},
  ];
  for(const type of taxonomies){
    const existing=manifest.taxonomy.find(item=>item.id===type.id);
    if(!existing)manifest.taxonomy.push({...type,sourceIds:[sourceId]});
    else if(type.id==='insurance_policy'||type.id==='insurance_application'){
      existing.keywords=[...new Set([...existing.keywords,...type.keywords])];
      existing.sourceIds=[...new Set([...existing.sourceIds,sourceId])];
      if(type.id==='insurance_policy')existing.label=type.label;
    }
  }
  if(!manifest.materials.some(material=>material.id==='premium_payment_receipt'))manifest.materials.push({id:'premium_payment_receipt',label:'保费支付凭证',taxonomyId:'premium_payment_receipt',required:false,sourceIds:[sourceId]});
  const recipe=REVIEW_EXTRACTION_RECIPES.find(recipe=>recipe.version==='azure-grounded-fields-v2')!;
  const descriptions:Record<string,string>={
    insurance_company:'本保险交易明确记载的保险公司／保险人名称。适用于保单、投保单和确认函，保留原文角色。排除经纪人、代理人、投保人、发票销售方及产品说明里的示例公司；投保申请上的名称不证明已经承保。',
    insurance_subject:'当前保险标的整体描述及标的名称，保留所对应的资产、项目及范围。风险所在地和被保险物另列；不得用借款人名称、评估值或其他文件的资产信息补填。多个标的分别保留。',
    insurance_risk_location:'当前被保险风险／资产所在地、坐落地址，保留完整楼栋、楼层、房号及区域限定。排除保险公司、投保人、被保险人的通讯地址及其他文件地址；不得补全被遮盖部分。',
    insurance_property:'保险标的项下明确列出的被保险物、财产种类和组成，例如建筑物、设备及存货。保留纳入和排除条件，不把被保险人或通用产品介绍当作本案财产。',
    insurance_period:'当前保险的完整起止期间，保留原文日期、时刻、时区及起止限定。投保申请须保留拟投保含义，不认定已生效；排除签发、缴费日期和贷款期限。开始和结束可以分别引用，不编造缺失的一端。',
    insurance_policyholder:'当前保险交易明确的投保人／投保申请人名称。引用能证明角色的上下文，不把被保险人、保险公司、借款人自动当作投保人。申请中的角色不证明保单已生效。',
    insurance_insured_party:'当前保险交易明确的被保险人／拟被保险人名称，保留原文角色。排除投保人、保险公司、代理人；投保申请里的名称不证明已经承保。',
    insurance_beneficiary:'明确指定的保险受益人、第一受益人或赔款接受人，逐项保留原文角色、优先次序和适用条件。仅出现抵押权人、贷款人或通用银行条款不能认定为指定受益人；不凭融资关系补造。',
    insurance_coverage:'本文件列明的保险责任／承保范围、适用险种及对应责任免除、限制条件，分条引用原文。保留所引用条款名称及范围；通用保险条款或产品说明须保留其文种，不自动认定已被本案采用。不得改写为风险标签集合或遗漏免责条件。',
    insurance_special_clauses:'本文件明确列明的附加／特别条款，逐条保留名称、正文条件、适用对象及限制。附加险限额列表不等同于全部特别条款；正文和跨页续文分别引用，不仅截取标题。通用条款的存在不证明已被本案保单采用。',
    insurance_sum_insured:'当前保险标的的保险金额及各分项金额，完整保留标的、币种、金额、比例基数和限额条件；主险总额与附加险限额分别记录。投保申请金额保留拟投保含义，不代表已承保。排除保费、税额及估值，禁止自行求和或推断币种。',
    insurance_application_reference:'投保申请／投保单自身明确编号，必须有投保单号、投保申请编号或 Proposal/Application Number 的角色依据。排除正式保单号、保批单号、发票号及收据号；其他文种仅可提取明确引用的投保单号。',
    insurance_payment_evidence:'本文件中保费收付的凭证内容，保留凭证类型、明确的付款／收讫状态、日期、金额、币种、双方及所对应保单／投保单编号。发票只可作为发票凭证候选，没有明确收款或支付记录不得认定已缴费。付款约定、应缴保费及空白收据不是实际付款证据。不按相同金额推断跨文件关联。',
  };
  const parties=new Set(['insurance_company','insurance_policyholder','insurance_insured_party','insurance_beneficiary']);
  const aliases:Record<string,string[]>={
    insurance_company:['保险公司','保险人','保險人','承保公司','Insurer','Underwriter'],
    insurance_subject:['保险标的','保險標的','标的名称','Subject Matter Insured','Property Insured'],
    insurance_risk_location:['风险所在地','風險所在地','财产坐落','保险财产地址','被保险财产地址','保险地址','Location of Risk','Risk Location','Situation of Property','Premises Insured'],
    insurance_property:['被保险物','被保險物','保险财产','保险项目','财产项目','Property Insured','Insured Property'],
    insurance_period:['保险期限','保险期间','保險期間','Period of Insurance','Policy Period'],
    insurance_policyholder:['投保人','投保申请人','投保單位','投保单位','Policyholder','Applicant','Proposer'],
    insurance_insured_party:['被保险人','被保險人','拟被保险人','Insured','Proposed Insured'],
    insurance_beneficiary:['受益人','第一受益人','赔款接受人','賠款接受人','Beneficiary','First Beneficiary','Loss Payee'],
    insurance_coverage:['保险范围','保险责任','保險責任','承保范围','Coverage','Perils Insured','Risks Covered'],
    insurance_special_clauses:['附加特别条款','特别约定','特别条款','附加条款','Special Conditions','Special Clauses','Endorsements','Extensions'],
    insurance_sum_insured:['保险金额','保險金額','总保险金额','Sum Insured','Insured Amount','Limit of Liability'],
    insurance_application_reference:['投保单号','投保單號','投保申请编号','Proposal Number','Application Number'],
    insurance_payment_evidence:['保费支付凭证','保费收据','保险费收据','发票','Premium Receipt','Payment Receipt','Premium Invoice'],
  };
  for(const row of INSURANCE_REQUIREMENTS){
    const clause=!parties.has(row.id)&&row.id!=='insurance_application_reference'&&row.id!=='insurance_risk_location';
    const definition:ReviewFieldDefinition={id:row.id,label:row.label,type:'text',unit:null,currency:null,objectKind:parties.has(row.id)?'party':'policy',
      ...(parties.has(row.id)?{objectRole:row.id,partyKinds:row.id==='insurance_company'?['organization']:['organization','person'] as Array<'organization'|'person'>}:{}),
      aliases:aliases[row.id]!,requireLabel:!clause,
      ...(row.id==='insurance_risk_location'?{excludedLabels:['通讯地址','通信地址','联系地址','Mailing Address','Correspondence Address']}:{}),
      semanticDefinition:descriptions[row.id]!+' 遮挡、黑框、空白占位和字段标签本身不是字段值；可见字段但内容无法辨认时保留不确定状态，不补造，也不把遮挡误判为原文未见。',taxonomyIds:row.id==='insurance_payment_evidence'?[...transactionTypes,'premium_payment_receipt','invoice']:
        ['insurance_coverage','insurance_special_clauses'].includes(row.id)?[...INSURANCE_MATERIAL_TYPES]:[...transactionTypes],
      valueKind:parties.has(row.id)?'party_name':row.id==='insurance_risk_location'?'address':row.id==='insurance_application_reference'?'identifier':'text',
      valueMultiplicity:parties.has(row.id)?'entities':clause?'clauses':'single',requiredDetection:true,requiredValue:false,sourceIds:[sourceId],
      recipe:{version:recipe.version,model:recipe.model,promptSha256:recipe.promptSha256,mode:'cloud_grounded_extract'}};
    const index=manifest.fields.findIndex(field=>field.id===row.id);
    if(index<0)manifest.fields.push(definition);else manifest.fields[index]=definition;
  }
  const bankFields=new Set<string>(INSURANCE_REQUIREMENTS.map(row=>row.id));
  manifest.fields=[...INSURANCE_REQUIREMENTS.map(row=>manifest.fields.find(field=>field.id===row.id)!),...manifest.fields.filter(field=>!bankFields.has(field.id))];
  return ReviewConfigManifestSchema.parse(manifest);
}
