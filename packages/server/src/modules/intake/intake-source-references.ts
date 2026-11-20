import { IntakeAssistantOutputSchema, IntakeReplyBlockSchema, type IntakeFieldSuggestion, type IntakeSourceBlock } from '@hsbc/contracts/intake';
import { ModelExecutionError } from '../../model/gateway.js';

export const PRIVACY_COVERAGE_SOURCE_ID = 'privacy:withheld';

/** Cloud references depend only on retained source order, never private IDs or text. */
export function intakeCloudReferences(blocks: readonly IntakeSourceBlock[]) {
  if (new Set(blocks.map(block => block.id)).size !== blocks.length) throw new ModelExecutionError('egress_denied', false, 'privacy_canonical_mismatch');
  const localByCloud = new Map<string, string>(); let ordinal = 0;
  const cloudBlocks = blocks.map(block => {
    const id = block.id === PRIVACY_COVERAGE_SOURCE_ID ? PRIVACY_COVERAGE_SOURCE_ID : `source:${++ordinal}`;
    localByCloud.set(id, block.id);
    return { id, text: block.text };
  });
  const restoreRefs = (refs: string[]) => {
    // No fallback to original IDs, numeric coercion, duplicate removal or fuzzy
    // lookup: only exact references actually supplied in this request are valid.
    if (new Set(refs).size !== refs.length || refs.some(ref => !localByCloud.has(ref))) throw new ModelExecutionError('invalid_output', false, 'intake_output_refs');
    return refs.map(ref => localByCloud.get(ref)!);
  };
  const restoreReplyBlock = (raw: unknown) => {
    const parsed = IntakeReplyBlockSchema.safeParse(raw);
    if (!parsed.success) throw new ModelExecutionError('invalid_output', false, 'intake_reply_schema');
    return { ...parsed.data, sourceRefs: restoreRefs(parsed.data.sourceRefs) };
  };
  const restoreOutput = (raw: unknown) => {
    const parsed = IntakeAssistantOutputSchema.safeParse(raw);
    if (!parsed.success) throw new ModelExecutionError('invalid_output', false, 'intake_output_schema');
    return { ...parsed.data, replyBlocks: parsed.data.replyBlocks.map(restoreReplyBlock),
      fieldSuggestions: parsed.data.fieldSuggestions.map(field => ({ ...field, sourceRefs: restoreRefs(field.sourceRefs) })) };
  };
  const restoreFieldSuggestion = (field: IntakeFieldSuggestion): IntakeFieldSuggestion => ({ ...field, sourceRefs: restoreRefs(field.sourceRefs) });
  return { blocks: cloudBlocks, restoreReplyBlock, restoreFieldSuggestion, restoreOutput };
}
