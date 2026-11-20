import type {ReviewEvidence} from '@hsbc/contracts/review';
import {evidenceIdentity} from './evidence-preview.ts';
import {evidenceContent,evidencePlainText} from './evidence-content.tsx';
import {matchingTranslationEvidence,type RoundTranslations} from './translation-evidence.ts';

export interface EvidenceReading {sources:ReviewEvidence[];text:string;pageNumber?:number;highlights?:string[]}
export const evidenceDocumentKey=(source:ReviewEvidence)=>JSON.stringify([source.documentVersionId,source.parseRevision,source.directoryRevision]);
/** Identical wording elsewhere is still separate evidence. Only shared anchors
 * or the same translation chunk coalesce readings. */
function deduplicateReadings(readings:EvidenceReading[]) {
  const compact=(text:string)=>evidencePlainText(text).replace(/\s/gu,'');
  const kept:EvidenceReading[]=[];
  for(const reading of [...readings].filter(r=>r.sources.length).sort((a,b)=>Number(/<table\b/iu.test(b.text))-Number(/<table\b/iu.test(a.text)))){
    const sameLocation=(other:EvidenceReading)=>evidenceDocumentKey(other.sources[0]!)===evidenceDocumentKey(reading.sources[0]!)&&other.pageNumber===reading.pageNumber;
    const match=kept.find(other=>sameLocation(other)&&other.sources.some(a=>reading.sources.some(b=>evidenceIdentity(a)===evidenceIdentity(b)))&&compact(other.text)===compact(reading.text));
    // Collapse the plain OCR duplicate only when it is the complete body of a
    // unique table on this page, never a substring or a repeated clause.
    const tables=reading.pageNumber!==undefined&&!/<table\b/iu.test(reading.text)?readings.filter(other=>sameLocation(other)&&evidenceContent(other.text).some(block=>block.kind==='table'&&block.rows.length>1&&compact(block.rows.slice(1).flat().map(cell=>cell.text).join(' '))===compact(reading.text))):[];
    const parent=match??(tables.length===1?kept.find(other=>other.text===tables[0]!.text&&sameLocation(other)):undefined);
    if(parent){parent.sources=[...new Map([...parent.sources,...reading.sources].map(s=>[evidenceIdentity(s),s])).values()];parent.highlights=[...new Set([...(parent.highlights??[]),...(reading.highlights??[])])];}
    else kept.push({...reading,sources:[...reading.sources],highlights:[...(reading.highlights??[])]});
  }
  return kept.sort((a,b)=>(a.pageNumber??0)-(b.pageNumber??0));
}
export function bilingualEvidence(readings:EvidenceReading[],data?:RoundTranslations){
  type Match=ReturnType<typeof matchingTranslationEvidence>[number];
  const pairs=new Map<string,{key:string;reading:EvidenceReading;match?:Match}>();
  const comparable=(text:string)=>evidencePlainText(text).replace(/\s/gu,'');
  for(const reading of deduplicateReadings(readings)){
    // A paragraph translation is not a translation of a highlighted value.
    // Reuse only the exact cited text; never enlarge the field's original.
    const matches=matchingTranslationEvidence(data,reading.sources).filter(match=>!!match.t.sourceText&&comparable(match.t.sourceText)===comparable(reading.text));
    const candidates=matches.length?matches.map(match=>({match,text:reading.text,key:`${evidenceDocumentKey(reading.sources[0]!)}:${match.t.chunkId}`})):
      [{match:undefined,text:reading.text,key:JSON.stringify([reading.sources.map(evidenceIdentity).sort(),reading.pageNumber,evidencePlainText(reading.text)])}];
    for(const candidate of candidates){
      const previous=pairs.get(candidate.key);
      if(previous){previous.reading.sources=[...new Map([...previous.reading.sources,...reading.sources].map(s=>[evidenceIdentity(s),s])).values()];previous.reading.highlights=[...new Set([...(previous.reading.highlights??[]),...(reading.highlights??[])])];}
      else pairs.set(candidate.key,{key:candidate.key,match:candidate.match,reading:{...reading,text:candidate.text,highlights:[...(reading.highlights??[])],sources:[...reading.sources]}});
    }

  }
  const result=[...pairs.values()];
  return result.filter(pair=>!result.some(other=>other!==pair&&!pair.match?.segment?.translatedText&&
    evidenceDocumentKey(other.reading.sources[0]!)===evidenceDocumentKey(pair.reading.sources[0]!)&&
    JSON.stringify(other.match?.t.source.pageNumbers??[other.reading.pageNumber])===JSON.stringify(pair.match?.t.source.pageNumbers??[pair.reading.pageNumber])&&
    other.reading.sources.some(a=>pair.reading.sources.some(b=>evidenceIdentity(a)===evidenceIdentity(b)))&&
    comparable(other.reading.text).length>comparable(pair.reading.text).length&&comparable(other.reading.text).includes(comparable(pair.reading.text))));
}

/** Keep paragraph/translation boundaries internally, but read one fixed file as one document. */
export function bilingualEvidenceDocuments(readings:EvidenceReading[],data?:RoundTranslations){
  type Pair=ReturnType<typeof bilingualEvidence>[number];
  const documents=new Map<string,{key:string;parts:Pair[]}>();
  for(const pair of bilingualEvidence(readings,data)){
    const key=evidenceDocumentKey(pair.reading.sources[0]!);
    const document=documents.get(key)??{key,parts:[]};
    document.parts.push(pair);documents.set(key,document);
  }
  return [...documents.values()].map(document=>({...document,parts:document.parts.sort((a,b)=>
    (a.match?.t.source.pageNumbers[0]??a.reading.pageNumber??0)-(b.match?.t.source.pageNumbers[0]??b.reading.pageNumber??0))}));
}
