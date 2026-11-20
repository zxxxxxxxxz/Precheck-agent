import { z } from 'zod';
import { DocumentRegionSchema, EvidenceAnchorSchema, PageAssetSchema } from './evidence.js';
import { DocumentOcrMarkPageSchema } from './ocr-marks.js';
import { DocumentRegionOcrSummarySchema } from './document-region-ocr.js';
export { DocumentOcrMarkPageSchema, DocumentOcrMarkSchema, DocumentOcrMarkSourceSchema, type DocumentOcrMarkPage, type DocumentOcrMark, type DocumentOcrMarkSource } from './ocr-marks.js';

const id = z.string().min(1).max(200);
const hash = z.string().regex(/^[a-f0-9]{64}$/);
export const DocumentScopeSchema = z.strictObject({
  caseId: id, caseRevision: z.number().int().positive(), configurationReleaseId: id,
  documentVersionId: id, parseRevision: id, sourceSha256: hash,
  sourceFormat: z.enum(['docx','jpg','png']).optional(), previewRevision: id.optional(), previewSha256: hash.optional(),
});
export type DocumentScope = z.infer<typeof DocumentScopeSchema>;
export const DocumentSourceAnchorSchema=z.strictObject({
  schema_version:z.literal('p2.v2'),anchor_id:id,location_scope:z.literal('source_structure'),
  document_version_id:id,parse_revision:id,sourceNodeId:id,part:z.string(),path:z.string(),
  granularity:z.enum(['paragraph','cell','symbol','node']),previewRevision:id.nullable(),
  localization_status:z.enum(['source_only','mapped','ambiguous']),page_numbers:z.array(z.number().int().positive()),candidate_anchor_ids:z.array(id),
});
export type DocumentSourceAnchor=z.infer<typeof DocumentSourceAnchorSchema>;
export const DocumentTaxonomyEntrySchema = z.strictObject({ id, label: z.string().min(1), keywords: z.array(z.string().min(1)).min(1) });
export const DocumentFieldDefinitionSchema = z.strictObject({
  id, label: z.string().min(1), aliases: z.array(z.string().min(1)).min(1),
  type: z.enum(['text', 'amount', 'date', 'currency']).default('text'),
  candidateExtraction:z.enum(['cloud','manual']).optional(),
});
export type DocumentFieldDefinition = z.infer<typeof DocumentFieldDefinitionSchema>;
export const DocumentEngineConfigSchema = z.strictObject({
  classificationMode:z.literal('content-first-v1').optional(),
  version: id, taxonomyVersion: id, fieldDictionaryVersion: id,
  taxonomy: z.array(DocumentTaxonomyEntrySchema), fields: z.array(DocumentFieldDefinitionSchema),
  renderScale: z.number().min(0.5).max(2).default(1.25),
  maxPagePixels: z.number().int().min(10000).max(20000000).default(10000000),
  maxPageCharacters: z.number().int().min(100).max(1000000).default(100000),
  maxRegions: z.number().int().min(1).max(20000).default(5000),
  maxOcrImageBytes: z.number().int().positive().max(10485760).default(10485760),
  ocrTimeoutMs: z.number().int().positive().max(180000).default(120000),
});
export type DocumentEngineConfig = z.infer<typeof DocumentEngineConfigSchema>;
export const DocumentClassificationSchema = z.strictObject({
  regionId: id, labelId: id.nullable(), candidates: z.array(id),
  status: z.enum(['candidate', 'unknown', 'conflict']),
  source: z.enum(['configured_keyword', 'ner_adapter', 'manual']),
  confidence: z.number().min(0).max(1).nullable(),
});
export const DocumentSignatureCandidateSchema = z.strictObject({
  id, pageNumber: z.number().int().positive(), regionIds: z.array(id), anchorIds: z.array(id),
  status: z.literal('needs_human_confirmation'),
  kind: z.enum(['signature_label', 'ocr_signature_region', 'visual_ink_candidate', 'image_unclassified']),
  name: z.string().nullable(), title: z.string().nullable(), date: z.string().nullable(),
  authorizationReferences: z.array(z.string()), contextText: z.string(),
  handwritingAssessment: z.literal('not_performed'), coverageGaps: z.array(z.string()),
});
export const DocumentPageArtifactSchema = z.strictObject({
  schema_version: z.enum(['p2.v1','p2.v2']), scope: DocumentScopeSchema,
  // Geometry remains the independently tested, backwards-compatible P0 DTO.
  page: PageAssetSchema, regions: z.array(DocumentRegionSchema), anchors: z.array(EvidenceAnchorSchema),
  imageSha256: hash, status: z.enum(['ready', 'partial', 'failed']),
  nativeTrust: z.enum(['validated_geometry_and_visibility', 'requires_validation', 'unavailable']),
  route: z.enum(['native', 'ocr', 'mixed', 'image_only']), coverageGaps: z.array(z.string()),
  canonicalRegionIds: z.array(id),
  // New parses only: body selection is separate from immutable source/locator regions.
  sourceTextAssembly: z.strictObject({
    version: z.literal('line-word-source-v1'),
    wordRepresentations: z.array(z.strictObject({wordRegionId:id,parentLineRegionId:id,bodyRegionId:id})),
    uncertainRegionIds: z.array(id), withheldWordRegionIds: z.array(id),
  }).optional(),
  duplicates: z.array(z.strictObject({ canonical_region_id: id, duplicate_region_id: id })),
  conflicts: z.array(z.strictObject({ region_ids: z.tuple([id, id]), reason: z.string() })),
  classifications: z.array(DocumentClassificationSchema), signatures: z.array(DocumentSignatureCandidateSchema),
  ocrMarks: DocumentOcrMarkPageSchema.optional(),
  regionOcr: DocumentRegionOcrSummarySchema.optional(),
  entityCandidates: z.array(z.strictObject({ fieldId: id, text: z.string(), confidence: z.number().min(0).max(1), anchorIds: z.array(id), source: z.literal('ner_adapter'), simulated: z.boolean() })).default([]),
  processing: z.strictObject({ engineVersion: id, configVersion: id, ocr: z.enum(['not_needed', 'unavailable', 'completed', 'failed']), ocrSimulated: z.boolean(), elapsedMs: z.number().nonnegative() }),
});
export type DocumentPageArtifact = z.infer<typeof DocumentPageArtifactSchema>;
export type DocumentSignatureCandidate = z.infer<typeof DocumentSignatureCandidateSchema>;

