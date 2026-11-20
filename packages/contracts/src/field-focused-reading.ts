import type {ChecklistRow, CrossFileCheck, CrossFileValue} from './review-checklist.js';

export interface FieldFocus {fieldId:string;label:string;type?:string;definition?:string}
export type FocusKind = 'amount'|'currency'|'date'|'text';
export function focusKind(field:FieldFocus):FocusKind {
  if(['pg_field_10','pg_field_18','pg_field_19','pg_field_27'].includes(field.fieldId))return 'date';
  if (/币种|幣種|currency/iu.test(field.label+' '+field.fieldId)) return 'currency';
  if (/金额|金額|amount/iu.test(field.label+' '+field.fieldId) && !/是否|有限额|无限额|责任范围/u.test(field.label)) return 'amount';
  if (field.type==='date'||/日期|签署日|簽署日|基准日/u.test(field.label)&&!/名称|名稱|与|及/u.test(field.label)) return 'date';
  return field.type==='amount'||field.type==='currency'?field.type:'text';
}
const unique=(values:string[])=>[...new Set(values.map(value=>value.trim()).filter(Boolean))];
const currency=String.raw`(?:\b(?:USD|HKD|CNY|RMB|EUR|GBP|JPY|SGD|AUD|CAD|CHF|NZD|TWD|NTD)(?![A-Za-z])|US\$|HK\$|NT\$|新台币|新臺幣|新台幣|台币|臺幣|人民币|人民幣|港元|港币|港幣|美元|美金|欧元|歐元|英镑|英鎊|日元|新加坡元)`;
const number=String.raw`(?:\d{1,3}(?:[,，]\d{3})+|\d+)(?:\.\d+)?(?:\s*(?:万亿|萬億|亿|億|万|萬|千|百|million|billion|thousand))?`;
const money=new RegExp(String.raw`(?:(?:${currency}|[$¥￥€£])\s*)?(${number})(?:\s*(?:${currency}|元))?`,'giu');
const amountLabel=/(?:担保金额|擔保金額|保证金额|保證金額|指定金额|指定金額|指定本金|保证本金|保證本金|guarantee(?:d)? amount|specified sum|principal cap|maximum liability|\bamount(?=\s*[:：])|金额(?=\s*[:：]))\s*(?:为|為|is|of|[:：=])?\s*/giu;
const anyAmountLabel=/(?:担保金额|擔保金額|保证金额|指定金额|保证本金|授信额度|授信金额|贷款金额|利息|利率|guarantee(?:d)? amount|specified sum|principal cap|maximum liability|facility (?:amount|limit)|loan amount|interest(?: rate)?|\bamount(?=\s*[:：])|金额(?=\s*[:：]))\s*(?:为|為|is|of|[:：=])?\s*/giu;
const clause=/[。；;\n]|\b(?:shall|means|provided|unless|if|formerly)\b|应当|應當|系指|如果|除非/u;
const datePattern=/\b\d{4}[-/.]\d{1,2}[-/.]\d{1,2}\b|\d{4}年\s*\d{1,2}月\s*\d{1,2}日|\b\d{1,2}\s+(?:Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:tember)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)\s+\d{4}\b/giu;
function dateKey(value:string):string|undefined {
  const numeric=/^(\d{4})[-/.年]\s*(\d{1,2})[-/.月]\s*(\d{1,2})日?$/u.exec(value.trim());
  if(numeric)return `${+numeric[1]!}-${+numeric[2]!}-${+numeric[3]!}`;
  const english=/^(\d{1,2})\s+([A-Za-z]+)\s+(\d{4})$/u.exec(value.trim());
  const month=english?['jan','feb','mar','apr','may','jun','jul','aug','sep','oct','nov','dec'].indexOf(english[2]!.slice(0,3).toLowerCase())+1:0;
  return english&&month?`${+english[3]!}-${month}-${+english[1]!}`:undefined;
}

