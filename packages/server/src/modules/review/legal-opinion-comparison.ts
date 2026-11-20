import type {CrossFileCheck,CrossFileValue} from '@hsbc/contracts/review-checklist';
import {legalSentences} from './legal-source-verification.js';

const unique=(values:string[])=>[...new Set(values)];
const plain=(value:string)=>value.replace(/<[^>]*>/gu,' ').replace(/\s+/gu,' ').trim();
const guarantee=/保证书|保證書|保证人|保證人|担保文件|擔保文件|\bguarantee\b|\bguarantor\b/iu;
const facility=/授信函|贷款协议|貸款協議|\bfacility\b|\bloan agreement\b/iu;
const sentences=legalSentences;

/** References are read from this opinion, never from a global document code list. */
function references(sources:CrossFileValue[],pattern:RegExp):string[] {
  return unique(sources.filter(s=>s.fieldId==='cgt_legal_references').flatMap(s=>s.values).flatMap(value=>{
    const text=plain(value);
    const code=/^([A-Z][A-Z0-9_-]{1,30})\s/iu.exec(text)?.[1];
    return code&&pattern.test(text)&&!(pattern===guarantee&&facility.test(text))?[code]:[];
  }));
}
function opinionClauses(source:CrossFileValue,sources:CrossFileValue[]):string[] {
  const own=sources.filter(s=>s.documentId===source.documentId);
  const guaranteeRefs=references(own,guarantee),facilityRefs=references(own,facility);
  return source.values.flatMap(sentences).filter(sentence=>{
    // A facility's different law is not a discrepancy in the guarantee.
    if(facility.test(sentence)||facilityRefs.some(ref=>sentence.startsWith(ref)))return false;
    if(guarantee.test(sentence)||guaranteeRefs.some(ref=>sentence.startsWith(ref)))return true;
    // Dedicated legal-choice extraction may omit the instrument name. General
    // reference prose must identify the guarantee explicitly.
    return source.fieldId==='cgt_legal_checklist_19'&&!/\b[A-Z]\d+\b/u.test(sentence);
  });
}

const regions=[
  {name:'香港',text:'(?:Hong Kong|香港)'},
  {name:'中国内地',text:'(?:the People[’\x27]s Republic of China|PRC|Mainland China|中国内地|中國內地|中华人民共和国|中華人民共和國)'},
  {name:'英格兰及威尔士',text:'(?:England and Wales|英格兰及威尔士|英格蘭及威爾士)'},
  {name:'新加坡',text:'(?:Singapore|新加坡)'},
];
type Aspect='law'|'court'|'jurisdiction';
function readAspect(clauses:string[],aspect:Aspect):string[] {
  return unique(clauses.flatMap(clause=>{
    // Negative, hypothetical and replacement wording cannot establish an
    // affirmative choice. Such text stays in the source for manual review.
    if(/\b(?:not|no|if|unless|may|might|would|previous|formerly|instead)\b|不适用|不適用|并非|並非|未选择|未選擇|并未|並未|尚未|若|如需|原为|原為|改为|改為|改用/iu.test(clause))return [];
    if(aspect==='jurisdiction') {
      const nonExclusive=/non[\s-]*exclusive\s+jurisdiction|非专属管辖|非專屬管轄/iu.test(clause);
      const rest=clause.replace(/non[\s-]*exclusive\s+jurisdiction|非专属管辖|非專屬管轄/giu,'');
      return [...(nonExclusive?['非专属管辖']:[]),...(/\bexclusive\s+jurisdiction|专属管辖|專屬管轄/iu.test(rest)?['专属管辖']:[])];
    }
    if(aspect==='law')return regions.filter(region=>new RegExp(`(?:laws? of\\s+(?:the\\s+)?${region.text}|${region.text}\\s*(?:law|法律|法))`,'iu').test(clause)).map(region=>region.name+'法');
    return [
      ...regions.filter(region=>new RegExp(`(?:${region.text}\\s*(?:courts?|法院)|courts? of\\s+(?:the\\s+)?${region.text})`,'iu').test(clause)).map(region=>region.name+'法院'),
      ...(/广州法院|廣州法院|Guangzhou courts?|courts? of Guangzhou/iu.test(clause)?['广州法院']:[]),
    ];
  }));
}

