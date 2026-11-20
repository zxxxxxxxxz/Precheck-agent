import {createSyntheticReviewConfigManifest, REVIEW_EXTRACTION_RECIPES, ReviewConfigManifestSchema, type ReviewConfigManifest, type ReviewFieldDefinition, type ReviewRule} from './review-config.js';
import {createInsuranceExtractionCandidate} from './insurance-fields.js';
import {MORTGAGE_REQUIREMENTS} from './mortgage-requirements-data.js';
export {MORTGAGE_REQUIREMENTS} from './mortgage-requirements-data.js';

export const MORTGAGE_WORKBOOK_SHA256='a0f8cb9b3216f915710db06d098d6a695b5391bdc04566d784e6317e8acb4caa';
const groups={mortgage:{label:'房地产抵押协议',taxonomy:'mortgage_contract',kind:'guarantee'},facility:{label:'授信函',taxonomy:'facility_letter',kind:'financing'},authorization:{label:'公司授权文件',taxonomy:'company_authorization',kind:'guarantee'},insurance:{label:'保单／保险合同',taxonomy:'insurance_policy',kind:'policy'},valuation:{label:'评估报告',taxonomy:'valuation_report',kind:'collateral'}} as const;
const cloud=REVIEW_EXTRACTION_RECIPES.find(r=>r.version==='azure-grounded-fields-v2')!;
const manual=REVIEW_EXTRACTION_RECIPES.find(r=>r.version==='p3-manual-evidence-v1')!;
const recipe=(automatic:boolean):ReviewFieldDefinition['recipe']=>{const r=automatic?cloud:manual;return {version:r.version,model:r.model,promptSha256:r.promptSha256,mode:automatic?'cloud_grounded_extract':'manual'};};
const sourceId=(row:number)=>`mtg_row_${row}`;
const fact=(value:string|boolean|null,state:'present'|'missing'='present')=>({value,state,evidenceIds:[]});
function rule(row:number,suffix:string,label:string,operator:ReviewRule['operator'],inputs:string[],values:string[][],extra:Partial<ReviewRule>={}):ReviewRule {
  const source=MORTGAGE_REQUIREMENTS.find(r=>r.row===row)!;
  const description=[38,52].includes(row)?'已确认业务口径：签署日期不得晚于审核日，且不得早于对应授权文件日期；缺少授权日期或关联依据时待核对。':row===57?'已确认业务口径：保险期限以至少一个日历年为宜；到期日早于审核日为过期，当天到期提醒即将到期。原文时刻、适用条件及需重新出具材料的情况由人工核对。':`银行要求：${source.rule||'提取原文'}。处理提示：${source.notice||'保留原文依据'}。`;
  return {id:`mtg_${row}_${suffix}`,label,operator,inputs,description,sourceIds:[sourceId(row)],sourceDirectionConfirmed:true,requiredParameters:[],...extra,
    tests:(['normal','abnormal','boundary','missing_input'] as const).map((kind,index)=>({id:kind,kind,synthetic:true,facts:Object.fromEntries(inputs.map((id,i)=>[id,kind==='missing_input'&&i===0?fact(null,'missing'):fact((values[index===3?0:index]??values[0])![i]!)])),expected:operator==='manual_review'?'blocked':kind==='abnormal'?'fail':kind==='missing_input'?operator==='present'?'fail':'blocked':'pass'}))};
}
const dateRows=new Set([4,21,24,38,41,52,67]);
const partyRows=new Set([6,9,10,26,27,28,43,44,45,68,70,71]);
const identifierRows=new Set([5,8,25,66]);
const englishLabels:Record<number,string[]>={4:['Issue Date','Date of Agreement'],5:['Agreement Number','Contract Number'],6:['Chargor','Mortgagor','Guarantor'],7:['Registered Office','Chargor Address'],8:['Registration No.','Passport Number','ID Number'],9:['Borrower','Obligor'],10:['Lender','Mortgagee'],11:['Lender Address'],12:['Facility Letter','Facility Agreement'],16:['Property Details','Mortgaged Property'],24:['Issue Date','Date of Facility Letter'],25:['Reference No.','Our Ref.'],26:['Borrower'],27:['Lender'],28:['Obligor','Guarantor'],41:['Meeting Date'],43:['Borrower'],44:['Lender'],45:['Guarantor','Chargor'],66:['Report Number','Report Reference'],67:['Report Date','Date of Issue'],68:['Valuer','Valuation Company'],69:['Property Valued','Subject Property'],70:['Owner','Registered Owner'],71:['Instructing Party','Client','Addressed To'],72:['Market Value'],73:['Reinstatement Value','Rebuilding Cost','Insurance Value'],74:['Net Value'],76:['Seizure','Frozen','Attachment']};
const privacy='只提取当前文件可见原文，保留页码与原文位置；不从其他文件补填。遮挡、空白、不可辨识须保留状态，不猜测。保留文种、角色、否定、条件、例外与多个对象的区别。';

