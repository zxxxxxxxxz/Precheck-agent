import {CaseDraftFieldsSchema, CaseDetailsSchema, emptyCaseDetails, type IntakeField} from '@hsbc/contracts/draft';
import {intakeFieldValue} from '@hsbc/contracts/intake';
import type {DraftRow} from './draft-state.js';

/** Assistant writes use the ordinary draft fields/details, never a second case shape. */
export function editableDraftValues(draft: DraftRow) {
  return {fields: {...draft.fields}, details: {...emptyCaseDetails(), ...draft.details}, guaranteeTypes: [...draft.guarantee_types ?? []]};
}
type Values = ReturnType<typeof editableDraftValues>;
export function draftValue(values: Values, field: IntakeField): unknown {
  if (field === 'guaranteeTypes') return values.guaranteeTypes;
  if (field in values.details) return values.details[field as keyof Values['details']];
  return values.fields[field as keyof Values['fields']];
}
export function setDraftValue(values: Values, field: IntakeField, raw: unknown) {
  const value = intakeFieldValue(field, raw);
  if (field === 'guaranteeTypes') values.guaranteeTypes = value as Values['guaranteeTypes'];
  else if (field in values.details) Object.assign(values.details, {[field]: value});
  else Object.assign(values.fields, {[field]: value});
  CaseDraftFieldsSchema.parse(values.fields);
  CaseDetailsSchema.parse(values.details);
}
