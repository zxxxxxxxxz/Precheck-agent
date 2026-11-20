import {createHash} from 'node:crypto';
import type {ChecklistRow} from '@hsbc/contracts/review-checklist';
import type {ReviewState} from '@hsbc/contracts/review';
import type {ReviewConfigManifest} from '@hsbc/contracts/review-config';
import {normalizeReviewValue} from './normalization.js';

export const GUARANTEE_AMOUNT_SOURCE='grounded_guarantee_amount';
/** A requirement input taken from what the files state, shown with its source and open to correction. */
export const REQUIREMENT_DEFAULT_SOURCE='requirement_source_default';
/** Whether the files call the guarantee limited or unlimited. Conditional or two-sided wording decides nothing. */
export function liabilityNature(raw:string):'limited'|'unlimited'|null {
  const text=raw.normalize('NFKC');
  if(/\b(?:if|unless|either|whether)\b|\b(?:un)?limited\s+or\s+(?:un)?limited\b|如果|除非|或者|是否|有限[额額]?\s*[或\/／]\s*无限|有限[额額]?\s*[或\/／]\s*無限/iu.test(text))return null;
  const unlimited=/\bunlimited\b|all\s+monies|无限额|無限額|全部债务|全部債務/iu.test(text);
  const limited=/\blimited\s+(?:amount|to|guarantee)\b|\bprincipal\s+cap\b|\bspecified\s+sum\b|\bnot\s+exceed(?:ing)?\b|\bup\s+to\b|\bcapped\b|有限额|有限額|不超过|不超過|以.{0,12}为限|以.{0,12}為限|最高额|最高額/iu.test(text.replace(/\bunlimited\b/giu,''));
  return unlimited===limited?null:unlimited?'unlimited':'limited';
}
/** Legacy combined fields may contain a labelled principal amount. Only a
 * single explicit amount/currency pair is usable; no facility sums, arithmetic,
 * exchange conversion, or liability classification are inferred. */
