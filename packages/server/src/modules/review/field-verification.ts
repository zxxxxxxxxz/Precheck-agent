import {fieldReviewOriginalReader,originalContains} from './field-review-original.js';
import {createHash} from 'node:crypto';
import type {DB} from '../../infrastructure/database/client.js';
import {AppError} from '../../shared/errors.js';
import {SaveFieldReviewSchema,fieldReviewStatus,isVerifiedSourceFact,type SaveFieldReview,type FieldReviewPin,type FieldCorrection,type FieldVerification} from '@hsbc/contracts/field-verification';
import type {ChecklistRow} from '@hsbc/contracts/review-checklist';
import type {DocumentFieldObservation} from '@hsbc/contracts/documents';
import type {ChecklistInputDocument} from './checklist.js';
import type {ReviewState} from '@hsbc/contracts/review';
import type {ReviewConfigManifest} from '@hsbc/contracts/review-config';
export function fieldReviewHash(value:unknown):string{
 const stable=(v:any):any=>Array.isArray(v)?v.map(stable):v&&typeof v==='object'?Object.fromEntries(Object.keys(v).sort().filter(k=>v[k]!==undefined).map(k=>[k,stable(v[k])])):v;
 return createHash('sha256').update(JSON.stringify(stable(value))).digest('hex');
}
export function reviewPins(docs:ChecklistInputDocument[]):FieldReviewPin[]{return docs.flatMap(d=>d.parseRevision&&d.directoryRevision?[{documentId:d.id,parseRevision:d.parseRevision,directoryRevision:d.directoryRevision,fieldsHash:fieldReviewHash(d.fields)}]:[]);}
export function pinsMatch(expected:FieldReviewPin[],actual:FieldReviewPin[]){return expected.length===actual.length&&expected.every(p=>actual.some(a=>fieldReviewHash(a)===fieldReviewHash(p)));}
export function pageTexts(page:any):string[]{return ['native_pdf','vl_ocr','pp_ocr'].map(source=>(page.regions??[]).filter((r:any)=>r.source===source&&typeof r.raw_text==='string'&&r.raw_text&&(!r.raw_text_sha256||createHash('sha256').update(r.raw_text).digest('hex')===r.raw_text_sha256)).sort((a:any,b:any)=>a.reading_order-b.reading_order).map((r:any)=>r.raw_text).join('\n')).filter(Boolean);}
export async function validateFieldReview(db:DB,input:SaveFieldReview,docs:ChecklistInputDocument[],rows:ChecklistRow[]){
 if(!pinsMatch(input.pins,reviewPins(docs))||new Set(input.pins.map(p=>p.documentId)).size!==input.pins.length)throw new AppError(409,'field_review_source_changed');
 if(new Set(input.items.map(i=>i.rowId)).size!==input.items.length)throw new AppError(422,'field_review_duplicate');
 const pages=new Map<string,any>(),anchors=new Map<string,any[]>(),original=fieldReviewOriginalReader(db);
 for(const source of [...input.items.flatMap(i=>i.sources),...input.corrections.map(c=>c.source)]){
  const e=source.evidence,pin=input.pins.find(p=>p.documentId===e.documentVersionId&&p.parseRevision===e.parseRevision&&p.directoryRevision===e.directoryRevision);
  if(!pin||(!e.anchorId&&!e.sourceNodeId)||source.filename!==docs.find(d=>d.id===e.documentVersionId)?.filename)throw new AppError(422,'field_review_evidence_invalid');
  if(e.sourceNodeId){
   if(!(await original(e)).some(q=>q.quote.includes(source.quote))||source.highlights.some(h=>!source.quote.includes(h)))throw new AppError(422,'field_review_quote_invalid');
   continue;
  }
  if(!anchors.has(e.parseRevision))anchors.set(e.parseRevision,(await db.query('SELECT body FROM business.document_artifacts WHERE job_id=$1 AND directory_revision=$2',[e.parseRevision,e.directoryRevision])).rows[0]?.body?.anchors??[]);
  const anchor=anchors.get(e.parseRevision)!.find(a=>a.anchor_id===e.anchorId&&a.document_version_id===e.documentVersionId&&a.parse_revision===e.parseRevision&&a.page_number===source.page);
  if(!anchor)throw new AppError(422,'field_review_evidence_invalid');
  const key=`${e.parseRevision}:${source.page}`;
  if(!pages.has(key))pages.set(key,(await db.query('SELECT body FROM business.document_pages WHERE job_id=$1 AND page_number=$2',[e.parseRevision,source.page])).rows[0]?.body);
  const page=pages.get(key);if(!page||!pageTexts(page).some(t=>t.includes(source.quote))||source.highlights.some(h=>!source.quote.includes(h)))throw new AppError(422,'field_review_quote_invalid');
 }
 for(const item of input.items){
  const row=rows.find(r=>r.id===item.rowId&&r.fieldId===item.fieldId&&r.objectId===item.objectId);
  if(!row)throw new AppError(409,'field_review_row_changed');
  if(['consistent','different'].includes(item.meaning)&&!item.sources.length)throw new AppError(422,'field_review_evidence_required');
  // Compared expressions must be present in original wording or in the current
  // extraction being checked. An arbitrary repeated string cannot yield confirmed.
  const extracted=[...row.candidates,...(row.unassignedCandidates??[])].flatMap(c=>c.value?[c.value,...input.corrections.filter(x=>x.documentId===c.documentId&&x.fieldId===row.fieldId).map(x=>c.value!.split(x.before).join(x.after))]:[]);
  for(const s of item.sources)if(s.value&&(s.kind==='extraction'?!extracted.includes(s.value):!(item.scope==='source_check'||item.scope==='bank_rule'?originalContains(s.quote,s.value):s.quote.includes(s.value))))throw new AppError(422,'field_review_value_invalid');
  if(item.scope==='source_check'&&item.meaning==='consistent'&&item.sources.length>=2&&!isVerifiedSourceFact(item)&&(!item.sources.some(s=>s.kind==='extraction')||!item.sources.some(s=>s.kind==='original')))throw new AppError(422,'field_review_extraction_pair_required');
  if(item.scope==='cross_file'&&item.meaning==='consistent'&&new Set(item.sources.map(s=>s.evidence.documentVersionId)).size<2)throw new AppError(422,'field_review_two_documents_required');
 }
 for(const correction of input.corrections){
  const field=docs.find(d=>d.id===correction.documentId)?.fields.find(f=>f.fieldId===correction.fieldId);
  if(correction.documentId!==correction.source.evidence.documentVersionId||!correction.source.quote.includes(correction.after)||correction.before===correction.after||!field?.candidates.some(c=>(c.displayValue??c.rawValue).includes(correction.before)))throw new AppError(422,'field_correction_invalid');
 }
}
export function correctedFieldDisplay<T extends DocumentFieldObservation>(fields:T[],corrections:FieldCorrection[]):T[]{return fields.map(field=>{
 const own=corrections.filter(c=>c.fieldId===field.fieldId);if(!own.length)return field;
 return {...field,candidates:field.candidates.map(candidate=>{let value=candidate.displayValue??candidate.rawValue;for(const c of own)value=value.split(c.before).join(c.after);return value===(candidate.displayValue??candidate.rawValue)?candidate:{...candidate,displayValue:value};})};
});}
/** An unrelated file change must not remove an intact source correction. */
export function pinnedFieldCorrections(input:SaveFieldReview,configurationReleaseId:string|null,doc:{id:string;parseRevision:string|null;directoryRevision:number|null;fields:DocumentFieldObservation[]}){
 const pin=input.pins.find(p=>p.documentId===doc.id);
 if(input.configurationReleaseId!==configurationReleaseId||!pin||pin.parseRevision!==doc.parseRevision||pin.directoryRevision!==doc.directoryRevision||pin.fieldsHash!==fieldReviewHash(doc.fields))return [];
 return input.corrections.filter(c=>c.documentId===doc.id);
}
export interface FieldReviewBasis {version:1;rows:Record<string,string>}

