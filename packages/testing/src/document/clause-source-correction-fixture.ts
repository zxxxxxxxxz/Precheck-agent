import type {DocumentBundle,DocumentFieldObservation,DocumentPageArtifact} from '@hsbc/contracts/documents';
import type {EvidenceAnchor} from '@hsbc/contracts/evidence';
import {createSyntheticReviewConfigManifest,REVIEW_EXTRACTION_RECIPES,type ReviewFieldDefinition} from '@hsbc/contracts/review-config';
import {anchorsForText,sha256} from '@hsbc/server/document/evidence';
import {buildDocumentFieldFilterFixture} from './field-filter-fixtures.js';
interface FixtureInput {
  fields:DocumentFieldObservation[];definitions:ReviewFieldDefinition[];pages:DocumentPageArtifact[];
  logicalDocuments:DocumentBundle['logicalDocuments'];anchors:EvidenceAnchor[];
  binding:NonNullable<DocumentFieldObservation['candidates'][number]['sourceCorrectionEvidence']>['binding'];
}

export const correctClauseLine='依照本决议授权董事共同签订协议并且核验本交易全部必要条件。';
export const inaccurateClauseLine=correctClauseLine.replace('协议','协仪');
export function buildClauseSourceCorrectionFixture(options:{documentVersionId?:string;parseRevision?:string;caseId?:string;configurationSha256?:string}={}){
  const values=['第一项完整条款。','第二项开始。'+inaccurateClauseLine+'第二项结尾。','第三项独立条件。','第四项附带限制。'];
  const f=buildDocumentFieldFilterFixture({id:'independent-line',blocks:[values.join('\n')],candidates:[],fieldId:'powers'});
  const page=f.pages[0]!;
  if(options.documentVersionId)page.scope.documentVersionId=page.page.document_version_id=options.documentVersionId;
  if(options.parseRevision)page.scope.parseRevision=page.page.parse_revision=options.parseRevision;
  if(options.caseId)page.scope.caseId=options.caseId;
  const base={...page.regions[0]!,document_version_id:page.scope.documentVersionId,parse_revision:page.scope.parseRevision};
  const polygon=(x:number,y:number,w:number,h:number):[number,number][]=>[[x,y],[x+w,y],[x+w,y+h],[x,y+h]];
  page.regions=[{...base,source:'vl_ocr',polygons:[polygon(20,30,550,300)]},
    {...base,region_id:'native-line',source_id:'native-engine',source:'native_pdf',raw_text:correctClauseLine,raw_text_sha256:sha256(correctClauseLine),polygons:[polygon(40,90,490,14)]},
    {...base,region_id:'pp-line',source_id:'pp-engine',source:'pp_ocr',raw_text:correctClauseLine,raw_text_sha256:sha256(correctClauseLine),polygons:[polygon(40,90,490,14)]}];
  page.canonicalRegionIds=[base.region_id,'native-line'];page.anchors=[];
  const segments=values.map(rawValue=>{
    const anchors=anchorsForText(page.page,[page.regions[0]!],rawValue),ids=anchors.map(a=>a.anchor_id);
    page.anchors.push(...anchors);
    return {rawValue,contextText:rawValue,anchorIds:ids,contextAnchorIds:ids,pageNumbers:[1]};
  });
  const candidate={rawValue:values[0]!,normalizedValue:null,evidenceSegments:segments,
    anchorIds:segments.flatMap(s=>s.anchorIds),pageNumbers:[1],
    structuredValue:{kind:'authorization_clause' as const,association:'candidate' as const,
      components:[{role:'action' as const,value:inaccurateClauseLine,normalizedValue:null,anchorIds:segments[1]!.anchorIds,pageNumbers:[1]}]}};
  const field:DocumentFieldObservation={...f.bundle.fields[0]!,documentVersionId:page.scope.documentVersionId,parseRevision:page.scope.parseRevision,valueMultiplicity:'clauses',candidates:[candidate],
    anchorIds:candidate.anchorIds,pageNumbers:[1],coverageGaps:[],
    extractionCoverage:{reviewedPageNumbers:[1],state:'complete',completion:'completed',reasonCodes:[]},
    semanticFilter:{version:'azure-grounded-fields-v2',state:'completed',model:'synthetic-model',
      originalCandidates:[{...candidate,candidateId:'model-1'}],decisions:[{candidateId:'model-1',decision:'selected',anchorIds:candidate.anchorIds,pageNumbers:[1]}],reasonCodes:[]}};
  const template=createSyntheticReviewConfigManifest().fields.find(d=>d.id==='borrower')!;
  const recipe=REVIEW_EXTRACTION_RECIPES.find(item=>item.version==='azure-grounded-fields-v2')!;
  const input:FixtureInput={fields:[field],pages:[page],anchors:page.anchors,
    definitions:[{...template,id:'powers',label:'Authorization scope',aliases:['authorised transactions'],objectKind:'signatory',objectRole:'authorization_scope',valueKind:'text',valueMultiplicity:'clauses',taxonomyIds:['authorization'],
      recipe:{mode:'cloud_grounded_extract',version:recipe.version,model:recipe.model,promptSha256:recipe.promptSha256}}],
    logicalDocuments:[{id:'one',labelId:'authorization',label:'Synthetic',status:'candidate',source:'classification',
      pageNumbers:[1],regionIds:page.regions.map(r=>r.region_id)}],
    binding:{documentVersionId:page.scope.documentVersionId,parseRevision:page.scope.parseRevision,sourceSha256:page.scope.sourceSha256,
      inputSha256:sha256('input'),configurationSha256:options.configurationSha256??sha256('config'),responseSha256s:[sha256('first'),sha256('second')]}};
  return {input,page,field,values,candidate};
}
