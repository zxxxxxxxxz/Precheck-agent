export {PERSONAL_LEGAL_LABELS,PERSONAL_RETIRED_INPUTS,personalLegalItem} from './personal-bank-scope.js';
import {applyGuaranteeRoleEvidence,type GuaranteeExtractionOptions} from './guarantee-role-evidence.js';
import {REVIEW_BANK_SOURCE_REFERENCES, REVIEW_EXTRACTION_RECIPES, ReviewConfigManifestSchema, type ReviewConfigManifest, type ReviewFieldDefinition, type ReviewRule, type ReviewFacts} from './review-config.js';
import {PERSONAL_FIELDS, PERSONAL_RULE_ROWS, PERSONAL_CHECKLIST_ROWS, PERSONAL_CHECKLIST_INTRO} from './personal-requirements-data.js';
export {PERSONAL_FIELDS, PERSONAL_RULE_ROWS, PERSONAL_CHECKLIST_ROWS, PERSONAL_CHECKLIST_INTRO} from './personal-requirements-data.js';

export const PERSONAL_WORKBOOK_SHA256='7ff0e8290b35efef5d73a95ec683fe4767d77d96ea80c3ede216d8e8c2dbe300';
export const PERSONAL_CHECKLIST_SHA256='7e3472610395b60c7e8d628aa6bdf4c9bbf8d9ed14c0df81810eeb959caf23a2';
// Historical review inputs remain available to rules, but are not source fields.
export const PERSONAL_IDENTITY_HIDDEN_FIELDS=['pg_field_40','pg_identity_required','pg_identity_confirmed','pg_verified_identity_number'] as const;
export const PERSONAL_IDENTITY_SOURCE_FIELDS=['pg_identity_name','pg_identity_number','pg_identity_address','pg_identity_type','pg_field_39'] as const;
export const PERSONAL_DERIVED_FIELDS=['pg_yes','pg_guarantee_currency','pg_note_currency','pg_required_currency','pg_verified_identity_number'] as const;
const yesNo=[{value:'yes',label:'需要／适用'},{value:'no',label:'不需要／不适用'}];
export const PERSONAL_FACT_OPTIONS:Record<string,Array<{value:string;label:string}>>={
 ...Object.fromEntries(PERSONAL_CHECKLIST_ROWS.map((_,i)=>[`pg_legal_checklist_${i+1}_applicable`,yesNo])),
 pg_required:yesNo,pg_note_required:yesNo,pg_authorization_required:yesNo,pg_identity_required:yesNo,pg_translation_required:yesNo,
 pg_limited:[{value:'limited',label:'有限额责任担保'},{value:'unlimited',label:'无限额责任担保'}],
 pg_legal_route:[{value:'opinion',label:'法律意见书'},{value:'rm',label:'客户经理证明（已确认适用简化流程）'},{value:'waiver',label:'法律意见豁免批准'},{value:'none',label:'无需法律配套（须有依据）'}],
 pg_taiwan_law:yesNo,
 pg_identity_confirmed:[{value:'yes',label:'已确认该证件属于本担保人'},{value:'no',label:'尚不能确认属于本担保人'}],
 pg_guarantor_signed:[{value:'yes',label:'已核对该担保人的签署存在'},{value:'no',label:'该担保人未签署'}],
 pg_bank_signed:[{value:'yes',label:'已核对银行方签署存在'},{value:'no',label:'银行方未签署'}],
};
const scope={kind:'guarantee',role:'personal_guarantee'} as const;
const groups={guarantee:['个人保证书','連續保證書（個人適用）','个人担保','Personal Guarantee'],note:['本票','Promissory Note'],authorization:['授权补全本票','授權書','Authorization to Complete Promissory Notes'],identity:['担保人身份证明','身份证明','身份证','身份證','居民身份证','中华人民共和国居民身份证','中華人民共和國居民身份證','國民身分證','中華民國國民身分證','中華民國國民身分證 測試樣張','香港永久性居民身份證','香港居民身份證','护照','護照','通行证','Identity Document','Identity Card','National Identity Card','Passport'],legal:['法律意见书','Legal Opinion'],facility:['授信函','Facility Offer Letter'],registration:['借款人注册文件','Certificate of Incorporation','Annual Return'],rm:['环球客户经理证明','RM certification'],waiver:['法律意见豁免批准','Legal opinion waiver'],translation:['中文版本','Chinese Translation']} as const;
type Group=keyof typeof groups;
const typeId=(g:Group)=>`pg_${g}`;
const dates=new Set([10,18,19,27]),amounts=new Set([7,17,20]),signatures=new Set([11,12,22,30]),blankRows=new Set([19,20,35]);
const partyRows=new Set([4,5,6,13,21,26,28,31]);
const aliases:Record<number,string[]>={4:['银行','銀行','致','Bank'],5:['保证人','保證人','立保證書人','Guarantor'],6:['主债务人','主債務人','借款人','Principal Debtor'],7:['金额','金額','本金不得超過','Amount'],8:['自本保證書簽訂日起','自本保证书签订日起','新本票'],9:['依中華民國法律解釋','依','法律解释','法律解釋','Governing Law'],10:['日期','Dated','Date'],13:['姓名','Name'],14:['身份证号码','身份證號碼','ID Card No.'],15:['地址','Address'],17:['金额','金額','Amount'],18:['发票日','發票日','Date'],19:['给付日','給付日','憑票准於'],20:['给付','給付'],21:['银行名称','銀行名稱','无条件向','無條件向'],23:['地址','Address'],24:['准据法','準據法','governed by'],26:['银行','銀行','致'],27:['日期','Date'],28:['立书人','立書人','立授權書人','THE UNDERSIGNED'],29:['法律解释','法律解釋','governed by'],31:['姓名','Name'],32:['职衔','職銜','Title'],33:['身份证字号','身份證字號','ID Number'],34:['住址','Address'],35:['背书人','背書人','THE ENDORSER'],39:['国别','國別','Nationality'],40:['姓名','证件号码','地址','有效期']};
const ruleField:Record<number,number>={4:4,5:5,6:6,7:7,8:8,9:9,10:10,11:11,12:12,13:13,14:14,15:15,16:9,19:17,20:18,21:19,22:20,23:21,24:22,25:23,26:24,29:26,30:27,31:28,32:29,33:30,34:31,35:32,36:33,37:34,38:35,40:37,41:37,42:37,43:37,47:39,48:40};
const recipe=(automatic:boolean):ReviewFieldDefinition['recipe']=>{const r=REVIEW_EXTRACTION_RECIPES.find(r=>r.version===(automatic?'azure-grounded-fields-v2':'p3-manual-evidence-v1'))!;return {version:r.version,model:r.model,promptSha256:r.promptSha256,mode:automatic?'cloud_grounded_extract':'manual'};};
const condition=(fieldId:string,equals:string|boolean)=>({fieldId,equals});
const fieldSource=(row:number)=>`pg_field_source_${row}`,ruleSource=(row:number)=>`pg_rule_source_${row}`;
const fact=(value:string|boolean|null,state:ReviewFacts[string]['state']='present'):ReviewFacts[string]=>({value,state,evidenceIds:[]});

