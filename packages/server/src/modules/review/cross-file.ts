import {fieldSourceSegments} from './field-source-segments.js';
import {currentRequirementPolicy,systemJudgementEnabled} from './requirement-policy.js';
import {companyNameValueCheck} from './company-name-meaning.js';
import {corporateSemanticRequirement} from './corporate-semantic-requirements.js';
import {corporateBankChecks} from './corporate-bank-checks.js';
import {corporateDerivedSources,corporateValueCheck} from './corporate-value-checks.js';
import {CORPORATE_CHECKLIST_SHA256,CORPORATE_RULE_ROWS,isCorporateSectionHeading} from '@hsbc/contracts/corporate-requirements';
import {compareGuaranteeLegalOpinion} from './legal-opinion-comparison.js';
import {verifyLegalSource} from './legal-source-verification.js';
import {fieldCandidateSelection} from './field-candidate-selection.js';

import {personalWorkbookSource} from './personal-workbook-source.js';
import {scopedSourceReadings} from './scoped-source-readings.js';
import {personalScalarSource} from './personal-scalar-source.js';
import {personalNameSource} from './personal-name-source.js';
import {GUARANTEE_AMOUNT_SOURCE} from './guarantee-amount-inputs.js';
import {semanticEligible} from './cross-file-semantics.js';
import {personalBankChecks} from './personal-bank-checks.js';
import {CORPORATE_CUSTOMER_ADDRESS_CHECK,fixedComparisonSource,type ChecklistRow,type CrossFileCheck,type CrossFileValue} from '@hsbc/contracts/review-checklist';
import type {ReviewConfigManifest,ReviewRule} from '@hsbc/contracts/review-config';
import type {ReviewState} from '@hsbc/contracts/review';
import {candidateAdoptionValue,candidateRequiredEvidenceGroups} from '@hsbc/contracts/documents';
import {assessFieldQuality,fieldQualityReason} from '@hsbc/contracts/field-quality';
import type {ChecklistInputDocument} from './checklist.js';
import {normalizeReviewValue} from './normalization.js';
import {authorizationDateSources,uploadDateSource,reviewUploadDateSources} from './date-sources.js';
import {comparisonCondition,fixedComparisonScope,isGuaranteeComparisonRow} from './guarantee-comparison-scope.js';
import {attachGuidance,attachGuidanceNotes,guidanceRefs} from './guidance.js';

