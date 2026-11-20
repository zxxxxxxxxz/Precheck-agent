import type {ChecklistRow,CrossFileCheck,ReviewChecklist} from '@hsbc/contracts/review-checklist';
import type {ReviewEvidence,ReviewState} from '@hsbc/contracts/review';
import type {CaseAssistPage} from '@hsbc/contracts/case-assistant';
import {SEMANTIC_GUIDANCE_KIND_LABELS,type GuidanceRef,type SemanticGuidanceKind} from '@hsbc/contracts/review-guidance';

/** The file open in the reader when the question was asked. Text is read with the sender's own document access. */
export interface CaseAssistDocument {
  documentId:string;filename:string;typeLabel:string|null;
  /** Values this file contributed, keyed by frozen checklist row. */
  fields:Array<{rowId:string;values:string[]}>;
  /** `spans` place each anchored block inside `text` (code points), so a quote can be located at its own block. */
  chunks:Array<{blockId:string;text:string;evidence:ReviewEvidence|null;spans?:Array<{start:number;end:number;evidence:ReviewEvidence}>}>;
  limitations:string[];
}
/** Earlier turns keep what they pointed at, so "它" or "刚才那条" still resolves after the checklist is re-read. */
export interface CaseAssistHistoryTurn {user:string;assistant:string;targets?:string[];proposal?:string}
/** Frozen with the turn. Only refs (F/R/G) cross the model boundary; ids stay server-side. */
export interface CaseAssistContext {
  version:'case-assist-context.v1';caseLabel:string;roundId:string|null;roundNumber:number|null;readOnly:boolean;
  configurationReleaseId:string|null;configurationLabel:string|null;runState:string;openIssues:number;
  page:CaseAssistPage;selectedRef:string|null;
  rows:Array<{ref:string;rowId:string;fieldId:string;label:string;objectLabel:string;status:string;detail:boolean;
    values:Array<{filename:string;text:string}>;semantic:string|null;guidance:string[];evidence:ReviewEvidence|null}>;
  rules:Array<{ref:string;guidanceRef:string;guidanceId:string|null;label:string;kind:SemanticGuidanceKind;statement:string;fieldIds:string[];expressions:string[]}>;
  history:CaseAssistHistoryTurn[];
  document?:CaseAssistDocument;
}
const statusLabels:Record<string,string>={confirmed:'已确认',consistent:'语义一致',different:'有差异',pending:'待确认',not_applicable:'不适用'};
const outcomeLabels:Record<CrossFileCheck['outcome'],string>={consistent:'一致',different:'有差异',insufficient:'依据不足',manual:'需人工核对',single_source:'单一来源',not_applicable:'不适用'};
const clip=(value:string,size:number)=>value.length>size?`${value.slice(0,size)}…`:value;
export const CASE_ASSIST_MESSAGE_LABEL='用户最新消息：';
export const CASE_ASSIST_DOCUMENT_BLOCK=/^doc:\d+$/;

export function rowStatus(row:ChecklistRow):string {
  if(row.verification)return statusLabels[row.verification.status]??row.verification.status;
  const outcomes=(row.crossChecks??[]).map(c=>c.semantic?.state==='complete'&&c.method==='text'?c.semantic.outcome:c.outcome);
  if(outcomes.includes('different'))return '有差异';
  if(outcomes.some(o=>['insufficient','manual','single_source'].includes(o)))return '待确认';
  if(outcomes.length&&outcomes.every(o=>o==='consistent'||o==='not_applicable'))return '一致';
  return row.status==='not_applicable'?'不适用':row.status==='not_found'||row.status==='missing_material'?'未取得':'待确认';
}
/** What one file contributed to a row: its extraction candidates and its compared or read values. */
function documentValues(row:ChecklistRow,documentId:string):string[]|null {
  const values=[
    ...(row.candidates??[]).filter(c=>c.documentId===documentId&&c.value).map(c=>c.value!),
    ...(row.crossChecks??[]).flatMap(c=>c.sources).filter(s=>s.documentId===documentId).flatMap(s=>s.values),
    ...(row.sourceValues??[]).filter(s=>s.documentId===documentId).flatMap(s=>s.values),
  ].map(value=>clip(value,160));
  if(values.length)return [...new Set(values)].slice(0,4);
  return row.documentScope?.included&&row.documentScope.documentIds.includes(documentId)?[]:null;
}

