import type { DocumentBundle, DocumentEvidenceChunk, DocumentFieldObservation } from '@hsbc/contracts/documents';
import {candidateRequiredEvidenceGroups} from '@hsbc/contracts/documents';
import { TRANSLATION_LIMITS, type DocumentTranslationTarget } from '@hsbc/contracts/document-translation';
import { sha256 } from '../../../document/evidence.js';
import { inputHash } from '../../../infrastructure/database/idempotency.js';
import { AppError } from '../../../shared/errors.js';

export function translationHash(value: unknown): string {
  const canonical = (v: any): any => Array.isArray(v) ? v.map(canonical) : v && typeof v === 'object'
    ? Object.fromEntries(Object.keys(v).sort().map(key => [key, canonical(v[key])])) : v;
  return inputHash(canonical(value));
}

// These warnings affect preview positioning, not the complete visible OOXML text.
const sourceOnlyWarnings = new Set(['visible_sequence_not_mapped', 'source_structure_only', 'repeated_source_sequence',
  'preview_geometry_unavailable', 'source_visibility_not_visually_verified']);
export interface TranslationSegmentSource {
  chunkId: string; sourceText: string; sourceSha256: string; contextText: string; contextSha256: string; contextManifestSha256: string;
  source: DocumentTranslationTarget['source']; sourceWarnings: string[];
}
export function sourceReferences(bundle: DocumentBundle, chunk: DocumentEvidenceChunk): DocumentTranslationTarget['source'] {
  const sourceNodeIds = [...new Set(chunk.sourceNodeIds ?? [])];
  const native = (bundle.sourceAnchors ?? []).filter(a => sourceNodeIds.includes(a.sourceNodeId));
  const anchorIds = [...new Set([...chunk.anchorIds, ...native.map(a => a.anchor_id)])];
  const anchors = [...bundle.anchors, ...(bundle.sourceAnchors ?? [])];
  if (chunk.documentVersionId !== bundle.scope.documentVersionId || chunk.parseRevision !== bundle.scope.parseRevision ||
      sha256(chunk.text) !== chunk.textSha256 || !anchorIds.length ||
      anchorIds.some(id => !anchors.some(a => a.anchor_id === id && a.document_version_id === bundle.scope.documentVersionId && a.parse_revision === bundle.scope.parseRevision)) ||
      sourceNodeIds.some(id => !native.some(a => a.sourceNodeId === id))) throw new AppError(409, 'translation_source_integrity_failed');
  return { anchorIds, pageNumbers: [...chunk.pageNumbers], sourceNodeIds };
}
export function translationSource(bundle: DocumentBundle, chunkId: string): { segment: TranslationSegmentSource; reasonCodes: string[] } {
  const chunks = new Map(bundle.chunks.map(chunk => [chunk.id, chunk]));
  if (chunks.size !== bundle.chunks.length) throw new AppError(409, 'translation_source_integrity_failed');
  const chunk = chunks.get(chunkId);
  if (!chunk) throw new AppError(422, 'translation_chunk_not_found');
  const reasons = new Set<string>(), warnings = new Set<string>(), visited = new Set([chunk.id]), context: DocumentEvidenceChunk[] = [];
  const inspect = (item: DocumentEvidenceChunk) => {
    sourceReferences(bundle, item);
    item.coverageGaps.forEach(gap => {
      warnings.add(gap);
      // Reference translation uses the text actually extracted. Coverage and
      // visual-verification gaps affect review quality, not translation admission.
      if (/^(?:missing|ambiguous)_reference:.+/u.test(gap) || gap === 'source_note_reference_unresolved') {
        warnings.add('translation_context_incomplete');
      } else if (!(item.sourceNodeIds?.length && sourceOnlyWarnings.has(gap))) warnings.add('translation_source_incomplete');
    });
    if (item.unresolvedReferences.length) warnings.add('translation_context_incomplete');
  };
  const visit = (id: string, depth: number) => {
    if (visited.has(id)) return;
    if (depth > 8 || context.length >= TRANSLATION_LIMITS.contextChunks) { reasons.add('translation_context_budget_exceeded'); return; }
    visited.add(id);
    const item = chunks.get(id);
    if (!item) { warnings.add('translation_context_incomplete'); return; }
    inspect(item); context.push(item); item.dependencyIds.forEach(next => visit(next, depth + 1));
  };
  inspect(chunk); chunk.dependencyIds.forEach(id => visit(id, 0));
  if (!chunk.text.trim() || !/[A-Za-z]{2,}/u.test(chunk.text)) reasons.add('translation_no_english_text');
  if (chunk.text.length > TRANSLATION_LIMITS.sourceCharacters) reasons.add('translation_source_too_large');
  const contextText = context.map(item => item.text).join('\n\n');
  if (contextText.length > TRANSLATION_LIMITS.contextCharacters) reasons.add('translation_context_budget_exceeded');
  const contextManifestSha256 = translationHash([chunk, ...context].map(item => ({ id: item.id, hash: item.textSha256,
    source: sourceReferences(bundle, item), dependencies: item.dependencyIds, unresolved: item.unresolvedReferences, gaps: item.coverageGaps })));
  return { segment: { chunkId, sourceText: chunk.text, sourceSha256: chunk.textSha256, contextText, contextSha256: sha256(contextText), contextManifestSha256, source: sourceReferences(bundle, chunk), sourceWarnings: [...warnings].sort() }, reasonCodes: [...reasons].sort() };
}
function evidenceKeys(bundle: DocumentBundle, ids: string[]): Set<string> {
  const selected = new Set(ids), keys = new Set(ids);
  for (const anchor of bundle.anchors) if (selected.has(anchor.anchor_id)) anchor.block_ids.forEach(id => keys.add(`block:${id}`));
  for (const anchor of bundle.sourceAnchors ?? []) if (selected.has(anchor.anchor_id)) keys.add(`node:${anchor.sourceNodeId}`);
  return keys;
}
export function translationTargets(bundle: DocumentBundle, fields: DocumentFieldObservation[] = bundle.fields,
  page: { offset: number; limit: number; fullSource?:boolean } = { offset: 0, limit: bundle.chunks.length }, confirmedEvidence:Array<{fieldId:string;anchorIds:string[]}>=[], projection?:Pick<DocumentBundle,'anchors'|'sourceAnchors'>): DocumentTranslationTarget[] {
  // Extraction can create finer field regions after the immutable parse. Use them
  // only to resolve field bindings; never change the translated chunk's identity.
  const bindings=projection?{...bundle,anchors:[...bundle.anchors,...projection.anchors],sourceAnchors:[...(bundle.sourceAnchors??[]),...(projection.sourceAnchors??[])]}:bundle;
  const fieldKeys = [...fields.map(field => ({fieldId:field.fieldId,anchorIds:[...field.anchorIds,...field.candidates.flatMap(candidate=>candidateRequiredEvidenceGroups(candidate).flat())]})),...confirmedEvidence]
    .map(field=>({fieldId:field.fieldId,anchors:[...new Set(field.anchorIds)].map(id=>({id,keys:evidenceKeys(bindings,[id])}))}));
  return bundle.chunks.slice(page.offset, page.offset + page.limit).map(chunk => {
    const keys = evidenceKeys(bundle, chunk.anchorIds); (chunk.sourceNodeIds ?? []).forEach(id => keys.add(`node:${id}`));
    const fieldEvidence=fieldKeys.map(field=>({fieldId:field.fieldId,anchorIds:field.anchors.filter(anchor=>[...anchor.keys].some(key=>keys.has(key))).map(anchor=>anchor.id)})).filter(field=>field.anchorIds.length);
    const fieldIds = [...new Set(fieldEvidence.map(field => field.fieldId))];
    try {
      const { segment, reasonCodes } = translationSource(bundle, chunk.id);
      return { chunkId: chunk.id, logicalDocumentId: chunk.logicalDocumentId, sourceSha256: chunk.textSha256,
        sourceText: page.fullSource || chunk.text.length <= TRANSLATION_LIMITS.sourceCharacters ? chunk.text : null, characterCount: chunk.text.length,
        source: segment.source, fieldIds, fieldEvidence, recommended: fieldIds.length > 0, available: !reasonCodes.length, reasonCodes, sourceWarnings: segment.sourceWarnings };
    } catch (error) {
      if (!(error instanceof AppError)) throw error;
      return { chunkId: chunk.id, logicalDocumentId: chunk.logicalDocumentId, sourceSha256: chunk.textSha256, sourceText: null,
        characterCount: chunk.text.length, source: { anchorIds: [], pageNumbers: [], sourceNodeIds: [] }, fieldIds, fieldEvidence,
        recommended: fieldIds.length > 0, available: false, reasonCodes: [error.code], sourceWarnings: [] };
    }
  });
}
/** Includes definitions, references, source anchors and index identity, not just the selected text. */
export function sourceFingerprint(bundle: DocumentBundle, chunkIds: string[]) {
  return translationHash({ scope: bundle.scope, directoryRevision: bundle.directoryRevision, index: bundle.indexManifest,
    segments: chunkIds.map(id => translationSource(bundle, id)) });
}
