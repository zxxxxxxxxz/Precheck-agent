import {createMixedGuaranteeManifest} from '@hsbc/contracts/mixed-guarantee';
import React, {useEffect, useState} from 'react';
import {Alert, App, Button, Checkbox, Form, Input, Select, Table, Tabs, Tag} from 'antd';
import {useQuery} from '@tanstack/react-query';
import {Link, useNavigate, useParams} from 'react-router';
import {REVIEW_EXTRACTION_RECIPES, ReviewConfigManifestSchema, type ReviewConfigManifest, type ReviewConfigView, type ReviewRule} from '@hsbc/contracts/review-config';
import {canUpdateMortgageInsuranceFields} from '@hsbc/contracts/insurance-fields';
import {createMortgageWorkbookManifest} from '@hsbc/contracts/mortgage-requirements';
import {applyPersonalGuaranteeRequirements, createPersonalGuaranteeManifest, PERSONAL_FACT_OPTIONS} from '@hsbc/contracts/personal-requirements';
import {applyCorporateRmSourceReview, applyCorporateGuaranteeRequirements, applyCorporateArticlesReview, applyCorporateResolutionNameReview, createCorporateGuaranteeManifest, CORPORATE_FACT_OPTIONS} from '@hsbc/contracts/corporate-requirements';
import {api, newKey, queryClient} from '../api.ts';
import {can} from '../features/identity/permissions.ts';
import {useAuth} from '../auth.tsx';
import {useCapabilities} from '../capabilities.ts';
import {configStateLabels, objectKindLabels, splitEntries, validationLabels, valueInput} from '../features/review/presentation.ts';
import {ActionModal, Blank, blocksView, CopyValue, ErrorNotice, Forbidden, Loading, PageHeader, RefreshNotice, Section, useCrumbs} from '../ui.tsx';
import {useReviewUnsavedChanges} from '../features/review/use-unsaved-changes.ts';
import {configurationActions, type ConfigAction as ConfigActionKind} from '../features/review/configuration-actions.ts';
import {configurationRecordInitialValues, type ConfigCollection as Collection} from '../features/review/configuration-record.ts';
import {ConfigSignatures} from '../features/review/configuration-signatures.tsx';
import {ConfigurationAppearance} from '../features/review/configuration-appearance.tsx';
import {ConfigSemanticGuidance} from '../features/review/configuration-guidance.tsx';
import {GuidanceDigests} from '../features/review/guidance-digests.tsx';
import './review-loop.css';
import './rules.css';

const collections: Collection[] = ['sources', 'taxonomy', 'materials', 'fields', 'rules'];
const collectionNames: Record<Collection, string> = {sources: '来源与处置', taxonomy: '材料分类', materials: '材料要求', fields: '字段字典', rules: '规则定义'};
const stageNames: Record<ConfigActionKind, string> = {validate: '校验', trial: '试跑', approve: '批准', publish: '发布'};
const scopeLabel = (scope: ReviewConfigManifest['scope']) => scope === 'synthetic' ? '合成验证' : '银行规则';
const pagination = {pageSize: 20, hideOnSinglePage: true, showSizeChanger: false};
const operatorNames: Record<string, string> = {present: '必须有值', equal: '相等', minimum: '不低于', range_covers: '范围覆盖', set_covers: '集合覆盖', date_order: '日期先后', blank: '应留空', same_entity: '同一主体（需身份确认）', currency_is: '指定币种', minimum_in_currency: '指定币种金额不低于', manual_review: '人工核对', minimum_ratio: '同币种金额比例', ltv_maximum: '抵押率不超过上限', date_after: '到期日检查（当天提醒）', calendar_year_minimum: '至少一个日历年', anniversary_notice: '出具日加一年'};
const guaranteeOptions = [{value: 'mortgage', label: '抵押'}, {value: 'account_charge', label: '账户押记'}, {value: 'personal_guarantee', label: '个人保证'}, {value: 'corporate_guarantee', label: '公司保证'}, {value: 'sblc', label: '备用信用证'}];
const outcomes = [{value: 'pass', label: '未发现差异'}, {value: 'fail', label: '明确差异'}, {value: 'blocked', label: '证据不足'}, {value: 'not_applicable', label: '不适用'}];
const required = [{required: true, whitespace: true, message: '请填写此项'}];
const options = (entries: readonly {id: string; label?: string; reference?: string}[]) => entries.map(entry => ({value: entry.id, label: entry.label || entry.reference || entry.id}));

export function RulesPage() {
  return <ConfigurationAppearance><RulesContent/></ConfigurationAppearance>;
}

function RulesContent() {
  const {session} = useAuth();
  const {configId} = useParams();
  const navigate = useNavigate();
  const [createOpen, setCreateOpen] = useState(false);
  const capabilities = useCapabilities();
  const access = can(session.allowed_actions, 'rule:read');
  const query = useQuery({queryKey: ['review-configs', session.user?.accountId], queryFn: ({signal}) => api<{items: ReviewConfigView[]; allowed_actions: string[]}>('/api/review-configs', {signal}), enabled: access && capabilities.data?.reviewConfiguration === true});
  useCrumbs(configId ? [{title: '规则中心', to: '/rules'}, {title: '配置详情'}] : [{title: '规则中心'}], '规则中心');
  if (!access) return <Forbidden/>;
  if (capabilities.isPending) return <Loading/>;
  if (!capabilities.data?.reviewConfiguration) return <Blank title="配置维护暂未开放"/>;
  if (configId) return <ConfigPage key={configId} id={configId} canCreate={!blocksView(query) && can(query.data?.allowed_actions, 'rule:propose')}/>;
  const data = blocksView(query) ? undefined : query.data;
  const open = (item: ReviewConfigView) => navigate(`/rules/${encodeURIComponent(item.id)}`);
  return <div className="review-loop-workspace rules-page">
    <PageHeader title="规则中心" meta={data && <span>共 {data.items.length} 个配置</span>} actions={can(data?.allowed_actions, 'rule:propose') && <Button type="primary" onClick={() => setCreateOpen(true)}>新建配置</Button>}/>
    <GuidanceDigests/>
    <Section title="配置列表" flush className="rules-list">
      <div className="section-notice"><ErrorNotice error={query.error} retry={() => void query.refetch()}/></div>
      {query.isPending ? <Loading/> : data?.items.length ? <Table<ReviewConfigView> rowKey="id" pagination={pagination} scroll={{x: 760}} dataSource={data.items} onRow={item => ({onClick: event => {if (!(event.target as HTMLElement).closest('a, button')) open(item);}, className: 'clickable-row'})} columns={[
        {title: '配置', key: 'label', render: (_, item) => <Link className="table-main" to={`/rules/${encodeURIComponent(item.id)}`}>{item.manifest.label}</Link>},
        {title: '使用范围', key: 'scope', width: 110, render: (_, item) => scopeLabel(item.manifest.scope)},
        {title: '版本', dataIndex: 'revision', width: 70, render: value => <span className="mono">r{value}</span>},
        {title: '状态', key: 'status', width: 100, render: (_, item) => <span className="rules-status" data-status={item.status}>{configStateLabels[item.status]}</span>},
        {title: '发布标识', key: 'release', width: 240, render: (_, item) => item.releaseId ? <span className="mono">{item.releaseId}</span> : <span className="muted">尚未发布</span>},
      ]}/> : !blocksView(query) && <Blank title="暂无可访问配置"/>}
    </Section>
    <p className="rules-hint">合成验证：用测试材料验证提取和审核。银行规则：用于获批范围的正式业务。规则可以来自银行需求表；来源、使用范围和发布状态分别记录。</p>
    {createOpen && <CreateConfig close={() => setCreateOpen(false)} done={item => {void query.refetch(); navigate(`/rules/${encodeURIComponent(item.id)}`);}}/>}
  </div>;
}

