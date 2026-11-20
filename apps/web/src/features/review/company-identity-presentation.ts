import type {CompanyIdentityState, CompanyLookupReceipt} from '@hsbc/contracts/company-identity';

export const companyLookupStatus: Record<CompanyLookupReceipt['status'], string> = {
  pending: '正在查询', candidates: '找到候选', not_found: '未找到匹配记录', conflicting: '登记信息有冲突',
  unavailable: '查询暂不可用', blocked: '查询未开放', stale: '查询依据已更新',
};
export function companyLookupReason(code: string | null | undefined): string {
  const reasons: Record<string, string> = {
    company_lookup_disabled: '企业查询暂未开放。',
    company_lookup_policy_disabled: '当前出站策略未开放企业查询。',
    company_lookup_policy_required: '企业查询尚未配置出站策略。',
    company_lookup_policy_expired: '企业查询的出站授权已到期，请联系配置维护人员。',
    company_lookup_scope_denied: '本案尚未开放企业信息查询。',
    company_lookup_permission_denied: '当前账号没有企业查询权限。',
    company_lookup_stale: '案件或查询依据已更新，请重新查询。',
    company_lookup_timeout: '企业信息服务响应超时，可稍后重新查询。',
    company_lookup_rate_limited: '企业信息服务繁忙，请稍后查询。',
    company_lookup_budget_exhausted: '企业查询额度已用完，请稍后或联系配置维护人员。',
    company_lookup_execution_unknown: '上次查询结果尚未确认，请恢复查询记录，勿重复提交。',
    company_lookup_transport_unavailable: '无法连接企业信息服务，请稍后查询。',
    company_lookup_provider_unavailable: '企业信息服务暂不可用，请稍后查询。',
    company_lookup_invalid_response: '企业信息服务返回内容无法读取，请稍后查询。',
    company_lookup_response_too_large: '企业信息服务返回过多内容，请补充登记标识缩小范围。',
  };
  return reasons[code ?? ''] ?? '企业查询当前不可用，可继续核对材料原文。';
}
export function canSelectCompanyRecord(state: CompanyIdentityState, receipt: CompanyLookupReceipt, lei: string, revision: number, now = Date.now()): boolean {
  return state.caseId === receipt.caseId && state.revision === revision && receipt.caseRevision === revision
    && state.allowedActions.includes('adopt') && receipt.status === 'candidates'
    && !!receipt.expiresAt && Number.isFinite(Date.parse(receipt.expiresAt)) && Date.parse(receipt.expiresAt) > now
    && receipt.records.some(record => record.lei === lei && record.conflicts.length === 0);
}
/** Only known official HTTPS references are clickable; records remain readable if a URL is rejected. */
export function gleifSourceUrl(value: string): string | undefined {
  try {
    const url = new URL(value);
    if (url.protocol === 'https:' && ['api.gleif.org', 'search.gleif.org', 'www.gleif.org'].includes(url.hostname) && !url.username && !url.password) return url.href;
  } catch { /* Display the record without an external link. */ }
  return undefined;
}
export function companyRegistryStatus(value: string | null): string {
  if (!value) return '未提供';
  return ({ACTIVE: '存续', INACTIVE: '非存续', NULL: '未提供'} as Record<string, string>)[value] ?? value;
}
export function leiRecordStatus(value: string | null): string {
  if (!value) return '未提供';
  return ({ISSUED: '已签发', LAPSED: '未续期', RETIRED: '已注销', ANNULLED: '已作废', DUPLICATE: '重复记录', PENDING_TRANSFER: '转移中', PENDING_ARCHIVAL: '归档中', MERGED: '已合并'} as Record<string, string>)[value] ?? value;
}
/** Provider codes are mapped locally; raw provider text never becomes UI copy. */
export function companyRecordConflicts(codes: readonly string[]): string[] {
  const labels: Record<string, string> = {
    name_differs: '名称不一致',
    jurisdiction_conflict: '司法辖区不一致',
    jurisdiction_missing: '来源未提供司法辖区',
    registration_authority_conflict: '登记机构不一致',
    registration_authority_missing: '来源未提供登记机构',
    registration_number_conflict: '登记编号不一致',
    registration_number_missing: '来源未提供登记编号',
  };
  return [...new Set(codes.map(code => labels[code] ?? '来源信息需核对'))];
}
