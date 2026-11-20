import {CheckerEntry} from '../features/review-checker/checker-entry.tsx';
import {ReviewProgressProvider} from '../features/review/semantic-progress.tsx';
import {CheckerPanel,ReviewReportActions} from '../features/review-checker/checker-panel.tsx';
import {GUARANTEE_LABELS} from '@hsbc/contracts/mixed-guarantee';
import {caseListStatuses, caseStatuses, statusView} from '../status.ts';
import {RoundControls,useReviewRounds} from '../features/review/round-controls.tsx';
import type {ReviewRoundsState} from '@hsbc/contracts/review-rounds';
import React, {useEffect, useRef, useState} from 'react';
import {caseListOverview, caseListPage, caseListStatus, matchesCaseListStatus} from '../features/cases/list-presentation.ts';
import {caseDisplayName} from '../features/cases/identity.ts';
import {caseForRound} from '../features/cases/round-presentation.ts';
import {PreviousRound} from '../features/cases/round-history.tsx';
import {caseMaterialsPath, reviewDestination} from '../features/cases/workspace-navigation.ts';
import {useCapabilities} from '../capabilities.ts';
import './cases.css';
import {Button, Form, Input, Segmented, Select, Table} from 'antd';
import type {TableProps} from 'antd';
import {useQuery} from '@tanstack/react-query';
import {Link, Navigate, useLocation, useNavigate, useParams, useSearchParams} from 'react-router';
import {api, isAccessLoss, newKey, queryClient} from '../api.ts';
import {can} from '../features/identity/permissions.ts';
import {useAuth} from '../auth.tsx';
import {nextStep} from '../caseActions.ts';
import type {CaseSummary} from '../features/cases/types.ts';
import {ActionModal, Blank, blocksView, ErrorNotice, Loading, ReasonField, RefreshNotice, useCaseHeader, useCrumbs, useRestoreFocus, useStickyTop} from '../ui.tsx';
import {useUploads} from '../uploads.tsx';
import {Materials} from './materials.tsx';
import {Review} from './review.tsx';
import {ReviewIssues, ReviewLoop, ReviewRecords} from './review-loop.tsx';

type Scope = 'all' | 'mine' | 'assign';
const scopeOptions: {value: Scope; label: string}[] = [{value: 'all', label: '全部'}, {value: 'mine', label: '我负责'}, {value: 'assign', label: '待我指派'}];

function CaseParties({names}: {names?: string[]}) {
  if (!names?.length) return <span className="muted">待确认</span>;
  if (names.length === 1) return <span>{names[0]}</span>;
  return <details className="case-list-parties"><summary>{names[0]} 等 {names.length} 个</summary><ol>{names.map((name, index) => <li key={index}>{name}</li>)}</ol></details>;
}

