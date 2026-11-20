import type {DocumentBundle,DocumentFieldObservation,DocumentPageArtifact} from '@hsbc/contracts/documents';
import type {EvidenceAnchor} from '@hsbc/contracts/evidence';
import type {ReviewFieldDefinition} from '@hsbc/contracts/review-config';
import {anchorsForText,sha256} from '../../document/evidence.js';
import {bottom,directorFormLines,formFold,lineLabel,right,rightOfLabel,type FormLine} from './director-notice-source.js';
import {formCheckbox,formPixels} from './form-checkbox.js';
import {annualDirectorIdentity,annualReturnIssueDate} from './annual-return-source.js';

type Candidate=DocumentFieldObservation['candidates'][number];
type Input={fields:DocumentFieldObservation[];definitions:ReviewFieldDefinition[];pages:DocumentPageArtifact[];logicalDocuments:DocumentBundle['logicalDocuments'];anchors:EvidenceAnchor[];loadImage?:(page:DocumentPageArtifact)=>Promise<Uint8Array>};
const version='nar1-source-fields-v1';
const unique=<T>(items:T[])=>[...new Set(items)];
const absent=(text:string)=>/^(?:不適用|不适用|無|无|NIL|N\/?A(?:\s*[-–:].*)?)$/iu.test(text.trim());
const chinese=(text:string)=>!absent(text)&&/^[\p{Script=Han}·\s]{2,60}$/u.test(text)&&!/(姓名|名稱|名称|公司|董事|秘書|秘书)/u.test(text);
const english=(text:string)=>!absent(text)&&/^[A-Z][A-Z .'-]{1,99}$/u.test(text)&&!/(NAME|DIRECTOR|SECRETARY|SURNAME|PREVIOUS|CAPACITY)/u.test(text);

/** Read only explicitly bounded NAR1 fields. This does not infer identities
 * from shared spelling, translate names, or turn incomplete coverage into a
 * successful model receipt. Original candidates/decisions remain inspectable. */
export async function recoverAnnualReturnFields(input:Input){
  const anchors=[...input.anchors],values=new Map<string,Candidate[]>(),handled=new Map<string,Set<number>>();
  const definitions=new Map(input.definitions.filter(d=>d.taxonomyIds?.includes('cgt_annual')&&d.recipe.mode==='cloud_grounded_extract').map(d=>[d.id,d]));
  const scope=input.fields.find(f=>definitions.has(f.fieldId));
  if(!scope||!input.pages.length||new Set(input.pages.map(p=>p.scope.sourceSha256)).size!==1||
    input.pages.some(p=>p.scope.documentVersionId!==scope.documentVersionId||p.scope.parseRevision!==scope.parseRevision)||
    input.fields.some(f=>definitions.has(f.fieldId)&&(f.documentVersionId!==scope.documentVersionId||f.parseRevision!==scope.parseRevision)))return {fields:input.fields,anchors:input.anchors};
  const mark=(id:string,n:number)=>{const pages=handled.get(id)??new Set<number>();pages.add(n);handled.set(id,pages);};
  for(const page of input.pages){
    if(page.scope.sourceFormat==='docx'||!input.fields.some(f=>f.documentVersionId===page.scope.documentVersionId&&f.parseRevision===page.scope.parseRevision))continue;
    const owners=input.logicalDocuments.filter(d=>d.pageNumbers.includes(page.page.page_number));
    if(owners.length!==1||owners[0]!.labelId!=='cgt_annual'||!['candidate','confirmed'].includes(owners[0]!.status))continue;
    // Select one line representation before deduplication. A VL paragraph
    // spanning two cells must not suppress the individually located OCR lines.
    const ocr=page.regions.filter(r=>r.source==='pp_ocr');
    const lines=directorFormLines({...page,regions:ocr.length?ocr:page.regions.filter(r=>r.source==='native_pdf')}),n=page.page.page_number;
    if(!lines.some(l=>/^(?:表格)?(?:form)?nar1$/u.test(formFold(l.text))&&l.box.y<page.page.height*.2))continue;
    const evidence=(line:FormLine,text=line.text)=>{try{return anchorsForText(page.page,[line.region],text);}catch{return [];}};
    const add=(id:string,parts:FormLine[],context:FormLine[],separator=' ',extra:EvidenceAnchor[]=[],metadata:Partial<Pick<Candidate,'formRecord'|'normalizedValue'|'displayValue'>>={})=>{
      if(!definitions.has(id)||!parts.length)return;
      const segments=parts.map(line=>({line,anchors:evidence(line)}));if(segments.some(s=>!s.anchors.length))return;
      const ctx=unique([...context,...parts]);if(ctx.some(line=>!evidence(line).length))return;
      const contextAnchors=ctx.flatMap(line=>evidence(line));
      const own=[...segments.flatMap(s=>s.anchors),...extra];anchors.push(...own,...contextAnchors);
      const rawValue=parts.map(line=>line.text).join(separator),candidate:Candidate={rawValue,normalizedValue:rawValue,displayValue:rawValue,
        anchorIds:unique(own.map(a=>a.anchor_id)),contextAnchorIds:unique(contextAnchors.map(a=>a.anchor_id)),pageNumbers:[n],contextText:ctx.map(l=>l.text).join('\n'),
        entityKey:sha256(JSON.stringify([version,id,page.page.page_asset_id,parts.map(l=>l.region.region_id)])),
        evidenceSegments:segments.map(({line,anchors:as})=>({rawValue:line.text,contextText:line.region.raw_text!,anchorIds:as.map(a=>a.anchor_id),contextAnchorIds:contextAnchors.map(a=>a.anchor_id),pageNumbers:[n]}))};
      if(id==='cgt_field_43')candidate.displayValue=parts.map(line=>line.text).join('；');
      // Header occurrences share one displayed number but retain every source.
      if(id==='cgt_field_41')delete candidate.entityKey;
      Object.assign(candidate,metadata);
      const prior=values.get(id)??[];if(!prior.some(c=>c.rawValue===candidate.rawValue&&c.pageNumbers[0]===n))prior.push(candidate);values.set(id,prior);mark(id,n);
    };
    // The company header is above all officer identifiers on continuation pages.
    const numberLabel=lines.find(l=>lineLabel(l,['Business Registration Number','商業登記號碼','商业登记号码'])&&l.box.y<page.page.height*.2);
    if(numberLabel){
      const numbers=lines.filter(l=>/^\d{8}$/u.test(l.text)&&l.box.y>=bottom(numberLabel.box)-2&&l.box.y-bottom(numberLabel.box)<numberLabel.box.height*3&&l.box.x>=numberLabel.box.x-10&&right(l.box)<=right(numberLabel.box)+20);
      if(numbers.length===1)add('cgt_field_41',numbers,[numberLabel]);
    }
    const issueDate=annualReturnIssueDate(lines);
    if(issueDate){
      add('cgt_field_48',issueDate.parts,issueDate.context,' ',[],{normalizedValue:issueDate.iso,displayValue:issueDate.iso});
      // Once the explicitly signed date is located, prior as-at/header date
      // candidates in this same logical return are superseded, not hidden history.
      if(values.has('cgt_field_48'))for(const pn of owners[0]!.pageNumbers)mark('cgt_field_48',pn);
    }
    const company=lines.find(l=>/^(?:1)?(?:公司名稱|公司名称|companyname)/u.test(formFold(l.text)));
    const business=lines.find(l=>/^(?:2)?(?:商業名稱|商业名称|businessname)/u.test(formFold(l.text)));
    if(company&&business&&business.box.y>company.box.y&&business.box.y-bottom(company.box)<page.page.height*.12){
      const names=lines.filter(l=>l.box.y>=bottom(company.box)-2&&bottom(l.box)<business.box.y&&l.box.x>=company.box.x-3&&l.text.length<240&&/(?:有限公司|LIMITED|LTD\.?|CORPORATION|INC\.?|LLC)$/iu.test(l.text));
      // At most one printed Chinese and one English name in this one box.
      if(names.length>0&&names.length<=2&&new Set(names.map(l=>/\p{Script=Han}/u.test(l.text)?'zh':'en')).size===names.length)add('cgt_field_42',names,[company],' / ');
    }
    const address=lines.find(l=>/^(?:6)?(?:在香港的註冊辦事處地址|在香港的注册办事处地址|addressofregisteredofficeinhongkong)/u.test(formFold(l.text)));
    const presentor=lines.find(l=>/^(?:提交人資料|提交人资料|presentor['’]?sreference)/u.test(formFold(l.text)));
    if(address&&presentor&&presentor.box.y>address.box.y){
      const own=lines.filter(l=>l.box.y>bottom(address.box)&&bottom(l.box)<presentor.box.y);
      const labels=[/flat\/?floor\/?block/u,/^building$/u,/street.*(?:estate|lot|village)/u,/^district$/u,/^region$/u];
      const rows=labels.map(re=>own.filter(l=>re.test(formFold(l.text))));
      if(rows.every(r=>r.length===1)){
        const headers=rows.map(r=>r[0]!);
        if(headers.every((h,i)=>i===0||h.box.y>headers[i-1]!.box.y)){
          const parts=headers.map((label,i)=>own.filter(l=>l.box.x>=Math.max(...headers.map(h=>right(h.box)))+3&&l.box.y>=label.box.y-label.box.height*1.2&&bottom(l.box)<(headers[i+1]?.box.y??presentor.box.y)-2&&!absent(l.text)));
          if(parts.every(part=>part.length===1))add('cgt_field_43',parts.flat(),[address,...headers],'\n');
        }
      }
    }
    const naturalHeadings=lines.filter(l=>/^(?:a\.)?(?:董事\(自然人\)|director\(naturalperson\)|董事詳情\(自然人\)|董事详情\(自然人\)|detailsofdirector\(naturalperson\))/u.test(formFold(l.text)));
    // This reader supports one record per page. Bilingual heading lines may
    // repeat nearby; multiple distant records must keep the general candidates.
    const natural=naturalHeadings.length&&naturalHeadings.every(l=>l.box.y-naturalHeadings[0]!.box.y<page.page.height*.06)?naturalHeadings[0]:undefined;
    const body=lines.find(l=>/^(?:b\.)?(?:董事\(法人團體\)|董事\(法人团体\)|director\(bodycorporate\))/u.test(formFold(l.text)));
    const reserve=lines.find(l=>/^(?:c\.)?(?:備任董事|备任董事|reservedirector)/u.test(formFold(l.text)));
    if(body||reserve){
      const heading=(body??reserve)!;
      const own=lines.filter(l=>l.box.y>bottom(heading.box));
      const names=own.filter(l=>lineLabel(l,['中文名稱','英文名稱','中文姓名','英文姓名','Name in Chinese','Name in English','Surname','姓氏']));
      const cells=names.flatMap(label=>own.filter(l=>l!==label&&l.box.x>right(label.box)+3&&Math.abs(l.box.y+l.box.height/2-label.box.y-label.box.height/2)<Math.max(l.box.height,label.box.height)*.85));
      // Explicit absence only; actual corporate/reserve directors remain with
      // the general extractor until their complete record can be verified.
      if(cells.some(l=>absent(l.text))&&cells.every(l=>absent(l.text)||/^(?:姓氏|名字|Surname|Other Names)$/u.test(l.text)))for(const id of [44,45,46,47])mark(`cgt_field_${id}`,n);
    }
    // These explicitly headed pages contain secretaries/members/the filing
    // signature, not director-detail records. Do not carry their IDs into a roster.
    if(!naturalHeadings.length&&!body&&!reserve&&lines.some(l=>/^(?:(?:12|14|15|16|a\.|b\.))?(?:公司秘[書书]|companysecretary|有股本公司的成員詳情|非上市公司的成員詳情|particularsofmember|陳述書|陈述书|statement)/u.test(formFold(l.text))))
      for(const id of [45,46,47])mark(`cgt_field_${id}`,n);
    if(natural){
      const end=lines.find(l=>l.box.y>natural.box.y&&/previousnames|前用姓名/u.test(formFold(l.text)))?.box.y;
      if(end===undefined)continue;
      const own=lines.filter(l=>l.box.y>bottom(natural.box)&&bottom(l.box)<end);
      const cn=rightOfLabel(own,['中文姓名','Name in Chinese'],chinese),surname=rightOfLabel(own,['姓氏','Surname'],english),other=rightOfLabel(own,['名字','Other Names'],english);
      const capacity=own.find(l=>lineLabel(l,['身分','身份','Capacity']));
      if(!cn||!surname||!other||!capacity||other.value.box.y<=surname.value.box.y||Math.abs(other.value.box.x-surname.value.box.x)>20)continue;
      const choices=own.filter(l=>/^(?:董事|候補董事|候补董事)$/u.test(formFold(l.text))&&Math.abs(l.box.y-capacity.box.y)<capacity.box.height*2);
      let pixels=null;try{if(input.loadImage)pixels=await formPixels(page,await input.loadImage(page));}catch{/* A failed optional image read never changes the extraction receipt. */}
      const checked=choices.map(line=>({line,check:pixels?formCheckbox(pixels,line.box):null}));
      if(checked.length!==2||checked.some(c=>!c.check||c.check.state==='unknown')||!checked.some(c=>c.check?.state==='checked'))continue;
      const checkAnchors=checked.filter(c=>c.check?.state==='checked').map(({check}):EvidenceAnchor=>{
        const b=check!.box;return {schema_version:'p0.v1',anchor_id:`nar1-checkbox:${sha256(JSON.stringify([page.scope.documentVersionId,page.scope.parseRevision,page.page.page_asset_id,n,page.imageSha256,b])).slice(0,32)}`,evidence_kind:'image_region',document_version_id:page.scope.documentVersionId,parse_revision:page.scope.parseRevision,page_asset_id:page.page.page_asset_id,page_number:n,block_ids:[],text_span_refs:[],polygons:[[[b.x,b.y],[b.x+b.width,b.y],[b.x+b.width,b.y+b.height],[b.x,b.y+b.height]]],granularity:'block',localization_status:'block_only',localization_source:version,configuration_version:version,reason:'closed_checkbox_interior_ink',candidate_anchor_ids:[]};
      });
      const headingAnchors=evidence(natural);if(!headingAnchors.length)continue;
      const record:NonNullable<Candidate['formRecord']>={version:'nar1-director-record-v1',recordId:sha256(JSON.stringify([page.scope,owners[0]!.id,natural.region.region_id,cn.value.region.region_id])),logicalDocumentId:owners[0]!.id,pageNumber:n,headingAnchorIds:headingAnchors.map(a=>a.anchor_id),association:'candidate'};
      const names=[cn.value,surname.value,other.value],context=[natural,capacity,cn.label,surname.label,other.label,...checked.filter(c=>c.check?.state==='checked').map(c=>c.line)];
      add('cgt_field_44',names,context,' ',checkAnchors,{formRecord:record});
      add('cgt_field_45',checked.filter(c=>c.check?.state==='checked').map(c=>c.line),context,' / ',checkAnchors,{formRecord:record});
      add('cgt_field_46',names,context,' ',[],{formRecord:record});
      // The identity block is below Previous Names, but remains within this one
      // natural-person record. Never take a preceding secretary's identity.
      const nextHeading=lines.find(l=>l.box.y>end&&/^(?:[ab]\.)?(?:董事\(|董事詳情\(|detailsofdirector\(|director\(|備任董事|reservedirector|公司秘書|companysecretary)/u.test(formFold(l.text)));
      const recordLines=lines.filter(l=>l.box.y>bottom(natural.box)&&bottom(l.box)<(nextHeading?.box.y??page.page.height));
      const identity=annualDirectorIdentity(recordLines);
      if(identity)add('cgt_field_47',identity.parts,[natural,cn.label,cn.value,...identity.context],' ',[],{formRecord:record,...(identity.partial?{normalizedValue:null,displayValue:`${identity.parts[0]!.text}（部分号码${identity.masked?'，遮挡位见原件':''}）`}:{})});
    }
  }
  const fields=input.fields.map((field):DocumentFieldObservation=>{
    const pages=handled.get(field.fieldId);if(field.humanRevisionId||!pages||!definitions.has(field.fieldId))return field;
    // Keep unsupported pages and unlocated candidates; never erase unseen rows.
    const retained=field.candidates.filter(c=>!c.pageNumbers.length||c.pageNumbers.some(n=>!pages.has(n)));
    const recovered=values.get(field.fieldId)??[];
    const candidates=[...retained,...recovered];
    const prior=field.semanticFilter?.originalCandidates??field.candidates.map((c,i)=>({...c,candidateId:`nar1-prior:${field.id}:${i}`}));
    const selected=recovered.map(c=>({...c,candidateId:`nar1:${sha256(JSON.stringify([field.fieldId,c])).slice(0,32)}`}));
    const originals=[...prior.filter(c=>!selected.some(s=>s.candidateId===c.candidateId)),...selected];
    return {...field,fieldLabel:definitions.get(field.fieldId)!.label,valueMultiplicity:definitions.get(field.fieldId)!.valueMultiplicity,status:candidates.length?'uncertain' as const:'not_found' as const,rawValue:candidates.length===1?candidates[0]!.rawValue:null,normalizedValue:candidates.length===1?candidates[0]!.normalizedValue:null,candidates,
      anchorIds:unique(candidates.flatMap(c=>c.anchorIds)),pageNumbers:unique(candidates.flatMap(c=>c.pageNumbers)),
      coverageGaps:unique([...field.coverageGaps.filter(g=>g!=='field_not_found_in_processed_scope'),version,'entity_candidate_requires_confirmation']),
      semanticFilter:{version:field.semanticFilter?.version??version,model:field.semanticFilter?.model??'source-layout',state:field.semanticFilter?.state==='failed'&&retained.length?'failed' as const:'completed' as const,originalCandidates:originals,
        decisions:originals.map(c=>({candidateId:c.candidateId,decision:selected.some(s=>s.candidateId===c.candidateId)?'selected' as const:c.pageNumbers.length&&c.pageNumbers.every(n=>pages.has(n))?'rejected' as const:field.semanticFilter?.decisions.find(d=>d.candidateId===c.candidateId)?.decision??'uncertain' as const,anchorIds:c.anchorIds,pageNumbers:c.pageNumbers})),reasonCodes:unique([...(field.semanticFilter?.reasonCodes??[]),version])}};
  });
  return {fields,anchors:[...new Map(anchors.map(a=>[a.anchor_id,a])).values()]};
}
