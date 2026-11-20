import type {DocumentFieldObservation} from '@hsbc/contracts/documents';
import type {DocumentFieldPresentation} from '@hsbc/contracts/document-presentation';
import {fieldDisplayText} from '@hsbc/contracts/document-presentation';

// These are review inputs, not rows in SRC-CGT/提取信息!C24:G31.
const reviewInputs = new Set(['cgt_authorization_date', 'cgt_authorization_reference_date', 'cgt_meeting_date', 'cgt_resolution_signer_count', 'cgt_resolution_kind']);
export function resolutionFieldLayout(fields: DocumentFieldPresentation[]) {
  return fields.filter(field => !reviewInputs.has(field.fieldId)).map(field => field.fieldId === 'cgt_field_31'
    ? {...field, fieldLabel: '授权签字样式'} : field);
}

export interface AuthorizationParagraph {text: string; anchorIds: string[]; pageNumbers: number[]}
/** Reading-only context. Names and immutable candidates remain available to the
 * review workflow; a paragraph is never substituted for an adoptable person. */
export function resolutionAuthorizationParagraphs(field: DocumentFieldObservation): AuthorizationParagraph[] {
  if (field.fieldId !== 'cgt_field_29' || field.humanRevisionId) return [];
  const paragraphs: AuthorizationParagraph[] = [];
  for (const candidate of field.candidates) {
    const sources = candidate.evidenceSegments?.length ? candidate.evidenceSegments : [candidate];
    for (const source of sources) {
      const context = source.contextText?.trim() || source.rawValue;
      const text = fieldDisplayText(context);
      const anchorIds = [...new Set(source.contextText?.trim() ? source.contextAnchorIds ?? [] : source.anchorIds)];
      // A name or table row alone cannot stand in for the authorization clause.
      const authorization = /\b(?:authori[sz](?:ed|ation|e)|empowered)\b[\s\S]*\b(?:sign|execute|execution|deliver)\b|(?:授[权權]|獲授權|获授权)[\s\S]*(?:[签簽][署字]|[订訂]立)/iu.test(text);
      if (!authorization || !anchorIds.length || /<table\b/iu.test(context)) continue;
      const existing = paragraphs.find(paragraph => paragraph.text === text && paragraph.anchorIds.some(id => anchorIds.includes(id)));
      if (existing) {
        existing.anchorIds = [...new Set([...existing.anchorIds, ...anchorIds])];
        existing.pageNumbers = [...new Set([...existing.pageNumbers, ...source.pageNumbers])];
      } else paragraphs.push({text, anchorIds, pageNumbers: [...source.pageNumbers]});
    }
  }
  return paragraphs;
}