function CreateConfig({base, close, done}: {base?: ReviewConfigManifest; close: () => void; done: (value: ReviewConfigView) => void}) {
  const [pending, setPending] = useState(false); const [error, setError] = useState<unknown>(); const [key, setKey] = useState(newKey);
  const [businessType, setBusinessType] = useState('mortgage');
  return <ActionModal title={base ? '按银行清单新建草稿' : '新建配置草稿'} okText="创建草稿" pending={pending} onCancel={close} initialValues={{businessType:'mortgage', label: base ? `${base.label.slice(0,180)}${base.label.includes('银行清单') ? '（新版本）' : ' · 银行清单'}` : '', releaseId: `review_${Date.now()}`}} onValuesChange={() => setKey(newKey())} error={<ErrorNotice error={error}/>}
    onFinish={async (values: {label: string; releaseId: string; businessType:string}) => {setPending(true); setError(undefined); try {const manifest = values.businessType==='mixed_guarantee'?createMixedGuaranteeManifest(values.releaseId,{corporateSectionVersion:'source-fields-v2',corporateExtractionVersion:'source-fields-v2',corporateGuaranteeVersion:'bank-amount-v1',corporateArticlesVersion:'articles-fields-v1',corporateRmVersion:'rm-source-v2'}):values.businessType==='personal_guarantee'?createPersonalGuaranteeManifest(values.releaseId):values.businessType==='corporate_guarantee'?createCorporateGuaranteeManifest(values.releaseId,{corporateSectionVersion:'source-fields-v2',corporateExtractionVersion:'source-fields-v2',corporateGuaranteeVersion:'bank-amount-v1',corporateArticlesVersion:'articles-fields-v1',corporateRmVersion:'rm-source-v2'}):createMortgageWorkbookManifest(values.releaseId); manifest.label = values.label; const result = await api<ReviewConfigView>('/api/review-configs', {method: 'POST', body: {manifest, idempotencyKey: key}}); done(result);} catch (failure) {setError(failure);} finally {setPending(false);}}}>
    <Form.Item name="businessType" label="业务类型" rules={required}><Select disabled={!!base} onChange={setBusinessType} options={[{value:'mortgage',label:'抵押融资'},{value:'corporate_guarantee',label:'公司担保'},{value:'personal_guarantee',label:'个人担保'},{value:'mixed_guarantee',label:'公司＋个人担保'}]}/></Form.Item>
    <Form.Item name="label" label="配置名称" rules={required}><Input maxLength={200} autoFocus/></Form.Item>
    <Form.Item name="releaseId" label="发布标识" rules={[...required, {pattern: /^[a-z][a-z0-9_]{0,63}$/, message: '使用小写英文字母、数字、下划线，以字母开头'}]}><Input maxLength={64}/></Form.Item>
    <p>{businessType==='mixed_guarantee'?'组合公司与个人担保要求，授信函可以共用；每家公司和每位个人的材料、事实和规则分别核对。':businessType==='personal_guarantee'?'按个人担保银行清单建立 33 行字段要求、37 行业务规则及法律意见清单。保证书、本票和授权补全本票文件逐人核对；留空栏目须有原文依据。':businessType==='corporate_guarantee'?'按公司担保银行清单建立 60 行字段要求、54 行业务规则及法律意见 Checklist。涵盖保证书、公司决议、环球客户经理证明、法律意见和注册资料。':'按银行 Excel 建立抵押协议、授信函、公司授权文件、保险、评估报告五类材料的 74 行字段要求及审核规则。'}</p>
    <p>日期、身份、金额比例和抵押率按已确认事实检查；签署权限、条款及例外保留人工核对。批准名单尚未提供的项目显示待配置。</p>
    <p>此操作建立独立草稿；原配置及在审任务保留原版本。校验、试跑和批准发布后，绑定新版本并重新提取材料，才会产生新结果。</p>
  </ActionModal>;
}

function ResolutionNameConfig({base,close,done,articles=false,rm=false}:{rm?:boolean;articles?:boolean;base:ReviewConfigManifest;close:()=>void;done:(value:ReviewConfigView)=>void}) {
  const [pending,setPending]=useState(false),[error,setError]=useState<unknown>(),[key,setKey]=useState(newKey);
  return <ActionModal title={rm?'新建客户经理证明字段修订':articles?'新建章程字段修订':'新建决议名称识别修订'} okText="创建草稿" pending={pending} onCancel={close}
    initialValues={{label:`${base.label.slice(0,175)} · ${rm?'客户经理证明字段核对':articles?'章程字段核对':'决议名称核对'}`,releaseId:`cgt_${rm?'rm_source':articles?'articles':'names'}_${Date.now()}`}} onValuesChange={()=>setKey(newKey())} error={<ErrorNotice error={error}/>}
    onFinish={async(values:{label:string;releaseId:string})=>{setPending(true);setError(undefined);try{const manifest={...(rm?applyCorporateRmSourceReview(base):articles?applyCorporateArticlesReview(base):applyCorporateResolutionNameReview(base)),...values};const result=await api<ReviewConfigView>('/api/review-configs',{method:'POST',body:{manifest,idempotencyKey:key}});done(result);}catch(failure){setError(failure);}finally{setPending(false);}}}>
    <p>{rm?`以「${base.label}」为基础，按原文提取担保公司、被担保公司、汇丰银行名称及客户经理姓名；a/b 只保留明确标记为已选的选项并去重。`:articles?`以「${base.label}」为基础，将章程要求分为董事会议最少出席人数、提供担保所需决议、提供担保的限制或许可。各项保留原文条件、例外及位置。`:`以「${base.label}」为基础，调整决议中的担保人、银行、客户和授权签字人四个名称字段。原文没有明确标签时，保留有原文位置的候选，并提示人工核对身份及授权。`}</p>
    <p>{articles?'保留本版本的其他字段、材料和签署要求，增加章程所需决议的人工核对项。':'沿用本版本的业务规则、材料要求及签署要求。'}新草稿仍需校验、试跑及独立批准；发布并绑定到案件后，重新提取才会生效。</p>
    <Form.Item name="label" label="配置名称" rules={required}><Input maxLength={200} autoFocus/></Form.Item>
    <Form.Item name="releaseId" label="发布标识" rules={[...required,{pattern:/^[a-z][a-z0-9_]{0,63}$/,message:'使用小写英文字母、数字、下划线，以字母开头'}]}><Input maxLength={64}/></Form.Item>
  </ActionModal>;
}

