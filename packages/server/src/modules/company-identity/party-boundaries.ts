import type { DocumentFieldObservation, DocumentPageArtifact } from '@hsbc/contracts/documents';
import type { DocumentRegion, EvidenceAnchor } from '@hsbc/contracts/evidence';
import { anchorsForText, sha256 } from '../../document/evidence.js';
type Candidate = DocumentFieldObservation['candidates'][number];
type Box = [number, number, number, number];
const unique = <T>(values: T[]) => [...new Set(values)];
const key = (candidate: Candidate) => JSON.stringify(candidate.evidenceSegments ?? [candidate.rawValue, candidate.contextText, candidate.pageNumbers]);
function valid(region: DocumentRegion, page: DocumentPageArtifact) {
  return region.page_asset_id === page.page.page_asset_id && region.document_version_id === page.scope.documentVersionId &&
    region.parse_revision === page.scope.parseRevision && region.processing_status === 'ready' && region.raw_text &&
    region.raw_text_sha256 === sha256(region.raw_text);
}
function box(region: DocumentRegion): Box | undefined {
  if (region.polygons.length !== 1) return;
  const p = region.polygons[0]!, result: Box = [Math.min(...p.map(v => v[0])), Math.min(...p.map(v => v[1])),
    Math.max(...p.map(v => v[0])), Math.max(...p.map(v => v[1]))];
  return result.every(Number.isFinite) && result[2] > result[0] && result[3] > result[1] ? result : undefined;
}
const verticalOverlap = (a: Box, b: Box) => Math.max(0, Math.min(a[3], b[3]) - Math.max(a[1], b[1])) / Math.min(a[3] - a[1], b[3] - b[1]);
const centeredInside = (inner: Box, outer: Box) => inner[0] >= outer[0] && inner[2] <= outer[2] &&
  (inner[1] + inner[3]) / 2 >= outer[1] && (inner[1] + inner[3]) / 2 <= outer[3];
const registrations = (text: string) => unique([...text.matchAll(/\bRegistration\s*(?:No\.?|Number)\s*[:：]?\s*([A-Z0-9][A-Z0-9./-]{4,})/giu)].map(match => match[1]!));
const roles = (text: string) => unique([...text.matchAll(/\b(?:Chargor|Borrower|Mortgagor|Guarantor|Lender)\b/giu)].map(match => match[0].toLowerCase()));

/** Only narrow a literal company suffix after three independent source checks.
 * Native text corroborates spelling only: its absent geometry is never invented.
 * Located PP must separate a grammatical pronoun/comma from the whole name;
 * another located identity block must repeat the exact name, registration and
 * role. No fuzzy name matching, prefix blacklist or inferred identity is used.
 * The original candidate is retained, rejected with evidence, beside its newly
 * anchored contiguous suffix. This helper is called only by extraction v2. */
