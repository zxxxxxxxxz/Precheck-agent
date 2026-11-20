import type {EvidenceAnchor, PageAsset} from '@hsbc/contracts/evidence';
import type {SignatureCheck, SignatureConfirmation, SignatureObservation, SignatureRequirementExpression, SignatureRequirementRecord, SignatureReviewProjection} from '@hsbc/contracts/signature-review';
export const signatureRoleLabels: Record<string, string> = {borrower: '借款人', mortgagor: '抵押人', lender: '贷款人', bank: '银行', insurer: '保险人', insured: '被保险人', applicant: '申请人', principal: '授权主体', attorney: '受托人', guarantor: '担保人', director: '董事', secretary: '秘书', authorized_signatory: '获授权签署人', authorized_representative: '获授权代表', legal_representative: '法定代表人', unassigned: '待关联', signatory: '签署人'};
export const signatureRoleLabel = (role: string) => signatureRoleLabels[role] ?? role;
export const markLabels = {signature: '签字', stamp: '盖章', signature_and_stamp: '签字并盖章', signature_or_stamp: '签字或盖章'};
export const observationLabels: Record<SignatureObservation['kind'], string> = {handwriting: '疑似签字', stamp: '疑似印章', blank_signing_slot: '空白签署栏', printed_name: '打印姓名', uncertain: '无法判断'};
export const signatureCheckLabels: Record<SignatureCheck['status'], string> = {satisfied: '已核对', suspected_missing_signature: '疑似缺签', suspected_missing_stamp: '疑似缺章', needs_confirmation: '待确认', authorization_failed: '授权待核对', not_applicable: '不适用'};
export const signatureStatusLabels: Record<SignatureReviewProjection['status'], string> = {not_started: '尚未检查', pending: '等待检查', running: '正在检查', ready: '检查完成', partial: '检查完成 · 待核对', failed: '检查未完成', canceled: '已取消', stale: '结果待更新'};
export function requirementExpressionText(expression: SignatureRequirementExpression): string {
  if (expression.kind === 'signers') return `${expression.minimum} 名${expression.roles.length ? expression.roles.map(signatureRoleLabel).join('／') : '签署人'}${markLabels[expression.mark]}`;
  return `${expression.kind === 'allOf' ? '全部满足' : '任选一组'}：${expression.children.map(child => child.kind === 'signers' ? requirementExpressionText(child) : `（${requirementExpressionText(child)}）`).join('；')}`;
}
export function changeRequirementExpressionKind(expression: SignatureRequirementExpression, kind: SignatureRequirementExpression['kind']): SignatureRequirementExpression {
  if (expression.kind === kind) return expression;
  if (kind === 'signers') return {kind, roles: [], minimum: 1, mark: 'signature'};
  return {kind, children: expression.kind === 'signers' ? [expression] : expression.children};
}
const reasonLabels: Record<string, string> = {
  requirement_unconfirmed: '签署要求待采用', signatory_identity_unconfirmed: '身份待确认', observation_unconfirmed: '观察待确认', blank_slot_requirement_unconfirmed: '空白栏的签署要求待核对', classification_unknown: '材料分类待确认', authorization_date_unknown: '授权期限待补充', authorization_amount_unknown: '授权金额待补充', authorization_transaction_unknown: '授权交易范围待补充', authorization_transaction_outside_scope: '交易超出授权范围',
  identity_unconfirmed: '身份待确认', signature_identity_unconfirmed: '身份待确认', coverage_incomplete: '页面未完整读取', visual_coverage_incomplete: '页面未完整读取',
  authorization_missing: '授权依据待补充', authorization_expired: '授权已过期', authorization_not_yet_valid: '授权尚未生效', authorization_amount_exceeded: '超出授权金额', authorization_currency_mismatch: '授权币种不一致', authorization_transaction_mismatch: '交易超出授权范围', authorization_condition_unknown: '授权条件待确认',
  requirement_conflict: '签署要求存在冲突', requirement_not_adopted: '签署要求待采用', requirement_candidate: '签署要求待采用', distinct_signers_required: '签署人数不足', missing_signature: '未见签字', missing_stamp: '未见盖章', no_confirmed_identity: '身份待确认', no_signature_requirements: '签署要求待补充', unassigned: '待关联',
};
export function signatureReason(code: string) {return reasonLabels[code] ?? '需核对原文和签署依据';}
export function signatureRequirementCoverageNotice(coverage?: SignatureReviewProjection['coverage']) {return coverage?.gaps.includes('requirements_truncated') ? '签署要求较多，部分条款待人工核对' : undefined;}
export interface SignatureRow {id: string; subjectRole: string; subjectId?: string | null; requirement?: SignatureRequirementRecord; check?: SignatureCheck; confirmation?: SignatureConfirmation; observations: SignatureObservation[]; anchorIds: string[]; pageNumbers: number[]}
export function signatureRows(review?: SignatureReviewProjection): SignatureRow[] {
  if (!review) return [];
  const usedObservations = new Set<string>();
  const usedRequirements = new Set(review.checks.flatMap(check => check.requirementId ? [check.requirementId] : []));
  const rows: SignatureRow[] = review.checks.filter(check => check.status !== 'not_applicable').map(check => {
    check.observationIds.forEach(id => usedObservations.add(id));
    return {id: check.id, subjectRole: check.subjectRole, subjectId: check.subjectId, requirement: review.requirements.find(value => value.requirement.id === check.requirementId), check,
      observations: review.observations.filter(value => check.observationIds.includes(value.id)), anchorIds: check.anchorIds, pageNumbers: check.pageNumbers};
  });
  for (const requirement of review.requirements) if (!usedRequirements.has(requirement.requirement.id) && requirement.status !== 'excluded') rows.push({id: `requirement:${requirement.requirement.id}`, subjectRole: requirement.requirement.subjectRole, requirement, observations: [], anchorIds: requirement.anchorIds, pageNumbers: requirement.pageNumbers});
  for (const observation of review.observations) {
    const confirmation = review.confirmations.filter(value => value.observationId === observation.id).at(-1);
    if (!usedObservations.has(observation.id) && (confirmation?.observedKind ?? observation.kind) !== 'printed_name' && confirmation?.action !== 'exclude') rows.push({id: `observation:${observation.id}`, subjectRole: confirmation?.identity?.subjectRole ?? '', subjectId: confirmation?.identity?.subjectId, confirmation, observations: [observation], anchorIds: observation.anchorIds, pageNumbers: [observation.pageNumber]});
  }
  return rows.sort((left, right) => Number(left.check?.status === 'satisfied') - Number(right.check?.status === 'satisfied') || (left.pageNumbers[0] ?? Infinity) - (right.pageNumbers[0] ?? Infinity));
}
export function signatureObservationSummary(observations: readonly SignatureObservation[], confirmations: readonly SignatureConfirmation[] = []) {
  const counts = new Map<string, number>();
  for (const observation of observations) {
    const confirmation = confirmations.filter(value => value.observationId === observation.id).at(-1);
    const kind = confirmation?.observedKind ?? observation.kind;
    if (kind === 'printed_name' || confirmation?.action === 'exclude') continue;
    const label = observationLabels[kind]; counts.set(label, (counts.get(label) ?? 0) + 1);
  }
  return [...counts].map(([label, count]) => `${label}${count > 1 ? ` × ${count}` : ''}`).join('、') || '尚无可用观察';
}

