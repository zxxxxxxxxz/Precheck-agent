import React, {createContext, useContext, useEffect, useId, useLayoutEffect, useRef} from 'react';
import {Alert, Button, Empty, Form, Input, Modal, Typography} from 'antd';
import type {FormInstance} from 'antd';
import {useLocation, useNavigate} from 'react-router';
import {ApiError, errorText, isAccessLoss} from './api.ts';
import {formatClock} from './shared/format.ts';
import {layout} from './theme.ts';
import {caseStatuses, statusView, type StatusView} from './status.ts';
import './refresh-notice.css';
export {Loading} from './loading.tsx';

export function ErrorNotice({error, retry}: {error: unknown; retry?: () => void}) {
  if (!error) return null;
  return <Alert className="notice" type="error" showIcon title={errorText(error)} description={error instanceof ApiError && error.requestId ? <details><summary>错误详情</summary><span className="mono">请求编号：{error.requestId}</span></details> : undefined} action={retry ? <Button onClick={retry}>重新查询</Button> : undefined}/>;
}
/** True when a query has nothing safe to show: no data yet, or access was lost (401/403/404 clear the view). */
export function blocksView(query: {error: unknown; data?: unknown}) {return !!query.error && (query.data === undefined || isAccessLoss(query.error));}
/** A failed background refresh keeps the last good data visible with this inline hint. */
export function RefreshNotice({query, retry}: {query: {error: unknown; data?: unknown; dataUpdatedAt: number}; retry: () => void}) {
  if (!query.error || blocksView(query)) return null;
  return <Alert className="notice refresh-notice" type="warning" showIcon
    classNames={{icon: 'refresh-notice-icon', section: 'refresh-notice-content', title: 'refresh-notice-copy', actions: 'refresh-notice-actions'}}
    title={<><strong className="refresh-notice-title">刷新失败</strong><span className="refresh-notice-detail">当前显示 {formatClock(query.dataUpdatedAt)} 读取的内容。</span></>}
    action={<Button className="refresh-notice-retry" onClick={retry}>重新查询</Button>}/>;
}
export function Blank({title, children}: {title: string; children?: React.ReactNode}) {return <div className="blank"><Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={title}>{children}</Empty></div>;}

/** L1 page header: a single row with the title, its status, inline tabs or scope, meta and page actions. */
export function PageHeader({title, status, extra, meta, actions}: {title: string; status?: React.ReactNode; extra?: React.ReactNode; meta?: React.ReactNode; actions?: React.ReactNode}) {
  return <header className="page-header"><div className="page-header-title"><h1 title={title}>{title}</h1>{status}</div>{extra && <div className="page-header-extra">{extra}</div>}{meta && <div className="page-header-meta">{meta}</div>}{actions && <div className="page-header-actions">{actions}</div>}</header>;
}
export function MetaItem({label, children, optional}: {label: string; children: React.ReactNode; optional?: boolean}) {
  return <span className={`meta-item${optional ? ' meta-optional' : ''}`}><span>{label}</span><span>{children}</span></span>;
}
/** L2 section: the toolbar replaces a visible heading that would repeat the tab or page name; without info or actions no empty toolbar is drawn. */
export function Section({title, info, actions, flush, children, className}: {title: string; info?: React.ReactNode; actions?: React.ReactNode; flush?: boolean; children: React.ReactNode; className?: string}) {
  return <section className={`section${className ? ` ${className}` : ''}`} aria-label={title}><h2 className="visually-hidden">{title}</h2>{(info || actions) && <div className="section-toolbar"><div className="section-toolbar-info">{info}</div>{actions && <div className="section-toolbar-actions">{actions}</div>}</div>}<div className={`section-body${flush ? ' flush' : ''}`}>{children}</div></section>;
}
/** Navigation styled as a button: a real link for new tabs and copying, client-side routing on a plain click. */
export function LinkButton({to, type, children}: {to: string; type?: 'primary' | 'default'; children: React.ReactNode}) {
  const navigate = useNavigate();
  return <Button type={type} href={to} onClick={event => {if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return; event.preventDefault(); void navigate(to);}}>{children}</Button>;
}
/** Every status reads the same way: an 8px mark and the words; colour never stands alone. */
export function StatusTag({view}: {view: StatusView}) {
  return <span className={`status-mark${view.tone === 'plain' ? '' : ` status-mark-${view.tone}`}`}>{view.label}</span>;
}
export function StatusText({view}: {view: StatusView}) {return <StatusTag view={view}/>;}
export function CaseStatus({status, plain}: {status: string; plain?: boolean}) {const view = statusView(caseStatuses, status); return plain ? <StatusText view={view}/> : <StatusTag view={view}/>;}
export function Later({title}: {title: string; description?: string}) {return <Section title={title}><Blank title={`${title}暂未开放`}/></Section>;}
export function Forbidden() {return <><PageHeader title="权限不足"/><section className="panel"><p>当前账号没有此页面的访问权限，请联系授权管理员。</p></section></>;}
export function CopyValue({value, label}: {value: string; label: string}) {return <Typography.Paragraph className="copy-value mono" copyable={{text: value, icon: [<span key="copy">复制</span>, <span key="copied">已复制</span>], tooltips: [`复制${label}`, '已复制']}}>{value}</Typography.Paragraph>;}

