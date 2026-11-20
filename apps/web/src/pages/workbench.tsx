import {caseMaterialsPath} from '../features/cases/workspace-navigation.ts';
import {caseDisplayName} from '../features/cases/identity.ts';
import {CheckerInbox} from '../features/review-checker/checker-panel.tsx';
import type {CaseReviewProjection} from '@hsbc/contracts/case-review-status';
import {GUARANTEE_LABELS} from '@hsbc/contracts/mixed-guarantee';
import {caseStatuses} from '../status.ts';
import React, {useId, useState} from 'react';
import {Button, Segmented, Table} from 'antd';
import type {TableProps} from 'antd';
import {useQuery} from '@tanstack/react-query';
import {Link, useNavigate} from 'react-router';
import {api} from '../api.ts';
import {can} from '../features/identity/permissions.ts';
import {formatTime} from '../shared/format.ts';
import {useAuth} from '../auth.tsx';
import {nextStep} from '../caseActions.ts';
import {blocksView, CaseStatus, ErrorNotice, Loading, PageHeader, RefreshNotice, Section} from '../ui.tsx';
import './workbench.css';

interface WorkbenchData {
  statusCounts?:Record<string,number>;
  periodDays: 7 | 30;
  counts: {accessibleCases: number; myCases: number; awaitingAssignment: number; registeredMaterials: number};
  materialTrend: {date: string; count: number}[];
  workItems: (Partial<CaseReviewProjection>&{
    caseId: string; caseNumber?: string | null; title: string; reference: string | null;
    status: 'assignment_required' | 'collecting_materials'; materialCount: number;
    allowed_actions: string[]; updatedAt: string;
  })[];
  recentActivity: {
    id: string; caseId: string; caseTitle: string;
    action: 'case.created' | 'case.assigned' | 'material:register';
    actorName: string | null; createdAt: string;
  }[];
}

const countFormatter = new Intl.NumberFormat('zh-CN');
const activityLabels: Record<WorkbenchData['recentActivity'][number]['action'], string> = {
  'case.created': '创建案件', 'case.assigned': '指派经办人员', 'material:register': '登记材料',
};

