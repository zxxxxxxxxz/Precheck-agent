import {createHash} from 'node:crypto';
import type {AnalysisEvidence} from '@hsbc/contracts/review-delivery';
import type {DocumentBundle} from '@hsbc/contracts/documents';
import type {CrossFileCheck} from '@hsbc/contracts/review-checklist';
import {sha256} from '../../document/evidence.js';
import {evidenceFromBundle} from './semantic.js';

export const EXTRACTED_VALUE_EVIDENCE_VERSION='selected-values-and-distinct-alternatives-v2';

/** Honest extraction evidence: no synthetic original quotes or locator success. */
export function extractedValueEvidence(check:CrossFileCheck):AnalysisEvidence[]{
  return check.sources.flatMap(source=>{
    if(!source.documentId||!source.extractionVersion||source.state!=='available'||!source.values.length)return [];
    // Do not repeat a long clause in values, selection.originalValues and
    // every duplicate candidate. Preserve all distinct alternatives and scores.
    const alternatives=[...new Map((source.candidates??[]).filter(c=>!source.values.includes(c.value)).map(c=>[JSON.stringify([c.value,c.confidence]),{value:c.value,confidence:c.confidence}])).values()];
    const text=JSON.stringify({field:source.label,values:source.values,selection:source.displaySelection?{reason:source.displaySelection.reason}:null,alternatives});
    const sha256=createHash('sha256').update(text).digest('hex');
    return [{id:`extracted:${sha256.slice(0,40)}:${check.sources.indexOf(source)}`,documentId:source.documentId,filename:source.filename,...source.extractionVersion,
      text,sha256,locations:source.evidence,warnings:[],sourceNotes:['本依据为当前版本的提取值，不是已核验的原文。'],referenceTranslations:[]}];
  });
}

/** Whole source chunks plus reference closure; never a translated or keyword-trimmed quote. */
export function crossFileEvidence(bundle:DocumentBundle,filename:string,check:CrossFileCheck){
  const scoped=check.bankRule&&[6,26,32,40,43].includes(check.bankRule.row)?check.sources.filter(s=>s.documentId===bundle.scope.documentVersionId&&s.resolvedQuality&&s.personalWorkbookReading):[];
  if(scoped.length&&check.sources.filter(s=>s.documentId===bundle.scope.documentVersionId).every(s=>scoped.includes(s))){
    const passages=scoped.flatMap(s=>s.personalWorkbookReading!.passages);
    // These are whole, hash-checked source regions, not model-produced quotes.
    // Only current references already proved by the field reader may be used.
    if(passages.length&&passages.every(p=>p.evidence.parseRevision===bundle.scope.parseRevision&&p.evidence.directoryRevision===Number(bundle.directoryRevision)&&
      bundle.anchors.some(a=>a.anchor_id===p.evidence.anchorId&&a.document_version_id===bundle.scope.documentVersionId&&a.parse_revision===bundle.scope.parseRevision))){
      return [...new Map(passages.map(p=>[JSON.stringify(p),p])).values()].map(p=>({id:sha256(JSON.stringify([p.evidence,p.text])),documentId:bundle.scope.documentVersionId,filename,
        parseRevision:bundle.scope.parseRevision,directoryRevision:Number(bundle.directoryRevision),text:p.text,sha256:sha256(p.text),locations:[p.evidence],warnings:[],
        sourceNotes:['按银行本项要求读取完整相关段落；其他位置的图像、签署及提取提示不用于本项文字比较。'],referenceTranslations:[]}));
    }
  }
  const evidence=evidenceFromBundle(bundle,filename,true);
  const refs=check.sources.flatMap(s=>s.evidence).filter(e=>e.documentVersionId===bundle.scope.documentVersionId);
  const selected=new Set<string>();
  evidence.forEach((e,index)=>{if(e.locations.some(location=>refs.some(ref=>ref.parseRevision===location.parseRevision&&ref.directoryRevision===location.directoryRevision&&
    (ref.anchorId?ref.anchorId===location.anchorId:ref.sourceNodeId&&ref.sourceNodeId===location.sourceNodeId))))selected.add(bundle.chunks[index]!.id);});
  const queue=[...selected];
  while(queue.length){const id=queue.shift()!,chunk=bundle.chunks.find(c=>c.id===id);for(const dependency of chunk?.dependencyIds??[]){if(!selected.has(dependency)){selected.add(dependency);queue.push(dependency);}}}
  return evidence.filter((_,index)=>selected.has(bundle.chunks[index]!.id));
}
