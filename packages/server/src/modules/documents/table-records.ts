import type {DocumentBundle, DocumentPageArtifact} from '@hsbc/contracts/documents';
import type {DocumentRegion, EvidenceAnchor} from '@hsbc/contracts/evidence';
import type {ReviewFieldDefinition} from '@hsbc/contracts/review-config';
import {fieldDisplayText, type DocumentFieldPresentation, type FieldTableRecord} from '@hsbc/contracts/document-presentation';
import {anchorsForText, sha256, validateAnchorSource} from '../../document/evidence.js';
import {documentHtmlCellSpans} from '../../document/html-cells.js';
import {deriveTables} from './engine/tables.js';

type Span = {start: number; end: number};
type Cell = Span & {text: string; columnIndex: number};
type Row = {rowIndex: number; cells: Cell[]};
type Component = FieldTableRecord['components'][number];
export interface TableRecordsInput {
  fields: DocumentFieldPresentation[];
  definitions: ReviewFieldDefinition[];
  pages: DocumentPageArtifact[];
  logicalDocuments: DocumentBundle['logicalDocuments'];
  anchors: EvidenceAnchor[];
}
const unique = <T>(values: T[]) => [...new Set(values)];
const normalized = (value: string) => fieldDisplayText(value).normalize('NFC');
const headerKey = (value: string) => normalized(value).toLowerCase().replace(/[：:]$/u, '');
export const supportsTableRecords = (definition: Pick<ReviewFieldDefinition, 'id' | 'taxonomyIds'>) =>
  ['cgt_field_25', 'cgt_field_29'].includes(definition.id) && definition.taxonomyIds?.includes('cgt_resolution');

function bounds(region: DocumentRegion) {
  const points = region.polygons.flat();
  return [Math.min(...points.map(p => p[0])), Math.min(...points.map(p => p[1])), Math.max(...points.map(p => p[0])), Math.max(...points.map(p => p[1]))];
}
function inside(region: DocumentRegion, table: DocumentRegion) {
  const a = bounds(region), b = bounds(table);
  return a[0]! >= b[0]! && a[1]! >= b[1]! && a[2]! <= b[2]! && a[3]! <= b[3]!;
}
function valid(page: DocumentPageArtifact, region: DocumentRegion) {
  const b = bounds(region);
  return page.status !== 'failed' && page.page.document_version_id === page.scope.documentVersionId && page.page.parse_revision === page.scope.parseRevision &&
    page.page.source_sha256 === page.scope.sourceSha256 && region.document_version_id === page.scope.documentVersionId && region.parse_revision === page.scope.parseRevision &&
    region.page_asset_id === page.page.page_asset_id && region.processing_status === 'ready' && region.raw_text !== null && region.raw_text_sha256 === sha256(region.raw_text) &&
    (region.source !== 'native_pdf' || page.nativeTrust === 'validated_geometry_and_visibility') &&
    region.polygons.length === 1 && region.polygons[0]!.length >= 3 && b.every(Number.isFinite) && b[2]! > b[0]! && b[3]! > b[1]! &&
    region.polygons[0]!.every(([x,y]) => x >= 0 && y >= 0 && x <= page.page.width && y <= page.page.height) &&
    !page.conflicts.some(conflict => conflict.region_ids.includes(region.region_id));
}

/** Validate with the shared bounded parser, then retain offsets into original bytes.
 * HTML spans/Markdown pipes are never used to invent cell coordinates. */
function sourceRows(page: DocumentPageArtifact, region: DocumentRegion): Row[] {
  const raw = region.raw_text!;
  const table = deriveTables([{...page, canonicalRegionIds: [region.region_id]}], []).tables[0];
  if (!table?.cells.length) return [];
  let spans: Span[] = [];
  if (table.format === 'html') spans = documentHtmlCellSpans(raw);
  else if (table.format === 'markdown') {
    const lines = [...raw.matchAll(/[^\r\n]+/gu)].filter(match => match[0].trim());
    for (const [index, line] of lines.entries()) {
      if (index === 1) continue;
      const delimiters: number[] = [];
      for (let i = 0; i < line[0].length; i++) {
        if (line[0][i] === '\\' && ['|', '\\'].includes(line[0][i + 1] ?? '')) {i++; continue;}
        if (line[0][i] === '|') delimiters.push(i);
      }
      const edges = [-1, ...delimiters, line[0].length];
      for (let i = 0; i < edges.length - 1; i++) {
        const start = edges[i]! + 1, end = edges[i + 1]!;
        if ((i === 0 || i === edges.length - 2) && !line[0].slice(start,end).trim()) continue;
        spans.push({start: line.index! + start, end: line.index! + end});
      }
    }
  }
  if (spans.length !== table.cells.length) return [];
  return table.rows.map(row => ({rowIndex: row.rowIndex, cells: table.cells.flatMap((cell, index) => cell.rowIndex === row.rowIndex
    ? [{...spans[index]!, text: cell.text, columnIndex: cell.columnIndex}] : [])}));
}

