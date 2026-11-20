import type {DocumentBundle,DocumentFieldObservation,DocumentPageArtifact} from '@hsbc/contracts/documents';
import type {DocumentRegion,EvidenceAnchor} from '@hsbc/contracts/evidence';
import type {ReviewFieldDefinition} from '@hsbc/contracts/review-config';
import {anchorsForText,sha256,validateAnchorSource} from '../../document/evidence.js';
import {directorFormLines} from './director-notice-source.js';
import {textFieldRoleEvidence} from './field-role-evidence.js';

type Candidate=DocumentFieldObservation['candidates'][number];
type Input={fields:DocumentFieldObservation[];definitions:ReviewFieldDefinition[];pages:DocumentPageArtifact[];
  logicalDocuments:DocumentBundle['logicalDocuments'];anchors:EvidenceAnchor[]};
const version='rm-source-fields-v2';
const unique=<T>(items:T[])=>[...new Set(items)];
const compact=(text:string)=>text.replace(/\s+/gu,' ').trim();
const bilingualContinuation=(full:string,part:string)=>{const prefix=part.replace(/\s*\/\s*$/u,'');return full.startsWith(prefix)&&/^\s*\/\s*\p{Script=Han}/u.test(full.slice(prefix.length));};
const captions:Record<string,{role:string;pattern:RegExp}>={
  cgt_field_32:{role:'rm_guarantor',pattern:/^RE GUARANTEE GIVEN BY\s*[:：]?\s+(.+)$/iu},
  cgt_field_34:{role:'rm_guaranteed_company',pattern:/^TO SECURE THE ACCOUNT OF\s*[:：]?\s+(.+)$/iu},
  cgt_field_35:{role:'rm_bank_entity',pattern:/^TO\s*[:：]?\s+((?:HSBC\b|The Hongkong and Shanghai Banking Corporation\b).+)$/iu},
  cgt_field_37:{role:'rm_relationship_manager',pattern:/^(?:NAME OF RM|RM Name|Relationship Manager Name|Name of Relationship Manager|客户经理名称|客户经理姓名)\s*[:：]\s*(.+)$/iu},
};

/** Recover literal RM captions omitted by the model, and select complete marked
 * option paragraphs instead of concatenating overlapping OCR/native versions.
 * Only this material owns these values. Originals and manual facts are retained. */
