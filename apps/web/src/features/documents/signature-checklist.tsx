import React from 'react';
import {Button} from 'antd';
import type {SignatureInformationProjection, SignatureInformationState} from '@hsbc/contracts/signature-information';
import type {SignatureEditor} from './signature-checklist-presentation.ts';
import type {FieldsResponse} from './types.ts';
import type {SignatureBox} from '@hsbc/contracts/signature-review';
import {signatureDetails, type SignatureDetailValue} from './signature-details.ts';
import './signature-details.css';

type Props={coveredAutomaticRecordIds?:readonly string[];data:SignatureInformationProjection;state:SignatureInformationState;fields?:FieldsResponse;includeFields:boolean;disabled:boolean;dirty:boolean;onEdit:(section:SignatureEditor,id?:string)=>void;onEvidence:(ids:string[],page?:number)=>void;onEntry:(id:string)=>void;onLocate:(page:number,box:SignatureBox)=>void};
function Value({item,data,onEvidence,onLocate}: {item:SignatureDetailValue}&Pick<Props,'data'|'onEvidence'|'onLocate'>){
  const own=item.evidence.filter(e=>e.documentVersionId===data.documentId&&e.parseRevision===data.parseRevision);
  const external=item.evidence.filter(e=>e.documentVersionId!==data.documentId||e.parseRevision!==data.parseRevision);
  return <div className="signature-detail-value">{item.box||own.some(e=>e.anchorId)||item.pages.length?<button type="button" className="evidence-value-link" aria-label={`定位${item.label}：${item.value}`}
    onClick={()=>item.box&&item.pages[0]?onLocate(item.pages[0],item.box):onEvidence([...new Set(own.flatMap(e=>e.anchorId?[e.anchorId]:[]))],item.pages[0])}>{item.value}</button>:<span>{item.value}</span>}
    {external.map((ref,i)=><a key={i} href={`/cases/${data.caseId}/review?${new URLSearchParams({document:ref.documentVersionId,...(ref.parseRevision?{parse:ref.parseRevision}:{}),...(ref.anchorId?{anchor:ref.anchorId}:{}),...(data.roundId?{round:data.roundId}:{})})}`} target="_blank" rel="noreferrer">来源 {i+1}</a>)}
  </div>;
}
export function SignatureChecklist(props:Props){
  const {data,state,fields,includeFields,disabled,dirty,onEdit,onEntry}=props;
  const details=signatureDetails(data,state,fields,includeFields,dirty,props.coveredAutomaticRecordIds);
  return <div className="signature-details">
    {!details.records.length&&<p className="signature-details-status">是否有签字：待查看原件</p>}
    {details.extracted.length>0&&<section className="signature-extracted-details" aria-label="原文提取的签署信息"><h4>文件与其他签署信息</h4><p className="signature-details-note">文件日期与个人日期分别展示。</p>
      <dl>{details.extracted.map((item,i)=><div key={i}><dt>{item.label}</dt><dd><Value {...props} item={item}/></dd></div>)}</dl>
    </section>}
    {details.records.map(record=><section className="signature-person-details" key={record.id} aria-label={record.title}>
      <div className="signature-person-heading"><h4>{record.title}</h4>{record.pages.length>0&&<span>第 {[...new Set(record.pages)].join('、')} 页</span>}</div>
      <dl><div><dt>是否签字</dt><dd><div className="signature-detail-value"><button type="button" className="evidence-value-link" disabled={!record.automaticBox&&!record.entry} onClick={()=>record.automaticBox?props.onLocate(record.pages[0]!,record.automaticBox):record.entry&&onEntry(record.entry.id)}>{record.presence}</button></div>{record.entry?.duplicateOf&&<span className="signature-details-note"> · 重复记录</span>}</dd></div>
        {[...new Set(record.fields.map(item=>item.label))].map(label=><div key={label}><dt>{label}</dt><dd>{record.fields.filter(item=>item.label===label).map((item,i)=><Value key={i} {...props} item={item}/>)}{[...new Set(record.fields.filter(item=>item.label===label).flatMap(item=>item.note&&item.note!=='已提取'?[item.note]:[]))].map(note=><p className="signature-details-note" key={note}>{note}</p>)}</dd></div>)}
      </dl>
      {record.entry&&<div className="signature-details-actions"><Button type="link" onClick={()=>onEdit('locations',record.entry!.id)}>{disabled?'查看记录':'更正信息'}</Button></div>}
    </section>)}
    {!details.records.length&&!details.extracted.length&&<p className="signature-details-note">暂无可展示的签署信息，可先查看原件。</p>}
    {fields?.filterJob&& !['ready','completed'].includes(fields.filterJob.status)&&includeFields&&<p className="signature-details-note" role="status">字段提取尚未完整完成，缺少信息不代表原件未填写。</p>}
    {includeFields&&!!data.automatic?.coverage.unavailablePages.length&&<p className="signature-details-note">部分页面暂未完成签署信息提取，未显示不代表没有签字。</p>}
    {dirty&&<p className="signature-details-note" role="status">修改尚未保存。</p>}
  </div>;
}
