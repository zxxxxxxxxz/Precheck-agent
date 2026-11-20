import {StartReviewButton} from '../features/review/start-review.tsx';
import {reviewEvidenceInScope} from '@hsbc/contracts/review';
import {materialKey,materialScope,materialDetail,materialRange,materialLabel,adoptedFileCount} from '../features/review/material-adoption.ts';
import {SignatureInformationSummaryView} from '../features/review/signature-information-summary.tsx';
import type {ChecklistRow} from '@hsbc/contracts/review-checklist';
import {sameFieldLocations} from '../features/review/field-comparison.ts';
import {caseExtractionPath, caseMaterialsPath, reviewResultsPath} from '../features/cases/workspace-navigation.ts';
import {FieldChecklist} from '../features/review/field-checklist.tsx';
import {SubjectConfirmation} from '../features/review/subject-confirmation.tsx';
import {RoundControls, roundQuery, useReviewRounds} from '../features/review/round-controls.tsx';
import {ReviewProgressSlot} from '../features/review/semantic-progress.tsx';
import {ConfigurationPicker} from '../features/review/configuration-picker.tsx';
import {objectLabel} from '../features/review/workbench-presentation.ts';
import {PERSONAL_DERIVED_FIELDS,PERSONAL_FACT_OPTIONS} from '@hsbc/contracts/personal-requirements';
import {CORPORATE_DERIVED_FIELDS,CORPORATE_FACT_OPTIONS} from '@hsbc/contracts/corporate-requirements';
import React, {useEffect, useRef, useState} from 'react';
import {Alert, App, Button, Checkbox, Form, Input, InputNumber, Modal, Select, Table, Tabs, Tag} from 'antd';
import {useQuery} from '@tanstack/react-query';
import {Link, Navigate, useNavigate, useSearchParams} from 'react-router';
import type {ReviewEvidence, ReviewFact, ReviewIssue, ReviewMaterial, ReviewObject, ReviewState, ReviewRun} from '@hsbc/contracts/review';
import {ApiError,api, newKey, queryClient} from '../api.ts';
import {can} from '../features/identity/permissions.ts';
import {formatTime} from '../shared/format.ts';
import {useAuth} from '../auth.tsx';
import {useCapabilities} from '../capabilities.ts';
import type {CaseSummary} from '../features/cases/types.ts';
import type {Material} from '../features/materials/types.ts';
import {evidenceForResult, factStateLabels, isReviewRunning, materialRelationLabels as relationLabels, objectKindLabels, objectRelationLabels, objectRelationOptions, readableValue, resultLabels, reviewReason, runStateLabels} from '../features/review/presentation.ts';
import type {DirectoryResponse, FieldsResponse, PageSummary, DocumentPageArtifact, ProcessingStatus} from '../features/documents/types.ts';
import {readableSourceNodes, type SourceDocumentResponse} from '../sourceDocument.ts';
import {ActionModal, Blank, blocksView, ErrorNotice, LinkButton, Loading, ReasonField, RefreshNotice, Section} from '../ui.tsx';
import {useReviewUnsavedChanges} from '../features/review/use-unsaved-changes.ts';
import {CompanyIdentityLookup, type CompanyNameChoice} from '../features/review/company-identity.tsx';
import {fieldDisplayText} from '../features/documents/presentation.ts';
import {candidateFactChoices} from '../features/review/candidate-fact-choices.ts';
import {EvidenceLinks} from '../features/review/evidence-links.tsx';
import {SelectedEvidence} from '../features/review/evidence-selection.tsx';
import {evidenceIdentity, pageEvidencePreview, sourceEvidencePreview, type EvidencePreview} from '../features/review/evidence-preview.ts';
import {RunResults} from '../features/review/run-results.tsx';
import {ProcessingAccessHistory} from '../features/documents/processing-access-history.tsx';
import './review-loop.css';

const required = [{required: true, whitespace: true, message: '请填写此项'}];
const issueLabels: Record<string, string> = {open: '待处理', resolved: '已关闭', acknowledged: '已记录'};
const historyLabels: Record<string, string> = {round_prepared: '准备本轮材料', round_result_confirmed: '确认初审结果', round_reopened: '返回本轮更正', round_discarded: '放弃本轮准备', materials_removed:'移除本轮文件',material_source_confirmed:'确认使用新提取结果',material_adopt:'本轮材料',material_reject:'撤回采用范围',configuration_bound: '绑定配置', material_adopted: '纳入材料', material_rejected: '不采纳材料', object_confirmed: '确认对象关联', fact_corrected: '保存事实更正', fact_confirmed: '确认事实', review_started: '开始检查', review_completed: '检查完成', external_reply: '登记外部反馈', check_requested: '申请检查', check_completed: '检查完成', check_failed: '检查未完成', check_canceled: '取消检查', issue_reply: '登记外部反馈', issue_decided: '问题处置', issue_opened: '发现检查问题', issue_rechecked: '问题重新检查', supplement_requested: '请求补充提取', supplement_dispatched: '已提交补充提取'};

export function useCaseReview(item: CaseSummary, configurationOnly = false, refreshInterval?:number, freshOnEntry = false) {
  const {session} = useAuth(); const capabilities = useCapabilities();
  const loopEnabled = capabilities.data?.reviewLoop === true;
  const enabled = (loopEnabled || (configurationOnly && capabilities.data?.reviewConfiguration === true)) && can(item.allowed_actions, 'case:read');
  const key = ['case-review', session.user?.accountId, item.id,item.selectedRoundId??'current'];
  const query = useQuery({queryKey: key, enabled, ...(freshOnEntry?{refetchOnMount:'always' as const,staleTime:0}:{}), queryFn: ({signal}) => api<ReviewState>(`/api/cases/${encodeURIComponent(item.id)}/review${roundQuery(item.selectedRoundId)}`, {signal}), refetchInterval: value => refreshInterval??(value.state.data?.runs.some(run => isReviewRunning(run.state)) ? 5000 : 30_000)});
  // Enter the desk only after reading this round again, even when its cache is still fresh.
  // A failed entry refresh must not unlock a checklist based on the previous visit.
  const entryPending=freshOnEntry&&!query.isFetchedAfterMount&&!query.isError;
  const entryReady=!freshOnEntry||query.isFetchedAfterMount&&!query.isError;
  return {...query, isPending:query.isPending||entryPending, capabilitiesPending:capabilities.isPending, capabilitiesError:capabilities.error, retryCapabilities:capabilities.refetch, enabled, loopEnabled, data: entryReady && enabled && !blocksView(query) && query.data?.caseId === item.id ? query.data : undefined, key};
}
async function refreshReview(caseId: string) {await Promise.all(['review-rounds','case-review', 'case', 'cases', 'workbench', 'materials', 'document-fields', 'review-checklist'].map(name => queryClient.invalidateQueries({queryKey: name === 'case' || name === 'materials' ? [name, caseId] : [name]})));}
function Snapshot({state, revision = true}: {state: ReviewState; revision?: boolean}) {const latest = state.runs[0]; return <div className="review-loop-snapshot">{state.businessDate && <span>审核基准日 <strong>{state.businessDate}</strong></span>}{revision && <span>修订 <strong className="mono">r{state.revision}</strong></span>}<span>配置 <strong>{state.configuration?.label ?? '待选择'}</strong></span><span>本轮材料 <strong>{state.materialCount??adoptedFileCount(state.materials)} 份</strong></span>{latest && <span>检查 <strong>{latest.validity === 'stale' ? '等待手动重审' : runStateLabels[latest.state] ?? latest.state}</strong></span>}</div>;}

