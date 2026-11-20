import type {DocumentBundle,DocumentFieldObservation,DocumentPageArtifact} from '@hsbc/contracts/documents';
import type {EvidenceAnchor} from '@hsbc/contracts/evidence';
import {createSyntheticReviewConfigManifest,REVIEW_EXTRACTION_RECIPES,type ReviewFieldDefinition} from '@hsbc/contracts/review-config';
import {anchorsForText,sha256} from '@hsbc/server/document/evidence';
import {buildDocumentFieldFilterFixture} from './field-filter-fixtures.js';

interface FixtureInput {
  fields:DocumentFieldObservation[];definitions:ReviewFieldDefinition[];pages:DocumentPageArtifact[];
  anchors:EvidenceAnchor[];targetFields:{scope:string;signingConditions:string};
  logicalDocuments:DocumentBundle['logicalDocuments'];
  binding:NonNullable<DocumentFieldObservation['candidates'][number]['authorizationEvidence']>['binding'];
}
export const authorizationExclusion='(other than the Compliance Letter, any such financing instrument set out above, a “Finance Instrument”, and collectively, the “Finance Instruments”).';
export const authorizationSealing='23. THAT authorisation be and is hereby given for the Common Seal of the Corporation to be affixed, where required, in accordance with the articles of association of the Corporation to the Finance Instruments and any document relating to the Financing (including any amendments thereto, where required);';
const use='24. THAT any Director may sign the Finance Instruments acting singly;';
export function buildAuthorizationSourceFixture(options:{documentVersionId?:string;parseRevision?:string;caseId?:string;configurationSha256?:string}={}){
  const f=buildDocumentFieldFilterFixture({id:'authorization-source-fixture',blocks:[authorizationExclusion],candidates:[authorizationExclusion]});
  const page=f.pages[0]!;
  if(options.documentVersionId)page.scope.documentVersionId=page.page.document_version_id=options.documentVersionId;
  if(options.parseRevision)page.scope.parseRevision=page.page.parse_revision=options.parseRevision;
  if(options.caseId)page.scope.caseId=options.caseId;
  const base={...page.regions[0]!,document_version_id:page.scope.documentVersionId,parse_revision:page.scope.parseRevision};
  page.regions=[{...base,kind:'text',source:'vl_ocr',raw_text:authorizationExclusion,raw_text_sha256:sha256(authorizationExclusion)}];
  page.canonicalRegionIds=page.regions.map(r=>r.region_id);page.anchors=[];
  const next=structuredClone(page);next.page.page_number=2;next.page.page_asset_id+=':next';
  next.regions=[authorizationSealing,use].map((text,index)=>({...base,kind:'text' as const,source:'vl_ocr' as const,
    region_id:base.region_id+':next:'+index,source_id:base.source_id+':next:'+index,page_asset_id:next.page.page_asset_id,
    raw_text:text,raw_text_sha256:sha256(text)}));next.canonicalRegionIds=next.regions.map(r=>r.region_id);
  const seed=(text:string,index:number)=>{
    const anchors=anchorsForText(next.page,[next.regions[index]!],text),ids=anchors.map(a=>a.anchor_id);
    return {anchors,candidate:{rawValue:text,normalizedValue:null,anchorIds:ids,pageNumbers:[2],
      evidenceSegments:[{rawValue:text,contextText:text,anchorIds:ids,contextAnchorIds:ids,pageNumbers:[2]}]}};
  };
  const a=seed(authorizationSealing,0),b=seed(use,1);
  const template=createSyntheticReviewConfigManifest().fields.find(field=>field.id==='borrower')!;
  const recipe=REVIEW_EXTRACTION_RECIPES.find(item=>item.version==='azure-grounded-fields-v2')!;
  const definition=(id:string)=>({...template,id,label:id==='powers'?'Authorization scope':'Signing formalities',
    aliases:id==='powers'?['authorised transactions','defined documents']:['seal','signing conditions'],
    semanticDefinition:id==='powers'?'Explicitly authorised documents and their source exclusions.':'Explicit signing and sealing requirements with all source conditions.',
    objectKind:'signatory' as const,objectRole:'authorization_scope',
    valueKind:'text' as const,valueMultiplicity:'clauses' as const,taxonomyIds:['authorization'],
    recipe:{mode:'cloud_grounded_extract' as const,version:recipe.version,model:recipe.model,promptSha256:recipe.promptSha256}});
  const common={...f.bundle.fields[0]!,documentVersionId:page.scope.documentVersionId,parseRevision:page.scope.parseRevision,
    status:'uncertain' as const,rawValue:null,normalizedValue:null,pageNumbers:[],anchorIds:[],candidates:[],
    extractionCoverage:{reviewedPageNumbers:[1,2],state:'complete' as const,completion:'completed' as const,reasonCodes:[]},
    semanticFilter:{version:'azure-grounded-fields-v2' as const,state:'completed' as const,model:'gpt-6-astra',
      originalCandidates:[],decisions:[],reasonCodes:[]},coverageGaps:[]};
  const scope:DocumentFieldObservation={...common,id:'scope-observation',fieldId:'powers',fieldLabel:'Powers',
    candidates:[a.candidate,b.candidate],semanticFilter:{...common.semanticFilter,
      originalCandidates:[{...a.candidate,candidateId:'model-seal'},{...b.candidate,candidateId:'model-use'}],
      decisions:[{candidateId:'model-seal',decision:'selected',anchorIds:a.candidate.anchorIds,pageNumbers:[2]},
        {candidateId:'model-use',decision:'selected',anchorIds:b.candidate.anchorIds,pageNumbers:[2]}]}};
  const signing:DocumentFieldObservation={...common,id:'signing-observation',fieldId:'formalities',fieldLabel:'Formalities'};
  const input:FixtureInput={fields:[scope,signing],definitions:[definition('powers'),definition('formalities')],
    pages:[page,next],anchors:[...a.anchors,...b.anchors],targetFields:{scope:'powers',signingConditions:'formalities'},
    logicalDocuments:[{id:'one-resolution',labelId:'authorization',label:'Resolution',status:'candidate',source:'classification',
      pageNumbers:[1,2],regionIds:[...page.regions,...next.regions].map(r=>r.region_id)}],
    binding:{documentVersionId:page.scope.documentVersionId,parseRevision:page.scope.parseRevision,sourceSha256:page.scope.sourceSha256,
      inputSha256:sha256('frozen input'),configurationSha256:options.configurationSha256??sha256('published config'),responseSha256s:[sha256('first response'),sha256('second response')],
      scopeFieldId:'powers',signingConditionsFieldId:'formalities'}};
  return {input,page,next,scope,signing};
}
