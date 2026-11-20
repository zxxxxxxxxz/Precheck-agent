import {useEffect,useRef,useState} from 'react';
import {useQueryClient} from '@tanstack/react-query';
import type {ReviewState} from '@hsbc/contracts/review';
import {ApiError} from '../../api.ts';
import {useAuth} from '../../auth.tsx';
import {translationApi,translationBase} from '../documents/translation/api.ts';
import {translationReason} from '../documents/translation/presentation.ts';
import type {RoundTranslations} from './translation-evidence.ts';
import {EvidenceTranslationRequests,evidenceTranslationCommand,nextEvidenceTranslation,withEvidenceTranslationJob} from './evidence-translation-generation.ts';

export function useEvidenceTranslationGeneration(state:ReviewState,data:RoundTranslations|undefined,ready:boolean){
  const {session}=useAuth(),cache=useQueryClient(),requests=useRef(new EvidenceTranslationRequests());
  const accountId=session.user?.accountId;
  const batch=ready&&accountId?nextEvidenceTranslation(state,data):undefined;
  const identity=batch?JSON.stringify([accountId,state.caseId,batch]):'';
  const [activity,setActivity]=useState<{identity:string;pending:boolean;error?:unknown}>();
  useEffect(()=>{
    if(!batch||!accountId)return;
    let canceled=false;
    setActivity({identity,pending:true});
    void (async()=>{
      const command=await evidenceTranslationCommand(accountId,state.caseId,batch);
      if(canceled)return;
      const job=await requests.current.submit(command.idempotencyKey,async()=>{
        const base=translationBase(state.caseId,batch.documentId);
        const accepted=await translationApi.create(base,command);
        return translationApi.get(base,accepted.jobId);
      });
      // Seed the durable receipt before history polling: even a very recent
      // accepted task must not look missing and trigger a submission loop.
      cache.setQueriesData<RoundTranslations>({queryKey:['round-translations',accountId,state.caseId]},data=>
        withEvidenceTranslationJob(data,batch,job));
    })().catch(error=>{if(!canceled)setActivity({identity,pending:false,error});})
      .finally(()=>{if(!canceled)setActivity(value=>value?.identity===identity?{...value,pending:false}:value);});
    return ()=>{canceled=true;};
  },[identity,cache]);
  const active=activity?.identity===identity?activity:undefined;
  return active?.error?translationReason(active.error instanceof ApiError?active.error.code:'translation_unavailable'):
    active?.pending?'正在生成并保存参考译文…':undefined;
}
