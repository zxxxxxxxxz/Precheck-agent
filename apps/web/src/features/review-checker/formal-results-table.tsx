import React from 'react';
import {Table,Tag} from 'antd';
import type {FormalCheck,FormalResult} from '@hsbc/contracts/formal-review';
import type {AnalysisEvidence} from '@hsbc/contracts/review-delivery';
import {EvidenceLinks} from '../review/evidence-links.tsx';
const outcomes={no_issue:'未发现语义问题',issue:'发现问题',insufficient:'依据不足',manual:'待人工判断'};
const programOutcomes:Record<string,string>={pass:'程序检查通过',fail:'程序检查未通过',blocked:'程序检查依据不足',not_applicable:'本轮不适用'};
export function FormalResultsTable({caseId,roundId,checks,results,evidence}:{caseId:string;roundId:string;checks:FormalCheck[];results:FormalResult[];evidence:AnalysisEvidence[]}){
 return (<Table<FormalCheck> rowKey="id" size="small" dataSource={checks} pagination={{pageSize:10,hideOnSinglePage:true}} scroll={{x:850}} columns={[
     {title:'所属对象',dataIndex:'objectLabel'},
     {title:'检查事项',dataIndex:'label'},
     {title:'处理方式',key:'method',render:(_,c)=>c.method==='business_confirmation'?'业务依据待确认':c.method==='cloud_and_human'?'语义分析及人工判断':'程序规则检查'},
     {title:'结果',key:'result',render:(_,c)=>{const r=results.find(r=>r.checkId===c.id);return !r?'尚未完成':c.programOutcome==='not_applicable'?'本轮不适用':c.method==='program'?programOutcomes[c.programOutcome]??'程序检查待核对':outcomes[r.outcome];}},
     {title:'问题与处理要求',key:'reason',render:(_,c)=>results.find(r=>r.checkId===c.id)?.reason||(c.gaps.join('；')||'等待处理')},
    ]} expandable={{expandedRowRender:check=>{const result=results.find(r=>r.checkId===check.id);return <div className="checker-record"><p><strong>检查依据：</strong>{check.requirement}</p><p>{check.sourceReferences.join('；')}</p>{check.evidenceIds.map(id=>{const e=evidence.find(e=>e.id===id);return e&&<article key={id}><strong>{e.filename}</strong><EvidenceLinks caseId={caseId} evidence={e.locations} roundId={roundId}/>{result?.citations.filter(c=>c.evidenceId===id).map((c,i)=><blockquote key={i}>{c.quote}</blockquote>)}<details><summary>完整原文与已有中文参考译文</summary><p className="formal-source-text">{e.text}</p>{e.referenceTranslations.length?e.referenceTranslations.map((t,i)=><div key={i}><Tag>{t.status}</Tag><p className="formal-source-text">{t.text}</p></div>):<p className="help-text">这段原文尚无已保存的参考译文，请从完整字段或原文页面使用现有翻译功能。</p>}</details></article>;})}</div>;}}}/>);
}
