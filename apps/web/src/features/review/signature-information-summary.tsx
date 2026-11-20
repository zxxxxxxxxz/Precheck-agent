import React from 'react';
import {Button} from 'antd';
import {Link} from 'react-router';
import type {SignatureInformationSummary} from '@hsbc/contracts/signature-information';
import {signatureCheckLabels,signatureReason,downloadSignatureInformation} from '../documents/signature-information-presentation.ts';
import '../documents/signature-information.css';
export function SignatureInformationSummaryView({caseId,items,roundId,issuesOnly=false}:{caseId:string;items:SignatureInformationSummary[];roundId?:string|null;issuesOnly?:boolean}){
 if(!items.length)return null;
 return <section className="signature-info-summary" aria-label="案件签署核对"><h3>签署与授权核对</h3><p>签署子项按已确认的适用要求判断；案件结论仍需复核。</p>{items.map(s=><details key={s.documentId} open={issuesOnly||s.evaluation.blocking||s.validity==='stale'}><summary>{s.filename} · {s.version?`核对版本 ${s.version}`:'尚未核对'} · {s.validity==='stale'?'已失效':s.evaluation.blocking?'有强制事项待处理':'查看核对记录'}</summary><p>签名记录 {s.evaluation.counts.signatures} · 确认独立人员 {s.evaluation.counts.people} · 已满足要求 {s.evaluation.counts.satisfied} · 待核对事项 {s.evaluation.counts.pending}</p><ul>{s.evaluation.checks.filter(c=>!issuesOnly||!['satisfied','not_applicable'].includes(c.status)||s.validity==='stale').map(c=><li key={c.id}><strong>{c.label}</strong> · {s.validity==='stale'?'已失效 / 需要重新核对':signatureCheckLabels[c.status]}{c.mandatory?' · 强制项':''}{c.reasons.map(reason=><div key={reason}>{signatureReason(reason)}</div>)}</li>)}</ul><Link to={`/cases/${caseId}/review?document=${s.documentId}&panel=signatures${s.version>0?`&signatureRecord=${s.recordId}`:''}${roundId?`&round=${roundId}`:''}`}>查看要求、人员、日期与原件依据</Link> <Button onClick={()=>downloadSignatureInformation(s)}>导出本版本签署核对</Button></details>)}</section>;
}
