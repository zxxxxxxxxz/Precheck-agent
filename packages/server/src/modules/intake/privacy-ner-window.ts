import {ModelExecutionError} from '../../model/gateway.js';

export interface PrivacyNerWindow {text:string;start:number;end:number}
interface Range {start:number;end:number}
export const PRIVACY_NER_WINDOW_MAX_BYTES=2200;
export const PRIVACY_NER_WINDOW_MAX_UTF16=2200;
export const PRIVACY_NER_WINDOW_MAX_EDGE_EXTENSION=256;
const graphemes=new Intl.Segmenter('und',{granularity:'grapheme'});
const words=new Intl.Segmenter('und',{granularity:'word'});
const opaque=/\[\[P_[A-Z]+_[a-f0-9]{20}\]\]/gu;
const invalid=():never=>{throw new ModelExecutionError('egress_denied',false,'privacy_canonical_mismatch');};
const exhausted=():never=>{throw new ModelExecutionError('input_budget_exhausted');};

/** This index belongs to one immutable original or fully rendered source block.
 * Only the NER window changes; paid-model transport chunks remain independent. */
export function createPrivacyNerWindowSource(text:string) {
  if(typeof text!=='string')invalid();
  const characterRanges:Range[]=[...graphemes.segment(text)]
    .map(part=>({start:part.index,end:part.index+part.segment.length}));
  const wordRanges:Range[]=[...words.segment(text)].filter(part=>part.isWordLike)
    .map(part=>({start:part.index,end:part.index+part.segment.length}));
  const opaqueRanges:Range[]=[...text.matchAll(opaque)]
    .map(part=>({start:part.index,end:part.index+part[0].length}));
  return {window(range:Range):PrivacyNerWindow {
    if(!range||!Number.isSafeInteger(range.start)||!Number.isSafeInteger(range.end)||
      range.start<0||range.end<=range.start||range.end>text.length)invalid();
    let start=range.start,end=range.end;
    const expand=(ranges:Range[])=>{
      for(const part of ranges){
        if(part.start<start&&start<part.end)start=part.start;
        if(part.start<end&&end<part.end)end=part.end;
      }
    };
    // The ordering also handles a caller's boundary inside a surrogate pair,
    // combining sequence or generated alias. Every step only adds source bytes.
    expand(characterRanges);expand(opaqueRanges);expand(wordRanges);
    expand(opaqueRanges);expand(characterRanges);
    if(characterRanges.some(part=>part.start<start&&start<part.end||part.start<end&&end<part.end)||
      wordRanges.some(part=>part.start<start&&start<part.end||part.start<end&&end<part.end)||
      opaqueRanges.some(part=>part.start<start&&start<part.end||part.start<end&&end<part.end))invalid();
    const value=text.slice(start,end);
    if(range.start-start>PRIVACY_NER_WINDOW_MAX_EDGE_EXTENSION||
      end-range.end>PRIVACY_NER_WINDOW_MAX_EDGE_EXTENSION||
      value.length>PRIVACY_NER_WINDOW_MAX_UTF16||
      Buffer.byteLength(JSON.stringify(value),'utf8')-2>PRIVACY_NER_WINDOW_MAX_BYTES)exhausted();
    return {text:value,start,end};
  }};
}

export function privacyNerWindow(text:string,range:Range):PrivacyNerWindow {
  return createPrivacyNerWindowSource(text).window(range);
}