interface ComparisonGroup {id:string;label:string;fields:string[];method:CrossFileCheck['method'];manual?:string;factor?:string;primary?:string[];applicability?:ReviewRule['applicability'];missingCounterpart?:{fieldId:string;label:string;filename:string;missingText:string;reason:string}}
// Explicit business counterparts, not fuzzy label/name matching. Only fields
// present in the case's pinned manifest participate; published rules are unchanged.
const groups:ComparisonGroup[]=[
  {id:'corporate-guarantee-law',primary:['cgt_field_5','cgt_legal_checklist_19'],label:'保证书与法律意见：适用法律及管辖',fields:['cgt_field_5','cgt_legal_checklist_19','cgt_legal_references','cgt_legal_conditions'],method:'manual'},
  {id:'corporate-bank',label:'授信银行名称',fields:['cgt_field_4','cgt_field_26','cgt_field_35','cgt_facility_lender','cgt_facility_parties'],method:'text',manual:'总行与分行的差异是否可接受，需要结合授信关系人工判断。'},
  {id:'corporate-borrower',label:'借款人名称',fields:['cgt_field_7','cgt_field_27','cgt_field_34','cgt_facility_borrower','cgt_facility_parties'],method:'text',manual:'中英文名称、简称或名称变更是否指向同一主体，需要原文依据。'},
  {id:CORPORATE_CUSTOMER_ADDRESS_CHECK,label:'客户地址与客户官方注册文件',fields:['cgt_field_8'],method:'text',manual:'客户官方注册文件必须属于该客户；担保人的注册文件或地址不能代替客户地址依据。',missingCounterpart:{fieldId:'cgt_customer_official_address',label:'客户官方注册文件',filename:'文件 B / 规则基准',missingText:'本批未提供客户官方注册文件',reason:'地址已提取，但缺少客户注册文件作交叉核对。按规则转客户经理确认地址有效。'}},
  {id:'corporate-guarantor',label:'担保公司名称',fields:['cgt_field_9','cgt_field_14','cgt_field_24','cgt_field_32','cgt_field_42','cgt_field_50','cgt_field_61','cgt_field_63','cgt_facility_guarantor','cgt_facility_parties'],method:'text',manual:'名称对照不代替主体身份及多担保人归属确认；环球客户经理证明中的担保公司是否为本案担保人需核对。'},
  {id:'corporate-address',label:'担保公司地址',fields:['cgt_field_10','cgt_field_43'],method:'text',manual:'注册办事处、通讯地址及地址变更的适用范围需人工判断。'},
  {id:'corporate-registration',label:'公司注册及商业登记编号',fields:['cgt_field_11','cgt_field_41','cgt_field_49','cgt_field_60'],method:'manual',manual:'核对号码标签、证件类型、注册编号与商业登记号码的对应关系，不将不同编号体系直接判为不一致。'},
  {id:'corporate-liability',label:'担保金额及用户要求',fields:['cgt_field_12','cgt_limited','cgt_amount','cgt_currency','cgt_user_required_amount','cgt_user_required_currency','cgt_required_amount','cgt_required_currency'],method:'manual',manual:'有限额担保仅与用户提供或明确确认的要求金额比较；授信函取值供确认基准时参考，不自动作为要求金额。'},
  {id:'corporate-facility-reference',label:'决议引用的授信函',fields:['cgt_field_28','cgt_facility_name','cgt_facility_number','cgt_facility_issue_date','cgt_facility_reference'],method:'manual',manual:'决议中的名称与日期是组合条款，需逐项核对对应授信函及版本。'},
  {id:'corporate-signing',label:'保证书签署人与授权',fields:['cgt_field_16','cgt_field_18','cgt_field_29','cgt_field_30','cgt_field_31','cgt_field_64','cgt_field_65'],method:'manual',manual:'核对签署人身份、授权组合、章程限制及实际签署；不判断签名真伪。'},
  {id:'corporate-directors',label:'董事名单、变更与决议签署',fields:['cgt_field_30','cgt_field_44','cgt_field_46','cgt_field_52','cgt_field_53','cgt_field_54','cgt_field_55','cgt_field_57','cgt_field_58','cgt_field_59'],method:'manual',manual:'按人员和任免生效日核对决议签署人的资格；停任、委任与周年申报名单不能直接合并为现任名单。'},
  {id:'corporate-legal-reference',primary:['cgt_legal_references'],label:'法律意见引用的主体与文书',fields:['cgt_legal_references','cgt_field_4','cgt_field_7','cgt_field_9','cgt_field_5','cgt_field_6','cgt_field_28','cgt_facility_name','cgt_facility_number','cgt_facility_issue_date','cgt_facility_reference'],method:'manual',manual:'核对法律意见引用的主体、文件名称、日期、版本及适用法律，保留限定条件和未提供材料。'},
  {id:'personal-bank',label:'授信银行名称',fields:['pg_field_4','pg_field_21','pg_field_26','pg_facility_parties'],method:'text',manual:'总分行差异是否可接受需人工判断。'},
  {id:'personal-guarantor',label:'个人担保人名称',fields:['pg_field_5','pg_field_13','pg_field_28','pg_field_31','pg_identity_name','pg_facility_parties'],method:'text',manual:'同名不能证明同一人；多人文件须逐人确认身份和归属。'},
  {id:'personal-borrower',label:'主债务人与授信函借款人',fields:['pg_field_6','pg_facility_parties'],method:'text',manual:'按授信函中的借款人角色核对主债务人；不将个人担保人或银行名称作为借款人。'},
  {id:'personal-address',label:'担保人地址',fields:['pg_field_15','pg_field_23','pg_field_34','pg_identity_address'],method:'text',manual:'逐人核对保证书、本票、授权书及身份证明地址；户籍、居住及通讯地址可能不同，须核对地址用途和证明日期。'},
  {id:'personal-identity',label:'担保人身份证号码',fields:['pg_field_14','pg_field_33','pg_identity_number'],method:'manual',manual:'先确认身份证明属于当前担保人，再按证件类型逐字核对号码并保留前导零；同名、遮挡或不同证件号码不能直接判为同一身份。'},
  {id:'personal-law',label:'保证书、本票与授权书适用法律',fields:['pg_field_9','pg_field_24','pg_field_29'],method:'text',manual:'逐份核对保证书、本票与授权书的法律名称及适用范围；条款字面相同不代表法律效力或签署要求已满足。'},
  {id:'personal-note',label:'保证书与本票金额',fields:['pg_field_7','pg_field_17'],method:'manual',manual:'核对金额、币种及票据适用条件；给付金额另按银行要求检查留空。'},
];
const unique=<T>(items:T[])=>[...new Set(items)];
const textKey=(value:string)=>value.normalize('NFKC').trim().replace(/\s+/gu,' ').toUpperCase();