export interface Crumb {title: string; to?: string}
export interface CaseHeader {
  caseId: string; title: string; status: string; revision: number; maker: string; activeTab: string;
  caseNumber?: string | null; reference?: string | null; roundNumber?: number | null; legacyRound?: boolean;
  tabs: {key: string; label: string; to: string; uploading?: boolean}[];
}
interface ShellChrome {setCrumbs: (path: string, items: Crumb[] | undefined, title?: string) => void; setCaseHeader: (path: string, item: CaseHeader | undefined) => void; stickyTop: number}
export const ShellContext = createContext<ShellChrome>({setCrumbs: () => undefined, setCaseHeader: () => undefined, stickyTop: layout.topbar});
/** Register only currently accessible case metadata; clear it before paint on access loss or navigation. */
export function useCaseHeader(item: CaseHeader | undefined) {
  const {setCaseHeader} = useContext(ShellContext);
  const {pathname} = useLocation();
  const key = JSON.stringify(item);
  useLayoutEffect(() => {setCaseHeader(pathname, key ? JSON.parse(key) as CaseHeader : undefined); return () => setCaseHeader(pathname, undefined);}, [setCaseHeader, pathname, key]);
}
/** Pages register their breadcrumb for the current path; the shell derives the browser title from the last crumb. */
export function useCrumbs(items: Crumb[], title?: string) {
  const {setCrumbs} = useContext(ShellContext);
  const {pathname} = useLocation();
  const key = JSON.stringify(items);
  useLayoutEffect(() => {setCrumbs(pathname, JSON.parse(key) as Crumb[], title); return () => setCrumbs(pathname, undefined);}, [setCrumbs, pathname, key, title]);
}
/** Confirm-with-reason dialog: object summary, consequence, error, fields, reason; footer stays visible and the request cannot be abandoned mid-flight. */
export function ActionModal({title, okText, danger, pending, disabled, onCancel, onFinish, summary, warning, error, children, width = 520, form, initialValues, onValuesChange}: {title: string; okText: string; danger?: boolean; pending: boolean; disabled?:boolean; onCancel: () => void; onFinish: (values: any) => void | Promise<void>; summary?: React.ReactNode; warning?: React.ReactNode; error?: React.ReactNode; children: React.ReactNode; width?: number; form?: FormInstance; initialValues?: Record<string, unknown>; onValuesChange?: () => void}) {
  const id = useId();
  const [own] = Form.useForm();
  const instance = form ?? own;
  return <Modal title={title} open width={width} onCancel={pending ? undefined : onCancel} closable={!pending} keyboard={!pending} mask={{closable: false}} destroyOnHidden okText={okText} cancelText="取消" okButtonProps={{disabled, htmlType: 'submit', form: id, loading: pending, danger}} cancelButtonProps={{disabled: pending}}>
    {summary && <div className="action-summary">{summary}</div>}
    {warning && <Alert className="notice" type="warning" showIcon title={warning}/>}
    {error}
    <Form id={id} form={instance} layout="vertical" clearOnDestroy disabled={pending} initialValues={initialValues} onValuesChange={onValuesChange} onFinish={values=>{if(!disabled&&!pending)return onFinish(values);}} onKeyDown={event => {if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {event.preventDefault(); instance.submit();}}}>{children}</Form>
  </Modal>;
}
export function ReasonField({label, autoFocus}: {label: string; autoFocus?: boolean}) {
  return <Form.Item name="reason" label={label} rules={[{required: true, whitespace: true, max: 500, message: `请填写${label}`}]}><Input.TextArea rows={3} maxLength={500} autoFocus={autoFocus}/></Form.Item>;
}
/** Offset for sticky table headers, measured from the shell's current top bar. */
export function useStickyTop() {return useContext(ShellContext).stickyTop;}

export function useRestoreFocus() {
  const trigger = useRef(typeof document === 'undefined' ? null : document.activeElement);
  useEffect(() => () => {requestAnimationFrame(() => {
    if (document.querySelector('[role="dialog"]')) return;
    const target = trigger.current instanceof HTMLElement && trigger.current.isConnected ? trigger.current : document.getElementById('main-content');
    target?.focus();
  });}, []);
}
