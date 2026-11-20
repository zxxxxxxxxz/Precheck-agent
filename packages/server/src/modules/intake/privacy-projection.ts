import {hasIntakeFormEvidence} from './form-evidence.js';
import {IntakeFieldSuggestionSchema, intakeFieldValue} from '@hsbc/contracts/intake';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { IntakeAssistantOutputSchema, IntakeReplyBlockSchema, IntakeSourceBlockSchema, INTAKE_V2_SCHEMA,
  type IntakeAssistantOutput, type IntakeReplyBlock, type IntakeSourceBlock } from '@hsbc/contracts/intake';
import { NerClient } from '../../infrastructure/integrations/inference.js';
import type { ServiceConfig } from '../../infrastructure/integrations/http.js';
import { ModelExecutionError, type PreparedModelPayload } from '../../model/gateway.js';
import { alignPrivacyEntities, completePrivacyMatch, indexedPrivacySource, restoreNerTerminalSourceSuffix } from './privacy-source.js';
import { ASSISTANT_CAPACITY_LIMITS, type IntakeConfig } from './config.js';
import { intakeCloudReferences, PRIVACY_COVERAGE_SOURCE_ID } from './intake-source-references.js';
import { PrivacyOutputValidationError, outputValidationReason, summarizeOutputCollisions, describeOutputNerRejection, type PrivacyOutputContext } from './privacy-output-diagnostics.js';
import { isLetterOutputEntity, inspectOutputEntityOccurrences } from './privacy-output-source.js';
import { privacyIdentifierMarkers } from './privacy-identifier-markers.js';
import {PrivacySourceRangeSchema,privacySourceHash,scanNerSourceSpans,type PrivacySourceRange} from './privacy-ner-spans.js';
import {PrivacyMaskFragmentSchema,originalMaskedWord,validMaskFragment,type PrivacyMaskFragment} from './privacy-mask-fragments.js';
import {knownPrivacySource} from './privacy-known-spans.js';
import {createPrivacyNerWindowSource} from './privacy-ner-window.js';
import {genericDocumentTerm,genericLabelTrim,surroundingWords} from './privacy-generic-terms.js';
import { INTAKE_FIELD_NOTICE_ID, IntakeOutputEnvelopeSchema, intakeModelReplyLimit, intakeSuggestedField, recoverableIntakeFieldError, intakeFieldNotice, type IntakeFieldIssue } from './field-validation.js';
export { PRIVACY_COVERAGE_SOURCE_ID } from './intake-source-references.js';

export const PrivacyEntityKindSchema = z.enum(['person', 'organization', 'account', 'identity', 'contact', 'address', 'reference', 'asset', 'secret', 'link']);
export const PrivacyEntitySchema = z.strictObject({ text: z.string().trim().min(1).max(2000), kind: PrivacyEntityKindSchema });
export type PrivacyEntity = z.infer<typeof PrivacyEntitySchema>;
const WithheldReasonSchema = z.enum(['source_validation_failed', 'output_truncated', 'ner_source_validation_failed']);
const PrivacyProposalResultSchema = z.union([
  z.strictObject({ entities: z.array(PrivacyEntitySchema).max(512) }),
  z.strictObject({ withheld: z.strictObject({ reason: WithheldReasonSchema }) }),
]);
export type PrivacyEntityProposalResult = z.infer<typeof PrivacyProposalResultSchema>;
export const PRIVACY_COVERAGE_NOTICE_ID = 'privacy-coverage-notice';
/** Preparation semantics are part of durable request identity, never an in-place migration. */
export const PRIVACY_PREPARE_VERSION = 'intake-redaction-v2';
export const LEGACY_PRIVACY_SPAN_PREPARE_VERSION = 'intake-redaction-v3';
export const LEGACY_PRIVACY_WINDOW_PREPARE_VERSION = 'intake-redaction-v4';
export const LEGACY_FRAGMENT_PREPARE_VERSION = 'intake-redaction-v5';
export const LEGACY_OCCURRENCE_PREPARE_VERSION = 'intake-redaction-v6';
export const PRIVACY_SPAN_PREPARE_VERSION = 'intake-redaction-v7';
/** Source spans with the document vocabulary: role words, form boxes and joining words stay readable, and a label read
 * together with its value is set apart from it. Everything else is prepared exactly as in v7. */
export const PRIVACY_DOCUMENT_TERMS_VERSION = 'intake-redaction-v8';
const scopedPrivacyVersions = [LEGACY_PRIVACY_SPAN_PREPARE_VERSION, LEGACY_PRIVACY_WINDOW_PREPARE_VERSION, LEGACY_FRAGMENT_PREPARE_VERSION, LEGACY_OCCURRENCE_PREPARE_VERSION, PRIVACY_SPAN_PREPARE_VERSION, PRIVACY_DOCUMENT_TERMS_VERSION] as const;
const usesScopedPrivacy = (version:string) => scopedPrivacyVersions.some(value=>value===version);
const usesWholeWordNerWindows = (version:string) => version===LEGACY_PRIVACY_WINDOW_PREPARE_VERSION||version===LEGACY_FRAGMENT_PREPARE_VERSION||version===LEGACY_OCCURRENCE_PREPARE_VERSION||version===PRIVACY_SPAN_PREPARE_VERSION||version===PRIVACY_DOCUMENT_TERMS_VERSION;
const coverageText = (count: number) => `有 ${count} 段附件内容未通过隐私处理，原文未提供，不得推断其内容或用于填表。`;
const ReplacementSchema = z.strictObject({ placeholder: z.string().regex(/^\[\[P_[A-Z]+_[a-f0-9]{20}\]\]$/), original: z.string().min(1).max(2000), kind: PrivacyEntityKindSchema,source:PrivacySourceRangeSchema.optional(),fragmentOf:PrivacyMaskFragmentSchema.optional() });
export const PrivateIntakeProjectionSchema = z.strictObject({
  version: z.literal(INTAKE_V2_SCHEMA), scopeId: z.string().min(1).max(200), sourceManifestHash: z.string().regex(/^[a-f0-9]{64}$/),
  redactionVersion: z.enum(['intake-redaction-v1', PRIVACY_PREPARE_VERSION,...scopedPrivacyVersions]), blocks: z.array(IntakeSourceBlockSchema).min(1).max(256),
  replacements: z.array(ReplacementSchema).max(4096),
  sourceCoverage:z.array(z.strictObject({sourceRef:IntakeSourceBlockSchema.shape.id,sourceSha256:z.string().regex(/^[a-f0-9]{64}$/),
    redactedSha256:z.string().regex(/^[a-f0-9]{64}$/),masks:z.array(z.strictObject({start:z.number().int().nonnegative(),end:z.number().int().positive()}).refine(value=>value.end>value.start)).max(100000)})).max(256).optional(),
  withheldSources: z.array(z.strictObject({ sourceRef: IntakeSourceBlockSchema.shape.id, reason: WithheldReasonSchema })).min(1).max(256).optional(),
}).superRefine((projection, ctx) => {
  const withheld = projection.withheldSources ?? [], ids = new Set(withheld.map(source => source.sourceRef));
  const coverage = projection.blocks.filter(block => block.id === PRIVACY_COVERAGE_SOURCE_ID);
  if (ids.size !== withheld.length || projection.blocks.some(block => ids.has(block.id)) ||
    (withheld.length ? coverage.length !== 1 || coverage[0]?.text !== coverageText(withheld.length) : coverage.length !== 0)) {
    ctx.addIssue({ code: 'custom', message: 'Invalid private coverage manifest' });
  }
  if(!usesScopedPrivacy(projection.redactionVersion)&&(projection.replacements.some(value=>value.source||value.fragmentOf)||projection.sourceCoverage))
    ctx.addIssue({code:'custom',message:'Source-scoped privacy requires its preparation version'});
  if(projection.replacements.some(value=>!validMaskFragment(value,projection.replacements)))
    ctx.addIssue({code:'custom',message:'Invalid masked-word fragment proof'});
});
export type PrivateIntakeProjection = z.infer<typeof PrivateIntakeProjectionSchema>;
/** Application-owned disclosure; never generated or suppressed by the model. */
export function privacyCoverageNotice(raw: PrivateIntakeProjection): IntakeReplyBlock | undefined {
  const projection = PrivateIntakeProjectionSchema.parse(raw), count = projection.withheldSources?.length ?? 0;
  return count ? { id: PRIVACY_COVERAGE_NOTICE_ID,
    text: `有 ${count} 段附件内容未能完成隐私处理，未用于本轮整理或自动填写。本轮仅根据其余材料提供建议，请核对未处理部分及案件信息。`, sourceRefs: [] } : undefined;
}
export interface PrivacyProjectionOptions {
  ner: Pick<NerClient, 'entities'> | ServiceConfig;
  proposeEntities?: (blocks: IntakeSourceBlock[], signal?: AbortSignal, trustedSourceContext?: readonly IntakeSourceBlock[]) => Promise<PrivacyEntityProposalResult>;
  maxSourceBytes?: number; maxCalls?: number;
  /** Trusted deployment labels only, never user-controlled vocabulary. */
  publicVocabulary?: string[];
  /** Program-owned public templates, pinned by digest; never request-supplied. */
  publicTemplateDigests?: Readonly<Record<string,string>>;
  /** Fixed public role labels only; never arbitrary caller-provided exclusions. v2 adds the fixed document vocabulary of
   * `privacy-generic-terms` and requires source spans, under its own preparation version. */
  sourceVocabulary?: 'document_roles_v1'|'document_roles_v2';
  /** Bounded, source-grounded mask refinement; never repeats a paid proposal. */
  maxPrepareRefinementPasses?: number;
  /** Protect the exact original union when NER spans an existing opaque mask. */
  allowGroundedOpaqueUnions?: boolean;
  /** Explicit capability gate; legacy providers and existing projections stay unchanged. */
  nerSourceSpans?:boolean;
}
const hash = (text: string) => createHash('sha256').update(text).digest('hex');
const canonical = (text: string) => text.normalize('NFKC').toLocaleLowerCase('en-US');
type PreparedPrivacyEntity=PrivacyEntity&{source?:PrivacySourceRange;fragmentOf?:PrivacyMaskFragment;native?:boolean};
type NerObservation=PrivacyEntity&{start?:number;end?:number};
const replacementKey=(value:{original:string;source?:PrivacySourceRange})=>value.source?JSON.stringify([value.source,value.original]):canonical(value.original);
const replacementAlias=(scopeId:string,kind:string,original:string,source?:PrivacySourceRange,fragmentOf?:PrivacyMaskFragment)=>
  `[[P_${kind.toUpperCase()}_${hash(source?JSON.stringify([scopeId,kind,source,original,...(fragmentOf?[fragmentOf]:[])]):`${scopeId}:${canonical(original)}`).slice(0,20)}]]`;
