import React from 'react';
import {Button} from 'antd';
import {fieldCandidateDisplayText, tableRecordLabels, type DocumentFieldPresentation} from '@hsbc/contracts/document-presentation';
import './table-records.css';

/** Read-only source records. Original candidate decisions remain in the field artifact. */
export function FieldTableRecords({field, onSelect, renderSource}: {
  field: DocumentFieldPresentation;
  onSelect: (ids: string[], page?: number) => void;
  renderSource: (value: string, ids: string[], page: number | undefined, label: string) => React.ReactNode;
}) {
  const projection = field.tableRecords;
  if (!projection?.records.length) return null;
  return <div className="field-table-records" aria-label={`${field.fieldLabel}表格记录`}>
    {projection.records.map(record => <section className="field-table-record" key={record.id} aria-label={record.kind === 'meeting' ? '会议信息' : '表内人员记录'}>
      <dl>{record.components.map(component => <div className="field-table-component" key={component.role}>
        {record.kind !== 'meeting' && <dt>{tableRecordLabels[component.role]}</dt>}<dd>
          <Button type="link" className="field-table-value" onClick={event => {event.stopPropagation(); onSelect(component.locationAnchorIds,record.pageNumber);}}
            aria-label={`定位${tableRecordLabels[component.role]}：${component.value}`}>
            {component.value || '未识别到文字'}
          </Button>
          <span className="field-table-location">第 {record.pageNumber} 页</span>
        </dd>
      </div>)}</dl>
    </section>)}
    {!!projection.otherCandidateIndexes.length && <details className="field-table-other" onClick={event => event.stopPropagation()}>
      <summary>其他原文提及（{projection.otherCandidateIndexes.length}）</summary>
      {projection.otherCandidateIndexes.map(index => {
        const candidate = field.candidates[index];
        return candidate ? <React.Fragment key={index}>{renderSource(fieldCandidateDisplayText(candidate),candidate.anchorIds,candidate.pageNumbers[0],`${field.fieldLabel}其他原文`)}</React.Fragment> : null;
      })}
    </details>}
  </div>;
}
