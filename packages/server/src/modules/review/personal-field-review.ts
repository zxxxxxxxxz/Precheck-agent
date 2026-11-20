import {PERSONAL_FIELDS,personalLegalItem} from '@hsbc/contracts/personal-requirements';
import type {FieldReviewItem} from '@hsbc/contracts/field-verification';
import type {ChecklistRow,CrossFileCheck,CrossFileValue} from '@hsbc/contracts/review-checklist';
import type {ReviewConfigManifest} from '@hsbc/contracts/review-config';
import type {DB} from '../../infrastructure/database/client.js';
import {fieldReviewOriginalReader} from './field-review-original.js';
import {normalizeReviewValue} from './normalization.js';
import {personalBankVerification} from './personal-bank-verification.js';
import {personalSourceVerification} from './personal-source-verification.js';

const key=(v:string)=>v.normalize('NFKC').trim().replace(/\s+/gu,' ').toUpperCase();
const roles:Record<string,string[]>={
  'personal-bank':['贷款人','貸款人','贷款银行','Lender','Lending Bank'],
  'personal-borrower':['借款人','主债务人','主債務人','Borrower','Principal Debtor'],
  'personal-guarantor':['担保人','擔保人','保证人','保證人','Guarantor'],
};
function comparedValue(check:CrossFileCheck,source:CrossFileValue,value:string):string|undefined {
  if(source.fieldId!=='pg_facility_parties')return value;
  const names=Object.entries(roles).find(([id])=>check.id.endsWith(':'+id))?.[1];
  if(!names)return;
  const matches=[...value.matchAll(/(?:^|[;；\n])\s*([^:：;；\n]+)\s*[:：]\s*([^;；\n]+)/gu)].filter(m=>names.some(n=>key(n)===key(m[1]!)));
  return matches.length===1?matches[0]![2]!.trim():undefined;
}
function comparisonMeaning(check:CrossFileCheck,values:Array<{fieldId:string;value:string}>):FieldReviewItem['meaning'] {
  if(check.id.endsWith(':personal-identity'))return 'pending';
  const amount=check.id.endsWith(':personal-note');
  const dates=values.every(v=>['pg_field_10','pg_field_18','pg_field_27'].includes(v.fieldId));
  if(check.method==='manual'&&!amount)return 'pending';
  if(amount||dates){
    const parsed=values.map(v=>({...v,n:normalizeReviewValue(v.value,amount?'amount':'date')}));
    if(parsed.some(v=>v.n.status==='pending'||v.n.value===null))return 'pending';
    if(check.method==='date_order'){
      const groups=check.fieldIds.map(id=>[...new Set(parsed.filter(v=>v.fieldId===id).map(v=>v.n.value!))]);
      return groups.length===2&&groups.every(v=>v.length===1)?groups[0]![0]!<=groups[1]![0]!?'consistent':'different':'pending';
    }
    return new Set(parsed.map(v=>JSON.stringify([v.n.value,v.n.currency]))).size===1?'consistent':'different';
  }
  // Text differences need meaning review; exact text equality is reproducible.
  return new Set(values.map(v=>key(v.value))).size===1?'consistent':'pending';
}