export function WorkbenchPage() {
  const {session} = useAuth();
  const navigate = useNavigate();
  const [days, setDays] = useState<7 | 30>(30);
  const query = useQuery({
    queryKey: ['workbench', days],
    queryFn: ({signal}) => api<WorkbenchData>(`/api/workbench?days=${days}`, {signal}),
    refetchInterval: 30_000,
    placeholderData: previous => previous,
  });
  const canCreate = can(session.allowed_actions, 'case:create');
  const canManageAccounts = can(session.allowed_actions, 'account:manage');
  const canManage = session.allowed_actions.some(action => ['account:manage', 'permission:manage', 'audit:read', 'system:status'].includes(action));
  const data = blocksView(query) ? undefined : query.data;
  const statusMetrics = Object.entries(data?.statusCounts ?? {}).filter(([status]) => status !== 'stale');
  const showWorkItems = canCreate || !can(session.allowed_actions, 'checker:read') || !!data?.workItems.length;
  const workColumns: TableProps<WorkbenchData['workItems'][number]>['columns'] = [
    {title: '案件', key: 'case', width: 220, render: (_, item) => <><Link className="table-main" to={caseMaterialsPath(item.caseId)}>{item.caseNumber || caseDisplayName({...item, id: item.caseId})}</Link>{item.caseNumber && item.title && item.title !== item.caseNumber && <span className="table-sub">{item.title}</span>}{item.reference && <span className="table-sub">{item.reference}</span>}<span className="table-sub">更新于 <time dateTime={item.updatedAt}>{formatTime(item.updatedAt)}</time></span></>},
    {title: '状态', key: 'status', width: 120, render: (_, item) => <><CaseStatus status={item.preReviewStatus??item.status} plain/>{!!item.outstandingCount&&<span className="table-sub">剩余 {item.outstandingCount} 项</span>}</>},
    {title:'担保 / 主体',key:'parties',width:240,render:(_,item)=><><div>{item.guaranteeTypes?.map(t=>GUARANTEE_LABELS[t]??t).join('、')||'担保类型待确认'}</div><span className="table-sub">借款人：{item.borrowers?.join('、')||'待确认'} · 担保人：{item.guarantors?.join('、')||'待确认'}</span></>},
    {title:'轮次与材料',key:'round',width:150,render:(_,item)=><>{item.roundNumber?`第 ${item.roundNumber} 轮`:item.roundsEnabled?'待准备':'历史未分轮'} · {item.materialCount} 份材料{item.roundsEnabled&&<span className="table-sub">{item.latestCompletedRoundNumber?`最近完成：第 ${item.latestCompletedRoundNumber} 轮`:'尚无完成轮次'}</span>}</>},
    {title: '下一步', key: 'next', width: 110, render: (_, item) => {const step = nextStep(item.caseId, item); return <Link to={step.to}>{step.label}</Link>;}},
  ];

  return <div className="workbench">
    <PageHeader title="工作台" actions={canCreate ? <Button type="primary" onClick={() => navigate('/cases/new')}>新建案件</Button> : undefined}/>
    {query.isPending ? <section className="wb-panel"><Loading label="正在加载工作台"/></section>
      : !data ? <section className="wb-panel wb-error"><ErrorNotice error={query.error} retry={() => void query.refetch()}/></section>
        : <>
          <RefreshNotice query={query} retry={() => void query.refetch()}/>
          <div className="wb-metrics-band">
          <dl className="wb-metrics" aria-label="案件与材料概况">
            {[
              {label: '可访问案件', value: data.counts.accessibleCases},
              {label: '我负责的案件', value: data.counts.myCases},
              {label: '待我指派', value: data.counts.awaitingAssignment},
              {label: '已登记材料', value: data.counts.registeredMaterials, title: '按已登记的材料版本计数'},
            ].map(metric => <div key={metric.label} title={metric.title}><dt>{metric.label}</dt><dd>{countFormatter.format(metric.value)}</dd></div>)}
          </dl>
          {showWorkItems && statusMetrics.length > 0 && <dl className="wb-metrics wb-metrics-status" aria-label="全部可访问案件的预审状态">{statusMetrics.map(([status,count])=><div key={status}><dt>{caseStatuses[status]?.label??status}</dt><dd>{count}</dd></div>)}</dl>}
          </div>
          <div className="wb-layout">
            <div className="wb-main">
              <CheckerInbox/>
              {showWorkItems && <Section title="待办与我的案件" flush info={<span className="wb-section-label">待办与我的案件（最多 6 项）</span>} actions={<Link to="/cases">全部案件</Link>}>
                {data.workItems.length ? <Table rowKey="caseId" size="middle" columns={workColumns} dataSource={data.workItems} pagination={false} scroll={{x: 820}}/> : <div className="wb-empty"><p>暂无待处理事项</p>{canCreate ? <Link to="/cases/new">新建案件</Link> : null}</div>}
              </Section>}
              <Section title="最近动态" flush info={<span className="wb-section-label">最近动态</span>}>
                {data.recentActivity.length ? <ul className="wb-activity-list">{data.recentActivity.map(activity => <li key={activity.id}>
                  <time className="mono" dateTime={activity.createdAt}>{formatTime(activity.createdAt)}</time>
                  <span className="wb-activity-actor">{activity.actorName ?? '经办人员'}</span>
                  <span className="wb-activity-action">{activityLabels[activity.action]}</span>
                  <Link to={caseMaterialsPath(activity.caseId)}>{activity.caseTitle}</Link>
                </li>)}</ul> : <div className="wb-empty"><p>暂无案件动态</p></div>}
              </Section>
            </div>
            <aside className="wb-side" aria-label="工作台操作">
              <NextAction data={data} canCreate={canCreate} canManage={canManage} canManageAccounts={canManageAccounts}/>
              <section className="wb-panel wb-trend" aria-labelledby="wb-trend-heading" aria-busy={query.isPlaceholderData}>
                <div className="wb-section-heading">
                  <div><h2 id="wb-trend-heading">材料登记趋势</h2><p className="wb-trend-total"><strong>{countFormatter.format(data.materialTrend.reduce((sum, day) => sum + day.count, 0))}</strong><span>份 · 最近 {data.periodDays} 天</span></p></div>
                  <Segmented<number> aria-label="材料登记趋势时间范围" name="material-trend-period" value={days} options={[{label: '7 天', value: 7}, {label: '30 天', value: 30}]} onChange={value => setDays(value === 7 ? 7 : 30)}/>
                </div>
                {query.isPlaceholderData && <p className="wb-trend-updating" role="status">正在更新趋势…</p>}
                <MaterialTrend points={data.materialTrend}/>
              </section>
            </aside>
          </div>
        </>}
  </div>;
}

