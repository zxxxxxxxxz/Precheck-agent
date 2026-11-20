import type {ReviewedRuleInputs,FieldReviewSourceSchema} from '@hsbc/contracts/field-verification';
import type {ChecklistRow} from '@hsbc/contracts/review-checklist';
import type {ReviewConfigManifest,ReviewFieldDefinition} from '@hsbc/contracts/review-config';
import type {ReviewEvidence,ReviewState} from '@hsbc/contracts/review';
import {CORPORATE_WORKBOOK_SHA256} from '@hsbc/contracts/corporate-requirements';
import type {z} from 'zod';
import type {DB} from '../../infrastructure/database/client.js';
import type {ChecklistInputDocument} from './checklist.js';
import {fieldReviewOriginalReader,originalContains,originalTextKey} from './field-review-original.js';
import {normalizeReviewValue} from './normalization.js';
import {reviewedFormDate} from './reviewed-form-date.js';

type Source=z.infer<typeof FieldReviewSourceSchema>;
type Selection={row:ChecklistRow;definition:ReviewFieldDefinition;sources:Source[]};
const unique=<T>(values:T[])=>[...new Set(values)];
const key=(value:string)=>originalTextKey(value).toUpperCase();
const evidence=(sources:Source[])=>[...new Map(sources.map(s=>[JSON.stringify(s.evidence),s.evidence])).values()];
const sourceIds=(refs:ReviewEvidence[])=>refs.map(e=>`${e.documentVersionId}:${e.parseRevision}:${e.anchorId??e.sourceNodeId}`);
const requiredAmount=new Set(['cgt_required_amount','cgt_required_currency','cgt_user_required_amount','cgt_user_required_currency']);
const names=new Set(['cgt_field_9','cgt_field_14','cgt_field_24','cgt_field_32','cgt_field_42','cgt_field_50','cgt_field_61','cgt_field_63']);

/** An explicit reviewed value is read from its selected sources only. Context
 * quotations (comparisonKey=null), explanations and highlights are never values. */
