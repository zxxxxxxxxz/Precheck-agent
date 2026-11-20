import {visibleProcessingGap,visibleProcessingGaps} from './processing-attention.ts';
import {distinctSourceCandidates, presentationFieldCandidates, type DocumentFieldPresentation} from '@hsbc/contracts/document-presentation';
import {meetingOtherCandidateIndexes} from './meeting-other-mentions.ts';
import {assessFieldQuality, fieldQualityReason} from '@hsbc/contracts/field-quality';
export {presentationFieldCandidates} from '@hsbc/contracts/document-presentation';
import {describeProcessingNote} from '../../processing-notes.ts';
import type {EvidenceAnchor, DocumentFieldObservation, FieldsResponse, LogicalDocument} from './types.ts';
import {documentMaterialScope} from './material-scope.ts';
import {isCorporateSectionHeading, CORPORATE_ARTICLES_REVIEW_INPUTS, scopeCorporateArticlesQuorum} from '@hsbc/contracts/corporate-requirements';
import {PERSONAL_IDENTITY_HIDDEN_FIELDS, PERSONAL_IDENTITY_SOURCE_FIELDS} from '@hsbc/contracts/personal-requirements';
export const processingLabels: Record<string, string> = {configuration_required: '待绑定审核配置', parked: '尚未解析', capability_disabled: '尚未解析', pending: '待解析', queued: '等待解析', running: '正在解析', processing: '正在解析', ready: '解析完成', partial: '处理已结束', failed: '解析失败', canceled: '已取消', stale: '结果已失效', succeeded: '解析完成', completed: '解析完成'};
export const localizationLabels = {exact: '已对齐原文', block_only: '仅定位到区域', ambiguous: '存在多个候选', unavailable: '无法精确定位'};
export const granularityLabels = {block: '区域', line: '行', word: '词 / 字', cell: '单元格'};
export function gapLabel(value: string) {return describeProcessingNote(value).title;}
export function pageNumbers(value: string, maximum: number): number[] {
  const values = new Set<number>();
  for (const part of value.split(/[,，\s]+/).filter(Boolean)) {
    if (!/^\d+(-\d+)?$/.test(part)) throw new Error('页码格式应为 1, 2, 5-8');
    const [start, end = start] = part.split('-').map(Number);
    if (start < 1 || end < start || end > maximum) throw new Error(`页码须在 1–${maximum} 之间`);
    for (let page = start; page <= end; page++) values.add(page);
  }
  if (!values.size) throw new Error('至少选择一页');
  return [...values].sort((a, b) => a - b);
}
export function pageTransform(width: number, height: number, rotation: number) {
  const angle = ((rotation % 360) + 360) % 360;
  if (angle === 90) return {width: height, height: width, transform: `translate(${height} 0) rotate(90)`};
  if (angle === 180) return {width, height, transform: `translate(${width} ${height}) rotate(180)`};
  if (angle === 270) return {width: height, height: width, transform: `translate(0 ${width}) rotate(270)`};
  return {width, height, transform: ''};
}
export function anchorsFor(ids: readonly string[], anchors: readonly EvidenceAnchor[], documentId: string, parseRevision: string) {
  const wanted = new Set(ids);
  return anchors.filter(anchor => wanted.has(anchor.anchor_id) && anchor.document_version_id === documentId && anchor.parse_revision === parseRevision);
}

export function formatPages(values: readonly number[]): string {
  const sorted = [...new Set(values)].sort((a, b) => a - b);
  const result: string[] = [];
  for (let i = 0; i < sorted.length; i++) {
    const start = sorted[i];
    let end = start;
    while (sorted[i + 1] === end + 1) {i++; end = sorted[i];}
    result.push(start === end ? String(start) : `${start}–${end}`);
  }
  return result.join('、');
}

