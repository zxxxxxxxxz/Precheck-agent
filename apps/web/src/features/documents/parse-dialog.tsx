import React, {useState} from 'react';
import {Alert, Modal} from 'antd';
import {api, newKey, queryClient} from '../../api.ts';
import type {CaseSummary} from '../cases/types.ts';
import type {Material} from '../materials/types.ts';
import {useCapabilities} from '../../capabilities.ts';
import {ErrorNotice, useRestoreFocus} from '../../ui.tsx';

export function ParseDialog({item: liveItem, material, close, done}: {item: CaseSummary; material: Material; close: () => void; done: () => void}) {
  useRestoreFocus();
  const [item] = useState(liveItem);
  const capabilities = useCapabilities();
  const firstParse=['parked','capability_disabled','configuration_required'].includes(material.parseStatus);
  const title=firstParse?'解析材料':'重新解析';
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<unknown>();
  const [key] = useState(newKey);
  const parse = async () => {
    if (!capabilities.data?.parsing) return;
    setPending(true);
    setError(undefined);
    try {
      await api(`/api/cases/${item.id}/documents/${material.id}/parse`, {method: 'POST', body: {reason: title,...(item.selectedRoundId&&item.selectedRoundId!=='legacy'?{roundId:item.selectedRoundId}:{}), expectedRevision: item.revision, idempotencyKey: key}});
      await Promise.all([queryClient.invalidateQueries({queryKey: ['materials', item.id]}), queryClient.invalidateQueries({queryKey: ['document-processing', item.id, material.id]})]);
      done();
    } catch (failure) {
      setError(failure);
    } finally {
      setPending(false);
    }
  };
  return <Modal title={title} open width={416} onCancel={pending ? undefined : close} closable={!pending} keyboard={!pending} mask={{closable: false}} destroyOnHidden okText="确认" cancelText="取消" confirmLoading={pending} cancelButtonProps={{disabled: pending}} onOk={() => void parse()}>
    {capabilities.data?.parsing ? undefined : <Alert className="notice" type="warning" showIcon title="材料解析暂未开放。"/>}
    <ErrorNotice error={error || capabilities.error}/>
    <p>{firstParse?'开始识别材料文字、分类并提取字段？':'是否确认重新解析该材料？'}</p>
  </Modal>;
}