function ConfigPage({id, canCreate}: {id: string; canCreate: boolean}) {
  const {session} = useAuth(); const {modal} = App.useApp();
  const navigate = useNavigate();
  const query = useQuery({queryKey: ['review-config', session.user?.accountId, id], queryFn: ({signal}) => api<ReviewConfigView>(`/api/review-configs/${encodeURIComponent(id)}`, {signal})});
  const current = blocksView(query) ? undefined : query.data;
  const [editing, setEditing] = useState<{manifest: ReviewConfigManifest; revision: number}>();
  const [record, setRecord] = useState<{kind: Collection; index?: number}>();
  const [action, setAction] = useState<ConfigActionKind>();
  const [insuranceBase, setInsuranceBase] = useState<ReviewConfigManifest>();
  const [nameReviewBase,setNameReviewBase]=useState<ReviewConfigManifest>();
  const [articlesReviewBase,setArticlesReviewBase]=useState<ReviewConfigManifest>();
  const [rmReviewBase,setRmReviewBase]=useState<ReviewConfigManifest>();
  const [tab, setTab] = useState('general');
  const [pending, setPending] = useState(false); const [error, setError] = useState<unknown>(); const [saveKey, setSaveKey] = useState(newKey);
  const manifest = editing?.manifest ?? current?.manifest;
  const editable = can(current?.allowed_actions, 'rule:propose') && current?.status !== 'published';
  useReviewUnsavedChanges(!!editing || (!!record && editable));
  useEffect(() => {if (blocksView(query)) {setEditing(undefined); setRecord(undefined); setAction(undefined); setInsuranceBase(undefined);setNameReviewBase(undefined);setArticlesReviewBase(undefined);setRmReviewBase(undefined);}}, [query.error]);
  const change = (next: ReviewConfigManifest) => {if (!current) return; setEditing(previous => ({manifest: next, revision: previous?.revision ?? current.revision})); setSaveKey(newKey()); setError(undefined);};
  if (query.isPending) return <Loading/>;
  if (!current || !manifest) return <ErrorNotice error={query.error} retry={() => void query.refetch()}/>;
  const releaseActions = configurationActions(current, session.allowed_actions, !!editing, pending);
  const corporate = manifest.guaranteeTypes.length===1 && manifest.guaranteeTypes[0]==='corporate_guarantee';
  const personal = manifest.guaranteeTypes.length===1 && manifest.guaranteeTypes[0]==='personal_guarantee';
  const personalReady = manifest.sources.some(source=>source.id==='pg_execution');
  const applyPersonal = () => modal.confirm({title:'将个人担保要求载入当前草稿？',content:`将替换当前草稿的 ${manifest.fields.length} 个字段及 ${manifest.rules.length} 条规则，载入银行个人担保要求。配置名称、标识及已保存历史保留；载入后可查看并保存。`,okText:'载入当前草稿',cancelText:'取消',onOk:()=>{change(applyPersonalGuaranteeRequirements(manifest));setTab('materials');}});
  const corporateReady = manifest.sources.some(source=>source.id==='cgt_confirmed_execution');
  const applyCorporate = () => modal.confirm({title:'将公司担保要求载入当前草稿？',content:`将替换当前草稿的 ${manifest.fields.length} 个字段及 ${manifest.rules.length} 条规则，载入银行公司担保要求。配置名称、标识及已保存历史保留；载入后可查看并保存。`,okText:'载入当前草稿',cancelText:'取消',onOk:()=>{change(applyCorporateGuaranteeRequirements(manifest));setTab('materials');}});
  const discard = () => modal.confirm({title: '放弃未保存的配置修改？', okText: '放弃修改', cancelText: '继续编辑', onOk: () => {setEditing(undefined); setError(undefined);}});
  const save = async () => {if (!editing) return; setPending(true); setError(undefined); try {const parsed = ReviewConfigManifestSchema.safeParse(editing.manifest); if (!parsed.success) {setError(new Error('invalid')); modal.error({title: '配置尚未完整', content: parsed.error.issues.map(issue => issue.path.join('.')).slice(0, 10).join('、')}); return;} const result = await api<ReviewConfigView>(`/api/review-configs/${encodeURIComponent(id)}`, {method: 'PUT', body: {manifest: parsed.data, expectedRevision: editing.revision, idempotencyKey: saveKey}}); queryClient.setQueryData(['review-config', session.user?.accountId, id], result); setEditing(undefined); void queryClient.invalidateQueries({queryKey: ['review-configs']});} catch (failure) {setError(failure);} finally {setPending(false);}};
  const list = (kind: Collection) => <Table className="review-loop-rule-table" rowKey="id" scroll={{x: 700}} pagination={pagination} locale={{emptyText: <Blank title={`暂无${collectionNames[kind]}`}/>}} dataSource={manifest[kind] as Array<{id: string; label?: string; reference?: string; sourceIds?: string[]}>} columns={[
      {title: '名称与标识', key: 'name', width: 260, render: (_, row) => <><strong>{row.label ?? row.reference}</strong><div className="review-loop-code mono">{row.id}</div></>},
      {title: '定义与依据', key: 'detail', render: (_, row) => <RecordSummary kind={kind} row={row as unknown as Record<string, unknown>} manifest={manifest}/>},
      {title: '操作', key: 'actions', width: 140, render: (_, row) => <div className="row-actions"><Button type="link" onClick={() => setRecord({kind, index: manifest[kind].findIndex(item => item.id === row.id)})}>{editable ? '编辑' : '查看'}</Button>{editable && <Button type="link" danger onClick={() => modal.confirm({title: `从此草稿移除“${row.label ?? row.id}”？`, content: '历史发布不受影响；存在引用时将阻止本次发布。', okText: '移除', cancelText: '取消', onOk: () => change({...manifest, [kind]: manifest[kind].filter(item => item.id !== row.id)})})}>移除</Button>}</div>},
  ]}/>;
  const addable = editable && collections.includes(tab as Collection) ? tab as Collection : undefined;
  return <div className="review-loop-workspace rules-page">
    <PageHeader title={manifest.label} status={<><Tag className="tag-neutral">{configStateLabels[current.status]}</Tag>{editing && <Tag className="tag-warning">未保存修改</Tag>}</>} meta={<span className="mono">r{current.revision}</span>} actions={<>
      {editable && personal && manifest.scope==='synthetic' && <Button disabled={!!editing||pending} onClick={applyPersonal}>{personalReady?'重新载入个人担保要求':'载入个人担保要求'}</Button>}
      {editable && corporate && manifest.scope==='synthetic' && <Button disabled={!!editing||pending} onClick={applyCorporate}>{corporateReady?'重新载入公司担保要求':'载入公司担保要求'}</Button>}
      {canCreate && canUpdateMortgageInsuranceFields(current.manifest) && <Button disabled={!!editing || pending} onClick={() => setInsuranceBase(structuredClone(current.manifest))}>按银行清单新建</Button>}
      {canCreate && corporate && manifest.scope==='synthetic' && <Button disabled={!!editing||pending} onClick={()=>setNameReviewBase(structuredClone(current.manifest))}>新建决议名称识别修订</Button>}
      {canCreate && manifest.guaranteeTypes.includes('corporate_guarantee') && manifest.scope==='synthetic' && <Button disabled={!!editing||pending} onClick={()=>setArticlesReviewBase(structuredClone(current.manifest))}>新建章程字段修订</Button>}
      {canCreate && manifest.guaranteeTypes.includes('corporate_guarantee') && manifest.scope==='synthetic' && <Button disabled={!!editing||pending} onClick={()=>setRmReviewBase(structuredClone(current.manifest))}>新建客户经理证明字段修订</Button>}
      {editable && <>{editing && <Button onClick={discard}>放弃修改</Button>}<Button type="primary" disabled={!editing} loading={pending} onClick={() => void save()}>保存草稿</Button></>}
    </>}/>
    <ErrorNotice error={error} retry={() => void query.refetch()}/><RefreshNotice query={query} retry={() => void query.refetch()}/>
    {personal && <Alert className="notice" type={personalReady?'info':'warning'} showIcon title={personalReady?'个人担保审核要求已载入':'当前草稿尚未载入个人担保要求'} description={personalReady?'在案件中为每位担保人确认材料与原文位置；共用授信文件可明确关联给多人。金额、日期、号码及留空检查采用已确认事实；身份归属、签署及法律事项仍须人工核对。':'仅选择担保类型不会替换字段和规则。请载入个人担保要求，核对后保存当前草稿。'}/>}
    {corporate && <Alert className="notice" type={corporateReady?'info':'warning'} showIcon title={corporateReady?'公司担保审核要求已载入':'当前草稿尚未载入公司担保要求'} description={corporateReady?'按银行字段提取并在案件审核中逐项检查。材料须关联到对应公司担保；日期、金额、完整性及已确认签署人数自动检查，授权组合、章程和法律意见保留人工核对。':'仅选择担保类型不会替换字段和规则。请载入公司担保要求，核对后保存当前草稿。'}/>}
    {editing && editing.revision !== current.revision && <Alert className="notice" type="warning" showIcon title="配置已有新修订。未保存修改仍保留，请核对后放弃旧草稿并重新编辑。"/>}
    <Section title="配置内容" flush className="rules-config">
      <Tabs activeKey={tab} onChange={setTab} classNames={{header: 'rules-tabs-header', body: 'rules-tabs-body'}} tabBarExtraContent={addable && <Button onClick={() => setRecord({kind: addable})}>新增{collectionNames[addable]}</Button>} items={[
        {key: 'general', label: '适用与参数', children: <ConfigGeneral manifest={manifest} disabled={!editable || pending} change={change}/>},
        ...collections.map(kind => ({key: kind, label: <>{collectionNames[kind]}<span className="rules-tab-count">{manifest[kind].length}</span></>, children: list(kind)})),
        {key: 'signatures', label: <>签署要求<span className="rules-tab-count">{manifest.signatureRequirements?.length ?? 0}</span></>, children: <ConfigSignatures manifest={manifest} disabled={!editable || pending} change={change}/>},
        {key: 'guidance', label: <>语义口径<span className="rules-tab-count">{manifest.semanticGuidance?.length ?? 0}</span></>, children: <ConfigSemanticGuidance manifest={manifest} disabled={!editable || pending} change={change}/>},
        {key: 'release', label: '试跑与发布', children: <ConfigRelease current={current} manifest={manifest} actions={releaseActions} start={setAction}/>},
      ]}/>
    </Section>
    {record && <ConfigRecord key={`${record.kind}:${record.index ?? 'new'}`} kind={record.kind} index={record.index} manifest={manifest} readOnly={!editable} close={() => setRecord(undefined)} save={row => {const rows = [...manifest[record.kind]]; if (record.index === undefined) rows.push(row as never); else rows[record.index] = row as never; change({...manifest, [record.kind]: rows}); setRecord(undefined);}}/>}
    {action && releaseActions.some(item => item.action === action && !item.disabled) && <ConfigAction value={current} action={action} close={() => setAction(undefined)} done={result => {queryClient.setQueryData(['review-config', session.user?.accountId, id], result); void queryClient.invalidateQueries({queryKey: ['review-configs']}); setAction(undefined);}}/>}
    {insuranceBase && canCreate && <CreateConfig base={insuranceBase} close={() => setInsuranceBase(undefined)} done={item => {void queryClient.invalidateQueries({queryKey: ['review-configs']}); navigate(`/rules/${encodeURIComponent(item.id)}`);}}/>}
    {nameReviewBase && canCreate && <ResolutionNameConfig base={nameReviewBase} close={()=>setNameReviewBase(undefined)} done={item=>{setNameReviewBase(undefined);void queryClient.invalidateQueries({queryKey:['review-configs']});navigate(`/rules/${encodeURIComponent(item.id)}`);}}/>}
    {articlesReviewBase && canCreate && <ResolutionNameConfig articles base={articlesReviewBase} close={()=>setArticlesReviewBase(undefined)} done={item=>{setArticlesReviewBase(undefined);void queryClient.invalidateQueries({queryKey:['review-configs']});navigate(`/rules/${encodeURIComponent(item.id)}`);}}/>}
    {rmReviewBase && canCreate && <ResolutionNameConfig rm base={rmReviewBase} close={()=>setRmReviewBase(undefined)} done={item=>{setRmReviewBase(undefined);void queryClient.invalidateQueries({queryKey:['review-configs']});navigate(`/rules/${encodeURIComponent(item.id)}`);}}/>}
  </div>;
}

