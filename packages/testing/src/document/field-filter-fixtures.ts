import { createHash } from 'node:crypto';
import { DocumentBundleSchema, DocumentPageArtifactSchema, type DocumentBundle, type DocumentPageArtifact } from '@hsbc/contracts/documents';

const hash = (text: string) => createHash('sha256').update(text).digest('hex');
export interface DocumentFieldFilterFixture {
  id: string; bundle: DocumentBundle; pages: DocumentPageArtifact[]; expectedSelectedValues: string[];
}
/** Hand-authored public synthetic text only; no source files, credentials or DB. */
export function buildDocumentFieldFilterFixture(input: { id: string; blocks: string[]; candidates: string[]; expectedSelectedValues?: string[]; fieldId?: string }): DocumentFieldFilterFixture {
  const fieldId = input.fieldId ?? 'borrower', documentVersionId = `synthetic-${input.id}`, parseRevision = 'synthetic-parse-1';
  const sourceSha256 = hash(JSON.stringify(input.blocks));
  const scope = { caseId: 'synthetic-field-filter', caseRevision: 1, configurationReleaseId: 'synthetic-field-filter-v1', documentVersionId, parseRevision, sourceSha256 };
  const pageId = `${documentVersionId}:page:1`, polygon = [[1, 1], [200, 1], [200, 20], [1, 20]];
  const regions = input.blocks.map((text, index) => ({ region_id: `region-${index + 1}`, page_asset_id: pageId, document_version_id: documentVersionId, parse_revision: parseRevision,
    source: 'native_pdf', source_id: `synthetic-source-${index + 1}`, kind: 'text', reading_order: index, raw_text: text, raw_text_sha256: hash(text), polygons: [polygon],
    processing_status: 'ready', coverage: ['text'], coverage_gaps: [], localization_reason: null }));
  const anchors = regions.map(region => ({ schema_version: 'p0.v1', anchor_id: `anchor-${region.region_id}`, evidence_kind: 'text', document_version_id: documentVersionId, parse_revision: parseRevision,
    page_asset_id: pageId, page_number: 1, block_ids: [region.region_id], text_span_refs: [{ block_id: region.region_id, offset: 0, length: [...region.raw_text].length, offset_unit: 'unicode_code_point' }],
    polygons: [polygon], granularity: 'block', localization_status: 'block_only', localization_source: 'synthetic-fixture', configuration_version: 'synthetic-v1', reason: null, candidate_anchor_ids: [] }));
  const candidates = input.candidates.map(value => ({ rawValue: value, normalizedValue: value,
    anchorIds: anchors.filter((_, index) => input.blocks[index]!.includes(value)).map(anchor => anchor.anchor_id), pageNumbers: [1] }));
  const page = DocumentPageArtifactSchema.parse({ schema_version: 'p2.v1', scope, page: { schema_version: 'p0.v1', page_asset_id: pageId, document_version_id: documentVersionId, parse_revision: parseRevision,
    page_number: 1, printed_page_label: null, width: 612, height: 792, source_sha256: sourceSha256, renderer: 'synthetic-fixture', renderer_config: 'synthetic-v1', pdf_view_box: [0, 0, 612, 792], intrinsic_rotation: 0, pdf_to_page: [1, 0, 0, -1, 0, 792] },
    regions, anchors, imageSha256: hash('synthetic-fixture-no-image'), status: 'ready', nativeTrust: 'validated_geometry_and_visibility', route: 'native', coverageGaps: [], canonicalRegionIds: regions.map(region => region.region_id), duplicates: [], conflicts: [], classifications: [], signatures: [], entityCandidates: [],
    processing: { engineVersion: 'synthetic-v1', configVersion: 'synthetic-field-filter-v1', ocr: 'not_needed', ocrSimulated: false, elapsedMs: 0 } });
  const bundle = DocumentBundleSchema.parse({ schema_version: 'p2.v1', scope, directoryRevision: '1', pageCount: 1, logicalDocuments: [], structures: [], tables: [], signatures: [], anchors, chunks: [], coverageGaps: [], status: 'ready',
    fields: [{ id: `field-${fieldId}`, fieldId, fieldLabel: fieldId, documentVersionId, parseRevision, status: 'uncertain', rawValue: null, normalizedValue: null, pageNumbers: [1], anchorIds: candidates.flatMap(candidate => candidate.anchorIds), candidates, objectId: null, humanRevisionId: null, coverageGaps: ['multiple_field_candidates', 'entity_candidate_requires_confirmation'] }],
    indexManifest: { id: 'synthetic-index', schema_version: 'p2.v1', scope, directoryRevision: '1', configVersion: 'synthetic-field-filter-v1', taxonomyVersion: 'synthetic-v1', fieldDictionaryVersion: 'synthetic-v1', indexVersion: 'synthetic-v1', status: 'ready', indexedPageNumbers: [1], expectedPageCount: 1, chunkIds: [], sourceFingerprint: hash('synthetic-source'), coverageGaps: [], retrieval: { lexical: 'unicode-terms-v1', embedding: null, reranker: null, modelEvaluation: 'unverified' } } });
  return { id: input.id, bundle, pages: [page], expectedSelectedValues: input.expectedSelectedValues ?? [] };
}

export function documentFieldFilterFixtures(): DocumentFieldFilterFixture[] {
  const noise = ['保险人', '海啸', '地震', '投保人', '被保险人', '抵押权条款', '虚构筠浦有限公司', '保险金额', '火灾', '建筑物', '保险期间', '特别费用', '专业费用', '洪水', '贷款银行', '保单号码', '独立被保险人条款', '虚构栖澜有限公司', '附加险', '错误与遗漏', '预付赔款', '烟熏扩展', '虚构霁屿有限公司', '72小时条款'];
  const insuranceText = `财产保险单。保险人：虚构澄松保险公司。投保人：虚构筠浦有限公司。被保险人：虚构栖澜有限公司。保单记载抵押权人：虚构霁屿有限公司。本保单没有指定借款人。保险期间为一年。条款与栏目：${noise.filter(value => !value.startsWith('虚构')).join('、')}。贷款银行一词仅出现在通用条款定义中。`;
  return [
    buildDocumentFieldFilterFixture({ id: 'insurance-zero-supported', blocks: [insuranceText], candidates: noise }),
    buildDocumentFieldFilterFixture({ id: 'insurance-without-explicit-borrower-negation', blocks: [insuranceText.replace('本保单没有指定借款人。', '')], candidates: noise }),
    buildDocumentFieldFilterFixture({ id: 'loan-one-current-party', blocks: [insuranceText,
      '本贷款的原借款人为虚构栖澜有限公司，原记录已被以下生效变更取代。',
      '生效借款人变更协议：虚构栖澜有限公司退出借款人身份并不再承担本贷款的还款义务。唯一现借款人是虚构筠浦有限公司，由其承担全部还款义务。虚构霁屿有限公司仅提供担保。',
      '虚构筠浦有限公司作为现借款人签署本贷款的生效变更协议。'], candidates: noise, expectedSelectedValues: ['虚构筠浦有限公司'] }),
    buildDocumentFieldFilterFixture({ id: 'loan-three-joint-parties', blocks: [insuranceText,
      '贷款协议：虚构筠浦有限公司、虚构栖澜有限公司和虚构霁屿有限公司均为本贷款的现共同借款人，三家公司共同承担还本付息义务。此共同借款安排现已生效。'], candidates: noise,
      expectedSelectedValues: ['虚构筠浦有限公司', '虚构栖澜有限公司', '虚构霁屿有限公司'] }),
  ];
}
