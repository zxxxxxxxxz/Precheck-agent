import type {ReviewEvidence, ReviewFact, ReviewObject, ReviewMaterial, ReviewRun, ReviewState} from '@hsbc/contracts/review';
import {evidenceForResult, resultLabels} from './presentation.ts';
export type ReviewResult = ReviewRun['results'][number];
export interface RunSnapshot {/** Judgement rules in force when the run started. */guidance?:Array<import('@hsbc/contracts/review-guidance').GuidanceRef>;crossFileChecklist?:Array<Pick<import('@hsbc/contracts/review-checklist').ChecklistRow,'id'|'fieldId'|'crossChecks'>>;signatureInformation?:ReviewState['signatureInformation'];businessDate:string;configurationReleaseId:string;objects:ReviewObject[];facts:ReviewFact[];materials:ReviewMaterial[]}
export interface RunReplay {id:string;snapshotHash:string;snapshot:RunSnapshot;configuration?:ReviewState['configuration']}
export function resultCategory(result:Pick<ReviewResult,'outcome'|'reasonCode'>) {
  if (result.outcome === 'blocked' && ['manual_review_required','business_rule_confirmation_required','reference_list_required'].includes(result.reasonCode)) return result.reasonCode;
  return result.outcome;
}
export function resultLabel(result:Pick<ReviewResult,'outcome'|'reasonCode'>) {
  const category=resultCategory(result);
  return ({manual_review_required:'待人工核对',business_rule_confirmation_required:'待确认业务口径',reference_list_required:'待配置名单'} as Record<string,string>)[category] ?? resultLabels[category] ?? category;
}
export function objectLabel(id:string, objects:readonly Pick<ReviewObject,'objectId'|'label'>[]) {
  const object=objects.find(value=>value.objectId===id);
  if(object){const peers=objects.filter(other=>other.objectId!==id&&other.label===object.label);let length=8;while(length<id.length&&peers.some(other=>other.objectId.slice(0,length)===id.slice(0,length)))length++;return `${object.label}${peers.length?` · ${id.slice(0,length)}`:''}`;}
  return id==='case'?'案件级检查':id.startsWith('unconfirmed:')?'归属待确认':`历史对象 · ${id.slice(0,8)}`;
}
export const evidenceKey=(source:ReviewEvidence)=>`${source.documentVersionId}:${source.parseRevision}:${source.anchorId??source.sourceNodeId}`;
/** Direct support requires a pinned input field AND an explicit fact-version receipt.
 * An object-level anchor may coincide with a field; that alone is not proof of direct support. */
export function resultSources(result:ReviewResult,facts:readonly ReviewFact[],objects:readonly ReviewObject[],materials:readonly ReviewMaterial[],inputFieldIds:readonly string[]) {
  const directFacts=facts.filter(f=>inputFieldIds.includes(f.fieldId)&&result.evidenceIds.includes(`fact:${f.factId}:${f.version}`));
  const direct=evidenceForResult(directFacts,result.evidenceIds);
  const all=new Map<string,ReviewEvidence>();
  for(const source of evidenceForResult([...facts,...objects.map(o=>({factId:'object:'+o.objectId,version:o.version,evidence:o.evidence}))],result.evidenceIds))all.set(evidenceKey(source),source);
  for(const source of direct)all.set(evidenceKey(source),source);
  const directKeys=new Set(direct.map(evidenceKey));
  const related=[...all.values()].filter(s=>!directKeys.has(evidenceKey(s)));
  const documents=materials.filter(m=>result.evidenceIds.includes(`document:${m.documentVersionId}`));
  const documentIds=[...new Set([...all.values()].map(e=>e.documentVersionId).concat(documents.map(m=>m.documentVersionId),result.evidenceIds.filter(id=>id.startsWith('document:')).map(id=>id.slice(9))))];
  // Keep every unresolvable receipt visible in diagnostics, rather than dropping server evidence.
  const known=new Set([...all.keys(),...facts.filter(f=>result.evidenceIds.includes(`fact:${f.factId}:${f.version}`)).map(f=>`fact:${f.factId}:${f.version}`),...documents.map(m=>`document:${m.documentVersionId}`)]);
  return {direct,related,documents,documentIds,unlocated:result.evidenceIds.filter(id=>!known.has(id))};
}
export function factOrigin(fact:ReviewFact,records:ReviewState['factRecords']) {
  const record=records?.find(r=>r.factId===fact.factId&&r.version===fact.version);
  if(fact.automaticAdoption)return {label:'系统提取值',record:undefined,confirmation:fact.validity==='stale'?'依据已变化 · 待核对':'已校验并用于检查'};
  return {label:fact.candidateRef?'自动提取候选':record?.origin==='manual'?'人工录入':'来源无法追溯',record,
    confirmation:fact.validity==='stale'?'已失效 · 待重新确认':fact.state==='pending'?'待确认':fact.version>1?'已更正并确认':'已确认'};
}
export {compareResults,type ResultChange} from '@hsbc/contracts/review-comparison';
export function snapshotChanges(before:RunSnapshot,after:RunSnapshot,labels:{fields?:Record<string,string>;documents?:Record<string,string>}={}) {
  const changes:{key:string;label:string;kind:'material'|'object'|'fact'}[]=[];
  const compare=<T,>(a:T[],b:T[],key:(v:T)=>string,value:(v:T)=>string,label:(v:T)=>string,kind:'material'|'object'|'fact')=>{
    const old=new Map(a.map(v=>[key(v),v])),next=new Map(b.map(v=>[key(v),v]));
    for(const id of new Set([...old.keys(),...next.keys()])){const x=old.get(id),y=next.get(id);if(!x||!y||value(x)!==value(y))changes.push({key:kind+id,kind,label:`${label(y??x!)} · ${!x?'新增':!y?'本轮未包含':'版本或依据已更正'}`});}
  };
  compare(before.materials,after.materials,m=>JSON.stringify([m.documentVersionId,m.logicalDocumentId]),m=>JSON.stringify([m.operation,m.parseRevision,m.directoryRevision,m.projectionHash,m.relation]),m=>labels.documents?.[m.documentVersionId]??`材料 ${m.documentVersionId.slice(0,8)}`,'material');
  compare(before.objects,after.objects,o=>o.objectId,o=>JSON.stringify([o.version,o.validity]),o=>objectLabel(o.objectId,after.objects.length?after.objects:before.objects),'object');
  compare(before.facts,after.facts,f=>f.factId,f=>JSON.stringify([f.version,f.validity]),f=>`${objectLabel(f.objectId,after.objects)} · ${labels.fields?.[f.fieldId]??f.fieldId}`,'fact');
  return changes;
}
