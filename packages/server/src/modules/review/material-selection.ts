import type {ReviewEvidence, ReviewMaterial} from '@hsbc/contracts/review';
import {AppError} from '../../shared/errors.js';

/** Legacy evidence is accepted only when its fixed source identifies one adoption. */
export function selectEvidenceMaterial(materials: ReviewMaterial[], evidence: ReviewEvidence): ReviewMaterial {
  const matches = materials.filter(material => material.operation === 'adopt'
    && material.documentVersionId === evidence.documentVersionId
    && material.parseRevision === evidence.parseRevision && material.directoryRevision === evidence.directoryRevision
    && (!evidence.materialScope || material.logicalDocumentId === evidence.materialScope.logicalDocumentId));
  if (!matches.length) throw new AppError(409, 'evidence_not_in_material_snapshot');
  if (matches.length !== 1) throw new AppError(409, 'review_material_scope_required');
  return matches[0]!;
}


export function sameLogicalExtent(left: {pageNumbers:number[];regionIds?:string[];sourceNodeIds?:string[]}, right?: {pageNumbers:number[];regionIds?:string[];sourceNodeIds?:string[]}): boolean {
  return Boolean(right && (['pageNumbers','regionIds','sourceNodeIds'] as const).every(key => JSON.stringify([...(left[key]??[])].sort()) === JSON.stringify([...(right[key]??[])].sort())));
}
