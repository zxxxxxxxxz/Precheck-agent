import {FieldWorkflow} from './field-workflow.tsx';
import type {FieldDecision} from './field-decision.ts';
import {FieldDecisionStrip} from './field-decision-strip.tsx';
import {verifiedFieldDecision} from './field-disposition.ts';
import React,{useRef,useState} from 'react';
import {Button} from 'antd';
import {useQueryClient} from '@tanstack/react-query';
import {SaveFieldReviewSchema,isVerifiedSourceFact,type FieldVerification} from '@hsbc/contracts/field-verification';
import type {ChecklistRow} from '@hsbc/contracts/review-checklist';
import type {ReviewState} from '@hsbc/contracts/review';
import {api,newKey} from '../../api.ts';
import {ErrorNotice} from '../../ui.tsx';
import {fieldBusinessRules,fieldRuleSummary} from './field-comparison.ts';
import {verificationOriginals,verificationComparison} from './field-verification-presentation.ts';
import {EvidenceLinks} from './evidence-links.tsx';
import './field-verification.css';
import {BilingualEvidenceRail,type EvidenceTranslationProps} from './bilingual-evidence-rail.tsx';
import {EvidenceContent} from './evidence-content.tsx';
import {fieldReviewLabels} from './field-review-status.ts';
export {checklistReviewLabel,checklistReviewStatus,fieldReviewLabels,hasCustomerAddressBusinessCheck} from './field-review-status.ts';
function marked(text:string,words:string[]){const escaped=words.filter(w=>text.includes(w)).sort((a,b)=>b.length-a.length).map(s=>s.replace(/[.*+?^${}()|[\]\\]/g,'\\$&'));if(!escaped.length)return text;const re=new RegExp('('+escaped.join('|')+')','gu');return text.split(re).map((part,i)=>words.includes(part)?<mark key={i}>{part}</mark>:part);}
export function FieldVerificationView({record,row,state,onEditObject,onEditFact,decision:business}:{decision?:FieldDecision;record:FieldVerification;row:ChecklistRow;state:ReviewState;onEditObject:()=>void;onEditFact?:()=>void}){
 const decision=verifiedFieldDecision(record,business);
 const {sources:displaySources,crossFile,missingCounterpart}=verificationComparison(record),rules=fieldBusinessRules(row);
 const original=(source:FieldVerification['sources'][number],i:number)=><article key={i}><h4>原文 · {source.filename}</h4><small>{source.evidence.sourceNodeId?'Word 原文段落':`第 ${source.page} 页`}</small><EvidenceContent text={source.quote} highlights={source.highlights}/><EvidenceLinks caseId={state.caseId} evidence={[source.evidence]} names={{[source.evidence.documentVersionId]:source.filename}} roundId={state.roundId}/></article>;
 const current=record.validity==='current',label=current?fieldReviewLabels[record.status]:'待确认';
 const detail=!current?'材料或案件信息已变化，需要重新核对':record.status==='confirmed'?(isVerifiedSourceFact(record)?'原文事实已核实':'字面相同'):record.status==='consistent'?'语义一致，字面不同':record.status==='different'?'已发现具体差异':record.status==='not_applicable'?'本项不适用':'仍有具体事项需要确认';
 return <><div className="field-comparison-heading"><h3>字段核对结果</h3><strong className={`field-verification-status-${record.status}`}>{label} · {detail}</strong></div>
 <div className="field-verified-comparison"><p>{current?record.reason:'以下保留上次核对依据，不计入当前已确认或一致结果。'}</p><div className={`field-verified-sources${crossFile?'':' field-verified-rule-pair'}`}>
 {crossFile?<>{displaySources.map(original)}{missingCounterpart&&<article><h4>对应文件原文</h4><p>尚未定位到另一份文件的原文。</p></article>}</>:<><section aria-label="文件原文">{displaySources.length?displaySources.map(original):<article><h4>文件原文</h4><p>尚未定位到本字段的原文。</p></article>}</section>
 <section className="field-verified-rule" aria-label="规则基准"><h4>规则基准</h4>{rules.length?rules.map(rule=><div key={rule.id}><h5>{rule.label}</h5><p>{rule.text}</p></div>):<><small>字段核验要求</small><p>{fieldRuleSummary(row.definition)||'本字段尚未配置具体核验要求。'}</p></>}</section></>}
 </div></div>
 <FieldDecisionStrip decision={decision}/>
 {!!record.corrections.length&&<section className="field-verified-corrections"><h3>提取错字已更正</h3>{record.corrections.map((c,i)=><p key={i}><del>{c.before}</del> → <mark>{c.after}</mark>。{c.reason} 原提取记录保留，当前显示使用更正值。</p>)}</section>}
 {!!decision.conditions?.length&&<section className="field-verified-actions"><h3>具体需要确认的事项</h3><ul>{decision.conditions.map(condition=><li key={condition.id}>{condition.detail}</li>)}</ul></section>}
 <FieldWorkflow row={row} state={state} decision={{...decision,workflow:business?.workflow}} onEditObject={onEditObject} onEditFact={onEditFact}/></>;
}
export function FieldVerificationEvidence({record,state,...translation}:{record:FieldVerification;state:ReviewState}&EvidenceTranslationProps){
 const sources=verificationOriginals(record);
 return <BilingualEvidenceRail {...translation} caseId={state.caseId} roundId={state.roundId} names={Object.fromEntries(sources.map(s=>[s.evidence.documentVersionId,s.filename]))}
   context={record.validity==='current'?'本次核对依据。':'上次核对依据，材料已变化，需重新核对。'}
   readings={sources.map(s=>({sources:[s.evidence],text:s.quote,pageNumber:s.evidence.sourceNodeId?undefined:s.page,highlights:s.highlights}))}/>;
}
/** Explicit, authenticated import into the current case; never a report-only overlay. */
export function ImportFieldReview({state}:{state:ReviewState}){
 const file=useRef<HTMLInputElement>(null),cache=useQueryClient(),[busy,setBusy]=useState(false),[error,setError]=useState<unknown>(),[note,setNote]=useState('');
 const save=async(selected:File)=>{setBusy(true);setError(undefined);setNote('');try{
  if(selected.size>4*1024*1024)throw new Error('核对记录超过可导入大小。');
  const input=SaveFieldReviewSchema.parse(JSON.parse(await selected.text()));
  // Preserve the prepared revision/round; do not silently rebase a stale result.
  if(input.expectedRevision!==state.revision||input.roundId!==state.roundId||input.configurationReleaseId!==state.configurationReleaseId)throw new Error('核对记录对应的案件版本、轮次或配置已变化，请重新核对。');
  await api(`/api/cases/${state.caseId}/review/field-verifications`,{method:'POST',body:{...input,idempotencyKey:newKey()},timeoutMs:120000});
  await cache.invalidateQueries();setNote('核对结果及提取更正已保存到本案件。');
 }catch(e){setError(e);}finally{setBusy(false);if(file.current)file.current.value='';}};
 if(state.readOnly||!state.allowedActions.includes('field:correct'))return null;
 return <div className="field-verification-import"><Button size="small" loading={busy} onClick={()=>file.current?.click()}>导入核对记录</Button><input ref={file} type="file" accept="application/json,.json" aria-label="选择核对记录文件" hidden onChange={e=>{const f=e.target.files?.[0];if(f)void save(f);}}/><ErrorNotice error={error}/>{note&&<span role="status">{note}</span>}</div>;
}
