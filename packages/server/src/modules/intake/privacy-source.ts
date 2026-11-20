import { ModelExecutionError } from '../../model/gateway.js';

/** Lookup options never authorize rewritten output: every result is an original slice. */
export interface SourceAlignmentOptions { foldCase?: boolean; removeWhitespace?: boolean; includeAllFormattingVariants?: boolean; }

const sourceSegments = new Intl.Segmenter('und', { granularity: 'grapheme' });
export function indexedPrivacySource(text: string, withoutPunctuation = false, options: SourceAlignmentOptions = {}) {
  let normalized = ''; const starts: number[] = [], ends: number[] = [];
  for (const part of sourceSegments.segment(text)) {
    let normal = part.segment.normalize('NFKC');
    if (options.foldCase !== false) normal = normal.toLocaleLowerCase('en-US');
    if (options.removeWhitespace !== false) normal = normal.replace(/\p{White_Space}/gu, '');
    const converted = withoutPunctuation ? normal.replace(/\p{P}/gu, '') : normal;
    for (let i = 0; i < converted.length; i++) { starts.push(part.index); ends.push(part.index + part.segment.length); }
    normalized += converted;
  }
  return { normalized, starts, ends };
}
type IndexedPrivacySource = ReturnType<typeof indexedPrivacySource>;
export function completePrivacyMatch(source: IndexedPrivacySource, at: number, length: number) {
  const end = at + length - 1;
  return length > 0 && (at === 0 || source.starts[at] !== source.starts[at - 1]) &&
    (end + 1 === source.ends.length || source.ends[end] !== source.ends[end + 1]);
}
export function alignPrivacyEntities<T extends { text: string; kind: string }>(blocks: readonly { text: string }[], entities: T[],
  sources: Array<{ text: string } & IndexedPrivacySource> | undefined = undefined, options: SourceAlignmentOptions = {}): T[] {
  sources ??= blocks.map(block => ({ text: block.text, ...indexedPrivacySource(block.text, false, options) }));
  const aligned: T[] = [], seen = new Set<string>();
  const add = (entity: T) => {
    const key = JSON.stringify([entity.kind, entity.text]);
    if (seen.has(key)) return;
    if (aligned.length >= 512) throw new ModelExecutionError('invalid_output', false, 'local_output_schema');
    seen.add(key); aligned.push(entity);
  };
  if (entities.length > 512) throw new ModelExecutionError('invalid_output', false, 'local_output_schema');
  for (const entity of entities) {
    if (!entity.text || entity.text.length > 2000) throw new ModelExecutionError('invalid_output', false, 'local_output_schema');
    if (blocks.some(block => block.text.includes(entity.text))) { add(entity); if(!options.includeAllFormattingVariants)continue; }
    // Formatting alignment is only a lookup: the mapping always stores an exact
    // original slice, never the model's rewritten spelling or whitespace.
    const needle = indexedPrivacySource(entity.text, false, options).normalized;
    if (!needle) throw new ModelExecutionError('invalid_output', false, 'local_output_source');
    const originals = new Set<string>();
    for (const source of sources) {
      let at = 0;
      while ((at = source.normalized.indexOf(needle, at)) !== -1) {
        const end = at + needle.length - 1;
        if (completePrivacyMatch(source, at, needle.length)) {
          const original = source.text.slice(source.starts[at], source.ends[end]);
          if (indexedPrivacySource(original, false, options).normalized === needle) {
            if (original.length > 2000) throw new ModelExecutionError('invalid_output', false, 'local_output_source');
            originals.add(original);
          }
        }
        at++;
      }
    }
    if (!originals.size) throw new ModelExecutionError('invalid_output', false, 'local_output_source');
    // Protect every grounded formatting variant instead of choosing one. The
    // projection retains its existing canonical identity/restoration semantics.
    for (const original of originals) add({ ...entity, text: original });
  }
  return aligned;
}
/**
 * GLiNER2 2.1.0 appends one ASCII period when a request does not end in .!?.
 * Its decoded span may include that synthetic character. Recover only an exact
 * request suffix; this is not a punctuation-normalization or fuzzy-match rule.
 */
export function restoreNerTerminalSourceSuffix<T extends { text: string }>(request: string, entities: T[]): T[] {
  if (/[.!?]$/u.test(request)) return entities;
  return entities.flatMap(entity => {
    if (!entity.text.endsWith('.') || entity.text.length <= 1) return [entity];
    const original = entity.text.slice(0, -1);
    if (!request.endsWith(original)) return [entity];
    const restored = { ...entity, text: request.slice(request.length - original.length) };
    // A real punctuated occurrence may coexist with the synthetic terminal one.
    // Preserve both grounded variants, so neither occurrence loses protection.
    return request.includes(entity.text) ? [entity, restored] : [restored];
  });
}
