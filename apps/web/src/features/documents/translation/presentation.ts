import type {DocumentTranslationCommand, DocumentTranslationTargets, DocumentTranslationView} from '@hsbc/contracts/document-translation';

export const translationStatus: Record<DocumentTranslationView['status'], string> = {
  pending: '排队中', running: '正在翻译', ready: '译文已生成', partial: '部分完成，需核对', failed: '翻译失败', canceled: '已取消', stale: '历史译文，已失效',
};
export const translationRunning = (status?: string) => status === 'pending' || status === 'running';
const reasons: Record<string, string> = {
  document_translation_unavailable: '中文翻译暂未启用，可查看已有记录。',
  review_configuration_required: '请先在案件概览绑定已发布的审核配置。',
  parse_not_available: '材料尚无解析记录，请先解析材料。', index_not_ready: '材料正在整理，请稍后刷新。', parse_not_ready: '材料尚未解析完成，请稍后刷新。',
  stale_revision: '案件已更新，请刷新后重新选择段落。', stale_parse_revision: '原文已有新的解析结果，请切换到最新识别记录。',
  stale_directory_revision: '材料目录已更新，请刷新后重新选择段落。',
  translation_chunk_not_found: '所选段落已变化，请刷新后重新选择。',
  translation_source_too_large: '段落过长，暂不能自动翻译，请查看完整原文。',
  translation_context_budget_exceeded: '关联条款过多，暂不能完整翻译，请人工核对原文。',
  translation_source_incomplete: '原文存在识别缺口，译文需结合原件核对。', translation_context_incomplete: '关联条款未完整定位',
  translation_quote_not_in_source: '当前引用与原文位置不一致，请重新核对字段来源。',
  translation_source_integrity_failed: '当前原文位置无法验证，请重新核对字段来源。',
  translation_no_english_text: '此段未识别到英文。', translation_queue_full: '本案已有多项翻译任务，请等候完成后再提交。',
  translation_no_available_source: '暂无可自动翻译的段落，请核对原文。',
  translation_full_text_budget_exceeded: '全文及关联条款超出处理上限，请联系管理员核查。',
  translation_retry_not_allowed: '此任务目前不能重试，请刷新状态。', translation_retry_budget_exceeded: '此组段落已达到重试次数限制，请联系管理员核查。',
  translation_call_unknown: '上次翻译是否完成尚不确定，已暂停重试，请联系管理员核查。',
  translation_invalid_output: '模型返回内容无法使用，请重新查询状态后重试。',
  translation_structure_check_failed: '译文结构需核对', translation_numbers_check_failed: '数字或日期需核对',
  translation_currencies_check_failed: '币种需核对', translation_placeholders_check_failed: '占位信息需核对',
  translation_references_check_failed: '条款引用需核对', translation_terminology_check_failed: '术语需核对',
};
export function translationReason(code: string) {
  return reasons[code] ?? (code.startsWith('qwen_') ? '翻译服务暂时不可用，请重新查询状态后再试。' : '翻译未完成，请刷新状态并核对原文。');
}
/** Never retry only completed items: a failed task may have produced zero segments. */
export function translationCommand(targets: Pick<DocumentTranslationTargets, 'caseRevision' | 'parseRevision' | 'directoryRevision'>, chunkIds: string[], idempotencyKey: string, retry?: DocumentTranslationView): DocumentTranslationCommand {
  return {expectedRevision: targets.caseRevision, parseRevision: targets.parseRevision, expectedDirectoryRevision: targets.directoryRevision,
    chunkIds: retry ? [...retry.chunkIds] : [...chunkIds], idempotencyKey,
    reason: retry ? '重新生成中文参考译文，供人工核对' : '生成所选英文段落的中文参考译文，供人工核对', ...(retry ? {retryOf: retry.jobId, ...(retry.fieldSources?{fieldSources:retry.fieldSources.map(source=>({...source}))}:{})} : {})};
}
export function consistentTargetPages(pages: DocumentTranslationTargets[]) {
  const first = pages[0];
  return !first || pages.every(page => page.caseRevision === first.caseRevision && page.parseRevision === first.parseRevision && page.directoryRevision === first.directoryRevision);
}
