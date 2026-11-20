/** Exact, reproducible normalization. Ambiguous input stays pending; no exchange rates are invented. */
export interface NormalizationResult {value:string|null;status:'normalized'|'pending'|'not_needed';reasonCode:string;currency:string|null;unit:string|null}
const pending=(reasonCode:string,currency:string|null=null,unit:string|null=null):NormalizationResult=>({value:null,status:'pending',reasonCode,currency,unit});
const ok=(value:string,currency:string|null=null,unit:string|null=null):NormalizationResult=>({value,status:'normalized',reasonCode:'normalized',currency,unit});
const currencyNames:Record<string,string>={CNY:'CNY',RMB:'CNY','人民币':'CNY','人民幣':'CNY',USD:'USD','US$':'USD','美元':'USD',HKD:'HKD','HK$':'HKD','港币':'HKD','港幣':'HKD',TWD:'TWD',NT$:'TWD','新台币':'TWD','新臺幣':'TWD',EUR:'EUR','€':'EUR',GBP:'GBP','£':'GBP',SGD:'SGD','S$':'SGD',JPY:'JPY','日元':'JPY',
  // Everyday names for the same currencies as they are written in facility letters and guarantees.
  '港元':'HKD','港圓':'HKD','美金':'USD','欧元':'EUR','歐元':'EUR','英镑':'GBP','英鎊':'GBP','新加坡元':'SGD','日圆':'JPY','日圓':'JPY',
  'HONG KONG DOLLAR':'HKD','HONG KONG DOLLARS':'HKD','US DOLLAR':'USD','US DOLLARS':'USD','UNITED STATES DOLLAR':'USD','UNITED STATES DOLLARS':'USD',
  'RENMINBI':'CNY','CHINESE YUAN':'CNY','EURO':'EUR','EUROS':'EUR','POUND STERLING':'GBP','POUNDS STERLING':'GBP','SINGAPORE DOLLAR':'SGD','SINGAPORE DOLLARS':'SGD','JAPANESE YEN':'JPY'};
