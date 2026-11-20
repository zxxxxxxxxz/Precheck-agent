/** Small, dependency-free OOXML writer for the review checklist (text and numbers only). */
export type ChecklistTone='problem'|'pending'|'incomplete'|'clear'|'not_applicable';
export interface ChecklistWorkbook {
  notes:string[];
  headers:string[];
  widths:number[];
  rows:Array<{tone:ChecklistTone;values:Array<string|number>}>;
}
export const CHECKLIST_COLORS:Record<ChecklistTone,string>={problem:'FCE7E4',pending:'FFF3DC',incomplete:'F3F3F3',clear:'E2F0D9',not_applicable:'F3F3F3'};
const tones:ChecklistTone[]=['problem','pending','incomplete','clear','not_applicable'];
const encoder=new TextEncoder();
const ns='http://schemas.openxmlformats.org/spreadsheetml/2006/main';
const rel='http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const xml=(body:string)=>`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>${body}`;
function escape(value:string):string {
  // OOXML uses _xHHHH_ escapes; protect literal escape-like text before encoding controls.
  return value.replace(/_x[0-9a-f]{4}_/gi,match=>'_x005F_'+match.slice(1))
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\uFFFE\uFFFF]/g,c=>`_x${c.charCodeAt(0).toString(16).padStart(4,'0')}_`)
    .replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&apos;'}[c]!)).replace(/\r/g,'&#13;');
}
function column(index:number):string {
  let result='';for(let n=index+1;n>0;n=Math.floor((n-1)/26))result=String.fromCharCode(65+(n-1)%26)+result;
  return result;
}
function cell(value:string|number,row:number,col:number,style:number):string {
  const address=`${column(col)}${row}`;
  if(typeof value==='number')return `<c r="${address}" s="${style}"><v>${value}</v></c>`;
  if(value.length>32767)throw new Error('单项内容超过 Excel 单元格容量，请联系管理员处理。');
  // Explicit strings keep leading zeroes, dates and formula-like user text intact and inert.
  return `<c r="${address}" s="${style}" t="inlineStr"><is><t xml:space="preserve">${escape(value)}</t></is></c>`;
}

/** ZIP STORE, UTF-8 names, CRC32. No macros, formulas, external links or shared strings. */
function zip(entries:Record<string,string>):Uint8Array<ArrayBuffer> {
  const table=Array.from({length:256},(_,n)=>{for(let k=0;k<8;k++)n=n&1?0xEDB88320^(n>>>1):n>>>1;return n>>>0;});
  const crc=(bytes:Uint8Array)=>{let n=0xFFFFFFFF;for(const byte of bytes)n=table[(n^byte)&255]!^(n>>>8);return (n^0xFFFFFFFF)>>>0;};
  const local:Uint8Array[]=[],central:Uint8Array[]=[];let offset=0;
  for(const [path,text] of Object.entries(entries)){
    const name=encoder.encode(path),data=encoder.encode(text),checksum=crc(data);
    const header=new Uint8Array(30+name.length),h=new DataView(header.buffer);
    h.setUint32(0,0x04034B50,true);h.setUint16(4,20,true);h.setUint16(6,0x0800,true);h.setUint16(12,33,true);
    h.setUint32(14,checksum,true);h.setUint32(18,data.length,true);h.setUint32(22,data.length,true);h.setUint16(26,name.length,true);header.set(name,30);
    const directory=new Uint8Array(46+name.length),d=new DataView(directory.buffer);
    d.setUint32(0,0x02014B50,true);d.setUint16(4,20,true);d.setUint16(6,20,true);d.setUint16(8,0x0800,true);d.setUint16(14,33,true);
    d.setUint32(16,checksum,true);d.setUint32(20,data.length,true);d.setUint32(24,data.length,true);d.setUint16(28,name.length,true);d.setUint32(42,offset,true);directory.set(name,46);
    local.push(header,data);central.push(directory);offset+=header.length+data.length;
  }
  const centralSize=central.reduce((n,b)=>n+b.length,0),end=new Uint8Array(22),e=new DataView(end.buffer);
  e.setUint32(0,0x06054B50,true);e.setUint16(8,central.length,true);e.setUint16(10,central.length,true);e.setUint32(12,centralSize,true);e.setUint32(16,offset,true);
  const result=new Uint8Array(offset+centralSize+end.length);let cursor=0;
  for(const bytes of [...local,...central,end]){result.set(bytes,cursor);cursor+=bytes.length;}return result;
}