/** Common processing limitations are displayed once; field-specific uncertainty stays with its field. */
export function documentGaps(pages: readonly {coverageGaps: readonly string[]}[], fields: readonly {coverageGaps: readonly string[]}[], aggregateGaps: readonly string[] = []): string[] {
  const shared = new Set(pages.flatMap(page => page.coverageGaps));
  // Bundle limitations may be attached only to populated fields, so intersecting
  // every visible field misses them when applicable empty fields are present.
  // Only known file-level limitations qualify; unknown and field-specific gaps
  // must still warn on the affected row.
  const fileLimitations = new Set(['native_text_visibility_or_geometry_unverified', 'geometry_degenerate_or_not_clockwise',
    'non_text_visual_content_unverified', 'text_layer_trust_not_established', 'non_text_visible_ink_unclassified',
    'table_merged_cells_unsupported', 'table_column_headers_unavailable', 'table_html_element_unsupported',
    'logical_directory_requires_confirmation']);
  for (const gap of aggregateGaps) if (fileLimitations.has(gap)) shared.add(gap);
  const fieldSpecific = new Set(['field_not_found_in_processed_scope', 'multiple_field_candidates', 'normalization_requires_confirmation', 'entity_candidate_requires_confirmation', 'repeated_value_object_association_unconfirmed']);
  if (fields.length > 1) {
    const [first, ...rest] = fields.map(field => new Set(field.coverageGaps));
    for (const gap of first) if (!fieldSpecific.has(gap) && !gap.startsWith('semantic_filter_') && rest.every(set => set.has(gap))) shared.add(gap);
  }
  return visibleProcessingGaps([...shared]).sort();
}
/** What is left for one field after the file-level gaps are taken out. */
export function fieldOwnGaps(field: {coverageGaps: readonly string[]}, shared: readonly string[]): string[] {
  const exclude = new Set(shared);
  return [...new Set(field.coverageGaps)].filter(gap => !exclude.has(gap) && visibleProcessingGap(gap));
}
/** Equal displayed values remove only the duplicate-value warning, never object/identity or coverage uncertainty. */
export function presentationFieldGaps(field: Pick<DocumentFieldObservation, 'candidates' | 'coverageGaps' | 'valueMultiplicity'>): string[] {
  const sameValue = field.candidates.length > 1 && presentationFieldCandidates(field.candidates, field.valueMultiplicity).length === 1;
  return field.coverageGaps.filter(gap => !sameValue || gap !== 'multiple_field_candidates');
}
/** Unfiltered source candidates are trace material, never effective values when semantic filtering is required. */
export function requiresFieldSemanticFilter(fieldId: string, scope?: {filterEnabled?: boolean; filterFieldIds?: readonly string[]}): boolean {
  return scope?.filterFieldIds === undefined ? Boolean(scope?.filterEnabled) : scope.filterFieldIds.includes(fieldId);
}
export function presentationFieldObservation(source: DocumentFieldPresentation, requireSemanticFilter = false): DocumentFieldPresentation {
  if ((source.semanticFilter && source.semanticFilter.state !== 'completed') || (requireSemanticFilter && !source.semanticFilter)) {
    const obsoleteCandidateGaps = new Set(['field_not_found_in_processed_scope', 'multiple_field_candidates', 'normalization_requires_confirmation', 'entity_candidate_requires_confirmation', 'repeated_value_object_association_unconfirmed']);
    const {tableRecords: _records, ...unfiltered} = source;
    return {...unfiltered, status: 'uncertain', candidates: [], rawValue: null, normalizedValue: null, anchorIds: [], pageNumbers: [], coverageGaps: source.coverageGaps.filter(gap => !obsoleteCandidateGaps.has(gap))};
  }
  const candidates = presentationFieldCandidates(source.candidates, source.valueMultiplicity);
  const sameValue = source.candidates.length > 1 && candidates.length === 1 && !!candidates[0].rawValue.trim();
  return {...source, candidates, coverageGaps: presentationFieldGaps(source),
    rawValue: sameValue ? candidates[0].rawValue : source.rawValue,
    normalizedValue: sameValue ? candidates[0].normalizedValue : source.normalizedValue,
    anchorIds: [...new Set([...source.anchorIds, ...candidates.flatMap(candidate => candidate.anchorIds)])]};
}
export type FieldRowTone = 'plain' | 'muted' | 'warning';
/** Row status words: never "存在候选" for a single value, never a bare dash for a missing one. */
export function fieldRowState(field: Pick<DocumentFieldPresentation, 'status' | 'candidates' | 'rawValue' | 'semanticFilter' | 'valueMultiplicity' | 'extractionCoverage' | 'tableRecords' | 'signatureRecords'> & {fieldId?:string}, ownGaps: readonly string[], requireSemanticFilter = false): {label: string; tone: FieldRowTone} {
  if (field.signatureRecords) {
    const source = field.signatureRecords;
    const count = source.records.filter(record => record.presence === 'graphic' || record.presence === 'handwriting').length;
    if (source.state === 'unavailable') return {label: '签署识别未完成', tone: 'warning'};
    const label = count ? `已找到 ${count} 处${source.purpose === 'specimen' ? '签字样本' : '签署'}` : '未检测到签字图形';
    const needsAttention = !count || source.coverageIncomplete || source.records.some(record =>
      record.presence === 'unknown');
    return {label, tone: needsAttention ? 'warning' : 'plain'};
  }
  const filter = field.semanticFilter;
  if (filter?.state === 'pending' || (requireSemanticFilter && !filter)) return {label: '待筛选', tone: 'warning'};
  if (filter?.state === 'failed') return {label: '筛选未完成', tone: 'warning'};
  if (filter?.state === 'unsupported') return {label: '暂不支持筛选', tone: 'warning'};
  // Coverage is field-local even when its repeated gap text is shown once at file level.
  const completionFailed = field.extractionCoverage?.completion === 'failed' || field.extractionCoverage?.completion === 'unknown' || ownGaps.includes('cloud_completion_incomplete');
  const coverageReasons = new Set(visibleProcessingGaps([...(field.extractionCoverage?.reasonCodes ?? []), ...ownGaps.filter(code=>code.startsWith('cloud_')||code==='field_role_requires_confirmation')]));
  const incomplete = completionFailed || (field.extractionCoverage !== undefined && field.extractionCoverage.state !== 'complete' && coverageReasons.size > 0);
  // A completed extraction can still have uncertain source coverage. Legacy
  // records only identify that uncertainty; never infer a failed/running job.
  const incompleteLabel = completionFailed ? '补查未完成'
    : coverageReasons.has('cloud_field_capacity_incomplete') ? '提取范围不完整'
    : coverageReasons.has('cloud_field_pages_unreviewed') ? '部分页面未核查'
    : coverageReasons.has('cloud_field_material_scope_unknown') ? '材料范围待核对'
    : coverageReasons.has('cloud_field_source_unverified') ? '部分候选依据待核对'
    : coverageReasons.has('field_role_requires_confirmation') ? '角色依据待核对'
    : '完整性待核对';
  if (field.status === 'not_applicable' && !field.candidates.length && filter?.state === 'completed' && !incomplete) return {label: '不适用', tone: 'muted'};
  if (filter?.state === 'completed') {
    const count = presentationFieldCandidates(field.candidates, field.valueMultiplicity).length;
    const confirmationOnly = new Set(['normalization_requires_confirmation', 'entity_candidate_requires_confirmation', 'repeated_value_object_association_unconfirmed']);
    if (field.candidates.some(candidate => candidate.sourceReviewCodes?.includes('insurance_name_source_disagreement'))) confirmationOnly.add('insurance_name_source_disagreement');
    const quality=assessFieldQuality({...field,coverageGaps:ownGaps},{multiple:true});
    const sourceGap = quality.reasonCodes.find(gap => (visibleProcessingGap(gap)||gap==='source_text_conflict') && !confirmationOnly.has(gap));
    const hasSourceGap = sourceGap !== undefined;
    const extracted = (label: string): {label: string; tone: FieldRowTone} => incomplete
      ? {label: `${label} · ${incompleteLabel}`, tone: 'warning'}
      : sourceGap ? {label: `${label} · ${fieldQualityReason(sourceGap)}`, tone: 'warning'} : {label, tone: 'plain'};
    if (field.tableRecords?.records.length) {
      const records = field.tableRecords.records;
      const label = records[0].kind === 'meeting' ? '已提取' : `已整理 ${records.length} 条表内人员记录`;
      return extracted(label);
    }
    if (!count && incomplete) return {label: incompleteLabel, tone: 'warning'};
    if (!count && filter.decisions.some(entry => entry.decision === 'uncertain')) return {label: '有候选待人工核对', tone: 'warning'};
    if (!count) return {label: '未找到有依据的值', tone: 'muted'};
    if(count && ['cgt_field_45','cgt_field_47'].includes(field.fieldId??''))return extracted(`已提取 ${count} 项`);
    if(count && field.valueMultiplicity==='entities')return extracted(`已提取 ${count} 个名称组`);
    if(count && field.valueMultiplicity==='clauses')return extracted(`已提取 ${count} 项`);
    if (incomplete) return extracted(count > 1 ? `已保留 ${count} 个值` : '已提取');
    if (count && hasSourceGap) return extracted(count > 1 ? `已保留 ${count} 个值` : '已提取');
    if (count > 1) return {label: `已保留 ${count} 个值`, tone: field.status === 'uncertain' ? 'warning' : 'plain'};
    if (count === 1 && field.candidates[0].anchorIds.length && !hasSourceGap) return {label: '已提取', tone: 'plain'};
  }
  if (field.status === 'not_found') return {label: '未提取到', tone: 'muted'};
  if (field.status === 'not_applicable') return {label: '不适用', tone: 'muted'};
  const candidates = presentationFieldCandidates(field.candidates, field.valueMultiplicity);
  if (candidates.length > 1) return {label: `多个候选（${candidates.length}）`, tone: 'warning'};
  if (field.status === 'uncertain') return {label: '需人工确认', tone: 'warning'};
  return ownGaps.length ? {label: '已提取 · 待核对', tone: 'plain'} : {label: '已提取', tone: 'plain'};
}
/** Source anchors grouped by page, in page order, for compact "p3" locator links. */
export function groupAnchorsByPage(ids: readonly string[], anchors: readonly EvidenceAnchor[]): {page: number; ids: string[]}[] {
  const groups = new Map<number, string[]>();
  for (const id of ids) {
    const anchor = anchors.find(entry => entry.anchor_id === id);
    if (!anchor) continue;
    groups.set(anchor.page_number, [...(groups.get(anchor.page_number) ?? []), id]);
  }
  return [...groups.entries()].sort(([a], [b]) => a - b).map(([page, list]) => ({page, ids: list}));
}
/** Line-level marks for version comparison: a line is "changed" when the other side has no identical line. Text only, no business judgement. */
export function diffLines(text: string, other: string): {text: string; changed: boolean}[] {
  const peer = new Set(other.split('\n').map(line => line.trim()).filter(Boolean));
  return text.split('\n').filter(line => line.trim()).map(line => ({text: line, changed: !peer.has(line.trim())}));
}

