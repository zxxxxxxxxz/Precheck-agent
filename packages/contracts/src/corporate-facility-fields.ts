import type {ReviewFieldDefinition} from './review-config.js';

/** New configurations use independent, source-backed values. Published manifests
 * and facts under the former compound field IDs are never rewritten. */
export function corporateFacilityFields(recipe: ReviewFieldDefinition['recipe']): ReviewFieldDefinition[] {
  const field = (id: string, label: string, semanticDefinition: string, options: Partial<ReviewFieldDefinition> = {}): ReviewFieldDefinition => ({
    id, label, type: 'text', valueKind: 'text', valueMultiplicity: 'single',
    objectKind: 'guarantee', objectRole: 'corporate_guarantee', taxonomyIds: ['cgt_facility'],
    aliases: [label], unit: null, currency: null, requiredDetection: true, requiredValue: false,
    sourceIds: ['cgt_materials'], recipe,
    semanticDefinition: `${semanticDefinition} 仅使用本份授信函可见原文及对应位置；不得借用其他文件或样本答案。多主体、不同金额或日期保留分别对应的候选，不合并、不猜测、不自动确认。`,
    ...options,
  });
  const party = (id: string, label: string, aliases: string[], role: string) => field(id, label,
    `仅提取授信函明确列为${label}的主体全称，保留同一主体有原文关联的中英文名称；不包含角色标签、住所、注册地或整段条款，不把担保公司或其他主体混入。`, {
      valueKind: 'party_name', valueMultiplicity: 'entities', partyKinds: ['organization', 'person'], requireLabel: true, aliases,
      // These are adjacent labelled values, not nested owner sections. Never
      // inherit the preceding borrower's row as the lender's section owner.
      roleEvidence: {version: 'source-role-v1', role, labels: aliases, genericLabels: [], headings: [], otherHeadings: [], declarationTerms: aliases},
    });
  const borrowers = ['借款人', '借款人名称', 'Borrower', 'Borrower Name'];
  const lenders = ['贷款人', '貸款人', '贷款银行', 'Lender', 'Lending Bank'];
  const guarantors = ['担保人', '擔保人', '保证人', '保證人', '担保公司', 'Guarantor'];
  return [
    party('cgt_facility_borrower', '借款人', borrowers, 'borrower'),
    party('cgt_facility_lender', '贷款人', lenders, 'lender'),
    field('cgt_facility_guarantor', '担保公司',
      '仅提取担保条款中明确出具或提供公司保证的公司全称。可以依据“某公司出具某号公司保证”的完整句子证明角色，不要求名称前一定有“担保人”标签；保留该角色句作为上下文。不得仅凭母子公司或股东关系推定担保人；不提取借款人、贷款人、保证书编号或整段担保安排。',
      {valueKind: 'party_name', valueMultiplicity: 'entities', partyKinds: ['organization'], aliases: [...guarantors, '公司保证', '公司保證', '公司担保', '公司擔保', 'Corporate Guarantee']}),
    field('cgt_required_amount', '担保金额（授信函要求）',
      '提取授信函明确要求该担保公司提供的保证金额或保证本金指定金额，值只保留原文金额及其明确币种，担保公司、保证书编号及完整要求作为上下文。不得以授信额度、贷款本金、其他公司的保证金额或保证书自身金额代替。原文写“另加利息／费用”时，该数字不是包含息费的绝对责任总上限；附加责任另保留在担保责任范围字段，不计算合计。未明确金额、无限额或仅有比例时保持未知，不填零。',
      {type: 'amount', valueKind: 'amount', unit: 'currency', sourceIds: ['cgt_rule_source_13'], aliases: ['担保金额', '保证金额', '保证本金指定金额', '指定金额', 'Guarantee Amount', 'Guaranteed Amount']}),
    field('cgt_required_currency', '担保币种（授信函要求）',
      '仅提取与授信函要求的该公司保证金额直接相连的明确币种；不能使用授信额度或其他款项的币种，也不能从单独的 $ 符号猜测 USD。不同担保的金额和币种分别对应。',
      {type: 'currency', valueKind: 'currency', sourceIds: ['cgt_rule_source_13']}),
    field('cgt_facility_guarantee_terms', '担保责任范围',
      '完整保留授信函对公司保证的有限额／无限额性质、保证书编号、指定金额的含义、利息和执行费用是否另计，以及适用条件、例外和对应公司。跨页补充须保留全部原文位置；不要把另计息费丢掉或将有限额保证改称无限额保证。排除无关的借款人注册地、一般支付条款及接受授信声明。',
      {valueMultiplicity: 'clauses', sourceIds: ['cgt_rule_source_13']}),
    field('cgt_facility_name', '授信函名称',
      '提取本份授信函的主标题及紧邻标题的授信函编号，保留原文。不包含出具日期，不用附件名称、特别授信条款、一般授信条款或正文引用的其他文件名称代替主标题。'),
    field('cgt_facility_issue_date', '出具日期',
      '仅提取本份授信函首页或出具栏明确记载的出具日期。不用借款人接受／签署日、授信到期日、附件日期、保证书日期或模板日期代替；没有明确出具日期时保持未知。',
      {type: 'date', valueKind: 'date', aliases: ['出具日期', '日期', 'Date', 'Issue Date', 'Date of Issue'],
        excludedLabels: ['接受日期', '签署日期', '签署日', '到期日期', '到期日', '附件日期', '保证书日期', 'Date of Acceptance', 'Acceptance Date', 'Signing Date', 'Expiry Date', 'Maturity Date']}),
  ];
}
