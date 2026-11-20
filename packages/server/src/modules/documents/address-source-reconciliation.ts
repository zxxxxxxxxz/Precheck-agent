import type { DocumentFieldObservation, DocumentPageArtifact } from '@hsbc/contracts/documents';
import type { DocumentRegion, EvidenceAnchor } from '@hsbc/contracts/evidence';
import type { ReviewFieldDefinition } from '@hsbc/contracts/review-config';
import { anchorsForText, sha256 } from '../../document/evidence.js';
import { documentHtmlCellSpans } from '../../document/html-cells.js';
import { fieldValueSpan, normalizeExtractedValue } from './field-values.js';
type Candidate = DocumentFieldObservation['candidates'][number];
type Box = [number, number, number, number];
const unique = <T>(values: T[]) => [...new Set(values)];
function box(region: DocumentRegion): Box | undefined {
  if (region.polygons.length !== 1 || region.processing_status !== 'ready' || !region.raw_text ||
    region.raw_text_sha256 !== sha256(region.raw_text)) return;
  const points = region.polygons[0]!, b: Box = [Math.min(...points.map(p => p[0])), Math.min(...points.map(p => p[1])),
    Math.max(...points.map(p => p[0])), Math.max(...points.map(p => p[1]))];
  return b.every(Number.isFinite) && b[2] > b[0] && b[3] > b[1] ? b : undefined;
}
const inside = (inner: Box, outer: Box) => inner[0] >= outer[0] && inner[1] >= outer[1] && inner[2] <= outer[2] && inner[3] <= outer[3];
function sameLine(a: Box, b: Box) {
  const overlap = Math.max(0, Math.min(a[2], b[2]) - Math.max(a[0], b[0])) * Math.max(0, Math.min(a[3], b[3]) - Math.max(a[1], b[1]));
  const small = Math.min((a[2] - a[0]) * (a[3] - a[1]), (b[2] - b[0]) * (b[3] - b[1]));
  return overlap / small >= 0.8 && Math.max(a[3] - a[1], b[3] - b[1]) / Math.min(a[3] - a[1], b[3] - b[1]) <= 2;
}
/** Rank only a proven OCR substitution, never a nearest-address guess.
 * Two independent native/PP full lines must agree exactly at one location.
 * A contradictory table quote must occupy the same uniquely bracketed cell
 * slot and retain that line's exact phone affix. Every other case is untouched.
 * Rejected table candidates remain in the caller's immutable source history. */