const compactCurrencyNames:Record<string,string>=Object.fromEntries(Object.entries(currencyNames).map(([name,code])=>[name.toUpperCase().replace(/\s+/g,''),code]));
const digits:Record<string,number>={'零':0,'〇':0,'一':1,'壹':1,'二':2,'贰':2,'貳':2,'两':2,'兩':2,'三':3,'叁':3,'參':3,'四':4,'肆':4,'五':5,'伍':5,'六':6,'陆':6,'陸':6,'七':7,'柒':7,'八':8,'捌':8,'九':9,'玖':9};
function chineseInteger(input:string):bigint|null{
  if(!input)return 0n;let total=0n,section=0n,number=0n,seen=false;
  const small:Record<string,bigint>={'十':10n,'拾':10n,'百':100n,'佰':100n,'千':1000n,'仟':1000n};
  let priorDigit=false,lastSmall=10000n,lastBig=1000000000000n,zeroAfterUnit=false;
  for(const c of input){
    if(c in digits){if(priorDigit&&number!==0n)return null;number=BigInt(digits[c]!);if(number===0n)zeroAfterUnit=true;seen=true;priorDigit=true;}
    else if(c in small){const unit=small[c]!;if(unit>=lastSmall||(!priorDigit&&(unit!==10n||section!==0n))||(priorDigit&&number===0n))return null;section+=(number||1n)*unit;lastSmall=unit;number=0n;seen=true;priorDigit=false;zeroAfterUnit=false;}
    else if(['万','萬','亿','億'].includes(c)){const base=['亿','億'].includes(c)?100000000n:10000n;if(base>=lastBig)return null;if(number>0n&&lastSmall>10n&&lastSmall<10000n&&!zeroAfterUnit)return null;section+=number;if(!section)return null;total+=section*base;lastBig=base;lastSmall=10000n;section=0n;number=0n;seen=true;priorDigit=false;zeroAfterUnit=false;}
    else return null;
  }
  if(number>0n&&lastSmall>10n&&lastSmall<10000n&&!zeroAfterUnit)return null;
  return seen?total+section+number:null;
}
function decimalCanonical(text:string,multiplier:bigint):string|null{
  const m=/^([+-]?)(\d+)(?:\.(\d{1,8}))?$/.exec(text);if(!m)return null;
  const fraction=m[3]??'',scale=10n**BigInt(fraction.length),n=BigInt(m[2]!+fraction)*multiplier;
  const whole=n/scale,rest=n%scale,tail=rest?rest.toString().padStart(fraction.length,'0').replace(/0+$/,''):'';
  return `${m[1]==='-'&&n!==0n?'-':''}${whole}${tail?'.'+tail:''}`;
}
export function normalizeAmount(raw:string,options:{currency?:string;unit?:string}={}):NormalizationResult{
  let text=raw.normalize('NFKC').trim().replace(/\s+/g,'');let currency=options.currency?currencyNames[options.currency.toUpperCase()]??null:null;
  if(options.currency&&!currency)return pending('currency_unknown');
  // Printed words and figures are two representations of one amount. Parse
  // both complete spans; never select the numeric half and discard a conflict.
  const dual=/^([^()]+)\(([^()]+)\)$/.exec(text);
  if(dual){
    const left=normalizeAmount(dual[1]!,options),right=normalizeAmount(dual[2]!,options);
    if(left.status!=='normalized'||right.status!=='normalized')return pending('amount_dual_unreadable');
    if(left.currency!==right.currency)return pending('currency_conflict');
    if(left.value!==right.value)return pending('amount_dual_conflict',left.currency);
    return left;
  }
  if(text.startsWith('¥')||text.endsWith('¥')){if(currency!=='CNY'&&currency!=='JPY')return pending('currency_ambiguous');text=text.startsWith('¥')?text.slice(1):text.slice(0,-1);}
  // The amount text has had its spaces removed, so a spelled-out name is matched in the same compact form.
  for(const name of Object.keys(currencyNames).map(key=>key.toUpperCase().replace(/\s+/g,'')).sort((a,b)=>b.length-a.length))if(text.toUpperCase().startsWith(name)||text.toUpperCase().endsWith(name)){
    const found=compactCurrencyNames[name]!;if(currency&&currency!==found)return pending('currency_conflict');currency=found;
    if(text.toUpperCase().startsWith(name))text=text.slice(name.length);else text=text.slice(0,-name.length);break;
  }
  if(text.includes('$')||text.includes('¥'))return pending('currency_ambiguous');
  let multiplier=1n;const units:Record<string,bigint>={'元':1n,'圆':1n,'圓':1n,'千':1000n,'万':10000n,'萬':10000n,'万元':10000n,'萬元':10000n,'亿':100000000n,'億':100000000n,'亿元':100000000n,'億元':100000000n};
  if(options.unit){if(!(options.unit in units))return pending('unit_unknown',currency,options.unit);multiplier=units[options.unit]!;}
  const numericUnit=/^([+-]?[\d,.]+)(万元|萬元|亿元|億元|万|萬|亿|億|千|元|圆|圓)$/.exec(text);
  if(numericUnit){if(options.unit&&units[numericUnit[2]!]!==multiplier)return pending('unit_conflict',currency,options.unit);multiplier=units[numericUnit[2]!]!;text=numericUnit[1]!;}
  if(text.includes(',')){if(!/^[+-]?\d{1,3}(?:,\d{3})+(?:\.\d+)?$/.test(text))return pending('amount_separator_ambiguous',currency);text=text.replace(/,/g,'');}
  let value=decimalCanonical(text,multiplier);
  if(value===null){const m=/^([零〇一壹二贰貳两兩三叁參四肆五伍六陆陸七柒八捌九玖十拾百佰千仟万萬亿億]+)(?:元|圆|圓)(?:整|正|([零〇一壹二贰貳三叁參四肆五伍六陆陸七柒八捌九玖])角(?:([零〇一壹二贰貳三叁參四肆五伍六陆陸七柒八捌九玖])分)?|([零〇一壹二贰貳三叁參四肆五伍六陆陸七柒八捌九玖])分)?$/.exec(text);
    if(m){const whole=chineseInteger(m[1]!);if(whole!==null&&multiplier===1n){const cents=(digits[m[2]??'零']??0)*10+(digits[m[3]??m[4]??'零']??0);value=`${whole}${cents?'.'+String(cents).padStart(2,'0').replace(/0+$/,''):''}`;}}
  }
  if(value===null)return pending('amount_ambiguous',currency,options.unit??null);
  if(!currency)return pending('currency_required');return ok(value,currency,'base');
}
/** Deeds write the day as an ordinal: "22nd day of September 2026", "the 1st day of March, 2026", "September 3rd, 2026".
 * Only a suffix that fits its number is read; "22th" or "3st" stays unreadable. */
