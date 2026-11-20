import React from 'react';
import type {ReviewEvidence} from '@hsbc/contracts/review';
import {evidenceIdentity} from './evidence-preview.ts';
import {groupEvidenceDocuments} from './evidence-paragraph.ts';
import {useEvidenceParagraphs} from './use-evidence-paragraphs.ts';
import type {FieldFocus} from './field-focused-reading.ts';
import {BilingualEvidenceRail,type EvidenceTranslationProps} from './bilingual-evidence-rail.tsx';

export function FieldEvidence(props:{caseId:string;roundId?:string|null;names:Record<string,string>;evidence:ReviewEvidence[];focus?:FieldFocus;focusValues?:Array<{evidence:ReviewEvidence[];values:string[]}>}&EvidenceTranslationProps) {
  const reading=useEvidenceParagraphs(props.caseId,props.evidence);
  const parts=groupEvidenceDocuments(reading.error?[]:reading.data??[]).flatMap(group=>group.parts);
  const readings=parts.map(part=>({sources:part.sources,text:part.paragraph?.displayText??part.paragraph?.text??'',pageNumber:part.paragraph?.pageNumber??part.pageNumber,
    highlights:props.focusValues?.filter(value=>value.evidence.some(ref=>part.sources.some(source=>evidenceIdentity(source)===evidenceIdentity(ref)))).flatMap(value=>value.values)??[]}));
  return <BilingualEvidenceRail {...props} readings={reading.error?props.evidence.map(source=>({sources:[source],text:''})):readings} pending={reading.isPending} error={reading.error}/>;
}
