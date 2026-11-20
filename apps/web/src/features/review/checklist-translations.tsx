import React,{useState,useRef,useEffect} from 'react';
import {Button} from 'antd';
import {useQuery} from '@tanstack/react-query';
import {Link} from 'react-router';
import type {ReviewState,ReviewEvidence} from '@hsbc/contracts/review';
import type {ReviewChecklist,ChecklistDocument} from '@hsbc/contracts/review-checklist';
import type {DocumentTranslationTarget,DocumentTranslationTargets,DocumentTranslationView} from '@hsbc/contracts/document-translation';
import type {AnalysisState} from '@hsbc/contracts/review-delivery';
import {api,ApiError,newKey} from '../../api.ts';
import {useAuth} from '../../auth.tsx';
import {ErrorNotice,Loading,blocksView} from '../../ui.tsx';
import {translationApi,translationBase} from '../documents/translation/api.ts';
import {translationReason,consistentTargetPages} from '../documents/translation/presentation.ts';
import {evidenceUrl} from './presentation.ts';
import {matchingTranslationEvidence,segmentFor,type RoundTranslations,type TranslationDocument} from './translation-evidence.ts';
export {matchingTranslationEvidence,segmentFor,type RoundTranslations} from './translation-evidence.ts';
import {roundQuery} from './round-controls.tsx';

