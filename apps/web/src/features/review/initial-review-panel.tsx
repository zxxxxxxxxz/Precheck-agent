import React from 'react';
import {Tag} from 'antd';
import type {ChecklistRow} from '@hsbc/contracts/review-checklist';
import type {ReviewState} from '@hsbc/contracts/review';
import type {CheckerState} from '@hsbc/contracts/review-checker';
import {formatTime} from '../../shared/format.ts';
import {initialReviewProgress,initialReviewResult,initialReviewSubmission} from './initial-review-result.ts';
import './initial-review-result.css';

export function InitialReviewResult({row,state,checker}:{row:ChecklistRow;state:ReviewState;checker?:CheckerState}){
 const submission=initialReviewSubmission(state,checker);
 if(!submission)return null;
 const result=initialReviewResult(row,state,submission);
 return <section className="initial-review-result" aria-label="初审结果">
  <div className="initial-review-title"><h3>初审结果</h3><Tag>本轮复核：{initialReviewProgress[checker!.summary.status]}</Tag></div>
  <p className="initial-review-meta">{submission.makerName} · {formatTime(submission.createdAt)} 提交 · 第 {submission.number} 次提交</p>
  <p><strong>初审结论：{result?.hasFieldResult?result.label:'未记录本项核对结论'}</strong></p>
  {submission.validity==='stale'&&<p className="initial-review-meta">以下保留初审提交时的结果；当前更正及复核结果见下方。</p>}
  {result?.stale&&<p>该项核对依据在提交时已失效，需重新核对。</p>}
  {result?.fact?.rawValue&&<p>初审采用值：{result.fact.rawValue}{result.fact.automaticAdoption?'（自动采用）':''}</p>}
  {result?.reasons.map(reason=><p key={reason}>{reason}</p>)}
  {!!result?.actions.length&&<div><h4>初审待处理事项</h4><ul>{result.actions.map(action=><li key={action}>{action}</li>)}</ul></div>}
  {!!result?.corrections.length&&<div><h4>初审更正记录</h4>{result.corrections.map((c,i)=><p key={i}><del>{c.before}</del> → {c.after}。{c.reason}</p>)}</div>}
  <p className="initial-review-meta">以上为经办提交的核对结果；系统分析不代表初审人已逐项人工确认。</p>
 </section>;
}
