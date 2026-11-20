import { DocumentTranslationSchema, type DocumentBundle, type DocumentTranslation } from '@hsbc/contracts/documents';
import { sha256 } from '../../../document/evidence.js';
export interface DocumentTranslationClient { version: string; simulated: boolean; translate(input: { sourceText: string; contextText: string; targetLanguage: 'zh'; signal?: AbortSignal }): Promise<string> }
export class SyntheticTranslationClient implements DocumentTranslationClient {
  readonly version = 'p2-explicit-simulation-v1'; readonly simulated = true;
  async translate(input: { sourceText: string }): Promise<string> { return `【模拟翻译，仅验证证据绑定，不代表真实译文】${input.sourceText}`; }
}
export async function translateEvidence(bundle: DocumentBundle, chunkIds: string[], client: DocumentTranslationClient, options: { glossaryVersion: string; promptVersion: string; authorized: boolean; signal?: AbortSignal }): Promise<DocumentTranslation> {
  if (!options.authorized) throw new Error('p2_translation_not_authorized');
  if (!chunkIds.length || new Set(chunkIds).size !== chunkIds.length) throw new Error('p2_translation_target_invalid');
  const chunks = chunkIds.map(id => { const chunk = bundle.chunks.find(chunk => chunk.id === id); if (!chunk || !chunk.anchorIds.length || !chunk.text) throw new Error('p2_translation_source_unavailable'); return chunk; });
  const dependencyIds = new Set<string>(), missing = new Set<string>();
  const visit = (id: string, depth: number) => {
    if (dependencyIds.has(id) || chunkIds.includes(id)) return;
    if (depth > 8 || dependencyIds.size >= 32) { missing.add('translation_context_budget_exhausted'); return; }
    const chunk = bundle.chunks.find(chunk => chunk.id === id); if (!chunk) { missing.add('translation_dependency_missing'); return; }
    dependencyIds.add(id); chunk.dependencyIds.forEach(next => visit(next, depth + 1));
  };
  chunks.forEach(chunk => chunk.dependencyIds.forEach(id => visit(id, 0)));
  const context = bundle.chunks.filter(chunk => dependencyIds.has(chunk.id));
  const coverageGaps = [...new Set([...chunks, ...context].flatMap(chunk => [...chunk.coverageGaps, ...chunk.unresolvedReferences.map(reference => `unresolved_reference:${reference}`)]).concat([...missing]))];
  const sourceText = chunks.map(chunk => chunk.text).join('\n\n'), contextText = context.map(chunk => chunk.text).join('\n\n');
  if (sourceText.length + contextText.length > 32000) coverageGaps.push('translation_character_budget_exhausted');
  const sourceSha256 = sha256(sourceText), contextSha256 = sha256(contextText);
  const base = { schema_version: 'p2.v1' as const, id: `translation:${sha256(JSON.stringify([bundle.scope, chunkIds, sourceSha256, contextSha256, options.glossaryVersion, options.promptVersion, client.version]))}`, scope: bundle.scope, sourceChunkIds: chunkIds, sourceAnchorIds: [...new Set(chunks.flatMap(chunk => chunk.anchorIds))], sourceSha256, contextSha256, glossaryVersion: options.glossaryVersion, promptVersion: options.promptVersion, clientVersion: client.version, sourceText, translatedText: null, simulated: client.simulated, validity: 'current' as const, reviewState: 'unreviewed' as const, checks: [], coverageGaps };
  if (coverageGaps.length) return DocumentTranslationSchema.parse({ ...base, status: 'blocked' });
  try {
    options.signal?.throwIfAborted();
    const translatedText = await client.translate({ sourceText, contextText, targetLanguage: 'zh', signal: options.signal });
    const tokens = (text: string, expression: RegExp) => (text.match(expression) ?? []).sort();
    const numbers = (text: string) => tokens(text, /\d+(?:[.,]\d+)*/gu);
    const placeholders = (text: string) => tokens(text, /\b(?:ENTITY|ASSET|PERSON)_\w+\b/gu);
    const checks = [
      { kind: 'numbers' as const, passed: JSON.stringify(numbers(sourceText)) === JSON.stringify(numbers(translatedText)) },
      { kind: 'placeholders' as const, passed: JSON.stringify(placeholders(sourceText)) === JSON.stringify(placeholders(translatedText)) },
      { kind: 'structure' as const, passed: translatedText.trim().length > 0 && translatedText.length <= 64000 },
    ];
    return DocumentTranslationSchema.parse({ ...base, translatedText, checks, status: checks.every(check => check.passed) ? 'ready' : 'failed', coverageGaps: checks.filter(check => !check.passed).map(check => `translation_${check.kind}_check_failed`) });
  } catch { options.signal?.throwIfAborted(); return DocumentTranslationSchema.parse({ ...base, status: 'failed', coverageGaps: ['translation_provider_failed'] }); }
}
export function translationValidity(translation: DocumentTranslation, bundle: DocumentBundle): 'current' | 'stale' {
  if (JSON.stringify(translation.scope) !== JSON.stringify(bundle.scope)) return 'stale';
  if (translation.sourceAnchorIds.some(id => !bundle.anchors.some(anchor => anchor.anchor_id === id && anchor.document_version_id === bundle.scope.documentVersionId && anchor.parse_revision === bundle.scope.parseRevision))) return 'stale';
  const chunks = translation.sourceChunkIds.map(id => bundle.chunks.find(chunk => chunk.id === id));
  if (chunks.some(chunk => !chunk) || sha256(chunks.map(chunk => chunk!.text).join('\n\n')) !== translation.sourceSha256) return 'stale';
  const contextIds = new Set<string>();
  const visit = (id: string) => { if (contextIds.has(id) || translation.sourceChunkIds.includes(id)) return; contextIds.add(id); bundle.chunks.find(chunk => chunk.id === id)?.dependencyIds.forEach(visit); };
  chunks.forEach(chunk => chunk!.dependencyIds.forEach(visit));
  return sha256(bundle.chunks.filter(chunk => contextIds.has(chunk.id)).map(chunk => chunk.text).join('\n\n')) === translation.contextSha256 ? 'current' : 'stale';
}
