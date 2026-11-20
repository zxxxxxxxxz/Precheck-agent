import type {DocumentFieldObservation, DocumentSourceAnchor} from '@hsbc/contracts/documents';
import {fieldCandidateCompleteDisplayText, fieldCandidateDisplayText, fieldDisplayText, tableRecordDisplayText, type DocumentFieldPresentation, type FieldTableRecord} from '@hsbc/contracts/document-presentation';
import type {EvidenceAnchor} from '@hsbc/contracts/evidence';
import {candidateSourceReviewLabel, candidateSupplementSources} from './field-v2-presentation.ts';

export interface FieldCsvInput {
  caseId: string;
  documentId: string;
  filename: string;
  sourceSha256: string;
  parseRevision: string;
  directoryRevision: string | number;
  /** Current applicable, presentation-filtered rows in visible order. */
  rows: readonly {field: DocumentFieldPresentation; statusLabel: string}[];
  originalFields: readonly DocumentFieldObservation[];
  anchors: readonly EvidenceAnchor[];
  sourceAnchors: readonly DocumentSourceAnchor[];
}

const headers = ['文件', '案件标识', '文件标识', '原件SHA256', '解析版本', '分类版本', '字段', '字段标识', '提取状态', '业务确认', '候选序号', '展示值', '完整提取值（逐段换行）', '标准化值', '页码', '逐段原文(JSON)', '结构化事项及条件(JSON)', '名称组(JSON)', '候选原始记录(JSON)', '来源定位(JSON)', '提取覆盖(JSON)', '字段原始记录及筛选历史(JSON)', '表格行整理(JSON)'];
const json = (value: unknown) => JSON.stringify(value ?? null);
/** Neutralize spreadsheet formulas. JSON audit columns retain original strings. */
export function fieldCsvCell(value: string): string {
  const safe = /^\s*[=+\-@]/u.test(value) ? `'${value}` : value;
  return `"${safe.replace(/"/gu, '""')}"`;
}

export function documentFieldsCsv(input: FieldCsvInput): string {
  const inScope = (value: {documentVersionId: string; parseRevision: string}) => value.documentVersionId === input.documentId && value.parseRevision === input.parseRevision;
  const anchors = input.anchors.filter(value => value.document_version_id === input.documentId && value.parse_revision === input.parseRevision);
  const sourceAnchors = input.sourceAnchors.filter(value => value.document_version_id === input.documentId && value.parse_revision === input.parseRevision);
  const rows: string[][] = [];
  for (const {field, statusLabel} of input.rows) {
    if (!inScope(field)) continue;
    const original = input.originalFields.find(value => value.id === field.id && inScope(value));
    const entries: {candidate: DocumentFieldObservation['candidates'][number] | null; record?: FieldTableRecord}[] = field.tableRecords?.records.length
      ? [...field.tableRecords.records.map(record => ({candidate: null, record})), ...field.tableRecords.otherCandidateIndexes.map(index => ({candidate: field.candidates[index]!}))]
      : (field.candidates.length ? field.candidates : [null]).map(candidate => ({candidate}));
    for (const [index, {candidate, record}] of entries.entries()) {
      const ids = new Set(candidate ? [
        ...candidate.anchorIds, ...(candidate.contextAnchorIds ?? []), ...(candidate.nameAssociation?.evidenceAnchorIds ?? []),
        ...(candidate.nameAssociation?.sourceNames ?? []).flatMap(source => source.anchorIds),
        ...(candidate.roleEvidence?.declaration.anchorIds ?? []), ...(candidate.roleEvidence?.relation.anchorIds ?? []),
        ...candidateSupplementSources(candidate).flatMap(source => source.anchorIds),
        ...(candidate.evidenceSegments ?? []).flatMap(value => [...value.anchorIds, ...value.contextAnchorIds]),
        ...(candidate.structuredValue?.components ?? []).flatMap(value => value.anchorIds),
      ] : field.anchorIds);
      if (record) {
        ids.clear();
        for (const id of [...record.anchorIds, ...record.components.flatMap(component => [...component.anchorIds,...component.locationAnchorIds]),
          ...record.candidateIndexes.flatMap(index => field.candidates[index]?.anchorIds ?? [])]) ids.add(id);
      }
      let previousSize = -1;
      while (previousSize !== ids.size) {
        previousSize = ids.size;
        for (const anchor of [...anchors, ...sourceAnchors]) {
          if (ids.has(anchor.anchor_id)) for (const id of anchor.candidate_anchor_ids ?? []) ids.add(id);
        }
      }
      const sources = {
        anchorIds: [...ids],
        anchors: anchors.filter(value => ids.has(value.anchor_id)),
        sourceAnchors: sourceAnchors.filter(value => ids.has(value.anchor_id)),
        unresolvedAnchorIds: [...ids].filter(id => !anchors.some(value => value.anchor_id === id) && !sourceAnchors.some(value => value.anchor_id === id)),
      };
      rows.push([
        input.filename, input.caseId, input.documentId, input.sourceSha256, input.parseRevision, String(input.directoryRevision),
        field.fieldLabel, field.fieldId, [statusLabel, candidate && candidateSourceReviewLabel(candidate)].filter(Boolean).join(' · '), '提取记录；业务确认请查看信息核对', candidate ? String(index + 1) : '',
        record ? tableRecordDisplayText(record) : candidate ? fieldCandidateDisplayText(candidate) : fieldDisplayText(field.rawValue ?? ''),
        record ? tableRecordDisplayText(record) : candidate ? fieldCandidateCompleteDisplayText(candidate) : fieldDisplayText(field.rawValue ?? ''),
        record ? '' : candidate?.normalizedValue ?? field.normalizedValue ?? '', (record ? [record.pageNumber] : candidate?.pageNumbers ?? field.pageNumbers).join(', '),
        json(candidate?.evidenceSegments), json(candidate?.structuredValue), json(candidate?.nameAssociation), json(candidate),
        json(sources), json(field.extractionCoverage), index === 0 ? json(original ?? field) : '', json(record),
      ]);
    }
  }
  return '\uFEFF' + [headers, ...rows].map(row => row.map(fieldCsvCell).join(',')).join('\r\n') + '\r\n';
}

export function documentFieldsCsvFilename(filename: string): string {
  return `${filename.replace(/\.[^.]*$/u, '').replace(/[\\/:*?"<>|\u0000-\u001f]/gu, '_') || '材料'}_当前字段.csv`;
}
