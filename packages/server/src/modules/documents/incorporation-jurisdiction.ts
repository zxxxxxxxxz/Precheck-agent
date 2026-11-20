import type {DocumentPageArtifact} from '@hsbc/contracts/documents';
import {anchorsForText,sha256,validateAnchorSource} from '../../document/evidence.js';

/** Recover the literal jurisdiction of incorporation, never an address, company
 * name or registration identifier. Each returned value has its own source span. */
export function pageIncorporationJurisdictions(page:DocumentPageArtifact){
 const result:Array<{value:string;context:string;anchors:ReturnType<typeof anchorsForText>;contextAnchors:ReturnType<typeof anchorsForText>}>=[];
 if(page.status==='failed'||page.page.document_version_id!==page.scope.documentVersionId||page.page.parse_revision!==page.scope.parseRevision)return result;
 const regions=page.regions.filter(r=>r.kind==='text'&&r.processing_status==='ready'&&r.raw_text&&r.raw_text_sha256===sha256(r.raw_text)&&
  r.document_version_id===page.scope.documentVersionId&&r.parse_revision===page.scope.parseRevision&&r.page_asset_id===page.page.page_asset_id);
 if(!regions.some(r=>/certificate\s+of\s+incorporation|公司[註注]冊證明書|公司注册证明书/iu.test(r.raw_text!)))return result;
 for(const region of regions){
  const patterns=[/\b(?:is\s+(?:this\s+day\s+)?|was\s+|has\s+been\s+|duly\s+)incorporated\s+in\s+(Hong\s+Kong|Singapore|Malaysia|British\s+Virgin\s+Islands|Cayman\s+Islands|Bermuda)\b/giu,
   /(?:在|於|于)(香港|新加坡|马来西亚|馬來西亞|英属维尔京群岛|英屬維爾京群島|开曼群岛|開曼群島|百慕大)(?:成立|註冊成立|注册成立)/gu];
  for(const pattern of patterns)for(const match of region.raw_text!.matchAll(pattern)){
   const before=region.raw_text!.slice(Math.max(0,match.index!-12),match.index);
   if(/(?:未|不|并非|並非|尚未|并未|並未|并不是|並不是)\s*$/u.test(before))continue;
   const value=match[1]!;
   if(result.some(r=>r.value===value))continue;
   try{
    const anchors=anchorsForText(page.page,[region],value),contextAnchors=anchorsForText(page.page,[region],match[0]);
    [...anchors,...contextAnchors].forEach(a=>validateAnchorSource(a,page.page,page.regions));
    if(anchors.length&&contextAnchors.length)result.push({value,context:match[0],anchors,contextAnchors});
   }catch{/* An unusable span cannot be repaired by guessing. */}
  }
 }
 return result;
}
