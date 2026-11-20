import type {ReviewEvidence} from '@hsbc/contracts/review';
import type {SignatureEntry, SignatureInformationProjection, SignatureInformationState} from '@hsbc/contracts/signature-information';
import type {SignatureBox} from '@hsbc/contracts/signature-review';
import {fieldCandidateDisplayText, tableRecordLabels} from '@hsbc/contracts/document-presentation';
import type {FieldsResponse} from './types.ts';
import {visibleDocumentFields, presentationFieldObservation, requiresFieldSemanticFilter} from './presentation.ts';
import {signatureRoleLabel} from './signature-presentation.ts';
import {authorizationSignatureDetails,isAuthorizationSignatureDocument} from './authorization-signatures.ts';

export type SignatureDetailValue = {label:string;value:string;evidence:ReviewEvidence[];pages:number[];box?:SignatureBox|null;note?:string};
export type SignatureDetailRecord = {id:string;title:string;presence:string;fields:SignatureDetailValue[];entry?:SignatureEntry;pages:number[];automaticBox?:SignatureBox;uncertainText?:boolean};
const field = (label:string,value:string,evidence:ReviewEvidence[]=[],pages:number[]=[]):SignatureDetailValue => ({label,value,evidence,pages});

/** Existence and identity are separate. Unknown/printed/excluded evidence never means a signed document. */
export function signaturePresence(entry: SignatureEntry, stale: boolean, dirty: boolean): string {
  if (entry.status === 'excluded') return '此记录已排除';
  if (stale) return '原件或信息已更新，需重新查看';
  if (dirty) return '修改尚未保存';
  if (entry.kind === 'handwriting') return entry.status === 'confirmed' ? '有签字（已核对此处）' : '签字记录，待核对原件';
  if (entry.kind === 'blank_signing_slot') return entry.status === 'confirmed' ? '此处为空白签署栏' : '疑似空白签署栏，待核对';
  if (entry.kind === 'printed_name') return '仅有打印姓名记录，签字情况待查看';
  if (entry.kind === 'stamp') return entry.status === 'confirmed' ? '有印章（不代表有签字）' : '印章记录，待核对原件';
  return '是否有签字待查看原件';
}

