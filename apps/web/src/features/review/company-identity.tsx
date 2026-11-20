import React, {useEffect, useRef, useState} from 'react';
import {Button, Form, Input, Modal, Select} from 'antd';
import {useQuery} from '@tanstack/react-query';
import {Link} from 'react-router';
import type {CompanyIdentityState, CompanyLookupReceipt} from '@hsbc/contracts/company-identity';
import {api, newKey, queryClient} from '../../api.ts';
import {useAuth} from '../../auth.tsx';
import {blocksView, ErrorNotice, Loading} from '../../ui.tsx';
import {formatTime} from '../../shared/format.ts';
import {canSelectCompanyRecord, companyLookupReason, companyLookupStatus, companyRecordConflicts, companyRegistryStatus, gleifSourceUrl, leiRecordStatus} from './company-identity-presentation.ts';
import './company-identity.css';

type CompanyRecord = CompanyLookupReceipt['records'][number];
export type CompanyNameChoice = {label: string; lookupId: string; lei: string};

export function CompanyIdentityLookup({caseId, revision, names, onSelect}: {
  caseId: string; revision: number; names: readonly string[]; onSelect?: (choice: CompanyNameChoice) => void;
}) {
  const [open, setOpen] = useState(false);
  return <><Button size="small" onClick={() => setOpen(true)}>查询企业信息</Button>
    {open && <CompanyLookupDialog key={`${caseId}:${revision}`} caseId={caseId} revision={revision} names={names} onSelect={onSelect} close={() => setOpen(false)}/>}
  </>;
}

