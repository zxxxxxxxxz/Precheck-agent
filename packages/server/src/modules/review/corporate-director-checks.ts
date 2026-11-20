import type {CorporateCheckContext,CorporateSource} from './corporate-check-sources.js';
import {corporateNameKey,uniqueSources} from './corporate-check-sources.js';
import type {CorporateCheckResult} from './corporate-material-checks.js';
import {directorFormLines,directorNoticeLayout,formFold,bottom} from '../documents/director-notice-source.js';
import {normalizeDate} from './normalization.js';
import {createHash} from 'node:crypto';
import type {ReviewEvidence} from '@hsbc/contracts/review';
import type {CorporatePage} from './corporate-check-sources.js';
import {CORPORATE_WORKBOOK_SHA256} from '@hsbc/contracts/corporate-requirements';

export type DirectorRecord={names:string[];identity:string|null;page:number};
export type DirectorChange={kind:'appointment'|'cessation';names:string[];date:string;role:'director'|'secretary'|'unknown';page:number};
const same=(a:string,b:string)=>corporateNameKey(a)===corporateNameKey(b);
export function directorNameAliases(value:string):string[]{
 const chinese=value.match(/[\p{Script=Han}·]+/gu)?.join(''),english=value.match(/[A-Za-z][A-Za-z .'’-]*/gu)?.join(' ');
 return [chinese,english].filter((s):s is string=>!!s?.trim()).map(s=>s.trim());
}

/** Consume the pinned form reader's pixel-backed checkbox receipt. The image
 * hash, exact rectangle, label, page and appointment/cessation section all agree;
 * a printed Director option or an arbitrary extraction candidate is insufficient. */
export function corporateCapacityReceipt(p:CorporatePage,kind:'appointment'|'cessation'):{role:'director'|'secretary';source:CorporateSource;evidence:ReviewEvidence}|undefined{
 const fieldId=kind==='appointment'?'cgt_field_57':'cgt_field_52';
 if(p.document.invalidFieldIds?.includes(fieldId))return;
 const candidates=p.document.fields.filter(f=>f.fieldId===fieldId&&f.documentVersionId===p.document.id&&f.parseRevision===p.document.parseRevision).flatMap(f=>f.candidates)
  .filter(c=>c.pageNumbers.length===1&&c.pageNumbers[0]===p.number);
 if(candidates.length!==1)return;
 const candidate=candidates[0]!,value=candidate.rawValue?.trim(),role=/^(?:董事|Director)$/iu.test(value??'')?'director':/^(?:公司秘[書书]|Company Secretary)$/iu.test(value??'')?'secretary':undefined;
 if(!role)return;
 const layout=directorNoticeLayout(p.page);if(!layout||layout.protectedSheet)return;
 const selected=p.anchors.filter(a=>candidate.anchorIds.includes(a.anchor_id)&&a.document_version_id===p.document.id&&a.parse_revision===p.document.parseRevision&&a.page_number===p.number&&a.page_asset_id===p.page.page.page_asset_id);
 const image=selected.find(a=>a.evidence_kind==='image_region'&&a.localization_source==='nd2a-source-fields-v1'&&a.reason==='closed_checkbox_interior_ink');
 if(!image||image.polygons.length!==1||image.polygons[0]!.length!==4)return;
 const points=image.polygons[0]!,xs=points.map(p=>p[0]),ys=points.map(p=>p[1]);
 const box={x:Math.min(...xs),y:Math.min(...ys),width:Math.max(...xs)-Math.min(...xs),height:Math.max(...ys)-Math.min(...ys)};
 if(box.x<0||box.y<0||box.width<10||box.height!==box.width||box.width>42||box.x+box.width>p.page.page.width||box.y+box.height>p.page.page.height||
  image.anchor_id!==`nd2a-checkbox:${createHash('sha256').update(JSON.stringify([p.page.imageSha256,box])).digest('hex').slice(0,32)}`)return;
 const line=layout.lines.find(l=>l.text.trim()===value&&selected.some(a=>a.evidence_kind==='text'&&a.block_ids.includes(l.region.region_id))&&l.box.x>box.x+box.width&&l.box.x-box.x-box.width<l.box.height*3.2&&Math.abs(l.box.y-box.y)<l.box.height);
 const section=line&&layout.sections.find(s=>s.kind===kind&&line.box.y>s.top&&bottom(line.box)<s.end);
 const anchor=line&&selected.find(a=>a.evidence_kind==='text'&&a.block_ids.includes(line.region.region_id));if(!line||!section||!anchor)return;
 const pin={documentVersionId:p.document.id,parseRevision:p.document.parseRevision!,directoryRevision:p.document.directoryRevision!};
 return {role,source:{filename:p.document.filename,page:p.number,evidence:{...pin,anchorId:anchor.anchor_id},kind:'original',comparisonKey:'verified-form-capacity',quote:line.text,value:line.text,highlights:[]},evidence:{...pin,anchorId:image.anchor_id}};
}
/** Compare at the meeting date, not today. Changes already included in an
 * annual baseline are not replayed; later/future changes cannot alter that list. */
export function computeCorporateDirectorRoster(base:DirectorRecord[],baselineDate:string,meetingDate:string,changes:DirectorChange[],attendees:string[]){
 const roster=base.map(r=>({...r,names:[...r.names]})),problems:string[]=[],applied:DirectorChange[]=[],ignored:DirectorChange[]=[];
 if(baselineDate>meetingDate)return {roster,applied,ignored,problems:['周年申报表的结算日晚于会议日期，不能倒推会议当日董事名单。'],unmatched:attendees};
 for(const change of [...changes].sort((a,b)=>a.date.localeCompare(b.date)||a.kind.localeCompare(b.kind))){
  if(change.date<=baselineDate||change.date>meetingDate||change.role==='secretary'){ignored.push(change);continue;}
  if(changes.some(other=>other!==change&&other.date===change.date&&other.kind!==change.kind&&other.names.some(n=>change.names.some(m=>same(n,m))))){problems.push(`变更通知第 ${change.page} 页人员同日停任及委任，尚无明确先后顺序。`);continue;}
  if(change.role!=='director'){problems.push(`变更通知第 ${change.page} 页的人员身份尚不能归属为董事。`);continue;}
  const matching=roster.filter(r=>r.names.some(n=>change.names.some(c=>same(n,c))));
  if(matching.length>1){problems.push(`变更通知第 ${change.page} 页存在同名人员歧义。`);continue;}
  if(change.kind==='cessation'){
   if(!matching.length){problems.push(`变更通知第 ${change.page} 页停任人员不在基准名单中，请核对是否缺少中间任免记录。`);continue;}
   roster.splice(roster.indexOf(matching[0]!),1);
  }else{
   if(matching.length){problems.push(`变更通知第 ${change.page} 页的委任人员已在基准名单内，请核对任免顺序。`);continue;}
   roster.push({names:change.names,identity:null,page:change.page});
  }
  applied.push(change);
 }
 const unmatched=attendees.filter(a=>!roster.some(r=>r.names.some(n=>same(n,a))));
 return {roster,applied,ignored,problems,unmatched};
}

function annualBaseline(c:CorporateCheckContext):{date:string;sources:CorporateSource[]}|undefined{
 for(const p of c.pages.filter(p=>p.document.taxonomyIds.includes('cgt_annual'))){
  const lines=directorFormLines(p.page).filter(l=>l.region.source==='pp_ocr');
  const labels=lines.filter(l=>/^(?:datetowhichthisreturnismadeup|本申報表的結算日期|本申报表的结算日期)$/u.test(formFold(l.text)));
  for(const label of labels){
   const values=lines.filter(l=>/^\d{1,4}$/u.test(l.text)&&l.box.x>label.box.x+label.box.width&&Math.abs(l.box.y-label.box.y)<label.box.height*2).sort((a,b)=>a.box.x-b.box.x);
   const parts=values.filter((l,i)=>!values.slice(0,i).some(o=>o.text===l.text&&Math.abs(o.box.x-l.box.x)<10));
   if(parts.length!==3||!/^\d{4}$/u.test(parts[2]!.text))continue;
   const units=lines.filter(l=>l.box.y>=Math.min(...parts.map(l=>bottom(l.box)))-3&&l.box.y<Math.max(...parts.map(l=>bottom(l.box)))+label.box.height*2);
   if(!parts.every((l,i)=>units.some(u=>Math.abs(u.box.x-l.box.x)<label.box.height*2&&[/dd/u,/mm/u,/yyyy/u][i]!.test(formFold(u.text)))))continue;
   const date=normalizeDate(`${parts[2]!.text}-${parts[1]!.text}-${parts[0]!.text}`).value;
   const sources=[...p.sources.filter(s=>label.text.trim()===s.value.trim()),...parts.flatMap(l=>{const s=p.formNumber(l.region.region_id);return s?[s]:[];})];
   if(date&&parts.every(part=>sources.some(s=>s.value.trim()===part.text.trim())))return {date,sources};
  }
 }
}

/** Read the actual Present clause. Signers/authorised representatives are not
 * attendees. A negative "not present" sentence is excluded before matching. */
export function corporateAttendees(paragraph:string):string[]|undefined{
 const positive=/^\s*Present\s*:\s*([\s\S]*?)(?:\b(?:directors|director)\b\s*[.;]|$)/iu.exec(paragraph)?.[1];
 if(!positive||/\b(?:not|absent|except|proxy)\b/iu.test(positive))return;
 const names=positive.replace(/,?\s*(?:being\s+)?all\s+(?:current\s+)?$/iu,'').replace(/\([^)]*\)/gu,'').replace(/\b(?:Mr|Mrs|Ms|Dr)\.?\s+/gu,'').split(/\s+and\s+|\s*[;；]\s*/iu).map(s=>s.trim().replace(/[,，.]$/u,'')).filter(Boolean);
 return names.length&&names.every(n=>/^[\p{L}\s.'’-]{2,100}$/u.test(n))?names:undefined;
}

export async function corporateDirectorChecks(c:CorporateCheckContext,businessDate:string):Promise<Array<[number,string,CorporateCheckResult]>>{
 const names=c.values('cgt_field_44','cgt_annual'),ids=c.values('cgt_field_47','cgt_annual'),meeting=c.values('cgt_meeting_date','cgt_resolution');
 if(!names.length||!meeting.length)return [];
 const meetingDates=[...new Set(meeting.map(s=>normalizeDate(s.value).value).filter((s):s is string=>!!s))];
 if(meetingDates.length!==1||meetingDates[0]!>businessDate)return [];
 const base:DirectorRecord[]=[],sources:CorporateSource[]=[...names,...ids,...meeting];
 for(const name of names){
  const record=base.find(r=>r.page===name.page);
  if(record){record.names.push(...directorNameAliases(name.value));continue;}
  const ownIds=ids.filter(s=>s.page===name.page&&s.evidence.documentVersionId===name.evidence.documentVersionId);
  base.push({names:directorNameAliases(name.value),identity:ownIds.length===1?ownIds[0]!.value:null,page:name.page});
 }
 const changes:DirectorChange[]=[],sourceConflicts:string[]=[],pixelEvidence:ReviewEvidence[]=[];
 for(const kind of ['cessation','appointment'] as const){
  const fields=kind==='cessation'?['cgt_field_52','cgt_field_53','cgt_field_54','cgt_field_55']:['cgt_field_57','cgt_field_58','cgt_field_58','cgt_field_59'];
  const people=uniqueSources([...c.values(fields[1]!,'cgt_change'),...c.values(fields[2]!,'cgt_change')]);
  const role=c.values(fields[0]!,'cgt_change'),date=c.values(fields[3]!,'cgt_change');
  sources.push(...people,...role,...date);
  const groups=new Map<string,CorporateSource[]>();
  for(const person of people){const k=`${person.evidence.documentVersionId}:${person.page}`;groups.set(k,[...(groups.get(k)??[]),person]);}
  for(const group of groups.values()){
   const first=group[0]!,ownDate=date.filter(s=>s.page===first.page&&s.evidence.documentVersionId===first.evidence.documentVersionId);
   const ownRole=role.filter(s=>s.page===first.page&&s.evidence.documentVersionId===first.evidence.documentVersionId);
   const page=c.pages.find(p=>p.document.id===first.evidence.documentVersionId&&p.number===first.page);
   const layout=page?directorNoticeLayout(page.page):null;
   if(!layout?.sections.some(s=>s.kind===kind)){sourceConflicts.push(`变更通知第 ${first.page} 页的姓名没有对应的${kind==='appointment'?'委任':'停任'}栏目。`);continue;}
   // The date's DD/MM/YYYY columns were validated by the input bridge. Reuse
   // that normalized value only when the exact same selected evidence is linked.
   const effective=c.facts[fields[3]!];
   const normalizedDates=ownDate.map(()=>effective?.state==='present'&&typeof effective.value==='string'&&/^\d{4}-\d{2}-\d{2}$/u.test(effective.value)?effective.value:null);
   if(normalizedDates.length!==1||!normalizedDates[0]){sourceConflicts.push(`变更通知第 ${first.page} 页缺少同一人员的明确生效日期。`);continue;}
   const receipt=page&&c.values(fields[0]!,'cgt_change').length&&c.facts[fields[0]!]?.state==='present'?corporateCapacityReceipt(page,kind):undefined;
   if(receipt){sources.push(receipt.source);pixelEvidence.push(receipt.evidence);}
   const capacity=receipt?.role??(ownRole.length===1&&/^(?:董事|Director)$/iu.test(ownRole[0]!.value.trim())?'director':ownRole.length===1&&/^(?:公司秘[書书]|Company Secretary)$/iu.test(ownRole[0]!.value.trim())?'secretary':'unknown');
   if(capacity==='unknown')sourceConflicts.push(`委任／停任身份所引原文与第 ${first.page} 页人员不在同一记录，不能把其他页的“董事”身份用于此人；请核对本页身份勾选。`);
   changes.push({kind,names:group.flatMap(s=>directorNameAliases(s.value)),date:normalizedDates[0]!,role:capacity,page:first.page});
  }
 }
 const present=c.pages.filter(p=>p.document.taxonomyIds.includes('cgt_resolution')).flatMap(p=>p.sources.filter(s=>/^\s*Present\s*:/iu.test(s.value)));
 const attendees=present.length===1?corporateAttendees(present[0]!.value):undefined;
 if(!attendees)return [];
 sources.push(...present);
 const baseline=annualBaseline(c);
 if(!baseline)return [];
 sources.push(...baseline.sources);
 const calculation=computeCorporateDirectorRoster(base,baseline.date,meetingDates[0]!,changes,attendees);
 const issues=[...new Set([...sourceConflicts,...calculation.problems])];
 if(base.some(r=>!r.identity))issues.push('周年申报表中有董事未能关联同一记录的身份证号码，请补全或核对该人员记录。');
 if(calculation.unmatched.length)issues.push(`决议出席人员中有 ${calculation.unmatched.length} 人未能落入会议当日可确认的董事名单，需处理上述任免依据后核对。`);
 const result:CorporateCheckResult={status:issues.length?'confirm':'done',reason:`已按周年申报结算日和会议日期核对 ${base.length} 条董事记录、${changes.length} 条任免记录及 ${attendees.length} 名出席人员；已应用 ${calculation.applied.length} 条生效变更。${issues.length?issues.join('；'):'出席人员均在会议当日名单内。'} 身份证部分号码保留遮挡，不据此确认签署真实性。`,sources:uniqueSources(sources),ruleIds:['cgt_bank_55','cgt_bank_61','cgt_bank_62','cgt_field_56_required'],execution:{version:'corporate-director-roster-v1',referenceHashes:[CORPORATE_WORKBOOK_SHA256],evidence:pixelEvidence}};
 // One computation and one actionable cause, not three generic confirmations.
 const output:Array<[number,string,CorporateCheckResult]>=[[55,'cgt_field_44',result]];
 return output;
}
