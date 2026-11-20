export {CORPORATE_LEGAL_INTRO,CORPORATE_LEGAL_OPINIONS,CORPORATE_LEGAL_FOOTNOTES} from './corporate-legal-checklist.js';
import {applyCorporateRmPartyReview,applyCorporateRmSourceReview} from './corporate-rm-fields.js';
export {applyCorporateRmPartyReview,applyCorporateRmSourceReview} from './corporate-rm-fields.js';
import {corporateGuaranteeAmountField,corporateGuaranteeLimitField,corporateGuaranteeLiabilityField,corporateGuaranteeValueFields} from './corporate-guarantee-fields.js';
import {corporateArticlesDefinitions} from './corporate-articles.js';
export {CORPORATE_ARTICLES_REVIEW_INPUTS,scopeCorporateArticlesQuorum} from './corporate-articles.js';
import {corporateFacilityFields} from './corporate-facility-fields.js';
import {applyGuaranteeRoleEvidence,type GuaranteeExtractionOptions} from './guarantee-role-evidence.js';
import {REVIEW_BANK_SOURCE_REFERENCES, REVIEW_EXTRACTION_RECIPES, ReviewConfigManifestSchema, type ReviewConfigManifest, type ReviewFieldDefinition, type ReviewRule} from './review-config.js';
import {CORPORATE_FIELDS, CORPORATE_RULE_ROWS} from './corporate-requirements-data.js';
import {corporateFieldSection, isCorporateSectionHeading} from './corporate-field-sections.js';
export {corporateFieldSection, isCorporateSectionHeading, CORPORATE_CHANGE_SECTIONS} from './corporate-field-sections.js';
export {CORPORATE_FIELDS, CORPORATE_RULE_ROWS} from './corporate-requirements-data.js';

export const CORPORATE_WORKBOOK_SHA256='4f0658a1277bcfe6e6e436c2018060eb5dfb2dbc57d73a9c4a2e63fc84292128';
export const CORPORATE_CHECKLIST_SHA256='371160a9fa387a175f0a2cfbed013ba498fb7b9fa97897136c6945e843ab6429';
export const CORPORATE_DERIVED_FIELDS=['cgt_yes','cgt_rm_valid_option','cgt_resolution_minimum'] as const;
/** Copy only extraction semantics; retain the selected version's business rules,
 * source references, manual fields and signature requirements for review. */
