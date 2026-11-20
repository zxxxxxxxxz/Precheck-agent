import { inflateRawSync, crc32 } from 'node:zlib';
import { createHash } from 'node:crypto';
import type { DocxBudgets } from '@hsbc/contracts/docx';
export const docxHash=(data:Uint8Array|string)=>createHash('sha256').update(data).digest('hex');
export class DocxError extends Error { constructor(readonly code:string){super(code);} }
const fail=(code:string):never=>{throw new DocxError(code);};
export interface DocxPackage { files:Map<string,Buffer>; expandedBytes:number; contentFingerprint:string }
/** ZIP32 only, central and local metadata agree; no file is extracted to disk. */
export function readDocxZip(input:Uint8Array,b:DocxBudgets):DocxPackage {
  const data=Buffer.from(input);
  if(!data.length||data.length>b.maxInputBytes)fail('docx_input_budget');
  if(data.length<22||data.readUInt32LE(0)!==0x04034b50)fail('docx_not_zip');
  let end=-1;
  for(let p=data.length-22;p>=Math.max(0,data.length-65557);p--)if(data.readUInt32LE(p)===0x06054b50&&p+22+data.readUInt16LE(p+20)===data.length){end=p;break;}
  if(end<0)fail('docx_invalid_zip');
  const disk=data.readUInt16LE(end+4),centralDisk=data.readUInt16LE(end+6),diskEntries=data.readUInt16LE(end+8),entries=data.readUInt16LE(end+10),centralSize=data.readUInt32LE(end+12),centralOffset=data.readUInt32LE(end+16);
  if(disk||centralDisk||diskEntries!==entries||entries===0xffff||centralOffset===0xffffffff||centralSize===0xffffffff)fail('docx_unsupported_zip');
  if(!entries||entries>b.maxEntries)fail('docx_entry_budget');
  if(centralOffset+centralSize!==end)fail('docx_invalid_zip_directory');
  const files=new Map<string,Buffer>(),names=new Set<string>(),ranges:Array<[number,number]>=[];let offset=centralOffset,total=0;
  for(let i=0;i<entries;i++){
    if(offset+46>end||data.readUInt32LE(offset)!==0x02014b50)fail('docx_invalid_zip_entry');
    const flags=data.readUInt16LE(offset+8),method=data.readUInt16LE(offset+10),crc=data.readUInt32LE(offset+16),compressed=data.readUInt32LE(offset+20),expanded=data.readUInt32LE(offset+24),nameLength=data.readUInt16LE(offset+28),extra=data.readUInt16LE(offset+30),comment=data.readUInt16LE(offset+32),local=data.readUInt32LE(offset+42),external=data.readUInt32LE(offset+38);
    if(flags&1||flags&0x40)fail('docx_encrypted_zip');
    if(flags&~0x80e||method===0&&(flags&6))fail('docx_unsupported_zip_flags');
    if(method!==0&&method!==8)fail('docx_unsupported_compression');
    if(compressed===0xffffffff||expanded===0xffffffff||local===0xffffffff||data.readUInt16LE(offset+34)!==0)fail('docx_unsupported_zip');
    if(offset+46+nameLength+extra+comment>end||!nameLength)fail('docx_invalid_zip_entry');
    const nameBytes=data.subarray(offset+46,offset+46+nameLength);let name='';
    try{name=new TextDecoder('utf-8',{fatal:true}).decode(nameBytes);}catch{fail('docx_invalid_entry_name');}
    if(name!.startsWith('/')||name!.includes('\\')||name!.includes('\0')||name!.includes(':')||name!.split('/').some(p=>p==='..'||p==='.')||/[%\x00-\x1f\x7f]/u.test(name!)||name!.normalize('NFC')!==name)fail('docx_unsafe_entry_path');
    const folded=name!.toLowerCase();if(names.has(folded))fail('docx_duplicate_entry');names.add(folded);
    const unixType=(external>>>16)&0xf000;if(unixType&&unixType!==0x8000&&unixType!==0x4000)fail('docx_unsupported_entry_type');
    if(local+30>centralOffset||data.readUInt32LE(local)!==0x04034b50)fail('docx_invalid_local_header');
    const localNameLength=data.readUInt16LE(local+26),localExtra=data.readUInt16LE(local+28),start=local+30+localNameLength+localExtra,finish=start+compressed;
    if(data.readUInt16LE(local+6)!==flags||data.readUInt16LE(local+8)!==method||!data.subarray(local+30,local+30+localNameLength).equals(nameBytes)||finish>centralOffset)fail('docx_header_mismatch');
    if(!(flags&8)&&(data.readUInt32LE(local+14)!==crc||data.readUInt32LE(local+18)!==compressed||data.readUInt32LE(local+22)!==expanded))fail('docx_header_mismatch');
    if(ranges.some(([a,z])=>local<z&&finish>a))fail('docx_overlapping_entries');ranges.push([local,finish]);
    if(expanded>b.maxEntryBytes||total+expanded>b.maxExpandedBytes)fail('docx_expansion_budget');
    if(expanded>0&&(!compressed||expanded/compressed>b.maxCompressionRatio))fail('docx_compression_ratio_budget');
    let bytes:Buffer;
    try{bytes=method===0?Buffer.from(data.subarray(start,finish)):inflateRawSync(data.subarray(start,finish),{maxOutputLength:Math.min(b.maxEntryBytes,b.maxExpandedBytes-total)+1});}catch{fail('docx_invalid_deflate');}
    if(bytes!.length!==expanded||crc32(bytes!)!==crc)fail('docx_crc_or_size_mismatch');
    total+=bytes!.length;
    if(name!.endsWith('/')){if(bytes!.length)fail('docx_invalid_directory');}
    else files.set(name!,bytes!);
    offset+=46+nameLength+extra+comment;
  }
  if(offset!==end)fail('docx_invalid_zip_directory');
  if([...files.keys()].some(p=>/vbaProject|vbaData|\/activeX\/|\/embeddings\//iu.test(p)))fail('docx_active_content_unsupported');
  return {files,expandedBytes:total,contentFingerprint:docxHash([...files].sort(([a],[b])=>a.localeCompare(b,'en')).map(([name,bytes])=>`${name}\0${docxHash(bytes)}`).join('\n'))};
}
