import React from 'react';
import {Button} from 'antd';
import type {DocumentOcrMark, DocumentOcrMarkPage} from './types.ts';
import {ocrMarkLabel, ocrMarkPageNotice, ocrMarkScore} from './ocr-mark-presentation.ts';

export function OcrMarkClues({pages, onSource}: {pages?: readonly DocumentOcrMarkPage[]; onSource: (page: DocumentOcrMarkPage, mark?: DocumentOcrMark) => void}) {
  const count = pages?.reduce((total, page) => total + page.items.length, 0) ?? 0;
  return <details className="signature-coverage ocr-mark-clues"><summary>签章线索 {count}</summary>
    <p className="muted">仅供定位，需结合原文核对。</p>
    {!pages?.length && <p className="muted">该解析记录未返回签章线索。</p>}
    {pages?.map(page => <section key={`${page.pageAssetId}:${page.imageSha256}`} aria-label={`第 ${page.pageNumber} 页签章线索`}>
      <div className="signature-observation-heading"><strong>第 {page.pageNumber} 页</strong>{ocrMarkPageNotice(page) && <span className="muted">{ocrMarkPageNotice(page)}</span>}</div>
      {!page.items.length && <p><span className="muted">本页未返回线索</span> <Button type="link" className="link-button" onClick={() => onSource(page)} aria-label={`查看第 ${page.pageNumber} 页原文`}>查看原文</Button></p>}
      {page.items.map(mark => <div key={mark.id} className="ocr-mark-clue">
        <div className="signature-observation-heading"><span>{ocrMarkLabel(mark.kind)}</span><Button type="link" className="link-button" onClick={() => onSource(page, mark)} aria-label={`查看第 ${page.pageNumber} 页${ocrMarkLabel(mark.kind)}原文`}>查看原文</Button></div>
        <details><summary>检测信息</summary><p>检测分数：{ocrMarkScore(mark.score)}</p>{mark.mappingStatus !== 'verified' && <p className="muted">位置待核对，查看原页。</p>}
          <p>来源：{[...new Set(mark.sourceRefs.map(source => source.source === 'layout_detection' ? '版面检测' : '版面区块'))].join('、')}</p>
          <p>原始标签：{[...new Set(mark.sourceRefs.map(source => source.label))].join('、')}</p>
          {page.model && <p>识别来源：{page.model}{page.modelVersion ? ` · ${page.modelVersion}` : ''}</p>}
        </details>
      </div>)}
    </section>)}
  </details>;
}
