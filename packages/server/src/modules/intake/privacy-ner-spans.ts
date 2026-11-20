import {createHash} from 'node:crypto';
import {z} from 'zod';
import type {NerClient} from '../../infrastructure/integrations/inference.js';
import {ModelExecutionError} from '../../model/gateway.js';

export const PrivacySourceRangeSchema=z.strictObject({
  sourceRef:z.string().min(1).max(200),sourceSha256:z.string().regex(/^[a-f0-9]{64}$/),
  start:z.number().int().nonnegative(),end:z.number().int().positive(),
}).refine(value=>value.end>value.start);
export type PrivacySourceRange=z.infer<typeof PrivacySourceRangeSchema>;
export interface LocatedNerEntity {text:string;kind:string;start:number;end:number}
const graphemes=new Intl.Segmenter('und',{granularity:'grapheme'});
const fail=():never=>{throw new ModelExecutionError('egress_denied',false,'privacy_source_entity');};
export const privacySourceHash=(text:string)=>createHash('sha256').update(text).digest('hex');
/** Insert only token boundaries around Han graphemes. Original characters and
 * Latin word boundaries remain intact; every returned span is mapped back. */
export function prepareNerSpanInput(text:string){
  let transformed='';const runs:Array<{start:number;end:number;originalStart:number;originalEnd:number}>=[];
  for(const part of graphemes.segment(text)){
    const han=/\p{Script=Han}/u.test(part.segment);
    if(han)transformed+=' ';
    const start=transformed.length;transformed+=part.segment;
    runs.push({start,end:transformed.length,originalStart:part.index,originalEnd:part.index+part.segment.length});
    if(han)transformed+=' ';
  }
  const codepointOffsets=[0];for(const point of transformed)codepointOffsets.push(codepointOffsets.at(-1)!+point.length);
  return {text:transformed,restore(raw:{text:string;start?:number;end?:number}){
    if(!Number.isSafeInteger(raw.start)||!Number.isSafeInteger(raw.end)||raw.start!<0||raw.end!<=raw.start!||raw.end!>=codepointOffsets.length)fail();
    const start=codepointOffsets[raw.start!]!,end=codepointOffsets[raw.end!]!;
    if(transformed.slice(start,end)!==raw.text)fail();
    const included=runs.filter(run=>run.start<end&&run.end>start),first=included[0]!,last=included.at(-1)!;
    if(!first||!last||first.start<start||last.end>end||
      transformed.slice(start,first.start).trim()||transformed.slice(last.end,end).trim())fail();
    // Both ends must be complete source graphemes, including surrogate pairs.
    const source=text.slice(first.originalStart,last.originalEnd);
    if(!source.trim()||source.length>2000)fail();
    return {text:source,start:first.originalStart,end:last.originalEnd};
  }};
}
export async function scanNerSourceSpans(ner:Pick<NerClient,'entities'>,text:string,labels:string[],kinds:Record<string,string>,signal?:AbortSignal):Promise<LocatedNerEntity[]>{
  const request=prepareNerSpanInput(text),response=await ner.entities(request.text||'empty',labels,{signal,wordSplitter:'whitespace',includeSpans:true});
  if(response.offset_unit!=='unicode_code_point')fail();
  return Object.entries(response.entities).flatMap(([label,values])=>values.map(value=>({...request.restore(value),kind:kinds[label]??'identity'})));
}
