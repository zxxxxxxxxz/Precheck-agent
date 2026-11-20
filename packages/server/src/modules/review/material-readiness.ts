import {DOCUMENT_CLASSIFICATION_PROJECTION} from './classification-projection.js';
import {fixedMaterialType} from '../documents/content-classification.js';
import {materialListIds} from '../materials/review-scope.js';
import type {ReviewEvidence,ReviewMaterial,ReviewObject} from '@hsbc/contracts/review';
import type {DB} from '../../infrastructure/database/client.js';

/** A fact's source must have been explicitly assigned to this company object.
 * Matching a role or belonging to the same case does not establish ownership. */
export function corporateEvidenceBelongsToObject(object:Pick<ReviewObject,'role'|'evidence'>,evidence:ReviewEvidence[]):boolean {
  return object.role!=='corporate_guarantee'||evidence.every(source=>object.evidence.some(assigned=>
    assigned.documentVersionId===source.documentVersionId&&assigned.parseRevision===source.parseRevision&&assigned.directoryRevision===source.directoryRevision&&(!source.materialScope||!assigned.materialScope||source.materialScope.logicalDocumentId===assigned.materialScope.logicalDocumentId)));
}

/** Joint personal guarantees share a PDF but not every signer's source region.
 * Common clauses may be assigned explicitly to both people. */
export function reviewEvidenceBelongsToObject(object:Pick<ReviewObject,'role'|'evidence'|'automaticAttribution'>,evidence:ReviewEvidence[]):boolean {
 if(object.role!=='personal_guarantee'&&!object.automaticAttribution)return corporateEvidenceBelongsToObject(object,evidence);
 return evidence.every(source=>object.evidence.some(assigned=>
  assigned.documentVersionId===source.documentVersionId&&assigned.parseRevision===source.parseRevision&&assigned.directoryRevision===source.directoryRevision&&(!source.materialScope||!assigned.materialScope||source.materialScope.logicalDocumentId===assigned.materialScope.logicalDocumentId)&&
  (source.anchorId?assigned.anchorId===source.anchorId:!!source.sourceNodeId&&assigned.sourceNodeId===source.sourceNodeId)));
}

export interface PendingReviewMaterial {
  documentVersionId:string;sourceSha256:string;parseRevision:string|null;
  processingState:string;taxonomyIds:string[];unclassified:boolean;
}

/** Freeze unresolved files separately from usable evidence. Unknown file types
 * cannot prove absence; filenames never establish a business classification. */
export async function pendingReviewMaterials(db:DB,caseId:string,decisions:ReviewMaterial[],roundId:string|null=null):Promise<PendingReviewMaterial[]> {
  // Readiness needs classification metadata, never the original text/chunks.
  // Keep this projection bounded when it is read on the materials page.
  const rows=(await db.query(`SELECT d.id,d.sha256,d.current_parse_job_id,d.parse_status,a.body
    FROM business.document_versions d LEFT JOIN LATERAL (
      SELECT jsonb_build_object(${DOCUMENT_CLASSIFICATION_PROJECTION}) AS body FROM business.document_artifacts WHERE job_id=d.current_parse_job_id ORDER BY directory_revision DESC LIMIT 1
    ) a ON true WHERE d.case_id=$1 AND d.round_id IS NOT DISTINCT FROM $2::uuid ORDER BY d.id`,[caseId,roundId])).rows;
  const included=await materialListIds(db,caseId,roundId);
  return rows.filter(row=>included===null||included.includes(row.id)).flatMap(row=>{
    const choices=decisions.filter(d=>d.documentVersionId===row.id);
    if(row.body?.classificationMode==='content-first-v1'&&!fixedMaterialType(row.body))return [{documentVersionId:row.id,sourceSha256:row.sha256,parseRevision:row.current_parse_job_id,processingState:row.parse_status,taxonomyIds:[],unclassified:true}];
    if(choices.some(d=>!d.logicalDocumentId))return [];
    const logicals=(row.body?.logicalDocuments??[]) as Array<{id:string;labelId:string|null;status:string}>;
    const pending=logicals.filter(d=>!choices.some(c=>c.logicalDocumentId===d.id));
    if(logicals.length&&!pending.length)return [];
    return [{documentVersionId:row.id,sourceSha256:row.sha256,parseRevision:row.current_parse_job_id,
      processingState:row.parse_status,taxonomyIds:[...new Set(pending.flatMap(d=>d.labelId?[d.labelId]:[]))].sort(),
      unclassified:!logicals.length||pending.some(d=>!d.labelId||!['candidate','confirmed'].includes(d.status))}];
  });
}

export function pendingMaterialForType(material:PendingReviewMaterial,taxonomyId:string):boolean {
  return material.unclassified||material.taxonomyIds.includes(taxonomyId);
}
