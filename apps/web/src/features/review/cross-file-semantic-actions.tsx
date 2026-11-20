import {useEffect,useRef} from 'react';
import {useMutation,useQuery,useQueryClient} from '@tanstack/react-query';
import type {CrossFileCheck} from '@hsbc/contracts/review-checklist';
import type {ReviewState} from '@hsbc/contracts/review';
import type {AnalysisState} from '@hsbc/contracts/review-delivery';
import {api,newKey} from '../../api.ts';
import {useAuth} from '../../auth.tsx';
import {blocksView} from '../../ui.tsx';

/** Viewing an editable field starts one bounded comparison at a time. GET remains read-only. */
export function CrossFileSemanticActions({checks,state,fieldId}:{checks:CrossFileCheck[];state:ReviewState;fieldId:string}){
  const {session}=useAuth(),cache=useQueryClient(),attempted=useRef(new Set<string>());
  const base=`/api/cases/${state.caseId}/review-delivery/analysis`;
  const eligible=checks.filter(c=>c.semanticEligible);
  const metadata=useQuery({queryKey:['review-analysis-state',session.user?.accountId,state.caseId,state.revision],enabled:!state.readOnly&&eligible.length>0,
    queryFn:({signal})=>api<AnalysisState>(base,{signal}),retry:false});
  const enabled=!state.readOnly&&!blocksView(metadata)&&metadata.data?.caseId===state.caseId&&metadata.data.revision===state.revision&&metadata.data.modelEnabled&&metadata.data.allowedActions.includes('review:analyze');
  const mutation=useMutation({mutationFn:(checkId:string)=>api<{id:string}>(`${base}/cross-file`,{method:'POST',body:{checkId,fieldId,expectedRevision:state.revision,idempotencyKey:newKey()}}),
    retry:false,onSuccess:()=>cache.invalidateQueries({queryKey:['review-checklist',session.user?.accountId,state.caseId]})});
  const key=(check:CrossFileCheck)=>JSON.stringify([state.caseId,state.roundId,state.revision,check.id,check.sources]);
  const next=eligible.find(c=>!c.semantic&&c.outcome!=='consistent'&&!attempted.current.has(key(c)));
  const busy=mutation.isPending||eligible.some(c=>c.semantic?.state==='pending');
  useEffect(()=>{
    if(!enabled||busy||mutation.isError||!next)return;
    attempted.current.add(key(next));mutation.mutate(next.id);
  },[enabled,busy,next,mutation.isError]);
  // Results use the existing comparison outcome and explanation; no extra UI.
  return null;
}
