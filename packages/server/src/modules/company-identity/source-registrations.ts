import type { DocumentPageArtifact } from '@hsbc/contracts/documents';
import type { DocumentRegion, EvidenceAnchor } from '@hsbc/contracts/evidence';
import { anchorsForText, sha256 } from '../../document/evidence.js';
import type { CompanyNameIdentifierEvidence, CompanyNamePairEvidence, NameCandidate } from './normalization.js';

type Box = [number, number, number, number];
type Line = { region: DocumentRegion; text: string; box: Box };
type Header = { name: string; key: string; page: DocumentPageArtifact; box: Box; anchors: EvidenceAnchor[] };
const unique = <T>(values: T[]) => [...new Set(values)];
const han = (text: string) => /\p{Script=Han}/u.test(text);
const center = (box: Box) => (box[0] + box[2]) / 2;
const height = (box: Box) => box[3] - box[1];
const contains = (outer: Box, inner: Box) =>
  outer[0] <= inner[0] && outer[1] <= inner[1] && outer[2] >= inner[2] && outer[3] >= inner[3];

// These are literal jurisdiction aliases, not company translations or a name
// similarity index. Unsupported/ambiguous incorporation language stays ungrouped.
const jurisdictions = [
  { key: 'MY', english: 'Malaysia', chinese: '马来西亚' },
  { key: 'SG', english: 'Singapore', chinese: '新加坡' },
  { key: 'HK', english: 'Hong Kong', chinese: '香港' },
] as const;

function sourceLines(page: DocumentPageArtifact): Line[] {
  if (page.status === 'failed' || page.page.document_version_id !== page.scope.documentVersionId ||
    page.page.parse_revision !== page.scope.parseRevision || page.page.source_sha256 !== page.scope.sourceSha256) return [];
  const lines = page.regions.flatMap(region => {
    if (region.source !== 'pp_ocr' || region.kind !== 'text' || region.processing_status !== 'ready' ||
      region.page_asset_id !== page.page.page_asset_id || region.document_version_id !== page.scope.documentVersionId ||
      region.parse_revision !== page.scope.parseRevision || !region.raw_text ||
      region.raw_text_sha256 !== sha256(region.raw_text) || region.polygons.length !== 1 ||
      /[\r\n]/u.test(region.raw_text) || page.conflicts.some(conflict => conflict.region_ids.includes(region.region_id))) return [];
    const polygon = region.polygons[0]!, box: Box = [
      Math.min(...polygon.map(p => p[0])), Math.min(...polygon.map(p => p[1])),
      Math.max(...polygon.map(p => p[0])), Math.max(...polygon.map(p => p[1])),
    ];
    if (!box.every(Number.isFinite) || box[0] < 0 || box[1] < 0 || box[2] > page.page.width ||
      box[3] > page.page.height * 0.4 || box[2] <= box[0] || box[3] <= box[1]) return [];
    return [{ region, text: region.raw_text.trim(), box }];
  });
  // OCR includes word boxes as well as complete lines. A token is not a header
  // line merely because it contains a country or the word "Company".
  return lines.filter(line => !lines.some(other => other !== line &&
    other.text.length > line.text.length && other.text.includes(line.text) && contains(other.box, line.box)))
    .sort((a, b) => a.box[1] - b.box[1] || a.box[0] - b.box[0]);
}