/** Pure read projection: uses fixed field evidence, no facts or legal approval. */
export function compareGuaranteeLegalOpinion(base:Omit<CrossFileCheck,'outcome'|'reason'>):CrossFileCheck {
  const guarantees=base.sources.filter(s=>s.fieldId==='cgt_field_5');
  const opinions=base.sources.filter(s=>s.fieldId==='cgt_legal_checklist_19'&&s.values.length);
  // Older releases may only have compound references. Fall back per document,
  // so a second opinion is never hidden by the first opinion's detailed field.
  opinions.push(...base.sources.filter(s=>s.fieldId==='cgt_legal_references'&&s.values.length&&!opinions.some(o=>o.documentId===s.documentId)));
  const inputs=[...guarantees,...opinions];
  const comparisons:NonNullable<CrossFileCheck['comparisons']>=(['law','court','jurisdiction'] as const).map(id=>{
    const label={law:'适用法律',court:'管辖法院',jurisdiction:'管辖方式'}[id];
    const observed=inputs.map(source=>({source,values:readAspect(source.fieldId==='cgt_field_5'?source.values.flatMap(sentences):opinionClauses(source,base.sources),id)}));
    const values=observed.map(({source,values})=>{
      const clauses=source.fieldId==='cgt_field_5'?source.values.flatMap(sentences):opinionClauses(source,base.sources);
      const quotes=clauses.filter(clause=>readAspect([clause],id).length);
      const verified=quotes.length>0&&quotes.every(quote=>source.verifiedQuotes?.some(q=>q.text===quote))&&
        ['available','uncertain'].includes(source.state)&&source.warnings.every(w=>['原文识别或段落拼接存在疑问','本字段提取范围尚未核查完整'].includes(w));
      return {sourceId:source.id,value:values.join(' / ')||'未能明确识别，请核对原文',quotes,verified};
    });
    const reliable=observed.filter(o=>(o.source.state==='available'||values.find(v=>v.sourceId===o.source.id)?.verified)&&o.source.documentId&&o.values.length===1);
    const definiteDifference=reliable.some(a=>a.source.fieldId==='cgt_field_5'&&reliable.some(b=>b.source.fieldId!=='cgt_field_5'&&a.values[0]!==b.values[0]));
    const complete=guarantees.some(s=>s.values.length)&&opinions.length>0&&observed.every(o=>o.values.length===1);
    const differs=complete&&unique(observed.flatMap(o=>o.values)).length>1;
    const quality=observed.some(o=>!o.source.documentId||o.source.state!=='available'&&!values.find(v=>v.sourceId===o.source.id)?.verified);
    const outcome=definiteDifference?'different':!complete?'insufficient':quality?'manual':differs?'different':'consistent';
    const reason=definiteDifference?`${label}的明确取值不同；请核对对应文书、版本和适用范围。`:
      !complete?`${label}尚未取得双方可明确对应的取值；保留已上传文件与原文，不能据此判断一致。`:
      quality?`${label}${differs?'取值不同':'取值相同'}，但来源仍有疑问，须核验后才能形成确定结论。`:
      differs?`${label}取值不同。`:`${label}一致${values.every(v=>v.verified)?'，双方引用已与固定版本原文互证':''}。`;
    return {id,label,outcome,reason,values};
  });
  const linked=opinions.some(s=>s.documentId);
  const reviewItems:NonNullable<CrossFileCheck['reviewItems']>=[];
  const itemRules=[
    {id:'approval',title:'确认银行内部法务批准',pattern:/不构成.{0,8}内部批准|不構成.{0,8}內部批准|internal.{0,12}approval/iu,action:'核对独立的银行内部批准记录是否已取得，以及是否覆盖本次保证书版本；律师意见不能替代该批准。'},
    {id:'activation',title:'确认授信启用条件的当前完成情况',pattern:/尚待签发|尚待簽發|启用复核仍须|啟用復核仍須|\bpending\b/iu,action:'核对意见出具后形成的文件和启用复核记录；意见中的“尚待”描述的是出具当日，不能据此认定现在仍然缺件。'},
    {id:'enforcement',title:'确认本次采用的执行路径',pattern:/不涵盖外国判决|不涵蓋外國判決|does not cover.{0,20}foreign/iu,action:'如需跨境承认或执行判决，确认相应司法辖区的补充法律意见；直接在香港主张权利与跨境执行须分别判断。'},
    {id:'changes',title:'确认意见出具后是否发生实质变更',pattern:/发生实质变更|發生實質變更|须重新核对|須重新核對/iu,action:'确认保证范围、版本、金额和执行方式是否仍与已审阅文件一致；有变更时重新核对法律意见及原批准。'},
  ];
  for(const source of base.sources.filter(s=>s.fieldId==='cgt_legal_conditions')){
    const clauses=source.values.flatMap(sentences);
    if(!clauses.length)reviewItems.push({id:`${source.id}:missing-conditions`,title:'补充核对法律意见的假设及限制',action:'尚未取得这部分条款，需从本份法律意见中补充核对；不影响上方已有依据的条款对照。',sourceId:source.id,quote:'未取得可定位的条款引用。',verified:false,evidence:source.evidence});
    for(const rule of itemRules){
      const quote=clauses.find(text=>rule.pattern.test(text.replace(/(?:无|無)尚待|无需|無需|无须|無須|\bno pending\b/giu,'')));
      if(!quote)continue;
      const verified=source.verifiedQuotes?.find(q=>q.text===quote);
      const approvalPart=/\b[A-Z]\d+\s*[甲乙丙丁]部/u.exec(quote)?.[0];
      const pendingDocument=/\b[A-Z]\d+(?=\s*尚待)/u.exec(quote)?.[0];
      const action=rule.id==='approval'&&approvalPart?`核对 ${approvalPart} 记载的银行内部批准是否已取得，以及是否覆盖本次保证书版本；律师意见不能替代该批准。`:rule.id==='activation'&&pendingDocument?`核对 ${pendingDocument} 及其他后续文件和启用复核记录；意见中的“尚待”描述的是出具当日，不能据此认定现在仍然缺件。`:rule.action;
      reviewItems.push({id:`${source.id}:${rule.id}`,title:rule.title,action,sourceId:source.id,quote,verified:!!verified,evidence:verified?.evidence??source.evidence});
    }
    // Unclassified obligations remain visible instead of being silently dropped.
    for(const text of clauses.filter(text=>/仍须|仍須|不构成.{0,8}批准|不構成.{0,8}批准|须重新|須重新|must be (?:obtained|reviewed)/iu.test(text))){
      if(reviewItems.some(item=>item.sourceId===source.id&&item.quote===text))continue;
      const verified=source.verifiedQuotes?.find(q=>q.text===text);
      reviewItems.push({id:`${source.id}:other:${reviewItems.length}`,title:'确认意见所列条件是否满足',action:'结合当前材料确认下列条件的完成情况。',sourceId:source.id,quote:text,verified:!!verified,evidence:verified?.evidence??source.evidence});
    }
  }
  const outcome=comparisons.some(c=>c.outcome==='different')?'different':comparisons.some(c=>c.outcome==='insufficient')?'insufficient':comparisons.some(c=>c.outcome==='manual')?'manual':'consistent';
  const allVerified=comparisons.every(c=>c.values.length>1&&c.values.every(v=>v.verified));
  const reason=!linked?'尚未取得可对应的法律意见条款；请检查法律意见的上传、提取结果和对象归属。':
    outcome==='consistent'?`适用法律、管辖法院和管辖方式三项一致，未发现这三项条款差异。${allVerified?'双方引用已逐句与固定版本原文互证。':''}法律意见的附带条件另列如下，不等同于预审通过。`:
    '已关联保证书与法律意见；各项差异及尚未核实的条款分别列示，不将未核实项目判为一致。';
  const manualReasons=unique(base.manualReasons.filter(r=>!r.includes('逐项核对适用法律')).map(r=>r.includes('对象归属')?'确认两份文件在本轮关联到同一担保人及保证书；条款一致不会自动完成材料归属。':r));
  return {...base,comparisons,outcome,reason,manualReasons,reviewItems};
}
