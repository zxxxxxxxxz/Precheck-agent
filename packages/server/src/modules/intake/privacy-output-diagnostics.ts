import { IntakeFieldSchema } from '@hsbc/contracts/draft';
import { z } from 'zod';
import { ModelExecutionError } from '../../model/gateway.js';
import { completePrivacyMatch, indexedPrivacySource } from './privacy-source.js';
import { isLetterOutputEntity, isSourceWitnessOutputKind, type OutputEntityRejectionShape } from './privacy-output-source.js';

const kind = z.enum(['person', 'organization', 'account', 'identity', 'contact', 'address', 'reference', 'asset', 'secret', 'link']);
const reason = z.enum(['privacy_source_entity', 'privacy_sensitive_pattern', 'privacy_final_entity', 'privacy_ner_unavailable', 'privacy_canonical_mismatch', 'privacy_encoded_input']);
const length = z.enum(['1', '2-3', '4-8', '9-32', '33+']), characterClass = z.enum(['digits', 'letters', 'mixed']);
const collision = z.strictObject({ kind, length, characterClass, firstMatch: z.enum(['whole_token', 'substring']), count: z.number().int().min(1).max(4096) });
const nerRejection = z.strictObject({ kind, length, characterClass,
  reason: z.enum(['unsupported_kind', 'opaque_boundary', 'not_literal_output', 'partial_grapheme', 'public_span_partial',
    'exact_registry_absent', 'wrong_kind', 'canonical_only', 'registry_ineligible', 'inactive_no_retained_alias', 'active_but_uncited', 'internal_inconsistent']),
  publicSpan: z.enum(['none', 'partial', 'complete']),
  literalVisibility: z.enum(['visible_in_cited_literal', 'visible_only_uncited_literal', 'not_visible_literal']), count: z.literal(1),
});
export type PrivacyNerRejection = z.infer<typeof nerRejection>;
/** Private shape-only evidence. Never add values, hashes, references or model IDs. */
const outputValidationShape = { stage: z.enum(['stream_reply', 'final_reply', 'field', 'question']),
  field: IntakeFieldSchema.optional(), reason,
  collisionCount: z.number().int().min(0).max(4096), collisions: z.array(collision).max(300),
};
const outputValidationV1 = z.strictObject({ version: z.literal('privacy-output-validation/1'), ...outputValidationShape }).superRefine((value, ctx) => {
  if ((value.stage === 'field') !== (value.field !== undefined) || value.collisions.reduce((sum, group) => sum + group.count, 0) !== value.collisionCount ||
    (value.reason !== 'privacy_source_entity' && value.collisionCount !== 0)) ctx.addIssue({ code: 'custom', message: 'Invalid private output diagnostic' });
});
const outputValidationV2 = z.strictObject({ version: z.literal('privacy-output-validation/2'), ...outputValidationShape, nerRejection }).superRefine((value, ctx) => {
  if ((value.stage === 'field') !== (value.field !== undefined) || value.reason !== 'privacy_final_entity' ||
    value.collisionCount !== 0 || value.collisions.length !== 0) ctx.addIssue({ code: 'custom', message: 'Invalid private NER output diagnostic' });
});
export const PrivacyOutputValidationSchema = z.union([outputValidationV1, outputValidationV2]);
export type PrivacyOutputValidation = z.infer<typeof PrivacyOutputValidationSchema>;
export type PrivacyOutputContext = Pick<PrivacyOutputValidation, 'stage' | 'field'>;
export class PrivacyOutputValidationError extends ModelExecutionError {
  readonly observation: PrivacyOutputValidation;
  constructor(diagnostic: PrivacyOutputValidation['reason'], context: PrivacyOutputContext, collisions: PrivacyOutputValidation['collisions'] = [], firstNerRejection?: PrivacyNerRejection) {
    super('egress_denied', false, diagnostic);
    this.observation = PrivacyOutputValidationSchema.parse({ version: firstNerRejection ? 'privacy-output-validation/2' : 'privacy-output-validation/1',
      ...(firstNerRejection ? { nerRejection: firstNerRejection } : {}), ...context, reason: diagnostic,
      collisionCount: collisions.reduce((sum, group) => sum + group.count, 0), collisions });
  }
}
export function outputValidationReason(value: unknown) { return reason.safeParse(value); }

const canonical = (text: string) => text.normalize('NFKC').toLocaleLowerCase('en-US');
const MAX_OUTPUT_COLLISION_MATCHES = 100_000;
type RegistryEntry = { original: string; kind: z.infer<typeof kind> };
const outputWords = new Intl.Segmenter('und', { granularity: 'word' });

