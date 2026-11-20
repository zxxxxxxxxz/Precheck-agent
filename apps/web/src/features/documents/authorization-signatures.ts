import type {DocumentFieldPresentation} from '@hsbc/contracts/document-presentation';
import {fieldCandidateDisplayText} from '@hsbc/contracts/document-presentation';
import type {SignatureInformationProjection} from '@hsbc/contracts/signature-information';
import type {SignatureDetailRecord,SignatureDetailValue} from './signature-details.ts';
import {fieldRowState} from './presentation.ts';

const componentFields={pg_field_31:'姓名',pg_field_32:'职衔',pg_field_33:'身份证字号',pg_field_34:'住址'} as const;
export const authorizationSignatureFieldIds=new Set(['pg_field_30',...Object.keys(componentFields),'pg_field_35']);
export function authorizationFieldLayout(fields:DocumentFieldPresentation[],materialType?:string|null){
  return materialType==='pg_authorization'?fields.filter(f=>!authorizationSignatureFieldIds.has(f.fieldId)):fields;
}
export function isAuthorizationSignatureDocument(data:Pick<SignatureInformationProjection,'locations'>){
  return data.locations.length>0&&data.locations.every(l=>l.taxonomyId==='pg_authorization');
}

/** Move the issuer's configured fields, including corrections and conflicting
 * candidates, into its signing block. Never assign them to an endorser. */
export function authorizationSignatureDetails(records:SignatureDetailRecord[],fields:DocumentFieldPresentation[],data:SignatureInformationProjection){
  const labels=['姓名','职衔','身份证字号','住址'];
  const aliases:Record<string,string>={'职位':'职衔','证件号码':'身份证字号','地址':'住址'};
  const result=records.map(r=>({...r,fields:labels.flatMap(label=>{
    const values=r.fields.filter(f=>(aliases[f.label]??f.label)===label).map(f=>({...f,label}));
    return values.length?values:[{label,value:'未提取到',evidence:[],pages:[]}];
  })}));
  let issuers=result.filter(r=>r.title==='立书人签署');
  if(!issuers.length){
    const issuer:SignatureDetailRecord={id:'authorization:issuer',title:'立书人签署',presence:'是否签字待核对',pages:[],fields:labels.map(label=>({label,value:'未提取到',evidence:[],pages:[]}))};
    result.unshift(issuer);issuers=[issuer];
  }
  // Multiple/manual issuer records must not acquire unassigned field values.
  // Keep those document-level candidates in a separate reviewable block.
  if(issuers.length!==1||issuers[0]!.entry){
    const unassigned:SignatureDetailRecord={id:'authorization:issuer-fields',title:'立书人签署',presence:'人员对应待核对',pages:[],fields:labels.map(label=>({label,value:'未提取到',evidence:[],pages:[]}))};
    result.push(unassigned);issuers=[unassigned];
  }
  const issuer=issuers[0]!;
  for(const [id,label] of Object.entries(componentFields)){
    const source=fields.find(f=>f.fieldId===id);if(!source)continue;
    const refs=(ids:string[])=>ids.map(anchorId=>({documentVersionId:data.documentId,parseRevision:data.parseRevision,directoryRevision:data.directoryRevision,anchorId}));
    const note=fieldRowState(source,source.coverageGaps).label;
    const values:SignatureDetailValue[]=source.humanRevisionId&&source.rawValue?.trim()
      ?[{label,value:source.rawValue,evidence:refs(source.anchorIds),pages:source.pageNumbers,note}]
      :source.candidates.filter(c=>fieldCandidateDisplayText(c).trim()).map(c=>({label,value:fieldCandidateDisplayText(c),evidence:refs(c.anchorIds),pages:c.pageNumbers,note}));
    if(!values.length&&source.rawValue?.trim())values.push({label,value:source.rawValue,evidence:refs(source.anchorIds),pages:source.pageNumbers,note});
    if(!values.length){issuer.fields=issuer.fields.map(f=>f.label===label?{...f,note}:f);continue;}
    issuer.fields=issuer.fields.flatMap(f=>f.label===label?values:[f]);
    issuer.pages=[...new Set([...issuer.pages,...values.flatMap(v=>v.pages)])];
  }
  const signed=fields.find(f=>f.fieldId==='pg_field_30'&&f.humanRevisionId&&f.rawValue?.trim());
  if(signed)issuer.presence=`${signed.rawValue}（已人工核对）`;
  // A non-empty endorser candidate must remain reviewable even when its
  // positioned signing block could not be reconstructed. Empty label/line
  // collections are optional form slots, not people.
  const endorser=fields.find(f=>f.fieldId==='pg_field_35');
  const content=(value:string)=>{
    let plain=value;
    for(let i=0;i<8;i++)plain=plain.replace(/\\(?:underline|text|textrm|textbf|mathrm)\{([^{}]*)\}/gu,'$1');
    return plain.replace(/背[书書]人|the\s+endorser|姓名|name|职衔|職銜|title|身份证字号|身份證字號|id\s+number|住址|address/giu,'').replace(/[_$\s:：（）().\-—]/gu,'');
  };
  const candidates=endorser?(!endorser.humanRevisionId&&endorser.candidates.length
    ?endorser.candidates.map(c=>({value:fieldCandidateDisplayText(c),ids:c.anchorIds,pages:c.pageNumbers}))
    :[{value:endorser.rawValue??'',ids:endorser.anchorIds,pages:endorser.pageNumbers}]):[];
  const populated=candidates.filter(c=>/\p{L}|\p{N}/u.test(content(c.value)));
  const endorsers=result.filter(r=>r.title==='背书人签署'&&!r.entry);
  const values:SignatureDetailValue[]=populated.map(v=>({label:'姓名',value:v.value,pages:v.pages,
    evidence:v.ids.map(anchorId=>({documentVersionId:data.documentId,parseRevision:data.parseRevision,directoryRevision:data.directoryRevision,anchorId})),
    note:endorser?.humanRevisionId?'已人工更正':'背书人原文，人员对应待核对'}));
  if(endorser?.humanRevisionId&&endorsers.length===1&&values.length){
    endorsers[0]!.fields=endorsers[0]!.fields.flatMap(f=>f.label==='姓名'?values:[f]);
  }else{
    const unassigned=values.filter(v=>!endorsers.some(r=>r.fields.some(f=>f.label==='姓名'&&f.value.replace(/\s/gu,'')===v.value.replace(/\s/gu,''))));
    if(unassigned.length)result.push({id:'authorization:endorser-candidate',title:'背书人签署',presence:'是否签字待核对',
      pages:[...new Set(unassigned.flatMap(v=>v.pages))],uncertainText:true,
      fields:labels.flatMap<SignatureDetailValue>(label=>label==='姓名'?unassigned:[{label,value:'未提取到',evidence:[],pages:[]}])});
  }
  return result;
}
