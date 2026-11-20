import {ExtractionNotice} from './extraction-notice.tsx';
import React, {useState} from 'react';
import {Button, Segmented, Table} from 'antd';
import type {TableProps} from 'antd';
import {fieldCandidateDisplayText,fieldDisplayText} from '@hsbc/contracts/document-presentation';
import type {DocumentFieldObservation,FieldsResponse,LogicalDocument} from './types.ts';
import {insuranceFieldSourceLabel,insuranceRequirementRows,type InsuranceRequirementRow} from './insurance-presentation.ts';
import './insurance-fields.css';

interface Props {
  response:FieldsResponse;directory:LogicalDocument[];
  onSelect:(ids:string[],page?:number)=>void;
  renderSources:(ids:string[])=>React.ReactNode;
  renderTranslation?:(field:DocumentFieldObservation)=>React.ReactNode;
  onPaymentEvidence:()=>void;
}
const attention=(row:InsuranceRequirementRow)=>['unsupported','review','pending'].includes(row.status);

export function InsuranceFields({response,directory,onSelect,renderSources,renderTranslation,onPaymentEvidence}:Props) {
  const [filter,setFilter]=useState<'all'|'attention'|'absent'>('all');
  const [expanded,setExpanded]=useState<readonly React.Key[]>([]);
  const rows=insuranceRequirementRows(response,directory);
  const visible=rows.filter(row=>filter==='all'||(filter==='attention'?attention(row):row.status==='absent'));
  const showAll=(id:string)=>setExpanded(current=>current.includes(id)?current:[...current,id]);
  const values=(row:InsuranceRequirementRow,full=false)=>row.fields.map(field=>{
    const candidates=field.candidates;
    const displayed=full?candidates:candidates.slice(0,3);
    const sourceKinds=new Set(candidates.map(candidate=>insuranceFieldSourceLabel(candidate,directory)).filter(Boolean));
    const separateSources=sourceKinds.size>1;
    return <div className="insurance-observation" key={field.id}>
      {row.fields.length>1&&<span className="insurance-observation-label">{field.fieldLabel}</span>}
      {displayed.map((candidate,index)=><div className="insurance-candidate" key={index}>
        <button type="button" className="evidence-value-link" disabled={!candidate.anchorIds.length}
          aria-label={`定位${row.requirement.label}原文：${fieldCandidateDisplayText(candidate)}`}
          onClick={()=>onSelect(candidate.anchorIds,candidate.pageNumbers[0])}>{fieldCandidateDisplayText(candidate)}</button>
        {full&&renderSources(candidate.anchorIds)}
        {separateSources&&<span className="insurance-source-kind">{insuranceFieldSourceLabel(candidate,directory)}</span>}
      </div>)}
      {!candidates.length&&field.rawValue&&<button type="button" className="evidence-value-link" disabled={!field.anchorIds.length} onClick={()=>onSelect(field.anchorIds,field.pageNumbers[0])}>{fieldDisplayText(field.rawValue)}</button>}
      {!full&&candidates.length>3&&<Button type="link" size="small" onClick={()=>showAll(row.requirement.id)}>展开全部 {candidates.length} 项</Button>}
      {!separateSources&&(candidates.length>0||field.rawValue)&&<span className="insurance-source-kind">{[...sourceKinds][0]??insuranceFieldSourceLabel(field,directory)}</span>}
      {!full&&renderTranslation?.(field)}
    </div>;
  });
  const columns:TableProps<InsuranceRequirementRow>['columns']=[
    {title:'字段',key:'label',width:128,render:(_,row)=><span className={`insurance-field-label${'parentId' in row.requirement?' is-child':''}`}>{row.requirement.label}</span>},
    {title:'值及状态',key:'value',render:(_,row)=><div className="insurance-field-value">
      {values(row)}<ExtractionNotice className={`insurance-status${attention(row)?' needs-attention':''}`} state={{label:row.label,tone:attention(row)?'warning':'plain'}} hasValue={row.fields.some(field=>field.candidates.length>0||Boolean(field.rawValue))} detail={row.detail}/>
      {row.requirement.id==='insurance_payment_evidence'&&<Button type="link" size="small" onClick={onPaymentEvidence}>核对独立凭证</Button>}
    </div>},
    {title:'来源',key:'source',width:64,render:(_,row)=>renderSources([...new Set(row.fields.flatMap(field=>field.anchorIds))])},
  ];
  return <section className="insurance-fields" aria-label="银行保险字段">
    <div className="insurance-fields-heading"><strong>保险字段</strong><span className="muted">按银行清单排列</span></div>
    <Segmented<'all'|'attention'|'absent'> block aria-label="保险字段筛选" value={filter} onChange={setFilter} options={[
      {value:'all',label:`全部 ${rows.length}`},{value:'attention',label:`需关注 ${rows.filter(attention).length}`},{value:'absent',label:`原文未见 ${rows.filter(row=>row.status==='absent').length}`},
    ]}/>
    <Table<InsuranceRequirementRow> rowKey={row=>row.requirement.id} size="small" tableLayout="fixed" pagination={false} columns={columns} dataSource={visible}
      className="field-table insurance-field-table" expandable={{columnWidth:28,expandedRowKeys:expanded,onExpandedRowsChange:setExpanded,
        expandedRowRender:row=><div className="insurance-field-detail">{row.detail&&<p>{row.detail}</p>}{values(row,true)}
          {row.requirement.id==='insurance_payment_evidence'&&<p>发票、应缴保费或金额相同不能单独证明已支付；请核对凭证类型、收付记录及对应编号。</p>}
        </div>}} locale={{emptyText:'当前筛选下没有字段'}}/>
  </section>;
}
