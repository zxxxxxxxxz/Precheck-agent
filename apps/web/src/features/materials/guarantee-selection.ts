import type {ReviewState} from '@hsbc/contracts/review';
import {guaranteeSelectionKey} from '@hsbc/contracts/mixed-guarantee';

export function matchingRoundConfiguration(state:ReviewState, types:string[]) {
  if(!types.length)return undefined;
  const matches=state.availableConfigurations.filter(option=>option.guaranteeTypes&&
    guaranteeSelectionKey(option.guaranteeTypes)===guaranteeSelectionKey(types));
  // Keep an existing pin; a new selection prefers bank releases, then latest publication.
  return matches.find(option=>option.releaseId===state.configurationReleaseId)??matches.sort((a,b)=>
    Number(b.scope==='bank')-Number(a.scope==='bank')||(b.publishedAt??'').localeCompare(a.publishedAt??''))[0];
}
