import {materialScope} from './material-adoption.ts';
import {candidateAdoptionValue, candidateRequiredEvidenceGroups, type DocumentFieldObservation, type DocumentSourceAnchor} from '@hsbc/contracts/documents';
import type {EvidenceAnchor} from '@hsbc/contracts/evidence';
import type {ReviewEvidence, ReviewFact, ReviewMaterial} from '@hsbc/contracts/review';

export interface CandidateFactChoice {
  key: string;
  fieldId: string;
  rawValue: string;
  evidence: ReviewEvidence[];
  ref: NonNullable<ReviewFact['candidateRef']>;
}

/** Adoption retains every separate source segment; a cleaned label is never the fact value. */
export function candidateFactChoices(field: DocumentFieldObservation, sourceAnchors: readonly EvidenceAnchor[], material: ReviewMaterial, nativeAnchors: readonly DocumentSourceAnchor[] = []): CandidateFactChoice[] {
  if (field.semanticFilter?.state !== 'completed' || !material.parseRevision || !material.projectionHash
    || field.documentVersionId !== material.documentVersionId || field.parseRevision !== material.parseRevision) return [];
  return field.semanticFilter.originalCandidates.flatMap(candidate => {
    const decision = field.semanticFilter!.decisions.find(entry => entry.candidateId === candidate.candidateId && entry.decision === 'selected');
    if (!decision) return [];
    const native = field.semanticFilter!.version === 'azure-grounded-docx-v1';
    const anchors = (native ? nativeAnchors : sourceAnchors).filter(anchor => decision.anchorIds.includes(anchor.anchor_id)
      && anchor.document_version_id === material.documentVersionId && anchor.parse_revision === material.parseRevision);
    const rawValue = candidateAdoptionValue(candidate);
    if (!anchors.length || native && anchors.length !== new Set(decision.anchorIds).size || !rawValue.trim() || candidateRequiredEvidenceGroups(candidate).some(group => !group.some(id => anchors.some(anchor => anchor.anchor_id === id)))) return [];
    return [{
      key: `${field.id}:${candidate.candidateId}`, fieldId: field.fieldId, rawValue,
      evidence: anchors.map(anchor => ({documentVersionId: material.documentVersionId, parseRevision: material.parseRevision!, directoryRevision: material.directoryRevision, materialScope:materialScope(material), ...('sourceNodeId' in anchor ? {sourceNodeId: anchor.sourceNodeId} : {anchorId: anchor.anchor_id})})),
      ref: {observationId: field.id, candidateId: candidate.candidateId, projectionHash: material.projectionHash!},
    }];
  });
}
