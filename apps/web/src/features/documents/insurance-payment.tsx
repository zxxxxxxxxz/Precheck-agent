import React,{useState} from 'react';
import {Drawer,Select} from 'antd';
import {useQuery} from '@tanstack/react-query';
import {Link} from 'react-router';
import {api} from '../../api.ts';
import {ErrorNotice,Loading} from '../../ui.tsx';
import {fieldCandidateDisplayText} from '@hsbc/contracts/document-presentation';
import type {Material} from '../materials/types.ts';
import type {FieldsResponse,ProcessingStatus,DocumentFieldObservation} from './types.ts';
import {paymentReferenceMatch} from './insurance-presentation.ts';
import {presentationFieldObservation,requiresFieldSemanticFilter} from './presentation.ts';

export function InsurancePaymentEvidence({caseId,documentId,materials,insuranceFields,close}:{caseId:string;documentId:string;materials:Material[];insuranceFields:DocumentFieldObservation[];close:()=>void}) {
  const choices=materials.filter(material=>material.id!==documentId&&material.allowed_actions.includes('evidence:read'));
  const [selected,setSelected]=useState<string>();
  const result=useQuery({queryKey:['insurance-payment-evidence',caseId,selected],enabled:!!selected,queryFn:async({signal})=>{
    const base=`/api/cases/${encodeURIComponent(caseId)}/documents/${encodeURIComponent(selected!)}`;
    const processing=await api<ProcessingStatus>(`${base}/processing`,{signal});
    if(!processing.parseRevision||processing.status==='stale')return null;
    return api<FieldsResponse>(`${base}/fields?parseRevision=${encodeURIComponent(processing.parseRevision)}`,{signal});
  }});
  const fields=(result.data?.presentationItems??result.data?.items??[]).filter(field=>field.documentVersionId===selected&&field.parseRevision===result.data?.parseRevision)
    .map(field=>presentationFieldObservation(field,requiresFieldSemanticFilter(field.fieldId,result.data??undefined)));
  const relevant=fields.filter(field=>['insurance_payment_evidence','invoice_policy_reference','payment_policy_reference','invoice_date','invoice_item','invoice_total_amount','invoice_currency'].includes(field.fieldId));
  const matching=paymentReferenceMatch(insuranceFields,fields);
  const url=(field?:DocumentFieldObservation)=>`/cases/${encodeURIComponent(caseId)}/review?document=${encodeURIComponent(selected!)}${result.data?`&parse=${encodeURIComponent(result.data.parseRevision)}`:''}${field?.anchorIds[0]?`&anchor=${encodeURIComponent(field.anchorIds[0])}&page=${field.pageNumbers[0]??1}`:''}`;
  return <Drawer open title="核对保费支付凭证" size="large" onClose={close} destroyOnHidden>
    <div className="insurance-payment-content">
      <p>选择本案中的独立凭证，核对银行要求的保费发票等凭证及对应保险编号。</p>
      <Select aria-label="选择支付凭证材料" placeholder="选择已登记的材料" value={selected} onChange={setSelected} options={choices.map(material=>({value:material.id,label:material.filename}))}/>
      {!choices.length&&<p>暂无其他可读取材料，请先登记支付凭证。</p>}
      {selected&&result.isPending&&<Loading/>}
      <ErrorNotice error={result.error} retry={()=>void result.refetch()}/>
      {selected&&!result.isPending&&!result.error&&<>
        <p>{matching==='matching'?'保险关联编号一致；请核对原件和付款状态。':matching==='different'?'已提取的保险关联编号不一致，请查看原件确认。':'保险关联编号缺失或存在多个候选，请人工核对。'}</p>
        <p className="muted">银行要求保单投保单号与发票保／批单号一致。发票可满足凭证材料要求；实际缴费状态仍须有收付依据。</p>
        <Link to={url()} onClick={close}>打开所选凭证原件</Link>
        {!result.data&&<p>这份材料尚无当前可用的识别结果，请查看原件。</p>}
        <div className="insurance-payment-fields">{relevant.map(field=><article key={field.id}><strong>{field.fieldLabel}</strong>
          {field.candidates.length?field.candidates.map((candidate,index)=><p key={index}>{fieldCandidateDisplayText(candidate)}</p>):<p className="muted">尚无有依据的值</p>}
          {field.anchorIds.length>0&&<Link to={url(field)} onClick={close}>查看原文依据</Link>}
        </article>)}</div>
      </>}
    </div>
  </Drawer>;
}