function registration(text: string, chinese: boolean): string | undefined {
  const pattern = chinese
    ? /^[（([]?\s*(?:公司编号|公司編號|公司注册编号|公司註冊編號)\s*[:：]?\s*([A-Z0-9][A-Z0-9./-]{3,79})\s*[）)\]]?$/u
    : /^[（([]?\s*Company\s+(?:No\.?|Number)\s*[:：]?\s*([A-Z0-9][A-Z0-9./-]{3,79})\s*[）)\]]?$/iu;
  // Preserve punctuation and case of the registration value. No fuzzy match.
  return pattern.exec(text)?.[1];
}
function definition(text: string, chinese: boolean): boolean {
  return chinese ? /^[（(]\s*[“"「]本公司[”"」]\s*[）)]$/u.test(text)
    : /^[（(]\s*the\s+[“"]Company[”"]\s*[）)]$/iu.test(text);
}
function incorporation(text: string, chinese: boolean): string | undefined {
  const words = text.replace(/\s+/gu, ' ').trim();
  const matches = jurisdictions.filter(jurisdiction => chinese
    ? new RegExp(`^[（(](?:根据|根據|依据|依據)${jurisdiction.chinese}《?\\s*\\d{4}\\s*年公司法》?(?:成立|正式|注册|註冊)?(?:(?:并且|並且)(?:视为|視為)(?:根据|根據|依据|依據)${jurisdiction.chinese}《?\\s*\\d{4}\\s*年公司法》?)?(?:注册|註冊)[）)]$`, 'u').test(words)
    : new RegExp(`^[（(]Incorporated under the Companies Act \\d{4}, ${jurisdiction.english}(?: and deemed registered under the Companies Act \\d{4}, ${jurisdiction.english})?[）)]$`, 'iu').test(words));
  return matches.length === 1 ? matches[0]!.key : undefined;
}
function validNameSource(page: DocumentPageArtifact, name: string): boolean {
  return page.regions.some(region => page.canonicalRegionIds.includes(region.region_id) &&
    region.processing_status === 'ready' && region.raw_text?.includes(name) &&
    region.raw_text_sha256 === sha256(region.raw_text) && region.polygons.length === 1 &&
    region.page_asset_id === page.page.page_asset_id && region.document_version_id === page.scope.documentVersionId &&
    region.parse_revision === page.scope.parseRevision && !page.conflicts.some(conflict => conflict.region_ids.includes(region.region_id)));
}

/** Both names need their own located, contiguous name/number/definition/
 * incorporation header on the same page. Same-page country mentions or a
 * registration number without its jurisdiction never establish correspondence.
 * Caller restricts pages and candidates to one classified logical material. */
