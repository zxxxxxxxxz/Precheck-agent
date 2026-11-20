import type {DocumentFieldObservation, DocumentSourceAnchor} from '@hsbc/contracts/documents';
import type {EvidenceAnchor} from '@hsbc/contracts/evidence';
import type {DocumentTranslationTarget, DocumentTranslationView} from '@hsbc/contracts/document-translation';
import {resolutionAuthorizationParagraphs} from '../resolution-field-layout.ts';

export interface FieldTranslationBinding {fieldId: string; groups: string[][]; fingerprint: string}
/** Paragraph reading aid, not a blanket translator for names, identifiers or numeric values. */
export function isEnglishParagraph(value: string): boolean {
  const words = value.match(/[A-Za-z]+(?:['’-][A-Za-z]+)*/g) ?? [];
  const prose = value.trim().length >= 48 && words.length >= 8;
  const shortClause = value.trim().length >= 28 && words.length >= 5 && /\b(shall|must|undertakes?|agrees?|notwithstanding)\b/i.test(value);
  return (prose || shortClause) && words.join('').length >= (value.match(/\p{L}/gu)?.length ?? 0) * 0.6;
}
export function fieldTranslationBinding(field: DocumentFieldObservation): FieldTranslationBinding | undefined {
  if (field.fieldId === 'cgt_field_29' && !field.humanRevisionId) {
    const paragraphs = resolutionAuthorizationParagraphs(field).filter(paragraph => isEnglishParagraph(paragraph.text));
    if (!paragraphs.length) return;
    return {fieldId: field.fieldId, groups: paragraphs.map(paragraph => paragraph.anchorIds), fingerprint: JSON.stringify([field.id, paragraphs])};
  }
  const label = `${field.fieldId} ${field.fieldLabel}`;
  if (!/条款|决议|内容|承诺|义务|条件|clause|resolution|undertaking/i.test(label) && /姓名|名称|地址|编号|号码|金额|币种|日期|比例|借款人|担保人|保证人|受益人|name|address|amount|currency|date|number|borrower|guarantor|beneficiary|(?:^|_)no(?:_|$)/i.test(label)) return;
  const candidates = field.candidates.filter(candidate => isEnglishParagraph(candidate.rawValue));
  const groups = candidates.length ? candidates.flatMap(candidate => candidate.evidenceSegments?.length
    ? candidate.evidenceSegments.map(segment => segment.anchorIds) : [candidate.anchorIds])
    : !field.candidates.length && isEnglishParagraph(field.rawValue ?? '') ? [field.anchorIds] : [];
  if (!groups.length) return;
  // Include values as well as evidence: an edited field must not retain another value's open result.
  return {fieldId: field.fieldId, groups, fingerprint: JSON.stringify([field.id, field.humanRevisionId, field.rawValue, field.candidates, groups])};
}
export function fieldEvidenceMatcher(binding: FieldTranslationBinding, anchors: readonly EvidenceAnchor[], sourceAnchors: readonly DocumentSourceAnchor[]) {
  const evidence = new Map(anchors.map(anchor => [anchor.anchor_id, anchor]));
  const native = new Map(sourceAnchors.map(anchor => [anchor.anchor_id, anchor]));
  const keys = (ids: readonly string[], nodes: readonly string[] = []) => {
    const result = new Set(nodes.map(id => `node:${id}`));
    for (const id of ids) {
      result.add(`anchor:${id}`);
      for (const block of evidence.get(id)?.block_ids ?? []) result.add(`block:${block}`);
      const node = native.get(id)?.sourceNodeId; if (node) result.add(`node:${node}`);
    }
    return result;
  };
  const groups = binding.groups.map(group => keys(group));
  const covers = (target: DocumentTranslationTarget, group: Set<string>) => {
    const targetKeys = keys(target.source.anchorIds, target.source.sourceNodeIds);
    return [...group].some(key => targetKeys.has(key));
  };
  return {
    matches: (target: DocumentTranslationTarget) => groups.some(group => covers(target, group)),
    complete: (targets: readonly DocumentTranslationTarget[]) => groups.every(group => group.size > 0 && targets.some(target => covers(target, group))),
  };
}
export function sameTranslationChunks(view: DocumentTranslationView, ids: readonly string[]) {
  return view.chunkIds.length === ids.length && ids.every(id => view.chunkIds.includes(id));
}
export function fieldTranslationSegments(view: DocumentTranslationView, targets: readonly DocumentTranslationTarget[]) {
  // The backend also checks validity; matching the source hash prevents a stale quote being silently rebound.
  return view.items.filter(segment => targets.some(target => target.chunkId === segment.chunkId && target.sourceSha256 === segment.sourceSha256));
}
