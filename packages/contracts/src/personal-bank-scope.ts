/** The workbook requires evidence and checks, not a second human yes/no decision
 * for a condition that the evidence can establish. Historical releases remain intact. */
export const PERSONAL_RETIRED_INPUTS=new Set([
 'pg_required','pg_note_required','pg_authorization_required','pg_identity_required',
 'pg_limited','pg_taiwan_law','pg_bank_signed','pg_guarantor_signed','pg_translation_required',
 'pg_identity_confirmed','pg_verified_identity_number',
 'pg_approval_parties','pg_approval_required_amount','pg_approval_conditions',
 ...Array.from({length:17},(_,i)=>`pg_legal_checklist_${i+1}_applicable`),
]);
export const personalLegalItem=(id:string)=>/^pg_legal_(?:intro_[1-6]|checklist_(?:[1-9]|1[0-7]))$/u.test(id);
export const PERSONAL_LEGAL_LABELS:Record<string,string>=Object.fromEntries(['设立与存续','破产及清算查询','公司权能','公司授权','文件适当签署','不违反适用法律','不违反章程','义务有效及可执行','批准与同意','印花税及登记税','备案与登记','担保物权','法律及管辖选择','外国判决承认执行','银行当地经营认定','银行经营许可','司法豁免'].map((label,i)=>[`pg_legal_checklist_${i+1}`,`法律意见：${label}`]));
