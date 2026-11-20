import type {DocumentPageArtifact} from '@hsbc/contracts/documents';
import {sha256} from '../../document/evidence.js';
import {normalizeReviewValue} from './normalization.js';
const labelled=/^\s*(?:Date|日期)\s*[:：]\s*((?:中華民國|中华民国|民國|民国)?\s*\d{2,4}\s*年\s*\d{1,2}\s*月\s*\d{1,2}\s*日)\s*$/iu;
/** A source-text disagreement outside the date does not veto two independent,
 * spatially coincident readings of the exact same date. Other values never use this. */
export function personalDateRegions(page:DocumentPageArtifact){
 if(page.processing.ocrSimulated||page.status==='failed')return [];
 const regions=page.regions.filter(r=>r.kind==='text'&&r.raw_text&&labelled.test(r.raw_text));
 const candidates=regions.filter(r=>r.processing_status==='ready'&&!r.coverage_gaps.length&&page.canonicalRegionIds.includes(r.region_id)&&
  r.document_version_id===page.page.document_version_id&&r.parse_revision===page.page.parse_revision&&r.page_asset_id===page.page.page_asset_id&&
  sha256(r.raw_text!)===r.raw_text_sha256&&r.polygons.length&&['pp_ocr','vl_ocr','native_pdf'].includes(r.source)&&(r.source!=='native_pdf'||page.nativeTrust==='validated_geometry_and_visibility'));
 const date=(r:typeof candidates[number])=>normalizeReviewValue(labelled.exec(r.raw_text!)![1]!,'date');
 // An unreadable channel or two genuinely different dates cannot be discarded.
 if(candidates.length!==regions.length||candidates.some(r=>date(r).status==='pending'||!date(r).value)||new Set(candidates.map(r=>date(r).value)).size!==1)return [];
 const box=(r:typeof candidates[number])=>{const p=r.polygons.flat();return [Math.min(...p.map(p=>p[0])),Math.max(...p.map(p=>p[0])),Math.min(...p.map(p=>p[1])),Math.max(...p.map(p=>p[1]))];};
 return candidates.filter(r=>candidates.some(other=>{if(r.source===other.source)return false;const a=box(r),b=box(other);return Math.max(a[0]!,b[0]!)<Math.min(a[1]!,b[1]!)&&Math.max(a[2]!,b[2]!)<Math.min(a[3]!,b[3]!);})).map(region=>({region,value:labelled.exec(region.raw_text!)![1]!}));
}
