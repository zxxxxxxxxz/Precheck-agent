import {z} from 'zod';
import type {ReviewEvidence, ReviewFact, ReviewMaterial, ReviewObject} from './review.js';

export const MAIL_TEMPLATE_VERSION = 'pre-review-mail.v5';
export const isGroupedMailTemplate=(version:string)=>['pre-review-mail.v2','pre-review-mail.v3','pre-review-mail.v4',MAIL_TEMPLATE_VERSION].includes(version);
export const MailFormatSchema = z.enum(['rounds', 'documents']);
export type MailFormat = z.infer<typeof MailFormatSchema>;
export const DeliveryCommandSchema = z.strictObject({expectedRevision:z.number().int().positive(),idempotencyKey:z.string().min(8).max(200)});
export const MailCommandSchema = DeliveryCommandSchema.extend({runId:z.uuid(),format:MailFormatSchema,replyIds:z.array(z.uuid()).max(1000).default([])});
export const AnalysisCommandSchema=DeliveryCommandSchema.extend({runId:z.uuid(),retryOf:z.uuid().optional()});
export const ComparisonCommandSchema=DeliveryCommandSchema.extend({beforeRoundId:z.uuid(),afterRoundId:z.uuid(),
  objectPairs:z.array(z.strictObject({before:z.uuid(),after:z.uuid()})).max(100).default([]),
  materialGroups:z.array(z.strictObject({before:z.array(z.uuid()).max(10),after:z.array(z.uuid()).max(10),reason:z.string().trim().min(1).max(1000)})).max(100).default([]),retryOf:z.uuid().optional()});
export type ComparisonCommand=z.infer<typeof ComparisonCommandSchema>;
export type AnalysisOutcome='consistent'|'different'|'insufficient'|'manual';
export interface AnalysisEvidence {id:string;documentId:string;filename:string;parseRevision:string;directoryRevision:number;roundId?:string|null;
  text:string;sha256:string;locations:ReviewEvidence[];warnings:string[];sourceNotes?:string[];referenceTranslations:Array<{text:string;jobId:string;status:string}>}
export interface SemanticItem {id:string;ruleId:string;ruleLabel:string;ruleText:string;ruleSources:string[];objectId:string;objectLabel:string;
  kind:'identity'|'liability'|'value'|'authorization'|'outside_scope';fieldIds:string[];confirmedInputs:Array<{fieldId:string;label:string;state:string;value:string|boolean|null}>;programChecks:Array<{ruleId:string;outcome:string}>;originalOutcome:string;
  outcome:AnalysisOutcome;state:'pending'|'complete'|'unavailable'|'failed';reason:string;limitations:string[];
  evidenceIds:string[];citations:Array<{evidenceId:string;quote:string}>;method:'model'|'program'|'not_run';simulated:boolean;deferredReason?:'batch_limit';
  /** Guidance refs the model relied on; only kept for consistent cross-file conclusions. */
  appliedGuidance?:string[]}
export interface MaterialMatch {id:string;before:string[];after:string[];objectIds:string[];kind:'matched'|'added'|'removed'|'ambiguous';basis:string;confirmed:boolean}
export interface MaterialChange extends MaterialMatch {classification:'unchanged'|'format'|'equivalent'|'substantive'|'unknown'|'added'|'removed';
  state:'pending'|'complete'|'unavailable'|'failed';reason:string;beforeEvidenceIds:string[];afterEvidenceIds:string[];affectedRuleIds:string[];
  rawChanges:Array<{kind:string;beforeChunkIds:string[];afterChunkIds:string[]}>;limitations:string[];citations:Array<{evidenceId:string;quote:string}>;simulated:boolean;deferredReason?:'batch_limit'}
export interface ResultChange {ruleId:string;ruleLabel?:string;objectLabels?:string[];beforeObjectId:string|null;afterObjectId:string|null;label:string;
  beforeOutcome:string|null;afterOutcome:string|null;kind:'added'|'persisting'|'rechecked'|'unverified'|'incomparable';
  beforeIssues:Array<{id:string;status:string}>;afterIssues:Array<{id:string;status:string}>;reason:string}
export interface AnalysisBody {version:string;purpose:'assistance';kind:'semantic'|'comparison';runs:DeliveryRound[];evidence:AnalysisEvidence[];
  items:SemanticItem[];changes:MaterialChange[];resultChanges:ResultChange[];limitations:string[];modelVersion:string|null}
