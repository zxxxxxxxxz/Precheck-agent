import {isDeepStrictEqual} from 'node:util';
import {SourceCorrectionBindingSchema, type DocumentBundle, type DocumentFieldObservation, type DocumentPageArtifact} from '@hsbc/contracts/documents';
import type {DocumentRegion, EvidenceAnchor} from '@hsbc/contracts/evidence';
import type {ReviewFieldDefinition} from '@hsbc/contracts/review-config';
import {anchorsForText, sha256, validateAnchorSource} from '../../document/evidence.js';
import {codePointSlice} from '../../document/geometry.js';
import {documentHtmlCellSpans} from '../../document/html-cells.js';
import {normalizeDocumentV2Value} from './field-values.js';

type Candidate=DocumentFieldObservation['candidates'][number];
type Binding=NonNullable<Candidate['sourceCorrectionEvidence']>['binding'];
type Component=NonNullable<Candidate['structuredValue']>['components'][number];
type Cell={start:number;end:number;text:string;attributes:string};
type Row={index:number;cells:Cell[]};
type Table={page:DocumentPageArtifact;region:DocumentRegion;header:Row;rows:Row[];name:number;amount:number;ordinal:number;currency:number};
const methodVersion='insurance-table-structure.v2' as const;
const unique=<T>(values:T[])=>[...new Set(values)];
const spaces=(value:string)=>value.replace(/\s+/gu,'').trim();
const column=(value:string)=>value.trim().toLowerCase();
const headers={
  name:['附加险名称','附加險名稱','extension name','insurance extension'],
  amount:['保险金额','保險金額','sum insured','insurance amount'],
  ordinal:['序号','序號','no.','no'],
  currency:['币种','幣種','currency'],
};

export interface InsuranceTableStructureInput {
  fields:DocumentFieldObservation[];definitions:ReviewFieldDefinition[];pages:DocumentPageArtifact[];
  logicalDocuments:DocumentBundle['logicalDocuments'];anchors:EvidenceAnchor[];binding:Binding;
}
export interface InsuranceTableStructureReceipt {
  methodVersion:typeof methodVersion;binding:Binding;
  entries:Array<{
    fieldId:string;sourceCandidateIds:string[];candidateSha256:string;logicalDocumentId:string;pageNumber:number;
    tableRegionId:string;tableTextSha256:string;rowIndex:number;headerAnchorIds:string[];originalRowAnchorIds:string[];
    components:Array<{role:Component['role'];valueSha256:string;sourceAnchorIds:string[];tableCellAnchorIds:string[];
      nativeTemplate?:{before:{valueSha256:string;anchorIds:string[]};after:{valueSha256:string;anchorIds:string[]};
        unverified:{offset:number;length:number;unit:'unicode_code_point';kind:'literal_underscore'};noBlankStateAssertion:true}}>;
    omittedComponents?:Array<{role:'insurance_name';reason:'source_disagreement';originalSourceAnchorIds:string[];tableCellAnchorIds:string[];
      nativeTemplate:NonNullable<InsuranceTableStructureReceipt['entries'][number]['components'][number]['nativeTemplate']>}>;
    currency:{basis:'row_literal'|'explicit_insured_currency'|'not_established';sourceFieldId?:string;sourceCandidateIds?:string[];
      logicalDocumentId?:string;labelAnchorIds?:string[];valueAnchorIds?:string[]};
  }>;
}

/** HTML establishes a column relation only. All offsets refer to untouched text;
 * cell geometry is never invented from an HTML row/column index. */