/** Bank-origin candidate for isolated engineering acceptance, never a bank approval. */
export function createPersonalGuaranteeManifest(releaseId:string,options:GuaranteeExtractionOptions={}):ReviewConfigManifest {
 const m:ReviewConfigManifest={schemaVersion:'review-config.v1',releaseId,label:'个人担保配置',scope:'synthetic',scenario:'overseas_loan',guaranteeTypes:['personal_guarantee'],bankApprovalRef:null,
  sources:REVIEW_BANK_SOURCE_REFERENCES.map(s=>({id:s.id,reference:s.registerId,sha256:s.sha256,guaranteeType:s.guaranteeType,disposition:'manual',reason:'来源登记；仅执行本配置个人担保逐行映射。',approvalRef:null})),taxonomy:[],materials:[],fields:[],rules:[],parameters:{},compatibility:{documentSchema:'p2.v2',factsSchema:'review-facts.v2',executorVersion:'p3-deterministic-v3'}};
 const source=(id:string,reference:string,sha256=PERSONAL_WORKBOOK_SHA256)=>m.sources.push({id,reference,sha256,guaranteeType:'personal_guarantee',disposition:'candidate',reason:'银行来源候选；用于隔离验收，正式业务批准另行记录。',approvalRef:null});
 source('pg_materials','SRC-PG/材料清单!C4:F8');source('pg_translation','SRC-PG/提取信息!B49、规则校验!B51');
 source('pg_checklist','Legal Opinion Checklist --draft.docx/意见类型矩阵及正文',PERSONAL_CHECKLIST_SHA256);
 source('pg_execution','用户确认（2026-10-24）：身份证字号先确认同一人再核对号码；银行签署仅台湾法条件适用；境内外及法律效力重点人工核对。');
 for(const f of PERSONAL_FIELDS)source(fieldSource(f.row),`SRC-PG/提取信息!C${f.row}:G${f.row}`);
 for(const r of PERSONAL_RULE_ROWS)source(ruleSource(r.row),`SRC-PG/规则校验!B${r.row}:F${r.row}`);
 for(const [g,values] of Object.entries(groups))m.taxonomy.push({id:typeId(g as Group),label:values[0],keywords:[...values],sourceIds:['pg_materials']});
 const addField=(id:string,label:string,group:Group,definition:string,options:Partial<ReviewFieldDefinition>={})=>m.fields.push({id,label,type:'text',objectKind:'guarantee',objectRole:scope.role,aliases:[label],taxonomyIds:[typeId(group)],valueKind:'text',valueMultiplicity:'clauses',unit:null,currency:null,requiredDetection:true,requiredValue:false,sourceIds:['pg_materials'],semanticDefinition:definition+' 仅提取当前文件可见内容，保留每个人的原文位置与上下文，不合并同名、同值或不同签署栏。遮挡、不可读、未检测到与空白分别记录，不猜测被遮盖值；签署姓名不等于签署存在。',recipe:recipe(true),...options});
 for(const f of PERSONAL_FIELDS){
  const date=dates.has(f.row),amount=amounts.has(f.row),party=partyRows.has(f.row),signature=signatures.has(f.row);
  addField(f.id,f.label.replace(/\n/g,' '),f.group,`${groups[f.group][0]}：${f.meaning||f.label}。${f.requirement}。${blankRows.has(f.row)?'本栏必须检测，但按银行规则应留空；零候选不能证明原文留空，需保留空栏定位供人工确认。':''}`,{
   type:date?'date':amount?'amount':'text',valueKind:date?'date':amount?'amount':party?'party_name':[14,33].includes(f.row)?'identifier':[15,23,34].includes(f.row)?'address':'text',
   ...(party?{partyKinds:([4,21,26].includes(f.row)?['organization']:f.row===6?['organization','person']:['person']) as Array<'person'|'organization'>}:{}),
   valueMultiplicity:party?'entities':f.row===37||f.row===8?'clauses':'single',aliases:aliases[f.row]??[f.label],requireLabel:party,
   unit:amount?'currency':null,requiredValue:!blankRows.has(f.row)&&!signature&&f.requirement==='必需',sourceIds:[fieldSource(f.row)],recipe:recipe(!signature),requiredDetection:!signature,
  });
 }
 // The repeated Name labels below the endorser section belong to a different role.
 Object.assign(m.fields.find(f=>f.id==='pg_field_31')!,{partyNameSection:{headings:['立書人','立书人','THE UNDERSIGNED'],otherHeadings:['背書人','背书人','THE ENDORSER']}});
 const helper=(id:string,label:string,group:Group,definition:string,type:ReviewFieldDefinition['type']='text')=>addField(id,label,group,definition+' 只确认当前这一位担保人的安排及依据。',{type,valueKind:type==='text'?'text':type,valueMultiplicity:'single',unit:type==='amount'?'currency':null,requiredDetection:false,recipe:recipe(false),sourceIds:['pg_execution']});
 for(const [id,label,group,definition] of [
  ['pg_required','需要个人保证书','guarantee','依据风控审批确认 yes/no；未知不默认不需要。'],['pg_note_required','需要本票','note','逐人确认是否要求本票。'],['pg_authorization_required','需要授权补全本票文件','authorization','逐人确认授权要求。'],['pg_identity_required','需要身份证明','identity','逐人确认身份证明要求。'],
  ['pg_legal_route','法律配套要求','legal','确认 opinion/rm/waiver/none，并附适用及批准依据；无名单或批准不能猜选。'],['pg_limited','担保责任是否有限额','guarantee','确认 limited/unlimited；金额空白不能证明无限额。'],
  ['pg_taiwan_law','已确认适用台湾法','guarantee','依据适用法律条款确认 yes/no，不能由国别推断。'],['pg_bank_signed','银行方签署已存在','guarantee','按原件确认是否有银行方签署，不比较笔迹真伪。'],['pg_guarantor_signed','该担保人签署已存在','guarantee','按当前担保人的签署区域确认 yes/no，不能使用其他人的签署。'],['pg_translation_required','需要中文版本','translation','逐份核对外文材料的中文版本要求。'],['pg_yes','检查值：是','guarantee','系统固定 yes，不接受人工覆盖。'],
  ['pg_identity_confirmed','证件已确认属于该担保人','identity','先核对证件姓名与保证人身份及关联证据，再确认 yes/no；同名不能自动合并。'],['pg_verified_identity_number','归属已确认的证件号码','identity','系统仅在证件归属已确认后提供用于比较的号码。'],
 ] as const)helper(id,label,group,definition);
 helper('review_business_date','审核基准日','guarantee','采用审核快照日期。','date');
 helper('pg_required_amount','用户要求的担保金额','facility','独立输入用户或审批要求的金额和币种，不能用保证书自身代替。','amount');
 for(const [id,label] of [['pg_guarantee_currency','保证书金额币种'],['pg_note_currency','本票金额币种'],['pg_required_currency','要求金额币种']] as const)helper(id,label,'guarantee','系统从对应已确认金额的规范化币种派生，不接受人工覆盖。','currency');
 for(const [id,label,g,definition] of [
  ['pg_facility_parties','授信函主体及个人担保安排','facility','逐一提取贷款人、借款人、每名担保人及各自对应的保证安排。'],['pg_identity_type','身份证明类别','identity','提取证件标题明确写明的类别，例如国民身分证、护照、通行证；保留原文，不使用本系统材料分类名称代替，不从号码格式猜测。'],
  ['pg_identity_name','身份证明姓名','identity','提取证件持有人姓名。'],['pg_identity_number','身份证明号码','identity','只提取证件号码本身，保留前导零、字母及连接符；不拼入证件类别、标签或持有人姓名。'],['pg_identity_address','身份证明地址','identity','提取证件或地址证明的地址及持有人。'],['pg_legal_firm','法律意见出具律所与范围','legal','提取律所与意见覆盖范围，不推定批准名单资格。'],['pg_legal_references','法律意见审阅材料及主体','legal','提取文件名称、日期、版本及主体；列出未提供材料和差异。'],['pg_legal_conditions','法律意见假设、保留及后续事项','legal','分别提取不利内容、前提、尚待完成文件、生效条件和跟进事项。'],
 ] as const)addField(id,label,g,definition);
 Object.assign(m.fields.find(f=>f.id==='pg_field_39')!,{label:'国别与地区',aliases:['国别与地区','国别','國別','国家或地区','國家或地區','国籍','國籍','Country / Region','Nationality'],semanticDefinition:'提取证件明确写明的国别或地区，国籍栏可作为国别来源，保留原文与定位依据；未明确写明时保持未知，不从地址、姓名、证件号码、签发机关或适用法律推断。'});
 Object.assign(m.fields.find(f=>f.id==='pg_identity_number')!,{valueKind:'identifier',valueMultiplicity:'single'});
 const material=(g:Group,required:boolean,applicability?:ReviewRule['applicability'])=>m.materials.push({id:typeId(g),label:groups[g][0],taxonomyId:typeId(g),required,objectScope:scope,sourceIds:['pg_materials'],...(applicability?{applicability}:{})});
 for(const [g,id] of [['guarantee','pg_required'],['note','pg_note_required'],['authorization','pg_authorization_required'],['identity','pg_identity_required'],['translation','pg_translation_required']] as const)material(g,true,condition(id,'yes'));
 for(const [g,value] of [['legal','opinion'],['rm','rm'],['waiver','waiver']] as const)material(g,true,condition('pg_legal_route',value));
 material('facility',false);material('registration',false);
 const addRule=(id:string,label:string,operator:ReviewRule['operator'],inputs:string[],sourceIds:string[],description:string,values:Array<Array<string|boolean|null>>,extra:Partial<ReviewRule>={})=>{
  const r:ReviewRule={id,label,operator,inputs,objectScope:scope,sourceIds,description,sourceDirectionConfirmed:true,requiredParameters:[],...extra,tests:[]};
  r.tests=(['normal','abnormal','boundary','missing_input'] as const).map((kind,index)=>({id:kind,kind,synthetic:true,facts:Object.fromEntries(inputs.map((key,i)=>[key,index===3&&i===0?fact(null,'missing'):fact(values[Math.min(index,2)]?.[i]??values[0]?.[i]??null,operator==='blank'&&index!==1?'blank':'present')])),expected:operator==='manual_review'?'blocked':kind==='abnormal'?'fail':kind==='missing_input'?operator==='present'?'fail':'blocked':'pass'}));
  for(const t of r.tests)for(const id of inputs){
   const definition=m.fields.find(f=>f.id===id),value=t.facts[id];
   if(!value||value.state!=='present')continue;
   if(operator==='present'&&value.value===''){t.facts[id]=fact(null,'missing');continue;}
   if(operator==='manual_review'||operator==='blank'){
    if(definition?.type==='date')t.facts[id]=fact('2026-10-20');
    if(definition?.type==='amount')t.facts[id]=fact('100');
   }
  }
  for(const t of r.tests)if(r.applicability)t.facts[r.applicability.fieldId]=fact(r.applicability.equals);
  m.rules.push(r);return r;
 };
 for(const item of m.materials.filter(x=>x.required))addRule(`${item.id}_required`,`${item.label}：材料要求`,'present',[`material:${item.id}`],item.sourceIds,'按当前担保人及已确认的适用条件检查；上传未处理不代表缺件或不适用。',[[true],[false],[true]],{applicability:item.applicability});
 for(const f of PERSONAL_FIELDS){
  if(blankRows.has(f.row)||signatures.has(f.row)||f.row===37)continue;
  const value=dates.has(f.row)?'2026-10-20':amounts.has(f.row)?'100':'已确认值';
  addRule(`${f.id}_required`,`${groups[f.group][0]}：${f.label.replace(/\n/g,' ')}完整性`,'present',[f.id],[fieldSource(f.row)],'有条件字段先确认适用性；未识别、遮挡及不可读保留无法检查。',[[value],[''],[value]],{applicability:f.row===7?condition('pg_limited','limited'):condition(`material:${typeId(f.group)}`,true)});
 }
 for(const row of PERSONAL_RULE_ROWS){
  const input=`pg_field_${ruleField[row.row]}`,extra:Partial<ReviewRule>={applicability:condition(`material:${typeId(row.group)}`,true)};
  let op:ReviewRule['operator']='manual_review',inputs=[input],values:Array<Array<string|boolean|null>>=[['待核对']],description=`${row.requirement} ${row.notice}`;
  if(row.row===7){op='minimum_ratio';inputs=['pg_field_7','pg_required_amount','pg_guarantee_currency','pg_required_currency'];values=[['100','90','TWD','TWD'],['89','90','TWD','TWD'],['90','90','TWD','TWD']];extra.factor='1';extra.applicability=condition('pg_limited','limited');}
  if(row.row===10){op='date_order';inputs=[input,'review_business_date'];values=[['2026-10-19','2026-10-20'],['2026-10-21','2026-10-20'],['2026-10-20','2026-10-20']];}
  if(row.row===12){op='equal';inputs=['pg_guarantor_signed','pg_yes'];values=[['yes','yes'],['no','yes'],['yes','yes']];}
  if(row.row===11){op='equal';inputs=['pg_bank_signed','pg_yes'];values=[['yes','yes'],['no','yes'],['yes','yes']];extra.applicability=condition('pg_taiwan_law','yes');description='仅在已确认适用台湾法时核对银行方签署存在；法律未确认时无法检查，不以打印姓名证明签署。';}
  if([14,36].includes(row.row)){op='equal';inputs=[input,'pg_verified_identity_number'];values=[['TEST001','TEST001'],['TEST002','TEST001'],['001','001']];description='先确认身份证明属于当前担保人，再逐字核对身份证号码；保留前导零，缺证件或归属不明时无法检查。';}
  if(row.row===19){op='minimum_ratio';inputs=['pg_field_17','pg_field_7','pg_note_currency','pg_guarantee_currency'];values=[['100','100','TWD','TWD'],['99','100','TWD','TWD'],['0.01','0.01','TWD','TWD']];extra.factor='1';description+=' 与反向金额检查共同判断同币种金额相等；币种不明或不同保持无法检查。';}
  if(row.row===20){op='equal';inputs=['pg_field_18','pg_field_10'];values=[['2026-10-20','2026-10-20'],['2026-10-19','2026-10-20'],['2026-10-20','2026-10-20']];}
  if([21,22,38].includes(row.row)){op='blank';values=[[null],['已填写'],[null]];description+=' 必须有原文位置及人工确认空栏；未检测到、脱敏或不可读不能作为留空证据。';}
  if(row.row===30){op='date_order';inputs=['pg_field_27','pg_field_18'];values=[['2026-10-19','2026-10-20'],['2026-10-21','2026-10-20'],['2026-10-20','2026-10-20']];}
  if(row.row===35){op='present';values=[['已确认职衔'],[''],['已确认职衔']];}
  if(row.row===40){inputs=['pg_legal_route'];delete extra.applicability;}
  if([41,42,43].includes(row.row))inputs=[({41:'pg_legal_firm',42:'pg_legal_references',43:'pg_legal_conditions'} as Record<number,string>)[row.row]!];
  if(row.row===47)description='重点人工核对担保人与借款人境内／境外认定、国别、适用法律及法律配套；原表认定口径待确认，不仅凭证件国别自动宣布担保无效。';
  if(op==='manual_review')extra.manualReason=[11,36,47].includes(row.row)?'business_rule_confirmation_required':row.row===41?'reference_list_required':'manual_review_required';
  addRule(`pg_bank_${row.row}`,`${groups[row.group][0]}：${row.label.replace(/\n/g,' ')}`,op,inputs,[ruleSource(row.row),...([11,36,47].includes(row.row)?['pg_execution']:[])],description,values,extra);
 }
 addRule('pg_note_amount_ceiling','本票金额不得高于保证书金额','minimum_ratio',['pg_field_7','pg_field_17','pg_guarantee_currency','pg_note_currency'],[ruleSource(19)],'与本票金额下限检查一起验证相等，不换汇。',[['100','100','TWD','TWD'],['99','100','TWD','TWD'],['0.01','0.01','TWD','TWD']],{factor:'1',applicability:condition('material:pg_note',true)});
 for(const [index,row] of PERSONAL_CHECKLIST_INTRO.entries()){
  const id=`pg_legal_intro_${index+1}`,sourceId=`pg_checklist_intro_${index+1}`;
  source(sourceId,`Legal Opinion Checklist --draft.docx/正文段落 ${row.paragraph}`,PERSONAL_CHECKLIST_SHA256);
  addField(id,`法律意见：${row.label}`,'legal',row.text,{sourceIds:[sourceId]});
  addRule(`${id}_review`,`法律意见：${row.label}`,'manual_review',[id],[sourceId],'提取相关原文，由审查人员核对草稿要求与本案适用性；虚构样例不能作为合格答案。',[['待核对']],{manualReason:'manual_review_required',applicability:condition('material:pg_legal',true)});
 }
 for(const [index,row] of PERSONAL_CHECKLIST_ROWS.entries()){
  const id=`pg_legal_checklist_${index+1}`,applicable=`${id}_applicable`;
  helper(applicable,`法律意见清单 ${index+1} 适用性`,'legal','按意见类型及当前个人担保确认 yes/no。公司注册、章程和公司授权等项目不能直接套用个人；应附确认依据。');
  addField(id,`法律意见清单 ${index+1}`,'legal',`${row.text} 原清单为草稿，需确认个人担保适用性及意见类型，逐项保留假设与保留意见。`,{sourceIds:['pg_checklist']});
  addRule(`${id}_review`,row.text.replace(/\s+/g,' ').slice(0,290),'manual_review',[id],['pg_checklist'],'逐项核对意见、适用条件、依据和备注；矩阵及公司条目适用性须确认。',[['待核对']],{manualReason:'business_rule_confirmation_required',applicability:condition(applicable,'yes')});
 }
 addRule('pg_translation_review','外文材料中文版本核对','manual_review',['pg_translation_required'],['pg_translation'],'逐份核对中文版本及对应关系，机器翻译不等于业务确认。',[['待核对']],{manualReason:'manual_review_required'});
 const native=REVIEW_EXTRACTION_RECIPES.find(r=>r.version==='azure-grounded-docx-v1')!;
 m.docxExtraction={version:native.version,model:native.model,promptSha256:native.promptSha256,mode:'cloud_grounded_extract'};
 return ReviewConfigManifestSchema.parse(applyGuaranteeRoleEvidence(m,options));
}

