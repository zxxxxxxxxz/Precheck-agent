import {fieldReviewStatus} from '@hsbc/contracts/field-verification';
import type {ChecklistRow} from '@hsbc/contracts/review-checklist';
import {partyDisplayNames, type PartyDisplayCandidate} from './party-display.js';

type Role = 'borrowers' | 'guarantors';
const corporatePartyFields: Record<string, Role> = {
  cgt_field_7: 'borrowers', cgt_field_27: 'borrowers', cgt_field_34: 'borrowers', cgt_facility_borrower: 'borrowers',
  cgt_field_9: 'guarantors', cgt_field_14: 'guarantors', cgt_field_24: 'guarantors', cgt_field_32: 'guarantors', cgt_facility_guarantor: 'guarantors',
};

/** Display only: consume the checklist's validated current/frozen receipts,
 * never infer names from explanations, highlights or an entire quotation. */
export function reviewedPartyNames(rows: ChecklistRow[]) {
  const result: Record<Role, PartyDisplayCandidate[]> = {borrowers: [], guarantors: []};
  for (const row of rows) {
    const role = corporatePartyFields[row.fieldId], review = row.verification;
    if (!role || !review || review.validity !== 'current' || ('origin' in review && review.origin === 'automatic') ||
      review.scope === 'bank_rule' || review.status !== 'confirmed' || fieldReviewStatus(review) !== 'confirmed') continue;
    for (const source of review.sources) {
      const name = source.value.trim();
      if (source.kind !== 'original' || source.comparisonKey === null || !name || name.length > 500 ||
        !source.quote.includes(source.value) || (!source.evidence.anchorId && !source.evidence.sourceNodeId)) continue;
      result[role].push({value: name, choiceKey: row.objectId ? `object:${row.objectId}` : undefined});
    }
  }
  return {borrowers: partyDisplayNames(result.borrowers), guarantors: partyDisplayNames(result.guarantors)};
}
