import type {ReviewEvidence} from '@hsbc/contracts/review';
import type {SignatureInformationProjection, SignatureInformationState, SignatureInformationCheck, SignatureInformationCandidate} from '@hsbc/contracts/signature-information';
import {signaturePersonRows, signatureCheckEditor, type SignaturePersonRow, type SignatureEditor} from './signature-checklist-presentation.ts';
import {signatureDateLabels, signatureReason} from './signature-information-presentation.ts';
import {requirementExpressionText, signatureRoleLabel} from './signature-presentation.ts';

export type SignatureComparisonGroup = 'people' | 'requirements' | 'dates' | 'other';
export const signatureComparisonGroups: Record<SignatureComparisonGroup, string> = {
  people: '人员与授权', requirements: '签署组合', dates: '日期', other: '其他信息',
};
export interface SignatureComparisonSide {
  lines: string[];
  evidence: ReviewEvidence[];
  entryIds: string[];
  pages: number[];
  quote?: string;
}
export interface SignatureComparisonItem {
  id: string; label: string; group: SignatureComparisonGroup;
  actual: SignatureComparisonSide; reference: SignatureComparisonSide;
  checks: SignatureInformationCheck[]; explanation: string;
  editor: SignatureEditor; editorId?: string; person?: SignaturePersonRow;
  candidate?: SignatureInformationCandidate; requirementCandidateId?: string;
}
const markLabels = {handwriting:'签字', stamp:'印章', printed_name:'打印姓名', blank_signing_slot:'空白签署栏', uncertain:'证据类型待核对'};
const stateLabels = {pending:'待核对', confirmed:'已核对信息', excluded:'已排除'};
const side = (lines: string[] = [], evidence: ReviewEvidence[] = [], entryIds: string[] = [], pages: number[] = [], quote?: string): SignatureComparisonSide => ({lines, evidence, entryIds, pages, quote});

