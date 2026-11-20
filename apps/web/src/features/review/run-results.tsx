import {CrossFileReport} from './cross-file-checks.tsx';
import type {MailDraft} from '@hsbc/contracts/review-delivery';
import {ResultOverview,useResultAnalysis} from '../review-delivery/result-overview.tsx';
import {comparisonPair,comparisonUnavailableReason} from '../review-delivery/result-presentation.ts';
import {SignatureInformationSummaryView} from './signature-information-summary.tsx';
import {TranslationPreparation,TranslationEvidence,useChecklist,useRoundTranslations} from './checklist-translations.tsx';
import {AnalysisPanel} from '../review-delivery/analysis-panel.tsx';
import {MailPanel} from '../review-delivery/mail-panel.tsx';
import {roundQuery} from './round-controls.tsx';
import {GUARANTEE_LABELS} from '@hsbc/contracts/mixed-guarantee';
import React,{useState,useEffect,useRef} from 'react';
import {Button,Select,Table,Tag} from 'antd';
import {useQuery} from '@tanstack/react-query';
import {Link,useSearchParams} from 'react-router';
import type {ReviewFact,ReviewRun,ReviewState} from '@hsbc/contracts/review';
import {api} from '../../api.ts';
import {useAuth} from '../../auth.tsx';
import {formatTime} from '../../shared/format.ts';
import {Blank,blocksView,ErrorNotice} from '../../ui.tsx';
import type {Material} from '../materials/types.ts';
import {EvidenceLinks} from './evidence-links.tsx';
import {evidenceUrl,factStateLabels,readableValue,reviewReason,runStateLabels} from './presentation.ts';
import {compareResults,factOrigin,objectLabel,resultCategory,resultLabel,resultSources,snapshotChanges,type RunReplay,type ReviewResult} from './workbench-presentation.ts';