export {fieldDisplayText} from '@hsbc/contracts/document-presentation';

/** Only the server's current whole-file classification may hide a field. Missing values never do. */
export function visibleDocumentFields(response: FieldsResponse | undefined, directoryRevision?: string | number, directory?: readonly LogicalDocument[]): DocumentFieldPresentation[] {
  if (!response) return [];
  const scope=documentMaterialScope(response,directoryRevision,directory);
  if(scope&&scope.status!=='resolved')return [];
  const applicability = response.applicability;
  const current = applicability && String(applicability.directoryRevision) === String(response.directoryRevision)
    && (directoryRevision === undefined || String(directoryRevision) === String(applicability.directoryRevision));
  return (response.presentationItems ?? response.items).filter(field => {
    if((PERSONAL_IDENTITY_HIDDEN_FIELDS as readonly string[]).includes(field.fieldId)||field.fieldId==='pg_note_required'||isCorporateSectionHeading(field.fieldId)||(CORPORATE_ARTICLES_REVIEW_INPUTS as readonly string[]).includes(field.fieldId))return false;
    if(scope){
      const definition=response.fieldCapabilities?.find(entry=>entry.id===field.fieldId);
      if(definition?.taxonomyIds?.length&&!definition.taxonomyIds.includes(scope.taxonomyId!))return false;
      if(current)return applicability.byFieldId[field.fieldId]==='applicable';
      return !applicability && !!definition;
    }
    return !current || applicability.byFieldId[field.fieldId] !== 'not_applicable';
  }).sort((a,b)=>{
    const ids:readonly string[]=PERSONAL_IDENTITY_SOURCE_FIELDS;
    return ids.includes(a.fieldId)&&ids.includes(b.fieldId)?ids.indexOf(a.fieldId)-ids.indexOf(b.fieldId):0;
  }).map(field => field.fieldId==='pg_field_39'?{...field,fieldLabel:'国别与地区'}:field)
    .map(scopeCorporateArticlesQuorum).map(field => distinctSourceCandidates(field, response.anchors));
}