/** Display projection only. Never normalizes numbers, guesses a currency or writes a fact. */
export function focusedValues(raw:string,field:FieldFocus,{compound=false}:{compound?:boolean}={}):string[] {
  const text=raw.trim();
  if(!text)return [];
  const kind=focusKind(field);
  if(kind==='amount') {
    const matches=[...text.matchAll(money)];
    // A scalar amount may contain a currency and a magnitude, but not a date,
    // percentage, reference number or another sentence.
    if(matches.length===1&&matches[0]![0].trim()===text)return [matches[0]![1]!];
    const markers=[...text.matchAll(anyAmountLabel)];
    const values=markers.flatMap(marker=>{
      if(compound&&!new RegExp(`^(?:${amountLabel.source})$`,'iu').test(marker[0]))return [];
      if(/interest|利率|利息/iu.test(marker[0]))return [];
      const tail=text.slice(marker.index!+marker[0].length);
      const match=new RegExp(String.raw`^(?:不超过|不超過|最高|up to|not exceeding)?\s*(?:${currency}\s*[$¥￥€£]?\s*|[$¥￥€£]\s*)?(${number})(?:\s*${currency})?(?![\d%％/])`,'iu').exec(tail);
      return match&&!/^[\s]*[%％/\d]|^[-–]\d/u.test(tail.slice(match[0].length))?[match[1]!]:[];
    });
    return unique(values);
  }
  if(kind==='currency') {
    if(!compound)return unique([...text.matchAll(new RegExp(currency,'giu'))].map(m=>m[0]));
    return unique([...text.matchAll(anyAmountLabel)].filter(marker=>new RegExp(`^(?:${amountLabel.source})$`,'iu').test(marker[0])).flatMap(marker=>{
      const match=new RegExp(`^(${currency})\\s*${number}`,'iu').exec(text.slice(marker.index!+marker[0].length));
      return match?[match[1]!]:[];
    }));
  }
  if(kind==='date') {
    // Keep an explicitly labelled ROC date intact; bare short years are ambiguous.
    const roc=[...text.matchAll(/(?:民国|民國)\s*\d{1,3}\s*年\s*\d{1,2}\s*月\s*\d{1,2}\s*日/gu)];
    if(roc.length===1&&!compound&&!new RegExp(datePattern.source,'iu').test(text))return [roc[0]![0]];
    const dates=[...text.matchAll(datePattern)];
    // Multiple events must not be relabelled as this field's date.
    if(dates.length===1&&!compound)return [dates[0]![0]];
    return labelledValues(text,[field.label]).flatMap(value=>focusedValues(value,field));
  }
  const labelled=labelledValues(text,[field.label.replace(/（[^）]*）/gu,'').trim()]);
  if(labelled.length)return labelled;
  if(compound)return [];
  if(/名称|名稱|Name/iu.test(field.label)&&clause.test(text)) {
    const joined=text.replace(/\s*\n\s*/gu,' ');
    if(!clause.test(joined))return [joined];
    return [];
  }
  // Separators inside a structured address, identity or list are not prose.
  if(/地址|Adress|Address|证件|證件|身份证明|Identification|名单|名單|全名|Full name/iu.test(field.label))return unique(text.split(/\s*[…\n]+\s*/u));
  if(text.length<=240&&!clause.test(text)&&!fieldTerms(field).length)return [text];
  // A field's already extracted clause is not a missing value. Select complete
  // relevant sentences, including negative/conditional sentences, never cut a
  // clause at a character limit or substitute an empty-state warning for it.
  const sentences=unique(text.split(/(?<=[。！？])\s*|(?<=[.!?])\s+(?=[A-Z])|\s*…+\s*|\n+/u));
  const terms=fieldTerms(field);
  const relevant=sentences.filter(sentence=>terms.some(term=>term.test(sentence)));
  return relevant.length?relevant:sentences;
}

function labelledValues(text:string,labels:string[]):string[] {
  const values:string[]=[];
  for(const label of labels.filter(Boolean)) {
    const escaped=label.replace(/[.*+?^${}()|[\]\\]/gu,'\\$&');
    for(const match of text.matchAll(new RegExp(`(?:^|[\\s;；。])${escaped}\\s*[:：]\\s*([^;；。\\n]+)`,'gu'))) {
      const value=match[1]!.split(/\s+[^\s:：]{1,24}[:：]/u)[0]!.trim();
      if(value&&value.length<=240&&!clause.test(value))values.push(value);
    }
  }
  return unique(values);
}

