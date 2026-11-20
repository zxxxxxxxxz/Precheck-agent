import type {ReviewRun} from './review.js';
type ReviewResult=ReviewRun['results'][number];
const resultKey=(r:ReviewResult)=>JSON.stringify([r.ruleId,r.scopeId]);
const isProblem=(r:ReviewResult)=>!['pass','not_applicable','no_difference','no_discrepancy'].includes(r.outcome);
export type ResultChange={key:string;ruleId:string;scopeId:string;before?:ReviewResult;after?:ReviewResult;kind:'added'|'persisting'|'resolved'|'unverified'|'unchanged'|'incomparable';label:string};
/** Compare immutable execution snapshots, never names, list order, or mutable issue status. */
export function compareResults(before:ReviewRun,after:ReviewRun):ResultChange[] {
  const left=new Map(before.results.map(r=>[resultKey(r),r])),right=new Map(after.results.map(r=>[resultKey(r),r]));
  const compatible=before.configurationReleaseId===after.configurationReleaseId&&before.state==='ready'&&after.state==='ready'&&after.validity==='current';
  return [...new Set([...left.keys(),...right.keys()])].map(key=>{
    const a=left.get(key),b=right.get(key),r=b??a!;
    let kind:ResultChange['kind']='unchanged',label='未发生问题变化';
    if(!compatible){kind='incomparable';label='配置不同、运行未完成或目标结果已失效，不可直接比较';}
    else if(!b){kind='unverified';label='本轮未检查／规则或对象已移除，不能视为解决';}
    else if(a&&isProblem(a)&&b.outcome==='pass'){kind='resolved';label='已解决 · 本轮重新检查未发现差异';}
    else if(a&&isProblem(a)&&b.outcome==='not_applicable'){kind='unverified';label='本轮不适用，不能视为问题已解决';}
    else if(isProblem(b)){kind=a&&isProblem(a)?'persisting':'added';label=kind==='persisting'?'仍需处理':'新增待处理';}
    else if(!a){kind='unverified';label='新增检查项，无上一轮结果可比';}
    return {key,ruleId:r.ruleId,scopeId:r.scopeId,before:a,after:b,kind,label};
  });
}
