import {candidateAdoptionValue, candidateRequiredEvidenceGroups, DocumentFieldObservationSchema} from '@hsbc/contracts/documents';
import {assessFieldQuality} from '@hsbc/contracts/field-quality';
import type {ReviewFieldDefinition} from '@hsbc/contracts/review-config';
import type {DB} from '../../infrastructure/database/client.js';
import {getPublished} from '../review/configuration.js';
import {materialProjection, reviewMaterials} from '../review/material-scope.js';
import {partyDisplayNames, type PartyDisplayCandidate} from './party-display.js';

type PartyRole = 'borrowers' | 'guarantors';
// Only fields that explicitly identify the party's role. Company names on
// registration documents and compound facility clauses cannot establish it.
const partyFields: Record<string, PartyRole> = {
  cgt_field_7: 'borrowers', cgt_field_27: 'borrowers', cgt_facility_borrower: 'borrowers',
  cgt_field_9: 'guarantors', cgt_field_14: 'guarantors', cgt_field_24: 'guarantors', cgt_facility_guarantor: 'guarantors',
  pg_field_5: 'guarantors', pg_field_6: 'borrowers',
  facility_borrower: 'borrowers', mortgage_chargor: 'guarantors',
};
const explicitRoles: Record<string, PartyRole> = {borrower: 'borrowers', guarantor: 'guarantors', rm_guarantor: 'guarantors', rm_guaranteed_company: 'borrowers'};
export function extractedPartyNames(fields: unknown[], definitions: ReviewFieldDefinition[], anchorIds: string[]) {
  const candidates = extractedPartyCandidates(fields, definitions, anchorIds);
  return {borrowers: partyDisplayNames(candidates.borrowers), guarantors: partyDisplayNames(candidates.guarantors)};
}
function extractedPartyCandidates(fields: unknown[], definitions: ReviewFieldDefinition[], anchorIds: string[]) {
  const names: Record<PartyRole, PartyDisplayCandidate[]> = {borrowers: [], guarantors: []};
  const anchors = new Set(anchorIds);
  for (const raw of fields) {
    const parsed = DocumentFieldObservationSchema.safeParse(raw);
    if (!parsed.success) continue;
    const field = parsed.data, definition = definitions.find(d => d.id === field.fieldId);
    if (!definition || definition.valueKind !== 'party_name') continue;
    const role = partyFields[definition.id] ?? explicitRoles[definition.roleEvidence?.role ?? ''];
    if (!role || assessFieldQuality(field, {multiple: true, valueGrounded: true, requireSemanticFilter: ['cloud_grounded_extract', 'private_candidate_filter'].includes(definition.recipe.mode)}).state !== 'usable') continue;
    for (const candidate of field.candidates) {
      if (candidateRequiredEvidenceGroups(candidate).some(group => !group.length || group.some(id => !anchors.has(id)))) continue;
      const name = candidateAdoptionValue(candidate).trim();
      const association = candidate.nameAssociation;
      const aliases = association?.evidenceAnchorIds.length && association.evidenceAnchorIds.every(id => anchors.has(id)) &&
        association.sourceNames?.every(source => source.anchorIds.every(id => anchors.has(id))) ? association.names : undefined;
      if (name && name.length <= 500) names[role].push({value: name, confidence: candidate.confidence, aliases,
        choiceKey: field.objectId ? `object:${field.objectId}` : field.valueMultiplicity === 'single' ? `field:${field.documentVersionId}:${field.parseRevision}:${field.id}` : undefined});
    }
  }
  return names;
}

/** Called only after evidence:read authorization. No writes, object creation or
 * fact adoption; submitted rounds use the same pinned materials as review. */
export async function caseExtractedParties(db: DB, c: {id: string; configuration_release_id: string | null; current_round_id: string | null; review_rounds_enabled: boolean; closed_at?: unknown}) {
  const result: Record<PartyRole, PartyDisplayCandidate[]> = {borrowers: [], guarantors: []};
  if (!c.configuration_release_id || (c.review_rounds_enabled && !c.current_round_id)) return {borrowers: [], guarantors: []};
  const release = await getPublished(db, c.configuration_release_id);
  const materials = (await reviewMaterials(db, c.id, c.current_round_id)).filter(m => m.operation === 'adopt');
  const seen = new Set<string>();
  for (const material of materials) {
    if (seen.has(material.documentVersionId) || !material.parseRevision || !material.directoryRevision) continue;
    seen.add(material.documentVersionId);
    const artifact = (await db.query(`SELECT sha256, body->'fields' AS fields, body->'anchors' AS anchors, body->'sourceAnchors' AS source_anchors, body->'logicalDocuments' AS logical_documents
      FROM business.document_artifacts WHERE job_id=$1 AND directory_revision=$2`, [material.parseRevision, material.directoryRevision])).rows[0];
    if (!artifact || artifact.sha256 !== material.artifactHash) continue;
    const projection = await materialProjection(db, material.documentVersionId, material.parseRevision, material.directoryRevision, material.projectionJobId);
    if (projection.hash !== material.projectionHash) continue;
    const job = (await db.query('SELECT configuration_release_id, state FROM business.document_jobs WHERE id=$1', [projection.jobId ?? material.parseRevision])).rows[0];
    if (job?.configuration_release_id !== release.documentConfigurationId || !['ready', 'partial'].includes(job?.state)) continue;
    const fields = projection.jobId ? projection.items : artifact.fields;
    const anchors = [...(artifact.anchors ?? []), ...(artifact.source_anchors ?? []), ...projection.anchors, ...(projection.sourceAnchors ?? [])]
      .filter(a => a.document_version_id === material.documentVersionId && a.parse_revision === material.parseRevision).map(a => a.anchor_id);
    const scopes = materials.filter(m => m.documentVersionId === material.documentVersionId);
    const definitions = release.manifest.fields.filter(d => d.taxonomyIds?.some(type => scopes.some(m => m.documentTypeId === type)));
    const observations = (Array.isArray(fields) ? fields : []).filter(f => f?.documentVersionId === material.documentVersionId && f?.parseRevision === material.parseRevision).flatMap(raw => {
      const parsed = DocumentFieldObservationSchema.safeParse(raw);
      if (!parsed.success) return [];
      const field = parsed.data, definition = definitions.find(d => d.id === field.fieldId);
      const relevant = scopes.filter(m => definition?.taxonomyIds?.includes(m.documentTypeId));
      if (relevant.some(m => !m.logicalDocumentId)) return [field];
      const included = new Set(relevant.map(m => m.logicalDocumentId));
      const logicals = artifact.logical_documents ?? [];
      // For combined files, a name must be confined to an included logical
      // document. Shared or excluded pages remain unresolved in this summary.
      return [{...field, candidates: field.candidates.filter(candidate => candidate.pageNumbers.length && candidate.pageNumbers.every(page => {
        const containing = logicals.filter((l: {pageNumbers: number[]}) => l.pageNumbers.includes(page));
        return containing.length > 0 && containing.every((l: {id: string}) => included.has(l.id));
      }))}];
    });
    const names = extractedPartyCandidates(observations, definitions, anchors);
    for (const role of ['borrowers', 'guarantors'] as const) result[role].push(...names[role]);
  }
  return {borrowers: partyDisplayNames(result.borrowers), guarantors: partyDisplayNames(result.guarantors)};
}
