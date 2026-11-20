import type {DB} from '../../infrastructure/database/client.js';
import {AppError} from '../../shared/errors.js';
import type {ReviewConfigManifest} from '@hsbc/contracts/review-config';
import type {ChecklistRow,CrossFileCheck} from '@hsbc/contracts/review-checklist';
import {COMPARISON_GUIDANCE_KINDS,caseGuidanceLabel,guidanceContentKey,guidanceTextKey,releaseGuidanceLabel,
  type CaseGuidance,type GuidanceRef,type SemanticGuidanceBody} from '@hsbc/contracts/review-guidance';

/** All rules of a case, newest numbering last. Retired rules stay for history. */
/** Worker roles have no auth schema access; names are display-only and omitted there. */
export async function canReadPeople(db:DB):Promise<boolean> {
  return (await db.query("SELECT CASE WHEN has_schema_privilege('auth','USAGE') THEN has_table_privilege('auth.people','SELECT') ELSE false END AS ok")).rows[0].ok===true;
}
export async function loadCaseGuidance(db:DB,caseId:string):Promise<CaseGuidance[]> {
  const names=await canReadPeople(db);
  const rows=(await db.query(`SELECT g.*,${names?'(SELECT display_name FROM auth.people p WHERE p.id=g.created_by)':'NULL'} AS created_by_name,r.number AS round_number FROM business.case_review_guidance g
    LEFT JOIN business.review_rounds r ON r.id=g.round_id WHERE g.case_id=$1 ORDER BY g.number`,[caseId])).rows;
  if(!rows.length)return [];
  const adopted=(await db.query(`SELECT r.release_id,e->>'id' AS entry_id,e->'origin'->>'guidanceId' AS guidance_id FROM business.review_config_releases r,
    jsonb_array_elements(COALESCE(r.manifest->'semanticGuidance','[]'::jsonb)) e WHERE e->'origin'->>'caseId'=$1 ORDER BY r.published_at`,[caseId])).rows;
  return rows.map(r=>({id:r.id,number:r.number,label:caseGuidanceLabel(r.number),kind:r.kind,statement:r.body.statement,fieldIds:r.body.fieldIds,expressions:r.body.expressions,
    status:r.status,origin:r.origin,createdBy:r.created_by,...(r.created_by_name?{createdByName:r.created_by_name}:{}),createdAt:new Date(r.created_at).toISOString(),
    roundId:r.round_id,roundNumber:r.round_number??null,caseRevision:r.case_revision,supersedes:r.supersedes,
    ...(r.retired_at?{retiredAt:new Date(r.retired_at).toISOString(),retireReason:r.retire_reason}:{}),
    adoptions:adopted.filter(a=>a.guidance_id===r.id).map(a=>({releaseId:a.release_id,entryId:a.entry_id}))}));
}

const refOf=(g:SemanticGuidanceBody,ref:string,source:GuidanceRef['source'],label:string):GuidanceRef=>
  ({ref,source,label,kind:g.kind,statement:g.statement,fieldIds:[...g.fieldIds],expressions:[...g.expressions]});

/** Published rule-centre wording first, then active case rules not already published. */
export function guidanceRefs(manifest:ReviewConfigManifest,guidance:readonly CaseGuidance[]|undefined):GuidanceRef[] {
  const release=(manifest.semanticGuidance??[]).map((entry,index)=>refOf(entry,`release:${manifest.releaseId}:${entry.id}`,'release',releaseGuidanceLabel(index)));
  const published=new Set([...(manifest.semanticGuidance??[]).map(guidanceContentKey),...(manifest.semanticGuidance??[]).flatMap(e=>e.origin?[`case:${e.origin.guidanceId}`]:[])]);
  const local=(guidance??[]).filter(g=>g.status==='active'&&!published.has(guidanceContentKey(g))&&!published.has(`case:${g.id}`))
    .map(g=>refOf(g,`case:${g.id}`,'case',g.label));
  return [...release,...local];
}

const readings=(check:CrossFileCheck)=>check.sources.flatMap(s=>s.values.map(guidanceTextKey));
/** A rule applies only when its field scope and wording both point at this comparison. */
export function guidanceApplies(ref:GuidanceRef,check:CrossFileCheck):boolean {
  if(!COMPARISON_GUIDANCE_KINDS.includes(ref.kind))return false;
  if(!ref.fieldIds.length&&!ref.expressions.length)return false;
  if(ref.fieldIds.length&&!ref.fieldIds.some(id=>check.fieldIds.includes(id)))return false;
  if(!ref.expressions.length)return true;
  const values=readings(check),matched=new Set(ref.expressions.map(guidanceTextKey).filter(e=>e&&values.some(v=>v.includes(e))));
  return ref.kind==='name_equivalence'?matched.size>=2:matched.size>=1;
}
export function attachGuidance(check:CrossFileCheck,refs:readonly GuidanceRef[]):CrossFileCheck {
  if(!check.semanticEligible||!refs.length)return check;
  const applicable=refs.filter(ref=>guidanceApplies(ref,check));
  return applicable.length?{...check,guidance:applicable}:check;
}
export function attachGuidanceNotes(row:ChecklistRow,refs:readonly GuidanceRef[]):ChecklistRow {
  const notes=refs.filter(ref=>ref.kind==='focus_note'&&ref.fieldIds.includes(row.fieldId));
  return notes.length?{...row,guidanceNotes:notes}:row;
}
/** Only refs supplied with the check survive; a model cannot invent a rule. */
export function verifiedAppliedGuidance(check:Pick<CrossFileCheck,'guidance'>,applied:readonly string[]|undefined):string[] {
  const allowed=new Set((check.guidance??[]).map(g=>g.ref));
  return [...new Set((applied??[]).filter(ref=>allowed.has(ref)))];
}

/** Business validation shared by manual saves, assistant proposals and digests. */
export function validateGuidanceBody(manifest:ReviewConfigManifest,body:SemanticGuidanceBody){
  const fields=body.fieldIds.map(id=>manifest.fields.find(f=>f.id===id));
  if(fields.some(f=>!f))throw new AppError(422,'guidance_field_unknown');
  if(new Set(body.fieldIds).size!==body.fieldIds.length||new Set(body.expressions.map(guidanceTextKey)).size!==body.expressions.length)throw new AppError(422,'guidance_duplicate_scope');
  if(COMPARISON_GUIDANCE_KINDS.includes(body.kind)){
    // Exact checks (amount, currency, date, identifiers) are never relaxed by wording.
    if(fields.some(f=>f!.type!=='text'||f!.valueKind==='identifier'))throw new AppError(422,'guidance_exact_field');
    if(body.kind==='name_equivalence'&&body.expressions.length<2)throw new AppError(422,'guidance_expressions_required');
    if(body.kind==='wording_tolerance'&&!body.fieldIds.length&&!body.expressions.length)throw new AppError(422,'guidance_scope_required');
  }
  if(body.kind==='focus_note'&&!body.fieldIds.length)throw new AppError(422,'guidance_scope_required');
}