/** Server-generated records: no client verdict, fabricated quote or object inference. */
export async function personalFieldReviewItems(db:DB,rows:ChecklistRow[],manifest:ReviewConfigManifest,names:Record<string,string>={}):Promise<FieldReviewItem[]> {
  const sourceOriginal=fieldReviewOriginalReader(db,{independentText:true}),original=fieldReviewOriginalReader(db),items:FieldReviewItem[]=[];
  for(const row of rows.filter(r=>r.objectRole==='personal_guarantee'&&(PERSONAL_FIELDS.some(f=>f.id===r.fieldId)||personalLegalItem(r.fieldId)))){
    if(row.fact?.validity==='current'&&row.fact.state==='not_applicable'){items.push(await personalSourceVerification(db,row,manifest,sourceOriginal));continue;}
    if(row.crossChecks?.some(c=>c.bankRule)){
      const bank=await personalBankVerification(db,row,names);
      items.push(bank);continue;
    }
    if(!row.crossChecks?.length){items.push(await personalSourceVerification(db,row,manifest,sourceOriginal));continue;}
    const item:FieldReviewItem={rowId:row.id,fieldId:row.fieldId,objectId:row.objectId,meaning:'pending',scope:'cross_file',reason:'尚无完整的字段核对依据。',actions:[],sources:[]};
    if(row.fact?.validity==='current'&&row.fact.state==='not_applicable'){
      items.push({...item,meaning:'not_applicable',reason:'本项已有当前有效的不适用决定。'});continue;
    }
    const checks=row.crossChecks??[],decisions:FieldReviewItem['meaning'][]=[];
    for(const [index,check] of checks.entries()){
      if(check.outcome==='not_applicable'){decisions.push('not_applicable');continue;}
      const sources:FieldReviewItem['sources']=[],values:Array<{fieldId:string;value:string}>=[];
      let complete=check.sources.length>0;
      for(const source of check.sources){
        if(!source.documentId||source.state!=='available'||source.warnings.length||!source.values.length){complete=false;continue;}
        for(const raw of source.values){
          const value=comparedValue(check,source,raw);
          if(!value||value.length>8000){complete=false;continue;}
          let found=false;
          for(const evidence of source.evidence){
            const quote=(await original(evidence)).find(q=>q.quote.includes(value)&&q.quote.length<=16000);
            if(!quote)continue;
            sources.push({filename:source.filename,page:quote.page,evidence,kind:'original',comparisonKey:`comparison-${index}`,quote:quote.quote,value,highlights:[]});
            values.push({fieldId:source.fieldId,value});found=true;break;
          }
          if(!found)complete=false;
        }
      }
      const documents=new Set(sources.map(s=>s.evidence.documentVersionId));
      let meaning:FieldReviewItem['meaning']='pending';
      if(complete&&documents.size>=2){
        meaning=comparisonMeaning(check,values);
        const semantic=check.semantic;
        if(meaning==='pending'&&check.method==='text'&&semantic?.state==='complete'&&!semantic.simulated&&['consistent','different'].includes(semantic.outcome)){
          let covered=true;
          for(const source of sources){
            const citations=semantic.citations.filter(c=>c.evidence.some(e=>JSON.stringify(e)===JSON.stringify(source.evidence)));
            if(!citations.length){covered=false;break;}
            if(!(await original(source.evidence)).some(q=>citations.some(c=>q.quote.includes(c.quote)))){covered=false;break;}
          }
          if(covered)meaning=semantic.outcome as 'consistent'|'different';
        }
      }
      // A single-field extraction can be checked against its original, but this
      // does not satisfy a missing cross-file counterpart or a manual recipe.
      if(complete&&documents.size===1&&checks.length===1&&check.fieldIds.length===1&&
        manifest.fields.find(f=>f.id===row.fieldId)?.recipe.mode!=='manual'&&
        !/签署|簽署|签字|簽字|签名|簽名|盖章|蓋章/u.test(row.label)){
        item.scope='source_check';
        sources.forEach((source,i)=>source.comparisonKey=`source-${i}`);
        sources.push(...sources.map(s=>({...s,kind:'extraction' as const})));
        meaning='consistent';
      }
      decisions.push(meaning);item.sources.push(...sources);
      if(meaning==='pending')item.actions.push(!complete?'请补齐本项对应材料、明确字段值及可定位原文。':check.manualReasons[0]??'请核对文字差异的含义及业务适用条件。');
      if(meaning==='different')item.actions.push('对应字段取值或原文含义存在差异，请核对并处理。');
    }
    item.meaning=decisions.includes('different')?'different':decisions.length&&decisions.every(d=>d==='not_applicable')?'not_applicable':decisions.length&&decisions.every(d=>['consistent','not_applicable'].includes(d))?'consistent':'pending';
    if(item.sources.length>40){item.sources=item.sources.slice(0,40);item.meaning='pending';item.actions.push('本项来源超过单次核对范围，请分项核对。');}
    item.reason=item.meaning==='not_applicable'?'当前已确认的条件表明本项不适用。':item.meaning==='different'?'已核验的对应取值或原文含义存在差异。':item.meaning==='consistent'?
      item.scope==='source_check'?'提取值已与其固定版本原文逐项核对。':'对应取值已与固定版本原文核验，并完成字段对照。':'本项核对尚未完整，保留已核验原文及待处理事项。';
    if(!row.objectId)item.actions.push('材料归属尚未确认；字段对照不代表已确认担保人身份。');
    item.actions=[...new Set(item.actions.map(action=>action.slice(0,1500)))].slice(0,15);
    if(item.meaning==='pending'&&!item.actions.length)item.actions.push(row.reason);
    items.push(item);
  }
  return items;
}