function ConfigGeneral({manifest, disabled, change}: {manifest: ReviewConfigManifest; disabled: boolean; change: (value: ReviewConfigManifest) => void}) {
  const parameters = Object.entries(manifest.parameters);
  const setParameters = (entries: typeof parameters) => change({...manifest, parameters: Object.fromEntries(entries)});
  return <Form layout="vertical" disabled={disabled} className="rules-general"><div className="review-loop-fields">
    <Form.Item label="配置名称"><Input value={manifest.label} onChange={event => change({...manifest, label: event.target.value})} maxLength={200}/></Form.Item>
    <Form.Item label="发布标识"><Input value={manifest.releaseId} onChange={event => change({...manifest, releaseId: event.target.value})} maxLength={64}/></Form.Item>
    <Form.Item label="使用范围" extra="合成验证用于测试材料；银行规则用于有批准依据的正式业务。切换此项不会自动取得批准。"><Select value={manifest.scope} options={[{value: 'synthetic', label: '合成验证'}, {value: 'bank', label: '银行规则'}]} onChange={scope => change({...manifest, scope})}/></Form.Item>
    <Form.Item label="担保类型"><Select mode="multiple" value={manifest.guaranteeTypes} options={guaranteeOptions} onChange={guaranteeTypes => change({...manifest, guaranteeTypes})}/></Form.Item>
    <Form.Item className="review-loop-full" label="业务批准依据"><Input value={manifest.bankApprovalRef ?? ''} onChange={event => change({...manifest, bankApprovalRef: event.target.value || null})} maxLength={300}/></Form.Item>
  </div>
  <section className="rules-parameters" aria-labelledby="rules-parameters-title">
    <h3 id="rules-parameters-title">参考参数</h3>
    <p className="rules-hint">规则通过“必需参考参数”引用这些值。</p>
    {parameters.length ? <div className="rules-parameter-list">
      <div className="rules-parameter-row rules-parameter-head" aria-hidden="true"><span>参数标识</span><span>值</span></div>
      {parameters.map(([name, value], index) => <div className="rules-parameter-row" key={index}>
        <Input aria-label={`参数 ${index + 1} 标识`} value={name} onChange={event => setParameters(parameters.map((entry, position) => position === index ? [event.target.value, entry[1]] : entry))}/>
        <ScalarValue label={`参数 ${index + 1} `} value={value} disabled={disabled} onChange={value => change({...manifest, parameters: {...manifest.parameters, [name]: value}})}/>
        <Button type="link" className="link-button" disabled={disabled} aria-label={`移除参数 ${name || index + 1}`} onClick={() => setParameters(parameters.filter((_, position) => position !== index))}>移除</Button>
      </div>)}
    </div> : <p className="muted">暂无参考参数。</p>}
    <Button disabled={disabled} onClick={() => change({...manifest, parameters: {...manifest.parameters, [`parameter_${parameters.length + 1}`]: null}})}>新增参数</Button>
  </section></Form>;
}

