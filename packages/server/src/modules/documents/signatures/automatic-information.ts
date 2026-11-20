import type {DocumentPageArtifact} from '@hsbc/contracts/documents';
import type {DocumentRegion} from '@hsbc/contracts/evidence';
import type {AutomaticSignatureInformation, AutomaticSignatureRecord, AutomaticSignatureValue} from '@hsbc/contracts/signature-information';
import type {SignatureBox, SignatureObservation} from '@hsbc/contracts/signature-review';
import {sha256} from '../../../document/evidence.js';
import {signatureTableRows} from '../engine/tables.js';
import {directorNoticeSignatures} from './director-notice-signatures.js';
import {associateSpecimenIdentities} from './specimen-identity.js';
import {guaranteeNativeLineAgreement} from '../guarantee-source-evidence.js';

type Input = {documentId:string;parseRevision:string;sourceSha256:string;directoryRevision:number;pages:DocumentPageArtifact[];expectedPages?:number[];observations?:SignatureObservation[]};
type Line = {text:string;box:SignatureBox;regions:DocumentRegion[]};
/** Unwrap only known OCR typography; immutable source text and hashes stay intact. */
const clean = (s:string) => {
  let text=s;
  for(let i=0;i<8;i++){
    const next=text.replace(/\\(?:underline|text|textrm|textbf|mathrm)\{([^{}]*)\}/gu,'$1');
    if(next===text)break;
    text=next;
  }
  return text.replace(/\$([^$]*)\$/gu,'$1').replace(/\\n|\r?\n/gu,' ').replace(/\s+/gu,' ').trim();
};
const nameLabel = /^(?:(?:full\s+name(?:\s*\(in block letters\))?|name(?: of (?:signatory|signer|witness))?)(?!\s+of\b)(?=\s|[:：（(]|$)(?:\s*[（(]姓名[）)])?|(?:姓名|签署人姓名|簽署人姓名|签字人|簽字人)(?:\s*[（(](?:full\s+)?name[）)])?|创办成员|創辦成員)\s*[:：]?\s*/iu;
// OCR can read 職 as 聀. Recognize it only in the field label; leave the
// immutable source text and the person's actual value untouched.
const roleLabel = /^(?:title|position|capacity|职务|職務|职位|職位|[职職聀][衔銜])(?:\s*[（(]title[）)])?\s*[:：]?\s*/iu;
const idLabel = /^(?:identification document type and number|identity record|(?:hk)?id(?:entity)?(?: card)?(?: number| no\.?)?|passport(?: number| no\.?)?|身份证(?:明文件)?(?:种类及)?号码|身份證(?:明文件)?(?:種類及)?號碼|身份证字号|身份證字號|证件号码|證件號碼)(?:\s*[（(]ID Number[）)])?\s*[:：]?\s*/iu;
const addressLabel = /^(?:address|地址|住址)(?:\s*[（(]address[）)])?\s*[:：]?\s*/iu;
const signingLabel = /^(?:signature(?: of (?:director|witness|secretary|signatory|guarantor))?|signed by|签名|簽名|签字|簽字|保证人签署|保證人簽署|担保人签署|擔保人簽署|签署人|簽署人)(?:\b|\s|[:：_]|$)/iu;
const roleSuffix = /(?:Chair(?:man)?\s+and\s+Director|公司秘[书書]\s*[/／]?\s*(?:Company Secretary)?|Company Secretary|董事\s*[/／]?\s*(?:Director)?|Director|见证人\s*[/／]?\s*(?:Witness)?|見證人\s*[/／]?\s*(?:Witness)?|Witness)\s*$/iu;
const dateText = '(?:\\d{4}年\\s*\\d{1,2}月\\s*\\d{1,2}日|\\d{4}[-/]\\d{1,2}[-/]\\d{1,2}|\\d{1,2}\\s+[A-Za-z]+\\s+\\d{4}|[A-Za-z]+\\s+\\d{1,2},?\\s+\\d{4})';
const adoptionDate = new RegExp('(?:采纳日期|採納日期|adoption date)\\s*[:：]?\\s*('+dateText+')','iu');
const signingDate = new RegExp('^(?:date of execution(?: and delivery)?|execution date|date of signing|签署日期|簽署日期)\\s*[:：]?\\s*('+dateText+')','iu');
const personDate = new RegExp('^(?:date|日期)\\s*[:：]?\\s*('+dateText+')','iu');
const resolutionDate = new RegExp('^(?:(?:duly\\s+authori[sz]ed\\s+by\\s+(?:a\\s+)?)?board\\s+resolution\\s+(?:dated|date)|董事[会會]决议日期|董事會決議日期)\\s*[:：]?\\s*('+dateText+')','iu');
const blockDateFields = [{pattern:personDate,label:'日期'},{pattern:resolutionDate,label:'董事会决议日期'}];
const confirmationDate = new RegExp('(?:现行版本確認|現行版本確認|current version confirmation).*?('+dateText+')','iu');
const unique = <T>(v:T[]) => [...new Set(v)];
function box(region:DocumentRegion):SignatureBox|null {
  const p=region.polygons.flat();if(!p.length)return null;
  const x=Math.min(...p.map(p=>p[0])),y=Math.min(...p.map(p=>p[1])),right=Math.max(...p.map(p=>p[0])),bottom=Math.max(...p.map(p=>p[1]));
  return [x,y,right,bottom].every(Number.isFinite)&&right>x&&bottom>y?{x,y,width:right-x,height:bottom-y}:null;
}
const right=(b:SignatureBox)=>b.x+b.width, bottom=(b:SignatureBox)=>b.y+b.height;
const overlapsX=(a:SignatureBox,b:SignatureBox)=>Math.max(0,Math.min(right(a),right(b))-Math.max(a.x,b.x))/Math.min(a.width,b.width)>.6;
const inside=(a:SignatureBox,b:SignatureBox)=>a.x>=b.x-3&&a.y>=b.y-3&&right(a)<=right(b)+3&&bottom(a)<=bottom(b)+3;
const intersects=(a:SignatureBox,b:SignatureBox)=>Math.max(a.x,b.x)<Math.min(right(a),right(b))&&Math.max(a.y,b.y)<Math.min(bottom(a),bottom(b));
const distance=(a:SignatureBox,b:SignatureBox)=>Math.max(0,a.y-bottom(b),b.y-bottom(a));
function valid(page:DocumentPageArtifact,r:DocumentRegion){
  const measuredInk=r.source==='image'&&r.source_id.startsWith('visible-ink-')&&r.processing_status==='image_only';
  const b=box(r);return r.document_version_id===page.scope.documentVersionId&&r.parse_revision===page.scope.parseRevision&&r.page_asset_id===page.page.page_asset_id&&(r.processing_status==='ready'||measuredInk)&&b&&b.x>=0&&b.y>=0&&right(b)<=page.page.width&&bottom(b)<=page.page.height&&
    (r.source!=='native_pdf'||page.nativeTrust==='validated_geometry_and_visibility')&&
    (r.raw_text!==null?sha256(r.raw_text)===r.raw_text_sha256:['signature','image'].includes(r.kind)&&r.raw_text_sha256===null);
}
function lines(regions:DocumentRegion[]):Line[]{
  // Layout OCR already supplies whole lines. Native runs are joined only on one
  // baseline and across small gaps, so adjacent signing columns stay separate.
  const layout=regions.filter(r=>r.source==='vl_ocr'&&r.kind==='text');
  const selected=regions.filter(r=>r.kind==='text'&&r.source!=='vl_ocr'&&!/:word[:_-]/u.test(r.source_id));
  const result:Line[]=[];
  for(const r of selected.sort((a,b)=>box(a)!.y-box(b)!.y||box(a)!.x-box(b)!.x)){
    const b=box(r)!,text=clean(r.raw_text!);if(!text)continue;
    const prior=result.find(l=>l.regions[0]!.source===r.source&&Math.abs(l.box.y-b.y)<Math.min(l.box.height,b.height)*.4&&b.x>=right(l.box)-2&&b.x-right(l.box)<Math.max(12,b.height));
    if(prior){prior.text+=' '+text;prior.box={...prior.box,width:right(b)-prior.box.x,height:Math.max(bottom(prior.box),bottom(b))-prior.box.y};prior.regions.push(r);}
    else result.push({text,box:b,regions:[r]});
  }
  return [...layout.map(r=>({text:clean(r.raw_text!),box:box(r)!,regions:[r]})),...result.filter(l=>!layout.some(r=>overlapsX(l.box,box(r)!)&&distance(l.box,box(r)!)===0))];
}
const extracted=(text:string,pattern:RegExp)=>pattern.test(text)?clean(text.replace(pattern,'')).replace(/^[_\s:：]+|[_\s]+$/gu,''):null;
const usableName=(value:string|null):value is string=>!!value&&value.length<=120&&!/[\\{}$]|\[signature graphic\]|\b(?:guarantor|company|address|resolution|sample)\b|有限公司|地址|决议|決議/iu.test(value)&&/\p{L}/u.test(value)&&!nameLabel.test(value)&&!roleLabel.test(value)&&
  !/^(?:姓名|签章|簽章|签名|簽名|签字|簽字|name|seal|signature)$/iu.test(value.replace(/[\s_()（）[\]{}:：.。-]/gu,''));

function signingSectionLabel(text:string):string|undefined {
  const heading=clean(text).replace(/[_:：\s]/gu,'');
  if(/^(?:(?:立(?:授[权權])?[书書]人)(?:theundersigned)?|theundersigned)$/iu.test(heading))return '立书人签署';
  if(/^(?:(?:背[书書]人)(?:theendorser)?|theendorser)$/iu.test(heading))return '背书人签署';
  if(/^(?:(?:(?:發票人|发票人)(?:簽章|签章|簽署|签署)?)?co-?maker'?ssignature(?:sample)?|(?:聯合|联合)(?:發票人|发票人)(?:簽章|签章|簽署|签署)?)$/iu.test(heading))return '联合发票人签署';
  if(/^(?:(?:(?:發票人|发票人)(?:簽章|签章|簽署|签署)?)?maker'?ssignature(?:sample)?|(?:發票人|发票人)(?:簽章|签章|簽署|签署))$/iu.test(heading))return '发票人签署';
  return undefined;
}

/** Explicit source headings delimit sections, including both endorser columns. */
function signingSection(source:Line,lines:Line[]):string|undefined {
  const headings=lines.filter(l=>bottom(l.box)<=source.box.y+3&&signingSectionLabel(l.text)).sort((a,b)=>b.box.y-a.box.y);
  const closest=headings[0];
  if(!closest){
    const contained=unique(lines.filter(l=>inside(l.box,source.box)||intersects(l.box,source.box)).map(l=>signingSectionLabel(l.text)).filter((label):label is string=>!!label));
    return contained.length===1?contained[0]:undefined;
  }
  const labels=unique(headings.filter(l=>Math.abs(l.box.y-closest.box.y)<3).map(l=>signingSectionLabel(l.text)));
  return labels.length===1?labels[0]:undefined;
}

function printedSigner(text:string){
  const adoption=adoptionDate.exec(text),trailingDate=new RegExp('\\s+('+dateText+')\\s*$','iu').exec(text);
  const withoutDate=adoption?text.slice(0,adoption.index).trim():trailingDate?text.slice(0,trailingDate.index).trim():text;
  const suffix=roleSuffix.exec(withoutDate);
  let name=extracted(withoutDate,nameLabel),role:string|null=null;
  if(/^创办成员|^創辦成員/u.test(withoutDate))role=withoutDate.match(/^(创办成员|創辦成員)/u)![1]!;
  if(suffix){name=clean(withoutDate.slice(0,suffix.index));role=suffix[0];if(nameLabel.test(name))name=extracted(name,nameLabel);}
  return usableName(name)&&!signingLabel.test(name)?{name,role,adoption,trailingDate,suffix}:null;
}

/** OCR may emit printed name, capacity and date as separate blocks on one
 * baseline. Join only a unique adjacent name/capacity pair outside tables. */
function executionLines(source:Line[],tables:DocumentRegion[],width:number):Line[]{
  const consumed=new Set<Line>(),joined:Line[]=[];
  const sameRow=(a:Line,b:Line)=>Math.abs(a.box.y-b.box.y)<Math.min(a.box.height,b.box.height)*.45;
  for(const capacity of source){
    if(!roleSuffix.test(capacity.text)||capacity.text.replace(roleSuffix,'').trim()||tables.some(t=>inside(capacity.box,box(t)!)))continue;
    const names=source.filter(l=>l!==capacity&&!consumed.has(l)&&sameRow(l,capacity)&&right(l.box)<=capacity.box.x&&capacity.box.x-right(l.box)<=width*.08&&usableName(l.text)&&!signingLabel.test(l.text)&&!roleLabel.test(l.text)&&!idLabel.test(l.text));
    if(names.length!==1)continue;
    const name=names[0]!;
    const dates=source.filter(l=>l!==capacity&&sameRow(l,capacity)&&l.box.x>=right(capacity.box)&&l.box.x-right(capacity.box)<=width*.08&&new RegExp('^'+dateText+'$','iu').test(l.text));
    const parts=[name,capacity,...(dates.length===1?dates:[])];
    const end=Math.max(...parts.map(l=>right(l.box)));
    joined.push({text:parts.map(l=>l.text).join(' '),box:{...name.box,width:end-name.box.x},regions:parts.flatMap(l=>l.regions)});
    parts.forEach(l=>consumed.add(l));
  }
  return [...source.filter(l=>!consumed.has(l)),...joined];
}

function applyObservations(records:AutomaticSignatureRecord[],page:DocumentPageArtifact,observations:SignatureObservation[]){
    // Model observations may classify visual presence, never supply a name.
    const noticeMatches=new Map<AutomaticSignatureRecord,Array<{kind:SignatureObservation['kind'];box:SignatureBox}>>();
    for(const o of observations){
      if(o.pageNumber!==page.page.page_number||o.parseRevision!==page.scope.parseRevision||o.sourceSha256!==page.scope.sourceSha256||o.imageSha256!==page.imageSha256||o.confidence<.8)continue;
      const b={x:o.box.x*page.page.width/o.imageWidth,y:o.box.y*page.page.height/o.imageHeight,width:o.box.width*page.page.width/o.imageWidth,height:o.box.height*page.page.height/o.imageHeight};
      if(![b.x,b.y,b.width,b.height].every(Number.isFinite)||b.x<0||b.y<0||b.width<=0||b.height<=0||right(b)>page.page.width||bottom(b)>page.page.height)continue;
      const matches=records.filter(r=>r.pageNumber===page.page.page_number&&overlapsX(r.box,b)&&distance(r.box,b)===0);
      if(matches.length===1){
        const record=matches[0]!;
        if(record.id.startsWith('nd2a-signature:')){
          // Keep the original signing window throughout matching. A later
          // printed-name or conflicting observation must not overwrite ink.
          if(!inside(b,record.box))continue;
          const list=noticeMatches.get(record)??[];
          if(!list.some(v=>v.kind===o.kind&&JSON.stringify(v.box)===JSON.stringify(b)))list.push({kind:o.kind,box:b});
          noticeMatches.set(record,list);
        }else{record.presence=({handwriting:'handwriting',blank_signing_slot:'blank',printed_name:'printed',stamp:'stamp',uncertain:'unknown'} as const)[o.kind];record.box=b;}
      }
    }
    for(const [record,matches] of noticeMatches){
      if(matches.length!==1){record.presence='unknown';continue;}
      const match=matches[0]!;
      record.presence=({handwriting:'handwriting',blank_signing_slot:'blank',printed_name:'printed',stamp:'stamp',uncertain:'unknown'} as const)[match.kind];record.box=match.box;
    }
}

/** Automatic read projection over immutable source pages. Does not create
 * confirmations, infer handwriting identity, run models, or rewrite history. */
export function automaticSignatureInformation(input:Input):AutomaticSignatureInformation {
  const result:AutomaticSignatureInformation={version:'source-signature-blocks-v1',documentId:input.documentId,parseRevision:input.parseRevision,sourceSha256:input.sourceSha256,records:[],dates:[],coverage:{processedPages:[],unavailablePages:[]}};
  for(const page of input.pages){
    const pageNumber=page.page.page_number;
    if(page.status==='failed'||page.scope.documentVersionId!==input.documentId||page.scope.parseRevision!==input.parseRevision||page.scope.sourceSha256!==input.sourceSha256||page.page.source_sha256!==input.sourceSha256||page.page.document_version_id!==input.documentId||page.page.parse_revision!==input.parseRevision){result.coverage.unavailablePages.push(pageNumber);continue;}
    const notice=directorNoticeSignatures(page,input.directoryRevision);
    if(notice){applyObservations(notice,page,input.observations??[]);result.records.push(...notice);result.coverage.processedPages.push(pageNumber);continue;}
    const regions=page.regions.filter(r=>valid(page,r));
    // Older parses sometimes de-duplicated a complete layout OCR line against
    // native runs whose visibility is still unverified. Retain the actual OCR
    // line in that case; never promote those unverified native runs.
    const canonical=regions.filter(r=>page.canonicalRegionIds.includes(r.region_id)||r.source==='vl_ocr');
    const textLines=lines(canonical),tables=canonical.filter(r=>r.kind==='table');
    const graphics=canonical.filter(r=>['signature','image'].includes(r.kind)&&box(r)!.width<page.page.width*.65&&box(r)!.height<page.page.height*.2)
      .filter((r,index,all)=>!all.slice(0,index).some(other=>inside(box(r)!,box(other)!)||inside(box(other)!,box(r)!)));
    const refs=(rs:DocumentRegion[])=>unique(page.anchors.filter(a=>a.document_version_id===input.documentId&&a.parse_revision===input.parseRevision&&a.page_number===pageNumber&&a.block_ids.some(id=>rs.some(r=>r.region_id===id||r.source_id===id))).map(a=>a.anchor_id)).map(anchorId=>({documentVersionId:input.documentId,parseRevision:input.parseRevision,directoryRevision:input.directoryRevision,anchorId}));
    const value=(label:string,text:string,source:Line):AutomaticSignatureValue=>({label,value:clean(text),evidence:refs(source.regions),box:source.box});
    const uncertain=(rs:DocumentRegion[])=>rs.some(r=>page.sourceTextAssembly?.uncertainRegionIds.includes(r.region_id)||page.conflicts.some(c=>c.region_ids.includes(r.region_id)));
    const record=(id:string,source:Line,name:AutomaticSignatureValue|null,role:AutomaticSignatureValue|null,number:AutomaticSignatureValue|null,graphic?:DocumentRegion,embedded=false):AutomaticSignatureRecord=>({id:`auto:${pageNumber}:${id}`,label:signingSection(source,textLines),pageNumber,box:graphic?box(graphic)!:source.box,presence:graphic||embedded?'graphic':'unknown',name,role,number,dates:[],evidence:refs(graphic?[graphic]:source.regions),uncertainText:uncertain(source.regions)});
    for(const line of textLines){const match=signingDate.exec(line.text);if(match)result.dates.push({...value('文件签署日期',match[1]!,line),pageNumber});}
    const used=new Set<string>();
    for(const table of tables){
      const rows=signatureTableRows(table.raw_text!),bounds=box(table)!;if(!rows.length)continue;
      const tableLine={text:table.raw_text!,box:bounds,regions:[table]};
      // A specimen register is row-oriented: headers, not column width or
      // repeated spelling, establish the name / capacity / identity relation.
      const headings=rows[0]!.map(c=>clean(c).toLowerCase());
      const nameColumn=headings.findIndex(c=>/^(?:name and capacity|name & capacity|姓名及职务|姓名及職務)$/u.test(c));
      const numberColumn=headings.findIndex(c=>/^(?:identity record|identification document type and number|身份证号码|身份證號碼)$/u.test(c));
      const specimenColumn=headings.findIndex(c=>/^(?:authori[sz]ed specimen|specimen signature|signature specimen|签字样本|簽字樣本)$/u.test(c));
      if(rows[0]!.length===3&&new Set([nameColumn,numberColumn,specimenColumn]).size===3&&Math.min(nameColumn,numberColumn,specimenColumn)>=0){
        for(const [rowIndex,row] of rows.slice(1).entries()){
          const capacity=clean(row[nameColumn]??''),suffix=roleSuffix.exec(capacity);
          const name=clean(suffix?capacity.slice(0,suffix.index):capacity).replace(/\s*[/／]\s*$/u,'');
          if(!usableName(name))continue;
          const printed=clean(row[specimenColumn]??'').replace(/\[signature graphic\]/gu,'').trim();
          const specimenHeadings=textLines.filter(l=>inside(l.box,bounds)&&/^(?:authori[sz]ed specimen|specimen signature|signature specimen|签字样本|簽字樣本)$/iu.test(l.text.trim()));
          const specimenLeft=specimenHeadings.length===1?specimenHeadings[0]!.box.x:undefined;
          const matching=textLines.filter(l=>inside(l.box,bounds)&&printed&&l.text===printed&&(specimenLeft===undefined||l.box.x>=specimenLeft-3));
          // A unique printed specimen name supports navigation to the nearby
          // mark. Repeated names or overlapping person rows retain table scope.
          const located=matching.length===1?matching[0]:undefined;
          const next=located?textLines.filter(l=>inside(l.box,bounds)&&l!==located&&overlapsX(l.box,located.box)&&l.box.y<located.box.y&&rows.slice(1).some(r=>clean(r[specimenColumn]??'').replace(/\[signature graphic\]/gu,'').trim()===l.text)).sort((a,b)=>b.box.y-a.box.y)[0]:undefined;
          const marks=located?graphics.filter(g=>!used.has(g.region_id)&&inside(box(g)!,bounds)&&overlapsX(box(g)!,located.box)&&bottom(box(g)!)<=located.box.y+3&&box(g)!.y>=(next?bottom(next.box):bounds.y)&&distance(box(g)!,located.box)<page.page.height*.08):[];
          const graphic=marks.length===1?marks[0]:undefined;
          const rawNumber=clean(row[numberColumn]??'');
          // Preserve the identity label: a generic identity record is not
          // silently asserted to be a government-issued identity number.
          const r=record(`${table.region_id}:row:${rowIndex+1}`,tableLine,value('姓名',name,tableLine),suffix?value('职位',suffix[0],tableLine):null,
            rawNumber?value(headings[numberColumn]==='identity record'?'身份记录':'证件号码',rawNumber,tableLine):null,graphic,(row[specimenColumn]??'').includes('[signature graphic]'));
          r.purpose='specimen';r.label=`签字样本 · ${name}`;
          result.records.push(r);if(graphic)used.add(graphic.region_id);
        }
        continue;
      }
      // Self-labelled cells establish column membership without assuming equal widths.
      for(let col=0;col<rows[0]!.length;col++){
        const cells=rows.map(row=>clean(row[col]??''));
        const names=cells.map(c=>extracted(c,nameLabel)).filter(usableName);if(names.length!==1)continue;
        let name=names[0]!;
        const latin=(s:string)=>s.replace(/[^a-z]/giu,'').toLowerCase();
        const matchingLines=lines(regions).filter(l=>inside(l.box,bounds)&&(l.text===name||latin(name).length>4&&latin(l.text)===latin(name)));
        const exact=matchingLines.filter(l=>l.text===name),nameLines=exact.length?exact:matchingLines;
        const first=nameLines[0];
        const oneLocation=first&&nameLines.every(l=>overlapsX(l.box,first.box)&&distance(l.box,first.box)<3);
        let preferred=oneLocation?(nameLines.find(l=>l.regions.every(r=>r.source==='native_pdf'))??first):undefined;
        // A layout-table OCR reading can disagree with the printed bilingual
        // name. Prefer a unique whole OCR line only when positioned native runs
        // reproduce it exactly; never translate or select a similar identity.
        const bilingual=/^(.*?)\s*\/\s*[\p{Script=Han}·]+$/u.exec(name);
        if(bilingual && rows.flat().filter(cell=>{
          const candidate=extracted(clean(cell),nameLabel);return candidate?.split('/')[0]!.trim()===bilingual[1]!.trim();
        }).length===1){
          const corroborated=regions.filter(r=>r.source==='pp_ocr'&&r.kind==='text'&&inside(box(r)!,bounds)&&
            r.raw_text!.split('/')[0]!.trim()===bilingual[1]!.trim()&&/\/\s*[\p{Script=Han}·]+$/u.test(r.raw_text!))
            .flatMap(r=>{const native=guaranteeNativeLineAgreement(page,{text:r.raw_text!,box:box(r)!,region:r});
              return native.length?[{text:clean(r.raw_text!),box:box(r)!,regions:[r,...native]}]:[];});
          if(corroborated.length===1)preferred=corroborated[0];
        }
        const nameRegions=preferred?.regions??[];
        if(preferred)name=preferred.text;
        const nameBoxes=nameRegions.map(r=>box(r)!);
        const nameBox=preferred?.box;
        const distinct=nameBox&&nameBoxes.every(b=>overlapsX(b,nameBox)&&distance(b,nameBox)<3);
        const source=distinct?{text:name,box:nameBox,regions:nameRegions}:tableLine;
        const labels=distinct?textLines.filter(l=>signingLabel.test(l.text)&&overlapsX(l.box,nameBox)&&bottom(l.box)<=nameBox.y&&nameBox.y-bottom(l.box)<page.page.height*.16):[];
        const signing=labels.sort((a,b)=>b.box.y-a.box.y)[0];
        const signatureCell=cells.find(c=>signingLabel.test(c));
        const nearbySigning=!!signingSection(tableLine,textLines)||textLines.some(l=>signingLabel.test(l.text)&&overlapsX(l.box,bounds)&&bottom(l.box)<=bounds.y&&bounds.y-bottom(l.box)<page.page.height*.16);
        const signatureSource=signatureCell?tableLine:signing??(nearbySigning?tableLine:undefined);
        if(!signatureSource)continue;
        const gs=signing?graphics.filter(g=>overlapsX(box(g)!,signing.box)&&box(g)!.y>=bottom(signing.box)-3&&bottom(box(g)!)<=bounds.y+3):
          signatureCell&&distinct?graphics.filter(g=>inside(box(g)!,bounds)&&overlapsX(box(g)!,nameBox)&&bottom(box(g)!)<=nameBox.y&&nameBox.y-bottom(box(g)!)<page.page.height*.16):[];
        const graphic=gs.length===1?gs[0]:undefined;
        const roleText=signatureCell?.match(/signature of (director|witness|secretary)/iu)?.[1]??signing?.text.match(/signature of (director|witness|secretary)/iu)?.[1]??cells.map(c=>extracted(c,roleLabel)).find(Boolean);
        const columnValue=(label:string,text:string)=>{
          // Reuse observed geometry only when one exact source line occupies
          // this named column. Shared/ambiguous text keeps table-level scope.
          const matches=distinct?lines(regions).filter(l=>clean(l.text)===clean(text)&&inside(l.box,bounds)&&overlapsX(l.box,nameBox)):[];
          const first=matches[0],uniquePosition=first&&matches.every(l=>distance(l.box,first.box)<3&&overlapsX(l.box,first.box));
          return value(label,text,uniquePosition?first:tableLine);
        };
        const number=cells.map(c=>extracted(c,idLabel)).find(Boolean);
        const r=record(`${table.region_id}:${col}`,tableLine,value('姓名',name,source),roleText?value('职位',roleText,signatureSource):null,number?columnValue('证件号码',number):null,graphic,!!signatureCell?.includes('[signature graphic]'));
        const address=cells.map(c=>extracted(c,addressLabel)??extracted(c,/^(?:Office|办事处|辦事處)\s*[:：]?\s*/iu)).filter(Boolean);
        if(address.length===1)r.address=columnValue(/witness/i.test(roleText??'')?'见证人办事处':'地址',address[0]!);
        for(const c of cells)for(const {pattern,label} of blockDateFields){const m=pattern.exec(c);if(m)r.dates.push(columnValue(label,m[1]!));}
        result.records.push(r);if(graphic)used.add(graphic.region_id);
      }
    }
    // Standalone printed names: explicit name labels, or a name immediately
    // followed by a printed capacity, within one bounded signing block.
    const signingLines=executionLines(textLines,tables,page.page.width).filter(line=>!tables.some(t=>inside(line.box,box(t)!))&&!roleLabel.test(line.text)&&!idLabel.test(line.text)&&!signingLabel.test(line.text)).flatMap(line=>{const signer=printedSigner(line.text);return signer?[{line,...signer}]:[];});
    for(const {line,name,role,adoption,trailingDate,suffix} of signingLines){
      // A nearby next person's mark must not compete with this person's mark.
      // Require a unique closest printed signing block before assigning a
      // graphic; ties remain unassigned, independently of source iteration order.
      const candidates=graphics.filter(g=>!used.has(g.region_id)&&signingSection({text:'',box:box(g)!,regions:[g]},textLines)===signingSection(line,textLines)&&overlapsX(box(g)!,line.box)&&distance(box(g)!,line.box)<page.page.height*.08&&
        !signingLines.some(other=>other.line!==line&&overlapsX(box(g)!,other.line.box)&&distance(box(g)!,other.line.box)<=distance(box(g)!,line.box)+3));
      candidates.sort((a,b)=>distance(box(a)!,line.box)-distance(box(b)!,line.box));
      const graphic=candidates.length===1?candidates[0]:candidates[0]&&distance(box(candidates[1]!)!,line.box)-distance(box(candidates[0])!,line.box)>page.page.height*.03?candidates[0]:undefined;
      const r=record(line.regions[0]!.region_id,line,value('姓名',name,line),role?value('职位',role,line):null,null,graphic);
      if(trailingDate&&suffix){r.dates.push(value('个人签署日期',trailingDate[1]!,line));r.purpose='execution';}
      const nextName=signingLines.map(other=>other.line).filter(l=>l!==line&&l.box.y>line.box.y&&overlapsX(l.box,line.box)).sort((a,b)=>a.box.y-b.box.y)[0];
      const localFields=textLines.filter(l=>l!==line&&l.box.y>=bottom(line.box)&&l.box.y<Math.min(nextName?.box.y??Infinity,bottom(line.box)+page.page.height*.14)&&overlapsX(l.box,line.box)&&!tables.some(t=>inside(l.box,box(t)!)));
      const roleLines=localFields.filter(l=>roleLabel.test(l.text));
      if(!r.role&&roleLines.length===1){const text=extracted(roleLines[0]!.text,roleLabel);if(text)r.role=value('职位',text,roleLines[0]!);}
      const numbers=localFields.filter(l=>idLabel.test(l.text)).flatMap(l=>{const text=extracted(l.text,idLabel);return text?[{text,line:l}]:[];});
      if(numbers.length===1)r.number=value('证件号码',numbers[0]!.text,numbers[0]!.line);
      const addresses=localFields.filter(l=>addressLabel.test(l.text)).flatMap(l=>{const text=extracted(l.text,addressLabel);return text?[{text,line:l}]:[];});
      if(addresses.length===1)r.address=value('住址',addresses[0]!.text,addresses[0]!.line);
      for(const {pattern,label} of blockDateFields){
        const dateLines=localFields.filter(l=>pattern.test(l.text));
        if(dateLines.length===1)r.dates.push(value(label,pattern.exec(dateLines[0]!.text)![1]!,dateLines[0]!));
      }
      if(adoption)r.dates.push(value('采纳日期',adoption[1]!,line));
      if(graphic){
        const headings=textLines.filter(l=>confirmationDate.test(l.text)&&bottom(l.box)<box(graphic)!.y&&distance(l.box,line.box)<page.page.height*.16&&!textLines.some(other=>other!==line&&other!==l&&nameLabel.test(other.text)&&other.box.y>l.box.y&&other.box.y<line.box.y));
        if(headings.length===1)r.dates.push(value('确认日期',confirmationDate.exec(headings[0]!.text)![1]!,headings[0]!));
        used.add(graphic.region_id);
      }
      result.records.push(r);
    }
    // Optional execution sections may contain ink without a printed name.
    // Retain that evidence; an empty name label alone never creates a record.
    for(const graphic of graphics){
      if(used.has(graphic.region_id))continue;
      const source={text:'',box:box(graphic)!,regions:[graphic]};
      if(!signingSection(source,textLines))continue;
      result.records.push(record(graphic.region_id,source,null,null,null,graphic));
    }
    applyObservations(result.records,page,input.observations??[]);
    if(!canonical.length)result.coverage.unavailablePages.push(pageNumber);else result.coverage.processedPages.push(pageNumber);
  }
  result.coverage.unavailablePages=unique([...result.coverage.unavailablePages,...(input.expectedPages??[]).filter(n=>!result.coverage.processedPages.includes(n))]);
  result.records=associateSpecimenIdentities(result.records);
  return result;
}