export function reconcileAddressSources(candidates: Candidate[], pages: DocumentPageArtifact[], suppliedAnchors: EvidenceAnchor[], definition?: ReviewFieldDefinition): {
  candidates: Candidate[]; rejected: Map<number, string[]>; anchors: EvidenceAnchor[];
} {
  const allCandidates = [...candidates];
  const rejected = new Map<number, string[]>(), evidence: EvidenceAnchor[] = [];
  const byAnchor = new Map(suppliedAnchors.map(anchor => [anchor.anchor_id, anchor]));
  const sourceIds = (candidate: Candidate) => unique(candidate.anchorIds.flatMap(id => byAnchor.get(id)?.block_ids ?? []));
  for (const [weakIndex, weak] of candidates.entries()) {
    if (weak.pageNumbers.length !== 1 || weak.rawValue.length < 6 || weak.rawValue.includes('\n')) continue;
    const page = pages.find(page => page.page.page_number === weak.pageNumbers[0]);
    if (!page) continue;
    const valid = page.regions.filter(region => region.page_asset_id === page.page.page_asset_id &&
      region.document_version_id === page.scope.documentVersionId && region.parse_revision === page.scope.parseRevision);
    const weakIds = sourceIds(weak);
    if (weakIds.length !== 1) continue;
    const table = valid.find(region => region.region_id === weakIds[0] && region.source === 'vl_ocr' && region.kind === 'table');
    const tableBox = table && box(table);
    if (!table?.raw_text || !tableBox || !page.canonicalRegionIds.includes(table.region_id)) continue;
    const pp = valid.filter(region => region.source === 'pp_ocr' && box(region));
    // A separately readable occurrence makes this an unresolved business/source
    // alternative. Never overrule it merely because another value has more votes.
    if (pp.some(region => region.raw_text!.includes(weak.rawValue))) continue;
    const weakAnchors = weak.anchorIds.flatMap(id => byAnchor.get(id) ?? []);
    const positions = weakAnchors.flatMap(anchor => anchor.text_span_refs.filter(ref => ref.block_id === table.region_id)
      .flatMap(ref => {
        const chars = [...table.raw_text!];
        return chars.slice(ref.offset, ref.offset + ref.length).join('') === weak.rawValue ? [chars.slice(0, ref.offset).join('').length] : [];
      }));
    if (unique(positions).length !== 1) continue;
    const position = positions[0]!, cell = documentHtmlCellSpans(table.raw_text).find(span => span.start <= position && position + weak.rawValue.length <= span.end);
    if (!cell) continue;
    const cellText = table.raw_text.slice(cell.start, cell.end);
    // A model may omit the readable alternative entirely. Discover only exact
    // native/PP whole-line agreement; the SAME cell/phone/bracketing checks below
    // must still prove its role before it can become a candidate.
    const discovered: Array<{ candidate: Candidate; anchors: EvidenceAnchor[] }> = [];
    if (definition?.valueKind === 'address') for (const native of valid.filter(region => region.source === 'native_pdf' && box(region))) {
      for (const line of pp.filter(region => region.raw_text === native.raw_text && sameLine(box(region)!, box(native)!))) {
        const rawValue = fieldValueSpan(line.raw_text!, definition);
        if (!rawValue || rawValue === weak.rawValue || rawValue.length < 6 || rawValue.length > 2000 ||
          rawValue.includes('\n') || rawValue === line.raw_text || candidates.some(candidate => candidate.rawValue === rawValue &&
            candidate.pageNumbers.length === 1 && candidate.pageNumbers[0] === weak.pageNumbers[0])) continue;
        let value: EvidenceAnchor[];
        try { value = anchorsForText(page.page, [native, line], rawValue); } catch { continue; }
        for (const anchor of value) byAnchor.set(anchor.anchor_id, anchor);
        const ids = value.map(anchor => anchor.anchor_id), pageNumbers = [page.page.page_number];
        discovered.push({ candidate: { rawValue, normalizedValue: normalizeExtractedValue(rawValue, definition.type),
          displayValue: rawValue, anchorIds: ids, pageNumbers, contextText: line.raw_text!, contextAnchorIds: [],
          evidenceSegments: [{ rawValue, contextText: line.raw_text!, anchorIds: ids, contextAnchorIds: [], pageNumbers }] }, anchors: value });
      }
    }
    for (const strong of [...candidates, ...discovered.map(item => item.candidate)]) {
      if (strong === weak || strong.rawValue === weak.rawValue || strong.pageNumbers.length !== 1 ||
        strong.pageNumbers[0] !== weak.pageNumbers[0] || strong.rawValue.includes('\n')) continue;
      if (cellText.includes(strong.rawValue)) continue; // The cell may explicitly contain two distinct addresses.
      const strongIds = sourceIds(strong);
      const nativeLines = valid.filter(region => region.source === 'native_pdf' && strongIds.includes(region.region_id) && box(region));
      const ppLines = pp.filter(region => strongIds.includes(region.region_id));
      for (const native of nativeLines) for (const line of ppLines) {
        const nbox = box(native)!, lbox = box(line)!;
        if (native.raw_text !== line.raw_text || !sameLine(nbox, lbox) || !inside(lbox, tableBox)) continue;
        const text = line.raw_text!, at = text.indexOf(strong.rawValue);
        if (at < 0 || text.indexOf(strong.rawValue, at + 1) !== -1) continue;
        const prefix = text.slice(0, at), suffix = text.slice(at + strong.rawValue.length);
        if (((prefix + suffix).match(/\d/gu) ?? []).length < 7) continue;
        const alternate = prefix + weak.rawValue + suffix, expected = position - cell.start - prefix.length;
        if (expected < 0 || cellText.slice(expected, expected + alternate.length) !== alternate ||
          cellText.indexOf(alternate) !== cellText.lastIndexOf(alternate)) continue;
        const boundary = pp.flatMap(region => {
          if (region.region_id === line.region_id) return [];
          const text = region.raw_text!.trim(), b = box(region)!;
          if (text.length < 6 || !inside(b, tableBox) || cellText.indexOf(text) < 0 ||
            table.raw_text!.indexOf(text) !== table.raw_text!.lastIndexOf(text) ||
            Math.min(b[2], lbox[2]) <= Math.max(b[0], lbox[0])) return [];
          const distance = Math.min(Math.abs(lbox[1] - b[3]), Math.abs(b[1] - lbox[3]));
          if (distance > (lbox[3] - lbox[1]) * 4) return [];
          const offset = cellText.indexOf(text);
          return [{ region, b, offset, text, distance }];
        });
        const before = boundary.filter(item => item.b[3] <= lbox[1] && item.offset + item.text.length <= expected)
          .sort((a, b) => a.distance - b.distance)[0];
        const after = boundary.filter(item => item.b[1] >= lbox[3] && item.offset >= expected + alternate.length)
          .sort((a, b) => a.distance - b.distance)[0];
        if (!before || !after) continue;
        if (after.b[1] - before.b[3] > (lbox[3] - lbox[1]) * 3) continue;
        if (pp.some(region => {
          const b = box(region)!;
          return b[1] >= before.b[3] && b[3] <= after.b[1] && Math.min(b[2], lbox[2]) > Math.max(b[0], lbox[0]) &&
            !text.includes(region.raw_text!) && !region.raw_text!.includes(text);
        })) continue;
        // No second located address line may occupy that same bracketed slot.
        if (pp.some(region => region.region_id !== line.region_id && region.raw_text!.includes(strong.rawValue) &&
          !sameLine(box(region)!, lbox))) continue;
        let anchors: EvidenceAnchor[];
        try {
          anchors = [...anchorsForText(page.page, [native, line], strong.rawValue),
            ...anchorsForText(page.page, [before.region], before.text), ...anchorsForText(page.page, [after.region], after.text),
            ...anchorsForText(page.page, [table], cellText).filter(anchor => anchor.text_span_refs.some(ref =>
              ref.offset === [...table.raw_text!.slice(0, cell.start)].length))];
        } catch { continue; }
        if (!anchors.length || anchors.some(anchor => !anchor.polygons.length)) continue;
        const recovered = discovered.find(item => item.candidate === strong);
        if (recovered && !allCandidates.some(candidate => candidate.rawValue === strong.rawValue &&
          JSON.stringify(candidate.pageNumbers) === JSON.stringify(strong.pageNumbers))) {
          const contextAnchorIds = unique([...anchors.map(anchor => anchor.anchor_id), ...(weak.contextAnchorIds ?? []), ...weak.anchorIds]);
          allCandidates.push({ ...strong, contextAnchorIds,
            evidenceSegments: strong.evidenceSegments?.map(segment => ({ ...segment, contextAnchorIds })) });
          evidence.push(...recovered.anchors);
        }
        evidence.push(...anchors); rejected.set(weakIndex, unique(anchors.map(anchor => anchor.anchor_id)));
      }
    }
  }
  return { candidates: allCandidates, rejected, anchors: [...new Map(evidence.map(anchor => [anchor.anchor_id, anchor])).values()] };
}