export interface AnalysisJob {id:string;caseId:string;kind:'semantic'|'comparison';state:'pending'|'running'|'ready'|'partial'|'failed'|'canceled';
  validity:'current'|'history'|'stale';errorCode:string|null;createdAt:string;body:AnalysisBody;canCancel:boolean;canRetry:boolean;simulated:boolean;
  canContinue:boolean;nextJobId:string|null;progress:{total:number;complete:number;pending:number;failed:number;deferred:number;unavailable:number;batchNumber:number;batchSize:number}}
export interface AnalysisState {caseId:string;revision:number;modelEnabled:boolean;allowedActions:string[];
  excludedRounds?:Array<{roundId:string;roundNumber:number;reason:'discarded'|'no_result'}>;
  rounds:Array<DeliveryRound&{submittedAt:string}>;jobs:Array<Pick<AnalysisJob,'id'|'kind'|'state'|'createdAt'>&{runIds:string[]}>;
  comparison:{beforeRoundId:string;afterRoundId:string;objectPairs:ComparisonCommand['objectPairs'];materialGroups:ComparisonCommand['materialGroups'];matches:MaterialMatch[];beforeObjects:Array<{id:string;label:string;role:string}>;
    afterObjects:Array<{id:string;label:string;role:string}>;documents:Array<{id:string;label:string;side:'before'|'after'}>}|null}
export interface DeliverySnapshot {
  requirementPolicy?:import('./review-config.js').ReviewRequirementPolicy;
  reviewedInputs?:import('./field-verification.js').ReviewedRuleInputs[];
  automaticChecks?:import('./field-verification.js').AutomaticReviewCheck[];
  fieldReviews?:import('./field-verification.js').FrozenFieldReview[];
  signatureInformation?:import('./signature-information.js').SignatureInformationSummary[];
  caseId:string;caseRevision:number;roundId?:string;roundNumber?:number;businessDate:string;
  configurationReleaseId:string;manifestHash:string;packageHash:string;
  objects:ReviewObject[];facts:ReviewFact[];materials:ReviewMaterial[];
}
export interface DeliveryRound {roundId:string|null;roundNumber:number|null;runId:string|null;state:string;validity:string;label:string;snapshotHash?:string;configurationReleaseId?:string;manifestHash?:string;packageHash?:string}
export interface MailCell {
  runId:string|null;roundId:string|null;roundNumber:number|null;outcome:string|null;
  action:string;reply:string;issueIds:string[];replyIds:string[];issueStatus:string|null;
  manualConfirmation?:boolean;
  summary?:string;
  /** Customer-facing assessment, separate from the unchanged program outcome. */
  assessment?:{tone:MailTone;label:string};
  fieldReviewText?:{conclusion:string;followUp:string};
}
export interface MailRow {
  key:string;ruleId:string;objectId:string;objectLabel:string;documentLabels:string[];documentIds:string[];
  ruleLabel:string;sourceReferences:string[];evidence:ReviewEvidence[];cells:MailCell[];
  documentTypes?:string[];
  /** Display owner from the frozen rule configuration, not its supporting-file combination. */
  documentGroup?:string;
  /** Exact scoped input identity, never a label-based merge. */
  consolidationKey?:string;
}
export interface MailBody {subject:string;caseLabel:string;notice:string;rounds:DeliveryRound[];rows:MailRow[];documentRounds?:Record<string,string|null>;totalChecks:number;templateVersion:string;
  fieldReviewSummary?:Record<import('./field-verification.js').FieldReviewStatus,number>}
export interface MailDraft {
  checkerPending?:{submissionId:string;submissionNumber:number;submittedAt:string};
  checkerConfirmation?:{submissionId:string;submissionNumber:number;confirmedAt:string;validity:'current'|'history'};
  id:string;caseId:string;runId:string;roundId:string|null;version:number;format:MailFormat;
  createdAt:string;validity:'current'|'history'|'stale';staleReasons:string[];body:MailBody;
  includedReplyIds:string[];canCopy:boolean;
}
export interface DeliveryState {
  caseId:string;revision:number;allowedActions:string[];
  runs:Array<{id:string;roundId:string|null;roundNumber:number|null;state:string;validity:string;createdAt:string}>;
  drafts:Array<Omit<MailDraft,'body'|'includedReplyIds'|'canCopy'>>;
  replies:Array<{id:string;issueId:string;roundId:string|null;text:string;externalAuthor:string;receivedAt:string}>;
}

export function escapeMailHtml(value:string):string {return value.replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]!));}

