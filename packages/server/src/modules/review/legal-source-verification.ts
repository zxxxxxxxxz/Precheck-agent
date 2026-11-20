import {createHash} from 'node:crypto';
import type {CrossFileValue} from '@hsbc/contracts/review-checklist';
import type {DocumentPageArtifact} from '@hsbc/contracts/documents';
import type {ChecklistInputDocument} from './checklist.js';

type Region=DocumentPageArtifact['regions'][number];
export const legalPlain=(text:string)=>text.replace(/<[^>]*>/gu,' ').replace(/\s+/gu,' ').trim();
export const legalSentences=(text:string)=>legalPlain(text).split(/(?<=[。！？])\s*|(?<=[.!?])\s+(?=[A-Z])/u).filter(Boolean);
const key=(text:string)=>text.normalize('NFKC').replace(/\s+/gu,'');
const digest=(text:string)=>createHash('sha256').update(text).digest('hex');
const box=(r:Region)=>{const points=r.polygons.flat();return {left:Math.min(...points.map(p=>p[0])),right:Math.max(...points.map(p=>p[0])),top:Math.min(...points.map(p=>p[1])),bottom:Math.max(...points.map(p=>p[1]))};};
function overlaps(a:Region,b:Region){const x=box(a),y=box(b);return Math.max(x.left,y.left)<Math.min(x.right,y.right)&&Math.max(x.top,y.top)<Math.min(x.bottom,y.bottom);}
/** Verify exact quotations against two independent text channels on the SAME
 * fixed page/geometry. Never clear the immutable receipt or adopt a fact. */
export function verifyLegalSource(source:CrossFileValue,document:ChecklistInputDocument):CrossFileValue {
  if(!['cgt_field_5','cgt_legal_checklist_19','cgt_legal_conditions'].includes(source.fieldId))return source;
  source={...source,verifiedQuotes:undefined};
  if(!document.projectionCurrent||!document.sourceHash||!document.parseRevision||!document.directoryRevision||
    !['ready','partial'].includes(document.state)||document.invalidFieldIds?.some(id=>id==='*'||id===source.fieldId)||
    source.documentId!==document.id||source.evidence.some(e=>e.documentVersionId!==document.id||e.parseRevision!==document.parseRevision||e.directoryRevision!==document.directoryRevision))return source;
  const verifiedQuotes:NonNullable<CrossFileValue['verifiedQuotes']>=[];
  const availableAnchors=new Set(document.availableAnchorIds??[]);
  for(const text of [...new Set(source.values.flatMap(legalSentences))]){
    const needle=key(text);
    if(needle.length<8)continue;
    for(const page of document.sourcePages??[]){
      if(page.page.document_version_id!==document.id||page.page.parse_revision!==document.parseRevision||page.status==='failed'||page.processing.ocrSimulated||!page.imageSha256)continue;
      // Re-locate an exact quote within the same document when the old field
      // citation is incomplete. Only existing, current-version anchors qualify.
      const anchors=page.anchors.filter(a=>availableAnchors.has(a.anchor_id)&&a.document_version_id===document.id&&a.parse_revision===document.parseRevision&&a.page_asset_id===page.page.page_asset_id&&a.polygons.length&&['exact','block_only'].includes(a.localization_status));
      const eligible=(r:Region)=>r.document_version_id===document.id&&r.parse_revision===document.parseRevision&&r.page_asset_id===page.page.page_asset_id&&r.processing_status==='ready'&&!r.coverage_gaps.length&&r.polygons.length&&!!r.raw_text&&digest(r.raw_text)===r.raw_text_sha256&&!page.conflicts.some(c=>c.region_ids.includes(r.region_id));
      const primary=page.regions.filter(r=>r.raw_text&&key(r.raw_text).includes(needle)&&r.source!=='image'&&anchors.some(a=>a.block_ids.includes(r.region_id))&&eligible(r));
      const match=primary.find(r=>(['native_pdf','pp_ocr','vl_ocr'] as const).some(channel=>{
        if(channel===r.source||channel==='native_pdf'&&page.nativeTrust!=='validated_geometry_and_visibility')return false;
        const others=page.regions.filter(other=>other.source===channel&&overlaps(r,other)).sort((a,b)=>a.reading_order-b.reading_order);
        // An invalid region is a barrier, never silently removed to join text.
        return key(others.map(other=>eligible(other)?other.raw_text:'\u0000').join('')).includes(needle);
      }));
      if(!match)continue;
      const anchor=anchors.find(a=>a.block_ids.includes(match.region_id))!;
      verifiedQuotes.push({text,page:page.page.page_number,sourceHash:document.sourceHash,method:'independent_text',evidence:[{documentVersionId:document.id,parseRevision:document.parseRevision,directoryRevision:document.directoryRevision,anchorId:anchor.anchor_id}]});break;
    }
  }
  return {...source,verifiedQuotes};
}