export function useChecklist(state:ReviewState){
  const {session}=useAuth();
  // A person's reads run one after another on the server and a large checklist takes seconds, so it is re-read no more
  // often than four times its own duration; while an AI check runs, a short read of the jobs says when to re-read it.
  const took=useRef(0);
  const query=useQuery({queryKey:['review-checklist',session.user?.accountId,state.caseId,state.roundId??(state.legacyView?'legacy':'current'),state.revision],
    refetchOnMount:'always',staleTime:0,queryFn:async({signal})=>{const started=performance.now();
      try{return await api<ReviewChecklist>(`/api/cases/${state.caseId}/review/checklist${roundQuery(state.roundId??(state.legacyView?'legacy':undefined))}`,{signal});}
      finally{took.current=performance.now()-started;}},
    refetchInterval:()=>state.readOnly?false:Math.max(15000,took.current*4)});
  const semanticPending=!state.readOnly&&!!query.data?.rows.some(row=>row.crossChecks?.some(check=>check.semantic?.state==='pending'));
  const jobs=useQuery({queryKey:['review-checklist-analysis-jobs',session.user?.accountId,state.caseId],enabled:semanticPending,staleTime:0,refetchInterval:semanticPending?3000:false,
    queryFn:({signal})=>api<AnalysisState>(`/api/cases/${state.caseId}/review-delivery/analysis`,{signal})});
  const active=semanticPending&&jobs.data?jobs.data.jobs.filter(job=>job.state==='pending'||job.state==='running').map(job=>job.id).sort().join(','):undefined;
  const seen=useRef<string|undefined>(undefined);const {refetch}=query;
  useEffect(()=>{if(active===undefined)return;if(seen.current!==undefined&&seen.current!==active)void refetch();seen.current=active;},[active,refetch]);
  // Refetch-on-mount alone still exposes cached rows during the request. Do not
  // display counts or schedule semantic work until this visit has a fresh response.
  return {...query,isPending:query.isPending||!query.isFetchedAfterMount&&!query.isError,
    data:!query.isFetchedAfterMount||query.isError||blocksView(query)?undefined:query.data};
}
const activeJob=(j:DocumentTranslationView)=>['pending','running'].includes(j.status);
export function useRoundTranslations(state:ReviewState,checklist:ReviewChecklist|undefined,evidence?:Array<ReviewEvidence&{quote?:string}>){
  const {session}=useAuth();const referenceRoundId=state.readOnly&&state.roundId?state.roundId:undefined;
  const query=useQuery({queryKey:['round-translations',session.user?.accountId,state.caseId,state.roundId??'legacy',state.revision,checklist?.documents.map(d=>[d.id,d.parseRevision,d.directoryRevision]),evidence],enabled:!!checklist&&(!evidence||evidence.length>0),
    queryFn:async({signal}):Promise<RoundTranslations>=>{
      const documents:TranslationDocument[]=[];
      for(const document of checklist!.documents){
        if(evidence&&!evidence.some(e=>e.documentVersionId===document.id&&e.parseRevision===document.parseRevision&&e.directoryRevision===document.directoryRevision))continue;
        if(!document.parseRevision||!document.directoryRevision)continue;
        const base=translationBase(state.caseId,document.id),targets:DocumentTranslationTarget[]=[];let offset:number|null=0,metadata:DocumentTranslationTargets|undefined;
        if(evidence){
          const selected=[...new Map(evidence.filter(e=>e.documentVersionId===document.id&&e.parseRevision===document.parseRevision&&e.directoryRevision===document.directoryRevision)
            .map(e=>{const source={...(e.anchorId?{anchorId:e.anchorId}:{sourceNodeId:e.sourceNodeId!}),...(e.quote?{quote:e.quote}:{})};return [JSON.stringify(source),source] as const;})).values()];
          for(let start=0;start<selected.length;start+=20){
            const page=await translationApi.fieldTargets(base,document.parseRevision,document.directoryRevision!,selected.slice(start,start+20),signal,referenceRoundId);
            metadata??=page;if(!consistentTargetPages([metadata,page]))throw new ApiError(409,'stale_revision','材料或案件已变化，请重新查询翻译范围。');targets.push(...page.items);
          }
        }else{
        do{const page=await translationApi.targets(base,document.parseRevision,offset,signal,referenceRoundId);metadata??=page;
          if(page.parseRevision!==document.parseRevision||page.directoryRevision!==document.directoryRevision||!consistentTargetPages([metadata,page]))throw new ApiError(409,'stale_directory_revision','材料或案件已变化，请重新查询翻译范围。');
          targets.push(...page.items.filter(t=>evidence?matchingTranslationEvidence({documents:[{document,metadata:page,targets:[t],jobs:[]}],unparsed:[]},evidence).length>0:t.recommended));offset=page.nextOffset;}while(offset!==null);
        }
        const jobs=new Map<string,DocumentTranslationView>();
        for(let start=0;start<targets.length;start+=20){
          const group=targets.slice(start,start+20);const history=await translationApi.history(base,document.parseRevision,signal,group.map(t=>t.chunkId));history.items.forEach(j=>jobs.set(j.jobId,j));
          // The history endpoint is bounded. Query omitted chunks separately instead of guessing they lack a translation.
          if(history.items.length===10)for(const target of group.filter(t=>!history.items.some(j=>j.chunkIds.includes(t.chunkId)))){
            const extra=await translationApi.history(base,document.parseRevision,signal,[target.chunkId]);extra.items.forEach(j=>jobs.set(j.jobId,j));
          }
        }
        documents.push({document,metadata:metadata!,targets,jobs:[...jobs.values()].sort((a,b)=>b.createdAt.localeCompare(a.createdAt))});
      }
      return {documents,unparsed:checklist!.documents.filter(d=>!d.parseRevision||!d.directoryRevision)};
    },refetchInterval:q=>q.state.data?.documents.some(d=>d.jobs.some(activeJob))?2000:false});
  return {...query,data:blocksView(query)||!checklist?undefined:query.data};
}
export function TranslationEvidence({caseId,roundId,data,evidence,fieldId,view}:{caseId:string;roundId?:string|null;data?:RoundTranslations;evidence:ReviewEvidence[];fieldId?:string;view?:'source'|'translation'}){
  const items=matchingTranslationEvidence(data,evidence,fieldId);
  if(!items.length)return <p className="muted">此项尚无可匹配的英文关键段落；请先核对字段来源。</p>;

  return <div className="checklist-evidence">{items.map(({d,t,segment})=>{
    const ref:ReviewEvidence={documentVersionId:d.document.id,parseRevision:d.document.parseRevision!,directoryRevision:d.document.directoryRevision,...(t.source.sourceNodeIds.length?{sourceNodeId:t.source.sourceNodeIds[0]}:{anchorId:t.source.anchorIds[0]})};
    const job=d.jobs.find(j=>j.chunkIds.includes(t.chunkId));
    const contextNotice=t.sourceWarnings?.includes('translation_context_incomplete')&&!segment?.reasonCodes.includes('translation_context_incomplete');
    const jobLabel=!job?'尚未生成译文':!(job.sourceCurrent??job.validity==='current')?'来源已变化，旧译文不用于当前字段':job.validity==='stale'&&job.sourceCurrent?'历史译文记录，来源与所选版本一致':({pending:'译文排队中',running:'正在翻译',ready:'翻译任务已完成',partial:'翻译部分未完成',failed:'翻译失败',canceled:'翻译已取消',stale:'翻译来源已过期'}[job.status]);
    return <article key={`${d.document.id}:${t.chunkId}`}><strong>{d.document.filename}</strong><div className={view?'checklist-reading':'checklist-bilingual'}>{view!=='source'&&<div><p>中文参考译文（未经人工核对）</p><p className="help-text">{jobLabel}{roundId?' · 所选轮次材料版本':''}</p>{job?.errorCode&&<p className="tone-warning">{translationReason(job.errorCode)}</p>}<p lang="zh-CN">{segment?.translatedText??'尚无可用译文'}</p>{segment?.status==='needs_review'&&<p className="tone-warning">译文需核对：{segment.reasonCodes.map(translationReason).join('；')}</p>}{contextNotice&&<p className="tone-warning">{translationReason('translation_context_incomplete')}</p>}{segment?.simulated&&<p>模拟译文，仅用于功能验证。</p>}{!t.available&&<p>{t.reasonCodes.map(translationReason).join('；')}</p>}</div>}{view!=='translation'&&<div><p>完整英文原文</p><p lang="en">{t.sourceText??'原文尚不可用'}</p>{(ref.anchorId||ref.sourceNodeId)&&<Link to={`${evidenceUrl(caseId,ref)}${roundId?`&round=${roundId}`:''}`}>定位原文</Link>}</div>}{view==='translation'&&(ref.anchorId||ref.sourceNodeId)&&<Link to={`${evidenceUrl(caseId,ref)}${roundId?`&round=${roundId}`:''}`}>定位原文</Link>}</div></article>;
  })}</div>;
}
export function TranslationPreparation({state,compact=false}:{state:ReviewState;compact?:boolean}){
  const checklist=useChecklist(state),query=useRoundTranslations(state,checklist.data),[busy,setBusy]=useState(false),[error,setError]=useState<unknown>(),[note,setNote]=useState('');
  const stopping=useRef(false),mounted=useRef(true);
  useEffect(()=>{mounted.current=true;return()=>{mounted.current=false;stopping.current=true;};},[]);
  const data=query.data,all=data?.documents.flatMap(d=>d.targets.map(t=>({d,t,segment:segmentFor(d,t)})))??[];
  const completed=all.filter(i=>i.segment?.translatedText),needsReview=completed.filter(i=>i.segment?.status==='needs_review');
  const pending=data?.documents.flatMap(d=>d.jobs.filter(activeJob).map(j=>({d,j})))??[];
  const generate=async()=>{
    if(busy)return;setBusy(true);setError(undefined);stopping.current=false;setNote('正在核对来源并准备翻译…');
    try{
      // Re-read metadata on explicit action. Refreshes only read; they never submit.
      const refreshed=await query.refetch();if(refreshed.error)throw refreshed.error;
      for(const d of refreshed.data?.documents??[]){
        if(!d.metadata.canCreate)continue;
        const missing=d.targets.filter(t=>t.available&&!segmentFor(d,t)&&!d.jobs.some(j=>j.chunkIds.includes(t.chunkId)&&(activeJob(j)||j.errorCode==='translation_call_unknown'||['failed','partial','canceled'].includes(j.status))));
        for(let start=0;start<missing.length;start+=20){
          if(stopping.current)break;
          const accepted=await translationApi.create(translationBase(state.caseId,d.document.id),{expectedRevision:d.metadata.caseRevision,parseRevision:d.document.parseRevision!,expectedDirectoryRevision:d.metadata.directoryRevision,
            ...(state.readOnly&&state.roundId?{referenceRoundId:state.roundId}:{}),chunkIds:missing.slice(start,start+20).map(t=>t.chunkId),idempotencyKey:newKey(),reason:'按本轮字段原文生成中文参考译文'});
          // Each accepted batch is durable. Navigation stops scheduling new batches, never loses accepted work.
          let job=await translationApi.get(translationBase(state.caseId,d.document.id),accepted.jobId);
          while(activeJob(job)&&!stopping.current){if(mounted.current){setNote(`正在翻译 ${d.document.filename}：${job.progress.completedSegments}/${job.progress.totalSegments} 段`);await query.refetch();}
            await new Promise(resolve=>setTimeout(resolve,1200));if(!stopping.current)job=await translationApi.get(translationBase(state.caseId,d.document.id),accepted.jobId);}
          if(job.errorCode==='translation_call_unknown')throw new Error('上次模型调用结果未知，请核对记录后再继续。');
        }
      }
      if(mounted.current)setNote(stopping.current?'已停止提交后续批次；已受理任务仍可查看或取消。':'本次批次处理结束，请查看缺失、失败及需核对段落。');
    }catch(e){if(mounted.current)setError(e);}finally{if(mounted.current){setBusy(false);await query.refetch();}}
  };
  const retry=async(d:TranslationDocument,j:DocumentTranslationView)=>{setError(undefined);try{await translationApi.create(translationBase(state.caseId,d.document.id),{expectedRevision:d.metadata.caseRevision,parseRevision:d.document.parseRevision!,expectedDirectoryRevision:d.metadata.directoryRevision,...(state.readOnly&&state.roundId?{referenceRoundId:state.roundId}:{}),chunkIds:j.chunkIds,...(j.fieldSources?{fieldSources:j.fieldSources}:{}),retryOf:j.jobId,idempotencyKey:newKey(),reason:'重试本轮未完成参考翻译'});await query.refetch();}catch(e){setError(e);}};
  return <section className="checklist-translation" aria-label="本轮中文参考译文"><strong>本轮关键段落中文译文</strong>
    <ErrorNotice error={checklist.error??query.error??error} retry={()=>{void checklist.refetch();void query.refetch();}}/>
    {(checklist.isPending||query.isPending)&&<Loading/>}{data&&<><p role="status">关键段落 {all.length} · 已有译文 {completed.length} · 尚无译文 {all.length-completed.length} · 自动检查提示 {needsReview.length}{data.unparsed.length?` · 尚未解析的文件 ${data.unparsed.length}`:''}</p>
      <p className="muted">已有译文均待人工核对。参考译文不改变审核结论，也不替代正式中文版材料。</p>
      {!all.length&&<p>尚无可定位的英文关键段落。请先完成材料解析，并核对字段候选或已确认事实的原文来源。</p>}
      <div className="review-loop-toolbar-actions"><Button disabled={busy||!data.documents.some(d=>d.metadata.canCreate)} onClick={()=>void generate()}>生成关键段落中文译文</Button><Button disabled={busy} onClick={()=>void query.refetch()}>刷新翻译状态</Button>{busy&&<Button onClick={()=>{stopping.current=true;}}>停止后续批次</Button>}</div>
      {note&&<p role="status">{note}</p>}{pending.map(({d,j})=><p key={j.jobId}>{d.document.filename}：{j.progress.completedSegments}/{j.progress.totalSegments} 段 {j.canCancel&&<Button size="small" onClick={()=>void translationApi.cancel(j.jobId).then(()=>query.refetch()).catch(setError)}>取消此任务</Button>}</p>)}
      {!data.documents.some(d=>d.metadata.canCreate)&&all.some(i=>!i.segment)&&<p>当前轮次或权限不允许生成新译文；已有译文仍可查看。锁定轮补译需单独授权，已完结案件保持只读。</p>}
      <details><summary>查看各文件的翻译范围与任务</summary>{data.documents.map(d=><div key={d.document.id}><strong>{d.document.filename}</strong>{d.targets.filter(t=>!t.available).map(t=><p key={t.chunkId}>{t.reasonCodes.map(translationReason).join('；')}</p>)}{d.jobs.map(j=><p key={j.jobId}>{j.progress.completedSegments}/{j.progress.totalSegments} 段{j.errorCode?` · ${translationReason(j.errorCode)}`:''}{j.canRetry&&<Button size="small" disabled={busy} onClick={()=>void retry(d,j)}>重试此任务</Button>}</p>)}</div>)}</details>
    </>}
  </section>;
}
