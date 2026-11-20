import React from 'react';
import {Button, Collapse} from 'antd';
import type {GuarantorGroup, GuarantorValue} from './personal-guarantor-groups.ts';
import './personal-guarantor-fields.css';

export type FieldCorrectionTarget = {fieldId: string; label: string; rawValue?: string; anchorIds: string[]; pageNumber?: number; personName?: string};
const rows = [{id: 'pg_field_13', label: '姓名'}, {id: 'pg_field_14', label: '身份证号码'}, {id: 'pg_field_15', label: '地址'}, {id: 'pg_guarantor_signed', label: '签署'}];
export function PersonalGuarantorFields({groups, unassigned, onSelect, onCorrect}: {groups: GuarantorGroup[]; unassigned: GuarantorValue[]; onSelect: (ids: string[], page?: number) => void; onCorrect?: (target: FieldCorrectionTarget) => void}) {
  const valueLink = (value: GuarantorValue, index: number) => <button key={index} type="button" className="evidence-value-link" disabled={!value.anchorIds.length} onClick={() => onSelect(value.anchorIds, value.pageNumbers[0])}>{value.text}</button>;
  return <section className="personal-guarantors" aria-label="逐位担保人信息">
    <div className="personal-guarantors-heading"><strong>担保人信息</strong><span className="muted">{groups.length} 个签署栏 · 归属待核对</span></div>
    <p className="muted">按原文签署位置整理。逐人核对姓名、证件、地址和签署后，再确认采用。</p>
    {groups.map((group, index) => <section className="personal-guarantor" key={group.id} aria-label={`担保人 ${index + 1}`}>
      <div className="personal-guarantor-heading"><strong>担保人 {index + 1}{group.values.filter(value => value.fieldId === 'pg_field_13').length === 1 ? ` · ${group.name.text}` : ' · 姓名待核对'}</strong><Button type="link" size="small" onClick={() => onSelect(group.name.anchorIds, group.name.pageNumbers[0])}>第 {group.name.pageNumbers[0]} 页</Button></div>
      <dl>{rows.map(row => {
        const values = group.values.filter(value => value.fieldId === row.id);
        const only = values.length === 1 ? values[0] : undefined;
        return <div className="personal-guarantor-row" key={row.id}><dt>{row.label}</dt><dd>{values.length ? values.map(valueLink) : <span className="muted">{row.id === 'pg_guarantor_signed' ? '待人工核对签署' : '未识别到 · 待补正'}</span>}{values.length > 1 && <span className="tone-warning">识别文字有差异，请核对原文</span>}</dd>{onCorrect && <Button type="link" size="small" aria-label={`担保人 ${index + 1}：${row.label}${row.id === 'pg_guarantor_signed' ? '核对' : '更正'}`} onClick={() => onCorrect({fieldId: row.id, label: `${row.label}（担保人 ${index + 1}）`, personName: group.values.filter(value => value.fieldId === 'pg_field_13').length === 1 ? group.name.text : undefined, rawValue: only?.text, anchorIds: only?.anchorIds ?? [], pageNumber: group.name.pageNumbers[0]})}>{row.id === 'pg_guarantor_signed' ? '核对' : '更正'}</Button>}</div>;
      })}</dl>
    </section>)}
    {!!unassigned.length && <Collapse className="personal-guarantors-unassigned" classNames={{header: 'personal-guarantors-unassigned-header', body: 'personal-guarantors-unassigned-body'}} size="small" items={[{key: 'unassigned', label: `待确认归属／空白栏 ${unassigned.length} 项`, children: <div className="personal-guarantor-unassigned"><p>这些内容未归入任何担保人。请核对原文；空白签署栏不作为新增担保人。</p>{unassigned.map((value, index) => <div key={index}><span>{rows.find(row => row.id === value.fieldId)?.label}：</span>{valueLink(value, index)}</div>)}</div>}]} />}
  </section>;
}

export function PersonalGuarantorRecords({count, children}: {count: number; children: React.ReactNode}) {
  return <details className="field-list-details personal-guarantor-records">
    <summary><span>担保人逐字段识别记录</span><span className="personal-guarantor-records-count">{count} 项</span></summary>
    {children}
  </details>;
}
