import React from 'react';
import './signature-requirement-editor.css';
import {Button, Checkbox, Input, InputNumber, Select} from 'antd';
import type {SignatureRequirement, SignatureRequirementExpression} from '@hsbc/contracts/signature-review';
import {changeRequirementExpressionKind, markLabels, signatureRoleLabels} from '../documents/signature-presentation.ts';
export interface SignatureRequirementEditorProps {
  value: SignatureRequirement; onChange: (value: SignatureRequirement) => void; disabled?: boolean;
  taxonomyOptions: {value: string; label: string}[]; sourceOptions: {value: string; label: string}[];
  subjectRoleOptions?: {value: string; label: string}[]; signerRoleOptions?: {value: string; label: string}[]; lockScope?: boolean;
}
const defaultRoles = Object.entries(signatureRoleLabels).map(([value, label]) => ({value, label}));
const defaultExpression: SignatureRequirementExpression = {kind: 'signers', roles: [], minimum: 1, mark: 'signature'};
function ExpressionEditor({value, onChange, disabled, roles, depth = 0}: {value: SignatureRequirementExpression; onChange: (value: SignatureRequirementExpression) => void; disabled?: boolean; roles: {value: string; label: string}[]; depth?: number}) {
  return <fieldset className="signature-expression" disabled={disabled}><legend className="visually-hidden">签署条件</legend>
    <label>组合方式<Select aria-label="签署条件组合方式" value={value.kind} disabled={disabled} options={[{value: 'signers', label: '人数及签章'}, {value: 'allOf', label: '全部满足', disabled: depth >= 5}, {value: 'anyOf', label: '任选一组', disabled: depth >= 5}]} onChange={kind => onChange(changeRequirementExpressionKind(value, kind))}/></label>
    {value.kind === 'signers' ? <div className="signature-editor-grid"><label>人员职务<Select aria-label="签署人员职务" mode="tags" value={value.roles} disabled={disabled} options={roles} placeholder="不限职务" onChange={values => onChange({...value, roles: values})}/></label><label>不同人员数<InputNumber aria-label="不同签署人员数" min={1} max={20} precision={0} value={value.minimum} disabled={disabled} onChange={minimum => {if (minimum !== null) onChange({...value, minimum});}}/></label><label>签章方式<Select aria-label="签章方式" disabled={disabled} value={value.mark} options={Object.entries(markLabels).map(([key, label]) => ({value: key, label}))} onChange={mark => onChange({...value, mark})}/></label></div>
    : <div className="signature-expression-children">{value.children.map((child, index) => <div key={index}><ExpressionEditor value={child} disabled={disabled} roles={roles} depth={depth + 1} onChange={next => onChange({...value, children: value.children.map((entry, position) => position === index ? next : entry)})}/><Button size="small" disabled={disabled || value.children.length <= 1} onClick={() => onChange({...value, children: value.children.filter((_, position) => position !== index)})}>移除此组</Button></div>)}<Button disabled={disabled || value.children.length >= 20 || depth >= 5} onClick={() => onChange({...value, children: [...value.children, {...defaultExpression}]})}>添加一组</Button></div>}
  </fieldset>;
}
export function SignatureRequirementEditor({value, onChange, disabled, taxonomyOptions, sourceOptions, subjectRoleOptions = defaultRoles, signerRoleOptions = defaultRoles, lockScope}: SignatureRequirementEditorProps) {
  const authorizationLabels = {requireEvidence: '核对授权依据', checkDate: '核对授权期限', checkAmount: '核对授权金额及币种', checkTransaction: '核对授权交易范围'} as const;
  return <div className="signature-requirement-editor"><div className="signature-editor-grid">
    <label>检查名称<Input aria-label="签署检查名称" value={value.label} maxLength={300} disabled={disabled} onChange={event => onChange({...value, label: event.target.value})}/></label>
    <label>代表主体角色<Select aria-label="签署要求代表主体角色" value={value.subjectRole} disabled={disabled} options={subjectRoleOptions} onChange={subjectRole => onChange({...value, subjectRole})}/></label>
    {!lockScope && <><label>适用材料<Select aria-label="签署要求适用材料" mode="multiple" value={value.taxonomyIds} disabled={disabled} options={taxonomyOptions} onChange={taxonomyIds => onChange({...value, taxonomyIds})}/></label><label>依据来源<Select aria-label="签署要求依据来源" mode="multiple" value={value.sourceIds} disabled={disabled} options={sourceOptions} onChange={sourceIds => onChange({...value, sourceIds})}/></label></>}
  </div><ExpressionEditor value={value.expression} onChange={expression => onChange({...value, expression})} disabled={disabled} roles={signerRoleOptions}/>
  <div className="signature-authorization-flags">{Object.entries(authorizationLabels).map(([key, label]) => <Checkbox key={key} checked={value.authorization[key as keyof typeof value.authorization]} disabled={disabled} onChange={event => onChange({...value, authorization: {...value.authorization, [key]: event.target.checked}})}>{label}</Checkbox>)}</div></div>;
}
