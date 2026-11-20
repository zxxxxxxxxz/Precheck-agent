import type {DocumentFieldObservation} from '@hsbc/contracts/documents';
import {createSyntheticReviewConfigManifest,REVIEW_EXTRACTION_RECIPES} from '@hsbc/contracts/review-config';
import {anchorsForText,sha256} from '@hsbc/server/document/evidence';
import {buildDocumentFieldFilterFixture} from './field-filter-fixtures.js';
export const tablePartyName='Synthetic Insurance Company';
export function buildTablePartyFixture(options:{documentVersionId?:string;parseRevision?:string;caseId?:string;configurationSha256?:string;compositeCells?:boolean}={}){
 const name=tablePartyName,baseHtml=`<table><tr><td rowspan="2">被保险人</td><td>正式名称</td><td>${name}</td></tr><tr><td>地址</td><td>Public Street</td></tr><tr><td rowspan="2">投保人</td><td>正式名称</td><td>${name}</td></tr><tr><td>地址</td><td>Other Street</td></tr></table>`;
 const html=options.compositeCells?baseHtml.replaceAll(`<td>正式名称</td><td>${name}</td>`,`<td>正式名称：${name}\\n行业类型：合成</td><td>证件类型：合成编号</td>`):baseHtml;
 const f=buildDocumentFieldFilterFixture({id:'table-party',blocks:[html],candidates:[]}),page=f.pages[0]!;
 if(options.documentVersionId)page.scope.documentVersionId=page.page.document_version_id=options.documentVersionId;
 if(options.parseRevision)page.scope.parseRevision=page.page.parse_revision=options.parseRevision;
 if(options.caseId)page.scope.caseId=options.caseId;
 page.regions=[{...page.regions[0]!,source:'vl_ocr',kind:'table',document_version_id:page.scope.documentVersionId,parse_revision:page.scope.parseRevision}];
 page.canonicalRegionIds=page.regions.map(r=>r.region_id);page.anchors=[];
 const anchors=anchorsForText(page.page,page.regions,name),ids=anchors.map(a=>a.anchor_id),template=createSyntheticReviewConfigManifest().fields.find(d=>d.id==='borrower')!,recipe=REVIEW_EXTRACTION_RECIPES.find(r=>r.version==='azure-grounded-fields-v2')!;
 const definitions=['被保险人','投保人'].map((alias,i)=>({...template,id:i?'table_applicant':'table_insured',label:alias,aliases:[alias],valueKind:'party_name' as const,partyKinds:['organization' as const],objectKind:'party' as const,objectRole:'borrower' as const,taxonomyIds:['insurance_application'],recipe:{mode:'cloud_grounded_extract' as const,version:recipe.version,model:recipe.model,promptSha256:recipe.promptSha256}}));
 const fields:DocumentFieldObservation[]=definitions.map(d=>{const seed={rawValue:name,normalizedValue:name,anchorIds:ids,pageNumbers:[1],contextText:'正式名称 '+name,contextAnchorIds:[],evidenceSegments:[{rawValue:name,contextText:'正式名称 '+name,anchorIds:ids,contextAnchorIds:[],pageNumbers:[1]}],candidateId:`cloud-party-seed-${sha256(d.id).slice(0,32)}`};return {...f.bundle.fields[0]!,id:d.id+'-observation',documentVersionId:page.scope.documentVersionId,parseRevision:page.scope.parseRevision,fieldId:d.id,fieldLabel:d.label,candidates:[],rawValue:null,normalizedValue:null,anchorIds:[],pageNumbers:[],status:'uncertain',coverageGaps:['cloud_field_source_unverified'],semanticFilter:{version:'azure-grounded-fields-v2',model:'synthetic',state:'failed',originalCandidates:[seed],decisions:[{candidateId:seed.candidateId,decision:'rejected',anchorIds:ids,pageNumbers:[1]}],reasonCodes:['cloud_field_source_unverified']},extractionCoverage:{state:'incomplete',reviewedPageNumbers:[1],completion:'completed',reasonCodes:['cloud_field_source_unverified']}};});
 const input={fields,definitions,pages:[page],anchors,logicalDocuments:[{id:'insurance-table',labelId:'insurance_application',label:'Application',status:'candidate' as const,source:'classification' as const,pageNumbers:[1],regionIds:page.regions.map(r=>r.region_id)}],binding:{documentVersionId:page.scope.documentVersionId,parseRevision:page.scope.parseRevision,sourceSha256:page.scope.sourceSha256,inputSha256:sha256('input'),configurationSha256:options.configurationSha256??sha256('configuration'),responseSha256s:[sha256('first'),sha256('second')]}};
 return {input,page,html,name,fields};
}
