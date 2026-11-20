import type {DocumentFieldPresentation} from '@hsbc/contracts/document-presentation';
import type {SignatureInformationProjection} from '@hsbc/contracts/signature-information';

/** Reading rows only: do not create candidates, adopted facts or person/date associations. */
export function signatureFileDateRows(fields:DocumentFieldPresentation[], data:SignatureInformationProjection|undefined, source:{documentId:string;parseRevision:string;sha256:string;directoryRevision:string|number;materialType?:string|null}|undefined) {
  const automatic=data?.automatic;
  if(!source||source.materialType==='pg_identity'||!data||!automatic||data.documentId!==source.documentId||data.parseRevision!==source.parseRevision||data.sourceSha256!==source.sha256||String(data.directoryRevision)!==String(source.directoryRevision)||
    automatic.documentId!==source.documentId||automatic.parseRevision!==source.parseRevision||automatic.sourceSha256!==source.sha256)return [];
  return automatic.dates.filter(date=>date.value.trim()&&!fields.some(field=>
    field.documentVersionId===source.documentId&&field.parseRevision===source.parseRevision&&
    (field.fieldId==='cgt_field_6'||field.fieldLabel===date.label)&&
    (field.rawValue===date.value||field.candidates.some(candidate=>(candidate.displayValue??candidate.rawValue)===date.value))
  )).map((date,index)=>({date,field:{
    id:`signature-file-date:${index}`,fieldId:`signature-file-date:${index}`,fieldLabel:date.label,
    documentVersionId:source.documentId,parseRevision:source.parseRevision,status:'extracted',rawValue:date.value,normalizedValue:null,
    pageNumbers:[date.pageNumber],anchorIds:date.evidence.filter(ref=>ref.documentVersionId===source.documentId&&ref.parseRevision===source.parseRevision).flatMap(ref=>ref.anchorId?[ref.anchorId]:[]),
    candidates:[],objectId:null,humanRevisionId:null,coverageGaps:[],
  } satisfies DocumentFieldPresentation}));
}

export function hasSavedSignatureInformation(data:SignatureInformationProjection) {
  return !!data.recordId||data.history.length>0||Object.values(data.state).some(records=>records.length>0);
}
