import {applyGuaranteeRoleEvidence,type GuaranteeExtractionOptions} from './guarantee-role-evidence.js';
import {createCorporateGuaranteeManifest} from './corporate-requirements.js';
import {createPersonalGuaranteeManifest} from './personal-requirements.js';
import {ReviewConfigManifestSchema, type ReviewConfigManifest} from './review-config.js';

export const GUARANTEE_LABELS:Record<string,string>={corporate_guarantee:'公司担保',personal_guarantee:'个人担保',mortgage:'抵押融资',account_charge:'账户押记',sblc:'备用信用证'};
export const SHARED_FACILITY_TYPE='shared_facility';
export const guaranteeSelectionKey=(types:readonly string[])=>[...types].sort().join('+');

/** Build before validation/publication, never compose mutable releases at execution time. */
export function createMixedGuaranteeManifest(releaseId:string,options:GuaranteeExtractionOptions & {corporateSectionVersion?:'nd2a-sections-v1'|'source-fields-v2';corporateArticlesVersion?:'articles-fields-v1'}={}):ReviewConfigManifest {
  const corporate=createCorporateGuaranteeManifest(releaseId,{corporateRmVersion:options.corporateRmVersion,corporateSectionVersion:options.corporateSectionVersion,corporateExtractionVersion:options.corporateExtractionVersion,corporateGuaranteeVersion:options.corporateGuaranteeVersion,corporateArticlesVersion:options.corporateArticlesVersion}),personal=createPersonalGuaranteeManifest(releaseId);
  return ReviewConfigManifestSchema.parse(applyGuaranteeRoleEvidence(combineGuaranteeManifests(releaseId,corporate,personal),options));
}

/** Prepare a new draft from explicit immutable inputs, retaining environment-specific fields.
 * The combined scope needs its own trial/approval/publication; input approvals are not inherited.
 */
export function combineGuaranteeManifests(releaseId:string,corporateInput:ReviewConfigManifest,personalInput:ReviewConfigManifest):ReviewConfigManifest {
  const corporate=ReviewConfigManifestSchema.parse(corporateInput),personal=ReviewConfigManifestSchema.parse(personalInput);
  if(corporate.guaranteeTypes.join()!=='corporate_guarantee'||personal.guaranteeTypes.join()!=='personal_guarantee')throw new Error('mixed_input_scope_invalid');
  const parameters={...corporate.parameters};
  for(const [name,value]of Object.entries(personal.parameters)){
    if(Object.hasOwn(parameters,name)&&JSON.stringify(parameters[name])!==JSON.stringify(value))throw new Error('mixed_parameter_collision');
    parameters[name]=value;
  }
  if(JSON.stringify(corporate.compatibility)!==JSON.stringify(personal.compatibility))throw new Error('mixed_compatibility_collision');
  const remapType=(id:string)=>['cgt_facility','pg_facility'].includes(id)?SHARED_FACILITY_TYPE:id;
  const sources=[...corporate.sources];
  for(const source of personal.sources){
    const prior=sources.find(s=>s.id===source.id);
    if(!prior){sources.push(source);continue;}
    if(prior.reference!==source.reference||prior.sha256!==source.sha256||prior.guaranteeType!==source.guaranteeType||prior.disposition!==source.disposition||prior.approvalRef!==source.approvalRef)throw new Error('mixed_source_collision');
    prior.reason='来源登记；具体执行范围以本混合配置引用的公司及个人来源条目为准。';
  }
  const facilities=[...corporate.taxonomy,...personal.taxonomy].filter(t=>remapType(t.id)===SHARED_FACILITY_TYPE);
  const date=corporate.fields.find(f=>f.id==='review_business_date'),personalDate=personal.fields.find(f=>f.id==='review_business_date');
  if(!date||!personalDate||date.type!=='date'||personalDate.type!=='date')throw new Error('mixed_business_date_required');
  const {objectRole:_role,...sharedDate}=date;
  const signatures=[...(corporate.signatureRequirements??[]),...(personal.signatureRequirements??[])];
  const signatureTests=[...(corporate.signatureTests??[]),...(personal.signatureTests??[])];
  if(corporate.docxExtraction&&JSON.stringify(corporate.docxExtraction)!==JSON.stringify(personal.docxExtraction))throw new Error('mixed_docx_collision');
  const manifest:ReviewConfigManifest={...corporate,releaseId,scope:'synthetic',bankApprovalRef:null,label:'公司与个人混合担保配置',guaranteeTypes:['corporate_guarantee','personal_guarantee'],sources,parameters,
    taxonomy:[...corporate.taxonomy,...personal.taxonomy].filter(t=>remapType(t.id)!==SHARED_FACILITY_TYPE).concat({
      id:SHARED_FACILITY_TYPE,label:'共用授信函',keywords:[...new Set(facilities.flatMap(t=>t.keywords))],sourceIds:[...new Set(facilities.flatMap(t=>t.sourceIds))],
    }),
    materials:[...corporate.materials,...personal.materials].map(m=>({...m,taxonomyId:remapType(m.taxonomyId)})),
    fields:[...corporate.fields,...personal.fields].filter(f=>f.id!=='review_business_date').map(f=>({...f,taxonomyIds:f.taxonomyIds?.map(remapType)})).concat({
      ...sharedDate,label:'审核基准日',semanticDefinition:'本轮快照固定的审核基准日，由系统提供；所有担保对象使用同一日期，不从其他对象事实借值。',
      taxonomyIds:[SHARED_FACILITY_TYPE],sourceIds:[...new Set([...date.sourceIds,...personalDate.sourceIds])],
    }),
    rules:[...corporate.rules,...personal.rules],docxExtraction:personal.docxExtraction,
    ...(signatures.length?{signatureRequirements:signatures.map(s=>({...s,taxonomyIds:s.taxonomyIds.map(remapType)}))}:{}),
    ...(signatureTests.length?{signatureTests:signatureTests.map(t=>({...t,input:{...t.input,taxonomyIds:t.input.taxonomyIds.map(remapType)}}))}:{}),
  };
  // Composition alone does not opt in; upgrade the final mixed manifest explicitly.
  delete manifest.documentClassification;
  for(const key of ['sources','taxonomy','materials','fields','rules','signatureRequirements','signatureTests'] as const){
    const rows=manifest[key]??[];
    if(new Set(rows.map(row=>row.id)).size!==rows.length)throw new Error(`mixed_${key}_collision`);
  }
  // Normalize optional undefined properties before hashing or JSON transport.
  return ReviewConfigManifestSchema.parse(JSON.parse(JSON.stringify(manifest)));
}
