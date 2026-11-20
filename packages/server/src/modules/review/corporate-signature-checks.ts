import {createHash} from 'node:crypto';
import {createCanvas,loadImage,type Canvas} from '@napi-rs/canvas';
import type {AutomaticReviewCheck} from '@hsbc/contracts/field-verification';
import type {ReviewConfigManifest,ReviewRequirementPolicy} from '@hsbc/contracts/review-config';
import type {AutomaticSignatureRecord} from '@hsbc/contracts/signature-information';
import type {ReviewEvidence} from '@hsbc/contracts/review';
import {CORPORATE_WORKBOOK_SHA256} from '@hsbc/contracts/corporate-requirements';
import {parseNativePdf,renderPdfPage} from '../../document/pdf.js';
import {automaticSignatureInformation} from '../documents/signatures/automatic-information.js';
import {guaranteeNativeLineAgreement} from '../documents/guarantee-source-evidence.js';
import {corporateBankScope} from './requirement-policy.js';
import {corporatePageStatements,uniqueSources,type CorporateCheckContext,type CorporatePage} from './corporate-check-sources.js';
import type {ChecklistInputDocument} from './checklist.js';

export type CorporateSignatureOriginal=(document:ChecklistInputDocument)=>Promise<Uint8Array|undefined>;
const digest=(b:Uint8Array)=>createHash('sha256').update(b).digest('hex');
const fold=(s:string)=>s.normalize('NFKC').toUpperCase().replace(/[^\p{L}\p{N}]/gu,'');
/** Only punctuation/spacing and an explicitly printed bilingual alias differ.
 * Conflicting Chinese or English parts veto a match; no fuzzy name guessing. */
export function corporateSignerSame(a:string,b:string):boolean{
 const parts=(s:string)=>({en:s.normalize('NFKC').toUpperCase().replace(/[^\p{Script=Latin}]/gu,''),cn:s.replace(/[^\p{Script=Han}]/gu,'')});
 const x=parts(a),y=parts(b);
 return !((x.en&&y.en&&x.en!==y.en)||(x.cn&&y.cn&&x.cn!==y.cn))&&!!(x.en&&x.en===y.en||x.cn&&x.cn===y.cn);
}
const box=(r:{polygons:number[][][]})=>{const ps=r.polygons.flat(),x=Math.min(...ps.map(p=>p[0]!)),y=Math.min(...ps.map(p=>p[1]!));return {x,y,width:Math.max(...ps.map(p=>p[0]!))-x,height:Math.max(...ps.map(p=>p[1]!))-y};};
const overlaps=(a:{x:number;y:number;width:number;height:number},b:ReturnType<typeof box>)=>Math.min(a.x+a.width,b.x+b.width)>Math.max(a.x,b.x)&&Math.min(a.y+a.height,b.y+b.height)>Math.max(a.y,b.y);

function nameLocated(record:AutomaticSignatureRecord,p:CorporatePage):boolean{
 if(!record.name)return false;
 const target=fold(record.name.value);
 // Trusted native text can span several runs. An OCR-only name must have its
 // entire visible line reproduced by positioned native runs on the same page.
 if(p.page.nativeTrust==='validated_geometry_and_visibility'){
  const text=p.page.regions.filter(r=>r.source==='native_pdf'&&r.processing_status==='ready'&&r.raw_text&&digest(Buffer.from(r.raw_text))===r.raw_text_sha256&&record.name!.box&&overlaps(record.name!.box,box(r))).map(r=>r.raw_text!).join(' ');
  return !!target&&!!text&&fold(text).includes(target);
 }
 return p.page.regions.some(r=>r.source==='pp_ocr'&&r.kind==='text'&&r.raw_text&&fold(r.raw_text)===target&&record.name!.box&&overlaps(record.name!.box,box(r))&&guaranteeNativeLineAgreement(p.page,{text:r.raw_text,box:box(r),region:r}).length>0);
}

/** Re-read original PDF graphics without changing stored pages. Fresh operator
 * boxes are corroborated against visible pixels; results reference the existing
 * full-page anchor, with the exact computed rectangle frozen in the receipt. */
