import {ReviewTeams} from '../features/administration/review-teams.tsx';
import type {SystemCapabilities} from '../capabilities.ts';
import React, {useEffect, useRef, useState} from 'react';
import {Button, Descriptions, Drawer, Form, Input, Modal, Select, Table, Tabs, Tag, Typography} from 'antd';
import type {TableProps} from 'antd';
import {useQuery} from '@tanstack/react-query';
import {useLocation, useNavigate} from 'react-router';
import {api, queryClient} from '../api.ts';
import {can} from '../features/identity/permissions.ts';
import {formatTime} from '../shared/format.ts';
import {useAuth} from '../auth.tsx';
import type {Account, AccessGrant, AuthEvent, Person, TemporaryPassword} from '../features/administration/types.ts';
import {ActionModal, blocksView, CopyValue, ErrorNotice, Forbidden, Loading, PageHeader, ReasonField, RefreshNotice, Section, useCrumbs, useRestoreFocus, useStickyTop} from '../ui.tsx';

const adminPages = [{path: '/system/accounts', label: '账号管理', action: 'account:manage'}, {path: '/system/people', label: '人员岗位', action: 'account:manage'}, {path: '/system/permissions', label: '权限管理', action: 'permission:manage'}, {path: '/system/audit', label: '操作审计', action: 'audit:read'}, {path: '/system/status', label: '运行状态', action: 'system:status'}];
export function AdminPage() {
  const {session} = useAuth();
  const {pathname} = useLocation();
  const navigate = useNavigate();
  const pages = adminPages.filter(page => can(session.allowed_actions, page.action));
  const active = adminPages.find(page => page.path === pathname) ?? pages[0];
  useCrumbs([{title: '系统管理', to: pages[0]?.path}, {title: active?.label ?? '系统管理'}]);
  if (!active || !can(session.allowed_actions, active.action)) return <Forbidden/>;
  return <><PageHeader title="系统管理" extra={<Tabs className="header-tabs" activeKey={active.path} items={pages.map(page => ({key: page.path, label: page.label}))} onChange={path => navigate(path)}/>}/>{active.path === '/system/people' ? <People/> : active.action === 'account:manage' ? <Accounts/> : active.action === 'permission:manage' ? <><ReviewTeams/><Permissions/></> : active.action === 'audit:read' ? <Audit/> : <SystemStatus/>}</>;
}
const roleText = (role?: 'RM' | 'BCO' | null) => role === 'RM' ? 'RM' : role === 'BCO' ? 'BCO' : '未设置岗位';
/** People are identified by name, role and a short id because display names repeat. */
export const personLabel = (person: Person) => `${person.displayName} · ${roleText(person.businessRole ?? person.business_role)} · ${person.id.slice(0, 6)}`;
function Accounts() {
  const {session} = useAuth();
  const stickyTop = useStickyTop();
  const [edit, setEdit] = useState<{action: 'create' | 'disable' | 'enable' | 'reset'; account?: Account}>();
  const [secret, setSecret] = useState<TemporaryPassword>();
  const [filter, setFilter] = useState('');
  const query = useQuery({queryKey: ['accounts'], queryFn: ({signal}) => api<{items: Account[]}>('/api/admin/accounts', {signal})});
  const labels = {create: '创建账号', disable: '停用账号', enable: '启用账号', reset: '重置密码'};
  const items = (query.data?.items ?? []).filter(account => !filter || `${account.displayName} ${account.username}`.toLowerCase().includes(filter.toLowerCase()));
  const columns: TableProps<Account>['columns'] = [
    {title: '人员', key: 'person', render: (_, account) => <>{account.displayName}{account.id === session.user?.accountId && <span className="muted">（当前账号）</span>}</>},
    {title: '账号', dataIndex: 'username', width: 260, render: value => <span className="mono">{value}</span>},
    {title: '账号状态', key: 'status', width: 180, render: (_, account) => <span className="status-cell">{account.enabled ? <span className="status-text">启用</span> : <Tag className="tag-neutral">停用</Tag>}{account.mustChangePassword && <Tag className="tag-warning">需改密</Tag>}</span>},
    {title: '操作', key: 'actions', width: 200, fixed: 'right', render: (_, account) => account.businessRole === 'RM' ? <span className="muted">历史 RM 账号</span> : account.id === session.user?.accountId ? <span className="muted">请在账号菜单中修改密码</span> : <div className="row-actions"><Button type="link" onClick={() => setEdit({action: 'reset', account})}>重置密码</Button><Button type="link" onClick={() => setEdit({action: account.enabled ? 'disable' : 'enable', account})}>{account.enabled ? '停用' : '启用'}</Button></div>},
  ];
  return <Section title="账号" flush info={<><Input.Search className="toolbar-search" aria-label="按姓名或账号筛选" placeholder="按姓名或账号筛选" allowClear onSearch={setFilter} onChange={event => {if (!event.target.value) setFilter('');}}/>{query.data && <span>共 {items.length} 个账号</span>}</>} actions={<Button type="primary" onClick={() => setEdit({action: 'create'})}>创建账号</Button>}>
    {blocksView(query) ? <div className="section-notice"><ErrorNotice error={query.error} retry={() => void query.refetch()}/></div> : <div className="section-notice"><RefreshNotice query={query} retry={() => void query.refetch()}/></div>}
    {query.isPending ? <Loading/> : !blocksView(query) && <Table<Account> rowKey="id" columns={columns} dataSource={items} scroll={{x: 760}} sticky={{offsetHeader: stickyTop}} pagination={{pageSize: 20, hideOnSinglePage: true, showSizeChanger: false, showTotal: total => `共 ${total} 个`}} locale={{emptyText: '暂无账号'}}/>}
    {edit && <AccountDialog edit={edit} title={labels[edit.action]} close={() => setEdit(undefined)} done={result => {setEdit(undefined); if (result?.temporaryPassword) setSecret(result); void query.refetch();}}/>}
    {secret && <SecretDialog value={secret} close={() => setSecret(undefined)}/>}
  </Section>;
}
function AccountDialog({edit, title, close, done}: {edit: {action: 'create' | 'disable' | 'enable' | 'reset'; account?: Account}; title: string; close: () => void; done: (value?: TemporaryPassword) => void}) {
  useRestoreFocus();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<unknown>();
  const people = useQuery({queryKey: ['people'], enabled: edit.action === 'create', queryFn: ({signal}) => api<{items: Person[]}>('/api/admin/people', {signal})});
  const warning = edit.action === 'disable' ? '停用后，该账号将退出登录，停用期间无法登录。' : edit.action === 'reset' ? '重置后，该账号将退出登录，须使用新的临时密码登录并改密。' : edit.action === 'create' ? '首次登录须修改临时密码。' : undefined;
  return <ActionModal title={title} okText={title} danger={edit.action === 'disable'} pending={pending} onCancel={close} width={edit.action === 'create' ? 640 : 520}
    summary={edit.account ? <dl><dt>人员</dt><dd>{edit.account.displayName}</dd><dt>账号</dt><dd className="mono">{edit.account.username}</dd><dt>当前状态</dt><dd>{edit.account.enabled ? '启用' : '停用'}</dd></dl> : undefined}
    warning={warning} error={<ErrorNotice error={error} retry={() => {void queryClient.invalidateQueries({queryKey: ['accounts']}); close();}}/>}
    onFinish={async (values: {username?: string; displayName?: string; personId?: string; businessRole?: 'BCO'; reason: string}) => {setPending(true); setError(undefined); try {const response = await api<TemporaryPassword>(edit.action === 'create' ? '/api/admin/accounts' : `/api/admin/accounts/${edit.account!.id}/${edit.action}`, {method: 'POST', body: edit.action === 'create' ? {...values, businessRole: values.personId?.trim() ? undefined : values.businessRole, personId: values.personId?.trim() || undefined} : {reason: values.reason, expectedVersion: edit.account!.version}}); void queryClient.invalidateQueries({queryKey: ['workbench']}); done(response);} catch (failure) {setError(failure);} finally {setPending(false);}}}>
    {edit.action === 'create' && <><Form.Item name="displayName" label="人员姓名" rules={[{required: true, whitespace: true, max: 100, message: '请输入人员姓名'}]}><Input maxLength={100} autoFocus/></Form.Item><Form.Item name="username" label="账号" rules={[{required: true, pattern: /^[a-zA-Z0-9][a-zA-Z0-9._@-]{2,99}$/, message: '使用 3–100 位英文字母、数字、点、@、下划线或连字符'}]}><Input autoComplete="off" maxLength={100}/></Form.Item><Form.Item name="businessRole" label="新人员岗位（选填）" extra="关联已有人员时沿用该人员的岗位。"><Select allowClear options={[{value: 'BCO', label: 'BCO · 业务办理'}]}/></Form.Item><Form.Item name="personId" label="关联已有人员（选填）" extra="同一人新增账号时请选择已有人员；留空会创建新人员。"><Select allowClear showSearch={{optionFilterProp: 'label'}} loading={people.isPending} options={people.data?.items.filter(person => person.enabled && (person.businessRole ?? person.business_role) !== 'RM').map(person => ({value: person.id, label: personLabel(person)}))} notFoundContent="暂无已有人员"/></Form.Item></>}
    <ReasonField label="操作原因" autoFocus={edit.action !== 'create'}/>
  </ActionModal>;
}
function SecretDialog({value, close}: {value: TemporaryPassword; close: () => void}) {
  useRestoreFocus();
  const clearAt = useRef(Math.min(Date.now() + 60_000, new Date(value.expiresAt).getTime()));
  const [left, setLeft] = useState(() => Math.max(0, Math.round((clearAt.current - Date.now()) / 1000)));
  useEffect(() => {const timer = setInterval(() => {const remaining = Math.max(0, Math.round((clearAt.current - Date.now()) / 1000)); setLeft(remaining); if (!remaining) close();}, 1000); return () => clearInterval(timer);}, [close]);
  const grouped = value.temporaryPassword.match(/.{1,4}/g)?.join(' ') ?? value.temporaryPassword;
  return <Modal title="临时密码仅显示一次" open closable={false} keyboard={false} mask={{closable: false}} footer={<Button type="primary" onClick={close}>已记录，关闭</Button>} destroyOnHidden><p>请通过团队认可的方式将临时密码交给本人。关闭后无法再次查看，{left} 秒后自动清除。</p><div className="action-summary"><dl><dt>人员</dt><dd>{value.account?.displayName}</dd><dt>账号</dt><dd className="mono">{value.account?.username}</dd></dl></div><p className="temporary-secret" aria-label={`临时密码：${value.temporaryPassword.split('').join(' ')}`}>{grouped}</p><Typography.Text copyable={{text: value.temporaryPassword, tooltips: ['复制临时密码', '已复制']}}>复制</Typography.Text><p className="muted">有效期至 {formatTime(value.expiresAt)}，首次登录必须改密。显示时每 4 位用空格分组，空格不属于密码。</p></Modal>;
}
const grantOptions = [
  ['checker','独立复核资格（Checker）'], ['checker:read','读取内部复核记录'], ['checker:comment','记录复核意见'], ['checker:confirm','确认本轮复核'], ['checker:correct','复核人直接更正'], ['maker:submit','经办提交复核'], ['consultation:record','录入专业意见'], ['exception:decide','登记例外决定'],
  ['maker', '经办资格（Maker）'], ['case:read', '查看案件'], ['case:create', '创建案件'], ['case:assign', '指派经办人员'], ['case:confirm-scenario', '确认业务场景'], ['document:parse', '解析材料'], ['document:authorize', '审批合成材料处理授权'], ['document:translate', '锁定轮参考翻译'], ['document:classify', '确认材料分类'], ['material:upload', '上传材料'], ['evidence:read', '读取原件'],
  ['case:configure', '绑定审核配置'], ['case:start', '启动案件检查'], ['case:close','复核后完结或明确终止'], ['report:read','读取预审邮件'], ['report:generate','生成预审邮件'], ['report:export','复制预审邮件'], ['review:analyze','生成辅助语义核对与轮次比较'], ['review:formal','发起正式云审核'], ['material:adopt', '管理本轮材料'], ['field:correct', '确认与更正对象及事实'], ['finding:decide', '记录问题反馈与处置'],
  ['rule:read', '查看规则配置'], ['rule:propose', '编写与校验规则配置'], ['rule:trial', '运行规则试例'], ['rule:approve', '批准规则配置'], ['rule:publish', '发布规则配置'],
  ['account:manage', '管理账号'], ['permission:manage', '管理授权'], ['audit:read', '查看操作审计'], ['system:status', '查看运行状态'],
].map(([value, label]) => ({value, label}));
function Permissions() {
  const {session} = useAuth();
  const stickyTop = useStickyTop();
  const [open, setOpen] = useState(false);
  const [revoke, setRevoke] = useState<AccessGrant>();
  const query = useQuery({queryKey: ['grants'], queryFn: ({signal}) => api<{items: AccessGrant[]}>('/api/admin/access-grants', {signal})});
  const people = useQuery({queryKey: ['people'], queryFn: ({signal}) => api<{items: Person[]}>('/api/admin/people', {signal})});
  const person = (id: string) => people.data?.items.find(entry => entry.id === id);
  const columns: TableProps<AccessGrant>['columns'] = [
    {title: '人员', dataIndex: 'personId', render: id => {const entry = person(id); return entry ? <>{entry.displayName} <span className="muted">· {roleText(entry.businessRole ?? entry.business_role)}</span>{id === session.user?.personId && <span className="muted">（当前账号）</span>}</> : <span className="mono">{id.slice(0, 8)}</span>;}},
    {title: '授权操作', dataIndex: 'action', render: action => grantOptions.find(option => option.value === action)?.label ?? action},
    {title: '授权范围', dataIndex: 'caseId', width: 180, render: id => id ? <span className="mono" title={id}>案件 {id.slice(0, 8)}</span> : '全局'},
    {title: '授予时间', dataIndex: 'createdAt', width: 180, render: time => <span className="mono">{formatTime(time)}</span>},
    {title: '操作', key: 'actions', width: 140, fixed: 'right', render: (_, grant) => grant.personId === session.user?.personId ? <span className="muted">不可撤销本人授权</span> : <div className="row-actions"><Button type="link" onClick={() => setRevoke(grant)}>撤销</Button></div>},
  ];
  return <Section title="业务授权" flush info={query.data && <span>共 {query.data.items.length} 条授权</span>} actions={<Button type="primary" onClick={() => setOpen(true)}>授予权限</Button>}>
    <div className="section-notice">{blocksView(query) || blocksView(people) ? <ErrorNotice error={query.error || people.error} retry={() => {void query.refetch(); void people.refetch();}}/> : <RefreshNotice query={query} retry={() => void query.refetch()}/>}</div>
    {query.isPending ? <Loading/> : !blocksView(query) && <Table<AccessGrant> rowKey="id" columns={columns} dataSource={query.data?.items ?? []} scroll={{x: 860}} sticky={{offsetHeader: stickyTop}} pagination={{pageSize: 20, hideOnSinglePage: true, showSizeChanger: false, showTotal: total => `共 ${total} 条`}} locale={{emptyText: '暂无授权记录'}}/>}
    {(open || revoke) && <GrantDialog people={people.data?.items.filter(entry => entry.enabled && (entry.businessRole ?? entry.business_role) !== 'RM') ?? []} revoke={revoke} revokePerson={revoke ? person(revoke.personId) : undefined} close={() => {setOpen(false); setRevoke(undefined);}} done={() => {setOpen(false); setRevoke(undefined); void query.refetch(); void queryClient.invalidateQueries({queryKey: ['workbench']});}}/>}
  </Section>;
}
function GrantDialog({people, revoke, revokePerson, close, done}: {people: Person[]; revoke?: AccessGrant; revokePerson?: Person; close: () => void; done: () => void}) {
  useRestoreFocus();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<unknown>();
  return <ActionModal title={revoke ? '撤销授权' : '授予权限'} okText={revoke ? '确认撤销' : '授予权限'} danger={!!revoke} pending={pending} onCancel={close}
    summary={revoke ? <dl><dt>人员</dt><dd>{revokePerson ? personLabel(revokePerson) : revoke.personId}</dd><dt>授权操作</dt><dd>{grantOptions.find(option => option.value === revoke.action)?.label ?? revoke.action}</dd><dt>授权范围</dt><dd>{revoke.caseId ? <span className="mono">案件 {revoke.caseId.slice(0, 8)}</span> : '全局'}</dd></dl> : undefined}
    warning={revoke ? '撤销后该人员须重新登录。' : undefined} error={<ErrorNotice error={error}/>}
    onFinish={async (values: {personId: string; action: string; caseId?: string; reason: string}) => {setPending(true); setError(undefined); try {await api(revoke ? `/api/admin/access-grants/${revoke.id}/revoke` : '/api/admin/access-grants', {method: 'POST', body: revoke ? {reason: values.reason} : {...values, caseId: values.caseId?.trim() || null}}); done();} catch (failure) {setError(failure);} finally {setPending(false);}}}>
    {!revoke && <><Form.Item name="personId" label="人员" rules={[{required: true, message: '请选择人员'}]}><Select autoFocus showSearch={{optionFilterProp: 'label'}} options={people.map(entry => ({value: entry.id, label: personLabel(entry)}))}/></Form.Item><Form.Item name="action" label="授权操作" rules={[{required: true, message: '请选择操作'}]}><Select showSearch={{optionFilterProp: 'label'}} options={grantOptions}/></Form.Item><Form.Item name="caseId" label="案件编号（选填）" extra="留空表示该操作的全局授权；管理类操作应留空。"><Input autoComplete="off"/></Form.Item></>}
    <ReasonField label={revoke ? '撤销原因' : '授权原因'} autoFocus={!!revoke}/>
  </ActionModal>;
}
const auditActions: Record<string, string> = {'auth.login': '登录', 'auth.logout': '退出登录', 'auth.password_changed': '修改密码', 'account.created': '创建账号', 'account.disable': '停用账号', 'account.enable': '启用账号', 'account.reset': '重置密码', 'permission.granted': '授予权限', 'permission.revoked': '撤销授权', 'person.business_role_changed': '变更人员岗位', 'case.scenario_confirmed': '确认业务场景', 'document:parse_document': '解析材料', 'document:classify': '更正材料目录', 'document:compare_document_versions': '比较文件版本', 'document:extract_fields': '提取字段', 'case.created': '创建案件', 'case.assigned': '指派经办人员', 'upload:issue': '申请上传', 'upload:complete': '提交核验', 'upload:cancel': '取消上传', 'material:register': '登记材料', 'evidence:read': '读取原件'};
const auditResults: Record<string, string> = {success: '成功', denied: '未获允许', rate_limited: '操作过于频繁'};
function Audit() {
  const stickyTop = useStickyTop();
  const [detailId, setDetailId] = useState<string>();
  const query = useQuery({queryKey: ['auth-events'], queryFn: ({signal}) => api<{items: AuthEvent[]}>('/api/admin/auth-events', {signal})});
  const selectedEvent = query.data?.items.find(event => event.id === detailId);
  const columns: TableProps<AuthEvent>['columns'] = [
    {title: '时间', dataIndex: 'createdAt', width: 180, render: time => <time className="mono" dateTime={time}>{formatTime(time)}</time>},
    {title: '操作', dataIndex: 'action', render: action => auditActions[action] ?? action},
    {title: '结果', dataIndex: 'result', width: 140, render: result => result === 'success' ? <span className="status-text">{auditResults[result]}</span> : <Tag className="tag-warning">{auditResults[result] ?? result}</Tag>},
    {title: '操作者编号', dataIndex: 'actorId', width: 160, render: value => value ? <span className="mono" title={value}>{value.slice(0, 8)}</span> : <span className="muted">无</span>},
    {title: '详情', key: 'details', width: 90, fixed: 'right', render: (_, event) => <div className="row-actions"><Button type="link" onClick={() => setDetailId(event.id)}>查看</Button></div>},
  ];
  return <Section title="操作审计" flush info={query.data && <span>显示最近 {query.data.items.length} 条</span>} actions={<Button onClick={() => void query.refetch()} loading={query.isFetching}>刷新</Button>}>
    <div className="section-notice">{blocksView(query) ? <ErrorNotice error={query.error}/> : <RefreshNotice query={query} retry={() => void query.refetch()}/>}</div>
    {query.isPending ? <Loading/> : !blocksView(query) && <Table<AuthEvent> rowKey="id" columns={columns} dataSource={query.data?.items ?? []} scroll={{x: 760}} sticky={{offsetHeader: stickyTop}} pagination={{pageSize: 20, hideOnSinglePage: true, showSizeChanger: false, showTotal: total => `共 ${total} 条`}} locale={{emptyText: '暂无审计记录'}}/>}
    {selectedEvent && !blocksView(query) && <AuditDetails event={selectedEvent} close={() => setDetailId(undefined)}/>}
  </Section>;
}
function AuditDetails({event, close}: {event: AuthEvent; close: () => void}) {
  useRestoreFocus();
  return <Drawer title="操作详情" open onClose={close} size="min(520px, 100vw)" destroyOnHidden classNames={{body: 'detail-drawer'}}><dl className="detail-list"><div><dt>操作</dt><dd>{auditActions[event.action] ?? event.action}</dd></div><div><dt>结果</dt><dd>{auditResults[event.result] ?? event.result}</dd></div><div><dt>时间</dt><dd>{formatTime(event.createdAt)}</dd></div><div><dt>记录编号</dt><dd><CopyValue value={event.id} label="记录编号"/></dd></div><div><dt>操作者编号</dt><dd>{event.actorId ? <CopyValue value={event.actorId} label="操作者编号"/> : '无'}</dd></div><div><dt>目标编号</dt><dd>{event.targetId ? <CopyValue value={event.targetId} label="目标编号"/> : '无'}</dd></div></dl></Drawer>;
}
function SystemStatus() {
  const query = useQuery({queryKey: ['system-status'], queryFn: ({signal}) => api<{version: string; services: {name: 'database' | 'taskRecovery' | 'objectStorage'; status: 'ready' | 'waiting' | 'configured' | 'disabled'}[]; capabilities: SystemCapabilities; updatedAt: string}>('/api/system/status', {signal}), refetchInterval: 30_000});
  const names = {database: '数据存储', taskRecovery: '任务恢复', objectStorage: '原件存储'};
  const states = {ready: '就绪', waiting: '等待连接', configured: '已配置', disabled: '未启用'};
  const data = blocksView(query) ? undefined : query.data;
  return <Section title="运行状态" info={data && <span>状态更新于 {formatTime(data.updatedAt)}</span>} actions={<Button onClick={() => void query.refetch()} loading={query.isFetching}>刷新</Button>}>
    {blocksView(query) ? <ErrorNotice error={query.error}/> : <RefreshNotice query={query} retry={() => void query.refetch()}/>}
    {query.isPending ? <Loading/> : data && <Descriptions size="small" colon={false} column={{xxl: 3, xl: 3, lg: 2, md: 2, sm: 1, xs: 1}} styles={{label: {width: 140, whiteSpace: 'nowrap', color: 'var(--muted)'}}} items={[
      ...data.services.map(service => ({key: service.name, label: names[service.name], children: service.status === 'waiting' ? <Tag className="tag-warning">{states[service.status]}</Tag> : <span className="status-text">{states[service.status]}</span>})),
      ...([['registration', '原件登记'], ['parsing', '材料解析'], ['automaticPreparse', '登记后自动解析'], ['documentReader', '原件与证据阅读'], ['logicalDirectory', '材料目录'], ['evidenceSearch', '证据检索'], ['versionComparison', '版本比较'], ['cloudReview', '云端审核']] as const).map(([key, label]) => ({key, label, children: data.capabilities[key] ? '已启用' : <span className="muted">未启用</span>})),
    ]}/>}
  </Section>;
}