/** Validate → trial → approve → publish is a real sequence: each stage shows its recorded state, its action and why that action is unavailable. */
function ConfigRelease({current, manifest, actions, start}: {current: ReviewConfigView; manifest: ReviewConfigManifest; actions: ReturnType<typeof configurationActions>; start: (action: ConfigActionKind) => void}) {
  const issues = current.validation.issues;
  const done: Record<ConfigActionKind, boolean> = {validate: current.validation.valid, trial: !!current.trial?.passed, approve: !!current.approval, publish: current.status === 'published'};
  const state: Record<ConfigActionKind, string> = {
    validate: current.validation.valid ? '配置校验通过' : issues.length ? `${issues.length} 项校验问题待修正` : '等待配置校验',
    trial: current.trial ? current.trial.passed ? '全部试例通过' : '试例未全部通过' : '尚未运行试例',
    approve: current.approval ? '已批准' : '尚未批准',
    publish: done.publish ? '已发布' : '尚未发布',
  };
  const next = actions.find(item => !done[item.action])?.action;
  return <div className="rules-release">
    <ol className="rules-steps" aria-label="发布步骤">{actions.map((item, index) => <li key={item.action} className={`rules-step${done[item.action] ? ' is-done' : item.action === next ? ' is-current' : ''}`} aria-current={item.action === next ? 'step' : undefined}>
      <span className="rules-step-index" aria-hidden="true">{done[item.action] ? <svg viewBox="0 0 16 16" width="12" height="12"><path d="M3 8.5l3.2 3.2L13 4.8" fill="none" stroke="currentColor" strokeWidth="2"/></svg> : index + 1}</span>
      <div className="rules-step-body">
        <h3>{stageNames[item.action]}</h3>
        <p className="rules-step-state">{state[item.action]}</p>
        <Button type={item.action === next ? 'primary' : 'default'} disabled={item.disabled} aria-describedby={item.reason ? `config-${item.action}-reason` : undefined} onClick={() => start(item.action)}>{item.label}</Button>
        {item.reason && <p id={`config-${item.action}-reason`} className="review-loop-action-reason">{item.reason}</p>}
      </div>
    </li>)}</ol>
    {issues.length > 0 && <section className="rules-release-block" aria-labelledby="rules-issues-title">
      <h3 id="rules-issues-title">校验问题</h3>
      <ul className="rules-issues">{issues.map((issue, index) => <li key={index}><span>{validationLabels[issue.code] ?? issue.code}</span><span className="mono">{issue.path}</span></li>)}</ul>
    </section>}
    {current.trial && <section className="rules-release-block" aria-labelledby="rules-trial-title">
      <h3 id="rules-trial-title">试例结果</h3>
      <Table rowKey={row => `${row.ruleId}:${row.testId}`} size="small" pagination={false} scroll={{x: 600}} dataSource={current.trial.results} columns={[{title: '规则', dataIndex: 'ruleId', render: value => manifest.rules.find(rule => rule.id === value)?.label ?? manifest.signatureRequirements?.find(rule => `signature:${rule.id}` === value)?.label ?? value}, {title: '试例', dataIndex: 'testId', width: 160, render: value => <span className="mono">{value}</span>}, {title: '预期', dataIndex: 'expected', width: 140, render: value => outcomes.find(item => item.value === value)?.label}, {title: '实际', dataIndex: 'actual', width: 140, render: value => outcomes.find(item => item.value === value)?.label}, {title: '结果', dataIndex: 'passed', width: 140, render: value => value ? '符合预期' : <span className="status-text tone-warning">不符合预期</span>}]}/>
      <p className="rules-receipt">试跑回执 <span className="mono">{current.trial.receiptHash}</span></p>
    </section>}
    <section className="rules-release-block" aria-labelledby="rules-version-title">
      <h3 id="rules-version-title">版本信息</h3>
      <dl className="rules-facts">
        <div><dt>配置发布标识</dt><dd className="mono">{manifest.releaseId}</dd></div>
        <div><dt>适用范围</dt><dd>{scopeLabel(manifest.scope)}</dd></div>
        <div><dt>审批人</dt><dd>{current.approval ? <span className="mono">{current.approval.personId}</span> : <span className="muted">尚未批准</span>}</dd></div>
        <div className="rules-facts-wide"><dt>内容指纹</dt><dd><CopyValue value={current.manifestHash} label="内容指纹"/></dd></div>
      </dl>
    </section>
  </div>;
}