export function applyPersonalGuaranteeRequirements(base:ReviewConfigManifest):ReviewConfigManifest {
 if(base.guaranteeTypes.length!==1||base.guaranteeTypes[0]!=='personal_guarantee')throw new Error('personal_configuration_required');
 if(base.scope!=='synthetic')throw new Error('personal_candidate_requires_synthetic_scope');
 return {...createPersonalGuaranteeManifest(base.releaseId),label:base.label};
}

/** Code-owned optional approval-notice definitions, matching the frozen 2026-10-27
 * candidate. This constructs a candidate only; publication remains independent. */
export function createPersonalApprovalGuaranteeManifest(releaseId:string):ReviewConfigManifest {
 const manifest=createPersonalGuaranteeManifest(releaseId);
 manifest.sources.push({
  "id": "pg_approval_recognition_20261027",
  "reference": "repo:docs/p3/personal-approval-recognition-source-20261027.md",
  "sha256": "084f4bcf337ee2ceffb002d6b05fd9e90be85492784887838c0b6b188d2737d7",
  "guaranteeType": "personal_guarantee",
  "disposition": "candidate",
  "reason": "程序自有合成测试辅助提取定义；不新增银行规则，须独立批准发布。",
  "approvalRef": null
});
 manifest.taxonomy.push({
  "id": "pg_approval",
  "label": "授信及担保审批通知",
  "keywords": [
    "授信及担保审批通知",
    "授信审批通知",
    "Credit and Guarantee Approval Notice"
  ],
  "sourceIds": [
    "pg_approval_recognition_20261027"
  ]
});
 manifest.materials.push({
  "id": "pg_approval",
  "label": "授信及担保审批通知",
  "taxonomyId": "pg_approval",
  "required": false,
  "objectScope": {
    "kind": "guarantee",
    "role": "personal_guarantee"
  },
  "sourceIds": [
    "pg_approval_recognition_20261027"
  ]
});
 manifest.fields.push({
  "id": "pg_approval_parties",
  "label": "审批涉及主体及担保安排",
  "type": "text",
  "aliases": [
    "审批涉及主体及担保安排"
  ],
  "objectKind": "guarantee",
  "objectRole": "personal_guarantee",
  "semanticDefinition": "提取审批通知中的借款人、每位担保人和各自对应的保证安排；保留主体与安排的同段原文，不凭同名合并主体，不把通知作为保证书。 仅提取当前文件可见内容并保留原文定位；不猜测遮挡或不可读内容。",
  "taxonomyIds": [
    "pg_approval"
  ],
  "valueKind": "text",
  "valueMultiplicity": "clauses",
  "unit": null,
  "currency": null,
  "requiredDetection": true,
  "requiredValue": false,
  "sourceIds": [
    "pg_approval_recognition_20261027"
  ],
  "recipe": {
    "version": "azure-grounded-fields-v2",
    "model": "gpt-6-astra",
    "promptSha256": "ed1cc9e37b8cf6c8fd1a766d04f58b2fa988c8e0f3559721350ca98a647d8314",
    "mode": "cloud_grounded_extract"
  }
});
 manifest.fields.push({
  "id": "pg_approval_required_amount",
  "label": "审批要求的担保金额",
  "type": "amount",
  "aliases": [
    "每人要求的保证本金金额",
    "要求的保证本金金额",
    "担保本金金额",
    "Required Guarantee Principal"
  ],
  "objectKind": "guarantee",
  "objectRole": "personal_guarantee",
  "semanticDefinition": "仅提取明确要求担保人承担的保证本金金额和明示币种，保留适用每位担保人的上下文；授信额度、费用及本票金额不能替代。该候选不自动成为用户要求的担保金额已确认事实。 仅提取当前文件可见内容并保留原文定位；不猜测遮挡或不可读内容。",
  "taxonomyIds": [
    "pg_approval"
  ],
  "valueKind": "amount",
  "valueMultiplicity": "entities",
  "unit": "currency",
  "currency": null,
  "requiredDetection": true,
  "requiredValue": false,
  "sourceIds": [
    "pg_approval_recognition_20261027"
  ],
  "recipe": {
    "version": "azure-grounded-fields-v2",
    "model": "gpt-6-astra",
    "promptSha256": "ed1cc9e37b8cf6c8fd1a766d04f58b2fa988c8e0f3559721350ca98a647d8314",
    "mode": "cloud_grounded_extract"
  },
  "requireLabel": true,
  "excludedLabels": [
    "币种及授信额度",
    "授信额度",
    "本票金额",
    "费用"
  ]
});
 manifest.fields.push({
  "id": "pg_approval_conditions",
  "label": "审批交付条件",
  "type": "text",
  "aliases": [
    "审批交付条件"
  ],
  "objectKind": "guarantee",
  "objectRole": "personal_guarantee",
  "semanticDefinition": "提取文件、法律配套、签署、有效期及办理前条件；区分要求与已经完成的事实，审批通知本身不能证明条件已满足或文件已签署。 仅提取当前文件可见内容并保留原文定位；不猜测遮挡或不可读内容。",
  "taxonomyIds": [
    "pg_approval"
  ],
  "valueKind": "text",
  "valueMultiplicity": "clauses",
  "unit": null,
  "currency": null,
  "requiredDetection": true,
  "requiredValue": false,
  "sourceIds": [
    "pg_approval_recognition_20261027"
  ],
  "recipe": {
    "version": "azure-grounded-fields-v2",
    "model": "gpt-6-astra",
    "promptSha256": "ed1cc9e37b8cf6c8fd1a766d04f58b2fa988c8e0f3559721350ca98a647d8314",
    "mode": "cloud_grounded_extract"
  }
});
 return ReviewConfigManifestSchema.parse(manifest);
}