/** Read-only details. Same-page/name proximity never joins a date or identity number to a person. */
export function signatureDetails(data:SignatureInformationProjection,state:SignatureInformationState,response?:FieldsResponse,includeFields=true,dirty=false,coveredAutomaticRecordIds:readonly string[]=[]) {
  const currentObject=(id:string|null)=>data.objects.find(o=>o.objectId===id&&o.validity==='current');
  const records:SignatureDetailRecord[]=state.entries.map((entry,index)=>{
    const location=state.locations.find(l=>l.id===entry.locationId);
    const person=currentObject(entry.personId),subject=currentObject(entry.subjectId);
    const dates=state.dates.filter(d=>d.status!=='excluded'&&((d.kind==='person_signing'&&d.targetType==='entry'&&d.targetId===entry.id)||(d.kind==='location_signing'&&d.targetType==='location'&&d.targetId===entry.locationId)));
    return {id:entry.id,entry,title:location?.label||`签署位置 ${index+1}`,pages:location?[location.pageNumber]:[],presence:signaturePresence(entry,data.validity==='stale',dirty),fields:[
      field('姓名',entry.kind==='stamp'?'印章无签署人':person?`${person.label}${entry.identityConfirmed&&entry.status==='confirmed'?'':'（对应关系待核对）'}`:'尚未确认签署人',entry.evidence),
      field('日期',dates.length?dates.map(d=>`${d.rawValue||'原文留空'}${d.status==='confirmed'?'':'（待核对）'}`).join('；'):'未关联日期',dates.flatMap(d=>d.evidence)),
      field('职位',entry.role?signatureRoleLabel(entry.role):'未记录职位'),
      field('证件号码','未关联号码'),
      ...(subject?[field(entry.kind==='stamp'?'印章所属主体':'代表主体',subject.label)]:[]),
    ]};
  });
  const extracted:SignatureDetailValue[]=[];
  const automatic=data.automatic;
  const validAutomatic=includeFields&&automatic?.documentId===data.documentId&&automatic.parseRevision===data.parseRevision&&automatic.sourceSha256===data.sourceSha256;
  const automaticRecords:SignatureDetailRecord[]=validAutomatic?automatic.records.map((r,index)=>({id:r.id,title:r.label||r.name?.value||`签署位置 ${index+1}`,pages:[r.pageNumber],automaticBox:r.box,uncertainText:r.uncertainText,
    presence:({handwriting:'有签字（自动识别）',graphic:'已检测到签字图形',blank:'空白签署栏（自动识别）',printed:'仅检测到打印文字',stamp:'检测到印章',unknown:'未能确定是否有签字'})[r.presence],
    fields:[...(r.purpose?[field('用途',r.purpose==='specimen'?'签字样本':'文书签署')]:[]),{...field('姓名',r.name?.value??'未提取到',r.name?.evidence,[r.pageNumber]),box:r.name?.box},
      ...(r.dates.length?r.dates.map(d=>({...field(d.label,d.value,d.evidence,[r.pageNumber]),box:d.box})):r.purpose==='specimen'?[]:[field('个人签署日期','未提取到对应日期')]),
      ...(r.address?[{...field(r.address.label,r.address.value,r.address.evidence,[r.pageNumber]),box:r.address.box}]:[]),
      ...(!r.id.startsWith('nd2a-signature:')||r.role?.value.trim()?[{...field('职位',r.role?.value??'未提取到对应职位',r.role?.evidence,r.role?[r.pageNumber]:[]),box:r.role?.box}]:[]),
      ...(!r.id.startsWith('nd2a-signature:')||r.number?.value.trim()?[{...field(r.number?.label??'证件号码',r.number?.value??'未提取到对应号码',r.number?.evidence,r.number?[r.pageNumber]:[]),box:r.number?.box}]:[])]})):[];
  if(validAutomatic)for(const d of automatic.dates){
    const coveredDate=response?.presentationItems?.some(f=>f.fieldId==='cgt_field_6'&&f.documentVersionId===data.documentId&&f.parseRevision===data.parseRevision&&f.candidates.some(c=>(c.displayValue??c.rawValue)===d.value));
    if(!coveredDate)extracted.push({...field(d.label,d.value,d.evidence,[d.pageNumber]),box:d.box});
  }
  const tableRecords:SignatureDetailRecord[]=[];
  const covered=new Set<string>();
  // A historical signature record must not silently acquire latest extraction values.
  const validFields=includeFields&&data.validity==='current'&&response?.parseRevision===data.parseRevision&&String(response.directoryRevision)===String(data.directoryRevision);
  const relevant=/签署|簽署|签字|簽字|签名|见证|見證|signator|signature|witness/i;
  const rule=/决议|決議|resolution|组合|人數|人数|条件|條件|授权范围|授權範圍|signing.conditions|combination/i;
  for(const original of validFields&&!automaticRecords.length?visibleDocumentFields(response,data.directoryRevision):[]){
    if(original.documentVersionId!==data.documentId||original.parseRevision!==data.parseRevision)continue;
    const item=presentationFieldObservation(original,requiresFieldSemanticFilter(original.fieldId,response));
    const rows=item.tableRecords?.records.filter(r=>r.kind==='signatory')??[];
    if(!rows.length&&(!relevant.test(item.fieldLabel)||rule.test(item.fieldLabel)))continue;
    covered.add(item.fieldId);
    const refs=(ids:string[])=>ids.map(anchorId=>({documentVersionId:data.documentId,parseRevision:data.parseRevision,directoryRevision:data.directoryRevision,anchorId}));
    for(const row of rows){
      if(tableRecords.some(r=>r.id===row.id))continue;
      tableRecords.push({id:row.id,title:`签署人员信息 · 第 ${row.pageNumber} 页`,pages:[row.pageNumber],presence:'是否有签字待查看原件',fields:row.components.map(c=>field(tableRecordLabels[c.role],c.value||'未提取到文字',refs(c.locationAnchorIds),[row.pageNumber]))});
    }
    const indexes=rows.length?item.tableRecords?.otherCandidateIndexes??[]:item.candidates.map((_,i)=>i);
    for(const index of indexes){const c=item.candidates[index];if(c)extracted.push(field(item.fieldLabel,fieldCandidateDisplayText(c)||'未提取到文字',refs(c.anchorIds),c.pageNumbers));}
    if(!rows.length&&!item.candidates.length)extracted.push(field(item.fieldLabel,item.rawValue||'未提取到可用信息',refs(item.anchorIds),item.pageNumbers));
  }
  for(const c of data.candidates){
    if(automaticRecords.length)continue;
    if(covered.has(c.fieldId)||c.kind==='authorization'||c.kind==='date'&&c.dateKind&&!['document_signing','person_signing','location_signing'].includes(c.dateKind))continue;
    const previous=extracted.find(v=>v.label===c.label&&v.value===(c.value??'未提取到文字'));
    if(previous){previous.evidence.push(...c.evidence);previous.pages=[...new Set([...previous.pages,...c.pageNumbers])];}
    else extracted.push(field(c.label,c.value??'未提取到文字',c.evidence,c.pageNumbers));
  }
  // Saved file dates remain file dates, never copied into each signer's record.
  for(const d of state.dates.filter(d=>d.status!=='excluded'&&d.kind==='document_signing'))extracted.push(field('文件签署日期',`${d.rawValue||'原文留空'}${d.status==='confirmed'?'':'（待核对）'}`,d.evidence));
  // Suppress only source records actually rendered in the field list. Saved
  // human records, historical records and unassigned observations remain visible.
  const visibleRecords=[...automaticRecords.filter(record=>!coveredAutomaticRecordIds.includes(record.id)),...records,...tableRecords];
  const authorization=isAuthorizationSignatureDocument(data)&&includeFields;
  const authorizationFields=validFields?visibleDocumentFields(response,data.directoryRevision).filter(f=>f.documentVersionId===data.documentId&&f.parseRevision===data.parseRevision).map(f=>presentationFieldObservation(f,requiresFieldSemanticFilter(f.fieldId,response))):[];
  return {records:authorization?authorizationSignatureDetails(visibleRecords,authorizationFields,data):visibleRecords,extracted:authorization?[]:extracted,fieldsAvailable:Boolean(validFields)};
}
