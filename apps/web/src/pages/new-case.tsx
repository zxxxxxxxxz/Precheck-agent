import {caseExtractionPath, caseMaterialsPath} from '../features/cases/workspace-navigation.ts';
import React, {useCallback, useEffect, useMemo, useRef, useState} from 'react';
import {Button, Checkbox, Form, Grid, Input, InputNumber, Modal, Select, Tabs} from 'antd';
import {Bubble, Sender, ThoughtChain} from '@ant-design/x';
import {useXChat, type MessageInfo} from '@ant-design/x-sdk';
import {useQuery} from '@tanstack/react-query';
import {Navigate, useNavigate, useSearchParams} from 'react-router';
import {CASE_FIELD_LIMITS, CaseCreationFieldsSchema, CaseDraftFieldsSchema, emptyCaseDraftFields, type CaseConfigurationOptions, type CaseDraft, type CaseDraftFields, type DraftField, type IntakeField, type DraftGuaranteeTypes, type DraftSource} from '@hsbc/contracts/draft';
import {api, ApiError, newKey, queryClient} from '../api.ts';
import {can} from '../features/identity/permissions.ts';
import {formatTime} from '../shared/format.ts';
import {useAuth} from '../auth.tsx';
import {createIntakeProvider, fieldLabels, fieldValueText, questionText, turnStatusText, intakeRequestFallback, type DraftSuggestion, type DraftTurn, type IntakeMessage, type IntakeRequest, type IntakeEvent, turnMessage} from '../draft-chat.ts';
import {useDraftAttachments, AttachmentList, draftAttachmentAccept, validateDraftAttachment, type DraftAttachments} from '../draft-attachments.tsx';
import {useCapabilities} from '../capabilities.ts';
import {semantic, palette} from '../theme.ts';
import type {CaseSummary} from '../features/cases/types.ts';
import {NewCaseConfiguration, NewCaseMaterialRequirements} from '../features/cases/new-case-configuration.tsx';
import {bankMaterialChecklist} from '../features/materials/bank-material-checklist.ts';
import {caseConfigurationSelection, chooseCaseConfiguration} from '../features/cases/configuration-selection.ts';
import {ErrorNotice, Forbidden, Loading} from '../ui.tsx';
import './new-case.css';

import {draftPath} from '../features/intake/api-paths.ts';
import {CASE_CURRENCIES, CASE_JURISDICTIONS, CaseDetailsSchema, emptyCaseDetails, type CaseDetails} from '@hsbc/contracts/draft';
const statusLabel = {open: '草稿', created: '已创建案件', discarded: '已废弃'};
type DraftValues = {fields: CaseDraftFields; source: DraftSource; details: CaseDetails; guaranteeTypes: DraftGuaranteeTypes};
type DraftList = {items: CaseDraft[]; nextBefore?: string | null};
const emptyValues = (): DraftValues => ({fields: emptyCaseDraftFields(), source: {kind: 'maker'}, details: emptyCaseDetails(), guaranteeTypes: []});
const draftValues = (draft: CaseDraft): DraftValues => ({fields: {...draft.fields}, source: {...draft.source}, details: {...emptyCaseDetails(), ...draft.details}, guaranteeTypes: [...draft.guaranteeTypes ?? []]});
const equalValues = (a: DraftValues, b: DraftValues) => JSON.stringify([a.fields, a.details, a.source, a.guaranteeTypes]) === JSON.stringify([b.fields, b.details, b.source, b.guaranteeTypes]);
const accessLost = (failure: unknown) => failure instanceof ApiError && [401, 403, 404].includes(failure.status);
function IntakeAssistantIcon() {
  return <svg className="intake-assistant-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false"><path d="M5 4.5h14v11H10l-5 4v-15Z"/><path d="M8.5 8.5h7M8.5 12h4.5"/></svg>;
}