export async function readCorporateSignatureDocument(c:CorporateCheckContext,d:ChecklistInputDocument,read:CorporateSignatureOriginal){
 const pages=c.pages.filter(p=>p.document.id===d.id);
 if(!pages.length||pages.some(p=>p.page.processing?.ocrSimulated)||d.invalidFieldIds?.some(id=>['*','cgt_field_15','cgt_field_20','cgt_field_30','cgt_field_31'].includes(id)))return;
 const bytes=await read(d);if(!bytes)return;
 if(pages.some(p=>digest(bytes)!==p.page.scope.sourceSha256))return;
 const scale=Number(/(?:^|:)scale=([0-9.]+)$/u.exec(pages[0]!.page.page.renderer_config)?.[1]);
 if(!Number.isFinite(scale)||scale<=0||scale>4)return;
 const native=await parseNativePdf(bytes,{documentVersionId:d.id,parseRevision:d.parseRevision!,scale});
 if(native.length!==pages.length)return;
 const supplements:NonNullable<AutomaticReviewCheck['execution']>['signatureRegions']=[];
 const renders=new Map<number,{png:Buffer;canvas:Canvas}>();
 const viewed=pages.map(p=>{
  const fresh=native.find(n=>n.page.page_number===p.number);
  if(!fresh||fresh.page.width!==p.page.page.width||fresh.page.height!==p.page.page.height||JSON.stringify(fresh.page.pdf_to_page)!==JSON.stringify(p.page.page.pdf_to_page)||JSON.stringify(fresh.page.pdf_view_box)!==JSON.stringify(p.page.page.pdf_view_box)||fresh.page.intrinsic_rotation!==p.page.page.intrinsic_rotation||fresh.coverage_gaps.includes('image_geometry_unverified'))return;
  const images=fresh.regions.filter(r=>r.source==='image'&&r.localization_reason==='pdf_image_operator_geometry');
  const pageAnchor=p.page.anchors.find(a=>a.evidence_kind==='image_region'&&a.polygons.some(ps=>{const b=box({polygons:[ps]});return b.width>=p.page.page.width*.95&&b.height>=p.page.page.height*.95;}));
  if(images.length&&!pageAnchor)return;
  const regions=[...p.page.regions.filter(r=>!['image','signature'].includes(r.kind)),...images];
  const anchors=[...p.page.anchors,...images.map(r=>({...pageAnchor!,anchor_id:r.region_id,block_ids:[r.region_id],polygons:r.polygons}))];
  return {p,page:{...p.page,regions,anchors,canonicalRegionIds:[...p.page.canonicalRegionIds,...images.map(r=>r.region_id)]},images,pageAnchor};
 });
 if(viewed.some(p=>!p))return;
 const result=automaticSignatureInformation({documentId:d.id,parseRevision:d.parseRevision!,directoryRevision:d.directoryRevision!,sourceSha256:digest(bytes),pages:viewed.map(p=>p!.page),expectedPages:pages.map(p=>p.number)});
 if(result.coverage.unavailablePages.length||!result.records.length)return {unavailable:'signature_page_coverage'};
 for(const r of result.records){
  const v=viewed.find(p=>p!.p.number===r.pageNumber)!;
  if(!v||!v.pageAnchor||!r.name||r.presence!=='graphic')return {unavailable:'signature_graphic_missing'};
  if(!nameLocated(r,v.p))return {unavailable:'signature_name_uncorroborated',role:r.role?.value,purpose:r.purpose};
  const image=v.images.filter(image=>r.evidence.some(e=>e.anchorId===image.region_id));
  if(image.length!==1)return {unavailable:'signature_graphic_not_individually_located',role:r.role?.value,purpose:r.purpose}; // OCR placeholder or a whole table never proves a mark.
  let rendered=renders.get(r.pageNumber);
  if(!rendered){const png=await renderPdfPage(bytes,r.pageNumber,scale),decoded=await loadImage(png),canvas=createCanvas(decoded.width,decoded.height);canvas.getContext('2d').drawImage(decoded,0,0);rendered={png,canvas};renders.set(r.pageNumber,rendered);}
  const {png,canvas}=rendered,ctx=canvas.getContext('2d');
  const b=box(image[0]!),left=Math.max(0,Math.ceil(b.x)),top=Math.max(0,Math.ceil(b.y)),width=Math.floor(b.width)-2,height=Math.floor(b.height)-2;
  if(width<10||height<3||left+width>canvas.width||top+height>canvas.height)return;
  const pixels=ctx.getImageData(left,top,width,height).data;let ink=0;
  for(let i=0;i<pixels.length;i+=4)if(pixels[i+3]!>100&&pixels[i]!+pixels[i+1]!+pixels[i+2]!<450)ink++;
  if(ink<30||ink/(width*height)<.003)return;
  const evidence={documentVersionId:d.id,parseRevision:d.parseRevision!,directoryRevision:d.directoryRevision!,anchorId:v.pageAnchor.anchor_id};
  supplements.push({evidence,pageNumber:r.pageNumber,sourceSha256:digest(bytes),renderSha256:digest(png),box:b});
  r.evidence=[evidence];
 }
 return {records:result.records,regions:supplements};
}

