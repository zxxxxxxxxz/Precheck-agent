import type {CrossFileValue} from '@hsbc/contracts/review-checklist';

const key=(v:string)=>v.normalize('NFKC').trim().replace(/\s+/gu,' ').toUpperCase();
const nameRows=new Set([5,13,31,34]);
/** Compare complete name sets, not the first person in a multi-guarantor file.
 * Language variants and compound clauses are left to grounded semantic analysis. */
export function personalComparisonValues(number:number,source:CrossFileValue):string[]|undefined{
  let values=source.values;
  if(source.fieldId==='pg_facility_parties'){
    const roles=number===4?/^(贷款人|貸款人|贷款银行|Lender|Lending Bank)$/iu:number===6?/^(借款人|主债务人|主債務人|Borrower|Principal Debtor)$/iu:/^(担保人|擔保人|保证人|保證人|Guarantors?)$/iu;
    values=values.flatMap(value=>[...value.matchAll(/(?:^|[;；\n])\s*([^:：;；\n]+)\s*[:：]\s*([^;；\n]+)/gu)].filter(m=>roles.test(m[1]!.trim())).map(m=>m[2]!));
    if(!values.length)return;
  }
  if(nameRows.has(number)){
    values=values.flatMap(v=>v.split(/[、;；\n]+/u)).map(v=>v.trim()).filter(Boolean);
    // Do not treat free prose, conditional arrangements, or a whole identity
    // paragraph as a name. No transliteration or same-person inference.
    if(values.some(v=>!v||v.length>100||/[：:。!?！？]|担保|擔保|保证|保證|出具|如果|若|\b(?:if|guarantee|provided)\b/iu.test(v)))return;
  }
  if([26,32].includes(number)){
    values=values.map(value=>{
      const v=key(value).replace(/[。.]$/u,'');
      const match=v.match(/^(?:本(?:保證書|保证书|授權書|授权书|本票)(?:應|应)?依)([^。；;]+?)法律(?:解釋|解释)$/u);
      return match?key(match[1]!):v;
    });
  }
  return [...new Set(values.map(key))].sort();
}

export function personalTextEqual(number:number,fields:string[],groups:CrossFileValue[][]):boolean{
  const values=groups.map(group=>{
    const parts=group.map(source=>personalComparisonValues(number,source));
    return parts.some(v=>!v)?undefined:[...new Set(parts.flatMap(v=>v!))].sort();
  });
  return fields.length===values.length&&values.length>1&&values.every(v=>v?.length)&&values.every(v=>JSON.stringify(v)===JSON.stringify(values[0]));
}