/** New unpublished workbook candidate, independent of immutable older templates.
 * Existing bank publication and cloud-data-scope approvals remain mandatory. */
export function createMortgageWorkbookManifest(releaseId:string):ReviewConfigManifest {
  const m=createInsuranceExtractionCandidate(createSyntheticReviewConfigManifest(releaseId),releaseId);
  m.label='抵押融资 · 银行清单';
  m.compatibility={documentSchema:'p2.v2',factsSchema:'review-facts.v2',executorVersion:'p3-deterministic-v3'};
  m.rules=[];m.materials=[];m.parameters={};delete m.signatureRequirements;delete m.signatureTests;
  m.sources=m.sources.filter(s=>s.id!=='synthetic_mortgage');
  m.sources.push(...MORTGAGE_REQUIREMENTS.map(r=>({id:sourceId(r.row),reference:`SRC-MTG/提取信息!C${r.row}:E${r.row};规则校验!C${r.row}:F${r.row}`,sha256:MORTGAGE_WORKBOOK_SHA256,guaranteeType:'mortgage' as const,disposition:'candidate' as const,reason:'银行字段及审核要求逐行映射；自动检查只使用已确认事实，人工判断项保留待核对。',approvalRef:null})));
  m.taxonomy=m.taxonomy.map(t=>({...t,sourceIds:[sourceId(t.id==='facility_letter'?24:t.id==='mortgage_contract'?4:53)]}));
  for(const [id,label,keywords,row] of [
    ['company_authorization','公司授权文件',['董事会决议','股东会决议','董事书面决议','Board Resolution','Shareholders Resolution'],42],
    ['valuation_report','评估报告',['估值报告','评估报告','房地产估价报告','Valuation Report'],66],
    ['basic_company_documents','主体基础资料',['营业执照','注册登记证','周年申报表','Certificate of Incorporation','Annual Return'],6],
    ['company_articles','公司章程',['公司章程','Articles of Association'],42],
    ['property_certificate','不动产权证书',['不动产权证书','房屋所有权证','土地使用权证'],55],
    ['property_registration','不动产登记证明',['不动产登记证明'],16],
    ['legal_opinion','法律意见书',['法律意见书','Legal Opinion'],20],
  ] as const)m.taxonomy.push({id,label,keywords:[...keywords],sourceIds:[sourceId(row)]});
  for(const [group,value] of Object.entries(groups))m.materials.push({id:group,label:value.label,taxonomyId:value.taxonomy,required:false,sourceIds:[sourceId(group==='mortgage'?4:group==='facility'?24:group==='authorization'?42:group==='insurance'?53:66)]});
  // Materials are selected against credit approval; the workbook does not make
  // the last three name-only materials unconditional mandatory requirements.
  m.materials.push({id:'premium_invoice',label:'保费发票',taxonomyId:'invoice',required:false,sourceIds:[sourceId(65)]},{id:'premium_receipt',label:'保费支付凭证',taxonomyId:'premium_payment_receipt',required:false,sourceIds:[sourceId(65)]});
  const insurance=new Map(m.fields.filter(f=>f.id.startsWith('insurance_')).map(f=>[f.id,f]));
  m.fields=MORTGAGE_REQUIREMENTS.map(r=>{
    if(r.group==='insurance'){const field=insurance.get(r.id)!;return {...field,...(field.objectKind==='policy'?{objectRole:'insurance'}:{}),sourceIds:[sourceId(r.row)],requiredValue:r.requirement==='必需'};}
    const group=groups[r.group],party=partyRows.has(r.row),date=dateRows.has(r.row),identifier=identifierRows.has(r.row);
    const aliases=[...new Set([r.label,r.description,...r.sourceLabel.split(/[\n/]/).map(s=>s.trim()),...(englishLabels[r.row]??[]),...(r.row===42?['董事会决议','股东会决议','Board Resolution','Written Resolutions']:[]),...(r.row===76?['查封','冻结','扣押','未查封','未冻结']:[])].filter(s=>s&&s.length<=200))];
    return {id:r.id,label:r.label,type:date?'date':'text',objectKind:party?'party':group.kind,objectRole:party?r.id:r.group,aliases,
      taxonomyIds:[group.taxonomy],valueKind:party?'party_name':date?'date':identifier?'identifier':'text',valueMultiplicity:party?'entities':date||identifier?'single':'clauses',requireLabel:party||identifier,
      ...(party?{partyKinds:['organization','person'] as Array<'organization'|'person'>}:{}),unit:null,currency:null,
      semanticDefinition:`${group.label}中的${r.label}：${r.description}。${r.requirement?`银行要求：${r.requirement}。`:''}${r.row===42?'同时记录董事／股东总人数、出席人数、表决人数和决议类型。':r.row===76?'保留是否存在限制的完整语句；“未查封／无冻结”不得变成存在查封冻结。':r.row===77?'这是计算依据，保留文件明确列示的授信额度、市场价值、LTV 上限及币种，不自行计算或假定审批限额。':r.row===75?'只记录原文明示的其他价值类型及数值、币种；银行未列明具体类型，待人工确认范围。':''}${privacy}`,
      requiredDetection:true,requiredValue:r.requirement==='必需',sourceIds:[sourceId(r.row)],recipe:recipe(r.row!==77)} as ReviewFieldDefinition;
  });
  // Atomic quantities are deliberately confirmed separately from multi-asset
  // source clauses. They never silently sum limits, infer currency or select a
  // latest document by filename/date. Object links supply the selected scope.
  const helper=(id:string,label:string,type:ReviewFieldDefinition['type'],group:keyof typeof groups,row:number,description:string,unit:string|null=type==='amount'?'currency':null)=>{
    m.fields.push({id,label,type,objectKind:groups[group].kind,objectRole:group,aliases:[label],taxonomyIds:[groups[group].taxonomy],valueKind:type==='text'?'text':type,unit,currency:null,requiredDetection:false,requiredValue:false,sourceIds:[sourceId(row)],semanticDefinition:description+' 必须由审核员选择有效材料并确认单一对象、数值及原文证据；不能跨标的相加或从名称猜测关系。',recipe:recipe(false)});
  };
  helper('review_business_date','审核基准日','date','facility',24,'采用本次审核快照的业务日期，系统提供，不能由文档或人工字段覆盖。');
  helper('mtg_authorization_date','对应授权文件日期（已确认）','date','authorization',38,'对应签署权限的授权文件日期；须确认该文件与本次签署的关系，不得直接用签署日期自身代替。');
  helper('mtg_insurance_start','保险开始日（已确认）','date','insurance',57,'本次有效保险责任开始日；原文时刻与附加条件保留在保险期限字段。');
  helper('mtg_insurance_end','保险到期日（已确认）','date','insurance',57,'本次有效保险责任到期日；原文时刻与附加条件保留在保险期限字段。');
  helper('mtg_insured_asset_kind','被保险抵押物类型（已确认）','text','insurance',56,'确认 real_estate（房产）或 other_tangible（其他有形担保物），用于确定被保险物描述检查是否适用。');
  helper('mtg_authorization_capacity','授权文件主体身份（已确认）','text','authorization',45,'确认 borrower（借款人授权）或 guarantor（抵押人／担保人授权），用于确定担保授权条款是否适用。');
  for(const [id,label,group,row,description] of [
    ['mtg_facility_principal','授信本金（已确认）','facility',30,'当前选定的、包含该抵押物的最新完整版授信函本金。'],
    ['mtg_maximum_liability','最高抵押债务金额（已确认）','mortgage',19,'该抵押合同明确的最高债务金额。'],
    ['mtg_mortgage_value','抵押物协议价值（已确认）','mortgage',17,'该抵押物协议价值。'],
    ['mtg_authorized_amount','授权授信金额（已确认）','authorization',47,'对应完整授信的有效授权金额。'],
    ['mtg_insured_collateral_amount','对应抵押物保险金额（已确认）','insurance',63,'仅对应抵押给本行资产的保险金额；范围较大的保单必须列明该资产分项限额，禁止使用全部保额或相加附加险限额。'],
    ['mtg_market_value','最新市场价值（已确认）','valuation',72,'与所比较授信／抵押范围一致的最新有效评估总市场价值；多个报告须先确认完整范围。'],
    ['mtg_reinstatement_value','重置价值（已确认）','valuation',73,'对应被保险抵押物的重置价值，不能使用市场价值或净值代替。'],
  ] as const)helper(id,label,'amount',group,row,description);
  for(const [group,row] of [['facility',30],['mortgage',19],['authorization',47],['insurance',63],['valuation',72]] as const)helper(`mtg_${group}_currency`,`${groups[group].label}比较币种（已确认）`,'currency',group,row,'与比较数值同一对象的明确 ISO 币种；有不同币种或口径不能合并。');
  helper('mtg_facility_ltv_limit','授信函抵押率上限（%）','amount','facility',77,'授信函明确的抵押率上限；空缺不能当作 100%。','percent');
  helper('mtg_approval_ltv_limit','内部审批抵押率上限（%）','amount','facility',77,'内部审批文件明确的抵押率上限，附该审批原文证据。','percent');
  m.fields.push({id:'invoice_policy_reference',label:'保险发票保／批单号',type:'text',objectKind:'policy',objectRole:'premium_invoice',aliases:['保/批单号','保单号','批单号','Policy Number','Endorsement Number'],taxonomyIds:['invoice','premium_payment_receipt'],valueKind:'identifier',valueMultiplicity:'single',requireLabel:true,unit:null,currency:null,requiredDetection:true,requiredValue:false,sourceIds:[sourceId(64)],semanticDefinition:'发票明确的保／批单号，保留原文字段角色；不得用发票号、订单号、税号代替。'+privacy,recipe:recipe(true)});
  const automaticRows=new Set([4,10,24,41,44,58,59,64,70]);
  const extractionOnly=new Set([5,25,66,72,74]);
  for(const r of MORTGAGE_REQUIREMENTS){
    if(r.requirement==='必需')m.rules.push(rule(r.row,'required',`${groups[r.group].label}：${r.label}必需`,'present',[r.id],[['已确认原文值'],[''],['已确认原文值']]));
    if(!automaticRows.has(r.row)&&!extractionOnly.has(r.row)&&![38,52,67].includes(r.row))m.rules.push(rule(r.row,'review',`${groups[r.group].label}：${r.label}人工核对`,'manual_review',[r.id],[['待核对']],{manualReason:[53,68].includes(r.row)?'reference_list_required':'manual_review_required'}));
  }
  for(const row of [4,24,38,41,52]){
    const f=MORTGAGE_REQUIREMENTS.find(r=>r.row===row)!;
    m.rules.push(rule(row,'not_future',`${groups[f.group].label}：${f.label}不晚于审核日`,'date_order',[f.id,'review_business_date'],[['2026-10-20','2026-10-21'],['2026-10-22','2026-10-21'],['2026-10-21','2026-10-21']]));
  }
  for(const [row,a,b,label] of [[10,'mortgage_lender','facility_lender','抵押权人与授信贷款人'],[44,'authorization_lender','facility_lender','授权文件贷款人与授信贷款人'],[58,'insurance_policyholder','facility_borrower','投保人与授信客户'],[59,'insurance_insured_party','facility_borrower','被保险人与授信客户'],[70,'valuation_owner','mortgage_chargor','评估产权人与抵押人']] as const){
    const r=rule(row,'identity',`${label}为同一主体`,'same_entity',[a,b],[['甲','甲'],['甲','乙'],['甲','甲']]);
    for(const t of r.tests){if(t.kind==='missing_input')continue;Object.assign(t.facts[a]!,{objectId:'party-a',...(t.kind==='abnormal'?{differentEntityIds:['party-b']}:{sameEntityIds:['party-b']})});Object.assign(t.facts[b]!,{objectId:'party-b'});}
    m.rules.push(r);
  }
  for(const [row,id] of [[38,'facility_signing_date'],[52,'authorization_signing_date']] as const)m.rules.push(rule(row,'authorized_date','签署日期不早于对应授权文件日期','date_order',['mtg_authorization_date',id],[['2026-10-20','2026-10-21'],['2026-10-22','2026-10-21'],['2026-10-21','2026-10-21']]));
  m.rules.push(rule(57,'minimum_year','保险期限至少一个日历年','calendar_year_minimum',['mtg_insurance_start','mtg_insurance_end'],[['2025-10-21','2026-10-22'],['2025-10-21','2026-10-20'],['2025-10-21','2026-10-21']]));
  const expiry=rule(57,'unexpired','保险到期日检查','date_after',['mtg_insurance_end','review_business_date'],[['2026-10-22','2026-10-21'],['2026-10-20','2026-10-21'],['2026-10-21','2026-10-21']]);expiry.tests[2]!.expected='blocked';m.rules.push(expiry);
  const anniversary=rule(67,'expiry','评估报告到期日：出具日期加一年','anniversary_notice',['valuation_issue_date'],[['2026-10-21'],['9999-12-31'],['2024-02-29']]);anniversary.tests[1]!.expected='blocked';m.rules.push(anniversary);
  for(const [row,a,b,ga,gb,factor,label] of [
    [17,'mtg_mortgage_value','mtg_market_value','mortgage','valuation','1','抵押物协议价值不低于最新市场价值'],
    [19,'mtg_maximum_liability','mtg_facility_principal','mortgage','facility','1.2','最高抵押债务金额达到授信本金 120%（原则要求）'],
    [47,'mtg_authorized_amount','mtg_facility_principal','authorization','facility','1','授权金额不低于授信金额'],
    [63,'mtg_insured_collateral_amount','mtg_reinstatement_value','insurance','valuation','1','对应抵押物保险金额覆盖重置价值'],
  ] as const)m.rules.push(rule(row,'amount',label,'minimum_ratio',[a,b,`mtg_${ga}_currency`,`mtg_${gb}_currency`],[['150','100','CNY','CNY'],['99','100','CNY','CNY'],[factor==='1.2'?'120':'100','100','CNY','CNY']],{factor}));
  m.rules.push(rule(64,'reference','保单投保单号与发票保／批单号一致','equal',['insurance_application_reference','invoice_policy_reference'],[['APP-1','APP-1'],['APP-1','APP-2'],['001','001']]));
  for(const [id,label] of [['mtg_facility_ltv_limit','授信函'],['mtg_approval_ltv_limit','内部审批']] as const)m.rules.push(rule(77,id,`抵押率不超过${label}上限`,'ltv_maximum',['mtg_facility_principal','mtg_market_value','mtg_facility_currency','mtg_valuation_currency',id],[['60','100','CNY','CNY','70'],['71','100','CNY','CNY','70'],['70','100','CNY','CNY','70']]));
  for(const [row,fieldId,value] of [[45,'mtg_authorization_capacity','guarantor'],[48,'mtg_authorization_capacity','guarantor'],[56,'mtg_insured_asset_kind','other_tangible']] as const){
    const check=m.rules.find(r=>r.id===`mtg_${row}_review`)!;check.applicability={fieldId,equals:value};
    for(const test of check.tests)test.facts[fieldId]=fact(value);
  }
  // Presence fixtures for typed fields must obey the same boundary as real facts.
  for(const r of m.rules)for(const t of r.tests)for(const [id,value] of Object.entries(t.facts))if(m.fields.find(f=>f.id===id)?.type==='date'&&value.state==='present'&&!/^\d{4}-\d{2}-\d{2}$/.test(String(value.value)))t.facts[id]=r.operator==='present'&&t.kind==='abnormal'?fact(null,'missing'):fact('2026-10-21');
  return ReviewConfigManifestSchema.parse(m);
}