function locateSpan(page: DocumentPageArtifact, region: DocumentRegion, span: Span): EvidenceAnchor[] {
  const raw = region.raw_text!, offset = [...raw.slice(0,span.start)].length;
  if (span.end <= span.start) return [];
  return anchorsForText(page.page, [region], raw.slice(span.start,span.end))
    .filter(anchor => anchor.text_span_refs.length === 1 && anchor.text_span_refs[0]!.offset === offset)
    .map(anchor => ({...anchor, localization_status: 'block_only' as const, candidate_anchor_ids: [], reason: 'table_record_region_only'}));
}

/** A whole independent OCR/native line can improve navigation only when it
 * uniquely corresponds to this table value. Repeated names remain table-level. */
function textLocation(page: DocumentPageArtifact, table: DocumentRegion, cell: Cell, rows: Row[]): EvidenceAnchor[] {
  const value = normalized(cell.text);
  if (!value || rows.flatMap(row => row.cells).filter(other => normalized(other.text) === value).length !== 1) return [];
  const matches = page.regions.filter(region => region !== table && region.kind === 'text' && valid(page,region) && inside(region,table) && normalized(region.raw_text!) === value);
  if (!matches.length) return [];
  // Independent producers may corroborate the same rectangle, but two separated
  // occurrences cannot be selected by reading order or text equality.
  const first = bounds(matches[0]!);
  if (matches.some(region => {
    const b = bounds(region), overlap = Math.max(0,Math.min(first[2]!,b[2]!)-Math.max(first[0]!,b[0]!)) * Math.max(0,Math.min(first[3]!,b[3]!)-Math.max(first[1]!,b[1]!));
    return overlap / Math.min((first[2]!-first[0]!)*(first[3]!-first[1]!), (b[2]!-b[0]!)*(b[3]!-b[1]!)) < .8;
  })) return [];
  const region = matches.sort((a,b) => {
    const x=bounds(a), y=bounds(b);
    return (x[2]!-x[0]!)*(x[3]!-x[1]!)-(y[2]!-y[0]!)*(y[3]!-y[1]!);
  })[0]!;
  return anchorsForText(page.page,[region],region.raw_text!).map(anchor => ({...anchor, granularity: 'line' as const, localization_status: 'block_only' as const, reason: 'table_value_corresponding_text'}));
}

const headers: Record<FieldTableRecord['kind'], Array<{role: Component['role']; labels: string[]}>> = {
  meeting: [{role:'date',labels:['date','日期']},{role:'time',labels:['time','时间','時間']},{role:'place',labels:['place','venue','地点','地點']}],
  signatory: [{role:'name_capacity',labels:['name and capacity','name & capacity','姓名及职务','姓名及職務']},
    {role:'identity_record',labels:['identity record','身份证明记录','身份證明記錄']},
    {role:'specimen',labels:['authorized specimen','authorised specimen','specimen signature','signature specimen','签字样本','簽字樣本']}],
};

/** Recomputed on reads from immutable source. Leaves candidates, decisions,
 * coverage, adoption and stored artifacts byte-for-byte unchanged. */
