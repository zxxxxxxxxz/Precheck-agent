import {analysisJobsForRun,comparisonPair,comparisonUnavailableReason,quotedSegments} from './result-presentation.ts';
import {visibleSelection} from '../review/field-desk-presentation.ts';
import React,{useEffect,useRef,useState} from 'react';
import {Button,Select,Table,Tag} from 'antd';
import {useQuery} from '@tanstack/react-query';
import type {AnalysisEvidence,AnalysisJob,AnalysisState,ComparisonCommand,MaterialChange,SemanticItem} from '@hsbc/contracts/review-delivery';
import {api,ApiError,newKey,queryClient} from '../../api.ts';
import {useAuth} from '../../auth.tsx';
import {ErrorNotice,Loading,blocksView} from '../../ui.tsx';
import {formatTime} from '../../shared/format.ts';
import {EvidenceLinks} from '../review/evidence-links.tsx';
import './review-delivery.css';

const outcomes={consistent:'一致',different:'存在差异',insufficient:'证据不足',manual:'需要人工判断'};
const changes={unchanged:'文件内容相同',format:'格式变化',equivalent:'表述改变，含义一致',substantive:'实质变化',unknown:'无法可靠判断',added:'新增材料',removed:'本轮缺少材料'};
const states={pending:'排队中',running:'分析中',ready:'分析完成',partial:'部分未完成',failed:'分析失败',canceled:'已取消'};
const runStates:Record<string,string>={ready:'检查完成',failed:'检查失败',pending:'等待检查',running:'检查中',canceled:'已取消',missing:'暂无结果'};
const validity={current:'当前结果',history:'历史结果',stale:'来源或权限已变化'};
const analysisFailure=(code:string)=>code==='review_assist_quote_mismatch'?'模型引用与对应原文不一致，未采用该结论。请核对原文，或按允许操作重试。':code==='review_assist_document_not_cited'?'模型未提供所有相关文件的原文依据，此项尚未完成。请核对缺少依据的文件。':code==='review_assist_call_unknown'?'模型请求已发出，但尚无可核验回执。请联系管理员核对后再决定是否重试。':code==='review_assist_unverifiable'||code==='review_assist_invalid_output'?'模型返回的依据或结论未通过校验，此项仍未完成，不能据此认定一致或没有变化。':code.includes('budget')?'完整原文或调用次数超出本次分析上限，此项尚未完成。':code.includes('stale')?'材料、结果或权限已经变化，请重新核对当前来源。':'辅助分析尚未完成，请查看原文和程序检查，按允许操作重试或人工核对。';
export const analysisReason=(reason:string)=>{const code=/^辅助分析未完成（([^）]+)）/.exec(reason)?.[1];return code?analysisFailure(code):reason;};
export function AnalysisPanel({caseId,runId,kind}:{caseId:string;runId:string;kind:'semantic'|'comparison'}){
  return <AnalysisScope key={`${caseId}:${runId}:${kind}`} caseId={caseId} runId={runId} kind={kind}/>;
}
export function AnalysisEvidenceView({caseId,items,citations=[]}:{caseId:string;items:AnalysisEvidence[];citations?:Array<{evidenceId:string;quote:string}>}){
  return <div className="delivery-evidence">{items.length?items.map(e=><article key={e.id}><h4>{e.filename}</h4><EvidenceLinks caseId={caseId} evidence={e.locations} roundId={e.roundId??null} names={{[e.documentId]:e.filename}}/>
    <p className="delivery-reference">原文版本：{e.documentId.slice(0,8)} · 目录 {e.directoryRevision}</p><div className="delivery-original">{quotedSegments(e.text,citations.filter(c=>c.evidenceId===e.id).map(c=>c.quote)).map((part,index)=>part.marked?<mark key={index}>{part.text}</mark>:<React.Fragment key={index}>{part.text}</React.Fragment>)}</div>
    {e.warnings.length>0&&<p className="tone-warning">原文覆盖限制：{e.warnings.join('；')}</p>}
    {e.sourceNotes?.map(note=><p className="tone-warning" key={note}>{note}</p>)}
    {e.referenceTranslations.map(t=><details key={t.jobId}><summary>已有中文参考译文</summary><p>{t.status}</p><div className="delivery-original">{t.text}</div></details>)}
    {!e.referenceTranslations.length&&<p className="muted">此段尚无已保存的中文参考译文；请在材料处理阶段使用现有翻译入口。</p>}
  </article>):<p>尚无完整可定位的原文依据。</p>}</div>;
}
function AnalysisScope({caseId,runId,kind}:{caseId:string;runId:string;kind:'semantic'|'comparison'}){
  const {session}=useAuth(),base=`/api/cases/${caseId}/review-delivery/analysis`,alive=useRef(true);
  useEffect(()=>{alive.current=true;return ()=>{alive.current=false;};},[]);
  const [selected,setSelected]=useState<string>(),[busy,setBusy]=useState(false),[error,setError]=useState<unknown>();
  const [object,setObject]=useState<string>(),[document,setDocument]=useState<string>(),[outcome,setOutcome]=useState<string>(),[scope,setScope]=useState('all');
  const [pairs,setPairs]=useState<ComparisonCommand['objectPairs']>([]),[groups,setGroups]=useState<ComparisonCommand['materialGroups']>([]);
  const [before,setBefore]=useState<string[]>([]),[after,setAfter]=useState<string[]>([]),[reason,setReason]=useState('');
  const pending=useRef<{url:string;body:unknown}|undefined>(undefined);
  const query=useQuery({queryKey:['review-analysis-state',session.user?.accountId,caseId],queryFn:({signal})=>api<AnalysisState>(base,{signal}),refetchInterval:10000});
  const state=!blocksView(query)&&query.data?.caseId===caseId?query.data:undefined,id=selected??analysisJobsForRun(state,runId,kind)[0]?.id;
  const record=useQuery({queryKey:['review-analysis',session.user?.accountId,caseId,id],enabled:!!id,queryFn:({signal})=>api<AnalysisJob>(`${base}/${id}`,{signal}),refetchInterval:q=>q.state.data&&['pending','running'].includes(q.state.data.state)?2000:15000});
  useEffect(()=>{setObject(undefined);setDocument(undefined);setOutcome(undefined);},[id]);
  const pair=comparisonPair(state,runId);
  const job=!blocksView(record)&&record.data&&record.data.id===id&&record.data.caseId===caseId&&analysisJobsForRun(state,runId,kind).some(j=>j.id===id)?record.data:undefined;
  const comparison=pair&&state?.comparison?.afterRoundId===pair.after.roundId&&state.comparison.beforeRoundId===pair.before.roundId?state.comparison:undefined;
  const initializedMapping=useRef<string|undefined>(undefined);
  useEffect(()=>{if(!comparison)return;const key=`${comparison.beforeRoundId}:${comparison.afterRoundId}`;if(initializedMapping.current===key)return;
    initializedMapping.current=key;setPairs(comparison.objectPairs);setGroups(comparison.materialGroups);
  },[comparison]);
  const send=async(url:string,body:unknown)=>{
    if(busy)return;setBusy(true);setError(undefined);pending.current??={url,body};
    try{const created=await api<{id:string}>(pending.current.url,{method:'POST',body:pending.current.body});pending.current=undefined;if(!alive.current)return;setSelected(created.id);
      await queryClient.invalidateQueries({queryKey:['review-analysis-state']});await queryClient.invalidateQueries({queryKey:['review-analysis']});
    }catch(e){if(alive.current){setError(e);if(e instanceof ApiError&&e.status>0)pending.current=undefined;}}finally{if(alive.current)setBusy(false);}
  };
  const create=()=>{if(!state)return;const command={expectedRevision:state.revision,idempotencyKey:newKey()};
    void send(`${base}/${kind}`,kind==='semantic'?{...command,runId}:{...command,beforeRoundId:comparison?.beforeRoundId,afterRoundId:comparison?.afterRoundId,objectPairs:pairs,materialGroups:groups});};
  const ev=(ids:string[])=>job?.body.evidence.filter(e=>ids.includes(e.id))??[];
  const semantic=job?.body.items.filter(i=>(scope==='all'||scope==='first_batch'&&i.kind!=='outside_scope'||scope==='model'&&i.method==='model')&&(!object||i.objectId===object)&&(!document||ev(i.evidenceIds).some(e=>e.documentId===document))&&(!outcome||i.outcome===outcome))??[];
  const differences=job?.body.changes.filter(i=>(!object||i.objectIds.includes(object))&&(!document||[...i.before,...i.after].includes(document))&&(!outcome||i.classification===outcome))??[];
  const labels=new Map(job?.body.evidence.map(e=>[e.documentId,e.filename]));
  return <section className="review-delivery" aria-label={kind==='semantic'?'语义核对':'两轮智能比较'}>
    <ErrorNotice error={query.error} retry={()=>void query.refetch()}/>{query.isPending?<Loading/>:!state?null:<>
      <p>辅助分析与程序检查、人工决定分别保留；分析不会修改事实、关闭问题或批准案件。</p>
      {!state.modelEnabled&&<p role="status" className="tone-warning">私有语义分析未启用。可保存检查清单或文字／结构比较，未完成的语义判断会明确标示。</p>}
      {kind==='comparison'&&<><p>{pair?`${pair.before.label}（${runStates[pair.before.state]??'尚未完成'}）→ ${pair.after.label}（${runStates[pair.after.state]??'尚未完成'}）`:comparisonUnavailableReason(state,runId)}</p>{pair&&!comparison&&<p>当前仅展示所选轮次已有的比较记录；暂无可生成的新比较。</p>}
        {comparison&&<details><summary>确认对象与材料对应关系</summary><p>仅根据已确认对象、材料用途和版本关系匹配。文件名相同不代表同一材料；共用材料、一对多或多对一可在下方确认。</p>
          {comparison.beforeObjects.map(o=><label className="delivery-mapping" key={o.id}>{o.label} · {o.id.slice(0,8)}<Select aria-label={`对应对象 ${o.id}`} allowClear placeholder="尚未人工对应" value={pairs.find(p=>p.before===o.id)?.after} disabled={busy||!!pending.current} onChange={value=>setPairs(p=>[...p.filter(x=>x.before!==o.id),...(value?[{before:o.id,after:value}]:[])])} options={comparison.afterObjects.filter(x=>x.role===o.role).map(x=>({value:x.id,label:`${x.label} · ${x.id.slice(0,8)}`}))}/></label>)}
          {comparison.matches.map(m=><p key={m.id}>{m.before.map(id=>comparison.documents.find(d=>d.id===id)?.label??id.slice(0,8)).join('、')||'无'} → {m.after.map(id=>comparison.documents.find(d=>d.id===id)?.label??id.slice(0,8)).join('、')||'无'}：{m.basis}</p>)}
          <div className="delivery-toolbar"><label>上一轮材料<Select aria-label="人工对应上一轮材料" mode="multiple" value={before} onChange={setBefore} disabled={busy||!!pending.current} options={comparison.documents.filter(d=>d.side==='before'&&!groups.some(g=>g.before.includes(d.id))).map(d=>({value:d.id,label:d.label}))}/></label><label>本轮材料<Select aria-label="人工对应本轮材料" mode="multiple" value={after} onChange={setAfter} disabled={busy||!!pending.current} options={comparison.documents.filter(d=>d.side==='after'&&!groups.some(g=>g.after.includes(d.id))).map(d=>({value:d.id,label:d.label}))}/></label></div>
          <label>对应依据<textarea aria-label="材料对应依据" value={reason} onChange={e=>setReason(e.target.value)} disabled={busy||!!pending.current} maxLength={1000}/></label>
          <Button disabled={busy||!!pending.current||!reason.trim()||!before.length&&!after.length} onClick={()=>{setGroups(g=>[...g,{before,after,reason:reason.trim()}]);setBefore([]);setAfter([]);setReason('');}}>加入人工确认</Button>
          {groups.map((g,i)=><p key={i}>{g.before.length} 份 → {g.after.length} 份：{g.reason} <Button disabled={busy||!!pending.current} onClick={()=>setGroups(x=>x.filter((_,n)=>n!==i))}>移除</Button></p>)}
        </details>}</>}
      <div className="delivery-toolbar">{state.allowedActions.includes('review:analyze')&&<Button type="primary" loading={busy} disabled={kind==='comparison'&&!comparison} onClick={create}>{pending.current?'核对上次请求':kind==='semantic'?'生成语义核对':'比较最近两轮'}</Button>}
        <label>历史分析<Select aria-label="历史分析结果" value={id} disabled={busy} onChange={setSelected} options={analysisJobsForRun(state,runId,kind).map(j=>({value:j.id,label:`${formatTime(j.createdAt)} · ${states[j.state]}`}))}/></label></div>
      {!state.allowedActions.includes('review:analyze')&&<p>当前为只读查看；生成分析需要独立的辅助分析权限及本案经办资格。</p>}
      <ErrorNotice error={error}/><ErrorNotice error={record.error} retry={()=>void record.refetch()}/>
      {job&&<><div className="delivery-toolbar"><Tag>{states[job.state]}</Tag><Tag>{validity[job.validity]}</Tag><span>{job.body.runs.map(r=>r.label).join(' → ')} · {formatTime(job.createdAt)}</span>
        {job.canCancel&&<Button disabled={busy} onClick={()=>void send(`${base}/${job.id}/cancel`,{})}>取消分析</Button>}
        {job.canRetry&&<Button disabled={busy||!!pending.current} onClick={()=>void send(`${base}/${job.id}/retry`,{expectedRevision:state.revision,idempotencyKey:newKey()})}>重试失败或中断项</Button>}
        {job.canContinue&&<Button loading={busy} disabled={!!pending.current} onClick={()=>void send(`${base}/${job.id}/continue`,{expectedRevision:state.revision,idempotencyKey:newKey()})}>{kind==='comparison'?'继续比较剩余材料':'继续核对剩余项目'}</Button>}
        {job.nextJobId&&<Button disabled={busy||!!pending.current} onClick={()=>setSelected(job.nextJobId!)}>查看后续分析</Button>}</div>
        {job.progress&&<p role="status" aria-live="polite">共 {job.progress.total} {kind==='comparison'?'组':'项'}：已完成 {job.progress.complete}，等待处理 {job.progress.pending}，待继续 {job.progress.deferred}，失败 {job.progress.failed}，缺少依据或暂不可分析 {job.progress.unavailable}。</p>}
        {!!job.progress?.deferred&&<p className="muted">每次最多处理 {job.progress.batchSize} 项，已完成结果会保留。{job.canContinue?'点击继续可处理下一批。':job.canCancel?'本批完成后可继续处理剩余项目。':job.canRetry?'可先重试失败或中断项。':'请核对当前记录状态及操作权限。'}</p>}
        {job.validity==='history'&&<p className="muted">历史轮仅供回查，不能生成、重试或继续分析。请切换到当前轮处理。</p>}
        {job.validity==='stale'&&<p className="tone-warning">此记录保留用于回查，不能作为当前有效结果。请核对来源后重新生成。</p>}
        {job.simulated&&<p className="tone-warning">本记录包含模拟模型结果，仅用于工程验证。</p>}{job.errorCode&&<p>{analysisFailure(job.errorCode)}</p>}
        {job.body.limitations.map((text,i)=><p className="tone-warning" key={i}>{text}</p>)}
        <div className="delivery-toolbar">{kind==='semantic'&&<label>检查范围<Select aria-label="检查范围筛选" value={scope} onChange={setScope} options={[{value:'all',label:'完整检查清单'},{value:'first_batch',label:'首批语义范围'},{value:'model',label:'已有模型建议'}]}/></label>}<label>对象<Select aria-label="分析对象筛选" allowClear value={object} onChange={setObject} options={[...new Map([...job.body.items.map(i=>[i.objectId,i.objectLabel] as const),...job.body.changes.flatMap(i=>i.objectIds.map(id=>[id,[...(comparison?.beforeObjects??[]),...(comparison?.afterObjects??[])].find(o=>o.id===id)?.label??id.slice(0,8)] as const))]).entries()].map(([value,label])=>({value,label}))}/></label>
          <label>文件<Select aria-label="分析文件筛选" allowClear value={document} onChange={setDocument} options={[...labels.entries()].map(([value,label])=>({value,label}))}/></label>
          <label>结果类型<Select aria-label="分析结果筛选" allowClear value={outcome} onChange={setOutcome} options={Object.entries(kind==='semantic'?outcomes:changes).map(([value,label])=>({value,label}))}/></label></div>
        {kind==='semantic'?<><p>完整检查清单 {job.body.items.length} 项 · 当前显示 {semantic.length} 项</p><Table<SemanticItem> rowKey="id" dataSource={semantic} scroll={{x:950}} pagination={{pageSize:10,showSizeChanger:false}} expandable={{expandedRowRender:i=><><p>{i.ruleText}</p>{i.ruleSources.map(s=><p className="delivery-reference" key={s}>{s}</p>)}{i.limitations.map((s,n)=><p key={n}>{s}</p>)}{i.citations.map((c,n)=><blockquote key={n}>{c.quote}</blockquote>)}<AnalysisEvidenceView caseId={caseId} items={ev(i.evidenceIds)}/></>}} columns={[
          {title:'对象／检查项',key:'rule',width:300,render:(_,i)=><>{i.objectLabel}<br/><strong>{i.ruleLabel}</strong></>},
          {title:'辅助结果',key:'outcome',width:180,render:(_,i)=><>{i.kind==='outside_scope'?'未纳入首批':i.deferredReason==='batch_limit'?'待继续分析':i.state==='pending'?'等待分析':outcomes[i.outcome]}<div className="muted">{i.method==='model'?'模型建议':i.method==='program'?'程序检查':'尚未分析'}</div></>},
          {title:'理由与限制',dataIndex:'reason',render:analysisReason},
          {title:'原程序检查',dataIndex:'originalOutcome',width:130,render:v=>({pass:'未发现差异',fail:'发现差异',blocked:'待补充／人工核对',not_applicable:'不适用'}[v as string]??v)},
        ]}/></>:<><p role="status">变化摘要：{Object.entries(changes).map(([key,label])=>({label,count:job.body.changes.filter(c=>c.classification===key).length})).filter(x=>x.count).map(x=>`${x.label} ${x.count} 组`).join('；')||'没有已覆盖的材料组'}。未完成 {job.body.changes.filter(c=>c.state!=='complete').length} 组。</p><p>材料组 {job.body.changes.length} 组 · 当前显示 {differences.length} 组</p><ComparisonWorkspace key={job.id} caseId={caseId} job={job} items={differences} objectLabels={new Map([...(comparison?.beforeObjects??[]),...(comparison?.afterObjects??[])].map(o=>[o.id,o.label]))}/><details><summary>两轮实际检查和问题记录</summary><p>文字修改不等于问题已解决。以下保留实际检查结论及人工处置记录。</p>{job.body.resultChanges.map((r,i)=><article key={i}><strong>{r.ruleLabel??r.ruleId}</strong><p>{r.objectLabels?.join(' → ')}</p><p>{({pass:'未发现差异',fail:'发现差异',blocked:'待补充／人工核对',not_applicable:'不适用'}[r.beforeOutcome??'']??'未完成')} → {({pass:'未发现差异',fail:'发现差异',blocked:'待补充／人工核对',not_applicable:'不适用'}[r.afterOutcome??'']??'未完成')}：{r.reason}</p><p>旧问题：{r.beforeIssues.map(x=>`${x.id.slice(0,8)} ${{open:'待处理',acknowledged:'已记录',resolved:'已关闭'}[x.status]??'待核对'}`).join('、')||'无记录'}；本轮问题：{r.afterIssues.map(x=>`${x.id.slice(0,8)} ${{open:'待处理',acknowledged:'已记录',resolved:'已关闭'}[x.status]??'待核对'}`).join('、')||'无记录'}</p></article>)}</details></>}
      </>}
    </>}
  </section>;
}

