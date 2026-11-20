import {parentPort,workerData} from 'node:worker_threads';
import {parseNativePdf,renderPdfPage} from '../../../document/pdf.js';
import {parseDocx} from '../../../document/docx.js';
import {DocxError} from '../../../document/docx-zip.js';
import {DRAFT_ATTACHMENT_LIMITS} from '@hsbc/contracts/draft-attachment';

/** Only local parsing runs here. OCR authorization and network calls stay in the parent. */
async function run(){
  const bytes=new Uint8Array(workerData.bytes);
  if(workerData.kind==='docx'){
    const source=await parseDocx(bytes);let characters=0;
    const blocks=source.nodes.filter(node=>node.kind==='paragraph'&&!node.excludedFromVisibleFacts&&node.visibleText.trim()).map(node=>{
      characters+=node.visibleText.length;if(characters>DRAFT_ATTACHMENT_LIMITS.extractedCharacters)throw Error('attachment_text_budget');
      return {text:node.visibleText,nodeId:node.id};
    });
    return {blocks,coverageGaps:[...source.coverageGaps,...(source.nodes.some(node=>node.kind==='image')?['embedded_images_not_read']:[])]};
  }
  const page=(await parseNativePdf(bytes,{documentVersionId:workerData.attachmentId,parseRevision:'intake-v1',scale:1,pages:[workerData.pageNumber]}))[0]!;
  const text=page.regions.map(region=>region.raw_text??'').filter(Boolean).join('\n');
  if(text.length>100000||page.regions.length>5000)throw Error('attachment_page_content_budget');
  const needsOcr=!text.trim()||page.image_occurrences>0;
  // Intake blocks are user-reviewable source text, never formal evidence anchors.
  if(!needsOcr)return {blocks:[{text}],coverageGaps:[]};
  const scale=Math.min(1.25,Math.sqrt(10_000_000/(page.page.width*page.page.height)),16383/page.page.width,16383/page.page.height);
  if(scale<0.5)throw Error('attachment_page_pixel_budget');
  const png=await renderPdfPage(bytes,workerData.pageNumber,scale);
  if(png.length>10*1024*1024)throw Error('attachment_ocr_image_budget');
  return {blocks:[],png,coverageGaps:[]};
}
if(parentPort)void run().then(result=>parentPort!.postMessage({result})).catch(error=>{
  const allowed=new Set(['attachment_text_budget','attachment_page_content_budget','attachment_page_pixel_budget','attachment_ocr_image_budget']);
  parentPort!.postMessage({error:error instanceof DocxError?error.code:allowed.has(error?.message)?error.message:'attachment_parse_failed'});
});