function NextAction({data, canCreate, canManage, canManageAccounts}: {data: WorkbenchData; canCreate: boolean; canManage: boolean; canManageAccounts: boolean}) {
  const nextCase = data.workItems[0];
  let heading = '查看案件';
  let description = '';
  let label = '进入案件列表';
  let destination = '/cases';
  if (nextCase) {
    const step = nextStep(nextCase.caseId, nextCase);
    heading = nextCase.status === 'assignment_required' && can(nextCase.allowed_actions, 'case:assign') ? '安排经办人员' : '继续办理案件';
    description = nextCase.title;
    label = step.label;
    destination = step.to;
  } else if (canCreate) {
    heading = '开始新的案件';
    label = '新建案件';
    destination = '/cases/new';
  } else if (canManage) {
    heading = canManageAccounts ? '管理团队账号' : '系统管理';
    label = canManageAccounts ? '管理账号' : '进入系统管理';
    destination = '/system';
  }
  return <section className="wb-next-action" aria-labelledby="wb-next-heading"><span className="wb-next-label">下一步</span><h2 id="wb-next-heading">{heading}</h2>{description && <p>{description}</p>}<Link to={destination}>{label}</Link></section>;
}

function MaterialTrend({points}: {points: WorkbenchData['materialTrend']}) {
  const id = useId();
  const max = Math.max(1, ...points.map(point => point.count));
  const ceiling = max === 1 ? 1 : Math.ceil(max / 4) * 4;
  const ticks = ceiling === 1 ? [1, 0] : [ceiling, ceiling / 2, 0];
  const left = 38;
  const right = 630;
  const top = 18;
  const bottom = 120;
  const x = (index: number) => points.length > 1 ? left + index * (right - left) / (points.length - 1) : (left + right) / 2;
  const y = (count: number) => bottom - count / ceiling * (bottom - top);
  const line = points.map((point, index) => `${index ? 'L' : 'M'}${x(index)},${y(point.count)}`).join(' ');
  const area = points.length ? `${line} L${x(points.length - 1)},${bottom} L${x(0)},${bottom} Z` : '';
  const total = points.reduce((sum, point) => sum + point.count, 0);
  const labelIndices = [...new Set([0, Math.floor((points.length - 1) / 2), points.length - 1])].filter(index => index >= 0 && index < points.length);

  return <div className="wb-chart">
    <svg viewBox="0 0 650 150" role="img" aria-labelledby={`${id}-title ${id}-description`}>
      <title id={`${id}-title`}>每日材料登记数量</title>
      <desc id={`${id}-description`}>{points.length ? `${points[0]!.date} 至 ${points[points.length - 1]!.date}，共登记 ${total} 份材料。下方可展开每日数据。` : '暂无登记数据。'}</desc>
      <defs><linearGradient id={`${id}-fill`} x1="0" x2="0" y1="0" y2="1"><stop offset="0%" stopColor="var(--primary, #DB0011)" stopOpacity="0.1"/><stop offset="100%" stopColor="var(--primary, #DB0011)" stopOpacity="0.015"/></linearGradient></defs>
      {ticks.map(tick => <g key={tick}><line x1={left} x2={right} y1={y(tick)} y2={y(tick)} className="wb-chart-grid"/><text x={left - 10} y={y(tick) + 4} textAnchor="end" className="wb-chart-label">{countFormatter.format(tick)}</text></g>)}
      {area && <path d={area} fill={`url(#${id}-fill)`}/>}
      {line && <path d={line} fill="none" className="wb-chart-line"/>}
      {points.filter(point => point.count > 0).length === 1 && points.map((point, index) => point.count > 0 ? <circle key={point.date} cx={x(index)} cy={y(point.count)} r="3.5" fill="var(--primary, #DB0011)"/> : null)}
      {labelIndices.map(index => <text key={points[index]!.date} x={x(index)} y={144} textAnchor={index === 0 ? 'start' : index === points.length - 1 ? 'end' : 'middle'} className="wb-chart-label">{points[index]!.date.slice(5).replace('-', '/')}</text>)}
    </svg>
    {!total && <p className="wb-chart-empty">这段时间暂无材料登记</p>}
    <details className="wb-chart-data"><summary>查看每日数据</summary><div><table><caption>每日材料登记数量（新加坡时间）</caption><thead><tr><th scope="col">日期</th><th scope="col">登记数量</th></tr></thead><tbody>{points.map(point => <tr key={point.date}><td><time dateTime={point.date}>{point.date}</time></td><td>{point.count}</td></tr>)}</tbody></table></div></details>
  </div>;
}