function rows(raw:string):Row[] {
  const spans=documentHtmlCellSpans(raw);
  if(!spans.length)return[];
  const result:Row[]=[];
  for(const match of raw.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr\s*>/giu)){
    const start=match.index+match[0].indexOf('>')+1,end=match.index+match[0].lastIndexOf('</');
    const cells=spans.filter(span=>span.start>=start&&span.end<=end).map(span=>{
      const open=raw.slice(0,span.start).match(/<t[dh]\b([^>]*)>$/iu);
      return {...span,text:raw.slice(span.start,span.end),attributes:open?.[1]?.trim()??'invalid'};
    });
    if(!cells.length||cells.some(cell=>/[<&]/u.test(cell.text)))return[];
    result.push({index:result.length,cells});
  }
  return result.length<=2000&&result.flatMap(row=>row.cells).length===spans.length?result:[];
}
function cleanCell(cell:Cell):boolean {return !cell.attributes&&!!cell.text.trim()&&cell.text.length<=8000;}
function parseTable(page:DocumentPageArtifact,region:DocumentRegion):Table|undefined {
  if(region.kind!=='table'||region.source!=='vl_ocr'||!page.canonicalRegionIds.includes(region.region_id)||
    !readySource(page,region)||!region.raw_text)return;
  const tableRows=rows(region.raw_text),matches=tableRows.flatMap(header=>{
    if(!header.cells.every(cleanCell))return[];
    const indices=Object.fromEntries(Object.entries(headers).map(([key,labels])=>[key,header.cells.flatMap((cell,index)=>
      labels.includes(column(cell.text))?[index]:[])])) as Record<keyof typeof headers,number[]>;
    if(indices.name.length!==1||indices.amount.length!==1||indices.ordinal.length>1||indices.currency.length>1)return[];
    const recognized=Object.values(indices).flat();
    if(recognized.length!==header.cells.length||new Set(recognized).size!==recognized.length)return[];
    return[{page,region,header,rows:tableRows.filter(row=>row.index>header.index),name:indices.name[0]!,amount:indices.amount[0]!,
      ordinal:indices.ordinal[0]??-1,currency:indices.currency[0]??-1}];
  });
  return matches.length===1?matches[0]:undefined;
}
function readySource(page:DocumentPageArtifact,region:DocumentRegion,allowUntrustedNative=false):boolean {
  return page.status!=='failed'&&region.processing_status==='ready'&&!!region.raw_text&&
    region.raw_text_sha256===sha256(region.raw_text)&&region.document_version_id===page.scope.documentVersionId&&
    region.parse_revision===page.scope.parseRevision&&region.page_asset_id===page.page.page_asset_id&&
    page.page.document_version_id===page.scope.documentVersionId&&page.page.parse_revision===page.scope.parseRevision&&
    page.page.source_sha256===page.scope.sourceSha256&&region.polygons.length===1&&
    !page.conflicts.some(conflict=>conflict.region_ids.includes(region.region_id))&&
    (region.source!=='native_pdf'||page.nativeTrust==='validated_geometry_and_visibility'||
      allowUntrustedNative&&page.nativeTrust==='requires_validation');
}
function bounds(polygons:EvidenceAnchor['polygons']) {
  const points=polygons.flat();
  return points.length?{left:Math.min(...points.map(point=>point[0])),right:Math.max(...points.map(point=>point[0])),
    top:Math.min(...points.map(point=>point[1])),bottom:Math.max(...points.map(point=>point[1]))}:undefined;
}
function cellAnchors(table:Table,cell:Cell):EvidenceAnchor[] {
  const text=cell.text.trim(),trimStart=cell.text.indexOf(text),offset=[...table.region.raw_text!.slice(0,cell.start+trimStart)].length;
  try{
    // A literal that repeats in other rows remains a block-level location; the
    // immutable offset selects this cell without claiming word-level geometry.
    return anchorsForText(table.page.page,[table.region],text).filter(anchor=>
      anchor.text_span_refs.length===1&&anchor.text_span_refs[0]!.offset===offset);
  }catch{return[];}
}
function anchorText(anchor:EvidenceAnchor,page:DocumentPageArtifact,allowUntrustedNative=false):string|undefined {
  if(anchor.text_span_refs.length!==1||anchor.block_ids.length!==1||anchor.localization_status==='unavailable'||
    anchor.localization_status==='ambiguous'||anchor.polygons.length!==1)return;
  const span=anchor.text_span_refs[0]!,region=page.regions.find(item=>item.region_id===span.block_id);
  if(!region||!readySource(page,region,allowUntrustedNative)||region.kind!=='text'||!['native_pdf','pp_ocr'].includes(region.source)||
    span.block_id!==anchor.block_ids[0])return;
  try{
    validateAnchorSource(anchor,page.page,page.regions);
    const value=codePointSlice(region.raw_text!,span.offset,span.length);
    // Reject manually altered geometry/IDs even if they refer to a real block.
    const expected=anchorsForText(page.page,[region],value);
    if(!expected.some(item=>isDeepStrictEqual(item,anchor)))return;
    return value;
  }catch{return;}
}
/** An unvalidated native layer is not evidence of visible print. Require an
 * independent exact private OCR line at the same original location; use that
 * OCR's own anchor in the component without changing page.nativeTrust. */
