import React from 'react';
import type {ChecklistRow} from '@hsbc/contracts/review-checklist';

/** Imported verification replaces the comparison view, so retain its upload-date context here. */
export function UploadDateBasis({row}:{row:ChecklistRow}) {
  const sources=[...new Map((row.crossChecks??[]).filter(check=>check.method==='date_order').flatMap(check=>check.sources)
    .filter(source=>source.fieldId==='review_business_date'&&/:upload-(?:date|missing)$/u.test(source.id))
    .map(source=>[source.id,source])).values()];
  if(!sources.length)return null;
  return <div aria-label="审核日期依据">{sources.map(source=><p className="help-text" key={source.id}>
    {source.filename}：本文件审核日为{source.values[0]??'待核实'}（上传日期，北京时间）。
    {!source.values.length&&'尚未取得上传记录。'}
  </p>)}</div>;
}
