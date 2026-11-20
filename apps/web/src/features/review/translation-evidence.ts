import type {ChecklistDocument} from '@hsbc/contracts/review-checklist';
import type {ReviewEvidence} from '@hsbc/contracts/review';
import type {DocumentTranslationTarget,DocumentTranslationTargets,DocumentTranslationView,DocumentTranslatedSegment} from '@hsbc/contracts/document-translation';

export interface TranslationDocument {document:ChecklistDocument;metadata:DocumentTranslationTargets;targets:DocumentTranslationTarget[];jobs:DocumentTranslationView[]}
export interface RoundTranslations {documents:TranslationDocument[];unparsed:ChecklistDocument[]}
export function segmentFor(document:TranslationDocument,target:DocumentTranslationTarget):DocumentTranslatedSegment|undefined {
  return document.jobs.filter(j=>j.sourceCurrent??j.validity==='current').flatMap(j=>j.items).find(i=>i.chunkId===target.chunkId&&i.sourceSha256===target.sourceSha256&&i.sourceText===target.sourceText);
}
export function matchingTranslationEvidence(data:RoundTranslations|undefined,evidence:ReviewEvidence[],fieldId?:string){
  return (data?.documents??[]).flatMap(d=>d.targets.filter(t=>(!fieldId||t.fieldIds.includes(fieldId))&&evidence.some(e=>e.documentVersionId===d.document.id&&e.parseRevision===d.document.parseRevision&&e.directoryRevision===d.document.directoryRevision&&(e.anchorId?t.source.anchorIds.includes(e.anchorId)||t.fieldEvidence?.some(f=>(!fieldId||f.fieldId===fieldId)&&f.anchorIds.includes(e.anchorId!)):t.source.sourceNodeIds.includes(e.sourceNodeId!)))).map(t=>({d,t,segment:segmentFor(d,t)})));
}
