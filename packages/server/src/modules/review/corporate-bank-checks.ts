import {CORPORATE_RULE_ROWS,CORPORATE_WORKBOOK_SHA256} from '@hsbc/contracts/corporate-requirements';
import {currentRequirementPolicy,systemJudgementEnabled} from './requirement-policy.js';
import type {ChecklistRow,CrossFileCheck,CrossFileValue} from '@hsbc/contracts/review-checklist';
import type {ReviewConfigManifest} from '@hsbc/contracts/review-config';

type Mode='text'|'equal'|'date_order'|'minimum'|'manual';
/** Directed counterparts transcribed from SRC-CGT/规则校验. No transitive
 * equality groups: the RM bank compares to the guarantee, not to every bank. */
export const corporateBankMappings:ReadonlyArray<readonly [number,string,readonly string[],Mode]>=[
 [4,'cgt_field_4',['cgt_facility_lender'],'text'],[5,'cgt_field_13',['cgt_field_4'],'manual'],
 [6,'cgt_field_5',[],'manual'],[7,'cgt_field_6',['cgt_authorization_date'],'manual'],
 [8,'cgt_field_7',['cgt_facility_borrower'],'text'],[9,'cgt_field_8',['cgt_customer_official_address'],'text'],
 [10,'cgt_field_9',['cgt_facility_guarantor','cgt_field_61','cgt_field_42','cgt_field_63'],'text'],
 [11,'cgt_field_10',['cgt_field_43'],'text'],[12,'cgt_field_11',['cgt_field_60','cgt_field_41'],'manual'],
 [13,'cgt_field_12',['cgt_limited','cgt_user_required_amount','cgt_user_required_currency'],'manual'],
 [14,'cgt_field_14',['cgt_field_9','cgt_field_61','cgt_field_42','cgt_field_63'],'text'],
 [15,'cgt_field_15',['cgt_field_29','cgt_field_31'],'manual'],
 [16,'cgt_field_16',['cgt_identity_details'],'manual'],[17,'cgt_field_17',['cgt_identity_details'],'manual'],[18,'cgt_field_18',['cgt_identity_details'],'manual'],
 [19,'cgt_field_19',['cgt_authorization_reference_date'],'equal'],[20,'cgt_field_20',['cgt_field_21','cgt_field_22','cgt_field_23'],'manual'],
 [21,'cgt_field_21',['cgt_identity_details'],'manual'],[22,'cgt_field_22',['cgt_identity_details'],'manual'],[23,'cgt_field_23',['cgt_identity_details'],'manual'],
 [27,'cgt_field_24',['cgt_field_9','cgt_field_61','cgt_field_42','cgt_field_63'],'text'],[28,'cgt_field_25',[],'manual'],
 [29,'cgt_field_26',['cgt_field_4'],'text'],[30,'cgt_field_27',['cgt_field_7'],'text'],
 [31,'cgt_field_28',['cgt_facility_name','cgt_facility_issue_date'],'manual'],[32,'cgt_field_29',['cgt_identity_details'],'manual'],
 [33,'cgt_field_30',['cgt_field_44','cgt_field_64','cgt_field_62'],'manual'],[34,'cgt_field_31',['cgt_field_29'],'manual'],
 [36,'cgt_legal_route',[],'manual'],[37,'cgt_legal_firm',[],'manual'],
 [38,'cgt_legal_references',['cgt_field_4','cgt_field_7','cgt_field_9','cgt_field_5','cgt_field_6','cgt_field_28','cgt_facility_name','cgt_facility_issue_date'],'manual'],
 [39,'cgt_legal_conditions',[],'manual'],
 [42,'cgt_field_32',['cgt_field_9'],'text'],[43,'cgt_field_33',['cgt_field_6'],'equal'],[44,'cgt_field_34',['cgt_field_7'],'text'],[45,'cgt_field_35',['cgt_field_4'],'text'],
 [46,'cgt_field_36',[],'manual'],[47,'cgt_field_37',[],'manual'],[48,'cgt_field_38',[],'manual'],[49,'cgt_rm_clauses',[],'manual'],
 [52,'cgt_field_41',['cgt_field_11','cgt_field_60'],'manual'],[53,'cgt_field_42',['cgt_field_9','cgt_field_61'],'text'],[54,'cgt_field_43',['cgt_field_10'],'text'],
 [55,'cgt_field_44',['cgt_field_30'],'manual'],[59,'cgt_field_49',['cgt_field_11','cgt_field_60'],'manual'],[60,'cgt_field_50',['cgt_field_9','cgt_field_61'],'text'],
 [61,'cgt_field_54',['cgt_field_44','cgt_field_55','cgt_field_30'],'manual'],[62,'cgt_field_58',['cgt_field_44','cgt_field_59','cgt_field_30'],'manual'],
 [65,'cgt_field_60',['cgt_field_11'],'manual'],[66,'cgt_field_61',['cgt_field_9'],'text'],[67,'cgt_field_62',['cgt_field_5'],'manual'],
 [70,'cgt_field_63',['cgt_field_9','cgt_field_61'],'text'],[71,'cgt_field_64',[],'manual'],[72,'cgt_field_65',[],'manual'],
];

