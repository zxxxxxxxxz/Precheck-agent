import {ReviewConfigManifestSchema, type ReviewConfigManifest, type ReviewFieldDefinition} from './review-config.js';

/** Preserve bank field identities while using guarantee roles, not ownership. */
export const corporateRmPartyDefinitions:Record<string,Partial<ReviewFieldDefinition>>=Object.fromEntries(([
  ['cgt_field_32','担保公司','rm_guarantor',
    ['担保公司','担保人名称','擔保人名稱','Guarantor','Guarantor Name','Name of Guarantor','RE GUARANTEE GIVEN BY'],
    '提供保证的公司全称；英文模板以 RE GUARANTEE GIVEN BY 后的公司为担保公司'],
  ['cgt_field_34','被担保公司','rm_guaranteed_company',
    ['被担保公司','被担保人名称','被擔保人名稱','Borrower','Borrower Name','Customer','TO SECURE THE ACCOUNT OF'],
    '保证所保障账户所属的公司全称；英文模板以 TO SECURE THE ACCOUNT OF 后的公司为被担保公司，不是收件银行'],
] as const).map(([id,label,role,labels,meaning])=>[id,{
  label,aliases:[...labels],partyKinds:['organization'],
  semanticDefinition:`环球客户经理证明中的${meaning}。只提取名称，保留证明担保角色的原文和位置。不得仅凭母公司、子公司或股权关系推断担保角色，不借用其他文件；未见明确依据时保持未知。`,
  roleEvidence:{version:'source-role-v1',role,labels:[...labels],genericLabels:[],headings:[],otherHeadings:[],declarationTerms:[...labels]},
} satisfies Partial<ReviewFieldDefinition>]));

/** Explicit draft upgrade; historical manifests and unrelated rules stay intact. */
export function applyCorporateRmPartyReview(base:ReviewConfigManifest):ReviewConfigManifest {
  if(!base.guaranteeTypes.includes('corporate_guarantee'))throw new Error('corporate_configuration_required');
  if(base.scope!=='synthetic')throw new Error('corporate_candidate_requires_synthetic_scope');
  const next=structuredClone(base);
  for(const [id,definition] of Object.entries(corporateRmPartyDefinitions)){
    const field=next.fields.find(field=>field.id===id);
    if(!field||!field.taxonomyIds?.includes('cgt_rm'))throw new Error('corporate_rm_fields_required');
    Object.assign(field,structuredClone(definition));
  }
  for(const rule of next.rules){
    if(rule.id==='cgt_field_32_required')rule.label='环球客户经理证明：担保公司完整性';
    if(rule.id==='cgt_field_34_required')rule.label='环球客户经理证明：被担保公司完整性';
    if(rule.id==='cgt_bank_42')rule.label='环球客户经理证明：担保公司';
    if(rule.id==='cgt_bank_44')rule.label='环球客户经理证明：被担保公司';
  }
  return ReviewConfigManifestSchema.parse(next);
}

/** A separate revision keeps the published rm-parties-v1 dictionary stable. */
export function applyCorporateRmSourceReview(base:ReviewConfigManifest):ReviewConfigManifest {
  const next=applyCorporateRmPartyReview(base);
  const updates:Record<string,Partial<ReviewFieldDefinition>>={
    cgt_field_35:{label:'汇丰银行名称',partyKinds:['organization'],aliases:['汇丰银行名称','HSBC Entity','HSBC Bank Entity','TO HSBC'],
      semanticDefinition:'环球客户经理证明收件汇丰银行的完整名称，包括原文分行名称。以 TO HSBC 或 TO The Hongkong and Shanghai Banking Corporation 后的银行全称为据，不包含 TO，不将被担保公司的账户主体当作银行。',
      roleEvidence:{version:'source-role-v1',role:'rm_bank_entity',labels:['汇丰银行名称','HSBC Entity','HSBC Bank Entity'],genericLabels:[],headings:[],otherHeadings:[],declarationTerms:[]}},
    cgt_field_37:{partyKinds:['person'],aliases:['NAME OF RM','RM Name','Relationship Manager Name','Name of Relationship Manager','客户经理名称','客户经理姓名'],
      semanticDefinition:'环球客户经理证明中 NAME OF RM 等明确标签后的客户经理姓名。保留原文中英文姓名；同一标签后用斜杠并列的中英文姓名属于同一人，不拆成两人。不把银行、公司或签署说明当作姓名。',
      roleEvidence:{version:'source-role-v1',role:'rm_relationship_manager',labels:['NAME OF RM','RM Name','Relationship Manager Name','Name of Relationship Manager','客户经理名称','客户经理姓名'],genericLabels:[],headings:[],otherHeadings:[],declarationTerms:[]}},
    cgt_field_36:{label:'已选选项 a/b',aliases:['[SELECTED] (a)','[SELECTED] (b)','已选选项'],
      semanticDefinition:'环球客户经理证明中明确标记 [SELECTED] 的 a/b 选项及其完整正文，只保留已选项。不得把 [NOT SELECTED] 误当成 SELECTED，不拼入未选项、I certify that、OR 或后续 c/d/e 条款。相同选项去重，保留原文位置；如 a、b 均选则分别保留并提示核对，不替用户选择；无明确已选标记时保持未知。'},
  };
  for(const [id,update] of Object.entries(updates)){
    const field=next.fields.find(f=>f.id===id);
    if(!field?.taxonomyIds?.includes('cgt_rm'))throw new Error('corporate_rm_fields_required');
    Object.assign(field,update);
  }
  for(const rule of next.rules){
    if(rule.id==='cgt_field_35_required')rule.label='环球客户经理证明：汇丰银行名称完整性';
    if(rule.id==='cgt_bank_45')rule.label='环球客户经理证明：汇丰银行名称';
  }
  return ReviewConfigManifestSchema.parse(next);
}