const liability=['cgt_field_12','cgt_facility_guarantee_terms','cgt_facility_parties'];
/** Keep only this aspect in the desk. Check outcomes stay the original business
 * assessment; currency/conditions still participate in server-side evaluation. */
export function focusedChecks(checks:CrossFileCheck[],field:FieldFocus):CrossFileCheck[] {
  const kind=focusKind(field);
  return checks.flatMap(check=>{
    const sources=check.sources.filter(source=>{
      if(source.fieldId===field.fieldId)return true;
      const other=focusKind(source);
      if(kind==='amount')return other==='amount'||liability.includes(source.fieldId);
      if(kind==='currency')return other==='currency'||liability.includes(source.fieldId);
      if(kind==='date')return other==='date';
      return (['text','equal'].includes(check.method)||check.id.endsWith(':personal-identity'))&&other==='text';
    });
    return sources.length?[{...check,label:field.label,sources}]:[];
  });
}

export function sourceFocus(source:CrossFileValue,selected?:FieldFocus):FieldFocus {
  return selected&&(source.fieldId===selected.fieldId||liability.includes(source.fieldId)&&['amount','currency'].includes(focusKind(selected)))?selected:source;
}
export function rowFocus(row:ChecklistRow,type?:string):FieldFocus {return {fieldId:row.fieldId,label:row.label,type,definition:row.definition};}

function fieldTerms(field:FieldFocus):RegExp[] {
  const groups:[RegExp,RegExp[]][]=[
    [/管辖|Governing|Jurisdiction/iu,[/governed|laws? of|jurisdiction|mandatory.*(?:court|rights|rules)|管辖|適用法律|适用法律|强制/u]],
    [/责任限制|責任限制/u,[/liability|责任|責任|limit|限制/iu]],
    [/经营许可|经营|牌照/u,[/经营|牌照|登记|许可|授权|不适用|不授权|仅|仅因|licen[cs]e|business/iu]],
    [/签署|签字|授權|授权|sign/iu,[/签署|签字|授权|授權|sign|execut|authoris|authoriz/iu]],
  ];
  return groups.filter(([label])=>label.test(field.label)).flatMap(([,terms])=>terms);
}

export interface FocusedSnippet {before:string;match:string;after:string}
/** One source line can contain both language variants. Highlight both in one
 * passage rather than repeating that line for each matching component. */
export function focusedPassages(snippets:FocusedSnippet[]) {
  const groups=new Map<string,Array<{start:number;end:number}>>();
  for(const snippet of snippets){
    const text=snippet.before+snippet.match+snippet.after;
    const spans=groups.get(text)??[];
    spans.push({start:snippet.before.length,end:snippet.before.length+snippet.match.length});
    groups.set(text,spans);
  }
  return [...groups].map(([text,spans])=>{
    const merged:Array<{start:number;end:number}>=[];
    for(const span of spans.sort((a,b)=>a.start-b.start)){
      const previous=merged.at(-1);
      if(previous&&span.start<=previous.end)previous.end=Math.max(previous.end,span.end);else merged.push({...span});
    }
    let offset=0;const runs:Array<{text:string;highlight:boolean}>=[];
    for(const span of merged){if(span.start>offset)runs.push({text:text.slice(offset,span.start),highlight:false});runs.push({text:text.slice(span.start,span.end),highlight:true});offset=span.end;}
    if(offset<text.length)runs.push({text:text.slice(offset),highlight:false});
    return runs;
  });
}
function searchText(text:string) {
  let normalized='';const offsets:Array<{start:number;end:number}>=[];
  let index=0;
  for(const character of text){
    const next=index+character.length;
    for(const c of character.normalize('NFKC').toLocaleLowerCase())if(!/\s/u.test(c)){
      normalized+=c;for(let i=0;i<c.length;i++)offsets.push({start:index,end:next});
    }
    index=next;
  }
  return {normalized,offsets};
}
function valueSpans(text:string,value:string):Array<{start:number;end:number}> {
  const source=searchText(text),needle=searchText(value).normalized;
  if(!needle)return [];
  const spans:Array<{start:number;end:number}>=[];
  let from=0,index:number;
  while((index=source.normalized.indexOf(needle,from))>=0){
    const span={start:source.offsets[index]!.start,end:source.offsets[index+needle.length-1]!.end};
    if(!/^\d[\d,.]*$/u.test(value)||!/\d\s+\d/u.test(text.slice(span.start,span.end)))spans.push(span);
    from=index+needle.length;
  }
  return spans;
}
function valueParts(value:string):string[] {
  return value.split(/[;；\n]|\s+[\/／]\s+|(?<=[\p{Script=Han}])\s*[\/／]\s*|(?<=[A-Za-z)])\s+(?=[\p{Script=Han}])|(?<=[\p{Script=Han}])(?=[A-Za-z])/u).map(s=>s.replace(/^[\s（(]+|[\s）)]+$/gu,'')).filter(s=>s.length>1);
}
/** Match source characters (or an unambiguous equivalent date), not whole
 * paragraphs merely because their anchors belong to a candidate. */
