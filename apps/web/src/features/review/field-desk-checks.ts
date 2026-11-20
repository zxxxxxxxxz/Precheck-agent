import {isBusinessSource,namedCheckSources} from './field-gap-guidance.ts';
import {comparisonSource,type ChecklistRow,type CrossFileCheck,type CrossFileValue} from '@hsbc/contracts/review-checklist';
import {focusedChecks,focusedValues,rowFocus,focusKind} from './field-focused-reading.ts';

/** Compatibility reading of existing compound extraction. Same object/role and
 * fixed evidence only; never adopts a manual field or changes a stored check. */
export function fieldDeskChecks(row:ChecklistRow,rows:ChecklistRow[]):CrossFileCheck[] {
  // Bank rows already specify exact counterparts; generic aspect filtering must not hide their evidence.
  if(row.crossChecks?.some(check=>check.bankRule))return namedCheckSources(row.crossChecks,row,rows).map(check=>({...check,sources:check.sources.map(comparisonSource)}));
  const focus=rowFocus(row),kind=focusKind(focus);
  const checks=focusedChecks(namedCheckSources(row.crossChecks??[],row,rows),focus);
  if(!checks.length)return checks;
  const sources=[...new Map(checks.flatMap(check=>check.sources).map(source=>[source.id,source])).values()];
  if(['amount','currency'].includes(kind)&&['cgt_field_12','cgt_amount','cgt_required_amount','cgt_currency','cgt_required_currency'].includes(row.fieldId)) {
    for(const fieldId of ['cgt_field_12','cgt_facility_guarantee_terms','cgt_facility_parties']) {
      const related=rows.find(other=>other.fieldId===fieldId&&other.objectId===row.objectId&&other.objectRole===row.objectRole);
      if(!related)continue;
      const available=related.crossChecks?.flatMap(check=>check.sources.filter(source=>source.fieldId===fieldId&&source.documentId))??[];
      for(const source of available) {
        if(sources.some(existing=>existing.id===source.id))continue;
        // Facility prose is a source only when it explicitly specifies the
        // guarantee amount, never from a facility limit or an unrelated sum.
        if(!source.values.some(value=>focusedValues(value,focus,{compound:true}).length))continue;
        sources.push({...source,label:fieldId==='cgt_field_12'?kind==='amount'?'保证书担保金额':'保证书担保币种':kind==='amount'?'授信函要求的担保金额':'授信函要求的担保币种'});
      }
    }
  }
  const scopedSources=sources.map(source=>{
    if(!source.documentId||!['amount','currency'].includes(kind)||!['cgt_field_12','cgt_facility_guarantee_terms','cgt_facility_parties'].includes(source.fieldId))return source;
    const related=rows.find(other=>other.fieldId===source.fieldId&&other.objectId===row.objectId&&other.objectRole===row.objectRole);
    const candidates=related?(row.objectId?related.candidates:related.unassignedCandidates??[]):[];
    const matched=candidates.filter(candidate=>candidate.documentId===source.documentId&&candidate.value&&focusedValues(candidate.value,focus,{compound:true}).length);
    return matched.length?{...source,values:[...new Set(matched.flatMap(candidate=>candidate.value?[candidate.value]:[]))],
      evidence:[...new Map(matched.flatMap(candidate=>candidate.evidence).map(evidence=>[JSON.stringify(evidence),evidence])).values()]}:source;
  });
  const readingSources=scopedSources.map(source=>withScopedReading(source,kind));
  const bySeverity=['different','insufficient','manual','single_source','consistent','not_applicable'] as const;
  const outcome=bySeverity.find(outcome=>checks.some(check=>check.outcome===outcome))??checks[0]!.outcome;
  return [{...checks[0]!,outcome,label:row.label,sources:readingSources,
    reason:[...new Set(checks.map(check=>check.reason))].join('\n'),
    manualReasons:[...new Set(checks.flatMap(check=>check.manualReasons))],
  }];
}

export function sourceIsPendingBusinessValue(source:CrossFileValue) {
  return isBusinessSource(source)&&!source.values.length;
}

/** Only server-issued, current-source proofs can narrow legacy field warnings. */
export function withScopedReading(source:CrossFileValue,kind:ReturnType<typeof focusKind>):CrossFileValue {
  source=comparisonSource(source);
  const proof=source.scopedReadings?.find(reading=>reading.kind===kind);
  if(source.state!=='uncertain'||!proof||!proof.values.length||!proof.evidence.length||!proof.values.every(value=>source.values.includes(value))||
    !proof.evidence.every(e=>e.documentVersionId===source.documentId&&!!e.anchorId&&source.evidence.some(ref=>ref.documentVersionId===e.documentVersionId&&ref.parseRevision===e.parseRevision&&ref.directoryRevision===e.directoryRevision&&ref.anchorId===e.anchorId)))return source;
  return {...source,values:proof.values,evidence:proof.evidence,warnings:[],state:'available'};
}

export function withScopedCheckReading(check:CrossFileCheck,kind:ReturnType<typeof focusKind>):CrossFileCheck {
 const sources=check.sources.map(source=>withScopedReading(source,source.scopedReadings?.some(reading=>reading.kind===kind)?kind:focusKind(source)));
 const resolved=check.outcome==='insufficient'&&check.sourceQualityBlocked&&check.sources.some((source,index)=>source.state==='uncertain'&&sources[index]!.state==='available')&&
   sources.every(source=>source.state==='available'||source.state==='pending_confirmation');
 return {...check,sources,...(resolved?{outcome:'manual' as const,reason:'',sourceQualityBlocked:false}: {})};
}
