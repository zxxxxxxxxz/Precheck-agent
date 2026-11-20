import {SUPPLEMENTAL_MATERIAL_ID,SUPPLEMENTAL_MATERIAL_LABEL} from '@hsbc/contracts/case-supplement';
import {assertSourceTextAssembly} from '../../../document/source-text-assembly.js';
import {normalizeExtractedValue} from '../field-values.js';
import { z } from 'zod';
import { DocumentBundleSchema, DocumentLogicalDocumentSchema, DocumentPageArtifactSchema, DocumentScopeSchema, DocumentComparisonSchema, DocumentEngineConfigSchema,
  type DocumentScope, type DocumentEngineConfig, type DocumentPageArtifact, type DocumentBundle, type DocumentStructureNode, type DocumentFieldObservation, type DocumentComparison } from '@hsbc/contracts/documents';
import type { EvidenceAnchor } from '@hsbc/contracts/evidence';
import { anchorsForText, sha256, validateAnchorSource } from '../../../document/evidence.js';
import { defaultEngineConfig } from './page.js';
import { deriveTables } from './tables.js';
import { createLogicalDirectory, directoryPage } from './directory.js';
import { assertOcrMarkPage, collectOcrMarkPages } from '../ocr-marks.js';
export * from './page.js';
export * from './search.js';
export * from './translation.js';
export * from './runner.js';
const unique = <T>(values: T[]) => [...new Set(values)];
const key = (prefix: string, value: unknown) => `${prefix}:${sha256(JSON.stringify(value))}`;
type LogicalDocument = z.infer<typeof DocumentLogicalDocumentSchema>;
export interface DeriveDocumentOptions { scope: DocumentScope; config?: DocumentEngineConfig; pageCount: number; directoryRevision?: string }
function sameScope(a: DocumentScope, b: DocumentScope) { return JSON.stringify(DocumentScopeSchema.parse(a)) === JSON.stringify(DocumentScopeSchema.parse(b)); }
function validatePages(input: DocumentPageArtifact[], options: DeriveDocumentOptions) {
  const seen = new Set<number>();
  if (!Number.isInteger(options.pageCount) || options.pageCount < 1) throw new Error('p2_invalid_page_count');
  return input.map(raw => {
    // Callers may pass processPage results; binary PNG is deliberately excluded from JSON DTO validation.
    const { png: _png, ...artifact } = raw as DocumentPageArtifact & { png?: unknown };
    const page = DocumentPageArtifactSchema.parse(artifact);
    assertSourceTextAssembly(page);
    if (!sameScope(page.scope, options.scope) || page.page.document_version_id !== options.scope.documentVersionId || page.page.parse_revision !== options.scope.parseRevision || page.page.source_sha256 !== (options.scope.previewSha256??options.scope.sourceSha256)) throw new Error('p2_page_scope_mismatch');
    if (seen.has(page.page.page_number) || page.page.page_number > options.pageCount) throw new Error('p2_duplicate_or_unexpected_page');
    seen.add(page.page.page_number);
    if (page.regions.some(region => region.document_version_id !== options.scope.documentVersionId || region.parse_revision !== options.scope.parseRevision || region.page_asset_id !== page.page.page_asset_id)) throw new Error('p2_region_scope_mismatch');
    if (options.config && page.processing.configVersion !== options.config.version) throw new Error('p2_parse_configuration_mismatch');
    if (new Set(page.regions.map(region => region.region_id)).size !== page.regions.length || new Set(page.canonicalRegionIds).size !== page.canonicalRegionIds.length || page.canonicalRegionIds.some(id => !page.regions.some(region => region.region_id === id))) throw new Error('p2_region_identity_invalid');
    for (const anchor of page.anchors) validateAnchorSource(anchor, page.page, page.regions);
    assertOcrMarkPage(page);
    return page;
  }).sort((a, b) => a.page.page_number - b.page.page_number);
}
function clauseLabel(text: string): { label: string; kind: DocumentStructureNode['kind']; level: number } | null {
  const appendix = /^(?:appendix|schedule|annex|附件|附录)\s*([A-Z0-9一二三四五六七八九十]+)/iu.exec(text.trim());
  if (appendix) return { label: `appendix:${appendix[1]!.toUpperCase()}`, kind: 'appendix', level: 0 };
  const numbered = /^(?:section\s+|clause\s+)?(\d+(?:\.\d+)*)(?:[.)、]\s*|\s+)(\S)/iu.exec(text.trim());
  if (numbered) return { label: numbered[1]!, kind: 'heading', level: numbered[1]!.split('.').length };
  // Definitions must begin the region; keep terms bounded rather than treating an
  // arbitrary sentence containing "means" as a contractual definition.
  const source = text.trim();
  const quoted = /^["“‘']([^"”’'\r\n]{1,100})["”’']\s*[:：]?\s*(?:(?:means|shall\s+mean|has\s+the\s+meaning)\b|是指|指)/iu.exec(source);
  const unquoted = /^([A-Za-z][A-Za-z0-9'’&()./-]*(?:[ \t]+[A-Za-z0-9'’&()./-]+){0,7}?)[ \t]+(?:means|shall[ \t]+mean|has[ \t]+the[ \t]+meaning)\b/iu.exec(source);
  const chinese = /^([^\s：:"“”‘’'\r\n]{1,30})[：:]\s*(?:是指|指)/u.exec(source);
  const term = (quoted?.[1] ?? unquoted?.[1] ?? chinese?.[1])?.trim();
  if (term && term.length <= 100) return { label: `definition:${term.toLocaleLowerCase()}`, kind: 'definition', level: 20 };
  return null;
}
function createStructures(pages: DocumentPageArtifact[], documents: LogicalDocument[]): DocumentStructureNode[] {
  const result: DocumentStructureNode[] = [];
  for (const document of documents) {
    let active: DocumentStructureNode | undefined; const parents: Array<{ id: string; level: number }> = [];
    for (const page of pages) for (const region of page.regions.filter(region => document.regionIds.includes(region.region_id))) {
      if (!region.raw_text && region.source !== 'image') continue;
      const text = region.raw_text ?? '', heading = clauseLabel(text), isImage = !region.raw_text;
      if (!active || heading || isImage || region.kind === 'table' || active.kind === 'image') {
        if (heading) while (parents.length && parents.at(-1)!.level >= heading.level) parents.pop();
        active = { id: key('structure', [document.id, region.region_id]), logicalDocumentId: document.id,
          kind: isImage ? 'image' : region.kind === 'table' ? 'table' : heading?.kind ?? 'clause', label: heading?.label ?? null,
          text: '', pageNumbers: [], regionIds: [], anchorIds: [], parentId: parents.at(-1)?.id ?? null, references: [], coverageGaps: [] };
        result.push(active);
        if (heading && heading.kind !== 'definition') parents.push({ id: active.id, level: heading.level });
      }
      active.text += `${active.text ? '\n' : ''}${text}`;
      active.pageNumbers = unique([...active.pageNumbers, page.page.page_number]); active.regionIds.push(region.region_id);
      active.anchorIds.push(...page.anchors.filter(anchor => anchor.block_ids.includes(region.region_id)).map(anchor => anchor.anchor_id));
      active.coverageGaps = unique([...active.coverageGaps, ...region.coverage_gaps]);
    }
  }
  const definitions = result.filter(node => node.kind === 'definition');
  for (const node of result) {
    const references: Array<{ label: string; documentOnly: boolean }> = [];
    for (const match of node.text.matchAll(/\b(?:section|clause)\s+(\d+(?:\.\d+)*)\b|第\s*([\d.]+)\s*条/giu)) references.push({ label: (match[1] ?? match[2])!, documentOnly: true });
    for (const match of node.text.matchAll(/\b(?:appendix|schedule|annex)\s+([A-Z0-9]+)\b|(?:附件|附录)\s*([A-Z0-9一二三四五六七八九十]+)/giu)) references.push({ label: `appendix:${(match[1] ?? match[2])!.toUpperCase()}`, documentOnly: false });
    for (const definition of definitions.filter(definition => definition.logicalDocumentId === node.logicalDocumentId && definition.id !== node.id)) {
      const term = definition.label!.slice('definition:'.length);
      if (node.text.toLocaleLowerCase().includes(term)) references.push({ label: definition.label!, documentOnly: true });
    }
    for (const reference of references) {
      if (node.references.some(value => value.label === reference.label)) continue;
      const targets = result.filter(target => target.label === reference.label && (!reference.documentOnly || target.logicalDocumentId === node.logicalDocumentId));
      node.references.push({ label: reference.label, targetIds: targets.map(target => target.id), required: true, status: targets.length === 1 ? 'resolved' : targets.length ? 'ambiguous' : 'missing' });
      if (targets.length !== 1) node.coverageGaps.push(`${targets.length ? 'ambiguous' : 'missing'}_reference:${reference.label}`);
    }
  }
  return result;
}
function escaped(text: string) { return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }
/** Only explicit local clause qualifiers create reverse dependencies. Ordinary
 * citations remain one-way; this is a bounded grammar, not a semantic classifier. */
function qualifyingClauseLabels(text: string): string[] {
  const patterns = [
    /\b(?:notwithstanding|despite)\s+(?:the\s+provisions\s+of\s+)?(?:section|clause)\s+(\d+(?:\.\d+)*)\b/giu,
    /\b(?:exception|condition|limitation|restriction)\b[^.!?\n]{0,100}?\b(?:to|for|on|under|in)\s+(?:section|clause)\s+(\d+(?:\.\d+)*)\b/giu,
    /\b(?:overrides?|modifies|modify|limits?|qualifies|qualify|amends?|changes?)\b[^.!?\n]{0,80}?\b(?:section|clause)\s+(\d+(?:\.\d+)*)\b/giu,
    /\b(?:except\s+that|provided\s+that)\s+(?:section|clause)\s+(\d+(?:\.\d+)*)\b/giu,
    /\b(?:section|clause)\s+(\d+(?:\.\d+)*)\b[^.!?\n]{0,80}?\b(?:shall\s+not\s+apply|does\s+not\s+apply|applies\s+only|applies\s+except)\b/giu,
    /(?:尽管|不论)\s*第\s*(\d+(?:\.\d+)*)\s*条/gu,
    /(?:作为|针对)\s*第\s*(\d+(?:\.\d+)*)\s*条(?:的)?(?:例外|条件|限制)/gu,
  ];
  return unique(patterns.flatMap(pattern => [...text.matchAll(pattern)].map(match => match[1]!)));
}
function requiredStructuralContext(structures: DocumentStructureNode[]): Map<string, string[]> {
  const dependencies = new Map(structures.map(node => [node.id, [] as string[]]));
  for (const node of structures) {
    const parent = node.parentId ? structures.find(parent => parent.id === node.parentId && parent.logicalDocumentId === node.logicalDocumentId) : null;
    if (parent) dependencies.get(parent.id)!.push(node.id);
    const labels = new Set(qualifyingClauseLabels(node.text));
    for (const reference of node.references) {
      if (reference.status !== 'resolved' || reference.targetIds.length !== 1 || !labels.has(reference.label)) continue;
      const target = structures.find(target => target.id === reference.targetIds[0] && target.logicalDocumentId === node.logicalDocumentId);
      if (target && target.id !== node.id) dependencies.get(target.id)!.push(node.id);
    }
  }
  return dependencies;
}
export const normalizeDocumentFieldValue = normalizeExtractedValue;

const normalize = normalizeDocumentFieldValue;
export function extractFieldObservations(pages: DocumentPageArtifact[], options: { scope: DocumentScope; config?: DocumentEngineConfig }): { fields: DocumentFieldObservation[]; anchors: EvidenceAnchor[] } {
  const config = DocumentEngineConfigSchema.parse(options.config ?? defaultEngineConfig()), allAnchors: EvidenceAnchor[] = [];
  const fields: DocumentFieldObservation[] = config.fields.map(field => {
    const candidates: DocumentFieldObservation['candidates'] = [];
    for (const page of pages) {
      if (!sameScope(page.scope, options.scope)) throw new Error('p2_field_scope_mismatch');
      const regions = page.regions.filter(region => page.canonicalRegionIds.includes(region.region_id) && region.raw_text);
      for (const [index, region] of regions.entries()) for (const alias of field.candidateExtraction?[]:field.aliases) {
        const match = new RegExp(`(?:^|\\n)\\s*${escaped(alias)}\\s*[:：]\\s*([^\\n]*)`, 'iu').exec(region.raw_text!);
        if (!match) continue;
        let rawValue = match[1]!.trim(), valueRegion = region;
        if (!rawValue && regions[index + 1]) { valueRegion = regions[index + 1]!; rawValue = valueRegion.raw_text!.trim(); }
        if (!rawValue || field.aliases.some(candidate => rawValue.toLowerCase().startsWith(candidate.toLowerCase() + ':'))) continue;
        const anchors = anchorsForText(page.page, [valueRegion], rawValue);
        const labelAnchors = valueRegion === region ? [] : anchorsForText(page.page, [region], alias);
        allAnchors.push(...anchors, ...labelAnchors);
        const candidate = { rawValue, normalizedValue: normalize(rawValue, field.type), anchorIds: unique([...anchors, ...labelAnchors].map(anchor => anchor.anchor_id)), pageNumbers: [page.page.page_number] };
        if (!candidates.some(existing => existing.rawValue === candidate.rawValue && JSON.stringify(existing.anchorIds) === JSON.stringify(candidate.anchorIds))) candidates.push(candidate);
      }
      for (const entity of page.entityCandidates.filter(entity => !field.candidateExtraction && entity.fieldId === field.id)) {
        const candidate = { rawValue: entity.text, normalizedValue: normalize(entity.text, field.type), anchorIds: entity.anchorIds, pageNumbers: [page.page.page_number] };
        if (!candidates.some(existing => existing.rawValue === candidate.rawValue && JSON.stringify(existing.anchorIds) === JSON.stringify(candidate.anchorIds))) candidates.push(candidate);
        allAnchors.push(...page.anchors.filter(anchor => entity.anchorIds.includes(anchor.anchor_id)));
      }
    }
    const values = unique(candidates.map(candidate => candidate.normalizedValue ?? candidate.rawValue));
    const gaps = unique(pages.flatMap(page => page.coverageGaps));
    if (!candidates.length) gaps.push('field_not_found_in_processed_scope');
    if (values.length > 1) gaps.push('multiple_field_candidates');
    if (candidates.length > 1 && values.length === 1) gaps.push('repeated_value_object_association_unconfirmed');
    if (candidates.some(candidate => candidate.normalizedValue === null)) gaps.push('normalization_requires_confirmation');
    if (pages.some(page => page.entityCandidates.some(entity => entity.fieldId === field.id && (entity.confidence < 0.7 || entity.anchorIds.length !== 1 || entity.simulated)))) gaps.push('entity_candidate_requires_confirmation');
    return { id: key('field', [options.scope, field.id]), fieldId: field.id, fieldLabel: field.label, documentVersionId: options.scope.documentVersionId, parseRevision: options.scope.parseRevision,
      status: !candidates.length ? 'not_found' : values.length > 1 || candidates.some(candidate => candidate.normalizedValue === null) || gaps.length ? 'uncertain' : 'extracted',
      rawValue: values.length === 1 ? candidates[0]!.rawValue : null, normalizedValue: values.length === 1 ? candidates[0]!.normalizedValue : null,
      pageNumbers: unique(candidates.flatMap(candidate => candidate.pageNumbers)), anchorIds: unique(candidates.flatMap(candidate => candidate.anchorIds)), candidates,
      objectId: null, humanRevisionId: null, coverageGaps: gaps };
  });
  return { fields, anchors: [...new Map(allAnchors.map(anchor => [anchor.anchor_id, anchor])).values()] };
}
function buildBundle(pages: DocumentPageArtifact[], options: DeriveDocumentOptions, documents: LogicalDocument[]): DocumentBundle {
  const config = DocumentEngineConfigSchema.parse(options.config ?? defaultEngineConfig()), revision = options.directoryRevision ?? '1';
  const structures = createStructures(pages, documents), extraction = extractFieldObservations(pages, { scope: options.scope, config });
  const tableExtraction = deriveTables(pages, structures);
  const gaps = unique([...pages.flatMap(page => page.coverageGaps), ...tableExtraction.coverageGaps]);
  const pageNumbers = pages.map(page => page.page.page_number);
  for (let page = 1; page <= options.pageCount; page++) if (!pageNumbers.includes(page)) gaps.push(`page_not_processed:${page}`);
  if (documents.some(document => document.status !== 'confirmed')) gaps.push('logical_directory_requires_confirmation');
  const requiredContext = requiredStructuralContext(structures);
  const chunks = structures.map(node => ({ id: key('chunk', [node.id, revision]), documentVersionId: options.scope.documentVersionId, parseRevision: options.scope.parseRevision, logicalDocumentId: node.logicalDocumentId,
    structureNodeId: node.id, parentId: node.parentId ? key('chunk', [node.parentId, revision]) : null, text: node.text, textSha256: sha256(node.text), pageNumbers: node.pageNumbers, regionIds: node.regionIds, anchorIds: unique(node.anchorIds),
    dependencyIds: unique([...node.references.flatMap(reference => reference.status === 'resolved' ? reference.targetIds.map(id => key('chunk', [id, revision])) : []), ...(requiredContext.get(node.id) ?? []).map(id => key('chunk', [id, revision])), ...(node.parentId ? [key('chunk', [node.parentId, revision])] : [])]),
    unresolvedReferences: node.references.filter(reference => reference.status !== 'resolved').map(reference => reference.label), coverageGaps: unique(node.coverageGaps) }));
  const sourceFingerprint = sha256(JSON.stringify({ scope: options.scope, revision, config, documents, chunks, tables: tableExtraction.tables }));
  const marks = collectOcrMarkPages(pages);
  const pageAnchors = pages.flatMap(page => page.anchors).filter(anchor =>
    !anchor.block_ids.some(id => marks.auxiliaryIds.has(id) && !marks.keptIds.has(id)));
  return DocumentBundleSchema.parse({ ...(config.classificationMode?{classificationMode:config.classificationMode}:{}),schema_version: options.scope.sourceFormat==='docx'?'p2.v2':'p2.v1', scope: options.scope, directoryRevision: revision, pageCount: options.pageCount, logicalDocuments: documents, structures, tables: tableExtraction.tables, fields: extraction.fields,
    signatures: pages.flatMap(page => page.signatures), ...(marks.layers.length ? { ocrMarkPages: marks.layers } : {}), anchors: [...new Map([...pageAnchors, ...extraction.anchors].map(anchor => [anchor.anchor_id, anchor])).values()], chunks,
    indexManifest: { id: key('index', [sourceFingerprint]), schema_version: options.scope.sourceFormat==='docx'?'p2.v2':'p2.v1', scope: options.scope, directoryRevision: revision, configVersion: config.version, taxonomyVersion: config.taxonomyVersion, fieldDictionaryVersion: config.fieldDictionaryVersion,
      indexVersion: 'p2-lexical-structure-v2', status: gaps.length || chunks.some(chunk => chunk.coverageGaps.length) ? 'partial' : 'ready', indexedPageNumbers: pageNumbers, expectedPageCount: options.pageCount,
      chunkIds: chunks.map(chunk => chunk.id), sourceFingerprint, coverageGaps: unique([...gaps, ...chunks.flatMap(chunk => chunk.coverageGaps)]), retrieval: { lexical: 'unicode-terms-v1', embedding: null, reranker: null, modelEvaluation: 'blocked_no_real_adapters' } },
    coverageGaps: gaps, status: pages.length === 0 ? 'failed' : gaps.length ? 'partial' : 'ready' });
}
export function deriveDocument(input: DocumentPageArtifact[], options: DeriveDocumentOptions): DocumentBundle {
  const scope = DocumentScopeSchema.parse(options.scope), config = DocumentEngineConfigSchema.parse(options.config ?? defaultEngineConfig());
  const pages = validatePages(input, { ...options, scope, config });
  return buildBundle(pages, { ...options, scope, config }, createLogicalDirectory(pages.map(directoryPage), config.classificationMode?{...config,taxonomy:[]}:config, scope, options.directoryRevision ?? '1'));
}
/** Model classification stays a candidate and must cover the immutable source exactly once. */
export function deriveClassifiedDocument(input:DocumentPageArtifact[],options:DeriveDocumentOptions,directory:unknown):DocumentBundle {
  const scope=DocumentScopeSchema.parse(options.scope),config=DocumentEngineConfigSchema.parse(options.config??defaultEngineConfig());
  const pages=validatePages(input,{...options,scope,config}),documents=z.array(DocumentLogicalDocumentSchema).min(1).parse(directory);
  const source=new Map(pages.flatMap(page=>page.canonicalRegionIds.map(id=>[id,page.page.page_number] as const))),seen=new Set<string>();
  if(new Set(documents.map(item=>item.id)).size!==documents.length)throw new Error('p2_directory_invalid_document');
  for(const item of documents){
    if(item.source!=='classification'||item.status!==(item.labelId?'candidate':'unknown')||!item.regionIds.length||
      item.labelId&&!config.taxonomy.some(type=>type.id===item.labelId&&type.label===item.label))throw new Error('p2_directory_invalid_document');
    for(const region of item.regionIds){if(!source.has(region)||seen.has(region))throw new Error('p2_directory_region_conflict');seen.add(region);}
    const expected=unique(item.regionIds.map(id=>source.get(id)!)).sort((a,b)=>a-b);
    if(JSON.stringify(expected)!==JSON.stringify(unique(item.pageNumbers).sort((a,b)=>a-b)))throw new Error('p2_directory_page_mismatch');
  }
  if(seen.size!==source.size)throw new Error('p2_directory_region_conflict');
  return buildBundle(pages,{...options,scope,config},documents);
}
/** Full directory replacement must account for every fixed source region exactly once. */
export function reviseLogicalDirectory(bundle: DocumentBundle, input: unknown, options: { expectedDirectoryRevision: string; pages: DocumentPageArtifact[]; config?: DocumentEngineConfig; reason: string }): DocumentBundle {
  if(bundle.pageCount===null)throw new Error('p2_preview_required_for_page_directory');
  if (!options.reason.trim() || options.expectedDirectoryRevision !== bundle.directoryRevision) throw new Error('p2_directory_revision_conflict');
  const config = DocumentEngineConfigSchema.parse(options.config ?? defaultEngineConfig());
  const documents = z.array(DocumentLogicalDocumentSchema).min(1).parse(input);
  const source = new Map(options.pages.flatMap(page => page.canonicalRegionIds.map(id => [id, page.page.page_number] as const)));
  const seen = new Set<string>(); const ids = new Set<string>();
  for (const document of documents) {
    if (ids.has(document.id) || document.regionIds.length === 0 || (document.labelId && document.labelId!==SUPPLEMENTAL_MATERIAL_ID && !config.taxonomy.some(label => label.id === document.labelId))) throw new Error('p2_directory_invalid_document');
    ids.add(document.id);
    for (const region of document.regionIds) { if (!source.has(region) || seen.has(region)) throw new Error('p2_directory_region_conflict'); seen.add(region); }
    const expectedPages = unique(document.regionIds.map(id => source.get(id)!)).sort((a, b) => a - b);
    if (JSON.stringify(expectedPages) !== JSON.stringify(unique(document.pageNumbers).sort((a, b) => a - b))) throw new Error('p2_directory_page_mismatch');
    document.source = 'manual';
    if(document.labelId===SUPPLEMENTAL_MATERIAL_ID)document.label=SUPPLEMENTAL_MATERIAL_LABEL;
    // Unknown labels cannot be confirmed by merely changing a state string.
    if (!document.labelId) document.status = 'unknown';
  }
  if (seen.size !== source.size) throw new Error('p2_directory_unassigned_regions');
  const revision = /^\d+$/u.test(bundle.directoryRevision) ? String(Number(bundle.directoryRevision) + 1) : key('directory', [bundle.directoryRevision, documents]);
  const pages = validatePages(options.pages, { scope: bundle.scope, pageCount: bundle.pageCount, config });
  const revised=buildBundle(pages, { scope: bundle.scope, config, pageCount: bundle.pageCount, directoryRevision: revision }, documents);
  return documents.every(d=>d.labelId===SUPPLEMENTAL_MATERIAL_ID)?{...revised,fields:[]}:revised;
}
export function indexValidity(bundle: DocumentBundle, expected: { scope: DocumentScope; directoryRevision: string; configVersion: string }): 'current' | 'stale' {
  return sameScope(bundle.scope, expected.scope) && bundle.directoryRevision === expected.directoryRevision && bundle.indexManifest.configVersion === expected.configVersion && bundle.indexManifest.status !== 'stale' ? 'current' : 'stale';
}
/** Conservative text/structure comparison, never a business-resolution or version-adoption command. */
export function compareDocumentVersions(before: DocumentBundle, after: DocumentBundle): DocumentComparison {
  if (before.scope.caseId !== after.scope.caseId) throw new Error('p2_cross_case_comparison');
  const used = new Set<string>(), changes: DocumentComparison['changes'] = [];
  for (const previous of before.chunks) {
    const exact = after.chunks.filter(next => next.textSha256 === previous.textSha256 && !used.has(next.id));
    if (exact.length === 1) { used.add(exact[0]!.id); continue; }
    const node = before.structures.find(node => node.id === previous.structureNodeId);
    const candidates = exact.length > 1 ? exact : after.chunks.filter(next => !used.has(next.id) && node?.label && after.structures.some(candidate => candidate.id === next.structureNodeId && candidate.label === node.label));
    for (const candidate of candidates) used.add(candidate.id);
    changes.push({ kind: candidates.length > 1 ? 'ambiguous' : candidates.length === 1 ? 'changed' : 'removed', beforeChunkIds: [previous.id], afterChunkIds: candidates.map(candidate => candidate.id), beforeAnchorIds: previous.anchorIds, afterAnchorIds: unique(candidates.flatMap(candidate => candidate.anchorIds)) });
  }
  for (const next of after.chunks.filter(next => !used.has(next.id))) changes.push({ kind: 'added', beforeChunkIds: [], afterChunkIds: [next.id], beforeAnchorIds: [], afterAnchorIds: next.anchorIds });
  const gaps = unique([...before.coverageGaps, ...after.coverageGaps, ...changes.filter(change => change.kind === 'ambiguous').map(() => 'comparison_alignment_ambiguous')]);
  return DocumentComparisonSchema.parse({ schema_version: 'p2.v1', beforeDocumentVersionId: before.scope.documentVersionId, beforeParseRevision: before.scope.parseRevision, afterDocumentVersionId: after.scope.documentVersionId, afterParseRevision: after.scope.parseRevision, changes, coverageGaps: gaps, status: gaps.length ? 'partial' : 'compared', automaticallyAdoptsVersion: false, resolvesBusinessFindings: false });
}
