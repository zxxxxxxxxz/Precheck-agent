import React from 'react';
import {Link} from 'react-router';
import {errorText} from '../../api.ts';
import {evidenceUrl} from './presentation.ts';
import {translationReason} from '../documents/translation/presentation.ts';
import {type RoundTranslations} from './translation-evidence.ts';
import {bilingualEvidenceDocuments,type EvidenceReading} from './bilingual-evidence.ts';
import {EvidenceContent} from './evidence-content.tsx';
import {FullOriginalButton} from './full-original-dialog.tsx';

export interface EvidenceTranslationProps {data?:RoundTranslations;translationPending?:boolean;translationError?:unknown;referenceRoundId?:string;translationStatus?:string}
export function BilingualEvidenceRail({caseId,roundId,names,readings,context,data,translationPending,translationError,translationStatus,referenceRoundId,pending,error}:{
  caseId:string;roundId?:string|null;names:Record<string,string>;readings:EvidenceReading[];context?:string;pending?:boolean;error?:unknown;
}&EvidenceTranslationProps){
  const documents=bilingualEvidenceDocuments(readings,data);
  return <><div className="field-column-heading"><h2>对应原文</h2><span>{pending?'读取中':documents.length?`${documents.length} 项证据`:'无可用证据'}</span></div>
    <div className="field-evidence-body field-bilingual-evidence">
      {!!error&&<p role="alert">{errorText(error)}</p>}
      {pending&&<p role="status">正在读取对应段落…</p>}
      {!pending&&!documents.length&&<p className="field-empty">尚无对应原文</p>}
      {documents.map(({key,parts},index)=>{
        const source=parts[0]!.reading.sources[0]!,filename=names[source.documentVersionId]??'来源文件';
        const pages=[...new Set(parts.flatMap(({reading,match})=>match?.t.source.pageNumbers.length?match.t.source.pageNumbers:reading.pageNumber?[reading.pageNumber]:[]))].sort((a,b)=>a-b);
        const location=pages.length?`第 ${pages.join('、')} 页`:'原文位置待核对';
        const url=evidenceUrl(caseId,{...source,...(parts[0]!.reading.pageNumber?{pageNumber:parts[0]!.reading.pageNumber}:{})})+(roundId?`&round=${encodeURIComponent(roundId)}`:'');
        const chineseOnly=(reading:EvidenceReading)=>/\p{Script=Han}/u.test(reading.text)&&!/[A-Za-z]{3,}/u.test(reading.text);
        const translatedParts=parts.filter(({reading})=>!chineseOnly(reading));
        const translationLabel=(translatedParts.some(({match})=>match?.segment?.status==='needs_review')?'中文译文 · 译文待核实':'中文参考译文')+(translatedParts.some(({match})=>match?.segment?.simulated)?' · 模拟译文，仅用于功能验证':'');
        let previousNotice:string|undefined;
        return <article className="field-evidence-document field-bilingual-pair" key={key}>
          <header><span>{String(index+1).padStart(2,'0')}</span><Link to={url} target="_blank" rel="noopener noreferrer" title={context} aria-label={`查看原文：${filename} · ${location}（新窗口）`}>{filename} · {location}</Link><FullOriginalButton caseId={caseId} source={source} filename={filename} referenceRoundId={referenceRoundId}/></header>
          {!!translatedParts.length&&<section className="field-evidence-translation" aria-label="中文参考译文"><h3 title="中文参考译文，未经人工核对">{translationLabel}</h3>
            {translatedParts.map(({key,reading,match})=>{
              const segment=match?.segment;
              const jobs=match?.d.jobs.filter(job=>(job.sourceCurrent??job.validity==='current')&&job.chunkIds.includes(match.t.chunkId))??[];
              const active=jobs.some(job=>['pending','running'].includes(job.status));
              const warnings=[...new Set([...(match?.t.reasonCodes??[]),...(match?.t.sourceWarnings??[]).filter(code=>code==='translation_context_incomplete'),...(segment?.reasonCodes??[]),...jobs.flatMap(job=>job.errorCode?[job.errorCode]:[])])];
              const latest=jobs[0];
              const notice=translationError?'参考译文读取失败，请刷新重试':translationPending?'正在读取当前原文的翻译状态…':
                match&&!match.t.available?'当前原文暂不能翻译':translationStatus??(latest?.status==='running'?'正在翻译当前引用原文':latest?.status==='pending'?'当前原文译文排队中':
                latest?.status==='failed'?'当前原文翻译失败，请查看原因后重试':latest?.status==='canceled'?'当前原文翻译已取消':
                latest?.status==='partial'?'当前原文翻译未完成，请查看原因后重试':latest?.status==='ready'?'任务已完成，但未返回当前原文的译文':
                match?(!match.d.metadata?.enabled?'当前未启用参考翻译':!match.d.metadata?.canCreate?'当前权限或轮次不允许生成译文':'当前原文尚未生成译文，等待提交翻译'):'尚未匹配到当前引用原文的译文');
              const noticeKey=segment?.translatedText?undefined:JSON.stringify([notice,[...warnings].sort()]);
              const repeated=noticeKey!==undefined&&noticeKey===previousNotice;
              previousNotice=noticeKey;
              if(repeated)return null;
              return <div className="field-evidence-passage" key={key}>
                {segment?.translatedText?<div lang="zh-CN"><EvidenceContent text={segment.translatedText} highlights={reading.highlights}/></div>:
                  <p role={translationPending||active?'status':undefined}>{notice}</p>}
                {warnings.length>0&&<p className="help-text">{warnings.map(translationReason).join(' ')}</p>}
              </div>;
            })}
          </section>}
          <section className="field-evidence-original" aria-label="对应原文段落"><h3>{!translatedParts.length?'中文原文':'对应原文 · 当前字段引用'}</h3>
            {parts.map(({key,reading})=>{
              const partSource=reading.sources[0]!;
              const partUrl=evidenceUrl(caseId,{...partSource,...(reading.pageNumber?{pageNumber:reading.pageNumber}:{})})+(roundId?`&round=${encodeURIComponent(roundId)}`:'');
              return <div className="field-evidence-passage" key={key}>
                <Link className="field-evidence-passage-link" to={partUrl} target="_blank" rel="noopener noreferrer" title={`${context??''}查看此段原文：${filename}${reading.pageNumber?` · 第 ${reading.pageNumber} 页`:''}（新窗口）`}>
                  {reading.text?<EvidenceContent text={reading.text} highlights={reading.highlights}/>:<p>暂未读到此处原文，请打开文件标题核对。</p>}
                </Link>
              </div>;
            })}
          </section>
        </article>;
      })}
    </div></>;
}