export function recoverRmSourceFields(input:Input):{fields:DocumentFieldObservation[];anchors:EvidenceAnchor[]} {
  const definitions=new Map(input.definitions.filter(d=>d.taxonomyIds?.includes('cgt_rm')&&d.recipe.mode==='cloud_grounded_extract').map(d=>[d.id,d]));
  const fields=input.fields.filter(f=>definitions.has(f.fieldId));
  if(!fields.length||!input.pages.length||new Set(input.pages.map(p=>p.scope.sourceSha256)).size!==1)return {fields:input.fields,anchors:input.anchors};
  const recovered=new Map<string,Candidate[]>(),anchors=[...input.anchors];
  const optionPages=new Set<number>();
  for(const page of input.pages){
    const n=page.page.page_number,owners=input.logicalDocuments.filter(d=>d.pageNumbers.includes(n));
    if(page.status==='failed'||page.scope.sourceFormat==='docx'||owners.length!==1||owners[0]!.labelId!=='cgt_rm'||
      !['candidate','confirmed'].includes(owners[0]!.status)||fields.some(f=>f.documentVersionId!==page.scope.documentVersionId||f.parseRevision!==page.scope.parseRevision))continue;
    const lines=directorFormLines(page).filter(l=>!page.conflicts.some(c=>c.region_ids.includes(l.region.region_id)));
    const add=(id:string,value:string,region:DocumentRegion)=>{
      if(!value||!region.raw_text?.includes(value)||value.length>2000||/<[^>]*>/u.test(value))return;
      let own:EvidenceAnchor[],ctx:EvidenceAnchor[];
      try{
        own=anchorsForText(page.page,[region],value);ctx=anchorsForText(page.page,[region],region.raw_text);
        if(own.length!==1||!ctx.length||[...own,...ctx].some(a=>a.localization_status==='unavailable'||a.localization_status==='ambiguous'))return;
        for(const a of [...own,...ctx])validateAnchorSource(a,page.page,page.regions);
      }catch{return;}
      const candidate:Candidate={rawValue:value,normalizedValue:value,displayValue:value,anchorIds:own.map(a=>a.anchor_id),
        contextText:region.raw_text,contextAnchorIds:ctx.map(a=>a.anchor_id),pageNumbers:[n]};
      const values=recovered.get(id)??[],prior=values.find(c=>compact(c.rawValue)===compact(value));
      if(prior){prior.anchorIds=unique([...prior.anchorIds,...candidate.anchorIds]);prior.contextAnchorIds=unique([...(prior.contextAnchorIds??[]),...(candidate.contextAnchorIds??[])]);prior.pageNumbers=unique([...prior.pageNumbers,n]);}
      else values.push(candidate);
      recovered.set(id,values);anchors.push(...own,...ctx);
    };
    for(const [id,caption] of Object.entries(captions)){
      const definition=definitions.get(id);if(definition?.roleEvidence?.role!==caption.role)continue;
      // Complete labelled OCR lines take priority over shorter native font runs
      // (e.g. an English name followed by a separate Chinese font run).
      const matches=lines.flatMap(line=>{
        const match=caption.pattern.exec(line.text),value=match?.[1]?.trim();
        return value&&value.length<=300&&!/^[\s_./-]+$/u.test(value)&&textFieldRoleEvidence(line.text,value,definition)==='supported'?[{line,value}]:[];
      });
      for(const match of matches){
        if(matches.some(other=>other!==match&&other.value!==match.value&&bilingualContinuation(other.value,match.value)&&Math.abs(other.line.box.y-match.line.box.y)<Math.max(other.line.box.height,match.line.box.height)))continue;
        add(id,match.value,match.line.region);
      }
    }
    if(!definitions.get('cgt_field_36')?.aliases.includes('[SELECTED] (a)'))continue;
    // A full OCR paragraph is the authoritative span here. Native fragments
    // and line OCR remain evidence, but cannot be concatenated into a duplicate.
    const options=directorFormLines({...page,regions:page.regions.filter(r=>r.source==='vl_ocr')}).filter(l=>!page.conflicts.some(c=>c.region_ids.includes(l.region.region_id))&&/^\[(?:NOT )?SELECTED\]\s*\([ab]\)\s+\S/iu.test(l.text)&&
      (l.text.match(/\[(?:NOT )?SELECTED\]/giu)?.length??0)===1&&!/\([cde]\)/iu.test(l.text));
    if(!options.length)continue;
    const selected=options.filter(l=>/^\[SELECTED\]/iu.test(l.text));
    for(const line of selected)add('cgt_field_36',line.text,line.region);
    // Only replace the page's broad model quote after every selected paragraph
    // is locatable. A clear pair of unselected options supports an empty result.
    if(selected.length&&selected.every(l=>recovered.get('cgt_field_36')?.some(c=>c.rawValue===l.text&&c.pageNumbers.includes(n)))||
      !selected.length&&['a','b'].every(letter=>options.some(l=>new RegExp(`^\\[NOT SELECTED\\]\\s*\\(${letter}\\)`,'iu').test(l.text))))optionPages.add(n);
  }
  const byAnchor=new Map(anchors.map(a=>[a.anchor_id,a]));
  const result=input.fields.map((field):DocumentFieldObservation=>{
    const added=recovered.get(field.fieldId)??[],option=field.fieldId==='cgt_field_36';
    if(field.humanRevisionId||!added.length&&(!option||!optionPages.size))return field;
    const superseded=(c:Candidate)=>{
      if(option)return c.pageNumbers.length>0&&c.pageNumbers.every(n=>optionPages.has(n));
      return added.some(a=>compact(a.rawValue)===compact(c.rawValue)||bilingualContinuation(a.rawValue,c.rawValue))&&
        c.anchorIds.length>0&&c.anchorIds.every(id=>{
          const anchor=byAnchor.get(id),page=anchor&&input.pages.find(p=>p.page.page_asset_id===anchor.page_asset_id);
          if(!anchor||!page)return false;try{validateAnchorSource(anchor,page.page,page.regions);return true;}catch{return false;}
        });
    };
    const candidates=[...field.candidates.filter(c=>!superseded(c)),...added];
    const prior=field.semanticFilter?.originalCandidates??field.candidates.map((c,i)=>({...c,candidateId:`rm-prior:${field.id}:${i}`}));
    const additions=added.map(c=>({...c,candidateId:`rm:${sha256(JSON.stringify([field.fieldId,c])).slice(0,32)}`}));
    const originals=[...prior.filter(c=>!additions.some(a=>a.candidateId===c.candidateId)),...additions];
    return {...field,status:'uncertain',rawValue:candidates.length===1?candidates[0]!.rawValue:null,normalizedValue:candidates.length===1?candidates[0]!.normalizedValue:null,
      candidates,anchorIds:unique(candidates.flatMap(c=>c.anchorIds)),pageNumbers:unique(candidates.flatMap(c=>c.pageNumbers)),
      coverageGaps:unique([...field.coverageGaps.filter(g=>g!=='field_not_found_in_processed_scope'),'entity_candidate_requires_confirmation']),
      semanticFilter:{version:field.semanticFilter?.version??'azure-grounded-fields-v2',model:field.semanticFilter?.model??'source-layout',state:'completed',originalCandidates:originals,
        decisions:originals.map(c=>({candidateId:c.candidateId,decision:additions.some(a=>a.candidateId===c.candidateId)?'selected':superseded(c)?'rejected':field.semanticFilter?.decisions.find(d=>d.candidateId===c.candidateId)?.decision??'uncertain',anchorIds:c.anchorIds,pageNumbers:c.pageNumbers})),
        reasonCodes:unique([...(field.semanticFilter?.reasonCodes??[]),version])}};
  });
  return {fields:result,anchors:[...new Map(anchors.map(a=>[a.anchor_id,a])).values()]};
}
