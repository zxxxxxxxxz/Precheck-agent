export const factStateLabels: Record<string, string> = {
  present: '有值', redacted: '被遮盖', missing: '未提供', unreadable: '不可读',
  not_applicable: '不适用', expected_blank: '已核对留空', pending: '待确认',
};
export const objectKindLabels: Record<string, string> = {
  party: '主体', financing: '融资', collateral: '押品', policy: '保单',
  guarantee: '担保工具', signatory: '签署人',
};
export const materialRelationLabels: Record<string, string> = {original: '原始文件', replacement: '替换版本', amendment: '修改文件', supplement: '补充文件'};
export const objectRelationLabels: Record<string, string> = {related: '普通关联', same_entity: '确认同一主体', different_entity: '确认不同主体'};
export function objectRelationOptions(sourceKind: string, targetKind?: string, current?: string) {
  const ordinary = ['related', '对应', '担保', '承保', '归属'];
  if (current && !['same_entity', 'different_entity'].includes(current) && !ordinary.includes(current)) ordinary.push(current);
  return [...ordinary, ...(sourceKind === 'party' && targetKind === 'party' ? ['same_entity', 'different_entity'] : [])].map(value => ({value, label: objectRelationLabels[value] ?? value}));
}
export const resultLabels: Record<string, string> = {
  difference: '明确差异', discrepancy: '明确差异', fail: '明确差异', pass: '未发现差异',
  no_difference: '未发现差异', no_discrepancy: '未发现差异',
  needs_review: '需要人工判断', needs_human: '需要人工判断', manual_review: '需要人工判断',
  insufficient_evidence: '证据不足／无法检查', insufficient: '证据不足／无法检查',
  not_applicable: '不适用', blocked: '证据不足／无法检查',
};
export const configStateLabels: Record<string, string> = {draft: '草稿', validated: '校验通过', trial_passed: '试跑通过', approved: '已批准', published: '已发布'};
export const runStateLabels: Record<string, string> = {queued: '待执行', pending: '待执行', running: '检查中', ready: '检查完成', completed: '检查完成', succeeded: '检查完成', failed: '检查未完成', stale: '结果待更新', canceled: '已取消'};
export const reviewReasonLabels: Record<string, string> = {
  manual_review_required: '请依据银行要求人工核对原文及关联材料', business_rule_confirmation_required: '业务口径待确认', reference_list_required: '待配置最新批准名单', currency_mismatch: '比较金额的币种不同，需人工核对', expires_today: '今日到期，请及时更新保险材料', calendar_out_of_range: '日期超出可计算范围，需人工核对', expiry_calculated: '已按出具日期加一个日历年计算到期日',
  identity_conflicting: '主体身份确认互相冲突，需要重新核对', identity_confirmation_required: '尚未确认是否为同一主体，名称相同不能代替身份确认', field_currency_mismatch: '事实币种不符合字段定义，需要重新核对', currency_outside_scope: '币种超出本项检查范围，不能直接比较或换汇',
  condition_not_met: '不满足此项适用条件', condition_unknown: '适用条件尚未确认', parameter_missing: '参考参数未配置',
  system_check_satisfied: '系统核对：原文符合本项要求', system_check_different: '系统核对：原文与本项要求不一致',
  input_insufficient: '输入事实或原文依据不足', input_invalid_number: '金额尚未规范化', satisfied: '符合本项配置要求', requirement_not_met: '与本项配置要求不一致',
  currency_unknown: '币种无法识别', currency_conflict: '原文币种与所选币种冲突', currency_ambiguous: '原文币种有歧义', currency_required: '需要确认币种',
  unit_unknown: '单位无法识别', unit_conflict: '原文单位与所选单位冲突', amount_separator_ambiguous: '金额分隔符有歧义', amount_ambiguous: '金额含义有歧义',
  calendar_conflict: '原文历法与所选历法冲突', calendar_required: '需要确认历法', date_ambiguous: '日期有歧义', date_invalid: '日期无效', no_value: '没有可规范化的原文值', normalized: '规范化完成',
};
export const validationLabels: Record<string, string> = {
  guarantee_source_scope_mismatch: '担保类型与字段／规则来源不一致，请载入对应业务要求', object_scope_version_unsupported: '主体范围需要新版审核配置', material_object_scope_mismatch: '材料要求与审核规则的主体范围不一致',
  ratio_factor_invalid: '金额比较比例必须为正数', ltv_threshold_invalid: '抵押率上限必须使用百分比字段', manual_reason_unexpected: '仅人工核对规则可设置待核对原因',
  signature_requirements_missing: '签署要求尚未配置', signature_executor_required: '签署检查版本不兼容', signature_requirement_id_invalid: '签署要求标识无效', signature_taxonomy_invalid: '签署材料类别无效', signature_requirement_reference_missing: '签署试例引用的要求不存在',
  operator_version_unsupported: '此判断方式需要新版执行配置', identity_party_fields_required: '主体身份判断需要两个主体文字字段', rule_currency_required: '请设置指定币种', rule_currency_unexpected: '此判断方式不使用指定币种', currency_fields_required: '指定币种判断需要币种字段', currency_amount_fields_required: '依次选择金额、基准金额、金额币种、基准币种', currency_object_scope_mismatch: '金额与对应币种必须属于同一对象角色',
  field_material_scope_required: '请选择字段适用的材料类别', field_material_scope_invalid: '字段材料类别无效', field_value_kind_required: '请选择字段内容类型', field_recipe_unsupported: '请选择已审核的提取方案与版本', set_fields_required: '集合覆盖需要文字字段与明确集合', duplicate_id: '标识重复', source_disposition_missing: '来源尚未处置', bank_scope_unconfirmed: '银行适用范围尚未确认', source_reference_missing: '缺少来源依据',
  source_not_executable: '所选来源不能用于执行', bank_source_unconfirmed: '银行来源尚未确认', taxonomy_reference_missing: '引用的材料分类不存在', condition_reference_missing: '适用条件字段不存在',
  rule_arity_invalid: '输入数量与判断方式不匹配', field_reference_missing: '输入字段不存在', rule_direction_unconfirmed: '比较方向尚未核对', parameter_missing: '缺少参考参数',
  field_type_incompatible: '输入字段类型不兼容', numeric_fields_required: '金额比较需要金额字段', date_fields_required: '日期比较需要日期字段', range_fields_required: '范围比较需要起止字段',
  unit_or_currency_incompatible: '输入单位或币种不兼容', rule_test_kind_missing: '缺少正常、异常、边界或缺输入试例', rule_test_expectation_invalid: '试例预期与类别不一致', test_fact_unknown: '试例包含未定义事实', applicability_conflict: '适用条件冲突',
  guidance_field_unknown: '口径引用的字段不存在', guidance_duplicate_scope: '口径的字段或表述重复', guidance_exact_field: '金额、币种、日期及编号类字段不适用语义口径', guidance_expressions_required: '名称等同至少需要两个表述', guidance_scope_required: '口径需要指定字段或表述', guidance_duplicate_content: '存在内容相同的口径',
};
export function reviewReason(code: string): string {return reviewReasonLabels[code] ?? `需核对（${code}）`;}
export function readableValue(value: unknown): string {
  if (value === null || value === undefined || value === '') return '未提供';
  if (Array.isArray(value)) return value.map(readableValue).join('、');
  if (typeof value === 'object') return Object.entries(value as Record<string, unknown>).map(([key, entry]) => `${key}：${readableValue(entry)}`).join('；');
  return String(value);
}
export interface EvidenceLocation {documentVersionId: string; parseRevision: string; directoryRevision?: number | null; anchorId?: string; sourceNodeId?: string; pageNumber?: number}
/** URLs contain reference identities only, never field values or source text. */
export function evidenceUrl(caseId: string, source: EvidenceLocation): string {
  const query = new URLSearchParams({document: source.documentVersionId, parse: source.parseRevision});
  if (source.directoryRevision != null && Number.isSafeInteger(source.directoryRevision) && source.directoryRevision > 0) query.set('directory',String(source.directoryRevision));
  if (source.sourceNodeId) {query.set('view', 'source'); query.set('sourceNode', source.sourceNodeId);}
  if (source.anchorId) query.set('anchor', source.anchorId);
  if (source.pageNumber && Number.isSafeInteger(source.pageNumber) && source.pageNumber > 0) query.set('page', String(source.pageNumber));
  return `/cases/${encodeURIComponent(caseId)}/review?${query}`;
}
export function isReviewRunning(status?: string): boolean {return ['queued', 'pending', 'running', 'processing'].includes(status ?? '');}
export function splitEntries(value: string | undefined): string[] {return [...new Set((value ?? '').split(/[\n,，]/).map(entry => entry.trim()).filter(Boolean))];}
export function valueInput(value: unknown): string {return value === null || value === undefined ? '' : Array.isArray(value) ? value.join('\n') : String(value);}
/** Reference choices never turn an empty selection into a fabricated source. */
export function selectEvidence<T extends EvidenceLocation>(choices: readonly T[], selected: readonly string[]): T[] {
  return choices.filter((_, index) => selected.includes(String(index)));
}
export function evidenceForResult<T extends EvidenceLocation>(facts: readonly {factId: string; version: number; evidence: T[]}[], ids: readonly string[]): T[] {
  const found = new Map<string, T>();
  for (const fact of facts) for (const source of fact.evidence) {
    const id = `${source.documentVersionId}:${source.parseRevision}:${source.anchorId ?? source.sourceNodeId}`;
    if (ids.includes(id) || ids.includes(`fact:${fact.factId}:${fact.version}`)) found.set(id, source);
  }
  return [...found.values()];
}
