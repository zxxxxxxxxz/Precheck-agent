import type {ChecklistRow} from '@hsbc/contracts/review-checklist';
import type {ReviewConfigManifest} from '@hsbc/contracts/review-config';
import type {FieldReviewItem} from '@hsbc/contracts/field-verification';
import type {DB} from '../../infrastructure/database/client.js';
import {fieldReviewOriginalReader,originalContains} from './field-review-original.js';

/** Verify an extracted observation, never infer legal sufficiency, applicability,
 * a signature, or an unassigned person's identity from a matching quotation. */
export async function personalSourceVerification(db:DB,row:ChecklistRow,manifest:ReviewConfigManifest,original=fieldReviewOriginalReader(db,{independentText:true})):Promise<FieldReviewItem>{
 const item:FieldReviewItem={rowId:row.id,fieldId:row.fieldId,objectId:row.objectId,scope:'source_check',meaning:'pending',reason:'本项尚待核对。',actions:[],sources:[]};
 const field=manifest.fields.find(f=>f.id===row.fieldId),sources=row.sourceValues??[];
 if(row.fact?.validity==='current'&&row.fact.state==='not_applicable')return {...item,meaning:'not_applicable',reason:'本项已有当前有效的不适用决定。'};
 const derivedAmounts:Record<string,string>={pg_guarantee_currency:'保证书金额',pg_note_currency:'本票金额',pg_required_currency:'用户要求的担保金额'};
 if(derivedAmounts[row.fieldId])return {...item,reason:'本项由已确认金额的币种生成。',actions:[`请先确认${derivedAmounts[row.fieldId]}及其币种；系统据此生成本项，不单独修改币种。`]};
 if(row.fieldId==='pg_verified_identity_number')return {...item,reason:'本项由已确认的证件号码及担保人对应关系生成。',actions:['先确认身份证明对应的担保人及证件号码；系统据此提供用于比较的号码。']};
 const manual=field?.recipe.mode==='manual'||!field;
 const stale=!!row.objectId&&row.status==='uncertain';
 let complete=!!sources.length&&!manual&&!stale;
 for(const source of sources){
  if(!source.documentId||(!source.originalEligible&&(source.state!=='available'||source.warnings.length))||!source.values.length){
   complete=false;
   item.actions.push(source.state==='processing'?`${source.filename}：等待「${source.label}」处理完成。`:
    source.state==='missing'?`${source.filename}：缺少「${source.label}」的对应材料或原文取值。`:
    source.state==='pending_confirmation'?`请确认「${source.label}」的业务适用条件或采用值。`:
    `${source.filename}：${source.warnings.join('；')||'本项原文依据尚不可靠。'}`);
   continue;
  }
  for(const value of source.values){
   let found=false;
   for(const evidence of source.evidence){
    const quote=(await original(evidence)).find(q=>originalContains(q.quote,value)&&q.quote.length<=16000&&(!q.corroboratingQuotes||q.corroboratingQuotes.some(text=>originalContains(text,value))));
    if(!quote||!value.trim()||value.length>8000)continue;
    const comparisonKey=`source-${item.sources.length}`;
    item.sources.push({filename:source.filename,page:quote.page,evidence,kind:'original',comparisonKey,quote:quote.quote,value,highlights:[]});found=true;break;
   }
   if(!found){complete=false;item.actions.push(`${source.filename}：「${source.label}」的部分取值不能逐字定位到当前版本原文，请核实提取及拼接。`);}
  }
 }
 if(manual)item.actions.push(...row.rules.map(rule=>rule.text),`「${row.label}」属于业务确认项，须按具体适用条件确认。`);
 if(stale)item.actions.push('现有对象或取值依据存在疑问，请核实当前范围后再保存确认。');
 if(complete&&item.sources.length&&item.sources.length<=20){
  item.meaning='consistent';item.reason='本项提取值已逐项核验当前版本原文；此记录确认原文取值，不代替法律效力、主体归属或业务适用性判断。';
  item.sources.push(...item.sources.map(source=>({...source,kind:'extraction' as const})));
 }else{
  item.reason=manual?'本项需要确认具体业务条件。':'本项原文核验尚未完成，具体原因见待办。';
  if(item.sources.length>20){item.sources=item.sources.slice(0,20);item.actions.push('本项原文片段较多，请分项核对后保存。');}
  if(!item.actions.length)item.actions.push(`请补齐「${row.label}」的取值及可定位的当前版本原文。`);
 }
 item.actions=[...new Set(item.actions)].map(s=>s.slice(0,1500)).slice(0,15);
 return item;
}