function People() {
  const {session} = useAuth();
  const stickyTop = useStickyTop();
  const [selected, setSelected] = useState<Person>();
  const [filter, setFilter] = useState('');
  const query = useQuery({queryKey: ['people'], queryFn: ({signal}) => api<{items: Person[]}>('/api/admin/people', {signal})});
  const selectedPerson = query.data?.items.find(person => person.id === selected?.id);
  const items = (query.data?.items ?? []).filter(person => !filter || person.displayName.toLowerCase().includes(filter.toLowerCase()));
  const columns: TableProps<Person>['columns'] = [
    {title: '人员', key: 'person', render: (_, person) => <>{person.displayName}{person.id === session.user?.personId && <span className="muted">（当前账号）</span>}</>},
    {title: '人员编号', dataIndex: 'id', width: 140, render: id => <span className="mono" title={id}>{id.slice(0, 8)}</span>},
    {title: '业务岗位', key: 'role', width: 140, render: (_, person) => (person.businessRole ?? person.business_role) ? <span className="status-text">{person.businessRole ?? person.business_role}</span> : <span className="muted">未设置</span>},
    {title: '人员状态', key: 'enabled', width: 120, render: (_, person) => person.enabled ? <span className="status-text">启用</span> : <Tag className="tag-neutral">停用</Tag>},
    {title: '操作', key: 'actions', width: 140, fixed: 'right', render: (_, person) => (person.businessRole ?? person.business_role) === 'RM' ? <span className="muted">历史岗位记录</span> : person.id === session.user?.personId ? <span className="muted">不可修改本人岗位</span> : <div className="row-actions"><Button type="link" onClick={() => setSelected(person)}>维护岗位</Button></div>},
  ];
  return <Section title="人员岗位" flush info={<><Input.Search className="toolbar-search" aria-label="按姓名筛选" placeholder="按姓名筛选" allowClear onSearch={setFilter} onChange={event => {if (!event.target.value) setFilter('');}}/><span>岗位、操作授权与案件指派分别维护</span></>}>
    <div className="section-notice">{blocksView(query) ? <ErrorNotice error={query.error} retry={() => void query.refetch()}/> : <RefreshNotice query={query} retry={() => void query.refetch()}/>}</div>
    {query.isPending ? <Loading/> : !blocksView(query) && <Table<Person> rowKey="id" columns={columns} dataSource={items} sticky={{offsetHeader: stickyTop}} pagination={{pageSize: 20, hideOnSinglePage: true, showSizeChanger: false, showTotal: total => `共 ${total} 人`}} scroll={{x: 680}}/>}
    {selectedPerson && !blocksView(query) && <BusinessRoleDialog person={selectedPerson} close={() => setSelected(undefined)} done={() => {setSelected(undefined); void query.refetch(); void queryClient.invalidateQueries({queryKey: ['assignment-candidates']});}}/>}
  </Section>;
}
function BusinessRoleDialog({person, close, done}: {person: Person; close: () => void; done: () => void}) {
  useRestoreFocus();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<unknown>();
  if ((person.businessRole ?? person.business_role) === 'RM') return null;
  return <ActionModal title="维护业务岗位" okText="保存岗位" pending={pending} onCancel={close} initialValues={{businessRole: person.businessRole ?? person.business_role ?? null}}
    summary={<dl><dt>人员</dt><dd>{person.displayName}</dd><dt>人员编号</dt><dd className="mono">{person.id.slice(0, 8)}</dd><dt>当前岗位</dt><dd>{roleText(person.businessRole ?? person.business_role)}</dd></dl>}
    warning="变更岗位后，该人员须重新登录。" error={<ErrorNotice error={error}/>}
    onFinish={async (values: {businessRole: 'BCO' | null; reason: string}) => {setPending(true); setError(undefined); try {await api(`/api/admin/people/${person.id}/business-role`, {method: 'POST', body: {...values, businessRole: values.businessRole ?? null, expectedVersion: person.version}}); done();} catch (failure) {setError(failure);} finally {setPending(false);}}}>
    <Form.Item name="businessRole" label="新业务岗位"><Select autoFocus allowClear placeholder="未设置" options={[{value: 'BCO', label: 'BCO · 业务办理'}]}/></Form.Item>
    <ReasonField label="变更原因"/>
  </ActionModal>;
}
