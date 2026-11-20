import {createHash} from 'node:crypto';
import type {ReviewFieldDefinition} from '@hsbc/contracts/review-config';
import type {DocumentPageArtifact} from '@hsbc/contracts/documents';
import {normalizeReviewValue} from '../review/normalization.js';
import {partyNameSectionEvidence} from './labelled-company-names.js';
import {labelledTableAmount} from './labelled-table-values.js';

const fold=(text:string)=>text.normalize('NFKC').replace(/\s/gu,'').toLowerCase();
const currencyToken=/^(?:人民币|人民幣|美元|美金|港币|港幣|港元|港圓|新台币|新臺幣|日元|日圆|日圓|欧元|歐元|英镑|英鎊|新加坡元|Hong Kong Dollars?|United States Dollars?|US Dollars?|Renminbi|Chinese Yuan|Euros?|Pounds? Sterling|Singapore Dollars?|Japanese Yen|CNY|RMB|USD|HKD|TWD|EUR|GBP|SGD|JPY|US\$|HK\$|NT\$|S\$|€|£)(?=$|[\s:：,，;；])/iu;
const genericParty=/^(?:the\s+)?(?:financial\s+institutions?|banks?|lenders?|borrowers?|directors?|company|corporation|金融机构|金融機構|银行|銀行|公司|借款人|贷款人|貸款人|董事)$/iu;
// Keep the printed calendar prefix in the source span; a bare three-digit year
// is ambiguous and must never be inferred to use the ROC calendar.
const dateValue=/(?:(?:中华民国|中華民國|民国|民國)\s*\d{1,3}\s*年\s*\d{1,2}\s*月\s*\d{1,2}\s*日?|\d{4}\s*年\s*\d{1,2}\s*月\s*\d{1,2}\s*日?|\d{4}[-/.]\d{1,2}[-/.]\d{1,2}|\d{1,2}\s+[A-Za-z]{3,9}\s+\d{4}|[A-Za-z]{3,9}\s+\d{1,2},?\s+\d{4})/gu;
export function normalizeExtractedValue(raw:string,type:string):string|null {
  if(type==='date')return normalizeReviewValue(raw.replace(/(?<=\d)\s*(?=[年月日])/gu,'').replace(/(?<=[年月])\s*(?=\d)/gu,''),type).value;
  if(type==='currency')return normalizeReviewValue(raw.replace(/\s/gu,''),type).value;
  if(type==='amount'){
    const amount=/^(?:([A-Z]{3})\s*)?([+-]?(?:\d+|\d{1,3}(?:,\d{3})+)(?:\.\d+)?)\s*(?:([A-Z]{3}))?$/u.exec(raw.trim());
    if(amount){
      const codes=[amount[1],amount[3]].filter((v):v is string=>!!v).map(v=>normalizeExtractedValue(v,'currency'));
      if(codes.some(v=>!v)||new Set(codes).size>1)return null;
      return amount[2]!.replace(/,/g,'');
    }
    return normalizeReviewValue(raw,type).value;
  }
  return raw.trim();
}
/** V2 numeric projection only. A currency symbol never establishes its currency. */
export function normalizeDocumentV2Value(raw:string,type:string,valueKind?:ReviewFieldDefinition['valueKind']):string|null {
  // V2 retains an explicitly printed clock boundary in raw/display evidence.
  // Its normalized date remains compatible with existing date comparisons;
  // 24时 is not silently changed to the following calendar date.
  if(type==='date'){
    const timed=/^(\d{4}[ \t]*年[ \t]*\d{1,2}[ \t]*月[ \t]*\d{1,2}[ \t]*日)[ \t]*(?:[01]\d|2[0-4]|\d)[ \t]*[时時]$/u.exec(raw);
    if(timed)return normalizeExtractedValue(timed[1]!,'date');
  }
  const existing=normalizeExtractedValue(raw,type);
  if(existing!==null||type!=='amount'||valueKind!=='amount')return existing;
  const value=raw.normalize('NFKC').trim(),number='([+-]?(?:\\d+|\\d{1,3}(?:,\\d{3})+)(?:\\.\\d+)?)';
  const prefix=new RegExp(`^[¥$€£]\\s*${number}$`,'u').exec(value);
  const suffix=new RegExp(`^${number}\\s*[¥$€£]$`,'u').exec(value);
  return (prefix?.[1]??suffix?.[1])?.replace(/,/gu,'')??null;
}
/** Narrow only within a verified literal span; never generate or fuzzy-correct source text. */
export function fieldValueSpan(raw:string,definition:ReviewFieldDefinition):string|null {
  let value=raw.trim();
  if(definition.id==='cgt_field_62'&&definition.taxonomyIds?.includes('cgt_incorporation')&&/^[\d\s.,/-]+$/u.test(value))return null;
  if(definition.valueKind==='address'){
    const labelled=/(?:电话|電話|Tel(?:ephone)?|Phone)\s*[:：]?\s*[+＋]?[\d ()-]{7,}\s*$/iu;
    const phone=/(?:[+＋]\d{1,3}[- ]?)?(?:0\d{2,3}-\d{7,8}|\(\d{2,4}\)\s*\d{7,8}|[+＋]\d[\d -]{7,})\s*$/u;
    value=value.replace(labelled,'').replace(phone,'').trim();
  }
  if(definition.type==='date'){
    const timed=/^(\d{4}\s*年\s*\d{1,2}\s*月\s*\d{1,2}\s*日)\s*(?:[01]?\d|2[0-4])\s*时$/u.exec(value);
    if(timed&&normalizeExtractedValue(timed[1]!,'date'))value=timed[1]!;
  }
  if(definition.type==='currency'){
    if(normalizeExtractedValue(value,'currency'))return value;
    const token=currencyToken.exec(value);return token?.[0]??null;
  }
  if(definition.valueKind==='party_name'){
    value=value.replace(/^(?:We|I)\s*[,，]\s*/iu,'').trim();
    if(genericParty.test(value.replace(/\s+/gu,' '))||genericParty.test(value.replace(/\s/gu,''))||/[|<>]/u.test(value))return null;
  }
  return value&&raw.includes(value)?value:null;
}
/** How the text before a value labels it: by one of the field's own labels, by a label that belongs to another field
 * (`excluded`), or by neither (`unlabelled`). A labelled field may not borrow a label from a later row or another value. */