export const DocumentLogicalDocumentSchema = z.strictObject({
  id, labelId: id.nullable(), label: z.string(), status: z.enum(['candidate', 'unknown', 'conflict', 'confirmed']),
  pageNumbers: z.array(z.number().int().positive()), regionIds: z.array(id),
  source: z.enum(['classification', 'manual']),
  sourceNodeIds:z.array(id).optional(),
  sourceCoverageComplete:z.boolean().optional(),
});
export const DocumentStructureNodeSchema = z.strictObject({
  id, logicalDocumentId: id, kind: z.enum(['heading', 'clause', 'definition', 'appendix', 'table', 'image']),
  label: z.string().nullable(), text: z.string(), pageNumbers: z.array(z.number().int().positive()),
  regionIds: z.array(id), anchorIds: z.array(id), parentId: id.nullable(),
  sourceNodeIds:z.array(id).optional(),
  references: z.array(z.strictObject({ label: z.string(), targetIds: z.array(id), required: z.boolean(), status: z.enum(['resolved', 'ambiguous', 'missing']) })),
  coverageGaps: z.array(z.string()),
});
export type DocumentStructureNode = z.infer<typeof DocumentStructureNodeSchema>;
export const DocumentTableObservationSchema = z.strictObject({
  id, documentVersionId: id, parseRevision: id, pageNumber: z.number().int().positive(), regionId: id,
  logicalDocumentId: id.nullable(), structureNodeId: id.nullable(), anchorIds: z.array(id),
  rawText: z.string().nullable(), rawTextSha256: hash.nullable(),
  format: z.enum(['markdown', 'html', 'unsupported', 'image_only']), status: z.enum(['structured', 'partial', 'unavailable']),
  // Cell relations describe text structure; their anchors locate the containing source region only.
  columns: z.array(z.strictObject({ columnIndex: z.number().int().nonnegative(), headerCellIds: z.array(id) })),
  rows: z.array(z.strictObject({ rowIndex: z.number().int().nonnegative(), kind: z.enum(['header', 'body']), cellIds: z.array(id) })),
  cells: z.array(z.strictObject({ id, rowIndex: z.number().int().nonnegative(), columnIndex: z.number().int().nonnegative(), text: z.string(), anchorIds: z.array(id), granularity: z.literal('region') })),
  crossPageAssociation: z.literal('not_established'), coverageGaps: z.array(z.string()),
});
export type DocumentTableObservation = z.infer<typeof DocumentTableObservationSchema>;
const PartyRoleSourceSchema = z.strictObject({
  quote:z.string().min(1).max(2000),textSha256:hash,anchorIds:z.array(id).min(1),pageNumbers:z.array(z.number().int().positive()).min(1),
});
export const AuthorizationSourceBindingSchema = z.strictObject({
  documentVersionId:id,parseRevision:id,sourceSha256:hash,inputSha256:hash,configurationSha256:hash,
  responseSha256s:z.array(hash).min(1).max(2),scopeFieldId:id,signingConditionsFieldId:id,
});
export const AuthorizationEvidenceSchema = z.strictObject({
  version:z.literal('authorization-source-v1'),association:z.literal('candidate'),
  method:z.enum(['classified_clause','referenced_definition']),targetFieldId:id,logicalDocumentId:id,
  sourceCandidateIds:z.array(id).min(1).max(50),binding:AuthorizationSourceBindingSchema,
  definedTerm:z.string().min(1).max(120).optional(),
  sources:z.array(PartyRoleSourceSchema.extend({kind:z.enum(['operative_clause','definition'])})).min(1).max(8),
});
export const SourceCorrectionBindingSchema=z.strictObject({
  documentVersionId:id,parseRevision:id,sourceSha256:hash,inputSha256:hash,configurationSha256:hash,
  responseSha256s:z.array(hash).min(1).max(2),
});
export const SourceCorrectionEvidenceSchema=z.strictObject({
  version:z.literal('independent-line-source-v1'),association:z.literal('candidate'),
  method:z.literal('independent_line_agreement'),targetFieldId:id,logicalDocumentId:id,
  sourceCandidateIds:z.array(id).min(1).max(50),binding:SourceCorrectionBindingSchema,
  segmentIndex:z.number().int().min(0).max(5),
  originalSegment:PartyRoleSourceSchema,nativeLine:PartyRoleSourceSchema,ocrLine:PartyRoleSourceSchema,
});
export const TablePartyEvidenceSchema=z.strictObject({
  version:z.literal('table-party-role-v1'),association:z.literal('candidate'),
  method:z.literal('classified_formal_name_row'),targetFieldId:id,logicalDocumentId:id,
  sourceCandidateIds:z.array(id).min(1).max(50),binding:SourceCorrectionBindingSchema,
  table:z.strictObject({
    regionId:id,rawTextSha256:hash,rowIndex:z.number().int().min(0).max(1999),
    roleCellIndex:z.number().int().min(0).max(1999),formalNameCellIndex:z.number().int().min(0).max(1999),
    nameCellIndex:z.number().int().min(0).max(1999),
  }),
  role:PartyRoleSourceSchema,formalName:PartyRoleSourceSchema,name:PartyRoleSourceSchema,
});
export const DocumentFieldCandidateSchema = z.strictObject({
  // Model extraction confidence, not a business approval; absent on legacy receipts.
  confidence:z.number().min(0).max(1).nullable().optional(),
  contextText:z.string().max(8000).optional(),contextAnchorIds:z.array(id).optional(),entityKey:hash.optional(),
  // Readable projections never replace immutable OCR text or its source spans.
  displayValue:z.string().max(20000).optional(),
  // Explicitly bounded form record, not a claim that equally named people
  // elsewhere are the same person. Used to keep a director's fields together.
  formRecord:z.strictObject({
    version:z.literal('nar1-director-record-v1'),recordId:hash,logicalDocumentId:id,
    pageNumber:z.number().int().positive(),headingAnchorIds:z.array(id).min(1),
    association:z.literal('candidate'),
  }).optional(),
  // A local source check may retain a candidate while leaving one component
  // unresolved. Explicit per-candidate codes avoid attributing a field-wide
  // gap to unrelated limits which legitimately contain no insurance name.
  sourceReviewCodes:z.array(z.enum(['insurance_name_source_disagreement'])).min(1).max(1).optional(),
  evidenceSegments:z.array(z.strictObject({
    rawValue:z.string().max(2000),contextText:z.string().max(8000),anchorIds:z.array(id),contextAnchorIds:z.array(id),pageNumbers:z.array(z.number().int().positive()),
  })).max(8).optional(),
  structuredValue:z.strictObject({
    kind:z.enum(['authorization_clause','insurance_limit']),association:z.literal('candidate'),
    components:z.array(z.strictObject({
      role:z.enum(['subject','action','signer_combination','signing_mode','condition','insurance_name','amount','currency','percentage','percentage_base','frequency','period']),
      value:z.string().max(8000),normalizedValue:z.string().max(8000).nullable(),anchorIds:z.array(id),pageNumbers:z.array(z.number().int().positive()),
    })).max(24),
  }).optional(),
  nameAssociation:z.strictObject({
    version:z.string().min(1).max(100),groupId:z.string().min(1).max(200),basis:z.enum(['source_bilingual_pair','scoped_identifier','format_equivalent']),
    names:z.array(z.string().min(1).max(2000)).min(1).max(50),evidenceAnchorIds:z.array(id),identityConfirmed:z.literal(false),
    sourceNames:z.array(z.strictObject({
      name:z.string().min(1).max(2000),anchorIds:z.array(id).min(1),pageNumbers:z.array(z.number().int().positive()).min(1),
    })).min(1).max(50).optional(),
  }).optional(),
  roleEvidence:z.strictObject({
    version:z.literal('explicit-defined-role-v1'),association:z.literal('candidate'),
    role:id,definedTerm:z.string().min(1).max(100),logicalDocumentId:id,
    declaration:PartyRoleSourceSchema,relation:PartyRoleSourceSchema,
  }).optional(),
  authorizationEvidence:AuthorizationEvidenceSchema.optional(),
  sourceCorrectionEvidence:SourceCorrectionEvidenceSchema.optional(),
  tablePartyEvidence:TablePartyEvidenceSchema.optional(),
  rawValue: z.string(), normalizedValue: z.string().nullable(), anchorIds: z.array(id), pageNumbers: z.array(z.number().int().positive()),
});
/** Multi-page clauses retain separate immutable quotes. Adoption must carry the
 * whole ordered clause, never only the first displayed/source segment. */
