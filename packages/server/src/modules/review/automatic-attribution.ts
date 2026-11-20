import {createHash} from 'node:crypto';
import {candidateAdoptionValue,candidateRequiredEvidenceGroups,type DocumentFieldObservation} from '@hsbc/contracts/documents';
import {assessFieldQuality} from '@hsbc/contracts/field-quality';
import type {ReviewConfigManifest} from '@hsbc/contracts/review-config';
import {reviewEvidenceInScope,type ReviewEvidence,type ReviewObject,type ReviewState} from '@hsbc/contracts/review';
import type {ConfirmedSubject,SubjectCandidate,SubjectRole} from '@hsbc/contracts/review-subjects';
import {companyNameMeaning} from './company-name-meaning.js';
import type {ChecklistInputDocument} from './checklist.js';

const ordered=(value:unknown):unknown=>Array.isArray(value)?value.map(ordered):value&&typeof value==='object'?
  Object.fromEntries(Object.keys(value).sort().filter(k=>(value as Record<string,unknown>)[k]!==undefined).map(k=>[k,ordered((value as Record<string,unknown>)[k])])):value;
const hash=(value:unknown)=>createHash('sha256').update(JSON.stringify(ordered(value))).digest('hex');
const unique=<T>(items:T[])=>[...new Set(items)];
// Formatting equivalence only: no fuzzy names, transliteration, or filename inference.
const key=(value:string)=>value.normalize('NFKC').toUpperCase().replace(/\s+/gu,' ').trim();
const identifier=(value:string)=>key(value).replace(/[\s-]/gu,'');
const uuid=(value:unknown)=>{const h=hash(value);return `${h.slice(0,8)}-${h.slice(8,12)}-5${h.slice(13,16)}-a${h.slice(17,20)}-${h.slice(20,32)}`;};
const dedupeEvidence=(items:ReviewEvidence[])=>[...new Map(items.map(e=>[JSON.stringify(e),e])).values()];
type Candidate=DocumentFieldObservation['candidates'][number];
type Source={id:string;scope:string;document:ChecklistInputDocument;field:DocumentFieldObservation;candidate:Candidate;value:string;names:string[];evidence:ReviewEvidence[]};
type Policy={role:string;seedNames:string[];names:string[];identifiers:string[];common:string[]};
const policies:Policy[]=[
  {role:'corporate_guarantee',seedNames:['cgt_field_9'],
    names:['cgt_field_9','cgt_field_14','cgt_field_24','cgt_field_32','cgt_field_42','cgt_field_50','cgt_field_61','cgt_field_63','cgt_facility_guarantor'],
    identifiers:['cgt_field_11','cgt_field_41','cgt_field_49','cgt_field_60'],
    common:['cgt_facility_borrower','cgt_facility_lender','cgt_facility_name','cgt_facility_issue_date']},
  {role:'personal_guarantee',seedNames:['pg_field_5','pg_field_13'],
    names:['pg_field_5','pg_field_13','pg_field_28','pg_field_31','pg_identity_name','pg_facility_guarantor'],identifiers:['pg_field_14','pg_field_33','pg_identity_number'],
    common:['pg_field_4','pg_field_6','pg_field_9','pg_field_26','pg_field_29','pg_facility_lender','pg_facility_borrower']},
];

