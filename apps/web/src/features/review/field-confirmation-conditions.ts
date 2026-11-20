import {sourceGap} from './field-gap-guidance.ts';
import {missingSourceEvidence} from './field-automatic-comparison.ts';
import type {ChecklistRow,CrossFileCheck} from '@hsbc/contracts/review-checklist';
import type {ReviewState} from '@hsbc/contracts/review';

export interface FieldCondition {id:string;label:string;detail:string;fieldId?:string;kind:'confirmation'|'evidence'|'processing'|'workflow'}
const generic=/^(?:本项有适用条件|本项适用条件尚待确认|已汇集对应字段|该字段包含人工业务核对|请结合规则条件|此项由人工确认|对象归属尚未确认|对象归属依据已失效|有限额担保仅与用户|这些值承担不同|核对适用条件$|待业务确认$)/u;
const unique=<T extends {id:string}>(values:T[])=>[...new Map(values.map(value=>[value.id,value])).values()];

/** Unresolved business decisions stay visible even when a file comparison succeeds. */
export function fieldConfirmationConditions(row:ChecklistRow,state:ReviewState,checks:CrossFileCheck[]):FieldCondition[] {
  const conditions:FieldCondition[]=[];
  const owner=state.objects.find(o=>o.objectId===row.objectId);
  if(!owner||owner.validity!=='current')conditions.push({id:'ownership',kind:'workflow',label:owner?'重新确认材料归属':'确认材料归属',detail:'确认文件对应的主体及本笔业务，随后采用可靠的提取值进行检查。'});
  for(const check of checks){
    if(check.outcome==='not_applicable')continue;
    for(const source of check.sources){
      const gap=sourceGap(source);
      if(gap&&!['cgt_amount','cgt_currency'].includes(source.fieldId)){
        conditions.push({id:`source:${source.id}`,fieldId:gap.kind==='confirmation'?source.fieldId:undefined,kind:gap.kind==='confirmation'?'confirmation':'evidence',label:gap.summary,detail:gap.kind==='confirmation'&&source.fieldId===row.fieldId?row.rules.filter(rule=>rule.id!==`${row.fieldId}_required`).map(rule=>rule.text).filter(Boolean).join('；')||gap.action:gap.action});
        continue;
      }
      if(source.state==='pending_confirmation'){
        if(['cgt_amount','cgt_currency'].includes(source.fieldId)){
          conditions.push({id:`field:${source.fieldId}`,fieldId:owner?.validity==='current'?source.fieldId:undefined,kind:owner?.validity==='current'?'evidence':'workflow',label:`取得明确的${source.label.replace('（已确认）','')}`,
            detail:owner?.validity==='current'?'当前原文尚不能提供唯一、明确的金额及币种，请核实取值；系统可自动采用有可靠依据的明确取值。':'确认材料归属后，系统自动采用保证书中有可靠依据的明确金额及币种；取值有歧义时才需确认。'});
          continue;
        }
        const fieldRequirement=source.fieldId===row.fieldId?row.rules.filter(rule=>rule.id!==`${row.fieldId}_required`).map(rule=>rule.text).filter(Boolean).join('；'):undefined;
        const benchmark=/^(?:cgt_(?:user_)?required_(?:amount|currency))$/u.test(source.fieldId);
        conditions.push({id:`field:${source.fieldId}`,fieldId:source.fieldId,kind:'confirmation',label:`确认${source.label}`,
          detail:benchmark?'确认本次采用的要求金额及币种；可以采用授信函中的明确取值，或填写本次审批要求。':source.fieldId==='cgt_limited'?'确认本笔担保适用有限额还是无限额条款，区分指定本金与另计利息、费用。':fieldRequirement||`「${source.label}」尚无可用于本项规则的有效值，请确认对应取值。`});
      }else if(source.state==='processing')conditions.push({id:`source:${source.id}`,kind:'processing',label:`等待${source.filename}提取完成`,detail:`「${source.label}」完成提取后自动重新核对。`});
      else if(source.state==='missing'||source.state==='uncertain'||!source.values.length||source.warnings.length||missingSourceEvidence(source))conditions.push({id:`source:${source.id}`,kind:'evidence',label:`${source.state==='uncertain'||source.warnings.length?'核实':'补齐'}${source.filename}的${source.label}`,detail:source.warnings.join('；')||'对应取值缺失或依据存疑，需补齐并核实原文。'});
    }
    if(['insufficient','single_source'].includes(check.outcome)&&!check.sources.some(source=>source.state!=='available'||source.warnings.length||missingSourceEvidence(source)||!source.values.length)){
      conditions.push({id:`comparison:${check.id}`,kind:'evidence',label:check.outcome==='single_source'?`补齐${check.label}的对照文件`:`明确${check.label}的比较取值`,detail:check.reason});
    }
    const semantic=check.semantic;
    if(semantic&&!(semantic.state==='complete'&&!semantic.simulated&&semantic.citations.length&&semantic.citations.every(c=>c.evidence.length)&&['consistent','different'].includes(semantic.outcome))){
      conditions.push({id:`semantic:${check.id}`,kind:semantic.state==='pending'?'processing':semantic.state==='complete'&&!semantic.simulated&&semantic.citations.length&&semantic.citations.every(c=>c.evidence.length)&&semantic.outcome==='manual'?'confirmation':'evidence',label:semantic.state==='pending'?`等待${check.label}语义核对`:`核实${check.label}的语义依据`,detail:semantic.simulated?'尚无可用于审核的正式结论，需核实原文依据。':semantic.state==='failed'?'本次语义核对未完成，请重试或人工核实原文。':semantic.state==='unavailable'?'暂无法完成语义核对，需人工核实对应原文。':semantic.reason||'原文依据尚不完整，需补齐并核实对应关系。'});
    }
    const settled=check.outcome==='consistent'||semantic?.state==='complete'&&!semantic.simulated&&semantic.outcome==='consistent'&&semantic.citations.length&&semantic.citations.every(c=>c.evidence.length);
    const details=[...(!settled||check.method==='manual'?check.manualReasons:[]),...(check.outcome==='manual'&&(!settled||check.method==='manual')?[check.reason]:[])].filter(detail=>detail&&!generic.test(detail)&&!detail.includes('尚待确认或生成')&&!detail.includes('尚未确认用户要求的担保金额'));
    for(const detail of new Set(details)){
      const field=check.sources.find(source=>source.state==='pending_confirmation'&&detail.includes(`「${source.label}」`));
      const existing=field&&conditions.find(condition=>condition.fieldId===field.fieldId);
      if(existing){existing.detail=detail;continue;}
      conditions.push({id:`clause:${detail}`,kind:'confirmation',label:`确认${check.label}的适用条件`,detail});
    }
  }
  // A single-source field may have no cross-file group. Its own business rules
  // remain actionable instead of a generic manual fallback (e.g. signing authority).
  if(!checks.length||checks.some(c=>c.method==='manual'&&c.outcome!=='not_applicable')&&!conditions.some(c=>c.id!=='ownership')){
    for(const rule of row.rules.filter(r=>r.id!==`${row.fieldId}_required`&&!checks.some(check=>check.id.endsWith(`rule:${r.id}`)&&check.method!=='manual'&&['consistent','not_applicable'].includes(check.outcome))))conditions.push({id:`rule:${rule.id}`,kind:'confirmation',label:`核对${rule.label}`,detail:rule.text||`确认「${row.label}」是否满足「${rule.label}」。`});
  }
  return unique(conditions);
}
