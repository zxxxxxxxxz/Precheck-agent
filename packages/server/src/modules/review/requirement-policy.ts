import type {ReviewRequirementPolicy} from '@hsbc/contracts/review-config';

// User suspended customer-supplied Chinese versions. Keep rule definitions and
// comparison code so a future release can restore this requirement here.
export const CHINESE_VERSION_REQUIREMENT_ENABLED:boolean=false;
export const currentRequirementPolicy=():ReviewRequirementPolicy=>({version:'review-requirements-v1',chineseVersionRequired:CHINESE_VERSION_REQUIREMENT_ENABLED,corporatePreReview:'bank-scope-v1',bankWorkbookOnly:true,systemJudgement:'v1'});
export const systemJudgementEnabled=(policy:ReviewRequirementPolicy|undefined)=>policy?.systemJudgement==='v1';
export const corporateBankScope=(policy:ReviewRequirementPolicy|undefined)=>policy?.corporatePreReview==='bank-scope-v1';
export const CORPORATE_PRE_REVIEW_BOUNDARY='公司担保预审：依据银行规则核对材料、字段、签署存在和授权组合，不鉴定笔迹或签名真伪。保留原规则允许的客户经理确认／澄清方式，不强制转换为证明文件或独立审批附件。RM 模板的 DATED 对应保证书签署日期，不新增独立出具日期必填项；文书实际引用日期冲突仍须列明。仅将当前未满足的明确生效条件列为待办；后续变更、启用事项及一般法律保留单列提示，不要求预审时一概完成。缺少银行内部律所参考资料向银行内部提出，系统尚未完成的核对不作为客户待办。';
export function translationRequirementDisabled(id:string,policy:ReviewRequirementPolicy|undefined):boolean{
 if(policy?.version!=='review-requirements-v1'||policy.chineseVersionRequired)return false;
 return ['cgt_translation','pg_translation','cgt_translation_required','pg_translation_required','cgt_translation_review','pg_translation_review'].includes(id);
}

/** Project explicit customer action lists only. Original evidence, opinions,
 * recorded judgments and already generated mail remain unchanged. */
export function projectRequirementAction(text:string,policy:ReviewRequirementPolicy|undefined):string{
 if(!translationRequirementDisabled('cgt_translation_review',policy))return text;
 const item='(?:公司保证书|保证书|公司章程|章程|董事会决议|RM ?证明|文件|材料)?(?:的)?(?:完整|对应|相应)?中文(?:译本|版本)';
 return text.split('\n').map(line=>{
  if(!/^请(?:定位或补充|提供|补充|补交)/u.test(line))return line;
  // Remove a standalone list item, not a quote, conditional, negation or the
  // remaining identity/address/approval requests sharing the same sentence.
  return line.replace(new RegExp(`[，、,]${item}(?=[，、,。；;]|$)`,'gu'),'');
 }).join('\n');
}

/** New runs omit the extra unconditional witness requirement; historical snapshots retain their rule set. */
export const extraBankRequirementDisabled=(id:string,policy:ReviewRequirementPolicy|undefined)=>policy?.bankWorkbookOnly===true&&id==='cgt_witness_signature';
