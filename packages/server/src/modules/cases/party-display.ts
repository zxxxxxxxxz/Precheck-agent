/** List-only name reconciliation. Never writes identities or adopts a fact. */
export interface PartyDisplayCandidate {
  value: string;
  confidence?: number | null;
  /** Only a known object or a single-valued observation establishes alternatives. */
  choiceKey?: string;
  aliases?: string[];
}

const key = (value: string) => value.normalize('NFKC').trim().replace(/\s+/gu, ' ').toLowerCase();
type Parts = {en?: string; zh?: string};
function parts(value: string): Parts {
  const normalized = key(value);
  // A complete English company name followed by its Chinese name (or reverse).
  // Do not remove legal suffixes or match a company by a substring of its name.
  const en = '[a-z0-9][a-z0-9 &.,’\'()/-]*\\b(?:limited|ltd\\.?|inc\\.?|corporation|llc|plc)';
  const zh = '[\\p{Script=Han}0-9（）()·\\s]+公司';
  const forward = normalized.match(new RegExp(`^(${en})\\s*(?:[/（(]\\s*)?(${zh})[）)]?$`, 'u'));
  const reverse = normalized.match(new RegExp(`^(${zh})\\s*(?:[/（(]\\s*)?(${en})[）)]?$`, 'u'));
  if (forward) return {en: key(forward[1]!), zh: key(forward[2]!)};
  if (reverse) return {en: key(reverse[2]!), zh: key(reverse[1]!)};
  if (!/\p{Script=Han}/u.test(normalized)) return {en: normalized};
  if (!/[a-z]/u.test(normalized)) return {zh: normalized};
  return {};
}
function equivalent(a: PartyDisplayCandidate, b: PartyDisplayCandidate) {
  if (key(a.value) === key(b.value)) return true;
  const x = parts(a.value), y = parts(b.value);
  if (x.en && y.en && x.en !== y.en || x.zh && y.zh && x.zh !== y.zh) return false;
  if (x.en && x.en === y.en || x.zh && x.zh === y.zh) return true;
  // These aliases are supplied only from a source-backed semantic receipt.
  return a.aliases?.some(value => key(value) === key(b.value)) || b.aliases?.some(value => key(value) === key(a.value)) || false;
}
function conflicting(a: PartyDisplayCandidate, b: PartyDisplayCandidate) {
  if (a.choiceKey?.startsWith('object:') && b.choiceKey?.startsWith('object:') && a.choiceKey !== b.choiceKey) return true;
  const x = parts(a.value), y = parts(b.value);
  return !!(x.en && y.en && x.en !== y.en || x.zh && y.zh && x.zh !== y.zh);
}
function score(candidate: PartyDisplayCandidate) {
  return typeof candidate.confidence === 'number' && Number.isFinite(candidate.confidence) && candidate.confidence >= 0 && candidate.confidence <= 1 ? candidate.confidence : -1;
}
function complete(candidate: PartyDisplayCandidate) {
  const value = parts(candidate.value);
  return Number(!!value.en && !!value.zh);
}

export function partyDisplayNames(input: PartyDisplayCandidate[]): string[] {
  const candidates = input.filter(c => c.value.trim() && c.value.length <= 500).map((candidate, index) => ({...candidate, value: candidate.value.trim(), index}));
  type Group = typeof candidates;
  const groups: Group[] = [];
  // Rich spellings first prevent a bare English name from joining two different
  // bilingual names transitively. Ambiguous bridges remain separate.
  for (const candidate of [...candidates].sort((a, b) => complete(b) - complete(a))) {
    const compatible = groups.filter(group => group.every(other => !conflicting(candidate, other)));
    const exact = compatible.filter(group => group.some(other => key(candidate.value) === key(other.value) && candidate.choiceKey === other.choiceKey));
    const matches = exact.length ? exact : compatible.filter(group => group.some(other => equivalent(candidate, other)));
    if (matches.length === 1) matches[0]!.push(candidate);
    else groups.push([candidate]);
  }
  // Compare confidence only between alternatives for the same known slot.
  // Missing confidence and tied maxima cannot justify discarding a value.
  const choices = new Map<string, Group[]>();
  for (const group of groups) for (const choice of new Set(group.map(c => c.choiceKey).filter((v): v is string => !!v))) {
    choices.set(choice, [...(choices.get(choice) ?? []), group]);
  }
  const losers = new Set<Group>();
  for (const [choice, alternatives] of choices) {
    if (alternatives.length < 2) continue;
    const scored = alternatives.map(group => ({group, score: Math.max(...group.filter(c => c.choiceKey === choice).map(score))}));
    if (scored.some(item => item.score < 0)) continue;
    const best = Math.max(...scored.map(item => item.score));
    if (scored.filter(item => item.score === best).length !== 1) continue;
    for (const item of scored) if (item.score < best && item.group.every(c => c.choiceKey === choice)) losers.add(item.group);
  }
  return groups.filter(group => !losers.has(group)).sort((a, b) => Math.min(...a.map(c => c.index)) - Math.min(...b.map(c => c.index)))
    .map(group => [...group].sort((a, b) => complete(b) - complete(a) || score(b) - score(a) || a.index - b.index)[0]!.value);
}
