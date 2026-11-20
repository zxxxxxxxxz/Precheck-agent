import type {DocumentFieldObservation} from '@hsbc/contracts/documents';
import type {SuppliedFieldValue,SupplyFieldValue} from '@hsbc/contracts/review-field-supply';
import {AppError} from '../../shared/errors.js';
import type {DB} from '../../infrastructure/database/client.js';

const hasValue=(field:DocumentFieldObservation)=>field.candidates.some(candidate=>(candidate.displayValue??candidate.rawValue).trim())||Boolean(field.rawValue?.trim());
/** True when extraction left this field without any value in the file. Supplying never overrides an extracted value. */
export function fieldIsEmpty(fields:readonly DocumentFieldObservation[],fieldId:string){return !fields.filter(field=>field.fieldId===fieldId).some(hasValue);}

/** Display context only: parsed passages can carry table markup. The stored quote stays verbatim. */
const plainContext=(quote:string)=>quote.replace(/<\/?[a-zA-Z][^>]*>/g,' ').replace(/\s+/g,' ').trim()||quote;
/** Latest confirmed supply per file and field in the round; a later withdrawal removes it. */
export async function suppliedFieldValues(db:DB,caseId:string,roundId:string|null):Promise<SuppliedFieldValue[]>{
  const rows=(await db.query(`SELECT DISTINCT ON (details->>'documentId',details->>'fieldId') id,kind,details,created_at FROM business.review_events
    WHERE case_id=$1 AND round_id IS NOT DISTINCT FROM $2::uuid AND kind IN ('field_value_supplied','field_value_withdrawn')
    ORDER BY details->>'documentId',details->>'fieldId',created_at DESC,id DESC`,[caseId,roundId])).rows;
  return rows.filter(row=>row.kind==='field_value_supplied').map(row=>({recordId:row.id,documentId:row.details.documentId,fieldId:row.details.fieldId,value:row.details.value,quote:row.details.quote,
    evidence:row.details.evidence,page:row.details.page,parseRevision:row.details.parseRevision,directoryRevision:row.details.directoryRevision,replace:row.details.replace===true,origin:row.details.origin==='assistant'?'assistant':'manual',suppliedAt:new Date(row.created_at).toISOString()}));
}
/** Shows a supplied value as the file's value for that field. A new parse or directory revision drops it.
 * A fill gives way to an extraction that has since found a value; a confirmed correction replaces the extracted values. */
export function withSuppliedFields(fields:DocumentFieldObservation[],supplied:readonly SuppliedFieldValue[],doc:{id:string;parseRevision:string|null;directoryRevision:number|null},labels?:ReadonlyMap<string,string>):DocumentFieldObservation[]{
  const own=supplied.filter(item=>item.documentId===doc.id&&item.parseRevision===doc.parseRevision&&item.directoryRevision===doc.directoryRevision&&item.evidence.anchorId&&(item.replace||fieldIsEmpty(fields,item.fieldId)));
  if(!own.length)return fields;
  const next=[...fields];
  for(const item of own){
    const anchorIds=[item.evidence.anchorId!],pageNumbers=[item.page];
    const candidate={rawValue:item.value,normalizedValue:null,anchorIds,pageNumbers,contextText:plainContext(item.quote),contextAnchorIds:anchorIds};
    const candidateId=`supplied:${item.recordId}`,existing=next.find(field=>field.fieldId===item.fieldId);
    const value:DocumentFieldObservation={id:`supplied:${item.recordId}`,fieldId:item.fieldId,fieldLabel:labels?.get(item.fieldId)??item.fieldId,documentVersionId:doc.id,parseRevision:item.parseRevision,
      status:'extracted',rawValue:item.value,normalizedValue:null,pageNumbers,anchorIds,
      candidates:[candidate],
      // The reviewer's confirmation settles this field: without a completed selection it would read as still awaiting filtering.
      semanticFilter:{version:existing?.semanticFilter?.version??'azure-grounded-fields-v2',state:'completed',model:null,originalCandidates:[{...candidate,candidateId}],
        decisions:[{candidateId,decision:'selected',anchorIds,pageNumbers}],reasonCodes:[]},
      objectId:null,humanRevisionId:item.recordId,coverageGaps:[]};
    const index=next.findIndex(field=>field.fieldId===item.fieldId);
    // Replace the empty observation whole: its own filter decisions and coverage describe the extraction, not this value.
    if(index<0)next.push(value);else next[index]={...value,id:next[index]!.id,fieldLabel:next[index]!.fieldLabel,objectId:next[index]!.objectId,...(next[index]!.valueMultiplicity?{valueMultiplicity:next[index]!.valueMultiplicity}:{})};
    for(let i=next.length-1;i>index&&index>=0;i--)if(next[i]!.fieldId===item.fieldId)next.splice(i,1);
  }
  return next;
}
/** The quote must be a passage of the cited anchor's own text in the pinned parse, and the value a part of the quote. */
export async function verifySuppliedQuote(db:DB,input:Pick<SupplyFieldValue,'value'|'quote'|'evidence'|'documentId'>):Promise<number>{
  const e=input.evidence;
  if(!e.anchorId||e.documentVersionId!==input.documentId||!e.directoryRevision)throw new AppError(422,'field_value_evidence_unsupported');
  if(!input.quote.includes(input.value))throw new AppError(422,'field_value_not_in_quote');
  const body=(await db.query(`SELECT jsonb_build_object('chunks',body->'chunks','anchors',body->'anchors') AS body FROM business.document_artifacts WHERE job_id=$1 AND directory_revision=$2`,[e.parseRevision,e.directoryRevision])).rows[0]?.body;
  const anchor=(body?.anchors??[]).find((a:any)=>a.anchor_id===e.anchorId&&a.document_version_id===input.documentId&&a.parse_revision===e.parseRevision);
  const chunk=(body?.chunks??[]).find((c:any)=>Array.isArray(c.anchorIds)&&c.anchorIds.includes(e.anchorId)&&typeof c.text==='string'&&c.text.includes(input.quote));
  if(!anchor||!chunk||!Number.isSafeInteger(anchor.page_number)||anchor.page_number<1)throw new AppError(422,'field_value_quote_invalid');
  return anchor.page_number;
}
