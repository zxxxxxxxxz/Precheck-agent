import {personalDateRegions} from './personal-date-source.js';
import type {ReviewEvidence} from '@hsbc/contracts/review';
import type {DB} from '../../infrastructure/database/client.js';
import {createHash} from 'node:crypto';

/** Read only the cited, fixed source location. Never search another page/person. */
export function fieldReviewOriginalReader(db:DB,options:{independentText?:boolean;humanReviewed?:boolean;personalDate?:boolean}={}) {
  const cache=new Map<string,Promise<Array<{page:number;quote:string;corroboratingQuotes?:string[]}>>>();
  // Many fields cite the same immutable page. Keep this cache within one review
  // reader/transaction, never across cases or source revisions.
  const bodies=new Map<string,Promise<any>>();
  const body=(sql:string,parameters:Array<string|number|null>)=>{
    const key=JSON.stringify([sql,parameters]);
    if(!bodies.has(key))bodies.set(key,db.query(sql,parameters).then(result=>result.rows[0]?.body));
    return bodies.get(key)!;
  };
  return (e:ReviewEvidence,selectedQuote?:string)=>{
    const key=JSON.stringify([e,options.humanReviewed?selectedQuote:null]);
    if(!cache.has(key))cache.set(key,(async()=>{
      if(e.sourceNodeId){
        const source=await body('SELECT body FROM business.document_sources WHERE job_id=$1',[e.parseRevision]);
        const node=source?.nodes?.find((n:any)=>n.id===e.sourceNodeId&&n.visibility==='visible'&&!n.excludedFromVisibleFacts);
        const quote=node?.visibleText;
        return typeof quote==='string'&&quote.trim()?[{page:1,quote}]:[];
      }
      if(!e.anchorId)return [];
      // Only fixed-location anchors are needed; never transfer unrelated OCR chunks on checklist polling.
      const artifact=await body("SELECT jsonb_build_object('anchors',body->'anchors') AS body FROM business.document_artifacts WHERE job_id=$1 AND directory_revision=$2",[e.parseRevision,e.directoryRevision]);
      const anchor=artifact?.anchors?.find((a:any)=>a.anchor_id===e.anchorId&&a.document_version_id===e.documentVersionId&&a.parse_revision===e.parseRevision);
      if(!anchor)return [];
      const page=await body('SELECT body FROM business.document_pages WHERE job_id=$1 AND page_number=$2',[e.parseRevision,anchor.page_number]);
      if(!options.humanReviewed)return fieldReviewPageQuotes(e,anchor,page,options);
      if(!page||page.processing?.ocrSimulated||options.independentText&&page.status==='failed')return [];
      // A current human source selection can resolve OCR disagreements. This
      // option is used only after validating the saved review and document pins;
      // automatic extraction continues to require conflict-free source text.
      const eligible=(r:any)=>r.processing_status==='ready'&&(options.humanReviewed||!r.coverage_gaps?.length&&
        !page.conflicts?.some((c:any)=>c.region_ids.includes(r.region_id)))&&typeof r.raw_text==='string'&&r.raw_text.trim()&&
        r.raw_text_sha256===createHash('sha256').update(r.raw_text).digest('hex');
      const current=(r:any)=>r.document_version_id===e.documentVersionId&&r.parse_revision===e.parseRevision&&r.page_asset_id===page.page?.page_asset_id;
      const overlaps=(a:any,b:any)=>{
        const box=(r:any)=>{const p=(r.polygons??[]).flat();return [Math.min(...p.map((v:number[])=>v[0]!)),Math.max(...p.map((v:number[])=>v[0]!)),Math.min(...p.map((v:number[])=>v[1]!)),Math.max(...p.map((v:number[])=>v[1]!))];};
        const x=box(a),y=box(b);return Math.max(x[0]!,y[0]!)<Math.min(x[1]!,y[1]!)&&Math.max(x[2]!,y[2]!)<Math.min(x[3]!,y[3]!);
      };
      const anchored=(page.regions??[]).filter((r:any)=>anchor.block_ids?.includes(r.region_id)&&eligible(r)&&(!(options.independentText||options.humanReviewed)||current(r)&&r.source!=='image'));
      const quotes=anchored.map((r:any)=>{
        if(!options.independentText||r.source==='native_pdf'&&page.nativeTrust==='validated_geometry_and_visibility')return {page:anchor.page_number,quote:r.raw_text};
        const corroboratingQuotes=['native_pdf','pp_ocr','vl_ocr'].filter(channel=>channel!==r.source&&(channel!=='native_pdf'||page.nativeTrust==='validated_geometry_and_visibility')).map(channel=>
          (page.regions??[]).filter((other:any)=>other.source===channel&&current(other)&&overlaps(r,other)).sort((a:any,b:any)=>a.reading_order-b.reading_order)
            .map((other:any)=>eligible(other)?other.raw_text:'\u0000').join('\n'));
        return {page:anchor.page_number,quote:r.raw_text,corroboratingQuotes};
      });
      // Saved human selections may span adjacent text blocks. Reconstruct only
      // their exact quotation on the same pinned page and text channel, with a
      // cited block inside that quotation. Unreadable blocks remain barriers;
      // no value-only search, cross-page join or OCR-channel mixing is allowed.
      if(options.humanReviewed&&selectedQuote?.trim())for(const channel of ['native_pdf','pp_ocr','vl_ocr']){
        const located=(page.regions??[]).filter((r:any)=>r.source===channel&&current(r)&&eligible(r)&&
          anchored.some((a:any)=>a.region_id===r.region_id||overlaps(a,r)));
        if(!located.some((r:any)=>originalContains(selectedQuote,r.raw_text)))continue;
        const text=(page.regions??[]).filter((r:any)=>r.source===channel).sort((a:any,b:any)=>a.reading_order-b.reading_order)
          .map((r:any)=>current(r)&&(eligible(r)||r.processing_status==='ready'&&typeof r.raw_text==='string'&&!r.raw_text.trim()&&
            r.raw_text_sha256===createHash('sha256').update(r.raw_text).digest('hex'))?r.raw_text:'\u0000').join('\n');
        if(originalContains(text,selectedQuote))quotes.push({page:anchor.page_number,quote:selectedQuote});
      }
      return quotes;
    })());
    return cache.get(key)!;
  };
}

