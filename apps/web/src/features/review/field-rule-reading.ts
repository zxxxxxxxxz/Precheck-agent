import type {ChecklistRow} from '@hsbc/contracts/review-checklist';
import {CORPORATE_RULE_ROWS} from '@hsbc/contracts/corporate-requirements';
import {PERSONAL_RULE_ROWS} from '@hsbc/contracts/personal-requirements';
import {fieldBusinessRules} from './field-comparison.ts';

/** Split only an exact published wording match; edited and historical rules stay intact. */
export function fieldRuleReading(row:ChecklistRow) {
  const rules=fieldBusinessRules(row);
  const bank=rules.filter(rule=>/^(?:cgt|pg)_bank_\d+$/.test(rule.id));
  const primary=bank.length?bank:rules;
  const requirements:string[]=[],exceptions:string[]=[];
  for(const rule of primary){
    const original=rule.id.startsWith('pg_')?PERSONAL_RULE_ROWS.find(source=>rule.id===`pg_bank_${source.row}`):CORPORATE_RULE_ROWS.find(source=>rule.id===`cgt_bank_${source.row}`);
    if(original&&rule.text.trim()===`${original.requirement} ${original.notice}`.trim()){
      if(original.requirement.trim())requirements.push(original.requirement);
      if(original.notice.trim())exceptions.push(original.notice);
    }else requirements.push(rule.text);
  }
  if(!rules.length&&row.definition)requirements.push(row.definition);
  return {requirements:[...new Set(requirements)],exceptions:[...new Set(exceptions)],
    supplementary:bank.length?rules.filter(rule=>!bank.includes(rule)):[]};
}