function CompanyLookupDialog({caseId, revision, names, onSelect, close}: {
  caseId: string; revision: number; names: readonly string[]; onSelect?: (choice: CompanyNameChoice) => void; close: () => void;
}) {
  const {session} = useAuth();
  const [form] = Form.useForm();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<unknown>();
  const [selectedId, setSelectedId] = useState<string>();
  const [submitted, setSubmitted] = useState<CompanyLookupReceipt>();
  const key = useRef(newKey());
  const controller = useRef<AbortController | undefined>(undefined);
  const base = `/api/cases/${encodeURIComponent(caseId)}/company-identities`;
  const queryKey = ['company-identities', session.user?.accountId, caseId];
  const state = useQuery({queryKey, queryFn: ({signal}) => api<CompanyIdentityState>(base, {signal}), refetchInterval: 15_000});
  const data = !blocksView(state) && state.data?.caseId === caseId ? state.data : undefined;
  const current = data?.revision === revision;
  const lookup = useQuery({
    queryKey: [...queryKey, selectedId],
    enabled: !!data && !!selectedId,
    queryFn: ({signal}) => api<CompanyLookupReceipt>(`${base}/lookups/${encodeURIComponent(selectedId!)}`, {signal}),
    refetchInterval: value => value.state.data?.status === 'pending' && value.state.data.errorCode !== 'company_lookup_execution_unknown' ? 2000 : false,
  });
  const receipt = data && !blocksView(lookup) ? (lookup.data?.id === selectedId ? lookup.data : submitted?.id === selectedId ? submitted : data.receipts.find(value => value.id === selectedId)) : undefined;
  const unresolved = receipt?.status === 'pending' || receipt?.errorCode === 'company_lookup_execution_unknown';
  const allowed = !state.error && current && data?.allowedActions.includes('lookup') && data.externalLookup.available;
  useEffect(() => () => controller.current?.abort(), []);
  const submit = async () => {
    if (!allowed || pending || unresolved) return;
    const values = await form.validateFields().catch(() => undefined);
    if (!values) return;
    setPending(true); setError(undefined);
    const request = new AbortController(); controller.current = request;
    try {
      const result = await api<CompanyLookupReceipt>(`${base}/lookups`, {
        method: 'POST', signal: request.signal,
        body: {expectedRevision: revision, idempotencyKey: key.current, reason: values.reason, name: values.name,
          ...Object.fromEntries(['lei', 'jurisdiction', 'registrationAuthority', 'registrationNumber'].flatMap(name => values[name]?.trim() ? [[name, values[name].trim()]] : [])), maxCandidates: 10},
      });
      if (request.signal.aborted) return;
      setSubmitted(result); setSelectedId(result.id); key.current = newKey();
      await queryClient.invalidateQueries({queryKey});
    } catch (failure) {if (!request.signal.aborted) setError(failure);}
    finally {if (!request.signal.aborted) setPending(false);}
  };
  const receipts = data?.receipts ?? [];
  return <Modal title="查询企业信息" open footer={<Button onClick={close}>关闭</Button>} onCancel={close} width={780} destroyOnHidden styles={{body: {maxHeight: 'calc(100dvh - 240px)', overflowY: 'auto'}}}>
    <div className="company-identity">
      <p className="muted">仅查询所选企业名称及登记标识。结果来自 GLEIF，供核对企业名称与登记信息。</p>
      <ErrorNotice error={state.error} retry={() => void state.refetch()}/>
      {state.isPending ? <Loading/> : data && <>
        {!current && <p role="status">案件已更新。请关闭并刷新当前案件后重新查询。</p>}
        {current && !allowed && <p role="status">{companyLookupReason(data.externalLookup.reasonCode)}</p>}
        <Form form={form} component="div" layout="vertical" initialValues={{name: names[0] ?? '', reason: '核对企业法定名称与登记信息'}} disabled={pending || !allowed} onValuesChange={() => {key.current = newKey();}} onKeyDown={event => {event.stopPropagation(); if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {event.preventDefault(); void submit();}}}>
          {names.length > 1 && <Form.Item label="材料中的名称"><Select aria-label="选择待查询的原文名称" placeholder="选择一个名称" options={[...new Set(names)].map(name => ({value: name, label: name}))} onChange={name => {form.setFieldValue('name', name); key.current = newKey();}}/></Form.Item>}
          <Form.Item name="name" label="企业名称" rules={[{required: true, whitespace: true, message: '请输入企业名称'}, {max: 300, message: '企业名称最多 300 字'}]}><Input maxLength={300}/></Form.Item>
          <details className="company-query-options"><summary>登记标识（选填）</summary><div className="company-query-fields">
            <Form.Item name="lei" label="LEI" rules={[{pattern: /^[A-Z0-9]{18}[0-9]{2}$/u, message: '请输入 20 位 LEI，大写字母及数字'}]}><Input maxLength={20}/></Form.Item>
            <Form.Item name="jurisdiction" label="司法辖区" rules={[{pattern: /^[A-Z]{2}(?:-[A-Z0-9]{1,4})?$/u, message: '请输入辖区代码，如 CN、HK、GB'}]}><Input maxLength={7} placeholder="如 CN、HK、GB"/></Form.Item>
            <Form.Item name="registrationAuthority" label="登记机构代码" rules={[{pattern: /^RA[0-9]{6}$/u, message: '请输入 RA 加 6 位数字'}]}><Input maxLength={8}/></Form.Item>
            <Form.Item name="registrationNumber" label="登记编号"><Input maxLength={80}/></Form.Item>
          </div></details>
          <Form.Item name="reason" label="查询依据" rules={[{required: true, whitespace: true, message: '请填写查询依据'}]}><Input maxLength={1000}/></Form.Item>
          <Button loading={pending} disabled={!allowed || pending || unresolved} onClick={() => void submit()}>查询 GLEIF</Button>
        </Form>
        <ErrorNotice error={error}/>
        {receipts.length > 0 && <div className="company-query-history"><Select aria-label="企业信息查询记录" placeholder="查看查询记录" value={selectedId} onChange={setSelectedId} options={receipts.map(value => ({value: value.id, label: `${value.query.name} · ${value.fetchedAt ? formatTime(value.fetchedAt) : '处理中'} · ${companyLookupStatus[value.status]}`}))}/></div>}
        <ErrorNotice error={lookup.error} retry={() => void lookup.refetch()}/>
        {receipt && <section className="company-query-result" aria-live="polite">
          <div className="company-result-heading"><strong>{companyLookupStatus[receipt.status]}</strong>{receipt.fetchedAt && <span className="muted">查询于 {formatTime(receipt.fetchedAt)}</span>}</div>
          {receipt.status === 'pending' && <p role="status">{receipt.errorCode === 'company_lookup_execution_unknown' ? companyLookupReason(receipt.errorCode) : '查询已受理，正在恢复处理结果。'}</p>}
          {receipt.errorCode === 'company_lookup_execution_unknown' && <Button size="small" onClick={() => void lookup.refetch()}>重新读取记录</Button>}
          {receipt.status === 'not_found' && <p>未找到匹配记录，不表示企业不存在；可换用原文中的另一名称或登记编号查询。</p>}
          {['blocked', 'unavailable'].includes(receipt.status) && <p>{companyLookupReason(receipt.errorCode)}</p>}
          {receipt.status === 'conflicting' && <p className="tone-warning">候选信息需核对，请查看下方差异。</p>}
          {(receipt.status === 'stale' || receipt.caseRevision !== revision || (receipt.expiresAt && Date.parse(receipt.expiresAt) <= Date.now())) && <p className="tone-warning">此记录已过期或依据已更新，请重新查询后采用。</p>}
          {receipt.records.length > 1 && <p className="muted">共 {receipt.records.length} 个候选，请结合原文及登记标识逐项核对。</p>}
          {receipt.truncated && <p className="tone-warning">仅展示前 10 个候选，可补充登记标识缩小查询范围。</p>}
          <div className="company-records">{receipt.records.map(record => <CompanyRecordView key={record.lei} record={record}>
            {onSelect && <Button size="small" disabled={!!state.error || !!lookup.error || !canSelectCompanyRecord(data, receipt, record.lei, revision)} onClick={() => {onSelect({label: record.legalName, lookupId: receipt.id, lei: record.lei}); close();}}>选用此法定名称</Button>}
          </CompanyRecordView>)}</div>
          {receipt.records.length > 0 && <p className="muted">{onSelect ? '选用只填入当前对象草稿；核对原文和操作依据后保存。' : <Link to={`/cases/${encodeURIComponent(caseId)}/review?mode=business`}>前往业务核对采用名称</Link>} 企业名称查询不确认两个主体相同。</p>}
        </section>}
      </>}
    </div>
  </Modal>;
}