function RecordSummary({kind, row, manifest}: {kind: Collection; row: Record<string, unknown>; manifest: ReviewConfigManifest}) {
  if (kind === 'sources') return <><span>{{confirmed: '已确认', candidate: '待确认', excluded: '不纳入', manual: '人工判断'}[String(row.disposition)]}</span><p className="review-loop-rule-source">{String(row.reason)}</p></>;
  const condition=row.applicability as ReviewRule['applicability'];
  const conditionText=condition?`${inputLabel(manifest,condition.fieldId)}：${(PERSONAL_FACT_OPTIONS[condition.fieldId]??CORPORATE_FACT_OPTIONS[condition.fieldId])?.find(option=>option.value===condition.equals)?.label??(condition.equals===true?'已提供':String(condition.equals))}`:null;
  const source = (row.sourceIds as string[]).map(id => manifest.sources.find(item => item.id === id)?.reference ?? id).join('；');
  return <>{kind === 'fields' ? String(row.semanticDefinition) : kind === 'rules' ? `${operatorNames[String(row.operator)]}${row.currency ? `（${row.currency}）` : ''}：${(row.inputs as string[]).map(id => inputLabel(manifest, id)).join(' → ')}` : kind === 'taxonomy' ? (row.keywords as string[]).join('、') : `${row.required ? condition?'符合条件时必需':'必需' : '按需提供'} · ${manifest.taxonomy.find(item => item.id === row.taxonomyId)?.label ?? row.taxonomyId}`}{conditionText&&<p>适用条件：{conditionText}</p>}{row.objectScope&&<p>按每个对应业务对象分别检查</p>}{kind === 'rules' && row.manualReason === 'reference_list_required' && <p><strong>待配置最新批准名单</strong>：表内占位名称不参与判断。</p>}{kind === 'rules' && !!row.description && <p>{String(row.description)}</p>}<div className="review-loop-rule-source">依据：{source}</div></>;
}