function sourcesFor(row:ChecklistRow,definition:ReviewConfigManifest['fields'][number],documents:ChecklistInputDocument[],state:ReviewState):CrossFileValue[] {
  const fixed=fixedComparisonSource(row.fieldId,`${row.id}:baseline`);
  if(fixed)return [fixed];
  if(row.fieldId==='review_business_date')return reviewUploadDateSources(row,documents,state);
  const candidates=row.objectId?row.candidates:row.unassignedCandidates??[];
  const signingSources=row.fieldId==='cgt_authorization_date'?authorizationDateSources(row,documents,state):[];
  const derived=corporateDerivedSources(row,documents,state,definition);
  if(derived?.length)return derived;
  // Manual/system inputs are not extraction failures. Empty placeholder
  // observations inherit document diagnostics but are not their evidence.
  // Preserve actual file candidates and existing decisions for review below.
  if(definition.recipe.mode==='manual'&&!row.fact&&!candidates.length&&!signingSources.length)return [{
    id:`${row.id}:pending`,fieldId:row.fieldId,label:row.label,documentId:null,
    filename:'待确认的业务值',
    values:[],evidence:[],state:'pending_confirmation',warnings:['此项由人工确认或在预审时生成，不以文件自动提取替代。'],
  }];
  if(row.fact?.automaticAdoption&&row.fact.normalization.reasonCode===GUARANTEE_AMOUNT_SOURCE){
    const fact=row.fact;
    return unique(fact.evidence.map(e=>e.documentVersionId)).map(id=>({id:`${row.id}:${id}:automatic`,fieldId:row.fieldId,label:row.label,documentId:id,
      filename:documents.find(d=>d.id===id)?.filename??'保证书',values:fact.rawValue?[fact.rawValue]:[],evidence:fact.evidence.filter(e=>e.documentVersionId===id),
      warnings:[],state:fact.validity==='current'&&fact.state==='present'?'available':'uncertain'}));
  }
  const owner=state.objects.find(o=>o.objectId===row.objectId);
  const docs=row.objectRole==='corporate_guarantee'?documents.filter(d=>d.taxonomyIds.some(id=>row.materialTypes.some(t=>t.id===id))&&
    (definition.recipe.mode!=='manual'||candidates.some(c=>c.documentId===d.id))&&
    (!signingSources.some(s=>s.documentId===d.id)||candidates.some(c=>c.documentId===d.id))&&
    (row.objectId?owner?.evidence.some(e=>e.documentVersionId===d.id&&e.parseRevision===d.parseRevision&&e.directoryRevision===d.directoryRevision):candidates.some(c=>c.documentId===d.id)||!state.objects.some(o=>o.kind===definition.objectKind&&(!row.objectRole||o.role===row.objectRole)&&o.evidence.some(e=>e.documentVersionId===d.id)))):documents.filter(d=>d.taxonomyIds.some(id=>row.materialTypes.some(t=>t.id===id))&&
    (definition.recipe.mode!=='manual'||candidates.some(c=>c.documentId===d.id))&&
    (!signingSources.some(s=>s.documentId===d.id)||candidates.some(c=>c.documentId===d.id))&&
    (!row.objectId||owner?.evidence.some(e=>e.documentVersionId===d.id&&e.parseRevision===d.parseRevision&&e.directoryRevision===d.directoryRevision)));
  const sources:CrossFileValue[]=docs.map(d=>{
    let values=candidates.filter(c=>c.documentId===d.id);
    const extracted=row.objectRole==='corporate_guarantee'&&!state.readOnly;
    // Missing locators must not discard extracted values. Only an unassigned
    // file or a uniquely attributed file can use this fallback.
    // The only subject of its role owns the files attached to it, so what those files say for this field is shown on its
    // row even where a value was not attributed: it appears with its doubts and is never adopted from here.
    const soleSubject=!!owner?.automaticAttribution&&state.objects.filter(o=>o.kind===definition.objectKind&&o.role===row.objectRole).length===1;
    if(extracted&&d.projectionCurrent&&(soleSubject||!owner?.automaticAttribution&&!state.objects.some(o=>o.automaticAttribution&&o.evidence.some(e=>e.documentVersionId===d.id))&&(!row.objectId||state.objects.filter(o=>o.kind===definition.objectKind&&o.role===row.objectRole&&o.evidence.some(e=>e.documentVersionId===d.id)).length===1))){
      const raw=d.fields.filter(f=>f.fieldId===row.fieldId&&f.documentVersionId===d.id&&f.parseRevision===d.parseRevision).flatMap(f=>f.candidates.map((c,i)=>({id:`${d.id}:${f.id}:${i}`,value:c.displayValue??candidateAdoptionValue(c),documentId:d.id,evidence:[],confidence:c.confidence})));
      values=[...values,...raw.filter(c=>!values.some(v=>v.id===c.id))];
    }
    const selection=fieldCandidateSelection(values,['cgt_field_4','cgt_field_26','cgt_field_35'].includes(row.fieldId)?{...definition,valueMultiplicity:'single'}:definition);
    const resolved=selection&&selection.reason!=='unresolved';
    const fields=d.fields.filter(f=>f.fieldId===row.fieldId&&f.parseRevision===d.parseRevision);
    const quality=fields.map(f=>assessFieldQuality(f,{multiple:definition.valueMultiplicity!=='single',requireSemanticFilter:['cloud_grounded_extract','private_candidate_filter'].includes(definition.recipe.mode)}));
    const warnings=unique(quality.flatMap(q=>q.reasons)).filter(reason=>!resolved||reason!==fieldQualityReason('multiple_field_candidates'));
    const qualityWarnings=[...warnings];
    const processing=['pending','running','registered','queued','configuration_required'].includes(d.state);
    if(!d.projectionCurrent||['failed','canceled','stale'].includes(d.state))warnings.push('材料处理失败或来源版本已变化，请重新提取。');
    if(d.invalidFieldIds?.some(id=>id==='*'||id===row.fieldId))warnings.push('提取记录校验未通过。');
    if(!d.sourceHash)warnings.push('缺少可核验的来源版本记录。');
    if(values.some(v=>v.evidence.some(e=>!e.directoryRevision||e.parseRevision!==d.parseRevision||e.directoryRevision!==d.directoryRevision)))warnings.push('字段依据与当前材料版本不一致。');
    if(fields.some(f=>f.candidates.some(c=>{const refs=candidateRequiredEvidenceGroups(c);return !refs.length||refs.some(g=>!g.length||g.some(id=>!d.availableAnchorIds?.includes(id)));})))warnings.push('部分提取依据无法定位到当前版本原文。');
    const present=values.flatMap(v=>v.value?.trim()?[v.value]:[]);
    const source:CrossFileValue={id:`${row.id}:${d.id}`,fieldId:row.fieldId,label:row.label,documentId:d.id,filename:d.filename,
      values:resolved?selection.values:unique(present),displaySelection:selection?{...selection,originalValues:unique(present)}:undefined,evidence:values.flatMap(v=>v.evidence),warnings,
      state:processing?'processing':warnings.length?'uncertain':present.length?'available':'missing'};
    source.originalEligible=!processing&&['ready','partial'].includes(d.state)&&warnings.length===qualityWarnings.length&&!!values.length&&values.every(v=>v.evidence.length>0&&v.evidence.every(e=>e.documentVersionId===d.id&&e.parseRevision===d.parseRevision&&e.directoryRevision===d.directoryRevision));
    if(!processing&&warnings.length&&warnings.every(w=>qualityWarnings.includes(w)))source.scopedReadings=scopedSourceReadings(definition,fields,source,d.readingPages??[],d.readingAnchors??[]);
    if(!processing&&warnings.length&&warnings.every(w=>qualityWarnings.includes(w)))source.personalNameReading=personalNameSource(source,fields,d);
    source.personalWorkbookReading=personalWorkbookSource(source,fields,d);
    source.personalScalarReading=personalScalarSource(source,fields,d);
    if(row.objectRole==='corporate_guarantee'){
      source.originalComparisonEligible=quality.length>0&&quality.every(q=>q.reasonCodes.every(code=>resolved&&code==='multiple_field_candidates'||[
        'cloud_field_source_unverified','cloud_field_source_assembly_uncertain','cloud_field_source_assembly_elsewhere','cloud_field_coverage_incomplete',
      ].includes(code)));
      if(extracted){
      const blockers:string[]=[];
      if(!d.projectionCurrent||['failed','canceled','stale'].includes(d.state))blockers.push('材料处理失败或来源版本已变化，请重新提取。');
      if(d.invalidFieldIds?.some(id=>id==='*'||id===row.fieldId))blockers.push('提取记录校验未通过。');
      return {id:`${row.id}:${d.id}`,fieldId:row.fieldId,label:row.label,documentId:d.id,filename:d.filename,
        values:resolved?selection.values:unique(present),displaySelection:selection?{...selection,originalValues:unique(present)}:undefined,
        ...(source.scopedReadings?.length?{scopedReadings:source.scopedReadings}:{}),
        candidates:values.flatMap(v=>v.value?.trim()?[{id:v.id,value:v.value,confidence:v.confidence??null}]:[]),
        evidence:values.flatMap(v=>v.evidence),warnings:blockers,extractionWarnings:warnings.filter(w=>!blockers.includes(w)),
        originalEligible:!processing&&['ready','partial'].includes(d.state)&&warnings.length===qualityWarnings.length&&present.length>0&&
          (resolved?selection.values:unique(present)).every(value=>values.some(v=>v.value===value&&v.evidence.length>0&&v.evidence.every(e=>e.documentVersionId===d.id))),
        originalComparisonEligible:quality.length>0&&quality.every(q=>q.reasonCodes.every(code=>resolved&&code==='multiple_field_candidates'||[
          'cloud_field_source_unverified','cloud_field_source_assembly_uncertain','cloud_field_source_assembly_elsewhere','cloud_field_coverage_incomplete',
        ].includes(code))),
        originalSegments:fieldSourceSegments(d,row.fieldId,resolved?selection.values:unique(present),values.flatMap(v=>v.evidence)),
        extractionVersion:d.parseRevision&&d.directoryRevision?{parseRevision:d.parseRevision,directoryRevision:d.directoryRevision}:undefined,
        state:processing?'processing':blockers.length?'uncertain':present.length?'available':'missing'};
    }
    return verifyLegalSource(source,d);
    }
    return source;
  });
  sources.push(...signingSources);
  // Keep a manual correction separate from file extraction; never relabel it as
  // the content of each evidence document or silently hide a source conflict.
  if(row.fact&&!row.fact.automaticAdoption){
    const fact=row.fact;
    const usable=fact.validity==='current'&&fact.state==='present'&&fact.normalization.status!=='pending';
    const pending=definition.recipe.mode==='manual'&&fact.validity==='current'&&fact.state==='pending';
    sources.push({id:`${row.id}:fact`,fieldId:row.fieldId,label:row.label,documentId:null,filename:'人工确认值',values:fact.rawValue?[fact.rawValue]:[],evidence:fact.evidence,
      state:fact.state==='not_applicable'&&fact.validity==='current'?'not_applicable':usable?'available':pending?'pending_confirmation':'uncertain',warnings:usable?[]:pending?['此项业务值尚待人工确认。']:['人工记录不适用、待定或已失效，请结合其处理决定核对。']});
  }
  return sources.length?sources:[{id:`${row.id}:missing`,fieldId:row.fieldId,label:row.label,documentId:null,
    filename:row.materialTypes.map(t=>t.label).join(' / ')||'本项依据',values:[],evidence:[],warnings:[row.reason],state:'missing'}];
}