export function checklistXlsx(input:ChecklistWorkbook):Uint8Array<ArrayBuffer> {
  const headerRow=input.notes.length+2,lastRow=headerRow+input.rows.length,lastColumn=column(input.headers.length-1);
  if(lastRow>1048576)throw new Error('清单超过 Excel 行数限制，请联系管理员处理。');
  const noteRows=input.notes.map((note,index)=>`<row r="${index+1}" ht="${index===0?30:42}" customHeight="1">${cell(note,index+1,0,index===0?1:0)}</row>`);
  const headers=`<row r="${headerRow}" ht="28" customHeight="1">${input.headers.map((name,i)=>cell(name,headerRow,i,2)).join('')}</row>`;
  const rows=input.rows.map((record,index)=>{
    const row=headerRow+index+1,style=3+tones.indexOf(record.tone);
    const lines=Math.max(...record.values.map((value,i)=>String(value).split('\n').reduce((n,line)=>n+Math.max(1,Math.ceil([...line].reduce((width,c)=>width+(c.charCodeAt(0)>255?2:1),0)/(input.widths[i]!-2))),0)));
    return `<row r="${row}" ht="${Math.min(409,Math.max(48,lines*16+12))}" customHeight="1">${record.values.map((value,i)=>cell(value,row,i,style)).join('')}</row>`;
  });
  const fills=['<fill><patternFill patternType="none"/></fill>','<fill><patternFill patternType="gray125"/></fill>',...['333333',...tones.map(t=>CHECKLIST_COLORS[t])].map(color=>`<fill><patternFill patternType="solid"><fgColor rgb="FF${color}"/><bgColor indexed="64"/></patternFill></fill>`)];
  const xf=(font:number,fill:number)=>`<xf numFmtId="0" fontId="${font}" fillId="${fill}" borderId="0" xfId="0" applyFont="1" applyFill="1" applyAlignment="1"><alignment vertical="top" wrapText="1"/></xf>`;
  return zip({
    '[Content_Types].xml':xml('<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/></Types>'),
    '_rels/.rels':xml(`<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="${rel}/officeDocument" Target="xl/workbook.xml"/></Relationships>`),
    'xl/workbook.xml':xml(`<workbook xmlns="${ns}" xmlns:r="${rel}"><sheets><sheet name="预审检查清单" sheetId="1" r:id="rId1"/></sheets></workbook>`),
    'xl/_rels/workbook.xml.rels':xml(`<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="${rel}/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="${rel}/styles" Target="styles.xml"/></Relationships>`),
    'xl/styles.xml':xml(`<styleSheet xmlns="${ns}"><fonts count="3"><font><sz val="11"/><name val="Arial"/><color rgb="FF333333"/></font><font><b/><sz val="16"/><name val="Arial"/><color rgb="FFDB0011"/></font><font><b/><sz val="11"/><name val="Arial"/><color rgb="FFFFFFFF"/></font></fonts><fills count="${fills.length}">${fills.join('')}</fills><borders count="1"><border/></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="8">${xf(0,0)}${xf(1,0)}${xf(2,2)}${tones.map((_,i)=>xf(0,i+3)).join('')}</cellXfs><cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>`),
    'xl/worksheets/sheet1.xml':xml(`<worksheet xmlns="${ns}"><dimension ref="A1:${lastColumn}${lastRow}"/><sheetViews><sheetView workbookViewId="0" showGridLines="0"><pane xSplit="2" ySplit="${headerRow}" topLeftCell="C${headerRow+1}" activePane="bottomRight" state="frozen"/></sheetView></sheetViews><sheetFormatPr defaultRowHeight="18"/><cols>${input.widths.map((width,i)=>`<col min="${i+1}" max="${i+1}" width="${width}" customWidth="1"/>`).join('')}</cols><sheetData>${noteRows.join('')}${headers}${rows.join('')}</sheetData><autoFilter ref="A${headerRow}:${lastColumn}${lastRow}"/><mergeCells count="${input.notes.length}">${input.notes.map((_,i)=>`<mergeCell ref="A${i+1}:${lastColumn}${i+1}"/>`).join('')}</mergeCells></worksheet>`),
  });
}
