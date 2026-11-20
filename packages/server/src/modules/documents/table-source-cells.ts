import type {DocumentPageArtifact} from '@hsbc/contracts/documents';
import type {DocumentRegion} from '@hsbc/contracts/evidence';
import {documentHtmlCellSpans} from '../../document/html-cells.js';
import {sha256} from '../../document/evidence.js';

type Box=[number,number,number,number];
export type SourceCell={start:number;end:number;row:number;column:number;labelEnd:number;labelBottom:number};
export type TableSourceCells={cells:SourceCell[];rows:Array<{top:number;bottom:number}>;columns:Array<{left:number;right:number}>;tableId:string};
const compact=(value:string)=>value.replace(/\s/gu,'');
function box(region:DocumentRegion):Box|undefined {
  if(region.polygons.length!==1)return;
  const points=region.polygons[0]!,b:Box=[Math.min(...points.map(p=>p[0])),Math.min(...points.map(p=>p[1])),Math.max(...points.map(p=>p[0])),Math.max(...points.map(p=>p[1]))];
  return b.every(Number.isFinite)&&b[2]>b[0]&&b[3]>b[1]?b:undefined;
}
function valid(region:DocumentRegion,page:DocumentPageArtifact){
  return region.processing_status==='ready'&&Boolean(region.raw_text)&&region.raw_text_sha256===sha256(region.raw_text!)&&
    region.document_version_id===page.page.document_version_id&&region.parse_revision===page.page.parse_revision&&region.page_asset_id===page.page.page_asset_id;
}

/** Correspond HTML rows/columns to independently positioned OCR row labels.
 * Every cell needs an exact full-line label, every row must occur once, and
 * columns must remain separated across rows. These are ownership bounds from
 * actual source lines, not inferred/equal-width cell rectangles for display. */
export function tableSourceCells(page:DocumentPageArtifact,table:DocumentRegion):TableSourceCells|undefined {
  const raw=table.raw_text,b=box(table);
  if(table.kind!=='table'||table.source!=='vl_ocr'||!raw||!b||!valid(table,page)||
    !page.canonicalRegionIds.includes(table.region_id)||page.conflicts.some(conflict=>conflict.region_ids.includes(table.region_id))||
    /\b(?:rowspan|colspan)\s*=\s*["']?(?!1(?:["'\s>]))/iu.test(raw))return;
  const spans=documentHtmlCellSpans(raw,{allowImages:true});
  const rows=[...raw.matchAll(/<tr\s*>[\s\S]*?<\/tr\s*>/giu)].map(row=>spans.filter(span=>span.start>row.index&&span.end<row.index+row[0].length));
  const width=rows[0]?.length??0;
  if(rows.length<2||rows.length>100||!width||width>10||rows.some(row=>row.length!==width)||spans.length!==rows.flat().length)return;
  const lines=page.regions.flatMap(region=>{
    const bounds=box(region);
    if(region.source!=='pp_ocr'||region.kind!=='text'||!/^line:\d+$/u.test(region.source_id)||!valid(region,page)||!bounds||
      bounds[0]<b[0]||bounds[1]<b[1]||bounds[2]>b[2]||bounds[3]>b[3])return [];
    return [{region,box:bounds,text:compact(region.raw_text!)}];
  });
  const used=new Set<string>(),markers:Array<typeof lines>=[];
  for(const row of rows){
    const labels=row.map(span=>{
      const first=raw.slice(span.start,span.end).split(/<br\s*\/?\s*>|\r?\n|\\n/iu)[0]!.trim();
      return first&&!/[<>&]/u.test(first)?compact(first):'';
    });
    if(labels.some(label=>!label))return;
    const found=lines.filter(line=>labels.includes(line.text)).sort((a,b)=>a.box[0]-b.box[0]);
    if(found.length!==width||found.some((line,column)=>line.text!==labels[column]||used.has(line.region.region_id)))return;
    const top=Math.max(...found.map(line=>line.box[1])),bottom=Math.min(...found.map(line=>line.box[3]));
    if(bottom-top<Math.min(...found.map(line=>line.box[3]-line.box[1]))*.5||
      found.some((line,column)=>column>0&&found[column-1]!.box[2]>=line.box[0]))return;
    found.forEach(line=>used.add(line.region.region_id));markers.push(found);
  }
  const columns=Array.from({length:width},(_,column)=>({left:Math.min(...markers.map(row=>row[column]!.box[0])),right:Math.max(...markers.map(row=>row[column]!.box[2]))}));
  if(columns.some((column,index)=>index>0&&columns[index-1]!.right>=column.left))return;
  const bands=markers.map((row,index)=>({top:Math.min(...row.map(line=>line.box[1])),bottom:index+1<markers.length?Math.min(...markers[index+1]!.map(line=>line.box[1])):b[3]}));
  if(bands.some((band,index)=>Math.max(...markers[index]!.map(line=>line.box[3]))>=band.bottom))return;
  // Repeated labels alone do not prove that HTML columns were not swapped.
  // Each column also needs an independently positioned unique whole value.
  const pieces=rows.flatMap((row,r)=>row.map((span,column)=>({row:r,column,texts:raw.slice(span.start,span.end)
    .split(/<br\s*\/?\s*>|\r?\n|\\n/iu).filter(text=>!/[<>&]/u.test(text)).map(compact)})));
  const corroborated=new Set<number>();
  for(const line of lines.filter(line=>!used.has(line.region.region_id)&&line.text.length>=4)){
    const matches=pieces.filter(cell=>cell.texts.includes(line.text));if(matches.length!==1)continue;
    const cell=matches[0]!,row=bands[cell.row]!,column=columns[cell.column]!;
    const right=columns[cell.column+1]?.left??b[2];
    if(line.box[1]<row.top||line.box[3]>row.bottom||line.box[0]<column.left||line.box[2]>=right)return;
    column.right=Math.max(column.right,line.box[2]);
    corroborated.add(cell.column);
  }
  if(corroborated.size!==width)return;
  return {tableId:table.region_id,columns,rows:bands,cells:rows.flatMap((row,r)=>row.map((span,column)=>({
    start:[...raw.slice(0,span.start)].length,end:[...raw.slice(0,span.end)].length,row:r,column,
    labelEnd:[...raw.slice(0,span.start)+raw.slice(span.start,span.end).split(/<br\s*\/?\s*>|\r?\n|\\n/iu)[0]!].length,
    labelBottom:markers[r]![column]!.box[3],
  })))};
}

export function tableSourceDisagreementSpan(region:DocumentRegion,cell:SourceCell){
  const bounds=box(region);
  return {start:bounds&&bounds[1]>cell.labelBottom?cell.labelEnd:cell.start,end:cell.end};
}

/** Only a whole source line inside one proved row and column can be assigned.
 * Gaps, crossing boxes, stale sources and ambiguous mappings remain unknown. */
export function locateTableSourceCell(page:DocumentPageArtifact,region:DocumentRegion,table:TableSourceCells):SourceCell|undefined {
  const bounds=box(region);if(!bounds||!valid(region,page)||region.kind!=='text')return;
  const rows=table.rows.flatMap((row,index)=>bounds[1]>=row.top&&bounds[3]<=row.bottom?[index]:[]);
  const columns=table.columns.flatMap((column,index)=>bounds[0]>=column.left&&bounds[2]<=column.right?[index]:[]);
  if(rows.length!==1||columns.length!==1)return;
  return table.cells.find(cell=>cell.row===rows[0]&&cell.column===columns[0]);
}
