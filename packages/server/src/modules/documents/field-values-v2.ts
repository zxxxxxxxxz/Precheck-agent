import type { ReviewFieldDefinition } from '@hsbc/contracts/review-config';
import { fieldValueSpan } from './field-values.js';

/** OCR/native representations can repeat one address with a phone on only one
 * line. Narrow to an existing literal only when every source line independently
 * yields the identical address. Different address lines/words remain untouched.
 * This is boundary cleanup, never a spelling correction or source adjudication. */
export function repeatedAddressValueSpan(raw: string, definition: ReviewFieldDefinition): string {
  if (definition.valueKind !== 'address' || raw.length > 2000) return raw;
  const lines = raw.split(/\r?\n/u).map(value => value.trim()).filter(Boolean);
  if (lines.length < 2 || lines.length > 8) return raw;
  const values = lines.map(value => fieldValueSpan(value, definition));
  const first = values[0];
  return first && first.length >= 4 && values.every(value => value === first) && raw.includes(first) ? first : raw;
}
