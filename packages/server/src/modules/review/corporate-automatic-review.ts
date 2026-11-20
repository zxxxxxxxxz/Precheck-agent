import {CORPORATE_WORKBOOK_SHA256} from '@hsbc/contracts/corporate-requirements';
import {fieldReviewStatus,type AutomaticReviewCheck,type FrozenFieldReview,type FieldReviewItem} from '@hsbc/contracts/field-verification';
import type {ChecklistRow} from '@hsbc/contracts/review-checklist';
import type {ReviewConfigManifest,ReviewRule} from '@hsbc/contracts/review-config';
import type {DB} from '../../infrastructure/database/client.js';
import {personalSourceReviewer as fieldSourceReviewer} from './personal-source-review.js';
import {originalTextKey} from './field-review-original.js';
import {normalizeReviewValue} from './normalization.js';

// These source requirements ask for this exact comparison. Broader identity,
// facility membership, signatures and legal judgments are deliberately separate.
const comparisons:Record<number,[string,string,'text'|'date']>={
 29:['cgt_field_26','cgt_field_4','text'],30:['cgt_field_27','cgt_field_7','text'],
 42:['cgt_field_32','cgt_field_9','text'],43:['cgt_field_33','cgt_field_6','date'],
 44:['cgt_field_34','cgt_field_7','text'],45:['cgt_field_35','cgt_field_4','text'],
 54:['cgt_field_43','cgt_field_10','text'],66:['cgt_field_61','cgt_field_9','text'],
};
const primary=(row:ChecklistRow)=>[...new Map((row.sourceValues??row.crossChecks?.flatMap(c=>c.sources)??[])
 .filter(s=>s.fieldId===row.fieldId).map(s=>[s.id,s])).values()];

/** Read-only checks over pinned originals. No inferred business object, adopted
 * fact, manual approval or changed raw rule outcome is created here. */
