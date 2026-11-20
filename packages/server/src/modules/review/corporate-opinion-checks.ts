import type {AutomaticReviewCheck} from '@hsbc/contracts/field-verification';
import type {ReviewConfigManifest} from '@hsbc/contracts/review-config';
import {CORPORATE_CHECKLIST_SHA256,CORPORATE_WORKBOOK_SHA256} from '@hsbc/contracts/corporate-requirements';
import {corporateNameKey,corporatePageStatements,uniqueSources,type CorporateCheckContext,type CorporateSource} from './corporate-check-sources.js';
import {compareGuaranteeLegalOpinion} from './legal-opinion-comparison.js';

const plain=(s:string)=>s.normalize('NFKC').replace(/\s+/gu,'');
const text=(s:CorporateSource[])=>[...new Set(s.map(s=>plain(s.value)))].join('\n');
type Conclusion={reason:string;notApplicable?:boolean};
export function completeArticlesBody(pages:string[]):boolean{
 const body=pages.join('\n'),range=/These Articles comprise Articles (\d+) to (\d+) and have no unlisted annexes/iu.exec(body.replace(/\s+/gu,' '));
 if(!range||Number(range[1])!==1||Number(range[2])>200)return false;
 const headings=[...body.matchAll(/(?:^|\n)(\d{1,3})\.\s+[A-Z]/gu)].map(m=>Number(m[1]));
 return headings.length===Number(range[2])&&headings.every((n,i)=>n===i+1);
}
/** Checks what the opinion expressly concludes, not whether those legal
 * propositions are independently true. Unrecognized or adverse wording is
 * never inferred from an absent keyword. Underlying approvals remain separate. */
