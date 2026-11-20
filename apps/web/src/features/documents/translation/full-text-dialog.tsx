import React, {useEffect, useRef, useState} from 'react';
import {Alert, Button, Modal, Progress} from 'antd';
import {ApiError, isAccessLoss, newKey} from '../../../api.ts';
import {ErrorNotice} from '../../../ui.tsx';
import {translationApi, translationBase} from './api.ts';
import {FullTextError, FullTextTranslation, fullTextJob, fullTextRows, fullTextSummary, type FullTextScope, type FullTextSnapshot} from './full-text.ts';
import {translationReason, translationRunning} from './presentation.ts';
import './full-text.css';

interface Props extends FullTextScope {filename: string; writable: boolean}
function wait(signal: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    signal.throwIfAborted();
    const abort = () => {clearTimeout(timer); reject(signal.reason);};
    const timer = setTimeout(() => {signal.removeEventListener('abort', abort); resolve();}, 2000);
    signal.addEventListener('abort', abort, {once: true});
  });
}
export function FullTextTranslationButton(props: Props) {
  return <FullTextControl key={`${props.caseId}:${props.documentId}:${props.parseRevision}:${props.caseRevision}:${props.directoryRevision}`} {...props}/>;
}
function FullTextControl(props: Props) {
  // Keep progress when hidden. Unmounting only stops observation of the durable server task.
  const [open, setOpen] = useState<boolean>();
  return <>
    <Button className="reader-full-translation" onClick={() => setOpen(true)}>全文翻译</Button>
    {open !== undefined && <FullTextDialog {...props} open={open} close={() => setOpen(false)}/>}
  </>;
}
function FullTextDialog(props: Props & {open: boolean; close: () => void}) {
  const [snapshot, setSnapshot] = useState<FullTextSnapshot>();
  const [busy, setBusy] = useState<'load' | 'generate' | 'export'>();
  const [error, setError] = useState<unknown>();
  const [downloaded, setDownloaded] = useState(false);
  const controller = useRef<AbortController | null>(null);
  const [session] = useState(() => {
    const base = translationBase(props.caseId, props.documentId);
    return new FullTextTranslation(props, {
      targets: (offset, signal) => translationApi.targets(base, props.parseRevision, offset, signal),
      history: (chunks, signal) => translationApi.history(base, props.parseRevision, signal, chunks, 'selection'),
      fullTextHistory: signal => translationApi.history(base, props.parseRevision, signal, undefined, 'full_text'),
      get: (id, signal) => translationApi.get(base, id, signal),
      create: (command, signal) => translationApi.createFullText(base, command, signal), key: newKey, wait,
    });
  });
  const run = async (action: 'load' | 'generate' | 'export') => {
    if (controller.current) return;
    const operation = new AbortController(); controller.current = operation;
    setBusy(action); setError(undefined); setDownloaded(false);
    try {
      if (action === 'generate') await session.generate(operation.signal, value => {if (!operation.signal.aborted) setSnapshot(value);});
      else {
        const fresh = await session.load(operation.signal);
        operation.signal.throwIfAborted(); setSnapshot(fresh);
        if (action === 'load') {
          if (translationRunning(fullTextJob(fresh)?.status)) setBusy('generate');
          await session.watch(fresh, operation.signal, value => {if (!operation.signal.aborted) setSnapshot(value);});
        }
        if (action === 'export') {
          const exporter = await import('./full-text-pdf.ts');
          const bytes = await exporter.fullTextPdf(props.filename, fresh, operation.signal);
          operation.signal.throwIfAborted();
          const url = URL.createObjectURL(new Blob([bytes], {type: 'application/pdf'}));
          const link = document.createElement('a'); link.href = url;
          link.download = exporter.translationPdfFilename(props.filename, fullTextSummary(fresh).missing > 0);
          document.body.append(link); link.click(); link.remove();
          setTimeout(() => URL.revokeObjectURL(url), 60_000); setDownloaded(true);
        }
      }
    } catch (failure) {
      if (!operation.signal.aborted) {
        setError(failure instanceof FullTextError ? new ApiError(409, 'translation_full_text', failure.message)
          : failure instanceof ApiError && /^(translation_|document_translation_|stale_|qwen_)/.test(failure.code)
            ? new ApiError(failure.status, failure.code, translationReason(failure.code), failure.requestId) : failure);
        const preserveProgress = failure instanceof FullTextError && !failure.invalidatesSnapshot;
        if (!preserveProgress && (action !== 'generate' || isAccessLoss(failure) || failure instanceof FullTextError)) setSnapshot(undefined);
      }
    }
    finally {if (controller.current === operation) {controller.current = null; setBusy(undefined);}}
  };
  useEffect(() => {
    // Reopening a running task only reveals its progress; keep failures visible for an explicit retry.
    if (props.open && !controller.current && !error) void run('load');
  }, [props.open]);
  useEffect(() => () => {controller.current?.abort(); controller.current = null;}, []);
  const summary = snapshot && fullTextSummary(snapshot);
  const rows = snapshot ? fullTextRows(snapshot) : [];
  const task = snapshot && fullTextJob(snapshot);
  const canGenerate = props.writable && snapshot?.targets.canCreate && snapshot.targets.enabled && (!task || task.canRetry) && rows.some(row => row.missing && row.target.available);
  const percent = summary?.total ? Math.round((summary.translated + summary.original) * 100 / summary.total) : 0;
  return <Modal open={props.open} className="full-text-dialog" classNames={{body: 'full-text-body'}}
    title={<div className="full-text-title">全文翻译<span>中文参考译文</span></div>}
    width={780} onCancel={props.close} footer={<div className="full-text-actions">
    <Button className="full-text-close" onClick={props.close}>关闭</Button>
    <Button disabled={!!busy || !canGenerate} loading={busy === 'generate'} onClick={() => void run('generate')}>{busy === 'generate' ? '正在翻译' : summary?.translated ? '继续全文翻译' : '生成全文翻译'}</Button>
    <Button className="full-text-export" type="primary" disabled={!!busy || !summary?.total} loading={busy === 'export'} onClick={() => void run('export')}>{summary?.missing ? '导出 PDF（含未译标记）' : '导出 PDF'}</Button>
  </div>}>
    <div className="full-text-heading"><strong>{props.filename}</strong><Button type="link" disabled={!!busy} onClick={() => void run('load')}>刷新</Button></div>
    <p className="full-text-note">译文未经人工核对。导出包含全部已识别段落，未识别内容、图片及版式请结合原件核对。</p>
    <ErrorNotice error={error}/>
    {busy && <p className="full-text-operation" role="status" aria-live="polite">{busy === 'load' ? '正在读取全文及已有译文…' : busy === 'generate' ? translationRunning(task?.status) ? '正在后台翻译，关闭弹窗、刷新或离开页面后仍会继续。可随时回来查看进度。' : '正在提交全文翻译任务…' : '正在生成 PDF…'}</p>}
    {summary && <>
      <section className="full-text-summary" aria-label="翻译进度">
        <div className="full-text-summary-heading"><h3>译文覆盖进度</h3><span>{percent}%</span></div>
        <Progress aria-label="全文翻译覆盖进度" percent={percent} showInfo={false} strokeLinecap="butt" size="small" status="normal"/>
        <dl className="full-text-counts" role="status">
          <div><dt>全部段落</dt><dd>{summary.total}<span>段</span></dd></div>
          <div><dt>已翻译</dt><dd>{summary.translated}<span>段</span></dd></div>
          <div><dt>无英文，保留原文</dt><dd>{summary.original}<span>段</span></dd></div>
          <div><dt>未翻译</dt><dd>{summary.missing}<span>段</span></dd></div>
        </dl>
        {!!summary.missing && <p className="full-text-incomplete">全文翻译尚未完成，可继续生成或导出含未译标记的 PDF。无法自动翻译的段落将保留原文或缺失原因。</p>}
      </section>
      {!!summary.review && <Alert className="full-text-review-notice" type="warning" showIcon title={`${summary.review} 段译文需核对，PDF 中将保留提示。`}/>}
      {(!props.writable || !snapshot?.targets.canCreate || !snapshot.targets.enabled) && <p className="full-text-permission">当前材料版本或权限不允许生成译文，可导出已有结果。</p>}
      {!summary.total ? <div className="full-text-empty"><h3>暂无可翻译的段落</h3><p>尚无可供翻译或导出的原文段落。</p></div> : <section className="full-text-preview" aria-label="段落预览">
        <div className="full-text-preview-heading"><h3>段落预览</h3><span>按原文顺序排列</span></div>
        {rows.map((row, index) => <article key={row.target.chunkId} className={row.missing ? 'full-text-paragraph is-missing' : 'full-text-paragraph'}>
        <header className="full-text-paragraph-heading">
          <strong>段落 {index + 1}</strong>
          {row.target.source.pageNumbers.length > 0 && <span className="full-text-page">原文第 {row.target.source.pageNumbers.join('、')} 页</span>}
          <span className={`full-text-state${row.segment?.status === 'needs_review' ? ' needs-review' : ''}`}>{row.segment ? row.segment.status === 'needs_review' ? '需核对' : '已翻译' : row.original ? '保留原文' : '未翻译'}</span>
        </header>
        <p>{row.segment?.translatedText ?? (row.original ? row.target.sourceText : '尚无译文，导出时将保留未译标记。')}</p>
        {row.segment?.simulated && <span className="full-text-simulated tone-warning">模拟译文，仅用于功能验证</span>}
      </article>)}
      </section>}
    </>}
    {downloaded && <p className="full-text-operation" role="status">PDF 已生成，下载已开始。</p>}
  </Modal>;
}