export function focusedSnippets(text:string,values:string[],field?:FieldFocus):FocusedSnippet[] {
  const result:FocusedSnippet[]=[];
  for(const value of unique(values)) {
    const exact=valueSpans(text,value);
    const date=field&&focusKind(field)==='date'?dateKey(value):undefined;
    const equivalentDates=date?[...text.matchAll(datePattern)].filter(match=>dateKey(match[0])===date).map(match=>({start:match.index!,end:match.index!+match[0].length})):[];
    const spans=exact.length?exact:equivalentDates.length?equivalentDates:valueParts(value).flatMap(part=>valueSpans(text,part));
    for(const {start:index,end:from} of spans) {
      const numericPrefix=/\d/u.test(text[index-1]??'')||/[.,]/u.test(text[index-1]??'')&&/\d/u.test(text[index-2]??'');
      const numericSuffix=/\d/u.test(text[from]??'')||/[.,]/u.test(text[from]??'')&&/\d/u.test(text[from+1]??'');
      if(/\d/u.test(value[0]??'')&&(numericPrefix||numericSuffix))continue;
      const prefix=text.slice(0,index),suffix=text.slice(from);
      const boundary=[...prefix.matchAll(/[;；。\n]|\.(?=\s)/gu)].at(-1);
      if(field&&['amount','currency'].includes(focusKind(field))&&/担保|擔保|保证|保證/u.test(field.label)) {
        const marker=[...prefix.slice(boundary?boundary.index!+1:0).matchAll(anyAmountLabel)].at(-1);
        if(marker&&!new RegExp(`^(?:${amountLabel.source})$`,'iu').test(marker[0]))continue;
      }
      const start=Math.max(boundary?boundary.index!+1:0,index-28);
      const next=suffix.search(/[;；。\n]|\.(?=\s|$)/u);
      const completeSentence=/[。！？.!?]$/u.test(text.slice(index,from));
      const end=completeSentence?from:Math.min(next<0?text.length:from+next+1,from+28);
      result.push({before:(start?'…':'')+text.slice(start,index),match:text.slice(index,from),after:completeSentence?'':text.slice(from,end)+(end<text.length?'…':'')});
    }
  }
  return [...new Map(result.map(item=>[JSON.stringify(item),item])).values()];
}

export function decimalKey(raw:string):string|undefined {
  const value=raw.normalize('NFKC').trim();
  const match=/^((?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?)\s*(万亿|萬億|亿|億|万|萬|千|百|million|billion|thousand)?$/iu.exec(value);
  if(!match)return undefined;
  const powers:Record<string,number>={万亿:12,萬億:12,亿:8,億:8,万:4,萬:4,千:3,百:2,million:6,billion:9,thousand:3};
  const [whole,fraction='']=match[1]!.replaceAll(',','').split('.');
  let digits=BigInt(whole!+fraction),scale=fraction.length-(powers[match[2]?.toLowerCase()??'']??0);
  if(!digits)return '0';
  if(scale<0){digits*=10n**BigInt(-scale);scale=0;}
  while(scale>0&&digits%10n===0n){digits/=10n;scale--;}
  return `${digits}:${scale}`;
}
