import React from 'react';
import {useQuery} from '@tanstack/react-query';
import type {ProcessingAccessState} from '@hsbc/contracts/document-processing-access';
import type {CaseSummary} from '../cases/types.ts';
import {can} from '../identity/permissions.ts';
import {api} from '../../api.ts';
import {blocksView, ErrorNotice, Loading, RefreshNotice} from '../../ui.tsx';
import {formatTime} from '../../shared/format.ts';

export function ProcessingAccessHistory({item}: {item: CaseSummary}) {
  const enabled = can(item.allowed_actions, 'case:read');
  const query = useQuery({queryKey: ['processing-access', item.id, item.revision], enabled,
    queryFn: ({signal}) => api<ProcessingAccessState>(`/api/cases/${item.id}/processing-access`, {signal}), refetchInterval: 15_000});
  if (!enabled) return null;
  if (query.isPending) return <Loading label="正在读取历史处理申请"/>;
  if (blocksView(query)) return <div><p>历史处理申请暂时无法读取。</p><ErrorNotice error={query.error} retry={() => void query.refetch()}/></div>;
  const state = query.data;
  return <>
    <RefreshNotice query={query} retry={() => void query.refetch()}/>
    {!!state?.requests.length && <details>
      <summary>历史处理申请（{state.requests.length}）</summary>
      <p className="help-text">保留本案此前的申请和审批记录，不按预审轮次筛选。{state.policy && '当前使用统一政策，无需再提交逐案申请。'}</p>
      <ol className="review-loop-list">{state.requests.map(request => <li key={request.id}>
        <p>{request.requesterName} · <time dateTime={request.requestedAt}>{formatTime(request.requestedAt)}</time></p>
        <p className="review-loop-value">申请依据：{request.reason}</p>
        {request.decisionReason && <p className="review-loop-value">{request.status === 'withdrawn' ? '撤回依据' : '审批依据'}：{request.decisionReason}{request.deciderName && ` · ${request.deciderName}`}</p>}
      </li>)}</ol>
    </details>}
  </>;
}
