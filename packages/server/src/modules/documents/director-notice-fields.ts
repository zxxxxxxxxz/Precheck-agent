import type {DocumentBundle,DocumentFieldObservation,DocumentPageArtifact} from '@hsbc/contracts/documents';
import type {EvidenceAnchor} from '@hsbc/contracts/evidence';
import type {ReviewFieldDefinition} from '@hsbc/contracts/review-config';
import {anchorsForText,sha256} from '../../document/evidence.js';
import {directorNoticeLayout,formFold,lineLabel,rightOfLabel,bottom,type FormLine} from './director-notice-source.js';
import {formPixels,formCheckbox,type FormPixels} from './form-checkbox.js';

type Candidate=DocumentFieldObservation['candidates'][number];
type Input={fields:DocumentFieldObservation[];definitions:ReviewFieldDefinition[];pages:DocumentPageArtifact[];logicalDocuments:DocumentBundle['logicalDocuments'];anchors:EvidenceAnchor[];loadImage?:(page:DocumentPageArtifact)=>Promise<Uint8Array>};
const unique=<T>(xs:T[])=>[...new Set(xs)];
const version='nd2a-source-fields-v1';
const person=(s:string)=>s.length<100&&/\p{L}/u.test(s)&&!/[<>:：]|不適用|不适用|^N\/?A$|^NIL$|^無$|^无$/iu.test(s);
const chinese=(s:string)=>person(s)&&/^[\p{Script=Han}·\s]+$/u.test(s)&&!/(姓名|名稱|名称|身分|身份|董事|公司|秘書|秘书)/u.test(s);
const english=(s:string)=>person(s)&&/^[A-Z][A-Z .'-]+$/u.test(s)&&!/(SURNAME|OTHER NAMES|NAME IN|DIRECTOR|SECRETARY|CAPACITY|PREVIOUS)/u.test(s);

/** A bounded form reader after material classification. It never fills from a
 * filename, another page's officer, sample answer or a generic Director token. */
export async function recoverDirectorNoticeFields(input:Input){
  const anchors=[...input.anchors],values=new Map<string,Candidate[]>(),handled=new Set<string>();
  const definitions=new Map(input.definitions.filter(d=>d.taxonomyIds?.includes('cgt_change')&&d.recipe.mode!=='manual').map(d=>[d.id,d]));
  for(const page of input.pages){
    if(!input.fields.some(f=>f.documentVersionId===page.scope.documentVersionId&&f.parseRevision===page.scope.parseRevision))continue;
    const owners=input.logicalDocuments.filter(d=>d.pageNumbers.includes(page.page.page_number));
    if(!owners.length||owners.some(d=>d.labelId!=='cgt_change'||d.status==='unknown'||d.status==='conflict'))continue;
    const layout=directorNoticeLayout(page);if(!layout||layout.protectedSheet)continue;
    const {lines,sections}=layout;
    const evidence=(line:FormLine,text=line.text)=>anchorsForText(page.page,[line.region],text);
    const add=(id:string,parts:{line:FormLine;text:string}[],context:FormLine[],normalized?:string,extra:EvidenceAnchor[]=[])=>{
      if(!definitions.has(id)||!parts.length)return;
      const es=parts.map(part=>({part,anchors:evidence(part.line,part.text)}));if(es.some(x=>!x.anchors.length))return;
      const ctx=unique([...context,...parts.map(p=>p.line)]),contextAnchors=ctx.flatMap(l=>evidence(l));
      const sourceAnchors=[...es.flatMap(e=>e.anchors),...extra];anchors.push(...sourceAnchors,...contextAnchors);
      const raw=parts.map(p=>p.text).join(' '),candidate:Candidate={rawValue:raw,normalizedValue:normalized??raw,displayValue:normalized??raw,
        anchorIds:unique(sourceAnchors.map(a=>a.anchor_id)),contextAnchorIds:unique(contextAnchors.map(a=>a.anchor_id)),pageNumbers:[page.page.page_number],
        contextText:ctx.map(l=>l.text).join('\n'),entityKey:sha256(JSON.stringify([page.page.page_asset_id,context.map(l=>l.region.region_id)])),
        evidenceSegments:es.map(({part,anchors:as})=>({rawValue:part.text,contextText:part.line.region.raw_text!,anchorIds:as.map(a=>a.anchor_id),contextAnchorIds:contextAnchors.map(a=>a.anchor_id),pageNumbers:[page.page.page_number]}))};
      const list=values.get(id)??[];
      if(!list.some(c=>c.rawValue===raw&&c.pageNumbers[0]===page.page.page_number))list.push(candidate);
      values.set(id,list);
    };
    const company=lines.find(l=>/^(?:1)?(?:公司名稱|公司名称|companyname)/u.test(formFold(l.text)));
    if(company){
      handled.add('cgt_field_50');
      const end=sections.find(s=>s.top>company.box.y)?.top??bottom(company.box)+page.page.height*.08;
      for(const line of lines.filter(l=>l.box.y>bottom(company.box)-2&&bottom(l.box)<end&&l.box.y-bottom(company.box)<page.page.height*.07&&l.box.x>=company.box.x)){
        for(const text of line.text.split(/\r?\n/u).map(t=>t.trim()).filter(Boolean))if(text.length<240&&/(?:有限公司|LIMITED|LTD\.?|CORPORATION|INC\.?|LLC)$/iu.test(text))add('cgt_field_50',[{line,text}],[company]);
      }
    }
    let pixels:FormPixels|null=null;
    if(input.loadImage&&sections.some(s=>s.kind==='cessation'||s.kind==='appointment'))pixels=await formPixels(page,await input.loadImage(page));
    for(const section of sections.filter(s=>s.kind==='cessation'||s.kind==='appointment')){
      const cessation=section.kind==='cessation',ids=cessation?['cgt_field_52','cgt_field_53','cgt_field_54','cgt_field_55']:['cgt_field_57','cgt_field_58','cgt_field_59'];
      ids.forEach(id=>handled.add(id));
      const own=lines.filter(l=>l.box.y>section.top&&bottom(l.box)<=section.end);
      const boundary=own.find(l=>/bodycorporate|法人團體|法人团体/u.test(formFold(l.text)));
      const identity=own.filter(l=>l.box.y<(boundary?.box.y??section.end));
      const cn=rightOfLabel(identity,['中文姓名','Name in Chinese'],chinese);
      if(cn)add(cessation?'cgt_field_53':'cgt_field_58',[{line:cn.value,text:cn.value.text}],[section.heading,cn.label]);
      const surname=rightOfLabel(identity,['姓氏','Surname'],english),other=rightOfLabel(identity,['名字','Other Names'],english);
      if(surname&&other&&other.value.box.y>surname.value.box.y&&other.value.box.y-bottom(surname.value.box)<page.page.height*.05&&Math.abs(other.value.box.x-surname.value.box.x)<20)
        add(cessation?'cgt_field_54':'cgt_field_58',[{line:surname.value,text:surname.value.text},{line:other.value,text:other.value.text}],[section.heading,surname.label,other.label]);
      const capacity=identity.find(l=>lineLabel(l,['身分','身份','Capacity']));
      if(capacity){
        const choices=identity.filter(l=>l.box.y>=capacity.box.y-8&&l.box.y<capacity.box.y+capacity.box.height*2&&/^(?:董事|公司秘[書书]|候補董事|候补董事)$/u.test(formFold(l.text)));
        const selections=choices.map(line=>({line,selection:pixels?formCheckbox(pixels,line.box):null}));
        // All printed choices need a readable frame; a missing frame is unknown.
        if(selections.length===3&&selections.every(s=>s.selection&&s.selection.state!=='unknown'))for(const {line,selection} of selections.filter(s=>s.selection?.state==='checked')){
          const b=selection!.box,polygon:[number,number][]=[[b.x,b.y],[b.x+b.width,b.y],[b.x+b.width,b.y+b.height],[b.x,b.y+b.height]];
          const imageAnchor:EvidenceAnchor={schema_version:'p0.v1',anchor_id:`nd2a-checkbox:${sha256(JSON.stringify([page.imageSha256,b])).slice(0,32)}`,evidence_kind:'image_region',document_version_id:page.scope.documentVersionId,parse_revision:page.scope.parseRevision,page_asset_id:page.page.page_asset_id,page_number:page.page.page_number,block_ids:[],text_span_refs:[],polygons:[polygon],granularity:'block',localization_status:'block_only',localization_source:version,configuration_version:version,reason:'closed_checkbox_interior_ink',candidate_anchor_ids:[]};
          add(cessation?'cgt_field_52':'cgt_field_57',[{line,text:line.text}],[section.heading,capacity,line],undefined,[imageAnchor]);
        }
      }
      const dateLabel=own.find(l=>lineLabel(l,cessation?['停任日期','Date of Cessation']:['委任日期','Date of Appointment']));
      if(dateLabel){
        const digits=own.filter(l=>/^\d{1,4}$/u.test(l.text)&&l.box.x>dateLabel.box.x+dateLabel.box.width&&Math.abs(l.box.y-dateLabel.box.y)<dateLabel.box.height*1.8).sort((a,b)=>a.box.x-b.box.x);
        const dedup=digits.filter((l,i)=>!digits.slice(0,i).some(p=>p.text===l.text&&Math.abs(p.box.x-l.box.x)<10));
        if(dedup.length===3){
          const [dd,mm,yyyy]=dedup as [FormLine,FormLine,FormLine];
          const units=own.filter(l=>l.box.y>=Math.min(...dedup.map(l=>bottom(l.box)))-3&&l.box.y<Math.max(...dedup.map(l=>bottom(l.box)))+dateLabel.box.height*2);
          const unit=(line:FormLine,re:RegExp)=>units.some(u=>re.test(formFold(u.text))&&Math.abs(u.box.x+u.box.width/2-line.box.x-line.box.width/2)<line.box.width);
          const iso=`${yyyy.text}-${mm.text.padStart(2,'0')}-${dd.text.padStart(2,'0')}`,date=new Date(iso+'T00:00:00Z');
          if(/^\d{4}$/u.test(yyyy.text)&&!Number.isNaN(date.valueOf())&&date.toISOString().slice(0,10)===iso&&unit(dd,/dd/u)&&unit(mm,/mm/u)&&unit(yyyy,/yyyy/u))
            add(cessation?'cgt_field_55':'cgt_field_59',dedup.map(line=>({line,text:line.text})),[section.heading,dateLabel,...units.filter(u=>/dd|mm|yyyy/u.test(formFold(u.text)))],iso);
        }
      }
    }
  }
  const fields=input.fields.map(field=>{
    if(field.humanRevisionId||!handled.has(field.fieldId)||!definitions.has(field.fieldId))return field;
    const candidates=values.get(field.fieldId)??[],prior=field.semanticFilter?.originalCandidates??field.candidates.map((c,i)=>({...c,candidateId:`nd2a-prior:${field.id}:${i}`}));
    const selected=candidates.map(c=>({...c,candidateId:`nd2a:${sha256(JSON.stringify([field.fieldId,c])).slice(0,32)}`}));
    const originals=[...prior.filter(c=>!selected.some(s=>s.candidateId===c.candidateId)),...selected];
    const gaps=unique([...field.coverageGaps.filter(g=>g!=='field_not_found_in_processed_scope'),version,...(!candidates.length?['field_role_requires_confirmation']:[]),'entity_candidate_requires_confirmation']);
    return {...field,status:'uncertain' as const,rawValue:candidates.length===1?candidates[0]!.rawValue:null,normalizedValue:candidates.length===1?candidates[0]!.normalizedValue:null,candidates,
      anchorIds:unique(candidates.flatMap(c=>c.anchorIds)),pageNumbers:unique(candidates.flatMap(c=>c.pageNumbers)),coverageGaps:gaps,
      semanticFilter:{version:field.semanticFilter?.version??version,model:field.semanticFilter?.model??'source-layout',state:'completed' as const,originalCandidates:originals,
        decisions:originals.map(c=>({candidateId:c.candidateId,decision:selected.some(s=>s.candidateId===c.candidateId)?'selected' as const:'rejected' as const,anchorIds:c.anchorIds,pageNumbers:c.pageNumbers})),reasonCodes:unique([...(field.semanticFilter?.reasonCodes??[]),version])}};
  });
  return {fields,anchors:[...new Map(anchors.map(a=>[a.anchor_id,a])).values()]};
}
