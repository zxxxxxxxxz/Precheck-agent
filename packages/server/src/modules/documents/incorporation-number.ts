import type {DocumentPageArtifact} from '@hsbc/contracts/documents';
import type {ReviewFieldDefinition} from '@hsbc/contracts/review-config';
import {anchorsForText,sha256,validateAnchorSource} from '../../document/evidence.js';

type Region=DocumentPageArtifact['regions'][number];
const fold=(s:string)=>s.normalize('NFKC').replace(/\s/gu,'').toLowerCase();
const label=/^(?:(?:編號|编号)\s*)?(?:No\.?|BRN\s*\/\s*UBI|Company\s+(?:Number|No\.?)|Registration\s+(?:Number|No\.?))\s*[:：]?\s*$/iu;
const inline=/^((?:(?:編號|编号)\s*)?(?:No\.?|BRN\s*\/\s*UBI|Company\s+(?:Number|No\.?)|Registration\s+(?:Number|No\.?))|編號|编号)\s*[:：]?\s*(\d{6,8})\s*(?:\(?BRN\s*\/\s*UBI\)?)?\s*$/iu;
function bounds(r:Region){const p=r.polygons.flat();if(!p.length)return;return {x:Math.min(...p.map(p=>p[0])),y:Math.min(...p.map(p=>p[1])),right:Math.max(...p.map(p=>p[0])),bottom:Math.max(...p.map(p=>p[1]))};}

/** Recover a labelled literal identifier on a certificate. A nearby chapter,
 * date, unrelated number or conflicting OCR reading cannot fill this field. */
export function pageIncorporationNumbers(page:DocumentPageArtifact,definition:ReviewFieldDefinition){
 const result:Array<{value:string;context:string;anchors:ReturnType<typeof anchorsForText>;contextAnchors:ReturnType<typeof anchorsForText>}>=[];
 if(definition.id!=='cgt_field_60'||!definition.taxonomyIds?.includes('cgt_incorporation')||page.status==='failed'||
   page.page.document_version_id!==page.scope.documentVersionId||page.page.parse_revision!==page.scope.parseRevision)return result;
 const readable=page.regions.filter(r=>r.kind==='text'&&r.processing_status==='ready'&&r.raw_text?.trim()&&r.raw_text_sha256===sha256(r.raw_text)&&
   r.document_version_id===page.scope.documentVersionId&&r.parse_revision===page.scope.parseRevision&&r.page_asset_id===page.page.page_asset_id&&bounds(r));
 const rows=readable.filter(r=>page.canonicalRegionIds.includes(r.region_id)&&
   (r.source!=='native_pdf'||page.nativeTrust==='validated_geometry_and_visibility'));
 if(!rows.some(r=>/^(?:certificateofincorporation|公司註冊證明書|公司注册证明书)$/u.test(fold(r.raw_text!))))return result;
 const add=(value:string,region:Region,context:Region[])=>{
   const box=bounds(region)!;
   const conflicting=readable.some(other=>{const b=bounds(other)!;
     return Math.min(box.right,b.right)>Math.max(box.x,b.x)&&Math.min(box.bottom,b.bottom)-Math.max(box.y,b.y)>Math.min(box.bottom-box.y,b.bottom-b.y)*.5&&
       /\d{6,8}/u.test(other.raw_text!)&&[...other.raw_text!.matchAll(/\d{6,8}/gu)].some(m=>m[0]!==value);
   });
   if(conflicting||result.some(r=>r.value===value))return;
   try{
     const anchors=anchorsForText(page.page,[region],value),contextAnchors=context.flatMap(r=>anchorsForText(page.page,[r],r.raw_text!));
     [...anchors,...contextAnchors].forEach(a=>validateAnchorSource(a,page.page,page.regions));
     if(anchors.length&&contextAnchors.length)result.push({value,context:context.map(r=>r.raw_text!).join('\n'),anchors,contextAnchors});
   }catch{/* No guessed or stale evidence. */}
 };
 for(const r of rows){
   const match=inline.exec(r.raw_text!.trim());
   if(match){add(match[2]!,r,[r]);continue;}
   if(!label.test(r.raw_text!.trim())&&!/^(?:編號|编号)$/u.test(r.raw_text!.trim()))continue;
   const box=bounds(r)!;
   const adjacent=rows.filter(other=>{const b=bounds(other)!;return /^\d{6,8}$/u.test(other.raw_text!.trim())&&b.x>=box.right&&b.x-box.right<=page.page.width*.12&&
     Math.min(box.bottom,b.bottom)-Math.max(box.y,b.y)>Math.min(box.bottom-box.y,b.bottom-b.y)*.5;});
   if(adjacent.length&&new Set(adjacent.map(r=>r.raw_text!.trim())).size===1)for(const value of adjacent)add(value.raw_text!.trim(),value,[r,value]);
 }
 return new Set(result.map(r=>r.value)).size===1?result:[];
}
