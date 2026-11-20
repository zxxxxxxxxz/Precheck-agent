import type {DocumentFieldObservation} from '@hsbc/contracts/documents';
export {fieldCandidateDisplayText} from '@hsbc/contracts/document-presentation';

type Candidate = DocumentFieldObservation['candidates'][number];

/** Only explicit candidate-level evidence may mark a row; amount-only limits are valid. */
export function candidateSourceReviewLabel(candidate: Candidate): string | undefined {
  return candidate.sourceReviewCodes?.includes('insurance_name_source_disagreement') ? '险名待核' : undefined;
}

/** Additional original clauses remain separate; matching text never lets one
 * independent source link stand in for another. */
export function candidateSupplementSources(candidate: Candidate): {label: string; quote: string; anchorIds: string[]}[] {
  const authorization = (candidate.authorizationEvidence?.sources ?? []).map(source => ({
    label: source.kind === 'definition' ? '定义范围' : '授权条款', quote: source.quote, anchorIds: source.anchorIds,
  }));
  const correction = candidate.sourceCorrectionEvidence;
  const tableParty = candidate.tablePartyEvidence;
  return [...authorization, ...(correction ? [
    {label: '原识别段', quote: correction.originalSegment.quote, anchorIds: correction.originalSegment.anchorIds},
    {label: '更正原文', quote: correction.nativeLine.quote, anchorIds: correction.nativeLine.anchorIds},
    {label: '同页核对', quote: correction.ocrLine.quote, anchorIds: correction.ocrLine.anchorIds},
  ] : []), ...(tableParty ? [
    {label: '角色栏', quote: tableParty.role.quote, anchorIds: tableParty.role.anchorIds},
    {label: '名称栏', quote: tableParty.formalName.quote, anchorIds: tableParty.formalName.anchorIds},
    {label: '名称原文', quote: tableParty.name.quote, anchorIds: tableParty.name.anchorIds},
  ] : [])];
}
