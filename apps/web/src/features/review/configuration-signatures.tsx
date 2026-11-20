import React, {useState} from 'react';
import {Alert, App, Button, Checkbox, Form, Input, Modal, Select, Table} from 'antd';
import {SignatureRuleTestSchema, type ReviewConfigManifest} from '@hsbc/contracts/review-config';
import {SignatureRequirementSchema, type SignatureRequirement} from '@hsbc/contracts/signature-review';
import {SignatureRequirementEditor} from './signature-requirement-editor.tsx';
import {requirementExpressionText, signatureRoleLabel, signatureRoleLabels} from '../documents/signature-presentation.ts';

type Trial = NonNullable<ReviewConfigManifest['signatureTests']>[number];
const kinds = {normal: '满足要求', abnormal: '不满足要求', boundary: '边界情况', missing_input: '依据不足'};
const outcomes = {pass: '未发现差异', fail: '明确差异', blocked: '证据不足', not_applicable: '不适用'};
const roleOptions = Object.entries(signatureRoleLabels).map(([value, label]) => ({value, label}));
const emptyRequirement = (): SignatureRequirement => ({id: `signature_${Date.now()}`, label: '', subjectRole: 'borrower', taxonomyIds: [], sourceIds: [], expression: {kind: 'signers', roles: [], minimum: 1, mark: 'signature'}, authorization: {requireEvidence: false, checkDate: false, checkAmount: false, checkTransaction: false}});

