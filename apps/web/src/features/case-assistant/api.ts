import {useQuery} from '@tanstack/react-query';
import type {CaseAssistantState, CaseAssistPage, CaseAssistTurnView} from '@hsbc/contracts/case-assistant';
import type {GuidanceDigestView} from '@hsbc/contracts/review-guidance';
import type {ReviewState} from '@hsbc/contracts/review';
import type {ReviewChecklist} from '@hsbc/contracts/review-checklist';
import {api, newKey, queryClient} from '../../api.ts';
import {useAuth} from '../../auth.tsx';
import {roundQuery} from '../review/round-controls.tsx';

const base = (caseId: string) => `/api/cases/${encodeURIComponent(caseId)}`;
export const assistantKey = (accountId: string | undefined, caseId: string) => ['case-assistant', accountId, caseId];
const busy = (turns: CaseAssistTurnView[]) => turns.some(turn => turn.state === 'pending' || turn.state === 'running');

/** Polls only while a turn is being processed; never re-sends a turn. */
export function useAssistantState(caseId: string, enabled: boolean) {
  const {session} = useAuth();
  return useQuery({queryKey: assistantKey(session.user?.accountId, caseId), enabled, queryFn: ({signal}) => api<CaseAssistantState>(`${base(caseId)}/assistant`, {signal}),
    refetchInterval: query => query.state.data && busy(query.state.data.turns) ? 2500 : false});
}
/** Same cache entry as the review workspace, so guidance and permissions stay consistent. */
export function useAssistantReview(caseId: string, roundId: string | null, enabled: boolean) {
  const {session} = useAuth();
  return useQuery({queryKey: ['case-review', session.user?.accountId, caseId, roundId ?? 'current'], enabled, queryFn: ({signal}) => api<ReviewState>(`${base(caseId)}/review${roundQuery(roundId)}`, {signal})});
}
export function useCaseDigests(caseId: string, enabled: boolean) {
  const {session} = useAuth();
  return useQuery({queryKey: ['case-guidance-digests', session.user?.accountId, caseId], enabled, queryFn: ({signal}) => api<{items: GuidanceDigestView[]}>(`${base(caseId)}/review/guidance/digests`, {signal})});
}
/** The caller owns the turn id, so the message can be shown before the server accepts it and matched afterwards. */
export function sendTurn(caseId: string, clientTurnId: string, text: string, page: CaseAssistPage, mode: 'chat' | 'legal_opinion' = 'chat') {
  return api<CaseAssistTurnView>(`${base(caseId)}/assistant/turns`, {method: 'POST', body: {clientTurnId, text, mode, page}});
}
/** Stops waiting for a message that has not been answered; a reply that arrives later is discarded by the server. */
export function cancelTurn(caseId: string, turnId: string) {
  return api<CaseAssistantState>(`${base(caseId)}/assistant/turns/${encodeURIComponent(turnId)}/cancel`, {method: 'POST', body: {}});
}
/** Sending a message changes the conversation only; rules and review data are refreshed when a rule is saved. */
export function refreshConversation() {return queryClient.invalidateQueries({queryKey: ['case-assistant']});}
/** Label of a checklist row the workspace has already loaded; undefined until it has. */
export function loadedFieldLabel(caseId: string, rowId: string | null): string | undefined {
  if (!rowId) return undefined;
  for (const [, data] of queryClient.getQueriesData<ReviewChecklist>({queryKey: ['review-checklist']})) {
    const row = data?.caseId === caseId ? data.rows.find(item => item.id === rowId) : undefined;
    if (row) return row.label;
  }
  return undefined;
}
export function applyProposal(caseId: string, proposalId: string, body: {contentHash: string; expectedRevision: number; statement?: string}) {
  return api<CaseAssistantState>(`${base(caseId)}/assistant/proposals/${encodeURIComponent(proposalId)}/apply`, {method: 'POST', body: {...body, idempotencyKey: newKey()}});
}
export function cancelProposal(caseId: string, proposalId: string) {
  return api<CaseAssistantState>(`${base(caseId)}/assistant/proposals/${encodeURIComponent(proposalId)}/cancel`, {method: 'POST', body: {idempotencyKey: newKey()}});
}
export function withdrawFieldValue(caseId: string, body: {documentId: string; fieldId: string; expectedRevision: number; roundId?: string}) {
  return api<ReviewState>(`${base(caseId)}/review/field-values/withdraw`, {method: 'POST', body: {...body, reason: '撤回经案件助手填入的字段取值', idempotencyKey: newKey()}});
}
export function retireGuidance(caseId: string, guidanceId: string, body: {expectedRevision: number; roundId?: string; reason: string}) {
  return api<ReviewState>(`${base(caseId)}/review/guidance/${encodeURIComponent(guidanceId)}/retire`, {method: 'POST', body: {...body, idempotencyKey: newKey()}});
}
export function requestDigest(caseId: string) {
  return api<GuidanceDigestView>(`${base(caseId)}/review/guidance/digest`, {method: 'POST', body: {idempotencyKey: newKey()}});
}
/** Re-runs semantic checks that now carry a rule but have no result yet; the queue accepts at most four. */
export async function recheckGuided(caseId: string, roundId: string | null): Promise<{submitted: number; remaining: number}> {
  const [state, checklist] = await Promise.all([api<ReviewState>(`${base(caseId)}/review${roundQuery(roundId)}`), api<ReviewChecklist>(`${base(caseId)}/review/checklist${roundQuery(roundId)}`)]);
  const targets = checklist.rows.flatMap(row => (row.crossChecks ?? []).filter(check => check.semanticEligible && check.guidance?.length && !check.semantic && check.outcome !== 'consistent').map(check => ({row, check})));
  let submitted = 0;
  for (const {row, check} of targets.slice(0, 4)) {
    await api(`${base(caseId)}/review-delivery/analysis/cross-file`, {method: 'POST', body: {checkId: check.id, fieldId: row.fieldId, expectedRevision: state.revision, idempotencyKey: newKey()}});
    submitted++;
  }
  return {submitted, remaining: targets.length - submitted};
}
export async function refreshAfterRule(caseId: string) {
  // A filled or withdrawn value shows on the reader, the check rows, the material list and the case list alike.
  await Promise.all(['case-assistant', 'case-review', 'review-checklist', 'review-rounds', 'case-guidance-digests', 'document-fields', 'document-fields-source-mode', 'document-directory', 'materials', 'case', 'cases'].map(name => queryClient.invalidateQueries({queryKey: [name]})));
  void caseId;
}
