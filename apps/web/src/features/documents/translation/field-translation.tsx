import React, {useEffect, useId, useRef, useState} from 'react';
import {Alert, Button} from 'antd';
import type {DocumentFieldObservation, DocumentSourceAnchor} from '@hsbc/contracts/documents';
import type {EvidenceAnchor} from '@hsbc/contracts/evidence';
import type {DocumentTranslationTarget} from '@hsbc/contracts/document-translation';
import {ErrorNotice, Loading} from '../../../ui.tsx';
import {fieldEvidenceMatcher, fieldTranslationBinding, fieldTranslationSegments, sameTranslationChunks, type FieldTranslationBinding} from './field-binding.ts';
import {translationReason, translationRunning, translationStatus} from './presentation.ts';
import {useDocumentTranslation, type TranslationScope} from './use-document-translation.ts';
import './field-translation.css';

interface Props extends TranslationScope {
  field: DocumentFieldObservation; anchors: readonly EvidenceAnchor[]; sourceAnchors: readonly DocumentSourceAnchor[];
  locate: (source: DocumentTranslationTarget['source']) => void;
}
export function FieldTranslation(props: Props) {
  const binding = fieldTranslationBinding(props.field);
  if (!binding) return null;
  return <BoundFieldTranslation key={JSON.stringify([props.caseId, props.documentId, props.parseRevision, props.caseRevision, props.directoryRevision, binding.fingerprint])} {...props} binding={binding}/>;
}
function BoundFieldTranslation(props: Props & {binding: FieldTranslationBinding}) {
  const [open, setOpen] = useState(false);
  const intent = useRef(false);
  const regionId = useId();
  const matcher = fieldEvidenceMatcher(props.binding, props.anchors, props.sourceAnchors);
  const state = useDocumentTranslation({...props, active: open && props.active}, matcher);
  const {items, metadata, view, pending, uncertain} = state;
  const chunks = items.map(item => item.chunkId);
  const complete = state.targetsComplete && matcher.complete(items);
  const withinLimit = chunks.length > 0 && chunks.length <= (metadata?.limits.chunksPerJob ?? 20);
  const available = complete && withinLimit && items.every(item => item.available);
  const error = state.error ?? state.targets.error ?? state.history.error ?? state.job.error;
  const loading = state.targets.isPending || state.targets.isFetching || (complete && withinLimit && (state.history.isPending || (!!state.selectedJobId && state.job.isPending)));
  const canGenerate = available && state.canCreate && !loading && !error;
  const exactJob = !!view && sameTranslationChunks(view, chunks);
  const segments = view ? fieldTranslationSegments(view, items) : [];
  // Only the user's explicit opening can create a task. Re-renders, polling and refresh never resubmit.
  useEffect(() => {
    if (!open || !intent.current || loading) return;
    intent.current = false;
    if (!view && !error && canGenerate) void state.submit(undefined, undefined, chunks);
  }, [open, loading, view, error, canGenerate, chunks.join('\n')]);
  const sourceButton = (source: DocumentTranslationTarget['source']) => <Button type="link" size="small" className="link-button" disabled={!source.pageNumbers.length && !source.sourceNodeIds.length} onClick={() => props.locate(source)}>定位原文</Button>;
  return <div className="field-translation" onClick={event => event.stopPropagation()}>
    <Button type="link" size="small" className="link-button" aria-label={`${open ? '收起' : '查看'}${props.field.fieldLabel}的中文翻译`} aria-expanded={open} aria-controls={regionId} onClick={() => {intent.current = !open; setOpen(!open);}}>{open ? '收起中文翻译' : '查看中文翻译'}</Button>
    {open && <section id={regionId} className="field-translation-content" aria-label={`${props.field.fieldLabel}的中文参考译文`}>
      <div className="field-translation-heading"><strong>中文参考译文</strong><Button type="link" size="small" className="link-button" disabled={pending} onClick={() => {intent.current = false; void state.refresh();}}>刷新</Button></div>
      <p className="field-translation-note">未经人工核对。译文对应此字段关联的完整原文段落。</p>
      <ErrorNotice error={error} retry={() => {intent.current = false; void state.refresh();}}/>
      {loading && !error && <Loading/>}
      {!loading && !error && <>
        {!state.coherent || !state.scopeCurrent ? <p role="status">材料信息已更新，请刷新页面后查看译文。</p>
          : !complete ? <p role="status">此字段缺少完整的原文段落定位，暂不能翻译。请先核对原文。</p>
          : !withinLimit ? <p role="status">此字段关联段落超过单次翻译上限，暂不能完整翻译。</p> : null}
        {items.filter(item => !item.available).map(item => <p className="tone-warning" key={item.chunkId}>{item.reasonCodes.map(translationReason).join('；')}</p>)}
        {!segments.length && items.some(item => item.sourceWarnings.includes('translation_context_incomplete')) && <p className="tone-warning">{translationReason('translation_context_incomplete')}</p>}
        {metadata && !metadata.enabled && <p>中文翻译暂未启用，可查看已有译文。</p>}
        {metadata?.enabled && (!props.writable || !metadata.canCreate) && <p>当前材料版本或权限不允许生成译文，可查看已有译文。</p>}
        {!view && !pending && <p className="muted">暂无此字段的翻译记录。</p>}
        {view && <>
          <p role="status" aria-live="polite">{translationStatus[view.status]}{translationRunning(view.status) ? '，完成后会自动显示。' : ''}</p>
          {view.validity === 'stale' && <Alert type="warning" showIcon title="原文或案件依据已更新，以下译文仅供历史回查。"/>}
          {view.errorCode && <Alert type="warning" showIcon title={translationReason(view.errorCode)}/>}
          {segments.map(segment => <div className="field-translation-segment" key={segment.chunkId}>
            {items.length > 1 && <strong>关联段落 {items.findIndex(item => item.chunkId === segment.chunkId) + 1}</strong>}
            <p lang="zh-CN" className="field-translation-text">{segment.translatedText ?? '此段尚无可用译文，请核对英文原文。'}</p>
            {segment.status === 'needs_review' && <Alert type="warning" showIcon title="此段译文需核对" description={segment.reasonCodes.map(translationReason).join('；')}/>}
            {segment.sourceWarnings.some(code => code !== 'translation_context_incomplete' && !/^(?:missing|ambiguous)_reference:.+/u.test(code) && code !== 'source_note_reference_unresolved') && <p className="tone-warning">原文有识别或定位提示，请结合原件核对。</p>}
            {segment.simulated && <p className="tone-warning">模拟译文，仅用于功能验证。</p>}
            <details><summary>查看对应英文原文</summary><p lang="en" className="field-translation-text">{segment.sourceText}</p>{sourceButton(segment.source)}</details>
          </div>)}
          {!translationRunning(view.status) && segments.length < items.length && <p className="tone-warning">部分关联段落尚无可用译文，请核对完整原文。</p>}
        </>}
      </>}
      {uncertain && <Alert type="warning" showIcon title="上次提交结果尚未确认。" action={<Button loading={pending} onClick={() => void state.submit(undefined, uncertain)}>核对上次提交</Button>}/>}
      <div className="field-translation-actions">
        {pending && <span role="status">正在提交翻译请求…</span>}
        {view?.canCancel && exactJob && <Button size="small" disabled={pending} onClick={() => void state.cancel()}>取消翻译</Button>}
        {view?.canRetry && exactJob && <Button size="small" disabled={!canGenerate} onClick={() => void state.submit(view)}>重试翻译</Button>}
        {(!view || view.validity === 'stale' || (!exactJob && !translationRunning(view.status) && view.errorCode !== 'translation_call_unknown' && segments.length < items.length)) && <Button size="small" disabled={!canGenerate} loading={pending} onClick={() => void state.submit(undefined, undefined, chunks)}>{view ? '生成当前段落译文' : '生成中文参考译文'}</Button>}
      </div>
    </section>}
  </div>;
}
