import {useEffect,useRef,useState} from 'react';
import {api,ApiError,queryClient} from '../../api.ts';
import type {ReviewState} from '@hsbc/contracts/review';
import type {Material} from './types.ts';

/** One admission attempt per material/revision while this list is open.
 * Polling and StrictMode must not become an automatic retry loop. */
export function useAutomaticMaterialProcessing(state:ReviewState|undefined,rows:Material[],enabled:boolean){
  const attempted=useRef(new Set<string>());
  const [failure,setFailure]=useState<{scope:string;error:unknown}>();
  const scope=state?`${state.caseId}:${state.roundId??'legacy'}`:'';
  const revision=state?.revision;
  const candidates=rows.filter(row=>['parked','capability_disabled','configuration_required'].includes(row.parseStatus)).map(row=>row.id).sort().join(',');
  const caseId=state?.caseId,roundId=state?.roundId;
  useEffect(()=>{
    if(!enabled||!caseId||!revision||!candidates)return;
    const keys=candidates.split(',').map(id=>`${scope}:${revision}:${id}`);
    if(keys.every(key=>attempted.current.has(key)))return;
    keys.forEach(key=>attempted.current.add(key));
    setFailure(undefined);
    void api<{started:string[];deferred:{documentId:string;code:string}[]}>(`/api/cases/${caseId}/materials/ensure-processing`,{
      method:'POST',body:{expectedRevision:revision,...(roundId?{roundId}:{})},
    }).then(async result=>{
      if(result.deferred.length)setFailure({scope,error:new ApiError(409,result.deferred[0].code,'部分材料暂时无法启动解析，请在材料详情查看处理状态并联系管理员检查识别配置。')});
      if(result.started.length)await Promise.all(['materials','case-review','document-processing-summary'].map(name=>queryClient.invalidateQueries({queryKey:[name],predicate:query=>query.queryKey.includes(caseId)})));
    }).catch(error=>setFailure({scope,error}));
  },[enabled,caseId,roundId,scope,revision,candidates]);
  return failure?.scope===scope?failure.error:undefined;
}
