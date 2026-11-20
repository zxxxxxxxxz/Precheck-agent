import {pageIncorporationNumbers} from '../documents/incorporation-number.js';
import {validateAnchorSource} from '../../document/evidence.js';
import {pageIncorporationJurisdictions} from '../documents/incorporation-jurisdiction.js';
import type {ChecklistRow,CrossFileCheck,CrossFileValue} from '@hsbc/contracts/review-checklist';
import type {ReviewState} from '@hsbc/contracts/review';
import type {ChecklistInputDocument} from './checklist.js';
import {normalizeDate} from './normalization.js';
import {addressMeaningKey} from './address-equivalence.js';
import {corporateSignerSame} from './corporate-signature-checks.js';
import {compareCorporateRmClauses,corporateMeetingCheck} from './corporate-material-checks.js';
import {corporateConditionKind} from './corporate-pre-review-scope.js';
import {documentHtmlCellSpans} from '../../document/html-cells.js';
import type {ReviewFieldDefinition} from '@hsbc/contracts/review-config';
import {candidateAdoptionValue} from '@hsbc/contracts/documents';
import {fieldCandidateSelection} from './field-candidate-selection.js';

const unique=<T>(v:T[])=>[...new Set(v)];
const key=(v:string)=>v.normalize('NFKC').toUpperCase().replace(/[\s\p{P}]/gu,'');
const usable=(s:CrossFileValue)=>s.state==='available'&&s.values.length>0&&!s.warnings.length;
const values=(s:CrossFileValue[])=>s.filter(usable).flatMap(s=>s.values);
const datePattern=/\b\d{1,2}\s+(?:January|February|March|April|May|June|July|August|September|October|November|December)\s+\d{4}\b|\b\d{4}-\d{1,2}-\d{1,2}\b|\d{4}年\s*\d{1,2}月\s*\d{1,2}日/giu;
/** Date/Place is the resolution's own heading table, not a signature date or
 * a date mentioned in a referenced facility. Reject merged/ambiguous tables. */
export function resolutionHeadingDate(raw:string):string[]{
 if(!documentHtmlCellSpans(raw).length||/rowspan|colspan/iu.test(raw))return [];
 const table=[...raw.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/giu)].map(r=>[...r[1]!.matchAll(/<t[dh]\b[^>]*>([\s\S]*?)<\/t[dh]>/giu)].map(c=>c[1]!.replace(/<br\s*\/?>/giu,' ').trim()));
 if(table.length!==2||table[0]!.length!==table[1]!.length||!table[0]!.some(v=>/^(?:place|venue|地点|地點)$/iu.test(v)))return [];
 const index=table[0]!.findIndex(v=>/^(?:date|resolution date|会议日期|會議日期|决议日期|決議日期)$/iu.test(v));
 if(index<0)return [];
 return (table[1]![index]!.match(datePattern)??[]).flatMap(v=>{const n=normalizeDate(v);return n.value?[n.value]:[];});
}

/** Stay inside the current object's materials; unassigned files never borrow
 * another object's records. This is a reading projection, not attribution. */
