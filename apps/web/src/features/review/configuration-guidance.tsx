import React, {useState} from 'react';
import {App, Button, Form, Input, Select, Table} from 'antd';
import type {ConfigSemanticGuidance, ReviewConfigManifest} from '@hsbc/contracts/review-config';
import {SEMANTIC_GUIDANCE_KIND_LABELS, releaseGuidanceLabel, type SemanticGuidanceKind} from '@hsbc/contracts/review-guidance';
import {ActionModal} from '../../ui.tsx';

const kindOptions = (Object.entries(SEMANTIC_GUIDANCE_KIND_LABELS) as Array<[SemanticGuidanceKind, string]>).map(([value, label]) => ({value, label}));
const kindHelp: Record<SemanticGuidanceKind, string> = {
  name_equivalence: '列出指向同一主体的不同写法，至少两个；比较取值中同时出现两种写法时才采用。',
  wording_tolerance: '指定字段或写法；仅文字字段适用，金额、币种、日期和编号仍逐字核对。',
  legal_baseline: '法律意见书核对时提示的底线要求，不改变字段比较结论。',
  focus_note: '在指定字段旁提示重点核对，不改变结论。',
};
type Row = ConfigSemanticGuidance;
/** Names may contain commas; only line breaks separate expressions. */
const lines = (value: string) => [...new Set(value.split('\n').map(entry => entry.trim()).filter(Boolean))];

/** Semantic wording only informs AI comparison; OPA rules and exact checks are unaffected. */
export function ConfigSemanticGuidance({manifest, disabled, change}: {manifest: ReviewConfigManifest; disabled: boolean; change: (value: ReviewConfigManifest) => void}) {
  const {modal} = App.useApp();
  const [editing, setEditing] = useState<{index?: number}>();
  const rows = manifest.semanticGuidance ?? [];
  const put = (next: Row[]) => {const {semanticGuidance: _old, ...rest} = manifest; change(next.length ? {...rest, semanticGuidance: next} : rest);};
  const fieldLabel = (id: string) => manifest.fields.find(field => field.id === id)?.label ?? id;
  return <div className="rules-guidance">
    <div className="rules-signatures-heading"><h3>语义口径</h3><Button disabled={disabled} onClick={() => setEditing({})}>新增口径</Button></div>
    <p className="rules-hint">口径用于 AI 跨文件含义核对和法律意见书提示。发布后，选用此版本的案件自动带入；金额、币种、日期、编号及确定性规则结果不受影响。</p>
    <Table<Row> rowKey="id" pagination={false} scroll={{x: 720}} dataSource={rows} locale={{emptyText: '尚未配置语义口径'}} columns={[
      {title: '编号', key: 'label', width: 120, render: (_, _row, index) => <span className="mono">{releaseGuidanceLabel(index).replace('规则中心口径 ', '')}</span>},
      {title: '口径', key: 'statement', render: (_, row) => <><strong>{SEMANTIC_GUIDANCE_KIND_LABELS[row.kind]}</strong><p className="rules-guidance-statement">{row.statement}</p>{row.origin && <div className="review-loop-rule-source">来自案件规则整理</div>}</>},
      {title: '适用范围', key: 'scope', width: 260, render: (_, row) => <>{row.fieldIds.length > 0 && <div>字段：{row.fieldIds.map(fieldLabel).join('、')}</div>}{row.expressions.length > 0 && <div>写法：{row.expressions.join('｜')}</div>}{!row.fieldIds.length && !row.expressions.length && <span className="muted">不限字段</span>}</>},
      {title: '操作', key: 'actions', width: 140, render: (_, row, index) => <div className="row-actions"><Button type="link" onClick={() => setEditing({index})}>{disabled ? '查看' : '编辑'}</Button>{!disabled && <Button type="link" danger onClick={() => modal.confirm({title: '从此草稿移除这条口径？', content: '已发布版本不受影响；移除后需重新校验和试跑。', okText: '移除', cancelText: '取消', onOk: () => put(rows.filter(item => item.id !== row.id))})}>移除</Button>}</div>},
    ]}/>
    {editing && <GuidanceRecord manifest={manifest} row={editing.index === undefined ? undefined : rows[editing.index]} readOnly={disabled} close={() => setEditing(undefined)}
      save={row => {const next = [...rows]; if (editing.index === undefined) next.push(row); else next[editing.index] = row; put(next); setEditing(undefined);}}/>}
  </div>;
}

function GuidanceRecord({manifest, row, readOnly, close, save}: {manifest: ReviewConfigManifest; row?: Row; readOnly: boolean; close: () => void; save: (row: Row) => void}) {
  const [form] = Form.useForm(); const kind = Form.useWatch('kind', form) as SemanticGuidanceKind | undefined;
  const textFields = manifest.fields.filter(field => kind === 'focus_note' || kind === 'legal_baseline' || field.type === 'text' && field.valueKind !== 'identifier');
  const initial = row ? {...row, expressions: row.expressions.join('\n')} : {id: `g_${Date.now()}`, kind: 'name_equivalence', statement: '', fieldIds: [], expressions: '', sourceIds: manifest.sources.filter(source => source.disposition === 'confirmed' || source.disposition === 'candidate').slice(0, 1).map(source => source.id)};
  return <ActionModal title={`${readOnly ? '查看' : row ? '编辑' : '新增'}语义口径`} okText={readOnly ? '关闭' : '保留修改'} pending={false} width={760} form={form} initialValues={initial} onCancel={close}
    onFinish={(values: {id: string; kind: SemanticGuidanceKind; statement: string; fieldIds?: string[]; expressions?: string; sourceIds: string[]}) => {
      if (readOnly) {close(); return;}
      save({...(row ?? {}), id: values.id, kind: values.kind, statement: values.statement.trim(), fieldIds: values.fieldIds ?? [], expressions: lines(values.expressions ?? ''), sourceIds: values.sourceIds});
    }}>
    <fieldset disabled={readOnly} style={{border: 0, padding: 0, margin: 0}}><div className="review-loop-fields">
      <Form.Item name="id" label="稳定标识" rules={[{required: true, pattern: /^[a-z][a-z0-9_.:-]{0,127}$/, message: '以小写字母开头，可含数字及 _ . : -'}]}><Input disabled={!!row || readOnly} maxLength={128}/></Form.Item>
      <Form.Item name="kind" label="口径类型" extra={kind ? kindHelp[kind] : undefined}><Select disabled={readOnly} options={kindOptions}/></Form.Item>
      <Form.Item className="review-loop-full" name="statement" label="口径内容" rules={[{required: true, whitespace: true, min: 4, message: '请用一句话写明判断口径'}]}><Input.TextArea rows={3} maxLength={500} showCount/></Form.Item>
      <Form.Item className="review-loop-full" name="fieldIds" label="适用字段（选填）"><Select mode="multiple" allowClear disabled={readOnly} options={textFields.map(field => ({value: field.id, label: field.label}))}/></Form.Item>
      <Form.Item className="review-loop-full" name="expressions" label="相关写法（每行一个，选填）"><Input.TextArea rows={3} placeholder={'Example Trading Limited\nExample Trading Ltd'}/></Form.Item>
      <Form.Item className="review-loop-full" name="sourceIds" label="来源依据" rules={[{required: true, type: 'array', min: 1, message: '请选择来源依据'}]}><Select mode="multiple" disabled={readOnly} options={manifest.sources.map(source => ({value: source.id, label: source.reference}))}/></Form.Item>
    </div></fieldset>
  </ActionModal>;
}
