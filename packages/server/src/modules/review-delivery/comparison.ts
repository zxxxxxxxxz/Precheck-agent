import type {AnalysisEvidence,ComparisonCommand,MaterialMatch,MaterialChange,ResultChange} from '@hsbc/contracts/review-delivery';
import type {ReviewRun} from '@hsbc/contracts/review';
import type {DocumentBundle} from '@hsbc/contracts/documents';
import {compareResults} from '@hsbc/contracts/review-comparison';
import {compareDocumentVersions} from '../documents/engine/index.js';
import {reviewHash,type ReviewSnapshot} from '../review/service.js';
import {AppError} from '../../shared/errors.js';

export function matchMaterials(before:ReviewSnapshot,after:ReviewSnapshot,pairs:ComparisonCommand['objectPairs']=[],groups:ComparisonCommand['materialGroups']=[]):MaterialMatch[]{
  const mapping=new Map(before.objects.filter(a=>after.objects.some(b=>b.objectId===a.objectId&&b.kind===a.kind&&b.role===a.role)).map(o=>[o.objectId,o.objectId]));
  for(const p of pairs){const a=before.objects.find(o=>o.objectId===p.before),b=after.objects.find(o=>o.objectId===p.after);
    if(!a||!b||a.kind!==b.kind||a.role!==b.role||mapping.has(p.before)&&mapping.get(p.before)!==p.after)throw new AppError(422,'comparison_object_mapping_invalid');mapping.set(p.before,p.after);}
  if(new Set(mapping.values()).size!==mapping.size)throw new AppError(422,'comparison_object_mapping_invalid');
  const old=before.materials.filter(m=>m.operation==='adopt'),next=after.materials.filter(m=>m.operation==='adopt'),left=new Set<string>(),right=new Set<string>(),out:MaterialMatch[]=[];
  const owners=(snapshot:ReviewSnapshot,id:string)=>snapshot.objects.filter(o=>o.validity==='current'&&o.evidence.some(e=>e.documentVersionId===id)).map(o=>o.objectId).sort();
  const ownKey=(snapshot:ReviewSnapshot,id:string,convert:boolean)=>{const ids=owners(snapshot,id);return ids.length&&(!convert||ids.every(id=>mapping.has(id)))?JSON.stringify(ids.map(id=>convert?mapping.get(id)!:id).sort()):null;};
  const add=(a:string[],b:string[],kind:MaterialMatch['kind'],basis:string,confirmed:boolean)=>{a.forEach(id=>left.add(id));b.forEach(id=>right.add(id));out.push({id:reviewHash([a,b]),before:a,after:b,objectIds:[...new Set([...a.flatMap(id=>owners(before,id)),...b.flatMap(id=>owners(after,id))])],kind,basis,confirmed});};
  for(const group of groups){
    if(!group.before.length&&!group.after.length||group.before.some(id=>!old.some(m=>m.documentVersionId===id)||left.has(id))||group.after.some(id=>!next.some(m=>m.documentVersionId===id)||right.has(id))||new Set(group.before).size!==group.before.length||new Set(group.after).size!==group.after.length)throw new AppError(422,'comparison_material_mapping_invalid');
    add(group.before,group.after,!group.before.length?'added':!group.after.length?'removed':'matched',`人工确认：${group.reason}`,true);
  }
  for(const a of old.filter(m=>!left.has(m.documentVersionId))){
    const key=ownKey(before,a.documentVersionId,true);
    const candidates=next.filter(b=>!right.has(b.documentVersionId)&&b.documentTypeId===a.documentTypeId&&key&&key===ownKey(after,b.documentVersionId,false));
    const related=candidates.filter(b=>b.documentVersionId===a.documentVersionId||b.relation?.predecessorDocumentVersionId===a.documentVersionId);
    const selected=related.length===1?related:candidates;
    const reverse=selected.length===1?old.filter(m=>!left.has(m.documentVersionId)&&m.documentTypeId===a.documentTypeId&&ownKey(before,m.documentVersionId,true)===key):[];
    if(selected.length===1&&(related.length===1||reverse.length===1))add([a.documentVersionId],[selected[0]!.documentVersionId],'matched',related.length?'已确认对象、用途与版本关系':'已确认对象与唯一材料用途',true);
  }
  const types=new Set([...old.filter(m=>!left.has(m.documentVersionId)),...next.filter(m=>!right.has(m.documentVersionId))].map(m=>m.documentTypeId));
  for(const type of types){const a=old.filter(m=>!left.has(m.documentVersionId)&&m.documentTypeId===type).map(m=>m.documentVersionId),b=next.filter(m=>!right.has(m.documentVersionId)&&m.documentTypeId===type).map(m=>m.documentVersionId);
    add(a,b,a.length&&b.length?'ambiguous':a.length?'removed':'added',a.length&&b.length?'对象、材料用途或版本对应关系尚未确认':'此用途在另一轮没有已采用材料',!(a.length&&b.length));}
  return out;
}
export function materialChanges(matches:MaterialMatch[],before:ReviewSnapshot,after:ReviewSnapshot,bundles:Map<string,DocumentBundle>,evidence:AnalysisEvidence[],enabled:boolean):MaterialChange[]{
  return matches.map(m=>{
    const a=evidence.filter(e=>m.before.includes(e.documentId)),b=evidence.filter(e=>m.after.includes(e.documentId));
    const all=[...a,...b],gaps:string[]=[];if(m.kind==='ambiguous')gaps.push('材料匹配未确认');
    if([...m.before,...m.after].some(id=>!bundles.has(id)))gaps.push('部分材料没有完整可读解析');
    if([...m.before,...m.after].some(id=>!all.some(e=>e.documentId===id&&e.text.trim())))gaps.push('部分材料缺少可核验原文');
    if(all.some(e=>e.warnings.length))gaps.push('解析或引用不完整');
    const rawChanges:MaterialChange['rawChanges']=[];
    if(m.before.length===1&&m.after.length===1&&bundles.has(m.before[0]!)&&bundles.has(m.after[0]!)){
      const compared=compareDocumentVersions(bundles.get(m.before[0]!)!,bundles.get(m.after[0]!)!);rawChanges.push(...compared.changes.map(({kind,beforeChunkIds,afterChunkIds})=>({kind,beforeChunkIds,afterChunkIds})));
      if(compared.changes.some(c=>c.kind==='ambiguous'))gaps.push('段落对应不明，完整原文仍可供人工核对');
    }
    const affectedRuleIds:string[]=[]; // Filled from published rule dependencies by the service.
    const exact=m.before.length===1&&m.after.length===1&&before.materials.find(x=>x.documentVersionId===m.before[0])?.sourceSha256===after.materials.find(x=>x.documentVersionId===m.after[0])?.sourceSha256;
    let classification:MaterialChange['classification']='unknown',state:MaterialChange['state']='unavailable',reason=gaps.join('；');
    if(m.kind==='added'||m.kind==='removed'){classification=m.kind;state='complete';reason=m.kind==='added'?'本轮新增材料；不代表已完成审核。':'本轮未采用上一轮材料；不能视为问题解决。';}
    else if(exact&&!gaps.length){classification='unchanged';state='complete';reason='文件字节与来源哈希一致；文件名变化不影响内容。';}
    else if(!gaps.length&&enabled&&all.length&&all.reduce((n,e)=>n+e.text.length,0)<=48000){state='pending';reason='文字／结构比较已完成，等待实质影响分析。';}
    else if(!reason)reason=enabled?'完整证据超过分析范围，需人工比较。':'文字／结构比较已完成；私有语义分析未启用，实质影响尚未判断。';
    return {...m,classification,state,reason,beforeEvidenceIds:a.map(e=>e.id),afterEvidenceIds:b.map(e=>e.id),affectedRuleIds,rawChanges,limitations:[...gaps,'材料修改不代表原问题解决；以本轮有效检查与人工处置为准。'],citations:[],simulated:false};
  });
}
export function reviewResultChanges(before:ReviewRun,after:ReviewRun,pairs:ComparisonCommand['objectPairs'],issues:Array<{id:string;runId:string;ruleId:string;scopeId:string;status:string}>):ResultChange[]{
  const inverse=new Map(pairs.map(p=>[p.after,p.before]));
  const remapped={...after,results:after.results.map(r=>({...r,scopeId:inverse.get(r.scopeId)??r.scopeId}))};
  return compareResults(before,remapped).map(c=>{const afterScope=c.after?pairs.find(p=>p.before===c.scopeId)?.after??c.scopeId:null;
    return {ruleId:c.ruleId,beforeObjectId:c.before?.scopeId??null,afterObjectId:afterScope,label:c.label,beforeOutcome:c.before?.outcome??null,afterOutcome:c.after?.outcome??null,
      kind:c.kind==='resolved'||c.kind==='unchanged'?'rechecked':c.kind,beforeIssues:issues.filter(i=>i.runId===before.id&&i.ruleId===c.ruleId&&i.scopeId===c.scopeId).map(({id,status})=>({id,status})),
      afterIssues:issues.filter(i=>i.runId===after.id&&i.ruleId===c.ruleId&&i.scopeId===afterScope).map(({id,status})=>({id,status})),reason:c.kind==='resolved'?'本轮程序检查未发现差异；原问题是否关闭仍以对应人工处置记录为准。':c.label} satisfies ResultChange;
  });
}
