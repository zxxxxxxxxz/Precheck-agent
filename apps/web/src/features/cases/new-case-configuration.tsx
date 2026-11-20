import React from 'react';
import {Checkbox} from 'antd';
import type {CaseConfigurationOption, CaseConfigurationOptions} from '@hsbc/contracts/draft';
import {GUARANTEE_LABELS} from '@hsbc/contracts/mixed-guarantee';
import {formatTime} from '../../shared/format.ts';
import {chooseCaseConfiguration, type CaseConfigurationChoice} from './configuration-selection.ts';
import {bankMaterialChecklist} from '../materials/bank-material-checklist.ts';
import {MaterialChecklistTitle} from '../materials/material-checklist-title.tsx';
import './new-case-configuration.css';

export function NewCaseConfiguration({data, loading, disabled, value, onChange}: {
  data?: CaseConfigurationOptions; loading: boolean; disabled: boolean; value: CaseConfigurationChoice; onChange: (next: CaseConfigurationChoice) => void;
}) {
  const selected = data?.items.find(item => item.releaseId === value.releaseId);
  const unavailable = !loading && data && !data.canSelect;
  const noMatch = !!data?.canSelect && value.guaranteeTypes.length > 0 && !selected;
  return <section className="case-business-picker" aria-label="选择担保类型">
    <div className="case-business-heading"><h2>担保类型 <span>可多选</span></h2><span role="status">已选择 {value.guaranteeTypes.length} 项</span></div>
    <Checkbox.Group aria-label="本案担保类型" className="case-business-options" value={value.guaranteeTypes}
      disabled={disabled || loading || !data?.canSelect}
      options={Object.entries(GUARANTEE_LABELS).map(([type, label]) => ({value: type, label,
        className: `case-business-option${value.guaranteeTypes.includes(type as CaseConfigurationChoice['guaranteeTypes'][number]) ? ' is-selected' : ''}`}))}
      onChange={types => onChange(chooseCaseConfiguration(data?.items ?? [], types as CaseConfigurationChoice['guaranteeTypes']))}/>
    {(loading || unavailable || noMatch || selected?.scope === 'synthetic') && <p className="case-business-hint has-warning" role="status">
      {loading ? '正在读取适用规则…' : unavailable ? data.reason === 'permission_required'
        ? '当前账号暂无使用审核规则的权限，请联系权限管理员。' : '审核规则暂不可用，可先暂存案件信息。'
        : noMatch ? '所选担保组合暂无已发布规则，可先暂存，待规则发布后创建案件。'
          : '当前仅有验证规则，仅用于测试。'}
    </p>}
    {selected && <details className="case-rule-details" key={selected.releaseId}><summary>查看规则详情</summary>
      <p>{selected.label}</p><p>{selected.scope === 'bank' ? '银行规则' : '合成验证'} · 发布于 {formatTime(selected.publishedAt)}</p>
      <p>创建后固定使用该版本，后续发布不影响已有案件。</p>
    </details>}
  </section>;
}

export function NewCaseMaterialRequirements({option, selected, loading, error, hidden}: {
  option?: CaseConfigurationOption; selected: boolean; loading: boolean; error: boolean; hidden?: boolean;
}) {
  const materials = bankMaterialChecklist(option?.guaranteeTypes);
  const roles = [...new Set(materials?.map(material => material.objectRole ?? 'case') ?? [])];
  return <aside className="case-material-preview" aria-label="本轮材料清单" hidden={hidden}>
    <header><h2>本轮材料清单</h2>{materials?.length ? <span>{materials.length} 类材料</span> : null}</header>
    {materials?.length ? <>
      <p className="case-material-intro">按银行材料清单列示，请按各项适用条件准备。</p>
      <div className="preparation-checklist">{roles.map(role => <section key={role}><h3 className={roles.length === 1 ? 'visually-hidden' : undefined}>{GUARANTEE_LABELS[role] ?? (role === 'case' ? '共用材料' : '相关材料')}</h3>
        <ul>{materials.filter(material => (material.objectRole ?? 'case') === role).map(material => <li key={material.id}>
          <MaterialChecklistTitle {...material}/>
        </li>)}</ul>
      </section>)}</div>
    </> : <p className="case-material-intro">{loading ? '正在读取材料要求…' : error ? '材料要求暂时无法读取，请重试规则查询。'
      : !selected ? '选择担保类型后，这里会列出本轮需要准备的材料。' : !option ? '暂无适用的已发布规则，暂不能列出材料要求。'
        : '材料要求暂不可用，创建后可在材料页查看。'}</p>}
  </aside>;
}