export function candidateAdoptionValue(candidate: Pick<z.infer<typeof DocumentFieldCandidateSchema>,'rawValue'|'evidenceSegments'>):string {
  return candidate.evidenceSegments&&candidate.evidenceSegments.length>1?candidate.evidenceSegments.map(segment=>segment.rawValue).join('\n'):candidate.rawValue;
}
/** Each separate proof must survive explicit adoption. A malformed role candidate
 * produces an impossible group rather than allowing its role quote to stand in
 * for the company's name. This helper does not itself confirm a business fact. */
export function candidateRequiredEvidenceGroups(candidate: Pick<z.infer<typeof DocumentFieldCandidateSchema>,
  'rawValue'|'anchorIds'|'evidenceSegments'|'roleEvidence'|'authorizationEvidence'|'sourceCorrectionEvidence'|'tablePartyEvidence'>):string[][] {
  const segments=candidate.evidenceSegments;
  if(candidate.tablePartyEvidence){
    if(candidate.roleEvidence||candidate.authorizationEvidence||candidate.sourceCorrectionEvidence||
      segments?.length!==1||segments[0]!.rawValue!==candidate.rawValue)return[[]];
    return [segments[0]!.anchorIds,candidate.tablePartyEvidence.role.anchorIds,
      candidate.tablePartyEvidence.formalName.anchorIds,candidate.tablePartyEvidence.name.anchorIds];
  }
  if(candidate.sourceCorrectionEvidence){
    if(candidate.roleEvidence||candidate.authorizationEvidence||!segments?.length||segments[0]!.rawValue!==candidate.rawValue)return[[]];
    return [...segments.map(segment=>segment.anchorIds),
      candidate.sourceCorrectionEvidence.nativeLine.anchorIds,candidate.sourceCorrectionEvidence.ocrLine.anchorIds];
  }
  if(candidate.roleEvidence&&candidate.authorizationEvidence)return[[]];
  if(candidate.roleEvidence){
    if(segments?.length!==1||segments[0]!.rawValue!==candidate.rawValue)return [[]];
    const names=segments[0]!.anchorIds.filter(id=>candidate.anchorIds.includes(id));
    return [names,candidate.roleEvidence.declaration.anchorIds,candidate.roleEvidence.relation.anchorIds];
  }
  const groups=segments?.length?segments.map(segment=>segment.anchorIds):[candidate.anchorIds];
  if(candidate.authorizationEvidence){
    if(!segments?.length||segments[0]!.rawValue!==candidate.rawValue||candidate.roleEvidence)return[[]];
    return [...groups,...candidate.authorizationEvidence.sources.map(source=>source.anchorIds)];
  }
  return groups;
}
export const DocumentFieldSemanticFilterSchema = z.strictObject({
  version: z.enum(['qwen-role-filter-v1','azure-grounded-fields-v1','azure-grounded-fields-v2','azure-grounded-docx-v1','nd2a-source-fields-v1','nar1-source-fields-v1','guarantee-source-fields-v1']), state: z.enum(['completed', 'pending', 'failed', 'unsupported']), model: id.nullable(),
  // Preserve the extraction evidence, including rejected and duplicate occurrences.
  originalCandidates: z.array(DocumentFieldCandidateSchema.extend({ candidateId: id })),
  decisions: z.array(z.strictObject({ candidateId: id, decision: z.enum(['selected', 'rejected', 'uncertain']), anchorIds: z.array(id), pageNumbers: z.array(z.number().int().positive()) })),
  reasonCodes: z.array(id),
});
export const DocumentFieldObservationSchema = z.strictObject({
  id, fieldId: id, fieldLabel: z.string(), documentVersionId: id, parseRevision: id,
  status: z.enum(['extracted', 'not_found', 'uncertain', 'not_applicable']),
  rawValue: z.string().nullable(), normalizedValue: z.string().nullable(),
  pageNumbers: z.array(z.number().int().positive()), anchorIds: z.array(id),
  candidates: z.array(DocumentFieldCandidateSchema),
  valueMultiplicity:z.enum(['single','entities','clauses']).optional(),
  extractionCoverage:z.strictObject({
    reviewedPageNumbers:z.array(z.number().int().positive()),state:z.enum(['complete','incomplete','unknown']),
    reviewedSourceNodeIds:z.array(id).optional(),
    completion:z.enum(['not_requested','not_needed','completed','failed','unknown']),reasonCodes:z.array(id),
  }).optional(),
  semanticFilter: DocumentFieldSemanticFilterSchema.optional(),
  objectId: id.nullable(), humanRevisionId: id.nullable(), coverageGaps: z.array(z.string()),
});
export type DocumentFieldObservation = z.infer<typeof DocumentFieldObservationSchema>;
export const DocumentEvidenceChunkSchema = z.strictObject({
  id, documentVersionId: id, parseRevision: id, logicalDocumentId: id,
  structureNodeId: id, parentId: id.nullable(), text: z.string(), textSha256: hash,
  pageNumbers: z.array(z.number().int().positive()), regionIds: z.array(id), anchorIds: z.array(id),
  sourceNodeIds:z.array(id).optional(),
  dependencyIds: z.array(id), unresolvedReferences: z.array(z.string()), coverageGaps: z.array(z.string()),
});
export type DocumentEvidenceChunk = z.infer<typeof DocumentEvidenceChunkSchema>;
export const DocumentIndexManifestSchema = z.strictObject({
  id, schema_version: z.enum(['p2.v1','p2.v2']), scope: DocumentScopeSchema, directoryRevision: id,
  configVersion: id, taxonomyVersion: id, fieldDictionaryVersion: id,
  indexVersion: id, status: z.enum(['ready', 'partial', 'stale', 'failed']),
  indexedPageNumbers: z.array(z.number().int().positive()), expectedPageCount: z.number().int().positive().nullable(),
  chunkIds: z.array(id), sourceFingerprint: hash, coverageGaps: z.array(z.string()),
  retrieval: z.strictObject({ lexical: z.literal('unicode-terms-v1'), embedding: z.string().nullable(), reranker: z.string().nullable(), modelEvaluation: z.enum(['blocked_no_real_adapters', 'unverified', 'measured']) }),
});
export type DocumentIndexManifest = z.infer<typeof DocumentIndexManifestSchema>;
export const DocumentBundleSchema = z.strictObject({
  classificationMode:z.literal('content-first-v1').optional(),
  schema_version: z.enum(['p2.v1','p2.v2']), scope: DocumentScopeSchema, directoryRevision: id,
  pageCount: z.number().int().positive().nullable(), logicalDocuments: z.array(DocumentLogicalDocumentSchema),
  structures: z.array(DocumentStructureNodeSchema), fields: z.array(DocumentFieldObservationSchema),
  tables: z.array(DocumentTableObservationSchema).default([]),
  signatures: z.array(DocumentSignatureCandidateSchema), anchors: z.array(EvidenceAnchorSchema),
  ocrMarkPages: z.array(DocumentOcrMarkPageSchema).optional(),
  sourceAnchors:z.array(DocumentSourceAnchorSchema).optional(),
  chunks: z.array(DocumentEvidenceChunkSchema), indexManifest: DocumentIndexManifestSchema,
  coverageGaps: z.array(z.string()), status: z.enum(['ready', 'partial', 'failed']),
});
export type DocumentBundle = z.infer<typeof DocumentBundleSchema>;
export const DocumentRetrievalResultSchema = z.strictObject({
  schema_version: z.literal('p2.v1'), indexManifestId: id, indexVersion: id,
  querySha256: hash, matches: z.array(z.strictObject({ chunk: DocumentEvidenceChunkSchema, score: z.number().finite(), reason: z.enum(['lexical', 'mandatory_dependency', 'dense', 'reranked']) })),
  coverageGaps: z.array(z.string()), unresolvedDependencies: z.array(id),
  status: z.enum(['complete_for_declared_scope', 'partial', 'no_match']),
  searchedPageNumbers: z.array(z.number().int().positive()),
  budget: z.strictObject({ maxChunks: z.number().int().positive(), maxCharacters: z.number().int().positive(), maxDependencyDepth: z.number().int().nonnegative(), usedCharacters: z.number().int().nonnegative() }),
  absenceProven: z.literal(false),
});
export type DocumentRetrievalResult = z.infer<typeof DocumentRetrievalResultSchema>;
export const DocumentComparisonSchema = z.strictObject({
  schema_version: z.literal('p2.v1'), beforeDocumentVersionId: id, beforeParseRevision: id,
  afterDocumentVersionId: id, afterParseRevision: id,
  changes: z.array(z.strictObject({ kind: z.enum(['added', 'removed', 'changed', 'ambiguous']), beforeChunkIds: z.array(id), afterChunkIds: z.array(id), beforeAnchorIds: z.array(id), afterAnchorIds: z.array(id) })),
  coverageGaps: z.array(z.string()), status: z.enum(['compared', 'partial']),
  automaticallyAdoptsVersion: z.literal(false), resolvesBusinessFindings: z.literal(false),
});
export type DocumentComparison = z.infer<typeof DocumentComparisonSchema>;
export const DocumentTranslationSchema = z.strictObject({
  schema_version: z.literal('p2.v1'), id, scope: DocumentScopeSchema, sourceChunkIds: z.array(id).min(1),
  sourceAnchorIds: z.array(id).min(1), sourceSha256: hash, contextSha256: hash,
  glossaryVersion: id, promptVersion: id, clientVersion: id,
  sourceText: z.string().min(1), translatedText: z.string().nullable(),
  status: z.enum(['ready', 'failed', 'blocked']), simulated: z.boolean(),
  validity: z.enum(['current', 'stale']), reviewState: z.literal('unreviewed'),
  checks: z.array(z.strictObject({ kind: z.enum(['numbers', 'placeholders', 'structure']), passed: z.boolean() })),
  coverageGaps: z.array(z.string()),
});
export type DocumentTranslation = z.infer<typeof DocumentTranslationSchema>;
export const DocumentTranslationBindingSchema = z.strictObject({
  scope: DocumentScopeSchema, directoryRevision: id, indexManifestId: id, indexVersion: id,
  sourceChunkIds: z.array(id).min(1), sourceAnchorIds: z.array(id).min(1), sourceSha256: hash, contextSha256: hash, contextManifestSha256: hash,
  glossaryVersion: id, promptVersion: id, clientVersion: id, targetLanguage: z.literal('zh'),
});
export type DocumentTranslationBinding = z.infer<typeof DocumentTranslationBindingSchema>;
export const DocumentTranslationJobSchema = z.strictObject({
  schema_version: z.literal('p2.v1'), id, cacheKey: hash, binding: DocumentTranslationBindingSchema,
  epoch: z.number().int().positive(), status: z.enum(['queued', 'running', 'succeeded', 'failed', 'blocked', 'canceled', 'stale']),
  isolatedReplay: z.literal(true), simulated: z.literal(true), cacheHit: z.boolean(), resultId: id.nullable(), reasonCodes: z.array(id),
});
export type DocumentTranslationJob = z.infer<typeof DocumentTranslationJobSchema>;
export const DocumentTranslationCacheSchema = z.strictObject({
  schema_version: z.literal('p2.v1'), cacheKey: hash, binding: DocumentTranslationBindingSchema,
  isolatedReplay: z.literal(true), simulated: z.literal(true), validity: z.enum(['current', 'stale']),
  result: DocumentTranslationSchema,
});
export type DocumentTranslationCache = z.infer<typeof DocumentTranslationCacheSchema>;
