import type {ClosurePreview} from '@hsbc/contracts/case-review-status';

/** What the closer states about the items that stay unresolved. */
export interface ClosureAcknowledgement {reason:string;itemReasons:Record<string,string>;checked:string[]}
export const emptyAcknowledgement=():ClosureAcknowledgement=>({reason:'',itemReasons:{},checked:[]});
/** Older servers do not mark items; every remaining item is then treated as unresolved. */
export const unresolvedItems=(preview:ClosurePreview)=>preview.items.filter(item=>item.unresolved!==false);
/** Each unresolved item is ticked and a reason is given before the case can be closed. */
export function acknowledgementComplete(preview:ClosurePreview,value:ClosureAcknowledgement){
 const unresolved=unresolvedItems(preview);
 return !unresolved.length||unresolved.every(item=>value.checked.includes(item.id))&&value.reason.trim().length>0;
}

/** Bind the explicit confirmation to the exact preview shown in the dialog. */
export function closureConfirmation(preview:ClosurePreview,idempotencyKey:string,acknowledgement?:ClosureAcknowledgement){
 const itemReasons=Object.fromEntries(Object.entries(acknowledgement?.itemReasons??{}).map(([id,reason])=>[id,reason.trim()] as const).filter(([id,reason])=>reason&&preview.items.some(item=>item.id===id)));
 return {
  roundId:preview.roundId,runId:preview.runId,confirmationToken:preview.confirmationToken,
  expectedRevision:preview.revision,idempotencyKey,
  acknowledgedItemIds:preview.items.map(item=>item.id),confirmPreReviewOnly:true as const,
  reason:acknowledgement?.reason.trim()||'确认完结当前已复核的文件审核流程，剩余问题及原结论保留',
  ...(Object.keys(itemReasons).length?{itemReasons}:{}),
 };
}
