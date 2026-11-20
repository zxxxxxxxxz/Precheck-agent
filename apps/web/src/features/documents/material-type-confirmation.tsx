import {SUPPLEMENTAL_MATERIAL_ID} from '@hsbc/contracts/case-supplement';
import React, {useState} from 'react';
import {Alert, Button, Drawer, Form, Select} from 'antd';
import {api, newKey, queryClient} from '../../api.ts';
import {ErrorNotice, ReasonField, useRestoreFocus} from '../../ui.tsx';
import type {CaseSummary} from '../cases/types.ts';
import type {DirectoryResponse} from './types.ts';
import {assignDocumentMaterialType} from './material-scope.ts';
import './material-type-confirmation.css';

export function MaterialScopeNotice({status, onConfirm}: {status?: string; onConfirm?: () => void}) {
  const stale = status === 'stale';
  return <Alert className="material-scope-notice" type={stale ? 'info' : 'warning'} showIcon
    title={stale ? '正在更新字段范围' : '材料类型待确认'}
    description={stale ? '材料类型已更新，字段核对完成后将显示结果。' : status === 'ambiguous' ? '自动分类结果不一致。请确认整份文件的材料类型，再核对对应字段。' : '暂未确定材料类型。确认前不展示字段，也不计算缺项。'}
    action={onConfirm && !stale ? <Button onClick={onConfirm}>确认材料类型</Button> : undefined}/>;
}

export function DirectoryDrawer({item: liveItem, filename, continueExtraction = false, base, value: liveValue, close, done}: {item: CaseSummary; filename: string; continueExtraction?: boolean; base: string; value: DirectoryResponse; close: () => void; done: () => void}) {
  useRestoreFocus();
  const [item] = useState(liveItem);
  const [value] = useState(liveValue);
  const [form] = Form.useForm();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<unknown>();
  const [key, setKey] = useState(newKey);
  const types = [...new Set(value.directory.flatMap(entry=>entry.labelId?[entry.labelId]:[]))];
  return <Drawer title="确认材料类型" classNames={{section: 'material-type-drawer'}} open mask={false} size="min(480px, 100vw)" onClose={pending ? undefined : close} closable={pending ? false : {placement: 'end'}} keyboard={!pending} destroyOnHidden footer={<div className="drawer-footer"><Button onClick={close} disabled={pending}>取消</Button><Button type="primary" loading={pending} onClick={() => form.submit()}>保存材料类型</Button></div>}>
    <div className="material-type-file"><span>当前文件</span><strong>{filename}</strong></div>
    <p className="material-type-intro">{continueExtraction ? '为整份文件选择一种材料类型。保存后将按新类型继续提取字段，请在完成后重新核对。' : '为整份文件选择一种材料类型。保存后仅显示对应字段，已有提取结果需重新核对。'}</p>
    <p className="material-type-intro">选择“其他／补充材料”后，请在案件助手的“补充材料”中指定提取字段及核对内容。</p>
    <div className="material-type-error"><ErrorNotice error={error} retry={done}/></div>
    <Form form={form} layout="vertical" clearOnDestroy disabled={pending} initialValues={{taxonomyId:types.length===1?types[0]:undefined}} onValuesChange={() => setKey(newKey())} onFinish={async (values: {reason: string; taxonomyId:string}) => {
      setPending(true);setError(undefined);
      try {
        const logicalDocuments=assignDocumentMaterialType(value,values.taxonomyId);
        await api(`${base}/directory`, {method:'POST',body:{...(item.selectedRoundId&&item.selectedRoundId!=='legacy'?{roundId:item.selectedRoundId}:{}),expectedRevision:item.revision,expectedDirectoryRevision:value.revision,parseRevision:value.parseRevision,idempotencyKey:key,reason:values.reason,logicalDocuments,...(continueExtraction&&values.taxonomyId!==SUPPLEMENTAL_MATERIAL_ID?{continueExtraction:true}:{})}});
        await queryClient.invalidateQueries({queryKey:['case',item.id]});done();
      } catch(failure){setError(failure);} finally{setPending(false);}
    }}>
      <Form.Item name="taxonomyId" label="当前文件材料类型" rules={[{required:true,message:'请选择材料类型'}]}><Select aria-label="当前文件材料类型" placeholder="请选择材料类型" options={value.taxonomy.map(type=>({value:type.id,label:type.label}))}/></Form.Item>
      <ReasonField label="确认原因"/>
    </Form>
  </Drawer>;
}