export function ConfigSignatures({manifest, disabled, change}: {manifest: ReviewConfigManifest; disabled: boolean; change: (value: ReviewConfigManifest) => void}) {
  const {modal} = App.useApp();
  const [editing, setEditing] = useState<{index?: number; value: SignatureRequirement}>();
  const [trial, setTrial] = useState<{index?: number; value: Trial}>();
  const [error, setError] = useState('');
  const requirements = manifest.signatureRequirements ?? [];
  const tests = manifest.signatureTests ?? [];
  const put = (next: SignatureRequirement[], nextTests = tests) => {
    const {signatureRequirements: _requirements, signatureTests: _tests, ...rest} = manifest;
    const {signatureExecutorVersion: _executor, ...compatibility} = manifest.compatibility;
    change(next.length ? {...rest, signatureRequirements: next, ...(nextTests.length ? {signatureTests: nextTests} : {}), compatibility: {...compatibility, signatureExecutorVersion: 'signature-requirements-v1'}} : {...rest, compatibility: {...compatibility, ...(manifest.compatibility.signatureExecutorVersion ? {signatureExecutorVersion: manifest.compatibility.signatureExecutorVersion} : {})}});
  };
  const addTrial = () => {setError(''); setTrial({value: {id: `signature_test_${Date.now()}`, requirementId: requirements[0]!.id, kind: 'normal', synthetic: true, expected: 'pass', input: {signers: [], transactionFacts: {date: null, amount: null, currency: null, transactionType: null}, taxonomyIds: requirements[0]!.taxonomyIds, classificationKnown: true, coverageComplete: true}}});};
  return <div className="rules-signatures">
    <Checkbox disabled={disabled || requirements.length > 0} checked={!!manifest.compatibility.signatureExecutorVersion} onChange={event => {const {signatureExecutorVersion: _version, ...compatibility} = manifest.compatibility; change({...manifest, compatibility: {...compatibility, ...(event.target.checked ? {signatureExecutorVersion: 'signature-requirements-v1' as const} : {})}});}}>启用签署核验</Checkbox>
    {!requirements.length && manifest.compatibility.signatureExecutorVersion && <p className="rules-hint">未配置统一要求，按原文条款逐项确认。</p>}
    <div className="rules-signatures-heading"><h3>签署要求</h3><Button disabled={disabled} onClick={() => {setError(''); setEditing({value: emptyRequirement()});}}>新增要求</Button></div>
    <Table<SignatureRequirement> rowKey="id" pagination={false} scroll={{x: 680}} dataSource={requirements} locale={{emptyText: '尚未配置签署要求'}} columns={[
      {title: '主体／要求', key: 'requirement', render: (_, row) => <><strong>{row.label}</strong><div>{signatureRoleLabel(row.subjectRole)} · {requirementExpressionText(row.expression)}</div></>},
      {title: '适用材料', key: 'taxonomy', render: (_, row) => row.taxonomyIds.map(id => manifest.taxonomy.find(value => value.id === id)?.label ?? id).join('、')},
      {title: '来源', key: 'source', render: (_, row) => row.sourceIds.map(id => manifest.sources.find(value => value.id === id)?.reference ?? id).join('；')},
      {title: '操作', key: 'actions', width: 140, render: (_, row, index) => <div className="row-actions"><Button type="link" onClick={() => {setError(''); setEditing({index, value: structuredClone(row)});}}>{disabled ? '查看' : '编辑'}</Button>{!disabled && <Button type="link" danger onClick={() => modal.confirm({title: `移除“${row.label}”？`, content: '关联试例将一并移除。', okText: '移除', cancelText: '取消', onOk: () => put(requirements.filter(value => value.id !== row.id), tests.filter(value => value.requirementId !== row.id))})}>移除</Button>}</div>},
    ]}/>
    <div className="rules-signatures-heading"><h3>合成试例</h3><Button disabled={disabled || !requirements.length} onClick={addTrial}>新增试例</Button></div>
    <p className="rules-hint">每项要求需覆盖满足、不满足、边界和依据不足的情况。</p>
    <Table<Trial> rowKey="id" pagination={{pageSize: 12, hideOnSinglePage: true}} scroll={{x: 620}} dataSource={tests} locale={{emptyText: '尚未配置试例'}} columns={[
      {title: '要求', dataIndex: 'requirementId', render: id => requirements.find(value => value.id === id)?.label ?? id},
      {title: '情况', dataIndex: 'kind', render: (kind: Trial['kind']) => kinds[kind]},
      {title: '人员', key: 'signers', render: (_, row) => row.input.signers.map(value => `${value.personId}（${signatureRoleLabel(value.role)}）`).join('、') || '未提供'},
      {title: '预期', dataIndex: 'expected', render: (value: Trial['expected']) => outcomes[value]},
      {title: '操作', key: 'actions', width: 140, render: (_, row, index) => <div className="row-actions"><Button type="link" onClick={() => {setError(''); setTrial({index, value: structuredClone(row)});}}>{disabled ? '查看' : '编辑'}</Button>{!disabled && <Button type="link" danger onClick={() => put(requirements, tests.filter(value => value.id !== row.id))}>移除</Button>}</div>},
    ]}/>
    {editing && <Modal open title={disabled ? '签署要求' : '编辑签署要求'} width={800} onCancel={() => setEditing(undefined)} footer={disabled ? null : undefined} okText="应用到草稿" cancelText="取消" onOk={() => {
      const parsed = SignatureRequirementSchema.safeParse(editing.value);
      if (!parsed.success || !/^[a-z][a-z0-9_.:-]{0,127}$/.test(editing.value.id) || requirements.some((value, index) => index !== editing.index && value.id === editing.value.id)) {setError('请补齐名称、材料和来源，并使用唯一的要求标识。'); return;}
      const next = [...requirements]; if (editing.index === undefined) next.push(parsed.data); else next[editing.index] = parsed.data;
      const previousId = editing.index === undefined ? undefined : requirements[editing.index]?.id;
      put(next, tests.map(value => value.requirementId === previousId ? {...value, requirementId: parsed.data.id} : value)); setEditing(undefined);
    }}>
      {error && <Alert type="error" showIcon title={error}/>}
      <Form layout="vertical"><Form.Item label="要求标识"><Input disabled={disabled} value={editing.value.id} onChange={event => setEditing({...editing, value: {...editing.value, id: event.target.value}})}/></Form.Item></Form>
      <SignatureRequirementEditor value={editing.value} disabled={disabled} onChange={value => setEditing({...editing, value})} taxonomyOptions={manifest.taxonomy.map(value => ({value: value.id, label: value.label}))} sourceOptions={manifest.sources.map(value => ({value: value.id, label: value.reference}))}/>
    </Modal>}
    {trial && <Modal open title="签署合成试例" width={900} onCancel={() => setTrial(undefined)} footer={disabled ? null : undefined} okText="应用到草稿" cancelText="取消" onOk={() => {
      const parsed = SignatureRuleTestSchema.safeParse(trial.value);
      if (!parsed.success || tests.some((value, index) => index !== trial.index && value.id === trial.value.id)) {setError('请检查试例标识、人员及授权信息。'); return;}
      const next = [...tests]; if (trial.index === undefined) next.push(parsed.data); else next[trial.index] = parsed.data; put(requirements, next); setTrial(undefined);
    }}>
      {error && <Alert type="error" showIcon title={error}/>}
      <SignatureTrialEditor value={trial.value} change={value => setTrial({...trial, value})} manifest={manifest} disabled={disabled}/>
    </Modal>}
  </div>;
}