// Reject-only: invisible OCR separators must not bypass a known private name.
// This does not infer new entities, change restoration or ignore punctuation.
const whitespaceFold = (text:string) => canonical(text).replace(/[\p{White_Space}\uFEFF\u200B]/gu,'');
// These exact public domain enums are schema vocabulary, never identity evidence.
// This is separate from configurable model labels; longer names remain protected.
const publicDomainEnums = new Set(['境外贷款', 'overseas_loan']);
// Generic role titles carry no party identity. Only a whole proposed entity may
// match this registry; names containing these words retain their full masks.
const documentRoleEnums = new Set([
  'company', 'directors', 'director', 'board of directors', 'company secretary',
  'authorised signatory', 'authorized signatory', 'authorised representative', 'authorized representative',
  '公司', '本公司', '董事', '董事会', '董事會', '公司秘书', '公司秘書', '授权签字人', '授權簽字人',
  'borrower', 'borrowers', 'lender', 'mortgagor', 'chargor', 'pledgor',
  'policyholder', 'insured', 'insurer', 'applicant', 'proposer',
  '借款人', '借款方', '贷款人', '貸款人', '抵押人', '抵押方', '出质人',
  '投保人', '被保险人', '被保險人', '保险人', '保險人', '投保单位', '投保單位',
  '授权人', '授權人', '被授权人', '被授權人', '委托人', '委託人', '受托人', '受託人',
]);
const placeholderPattern = /\[\[P_[A-Z]+_[a-f0-9]{20}\]\]/g;
const MAX_PRIVACY_SPANS_PER_BLOCK = 100_000;
const MAX_PREPARE_VERIFICATION_REQUESTS = 512;
const MAX_PREPARE_REFINEMENT_ENTITIES = 512;
const MAX_PREPARE_REFINEMENT_MATCHES = 100_000;
type SourceRange = { start: number; end: number };
type LiteralRun = { renderedStart: number; renderedEnd: number; originalStart: number; originalEnd: number };
type ProjectionProvenance = { literals: LiteralRun[]; masks: SourceRange[]; opaque: LiteralRun[] };
type SourceSlice = IntakeSourceBlock & SourceRange;
type PreparedProjection = { projection: PrivateIntakeProjection; provenance: Map<string, ProjectionProvenance> };
const sourceGraphemes = new Intl.Segmenter('und', { granularity: 'grapheme' });
const nerLabels = ['person', 'company', 'location', 'account', 'identity number', 'phone number', 'email', 'address', 'contract number', 'asset identifier'];
const kindFor: Record<string, PrivacyEntity['kind']> = { person: 'person', company: 'organization', location: 'address', account: 'account', 'identity number': 'identity', 'phone number': 'contact', email: 'contact', address: 'address', 'contract number': 'reference', 'asset identifier': 'asset' };
const patterns: Array<[PrivacyEntity['kind'], RegExp]> = [
  ['contact', /[\w.+-]+@[\w.-]+\.[a-z]{2,}/giu],
  ['link', /(?:https?:\/\/|www\.|oss:\/\/|file:\/\/)[^\s<>"']+|(?:\/(?:Users|home|var|private|tmp)\/|[a-z]:\\)[^\s<>"']+/giu],
  ['secret', /\b(?:sk-[\w-]{8,}|Bearer\s+[\w.+\/-]{6,}|(?:password|secret|access[_ -]?key|cookie)\s*[:=]\s*[^\s;,]+)/giu],
  ['identity', /\b\d{17}[\dX]\b|\b[A-Z]{1,2}\d{7,9}\b/giu],
  ['contact', /(?:\+\d{1,3}[ -]?)?(?<!\d)1[3-9]\d{9}(?!\d)|\+\d[\d ()-]{7,}\d/gu],
  ['account', /(?<![\p{L}\d])\d(?:[ -]?\d){7,}(?![\p{L}\d])/gu],
  ['reference', /(?:账号|帐号|客户编号|合同编号|参考编号|参考标识|证件号码|身份证号|护照号|account|contract\s*(?:number|no)|reference)\s*[:：#]?\s*([A-Za-z0-9][A-Za-z0-9_./-]{3,})/giu],
];
function deny(diagnostic: 'privacy_sensitive_pattern' | 'privacy_ner_unavailable' | 'privacy_canonical_mismatch' | 'privacy_source_entity' | 'privacy_final_entity' | 'privacy_encoded_input' = 'privacy_sensitive_pattern'): never {
  throw new ModelExecutionError('egress_denied', false, diagnostic);
}
function encoded(text: string) { return /(?:%[a-f\d]{2}){3,}|\\u[\da-f]{4}|data:[^\s]*;base64|[A-Za-z\d+/]{80,}={0,2}/iu.test(text.normalize('NFKC')); }
function indexed(text: string) {
  const value = indexedPrivacySource(text, false, { removeWhitespace: false });
  // Grapheme offsets must represent the same whole-string normalization used
  // by stable aliases. Context-dependent case folding is not guessed.
  if (value.normalized !== canonical(text)) deny('privacy_canonical_mismatch');
  return value;
}
/** Internal occurrence offsets are carried while constructing each exact slice. */
function splitPrivacyBlockRanges(blocks: IntakeSourceBlock[], maxBytes = 2200): SourceSlice[][] {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 800) throw new ModelExecutionError('invalid_output');
  const pieces: SourceSlice[] = [];
  const wire = (block: IntakeSourceBlock): IntakeSourceBlock => ({ id: block.id, text: block.text });
  for (const block of blocks) {
    let active: string[] = [], bytes = 0, start = 0, offset = 0;
    const textBudget = maxBytes - Buffer.byteLength(JSON.stringify({ id: block.id, text: '' })) - 64;
    const encodedBytes = (value: string) => Buffer.byteLength(JSON.stringify(value)) - 2;
    // Keep the existing transport boundaries and atomic placeholder treatment.
    for (const unit of block.text.match(/\[\[P_[A-Z]+_[a-f0-9]{20}\]\]|[\s\S]/gu) ?? []) {
      const size = encodedBytes(unit);
      if (bytes + size > textBudget) {
        pieces.push({ id: block.id, text: active.join(''), start, end: offset });
        const overlap: string[] = []; let overlapBytes = 0;
        for (const previous of active.slice(-80).reverse()) { const cost = encodedBytes(previous); if (overlapBytes + cost > 320) break; overlap.unshift(previous); overlapBytes += cost; }
        active = overlap; bytes = overlapBytes; start = offset - overlap.join('').length;
      }
      active.push(unit); bytes += size; offset += unit.length;
    }
    const current = active.join(''); if (current.trim()) pieces.push({ id: block.id, text: current, start, end: offset });
  }
  const chunks: SourceSlice[][] = []; let batch: SourceSlice[] = [];
  for (const piece of pieces) {
    if (batch.length && Buffer.byteLength(JSON.stringify([...batch, piece].map(wire))) > maxBytes) { chunks.push(batch); batch = []; }
    if (Buffer.byteLength(JSON.stringify([wire(piece)])) > maxBytes) throw new ModelExecutionError('input_budget_exhausted');
    batch.push(piece);
  }
  if (batch.length) chunks.push(batch);
  return chunks;
}
/** Conservative transport chunks retain overlap and never silently omit a suffix. */
export function splitPrivacyBlocks(blocks: IntakeSourceBlock[], maxBytes = 2200): IntakeSourceBlock[][] {
  return splitPrivacyBlockRanges(blocks, maxBytes).map(chunk => chunk.map(({ id, text }) => ({ id, text })));
}
function prepareVerificationPlan(projection: PrivateIntakeProjection, publicIds: ReadonlySet<string> = new Set()): SourceSlice[] {
  const blocks=projection.blocks.filter(block => block.id !== PRIVACY_COVERAGE_SOURCE_ID && !publicIds.has(block.id));
  const sources=usesWholeWordNerWindows(projection.redactionVersion)
    ?new Map(blocks.map(block=>[block.id,createPrivacyNerWindowSource(block.text)])):null;
  const plan = splitPrivacyBlockRanges(blocks).flat().map(slice=>sources?{id:slice.id,...sources.get(slice.id)!.window(slice)}:slice);
  // Preflight the entire pass before its first NER request, including many small
  // sources that share one transport batch but each require an individual scan.
  if (plan.length > MAX_PREPARE_VERIFICATION_REQUESTS) throw new ModelExecutionError('input_budget_exhausted');
  return plan;
}
function assertPrepareObservation(entities: PrivacyEntity[]): void {
  if (entities.length > MAX_PREPARE_REFINEMENT_ENTITIES) throw new ModelExecutionError('input_budget_exhausted');
  // Invalid shape/Unicode is never converted to an isolation decision.
  if (entities.some(entity => !entity.text || entity.text.length > 2000 ||
    [...entity.text].some(character => character.length === 1 && /[\uD800-\uDFFF]/u.test(character)))) deny('privacy_final_entity');
}
/** Map this exact cleaned request back through literal runs, never mask contents. */
function cleanSliceProvenance(slice: SourceSlice, provenance: ProjectionProvenance) {
  let cursor = 0, clean = '';
  const runs: Array<SourceRange & { originalStart: number }> = [];
  const opaque: Array<SourceRange & {originalStart:number;originalEnd:number}> = [];
  const appendLiteral = (start: number, end: number) => {
    if (start === end) return;
    const renderedStart = slice.start + start, renderedEnd = slice.start + end;
    const run = provenance.literals.find(value => value.renderedStart <= renderedStart && value.renderedEnd >= renderedEnd);
    if (!run) deny('privacy_canonical_mismatch');
    runs.push({ start: clean.length, end: clean.length + end - start, originalStart: run.originalStart + renderedStart - run.renderedStart });
    clean += slice.text.slice(start, end);
  };
  for (const match of slice.text.matchAll(placeholderPattern)) {
    appendLiteral(cursor, match.index!);
    const mapped=provenance.opaque.find(run=>run.renderedStart===slice.start+match.index!&&run.renderedEnd===slice.start+match.index!+match[0].length);
    if(!mapped)deny('privacy_canonical_mismatch');
    opaque.push({start:clean.length,end:clean.length+1,originalStart:mapped.originalStart,originalEnd:mapped.originalEnd});
    clean += '\uFFFC'; cursor = match.index! + match[0].length;
  }
  appendLiteral(cursor, slice.text.length);
  return { clean, runs,opaque };
}
/** One deterministic bisection only; the caller owns any paid correction policy. */
export function splitPrivacyCorrectionBlocks(input: IntakeSourceBlock[]): IntakeSourceBlock[][] {
  const parsed = z.array(IntakeSourceBlockSchema).min(1).max(256).safeParse(input);
  if (!parsed.success) throw new ModelExecutionError('invalid_output');
  const blocks = parsed.data, segments = new Intl.Segmenter('und', { granularity: 'grapheme' });
  if (blocks.reduce((sum, block) => sum + Buffer.byteLength(block.text), 0) > ASSISTANT_CAPACITY_LIMITS.maxSourceBytes) throw new ModelExecutionError('input_budget_exhausted');
  type Unit = { block: number; start: number; end: number; bytes: number; characters: number };
  const units: Unit[] = [];
  for (const [block, value] of blocks.entries()) {
    if ([...value.text].some(character => character.length === 1 && /[\uD800-\uDFFF]/u.test(character))) throw new ModelExecutionError('invalid_output');
    const add = (start: number, end: number) => { const text = value.text.slice(start, end); units.push({ block, start, end,
      bytes: Buffer.byteLength(JSON.stringify(text)) - 2, characters: Array.from(text).length }); };
    const ordinary = (start: number, end: number) => { for (const part of segments.segment(value.text.slice(start, end))) add(start + part.index, start + part.index + part.segment.length); };
    let cursor = 0;
    for (const match of value.text.matchAll(/\[\[P_[A-Z]+_[a-f0-9]{20}\]\]/gu)) {
      ordinary(cursor, match.index!); add(match.index!, match.index! + match[0].length); cursor = match.index! + match[0].length;
    }
    ordinary(cursor, value.text.length);
  }
  if (!units.length) throw new ModelExecutionError('invalid_output');
  if (units.length === 1) return [blocks];
  const total = units.reduce((sum, unit) => sum + unit.bytes, 0);
  let cut = 1, best = Infinity, prefix = 0;
  for (let i = 1; i < units.length; i++) { prefix += units[i - 1].bytes; const distance = Math.abs(total - 2 * prefix); if (distance < best) { best = distance; cut = i; } }
  let rightStart = cut, overlapBytes = 0, overlapCharacters = 0;
  // Keep at least the first atomic unit exclusive to the left, so overlap can
  // never turn the right half back into a replay of the full parent input.
  while (rightStart > 1) {
    const unit = units[rightStart - 1];
    if (overlapBytes + unit.bytes > 320 || overlapCharacters + unit.characters > 80) break;
    overlapBytes += unit.bytes; overlapCharacters += unit.characters; rightStart--;
  }
  const part = (selected: Unit[]) => {
    const result: IntakeSourceBlock[] = []; let lastBlock = -1;
    for (const unit of selected) {
      const text = blocks[unit.block].text.slice(unit.start, unit.end);
      if (unit.block === lastBlock) result[result.length - 1].text += text;
      else { result.push({ id: blocks[unit.block].id, text }); lastBlock = unit.block; }
    }
    return result;
  };
  return [part(units.slice(0, cut)), part(units.slice(rightStart))];
}
function detectedRules(text: string): PrivacyEntity[] {
  const value = indexed(text), result: PrivacyEntity[] = [];
  for (const [kind, pattern] of patterns) {
    pattern.lastIndex = 0;
    for (const match of value.normalized.matchAll(pattern)) {
      const token = match[1] ?? match[0], start = match.index! + match[0].indexOf(token), end = start + token.length - 1;
      if (value.starts[start] !== undefined && value.ends[end] !== undefined) result.push({ kind, text: text.slice(value.starts[start], value.ends[end]) });
    }
  }
  return result;
}
function withoutPlaceholders(text: string) { return text.replace(placeholderPattern, ' '); }
function numberTokens(text: string): Array<string | undefined> {
  // Compare whole lexical numbers without floating-point conversion. The only
  // equivalence is a correctly grouped comma thousands separator; signs,
  // decimal precision and decimal separators retain their original meaning.
  return (withoutPlaceholders(text).match(/(?:[+\-−]\s*)?\d+(?:[.,]\d+)*(?:[eE][+-]?\d+)?/gu) ?? []).map(value => {
    if (/^[+-]?\d{1,3}(?:,\d{3})+(?:\.\d+)?$/u.test(value)) return value.replaceAll(',', '');
    return /^[+-]?\d+(?:\.\d+)?$/u.test(value) ? value : undefined;
  });
}

export class PrivacyProjectionService {
  private readonly ner: Pick<NerClient, 'entities'>;
  private readonly publicVocabulary: Set<string>;
  private readonly publicTemplates: Map<string,string>;
  private readonly sourceEnums: Set<string>;
  private readonly foldedSourceEnums: Set<string>;
  private readonly documentTerms: boolean;
  constructor(private readonly options: PrivacyProjectionOptions) {
    const vocabulary=z.enum(['document_roles_v1','document_roles_v2']).optional().parse(options.sourceVocabulary);
    if(vocabulary==='document_roles_v2'&&options.nerSourceSpans!==true)throw new ModelExecutionError('capability_unsupported');
    this.documentTerms=vocabulary==='document_roles_v2';
    this.sourceEnums=new Set([...publicDomainEnums,...(vocabulary?documentRoleEnums:[])]);
    this.foldedSourceEnums=new Set([...this.sourceEnums].map(whitespaceFold));
    this.publicTemplates = new Map(Object.entries(z.record(IntakeSourceBlockSchema.shape.id,z.string().regex(/^[a-f0-9]{64}$/)).parse(options.publicTemplateDigests ?? {})));
    z.number().int().min(1).max(8).parse(options.maxPrepareRefinementPasses??1);
    if(this.publicTemplates.size>8)throw new ModelExecutionError('invalid_output');
    this.ner = 'entities' in options.ner ? options.ner : new NerClient(options.ner);
    this.publicVocabulary = new Set(['跨境通途', '跨境通途建案助手', 'Azure', 'OpenAI', 'Azure OpenAI', 'Qwen',
      ...z.array(z.string().min(1).max(100)).max(16).parse(options.publicVocabulary ?? [])].map(canonical));
  }
  private verifyPublicTemplates(blocks: IntakeSourceBlock[]): Set<string> {
    for(const [id,digest] of this.publicTemplates){
      const found=blocks.filter(block=>block.id===id);
      if(found.length!==1||hash(found[0]!.text)!==digest)deny('privacy_canonical_mismatch');
    }
    return new Set(this.publicTemplates.keys());
  }
  private isSourceVocabulary(text:string) {
    // OCR can retain a literal newline escape. Only those exact two bytes are
    // layout vocabulary, never a contact identity. Do not case-fold this token,
    // rewrite the source, or exempt a larger entity containing the escape.
    // A layout line break inside a role title does not make it a party: the same word elsewhere in the source stays
    // unmasked, so masking only the wrapped occurrence would leave the known-source check unable to pass.
    return this.sourceEnums.has(canonical(text)) || this.foldedSourceEnums.has(whitespaceFold(text)) || this.options.nerSourceSpans===true&&this.options.sourceVocabulary!==undefined&&text==='\\n' ||
      this.documentTerms&&genericDocumentTerm(text);
  }
  /** With the document vocabulary, a label read together with its value keeps only the value: the rest is the same
   * source span, shortened at a layout gap, and stays masked. */
  private withoutLabel<T extends {text:string;start?:number;end?:number}>(entity:T):T {
    if(!this.documentTerms||entity.start===undefined||entity.end===undefined)return entity;
    const trim=genericLabelTrim(entity.text);
    return trim?{...entity,text:entity.text.slice(trim.start,trim.end),start:entity.start+trim.start,end:entity.start+trim.end}:entity;
  }
  /** With the document vocabulary, a part of a word (one letter of "with", "公" of "公司") is not a finding when the whole
   * word or words around it are vocabulary: nothing in them names anyone. A part of any other word stays a finding. */
  private insideDocumentTerm(text:string,entity:{start?:number;end?:number}):boolean {
    return this.documentTerms&&entity.start!==undefined&&entity.end!==undefined&&genericDocumentTerm(surroundingWords(text,entity.start,entity.end));
  }
  private async scan(text: string, signal?: AbortSignal, filterDomainEnums = true): Promise<NerObservation[]> {
    signal?.throwIfAborted();
    try {
      if(this.options.nerSourceSpans){
        return (await scanNerSourceSpans(this.ner,text,nerLabels,kindFor,signal)).map(entity=>this.withoutLabel(entity))
          .filter(entity=>!filterDomainEnums||!this.isSourceVocabulary(entity.text)&&!this.insideDocumentTerm(text,entity)) as NerObservation[];
      }
      const result = await this.ner.entities(text || 'empty', nerLabels, { signal, wordSplitter: /[\u3400-\u9fff]/u.test(text) ? 'char' : 'whitespace' });
      const entities = Object.entries(result.entities).flatMap(([label, values]) => values.filter(value => value.text.trim()).map(value => ({ text: value.text, kind: kindFor[label] ?? 'identity' } as PrivacyEntity)));
      return restoreNerTerminalSourceSuffix(text, entities).filter(entity => !filterDomainEnums || !this.isSourceVocabulary(entity.text));
    } catch (error) { if (signal?.aborted) throw error; return deny('privacy_ner_unavailable'); }
  }
  async prepare(input: { scopeId: string; blocks: IntakeSourceBlock[]; previousReplacements?: PrivateIntakeProjection['replacements']; isolatableSourceIds?: readonly string[] }, signal?: AbortSignal): Promise<PrivateIntakeProjection> {
    // Validate source shape separately so capacity failures never masquerade as
    // malformed model output, and malformed blocks never become budget errors.
    const parsed = z.array(IntakeSourceBlockSchema).min(1).safeParse(input.blocks);
    if (!parsed.success) throw new ModelExecutionError('invalid_output');
    const blocks = parsed.data;
    if (blocks.length > 256) throw new ModelExecutionError('input_budget_exhausted');
    if (!input.scopeId || new Set(blocks.map(block => block.id)).size !== blocks.length || blocks.some(block => block.id === PRIVACY_COVERAGE_SOURCE_ID)) deny('privacy_canonical_mismatch');
    // Only the caller's verified attachment sources may be isolated. User
    // instructions/form fields keep their original all-or-nothing behavior.
    const isolatable = new Set(input.isolatableSourceIds ?? []);
    if (isolatable.size !== (input.isolatableSourceIds?.length ?? 0) || [...isolatable].some(id => !blocks.some(block => block.id === id))) deny('privacy_canonical_mismatch');
    const bytes = blocks.reduce((sum, block) => sum + Buffer.byteLength(block.text), 0);
    if (bytes > (this.options.maxSourceBytes ?? 120_000)) throw new ModelExecutionError('input_budget_exhausted');
    if (blocks.some(block => encoded(block.text) || /\[\[P_/u.test(block.text))) deny('privacy_encoded_input');
    const publicIds=this.verifyPublicTemplates(blocks),privateBlocks=blocks.filter(block=>!publicIds.has(block.id));
    const chunks = splitPrivacyBlockRanges(privateBlocks);
    if (chunks.length > (this.options.maxCalls ?? 64)) throw new ModelExecutionError('input_budget_exhausted');
    const originalBlocks = new Map(blocks.map(block => [block.id, block]));
    // NER receives whole source words; Qwen retains its existing immutable chunks.
    // Preflight every window before either service runs, including oversized words.
    const nerSources=this.options.nerSourceSpans?new Map(privateBlocks.map(block=>[block.id,createPrivacyNerWindowSource(block.text)])):null;
    const nerWindows=new Map(chunks.flat().map(block=>[block,nerSources?nerSources.get(block.id)!.window(block):block]));
    const withheld = new Map<string, z.infer<typeof WithheldReasonSchema>>();
    const proposals: PrivacyEntity[] = privateBlocks.flatMap(block => detectedRules(block.text));
    const scopedProposals:PreparedPrivacyEntity[]=[];
    for (const originalChunk of chunks) {
      signal?.throwIfAborted();
      let chunk = originalChunk.filter(block => !withheld.has(block.id));
      if (!chunk.length) continue;
      for (const block of chunk) {
        if (withheld.has(block.id)) continue;
        // The NER transport/schema has already completed before source checking.
        // Only a known, well-formed but ungrounded result can isolate an attachment;
        // unavailable/unknown service responses remain fatal.
        const window=nerWindows.get(block)!;
        const entities = await this.scan(window.text, signal);
        try {
          if(this.options.nerSourceSpans){
            const source=originalBlocks.get(block.id)!;
            for(const entity of entities){
              if(entity.start===undefined||entity.end===undefined||window.text.slice(entity.start,entity.end)!==entity.text)deny('privacy_source_entity');
              const start=window.start+entity.start,end=window.start+entity.end;
              if(source.text.slice(start,end)!==entity.text)deny('privacy_source_entity');
              scopedProposals.push({kind:entity.kind,text:entity.text,native:true,source:{sourceRef:block.id,sourceSha256:privacySourceHash(source.text),start,end}});
            }
          }else proposals.push(...alignPrivacyEntities([originalBlocks.get(block.id)!], entities, undefined, { foldCase: false }));
        }
        catch (error) {
          if (!(error instanceof ModelExecutionError) || error.diagnostic !== 'local_output_source') throw error;
          if (!isolatable.has(block.id)) deny('privacy_source_entity');
          withheld.set(block.id, 'ner_source_validation_failed');
          if (!blocks.some(source => isolatable.has(source.id) && !withheld.has(source.id) && source.text.trim())) deny('privacy_source_entity');
        }
      }
      // An NER-rejected source must not enter a later model input/context, even
      // when other originals share the same transport batch.
      chunk = chunk.filter(block => !withheld.has(block.id));
      if (!chunk.length) continue;
      if (this.options.proposeEntities) {
        // Only the complete originals behind this transport chunk may ground
        // returned entities. This private context is never a model input.
        const context = [...new Set(chunk.map(block => block.id))].map(id => originalBlocks.get(id)!);
        const result = PrivacyProposalResultSchema.parse(await this.options.proposeEntities(chunk.map(({id,text})=>({id,text})), signal, context));
        if ('entities' in result) proposals.push(...result.entities);
        else {
          // The bridge may return this only after known settled failures. It
          // cannot nominate source IDs: the complete current originals decide
          // the quarantine scope, including earlier successful slices.
          const failure = () => result.withheld.reason === 'output_truncated'
            ? new ModelExecutionError('truncated', false, 'qwen_truncated')
            : new ModelExecutionError('invalid_output', false, 'local_output_source');
          if (context.some(block => !isolatable.has(block.id))) throw failure();
          for (const block of context) withheld.set(block.id, result.withheld.reason);
          if (!blocks.some(block => isolatable.has(block.id) && !withheld.has(block.id) && block.text.trim())) throw failure();
        }
      }
    }
    const previous = z.array(ReplacementSchema).max(4096).parse(input.previousReplacements ?? []);
    if(previous.some(value=>value.placeholder!==replacementAlias(input.scopeId,value.kind,value.original,value.source,value.fragmentOf)||!validMaskFragment(value,previous)))deny('privacy_canonical_mismatch');
    if(!this.options.nerSourceSpans&&previous.some(value=>value.source))deny('privacy_canonical_mismatch');
    // Only current, native literal observations may trigger conservative word
    // expansion. Generated unions/variants/identity masks do not bootstrap it.
    const nativeExpansionValues=new Set<string>();
    // Only exact current native findings can authorize their own bounded cover.
    // This process-local proof is never loaded from a persisted replacement.
    const nativePartialFindings=new Set<string>();
    // This closure only renders already completed private proposals. It cannot
    // dispatch a model, change source ownership or alter isolation decisions.
    const buildProjection = (additional: PreparedPrivacyEntity[], stableRegistry = previous): PreparedProjection => {
      const retained = blocks.filter(block => !withheld.has(block.id));
      const unique = new Map<string, PrivacyEntity>();
      const indexedSources=blocks.filter(block=>!publicIds.has(block.id)).map(block=>({text:block.text,...indexedPrivacySource(block.text)}));
      // Previously discovered names remain protected in subsequent turns, even if a model misses them.
      for (const entity of [...stableRegistry.filter(value=>!value.source||
        !blocks.some(block=>block.id===value.source!.sourceRef&&privacySourceHash(block.text)===value.source!.sourceSha256))
        .map(value => ({ text: value.fragmentOf?.text??value.original, kind: value.kind })), ...proposals, ...additional.filter(value=>!value.source)]) {
        if(this.isSourceVocabulary(entity.text))continue;
        let variants:PrivacyEntity[];
        try{variants=alignPrivacyEntities(blocks.filter(block=>!publicIds.has(block.id)),[entity],indexedSources,{includeAllFormattingVariants:true});}
        catch(error){
          if(!(error instanceof ModelExecutionError)||error.diagnostic!=='local_output_source')throw error;
          if(proposals.includes(entity)||additional.includes(entity))deny('privacy_source_entity');
          continue;
        }
        // Every whitespace/case/width variant is an exact source slice with its
        // own restoration mapping. An exact occurrence does not excuse another
        // OCR-spaced occurrence of the same known private entity.
        for(const variant of variants){
          const variantKey=canonical(variant.text);
          if(this.isSourceVocabulary(variant.text)||!retained.some(block=>!publicIds.has(block.id)&&canonical(block.text).includes(variantKey)))continue;
          if(!unique.has(variantKey))unique.set(variantKey,variant);
        }
      }
      const replacements = [...unique.entries()].map(([key, entity]) => {
        const old = stableRegistry.find(value => !value.source&&canonical(value.original) === key);
        return old ?? { placeholder: `[[P_${entity.kind.toUpperCase()}_${hash(`${input.scopeId}:${key}`).slice(0, 20)}]]`, original: entity.text, kind: entity.kind };
      }) as PrivateIntakeProjection['replacements'];
      const scoped=new Map<string,PrivateIntakeProjection['replacements'][number]>();
      for(const entity of [...stableRegistry.filter(value=>value.source).map(value=>({text:value.original,kind:value.kind,source:value.source,fragmentOf:value.fragmentOf})),...scopedProposals,...additional.filter(value=>value.source)]){
        const range=entity.source!,source=retained.find(block=>block.id===range.sourceRef);
        // Cross-turn scoped findings do not gain authority over changed bytes.
        if(!source||privacySourceHash(source.text)!==range.sourceSha256)continue;
        if(source.text.slice(range.start,range.end)!==entity.text)deny('privacy_canonical_mismatch');
        if(entity.fragmentOf&&JSON.stringify(originalMaskedWord(source.text,range.start,range.end))!==JSON.stringify({text:entity.fragmentOf.text,start:entity.fragmentOf.start,end:entity.fragmentOf.end}))deny('privacy_canonical_mismatch');
        const value={placeholder:replacementAlias(input.scopeId,entity.kind,entity.text,range,entity.fragmentOf),original:entity.text,kind:entity.kind,source:range,...(entity.fragmentOf?{fragmentOf:entity.fragmentOf}:{})};
        scoped.set(replacementKey(value),value);
      }
      if(this.options.nerSourceSpans){
        // A native finding remains evidence when another chunk misses it. Every
        // additional mask binds an exact original range; a containing word is
        // conservatively opaque, never asserted to be the original entity.
        const originals=new Map(retained.filter(block=>!publicIds.has(block.id)).map(block=>[block.id,{index:knownPrivacySource(block.text),sha256:privacySourceHash(block.text)}]));
        for(const entity of [...scopedProposals,...additional]){
          const range=entity.source,origin=range&&originals.get(range.sourceRef);
          if(entity.native&&!entity.fragmentOf&&range&&origin?.sha256===range.sourceSha256&&
            origin.index.text.slice(range.start,range.end)===entity.text){
            const complete=origin.index.completeWords(range.start,range.end);
            const cover=complete?undefined:[...origin.index.matches(entity.text,true)].find(match=>
              match.expanded&&match.start<=range.start&&match.end>=range.end);
            if(complete||cover){
              nativeExpansionValues.add(JSON.stringify([entity.kind,whitespaceFold(entity.text)]));
              if(!complete)nativePartialFindings.add(replacementKey({original:entity.text,source:range}));
            }
          }
        }
        const alreadyProtected=new Map<string,Array<SourceRange&{owner?:string}>>();
        for(const [id,origin] of originals){
          const masks:Array<SourceRange&{owner?:string}>=[...scoped.values()].filter(value=>value.source!.sourceRef===id).map(value=>({start:value.source!.start,end:value.source!.end,owner:replacementKey(value)}));
          const normalized=indexed(origin.index.text);
          for(const value of replacements){
            const needle=canonical(value.original);let at=0;
            while((at=normalized.normalized.indexOf(needle,at))!==-1){
              if(!completePrivacyMatch(normalized,at,needle.length))deny('privacy_source_entity');
              if(masks.length>=MAX_PRIVACY_SPANS_PER_BLOCK)throw new ModelExecutionError('input_budget_exhausted');
              masks.push({start:normalized.starts[at]!,end:normalized.ends[at+needle.length-1]!});at++;
            }
          }
          alreadyProtected.set(id,masks);
        }
        const known=new Map<string,PrivateIntakeProjection['replacements'][number]>();
        for(const value of scoped.values()){
          const source=value.source!,origin=originals.get(source.sourceRef);
          if(!value.fragmentOf&&origin){
            if(origin.index.completeWords(source.start,source.end))known.set(JSON.stringify([value.kind,whitespaceFold(value.original)]),value);
            else if(nativePartialFindings.has(replacementKey(value)))known.set('native:'+replacementKey(value),value);
          }
        }
        for(const value of known.values())for(const [sourceRef,origin] of originals){
          for(const match of origin.index.matches(value.original,true)){
            // A few letters of a finding ("W" of a surname) also occur inside ordinary words ("with", "were"). With the
            // document vocabulary such a word is left as written when the whole word around the match is vocabulary.
            if(this.documentTerms&&!(value.source!.sourceRef===sourceRef&&value.source!.start<match.end&&value.source!.end>match.start)&&
              genericDocumentTerm(surroundingWords(origin.index.text,match.start,match.end)))continue;
            if(match.expanded&&(!nativeExpansionValues.has(JSON.stringify([value.kind,whitespaceFold(value.original)]))||
              alreadyProtected.get(sourceRef)!.some(mask=>mask.start<match.end&&mask.end>match.start&&
                // The native finding's own mask may grow to its original word.
                // Any independent mask still blocks this inference.
                !(nativePartialFindings.has(replacementKey(value))&&value.source!.sourceRef===sourceRef&&
                  mask.owner===replacementKey(value)&&mask.start===value.source!.start&&mask.end===value.source!.end))))continue;
            const source={sourceRef,sourceSha256:origin.sha256,start:match.start,end:match.end};
            // A containing business word is not declared to be the entity.
            // Conservatively make its entire source span opaque instead.
            const kind=match.expanded?'identity':value.kind;
            const next={placeholder:replacementAlias(input.scopeId,kind,match.original,source),original:match.original,kind,source};
            const key=replacementKey(next);
            if(!scoped.has(key)){
              if(scoped.size+replacements.length>=4096)throw new ModelExecutionError('input_budget_exhausted');
              scoped.set(key,next);
            }
          }
        }
      }
      replacements.push(...scoped.values());
      if (replacements.length > 4096) throw new ModelExecutionError('input_budget_exhausted');
      const replacementByKey = new Map(replacements.map(value => [replacementKey(value), value]));
      const provenance = new Map<string, ProjectionProvenance>();
      const redacted = retained.map(block => {
        if(publicIds.has(block.id)){
          provenance.set(block.id,{literals:[{renderedStart:0,renderedEnd:block.text.length,originalStart:0,originalEnd:block.text.length}],masks:[],opaque:[]});
          return {...block};
        }
        const normalized = indexed(block.text), spans: Array<{ start: number; end: number; placeholder?: string;scoped?:boolean }> = [];
        for (const replacement of replacements) {
          if(replacement.source){
            if(replacement.source.sourceRef===block.id)spans.push({start:replacement.source.start,end:replacement.source.end,placeholder:replacement.placeholder,scoped:true});
            continue;
          }
          const needle = canonical(replacement.original); let at = 0;
          while ((at = normalized.normalized.indexOf(needle, at)) !== -1) {
            if (!completePrivacyMatch(normalized, at, needle.length)) deny('privacy_source_entity');
            // Repeated overlapping entities can otherwise multiply allocations.
            // Reject the whole block instead of dropping any sensitive interval.
            if (spans.length >= MAX_PRIVACY_SPANS_PER_BLOCK) throw new ModelExecutionError('input_budget_exhausted');
            spans.push({ start: normalized.starts[at], end: normalized.ends[at + needle.length - 1], placeholder: replacement.placeholder }); at++;
          }
        }
        spans.sort((a, b) => a.start - b.start || b.end - a.end);
        const merged: typeof spans = [];
        for (const span of spans) {
          const previous = merged.at(-1);
          // Only intersecting original spans may form a union; adjacent spans and
          // separate source blocks never authorize reconstruction of a larger fact.
          if (!previous || span.start >= previous.end) merged.push({ ...span });
          else if (span.end > previous.end) { previous.end = span.end; previous.placeholder = undefined;previous.scoped=previous.scoped||span.scoped; }
        }
        let cursor = 0, text = '';
        const literals: LiteralRun[] = [],opaque:LiteralRun[]=[];
        const appendLiteral = (end: number) => {
          if (end > cursor) literals.push({ renderedStart: text.length, renderedEnd: text.length + end - cursor, originalStart: cursor, originalEnd: end });
          text += block.text.slice(cursor, end);
        };
        for (const span of merged) {
          let placeholder = span.placeholder;
          if (!placeholder) {
            const original = block.text.slice(span.start, span.end),source=span.scoped?{sourceRef:block.id,sourceSha256:privacySourceHash(block.text),start:span.start,end:span.end}:undefined;
            const key=replacementKey({original,source});
            if (!original || original.length > 2000) deny('privacy_source_entity');
            let replacement = replacementByKey.get(key);
            if (!replacement) {
              if (replacements.length >= 4096) throw new ModelExecutionError('input_budget_exhausted');
              replacement = {placeholder:replacementAlias(input.scopeId,'identity',original,source),original,kind:'identity',...(source?{source}:{})};
              replacementByKey.set(key, replacement); replacements.push(replacement);
            }
            placeholder = replacement.placeholder;
          }
          appendLiteral(span.start);opaque.push({renderedStart:text.length,renderedEnd:text.length+placeholder.length,originalStart:span.start,originalEnd:span.end});text += placeholder; cursor = span.end;
        }
        appendLiteral(block.text.length);
        provenance.set(block.id, { literals,opaque, masks: merged.map(({ start, end }) => ({ start, end })) });
        return { id: block.id, text };
      });
      // Keep grounded child entities as private cross-turn memory. Only aliases
      // occurring in the surviving projection can be restored (enforced below).
      if (withheld.size) redacted.push({ id: PRIVACY_COVERAGE_SOURCE_ID, text: coverageText(withheld.size) });
      const projection = PrivateIntakeProjectionSchema.parse({ version: INTAKE_V2_SCHEMA, scopeId: input.scopeId, sourceManifestHash: hash(JSON.stringify(blocks)), redactionVersion: this.options.nerSourceSpans?this.documentTerms?PRIVACY_DOCUMENT_TERMS_VERSION:PRIVACY_SPAN_PREPARE_VERSION:PRIVACY_PREPARE_VERSION, blocks: redacted,
        replacements,
        ...(this.options.nerSourceSpans?{sourceCoverage:retained.filter(block=>!publicIds.has(block.id)).map(block=>({
          sourceRef:block.id,sourceSha256:privacySourceHash(block.text),redactedSha256:privacySourceHash(redacted.find(value=>value.id===block.id)!.text),masks:provenance.get(block.id)!.masks,
        }))}:{}),
        ...(withheld.size ? { withheldSources: [...withheld].map(([sourceRef, reason]) => ({ sourceRef, reason })) } : {}),
      });
      return { projection, provenance };
    };
    // Restriction only removes complete trusted attachment originals. It never
    // rewrites surviving bytes or grants an unused alias restoration authority.
    const restrictProjection = (prepared: PreparedProjection, sourceIds: ReadonlySet<string>): PreparedProjection => {
      if (!sourceIds.size) return prepared;
      const before = prepared.projection, nextWithheld = new Map(withheld);
      for (const id of sourceIds) {
        if (!isolatable.has(id) || !originalBlocks.has(id) || !prepared.provenance.has(id) ||
          !before.blocks.some(block => block.id === id)) deny('privacy_final_entity');
        nextWithheld.set(id, 'ner_source_validation_failed');
      }
      const retained = blocks.filter(block => !nextWithheld.has(block.id));
      if (!retained.some(block => isolatable.has(block.id) && block.text.trim())) deny('privacy_final_entity');
      const surviving = before.blocks.filter(block => block.id !== PRIVACY_COVERAGE_SOURCE_ID && !sourceIds.has(block.id));
      const replacements = before.replacements.filter(value => retained.some(block => value.source?block.id===value.source.sourceRef&&privacySourceHash(block.text)===value.source.sourceSha256:canonical(block.text).includes(canonical(value.original))));
      const aliases = new Set(replacements.map(value => value.placeholder));
      if (surviving.some(block => (block.text.match(placeholderPattern) ?? []).some(alias => !aliases.has(alias)))) deny('privacy_canonical_mismatch');
      const projection = PrivateIntakeProjectionSchema.parse({ ...before, blocks: [...surviving,
        { id: PRIVACY_COVERAGE_SOURCE_ID, text: coverageText(nextWithheld.size) }], replacements,
        ...(before.sourceCoverage?{sourceCoverage:before.sourceCoverage.filter(value=>!sourceIds.has(value.sourceRef))}:{}),
        withheldSources: [...nextWithheld].map(([sourceRef, reason]) => ({ sourceRef, reason })) });
      // A checked retained block and every retained mapping must remain exactly
      // identical, including kind and original, after the deletion-only step.
      if (projection.sourceManifestHash !== before.sourceManifestHash ||
        JSON.stringify(projection.blocks.filter(block => block.id !== PRIVACY_COVERAGE_SOURCE_ID)) !== JSON.stringify(surviving) ||
        projection.replacements.some(value => !before.replacements.some(previous => JSON.stringify(previous) === JSON.stringify(value)))) deny('privacy_canonical_mismatch');
      for (const id of sourceIds) withheld.set(id, 'ner_source_validation_failed');
      return { projection, provenance: new Map([...prepared.provenance].filter(([id]) => !sourceIds.has(id))) };
    };
    let prepared=buildProjection([]);
    const maximumPasses=this.options.maxPrepareRefinementPasses??1;
    for(let pass=0;pass<maximumPasses;pass++){
    const initial=prepared,plan = prepareVerificationPlan(initial.projection,publicIds);
    const refinements = await this.collectPrepareRefinements(plan, initial.projection, initial.provenance, originalBlocks, isolatable, signal);
    signal?.throwIfAborted();
    const retainedInitial = restrictProjection(initial, refinements.isolateSourceIds);
    if (!refinements.entities.length) return retainedInitial.projection;
    // Each local pass adds grounded masks monotonically. Never recurse into
    // prepare or re-run any known/unknown paid child.
    // Seed from the restricted registry, including already generated unions.
    // A shared alias must not acquire a different original/kind when its first
    // source was isolated but an equivalent source still independently remains.
    const refined = buildProjection(refinements.entities, retainedInitial.projection.replacements);
    if (refined.projection.sourceManifestHash !== retainedInitial.projection.sourceManifestHash ||
      JSON.stringify(refined.projection.withheldSources) !== JSON.stringify(retainedInitial.projection.withheldSources) ||
      JSON.stringify(refined.projection.blocks.map(block => block.id)) !== JSON.stringify(retainedInitial.projection.blocks.map(block => block.id))) deny('privacy_canonical_mismatch');
    for (const replacement of refined.projection.replacements) {
      const existing = retainedInitial.projection.replacements.find(value => value.placeholder === replacement.placeholder);
      if (existing && JSON.stringify(existing) !== JSON.stringify(replacement)) deny('privacy_canonical_mismatch');
    }
    let oldCoverage = 0, newCoverage = 0;
    for (const [id, before] of retainedInitial.provenance) {
      const after = refined.provenance.get(id); if (!after) deny('privacy_canonical_mismatch');
      // Separate adjacent aliases still protect the complete original interval.
      // Do not merge their identities, and reject even a one-character gap.
      const covers = (range: SourceRange) => {
        let covered = range.start;
        for (const mask of after.masks) {
          if (mask.end <= covered) continue;
          if (mask.start > covered) return false;
          covered = mask.end;
          if (covered >= range.end) return true;
        }
        return false;
      };
      if (before.masks.some(range => !covers(range)) || (refinements.ranges.get(id) ?? []).some(range => !covers(range))) deny('privacy_final_entity');
      oldCoverage += before.masks.reduce((sum, range) => sum + range.end - range.start, 0);
      newCoverage += after.masks.reduce((sum, range) => sum + range.end - range.start, 0);
    }
    if (newCoverage <= oldCoverage) deny('privacy_final_entity');
    if(pass+1<maximumPasses){prepared=refined;continue;}
    const finalPlan = prepareVerificationPlan(refined.projection,publicIds), finalIsolation = new Set<string>();
    for (const block of finalPlan) {
      if (finalIsolation.has(block.id)) continue;
      // Only a completed, well-formed NER observation may isolate a source.
      // All pre-NER guards, transport/schema failures and cancellation still throw.
      const observed = await this.inspectClean(block.text, refined.projection, signal);
      assertPrepareObservation(observed.entities);
      if (observed.entities.length) {
        if (!isolatable.has(block.id)) deny('privacy_final_entity');
        finalIsolation.add(block.id);
      }
    }
    signal?.throwIfAborted();
    return restrictProjection(refined, finalIsolation).projection;
    }
    deny('privacy_final_entity');
  }
  private async collectPrepareRefinements(plan: SourceSlice[], projection: PrivateIntakeProjection,
    provenance: Map<string, ProjectionProvenance>, originals: Map<string, IntakeSourceBlock>, isolatable: ReadonlySet<string>, signal?: AbortSignal) {
    const entities = new Map<string, { entity: PreparedPrivacyEntity; owners: Set<string> }>(), ranges = new Map<string, SourceRange[]>(), seenRanges = new Set<string>();
    const isolateSourceIds = new Set<string>(), boundaries = new Map<string, Set<number>>(); let matches = 0;
    for (const slice of plan) {
      signal?.throwIfAborted();
      if (isolateSourceIds.has(slice.id)) continue;
      const origin = originals.get(slice.id), mapping = provenance.get(slice.id);
      if (!origin || !mapping || projection.withheldSources?.some(source => source.sourceRef === slice.id)) deny('privacy_canonical_mismatch');
      const observed = await this.inspectClean(slice.text, projection, signal);
      if (!observed.entities.length) continue;
      assertPrepareObservation(observed.entities);
      const request = cleanSliceProvenance(slice, mapping);
      if (request.clean !== observed.clean) deny('privacy_canonical_mismatch');
      let originalBoundaries = boundaries.get(slice.id);
      if (!originalBoundaries) {
        originalBoundaries = new Set([0, origin.text.length, ...[...sourceGraphemes.segment(origin.text)].map(part => part.index)]);
        boundaries.set(slice.id, originalBoundaries);
      }
      for (const entity of observed.entities) {
        let at = 0, found = false, grounded = !/\[\[P_/u.test(entity.text) &&
          (!entity.text.includes('\uFFFC')||this.options.allowGroundedOpaqueUnions===true);
        const additions:PreparedPrivacyEntity[]=[];
        const nativeAt=this.options.nerSourceSpans?entity.start:undefined;
        if(this.options.nerSourceSpans&&(nativeAt===undefined||entity.end!==nativeAt+entity.text.length||request.clean.slice(nativeAt,entity.end)!==entity.text))deny('privacy_source_entity');
        let nativeConsumed=false;
        while (grounded && (at = nativeAt!==undefined?(nativeConsumed?-1:nativeAt):request.clean.indexOf(entity.text, at)) !== -1) {
          nativeConsumed=true;
          if (++matches > MAX_PREPARE_REFINEMENT_MATCHES) throw new ModelExecutionError('input_budget_exhausted');
          const end = at + entity.text.length, run = request.runs.find(value => value.start <= at && value.end >= end);
          let startOriginal:number,endOriginal:number,protectedEntity=entity;
          if(run){startOriginal=run.originalStart+at-run.start;endOriginal=startOriginal+entity.text.length;}
          else if(this.options.allowGroundedOpaqueUnions){
            const spans=[...request.runs.map(value=>({...value,originalEnd:value.originalStart+value.end-value.start,opaque:false})),
              ...request.opaque.map(value=>({...value,opaque:true}))].filter(value=>value.start<end&&value.end>at).sort((a,b)=>a.start-b.start);
            const first=spans[0],last=spans.at(-1);
            if(!first||!last||first.start>at||last.end<end||!spans.some(value=>value.opaque)||
              spans.some((value,index)=>index>0&&(spans[index-1]!.end!==value.start||spans[index-1]!.originalEnd!==value.originalStart))){grounded=false;break;}
            startOriginal=first.originalStart+(first.opaque?0:at-first.start);
            endOriginal=last.opaque?last.originalEnd:last.originalStart+end-last.start;
            const original=origin.text.slice(startOriginal,endOriginal);
            if(!original||original.length>2000){grounded=false;break;}
            // A union has no inferred business entity kind. Every character is
            // from one contiguous private original, including prior masks.
            protectedEntity={text:original,kind:'identity'};
          }else{grounded=false;break;}
          if(!originalBoundaries.has(startOriginal)||!originalBoundaries.has(endOriginal)||
            run&&(origin.text.slice(startOriginal,endOriginal)!==entity.text||mapping.masks.some(mask=>startOriginal<mask.end&&endOriginal>mask.start))){grounded=false;break;}
          let fragmentOf:PrivacyMaskFragment|undefined;
          if(this.options.nerSourceSpans&&run){
            const word=originalMaskedWord(origin.text,startOriginal,endOriginal),owner=projection.blocks.find(block=>block.id===slice.id)!;
            if(word){
              const mask=mapping.opaque.find(value=>{
                const alias=owner.text.slice(value.renderedStart,value.renderedEnd),prior=projection.replacements.find(item=>item.placeholder===alias);
                return prior&&!prior.fragmentOf&&value.originalStart<word.end&&value.originalEnd>word.start&&
                  (value.originalEnd<=startOriginal||value.originalStart>=endOriginal);
              });
              if(mask){
                let placeholder=owner.text.slice(mask.renderedStart,mask.renderedEnd);
                const prior=projection.replacements.find(item=>item.placeholder===placeholder)!;
                const literal=origin.text.slice(mask.originalStart,mask.originalEnd);
                // A global alias may cover case/width variants. Fragment proofs
                // require the exact occurrence, not the alias's first spelling.
                // Bind that already masked range locally; never relax the proof.
                if(prior.original!==literal){
                  const source={sourceRef:slice.id,sourceSha256:privacySourceHash(origin.text),start:mask.originalStart,end:mask.originalEnd};
                  const existing=projection.replacements.find(item=>!item.fragmentOf&&item.original===literal&&
                    item.source?.sourceRef===source.sourceRef&&item.source.sourceSha256===source.sourceSha256&&
                    item.source.start===source.start&&item.source.end===source.end);
                  if(existing)placeholder=existing.placeholder;
                  else{
                    additions.push({text:literal,kind:'identity',source});
                    placeholder=replacementAlias(projection.scopeId,'identity',literal,source);
                  }
                }
                fragmentOf={...word,priorMask:{start:mask.originalStart,end:mask.originalEnd,placeholder}};
              }
            }
          }
          additions.push({...protectedEntity,...(this.options.nerSourceSpans?{native:Boolean(run),source:{sourceRef:slice.id,sourceSha256:privacySourceHash(origin.text),start:startOriginal,end:endOriginal},...(fragmentOf?{fragmentOf}:{})}:{})});
          const rangeKey = JSON.stringify([slice.id, startOriginal, endOriginal, entity.kind]);
          if (!seenRanges.has(rangeKey)) { seenRanges.add(rangeKey); const list = ranges.get(slice.id) ?? []; list.push({ start: startOriginal, end: endOriginal }); ranges.set(slice.id, list); }
          found = true; at++;
        }
        if (!grounded || !found) {
          if (!isolatable.has(slice.id)) deny('privacy_final_entity');
          isolateSourceIds.add(slice.id); break;
        }
        for(const addition of additions){
          const key=JSON.stringify([addition.kind,addition.text,addition.source]),entry=entities.get(key);
          if(entry)entry.owners.add(slice.id);
          else{
            if(entities.size>=MAX_PREPARE_REFINEMENT_ENTITIES)throw new ModelExecutionError('input_budget_exhausted');
            entities.set(key,{entity:addition,owners:new Set([slice.id])});
          }
        }
      }
    }
    // A later failed slice withdraws the complete original, including findings
    // from earlier slices. Shared findings need independent surviving evidence.
    for (const id of isolateSourceIds) ranges.delete(id);
    return { entities: [...entities.values()].filter(value => [...value.owners].some(id => !isolateSourceIds.has(id))).map(value => value.entity), ranges, isolateSourceIds };
  }
  private assertKnownSourceRemoved(text:string,projection:PrivateIntakeProjection){
    // With the document vocabulary, whole vocabulary words are set aside first: the letters of a known finding inside
    // "with" or "公司" are not that finding. Every other occurrence, across spacing, still blocks the request.
    const visible=text.replace(placeholderPattern,'\uFFFC');
    const clean=whitespaceFold(this.documentTerms?visible.replace(/[\p{L}\p{M}]+/gu,word=>genericDocumentTerm(word)?'\uFFFC':word):visible);
    if(projection.replacements.some(value=>{const needle=whitespaceFold(value.fragmentOf?.text??value.original);return needle&&clean.includes(needle);}))deny('privacy_source_entity');
  }
  private assertScopedSourceCoverage(projection:PrivateIntakeProjection){
    if(!usesScopedPrivacy(projection.redactionVersion))return;
    if(!this.options.nerSourceSpans||!projection.sourceCoverage)deny('privacy_canonical_mismatch');
    const coverages=new Map(projection.sourceCoverage.map(value=>[value.sourceRef,value]));
    if(coverages.size!==projection.sourceCoverage.length)deny('privacy_canonical_mismatch');
    for(const replacement of projection.replacements){
      if(replacement.placeholder!==replacementAlias(projection.scopeId,replacement.kind,replacement.original,replacement.source,replacement.fragmentOf)||!validMaskFragment(replacement,projection.replacements))deny('privacy_canonical_mismatch');
      const source=replacement.source;if(!source)continue;
      const owner=projection.blocks.find(block=>block.id===source.sourceRef);
      if(projection.blocks.some(block=>block.id!==source.sourceRef&&block.text.includes(replacement.placeholder)))deny('privacy_canonical_mismatch');
      if(!owner)continue; // A targeted completion may omit this complete source.
      const coverage=coverages.get(source.sourceRef);
      if(!coverage||coverage.sourceSha256!==source.sourceSha256||coverage.redactedSha256!==privacySourceHash(owner.text))deny('privacy_canonical_mismatch');
      let covered=source.start;
      for(const mask of coverage.masks){if(mask.end<=covered)continue;if(mask.start>covered)break;covered=mask.end;if(covered>=source.end)break;}
      if(covered<source.end)deny('privacy_source_entity');
      if(replacement.fragmentOf){
        const prior=replacement.fragmentOf.priorMask;
        if(!coverage.masks.some(mask=>mask.start<=prior.start&&mask.end>=prior.end))deny('privacy_source_entity');
      }
    }
  }
  private async inspectClean(text: string, projection: PrivateIntakeProjection, signal?: AbortSignal, outputContext?: PrivacyOutputContext) {
    const aliases = new Set(projection.replacements.map(value => value.placeholder));
    const found = text.match(placeholderPattern) ?? [];
    if (found.some(alias => !aliases.has(alias)) || /\[\[P_/u.test(withoutPlaceholders(text))) deny('privacy_final_entity');
    // An already-protected span is an opaque boundary, not whitespace. Removing
    // it as a space can falsely bind a later number to an earlier account label.
    // All remaining characters are still scanned, including both sides.
    const clean = text.replace(placeholderPattern, '\uFFFC');
    if (encoded(clean) || detectedRules(clean).length) deny('privacy_sensitive_pattern');
    if (outputContext) {
      // Private inbound prose has a separate source contract; it cannot weaken
      // prepare or the independent final outbound scan below.
      const collisions = summarizeOutputCollisions(clean, projection.replacements);
      if (collisions.length) throw new PrivacyOutputValidationError('privacy_source_entity', outputContext, collisions);
    } else this.assertKnownSourceRemoved(text,projection);
    const observed = await this.scan(clean, signal, !outputContext);
    // A model may label the opaque boundary itself as an identifier. Only an
    // exact generated marker carries no source bytes; mixed spans and literal
    // markers from the source still follow the complete rejection checks.
    const generatedMarkersOnly = !outputContext && found.length > 0 && !withoutPlaceholders(text).includes('\uFFFC');
    assertPrepareObservation(observed);
    const entities = observed.filter(entity => !(generatedMarkersOnly && entity.text === '\uFFFC')).filter(entity =>
      !this.publicVocabulary.has(canonical(entity.text)) || Boolean(outputContext &&
        projection.replacements.some(value => canonical(value.original) === canonical(entity.text))));
    signal?.throwIfAborted();
    return { clean, entities };
  }
  private async checkClean(text: string, projection: PrivateIntakeProjection, signal?: AbortSignal) {
    if ((await this.inspectClean(text, projection, signal)).entities.length) deny('privacy_final_entity');
  }
  private async checkOutput(text: string, projection: PrivateIntakeProjection, context: PrivacyOutputContext, sourceRefs: readonly string[], signal?: AbortSignal) {
    try {
      const observed = await this.inspectClean(text, projection, signal, context);
      assertPrepareObservation(observed.entities);
      const citedAliases = new Set(projection.blocks.filter(block => sourceRefs.includes(block.id)).flatMap(block => block.text.match(placeholderPattern) ?? []));
      const witnessed = new Set(projection.replacements.filter(value => citedAliases.has(value.placeholder) && isLetterOutputEntity(value))
        .map(value => JSON.stringify([value.kind, value.original])));
      const inspect = inspectOutputEntityOccurrences(observed.clean);
      for (const entity of observed.entities) {
        const result = inspect(entity, witnessed.has(JSON.stringify([entity.kind, entity.text])));
        if (!result.accepted) {
          // Only after the existing decision rejects: describe that first entity
          // from current private state, with no repeat lookup, scan or model call.
          const activeAliases = new Set(projection.blocks.flatMap(block => block.text.match(placeholderPattern) ?? []));
          // Visibility is only an exact substring in a mask-separated literal
          // run, not a grapheme/word boundary or a source/semantic witness.
          const visible = projection.blocks.filter(block => block.id !== PRIVACY_COVERAGE_SOURCE_ID &&
            !entity.text.includes('\uFFFC') && block.text.split(placeholderPattern).some(literal => literal.includes(entity.text)));
          const literalVisibility = visible.some(block => sourceRefs.includes(block.id)) ? 'visible_in_cited_literal' :
            visible.length ? 'visible_only_uncited_literal' : 'not_visible_literal';
          throw new PrivacyOutputValidationError('privacy_final_entity', context, [],
            describeOutputNerRejection(entity, result.rejection, projection.replacements, activeAliases, citedAliases, literalVisibility));
        }
      }
    }
    catch (error) {
      if (error instanceof PrivacyOutputValidationError) throw error;
      const diagnostic = error instanceof ModelExecutionError && error.code === 'egress_denied' ? outputValidationReason(error.diagnostic) : undefined;
      if (diagnostic?.success) throw new PrivacyOutputValidationError(diagnostic.data, context);
      throw error;
    }
  }
  async validateOutbound(payload: PreparedModelPayload, raw: PrivateIntakeProjection,
    cloud: {endpoint:string;model:string;policy:{expiresAt:string;version:string}}, canonicalBody: string, signal?: AbortSignal,
    protocol: typeof INTAKE_V2_SCHEMA | 'document-extraction.v1' | 'document-extraction.v2' | 'document-extraction.docx.v1' | 'formal-review.v1' | 'case-assist.v1' | 'case-assist-legal.v1' = INTAKE_V2_SCHEMA) {
    const projection = PrivateIntakeProjectionSchema.parse(raw);
    this.assertScopedSourceCoverage(projection);
    if (Date.parse(cloud.policy.expiresAt) <= Date.now()) throw new ModelExecutionError('egress_denied', false, 'privacy_policy_unavailable');
    if (payload.endpoint !== cloud.endpoint || payload.actualProvider !== 'azure-openai' || payload.model !== cloud.model || payload.body !== canonicalBody || hash(payload.body) !== payload.payloadHash) deny('privacy_canonical_mismatch');
    let body: unknown; try { body = JSON.parse(payload.body); } catch { deny('privacy_canonical_mismatch'); }
    // Canonical equality binds the immutable instructions/schema and approved model
    // identity. A source entity can share a word with that fixed template without
    // transmitting its source relationship. Inspect all dynamic blocks separately.
    if(protocol!==INTAKE_V2_SCHEMA&&protocol!=='document-extraction.v1'&&protocol!=='document-extraction.v2'&&protocol!=='document-extraction.docx.v1'&&protocol!=='formal-review.v1'&&protocol!=='case-assist.v1'&&protocol!=='case-assist-legal.v1')deny('privacy_canonical_mismatch');
    const identifierMarkers=(protocol==='document-extraction.v2'||protocol==='document-extraction.docx.v1')?privacyIdentifierMarkers(projection):undefined;
    const expectedInput = [{ role: 'user', content: [{ type: 'input_text', text: JSON.stringify({ schema: protocol, blocks: intakeCloudReferences(projection.blocks).blocks,...(identifierMarkers?{identifierMarkers}:{}) }) }] }];
    if (!body || typeof body !== 'object' || JSON.stringify((body as {input?:unknown}).input) !== JSON.stringify(expectedInput)) deny('privacy_canonical_mismatch');
    // Wire IDs above are fixed ordinal protocol labels, independent of private
    // IDs and source text. Exact shape equality binds them; body digits and all
    // other dynamic source characters still undergo the unchanged full scan.
    const publicIds=this.verifyPublicTemplates(projection.blocks);
    // Scan each complete decoded source before transport-sized NER chunks, so
    // a spaced private name cannot escape by straddling a chunk boundary.
    for(const block of projection.blocks)if(block.id!==PRIVACY_COVERAGE_SOURCE_ID&&!publicIds.has(block.id))this.assertKnownSourceRemoved(block.text,projection);
    if(usesWholeWordNerWindows(projection.redactionVersion)){
      for (const block of prepareVerificationPlan(projection,publicIds)) await this.checkClean(block.text, projection, signal);
    }else{
      for (const chunk of splitPrivacyBlocks(projection.blocks.filter(block => block.id !== PRIVACY_COVERAGE_SOURCE_ID && !publicIds.has(block.id)))) for (const block of chunk) await this.checkClean(block.text, projection, signal);
    }
    if(identifierMarkers)await this.checkClean(JSON.stringify(identifierMarkers),projection,signal);
    return { payloadHash: payload.payloadHash, policyVersion: cloud.policy.version, dataClasses: ['redacted_intake_text', 'source_reference'] };
  }
  private restore(text: string, projection: PrivateIntakeProjection) {
    const usedAliases = new Set(projection.blocks.flatMap(block => block.text.match(placeholderPattern) ?? []));
    const map = new Map(projection.replacements.filter(value => usedAliases.has(value.placeholder)).map(value => [value.placeholder, value.original]));
    if ((text.match(placeholderPattern) ?? []).some(alias => !map.has(alias)) || /\[\[P_/u.test(withoutPlaceholders(text))) throw new ModelExecutionError('invalid_output', false, 'intake_output_placeholder_source');
    return text.replace(placeholderPattern, value => map.get(value)!);
  }
  private refs(refs: string[], projection: PrivateIntakeProjection) {
    if (new Set(refs).size !== refs.length || refs.some(ref => !projection.blocks.some(block => block.id === ref))) throw new ModelExecutionError('invalid_output', false, 'intake_output_refs');
  }
  async validateReplyBlock(raw: unknown, projection: PrivateIntakeProjection, signal?: AbortSignal, stage: 'stream_reply' | 'final_reply' = 'final_reply'): Promise<IntakeReplyBlock> {
    const parsed = IntakeReplyBlockSchema.safeParse(raw); if (!parsed.success) throw new ModelExecutionError('invalid_output', false, 'intake_reply_schema');
    const block = parsed.data;
    if (block.id === PRIVACY_COVERAGE_NOTICE_ID || block.id === INTAKE_FIELD_NOTICE_ID) throw new ModelExecutionError('invalid_output', false, 'intake_reply_schema');
    this.refs(block.sourceRefs, projection);
    const source = block.sourceRefs.map(ref => projection.blocks.find(value => value.id === ref)!.text).join('\n');
    if ((block.text.match(placeholderPattern) ?? []).some(alias => !source.includes(alias))) throw new ModelExecutionError('invalid_output', false, 'intake_output_placeholder_source');
    // Output is untrusted too: new identifiers must not acquire a local mapping.
    await this.checkOutput(block.text, projection, { stage }, block.sourceRefs, signal);
    const restored = IntakeReplyBlockSchema.safeParse({ ...block, text: this.restore(block.text, projection) });
    if (!restored.success) throw new ModelExecutionError('invalid_output', false, 'intake_output_restored_schema');
    return restored.data;
  }
  async restoreAndValidate(raw: unknown, projection: PrivateIntakeProjection, signal?: AbortSignal, references?: ReturnType<typeof intakeCloudReferences>): Promise<IntakeAssistantOutput> {
    const parsed = IntakeOutputEnvelopeSchema.safeParse(raw); if (!parsed.success) throw new ModelExecutionError('invalid_output', false, 'intake_output_schema');
    const output = parsed.data, replyBlocks: IntakeReplyBlock[] = [];
    if (output.replyBlocks.length > intakeModelReplyLimit(!!projection.withheldSources?.length)) throw new ModelExecutionError('invalid_output', false, 'intake_output_schema');
    for (const block of output.replyBlocks) replyBlocks.push(await this.validateReplyBlock(references ? references.restoreReplyBlock(block) : block, projection, signal));
    const fieldSuggestions = [];
    const issues: IntakeFieldIssue[] = [];
    const names = output.fieldSuggestions.map(intakeSuggestedField);
    for (const rawField of output.fieldSuggestions) {
      signal?.throwIfAborted();
      const name = intakeSuggestedField(rawField);
      // Conflicting suggestions never select a winner by order.
      if (name && names.filter(value => value === name).length > 1) { issues.push({field: name, reason: 'duplicate_field'}); continue; }
      const parsedField = IntakeFieldSuggestionSchema.safeParse(rawField);
      if (!parsedField.success) { issues.push({field: name, reason: 'invalid_format'}); continue; }
      try {
        const field = references ? references.restoreFieldSuggestion(parsedField.data) : parsedField.data;
        if (field.sourceRefs.includes(PRIVACY_COVERAGE_SOURCE_ID)) throw new ModelExecutionError('invalid_output', false, 'intake_output_refs');
        this.refs(field.sourceRefs, projection); await this.checkOutput(field.value, projection, { stage: 'field', field: field.field }, field.sourceRefs, signal);
        // A model cannot silently move a protected identifier from unrelated evidence.
        const source = field.sourceRefs.map(ref => projection.blocks.find(block => block.id === ref)!.text).join('\n');
        if ((field.value.match(placeholderPattern) ?? []).some(alias => !source.includes(alias))) throw new ModelExecutionError('invalid_output', false, 'intake_output_placeholder_source');
        if (field.field === 'scenario' && !/(境外贷款|overseas_loan)/u.test(source)) throw new ModelExecutionError('invalid_output', false, 'intake_output_scenario_source');
        if ((field.field === 'reference' || field.field === 'customerNumber') && !source.includes(field.value)) throw new ModelExecutionError('invalid_output', false, 'intake_output_reference_source');
        const sourceNumbers = new Set(numberTokens(source).filter(value => value !== undefined));
        for (const number of numberTokens(field.value)) {
          if (number === undefined || !sourceNumbers.has(number)) throw new ModelExecutionError('invalid_output', false, 'intake_output_number_source');
        }
        const restoredValue = this.restore(field.value, projection);
        try { intakeFieldValue(field.field, restoredValue); IntakeFieldSuggestionSchema.parse({ ...field, value: restoredValue }); }
        catch { throw new ModelExecutionError('invalid_output', false, 'intake_output_restored_schema'); }
        if (!hasIntakeFormEvidence(field.field, restoredValue, this.restore(source, projection))) throw new ModelExecutionError('invalid_output', false, 'intake_output_reference_source');
        fieldSuggestions.push({ ...field, value: restoredValue });
      } catch (error) {
        const reason = recoverableIntakeFieldError(error);
        if (!reason) throw error;
        issues.push({field: name, reason});
      }
    }
    const questions: string[] = [];
    for (const question of output.questions) { await this.checkOutput(question, projection, { stage: 'question' }, [], signal); questions.push(this.restore(question, projection)); }
    const notice = intakeFieldNotice(issues); if (notice) replyBlocks.push(notice);
    const restored = IntakeAssistantOutputSchema.safeParse({ replyBlocks, fieldSuggestions, questions });
    if (!restored.success) throw new ModelExecutionError('invalid_output', false, 'intake_output_restored_schema'); return restored.data;
  }
}