function sources(manifest:ReviewConfigManifest,documents:ChecklistInputDocument[],confirmedNames?:ReadonlyMap<string,ReadonlySet<string>>):Source[]{
  return documents.flatMap(document=>{
    if(!document.adopted||!document.projectionCurrent||!document.parseRevision||!document.directoryRevision||!document.sourceHash||document.unclassified||!['ready','partial'].includes(document.state))return [];
    return document.fields.flatMap(field=>{
      const definition=manifest.fields.find(f=>f.id===field.fieldId);
      if(!definition||definition.recipe.mode==='manual'||field.documentVersionId!==document.id||field.parseRevision!==document.parseRevision||document.invalidFieldIds?.some(id=>id==='*'||id===field.fieldId))return [];
      const quality=assessFieldQuality({...field,coverageGaps:field.coverageGaps.filter(code=>code!=='repeated_value_object_association_unconfirmed')},
        {multiple:true,valueGrounded:true,requireSemanticFilter:['cloud_grounded_extract','private_candidate_filter'].includes(definition.recipe.mode)});
      // A name the reviewer confirmed is usable for attribution even where extraction left several writings unresolved.
      const confirmed=quality.state==='usable'?undefined:confirmedNames?.get(policies.find(p=>p.names.includes(field.fieldId))?.role??'');
      if(quality.state!=='usable'&&!confirmed)return [];
      return field.candidates.flatMap((candidate,index)=>{
        const groups=candidateRequiredEvidenceGroups(candidate),value=candidateAdoptionValue(candidate).trim();
        if(confirmed&&!confirmed.has(key(value)))return [];
        if(!value||!groups.length||groups.some(g=>!g.length||g.some(id=>!document.availableAnchorIds?.includes(id))))return [];
        // A PDF value is placed by its pages. A Word value has no pages: it is placed by the source nodes it cites.
        const nodes=unique(groups.flat()).flatMap(id=>document.sourceNodes[id]?[document.sourceNodes[id]!]:[]);
        const scopes=document.logicalScopes?.filter(s=>candidate.pageNumbers.length?candidate.pageNumbers.every(page=>s.pageNumbers.includes(page)):
          nodes.length>0&&nodes.every(node=>s.sourceNodeIds?.includes(node)));
        if(scopes&&scopes.length!==1||!scopes&&document.taxonomyIds.length!==1)return [];
        // Starting a review re-checks scoped evidence; text another document owns is never attributed to this scope.
        const adopted=scopes?.[0]?.materialScope?scopes[0]:undefined;
        if(adopted&&unique(groups.flat()).some(id=>!reviewEvidenceInScope(adopted,document.sourceNodes[id]?undefined:document.anchorPlacements?.get(id),document.sourceNodes[id])))return [];
        const scope=scopes?.[0]?.id??document.id;
        const evidence=unique(groups.flat()).map(id=>({documentVersionId:document.id,parseRevision:document.parseRevision!,directoryRevision:document.directoryRevision,
          ...(scopes?.[0]?.materialScope?{materialScope:scopes[0].materialScope}:{}),
          ...(document.sourceNodes[id]?{sourceNodeId:document.sourceNodes[id]}:{anchorId:id})}));
        const association=candidate.nameAssociation;
        const aliases=association&&association.basis==='source_bilingual_pair'&&association.sourceNames?.length&&association.evidenceAnchorIds.length&&
          association.evidenceAnchorIds.every(id=>document.availableAnchorIds?.includes(id))&&association.sourceNames.every(n=>n.anchorIds.every(id=>document.availableAnchorIds?.includes(id)))
          ?association.sourceNames.map(n=>n.name):[];
        return [{id:`${document.id}:${field.id}:${index}`,scope,document,field,candidate,value,names:unique([value,...aliases].map(key)),evidence}];
      });
    });
  });
}
const local=(a:Source,b:Source)=>a.document.id===b.document.id&&a.scope===b.scope;
// entityKey/formRecord are local grouping evidence, never cross-file identities.
const record=(a:Source,b:Source)=>local(a,b)&&!!(a.candidate.entityKey&&a.candidate.entityKey===b.candidate.entityKey||
  a.candidate.formRecord&&a.candidate.formRecord.recordId===b.candidate.formRecord?.recordId);
type Identity={key:string;label:string;names:string[];number?:string;seeds:Source[]};

/** Derived, reproducible scopes. No human confirmation or identity record is
 * invented. Only draft/current inputs are projected; submitted snapshots stay fixed. */