export function companyRegistrationEvidence(candidates: NameCandidate[], pages: DocumentPageArtifact[]): {
  pairs: CompanyNamePairEvidence[]; identifiers: CompanyNameIdentifierEvidence[]; anchors: EvidenceAnchor[];
} {
  const names = unique(candidates.map(item => item.rawValue)).filter(name => name.length >= 2 && name.length <= 300 &&
    !/\bbranch\b|分行|支行|分公司/iu.test(name));
  const first = pages[0]?.scope;
  if (!first || pages.some(page => page.scope.documentVersionId !== first.documentVersionId ||
    page.scope.parseRevision !== first.parseRevision || page.scope.sourceSha256 !== first.sourceSha256)) return { pairs: [], identifiers: [], anchors: [] };
  const headers: Header[] = [];
  for (const page of pages) {
    // A canonical paragraph can carry the whole header. It supplies its own
    // literal line spans; a conflicting alternative OCR line is not reused.
    for (const region of page.regions) {
      if (page.status === 'failed' || page.page.document_version_id !== page.scope.documentVersionId ||
        page.page.parse_revision !== page.scope.parseRevision || page.page.source_sha256 !== page.scope.sourceSha256 ||
        region.source !== 'vl_ocr' || region.kind !== 'text' || !page.canonicalRegionIds.includes(region.region_id) ||
        region.processing_status !== 'ready' || !region.raw_text || region.raw_text.length > 1500 ||
        region.raw_text_sha256 !== sha256(region.raw_text) || region.polygons.length !== 1 ||
        region.page_asset_id !== page.page.page_asset_id || region.document_version_id !== page.scope.documentVersionId ||
        region.parse_revision !== page.scope.parseRevision || page.conflicts.some(conflict => conflict.region_ids.includes(region.region_id))) continue;
      const lines = region.raw_text.split(/\r?\n/u).map(text => text.trim()).filter(Boolean);
      if (lines.length < 4 || lines.length > 5 || !names.includes(lines[0]!)) continue;
      const chinese = han(lines[0]!), number = registration(lines[1]!, chinese);
      const jurisdiction = incorporation(lines.slice(3).join(' '), chinese);
      if (!number || !definition(lines[2]!, chinese) || !jurisdiction) continue;
      const polygon = region.polygons[0]!, box: Box = [
        Math.min(...polygon.map(p => p[0])), Math.min(...polygon.map(p => p[1])),
        Math.max(...polygon.map(p => p[0])), Math.max(...polygon.map(p => p[1])),
      ];
      if (!box.every(Number.isFinite) || box[0] < 0 || box[1] < 0 || box[2] > page.page.width ||
        box[3] > page.page.height * 0.4 || box[2] <= box[0] || box[3] <= box[1]) continue;
      try {
        const anchors = lines.flatMap(text => anchorsForText(page.page, [region], text));
        if (anchors.length === lines.length && anchors.every(anchor => anchor.polygons.length > 0))
          headers.push({name:lines[0]!,key:`registration-jurisdiction:${jurisdiction}:${number}`,page,box,anchors});
      } catch { continue; }
    }
    const lines = sourceLines(page);
    for (const [index, line] of lines.entries()) {
      if (!names.includes(line.text) || !validNameSource(page, line.text)) continue;
      const chinese = han(line.text), remaining = lines.slice(index + 1, index + 6);
      // Require adjacent centered lines; do not skip an intervening company,
      // column, list item or unrelated prose to find a convenient identifier.
      const selected = [line];
      for (const next of remaining) {
        const prior = selected.at(-1)!;
        if (next.box[1] < prior.box[3] - Math.min(height(prior.box), height(next.box)) * 0.25 ||
          next.box[1] - prior.box[3] > Math.max(height(prior.box), height(next.box)) * 2 ||
          Math.abs(center(next.box) - center(line.box)) > page.page.width * 0.1) break;
        selected.push(next);
      }
      const number = selected[1] && registration(selected[1].text, chinese);
      if (!number || !selected[2] || !definition(selected[2].text, chinese)) continue;
      let matched: { jurisdiction: string; count: number } | undefined;
      for (const count of [1, 2]) {
        const clauses = selected.slice(3, 3 + count);
        if (clauses.length !== count) continue;
        const jurisdiction = incorporation(clauses.map(item => item.text).join(' '), chinese);
        if (jurisdiction) { matched = { jurisdiction, count }; break; }
      }
      if (!matched) continue;
      const proof = selected.slice(0, 3 + matched.count);
      try {
        const anchors = proof.flatMap(item => anchorsForText(page.page, [item.region], item.region.raw_text!));
        if (anchors.length !== proof.length || anchors.some(anchor => !anchor.polygons.length)) continue;
        headers.push({ name: line.text, key: `registration-jurisdiction:${matched.jurisdiction}:${number}`,
          page, box: line.box, anchors });
      } catch { continue; }
    }
  }
  const keysByName = new Map(names.map(name => [name, unique(headers.filter(header => header.name === name).map(header => header.key))]));
  const result: Array<{ pair: CompanyNamePairEvidence; anchors: EvidenceAnchor[] }> = [];
  for (const [index, a] of headers.entries()) for (const b of headers.slice(index + 1)) {
    if (a.name === b.name || han(a.name) === han(b.name) || a.key !== b.key ||
      a.page.page.page_asset_id !== b.page.page.page_asset_id ||
      Math.abs(center(a.box) - center(b.box)) > a.page.page.width * 0.1 ||
      Math.abs(a.box[1] - b.box[1]) > a.page.page.height * 0.3 ||
      keysByName.get(a.name)?.length !== 1 || keysByName.get(b.name)?.length !== 1 ||
      unique(headers.filter(header => header.key === a.key).map(header => header.name)).length !== 2) continue;
    const anchors = [...a.anchors, ...b.anchors];
    result.push({ pair: { names: [a.name, b.name], basis: 'scoped_identifier', scopedIdentifier: a.key,
      evidenceAnchorIds: anchors.map(anchor => anchor.anchor_id), materialPageNumbers: pages.map(item => item.page.page_number) }, anchors });
  }
  return { pairs: result.map(item => item.pair),
    identifiers: headers.map(header => ({ name: header.name, key: header.key,
      evidenceAnchorIds: header.anchors.map(anchor => anchor.anchor_id), materialPageNumbers: pages.map(page => page.page.page_number) })),
    anchors: [...new Map(headers.flatMap(item => item.anchors).map(anchor => [anchor.anchor_id, anchor])).values()] };
}