export function StartReviewAction({item}: {item: CaseSummary}) {
  const query = useCaseReview(item);
  return query.data&&!item.closure?<StartReviewButton key={`${item.id}:${item.selectedRoundId??'current'}`} state={query.data}/>:null;
}

/** Configuration stays with the material list and retains the original command. */
export function MaterialReviewConfiguration({item}: {item: CaseSummary}) {
  const query = useCaseReview(item, true); const [action, setAction] = useState<'configuration'>();
  if (!query.data || !can(query.data.allowedActions, 'case:configure')) return null;
  return <>
    <Button className="material-configuration-button" onClick={() => setAction('configuration')}>更换配置</Button>
    {action && query.data && can(query.data.allowedActions,'case:configure') && <ReviewCommand item={item} state={query.data} path="configuration" title="绑定配置" close={() => setAction(undefined)} warning="更换后，新提取和业务检查使用所选配置。已有字段不会自动更新，请逐份重新提取；原有事实和检查结果可能需要重新核对。">
      <ConfigurationPicker state={query.data}/>
    </ReviewCommand>}
  </>;
}

export function ReviewLoop({item}: {item: CaseSummary}) {
  return <ReviewDesk key={`${item.id}:${item.selectedRoundId??'current'}`} item={item}/>;
}

function ReviewDesk({item}: {item: CaseSummary}) {
  const query = useCaseReview(item, false, undefined, true);
  const rounds = useReviewRounds(item.id);
  const [object, setObject] = useState<{value?: ReviewObject; context?: ChecklistRow}>();
  const [fact, setFact] = useState<{value?: ReviewFact; context?: ChecklistRow}>();
  const [params, setParams] = useSearchParams();
  const manage = params.get('manage') ?? params.get('tab');
  const setObjectsOpen = (open: boolean) => setParams(current => {
    const next = new URLSearchParams(current); next.set('tab', 'checklist');
    if (open) next.set('manage', 'objects'); else next.delete('manage');
    return next;
  }, {replace: true});
  if(query.capabilitiesPending)return <Loading/>;
  if(query.capabilitiesError)return <ErrorNotice error={query.capabilitiesError} retry={()=>void query.retryCapabilities()}/>;
  if (!query.enabled) return <Blank title="业务核对暂未开放"/>;
  if (query.isPending) return <Loading label="正在同步本轮核对数据"/>;
  const state = query.data;
  if (!state) return <ErrorNotice error={query.error} retry={() => void query.refetch()}/>;
  if (params.get('tab') === 'results') return <Navigate replace to={reviewResultsPath(item.id, state.roundId??(state.legacyView?'legacy':null))}/>;
  const editable = !state.readOnly && can(state.allowedActions, 'field:correct');
  return <div className="review-loop-workspace field-workspace"><Section title="业务核对" className="review-desk-section">
    <RefreshNotice query={query} retry={() => void query.refetch()}/>
    {!state.configuration && <p>请先在<Link to={caseMaterialsPath(item.id, item.selectedRoundId)}>材料区</Link>绑定已发布配置。</p>}
    {state.configuration && <SubjectConfirmation state={state}/>}
    <FieldChecklist key={`${state.caseId}:${state.roundId??'legacy'}`} state={state}
      indexFooter={<>
        <ReviewProgressSlot/>
        <div className="field-index-actions"><StartReviewAction key={`${item.id}:${item.selectedRoundId??'current'}`} item={item}/><RoundControls item={item} state={blocksView(rounds) ? undefined : rounds.data} compact inline reviewAction={null}/></div>
        <Link className="field-index-reader-link" to={caseExtractionPath(item.id, item.selectedRoundId)}>按原件逐份核对</Link>
      </>}
      onEditFact={row => setFact({value: row.fact??undefined, context: row})}
      onEditObject={row => setObject({value: state.objects.find(o=>o.objectId===row.objectId), context: row})}
      onManageObjects={() => setObjectsOpen(true)}/>
  </Section>
    <Modal title="对象与材料归属" open={manage==='objects'} width={1100} footer={null} onCancel={()=>setObjectsOpen(false)} destroyOnHidden>
      <div className="review-loop-toolbar">{editable && <Button disabled={!state.configuration} onClick={() => setObject({})}>确认新对象</Button>}</div><Table<ReviewObject> rowKey="objectId" pagination={false} scroll={{x: 700}} dataSource={state.objects} columns={[
        {title: '对象', dataIndex: 'label', render: (_, value) => <>{objectLabel(value.objectId,state.objects)}{value.validity === 'stale' && <div className="tone-warning">依据已更新 · 待重新核对</div>}</>}, {title: '类别／角色', key: 'role', render: (_, value) => <>{objectKindLabels[value.kind] ?? value.kind} · {value.role==='corporate_guarantee'?'公司担保':value.role==='personal_guarantee'?'个人担保':value.role}</>},
        {title: '关联方式', key: 'attribution', render: (_, value) => value.automaticAttribution ? '系统自动关联' : '人工确认'},
        {title: '关系', key: 'relations', render: (_, value) => value.relations.length ? value.relations.map((relation, index) => <div key={index}>{objectRelationLabels[relation.kind] ?? relation.kind} → {objectLabel(relation.targetObjectId,state.objects)}</div>) : '无关联'},
        {title: '依据', key: 'evidence', render: (_, value) => <EvidenceLinks caseId={item.id} evidence={value.evidence}/>},
        {title: '操作', key: 'action', render: (_, value) => <div className="review-loop-toolbar-actions">{editable && <Button type="link" onClick={() => setObject({value})}>更正关联</Button>}{value.kind === 'party' && <CompanyIdentityLookup caseId={item.id} revision={state.revision} names={[value.label]}/>}</div>},
      ]}/>
    </Modal>
    {object && editable && <ObjectDialog item={item} state={state} value={object.value} context={object.context} close={() => setObject(undefined)}/>}
    {fact && editable && <FactDialog item={item} state={state} value={fact.value} context={fact.context} close={() => setFact(undefined)}/>}
  </div>;
}

