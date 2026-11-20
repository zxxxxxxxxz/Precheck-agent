import {materialReaderPath,materialContentPath} from '../features/materials/navigation.ts';
import {fileProcessingLabel} from '../features/materials/processing.ts';
import {useAutomaticMaterialProcessing} from '../features/materials/use-automatic-processing.ts';
import {caseExtractionPath} from '../features/cases/workspace-navigation.ts';
import {ProcessingAvailability} from '../features/documents/processing-availability.tsx';
import {deferredProcessingMessage} from '../features/documents/deferred-processing.ts';
import type {ReviewState} from '@hsbc/contracts/review';
import type {ProcessingStatus} from '../features/documents/types.ts';
import {AddHistoricalMaterials,useHistoricalMaterials} from '../features/materials/history.tsx';
import {PreparationChecklist} from '../features/materials/preparation-checklist.tsx';
import {MaterialGuaranteeSelection} from '../features/materials/guarantee-selection.tsx';
import {roundQuery} from '../features/review/round-controls.tsx';
import {MaterialProcessing,useMaterialProcessing} from '../features/review/progress.tsx';
import {MaterialFileList} from '../features/materials/file-list.tsx';
import {useCapabilities} from '../capabilities.ts';
import React, {useEffect, useRef, useState} from 'react';
import {Alert, Button, Drawer, Modal, Progress} from 'antd';
import {ConfigurationRequired} from '../features/documents/configuration-required.tsx';
import {useQuery} from '@tanstack/react-query';
import {api, newKey, queryClient} from '../api.ts';
import {can} from '../features/identity/permissions.ts';
import {formatSize, formatTime} from '../shared/format.ts';
import type {CaseSummary} from '../features/cases/types.ts';
import type {Material, UploadSession} from '../features/materials/types.ts';
import {parseStatuses, statusView} from '../status.ts';
import {blocksView, CopyValue, ErrorNotice, LinkButton, Loading, RefreshNotice, StatusText, useRestoreFocus} from '../ui.tsx';
import {terminalUpload, useUploads, type UploadState} from '../uploads.tsx';
import {materialAccept} from '../upload.ts';
import type {DraftSource} from '@hsbc/contracts/draft';
import {MaterialReviewConfiguration, useCaseReview} from './review-loop.tsx';
import {Link, useNavigate} from 'react-router';
import './materials.css';