/** Shared fixed-location PDF inspection for in-memory checklist projections. */
export function fieldReviewPageQuotes(e:ReviewEvidence,anchor:any,page:any,options:{independentText?:boolean;personalDate?:boolean}={}):Array<{page:number;quote:string;corroboratingQuotes?:string[]}> {
  if(!page||page.processing?.ocrSimulated||options.independentText&&(page.status==='failed'||page.page?.document_version_id!==e.documentVersionId||page.page?.parse_revision!==e.parseRevision))return [];
  if(options.personalDate&&page.page?.document_version_id===e.documentVersionId&&page.page?.parse_revision===e.parseRevision)return personalDateRegions(page).filter(({region})=>anchor.block_ids?.includes(region.region_id)).map(({region})=>({page:anchor.page_number,quote:region.raw_text!}));
  const eligible=(r:any)=>r.processing_status==='ready'&&!r.coverage_gaps?.length&&
    !page.conflicts?.some((c:any)=>c.region_ids.includes(r.region_id))&&typeof r.raw_text==='string'&&
    r.raw_text_sha256===createHash('sha256').update(r.raw_text).digest('hex');
  const current=(r:any)=>r.document_version_id===e.documentVersionId&&r.parse_revision===e.parseRevision&&r.page_asset_id===page.page?.page_asset_id;
  const overlaps=(a:any,b:any)=>{
    const box=(r:any)=>{const p=(r.polygons??[]).flat();return [Math.min(...p.map((v:number[])=>v[0]!)),Math.max(...p.map((v:number[])=>v[0]!)),Math.min(...p.map((v:number[])=>v[1]!)),Math.max(...p.map((v:number[])=>v[1]!))];};
    const x=box(a),y=box(b);return Math.max(x[0]!,y[0]!)<Math.min(x[1]!,y[1]!)&&Math.max(x[2]!,y[2]!)<Math.min(x[3]!,y[3]!);
  };
  return (page.regions??[]).filter((r:any)=>anchor.block_ids?.includes(r.region_id)&&r.raw_text?.trim()&&eligible(r)&&(!options.independentText||current(r)&&r.source!=='image')).map((r:any)=>{
    if(!options.independentText||r.source==='native_pdf'&&page.nativeTrust==='validated_geometry_and_visibility')return {page:anchor.page_number,quote:r.raw_text};
    const corroboratingQuotes=['native_pdf','pp_ocr','vl_ocr'].filter(channel=>channel!==r.source&&(channel!=='native_pdf'||page.nativeTrust==='validated_geometry_and_visibility')).map(channel=>
      (page.regions??[]).filter((other:any)=>other.source===channel&&current(other)&&overlaps(r,other)).sort((a:any,b:any)=>a.reading_order-b.reading_order)
        // Valid whitespace is layout, while an invalid region is a barrier.
        .map((other:any)=>eligible(other)?other.raw_text:'\u0000').join('\n'));
    return {page:anchor.page_number,quote:r.raw_text,corroboratingQuotes};
  });
}

/** Layout whitespace between CJK characters is insignificant; English word boundaries are not. */
export const originalTextKey=(text:string)=>text.normalize('NFKC').trim().replace(/\s+/gu,' ').replace(/(?<=\p{Script=Han}) | (?=\p{Script=Han})/gu,'').replace(/ *([,.:;()\[\]，。；：、“”‘’]) */gu,'$1');
export function originalContains(quote:string,value:string):boolean {
  const text=originalTextKey(quote),needle=originalTextKey(value);
  if(!needle)return false;
  for(let at=text.indexOf(needle);at>=0;at=text.indexOf(needle,at+1)){
    const before=text[at-1]??'',after=text[at+needle.length]??'';
    if(/[A-Za-z0-9]/u.test(needle[0]!)&&/[A-Za-z0-9]/u.test(before))continue;
    if(/[A-Za-z0-9]/u.test(needle.at(-1)!)&&/[A-Za-z0-9]/u.test(after))continue;
    return true;
  }
  return false;
}