function corroboratedCell(anchor:EvidenceAnchor,page:DocumentPageArtifact,text:string):EvidenceAnchor[] {
  const literal=anchorText(anchor,page,true);
  if(literal!==text)return[];
  const region=page.regions.find(item=>item.region_id===anchor.block_ids[0])!;
  if(region.source!=='native_pdf'||page.nativeTrust==='validated_geometry_and_visibility')return[anchor];
  const nativeBox=bounds(anchor.polygons)!;
  const matches=page.regions.filter(item=>{
    if(item.source!=='pp_ocr'||item.source_id===region.source_id||item.kind!=='text'||item.raw_text?.trim()!==text||!readySource(page,item))return false;
    const box=bounds(item.polygons)!;
    const intersection=Math.max(0,Math.min(box.right,nativeBox.right)-Math.max(box.left,nativeBox.left))*
      Math.max(0,Math.min(box.bottom,nativeBox.bottom)-Math.max(box.top,nativeBox.top));
    const union=(box.right-box.left)*(box.bottom-box.top)+(nativeBox.right-nativeBox.left)*(nativeBox.bottom-nativeBox.top)-intersection;
    return union>0&&intersection/union>=0.5;
  });
  try{
    return unique(matches.flatMap(item=>anchorsForText(page.page,[item],text)).filter(item=>
      item.localization_status==='block_only'&&item.polygons.length===1));
  }catch{return[];}
}
function nativeTemplate(anchor:EvidenceAnchor,page:DocumentPageArtifact,tableText:string):{
  value:string;anchors:EvidenceAnchor[];nameSupported:boolean;proof:NonNullable<InsuranceTableStructureReceipt['entries'][number]['components'][number]['nativeTemplate']>;
}|undefined {
  const value=anchorText(anchor,page,true),region=page.regions.find(item=>item.region_id===anchor.block_ids[0]);
  if(!value||region?.source!=='native_pdf')return;
  const parts=/^([^_\r\n]{2,200})(_{2,20})([^_\r\n]{2,200})$/u.exec(value);
  if(!parts||!tableText.startsWith(parts[1]!)||!tableText.endsWith(parts[3]!))return;
  const middle=tableText.slice(parts[1]!.length,tableText.length-parts[3]!.length);
  if(!middle||middle.length>20)return;
  // A competing recognizable letter or numeral is not noise (including Han
  // number words and Roman numerals). Only independently supported amount and
  // currency may then receive structure; the original name stays unresolved.
  const nameSupported=!/[\p{L}\p{N}]/u.test(middle);
  const nativeBox=bounds(anchor.polygons)!;
  const edgeAllowance=(nativeBox.bottom-nativeBox.top)/4;
  const locate=(text:string)=>page.regions.filter(item=>{
    if(item.source!=='pp_ocr'||item.source_id===region.source_id||item.kind!=='text'||item.raw_text?.trim()!==text||!readySource(page,item))return false;
    const box=bounds(item.polygons)!;
    return box.left>=nativeBox.left-edgeAllowance&&box.right<=nativeBox.right+edgeAllowance&&
      Math.min(box.bottom,nativeBox.bottom)-Math.max(box.top,nativeBox.top)>=Math.min(box.bottom-box.top,nativeBox.bottom-nativeBox.top)*0.5;
  }).flatMap(item=>anchorsForText(page.page,[item],text)).filter(item=>item.localization_status==='block_only');
  try{
    const before=locate(parts[1]!),after=locate(parts[3]!);
    if(before.length!==1||after.length!==1)return;
    const left=bounds(before[0]!.polygons)!,right=bounds(after[0]!.polygons)!;
    if(left.left>=right.left||left.right>=right.right||
      Math.max(0,left.right-right.left)>Math.min(left.right-left.left,right.right-right.left)*0.2)return;
    if(page.regions.some(item=>{
      if(item.source!=='pp_ocr'||!readySource(page,item)||!item.raw_text?.trim()||
        [parts[1],parts[3]].includes(item.raw_text.trim()))return false;
      const box=bounds(item.polygons)!,center=(box.left+box.right)/2;
      // combine-ocr emits line:n:word:i regions from the same observed line.
      // These are not independent intervening text, but only when their exact
      // parent, original literal and contained geometry all agree.
      if([...before,...after].some(anchor=>{
        const parent=page.regions.find(region=>region.region_id===anchor.block_ids[0]),parentBox=bounds(anchor.polygons)!;
        if(!parent||!/^(?:.*:)?line:\d+$/u.test(parent.source_id)||!item.source_id.startsWith(parent.source_id+':word:')||
          !/^\d+$/u.test(item.source_id.slice((parent.source_id+':word:').length)))return false;
        return parent.raw_text!.includes(item.raw_text!)&&box.left>=parentBox.left&&box.right<=parentBox.right&&
          box.top>=parentBox.top&&box.bottom<=parentBox.bottom;
      }))return false;
      return center>(left.left+left.right)/2&&center<(right.left+right.right)/2&&
        box.left>=nativeBox.left-edgeAllowance&&box.right<=nativeBox.right+edgeAllowance&&
        Math.min(box.bottom,nativeBox.bottom)-Math.max(box.top,nativeBox.top)>=Math.min(box.bottom-box.top,nativeBox.bottom-nativeBox.top)*0.5;
    }))return;
    return {value,anchors:[anchor,...before,...after],nameSupported,proof:{
      before:{valueSha256:sha256(parts[1]!),anchorIds:before.map(item=>item.anchor_id)},
      after:{valueSha256:sha256(parts[3]!),anchorIds:after.map(item=>item.anchor_id)},
      unverified:{offset:[...parts[1]!].length,length:parts[2]!.length,unit:'unicode_code_point',kind:'literal_underscore'},noBlankStateAssertion:true}};
  }catch{return;}
}
function selectedOrigins(field:DocumentFieldObservation,candidate:Candidate):string[] {
  const filter=field.semanticFilter;
  if(filter?.version!=='azure-grounded-fields-v2'||filter.state!=='completed')return[];
  const originalShape=(value:Candidate)=>({rawValue:value.rawValue,normalizedValue:value.normalizedValue,anchorIds:value.anchorIds,
    pageNumbers:value.pageNumbers,evidenceSegments:value.evidenceSegments});
  return filter.originalCandidates.filter(prior=>!prior.roleEvidence&&!prior.authorizationEvidence&&!prior.sourceCorrectionEvidence&&
    !prior.tablePartyEvidence&&!prior.structuredValue&&isDeepStrictEqual(originalShape(prior),originalShape(candidate))&&
    filter.decisions.some(decision=>decision.candidateId===prior.candidateId&&decision.decision==='selected'&&
      candidate.anchorIds.every(id=>decision.anchorIds.includes(id))&&
      candidate.pageNumbers.every(page=>decision.pageNumbers.includes(page)))).map(item=>item.candidateId);
}
function eligible(field:DocumentFieldObservation,definition:ReviewFieldDefinition|undefined,label:string):boolean {
  return !!definition&&field.status!=='not_applicable'&&definition.objectKind==='policy'&&definition.valueMultiplicity==='clauses'&&
    definition.recipe.mode==='cloud_grounded_extract'&&definition.recipe.version==='azure-grounded-fields-v2'&&
    definition.taxonomyIds?.includes(label)===true;
}
/** An explicitly labelled insured currency may describe a material's insured
 * amounts, but a premium currency, another subject/role, or a filename cannot. */
