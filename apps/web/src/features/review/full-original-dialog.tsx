import React,{useEffect,useRef,useState} from 'react';
import {Button,Modal} from 'antd';
import {errorText} from '../../api.ts';
import {fullTextSummary} from '../documents/translation/full-text.ts';
import {translationReason} from '../documents/translation/presentation.ts';
import {EvidenceContent} from './evidence-content.tsx';
import {loadFullOriginal,type FullOriginalResult,type FullOriginalScope} from './full-original.ts';

interface Props extends FullOriginalScope {filename:string}
export function FullOriginalButton(props:Props){
  const [open,setOpen]=useState(false);
  const identity=JSON.stringify([props.caseId,props.source.documentVersionId,props.source.parseRevision,props.source.directoryRevision,props.referenceRoundId]);
  return <><Button type="text" size="small" className="field-full-original-button" aria-label={`查看全文：${props.filename}`} onClick={()=>setOpen(true)}>查看全文</Button>
    {open&&<FullOriginalDialog key={identity} {...props} close={()=>setOpen(false)}/>}</>;
}
function FullOriginalDialog(props:Props&{close:()=>void}){
  const [result,setResult]=useState<FullOriginalResult>();
  const [error,setError]=useState<unknown>();
  const [busy,setBusy]=useState<'load'|'export'>();
  const [downloaded,setDownloaded]=useState(false);
  const controller=useRef<AbortController|null>(null);
  const run=async(action:'load'|'export')=>{
    if(controller.current)return;
    const operation=new AbortController();controller.current=operation;
    setBusy(action);setError(undefined);setDownloaded(false);setResult(undefined);
    try{
      const fresh=await loadFullOriginal(props,operation.signal);
      operation.signal.throwIfAborted();setResult(fresh);
      if(action==='export'){
        if(fresh.translationError)throw new Error('译文读取失败，请重试后再导出。');
        const exporter=await import('../documents/translation/full-text-pdf.ts');
        const bytes=await exporter.fullTextPdf(props.filename,fresh.snapshot,operation.signal);
        operation.signal.throwIfAborted();
        const url=URL.createObjectURL(new Blob([bytes],{type:'application/pdf'}));
        const link=document.createElement('a');link.href=url;
        link.download=exporter.translationPdfFilename(props.filename,fullTextSummary(fresh.snapshot).missing>0);
        document.body.append(link);link.click();link.remove();
        setTimeout(()=>URL.revokeObjectURL(url),60_000);setDownloaded(true);
      }
    }catch(failure){if(!operation.signal.aborted)setError(failure);}
    finally{if(controller.current===operation){controller.current=null;setBusy(undefined);}}
  };
  useEffect(()=>{void run('load');return()=>{controller.current?.abort();controller.current=null;};},[]);
  const snapshot=result?.snapshot,summary=snapshot&&fullTextSummary(snapshot);
  return <Modal open title="原文全文" width={860} onCancel={props.close}
    classNames={{container:'evidence-full-original-container',header:'evidence-full-original-header',body:'evidence-full-original-body',footer:'evidence-full-original-footer'}}
    footer={<div className="evidence-full-original-actions"><Button onClick={props.close}>关闭</Button>
      <Button type="primary" disabled={!!busy||!summary?.total||!!result?.translationError} loading={busy==='export'} onClick={()=>void run('export')}>导出全文翻译 PDF</Button></div>}>
    <div className="evidence-full-original-meta"><strong>{props.filename}</strong><Button type="text" size="small" disabled={!!busy} onClick={()=>void run('load')}>重新读取</Button></div>
    <p className="evidence-full-original-note">以下为整份文件已识别的原文；图片、签章及未识别内容请结合原件核对。</p>
    {!!error&&<p role="alert">{errorText(error)}</p>}
    {busy&&<p role="status">{busy==='load'?'正在读取全文及已有译文…':'正在导出全文翻译 PDF…'}</p>}
    {!!result?.translationError&&<p role="alert">译文暂时无法读取，原文仍可查看。请重新读取后再导出。</p>}
    {summary&&!!summary.missing&&!result?.translationError&&<p className="evidence-full-original-note">还有 {summary.missing} 段未译，导出的 PDF 将保留未译标记及可用原文。</p>}
    {summary&&!summary.total&&<p>尚无已识别的原文，请打开原件核对。</p>}
    {snapshot&&!!snapshot.targets.items.length&&<div className="evidence-full-original-reading" role="region" aria-label="原文全文内容" tabIndex={0}>
      {snapshot.targets.items.map((target,index)=>{
        const pages=target.source.pageNumbers;
        const previous=snapshot.targets.items[index-1]?.source.pageNumbers;
        return <div className="evidence-full-original-passage" key={target.chunkId}>
          {!!pages.length&&JSON.stringify(pages)!==JSON.stringify(previous)&&<h3>第 {pages.join('、')} 页</h3>}
          {target.sourceText?<EvidenceContent text={target.sourceText}/>:<p className="evidence-full-original-note">此段原文未能完整读取。{target.reasonCodes.map(translationReason).join('；')}</p>}
        </div>;
      })}
    </div>}
    {downloaded&&<p role="status">全文翻译 PDF 已生成，下载已开始。</p>}
  </Modal>;
}