export function Cases() {
  const {session} = useAuth();
  const navigate = useNavigate();
  const stickyTop = useStickyTop();
  const [search, setSearch] = useSearchParams();
  const expandedCaseId = search.get('case');
  const q = search.get('q') ?? '';
  const scope = (scopeOptions.some(option => option.value === search.get('scope')) ? search.get('scope') : 'all') as Scope;
  const status = search.get('status') && caseStatuses[search.get('status')!] ? search.get('status')! : undefined;
  const closedOnly = status === 'closed';
  const hasFilters = !!q || scope !== 'all' || (!!status && !closedOnly);
  const pageSize = [10, 20, 50].includes(Number(search.get('size'))) ? Number(search.get('size')) : 20;
  const [input, setInput] = useState(q);
  useEffect(() => setInput(q), [q]);
  const update = (patch: Record<string, string | undefined>) => setSearch(current => {const next = new URLSearchParams(current); for (const [key, value] of Object.entries(patch)) {if (value) next.set(key, value); else next.delete(key);} return next;}, {replace: true});
  const query = useQuery({queryKey: ['cases', q, {closedOnly}], queryFn: ({signal}) => api<{items: CaseSummary[]}>(`/api/cases?q=${encodeURIComponent(q)}${closedOnly ? '&lifecycle=closed' : ''}`, {signal}), refetchInterval: 30_000});
  const all = query.data?.items ?? [];
  const items = all.filter(item => (scope === 'mine' ? item.makerPersonId === session.user?.personId : scope === 'assign' ? item.status === 'assignment_required' && can(item.allowed_actions, 'case:assign') : true) && matchesCaseListStatus(item, status));
  const overview = caseListOverview(items);
  const ready = !query.isPending && !blocksView(query);
  const page = caseListPage(search.get('page'), pageSize, items.length);
  const columns: TableProps<CaseSummary>['columns'] = [
    {title: '案件号', key: 'reference', width: 210, defaultSortOrder: 'descend', showSorterTooltip: {title: '按更新时间排序'}, sorter: (a,b) => a.updatedAt.localeCompare(b.updatedAt) || a.id.localeCompare(b.id), render: (_, item) => <><Link className="case-list-reference" to={caseMaterialsPath(item.id)} title={caseDisplayName(item)}><span>{item.caseNumber || item.reference || item.id.slice(0,8)}</span><span aria-hidden="true">{expandedCaseId === item.id ? '⌄' : '›'}</span></Link>{item.title && item.title !== item.caseNumber && <span className="case-list-title" title={item.title}>{item.title}</span>}</>},
    {title: '担保类型', key: 'guarantees', width: 140, render: (_, item) => item.guaranteeTypes?.map(t => GUARANTEE_LABELS[t] ?? t).join(' + ') || <span className="muted">待确认</span>},
    {title: '借款人', key: 'borrowers', width: 190, render: (_, item) => <CaseParties names={item.borrowers}/>},
    {title: '担保人', key: 'guarantors', width: 210, render: (_, item) => <CaseParties names={item.guarantors}/>},
    {title: '轮次', key: 'round', width: 80, render: (_, item) => <span className="case-list-round" aria-label={item.roundNumber ? `第 ${item.roundNumber} 轮` : undefined}>{item.roundNumber ? `R${item.roundNumber}` : item.roundsEnabled ? '待准备' : '历史未分轮'}</span>},
    {title: '当前状态', key: 'status', width: 150, render: (_, item) => {const step = nextStep(item.id, item); const view = statusView(caseStatuses, caseListStatus(item)); return <Link className={`case-list-status tone-${view.tone}`} to={step.to} title={step.label}>{view.label}</Link>;}},
  ];
  if (expandedCaseId) return <Navigate replace to={caseMaterialsPath(expandedCaseId, search.get('round'))}/>;
  return <div className="cases-landing">
    <section className="case-dashboard" aria-labelledby="cases-title">
      <header className="case-dashboard-head">
        <div>
          <div className="case-dashboard-title"><h1 id="cases-title">案件工作台</h1>{ready && <span className={`case-list-count${closedOnly ? ' is-closed' : ''}`}>{closedOnly ? `${items.length} 个已完结案件` : `${overview.active} 个在途案件`}</span>}</div>
          <p>点案件号查看该案，或新建案件。</p>
          {ready && <dl className="case-dashboard-metrics" aria-label="当前筛选范围的案件概览"><div><dt>准备材料</dt><dd>{overview.preparing}</dd></div><div><dt>预审中</dt><dd>{overview.reviewing}</dd></div><div title="按北京时间统计"><dt>今日更新</dt><dd>{overview.updatedToday}</dd></div></dl>}
        </div>
        <div className="case-dashboard-actions">
          {can(session.allowed_actions, 'case:create') && <Button type="primary" icon={<span aria-hidden="true">＋</span>} onClick={() => navigate('/cases/new')}>新建案件</Button>}
        </div>
      </header>
      <div className="case-list-viewbar" id="case-list-search-tools">
        <div className="case-list-views" role="group" aria-label="案件视图">
          <Button type="text" aria-pressed={!closedOnly} onClick={() => update({status: undefined, page: undefined, case: undefined, round: undefined})}>全部案件</Button>
          <Button type="text" aria-pressed={closedOnly} onClick={() => update({status: 'closed', page: undefined, case: undefined, round: undefined})}>已完结</Button>
        </div>
        <div className="case-list-tools">
        <Segmented<Scope> aria-label="案件范围" options={scopeOptions} value={scope} onChange={value => update({scope: value === 'all' ? undefined : value, page: undefined})}/>
        <Select className="case-list-status-filter" aria-label="案件状态" value={status ?? 'all'} options={[{value: 'all', label: '全部状态'}, {value: 'closed', label: '已完结'}, ...caseListStatuses.map(value => ({value, label: caseStatuses[value]!.label}))]} onChange={value => update({status: value === 'all' ? undefined : value, page: undefined, case: undefined, round: undefined})}/>
        <form className="search-form" role="search" onSubmit={event => {event.preventDefault(); update({q: input.trim() || undefined, page: undefined});}}><Input aria-label="搜索案件号、名称或参考标识" placeholder="搜索案件号、名称或参考标识" value={input} onChange={event => setInput(event.target.value)} allowClear maxLength={200}/><Button htmlType="submit">搜索</Button></form>
        {hasFilters && <Button type="link" onClick={() => {setInput(''); update({q: undefined, scope: undefined, status: closedOnly ? 'closed' : undefined, page: undefined});}}>清除筛选</Button>}
        </div>
      </div>
      {ready && all.length >= 200 && <p className="case-list-range" role="status">当前范围显示最近 200 个案件中的 {items.length} 个，可搜索其他案件</p>}

      {blocksView(query) ? <ErrorNotice error={query.error} retry={() => void query.refetch()}/> : <RefreshNotice query={query} retry={() => void query.refetch()}/>}
      {query.isPending ? <Loading/> : ready && <Table<CaseSummary> className="case-list-table" rowKey="id" columns={columns} dataSource={items} tableLayout="fixed" scroll={{x: 980}} sticky={{offsetHeader: stickyTop}} locale={{emptyText: <Blank title={q || scope !== 'all' || status ? '没有匹配的案件' : '暂无可访问的案件'}>{q || scope !== 'all' || status ? <Button onClick={() => {setInput(''); update({q: undefined, scope: undefined, status: undefined, page: undefined});}}>清除筛选</Button> : can(session.allowed_actions, 'case:create') ? <Link to="/cases/new">新建案件</Link> : null}</Blank>}}
        onChange={(pagination, _filters, _sorter, extra) => update(extra.action === 'paginate' ? {page: pagination.pageSize !== pageSize ? undefined : (pagination.current ?? 1) > 1 ? String(pagination.current) : undefined, size: pagination.pageSize === 20 ? undefined : String(pagination.pageSize)} : {page: undefined})}
        pagination={{current: page, pageSize, pageSizeOptions: [10, 20, 50], showSizeChanger: items.length > 10, hideOnSinglePage: items.length <= 10, size: 'small', showTotal: (total, range) => total ? `第 ${range[0]}–${range[1]} 个，共 ${total} 个` : '共 0 个'}}/>}
    </section>
    {ready && !all.length && !hasFilters && !closedOnly && <section className="case-list-intro" aria-label="预审流程">
      <div><h2>选择案件查看材料与历史轮次，<br className="case-intro-break"/>或新建案件开始预审</h2><p>按轮次保留材料与核对记录；原文、参考译文及人工确认分别记录。</p><ol><li><span>01</span>准备本轮材料</li><li><span>02</span>提取与字段核对</li><li><span>03</span>整理预审邮件</li></ol></div>
      <img src="/illustrations/case-review.svg" alt="" width="248" height="148"/>
    </section>}
  </div>;
}

