type Box=[number,number,number,number];
export interface SignatureEvaluationRegion {kind:string;bbox:Box}
function iou(a:Box,b:Box){const intersection=Math.max(0,Math.min(a[2],b[2])-Math.max(a[0],b[0]))*Math.max(0,Math.min(a[3],b[3])-Math.max(a[1],b[1]));return intersection/Math.max(1,(a[2]-a[0])*(a[3]-a[1])+(b[2]-b[0])*(b[3]-b[1])-intersection);}

/** Frozen acceptance threshold, with one observation per independently marked
 * region. Maximum matching prevents one wide box from claiming two people and
 * reports repeated detections separately from unrelated false positives. */
export function matchSignatureRegions(gold:SignatureEvaluationRegion[],observed:SignatureEvaluationRegion[]){
  const edges=gold.map(g=>observed.map((o,index)=>({index,overlap:g.kind===o.kind?iou(g.bbox,o.bbox):0})).filter(v=>v.overlap>=.3).sort((a,b)=>b.overlap-a.overlap||a.index-b.index).map(v=>v.index));
  const owners=new Map<number,number>();
  const assign=(goldIndex:number,visited:Set<number>):boolean=>{
    for(const observationIndex of edges[goldIndex]!){
      if(visited.has(observationIndex))continue;visited.add(observationIndex);
      const previous=owners.get(observationIndex);
      if(previous===undefined||assign(previous,visited)){owners.set(observationIndex,goldIndex);return true;}
    }
    return false;
  };
  for(let index=0;index<gold.length;index++)assign(index,new Set());
  let extra=0,duplicates=0;
  for(let index=0;index<observed.length;index++)if(!owners.has(index)){
    if(edges.some(list=>list.includes(index)))duplicates++;else extra++;
  }
  const pairs=[...owners].map(([observedIndex,goldIndex])=>({goldIndex,observedIndex})).sort((a,b)=>a.goldIndex-b.goldIndex);
  return {matched:owners.size,missing:gold.length-owners.size,extra,duplicates,pairs};
}

export type SignatureEvaluationAssessment='clear'|'indeterminate';
export const SIGNATURE_SCORING_VERSION='signature-observations-stratified.v1';
export function signatureEvaluationAssessment(source:'controls'|'pages',value:string):SignatureEvaluationAssessment{
  if(source==='controls'){
    if(value==='positive_synthetic_mark'||value==='negative_for_handwriting_and_stamp')return 'clear';
    if(value==='indeterminate')return 'indeterminate';
  }else{
    if(value==='no_visible_handwriting_or_seal')return 'clear';
    if(value==='uncertain_fragment_present')return 'indeterminate';
  }
  throw new Error('evaluation_assessment_invalid');
}
/** Assessment comes from the frozen human annotation, never model output.
 * A conservative abstention is safer than a false claim, but it is not a pass
 * on a clearly assessable region. Page-wide uncertainty cannot replace the
 * localization of an independently annotated uncertain fragment. */
export function evaluateSignatureObservations(input:{
  assessment:SignatureEvaluationAssessment;
  expected:SignatureEvaluationRegion[];
  observed:SignatureEvaluationRegion[];
  coverage:'complete'|'partial'|'unreadable'|'failed';
  executionFailed?:boolean;
}){
  const select=(regions:SignatureEvaluationRegion[],kinds:string[])=>regions.filter(region=>kinds.includes(region.kind));
  const matching=(kinds:string[])=>matchSignatureRegions(select(input.expected,kinds),select(input.observed,kinds));
  const positiveMatch=matching(['handwriting','stamp']),blankMatch=matching(['blank_signing_slot']),printedMatch=matching(['printed_name']),uncertainMatch=matching(['uncertain']);
  const exact=(result:ReturnType<typeof matchSignatureRegions>)=>result.missing===0&&result.extra===0&&result.duplicates===0;
  const unsupportedObservations=input.observed.filter(region=>!['handwriting','stamp','blank_signing_slot','printed_name','uncertain'].includes(region.kind)).length;
  const expectedUncertain=select(input.expected,['uncertain']).length;
  const uncertaintyPass=input.assessment==='indeterminate'
    ?expectedUncertain>0&&input.coverage==='partial'&&exact(uncertainMatch)
    :expectedUncertain===0&&input.coverage==='complete'&&exact(uncertainMatch);
  const passed=!input.executionFailed&&unsupportedObservations===0&&exact(positiveMatch)&&exact(blankMatch)&&exact(printedMatch)&&uncertaintyPass;
  return {assessment:input.assessment,positiveMatch,blankMatch,printedMatch,uncertainMatch,unsupportedObservations,uncertaintyPass,passed};
}
