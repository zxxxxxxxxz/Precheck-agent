import type {DocumentBundle, DocumentPageArtifact} from '@hsbc/contracts/documents';
import type {DocxSourceDocument} from '@hsbc/contracts/docx';
import type {FieldTranslationSource} from '@hsbc/contracts/document-translation';
import {sha256, validateAnchorSource} from '../../../document/evidence.js';
import {AppError} from '../../../shared/errors.js';
import {translationHash} from './source.js';

function pageQuoteRegions(page:DocumentPageArtifact,anchor:DocumentBundle['anchors'][number],quote:string){
  for(const source of ['native_pdf','vl_ocr','pp_ocr']){
    let offset=0;
    const positioned=page.regions.filter(r=>r.source===source&&typeof r.raw_text==='string'&&r.raw_text&&sha256(r.raw_text)===r.raw_text_sha256)
      .sort((a,b)=>a.reading_order-b.reading_order).map(region=>{
        const start=offset;offset+=region.raw_text!.length+1;
        return {region,start,end:start+region.raw_text!.length};
      });
    const text=positioned.map(item=>item.region.raw_text).join('\n'),start=text.indexOf(quote);
    if(start<0)continue;
    const end=start+quote.length,regions=positioned.filter(item=>item.end>start&&item.start<end).map(item=>item.region);
    if(!regions.length||regions.some(region=>region.document_version_id!==anchor.document_version_id||region.parse_revision!==anchor.parse_revision||region.page_asset_id!==anchor.page_asset_id))
      throw new AppError(409,'translation_source_integrity_failed');
    return regions;
  }
}

/** Select immutable original text, never a value synthesized by the client.
 * Scope checks are local to the selected regions; a different clause's gaps do
 * not block a bank name. References actually present in the quote still apply. */