/** Display existing associations only. Never match identity/authority by name or infer a business verdict. */
export function signatureComparisonItems(data: SignatureInformationProjection, state: SignatureInformationState): SignatureComparisonItem[] {
  const name = (id: string | null) => data.objects.find(o => o.objectId === id && o.validity === 'current')?.label ?? '对应对象待核对';
  const entriesSide = (ids: string[]) => {
    const entries = state.entries.filter(e => ids.includes(e.id));
    return side(entries.map(e => `${e.kind === 'stamp' ? name(e.subjectId) : name(e.personId)} · ${markLabels[e.kind]} · ${stateLabels[e.status]}${e.duplicateOf ? '（重复记录）' : ''}`), entries.flatMap(e => e.evidence), entries.map(e => e.id), entries.flatMap(e => state.locations.find(l => l.id === e.locationId)?.pageNumber ?? []));
  };
  const items: SignatureComparisonItem[] = signaturePersonRows(data, state).map(person => {
    const entryIds = person.entries.map(e => e.id);
    const authorizations = state.authorizations.filter(a => person.entries.some(e => e.authorizationIds.includes(a.id)));
    const actual = entriesSide(entryIds);
    actual.lines.push(...person.candidates.map(c => `${c.value ?? '原文未提供值'} · ${c.origin === 'adopted_fact' ? '已采用字段' : '提取信息，待核对'}`));
    actual.lines.push(...person.entries.filter(e => e.role).map(e => `职务或角色：${signatureRoleLabel(e.role!)}；${e.capacity === 'self' ? '本人签署' : `代表主体：${name(e.subjectId)}`}`));
    actual.evidence.push(...person.candidates.flatMap(c => c.evidence));
    actual.pages.push(...person.candidates.flatMap(c => c.pageNumbers));
    const reference = side(authorizations.flatMap(a => [
      `${a.label} · ${stateLabels[a.status]}`,
      `授权主体：${name(a.subjectId)}`,
      `获授权人员：${a.personIds.length ? a.personIds.map(name).join('、') : '未明确'}${a.roles.length ? `；角色：${a.roles.map(signatureRoleLabel).join('、')}` : ''}`,
      ...(a.maxAmount ? [`授权上限：${a.currency ?? '币种待核对'} ${a.maxAmount}`] : []),
      ...(a.transactionTypes.length ? [`交易范围：${a.transactionTypes.join('、')}`] : []),
    ]), authorizations.flatMap(a => a.evidence));
    return {id:person.id, label:person.name, group:'people', actual, reference,
      checks:data.evaluation.checks.filter(c => c.entryIds.some(id => entryIds.includes(id))),
      explanation:!authorizations.length ? '尚无与此签署记录明确关联的授权依据；不能仅凭姓名相同判断授权对应。个人本人签署按适用要求核对。' : '人员对应、授权范围及签署组合分别核对；有姓名或签署记录不代表已满足签署要求。',
      editor:'locations', person};
  });
  for (const r of state.requirements) {
    const actual = entriesSide(r.entryIds.filter(id => state.entries.some(e => e.id === id && r.locationIds.includes(e.locationId))));
    items.push({id:`requirement:${r.id}`, label:r.requirement.label, group:'requirements', actual,
      reference:side([requirementExpressionText(r.requirement.expression), `适用主体：${name(r.subjectId)}`, r.scope === 'each_location' ? '每个所选签署位置分别满足' : '在所选签署位置内合计核对', `适用状态：${stateLabels[r.status]}`], r.evidence),
      checks:data.evaluation.checks.filter(c => c.requirementId === r.id),
      explanation:'只对照本项明确关联的签署证据；其他位置的签字不会自动计入。', editor:'requirements', editorId:r.id});
  }
  for (const c of data.requirementCandidates.filter(c => c.status !== 'excluded' && !state.requirements.some(r => r.sourceRequirementId === c.requirement.id))) {
    items.push({id:`requirement-candidate:${c.requirement.id}`, label:c.requirement.label, group:'requirements', actual:side(),
      reference:side([requirementExpressionText(c.requirement.expression), c.source === 'published_configuration' ? '已发布要求，适用范围待确认' : '原文条款，适用范围待确认'], c.anchorIds.map(anchorId => ({documentVersionId:data.documentId, parseRevision:data.parseRevision, directoryRevision:data.directoryRevision, anchorId})), [], c.pageNumbers, c.clauseText ?? undefined),
      checks:data.evaluation.checks.filter(check => check.requirementId === c.requirement.id),
      explanation:'要求尚未关联适用位置与签署证据，暂不能判断是否满足。', editor:'requirements', requirementCandidateId:c.requirement.id});
  }
  for (const d of state.dates) {
    const matches = (s: {kind: string; targetType: string; targetId: string} | null) => !!s && s.kind === d.kind && s.targetType === d.targetType && s.targetId === d.targetId;
    const rules = state.dateRules.filter(r => matches(r.left) || matches(r.right));
    const operationLabels = {required:'必须填写', blank:'必须留空', before:'早于（不含同日）', not_after:'不晚于（允许同日）', equal:'同日', after:'晚于（不含同日）', not_before:'不早于（允许同日）'};
    const describe = (selector: NonNullable<typeof rules[number]['right']>) => `${signatureDateLabels[selector.kind]}：${state.dates.filter(value => value.kind === selector.kind && value.targetType === selector.targetType && value.targetId === selector.targetId).map(value => value.rawValue || '原文留空').join(' / ') || '日期待补充'}`;
    items.push({id:`date-record:${d.id}`, label:signatureDateLabels[d.kind], group:'dates',
      actual:side([d.rawValue || '原文留空 / 待核对', `日期用途：${signatureDateLabels[d.kind]} · ${stateLabels[d.status]}`, d.targetId ? '已指定日期对应对象' : '日期对应对象待核对'], d.evidence),
      reference:side(rules.flatMap(r => [r.label, `${describe(r.left)} ${operationLabels[r.operation]}${r.right ? ` ${describe(r.right)}` : ''}`, `规则状态：${stateLabels[r.status]}`]), rules.flatMap(r => r.evidence)),
      checks:data.evaluation.checks.filter(c => c.id === `date-record:${d.id}` || rules.some(r => c.id === `date:${r.id}`)),
      explanation:rules.length ? '按已关联的日期用途和规则展示；不同用途的日期不会自动相互替代。' : '尚无明确适用于此日期的比较规则，不自动推定日期先后。', editor:'dates', editorId:d.id});
  }
  for (const c of data.candidates.filter(c => c.kind !== 'person')) {
    items.push({id:`candidate:${c.id}`, label:c.label, group:c.kind === 'date' ? 'dates' : 'other',
      actual:side([c.value ?? '原文未提供值', c.origin === 'adopted_fact' ? '已采用字段，仍需核对签署用途' : '提取信息，待核对签署用途'], c.evidence, [], c.pageNumbers), reference:side(), checks:[],
      explanation:c.kind === 'date' ? '已有日期可直接查看原文。确认用途与对应对象后，再按适用规则核对。' : '这是已有字段信息，不能单独作为签署存在或授权成立的结论。',
      editor:c.kind === 'date' ? 'dates' : c.kind === 'authorization' ? 'authorizations' : 'locations', candidate:c});
  }
  // Retain checks which have no person, date or requirement row, including stale/partial historical data.
  for (const check of data.evaluation.checks.filter(c => !items.some(item => item.checks.some(value => value.id === c.id)))) {
    items.push({id:`check:${check.id}`, label:check.label, group:'other', actual:entriesSide(check.entryIds), reference:side([], check.evidence), checks:[check], explanation:check.reasons.map(signatureReason).join('；'), editor:signatureCheckEditor(check), editorId:check.id.startsWith('date-record:') ? check.id.slice(12) : check.id.startsWith('date:') ? check.id.slice(5) : check.entryIds[0] ?? check.requirementId ?? undefined});
  }
  return items;
}

export function signatureComparisonVerdict(item: SignatureComparisonItem, validity: SignatureInformationProjection['validity'], dirty: boolean) {
  if (validity === 'stale') return {label:'需重新核对', tone:'pending', reasons:['依据或版本已变化，旧结论已失效。']};
  if (dirty) return {label:'修改待保存', tone:'pending', reasons:['当前信息含未保存修改，保存后更新检查结论。']};
  const checks = item.checks;
  const reasons = [...new Set(checks.flatMap(c => c.reasons.map(signatureReason)))];
  if (checks.some(c => c.status === 'not_satisfied')) return {label:'不满足已确认要求', tone:'issue', reasons};
  if (!checks.length || checks.some(c => c.status === 'needs_confirmation')) return {label:'待核对', tone:'pending', reasons:reasons.length ? reasons : [item.explanation]};
  if (checks.every(c => c.status === 'not_applicable')) return {label:'不适用', tone:'neutral', reasons};
  return {label:'满足本项已确认要求', tone:'satisfied', reasons};
}
