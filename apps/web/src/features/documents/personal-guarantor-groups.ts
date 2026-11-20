import type {DocumentFieldObservation, EvidenceAnchor} from './types.ts';

type Candidate = DocumentFieldObservation['candidates'][number];
type Box = {left: number; top: number; right: number; bottom: number; page: number; asset: string};
export type GuarantorValue = {fieldId: string; text: string; anchorIds: string[]; pageNumbers: number[]; box?: Box};
export type GuarantorGroup = {id: string; name: GuarantorValue; values: GuarantorValue[]};
export const guarantorDetailFields = new Set(['pg_field_13', 'pg_field_14', 'pg_field_15', 'pg_field_12', 'pg_guarantor_signed']);
const identityFields = new Set(['pg_field_13', 'pg_field_14', 'pg_field_15']);
const textKey = (value: string) => value.normalize('NFKC').replace(/\s/g, '');
const blank = (value: string) => !value.trim() || /^[\s_—–\-．.·]+$/u.test(value);
const unique = <T,>(values: T[]) => [...new Set(values)];
function boxFor(candidate: Candidate, anchors: Map<string, EvidenceAnchor>): Box | undefined {
  const found = candidate.anchorIds.map(id => anchors.get(id));
  if (!found.length || found.some(anchor => !anchor || !['exact', 'block_only'].includes(anchor.localization_status) || !anchor.polygons.length)) return;
  const scoped = found as EvidenceAnchor[];
  if (new Set(scoped.map(anchor => anchor.page_asset_id)).size !== 1 || new Set(scoped.map(anchor => anchor.page_number)).size !== 1) return;
  const points = scoped.flatMap(anchor => anchor.polygons.flat());
  const box = {left: Math.min(...points.map(p => p[0])), top: Math.min(...points.map(p => p[1])), right: Math.max(...points.map(p => p[0])), bottom: Math.max(...points.map(p => p[1])), page: scoped[0].page_number, asset: scoped[0].page_asset_id};
  return box.bottom > box.top && box.right > box.left ? box : undefined;
}
function overlaps(a: Box, b: Box) {
  return a.asset === b.asset && a.page === b.page && Math.min(a.right, b.right) > Math.max(a.left, b.left) && Math.min(a.bottom, b.bottom) > Math.max(a.top, b.top);
}
function merge(target: GuarantorValue, other: GuarantorValue) {
  target.anchorIds = unique([...target.anchorIds, ...other.anchorIds]);
  target.pageNumbers = unique([...target.pageNumbers, ...other.pageNumbers]);
}
/** A reading aid, never an identity assertion. Only local, vertically arranged
 * signing rows are suggested; uncertain associations stay outside the groups. */
export function personalGuarantorGroups(fields: readonly DocumentFieldObservation[], anchors: readonly EvidenceAnchor[], documentId: string, parseRevision: string) {
  const scoped = new Map(anchors.filter(a => a.document_version_id === documentId && a.parse_revision === parseRevision).map(a => [a.anchor_id, a]));
  const values: GuarantorValue[] = [];
  for (const field of fields.filter(f => identityFields.has(f.fieldId) && f.documentVersionId === documentId && f.parseRevision === parseRevision)) {
    for (const candidate of field.candidates) {
      const value: GuarantorValue = {fieldId: field.fieldId, text: candidate.rawValue, anchorIds: candidate.anchorIds.filter(id => scoped.has(id)), pageNumbers: unique(candidate.anchorIds.flatMap(id => scoped.get(id)?.page_number ?? [])), box: boxFor(candidate, scoped)};
      // Only formatting duplicates at the same source position are coalesced.
      const previous = values.find(v => v.fieldId === value.fieldId && textKey(v.text) === textKey(value.text) && v.box && value.box && overlaps(v.box, value.box));
      if (previous) merge(previous, value); else values.push(value);
    }
  }
  const groups: GuarantorGroup[] = [];
  const names = values.filter(v => v.fieldId === 'pg_field_13' && !blank(v.text) && v.box && v.box.bottom - v.box.top < (v.box.right - v.box.left) / 2);
  for (const name of names) {
    // OCR and native text can disagree at the same signing row. Keep both
    // readings visible in one source block, without choosing an identity.
    const sameRow = groups.filter(group => group.name.box && overlaps(group.name.box, name.box!));
    if (sameRow.length === 1) sameRow[0].values.push(name);
    else groups.push({id: name.anchorIds.join('|'), name, values: [name]});
  }
  groups.sort((a, b) => a.name.box!.page - b.name.box!.page || a.name.box!.top - b.name.box!.top || a.name.box!.left - b.name.box!.left);
  const unassigned = values.filter(value => !groups.some(group => group.values.includes(value)));
  for (const value of [...unassigned]) {
    if (!value.box || blank(value.text) || value.fieldId === 'pg_field_13') continue;
    const box = value.box;
    const eligible = groups.filter(group => {
      const name = group.name.box!, height = name.bottom - name.top;
      return name.asset === box.asset && name.page === box.page && box.top >= name.bottom - height / 2 && box.bottom - name.top <= height * 7 && box.bottom - box.top <= height * 3 && Math.min(name.right, box.right) - Math.max(name.left, box.left) >= Math.min(name.right - name.left, box.right - box.left) * 0.5;
    });
    if (eligible.length === 1) {eligible[0].values.push(value); unassigned.splice(unassigned.indexOf(value), 1);}
  }
  return {groups, unassigned};
}
