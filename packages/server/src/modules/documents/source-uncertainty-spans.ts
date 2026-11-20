import type {DocumentPageArtifact} from '@hsbc/contracts/documents';
import type {DocumentRegion,EvidenceAnchor} from '@hsbc/contracts/evidence';
import {sha256} from '../../document/evidence.js';
import {tableSourceCells,locateTableSourceCell,tableSourceDisagreementSpan,type TableSourceCells} from './table-source-cells.js';

type Span={start:number;end:number};
type Difference={spans:Span[];contexts:string[];contextRegionIds:string[];counterpartIds:string[];tableCells?:TableSourceCells};
function literal(text:string){
  const positions:number[]=[],units:string[]=[];
  [...text].forEach((char,index)=>{if(!/\s/u.test(char))for(const unit of char.split('')){units.push(unit);positions.push(index);}});
  return {text:units.join(''),positions};
}
function box(region:DocumentRegion){
  if(region.polygons.length!==1)return;
  const ps=region.polygons[0]!,b=[Math.min(...ps.map(p=>p[0])),Math.min(...ps.map(p=>p[1])),Math.max(...ps.map(p=>p[0])),Math.max(...ps.map(p=>p[1]))];
  return b.every(Number.isFinite)&&b[2]!>b[0]!&&b[3]!>b[1]!?b:undefined;
}
function covers(inner:DocumentRegion,outer:DocumentRegion){
  const a=box(inner),b=box(outer);if(!a||!b)return false;
  return Math.max(0,Math.min(a[2]!,b[2]!)-Math.max(a[0]!,b[0]!))*Math.max(0,Math.min(a[3]!,b[3]!)-Math.max(a[1]!,b[1]!))/((a[2]!-a[0]!)*(a[3]!-a[1]!))>.8;
}
function valid(region:DocumentRegion,page:DocumentPageArtifact){
  return region.processing_status==='ready'&&region.raw_text&&region.raw_text_sha256===sha256(region.raw_text)&&
    region.page_asset_id===page.page.page_asset_id&&region.parse_revision===page.page.parse_revision&&region.document_version_id===page.page.document_version_id;
}
function uniqueAt(text:string,part:string){
  const start=text.indexOf(part);return start>=0&&start===text.lastIndexOf(part)?start:undefined;
}
/** OCR may insert layout spaces around Han characters. Keep Latin word and
 * digit boundaries, punctuation, case and every printed character literal. */
function proseSpacing(text:string){
  return text.replace(/\b(USD|HKD|CNY|RMB|EUR|GBP|JPY|SGD|AUD|CAD|CHF|NZD)\s+(?=\d)/gu,'$1').replace(/\s+/gu,' ').replace(/(?<=\p{Script=Han}) | (?=\p{Script=Han})/gu,'').trim();
}
function sameProseLine(line:DocumentRegion,layout:DocumentRegion){
  if(layout.kind!=='text'||!/[\p{Script=Han}]/u.test(line.raw_text!)||/[<>$^{}]/u.test(layout.raw_text!)||
    line.raw_text!.length>2000||layout.raw_text!.length>10000)return false;
  const part=proseSpacing(line.raw_text!),whole=proseSpacing(layout.raw_text!);
  if(part.length<6)return false;
  const a=box(line),b=box(layout);
  // A one-line alternative must agree in full: a matching substring cannot
  // excuse an added prefix, negation, footnote or suffix on that same line.
  if(!a||!b||b[3]!-b[1]!<=(a[3]!-a[1]!)*1.8&&part!==whole)return false;
  const at=uniqueAt(whole,part);if(at===undefined)return false;
  // A line cannot prove a different word/number by matching its substring.
  const word=(c:string)=>/[\p{Script=Latin}\p{N}]/u.test(c);
  return !(word(part[0]!)&&word(whole[at-1]??''))&&
    !(word(part.at(-1)!)&&word(whole[at+part.length]??''));
}
/** Locate one line's disagreement in a containing plain-text block using unique
 * unchanged prefixes AND suffixes. No fuzzy edit distance, cell geometry or
 * corrected text is invented. Ambiguous/short/table matches remain block-wide. */
