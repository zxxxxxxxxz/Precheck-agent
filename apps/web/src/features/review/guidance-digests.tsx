import React, {useState} from 'react';
import {Button, Checkbox, Form, Input, Table} from 'antd';
import {useQuery} from '@tanstack/react-query';
import {Link} from 'react-router';
import {SEMANTIC_GUIDANCE_KIND_LABELS, type GuidanceDigestEntry, type GuidanceDigestView} from '@hsbc/contracts/review-guidance';
import {api, newKey, queryClient} from '../../api.ts';
import {useAuth} from '../../auth.tsx';
import {ActionModal, ErrorNotice, Section} from '../../ui.tsx';

const states: Record<GuidanceDigestView['state'], string> = {pending: '整理中', running: '整理中', ready: '待处理', adopted: '已发布', declined: '未采纳', failed: '整理未完成'};
const dispositions: Record<GuidanceDigestEntry['disposition'], string> = {adopt: '建议纳入', merge: '建议合并', conflict: '与现有口径冲突', case_only: '仅适用本案'};
const steps: Record<string, string> = {drafted: '已生成草稿', trial_passed: '试例已通过', approved: '已批准', published: '已发布'};

/** Case rules summarized for the rule centre. Adoption publishes a successor configuration in one action. */
export function GuidanceDigests() {
  const {session} = useAuth();
  const query = useQuery({queryKey: ['guidance-digests', session.user?.accountId], queryFn: ({signal}) => api<{items: GuidanceDigestView[]}>('/api/review-configs/guidance-digests', {signal})});
  const [open, setOpen] = useState<{digest: GuidanceDigestView; action: 'adopt' | 'decline'}>();
  const items = query.data?.items ?? [];
  if (!query.isPending && !items.length && !query.error) return null;
  return <Section title="案件口径整理" flush info={<span>{items.filter(item => item.state === 'ready').length} 份待处理</span>}>
    <div className="section-notice"><ErrorNotice error={query.error} retry={() => void query.refetch()}/></div>
    <p className="rules-hint rules-digest-hint">经办人在案件中确认的判断口径。采纳后生成新版本并完成校验、试跑、批准和发布；在办案件继续使用原版本，新建案件可选用新版本。</p>
    <Table<GuidanceDigestView> rowKey="id" loading={query.isPending} pagination={{pageSize: 10, hideOnSinglePage: true}} scroll={{x: 760}} dataSource={items} columns={[
      {title: '案件', key: 'case', render: (_, item) => <><Link className="table-main" to={`/cases/${encodeURIComponent(item.caseId)}/review`}>{item.caseNumber ?? item.caseTitle}</Link><div className="muted">{item.trigger === 'manual' ? '经办人手动提交' : `第 ${item.roundNumber ?? '-'} 轮确认时整理`}</div></>},
      {title: '口径', key: 'entries', render: (_, item) => <ul className="rules-digest-entries">{item.body?.entries.map(entry => <li key={entry.guidanceId}><strong>{entry.label}</strong>{entry.body.statement}<span className="muted">{dispositions[entry.disposition]}</span></li>)}</ul>},
      {title: '基于版本', key: 'base', width: 200, render: (_, item) => <span className="mono">{item.baseReleaseId}</span>},
      {title: '状态', key: 'state', width: 220, render: (_, item) => <>{states[item.state]}{item.adoption?.releaseId && item.state === 'adopted' && <div className="mono">{item.adoption.releaseId}</div>}{item.state === 'ready' && item.adoption?.step && <div className="muted">进行到：{steps[item.adoption.step] ?? item.adoption.step}{item.adoption.errorCode ? '，未完成' : ''}</div>}</>},
      {title: '操作', key: 'actions', width: 180, render: (_, item) => <div className="row-actions">
        {item.allowedActions.includes('adopt') && <Button type="link" onClick={() => setOpen({digest: item, action: 'adopt'})}>{item.adoption?.draftId ? '继续发布' : '采纳并发布'}</Button>}
        {item.allowedActions.includes('decline') && !item.adoption?.draftId && <Button type="link" onClick={() => setOpen({digest: item, action: 'decline'})}>不采纳</Button>}
      </div>},
    ]}/>
    {open?.action === 'adopt' && <AdoptDigest digest={open.digest} close={() => setOpen(undefined)}/>}
    {open?.action === 'decline' && <DeclineDigest digest={open.digest} close={() => setOpen(undefined)}/>}
  </Section>;
}

