import type {ReviewEvidence} from '@hsbc/contracts/review';
import type {DocumentPageArtifact, EvidenceAnchor} from '../documents/types.ts';
import {sourceNodeLabel, type SourceDocumentResponse} from '../../sourceDocument.ts';

export interface EvidencePreview {location: string; excerpt: string; pageNumber?: number}
export function evidenceIdentity(source: ReviewEvidence): string {
  return JSON.stringify([source.documentVersionId, source.parseRevision, source.directoryRevision, source.anchorId, source.sourceNodeId, source.materialScope]);
}
export function evidenceExcerpt(text: string): string {
  const characters = Array.from(text.replace(/\s+/gu, ' ').trim());
  return characters.length > 360 ? `${characters.slice(0, 360).join('')}…` : characters.join('');
}
/** Use the selected span, not the whole parent line, for word/line anchors. */
export function pageEvidencePreview(source: ReviewEvidence, page: DocumentPageArtifact, fallbackAnchor?: EvidenceAnchor, fullText = false): EvidencePreview | undefined {
  if (page.scope.documentVersionId !== source.documentVersionId || page.scope.parseRevision !== source.parseRevision) return;
  const anchor = page.anchors.find(value => value.anchor_id === source.anchorId) ?? fallbackAnchor;
  if (!anchor || anchor.anchor_id !== source.anchorId || anchor.document_version_id !== source.documentVersionId ||
    anchor.parse_revision !== source.parseRevision || anchor.page_asset_id !== page.page.page_asset_id || anchor.page_number !== page.page.page_number) return;
  const regions = page.regions.filter(region => region.document_version_id === source.documentVersionId && region.parse_revision === source.parseRevision && region.page_asset_id === anchor.page_asset_id);
  const text = anchor.text_span_refs.length
    ? anchor.text_span_refs.map(span => Array.from(regions.find(region => region.region_id === span.block_id)?.raw_text ?? '').slice(span.offset, span.offset + span.length).join('')).join(' ')
    : anchor.block_ids.map(id => regions.find(region => region.region_id === id)?.raw_text ?? '').join(' ');
  return {location: `第 ${anchor.page_number} 页`, pageNumber: anchor.page_number, excerpt: fullText ? text : evidenceExcerpt(text)};
}
export function sourceEvidencePreview(source: ReviewEvidence, document: SourceDocumentResponse, fullText = false): EvidencePreview | undefined {
  if (document.parseRevision !== source.parseRevision) return;
  const node = document.source.nodes.find(value => value.id === source.sourceNodeId && !value.excludedFromVisibleFacts && value.visibility === 'visible');
  if (!node) return;
  const pages = [...new Set(document.mappings.filter(mapping => mapping.sourceNodeId === node.id && mapping.status === 'mapped').flatMap(mapping => mapping.pageNumbers))].filter(page => Number.isSafeInteger(page) && page > 0).sort((a, b) => a - b);
  return {location: `${sourceNodeLabel(node)} · ${pages.length ? `第 ${pages.join('、')} 页` : '页码未映射'}`, excerpt: fullText ? node.visibleText ?? '' : evidenceExcerpt(node.visibleText ?? '')};
}