const uploadLabels: Record<UploadSession['state'], string> = {issued: '等待传输或核验', verifying: '正在核验原件', registered: '已登记', rejected: '核验未通过', expired: '上传授权已过期', canceled: '已取消'};
const errorLabels: Record<string, string> = {oss_not_found: '核验时未找到上传原件，本文件未加入待审列表。请重新选择文件上传；再次失败时联系管理员。', upload_size_mismatch: '上传文件不完整，请重新选择文件上传。', pdf_encrypted: 'PDF 已加密，请解密后重新上传。', pdf_invalid: 'PDF 无法读取，请检查文件。', pdf_page_limit: 'PDF 超过 500 页。', size_exceeded: '文件超过大小限制。', authorization_revoked: '上传权限已撤销。', document_cloud_scope_denied: '材料处理授权范围不匹配，请联系管理员。', document_cloud_unavailable: '材料识别服务尚未启用，请联系管理员。', case_revision_conflict: '案件已更新，请刷新后重新上传。'};
const isImage = (material: Material) => material.format === 'jpg' || material.format === 'png';
const sourceLabel = (source?: DraftSource) => source?.kind === 'maker' ? '经办人员整理' : source?.kind === 'external_rm' ? `RM 提供${source.label ? ` · ${source.label}` : ''}` : '来源待核实';
export function Materials({item,reviewEntry,roundActions,caseActions}: {item: CaseSummary;reviewEntry?:React.ReactNode;roundActions?:React.ReactNode;caseActions?:React.ReactNode}) {
  const navigate = useNavigate();
  const uploads = useUploads();
  const uploadStates = uploads.states.filter(state => state.caseId === item.id&&(state.roundId??null)===(item.selectedRoundId??null));
  const [detailId, setDetailId] = useState<string>();
  const [removal,setRemoval]=useState<{ids:string[];revision:number;key:string;caseId:string;roundId?:string|null}>();
  const [removing,setRemoving]=useState(false),[removeError,setRemoveError]=useState<unknown>();
  const removePending=useRef(false);
  useEffect(()=>{setRemoval(undefined);setDetailId(undefined);setRemoveError(undefined);},[item.id,item.selectedRoundId]);
  const [dragging,setDragging]=useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const capabilities = useCapabilities();
  const canUpload = can(item.allowed_actions, 'material:upload') && !!capabilities.data?.registration;
  const uploadFiles = (files: File[]) => {if (canUpload && files.length) uploads.start(item, files, {kind: 'unknown'});};
  const materials = useQuery({queryKey: ['materials', item.id,item.selectedRoundId??'current'], queryFn: ({signal}) => api<{items: Material[]}>(`/api/cases/${item.id}/materials${roundQuery(item.selectedRoundId)}`, {signal}), refetchInterval: query => query.state.data?.items.some(material => ['queued', 'pending', 'running', 'processing'].includes(material.parseStatus)) ? 2000 : 15_000});
  const rows = blocksView(materials)?[]:materials.data?.items ?? [];
  const review = useCaseReview(item,true,rows.some(material=>['pending','queued','running','processing'].includes(material.parseStatus))?2000:undefined);
  const decisions = review.data;
  const automaticProcessingError=useAutomaticMaterialProcessing(decisions,rows,
    !materials.error&&!review.error&&!!decisions&&!decisions.readOnly&&!decisions.legacyView&&
    can(decisions.allowedActions,'document:parse')&&!!capabilities.data?.parsing&&!!capabilities.data?.automaticPreparse&&
    !rows.some(material=>material.parseStatus==='configuration_required'));
  const historicalMaterials=useHistoricalMaterials(decisions);
  const canRemove = !blocksView(review) && !!decisions && !decisions.readOnly && can(decisions.allowedActions,'material:adopt');

  const materialRevision=rows.map(material=>`${material.id}:${material.parseStatus}`).join('|');
  const lastMaterialRevision=useRef<{scope:string;revision:string}|undefined>(undefined);
  useEffect(()=>{
    if(!materials.data||blocksView(materials))return;
    const scope=`${item.id}:${item.selectedRoundId??'current'}`,previous=lastMaterialRevision.current;
    lastMaterialRevision.current={scope,revision:materialRevision};
    if(previous?.scope!==scope||previous.revision===materialRevision)return;
    void queryClient.invalidateQueries({queryKey:['cases']});
    void queryClient.invalidateQueries({queryKey:['case-review'],predicate:query=>query.queryKey.includes(item.id)});
    void queryClient.invalidateQueries({queryKey:['document-processing-summary'],predicate:query=>query.queryKey.includes(item.id)});
  },[item.id,item.selectedRoundId,materialRevision,materials.data,materials.error]);
  const processing = useMaterialProcessing(item.id,rows);
  const selectedMaterial = rows.find(material => material.id === detailId);
  const processingFor=(material:Material)=>{const q=processing[rows.findIndex(row=>row.id===material.id)];return {data:q&&!blocksView(q)?q.data:undefined,error:q?.error};};
  const requestRemoval=(ids:string[])=>{if(!decisions||!canRemove)return;setRemoveError(undefined);setRemoval({ids,revision:decisions.revision,key:newKey(),caseId:item.id,roundId:item.selectedRoundId});};
  const removeFiles=async()=>{
    if(!removal||removePending.current||!canRemove)return;
    removePending.current=true;setRemoving(true);setRemoveError(undefined);
    try{
      await api(`/api/cases/${removal.caseId}/review/materials/remove`,{method:'POST',body:{documentVersionIds:removal.ids,expectedRevision:removal.revision,idempotencyKey:removal.key,reason:'从本轮待审文件列表移除',...(removal.roundId?{roundId:removal.roundId}:{})}});
      setRemoval(undefined);setDetailId(undefined);
      await Promise.all(['materials','case-review','case','cases','workbench','review-rounds','review-checklist','document-processing-summary'].map(name=>queryClient.invalidateQueries({queryKey:name==='materials'||name==='case'?[name,item.id]:[name]})));
    }catch(error){setRemoveError(error);}finally{removePending.current=false;setRemoving(false);}
  };
  const configurationNotice = !blocksView(materials) && rows.some(material => material.parseStatus === 'configuration_required');
  const canEnterReview = rows.length > 0 && !!decisions && !blocksView(materials) && !blocksView(review);
  const reviewPath = `/cases/${item.id}/review?mode=business&tab=checklist${item.selectedRoundId ? `&round=${encodeURIComponent(item.selectedRoundId)}` : ''}`;
  const extractionPath = caseExtractionPath(item.id, item.selectedRoundId);
  const resultsPath = `/cases/${item.id}/reports${item.selectedRoundId ? `?round=${encodeURIComponent(item.selectedRoundId)}` : ''}`;
  return <>
    <header className="materials-page-head">
      <div className="materials-page-title"><h2>{decisions?.roundNumber ? `第 ${decisions.roundNumber} 轮材料${decisions.readOnly ? '与记录' : ''}` : '本轮材料'}</h2>{decisions?.readOnly && <span className="status-mark status-mark-muted">只读</span>}</div>
      <div className="materials-page-actions">
        {!decisions?.readOnly && can(item.allowed_actions,'material:upload') && <Button disabled={!canUpload} onClick={() => inputRef.current?.click()}>上传文件</Button>}
        {!decisions?.readOnly && <Button type="primary" disabled={!canEnterReview} onClick={() => navigate(extractionPath)}>进入提取与核对</Button>}
        {decisions?.readOnly && <><LinkButton to={reviewPath}>查看本轮审查</LinkButton><LinkButton to={resultsPath}>查看本轮结果</LinkButton></>}
        {roundActions}
      </div>
    </header>
    <div className="materials-context">
      {decisions&&<MaterialGuaranteeSelection key={`guarantee:${item.id}:${item.selectedRoundId??'current'}`} state={decisions} disabled={blocksView(review)||uploadStates.some(upload=>upload.queued||upload.transmitting||!!upload.upload&&['issued','verifying'].includes(upload.upload.state))}/>}
      <span className="materials-context-item">审核配置 <b>{decisions?.configuration?.label ?? '待选择'}</b><MaterialReviewConfiguration item={item}/></span>
      <span className="materials-context-item">经办 <b>{item.makerDisplayName || '未指派'}</b>{caseActions}</span>
      {decisions?.readOnly && <span className="materials-context-note">{`本轮材料已锁定。可查看原件、字段核对与预审结果；${item.currentRoundId && item.selectedRoundId !== item.currentRoundId ? '切换到当前轮继续处理。' : '需要更换文件时，请准备下一轮。'}`}</span>}
    </div>
    <div className="materials-workspace"><div className="materials-main">
    <ProcessingAvailability item={item}/>
    {uploadStates.length > 0 && <details className="material-upload-details" key={`${item.id}:${item.selectedRoundId??'current'}`}>
      <summary>查看上传详情（{uploadStates.length}）{uploadStates.some(state => state.error || state.localError || ['rejected', 'expired'].includes(state.upload?.state ?? '')) && <span role="status"> · 有文件上传未完成，请展开查看</span>}</summary>
      <div className="material-upload-list" aria-label="本次上传记录">{uploadStates.map(state => <MaterialUploadStatus key={state.id} state={state} onReselect={canUpload ? () => inputRef.current?.click() : undefined}/>)}</div>
    </details>}
    <div className="material-file-section">
    {can(item.allowed_actions,'material:upload')&&<input className="visually-hidden" aria-hidden="true" id="material-file" ref={inputRef} type="file" multiple disabled={!canUpload} accept={materialAccept(capabilities.data?.docxUpload===true)} onChange={event=>{uploadFiles(Array.from(event.target.files??[]));event.target.value='';}} tabIndex={-1}/>}
    {blocksView(materials) ? <div className="section-notice"><ErrorNotice error={materials.error} retry={() => void materials.refetch()}/></div> : <div className="section-notice"><RefreshNotice query={materials} retry={() => void materials.refetch()}/></div>}
    {configurationNotice && <div className="section-notice"><ConfigurationRequired item={item}/></div>}
    {!!automaticProcessingError&&<div className="section-notice"><ErrorNotice error={automaticProcessingError}/></div>}
    {capabilities.data?.parsing===false&&rows.some(material=>['parked','capability_disabled','configuration_required'].includes(material.parseStatus))&&<div className="section-notice"><Alert type="warning" showIcon title="材料已保存，识别服务未启用" description="当前无法自动提取或识别材料类型，请联系管理员启用材料识别服务。完成提取后会更新右侧清单，无需重复上传。"/></div>}
    {review.error ? <div className="section-notice"><ErrorNotice error={review.error} retry={() => void review.refetch()}/></div> : null}
    {materials.isPending?<Loading/>:!blocksView(materials)&&<MaterialFileList key={`${item.id}:${item.selectedRoundId??'current'}`} rows={rows} caseId={item.id} roundId={item.selectedRoundId} state={decisions} roundLabel={decisions?.roundNumber?`第 ${decisions.roundNumber} 轮`:'本轮'} canRemove={canRemove} pending={removing} reader={!!capabilities.data?.documentReader} parsing={capabilities.data?.parsing} processing={processingFor} onRemove={requestRemoval} onDetails={material=>setDetailId(material.id)} historyAction={decisions&&canRemove&&canUpload&&can(item.allowed_actions,'evidence:read')&&(decisions.roundNumber??0)>1?<AddHistoricalMaterials state={decisions} disabled={removing||uploadStates.some(upload=>upload.queued||upload.transmitting||!!upload.upload&&['issued','verifying'].includes(upload.upload.state))}/>:undefined}/>}
    {!decisions?.readOnly && <section className={`workspace-upload${rows.length?' is-compact':''}${dragging?' is-dragging':''}${can(item.allowed_actions,'material:upload')?'':' is-readonly'}`} aria-label={can(item.allowed_actions,'material:upload')?'上传本轮材料':'本轮材料只读'} onDragOver={event=>{if(event.dataTransfer.types.includes('Files')){event.preventDefault();if(canUpload)setDragging(true);}}} onDragLeave={event=>{if(!event.currentTarget.contains(event.relatedTarget as Node|null))setDragging(false);}} onDrop={event=>{event.preventDefault();setDragging(false);uploadFiles(Array.from(event.dataTransfer.files));}}>
      {can(item.allowed_actions,'material:upload')?<Button type="text" block className="material-drop-trigger" disabled={!canUpload} onClick={() => inputRef.current?.click()} aria-label="上传本轮文件">
        <span><span className="workspace-upload-mark" aria-hidden="true">＋</span><strong>{rows.length?'拖入文件即可加入本轮':'上传本轮文件'}</strong><span className="material-drop-hint">拖放或点选 PDF、{capabilities.data?.docxUpload?'Word、':''}图片，可一次选择多份</span></span>
      </Button>:<><h2>本轮文件只读</h2><p>可在下方查看原件及版本。</p></>}
      {!capabilities.data?.registration&&can(item.allowed_actions,'material:upload')&&<p role="status">材料登记暂不可用，请稍后重试。</p>}
    </section>}
    {reviewEntry && <div className="materials-next">{reviewEntry}</div>}
    {!decisions?.readOnly && <footer className="materials-next"><p role="status">{materials.isPending || !decisions || blocksView(materials) || blocksView(review) ? '正在确认本轮材料与权限，请稍后重试。' : rows.length === 0 ? '请先上传文件或加入历史材料，再进入提取与核对。' : '对照原件查看文件提取结果，可切换本轮文件逐份核对。'}</p></footer>}
    <Modal title={`从本轮移除 ${removal?.ids.length??0} 份文件？`} open={!!removal} onCancel={()=>{if(!removing)setRemoval(undefined);}} onOk={()=>void removeFiles()} okText="确认移除" cancelText="取消" confirmLoading={removing} okButtonProps={{danger:true,disabled:!canRemove}} cancelButtonProps={{disabled:removing}} destroyOnHidden>
      <p>所选文件将退出本轮审核，原件和历史记录保留。</p><ul className="material-remove-files">{removal?.ids.map(id=><li key={id}>{rows.find(row=>row.id===id)?.filename??'所选文件'}</li>)}</ul><ErrorNotice error={removeError}/>
    </Modal>
    {selectedMaterial && !blocksView(materials) && <MaterialDetails material={selectedMaterial} caseId={item.id} state={decisions} processing={processingFor(selectedMaterial)} close={() => setDetailId(undefined)}/>}
    </div>
  </div><aside className="materials-requirements" tabIndex={0} aria-label="本轮配置材料要求"><h2>本轮材料清单</h2>{decisions?<PreparationChecklist state={decisions} materials={rows} history={blocksView(historicalMaterials)?[]:historicalMaterials.data?.items??[]}/>:<p>正在读取本轮材料要求…</p>}<ErrorNotice error={review.error}/></aside></div>
  </>;
}
function MaterialUploadStatus({state, onReselect}: {state: UploadState; onReselect?: () => void}) {
  const {settle, cancel, completeAgain, dismiss} = useUploads();
  const upload = state.upload;
  const canceled = state.canceled || upload?.state === 'canceled';
  const status = useQuery({queryKey: ['upload', upload?.id], enabled: !!upload && !state.transmitting && !state.actionPending && !terminalUpload(upload.state), queryFn: ({signal}) => api<UploadSession>(`/api/uploads/${upload!.id}`, {signal}), refetchInterval: query => terminalUpload(query.state.data?.state) ? false : 2000});
  useEffect(() => {if (status.data && status.data.state !== upload?.state) settle(state.id, status.data);}, [status.data, upload?.state, state.id, settle]);
  useEffect(() => {
    if (upload?.state === 'registered') {
      void queryClient.invalidateQueries({queryKey: ['materials', state.caseId]});
      void queryClient.invalidateQueries({queryKey: ['case', state.caseId]});
      void queryClient.invalidateQueries({queryKey: ['workbench']});
      void queryClient.invalidateQueries({queryKey: ['case-review']});
      void queryClient.invalidateQueries({queryKey: ['review-rounds']});
      dismiss(state.id);
    }
  }, [upload?.id, upload?.state, state.caseId, state.id, dismiss]);
  useEffect(() => {
    if (canceled && !state.actionPending && !state.error && !state.localError) dismiss(state.id);
  }, [canceled, state.actionPending, state.error, state.localError, state.id, dismiss]);
  // Registered files belong to the persistent list below, not the transient upload queue.
  if (upload?.state === 'registered' || canceled && !state.actionPending && !state.error && !state.localError) return null;
  const active = state.queued || state.transmitting || (!!upload && !terminalUpload(upload.state));
  const label = canceled ? state.actionPending ? '正在取消上传' : '已取消' : state.queued ? '等待上传' : state.transmitting ? '正在传输文件' : upload ? uploadLabels[upload.state] : '上传未完成';
  return <div className="material-upload-row" role="status" aria-live="polite" aria-label={`上传：${state.filename}`}>
    <div className="material-upload-info"><strong className="material-upload-name">{state.filename}</strong>
    <p className="material-upload-state">{label}{upload?.errorCode ? ` · ${errorLabels[upload.errorCode] ?? '登记未完成，请联系管理员核查上传记录。'}` : ''}</p>
    {state.transmitting && <Progress percent={state.progress} status="active" aria-label={`${state.filename} 文件传输进度`}/>}
    <ErrorNotice error={state.error}/>{state.localError && <Alert type="error" title={state.localError} showIcon/>}
    <ErrorNotice error={status.error} retry={() => void status.refetch()}/>
    </div>
    <div className="material-upload-actions">
      {!state.transmitting && upload?.state === 'issued' && <Button type="link" disabled={state.actionPending} onClick={() => void completeAgain(state.id)}>重新核验</Button>}
      {!active && !canceled && onReselect && <Button type="link" disabled={state.actionPending} onClick={onReselect}>重新选择文件</Button>}
      <Button type="link" danger disabled={state.actionPending} onClick={() => void cancel(state.id)}>取消上传</Button>
    </div>
  </div>;
}
function MaterialDetails({material, caseId, close,state,processing}: {material: Material; caseId: string; close: () => void;state?:ReviewState;processing?:{data?:ProcessingStatus;error?:unknown}}) {
  useRestoreFocus();
  return <Drawer title="材料详情" open onClose={close} size="min(520px, 100vw)" destroyOnHidden classNames={{body: 'detail-drawer'}} footer={can(material.allowed_actions, 'evidence:read') ? <Button type="primary" href={materialContentPath(caseId,material.id,true)} download={material.filename}>下载原件</Button> : undefined}><h2 className="filename">{material.filename}</h2>{isImage(material) && can(material.allowed_actions, 'evidence:read') && <div className="material-image-preview"><Link to={materialReaderPath(caseId,material.id,state?.roundId??(state?.legacyView?'legacy':undefined))} aria-label="在阅读器中预览原图"><img alt={material.filename} src={materialContentPath(caseId,material.id)} style={{width:'100%',maxHeight:'50dvh',objectFit:'contain'}}/></Link><p className="help-text">图片按单页材料自动识别、分类并提取字段，处理结果仍需核对。</p></div>}{material.parseStatus==='capability_disabled'?<DeferredMaterialStatus caseId={caseId} material={material}/>:<MaterialProcessing caseId={caseId} material={material} state={state} processing={processing?.data} error={processing?.error}/>}<dl className="detail-list"><div><dt>格式</dt><dd>{material.format?.toUpperCase() ?? '待确认'}</dd></div><div><dt>页数</dt><dd>{material.pageCount ?? '待确认'}</dd></div><div><dt>登记状态</dt><dd>已登记</dd></div><div><dt>解析状态</dt><dd>{fileProcessingLabel(material,processing?.data,processing?.error)}</dd></div><div><dt>固定版本标识</dt><dd><CopyValue value={material.ossVersionId} label="固定版本标识"/></dd></div><div><dt>SHA-256</dt><dd><CopyValue value={material.sha256} label="SHA-256"/></dd></div><div><dt>登记编号</dt><dd><CopyValue value={material.id} label="登记编号"/></dd></div><div><dt>文件大小</dt><dd className="mono">{formatSize(material.size)}</dd></div><div><dt>材料来源</dt><dd>{sourceLabel(material.source)}</dd></div><div><dt>上传人</dt><dd>{material.uploadedByName || '未提供姓名'}</dd></div><div><dt>登记时间</dt><dd><time dateTime={material.createdAt}>{formatTime(material.createdAt)}</time></dd></div></dl></Drawer>;
}

function DeferredMaterialStatus({caseId, material}: {caseId: string; material: Material}) {
  const processing = useQuery({queryKey: ['document-processing', caseId, material.id], queryFn: ({signal}) => api<ProcessingStatus>(`/api/cases/${caseId}/documents/${material.id}/processing`, {signal}), refetchInterval: 15_000});
  if (processing.data?.status === 'parked' && processing.data.errorCode === null) return <span>已获授权，待启动解析</span>;
  const message = deferredProcessingMessage(processing.data?.errorCode);
  return message ? <span>原件已保存<span className="table-sub">{message.replace(/^原件已保存，/, '')}</span></span> : <StatusText view={statusView(parseStatuses, material.parseStatus)}/>;
}