export async function reviewedCorporateRuleInputs(db:DB,rows:ChecklistRow[],manifest:ReviewConfigManifest,state:Pick<ReviewState,'objects'|'materials'|'materialScope'>,documents:ChecklistInputDocument[]):Promise<ReviewedRuleInputs[]>{
 if(!manifest.guaranteeTypes.includes('corporate_guarantee'))return [];
 const original=fieldReviewOriginalReader(db,{humanReviewed:true}),selections=new Map<string,Selection>();
 const current=(source:Source,fieldId:string)=>{
  const e=source.evidence,d=documents.find(d=>d.id===e.documentVersionId);
  return !!d&&d.adopted&&d.projectionCurrent&&['ready','partial'].includes(d.state)&&d.parseRevision===e.parseRevision&&d.directoryRevision===e.directoryRevision&&
   !d.invalidFieldIds?.some(id=>id==='*'||id===fieldId)&&state.materials.some(m=>m.operation==='adopt'&&m.documentVersionId===d.id&&m.parseRevision===d.parseRevision&&m.directoryRevision===d.directoryRevision);
 };
 for(const row of rows.filter(r=>r.objectRole==='corporate_guarantee')){
  const v=row.verification,definition=manifest.fields.find(f=>f.id===row.fieldId);
  if(!definition||!v||v.origin||v.validity!=='current'||v.meaning!=='consistent')continue;
  const selected=v.sources.filter(s=>s.kind==='original'&&s.comparisonKey!==null&&s.value.trim());
  if(!selected.length||selected.some(s=>!current(s,row.fieldId)))continue;
  const sources:Source[]=[];
  for(const source of selected){
   const quotes=await original(source.evidence,source.quote);
   if(quotes.some(q=>q.page===source.page&&originalContains(q.quote,source.value)))sources.push(source);
  }
  // Do not turn one successful side into an accepted comparison if another side
  // of the saved selection has lost its original evidence.
  if(sources.length!==selected.length)continue;
  selections.set(row.id,{row,definition,sources});
 }
 const result:ReviewedRuleInputs[]=[];
 const owners=state.objects.filter(o=>o.role==='corporate_guarantee');
 const scopes=owners.length?owners.filter(o=>o.validity==='current').map(o=>o.objectId):[null];
 for(const objectId of scopes){
  const own=[...selections.values()].filter(s=>s.row.objectId===objectId);
  const find=(id:string)=>own.find(s=>s.row.fieldId===id);
  const typed=(selection:Selection|undefined,type:string)=>selection?.sources.filter(s=>documents.find(d=>d.id===s.evidence.documentVersionId)?.taxonomyIds.includes(type))??[];
  let bound:Source[]=[],documentIds:string[]=[];
  if(objectId){
   const owner=owners.find(o=>o.objectId===objectId)!;
   documentIds=unique(owner.evidence.filter(e=>documents.some(d=>d.id===e.documentVersionId&&d.parseRevision===e.parseRevision&&d.directoryRevision===e.directoryRevision)).map(e=>e.documentVersionId));
   bound=own.flatMap(s=>s.sources).filter(s=>documentIds.includes(s.evidence.documentVersionId));
  }else{
   // A single company pack needs BOTH its reviewed name and registration number
   // matched to an official registration document. A repeated name alone is not
   // ownership. Multiple guarantee files or conflicting identities stay scoped out.
   if(documents.filter(d=>d.taxonomyIds.includes('cgt_guarantee')).length!==1)continue;
   const guaranteeNames=typed(find('cgt_field_9'),'cgt_guarantee'),registeredNames=typed(find('cgt_field_61'),'cgt_incorporation');
   const guaranteeIds=typed(find('cgt_field_11'),'cgt_guarantee'),registeredIds=typed(find('cgt_field_60'),'cgt_incorporation');
   if([guaranteeNames,registeredNames,guaranteeIds,registeredIds].some(s=>unique(s.map(v=>key(v.value))).length!==1))continue;
   if(key(guaranteeNames[0]!.value)!==key(registeredNames[0]!.value)||key(guaranteeIds[0]!.value)!==key(registeredIds[0]!.value))continue;
   if(registeredNames[0]!.evidence.documentVersionId!==registeredIds[0]!.evidence.documentVersionId||guaranteeNames[0]!.evidence.documentVersionId!==guaranteeIds[0]!.evidence.documentVersionId)continue;
   const company=key(guaranteeNames[0]!.value);
   const named=own.filter(s=>names.has(s.row.fieldId)&&s.row.verification?.scope==='cross_file');
   if(named.some(s=>s.sources.some(v=>key(v.value)!==company)))continue;
   bound=[...guaranteeNames,...registeredNames,...guaranteeIds,...registeredIds,...named.flatMap(s=>s.sources)];
   // A reviewed facility requirement can join only through an affirmative
   // corporate-guarantee obligation naming this already matched company.
   for(const source of find('cgt_required')?.sources??[]){
    if(originalContains(source.value,guaranteeNames[0]!.value)&&corporateRequirement(source.value))bound.push(source);
   }
   documentIds=unique(bound.map(s=>s.evidence.documentVersionId));
  }
  if(!bound.length)continue;
  const scope:ReviewedRuleInputs={policyVersion:'reviewed-rule-inputs-v1',scopeId:objectId??'unconfirmed:corporate_guarantee',role:'corporate_guarantee',configurationReleaseId:manifest.releaseId,documentIds,bindingEvidence:evidence(bound),inputs:{},gaps:[]};
  const put=(id:string,value:string|boolean,sources:Source[],fieldIds:string[])=>{
   const refs=evidence(sources),recordIds=unique(own.filter(s=>fieldIds.includes(s.row.fieldId)).map(s=>s.row.verification!.recordId));
   scope.inputs[id]={fact:{value,state:'present',evidenceIds:[...recordIds.map(r=>`field-review:${r}`),...sourceIds(refs)]},fieldIds,recordIds,evidence:refs};
  };
  for(const selection of own){
   const {row,definition}=selection;
   if(requiredAmount.has(row.fieldId)){scope.gaps.push({fieldId:row.fieldId,reason:'要求金额及币种必须来自明确的业务确认，原文核对不能替代该决定。'});continue;}
   const types=row.fieldId==='cgt_required'?['cgt_facility']:definition.taxonomyIds;
   const sources=selection.sources.filter(s=>documentIds.includes(s.evidence.documentVersionId)&&documents.find(d=>d.id===s.evidence.documentVersionId)?.taxonomyIds.some(t=>types?.includes(t)));
   if(!sources.length)continue;
   const converted=await Promise.all(sources.map(async s=>reviewedValue(definition,s.value)??await reviewedFormDate(db,row.fieldId,s)));
   if(converted.some(v=>v===null)){
    scope.gaps.push({fieldId:row.fieldId,reason:'已核对原文，但取值尚不能无歧义地转换为本条规则所需格式。'});continue;
   }
   const values=unique(converted as string[]);
   if(values.length!==1&&definition.valueMultiplicity!=='clauses'&&definition.valueMultiplicity!=='entities'){
    scope.gaps.push({fieldId:row.fieldId,reason:'当前有效核对中存在多个不同取值，未自动选择其中一个。'});continue;
   }
   put(row.fieldId,values.join('\n\n'),sources,[row.fieldId]);
  }
  // ND2A section fields are composed from their reviewed role/name/date cells,
  // not from the printed section heading. All cells must belong to one page.
  for(const [id,parts] of [['cgt_field_51',['cgt_field_52','cgt_field_54','cgt_field_55']],['cgt_field_56',['cgt_field_57','cgt_field_58','cgt_field_59']]] as const){
   if(scope.inputs[id]||parts.some(part=>!scope.inputs[part]))continue;
   const located=parts.map(part=>find(part)?.sources.filter(s=>scope.inputs[part]!.evidence.some(e=>JSON.stringify(e)===JSON.stringify(s.evidence)))??[]);
   if(located.some(s=>!s.length)||new Set(located.flat().map(s=>`${s.evidence.documentVersionId}:${s.page}`)).size!==1)continue;
   put(id,JSON.stringify(Object.fromEntries(parts.map(part=>[part,scope.inputs[part]!.fact.value]))),located.flat(),[...parts]);
  }
  const unresolved=documents.some(d=>d.unclassified||!d.projectionCurrent||!['ready','partial'].includes(d.state));
  for(const material of manifest.materials.filter(m=>m.objectScope?.role==='corporate_guarantee')){
   // Workbook row 46 explicitly accepts an opinion OR a confirmation email.
   // A scoped, supplied opinion satisfies only this document-presence requirement;
   // its legal sufficiency and the bank's approval remain separate checks.
   const opinionAlternative=material.id==='cgt_lawyer_confirmation'&&material.sourceIds.length===1&&material.sourceIds[0]==='cgt_rule_source_46'&&
    manifest.sources.some(s=>s.id==='cgt_rule_source_46'&&s.sha256===CORPORATE_WORKBOOK_SHA256&&s.guaranteeType==='corporate_guarantee'&&['candidate','confirmed'].includes(s.disposition));
   const supplied=state.materials.filter(m=>m.operation==='adopt'&&(m.documentTypeId===material.taxonomyId||opinionAlternative&&m.documentTypeId==='cgt_legal'));
   const matched=supplied.filter(m=>documentIds.includes(m.documentVersionId));
   if(supplied.some(m=>!documentIds.includes(m.documentVersionId))||(!matched.length&&(unresolved||state.materialScope!=='file-list')))continue;
   const id=`material:${material.id}`,refs=evidence(bound.filter(s=>matched.some(m=>m.documentVersionId===s.evidence.documentVersionId)));
   scope.inputs[id]={fact:{value:matched.length>0,state:'present',evidenceIds:[...matched.map(m=>`document:${m.documentVersionId}`),...sourceIds(refs)]},fieldIds:[],recordIds:unique(own.map(s=>s.row.verification!.recordId)),evidence:refs};
  }
  result.push(scope);
 }
 return result;
}

