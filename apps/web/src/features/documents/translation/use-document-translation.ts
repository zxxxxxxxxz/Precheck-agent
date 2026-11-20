import {useEffect, useRef, useState} from 'react';
import {useInfiniteQuery, useQuery} from '@tanstack/react-query';
import {DocumentTranslationCommandSchema, type FullTextTranslationCommand, type DocumentTranslationCommand, type DocumentTranslationTarget, type DocumentTranslationView} from '@hsbc/contracts/document-translation';
import {ApiError, newKey} from '../../../api.ts';
import {translationApi, translationBase} from './api.ts';
import {consistentTargetPages, translationCommand, translationReason, translationRunning} from './presentation.ts';

export interface TranslationScope {caseId: string; documentId: string; parseRevision: string; caseRevision: number; directoryRevision?: number; active: boolean; writable: boolean}
/** Mount with a key for case/document/parse/revision/directory. No material text goes into browser storage. */
export function useDocumentTranslation(scope: TranslationScope, field?: {matches: (target: DocumentTranslationTarget) => boolean}) {
  const {caseId, documentId, parseRevision, caseRevision, directoryRevision, active, writable} = scope;
  const base = translationBase(caseId, documentId);
  const key = ['document-translation', caseId, documentId, parseRevision, caseRevision, directoryRevision];
  const [selection, setSelection] = useState<string[]>([]);
  const [selectedJobId, setSelectedJobId] = useState<string>();
  const [pending, setPending] = useState(false);
  const [uncertain, setUncertain] = useState<DocumentTranslationCommand | FullTextTranslationCommand>();
  const [error, setError] = useState<unknown>();
  const [reused, setReused] = useState(false);
  const commandController = useRef<AbortController | null>(null);
  const alive = useRef(true);
  useEffect(() => {alive.current = true; return () => {alive.current = false; commandController.current?.abort();};}, []);
  const targets = useInfiniteQuery({queryKey: [...key, 'targets'], enabled: active, initialPageParam: 0,
    queryFn: ({signal, pageParam}) => translationApi.targets(base, parseRevision, pageParam, signal),
    getNextPageParam: page => page.nextOffset ?? undefined, staleTime: 0});
  const pages = targets.error ? [] : targets.data?.pages ?? [];
  const coherent = consistentTargetPages(pages);
  const metadata = coherent ? pages[0] : undefined;
  const items = coherent ? pages.flatMap(page => page.items).filter(item => !field || field.matches(item)) : [];
  const chunks = items.map(item => item.chunkId);
  const targetsComplete = !!metadata && !targets.hasNextPage && !targets.isFetching && coherent;
  // Field matching must cover every page; do not silently submit the first 50 paragraphs.
  useEffect(() => {
    if (field && active && coherent && targets.hasNextPage && !targets.isFetching && !targets.error)
      void targets.fetchNextPage({cancelRefetch: false});
  }, [!!field, active, coherent, targets.hasNextPage, targets.isFetching, targets.error]);
  const historyEnabled = active && (!field || (targetsComplete && chunks.length > 0 && chunks.length <= 20));
  const history = useQuery({queryKey: [...key, 'history', ...(field ? [chunks] : [])], enabled: historyEnabled,
    queryFn: ({signal}) => translationApi.history(base, parseRevision, signal, field ? chunks : undefined), staleTime: 0,
    refetchInterval: query => query.state.error ? false : query.state.data?.items.some(item => translationRunning(item.status)) ? 2000 : 15000});
  const records = history.error ? [] : history.data?.items ?? [];
  const jobId = selectedJobId ?? records[0]?.jobId;
  const job = useQuery({queryKey: [...key, 'job', jobId], enabled: active && !!jobId,
    queryFn: ({signal}) => translationApi.get(base, jobId!, signal), staleTime: 0,
    refetchInterval: query => !query.state.error && translationRunning(query.state.data?.status) ? 2000 : false});
  const historyView = records.find(record => record.jobId === jobId);
  const view = job.error || history.error ? undefined : historyView && history.dataUpdatedAt > job.dataUpdatedAt ? historyView : job.data;
  const fingerprint = metadata ? `${metadata.caseRevision}:${metadata.parseRevision}:${metadata.directoryRevision}` : '';
  const lastFingerprint = useRef('');
  useEffect(() => {if (fingerprint && lastFingerprint.current && fingerprint !== lastFingerprint.current) setSelection([]); if (fingerprint) lastFingerprint.current = fingerprint;}, [fingerprint]);
  const scopeCurrent = metadata?.caseRevision === caseRevision && metadata.parseRevision === parseRevision && (directoryRevision === undefined || metadata.directoryRevision === directoryRevision);
  const canCreate = writable && scopeCurrent && metadata?.enabled === true && metadata.canCreate && !targets.error && !pending && !uncertain;
  const refresh = async () => {setError(undefined); await Promise.all([targets.refetch(), ...(historyEnabled ? [history.refetch()] : []), ...(jobId ? [job.refetch()] : [])]);};
  const humanError = (failure: unknown) => failure instanceof ApiError && /^(translation_|document_translation_|stale_|parse_|index_not_ready|review_configuration_required|qwen_)/.test(failure.code)
    ? new ApiError(failure.status, failure.code, translationReason(failure.code), failure.requestId) : failure;
  const submit = async (retry?: DocumentTranslationView, resend?: DocumentTranslationCommand | FullTextTranslationCommand, chunkIds?: string[]) => {
    if (commandController.current || (!resend && (!canCreate || !metadata))) return;
    const requested = chunkIds ?? selection;
    const chosen = items.filter(item => item.available && requested.includes(item.chunkId)).map(item => item.chunkId);
    if (chunkIds && (!targetsComplete || chosen.length !== chunkIds.length)) return;
    if (!resend && !retry && !chosen.length) return;
    if (retry && !retry.canRetry) return;
    let input = resend;
    if (!input) {
      const command = translationCommand(metadata!, chosen, newKey(), retry);
      const {chunkIds: _chunkIds, fieldSources: _fieldSources, ...fullTextCommand} = command;
      input = retry?.scope === 'full_text' ? fullTextCommand : command;
    }
    const controller = new AbortController(); commandController.current = controller;
    setPending(true); setError(undefined); setReused(false);
    try {
      const result = await ('chunkIds' in input ? translationApi.create(base, DocumentTranslationCommandSchema.parse(input), controller.signal) : translationApi.createFullText(base, input, controller.signal));
      if (!alive.current) return;
      setUncertain(undefined); setSelectedJobId(result.jobId); setReused(result.reused); setSelection([]);
      await history.refetch();
    } catch (failure) {
      if (!alive.current) return;
      // Keep the exact payload/key until an ambiguous transport outcome is resolved.
      setUncertain(failure instanceof ApiError && failure.status > 0 && failure.status < 500 ? undefined : input);
      setError(humanError(failure));
    } finally {commandController.current = null; if (alive.current) setPending(false);}
  };
  const cancel = async () => {
    if (commandController.current || !view?.canCancel) return;
    const controller = new AbortController(); commandController.current = controller; setPending(true); setError(undefined);
    try {await translationApi.cancel(view.jobId, controller.signal); if (alive.current) await refresh();}
    catch (failure) {if (alive.current) setError(humanError(failure));}
    finally {commandController.current = null; if (alive.current) setPending(false);}
  };
  return {targets, history, job, metadata, items, records, view, coherent, selection, setSelection, selectedJobId: jobId, setSelectedJobId,
    pending, uncertain, error, reused, canCreate, targetsComplete, scopeCurrent, refresh, submit, cancel};
}