function AdoptDigest({digest, close}: {digest: GuidanceDigestView; close: () => void}) {
  const entries = digest.body?.entries ?? [];
  const [selected, setSelected] = useState(entries.filter(entry => entry.disposition !== 'case_only').map(entry => entry.guidanceId));
  const [statements, setStatements] = useState<Record<string, string>>({});
  const [pending, setPending] = useState(false);const [error, setError] = useState<unknown>();const [key] = useState(newKey);
  return <ActionModal title="采纳并发布" okText="采纳并发布" pending={pending} disabled={!selected.length} width={720} onCancel={close} error={<ErrorNotice error={error}/>}
    warning="将以最新版本为基础生成新版本，草稿作者记为提交整理的经办人，由你批准并发布；依次完成校验、试跑、批准和发布。在办案件不会自动换版本。"
    onFinish={async () => {setPending(true);setError(undefined);
      try {await api(`/api/review-configs/guidance-digests/${encodeURIComponent(digest.id)}/adopt`, {method: 'POST', timeoutMs: 180_000, body: {idempotencyKey: key, guidanceIds: selected,
        statements: Object.fromEntries(Object.entries(statements).filter(([id, text]) => selected.includes(id) && text.trim()))}});
        await Promise.all(['guidance-digests', 'review-configs'].map(name => queryClient.invalidateQueries({queryKey: [name]})));close();}
      catch (failure) {setError(failure);await queryClient.invalidateQueries({queryKey: ['guidance-digests']});} finally {setPending(false);}}}>
    <p>来自 {digest.caseNumber ?? digest.caseTitle}，基于 <span className="mono">{digest.baseReleaseId}</span>。勾选要纳入的口径，可在发布前调整措辞。</p>
    <ul className="rules-digest-adopt">{entries.map(entry => <li key={entry.guidanceId}>
      <Checkbox checked={selected.includes(entry.guidanceId)} onChange={event => setSelected(current => event.target.checked ? [...current, entry.guidanceId] : current.filter(id => id !== entry.guidanceId))}>
        <strong>{entry.label}</strong>{SEMANTIC_GUIDANCE_KIND_LABELS[entry.body.kind]}，{dispositions[entry.disposition]}
      </Checkbox>
      <p className="muted">{entry.reason}{entry.appliedCheckCount ? `本轮有 ${entry.appliedCheckCount} 项结论采用了这条口径。` : ''}</p>
      <Form.Item label="纳入后的措辞" className="rules-digest-statement"><Input.TextArea autoSize={{minRows: 1, maxRows: 4}} maxLength={500} disabled={!selected.includes(entry.guidanceId)} value={statements[entry.guidanceId] ?? entry.suggestedStatement} onChange={event => setStatements(current => ({...current, [entry.guidanceId]: event.target.value}))}/></Form.Item>
      {entry.body.expressions.length > 0 && <p className="muted">写法：{entry.body.expressions.join('｜')}</p>}
    </li>)}</ul>
    {(digest.body?.unused.length ?? 0) > 0 && <p className="muted">另有 {digest.body!.unused.length} 条本案规则未在预审中使用，不在此提交。</p>}
  </ActionModal>;
}

function DeclineDigest({digest, close}: {digest: GuidanceDigestView; close: () => void}) {
  const [pending, setPending] = useState(false);const [error, setError] = useState<unknown>();const [key] = useState(newKey);
  return <ActionModal title="不采纳这份整理" okText="不采纳" pending={pending} onCancel={close} error={<ErrorNotice error={error}/>}
    onFinish={async (values: {reason: string}) => {setPending(true);setError(undefined);
      try {await api(`/api/review-configs/guidance-digests/${encodeURIComponent(digest.id)}/decline`, {method: 'POST', body: {idempotencyKey: key, reason: values.reason}});await queryClient.invalidateQueries({queryKey: ['guidance-digests']});close();}
      catch (failure) {setError(failure);} finally {setPending(false);}}}>
    <p>本案规则仍在该案件中生效，只是不纳入规则中心。</p>
    <Form.Item name="reason" label="原因" rules={[{required: true, whitespace: true, message: '请说明原因'}]}><Input.TextArea rows={3} maxLength={1000}/></Form.Item>
  </ActionModal>;
}
