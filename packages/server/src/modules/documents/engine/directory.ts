import type { DocumentBundle, DocumentEngineConfig, DocumentPageArtifact, DocumentScope } from '@hsbc/contracts/documents';
import { sha256 } from '../../../document/evidence.js';

type LogicalDocument = DocumentBundle['logicalDocuments'][number];
export const DIRECTORY_POLICY = 'explicit-title-boundaries-v1';
export const CLOUD_DIRECTORY_POLICY = 'validated-cloud-classification-v1';
export interface DirectoryPage {
  pageNumber: number;
  regionIds: string[];
  headings: Array<{ regionId: string; text: string }>;
}

/** A whole configured title is boundary evidence. Body mentions and a classifier's
 * region-level category are not evidence that a new document starts here. */
export function documentTitleCandidates(text: string, config: DocumentEngineConfig): string[] {
  if (!text || text.length > 160) return [];
  const normalize = (value: string) => value.normalize('NFKC').trim().replace(/\s+/gu, ' ').toLocaleLowerCase();
  const title = normalize(text);
  return config.taxonomy.filter(label => label.keywords.some(keyword => normalize(keyword) === title)).map(label => label.id);
}

export function directoryPage(page: DocumentPageArtifact): DirectoryPage {
  const canonical = new Set(page.canonicalRegionIds);
  return { pageNumber: page.page.page_number, regionIds: page.canonicalRegionIds,
    headings: page.regions.filter(region => canonical.has(region.region_id) && region.kind === 'text' && region.raw_text && region.raw_text.length <= 160)
      .map(region => ({ regionId: region.region_id, text: region.raw_text! })) };
}

/** The stored OCR/classification evidence remains untouched. Unclassified content
 * continues until an explicit title supplies a boundary; page breaks alone do not. */
export function createLogicalDirectory(pages: DirectoryPage[], config: DocumentEngineConfig, scope: DocumentScope, revision: string): LogicalDocument[] {
  const result: LogicalDocument[] = []; let active: LogicalDocument | undefined;
  for (const page of pages) {
    const headings = new Map(page.headings.map(heading => [heading.regionId, documentTitleCandidates(heading.text, config)]));
    for (const regionId of page.regionIds) {
      const candidates = headings.get(regionId) ?? [], labelId = candidates.length === 1 ? candidates[0]! : null;
      const status = candidates.length > 1 ? 'conflict' : labelId ? 'candidate' : 'unknown';
      const samePagePreamble = active?.status === 'unknown' && active.pageNumbers.length === 1 && active.pageNumbers[0] === page.pageNumber;
      if (active && samePagePreamble && candidates.length) {
        active.labelId = labelId; active.label = config.taxonomy.find(label => label.id === labelId)?.label ?? '类别待确认'; active.status = status;
      } else if (!active || (candidates.length > 1 && active.status !== 'conflict') || (labelId && labelId !== active.labelId)) {
        active = { id: `logical:${sha256(JSON.stringify([scope.documentVersionId, scope.parseRevision, revision, regionId]))}`,
          labelId, label: config.taxonomy.find(label => label.id === labelId)?.label ?? '类别待确认', status,
          pageNumbers: [], regionIds: [], source: 'classification' };
        result.push(active);
      }
      active.regionIds.push(regionId);
      if (!active.pageNumbers.includes(page.pageNumber)) active.pageNumbers.push(page.pageNumber);
    }
  }
  return result;
}

export interface DirectoryDisplayEntry extends LogicalDocument { sourceLogicalDocumentIds: string[] }
/** Navigation-only projection. Never use its IDs for persisted index filters or
 * submit it as a directory correction without an explicit user editing action. */
export function displayLogicalDirectory(bundle: DocumentBundle, pages: DirectoryPage[], config: DocumentEngineConfig,
  options: { preserveClassification?: boolean } = {}): DirectoryDisplayEntry[] {
  const stored = bundle.logicalDocuments.filter(document => !document.id.startsWith('source-document:'));
  const unchanged = () => stored.map(document => ({ ...document, sourceLogicalDocumentIds: [document.id] }));
  // A content-first checkpoint is already authoritative even when extraction
  // subsequently fails and no completed extraction receipt exists.
  if (bundle.classificationMode === 'content-first-v1' || options.preserveClassification || stored.some(document => document.source === 'manual') || bundle.coverageGaps.some(gap =>
    ['preview_revision_or_visibility_review_required', 'preview_unavailable_source_review_required'].includes(gap))) return unchanged();
  const owners = new Map<string, LogicalDocument>();
  for (const document of stored) for (const id of document.regionIds) {
    if (owners.has(id)) throw new Error('p2_directory_region_conflict');
    owners.set(id, document);
  }
  const seen = new Set<string>();
  for (const page of pages) for (const id of page.regionIds) {
    if (seen.has(id) || !owners.get(id)?.pageNumbers.includes(page.pageNumber)) throw new Error('p2_directory_projection_source_mismatch');
    seen.add(id);
  }
  if (seen.size !== owners.size) throw new Error('p2_directory_projection_source_mismatch');
  return createLogicalDirectory(pages, config, bundle.scope, bundle.directoryRevision).map(document => ({ ...document,
    id: `directory-view:${sha256(JSON.stringify([DIRECTORY_POLICY, bundle.scope, bundle.directoryRevision, document.regionIds]))}`,
    sourceLogicalDocumentIds: [...new Set(document.regionIds.map(id => owners.get(id)!.id))] }));
}
