import React from 'react';
import {Alert, Button} from 'antd';
import {useQuery} from '@tanstack/react-query';
import {useSearchParams} from 'react-router';
import {api, ApiError} from './api.ts';
import {useCapabilities} from './capabilities.ts';
import {Blank, blocksView, ErrorNotice, Loading, RefreshNotice} from './ui.tsx';
import {SourceReader} from './source-reader.tsx';
import {MockReader} from './mock-reader.tsx';
import {documentViewAvailability, resolveDocumentView, validateSourceResponse} from './sourceDocument.ts';
import type {SourceDocumentResponse} from './sourceDocument.ts';
import type {Material} from './features/materials/types.ts';
import './source-reader.css';

/** The file toolbar and content share one scoped query and view selection. */
export function useDocumentView({caseId, material, parseRevision, base, isProcessing}: {caseId:string; material:Material; parseRevision?:string; base:string; isProcessing:boolean}) {
  const capabilities = useCapabilities();
  const [params,setParams] = useSearchParams();
  const docx = material.format === 'docx';
  const source = useQuery({queryKey:['document-source',caseId,material.id,parseRevision], enabled:docx && !!parseRevision, queryFn:async ({signal}) => validateSourceResponse(await api<SourceDocumentResponse>(`${base}/source?parseRevision=${encodeURIComponent(parseRevision!)}`,{signal}),parseRevision!,material.sha256), refetchInterval:isProcessing ? 2000 : false});
  const sourceData = blocksView(source) ? undefined : source.data;
  const availability = documentViewAvailability(docx,sourceData,capabilities.data);
  const canPreview = availability.preview;
  const requested = params.get('view');
  const view = resolveDocumentView(requested,docx,availability);
  const setView = (value:string,page?:number) => setParams(current => {const next = new URLSearchParams(current); if (value === 'preview') next.delete('view'); else next.set('view',value); if (value !== 'source') next.delete('sourceNode'); if (page) next.set('page',String(page)); return next;},{replace:true});
  const waitingForSource = isProcessing && source.error instanceof ApiError && source.error.code === 'source_structure_not_ready';
  return {docx, source, sourceData, availability, canPreview, view, setView, waitingForSource};
}
type DocumentViewState = ReturnType<typeof useDocumentView>;

/** PDF and Word expose the same parsing action; reading-view controls are hidden. */
export function DocumentViewMenu({onParse, parseDisabled, parseLabel='重新解析'}: {onParse?:()=>void; parseDisabled:boolean; parseLabel?:string}) {
  return onParse ? <Button onClick={onParse} disabled={parseDisabled}>{parseLabel}</Button> : null;
}

/** Failed DOCX conversion still exposes its source structure. */
export function DocumentViews({caseId, caseRevision, material, parseRevision, base, state, children, renderSource}: {caseId:string; caseRevision:number; material:Material; parseRevision:string; base:string; state:DocumentViewState; children:React.ReactNode; renderSource?:(reader:React.ReactNode)=>React.ReactNode}) {
  const {docx, source, sourceData, view, setView, waitingForSource} = state;
  return <>
    {view === 'mock' ? <MockReader key={parseRevision} base={base} documentId={material.id} parseRevision={parseRevision} sourceSha256={material.sha256}/> : view === 'source' ? source.isPending ? <Loading/> : waitingForSource ? <Blank title="正在读取源结构"/> : blocksView(source) ? <ErrorNotice error={source.error} retry={() => void source.refetch()}/> : sourceData ? <><RefreshNotice query={source} retry={() => void source.refetch()}/>{renderSource ? renderSource(<SourceReader caseId={caseId} caseRevision={caseRevision} documentId={material.id} data={sourceData} onPreview={page => setView('preview',page)}/>) : <SourceReader caseId={caseId} caseRevision={caseRevision} documentId={material.id} data={sourceData} onPreview={page => setView('preview',page)}/>}</> : <Blank title="源结构暂不可用"/> : <>{docx && sourceData?.preview?.manifest?.fonts.some(font => font.status !== 'available') && <Alert className="review-banner review-document-notice" type="warning" banner showIcon title="预览使用了替代或未确认字体，请结合源结构核对。" action={<Button type="link" size="small" onClick={() => setView('source')}>查看源结构</Button>}/>} {children}</>}
  </>;
}
