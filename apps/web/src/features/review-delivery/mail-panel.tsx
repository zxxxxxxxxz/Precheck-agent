import React,{useEffect,useRef,useState} from 'react';
import {App,Button,Checkbox,Select,Tag} from 'antd';
import {useQuery} from '@tanstack/react-query';
import type {DeliveryState,MailDraft,MailFormat} from '@hsbc/contracts/review-delivery';
import {api,ApiError,newKey,queryClient} from '../../api.ts';
import {useAuth} from '../../auth.tsx';
import {ErrorNotice,LinkButton,Loading,blocksView} from '../../ui.tsx';
import {formatTime} from '../../shared/format.ts';
import {EvidenceLinks} from '../review/evidence-links.tsx';
import {MailPreview} from './mail-preview.tsx';
import {ChecklistExportButton} from './checklist-export-button.tsx';
import './review-delivery.css';

const formatNames={rounds:'按轮次记录问题与回复',documents:'按文件组织邮件'};
const validityNames={current:'当前草稿',history:'历史轮次草稿',stale:'来源已有更新'};
export async function copyMailContent(value:{plainText:string;html:string}):Promise<'html'|'text'> {
  if(typeof ClipboardItem!=='undefined'&&navigator.clipboard?.write){
    try{await navigator.clipboard.write([new ClipboardItem({'text/plain':new Blob([value.plainText],{type:'text/plain'}),'text/html':new Blob([value.html],{type:'text/html'})})]);return 'html';}catch{/* Plain text remains a supported clipboard format. */}
  }
  if(!navigator.clipboard?.writeText)throw new Error('clipboard_unavailable');
  await navigator.clipboard.writeText(value.plainText);return 'text';
}
type MailPanelProps={presentation?:'full'|'report';caseId:string;runId:string;backTo?:string;onCompare?:()=>void;compareLabel?:string;comparison?:React.ReactNode;onDraft?:(draft:MailDraft|undefined)=>void};
export function MailPanel(props:MailPanelProps) {
  return <MailPanelScope key={`${props.caseId}:${props.runId}`} {...props}/>;
}
function MailPanelScope({presentation='full',caseId,runId,backTo,onCompare,compareLabel,comparison,onDraft}:MailPanelProps) {
  const alive=useRef(true);useEffect(()=>{alive.current=true;return()=>{alive.current=false;};},[]);
  const {session}=useAuth(),{message}=App.useApp(),base=`/api/cases/${caseId}/review-delivery`;
  const [format,setFormat]=useState<MailFormat>('documents'),[draftId,setDraftId]=useState<string>(),[replyIds,setReplyIds]=useState<string[]>([]);
  const [busy,setBusy]=useState(false),[error,setError]=useState<unknown>(),[fallback,setFallback]=useState<string>();
  const pending=useRef<{expectedRevision:number;idempotencyKey:string;runId:string;format:MailFormat;replyIds:string[]}|undefined>(undefined);
  const query=useQuery({queryKey:['review-delivery',session.user?.accountId,caseId],queryFn:({signal})=>api<DeliveryState>(base,{signal}),refetchInterval:30_000});
  const state=!blocksView(query)&&query.data?.caseId===caseId?query.data:undefined;
  const selected=draftId??state?.drafts.find(d=>d.runId===runId)?.id;
  const record=useQuery({queryKey:['review-mail',session.user?.accountId,caseId,selected],enabled:!!selected&&!!state?.allowedActions.includes('report:read'),queryFn:({signal})=>api<MailDraft>(`${base}/mail/${selected}`,{signal}),refetchInterval:30_000});
  const draft=!blocksView(record)&&record.data&&record.data.id===selected&&record.data.caseId===caseId&&record.data.runId===runId&&state?.allowedActions.includes('report:read')?record.data:undefined;
  useEffect(()=>{onDraft?.(draft);},[draft,onDraft]);
  const generate=async()=>{
    if(!state||busy)return;setBusy(true);setError(undefined);setFallback(undefined);
    pending.current??={expectedRevision:state.revision,idempotencyKey:newKey(),runId,format,replyIds};
    try{const created=await api<{id:string}>(`${base}/mail`,{method:'POST',body:pending.current});pending.current=undefined;if(!alive.current)return;setDraftId(created.id);
      await queryClient.invalidateQueries({queryKey:['review-delivery']});await message.success('邮件草稿已保存');
    }catch(e){if(alive.current){setError(e);if(e instanceof ApiError&&e.status>0)pending.current=undefined;}}finally{if(alive.current)setBusy(false);}
  };
  const copy=async()=>{
    if(!draft||busy)return;setBusy(true);setError(undefined);setFallback(undefined);
    try{const content=await api<{plainText:string;html:string}>(`${base}/mail/${draft.id}/copy`,{method:'POST'});
      if(!alive.current)return;try{const mode=await copyMailContent(content);await message.success(mode==='html'?'邮件标题和表格已复制':'已按纯文本复制');}catch{setFallback(content.plainText);}
    }catch(e){if(alive.current)setError(e);}finally{if(alive.current)setBusy(false);}
  };
  const canRead=state?.allowedActions.includes('report:read')===true;
  return <section id="report-mail" className="review-delivery report-mail" aria-label="预审邮件">
    <header className="report-mail-header">
      <div className="report-mail-title"><span className="report-step" aria-hidden="true">03</span><div><span className="report-eyebrow">预审邮件标题</span><h2>{canRead&&draft?draft.body.subject:'预审邮件'}</h2></div></div>
      <div className="report-mail-actions">{backTo&&<LinkButton to={backTo}>返回信息核对</LinkButton>}{compareLabel&&<Button disabled={!onCompare} onClick={onCompare}>{compareLabel}</Button>}{presentation==='report'&&canRead&&(!draft||draft.validity==='stale')&&state?.allowedActions.includes('report:generate')&&<Button type="primary" loading={busy} disabled={!state.runs.some(r=>r.id===runId&&r.state==='ready'&&r.validity==='current')} onClick={()=>void generate()}>{pending.current?'核对上次生成':'生成邮件草稿'}</Button>}{canRead&&draft?.canCopy&&<ChecklistExportButton key={`${session.user?.accountId}:${draft.id}`} draft={draft} onError={setError}/>}{canRead&&draft?.canCopy&&<Button type="primary" loading={busy} onClick={()=>void copy()}>复制邮件正文</Button>}</div>
    </header>
    {comparison}
    <ErrorNotice error={query.error} retry={()=>void query.refetch()}/>{query.isPending?<Loading/>:!state?null:<>
      {!canRead?<div className="report-mail-empty" role="status"><h3>暂时无法查看预审邮件</h3><p>尚无预审邮件读取权限，请联系有权限的管理员分配。</p></div>:<>
        {presentation==='full'&&<details className={`mail-options${draft?' mail-options-saved':''}`} open={!draft}><summary>{draft?'邮件格式、历史版本与外部回复':'准备邮件草稿'}</summary>
        {draft&&<div className="mail-version"><Tag>{validityNames[draft.validity]}</Tag><span>版本 {draft.version} · {formatTime(draft.createdAt)} · {formatNames[draft.format]}</span></div>}
        <div className="delivery-toolbar"><label>邮件格式<Select aria-label="邮件格式" value={format} disabled={busy||!!pending.current} onChange={setFormat} options={Object.entries(formatNames).map(([value,label])=>({value,label}))}/></label>
          {state.allowedActions.includes('report:generate')&&<Button type={draft?'default':'primary'} loading={busy} disabled={!state.runs.some(r=>r.id===runId&&r.state==='ready'&&r.validity==='current')} onClick={()=>void generate()}>{pending.current?'核对上次生成':'生成邮件草稿'}</Button>}
          <label>历史草稿<Select aria-label="历史邮件草稿" value={selected} disabled={busy} onChange={id=>{setDraftId(id);setFallback(undefined);}} placeholder="尚未生成" options={state.drafts.filter(d=>d.runId===runId).map(d=>({value:d.id,label:`版本 ${d.version} · ${formatTime(d.createdAt)} · ${validityNames[d.validity]}`}))}/></label>
        </div>
        {state.allowedActions.includes('report:generate')&&state.replies.length>0&&<details><summary>选择允许写入邮件的外部回复（已选 {replyIds.length} 条）</summary><p>默认不带入回复；只勾选可对外提供的内容。内部处置理由不会自动复制。</p>
          {state.replies.map(reply=><div className="delivery-reply" key={reply.id}><Checkbox checked={replyIds.includes(reply.id)} disabled={busy||!!pending.current} onChange={e=>setReplyIds(ids=>e.target.checked?[...ids,reply.id]:ids.filter(id=>id!==reply.id))}>{reply.externalAuthor} · {formatTime(reply.receivedAt)}</Checkbox><p>{reply.text}</p></div>)}
        </details>}
        </details>}
        <ErrorNotice error={error}/><ErrorNotice error={record.error} retry={()=>void record.refetch()}/>
        {record.isFetching&&!draft&&<p role="status">正在读取邮件草稿…</p>}
        {!draft&&!record.isFetching&&!record.error&&<div className="report-mail-empty"><h3>尚未生成邮件草稿</h3><p>完成有效预审后生成邮件草稿；未完成检查不能作为完成结果输出。</p></div>}
        {draft&&<>
          {draft.staleReasons.length>0&&<p role="status" className="tone-warning">{draft.staleReasons.join('；')}。复制内容会保留历史提示。</p>}
          <p className="mail-confirmation">{draft.checkerPending?`待复核版本 · 第 ${draft.checkerPending.submissionNumber} 次提交 · ${formatTime(draft.checkerPending.submittedAt)}`:draft.checkerConfirmation?`${draft.checkerConfirmation.validity==='current'?'已复核版本':'历史已复核版本'} · 第 ${draft.checkerConfirmation.submissionNumber} 次提交 · ${formatTime(draft.checkerConfirmation.confirmedAt)}`:draft.validity==='current'?'预审草稿 · 尚未独立复核':'历史版本 · 仅供回看，不代表当前结果'}</p>
          {!draft.body.fieldReviewSummary&&<p className="tone-warning">此邮件保留生成时的核对结果。后续字段确认不会自动更新本版本，请通过本轮更正重新预审并生成邮件。</p>}
          <MailPreview key={draft.id} body={draft.body} format={draft.format} validity={draft.validity} showSubject={false} showAllChecks={presentation==='report'}/>
          {presentation==='full'&&<details><summary>查看规则和原文依据（此部分不随邮件复制）</summary>{draft.body.rows.map(row=><article key={row.key}><h4>{row.objectLabel} · {row.ruleLabel}</h4>{row.documentIds.map(documentId=><EvidenceLinks key={documentId} caseId={caseId} roundId={draft.body.documentRounds?.[documentId]??null} evidence={row.evidence.filter(e=>e.documentVersionId===documentId)} names={Object.fromEntries(row.documentIds.map((id,i)=>[id,row.documentLabels[i]!]))}/>)}{row.sourceReferences.map(ref=><p className="delivery-reference" key={ref}>{ref}</p>)}</article>)}</details>}
        </>}
        {fallback&&<div><p role="status">浏览器未允许自动复制，请在下方选中正文后复制。</p><textarea className="delivery-copy" aria-label="可手动复制的邮件正文" readOnly value={fallback} onFocus={e=>e.currentTarget.select()}/></div>}
      </>}
    </>}
  </section>;
}
