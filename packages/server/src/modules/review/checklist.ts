import {PERSONAL_LEGAL_LABELS,PERSONAL_RETIRED_INPUTS} from '@hsbc/contracts/personal-requirements';
import type {DocumentPageArtifact} from '@hsbc/contracts/documents';
import type {EvidenceAnchor} from '@hsbc/contracts/evidence';
import {withGuaranteeAmountInputs,withRequirementInputDefaults} from './guarantee-amount-inputs.js';
import {automaticFieldFact,type AutomaticFieldSource} from './automatic-fields.js';
import type {ReviewConfigManifest} from '@hsbc/contracts/review-config';
import {candidateAdoptionValue,candidateRequiredEvidenceGroups,type DocumentFieldObservation} from '@hsbc/contracts/documents';
import type {ReviewState,ReviewEvidence} from '@hsbc/contracts/review';
import type {ChecklistDocument,ChecklistRow,ChecklistStatus} from '@hsbc/contracts/review-checklist';
import {reviewEvidenceBelongsToObject} from './material-readiness.js';
import type {AutomaticSignatureInformation} from '@hsbc/contracts/signature-information';

export interface ChecklistInputDocument extends ChecklistDocument {
  taxonomyIds:string[];fields:DocumentFieldObservation[];unclassified:boolean;
  sourceNodes:Record<string,string>;projectionCurrent:boolean;
  availableAnchorIds?:string[];sourceHash?:string;invalidFieldIds?:string[];
  uploadedAt?:string;
  logicalScopes?:Array<{id:string;pageNumbers:number[];regionIds?:string[];sourceNodeIds?:string[];wholePageNumbers?:number[];materialScope?:{logicalDocumentId:string}}>;
  /** Page and regions of the anchors that candidates cite; only read to keep automatic evidence inside its adopted scope. */
  anchorPlacements?:ReadonlyMap<string,{page_number:number;block_ids:string[]}>;
  sourcePages?:DocumentPageArtifact[];
  readingSourceSha256?:string;
  readingPages?:DocumentPageArtifact[];readingAnchors?:EvidenceAnchor[];
  authorizationSignatures?:{automatic:AutomaticSignatureInformation;pages:number[];sourceSha256:string};
}
/** Read-only file candidates, never object attribution or fact adoption. */
export function unassignedFieldCandidates(d:ChecklistInputDocument,fieldId:string) {
  if (!d.projectionCurrent || !d.parseRevision || !d.directoryRevision || !['ready','partial'].includes(d.state)) return [];
  return d.fields.filter(f=>f.fieldId===fieldId&&f.documentVersionId===d.id&&f.parseRevision===d.parseRevision).flatMap(f=>f.candidates.flatMap((candidate,index)=>{
    const groups=candidateRequiredEvidenceGroups(candidate);
    if (!groups.length || groups.some(group=>!group.length)) return [];
    const evidence:ReviewEvidence[]=[...new Set(groups.flat())].map(id=>({documentVersionId:d.id,parseRevision:d.parseRevision!,directoryRevision:d.directoryRevision,...(d.sourceNodes[id]?{sourceNodeId:d.sourceNodes[id]}:{anchorId:id})}));
    return evidence.length?[{id:`${d.id}:${f.id}:${index}`,value:candidate.displayValue??candidateAdoptionValue(candidate),documentId:d.id,evidence,...(candidate.confidence!==undefined?{confidence:candidate.confidence}:{})}]:[];
  }));
}
/** Pure read projection. A missing object is a display placeholder, never a saved identity. */
export function buildChecklist(manifest:ReviewConfigManifest,state:ReviewState,documents:ChecklistInputDocument[],includeUnassignedDocuments=false):ChecklistRow[] {
  const rows:ChecklistRow[]=manifest.fields.filter(field=>state.readOnly||!PERSONAL_RETIRED_INPUTS.has(field.id)).flatMap(field=>{
    const matching=state.objects.filter(o=>o.kind===field.objectKind&&(!field.objectRole||o.role===field.objectRole));
    const fieldTypes=field.taxonomyIds??manifest.materials.filter(m=>!m.objectScope||m.objectScope.kind===field.objectKind&&(!field.objectRole||m.objectScope.role===field.objectRole)).map(m=>m.taxonomyId);
    const candidateOwned=(candidate:ReturnType<typeof unassignedFieldCandidates>[number],d:ChecklistInputDocument)=>matching.some(o=>{
      if(o.automaticAttribution)return o.automaticAttribution.candidateIds.includes(candidate.id);
      if(!reviewEvidenceBelongsToObject(o,candidate.evidence))return false;
      const owners=matching.filter(owner=>owner.evidence.some(e=>e.documentVersionId===d.id&&e.parseRevision===d.parseRevision&&e.directoryRevision===d.directoryRevision));
      return owners.length<=1||candidate.evidence.every(e=>o.evidence.some(own=>own.documentVersionId===e.documentVersionId&&own.parseRevision===e.parseRevision&&own.directoryRevision===e.directoryRevision&&(e.anchorId?own.anchorId===e.anchorId:own.sourceNodeId===e.sourceNodeId)));
    });
    const unowned=documents.filter(d=>d.taxonomyIds.some(id=>fieldTypes.includes(id))&&(!matching.some(o=>o.evidence.some(e=>e.documentVersionId===d.id))||
      unassignedFieldCandidates(d,field.id).some(c=>!candidateOwned(c,d))));
    // New files remain visible before attribution. Never adopt them into an
    // existing guarantor merely because a same-type object already exists.
    const objects=matching.length?[...matching,...(includeUnassignedDocuments&&unowned.length?[null]:[])]:[null];
    return objects.map(object=>{
      field=PERSONAL_LEGAL_LABELS[field.id]?{...field,label:PERSONAL_LEGAL_LABELS[field.id]!}:field;
      const rules=manifest.rules.filter(rule=>rule.inputs.includes(field.id)&&(!rule.objectScope||rule.objectScope.kind===field.objectKind&&(!object||rule.objectScope.role===object.role)));
      const types=field.taxonomyIds??manifest.materials.filter(m=>!m.objectScope||m.objectScope.kind===field.objectKind&&(!field.objectRole||m.objectScope.role===field.objectRole)).map(m=>m.taxonomyId);
      const typed=documents.filter(d=>d.taxonomyIds.some(id=>types.includes(id)));
      const assigned=(d:ChecklistInputDocument,o:ReviewState['objects'][number])=>o.evidence.some(e=>e.documentVersionId===d.id&&e.parseRevision===d.parseRevision&&e.directoryRevision===d.directoryRevision);
      const relevant=object?typed.filter(d=>assigned(d,object)):matching.length&&includeUnassignedDocuments?unowned:typed;
      const unassigned=typed.filter(d=>!state.objects.some(o=>assigned(d,o)));
      const unknown=documents.some(d=>d.unclassified);
      let fact=object?state.facts.find(f=>f.objectId===object.objectId&&f.fieldId===field.id)??null:null;
      const evidenceFor=(d:ChecklistInputDocument,ids:string[]):ReviewEvidence[]=>!d.parseRevision?[]:ids.map(id=>({documentVersionId:d.id,parseRevision:d.parseRevision!,directoryRevision:d.directoryRevision,...(d.sourceNodes[id]?{sourceNodeId:d.sourceNodes[id]}:{anchorId:id})}));
      const owned=relevant.flatMap(d=>d.fields.filter(f=>f.fieldId===field.id&&f.documentVersionId===d.id&&f.parseRevision===d.parseRevision).map(f=>({d,f})));
      const automaticSources:AutomaticFieldSource[]=[];
      const readable=(d:ChecklistInputDocument)=>d.adopted&&d.projectionCurrent&&['ready','partial'].includes(d.state);
      const candidates=owned.flatMap(({d,f})=>f.candidates.flatMap((candidate,index)=>{
        if(object?.automaticAttribution&&!object.automaticAttribution.candidateIds.includes(`${d.id}:${f.id}:${index}`))return [];
        const groups=candidateRequiredEvidenceGroups(candidate);
        if(groups.some(group=>!group.length))return [];
        const evidence=evidenceFor(d,[...new Set(groups.flat())]).map(e=>object?.automaticAttribution?object.evidence.find(source=>source.documentVersionId===e.documentVersionId&&source.parseRevision===e.parseRevision&&source.directoryRevision===e.directoryRevision&&(e.anchorId?source.anchorId===e.anchorId:source.sourceNodeId===e.sourceNodeId))??e:e);
        // No name-based attribution. A joint personal document requires exact source ownership.
        if(!object||!d.adopted||!d.projectionCurrent||!evidence.length||!reviewEvidenceBelongsToObject(object,evidence)||
          !evidence.every(e=>object.evidence.some(o=>o.documentVersionId===e.documentVersionId&&o.parseRevision===e.parseRevision&&o.directoryRevision===e.directoryRevision)))return [];
        if(state.objects.filter(o=>o.kind===object.kind&&o.role===object.role&&assigned(d,o)).length>1&&
          !evidence.every(e=>object.evidence.some(o=>o.documentVersionId===e.documentVersionId&&o.parseRevision===e.parseRevision&&o.directoryRevision===e.directoryRevision&&(e.anchorId?o.anchorId===e.anchorId:o.sourceNodeId===e.sourceNodeId))))return [];
        if(readable(d))automaticSources.push({field:f,candidate,evidence,availableAnchorIds:d.availableAnchorIds??[],sourceHash:d.sourceHash??''});
        return [{id:`${d.id}:${f.id}:${index}`,value:candidate.displayValue??candidateAdoptionValue(candidate),documentId:d.id,evidence,...(candidate.confidence!==undefined?{confidence:candidate.confidence}:{})}];
      }));
      // A missing business identity must not hide readable file evidence. Keep these
      // separate from attributable candidates, including in historical projections.
      const unassignedCandidates = object ? [] : relevant.flatMap(d => unassignedFieldCandidates(d,field.id).filter(c=>!candidateOwned(c,d)));
      const invalidReceipt=relevant.some(d=>d.invalidFieldIds?.some(id=>id==='*'||id===field.id));
      // A value is taken from the files that were read. A file that failed or was left out of the round no longer
      // withholds what the others say; a file still being processed does, because its value may differ.
      const waiting=relevant.some(d=>!d.parseRevision||['pending','running','registered','queued','configuration_required'].includes(d.state));
      const automatic=!fact&&!invalidReceipt&&object?.validity==='current'&&!state.readOnly&&!waiting&&relevant.some(readable)?automaticFieldFact(field,object,automaticSources,state.revision,owned.filter(({d})=>readable(d)).map(({f})=>f)):undefined;
      if(automatic?.fact)fact=automatic.fact;
      let status:ChecklistStatus='pending_confirmation',reason='请核对原文并确认事实。';
      if(fact?.validity==='current'&&fact.state==='not_applicable'){status='not_applicable';reason='本轮已明确确认不适用。';}
      else if(fact?.automaticAdoption&&fact.validity==='current'){status='extracted';reason='提取值已通过校验，直接用于后续检查。';}
      else if(fact?.validity==='current'&&['present','expected_blank'].includes(fact.state)&&fact.normalization.status!=='pending'){status='confirmed';reason='已有人工作出的事实确认；不代表规则检查通过。';}
      else if(fact){status=fact.validity==='stale'||['unreadable','redacted'].includes(fact.state)?'uncertain':'pending_confirmation';reason='已有事实仍需核对；缺失或待定不是确认通过。';}
      else if(object&&object.validity!=='current'){status='uncertain';reason='对象依据已失效，请重新确认归属。';}
      else if(!relevant.length&&types.length){status=unknown?'unprocessed':unassigned.length?'pending_confirmation':'missing_material';reason=unknown?'有尚未分类的材料，不能据此断定缺件。':unassigned.length?'已有对应类别材料，请确认材料归属和处理状态。':object?'本轮尚无归属于该对象的对应类别材料。':'本轮尚无对应类别材料。';}
      else if(!object){status='pending_confirmation';reason='对象尚未建立，以下是配置要求的待核对范围。';}
      else if(relevant.some(d=>['failed','canceled','stale'].includes(d.state))){status='uncertain';reason='对应材料处理失败、取消或来源已变化。';}
      else if(relevant.some(d=>!d.parseRevision||['pending','running','registered','queued','configuration_required'].includes(d.state))){status='unprocessed';reason='对应材料尚未处理完成。';}
      else if(relevant.some(d=>!d.adopted||!d.projectionCurrent)){status='pending_confirmation';reason=state.materialScope==='file-list'?'请核对材料类型及当前提取版本。':'请确认材料采用及当前提取版本。';}
      else if(invalidReceipt){status='pending_confirmation';reason='提取记录校验未通过，无法确定结果可靠，请核对原文或重新提取。';}
      else if(owned.some(({f})=>['failed','unsupported'].includes(f.semanticFilter?.state??''))){status='uncertain';reason='字段语义处理失败或暂不支持，请核对原文。';}
      else if(owned.some(({f})=>f.semanticFilter?.state==='pending')){status='unprocessed';reason='字段语义处理尚未完成。';}
      else if(candidates.length){reason=automatic?.reason??'当前历史记录未保存可直接采用的判定，请核对原文。';}
      else if(field.recipe.mode==='manual'){reason='此项需要人工核对或由审核时计算，不以自动提取替代。';}
      else if(owned.some(({f})=>['uncertain','unreadable','redacted'].includes(f.status))){status='uncertain';reason='提取存在歧义或原文无法辨认。';}
      else if(owned.length&&owned.every(({f})=>f.status==='not_found')&&relevant.every(d=>state.objects.filter(o=>o.kind===object.kind&&o.role===object.role&&assigned(d,o)).length===1)){status='not_found';reason='已处理的对应材料未提取到该字段；请核对原件。';}
      else if(owned.some(({f})=>f.candidates.length)){reason='文件中有候选，但尚无足够依据归属到此对象。';}
      else if(!owned.length){status='unprocessed';reason='尚无本字段的提取结果。';}
      else {reason='请核对对象范围和字段适用性；文件级缺失不能替代逐人核对。';}
      const guaranteeTypes=[...new Set(field.sourceIds.flatMap(id=>manifest.sources.filter(s=>s.id===id).map(s=>s.guaranteeType)))];
      return {id:`${object?.objectId??`pending:${field.objectKind}:${field.objectRole??''}`}:${field.id}`,fieldId:field.id,label:field.label,definition:field.semanticDefinition,
        objectId:object?.objectId??null,objectLabel:object?`${object.label} · ${object.objectId.slice(0,8)}`:'待建立对象',objectRole:object?.role??field.objectRole??null,
        guaranteeTypes,status,reason,unassignedCandidates,materialTypes:types.map(id=>({id,label:manifest.taxonomy.find(t=>t.id===id)?.label??id})),candidates,fact,
        confirmations:fact?(state.factRecords??[]).filter(r=>r.factId===fact.factId&&r.version===fact.version):[],
        rules:rules.map(r=>({id:r.id,label:r.label,text:r.description??r.label,sources:r.sourceIds.map(id=>manifest.sources.find(s=>s.id===id)?.reference??id)}))};
    });
  });
  return withRequirementInputDefaults(withGuaranteeAmountInputs(rows,manifest,state),manifest,state);
}