export function projectTableRecords(input: TableRecordsInput): {fields: DocumentFieldPresentation[]; anchors: EvidenceAnchor[]} {
  const anchorMap = new Map(input.anchors.map(anchor => [anchor.anchor_id,anchor]));
  const fields = input.fields.map(field => {
    const {tableRecords: _old, ...clean} = field;
    const definition = input.definitions.find(value => value.id === field.fieldId);
    if (!definition || !supportsTableRecords(definition) || definition.recipe.mode === 'manual' || field.humanRevisionId || field.status === 'not_applicable' ||
      field.semanticFilter?.state !== 'completed' || !field.candidates.length) return clean;
    const kind = field.fieldId === 'cgt_field_25' ? 'meeting' : 'signatory';
    const records: FieldTableRecord[] = [];
    for (const material of input.logicalDocuments.filter(value => value.labelId === 'cgt_resolution' && ['candidate','confirmed'].includes(value.status))) {
      if (material.pageNumbers.some(number => input.logicalDocuments.some(other => other.id !== material.id && other.pageNumbers.includes(number)))) continue;
      for (const page of input.pages.filter(value => material.pageNumbers.includes(value.page.page_number) && value.scope.documentVersionId === field.documentVersionId && value.scope.parseRevision === field.parseRevision)) {
        for (const region of page.regions.filter(value => value.kind === 'table' && value.source === 'vl_ocr' && page.canonicalRegionIds.includes(value.region_id) && material.regionIds.includes(value.region_id) && valid(page,value))) {
          let rows: Row[];
          try { rows = sourceRows(page,region); } catch { continue; }
          if (rows.length < 2) continue;
          const header = rows[0]!;
          const columns = headers[kind].map(spec => ({...spec, cells: header.cells.filter(cell => spec.labels.includes(headerKey(cell.text)))}))
            .filter(column => column.role !== 'time' || column.cells.length > 0);
          if (columns.some(column => column.cells.length !== 1) || header.cells.length !== columns.length) continue;
          for (const row of rows.slice(1)) {
            if (row.cells.length !== columns.length || (kind === 'meeting' && columns.some(column => column.role !== 'time' && !row.cells.find(cell => cell.columnIndex === column.cells[0]!.columnIndex)?.text.trim())) ||
              kind === 'signatory' && !row.cells[columns[0]!.cells[0]!.columnIndex]!.text.trim()) continue;
            const span = {start: row.cells[0]!.start, end: row.cells.at(-1)!.end};
            const rowAnchors = locateSpan(page,region,span);
            if (rowAnchors.length !== 1) continue;
            const candidateIndexes = field.candidates.flatMap((candidate,index) => {
              if (!candidate.anchorIds.length || !candidate.pageNumbers.length || candidate.pageNumbers.some(number => number !== page.page.page_number)) return [];
              const own = candidate.anchorIds.map(id => anchorMap.get(id));
              const quotes: string[] = [];
              const rowStart = [...region.raw_text!.slice(0,span.start)].length, rowEnd = [...region.raw_text!.slice(0,span.end)].length;
              const contained = own.every(anchor => {
                if (!anchor?.text_span_refs.length) return false;
                try {validateAnchorSource(anchor,page.page,page.regions);} catch {return false;}
                quotes.push(anchor.text_span_refs.map(ref => [...page.regions.find(source => source.region_id === ref.block_id)!.raw_text!].slice(ref.offset,ref.offset+ref.length).join('')).join(' '));
                return anchor.text_span_refs.every(ref => {
                  if (ref.block_id === region.region_id) return ref.offset >= rowStart && ref.offset + ref.length <= rowEnd;
                  const source = page.regions.find(value => value.region_id === ref.block_id);
                  if (!source || source.kind !== 'text' || !valid(page,source) || !inside(source,region)) return false;
                  const text = normalized(source.raw_text!);
                  // Same spelling in another table row must never bridge people.
                  const owners = rows.slice(1).filter(other => other.cells.some(cell => normalized(cell.text).includes(text)));
                  return text.length > 1 && owners.length === 1 && owners[0] === row;
                });
              });
              const compact = (text: string) => normalized(text).replace(/\s/gu,'');
              const value = compact(candidate.rawValue);
              const quoted = value && (quotes.every(quote => compact(quote) === value) || compact(quotes.join(' ')) === value);
              return contained && quoted ? [index] : [];
            });
            // Do not manufacture results for a table the field extraction never cited.
            if (!candidateIndexes.length) continue;
            const added = [...rowAnchors, ...header.cells.flatMap(cell => locateSpan(page,region,cell))];
            const components = columns.map(column => {
              const cell = row.cells.find(value => value.columnIndex === column.cells[0]!.columnIndex)!;
              const source = cell.text.trim() ? locateSpan(page,region,cell) : rowAnchors, located = textLocation(page,region,cell,rows);
              added.push(...source,...located);
              return {role: column.role, value: normalized(cell.text), rawValue: region.raw_text!.slice(cell.start,cell.end), anchorIds: source.map(anchor => anchor.anchor_id),
                locationAnchorIds: (located.length ? located : source).map(anchor => anchor.anchor_id), localization: located.length ? 'text' as const : 'table' as const};
            });
            if (components.some(component => !component.anchorIds.length)) continue;
            // No collisions with persisted source anchors: their coordinates/status stay immutable.
            for (const anchor of added) if (!anchorMap.has(anchor.anchor_id)) anchorMap.set(anchor.anchor_id,anchor);
            records.push({id: `table-record:${sha256(JSON.stringify([field.id,material.id,region.region_id,region.raw_text_sha256,row.rowIndex,kind]))}`,
              kind, logicalDocumentId: material.id, regionId: region.region_id, rowIndex: row.rowIndex, pageNumber: page.page.page_number,
              sourceTextSha256: region.raw_text_sha256!, anchorIds: unique(added.map(anchor => anchor.anchor_id)), candidateIndexes, components});
          }
        }
      }
    }
    if (!records.length) return clean;
    // Multiple rows claiming the same source are ambiguous; retain the old view.
    const indexes = records.flatMap(record => record.candidateIndexes);
    if (unique(indexes).length !== indexes.length) return clean;
    return {...clean, tableRecords: {version: 'source-table-records-v1' as const, records,
      otherCandidateIndexes: field.candidates.flatMap((_,index) => indexes.includes(index) ? [] : [index])}};
  });
  return {fields, anchors: [...anchorMap.values()]};
}
