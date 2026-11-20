import type {FieldReviewItem} from '@hsbc/contracts/field-verification';
import type {DB} from '../../infrastructure/database/client.js';
import {annualReturnIssueDate} from '../documents/annual-return-source.js';
import {bottom,directorFormLines,directorNoticeLayout,formFold,lineLabel} from '../documents/director-notice-source.js';
import {normalizeDate} from './normalization.js';

/** Resolve a reviewed DD/MM/YYYY selection only from the original form's
 * explicitly labelled columns. Call after verifying the saved quote and pins. */
export async function reviewedFormDate(db:DB,fieldId:string,source:FieldReviewItem['sources'][number]):Promise<string|null>{
 if(!['cgt_field_48','cgt_field_55','cgt_field_59'].includes(fieldId)||!source.evidence.anchorId)return null;
 const digits=source.value.trim().split(/[\s/.-]+/u);
 if(digits.length!==3||!/^\d{1,2}$/u.test(digits[0]!)||!/^\d{1,2}$/u.test(digits[1]!)||!/^\d{4}$/u.test(digits[2]!))return null;
 const page=(await db.query('SELECT body FROM business.document_pages WHERE job_id=$1 AND page_number=$2',[source.evidence.parseRevision,source.page])).rows[0]?.body;
 if(!page||page.processing?.ocrSimulated||page.scope?.documentVersionId!==source.evidence.documentVersionId||page.scope?.parseRevision!==source.evidence.parseRevision)return null;
 const iso=normalizeDate(`${digits[2]}-${digits[1]}-${digits[0]}`).value;if(!iso)return null;
 if(fieldId==='cgt_field_48'){
  const ocr=page.regions.filter((r:any)=>r.source==='pp_ocr');
  const result=annualReturnIssueDate(directorFormLines({...page,regions:ocr.length?ocr:page.regions.filter((r:any)=>r.source==='native_pdf')}));
  return result?.iso===iso?iso:null;
 }
 const layout=directorNoticeLayout(page);if(!layout||layout.protectedSheet)return null;
 const kind=fieldId==='cgt_field_55'?'cessation':'appointment',dates:string[]=[];
 for(const section of layout.sections.filter(s=>s.kind===kind)){
  const own=layout.lines.filter(l=>l.box.y>=section.top&&l.box.y<section.end);
  const label=own.find(l=>lineLabel(l,kind==='cessation'?['停任日期','Date of Cessation']:['委任日期','Date of Appointment']));if(!label)continue;
  const parts=own.filter(l=>/^\d{1,4}$/u.test(l.text)&&l.box.x>label.box.x+label.box.width&&Math.abs(l.box.y-label.box.y)<label.box.height*1.8).sort((a,b)=>a.box.x-b.box.x);
  const dedup=parts.filter((l,i)=>!parts.slice(0,i).some(p=>p.text===l.text&&Math.abs(p.box.x-l.box.x)<10));if(dedup.length!==3)continue;
  const units=own.filter(l=>l.box.y>=Math.min(...dedup.map(l=>bottom(l.box)))-3&&l.box.y<Math.max(...dedup.map(l=>bottom(l.box)))+label.box.height*2);
  if(!dedup.every((p,i)=>units.some(u=>Math.abs(u.box.x-p.box.x)<label.box.height*2&&[ /dd/u,/mm/u,/yyyy/u ][i]!.test(formFold(u.text)))))continue;
  const candidate=normalizeDate(`${dedup[2]!.text}-${dedup[1]!.text}-${dedup[0]!.text}`).value;if(candidate)dates.push(candidate);
 }
 return dates.length===1&&dates[0]===iso?iso:null;
}
