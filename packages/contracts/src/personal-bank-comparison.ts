import type {CrossFileCheck} from './review-checklist.js';
import {crossFileSourceReading} from './field-role-reading.js';
export {crossFileSourceReading} from './field-role-reading.js';

export interface PersonalBankContent {
  status:'same'|'different'|'partial'|'incomplete'|'ambiguous'|'ownership_required'|'present'|'filled'|'blank_unconfirmed';
  label:string;reason:string;evidencePending:boolean;
  readings:Array<{sourceId:string;values:string[];complete:boolean}>;
}
const unique=(values:string[])=>[...new Set(values)];
const textKey=(value:string)=>value.normalize('NFKC').trim().replace(/\s+/gu,' ').toUpperCase();
const bankRows=new Set([4,23,29]),lawRows=new Set([26,32]);
const personRows=new Set([5,13,14,15,19,20,24,25,30,31,33,34,36,37]);
const blankRows=new Set([21,22,38]);

/** Orthographic equivalence only. Branches, countries and legal suffixes remain
 * part of the value. Do not apply these substitutions to personal names/IDs. */
export function personalBankNameKey(raw:string):string|undefined {
  const value=raw.normalize('NFKC').trim();
  if(!value||value.length>240||/[\n;；。:：]|\b(?:not|unless|if|formerly|shall)\b|如果|除非|并非|並非/iu.test(value))return undefined;
  return value.replace(/[銀國豐匯滙臺]/gu,c=>({銀:'银',國:'国',豐:'丰',匯:'汇',滙:'汇',臺:'台'})[c]!)
    .replace(/\s+/gu,'').toUpperCase();
}
const laws:Array<[string,RegExp]>=[
  ['中華民國法律',/^(?:中[華华]民[國国](?:法律|法)|(?:the )?laws? of (?:the )?Republic of China)$/iu],
  ['中华人民共和国法律',/^(?:中华人民共和[国國](?:法律|法)|中華人民共和國(?:法律|法)|(?:the )?laws? of (?:the )?People['’]s Republic of China)$/iu],
  ['香港法律',/^(?:香港(?:特[别別]行政[区區])?(?:法律|法)|(?:the )?laws? of Hong Kong|Hong Kong(?: law)?)$/iu],
];
/** Recognize complete affirmative governing-law phrases, never a keyword in
 * exceptions, negative/conditional clauses or multiple jurisdictions. */
export function personalLawName(raw:string):string|undefined {
  const value=raw.normalize('NFKC').trim().replace(/[。.]$/u,'').trim().replace(/\s+/gu,' ');
  const direct=laws.find(([,pattern])=>pattern.test(value));
  if(direct)return direct[0];
  const chinese=/^(?:(?:本票|本保[证證][书書]|本授[权權][书書])\s*)?(?:[应應]\s*)?(?:以|依)\s*(.+?)\s*(?:[为為][准準][据據]法|解[释釋])$/u.exec(value);
  const english=/^(?:(?:this (?:promissory note|guarantee|authorization)) (?:is|shall be) )?(?:governed by(?: and construed in accordance with)?|construed in accordance with) (.+)$/iu.exec(value);
  const inner=chinese?.[1]??english?.[1];
  return inner?laws.find(([,pattern])=>pattern.test(inner))?.[0]:undefined;
}

export function personalBankComparableValue(check:CrossFileCheck,raw:string):string|undefined {
  const number=check.bankRule?.row;
  // A joint name list is not a scalar identity even after document assignment.
  if(number&&[5,13,31,34].includes(number)&&/[;；、\n&]|\b(?:and|or)\b/iu.test(raw))return undefined;
  return number&&bankRows.has(number)?personalBankNameKey(raw):number&&lawRows.has(number)?personalLawName(raw):textKey(raw)||undefined;
}

/** Only known blank-column labels and empty writing guides are template text.
 * This is not proof of a blank original: signatures/images still require review. */
export function personalBankBlankTemplate(row:number,raw:string):boolean {
  const labels:Record<number,RegExp>={21:/給付日|给付日|(?:DATE OF PAYMENT|PAYMENT DATE)/giu,
    22:/給付金額|给付金额|(?:AMOUNT OF PAYMENT|PAYMENT AMOUNT)/giu,
    38:/背書人|背书人|\b(?:THE\s+)?ENDORSER\b/giu};
  const pattern=labels[row];if(!pattern)return false;
  const value=raw.normalize('NFKC').replace(pattern,'');
  return /^[\s_＿﹍﹎.．·/\-—–()（）:：]*$/u.test(row===21?value.replace(/[年月日]/gu,''):value);
}

/** Compare only the rule's fields, without assigning a person, adopting facts
 * or clearing source warnings. The optional legacy argument is not a gate. */
export function personalBankContent(check:CrossFileCheck,_ownershipConfirmed=!!check.objectId):PersonalBankContent|undefined {
  const number=check.bankRule?.row;
  if(!number||!bankRows.has(number)&&!lawRows.has(number)&&!personRows.has(number)&&!blankRows.has(number)&&number!==35&&number!==6)return undefined;
  const sources=check.sources.filter(source=>!(number===6&&['pg_facility_parties','pg_registration_customer_name'].includes(source.fieldId)&&
    source.state==='missing'&&!source.documentId&&!source.values.length&&check.sources.some(other=>other.fieldId!==source.fieldId&&['pg_facility_parties','pg_registration_customer_name'].includes(other.fieldId)&&other.documentId&&other.values.length)));
  const readings=sources.map(source=>{
    const raw=crossFileSourceReading(check,source).values;
    const keys=raw.map(value=>personalBankComparableValue(check,value));
    return {sourceId:source.id,values:unique(keys.filter((key):key is string=>!!key)),complete:raw.length>0&&keys.every(Boolean)};
  });
  const evidencePending=sources.some(s=>s.state!=='available'||s.warnings.length>0);
  const result=(status:PersonalBankContent['status'],label:string,reason:string):PersonalBankContent=>({status,label,reason,evidencePending,readings});
  // Presence/blank requirements are evaluated per document. Different people's
  // titles or endorser text are never compared with each other for equality.
  if(number===35){
    if(sources.length&&sources.every(s=>s.values.some(v=>v.trim())))return result('present','各份均有取值','逐份核对职衔是否填写，不要求不同担保人的职衔相同；取值真实性仍按来源核实。');
    return result('incomplete','部分职衔待核实','逐份检查职衔栏；未提取到值不能证明原文留空。');
  }
  if(blankRows.has(number))return sources.some(s=>s.values.some(v=>v.trim()&&!personalBankBlankTemplate(number,v)))?
    result('filled','留空栏存在提取内容','逐份核实是否为实际填写内容或模板文字；不比较不同文件的内容是否相同。'):
    result('blank_unconfirmed','未发现实际填写内容','仅取得空白占位、栏位标题或未提取到值；需查看每份原文确认留空。');
  // Amounts and dates use the typed comparator; identity is a separate rule.
  if([19,20,30].includes(number))return undefined;
  if(personRows.has(number)&&[24,33,36].includes(number))return result('ambiguous','需核对签署或身份','按本条要求核对原文及本人身份，不以文字相同代替签署或证件确认。');
  const nonempty=readings.filter(r=>r.values.length);
  if(nonempty.some(r=>r.values.length>1))return result('ambiguous','同一来源有多个取值','同一文件中有尚未消除的不同取值；不选取其中一个值代表全部内容。');
  if(lawRows.has(number)&&readings.length&&readings.every(r=>r.values.length>0)&&readings.some(r=>!r.complete)&&new Set(sources.map(s=>s.fieldId)).size>=2){
    const same=new Set(readings.flatMap(r=>r.values)).size===1;
    return result('partial',same?'法律名称一致，条款待核实':'部分法律名称已识别','已识别的法律名称单独对照；其余补充、例外或未识别条款须逐份核实，不能据此判定整项一致。');
  }
  if(readings.some(r=>!r.complete)||!readings.length)return result('incomplete','无完整可比取值',lawRows.has(number)?
    '法律名称或条款范围尚未完整识别；含条件、例外或未支持的表述须核对原文。':'对应材料或字段值不完整，暂无法形成完整对照。');
  if(new Set(sources.map(s=>s.fieldId)).size<2)return result('incomplete','缺少对应字段','当前仅有一侧取值，不能据此认定一致。');
  if(new Set(nonempty.flatMap(r=>r.values)).size>1)return result('different',evidencePending?'取值显示差异，待核实':'对应取值不同',
    '按本条指定字段对照后仍有差异；保留各份取值及来源，需核实差异原因。');
  return result('same',lawRows.has(number)?'法律名称一致':bankRows.has(number)?'银行名称一致':'对应取值一致',
    lawRows.has(number)?'完整的中英文表述指向同一法律名称；不代表法律效力或全部条款一致。':
    bankRows.has(number)?'仅统一银行名称中的繁简字形、空白及全半角；总分行和不同机构仍分别比较。':'对应范围内的字段取值一致；不代替身份及材料归属确认。');
}
