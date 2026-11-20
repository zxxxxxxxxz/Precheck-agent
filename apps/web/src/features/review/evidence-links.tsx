import React from 'react';
import {Link,useSearchParams} from 'react-router';
import type {ReviewEvidence} from '@hsbc/contracts/review';
import {evidenceUrl} from './presentation.ts';
export function EvidenceLinks({caseId,evidence,names={},roundId,compact=false}:{caseId:string;evidence:readonly ReviewEvidence[];names?:Record<string,string>;roundId?:string|null;compact?:boolean}) {
  const [params]=useSearchParams();const round=roundId===undefined?params.get('round'):roundId;
  const render=(values:readonly ReviewEvidence[],start=0)=><span className="review-loop-evidence">{values.map((source,i)=>{const filename=names[source.documentVersionId]??`文件 ${source.documentVersionId.slice(0,8)}`,location=`${source.sourceNodeId?'Word 段落／单元格':'原文区域'} ${start+i+1}`;return <Link key={`${source.documentVersionId}:${source.parseRevision}:${source.anchorId??source.sourceNodeId}:${i}`} title={`${filename} · ${location}`} aria-label={`${filename} · ${location}`} to={evidenceUrl(caseId,source)+(round?`&round=${encodeURIComponent(round)}`:'')}>{compact?location:`${filename} · ${location}`}</Link>;})}</span>;
  return evidence.length?<div>{render(evidence.slice(0,2))}{evidence.length>2&&<details className="review-source-more"><summary>其余 {evidence.length-2} 处原文</summary>{render(evidence.slice(2),2)}</details>}</div>:<span className="muted">尚无可定位的原文依据</span>;
}
