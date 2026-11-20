import { DocumentBundleSchema, DocumentRetrievalResultSchema, DocumentScopeSchema, type DocumentBundle, type DocumentEvidenceChunk, type DocumentRetrievalResult, type DocumentScope } from '@hsbc/contracts/documents';
import { sha256 } from '../../../document/evidence.js';
const unique = <T>(values: T[]) => [...new Set(values)];
export interface SearchEvidenceOptions { scope: DocumentScope; maxChunks?: number; maxCharacters?: number; maxDependencyDepth?: number; requiredChunkIds?: string[] }
export function searchTerms(text: string): string[] {
  const normalized = text.normalize('NFKC').toLocaleLowerCase();
  const latin = normalized.match(/[\p{L}\p{N}]+(?:[._-][\p{L}\p{N}]+)*/gu) ?? [];
  const cjk: string[] = [];
  for (const run of normalized.match(/[\p{Script=Han}]+/gu) ?? []) {
    const points = [...run]; if (points.length === 1) cjk.push(run);
    for (let i = 0; i + 1 < points.length; i++) cjk.push(points[i]! + points[i + 1]!);
  }
  return unique([...latin, ...cjk]);
}
function validate(bundle: DocumentBundle, options: SearchEvidenceOptions) {
  DocumentBundleSchema.parse(bundle);
  if (JSON.stringify(DocumentScopeSchema.parse(bundle.scope)) !== JSON.stringify(DocumentScopeSchema.parse(options.scope))) throw new Error('p2_search_scope_mismatch');
  if (bundle.indexManifest.status === 'stale' || bundle.indexManifest.status === 'failed') throw new Error('p2_index_not_ready');
  if (bundle.indexManifest.directoryRevision !== bundle.directoryRevision || JSON.stringify(bundle.indexManifest.scope) !== JSON.stringify(bundle.scope)) throw new Error('p2_index_scope_mismatch');
  if (bundle.chunks.some(chunk => chunk.documentVersionId !== bundle.scope.documentVersionId || chunk.parseRevision !== bundle.scope.parseRevision || !bundle.indexManifest.chunkIds.includes(chunk.id) || sha256(chunk.text) !== chunk.textSha256) || new Set(bundle.chunks.map(chunk => chunk.id)).size !== bundle.chunks.length || bundle.indexManifest.chunkIds.length !== bundle.chunks.length) throw new Error('p2_chunk_scope_mismatch');
  const maxChunks = options.maxChunks ?? 16, maxCharacters = options.maxCharacters ?? 24000, maxDependencyDepth = options.maxDependencyDepth ?? 8;
  if (!Number.isInteger(maxChunks) || maxChunks < 1 || maxChunks > 256 || !Number.isInteger(maxCharacters) || maxCharacters < 1 || maxCharacters > 200000 || !Number.isInteger(maxDependencyDepth) || maxDependencyDepth < 0 || maxDependencyDepth > 32) throw new Error('p2_search_budget_invalid');
  return { maxChunks, maxCharacters, maxDependencyDepth };
}
function rankedLexical(bundle: DocumentBundle, query: string) {
  const terms = searchTerms(query), corpus = bundle.chunks.filter(chunk => chunk.text.length > 0);
  const frequencies = new Map(terms.map(term => [term, corpus.filter(chunk => searchTerms(chunk.text).includes(term)).length]));
  return corpus.map(chunk => {
    const words = searchTerms(chunk.text), tokenSet = new Set(words);
    const score = terms.reduce((score, term) => score + (tokenSet.has(term) ? Math.log(1 + (corpus.length + 1) / ((frequencies.get(term) ?? 0) + 1)) : 0), 0) / Math.sqrt(1 + words.length / 100);
    return { chunk, score, reason: 'lexical' as const };
  }).filter(entry => entry.score > 0).sort((a, b) => b.score - a.score || a.chunk.id.localeCompare(b.chunk.id));
}
function expand(bundle: DocumentBundle, query: string, options: SearchEvidenceOptions, candidates: DocumentRetrievalResult['matches']): DocumentRetrievalResult {
  const budget = validate(bundle, options), byId = new Map(bundle.chunks.map(chunk => [chunk.id, chunk]));
  const included = new Map<string, DocumentRetrievalResult['matches'][number]>(), unresolved = new Set<string>(), gaps = new Set(bundle.indexManifest.coverageGaps);
  const processedDepth = new Map<string, number>(); let characters = 0;
  const visit = (id: string, depth: number, score: number, reason: DocumentRetrievalResult['matches'][number]['reason']) => {
    if ((processedDepth.get(id) ?? Infinity) <= depth) return;
    const chunk = byId.get(id);
    if (!chunk) { unresolved.add(id); gaps.add('required_dependency_missing'); return; }
    if (depth > budget.maxDependencyDepth) { unresolved.add(id); gaps.add('dependency_depth_budget_exhausted'); return; }
    if (!included.has(id) && (included.size >= budget.maxChunks || characters + chunk.text.length > budget.maxCharacters)) { unresolved.add(id); gaps.add('evidence_context_budget_exhausted'); return; }
    processedDepth.set(id, depth);
    if (!included.has(id)) { included.set(id, { chunk, score, reason }); characters += chunk.text.length; }
    chunk.coverageGaps.forEach(gap => gaps.add(gap));
    chunk.unresolvedReferences.forEach(reference => { unresolved.add(reference); gaps.add('required_reference_unresolved'); });
    // Required dependencies are traversed before another top-k candidate. Cycles are valid
    // document references and terminate via the visited map, not an execution-DAG error.
    for (const dependency of chunk.dependencyIds) visit(dependency, depth + 1, 0, 'mandatory_dependency');
  };
  for (const id of options.requiredChunkIds ?? []) visit(id, 0, 0, 'mandatory_dependency');
  for (const candidate of candidates) {
    if (included.size >= budget.maxChunks) break;
    visit(candidate.chunk.id, 0, candidate.score, candidate.reason);
  }
  return DocumentRetrievalResultSchema.parse({ schema_version: 'p2.v1', indexManifestId: bundle.indexManifest.id, indexVersion: bundle.indexManifest.indexVersion, querySha256: sha256(query), matches: [...included.values()], coverageGaps: [...gaps], unresolvedDependencies: [...unresolved],
    status: included.size === 0 ? 'no_match' : gaps.size || unresolved.size ? 'partial' : 'complete_for_declared_scope', searchedPageNumbers: bundle.indexManifest.indexedPageNumbers,
    budget: { ...budget, usedCharacters: characters }, absenceProven: false });
}
export function searchEvidence(bundle: DocumentBundle, query: string, options: SearchEvidenceOptions): DocumentRetrievalResult {
  validate(bundle, options);
  if (!query.trim() || [...query].length > 2000) throw new Error('p2_search_query_invalid');
  return expand(bundle, query, options, rankedLexical(bundle, query));
}
/** PG/FTS candidates have already been filtered by the caller's current authorization.
 * This second boundary verifies the exact manifest and expands mandatory dependencies. */
