import type { ReviewFieldDefinition } from '@hsbc/contracts/review-config';
import { normalizeExtractedValue } from './field-values.js';

const date = /^\d{4}[ \t]*年[ \t]*\d{1,2}[ \t]*月[ \t]*\d{1,2}[ \t]*日$/u;

/** Retain an explicit clock boundary beside an already grounded date. This
 * only widens within the same literal context: no other row, page or occurrence
 * can supply a missing time, and a date remains the normalized business value.
 */
export function preserveExplicitDateTime(value: string, context: string, definition: ReviewFieldDefinition): string {
  if (definition.type !== 'date' || !date.test(value) || !normalizeExtractedValue(value, 'date')) return value;
  const at = context.indexOf(value);
  if (at < 0 || at !== context.lastIndexOf(value)) return value;
  const tail = context.slice(at + value.length);
  const clock = /^[ \t]*(?:[01]\d|2[0-4]|\d)[ \t]*[时時](?![ \t]*(?:\d|[分秒]))/u.exec(tail);
  if (!clock) return value;
  return value + clock[0];
}