export {NewCase} from './new-case.tsx';
const tabs = [{key: 'materials', label: '材料与版本'}, {key: 'review', label: '审核工作台'}, {key: 'collaboration', label: '协作与复核'}, {key: 'reports', label: '报告与记录'}];
export function CasePage() {
  const {caseId, tab: rawTab = 'materials'} = useParams();
  const tab = tabs.some(entry => entry.key === rawTab) ? rawTab : 'materials';
  const location = useLocation();
  const capabilities = useCapabilities();
  // Each tab keeps its own query (reader page, parse revision) while the reviewer moves between tabs.
  const lastSearch = useRef<{caseId?: string; values: Record<string, string>}>({caseId, values: {}});
  if (lastSearch.current.caseId !== caseId) lastSearch.current = {caseId, values: {}};
  lastSearch.current.values[tab] = location.search;
  const query = useQuery({queryKey: ['case', caseId], queryFn: ({signal}) => api<CaseSummary>(`/api/cases/${encodeURIComponent(caseId!)}`, {signal}), refetchInterval: 30_000});
  const roundState=useReviewRounds(caseId!);
  const selectedRoundId=new URLSearchParams(location.search).get('round')??roundState.data?.currentRoundId??query.data?.currentRoundId??null;
  const selectedRound=roundState.data?.items.find(r=>r.roundId===selectedRoundId);
  const rawItem = blocksView(query) || query.data?.id !== caseId ? undefined : query.data;
  const item=rawItem?caseForRound(rawItem,blocksView(roundState)?undefined:roundState.data,selectedRoundId):undefined;
  const roundSearch=(value:string)=>{const p=new URLSearchParams(value);if(selectedRoundId)p.set('round',selectedRoundId);else p.delete('round');return p.size?'?'+p.toString():'';};
  const uploading = useUploads().states.some(state => state.caseId === caseId && (state.queued || state.transmitting));
  useCaseHeader(item ? {
    caseId: item.id, caseNumber: item.caseNumber, title: caseDisplayName(item), status: item.preReviewStatus??item.status, revision: item.revision,
    reference: item.reference, roundNumber: selectedRound?.roundNumber, legacyRound: selectedRoundId === 'legacy' || item.roundsEnabled === false,
    maker: item.makerDisplayName || (item.makerPersonId ? '已指派' : '未指派'), activeTab: tab,
    tabs: tabs.map(entry => ({...entry, to: `/cases/${encodeURIComponent(item.id)}/${entry.key}${roundSearch(lastSearch.current.values[entry.key] ?? '')}`, uploading: entry.key === 'materials' && uploading})),
  } : undefined);
  const tabLabel = tabs.find(entry => entry.key === tab)!.label;
  const caseTitle = item?.title ?? (query.isPending ? '正在读取案件' : '无法打开案件');
  useCrumbs([{title: '案件', to: '/cases'}, {title: caseTitle}], `${caseTitle} · ${tabLabel}`);
  return <div className={`case-page case-page-${tab}${tab==='review'&&reviewDestination(location.search,capabilities.data?.reviewLoop===true)==='reader'?' case-page-reader':''}`}>
    {query.isPending ? <Loading/> : !item ? (isAccessLoss(query.error) ? <section className="panel"><Blank title="当前账号无法访问此案件，或案件不存在。"><Link to="/cases">返回案件列表</Link></Blank></section> : <ErrorNotice error={query.error} retry={() => void query.refetch()}/>) : <ReviewProgressProvider key={`${item.id}:${selectedRoundId??'legacy'}`}>
      <RefreshNotice query={query} retry={() => void query.refetch()}/>
      {tab !== 'materials' && <RoundControls key={item.id} item={item} state={blocksView(roundState)?undefined:roundState.data} compact selectionOnly={tab==='reports'||tab==='collaboration'} roundCommands={false}/>}<div className="case-page-content" key={`${item.id}:${selectedRoundId??'legacy'}`}>
      {tab === 'materials' ? <CaseMaterials item={item} rounds={blocksView(roundState) ? undefined : roundState.data} refresh={() => query.refetch()}/> : tab === 'review' ? capabilities.isPending ? <Loading/> : reviewDestination(location.search, capabilities.data?.reviewLoop === true) === 'business' ? <ReviewLoop key={item.id} item={item}/> : <Review item={item}/> : tab === 'collaboration' ? <ReviewRecords key={`${item.id}:${selectedRoundId??'current'}`} item={item} afterMail={run=><CheckerPanel item={item} compact displayedRun={run} roundState={blocksView(roundState)?undefined:roundState.data} records={<ReviewIssues key={item.id} item={item}/>}/>}/> : <ReviewRecords key={`${item.id}:${selectedRoundId??'current'}`} item={item} afterMail={run=><ReviewReportActions item={item} displayedRun={run} state={blocksView(roundState)?undefined:roundState.data}/>}/>}</div>
    </ReviewProgressProvider>}
  </div>;
}
function CaseMaterials({item, rounds, refresh}: {item: CaseSummary; rounds?: ReviewRoundsState; refresh: () => Promise<unknown>}) {
  const selectedRound = rounds?.items.find(round => round.roundId === item.selectedRoundId);
  return <>
    <PreviousRound item={item} state={rounds}/>
    <Materials key={`${item.id}:${item.selectedRoundId ?? 'current'}`} item={item}
      roundActions={<RoundControls item={item} state={rounds} compact inline reviewAction={null}/>}
      caseActions={<CasePreparationActions item={item} refresh={refresh}/>}
      reviewEntry={selectedRound?.status === 'checker_pending' ? <CheckerEntry item={item} round={selectedRound}/> : undefined}/>
  </>;
}
function CasePreparationActions({item, refresh}: {item: CaseSummary; refresh: () => Promise<unknown>}) {
  const [dialog, setDialog] = useState<'assign' | 'scenario'>();
  return <>
    {can(item.allowed_actions, 'case:assign') && <Button onClick={() => setDialog('assign')}>{item.makerPersonId ? '调整经办' : '指派经办人员'}</Button>}
    {item.scenario !== 'overseas_loan' && can(item.allowed_actions, 'case:confirm-scenario') && <Button onClick={() => setDialog('scenario')}>确认业务场景</Button>}
    {dialog === 'assign' && <AssignDialog item={item} close={() => setDialog(undefined)} refresh={refresh}/>}
    {dialog === 'scenario' && <ScenarioDialog item={item} close={() => setDialog(undefined)} refresh={refresh}/>}
  </>;
}
function AssignDialog({item: live, close, refresh}: {item: CaseSummary; close: () => void; refresh: () => Promise<unknown>}) {
  useRestoreFocus();
  // Lock the revision seen when the dialog opened, so a background refresh cannot bypass the 409 check.
  const [item] = useState(live);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<unknown>();
  const [key, setKey] = useState(newKey);
  const candidates = useQuery({queryKey: ['assignment-candidates', item.id], queryFn: ({signal}) => api<{items: {personId: string; displayName: string}[]}>(`/api/cases/${item.id}/assignment-candidates`, {signal})});
  return <ActionModal title={item.makerPersonId ? '调整指派' : '指派经办人员'} okText="保存指派" pending={pending} onCancel={close} onValuesChange={() => setKey(newKey())}
    summary={<dl><dt>案件</dt><dd>{item.title}</dd><dt>当前经办</dt><dd>{item.makerDisplayName || (item.makerPersonId ? '已指派' : '尚未指派')}</dd><dt>案件修订</dt><dd className="mono">r{item.revision}</dd></dl>}
    error={<><ErrorNotice error={error} retry={() => {setPending(true); void refresh().then(() => close()).catch(setError).finally(() => setPending(false));}}/><ErrorNotice error={candidates.error} retry={() => void candidates.refetch()}/></>}
    onFinish={async (values: {makerPersonId: string; reason: string}) => {
      setPending(true); setError(undefined);
      try {await api(`/api/cases/${item.id}/assign`, {method: 'POST', body: {...values, expectedRevision: item.revision, idempotencyKey: key}}); await refresh(); await Promise.all([queryClient.invalidateQueries({queryKey: ['cases']}), queryClient.invalidateQueries({queryKey: ['workbench']})]); close();}
      catch (failure) {setError(failure);} finally {setPending(false);}
    }}>
    <Form.Item name="makerPersonId" label="新经办人员" rules={[{required: true, message: '请选择经办人员'}]}><Select autoFocus showSearch={{optionFilterProp: 'label'}} loading={candidates.isPending} options={candidates.data?.items.map(person => ({value: person.personId, label: person.displayName}))} notFoundContent="暂无可指派人员"/></Form.Item>
    <ReasonField label="指派原因"/>
  </ActionModal>;
}
function ScenarioDialog({item: live, close, refresh}: {item: CaseSummary; close: () => void; refresh: () => Promise<unknown>}) {
  useRestoreFocus();
  const [item] = useState(live);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<unknown>();
  const [key, setKey] = useState(newKey);
  return <ActionModal title="确认业务场景" okText="确认境外贷款" pending={pending} onCancel={close} onValuesChange={() => setKey(newKey())}
    summary={<dl><dt>案件</dt><dd>{item.title}</dd><dt>确认为</dt><dd>境外贷款</dd></dl>} warning="请核对案件材料后再确认。确认后才能解析材料。" error={<ErrorNotice error={error}/>}
    onFinish={async (values: {reason: string}) => {setPending(true); setError(undefined); try {await api(`/api/cases/${item.id}/confirm-scenario`, {method: 'POST', body: {...values, scenario: 'overseas_loan', expectedRevision: item.revision, idempotencyKey: key}}); await refresh(); close();} catch (failure) {setError(failure);} finally {setPending(false);}}}>
    <ReasonField label="确认依据" autoFocus/>
  </ActionModal>;
}
