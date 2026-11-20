import React,{useEffect,useRef,useState} from 'react';
import {App,Button} from 'antd';
import type {MailDraft} from '@hsbc/contracts/review-delivery';
import {api} from '../../api.ts';

export function ChecklistExportButton({draft,onError}:{draft:MailDraft;onError:(error:unknown)=>void}) {
  const {message}=App.useApp(),[busy,setBusy]=useState(false),pending=useRef<AbortController|null>(null);
  useEffect(()=>()=>{pending.current?.abort();},[]);
  const download=async()=>{
    if(pending.current)return;
    const controller=new AbortController();pending.current=controller;setBusy(true);onError(undefined);
    try{
      const [fresh,exporter]=await Promise.all([
        api<MailDraft>(`/api/cases/${draft.caseId}/review-delivery/mail/${draft.id}`,{signal:controller.signal}),
        import('./checklist-export.ts'),
      ]);
      if(controller.signal.aborted)return;
      if(!fresh.canCopy||fresh.id!==draft.id||fresh.caseId!==draft.caseId||fresh.runId!==draft.runId)throw new Error('当前版本无法导出，请刷新页面后重试。');
      const bytes=exporter.reviewChecklistXlsx(fresh);
      const url=URL.createObjectURL(new Blob([bytes],{type:'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'}));
      const link=document.createElement('a');link.href=url;link.download=exporter.reviewChecklistFilename(fresh);
      document.body.append(link);link.click();link.remove();
      // Keep the Blob alive while the browser starts the download, then release it.
      window.setTimeout(()=>URL.revokeObjectURL(url),60_000);
      void message.success('Excel 清单已生成，包含问题、无误及待确认项');
    }catch(error){if(!controller.signal.aborted)onError(error);}
    finally{if(!controller.signal.aborted){pending.current=null;setBusy(false);}}
  };
  return <Button loading={busy} disabled={!draft.canCopy} onClick={()=>void download()} title="导出当前草稿全部检查项、结论和理由，按状态标色">导出 Excel 清单</Button>;
}
