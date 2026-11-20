import type {SignatureEntry, SignatureInformationCandidate, SignatureInformationCheck, SignatureInformationProjection, SignatureInformationState} from '@hsbc/contracts/signature-information';

export type SignatureEditor = 'locations' | 'authorizations' | 'dates' | 'requirements' | 'dateRules';
export const signatureEditorLabels: Record<SignatureEditor, string> = {
  locations: '人员与签署证据', authorizations: '授权依据', dates: '日期与用途', requirements: '签署要求', dateRules: '日期规则',
};
export type SignaturePersonRow = {id: string; name: string; aliases: string[]; candidates: SignatureInformationCandidate[]; entries: SignatureEntry[]};

/** Only an adopted business identity or an explicitly confirmed entry can join a person row. */
export function signaturePersonRows(data: Pick<SignatureInformationProjection, 'objects' | 'candidates'>, state: SignatureInformationState): SignaturePersonRow[] {
  const rows = new Map<string, SignaturePersonRow>();
  const person = (id: string | null) => data.objects.find(o => o.objectId === id && o.validity === 'current');
  for (const candidate of data.candidates.filter(c => c.kind === 'person')) {
    const object = candidate.origin === 'adopted_fact' ? person(candidate.objectId) : undefined;
    const id = object ? `person:${object.objectId}` : `candidate:${candidate.id}`;
    const row = rows.get(id) ?? {id, name: object?.label ?? candidate.value ?? '姓名待核对', aliases: [], candidates: [], entries: []};
    if (candidate.value && candidate.value !== row.name && !row.aliases.includes(candidate.value)) row.aliases.push(candidate.value);
    row.candidates.push(candidate);
    rows.set(id, row);
  }
  for (const entry of state.entries) {
    const object = person(entry.personId);
    const id = object && entry.status === 'confirmed' && entry.identityConfirmed ? `person:${object.objectId}` : `entry:${entry.id}`;
    const row = rows.get(id) ?? {id, name: entry.kind === 'stamp' ? person(entry.subjectId)?.label ?? '印章主体待核对' : object?.label ?? '签署人员待核对', aliases: [], candidates: [], entries: []};
    row.entries.push(entry);
    rows.set(id, row);
  }
  return [...rows.values()];
}

export function signatureCheckEditor(check: SignatureInformationCheck): SignatureEditor {
  if (check.id.startsWith('date-record:')) return 'dates';
  if (check.reasons.some(r => r.startsWith('authorization') || r.startsWith('authorized_'))) return 'authorizations';
  if (check.id.startsWith('date:') || check.reasons.some(r => r.startsWith('date_') || r.startsWith('required_date'))) return 'dateRules';
  if (check.reasons.some(r => r.includes('requirement') || r === 'combination_unconfirmed')) return 'requirements';
  return 'locations';
}