export function ObjectDialog({item, state, value, draft, context, close}: {item: CaseSummary; state: ReviewState; value?: ReviewObject; context?: ChecklistRow; draft?: {label?: string; evidence: ReviewEvidence[]; documentId: string; pageNumber: number}; close: () => void}) {
  const [evidence, setEvidence] = useState<ReviewEvidence[]>(value?.evidence ?? draft?.evidence ?? []);
  const contextDefinition=state.configuration?.fields.find(f=>f.id===context?.fieldId);
  const initialKind=value?.kind??contextDefinition?.objectKind??(state.configuration?.fields.some(field=>['corporate_guarantee','personal_guarantee'].includes(field.objectRole??''))?'guarantee':'party');
  const [form] = Form.useForm(); const [kind, setKind] = useState<string>(initialKind);
  const [companyName, setCompanyName] = useState<CompanyNameChoice>();
  const label = Form.useWatch('label', form) as string | undefined;
  const relations = Form.useWatch('relations', form) as ReviewObject['relations'] | undefined;
  useEffect(() => {if (companyName && (kind !== 'party' || (label !== undefined && label !== companyName.label))) setCompanyName(undefined);}, [label, kind, companyName]);
  const roles = [...new Set(state.configuration?.fields.filter(field => field.objectKind === kind && field.objectRole).map(field => field.objectRole!) ?? [])];
  const roleOptions = (roles.length ? roles : [kind]).map(role => ({value: role, label: ({borrower:'借款人',mortgagor:'抵押人',corporate_guarantee:'公司担保',personal_guarantee:'个人担保'} as Record<string,string>)[role] ?? objectKindLabels[role] ?? role}));
  return <ReviewCommand item={item} state={state} form={form} contentVersion={JSON.stringify({evidence, relations, companyName})} path="objects" warning={state.roundsEnabled?'确认本轮对象与原文关联。核对完成后，在材料区手动开始本轮预审；历史轮次保持不变。':'确认对象与关联会建立新修订并使旧结果失效；核对后需在材料区手动开始重审。'} title={value ? '更正对象与关联' : '确认业务对象'} close={close} initialValues={{kind: initialKind,label: value?.label ?? draft?.label,role: value?.role ?? contextDefinition?.objectRole ?? roleOptions[0]?.value,relations: value?.relations ?? []}} mapValues={values => ({...(value ? {objectId: value.objectId} : {}),kind: values.kind,label: values.label,role: values.role,relations: values.relations ?? [],evidence,...(companyName && values.kind === 'party' && values.label === companyName.label ? {companyNameSelection: {lookupId: companyName.lookupId, lei: companyName.lei}} : {})})}>
    <div className="review-loop-fields"><Form.Item name="kind" label="对象类别" rules={required}><Select onChange={kind => {setKind(kind); form.setFieldsValue({relations: (form.getFieldValue('relations') ?? []).map((relation: ReviewObject['relations'][number]) => ({...relation, kind: kind !== 'party' && ['same_entity', 'different_entity'].includes(relation.kind) ? 'related' : relation.kind})), role:state.configuration?.fields.find(field => field.objectKind === kind && field.objectRole)?.objectRole ?? kind});}} options={Object.entries({...objectKindLabels, signatory: '签署人'}).filter(([key]) => key !== 'signer').map(([value, label]) => ({value, label}))}/></Form.Item><Form.Item name="label" label="对象名称" rules={required}><Input maxLength={300}/></Form.Item><Form.Item name="role" label="本案角色" rules={required}><Select showSearch={{optionFilterProp: 'label'}} options={roleOptions}/></Form.Item></div>
    {roles.includes('personal_guarantee') && <p>每位个人担保人单独建立对象。请添加属于此人的原文位置；同一文件中其他人的签署栏不能直接采用。共用授信或条款须分别明确关联。同名不代表同一人。</p>}
    {roles.some(role=>['corporate_guarantee','personal_guarantee'].includes(role)) && <p>系统按材料中的主体及原文位置自动关联。多个担保人分别核对；仅在关联有误或无法确定时，在此更正。</p>}
    {kind === 'party' && <div className="company-name-selection"><CompanyIdentityLookup caseId={item.id} revision={state.revision} names={label?.trim() ? [label] : []} onSelect={choice => {form.setFieldValue('label', choice.label); setCompanyName(choice);}}/>{companyName && <><span>已选 GLEIF 名称，保存后记录来源</span><Button type="link" onClick={() => setCompanyName(undefined)}>取消采用外部来源</Button></>}</div>}
    <Form.List name="relations">{(rows, {add, remove}) => <fieldset className="review-loop-subpanel"><legend>对象关系</legend><p className="muted">普通关联不证明主体相同。身份确认仅用于两个主体，须结合原文依据核对。</p>{rows.map(row => {
      const relation = relations?.[row.name];
      const target = state.objects.find(entry => entry.objectId === relation?.targetObjectId);
      return <div className="review-loop-fields" key={row.key}><Form.Item name={[row.name, 'targetObjectId']} label="关联对象" rules={required}><Select onChange={id => {form.setFieldValue(['relations', row.name, 'targetVersion'], undefined); if (kind !== 'party' || state.objects.find(entry => entry.objectId === id)?.kind !== 'party') form.setFieldValue(['relations', row.name, 'kind'], 'related');}} options={state.objects.filter(entry => entry.objectId !== value?.objectId).map(entry => ({value: entry.objectId, label: `${objectLabel(entry.objectId,state.objects)} · ${entry.role}`}))}/></Form.Item><Form.Item name={[row.name, 'kind']} label="关系" rules={required}><Select options={objectRelationOptions(kind, target?.kind, relation?.kind)}/></Form.Item>{relation && ['same_entity', 'different_entity'].includes(relation.kind) && relation.targetVersion !== undefined && target && relation.targetVersion !== target.version && <div className="review-loop-full"><p role="status">关联主体已更新，请重新核对原文和主体身份后确认当前版本。</p><Button onClick={() => form.setFieldValue(['relations', row.name, 'targetVersion'], target.version)}>已核对，确认当前对象版本</Button></div>}<Button onClick={() => remove(row.name)}>移除此关系</Button></div>;
    })}<Button onClick={() => add({kind: 'related'})}>新增关系</Button></fieldset>}</Form.List>
    <EvidencePicker item={item} state={state} value={evidence} onChange={setEvidence} initialDocumentId={draft?.documentId} initialPageNumber={draft?.pageNumber}/>
  </ReviewCommand>;
}