function evaluate(group:ComparisonGroup,sources:CrossFileValue[],row:ChecklistRow,manifest:ReviewConfigManifest,state:ReviewState):CrossFileCheck {
  const owner=state.objects.find(o=>o.objectId===row.objectId);
  const manualReasons=unique([...(group.manual?[group.manual]:[]),...(!owner?['对象归属尚未确认；当前仅按字段用途列出文件取值，不能据此确认是同一主体或同一笔担保。']:owner.validity!=='current'?['对象归属依据已失效。']:[])]);
  const base={id:`${row.objectId??`unassigned:${row.objectRole}`}:${group.id}`,label:group.label,fieldIds:group.fields,objectId:row.objectId,method:group.method,manualReasons,sources};
  if(group.id==='corporate-guarantee-law')return compareGuaranteeLegalOpinion(base);
  const result=(outcome:CrossFileCheck['outcome'],reason:string):CrossFileCheck=>({...base,outcome,reason});
  if(group.fields.length===1&&row.status==='not_applicable')return result('not_applicable','本项已有人工不适用决定，保留各文件原值供回查。');
  if(!sources.length)return result('insufficient','尚无可对照的材料与字段。');
  if(sources.some(s=>s.state==='not_applicable'))return result('manual','关联字段存在不适用决定，需要人工核对本项适用范围。');
  const pending=sources.filter(s=>s.state==='pending_confirmation');
  const pendingReason=pending.length?`${unique(pending.map(s=>s.label)).join('、')}尚待确认或生成；当前不能作出完整比较结论。`:undefined;
  const incomplete=sources.some(s=>s.state==='processing')?'部分文件仍在提取，完成后会自动更新对照。':
    sources.some(s=>s.state==='uncertain')?'部分来源存在识别、版本或完整性疑问；原因见对应文件。':
    sources.some(s=>s.state==='missing'||s.state!=='pending_confirmation'&&!s.values.length)?'缺少部分对应文件或字段值；缺失不记为一致。':undefined;
  if(incomplete||pending.length){
    // Missing or unreliable material must not conceal a discrepancy already
    // established between two other reliable documents, nor establish a pass.
    const reliable=sources.filter(s=>s.state==='available'&&s.documentId&&s.values.length);
    if(group.method==='text'&&!group.fields.some(id=>['cgt_facility_parties','pg_facility_parties'].includes(id))&&new Set(reliable.map(s=>s.documentId)).size>1){
      const key=(source:CrossFileValue)=>JSON.stringify(unique(source.values.map(textKey)).sort());
      const differing=reliable.filter(s=>key(s)!==key(reliable[0]!));
      if(differing.length){
        manualReasons.push(incomplete??pendingReason!);
        return result('different',`已取得的可靠取值存在差异：以${reliable[0]!.filename}为对照，${unique(differing.map(s=>`${s.filename}（${s.label}）`)).join('、')}的取值不同。核对尚未完整，不能据此确定全部材料是否符合。`);
      }
    }
    if(incomplete)return {...result('insufficient',incomplete),sourceQualityBlocked:sources.some(s=>s.state==='uncertain')&&sources.every(s=>['available','uncertain','pending_confirmation'].includes(s.state)&& (s.state==='pending_confirmation'||s.values.length>0))};
  }
  if(pending.length){
    manualReasons.push(...unique(pending.flatMap(s=>s.warnings)));
    return result('manual',pendingReason!);
  }
  if(sources.some(s=>['cgt_facility_parties','pg_facility_parties'].includes(s.fieldId)))return result('manual','授信函保留的是包含多种主体与担保安排的完整条款；已列出该文件原值，需逐角色核对，不能把整段条款当作某一个主体名称。');
  if(group.method==='manual')return result('manual','已汇集对应字段及原文；这些值承担不同业务含义，需结合条款和条件判断，不能直接按文字相等处理。');
  if(group.method==='text'&&new Set(sources.flatMap(s=>s.documentId?[s.documentId]:s.evidence.map(e=>e.documentVersionId))).size<2)return result('single_source','目前只有一份文件的依据，不能形成跨文件一致性结论。');
  if(group.method==='minimum'){
    const inputs=group.fields.slice(0,2).map((id,index)=>{
      const definition=manifest.fields.find(f=>f.id===id)!;
      const currencyValues=unique(sources.filter(s=>s.fieldId===group.fields[index+2]).flatMap(s=>s.values));
      const currency=currencyValues.length===1?normalizeReviewValue(currencyValues[0]!,'currency').value??undefined:undefined;
      return sources.filter(s=>s.fieldId===id).flatMap(s=>s.values.map(v=>normalizeReviewValue(v,definition.type,{currency,integerCount:definition.unit==='persons'})));
    });
    if(inputs.some(values=>!values.length||values.some(v=>v.status==='pending'||v.value===null)||unique(values.map(v=>JSON.stringify([v.value,v.currency,v.unit]))).length!==1))return result('insufficient','金额、币种、单位或人数存在缺失、歧义或不同取值，无法自动计算。');
    const a=inputs[0]![0]!,b=inputs[1]![0]!;
    if(a.currency!==b.currency||a.unit!==b.unit)return result('manual','两项金额的币种或单位不同，不能直接比较，也不自动换汇。');
    // Exact decimal comparison, including values above Number.MAX_SAFE_INTEGER.
    const decimal=(v:string)=>{const [whole,fraction='']=v.split('.');return {n:BigInt(whole!+fraction),scale:10n**BigInt(fraction.length)};};
    const factor=group.factor??'1';
    if(![a.value!,b.value!,factor].every(v=>/^\d+(?:\.\d+)?$/.test(v)))return result('manual','数值不能按非负十进制规则比较，请人工核对。');
    const left=decimal(a.value!),right=decimal(b.value!),ratio=decimal(factor);
    const meets=left.n*right.scale*ratio.scale>=right.n*ratio.n*left.scale;
    return result(meets?'consistent':'different',`${a.value} ${a.currency??''} ${meets?'达到':'低于'}对照要求 ${b.value} ${b.currency??''}${factor==='1'?'':` × ${factor}`}；条款适用性仍按人工提示核对。`);
  }
  const normalized=sources.map(source=>source.values.map(value=>{
    const definition=manifest.fields.find(f=>f.id===source.fieldId)!;
    if(['amount','date','currency'].includes(definition.type)){
      const n=normalizeReviewValue(value,definition.type,{literalDateClock:true});
      return n.status==='pending'||n.value===null?null:JSON.stringify([n.value,n.currency,n.unit]);
    }
    return textKey(value);
  }));
  if(normalized.some(values=>values.some(v=>v===null)))return result('insufficient','金额、币种或日期无法明确转换，需核对原文；不猜测币种、单位或日期。');
  if(group.method==='date_order'){
    const fieldValues=group.fields.map(id=>unique(sources.filter(s=>s.fieldId===id).flatMap(s=>s.values.map(v=>normalizeReviewValue(v,'date').value))));
    if(fieldValues.length!==2||fieldValues.some(v=>v.length!==1||!v[0]))return result('manual','同一日期存在多个候选或日期不明确，需确认对应事件后比较。');
    const left=fieldValues[0]![0]!,right=fieldValues[1]![0]!;
    return result(left<=right?'consistent':'different',`${sources.find(s=>s.fieldId===group.fields[0])!.label}（${left}）${left<=right?'不晚于':'晚于'}${sources.find(s=>s.fieldId===group.fields[1])!.label}（${right}）。`);
  }
  const keys=normalized.map(values=>JSON.stringify(unique(values).sort()));
  const same=new Set(keys).size===1;
  const differing=unique(sources.filter((_,index)=>keys[index]!==keys[0]).map(source=>`${source.filename}（${source.label}）`));
  const difference=`以${sources[0]!.filename}为对照，${differing.join('、')}的取值不同。`;
  return result(same?'consistent':'different',group.method==='text'?
    same?'各文件取值文字一致（仅统一全半角、大小写及连续空白）；主体身份和条款适用性按人工提示核对。':`${difference}简称、译名、总分行及名单变化需人工判断是否可接受。`:
    same?'各文件的对应值经明确格式转换后相同。':`${difference}比较已统一明确的数值或日期格式，请核对原文及适用条件。`);
}

