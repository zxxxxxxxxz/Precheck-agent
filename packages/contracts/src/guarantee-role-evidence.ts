import type {ReviewConfigManifest,ReviewFieldDefinition} from './review-config.js';

export interface GuaranteeExtractionOptions {corporateRmVersion?:'rm-parties-v1'|'rm-source-v2';corporateGuaranteeVersion?:'bank-amount-v1';corporateExtractionVersion?:'source-fields-v2';roleEvidenceVersion?:'source-role-v1'|'source-role-v2'}
type Policy=NonNullable<ReviewFieldDefinition['roleEvidence']>;
const generic=['Full name','Full Name (in Block Letters)','Name','Name (in Block Letters)','全名','姓名'];
const signer=['Director','Secretary','Director / Secretary','Director/Secretary','Authorised Signatory','Authorized Signatory','董事','秘書','秘书','授權簽字人','授权签字人'];
const witness=['Witness','Witnessed by','Witness by','見證人','见证人'];
const parties=['Details of Customer','Details of Guarantor','Name of Process Agent','客戶資料','客户资料','擔保人資料','担保人资料','送達代理人','送达代理人'];
const policy=(role:string,labels:string[],headings:string[]=[],otherHeadings:string[]=[],genericLabels:string[]=[],declarationTerms:string[]=labels):Policy=>
 ({version:'source-role-v1',role,labels,genericLabels,headings,otherHeadings,declarationTerms});
const bank=policy('lender',['Bank','Lender','Lending Bank','贷款银行','貸款銀行','授信银行','授信銀行','银行名称','銀行名稱','银行','銀行'],[],
 [...parties,'Account Bank','Correspondent Bank','Previous Bank','Other Bank','Beneficiary Bank','Receiving Bank','Issuing Bank','Advising Bank','开户银行','開戶銀行','往来银行','往來銀行','收款银行','收款銀行','通知银行','通知銀行'],[],['Bank','Lender','贷款银行','貸款銀行','授信银行','授信銀行']);
const signerName=policy('signatory',['Name of Director','Director Name','Name of Secretary','Signatory Name','董事姓名','秘書姓名','秘书姓名','簽署人姓名','签署人姓名'],signer,[...witness,...parties],generic);
const witnessName=policy('witness',['Witness Name','Name of Witness','Witness Full Name','见证人全名','見證人全名','见证人姓名','見證人姓名'],witness,[...signer,...parties],generic);
const directorNames=policy('registered_officer',['Name of Director','Director Name','Name of Secretary','董事姓名','秘書姓名','秘书姓名'],
 ['Directors','Director','Company Secretary','Secretary','Particulars of Directors','Particulars of Company Secretary','董事資料','董事资料','秘書資料','秘书资料'],
 ['Shareholders','Members','Presenter','公司名稱','公司名称','Company Name','Registered Office'],['English Name','Name in English','Chinese Name','Name in Chinese','中文姓名','英文姓名','中文/英文姓名',...generic]);
const officerLanguage=(language:'Chinese'|'English'):Policy=>{
 const labels=language==='Chinese'?['Director Chinese Name','Chinese Name of Director','董事中文姓名','秘書中文姓名','秘书中文姓名']:['Director English Name','English Name of Director','董事英文姓名','秘書英文姓名','秘书英文姓名'];
 return {...directorNames,labels,declarationTerms:labels,genericLabels:language==='Chinese'?['Chinese Name','Name in Chinese','中文姓名']:['English Name','Name in English','英文姓名']};
};
const policies:Record<string,Policy>={
 cgt_field_4:bank,cgt_field_16:signerName,cgt_field_21:witnessName,cgt_field_26:bank,
 cgt_field_29:policy('authorized_signatory',['Authorized Signatory','Authorised Signatory','Authorised Signatories','Authorized Signatories','授权签字人','授權簽字人','被授权人','被授權人'],['Authorised Signatories','Authorized Signatories','授权签字人','授權簽字人'],['Attendees','Directors Present','Witness','出席董事','见证人'],generic),
 cgt_field_32:policy('parent_company',['Parent Company','Parent','母公司']),
 cgt_field_34:policy('subsidiary',['Subsidiary','Subsidiary Company','子公司']),
 cgt_field_35:policy('bank_entity',['HSBC Entity','HSBC Bank Entity','汇丰实体','匯豐實體']),
 cgt_field_37:policy('relationship_manager',['Relationship Manager Name','Name of Relationship Manager','Relationship Manager','RM Name','客户经理名称','客戶經理名稱','客户经理姓名','客戶經理姓名']),
 cgt_field_46:directorNames,cgt_field_53:officerLanguage('Chinese'),cgt_field_54:officerLanguage('English'),cgt_field_58:directorNames,
 pg_field_21:policy('payee',['Payee','Pay to the order of','Unconditionally pay to','无条件向','無條件向','收款人','银行名称','銀行名稱'],[],['Maker','Drawer','Endorser','發票人','发票人','背书人','背書人']),
 pg_field_26:bank,
};

// In a resolution a company declaration, facility paragraph or name table may
// have no qualified field label. V2 retains a grounded model proposal for human
// role confirmation; it does not certify the role from a bare name.
const resolutionPolicies:Record<string,Policy>={
 cgt_field_24:policy('guarantor',['Guarantor','Guarantor Name','Name of Guarantor','担保人名称'],['Details of Guarantor'],['Details of Customer','Borrower','Customer'],['Company Name','Name of Company']),
 cgt_field_26:bank,
 cgt_field_27:policy('borrower',['Borrower','Customer','Customer Name','Name of Customer','Borrower Name','客户名称','借款人名称'],['Details of Customer'],['Details of Guarantor','Guarantor']),
 cgt_field_29:{...policies.cgt_field_29!,otherHeadings:[...policies.cgt_field_29!.otherHeadings,'Present','Secretary','Former Director']},
};

/** Only a newly built configuration opts in. No historical manifest is mutated. */
export function applyGuaranteeRoleEvidence(manifest:ReviewConfigManifest,options:GuaranteeExtractionOptions):ReviewConfigManifest {
 if(!options.roleEvidenceVersion)return manifest;
 return {...manifest,fields:manifest.fields.map(field=>{
  if(['rm_guarantor','rm_guaranteed_company','rm_bank_entity','rm_relationship_manager'].includes(field.roleEvidence?.role??''))return field;
  const roleEvidence=options.roleEvidenceVersion==='source-role-v2'
   ?(resolutionPolicies[field.id]?{...resolutionPolicies[field.id]!,version:'source-role-v2' as const}:undefined)
   :policies[field.id];if(!roleEvidence)return field;
  return {...field,aliases:[...new Set([...roleEvidence.labels,...roleEvidence.genericLabels])],roleEvidence:structuredClone(roleEvidence)};
 })};
}