export function buildCaseAssistContext(input:{caseLabel:string;state:ReviewState;checklist:ReviewChecklist;refs:readonly GuidanceRef[];page:CaseAssistPage;history:CaseAssistHistoryTurn[];
  document?:Omit<CaseAssistDocument,'fields'>}):CaseAssistContext {
  const {state,checklist,refs,page}=input,run=state.runs[0];
  const caseRule=new Map((state.guidance??[]).map(g=>[`case:${g.id}`,g]));
  let release=0;
  const rules=refs.map(ref=>({ref:ref.source==='case'?`R${caseRule.get(ref.ref)?.number??0}`:`G${++release}`,guidanceRef:ref.ref,guidanceId:caseRule.get(ref.ref)?.id??null,
    label:ref.label,kind:ref.kind,statement:ref.statement,fieldIds:ref.fieldIds,expressions:ref.expressions}));
  const ruleRef=(ref:string)=>rules.find(r=>r.guidanceRef===ref)?.ref??ref;
  const rows=checklist.rows.map((row,index)=>{
    const checks=row.crossChecks??[],status=rowStatus(row);
    const values=checks.flatMap(c=>c.sources).filter(s=>s.values.length).map(s=>({filename:s.filename,text:clip(s.values.join(' / '),160)}));
    const unique=[...new Map(values.map(v=>[`${v.filename}\u0000${v.text}`,v])).values()].slice(0,6);
    const semantic=checks.find(c=>c.semantic?.state==='complete')?.semantic;
    const evidence=checks.flatMap(c=>c.sources).flatMap(s=>s.evidence)[0]??null;
    return {ref:`F${index+1}`,rowId:row.id,fieldId:row.fieldId,label:row.label,objectLabel:row.objectLabel,status,detail:false,values:unique,
      semantic:semantic?`${outcomeLabels[semantic.outcome]}${semantic.appliedGuidance?.length?`（依据 ${semantic.appliedGuidance.map(ruleRef).join('、')}）`:''}`:null,
      guidance:[...new Set(checks.flatMap(c=>c.guidance??[]).map(g=>ruleRef(g.ref)))],evidence};
  });
  // Details for the selected field, fields needing attention and guided fields; others by name only.
  const selected=rows.find(r=>r.rowId===page.rowId);
  const budget=[...(selected?[selected]:[]),...rows.filter(r=>r!==selected&&(r.guidance.length||['有差异','待确认'].includes(r.status))&&r.values.length)].slice(0,40);
  for(const row of budget)row.detail=true;
  const document=input.document?{...input.document,fields:checklist.rows.flatMap(row=>{const values=documentValues(row,input.document!.documentId);return values?[{rowId:row.id,values}]:[];}).slice(0,60)}:undefined;
  return {version:'case-assist-context.v1',caseLabel:input.caseLabel,roundId:checklist.roundId,roundNumber:checklist.roundNumber,readOnly:checklist.readOnly,
    configurationReleaseId:state.configurationReleaseId,configurationLabel:state.configuration?.label??null,
    runState:!run?'未开始预审':run.validity!=='current'?'预审结果已失效，待重新预审':run.state==='ready'?'预审已完成':['pending','running'].includes(run.state)?'预审进行中':'预审未完成',
    openIssues:state.issues.filter(i=>i.validity==='current'&&i.status==='open').length,page,selectedRef:selected?.ref??null,rows,rules,history:input.history.slice(-6),
    ...(document?{document}:{})};
}

