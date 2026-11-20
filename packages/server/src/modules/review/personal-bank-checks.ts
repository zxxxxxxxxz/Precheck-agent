import {personalTextEqual} from './personal-text-comparison.js';
import {personalWorkbookRuleSource} from './personal-workbook-source.js';
import {personalBankContent,personalBankComparableValue,crossFileSourceReading,personalBankBlankTemplate} from '@hsbc/contracts/personal-bank-comparison';
import {personalScalarRuleSource} from './personal-scalar-source.js';
import {personalNameRuleSource} from './personal-name-source.js';
import {PERSONAL_RULE_ROWS,PERSONAL_FIELDS,PERSONAL_WORKBOOK_SHA256} from '@hsbc/contracts/personal-requirements';
import type {ChecklistRow,CrossFileCheck,CrossFileValue} from '@hsbc/contracts/review-checklist';
import type {ReviewConfigManifest} from '@hsbc/contracts/review-config';
import type {ReviewState} from '@hsbc/contracts/review';
import {normalizeReviewValue} from './normalization.js';
import {semanticEligible} from './cross-file-semantics.js';

type Mode='manual'|'text'|'amount'|'minimum'|'date_equal'|'date_order'|'today'|'blank'|'present';
// Rule row numbers and directions are from SRC-PG/规则校验, hash pinned below.
// No symmetric/transitive group: each row has only its own bank counterparts.
const mappings:Array<[number,string,string[],Mode]>=[
 [4,'pg_field_4',['pg_facility_parties'],'text'],
 [5,'pg_field_5',['pg_facility_parties','pg_identity_name'],'text'],
 [6,'pg_field_6',['pg_facility_parties','pg_registration_customer_name'],'text'],
 [7,'pg_field_7',['pg_required_amount'],'minimum'],
 [8,'pg_field_8',[],'manual'],[9,'pg_field_9',[],'manual'],[10,'pg_field_10',[],'today'],
 [11,'pg_field_11',[],'manual'],[12,'pg_field_12',[],'manual'],
 [13,'pg_field_13',['pg_identity_name'],'text'],[14,'pg_field_14',['pg_identity_number'],'manual'],
 [15,'pg_field_15',['pg_identity_address'],'text'],[16,'pg_field_9',[],'manual'],
 [19,'pg_field_17',['pg_field_7'],'amount'],[20,'pg_field_18',['pg_field_10'],'date_equal'],
 [21,'pg_field_19',[],'blank'],[22,'pg_field_20',[],'blank'],
 [23,'pg_field_21',['pg_field_4'],'text'],[24,'pg_field_22',['pg_field_5'],'manual'],
 [25,'pg_field_23',['pg_field_15','pg_identity_address'],'text'],[26,'pg_field_24',['pg_field_9'],'text'],
 [29,'pg_field_26',['pg_field_4'],'text'],[30,'pg_field_27',['pg_field_18'],'date_order'],
 [31,'pg_field_28',['pg_field_5','pg_identity_name'],'text'],[32,'pg_field_29',['pg_field_9'],'text'],
 [33,'pg_field_30',['pg_field_5'],'manual'],[34,'pg_field_31',['pg_field_5','pg_identity_name'],'text'],
 [35,'pg_field_32',[],'present'],[36,'pg_field_33',['pg_identity_name'],'manual'],
 [37,'pg_field_34',['pg_identity_address'],'text'],[38,'pg_field_35',[],'blank'],
 [40,'pg_field_37',['pg_legal_route'],'manual'],[41,'pg_field_37',['pg_legal_firm'],'manual'],
 [42,'pg_field_37',['pg_legal_references'],'manual'],[43,'pg_field_37',['pg_legal_conditions'],'manual'],
 [47,'pg_field_39',[],'manual'],[48,'pg_field_40',[],'manual'],
];
const labels:Record<string,string>={pg_registration_customer_name:'客户官方注册文件中的客户名称'};
const usable=(source:CrossFileValue)=>source.state==='available'&&!source.warnings.length&&source.values.length>0;
const decimal=(v:string)=>{const [whole,fraction='']=v.split('.');return {n:BigInt(whole!+fraction),scale:10n**BigInt(fraction.length)};};