export function FactDialog({item, state, value, draft, context, close}: {item: CaseSummary; state: ReviewState; value?: ReviewFact; context?: ChecklistRow; draft?: {fieldId: string; objectId: string; rawValue?: string; evidence: ReviewEvidence[]; documentId: string; pageNumber: number}; close: () => void}) {
  const [evidence, setEvidence] = useState<ReviewEvidence[]>(value?.evidence ?? draft?.evidence ?? []);
  const [form] = Form.useForm(); const [candidate, setCandidate] = useState<ReviewFact['candidateRef']>();
  const [fieldId, setFieldId] = useState(value?.fieldId ?? draft?.fieldId ?? context?.fieldId); const definition = state.configuration?.fields.find(field => field.id === fieldId);
  const factOptions=definition?.objectRole==='personal_guarantee'?PERSONAL_FACT_OPTIONS[fieldId??'']:definition?.objectRole==='corporate_guarantee'?CORPORATE_FACT_OPTIONS[fieldId??'']:undefined;
  const personalAmountInput=definition?.objectRole==='personal_guarantee'&&fieldId==='pg_required_amount';
  return <ReviewCommand item={item} state={state} form={form} contentVersion={JSON.stringify({evidence,candidate})} path="facts" title={value ? '更正字段值' : '确认采用字段值'} close={close} initialValues={{objectId: value?.objectId ?? draft?.objectId ?? context?.objectId,fieldId: value?.fieldId ?? draft?.fieldId ?? context?.fieldId,state: value?.state ?? 'present',rawValue: value?.rawValue ?? draft?.rawValue ?? '',currency: value?.currency,unit: value?.unit,calendar: value?.calendar ?? 'gregorian'}} warning={state.roundsEnabled?'保存本轮事实及原文依据。核对完成后，在材料区手动开始本轮预审；历史轮次保持不变。':'保存保留原文和旧值，建立新修订并使旧结果失效；核对后需在材料区手动开始重审。'} mapValues={values => ({...(value && !value.automaticAdoption ? {factId: value.factId} : {}),objectId: values.objectId,fieldId: values.fieldId,state: values.state,rawValue: values.rawValue === '' || values.rawValue === undefined ? null : values.rawValue,...(values.currency ? {currency: values.currency} : {}),...(values.unit ? {unit: values.unit} : {}),calendar: values.calendar,evidence,...(candidate ? {candidateRef: candidate} : {})})}>
    {!value && !draft && !personalAmountInput && <CandidatePicker item={item} state={state} context={context} selected={!!candidate} onManual={() => setCandidate(undefined)} onSelect={choice => {setCandidate(choice.ref); setFieldId(choice.fieldId); setEvidence(choice.evidence); form.setFieldsValue({fieldId: choice.fieldId,rawValue: choice.rawValue,state: 'present',objectId: context?.objectId??undefined});}}/>}
    <div className="review-loop-fields"><Form.Item name="objectId" label="业务对象" rules={required}><Select disabled={!!value || !!draft || !!context?.objectId} options={state.objects.filter(object => !definition || (object.kind === definition.objectKind && (!definition.objectRole || object.role === definition.objectRole))).map(object => ({value: object.objectId, label: `${objectLabel(object.objectId,state.objects)} · ${object.role}`}))}/></Form.Item><Form.Item name="fieldId" label="字段定义" rules={required}><Select showSearch={{optionFilterProp: 'label'}} disabled={!!value || !!candidate || !!draft || !!context} onChange={id => {setFieldId(id); form.setFieldsValue({objectId: undefined,rawValue:undefined,currency:undefined,unit:undefined});}} options={state.configuration?.fields.filter(field=>field.id!=='review_business_date'&&!([...CORPORATE_DERIVED_FIELDS,...PERSONAL_DERIVED_FIELDS] as readonly string[]).includes(field.id)).map(field => ({value: field.id, label: field.label}))}/></Form.Item><Form.Item name="state" label="事实状态" rules={required}><Select disabled={!!candidate} options={Object.entries(factStateLabels).map(([value, label]) => ({value, label}))}/></Form.Item><Form.Item name="calendar" label="历法"><Select options={[{value: 'gregorian', label: '公历'}, {value: 'roc', label: '民国历'}]}/></Form.Item><Form.Item className="review-loop-full" name="rawValue" label={personalAmountInput?'要求的担保金额':'原文值'}>{factOptions?<Select disabled={!!candidate} options={factOptions}/>:<Input.TextArea readOnly={!!candidate} rows={3} maxLength={10000}/>}</Form.Item><Form.Item name="currency" label="币种"><Input disabled={definition?.unit==='persons'} maxLength={10} placeholder={definition?.currency ?? undefined}/></Form.Item><Form.Item name="unit" label="单位"><Input maxLength={20} placeholder={definition?.unit ?? undefined}/></Form.Item></div>
    {personalAmountInput&&<p>填写用户或审批要求的金额及币种，并在操作依据中说明要求来源。可以直接填写；如有审批材料，也可附上原文依据。不能用保证书金额代替用户要求。</p>}
    {definition?.objectRole==='personal_guarantee' && !personalAmountInput && <p>请核对所选担保人与原文位置。只有看清空栏并选取依据后，才能确认“按要求留空”；遮挡、不可读或未识别到应保留待确认。</p>}
    {value && <p>已保存规范值：{readableValue(value.normalizedValue)} · {value.normalization.status === 'pending' ? '待确认' : '可回算'}</p>}
    {candidate ? <div className="review-loop-subpanel"><strong>候选原文依据</strong><EvidenceLinks caseId={item.id} evidence={evidence}/><p>选择业务对象并核对原文后保存。需要更正原值或依据时，请切换人工填写。</p></div> : <EvidencePicker item={item} state={state} value={evidence} onChange={setEvidence} initialDocumentId={draft?.documentId ?? context?.candidates[0]?.documentId} initialPageNumber={draft?.pageNumber}/>}
  </ReviewCommand>;
}

