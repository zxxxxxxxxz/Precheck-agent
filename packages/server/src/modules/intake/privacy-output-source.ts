import { ModelExecutionError } from '../../model/gateway.js';

/** Private inbound names only; this does not authorize outbound source text. */
export function isSourceWitnessOutputKind(kind: string) {
  return kind === 'person' || kind === 'organization' || kind === 'address';
}

export function isLetterOutputEntity(value: { kind: string; original: string }) {
  return isSourceWitnessOutputKind(value.kind) &&
    /^[\p{L}\p{M}]+$/u.test(value.original.normalize('NFKC').toLocaleLowerCase('en-US'));
}

const graphemes = new Intl.Segmenter('und', { granularity: 'grapheme' });
// Application-owned UI labels only, never configurable/user text or values.
// Identifier kinds admit only the complete literal label, never its substrings.
const publicLabels = [
  { text: '境外贷款', kinds: ['organization', 'address'], exact: false },
  { text: 'overseas_loan', kinds: ['organization', 'address'], exact: false },
  { text: '司法管辖地', kinds: ['address'], exact: false },
  { text: '公司担保', kinds: ['organization'], exact: false },
  { text: '公司担保类型', kinds: ['organization'], exact: false },
  { text: '客户号', kinds: ['identity'], exact: true },
];
const MAX_OUTPUT_SOURCE_MATCHES = 100_000;

export type OutputEntityRejectionShape = {
  literalFound: boolean; partialGrapheme: boolean; opaqueBoundary: boolean;
  publicSpan: 'none' | 'partial' | 'complete';
};
type OutputEntityOccurrenceResult = { accepted: true } | { accepted: false; rejection: OutputEntityRejectionShape };
/** Same bounded decision, with shape-only evidence from its single lookup. */
export function inspectOutputEntityOccurrences(text: string) {
  const boundaries = new Set<number>([0]);
  for (const part of graphemes.segment(text)) boundaries.add(part.index + part.segment.length);
  let matches = 0;
  const find = (needle: string) => {
    if (!needle || needle.length > 2000 || [...needle].some(character => character.length === 1 && /[\uD800-\uDFFF]/u.test(character))) return [];
    const found: Array<{ start: number; end: number; complete: boolean }> = [];
    let at = 0;
    while ((at = text.indexOf(needle, at)) !== -1) {
      if (++matches > MAX_OUTPUT_SOURCE_MATCHES) throw new ModelExecutionError('input_budget_exhausted');
      const end = at + needle.length;
      found.push({ start: at, end, complete: boundaries.has(at) && boundaries.has(end) });
      at++;
    }
    return found;
  };
  const publicSpans = publicLabels.flatMap(label => find(label.text).filter(span => span.complete)
    .map(span => ({ ...span, label })));
  return (entity: { kind: string; text: string }, sourceWitness: boolean): OutputEntityOccurrenceResult => {
    if (!isSourceWitnessOutputKind(entity.kind) &&
      !publicLabels.some(label => label.exact && label.text === entity.text && label.kinds.includes(entity.kind))) return { accepted: false, rejection: {
      literalFound: false, partialGrapheme: false, opaqueBoundary: entity.text.includes('\uFFFC'), publicSpan: 'none',
    } }; // Unsupported kinds never inspect/consume occurrences, as before.
    const occurrences = find(entity.text);
    // Public labels never establish a person's identity. A detected person
    // always needs the same exact, currently cited alias witness as other names.
    const covered = (span: { start: number; end: number; complete: boolean }) =>
      span.complete && publicSpans.some(publicSpan => publicSpan.label.kinds.includes(entity.kind) &&
        (!publicSpan.label.exact || publicSpan.label.text === entity.text) &&
        publicSpan.start <= span.start && publicSpan.end >= span.end);
    const accepted = occurrences.length > 0 && occurrences.every(span => span.complete &&
      (isSourceWitnessOutputKind(entity.kind) && sourceWitness || covered(span)));
    if (accepted) return { accepted: true };
    const publicCount = occurrences.filter(covered).length;
    return { accepted: false, rejection: { literalFound: occurrences.length > 0,
      partialGrapheme: occurrences.some(span => !span.complete), opaqueBoundary: entity.text.includes('\uFFFC'),
      publicSpan: publicCount === 0 ? 'none' : publicCount === occurrences.length ? 'complete' : 'partial' } };
  };
}

/** Exact literal occurrences only; preserves the original boolean interface. */
export function outputEntityOccurrences(text: string) {
  const inspect = inspectOutputEntityOccurrences(text);
  return (entity: { kind: string; text: string }, sourceWitness: boolean) => inspect(entity, sourceWitness).accepted;
}
