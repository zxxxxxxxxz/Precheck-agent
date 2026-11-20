import type {DocumentFieldPresentation} from '@hsbc/contracts/document-presentation';
import type {DocumentBundle, DocumentPageArtifact} from '@hsbc/contracts/documents';
import type {EvidenceAnchor} from '@hsbc/contracts/evidence';
import {anchorsForText, validateAnchorSource} from '../../document/evidence.js';

/** Reading aid for old manual fields. Never changes stored observations or facts. */
export function projectGuaranteeMoney(fields:DocumentFieldPresentation[], anchors:EvidenceAnchor[], bundle:DocumentBundle, titlePage:DocumentPageArtifact|undefined, manualFieldIds:readonly string[]) {
  const outputAnchors=[...anchors];
  const guarantees=bundle.logicalDocuments.filter(d=>d.labelId==='cgt_guarantee' && ['candidate','confirmed'].includes(d.status));
  if(guarantees.length!==1 || bundle.logicalDocuments.length!==1)return {fields,anchors};
  const owner=guarantees[0]!;
  const scoped=(f:DocumentFieldPresentation)=>f.documentVersionId===bundle.scope.documentVersionId && f.parseRevision===bundle.scope.parseRevision;
  const located=(ids:string[])=>ids.length>0 && ids.every(id=>anchors.some(a=>a.anchor_id===id && a.document_version_id===bundle.scope.documentVersionId && a.parse_revision===bundle.scope.parseRevision && owner.pageNumbers.includes(a.page_number) && a.evidence_kind==='text'));
  const money=fields.filter(f=>scoped(f) && ['cgt_field_12','cgt_amount'].includes(f.fieldId) && !f.humanRevisionId && f.semanticFilter?.state==='completed' && f.extractionCoverage?.state==='complete').flatMap(f=>f.candidates);
  const currencies=money.flatMap(c=>[...c.rawValue.matchAll(/\b(USD|HKD|CNY|RMB|EUR|GBP|JPY|CHF|AUD|CAD|SGD|NZD)\s+\d[\d,]*(?:\.\d+)?\b/gu)].map(m=>({value:m[1]!,candidate:c})));
  const currencyValues=new Set(currencies.map(c=>c.value));
  const currency=currencyValues.size===1 && currencies.every(c=>located(c.candidate.anchorIds)) ? currencies[0] : undefined;
  const titleValues=new Map<string,EvidenceAnchor[]>();
  if(titlePage && titlePage.scope.documentVersionId===bundle.scope.documentVersionId && titlePage.scope.parseRevision===bundle.scope.parseRevision && titlePage.scope.sourceSha256===bundle.scope.sourceSha256 && titlePage.status!=='failed' && owner.pageNumbers.includes(titlePage.page.page_number)) {
    for(const region of titlePage.regions.filter(r=>['vl_ocr','pp_ocr'].includes(r.source))) {
      const match=/^GUARANTEE\s*\(\s*(Limited|Unlimited) Amount\s*\)$/iu.exec(region.raw_text?.trim()??'');
      if(!match)continue;
      try {
        const proof=anchorsForText(titlePage.page,[region],region.raw_text!);
        for(const anchor of proof)validateAnchorSource(anchor,titlePage.page,titlePage.regions);
        if(proof.length)titleValues.set(match[1]!.toLowerCase(),[...(titleValues.get(match[1]!.toLowerCase())??[]),...proof]);
      } catch { /* Missing or invalid evidence leaves the manual field unchanged. */ }
    }
  }
  const title=titleValues.size===1?[...titleValues.entries()][0]:undefined;
  return {anchors:outputAnchors,fields:fields.map(field=>{
    if(!manualFieldIds.includes(field.fieldId)||!scoped(field)||field.status==='not_applicable'||field.humanRevisionId||field.rawValue?.trim()||field.candidates.length)return field;
    if(field.fieldId==='cgt_currency' && currency)return {...field,guaranteeSourceValue:{displayValue:currency.value,anchorIds:[...new Set(currencies.flatMap(c=>c.candidate.anchorIds))],pageNumbers:[...new Set(currencies.flatMap(c=>c.candidate.pageNumbers))]}};
    if(field.fieldId==='cgt_limited' && title){
      outputAnchors.push(...title[1].filter(a=>!outputAnchors.some(existing=>existing.anchor_id===a.anchor_id)));
      return {...field,guaranteeSourceValue:{displayValue:title[0]==='limited'?'否（有限额责任担保）':'是（无限额责任担保）',anchorIds:title[1].map(a=>a.anchor_id),pageNumbers:[titlePage!.page.page_number]}};
    }
    return field;
  })};
}