export function applyCorporateResolutionNameReview(manifest:ReviewConfigManifest):ReviewConfigManifest {
 if(manifest.guaranteeTypes.length!==1||manifest.guaranteeTypes[0]!=='corporate_guarantee')throw new Error('corporate_configuration_required');
 return applyGuaranteeRoleEvidence(structuredClone(manifest),{roleEvidenceVersion:'source-role-v2'});
}
export const CORPORATE_FACT_OPTIONS:Record<string,Array<{value:string;label:string}>>={
 cgt_required:[{value:'yes',label:'需要'},{value:'no',label:'不需要'}],
 cgt_legal_route:[{value:'rm',label:'环球客户经理证明（已确认符合简化流程）'},{value:'opinion',label:'法律意见书'},{value:'waiver',label:'风险管理部法律意见豁免批准'}],
 cgt_limited:[{value:'limited',label:'有限额责任担保'},{value:'unlimited',label:'无限额责任担保'}],
 cgt_resolution_kind:[{value:'board',label:'董事会决议'},{value:'shareholders',label:'股东会决议'}],
 cgt_witness_signed:[{value:'yes',label:'已见签署'},{value:'no',label:'无签署'}],
 cgt_rm_option:[{value:'a',label:'仅选 a'},{value:'b',label:'仅选 b'},{value:'both',label:'同时选 a 和 b'},{value:'none',label:'均未选择'}],
 cgt_translation_required:[{value:'yes',label:'需要中文版本'},{value:'no',label:'无需中文版本'}],
};
const objectScope={kind:'guarantee',role:'corporate_guarantee'} as const;
const groups={guarantee:['公司保证书','Corporate Guarantee','Guarantee'],resolution:['董事会／股东会决议','Board Resolution','Shareholder Resolution'],rm:['环球客户经理证明','RM certification','Cross-border guarantees'],annual:['周年申报表','Annual Return','NAR1'],change:['董事及秘书变更通知','ND2A','Notice of Change of Company Secretary and Director'],incorporation:['公司注册证明书','Certificate of Incorporation'],articles:['公司章程及修正案','Articles of Association','Memorandum'],legal:['法律意见书','Legal Opinion'],facility:['授信函','Facility Offer Letter'],identity:['身份证明及地址证明','Identity Document','Passport'],lawyer_confirmation:['律师意见／邮件确认','Lawyer confirmation'],waiver:['法律意见豁免批准','Legal opinion waiver'],translation:['中文版本／翻译','Chinese Translation']} as const;
type Group=keyof typeof groups;
const taxonomy=(group:Group)=>`cgt_${group}`;
const recipe=(cloud:boolean):ReviewFieldDefinition['recipe']=>{const r=REVIEW_EXTRACTION_RECIPES.find(r=>r.version===(cloud?'azure-grounded-fields-v2':'p3-manual-evidence-v1'))!;return {version:r.version,model:r.model,promptSha256:r.promptSha256,mode:cloud?'cloud_grounded_extract':'manual'};};
const privacy='仅提取本文件可见内容，保留原文位置、文书及主体归属。不可用其他文件、样本答案补填；遮挡、空白、不可辨识分别记录。不把姓名文字当作已签署，不判断笔迹或签名真伪。';
const fieldSource=(row:number)=>`cgt_field_source_${row}`;
const ruleSource=(row:number)=>`cgt_rule_source_${row}`;
const fact=(value:string|boolean|null,state:'present'|'missing'='present')=>({value,state,evidenceIds:[]});
const dates=new Set([6,19,33,48,55,59]);
const signatureRows=new Set([15,20,30,31]);
const parties=new Set([4,7,9,14,16,21,24,26,27,29,32,34,35,37,42,46,50,53,54,58,61,63]);
const companyNames:Record<number,Partial<ReviewFieldDefinition>>={
 7:{aliases:['客户名称','借款人名称','Customer Name','Name of Customer','Borrower Name','Name (in Block Letters)'],partyNameSection:{headings:['Details of Customer','客户资料','借款人资料','客户名称','Customer Name','Name of Customer','Borrower Name'],otherHeadings:['Details of Guarantor','担保人资料','Name of Process Agent','送达代理人']}},
 9:{aliases:['担保人名称','Guarantor Name','Name of Guarantor','Name (in Block Letters)'],partyNameSection:{headings:['Details of Guarantor','担保人资料','担保人名称','Guarantor Name','Name of Guarantor'],otherHeadings:['Details of Customer','客户资料','借款人资料','Name of Process Agent','送达代理人']}},
 14:{aliases:['担保人名称','Name of Guarantor','Guarantor Name']},
 24:{aliases:['担保人名称','Guarantor','Name of Guarantor']},
 27:{aliases:['客户名称','借款人名称','Customer Name','Name of Customer','Borrower Name']},
 ...Object.fromEntries([42,50,61,63].map(row=>[row,{aliases:['公司名称','公司名稱','Company Name','Name of Company','英文名称','英文名稱','中文名称','中文名稱','English Name','Chinese Name']}]))
};
const ruleField:Record<number,number>={4:4,5:13,6:5,7:6,8:7,9:8,10:9,11:10,12:11,13:12,14:14,15:15,16:16,17:17,18:18,19:19,20:20,21:21,22:22,23:23,27:24,28:25,29:26,30:27,31:28,32:29,33:30,34:31,42:32,43:33,44:34,45:35,46:36,47:37,48:38,49:36,52:41,53:42,54:43,55:44,59:49,60:50,61:51,62:56,65:60,66:61,67:62,70:63,71:64,72:65};

/** Bank-origin requirements are a synthetic-scope candidate until independently approved.
 * Keep the default historical definitions stable; section semantics require an
 * explicit version when preparing a new configuration. */
