import {createHash} from 'node:crypto';
import {assessFieldQuality} from '@hsbc/contracts/field-quality';
import {candidateAdoptionValue,candidateRequiredEvidenceGroups,type DocumentFieldObservation} from '@hsbc/contracts/documents';
import type {ReviewFieldDefinition} from '@hsbc/contracts/review-config';
import type {ReviewFact,ReviewEvidence,ReviewObject} from '@hsbc/contracts/review';
import {normalizeReviewValue} from './normalization.js';
import {fieldCandidateSelection} from './field-candidate-selection.js';

export const FIELD_ACCEPTANCE_POLICY='grounded-field-acceptance-v2' as const;
/** Runs frozen under an earlier policy stay verifiable. */
export const FIELD_ACCEPTANCE_POLICIES:readonly string[]=['grounded-field-acceptance-v1',FIELD_ACCEPTANCE_POLICY];
export interface AutomaticFieldSource {
  field:DocumentFieldObservation;
  candidate:DocumentFieldObservation['candidates'][number];
  evidence:ReviewEvidence[];
  availableAnchorIds:readonly string[];
  sourceHash:string;
}
const hash=(value:unknown)=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const unique=<T>(values:T[])=>[...new Set(values)];
/** Candidates arrive only after exact current material/object attribution.
 * No writes, human identities, confirmation events or contribution records. */
export function automaticFieldFact(definition:ReviewFieldDefinition, object:ReviewObject, sources:AutomaticFieldSource[], caseRevision:number, observations:DocumentFieldObservation[]=sources.map(source=>source.field)):{fact?:ReviewFact;reason:string} {
  if(definition.recipe.mode==='manual')return {reason:'此项需要业务判断，自动提取不能确定结论。'};
  if(!sources.length)return {reason:'尚无有原文依据的提取值。'};
  const reasons:string[]=[];
  const multiple=definition.valueMultiplicity==='entities'||definition.valueMultiplicity==='clauses';
  for(const field of observations){
    // Field coverage applies to the complete field; multiplicity/normalization
    // are resolved below for this exact object, not other people in the file.
    const quality=assessFieldQuality({...field,coverageGaps:(field.coverageGaps??[]).filter(code=>!['normalization_requires_confirmation','repeated_value_object_association_unconfirmed'].includes(code))},
      {multiple:true,valueGrounded:true,requireSemanticFilter:['cloud_grounded_extract','private_candidate_filter'].includes(definition.recipe.mode)});
    reasons.push(...quality.reasons);
  }
  for(const source of sources){
    const groups=candidateRequiredEvidenceGroups(source.candidate);
    if(!source.sourceHash||groups.some(group=>!group.length||group.some(id=>!source.availableAnchorIds.includes(id))))reasons.push('部分提取依据无法定位到当前版本原文。');
  }
  // Resolve each document's alternatives before comparing this object's values
  // across documents. The original observations remain immutable audit records.
  const selectedSources=unique(sources.map(s=>s.field.documentVersionId)).flatMap(documentId=>{
    const group=sources.filter(s=>s.field.documentVersionId===documentId);
    const selection=fieldCandidateSelection(group.map((s,index)=>({id:String(index),documentId:s.field.documentVersionId,
      value:candidateAdoptionValue(s.candidate),confidence:s.candidate.confidence,evidence:s.evidence})),definition);
    return selection&&selection.reason!=='unresolved'?selection.candidateIds.map(id=>group[Number(id)]!):group;
  });
  const normalized=selectedSources.map(({candidate})=>{
    const raw=candidateAdoptionValue(candidate);
    const currencies=candidate.structuredValue?.components.filter(c=>c.role==='currency'&&c.anchorIds.length&&c.anchorIds.every(id=>candidateRequiredEvidenceGroups(candidate).flat().includes(id))).map(c=>c.value)??[];
    const currency=unique(currencies).length===1?currencies[0]:definition.recipe.mode==='cloud_grounded_extract'?undefined:definition.currency??undefined;
    const result=normalizeReviewValue(raw,definition.type,{currency,unit:definition.unit==='currency'?undefined:definition.unit??undefined,
      literalDateClock:definition.recipe.version==='azure-grounded-fields-v2',integerCount:definition.unit==='persons'&&definition.currency===null});
    if(result.status==='pending')reasons.push(definition.type==='amount'?'金额、币种或单位不明确，尚不能用于计算。':definition.type==='date'?'日期存在歧义，尚不能用于比较。':'取值尚不能明确转换为本字段要求的格式。');
    if(definition.type==='amount'&&definition.currency&&result.currency&&definition.currency!==result.currency)reasons.push('提取币种与本字段要求不一致。');
    return {raw,...result};
  });
  const identities=unique(normalized.map(v=>JSON.stringify([v.value,v.currency,v.unit])));
  if(!multiple&&identities.length>1)reasons.push('同一对象的同一字段存在不同取值，请核对各处原文。');
  if(reasons.length)return {reason:unique(reasons).join('；')};
  const values=unique(normalized.map(v=>v.raw));
  const evidence=[...new Map(sources.flatMap(s=>s.evidence).map(e=>[JSON.stringify(e),e])).values()];
  const automaticAdoption={kind:'extraction' as const,policyVersion:FIELD_ACCEPTANCE_POLICY,
    observationIds:unique(sources.map(s=>s.field.id)),sourceHashes:unique(sources.map(s=>s.sourceHash)),values};
  const digest=hash([object.objectId,object.version,definition,automaticAdoption,evidence]);
  const factId=`${digest.slice(0,8)}-${digest.slice(8,12)}-5${digest.slice(13,16)}-a${digest.slice(17,20)}-${digest.slice(20,32)}`;
  const first=normalized[0]!;
  const {value:_,raw:__,...normalization}=first;
  return {reason:'提取值已通过原文依据、取值及归属检查，可直接用于后续检查。',fact:{factId,objectId:object.objectId,fieldId:definition.id,
    state:'present',rawValue:multiple?values.join('\n\n'):first.raw,normalizedValue:multiple?unique(normalized.map(v=>String(v.value))).join('\n\n'):first.value,
    normalization,evidence,version:1,validity:'current',confirmedBy:null,caseRevision,automaticAdoption,
    ...(first.currency?{currency:first.currency}:{}),...(definition.unit==='persons'?{unit:'persons'}:{})}};
}
