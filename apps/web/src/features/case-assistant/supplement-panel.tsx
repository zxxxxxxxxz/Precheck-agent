import React from 'react';
import {Select} from 'antd';
import {Link} from 'react-router';
import type {SupplementJob, SupplementState, SupplementOutput} from '@hsbc/contracts/case-supplement';
import {SUPPLEMENTAL_MATERIAL_LABEL} from '@hsbc/contracts/case-supplement';
import type {CaseSummary} from '../cases/types.ts';
import {evidenceUrl} from '../review/presentation.ts';
import type {useSupplements} from './use-supplements.ts';
import './supplement-panel.css';

type SupplementCase = Pick<CaseSummary, 'id' | 'revision' | 'selectedRoundId'>;
export function SupplementScope({supplement, currentDocumentId}: {supplement: ReturnType<typeof useSupplements>; currentDocumentId?: string}) {
  return <>
    <div className="case-assistant-about case-supplement-about">
    <span className="case-assistant-about-label">关于</span>
    <Select className="case-supplement-files" aria-label="本次阅读的文件（最多 6 份）" mode="multiple" maxCount={6} value={supplement.documentIds}
      size="small" variant="borderless" suffixIcon={null}
      disabled={supplement.sending || !supplement.data?.canRequest} showSearch={{optionFilterProp: 'label'}} placeholder="选择补充材料与对照文件"
      options={supplement.data?.documents.map(document => ({value: document.id, label: `${document.filename}${document.supplemental ? `（${SUPPLEMENTAL_MATERIAL_LABEL}）` : ''}`, disabled: !document.available}))}
      tagRender={({value, onClose, closable}) => {
        const filename = supplement.data?.documents.find(document => document.id === value)?.filename ?? '所选文件';
        return <span className="case-assistant-subject case-supplement-file" title={filename}>
          <span>{value === currentDocumentId ? '当前文件' : '文件'}</span><strong>{filename}</strong>
          {closable && <button type="button" aria-label={`移除文件 ${filename}`} disabled={supplement.sending || !supplement.data?.canRequest}
            onMouseDown={event => {event.preventDefault();event.stopPropagation();}} onClick={onClose}>×</button>}
        </span>;
      }}
      onChange={supplement.setDocumentIds}/>
    </div>
    {supplement.hint && <p role="status" className="case-supplement-hint case-supplement-blocked">{supplement.hint}</p>}
  </>;
}
const stateLabels={pending:'等待处理',running:'正在读取与核对',ready:'已完成',failed:'未完成',unknown:'结果待查询'};
const outcomeLabels={consistent:'一致',different:'存在差异',insufficient:'依据不足'};
export function SupplementResult({job,item,documents,onLocate}:{job:SupplementJob;item:SupplementCase;documents:SupplementState['documents'];onLocate:()=>void}){
  const names=Object.fromEntries([...documents.map(d=>[d.id,d.filename]),...job.evidence.map(e=>[e.documentId,e.filename])]);
  const round=item.selectedRoundId&&item.selectedRoundId!=='legacy'?`&round=${encodeURIComponent(item.selectedRoundId)}`:'';
  const sources=(citations:SupplementOutput['checks'][number]['citations'])=>citations.map((citation,i)=>{
    const source=job.evidence.find(e=>e.id===citation.evidenceId);
    return <blockquote key={`${citation.evidenceId}:${i}`}><p>{citation.quote}</p>{source&&<footer>{source.locations.length?source.locations.map((location,index)=><React.Fragment key={index}>{index>0&&'；'}<Link to={evidenceUrl(item.id,location)+round} onClick={onLocate}>{source.filename} · 查看原文{source.locations.length>1?`（${index+1}）`:''}</Link></React.Fragment>):<span>{source.filename} · 暂无原文定位</span>}</footer>}</blockquote>;
  });
  return <article className="case-supplement-result">
    <header><strong>{stateLabels[job.state]}</strong>{job.validity==='stale'&&<span className="case-supplement-stale">依据已更新，请重新发起核对</span>}</header>

    <p className="case-supplement-hint">{job.documentIds.map(id=>names[id]??'历史文件').join('、')}</p>
    {job.simulated&&<p className="case-supplement-stale">模拟结果，仅供测试</p>}
    {job.state==='unknown'&&<p role="status">模型调用结果尚不确定，本次不会自动重发。请联系管理员核实。</p>}
    {job.state==='failed'&&<p role="status">{job.errorCode==='supplement_source_stale'?'材料或案件已变化，请按当前材料重新发起请求。':'本次未能完成。请核对文件范围及原文读取状态后重新发起请求。'}</p>}
    {job.output&&<div className="case-supplement-answer"><p>{job.output.reply}</p>
      {job.output.fields.map((field,i)=><section key={i}><h4>{field.label}<span>{field.status==='found'?'已提取':field.status==='not_found'?'未找到':'待核实'}</span></h4><p className="case-supplement-hint">{names[field.documentId]??'所选文件'}</p>{field.value&&<p className="case-supplement-value">{field.value}</p>}{sources(field.citations)}</section>)}
      {job.output.checks.map((check,i)=><section key={i}><h4>{check.label}<span>{outcomeLabels[check.outcome]}</span></h4><p>{check.reason}</p>{sources(check.citations)}</section>)}
      {!!job.output.questions.length&&<div><h4>需要补充说明</h4><ul>{job.output.questions.map((q,i)=><li key={i}>{q}</li>)}</ul></div>}
      {!!job.output.limitations.length&&<ul className="case-supplement-hint">{job.output.limitations.map((v,i)=><li key={i}>{v}</li>)}</ul>}
    </div>}
  </article>;
}