/** Automatic read projection, also frozen verbatim when starting a review. */
export function withCrossFileChecks(manifest:ReviewConfigManifest,state:ReviewState,documents:ChecklistInputDocument[],rows:ChecklistRow[]):ChecklistRow[] {
  // Published rule-centre wording and confirmed case rules; absent when none exist,
  // so checks without applicable guidance keep their previous fingerprints.
  const refs=guidanceRefs(manifest,state.guidance);
  return withoutGuidance(manifest,state,documents,rows).map(row=>{
    const guided=row.crossChecks?{...row,crossChecks:row.crossChecks.map(check=>attachGuidance(check,refs))}:row;
    return attachGuidanceNotes(guided,refs);
  });
}
function withoutGuidance(manifest:ReviewConfigManifest,state:ReviewState,documents:ChecklistInputDocument[],rows:ChecklistRow[]):ChecklistRow[] {
  const definitions=new Map(manifest.fields.map(f=>[f.id,f]));
  const configured=groups.map(g=>({...g,fields:g.fields.filter(id=>definitions.has(id))})).filter(g=>g.fields.length>1||g.missingCounterpart&&g.fields.length);
  const rules:ComparisonGroup[]=manifest.rules.filter(r=>r.inputs.filter(id=>definitions.has(id)).length>1).map(r=>({id:`rule:${r.id}`,label:r.label,
    fields:r.inputs.filter(id=>definitions.has(id)),factor:r.factor,applicability:r.applicability,
    method:!r.sourceDirectionConfirmed?'manual':r.operator==='equal'?'equal':r.operator==='date_order'?'date_order':['minimum','minimum_ratio'].includes(r.operator)?'minimum':'manual',
    manual:r.applicability?'本项有适用条件，数值对照不替代条件与业务规则判断。':!r.sourceDirectionConfirmed?'业务比较方向尚未确认。':['equal','date_order','minimum','minimum_ratio'].includes(r.operator)?undefined:r.description??'请结合规则条件人工判断。'}));
  return rows.map(row=>{
    if(row.objectRole==='corporate_guarantee'){
      const sourceValues=sourcesFor(row,definitions.get(row.fieldId)!,documents,state);
      const read=(related:ChecklistRow)=>sourcesFor(related,definitions.get(related.fieldId)!,documents,state);
      const today=new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Shanghai',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date());
      const checks=corporateBankChecks(row,rows,manifest,read,
        (group,sources)=>evaluate(group,sources,row,manifest,state));
      if(row.fieldId==='cgt_authorization_reference_date'&&!state.readOnly){
        const guarantee=rows.find(r=>r.fieldId==='cgt_field_19'&&r.objectId===row.objectId&&r.objectRole===row.objectRole);
        if(guarantee)checks.push(...corporateBankChecks(guarantee,rows,manifest,read,(group,sources)=>evaluate(group,sources,row,manifest,state)));
      }
      // The authorization-date row is another view of workbook row 7, not a
      // new requirement. Show that existing comparison instead of an empty result.
      if(row.fieldId==='cgt_authorization_date'&&!state.readOnly){
        const guarantee=rows.find(r=>r.fieldId==='cgt_field_6'&&r.objectId===row.objectId&&r.objectRole===row.objectRole);
        if(guarantee)checks.push(...corporateBankChecks(guarantee,rows,manifest,related=>sourcesFor(related,definitions.get(related.fieldId)!,documents,state),
          (group,sources)=>evaluate(group,sources,row,manifest,state)).filter(c=>c.id.endsWith('rule:cgt_signing_authorized')));
      }
      const legal=/^cgt_legal_checklist_\d+$/u.test(row.fieldId)?row.rules.find(r=>r.id===`${row.fieldId}_review`):undefined;
      if(legal&&!state.readOnly&&manifest.rules.some(r=>r.id===legal.id&&r.sourceIds.includes('cgt_checklist'))&&manifest.sources.some(s=>s.id==='cgt_checklist'&&s.sha256===CORPORATE_CHECKLIST_SHA256&&s.disposition!=='excluded'))checks.push({...evaluate({id:`rule:${legal.id}`,label:row.label,fields:[row.fieldId],method:'manual'},sourceValues,row,manifest,state),
        id:`${row.id}:rule:${legal.id}`,checklistRule:{id:legal.id,text:legal.text,sources:legal.sources}});
      return {...row,rules:state.readOnly?row.rules:row.rules.filter(r=>r.id!=='cgt_witness_signature').map(r=>{const bank=/^cgt_bank_(\d+)$/u.exec(r.id),original=bank?CORPORATE_RULE_ROWS.find(b=>b.row===Number(bank[1])):undefined;return original?{...r,text:[original.requirement,original.notice].filter(Boolean).join(' ')}:r;}),sourceValues,crossChecks:checks.map(original=>{
        const check=state.readOnly?original:companyNameValueCheck(corporateSemanticRequirement(corporateValueCheck(original,row,rows,documents,state,read,today),row,rows,read,documents,state,manifest));
        const current={...check,...(!state.readOnly?{valueBasis:'extracted' as const,sources:check.sources.map(({originalEligible,originalComparisonEligible,originalSegments,...source})=>source)}:{})};
        return {...current,semanticEligible:current.bankExecution?false:semanticEligible(current,manifest)};
      })};
    }
    if(row.objectRole==='personal_guarantee')return {...row,
      crossChecks:personalBankChecks(row,rows,manifest,state,related=>sourcesFor(related,definitions.get(related.fieldId)!,documents,state)),
      sourceValues:sourcesFor(row,definitions.get(row.fieldId)!,documents,state)};
    if(isCorporateSectionHeading(row.fieldId))return row;
    const selected=[...configured,...rules].filter(g=>(g.primary??g.fields).includes(row.fieldId));
    if(!selected.length&&!isGuaranteeComparisonRow(row))selected.push({id:`field:${row.fieldId}`,label:row.label,fields:[row.fieldId],method:'text',
      manual:row.rules.some(r=>manifest.rules.some(rule=>rule.id===r.id&&rule.operator==='manual_review'))?'该字段包含人工业务核对要求；取值相同不代表规则通过。':undefined});
    const crossChecks=selected.flatMap(original=>{
      const scoped=isGuaranteeComparisonRow(row)&&!original.id.startsWith('rule:')?fixedComparisonScope(original.fields,row,rows,documents,manifest,state):{fields:original.fields,pending:[]};
      const group={...original,fields:scoped.fields};
      // An optional legal opinion absent from the current bank scope is not a missing counterpart.
      if(original.id==='corporate-guarantee-law'&&group.fields.length<2)return [];
      const applicable=isGuaranteeComparisonRow(row)&&group.applicability?comparisonCondition(group.applicability,row,rows,documents,manifest,state):true;
      const owner=state.objects.find(o=>o.objectId===row.objectId);
      let sources=group.fields.flatMap(id=>{
        const definition=definitions.get(id)!;
        let related=rows.find(r=>r.fieldId===id&&r.objectId===row.objectId);
        if(!related&&owner?.validity==='current'&&row.objectRole!=='personal_guarantee'){
          const linked=rows.filter(r=>r.fieldId===id&&state.objects.some(o=>o.objectId===r.objectId&&o.validity==='current'&&owner.relations.some(link=>link.targetObjectId===o.objectId&&link.targetVersion===o.version)));
          if(linked.length===1)related=linked[0];
        }
        return related?sourcesFor(related,definition,documents,state):[{id:`${row.id}:${id}:unassigned`,fieldId:id,label:definition.label,documentId:null,filename:'对应材料',values:[],evidence:[],warnings:['尚无明确归属于本对象的对应字段。'],state:'missing' as const}];
      });
      if(original.missingCounterpart){
        const missing=original.missingCounterpart;
        sources.push({id:`${row.id}:${missing.fieldId}`,fieldId:missing.fieldId,label:missing.label,documentId:null,filename:missing.filename,values:[],evidence:[],warnings:[missing.reason],state:'missing',missingText:missing.missingText});
      }
      if(isGuaranteeComparisonRow(row)) {
        const result=(outcome:CrossFileCheck['outcome'],reason:string):CrossFileCheck=>({id:`${row.objectId??`unassigned:${row.objectRole}`}:${group.id}`,label:group.label,fieldIds:group.fields,objectId:row.objectId,method:group.method,outcome,reason,sources,manualReasons:[...(group.manual?[group.manual]:[]),...scoped.pending]});
        if(applicable===false)return result('not_applicable','已确认本项适用条件不成立，不进行数值比较。');
        if(applicable===undefined){
          const condition=group.applicability!;
          const label=definitions.get(condition.fieldId)?.label??manifest.materials.find(m=>`material:${m.id}`===condition.fieldId)?.label??condition.fieldId;
          const expected=condition.equals==='limited'?'有限额':condition.equals==='unlimited'?'无限额':condition.equals===true?'适用':condition.equals===false?'不适用':String(condition.equals);
          return result('manual',`请确认「${label}」是否为「${expected}」；确认后自动执行「${group.label}」。`);
        }
        if(!original.id.startsWith('rule:')&&group.fields.length<2)return result('manual',original.missingCounterpart?.reason??'请按本项银行规则核对已提供的材料；未提供的非必需材料不作为补件要求。');
        // Old published configurations may still point at extracted facility
        // values. Reading that amount does not establish the user's benchmark.
        if(group.id==='rule:cgt_amount_minimum') {
          const benchmarkIds=[group.fields[1],group.fields[3]];
          if(benchmarkIds.some(id=>{
            const fact=rows.find(r=>r.fieldId===id&&r.objectId===row.objectId)?.fact;
            return !fact||fact.automaticAdoption&&!systemJudgementEnabled(currentRequirementPolicy())||fact.validity!=='current'||fact.state!=='present'||fact.normalization.status==='pending';
          }))return result('manual',systemJudgementEnabled(currentRequirementPolicy())?'尚未取得授信函要求的担保金额及币种；请填写用户要求的金额及币种，或确认保证书所列金额可接受。':'尚未确认用户要求的担保金额；请由用户提供或明确确认比较基准及币种。授信函取值仅供核对，不能自动代替用户要求。');
          // Keep file candidates on their own reading cards, not as competing
          // requirements alongside an explicitly confirmed user benchmark.
          sources=sources.filter(s=>!benchmarkIds.includes(s.fieldId)||s.id.endsWith(':fact'));
        }
      }
      // Each file is checked against its own upload day, including before a run
      // starts. Never borrow the case clock or the latest upload in the case.
      if(group.method==='date_order'&&group.fields.length===2&&group.fields.includes('review_business_date')){
        const fieldId=group.fields.find(id=>id!=='review_business_date')!;
        const values=sources.filter(s=>s.fieldId===fieldId);
        const ids=unique(values.flatMap(s=>s.documentId?[s.documentId]:s.evidence.map(e=>e.documentVersionId)));
        if(!ids.length)return evaluate(group,[...values,{id:`${row.id}:upload-missing`,fieldId:'review_business_date',label:'审核基准日（本文件上传日期，北京时间）',documentId:null,filename:'对应文件上传记录',values:[],evidence:[],warnings:['尚未明确被检查日期对应的文件，无法取得上传日期。'],state:'missing'}],row,manifest,state);
        return ids.map(id=>{
          const document=documents.find(d=>d.id===id);
          const own=values.filter(s=>s.documentId===id||!s.documentId&&s.evidence.length>0&&s.evidence.every(e=>e.documentVersionId===id));
          // Unattributed or multi-file corrections cannot be silently discarded.
          const unresolved=values.filter(s=>!s.documentId&&(new Set(s.evidence.map(e=>e.documentVersionId)).size!==1));
          const baseline=document?uploadDateSource(document):{id:`${id}:upload-missing`,fieldId:'review_business_date',label:'审核基准日（本文件上传日期，北京时间）',documentId:id,filename:'对应文件上传记录',values:[],evidence:[],warnings:['未取得本文件上传记录。'],state:'missing' as const};
          return evaluate({...group,id:ids.length>1?`document:${id}:${group.id}`:group.id},[...own,...unresolved.map(s=>({...s,state:'uncertain' as const,warnings:[...s.warnings,'人工日期尚未明确对应唯一文件。']})),baseline],row,manifest,state);
        });
      }
      const checked=evaluate(group,sources,row,manifest,state);
      if(scoped.pending.length){
        checked.manualReasons.push(...scoped.pending);
        if(checked.outcome==='consistent'){checked.outcome='manual';checked.reason='已提供的文件取值一致，相关材料的适用条件尚待确认。';}
      }
      return checked;
    });
    return {...row,...(!crossChecks.length&&isGuaranteeComparisonRow(row)?{sourceValues:sourcesFor(row,definitions.get(row.fieldId)!,documents,state)}:{}),crossChecks:crossChecks.map(check=>({...check,semanticEligible:semanticEligible(check,manifest)}))};
  });
}