export function searchEvidenceFromCandidates(bundle: DocumentBundle, query: string, options: SearchEvidenceOptions, rankedChunkIds: string[]): DocumentRetrievalResult {
  validate(bundle, options);
  if (!query.trim() || [...query].length > 2000 || rankedChunkIds.length > 2000 || new Set(rankedChunkIds).size !== rankedChunkIds.length) throw new Error('p2_search_query_invalid');
  const candidates = rankedChunkIds.map((id, index) => {
    const chunk = bundle.chunks.find(chunk => chunk.id === id); if (!chunk) throw new Error('p2_candidate_scope_mismatch');
    return { chunk, score: 1 / (index + 1), reason: 'lexical' as const };
  });
  return expand(bundle, query, options, candidates);
}
export interface DocumentEmbeddingAdapter { id: string; version: string; simulated: boolean; embed(texts: string[], signal?: AbortSignal): Promise<number[][]> }
export interface DocumentRerankerAdapter { id: string; version: string; simulated: boolean; rerank(query: string, candidates: Array<{ id: string; text: string }>, signal?: AbortSignal): Promise<Array<{ id: string; score: number }>> }
export interface DocumentHybridOptions extends SearchEvidenceOptions { embedding: DocumentEmbeddingAdapter; reranker?: DocumentRerankerAdapter; signal?: AbortSignal; authorizedEnvironment: true }
function cosine(a: number[], b: number[]) {
  if (!a.length || a.length !== b.length || !a.every(Number.isFinite) || !b.every(Number.isFinite)) throw new Error('p2_embedding_shape_invalid');
  const norm = (value: number[]) => Math.sqrt(value.reduce((sum, item) => sum + item * item, 0));
  const denominator = norm(a) * norm(b); if (!denominator) return 0;
  return a.reduce((sum, value, index) => sum + value * b[index]!, 0) / denominator;
}
/** Adapter-only integration point. No vendor/network/credential selection occurs in this engine. */
export async function searchEvidenceHybrid(bundle: DocumentBundle, query: string, options: DocumentHybridOptions): Promise<DocumentRetrievalResult> {
  validate(bundle, options);
  if (options.authorizedEnvironment !== true) throw new Error('p2_embedding_environment_not_authorized');
  if (!query.trim() || [...query].length > 2000) throw new Error('p2_search_query_invalid');
  const chunks = bundle.chunks.filter(chunk => chunk.text), vectors: number[][] = [];
  if (chunks.length > 2000 || chunks.some(chunk => Buffer.byteLength(chunk.text) > 32000)) throw new Error('p2_embedding_batch_budget_exceeded');
  options.signal?.throwIfAborted();
  const queryVector = await options.embedding.embed([query], options.signal); if (queryVector.length !== 1) throw new Error('p2_embedding_shape_invalid');
  for (let start = 0; start < chunks.length; start += 16) {
    options.signal?.throwIfAborted();
    const batch = chunks.slice(start, start + 16), result = await options.embedding.embed(batch.map(chunk => chunk.text), options.signal);
    if (result.length !== batch.length) throw new Error('p2_embedding_shape_invalid'); vectors.push(...result);
  }
  const dense = chunks.map((chunk, i) => ({ chunk, score: cosine(queryVector[0]!, vectors[i]!), reason: 'dense' as const })).sort((a, b) => b.score - a.score);
  const lexical = rankedLexical(bundle, query), fused = new Map<string, DocumentRetrievalResult['matches'][number]>();
  for (const ranking of [lexical, dense]) for (const [rank, entry] of ranking.entries()) {
    const previous = fused.get(entry.chunk.id); fused.set(entry.chunk.id, { ...entry, score: (previous?.score ?? 0) + 1 / (60 + rank + 1) });
  }
  let candidates = [...fused.values()].sort((a, b) => b.score - a.score).slice(0, 64);
  if (options.reranker) {
    const reranked = await options.reranker.rerank(query, candidates.map(candidate => ({ id: candidate.chunk.id, text: candidate.chunk.text })), options.signal);
    if (new Set(reranked.map(result => result.id)).size !== reranked.length || reranked.some(result => !candidates.some(candidate => candidate.chunk.id === result.id) || !Number.isFinite(result.score))) throw new Error('p2_reranker_response_invalid');
    const scores = new Map(reranked.map(result => [result.id, result.score]));
    // Missing provider rows remain candidates and are never mistaken for verified irrelevance.
    candidates = candidates.map(candidate => ({ ...candidate, score: scores.get(candidate.chunk.id) ?? candidate.score, reason: 'reranked' as const })).sort((a, b) => b.score - a.score);
  }
  const result = expand(bundle, query, options, candidates);
  if (options.embedding.simulated || options.reranker?.simulated) { result.coverageGaps.push('retrieval_uses_simulated_adapter'); result.status = result.matches.length ? 'partial' : 'no_match'; }
  return result;
}
