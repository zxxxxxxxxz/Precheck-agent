import {fixedComparisonValue,type ChecklistRow} from '@hsbc/contracts/review-checklist';
import type {ReviewEvidence, ReviewState} from '@hsbc/contracts/review';
import {CORPORATE_DERIVED_FIELDS} from '@hsbc/contracts/corporate-requirements';
import {PERSONAL_DERIVED_FIELDS} from '@hsbc/contracts/personal-requirements';
import {evidenceIdentity} from './evidence-preview.ts';

/** Generated presence checks still execute; the reading desk prefers the business rule text. */
export function fieldBusinessRules(row: ChecklistRow) {
  const business = row.rules.filter(rule => rule.id !== `${row.fieldId}_required`);
  return [...new Map((business.length ? business : row.rules).map(rule => [rule.text.trim(), rule])).values()];
}

export function fieldRuleSummary(text: string) {
  return text.split(/(?<=[。！？])\s*|\n/u).find(line => line.trim())?.trim() ?? text;
}

export function canEditField(fieldId: string) {
  return fieldId !== 'review_business_date' && !([...CORPORATE_DERIVED_FIELDS, ...PERSONAL_DERIVED_FIELDS] as readonly string[]).includes(fieldId);
}

export function uniqueFieldEvidence(evidence: ReviewEvidence[]) {
  return [...new Map(evidence.map(e => [evidenceIdentity(e), e])).values()];
}

export function sameFieldEvidence(left: ReviewEvidence[], right: ReviewEvidence[]) {
  return JSON.stringify([...new Set(left.map(evidenceIdentity))].sort()) === JSON.stringify([...new Set(right.map(evidenceIdentity))].sort());
}

/** The checklist identifies exact source locations but does not carry adoption scope.
 * Callers must separately validate the selected material scope before adopting a candidate. */
export function sameFieldLocations(left: ReviewEvidence[], right: ReviewEvidence[]) {
  const locations = (values: ReviewEvidence[]) => values.map(({materialScope: _scope, ...source}) => source);
  return sameFieldEvidence(locations(left), locations(right));
}

/** Only explicit rule inputs for this exact object are comparison partners.
 * A matching name, role, material title or generic object relationship is not attribution. */
export function comparisonRows(row: ChecklistRow, rows: ChecklistRow[], state: ReviewState) {
  if (!row.objectId) return [];
  const inputIds = new Set(state.configuration?.rules.filter(rule => row.rules.some(r => r.id === rule.id)).flatMap(rule => rule.inputFieldIds) ?? []);
  return rows.filter(other => other.id !== row.id && other.objectId === row.objectId && inputIds.has(other.fieldId)&&fixedComparisonValue(other.fieldId)===undefined);
}

export interface FieldSourceValue {
  id: string;
  label: string;
  value: string | null;
  evidence: ReviewEvidence[];
  documentId?: string;
  origin: 'candidate' | 'fact' | 'unassigned';
  stale: boolean;
  confirmed?: boolean;
  currency?: string;
  unit?: string;
}

export function fieldSourceValues(row: ChecklistRow): FieldSourceValue[] {
  if(fixedComparisonValue(row.fieldId)!==undefined)return [];
  const matchesFact = (candidate: ChecklistRow['candidates'][number]) => row.fact && candidate.value === row.fact.rawValue &&
    sameFieldEvidence(candidate.evidence, row.fact.evidence);
  const candidates: FieldSourceValue[] = row.candidates.map(c => ({...c, label: row.label, origin: 'candidate', stale: false,
    ...(matchesFact(c) ? {confirmed: !row.fact!.automaticAdoption && row.fact!.validity === 'current' && row.fact!.state === 'present' && row.fact!.normalization.status !== 'pending', currency: row.fact!.currency, unit: row.fact!.unit} : {})}));
  // A confirmed value is a separate record, not an extra extraction from its evidence documents.
  if (row.fact && (!row.candidates.some(matchesFact) || row.fact.validity === 'stale')) {
    candidates.push({id: row.fact.factId, label: row.label, value: row.fact.rawValue, evidence: row.fact.evidence,
      origin: 'fact', stale: row.fact.validity === 'stale', currency: row.fact.currency, unit: row.fact.unit});
  }
  if (!row.objectId) candidates.push(...(row.unassignedCandidates ?? []).map(c => ({...c, label: row.label, origin: 'unassigned' as const, stale: false})));
  return candidates;
}

export function fieldComparison(row: ChecklistRow, rows: ChecklistRow[], state: ReviewState, sourceId?: string) {
  const own = fieldSourceValues(row);
  const documents = [...new Set(own.flatMap(value => value.documentId ? [value.documentId] : []))];
  const documentId = documents.includes(sourceId ?? '') ? sourceId : documents[0];
  const primary = own.filter(value => !value.documentId || value.documentId === documentId);
  const alternate = own.filter(value => value.documentId && value.documentId !== documentId);
  const related = comparisonRows(row, rows, state);
  const references = [...alternate, ...related.flatMap(fieldSourceValues)];
  const missing = related.filter(other => !fieldSourceValues(other).length);
  return {documents, documentId, primary, references, missing, related,
    evidence: uniqueFieldEvidence([...own, ...references].flatMap(value => value.evidence))};
}