export function automaticMaterialObjects(manifest:ReviewConfigManifest,state:Pick<ReviewState,'caseId'|'roundId'|'revision'|'readOnly'|'objects'>,documents:ChecklistInputDocument[]):ReviewObject[]{
  if(state.readOnly)return state.objects;
  const manual=state.objects.filter(o=>!o.automaticAttribution),all=sources(manifest,documents),result=[...manual];
  for(const policy of policies){
    if(!manifest.guaranteeTypes.includes(policy.role as 'corporate_guarantee'|'personal_guarantee'))continue;
    const explicit=manual.filter(o=>o.role===policy.role);
    const available=all.filter(s=>manifest.fields.some(f=>f.id===s.field.fieldId&&f.objectRole===policy.role));
    const seedSources=available.filter(s=>policy.seedNames.includes(s.field.fieldId)&&!/[;；、\r\n]/u.test(s.value));
    const identities=new Map<string,Identity>();
    for(const seed of seedSources){
      const names=seedSources.filter(s=>local(s,seed));
      const ids=available.filter(s=>policy.identifiers.includes(s.field.fieldId)&&local(s,seed));
      const paired=ids.filter(s=>record(s,seed));
      const numbers=unique((paired.length?paired:unique(names.flatMap(s=>s.names)).length===1?ids:[]).map(s=>identifier(s.value)));
      if(numbers.length>1)continue;
      const number=numbers[0],identityKey=JSON.stringify([policy.role,number??seed.names.slice().sort()]);
      const existing=identities.get(identityKey);
      if(existing){existing.seeds.push(seed);existing.names=unique([...existing.names,...seed.names]);}
      else identities.set(identityKey,{key:identityKey,label:seed.value,names:seed.names,number,seeds:[seed]});
    }
    // A name-only occurrence joins a numbered identity only if exactly one
    // identity matches. Two people sharing a name stay separate.
    for(const identity of [...identities.values()].filter(i=>!i.number)){
      const numbered=[...identities.values()].filter(i=>i.number&&i.names.some(n=>identity.names.includes(n)));
      if(numbered.length===1){numbered[0]!.seeds.push(...identity.seeds);identities.delete(identity.key);}
      else if(numbered.length>1)identities.delete(identity.key);
    }
    const people=[...identities.values()].filter(identity=>!identity.number||identity.seeds.every(seed=>seed.names.some(name=>identity.seeds[0]!.names.includes(name))));
    const objectId=(identity:Identity)=>uuid([state.caseId,state.roundId??null,identity.key]);
    // One identified subject only, and nobody confirmed by hand: files that name nobody belong to that subject.
    // Two or more identified subjects, or an unsplit list of names, never fall under this rule.
    // With no name at all no subject is invented: file-level comparisons rely on those files staying unassigned.
    const nameSources=available.filter(s=>policy.seedNames.includes(s.field.fieldId));
    const sole=!explicit.length&&people.length===1&&identities.size===1&&nameSources.length===seedSources.length;
    const covers=(object:ReviewObject,source:Source)=>source.evidence.every(e=>object.evidence.some(o=>hash(e)===hash(o)));
    // Keep every identity in local matching, including manually corrected ones.
    // Removing A from a joint document would falsely make B its sole owner.
    const suppressed=new Set(people.filter(identity=>explicit.some(object=>object.objectId===objectId(identity)||identity.seeds.some(seed=>
      object.evidence.some(e=>e.documentVersionId===seed.document.id)&&
      (covers(object,seed)||people.filter(p=>p.seeds.some(s=>local(s,seed))).length===1)))));
    const matchName=(source:Source)=>people.filter(i=>source.names.some(n=>i.names.includes(n)));
    const boundNames=new Map<string,Identity>();
    for(const source of available.filter(s=>policy.names.includes(s.field.fieldId))){
      let matches=matchName(source);
      const ids=available.filter(s=>policy.identifiers.includes(s.field.fieldId)&&local(s,source));
      const paired=ids.filter(s=>record(s,source));
      const localNames=available.filter(s=>policy.names.includes(s.field.fieldId)&&local(s,source));
      const numbers=unique((paired.length?paired:unique(localNames.flatMap(s=>s.names)).length===1?ids:[]).map(s=>identifier(s.value)));
      if(numbers.length>1)continue;
      if(numbers.length)matches=matches.filter(i=>!i.number||i.number===numbers[0]);
      if(matches.length===1)boundNames.set(source.id,matches[0]!);
    }
    for(const identity of people){
      if(suppressed.has(identity))continue;
      const selected:Source[]=[];
      for(const source of available){
        const localNames=available.filter(s=>policy.names.includes(s.field.fieldId)&&local(s,source));
        // A file that names nobody belongs to the only subject there is.
        if(!localNames.length){if(sole&&!explicit.some(o=>o.evidence.some(e=>e.documentVersionId===source.document.id)))selected.push(source);continue;}
        const owners=unique(localNames.flatMap(s=>boundNames.has(s.id)?[boundNames.get(s.id)!]:[]));
        const namesResolved=localNames.every(s=>boundNames.has(s.id));
        if(!owners.includes(identity))continue;
        const claims=explicit.filter(o=>o.evidence.some(e=>e.documentVersionId===source.document.id));
        if(claims.length&&(owners.length===1||!policy.common.includes(source.field.fieldId)&&claims.some(o=>covers(o,source))))continue;
        if(policy.names.includes(source.field.fieldId)){
          if(boundNames.get(source.id)===identity)selected.push(source);
          continue;
        }
        const records=localNames.filter(s=>record(s,source));
        const recordOwners=unique(records.flatMap(s=>boundNames.has(s.id)?[boundNames.get(s.id)!]:[]));
        if(records.length){if(records.every(s=>boundNames.has(s.id))&&recordOwners.length===1&&recordOwners[0]===identity)selected.push(source);continue;}
        if(namesResolved&&owners.length===1){selected.push(source);continue;}
        // Only genuinely document-wide fields may be shared. Amounts, personal
        // addresses, IDs and signatures require a bounded source record.
        if(namesResolved&&policy.common.includes(source.field.fieldId))selected.push(source);
      }
      const basis=identity.seeds.filter(s=>selected.includes(s));
      if(!basis.length)continue;
      const evidence=dedupeEvidence(selected.flatMap(s=>s.evidence)),candidateIds=selected.map(s=>s.id).sort();
      const sourceHashes=unique(selected.map(s=>s.document.sourceHash!)).sort();
      result.push({objectId:objectId(identity),kind:'guarantee',role:policy.role,label:identity.label,
        relations:[],evidence,version:1,validity:'current',confirmedBy:null,caseRevision:state.revision,
        automaticAttribution:{policyVersion:'source-party-attribution-v1',identityKey:hash(identity.key),candidateIds,sourceHashes,
          basis:dedupeEvidence(basis.flatMap(s=>s.evidence)),inputHash:hash([candidateIds,evidence,sourceHashes])}});
    }
  }
  return result;
}