function materialCurrency(input:InsuranceTableStructureInput,material:DocumentBundle['logicalDocuments'][number],
  definition:ReviewFieldDefinition,pages:DocumentPageArtifact[]):{
    component:Component;anchors:EvidenceAnchor[];proof:InsuranceTableStructureReceipt['entries'][number]['currency'];
  }|undefined {
  if(!definition.objectRole)return;
  const possible=input.fields.flatMap(field=>{
    const d=input.definitions.find(item=>item.id===field.fieldId);
    if(!d||d.objectKind!==definition.objectKind||(d.objectRole!==undefined&&d.objectRole!==definition.objectRole)||d.type!=='currency'||d.valueKind!=='currency'||
      !d.taxonomyIds?.includes(material.labelId!)||d.recipe.version!=='azure-grounded-fields-v2'||d.recipe.mode!=='cloud_grounded_extract'||
      field.status==='not_applicable'||field.documentVersionId!==input.binding.documentVersionId||field.parseRevision!==input.binding.parseRevision)return[];
    return field.candidates.filter(candidate=>candidate.pageNumbers.length===1&&material.pageNumbers.includes(candidate.pageNumbers[0]!)&&
      !candidate.roleEvidence&&!candidate.authorizationEvidence&&!candidate.sourceCorrectionEvidence&&!candidate.tablePartyEvidence)
      .map(candidate=>({field,candidate,ids:selectedOrigins(field,candidate)}));
  });
  if(possible.length!==1||!possible[0]!.ids.length)return;
  const {field,candidate,ids}=possible[0]!,normalized=normalizeDocumentV2Value(candidate.rawValue,'currency','currency');
  if(!normalized)return;
  const insuredLabel=/(?:保额币种|保額幣種|Insured currency)\s*[:：]/giu;
  const declaredTables=pages.flatMap(page=>page.regions.filter(region=>region.kind==='table'&&region.source==='vl_ocr'&&
    material.regionIds.includes(region.region_id)&&page.canonicalRegionIds.includes(region.region_id)&&
    [...(region.raw_text??'').matchAll(insuredLabel)].length).map(region=>({page,region})));
  if(declaredTables.reduce((count,{region})=>count+[...region.raw_text!.matchAll(insuredLabel)].length,0)!==1||
    declaredTables.some(({page,region})=>!readySource(page,region)))return;
  const matches=declaredTables.flatMap(({page,region})=>
    documentHtmlCellSpans(region.raw_text!).flatMap(span=>{
      const raw=region.raw_text!.slice(span.start,span.end);
      // A source cell may contain several separately labelled currency keys.
      // The second key is not interpreted as an insured currency by proximity.
      const keys=[...raw.matchAll(/(?:^|\s+)([\p{Script=Han}A-Za-z][\p{Script=Han}A-Za-z ]{1,39})\s*[:：]\s*([^\s:<>&]+)(?=$|\s)/gu)];
      if(!keys.length||keys.map(key=>key[0]).join('')!==raw.trim()||
        keys.some(key=>!normalizeDocumentV2Value(key[2]!,'currency','currency')))return[];
      const insured=keys.filter(key=>['保额币种','保額幣種','insured currency'].includes(column(key[1]!)));
      if(!insured.length)return[];
      const locate=(text:string,at:number)=>anchorsForText(page.page,[region],text).filter(anchor=>
        anchor.text_span_refs[0]?.offset===[...region.raw_text!.slice(0,span.start+at)].length);
      try{return insured.map(key=>{
        const value=key[2]!,label=key[1]!.trim(),keyStart=key.index;
        return {page,region,value,labelAnchors:locate(label,keyStart+key[0].indexOf(label)),
          valueAnchors:locate(value,keyStart+key[0].lastIndexOf(value))};
      });}
      catch{return[];}
    }));
  // Even equal repeated declarations are not silently assigned to one subject.
  if(matches.length!==1)return;
  const match=matches[0]!;
  if(match.page.page.page_number!==candidate.pageNumbers[0]||match.value!==candidate.rawValue||
    match.labelAnchors.length!==1||match.valueAnchors.length!==1)return;
  const sourceAnchors=candidate.anchorIds.map(id=>input.anchors.find(anchor=>anchor.anchor_id===id));
  const tableBox=bounds(match.region.polygons);
  if(!sourceAnchors.length||!tableBox)return;
  try{
    for(const anchor of sourceAnchors){
      if(!anchor) return;
      validateAnchorSource(anchor,match.page.page,match.page.regions);
    }
  }catch{return;}
  const hasExistingExactSource=sourceAnchors.some(anchor=>{
    if(!anchor)return false;
    if(match.valueAnchors.some(value=>isDeepStrictEqual(anchor,value)))return true;
    if(anchorText(anchor,match.page)!==candidate.rawValue)return false;
    const box=bounds(anchor.polygons);
    return !!box&&box.left>=tableBox.left&&box.right<=tableBox.right&&box.top>=tableBox.top&&box.bottom<=tableBox.bottom;
  });
  if(!hasExistingExactSource)return;
  const anchors=[...match.labelAnchors,...match.valueAnchors];
  return {component:{role:'currency',value:candidate.rawValue,normalizedValue:normalized,
    anchorIds:match.valueAnchors.map(anchor=>anchor.anchor_id),pageNumbers:[match.page.page.page_number]},anchors,
    proof:{basis:'explicit_insured_currency',sourceFieldId:field.fieldId,sourceCandidateIds:ids,logicalDocumentId:material.id,
      labelAnchorIds:match.labelAnchors.map(anchor=>anchor.anchor_id),valueAnchorIds:match.valueAnchors.map(anchor=>anchor.anchor_id)}};
}