export function createCorporateGuaranteeManifest(releaseId:string,options:GuaranteeExtractionOptions & {corporateSectionVersion?:'nd2a-sections-v1'|'source-fields-v2';corporateArticlesVersion?:'articles-fields-v1'}={}):ReviewConfigManifest {
 // Preserve the shared section-version output; guarantee/articles extensions use their own opt-in.
 const bankAmount=options.corporateGuaranteeVersion==='bank-amount-v1';
 const extendedSourceFields=options.corporateExtractionVersion==='source-fields-v2';
 const sourceFields=extendedSourceFields||options.corporateSectionVersion==='source-fields-v2';
 const sectionSemantics=options.corporateSectionVersion==='source-fields-v2'||options.corporateSectionVersion==='nd2a-sections-v1';
 const m:ReviewConfigManifest={schemaVersion:'review-config.v1',releaseId,label:'公司担保配置',scope:'synthetic',scenario:'overseas_loan',guaranteeTypes:['corporate_guarantee'],bankApprovalRef:null,
  sources:REVIEW_BANK_SOURCE_REFERENCES.map(s=>({id:s.id,reference:s.registerId,sha256:s.sha256,guaranteeType:s.guaranteeType,disposition:'manual',reason:'来源登记；本配置只执行下列公司担保逐行映射。',approvalRef:null})),taxonomy:[],materials:[],fields:[],rules:[],parameters:{},compatibility:{documentSchema:'p2.v2',factsSchema:'review-facts.v2',executorVersion:'p3-deterministic-v3'}};
 const source=(id:string,reference:string,sha256=CORPORATE_WORKBOOK_SHA256,reason='银行要求映射，供测试材料验收；尚未取得正式发布批准。')=>m.sources.push({id,reference,sha256,guaranteeType:'corporate_guarantee',disposition:'candidate',reason,approvalRef:null});
 source('cgt_materials','SRC-CGT/材料清单!C4:F11');
 source('cgt_translation','SRC-CGT/规则校验!B75');
 source('cgt_checklist','Legal Opinion Checklist (Oct 2026)，正文、意见类型矩阵及脚注',CORPORATE_CHECKLIST_SHA256);
 // This is a decision record, not a forged bank approval. Original workbook wording remains in the data file.
 source('cgt_confirmed_execution','用户确认：公司担保对话，2026-10-20；见证人必须签署、实际签署人数、香港董事会例外；签署只检查有无、信息和授权组合，不比较笔迹。',CORPORATE_WORKBOOK_SHA256,'用户补充的执行口径；银行文件原文另行保留，正式配置仍待独立确认。');
 for(const f of CORPORATE_FIELDS)source(fieldSource(f.row),`SRC-CGT/提取信息!C${f.row}:E${f.row}`);
 for(const r of CORPORATE_RULE_ROWS)source(ruleSource(r.row),`SRC-CGT/规则校验!B${r.row}:F${r.row}`);
 for(const [group,values] of Object.entries(groups))m.taxonomy.push({id:taxonomy(group as Group),label:values[0],keywords:[...values],sourceIds:[group==='legal'?'cgt_checklist':'cgt_materials']});
 const addField=(id:string,label:string,group:Group,definition:string,options:Partial<ReviewFieldDefinition>={})=>m.fields.push({id,label,type:'text',objectKind:'guarantee',objectRole:objectScope.role,aliases:[label],taxonomyIds:[taxonomy(group)],valueKind:'text',valueMultiplicity:'clauses',unit:null,currency:null,requiredDetection:true,requiredValue:false,sourceIds:['cgt_materials'],semanticDefinition:definition+' '+privacy,recipe:recipe(true),...options});
 for(const f of CORPORATE_FIELDS){
  if(sectionSemantics&&isCorporateSectionHeading(f.id))continue;
  const date=dates.has(f.row),signature=signatureRows.has(f.row),party=parties.has(f.row);
  addField(f.id,f.label,f.group,`${groups[f.group][0]}中的${f.meaning||f.label}。${f.requirement}。${f.row===65?'提取与担保权限、限制、所需决议及修正内容有关的条款，记录检索覆盖缺口；不可将节选当作全文已经审阅。':f.row===31?'记录每名被授权人是否留有签字样式及缺失者；不比对笔迹。':f.row===23?'此处专指见证人的身份证明，不混入担保签字人。':''}`,{type:date?'date':'text',valueKind:date?'date':party?'party_name':'text',...(party?{partyKinds:['organization','person'] as Array<'person'|'organization'>}:{}),valueMultiplicity:date?'single':party?'entities':'clauses',requireLabel:party,requiredValue:f.requirement==='必需',sourceIds:[fieldSource(f.row)],recipe:recipe(!signature),requiredDetection:!signature});
  if(options.corporateArticlesVersion==='articles-fields-v1'&&corporateArticlesDefinitions[f.id])Object.assign(m.fields.at(-1)!,corporateArticlesDefinitions[f.id],{semanticDefinition:corporateArticlesDefinitions[f.id]!.semanticDefinition+' '+privacy});
  if(companyNames[f.row])Object.assign(m.fields.at(-1)!,companyNames[f.row],{partyKinds:f.row===7||f.row===27?['organization','person']:['organization']});
  if((extendedSourceFields||bankAmount)&&f.row===12)Object.assign(m.fields.at(-1)!,bankAmount?corporateGuaranteeAmountField:corporateGuaranteeLiabilityField);
  if(sourceFields){
  if(extendedSourceFields&&corporateArticlesDefinitions[f.id])Object.assign(m.fields.at(-1)!,corporateArticlesDefinitions[f.id],{semanticDefinition:corporateArticlesDefinitions[f.id]!.semanticDefinition+' '+privacy});
  if(f.row===60)Object.assign(m.fields.at(-1)!,{valueMultiplicity:'single',aliases:['编号','編號','No.','BRN / UBI','Company Number','Registration Number'],semanticDefinition:'提取证书上实际印出的公司注册编号或商业登记号码，保留号码标签及原文位置。No.、BRN / UBI 是标签，不是号码值；标签后没有可读号码时保持未提取，不用法规章节号或日期代替。 '+privacy});
  if(f.row===61)Object.assign(m.fields.at(-1)!,{aliases:[...m.fields.at(-1)!.aliases,'I hereby certify that','本人謹此證明','本人谨此证明'],requireLabel:false,semanticDefinition:'提取证书认证成立的公司名称，包括原文印出的英文名和中文名；I hereby certify that／本人謹此證明之后、is this day incorporated／於本日成立等成立声明之前的名称即为被认证公司，不要求另有 Company Name 标签。分别保留两种名称及其认证句上下文和原文位置，不翻译、猜测或用公司注册处、签发人名称代替。 '+privacy});
  if(f.row===62)Object.assign(m.fields.at(-1)!,{semanticDefinition:'提取成立声明明确写出的公司注册国家／地区，例如 incorporated in Hong Kong 中的 Hong Kong 或在香港成立中的香港。保留原文国家／地区名称，不转换为 ISO 代码，不把公司名称中的地名、注册办事处地址、签发地点或法规名称单独当作注册地。 '+privacy});
  if(f.row===41)Object.assign(m.fields.at(-1)!,{valueMultiplicity:'single',aliases:['公司编号','公司編號','Company Number','商業登記號碼','商业登记号码','Business Registration Number'],semanticDefinition:'提取本公司的注册号或商业登记号码，保留原号码标签；不得借用董事、秘书或提交人的号码。 '+m.fields.at(-1)!.semanticDefinition});
  if(f.row===43)Object.assign(m.fields.at(-1)!,{valueKind:'address',semanticDefinition:'仅提取注册办事处地址栏的地址内容，分段保留室楼座、大厦、街道、区和地区的原文位置，不把栏目标签拼入地址，不借用提交人或董事的通讯地址。 '+m.fields.at(-1)!.semanticDefinition});
  if(f.row===44)Object.assign(m.fields.at(-1)!,{valueKind:'party_name',valueMultiplicity:'entities',partyKinds:['organization','person'],requireLabel:true,aliases:['董事','Directors','Director','Name in Chinese','Name in English'],semanticDefinition:'按董事栏目和董事续页逐条提取名单，关联同一记录内的中文名、英文姓氏和名字，并保留已勾选身份；排除N/A、不适用、无董事说明、前用姓名、别名、秘书、成员与提交人。不得把重复识别结果或中英文名当成不同董事。 '+m.fields.at(-1)!.semanticDefinition});
  if(f.row===44)m.fields.at(-1)!.label='董事清单';
  if(f.row===25)Object.assign(m.fields.at(-1)!,{label:'会议日期',aliases:['会议日期','Meeting date','Date'],semanticDefinition:'提取本次会议举行的日期；原文明示时间时可附在日期后，未列时间不构成缺项。不得混入会议地点、文件签署日、签字样本日期或其他会议日期。 '+privacy});
  if([45,46,47].includes(f.row))Object.assign(m.fields.at(-1)!,{valueMultiplicity:'entities',semanticDefinition:'逐位董事提取，并关联同一董事栏目或续页记录；不得借用秘书、成员、签署人、前用姓名或其他董事的资料。身份只取已勾选的董事／候补董事职位；姓名保留中文及英文姓氏、名字；身份证号码仅取该记录身份证栏，明确部分号码及遮挡，不补全、不用护照或公司号码代替。 '+m.fields.at(-1)!.semanticDefinition});
  if(f.row===48)Object.assign(m.fields.at(-1)!,{label:'周年申报表出具日期（签署日）',aliases:['日期 Date','Date','日期'],semanticDefinition:'提取本份周年申报表末尾签署栏的日期，作为出具日期；属于整份文件，不属于任何一位董事。不得用首页或续页的申报结算日期（Date to which this Return is Made Up）、委任日期、模板版本日期代替。保留日月年的原文和定位；没有签署栏日期则保持未提取。 '+privacy});
  }
  const section=corporateFieldSection(f.id);
  if(sectionSemantics&&section){
   const field=m.fields.at(-1)!;
   field.semanticDefinition=`仅提取「${section.label}」栏目中该人员对应的${f.label}；不得混入另一停任／委任栏目、公司名称、提交人或不适用的法人资料。身份读取已勾选的职位，不能用变更说明代替。英文姓名保留原文姓氏及名字的顺序和来源，不自行倒置。日期须对应同一人的停任／委任事项。 ${field.semanticDefinition}`;
  }
  if(sourceFields&&f.row===25)addField('cgt_meeting_place','会议地点','resolution','提取本次会议举行的地点或地址，保留完整原文；不混入会议日期、注册办事处或其他会议的地点。',{aliases:['会议地点','Meeting place','Venue','Place'],requiredValue:true,sourceIds:[fieldSource(25)]});
 }
 if(extendedSourceFields||options.corporateArticlesVersion==='articles-fields-v1'){
 const resolutionDefinition=corporateArticlesDefinitions.cgt_articles_required_resolution!;
 addField('cgt_articles_required_resolution',resolutionDefinition.label!,'articles',resolutionDefinition.semanticDefinition!,{aliases:resolutionDefinition.aliases,sourceIds:[fieldSource(65),ruleSource(72)]});
 }
 const helper=(id:string,label:string,type:ReviewFieldDefinition['type'],group:Group,definition:string,sourceIds:string[]=['cgt_materials'],unit:string|null=null,currency:string|null=null)=>addField(id,label,group,definition+' 须按当前这一家公司担保、有效文件及对应原文证据确认；其他主体资料不能代替。',{type,valueKind:type==='text'?'text':type,valueMultiplicity:'single',requiredDetection:false,sourceIds,unit,currency,recipe:recipe(false)});
 helper('review_business_date','审核基准日','date','guarantee','系统使用本次审核快照日期。');
 helper('cgt_required','本案需要公司担保','text','guarantee','按风控审批确认 yes 或 no；未知不得推断为不需要。');
 helper('cgt_legal_route','法律配套要求','text','legal','确认 rm（合资格司法管辖区简化流程）、opinion（法律意见）或 waiver（风险管理部法律意见豁免批准）。司法管辖区资格清单及批准依据未确认时保持未知。',[ruleSource(36)]);
 helper('cgt_limited','担保责任是否有限额','text','guarantee','确认 limited 或 unlimited；金额空白不等于无限额。',[ruleSource(13)]);
 if(bankAmount)Object.assign(m.fields.at(-1)!,corporateGuaranteeLimitField,{recipe:recipe(true)});
 if(!extendedSourceFields&&!bankAmount)helper('cgt_amount','担保金额（已确认）','amount','guarantee','单一公司担保明确的金额。',[ruleSource(13)],'currency');
 if(!sourceFields)helper('cgt_required_amount','本次要求的担保金额','amount','facility','用户或审批明确要求的金额；未提供时保持未知，不能用合同金额自身代替。',[ruleSource(13)],'currency');
 if(!extendedSourceFields&&!bankAmount)helper('cgt_currency','担保币种','currency','guarantee','单一担保金额币种。',[ruleSource(13)]);
 if(!sourceFields)helper('cgt_required_currency','要求金额币种','currency','facility','要求金额的币种。',[ruleSource(13)]);
 if(extendedSourceFields||bankAmount)helper('cgt_user_required_amount','用户要求的担保金额','amount','guarantee','由用户提供或明确确认本次要求金额，并记录对应依据；授信函提取值只可作为待确认来源，不自动代表用户要求。未提供时提醒用户判断保证金额是否可接受。',[ruleSource(13)],'currency');
 if(extendedSourceFields||bankAmount)helper('cgt_user_required_currency','用户要求的担保币种','currency','guarantee','与用户确认的要求金额对应的明确币种；不换汇，不从授信函或保证书自动代入。',[ruleSource(13)]);
 helper('cgt_authorization_date','授权文件签署日','date','resolution','当前有效授权文件签署日，不以会议日期自动替代。',[ruleSource(7)]);
 helper('cgt_authorization_reference_date','对应决议文件日期','date','resolution','对应决议原文明示日期，与签署日分别确认。',[ruleSource(19)]);
 helper('cgt_meeting_date',sourceFields?'会议日期（已确认）':'会议日期','date','resolution','会议时间中的日期。',[ruleSource(28)]);
 helper('cgt_resolution_signer_count','决议实际签署人数','amount','resolution','逐人确认实际签署者，去重计数；出席或打印姓名不算签署。',[ruleSource(33),'cgt_confirmed_execution'],'persons',null);
 helper('cgt_resolution_minimum','决议最低签署人数','amount','articles','由已确认的注册地、决议类型和章程人数派生；香港董事会决议至少一名董事，其余按章程最低出席人数。',[ruleSource(33),'cgt_confirmed_execution'],'persons',null);
 helper('cgt_jurisdiction','担保人注册地代码','text','incorporation','确认 ISO 国家／地区代码（香港为 HK）。',[ruleSource(33)]);
 helper('cgt_resolution_kind','决议类型','text','resolution','确认 board（董事会）或 shareholders（股东会）。香港一名董事例外只适用于 board。',[ruleSource(33)]);
 helper('cgt_charter_minimum','章程最低出席人数','amount','articles','确认当前有效章程规定的人数及条款；不得使用实际出席人数或旧修正条款。',[ruleSource(33),ruleSource(71)],'persons',null);
 helper('cgt_witness_signed','见证人签署已存在','text','guarantee','确认 yes 或 no；仅姓名、签署栏标题或无法识别时不能确认 yes。',[ruleSource(20),'cgt_confirmed_execution']);
 helper('cgt_yes','检查值：是','text','guarantee','系统固定比较值 yes，不接受材料或人工覆盖。');
 helper('cgt_rm_option','环球客户经理证明选项','text','rm','确认 a、b、none 或 both；必须恰选一项。',[ruleSource(46)]);
 helper('cgt_rm_valid_option','选项是否恰选一项','text','rm','系统按已确认的 a/b/none/both 派生 yes 或 no。',[ruleSource(46)]);
 helper('cgt_translation_required','是否需要中文版本','text','translation','逐份确认外文材料的中文版本要求；yes/no，不能因没有识别出语言就认为不需要。',['cgt_translation']);
 if(extendedSourceFields||bankAmount)m.fields.push(...corporateGuaranteeValueFields(recipe(true),bankAmount));
 if(sourceFields)m.fields.push(...corporateFacilityFields(recipe(true)));
 for(const [id,label,group,definition] of [
  ['cgt_facility_parties','授信函主体及担保安排','facility','逐一提取借款人、贷款人及由哪家公司出具何种担保，保留多主体对应关系。'],
  ['cgt_facility_reference','授信函名称与出具日','facility','保留文件标题、编号与出具日，不能用其他授信材料代替授信函。'],
  ['cgt_identity_details','签字人／见证人身份证明','identity','保留证件类型、号码、姓名、地址及证件所属人，禁止混淆角色。'],
  ['cgt_legal_firm','法律意见出具律所与执业范围','legal','提取律所全称及意见所涉及的管辖区和审查范围；批准资格必须另有名单依据。'],
  ['cgt_legal_references','法律意见引用主体及文书','legal','提取银行、客户、担保人、审阅文件的名称、日期、版本、适用法律。'],
  ['cgt_legal_conditions','法律意见不利内容、前提与后续事项','legal','逐条提取可能不利于银行、尚待签署完成、生效条件及后续事项。'],
  ['cgt_rm_clauses','环球客户经理证明条款','rm','保留完整条款及修改之处，用于与获准标准文本比较。'],
 ] as const)if(!sourceFields||!['cgt_facility_parties','cgt_facility_reference'].includes(id))addField(id,label,group,definition,{sourceIds:[group==='legal'?'cgt_checklist':'cgt_materials']});
 const condition=(fieldId:string,equals:string|boolean)=>({fieldId,equals});
 const material=(group:Group,required:boolean,applicability?:ReviewRule['applicability'])=>m.materials.push({id:taxonomy(group),label:groups[group][0],taxonomyId:taxonomy(group),required,objectScope,sourceIds:[group==='waiver'?ruleSource(36):group==='lawyer_confirmation'?ruleSource(46):group==='translation'?'cgt_translation':group==='identity'?ruleSource(16):group==='facility'?ruleSource(10):'cgt_materials'],...(applicability?{applicability}:{})});
 for(const group of ['guarantee','resolution','articles','incorporation'] as const)material(group,true,condition('cgt_required','yes'));
 material('rm',true,condition('cgt_legal_route','rm'));material('legal',true,condition('cgt_legal_route','opinion'));material('waiver',true,condition('cgt_legal_route','waiver'));
 material('lawyer_confirmation',true,condition('cgt_rm_option','b'));material('translation',true,condition('cgt_translation_required','yes'));
 for(const group of ['annual','change','facility','identity'] as const)material(group,false);
 const addRule=(id:string,label:string,operator:ReviewRule['operator'],inputs:string[],sourceIds:string[],description:string,values:(string|boolean)[][],extra:Partial<ReviewRule>={})=>{
  const r:ReviewRule={id,label,operator,inputs,objectScope,sourceIds,description,sourceDirectionConfirmed:true,requiredParameters:[],...extra,tests:[]};
  r.tests=(['normal','abnormal','boundary','missing_input'] as const).map((kind,index)=>({id:kind,kind,synthetic:true,facts:Object.fromEntries(inputs.map((id,i)=>[id,index===3&&i===0?fact(null,'missing'):fact(values[Math.min(index,2)]?.[i]??values[0]![i]!)])),expected:operator==='manual_review'?'blocked':kind==='abnormal'?'fail':kind==='missing_input'?operator==='present'?'fail':'blocked':'pass'}));
  for(const t of r.tests)for(const id of inputs)if(m.fields.find(f=>f.id===id)?.type==='date'&&t.facts[id]?.state==='present'&&operator==='manual_review')t.facts[id]=fact('2026-10-20');
  for(const t of r.tests)if(r.applicability)t.facts[r.applicability.fieldId]=fact(r.applicability.equals);
  m.rules.push(r);return r;
 };
 for(const item of m.materials.filter(m=>m.required))addRule(`${item.id}_required`,`${item.label}：材料要求`,'present',[`material:${item.id}`],item.sourceIds,'需确认材料属于当前公司担保；适用条件未知时等待确认。',[[true],[false],[true]],{applicability:item.applicability});
 for(const f of CORPORATE_FIELDS){
  if(f.row===65||signatureRows.has(f.row)||(sectionSemantics&&isCorporateSectionHeading(f.id)))continue;
  const date=dates.has(f.row),r=addRule(`${f.id}_required`,`${groups[f.group][0]}：${f.label}完整性`,'present',[f.id],[fieldSource(f.row)],`${f.requirement}；原文未见与识别不确定分别处理。`,[[date?'2026-10-20':'已确认值'],[''],[date?'2026-10-20':'已确认值']],{applicability:f.row===12?condition('cgt_limited','limited'):condition(`material:${taxonomy(f.group)}`,true)});
  if(date)r.tests[1]!.facts[f.id]=fact(null,'missing');
 }
 // Preserve all 54 bank rule rows as executable review tasks. Automated subchecks
 // below do not claim that nuanced identity, legal or authorisation checks passed.
 for(const row of CORPORATE_RULE_ROWS){
  const f=CORPORATE_FIELDS.find(f=>f.row===(sectionSemantics&&row.row===61?54:sectionSemantics&&row.row===62?58:ruleField[row.row]));
  const input=f?.id??(row.row===36?'cgt_legal_route':row.row===37?'cgt_legal_firm':row.row===38?'cgt_legal_references':'cgt_legal_conditions');
  const description=row.row===15?'核对实际签署是否存在、签字人信息和授权组合是否符合；授权要求盖章时核对印章存在。不进行笔迹比对或签名真伪判断。':row.row===20?'见证人必须签署，全名、办事处及身份证明须完整，缺项请求补充；核对证明归属与有效性。':row.row===33?'核对实际签署者在有效成员名单内；普通决议实际签署人数不得少于章程最低出席人数；香港董事会决议可接受至少一名董事签署，股东会不适用该例外。':`${row.requirement} ${row.notice}`;
  const group=f?.group??'legal';
  addRule(`cgt_bank_${row.row}`,`${groups[group][0]}：${row.label.replace(/\n/g,' ')}`,'manual_review',[input],[ruleSource(row.row),...([15,20,33].includes(row.row)?['cgt_confirmed_execution']:[])],description,[['待核对']],{manualReason:[36,37,49].includes(row.row)?'reference_list_required':'manual_review_required',...(row.row===36?{}:{applicability:condition(`material:${taxonomy(group)}`,true)})});
 }
 if(extendedSourceFields||options.corporateArticlesVersion==='articles-fields-v1')addRule('cgt_articles_resolution_review','公司章程：提供担保所需决议','manual_review',['cgt_articles_required_resolution'],[ruleSource(72),fieldSource(65)],'核对章程规定的担保决议机关、适用条件、例外及相关修正；没有明确依据时保持待核对。',[['待核对']],{manualReason:'manual_review_required',applicability:condition('material:cgt_articles',true)});
 addRule('cgt_signing_authorized','保证书签署不早于授权签署','date_order',['cgt_authorization_date','cgt_field_6'],[ruleSource(7)],'比较同一公司担保对应的有效授权文件签署日。',[['2026-10-19','2026-10-20'],['2026-10-21','2026-10-20'],['2026-10-20','2026-10-20']]);
 for(const [id,label,row] of [['cgt_field_6','保证书签署日期',7],['cgt_meeting_date','会议日期',28]] as const)addRule(`${id}_not_future`,`${label}不晚于审核日`,'date_order',[id,'review_business_date'],[ruleSource(row)],'采用审核快照日期。',[['2026-10-19','2026-10-20'],['2026-10-21','2026-10-20'],['2026-10-20','2026-10-20']]);
 for(const [id,a,b,label,row] of [['cgt_authorization_reference','cgt_field_19','cgt_authorization_reference_date','保证书引用的授权日期一致',19],['cgt_rm_date','cgt_field_33','cgt_field_6','环球客户经理证明日期与保证书签署日一致',43]] as const)addRule(id,label,'equal',[a,b],[ruleSource(row)],'缺少对应文件、日期不确定或主体未对应时待核对。',[['2026-10-20','2026-10-20'],['2026-10-19','2026-10-20'],['2026-10-20','2026-10-20']],id==='cgt_rm_date'?{applicability:condition('material:cgt_rm',true)}:{});
 // Existing default and section-version manifests are frozen. Opt in only
 // through the independent extraction/amount versions used by new configurations.
 if(extendedSourceFields||bankAmount)addRule('cgt_amount_minimum','有限额担保金额满足用户要求','minimum_ratio',['cgt_amount','cgt_user_required_amount','cgt_currency','cgt_user_required_currency'],[ruleSource(13)],'仅与用户提供或明确确认的要求金额同币种比较；未提供时提醒用户判断是否可接受，不自动采用授信函金额。无限额担保不据此报缺金额。',[['120','100','CNY','CNY'],['99','100','CNY','CNY'],['100','100','CNY','CNY']],{factor:'1',applicability:condition('cgt_limited','limited')});
 else addRule('cgt_amount_minimum','有限额担保金额满足要求','minimum_ratio',['cgt_amount','cgt_required_amount','cgt_currency','cgt_required_currency'],[ruleSource(13)],'同币种比较，未知要求或币种不同时待核对；无限额担保不据此报缺金额。',[['120','100','CNY','CNY'],['99','100','CNY','CNY'],['100','100','CNY','CNY']],{factor:'1',applicability:condition('cgt_limited','limited')});
 addRule('cgt_resolution_signatures','决议实际签署人数满足要求','minimum',['cgt_resolution_signer_count','cgt_resolution_minimum'],[ruleSource(33),'cgt_confirmed_execution'],'香港董事会至少一名董事；其他决议按有效章程最低出席人数检查实际签署人数，成员资格另核对。',[['2','1'],['0','1'],['1','1']]);
 for(const [id,input,label,row] of [['cgt_witness_signature','cgt_witness_signed','见证人必须有签署',20],['cgt_rm_option_single','cgt_rm_valid_option','环球客户经理证明恰选 a 或 b',46]] as const)addRule(id,label,'equal',[input,'cgt_yes'],[ruleSource(row),'cgt_confirmed_execution'],'以已确认原文为据，未确认时不会自动通过。',[['yes','yes'],['no','yes'],['yes','yes']],id==='cgt_rm_option_single'?{applicability:condition('material:cgt_rm',true)}:{});
 const checklist=[
  ['收件人','包括汇丰中国或相关分行。'],['披露权限','逐项核对四类披露对象和场景，保留非依赖限制。'],['审阅文书清单','所有相关文件列明，并与实际采用材料、日期和版本对应。'],['假设','仅限律所无法掌握的事实事项，不接受法律假设、所有陈述均正确或律师职责内事项的笼统假设。'],['保留意见','限于适用法律及司法实践，不得削弱意见可靠性。'],['责任限制','检查是否存在责任限制。'],
  ['存续与注册','意见项 1。'],['清盘／接管查询','意见项 2。'],['公司权能','意见项 3。'],['公司授权','意见项 4。'],['适当签署','意见项 5；不比对签名真伪。'],['不违反注册地法律','意见项 6(i)。'],['不违反章程','意见项 6(ii)。'],['有效及可执行义务','意见项 7。'],['授权与同意','意见项 8。'],['印花税及登记税','意见项 9；保留明确列明的例外。'],['备案与登记','意见项 10；保留需完成的登记。'],['有效担保权益','意见项 11，仅涉及担保物权文件时适用。'],['法律与管辖选择','意见项 12；主体与管辖法律分属不同司法区时按脚注核对。'],['外国判决承认执行','意见项 13。'],['银行不被视为在当地经营','意见项 14，境外法律意见且可获得时。'],['银行无需经营许可','意见项 15，境外法律意见且可获得时。'],['无司法豁免','意见项 16，境外义务主体且可获得时。'],
 ] as const;
 for(const [index,[label,meaning]] of checklist.entries()){
  const id=`cgt_legal_checklist_${index+1}`;
  addField(id,`法律意见：${label}`,'legal',meaning+' 按意见类型选择适用项：矩阵空格为必需，X 为不要求，Required if possible 为尽可能取得；保留适用条件和原文，不把 X 当作已满足。',{sourceIds:['cgt_checklist']});
  addRule(`${id}_review`,label,'manual_review',[id],['cgt_checklist'],meaning+' 根据容量／管辖法律／综合意见类型及原清单脚注核对；未确认适用性不自动通过。',[['待核对']],{manualReason:'manual_review_required',applicability:condition('material:cgt_legal',true)});
 }
 addRule('cgt_translation_review','外文材料中文版本逐份核对','manual_review',['cgt_translation_required'],['cgt_translation'],'全部非中文材料需有对应中文版本；核对对应版本与完整性，机器翻译不等于人工认可。',[['待核对']],{manualReason:'manual_review_required'});
 m.documentClassification='content-first-v1';
 const nativeRecipe=REVIEW_EXTRACTION_RECIPES.find(r=>r.version==='azure-grounded-docx-v1')!;
 m.docxExtraction={version:nativeRecipe.version,model:nativeRecipe.model,promptSha256:nativeRecipe.promptSha256,mode:'cloud_grounded_extract'};
 const result=applyGuaranteeRoleEvidence(m,options);
 return ReviewConfigManifestSchema.parse(options.corporateRmVersion==='rm-source-v2'?applyCorporateRmSourceReview(result):options.corporateRmVersion==='rm-parties-v1'?applyCorporateRmPartyReview(result):result);
}

