import {candidateAdoptionValue} from '@hsbc/contracts/documents';
import type {CrossFileValue} from '@hsbc/contracts/review-checklist';
import type {ChecklistInputDocument} from './checklist.js';

/** Retain each candidate's own source segments. Display punctuation is not an
 * original quotation, and segments from separate candidates must never mix. */
export function fieldSourceSegments(document:ChecklistInputDocument,fieldId:string,values:string[],evidence:CrossFileValue['evidence']):NonNullable<CrossFileValue['originalSegments']>{
 const result:NonNullable<CrossFileValue['originalSegments']>=[];
 for(const field of document.fields.filter(f=>f.fieldId===fieldId&&f.documentVersionId===document.id&&f.parseRevision===document.parseRevision))for(const candidate of field.candidates){
  const value=candidate.displayValue??candidateAdoptionValue(candidate),segments=candidate.evidenceSegments;
  if(!values.includes(value)||!segments?.length||segments.some(s=>!s.rawValue.trim()||!s.anchorIds.length))continue;
  const parts=segments.map(s=>s.rawValue);
  let faithful=[' ','\n',' / ','；',''].some(separator=>parts.join(separator)===value);
  // NAR1 dates are deliberately shown as ISO. Require the printed DD/MM/YYYY
  // legend and all three original components; do not infer a locale.
  if(!faithful&&fieldId==='cgt_field_48'&&/DD\s*[/\s]\s*MM\s*[/\s]\s*YYYY/iu.test(candidate.contextText??'')){
   const components=parts.join(' ').split(/[\s/.-]+/u);
   if(components.length===3&&/^\d{1,2}$/u.test(components[0]!)&&/^\d{1,2}$/u.test(components[1]!)&&/^\d{4}$/u.test(components[2]!)){
    const iso=`${components[2]}-${components[1]!.padStart(2,'0')}-${components[0]!.padStart(2,'0')}`;
    const date=new Date(iso+'T00:00:00Z');faithful=iso===value&&!Number.isNaN(date.valueOf())&&date.toISOString().slice(0,10)===iso;
   }
  }
  if(!faithful)continue;
  const located=segments.map(segment=>({value:segment.rawValue,evidence:evidence.filter(e=>segment.anchorIds.some(id=>e.anchorId===id||document.sourceNodes[id]===e.sourceNodeId&&!!e.sourceNodeId))}));
  if(located.some(part=>!part.evidence.length))continue;
  result.push({value,parts:located});
 }
 return result;
}