export function EvidencePicker({item, state, value, onChange, pageOnly = false, initialDocumentId, initialPageNumber = 1}: {item: CaseSummary; state: ReviewState; value: ReviewEvidence[]; onChange: (value: ReviewEvidence[]) => void; pageOnly?: boolean; initialDocumentId?: string; initialPageNumber?: number}) {
  const capabilities = useCapabilities(); const [selection,setSelection]=useState(()=>{const matches=state.materials.filter(entry=>entry.documentVersionId===initialDocumentId&&entry.operation==='adopt');return matches.length===1?materialKey(matches[0]!):undefined;}); const [pageNumber, setPageNumber] = useState(initialPageNumber); const [kind, setKind] = useState<'page' | 'source'>('page');
  const [previews, setPreviews] = useState<Record<string, EvidencePreview>>({});
  const readable = capabilities.data?.documentReader === true && can(item.allowed_actions, 'evidence:read');
  const registered = useQuery({queryKey: ['materials', item.id, item.selectedRoundId ?? 'current'], enabled: can(item.allowed_actions, 'case:read'), queryFn: ({signal}) => api<{items: Material[]}>(`/api/cases/${encodeURIComponent(item.id)}/materials${roundQuery(item.selectedRoundId)}`, {signal})});
  const filename = (id: string) => (!blocksView(registered) ? registered.data?.items.find(entry => entry.id === id)?.filename : undefined) ?? `文件 ${id.slice(0, 8)}`;
  const material = state.materials.find(entry => materialKey(entry) === selection && entry.operation === 'adopt');
  const documentId=material?.documentVersionId; const detail=material&&materialDetail(state,material);
  const enabled = !!material?.parseRevision && capabilities.data?.documentReader === true && can(item.allowed_actions, 'evidence:read');
  const base = `/api/cases/${encodeURIComponent(item.id)}/documents/${encodeURIComponent(documentId ?? '')}`;
  const suffix = `?parseRevision=${encodeURIComponent(material?.parseRevision ?? '')}`;
  const pages = useQuery({queryKey: ['review-loop-evidence-pages', item.id, documentId, material?.parseRevision], enabled: enabled && kind === 'page', queryFn: ({signal}) => api<{items: PageSummary[]}>(`${base}/pages${suffix}`, {signal})});
  const page = useQuery({queryKey: ['review-loop-evidence-page', item.id, documentId, material?.parseRevision, pageNumber], enabled: enabled && kind === 'page' && pages.data?.items.some(entry => entry.pageNumber === pageNumber), queryFn: ({signal}) => api<DocumentPageArtifact>(`${base}/pages/${pageNumber}${suffix}`, {signal})});
  const source = useQuery({queryKey: ['review-loop-evidence-source', item.id, documentId, material?.parseRevision], enabled: enabled && kind === 'source' && material?.sourceFormat === 'docx', queryFn: ({signal}) => api<SourceDocumentResponse>(`${base}/source${suffix}`, {signal})});
  const anchors = !blocksView(page) && page.data && page.data.scope.parseRevision === material?.parseRevision && page.data.scope.documentVersionId === documentId ? page.data.anchors.filter(anchor=>!material?.logicalDocumentId||!!detail&&reviewEvidenceInScope(detail,anchor)) : [];
  const nodes = !blocksView(source) && source.data && source.data.parseRevision === material?.parseRevision ? readableSourceNodes(source.data.source.nodes).filter(node => !node.excludedFromVisibleFacts && node.visibility === 'visible'&&(!material?.logicalDocumentId||detail?.sourceNodeIds?.includes(node.id))) : [];
  const reference = (locator: {anchorId: string} | {sourceNodeId: string}): ReviewEvidence => ({documentVersionId: material!.documentVersionId, parseRevision: material!.parseRevision!, directoryRevision: material!.directoryRevision, materialScope:materialScope(material!), ...locator});
  const choices = kind === 'page' ? anchors.map(anchor => ({value: anchor.anchor_id, preview: pageEvidencePreview(reference({anchorId: anchor.anchor_id}), page.data!)})) : nodes.map(node => ({value: node.id, preview: sourceEvidencePreview(reference({sourceNodeId: node.id}), source.data!)}));
  const add = (id: string) => {
    if (!material?.parseRevision) return;
    const entry = reference(kind === 'page' ? {anchorId: id} : {sourceNodeId: id});
    const preview = choices.find(choice => choice.value === id)?.preview;
    if (preview) setPreviews(current => ({...current, [evidenceIdentity(entry)]: preview}));
    if (!value.some(existing => evidenceIdentity(existing) === evidenceIdentity(entry))) onChange([...value, entry]);
  };
  return <fieldset className="review-loop-subpanel evidence-picker"><legend>原文依据</legend>
    <ul className={`review-loop-list${value.length?' evidence-picker-selected':''}`}>{value.map((entry, index) => <SelectedEvidence key={evidenceIdentity(entry)} caseId={item.id} roundId={item.selectedRoundId} source={entry} filename={filename(entry.documentVersionId)} preview={previews[evidenceIdentity(entry)]} readable={readable} remove={() => onChange(value.filter((_, position) => position !== index))}/>)}</ul>
    <ErrorNotice error={registered.error} retry={() => void registered.refetch()}/>
    <div className="review-loop-fields"><Form.Item label="本轮材料" className="evidence-material-field"><Select aria-label="本轮材料" value={selection} optionRender={option=><div className="evidence-picker-option">{option.data.label}</div>} onChange={value=>{const entry=state.materials.find(entry=>materialKey(entry)===value);setSelection(value);setPageNumber(entry?materialDetail(state,entry)?.pageNumbers[0]??1:1);setKind(entry?.sourceFormat==='docx'?'source':'page');}} options={state.materials.filter(entry=>entry.operation==='adopt').map(entry=>({value:materialKey(entry),label:materialLabel(state,entry,filename(entry.documentVersionId))}))}/>{material&&<span className="help-text">{materialRange(state,material)}</span>}</Form.Item>{!pageOnly && material?.sourceFormat === 'docx' && <Form.Item label="证据视图"><Select aria-label="证据视图" value={kind} options={[{value: 'page', label: '页面锚点'}, {value: 'source', label: '原生结构'}]} onChange={setKind}/></Form.Item>}{kind === 'page' && <Form.Item label="页码"><Select aria-label="页码" value={pageNumber} onChange={setPageNumber} options={(blocksView(pages) ? [] : pages.data?.items ?? []).filter(page=>!material?.logicalDocumentId||detail?.pageNumbers.includes(page.pageNumber)).map(page => ({value: page.pageNumber, label: `第 ${page.pageNumber} 页`}))}/></Form.Item>}</div>
    <ErrorNotice error={kind==='source'?source.error:pages.error || page.error}/>{enabled && <Select<string> className="evidence-picker-select" aria-label="选择原文依据" placeholder="搜索并添加原文依据" value={null} showSearch={{optionFilterProp: 'label'}} listHeight={320} popupMatchSelectWidth
      options={choices.map(choice => ({value: choice.value, label: `${choice.preview?.location ?? '原文位置'} ${choice.preview?.excerpt ?? ''}`, preview: choice.preview, disabled: value.some(entry => evidenceIdentity(entry) === evidenceIdentity(reference(kind === 'page' ? {anchorId: choice.value} : {sourceNodeId: choice.value})))}))}
      optionRender={option => <div className="evidence-picker-option"><span className="evidence-picker-option-location">{option.data.preview?.location ?? '原文位置'}{option.data.disabled ? ' · 已添加' : ''}</span>{option.data.preview?.excerpt || '此位置没有可显示的文字，请查看原文。'}</div>}
      onChange={add}/>} {documentId && !enabled && <p className="muted">该材料尚无可读取的固定解析依据。</p>}
  </fieldset>;
}

