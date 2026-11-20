import type {ChecklistRow,CrossFileValue} from '@hsbc/contracts/review-checklist';
import type {ReviewState} from '@hsbc/contracts/review';
import type {ReviewConfigManifest} from '@hsbc/contracts/review-config';
import {PERSONAL_WORKBOOK_SHA256} from '@hsbc/contracts/personal-requirements';
import type {DB} from '../../infrastructure/database/client.js';
import {personalSourceReviewer} from './personal-source-review.js';
import {personalBankChecks} from './personal-bank-checks.js';
import {semanticEligible} from './cross-file-semantics.js';

/** One read-only preparation for entry, semantic jobs, saving and pre-review.
 * Recover only the current cited text; never adopt identities or rewrite receipts. */
export async function preparePersonalChecklist(db:DB,rows:ChecklistRow[],manifest:ReviewConfigManifest,state:ReviewState):Promise<ChecklistRow[]>{
  if(state.readOnly||!rows.some(row=>row.objectRole==='personal_guarantee'))return rows;
  const reader=personalSourceReviewer(db),cache=new Map<string,Promise<CrossFileValue>>();
  const recover=(source:CrossFileValue)=>{
    const key=JSON.stringify(source);
    if(!cache.has(key))cache.set(key,(async()=>{
      if(source.state!=='uncertain'||!source.originalComparisonEligible)return source;
      const quotes=await reader.grounded(source);
      return quotes?.length?{...source,state:'available' as const,warnings:[],resolvedQuality:{warnings:source.warnings,originalValues:source.values,reason:'已逐项核对当前原文；仅用于内容比较。'}}:source;
    })());
    return cache.get(key)!;
  };
  const prepared=await Promise.all(rows.map(async row=>row.objectRole!=='personal_guarantee'?row:{...row,
    sourceValues:await Promise.all((row.sourceValues??[]).map(recover))}));
  return prepared.map(row=>{
    if(row.objectRole!=='personal_guarantee')return row;
    const checks=personalBankChecks(row,prepared,manifest,state,related=>related.sourceValues??[]);
    const ids=new Set(checks.map(check=>check.id));
    return {...row,crossChecks:[...checks.map(check=>({...check,semanticEligible:
      manifest.sources.some(s=>s.id===`pg_rule_source_${check.bankRule!.row}`&&s.sha256===PERSONAL_WORKBOOK_SHA256)&&!['consistent','not_applicable'].includes(check.outcome)&&check.semanticEligible===true&&semanticEligible(check,manifest)})),...(row.crossChecks??[]).filter(check=>!ids.has(check.id))]};
  });
}
