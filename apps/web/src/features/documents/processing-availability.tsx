import React from 'react';
import {Alert} from 'antd';
import {useQuery} from '@tanstack/react-query';
import type {ProcessingAccessState} from '@hsbc/contracts/document-processing-access';
import type {CaseSummary} from '../cases/types.ts';
import {api} from '../../api.ts';
import {blocksView, ErrorNotice} from '../../ui.tsx';

/** Normal uploads need no policy UI; surface only actionable service failures. */
export function ProcessingAvailability({item}: {item: CaseSummary}) {
  const query=useQuery({queryKey:['processing-access',item.id,item.revision],
    queryFn:({signal})=>api<ProcessingAccessState>(`/api/cases/${item.id}/processing-access`,{signal}),refetchInterval:30_000});
  if(item.selectedRoundId&&item.selectedRoundId!==item.currentRoundId)return null;
  if(blocksView(query))return <ErrorNotice error={query.error} retry={()=>void query.refetch()}/>;
  if(query.data?.policy&&!query.data.available)return <Alert type="warning" showIcon title="材料识别服务暂不可用，文件可继续上传，请联系系统负责人。"/>;
  return null;
}
