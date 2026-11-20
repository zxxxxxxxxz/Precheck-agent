import type {ReviewEvidence} from '@hsbc/contracts/review';
import type {DocumentPageArtifact,DocumentRegion,EvidenceAnchor} from '../documents/types.ts';
import {pageEvidencePreview,sourceEvidencePreview} from './evidence-preview.ts';
import type {SourceDocumentResponse} from '../../sourceDocument.ts';

export interface EvidenceParagraph {
  source:ReviewEvidence; text:string; displayText?:string; pageNumber?:number; location:string;
  bounds?:[number,number,number,number]; regionIds:string[];
}
export interface EvidenceParagraphReading {sources:ReviewEvidence[];paragraph?:EvidenceParagraph;pageNumber?:number}

/** A reading card represents one fixed file version, not each OCR text block. */
export function groupEvidenceDocuments(readings:EvidenceParagraphReading[]) {
  const documents=new Map<string,{key:string;parts:EvidenceParagraphReading[]}>();
  for(const reading of readings){
    const source=reading.sources[0];
    if(!source)continue;
    const key=JSON.stringify([source.documentVersionId,source.parseRevision,source.directoryRevision]);
    const group=documents.get(key)??{key,parts:[]};
    group.parts.push(reading);documents.set(key,group);
  }
  return [...documents.values()].map(group=>({...group,parts:mergeCoveredParagraphs(group.parts).sort((a,b)=>
    (a.paragraph?.pageNumber??a.pageNumber??0)-(b.paragraph?.pageNumber??b.pageNumber??0)||
    (a.paragraph?.bounds?.[1]??0)-(b.paragraph?.bounds?.[1]??0)||
    (a.paragraph?.bounds?.[0]??0)-(b.paragraph?.bounds?.[0]??0))}));
}
/** Discard an OCR fragment only when its text and page geometry are covered by another reading. */
function mergeCoveredParagraphs(parts:EvidenceParagraphReading[]) {
  const kept:EvidenceParagraphReading[]=[];
  const comparable=(text:string)=>/^or[:;]?$/iu.test(text.trim())?'or':normalized(text);
  for(const part of [...parts].sort((a,b)=>(b.paragraph?.text.length??0)-(a.paragraph?.text.length??0))){
    const small=part.paragraph;
    if(small&&/^[\s:;,.]+$/u.test(small.text))continue;
    const parent=small&&kept.find(candidate=>{
      const large=candidate.paragraph;
      if(!large||large.pageNumber!==small.pageNumber||!large.bounds||!small.bounds||!comparable(large.text).includes(comparable(small.text)))return false;
      const [a,b,c,d]=large.bounds,[x,y,z,w]=small.bounds;
      const area=(z-x)*(w-y);
      const overlap=Math.max(0,Math.min(c,z)-Math.max(a,x))*Math.max(0,Math.min(d,w)-Math.max(b,y));
      return area>0&&overlap/area>.8;
    });
    if(parent)parent.sources.push(...part.sources);else kept.push({...part,sources:[...part.sources]});
  }
  // Preserve incoming order for Word nodes that do not have page coordinates.
  return kept.sort((a,b)=>parts.findIndex(part=>part.paragraph===a.paragraph)-parts.findIndex(part=>part.paragraph===b.paragraph));
}

