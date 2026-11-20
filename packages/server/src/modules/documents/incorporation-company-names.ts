import type {DocumentPageArtifact} from '@hsbc/contracts/documents';
import type {EvidenceAnchor} from '@hsbc/contracts/evidence';
import type {ReviewFieldDefinition} from '@hsbc/contracts/review-config';
import {anchorsForText,sha256,validateAnchorSource} from '../../document/evidence.js';

const fold=(text:string)=>text.normalize('NFKC').replace(/\s/gu,'').toLowerCase();
type Region=DocumentPageArtifact['regions'][number];
function bounds(region:Region){
  const points=region.polygons.flat();if(!points.length)return;
  const x=Math.min(...points.map(p=>p[0])),y=Math.min(...points.map(p=>p[1]));
  const right=Math.max(...points.map(p=>p[0])),bottom=Math.max(...points.map(p=>p[1]));
  return right>x&&bottom>y?{x,y,right,bottom,center:(x+right)/2}:undefined;
}
const companyName=(text:string)=>text.length>=4&&text.length<=240&&!/[\n|<>:：]/u.test(text)&&
  /(?:有限公司|有限責任公司|有限责任公司|股份公司|\bLIMITED|\bLTD\.?|\bINC\.?|\bLLC|\bCORPORATION|\bPLC)$/iu.test(text);

/** The certified subject is bounded by the certificate's declaration, not a
 * generic Company Name label. All values and context retain their own spans;
 * duplicate OCR rows never become a fabricated contiguous quotation. */
export function pageIncorporationCompanyNames(page:DocumentPageArtifact,definition:ReviewFieldDefinition){
  const found:Array<{value:string;context:string;anchors:EvidenceAnchor[];contextAnchors:EvidenceAnchor[]}>=[];
  if(definition.id!=='cgt_field_61'||definition.valueKind!=='party_name'||
    !definition.partyKinds?.includes('organization')||!definition.taxonomyIds?.includes('cgt_incorporation')||page.status==='failed')return found;
  const readable=page.regions.filter(region=>region.kind==='text'&&region.processing_status==='ready'&&region.raw_text?.trim()&&
    region.raw_text_sha256===sha256(region.raw_text)&&region.document_version_id===page.scope.documentVersionId&&
    region.parse_revision===page.scope.parseRevision&&region.page_asset_id===page.page.page_asset_id&&bounds(region));
  const valid=readable.filter(region=>{
    const parent=/^(.+):word:\d+$/u.exec(region.source_id)?.[1];
    return !parent||!readable.some(other=>other.source===region.source&&other.source_id===parent&&
      other.raw_text!.includes(region.raw_text!));
  });
  const rows=valid.filter(region=>page.canonicalRegionIds.includes(region.region_id));
  const titles=rows.filter(r=>/^(?:certificateofincorporation|公司註冊證明書|公司注册证明书)$/u.test(fold(r.raw_text!)));
  const starts=rows.filter(r=>/^(?:iherebycertifythat|本人謹此證明|本人谨此证明)$/u.test(fold(r.raw_text!)));
  const ends=rows.filter(r=>/^(?:isthisdayincorporated\b|isthisdayincorporatedin|於本日根據|于本日根据)/u.test(fold(r.raw_text!)));
  const centered=(a:Region,b:Region)=>Math.abs(bounds(a)!.center-bounds(b)!.center)<=page.page.width*.12;
  const evidence=(region:Region)=>{
    const anchors=anchorsForText(page.page,[region],region.raw_text!);
    for(const anchor of anchors)validateAnchorSource(anchor,page.page,page.regions);
    return anchors;
  };
  for(const start of starts){
    const s=bounds(start)!;
    const title=titles.filter(r=>bounds(r)!.bottom<s.y&&s.y-bounds(r)!.bottom<page.page.height*.2&&centered(r,start))
      .sort((a,b)=>bounds(b)!.y-bounds(a)!.y)[0];
    const end=ends.filter(r=>bounds(r)!.y>s.bottom&&bounds(r)!.y-s.bottom<page.page.height*.25)
      .sort((a,b)=>bounds(a)!.y-bounds(b)!.y)[0];
    if(!title||!end)continue;
    const names=rows.filter(r=>bounds(r)!.y>=s.bottom&&bounds(r)!.bottom<=bounds(end)!.y&&centered(r,start)&&companyName(r.raw_text!.trim()));
    for(const region of names){
      const value=region.raw_text!.trim(),box=bounds(region)!;
      const overlapping=valid.filter(other=>{
        const b=bounds(other)!;
        return Math.min(box.right,b.right)>Math.max(box.x,b.x)&&
          Math.min(box.bottom,b.bottom)-Math.max(box.y,b.y)>Math.min(box.bottom-box.y,b.bottom-b.y)*.5;
      });
      // Do not decide between inconsistent OCR readings or trust an unverified
      // native text layer. Independent OCR can corroborate its exact name.
      if(overlapping.some(r=>fold(r.raw_text!)!==fold(value))||
        region.source==='native_pdf'&&page.nativeTrust!=='validated_geometry_and_visibility'&&
        !overlapping.some(r=>['pp_ocr','vl_ocr'].includes(r.source)&&fold(r.raw_text!)===fold(value)))continue;
      try{
        const anchors=evidence(region),contextRegions=[title,start,...names,end];
        const contextAnchors=contextRegions.flatMap(evidence);
        if(!anchors.length||!contextAnchors.length||found.some(item=>item.value===value))continue;
        found.push({value,context:contextRegions.map(r=>r.raw_text!).join('\n'),anchors,contextAnchors});
      }catch{/* Invalid or stale source evidence is never repaired by guessing. */}
    }
  }
  return found;
}
