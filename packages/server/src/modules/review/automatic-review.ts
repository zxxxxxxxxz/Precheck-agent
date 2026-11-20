import {corporateAutomaticReview} from './corporate-automatic-review.js';
import type {ChecklistRow} from '@hsbc/contracts/review-checklist';
import type {ReviewConfigManifest} from '@hsbc/contracts/review-config';
import type {DB} from '../../infrastructure/database/client.js';
/** Company checks; the existing personal automatic projection remains in ReviewService. */
export async function automaticReview(db:DB,rows:ChecklistRow[],manifest:ReviewConfigManifest,_names:Record<string,string>,revision:number,recordedAt:string){
 return corporateAutomaticReview(db,rows,manifest,revision,recordedAt);
}
