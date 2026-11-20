import {useAnnounceOpenDocument} from '../features/case-assistant/focus.ts';
import {SUPPLEMENTAL_MATERIAL_ID} from '@hsbc/contracts/case-supplement';
import {docxReadingNotice,extractionDeferredReason} from '../features/documents/processing-presentation.ts';
import {FullTextTranslationButton} from '../features/documents/translation/full-text-dialog.tsx';
import {ImageReader} from '../features/documents/image-reader.tsx';
import {ReaderPage,ReaderViewControls,type ReaderZoom} from '../features/documents/reader-page.tsx';
import {materialContentPath} from '../features/materials/navigation.ts';
import type {SignatureInformationProjection} from '@hsbc/contracts/signature-information';
import {signatureFileDateRows} from '../features/documents/signature-file-dates.ts';
import {waitingForDocumentArtifact} from '../features/documents/query-presentation.ts';
import {readerProcessingStatus,documentProcessingActive,documentParseAction} from '../features/documents/reader-processing-status.ts';
import {pageProcessingLabel,visibleProcessingGaps} from '../features/documents/processing-attention.ts';
import {ExtractionNotice,fieldExtractionNoticeDetail} from '../features/documents/extraction-notice.tsx';
import {authorizationFieldLayout} from '../features/documents/authorization-signatures.ts';
import {guaranteeSourceValue} from '@hsbc/contracts/document-presentation';
import {CORPORATE_DERIVED_FIELDS} from '@hsbc/contracts/corporate-requirements';
import '../features/documents/signature-details.css';
import {guaranteeFieldLayout} from '../features/documents/guarantee-field-layout.ts';
import {resolutionAuthorizationParagraphs, resolutionFieldLayout} from '../features/documents/resolution-field-layout.ts';
import '../features/documents/field-signatures.css';
import {FieldSignatureRecords} from '../features/documents/field-signatures.tsx';
import {SignatureInformationPanel} from '../features/documents/signature-information.tsx';
import {showsSignatureInformationPanel} from '../features/documents/signature-information-presentation.ts';
import {SignatureRegionOverlay} from '../features/documents/signature-region-overlay.tsx';
import type {SignatureBox} from '@hsbc/contracts/signature-review';
import {RecoveryNotice} from '../features/documents/recovery-notice.tsx';
import {useCaseReview} from './review-loop.tsx';
import {personalGuarantorGroups, guarantorDetailFields} from '../features/documents/personal-guarantor-groups.ts';
import {PersonalGuarantorFields, PersonalGuarantorRecords, type FieldCorrectionTarget} from '../features/documents/personal-guarantor-fields.tsx';
import {ReaderFieldCorrection} from '../features/documents/reader-field-correction.tsx';
import {deferredProcessingMessage} from '../features/documents/deferred-processing.ts';
import {PERSONAL_DERIVED_FIELDS} from '@hsbc/contracts/personal-requirements';
import {roundQuery} from '../features/review/round-controls.tsx';
import {ParseDialog} from '../features/documents/parse-dialog.tsx';
import {signatureRows, signatureVisualAnchors} from '../features/documents/signature-presentation.ts';
import {ocrMarkPagesForSource, ocrMarkSourceAnchorIds} from '../features/documents/ocr-mark-presentation.ts';
import {ConfigurationRequired} from '../features/documents/configuration-required.tsx';
import {fieldCandidateDisplayText} from '../features/documents/field-v2-presentation.ts';
import {type DocumentFieldPresentation} from '@hsbc/contracts/document-presentation';
import {FieldTableRecords} from '../features/documents/table-records.tsx';
import {documentFieldSections} from '../features/documents/field-sections.ts';
import {annualReturnFieldSections} from '../features/documents/annual-return-sections.ts';
import '../features/documents/field-sections.css';
import {InsuranceFields} from '../features/documents/insurance-fields.tsx';
import {InsurancePaymentEvidence} from '../features/documents/insurance-payment.tsx';
import {isInsuranceDocument,isSyntheticInsuranceField,insuranceSupportingFieldIds} from '../features/documents/insurance-presentation.ts';
import React, {useEffect, useRef, useState} from 'react';
import {createPortal} from 'react-dom';
import {Alert, Button, Drawer, Dropdown, Input, Progress, Segmented, Select, Space, Splitter, Table, Tag, Tooltip} from 'antd';
import type {TableProps} from 'antd';
import {useQuery} from '@tanstack/react-query';
import {Link, useSearchParams} from 'react-router';
import {api, ApiError, newKey, queryClient} from '../api.ts';
import {can} from '../features/identity/permissions.ts';
import {formatTime} from '../shared/format.ts';
import type {CaseSummary} from '../features/cases/types.ts';
import type {Material} from '../features/materials/types.ts';
import {ActionModal, Blank, blocksView, ErrorNotice, LinkButton, Loading, ReasonField, RefreshNotice, StatusTag, useRestoreFocus} from '../ui.tsx';
import {DirectoryDrawer, MaterialScopeNotice} from '../features/documents/material-type-confirmation.tsx';
import {documentMaterialScope} from '../features/documents/material-scope.ts';
import {meetingFieldRows, anchorsFor, diffLines, documentGaps, fieldOwnGaps, fieldDisplayText, fieldRowState, formatPages, granularityLabels, groupAnchorsByPage, localizationLabels, pageTransform, presentationFieldObservation, requiresFieldSemanticFilter, visibleDocumentFields} from '../features/documents/presentation.ts';
import type {ComparisonView, DirectoryResponse, DocumentRegion, EvidenceAnchor, FieldsResponse, LogicalDocument, PageSummary, ProcessingStatus, DocumentSourceAnchor, DocumentFieldObservation, DocumentPageArtifact, DocumentRetrievalResult, DocumentOcrMark, DocumentOcrMarkPage, SignaturesResponse, ToolJob} from '../features/documents/types.ts';
import {useCapabilities} from '../capabilities.ts';
import {shortVersion} from '../features/materials/presentation.ts';
import {usefulEvidenceAnchors, visibleEvidencePolygons} from '../readerEvidence.ts';
import {NavIcon} from '../brand.tsx';
import {SearchPanel} from '../evidence-search.tsx';
import {DocumentViewMenu, DocumentViews, useDocumentView} from '../document-views.tsx';
import {OcrRegionContent} from '../ocr-region-content.tsx';
import {defaultReaderLayout, readerLayout, readerLayoutKey, readerRatio, readerRatioKey, type ReaderLayout} from '../features/documents/reader-layout.ts';
import {processingNotes} from '../processing-notes.ts';
import {ProcessingNotesList} from '../processing-notes-view.tsx';
import '../ocr-region-content.css';
import './review.css';

const terminalJob = (status?: string) => !!status && ['ready', 'partial', 'completed', 'succeeded', 'failed', 'canceled', 'stale'].includes(status);
const runningStatus = (status?: string) => ['pending', 'queued', 'running', 'processing'].includes(status ?? '');
const directoryLabels = {candidate: '待确认', unknown: '类别未知', conflict: '分类冲突', confirmed: '已确认'};
const regionKinds = {signature: '签署候选', table: '表格', image: '图像', text: '文字', unknown: '未分类'};
const regionModes = [{value: 'evidence', label: '显示证据框'}, {value: 'hover', label: '悬停时显示'}, {value: 'off', label: '隐藏证据框'}];
type RegionMode = 'evidence' | 'hover' | 'off';

function GapList({gaps}: {gaps: readonly string[]}) {return <ProcessingNotesList notes={processingNotes([], gaps)} grouped={false} compact/>;}
function readSession<T>(key: string, fallback: T): T {try {const raw = sessionStorage.getItem(key); return raw === null ? fallback : JSON.parse(raw) as T;} catch {return fallback;}}
function writeSession(key: string, value: unknown) {try {sessionStorage.setItem(key, JSON.stringify(value));} catch {/* storage unavailable: preference lives in memory only */}}
function useSessionState<T>(key: string, fallback: T) {
  const [value, setValue] = useState<T>(() => readSession(key, fallback));
  return [value, (next: T) => {setValue(next); writeSession(key, next);}] as const;
}
function useMedia(query: string) {
  const [matches, setMatches] = useState(() => typeof window === 'undefined' ? true : window.matchMedia(query).matches);
  useEffect(() => {const media = window.matchMedia(query); const update = () => setMatches(media.matches); update(); media.addEventListener('change', update); return () => media.removeEventListener('change', update);}, [query]);
  return matches;
}
/** One locator per source page; the count is evidence records, not distinct occurrences. */
function SourceLinks({ids, anchors, sourceAnchors = [], onSelect}: {ids: string[]; anchors: EvidenceAnchor[]; sourceAnchors?: DocumentSourceAnchor[]; onSelect: (ids: string[], page?: number) => void}) {
  const [params] = useSearchParams();
  const sourceNodes = sourceAnchors.filter(anchor => ids.includes(anchor.anchor_id));
  const groups = groupAnchorsByPage(ids, anchors);
  if (!groups.length && !sourceNodes.length) return <span className="muted source-none">{ids.length ? '定位不可用' : '无定位'}</span>;
  return <span className="source-links">{sourceNodes.map((anchor,i) => {const next = new URLSearchParams(params); next.set('view','source'); next.set('sourceNode',anchor.sourceNodeId); return <Link key={anchor.anchor_id} to={`?${next}`} onClick={event => event.stopPropagation()} title={anchor.localization_status === 'ambiguous' ? '页面映射存在歧义，查看源结构' : '查看源结构定位'}>源{i + 1}</Link>;})}{groups.map(group => {const precision = group.ids.map(id => anchors.find(anchor => anchor.anchor_id === id)).filter(Boolean).map(anchor => `${localizationLabels[anchor!.localization_status]}（${granularityLabels[anchor!.granularity]}）`); return <Tooltip key={group.page} title={`第 ${group.page} 页，关联 ${group.ids.length} 条原文定位记录：${[...new Set(precision)].join('；')}`}><Button className="link-button" type="link" onClick={event => {event.stopPropagation(); onSelect(group.ids, group.page);}} aria-label={`定位第 ${group.page} 页来源`}>第 {group.page} 页</Button></Tooltip>;})}</span>;
}

