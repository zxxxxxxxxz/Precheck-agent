import type {DocumentPageArtifact} from '@hsbc/contracts/documents';
import type {DocumentRegion} from '@hsbc/contracts/evidence';
import {anchorsForText,sha256,validateAnchorSource} from '../../document/evidence.js';
import {formBox,type FormLine} from './director-notice-source.js';

const unspaced=(text:string)=>text.replace(/\s/gu,'');

/** Independently positioned native runs must reproduce the entire OCR line.
 * This corroborates one visible OCR line, not the PDF's global text trust. */
export function guaranteeNativeLineAgreement(page:DocumentPageArtifact,line:FormLine):DocumentRegion[] {
  const native=page.regions.filter(r=>{
    const box=formBox(r);
    if(r.source!=='native_pdf'||r.kind!=='text'||r.processing_status!=='ready'||!r.raw_text||
      !page.canonicalRegionIds.includes(r.region_id)||/word[:_-]/u.test(r.source_id)||
      r.raw_text_sha256!==sha256(r.raw_text)||r.document_version_id!==page.scope.documentVersionId||
      r.parse_revision!==page.scope.parseRevision||r.page_asset_id!==page.page.page_asset_id||!box||
      box.x<line.box.x-3||box.x+box.width>line.box.x+line.box.width+3||
      Math.abs(box.y+box.height/2-line.box.y-line.box.height/2)>Math.min(box.height,line.box.height)*.5)return false;
    try{const a=anchorsForText(page.page,[r],r.raw_text);for(const anchor of a)validateAnchorSource(anchor,page.page,page.regions);return a.length>0;}catch{return false;}
  }).sort((a,b)=>formBox(a)!.x-formBox(b)!.x);
  return native.length&&unspaced(native.map(r=>r.raw_text!).join(''))===unspaced(line.text)?native:[];
}