type BasisState=Pick<ReviewState,'objects'|'facts'>;
const ordered=(values:unknown[])=>values.map(value=>({value,hash:fieldReviewHash(value)})).sort((a,b)=>a.hash.localeCompare(b.hash)).map(({value})=>value);
/** Revision, author and workflow metadata are not comparison inputs. */
function content(value:Record<string,unknown>){
 const {version,caseRevision,confirmedBy,automaticAdoption,validity,...body}=value;
 return body;
}
function dependencies(row:ChecklistRow,manifest:ReviewConfigManifest){
 const rules=manifest.rules.filter(rule=>row.rules.some(r=>r.id===rule.id));
 const ids=new Set([row.fieldId,...rules.flatMap(r=>[...r.inputs,...(r.applicability?[r.applicability.fieldId]:[])]),...(row.crossChecks??[]).flatMap(c=>c.fieldIds)]);
 return {rules,fields:manifest.fields.filter(f=>ids.has(f.id)),ids};
}
function factInputs(row:ChecklistRow,state:BasisState,manifest:ReviewConfigManifest){
 const {fields,ids}=dependencies(row,manifest),objects=new Set<string>();
 for(const object of state.objects)if(object.objectId===row.objectId||fields.some(f=>f.objectKind===object.kind&&(!f.objectRole||f.objectRole===object.role)&&
   (f.id!==row.fieldId||!row.objectId)))objects.add(object.objectId);
 // Relation targets can supply facts used by a cross-object comparison.
 let size=-1;while(size!==objects.size){size=objects.size;for(const object of state.objects)if(objects.has(object.objectId))for(const relation of object.relations)objects.add(relation.targetObjectId);}
 return {objects:state.objects.filter(o=>objects.has(o.objectId)),facts:state.facts.filter(f=>!f.automaticAdoption&&f.confirmedBy!==null&&objects.has(f.objectId)&&ids.has(f.fieldId))};
}
/** Shared by new receipts and the read-only compatibility path for old receipts. */
export function fieldReviewFactBasis(row:ChecklistRow,state:BasisState,manifest:ReviewConfigManifest):string{
 const {objects,facts}=factInputs(row,state,manifest);
 return fieldReviewHash({objects:ordered(objects.map(o=>({...content({...o}),relations:ordered(o.relations.map(({targetVersion,...r})=>r)),evidence:ordered(o.evidence)}))),
   facts:ordered(facts.map(f=>({...content({...f}),evidence:ordered(f.evidence)})))});
}
/** Server-owned per-row dependency digest. Never accepts a client-supplied basis. */
export function fieldReviewBasis(rows:ChecklistRow[],docs:ChecklistInputDocument[],state:BasisState,manifest:ReviewConfigManifest,input:SaveFieldReview):FieldReviewBasis{
 const pins=reviewPins(docs);
 return {version:1,rows:Object.fromEntries(rows.filter(row=>input.items.some(i=>i.rowId===row.id)).map(row=>{
  const {rules,fields,ids}=dependencies(row,manifest),item=input.items.find(i=>i.rowId===row.id)!;
  const types=new Set([...row.materialTypes.map(t=>t.id),...fields.flatMap(f=>f.taxonomyIds??manifest.materials.filter(m=>!m.objectScope||m.objectScope.kind===f.objectKind&&(!f.objectRole||m.objectScope.role===f.objectRole)).map(m=>m.taxonomyId))]);
  const inputs=factInputs(row,state,manifest);
  const sourceIds=new Set([...item.sources.map(s=>s.evidence.documentVersionId),...[...inputs.objects,...inputs.facts].flatMap(v=>v.evidence.map(e=>e.documentVersionId)),
   ...(row.crossChecks??[]).flatMap(c=>c.sources.flatMap(s=>s.documentId?[s.documentId]:[]))]);
  const relevant=docs.filter(d=>sourceIds.has(d.id)||d.taxonomyIds.some(t=>types.has(t))||d.fields.some(f=>ids.has(f.fieldId)));
  const materials=manifest.materials.filter(m=>types.has(m.taxonomyId));
  const sources=new Set([...fields.flatMap(f=>f.sourceIds),...rules.flatMap(r=>r.sourceIds),...materials.flatMap(m=>m.sourceIds)]);
  return [row.id,fieldReviewHash({...(row.crossChecks?.some(c=>c.bankRule)?{bankRules:row.crossChecks.filter(c=>c.bankRule).map(c=>({bankRule:c.bankRule,fieldIds:c.fieldIds,method:c.method}))}:{}),facts:fieldReviewFactBasis(row,state,manifest),fields:ordered(fields),rules:ordered(rules.map(({tests,...rule})=>rule)),
   materialDefinitions:ordered(materials),parameters:Object.fromEntries(rules.flatMap(r=>(r.requiredParameters??[]).map(id=>[id,manifest.parameters[id]??null]))),
   sources:ordered(manifest.sources.filter(s=>sources.has(s.id))),
   materials:ordered(relevant.map(d=>({id:d.id,pin:pins.find(p=>p.documentId===d.id)??null,taxonomyIds:[...d.taxonomyIds].sort(),uploadedAt:d.uploadedAt,
    adopted:d.adopted,projectionCurrent:d.projectionCurrent,unclassified:d.unclassified}))),
   // Missing source documents must not disappear silently from the dependency set.
   sourceIds:[...sourceIds].sort()})];
 }))};
}
interface Saved {id:string;case_revision:number;created_at:Date;details:{input:SaveFieldReview;basis?:FieldReviewBasis};assignmentTransitions?:unknown[]}
/** Only explicit, contiguous assignment-only revisions can preserve a review.
 * Never infer this from event counts or timestamps: transaction start times can
 * precede the case lock, and legacy events do not prove a revision boundary. */