export function corporateValueDocuments(row:ChecklistRow,documents:ChecklistInputDocument[],state:ReviewState,type:string){
 const owners=state.objects.filter(o=>o.kind==='guarantee'&&o.role===row.objectRole);
 const own=owners.find(o=>o.objectId===row.objectId);
 return documents.filter(d=>d.taxonomyIds.includes(type)&&(row.objectId?
  own?.evidence.some(e=>e.documentVersionId===d.id&&e.parseRevision===d.parseRevision&&e.directoryRevision===d.directoryRevision):
  !owners.some(o=>o.evidence.some(e=>e.documentVersionId===d.id))));
}
const current=(d:ChecklistInputDocument)=>d.projectionCurrent&&['ready','partial'].includes(d.state);
function signatureRecords(d:ChecklistInputDocument){
 const s=d.authorizationSignatures,a=s?.automatic;
 return current(d)&&s&&a?.documentId===d.id&&a.parseRevision===d.parseRevision&&a.sourceSha256===s.sourceSha256?
  a.records.filter(r=>s.pages.includes(r.pageNumber)):undefined;
}
function source(row:ChecklistRow,d:ChecklistInputDocument,v:string[],evidence:CrossFileValue['evidence']=[]):CrossFileValue {
 return {id:`${row.id}:${d.id}:bank-derived`,fieldId:row.fieldId,label:row.label,documentId:d.id,filename:d.filename,
  values:v,evidence,warnings:[],state:!current(d)?['pending','running','registered','queued','configuration_required'].includes(d.state)?'processing':'uncertain':v.length?'available':'missing',
  ...(d.parseRevision&&d.directoryRevision?{extractionVersion:{parseRevision:d.parseRevision,directoryRevision:d.directoryRevision}}:{})};
}

/** Existing signature extraction supplies presence, never printed names alone.
 * A document's resolution date is distinct from its execution/signature dates. */
