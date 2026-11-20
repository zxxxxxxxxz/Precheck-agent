import React from 'react';
import {Alert, Button, Checkbox, Select} from 'antd';
import type {DocumentTranslationTarget} from '@hsbc/contracts/document-translation';
import {ErrorNotice, Loading} from '../../../ui.tsx';
import {formatTime} from '../../../shared/format.ts';
import {translationReason, translationRunning, translationStatus} from './presentation.ts';
import {useDocumentTranslation, type TranslationScope} from './use-document-translation.ts';
import './translation.css';

type Source = DocumentTranslationTarget['source'];
export interface TranslationPanelProps extends TranslationScope {locate: (source: Source) => void}
export function DocumentTranslationPanel(props: TranslationPanelProps) {
  // A new source scope owns fresh selection and in-flight transport state.
  return <TranslationPanel key={`${props.caseId}:${props.documentId}:${props.parseRevision}:${props.caseRevision}:${props.directoryRevision}`} {...props}/>;
}
function TranslationPanel(props: TranslationPanelProps) {
  const state = useDocumentTranslation(props);
  const {metadata, items, view, records, selection, pending, uncertain, canCreate} = state;
  const limit = metadata?.limits.chunksPerJob ?? 20;
  const available = items.filter(item => item.available);
  const ordered = [...items].sort((a, b) => Number(b.recommended) - Number(a.recommended));
  const error = state.error ?? state.targets.error ?? state.history.error ?? state.job.error;
  const sourceButton = (source: Source) => <Button type="link" className="link-button" disabled={!source.pageNumbers.length && !source.sourceNodeIds.length} onClick={() => props.locate(source)}>{source.sourceNodeIds.length ? '定位 Word 原文' : source.pageNumbers.length ? `定位原文 p${source.pageNumbers.join('、')}` : '暂无原文定位'}</Button>;
  return <section className="translation-panel evidence-panel" aria-label="中文参考翻译">
    <p className="translation-intro">中文参考译文，未经人工核对。请结合英文原文核对，不替代正式中文版材料。</p>
    <div className="translation-toolbar"><h3>英文段落</h3><Button size="small" loading={state.targets.isFetching && !state.targets.isFetchingNextPage} disabled={pending} onClick={() => void state.refresh()}>刷新翻译状态</Button></div>
    <ErrorNotice error={error} retry={() => void state.refresh()}/>
    {!state.coherent && <Alert type="warning" showIcon title="材料信息已更新，请刷新后重新选择段落。"/>}
    {metadata && !metadata.enabled && <Alert type="info" showIcon title="中文翻译暂未启用，可查看已有记录。"/>}
    {metadata?.enabled && (!props.writable || !metadata.canCreate) && <p className="tone-warning">当前材料版本或权限不允许发起翻译，可查看已有记录。</p>}
    {uncertain && <Alert type="warning" showIcon title="上次提交结果尚未确认。请重新查询，或核对同一次提交。" action={<Button loading={pending} onClick={() => void state.submit(undefined, uncertain)}>核对上次提交</Button>}/>}
    {state.targets.isPending ? <Loading/> : <>
      <div className="translation-toolbar">
        <span>已加载 {items.length} / {metadata?.total ?? 0} 段；已选 {selection.length} / {limit} 段</span>
        <Button size="small" disabled={!canCreate || !available.some(item => item.recommended)} onClick={() => state.setSelection(available.filter(item => item.recommended).slice(0, limit).map(item => item.chunkId))}>选择已加载的关键段落</Button>
      </div>
      {!!items.length && <p className="muted translation-hint">关键段落关联已识别字段，其余段落也可手动选择。每次最多 {limit} 段。</p>}
      {!items.length && metadata && <p>此识别记录尚无可供翻译的段落。</p>}
      <div className="translation-targets">{ordered.map((item, index) => <article className="translation-target" key={item.chunkId}>
        <div className="translation-toolbar"><Checkbox aria-label={`选择英文段落 ${index + 1}`} checked={selection.includes(item.chunkId)} disabled={!canCreate || !item.available || (!selection.includes(item.chunkId) && selection.length >= limit)} onChange={event => state.setSelection(event.target.checked ? [...selection, item.chunkId] : selection.filter(id => id !== item.chunkId))}>段落 {index + 1}{item.recommended ? ' · 关键段落' : ''}</Checkbox>{sourceButton(item.source)}</div>
        <details><summary>{item.sourceText ? '查看完整英文段落' : '原文暂不可用'}</summary>{item.sourceText && <p className="translation-text" lang="en">{item.sourceText}</p>}</details>
        {!!item.reasonCodes.length && <p className="tone-warning">{[...new Set(item.reasonCodes.map(translationReason))].join('；')}</p>}
        {!!item.sourceWarnings.length && <p className="muted">原文有识别或定位提示，请结合原件核对。</p>}
      </article>)}</div>
      {state.targets.hasNextPage && <Button block loading={state.targets.isFetchingNextPage} onClick={() => void state.targets.fetchNextPage()}>加载更多段落</Button>}
      <div className="translation-toolbar translation-submit"><Button type="primary" disabled={!canCreate || !selection.length} loading={pending && !view?.canCancel} onClick={() => void state.submit()}>生成中文参考译文</Button><Button disabled={!selection.length || pending || !!uncertain} onClick={() => state.setSelection([])}>清空选择</Button></div>
    </>}
    <div className="translation-toolbar"><h3>翻译记录</h3><span className="muted">最近 {records.length} 条</span></div>
    {!!records.length && <Select className="translation-history" aria-label="选择翻译记录" value={state.selectedJobId} onChange={state.setSelectedJobId} options={records.map(record => ({value: record.jobId, label: `${formatTime(record.createdAt)} · ${translationStatus[record.status]}`}))}/>}
    {state.reused && <p role="status">已打开相同段落的已有翻译记录。</p>}
    {state.history.isPending || (state.selectedJobId && state.job.isPending) ? <Loading/> : !view && !error ? <p className="muted">尚无翻译记录。选择英文段落后生成参考译文。</p> : null}
    {view && <>
      <div className="translation-toolbar"><span role="status" aria-live="polite">{translationStatus[view.status]} · {view.progress.completedSegments} / {view.progress.totalSegments} 段</span>
        {view.canCancel && <Button size="small" loading={pending} disabled={pending} onClick={() => void state.cancel()}>取消翻译</Button>}
        {view.canRetry && <Button size="small" disabled={!canCreate || pending} loading={pending} onClick={() => void state.submit(view)}>重试此任务</Button>}
      </div>
      {view.validity === 'stale' && <Alert type="warning" showIcon title="原文或案件依据已更新，此译文仅供历史回查。请在最新识别记录中重新选择段落。"/>}
      {view.errorCode && <Alert type="warning" showIcon title={translationReason(view.errorCode)}/>}
      {translationRunning(view.status) && <p className="muted">翻译完成后自动显示。离开页面后任务仍会继续。</p>}
      {view.items.map((segment, index) => <article className="translation-result" key={segment.chunkId}>
        <div className="translation-toolbar"><h4>段落 {index + 1}</h4>{view.parseRevision === props.parseRevision && sourceButton(segment.source)}</div>
        <div className="translation-pair"><div><h5>英文原文</h5><p className="translation-text" lang="en">{segment.sourceText}</p></div><div><h5>中文参考译文 · 未经人工核对</h5><p className="translation-text" lang="zh-CN">{segment.translatedText ?? '此段尚无可用译文，请核对英文原文。'}</p></div></div>
        {segment.status === 'needs_review' && <Alert type="warning" showIcon title="此段译文检查未通过，请核对原文。" description={segment.reasonCodes.map(translationReason).join('；')}/>}
        {!!segment.sourceWarnings.length && <p className="muted">原文有识别或定位提示，请结合原件核对。</p>}
        {segment.simulated && <p className="tone-warning">模拟译文，仅用于功能验证。</p>}
      </article>)}
    </>}
  </section>;
}
