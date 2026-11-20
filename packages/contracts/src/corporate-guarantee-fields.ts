import type {ReviewFieldDefinition} from './review-config.js';

const amountLabels = ['金额', '金額', 'Amount', '担保金额', '擔保金額', '保证金额', '保證金額', '指定金额', '指定金額', '保证本金', '保證本金', 'Specified Sum', 'Guarantee Amount', 'Guaranteed Amount', 'Principal Cap', 'Maximum Liability'];
const otherAmounts = ['Banking Facilities', 'Facility Amount', 'Facility Limit', 'Loan Amount', 'Default Interest', 'Interest Rate', '授信额度', '授信額度', '授信金额', '授信金額', '贷款金额', '貸款金額', '利率'];
const privacy = '仅使用本份保证书可见原文及对应位置，不借用授信函或其他主体资料，不计算原文没有的金额。候选仍须按担保对象核对确认。';

/** New manifests only. Keep the existing field identities and confirmation flow. */
export function corporateGuaranteeValueFields(recipe: ReviewFieldDefinition['recipe'], bankAmount = false): ReviewFieldDefinition[] {
  const field = (id: string, label: string, type: 'amount' | 'currency', definition: string): ReviewFieldDefinition => ({
    id, label, type, valueKind: type, valueMultiplicity: 'single',
    objectKind: 'guarantee', objectRole: 'corporate_guarantee', taxonomyIds: ['cgt_guarantee'],
    aliases: [...amountLabels], excludedLabels: [...otherAmounts], requireLabel: true,
    unit: type === 'amount' ? 'currency' : null, currency: null,
    requiredDetection: true, requiredValue: false, sourceIds: ['cgt_field_source_12', 'cgt_rule_source_13'], recipe,
    semanticDefinition: `${type === 'amount' && !bankAmount ? definition.replace('全部责任上限。', '全部责任上限；完整定义和例外另由担保金额及责任范围字段保留。') : definition} ${privacy}`,
  });
  return [
    field('cgt_amount', '担保金额（保证书载明）', 'amount',
      '提取该公司保证书明确载明的担保金额或 Specified Sum／指定本金金额，值仅为原文数字及紧邻的明确币种。须引用定义金额的完整上下文；不得把 Banking Facilities 授信额度、利率、日期或文件编号当作担保金额。Maximum Liability 如定义为指定本金加利息及费用，数字只表示指定本金，不能称为全部责任上限。无限额、仅有比例或没有明确数字时保持未提取，不填零。'),
    field('cgt_currency', '担保币种', 'currency',
      '仅提取与本保证书明确载明的担保金额／Specified Sum 直接相连的币种，保留金额定义上下文。不得用 Banking Facilities 授信额度、支付账户或其他款项的币种代替，不从单独的 $ 符号猜测 USD。'),
  ];
}

export const corporateGuaranteeAmountField: Partial<ReviewFieldDefinition> = {
  label: '担保金额', type: 'text', valueKind: 'amount', valueMultiplicity: 'single',
  aliases: [...amountLabels], excludedLabels: [...otherAmounts], requireLabel: true,
  semanticDefinition: '只提取保证书明确载明的担保金额／Specified Sum 数字及紧邻币种。不提取完整责任范围、利息或执行费用条款，不将本金称为全部责任上限。无限额或金额未载明时不填零。 ' + privacy,
};

export const corporateGuaranteeLimitField: Partial<ReviewFieldDefinition> = {
  label: '是否无限额担保', valueMultiplicity: 'single', requiredDetection: true,
  aliases: ['GUARANTEE (Limited Amount)', 'GUARANTEE (Unlimited Amount)', 'Unlimited Guarantee', 'Limited Guarantee', '无限额责任担保', '無限額責任擔保', '有限额责任担保', '有限額責任擔保'],
  semanticDefinition: '仅提取原文明示的有限额／无限额担保类型，保留原词和位置。Limited Amount 对应 limited，Unlimited Amount／无限额责任担保对应 unlimited。金额缺失、continuing guarantee、all monies 或本金之外另计利息费用，均不能单独推断为无限额；不提取责任范围长条款。 ' + privacy,
};

export const corporateGuaranteeLiabilityField: Partial<ReviewFieldDefinition> = {
  label: '担保金额及责任范围', aliases: [...amountLabels, 'Maximum Liability', '最大责任', '最高責任'],
  semanticDefinition: '完整提取担保金额及责任范围：Specified Sum／指定金额的定义、Maximum Liability／最大责任的定义，以及相关利息、执行费用、上限、条件与例外。定义互相引用时保留各段原文与位置，不只截取 Maximum Liability 段而遗漏所引用的指定金额。明确区分指定本金上限与包含息费的全部责任上限；无限额须有明文，不由金额缺失推断。 ' + privacy,
};
