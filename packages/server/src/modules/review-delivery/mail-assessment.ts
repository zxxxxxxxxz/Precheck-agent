import {translationRequirementDisabled} from '../review/requirement-policy.js';
import type {FrozenFieldReview} from '@hsbc/contracts/field-verification';
import type {MailRow,MailCell} from '@hsbc/contracts/review-delivery';
import {currentMailFollowUp} from '@hsbc/contracts/review-delivery';
import type {MailSourceRun} from './mail.js';

const labels={confirmed:'已确认',consistent:'一致',different:'有差异',pending:'待确认',not_applicable:'不适用'};
function fieldAssessment(field:FrozenFieldReview):NonNullable<MailCell['assessment']>{
  const v=field.verification;
  if(v.validity!=='current')return {tone:'confirm',label:'待确认：原核对依据已有变化'};
  return {tone:v.status==='different'?'open':v.status==='pending'?'confirm':'done',label:`字段核对：${labels[v.status]}`};
}
/** Reconcile the customer projection only. Never replace rule outcomes or issue dispositions. */
export function assessMailRows(rows:MailRow[],runs:MailSourceRun[],names:Record<string,string>,aliases:Record<string,string>={}){
  const represented=new Set<string>();
  for(const row of rows){
    // Specialist findings keep their full independent explanation and evidence.
    if(row.ruleId.startsWith('formal:')||row.ruleId.startsWith('signature:')){
      for(const cell of row.cells)cell.assessment=currentMailFollowUp(cell);
      continue;
    }
    const definitions=runs.map(run=>run.configuration?.manifest.rules.find(r=>r.id===row.ruleId));
    const inputs=definitions.filter(Boolean).map(r=>r!.inputs);
    if(inputs.length&&inputs.every(ids=>ids.length===1&&ids[0]===inputs[0]![0])){
      // A changed rule occupying a different set of rounds is kept separate by the renderer.
      row.consolidationKey=JSON.stringify(inputs[0]);
    }
    row.cells.forEach((cell,index)=>{
      const run=runs[index]!,rule=definitions[index],result=run.results.find(r=>r.ruleId===row.ruleId&&(aliases[r.scopeId]??r.scopeId)===(aliases[row.objectId]??row.objectId));
      const valid=run.state==='ready'&&run.validity==='current'&&!!cell.outcome;
      cell.assessment=currentMailFollowUp(cell);
      if(!valid||!rule||!result)return;
      if(rule.inputs.length!==1){
        const related=(run.snapshot?.fieldReviews??[]).filter(f=>rule.inputs.includes(f.fieldId)&&(f.objectId===result.scopeId||f.objectId===null&&result.scopeId.startsWith('unconfirmed:')));
        const different=related.filter(f=>f.verification.validity==='current'&&f.verification.status==='different');
        const uncertain=related.filter(f=>f.verification.validity!=='current'||f.verification.status==='pending');
        if(different.length||uncertain.length){
          for(const field of [...different,...uncertain])represented.add(JSON.stringify([index,field.id]));
          cell.assessment={tone:cell.outcome==='fail'||different.length?'open':'confirm',label:different.length?'相关字段有差异，需重新检查':'相关字段待确认'};
          const prompt=`${row.ruleLabel}：${different.length?'相关字段核对有差异':'相关字段尚待确认'}（${(different.length?different:uncertain).map(f=>f.label).join('、')}），请完成字段核对后重新检查。`;
          cell.summary=cell.action=cell.outcome==='fail'?`${cell.summary??cell.action}\n${prompt}`:prompt;
        }else if(related.length&&cell.outcome==='blocked'){
          cell.summary=cell.action=`${row.ruleLabel}：${related.map(f=>`${f.label}已完成字段核对`).join('；')}。请确认本项业务检查所需的采用值及适用范围。`;
        }
        return;
      }
      const matches=(run.snapshot?.fieldReviews??[]).filter(f=>f.fieldId===rule.inputs[0]&&(f.objectId===result.scopeId||f.objectId===null&&result.scopeId.startsWith('unconfirmed:')));
      if(matches.length!==1)return;
      const field=matches[0]!,v=field.verification,assessment=fieldAssessment(field);
      represented.add(JSON.stringify([index,field.id]));
      const status=`${field.label}：${assessment.label}。`;
      const current=v.validity==='current',established=current&&['confirmed','consistent','not_applicable'].includes(v.status);
      // A verified source cannot establish satisfaction of an independent bank rule,
      // applicability, or material attribution. Keep these tasks, but do not claim
      // the already-reviewed field is absent.
      const remaining=cell.outcome==='fail'?`规则检查发现差异（${row.ruleLabel}），请核对并更正或补充依据。`
        :established&&cell.outcome==='blocked'?(result.scopeId.startsWith('unconfirmed:')?'材料归属及业务适用性尚待确认。':`业务要求尚待确认（${row.ruleLabel}）。`)
        :established&&cell.manualConfirmation?`业务要求尚待确认（${row.ruleLabel}）。`
        :current&&v.status==='different'?'请按已保存的字段核对结论更正或补充依据。'
        :!current?'请重新核对原文及适用范围。'
        :v.status==='pending'?'请完成本项字段核对。':'';
      cell.summary=cell.action=status+remaining;
      cell.fieldReviewText={conclusion:status,followUp:remaining};
      // A true rule failure or a confirmed field difference always remains visible.
      if(cell.outcome==='fail'||assessment.tone==='open')cell.assessment={tone:'open',label:'发现问题：需更正或补充依据'};
      else if(assessment.tone==='confirm'||cell.assessment.tone==='confirm')cell.assessment={tone:'confirm',label:established?`${assessment.label}；业务待确认`:assessment.label};
      else cell.assessment=assessment;
      for(const source of v.sources){const e=source.evidence;
        if(!row.evidence.some(other=>JSON.stringify(other)===JSON.stringify(e)))row.evidence.push(e);
        if(!row.documentIds.includes(e.documentVersionId)){row.documentIds.push(e.documentVersionId);row.documentLabels.push(names[e.documentVersionId]??source.filename);}
      }
    });
  }
  // Fields without a deterministic rule are still part of the saved review.
  const extra=new Map<string,MailRow>();
  runs.forEach((run,index)=>{for(const field of run.snapshot?.fieldReviews??[]){
    if(translationRequirementDisabled(field.fieldId,run.snapshot?.requirementPolicy))continue;
    // Automatic source observations are coverage evidence, not another task.
    // Their business requirements are represented by automaticChecks/rule rows.
    if(field.verification.origin==='automatic'&&(field.verification.status!=='different'||
      run.snapshot?.automaticChecks?.some(check=>check.fieldId===field.fieldId&&check.objectId===field.objectId&&check.ruleIds.length)))continue;
    if(represented.has(JSON.stringify([index,field.id])))continue;
    const key=JSON.stringify(['field',field.objectId?(aliases[field.objectId]??field.objectId):field.id,field.fieldId,run.configuration?.manifest.fields.find(f=>f.id===field.fieldId)]);
    let row=extra.get(key);
    if(!row){row={key,ruleId:`field:${field.fieldId}`,objectId:field.objectId??`unassigned:${field.id}`,objectLabel:field.objectLabel,ruleLabel:field.label,documentGroup:field.materialTypes.map(t=>t.label).join('、'),documentIds:[],documentLabels:[],sourceReferences:[],evidence:[],cells:runs.map(r=>({runId:r.runId,roundId:r.roundId,roundNumber:r.roundNumber,outcome:null,action:'本轮尚无此项核对结论。',summary:'本轮尚无此项核对结论。',reply:'',issueIds:[],replyIds:[],issueStatus:null}))};extra.set(key,row);}
    const cell=row.cells[index]!,valid=run.state==='ready'&&run.validity==='current',assessment=valid?fieldAssessment(field):{tone:'confirm' as const,label:'待确认：检查未完成'};
    cell.assessment=assessment;cell.outcome=valid?'manual':null;
    cell.action=cell.summary=`${field.label}：${assessment.label}。`;
    for(const source of field.verification.sources){row.evidence.push(source.evidence);if(!row.documentIds.includes(source.evidence.documentVersionId)){row.documentIds.push(source.evidence.documentVersionId);row.documentLabels.push(names[source.evidence.documentVersionId]??source.filename);}}
  }});
  rows.push(...extra.values());
}