function FactTrace({fact,state}:{fact:ReviewFact;state:ReviewState}) {
  const origin=factOrigin(fact,state.factRecords);
  return <div><strong>{origin.label}</strong><div>{origin.confirmation} · {factStateLabels[fact.state]}</div><details><summary>来源与确认记录</summary>{fact.candidateRef&&<p className="review-loop-code">候选编号：{fact.candidateRef.candidateId}<br/>提取记录：{fact.candidateRef.observationId}</p>}{origin.record?<p>确认人：{origin.record.confirmedByName??origin.record.confirmedBy}<br/>{formatTime(origin.record.confirmedAt)} · r{origin.record.caseRevision} · 事实 v{fact.version}</p>:fact.automaticAdoption?<p>系统按原文依据及字段校验采用；本次检查保留采用值和来源版本。</p>:<p>此版本的确认时间和来源记录不足，不能补推处理人或时间。</p>}{fact.version>1&&<p>本行显示更正后的版本；旧版本保留在历史检查快照中。</p>}</details></div>;
}
function RuleText({configuration,id}:{configuration:ReviewState['configuration'];id:string}) {
  const rule=configuration?.rules.find(r=>r.id===id);
  return <div><strong>{rule?.label??id}</strong>{rule?.description&&<p className="review-loop-value">{rule.description}</p>}{rule?.sourceReferences.length? <details><summary>查看规则要求</summary>{rule.sourceReferences.map(s=><div className="review-loop-code" key={s}>{s}</div>)}</details>:!rule&&<div className="muted">历史规则说明未取得</div>}</div>;
}
function Sources({caseId,sources,names}:{caseId:string;sources:ReturnType<typeof resultSources>;names:Record<string,string>}) {
  const [params]=useSearchParams(),round=params.get('round');
  const scoped=(url:string)=>round?url+(url.includes('?')?'&':'?')+'round='+encodeURIComponent(round):url;
  return <div className="review-result-sources">{sources.direct.length>0&&<><span className="muted">本项字段依据</span><EvidenceLinks caseId={caseId} evidence={sources.direct} names={names}/></>}
    {sources.documents.map(m=><div key={`${m.documentVersionId}:${m.logicalDocumentId}`}><Link to={scoped(m.parseRevision?evidenceUrl(caseId,{...m,parseRevision:m.parseRevision}):`/cases/${caseId}/materials`)}>{names[m.documentVersionId]??`材料 ${m.documentVersionId.slice(0,8)}`} · 材料记录</Link><div className="muted">文件关联不等于具体字段判断依据</div></div>)}
    {sources.related.length>0&&<details><summary>关联依据 {sources.related.length} 处</summary><p className="muted">对象或其他关联依据，不能单独证明本项字段判断。</p><EvidenceLinks caseId={caseId} evidence={sources.related} names={names}/></details>}
    {sources.unlocated.length>0&&<details><summary>其他记录 {sources.unlocated.length} 项（无原文定位）</summary><p>下列为系统输入、对象关联或无法定位的证据标识。</p>{sources.unlocated.map(id=><div className="review-loop-code" key={id}>{id}</div>)}</details>}
    {!sources.direct.length&&!sources.documents.length&&<div className="muted">未记录可直接支持本项判断的原文</div>}
  </div>;
}
function ResultTranslation({state,sources}:{state:ReviewState;sources:ReturnType<typeof resultSources>}){
  const checklist=useChecklist(state),translations=useRoundTranslations(state,checklist.data);
  return <div className="checklist-detail"><ErrorNotice error={checklist.error??translations.error} retry={()=>{void checklist.refetch();void translations.refetch();}}/>
    {translations.isPending?<p role="status">正在读取本项原文和参考译文…</p>:<TranslationEvidence caseId={state.caseId} roundId={state.roundId} data={translations.data} evidence={sources.direct}/>}</div>;
}
export function RunResults({state,canReadEvidence,presentation='checks',afterMail}:{state:ReviewState;canReadEvidence:boolean;presentation?:'checks'|'report';afterMail?:React.ReactNode|((run:Pick<ReviewRun,'id'|'snapshotHash'>)=>React.ReactNode)}) {
  const {session}=useAuth();const [runId,setRunId]=useState<string>();const run=state.runs.find(r=>r.id===runId)??state.runs[0];
  const [businessType,setBusinessType]=useState<string>();const [scope,setScope]=useState<string>();const [document,setDocument]=useState<string>();const [category,setCategory]=useState<string>();
  const [changeKind,setChangeKind]=useState<string>();const [page,setPage]=useState(1);const [previousId,setPreviousId]=useState<string>();
  const [mailDraft,setMailDraft]=useState<MailDraft>();
  const analysis=useResultAnalysis(state.caseId,canReadEvidence&&presentation==='report');
  const pair=run?comparisonPair(analysis.data,run.id):undefined;
  const [comparisonOpen,setComparisonOpen]=useState(false),comparisonRef=useRef<HTMLDetailsElement>(null);
  const before=state.runs.find(r=>r.id===previousId&&r.id!==run?.id)??state.runs[state.runs.findIndex(r=>r.id===run?.id)+1];
  const useReplay=(selected:ReviewRun|undefined)=>useQuery({queryKey:['review-run',session.user?.accountId,state.caseId,selected?.id,selected?.state,selected?.validity],enabled:!!selected&&canReadEvidence,queryFn:({signal})=>api<RunReplay>(`/api/cases/${state.caseId}/review/runs/${selected!.id}`,{signal})});
  const replay=useReplay(run),prior=useReplay(before);
  const valid=(q:typeof replay,r:ReviewRun|undefined)=>r&&!blocksView(q)&&q.data?.id===r.id&&q.data.snapshotHash===r.snapshotHash?q.data:undefined;
  const data=valid(replay,run),old=valid(prior,before),snapshot=data?.snapshot;
  const registered=useQuery({queryKey:['materials',state.caseId,state.roundId??(state.legacyView?'legacy':'current')],queryFn:({signal})=>api<{items:Material[]}>(`/api/cases/${state.caseId}/materials${roundQuery(state.roundId??(state.legacyView?'legacy':null))}`,{signal}),enabled:canReadEvidence});
  const names=Object.fromEntries((blocksView(registered)?[]:registered.data?.items??[]).map(m=>[m.id,m.filename]));
  const crossChecks=[...new Map((snapshot?.crossFileChecklist??[]).flatMap(row=>row.crossChecks??[]).map(check=>[check.id,check])).values()];
  const facts=snapshot?.facts??[],objects=snapshot?.objects??[],materials=snapshot?.materials??[];
  const configuration=data?.configuration??(run?.configurationReleaseId===state.configurationReleaseId?state.configuration:null);
  const sources=(r:ReviewResult)=>resultSources(r,facts,objects,materials,configuration?.rules.find(rule=>rule.id===r.ruleId)?.inputFieldIds??[]);
  const rows=run?.results??[];const visible=rows.filter(r=>(!businessType||(objects.find(o=>o.objectId===r.scopeId)?.role??r.scopeId.replace('unconfirmed:',''))===businessType)&&(!scope||r.scopeId===scope)&&(!category||resultCategory(r)===category)&&(!document||(document==='__none'?sources(r).documentIds.length===0:sources(r).documentIds.includes(document))));
  const reset=()=>{setBusinessType(undefined);setScope(undefined);setDocument(undefined);setCategory(undefined);setPage(1);};
  useEffect(()=>{reset();setRunId(undefined);setPreviousId(undefined);setComparisonOpen(false);setMailDraft(undefined);},[state.caseId,state.roundId]);
  const changes=run&&before?compareResults(before,run):[];
  const changeLabels={fields:Object.fromEntries((configuration?.fields??[]).map(f=>[f.id,f.label])),documents:names};
  const pendingChanges=snapshot?snapshotChanges(snapshot,{businessDate:state.businessDate??snapshot.businessDate,configurationReleaseId:state.configurationReleaseId??'',objects:state.objects,facts:state.facts,materials:state.materials},changeLabels):[];
  const reviewPath=`/cases/${state.caseId}/review?mode=business&tab=checklist${state.roundId?`&round=${state.roundId}`:state.legacyView?'&round=legacy':''}`;
  const runSelector=run?<div className="review-loop-toolbar"><label>查看执行记录 <Select aria-label="检查记录" value={run.id} options={state.runs.map(r=>({value:r.id,label:`r${r.caseRevision} · ${formatTime(r.createdAt)} · ${runStateLabels[r.state]??r.state}`}))} onChange={id=>{setRunId(id);setPreviousId(undefined);setChangeKind(undefined);reset();}}/></label><Tag>{run.validity==='stale'?'旧结果已失效 · 仅供回查':run.state==='ready'?'当前有效检查结果':runStateLabels[run.state]}</Tag></div>:null;
  const comparison=<details hidden={presentation==='report'&&!comparisonOpen} ref={comparisonRef} className="review-loop-record report-comparison" tabIndex={-1} open={comparisonOpen} onToggle={event=>setComparisonOpen(event.currentTarget.open)}><summary>两轮材料比较</summary>{comparisonOpen&&run&&<AnalysisPanel caseId={state.caseId} runId={run.id} kind="comparison"/>}</details>;
  return !run?<><div className="report-pending"><h2>本轮尚未提交预审</h2><p>请先上传本轮材料，并在提取审查中核对字段后开始预审。</p><div className="review-loop-toolbar-actions"><Link to={`/cases/${state.caseId}/materials${state.roundId?`?round=${state.roundId}`:''}`}>继续上传材料</Link><Link to={reviewPath}>前往提取审查</Link></div><SignatureInformationSummaryView caseId={state.caseId} items={state.signatureInformation??[]} roundId={state.roundId}/></div>{presentation==='report'&&afterMail}</>:<div className={presentation==='report'?'review-results report-workspace':'review-results'}>
    {presentation==='report'&&<ResultOverview state={state} runId={run.id} draft={mailDraft} analysis={analysis.data} reviewPath={reviewPath}/>}
    <div className="report-main">
    {presentation==='checks'&&runSelector}
    {run.validity==='stale'&&<div className="tone-warning" role="status"><p>此轮结果已失效，仅供回查。请核对变更，再从概览手动重审。</p><details><summary>查看本轮与当前修订的差异</summary>{run.configurationReleaseId!==state.configurationReleaseId&&<p>当前采用配置已更换。</p>}{snapshot&&snapshot.businessDate!==state.businessDate&&<p>审核基准日已变化。</p>}<ul>{pendingChanges.map(c=><li key={c.key}>{c.label}</li>)}</ul>{!pendingChanges.length&&<p>当前返回的材料、对象、事实版本未显示差异。具体失效原因尚缺可追溯记录，请核对原件处理记录；不据此恢复旧结果有效性。</p>}</details></div>}
    {!!snapshot?.guidance?.length&&<p className="report-guidance">本轮采用的判断口径：{snapshot.guidance.map(g=>g.label).join('、')}。依据这些口径的含义核对结论在字段工作台中逐项标明。</p>}
    {run.state!=='ready'&&<div className="report-pending" role="status"><h2>{runStateLabels[run.state]}</h2><p>{['pending','running'].includes(run.state)?'本轮预审正在执行，完成后可生成邮件草稿。':'本轮没有有效的完成结果，请查看执行记录，并通过轮次操作重试或准备材料。'}</p></div>}
    {run.errorCode&&<div role="alert">本轮检查未完成，不能作为有效完成结果。<details><summary>处理记录</summary><span className="review-loop-code">{run.errorCode}</span></details></div>}
    {presentation==='checks'&&canReadEvidence&&crossChecks.length>0&&<CrossFileReport key={run.id} checks={crossChecks} caseId={state.caseId}/>}
    {presentation==='report'&&!pair&&analysis.data&&<p role="status" className="muted">{comparisonUnavailableReason(analysis.data,run.id)}</p>}
    {presentation==='report'?<MailPanel presentation="report" caseId={state.caseId} runId={run.id} backTo={reviewPath} onDraft={setMailDraft} compareLabel={pair?`智能比对 R${pair.before.roundNumber} → R${pair.after.roundNumber}`:analysis.isPending?'正在读取轮次':analysis.error?'轮次暂不可用':'暂无可比较结果'} comparison={pair?comparison:null} onCompare={pair?()=>{setComparisonOpen(value=>!value);requestAnimationFrame(()=>{comparisonRef.current?.focus();comparisonRef.current?.scrollIntoView({block:'start'});});}:undefined}/>:<details className="review-loop-record"><summary>预审邮件</summary><MailPanel caseId={state.caseId} runId={run.id}/></details>}
    {presentation!=='report'&&comparison}
    <ErrorNotice error={analysis.error} retry={()=>void analysis.refetch()}/>
    {presentation==='report'&&<><div className="report-next-actions">{run.id!==state.runs[0]?.id?<p>正在查看历史执行结果，请切换到最新执行记录后确认本轮。</p>:run.state==='ready'&&!data?<p>正在核对本轮结果，请稍候。</p>:typeof afterMail==='function'?afterMail(run):afterMail}</div></>}
    {presentation==='checks'&&<details className="report-supporting" open><summary>核对依据与检查记录</summary>
    <SignatureInformationSummaryView caseId={state.caseId} items={snapshot?.signatureInformation??[]} roundId={state.roundId}/>
    <details className="review-loop-record"><summary>本轮中文译文与完整字段</summary><TranslationPreparation state={state} compact/><Link to={reviewPath}>查看完整字段、译文与原文</Link></details>
    <details className="review-loop-record"><summary>语义核对</summary><AnalysisPanel caseId={state.caseId} runId={run.id} kind="semantic"/></details>
    <details className="review-loop-record" open><summary>程序检查明细 · {rows.length} 项</summary><p className="muted">采用配置：{configuration?.label??run.configurationReleaseId} · 审核基准日：{snapshot?.businessDate??'待读取历史快照'} · r{run.caseRevision}</p>
    {replay.isPending&&canReadEvidence&&<p role="status">正在读取本轮快照与依据…</p>}<ErrorNotice error={replay.error} retry={()=>void replay.refetch()}/>
    {!canReadEvidence&&<p>未获原文读取权限；来源和历史快照暂不可查看。</p>}
    <div className="review-result-filters" aria-label="检查结果筛选">
      <label>担保类型<Select aria-label="筛选担保类型" allowClear placeholder="全部担保类型" value={businessType} onChange={v=>{setBusinessType(v);setScope(undefined);setPage(1);}} options={[...new Set(objects.map(o=>o.role).filter(role=>GUARANTEE_LABELS[role]))].map(value=>({value,label:GUARANTEE_LABELS[value]}))}/></label>
      <label>对象<Select aria-label="筛选检查对象" allowClear placeholder="全部对象" value={scope} onChange={v=>{setScope(v);setPage(1);}} options={[...new Set(rows.map(r=>r.scopeId))].map(id=>({value:id,label:objectLabel(id,objects)}))}/></label>
      <label>关联材料<Select aria-label="筛选关联材料" allowClear disabled={!snapshot} placeholder="全部材料" value={document} onChange={v=>{setDocument(v);setPage(1);}} options={[...new Set(rows.flatMap(r=>sources(r).documentIds))].map(id=>({value:id,label:names[id]??`文件 ${id.slice(0,8)}`})).concat([{value:'__none',label:'没有材料依据'}])}/></label>
      <label>结果<Select aria-label="筛选检查结果" allowClear placeholder="全部结果" value={category} onChange={v=>{setCategory(v);setPage(1);}} options={[...new Map(rows.map(r=>[resultCategory(r),{value:resultCategory(r),label:resultLabel(r)}])).values()]}/></label>
      <Button onClick={reset} disabled={!businessType&&!scope&&!document&&!category}>恢复全部</Button>
    </div><p role="status">当前筛选 {visible.length} / {rows.length} 项{document?' · 材料筛选包含跨文件及对象关联依据':''}</p>
    <Table<ReviewResult> className="review-result-table" tableLayout="fixed" rowKey={r=>JSON.stringify([r.ruleId,r.scopeId])} dataSource={visible} scroll={{x:1120}} pagination={{current:page,pageSize:20,onChange:setPage,showSizeChanger:false,hideOnSinglePage:true}} locale={{emptyText:'没有符合条件的检查结果，可恢复全部重新选择'}}
      expandable={canReadEvidence&&snapshot?{expandedRowRender:r=><ResultTranslation state={state} sources={sources(r)}/>,rowExpandable:r=>sources(r).direct.length>0}:undefined} columns={[
      {title:'检查项',key:'rule',width:260,render:(_,r)=><RuleText configuration={configuration} id={r.ruleId}/>},
      {title:'对象',dataIndex:'scopeId',width:170,render:id=><><span>{objectLabel(id,objects)}</span><details><summary>对象标识</summary><span className="review-loop-code">{id}</span></details></>},
      {title:'结果',key:'result',width:160,render:(_,r)=><span className={r.outcome==='fail'?'tone-danger':['blocked','needs_review'].includes(r.outcome)?'tone-warning':undefined}>{resultLabel(r)}</span>},
      {title:'说明',key:'reason',width:260,render:(_,r)=><>{reviewReason(r.reasonCode)}{r.details?.expiryDate&&<div>系统计算到期日：{r.details.expiryDate}</div>}</>},
      {title:'原文与关联依据',key:'evidence',width:270,render:(_,r)=>snapshot?<Sources caseId={state.caseId} sources={sources(r)} names={names}/>:<span className="muted">尚未取得本轮快照，无法定位依据</span>},
    ]}/>
    </details><details className="review-loop-record"><summary>更正与重审变化{changes.length?` · ${changes.filter(c=>c.kind==='added').length} 项新增待处理，${changes.filter(c=>c.kind==='resolved').length} 项已解决`:''}</summary>
      <p>目标轮次：r{run.caseRevision} · {run.id}；配置 {run.configurationReleaseId}；审核基准日 {snapshot?.businessDate??'待读取'}</p>
      {state.runs.length>1?<><label>比较基准 <Select aria-label="重审比较基准" value={before?.id} placeholder="选择上一轮检查" onChange={setPreviousId} options={state.runs.filter(r=>r.id!==run.id&&new Date(r.createdAt)<=new Date(run.createdAt)).map(r=>({value:r.id,label:`r${r.caseRevision} · ${formatTime(r.createdAt)}`}))}/></label>{before&&<p>基准轮次：r{before.caseRevision} · {before.id}；配置 {before.configurationReleaseId}；审核基准日 {old?.snapshot.businessDate??'待读取'}</p>}<ErrorNotice error={prior.error} retry={()=>void prior.refetch()}/>
        {before&&<><p>按规则和对象标识比较；“已解决”仅指同一配置下，本轮有效检查明确未发现差异。问题处置状态仍以问题记录为准。</p><p>新增待处理 {changes.filter(c=>c.kind==='added').length} · 仍需处理 {changes.filter(c=>c.kind==='persisting').length} · 已解决 {changes.filter(c=>c.kind==='resolved').length} · 未重新验证 {changes.filter(c=>c.kind==='unverified').length} · 不可直接比较 {changes.filter(c=>c.kind==='incomparable').length}</p>
          {old&&snapshot?<details><summary>材料、对象和事实的变化</summary><ul>{snapshotChanges(old.snapshot,snapshot,changeLabels).map(c=><li key={c.key}>{c.label}</li>)}</ul>{!snapshotChanges(old.snapshot,snapshot,changeLabels).length&&<p>两轮快照中的材料、对象、事实版本相同；另请核对配置及审核基准日。</p>}</details>:<p>快照尚未完整取得，材料及事实变化暂不可验证。</p>}
          <label>变化类型 <Select aria-label="筛选重审变化" allowClear placeholder="全部变化" value={changeKind} onChange={setChangeKind} options={[{value:'added',label:'新增待处理'},{value:'resolved',label:'已解决'},{value:'persisting',label:'仍需处理'},{value:'unverified',label:'未重新验证'},{value:'incomparable',label:'不可直接比较'}]}/></label>
          <Table className="review-result-table" tableLayout="fixed" rowKey="key" scroll={{x:850}} pagination={{pageSize:10,showSizeChanger:false}} dataSource={changes.filter(c=>c.kind!=='unchanged'&&(!changeKind||c.kind===changeKind)).toSorted((a,b)=>['added','resolved','unverified','incomparable','persisting'].indexOf(a.kind)-['added','resolved','unverified','incomparable','persisting'].indexOf(b.kind))} columns={[{title:'检查项／对象',key:'identity',width:300,render:(_,c)=><>{configuration?.rules.find(r=>r.id===c.ruleId)?.label??c.ruleId}<div>{objectLabel(c.scopeId,objects)}</div></>},{title:'上一轮',key:'before',width:150,render:(_,c)=>c.before?resultLabel(c.before):'未检查'},{title:'本轮',key:'after',width:150,render:(_,c)=>c.after?resultLabel(c.after):'未检查'},{title:'变化说明',dataIndex:'label',width:250}]}/></>}
      </>:<p>目前只有一轮记录；完成更正和重审后，才能比较两轮结果。</p>}
      <details><summary>本轮之后的变更记录（最多读取最近 200 条）</summary><ul>{state.history.filter(e=>new Date(e.createdAt)>new Date(run.createdAt)&&['fact_confirmed','fact_corrected','object_confirmed','material_adopted','material_rejected','materials_removed','configuration_bound'].includes(e.kind)).map(e=><li key={e.id}>r{e.caseRevision} · {formatTime(e.createdAt)} · {{fact_confirmed:'事实确认／更正',fact_corrected:'事实更正',object_confirmed:'对象关联更正',material_adopted:'材料采用',material_rejected:'材料不采用',materials_removed:'移除本轮文件',configuration_bound:'配置更换'}[e.kind]}<div className="review-loop-code">{typeof e.details.fieldId==='string'?configuration?.fields.find(f=>f.id===e.details.fieldId)?.label??e.details.fieldId:''} {typeof e.details.objectId==='string'?objectLabel(e.details.objectId,state.objects):''} {typeof e.details.documentVersionId==='string'?names[e.details.documentVersionId]??e.details.documentVersionId:''}</div></li>)}</ul><p className="muted">只列已记录的事件，不能把时间相邻的操作认定为失效原因。原件处理、基准日变化等原因需结合执行记录核对。</p></details>
    </details>
    <details className="review-loop-record"><summary>执行与快照记录</summary><p>检查记录：<span className="review-loop-code">{run.id}</span> · r{run.caseRevision}</p><p className="review-loop-code">配置：{run.configurationReleaseId}<br/>快照指纹：{run.snapshotHash}</p>{snapshot&&<><p>固定 {snapshot.materials.length} 份材料、{snapshot.facts.length} 项事实；审核基准日 {snapshot.businessDate}</p><ul>{snapshot.materials.map(m=><li key={`${m.documentVersionId}:${m.logicalDocumentId}`}>{names[m.documentVersionId]??m.documentTypeId}<div className="review-loop-code">材料版本 {m.documentVersionId} · 解析 {m.parseRevision??'无'} · 目录 {m.directoryRevision??'无'}</div></li>)}</ul><Table<ReviewFact> className="review-result-table" tableLayout="fixed" rowKey="factId" size="small" pagination={{pageSize:10,showSizeChanger:false}} scroll={{x:900}} dataSource={snapshot.facts} columns={[{title:'本轮对象／字段',width:200,render:(_,f)=><>{objectLabel(f.objectId,snapshot.objects)}<div>{configuration?.fields.find(d=>d.id===f.fieldId)?.label??f.fieldId}</div></>},{title:'当时原值',dataIndex:'rawValue',width:200,render:readableValue},{title:'规范值（系统规范化）',dataIndex:'normalizedValue',width:180,render:readableValue},{title:'来源与确认',width:180,render:(_,f)=><FactTrace fact={f} state={state}/>},{title:'本轮原文',width:240,render:(_,f)=><EvidenceLinks caseId={state.caseId} evidence={f.evidence} names={names}/>}]}/></>}
      <details><summary>执行回执 {run.executionReceipts.length} 项</summary>{run.executionReceipts.map(r=><p className="review-loop-code" key={r.evaluationId}>{r.evaluationId} · {r.actualReleaseId} · {r.actualPackageHash} · {r.executorVersion}{r.reusedFrom?` · 沿用已验证结果 ${r.reusedFrom}`:''}</p>)}</details>
    </details><p className="muted">结果仅适用于本轮配置和证据范围，尚未经最终独立复核。</p>
  </details>}</div></div>;
}
