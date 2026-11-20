import {fieldDisplayText, type DocumentFieldPresentation, type FieldTableRecord} from '@hsbc/contracts/document-presentation';

// Ignore table layout and typographic separators, but keep word/number boundaries
// and signs: 18/F must not compare equal to 118/F, nor 10–11 to 1011.
function comparisonText(value: string): string {
  return (fieldDisplayText(value).normalize('NFKC').toLowerCase().replace(/[‐‑‒–—−]/gu, '-')
    .match(/[\p{L}\p{N}]+|[^\s,;:|，；：]/gu) ?? []).join('\u0000');
}

const labels = {date: ['Date', '日期', '会议日期'], time: ['Time', '时间', '会议时间'], place: ['Place', '地点', '会议地点']};
type Part = {value: string; labels: string[]};

function sequences(parts: Part[]): Part[][] {
  return parts.flatMap((part, index) => [[part], ...sequences(parts.filter((_, i) => i !== index)).map(rest => [part, ...rest])]);
}

function repeatedForms(record: FieldTableRecord): Set<string> {
  const parts = record.components.flatMap(component => component.role in labels && component.value.trim()
    ? [{value: component.value, labels: labels[component.role as keyof typeof labels]}] : []);
  const forms = new Set<string>();
  for (const sequence of sequences(parts)) {
    forms.add(comparisonText(sequence.map(part => part.value).join(' ')));
    // Source tables may flatten into a header row followed by the data row,
    // or into labelled cells. Only complete components from this one row count.
    const addLabels = (index: number, chosen: string[]) => {
      if (index < sequence.length) {
        for (const label of sequence[index]!.labels) addLabels(index + 1, [...chosen, label]);
      } else {
        forms.add(comparisonText([...chosen, ...sequence.map(part => part.value)].join(' ')));
        forms.add(comparisonText(sequence.map((part, i) => `${chosen[i]} ${part.value}`).join(' ')));
      }
    };
    addLabels(0, []);
  }
  return forms;
}

/** Reading-only deduplication before date/place are split; persisted evidence stays intact. */
export function meetingOtherCandidateIndexes(field: DocumentFieldPresentation): number[] {
  const projection = field.tableRecords;
  if (!projection || field.humanRevisionId) return projection?.otherCandidateIndexes ?? [];
  const records = projection.records.filter(record => record.kind === 'meeting').map(repeatedForms);
  return projection.otherCandidateIndexes.filter(index => {
    const candidate = field.candidates[index];
    if (!candidate || candidate.structuredValue || (candidate.evidenceSegments?.length ?? 0) > 1) return true;
    const value = comparisonText(candidate.rawValue);
    // A display override must not conceal a conflicting source quotation.
    return !value || !records.some(forms => forms.has(value) &&
      (candidate.displayValue === undefined || forms.has(comparisonText(candidate.displayValue))));
  });
}
