import type { DocumentPageArtifact } from '@hsbc/contracts/documents';
import type { EvidenceAnchor } from '@hsbc/contracts/evidence';
import { anchorsForText, sha256 } from '../../document/evidence.js';
import { documentHtmlCellSpans } from '../../document/html-cells.js';
import { normalizeCompanyName, type CompanyNamePairEvidence, type NameCandidate } from './normalization.js';

const compare = (value: string) => normalizeCompanyName(value).comparisonKey;
const han = (value: string) => /\p{Script=Han}/u.test(value);
const unique = <T>(values: T[]) => [...new Set(values)];

/** Caller must pass only pages of the field's applicable logical materials.
 * A whole-table/shared paragraph anchor does not constitute a bilingual cell.
 * Exactly two selected names must exhaust one cell; country/role/test lines are
 * deliberately not stripped. Source proof may support a repeated signing-page
 * citation in that same material, without modifying either original candidate. */
export function companyNameCellEvidence(candidates: NameCandidate[], pages: DocumentPageArtifact[]): {
  pairs: CompanyNamePairEvidence[]; anchors: EvidenceAnchor[];
} {
  const names = unique(candidates.map(candidate => candidate.rawValue).filter(value => value.trim().length >= 2));
  const found: Array<CompanyNamePairEvidence & { anchors: EvidenceAnchor[] }> = [];
  for (const page of pages) for (const region of page.regions) {
    if (region.kind !== 'table' || region.source !== 'vl_ocr' || !page.canonicalRegionIds.includes(region.region_id) ||
      !region.raw_text || region.raw_text_sha256 !== sha256(region.raw_text) || region.processing_status !== 'ready' ||
      region.polygons.length !== 1 || region.page_asset_id !== page.page.page_asset_id ||
      region.document_version_id !== page.scope.documentVersionId || region.parse_revision !== page.scope.parseRevision) continue;
    for (const span of documentHtmlCellSpans(region.raw_text)) {
      const rawCell = region.raw_text.slice(span.start, span.end);
      const text = compare(rawCell.replace(/<br\s*\/?>/giu, '\n'));
      const members = names.filter(name => text.includes(compare(name)));
      if (members.length !== 2 || han(members[0]!) === han(members[1]!) ||
        !/[A-Za-z]/u.test(han(members[0]!) ? members[1]! : members[0]!)) continue;
      // Explicit cell structure is the correspondence. Additional words, a
      // third party, or repeated occurrences make that correspondence unclear.
      let remaining = text;
      for (const member of [...members].sort((a, b) => b.length - a.length)) remaining = remaining.replace(compare(member), '');
      if (!/^[\s()（）,，;；]*$/u.test(remaining)) continue;
      const offset = [...region.raw_text.slice(0, span.start)].length;
      let anchors: EvidenceAnchor[];
      try {
        anchors = anchorsForText(page.page, [region], rawCell).filter(anchor =>
          anchor.text_span_refs.some(ref => ref.offset === offset) && anchor.polygons.length);
      } catch { continue; }
      if (!anchors.length) continue;
      found.push({ names: [members[0]!, members[1]!], evidenceAnchorIds: anchors.map(anchor => anchor.anchor_id),
        materialPageNumbers: pages.map(item => item.page.page_number), anchors });
    }
  }
  // A source that pairs the same spelling with different counterparts remains
  // ambiguous; it cannot bridge independently identified business objects.
  const counterparts = new Map<string, Set<string>>();
  for (const pair of found) for (const name of pair.names) {
    const other = pair.names.find(value => value !== name)!;
    const values = counterparts.get(name) ?? new Set<string>(); values.add(other); counterparts.set(name, values);
  }
  const unambiguous = found.filter(pair => pair.names.every(name => counterparts.get(name)?.size === 1));
  return { pairs: unambiguous.map(({ anchors: _, ...pair }) => pair),
    anchors: [...new Map(unambiguous.flatMap(pair => pair.anchors).map(anchor => [anchor.anchor_id, anchor])).values()] };
}
