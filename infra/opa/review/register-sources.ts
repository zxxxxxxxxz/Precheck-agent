/** Source metadata only: never emits cell contents or creates executable rules. */
import { readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { indexWorkbookSources } from '@hsbc/server/modules/documents/validation/workbook-index';

const hash=(bytes:string|Buffer)=>createHash('sha256').update(bytes).digest('hex');
const value=(flag:string)=>{const index=process.argv.indexOf(flag);if(index<0||!process.argv[index+1])throw new Error('source_register_arguments_required');return process.argv[index+1]!;};
const known=[
  {id:'SRC-AR',catalogId:'bank-source-004',guaranteeType:'account_charge',businessLabel:'应收账款质押',ranges:['C4:F4','B4:G23','B5:E28']},
  {id:'SRC-PG',catalogId:'bank-source-010',guaranteeType:'personal_guarantee',businessLabel:'个人担保',ranges:['C4:F8','B4:G40','B4:F48']},
  {id:'SRC-CGT',catalogId:'bank-source-018',guaranteeType:'corporate_guarantee',businessLabel:'公司担保',ranges:['C4:F11','B4:G65','B4:F72']},
  {id:'SRC-SBLC',catalogId:'bank-source-029',guaranteeType:'sblc',businessLabel:'备用信用证',ranges:['C4:F5','B4:G39','B5:E32']},
  {id:'SRC-MTG',catalogId:'bank-source-033',guaranteeType:'mortgage',businessLabel:'房地产抵押',ranges:['C4:F6','B4:G81','B4:F81']},
];
async function main(){
  const catalog=JSON.parse(await readFile(value('--catalog'),'utf8')),input=JSON.parse(await readFile(value('--input'),'utf8'));
  if(hash(JSON.stringify(catalog.manifest))!==catalog.manifestSha256)throw new Error('source_catalog_integrity_failed');
  const sources=[];
  for(const source of known){
    const entry=catalog.manifest.entries.find((item:{id:string})=>item.id===source.catalogId);
    if(!entry||entry.format!=='xlsx')throw new Error('required_workbook_missing');
    const bytes=await readFile(resolve(input.rootDirectory,entry.path));
    if(hash(bytes)!==entry.sha256)throw new Error('source_workbook_changed');
    const index=indexWorkbookSources(bytes);
    const sheets=['材料清单','提取信息','规则校验'].map((name,i)=>{
      const sheet=index.sheets.find(sheet=>sheet.name===name);if(!sheet)throw new Error('required_workbook_sheet_missing');
      const range=source.ranges[i]!,match=/^[A-Z]+(\d+):[A-Z]+(\d+)$/.exec(range)!;
      const start=Number(match[1]),end=Number(match[2]);
      return {name,checklistRange:range,rows:sheet.rows.map(row=>({
        rowNumber:row.rowNumber,cellRefs:row.cellRefs,rowSha256:row.sha256,containsFormula:row.containsFormula,
        disposition:row.rowNumber<start?'excluded':row.rowNumber>end?'manual':source.guaranteeType==='mortgage'?'candidate':'manual',
        reason:row.rowNumber<start?'header_or_preamble_not_executable':row.rowNumber>end?'outside_counted_range_note_or_formatting_requires_source_review':source.guaranteeType==='mortgage'?'first_chain_source_candidate_pending_atomic_mapping_and_bank_confirmation':'outside_first_executable_chain_requires_manual_review_and_bank_confirmation',
        implementationIds:[],approvalRef:null,
      }))};
    });
    sources.push({...source,sha256:entry.sha256,disposition:source.guaranteeType==='mortgage'?'candidate':'manual',
      reference:`bank-confirmation-checklist-v0.5.md#11-2026-10-15-已取得材料来源登记`,approvalRef:null,sheets});
  }
  const result={schemaVersion:'review-source-dispositions.v1',basis:'docs/bank-confirmation-checklist-v0.5.md section 1.1',
    scope:'source_locations_and_pending_dispositions_only',catalogManifestSha256:catalog.manifestSha256,
    bankApprovedRules:0,executableMappings:0,cellContentsIncluded:false,
    countMeaning:'Physical source rows include headings, notes and formatting; they are not atomic rules or a rule pass-rate denominator.',sources};
  await writeFile(value('--output'),JSON.stringify(result,null,2)+'\n');
  console.log(JSON.stringify({code:'review_source_dispositions_registered',sources:sources.length,rows:sources.flatMap(source=>source.sheets.flatMap(sheet=>sheet.rows)).length,bankApprovedRules:0}));
}
main().catch(()=>{console.error('review_source_disposition_registration_failed');process.exitCode=1;});
