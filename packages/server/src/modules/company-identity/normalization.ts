import { createHash } from 'node:crypto';
import type { CompanyNormalizedName } from '@hsbc/contracts/company-identity';

export const COMPANY_NAME_VERSION = 'company-name-v1';
const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
/** Comparison only: never removes word boundaries, legal suffixes, accents or punctuation. */
export function normalizeCompanyName(rawName: string): CompanyNormalizedName {
  const composed = rawName.normalize('NFC');
  const normalizedName = composed.trim().replace(/[\s\p{Z}]+/gu, ' ');
  const comparisonKey = normalizedName.toLowerCase();
  const differenceTypes: CompanyNormalizedName['differenceTypes'] = [];
  if (rawName !== composed) differenceTypes.push('unicode_composition');
  if (composed !== normalizedName) differenceTypes.push('whitespace');
  if (normalizedName !== comparisonKey) differenceTypes.push('case');
  return { rawName, normalizedName, comparisonKey, version: COMPANY_NAME_VERSION, differenceTypes };
}
export interface CompanyNameAssociation {
  version: string; groupId: string; basis: 'source_bilingual_pair' | 'scoped_identifier' | 'format_equivalent';
  names: string[]; evidenceAnchorIds: string[]; identityConfirmed: false;
  sourceNames?: Array<{name:string;anchorIds:string[];pageNumbers:number[]}>;
}
export interface NameCandidate {
  rawValue: string; anchorIds: string[]; pageNumbers: number[];
  contextText?: string; contextAnchorIds?: string[];
  nameAssociation?: CompanyNameAssociation;
}
/** Private source reader supplies these only after checking an immutable cell.
 * They group spellings for display and never establish a legal entity fact. */