function difference(line:DocumentRegion,layout:DocumentRegion){
  if(line.raw_text!.length>2000||layout.raw_text!.length>10000||layout.kind!=='text'||/[<>]/u.test(layout.raw_text!))return;
  const a=literal(line.raw_text!),b=literal(layout.raw_text!);
  if(!a.text||b.text.includes(a.text))return;
  let prefix=0,suffix=0;
  while(prefix<a.text.length&&b.text.includes(a.text.slice(0,prefix+1)))prefix++;
  while(suffix<a.text.length&&b.text.includes(a.text.slice(a.text.length-suffix-1)))suffix++;
  if(prefix<6||suffix<6||prefix+suffix>a.text.length)return;
  const left=uniqueAt(b.text,a.text.slice(0,prefix)),right=uniqueAt(b.text,a.text.slice(a.text.length-suffix));
  if(left===undefined||right===undefined)return;
  // A deletion can make independently longest flanks overlap in the shorter
  // alternative. Shorten the prefix only if both unique flanks still hold.
  if(left+prefix>right){prefix=right-left;if(prefix<6||uniqueAt(b.text,a.text.slice(0,prefix))!==left)return;}
  // Include adjacent characters so an insertion at a value boundary still
  // affects that value. Source offsets remain Unicode code points.
  const span=(source:ReturnType<typeof literal>,start:number,end:number):Span=>({
    start:source.positions[Math.max(0,start-1)]!,end:source.positions[Math.min(source.positions.length-1,end)]!+1,
  });
  return {line:span(a,prefix,a.text.length-suffix),layout:span(b,left+prefix,right),
    context:[...layout.raw_text!].slice(b.positions[left],b.positions[right+suffix-1]!+1).join('')};
}

export function sourceUncertaintySpans(page:DocumentPageArtifact):Map<string,Difference>{
  const result=new Map<string,Difference>(),assembly=page.sourceTextAssembly;if(!assembly)return result;
  const byId=new Map(page.regions.map(region=>[region.region_id,region]));
  const parents=new Set(assembly.wordRepresentations.map(link=>link.parentLineRegionId));
  const uncertain=assembly.uncertainRegionIds.flatMap(id=>byId.get(id)??[]);
  const layouts=uncertain.filter(region=>region.source==='vl_ocr'&&valid(region,page));
  const failed=new Set<string>();
  for(const table of layouts.filter(region=>region.kind==='table')){
    const proof=tableSourceCells(page,table),related=uncertain.filter(region=>region.source==='pp_ocr'&&covers(region,table));
    const located=related.map(parent=>({parent,cell:proof&&parents.has(parent.region_id)?locateTableSourceCell(page,parent,proof):undefined}));
    if(!proof||!related.length||located.some(item=>!item.cell)){
      failed.add(table.region_id);related.forEach(region=>failed.add(region.region_id));continue;
    }
    const parts:Difference={spans:[],contexts:[],contextRegionIds:[],counterpartIds:[],tableCells:proof};
    for(const {parent,cell} of located){
      const context=[...table.raw_text!].slice(cell!.start,cell!.end).join('');
      // The same complete line in the proved cell, differing only in white
      // space, is not a character disagreement. Never compare across cells or
      // against image attributes/markup, which are not visible source text.
      const sameLine=context.split(/<br\s*\/?\s*>|\r?\n|\\n/iu).some(text=>!/[<>&]/u.test(text)&&literal(text).text===literal(parent.raw_text!).text);
      const prior=result.get(parent.region_id)??{spans:[],contexts:[],contextRegionIds:[],counterpartIds:[]};
      if(!sameLine){
        parts.spans.push(tableSourceDisagreementSpan(parent,cell!));parts.contexts.push(context,parent.raw_text!);parts.contextRegionIds.push(table.region_id,parent.region_id);
        prior.spans.push({start:0,end:[...parent.raw_text!].length});prior.contexts.push(context,parent.raw_text!);prior.contextRegionIds.push(table.region_id,parent.region_id);
      }
      parts.counterpartIds.push(parent.region_id);prior.counterpartIds.push(table.region_id);
      result.set(parent.region_id,prior);
    }
    result.set(table.region_id,parts);
  }
  for(const parent of uncertain.filter(region=>parents.has(region.region_id)&&region.source==='pp_ocr')){
    if(!valid(parent,page))continue;
    const owners=layouts.filter(layout=>layout.kind!=='table'&&covers(parent,layout));
    for(const layout of owners){
      if(sameProseLine(parent,layout)){
        for(const [region,other] of [[parent,layout],[layout,parent]] as const){
          const prior=result.get(region.region_id)??{spans:[],contexts:[],contextRegionIds:[],counterpartIds:[]};
          prior.counterpartIds.push(other.region_id);result.set(region.region_id,prior);
        }
        continue;
      }
      const diff=difference(parent,layout);
      if(!diff){failed.add(parent.region_id);failed.add(layout.region_id);continue;}
      for(const [region,span] of [[parent,diff.line],[layout,diff.layout]] as const){
        const prior=result.get(region.region_id)??{spans:[],contexts:[],contextRegionIds:[],counterpartIds:[]};
        prior.spans.push(span);prior.contexts.push(parent.raw_text!,diff.context);
        prior.contextRegionIds.push(parent.region_id,layout.region_id);
        prior.counterpartIds.push(region===parent?layout.region_id:parent.region_id);result.set(region.region_id,prior);
      }
    }
  }
  for(const id of failed)result.delete(id);
  return result;
}

