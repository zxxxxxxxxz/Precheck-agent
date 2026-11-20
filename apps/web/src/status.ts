import {processingLabels} from './features/documents/presentation.ts';

export type Tone = 'plain' | 'muted' | 'warning' | 'error';
export interface StatusView {label: string; tone: Tone}
const fallback: StatusView = {label: '状态待查询', tone: 'muted'};

export const caseStatuses: Record<string, StatusView> = {
  assignment_required: {label: '待指派', tone: 'warning'},
  preparing:{label:'准备材料',tone:'muted'},reviewing:{label:'预审中',tone:'plain'},execution_failed:{label:'预审失败',tone:'error'},results_pending:{label:'结果待处理',tone:'warning'},round_completed:{label:'本轮预审完成',tone:'plain'},canceled:{label:'预审已取消',tone:'warning'},stale:{label:'结果待更新',tone:'warning'},closed:{label:'案件已完结',tone:'muted'},
  collecting_materials: {label: '材料整理中', tone: 'muted'},
  // Who has to act on the current round.
  result_to_confirm: {label: '初审结果待确认', tone: 'warning'}, to_submit: {label: '待提交复核', tone: 'warning'}, awaiting_checker: {label: '待独立复核', tone: 'plain'},
  returned: {label: '已退回待修改', tone: 'warning'}, correcting: {label: '复核更正中', tone: 'warning'}, round_confirmed: {label: '本轮已复核', tone: 'plain'},
};
/** Statuses a case list can actually be in, in the order the work moves. The stage values replace the two that lumped them together. */
export const caseListStatuses = ['assignment_required', 'preparing', 'reviewing', 'execution_failed', 'canceled', 'stale', 'result_to_confirm', 'to_submit', 'awaiting_checker', 'returned', 'correcting', 'round_confirmed'] as const;
export const adoptionStatuses: Record<string, StatusView> = {
  pending: {label: '待确认采用', tone: 'warning'}, adopt: {label: '已纳入', tone: 'plain'}, reject: {label: '不采纳', tone: 'muted'}, superseded: {label: '历史版本', tone: 'muted'},
};
const parseTones: Record<string, Tone> = {
  parked: 'muted', configuration_required: 'warning', capability_disabled: 'muted', pending: 'muted', queued: 'muted', running: 'muted', processing: 'muted',
  ready: 'plain', succeeded: 'plain', completed: 'plain', partial: 'warning', stale: 'warning', canceled: 'warning', failed: 'error',
};
export const parseStatuses: Record<string, StatusView> = Object.fromEntries(Object.entries(processingLabels).map(([key, label]) => [key, {label, tone: parseTones[key] ?? 'muted'}]));

export function statusView(map: Record<string, StatusView>, value: string | null | undefined): StatusView {
  return (value && map[value]) || fallback;
}
