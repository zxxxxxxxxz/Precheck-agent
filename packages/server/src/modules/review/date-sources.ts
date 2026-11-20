import type {ChecklistRow,CrossFileValue} from '@hsbc/contracts/review-checklist';
import type {ReviewState} from '@hsbc/contracts/review';
import type {ChecklistInputDocument} from './checklist.js';
import {normalizeReviewValue} from './normalization.js';

/** Upload registration is immutable document metadata, not an extracted date. */
export function uploadBusinessDate(uploadedAt:string|undefined):string|null {
  if(!uploadedAt||!/^\d{4}-\d{2}-\d{2}T.*(?:Z|[+-]\d{2}:\d{2})$/u.test(uploadedAt))return null;
  const date=new Date(uploadedAt);
  return Number.isFinite(date.getTime())?new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Shanghai',year:'numeric',month:'2-digit',day:'2-digit'}).format(date):null;
}

export function uploadDateSource(document:ChecklistInputDocument):CrossFileValue {
  const date=uploadBusinessDate(document.uploadedAt);
  return {id:`${document.id}:upload-date`,fieldId:'review_business_date',label:'审核基准日（本文件上传日期，北京时间）',documentId:document.id,filename:document.filename,
    values:date?[date]:[],evidence:[],state:date?'available':'missing',warnings:date?[]:['未取得本文件的上传时间，不能用当前日期或其他文件日期替代。']};
}

export function reviewUploadDateSources(row:ChecklistRow,documents:ChecklistInputDocument[],state:ReviewState):CrossFileValue[] {
  const owner=state.objects.find(o=>o.objectId===row.objectId);
  return documents.filter(d=>d.adopted&&d.taxonomyIds.some(id=>row.materialTypes.some(t=>t.id===id))&&
    (!row.objectId||owner?.evidence.some(e=>e.documentVersionId===d.id&&e.parseRevision===d.parseRevision&&e.directoryRevision===d.directoryRevision))).map(uploadDateSource);
}

/** Override only the current reading projection, never saved verification or history. */
export function withUploadDateBaselines(rows:ChecklistRow[],documents:ChecklistInputDocument[],state:ReviewState):ChecklistRow[] {
  if(state.readOnly)return rows;
  return rows.map(row=>{
    if(row.fieldId!=='review_business_date')return row;
    const sources=reviewUploadDateSources(row,documents,state),available=sources.length>0&&sources.every(s=>s.state==='available');
    const definition='每份文件均以其上传日期（北京时间）为审核基准日。';
    return {...row,systemValue:{kind:'document_upload_date' as const,sources},verification:undefined,fact:null,candidates:[],unassignedCandidates:[],
      status:available?'confirmed' as const:'pending_confirmation' as const,definition,
      reason:available?'已根据对应文件的上传记录确定，无需手工填写。':'未取得对应文件的上传记录，暂时无法确定审核基准日。',
      rules:row.rules.map(rule=>({...rule,text:rule.text.replaceAll('采用审核快照日期。',definition)}))};
  });
}

/** Reduce within one authorization document only; never merge different resolutions. */
export function authorizationDateSources(row:ChecklistRow,documents:ChecklistInputDocument[],state:ReviewState):CrossFileValue[] {
  const owner=state.objects.find(o=>o.objectId===row.objectId);
  return documents.filter(d=>d.taxonomyIds.includes('cgt_resolution')&&d.authorizationSignatures&&
    (!row.objectId||owner?.evidence.some(e=>e.documentVersionId===d.id&&e.parseRevision===d.parseRevision&&e.directoryRevision===d.directoryRevision))).map(d=>{
    const {automatic,pages,sourceSha256}=d.authorizationSignatures!;
    const warnings:string[]=[];
    const signers=automatic.records.filter(r=>pages.includes(r.pageNumber)&&r.purpose!=='specimen'&&/\b(?:director|chair(?:man)?|shareholder)\b|董事|主席|股[东東]/iu.test(r.role?.value??''));
    const records=signers.filter(r=>r.purpose==='execution');
    if(signers.some(r=>r.purpose!=='execution'))warnings.push('部分签署记录的文书签署用途尚未明确，不能确定完整的最晚签署日。');
    const current=automatic.documentId===d.id&&automatic.parseRevision===d.parseRevision&&automatic.sourceSha256===sourceSha256;
    if(!current||!d.projectionCurrent||['failed','canceled','stale'].includes(d.state))warnings.push('签署信息与当前材料版本不一致或材料处理失败。');
    if(!pages.length||pages.some(p=>!automatic.coverage.processedPages.includes(p)||automatic.coverage.unavailablePages.includes(p)))warnings.push('授权文件签署信息覆盖不完整，请核对原文。');
    const dates=records.flatMap(record=>{
      const values=record.dates.filter(v=>['个人签署日期','日期','签署日期'].includes(v.label));
      const normalized=values.map(v=>normalizeReviewValue(v.value,'date'));
      if(record.uncertainText||!['graphic','handwriting'].includes(record.presence))warnings.push('部分签署文字或实际签字情况尚待核对。');
      if(!values.length||normalized.some(v=>v.status==='pending'||!v.value)||new Set(normalized.map(v=>v.value)).size!==1)warnings.push('部分签署人的日期缺失、不明确或存在冲突，不能确定完整的最晚签署日。');
      if(values.some(v=>!v.evidence.length||v.evidence.some(e=>e.documentVersionId!==d.id||e.parseRevision!==d.parseRevision||e.directoryRevision!==d.directoryRevision)))warnings.push('签署日期缺少当前版本的原文依据。');
      return values.map((v,i)=>({value:normalized[i]!.status!=='pending'?normalized[i]!.value:null,evidence:v.evidence}));
    });
    const latest=dates.flatMap(v=>v.value?[v.value]:[]).sort().at(-1);
    const advisory=!state.readOnly&&row.objectRole==='corporate_guarantee'?warnings.filter(w=>[
      '授权文件签署信息覆盖不完整，请核对原文。','部分签署文字或实际签字情况尚待核对。','签署日期缺少当前版本的原文依据。',
    ].includes(w)):[];
    const blocking=warnings.filter(w=>!advisory.includes(w));
    return {id:`${row.id}:${d.id}:signing-date`,fieldId:row.fieldId,label:'授权文件签署日（多人取最晚）',documentId:d.id,filename:d.filename,
      values:current&&latest?[latest]:[],evidence:current?dates.flatMap(v=>v.evidence):[],warnings:[...new Set(blocking)],extractionWarnings:[...new Set(advisory)],
      state:['pending','running','registered','queued','configuration_required'].includes(d.state)?'processing':blocking.length?'uncertain':latest?'available':'missing'};
  });
}
