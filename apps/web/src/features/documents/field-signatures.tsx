import React from 'react';
import type {DocumentFieldPresentation} from '@hsbc/contracts/document-presentation';
import type {SignatureBox} from '@hsbc/contracts/signature-review';
import type {AutomaticSignatureValue} from '@hsbc/contracts/signature-information';

/** Same source records as the signature panel; one complete block per signing record. */
export function FieldSignatureRecords({field,onLocate,onEvidence}: {
  field:DocumentFieldPresentation;onLocate:(page:number,box:SignatureBox)=>void;onEvidence?:(ids:string[],page?:number)=>void;
}) {
  const source=field.signatureRecords;
  if(!source)return null;
  const value=(label:string,item:AutomaticSignatureValue|null|undefined,page:number)=> <div key={label}><dt>{label}</dt><dd>{item?<button type="button" className="evidence-value-link"
    aria-label={`定位${label}：${item.value}`} disabled={!item.box&&!item.evidence.some(ref=>ref.anchorId)&&!onEvidence}
    onClick={event=>{event.stopPropagation();if(item.box)onLocate(page,item.box);else onEvidence?.(item.evidence.filter(ref=>ref.documentVersionId===field.documentVersionId&&ref.parseRevision===field.parseRevision).flatMap(ref=>ref.anchorId?[ref.anchorId]:[]),page);}}>{item.value}</button>:<span className="muted">未提取到</span>}</dd></div>;
  const heading=({cgt_field_15:'有限公司签署-董事/秘书签署',cgt_field_20:'见证人签署',cgt_field_30:'董事/股东/会议主席签署',cgt_field_31:'授权签字样式',pg_field_12:'保证人签署',pg_field_22:'发票人签署'} as Record<string,string>)[field.fieldId];
  const personal=field.fieldId==='pg_field_12',note=field.fieldId==='pg_field_22';
  const presence={graphic:'已检测到签字图形',handwriting:'已检测到手写签字',printed:'仅检测到打印文字',blank:'空白签署栏',stamp:'检测到印章',unknown:'无法判断是否有签字'};
  return <div className="signature-details field-signature-records" data-signature-field aria-label={`${field.fieldLabel}自动识别结果`}>
    {source.records.map((record,index)=><section className="signature-person-details" key={record.id} aria-label={heading??record.name?.value??'签署记录'}>
      <div className="signature-person-heading"><h4>{heading?`${heading}${source.records.length>1?index+1:''}`:record.name?.value||'签署记录'}</h4><span>{/witness/i.test(record.role?.value??'')?'见证人 · ':''}第 {record.pageNumber} 页</span></div>
      <dl><div><dt>{source.purpose==='specimen'?'签字样本':'是否签字'}</dt><dd><button type="button" className="evidence-value-link" aria-label={`定位签字：${heading??record.name?.value??'签署记录'}`} onClick={event=>{event.stopPropagation();onLocate(record.pageNumber,record.box);}}>{presence[record.presence]}</button></dd></div>
        {!note&&value('姓名',record.name,record.pageNumber)}
        {!personal&&!note&&record.role&&value('职位',record.role,record.pageNumber)}
        {personal&&value('身份证号码',record.number,record.pageNumber)}
        {(record.address||personal)&&value(personal?'地址':record.address?.label??'地址',record.address,record.pageNumber)}
        {!personal&&!note&&record.number&&value(record.number.label,record.number,record.pageNumber)}
        {record.dates.filter(date=>date.value.trim()).map(date=>value(date.label,date,record.pageNumber))}
      </dl>
    </section>)}
    {source.coverageIncomplete&&source.state!=='unavailable'&&<p className="signature-details-note">部分签署页面未核查</p>}
  </div>;
}
