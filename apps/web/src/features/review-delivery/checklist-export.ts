import {currentMailFollowUp,mailFollowUp,type MailDraft,type MailCell} from '@hsbc/contracts/review-delivery';
import {formatTime} from '../../shared/format.ts';
import {checklistXlsx,type ChecklistTone,type ChecklistWorkbook} from './checklist-xlsx.ts';

const labels:Record<ChecklistTone,string>={problem:'有问题',pending:'待确认',incomplete:'检查未完成',clear:'检查无误',not_applicable:'不适用 / 无需跟进'};
const order:ChecklistTone[]=['problem','pending','incomplete','clear','not_applicable'];
function classification(cell:MailCell|undefined,version:string):ChecklistTone {
  if(!cell?.outcome)return 'incomplete';
  // Newer saved drafts may carry this tone before the local MailTone union is upgraded.
  if(cell.outcome!=='fail'&&['incomplete'].includes(cell.assessment?.tone??''))return 'incomplete';
  const follow=['pre-review-mail.v4','pre-review-mail.v5'].includes(version)?currentMailFollowUp(cell):mailFollowUp(cell);
  if(follow.tone==='open')return 'problem';
  if(follow.tone==='confirm')return 'pending';
  if(follow.tone!=='done')return 'pending';
  return cell.outcome==='not_applicable'?'not_applicable':'clear';
}

/** Export the immutable draft, never merge it with live field confirmations or other runs. */
export function reviewChecklistWorkbook(draft:MailDraft):ChecklistWorkbook {
  const round=draft.body.rounds.find(r=>r.runId===draft.runId);
  const rows=draft.body.rows.map(row=>{
    const cell=row.cells.find(c=>c.runId===draft.runId),tone=classification(cell,draft.body.templateVersion);
    return {tone,values:[labels[tone],row.objectLabel,row.documentGroup||row.documentTypes?.join('、')||'未分类',row.documentLabels.join('\n'),row.ruleLabel,
      cell?.fieldReviewText?.conclusion||cell?.summary||cell?.action||'本轮未保存有效检查结果，不能确认为无误。',
      cell?.fieldReviewText?.followUp||cell?.action||'请完成本项检查。',cell?.reply||'',row.sourceReferences.join('\n'),row.ruleId]};
  }).sort((a,b)=>order.indexOf(a.tone)-order.indexOf(b.tone));
  const counts=order.map(tone=>`${labels[tone]} ${rows.filter(r=>r.tone===tone).length} 项`).join('；');
  const validity={current:'当前草稿',history:'历史轮次草稿，仅供回看',stale:'来源已有更新，仅供回看，不代表当前结果'}[draft.validity];
  const confirmation=draft.checkerPending?`待独立复核 · 第 ${draft.checkerPending.submissionNumber} 次提交`:draft.checkerConfirmation?`${draft.checkerConfirmation.validity==='current'?'已独立复核':'历史已复核'} · ${formatTime(draft.checkerConfirmation.confirmedAt)}`:'尚未独立复核';
  return {
    notes:['预审检查清单',`客户／案件：${draft.body.caseLabel}　｜　${round?.label??'所选预审轮次'}　｜　草稿版本 ${draft.version}`,
      `版本状态：${validity}　｜　${confirmation}　｜　生成时间：${formatTime(draft.createdAt)}`,
      `合计 ${rows.length} 项（逐条检查，未合并）：${counts}`,
      '颜色：红色＝有问题；绿色＝检查无误；黄色＝待确认；灰色＝检查未完成或不适用。以文字结论为准。',
      ['范围：本清单保留所选草稿生成时的全部检查项及理由；后续字段确认不会自动更新此版本。',draft.body.notice,...draft.staleReasons].filter(Boolean).join('\n'),
      `案件 ID：${draft.caseId}　｜　预审 ID：${draft.runId}　｜　草稿 ID：${draft.id}`],
    headers:['序号','结论','检查对象','文件类型','文件名称','检查项','理由 / 核对结果','跟进要求','已选外部回复','规则依据','规则标识'],
    widths:[8,24,28,22,30,34,64,56,36,40,32],
    rows:rows.map((row,index)=>({...row,values:[index+1,...row.values]})),
  };
}
export function reviewChecklistFilename(draft:MailDraft):string {
  const round=draft.body.rounds.find(r=>r.runId===draft.runId);
  const safe=(value:string)=>value.replace(/[<>:"/\\|?*\x00-\x1f\x7f]/g,'_').replace(/[. ]+$/g,'').slice(0,70)||'预审';
  return `${safe(draft.body.caseLabel)}_${safe(round?.label??'预审结果')}_v${draft.version}_检查清单.xlsx`;
}
export function reviewChecklistXlsx(draft:MailDraft):Uint8Array<ArrayBuffer> {return checklistXlsx(reviewChecklistWorkbook(draft));}