const usableDocument=(document:ChecklistInputDocument)=>!!document.parseRevision&&!!document.directoryRevision&&['ready','partial'].includes(document.state);
/** Every writing of a guarantor name found in the round's files, whatever its extraction quality.
 * Nothing is decided here: the reviewer picks the subjects and says which writings are the same one. */
export function subjectCandidates(manifest:ReviewConfigManifest,documents:ChecklistInputDocument[]):SubjectCandidate[]{
  const found=new Map<string,SubjectCandidate>();
  for(const policy of policies){
    if(!manifest.guaranteeTypes.includes(policy.role as SubjectRole))continue;
    for(const document of documents.filter(usableDocument))for(const field of document.fields){
      if(!policy.names.includes(field.fieldId)||field.documentVersionId!==document.id||field.parseRevision!==document.parseRevision)continue;
      const fieldLabel=manifest.fields.find(f=>f.id===field.fieldId)?.label??field.fieldLabel;
      for(const candidate of field.candidates){
        for(const name of candidateAdoptionValue(candidate).split(/[;；]+/u).map(part=>part.trim()).filter(Boolean)){
          if(name.length>300)continue;
          const id=JSON.stringify([policy.role,key(name)]),entry=found.get(id)??{role:policy.role as SubjectRole,name,suggested:false,sources:[]};
          entry.suggested||=policy.seedNames.includes(field.fieldId);
          if(!entry.sources.some(source=>source.documentId===document.id&&source.fieldLabel===fieldLabel))entry.sources.push({documentId:document.id,filename:document.filename,fieldLabel});
          found.set(id,entry);
        }
      }
    }
  }
  const candidates=[...found.values()].sort((a,b)=>a.role.localeCompare(b.role)||Number(b.suggested)-Number(a.suggested)||a.name.localeCompare(b.name));
  // Writings of one company in different arrangements are offered as one subject, under the fullest writing.
  for(const role of new Set(candidates.map(candidate=>candidate.role))){
    const own=candidates.filter(candidate=>candidate.role===role).map(candidate=>({candidate,meaning:companyNameMeaning(candidate.name)}));
    for(const {candidate,meaning} of own){
      if(!meaning)continue;
      const same=own.filter(other=>other.meaning&&other.meaning.english===meaning.english);
      const chinese=new Set(same.flatMap(other=>other.meaning!.chinese?[other.meaning!.chinese]:[]));
      if(same.length<2||chinese.size>1)continue;
      const primary=same.map(other=>other.candidate).sort((a,b)=>Number(b.suggested)-Number(a.suggested)||b.name.length-a.name.length||a.name.localeCompare(b.name))[0]!;
      if(primary!==candidate)candidate.sameAs=primary.name;
    }
  }
  return candidates;
}
/** Attaches the round's files to the subjects the reviewer confirmed. A file goes to the subject whose confirmed
 * writings it names; a file that names nobody goes to the role's only subject; with several subjects it stays unattached.
 * Before confirmation nothing is attached. Subjects confirmed by hand as review objects keep precedence. */