/** Display cleanup only. Never modifies the fixed parse or evidence coordinates. */
export function cleanEvidenceText(text:string):string {
  // OCR table regions can contain HTML. Keep their cell text as plain text;
  // never render markup or mistake a mathematical comparison for a tag.
  const plain=text.replace(/<\/?(?:table|thead|tbody|tfoot|tr|td|th|br|p|span|b|strong)\b[^>]*>/giu,' ')
    .replace(/&(?:amp|lt|gt|quot|apos|nbsp);/gu,entity=>({'&amp;':'&','&lt;':'<','&gt;':'>','&quot;':'"','&apos;':"'",'&nbsp;':' '}[entity]!));
  return plain.split(/\r?\n/).map(line=>line.trim()
    .replace(/\[COPY\s*[-–—]\s*FICTIONAL CASE\]\s*/gu,''))
    .filter(line=>line && !/^[\s*★☆_─━—–\-=·•.]+$/u.test(line) &&
      !/^(?:SAMPLE(?:\s|$)|ILLUSTRATIVE COPY\b|[虚虛][构構].*(?:案例|註冊|注册)|不供交易使用)/u.test(line))
    .join(' ').replace(/\s+/gu,' ').trim();
}
function box(polygons:number[][][]) {
  const points=polygons.flat();
  return points.length?[Math.min(...points.map(p=>p[0]!)),Math.min(...points.map(p=>p[1]!)),Math.max(...points.map(p=>p[0]!)),Math.max(...points.map(p=>p[1]!))] as [number,number,number,number]:undefined;
}
const regionBox=(region:DocumentRegion)=>box(region.polygons);
const normalized=(text:string)=>cleanEvidenceText(text).replace(/\s+/gu,' ').toLocaleLowerCase();
function paragraphBreak(before:DocumentRegion,after:DocumentRegion) {
  const a=regionBox(before),b=regionBox(after);
  if(!a||!b)return true;
  const height=Math.min(a[3]-a[1],b[3]-b[1]);
  const gap=b[1]-a[3];
  return height<=0 || gap < -height*.3 || gap>height*.65 || Math.abs(a[0]-b[0])>height*1.5 ||
    /^\s*(?:\d+[.)]|[A-Z][.)])\s+\S/u.test(after.raw_text??'') ||
    (/^[A-Z][A-Za-z /()–-]{1,80}:/.test(after.raw_text??'') && /[.!?]$/.test((before.raw_text??'').trim())) || !cleanEvidenceText(before.raw_text??'') || !cleanEvidenceText(after.raw_text??'');
}
export function pageEvidenceParagraph(source:ReviewEvidence,page:DocumentPageArtifact,fallback?:EvidenceAnchor):EvidenceParagraph|undefined {
  if(!pageEvidencePreview(source,page,fallback,true))return;
  const anchor=page.anchors.find(a=>a.anchor_id===source.anchorId)??fallback;
  if(!anchor || anchor.localization_status==='unavailable')return;
  // OCR may not pinpoint a word, while its parent paragraph and Unicode span remain known.
  if(anchor.localization_status==='ambiguous' && (anchor.block_ids.length!==1 || !anchor.text_span_refs.length || anchor.text_span_refs.some(span=>{
    const region=page.regions.find(r=>r.region_id===span.block_id);
    return !anchor.block_ids.includes(span.block_id)||!region?.raw_text||span.offset+span.length>Array.from(region.raw_text).length;
  })))return;
  const regions=page.regions.filter(r=>r.document_version_id===source.documentVersionId&&r.parse_revision===source.parseRevision&&r.page_asset_id===page.page.page_asset_id&&r.kind==='text'&&r.raw_text?.trim()&&r.processing_status==='ready');
  const selected=regions.filter(r=>anchor.block_ids.includes(r.region_id));
  if(!selected.length)return;
  const expanded=new Map<string,DocumentRegion>();
  for(const selectedRegion of selected) {
    const seedBox=regionBox(selectedRegion);
    if(!seedBox || seedBox[3]-seedBox[1]>page.page.height*.6)return;
    // A word-level OCR region can be contained by a line from the same provider.
    const parents=regions.filter(r=>{
      const b=regionBox(r);
      return b&&r.source===selectedRegion.source&&b[0]<=seedBox[0]+1&&b[1]<=seedBox[1]+1&&b[2]>=seedBox[2]-1&&b[3]>=seedBox[3]-1&&b[3]-b[1] <= (seedBox[3]-seedBox[1])*2 && (r.raw_text??'').includes(selectedRegion.raw_text??'');
    });
    const seed=parents.sort((a,b)=>(b.raw_text?.length??0)-(a.raw_text?.length??0))[0]??selectedRegion;
    const lines=regions.filter(r=>r.source===seed.source).filter(r=>!regions.some(parent=>{
      if(parent===r||parent.source!==r.source||(parent.raw_text?.length??0)<=(r.raw_text?.length??0))return false;
      const a=regionBox(parent),b=regionBox(r);
      return a&&b&&a[0]<=b[0]+1&&a[1]<=b[1]+1&&a[2]>=b[2]-1&&a[3]>=b[3]-1&&(parent.raw_text??'').includes(r.raw_text??'');
    })).sort((a,b)=>a.reading_order-b.reading_order);
    const index=lines.findIndex(r=>r.region_id===seed.region_id);
    if(index<0)return;
    let first=index,last=index;
    while(first>0&&!paragraphBreak(lines[first-1]!,lines[first]!))first--;
    while(last+1<lines.length&&!paragraphBreak(lines[last]!,lines[last+1]!))last++;
    for(const region of lines.slice(first,last+1))expanded.set(region.region_id,region);
  }
  const ordered=[...expanded.values()].sort((a,b)=>a.reading_order-b.reading_order);
  const text=cleanEvidenceText(ordered.map(r=>r.raw_text).join('\n'));
  if(!text)return;
  return {source,text,displayText:ordered.some(r=>/<table\b/iu.test(r.raw_text??''))?ordered.map(r=>r.raw_text).join('\n'):text,pageNumber:anchor.page_number,location:`第 ${anchor.page_number} 页`,bounds:box(ordered.flatMap(r=>r.polygons)),regionIds:ordered.map(r=>r.region_id)};
}
export function sourceEvidenceParagraph(source:ReviewEvidence,document:SourceDocumentResponse):EvidenceParagraph|undefined {
  const preview=sourceEvidencePreview(source,document,true);
  if(!preview)return;
  const text=cleanEvidenceText(preview.excerpt);
  return text?{source,text,displayText:preview.excerpt,location:preview.location,regionIds:[source.sourceNodeId!]}:undefined;
}
/** Equal text alone is not sufficient: repeated clauses in separate locations stay separate. */
export function sameEvidenceParagraph(a:EvidenceParagraph,b:EvidenceParagraph) {
  if(a.source.documentVersionId!==b.source.documentVersionId||a.source.parseRevision!==b.source.parseRevision||a.source.directoryRevision!==b.source.directoryRevision||a.pageNumber!==b.pageNumber||normalized(a.text)!==normalized(b.text))return false;
  if(a.regionIds.some(id=>b.regionIds.includes(id)))return true;
  if(!a.bounds||!b.bounds)return false;
  const [x1,y1,x2,y2]=a.bounds,[u1,v1,u2,v2]=b.bounds;
  const overlap=Math.max(0,Math.min(x2,u2)-Math.max(x1,u1))*Math.max(0,Math.min(y2,v2)-Math.max(y1,v1));
  return overlap/Math.min((x2-x1)*(y2-y1),(u2-u1)*(v2-v1))>.8;
}