/** Local display geometry is scoped to the loaded private page; it is never a text evidence anchor. */
export function signatureVisualAnchors(observations: readonly SignatureObservation[], page: PageAsset): EvidenceAnchor[] {
  return observations.filter(value => value.pageNumber === page.page_number && value.parseRevision === page.parse_revision && value.sourceSha256 === page.source_sha256 && value.imageWidth === page.width && value.imageHeight === page.height
    && [value.box.x, value.box.y, value.box.width, value.box.height].every(Number.isFinite) && value.box.x >= 0 && value.box.y >= 0 && value.box.width > 0 && value.box.height > 0 && value.box.x + value.box.width <= page.width && value.box.y + value.box.height <= page.height).map(value => ({
    schema_version: 'p0.v1', anchor_id: `visual:${value.id}`, evidence_kind: 'image_region', document_version_id: page.document_version_id, parse_revision: page.parse_revision, page_asset_id: page.page_asset_id, page_number: page.page_number,
    block_ids: [], text_span_refs: [], polygons: [[[value.box.x, value.box.y], [value.box.x + value.box.width, value.box.y], [value.box.x + value.box.width, value.box.y + value.box.height], [value.box.x, value.box.y + value.box.height]]],
    granularity: 'block', localization_status: 'block_only', localization_source: 'private_signature_visual', configuration_version: value.promptVersion, reason: null, candidate_anchor_ids: [],
  }));
}

export function signatureRowNeedsAttention(row: SignatureRow) {return row.check ? row.check.status !== 'satisfied' : row.confirmation?.action !== 'accept';}
export function signatureRowResult(row: SignatureRow) {return row.check ? signatureCheckLabels[row.check.status] : row.confirmation?.action === 'accept' ? '观察已确认' : '待确认';}
