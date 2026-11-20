import {CASE_CURRENCIES, CASE_JURISDICTIONS, type IntakeField} from '@hsbc/contracts/draft';
import {intakeFieldValue} from '@hsbc/contracts/intake';

const guaranteeTerms: Record<string, string[]> = {
  corporate_guarantee: ['公司担保', '公司保证', '公司擔保', '公司保證', 'corporate guarantee', 'corporate_guarantee'],
  personal_guarantee: ['个人担保', '个人保证', '個人擔保', '個人保證', 'personal guarantee', 'personal_guarantee'],
  mortgage: ['抵押融资', '抵押融資', 'mortgage'],
  account_charge: ['账户押记', '賬戶押記', '帐户押记', 'account charge', 'account_charge'],
  sblc: ['备用信用证', '備用信用證', 'standby letter of credit', 'stand-by letter of credit', 'sblc'],
};
const jurisdictionTerms: Record<string, string[]> = {
  CN: ['中国内地', '中国大陆', '中华人民共和国', '中国法律', '中国法', 'mainland china', 'prc'],
  HK: ['香港', 'hong kong'], MO: ['澳门', '澳門', 'macao', 'macau'], TW: ['台湾', '台灣', 'taiwan'],
  SG: ['新加坡', 'singapore'], GB: ['英国', '英國', '英格兰', '英格蘭', 'united kingdom', 'england'],
  US: ['美国', '美國', 'united states'], AU: ['澳大利亚', '澳洲', 'australia'], CA: ['加拿大', 'canada'],
  NZ: ['新西兰', '紐西蘭', 'new zealand'], JP: ['日本', 'japan'], KR: ['韩国', '韓國', 'korea'],
  DE: ['德国', '德國', 'germany'], FR: ['法国', '法國', 'france'], CH: ['瑞士', 'switzerland'],
  VG: ['英属维尔京', '英屬維爾京', 'british virgin islands', 'bvi'], KY: ['开曼', '開曼', 'cayman'], BM: ['百慕大', 'bermuda'],
};
function contains(source: string, term: string) {
  return /^[a-z_ ]+$/i.test(term) ? new RegExp(`(?:^|[^a-z])${term.replaceAll(' ', '\\s+')}(?:$|[^a-z])`, 'i').test(source) : source.includes(term);
}
/** Canonical option codes still need evidence; a valid enum alone is not a fact. */
export function hasIntakeFormEvidence(field: IntakeField, value: string, source: string): boolean {
  if (field === 'guaranteeTypes') {
    const types = intakeFieldValue(field, value) as string[];
    return types.length > 0 && types.every(type => guaranteeTerms[type]?.some(term => contains(source, term)));
  }
  if (field === 'jurisdiction') return CASE_JURISDICTIONS.some(option => option.value === value) &&
    [value, ...jurisdictionTerms[value] ?? []].some(term => contains(source, term));
  if (field === 'guaranteeCurrency') {
    const option = CASE_CURRENCIES.find(option => option.value === value);
    return !!option && [value, option.label.split(' ')[1]!, ...(value === 'USD' ? ['美元', '美金', 'US dollars'] : [])].some(term => contains(source, term));
  }
  return true;
}
