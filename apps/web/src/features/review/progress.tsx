import {processingProblem} from '../documents/processing-attention.ts';
import {roundQuery} from './round-controls.tsx';
import React from 'react';
import {useQueries,useQuery} from '@tanstack/react-query';
import {Link} from 'react-router';
import type {ReviewState} from '@hsbc/contracts/review';
import {api} from '../../api.ts';
import {useAuth} from '../../auth.tsx';
import {can} from '../identity/permissions.ts';
import type {Material} from '../materials/types.ts';
import type {ProcessingStatus} from '../documents/types.ts';
import {processingView} from '../documents/processing-presentation.ts';
import {blocksView,ErrorNotice} from '../../ui.tsx';
import {isReviewRunning,runStateLabels} from './presentation.ts';
export function useMaterialProcessing(caseId:string,materials:Material[]) {
  const {session}=useAuth();
  return useQueries({queries:materials.map(material=>({queryKey:['document-processing-summary',session.user?.accountId,caseId,material.id],enabled:can(material.allowed_actions,'case:read')||can(material.allowed_actions,'evidence:read'),queryFn:({signal}:{signal:AbortSignal})=>api<ProcessingStatus>(`/api/cases/${caseId}/documents/${material.id}/processing`,{signal}),refetchInterval:15000}))});
}
export function MaterialProcessing({material,processing,error,state,caseId}:{material:Material;processing?:ProcessingStatus;error?:unknown;state?:ReviewState;caseId:string}) {
  const view=processingView(material.format,processing?.documentId===material.id?processing:undefined);
  const linked=state?.objects.filter(o=>o.validity==='current'&&o.evidence.some(e=>e.documentVersionId===material.id&&e.parseRevision===processing?.parseRevision))??[];
  const facts=state?.facts.filter(f=>f.evidence.some(e=>e.documentVersionId===material.id))??[];
  return <div className="material-processing"><div>登记：已成功</div><div>读取：{view.read}</div><div>预览：{view.preview}</div><div>提取：{view.extraction}</div>{error?<ErrorNotice error={error}/>:null}
    {state&&<div>确认：{linked.length?`已关联 ${linked.length} 个对象`:'归属待确认'} · {facts.filter(f=>f.validity==='current'&&f.state!=='pending').length} 项已确认事实{facts.some(f=>f.validity==='stale'||f.state==='pending')?' · 有待重新核对项':''}</div>}
    <Link to={`/cases/${caseId}/review?document=${material.id}${state?.roundId?`&round=${state.roundId}`:state?.legacyView?'&round=legacy':''}`}>{material.format==='docx'?'查看文字与核对':'查看提取与核对'}</Link>
    <details><summary>处理记录</summary><div className="review-loop-code">解析记录：{processing?.parseRevision??'尚无'}<br/>处理状态：{processing?.status??material.parseStatus}<br/>诊断编号：{processing?.errorCode??processing?.presentation?.extraction?.errorCode??processing?.presentation?.preview?.errorCode??'无'}</div></details>
  </div>;
}
export function CaseProgress({state}:{state:ReviewState}) {
  const {session}=useAuth();
  const materials=useQuery({queryKey:['materials',state.caseId,state.roundId??(state.legacyView?'legacy':'current')],queryFn:({signal})=>api<{items:Material[]}>(`/api/cases/${state.caseId}/materials${roundQuery(state.roundId??(state.legacyView?'legacy':null))}`,{signal}),enabled:!!session.user});
  const rows=blocksView(materials)?[]:materials.data?.items??[];
  const queries=useMaterialProcessing(state.caseId,rows);
  const p=queries.flatMap((q,i)=>!blocksView(q)&&q.data?.documentId===rows[i]?.id?[q.data]:[]);
  const views=queries.flatMap((q,i)=>!blocksView(q)&&q.data?.documentId===rows[i]?.id?[processingView(rows[i].format,q.data)]:[]);
  const current=state.runs.find(r=>r.validity==='current');
  return <div className="case-processing-summary" aria-label="案件处理进度">
    <div><strong>上传登记</strong><span>{materials.isPending?'正在查询':blocksView(materials)?'登记状态暂不可查询':`${rows.length} 份已登记`}</span>{materials.error?<ErrorNotice error={materials.error}/>:null}<Link to={`/cases/${state.caseId}/materials${state.roundId?`?round=${state.roundId}`:state.legacyView?'?round=legacy':''}`}>查看材料</Link></div>
    <div><strong>读取与提取</strong><span>{p.length} / {rows.length} 份状态已查询</span><span>原文：{views.filter(v=>v.read==='Word 文字结构可读'||v.read==='已生成原件页面').length} 份可读；预览：{views.filter(v=>['原件页面可查看','页面预览可用','页面预览部分可用'].includes(v.preview)).length} 份可用</span><span>提取：{views.filter(v=>v.extraction==='字段提取未开始').length} 份未开始 · {views.filter(v=>['字段提取中','字段提取等待原文处理'].includes(v.extraction)).length} 份处理中</span><span>{p.filter(v=>v.presentation?.sourceOnly).length} 份不支持自动提取，需人工整理</span><span>文件处理：{p.filter(v=>v.status!=='failed'&&v.presentation?.extraction?.status!=='failed'&&processingProblem(v)).length} 份有处理提示 · {p.filter(v=>v.status==='failed'||v.presentation?.extraction?.status==='failed').length} 份处理失败</span>{queries.some(q=>q.error)&&<span role="status">部分状态查询失败，请在材料列表查看原因</span>}<span className="muted">文件处理完成不代表字段齐全；预览限制见材料详情</span></div>
    <div><strong>归属与事实</strong><span>{state.materialCount??new Set(state.materials.filter(m=>m.operation==='adopt').map(m=>m.documentVersionId)).size} 份本轮材料 · {state.objects.filter(o=>o.validity==='current').length} 个已确认对象</span><span>{state.facts.filter(f=>f.state==='pending'||f.validity==='stale').length} 项事实待核对</span><Link to={`/cases/${state.caseId}/review?mode=business&tab=checklist${state.roundId?`&round=${state.roundId}`:state.legacyView?'&round=legacy':''}`}>核对字段</Link></div>
    <div><strong>规则检查</strong><span>{current?(runStateLabels[current.state]??current.state):state.runs.length?'旧结果已失效 · 等待重审':'尚未开始'}</span><span>{current?.state==='ready'?`${current.results.length} 项检查结果`:'核对材料与事实后手动开始'}</span><Link to={`/cases/${state.caseId}/review?mode=business&tab=results${state.roundId?`&round=${state.roundId}`:state.legacyView?'&round=legacy':''}`}>{isReviewRunning(current?.state)?'查看执行状态':'查看结果与变化'}</Link><span className="muted">检查完成不等于案件通过或独立复核完成</span></div>
  </div>;
}
