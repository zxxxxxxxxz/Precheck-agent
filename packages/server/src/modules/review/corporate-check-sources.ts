import {createHash} from 'node:crypto';
import type {FieldReviewItem,ReviewedRuleInputs} from '@hsbc/contracts/field-verification';
import type {ChecklistRow} from '@hsbc/contracts/review-checklist';
import type {ReviewFacts} from '@hsbc/contracts/review-config';
import type {DB} from '../../infrastructure/database/client.js';
import type {DocumentPageArtifact} from '@hsbc/contracts/documents';
import type {EvidenceAnchor} from '@hsbc/contracts/evidence';
import type {ChecklistInputDocument} from './checklist.js';
import {fieldReviewOriginalReader,originalContains,originalTextKey} from './field-review-original.js';

export type CorporateSource=FieldReviewItem['sources'][number];
export type CorporatePage={document:ChecklistInputDocument;number:number;text:string;trusted:boolean;sources:CorporateSource[];page:DocumentPageArtifact;anchors:EvidenceAnchor[];formNumber:(regionId:string)=>CorporateSource|undefined};
export const corporateTextKey=(s:string)=>originalTextKey(s).toUpperCase();
export const corporateNameKey=(s:string)=>corporateTextKey(s).replace(/[\s,，.。()（）]/gu,'');
export const uniqueSources=(sources:CorporateSource[])=>[...new Map(sources.map(s=>[JSON.stringify(s),s])).values()];

/** A grounded sentence may span adjacent native text blocks. Locate its actual
 * overlapping anchor on this complete trusted page, never a header elsewhere. */
export function corporatePageStatements(pages:CorporatePage[],taxonomy:string,pattern:RegExp):CorporateSource[]{
 return pages.filter(p=>p.trusted&&p.document.taxonomyIds.includes(taxonomy)&&p.text.length<=16000).flatMap(p=>{
  const match=new RegExp(pattern.source,pattern.flags.replace(/[gy]/gu,'')).exec(p.text);if(!match)return [];
  // Keep every overlapping block's real anchor and exact quote. Attaching the
  // whole page to one block anchor would create a receipt that cannot be read
  // back through the original-source reader.
  return p.sources.filter(s=>{const start=p.text.indexOf(s.quote);return start>=0&&start<match.index+match[0].length&&start+s.quote.length>match.index;});
 });
}

/** No model output or background quotation becomes a field value. Every selected
 * original is re-read; an explicit business fact may veto its use. */