/** Compare a cited source range against a proven disagreement range. A
 * different producer must have its complete block uniquely represented at
 * the same position; a matching value alone is insufficient. */
export function anchorTouchesDisagreement(anchor:EvidenceAnchor,region:DocumentRegion,difference:Difference,page:DocumentPageArtifact,differences?:Map<string,Difference>):boolean {
  if(!anchor.text_span_refs.length)return true;
  const source=literal(region.raw_text!);
  return anchor.text_span_refs.some(ref=>{
    let span:Span;
    if(ref.block_id===region.region_id)span={start:ref.offset,end:ref.offset+ref.length};
    else{
      const counterpart=difference.counterpartIds.includes(ref.block_id)?differences?.get(ref.block_id):undefined;
      if(counterpart)return counterpart.spans.some(part=>ref.offset<part.end&&part.start<ref.offset+ref.length);
      const other=page.regions.find(r=>r.region_id===ref.block_id);
      if(other&&difference.tableCells){
        const cell=locateTableSourceCell(page,other,difference.tableCells);
        return !cell||difference.spans.some(part=>cell.start<part.end&&part.start<cell.end);
      }
      if(!other||!valid(other,page))return true;
      // A native PDF block may span several OCR lines. Locate its complete
      // text in the corroborated containing layout, rather than requiring it
      // to fit inside this one line. Unknown/ambiguous counterparts still block.
      if(!covers(other,region)||uniqueAt(source.text,literal(other.raw_text!).text)===undefined){
        const alternatives=difference.counterpartIds.flatMap(id=>{
          const owner=page.regions.find(r=>r.region_id===id),known=differences?.get(id);
          if(!owner||!known||!valid(owner,page)||!covers(other,owner))return [];
          const full=literal(owner.raw_text!),part=literal(other.raw_text!),start=uniqueAt(full.text,part.text);
          if(start===undefined)return [];
          const first=part.positions.findIndex(offset=>offset>=ref.offset),last=part.positions.findLastIndex(offset=>offset<ref.offset+ref.length);
          if(first<0||last<first)return [];
          const span={start:full.positions[start+first]!,end:full.positions[start+last]!+1};
          return [known.spans.some(p=>span.start<p.end&&p.start<span.end)];
        });
        return !alternatives.length||alternatives.some(Boolean);
      }
      const text=literal(other.raw_text!),start=uniqueAt(source.text,text.text)!;
      const first=text.positions.findIndex(offset=>offset>=ref.offset),last=text.positions.findLastIndex(offset=>offset<ref.offset+ref.length);
      if(first<0||last<first)return true;
      span={start:source.positions[start+first]!,end:source.positions[start+last]!+1};
    }
    return difference.spans.some(part=>span.start<part.end&&part.start<span.end);
  });
}
