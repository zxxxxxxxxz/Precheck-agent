import type {ChecklistInputDocument} from './checklist.js';
import {PERSONAL_CHECKLIST_ROWS,PERSONAL_CHECKLIST_INTRO,PERSONAL_CHECKLIST_SHA256,personalLegalItem} from '@hsbc/contracts/personal-requirements';
import type {ChecklistRow,CrossFileCheck,CrossFileValue} from '@hsbc/contracts/review-checklist';
import type {ReviewConfigManifest} from '@hsbc/contracts/review-config';
import type {DB} from '../../infrastructure/database/client.js';
import {fieldReviewOriginalReader,originalContains} from './field-review-original.js';

/** Legal opinion content checks are required by workbook F40. They are not a
 * second set of per-item human applicability switches or legal approval. */
export async function withPersonalLegalChecks(db:DB,rows:ChecklistRow[],manifest:ReviewConfigManifest,documents:ChecklistInputDocument[]=[]):Promise<ChecklistRow[]> {
 if(!manifest.guaranteeTypes.includes('personal_guarantee'))return rows;
 const original=fieldReviewOriginalReader(db,{independentText:true});
 const tableText=(text:string)=>text.replace(/<[^>]*>/gu,' ').replace(/\\n/gu,' ').replace(/&nbsp;/gu,' ');
 const matches=(quote:string,value:string)=>originalContains(quote,value)||originalContains(tableText(quote),tableText(value));
 const grounded=new Map<string,CrossFileValue[]>();
 async function readings(row:ChecklistRow){
  if(grounded.has(row.id))return grounded.get(row.id)!;
  const out:CrossFileValue[]=[];
  for(const source of row.sourceValues??[]){
   let complete=!!source.documentId&&!!source.values.length&&(source.originalEligible===true||source.state==='available'&&!source.warnings.length);
   const provenValues:string[]=[];
   const values=source.values.flatMap(v=>v.split(/\s+…\s+/u)),evidence:CrossFileValue['evidence']=[],passages:NonNullable<CrossFileValue['personalWorkbookReading']>['passages']=[];
   for(const value of values){
    let found=false;
    for(const ref of source.evidence){
     const quote=(await original(ref)).find(q=>value.trim()&&matches(q.quote,value)&&(!q.corroboratingQuotes||q.corroboratingQuotes.some(t=>matches(t,value))));
     if(!quote)continue;
     provenValues.push(originalContains(quote.quote,value)?value:quote.quote);evidence.push(ref);passages.push({text:quote.quote,evidence:ref});found=true;break;
    }
    if(!found)complete=false;
   }
   // Re-read the complete numbered inventory at its original anchors. OCR
   // alternates are retained in resolvedQuality, not promoted over proved text.
   if(!complete&&row.fieldId==='pg_legal_intro_3'&&source.originalEligible){
    const document=documents.find(d=>d.id===source.documentId&&d.projectionCurrent);
    const entries=source.values.map(value=>({value,number:/^\s*(\d+)[.、]/u.exec(value)?.[1],ids:value.match(/PG[0-9A-Z-]+/gu)??[],dates:(value.replace(/\s+/gu,'').match(/\d{4}年\d{1,2}月\d{1,2}日/gu)??[])}));
    const originals:Array<{text:string;evidence:CrossFileValue['evidence'][number]}>=[];
    if(document&&entries.every(e=>e.number))for(const page of document.readingPages??[])for(const anchor of document.readingAnchors??[]){
     if(anchor.page_number!==page.page.page_number||!anchor.block_ids.some(id=>page.regions.some(r=>r.region_id===id&&entries.some(e=>new RegExp('^\\s*'+e.number+'[.、]').test(r.raw_text??'')))))continue;
     const ref={documentVersionId:document.id,parseRevision:document.parseRevision!,directoryRevision:document.directoryRevision!,anchorId:anchor.anchor_id};
     for(const q of await original(ref))if(!q.corroboratingQuotes||q.corroboratingQuotes.some(t=>matches(t,q.quote)))originals.push({text:q.quote,evidence:ref});
    }
    const match=(entry:typeof entries[number],q:typeof originals[number])=>new RegExp('^\\s*'+entry.number+'[.、]').test(q.text)&&entry.ids.every(id=>q.text.includes(id))&&entry.dates.every(date=>q.text.replace(/\s+/gu,'').includes(date))&&(entry.ids.length>0||/附件.*核查摘要/u.test(entry.value)&&/附件.*核查摘要/u.test(q.text));
    if(entries.length&&entries.every(e=>originals.some(q=>match(e,q)))){
     const selected=originals.filter(q=>entries.some(e=>match(e,q)));
     provenValues.splice(0,provenValues.length,...new Set(selected.map(q=>q.text)));evidence.splice(0,evidence.length,...selected.map(q=>q.evidence));passages.splice(0,passages.length,...selected);complete=true;
    }
   }
   out.push(complete?{...source,state:'available',values:[...new Set(provenValues)],evidence:[...new Map(evidence.map(e=>[JSON.stringify(e),e])).values()],warnings:[],
    resolvedQuality:{warnings:source.warnings,originalValues:source.values,reason:'法律意见全部选定片段已在当前原文独立核实；保留限定条件，按银行清单核对文字内容。'},
    personalWorkbookReading:{kind:'legal',values,evidence,passages,reason:'法律意见条目原文定位'}}:source);
  }
  grounded.set(row.id,out);return out;
 }
 const result:ChecklistRow[]=[];
 for(const row of rows){
  if(row.fieldId==='pg_field_37'){
   const opinion=await readings(row);
   const exists=opinion.length>0&&opinion.every(s=>s.state==='available'&&s.documentId&&s.values.length);
   const referenceRow=rows.find(r=>r.fieldId==='pg_legal_intro_3'&&r.objectId===row.objectId);
   const references=referenceRow?await readings(referenceRow):[];
   const referenceText=references.filter(s=>s.state==='available').flatMap(s=>s.values).join('\n');
   const missing:string[]=[];
   if(documents.length&&/(?:审批|審批).*(?:通知|批复)/u.test(referenceText)&&!documents.some(d=>d.taxonomyIds.includes('pg_approval')))missing.push('法律意见书列出的授信及担保审批通知');
   if(documents.length&&/身份(?:及地址|证明|證明)|身份证明/u.test(referenceText)&&!documents.some(d=>d.taxonomyIds.includes('pg_identity')))missing.push('法律意见书列出的两位担保人身份及地址证明');
   const conditionRow=rows.find(r=>r.fieldId==='pg_legal_conditions'&&r.objectId===row.objectId);
   const conditions=conditionRow?await readings(conditionRow):[];
   result.push({...row,crossChecks:(row.crossChecks??[]).map(check=>{
    if(check.bankRule?.row===40&&exists)return {...check,sources:opinion,fieldIds:[row.fieldId],outcome:'consistent',reason:'已提供法律意见书，按银行原表的法律意见路径继续核对；律所批准资格、引用文件及不利条件分别见第 41–43 行。'};
    if(check.bankRule?.row===42&&missing.length)return {...check,sources:references,fieldIds:['pg_legal_intro_3'],outcome:'different',reason:'法律意见书称已审阅，但本案未提供：'+missing.join('；')+'。需补齐后再核对对应文件的日期、主体及版本。'};
    if(check.bankRule?.row===41)return {...check,reason:'需将意见出具律所及审查范围与银行批准名单核对；当前未提供可核验的银行批准律所名单或认可记录。'};
    if(check.bankRule?.row===43&&conditions.length&&conditions.every(s=>s.state==='available'))return {...check,method:'text',fieldIds:['pg_legal_conditions'],sources:conditions,semanticEligible:true,
      bankRule:{...check.bankRule,requirement:check.bankRule.requirement+' 本条任务是识别并列出这些条款与后续事项，不是对条款作业务批准；已准确列示时可判 consistent，并在 reason/limitations 保留事项。简洁列示，最多五项，每项不超过一百字；引用一至三个关键原文片段。'},
      reason:'相关条件已定位到原文，等待识别并列示银行要求关注的内容。'};
    return check;
   })});continue;
  }
  if(!personalLegalItem(row.fieldId)){result.push(row);continue;}
  const intro=/^pg_legal_intro_(\d+)$/u.exec(row.fieldId),index=Number((intro??/_(\d+)$/u.exec(row.fieldId))![1])-1;
  const rule=intro?PERSONAL_CHECKLIST_INTRO[index]:PERSONAL_CHECKLIST_ROWS[index];
  const sources=await readings(row),scopeRow=rows.find(r=>r.fieldId==='pg_field_37'&&r.objectId===row.objectId),scope=scopeRow?await readings(scopeRow):[];
  const complete=sources.length>0&&sources.every(s=>s.state==='available'&&!s.warnings.length&&s.values.length>0);
  const text=sources.flatMap(s=>s.values).join('\n');
  const companyExcluded=!intro&&[0,2,3,6].includes(index)&&/(?:係|系|為|为)自然人/u.test(text)&&/公司.*不適用|公司.*不适用/u.test(text);
  const noSecurity=!intro&&index===11&&/(?:^|[。；\n])本次(?:未設抵押、質押或其他財產擔保物權|未设抵押、质押或其他财产担保物权)/u.test(text);
  // This personal draft has no X legend. Do not import the corporate matrix's
  // interpretation to waive a personal requirement; review the supplied opinion.
  const pinned=manifest.sources.some(s=>s.sha256===PERSONAL_CHECKLIST_SHA256);
  const inactive=pinned&&complete&&(companyExcluded||noSecurity);
  const check:CrossFileCheck={id:`${row.id}:bank:legal`,label:row.label,objectId:row.objectId,fieldIds:[row.fieldId],method:'text',
   sources:sources.map(s=>s.personalWorkbookReading?{...s,personalWorkbookReading:{...s.personalWorkbookReading,passages:[...s.personalWorkbookReading.passages,...scope.flatMap(c=>c.personalWorkbookReading?.passages??[])]}}:s),semanticEligible:pinned&&complete&&scope.length>0&&scope.every(s=>s.state==='available')&&!inactive,
   outcome:inactive?'not_applicable':'manual',reason:inactive?companyExcluded?'原文明确本案义务人为自然人，公司设立、权能、公司授权或章程条目不适用于其个人义务。':'原文明确未设抵押、质押或其他财产担保物权，本条不适用。':!pinned?'银行 checklist 版本未核实。':complete?'已核实本条原文，等待按银行清单核对内容。':'本条部分原文仍不能可靠定位，保留缺项。',manualReasons:[],
   bankRule:{row:40,reference:`SRC-PG/规则校验!F40 → Legal Opinion Checklist/${intro?'正文段落 '+PERSONAL_CHECKLIST_INTRO[index]!.paragraph:'表格行 '+PERSONAL_CHECKLIST_ROWS[index]!.row}`,primaryFieldId:row.fieldId,
    requirement:rule!.text+(intro&&index===2?' 本案已提交文件名称（系统材料清单）：'+JSON.stringify(documents.map(d=>d.filename)):'')+' 仅检查所提供法律意见是否包含本条要求的明确意见、适用范围及保留；不重新认定法律效力或签署真伪。公司条目按自然人范围判断；个人清单未解释 X，不以 X 免除检查。Required if possible 为尽可能取得；不能把不适用当通过。',notice:'列出具体缺失、不一致或限定条件，不新增人工适用性开关。'}};
  result.push({...row,crossChecks:[check]});
 }
 return result;
}
