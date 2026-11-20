import {createHash} from 'node:crypto';
import type {DocumentPageArtifact} from '@hsbc/contracts/documents';
import type {ReviewFieldDefinition} from '@hsbc/contracts/review-config';
import {documentHtmlCellSpans} from '../../document/html-cells.js';

const fold=(text:string)=>text.normalize('NFKC').replace(/\s/gu,'').toLowerCase();
/** A two-cell source row proves an amount's label without borrowing an earlier
 * occurrence of the same number. This does not synthesize values or anchors. */
export function labelledTableAmount(page:DocumentPageArtifact,value:string,definition:ReviewFieldDefinition):boolean {
 if(definition.type!=='amount'||definition.valueKind!=='amount'||!definition.requireLabel)return false;
 for(const region of page.regions){
  const raw=region.raw_text;
  if(region.kind!=='table'||!page.canonicalRegionIds.includes(region.region_id)||!raw||region.processing_status!=='ready'||
   region.raw_text_sha256!==createHash('sha256').update(raw).digest('hex')||region.document_version_id!==page.scope.documentVersionId||
   region.parse_revision!==page.scope.parseRevision||region.page_asset_id!==page.page.page_asset_id||region.polygons.length!==1||
   /\b(?:rowspan|colspan)\s*=/iu.test(raw))continue;
  const points=region.polygons[0]!;
  if(points.length<4||Math.max(...points.map(p=>p[0]))<=Math.min(...points.map(p=>p[0]))||
   Math.max(...points.map(p=>p[1]))<=Math.min(...points.map(p=>p[1])))continue;
  const spans=documentHtmlCellSpans(raw);if(!spans.length)continue;
  for(const row of raw.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr\s*>/giu)){
   const cells=spans.filter(cell=>cell.start>=row.index!&&cell.end<=row.index!+row[0].length);
   if(cells.length!==2)continue;
   const label=raw.slice(cells[0]!.start,cells[0]!.end).replace(/<br\s*\/?>/giu,'\n').replace(/[:：]\s*$/u,'');
   const amount=raw.slice(cells[1]!.start,cells[1]!.end);
   if(/[<>]/u.test(label)||/[<>]/u.test(amount)||!definition.aliases.some(alias=>fold(alias)===fold(label))||
    definition.excludedLabels?.some(excluded=>fold(label).includes(fold(excluded))))continue;
   if(fold(amount)===fold(value))return true;
  }
 }
 return false;
}
