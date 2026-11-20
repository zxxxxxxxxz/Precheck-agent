import React from 'react';
import {Link} from 'react-router';
import type {CheckerBlocker} from '@hsbc/contracts/review-checker';
import './submission-readiness.css';

export function SubmissionPrerequisites({caseId,roundId,blockers,onNavigate}:{caseId:string;roundId:string;blockers:CheckerBlocker[];onNavigate?:()=>void}) {
 const base=`/cases/${caseId}`,round=encodeURIComponent(roundId);
 return <ul className="submission-prerequisites">{blockers.map((blocker,index)=>{
  const mail=['checker_mail_required','checker_mail_stale'].includes(blocker.code);
  const assignment=['checker_assignment_required','checker_not_independent_or_authorized','maker_qualification_required'].includes(blocker.code);
  const path=mail?`${base}/reports?round=${round}`:assignment?`${base}/collaboration?round=${round}`:`${base}/review?mode=business&round=${round}`;
  return <li key={`${blocker.code}:${index}`}><span>{blocker.label}</span><Link to={path} onClick={onNavigate}>{mail?'处理本轮邮件':assignment?'查看人员与授权':'核对本轮结果'}</Link></li>;
 })}</ul>;
}

export function PendingReviewFindings({items,submitted=false}:{items:CheckerBlocker[];submitted?:boolean}) {
 if(!items.length)return null;
 return <div className="submission-findings">
  <strong>{items.length} 项问题{submitted?'未解决，保留至后续轮次':'将随结果一并提交'}</strong>
  <p>{submitted?'复核确认仅确认本轮审核结果，未解决事项可在下一轮继续处理。':'未解决和待人工确认的事项会保留原状态，交由复核人继续审核。'}</p>
  <details><summary>查看问题清单</summary><ul>{items.map((item,index)=><li key={`${item.code}:${index}`}>{item.label}</li>)}</ul></details>
 </div>;
}
