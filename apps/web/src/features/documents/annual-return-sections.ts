import {fieldCandidateDisplayText,type DocumentFieldPresentation} from '@hsbc/contracts/document-presentation';

type Field=DocumentFieldPresentation;
type Candidate=Field['candidates'][number];
type Section={key:string;label?:string;rows:Field[]};
const detailIds=['cgt_field_45','cgt_field_46','cgt_field_47'];

function recordKey(field:Field,candidate:Candidate){
  const record=candidate.formRecord;
  if(field.humanRevisionId||record?.version!=='nar1-director-record-v1'||!record.headingAnchorIds.length||
    candidate.pageNumbers.length!==1||candidate.pageNumbers[0]!==record.pageNumber||
    !record.headingAnchorIds.every(id=>candidate.contextAnchorIds?.includes(id)))return null;
  return JSON.stringify([field.documentVersionId,field.parseRevision,record.logicalDocumentId,record.recordId,record.pageNumber,record.headingAnchorIds]);
}
function sliceField(field:Field,candidates:Candidate[]):Field{
  return {...field,candidates,rawValue:candidates.length===1?candidates[0]!.rawValue:null,
    normalizedValue:candidates.length===1?candidates[0]!.normalizedValue:null,
    anchorIds:[...new Set(candidates.flatMap(c=>c.anchorIds))],pageNumbers:[...new Set(candidates.flatMap(c=>c.pageNumbers))],
    status:candidates.length?field.status:'not_found',
    coverageGaps:candidates.length?field.coverageGaps:[...new Set([...field.coverageGaps,'field_not_found_in_processed_scope'])]};
}

/** Reading groups, not new observations/facts. Never zip candidate arrays or
 * match by spelling, page alone, or a model-supplied entityKey. */
export function annualReturnFieldSections(fields:readonly Field[]):Section[]|null{
  const roster=fields.find(f=>f.fieldId==='cgt_field_44');
  if(!roster)return null;
  const records=roster.candidates.flatMap(candidate=>{
    const key=recordKey(roster,candidate);return key?[{key,candidate}]:[];
  });
  if(!records.length||new Set(records.map(r=>r.key)).size!==records.length)return null;
  const sections:Section[]=[{key:'annual-company',rows:fields.filter(f=>!detailIds.includes(f.fieldId)&&f.fieldId!=='cgt_field_48')}];
  const consumed=new Set<Candidate>();
  for(const [index,record] of records.entries()){
    const rows=detailIds.flatMap(id=>{
      const field=fields.find(f=>f.fieldId===id);if(!field||field.humanRevisionId)return [];
      const candidates=field.candidates.filter(c=>recordKey(field,c)===record.key);
      candidates.forEach(c=>consumed.add(c));
      return [sliceField(field,candidates)];
    });
    sections.push({key:record.key,label:`董事 ${index+1} · ${fieldCandidateDisplayText(record.candidate)}`,rows});
  }
  const unassigned=fields.filter(f=>detailIds.includes(f.fieldId)).flatMap(field=>{
    if(field.humanRevisionId)return [field];
    const candidates=field.candidates.filter(c=>!consumed.has(c));
    // Preserve old/unlocated/scoped candidates rather than attach them to the
    // closest or equally named director. Manual facts remain intact as well.
    return candidates.length?[sliceField(field,candidates)]:[];
  });
  if(unassigned.length)sections.push({key:'annual-unassigned',label:'其他人员资料（归属待核对）',rows:unassigned});
  sections.push({key:'annual-date',rows:fields.filter(f=>f.fieldId==='cgt_field_48')});
  return sections.filter(section=>section.rows.length);
}