export function ReviewIssues({item}: {item: CaseSummary}) {
  const query = useCaseReview(item); const [selected, setSelected] = useState<{issue: ReviewIssue; action: 'reply' | 'decide'}>(); const [supplement, setSupplement] = useState<ReviewIssue>();
  if(query.capabilitiesPending)return <Loading/>;
  if(query.capabilitiesError)return <ErrorNotice error={query.capabilitiesError} retry={()=>void query.retryCapabilities()}/>;
  if (!query.enabled) return <Blank title="问题跟踪暂未开放"/>; if (query.isPending) return <Loading/>; const state = query.data;
  if (!state) return <ErrorNotice error={query.error} retry={() => void query.refetch()}/>;
  return <Section title="问题跟踪" info={<Snapshot state={state}/>}><SignatureInformationSummaryView caseId={item.id} items={state.signatureInformation??[]} roundId={state.roundId} issuesOnly/><RefreshNotice query={query} retry={() => void query.refetch()}/>{state.issues.length ? <ul className="review-loop-list">{state.issues.map(issue => <li key={issue.issueId}><div className="review-loop-item-heading"><h3>{state.configuration?.rules.find(rule => rule.id === issue.ruleId)?.label ?? issue.ruleId}</h3><span>{issueLabels[issue.status]}{issue.validity === 'stale' ? ' · 待复查' : ''}</span></div><p>{resultLabels[issue.outcome] ?? issue.outcome} · {reviewReason(issue.reasonCode)}</p><EvidenceLinks caseId={item.id} evidence={evidenceForResult(state.facts, issue.evidenceIds)}/><div className="review-loop-code mono">问题 {issue.issueId} · r{issue.caseRevision}</div><div className="review-loop-toolbar-actions"><Link to={`/cases/${item.id}/review?mode=business${item.selectedRoundId?`&round=${item.selectedRoundId}`:''}`}>查看事实与检查</Link>{can(state.allowedActions, 'finding:decide') && <><Button disabled={issue.validity === 'stale'} onClick={() => setSelected({issue, action: 'reply'})}>登记外部反馈</Button><Button disabled={issue.validity === 'stale'} onClick={() => setSelected({issue, action: 'decide'})}>记录处置</Button></>}{can(state.allowedActions, 'document:parse') && issue.outcome === 'blocked' && issue.validity === 'current' && <Button onClick={() => setSupplement(issue)}>补充提取一次</Button>}</div>{state.supplements.filter(value => value.issueId === issue.issueId).map(value => <SupplementStatus key={value.id} item={item} value={value}/>)}<div className="review-loop-issue-history">{state.history.filter(event => event.details.issueId === issue.issueId).map(event => <div key={event.id}><p>{historyLabels[event.kind] ?? event.kind} · {formatTime(event.createdAt)} · r{event.caseRevision}</p>{['text', 'reason', 'externalAuthor', 'externalRole', 'channel', 'receivedAt', 'disposition'].filter(key => event.details[key] !== undefined).map(key => <p key={key}>{({text: '回复', reason: '依据', externalAuthor: '外部来源人', externalRole: '外部角色', channel: '渠道', receivedAt: '收到时间', disposition: '处置'} as Record<string, string>)[key]}：{key === 'receivedAt' ? formatTime(String(event.details[key])) : key === 'disposition' ? ({resolved: '关闭', acknowledged: '记录待跟进', reopened: '重新打开'} as Record<string, string>)[String(event.details[key])] ?? readableValue(event.details[key]) : readableValue(event.details[key])}</p>)}<p className="muted">实际录入人：{event.actorPersonId}</p></div>)}</div></li>)}</ul> : <Blank title="暂无检查问题"/>}
    {supplement && can(state.allowedActions, 'document:parse') && <ReviewCommand item={item} state={state} path={`issues/${supplement.issueId}/supplement`} title="补充提取一次" close={() => setSupplement(undefined)} warning="仅对本项缺少的输入请求一次定向提取。完成后仍需核对候选；未找到或失败时转人工核对。" mapValues={values => ({expectedIssueVersion:supplement.version,documentVersionId:state.materials.find(material=>materialKey(material)===values.materialSelection)!.documentVersionId,materialScope:materialScope(state.materials.find(material=>materialKey(material)===values.materialSelection)!),fieldIds:values.fieldIds})}>
      <Form.Item name="materialSelection" label="本轮材料" rules={required}><Select optionRender={option=><div className="evidence-picker-option">{option.data.label}</div>} options={state.materials.filter(material => material.operation === 'adopt').map(material => ({value:materialKey(material),label:materialLabel(state,material)}))}/></Form.Item>
      <Form.Item name="fieldIds" label="本项缺少的输入" rules={[{required:true,type:'array',min:1,message:'请选择待补充的字段'}]}><Select mode="multiple" options={(state.configuration?.rules.find(rule => rule.id === supplement.ruleId)?.inputFieldIds ?? []).map(id => ({value:id,label:state.configuration?.fields.find(field => field.id === id)?.label ?? id}))}/></Form.Item>
    </ReviewCommand>}
    {selected && can(state.allowedActions, 'finding:decide') && <ReviewCommand item={item} state={state} path={`issues/${selected.issue.issueId}/${selected.action}`} title={selected.action === 'reply' ? '登记外部反馈' : '记录问题处置'} close={() => setSelected(undefined)} initialValues={{externalRole: 'RM',channel: '邮件',receivedAt: new Intl.DateTimeFormat('sv-SE', {timeZone: 'Asia/Singapore', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false}).format(new Date()).replace(' ', 'T'),disposition: 'acknowledged'}} mapValues={values => selected.action === 'reply' ? {expectedIssueVersion: selected.issue.version,text: values.text,externalAuthor: values.externalAuthor,externalRole: values.externalRole,channel: values.channel,receivedAt: new Date(`${values.receivedAt}+08:00`).toISOString()} : {expectedIssueVersion: selected.issue.version,disposition: values.disposition}}>
      <p>问题：{state.configuration?.rules.find(rule => rule.id === selected.issue.ruleId)?.label ?? selected.issue.ruleId} · r{selected.issue.caseRevision}</p>{selected.action === 'reply' ? <><div className="review-loop-fields"><Form.Item name="externalAuthor" label="外部来源人" rules={required}><Input maxLength={300}/></Form.Item><Form.Item name="externalRole" label="外部角色" rules={required}><Input maxLength={100}/></Form.Item><Form.Item name="channel" label="沟通渠道" rules={required}><Input maxLength={100}/></Form.Item><Form.Item name="receivedAt" label="收到时间（新加坡时间）" rules={required}><Input type="datetime-local"/></Form.Item></div><Form.Item name="text" label="反馈内容" rules={required}><Input.TextArea rows={5} maxLength={10000}/></Form.Item></> : <Form.Item name="disposition" label="处置" rules={required}><Select options={[{value: 'acknowledged', label: '记录待跟进'}, {value: 'resolved', label: '按本轮依据关闭'}, {value: 'reopened', label: '重新打开'}]}/></Form.Item>}
    </ReviewCommand>}
  </Section>;
}

