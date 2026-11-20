import type {FieldReviewItem} from '@hsbc/contracts/field-verification';
import type {ChecklistRow} from '@hsbc/contracts/review-checklist';
import {crossFileSourceReading} from '@hsbc/contracts/personal-bank-comparison';
import type {DB} from '../../infrastructure/database/client.js';
import {fieldReviewOriginalReader,originalContains} from './field-review-original.js';

/** Persist the bank-row projection, never run a second set of business rules. */
export async function personalBankVerification(db:DB,row:ChecklistRow,names:Record<string,string>):Promise<FieldReviewItem>{
 const original=fieldReviewOriginalReader(db),dateOriginal=fieldReviewOriginalReader(db,{personalDate:true});
 const item:FieldReviewItem={rowId:row.id,fieldId:row.fieldId,objectId:row.objectId,scope:'bank_rule',meaning:'pending',reason:'本项无银行原表核对结果。',actions:[],sources:[]};
 const decisions:FieldReviewItem['meaning'][]=[];
 for(const check of row.crossChecks??[]){
  if(!check.bankRule)continue;
  let grounded=true;
  const manual=new Set(check.sources.filter(s=>s.id.endsWith(':fact')).map(s=>s.fieldId));
  for(const source of check.sources.filter(s=>!manual.has(s.fieldId)||s.id.endsWith(':fact'))){
   // Row 7 explicitly uses the user's requirement, not a quotation from a file.
   // Its current manual fact is checked by personalBankChecks and pinned in basis.
   if(check.bankRule.row===7&&source.fieldId==='pg_required_amount'&&source.id.endsWith(':fact'))continue;
   if(source.state!=='available'&&!(source.id.endsWith(':fact')&&row.fact?.state==='expected_blank'))continue;
   // Ground the explicit lender/guarantor/borrower role used by rows 4–6, not
   // unrelated parties bundled into a legacy facility extraction.
   const values=[4,5,6].includes(check.bankRule.row)?crossFileSourceReading(check,source).values:source.values;
   if([4,5,6].includes(check.bankRule.row)&&!values.length)grounded=false;
   for(const value of values.length?values:['']){
    let found=false;
    for(const evidence of source.evidence){
     const quote=(await (source.fieldId==='pg_field_27'&&source.personalWorkbookReading?.kind==='date'?dateOriginal:original)(evidence)).find(q=>(source.personalScalarReading||source.personalWorkbookReading?originalContains(q.quote,value):q.quote.includes(value))&&q.quote.length<=16000);
     const filename=names[evidence.documentVersionId];
     if(!quote||!filename||value.length>8000)continue;
     item.sources.push({filename,page:quote.page,evidence,kind:'original',comparisonKey:check.id,quote:quote.quote,value,highlights:[]});found=true;break;
    }
    if(!found)grounded=false;
   }
  }
  const meaning=check.outcome==='not_applicable'?'not_applicable':grounded&&['consistent','different'].includes(check.outcome)?check.outcome as 'consistent'|'different':'pending';
  decisions.push(meaning);
  item.actions.push(`${check.bankRule.reference}：${check.reason}`);
  if(!grounded)item.actions.push('部分采用值尚不能定位到对应原文，请核对来源；不是要求重新提交材料。');
 }
 item.meaning=decisions.includes('different')?'different':decisions.length&&decisions.every(d=>d==='not_applicable')?'not_applicable':decisions.length&&decisions.every(d=>d==='consistent'||d==='not_applicable')?'consistent':'pending';
 item.reason=item.meaning==='different'?'本项银行核对发现差异，请按各条要求处理。':item.meaning==='consistent'?'本项已按所列银行要求核对。':item.meaning==='not_applicable'?'本项银行要求的适用条件不成立。':'本项仍有银行要求或对应取值尚待核对，具体原因见待办。';
 if(item.sources.length>40){item.sources=item.sources.slice(0,40);item.meaning='pending';item.reason='本项原文超出单次保存范围，请分项核对。';}
 item.actions=[...new Set(item.actions)].map(s=>s.slice(0,1500)).slice(0,15);
 return item;
}