export function explicitOpinionConclusion(number:number,value:string):Conclusion|undefined{
 const t=plain(value);
 if(/尚无结论|尚無結論|待(?:确认|审核|核实)|仅为示例|僅為示例|未注册|未依法注册|已不再存续|未必|不能认定|不确认|无法确定/u.test(t))return;
 if(/(?:^|[。；\n])(?:如果|假设|假設|假定|若).{0,80}(?:注册|存续|授权|签署|有效|权力)/u.test(t))return;
 if(/(?:但是|但|然而).{0,60}(?:尚需|仍需|无法|不满足|不具有|无效|仍享有|责任限制|应支付)/u.test(t))return;
 // Do not let an affirmative fragment override an express withdrawal, missing
 // opinion, draft question, or a contradictory conclusion in the same field.
 if(/不发表|不發表|不作.{0,8}(?:结论|結論|意见|意見)|无法确认|無法確認|不能确认|不能確認|撤回.{0,12}(?:结论|意见)|尚未(?:注册|授权|签署)|不具有.{0,8}(?:权力|能力)|不构成.{0,12}(?:有效|约束力)|不享有.{0,8}公司权力|\?|？/u.test(t)&&![20].includes(number))return;
 const definitions:Record<number,{tests:RegExp[];reason:string}>={
  4:{tests:[/仅假设副本与原件一致/u,/签名由所标示人员作出/u,/无法从具体询问和检索得知的未披露私人协议/u,/不以概括.{0,12}完整披露.{0,12}代替核查/u,/没有把.{0,25}公司能力.{0,15}董事会权限.{0,15}会议法定人数.{0,15}适当授权.{0,15}法律合规.{0,15}章程合规.{0,15}保证可执行性作为假设/u,/未假定.{0,40}所有陈述均正确/u],reason:'已核对本意见的事实假设范围及明确排除项：未将公司能力、授权、法律／章程合规、可执行性或全部陈述正确作为假设。身份与事实记录的核验已在独立待办保留，不重复要求人工重读同一条款。'},
  5:{tests:[/破产.{0,12}清盘.{0,25}债权人共同利益.{0,20}可撤销交易.{0,12}一般法律约束/u,/衡平救济.{0,12}具体履行.{0,12}禁令.{0,15}法院裁量/u,/诉讼时效.{0,12}送达.{0,12}程序规则/u,/此保留不取消正文对能力.{0,8}授权或合同效力的意见/u,/检索存在记录更新和公开范围限制/u,/本意见截至\d{4}年\d{1,2}月\d{1,2}日/u,/未来法律或事实变化没有自动更新义务/u,/若董事.{0,12}章程.{0,12}保证范围或执行地区改变.{0,12}再次审阅/u],reason:'已核对本意见明确列出的普通法律、法院程序及查询时点限制，并确认保留条款没有撤回正文的能力、授权或合同效力结论；后续变更复核保留在独立待办。本项完成文书内容核对，不替代银行批准。'},
  2:{tests:[/关联公司.{0,60}(?:高级人员|董事).{0,60}(?:审计师|专业顾问)/u,/潜在受让人.{0,40}分参与人/u,/(?:诉讼|仲裁).{0,50}(?:调查|程序|争议)/u,/法律法规.{0,90}(?:监管|监督)/u,/无须另获.{0,8}同意/u,/披露权不因第三人无依赖权而受限制/u],reason:'已核对四类披露对象及场景均获允许，且非依赖限制不取消披露权。'},
  6:{tests:[/不含责任金额上限/u,/免责额/u,/(?:亦不|不)以其他委托条款引入责任限制/u],reason:'已核对责任条款：意见明确不设责任金额上限、免责额或通过其他委托条款引入的责任限制。'},
  7:{tests:[/注册并存续/u,/私人股份有限公司/u],reason:'已定位并核对律师对公司注册及存续的肯定结论；不将该文书结论冒充实时登记查询。'},
  8:{tests:[/检索/u,/未见清盘人或接管人获委任/u,/未见清盘呈请或命令/u,/\d{4}年\d{1,2}月\d{1,2}日/u],reason:'已核对意见包含有日期的清盘、接管及呈请检索结论；结论仅截至所述查询时点，底层查询记录另列核验。'},
  9:{tests:[/允许为全资子公司的债务提供保证/u,/具有.{0,24}公司权力/u,/(?:不属于|并非).{0,12}董事个人债务/u],reason:'已核对意见对本次保证的公司权能作出肯定结论，并明确全资子公司及排除董事个人债务的事实条件。'},
  10:{tests:[/现任董事/u,/全程出席表决/u,/满足章程.{0,40}法定人数/u,/授权.{0,30}共同签署/u,/无须额外股东决议/u],reason:'已核对意见具体说明董事名单、会议人数、共同签署授权及无需额外股东决议；相关公司事实资料仍按独立事项核验。'},
  11:{tests:[/作为契据签署/u,/共同签署/u,/无条件交付/u,/无须法团印章/u],reason:'已核对意见明确说明契据签署、共同签署、交付及无需印章的法律结论；本项不验证签名真伪。'},
  12:{tests:[/订立.{0,12}交付.{0,12}履行/u,/不违反适用于.{0,35}法律要求/u],reason:'已核对意见对本案保证的订立、交付及履行不违反注册地法律作出结论，保留其交易范围。'},
  13:{tests:[/与已审阅完整.{0,35}一致/u,/没有未经满足的章程限制/u,/不存在后续修订/u],reason:'已核对意见明确说明与完整章程一致、无未满足限制及无后续修订；不替代后续变更确认。'},
  14:{tests:[/合法.{0,4}有效.{0,4}有约束力/u,/可按其条款执行/u,/(?:本金数字不是|本金不构成).{0,15}总责任上限/u,/不含未来新增授信/u],reason:'已核对意见对保证有效、约束及可执行性作出肯定结论，并保留本金、息费和现有授信范围限制。'},
  15:{tests:[/无须另取.{0,55}(?:授权|许可).{0,20}批准/u,/不存在.{0,20}尚未满足的限制性承诺/u,/内部法务审批.{0,25}另行处理/u],reason:'已核对意见明确无额外外部授权／许可要求；银行内部批准及提款条件仍独立处理。'},
  16:{tests:[/无须支付.{0,12}印花税或登记税/u,/纯付款保证/u],reason:'已核对意见对本案保证所在法域的印花税／登记税给出明确否定结论；其他融资文件及法域不纳入此结论。'},
  17:{tests:[/无须.{0,12}另作公证.{0,12}登记.{0,12}备案/u,/无保证相关待办登记及缴税条件/u],reason:'已核对意见明确本保证无需另行公证、登记或备案，且区分公司一般申报义务。'},
  21:{tests:[/不会被视为.{0,12}住所或在.{0,12}经营业务/u,/仅因实施这些活动/u,/不将关联实体的牌照或登记移用于本银行/u],reason:'已核对意见针对本银行接受、持有及执行该保证的活动，给出不构成当地经营的限定结论。'},
  22:{tests:[/无须另行取得.{0,40}(?:牌照|经营资格)/u,/无须仅为该等行为办理.{0,12}经营登记/u,/不授权其他.{0,18}受规管活动/u],reason:'已核对意见对本银行接受、持有及执行该保证无需额外当地许可给出限定结论；不扩大到其他业务。'},
  23:{tests:[/私人商业公司/u,/不涉及国家或公共机关/u,/不享有.{0,60}主权豁免/u],reason:'已核对意见明确该私人商业保证人不享有所列司法程序及执行的主权豁免。'},
 };
 const definition=definitions[number];
 if(definition?.tests.every(re=>re.test(t)))return {reason:definition.reason};
}

