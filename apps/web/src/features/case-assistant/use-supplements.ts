import {useEffect, useRef, useState} from 'react';
import {useQuery} from '@tanstack/react-query';
import type {SupplementState} from '@hsbc/contracts/case-supplement';
import {api, newKey} from '../../api.ts';
import {useAuth} from '../../auth.tsx';
import {blocksView} from '../../ui.tsx';
import {supplementRequestHint} from './supplement-conversation.ts';

export function useSupplements(caseId: string, roundId: string | null, revision: number | undefined, active: boolean, currentDocumentId?: string) {
  const {session} = useAuth();
  const [documentIds, setDocumentIds] = useState<string[]>([]);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<unknown>();
  const initialized = useRef(false), inFlight = useRef(false);
  const attempt = useRef<{signature: string; key: string} | undefined>(undefined);
  const base = `/api/cases/${encodeURIComponent(caseId)}/assistant/supplements`;
  const query = useQuery({queryKey: ['case-supplements', session.user?.accountId, caseId, roundId ?? 'legacy'],
    queryFn: ({signal}) => api<SupplementState>(`${base}${roundId ? `?roundId=${encodeURIComponent(roundId)}` : ''}`, {signal}),
    enabled: active && revision !== undefined, refetchInterval: active ? 2000 : false});
  const data = revision === undefined || blocksView(query) ? undefined : query.data;
  useEffect(() => {
    if (!data || initialized.current) return;
    initialized.current = true;
    const current = data.documents.find(document => document.id === currentDocumentId && document.available);
    const supplements = data.documents.filter(document => document.supplemental && document.available);
    setDocumentIds(current ? [current.id] : supplements.length === 1 ? [supplements[0]!.id] : []);
  }, [data, currentDocumentId]);
  const hint = query.error ? '补充材料读取失败，请重新查询后发送。' : revision === undefined ? '当前轮次尚未读取完成，请稍后再试。' : supplementRequestHint(data, documentIds);
  async function send(text: string) {
    const request = text.trim();
    if (inFlight.current || hint || !request || revision === undefined) return false;
    const body = {expectedRevision: revision, ...(roundId ? {roundId} : {}), request, documentIds};
    const signature = JSON.stringify(body);
    if (attempt.current?.signature !== signature) attempt.current = {signature, key: newKey()};
    inFlight.current = true; setSending(true); setError(undefined);
    try {
      await api(base, {method: 'POST', body: {...body, idempotencyKey: attempt.current.key}});
      attempt.current = undefined;
      await query.refetch();
      return true;
    } catch (failure) {setError(failure); await query.refetch(); return false;}
    finally {inFlight.current = false; setSending(false);}
  }
  return {query, data, documentIds, setDocumentIds, hint, sending, error, send};
}
