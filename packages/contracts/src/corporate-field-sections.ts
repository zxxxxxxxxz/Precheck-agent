/** Workbook rows 51 and 56 name sections, not extractable values. Keep the
 * original workbook data and historical observations intact. */
export const CORPORATE_CHANGE_SECTIONS = [
  {id: 'cgt_field_51', label: '公司秘书/董事的停任', fieldIds: ['cgt_field_52', 'cgt_field_53', 'cgt_field_54', 'cgt_field_55']},
  {id: 'cgt_field_56', label: '委任公司秘书/董事', fieldIds: ['cgt_field_57', 'cgt_field_58', 'cgt_field_59']},
] as const;

export function isCorporateSectionHeading(fieldId: string): boolean {
  return CORPORATE_CHANGE_SECTIONS.some(section => section.id === fieldId);
}

export function corporateFieldSection(fieldId: string) {
  return CORPORATE_CHANGE_SECTIONS.find(section => (section.fieldIds as readonly string[]).includes(fieldId));
}
