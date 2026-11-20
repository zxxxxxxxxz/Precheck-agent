import React from 'react';
import {Button,Modal,Table} from 'antd';
import {Link} from 'react-router';
import type {CheckerSubmission} from '@hsbc/contracts/review-checker';
import type {MailBody} from '@hsbc/contracts/review-delivery';
import {formatTime} from '../../shared/format.ts';
import {EvidenceLinks} from '../review/evidence-links.tsx';
import {FormalResultsTable} from './formal-results-table.tsx';
import {MailPreview} from '../review-delivery/mail-preview.tsx';

export function SubmissionSnapshot({caseId,submission:s,close}:{caseId:string;submission:CheckerSubmission;close:()=>void}){
 const snapshot=s.snapshot as any,review=snapshot.reviewSnapshot;
 return <Modal open title={`第 ${s.roundNumber} 轮 · 第 ${s.number} 次复核提交`} width={1050} onCancel={close} footer={<Button onClick={close}>关闭</Button>} destroyOnHidden>
  <div className="checker-snapshot"><p>{s.makerName} → {s.checkerName} · 提交于 {formatTime(s.createdAt)}</p><p>提交说明：{s.reason}</p>{s.decidedAt&&<p>决定于 {formatTime(s.decidedAt)} · {s.decisionReason}</p>}<p className="help-text">以下内容固定于提交时。原文入口绑定当时的轮次，后续更正不会覆盖此记录。</p>
   <h3>材料与配置</h3><p>配置：{snapshot.configurationReleaseId}</p><ul>{(review?.materials??[]).map((m:any)=><li key={`${m.documentVersionId}:${m.logicalDocumentId??''}`}><Link to={`/cases/${caseId}/review?document=${m.documentVersionId}&round=${s.roundId}`}>{snapshot.sources.find((d:any)=>d.id===m.documentVersionId)?.filename??m.documentTypeId}</Link> · {review.materialScope==='file-list'?'本轮材料':m.operation==='adopt'?'已采用':'未采用'} · 来源版本 {m.sourceSha256.slice(0,12)}</li>)}</ul>
   <h3>已确认事实与原文</h3><Table rowKey="factId" size="small" dataSource={review?.facts??[]} pagination={{pageSize:8}} scroll={{x:750}} columns={[{title:'对象',key:'object',render:(_,f:any)=>review.objects.find((o:any)=>o.objectId===f.objectId)?.label??'未确认对象'},{title:'字段',key:'field',render:(_,f:any)=>snapshot.configuration?.fields.find((v:any)=>v.id===f.fieldId)?.label??f.fieldId},{title:'事实',key:'value',render:(_,f:any)=>f.rawValue??f.state},{title:'版本',dataIndex:'version'},{title:'来源',key:'evidence',render:(_,f:any)=><EvidenceLinks caseId={caseId} roundId={s.roundId} evidence={f.evidence??[]}/>} ]}/>
   <h3>事实确认及更正记录</h3>{(snapshot.factHistory??[]).map((f:any)=><article key={`${f.fact_id}:${f.version}`} className="checker-record"><strong>{snapshot.configuration?.fields.find((v:any)=>v.id===f.field_id)?.label??f.field_id} · 版本 {f.version}</strong><p>{f.body.rawValue??f.body.state}</p><p>{f.reason} · {formatTime(f.created_at)} · 记录人员 {f.confirmed_by.slice(0,8)}</p><EvidenceLinks caseId={caseId} roundId={s.roundId} evidence={f.body.evidence??[]}/></article>)}
   <h3>检查与处理</h3><Table rowKey="evaluationId" size="small" dataSource={snapshot.results??[]} pagination={{pageSize:8}} columns={[{title:'规则',key:'rule',render:(_,r:any)=>snapshot.configuration?.rules.find((v:any)=>v.id===r.ruleId)?.label??r.ruleId},{title:'原始结果',dataIndex:'outcome'},{title:'依据',dataIndex:'reasonCode'}]}/>
   {(snapshot.replies??[]).map((r:any)=><article className="checker-record" key={r.id}><p>{r.details.text??r.details.reason}</p></article>)}
   {(snapshot.dispositions??[]).map((d:any)=><article className="checker-record" key={d.id}><strong>{d.rule_id}</strong><p>{d.reason}</p><p>{d.external_author} · {d.source}</p><EvidenceLinks caseId={caseId} roundId={s.roundId} evidence={d.evidence??[]}/></article>)}
   {snapshot.formalDetails&&<><h3>本次提交的正式审核与原文</h3><FormalResultsTable caseId={caseId} roundId={s.roundId} {...snapshot.formalDetails}/></>}
   {(snapshot.returnItems??[]).length>0&&<h3>历史退回事项及经办回复</h3>}{(snapshot.returnItems??[]).map((i:any)=><article className="checker-record" key={i.id}><p>{i.text}</p>{i.responses.map((r:any)=><p key={r.id}>{r.text}</p>)}</article>)}
   <h3>本次提交的邮件</h3>{snapshot.mail?<><p>版本 {snapshot.mail.version}</p><MailPreview body={snapshot.mail.body as MailBody} format={snapshot.mail.format} validity="history"/></>:<p>无邮件版本</p>}
  </div>
 </Modal>;
}