export function fieldLabelState(context:string,value:string,definition:ReviewFieldDefinition):'labelled'|'excluded'|'unlabelled' {
  const end=context.indexOf(value);if(end<0)return 'unlabelled';
  const prefix=fold(context.slice(0,end));
  const latest=(labels:readonly string[])=>Math.max(-1,...labels.map(label=>prefix.lastIndexOf(fold(label))));
  const expected=latest(definition.aliases),excluded=latest(definition.excludedLabels??[]);
  if(excluded>=0&&excluded>=expected)return 'excluded';
  // A generic suffix ("日期" / "Date") inside an excluded label must not
  // override the whole label ("接受日期" / "Acceptance Date"). A genuinely
  // later label, such as the end of an insurance period, remains admissible.
  if(expected>=0&&(definition.excludedLabels??[]).some(label=>{
    const key=fold(label),start=prefix.lastIndexOf(key);
    return start>=0&&start<=expected&&start+key.length>expected;
  }))return 'excluded';
  if(!definition.requireLabel||(expected>=0&&prefix.length-expected<=160))return 'labelled';
  if(definition.valueKind==='party_name'){
    const suffix=fold(context.slice(end+value.length));
    if(definition.aliases.some(alias=>{
      const at=suffix.indexOf(fold(alias));
      return at>=0&&/^[（(【\[]?(?:以下称|以下稱|以下简称|以下簡稱|下称|下稱)[「『"']?$/u.test(suffix.slice(0,at));
    }))return 'labelled';
  }
  return 'unlabelled';
}
export function hasFieldLabel(context:string,value:string,definition:ReviewFieldDefinition):boolean {
  return context.includes(value)&&fieldLabelState(context,value,definition)==='labelled';
}
/** Flat reading order is not a label/value association. A constrained field must
 * also have a local region or a neighbouring label with real page geometry. */
export function sourceLabelSupportsValue(page:DocumentPageArtifact,value:string,definition:ReviewFieldDefinition):boolean {
  if(!definition.requireLabel)return true;
  if(labelledTableAmount(page,value,definition))return true;
  const regions=page.regions.filter(r=>page.canonicalRegionIds.includes(r.region_id)&&r.raw_text);
  const boxes=(r:typeof regions[number])=>{const p=r.polygons.flat();return p.length?{left:Math.min(...p.map(v=>v[0])),right:Math.max(...p.map(v=>v[0])),top:Math.min(...p.map(v=>v[1])),bottom:Math.max(...p.map(v=>v[1]))}:null;};
  const values=regions.filter(r=>r.raw_text!.includes(value)&&partyNameSectionEvidence(page,r,value,definition)!==null);
  if(values.some(r=>hasFieldLabel(r.raw_text!,value,definition)&&boxes(r)))return true;
  const labels=regions.filter(r=>definition.aliases.some(alias=>fold(r.raw_text!.replace(/[:：]/gu,''))===fold(alias)));
  return values.some(region=>{
    const b=boxes(region);if(!b)return false;
    return labels.some(label=>{const l=boxes(label);if(!l)return false;const h=Math.max(b.bottom-b.top,l.bottom-l.top);
      return b.left>=l.right-h*0.25&&b.left-l.right<h*8&&Math.abs((b.top+b.bottom-l.top-l.bottom)/2)<=h*0.6;
    });
  });
}
/** Local recovery is deliberately limited to an explicitly labelled, contiguous date. */
export function labelledDates(text:string,definition:ReviewFieldDefinition):Array<{value:string;context:string}> {
  if(definition.type!=='date')return[];
  const result:Array<{value:string;context:string}>=[];
  for(const date of text.matchAll(dateValue)){
    if(!normalizeExtractedValue(date[0],'date'))continue;
    const prefix=text.slice(Math.max(0,date.index!-160),date.index!);
    const cleaned=prefix.replace(/\\(?:underline|text)\s*\{/gu,'').replace(/<[^>]*>/gu,'').replace(/[$:{}：\s]/gu,'');
    const label=definition.aliases.find(alias=>cleaned.toLowerCase().endsWith(fold(alias)));
    if(!label)continue;
    result.push({value:date[0],context:prefix+date[0]});
  }
  return result;
}
/** Identity hints require a labelled identifier in the same quoted party clause.
 * No fuzzy spelling, translated-name guessing or document-wide identifier lookup. */
export function partyIdentityKey(value:string,context:string):string|undefined {
  const at=context.indexOf(value);if(at<0)return;
  const vicinity=context.slice(at+value.length,at+value.length+150);
  const match=/^[\s,，(（\[【]*?(?:Registration\s*(?:No\.?|Number)|Company\s*(?:No\.?|Number)|注册号|註冊號|公司编号|公司編號)\s*[:：]?\s*([A-Z0-9][A-Z0-9-]{5,60})(?![A-Z0-9-])/iu.exec(vicinity);
  if(!match)return;
  return createHash('sha256').update(fold(match[1]!)).digest('hex');
}
