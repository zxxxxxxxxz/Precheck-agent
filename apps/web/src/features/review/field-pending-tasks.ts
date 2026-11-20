import type {ChecklistRow} from '@hsbc/contracts/review-checklist';
/** Merge only explicit, current follow-ups sharing the complete question and actions.
 * Keep row identities and evidence; do not merge stale results or different objects. */
export function pendingTaskGroups(rows:ChecklistRow[]):ChecklistRow[][] {
 const groups=new Map<string,ChecklistRow[]>();
 for(const row of rows){const v=row.verification;
  const merge=v?.validity==='current'&&v.status==='pending'&&v.meaning==='pending'&&v.actions.length;
  const key=merge?JSON.stringify([v.recordId,row.objectId,v.reason,v.actions]):row.id;
  groups.set(key,[...(groups.get(key)??[]),row]);
 }
 return [...groups.values()];
}
export function pendingTaskRow(rows:ChecklistRow[]):ChecklistRow {
 const first=rows[0]!;if(rows.length===1||!first.verification)return first;
 const sources=[...new Map(rows.flatMap(r=>r.verification?.sources??[]).map(s=>[JSON.stringify(s),s])).values()];
 return {...first,label:first.verification.reason.split(/[。\n]/u)[0]||first.label,
  verification:{...first.verification,sources}};
}
