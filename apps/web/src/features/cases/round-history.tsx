import React from 'react';
import {Link} from 'react-router';
import {useQuery} from '@tanstack/react-query';
import type {ReviewRoundsState} from '@hsbc/contracts/review-rounds';
import type {CaseSummary} from './types.ts';
import type {Material} from '../materials/types.ts';
import {api} from '../../api.ts';
import {blocksView, ErrorNotice} from '../../ui.tsx';

export function PreviousRound({item, state}: {item: CaseSummary; state?: ReviewRoundsState}) {
  const selected = state?.items.find(round => round.roundId === item.selectedRoundId);
  const previous = selected && !selected.locked ? state?.items.filter(round => round.locked && round.status !== 'discarded' && round.roundNumber < selected.roundNumber).sort((a, b) => b.roundNumber - a.roundNumber)[0] : undefined;
  const materials = useQuery({
    queryKey: ['materials', item.id, previous?.roundId],
    enabled: !!previous,
    queryFn: ({signal}) => api<{items: Material[]}>(`/api/cases/${encodeURIComponent(item.id)}/materials?roundId=${encodeURIComponent(previous!.roundId)}`, {signal}),
  });
  if (!previous) return null;
  const query = `round=${encodeURIComponent(previous.roundId)}`;
  return <details className="previous-round" aria-label="上一轮已锁定记录">
    <summary>
      <span className="previous-round-title"><svg className="previous-round-lock" viewBox="0 0 16 16" width="14" height="14" aria-hidden="true" fill="none" stroke="currentColor"><rect x="3.5" y="7" width="9" height="6.5"/><path d="M5.5 7V5a2.5 2.5 0 0 1 5 0v2"/></svg><b>第 {previous.roundNumber} 轮已锁定</b></span>
      <span className="previous-round-meta">{previous.materialCount != null ? `${previous.materialCount} 份文件 · ` : ''}只读 · 第 {selected!.roundNumber} 轮在下方准备</span>
      <span className="previous-round-actions"><Link to={`/cases/${item.id}/review?${query}&mode=business&tab=checklist`}>查看第 {previous.roundNumber} 轮审查</Link><Link to={`/cases/${item.id}/reports?${query}`}>查看结果</Link></span>
      <span className="previous-round-toggle">文件</span>
    </summary>
    {materials.isPending ? <p role="status">正在读取本轮文件…</p> : materials.error ? <ErrorNotice error={materials.error} retry={() => void materials.refetch()}/> : null}
    {!blocksView(materials) && !!materials.data?.items.length && <ul className="previous-round-files" aria-label={`第 ${previous.roundNumber} 轮文件`}>{materials.data.items.map(material => <li key={material.id}>{material.filename}</li>)}</ul>}
  </details>;
}
