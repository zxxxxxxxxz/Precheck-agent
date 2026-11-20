import type {PoolClient} from 'pg';
import type {ReviewChecklist} from '@hsbc/contracts/review-checklist';
import type {ReviewState} from '@hsbc/contracts/review';
import type {AnalysisEvidence} from '@hsbc/contracts/review-delivery';
import type {DocumentBundle} from '@hsbc/contracts/documents';
import type {CaseAssistCard,CaseAssistModelOutput} from '@hsbc/contracts/case-assistant';
import type {ReviewEvidence} from '@hsbc/contracts/review';
import {AppError} from '../../shared/errors.js';
import type {Actor} from '../identity/types.js';
import type {DocumentService} from '../documents/service.js';
import type {CaseAssistDocument} from './context.js';

const MAX_CHUNKS=24,MAX_BYTES=24_000;
export type CaseAssistDocumentReader=Pick<DocumentService,'reviewBundle'|'readerBundle'>;

/** Reads the file open in the reader with the sender's own document access.
 * Only a file of the viewed round is accepted; a submitted round reads its pinned evidence, never a newer parse. */
export async function openDocument(db:PoolClient,actor:Actor,caseId:string,documentId:string,state:ReviewState,checklist:ReviewChecklist,documents:CaseAssistDocumentReader,
  evidenceFromBundle:(bundle:DocumentBundle,filename:string,confirmed?:boolean)=>AnalysisEvidence[]):Promise<Omit<CaseAssistDocument,'fields'>|undefined> {
  const listed=checklist.documents.find(document=>document.id===documentId);
  if(!listed)return undefined;
  const pin=state.materials.find(material=>material.documentVersionId===documentId&&material.operation==='adopt');
  const typeLabel=pin?state.configuration?.taxonomy.find(type=>type.id===pin.documentTypeId)?.label??null:null;
  const document:Omit<CaseAssistDocument,'fields'>={documentId,filename:listed.filename,typeLabel,chunks:[],limitations:[]};
  let evidence:AnalysisEvidence[],bundle:DocumentBundle|undefined;
  try{
    if(checklist.readOnly){
      if(!pin){document.limitations.push('这份文件未在已提交的轮次中采用，未读取原文。');return document;}
      bundle=await documents.reviewBundle(db,actor,caseId,pin) as DocumentBundle;evidence=evidenceFromBundle(bundle,listed.filename,true);
    }else{bundle=(await documents.readerBundle(db,actor,caseId,documentId)).bundle;evidence=evidenceFromBundle(bundle,listed.filename,!!pin);}
  }catch(error){
    if(!(error instanceof AppError)||error.status===403)throw error;
    document.limitations.push('当前文件的原文暂时读取不到，本次只依据已提取的字段回答。');return document;
  }
  let bytes=0,skipped=0;
  for(const [index,item] of evidence.entries()){
    const text=item.text.trim(),size=Buffer.byteLength(text);
    if(!text)continue;
    if(document.chunks.length>=MAX_CHUNKS||bytes+size>MAX_BYTES){skipped++;continue;}
    const spans=bundle?blockSpans(bundle,index,item):undefined;
    bytes+=size;document.chunks.push({blockId:`doc:${document.chunks.length+1}`,text,evidence:item.locations[0]??null,...(spans?{spans}:{})});
  }
  if(!document.chunks.length)document.limitations.push('当前文件还没有可读取的原文，本次只依据已提取的字段回答。');
  if(skipped)document.limitations.push(`当前文件较长，本次只读取了前 ${document.chunks.length} 段，其余 ${skipped} 段未读取。`);
  return document;
}

/** A passage's text is its anchored blocks joined by one character. Returns where each block sits in the trimmed text,
 * or nothing when the passage does not follow that layout (the first location is then used as before). */
function blockSpans(bundle:DocumentBundle,index:number,item:AnalysisEvidence){
  const chunk=bundle.chunks?.[index];
  if(!chunk||chunk.text!==item.text||chunk.anchorIds.length<2||item.locations.length!==chunk.anchorIds.length)return undefined;
  const lengths=chunk.anchorIds.map(id=>{const anchor=bundle.anchors.find(a=>a.anchor_id===id);return anchor?.text_span_refs.length===1?anchor.text_span_refs[0]!.length:-1;});
  const total=[...chunk.text].length;
  if(lengths.some(length=>length<0)||lengths.reduce((sum,length)=>sum+length,0)+lengths.length-1!==total)return undefined;
  const lead=[...chunk.text].length-[...chunk.text.trimStart()].length;let cursor=-lead;
  return lengths.map((length,i)=>{const span={start:cursor,end:cursor+length,evidence:item.locations[i]!};cursor+=length+1;return span;});
}
/** The location of the block that holds the quote; the passage's first location when blocks are unknown. */
export function locateQuote(chunk:CaseAssistDocument['chunks'][number],quote:string):ReviewEvidence|null {
  const at=chunk.text.indexOf(quote);
  if(at<0||!chunk.spans?.length)return chunk.evidence;
  const start=[...chunk.text.slice(0,at)].length,end=start+[...quote].length;
  const overlap=(span:{start:number;end:number})=>Math.min(end,span.end)-Math.max(start,span.start);
  const best=chunk.spans.reduce((a,b)=>overlap(b)>overlap(a)?b:a);
  return overlap(best)>0?best.evidence:chunk.evidence;
}
const escaped=(text:string)=>text.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
/** The passage of `source` that a model quote stands for. Models often turn a line break into a space or drop one, and a
 * masked name is restored in the casing of its first occurrence, which need not be this one. Only spacing and letter case
 * are tolerated; the returned text is always cut from the source itself, so what is shown and stored stays verbatim. */
export function sourceQuote(source:string,quote:string):string|null {
  const wanted=quote.trim();
  if(!wanted)return null;
  if(source.includes(wanted))return wanted;
  const words=wanted.split(/\s+/u).filter(Boolean);
  const patterns=[words.map(escaped).join('\\s+'),[...wanted.replace(/\s+/gu,'')].map(escaped).join('\\s*')].filter(pattern=>pattern.length<=6000);
  for(const flags of ['u','iu'])for(const pattern of patterns){
    const match=new RegExp(pattern,flags).exec(source);
    if(match?.[0].trim())return match[0];
  }
  return null;
}
/** A quote is shown only when it is a verbatim passage of the block the model cited. */
export function documentQuotes(document:CaseAssistDocument|undefined,quotes:CaseAssistModelOutput['quotes'],sourceRef:(wire:string)=>string,notes:string[]):CaseAssistCard|null {
  if(!quotes.length)return null;
  const items:Array<{quote:string;evidence:CaseAssistDocument['chunks'][number]['evidence']}>=[];let rejected=false;
  for(const item of quotes){
    let local:string;try{local=sourceRef(item.sourceRef);}catch{rejected=true;continue;}
    const chunk=document?.chunks.find(candidate=>candidate.blockId===local);
    const quote=chunk?sourceQuote(chunk.text,item.quote):null;
    if(!chunk||!quote){rejected=true;continue;}
    if(!items.some(existing=>existing.quote===quote))items.push({quote,evidence:locateQuote(chunk,quote)});
  }
  if(rejected)notes.push('部分引文与当前文件的原文不一致，已忽略。');
  return items.length&&document?{kind:'quotes',filename:document.filename,items}:null;
}