export async function corporateAutomaticReview(db:DB,rows:ChecklistRow[],manifest:ReviewConfigManifest,revision:number,recordedAt:string){
 const checks:AutomaticReviewCheck[]=[],fields:FrozenFieldReview[]=[],sourceGaps:Array<{rowId:string;reasons:string[]}>=[],reader=fieldSourceReviewer(db);
 const corporate=rows.filter(r=>r.objectRole==='corporate_guarantee');
 const supported=(ids:string[])=>ids.length>0&&ids.every(id=>manifest.sources.some(s=>s.id===id&&s.guaranteeType==='corporate_guarantee'&&s.sha256===CORPORATE_WORKBOOK_SHA256&&['candidate','confirmed'].includes(s.disposition)));
 const applicable=(rule:ReviewRule,row:ChecklistRow)=>{
  if(!rule.applicability)return true;
  const material=manifest.materials.find(m=>`material:${m.id}`===rule.applicability!.fieldId);
  const types=manifest.fields.find(f=>f.id===row.fieldId)?.taxonomyIds;
  // A grounded field whose sole document type is this material establishes
  // that it was supplied. It does not establish other business conditions.
  return rule.applicability.equals===true&&!!material&&types?.length===1&&types[0]===material.taxonomyId&&
   row.materialTypes.length===1&&row.materialTypes[0]!.id===material.taxonomyId;
 };
 for(const row of corporate){
  const definition=manifest.fields.find(f=>f.id===row.fieldId);
  if(!definition||definition.recipe.mode==='manual'||definition.type!=='date'&&/签署|簽署|签字|簽字|签名|簽名|盖章|蓋章/u.test(row.label))continue;
  const observation=await reader.source(row);
  let item=observation;
  const reviewed=row.verification;
  if(!item&&reviewed?.validity==='current'&&!reviewed.origin&&reviewed.meaning==='consistent'&&['confirmed','consistent'].includes(reviewed.status)){
   // Reuse an effective human source selection, then verify that exact original
   // again. Do not search a different field/document or infer role from a name.
   for(const source of reviewed.sources.filter(s=>s.kind==='original'&&s.value.trim())){
    const input=primary(row).find(s=>s.documentId===source.evidence.documentVersionId);
    if(!input)continue;
    // Current verification has already checked the saved document pins and
    // dependent facts. A human-selected location can repair an empty extraction;
    // the original reader still validates its anchor, revision, hash and text.
    const grounded=await reader.grounded({...input,originalEligible:true,state:'available',values:[source.value],evidence:[source.evidence]});
    if(!grounded)continue;
    item={rowId:row.id,fieldId:row.fieldId,objectId:row.objectId,scope:'bank_rule',meaning:'consistent',reason:'已复核当前有效记录所选原文，确认本字段有值。',actions:[],sources:grounded};break;
   }
  }
  if(!item){
   if(!row.crossChecks?.length&&row.verification?.validity!=='current')sourceGaps.push({rowId:row.id,reasons:await reader.gaps(row)});
   continue;
  }
  if(observation&&row.verification?.validity!=='current')fields.push({id:row.id,fieldId:row.fieldId,label:row.label,objectId:row.objectId,objectLabel:row.objectLabel,materialTypes:row.materialTypes,
   verification:{...item,status:fieldReviewStatus(item),origin:'automatic',pendingKind:'incomplete',recordId:`automatic:${row.id}`,recordedAt,caseRevision:revision,validity:'current',corrections:[]}});
  // Presence is a narrower result than the independent business requirement.
  for(const rule of manifest.rules.filter(r=>r.operator==='present'&&r.inputs.length===1&&r.inputs[0]===row.fieldId&&r.objectScope?.role==='corporate_guarantee'&&applicable(r,row)&&!r.requiredParameters.length&&r.sourceDirectionConfirmed&&supported(r.sourceIds))){
   checks.push({id:`${row.id}:presence:${rule.id}`,fieldId:row.fieldId,objectId:row.objectId,ruleIds:[rule.id],status:'done',
    reason:'已在所列材料原文中核实本字段有值；对应业务要求另项检查。',item});
  }
 }
 for(const [number,[leftId,rightId,type]] of Object.entries(comparisons)){
  const sourceId=`cgt_rule_source_${number}`;
  const rules=manifest.rules.filter(r=>r.id===`cgt_bank_${number}`&&r.operator==='manual_review'&&r.inputs.length===1&&r.inputs[0]===leftId&&
   r.objectScope?.role==='corporate_guarantee'&&!r.requiredParameters.length&&r.sourceDirectionConfirmed&&r.sourceIds.length===1&&r.sourceIds[0]===sourceId&&supported(r.sourceIds));
  if(!rules.length)continue;
  for(const left of corporate.filter(r=>r.fieldId===leftId)){
   const applicableRules=rules.filter(r=>applicable(r,left));if(!applicableRules.length)continue;
   const counterparts=corporate.filter(r=>r.fieldId===rightId&&r.objectId===left.objectId);if(counterparts.length!==1)continue;
   const right=counterparts[0]!,inputs=[primary(left),primary(right)];
   // A multi-party/ambiguous receipt cannot be matched merely by repeated names.
   if(inputs.some(s=>s.length!==1||!s[0]!.originalComparisonEligible||s[0]!.values.length!==1))continue;
   const groups=await Promise.all(inputs.map(s=>reader.grounded(s[0]!)));
   if(groups.some(g=>!g?.length))continue;
   const sources=groups.flatMap(g=>g!);
   if(new Set(sources.map(s=>s.evidence.documentVersionId)).size!==2)continue;
   let equal:boolean;
   if(type==='date'){
    const values=sources.map(s=>normalizeReviewValue(s.value,'date'));
    if(values.some(v=>v.status==='pending'||v.value===null))continue;
    equal=new Set(values.map(v=>v.value)).size===1;
   }else equal=new Set(sources.map(s=>originalTextKey(s.value).toUpperCase())).size===1;
   let reviewedEqual=false;
   const verification=left.verification;
   if(!equal&&type==='text'&&verification?.validity==='current'&&!verification.origin&&verification.scope==='cross_file'&&
    verification.meaning==='consistent'&&['confirmed','consistent'].includes(verification.status)){
    const covered=await Promise.all(inputs.map(async ([input])=>{
     const selected=verification.sources.filter(s=>s.kind==='original'&&s.evidence.documentVersionId===input!.documentId&&
      input!.evidence.some(e=>e.parseRevision===s.evidence.parseRevision&&e.directoryRevision===s.evidence.directoryRevision));
     for(const source of selected)if(await reader.grounded({...input!,values:[source.value],evidence:[source.evidence]}))return true;
     return false;
    }));
    reviewedEqual=covered.every(Boolean);
   }
   equal=equal||reviewedEqual;
   const status=equal?'done':type==='date'?'open':'confirm';
   const reason=reviewedEqual?'已复核当前有效的跨文件核对记录及两侧原文，保留已记录的一致结论。':equal?'已逐项核对两份材料的对应原文，取值一致。':type==='date'?'两份材料的对应日期不一致，请核对并更正。':'两份材料的对应文字不同，请核对名称或地址差异是否可接受。';
   const item:FieldReviewItem={rowId:left.id,fieldId:left.fieldId,objectId:left.objectId,scope:'bank_rule',meaning:equal?'consistent':type==='date'?'different':'pending',reason,actions:equal?[]:[reason],sources:sources.map(s=>({...s,comparisonKey:'corporate-counterpart'}))};
   checks.push({id:`${left.id}:corporate:${number}`,fieldId:left.fieldId,objectId:left.objectId,ruleIds:applicableRules.map(r=>r.id),status,reason,item});
  }
 }
 return {checks,fields,sourceGaps};
}
