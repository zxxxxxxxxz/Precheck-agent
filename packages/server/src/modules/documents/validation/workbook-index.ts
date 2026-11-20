import { posix } from 'node:path';
import { SaxesParser } from 'saxes';
import { defaultDocxBudgets } from '@hsbc/contracts/docx';
import { readDocxZip } from '../../../document/docx-zip.js';
import { mockDigest } from './image.js';

interface Element {name:string;attrs:Record<string,string>}
/** Namespace-aware bounded XML events, with external entities/DTDs rejected. */
function xml(bytes:Buffer,onOpen:(tag:Element)=>void,onClose:(name:string)=>void,onText:(text:string)=>void){
  const text=new TextDecoder('utf-8',{fatal:true}).decode(bytes);
  if(/<!DOCTYPE|<!ENTITY/iu.test(text))throw new Error('catalog_xml_dtd_forbidden');
  let depth=0,nodes=0,characters=0;const parser=new SaxesParser({xmlns:true});
  parser.on('doctype',()=>{throw new Error('catalog_xml_dtd_forbidden');});
  parser.on('opentag',tag=>{if(++depth>128||++nodes>200000)throw new Error('catalog_xml_budget_exceeded');const attrs:Record<string,string>={};for(const a of Object.values(tag.attributes))attrs[a.local]=a.value;onOpen({name:tag.local,attrs});});
  parser.on('closetag',tag=>{onClose(tag.local);depth--;});
  const append=(value:string)=>{characters+=value.length;if(characters>5_000_000)throw new Error('catalog_xml_budget_exceeded');onText(value);};
  parser.on('text',append);parser.on('cdata',append);parser.on('error',()=>{throw new Error('catalog_xml_invalid');});parser.write(text).close();
}
export interface WorkbookSourceIndex {
  schemaVersion:'workbook-source-index.v1';sourceSha256:string;scope:'row_locations_only';rulesGenerated:0;formulasEvaluated:false;
  sheets:Array<{id:string;name:string;part:string;rows:Array<{rowNumber:number;cellRefs:string[];sha256:string;containsFormula:boolean}>}>;
}
export function indexWorkbookSources(bytes:Buffer):WorkbookSourceIndex{
  const pkg=readDocxZip(bytes,defaultDocxBudgets()),workbook=pkg.files.get('xl/workbook.xml'),relationships=pkg.files.get('xl/_rels/workbook.xml.rels');
  if(!workbook||!relationships)throw new Error('catalog_workbook_parts_missing');
  const rels=new Map<string,string>();
  xml(relationships,tag=>{if(tag.name!=='Relationship')return;const {Id,Target,Type,TargetMode}=tag.attrs;
    if(!Id||!Target||!Type)throw new Error('catalog_workbook_relationship_invalid');
    if(TargetMode==='External')return;
    if(!Type.endsWith('/worksheet'))return;
    if(Target.includes('\\')||Target.includes(':')||Target.includes('%')||Target.startsWith('/'))throw new Error('catalog_workbook_relationship_invalid');
    const part=posix.normalize(posix.join('xl',Target));if(!part.startsWith('xl/worksheets/')||!pkg.files.has(part))throw new Error('catalog_workbook_relationship_invalid');rels.set(Id,part);
  },()=>{},()=>{});
  const sheets:WorkbookSourceIndex['sheets']=[];
  xml(workbook,tag=>{if(tag.name==='sheet'){const part=rels.get(tag.attrs.id!);if(!part)throw new Error('catalog_workbook_sheet_unresolved');sheets.push({id:tag.attrs.sheetId!,name:tag.attrs.name!,part,rows:[]});}},()=>{},()=>{});
  if(!sheets.length||sheets.length>100)throw new Error('catalog_workbook_sheet_budget');
  for(const sheet of sheets){
    let row:WorkbookSourceIndex['sheets'][number]['rows'][number]|undefined,parts:unknown[]=[];const seen=new Set<number>();
    xml(pkg.files.get(sheet.part)!,tag=>{
      if(tag.name==='row'){
        const rowNumber=Number(tag.attrs.r);if(!Number.isSafeInteger(rowNumber)||rowNumber<1||rowNumber>1048576||seen.has(rowNumber))throw new Error('catalog_workbook_row_invalid');seen.add(rowNumber);
        row={rowNumber,cellRefs:[],sha256:'',containsFormula:false};parts=[];
      }
      if(row){parts.push(tag);if(tag.name==='f')row.containsFormula=true;if(tag.name==='c'){const ref=tag.attrs.r,match=ref&&/^([A-Z]{1,3})([1-9][0-9]*)$/.exec(ref);if(!match||Number(match[2])!==row.rowNumber)throw new Error('catalog_workbook_cell_invalid');row.cellRefs.push(ref!);}}
    },name=>{if(row)parts.push({close:name});if(name==='row'&&row){row.sha256=mockDigest(JSON.stringify(parts));sheet.rows.push(row);row=undefined;if(sheet.rows.length>100000)throw new Error('catalog_workbook_row_budget');}},value=>{if(row)parts.push(value);});
  }
  return {schemaVersion:'workbook-source-index.v1',sourceSha256:mockDigest(bytes),scope:'row_locations_only',rulesGenerated:0,formulasEvaluated:false,sheets};
}
