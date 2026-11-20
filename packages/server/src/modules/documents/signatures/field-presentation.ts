import type {DocumentFieldPresentation} from '@hsbc/contracts/document-presentation';
import type {DocumentBundle} from '@hsbc/contracts/documents';
import type {ReviewFieldDefinition} from '@hsbc/contracts/review-config';
import type {AutomaticSignatureInformation} from '@hsbc/contracts/signature-information';

const purposes={cgt_field_30:'execution',cgt_field_31:'specimen',cgt_field_15:'execution',cgt_field_20:'execution',pg_field_12:'execution',pg_field_22:'execution'} as const;
const taxonomy=(id:string)=>id==='pg_field_12'?'pg_guarantee':id==='pg_field_22'?'pg_note':['cgt_field_15','cgt_field_20'].includes(id)?'cgt_guarantee':'cgt_resolution';
export function isSourceSignatureField(definition:ReviewFieldDefinition){
  return Object.hasOwn(purposes,definition.id)&&definition.recipe.mode==='manual'&&definition.taxonomyIds?.includes(taxonomy(definition.id));
}
export function isResolutionSignatureField(definition:ReviewFieldDefinition){
  return ['cgt_field_30','cgt_field_31'].includes(definition.id)&&isSourceSignatureField(definition);
}

/** Read projection only. Extraction and human confirmation are independent;
 * source records never become textual candidates, adopted facts or approvals. */
export function projectSignatureFields(fields:DocumentFieldPresentation[],definitions:ReviewFieldDefinition[],documents:DocumentBundle['logicalDocuments'],automatic:AutomaticSignatureInformation):DocumentFieldPresentation[]{
  return fields.map(field=>{
    if(field.humanRevisionId||field.rawValue||field.candidates.length||field.documentVersionId!==automatic.documentId||field.parseRevision!==automatic.parseRevision||
      !definitions.some(d=>d.id===field.fieldId&&isSourceSignatureField(d)))return field;
    const purpose=purposes[field.fieldId as keyof typeof purposes],material=taxonomy(field.fieldId),personal=field.fieldId==='pg_field_12',note=field.fieldId==='pg_field_22';
    const pages=[...new Set(documents.filter(d=>d.labelId===material&&['candidate','confirmed'].includes(d.status)).flatMap(d=>d.pageNumbers))]
      .filter(page=>documents.filter(d=>d.pageNumbers.includes(page)).every(d=>d.labelId===material));
    const records=automatic.records.filter(r=>pages.includes(r.pageNumber)&&(note?r.label==='发票人签署':(material==='cgt_guarantee'||personal?r.purpose!=='specimen':r.purpose===purpose)&&
      (personal||purpose==='specimen'||(field.fieldId==='cgt_field_20'?/witness|见证|見證/iu:field.fieldId==='cgt_field_15'?/director|secretary|董事|秘书|秘書/iu:/\b(?:director|chair(?:man)?|shareholder)\b|董事|主席|股[东東]/iu).test(r.role?.value??'')))&&
      r.evidence.length>0&&r.evidence.every(e=>e.documentVersionId===field.documentVersionId&&e.parseRevision===field.parseRevision));
    const found=records.some(r=>r.presence==='graphic'||r.presence==='handwriting');
    const unavailable=!pages.length||pages.some(page=>!automatic.coverage.processedPages.includes(page)||automatic.coverage.unavailablePages.includes(page));
    return {...field,status:'uncertain',signatureRecords:{purpose,state:found?'detected':unavailable?'unavailable':'not_detected',coverageIncomplete:unavailable,records},
      coverageGaps:field.coverageGaps.filter(g=>g!=='field_not_found_in_processed_scope')};
  });
}