function ConfigRecord({kind, index, manifest, readOnly, close, save}: {kind: Collection; index?: number; manifest: ReviewConfigManifest; readOnly: boolean; close: () => void; save: (row: unknown) => void}) {
  const row = index === undefined ? undefined : manifest[kind][index];
  const [form] = Form.useForm(); const recipeMode = Form.useWatch(['recipe', 'mode'], form); const operator = Form.useWatch('operator', form) as ReviewRule['operator'] | undefined; const [dirty, setDirty] = useState(false); const {modal} = App.useApp();
  const initial = configurationRecordInitialValues(kind, manifest.scope, row);
  for (const name of ['keywords', 'aliases']) if (Array.isArray(initial[name])) initial[name] = (initial[name] as string[]).join('\n');
  const finish = (values: Record<string, unknown>) => {
    if (readOnly) {close(); return;}
    // Keep extraction metadata that has no editable form control (for example
    // partyKinds, valueMultiplicity and requireLabel) when editing a field.
    const next: Record<string, unknown> = {...structuredClone(row ?? {}), ...values};
    for (const name of ['keywords', 'aliases']) if (name in next) next[name] = splitEntries(String(next[name] ?? ''));
    if (kind === 'sources') next.approvalRef = next.approvalRef || null;
    if (kind === 'fields') {if (!next.objectRole) delete next.objectRole; if (!(next.taxonomyIds as string[] | undefined)?.length) delete next.taxonomyIds; if (!next.valueKind) delete next.valueKind; next.unit = next.unit || null; next.currency = next.currency || null; const recipe = next.recipe as Record<string, unknown>; next.recipe = {...recipe, model: recipe.model || null};}
    if ((kind === 'materials' || kind === 'rules') && (next.applicability as {fieldId?: string})?.fieldId === undefined) delete next.applicability;
    if (kind === 'rules') {if (next.operator !== 'minimum_ratio') delete next.factor; if (next.operator !== 'manual_review') delete next.manualReason; if (!next.description) delete next.description; if (!['currency_is', 'minimum_in_currency'].includes(String(next.operator))) delete next.currency; next.requiredParameters ??= []; next.tests ??= []; for (const test of next.tests as ReviewRule['tests']) {test.synthetic = true; for (const fact of Object.values(test.facts)) {fact.value ??= null; fact.evidenceIds ??= []; if (!fact.objectId) delete fact.objectId;}}}
    save(next);
  };
  return <ActionModal title={`${readOnly ? '查看' : row ? '编辑' : '新增'}${collectionNames[kind]}`} okText={readOnly ? '关闭' : '保留修改'} pending={false} width={850} form={form} initialValues={initial} onValuesChange={() => setDirty(true)} onCancel={() => {if (!dirty || readOnly) close(); else modal.confirm({title: '放弃本次未保存修改？', okText: '放弃', cancelText: '继续编辑', onOk: close});}} onFinish={finish}>
    <fieldset disabled={readOnly} style={{border: 0, padding: 0, margin: 0}}><div className="review-loop-fields">
      <Form.Item name="id" label="稳定标识" rules={[...required, {pattern: /^[a-z][a-z0-9_.:-]{0,127}$/, message: '以小写字母开头，可含数字及 _ . : -'}]}><Input disabled={!!row || readOnly} maxLength={128}/></Form.Item>
      <Form.Item name={kind === 'sources' ? 'reference' : 'label'} label={kind === 'sources' ? '来源文件／单元格／版本' : '名称'} rules={required}><Input disabled={readOnly} maxLength={kind === 'sources' ? 500 : 200}/></Form.Item>
      {kind !== 'sources' && <Form.Item className="review-loop-full" name="sourceIds" label="来源依据" rules={[{required: true, type: 'array', min: 1, message: '请选择来源依据'}]}><Select mode="multiple" disabled={readOnly} options={options(manifest.sources)}/></Form.Item>}
      {kind === 'sources' && <><Form.Item name="sha256" label="来源 SHA-256" rules={[...required, {pattern: /^[a-f0-9]{64}$/, message: '输入 64 位 SHA-256'}]}><Input maxLength={64}/></Form.Item><Form.Item name="guaranteeType" label="担保类别"><Select disabled={readOnly} options={guaranteeOptions}/></Form.Item><Form.Item name="disposition" label="处置"><Select disabled={readOnly} options={[{value: 'candidate', label: '待确认'}, {value: 'confirmed', label: '已确认'}, {value: 'excluded', label: '不纳入'}, {value: 'manual', label: '人工判断'}]}/></Form.Item><Form.Item name="approvalRef" label="确认依据"><Input maxLength={300}/></Form.Item><Form.Item className="review-loop-full" name="reason" label="处置原因" rules={required}><Input.TextArea rows={3} maxLength={1000}/></Form.Item></>}
      {kind === 'taxonomy' && <Form.Item className="review-loop-full" name="keywords" label="完整文书标题（每行一个）" rules={required}><Input.TextArea rows={4}/></Form.Item>}
      {kind === 'materials' && <><Form.Item name="taxonomyId" label="材料类别" rules={required}><Select disabled={readOnly} options={options(manifest.taxonomy)}/></Form.Item><Form.Item name="required" label="材料要求" valuePropName="checked"><Checkbox disabled={readOnly}>必须提交</Checkbox></Form.Item><ConditionFields manifest={manifest} readOnly={readOnly}/></>}
      {kind === 'fields' && <><Form.Item name="type" label="值类型"><Select disabled={readOnly} options={[{value: 'text', label: '文字'}, {value: 'amount', label: '金额'}, {value: 'date', label: '日期'}, {value: 'currency', label: '币种'}]}/></Form.Item><Form.Item name="objectKind" label="业务对象"><Select disabled={readOnly} options={Object.entries({...objectKindLabels, signatory: '签署人'}).filter(([value]) => value !== 'signer').map(([value, label]) => ({value, label}))}/></Form.Item><Form.Item name="objectRole" label="对象角色标识（选填）" rules={[{pattern: /^[a-z][a-z0-9_]*$/, message: '使用小写字母、数字及下划线，以字母开头'}]}><Input maxLength={100} placeholder="如 borrower、mortgagor"/></Form.Item><Form.Item name="unit" label="单位"><Input maxLength={80}/></Form.Item><Form.Item name="currency" label="币种"><Input maxLength={3}/></Form.Item><Form.Item className="review-loop-full" name="semanticDefinition" label="字段业务含义" rules={required}><Input.TextArea rows={3} maxLength={4000}/></Form.Item><Form.Item className="review-loop-full" name="aliases" label="原文字段标签（每行一个）" rules={required}><Input.TextArea rows={3}/></Form.Item><Form.Item name="requiredDetection" valuePropName="checked"><Checkbox disabled={readOnly}>必须检测此字段</Checkbox></Form.Item><Form.Item name="requiredValue" valuePropName="checked"><Checkbox disabled={readOnly}>必须有值</Checkbox></Form.Item><Form.Item name={['recipe', 'mode']} label="提取方式"><Select disabled={readOnly} onChange={mode => {const recipe = REVIEW_EXTRACTION_RECIPES.find(recipe => recipe.modes.includes(mode) && recipe.scopes.includes(manifest.scope))!; form.setFieldsValue({recipe: {mode,version: recipe.version,model: recipe.model,promptSha256: recipe.promptSha256}});}} options={[{value: 'manual', label: '人工核对'}, {value: 'deterministic', label: '确定性提取'}, {value: 'private_candidate_filter', label: '私有候选筛选'}, ...(manifest.scope === 'synthetic' ? [{value: 'cloud_grounded_extract', label: '云端原文提取'}] : [])]}/></Form.Item><Form.Item name="taxonomyIds" label="适用材料" rules={recipeMode === 'cloud_grounded_extract' ? [{required: true, type: 'array', min: 1, message: '请选择适用材料'}] : []}><Select mode="multiple" allowClear disabled={readOnly} options={options(manifest.taxonomy)}/></Form.Item><Form.Item name="valueKind" label="字段内容" rules={recipeMode === 'cloud_grounded_extract' ? required : []}><Select allowClear disabled={readOnly} options={[{value: 'party_name', label: '主体名称'}, {value: 'identifier', label: '编号'}, {value: 'address', label: '地址'}, {value: 'amount', label: '金额'}, {value: 'date', label: '日期'}, {value: 'currency', label: '币种'}, {value: 'text', label: '其他文字'}]}/></Form.Item><Form.Item name={['recipe', 'version']} label="提取定义版本" rules={required}><Select disabled={readOnly} options={REVIEW_EXTRACTION_RECIPES.filter(recipe => recipe.scopes.includes(manifest.scope)).map(recipe => ({value: recipe.version,label: recipe.version}))} onChange={version => {const recipe = REVIEW_EXTRACTION_RECIPES.find(recipe => recipe.version === version)!; const current = form.getFieldValue(['recipe', 'mode']); form.setFieldsValue({recipe: {mode: recipe.modes.includes(current) ? current : recipe.modes[0],version,model: recipe.model,promptSha256: recipe.promptSha256}});}}/></Form.Item><Form.Item name={['recipe', 'model']} label="模型标识"><Input readOnly/></Form.Item><Form.Item name={['recipe', 'promptSha256']} label="提取定义指纹" rules={[...required, {pattern: /^[a-f0-9]{64}$/, message: '输入 64 位 SHA-256'}]}><Input readOnly/></Form.Item></>}
      {kind === 'rules' && <><Form.Item className="review-loop-full" name="description" label="银行要求与处理提示"><Input.TextArea rows={4} maxLength={8000}/></Form.Item>{operator === 'minimum_ratio' && <Form.Item name="factor" label="最低金额比例" extra="例如 1.2 表示基准金额的 120%。" rules={required}><Input maxLength={12}/></Form.Item>}{operator === 'manual_review' && <Form.Item name="manualReason" label="待核对原因"><Select disabled={readOnly} options={[{value:'manual_review_required',label:'人工核对原文'},{value:'reference_list_required',label:'待配置批准名单'},{value:'business_rule_confirmation_required',label:'待确认业务口径'}]}/></Form.Item>}<Form.Item name="operator" label="判断方式"><Select disabled={readOnly} options={Object.entries(operatorNames).map(([value, label]) => ({value, label}))}/></Form.Item>{['currency_is', 'minimum_in_currency'].includes(operator ?? '') && <Form.Item name="currency" label="指定币种" rules={[...required, {pattern: /^[A-Z]{3}$/, message: '请输入三位大写币种代码'}]}><Input disabled={readOnly} maxLength={3} placeholder="USD"/></Form.Item>}<Form.Item name="inputs" extra={operator === 'minimum_in_currency' ? '顺序：金额、基准金额、金额币种、基准币种；不进行换汇。' : operator === 'same_entity' ? '选择两个主体字段；名称相同不能替代身份确认。' : operator === 'currency_is' ? '三个币种输入均须等于指定币种。' : undefined} label="输入字段（按比较顺序）" rules={[{required: true, type: 'array', min: 1, message: '请选择输入字段'}]}><Select mode="multiple" disabled={readOnly} options={[...options(manifest.fields), ...manifest.materials.map(material => ({value: `material:${material.id}`, label: `材料已纳入：${material.label}`}))]}/></Form.Item><Form.Item name="requiredParameters" label="必需参考参数"><Select mode="multiple" disabled={readOnly} options={Object.keys(manifest.parameters).map(value => ({value, label: value}))}/></Form.Item><Form.Item name="sourceDirectionConfirmed" valuePropName="checked"><Checkbox disabled={readOnly}>已核对来源的比较方向及边界</Checkbox></Form.Item><ConditionFields manifest={manifest} readOnly={readOnly}/></>}
    </div>{kind === 'rules' && <RuleTests form={form} manifest={manifest} readOnly={readOnly}/>}</fieldset>
  </ActionModal>;
}

