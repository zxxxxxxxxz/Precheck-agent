import {gapDecision,isBusinessSource} from './field-gap-guidance.ts';
import {needsSemanticAnalysis} from './cross-file-semantic-queue.ts';
import {comparisonSource,type CrossFileCheck} from '@hsbc/contracts/review-checklist';
import {focusedSourceReading} from './cross-file-presentation.ts';
import {focusKind,type FieldFocus} from './field-focused-reading.ts';
import {fieldLiteralDecision,decisionStep as step,type DecisionStep} from './field-literal.ts';

export type MeaningFilter='consistent'|'equivalent'|'different'|'pending'|'insufficient';
export interface MeaningDecision extends DecisionStep {result:MeaningFilter|'not_applicable'}
const result=(kind:MeaningDecision['result'],label:string,note:string):MeaningDecision=>({...step(label,note,kind==='consistent'||kind==='equivalent'?'pass':kind==='different'?'attention':kind==='not_applicable'?'neutral':'pending'),result:kind});
const defaultFocus=(check:CrossFileCheck):FieldFocus=>({fieldId:check.fieldIds[0]??'',label:check.label});
function sourcesFor(check:CrossFileCheck){
  return check.sources.map(comparisonSource).filter(s=>s.documentId&&(!check.comparisons?.length||check.comparisons.some(c=>c.values.some(v=>v.sourceId===s.id))));
}
/** Compare the displayed wording separately from normalized dates/amounts and meaning. */
export function wordingDiffers(check:CrossFileCheck,focus=defaultFocus(check)) {
  const sources=sourcesFor(check);
  const values=sources.map(s=>focusedSourceReading(check,s,focus).values);
  return new Set(sources.map(s=>s.documentId)).size>1&&values.every(v=>v.length>0)&&new Set(values.map(v=>JSON.stringify([...new Set(v.map(t=>t.trim()))].sort()))).size>1;
}
function agrees(check:CrossFileCheck,focus:FieldFocus,note:string):MeaningDecision {
  return wordingDiffers(check,focus)?result('equivalent','语义一致，字面不同',note):result('consistent','语义一致',note);
}
function completeCitations(check:CrossFileCheck){
  const citations=check.semantic?.citations??[];
  return citations.length>0&&citations.every(c=>!!c.quote.trim()&&c.evidence.length>0)&&sourcesFor(check).every(s=>
    citations.some(c=>c.evidence.some(e=>e.documentVersionId===s.documentId&&s.evidence.some(pin=>pin.documentVersionId===e.documentVersionId&&pin.parseRevision===e.parseRevision&&pin.directoryRevision===e.directoryRevision))));
}
/** One evidence-based meaning result for every field, list entry and filter.
 * No business rule approval, translated guess or simulated result establishes equivalence. */