/** Populate the existing corporate draft; do not rename it or inherit approvals. */
export function applyCorporateGuaranteeRequirements(base:ReviewConfigManifest):ReviewConfigManifest {
 if(base.guaranteeTypes.length!==1||base.guaranteeTypes[0]!=='corporate_guarantee')throw new Error('corporate_configuration_required');
 if(base.scope!=='synthetic')throw new Error('corporate_candidate_requires_synthetic_scope');
 return {...createCorporateGuaranteeManifest(base.releaseId,{corporateSectionVersion:'nd2a-sections-v1',corporateExtractionVersion:'source-fields-v2',corporateGuaranteeVersion:'bank-amount-v1',corporateRmVersion:'rm-parties-v1'}),label:base.label};
}

/** Explicit draft upgrade, scoped to the bank's articles requirements. Historical
 * manifests, unrelated extraction recipes and existing approvals stay untouched. */
export function applyCorporateArticlesReview(base:ReviewConfigManifest):ReviewConfigManifest {
 if(!base.guaranteeTypes.includes('corporate_guarantee'))throw new Error('corporate_configuration_required');
 if(base.scope!=='synthetic')throw new Error('corporate_candidate_requires_synthetic_scope');
 const prior=base.fields.find(field=>field.id==='cgt_field_65');
 if(!prior||!base.fields.some(field=>field.id==='cgt_field_64')||!['cgt_field_source_65','cgt_rule_source_72'].every(id=>base.sources.some(source=>source.id===id)))throw new Error('corporate_articles_sources_required');
 const next=structuredClone(base),candidate=createCorporateGuaranteeManifest(base.releaseId,{corporateArticlesVersion:'articles-fields-v1'});
 next.fields=next.fields.map(field=>corporateArticlesDefinitions[field.id]?{...field,...corporateArticlesDefinitions[field.id],semanticDefinition:candidate.fields.find(entry=>entry.id===field.id)!.semanticDefinition,valueMultiplicity:'clauses' as const}:field);
 if(!next.fields.some(field=>field.id==='cgt_articles_required_resolution')){
  const field=candidate.fields.find(field=>field.id==='cgt_articles_required_resolution')!;
  next.fields.splice(next.fields.findIndex(field=>field.id==='cgt_field_65')+1,0,{...field,recipe:structuredClone(prior.recipe)});
 }
 if(!next.rules.some(rule=>rule.id==='cgt_articles_resolution_review'))next.rules.push(candidate.rules.find(rule=>rule.id==='cgt_articles_resolution_review')!);
 return ReviewConfigManifestSchema.parse(next);
}