function CompanyRecordView({record, children}: {record: CompanyRecord; children?: React.ReactNode}) {
  const source = gleifSourceUrl(record.sourceUrl);
  return <article className="company-record"><strong>{record.legalName}</strong>
    {record.aliases.length > 0 && <div className="company-aliases">{record.aliases.map((alias, index) => <span key={index}>{alias.name}{alias.language ? `（${alias.language}）` : ''}</span>)}</div>}
    <dl className="company-record-details">
      <div><dt>LEI</dt><dd className="mono">{record.lei}</dd></div>
      <div><dt>司法辖区</dt><dd>{record.jurisdiction || '未提供'}</dd></div>
      <div><dt>登记机构／编号</dt><dd>{record.registrationAuthority || '未提供'}／{record.registrationNumber || '未提供'}</dd></div>
      <div><dt>企业状态</dt><dd>{companyRegistryStatus(record.entityStatus)}</dd></div>
      <div><dt>LEI 状态</dt><dd>{leiRecordStatus(record.leiRegistrationStatus)}</dd></div>
      <div><dt>来源更新</dt><dd>{record.recordUpdatedAt ? formatTime(record.recordUpdatedAt) : '未提供'}</dd></div>
    </dl>
    {record.matchBasis.length > 0 && <p className="muted">匹配依据：{record.matchBasis.map(value => ({lei_exact: 'LEI 一致', name_format_equal: '名称格式对应', jurisdiction_exact: '司法辖区一致', registration_authority_exact: '登记机构一致', registration_number_exact: '登记编号一致'} as Record<string, string>)[value] ?? '登记信息').join('、')}</p>}
    {record.conflicts.length > 0 && <p className="tone-warning">{companyRecordConflicts(record.conflicts).join('；')}，暂不能采用。</p>}
    <div className="company-record-actions">{source && <a href={source} target="_blank" rel="noopener noreferrer">查看 GLEIF 来源</a>}{children}</div>
  </article>;
}
