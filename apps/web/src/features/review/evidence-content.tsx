import React from 'react';

export type EvidenceContentBlock = {kind:'text';text:string}|{kind:'table';rows:Array<Array<{text:string;header:boolean;rowSpan:number;colSpan:number}>>};
/** Parse only table structure. Attributes, links and source HTML are never executed. */
export function evidencePlainText(text:string):string {
  return text.replace(/<\/?[a-z][^>]*>/giu,' ').replace(/&(?:amp|lt|gt|quot|apos|nbsp|#\d+|#x[\da-f]+);/giu,entity=>{
    const named:Record<string,string>={'&amp;':'&','&lt;':'<','&gt;':'>','&quot;':'"','&apos;':"'",'&nbsp;':' '};
    if(named[entity.toLowerCase()])return named[entity.toLowerCase()]!;
    const code=parseInt(entity.slice(entity[2]?.toLowerCase()==='x'?3:2,-1),entity[2]?.toLowerCase()==='x'?16:10);
    return code>0&&code<=0x10ffff?String.fromCodePoint(code):entity;
  }).replace(/\s+/gu,' ').trim();
}
export function evidenceContent(text:string):EvidenceContentBlock[] {
  const blocks:EvidenceContentBlock[]=[];let offset=0;
  const prose=(value:string)=>{const plain=evidencePlainText(value);if(plain)blocks.push({kind:'text',text:plain});};
  for(const table of text.matchAll(/<table\b[^>]*>[\s\S]*?<\/table\s*>/giu)){
    prose(text.slice(offset,table.index));
    const rows=[...table[0].matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr\s*>/giu)].map(row=>[...row[1]!.matchAll(/<(td|th)\b([^>]*)>([\s\S]*?)<\/\1\s*>/giu)].map(cell=>{
      const span=(name:string)=>{const match=new RegExp(`\\b${name}\\s*=\\s*["']?(\\d+)`,'iu').exec(cell[2]!);return Math.min(100,Math.max(1,Number(match?.[1]??1)));};
      return {text:evidencePlainText(cell[3]!),header:cell[1]!.toLowerCase()==='th',rowSpan:span('rowspan'),colSpan:span('colspan')};
    })).filter(row=>row.length);
    if(rows.length)blocks.push({kind:'table',rows});else prose(table[0]);
    offset=table.index!+table[0].length;
  }
  prose(text.slice(offset));return blocks;
}
function highlighted(text:string,values:string[]) {
  const words=[...new Set(values.map(evidencePlainText).filter(Boolean))].sort((a,b)=>b.length-a.length);
  if(!words.length)return text;
  const pattern=new RegExp(`(${words.map(word=>word.replace(/[.*+?^${}()|[\]\\]/gu,'\\$&')).join('|')})`,'giu');
  const selected=new Set(words.map(word=>word.toLocaleLowerCase()));
  return text.split(pattern).map((part,i)=>selected.has(part.toLocaleLowerCase())?<mark className="field-value-match" key={i}>{part}</mark>:part);
}
export function EvidenceContent({text,highlights=[]}:{text:string;highlights?:string[]}) {
  return <>{evidenceContent(text).map((block,i)=>block.kind==='text'?<p key={i}>{highlighted(block.text,highlights)}</p>:<div className="field-evidence-table-scroll" role="region" aria-label="原文表格，可横向滚动" tabIndex={0} key={i}><table className="field-evidence-table"><tbody>{block.rows.map((row,r)=><tr key={r}>{row.map((cell,c)=>{const Cell=cell.header?'th':'td';return <Cell key={c} rowSpan={cell.rowSpan} colSpan={cell.colSpan}>{highlighted(cell.text,highlights)}</Cell>;})}</tr>)}</tbody></table></div>)}</>;
}