export type MailTone='open'|'confirm'|'done'|'incomplete';
export const MAIL_FOLLOWUP_COLORS:Record<MailTone,{color:string;background:string}>={
  incomplete:{color:'#666666',background:'#F3F3F3'},
  open:{color:'#DB0011',background:'#FCE7E4'},
  confirm:{color:'#936000',background:'#FFF3DC'},
  done:{color:'#007C80',background:'#E2F4F3'},
};
/** Presentation only: never changes an issue's disposition or a review result. */
export function mailFollowUp(cell:MailCell|undefined):{tone:MailTone;label:string} {
  if(!cell||!cell.outcome)return {tone:'confirm',label:'待人工确认（本项未完成）'};
  if(cell.outcome==='fail')return {tone:'open',label:'信贷运营部：未解决'};
  if(cell.manualConfirmation||['needs_review','manual_review','manual'].includes(cell.outcome)||cell.issueStatus==='acknowledged')return {tone:'confirm',label:'待人工确认'};
  if(cell.outcome==='blocked'||cell.issueStatus==='open')return {tone:'open',label:'信贷运营部：未解决'};
  if(cell.outcome==='not_applicable')return {tone:'done',label:'信贷运营部：不需要跟进'};
  if(cell.outcome==='pass')return {tone:'done',label:'信贷运营部：检查无误'};
  return {tone:'confirm',label:'待人工确认'};
}
export interface MailDisplayRow {key:string;group:string;rowSpan:number;action:string;followUp:string;tone:MailTone}
/** One projection is shared by the preview, summary and exported HTML/plain text. */
export function mailDisplayRows(body:MailBody,includeAll=false):MailDisplayRow[] {
  if(body.templateVersion===MAIL_TEMPLATE_VERSION){
    const merged=consolidatedMailBody(body);
    return documentMailRows(includeAll?merged:{...merged,rows:merged.rows.filter(r=>['open','confirm'].includes(currentMailFollowUp(r.cells.at(-1)).tone))},true);
  }
  if(body.templateVersion==='pre-review-mail.v4')return documentMailRows(consolidatedMailBody(body),true);
  if(body.templateVersion==='pre-review-mail.v3')return documentMailRows(body);
  const groups=new Map<string,MailRow[]>();
  for(const row of body.rows){
    const group=(row.documentTypes?.length?row.documentTypes:row.documentLabels).join('、')||'其他核对事项';
    const entries=groups.get(group)??[];entries.push(row);groups.set(group,entries);
  }
  return [...groups].flatMap(([group,rows])=>rows.map((row,index)=>{
    const cell=row.cells.at(-1),follow=mailFollowUp(cell);
    const context=[row.objectLabel,...row.documentLabels].filter(Boolean).join(' · ');
    return {key:row.key,group,rowSpan:index===0?rows.length:0,
      action:`${index+1}. ${row.ruleLabel}\n${cell?.action??'尚无有效检查结果，请核对。'}${context?`\n${context}`:''}`,
      followUp:[follow.label,cell?.reply].filter(Boolean).join('\n'),tone:follow.tone};
  }));
}
function documentMailRows(body:MailBody,current=false):MailDisplayRow[] {
  const groups=new Map<string,MailRow[]>();
  for(const row of body.rows){
    const group=row.documentGroup||(row.documentTypes?.length?row.documentTypes:row.documentLabels).join('、')||'其他核对事项';
    const entries=groups.get(group)??[];entries.push(row);groups.set(group,entries);
  }
  return [...groups].flatMap(([group,rows])=>{
    const multipleObjects=new Set(rows.map(row=>row.objectId)).size>1;
    return rows.map((row,index)=>{
      const cell=row.cells.at(-1),follow=current?currentMailFollowUp(cell):mailFollowUp(cell);
      const ambiguous=rows.some(other=>other.key!==row.key&&((other.objectId===row.objectId&&other.ruleLabel===row.ruleLabel)||(other.objectId!==row.objectId&&other.objectLabel===row.objectLabel)));
      const context=[multipleObjects?row.objectLabel:'',ambiguous?row.documentLabels.join('、'):''].filter(Boolean).join(' · ');
      const summary=cell?.summary??`${row.ruleLabel}：${cell?.action??'尚无有效检查结果，请核对。'}`;
      return {key:row.key,group:`文件类型-${group}`,rowSpan:index===0?rows.length:0,
        action:`${rows.length>1?`${index+1}. `:''}${context?`${context}：`:''}${summary}`,
        followUp:[follow.label,cell?.reply].filter(Boolean).join('\n'),tone:follow.tone};
    });
  });
}
/** New drafts distinguish inability to check from an established discrepancy. */
export function currentMailFollowUp(cell:MailCell|undefined):{tone:MailTone;label:string}{
  if(cell?.outcome==='fail')return {tone:'open',label:'发现问题：需更正或补充依据'};
  if(cell?.assessment)return cell.assessment;
  if(!cell?.outcome)return {tone:'confirm',label:'待确认：检查未完成'};
  if(cell.outcome==='blocked')return {tone:'confirm',label:cell.manualConfirmation?'待人工确认':'待确认：检查依据不足'};
  if(cell.manualConfirmation||['needs_review','manual_review','manual'].includes(cell.outcome)||cell.issueStatus==='acknowledged'||cell.issueStatus==='open')return {tone:'confirm',label:'待人工确认'};
  return mailFollowUp(cell);
}
/** Keep original rule rows, evidence, issues and per-round decisions in the saved body. */
function consolidatedMailBody(body:MailBody):MailBody{
  const groups=new Map<string,MailRow[]>();
  for(const row of body.rows){
    const scope=row.consolidationKey?.startsWith('corporate-manual:')&&row.objectId.startsWith('unassigned:')?'unassigned:corporate_guarantee':row.objectId;
    const key=row.consolidationKey?JSON.stringify([scope,row.documentGroup,row.consolidationKey,row.cells.map(c=>!!c.outcome),...(body.templateVersion===MAIL_TEMPLATE_VERSION?[row.cells.map(c=>currentMailFollowUp(c).tone)]:[])]):row.key;
    groups.set(key,[...(groups.get(key)??[]),row]);
  }
  const unique=(items:string[])=>[...new Set(items.filter(Boolean))];
  return {...body,rows:[...groups.values()].map(rows=>{
    const first=rows[0]!;if(rows.length===1)return first;
    return {...first,key:JSON.stringify(rows.map(r=>r.key)),cells:first.cells.map((cell,i)=>{
      const cells=rows.map(r=>r.cells[i]!).filter(Boolean),follows=cells.map(currentMailFollowUp);
      const tone=follows.some(f=>f.tone==='open')?'open':follows.some(f=>f.tone==='confirm')?'confirm':follows.some(f=>f.tone==='incomplete')?'incomplete':'done';
      const fieldText=new Map<string,string[]>();
      for(const c of cells)if(c.fieldReviewText){const {conclusion,followUp}=c.fieldReviewText;fieldText.set(conclusion,[...(fieldText.get(conclusion)??[]),followUp]);}
      const summaries=[...fieldText].map(([conclusion,followUps])=>conclusion+unique(followUps).join(''));
      summaries.push(...cells.filter(c=>!c.fieldReviewText).map(c=>c.summary??c.action));
      return {...cell,summary:unique(summaries).join('\n'),reply:unique(cells.map(c=>c.reply)).join('\n'),
        assessment:{tone,label:unique(follows.filter(f=>f.tone===tone).map(f=>f.label)).join('；')}};
    })};
  })};
}
export function mailSummary(body:MailBody):Record<'open'|'confirm'|'done',number>&{incomplete?:number} {
  const counts={open:0,confirm:0,done:0,...(body.templateVersion===MAIL_TEMPLATE_VERSION?{incomplete:0}:{})};
  for(const row of mailDisplayRows(body,true))if(row.tone==='incomplete')counts.incomplete=(counts.incomplete??0)+1;else counts[row.tone]++;
  return counts;
}
export function mailCoverageNotice(body:MailBody):string {
  const count=mailSummary(body).incomplete??0;
  return count?`本轮仍有 ${count} 项检查未完成，以下仅列已识别的问题及需要人工判断的事项，不代表全部检查通过。`:'';
}
export function omittedMailReplies(body:MailBody):string {
  if(body.templateVersion!==MAIL_TEMPLATE_VERSION)return '';
  const replies=body.rows.filter(r=>!['open','confirm'].includes(currentMailFollowUp(r.cells.at(-1)).tone)).flatMap(r=>r.cells.map(c=>c.reply).filter(Boolean));
  return replies.length?`已选定的历史回复（不计入本轮人工待办）：\n${[...new Set(replies)].join('\n')}`:'';
}
function groupedMailContent(body:MailBody):{plainText:string;html:string} {
  const rows=mailDisplayRows(body),headers=['文件类型','信贷运营部 回复','跟进'];
  const text=[`邮件标题：${body.subject}`,`客户／案件：${body.caseLabel}`,[body.notice,mailCoverageNotice(body)].filter(Boolean).join('\n'),headers.join('\t'),...rows.map(r=>[r.rowSpan?r.group:'',r.action,r.followUp].join('\t'))];
  const empty=body.templateVersion===MAIL_TEMPLATE_VERSION?'本轮暂无已识别的问题或人工待办；检查完成情况以上述范围说明为准。':'本轮暂无可展示的预审事项，请核对检查范围；此草稿不代表业务批准。';
  if(!rows.length)text.push(empty);
  if(omittedMailReplies(body))text.push(omittedMailReplies(body));
  const e=(value:string)=>escapeMailHtml(value).replace(/\n/g,'<br>');
  const style='border:1px solid #D7D8D6;padding:10px 12px;vertical-align:top;text-align:left;';
  const html=`<div><p>邮件标题：${e(body.subject)}</p><p>客户／案件：${e(body.caseLabel)}</p><p>${e([body.notice,mailCoverageNotice(body)].filter(Boolean).join('\n'))}</p><table style="border-collapse:collapse;width:100%;font-family:Arial,sans-serif;font-size:14px;line-height:1.6;color:#333333"><thead><tr>${headers.map(h=>`<th style="${style}background:#EEEFF0">${e(h)}</th>`).join('')}</tr></thead><tbody>${rows.map(row=>{const paint=MAIL_FOLLOWUP_COLORS[row.tone];return `<tr>${row.rowSpan?`<td rowspan="${row.rowSpan}" style="${style}background:#EEEFF0;font-weight:bold">${e(row.group)}</td>`:''}<td style="${style}">${e(row.action)}</td><td style="${style}color:${paint.color};background:${paint.background};font-weight:bold">${e(row.followUp)}</td></tr>`;}).join('')}</tbody></table>${!rows.length?`<p>${e(empty)}</p>`:''}</div>`;
  return {plainText:text.join('\n\n'),html:html+ (omittedMailReplies(body)?`<p>${e(omittedMailReplies(body))}</p>`:'')};
}
/** Only the explicit customer projection is rendered; internal evidence/decision reasons never enter the clipboard. */
export function mailContent(body:MailBody,format:MailFormat):{plainText:string;html:string} {
  if(format==='documents'&&isGroupedMailTemplate(body.templateVersion))return groupedMailContent(body);
  const headers=format==='rounds'?['序号','文件／条件',...body.rounds.flatMap(r=>[`${r.label}：问题及所需行动`,'客户经理回复'])]:['文件／条件','本轮跟进事项','回复／跟进状态'];
  const sourceRows=body.templateVersion===MAIL_TEMPLATE_VERSION?body.rows.filter(r=>['open','confirm'].includes(currentMailFollowUp(r.cells.at(-1)).tone)):body.rows;
  const records=sourceRows.map((r,index)=>{
    const label=`${r.documentLabels.join('、')||'材料待确认'}\n${r.objectLabel} · ${r.ruleLabel}`;
    if(format==='rounds')return [String(index+1),label,...r.cells.flatMap(c=>[c.action,c.reply||'尚无已选定的外部回复'])];
    const cell=r.cells.at(-1)!;
    return [label,cell.action,[cell.reply||'尚无已选定的外部回复',cell.issueStatus==='resolved'?'问题记录已关闭':cell.issueStatus==='acknowledged'?'已记录，仍须按要求核对':cell.issueStatus?'问题记录待处理':'未记录问题处置'].join('\n')];
  });
  const text=[`邮件标题：${body.subject}`,`客户／案件：${body.caseLabel}`,[body.notice,mailCoverageNotice(body)].filter(Boolean).join('\n'),headers.join('\t'),...records.map(r=>r.join('\t'))];
  const empty='当前结果中没有列出的待跟进事项。请核对检查范围及人工要求；此草稿不代表业务批准。';
  if(!records.length)text.push(empty);
  if(omittedMailReplies(body))text.push(omittedMailReplies(body));
  const e=(s:string)=>escapeMailHtml(s).replace(/\n/g,'<br>');
  const html=`<div><p>邮件标题：${e(body.subject)}</p><p>客户／案件：${e(body.caseLabel)}</p><p>${e([body.notice,mailCoverageNotice(body)].filter(Boolean).join('\n'))}</p><table style="border-collapse:collapse;width:100%"><thead><tr>${headers.map(h=>`<th style="border:1px solid #ccc;padding:8px;text-align:left">${e(h)}</th>`).join('')}</tr></thead><tbody>${records.map(r=>`<tr>${r.map(c=>`<td style="border:1px solid #ccc;padding:8px;vertical-align:top">${e(c)}</td>`).join('')}</tr>`).join('')}</tbody></table>${!records.length?`<p>${e(empty)}</p>`:''}</div>`;
  return {plainText:text.join('\n\n'),html:html+(omittedMailReplies(body)?`<p>${e(omittedMailReplies(body))}</p>`:'')};
}