export function personalBankChecks(row:ChecklistRow,rows:ChecklistRow[],manifest:ReviewConfigManifest,state:ReviewState,
 sourceFor:(row:ChecklistRow)=>CrossFileValue[],today=new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Shanghai',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date())):CrossFileCheck[]{
 const owner=state.objects.find(o=>o.objectId===row.objectId);
 return mappings.filter(([,primary])=>primary===row.fieldId).map(([number,primary,others,mode])=>{
  const bank=PERSONAL_RULE_ROWS.find(r=>r.row===number)!;
  const fields=[primary,...others],related=fields.map(id=>rows.find(r=>r.fieldId===id&&r.objectId===row.objectId&&r.objectRole===row.objectRole));
  const sources=fields.flatMap((id,i)=>related[i]?sourceFor(related[i]!):[{
   id:`${row.id}:${id}:bank-missing`,fieldId:id,label:labels[id]??id,documentId:null,filename:labels[id]??'对应材料',
   values:[],evidence:[],warnings:id==='pg_registration_customer_name'?[]:['尚无本项取值，请查看对应原文并人工核对。'],state:'missing' as const,
   ...(id==='pg_registration_customer_name'?{missingText:'可选对照依据；可使用授信函核对客户名称。'}:{}),
  }]).map(source=>personalWorkbookRuleSource(personalScalarRuleSource(personalNameRuleSource(source,number),number),number));
  const check:CrossFileCheck={id:`${row.id}:bank:${number}`,label:bank.label.replace(/\n/gu,' '),objectId:row.objectId,fieldIds:fields,
   method:mode==='text'?'text':mode==='date_order'?'date_order':mode==='minimum'?'minimum':mode==='manual'?'manual':'equal',outcome:'manual',reason:'请按银行要求核对原文。',manualReasons:[],sources,semanticEligible:false,
   bankRule:{row:number,reference:`SRC-PG/规则校验!B${number}:F${number}`,requirement:bank.requirement,notice:bank.notice,primaryFieldId:primary,applicability:PERSONAL_FIELDS.find(f=>f.id===primary)?.requirement,...(mode==='today'?{currentDate:today}:{})}};
  if(['today','date_equal','date_order'].includes(mode))check.bankRule!.dates=sources.flatMap(source=>source.values.flatMap(raw=>{
   const date=normalizeReviewValue(raw,'date');
   return date.value&&date.status==='normalized'?[{sourceId:source.id,raw,gregorian:date.value}]:[];
  }));
  // A changed bank source is not silently interpreted as this workbook revision.
  if(!manifest.sources.some(s=>s.id===`pg_rule_source_${number}`&&s.sha256===PERSONAL_WORKBOOK_SHA256)){
   check.reason='当前配置的银行来源版本与本表不一致，请核对对应银行要求。';return check;
  }
  if(row.fact?.validity==='current'&&row.fact.state==='not_applicable'){check.outcome='not_applicable';check.reason='本项已有当前有效的不适用决定。';return check;}
  check.bankRule!.content=personalBankContent(check,owner?.validity==='current');
  if(number===36){check.reason='银行原表检查项为“身份证字号”，判断规则写“名称一致”；保留原文，请人工确认此项要求。';return check;}
  if(mode==='manual'){
   // The workbook's exception notice is conditional, not an observed finding.
   const instructions:Record<number,string>={
    4:'核对保证书银行名称与授信函中的贷款人；总行或分支行的适用关系需人工判断。',
    8:'按原文所列周期确认新本票更新日期。',9:'按原文适用法律，确认该担保人是否适用。',
    11:'核对银行同意签章及客户经理签署；需查看原文确认是否存在。',
    12:'逐人核对保证人签署；需查看原文确认每位保证人是否已签署。',
    14:'先匹配担保人姓名，再逐人核对身份证号码。',
    16:'核对台湾客户经理的标准版本确认；非标准版本需核对当地法务确认。',
    24:'核对本票发票人签署是否对应保证书中的担保人。',
    33:'核对担保人签署，并由客户经理确认已核对签字。',
   };
   check.reason=instructions[number]??'请按本条银行要求逐项核对原文，并记录人工判断及待跟进事项。';
   return check;
  }
  // Keep an existing scope current, but do not invent an identity prerequisite
  // for a rule that only compares the supplied amounts, dates or text.
  if(owner&&owner.validity!=='current'){check.reason='材料归属依据已变化，请重新核实当前文件范围。';return check;}
  if(number===7){
   // The bank requires a minimum comparison when an amount is provided. An
   // extracted finite cap does not need a second human 'limited' switch.
   const benchmark=related[1]?.fact;
   if(!benchmark||benchmark.automaticAdoption||benchmark.validity!=='current'||benchmark.state!=='present'){
    check.reason='请填写用户或审批要求的担保金额和币种，用于比较保证书金额；不能用保证书金额作为自身基准。';return check;
   }
  }
  // Current human adoption is authoritative; file values remain visible alongside it.
  const effective=fields.map((id,i)=>{
   const fact=related[i]?.fact;
   return fact&&!fact.automaticAdoption?sources.filter(s=>s.fieldId===id&&s.id.endsWith(':fact')):sources.filter(s=>s.fieldId===id);
  }).filter((group,index)=>number!==6||index===0||group.some(source=>source.documentId||source.values.length||source.id.endsWith(':fact')));
  if(mode==='blank'){
   const fact=row.fact;
   if(fact?.validity==='current'&&fact.state==='expected_blank'&&fact.evidence.length){check.outcome='consistent';check.reason='已按对应原文人工确认留空。';}
   else if(effective[0]?.some(s=>usable(s)&&s.values.some(value=>!personalBankBlankTemplate(number,value)))){check.outcome='different';check.reason='未留空，人工判断。';}
   else check.reason='请查看原文栏位并确认是否留空；未提取到值不能证明留空。';
   return check;
  }
  const available=effective.map(group=>group.filter(usable));
  const complete=(number!==6||effective.length>1)&&effective.every(group=>group.length&&group.every(usable));
  if(mode==='present'){
   if(row.fact?.validity==='current'&&row.fact.state==='expected_blank'){check.outcome='different';check.reason=bank.notice;}
   else if(complete){check.outcome='consistent';check.reason='职衔已填写。';}else check.reason='请核对职衔栏；确认留空时按银行要求补充。';return check;
  }
  if(mode==='text'){
   // Reuse the corporate meaning-review pipeline only for complete textual
   // comparisons. Manual signature/identity decisions and numeric rules stay out.
   check.semanticEligible=complete&&semanticEligible(check,manifest)&&
    (![5,6].includes(number)||sources.some(s=>s.fieldId==='pg_facility_parties'&&s.documentId));
   // Compare the complete list, preserving every named person. This only
   // establishes content agreement, never identity or material ownership.
   if(complete&&(![5,6].includes(number)||sources.some(s=>s.fieldId==='pg_facility_parties'&&s.documentId))&&(!row.objectId||effective.every(group=>new Set(group.flatMap(s=>s.values)).size===1))&&[5,6,13,23,26,29,31,32,34].includes(number)&&personalTextEqual(number,effective.map(group=>group[0]!.fieldId),effective)){
    check.outcome='consistent';check.semanticEligible=false;check.reason='银行指定的对应文字或完整姓名名单一致；不代替担保人身份、材料归属或法律适用性确认。';return check;
   }
   const keys=available.map(group=>group.map(s=>[...new Set(crossFileSourceReading(check,s).values.map(value=>personalBankComparableValue(check,value)))]));
   // A bilingual rendering may normalize to one name. Multiple distinct values
   // inside the same person's source remain ambiguous, never a selectable match.
   if(keys.some(group=>group.some(values=>values.includes(undefined)||values.length!==1))){
    check.reason='同一来源的名称或条款尚未明确，请核对原文；不以其中一个候选值代表全部内容。';return check;
   }
   const values=keys.map(group=>[...new Set(group.flat())].sort());
   const primaryValues=values[0]!;
   const different=primaryValues.length&&values.slice(1).some(v=>v.length&&new Set([...v,...primaryValues]).size>1);
   if(number===4&&different){check.reason='保证书与授信函中的银行名称不同，请按原表核实总行或分支行关系。';return check;}
   if(different){check.outcome='different';check.reason=`对应取值文字有差异。${bank.notice}${complete?'':' 另有来源未完成核对。'}`;}
   else if(complete&&(![5,6].includes(number)||sources.some(s=>s.fieldId==='pg_facility_parties'&&s.documentId))){check.outcome='consistent';check.reason='银行指定的对应字段取值一致。';}
   else if([5,6].includes(number)&&!sources.some(s=>s.fieldId==='pg_facility_parties'&&s.documentId))check.reason='未提供授信函，按银行原表需人工判断；已保留客户名称对照结果。';
   else check.reason=sources.some(s=>s.state==='processing')?'部分字段仍在提取，完成后再核对。':sources.some(s=>s.state==='uncertain'||s.warnings.length)?'对应名称已有取值，但部分原文来源存疑；请核实下方列出的文件与依据。':'缺少对应文件或字段值，请补齐后核对。';
   return check;
  }
  const amount=mode==='amount'||mode==='minimum';
  const parsed=available.map((group,i)=>group.flatMap(s=>s.values.map(value=>normalizeReviewValue(value,amount?'amount':'date',
   {currency:related[i]?.fact?.normalization.currency??undefined}))).filter(v=>v.status!=='pending'&&v.value!==null));
  const reliable=available.every((group,i)=>group.length&&parsed[i]!.length===group.flatMap(s=>s.values).length);
  if(!reliable){check.reason=number===7?bank.notice:'日期、金额或币种尚不能明确读取，请核对原文。';return check;}
  const first=parsed[0]!;
  let mismatch=false;
  if(mode==='today')mismatch=first.some(v=>v.value!>today);
  else if(amount){
   if(parsed.some(group=>group.some(v=>!v.currency))){check.reason='币种不明确，请核对原文。';return check;}
   if(new Set(parsed.flat().map(v=>v.currency)).size!==1){
    check.outcome=mode==='amount'?'different':'manual';check.reason=mode==='amount'?'对应金额的币种不同；不进行汇率换算。':'要求金额与担保金额的币种不同，无法判断是否达到最低要求；不进行汇率换算。';return check;
   }
   mismatch=first.some(a=>parsed[1]!.some(b=>{
    if(mode==='amount')return a.value!==b.value;
    const x=decimal(a.value!),y=decimal(b.value!);return x.n*y.scale<y.n*x.scale;
   }));
  }else mismatch=first.some(a=>parsed[1]!.some(b=>mode==='date_order'?a.value!>b.value!:a.value!==b.value));
  check.outcome=mismatch?'different':complete?'consistent':'manual';
  check.reason=mismatch?bank.notice:complete?'符合本条银行要求。':'已取得值未发现差异，仍有来源待核对。';
  return check;
 });
}
