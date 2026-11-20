import type { TranslationArtifact, TranslationJob } from '@hsbc/contracts/translation';
import { sha256 } from './evidence.js';

/** Authorization is checked separately on every read; a fingerprint never grants access. */
export function translationFingerprint(job: TranslationJob): string {
  for (const target of job.targets) if (sha256(target.source_text) !== target.source_sha256) throw new Error('translation_source_hash_mismatch');
  return sha256(JSON.stringify({ schema: job.schema_version, case: job.case_id, purpose: job.purpose,
    snapshot: job.snapshot_id, document: job.document_version_id, parse: job.parse_revision,
    evidence: job.evidence_package_id, sourceLanguage: job.source_language, targetLanguage: job.target_language,
    targets: job.targets, context: job.context_dependencies, coverage: job.coverage_gaps,
    input: job.input_package_sha256, redaction: job.redaction_version, glossary: job.glossary_version,
    prompt: job.prompt_version, model: job.model_profile_version,
  }));
}
export function invalidateTranslation(artifact: TranslationArtifact, currentJob: TranslationJob): TranslationArtifact {
  if (translationFingerprint(artifact.job) === translationFingerprint(currentJob)) return artifact;
  return { ...artifact, validity: 'stale', review_state: 'needs_review' };
}