/** Consume current, re-read sources and full pinned pages. Multiple clauses are
 * complementary requirements: preserve them all instead of ranking by score. */
export function corporateOpinionChecks(c:CorporateCheckContext,manifest:ReviewConfigManifest,scopeId:string):AutomaticReviewCheck[]{
 const result:AutomaticReviewCheck[]=[];
 const legal=c.current.filter(d=>d.taxonomyIds.includes('cgt_legal'));
 if(legal.length!==1||!c.coverage.get(legal[0]!.id))return result;
 const pages=c.pages.filter(p=>p.document.id===legal[0]!.id&&p.trusted);
 const typeSources=pages.filter(p=>p.number===1).flatMap(p=>p.sources).filter(s=>/综合意见|綜合意見|combined.{0,30}opinion/iu.test(plain(s.value)));
 if(!typeSources.length)return result;
 const emit=(fieldId:string,ruleIds:string[],reason:string,sources:CorporateSource[],notApplicable=false)=>{
  const row=c.own.find(r=>r.fieldId===fieldId),all=uniqueSources([...sources,...typeSources]);
  if(!row||!all.length||all.length>40||!ruleIds.length)return;
  const rules=ruleIds.map(id=>manifest.rules.find(r=>r.id===id));
  if(rules.some(r=>!r||r.operator!=='manual_review'||r.inputs.length!==1||r.inputs[0]!==fieldId||r.objectScope?.role!=='corporate_guarantee'||r.requiredParameters.length||!r.sourceDirectionConfirmed||
    r.applicability&&c.facts[r.applicability.fieldId]?.value!==r.applicability.equals||!r.sourceIds.length||!r.sourceIds.every(id=>manifest.sources.some(s=>s.id===id&&s.sha256===(id==='cgt_checklist'?CORPORATE_CHECKLIST_SHA256:CORPORATE_WORKBOOK_SHA256)&&['candidate','confirmed'].includes(s.disposition)))))return;
  result.push({id:`corporate-opinion-v1:${scopeId}:${fieldId}`,fieldId,objectId:row.objectId,ruleIds,status:'done',reason,
   execution:{version:'corporate-opinion-content-v1',referenceHashes:[CORPORATE_CHECKLIST_SHA256,CORPORATE_WORKBOOK_SHA256],evidence:[]},
   item:{rowId:row.id,fieldId,objectId:row.objectId,scope:'bank_rule',meaning:notApplicable?'not_applicable':'consistent',reason,actions:[],sources:all}});
 };
 for(let n=1;n<=23;n++){
  const field=`cgt_legal_checklist_${n}`,sources=c.values(field,'cgt_legal');
  if(!sources.length)continue;
  const conclusion=explicitOpinionConclusion(n,text(sources));
  if(conclusion)emit(field,[`${field}_review`],conclusion.reason,sources);
 }
 const recipient=c.values('cgt_legal_checklist_1','cgt_legal'),bank=c.values('cgt_field_4','cgt_guarantee');
 const name=(s:string)=>corporateNameKey(s).replace(/ANDITS|及其/gu,'');
 if(bank.length&&recipient.some(s=>bank.some(b=>name(s.value).includes(name(b.value)))))emit('cgt_legal_checklist_1',['cgt_legal_checklist_1_review'],'已核对法律意见收件人包含本保证书所列银行及对应分行。',[...recipient,...bank]);
 // The existing legal-choice comparator already separates guarantee law from
 // facility law. Feed it verified originals rather than stale extraction gaps.
 const choiceFields=['cgt_field_5','cgt_legal_checklist_19','cgt_legal_references','cgt_legal_conditions'];
 const choiceSources=choiceFields.flatMap(fieldId=>c.values(fieldId,fieldId==='cgt_field_5'?'cgt_guarantee':'cgt_legal').map((s,index)=>({id:`${fieldId}:${index}`,fieldId,label:fieldId,documentId:s.evidence.documentVersionId,filename:s.filename,values:[s.value],evidence:[s.evidence],state:'available' as const,warnings:[]})));
 // Preserve each document's full field clauses together: one paragraph can
 // state law while another states forum or the current enforcement route.
 const grouped=new Map<string,typeof choiceSources[number]>();
 for(const s of choiceSources){const key=JSON.stringify([s.fieldId,s.documentId]),previous=grouped.get(key);if(previous){previous.values.push(...s.values);previous.evidence.push(...s.evidence);}else grouped.set(key,{...s,values:[...s.values],evidence:[...s.evidence]});}
 const law=compareGuaranteeLegalOpinion({id:'corporate-opinion-law',label:'保证书与法律意见',objectId:c.own[0]?.objectId??null,fieldIds:choiceFields,method:'manual',manualReasons:[],sources:[...grouped.values()]});
 const guarantee=c.values('cgt_field_5','cgt_guarantee'),opinion=c.values('cgt_legal_checklist_19','cgt_legal');
 if(guarantee.length&&opinion.length&&law.comparisons?.length===3&&law.comparisons.every(a=>a.outcome==='consistent')){
  const matched=[...guarantee,...opinion];
  emit('cgt_legal_checklist_19',['cgt_legal_checklist_19_review'],'已逐项核对保证书与法律意见的适用法律、法院及管辖方式，三项一致；授信函自己的法律选择已分别处理。',matched);
  const incorporation=c.values('cgt_field_62','cgt_incorporation'),regions=new Set(incorporation.map(s=>/^(?:Hong\s*Kong(?:SAR)?|香港)$/iu.test(plain(s.value))?'香港':plain(s.value)));
  if(regions.size===1&&regions.has('香港')&&law.comparisons.find(a=>a.id==='law')?.values.every(v=>v.value==='香港法')){
   emit('cgt_field_62',['cgt_bank_67'],'已核对注册地为香港，保证书适用香港法，且已有对应法律意见；未触发离岸注册地与香港／内地法不一致的分支。',[...incorporation,...matched]);
   emit('cgt_field_5',['cgt_bank_6'],'已核对保证人的注册地、保证书香港法及对应综合意见的适用性说明，未发现法域不一致。',[...incorporation,...matched]);
  }
 }
 const articles=c.current.filter(d=>d.taxonomyIds.includes('cgt_articles'));
 const quorum=c.values('cgt_field_64','cgt_articles');
 if(articles.length===1&&quorum.length){
  const q=quorum.map(s=>s.value.replace(/\s+/gu,' ')).join('\n');
  const counts=[...q.matchAll(/quorum (?:is|shall be) (\d+|one|two|three|four|five) directors?\b/giu)].map(m=>({one:1,two:2,three:3,four:4,five:5}[m[1]!.toLowerCase()]??Number(m[1])));
  if(counts.length&&new Set(counts).size===1&&counts[0]!>0&&/entitled to vote/iu.test(q)&&/must not be counted in its quorum/iu.test(q)&&/quorum must be maintained throughout/iu.test(q)){
   emit('cgt_field_64',['cgt_bank_71'],`已从章程核对通常法定人数为 ${counts[0]} 名有表决权董事，利益冲突者不得计入且须全程维持；原文单董事等例外一并保留。本项完成条款提取和提示，不把人数条款当作签署真实性证明。`,quorum);
  }
 }
 const articlePages=c.pages.filter(p=>p.document.id===articles[0]?.id&&p.trusted).sort((a,b)=>a.number-b.number);
 const articleBody=articlePages.map(p=>p.text).join('\n').replace(/\s+/gu,' ');
 const restrictions=c.values('cgt_field_65','cgt_articles'),requiredResolution=c.values('cgt_articles_required_resolution','cgt_articles');
 const ownership=corporatePageStatements(c.pages,'cgt_facility',new RegExp([...'保证人是借款人的100%直接股东'].join('\\s*'),'u'));
 const authority=c.values('cgt_field_28','cgt_resolution');
 const complete=articles.length===1&&completeArticlesBody(articlePages.map(p=>p.text));
 const conditions=[/guarantee the debts of its direct or indirect wholly-owned subsidiaries/iu,/guarantee requires Board approval/iu,
  /must not guarantee a director['’]s personal debts/iu,/not wholly owned requires a prior special resolution of the members/iu,
  /No separate approval of members is required except under mandatory law/iu,/requires renewed approval/iu];
 if(complete&&conditions.every(p=>p.test(articleBody))&&ownership.length&&authority.length&&restrictions.length&&requiredResolution.length){
  const footer=articlePages.flatMap(p=>p.sources).filter(s=>/These Articles comprise Articles/iu.test(s.value));
  const sources=[...restrictions,...requiredResolution,...ownership,...authority,...footer];
  const reason='已核对完整章程正文及本轮授信记载：全资子公司担保走董事会批准，非全资第三方另需股东特别决议，禁止为董事个人债务担保；金额／授信范围重大变化需重新批准。本案授信记载100%直接持股，已提供对应董事会决议；底层股权资料及后续变更核验另列，未被本项代替。';
  emit('cgt_field_65',['cgt_bank_72'],reason,sources);
  emit('cgt_articles_required_resolution',['cgt_articles_resolution_review'],reason,sources);
 }
 const security=c.values('cgt_legal_checklist_18','cgt_legal');
 const guaranteeExclusion=c.pages.filter(p=>p.document.taxonomyIds.includes('cgt_guarantee')).flatMap(p=>p.sources)
  .filter(s=>/(?:does not|shall not) create.{0,60}mortgage.{0,50}(?:charge|security interest)|No mortgage, pledge, fixed charge or floating charge is created by this Guarantee/iu.test(s.value.replace(/\s+/gu,' ')));
 const facilityExclusion=corporatePageStatements(c.pages,'cgt_facility',new RegExp([...'无抵押、质押或其他资产押记。'].join('\\s*'),'u'));
 if(security.length&&/本保证不创设抵押.{0,20}质押.{0,40}押记/u.test(text(security))&&(guaranteeExclusion.length||facilityExclusion.length))
  emit('cgt_legal_checklist_18',['cgt_legal_checklist_18_review'],'已核对法律意见及对应融资文书明确不设抵押、质押或资产押记，担保物权设立／完善检查在本次纯保证范围内不适用；增加资产担保时须重新检查。',[...security,...guaranteeExclusion,...facilityExclusion],true);
 const enforcement=c.values('cgt_legal_checklist_20','cgt_legal');
 if(enforcement.length&&/不涵盖外国判决的承认与执行/u.test(text(enforcement))&&/本案拟直接向香港法院主张/u.test(text(enforcement))&&/另行取得法律意见/u.test(text(enforcement))&&law.comparisons?.length===3&&law.comparisons.every(a=>a.outcome==='consistent'))
  emit('cgt_legal_checklist_20',['cgt_legal_checklist_20_review'],'已核对现有文书记载的路径为直接在香港主张保证权利，本次不依赖外国判决承认；意见明确不覆盖其他法域执行，执行路径后续变化的确认仍单列保留。',[...enforcement,...guarantee,...opinion],true);
 return result;
}
