import type {CrossFileCheck,CrossFileValue} from './review-checklist.js';

const roles = {
  'corporate-bank': {label: '贷款人（银行）', names: ['贷款人', '貸款人', '贷款银行', 'Lender', 'Lending Bank']},
  'personal-bank': {label: '贷款人（银行）', names: ['贷款人', '貸款人', '贷款银行', 'Lender', 'Lending Bank']},
  'personal-borrower': {label: '借款人', names: ['借款人', '主债务人', '主債務人', 'Borrower', 'Principal Debtor']},
  'corporate-borrower': {label: '借款人', names: ['借款人', 'Borrower']},
  'corporate-guarantor': {label: '担保公司', names: ['担保人', '擔保人', '保证人', '保證人', '担保公司', 'Guarantor']},
  'personal-guarantor': {label: '个人担保人', names: ['担保人', '擔保人', '保证人', '保證人', 'Guarantor']},
} as const;
const key = (value: string) => value.normalize('NFKC').replace(/\s+/gu, '').toLowerCase();
const roleLabels = [...new Set(Object.values(roles).flatMap(role => [...role.names])), '债务人', '債務人', '担保安排', '擔保安排', '住所', '地址', 'Debtor', 'Address'];
const labels = new RegExp(`(?:^|[\\s;；。])(${roleLabels.join('|')})\\s*[:：]\\s*`, 'giu');

/** A reading projection only: never changes stored candidates, facts or outcomes.
 * Legacy compound fields need explicit labels and a bounded name, not a nearby
 * bank/company keyword. Unsupported prose stays available in the full extract. */
export function crossFileSourceReading(check: CrossFileCheck, source: CrossFileValue) {
  const bankRole = check.bankRule?.row===4?'personal-bank':check.bankRule?.row===5?'personal-guarantor':check.bankRule?.row===6?'personal-borrower':undefined;
  const role = bankRole?roles[bankRole]:Object.entries(roles).find(([id]) => check.id.endsWith(`:${id}`))?.[1];
  if (!role || !source.documentId || !['cgt_facility_parties', 'pg_facility_parties'].includes(source.fieldId)) {
    return {label: source.label, values: source.values, focused: false};
  }
  if(bankRole==='personal-borrower'&&source.resolvedQuality&&source.personalWorkbookReading?.kind==='borrower')return {label:role.label,values:source.values,focused:true};
  if(bankRole==='personal-bank'&&source.resolvedQuality&&source.personalNameReading?.kind==='bank')return {label:role.label,values:source.values,focused:true};
  const values: string[] = [];
  // Bank rows now have directional IDs rather than the legacy role-group ID.
  // Read explicitly labelled lines only; never substitute unlabelled prose.
  const passages=bankRole?source.values.flatMap(value=>value.split(/\n+/u)):source.values;
  for (const raw of passages) {
    const markers = [...raw.matchAll(labels)];
    if (!markers.length || raw.slice(0, markers[0]!.index).trim() || /(?:如果|除非|非贷款人|非借款人)|\b(?:unless|if|not|may|formerly)\b/iu.test(raw)) continue;
    for (const [index, marker] of markers.entries()) {
      if (!role.names.some(name => key(name) === key(marker[1]!))) continue;
      const value = raw.slice(marker.index! + marker[0].length, markers[index + 1]?.index ?? raw.length)
        .replace(/^[\s;；]+|[\s;；。]+$/gu, '').replace(/\s+/gu, ' ');
      // Decline clauses, definitions, conditions and unbounded OCR fragments.
      if (!value || value.length > 240 || /[。；;:：\n]|(?:提供|出具|落中|各人|任何|如果|除非|应当|應當|系指)|\b(?:means|shall|provided|unless|if|not|may|formerly|includes)\b/iu.test(value)) continue;
      const balanced = (value.match(/[（(]/gu)?.length ?? 0) === (value.match(/[）)]/gu)?.length ?? 0);
      if (!balanced) continue;
      if (!values.some(existing => key(existing) === key(value))) values.push(value);
    }
  }
  // OCR may concatenate two copies inside one labelled segment. Collapse only
  // when another independently labelled segment supplies the entire base name.
  const distinct = values.filter(value => !values.some(base => {
    const whole = key(value), part = key(base);
    return whole !== part && whole.length > part.length && whole.length % part.length === 0 &&
      part.repeat(whole.length / part.length) === whole;
  }));
  return {label: role.label, values: distinct, focused: true};
}
