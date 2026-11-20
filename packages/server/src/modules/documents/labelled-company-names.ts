import type {DocumentPageArtifact} from '@hsbc/contracts/documents';
import type {ReviewFieldDefinition} from '@hsbc/contracts/review-config';
import type {EvidenceAnchor} from '@hsbc/contracts/evidence';
import {anchorsForText} from '../../document/evidence.js';

const fold=(s:string)=>s.normalize('NFKC').replace(/[\s:：]/gu,'').toLowerCase();
type Region=DocumentPageArtifact['regions'][number];
function box(r:Region){const p=r.polygons.flat();return p.length?{left:Math.min(...p.map(v=>v[0])),right:Math.max(...p.map(v=>v[0])),top:Math.min(...p.map(v=>v[1])),bottom:Math.max(...p.map(v=>v[1]))}:null;}
const canonical=(page:DocumentPageArtifact)=>page.regions.filter(r=>page.canonicalRegionIds.includes(r.region_id)&&r.raw_text&&box(r));

/** A generic Name row needs the preceding role heading in its own visual column.
 * A later role, another column or a page-wide table cannot establish ownership. */
export function partyNameSectionEvidence(page:DocumentPageArtifact,region:Region,value:string,definition:ReviewFieldDefinition):Region[]|null {
 const scope=definition.partyNameSection;if(!scope)return[];
 const b=box(region);if(!b)return null;
 const prefix=region.raw_text!.slice(0,region.raw_text!.indexOf(value));
 const last=(text:string,labels:string[])=>Math.max(-1,...labels.map(label=>fold(text).lastIndexOf(fold(label))));
 const direct=last(prefix,scope.headings),other=last(prefix,scope.otherHeadings);
 if(direct>=0||other>=0)return direct>other?[region]:null;
 // Multiline regions may contain several subjects; require an explicit role in
 // that region instead of borrowing a heading outside it.
 if(region.kind==='table'||region.raw_text!.split('\n').length>2)return null;
 const headings=canonical(page).flatMap(r=>{
  const p=box(r)!,h=Math.max(b.bottom-b.top,p.bottom-p.top);
  if(r.region_id===region.region_id||p.bottom>b.top+h*.3||b.top-p.bottom>h*12||Math.abs(p.left-b.left)>h*4)return[];
  const text=fold(r.raw_text!);const expected=scope.headings.some(s=>text===fold(s)),excluded=scope.otherHeadings.some(s=>text===fold(s));
  return expected||excluded?[{region:r,top:p.top,expected:expected&&!excluded}]:[];
 }).sort((a,c)=>c.top-a.top);
 return headings[0]?.expected?[headings[0].region]:null;
}

/** Bounded private recovery: literal single-line organisation names with an
 * explicit label. No translation, expected sample answer or fuzzy name repair. */
export function pageLabelledCompanyNames(page:DocumentPageArtifact,definition:ReviewFieldDefinition){
 if(definition.valueKind!=='party_name'||!definition.partyKinds?.includes('organization')||
  (definition.partyKinds.length!==1&&!definition.partyNameSection))return[];
 const regions=canonical(page),found:Array<{value:string;context:string;anchors:EvidenceAnchor[];contextAnchors:EvidenceAnchor[]}>=[];
 const name=(value:string)=>value.length>=4&&value.length<=240&&!/[\n|<>:：]/u.test(value)&&
  /(?:有限公司|有限責任公司|有限责任公司|股份公司|公司|\bLIMITED|\bLTD\.?|\bINC\.?|\bLLC|\bCORPORATION|\bPLC)$/iu.test(value)&&
  !/^(?:name|company name|公司名称|公司名稱)$/iu.test(value);
 const add=(region:Region,value:string,labels:Region[],context:string)=>{
  if(!name(value))return;
  const section=partyNameSectionEvidence(page,region,value,definition);if(section===null)return;
  const evidence=anchorsForText(page.page,[region],value);if(!evidence.length)return;
  const sources=[...new Map([...section,...labels,region].map(r=>[r.region_id,r])).values()];
  found.push({value,context:[...section.filter(r=>r!==region).map(r=>r.raw_text!),context].join('\n'),anchors:evidence,
   contextAnchors:sources.flatMap(r=>anchorsForText(page.page,[r],r.raw_text!))});
 };
 for(const region of regions){
  // Text rows only: table cell reconstruction has its own evidence validator.
  if(region.kind==='table')continue;
  const text=region.raw_text!.trim();
  for(const alias of definition.aliases){
   const escaped=alias.replace(/[.*+?^${}()|[\]\\]/g,'\\$&').replace(/\s+/g,'\\s*');
   const match=new RegExp('^'+escaped+'\\s*[:：]\\s*(.+)$','iu').exec(text);
   if(match)add(region,match[1]!.trim(),[],text);
  }
  if(!name(text))continue;
  const b=box(region)!;
  const labels=regions.filter(r=>definition.aliases.some(alias=>fold(r.raw_text!)===fold(alias))).filter(r=>{
   const l=box(r)!,h=Math.max(b.bottom-b.top,l.bottom-l.top);
   return b.left>=l.right-h*.25&&b.left-l.right<h*12&&Math.abs((b.top+b.bottom-l.top-l.bottom)/2)<=h*.6;
  }).sort((a,c)=>box(c)!.right-box(a)!.right);
  if(labels[0])add(region,text,[labels[0]],labels[0].raw_text!+' '+text);
 }
 return found;
}