export function confirmedSubjectObjects(manifest:ReviewConfigManifest,state:Pick<ReviewState,'caseId'|'roundId'|'revision'|'readOnly'|'objects'>,documents:ChecklistInputDocument[],subjects:readonly ConfirmedSubject[]):ReviewObject[]{
  if(state.readOnly)return state.objects;
  const manual=state.objects.filter(o=>!o.automaticAttribution),result=[...manual];
  const confirmedNames=new Map<string,Set<string>>();
  for(const subject of subjects)confirmedNames.set(subject.role,new Set([...(confirmedNames.get(subject.role)??[]),...subject.names.map(key)]));
  const all=sources(manifest,documents,confirmedNames);
  for(const policy of policies){
    const own=subjects.filter(subject=>subject.role===policy.role);
    if(!own.length||!manifest.guaranteeTypes.includes(policy.role as SubjectRole))continue;
    const explicit=manual.filter(o=>o.role===policy.role);
    const available=all.filter(s=>manifest.fields.some(f=>f.id===s.field.fieldId&&f.objectRole===policy.role));
    const names=new Map(own.map(subject=>[subject.id,new Set(subject.names.map(key))]));
    const owner=(source:Source)=>{const matches=own.filter(subject=>source.names.some(name=>names.get(subject.id)!.has(name)));return matches.length===1?matches[0]!:undefined;};
    const bound=new Map<string,ConfirmedSubject>();
    for(const source of available.filter(s=>policy.names.includes(s.field.fieldId))){const subject=owner(source);if(subject)bound.set(source.id,subject);}
    for(const subject of own){
      const selected:Source[]=[];
      for(const source of available){
        if(explicit.some(o=>o.evidence.some(e=>e.documentVersionId===source.document.id)))continue;
        const localNames=available.filter(s=>policy.names.includes(s.field.fieldId)&&local(s,source));
        const owners=unique(localNames.flatMap(s=>bound.has(s.id)?[bound.get(s.id)!]:[]));
        if(policy.names.includes(source.field.fieldId)){if(bound.get(source.id)===subject)selected.push(source);continue;}
        // A file that names none of the confirmed subjects belongs to the only subject of its role.
        if(!owners.length){if(own.length===1)selected.push(source);continue;}
        if(!owners.includes(subject))continue;
        const records=localNames.filter(s=>record(s,source)&&bound.has(s.id));
        if(records.length){if(records.every(s=>bound.get(s.id)===subject))selected.push(source);continue;}
        // Amounts, addresses, numbers and signatures of a file shared by several subjects need their own record.
        if(owners.length===1||policy.common.includes(source.field.fieldId))selected.push(source);
      }
      if(!selected.length)continue;
      const named=selected.filter(s=>policy.names.includes(s.field.fieldId)),basis=named.length?named:selected;
      const evidence=dedupeEvidence(selected.flatMap(s=>s.evidence)),candidateIds=selected.map(s=>s.id).sort(),sourceHashes=unique(selected.map(s=>s.document.sourceHash!)).sort();
      const identityKey=JSON.stringify([policy.role,'confirmed',subject.id]);
      result.push({objectId:uuid([state.caseId,state.roundId??null,identityKey]),kind:'guarantee',role:policy.role,label:subject.label,
        relations:[],evidence,version:1,validity:'current',confirmedBy:null,caseRevision:state.revision,
        automaticAttribution:{policyVersion:'source-party-attribution-v1',identityKey:hash(identityKey),candidateIds,sourceHashes,
          basis:dedupeEvidence(basis.flatMap(s=>s.evidence)),inputHash:hash([candidateIds,evidence,sourceHashes]),confirmedSubjectId:subject.id}});
    }
  }
  return result;
}