function ordinalDate(text:string):string|undefined{
  const suffix=(day:string,given:string)=>{const n=Number(day),expected=n%100>=11&&n%100<=13?'th':['th','st','nd','rd'][n%10]??'th';return expected===given.toLowerCase();};
  const before=/^(?:the\s+)?(\d{1,2})(st|nd|rd|th)\s+(?:day\s+of\s+)?([A-Za-z]+),?\s+(\d{4})$/iu.exec(text);
  if(before)return suffix(before[1]!,before[2]!)?`${before[1]} ${before[3]} ${before[4]}`:'';
  const after=/^([A-Za-z]+)\s+(\d{1,2})(st|nd|rd|th),?\s+(\d{4})$/iu.exec(text);
  if(after)return suffix(after[2]!,after[3]!)?`${after[2]} ${after[1]} ${after[4]}`:'';
}
export function normalizeDate(raw:string,calendar?:'gregorian'|'roc'):NormalizationResult{
  const read=raw.normalize('NFKC').trim(),ordinal=ordinalDate(read);
  if(ordinal==='')return pending('date_ambiguous');
  const text=ordinal??read;let year:number,month:number,day:number;
  const roc=/^(?:中华民国|中華民國|民国|民國)\s*(\d{1,3})\s*年\s*(\d{1,2})\s*月\s*(\d{1,2})\s*日?$/.exec(text);
  const standard=/^(\d{1,4})[-/.年](\d{1,2})[-/.月](\d{1,2})日?$/.exec(text);
  const months=['january','february','march','april','may','june','july','august','september','october','november','december'];
  const english=/^(?:(\d{1,2})\s+([A-Za-z]+)|([A-Za-z]+)\s+(\d{1,2}),?)\s+(\d{4})$/.exec(text);
  if(roc){if(calendar==='gregorian')return pending('calendar_conflict');year=Number(roc[1])+1911;month=Number(roc[2]);day=Number(roc[3]);}
  else if(standard){year=Number(standard[1]);if(calendar==='roc')year+=1911;else if(year<1000)return pending('calendar_required');month=Number(standard[2]);day=Number(standard[3]);}
  else if(english){if(calendar==='roc')return pending('calendar_conflict');year=Number(english[5]);day=Number(english[1]??english[4]);const name=(english[2]??english[3]!).toLowerCase();month=months.findIndex(m=>m===name||m.slice(0,3)===name)+1;}
  else return pending('date_ambiguous');
  const date=new Date(Date.UTC(year,month-1,day));if(year<1000||year>9999||date.getUTCFullYear()!==year||date.getUTCMonth()!==month-1||date.getUTCDate()!==day)return pending('date_invalid');
  return ok(`${year}-${String(month).padStart(2,'0')}-${String(day).padStart(2,'0')}`);
}
/** V2 keeps a printed clock boundary in rawValue. Date rules still compare the
 * printed business day; 24时 is not silently shifted to the following day.
 * Legacy date readers and other date command inputs keep their original grammar.
 */
function normalizeLiteralDateClock(raw:string,calendar?:'gregorian'|'roc'):NormalizationResult|undefined{
  const match=/^(\d{4}[ \t]*年[ \t]*\d{1,2}[ \t]*月[ \t]*\d{1,2}[ \t]*日)[ \t]*(?:[01]\d|2[0-4]|\d)[ \t]*[时時]$/u.exec(raw.normalize('NFKC').trim());
  if(!match)return;
  if(calendar==='roc')return pending('calendar_conflict');
  return normalizeDate(match[1]!.replace(/[ \t]/gu,''),'gregorian');
}
export function normalizeReviewValue(raw:string|null,type:string,options:{currency?:string;unit?:string;calendar?:'gregorian'|'roc';literalDateClock?:boolean;integerCount?:boolean}={}):NormalizationResult{
  if(raw===null)return {value:null,status:'not_needed',reasonCode:'no_value',currency:null,unit:null};
  if(type==='amount'&&options.integerCount){
    const text=raw.normalize('NFKC').trim();
    if(options.currency||options.unit&&!['persons','人'].includes(options.unit)||!/^\d{1,4}$/.test(text))return pending('count_invalid',null,'persons');
    return ok(String(Number(text)),null,'persons');
  }
  if(type==='amount')return normalizeAmount(raw,options);if(type==='date')return (options.literalDateClock?normalizeLiteralDateClock(raw,options.calendar):undefined)??normalizeDate(raw,options.calendar);
  if(type==='currency'){const value=currencyNames[raw.normalize('NFKC').trim().toUpperCase()];return value?ok(value,value):pending('currency_ambiguous');}
  return ok(raw.normalize('NFKC').trim());
}