export function corporateDerivedSources(row:ChecklistRow,documents:ChecklistInputDocument[],state:ReviewState,definition:ReviewFieldDefinition):CrossFileValue[]|undefined {
 if(state.readOnly||row.objectRole!=='corporate_guarantee'||row.fact&&!row.fact.automaticAdoption)return;
 if(row.fieldId==='cgt_field_60'){
  const docs=corporateValueDocuments(row,documents,state,'cgt_incorporation');
  // Repair an empty legacy extraction on entry using current saved source
  // anchors. Existing nonempty candidates, human decisions and history win.
  if(!docs.length||docs.some(d=>!current(d)||!d.sourceHash||!d.parseRevision||!d.directoryRevision||
    d.invalidFieldIds?.some(id=>id==='*'||id===row.fieldId)||d.fields.some(f=>f.fieldId===row.fieldId&&f.candidates.some(c=>c.rawValue.trim()))))return;
  const recovered=docs.map(d=>{
   const found=(d.sourcePages??[]).filter(p=>p.scope.documentVersionId===d.id&&p.scope.parseRevision===d.parseRevision&&!p.processing.ocrSimulated)
    .flatMap(page=>pageIncorporationNumbers(page,definition).flatMap(value=>{
     const anchors=page.anchors.filter(a=>d.availableAnchorIds?.includes(a.anchor_id)&&a.evidence_kind==='text'&&
       ['exact','block_only'].includes(a.localization_status)&&value.anchors.some(v=>v.block_ids.some(id=>a.block_ids.includes(id))));
     try{anchors.forEach(a=>validateAnchorSource(a,page.page,page.regions));}catch{return [];}
     return anchors.length?[{value:value.value,evidence:anchors.map(a=>({documentVersionId:d.id,parseRevision:d.parseRevision!,directoryRevision:d.directoryRevision,anchorId:a.anchor_id}))}]:[];
    }));
   if(!found.length||new Set(found.map(v=>v.value)).size!==1)return;
   return {...source(row,d,[found[0]!.value],found.flatMap(v=>v.evidence)),originalEligible:true,originalComparisonEligible:true};
  });
  return recovered.every(Boolean)?recovered as CrossFileValue[]:undefined;
 }
 if(row.fieldId==='cgt_field_62'){
  const docs=corporateValueDocuments(row,documents,state,'cgt_incorporation');
  const hasBad=docs.some(d=>d.fields.some(f=>f.fieldId===row.fieldId&&f.candidates.some(c=>/^[\d\s.,/-]+$/u.test(c.displayValue??candidateAdoptionValue(c)))));
  const recovered=docs.map(d=>{
   const explicit=(d.sourcePages??[]).filter(p=>p.scope.documentVersionId===d.id&&p.scope.parseRevision===d.parseRevision).flatMap(pageIncorporationJurisdictions);
   if(!explicit.length)return undefined;
   const vals=unique(explicit.map(v=>/^(?:Hong\s+Kong|香港)$/iu.test(v.value)?'香港':v.value));
   return source(row,d,vals,explicit.flatMap(v=>v.anchors.filter(a=>d.availableAnchorIds?.includes(a.anchor_id)).map(a=>({documentVersionId:d.id,parseRevision:d.parseRevision!,directoryRevision:d.directoryRevision,anchorId:a.anchor_id}))));
  });
  if(docs.length&&recovered.every(Boolean))return recovered as CrossFileValue[];
  // Reject the mislabeled identifier even if no explicit recovery is possible.
  if(hasBad)return docs.map(d=>source(row,d,[]));
  return;
 }
 if(!['cgt_authorization_reference_date','cgt_field_20','cgt_field_31'].includes(row.fieldId))return;
 const docs=corporateValueDocuments(row,documents,state,row.fieldId==='cgt_field_20'?'cgt_guarantee':'cgt_resolution');
 return docs.map(d=>{
  if(row.fieldId==='cgt_authorization_reference_date'){
   const explicit=d.fields.filter(f=>f.fieldId===row.fieldId&&f.parseRevision===d.parseRevision).flatMap(f=>f.candidates.map((c,i)=>({id:`${f.id}:${i}`,value:c.displayValue??candidateAdoptionValue(c),documentId:d.id,evidence:[],confidence:c.confidence})));
   if(explicit.some(c=>c.value?.trim())){
    const selection=fieldCandidateSelection(explicit,definition);
    return {...source(row,d,selection?.values??unique(explicit.flatMap(c=>c.value?[c.value]:[]))),displaySelection:selection};
   }
   const dated=d.authorizationSignatures?.automatic.dates.filter(v=>/决议日期|決議日期|resolution date|date of (?:this )?resolution|document date/iu.test(v.label))??[];
   const pages=(d.sourcePages??[]).filter(p=>p.scope.documentVersionId===d.id&&p.scope.parseRevision===d.parseRevision);
   const lines=pages.flatMap(p=>p.regions.filter(r=>r.processing_status==='ready'&&r.raw_text).map(r=>r.raw_text!));
   const labeled=lines.filter(v=>/^(?:(?:board|shareholders?'?)\s+)?(?:resolution\s+date|date\s+of\s+(?:this\s+)?resolution|决议日期|決議日期|文件日期)\s*[:：]/iu.test(v.trim()));
   const heading=pages.filter(p=>p.page.page_number===1).flatMap(p=>p.regions.flatMap(r=>r.processing_status==='ready'&&r.raw_text?resolutionHeadingDate(r.raw_text):[]));
   const dates=unique([...heading,...[...dated.map(v=>v.value),...labeled].flatMap(v=>(v.match(datePattern)??[]).flatMap(t=>{const n=normalizeDate(t);return n.value?[n.value]:[];}))]);
   return source(row,d,dates,dated.flatMap(v=>v.evidence));
  }
  const records=signatureRecords(d)?.filter(r=>row.fieldId==='cgt_field_20'?/^(?:witness|见证人|見證人)$/iu.test(r.role?.value??''):r.purpose==='specimen');
  return source(row,d,records?.map(r=>`${r.name?.value??'未识别姓名'}：${r.presence==='graphic'||r.presence==='handwriting'?'已留签字':r.presence==='blank'?'签字栏空白':'签字状态未明确'}`)??[],records?.flatMap(r=>r.evidence)??[]);
 });
}

/** The executable subset of the bank workbook. It is called on every editable
 * checklist GET, and by the review snapshot path. No database writes or model
 * calls occur here; unresolved business exceptions are explicit outcomes. */
export function corporateValueCheck(check:CrossFileCheck,row:ChecklistRow,rows:ChecklistRow[],documents:ChecklistInputDocument[],state:ReviewState,
 sourceFor:(row:ChecklistRow)=>CrossFileValue[],today:string):CrossFileCheck {
 const n=check.bankRule?.row;
 if(state.readOnly||!n||![5,6,19,20,28,34,39,46,49,67].includes(n)||check.reason==='当前配置尚无本条银行原表的有效来源，请核对配置。')return check;
 if(n===20&&check.outcome==='not_applicable')return check;
 const get=(id:string)=>{const r=rows.find(r=>r.fieldId===id&&r.objectId===row.objectId&&r.objectRole===row.objectRole);return r?sourceFor(r):[];};
 const done=(outcome:CrossFileCheck['outcome'],reason:string,sources=check.sources,extra:Partial<CrossFileCheck>={}):CrossFileCheck=>({...check,bankExecution:{version:'bank-value-checks-v1'},outcome,reason,sources,manualReasons:outcome==='manual'?[reason]:[],semanticEligible:false,...extra});
 const blocked=(sources:CrossFileValue[])=>sources.some(s=>['processing','uncertain'].includes(s.state)||s.warnings.length>0&&s.state==='available');
 if(blocked(check.sources))return done('insufficient','当前输入仍在处理或版本已失效，完成后自动重新检查。');
 const region=(v:string)=>/香港|hong\s*kong/iu.test(v)?'香港':/开曼|開曼|cayman/iu.test(v)?'开曼群岛':/英属维尔京|英屬維爾京|british virgin|\bBVI\b/iu.test(v)?'英属维尔京群岛':/百慕大|bermuda/iu.test(v)?'百慕大':/中国|中國|\bchina\b|\bPRC\b/iu.test(v)?'中国':undefined;
 if(n===6){
  // The bank row asks to state the governing law and to judge whether it applies to the guarantor. The clause is read
  // here and compared with the guarantor's place of incorporation; what cannot be read from the files stays with a person.
  const law=get('cgt_field_5'),place=get('cgt_field_62'),all=[...law,...place];
  if(blocked(all)||!values(law).length)return done('insufficient','尚未取得保证书的适用法律及管辖条款，需完成提取。',all);
  const governing=unique(values(law).flatMap(v=>{const r=region(v);return r?[r]:[];}));
  if(governing.length!==1)return done('manual',governing.length?`保证书条款同时指向${governing.join('、')}法域，请核对适用法律条款原文。`:'已读取适用法律条款，但未能归入明确法域，请核对条款原文。',all);
  const nonExclusive=values(law).some(v=>/non[-\s]?exclusive|非专属|非專屬|非排他/iu.test(v));
  const exclusive=values(law).some(v=>/exclusive|专属|專屬|排他/iu.test(v.replace(/non[-\s]?exclusive|非专属|非專屬|非排他/giu,'')));
  const courts=nonExclusive&&exclusive?'':nonExclusive?`，${governing[0]}法院非专属管辖`:exclusive?`，${governing[0]}法院专属管辖`:'';
  if(nonExclusive&&exclusive)return done('manual',`保证书适用${governing[0]}法律，但管辖条款同时出现专属与非专属管辖的表述，前后不一致，请核对原文并要求更正。`,all);
  const incorporation=unique(values(place).flatMap(v=>{const r=region(v);return r?[r]:[];}));
  if(incorporation.length!==1)return done('manual',`保证书适用${governing[0]}法律${courts}；尚未取得担保人明确的注册地，不能判断该法律是否适用于担保人。`,all);
  if(incorporation[0]===governing[0])return done('consistent',`保证书适用${governing[0]}法律${courts}；担保人注册地为${incorporation[0]}，与适用法律同属一个法域。`,all);
  return done('manual',`保证书适用${governing[0]}法律${courts}；担保人注册地为${incorporation[0]}，与适用法律不属同一法域，请判断是否接受并检查配套法律意见。`,all);
 }
 if(n===19){
  const a=get('cgt_field_19'),b=get('cgt_authorization_reference_date'),all=[...a,...b];
  const dates=(s:CrossFileValue[])=>unique(values(s).flatMap(v=>{const d=normalizeDate(v);return d.value?[d.value]:[];}));
  if(!b.some(s=>s.documentId))return done('manual','未提供对应授权决议文件，按银行第 19 行请判断是否接受。',a);
  if(blocked(all)||!values(a).length||!values(b).length)return done('insufficient','尚未取得保证书引用日期或对应决议的明确文件日期；需补全日期提取，不把签署日自动当作决议日期。',all);
  const x=dates(a),y=dates(b);
  if(x.length!==1||y.length!==1)return done('insufficient','日期不明确或存在多份不同日期的决议，需明确本次引用文件后比较。',all);
  return done(x[0]===y[0]?'consistent':'different',x[0]===y[0]?'保证书引用日期与对应决议文件日期一致。':'保证书引用日期与对应决议文件日期不一致，请更正。',all);
 }
 if(n===28){
  const a=get('cgt_field_25'),place=get('cgt_meeting_place').filter(s=>s.documentId&&s.values.length),all=[...a,...place];
  if(blocked(all)||!values(a).length)return done('insufficient','未取得可检查的会议日期，需完成提取。',all);
  const result=corporateMeetingCheck(values(all).map(value=>({value})) as Parameters<typeof corporateMeetingCheck>[0],today);
  return done(result.status==='done'?'consistent':result.status==='open'?'different':'insufficient',result.reason,all,{bankRule:{...check.bankRule!,currentDate:today}});
 }
 if(n===46){
  const a=get('cgt_field_36'),v=values(a).join('\n');
  if(!v)return done('insufficient','尚未取得 a/b 勾选结果，需完成选项识别。',a);
  const selected=unique([...v.matchAll(/\[SELECTED\]\s*\(([ab])\)|[☑✓✔]\s*\(?([ab])\)?|(?:仅选|已选|选择|選擇)\s*\(?([ab])\)?/giu)].map(m=>(m[1]??m[2]??m[3])!.toLowerCase()));
  if(/^[ab]$/iu.test(v.trim()))selected.push(v.trim().toLowerCase());
  const choices=unique(selected);
  if(choices.length===2||/^(?:both|同时选[择擇]?\s*a\s*和\s*b)$/iu.test(v.trim()))return done('different','a 和 b 同时选中；银行要求任选其一，请更正。',a);
  if(!choices.length)return done(/none|均未|未选择|未選擇|\[NOT SELECTED\]/iu.test(v)?'different':'insufficient','未识别到唯一选项；请检查 a/b 是否已明确勾选。',a);
  if(choices[0]==='a')return done('consistent','已仅选择 a，满足本条单选要求。',a);
  const docs=unique([...corporateValueDocuments(row,documents,state,'cgt_lawyer_confirmation'),...corporateValueDocuments(row,documents,state,'cgt_legal')]);
  const material=docs.map(d=>source({...row,fieldId:'material:cgt_lawyer_confirmation',label:'律师意见书／邮件确认'},d,['已提供']));
  return done(docs.length?'consistent':'different',docs.length?'已仅选择 b，并已提供对应律师意见书／邮件确认；本项只核对配套材料是否提供。':'已选择 b，但未提供对应律师意见书／邮件确认，请补充。',[...a,...material]);
 }
 if(n===67){
  const a=get('cgt_field_62'),b=get('cgt_field_5'),all=[...a,...b];
  if(blocked(all)||!values(a).length||!values(b).length)return done('insufficient','缺少注册地或保证书管辖法取值，需完成提取。',all);
  if(values(a).some(v=>/^\d[\d\s-]*$/u.test(v.trim())))return done('insufficient','注册地当前提取为数字编号，不能作为国家或地区比较；需纠正注册地提取后自动重算。',all);
  const x=unique(values(a).map(region)),y=unique(values(b).map(region));
  if(x.length!==1||y.length!==1||!x[0]||!y[0])return done('manual','已比较注册地与管辖法，尚不能明确对应法域；请确认具体不符点及配套法律意见。',all);
  if(x[0]===y[0])return done('consistent','注册地与保证书管辖法所属法域一致。',all);
  return done('manual',['开曼群岛','英属维尔京群岛','百慕大'].includes(x[0])&&['香港','中国'].includes(y[0])?
   `注册地为${x[0]}、管辖法为${y[0]}法；按银行要求请客户经理确认主要资产所在地。`:
   `注册地为${x[0]}、管辖法为${y[0]}法，不一致；请判断是否接受，并检查配套法律意见或同等文件。`,all);
 }
 if(n===49){
  const a=get('cgt_rm_clauses');
  if(blocked(a)||!values(a).length)return done('insufficient','尚未取得客户经理证明条款，需完成提取后与银行标准版本比较。',a);
  const text=values(a).join('\n'),labels=[...text.matchAll(/\(([a-e])\)/giu)].map(m=>m[1]!.toLowerCase());
  const missing=['a','b','c','d','e'].filter(l=>!labels.includes(l));
  if(missing.length)return done('insufficient',`已检查提取内容，但缺少标准证明 ${missing.join('、')} 条的完整取值，暂不能判断是材料缺条款还是提取遗漏。需补全条款提取后自动比较。`,a);
  const result=compareCorporateRmClauses(text);
  return done(result.equal?'consistent':'different',result.equal?'证明条款与银行标准版本一致（仅忽略排版、标点和勾选标记）。':`与银行标准版本比较，${result.mismatches.join('、')} 条不一致或未完整提取；请查看对应条款差异并使用标准版本。`,a);
 }
 if(n===39){
  const a=get('cgt_legal_conditions');
  if(blocked(a)||!values(a).length)return done('insufficient','尚未取得法律意见的不利内容、前提及后续事项，需完成提取。',a);
  const items=a.filter(usable).flatMap(s=>s.values.map((quote,i)=>{const kind=corporateConditionKind([quote]);return {id:`${s.id}:condition:${i}`,kind:'notice' as const,title:kind==='current'?'涉及当前生效的条件':kind==='notice'?'法律限制或后续事项':'需注意的法律意见条款',action:'请注意此条款，并在相应业务环节处理。',sourceId:s.id,quote,verified:false,evidence:s.evidence};}));
  return done('consistent','已按银行要求列示并提示提取到的不利内容、前提及后续事项；完成本条提醒不表示相关条件已满足或整案通过。',a,{reviewItems:items});
 }
 if(n===20||n===34){
  const type=n===20?'cgt_guarantee':'cgt_resolution',docs=corporateValueDocuments(row,documents,state,type);
  const a=get(n===20?'cgt_field_20':'cgt_field_31');
  if(docs.length!==1)return done('insufficient','需明确本次检查对应的唯一文书，不能合并不同文书的签署记录。',a);
  const records=signatureRecords(docs[0]!);
  if(!records)return done('insufficient','当前文书尚无有效签署识别结果，需完成签署识别；不据此认定没有签字。',a);
  if(n===20){
   const witness=records.filter(r=>/^(?:witness|见证人|見證人)$/iu.test(r.role?.value??''));
   if(!witness.length||witness.some(r=>!['graphic','handwriting','blank'].includes(r.presence)))return done('insufficient','见证人签署状态尚未明确，需完成签署区域识别。',a);
   if(witness.every(r=>r.presence==='blank'))return done('not_applicable','已识别见证人签字栏为空，银行“若有签署”的条件不成立。',a);
   const ids=['cgt_field_21','cgt_field_22','cgt_field_23'],details=ids.flatMap(get),missing=ids.filter(id=>!values(get(id)).length);
   if(blocked(details))return done('insufficient','已识别见证人签署，相关信息仍在处理或版本失效。',[...a,...details]);
   if(!missing.length&&witness.filter(r=>r.presence!=='blank').some(r=>!r.name?.value||!r.number?.value||!r.address?.value))return done('insufficient','已识别见证人签署及信息取值，但尚未把姓名、办事处及证件信息逐一对应到每位签署人，需补全同栏识别。',[...a,...details]);
   return done(missing.length?'different':'consistent',missing.length?`已有见证人签署，但${missing.map(id=>rows.find(r=>r.fieldId===id)?.label??id).join('、')}未填写或未提取，请补全。`:'已有见证人签署，姓名、办事处及证件类型和号码均有填写。',[...a,...details]);
  }
  const authorized=get('cgt_field_29'),names=unique(values(authorized));
  if(blocked(authorized)||!names.length)return done('insufficient','尚未取得完整被授权人名单，无法逐人检查样式。',[...a,...authorized]);
  const specimens=records.filter(r=>r.purpose==='specimen'),missing=names.filter(name=>!specimens.some(r=>r.name&&corporateSignerSame(name,r.name.value)&&['graphic','handwriting'].includes(r.presence)));
  const unknown=specimens.some(r=>!r.name||!['graphic','handwriting','blank'].includes(r.presence));
  return done(unknown?'insufficient':missing.length?'different':'consistent',unknown?'部分签字样式的姓名或图形状态不明确，需完成识别。':missing.length?`以下被授权人尚未匹配到签字样式：${missing.join('、')}。请补充对应样式或纠正识别结果。`:'名单中的每位被授权人均已匹配到签字样式；本项不判断笔迹真伪。',[...a,...authorized]);
 }
 // Row 5 compares an address with its bank, not just two arbitrary addresses.
 const addresses=get('cgt_field_13'),banks=get('cgt_field_4');
 if(!values(addresses).length||!values(banks).length)return done('insufficient','尚未取得银行名称及地址，需完成提取。',[...addresses,...banks]);
 const counterparts=documents.filter(d=>corporateValueDocuments(row,documents,state,'cgt_facility').some(x=>x.id===d.id));
 const reference=counterparts.flatMap(d=>d.fields.filter(f=>f.fieldId==='cgt_field_13'&&f.parseRevision===d.parseRevision).flatMap(f=>f.candidates.flatMap(c=>typeof c.rawValue==='string'?[source({...row,fieldId:'cgt_bank_address_reference',label:'对应银行地址'},d,[c.displayValue??c.rawValue])]:[])));
 const all=[...addresses,...banks,...reference];
 const matches=reference.length>0&&values(addresses).every(a=>values(reference).some(b=>key(a)===key(b)||!!addressMeaningKey(a)&&addressMeaningKey(a)===addressMeaningKey(b)));
 // An address can explicitly name its bank; otherwise a trusted counterpart
 // must name that bank too. Do not manufacture a directory from the bank name.
 const lender=get('cgt_facility_lender');
 const bankMatch=values(lender).length>0&&values(banks).every(a=>values(lender).some(b=>corporateSignerSame(a,b)));
 const named=values(addresses).every(a=>values(banks).some(b=>{
  if(key(a).startsWith(key(b)))return true;
  const headquarters=/总行|總行|head\s*office|headquarters/iu;
  const root=b.replace(headquarters,'').replace(/[()（）,，-]/gu,'').trim();
  return headquarters.test(b)&&key(root).length>=3&&key(a).startsWith(key(root))&&/branch|分行|支行/iu.test(a);
 }));
 return done(named||matches&&bankMatch?'consistent':'manual',named||matches&&bankMatch?'已核对银行地址与所列银行对应。':'已检查银行名称及地址，但现有提取值未提供足够的对应依据；请确认地址属于所列银行。若所列为总行，可接受其分支行地址。',all);
}