export function explicitGuaranteeAmount(raw:string) {
  const scalar=normalizeReviewValue(raw,'amount');
  if(scalar.status==='normalized'&&scalar.currency&&scalar.value&&!scalar.value.startsWith('-'))return scalar;
  if(/\b(?:if|unless|either|or)\b|如果|除非|或者/iu.test(raw))return;
  // Consume other amount labels too, so the Amount in Facility Amount cannot
  // be reinterpreted as a guaranteed principal. Clause numbers and interest
  // elsewhere in a grounded passage are not additional principal amounts.
  const markers=/(?:^|[\s;；。])((?:facility|loan) amount|facility limit|banking facilities|default interest|interest rate|授信额度|授信金额|贷款金额|利息|利率|guarantee(?:d)? amount|specified sum|principal cap|担保金额|擔保金額|指定金额|指定金額|指定本金|保证本金|amount)\s*(?:[:：=]|为|為|means|is|of)\s*/giu;
  const money=/^((?:USD|HKD|CNY|RMB|EUR|GBP|SGD|JPY|US\$|HK\$|美元|人民币|人民幣|港币|港幣)\s*(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?(?:\s*(?:万元|萬元|万|萬|亿|億|元))?)(?![.,]\d)(?!\s*(?:million|billion|thousand|[%％]))(?=$|[\s;；。，,（(—–-])/iu;
  const values=[];
  for(const marker of raw.matchAll(markers)){
    if(/facility|loan|banking|interest|授信|贷款|利息|利率/iu.test(marker[1]!))continue;
    const tail=raw.slice(marker.index!+marker[0].length),match=money.exec(tail);
    if(!match){
      // A reference such as "Specified Sum is a principal cap" supplies no
      // second amount; a malformed/unknown monetary declaration is a blocker.
      if(/^(?:[A-Z]{3}\b|[$¥￥€£]|\d)/iu.test(tail))return;
      continue;
    }
    const value=normalizeReviewValue(match[1]!,'amount');
    if(value.status!=='normalized'||!value.currency)return;
    values.push(value);
  }
  if(!values.length||new Set(values.map(value=>JSON.stringify([value.value,value.currency]))).size!==1)return;
  return values[0];
}

/** Whether the facility letter asks for a guarantee given by a company. The wording has to say that a company gives the
 * guarantee; wording that waives it, leaves it open or makes it depend on something decides nothing. */
export function corporateGuaranteeAsked(raw:string):boolean {
  const text=raw.normalize('NFKC').replace(/\s+/gu,' ');
  if(/不(?:需|必|要求|再|用|适用|適用)|[无無毋][需须須]|豁免|免除|\bno\b[^.;]{0,40}\bguarantee\b|\bguarantee\b[^.;]{0,60}\bnot\b(?!\s+(?:exceed|less|more|later|earlier))|\bnot\s+(?:be\s+)?(?:required|necessary|needed|applicable)\b|\bwaive[drs]?\b|\bwithout\b[^.;]{0,30}\bguarantee\b/iu.test(text))return false;
  if(/\b(?:if|unless|whether)\b|\bmay\b|如果|如需|除非|是否|或者/iu.test(text))return false;
  const company='(?:LIMITED|LTD|CORPORATION|CORP|INC|LLC|PLC|COMPANY)';
  return new RegExp(`(?:公司|${company}\\.?)\\s*[)）]?\\s*所?(?:出具|提供|签署|簽署|作出)(?:的|之)?.{0,80}(?:保证|保證|担保|擔保)`,'iu').test(text)||
    /(?:出具|提供|签署|簽署).{0,80}(?:公司保证|公司保證|公司担保|公司擔保)/u.test(text)||
    /\bcorporate\s+guarantee\b.{0,60}\b(?:from|by)\b/iu.test(text)||
    !/\bpersonal\s+guarantee\b/iu.test(text)&&new RegExp(`\\bguarantee\\b.{0,60}\\b(?:from|by)\\b.{0,80}\\b${company}\\b`,'iu').test(text);
}
/** Which of the two alternatives of the relationship manager's certificate is ticked. None, both, or a mark that cannot
 * be told apart decide nothing. */
export function tickedCertificateOption(raw:string):'a'|'b'|null {
  const ticked=new Set([...raw.normalize('NFKC').matchAll(/(?:[☒☑✓✔]|\[\s*[xX✓✔]\s*\]|\[SELECTED\])\s*\(?([ab])\)/gu)].map(match=>match[1]!.toLowerCase()));
  return ticked.size===1?[...ticked][0] as 'a'|'b':null;
}
const nameKey=(value:string)=>value.normalize('NFKC').toUpperCase().replace(/[\s,，.。、()（）"“”'‘’]/gu,'');
const COMPANY_NAME_FIELDS=['cgt_field_9','cgt_field_14','cgt_field_24','cgt_field_32','cgt_field_42','cgt_field_50','cgt_field_61','cgt_field_63'];
const REQUIREMENT_DEFAULT_FIELDS=new Set(['cgt_limited','cgt_required','cgt_rm_option','cgt_legal_route']);

/** What a reviewer would otherwise have to enter about the guarantee, taken from what the files state: whether it is
 * limited (facility letter, else the guarantee), whether the facility letter asks for a company's guarantee, which
 * alternative of the relationship manager's certificate is ticked, and that the legal opinion route applies when an
 * opinion was supplied. Only a current grounded fact of the same guarantor is used, the value carries that source, and
 * a person's own entry always takes its place. Nothing is ever read as "not required". */
export function withRequirementInputDefaults(rows:ChecklistRow[],manifest:ReviewConfigManifest,state:ReviewState):ChecklistRow[] {
  if(state.readOnly)return rows;
  // One guarantor in the case: what its files ask for can be about no one else.
  const sole=state.objects.filter(o=>o.role==='corporate_guarantee'&&o.validity==='current').length<=1&&
    new Set(rows.filter(r=>r.objectRole==='corporate_guarantee'&&r.objectId).map(r=>r.objectId)).size===1;
  return rows.map(row=>{
    if(row.fact||!row.objectId||row.objectRole!=='corporate_guarantee'||!REQUIREMENT_DEFAULT_FIELDS.has(row.fieldId))return row;
    const definition=manifest.fields.find(field=>field.id===row.fieldId),owner=state.objects.find(o=>o.objectId===row.objectId&&o.validity==='current');
    if(definition?.recipe.mode!=='manual'||!owner)return row;
    const fact=(id:string)=>{const found=rows.find(other=>other.objectId===row.objectId&&other.objectRole===row.objectRole&&other.fieldId===id)?.fact;
      return found?.automaticAdoption&&found.validity==='current'&&found.state==='present'&&found.normalization.status!=='pending'&&found.evidence.length&&found.rawValue?found:undefined;};
    let source:ReturnType<typeof fact>,value:string|null=null,reason='';
    if(row.fieldId==='cgt_limited'){
      for(const id of ['cgt_facility_guarantee_limit','cgt_facility_guarantee_terms','cgt_field_12']){
        const candidate=fact(id),read=candidate?liabilityNature(candidate.rawValue!):null;
        if(candidate&&read){source=candidate;value=read;break;}
      }
      // A guarantee that states one explicit guaranteed amount is a limited one.
      const amount=fact('cgt_amount');
      if(!value&&amount?.normalization.reasonCode===GUARANTEE_AMOUNT_SOURCE){source=amount;value='limited';}
      if(source)reason=`已按${source.fieldId.startsWith('cgt_facility')?'授信函':'保证书'}的表述取得担保责任范围，如与业务安排不符可更正。`;
    }else if(row.fieldId==='cgt_required'){
      // With several guarantors the letter has to name this one.
      const names=[owner.label??'',...COMPANY_NAME_FIELDS.map(id=>fact(id)?.rawValue??'')].map(nameKey).filter(name=>name.length>=4);
      const named=(text:string)=>{const key=nameKey(text);return names.some(name=>key.includes(name)||name.includes(key)&&key.length>=4);};
      for(const id of ['cgt_facility_guarantee_terms','cgt_facility_guarantee_limit']){
        const candidate=fact(id);
        if(candidate&&corporateGuaranteeAsked(candidate.rawValue!)&&(sole||named(candidate.rawValue!))){source=candidate;value='yes';break;}
      }
      const guarantor=fact('cgt_facility_guarantor');
      if(!value&&guarantor&&named(guarantor.rawValue!)){source=guarantor;value='yes';}
      if(source)reason='授信函写明由公司出具保证，已据此确认本案需要公司担保；如与审批不符可更正。';
    }else if(row.fieldId==='cgt_rm_option'){
      for(const id of ['cgt_field_36','cgt_rm_clauses']){
        const candidate=fact(id),read=candidate?tickedCertificateOption(candidate.rawValue!):null;
        if(candidate&&read){source=candidate;value=read;break;}
      }
      if(source)reason=`已按环球客户经理证明中勾选的选项取得（仅选 ${value}），如与原件不符可更正。`;
    }else{
      // A supplied opinion is the fullest of the three routes; a waiver on file leaves the choice to a person.
      const supplied=(type:string)=>(state.materials??[]).filter(material=>material.operation==='adopt'&&material.documentTypeId===type).map(material=>material.documentVersionId);
      const opinions=supplied('cgt_legal');
      source=supplied('cgt_waiver').length?undefined:['cgt_legal_checklist_1','cgt_legal_firm','cgt_legal_references'].map(fact).find(candidate=>candidate?.evidence.every(e=>opinions.includes(e.documentVersionId)));
      if(source){value='opinion';reason='已提供法律意见书，按法律意见路径核对配套材料；如本案适用简化流程或豁免批准，可更正。';}
    }
    if(!source||!value)return row;
    const digest=createHash('sha256').update(JSON.stringify([REQUIREMENT_DEFAULT_SOURCE,source.factId,source.version,row.fieldId,value,source.evidence])).digest('hex');
    return {...row,status:'extracted',reason,fact:{...source,
      factId:`${digest.slice(0,8)}-${digest.slice(8,12)}-5${digest.slice(13,16)}-a${digest.slice(17,20)}-${digest.slice(20,32)}`,
      fieldId:row.fieldId,definitionHash:undefined,rawValue:value,normalizedValue:value,currency:undefined,unit:undefined,
      normalization:{status:'normalized',reasonCode:REQUIREMENT_DEFAULT_SOURCE,currency:null,unit:null},confirmedBy:null,
      automaticAdoption:{...source.automaticAdoption!,values:[value]}}};
  });
}

/** Read projection only, reused by the existing review snapshot pipeline.
 * A current grounded source fact already passed ownership/quality checks.
 * User benchmarks, manual corrections and history are never inferred here. */
export function withGuaranteeAmountInputs(rows:ChecklistRow[],manifest:ReviewConfigManifest,state:ReviewState):ChecklistRow[] {
  if(state.readOnly)return rows;
  return rows.map(row=>{
    if(row.fact||!row.objectId||row.objectRole!=='corporate_guarantee'||!['cgt_amount','cgt_currency'].includes(row.fieldId))return row;
    const definition=manifest.fields.find(field=>field.id===row.fieldId);
    if(definition?.recipe.mode!=='manual')return row;
    const owner=state.objects.find(o=>o.objectId===row.objectId&&o.validity==='current');
    const source=rows.find(other=>other.objectId===row.objectId&&other.objectRole===row.objectRole&&other.fieldId==='cgt_field_12')?.fact;
    if(!owner||!source?.automaticAdoption||source.validity!=='current'||source.state!=='present'||source.normalization.status==='pending'||!source.evidence.length||!source.rawValue)return row;
    const amount=explicitGuaranteeAmount(source.rawValue);
    if(!amount?.value||!amount.currency)return row;
    const raw=row.fieldId==='cgt_amount'?`${amount.currency} ${amount.value}`:amount.currency;
    const normalized=normalizeReviewValue(raw,definition.type);
    if(normalized.status==='pending'||normalized.value===null)return row;
    const digest=createHash('sha256').update(JSON.stringify([GUARANTEE_AMOUNT_SOURCE,source.factId,source.version,row.fieldId,raw,source.evidence])).digest('hex');
    const {value,...normalization}=normalized;
    return {...row,status:'extracted',reason:'已从当前保证书的明确金额自动取得，可用于后续规则计算。',fact:{...source,
      factId:`${digest.slice(0,8)}-${digest.slice(8,12)}-5${digest.slice(13,16)}-a${digest.slice(17,20)}-${digest.slice(20,32)}`,
      fieldId:row.fieldId,definitionHash:undefined,rawValue:raw,normalizedValue:value,currency:amount.currency,
      normalization:{...normalization,reasonCode:GUARANTEE_AMOUNT_SOURCE},confirmedBy:null,
      automaticAdoption:{...source.automaticAdoption,values:[raw]}}};
  });
}