/** Split the legacy combined field for reading, preserving its underlying field
 * identity for corrections and every original candidate in the details panel. */
export function meetingFieldRows(field: DocumentFieldPresentation): DocumentFieldPresentation[] {
  if (field.fieldId !== 'cgt_field_25' || !field.tableRecords?.records.length || field.humanRevisionId) return [field];
  const roles = field.fieldLabel === '会议日期' ? ['date'] as const : ['date', 'place'] as const;
  const otherCandidateIndexes = meetingOtherCandidateIndexes(field);
  return roles.map(role => {
    const records = field.tableRecords!.records.map(record => {
      const component = record.components.find(c => c.role === role);
      const time = role === 'date' ? record.components.find(c => c.role === 'time' && c.value.trim()) : undefined;
      const parts = [component, time].filter((c): c is NonNullable<typeof c> => !!c);
      return {...record, components: component ? [{...component,
        value: parts.map(c => c.value).join('  '),
        anchorIds: [...new Set(parts.flatMap(c => c.anchorIds))],
        locationAnchorIds: [...new Set(parts.flatMap(c => c.locationAnchorIds))],
      }] : []};
    }).filter(record => record.components.length);
    return {...field, id: `${field.id}:meeting-${role}`, fieldLabel: role === 'date' ? '会议日期' : '会议地点',
      anchorIds: [...new Set(records.flatMap(r=>r.components.flatMap(c=>c.locationAnchorIds)))],
      tableRecords: {...field.tableRecords!, records, otherCandidateIndexes: role === 'date' ? otherCandidateIndexes : []}};
  });
}
