import type {DocumentPageArtifact} from '@hsbc/contracts/documents';
import type {DocumentRegion} from '@hsbc/contracts/evidence';
import {sha256} from '../../document/evidence.js';

export type FormBox={x:number;y:number;width:number;height:number};
export type FormLine={text:string;region:DocumentRegion;box:FormBox};
export const formFold=(s:string)=>s.normalize('NFKC').replace(/\s+/gu,'').toLowerCase();
export const bottom=(b:FormBox)=>b.y+b.height;
export const right=(b:FormBox)=>b.x+b.width;
export function formBox(r:DocumentRegion):FormBox|null {
  const points=r.polygons.flat();if(!points.length)return null;
  const x=Math.min(...points.map(p=>p[0])),y=Math.min(...points.map(p=>p[1]));
  const width=Math.max(...points.map(p=>p[0]))-x,height=Math.max(...points.map(p=>p[1]))-y;
  return [x,y,width,height].every(Number.isFinite)&&x>=0&&y>=0&&width>0&&height>0?{x,y,width,height}:null;
}
/** Full OCR lines retain their source and geometry, even when an older parser
 * selected unvalidated native runs as the canonical alternative. */
export function directorFormLines(page:DocumentPageArtifact):FormLine[] {
  if(page.status==='failed'||page.page.document_version_id!==page.scope.documentVersionId||page.page.parse_revision!==page.scope.parseRevision||page.page.source_sha256!==page.scope.sourceSha256)return [];
  const lines=page.regions.flatMap(region=>{
    const box=formBox(region),text=region.raw_text?.trim();
    if(!text||region.kind!=='text'||region.processing_status!=='ready'||region.raw_text_sha256!==sha256(region.raw_text!)||
      region.document_version_id!==page.scope.documentVersionId||region.parse_revision!==page.scope.parseRevision||region.page_asset_id!==page.page.page_asset_id||
      region.source==='image'||region.source==='native_pdf'&&page.nativeTrust!=='validated_geometry_and_visibility'||/word[:_-]/u.test(region.source_id)||
      !box||right(box)>page.page.width||bottom(box)>page.page.height)return [];
    return [{text,box,region}];
  }).sort((a,b)=>a.box.y-b.box.y||a.box.x-b.box.x);
  return lines.filter((line,index)=>!lines.slice(0,index).some(other=>formFold(other.text)===formFold(line.text)&&
    Math.abs(other.box.y-line.box.y)<Math.min(other.box.height,line.box.height)&&Math.abs(other.box.x-line.box.x)<10));
}
export type NoticeSection={kind:'cessation'|'appointment'|'body'|'consent'|'submission';heading:FormLine;top:number;end:number};
export function directorNoticeLayout(page:DocumentPageArtifact){
  const lines=directorFormLines(page);
  if(lines.some(l=>/^(?:表格)?(?:form)?pi[-‐‑–]?nd2a$/iu.test(formFold(l.text))&&l.box.y<page.page.height*.2))return {lines,sections:[] as NoticeSection[],protectedSheet:true};
  // A protected-information sheet and a mention in prose are not the form.
  const form=lines.some(l=>/^(?:表格)?(?:form)?nd2a$/iu.test(formFold(l.text))&&l.box.y<page.page.height*.2);
  if(!form)return null;
  const headings=lines.flatMap(line=>{
    const t=formFold(line.text);let kind:NoticeSection['kind']|undefined;
    if(/^(?:2)?(?:公司秘[書书][／/]董事的停任|cessationtoactascompanysecretary)/u.test(t))kind='cessation';
    else if(/^(?:3)?(?:委任公司秘[書书][／/]董事|appointmentofcompanysecretary)/u.test(t)&&/自然人|naturalperson/u.test(t)&&!/protected|受保護|受保护/u.test(t))kind='appointment';
    else if(/^(?:4)?(?:委任公司秘[書书][／/]董事|appointmentofcompanysecretary)/u.test(t)&&/法人|bodycorporate/u.test(t))kind='body';
    else if(/^(?:出任董事職位同意書|出任董事职位同意书|consenttoactasdirector)/u.test(t))kind='consent';
    else if(/^(?:5)?(?:確認\(|确认\(|confirmation\()/u.test(t))kind='submission';
    return kind?[{kind,heading:line,top:line.box.y,end:page.page.height}]:[];
  }).filter((line,index,all)=>!all.slice(0,index).some(other=>other.kind===line.kind&&Math.abs(other.top-line.top)<20));
  headings.forEach((section,index)=>section.end=headings[index+1]?.top??page.page.height);
  return {lines,sections:headings,protectedSheet:false};
}
export const lineLabel=(line:FormLine,labels:string[])=>labels.some(label=>formFold(line.text)===formFold(label));
export function rightOfLabel(lines:FormLine[],labels:string[],accept:(s:string)=>boolean):{value:FormLine;label:FormLine}|null {
  const found=lines.filter(l=>lineLabel(l,labels)).flatMap(label=>lines.filter(value=>value!==label&&accept(value.text)&&
    value.box.x>=right(label.box)-3&&value.box.x-right(label.box)<label.box.height*20&&
    Math.abs(value.box.y+value.box.height/2-label.box.y-label.box.height/2)<Math.max(label.box.height,value.box.height)*.85)
    .map(value=>({value,label}))).sort((a,b)=>a.value.box.x-b.value.box.x);
  const distinct=found.filter((x,i)=>!found.slice(0,i).some(y=>formFold(y.value.text)===formFold(x.value.text)&&Math.abs(y.value.box.y-x.value.box.y)<15));
  return distinct.length===1?distinct[0]!:null;
}
