import type {ReviewRoundsState} from '@hsbc/contracts/review-rounds';
import type {CaseSummary} from './types.ts';

const roundEdits = new Set(['material:upload', 'document:parse', 'document:classify', 'case:configure', 'field:correct', 'material:adopt']);

/** Keep list expansion and direct links on the same round and permission boundary. */
export function caseForRound(item: CaseSummary, rounds: ReviewRoundsState | undefined, selected: string | null): CaseSummary {
  const selectedRoundId = selected ?? rounds?.currentRoundId ?? item.currentRoundId ?? null;
  const round = rounds?.items.find(value => value.roundId === selectedRoundId);
  const editable = rounds?.enabled === false || item.roundsEnabled === false && !rounds
    || !!round && round.roundId === rounds?.currentRoundId && !round.locked && !['pending','running'].includes(round.status);
  return {...item, selectedRoundId, allowed_actions: editable ? item.allowed_actions : item.allowed_actions.filter(action => !roundEdits.has(action))};
}
