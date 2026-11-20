import type {DocumentFieldPresentation} from '@hsbc/contracts/document-presentation';
import type {AutomaticSignatureRecord} from '@hsbc/contracts/signature-information';

export function guaranteeLimitLabel(value:string|null|undefined) {
  if(value==='limited'||/^(?:GUARANTEE\s*\(\s*Limited Amount\s*\)|Limited Guarantee|有限额(?:责任)?担保|有限額(?:責任)?擔保)$/iu.test(value??''))return '否（有限额责任担保）';
  if(value==='unlimited'||/^(?:GUARANTEE\s*\(\s*Unlimited Amount\s*\)|Unlimited Guarantee|无限额(?:责任)?担保|無限額(?:責任)?擔保)$/iu.test(value??''))return '是（无限额责任担保）';
  return undefined;
}
const labels:Record<string,string>={cgt_field_4:'银行名称',cgt_field_5:'管辖法律及管辖权',cgt_field_6:'文件签署日期',cgt_field_7:'客户名称',cgt_field_8:'客户地址',cgt_field_9:'担保人名称',cgt_field_10:'担保人地址',cgt_field_11:'担保人证件信息',cgt_field_13:'银行地址',cgt_field_14:'签署主体'};
const same = (a:string,b:string) => a.replace(/\s+/gu,'').toLowerCase() === b.replace(/\s+/gu,'').toLowerCase();
const hasValue = (field:DocumentFieldPresentation) => Boolean(field.rawValue?.trim() || field.candidates.some(candidate=>candidate.rawValue.trim()));
const sameSource = (a:DocumentFieldPresentation,b:DocumentFieldPresentation) => a.documentVersionId===b.documentVersionId && a.parseRevision===b.parseRevision;
/** Suppress only values covered by the same document/revision's source records.
 * Unmatched extractions and human corrections remain available for review. */
export function guaranteeFieldLayout(fields:DocumentFieldPresentation[]) {
  const records=(id:string)=>fields.filter(f=>f.fieldId===id).flatMap(f=>f.signatureRecords?.records??[]);
  const signer=records('cgt_field_15'),witness=records('cgt_field_20'),guarantor=records('pg_field_12');
  const components:Record<string,{records:AutomaticSignatureRecord[];values:(r:AutomaticSignatureRecord)=>string[]}>={};
  for(const [ids,people] of [[['16','17','18','19'],signer],[['21','22','23'],witness]] as const) {
    ids.forEach((id,index)=>{components[`cgt_field_${id}`]={records:people,values:r=>index===0?[r.name?.value??'']:index===1?[r.address?.value??'']:index===2?[r.number?.value??'']:r.dates.map(d=>d.value)};});
  }
  [['13','name'],['14','number'],['15','address']].forEach(([id,key])=>{components[`pg_field_${id}`]={records:guarantor,values:r=>[r[key as 'name'|'number'|'address']?.value??'']};});
  // Review inputs are not extracted values from the bank's document checklist.
  const corporateDocument=fields.some(f=>f.fieldId.startsWith('cgt_'));
  const personalDocument=fields.some(f=>f.fieldId==='pg_field_12');
  const reviewInputs=new Set(['review_business_date','cgt_required','cgt_witness_signed','cgt_yes']);
  // Keep the source field's identity, clauses and anchors when the review-input
  // amount has no value. This display fallback never adopts a business fact.
  const sourceAmounts=fields.filter(f=>f.fieldId==='cgt_field_12' && hasValue(f));
  const emptyAmounts=new Set(fields.filter(f=>f.fieldId==='cgt_amount' && !f.humanRevisionId && !hasValue(f) && sourceAmounts.some(source=>sameSource(source,f))));
  const visible=fields.filter(f=>{
    if(corporateDocument&&reviewInputs.has(f.fieldId))return false;
    if(personalDocument&&!f.fieldId.startsWith('pg_field_'))return false;
    if(personalDocument&&['pg_field_13','pg_field_14','pg_field_15'].includes(f.fieldId))return false;
    if(f.humanRevisionId)return true;
    if(emptyAmounts.has(f))return false;
    if(f.fieldId==='cgt_field_12'&&fields.some(other=>other.fieldId==='cgt_amount' && sameSource(f,other) && !emptyAmounts.has(other)))return false;
    const group=components[f.fieldId];
    if(!group?.records.length)return true;
    const source=fields.find(other=>other.signatureRecords?.records.some(r=>r.id===group.records[0]!.id));
    if(source?.documentVersionId!==f.documentVersionId||source.parseRevision!==f.parseRevision)return true;
    const values=f.candidates.length?f.candidates.map(c=>c.displayValue??c.rawValue):f.rawValue?[f.rawValue]:[];
    // Missing values remain visible until every source person has this component.
    return !group.records.every(r=>group.values(r).some(Boolean)) || values.some(v=>!group.records.some(r=>group.values(r).some(value=>same(v,value))));
  }).map(f=>['cgt_amount','cgt_field_12'].includes(f.fieldId)?{...f,fieldLabel:'担保金额'}:f.fieldId==='cgt_limited'?{...f,fieldLabel:'是否无限额担保',candidates:f.candidates.map(c=>({...c,displayValue:guaranteeLimitLabel(c.normalizedValue)??guaranteeLimitLabel(c.rawValue)??c.displayValue}))}:labels[f.fieldId]?{...f,fieldLabel:labels[f.fieldId]!}:f);
  if(visible.some(f=>f.fieldId==='pg_field_22')){
    const law=visible.find(f=>f.fieldId==='pg_field_24');
    if(law){
      const rest=visible.filter(f=>f.fieldId!=='pg_field_24'),position=rest.findIndex(f=>f.fieldId==='pg_field_22');
      rest.splice(position<0?rest.length:position,0,law);return rest;
    }
  }
  const moneyIds=new Set(['cgt_amount','cgt_field_12','cgt_currency','cgt_limited']);
  const money=visible.filter(f=>moneyIds.has(f.fieldId));
  if(!fields.some(f=>f.fieldId==='cgt_field_12')||!money.length)return visible;
  const rest=visible.filter(f=>!moneyIds.has(f.fieldId));
  const position=rest.findIndex(f=>f.fieldId==='cgt_field_13'||f.fieldId==='cgt_field_14');
  const moneyOrder=(id:string)=>id==='cgt_limited'?0:id==='cgt_currency'?2:1;
  rest.splice(position<0?rest.length:position,0,...money.sort((a,b)=>moneyOrder(a.fieldId)-moneyOrder(b.fieldId)));
  return rest;
}