export function NewCase() {
  const {session} = useAuth();
  useEffect(() => {
    const viewport = window.visualViewport;
    const measure = () => document.documentElement.style.setProperty('--intake-viewport-height', `${viewport?.height ?? window.innerHeight}px`);
    measure(); viewport?.addEventListener('resize', measure); window.addEventListener('resize', measure);
    return () => {viewport?.removeEventListener('resize', measure); window.removeEventListener('resize', measure); document.documentElement.style.removeProperty('--intake-viewport-height');};
  }, []);
  return can(session.allowed_actions, 'case:create') ? <DraftWorkspace/> : <Forbidden/>;
}
function DraftWorkspace() {
  const {session} = useAuth();
  const navigate = useNavigate();
  const [search, setSearch] = useSearchParams();
  const [drafts, setDrafts] = useState<CaseDraft[]>([]);
  const [nextBefore, setNextBefore] = useState<string | null>();
  const [draft, setDraft] = useState<CaseDraft>();
  const [values, setValues] = useState<DraftValues | undefined>(emptyValues);
  const [busy, setBusy] = useState(false);
  const [processing, setProcessing] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [loading, setLoading] = useState(!!search.get('draft'));
  const [resumed, setResumed] = useState(!!search.get('draft'));
  const [resumeOpen, setResumeOpen] = useState(false);
  const [resumeLoading, setResumeLoading] = useState(false);
  const [resumeError, setResumeError] = useState<unknown>();
  const [queuedFiles, setQueuedFiles] = useState<{draftId: string; files: File[]}>(() => ({draftId: '', files: []}));
  const [dragging, setDragging] = useState(false);
  const [error, setError] = useState<unknown>();
  const [notice, setNotice] = useState('');
  const [fieldErrors, setFieldErrors] = useState<Partial<Record<DraftField, string>>>({});
  const [detailErrors, setDetailErrors] = useState<Partial<Record<keyof CaseDetails, string>>>({});
  const [tab, setTab] = useState('form');
  const touched = useRef(new Set<IntakeField>());
  const currentValues = useRef({draft, values}); currentValues.current = {draft, values};
  const attachments = useDraftAttachments(draft, values?.source, next => mergeRemote(next));
  const materialsRequired = !attachments.items.some(item => item.state === 'registered');
  const materialsUnavailable = materialsRequired || !!attachments.error;
  const capabilities = useCapabilities();
  const usesConfiguration = capabilities.data?.reviewConfiguration === true;
  const configurations = useQuery({queryKey: ['case-configuration-options'], enabled: usesConfiguration,
    queryFn: ({signal}) => api<CaseConfigurationOptions>('/api/case-configuration-options', {signal})});
  const configurationChoice = chooseCaseConfiguration(configurations.data?.items ?? [], values?.guaranteeTypes ?? []);
  const selectedConfiguration = configurations.data?.items.find(item => item.releaseId === configurationChoice.releaseId);
  const reviewConfiguration = caseConfigurationSelection(configurations.data?.items ?? [], configurationChoice);
  const configurationBlocked = capabilities.isPending || !!capabilities.error || usesConfiguration && (!reviewConfiguration || !!configurations.error);
  const [useAttachment, setUseAttachment] = useState<{id: string; key: string; draftId: string}>();
  const fileInput = useRef<HTMLInputElement>(null);
  const [discardOpen, setDiscardOpen] = useState(false);
  const onAccessLoss = useCallback((failure: unknown) => {setDraft(undefined); setValues(undefined); setDrafts([]); touched.current.clear(); setProcessing(false); setError(failure);}, []);
  const screens = Grid.useBreakpoint();
  const initialDraftId = useRef(search.get('draft'));
  const newDraftKey = useRef<string | undefined>(undefined);
  const pendingDraft = useRef<Promise<CaseDraft> | undefined>(undefined);
  const actionRunning = useRef(false);
  const commands = useRef(new Map<string, {fingerprint: string; key: string}>());
  const createReceipt = useRef<{draftId: string; revision: number; configurationKey: string; key: string} | undefined>(undefined);
  const dirty = !!values && (!equalValues(values, draft ? draftValues(draft) : emptyValues()) || touched.current.size > 0);
  const editable = !!values && !loading && (!draft || draft.status === 'open');
  const update = useCallback((next: CaseDraft) => {
    touched.current.clear();
    const nextValues = draftValues(next);
    currentValues.current = {draft: next, values: nextValues};
    setDraft(next); setValues(nextValues); setFieldErrors({}); setDetailErrors({});
    setDrafts(previous => [next, ...previous.filter(item => item.id !== next.id)]);
    setSearch({draft: next.id}, {replace: true});
  }, [setSearch]);
  const mergeRemote = useCallback((next: CaseDraft) => {
    const previous = currentValues.current;
    if (!previous.draft || previous.draft.id !== next.id || next.revision <= previous.draft.revision) return;
    setDraft(next);
    setValues(current => {
      if (!current) return draftValues(next);
      const fields = {...next.fields};
      for (const field of Object.keys(fields) as DraftField[]) {
        if (touched.current.has(field) || current.fields[field] !== previous.draft!.fields[field]) Object.assign(fields, {[field]: current.fields[field]});
      }
      const details = {...emptyCaseDetails(), ...next.details};
      for (const field of Object.keys(details) as (keyof CaseDetails)[]) {
        if (touched.current.has(field) || current.details[field] !== ({...emptyCaseDetails(), ...previous.draft!.details})[field]) Object.assign(details, {[field]: current.details[field]});
      }
      const guaranteeTypes = touched.current.has('guaranteeTypes') || JSON.stringify(current.guaranteeTypes) !== JSON.stringify(previous.draft!.guaranteeTypes ?? []) ? current.guaranteeTypes : [...next.guaranteeTypes ?? []];
      return {fields, details, guaranteeTypes, source: JSON.stringify(current.source) === JSON.stringify(previous.draft!.source) ? {...next.source} : current.source};
    });
    setDrafts(previousDrafts => [next, ...previousDrafts.filter(item => item.id !== next.id)]);
  }, []);
  const onInitialLoad = useRef(update); onInitialLoad.current = update;
  useEffect(() => {
    const selected = initialDraftId.current;
    if (!selected) return;
    let alive = true;
    void (async () => {
      try {
        const next = await api<CaseDraft>(draftPath(selected));
        if (alive) onInitialLoad.current(next);
      } catch (failure) {if (alive) {setValues(undefined); setError(failure);}} finally {if (alive) setLoading(false);}
    })();
    return () => {alive = false;};
  }, []);
  useEffect(() => {
    if (!dirty) return;
    const warn = (event: BeforeUnloadEvent) => {event.preventDefault(); event.returnValue = '';};
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [dirty]);
  useEffect(() => {
    if (!queuedFiles.files.length || draft?.id !== queuedFiles.draftId) return;
    const files = queuedFiles.files;
    setQueuedFiles({draftId: '', files: []});
    void attachments.add(files, true);
  }, [queuedFiles, draft?.id]);

  // Reuse a receipt only for the identical command. A lost response never turns
  // an explicit retry into a new mutation; new local edits get a new receipt.
  function commandKey(scope: string, body: unknown) {
    const fingerprint = JSON.stringify(body), previous = commands.current.get(scope);
    if (previous?.fingerprint === fingerprint) return previous.key;
    const key = newKey(); commands.current.set(scope, {fingerprint, key}); return key;
  }
  async function save(): Promise<CaseDraft> {
    if (!values) throw new Error('draft_unavailable');
    const parsed = CaseDraftFieldsSchema.safeParse(values.fields);
    if (!parsed.success) throw new ApiError(400, 'invalid_draft_fields', '请核对案件信息的长度和业务场景。');
    const details = CaseDetailsSchema.safeParse(values.details);
    if (!details.success) {
      setDetailErrors(Object.fromEntries(details.error.issues.map(issue => [issue.path[0], issue.message])));
      setTab('form');
      throw new ApiError(400, 'invalid_case_details', '请核对客户号、司法管辖地、币种和担保金额。');
    }
    const current = await ensureDraft();
    if (equalValues(values, draftValues(current)) && !touched.current.size) return current;
    const body = {expectedRevision: current.revision, fields: parsed.data, details: details.data, guaranteeTypes: values.guaranteeTypes, source: values.source, touchedFields: [...touched.current]};
    const next = await api<CaseDraft>(`${draftPath(current.id)}/save`, {method: 'POST', body: {...body, idempotencyKey: commandKey(`save:${current.id}`, body)}});
    update(next); return next;
  }
  async function ensureDraft(): Promise<CaseDraft> {
    if (currentValues.current.draft) return currentValues.current.draft;
    if (!pendingDraft.current) {
      newDraftKey.current ??= newKey();
      pendingDraft.current = api<CaseDraft>('/api/case-drafts', {method: 'POST', body: {idempotencyKey: newDraftKey.current}}).then(next => {
        currentValues.current = {...currentValues.current, draft: next};
        setDraft(next);
        setSearch({draft: next.id}, {replace: true});
        newDraftKey.current = undefined;
        return next;
      }).finally(() => {pendingDraft.current = undefined;});
    }
    return pendingDraft.current;
  }
  async function perform(action: () => Promise<void>) {
    if (actionRunning.current || busy) return;
    actionRunning.current = true;
    setBusy(true); setError(undefined); setNotice('');
    try {await action();} catch (failure) {setError(failure);} finally {actionRunning.current = false; setBusy(false);}
  }
  async function stopOpenTurns() {
    if (!draft || !editable) return;
    const result = await api<{items: DraftTurn[]}>(`${draftPath(draft.id)}/turns`);
    for (const turn of result.items) if (['pending', 'running'].includes(turn.status)) await api(`${draftPath(draft.id)}/turns/${turn.id}/cancel`, {method: 'POST'});
  }
  const switchDraft = (id: string) => perform(async () => {if (editable) {await stopOpenTurns(); if (dirty) await save();} update(await api<CaseDraft>(draftPath(id))); setTab('form'); setResumed(true); setResumeOpen(false);});
  const newDraft = () => perform(async () => {
    if (editable) {await stopOpenTurns(); if (dirty) await save();}
    touched.current.clear(); newDraftKey.current = undefined; initialDraftId.current = null;
    const nextValues = emptyValues(); currentValues.current = {draft: undefined, values: nextValues};
    setDraft(undefined); setValues(nextValues); setFieldErrors({}); setDetailErrors({}); setUseAttachment(undefined);
    setSearch({}, {replace: true}); setTab('form'); setResumed(false);
  });
  const refresh = () => perform(async () => {const id = draft?.id ?? initialDraftId.current; if (id) {update(await api<CaseDraft>(draftPath(id))); setNotice('已载入保存的案件信息');}});
  async function loadDrafts(more = false) {
    setResumeOpen(true); setResumeLoading(true); setResumeError(undefined);
    try {
      const result = await api<DraftList>(`/api/case-drafts?status=open${more && nextBefore ? `&before=${encodeURIComponent(nextBefore)}` : ''}`);
      setDrafts(previous => more ? [...previous, ...result.items.filter(item => !previous.some(existing => existing.id === item.id))] : result.items);
      setNextBefore(result.nextBefore);
    } catch (failure) {setResumeError(failure);} finally {setResumeLoading(false);}
  }
  const selectTab = (next: string) => {
    if (next !== 'chat' || draft) {setTab(next); return;}
    void perform(async () => {await save(); setTab(next);});
  };
  const addFiles = (files: File[]) => {
    if (!files.length || !editable || !capabilities.data?.draftAttachments || busy || submitting || attachments.blocked || queuedFiles.files.length) return;
    const issue = files.map(validateDraftAttachment).find(Boolean);
    if (issue) {setError(new ApiError(400, 'invalid_attachment', issue)); return;}
    void perform(async () => {const current = await save(); setQueuedFiles({draftId: current.id, files});});
  };
  async function createCase() {
    if (!values || processing || submitting || materialsUnavailable || attachments.blocked || queuedFiles.files.length || configurationBlocked) return;
    const parsed = CaseCreationFieldsSchema.safeParse(values.fields);
    if (!parsed.success) {
      const errors: Partial<Record<DraftField, string>> = {};
      for (const issue of parsed.error.issues) errors[issue.path[0] as DraftField] = issue.path[0] === 'scenario' ? '请选择境外贷款场景' : `案件名称不能超过 ${CASE_FIELD_LIMITS.title} 字`;
      setFieldErrors(errors); setTab('form'); return;
    }
    await perform(async () => {
      const saved = await save();
      const configurationKey = JSON.stringify(usesConfiguration ? {reviewConfiguration} : null);
      if (createReceipt.current?.draftId !== saved.id || createReceipt.current.revision !== saved.revision || createReceipt.current.configurationKey !== configurationKey) createReceipt.current = {draftId: saved.id, revision: saved.revision, configurationKey, key: newKey()};
      const receipt = createReceipt.current;
      try {
        const result = await api<CaseSummary>('/api/cases', {method: 'POST', body: {createReviewRound:true,draftId: saved.id, expectedRevision: saved.revision, idempotencyKey: receipt.key,
          ...(usesConfiguration ? {reviewConfiguration} : {})}});
        void queryClient.invalidateQueries({queryKey: ['cases']}); void queryClient.invalidateQueries({queryKey: ['workbench']}); navigate(caseExtractionPath(result.id), {replace: true});
      } catch (failure) {
        if (failure instanceof ApiError && failure.status === 0) {
          const recovered = await api<CaseDraft>(draftPath(saved.id));
          if (recovered.createdCaseId) {
            void queryClient.invalidateQueries({queryKey: ['cases']}); void queryClient.invalidateQueries({queryKey: ['workbench']});
            navigate(caseExtractionPath(recovered.createdCaseId), {replace: true}); return;
          }
          update(recovered);
        }
        throw failure;
      }
    });
  }
  const changeField = (name: DraftField, value: string | null) => {
    touched.current.add(name);
    setValues(previous => previous && ({...previous, fields: {...previous.fields, [name]: value}}));
    setFieldErrors(previous => ({...previous, [name]: undefined})); setNotice('');
  };
  const changeDetail = <K extends keyof CaseDetails>(name: K, value: CaseDetails[K]) => {
    touched.current.add(name);
    setValues(previous => previous && ({...previous, details: {...previous.details, [name]: value}}));
    setDetailErrors(previous => ({...previous, [name]: undefined})); setNotice('');
  };
  const detailProps = (name: keyof CaseDetails) => ({validateStatus: detailErrors[name] ? 'error' as const : undefined, help: detailErrors[name]});
  const beforeSend = async () => {if (busy) throw new Error('draft_busy'); setBusy(true); try {return await save();} finally {setBusy(false);}};
  const apply = async (turn: DraftTurn, candidateIds: string[]) => {
    if (!draft || dirty || !editable || busy || (turn.resultRevision ?? turn.draftRevision) !== draft.revision) return;
    await perform(async () => {const body = {expectedRevision: draft.revision, turnId: turn.id, candidateIds}; const next = await api<CaseDraft>(`${draftPath(draft.id)}/apply`, {method: 'POST', body: {...body, idempotencyKey: commandKey(`apply:${draft.id}`, body)}}); update(next); setNotice('建议已应用，请核对案件信息');});
  };
  const undo = async (turn: DraftTurn) => {
    if (!draft || dirty || busy || !editable) return;
    await perform(async () => {const body = {expectedRevision: draft.revision}; const next = await api<CaseDraft>(`${draftPath(draft.id)}/turns/${turn.id}/undo`, {method: 'POST', body: {...body, idempotencyKey: commandKey(`undo:${turn.id}`, body)}}); update(next); setNotice('已撤销本轮自动填写');});
  };
  const fieldProps = (field: DraftField) => {
    const origin = draft?.fieldSources[field];
    const extra = !touched.current.has(field) && origin?.kind === 'assistant' ? `助手填写 · ${sourceLabels(origin.sourceRefs, attachments)}` : undefined;
    return {validateStatus: fieldErrors[field] ? 'error' as const : undefined, help: fieldErrors[field], extra};
  };
  const creationHint = !editable ? '当前草稿不可编辑' : submitting || processing ? '建案助手正在整理，请稍候' : capabilities.isPending ? '正在读取创建权限…'
    : capabilities.error ? '创建权限读取失败，请重试' : attachments.blocked || queuedFiles.files.length > 0 ? '请先完成或取消文件上传'
    : attachments.error ? '文件列表读取失败，请刷新后重试' : usesConfiguration && configurations.isPending ? '正在读取适用规则…'
    : usesConfiguration && configurations.error ? '适用规则读取失败，请重试' : usesConfiguration && !configurations.data?.canSelect ? '审核规则暂不可用，请核对上方提示'
    : usesConfiguration && !configurationChoice.guaranteeTypes.length ? '请先选择担保类型' : configurationBlocked ? '所选担保组合暂无可用规则，请调整担保类型'
    : materialsRequired ? '请先上传至少一份材料' : '创建后进入提取与核对';
  const uploadBlocked = busy || submitting || !editable || !capabilities.data?.draftAttachments || attachments.blocked || queuedFiles.files.length > 0;
  // A completed draft is a receipt, not an editable upload workspace. Old
  // history/bookmarks must reopen its case instead of stranding a locked form.
  if (draft?.createdCaseId) return <Navigate to={caseMaterialsPath(draft.createdCaseId)} replace/>;
  const form = values && <section className="intake-form" aria-labelledby="intake-form-heading">
    <header className="case-intake-heading"><span className="case-intake-step" aria-hidden="true">01</span><div><span className="case-intake-context">文件批次</span><h1 id="intake-form-heading">{usesConfiguration ? '选择业务并上传第一轮文件' : '填写案件信息并上传文件'}</h1><p>{usesConfiguration ? '可同时勾选多种担保类型，材料清单随之更新。' : '上传本轮文件后创建案件，客户与担保信息可选填。'}</p></div><div className="case-intake-number"><span>案件号</span><strong>创建成功后自动生成</strong></div></header>
    <Form className="intake-form-layout" layout="vertical" autoComplete="off" disabled={busy || submitting || !editable} onFinish={() => void createCase()}>
      <div className="intake-form-scroll">
        <ErrorNotice error={capabilities.error} retry={() => void capabilities.refetch()}/>
        {usesConfiguration && <><ErrorNotice error={configurations.error} retry={() => void configurations.refetch()}/>
          <NewCaseConfiguration data={configurations.error ? undefined : configurations.data} loading={configurations.isPending} disabled={busy || submitting || !editable} value={configurationChoice}
            onChange={choice => {touched.current.add('guaranteeTypes'); setValues(previous => previous && ({...previous, guaranteeTypes: choice.guaranteeTypes}));}}/>
          {!screens.lg && <details className="case-mobile-materials" key={selectedConfiguration?.releaseId}><summary>查看本轮材料清单{selectedConfiguration ? `（${bankMaterialChecklist(selectedConfiguration.guaranteeTypes).length} 类）` : ''}</summary>
            <NewCaseMaterialRequirements option={configurations.error ? undefined : selectedConfiguration} selected={configurationChoice.guaranteeTypes.length > 0} loading={configurations.isPending} error={!!configurations.error}/></details>}</>}
        <section className="case-intake-details" aria-labelledby="case-details-heading" aria-describedby="case-details-optional">
          <header className="case-intake-details-heading"><h2 id="case-details-heading">客户与担保信息</h2><span id="case-details-optional">均为选填</span></header>
          <div className="case-intake-details-grid">
            <Form.Item label="客户号" htmlFor="case-customer-number" {...detailProps('customerNumber')}><Input id="case-customer-number" aria-label="客户号" value={values.details.customerNumber} maxLength={100} placeholder="输入客户号" onChange={event => changeDetail('customerNumber', event.target.value)}/></Form.Item>
            <Form.Item label="司法管辖地" htmlFor="case-jurisdiction" {...detailProps('jurisdiction')}><Select id="case-jurisdiction" aria-label="司法管辖地" value={values.details.jurisdiction} placeholder="选择国家／地区" allowClear showSearch={{optionFilterProp: 'label'}} options={[...CASE_JURISDICTIONS]} onChange={value => changeDetail('jurisdiction', value ?? null)}/></Form.Item>
            <div className="case-intake-money">
              <Form.Item label="币种" htmlFor="case-guarantee-currency" {...detailProps('guaranteeCurrency')}><Select id="case-guarantee-currency" aria-label="担保币种" value={values.details.guaranteeCurrency ?? null} placeholder="选择币种" allowClear showSearch={{optionFilterProp: 'label'}} optionLabelProp="value" popupMatchSelectWidth={220} options={[...CASE_CURRENCIES]} onChange={value => changeDetail('guaranteeCurrency', value ?? null)}/></Form.Item>
              <Form.Item className="case-intake-amount" label="担保金额" htmlFor="case-guarantee-amount" {...detailProps('guaranteeAmount')}><InputNumber<string> id="case-guarantee-amount" aria-label="担保金额" stringMode controls={false} changeOnBlur={false} value={values.details.guaranteeAmount} placeholder="输入金额" onChange={value => changeDetail('guaranteeAmount', value)}/></Form.Item>
            </div>
          </div>
        </section>
        <section className="intake-materials" aria-label="第一轮文件">
          <Button className={`case-attachment-dropzone${dragging ? ' is-dragging' : ''}`} classNames={{content: 'case-attachment-dropzone-content'}} type="dashed" block aria-label="上传第一轮文件" disabled={uploadBlocked}
            onClick={() => fileInput.current?.click()} onDragOver={event => {event.preventDefault(); if (!uploadBlocked) setDragging(true);}}
            onDragLeave={event => {if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDragging(false);}}
            onDrop={event => {event.preventDefault(); setDragging(false); addFiles(Array.from(event.dataTransfer.files));}}>
            <span><span aria-hidden="true" className="case-attachment-plus">＋</span><strong>上传第 1 轮文件</strong><span>拖放或点选 PDF、Word、图片，可一次选择多份</span></span>
          </Button><input ref={fileInput} hidden type="file" multiple accept={draftAttachmentAccept} onChange={event => {addFiles(Array.from(event.target.files ?? [])); event.target.value = '';}}/>
          <p className="intake-footnote" id="case-material-requirement">至少上传一份材料，校验完成后可创建案件；其他材料可后续补充。</p>
          {!capabilities.isPending && !capabilities.error && !capabilities.data?.draftAttachments && <p className="intake-footnote" role="status">文件上传暂不可用，可先暂存案件信息，待上传恢复后继续创建。</p>}
          <div className="intake-materials-heading"><h2>第 1 轮待审文件</h2><span>{attachments.items.length ? `${attachments.items.length} 份文件` : '尚未上传'}</span></div>
          {draft && <AttachmentList attachments={attachments} draftId={draft.id} disabled={busy || submitting || !editable} selectable={capabilities.data?.intake?.available === true}/>}
          {!!attachments.items.length && capabilities.data?.intake?.available && <p className="intake-footnote">勾选的文件会随下一条消息交给建案助手读取；创建案件时仍会纳入本轮全部材料。</p>}
          {!attachments.items.length && !attachments.transfers.length && <p className="intake-attachment-empty">{attachments.loading || queuedFiles.files.length ? '正在准备文件…' : '本轮还没有文件。'}</p>}
        </section>
        {values.fields.scenario !== 'overseas_loan' && <section className="case-intake-fields" aria-label="案件信息">
          {values.fields.scenario !== 'overseas_loan' && <Form.Item label="业务场景" required {...fieldProps('scenario')}><Select aria-label="业务场景" value={values.fields.scenario} onChange={value => changeField('scenario', value)} placeholder="请选择业务场景" options={[{value: 'overseas_loan', label: '境外贷款'}, {value: 'inbound_guarantee', label: '外保内贷（暂未开放）', disabled: true}]}/></Form.Item>}

        </section>}
      </div>
      <div className="intake-submit"><span id="case-creation-status" role="status">{creationHint}</span><Button htmlType="button" disabled={!editable || !dirty || busy || submitting} onClick={() => void perform(async () => {await save(); setNotice('案件信息已暂存');})}>暂存</Button><Button type="primary" htmlType="submit" aria-describedby="case-creation-status" loading={busy} disabled={!editable || submitting || processing || materialsUnavailable || attachments.blocked || queuedFiles.files.length > 0 || configurationBlocked}>创建案件</Button></div>
    </Form>
  </section>;
  return <div className="intake-page">
    <header className="intake-draftbar"><div className="intake-draft-identity"><strong className="intake-entry-title">{resumed ? '继续填写案件' : '新建案件'}</strong><span className="intake-saved" role="status">{dirty ? '有未保存的修改' : draft ? draft.status === 'open' ? '已暂存' : statusLabel[draft.status] : ''}</span></div><div className="intake-draft-actions">
      {usesConfiguration && screens.lg && (draft || capabilities.data?.intake?.available) && <Button className="intake-assistant-toggle" icon={<IntakeAssistantIcon/>} aria-expanded={tab === 'chat'} aria-controls="intake-assistant-panel" title={tab === 'chat' ? '收起助手，查看材料清单' : '打开建案助手，辅助填写案件信息'} disabled={busy || submitting || loading || !editable} onClick={() => selectTab(tab === 'chat' ? 'form' : 'chat')}>{tab === 'chat' ? '收起助手' : '建案助手'}</Button>}
      {draft && <Button type="text" danger disabled={busy || submitting || !editable || attachments.blocked} onClick={() => setDiscardOpen(true)}>放弃本次填写</Button>}
      <Button type="text" disabled={busy || submitting || loading || attachments.blocked || queuedFiles.files.length > 0} onClick={() => void loadDrafts()}>继续未完成案件</Button>
      {(draft || dirty) && <Button type="text" disabled={busy || submitting || loading || attachments.blocked || queuedFiles.files.length > 0} onClick={() => void newDraft()}>新建案件</Button>}
    </div></header>
    <ErrorNotice error={error} retry={draft || initialDraftId.current ? refresh : undefined}/>
    {error instanceof ApiError && error.status === 409 && dirty && <p className="intake-conflict">本页未保存的修改仍保留。重新载入将使用服务端内容，请先核对或复制需要保留的修改。</p>}
    {notice && <p className="intake-status" role="status">{notice}</p>}
    {loading ? <Loading label="正在读取案件信息"/> : !values ? <section className="panel"><p>案件信息暂不可用</p><Button onClick={() => void newDraft()}>新建案件</Button></section> : <>
      {!screens.lg && (draft || capabilities.data?.intake?.available) && <Tabs className="intake-mobile-tabs" activeKey={tab} onChange={selectTab} items={[{key: 'form', label: '案件与上传'}, {key: 'chat', label: <span className="intake-assistant-tab"><IntakeAssistantIcon/>建案助手</span>}]}/>}
      <div className="intake-workspace">
        <div className="intake-form-pane" hidden={!screens.lg && tab !== 'form'}>{form}</div>
        <div className={`intake-support-pane${!screens.lg || !usesConfiguration || tab === 'chat' ? ' is-chat' : ''}`} hidden={!screens.lg && tab !== 'chat'}>
          {usesConfiguration && screens.lg && <NewCaseMaterialRequirements hidden={tab === 'chat'} option={configurations.error ? undefined : selectedConfiguration} selected={configurationChoice.guaranteeTypes.length > 0} loading={configurations.isPending} error={!!configurations.error}/>}
          <div id="intake-assistant-panel" className="intake-chat-pane" hidden={!!screens.lg && usesConfiguration && tab !== 'chat'}>{draft ? <DraftChat key={`${session.user?.accountId}:${draft.id}`} draft={draft} dirty={dirty} busy={busy} beforeSend={beforeSend} apply={apply} undo={undo} mergeRemote={mergeRemote} attachments={attachments} useAttachment={useAttachment} available={capabilities.data?.intake?.available === true} unavailableReason={capabilities.data?.intake?.reason} uploadAvailable={capabilities.data?.draftAttachments === true} onProcessingChange={setProcessing} onSubmittingChange={setSubmitting} onAccessLoss={onAccessLoss}/> : <div className="intake-chat-empty"><h3>建案助手</h3><Button disabled={busy || !capabilities.data?.intake?.available} onClick={() => selectTab('chat')}>开始整理案件信息</Button></div>}</div></div>
      </div>
    </>}
    <Modal title="继续未完成案件" open={resumeOpen} footer={null} onCancel={() => setResumeOpen(false)} destroyOnHidden>
      <ErrorNotice error={resumeError} retry={() => void loadDrafts()}/>
      {resumeLoading && <Loading label="正在读取未完成案件"/>}
      <div className="intake-resume-list">{drafts.filter(item => item.status === 'open' && item.id !== draft?.id).map(item => <Button block key={item.id} disabled={busy || resumeLoading} onClick={() => void switchDraft(item.id)}><span>{item.fields.title || '未命名案件'}</span><span>{formatTime(item.updatedAt)}</span></Button>)}</div>
      {!resumeLoading && !resumeError && !drafts.some(item => item.status === 'open' && item.id !== draft?.id) && <p className="intake-footnote">暂无其他未完成案件。</p>}
      {nextBefore && <Button block type="text" disabled={resumeLoading} onClick={() => void loadDrafts(true)}>加载更早记录</Button>}
    </Modal>
    <Modal title="放弃本次填写？" open={discardOpen} okText="放弃填写" okButtonProps={{danger: true}} cancelText="继续编辑" confirmLoading={busy} onCancel={() => setDiscardOpen(false)} onOk={() => void perform(async () => {if (!draft) return; const body = {expectedRevision: draft.revision}; update(await api<CaseDraft>(`${draftPath(draft.id)}/discard`, {method: 'POST', body: {...body, idempotencyKey: commandKey(`discard:${draft.id}`, body)}})); setDiscardOpen(false);})} destroyOnHidden><p>放弃后不能继续编辑或创建案件，已保存的记录会保留。</p></Modal>
  </div>;
}

function sourceLabels(refs: string[], attachments: DraftAttachments) {
  const labels = refs.map(ref => {
    if (ref.startsWith('message:') || ref.startsWith('reply:')) return '对话描述';
    if (ref.startsWith('field:')) return `已保存的${fieldLabels[ref.slice(6) as DraftField] ?? '案件信息'}`;
    const file = attachments.items.find(item => ref.startsWith(`${item.id}:`));
    const page = ref.match(/:p(\d+):/);
    return file ? `${file.filename}${page ? ` · 第 ${page[1]} 页` : ''}` : '所选材料';
  });
  return [...new Set(labels)].join('、') || '对话描述';
}
function DraftChat({draft, dirty, busy, beforeSend, apply, undo, mergeRemote, attachments, useAttachment, available, unavailableReason, uploadAvailable, onProcessingChange, onSubmittingChange, onAccessLoss}: {
  draft: CaseDraft; dirty: boolean; busy: boolean; beforeSend: () => Promise<CaseDraft>; apply: (turn: DraftTurn, ids: string[]) => Promise<void>; undo: (turn: DraftTurn) => Promise<void>; mergeRemote: (draft: CaseDraft) => void; attachments: DraftAttachments; useAttachment?: {id: string; key: string; draftId: string}; available: boolean; unavailableReason?: string; uploadAvailable: boolean; onProcessingChange: (processing: boolean) => void; onSubmittingChange: (submitting: boolean) => void; onAccessLoss: (failure: unknown) => void;
}) {
  const [turns, setTurns] = useState<DraftTurn[]>([]);
  const [input, setInput] = useState('');
  const [error, setError] = useState<unknown>();
  const [loading, setLoading] = useState(true);
  const [sending, setSending] = useState(false);
  const [active, setActive] = useState<string>();
  const [recovering, setRecovering] = useState(false);
  const [interrupted, setInterrupted] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [uncertainClient, setUncertainClient] = useState<string>();
  const canceled = useRef(new Set<string>());
  const activeRef = useRef<string | undefined>(undefined);
  const alive = useRef(true);
  const fileInput = useRef<HTMLInputElement>(null);
  const usedAttachment = useRef<string | undefined>(undefined);
  const mergeRef = useRef(mergeRemote); mergeRef.current = mergeRemote;
  const eventHandler = useRef((event: IntakeEvent) => {
    if (event.type === 'draft_updated' && event.draft) mergeRef.current(event.draft);
  });
  const provider = useMemo(() => createIntakeProvider(draft.id, id => alive.current && activeRef.current === id && !canceled.current.has(id), event => eventHandler.current(event), value => {if (alive.current) setInterrupted(value);}), [draft.id]);
  const chat = useXChat<IntakeMessage, IntakeMessage, IntakeRequest>({
    provider,
    requestPlaceholder: request => request.resume ?? ({role: 'assistant', content: '正在整理信息', turnId: request.turnId!, requestId: request.clientTurnId!, draftRevision: request.draftRevision!}),
    requestFallback: (request, info) => intakeRequestFallback(request, info.error, info.messageInfo?.message),
  });
  const chatRef = useRef(chat); chatRef.current = chat;
  const refresh = useCallback(async () => {
    const result = await api<{items: DraftTurn[]}>(`${draftPath(draft.id)}/turns`);
    if (alive.current) {setTurns(result.items); setUncertainClient(previous => previous && !result.items.some(turn => turn.clientTurnId === previous) ? previous : undefined);}
    return result.items;
  }, [draft.id]);
  const connect = useCallback((turn: DraftTurn) => {
    activeRef.current = turn.id; setActive(turn.id); setInterrupted(false);
    chatRef.current.setMessages([]);
    const resume = turnMessage(turn);
    chatRef.current.onRequest({turnId: turn.id, clientTurnId: turn.clientTurnId, draftRevision: turn.draftRevision, text: turn.text, after: resume.seq ?? 0, resume});
  }, []);
  useEffect(() => {
    alive.current = true;
    void refresh().then(list => {
      if (!alive.current) return;
      const pending = list.find(turn => ['pending', 'running'].includes(turn.status));
      if (pending && draft.status === 'open') connect(pending);
    }).catch(failure => {if (alive.current) {if (accessLost(failure)) onAccessLoss(failure); else {setError(failure); setInterrupted(true);}}}).finally(() => {if (alive.current) setLoading(false);});
    return () => {alive.current = false; activeRef.current = undefined; if (provider.request.isRequesting) chatRef.current.abort(); chatRef.current.setMessages([]);};
  }, [refresh, connect, provider, draft.status]);
  useEffect(() => {
    if (!active || chat.isRequesting || !chat.messages.length) return;
    let stale = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const checkResult = () => void refresh().then(async list => {
      if (stale || !alive.current) return;
      const turn = list.find(item => item.id === active);
      if (turn && ['pending', 'running'].includes(turn.status)) {setInterrupted(true); timer = setTimeout(checkResult, 5000); return;}
      const updated = await api<CaseDraft>(draftPath(draft.id));
      if (stale || !alive.current) return;
      mergeRef.current(updated); void attachments.refresh().catch(() => undefined);
      activeRef.current = undefined; setActive(undefined); setInterrupted(false); chatRef.current.setMessages([]);
    }).catch(failure => {if (!stale && alive.current) {if (accessLost(failure)) {onAccessLoss(failure); return;} setError(failure); setInterrupted(true); timer = setTimeout(checkResult, 5000);}});
    checkResult();
    return () => {stale = true; clearTimeout(timer);};
  }, [active, chat.isRequesting, chat.messages.length, refresh, draft.id, onAccessLoss]);
  const refreshAttachments = attachments.refresh;
  useEffect(() => {
    if (!active) return;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const checkAttachments = async () => {
      try {await refreshAttachments();} catch (failure) {if (!stopped && accessLost(failure)) {onAccessLoss(failure); return;}}
      if (!stopped) timer = setTimeout(() => void checkAttachments(), 5000);
    };
    void checkAttachments();
    return () => {stopped = true; clearTimeout(timer);};
  }, [active, refreshAttachments, onAccessLoss]);
  async function send(text = input.trim(), attachmentIds = attachments.readySelected) {
    if ((!text && !attachmentIds.length) || sending || busy || chat.isRequesting || uncertainClient || !available || draft.status !== 'open' || attachments.blocked || turns.some(item => ['pending', 'running'].includes(item.status))) return;
    setSending(true); onSubmittingChange(true); setError(undefined);
    const clientTurnId = newKey(); let submitted = false;
    try {
      const saved = await beforeSend(); submitted = true;
      const {turn} = await api<{turn: DraftTurn}>(`${draftPath(draft.id)}/turns`, {method: 'POST', body: {expectedRevision: saved.revision, clientTurnId, text, attachmentIds}});
      if (!alive.current) return;
      setInput(''); attachments.setSelected(previous => previous.filter(id => !attachmentIds.includes(id))); setTurns(previous => [...previous.filter(item => item.id !== turn.id), turn]);
      if (['pending', 'running'].includes(turn.status)) connect(turn);
      else mergeRef.current(await api<CaseDraft>(draftPath(draft.id)));
    } catch (failure) {
      if (alive.current) {setError(failure); if (submitted && failure instanceof ApiError && failure.status === 0) {setUncertainClient(clientTurnId); setInterrupted(true); try {const list = await refresh(); const accepted = list.find(item => item.clientTurnId === clientTurnId); if (accepted) {setInput(''); if (['pending', 'running'].includes(accepted.status)) connect(accepted);} else setUncertainClient(clientTurnId);} catch {/* Preserve the unknown receipt; do not replay the POST. */}}}
    } finally {onSubmittingChange(false); if (alive.current) setSending(false);}
  }
  const sendRef = useRef(send); sendRef.current = send;
  useEffect(() => {
    if (!useAttachment || useAttachment.draftId !== draft.id || usedAttachment.current === useAttachment.key) return;
    usedAttachment.current = useAttachment.key; attachments.toggle(useAttachment.id, true);
    if (available && !busy && !sending && !chat.isRequesting && !attachments.blocked && !turns.some(item => ['pending', 'running'].includes(item.status))) void sendRef.current('', [useAttachment.id]);
  }, [useAttachment]);
  async function recover() {
    setRecovering(true); setError(undefined);
    try {
      // Let the old SDK callback settle before it can overwrite a new connection.
      if (provider.request.isRequesting) {chat.abort(); await provider.request.asyncHandler;}
      if (!alive.current) return;
      const list = await refresh();
      if (!alive.current) return;
      if (uncertainClient && list.some(item => item.clientTurnId === uncertainClient)) setInput('');
      const pending = list.find(item => ['pending', 'running'].includes(item.status));
      if (pending && draft.status === 'open' && !canceled.current.has(pending.id)) connect(pending);
      else {mergeRef.current(await api<CaseDraft>(draftPath(draft.id))); activeRef.current = undefined; setActive(undefined); chat.setMessages([]); setInterrupted(false);}
    } catch (failure) {if (alive.current) {if (accessLost(failure)) onAccessLoss(failure); else {setError(failure); setInterrupted(true);}}} finally {if (alive.current) setRecovering(false);}
  }
  async function cancel(turn: DraftTurn) {
    canceled.current.add(turn.id); if (provider.request.isRequesting) chat.abort(); setSending(true);
    try {const result = await api<{turn: DraftTurn}>(`${draftPath(draft.id)}/turns/${turn.id}/cancel`, {method: 'POST'}); if (!alive.current) return; setTurns(previous => previous.map(item => item.id === turn.id ? result.turn : item)); activeRef.current = undefined; setActive(undefined); chat.setMessages([]); setInterrupted(false);}
    catch (failure) {setError(failure); setInterrupted(true);} finally {if (alive.current) setSending(false);}
  }
  const pending = turns.find(item => ['pending', 'running'].includes(item.status));
  useEffect(() => {onProcessingChange(!!pending || sending || chat.isRequesting);}, [pending, sending, chat.isRequesting, onProcessingChange]);
  useEffect(() => () => onProcessingChange(false), [onProcessingChange]);
  const history: MessageInfo<IntakeMessage>[] = turns.filter(turn => turn.id !== active).flatMap(turn => [
    {id: `${turn.id}:user`, status: 'local' as const, message: {role: 'user' as const, content: turn.text, turnId: turn.id, requestId: turn.clientTurnId, draftRevision: turn.draftRevision}},
    {id: `${turn.id}:assistant`, status: 'success' as const, message: turnMessage(turn)},
  ]);
  const rendered = [...history, ...chat.messages].map(({id, message, status}) => {
    const turn = turns.find(item => item.id === message.turnId);
    const canApply = !!turn && turn.status === 'ready' && !busy && !dirty && !pending && !chat.isRequesting && !sending && !canceled.current.has(message.turnId) && draft.status === 'open' && (turn.resultRevision ?? turn.draftRevision) === draft.revision;
    const conflicts = message.conflictFields ?? turn?.conflictFields;
    const suggestion = message.suggestion && {...message.suggestion, candidates: conflicts ? message.suggestion.candidates.filter(candidate => conflicts.includes(candidate.field)) : message.suggestion.candidates};
    return {key: id, role: message.role, content: <div>
      {message.content && <p className="intake-message-text">{message.content}</p>}
      {message.connectionNotice && <p className="intake-chat-note" role="status">{message.connectionNotice}</p>}
      {message.role === 'user' && !!turn?.attachmentIds?.length && <p className="intake-message-attachment">{turn.attachmentIds.length} 份附件 · {turn.attachmentIds.map(attachmentId => attachments.items.find(item => item.id === attachmentId)?.filename).filter(Boolean).join('、')}</p>}
      {message.role === 'assistant' && <>
        {!!message.replyBlocks?.some(block => block.sourceRefs.length) && <p className="intake-footnote">依据：{sourceLabels(message.replyBlocks.flatMap(block => block.sourceRefs), attachments)}</p>}
        {!!message.steps?.length && <details className="intake-process"><summary>查看处理过程</summary><ThoughtChain defaultExpandedKeys={[]} items={message.steps.map(step => ({key: step.key, title: step.title, status: step.status === 'completed' ? 'success' : step.status === 'failed' ? 'error' : step.status === 'running' ? 'loading' : undefined, description: step.durationMs === undefined ? undefined : `${(step.durationMs / 1000).toFixed(1)} 秒`, content: step.summary, collapsible: !!step.summary}))}/></details>}
        {!!turn?.questions?.length && <div className="intake-questions">{turn.questions.map((question, index) => <p key={index}>{question}</p>)}</div>}
        {!!message.appliedFields?.length && <div className="intake-applied"><p>已填写：{message.appliedFields.map(field => fieldLabels[field]).join('、')}</p><Button type="link" size="small" disabled={!canApply} onClick={() => turn && void undo(turn)}>撤销本轮填写</Button></div>}
        {suggestion && <Suggestions suggestion={suggestion} disabled={!canApply} onApply={ids => turn && void apply(turn, ids)} conflict={!!conflicts?.length}/>}
        {turn?.status === 'failed' && turn.errorCode && <p className="intake-footnote">错误编号：{turn.errorCode}</p>}
      </>}
    </div>, loading: status === 'loading' && !message.replyBlocks?.length && !message.steps?.length};
  });
  const locked = draft.status !== 'open' || busy || !!uncertainClient || !available;
  const canSend = !locked && !pending && !attachments.blocked && (!!input.trim() || !!attachments.readySelected.length);
  return <section className="intake-chat" aria-labelledby="intake-chat-heading">
    <div className="intake-section-heading"><div className="intake-assistant-heading"><IntakeAssistantIcon/><div><h2 id="intake-chat-heading">建案助手</h2><p>描述需求，辅助填写案件信息</p></div></div>{(interrupted || uncertainClient) && <Button type="text" disabled={sending || recovering} loading={recovering} onClick={() => void recover()}>重新连接</Button>}</div>
    <ErrorNotice error={error}/>
    {!available && <p className="intake-chat-note" role="status">{unavailableReason && /[\u4e00-\u9fff]/.test(unavailableReason) ? unavailableReason : '建案助手暂不可用，可手动填写案件信息。'}</p>}
    {loading ? <Loading label="正在恢复对话"/> : rendered.length ? <Bubble.List className="intake-messages" role={bubbleRoles} items={rendered}/> : <div className="intake-chat-empty"><h3>从一段描述开始</h3><p>输入案件描述或添加材料，助手会整理客户号、司法管辖地、币种和担保金额，并勾选有依据的担保类型。</p><p className="intake-chat-reminder">未知信息留空，创建前请核对表单与担保类型。</p></div>}
    <div className={`intake-sender${dragging ? ' is-dragging' : ''}`} onDragOver={event => {if (!locked && uploadAvailable && event.dataTransfer.types.includes('Files')) {event.preventDefault(); setDragging(true);}}} onDragLeave={event => {if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDragging(false);}} onDrop={event => {event.preventDefault(); setDragging(false); if (!locked && uploadAvailable) void attachments.add(Array.from(event.dataTransfer.files), true);}}>
      {uncertainClient && <p className="intake-conflict" role="status">发送结果尚不确定，请重新连接。为避免重复处理，暂不再次发送。</p>}
      {pending && !chat.isRequesting && <div className="intake-pending"><span>此轮仍在处理中</span><Button size="small" onClick={() => void recover()}>重新连接</Button><Button size="small" disabled={sending} onClick={() => void cancel(pending)}>取消处理</Button></div>}
      <AttachmentList attachments={attachments} draftId={draft.id} disabled={locked} compact/>
      <input ref={fileInput} hidden type="file" multiple accept={draftAttachmentAccept} onChange={event => {void attachments.add(Array.from(event.target.files ?? []), true); event.target.value = '';}}/>
      <Sender value={input} onChange={value => setInput(value.slice(0, CASE_FIELD_LIMITS.background))} onSubmit={() => void send()} loading={sending || chat.isRequesting} onCancel={() => {const turn = turns.find(item => item.id === active) ?? pending; if (turn) void cancel(turn);}} disabled={locked} autoSize={{minRows: 2, maxRows: 4}} placeholder={dragging ? '松开即可上传附件' : '描述案件，或拖入附件'} onPasteFile={files => {if (!locked && uploadAvailable) void attachments.add(Array.from(files), true);}} suffix={false} footer={(_, {components}) => <div className="intake-composer-actions"><Button type="text" disabled={locked || !uploadAvailable} aria-label="添加对话附件" onClick={() => fileInput.current?.click()}><span className="intake-add-icon" aria-hidden="true">＋</span></Button>{sending || chat.isRequesting ? <components.LoadingButton aria-label="取消处理"/> : <components.SendButton type="primary" aria-label="发送描述" disabled={!canSend}/>}</div>}/>
      <div className="intake-sender-footer"><span>{attachments.readySelected.length ? `将发送 ${attachments.readySelected.length} 份附件` : '支持附件、拖拽及粘贴图片'}</span><span>{input.length} / {CASE_FIELD_LIMITS.background}</span></div>
    </div>
  </section>;
}
const bubbleRoles = {user: {placement: 'end' as const, styles: {root: {paddingInline: 0}, body: {maxWidth: '100%', minWidth: 0}, content: {background: semantic.chatUserBackground, color: palette.text}}}, assistant: {placement: 'start' as const, styles: {root: {paddingInline: 0}, body: {width: '100%', maxWidth: '100%', minWidth: 0}, content: {background: palette.surface, color: palette.text}}}};
function Suggestions({suggestion, disabled, onApply, conflict}: {suggestion: DraftSuggestion; disabled: boolean; onApply: (ids: string[]) => void; conflict: boolean}) {
  const [selected, setSelected] = useState<string[]>(suggestion.candidates.map(item => item.candidateId));
  const candidateKey = suggestion.candidates.map(item => item.candidateId).join(',');
  useEffect(() => setSelected(suggestion.candidates.map(item => item.candidateId)), [candidateKey]);
  if (!suggestion.questions.length && !suggestion.candidates.length) return null;
  return <div className="intake-suggestions">
    {suggestion.questions.map((question, index) => <p key={`${question.field}:${index}`}>{questionText(question)}</p>)}
    {!!suggestion.candidates.length && <><p className="intake-suggestion-label">{conflict ? '这些字段保留了你的手动填写。核对后可替换：' : '建议填写'}</p><Checkbox.Group value={selected} onChange={value => setSelected(value as string[])} disabled={disabled}>{suggestion.candidates.map(candidate => <div key={candidate.candidateId} className="intake-candidate"><Checkbox value={candidate.candidateId}><span><strong>{fieldLabels[candidate.field]}</strong><span className="pre-wrap">{fieldValueText(candidate.field, candidate.value)}</span>{!!candidate.sourceRefs?.length && <span className="intake-footnote">依据本轮描述或所选材料</span>}</span></Checkbox></div>)}</Checkbox.Group><Button disabled={disabled || !selected.length} onClick={() => onApply(selected)}>{conflict ? '替换所选字段' : '应用所选建议'}</Button></>}
  </div>;
}