export async function corporateCheckSources(db:DB,rows:ChecklistRow[],scope:ReviewedRuleInputs,documents:ChecklistInputDocument[],facts:ReviewFacts){
 const reader=fieldReviewOriginalReader(db,{humanReviewed:true});
 const own=rows.filter(r=>r.objectId===(scope.scopeId.startsWith('unconfirmed:')?null:scope.scopeId)&&r.objectRole==='corporate_guarantee');
 const current=documents.filter(d=>scope.documentIds.includes(d.id)&&d.adopted&&d.projectionCurrent&&['ready','partial'].includes(d.state)&&!d.invalidFieldIds?.includes('*'));
 const selected=new Map<string,CorporateSource[]>();
 const reviewed=new Map<string,CorporateSource[]>();
 for(const row of own){
  const v=row.verification;if(!v||v.origin||v.validity!=='current'||!['consistent','pending'].includes(v.meaning))continue;
  const input=scope.inputs[row.fieldId],effective=facts[row.fieldId];
  if(input&&(!effective||effective.state!=='present'||effective.value!==input.fact.value))continue;
  // Pending clauses are readable evidence, not adopted comparison values.
  // Their null comparison key must not prevent checking what the clause says.
  const sources=v.sources.filter(s=>s.kind==='original'&&s.value.trim());
  const valid=await Promise.all(sources.map(async s=>{
   const d=current.find(d=>d.id===s.evidence.documentVersionId&&d.parseRevision===s.evidence.parseRevision&&d.directoryRevision===s.evidence.directoryRevision&&!d.invalidFieldIds?.includes(row.fieldId));
   return !!d&&(await reader(s.evidence,s.quote)).some(q=>q.page===s.page&&originalContains(q.quote,s.value));
  }));
  if(sources.length&&valid.every(Boolean))reviewed.set(row.fieldId,sources);
  const comparisons=sources.filter(s=>s.comparisonKey!==null);
  if(v.meaning==='consistent'&&comparisons.length&&sources.every((s,i)=>s.comparisonKey===null||valid[i]))selected.set(row.fieldId,comparisons);
 }
 const values=(id:string,type?:string)=>selected.get(id)?.filter(s=>!type||current.some(d=>d.id===s.evidence.documentVersionId&&d.taxonomyIds.includes(type)))??[];
 const pages:CorporatePage[]=[];
 // Inspect the complete pinned inventory, including documents without a field
 // selection. Absence is meaningful only when every expected page was readable.
 const coverage=new Map<string,boolean>();
 for(const document of current){
  const artifact=(await db.query('SELECT body FROM business.document_artifacts WHERE job_id=$1 AND directory_revision=$2',[document.parseRevision,document.directoryRevision])).rows[0]?.body;
  if(!artifact||!Number.isInteger(artifact.pageCount)||artifact.pageCount<1||artifact.pageCount>500){coverage.set(document.id,false);continue;}
  let complete=true;
  for(let number=1;number<=artifact.pageCount;number++){
   const page=(await db.query('SELECT body FROM business.document_pages WHERE job_id=$1 AND page_number=$2',[document.parseRevision,number])).rows[0]?.body;
   if(!page||page.processing?.ocrSimulated||page.status==='failed'||page.scope?.documentVersionId!==document.id||page.scope?.parseRevision!==document.parseRevision||page.page?.page_number!==number||page.page?.source_sha256!==page.scope?.sourceSha256){complete=false;continue;}
   const regions=(page.regions??[]).filter((r:any)=>r.document_version_id===document.id&&r.parse_revision===document.parseRevision&&r.page_asset_id===page.page.page_asset_id&&r.processing_status==='ready'&&typeof r.raw_text==='string'&&r.raw_text_sha256===createHash('sha256').update(r.raw_text).digest('hex')&&!/word[:_-]/u.test(r.source_id??''));
   const channel=(name:string)=>regions.filter((r:any)=>r.source===name).sort((a:any,b:any)=>a.reading_order-b.reading_order);
   const native=page.nativeTrust==='validated_geometry_and_visibility',chosen=channel(native?'native_pdf':'pp_ocr');
   const text=chosen.map((r:any)=>r.raw_text).join('\n');
   const independent=channel('vl_ocr').map((r:any)=>r.raw_text).join('\n');
   // Non-native OCR can support a located statement only when another channel
   // agrees. It never establishes whole-file absence/completeness on its own.
   const sources:CorporateSource[]=chosen.flatMap((r:any)=>{
    if(!r.raw_text.trim()||r.raw_text.length>16000||!native&&!originalContains(independent,r.raw_text))return [];
    const anchor=artifact.anchors?.find((a:any)=>a.document_version_id===document.id&&a.parse_revision===document.parseRevision&&a.page_number===number&&a.block_ids?.includes(r.region_id));
    if(!anchor)return [];
    return [{filename:document.filename,page:number,evidence:{documentVersionId:document.id,parseRevision:document.parseRevision!,directoryRevision:document.directoryRevision!,anchorId:anchor.anchor_id},kind:'original' as const,comparisonKey:'computed-context',quote:r.raw_text,value:r.raw_text.slice(0,8000),highlights:[]}];
   });
   const trusted=native&&chosen.length>0&&sources.length===chosen.filter((r:any)=>r.raw_text.trim()).length;
   // A narrow numeric form cell can be independently corroborated by native
   // text at the same geometry even when unrelated parts of the native page
   // failed validation. This does not bless the rest of that text layer.
   const formNumber=(regionId:string):CorporateSource|undefined=>{
    const r=regions.find((r:any)=>r.region_id===regionId&&r.source==='pp_ocr'&&/^\d{1,4}$/u.test(r.raw_text.trim()));if(!r)return;
    const box=(r:any)=>{const ps=(r.polygons??[]).flat();return [Math.min(...ps.map((p:number[])=>p[0]!)),Math.max(...ps.map((p:number[])=>p[0]!)),Math.min(...ps.map((p:number[])=>p[1]!)),Math.max(...ps.map((p:number[])=>p[1]!))];};
    const a=box(r),other=regions.find((n:any)=>{const b=box(n);return n.source==='native_pdf'&&n.raw_text.trim()===r.raw_text.trim()&&Math.min(a[1]!,b[1]!)>Math.max(a[0]!,b[0]!)&&Math.min(a[3]!,b[3]!)>Math.max(a[2]!,b[2]!);});
    const anchor=artifact.anchors?.find((a:any)=>a.document_version_id===document.id&&a.parse_revision===document.parseRevision&&a.page_number===number&&a.block_ids?.includes(regionId));
    if(!other||!anchor)return;
    return {filename:document.filename,page:number,evidence:{documentVersionId:document.id,parseRevision:document.parseRevision!,directoryRevision:document.directoryRevision!,anchorId:anchor.anchor_id},kind:'original',comparisonKey:'corroborated-form-number',quote:r.raw_text,value:r.raw_text,highlights:[]};
   };
   complete=complete&&trusted;pages.push({document,number,text,trusted,sources,page,anchors:artifact.anchors??[],formNumber});
  }
  coverage.set(document.id,complete);
 }
 return {own,current,values,selected,reviewed,pages,coverage,facts};
}
export type CorporateCheckContext=Awaited<ReturnType<typeof corporateCheckSources>>;