/** Deterministic presentation metadata for a previously validated complete row.
 * It neither creates a fact nor changes the selected raw value, model history,
 * source segments, coverage verdict, or manual adoption value. Different rows
 * and conditional paragraphs are deliberately never merged. */
export function structureInsuranceTableRows(input:InsuranceTableStructureInput):{
  fields:DocumentFieldObservation[];anchors:EvidenceAnchor[];receipt:InsuranceTableStructureReceipt;
} {
  const binding=SourceCorrectionBindingSchema.parse(input.binding);
  const fields=input.fields.map(field=>({...field,candidates:[...field.candidates]})),added:EvidenceAnchor[]=[];
  const receipt:InsuranceTableStructureReceipt={methodVersion,binding,entries:[]};
  const definitions=new Map(input.definitions.map(item=>[item.id,item])),anchorMap=new Map(input.anchors.map(anchor=>[anchor.anchor_id,anchor]));
  for(const material of input.logicalDocuments){
    if(!material.labelId||!['candidate','confirmed'].includes(material.status)||
      input.logicalDocuments.some(other=>other!==material&&other.pageNumbers.some(page=>material.pageNumbers.includes(page))))continue;
    const pages=input.pages.filter(page=>material.pageNumbers.includes(page.page.page_number));
    if(!pages.length||pages.length!==material.pageNumbers.length||pages.some(page=>page.scope.documentVersionId!==binding.documentVersionId||
      page.scope.parseRevision!==binding.parseRevision||page.scope.sourceSha256!==binding.sourceSha256))continue;
    const tables=pages.flatMap(page=>page.regions.filter(region=>material.regionIds.includes(region.region_id))
      .flatMap(region=>{const table=parseTable(page,region);return table?[table]:[];}));
    for(const field of fields){
      if(!eligible(field,definitions.get(field.fieldId),material.labelId)||field.documentVersionId!==binding.documentVersionId||
        field.parseRevision!==binding.parseRevision)continue;
      const independentCurrency=materialCurrency(input,material,definitions.get(field.fieldId)!,pages);
      field.candidates=field.candidates.map(candidate=>{
        if(candidate.structuredValue||candidate.roleEvidence||candidate.authorizationEvidence||candidate.sourceCorrectionEvidence||
          candidate.tablePartyEvidence||candidate.evidenceSegments?.length!==1||candidate.pageNumbers.length!==1||
          !material.pageNumbers.includes(candidate.pageNumbers[0]!))return candidate;
        const segment=candidate.evidenceSegments[0]!;
        if(segment.rawValue!==candidate.rawValue||!isDeepStrictEqual(segment.pageNumbers,candidate.pageNumbers)||
          !isDeepStrictEqual(unique(segment.anchorIds).sort(),unique(candidate.anchorIds).sort()))return candidate;
        const sourceCandidateIds=selectedOrigins(field,candidate);
        if(!sourceCandidateIds.length)return candidate;
        const matches=tables.filter(table=>table.page.page.page_number===candidate.pageNumbers[0]).flatMap(table=>table.rows.flatMap(row=>{
          if(row.cells.length!==table.header.cells.length||!row.cells.every(cleanCell)||
            table.ordinal>=0&&!/^[1-9]\d{0,3}$/u.test(row.cells[table.ordinal]!.text.trim()))return[];
          let name=row.cells[table.name]!.text.trim();const amount=row.cells[table.amount]!.text.trim();
          if(name.length<2||name.length>500||!/^(?:\d+|\d{1,3}(?:,\d{3})+)(?:\.\d+)?$/u.test(amount))return[];
          const sourceAnchors=candidate.anchorIds.map(id=>anchorMap.get(id));
          if(sourceAnchors.some(anchor=>!anchor)||sourceAnchors.length!==row.cells.length)return[];
          const templateMatches=spaces(candidate.rawValue)===spaces(row.cells.map(cell=>cell.text.trim()).join('\n'))?[]:
            sourceAnchors.flatMap(anchor=>{const match=nativeTemplate(anchor!,table.page,name);return match?[match]:[];});
          if(templateMatches.length>1)return[];
          const template=templateMatches[0];if(template)name=template.value;
          if(spaces(candidate.rawValue)!==spaces(row.cells.map((cell,index)=>index===table.name?name:cell.text.trim()).join('\n')))return[];
          const cells=row.cells.map((cell,index)=>{
            const text=index===table.name?name:cell.text.trim();
            const matches=sourceAnchors.filter((anchor):anchor is EvidenceAnchor=>!!anchor&&anchorText(anchor,table.page,true)===text);
            return matches.length===1?matches[0]:undefined;
          });
          if(cells.some(anchor=>!anchor)||new Set(cells.map(anchor=>anchor!.anchor_id)).size!==cells.length)return[];
          const cellBounds=cells.map(anchor=>bounds(anchor!.polygons)!),tableBounds=bounds(table.region.polygons);
          if(!tableBounds||cellBounds.some(box=>!box||box.left<tableBounds.left||box.right>tableBounds.right||
            box.top<tableBounds.top||box.bottom>tableBounds.bottom)||
            Math.max(...cellBounds.map(box=>box.top))>=Math.min(...cellBounds.map(box=>box.bottom))||
            cellBounds.some((box,index)=>index>0&&box.left<=cellBounds[index-1]!.left))return[];
          const supported=row.cells.map((cell,index)=>index===table.name&&template?template.anchors:
            corroboratedCell(cells[index]!,table.page,cell.text.trim()));
          if([table.name,table.amount,...(table.currency>=0?[table.currency]:[])].some(index=>!supported[index]!.length))return[];
          const selected=[...(!template||template.nameSupported?[{role:'insurance_name' as const,index:table.name,value:name,normalizedValue:null}]:[]),
            {role:'amount' as const,index:table.amount,value:amount,normalizedValue:normalizeDocumentV2Value(amount,'amount','amount')}];
          const components:Component[]=selected.map(item=>({role:item.role,value:item.value,normalizedValue:item.normalizedValue,
            anchorIds:supported[item.index]!.map(anchor=>anchor.anchor_id),pageNumbers:candidate.pageNumbers}));
          let currency:InsuranceTableStructureReceipt['entries'][number]['currency']={basis:'not_established'};
          if(table.currency>=0){
            const value=row.cells[table.currency]!.text.trim(),normalizedValue=normalizeDocumentV2Value(value,'currency','currency');
            if(!normalizedValue)return[];
            components.push({role:'currency',value,normalizedValue,anchorIds:supported[table.currency]!.map(anchor=>anchor.anchor_id),pageNumbers:candidate.pageNumbers});
            currency={basis:'row_literal'};
          }
          const headerAnchors=table.header.cells.flatMap(cell=>cellAnchors(table,cell));
          const evidence=components.map(component=>{
            const index=component.role==='insurance_name'?table.name:component.role==='amount'?table.amount:table.currency;
            return {component,anchors:template&&component.role==='insurance_name'?[]:cellAnchors(table,row.cells[index]!)};
          });
          if(headerAnchors.length!==table.header.cells.length||evidence.some(item=>item.anchors.length!==1&&!(template&&item.component.role==='insurance_name')))return[];
          return [{table,row,components,currency,headerAnchors,evidence,supported,template}];
        }));
        if(matches.length!==1)return candidate;
        const match=matches[0]!;
        if(match.currency.basis==='not_established'&&independentCurrency){
          match.components.push(independentCurrency.component);match.currency=independentCurrency.proof;
          added.push(...independentCurrency.anchors);
        }
        receipt.entries.push({fieldId:field.fieldId,sourceCandidateIds,candidateSha256:sha256(JSON.stringify(candidate)),logicalDocumentId:material.id,
          pageNumber:candidate.pageNumbers[0]!,tableRegionId:match.table.region.region_id,tableTextSha256:match.table.region.raw_text_sha256!,
          rowIndex:match.row.index,headerAnchorIds:match.headerAnchors.map(anchor=>anchor.anchor_id),originalRowAnchorIds:candidate.anchorIds,currency:match.currency,
          ...(!match.template||match.template.nameSupported?{}:{omittedComponents:[{role:'insurance_name' as const,reason:'source_disagreement' as const,
            originalSourceAnchorIds:match.template.anchors.map(anchor=>anchor.anchor_id),
            tableCellAnchorIds:cellAnchors(match.table,match.row.cells[match.table.name]!).map(anchor=>anchor.anchor_id),
            nativeTemplate:match.template.proof}]}),
          components:[...match.evidence.map(item=>({role:item.component.role,valueSha256:sha256(item.component.value),
            sourceAnchorIds:item.component.anchorIds,tableCellAnchorIds:item.anchors.map(anchor=>anchor.anchor_id),
            ...(item.component.role==='insurance_name'&&match.template?{nativeTemplate:match.template.proof}:{})})),
            ...(match.currency.basis==='explicit_insured_currency'?[{role:'currency' as const,valueSha256:sha256(independentCurrency!.component.value),
              sourceAnchorIds:independentCurrency!.component.anchorIds,tableCellAnchorIds:independentCurrency!.component.anchorIds}]:[])]});
        added.push(...match.headerAnchors,...match.evidence.flatMap(item=>item.anchors),...match.supported.flat());
        if(match.template&&!match.template.nameSupported){
          added.push(...cellAnchors(match.table,match.row.cells[match.table.name]!));
          field.coverageGaps=unique([...field.coverageGaps,'insurance_name_source_disagreement']);
        }
        return {...candidate,...(match.template&&!match.template.nameSupported?{sourceReviewCodes:['insurance_name_source_disagreement' as const]}:{}),
          structuredValue:{kind:'insurance_limit',association:'candidate',components:match.components}};
      });
    }
  }
  return {fields,anchors:[...new Map([...input.anchors,...added].map(anchor=>[anchor.anchor_id,anchor])).values()],receipt};
}
