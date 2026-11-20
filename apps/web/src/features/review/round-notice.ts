import type {ReviewRoundsState} from '@hsbc/contracts/review-rounds';

type Round = ReviewRoundsState['items'][number];

export const roundLabels:Record<string,string>={draft:'准备中',pending:'等待预审',running:'预审中',ready:'初审结果待确认',checker_pending:'待独立复核',completed:'本轮已结束',failed:'预审失败',canceled:'已取消',stale:'需重试',discarded:'已放弃'};

/** The round a page shows: the one named in the address, else the current round, else legacy records. */
export function resolveSelectedRound(state:ReviewRoundsState,requested?:string|null){
  return requested??state.currentRoundId??(!state.enabled?'legacy':undefined);
}

export function roundLabel(state:ReviewRoundsState,round:Round){
  if(state.returnedToMaker&&round.roundId===state.currentRoundId)return '初审修改中';
  if(state.checkerCorrection&&round.roundId===state.currentRoundId&&round.status==='ready')return '更正结果待确认';
  return roundLabels[round.status]??round.status;
}

export function roundOptions(state:ReviewRoundsState){
  return [...state.items.map(round=>({value:round.roundId,label:`第 ${round.roundNumber} 轮 · ${roundLabel(state,round)}`})),...(!state.enabled||state.hasLegacyRecords?[{value:'legacy',label:'历史记录（未分轮）'}]:[])];
}

export type RoundNoticeKind='history'|'attention'|'guidance';

/**
 * What the selected round means for the person working on it.
 * `attention` notices change what they may do and stay on the page; `guidance` is routine and
 * lives with the round selector; `history` is carried by the read-only round selector itself.
 */
export function roundNotice(state:ReviewRoundsState,selected:string|undefined,closed:boolean):{text:string;kind:RoundNoticeKind}{
  const round=state.items.find(value=>value.roundId===selected),current=state.items.find(value=>value.roundId===state.currentRoundId);
  const preparing=state.items.find(value=>value.roundId===state.currentRoundId&&value.status==='draft'&&value.roundId!==selected);
  if(round&&round.roundId!==state.currentRoundId)return {kind:'history',text:`正在查看历史第 ${round.roundNumber} 轮，只读。${current?`当前为第 ${current.roundNumber} 轮。`:''}材料、结果和操作记录均按所选轮次展示。`};
  if(state.returnedToMaker&&round?.roundId===state.currentRoundId)return {kind:'attention',text:`本轮已退回原经办人修改，修改后需重新预审并提交复核。${state.returnReason?`退回原因：${state.returnReason}`:''}`};
  if(state.checkerCorrection)return {kind:'attention',text:'本轮由复核人直接更正。更正后重新预审、核对并确认结果，无需交还经办人。'};
  if(closed)return {kind:'guidance',text:'案件已完结，可只读查看各轮材料、结果和操作记录。'};
  if(selected==='legacy')return {kind:'attention',text:'保留原有记录。启用轮次后，历史记录只读，新一轮重新上传材料。'};
  if(round?.status==='draft')return {kind:'guidance',text:'核对材料与字段后，可开始预审。'};
  if(round?.status==='checker_pending')return {kind:'guidance',text:'初审结果已确认，材料固定待独立复核。需要修改时，由复核人退回原经办人，修改后重新提交复核。'};
  if(round&&!round.locked)return {kind:'guidance',text:['pending','running'].includes(round.status)?'正在生成预审结果，完成后可继续更正，确认结果后再进入下一步。':'本轮尚未确认，可继续更正材料和字段。更正后须重新预审，再确认最新结果。'};
  if(round?.allowedActions.includes('round:reopen'))return {kind:'guidance',text:'本轮材料已固定，尚未确认结束。可返回本轮更正，已有材料和结果保留。'};
  if(round)return preparing?{kind:'attention',text:`本轮已锁定。当前第 ${preparing.roundNumber} 轮正在准备，请切回该轮继续上传。`}:{kind:'guidance',text:'本轮已锁定，可查看材料、结果和操作记录。需要更换材料时，请准备下一轮。'};
  return {kind:'guidance',text:'准备一轮后上传材料并预审。'};
}