function corporateRequirement(value:string):boolean{
 const text=originalTextKey(value);
 return !/不(?:需|必)|无需|無需|无须|毋須|\b(?:no|not|waived)\b/iu.test(text)&&
  /出具.{0,80}(?:公司保证|公司保證|公司担保|公司擔保)|corporate guarantee (?:from|by|provided by)/iu.test(text);
}

/** Only exact reviewed selections are converted, never a whole-page keyword search. */
export function reviewedValue(definition:ReviewFieldDefinition,raw:string):string|null{
 const text=originalTextKey(raw),id=definition.id;
 if(id==='cgt_required')return corporateRequirement(text)?'yes':null;
 if(id==='cgt_limited')return /^(?:the )?specified sum is a principal cap\.?$/iu.test(text)||/^(?:limited|GUARANTEE \(Limited Amount\)|有限额责任担保|有限額責任擔保)$/iu.test(text)?'limited':/^(?:unlimited|GUARANTEE \(Unlimited Amount\)|无限额责任担保|無限額責任擔保)$/iu.test(text)?'unlimited':null;
 if(id==='cgt_rm_option')return /^\[SELECTED\]\s*\(([ab])\)$/iu.exec(text)?.[1]?.toLowerCase()??(/^[ab]$/u.test(text)?text:null);
 if(id==='cgt_resolution_kind')return /^(?:DIRECTORS? RESOLUTIONS?|董事会决议|董事會決議|board)$/iu.test(text)?'board':/^(?:SHAREHOLDERS? RESOLUTIONS?|股东会决议|股東會決議|shareholders)$/iu.test(text)?'shareholders':null;
 if(id==='cgt_jurisdiction')return /^(?:Hong Kong|香港|HK)$/iu.test(text)?'HK':null;
 if(['cgt_legal_route','cgt_translation_required','cgt_witness_signed','cgt_resolution_signer_count','cgt_rm_valid_option','cgt_yes','cgt_resolution_minimum'].includes(id))return null;
 if(definition.recipe.mode==='manual'&&!['cgt_authorization_date','cgt_authorization_reference_date','cgt_meeting_date','cgt_amount','cgt_currency','cgt_charter_minimum','cgt_articles_required_resolution'].includes(id))return null;
 const normalized=normalizeReviewValue(text,definition.type,{unit:definition.unit==='persons'?'persons':undefined,integerCount:definition.unit==='persons',literalDateClock:true});
 return normalized.status==='pending'?null:normalized.value;
}