/** Plain-text source blocks for privacy projection. No UUIDs, URLs or encoded payloads.
 * Wire ids are ordinal, so every block names itself in its own text; the user's message stays last. */
export function caseAssistBlocks(context:CaseAssistContext,message:string):Array<{id:string;text:string}> {
  const views:Record<CaseAssistPage['view'],string>={desk:'提取审查·字段工作台',reader:'原件阅读',result:'预审结果',materials:'案件与上传',other:'案件页面'};
  const selected=context.rows.find(r=>r.ref===context.selectedRef),document=context.document;
  const row=(rowId:string)=>context.rows.find(r=>r.rowId===rowId);
  const documentFields=document?.fields.flatMap(field=>{const r=row(field.rowId);return r?[`${r.ref} ${r.label}（${r.objectLabel}）：${field.values.length?field.values.join(' / '):'本文件未提取到取值'}`]:[];})??[];
  const history=context.history.map(h=>{
    const targets=(h.targets??[]).flatMap(id=>{const r=row(id);return r?[`${r.ref} ${r.label}`]:[];});
    return [`用户：${clip(h.user,400)}`,`助手：${clip(h.assistant,400)}`,...(targets.length?[`  当时涉及字段：${targets.join('、')}`]:[]),...(h.proposal?[`  当时提出的口径建议：${clip(h.proposal,300)}`]:[])].join('\n');
  });
  const blocks=[
    {id:'case',text:[`案件：${context.caseLabel}`,`轮次：${context.roundNumber?`第 ${context.roundNumber} 轮`:'无轮次'}${context.readOnly?'（只读）':''}`,`审核配置：${context.configurationLabel??'未绑定'}`,`预审：${context.runState}；未关闭问题 ${context.openIssues} 项`].join('\n')},
    {id:'page',text:[`当前页面：${views[context.page.view]}${selected?`；当前选中字段：${selected.ref} ${selected.label}（${selected.objectLabel}）`:''}`,
      ...(document?[`当前打开的文件：${document.filename}${document.typeLabel?`（${document.typeLabel}）`:''}`]:[])].join('\n')},
    {id:'fields-index',text:context.rows.map(r=>`${r.ref} ${r.label}｜${r.objectLabel}｜${r.status}`).join('\n')||'暂无字段'},
    {id:'fields-detail',text:context.rows.filter(r=>r.detail).map(r=>[`${r.ref} ${r.label}（${r.objectLabel}）：${r.status}`,...r.values.map(v=>`  ${v.filename}：${v.text}`),...(r.semantic?[`  AI 含义核对：${r.semantic}`]:[]),...(r.guidance.length?[`  适用口径：${r.guidance.join('、')}`]:[])].join('\n')).join('\n')||'暂无需要关注的字段'},
    {id:'rules',text:context.rules.map(r=>`${r.ref}（${r.label}，${SEMANTIC_GUIDANCE_KIND_LABELS[r.kind]}）：${r.statement}${r.fieldIds.length?`；字段：${r.fieldIds.map(id=>context.rows.find(item=>item.fieldId===id)?.label??id).join('、')}`:''}${r.expressions.length?`；表述：${r.expressions.join('｜')}`:''}`).join('\n')||'本案尚无生效口径'},
    ...(document?[{id:'document-fields',text:`当前文件已提取的字段：\n${documentFields.join('\n')||'暂无'}`}]:[]),
    ...(document?.chunks.map((chunk,index)=>({id:chunk.blockId,text:`当前文件原文 第 ${index+1} 段：\n${chunk.text}`}))??[]),
    ...(history.length?[{id:'history',text:`此前对话（由旧到新）：\n${history.join('\n')}`}]:[]),
    {id:'message',text:`${CASE_ASSIST_MESSAGE_LABEL}\n${message}`},
  ];
  return blocks.map(b=>({...b,text:b.text.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/gu,' ')}));
}
