import React, {useMemo} from 'react';
import type {DocumentRegion} from '@hsbc/contracts/evidence';
import type {DocumentTableObservation} from '@hsbc/contracts/documents';
import {OCR_TABLE_LIMITS, presentOcrRegion} from './ocrTable.ts';

/** Import ocr-region-content.css with the reader stylesheet. OCR is always rendered as text. */
export function OcrRegionContent({region, observation}: {region: DocumentRegion; observation?: DocumentTableObservation}) {
  const presentation = useMemo(() => presentOcrRegion(region, observation), [region, observation]);
  if (presentation.kind === 'text') return <div className="ocr-region-content">
    {presentation.tableFallback && <p className="ocr-table-note">表格结构不完整，以下显示识别原文，请核对原件。</p>}
    <p className="evidence-excerpt">{presentation.text || '该区域仅保留原图，请核对图像。'}</p>
    {presentation.truncated && <p className="ocr-table-note">识别原文较长，仅显示前 {OCR_TABLE_LIMITS.fallbackCharacters.toLocaleString('zh-CN')} 个字符，请核对原件。</p>}
  </div>;
  return <div className="ocr-region-content">
    <div className="ocr-table-scroll" tabIndex={0} role="region" aria-label="识别表格，可横向滚动">
      <table className="ocr-table" aria-label="所选区域的识别表格"><tbody>{presentation.table.rows.map((row, rowIndex) => <tr key={rowIndex}>{row.map((cell, cellIndex) => {
        const Cell = cell.header ? 'th' : 'td';
        return <Cell key={cellIndex} rowSpan={cell.rowSpan} colSpan={cell.colSpan}>{cell.text}</Cell>;
      })}</tr>)}</tbody></table>
    </div>
    <details className="ocr-table-source"><summary>查看识别原文</summary><p className="evidence-excerpt">{presentation.rawText.slice(0, OCR_TABLE_LIMITS.fallbackCharacters)}</p>{presentation.rawText.length > OCR_TABLE_LIMITS.fallbackCharacters && <p className="ocr-table-note">原文较长，仅显示前 {OCR_TABLE_LIMITS.fallbackCharacters.toLocaleString('zh-CN')} 个字符。</p>}</details>
  </div>;
}