/** The first already-rejected NER entity only. This never participates in admission. */
export function describeOutputNerRejection(entity: { text: string; kind: z.infer<typeof kind> }, shape: OutputEntityRejectionShape,
  registry: readonly (RegistryEntry & { placeholder: string })[], activeAliases: ReadonlySet<string>, citedAliases: ReadonlySet<string>,
  literalVisibility: PrivacyNerRejection['literalVisibility']): PrivacyNerRejection {
  let rejected: PrivacyNerRejection['reason'];
  if (!isSourceWitnessOutputKind(entity.kind)) rejected = 'unsupported_kind';
  else if (shape.opaqueBoundary) rejected = 'opaque_boundary';
  else if (!shape.literalFound) rejected = 'not_literal_output';
  else if (shape.partialGrapheme) rejected = 'partial_grapheme';
  else if (shape.publicSpan === 'partial') rejected = 'public_span_partial';
  else {
    const exact = registry.filter(value => value.original === entity.text), sameKind = exact.filter(value => value.kind === entity.kind);
    if (!sameKind.length) rejected = exact.length ? 'wrong_kind' : registry.some(value => value.kind === entity.kind && canonical(value.original) === canonical(entity.text)) ? 'canonical_only' : 'exact_registry_absent';
    else {
      const eligible = sameKind.filter(isLetterOutputEntity), active = eligible.filter(value => activeAliases.has(value.placeholder));
      rejected = !eligible.length ? 'registry_ineligible' : !active.length ? 'inactive_no_retained_alias' :
        !active.some(value => citedAliases.has(value.placeholder)) ? 'active_but_uncited' : 'internal_inconsistent';
    }
  }
  const size = Array.from(entity.text).length;
  return nerRejection.parse({ kind: entity.kind, length: size === 1 ? '1' : size <= 3 ? '2-3' : size <= 8 ? '4-8' : size <= 32 ? '9-32' : '33+',
    characterClass: /^\p{Nd}+$/u.test(entity.text) ? 'digits' : /^[\p{L}\p{M}]+$/u.test(entity.text) ? 'letters' : 'mixed',
    reason: rejected, publicSpan: shape.publicSpan, literalVisibility, count: 1 });
}
/** Private inbound registry gate. Deferred entities still undergo full NER/source checks. */
export function analyzeOutputCollisions(clean: string, replacements: readonly RegistryEntry[]) {
  if (replacements.length > 4096) throw new ModelExecutionError('input_budget_exhausted');
  const value = canonical(clean), indexed = indexedPrivacySource(clean, false, { removeWhitespace: false });
  const exactNormalization = indexed.normalized === value;
  // A short reference is not the identity of every longer number containing it.
  // Only complete numeric words qualify (never an alphanumeric identifier or a
  // split/zero-padded spelling). This is inbound-only; NER still checks the full
  // reply, and outbound source removal retains its strict substring checks.
  const numericWords = [...outputWords.segment(value)].filter(part => /^[0-9]+$/u.test(part.segment));
  const groups = new Map<string, PrivacyOutputValidation['collisions'][number]>();
  let deferredOccurrences = 0, blockingOccurrences = 0, matches = 0;
  for (const replacement of replacements) {
    const needle = canonical(replacement.original);
    if (!needle) throw new ModelExecutionError('invalid_output');
    const eligible = isLetterOutputEntity(replacement);
    const numericReference = replacement.kind === 'reference' && /^[0-9]{2,3}$/u.test(needle);
    let wordIndex = 0;
    let firstBlocking: 'whole_token' | 'substring' | undefined, at = 0;
    while ((at = value.indexOf(needle, at)) !== -1) {
      if (++matches > MAX_OUTPUT_COLLISION_MATCHES) throw new ModelExecutionError('input_budget_exhausted');
      const end = at + needle.length;
      const complete = exactNormalization && completePrivacyMatch(indexed, at, needle.length);
      while (wordIndex < numericWords.length && numericWords[wordIndex].index + numericWords[wordIndex].segment.length <= at) wordIndex++;
      const word = numericWords[wordIndex];
      const differentNumber = numericReference && word && word.index <= at && word.index + word.segment.length >= end &&
        word.segment.length > needle.length && word.segment.replace(/^0+/u, '') !== needle.replace(/^0+/u, '');
      // Registry spelling alone does not establish an entity in private prose.
      // Partial graphemes/normalization remain fail closed; all other kinds and
      // digit/mixed values retain strict behavior except a different numeric word.
      if ((eligible || differentNumber) && complete) deferredOccurrences++;
      else {
        blockingOccurrences++;
        if (!firstBlocking) {
          const left = Array.from(value.slice(0, at)).at(-1) ?? '', right = Array.from(value.slice(end))[0] ?? '';
          firstBlocking = /[\p{L}\p{M}\p{N}_]/u.test(left + right) ? 'substring' : 'whole_token';
        }
      }
      at++; // Includes overlapping occurrences; a later incomplete match still blocks.
    }
    if (!firstBlocking) continue;
    const size = Array.from(needle).length;
    const group = { kind: replacement.kind, length: size === 1 ? '1' : size <= 3 ? '2-3' : size <= 8 ? '4-8' : size <= 32 ? '9-32' : '33+',
      characterClass: /^\p{Nd}+$/u.test(needle) ? 'digits' : /^[\p{L}\p{M}]+$/u.test(needle) ? 'letters' : 'mixed',
      firstMatch: firstBlocking, count: 1 } as PrivacyOutputValidation['collisions'][number];
    const key = JSON.stringify([group.kind, group.length, group.characterClass, group.firstMatch]), existing = groups.get(key);
    if (existing) existing.count++; else groups.set(key, group);
  }
  // These internal counts contain no values/offsets. The persisted /1 shape
  // remains registry-entry counts, restricted to actual blocking entries.
  return { matchedOccurrences: matches, deferredOccurrences, blockingOccurrences, collisions: [...groups.values()] };
}
/** Counts blocking registry entries; firstMatch describes the first blocking occurrence. */
export function summarizeOutputCollisions(clean: string, replacements: readonly RegistryEntry[]): PrivacyOutputValidation['collisions'] {
  return analyzeOutputCollisions(clean, replacements).collisions;
}