export function checkMeaningDecision(check:CrossFileCheck,focus=defaultFocus(check)):MeaningDecision {
  check={...check,sources:check.sources.map(comparisonSource)};
  if(check.bankRule||check.checklistRule){
    if(check.semantic?.state==='pending'||needsSemanticAnalysis(check))return result('pending','核对中','正在按银行要求核对提取值');
    if(check.semantic&&['failed','unavailable'].includes(check.semantic.state))return result('insufficient','核对未完成',check.semantic.reason);
    if(check.outcome==='not_applicable')return result('not_applicable','不适用',check.reason);
    if(check.outcome==='different')return result('different','发现差异',check.reason);
    if(check.sources.some(s=>s.state==='processing'))return result('pending','核对中',check.reason);
    if(check.sources.some(s=>s.state==='uncertain'||s.state==='available'&&s.warnings.length))return result('insufficient','核对未完成',check.reason);
    const gap=gapDecision([check]);
    if(gap)return result(gap.label==='需人工确认'?'pending':'insufficient',gap.label,gap.note);
    if(['insufficient','single_source'].includes(check.outcome)||check.sources.some(s=>s.state==='missing'&&!isBusinessSource(s)))return result('insufficient','核对未完成',check.reason);
    return check.outcome==='consistent'?result('consistent','符合本条要求',check.reason):result('pending','需人工确认',check.reason);
  }
  if(check.outcome==='not_applicable')return result('not_applicable','不适用','本项适用条件不成立');
  if(check.sources.some(s=>s.state==='processing'))return result('pending','等待提取完成','尚未形成完整核对依据');
  if(check.comparisons?.length){
    const verified=check.comparisons.every(c=>c.values.length>1&&c.values.every(v=>v.verified&&check.sources.some(s=>s.id===v.sourceId&&s.verifiedQuotes?.length)));
    if(!verified)return result('pending','条款待核验','引用或对应条款尚未完整核实');
    if(check.comparisons.some(c=>c.outcome==='different'))return result('different','语义存在差异','已核验的对应条款存在实质差异');
    if(check.comparisons.every(c=>c.outcome==='consistent'))return agrees(check,focus,'已核对所列条款，业务条件另行确认');
    return result('pending','待语义核对','部分条款仍需核对');
  }
  if(check.sources.some(s=>['missing','uncertain'].includes(s.state)||s.warnings.length))return result('insufficient','证据不足','来源缺失或仍有核验疑问');
  if(['insufficient','single_source'].includes(check.outcome))return result('insufficient','证据不足','对应依据尚未齐备');
  if(check.id.endsWith(':personal-identity'))return result('pending','核对证件归属与类型','号码字面相同不代表属于同一人；先确认本担保人的证件，再执行号码核对');
  const literal=fieldLiteralDecision([check],focus),kind=focusKind(focus);
  // Exact value normalization is sufficient evidence, even across languages;
  // semantic advice must never erase a numeric/date/currency discrepancy.
  if(kind!=='text'&&['equal','text','manual'].includes(check.method)&&sourcesFor(check).every(s=>s.state==='available'&&!s.warnings.length)){
    if(['金额数字相同','日期相同','币种相同'].includes(literal.label))return agrees(check,focus,literal.note);
    if(['金额数字不同','日期不同','币种不同'].includes(literal.label))return result('different','语义存在差异',literal.label);
    return result('pending','待语义核对',literal.note);
  }
  if(/编号|号码|证件|身份证|护照|登记号|注册号|账号|帳號|\b(?:identifier|passport|reference\s*(?:no|number))\b/iu.test(focus.label)){
    if(literal.label==='字面一致')return agrees(check,focus,'编号取值相同');
    if(literal.label==='字面不同')return result('different','语义存在差异','编号取值不同，不能以译名或语义近似消除差异');
    return result('pending','待语义核对',literal.note);
  }
  const semantic=check.semantic;
  if(semantic){
    if(semantic.state==='pending')return result('pending','语义核对中','正在结合对应原文核对含义');
    if(semantic.state!=='complete'||semantic.simulated||!completeCitations(check))return result('pending','语义尚未确认',semantic.simulated?'模拟结论不作为审核依据':'尚无覆盖双方固定版本原文的完整结论');
    if(semantic.outcome==='consistent')return agrees(check,focus,'双方原文含义相同，业务条件另行确认');
    if(semantic.outcome==='different')return result('different','语义存在差异','原文含义存在差异，需核对处置');
    return result(semantic.outcome==='insufficient'?'insufficient':'pending',semantic.outcome==='insufficient'?'证据不足':'保留人工判断','当前原文尚不能支持确定结论');
  }
  if(check.method==='text'&&check.outcome==='different')return result('pending','待语义核对','文字不同，尚未确认含义是否相同');
  if(check.method!=='manual'&&check.outcome==='consistent')return agrees(check,focus,'本项对照成立，业务条件另行确认');
  if(check.method!=='manual'&&check.outcome==='different')return result('different','语义存在差异','对照取值或适用条件不同');
  return result('pending','保留人工判断','条款、适用条件或业务值尚待确认');
}
export function fieldMeaningDecision(checks:CrossFileCheck[],focus?:FieldFocus):MeaningDecision {
  const decisions=checks.map(c=>checkMeaningDecision(c,focus));
  for(const kind of ['different','insufficient','pending','equivalent','consistent','not_applicable'] as const){
    const found=decisions.find(d=>d.result===kind);if(found)return found;
  }
  return result('pending','尚无检查结论','提取值需结合规则基准核对');
}
export function matchesMeaningFilter(decision:MeaningDecision,filter:MeaningFilter){
  return filter==='consistent'?['consistent','equivalent'].includes(decision.result):decision.result===filter;
}