export function reconcilePartyBoundaries(originals: Candidate[], pages: DocumentPageArtifact[], suppliedAnchors: EvidenceAnchor[]): {
  candidates: Candidate[]; rejected: Map<number, string[]>; anchors: EvidenceAnchor[];
} {
  const candidates = [...originals], rejected = new Map<number, string[]>(), evidence: EvidenceAnchor[] = [];
  const byAnchor = new Map(suppliedAnchors.map(anchor => [anchor.anchor_id, anchor]));
  for (const [index, candidate] of originals.entries()) {
    if (candidate.pageNumbers.length !== 1 || candidate.evidenceSegments && candidate.evidenceSegments.length !== 1 ||
      candidate.rawValue.length > 300 || !candidate.contextText) continue;
    const page = pages.find(item => item.page.page_number === candidate.pageNumbers[0]);
    if (!page) continue;
    const regions = page.regions.filter(region => valid(region, page));
    const sourceIds = unique(candidate.anchorIds.flatMap(id => byAnchor.get(id)?.block_ids ?? []));
    if (sourceIds.length !== 1) continue;
    const paragraph = regions.find(region => sourceIds.includes(region.region_id) && region.source === 'vl_ocr' && region.kind === 'text');
    const paragraphBox = paragraph && box(paragraph);
    if (!paragraph?.raw_text || !paragraphBox || !page.canonicalRegionIds.includes(paragraph.region_id) ||
      paragraph.raw_text.indexOf(candidate.rawValue) !== 0 || paragraph.raw_text.lastIndexOf(candidate.rawValue) !== 0) continue;
    const registration = registrations(paragraph.raw_text), partyRoles = roles(paragraph.raw_text);
    if (registration.length !== 1 || partyRoles.length !== 1) continue;
    const pp = regions.filter(region => region.source === 'pp_ocr' && box(region));
    const matches: Array<{ name: string; value: EvidenceAnchor[]; proof: EvidenceAnchor[] }> = [];
    for (const line of pp) {
      const name = line.raw_text!, lineBox = box(line)!;
      if (name.length < 6 || name !== name.trim() || !candidate.rawValue.endsWith(name) || name === candidate.rawValue ||
        !centeredInside(lineBox, paragraphBox) || lineBox[1] - paragraphBox[1] > (lineBox[3] - lineBox[1]) * 1.5) continue;
      const prefix = candidate.rawValue.slice(0, -name.length);
      // Only a short separate word and comma can correspond to the independently
      // located grammatical opening below. Its OCR spelling is not corrected.
      if (!/^\p{L}{1,4},\s+$/u.test(prefix)) continue;
      const native = regions.filter(region => region.source === 'native_pdf' && region.raw_text === name);
      if (!native.length) continue;
      // A complete competing PP observation of the original name defeats the
      // boundary claim. Shorter token fragments inside this name do not.
      if (pp.some(region => region.raw_text === candidate.rawValue)) continue;
      const left = pp.filter(region => {
        const b = box(region)!;
        return region.raw_text!.trim().length > 0 && b[2] <= lineBox[0] && lineBox[0] - b[0] <= (lineBox[3] - lineBox[1]) * 4 &&
          verticalOverlap(b, lineBox) >= 0.5 && centeredInside(b, paragraphBox);
      }).sort((a, b) => box(a)![0] - box(b)![0]);
      const pronoun = left.find(region => /^(?:We|I),?$/u.test(region.raw_text!));
      if (!pronoun) continue;
      const pronounIndex = left.indexOf(pronoun), observedLead = left.slice(pronounIndex);
      // OCR may provide both a whole token and its constituent glyph runs.
      // A duplicate can be ignored only inside that exact located token.
      const lead = /,$/u.test(pronoun.raw_text!) ? [pronoun, ...observedLead.slice(1).filter(region =>
        !pronoun.raw_text!.includes(region.raw_text!) || box(region)![0] < box(pronoun)![0] ||
        box(region)![2] > box(pronoun)![2] + 2)] : observedLead;
      if (lead.length > 2 || !/^(?:We|I),$/u.test(lead.map(region => region.raw_text).join('')) ||
        lead.some((region, i) => i > 0 && box(region)![0] - box(lead[i - 1]!)![2] > (lineBox[3] - lineBox[1])) ||
        lineBox[0] - box(lead.at(-1)!)![2] > (lineBox[3] - lineBox[1])) continue;
      const witnesses = pages.filter(other => other.page.page_number !== page.page.page_number &&
        other.scope.documentVersionId === page.scope.documentVersionId && other.scope.parseRevision === page.scope.parseRevision)
        .flatMap(other => other.regions.filter(region => valid(region, other) && region.source === 'vl_ocr' && region.kind === 'text' &&
          box(region) && other.canonicalRegionIds.includes(region.region_id)).map(region => ({ page: other, region })))
        .filter(({ region }) => {
          const text = region.raw_text!;
          return text.length <= 500 && text.startsWith(name) && text.indexOf(name) === text.lastIndexOf(name) &&
            /^[\s(（]*Registration\b/iu.test(text.slice(name.length)) &&
            JSON.stringify(registrations(text)) === JSON.stringify(registration) &&
            JSON.stringify(roles(text)) === JSON.stringify(partyRoles);
        });
      if (!witnesses.length) continue;
      let value: EvidenceAnchor[], proof: EvidenceAnchor[];
      try {
        value = [...anchorsForText(page.page, [line], name), ...anchorsForText(page.page, [paragraph], name)];
        proof = [...native.flatMap(region => anchorsForText(page.page, [region], name)),
          ...lead.flatMap(region => anchorsForText(page.page, [region], region.raw_text!)),
          ...anchorsForText(page.page, [paragraph], paragraph.raw_text),
          ...witnesses.flatMap(({ page: other, region }) => anchorsForText(other.page, [region], region.raw_text!))];
      } catch { continue; }
      if (!value.length || value.some(anchor => !anchor.polygons.length)) continue;
      matches.push({ name, value, proof });
    }
    if (unique(matches.map(match => match.name)).length !== 1) continue;
    const match = matches[0]!, valueAnchors = unique(matches.flatMap(item => item.value.map(anchor => anchor.anchor_id)));
    const proofAnchors = unique(matches.flatMap(item => item.proof.map(anchor => anchor.anchor_id)));
    const contextAnchorIds = unique([...(candidate.contextAnchorIds ?? []), ...candidate.anchorIds, ...proofAnchors]);
    const { nameAssociation: _, ...prior } = candidate;
    const narrowed: Candidate = { ...prior, rawValue: match.name, normalizedValue: match.name, displayValue: match.name,
      anchorIds: valueAnchors, contextAnchorIds,
      evidenceSegments: [{ rawValue: match.name, contextText: candidate.contextText, anchorIds: valueAnchors,
        contextAnchorIds, pageNumbers: candidate.pageNumbers }] };
    if (!candidates.some(item => key(item) === key(narrowed))) candidates.push(narrowed);
    rejected.set(index, unique([...valueAnchors, ...proofAnchors]));
    evidence.push(...matches.flatMap(item => [...item.value, ...item.proof]));
  }
  return { candidates, rejected, anchors: [...new Map(evidence.map(anchor => [anchor.anchor_id, anchor])).values()] };
}