export interface BankComparison {id:string;label:string;fields:string[];method:Mode}
export function corporateBankChecks(row:ChecklistRow,rows:ChecklistRow[],manifest:ReviewConfigManifest,
 sourceFor:(row:ChecklistRow)=>CrossFileValue[],compare:(group:BankComparison,sources:CrossFileValue[])=>CrossFileCheck,
 today=new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Shanghai',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date())):CrossFileCheck[]{
 return corporateBankMappings.filter(([,primary])=>primary===row.fieldId).flatMap(([number,primary,other,method])=>{
  const bank=CORPORATE_RULE_ROWS.find(r=>r.row===number)!;
  const fields=[primary,...other.map(id=>/^cgt_facility_(lender|borrower|guarantor)$/.test(id)&&!manifest.fields.some(f=>f.id===id)&&manifest.fields.some(f=>f.id==='cgt_facility_parties')?'cgt_facility_parties':id)];
  const related=(id:string)=>rows.find(r=>r.fieldId===id&&r.objectId===row.objectId&&r.objectRole===row.objectRole);
  let sources=fields.flatMap(id=>{
   const r=related(id);
   return r?sourceFor(r):[{id:`${row.id}:${id}:bank-missing`,fieldId:id,label:manifest.fields.find(f=>f.id===id)?.label??(id==='cgt_customer_official_address'?'客户官方注册文件地址':'对应银行要求的字段'),documentId:null,filename:'对应材料',values:[],evidence:[],warnings:[],state:'missing' as const}];
  });
  // The workbook lists official records as alternative evidence, not a demand
  // that every example document must be supplied. Retain provided empty records.
  if([10,14,27].includes(number)){
   const alternatives=['cgt_field_61','cgt_field_42','cgt_field_63'];
   if(sources.some(s=>alternatives.includes(s.fieldId)&&s.documentId))sources=sources.filter(s=>!alternatives.includes(s.fieldId)||s.documentId);
  }
  if(number===33)sources=sources.filter(s=>s.fieldId!=='cgt_field_64'||s.documentId); // “如提供了公司章程”
  if([9,17,21,22,23].includes(number))sources=sources.map(s=>s.fieldId!==primary&&!s.documentId&&s.state==='missing'?{...s,state:'pending_confirmation' as const,warnings:[]}:s);
  const group={id:`bank:${number}`,label:bank.label.replace(/\n/gu,' ')||row.label,fields,method};
  let check=compare(group,sources);
  const configured=manifest.sources.some(s=>s.id===`cgt_rule_source_${number}`&&s.sha256===CORPORATE_WORKBOOK_SHA256&&s.disposition!=='excluded');
  if(!configured)check={...check,outcome:'insufficient',reason:'当前配置尚无本条银行原表的有效来源，请核对配置。'};
  else if(!other.length&&[47,48].includes(number)&&sources.length&&sources.every(s=>s.state==='available'&&!s.warnings.length&&s.values.some(v=>v.trim())))check={...check,outcome:'consistent',reason:'已按银行原表核对本栏非空。'};
  else if(method==='manual'&&check.outcome==='manual')check={...check,reason:bank.requirement||bank.notice};
  if(configured&&number===13){
   const limited=related('cgt_limited')?.fact,sourceDefaults=systemJudgementEnabled(currentRequirementPolicy());
   const current=limited?.validity==='current'&&limited.state==='present';
   const amountRule=manifest.rules.find(r=>r.id==='cgt_amount_minimum');
   const inputs=amountRule?.inputs??['cgt_amount','cgt_user_required_amount','cgt_currency','cgt_user_required_currency'];
   const supported=inputs.length===4&&inputs[0]==='cgt_amount'&&inputs[2]==='cgt_currency'&&
    (inputs[1]==='cgt_user_required_amount'&&inputs[3]==='cgt_user_required_currency'||inputs[1]==='cgt_required_amount'&&inputs[3]==='cgt_required_currency');
   const benchmarks=[inputs[1],inputs[3]].map(id=>id?related(id)?.fact:undefined);
   if(current&&limited.rawValue==='unlimited')check={...check,outcome:'not_applicable',reason:'已确认无限额责任担保，银行原表不要求列示或比较详细金额。'};
   // What the facility letter states for this guarantee is taken as the amount to compare against. It is shown with its
   // source and replaced by the reviewer's own figure once one is entered.
   else if(!current||limited.rawValue!=='limited'||!supported||benchmarks.some(f=>!f||f.automaticAdoption&&!sourceDefaults||f.validity!=='current'||f.state!=='present'||f.normalization.status==='pending'))check={...check,outcome:'manual',reason:sourceDefaults?'请确认担保责任范围；有限额担保未取得授信函要求的担保金额及币种时，请判断保证书所列金额是否可接受，或填写用户要求的金额及币种。':'请确认担保责任范围；有限额担保未提供用户要求金额时，按银行原表提醒用户判断金额是否可接受。授信函金额不自动成为用户要求。'};
   else {
    const numeric=inputs.flatMap((id,i)=>{const r=related(id);return r?sourceFor(r).filter(s=>i%2===0||s.id.endsWith(':fact')):[];});
    check=compare({id:'rule:cgt_amount_minimum',label:bank.label,fields:inputs,method:'minimum'},numeric);
    if(benchmarks.some(f=>f?.automaticAdoption)&&['consistent','different'].includes(check.outcome))check={...check,reason:`${check.reason}（要求金额及币种取自授信函，可更正。）`};
   }
  }
  if(configured&&number===9&&sources.some(s=>s.fieldId==='cgt_customer_official_address'&&!s.documentId))check={...check,outcome:'manual',reason:'未取得客户官方注册文件地址，按银行原表由客户经理确认地址有效。'};
  const bankRule={row:number,reference:`SRC-CGT/规则校验!B${number}:F${number}`,requirement:bank.requirement,notice:bank.notice,primaryFieldId:primary};
  if(configured&&number===7){
   const authorized=compare({id:'rule:cgt_signing_authorized',label:'签署日不早于授权文件签署日',fields:['cgt_authorization_date',primary],method:'date_order'},[...sources.filter(s=>s.fieldId==='cgt_authorization_date'),...sources.filter(s=>s.fieldId===primary)]);
   const current:CrossFileValue={id:`${row.id}:today`,fieldId:'review_business_date',label:'当前日期（北京时间）',documentId:null,filename:'当前日期',values:[today],evidence:[],warnings:[],state:'available'};
   const future=sources.filter(s=>s.fieldId===primary).map(source=>compare({id:`${source.id}:rule:cgt_field_6_not_future`,label:'签署日不晚于当前日期',fields:[primary,'review_business_date'],method:'date_order'},[source,current]));
   return [authorized,...future].map(c=>({...c,semanticEligible:false,bankRule:{...bankRule,currentDate:today}}));
  }
  if(configured&&number===20){const witness=related('cgt_witness_signed')?.fact;if(witness?.validity==='current'&&witness.state==='present'&&witness.rawValue==='no'&&witness.evidence.length)check={...check,outcome:'not_applicable',reason:'已依据原文确认无见证人签署，银行第 20 行“若有签署”的适用条件不成立。'};}
  return [{...check,id:`${row.id}:${number===13?'rule:cgt_amount_minimum':`bank:${number}`}`,semanticEligible:false,bankRule}];
 });
}
