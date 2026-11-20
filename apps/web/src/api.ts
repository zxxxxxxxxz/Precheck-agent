import { QueryClient } from '@tanstack/react-query';
import type {Session} from './features/identity/types.ts';

export class ApiError extends Error {
  constructor(public status: number, public code: string, message: string, public requestId?: string) {super(message);}
}
export const queryClient = new QueryClient({defaultOptions: {
  queries: {retry: false, staleTime: 15_000, gcTime: 60_000, refetchOnWindowFocus: true},
  mutations: {retry: false, gcTime: 0},
}});
let csrf = '';
let securityHandler: ((status: number) => void) | undefined;
const pending = new Set<AbortController>();
export function setCsrf(value: string) {csrf = value;}
/** Same-origin streaming transport. The controller remains registered until the body closes. */
export async function sessionStream(path: string, signal?: AbortSignal): Promise<Response> {
  if (!path.startsWith('/api/') || path.startsWith('//')) throw new ApiError(400, 'invalid_stream_path', '无法打开此处理记录。');
  const controller = new AbortController();
  pending.add(controller);
  const abort = () => controller.abort();
  signal?.addEventListener('abort', abort, {once: true});
  if (signal?.aborted) controller.abort();
  const release = () => {pending.delete(controller); signal?.removeEventListener('abort', abort);};
  try {
    const response = await fetch(path, {credentials: 'same-origin', cache: 'no-store', redirect: 'error', signal: controller.signal, headers: {'Accept': 'text/event-stream', 'x-csrf-token': csrf}});
    if (!response.ok || !response.body) {
      if (response.status === 401 || response.status === 403) securityHandler?.(response.status);
      throw new ApiError(response.status, 'stream_unavailable', safeMessage(response.status, undefined));
    }
    const reader = response.body.getReader();
    return new Response(new ReadableStream<Uint8Array>({
      async pull(target) {try {const next = await reader.read(); if (next.done) {release(); target.close();} else target.enqueue(next.value);} catch (error) {release(); target.error(error);}},
      async cancel() {abort(); release(); await reader.cancel().catch(() => undefined);},
    }), {status: response.status, headers: response.headers});
  } catch (error) {release(); throw error;}
}
export function onSecurityChange(handler?: (status: number) => void) {securityHandler = handler;}
export function clearSensitiveState(preserveSession = false) {
  csrf = '';
  for (const controller of pending) controller.abort();
  pending.clear();
  if (preserveSession) {
    const sensitive = {predicate: (query: {queryKey: readonly unknown[]}) => query.queryKey[0] !== 'session'};
    void queryClient.cancelQueries(sensitive);
    queryClient.removeQueries(sensitive);
    queryClient.getMutationCache().clear();
  } else {
    void queryClient.cancelQueries();
    queryClient.clear();
  }
}
export async function api<T>(path: string, options: {method?: 'GET' | 'POST' | 'PUT'; body?: unknown; signal?: AbortSignal; security?: boolean; timeoutMs?: number} = {}): Promise<T> {
  const controller = new AbortController();
  pending.add(controller);
  const abort = () => controller.abort();
  options.signal?.addEventListener('abort', abort, {once: true});
  if (options.signal?.aborted) controller.abort();
  const timeout = setTimeout(abort, Math.min(180_000, Math.max(1_000, options.timeoutMs ?? 30_000)));
  try {
    const response = await fetch(path, {
      method: options.method ?? 'GET', credentials: 'same-origin', cache: 'no-store', signal: controller.signal,
      headers: options.method && options.method !== 'GET' ? {'Content-Type': 'application/json', 'x-csrf-token': csrf} : {'Accept': 'application/json'},
      body: options.method && options.method !== 'GET' ? JSON.stringify(options.body ?? {}) : undefined,
    });
    const payload = response.status === 204 ? undefined : await response.json().catch(() => undefined);
    if (!response.ok) {
      if (options.security !== false && (response.status === 401 || response.status === 403)) securityHandler?.(response.status);
      throw new ApiError(response.status, payload?.error?.code ?? 'request_failed', safeMessage(response.status, payload?.error?.message, payload?.error?.code), payload?.error?.requestId);
    }
    if (response.status !== 204 && payload === undefined) throw new ApiError(502, 'invalid_response', '服务返回格式不正确，请稍后重试。');
    return payload as T;
  } catch (error) {
    if (error instanceof ApiError || options.signal?.aborted) throw error;
    throw new ApiError(0, 'network_error', '连接中断或请求超时。请检查网络后重新查询状态，勿重复提交。');
  } finally {
    clearTimeout(timeout);
    options.signal?.removeEventListener('abort', abort);
    pending.delete(controller);
  }
}
function safeMessage(status: number, message: unknown, code?: string) {
  const messages: Record<string, string> = {
    subject_name_duplicate: '同一个名称写法不能同时属于两个主体，请调整后再确认。', subject_role_not_in_configuration: '当前审核配置不包含这类主体。',
    field_value_present: '这个字段在这份文件里已经有取值；请让助手按“更正”重新提出。', field_value_source_changed: '这份文件已重新解析，请重新提问后再填入。', field_value_document_unavailable: '这份文件当前不能用于填入，请确认它在本轮材料中且已解析完成。',
    field_value_quote_invalid: '引文与这份文件的原文不一致，未填入。', field_value_not_in_quote: '取值没有逐字出现在引文里，未填入。', field_value_evidence_unsupported: '这份文件的原文位置暂不支持直接填入。', field_value_not_supplied: '这个字段没有可撤回的填入记录。',
    guidance_duplicate: '已有内容相同的本案规则。', guidance_not_active: '这条规则已停用或已被替换，请刷新后查看。', guidance_limit_reached: '本案生效规则已达 50 条，请先停用不再需要的规则。',
    guidance_exact_field: '金额、币种、日期和编号需逐字核对，不能用口径放宽。', guidance_expressions_required: '名称等同至少需要两个写法。', guidance_scope_required: '请说明口径适用的字段或表述。', guidance_field_unknown: '口径引用的字段不在当前审核配置中。',
    guidance_digest_nothing_to_propose: '本案没有可提交到规则中心的新口径。', guidance_digest_not_ready: '这份整理已处理或尚未完成。', guidance_digest_adoption_in_progress: '这份整理正在采纳，请刷新后查看进度。', guidance_digest_config_invalid: '采纳后的配置未通过校验，请在规则中心检查口径内容。', review_config_trial_failed: '新版本试例未全部通过，未发布；请在规则中心查看试跑结果。',
    case_assistant_disabled: '案件助手未开启。', case_assistant_policy_expired: '案件助手的出站授权已到期，请联系管理员。', case_assistant_case_not_authorized: '本案未在案件助手的授权范围内（仅限合成验证配置或已列明的案件）。',
    assistant_turn_active: '上一条消息仍在处理中，请稍候。', assistant_turn_conflict: '这条消息已用相同编号发送过，请刷新后重试。', assistant_rate_limited: '发送过于频繁，请稍后再试。', assistant_legal_material_required: '本轮尚未采用法律意见书材料。', assistant_legal_unavailable: '当前环境不能读取法律意见书原文。',
    assistant_proposal_not_pending: '这条口径建议已处理或已被新的建议替代。', assistant_proposal_expired: '这条口径建议已过期，请重新描述。', assistant_proposal_changed: '口径建议内容已变化，请刷新后确认。', assistant_proposal_stale: '审核配置已变化，请重新描述口径。', assistant_proposal_not_found: '口径建议不存在或不属于当前对话。',
    delivery_result_not_ready: '所选检查尚未有效完成，请先完成预审。',
    delivery_reply_scope_invalid: '所选回复不属于此次输出范围，请调整勾选。',
    delivery_round_run_mismatch: '轮次对应的检查记录已有变化，请刷新后重试。',
    delivery_draft_not_found: '邮件草稿不存在或无权读取。',
    delivery_integrity_failed: '邮件记录未通过完整性校验，请联系管理员。',
    analysis_not_found: '未找到该分析记录，请重新读取历史记录。',
    analysis_retry_not_allowed: '这份分析目前不能重试，请核对来源、权限和调用状态。',
    analysis_continue_not_allowed: '当前没有可继续的项目，或本批分析尚未结束。请刷新结果并核对状态。',
    analysis_queue_full: '本案正在运行的分析较多，请等待已有任务完成。',
    analysis_source_stale: '材料或审核结果已有变化，请基于最新结果重新分析。',
    comparison_rounds_unavailable: '所选两轮尚不具备比较条件，请检查轮次是否已提交。',
    comparison_object_mapping_invalid: '对象对应关系不明确或有重复，请逐一确认同类对象。',
    comparison_material_mapping_invalid: '材料对应关系有重复或不属于所选轮次，请调整后重试。',
    review_assist_call_unknown: '模型请求已发出，但未取得可核验回执。已暂停自动重试，请联系管理员核对。',
    draft_not_found: '草稿不存在或你没有访问权限，请返回草稿列表。',
    draft_closed: '这份草稿已创建案件或已废弃，不能继续编辑。',
    draft_revision_conflict: '草稿已在其他页面更新。本人未保存内容仍保留，请重新载入后核对。',
    checker_submission_pending:'本轮已提交复核，请由 Checker 进入本轮更正后修改。',
    checker_confirmation_required:'尚无当前版本的有效 Checker 确认，不能进入下一轮或正常完结。请到协作与复核查看；无法继续时可明确终止。',
    checker_assignment_required:'请先指派当前具备资格的独立复核人。',
    checker_not_independent_or_authorized:'复核人的权限、资格或独立性不满足要求，请核对授权或改派。',
    checker_submission_stale:'这次提交已失效或已有决定，请刷新后查看最新复核状态。',
    checker_preview_stale:'提交内容已变化，请重新核对后提交。',
    checker_manual_conclusion_not_allowed:'此检查项不能用人工已满足覆盖，请核对缺失依据及业务规则。',
    checker_evidence_version_mismatch:'所选依据不属于当前轮的有效来源版本。',
    checker_correction_required:'请由当前复核人进入本轮更正后操作。',
    checker_correction_in_progress:'本轮正在由 Checker 更正，经办人只能查看。',
    checker_correction_not_authorized:'没有本案 Checker 更正权限，请核对指派和更正授权。',
    checker_return_items_unreviewed:'仍有经办回复尚未被复核人接受。',
    formal_review_unavailable:'正式云审核尚未接入，不能提交正式复核或确认。',
    formal_review_incomplete:'当前版本的正式审核和证据校验尚未完成。',
    exception_policy_unconfirmed:'例外适用口径尚未配置，记录不能代替有效批准。',
    case_closed:'本案预审已完结，当前只读。可查看历史材料和结果。',
    historical_material_unavailable:'所选历史材料已不可用，请刷新列表后重新选择。',
    historical_material_already_added:'所选文件已在本轮，请刷新材料列表。',
    invalid_historical_materials:'请选择要加入本轮的历史材料。',
    review_round_required:'请明确选择当前预审轮次后再操作。旧页面不能自动写入新一轮。',
    review_round_not_current:'此轮次已不是当前轮次，请切换后重新核对。未提交内容仍保留。',
    review_round_locked:'本轮材料已固定。待复核时可返回更正；复核中由 Checker 直接更正，已结束的轮次保持只读。',
    review_round_confirmation_stale:'本轮结果尚未完成或依据已有变化，请重新预审并核对最新结果后确认。',
    review_document_round_mismatch:'这份材料不属于当前轮次，不能在本轮修改或采用。',
    review_round_inputs_processing:'本轮还有上传或解析任务未结束，请完成或取消后再操作。',
    review_round_draft_exists:'当前已有准备中的轮次，请先完成或放弃。',
    review_round_execution_active:'预审仍在执行，请等待完成或取消本轮执行。',
    review_round_not_found:'未找到该预审轮次，请重新读取案件。',
    review_round_retry_unavailable:'当前执行状态不支持重试，请刷新轮次状态。',
    closure_draft_pending:'还有未提交的下一轮，请先明确放弃或完成该轮预审。',
    closure_result_required:'最新已提交轮次还没有有效结果，请先完成该轮预审。',
    closure_confirmation_stale:'待确认结果或问题已有变化，请重新读取结果并逐项确认。',
    closure_items_not_acknowledged:'请逐项确认所有剩余问题后再完结。',
    review_material_reconfirmation_required: '本材料有新的提取结果。请到材料页核对，并在原采用范围上确认使用新结果。',
  review_material_scope_required: '同一文件有多个采用范围，请明确选择范围后重新添加原文依据。',
  review_material_add_scope_required: '本文件已存在采用范围。请更改原范围，或明确选择新增采用范围。',
  review_material_scope_exists: '此范围已被采用，请更改已有记录。',
  review_material_target_stale: '所选采用记录已变化，请重新打开该范围核对。',
  review_material_source_changed: '核对期间提取结果已更新，请重新打开并核对最新结果。',
  review_material_scope_changed: '原文书范围已变化，请在材料页核对并更正范围。',
  evidence_outside_material_scope: '所选原文不在此采用范围内，请核对范围和页码。',
  stale_revision: '记录已有更新。未提交内容仍保留，请重新查询并核对最新修订后操作。',
    stale_draft_revision: '草稿已在其他页面更新。本人未保存内容仍保留，请重新载入后核对。',
    suggestion_not_current: '此建议对应旧版草稿，请重新整理信息。',
    suggestion_stale: '此建议对应旧版草稿，请重新整理信息。',
    maker_qualification_required: '建案需要有效经办资格及建案权限，请联系授权管理员。',
    rm_system_access_disabled: 'RM 不使用系统账号，请联系授权管理员。',
    scenario_confirmation_required: '请先确认案件为境外贷款，再解析材料。',
    supplement_unavailable: '补充提取暂不可用，请联系管理员检查私有辅助模型配置。',
    supplement_material_required: '请选择至少一份其他／补充材料。',
    supplement_material_scope: '所选文件不在当前案件轮次中，请刷新后重新选择。',
    supplement_source_unavailable: '所选文件尚无可读取的原文，请先完成解析。',
    supplement_input_budget: '所选原文超过单次处理容量，请减少文件数量后分次请求。',
    supplement_queue_full: '本案已有补充请求正在处理，请完成后再提交。',
    review_configuration_required: '请先在案件概览绑定已发布的审核配置。',
    review_configuration_not_found: '该配置尚未发布或不可用，请重新选择。',
    processing_policy_automatic: '演示环境已自动应用测试材料处理策略，无需逐案申请。',
    review_config_not_published: '该配置尚未发布，请选择已发布的审核配置。',
    review_configuration_unavailable: '审核配置暂不可用，请保存草稿后重试。',
    review_configuration_scenario_mismatch: '所选配置的业务场景或适用范围不匹配，请重新选择。',
    review_guarantee_types_mismatch: '所选配置与本案担保类型不匹配，请重新选择。',
    review_guarantee_types_locked: '担保类型已固定，第二轮起不可修改。',
    review_config_integrity_failed: '已发布配置校验未通过，请联系配置负责人。',
    review_configuration_already_initialized: '案件已绑定审核配置，请刷新后查看。',
    field_not_in_configuration: '该字段不属于本案配置，请重新查询字段定义。',
    field_object_mismatch: '字段与对象类别不匹配，请核对所选对象。',
    fact_evidence_object_mismatch: '这处原文尚未关联到所选担保对象，无法采用。请先核对材料、主体及具体原文位置。',
    identity_party_objects_required: '身份确认仅适用于两个主体对象。',
    identity_evidence_required: '请为两个主体核对有效原文依据后确认身份。',
    identity_target_version_stale: '关联主体已更新。未提交内容仍保留，请重新查询并核对当前对象版本后确认身份。',
    identity_relation_conflict: '存在相反的主体身份确认，请核对并更正关系。',
    company_lookup_stale: '企业查询记录已过期或案件依据已更新，请重新查询后采用。',
    company_lookup_selection_invalid: '所选企业名称与查询记录不一致，请重新选择并核对。',
    company_name_evidence_required: '采用企业名称仍需选择材料原文依据。',
    identity_registration_conflict: '两个主体的登记标识不同，不能确认其为同一主体。',
    company_lookup_canceled: '查询依据或权限已变化，请刷新记录后核对。',
    fact_identity_immutable: '更正不能改变原事实的对象和字段，请另行确认新事实。',
    review_derived_field_readonly: '此值由已确认依据计算，请更正相应原始字段后重新检查。',
    personal_fact_option_invalid: '请选择已定义的个人担保选项；尚不能判断时，请将事实状态设为待确认。',
    review_business_date_readonly: '审核基准日由本次检查记录提供，不能作为材料字段填写。',
    fact_evidence_required: '请选择原文依据后确认事实。',
    present_value_required: '有值状态必须填写原文值。',
    non_present_value_forbidden: '该状态不能同时填写原文值，请清空原文值或调整状态。',
    evidence_not_in_material_snapshot: '原文依据不在本轮材料快照中，请核对当前文件及来源版本。',
    evidence_anchor_invalid: '原文位置未通过校验，请重新选择可回查的依据。',
    material_evidence_not_ready: '材料尚无解析依据，请先完成解析或核对原文。',
    material_predecessor_required: '请选择当前采用的前驱材料。',
    amendment_sequence_conflict: '修改次序与已有版本冲突，请核对生效关系。',
    logical_document_invalid: '请选择实际逻辑文书范围，导航分组不能作为采用依据。',
    candidate_projection_stale: '字段候选已更新，请重新核对当前来源。',
    review_business_date_invalid: '审核基准日无效，请填写有效的年月日。',
    stale_issue: '问题已产生新结果，请查看当前修订后记录回复或处置。',
    stale_issue_version: '问题已有新的回复或处置，请重新查询后核对。',
    issue_not_resolved_by_current_facts: '当前检查仍有差异或证据不足，暂不能关闭问题。',
    business_role_required: '当前人员尚未设置业务岗位，请联系管理员。',
    person_role_change_requires_explicit_action: '已有人员的岗位请在人员岗位页面修改。',
    signature_vision_unavailable: '签署图像检查暂未开放。',
    signature_configuration_required: '请先绑定已发布的签署核验配置。',
    signature_call_unknown: '上次调用结果未确认，已阻止重复检查，请联系管理员核对。',
    signature_review_not_ready: '签署检查尚未完成，请稍后再核对。',
    stale_signature_review: '签署检查依据已有更新，请重新检查。',
    signature_identity_incomplete: '请补齐签署人员、代表主体及授权依据。',
    signature_identity_not_current: '人员或主体记录已有更新，请重新选择。',
    signature_receipt_integrity_failed: '签署记录校验未通过，请联系管理员。',
    signature_snapshot_integrity_failed: '签署检查依据校验未通过，请联系管理员。',
    stale_directory_revision: '材料目录已有更新，请重新查询后再保存。',
    translation_round_mismatch: '所选材料不属于这一预审轮次，请重新选择本轮材料。',
    translation_round_not_frozen: '本轮尚无可用于参考补译的固定审核快照，请先在材料准备阶段生成译文。',
    translation_frozen_source_mismatch: '原文版本与本轮冻结依据不一致，暂不能补译，请核对材料记录。',
    stale_parse_revision: '解析版本已有更新，请查看当前解析记录。',
    daily_budget_exhausted: '今日处理额度不足，额度恢复后可继续解析。',
    request_budget_exhausted: '本次处理超过单次额度，需要检查处理配置。',
    rate_limited: '处理请求较多，系统正在等待重试。',
    fresh_parse_required: '现有结果无法安全复用，请重新解析。',
    recovery_owner_changed: '当前账号与原解析任务的经办身份不一致，无法恢复原任务。',
    recovery_not_failed: '任务状态已变化，请刷新后查看。',
    recovery_already_queued: '恢复任务已经排队，无需重复提交。',
    recovery_attempts_exhausted: '恢复次数已达到上限，请先排查失败原因。',
    index_not_ready: '尚无可用的材料结构，请查看本次解析状态。',
    page_not_ready: '本页尚未处理完成，请稍后重新查询。',
    parse_not_available: '尚无可用解析记录，请先解析材料。',
    document_page_limit: '材料超过当前解析容量，请拆分或联系管理员。',
    p2_page_pixel_budget_exceeded: '页面尺寸超过安全处理范围，请核对原件或联系管理员。',
    capability_disabled: '此功能暂未启用，请联系管理员。',
    document_cloud_unavailable: '云端材料识别尚未启用，请联系管理员。',
    document_cloud_scope_denied: '此材料尚未获准识别，请在材料与版本查看处理授权。',
    processing_access_unavailable: '材料处理授权暂未开放或处理政策已到期，请联系系统负责人。',
    processing_access_configuration_required: '请先绑定适用于合成材料识别的审核配置。',
    processing_access_pending: '本案已有待审批申请，可等待另一位 BCO 在工作台审批，或撤回后重新申请。',
    processing_access_no_approver: '当前没有可处理本案申请的独立审批人，请先安排另一位具有材料处理审批资格的 BCO。',
    processing_access_not_found: '申请不存在或已不可访问，请刷新待办。',
    processing_access_empty_scope: '请先上传合成 PDF，或申请覆盖本案后续合成 PDF。',
    processing_access_conflict: '审批记录已有更新，请刷新后核对。',
    processing_access_self_approval: '需由另一位有材料处理审批权限的 BCO 审批。',
    processing_access_changed: '人员资格、审核配置或处理政策已变更，请重新申请。',
    processing_access_materials_changed: '申请后材料范围已有变化，请不批准本次申请并重新申请。',
    processing_access_nothing_to_resume: '暂无符合授权且未启动解析的材料，请刷新列表。',
    document_cloud_source_incomplete: '部分页面尚未完成识别，请先重新解析。',
    document_cloud_format_unsupported: '云端材料识别暂仅支持 PDF。',
    document_cloud_classification_conflict: '识别类别与已保存分类不同，请核对材料分类。',
    page_integrity_failed: '原页完整性校验未通过，暂时无法读取，请联系管理员。',
    tool_job_not_found: '处理记录不存在或当前账号无权读取，请重新查询。',
    case_not_found: '案件不存在或你没有访问权限，请返回案件列表。',
    material_not_in_current_list: '本轮文件列表已变化，请刷新后重新选择。',
    duplicate_material_ids: '所选文件重复，请重新选择。',
    material_not_found: '材料不存在或你没有访问权限，请刷新材料列表。',
    account_not_found: '账号不存在，请刷新账号列表。',
    upload_unavailable: '上传服务暂未就绪，请联系管理员检查原件存储配置。',
    invalid_upload_request: '上传信息不正确，请重新选择受支持的材料文件。',
    upload_size_exceeded: '文件超过当前格式的大小限制，请缩减后重新上传。',
    draft_attachment_budget_exceeded: '每份草稿最多 20 份附件，合计 100 MiB，请移除不需要的附件后重试。',
    draft_uploads_pending: '附件仍在上传或校验，请完成或取消后再创建案件。',
    draft_materials_required: '请至少上传一份材料并完成校验后，再创建案件。',
    attachment_not_ready: '所选附件尚未校验完成，请稍后重试或移除后重新上传。',
    attachment_removed: '此附件已被移除，请刷新附件列表。',
    attachment_parse_busy: '附件正在读取，请等待当前轮次完成。',
    assistant_configuration_required: '建案助手尚未就绪，请联系管理员检查模型配置；可继续手动填写。',
    upload_extension_mismatch: '文件扩展名与类型不一致，请重新选择原件。',
    upload_size_mismatch: '已传输文件的大小与申请不一致，请重新上传。',
    upload_expired: '上传授权已过期，请重新选择文件上传。',
    upload_version_conflict: '原件版本发生变化，请重新查询上传状态。',
    upload_already_registered: '原件已经登记，不能取消。请刷新材料列表。',
    username_exists: '此账号已存在，请使用其他账号名称。',
    cannot_disable_self: '不能停用当前登录账号，请由其他管理员处理。',
    cannot_revoke_own_permission_management: '不能撤销自己的权限管理资格，请由其他管理员处理。',
    person_not_available: '所选人员不可用，请刷新人员列表。',
    maker_unavailable: '所选经办人员当前不可指派，请刷新候选列表。',
    signature_source_incomplete: '现有解析结构不完整，请先检查材料处理状态；不会据此判定缺签。',
    signature_stamp_person_invalid: '印章应关联所属主体，不能填写签署人员。',
    signature_date_target_invalid: '请明确日期对应的文书、位置、签名记录或授权；无法对应时保留未核对。',
    signature_date_kind_scope_mismatch: '日期用途与对应对象不符，请分别记录文件日期、个人日期和授权日期。',
    signature_published_requirement_changed: '已发布要求不能在材料页改写或排除，请核对适用配置。',
    signature_information_storage_unavailable: '当前环境尚未安装签署记录存储，请先完成应用迁移。',
    stale_signature_information: '原件、依据或核对记录已变化，请重新查询并核对后保存。',
    signature_information_requires_review: '签署核对已失效或仍有强制事项未解决，请先完成核对。',
    signature_information_scope_invalid: '请核对文书、页码及关联范围。',
    signature_requirement_subject_invalid: '要求的主体角色或材料分类与所选对象不符。',
    signature_requirement_location_invalid: '要求关联的位置必须属于同一适用文书。',
    signature_requirement_entry_invalid: '请只关联所选位置中的签署证据。',
    signature_identity_not_confirmed: '人员或主体尚无当前有效依据，请先到业务核对确认。',
    signature_geometry_outside_page: '框选区域超出原件页面，请重新定位。',
    signature_child_outside_location: '单份签名区域必须位于所属签署位置内。',
    signature_duplicate_region: '同一区域重复登记，请明确重复关系或分别框选。',
    signature_evidence_stale: '原文依据版本已变化，请重新关联当前依据。',
    signature_evidence_invalid: '原文依据不可用，请重新选择。',
    signature_history_record_removal_forbidden: '已保存记录不能移除，请记录更正或排除原因。',
    signature_date_evidence_required: '确认日期前请添加对应的原文依据。',
    signature_date_rule_evidence_required: '确认日期规则前请添加适用条款依据。',
    signature_authorization_evidence_required: '确认授权前请添加原文授权依据。',
    signature_requirement_evidence_required: '确认要求前请添加适用条款依据。',
    invalid_grant_scope: '所选操作不支持此案件范围，请调整授权范围。',
    review_team_person_unavailable: '固定搭档中的人员已停用、需改密或不具备 BCO 身份，请管理员调整。',
    review_team_authority_unavailable: '固定分工的授权管理员已不可用，请管理员重新保存分工。',
    review_team_authority_required: '固定分工的授权已失效，请管理员重新配置。',
    review_team_permissions_changed: '固定搭档的必要权限已变更，请管理员检查分工和权限。',
    review_team_changed: '固定分工刚刚发生变更，请刷新后重试。',
    review_team_not_found: '该固定分工不存在，请刷新后重试。',
    grant_scope_denied: '此权限不在你的可授权范围内，请联系授权负责人。',
    current_password_invalid: '当前密码不正确，请重新输入。',
    password_unchanged: '新密码不能与当前密码相同。',
    invalid_credentials: '账号或密码不正确，请重新输入。',
    invalid_csrf: '页面验证已过期，请刷新页面后重新操作。',
    csrf_expired: '登录页面已过期，请刷新页面后重新登录。',
    invalid_origin: '页面来源与服务配置不一致，请从正式应用入口进入。',
  };
  if (code && messages[code]) return messages[code];
  if (status === 401) return '登录已失效或账号凭据不正确，请重新登录。';
  if (status === 403) return '当前账号没有此操作的权限，请联系授权管理员。';
  if (status === 409) return '记录已发生变化。请先刷新最新版本，再确认操作。';
  if (status === 429) return '操作过于频繁，请稍后重试。';
  return typeof message === 'string' && message.length < 300 && /[\u4e00-\u9fff]/.test(message) ? message : '操作未完成，请检查输入并稍后重试。';
}
export function errorText(error: unknown) {return error instanceof ApiError ? error.message : '操作未完成，请重新查询状态后再试。';}
export function newKey() {return crypto.randomUUID();}

export async function readSession(signal?: AbortSignal): Promise<Session> {
  try {return await api<Session>('/api/auth/session', {signal, security: false});}
  catch (error) {
    if (error instanceof ApiError && [401, 403].includes(error.status)) clearSensitiveState(true);
    throw error;
  }
}
/** Access loss must hide previously loaded data; other refresh failures keep the last good copy on screen. */
export function isAccessLoss(error: unknown) {return error instanceof ApiError && [401, 403, 404].includes(error.status);}