function SignatureTrialEditor({value, change, manifest, disabled}: {value: Trial; change: (value: Trial) => void; manifest: ReviewConfigManifest; disabled: boolean}) {
  const input = value.input;
  const setInput = (next: Trial['input']) => change({...value, input: next});
  const setSigner = (index: number, next: Trial['input']['signers'][number]) => setInput({...input, signers: input.signers.map((entry, position) => position === index ? next : entry)});
  return <Form layout="vertical" disabled={disabled}>
    <div className="review-loop-fields">
      <Form.Item label="试例标识"><Input value={value.id} onChange={event => change({...value, id: event.target.value})}/></Form.Item>
      <Form.Item label="签署要求"><Select value={value.requirementId} options={manifest.signatureRequirements?.map(entry => ({value: entry.id, label: entry.label}))} onChange={requirementId => change({...value, requirementId})}/></Form.Item>
      <Form.Item label="情况"><Select value={value.kind} options={Object.entries(kinds).map(([value, label]) => ({value, label}))} onChange={kind => change({...value, kind})}/></Form.Item>
      <Form.Item label="预期结果"><Select value={value.expected} options={Object.entries(outcomes).map(([value, label]) => ({value, label}))} onChange={expected => change({...value, expected})}/></Form.Item>
      <Form.Item label="材料类别"><Select mode="multiple" value={input.taxonomyIds} options={manifest.taxonomy.map(entry => ({value: entry.id, label: entry.label}))} onChange={taxonomyIds => setInput({...input, taxonomyIds})}/></Form.Item>
      <Form.Item label="读取情况"><Checkbox checked={input.coverageComplete} onChange={event => setInput({...input, coverageComplete: event.target.checked})}>页面完整</Checkbox><Checkbox checked={input.classificationKnown} onChange={event => setInput({...input, classificationKnown: event.target.checked})}>分类明确</Checkbox></Form.Item>
    </div>
    <h4>合成人员</h4>
    {input.signers.map((signer, index) => <fieldset className="rules-signature-signer" key={index}><legend>人员 {index + 1}</legend><div className="review-loop-fields">
      <Form.Item label="人员标识"><Input value={signer.personId} onChange={event => setSigner(index, {...signer, personId: event.target.value})}/></Form.Item>
      <Form.Item label="主体标识"><Input value={signer.subjectId} onChange={event => setSigner(index, {...signer, subjectId: event.target.value})}/></Form.Item>
      <Form.Item label="主体角色"><Select value={signer.subjectRole} options={roleOptions} onChange={subjectRole => setSigner(index, {...signer, subjectRole})}/></Form.Item>
      <Form.Item label="人员职务"><Select value={signer.role} options={roleOptions} onChange={role => setSigner(index, {...signer, role})}/></Form.Item>
      <Form.Item label="已确认观察"><Checkbox checked={signer.signature} onChange={event => setSigner(index, {...signer, signature: event.target.checked})}>签字</Checkbox><Checkbox checked={signer.stamp} onChange={event => setSigner(index, {...signer, stamp: event.target.checked})}>盖章</Checkbox></Form.Item>
      <Form.Item label="授权依据"><Checkbox checked={!!signer.authorization} onChange={event => setSigner(index, {...signer, authorization: event.target.checked ? {sourceAnchorIds: ['synthetic_authorization'], validFrom: null, validUntil: null, maxAmount: null, currency: null, transactionTypes: []} : null})}>提供合成授权</Checkbox></Form.Item>
      {signer.authorization && <><Form.Item label="授权开始日期"><Input type="date" value={signer.authorization.validFrom ?? ''} onChange={event => setSigner(index, {...signer, authorization: {...signer.authorization!, validFrom: event.target.value || null}})}/></Form.Item><Form.Item label="授权截止日期"><Input type="date" value={signer.authorization.validUntil ?? ''} onChange={event => setSigner(index, {...signer, authorization: {...signer.authorization!, validUntil: event.target.value || null}})}/></Form.Item><Form.Item label="授权金额"><Input inputMode="decimal" value={signer.authorization.maxAmount ?? ''} onChange={event => setSigner(index, {...signer, authorization: {...signer.authorization!, maxAmount: event.target.value || null}})}/></Form.Item><Form.Item label="授权币种"><Input value={signer.authorization.currency ?? ''} onChange={event => setSigner(index, {...signer, authorization: {...signer.authorization!, currency: event.target.value || null}})}/></Form.Item><Form.Item label="授权交易范围"><Select mode="tags" value={signer.authorization.transactionTypes} onChange={transactionTypes => setSigner(index, {...signer, authorization: {...signer.authorization!, transactionTypes}})}/></Form.Item></>}
    </div><Button danger onClick={() => setInput({...input, signers: input.signers.filter((_, position) => position !== index)})}>移除此人</Button></fieldset>)}
    <Button onClick={() => setInput({...input, signers: [...input.signers, {personId: `person_${input.signers.length + 1}`, subjectId: 'company_1', subjectRole: manifest.signatureRequirements?.find(entry => entry.id === value.requirementId)?.subjectRole ?? 'borrower', role: 'director', authorization: null, signature: true, stamp: false}]})}>添加合成人员</Button>
    <h4>交易条件</h4><div className="review-loop-fields">{(['date', 'amount', 'currency', 'transactionType'] as const).map(key => <Form.Item key={key} label={{date: '交易日期', amount: '金额', currency: '币种', transactionType: '交易类型'}[key]}>{key === 'amount' ? <Input inputMode="decimal" value={input.transactionFacts.amount ?? ''} onChange={event => setInput({...input, transactionFacts: {...input.transactionFacts, amount: event.target.value || null}})}/> : <Input type={key === 'date' ? 'date' : 'text'} value={input.transactionFacts[key] ?? ''} onChange={event => setInput({...input, transactionFacts: {...input.transactionFacts, [key]: event.target.value || null}})}/>}</Form.Item>)}</div>
  </Form>;
}
