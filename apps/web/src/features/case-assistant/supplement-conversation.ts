import type {CaseAssistTurnView} from '@hsbc/contracts/case-assistant';
import type {SupplementJob, SupplementState} from '@hsbc/contracts/case-supplement';

export function supplementRequestHint(data: SupplementState | undefined, documentIds: string[]): string | undefined {
  if (!data) return '正在读取补充材料';
  if (!data.available) return '补充提取暂不可用，请联系管理员检查私有辅助模型配置。';
  if (!data.canRequest) return '当前轮次或权限不允许发起补充请求。';
  if (!data.documents.some(document => document.supplemental)) return '请先在原件阅读页将补充文件的材料类型确认为“其他／补充材料”。';
  const selected = data.documents.filter(document => documentIds.includes(document.id));
  if (selected.length !== documentIds.length || selected.some(document => !document.available)) return '所选材料已变化，请重新选择。';
  if (!selected.some(document => document.supplemental)) return '请选择至少一份其他／补充材料，可同时加入需要对照的标准材料。';
  if (documentIds.length > 6) return '每次最多选择六份文件。';
}

/** Keep request/reply pairs together and merge the two persisted histories without changing either. */
export function conversationEntries(turns: CaseAssistTurnView[], jobs: SupplementJob[]) {
  return [
    ...turns.map(turn => ({kind: 'chat' as const, id: turn.id, createdAt: turn.createdAt, turn})),
    ...jobs.map(job => ({kind: 'supplement' as const, id: job.id, createdAt: job.createdAt, job})),
  ].sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt) || a.id.localeCompare(b.id));
}