export function ReviewRecords({item,afterMail}: {item: CaseSummary;afterMail?:React.ReactNode|((run:Pick<ReviewRun,'id'|'snapshotHash'>)=>React.ReactNode)}) {
  const query = useCaseReview(item);
  return <div className="review-loop-workspace">
    {query.capabilitiesPending ? <Loading/> : query.capabilitiesError ? <ErrorNotice error={query.capabilitiesError} retry={() => void query.retryCapabilities()}/> : !query.enabled ? <Blank title="检查记录暂未开放"/> : query.isPending ? <Loading/> : !query.data ? <ErrorNotice error={query.error} retry={() => void query.refetch()}/> : <Section title="预审结果" className="report-section" flush><RunResults afterMail={afterMail} presentation="report" state={query.data} canReadEvidence={can(item.allowed_actions, 'evidence:read')}/></Section>}
  </div>;
}

function ReviewCommand({item, state: live, path, title, close, onSuccess, children, initialValues, warning, mapValues, contentVersion, form, submitDisabled}: {item: CaseSummary; state: ReviewState; path: string; title: string; close: () => void; onSuccess?: () => void; children?: React.ReactNode; initialValues?: Record<string, unknown>; warning?: string; mapValues?: (values: Record<string, any>) => Record<string, unknown>; contentVersion?: string; submitDisabled?:boolean; form?: ReturnType<typeof Form.useForm>[0]}) {
  const [state,setState] = useState(live); const [pending, setPending] = useState(false); const [error, setError] = useState<unknown>(); const [key, setKey] = useState(newKey); const [dirty, setDirty] = useState(false); const {modal} = App.useApp();
  const originalContent = useRef(contentVersion);
  useEffect(() => {setKey(newKey()); if (contentVersion !== originalContent.current) setDirty(true);}, [contentVersion]);
  const [completed, setCompleted] = useState(false);
  useReviewUnsavedChanges(dirty && !completed);
  useEffect(() => {if (completed) {close(); onSuccess?.();}}, [completed]);
  return <ActionModal title={title} okText={title} pending={pending} disabled={submitDisabled} width={780} form={form} initialValues={initialValues} onValuesChange={() => {setKey(newKey()); setDirty(true);}} onCancel={() => {if (!dirty) close(); else modal.confirm({title: '放弃未保存的修改？', okText: '放弃修改', cancelText: '继续编辑', onOk: close});}} summary={<Snapshot state={state}/>} warning={warning} error={<><ErrorNotice error={error}/>{error instanceof ApiError&&['review_material_reconfirmation_required','review_material_scope_required','review_material_source_changed','review_material_target_stale'].includes(error.code)&&<a href={`/cases/${item.id}/materials${state.roundId?`?round=${state.roundId}`:''}`} target="_blank" rel="noopener noreferrer">前往材料页核对采用范围与新提取结果（保留当前输入）</a>}{error instanceof ApiError&&error.code==='stale_revision'&&<Button disabled={pending} onClick={async()=>{setPending(true);try{const fresh=await api<ReviewState>(`/api/cases/${item.id}/review${roundQuery(state.roundId??(state.legacyView?'legacy':null))}`);const action=path==='configuration'?'case:configure':path==='start'?'case:start':path==='materials'?'material:adopt':path.startsWith('issues/')?(path.endsWith('/supplement')?'document:parse':'finding:decide'):'field:correct';if(fresh.roundId!==state.roundId||!fresh.allowedActions.includes(action))throw new ApiError(409,'review_round_locked','本轮不可继续编辑');setState(fresh);setKey(newKey());setError(undefined);}catch(failure){setError(failure);}finally{setPending(false);}}}>保留输入，读取最新修订后重新核对</Button>}</>}
    onFinish={async values => {setPending(true); setError(undefined); try {await api<ReviewState>(`/api/cases/${encodeURIComponent(item.id)}/review/${path}`, {method: 'POST', body: {...(mapValues ? mapValues(values) : values),...(state.roundId?{roundId:state.roundId}:{}),expectedRevision: state.revision,idempotencyKey: key,reason: values.reason}}); await refreshReview(item.id); setCompleted(true);} catch (failure) {setError(failure);} finally {setPending(false);}}}>
    {children}<ReasonField label={path === 'start' ? '检查说明' : '操作依据'}/>
  </ActionModal>;
}

