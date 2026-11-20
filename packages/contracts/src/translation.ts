import { z } from 'zod';

const id = z.string().min(1);
const hash = z.string().regex(/^[a-f0-9]{64}$/);
export const TranslationSourceSchema = z.strictObject({
  segment_id: id, source_text: z.string().min(1), source_sha256: hash, anchor_ids: z.array(id).min(1),
});
export const TranslationJobSchema = z.strictObject({
  schema_version: z.literal('p0.v1'), job_id: id, case_id: id, snapshot_id: id,
  document_version_id: id, parse_revision: id, evidence_package_id: id,
  purpose: z.literal('business_clause_translation'), source_language: id, target_language: id,
  targets: z.array(TranslationSourceSchema).min(1),
  context_dependencies: z.array(z.strictObject({ source_id: id, sha256: hash })),
  coverage_gaps: z.array(z.string()), input_package_sha256: hash,
  redaction_version: id, glossary_version: id, prompt_version: id, model_profile_version: id,
  generation_state: z.enum(['pending', 'running', 'ready', 'failed']), blocked_reason: z.string().nullable(),
});
export const TranslationArtifactSchema = z.strictObject({
  translation_id: id, revision: z.number().int().positive(), job: TranslationJobSchema,
  validity: z.enum(['current', 'stale', 'superseded']), review_state: z.enum(['unreviewed', 'needs_review', 'checked']),
  translations: z.array(z.strictObject({ segment_id: id, translated_text: z.string().min(1), source_anchor_ids: z.array(id).min(1) })),
  checks: z.array(z.strictObject({ kind: z.enum(['structure', 'numbers', 'references', 'placeholders', 'terminology']), passed: z.boolean(), reason: z.string().nullable() })),
  actual_provider: id.nullable(), actual_model: id.nullable(), call_record_id: id.nullable(),
  human_revision: z.strictObject({ person_id: id, at: z.iso.datetime(), reason: z.string().min(1) }).nullable(),
}).superRefine((artifact, ctx) => {
  if (artifact.job.generation_state === 'ready') {
    const expected = artifact.job.targets.map(t => t.segment_id).sort();
    const actual = artifact.translations.map(t => t.segment_id).sort();
    if (new Set(expected).size !== expected.length || JSON.stringify(expected) !== JSON.stringify(actual))
      ctx.addIssue({ code: 'custom', message: 'Ready translation must contain every target exactly once' });
    for (const translated of artifact.translations) {
      const source = artifact.job.targets.find(target => target.segment_id === translated.segment_id);
      if (!source || JSON.stringify([...source.anchor_ids].sort()) !== JSON.stringify([...translated.source_anchor_ids].sort()))
        ctx.addIssue({ code: 'custom', message: 'Translation anchor references must match its target source' });
    }
    const required = ['structure', 'numbers', 'references', 'placeholders', 'terminology'];
    if (required.some(kind => !artifact.checks.some(c => c.kind === kind && c.passed)) || artifact.checks.some(c => !c.passed))
      ctx.addIssue({ code: 'custom', message: 'Ready requires all programmatic checks to pass' });
    if (artifact.job.blocked_reason || artifact.job.coverage_gaps.length)
      ctx.addIssue({ code: 'custom', message: 'Blocked or incomplete source cannot be ready' });
  }
});
export type TranslationJob = z.infer<typeof TranslationJobSchema>;
export type TranslationArtifact = z.infer<typeof TranslationArtifactSchema>;
