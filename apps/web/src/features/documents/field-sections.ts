import {corporateFieldSection, isCorporateSectionHeading} from '@hsbc/contracts/corporate-requirements';

/** Group by field identity, never by candidate order, extracted text or labels. */
export function documentFieldSections<T extends {field: {fieldId: string}}>(rows: readonly T[]) {
  const sections: {key: string; label?: string; rows: T[]}[] = [];
  for (const row of rows) {
    if (isCorporateSectionHeading(row.field.fieldId)) continue;
    const section = corporateFieldSection(row.field.fieldId);
    const key = section?.id ?? 'fields';
    let group = sections.find(group => group.key === key);
    if (!group) {group = {key, label: section?.label, rows: []}; sections.push(group);}
    group.rows.push(row);
  }
  return sections.length ? sections : [{key: 'fields', rows: [] as T[]}];
}
