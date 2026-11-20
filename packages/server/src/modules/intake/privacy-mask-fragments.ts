import {z} from 'zod';
import type {PrivacySourceRange} from './privacy-ner-spans.js';

const offset=z.number().int().nonnegative();
export const PrivacyMaskFragmentSchema=z.strictObject({
  text:z.string().min(1).max(2000),start:offset,end:offset,
  priorMask:z.strictObject({start:offset,end:offset,placeholder:z.string().regex(/^\[\[P_[A-Z]+_[a-f0-9]{20}\]\]$/)}),
});
export type PrivacyMaskFragment=z.infer<typeof PrivacyMaskFragmentSchema>;
type Replacement={placeholder:string;original:string;source?:PrivacySourceRange;fragmentOf?:PrivacyMaskFragment};
const words=new Intl.Segmenter('und',{granularity:'word'});
/** This is a source-boundary proof, not a guess about the identity or length of
 * an NER entity. An original standalone letter never qualifies. */
export function originalMaskedWord(text:string,start:number,end:number){
  for(const part of words.segment(text)){
    const stop=part.index+part.segment.length;
    if(part.index<=start&&stop>=end&&part.isWordLike&&
      (part.index<start||stop>end)&&part.segment.length<=2000)
      return {text:part.segment,start:part.index,end:stop};
  }
  return undefined;
}
/** Validate the persisted local proof without reconstructing missing original
 * context. The writer separately verifies full-source word boundaries/hash. */
export function validMaskFragment(value:Replacement,registry:readonly Replacement[]):boolean{
  const proof=value.fragmentOf,source=value.source;
  if(!proof)return true;
  if(!source||proof.end-proof.start!==proof.text.length||
    source.start<proof.start||source.end>proof.end||
    source.start===proof.start&&source.end===proof.end||
    proof.text.slice(source.start-proof.start,source.end-proof.start)!==value.original)return false;
  const segments=[...words.segment(proof.text)];
  if(segments.length!==1||!segments[0]!.isWordLike)return false;
  const mask=proof.priorMask,prior=registry.find(candidate=>candidate.placeholder===mask.placeholder);
  if(!prior||prior.fragmentOf||prior===value||mask.end<=mask.start||
    mask.end-mask.start!==prior.original.length||
    mask.start>=proof.end||mask.end<=proof.start||
    mask.start<source.end&&mask.end>source.start)return false;
  if(prior.source&&(prior.source.sourceRef!==source.sourceRef||
    prior.source.sourceSha256!==source.sourceSha256||
    prior.source.start!==mask.start||prior.source.end!==mask.end))return false;
  const overlapStart=Math.max(mask.start,proof.start),overlapEnd=Math.min(mask.end,proof.end);
  return proof.text.slice(overlapStart-proof.start,overlapEnd-proof.start)===
    prior.original.slice(overlapStart-mask.start,overlapEnd-mask.start);
}