export function fieldTranslationBundle(bundle: DocumentBundle, selections: FieldTranslationSource[], pages: DocumentPageArtifact[], native?: DocxSourceDocument) {
  const selected = selections.map(selection => {
    let text = '', warnings: string[] = [], anchorIds: string[] = [], sourceNodeIds: string[] = [], pageNumbers: number[] = [], regionIds: string[] = [];
    let identity: unknown;
    if (selection.anchorId) {
      const anchor = bundle.anchors.find(a => a.anchor_id === selection.anchorId);
      const page = pages.find(p => p.page.page_number === anchor?.page_number);
      if (!anchor || !page || page.scope.documentVersionId !== bundle.scope.documentVersionId || page.scope.parseRevision !== bundle.scope.parseRevision ||
          page.scope.sourceSha256 !== bundle.scope.sourceSha256) throw new AppError(409, 'translation_source_integrity_failed');
      let regions = page.regions.filter(r => anchor.block_ids.includes(r.region_id));
      try {
        if (new Set(anchor.block_ids).size !== regions.length || !regions.length) throw new Error('missing_region');
        validateAnchorSource(anchor, page.page, regions);
        for (const region of regions) if (region.raw_text === null || sha256(region.raw_text) !== region.raw_text_sha256 ||
          region.document_version_id !== bundle.scope.documentVersionId || region.parse_revision !== bundle.scope.parseRevision || region.page_asset_id !== anchor.page_asset_id) throw new Error('invalid_region');
      } catch { throw new AppError(409, 'translation_source_integrity_failed'); }
      text = anchor.text_span_refs.length ? anchor.text_span_refs.map(span => Array.from(regions.find(r => r.region_id === span.block_id)!.raw_text!).slice(span.offset, span.offset + span.length).join('')).join(' ')
        : regions.map(r => r.raw_text).join(' ');
      if (selection.quote !== undefined && !text.includes(selection.quote)) {
        const quoted = pageQuoteRegions(page, anchor, selection.quote);
        if (!quoted) throw new AppError(422, 'translation_quote_not_in_source');
        regions = quoted; text = selection.quote;
      }
      warnings = regions.flatMap(r => [...r.coverage_gaps, ...(!['ready', 'partial'].includes(r.processing_status) ? ['field_text_unavailable'] : [])]);
      if (anchor.evidence_kind !== 'text' || ['ambiguous', 'unavailable'].includes(anchor.localization_status)) warnings.push('field_source_ambiguous');
      anchorIds = [anchor.anchor_id]; pageNumbers = [anchor.page_number]; regionIds = regions.map(r => r.region_id); identity = anchor;
    } else {
      const node = native?.nodes.find(n => n.id === selection.sourceNodeId && n.visibility === 'visible' && !n.excludedFromVisibleFacts);
      const anchors = bundle.sourceAnchors?.filter(a => a.sourceNodeId === selection.sourceNodeId) ?? [];
      if (!node || !anchors.length || native?.sourceSha256 !== bundle.scope.sourceSha256) throw new AppError(409, 'translation_source_integrity_failed');
      text = node.visibleText; warnings = node.coverageGaps; anchorIds = anchors.map(a => a.anchor_id); sourceNodeIds = [node.id]; identity = anchors;
    }
    // Quotes are optional only for callers selecting the entire anchor/node.
    // Exact containment prevents translating user-supplied or normalized facts.
    if (selection.quote !== undefined) {
      if (!text.includes(selection.quote)) throw new AppError(422, 'translation_quote_not_in_source');
      text = selection.quote;
    }
    const parents = bundle.chunks.filter(c => c.anchorIds.some(id => anchorIds.includes(id)) || c.regionIds.some(id => regionIds.includes(id)) || c.sourceNodeIds?.some(id => sourceNodeIds.includes(id)));
    const explicitReference = /\b(?:Clause|Section|Schedule|Article|Annex|Appendix)\s+[A-Za-z0-9]+(?:[.-]\d+)*\b/iu;
    const refs = bundle.structures.filter(n => parents.some(c => c.structureNodeId === n.id)).flatMap(n => n.references).filter(r => explicitReference.test(r.label) && text.includes(r.label));
    const directReferences = text.match(/\b(?:Clause|Section|Schedule|Article|Annex|Appendix)\s+[A-Za-z0-9]+(?:[.-]\d+)*\b/giu) ?? [];
    const dependencyIds = [...new Set(refs.filter(r => r.status === 'resolved').flatMap(r => bundle.chunks.filter(c => r.targetIds.includes(c.structureNodeId)).map(c => c.id)))];
    const unresolvedReferences = [...new Set([...refs.filter(r => r.status !== 'resolved').map(r => r.label), ...directReferences.filter(label => !refs.some(r => r.label.toLowerCase() === label.toLowerCase() && r.status === 'resolved'))])];
    // A whole selected clause retains structural context (definitions, parents).
    for (const parent of parents.filter(c => c.text === text)) { dependencyIds.push(...parent.dependencyIds); unresolvedReferences.push(...parent.unresolvedReferences); warnings.push(...parent.coverageGaps); }
    const id = `field-source:${translationHash([selection, identity, text])}`;
    return {selection, chunk: {id, documentVersionId: bundle.scope.documentVersionId, parseRevision: bundle.scope.parseRevision,
      logicalDocumentId: parents[0]?.logicalDocumentId ?? bundle.logicalDocuments[0]?.id ?? 'field-source', structureNodeId: id, parentId: null,
      text, textSha256: sha256(text), pageNumbers, regionIds, anchorIds, sourceNodeIds, dependencyIds: [...new Set(dependencyIds)], unresolvedReferences: [...new Set(unresolvedReferences)], coverageGaps: [...new Set(warnings)]}};
  });
  const unique = [...new Map(selected.map(item => [item.chunk.id, item])).values()].sort((a,b)=>a.chunk.id.localeCompare(b.chunk.id));
  return {bundle: {...bundle, chunks: [...bundle.chunks, ...unique.map(item => item.chunk)]}, selected: unique};
}