function ConditionFields({manifest, readOnly}: {manifest: ReviewConfigManifest; readOnly: boolean}) {return <><Form.Item name={['applicability', 'fieldId']} label="适用条件字段（选填）"><Select allowClear disabled={readOnly} options={options(manifest.fields)}/></Form.Item><Form.Item name={['applicability', 'equals']} label="适用条件等于"><ScalarValue disabled={readOnly}/></Form.Item></>;}

function RuleTests({form, manifest, readOnly}: {form: ReturnType<typeof Form.useForm>[0]; manifest: ReviewConfigManifest; readOnly: boolean}) {
  const operator = Form.useWatch('operator', form) as ReviewRule['operator'] | undefined;
  const inputFields = (Form.useWatch('inputs', form) ?? []) as string[];
  const condition = Form.useWatch(['applicability', 'fieldId'], form) as string | undefined;
  const inputs = [...new Set([...inputFields, ...(condition ? [condition] : [])])];
  return <Form.List name="tests">{(rows, {add, remove}) => <><h3>独立试例</h3>{rows.map(row => <fieldset className="review-loop-subpanel" key={row.key}><legend>试例 {row.name + 1}</legend><div className="review-loop-fields"><Form.Item name={[row.name, 'id']} label="试例标识" rules={required}><Input/></Form.Item><Form.Item name={[row.name, 'kind']} label="类型" rules={required}><Select disabled={readOnly} options={[{value: 'normal', label: '正常'}, {value: 'abnormal', label: '异常'}, {value: 'boundary', label: '边界'}, {value: 'missing_input', label: '缺输入'}]}/></Form.Item><Form.Item name={[row.name, 'expected']} label="预期结果" rules={required}><Select disabled={readOnly} options={outcomes}/></Form.Item><Form.Item name={[row.name, 'synthetic']} hidden valuePropName="checked"><Checkbox/></Form.Item></div>{inputs.map(fieldId => <div className="review-loop-fields" key={fieldId}><Form.Item name={[row.name, 'facts', fieldId, 'value']} label={inputLabel(manifest, fieldId)}><ScalarValue disabled={readOnly}/></Form.Item><Form.Item name={[row.name, 'facts', fieldId, 'state']} label="事实状态" rules={required}><Select disabled={readOnly} options={[{value: 'present', label: '有值'}, {value: 'missing', label: '缺少'}, {value: 'uncertain', label: '待确认'}, {value: 'redacted', label: '遮盖'}, {value: 'unreadable', label: '不可读'}, {value: 'not_applicable', label: '不适用'}, {value: 'blank', label: '留空'}]}/></Form.Item>{operator === 'same_entity' && <><Form.Item name={[row.name, 'facts', fieldId, 'objectId']} label="试例对象标识"><Input disabled={readOnly} maxLength={200}/></Form.Item><Form.Item name={[row.name, 'facts', fieldId, 'sameEntityIds']} label="确认同一主体的对象标识"><Select mode="tags" disabled={readOnly}/></Form.Item><Form.Item name={[row.name, 'facts', fieldId, 'differentEntityIds']} label="确认不同主体的对象标识"><Select mode="tags" disabled={readOnly}/></Form.Item></>}</div>)}{!readOnly && <Button danger onClick={() => remove(row.name)}>移除试例</Button>}</fieldset>)}{!readOnly && <Button onClick={() => add({id: `test_${rows.length + 1}`, kind: 'normal', synthetic: true, facts: Object.fromEntries(inputs.map(id => [id, {value: null, state: 'missing', evidenceIds: []}])), expected: 'blocked'})}>新增试例</Button>}</>}</Form.List>;
}

function ConfigAction({value, action, close, done}: {value: ReviewConfigView; action: 'validate' | 'trial' | 'approve' | 'publish'; close: () => void; done: (result: ReviewConfigView) => void}) {
  const [snapshot] = useState(value); const [key] = useState(newKey); const [pending, setPending] = useState(false); const [error, setError] = useState<unknown>();
  const title = {validate: '校验配置', trial: '运行试例', approve: '批准此版本', publish: '发布此版本'}[action];
  return <ActionModal title={title} okText={title} pending={pending} onCancel={close} summary={<dl><dt>配置</dt><dd>{snapshot.manifest.label}</dd><dt>修订</dt><dd>r{snapshot.revision}</dd><dt>适用范围</dt><dd>{snapshot.manifest.scope === 'synthetic' ? '合成验证' : '银行规则'}</dd><dt>发布标识</dt><dd className="mono">{snapshot.manifest.releaseId}</dd></dl>} warning={action === 'publish' ? '发布绑定当前清单、来源、测试和批准。已在审案件继续使用原绑定版本。' : action === 'approve' ? '批准仅适用于此内容指纹；实质编写者不能批准。' : undefined} error={<ErrorNotice error={error}/>}
    onFinish={async () => {setPending(true); setError(undefined); try {done(await api<ReviewConfigView>(`/api/review-configs/${encodeURIComponent(snapshot.id)}/${action}`, {method: 'POST', timeoutMs: action === 'trial' ? 180_000 : 30_000, body: {expectedRevision: snapshot.revision, idempotencyKey: key}}));} catch (failure) {setError(failure);} finally {setPending(false);}}}>
    <p className="review-loop-code mono">{snapshot.manifestHash}</p>
  </ActionModal>;
}

function inputLabel(manifest: ReviewConfigManifest, id: string) {return manifest.fields.find(field => field.id === id)?.label ?? (id.startsWith('material:') ? `材料已纳入：${manifest.materials.find(material => material.id === id.slice(9))?.label ?? id.slice(9)}` : id);}

/** Preserve booleans and exact decimal text in rules; never coerce finance values to JS numbers. */
function ScalarValue({value, onChange, disabled, label = ''}: {value?: string | boolean | null; onChange?: (value: string | boolean | null) => void; disabled?: boolean; label?: string}) {
  const kind = typeof value === 'boolean' ? 'boolean' : 'text';
  return <div className="rules-scalar"><Select aria-label={`${label}值类型`} value={kind} disabled={disabled} className="rules-scalar-kind" options={[{value: 'text', label: '文字／金额'}, {value: 'boolean', label: '是或否'}]} onChange={kind => onChange?.(kind === 'boolean' ? false : '')}/>{kind === 'boolean' ? <Checkbox disabled={disabled} checked={value === true} onChange={event => onChange?.(event.target.checked)}>是</Checkbox> : <Input aria-label={label ? `${label}值` : '参数或试例值'} disabled={disabled} className="rules-scalar-value" value={valueInput(value)} onChange={event => onChange?.(event.target.value || null)}/>}</div>;
}