function RuleReference({state, id}: {state: ReviewState; id: string}) {const rule = state.configuration?.rules.find(rule => rule.id === id); return <><strong>{rule?.label ?? id}</strong>{rule?.description && <p>{rule.description}</p>}{rule?.sourceReferences.length ? <div className="review-loop-rule-source">来源：{rule.sourceReferences.join('；')}</div> : null}</>;}

function CandidatePicker({item, state, context, selected, onManual, onSelect}: {item: CaseSummary; state: ReviewState; context?: ChecklistRow; selected: boolean; onManual: () => void; onSelect: (choice: {fieldId: string; rawValue: string; evidence: ReviewEvidence[]; ref: NonNullable<ReviewFact['candidateRef']>}) => void}) {
  const capabilities = useCapabilities(); const [selection,setSelection]=useState<string|undefined>(()=>{
    for (const id of context?.candidates.map(c=>c.documentId)??[]) {
      const matches=state.materials.filter(m=>m.documentVersionId===id&&m.operation==='adopt'&&m.projectionHash);
      if(matches.length===1)return materialKey(matches[0]!);
    }
    return undefined;
  });
  const material=state.materials.find(value=>materialKey(value)===selection&&value.operation==='adopt');const documentId=material?.documentVersionId;
  const enabled = capabilities.data?.documentReader === true && can(item.allowed_actions, 'evidence:read') && !!material?.projectionHash && !!material.parseRevision;
  const fields = useQuery({queryKey: ['review-loop-confirm-candidates', item.id, documentId, material?.parseRevision, material?.projectionJobId], enabled, queryFn: ({signal}) => api<FieldsResponse>(`/api/cases/${encodeURIComponent(item.id)}/documents/${encodeURIComponent(documentId!)}/fields?parseRevision=${encodeURIComponent(material!.parseRevision!)}`, {signal})});
  const data = !blocksView(fields) ? fields.data : undefined;
  const current = data && data.parseRevision === material?.parseRevision && Number(data.directoryRevision) === material.directoryRevision && (data.filterJob?.id ?? material.parseRevision) === material.projectionJobId;
  const choices = current ? data.items.filter(field => state.configuration?.fields.some(definition => definition.id === field.fieldId))
    .flatMap(field => candidateFactChoices(field, data.anchors, material!, data.sourceAnchors)).filter(choice=>!material?.logicalDocumentId||choice.evidence.every(e=>{const detail=materialDetail(state,material);const anchor=e.anchorId?data.anchors.find(a=>a.anchor_id===e.anchorId):undefined;return !!detail&&reviewEvidenceInScope(detail,anchor,e.sourceNodeId);})).filter(choice => !context || (choice.fieldId === context.fieldId && context.candidates.some(c => c.documentId === documentId && sameFieldLocations(c.evidence, choice.evidence)))) : [];
  return <fieldset className="review-loop-subpanel review-loop-candidates"><legend>待人工核对的字段候选</legend><Select className="review-loop-candidate-select" aria-label="候选来源材料" allowClear placeholder="选择本轮材料查看候选，也可直接人工填写" value={selection} optionRender={option=><div className="evidence-picker-option">{option.data.label}</div>} onChange={setSelection} options={state.materials.filter(value => value.operation === 'adopt' && value.projectionHash).map(value => ({value:materialKey(value),label:materialLabel(state,value)}))}/><ErrorNotice error={fields.error}/>{fields.isFetching && <span role="status">正在查询候选</span>}{enabled && data && !current && <p>候选投影已更新。请重新核对本轮材料版本，或回查原文后人工填写。</p>}{current && <Select className="review-loop-candidate-select" aria-label="选择字段候选" placeholder={choices.length ? '选择候选后仍需确认对象与原文' : '没有可直接采用的候选，请核对原文后人工填写'} value={undefined} options={choices.map(choice => ({value: choice.key, label: `${state.configuration?.fields.find(field => field.id === choice.fieldId)?.label ?? choice.fieldId}：${fieldDisplayText(choice.rawValue)}`}))} onChange={key => {const choice = choices.find(value => value.key === key); if (choice) onSelect(choice);}}/>}{selected && <Button type="link" onClick={onManual}>改为人工填写</Button>}</fieldset>;
}

function SupplementStatus({item, value}: {item: CaseSummary; value: ReviewState['supplements'][number]}) {
  const job = useQuery({queryKey:['review-loop-supplement-job',item.id,value.jobId],enabled:!!value.jobId && can(item.allowed_actions,'evidence:read'),queryFn:({signal})=>api<{status:string;errorCode?:string|null}>(`/api/tool-jobs/${encodeURIComponent(value.jobId!)}`,{signal}),refetchInterval:query=>isReviewRunning(query.state.data?.status)?3000:false});
  const status = !blocksView(job) && job.data ? job.data.status : value.state;
  return <div className="review-loop-subpanel"><strong>补充提取：{({requested:'已提交',ready:'已完成，请核对候选',partial:'部分完成，请核对原文',pending:'待执行',running:'处理中',failed:'未完成，转人工核对',canceled:'已取消'} as Record<string,string>)[status] ?? '待查询'}</strong><div className="review-loop-toolbar-actions"><Link to={`/cases/${item.id}/review?document=${encodeURIComponent(value.documentVersionId)}&parse=${encodeURIComponent(value.parseRevision)}`}>查看材料与候选</Link><Link to={`/cases/${item.id}/review?mode=business${item.selectedRoundId?`&round=${item.selectedRoundId}`:''}`}>人工确认事实</Link></div><ErrorNotice error={job.error} retry={()=>void job.refetch()}/></div>;
}