export interface CompanyNamePairEvidence {
  names: [string, string];
  evidenceAnchorIds: string[];
  materialPageNumbers: number[];
  basis?: 'scoped_identifier';
  scopedIdentifier?: string;
}
export interface CompanyNameIdentifierEvidence {
  name: string; key: string; evidenceAnchorIds: string[]; materialPageNumbers: number[];
}
const unique = <T>(values: T[]) => [...new Set(values)];
function identifier(candidate: NameCandidate): string | undefined {
  const context = candidate.contextText ?? '', at = context.indexOf(candidate.rawValue);
  if (at < 0) return;
  const text = context.slice(at + candidate.rawValue.length, at + candidate.rawValue.length + 200);
  const lei = /^[\s,，(（]*LEI\s*[:：]\s*([A-Z0-9]{18}[0-9]{2})(?![A-Z0-9])/u.exec(text);
  if (lei) return `lei:${lei[1]}`;
  // Registration numbers without their authority/jurisdiction are NOT global identifiers.
  const authority = /^[\s,，(（]*(?:Registration\s*(?:No\.?|Number)?\s*[:：]?\s*)?(RA[0-9]{6})\s*[:/]\s*([A-Z0-9][A-Z0-9-]{3,60})(?![A-Z0-9-])/iu.exec(text);
  return authority ? `registration:${authority[1]}:${authority[2]}` : undefined;
}
function bilingualPair(a: NameCandidate, b: NameCandidate): boolean {
  const han = (v: string) => /\p{Script=Han}/u.test(v);
  if (han(a.rawValue) === han(b.rawValue) || !/[A-Za-z]/u.test(han(a.rawValue) ? b.rawValue : a.rawValue)) return false;
  // Both names must occur in the same quoted clause and have real shared source anchors.
  const shared = (a.contextAnchorIds ?? []).some(id => (b.contextAnchorIds ?? []).includes(id));
  if (!shared) return false;
  for (const text of [a.contextText, b.contextText]) {
    if (!text) continue;
    const x = text.indexOf(a.rawValue), y = text.indexOf(b.rawValue);
    if (x < 0 || y < 0) continue;
    const first = x < y ? a.rawValue : b.rawValue, second = x < y ? b.rawValue : a.rawValue;
    const between = text.slice(Math.min(x, y) + first.length, Math.max(x, y));
    const tail = text.slice(Math.max(x, y) + second.length, Math.max(x, y) + second.length + 3);
    // Parenthesized bilingual names or explicitly labelled language equivalents.
    // A newline alone may be an unrelated company list, even in a shared quote.
    if (/^\s*[(（]\s*$/u.test(between) && /^\s*[)）]/u.test(tail)) return true;
    const prefix = text.slice(Math.max(0, Math.min(x, y) - 30), Math.min(x, y));
    const firstChinese = han(first);
    if (firstChinese && /(?:中文名称|中文名稱)\s*[:：]\s*$/u.test(prefix) &&
      /^\s*[,;，；\n]?\s*(?:英文名称|英文名稱|English\s+name)\s*[:：]\s*$/iu.test(between)) return true;
    if (!firstChinese && /English\s+name\s*[:：]\s*$/iu.test(prefix) &&
      /^\s*[,;，；\n]?\s*(?:中文名称|中文名稱)\s*[:：]\s*$/u.test(between)) return true;
  }
  return false;
}
/** Source-grounded display groups only; candidates and business identity facts remain separate. */
export function annotateCompanyCandidates<T extends NameCandidate>(originals: T[], sourcePairs: CompanyNamePairEvidence[] = [],
  sourceIdentifiers: CompanyNameIdentifierEvidence[] = []): Array<T & Pick<NameCandidate, 'nameAssociation'>> {
  // Completion can supply a contradictory registration or remove applicable
  // source proof. Recompute this view; never retain an earlier union by accident.
  const candidates = originals.map(candidate => { const copy = {...candidate}; delete copy.nameAssociation; return copy; });
  const parents = candidates.map((_, index) => index), bases = new Map<number, CompanyNameAssociation['basis']>();
  const supportingPairs: Array<{ indices: [number, number]; anchorIds: string[] }> = [];
  const bilingualEdges = new Set<string>(), counterparts = new Map<string, Set<string>>();
  const applies = (pair: CompanyNamePairEvidence, candidate: NameCandidate) => pair.evidenceAnchorIds.length > 0 &&
    pair.names.includes(candidate.rawValue) && candidate.pageNumbers.length > 0 &&
    candidate.pageNumbers.every(page => pair.materialPageNumbers.includes(page));
  const identifiers = (candidate: NameCandidate) => unique([
    ...[identifier(candidate)].filter((key): key is string => !!key),
    ...sourcePairs.filter(pair => applies(pair, candidate) && pair.basis === 'scoped_identifier' && pair.scopedIdentifier)
      .map(pair => pair.scopedIdentifier!),
    ...sourceIdentifiers.filter(proof => proof.name === candidate.rawValue && proof.evidenceAnchorIds.length > 0 &&
      candidate.pageNumbers.length > 0 && candidate.pageNumbers.every(page => proof.materialPageNumbers.includes(page))).map(proof => proof.key),
  ]);
  for (let i = 0; i < candidates.length; i++) for (let j = i + 1; j < candidates.length; j++) {
    const a = candidates[i]!, b = candidates[j]!;
    const proof = sourcePairs.some(pair => pair.evidenceAnchorIds.length && pair.names.includes(a.rawValue) && pair.names.includes(b.rawValue) &&
      a.rawValue !== b.rawValue && [a, b].every(candidate => candidate.pageNumbers.length && candidate.pageNumbers.every(page => pair.materialPageNumbers.includes(page))));
    if (!bilingualPair(a, b) && !proof) continue;
    bilingualEdges.add(`${i}:${j}`);
    for (const [name, other] of [[a.rawValue, b.rawValue], [b.rawValue, a.rawValue]]) {
      const key = normalizeCompanyName(name!).comparisonKey, values = counterparts.get(key) ?? new Set<string>();
      values.add(normalizeCompanyName(other!).comparisonKey); counterparts.set(key, values);
    }
  }
  const root = (index: number): number => parents[index] === index ? index : (parents[index] = root(parents[index]!));
  for (let i = 0; i < candidates.length; i++) for (let j = i + 1; j < candidates.length; j++) {
    const a = candidates[i]!, b = candidates[j]!, ai = identifiers(a), bi = identifiers(b);
    const branch = (candidate: NameCandidate) => /\bbranch\b|分行|支行|分公司/iu.test(candidate.rawValue);
    const sameFormat = normalizeCompanyName(a.rawValue).comparisonKey === normalizeCompanyName(b.rawValue).comparisonKey &&
      a.anchorIds.some(id => b.anchorIds.includes(id));
    // A branch may share its parent's registration identifier. Only an explicit
    // bilingual source or the same located spelling can associate branch names.
    if (branch(a) !== branch(b) || branch(a) && !bilingualEdges.has(`${i}:${j}`) && !sameFormat) continue;
    // A spelling or a bilingual cell may not bridge conflicting source
    // registration scopes, including conflicts introduced by a third alias.
    if (ai.length > 1 || bi.length > 1 || ai.length && bi.length && ai[0] !== bi[0]) continue;
    let basis: CompanyNameAssociation['basis'] | undefined;
    if (ai.length === 1 && ai[0] === bi[0]) basis = 'scoped_identifier';
    const proofs = sourcePairs.filter(pair => pair.evidenceAnchorIds.length && pair.names.includes(a.rawValue) && pair.names.includes(b.rawValue) &&
      a.rawValue !== b.rawValue && [a, b].every(candidate => candidate.pageNumbers.length && candidate.pageNumbers.every(page => pair.materialPageNumbers.includes(page))));
    if (!basis && bilingualEdges.has(`${i}:${j}`) && [a, b].every(candidate => counterparts.get(normalizeCompanyName(candidate.rawValue).comparisonKey)?.size === 1)) basis = 'source_bilingual_pair';
    if (!basis && sameFormat) basis = 'format_equivalent';
    if (basis) {
      const x = root(i), y = root(j);
      // A third alias cannot bridge two independently identified companies.
      const keys = unique(candidates.flatMap((candidate, index) => root(index) === x || root(index) === y ? identifiers(candidate) : []));
      if (keys.length > 1) continue;
      if (x !== y) parents[y] = x;
      bases.set(x, basis);
      if (proofs.length) supportingPairs.push({ indices: [i, j], anchorIds: proofs.flatMap(proof => proof.evidenceAnchorIds) });
    }
  }
  const groups = new Map<number, number[]>();
  candidates.forEach((_, index) => { const key = root(index); groups.set(key, [...groups.get(key) ?? [], index]); });
  return candidates.map((candidate, index) => {
    const key = root(index), group = groups.get(key)!;
    if (group.length < 2) return candidate;
    const members = group.map(i => candidates[i]!), names = unique(members.map(item => item.rawValue));
    const evidenceAnchorIds = unique([...members.flatMap(item => [...item.anchorIds, ...item.contextAnchorIds ?? []]),
      ...supportingPairs.filter(pair => pair.indices.every(i => root(i) === key)).flatMap(pair => pair.anchorIds)]).sort();
    return { ...candidate, nameAssociation: { version: COMPANY_NAME_VERSION,
      groupId: `company-name:${digest({ names: [...names].sort(), evidenceAnchorIds })}`,
      basis: bases.get(key) ?? 'source_bilingual_pair', names, evidenceAnchorIds, identityConfirmed: false } };
  });
}

/** Explicit opt-in after model completion decisions. The source reader proves a
 * complete, bounded signing subject record; ordinary name normalization and
 * historical model-call identities remain unchanged. */
export interface CompanySigningRecord {
  candidateIndexes:number[];
  names:[string,string];
  sourceNames:Array<{name:string;anchorIds:string[];pageNumbers:number[]}>;
  evidenceAnchorIds:string[];
  materialPageNumbers:number[];
}
export function associateCompanySigningRecords<T extends NameCandidate>(originals:T[],records:CompanySigningRecord[],
  sourceIdentifiers:CompanyNameIdentifierEvidence[]=[]):T[] {
  const candidates=originals.map(candidate=>{if(candidate.nameAssociation?.version!=='company-signing-subject-v1')return candidate;const copy={...candidate};delete copy.nameAssociation;return copy;});
  const key=(name:string)=>normalizeCompanyName(name).comparisonKey;
  const branch=(name:string)=>/\bbranch\b|branch$|分行|支行|分公司/iu.test(name.normalize('NFKC'));
  const admissible=records.filter(record=>record.names.length===2&&record.names[0]!==record.names[1]&&
    branch(record.names[0])===branch(record.names[1])&&record.evidenceAnchorIds.length&&record.sourceNames.length===2&&new Set(record.sourceNames.map(source=>source.name)).size===2&&
    record.sourceNames.every(source=>record.names.includes(source.name)&&source.anchorIds.length&&source.pageNumbers.length&&
      source.anchorIds.every(id=>record.evidenceAnchorIds.includes(id))&&source.pageNumbers.every(page=>record.materialPageNumbers.includes(page)))&&
    record.candidateIndexes.length>=2&&record.candidateIndexes.every(index=>Number.isSafeInteger(index)&&index>=0&&index<candidates.length&&
      candidates[index]!.pageNumbers.length&&candidates[index]!.pageNumbers.every(page=>record.materialPageNumbers.includes(page))));
  const counterparts=new Map<string,Set<string>>();
  for(const record of admissible)for(const [name,other] of [[record.names[0],record.names[1]],[record.names[1],record.names[0]]]){
    const values=counterparts.get(key(name!))??new Set<string>();values.add(key(other!));counterparts.set(key(name!),values);
  }
  const groups=new Map<string,CompanySigningRecord[]>();
  for(const record of admissible){
    if(record.names.some(name=>counterparts.get(key(name))?.size!==1))continue;
    const id=JSON.stringify(record.names.map(key).sort());groups.set(id,[...(groups.get(id)??[]),record]);
  }
  const output=[...candidates];
  const memberships=new Map<number,Set<string>>();
  for(const [id,group] of groups)for(const index of group.flatMap(record=>record.candidateIndexes)){
    const values=memberships.get(index)??new Set<string>();values.add(id);memberships.set(index,values);
  }
  for(const group of groups.values()){
    const indices=unique(group.flatMap(record=>record.candidateIndexes));
    if(indices.some(index=>memberships.get(index)?.size!==1))continue;
    const names=group[0]!.names;
    const identifiers=unique([
      ...indices.flatMap(index=>{const value=identifier(candidates[index]!);return value?[value]:[];}),
      ...sourceIdentifiers.filter(proof=>proof.evidenceAnchorIds.length&&
        [...names,...indices.map(index=>candidates[index]!.rawValue)].some(name=>key(name)===key(proof.name))).map(proof=>proof.key),
    ]);
    if(identifiers.length>1)continue;
    const sourceNames=names.map(name=>({name,
      anchorIds:unique(group.flatMap(record=>record.sourceNames.filter(source=>source.name===name).flatMap(source=>source.anchorIds))),
      pageNumbers:unique(group.flatMap(record=>record.sourceNames.filter(source=>source.name===name).flatMap(source=>source.pageNumbers))).sort((a,b)=>a-b),
    }));
    if(sourceNames.some(source=>!source.anchorIds.length))continue;
    const evidenceAnchorIds=unique([...group.flatMap(record=>record.evidenceAnchorIds),
      ...indices.flatMap(index=>[...candidates[index]!.anchorIds,...candidates[index]!.contextAnchorIds??[]])]).sort();
    const association:CompanyNameAssociation={version:'company-signing-subject-v1',
      groupId:`company-name:${digest({names,sourceNames,evidenceAnchorIds})}`,basis:'source_bilingual_pair',
      names:[...names],sourceNames,evidenceAnchorIds,identityConfirmed:false};
    for(const index of indices)output[index]={...candidates[index]!,nameAssociation:association};
  }
  return output;
}
