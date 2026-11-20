import type {FieldSourceValue} from './field-comparison.ts';
import {evidenceIdentity} from './evidence-preview.ts';
import {groupEvidenceDocuments,type EvidenceParagraphReading} from './evidence-paragraph.ts';

const plain=(text:string)=>text.replace(/\s+/gu,' ').trim();
const words=(text:string)=>text.match(/[\p{L}\p{N}]+|[$€£¥%+−-]/gu)??[];

/** Reconstruct duplicated prose only from the candidate's own located source paragraphs.
 * Short extracted values and adopted facts must not be replaced by surrounding prose. */
export function fieldValueReading(value:FieldSourceValue,readings:EvidenceParagraphReading[]|undefined):string|null {
  const raw=value.value;
  if(!raw||!readings||!value.evidence.length||value.origin==='fact'||value.confirmed||value.stale)return raw;
  const ids=new Set(value.evidence.map(evidenceIdentity));
  const own=readings.flatMap(reading=>{
    const sources=reading.sources.filter(source=>ids.has(evidenceIdentity(source)));
    return sources.length?[{...reading,sources}]:[];
  });
  if(own.some(reading=>!reading.paragraph)||[...ids].some(id=>!own.some(reading=>reading.sources.some(source=>evidenceIdentity(source)===id))))return raw;
  const parts=groupEvidenceDocuments(own).flatMap(group=>group.parts.map(part=>part.paragraph!.text));
  const original=plain(raw);
  // Every displayed paragraph must already be present in the extracted value.
  if(!parts.length||parts.some(text=>!original.includes(plain(text))))return raw;
  const retainedWords=new Set(words(parts.join(' ')));
  // Additional extracted content cannot disappear just because it lacks a matched paragraph.
  if(words(raw).some(word=>!retainedWords.has(word)))return raw;
  return parts.join('\n\n');
}
