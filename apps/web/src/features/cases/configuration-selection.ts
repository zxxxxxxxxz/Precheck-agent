import {isCaseConfigurationEnabled, type CaseConfigurationOption, type CaseReviewSelection} from '@hsbc/contracts/draft';

export interface CaseConfigurationChoice {guaranteeTypes: CaseReviewSelection['guaranteeTypes']; releaseId?: string}
export const emptyConfigurationChoice = (): CaseConfigurationChoice => ({guaranteeTypes: []});
const typeKey = (types: readonly string[]) => [...types].sort().join(',');

/** Exact sets only: a combined release never silently substitutes for a single guarantee. */
export function matchingCaseConfigurations(items: CaseConfigurationOption[], types: readonly string[]) {
  if (!isCaseConfigurationEnabled(types)) return [];
  return items.filter(item => typeKey(item.guaranteeTypes) === typeKey(types))
    .sort((a, b) => b.publishedAt.localeCompare(a.publishedAt) || a.releaseId.localeCompare(b.releaseId));
}

export function chooseCaseConfiguration(items: CaseConfigurationOption[], guaranteeTypes: CaseReviewSelection['guaranteeTypes']): CaseConfigurationChoice {
  const matches = matchingCaseConfigurations(items, guaranteeTypes);
  // A newer synthetic release must never displace available bank rules.
  const releaseId = (matches.find(item => item.scope === 'bank') ?? matches[0])?.releaseId;
  return {guaranteeTypes, releaseId};
}

export function caseConfigurationSelection(items: CaseConfigurationOption[], choice: CaseConfigurationChoice): CaseReviewSelection | undefined {
  const selected = matchingCaseConfigurations(items, choice.guaranteeTypes).find(item => item.releaseId === choice.releaseId);
  return selected && {releaseId: selected.releaseId, guaranteeTypes: [...choice.guaranteeTypes], scope: selected.scope};
}
