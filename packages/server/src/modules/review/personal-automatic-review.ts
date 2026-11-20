import type {ChecklistRow} from '@hsbc/contracts/review-checklist';
import type {ReviewConfigManifest} from '@hsbc/contracts/review-config';
import {fieldReviewStatus} from '@hsbc/contracts/field-verification';
import type {DB} from '../../infrastructure/database/client.js';
import {personalFieldReviewItems} from './personal-field-review.js';
import {fieldReviewHash} from './field-verification.js';

/** Read-only current-source projection. Never adopts a person/fact, writes an
 * audit event, overwrites a human receipt, or recalculates a frozen round. */
export async function personalAutomaticReview(db:DB,rows:ChecklistRow[],manifest:ReviewConfigManifest,names:Record<string,string>,caseRevision:number):Promise<ChecklistRow[]>{
 if(!manifest.guaranteeTypes.includes('personal_guarantee'))return rows;
 const items=await personalFieldReviewItems(db,rows.filter(row=>!row.verification||row.verification.scope==='source_check'&&row.crossChecks?.some(c=>c.bankRule)),manifest,names);
 const verified=new Map(items.map(item=>[item.rowId,item]));
 return rows.map(row=>{
  const item=verified.get(row.id);
  if(!item)return row;
  return {...row,...(row.verification?.scope==='source_check'?{sourceVerification:row.verification}:{}),verification:{...item,status:fieldReviewStatus(item),origin:'automatic' as const,recordId:`automatic:${fieldReviewHash(item)}`,recordedAt:null,caseRevision,validity:'current' as const,corrections:[]}};
 });
}