function ComparisonWorkspace({caseId,job,items,objectLabels}:{caseId:string;job:AnalysisJob;items:MaterialChange[];objectLabels:Map<string,string>}) {
  const [selectedId,setSelectedId]=useState<string>(),selected=visibleSelection(items,selectedId);
  const labels=new Map(job.body.evidence.map(e=>[e.documentId,e.filename]));
  const filenames=(ids:string[])=>ids.map(id=>`${labels.get(id)??'材料'} · ${id.slice(0,6)}`).join('、')||'无对应材料';
  const evidence=(ids:string[])=>job.body.evidence.filter(e=>ids.includes(e.id));
  const status=(i:MaterialChange)=>i.deferredReason==='batch_limit'?'待继续比较':i.state==='complete'?changes[i.classification]:{pending:'等待比较',failed:'比较失败',unavailable:'无法比较'}[i.state];
  return <div className="comparison-workspace"><nav className="comparison-files" aria-label="选择比较材料组"><h3>材料对应关系</h3>{items.map(i=><button key={i.id} type="button" aria-current={selected?.id===i.id?'true':undefined} onClick={()=>setSelectedId(i.id)}><strong>{filenames(i.after.length?i.after:i.before)}</strong><span>{status(i)}</span></button>)}{!items.length&&<p>没有匹配材料组，请调整筛选。尚未覆盖的材料不能据此视为无变化。</p>}</nav><section className="comparison-detail" aria-label="材料变化详情">{selected?<><header><h3>{status(selected)}</h3><p>{job.body.runs.map(r=>r.label).join(' → ')}</p></header><p>上一轮：{filenames(selected.before)}</p><p>本轮：{filenames(selected.after)}</p><p>匹配依据：{selected.basis}{selected.confirmed?' · 已人工确认对应':''}</p><p>{analysisReason(selected.reason)}</p><p>关联对象：{selected.objectIds.map(id=>`${objectLabels.get(id)??job.body.items.find(i=>i.objectId===id)?.objectLabel??'对象'} · ${id.slice(0,8)}`).join('、')||'未记录对象归属'}</p>{selected.simulated&&<p className="tone-warning">此项包含模拟建议，仅用于功能验证。</p>}{selected.limitations.map((v,n)=><p className="tone-warning" key={n}>{v}</p>)}<div className="comparison-impact"><strong>变化与审查影响</strong><p>{analysisReason(selected.reason)}</p><p>关联检查：{selected.affectedRuleIds.map(id=>job.body.resultChanges.find(r=>r.ruleId===id)?.ruleLabel??id).join('、')||'尚无已记录的影响判断'}</p></div><p className="help-text">高亮为已有分析引用的原文片段；没有可靠引用时保留完整段落，不推断逐字修改。</p><div className="delivery-compare"><div><h4>上一轮原文</h4><AnalysisEvidenceView caseId={caseId} items={evidence(selected.beforeEvidenceIds)} citations={selected.citations}/></div><div><h4>本轮原文</h4><AnalysisEvidenceView caseId={caseId} items={evidence(selected.afterEvidenceIds)} citations={selected.citations}/></div></div><details><summary>变化依据与规则关联</summary><p>可能受影响的规则：{selected.affectedRuleIds.join('、')||'尚未取得规则关联'}</p><p>原文结构变化：{selected.rawChanges.map(c=>c.kind).join('、')||'暂无可核验记录'}</p>{selected.citations.map((c,n)=><blockquote key={n}>{c.quote}</blockquote>)}</details></>:<p>选择材料组，查看实际比较范围和前后原文。</p>}</section></div>;
}