/** Same bounded source checks for every company object, including mixed cases.
 * Missing evidence stays a system task. No material or person is auto-confirmed. */
export async function corporateSignatureChecks(c:CorporateCheckContext,m:ReviewConfigManifest,scopeId:string,policy:ReviewRequirementPolicy|undefined,prior:AutomaticReviewCheck[],read?:CorporateSignatureOriginal):Promise<AutomaticReviewCheck[]>{
 if(!corporateBankScope(policy)||!read)return [];
 const docs=['cgt_guarantee','cgt_resolution'].map(t=>c.current.filter(d=>d.taxonomyIds.includes(t)));
 if(docs.some(ds=>ds.length!==1))return [];
 const [g,r]=await Promise.all(docs.map(ds=>readCorporateSignatureDocument(c,ds[0]!,read)));
 if(!g||!r||'unavailable' in g||'unavailable' in r)return [];
 return evaluateCorporateSignatures(c,m,scopeId,prior,g,r);
}

/** Evaluate only independently located and pixel-checked original graphics. */
export function evaluateCorporateSignatures(c:CorporateCheckContext,m:ReviewConfigManifest,scopeId:string,prior:AutomaticReviewCheck[],g:Extract<Awaited<ReturnType<typeof readCorporateSignatureDocument>>,{records:AutomaticSignatureRecord[]}>,r:Extract<Awaited<ReturnType<typeof readCorporateSignatureDocument>>,{records:AutomaticSignatureRecord[]}>):AutomaticReviewCheck[]{
 const docs=['cgt_guarantee','cgt_resolution'].map(t=>c.current.filter(d=>d.taxonomyIds.includes(t)));
 if(docs.some(ds=>ds.length!==1))return [];
 const directors=g.records.filter(s=>/^Director$/iu.test(s.role?.value??'')),witnesses=g.records.filter(s=>/^Witness$/iu.test(s.role?.value??''));
 const execution=r.records.filter(s=>s.purpose==='execution'),specimens=r.records.filter(s=>s.purpose==='specimen');
 if(!directors.length||!witnesses.length||!execution.length||!specimens.length||directors.length+witnesses.length!==g.records.length||execution.length+specimens.length!==r.records.length)return [];
 const unique=(ss:AutomaticSignatureRecord[])=>ss.every(s=>ss.filter(t=>corporateSignerSame(s.name!.value,t.name!.value)).length===1);
 if(![directors,witnesses,execution,specimens].every(unique))return [];
 const match=(a:AutomaticSignatureRecord[],b:AutomaticSignatureRecord[])=>a.length===b.length&&a.every(s=>b.filter(t=>corporateSignerSame(s.name!.value,t.name!.value)).length===1);
 const authorities=c.values('cgt_field_29','cgt_resolution');
 const required=[...new Set(authorities.map(s=>s.value.trim()).filter(Boolean))];
 if(!required.length||!required.every(name=>specimens.filter(s=>corporateSignerSame(name,s.name!.value)).length===1)||specimens.some(s=>!required.some(name=>corporateSignerSame(name,s.name!.value))))return [];
 const names=c.values('cgt_field_16','cgt_guarantee'),witnessNames=c.values('cgt_field_21','cgt_guarantee');
 if(!directors.every(s=>names.some(n=>corporateSignerSame(n.value,s.name!.value)))||!witnesses.every(s=>witnessNames.some(n=>corporateSignerSame(n.value,s.name!.value))))return [];
 // A readable explicit joint mandate is required; unknown/discretionary
 // combinations remain with the existing signature requirement workflow.
 const mandatePattern=/Execution condition:\s*(BOTH|ALL) directors must sign together[.]\s*Common\s*\/\s*Corporate Seal:\s*NOT\s+REQUIRED\s+under\s+Article\s+\d+\s+and\s+resolution\s+\d+/iu;
 const mandatePages=c.pages.filter(p=>p.trusted&&p.document.id===docs[1]![0]!.id&&mandatePattern.test(p.text));
 const mandate=corporatePageStatements(mandatePages,'cgt_resolution',mandatePattern);
 if(mandatePages.length!==1||!mandate.length||!match(directors,specimens)||mandatePattern.exec(mandatePages[0]!.text)?.[1]?.toUpperCase()==='BOTH'&&directors.length!==2)return [];
 const minimum=c.facts.cgt_resolution_minimum;
 const min=minimum?.state==='present'&&typeof minimum.value==='string'&&/^[1-9]\d{0,3}$/u.test(minimum.value)?Number(minimum.value):undefined;
 const objectId=c.own.find(row=>row.fieldId==='cgt_field_30')?.objectId;
 const membership=prior.find(check=>check.objectId===objectId&&check.ruleIds.includes('cgt_bank_55')&&check.status==='done'&&check.execution?.version==='corporate-director-roster-v1');
 if(min===undefined||!membership||!execution.every(s=>specimens.filter(t=>corporateSignerSame(s.name!.value,t.name!.value)).length===1)||execution.length<min)return [];
 // An explicit business fact is authoritative; do not conceal a contrary
 // count or witness decision using an inferred observation.
 for(const [id,observed] of [['cgt_resolution_signer_count',String(execution.length)],['cgt_witness_signed','yes']] as const){
  const fact=c.facts[id],explicit=c.own.some(row=>row.fieldId===id&&row.fact);
  if(fact&&(fact.state==='present'&&String(fact.value)!==observed||explicit&&fact.state!=='present'))return [];
 }
 const sources=uniqueSources([...authorities,...names,...witnessNames,...mandate,...membership.item.sources]);
 if(sources.length>40)return [];
 const checks:AutomaticReviewCheck[]=[];
 for(const [id,field,operator,inputs,source] of [
  ['cgt_bank_15','cgt_field_15','manual_review','cgt_field_15',15],['cgt_bank_20','cgt_field_20','manual_review','cgt_field_20',20],
  ['cgt_bank_33','cgt_field_30','manual_review','cgt_field_30',33],['cgt_bank_34','cgt_field_31','manual_review','cgt_field_31',34],
  ['cgt_resolution_signatures','cgt_field_30','minimum','cgt_resolution_signer_count,cgt_resolution_minimum',33],['cgt_witness_signature','cgt_field_20','equal','cgt_witness_signed,cgt_yes',20],
 ] as const){
  const rule=m.rules.find(r=>r.id===id),row=c.own.find(r=>r.fieldId===field);
  const expectedSources=[`cgt_rule_source_${source}`,...(id==='cgt_bank_34'?[]:['cgt_confirmed_execution'])];
  if(!row||row.verification?.meaning==='different'||row.verification?.validity!=='current'||!rule||rule.objectScope?.role!=='corporate_guarantee'||rule.operator!==operator||rule.inputs.join(',')!==inputs||rule.requiredParameters.length||!rule.sourceDirectionConfirmed||rule.sourceIds.length!==expectedSources.length||!expectedSources.every(source=>rule.sourceIds.includes(source))||!rule.sourceIds.every(id=>m.sources.some(s=>s.id===id&&s.sha256===CORPORATE_WORKBOOK_SHA256&&['confirmed','candidate'].includes(s.disposition)))||rule.applicability&&(c.facts[rule.applicability.fieldId]?.state!=='present'||c.facts[rule.applicability.fieldId]?.value!==rule.applicability.equals))continue;
  const reason=`已回读原始 PDF 并核对可见图形及局部姓名：保证书 ${directors.length} 名董事、${witnesses.length} 名见证人；决议 ${execution.length} 名签署人，最低要求 ${min} 人；${specimens.length} 份授权签字样本均有图形。名单、共同签署组合与明确的无须盖章要求对应。仅核对图形存在、列示人员和授权组合，不鉴定笔迹真伪或认定示例为真实法律签署。`;
  checks.push({id:`corporate-bank-scope-v1:${scopeId}:${id}:signature-layout-v1`,objectId:row.objectId,fieldId:field,ruleIds:[id],status:'done',reason,task:{kind:'system',group:'signature'},
   execution:{version:'corporate-bank-scope-v1',referenceHashes:[CORPORATE_WORKBOOK_SHA256],evidence:[...g.regions!,...r.regions!].map(r=>r.evidence),signatureRegions:[...g.regions!,...r.regions!]},
   item:{rowId:row.id,objectId:row.objectId,fieldId:field,scope:'bank_rule',meaning:'consistent',reason,actions:[],sources}});
 }
 return checks;
}
