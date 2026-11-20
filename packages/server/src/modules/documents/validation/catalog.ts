import { createHash } from 'node:crypto';
import { lstat,mkdir,open,readFile,realpath,rename } from 'node:fs/promises';
import { dirname,extname,isAbsolute,relative,resolve,sep } from 'node:path';
import { z } from 'zod';
import { mockDigest } from './image.js';
import { indexWorkbookSources,type WorkbookSourceIndex } from './workbook-index.js';

const id=z.string().regex(/^[A-Za-z0-9_-]{1,80}$/);
export const BankCatalogInputSchema=z.strictObject({
  schemaVersion:z.literal('bank-source-input.v1'),rootDirectory:z.string().min(1),
  authorization:z.strictObject({environment:z.literal('hsbc.mse.pub'),purpose:z.literal('p2_validation'),confirmed:z.literal(true)}),
  files:z.array(z.strictObject({id,path:z.string().min(1),purpose:z.enum(['case_material','rule_reference','template','legal_opinion_sample','other_reference']),
    completeness:z.enum(['complete','excerpt','unknown']),contentFamily:id.optional(),contentFingerprint:z.string().regex(/^[a-f0-9]{64}$/).optional(),
    disposition:z.strictObject({status:z.enum(['reference_only','needs_confirmation','accepted_sample']),owner:id,sourceLocation:z.string().max(200).optional()})})).min(1).max(1000),
});
export type BankCatalogInput=z.infer<typeof BankCatalogInputSchema>;
function contained(root:string,path:string){const r=relative(root,path);return r!==''&&!r.startsWith(`..${sep}`)&&r!=='..'&&!isAbsolute(r);}
/** Records source inventory only: neither workbook cells nor rules are interpreted. */
export async function buildBankCatalog(raw:unknown,expectedCount=39){
  const input=BankCatalogInputSchema.parse(raw);
  if(input.files.length!==expectedCount||new Set(input.files.map(f=>f.id)).size!==input.files.length)throw new Error('catalog_count_or_identifier_mismatch');
  const root=await realpath(input.rootDirectory),seenPaths=new Set<string>();
  const entries:Array<BankCatalogInput['files'][number]&{bytes:number;sha256:string;format:string;fingerprintStatus:string;completenessBasis:string;parsingAccepted:boolean;ruleGeneration:boolean;retention:{automaticExpiry:boolean};splitEligible:boolean;evaluationGroup:string;workbookSourceIndex?:WorkbookSourceIndex}>=[];
  for(const source of input.files){
    const candidate=resolve(root,source.path);
    if(!contained(root,candidate)||(await lstat(candidate)).isSymbolicLink())throw new Error('catalog_source_path_invalid');
    const path=await realpath(candidate);
    if(!contained(root,path)||seenPaths.has(path))throw new Error('catalog_duplicate_path');seenPaths.add(path);
    const stat=await lstat(path);if(!stat.isFile()||stat.size<1||stat.size>50*1024*1024)throw new Error('catalog_file_budget_exceeded');
    const bytes=await readFile(path);if(bytes.length!==stat.size)throw new Error('catalog_source_changed');
    const extension=extname(path).toLowerCase();
    if(!['.pdf','.docx','.xlsx'].includes(extension))throw new Error('catalog_unsupported_file');
    const headerValid=extension==='.pdf'?bytes.subarray(0,5).toString()==='%PDF-':bytes.subarray(0,4).equals(Buffer.from([80,75,3,4]));
    if(!headerValid)throw new Error('catalog_container_mismatch');
    entries.push({...source,path:relative(root,path),bytes:bytes.length,sha256:mockDigest(bytes),format:extension.slice(1),
      fingerprintStatus:source.contentFingerprint?'operator_supplied':'content_not_extracted',
      completenessBasis:'operator_manifest',
      parsingAccepted:false,ruleGeneration:false,retention:{automaticExpiry:false},
      splitEligible:source.completeness==='complete'&&Boolean(source.contentFamily||source.contentFingerprint),
      evaluationGroup:source.contentFamily??(source.contentFingerprint?`content-${source.contentFingerprint}`:'unreviewed-source-family'),
      ...(extension==='.xlsx'?{workbookSourceIndex:indexWorkbookSources(bytes)}:{})});
  }
  // Union byte-identical files and operator-confirmed content families. Cross-container
  // similarity is explicitly unresolved until a reviewer supplies the family/fingerprint.
  const groups=new Map<string,string[]>();
  for(const e of entries){const same=entries.filter(other=>other.sha256===e.sha256||other.evaluationGroup===e.evaluationGroup);const key=same.map(x=>x.id).sort()[0]!;const members=groups.get(key)??[];for(const x of same)if(!members.includes(x.id))members.push(x.id);groups.set(key,members);}
  // Transitive closure handles a byte duplicate linked to a second content family.
  const families=[...groups.values()];let merged=true;
  while(merged){merged=false;outer:for(let i=0;i<families.length;i++)for(let j=i+1;j<families.length;j++)if(families[i]!.some(x=>families[j]!.includes(x))){families[i]=[...new Set([...families[i]!,...families[j]!])];families.splice(j,1);merged=true;break outer;}}
  for(const family of families){const group=`source-family-${mockDigest(family.sort().join('\n')).slice(0,20)}`;for(const e of entries)if(family.includes(e.id))e.evaluationGroup=group;}
  const manifest={schemaVersion:'bank-source-catalog.v1',createdAt:new Date().toISOString(),authorization:input.authorization,expectedCount,actualCount:entries.length,originalsRewritten:false,
    scope:'source_inventory_only',retention:{automaticExpiry:false},entries,duplicateByteGroups:[...new Set(entries.map(e=>e.sha256))].map(sha256=>({sha256,ids:entries.filter(e=>e.sha256===sha256).map(e=>e.id)})).filter(g=>g.ids.length>1),
    unresolvedContentFamilies:entries.filter(e=>e.fingerprintStatus==='content_not_extracted'&&!e.contentFamily).map(e=>e.id)};
  return {manifest,manifestSha256:createHash('sha256').update(JSON.stringify(manifest)).digest('hex')};
}
/** Confidential inventories stay beneath the ignored .local directory with mode 0600. */
export async function writePrivateJson(path:string,value:unknown){
  const root=resolve('.local'),destination=resolve(path);
  if(!contained(root,destination))throw new Error('private_local_output_required');
  await mkdir(dirname(destination),{recursive:true,mode:0o700});
  const actualRoot=await realpath(root),actualParent=await realpath(dirname(destination));
  if(actualParent!==actualRoot&&!contained(actualRoot,actualParent))throw new Error('private_local_output_required');
  const temporary=`${destination}.tmp-${process.pid}`,handle=await open(temporary,'wx',0o600);
  try{await handle.writeFile(JSON.stringify(value,null,2)+'\n');}finally{await handle.close();}
  await rename(temporary,destination);
}
