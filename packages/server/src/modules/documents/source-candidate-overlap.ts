import type {DocumentFieldObservation, DocumentPageArtifact} from '@hsbc/contracts/documents';
import type {EvidenceAnchor} from '@hsbc/contracts/evidence';
import {distinctSourceCandidates, type DocumentFieldPresentation} from '@hsbc/contracts/document-presentation';
import {validateAnchorSource} from '../../document/evidence.js';

/** Reconcile quotes from the same physical source, including overlapping OCR
 * and native text blocks. Tables, conflicts and unverified native text cannot
 * establish cross-block equivalence. No persisted source geometry is rewritten. */
export function reconcileSourceOverlaps(field: DocumentFieldPresentation, anchors: EvidenceAnchor[], pages: DocumentPageArtifact[]) {
  if(field.candidates.length<2)return field;
  const wanted=new Set(field.candidates.flatMap(c=>c.anchorIds));
  const checked = new Map<string, {anchor: EvidenceAnchor; box: number[]}>();
  for (const a of anchors) {
    if(!wanted.has(a.anchor_id))continue;
    const page = pages.find(p => p.page.page_number === a.page_number && p.scope.documentVersionId === field.documentVersionId && p.scope.parseRevision === field.parseRevision);
    if (!page || page.status === 'failed' || a.text_span_refs.length !== 1) continue;
    const region = page.regions.find(r => r.region_id === a.text_span_refs[0]!.block_id);
    if (!region || region.kind !== 'text' || region.processing_status !== 'ready' ||
      region.source === 'native_pdf' && page.nativeTrust !== 'validated_geometry_and_visibility' ||
      page.conflicts.some(c => c.region_ids.includes(region.region_id))) continue;
    try { validateAnchorSource(a, page.page, page.regions); } catch { continue; }
    const points = a.polygons.flat();
    const box = [Math.min(...points.map(p=>p[0])),Math.min(...points.map(p=>p[1])),Math.max(...points.map(p=>p[0])),Math.max(...points.map(p=>p[1]))];
    if (box.every(Number.isFinite) && box[2]! > box[0]! && box[3]! > box[1]!) checked.set(a.anchor_id, {anchor:a,box});
  }
  return distinctSourceCandidates(field, anchors, (inner,outer) => {
    const a=checked.get(inner.anchor_id)?.box,b=checked.get(outer.anchor_id)?.box;
    if (!a || !b) return false;
    const overlap=Math.max(0,Math.min(a[2]!,b[2]!)-Math.max(a[0]!,b[0]!))*Math.max(0,Math.min(a[3]!,b[3]!)-Math.max(a[1]!,b[1]!));
    // Comparable line height prevents a whole paragraph from absorbing a
    // different occurrence elsewhere within its large rectangle.
    return Math.max(a[3]!-a[1]!,b[3]!-b[1]!)/Math.min(a[3]!-a[1]!,b[3]!-b[1]!)<=1.5 && overlap/((a[2]!-a[0]!)*(a[3]!-a[1]!))>=.85;
  });
}

/** New extraction decisions use the same source proof as historical reading. */
export function rejectSourceOverlaps(field: DocumentFieldObservation, candidates: DocumentFieldObservation['candidates'], anchors: EvidenceAnchor[], pages: DocumentPageArtifact[]) {
  const projected=reconcileSourceOverlaps({...field,candidates,humanRevisionId:null,semanticFilter:{version:'azure-grounded-fields-v2',state:'completed',model:'source-overlap',originalCandidates:[],decisions:[],reasonCodes:[]}},anchors,pages);
  return new Map(candidates.flatMap((candidate,index)=>projected.candidates.includes(candidate)?[]:[[index,candidate.anchorIds] as const]));
}