export function fieldReviewRevisionCurrent(savedRevision:number,revision:number,transitions:unknown[]=[]):boolean{
 if(savedRevision===revision)return true;
 if(!Number.isSafeInteger(savedRevision)||!Number.isSafeInteger(revision)||savedRevision>revision)return false;
 const steps=transitions.filter((v):v is {from:number;to:number}=>!!v&&typeof v==='object'
  &&Number.isSafeInteger((v as any).from)&&Number.isSafeInteger((v as any).to)
  &&(v as any).to===(v as any).from+1&&(v as any).from>=savedRevision&&(v as any).to<=revision)
  .sort((a,b)=>a.from-b.from);
 return steps.length===revision-savedRevision&&steps.every((v,i)=>v.from===savedRevision+i);
}
export async function savedFieldReview(db:DB,caseId:string,roundId:string|null,revision?:number):Promise<Saved|undefined>{
 const saved:Saved|undefined=(await db.query("SELECT id,case_revision,created_at,details FROM business.review_events WHERE case_id=$1 AND round_id IS NOT DISTINCT FROM $2::uuid AND kind='field_review_saved' ORDER BY created_at DESC,id DESC LIMIT 1",[caseId,roundId])).rows[0];
 if(saved&&revision!==undefined&&saved.case_revision<revision){
  saved.assignmentTransitions=(await db.query(`SELECT details->'fieldReviewTransition' AS transition FROM business.checker_events
   WHERE case_id=$1 AND kind='assigned' AND details->'fieldReviewTransition'->>'roundId' IS NOT DISTINCT FROM $2::text
   AND details->'fieldReviewTransition' IS NOT NULL`,[caseId,roundId])).rows.map(r=>r.transition);
 }
 return saved;
}
export function projectFieldReview(rows:ChecklistRow[],saved:Saved|undefined,docs:ChecklistInputDocument[],configurationReleaseId:string|null,revision:number,context?:{basis:FieldReviewBasis;legacyFacts?:Record<string,boolean>}):ChecklistRow[]{
 if(!saved)return rows;const parsed=SaveFieldReviewSchema.safeParse(saved.details.input);if(!parsed.success)throw new AppError(409,'field_review_record_invalid');const input=parsed.data;
 return rows.map(row=>{const item=input.items.find(i=>i.rowId===row.id&&i.fieldId===row.fieldId&&i.objectId===row.objectId);if(!item)return row;
 const current=saved.details.basis
  ?saved.details.basis.version===1&&!!saved.details.basis.rows[row.id]&&saved.details.basis.rows[row.id]===context?.basis.rows[row.id]
  :input.configurationReleaseId===configurationReleaseId&&pinsMatch(input.pins,reviewPins(docs))&&(context?.legacyFacts?.[row.id]??fieldReviewRevisionCurrent(saved.case_revision,revision,saved.assignmentTransitions));
 const verification:FieldVerification={...item,status:current?fieldReviewStatus(item):'pending',recordId:saved.id,recordedAt:saved.created_at.toISOString(),caseRevision:saved.case_revision,validity:current?'current':'stale',corrections:current?input.corrections.filter(c=>c.fieldId===row.fieldId):[]};
 return {...row,verification};});
}
export async function fieldDisplayCorrections(db:DB,caseId:string,roundId:string|null,configurationReleaseId:string|null,doc:{id:string;parseRevision:string;directoryRevision:number;fields:DocumentFieldObservation[]}){
 const saved=await savedFieldReview(db,caseId,roundId);if(!saved)return [];
 return pinnedFieldCorrections(SaveFieldReviewSchema.parse(saved.details.input),configurationReleaseId,doc);
}