export function Review({item}: {item: CaseSummary}) {
  const capabilities = useCapabilities();
  const [searchParams, setSearchParams] = useSearchParams();
  const materials = useQuery({queryKey: ['materials', item.id,item.selectedRoundId??'current'], queryFn: ({signal}) => api<{items: Material[]}>(`/api/cases/${item.id}/materials${roundQuery(item.selectedRoundId)}`, {signal}), refetchInterval: 15_000, enabled: capabilities.data?.documentReader === true});
  const readable = (blocksView(materials) ? undefined : materials.data)?.items.filter(material => can(material.allowed_actions, 'evidence:read')) ?? [];
  const selectedId = searchParams.get('document');
  // Without an explicit choice, open the first file that already has parse results.
  const material = readable.find(entry => entry.id === selectedId) ?? readable.find(entry => ['ready', 'succeeded', 'partial'].includes(entry.parseStatus)) ?? readable[0];
  const notice = (title: string) => <section className="panel review-notice"><Blank title={title}><Link to={`/cases/${item.id}/materials${item.selectedRoundId?`?round=${item.selectedRoundId}`:''}`}>查看材料与版本</Link></Blank></section>;
  if (capabilities.isPending) return <Loading/>;
  if (capabilities.error) return <ErrorNotice error={capabilities.error} retry={() => void capabilities.refetch()}/>;
  if (!capabilities.data?.documentReader) return notice('原件与证据阅读暂未开放');
  if (materials.isPending) return <Loading/>;
  if (blocksView(materials)) return <ErrorNotice error={materials.error} retry={() => void materials.refetch()}/>;
  if (selectedId && !readable.some(entry => entry.id === selectedId)) return notice('所引用的文件版本不存在或无读取权限，请回到材料列表核对');
  if (!material) return notice(materials.data?.items.length ? '当前账号没有原件读取权限' : '暂无可查看的材料');
  const onDocument=(id:string)=>{const next=new URLSearchParams({mode:'reader',document:id});const round=searchParams.get('round');if(round)next.set('round',round);setSearchParams(next);};
  return <DocumentReview key={`${item.id}:${material.id}`} item={item} material={material} materials={readable} onDocument={onDocument}/>;
}
function DocumentReview({item, material, materials, onDocument}: {item: CaseSummary; material: Material; materials: Material[]; onDocument: (id: string) => void}) {
  const capabilities = useCapabilities();
  useAnnounceOpenDocument(item.id, material.id, material.filename);
  const originalImage=material.format==='jpg'||material.format==='png';
  const base = `/api/cases/${encodeURIComponent(item.id)}/documents/${encodeURIComponent(material.id)}`;
  const [params, setParams] = useSearchParams();
  const historical = params.get('parse') || undefined;
  const setHistorical = (value?: string) => setParams(current => {const next = new URLSearchParams(current); if (value) next.set('parse', value); else next.delete('parse'); next.delete('page'); next.delete('sourceNode'); return next;}, {replace: true});
  const [parseOpen, setParseOpen] = useState(false);
  const [translationAction, setTranslationAction] = useState<HTMLSpanElement | null>(null);
  // 文件版本比较暂不开放；恢复时一并启用状态、工具栏入口和 CompareDrawer 挂载。
  // const [compareOpen, setCompareOpen] = useState(false);
  const processing = useQuery({queryKey: ['document-processing', item.id, material.id], queryFn: ({signal}) => api<ProcessingStatus>(`${base}/processing`, {signal}), refetchInterval: query => documentProcessingActive(query.state.data) ? 2000 : 15_000});
  const status = blocksView(processing) ? undefined : processing.data;
  const current = status?.parseRevision;
  // Pin the parse revision being read: a parse started elsewhere only raises a notice instead of replacing the page under the reviewer.
  const [pinned, setPinned] = useState<{rev?: string; follow: boolean}>({follow: true});
  useEffect(() => {if (current && (!pinned.rev || (pinned.follow && current !== pinned.rev))) setPinned({rev: current, follow: false});}, [current, pinned]);
  const viewed = historical ?? pinned.rev ?? current;
  const newer = !historical && !!pinned.rev && !!current && current !== pinned.rev;
  const isHistorical = (!!viewed && viewed !== current) || status?.status === 'stale';
  const documentView = useDocumentView({caseId:item.id, material, parseRevision:viewed, base, isProcessing:!isHistorical && runningStatus(status?.status)});
  const sourceFieldMetadata = useQuery({queryKey:['document-fields-source-mode',item.id,material.id,viewed],enabled:material.format==='docx'&&documentView.view==='source'&&!!viewed,queryFn:({signal})=>api<FieldsResponse>(`${base}/fields?parseRevision=${encodeURIComponent(viewed!)}`,{signal})});
  const visibleStatus = viewed && viewed !== current ? status?.history.find(entry => entry.parseRevision === viewed)?.status ?? status?.status : status?.status;
  useEffect(() => {if (terminalJob(status?.status)) {
    for (const name of ['document-pages', 'document-directory', 'document-fields', 'document-signatures', 'document-source']) void queryClient.invalidateQueries({queryKey: [name, item.id, material.id, current]});
    // What this file now says belongs on the case's check rows as well, without waiting for their next poll.
    for (const name of ['review-checklist', 'case-review']) void queryClient.invalidateQueries({queryKey: [name]});
  }}, [status?.status, item.id, material.id, current]);
  const canParse = capabilities.data?.parsing && status?.status !== 'configuration_required' && material.parseStatus !== 'configuration_required' && can(status?.allowed_actions ?? material.allowed_actions, 'document:parse');
  const versions = materials.map(entry => entry.ossVersionId);
  const latestRecord = status?.history.find(entry => entry.parseRevision === current);
  const historyOptions = status?.history?.length ? [{value: 'current', label: latestRecord ? `最新 · ${formatTime(latestRecord.createdAt)}` : '最新识别结果'}, ...status.history.filter(entry => entry.parseRevision !== current).map(entry => ({value: entry.parseRevision, label: `${formatTime(entry.createdAt)} · ${readerProcessingStatus({status: entry.status}).label}`}))] : undefined;
  const viewedEntry = status?.history.find(entry => entry.parseRevision === viewed);
  const readingNotice = !isHistorical ? docxReadingNotice(status) : null;
  return <section className="review" aria-label="原件与证据工作台">
    <h2 className="visually-hidden">原件与证据</h2>
    <div className="review-docbar">
      <label className="review-field"><span>文件</span><Select className="review-file" aria-label="选择材料固定版本" value={material.id} onChange={onDocument} popupMatchSelectWidth={false} options={materials.map(entry => ({value: entry.id, label: entry.filename, title: entry.filename}))} optionRender={option => {const entry = materials.find(candidate => candidate.id === option.value); return <span className="file-option"><span>{entry?.filename}</span><span className="mono muted">版本 {entry ? shortVersion(entry.ossVersionId, versions) : ''} · {entry ? formatTime(entry.createdAt) : ''}</span></span>;}}/></label>
      {historyOptions && <div className="review-field"><span>识别记录</span>{historyOptions.length > 1 ? <Select aria-label="选择识别记录" value={viewed && viewed !== current ? viewed : 'current'} popupMatchSelectWidth={false} style={{minWidth: 180}} onChange={value => {if (value === 'current') {setHistorical(undefined); setPinned({rev: current, follow: false});} else setHistorical(value);}} options={historyOptions}/> : <span className="review-record-time">{latestRecord ? formatTime(latestRecord.createdAt) : '最新识别结果'}</span>}</div>}
      <StatusTag view={readerProcessingStatus(isHistorical ? {status: visibleStatus ?? material.parseStatus} : status ?? {status: material.parseStatus}, processing.error)}/>
      {!isHistorical && status?.progress && runningStatus(status.status) && <span className="review-progress" role="status">已处理 {status.progress.completedPages} / {status.progress.totalPages || '待确认'} 页<Progress size="small" percent={status.progress.totalPages ? Math.floor(status.progress.completedPages / status.progress.totalPages * 100) : 0} showInfo={false} aria-label="材料解析进度"/></span>}
      <span className="mono muted review-version" title={material.ossVersionId}>版本 {shortVersion(material.ossVersionId, versions)}</span>
      <div className="review-docbar-actions">
        <Button href={materialContentPath(item.id,material.id,true)} download={material.filename}>下载原件</Button>
        <span className="review-translation-action" ref={setTranslationAction}/>
        {capabilities.data?.reviewLoop && can(item.allowed_actions, 'case:read') && <LinkButton type="primary" to={`/cases/${item.id}/review?mode=business&document=${encodeURIComponent(material.id)}${item.selectedRoundId?`&round=${item.selectedRoundId}`:''}`}>信息核对</LinkButton>}
        {/* {capabilities.data?.versionComparison && <Button onClick={() => setCompareOpen(true)} disabled={materials.length < 2 || !viewed}>比较文件版本</Button>} */}
        {viewed ? <DocumentViewMenu onParse={canParse ? () => setParseOpen(true) : undefined} parseDisabled={documentProcessingActive(status)} parseLabel={documentParseAction(status)}/> : canParse && <Button onClick={() => setParseOpen(true)} disabled={documentProcessingActive(status)}>{documentParseAction(status)}</Button>}
      </div>
    </div>
    {newer && <Alert className="review-banner" type="info" banner showIcon title="有新的解析结果。当前仍显示打开时的解析记录。" action={<Button onClick={() => setPinned({rev: current, follow: false})}>切换到最新</Button>}/>}
    {historical && historical !== current && <Alert className="review-banner" type="warning" banner showIcon title={`正在回查历史识别结果${viewedEntry ? `（${formatTime(viewedEntry.createdAt)}）` : ''}，仅供核对，不能更正目录。`} action={<Button onClick={() => {setHistorical(undefined); setPinned({rev: current, follow: false});}}>回到最新识别</Button>}/>}
    {!historical && status?.status === 'stale' && <Alert className="review-banner" type="warning" banner showIcon title="本次识别结果已失效，仅供回查。"/>}
    {!isHistorical&&status&&<RecoveryNotice key={`recovery:${status.parseRevision}:${status.status}`} status={status}/>}
    <div className="review-notices">{blocksView(processing) ? <ErrorNotice error={processing.error} retry={() => void processing.refetch()}/> : <RefreshNotice query={processing} retry={() => void processing.refetch()}/>}</div>
    {readingNotice ? <Alert className="review-banner review-document-notice" type="info" banner showIcon title={readingNotice}/> : !blocksView(sourceFieldMetadata)&&sourceFieldMetadata.data?.sourceOnly==='docx'&&documentView.view==='source'&&<Alert className="review-banner review-document-notice" type="info" banner showIcon title="当前识别记录尚无自动提取结果。请按原文核对字段。"/>}
    {originalImage&&!viewed&&status?.status==='configuration_required'&&<div className="review-status"><ConfigurationRequired item={item}/></div>}
    {originalImage&&!viewed&&!blocksView(processing)?<ImageReader caseId={item.id} material={material}/>:processing.isPending ? <Loading/> : status && (viewed ? <DocumentViews key={viewed} caseId={item.id} caseRevision={item.revision} material={material} base={base} parseRevision={viewed} state={documentView} renderSource={reader=><ParsedDocument translationAction={translationAction} item={item} material={material} materials={materials} base={base} parseRevision={viewed} isHistorical={isHistorical} actions={status.allowed_actions ?? []} isProcessing={!isHistorical && runningStatus(status.status)} isFailed={!isHistorical&&status.status==='failed'} sourceContent={reader}/>}><ParsedDocument translationAction={translationAction} item={item} material={material} materials={materials} base={base} parseRevision={viewed} isHistorical={isHistorical} actions={status.allowed_actions ?? []} isProcessing={!isHistorical && runningStatus(status.status)} isFailed={!isHistorical&&status.status==='failed'}/></DocumentViews> : <div className="review-status">{deferredProcessingMessage(status.errorCode) ? <Blank title={deferredProcessingMessage(status.errorCode)!}/> : status.status === 'configuration_required' ? <ConfigurationRequired item={item}/> : <Blank title={status.status === 'failed' ? '材料解析未完成' : documentProcessingActive(status) ? (['pending','queued'].includes(status.status)?'材料已排队，将自动识别、分类并提取字段':'正在识别、分类并提取字段') : status.status==='capability_disabled' ? extractionDeferredReason(status.errorCode) ?? '自动解析尚未启动，请查看材料处理记录' : '尚无解析结果，可点击解析材料开始'}/>}</div>)}
    {parseOpen && canParse && <ParseDialog item={item} material={material} close={() => setParseOpen(false)} done={() => {setParseOpen(false); setHistorical(undefined); setPinned(current0 => ({rev: current0.rev, follow: true})); void processing.refetch();}}/>}
    {/* {compareOpen && capabilities.data?.versionComparison && viewed && <CompareDrawer item={item} material={material} materials={materials} parseRevision={viewed} close={() => setCompareOpen(false)}/>} */}
  </section>;
}
function ParsedDocument({item, material, materials, base, parseRevision, isHistorical, actions, isProcessing, isFailed, sourceContent, translationAction}: {translationAction: HTMLSpanElement | null; item: CaseSummary; material: Material; materials: Material[]; base: string; parseRevision: string; isHistorical: boolean; actions: string[]; isProcessing: boolean; isFailed: boolean; sourceContent?:React.ReactNode}) {
  const review = useCaseReview(item);
  const capabilities = useCapabilities();
  const pageKind = material.format === 'docx' ? '预览' : '原件';
  const suffix = `?parseRevision=${encodeURIComponent(parseRevision)}`;
  const [params, setParams] = useSearchParams();
  const [pageNumber, setPageNumber] = useState(() => {const value = Number(params.get('page')); return Number.isSafeInteger(value) && value > 0 ? value : 1;});
  const [pageDraft, setPageDraft] = useState(String(pageNumber));
  const [rotation, setRotation] = useState(0);
  const [zoom, setZoom] = useState<ReaderZoom>(100);
  const [regionMode, setRegionMode] = useState<RegionMode>('evidence');
  const [directoryVisible, setDirectoryVisible] = useState(false);
  const [evidenceVisible, setEvidenceVisible] = useSessionState('ui.review.evidence', true);
  const [storedLayout, storeLayout] = useSessionState<ReaderLayout>(readerLayoutKey, defaultReaderLayout);
  const sizes = readerLayout(storedLayout);
  const setSizes = (next: ReaderLayout) => storeLayout(readerLayout(next));
  const [liveRatio, setLiveRatio] = useState<number>();
  const [liveDirectory, setLiveDirectory] = useState<number>();
  const resetSplit = () => {setSizes({...sizes, canvasRatio: 0.5}); setLiveRatio(undefined);};
  const splitRef = useRef<HTMLDivElement>(null);
  const [leftView, setLeftView] = useState<'directory' | 'pages'>('directory');
  const [selectedAnchors, setSelectedAnchors] = useState<string[]>([]);
  const [signatureRegion,setSignatureRegion]=useState<{page:number;box?:SignatureBox|null;done?:((box:SignatureBox)=>void)}>();
  useEffect(()=>setSignatureRegion(undefined),[material.id,parseRevision]);
  const routeAnchor = params.get('anchor');
  const locatedRouteAnchor = useRef<string | undefined>(undefined);
  const [anchorCursor, setAnchorCursor] = useState(0);
  const [scrollTarget, setScrollTarget] = useState<string>();
  const [noteTarget, setNoteTarget] = useState<{page: number; codes: readonly string[]}>();
  const [selectedRegion, setSelectedRegion] = useState<string>();
  const [focusRegion, setFocusRegion] = useState(0);
  const [activeLogical, setActiveLogical] = useState<string>();
  const [fieldFilter, setFieldFilter] = useState<'all' | 'attention' | 'missing'>('all');
  const [paymentOpen,setPaymentOpen]=useState(false);
  const [correction, setCorrection] = useState<FieldCorrectionTarget>();
  const [ocrMarkTarget, setOcrMarkTarget] = useState<{page: DocumentOcrMarkPage; mark?: DocumentOcrMark}>();
  // Signature links focus applicable fields; the separate panel is material-specific.
  const signatureLink = params.get('panel') === 'signatures' || !!params.get('signatureRecord');
  const [directoryOpen, setDirectoryOpen] = useState(false);
  const [imageFailed, setImageFailed] = useState(false);
  const canvasRef = useRef<HTMLDivElement>(null);
  const evidenceRef = useRef<HTMLDivElement>(null);
  const directoryRef = useRef<HTMLElement>(null);
  const focusSignatureFields = () => {setEvidenceVisible(true);setFieldFilter('all');requestAnimationFrame(()=>evidenceRef.current?.querySelector<HTMLElement>(params.get('signatureRecord')?'#signature-field-records':'[data-signature-field], #signature-field-records')?.scrollIntoView({block:'nearest'}));};
  const directoryTrigger = useRef<HTMLButtonElement>(null);
  const toggleDirectory = (open: boolean) => {setDirectoryVisible(open); requestAnimationFrame(() => {if (open) directoryRef.current?.querySelector<HTMLButtonElement>('[aria-label="收起目录"]')?.focus(); else directoryTrigger.current?.focus();});};
  const wide = useMedia('(min-width: 1000px)');
  useEffect(() => {
    const separator = splitRef.current?.querySelector<HTMLElement>('[role="separator"]');
    if (!separator) return;
    separator.tabIndex = 0;
    separator.setAttribute('aria-label', '调整原件与证据比例，左右方向键调整，回车恢复等分');
  }, [wide, evidenceVisible, directoryVisible]);
  const pages = useQuery({queryKey: ['document-pages', item.id, material.id, parseRevision], queryFn: ({signal}) => api<{items: PageSummary[]; totalPages?: number}>(`${base}/pages${suffix}`, {signal}), refetchInterval: isProcessing ? 2000 : false});
  const directory = useQuery({queryKey: ['document-directory', item.id, material.id, parseRevision], queryFn: ({signal}) => api<DirectoryResponse>(`${base}/directory${suffix}`, {signal}), enabled: capabilities.data?.logicalDirectory === true, refetchInterval: isProcessing ? 2000 : false});
  const fields = useQuery({queryKey: ['document-fields', item.id, material.id, parseRevision, directory.data?.revision], queryFn: ({signal}) => api<FieldsResponse>(`${base}/fields${suffix}`, {signal}), refetchInterval: query => isProcessing || runningStatus(query.state.data?.filterJob?.status) ? 2000 : false});
  const signatures = useQuery({queryKey: ['document-signatures', item.id, material.id, parseRevision, directory.data?.revision], queryFn: ({signal}) => api<SignaturesResponse>(`${base}/signatures${suffix}`, {signal}), refetchInterval: query => isProcessing || runningStatus(query.state.data?.review?.status) ? 2000 : false});
  const pageItems = blocksView(pages) ? [] : pages.data?.items ?? [];
  const page = useQuery({queryKey: ['document-page', item.id, material.id, parseRevision, pageNumber], queryFn: ({signal}) => api<DocumentPageArtifact>(`${base}/pages/${pageNumber}${suffix}`, {signal}), enabled: pageItems.some(entry => entry.pageNumber === pageNumber)});
  const pageData = blocksView(page) ? undefined : page.data;
  const directoryData = blocksView(directory) ? undefined : directory.data;
  const fieldData = blocksView(fields) ? undefined : fields.data;
  const fieldsWaiting = waitingForDocumentArtifact(fields, isProcessing);
  const requestedDirectory = params.get('directory');
  const directoryMismatch = !!requestedDirectory && !!fieldData && String(fieldData.directoryRevision) !== requestedDirectory;
  const signatureData = blocksView(signatures) ? undefined : signatures.data;
  useEffect(()=>{if(signatureLink&&!fields.isPending)focusSignatureFields();},[signatureLink,fields.isPending,parseRevision,params.get('signatureRecord')]);
  const ocrMarkPages = ocrMarkPagesForSource(signatureData?.ocrMarkPages, material.id, parseRevision, material.sha256);
  const totalPages = Math.max(1, ...pageItems.map(entry => entry.pageNumber));
  useEffect(() => {if(sourceContent)return;setImageFailed(false); setSelectedRegion(undefined); setFocusRegion(0); setPageDraft(String(pageNumber)); setParams(current => {const next = new URLSearchParams(current); next.set('page', String(pageNumber)); return next;}, {replace: true});}, [pageNumber]);
  useEffect(() => {const first = pageItems[0]?.pageNumber; if (first && !pageItems.some(entry => entry.pageNumber === pageNumber)) setPageNumber(first);}, [pages.data, pageNumber]);
  const allSourceAnchors = (fieldData?.sourceAnchors ?? []).filter(anchor => anchor.document_version_id === material.id && anchor.parse_revision === parseRevision);
  const allAnchors = [...new Map([...(fieldData?.anchors ?? []), ...(signatureData?.anchors ?? []), ...(pageData?.anchors ?? []), ...(pageData ? signatureVisualAnchors(signatureData?.review?.observations ?? [], pageData.page) : [])].map(anchor => [anchor.anchor_id, anchor])).values()].filter(anchor => anchor.document_version_id === material.id && anchor.parse_revision === parseRevision);
  const selected = anchorsFor(selectedAnchors, allAnchors, material.id, parseRevision).sort((a, b) => a.page_number - b.page_number);
  const materialScope = documentMaterialScope(fieldData, directoryData?.revision, directoryData?.directory);
  const materialScopePending = !!materialScope && materialScope.status !== 'resolved';
  const signatureRecordId=params.get('signatureRecord')??undefined;
  const signatureInformation=useQuery({queryKey:['signature-information',item.id,base,parseRevision,signatureRecordId],
    enabled:!!parseRevision&&materialScope?.status==='resolved'&&showsSignatureInformationPanel(materialScope.taxonomyId),
    queryFn:({signal})=>api<SignatureInformationProjection>(`${base}/signatures/information?parseRevision=${parseRevision}${signatureRecordId?`&recordId=${signatureRecordId}`:''}`,{signal})});
  const effectiveFields = visibleDocumentFields(fieldData, directoryData?.revision, directoryData?.directory).filter(field=>!isSyntheticInsuranceField(field.fieldId)).map(field => presentationFieldObservation(field, requiresFieldSemanticFilter(field.fieldId, fieldData)));
  const usefulAnchors = pageData ? usefulEvidenceAnchors({documentId: material.id, parseRevision, pageAssetId: pageData.page.page_asset_id, pageNumber}, allAnchors, effectiveFields, [], [...selectedAnchors, ...(signatureData?.review?.observations ?? []).filter(value => value.pageNumber === pageNumber).flatMap(value => value.anchorIds)]) : [];
  const fieldSourceIds = new Set(pageData ? usefulEvidenceAnchors({documentId: material.id, parseRevision, pageAssetId: pageData.page.page_asset_id, pageNumber}, allAnchors, effectiveFields, [], []).map(anchor => anchor.anchor_id) : []);
  // Signature context may include a footer: only explicit signature geometry is outlined until its source is selected.
  const usefulRegionIds = new Set(usefulAnchors.filter(anchor => fieldSourceIds.has(anchor.anchor_id) || selectedAnchors.includes(anchor.anchor_id) || anchor.block_ids.some(id => pageData?.regions.some(region => region.region_id === id && region.kind === 'signature'))).flatMap(anchor => anchor.block_ids));
  const cursorAnchor = selected[Math.min(anchorCursor, selected.length - 1)];
  const currentRegion = pageData?.regions.find(region => region.region_id === selectedRegion);
  const selectEvidence = (ids: string[], number?: number) => {
    setSignatureRegion(undefined);
    setOcrMarkTarget(undefined);
    setNoteTarget(undefined);
    const roots = anchorsFor(ids, allAnchors, material.id, parseRevision);
    const source = allSourceAnchors.find(anchor => ids.includes(anchor.anchor_id));
    if (!roots.length && source) {setParams(current => {const next = new URLSearchParams(current); next.set('view','source'); next.set('sourceNode',source.sourceNodeId); return next;}, {replace:true}); return;}
    const expandedIds = [...new Set([...ids, ...roots.flatMap(root => usefulEvidenceAnchors({documentId: material.id, parseRevision, pageAssetId: root.page_asset_id, pageNumber: root.page_number}, allAnchors, [], [], [root.anchor_id]).map(anchor => anchor.anchor_id))])];
    setSelectedAnchors(expandedIds); setSelectedRegion(undefined); setRegionMode('evidence');
    const sources = anchorsFor(expandedIds, allAnchors, material.id, parseRevision).sort((a, b) => a.page_number - b.page_number);
    const onPage = sources.filter(anchor => !number || anchor.page_number === number);
    const first = onPage.find(anchor => {const asset = pageItems.find(entry => entry.pageNumber === anchor.page_number); return asset && visibleEvidencePolygons(anchor.polygons, asset.width, asset.height).length > 0;}) ?? onPage[0];
    setAnchorCursor(Math.max(0, sources.indexOf(first)));
    const target = number ?? first?.page_number;
    if (target) setPageNumber(target);
    setScrollTarget(first?.anchor_id);
  };
  useEffect(() => {
    if (directoryMismatch) {setSelectedAnchors([]);setSelectedRegion(undefined);setScrollTarget(undefined);return;}
    if (!routeAnchor) {locatedRouteAnchor.current = undefined; return;}
    if(requestedDirectory&&!fieldData)return;
    const key = `${material.id}:${parseRevision}:${routeAnchor}`;
    if (locatedRouteAnchor.current === key) return;
    const anchor = allAnchors.find(value => value.anchor_id === routeAnchor && value.document_version_id === material.id && value.parse_revision === parseRevision);
    if (!anchor) return;
    locatedRouteAnchor.current = key;
    selectEvidence([anchor.anchor_id], anchor.page_number);
  }, [routeAnchor, requestedDirectory, directoryMismatch, material.id, parseRevision, fieldData, pageData]);
  // Resolve a note only against the loaded page of this document and parse revision.
  useEffect(() => {
    if (!noteTarget || !pageData || noteTarget.page !== pageNumber || pageData.page.page_number !== pageNumber || pageData.scope.documentVersionId !== material.id || pageData.scope.parseRevision !== parseRevision) return;
    const regionIds = new Set(pageData.regions.filter(region => region.coverage_gaps.some(code => noteTarget.codes.includes(code))).map(region => region.region_id));
    const ids = pageData.anchors.filter(anchor => anchor.document_version_id === material.id && anchor.parse_revision === parseRevision && anchor.page_asset_id === pageData.page.page_asset_id && anchor.block_ids.some(id => regionIds.has(id))).map(anchor => anchor.anchor_id);
    if (ids.length) selectEvidence(ids, pageNumber);
    else {setSelectedAnchors([]); setSelectedRegion(undefined); canvasRef.current?.scrollTo({top: 0, left: 0}); if (!wide) canvasRef.current?.closest('.review-canvas-stage')?.scrollIntoView({block: 'start'});}
    setNoteTarget(undefined);
  }, [noteTarget, pageData, pageNumber, material.id, parseRevision]);
  const selectOcrMark = (layer: DocumentOcrMarkPage, mark?: DocumentOcrMark) => {
    if (!ocrMarkPages?.includes(layer) || !pageItems.some(page => page.pageNumber === layer.pageNumber)) return;
    setNoteTarget(undefined); setSelectedAnchors([]); setSelectedRegion(undefined); setScrollTarget(undefined); setRegionMode('evidence');
    setOcrMarkTarget({page: layer, mark}); setPageNumber(layer.pageNumber);
  };
  useEffect(() => {
    if (!ocrMarkTarget) return;
    if (pageNumber !== ocrMarkTarget.page.pageNumber) {setOcrMarkTarget(undefined); return;}
    if (!pageData || pageData.page.page_number !== ocrMarkTarget.page.pageNumber) return;
    const ids = ocrMarkTarget.mark ? ocrMarkSourceAnchorIds(ocrMarkTarget.page, ocrMarkTarget.mark, pageData, allAnchors) : [];
    if (ids.length) selectEvidence(ids, pageNumber);
    else {setSelectedAnchors([]); setSelectedRegion(undefined); canvasRef.current?.scrollTo({top: 0, left: 0}); if (!wide) canvasRef.current?.closest('.review-canvas-stage')?.scrollIntoView({block: 'start'});}
    setOcrMarkTarget(undefined);
  }, [ocrMarkTarget, pageData, pageNumber]);
  const regionFields = currentRegion ? effectiveFields.filter(field => field.anchorIds.some(id => allAnchors.find(anchor => anchor.anchor_id === id)?.block_ids.includes(currentRegion.region_id))) : [];
  const selectRegion = (region: DocumentRegion) => {
    setSignatureRegion(undefined);
    setOcrMarkTarget(undefined);
    setSelectedRegion(region.region_id);
    setSelectedAnchors(usefulAnchors.filter(anchor => anchor.block_ids.includes(region.region_id)).map(anchor => anchor.anchor_id));
    if (region.kind === 'signature' || region.kind === 'image') {focusSignatureFields(); return;}
    requestAnimationFrame(() => {
      const pane = evidenceRef.current?.querySelector<HTMLElement>('.review-evidence-body');
      if (wide && pane) pane.scrollTop = 0;
      else evidenceRef.current?.querySelector('.region-card')?.scrollIntoView({block: 'nearest'});
    });
  };
  // Bring the selected source into view on the page: measured from the rendered polygon, not recomputed from coordinates.
  useEffect(() => {
    if (!scrollTarget) return;
    const element = canvasRef.current?.querySelector(`[data-anchor-id="${CSS.escape(scrollTarget)}"]`);
    if (element && canvasRef.current) {
      const pane = canvasRef.current, target = element.getBoundingClientRect(), frame = pane.getBoundingClientRect();
      pane.scrollTop += target.top - frame.top + target.height / 2 - pane.clientHeight / 2;
      pane.scrollLeft += target.left - frame.left + target.width / 2 - pane.clientWidth / 2;
      if (!wide) pane.closest('.review-canvas-stage')?.scrollIntoView({block: 'start'});
      setScrollTarget(undefined);
    }
    else if (pageData?.anchors.some(anchor => anchor.anchor_id === scrollTarget) && !visibleEvidencePolygons(allAnchors.find(anchor => anchor.anchor_id === scrollTarget)?.polygons ?? [], pageData.page.width, pageData.page.height).length) {canvasRef.current?.scrollTo({top: 0, left: 0}); if (!wide) canvasRef.current?.closest('.review-canvas-stage')?.scrollIntoView({block: 'start'}); setScrollTarget(undefined);}
  }, [scrollTarget, pageData, zoom, rotation, regionMode, wide]);
  useEffect(() => {
    if (!signatureRegion?.box || signatureRegion.done || signatureRegion.page !== pageNumber || pageData?.page.page_number !== pageNumber) return;
    const pane = canvasRef.current, element = pane?.querySelector('[data-signature-region]');
    if (!pane || !element) return;
    const target = element.getBoundingClientRect(), frame = pane.getBoundingClientRect();
    pane.scrollTop += target.top - frame.top + target.height / 2 - pane.clientHeight / 2;
    pane.scrollLeft += target.left - frame.left + target.width / 2 - pane.clientWidth / 2;
    if (!wide) pane.closest('.review-canvas-stage')?.scrollIntoView({block: 'start'});
  }, [signatureRegion, pageNumber, pageData, zoom, rotation, wide]);
  const transforms = pageData ? pageTransform(pageData.page.width, pageData.page.height, rotation) : undefined;
  const refresh = async () => {await Promise.all([directory.refetch(), fields.refetch(), signatures.refetch()]); setSelectedAnchors([]); setSelectedRegion(undefined);};
  // Navigation groups never replace persisted logical IDs used by corrections and evidence.
  const logicalDocuments = (directoryData?.directoryDisplayPolicy === 'explicit-title-boundaries-v1' ? directoryData.directoryDisplay : undefined) ?? directoryData?.directory ?? [];
  const activeDocument = logicalDocuments.find(entry => entry.id === activeLogical && entry.pageNumbers.includes(pageNumber)) ?? logicalDocuments.find(entry => entry.pageNumbers.includes(pageNumber));
  const arrangedFields= authorizationFieldLayout(resolutionFieldLayout(guaranteeFieldLayout(effectiveFields)),!signatureRecordId&&materialScope?.status==='resolved'?materialScope.taxonomyId:null).filter(field=>!['pg_yes','cgt_rm_option','cgt_rm_valid_option'].includes(field.fieldId));
  const fileDates=signatureFileDateRows(arrangedFields,!signatureRecordId&&!blocksView(signatureInformation)?signatureInformation.data:undefined,
    !directoryMismatch&&fieldData&&materialScope?.status==='resolved'?{documentId:material.id,parseRevision,sha256:material.sha256,directoryRevision:fieldData.directoryRevision,materialType:materialScope.taxonomyId}:undefined);
  const fieldViews = [...arrangedFields,...fileDates.map(row=>row.field)].map(field => {
    const first = field.candidates.length === 1 ? field.candidates[0] : undefined;
    return {field, primaryIds: first?.anchorIds.length ? first.anchorIds : field.anchorIds, primaryPage: first?.pageNumbers[0] ?? field.pageNumbers[0]};
  });
  const sharedGaps = documentGaps(pageItems, fieldViews.map(view => view.field), fieldData?.coverageGaps);
  const notes = processingNotes(pageItems, [...sharedGaps, ...(fieldData?.coverageGaps ?? [])]);
  const makeFieldRow = (field:DocumentFieldPresentation) => {
    const first=field.candidates.length===1?field.candidates[0]:undefined;
    const record=field.tableRecords?.records[0];
    const sourceValue=guaranteeSourceValue(field);
    const view={field,primaryIds:record?record.components.flatMap(c=>c.locationAnchorIds):first?.anchorIds.length?first.anchorIds:field.anchorIds,primaryPage:record?.pageNumber??first?.pageNumbers[0]??field.pageNumbers[0]};
    const own = fieldOwnGaps(view.field, sharedGaps);
    const manual = !view.field.signatureRecords && fieldData?.fieldCapabilities?.some(capability => capability.id === view.field.fieldId && capability.mode === 'manual');
    const calculated = view.field.fieldId==='review_business_date' || [...PERSONAL_DERIVED_FIELDS,...CORPORATE_DERIVED_FIELDS].some(id=>id===view.field.fieldId);
    const authorizationParagraphs = resolutionAuthorizationParagraphs(field);
    return {...view, own, manual, sourceValue, authorizationParagraphs, state: sourceValue ? {label:'原文已识别',tone:'neutral' as const} : manual ? {label: calculated ? '审核时计算' : '在信息核对中判断', tone: 'neutral' as const} : fieldRowState(view.field, own, requiresFieldSemanticFilter(view.field.fieldId, fieldData))};
  };
  const fieldRows = fieldViews.flatMap(view=>meetingFieldRows(view.field).map(makeFieldRow));
  const fieldsWithNotes = fieldRows.filter(row => row.own.length > 0);
  const signaturePagesWithNotes = signatureData?.review?.coverage.uncertainPages ?? [];
  const hasNotes = notes.length > 0 || fieldsWithNotes.length > 0 || signaturePagesWithNotes.length > 0;
  const insuranceMode=!materialScopePending&&isInsuranceDocument(directoryData?.directory??[],materialScope?.taxonomyId);
  const personalGroups = personalGuarantorGroups(effectiveFields.map(field => ({...field, candidates: field.candidates.length ? fieldData?.items.find(original => original.id === field.id)?.candidates ?? field.candidates : []})), allAnchors, material.id, parseRevision);
  const canCorrect = !isHistorical && fieldData?.configuration?.matchesCurrent !== false && capabilities.data?.reviewLoop === true && can(review.data?.allowedActions ?? [], 'field:correct');
  const supportingIds=insuranceSupportingFieldIds();
  const personalRawRows = personalGroups.groups.length ? fieldRows.filter(row => guarantorDetailFields.has(row.field.fieldId)) : [];
  const ungroupedRows=fieldRows.filter(row => (!insuranceMode || !supportingIds.has(row.field.fieldId)) && (!personalGroups.groups.length || !guarantorDetailFields.has(row.field.fieldId)));
  const annualSections=annualReturnFieldSections(ungroupedRows.map(row=>row.field));
  const fieldSections=annualSections?.map(section=>({...section,rows:section.rows.map(makeFieldRow)}))??documentFieldSections(ungroupedRows);
  const otherFieldRows=fieldSections.flatMap(section=>section.rows);
  const filteredSections=fieldSections.map(section=>({...section,rows:section.rows.filter(row => fieldFilter === 'all' ? true : fieldFilter === 'missing' ? !row.manual && row.field.status === 'not_found' : row.state.tone === 'warning')})).filter(section=>section.rows.length);
  /* 暂时隐藏的字段状态摘要，恢复展示时一并启用。
  const filterJobStatus = fieldData?.filterJob?.status;
  const filtering = runningStatus(filterJobStatus);
  const filterFailed = ['failed', 'canceled', 'stale'].includes(filterJobStatus ?? '') || fieldRows.some(row => row.field.semanticFilter?.state === 'failed');
  const extractionUnknown = fieldData?.filterJob?.errorCode === 'execution_unknown';
  const filterStatusLabel = filtering ? '正在按当前配置提取字段' : extractionUnknown ? '本次提取结果尚未确认，请先核对执行记录。' : filterFailed ? '本次字段提取未完成' : '';
  */
  const commitPage = () => {const value = Number(pageDraft); if (Number.isSafeInteger(value) && pageItems.some(entry => entry.pageNumber === value)) {setNoteTarget(undefined); setPageNumber(value); setSelectedAnchors([]);} else setPageDraft(String(pageNumber));};
  const goPage = (value: number) => {setNoteTarget(undefined); setPageNumber(value); setSelectedAnchors([]);};
  const locateNote = (page: number, codes: readonly string[]) => {if (!pageItems.some(entry => entry.pageNumber === page)) return; setSelectedAnchors([]); setSelectedRegion(undefined); setPageNumber(page); setNoteTarget({page, codes});};
  const regions = (pageData?.regions ?? []).filter(region => usefulRegionIds.has(region.region_id) && region.document_version_id === material.id && region.parse_revision === parseRevision && region.page_asset_id === pageData?.page.page_asset_id).map(region => ({...region, polygons: visibleEvidencePolygons(region.polygons, pageData!.page.width, pageData!.page.height)})).filter(region => region.polygons.length).sort((a, b) => a.reading_order - b.reading_order);
  const selectedOnPage = selected.filter(anchor => anchor.page_number === pageNumber && anchor.page_asset_id === pageData?.page.page_asset_id);
  const focusRegionAt = (index: number) => {if (!regions.length) return; const next = (index + regions.length) % regions.length; setFocusRegion(next); requestAnimationFrame(() => (canvasRef.current?.querySelector(`[data-region-index="${next}"]`) as SVGElement | null)?.focus());};

  const renderValueSource = (value: string, ids: string[], page: number | undefined, label: string) => <div className="field-value-source" role="group" aria-label={label}>
    <button type="button" className="evidence-value-link" disabled={!ids.length} aria-label={`定位${label}`} onClick={event => {event.stopPropagation(); selectEvidence(ids, page);}}>{value}</button>

  </div>;
  // A link from elsewhere (the case assistant) can point at one extracted field of this file: show and mark its row here.
  const routeField = params.get('field');
  const locatedField = fieldRows.find(row => row.field.fieldId === routeField);
  const locatedFieldId = locatedField?.field.id;
  useEffect(() => {
    if (!locatedFieldId) return;
    setFieldFilter('all');
    const anchors = locatedField!.field.anchorIds.length ? locatedField!.field.anchorIds : locatedField!.field.candidates.flatMap(candidate => candidate.anchorIds);
    if (locatedField!.primaryIds.length) selectEvidence(locatedField!.primaryIds, locatedField!.primaryPage);
    else if (anchors.length) selectEvidence(anchors);
    const frame = requestAnimationFrame(() => document.querySelector(`.field-summary-table tr[data-row-key="${CSS.escape(locatedFieldId)}"]`)?.scrollIntoView({block: 'center'}));
    return () => cancelAnimationFrame(frame);
  }, [locatedFieldId]);
  const columns: TableProps<typeof fieldRows[number]>['columns'] = [
    {title: '字段', key: 'label', width: 112, onCell: row=>({colSpan:row.field.signatureRecords?0:1}), render: (_, row) => <>
      <span className="field-label">{row.field.fieldLabel}</span>
      {/* 暂时隐藏字段来源，后续需要时恢复此组件。
      <span className="table-sub">{row.field.humanRevisionId?'来源：人工更正':row.field.signatureRecords?'来源：签署自动识别':row.field.candidates.length?'来源：自动候选':'尚无提取值'}</span>
      */}
    </>},
    {title: '值与原文位置', key: 'value', onCell: row=>({colSpan:row.field.signatureRecords?2:1,className:row.field.signatureRecords?'field-signature-cell':undefined}), render: (_, row) => {
      const field=row.field;
      const fileDate=fileDates.find(date=>date.field.id===field.id)?.date;
      if(fileDate)return <button type="button" className="evidence-value-link" aria-label={`定位${field.fieldLabel}：${fileDate.value}`} onClick={event=>{event.stopPropagation();if(fileDate.box){setSignatureRegion({page:fileDate.pageNumber,box:fileDate.box});setPageNumber(fileDate.pageNumber);setRegionMode('evidence');setSelectedAnchors([]);}else selectEvidence(field.anchorIds,fileDate.pageNumber);}}>{fileDate.value}</button>;
      const notice=(hasValue:boolean,detailsInline=false)=><ExtractionNotice state={row.state} hasValue={hasValue} detailsInline={detailsInline}
        detail={fieldExtractionNoticeDetail(field,row.own)}/>;
      if(row.sourceValue)return <>{renderValueSource(row.sourceValue.displayValue,row.sourceValue.anchorIds,row.sourceValue.pageNumbers[0],`${field.fieldLabel}原文`)}{notice(true)}</>;
      if(field.signatureRecords)return <>{notice(field.signatureRecords.records.some(record=>record.presence==='graphic'||record.presence==='handwriting'),true)}<FieldSignatureRecords field={field} onEvidence={selectEvidence} onLocate={(page,box)=>{setSignatureRegion({page,box});setPageNumber(page);setRegionMode('evidence');setSelectedAnchors([]);}}/></>;
      if(field.fieldId==='cgt_field_29'&&!field.humanRevisionId)return <div className="field-kept-values">
        {row.authorizationParagraphs.map((paragraph,index)=><React.Fragment key={index}>{renderValueSource(paragraph.text,paragraph.anchorIds,paragraph.pageNumbers[0],`${field.fieldLabel}原文段落`)}</React.Fragment>)}
        {row.authorizationParagraphs.length?notice(true):<ExtractionNotice state={{label:'未提取到授权段落，请核对原文',tone:'warning'}} hasValue={false}/>}
      </div>;
      if(field.tableRecords?.records.length)return <><FieldTableRecords field={field} onSelect={selectEvidence} renderSource={renderValueSource}/>{notice(true)}</>;
      if(field.semanticFilter?.state==='completed'&&field.candidates.length>1)return <div className="field-kept-values">
        {field.candidates.map((candidate,index)=><React.Fragment key={index}>{renderValueSource(fieldCandidateDisplayText(candidate),candidate.anchorIds,candidate.pageNumbers[0],`${field.fieldLabel}原文：${fieldCandidateDisplayText(candidate)}`)}</React.Fragment>)}{notice(true)}
      </div>;
      return <>{field.rawValue&&renderValueSource(field.candidates.length===1?fieldCandidateDisplayText(field.candidates[0]):fieldDisplayText(field.rawValue),row.primaryIds,row.primaryPage,`${field.fieldLabel}原文`)}{notice(Boolean(field.rawValue))}</>;
    }},
  ];
  const fullTextTranslation = <FullTextTranslationButton caseId={item.id} documentId={material.id} filename={material.filename} parseRevision={parseRevision} caseRevision={item.revision} directoryRevision={fieldData?.directoryRevision === undefined ? undefined : Number(fieldData.directoryRevision)} writable={!isHistorical && !isProcessing && can(actions, 'document:parse')}/>;
  const readerTools = <div className="reader-tools" role="group" aria-label={`${pageKind}阅读工具`}>
    <Button ref={directoryTrigger} className="reader-directory-toggle" type="text" aria-label={directoryVisible ? '收起材料分类与页面' : '展开材料分类与页面'} aria-expanded={directoryVisible} icon={<NavIcon name="directory"/>} onClick={() => toggleDirectory(!directoryVisible)}>材料分类</Button>
    <div className="reader-page-controls">
      <Tooltip title="上一页"><Button type="text" aria-label="上一页" icon={<NavIcon name="previous"/>} disabled={!pageItems.some(entry => entry.pageNumber < pageNumber)} onClick={() => goPage(Math.max(...pageItems.filter(entry => entry.pageNumber < pageNumber).map(entry => entry.pageNumber)))}/></Tooltip>
      <div className="reader-page-number"><Input className="review-page-input mono" aria-label={`${pageKind}页码，按回车跳转`} inputMode="numeric" value={pageDraft} onChange={event => setPageDraft(event.target.value.replace(/\D/g, ''))} onPressEnter={commitPage} onBlur={commitPage}/><span className="reader-page-total mono">/ {pages.data?.totalPages ?? totalPages}</span></div>
      <Tooltip title="下一页"><Button type="text" aria-label="下一页" icon={<NavIcon name="next"/>} disabled={!pageItems.some(entry => entry.pageNumber > pageNumber)} onClick={() => goPage(Math.min(...pageItems.filter(entry => entry.pageNumber > pageNumber).map(entry => entry.pageNumber)))}/></Tooltip>
    </div>
    <ReaderViewControls zoom={zoom} onZoom={setZoom} onRotate={() => setRotation(value => (value + 90) % 360)}/>
    <Dropdown trigger={['click']} placement="topLeft" menu={{selectable: true, selectedKeys: [regionMode], items: regionModes.map(option => ({key: option.value, label: option.label})), onClick: ({key}) => setRegionMode(key as RegionMode)}}><Button type="text" aria-label={`证据框显示方式：${regionModes.find(option => option.value === regionMode)?.label}`} title={`证据框显示方式：${regionModes.find(option => option.value === regionMode)?.label}`} icon={<NavIcon name={regionMode === 'off' ? 'regions-off' : 'regions'}/>}/></Dropdown>
    {wide && evidenceVisible && <Button className="reader-reset-split" type="text" onClick={resetSplit} title="恢复原件与证据等分，也可双击分隔条">恢复等分</Button>}
    {!evidenceVisible && <Tooltip title="展开字段与证据"><Button type="text" icon={<NavIcon name="evidence"/>} onClick={() => setEvidenceVisible(true)} aria-label="展开字段与证据"/></Tooltip>}
  </div>;
  const directoryPane = <aside className="review-pane review-directory" aria-label="材料目录与页面" ref={directoryRef}>
    <div className="review-pane-head">
      {capabilities.data?.logicalDirectory ? <Segmented<'directory' | 'pages'> aria-label="目录或页面" value={leftView} onChange={setLeftView} options={[{value: 'directory', label: '分类'}, {value: 'pages', label: '页面'}]}/> : <span className="review-pane-title">页面</span>}
      {leftView === 'directory' && capabilities.data?.logicalDirectory && !isHistorical && can(actions, 'document:classify') && <Button className="link-button" type="link" disabled={!directoryData} onClick={() => setDirectoryOpen(true)}>更正</Button>}
      <Tooltip title="收起目录"><Button type="text" className="pane-close" aria-label="收起目录" onClick={() => toggleDirectory(false)}>«</Button></Tooltip>
    </div>
    <div className="review-pane-body">
      {leftView === 'directory' && capabilities.data?.logicalDirectory ? (directory.isPending ? <Loading/> : blocksView(directory) ? <ErrorNotice error={(isProcessing||isFailed) && directory.error instanceof ApiError && directory.error.code === 'index_not_ready' ? null : directory.error} retry={() => void directory.refetch()}/> : logicalDocuments.length ? <ol className="directory-list">{logicalDocuments.map((logical, index) => {const duplicate = logicalDocuments.filter(entry => entry.label === logical.label).length > 1; return <li key={logical.id}><button type="button" className={`directory-item${activeDocument?.id === logical.id ? ' active' : ''}`} aria-current={activeDocument?.id === logical.id ? 'true' : undefined} onClick={() => {setActiveLogical(logical.id); if(sourceContent&&logical.sourceNodeIds?.length)setParams(current=>{const next=new URLSearchParams(current);next.set('view','source');next.set('sourceNode',logical.sourceNodeIds![0]);return next;});else if(logical.pageNumbers[0])goPage(logical.pageNumbers[0]);}}><span className="directory-name">{logical.label}{duplicate && <span className="muted">（{logicalDocuments.slice(0, index + 1).filter(entry => entry.label === logical.label).length}）</span>}</span><span className="directory-pages mono">{logical.pageNumbers.length?`p${formatPages(logical.pageNumbers)}`:logical.sourceNodeIds?.length?'源结构':'位置待确认'}</span><span className={`directory-status${logical.status === 'confirmed' ? '' : ' tone-warning'}`}>{directoryLabels[logical.status]}</span></button></li>;})}</ol> : <p className="muted pane-note">尚无分类目录</p>)
        : <><div className="review-thumbnails">{pageItems.filter(entry => Math.abs(entry.pageNumber - pageNumber) <= 2).map(entry => <button type="button" key={entry.pageNumber} aria-label={`查看${pageKind}第 ${entry.pageNumber} 页`} aria-current={entry.pageNumber === pageNumber ? 'page' : undefined} onClick={() => goPage(entry.pageNumber)}><img src={`${base}/pages/${entry.pageNumber}/image${suffix}`} alt="" loading="lazy"/><span>{entry.pageNumber}</span></button>)}</div>
          <ol className="page-list">{pageItems.map(entry => <li key={entry.pageNumber}><button type="button" className={`directory-item${entry.pageNumber === pageNumber ? ' active' : ''}`} aria-current={entry.pageNumber === pageNumber ? 'page' : undefined} onClick={() => goPage(entry.pageNumber)}><span className="directory-name">第 {entry.pageNumber} 页</span><span className={`directory-status${pageProcessingLabel(entry) === '已处理' ? '' : ' tone-warning'}`}>{pageProcessingLabel(entry)}</span>{!!visibleProcessingGaps(entry.coverageGaps).length && <span className="directory-pages">有核对提示</span>}</button></li>)}</ol></>}
    </div>
  </aside>;
  const canvasPane = sourceContent ? <section className="review-pane review-source-pane" aria-label="Word 源结构与字段"><div className="review-source-toolbar">文字结构定位 · 不代表原件页面高亮{!evidenceVisible && <Button size="small" onClick={()=>setEvidenceVisible(true)}>展开字段与证据</Button>}</div>{sourceContent}</section> : <section className="review-pane review-canvas-pane" aria-label={`${pageKind}页面`}>
    <div className="review-pane-notices">{blocksView(pages) && <ErrorNotice error={pages.error} retry={() => void pages.refetch()}/>}{blocksView(page) && <ErrorNotice error={page.error} retry={() => void page.refetch()}/>}<RefreshNotice query={page} retry={() => void page.refetch()}/>{imageFailed && <Alert className="notice" type="error" title="原页图像暂不可用，请重新查询或核对读取权限。" showIcon/>}</div>
    <div className="review-canvas-stage">
    <div className={`review-canvas${zoom === 'page' ? ' fit-page' : ''}`} ref={canvasRef}>{!pages.isPending && !pageItems.some(entry => entry.pageNumber === pageNumber) ? <Blank title="本页尚无解析产物"/> : page.isPending ? <Loading/> : pageData && transforms && <ReaderPage src={`${base}/pages/${pageNumber}/image${suffix}`} width={pageData.page.width} height={pageData.page.height} rotation={rotation} zoom={zoom} className={`regions-${regionMode}`} label={`${pageKind}第 ${pageNumber} 页，旋转 ${rotation} 度。方向键在区域之间移动，回车选择。`} onImageError={() => setImageFailed(true)}>
      {regionMode !== 'off' && regions.map((region, index) => {const signature = region.kind === 'signature' || pageData.signatures.some(entry => entry.regionIds.includes(region.region_id)); return region.polygons.map((polygon, i) => <polygon key={`${region.region_id}:${i}`} data-region-index={i === 0 ? index : undefined} className={`review-region${signature ? ' signature' : ''}${selectedRegion === region.region_id ? ' selected' : ''}`} points={polygon.map(point => point.join(',')).join(' ')} role="button" tabIndex={i === 0 && index === Math.min(focusRegion, regions.length - 1) ? 0 : -1} aria-pressed={selectedRegion === region.region_id} aria-label={`区域 ${region.reading_order + 1}：${regionKinds[region.kind]}，${region.raw_text?.slice(0, 50) ?? '待人工查看'}`} onClick={() => {setFocusRegion(index); selectRegion(region);}} onKeyDown={event => {if (event.key === 'Enter' || event.key === ' ') {event.preventDefault(); selectRegion(region);} else if (event.key === 'ArrowRight' || event.key === 'ArrowDown') {event.preventDefault(); focusRegionAt(index + 1);} else if (event.key === 'ArrowLeft' || event.key === 'ArrowUp') {event.preventDefault(); focusRegionAt(index - 1);}}}/>);})}
      {regionMode !== 'off' && selectedOnPage.flatMap(anchor => visibleEvidencePolygons(anchor.polygons, pageData.page.width, pageData.page.height).map((polygon, i) => <polygon className={`review-anchor${cursorAnchor?.anchor_id === anchor.anchor_id ? ' current' : ''}`} data-anchor-id={i === 0 ? anchor.anchor_id : undefined} key={`${anchor.anchor_id}:${i}`} points={polygon.map(point => point.join(',')).join(' ')}/>))}{signatureRegion?.page===pageNumber&&<SignatureRegionOverlay width={pageData.page.width} height={pageData.page.height} box={signatureRegion.box} drawing={!!signatureRegion.done} onComplete={box=>{if(box)signatureRegion.done?.(box);setSignatureRegion({page:pageNumber,box});}}/>}</ReaderPage>}</div>
    </div>
    {directoryMismatch&&<Alert className="review-banner" type="warning" showIcon title="所引用的目录版本与当前展示不同，未自动高亮。此页显示该解析记录的最新目录，请回查历史快照中的依据标识。"/>}
    {routeAnchor&&!directoryMismatch&&fieldData&&!allAnchors.some(a=>a.anchor_id===routeAnchor)&&<Alert className="review-banner" type="warning" showIcon title="此原文位置暂无法定位，未显示精确高亮。请核对文件和解析版本。"/>}
    <footer className="review-footer" aria-label={`${pageKind}预览控制`}>{readerTools}</footer>
  </section>;
  const fieldsTab = <div className="evidence-panel">
    {/* 暂时隐藏字段面板摘要。
    {materialScope?.status==='resolved'&&<div className="field-semantic-status"><span>当前材料：{directoryData?.taxonomy.find(type=>type.id===materialScope.taxonomyId)?.label??'已识别材料'}</span></div>}
    */}
    {/* 暂时隐藏字段面板摘要。
    {fieldData?.configuration?.currentReleaseId && <div className="field-semantic-status"><span>本案审核配置：{fieldData.configuration.currentLabel}</span>{!fieldData.configuration.matchesCurrent && <span role="status" className="tone-warning">{extractionUnknown ? '当前配置的字段结果待确认。' : '字段结果尚未按本案当前配置完成更新，请重新提取后核对。'}</span>}</div>}
    */}
    <div className="review-pane-notices">{blocksView(fields) ? <ErrorNotice error={(isProcessing||isFailed) && fields.error instanceof ApiError && fields.error.code === 'index_not_ready' ? null : fields.error} retry={() => void fields.refetch()}/> : <RefreshNotice query={fields} retry={() => void fields.refetch()}/>}</div>
    {currentRegion && <div className="region-card"><div className="region-card-head"><strong>已选区域 · 第 {pageNumber} 页</strong><span className="muted">{regionFields.length ? `关联 ${regionFields.length} 个字段` : '没有关联字段'}</span></div><OcrRegionContent region={currentRegion}/><GapList gaps={currentRegion.coverage_gaps}/></div>}
    {/* 暂时隐藏字段提取状态摘要；字段行及核对提示仍保留原有状态。
    {filterStatusLabel && <div className="field-semantic-status"><span role="status">{filterStatusLabel}</span></div>}
    */}
    {fieldsWaiting ? <Loading/> : fieldData && (materialScopePending ? <MaterialScopeNotice status={materialScope?.status} onConfirm={!isHistorical&&!isProcessing&&materialScope?.status!=='stale'&&capabilities.data?.logicalDirectory&&can(actions,'document:classify')&&directoryData?()=>setDirectoryOpen(true):undefined}/> : fieldRows.length||insuranceMode ? <>
      {insuranceMode&&<InsuranceFields response={fieldData} directory={directoryData?.directory??[]} onSelect={selectEvidence} onPaymentEvidence={()=>setPaymentOpen(true)}
        renderSources={ids=><SourceLinks ids={ids} anchors={allAnchors} sourceAnchors={allSourceAnchors} onSelect={selectEvidence}/>}/>}
      {!!personalGroups.groups.length && <PersonalGuarantorFields {...personalGroups} onSelect={selectEvidence} onCorrect={canCorrect ? setCorrection : undefined}/>}
      <details className={insuranceMode?'insurance-other-fields':'field-list-details'} open={insuranceMode?undefined:true}>
      <summary hidden={!insuranceMode}>其他字段 {otherFieldRows.length}</summary>
      <Segmented<'all' | 'attention' | 'missing'> className="field-filter" block aria-label="字段筛选" value={fieldFilter} onChange={setFieldFilter} options={[{value: 'all', label: `全部 ${otherFieldRows.length}`}, {value: 'attention', label: `需关注 ${otherFieldRows.filter(row => row.state.tone === 'warning').length}`}, {value: 'missing', label: `未提取到 ${otherFieldRows.filter(row => !row.manual && row.field.status === 'not_found').length}`}]}/>
      {(filteredSections.length?filteredSections:[{key:'fields',rows:[]}]).map(section=><Table key={section.key} showHeader={false} title={section.label?()=> <h3 className="document-field-section-title">{section.label}</h3>:undefined} rowKey={row => row.field.id} size="small" tableLayout="fixed" pagination={false} columns={columns} dataSource={section.rows} className="field-table field-summary-table"
        rowClassName={row => `${row.field.anchorIds.some(id => selectedAnchors.includes(id)) ? 'is-selected' : ''}${row.field.id === locatedFieldId ? ' field-row-located' : ''}`}
        onRow={row => ({onClick: () => {if (row.primaryIds.length) selectEvidence(row.primaryIds, row.primaryPage);}})}
        locale={{emptyText: '当前筛选下没有字段'}}/>)}
      </details>
      {!!personalRawRows.length && <PersonalGuarantorRecords count={personalRawRows.length}><Table rowKey={row => row.field.id} size="small" tableLayout="fixed" pagination={false} columns={columns} dataSource={personalRawRows}/></PersonalGuarantorRecords>}
      {correction && canCorrect && <ReaderFieldCorrection item={item} material={material} materials={materials} target={correction} parseRevision={parseRevision} directoryRevision={fieldData.directoryRevision} anchors={allAnchors} close={() => setCorrection(undefined)}/>}
    </> : <Blank title={materialScope?.taxonomyId===SUPPLEMENTAL_MATERIAL_ID?"此文件为其他／补充材料":"尚未提取到字段"}>{materialScope?.taxonomyId===SUPPLEMENTAL_MATERIAL_ID&&"请打开案件助手的补充材料页，指定要提取的字段与核对内容。"}</Blank>)}
    {paymentOpen&&fieldData&&<InsurancePaymentEvidence caseId={item.id} documentId={material.id} materials={materials} insuranceFields={effectiveFields} close={()=>setPaymentOpen(false)}/>}
  </div>;
  const gapsTab = <div className="evidence-panel">
    {blocksView(pages) && <ErrorNotice error={pages.error} retry={() => void pages.refetch()}/>}
    {blocksView(fields) && <ErrorNotice error={fields.error} retry={() => void fields.refetch()}/>}
    {blocksView(signatures) && <ErrorNotice error={signatures.error} retry={() => void signatures.refetch()}/>}
    <ProcessingNotesList notes={notes} onLocate={locateNote} availablePages={pageItems.map(entry => entry.pageNumber)}/>
    {fieldsWithNotes.length > 0 && <section className="processing-context-group" aria-label="字段待核对"><h3>字段待核对</h3>{fieldsWithNotes.map(row => <details className="processing-context-note" key={row.field.id}><summary>{row.field.fieldLabel} · {row.state.label}</summary><GapList gaps={row.own}/><SourceLinks ids={row.field.anchorIds} anchors={allAnchors} sourceAnchors={allSourceAnchors} onSelect={selectEvidence}/></details>)}</section>}
    {signaturePagesWithNotes.length > 0 && <section className="processing-context-group" aria-label="签署待核对"><h3>签署待核对</h3><p>{signaturePagesWithNotes.length} 页需核对清晰度或覆盖范围。</p>{signaturePagesWithNotes.map(number => <Button type="link" key={number} onClick={() => {selectEvidence([], number); focusSignatureFields();}}>p{number}</Button>)}</section>}
    {!hasNotes && (pages.isPending || fields.isPending || signatures.isPending ? <Loading/> : !blocksView(pages) && !blocksView(fields) && !blocksView(signatures) && <Blank title="已返回的解析记录中暂无提示"/>)}
  </div>;
  const evidencePane = <aside className="review-pane review-evidence" aria-label="字段与证据" ref={evidenceRef}>
    <div className="review-pane-head"><h3 className="review-pane-title">提取字段{fieldData && !materialScopePending ? ` ${fieldRows.length}` : ''}</h3><Tooltip title="收起证据栏"><Button type="text" className="pane-close" aria-label="收起证据栏" onClick={() => setEvidenceVisible(false)}>»</Button></Tooltip></div>
    <div className="review-evidence-body review-field-body">{fieldsTab}
      {parseRevision&&materialScope?.status==='resolved'&&showsSignatureInformationPanel(materialScope.taxonomyId)&&<SignatureInformationPanel materialType={materialScope.taxonomyId} embedded coveredAutomaticRecordIds={fieldRows.flatMap(row=>row.field.signatureRecords?.records.map(record=>record.id)??[])} fields={directoryMismatch?undefined:fieldData} item={item} base={base} parseRevision={parseRevision} historical={isHistorical||!!params.get('signatureRecord')} currentPage={pageNumber} onLocate={(page,box)=>{setSignatureRegion({page,box});setPageNumber(page);setRegionMode('evidence');setSelectedAnchors([]);}} onDraw={(page,done)=>{setSignatureRegion({page,done});setPageNumber(page);setRegionMode('off');setSelectedAnchors([]);}} onEvidence={selectEvidence}/>}
    </div>
  </aside>;
  // The directory is outside the ratio: toggling it divides only the remaining reader width.
  const documentSplit = evidenceVisible ? <div className="review-document-split" ref={splitRef} onKeyDown={event => {
    if (!(event.target instanceof HTMLElement) || event.target.getAttribute('role') !== 'separator') return;
    const next = readerRatioKey(liveRatio ?? sizes.canvasRatio, event.key);
    if (next === undefined) return;
    event.preventDefault(); setSizes({...sizes, canvasRatio: next}); setLiveRatio(undefined);
  }}><Splitter className="review-reader-split" onDraggerDoubleClick={resetSplit}
    onResize={values => setLiveRatio(readerRatio(values))}
    onResizeEnd={values => {setSizes({...sizes, canvasRatio: readerRatio(values)}); setLiveRatio(undefined);}}>
    <Splitter.Panel size={`${(liveRatio ?? sizes.canvasRatio) * 100}%`} min="30%" max="70%">{canvasPane}</Splitter.Panel>
    <Splitter.Panel size={`${(1 - (liveRatio ?? sizes.canvasRatio)) * 100}%`} min="30%" max="70%">{evidencePane}</Splitter.Panel>
  </Splitter></div> : canvasPane;
  return <>
    {translationAction && createPortal(fullTextTranslation, translationAction)}
    {wide ? <Splitter className="review-workspace" onResize={values => {if (directoryVisible) setLiveDirectory(values[0]);}} onResizeEnd={values => {if (directoryVisible) setSizes({...sizes, directory: values[0]}); setLiveDirectory(undefined);}}>
      {directoryVisible && <Splitter.Panel key="directory" size={liveDirectory ?? sizes.directory} min={180} max="30%">{directoryPane}</Splitter.Panel>}
      <Splitter.Panel key="reader" min="60%">{documentSplit}</Splitter.Panel>
    </Splitter> : <div className="review-stack">{directoryVisible && directoryPane}{canvasPane}{evidenceVisible && evidencePane}</div>}
    {directoryOpen && capabilities.data?.logicalDirectory && directoryData && <DirectoryDrawer item={item} filename={material.filename} continueExtraction={!isProcessing&&can(actions,'document:parse')} base={base} value={directoryData} close={() => setDirectoryOpen(false)} done={() => {setDirectoryOpen(false); void refresh();}}/>}
  </>;
}
function CompareDrawer({item: liveItem, material, materials, parseRevision, close}: {item: CaseSummary; material: Material; materials: Material[]; parseRevision: string; close: () => void}) {
  useRestoreFocus();
  const [item] = useState(liveItem);
  const [target, setTarget] = useState<string>();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<unknown>();
  const [key, setKey] = useState(newKey);
  const [jobId, setJobId] = useState<string>();
  const [direct, setDirect] = useState<ComparisonView>();
  const targetStatus = useQuery({queryKey: ['document-processing', item.id, target], enabled: !!target, queryFn: ({signal}) => api<ProcessingStatus>(`/api/cases/${item.id}/documents/${target}/processing`, {signal})});
  const job = useQuery({queryKey: ['tool-job', jobId], enabled: !!jobId, queryFn: ({signal}) => api<ToolJob>(`/api/tool-jobs/${jobId}`, {signal}), refetchInterval: query => terminalJob(query.state.data?.status) ? false : 1500});
  useEffect(() => {if (['failed', 'canceled'].includes(job.data?.status ?? '')) setKey(newKey());}, [job.data?.status]);
  const result = direct ?? job.data?.result;
  const labels = {added: '新增内容', removed: '移除内容', changed: '内容变化', ambiguous: '对应关系待确认'};
  const versions = materials.map(entry => entry.ossVersionId);
  const targetMaterial = materials.find(entry => entry.id === target);
  const running = !!jobId && !terminalJob(job.data?.status);
  const chunkText = (chunks: ComparisonView['beforeChunks'], ids: string[]) => ids.map(id => chunks?.find(entry => entry.id === id)?.text ?? '').join('\n');
  const side = (title: string, chunks: ComparisonView['beforeChunks'], ids: string[], other: string, documentId: string, revision: string, mark: 'del' | 'ins') => <div className="compare-side"><h3 className="visually-hidden">{title}</h3>{ids.length ? ids.map(id => {const chunk = chunks?.find(entry => entry.id === id); return <div key={id}>{chunk && !chunk.text.trim() ? <p className="muted">该段没有可比较的文字内容（可能为图像），请查看原页。</p> : chunk ? <p className="compare-text">{diffLines(chunk.text, other).map((line, i) => line.changed ? (mark === 'del' ? <del key={i}>− {line.text}{'\n'}</del> : <ins key={i}>+ {line.text}{'\n'}</ins>) : <span key={i}>{'  '}{line.text}{'\n'}</span>)}</p> : <p className="muted">内容片段暂不可用</p>}{chunk && <Link target="_blank" rel="noopener noreferrer" to={`/cases/${item.id}/review?document=${encodeURIComponent(documentId)}&parse=${encodeURIComponent(revision)}${item.selectedRoundId?`&round=${item.selectedRoundId}`:''}${chunk.pageNumbers.length ? `&page=${chunk.pageNumbers[0]}` : `&view=source&sourceNode=${encodeURIComponent(chunk.sourceNodeIds?.[0] ?? '')}`}`}>{chunk.pageNumbers.length ? `新标签页查看第 ${formatPages(chunk.pageNumbers)} 页` : '新标签页查看源结构'}</Link>}</div>;}) : <p className="muted">无对应内容</p>}</div>;
  return <Drawer title="比较文件版本" open size="min(1200px, calc(100vw - 72px))" onClose={close} destroyOnHidden footer={<div className="drawer-footer"><Button onClick={close}>关闭</Button></div>}>
    <div className="compare-head">
      <div className="compare-file"><span className="muted">原版本</span><strong className="filename">{material.filename}</strong><span className="mono muted">版本 {shortVersion(material.ossVersionId, versions)}</span></div>
      <span className="compare-arrow" aria-hidden="true">⇄</span>
      <div className="compare-file"><span className="muted">对照文件</span><Select aria-label="选择对照文件" style={{width: '100%'}} value={target} placeholder="选择对照文件" options={materials.filter(entry => entry.id !== material.id).map(entry => ({value: entry.id, label: entry.filename}))} onChange={value => {setTarget(value); setJobId(undefined); setDirect(undefined); setKey(newKey());}}/>{targetMaterial && <span className="mono muted">版本 {shortVersion(targetMaterial.ossVersionId, versions)}</span>}</div>
      <Button type="primary" disabled={!targetStatus.data?.parseRevision || running} loading={pending || running} onClick={async () => {setPending(true); setError(undefined); try {const response = await api<{jobId: string} | ComparisonView>(`/api/cases/${item.id}/documents/compare`, {method: 'POST', body: {beforeDocumentId: material.id, afterDocumentId: target, beforeParseRevision: parseRevision, afterParseRevision: targetStatus.data?.parseRevision, expectedRevision: item.revision, idempotencyKey: key}}); if ('jobId' in response) setJobId(response.jobId); else setDirect(response);} catch (failure) {setError(failure);} finally {setPending(false);}}}>开始比较</Button>
    </div>
    <ErrorNotice error={error || targetStatus.error || job.error}/>
    {target && targetStatus.data && !targetStatus.data.parseRevision && <Alert className="notice" type="info" showIcon title="对照文件尚无解析结果，请先解析材料。"/>}
    {job.data?.status === 'failed' && <Alert className="notice" type="error" title="比较未完成，请检查材料解析状态后重试。" showIcon/>}
    {job.data?.validity === 'stale' && <Alert className="notice" type="warning" title="输入版本已变化，此比较仅供历史回查。" showIcon/>}
    {result && <>
      <p className="muted compare-summary">{result.changes.length} 项变化{result.status === 'partial' ? '，存在覆盖缺口' : ''}</p>
      {result.changes.length > 0 && <div className="compare-table" role="table" aria-label="比较结果">
        <div className="compare-row compare-row-head" role="row"><span role="columnheader">变化</span><span role="columnheader">原版本</span><span role="columnheader">对照版本</span></div>
        {result.changes.map((change, i) => {const before = chunkText(result.beforeChunks, change.beforeChunkIds), after = chunkText(result.afterChunks, change.afterChunkIds); return <div className="compare-row" role="row" key={i}><span role="cell"><Tag className={change.kind === 'ambiguous' ? 'tag-warning' : 'tag-neutral'}>{labels[change.kind]}</Tag></span><div role="cell">{side('原版本', result.beforeChunks, change.beforeChunkIds, after, result.beforeDocumentVersionId, result.beforeParseRevision, 'del')}</div><div role="cell">{side('对照版本', result.afterChunks, change.afterChunkIds, before, result.afterDocumentVersionId, result.afterParseRevision, 'ins')}</div></div>;})}
      </div>}
      {!result.changes.length && <p>已比较范围内未检出变化</p>}
      <GapList gaps={result.coverageGaps}/>
    </>}
  </Drawer>;
}
