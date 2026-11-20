import { posix } from 'node:path';
import { SaxesParser } from 'saxes';
import { DocxBudgetsSchema, DocxSourceDocumentSchema, type DocxBudgets, type DocxNode, type DocxSourceDocument } from '@hsbc/contracts/docx';
import { DocxError, docxHash, readDocxZip } from './docx-zip.js';
export { DocxError } from './docx-zip.js';
export { defaultDocxBudgets } from '@hsbc/contracts/docx';
interface Xml { name:string; uri:string; attrs:Record<string,string>; children:Xml[]; value:string; path:string }
const W=['http://schemas.openxmlformats.org/wordprocessingml/2006/main','http://purl.oclc.org/ooxml/wordprocessingml/main'];
const OFFICE=['http://schemas.openxmlformats.org/officeDocument/2006/relationships','http://purl.oclc.org/ooxml/officeDocument/relationships'];
const DRAWING=['http://schemas.openxmlformats.org/drawingml/2006/main','http://purl.oclc.org/ooxml/drawingml/main'];
const word=(x:Xml,name?:string)=>W.includes(x.uri)&&(!name||x.name===name);
const attribute=(x:Xml,name:string)=>x.attrs[`w:${name}`]??x.attrs[name];
const children=(x:Xml,name:string)=>x.children.filter(y=>word(y,name));
const descendants=(x:Xml,match:(x:Xml)=>boolean):Xml[]=>x.children.flatMap(c=>[...(match(c)?[c]:[]),...descendants(c,match)]);
function parseXml(bytes:Buffer,b:DocxBudgets,state:{nodes:number;chars:number}):Xml {
  let text:string;try{
    const utf16le=bytes[0]===0xff&&bytes[1]===0xfe,utf16be=bytes[0]===0xfe&&bytes[1]===0xff;
    text=new TextDecoder(utf16le?'utf-16le':utf16be?'utf-16be':'utf-8',{fatal:true}).decode(bytes);
  }catch{throw new DocxError('docx_xml_encoding_invalid');}
  if(/<!DOCTYPE|<!ENTITY/iu.test(text))throw new DocxError('docx_xml_dtd_forbidden');
  const parser=new SaxesParser({xmlns:true});const stack:Xml[]=[],counts:Array<Map<string,number>>=[];let root:Xml|undefined;
  parser.on('doctype',()=>{throw new DocxError('docx_xml_dtd_forbidden');});
  parser.on('opentag',tag=>{
    if(++state.nodes>b.maxXmlNodes||stack.length>=b.maxXmlDepth)throw new DocxError('docx_xml_budget');
    const key=`{${tag.uri}}${tag.local}`,siblings=counts.at(-1),index=(siblings?.get(key)??0)+1;siblings?.set(key,index);
    const prefix=W.includes(tag.uri)?'w':DRAWING.includes(tag.uri)?'a':tag.prefix;
    const node:Xml={name:tag.local,uri:tag.uri,attrs:{},children:[],value:'',path:`${stack.at(-1)?.path??''}/${prefix?prefix+':':''}${tag.local}[${index}]`};
    for(const a of Object.values(tag.attributes))node.attrs[W.includes(a.uri)?`w:${a.local}`:OFFICE.includes(a.uri)?`r:${a.local}`:a.local]=a.value;
    if(stack.length)stack.at(-1)!.children.push(node);else if(root)throw new DocxError('docx_xml_multiple_roots');else root=node;
    stack.push(node);counts.push(new Map());
  });
  const append=(value:string)=>{state.chars+=value.length;if(state.chars>b.maxTextCharacters)throw new DocxError('docx_text_budget');if(stack.length)stack.at(-1)!.value+=value;};
  parser.on('text',append);parser.on('cdata',append);parser.on('closetag',()=>{stack.pop();counts.pop();});
  parser.on('error',()=>{throw new DocxError('docx_xml_invalid');});
  try{parser.write(text).close();}catch(error){if(error instanceof DocxError)throw error;throw new DocxError('docx_xml_invalid');}
  if(!root)throw new DocxError('docx_xml_empty');return root;
}
interface Rel { id:string;type:string;target:string;external:boolean }
function resolvePart(part:string,target:string){
  let decoded:string;try{decoded=decodeURIComponent(target);}catch{throw new DocxError('docx_invalid_relationship');}
  if(decoded.includes('\\')||decoded.includes('\0')||decoded.includes(':')||decoded.includes('?')||decoded.includes('#'))throw new DocxError('docx_unsafe_relationship');
  const resolved=posix.normalize(decoded.startsWith('/')?decoded.slice(1):posix.join(posix.dirname(part),decoded));
  if(resolved==='..'||resolved.startsWith('../')||resolved.startsWith('/'))throw new DocxError('docx_unsafe_relationship');return resolved;
}
const bool=(value:string|undefined)=>value===undefined||!['0','false','off'].includes(value.toLowerCase());
/** Native OOXML evidence. Text is preserved; visibleText excludes hidden/revision/comment content. */
export async function parseDocx(bytes:Uint8Array,overrides:Partial<DocxBudgets>={}):Promise<DocxSourceDocument>{
  const b=DocxBudgetsSchema.parse(overrides),pkg=readDocxZip(bytes,b),sourceSha256=docxHash(bytes),state={nodes:0,chars:0};
  const roots=new Map<string,Xml>();const xml=(name:string)=>{const existing=roots.get(name);if(existing)return existing;const raw=pkg.files.get(name);if(!raw)throw new DocxError('docx_required_part_missing');const parsed=parseXml(raw,b,state);roots.set(name,parsed);return parsed;};
  const contentTypes=xml('[Content_Types].xml');
  if(contentTypes.name!=='Types'||contentTypes.uri!=='http://schemas.openxmlformats.org/package/2006/content-types')throw new DocxError('docx_invalid_content_types');
  if(contentTypes.children.some(x=>/macroEnabled|vbaProject|activeX|oleObject/iu.test(x.attrs.ContentType??'')))throw new DocxError('docx_active_content_unsupported');
  const relationships=new Map<string,Map<string,Rel>>();
  for(const [name,raw] of pkg.files){
    if(!name.endsWith('.rels'))continue;
    const part=name==='_rels/.rels'?'':name.replace(/(^|\/)_rels\//u,'$1').replace(/\.rels$/u,'');
    const root=parseXml(raw,b,state),rels=new Map<string,Rel>();
    if(root.name!=='Relationships'||root.uri!=='http://schemas.openxmlformats.org/package/2006/relationships')throw new DocxError('docx_invalid_relationships');
    for(const entry of root.children){
      const id=entry.attrs.Id,type=entry.attrs.Type,target=entry.attrs.Target;if(entry.name!=='Relationship'||!id||!type||!target||rels.has(id))throw new DocxError('docx_invalid_relationship');
      const external=entry.attrs.TargetMode==='External';if(entry.attrs.TargetMode&&!['External','Internal'].includes(entry.attrs.TargetMode))throw new DocxError('docx_invalid_relationship');
      rels.set(id,{id,type,target:external?target:resolvePart(part,target),external});
    }relationships.set(part,rels);
  }
  const main=[...(relationships.get('')?.values()??[])].filter(r=>r.type.endsWith('/officeDocument'));
  if(main.length!==1||main[0]!.external)throw new DocxError('docx_invalid_main_relationship');
  const mainPart=main[0]!.target;
  const declared=contentTypes.children.find(x=>x.name==='Override'&&x.attrs.PartName===`/${mainPart}`)?.attrs.ContentType;
  if(declared!=='application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml')throw new DocxError('docx_not_word_document');
  if(!word(xml(mainPart),'document'))throw new DocxError('docx_invalid_main_document');
  const gaps=new Set<string>(),nodes:DocxNode[]=[],fonts=new Map<string,{name:string;sources:Set<'font_table'|'run'|'style'|'symbol'>;embedded:boolean}>();let aggregateTextCharacters=0;
  const font=(name:string|undefined,source:'font_table'|'run'|'style'|'symbol',embedded=false)=>{if(!name)return;if(name.length>256||!fonts.has(name)&&fonts.size>=256)throw new DocxError('docx_font_budget');const old=fonts.get(name)??{name,sources:new Set(),embedded:false};old.sources.add(source);old.embedded||=embedded;fonts.set(name,old);};
  for(const [part,rels] of relationships){for(const rel of rels.values()){
    if(rel.external)gaps.add('external_relationship_not_loaded');
    else if(!pkg.files.has(rel.target))gaps.add('relationship_target_missing');
    if(rel.type.endsWith('/font')&&!rel.external)gaps.add('embedded_fonts_not_executed');
  }}
  const storyParts=new Set([mainPart]);
  for(const rel of relationships.get(mainPart)?.values()??[])if(!rel.external&&/\/(footnotes|endnotes|comments|header|footer)$/u.test(rel.type)&&pkg.files.has(rel.target))storyParts.add(rel.target);
  for(const [name] of pkg.files){
    if(!name.endsWith('.xml')||!name.startsWith(posix.dirname(mainPart)+'/'))continue;
    const root=xml(name);
    if(word(root)&&['footnotes','endnotes','comments','hdr','ftr'].includes(root.name))storyParts.add(name);
    if(word(root,'fonts'))for(const f of children(root,'font'))font(attribute(f,'name'),'font_table',f.children.some(c=>c.name.startsWith('embed')));
    for(const f of descendants(root,x=>word(x,'rFonts')))for(const k of ['ascii','hAnsi','eastAsia','cs'])font(attribute(f,k),name.endsWith('styles.xml')?'style':'run');
  }
  const styleHidden=new Set<string>(),styleParents=new Map<string,string>();let defaultHidden=false;
  for(const [name,root] of roots)if(name.endsWith('styles.xml'))for(const defaults of children(root,'docDefaults'))if(descendants(defaults,n=>word(n)&&['vanish','webHidden'].includes(n.name)&&bool(attribute(n,'val'))).length){defaultHidden=true;gaps.add('default_hidden_style_conservatively_excluded');}
  for(const [name,root] of roots)if(name.endsWith('styles.xml'))for(const s of children(root,'style')){
    const sid=attribute(s,'styleId');if(!sid)continue;const parent=children(s,'basedOn')[0];if(parent&&attribute(parent,'val'))styleParents.set(sid,attribute(parent,'val')!);
    if(descendants(s,n=>word(n)&&['vanish','webHidden'].includes(n.name)&&bool(attribute(n,'val'))).length)styleHidden.add(sid);
  }
  const hasHiddenStyle=(sid:string|undefined)=>{const visited=new Set<string>();while(sid&&!visited.has(sid)){if(styleHidden.has(sid))return true;visited.add(sid);sid=styleParents.get(sid);}if(sid)gaps.add('style_inheritance_cycle');return false;};
  const nodeId=(part:string,path:string)=>`docx:${docxHash(`${sourceSha256}\0${part}\0${path}`)}`;
  const visibility=(x:Xml,inherited:DocxNode['visibility']):DocxNode['visibility']=>{
    if(inherited!=='visible')return inherited;
    if(word(x,'del')||word(x,'moveFrom')||word(x,'delText')||word(x,'delInstrText'))return 'deleted';
    if(word(x,'ins')||word(x,'moveTo'))return 'inserted';
    if(word(x,'comment'))return 'comment';
    if(word(x)&&x.name.endsWith('PrChange'))return 'unknown';
    if(defaultHidden&&word(x,'r'))return 'hidden';
    if(word(x)&&['footnote','endnote'].includes(x.name)&&['separator','continuationSeparator','continuationNotice'].includes(attribute(x,'type')??''))return 'hidden';
    const props=x.children.filter(c=>word(c)&&['pPr','rPr'].includes(c.name));
    if(props.some(p=>descendants(p,n=>word(n)&&['vanish','webHidden'].includes(n.name)&&bool(attribute(n,'val'))).length||descendants(p,n=>word(n)&&['pStyle','rStyle'].includes(n.name)&&hasHiddenStyle(attribute(n,'val'))).length))return 'hidden';
    return 'visible';
  };
  const kindOf=(x:Xml):DocxNode['kind']|null=>word(x)?({p:'paragraph',r:'run',tbl:'table',tr:'row',tc:'cell',sym:'symbol',footnote:'footnote',endnote:'endnote',txbxContent:'textbox',comment:'comment',sectPr:'section'} as Record<string,DocxNode['kind']>)[x.name]??null:(DRAWING.includes(x.uri)&&x.name==='blip')||(x.uri==='urn:schemas-microsoft-com:vml'&&x.name==='imagedata')?'image':null;
  const textOf=(x:Xml)=>word(x)&&['t','delText','instrText'].includes(x.name)?x.value:word(x,'tab')?'\t':word(x)&&['br','cr'].includes(x.name)?'\n':'';
  function visit(x:Xml,part:string,parentId:string|null,inherited:DocxNode['visibility'],position?:{row:number;column:number}):{text:string;visible:string}{
    const visible=visibility(x,inherited),kind=kindOf(x),id=kind?nodeId(part,x.path):parentId;
    if(nodes.length>=b.maxSourceNodes)throw new DocxError('docx_source_node_budget');
    const own=textOf(x);let node:DocxNode|undefined;
    if(kind){node={id:id!,kind,part,path:x.path,parentId,order:nodes.length,text:'',visibleText:'',textSha256:docxHash(''),visibility:visible,excludedFromVisibleFacts:visible!=='visible',coverageGaps:[],fontNames:[]};nodes.push(node);}
    if(visible!=='visible')gaps.add(`${visible}_content_excluded`);
    if(word(x,'instrText')||word(x,'fldSimple'))gaps.add('dynamic_fields_not_evaluated');
    if(word(x,'numPr'))gaps.add('numbering_label_requires_preview_verification');
    if(word(x,'sdt'))gaps.add('content_control_state_requires_verification');
    if(x.uri.includes('/officeDocument/2006/math'))gaps.add('equation_layout_not_reconstructed');
    if(x.name==='AlternateContent'){gaps.add('alternate_content_branches_unresolved');if(node){node.visibility='unknown';node.excludedFromVisibleFacts=true;}}
    if(node?.kind==='symbol'){
      const name=attribute(x,'font')??'',charCode=attribute(x,'char')??'';
      font(name,'symbol');node.fontNames=[name];node.symbol={font:name,charCode,unicodeCandidate:/^wingdings$/iu.test(name)&&/^f0fc$/iu.test(charCode)?'✓':null,meaningConfirmed:false};
      node.coverageGaps.push('symbol_glyph_requires_render_verification');gaps.add('symbol_glyph_requires_render_verification');
    }
    if(node?.kind==='cell'){
      const props=children(x,'tcPr')[0],span=props?children(props,'gridSpan')[0]:undefined,merge=props?children(props,'vMerge')[0]:undefined;
      const gridSpan=span?Number(attribute(span,'val')):1;if(!Number.isInteger(gridSpan)||gridSpan<1||gridSpan>1000)throw new DocxError('docx_invalid_table_span');
      if(merge&&attribute(merge,'val')&&!['restart','continue'].includes(attribute(merge,'val')!))throw new DocxError('docx_invalid_table_span');
      node.cell={rowIndex:position?.row??0,columnIndex:position?.column??0,gridSpan,verticalMerge:merge?attribute(merge,'val')==='restart'?'restart':'continue':'none'};
      if(gridSpan>1||merge){node.coverageGaps.push('merged_cell_layout_requires_preview_verification');gaps.add('merged_cell_layout_requires_preview_verification');}
      if(props&&children(props,'hMerge').length){node.coverageGaps.push('legacy_horizontal_merge_unresolved');gaps.add('legacy_horizontal_merge_unresolved');}
    }
    if(node?.kind==='image'){
      const rid=x.attrs['r:embed']??x.attrs['r:link']??x.attrs['r:id']??null,rel=rid?relationships.get(part)?.get(rid):undefined;
      node.reference={kind:'image',targetId:null,relationshipId:rid,part:rel&&!rel.external?rel.target:null,sha256:rel&&!rel.external&&pkg.files.has(rel.target)?docxHash(pkg.files.get(rel.target)!):null,external:rel?.external??false};
      if(!rel||rel.external||!pkg.files.has(rel.target)){node.coverageGaps.push('image_source_unavailable');gaps.add('image_source_unavailable');}
    }
    if(word(x)&&['footnoteReference','endnoteReference','commentReference'].includes(x.name)){
      const type=x.name.replace('Reference','') as 'footnote'|'endnote'|'comment',rel=[...(relationships.get(part)?.values()??[])].find(r=>r.type.endsWith('/'+type+'s'));
      const reference:DocxNode={id:nodeId(part,x.path),kind:'run',part,path:x.path,parentId,order:nodes.length,text:'',visibleText:'',textSha256:docxHash(''),visibility:visible,excludedFromVisibleFacts:visible!=='visible',coverageGaps:[],fontNames:[],reference:{kind:type,targetId:attribute(x,'id')??null,relationshipId:rel?.id??null,part:rel&&!rel.external?rel.target:null,sha256:null,external:rel?.external??false}};nodes.push(reference);
    }
    if(node&&['footnote','endnote','comment'].includes(node.kind))node.reference={kind:node.kind as 'footnote'|'endnote'|'comment',targetId:attribute(x,'id')??null,relationshipId:null,part,sha256:null,external:false};
    if(node?.kind==='run')for(const r of descendants(x,n=>word(n,'rFonts')))for(const key of ['ascii','hAnsi','eastAsia','cs']){const name=attribute(r,key);if(name){node.fontNames.push(name);font(name,'run');}}
    let text=own,visibleText=visible==='visible'&&!word(x,'instrText')?own:'';
    let row=0,column=0;
    if(word(x,'tr')){const before=children(x,'trPr').flatMap(p=>children(p,'gridBefore'))[0];if(before){column=Number(attribute(before,'val'));if(!Number.isInteger(column)||column<0||column>1000)throw new DocxError('docx_invalid_table_span');}}
    for(const child of x.children){
      if(word(x,'tr')&&word(child,'tc')){
        const value=visit(child,part,id,visible,{row:position?.row??0,column});text+=value.text;visibleText+=value.visible;
        const props=children(child,'tcPr')[0],span=props?children(props,'gridSpan')[0]:undefined;column+=span?Number(attribute(span,'val')):1;
      }else{const value=visit(child,part,id,x.name==='AlternateContent'?'unknown':visible,word(x,'tbl')&&word(child,'tr')?{row:row++,column:0}:position);text+=value.text;visibleText+=value.visible;}
      if(word(child)&&['p','tr','tc'].includes(child.name)){text+='\n';if(visible==='visible')visibleText+='\n';}
    }
    if(node?.symbol){text+=`[${node.symbol.font}:${node.symbol.charCode}]`;/* Symbol identity is source evidence, not verified rendered text. */}
    if(node){
      const factText=node.excludedFromVisibleFacts?'':visibleText;
      aggregateTextCharacters+=text.length+factText.length;
      if(aggregateTextCharacters>2*b.maxTextCharacters)throw new DocxError('docx_aggregate_text_budget');
      node.text=text;node.visibleText=factText;node.textSha256=docxHash(text);
    }
    return {text,visible:visible==='visible'?visibleText:''};
  }
  const activeHeadersFooters=new Set<string>();
  function storyReferences(x:Xml,inherited:DocxNode['visibility']){
    const state=visibility(x,inherited);
    if(state==='visible'&&word(x)&&['headerReference','footerReference'].includes(x.name)){
      const rel=relationships.get(mainPart)?.get(x.attrs['r:id']??'');
      if(rel&&!rel.external&&/\/(header|footer)$/u.test(rel.type))activeHeadersFooters.add(rel.target);
    }
    for(const child of x.children)storyReferences(child,state);
  }
  storyReferences(xml(mainPart),'visible');
  for(const part of [mainPart,...[...storyParts].filter(p=>p!==mainPart).sort()]){
    const root=xml(part),unused=word(root)&&['hdr','ftr'].includes(root.name)&&!activeHeadersFooters.has(part);
    if(unused)gaps.add('unreferenced_story_not_visible_fact');
    visit(root,part,null,word(root,'comments')?'comment':unused?'unknown':'visible');
  }
  const noteTargets=new Map<string,string>();
  for(const n of nodes)if(n.reference&&['footnote','endnote','comment'].includes(n.kind)){
    const key=`${n.part}:${n.kind}:${n.reference.targetId}`;
    if(n.reference.targetId===null||noteTargets.has(key))throw new DocxError('docx_duplicate_or_missing_note_id');noteTargets.set(key,n.id);
  }
  for(const n of nodes)if(n.reference&&n.reference.kind!=='image'){
    const r=n.reference,raw=r.targetId;r.ooxmlId=raw??undefined;
    r.targetId=raw!==null&&r.part?noteTargets.get(`${r.part}:${r.kind}:${raw}`)??null:null;
    if(!r.targetId){n.coverageGaps.push('note_reference_unresolved');gaps.add('note_reference_unresolved');}
  }
  const byId=new Map(nodes.map(n=>[n.id,n]));
  const noteOwner=(n:DocxNode):string|null=>{let current:DocxNode|undefined=n;while(current){if(current.kind==='footnote'||current.kind==='endnote')return current.id;current=current.parentId?byId.get(current.parentId):undefined;}return null;};
  const reachable=new Set<string>(),referencesByNote=new Map<string,string[]>();
  for(const n of nodes)if(n.kind==='run'&&!n.excludedFromVisibleFacts&&n.reference?.targetId&&['footnote','endnote'].includes(n.reference.kind)){
    const owner=noteOwner(n);
    if(owner){const refs=referencesByNote.get(owner)??[];refs.push(n.reference.targetId);referencesByNote.set(owner,refs);}
    else if(n.part===mainPart||activeHeadersFooters.has(n.part))reachable.add(n.reference.targetId);
  }
  for(const id of reachable)for(const next of referencesByNote.get(id)??[])reachable.add(next);
  for(const n of nodes){const owner=noteOwner(n);if(owner&&!reachable.has(owner)){
    n.excludedFromVisibleFacts=true;n.visibleText='';if(n.visibility==='visible')n.visibility='unknown';
    n.coverageGaps.push('unreferenced_note_not_visible_fact');gaps.add('unreferenced_note_not_visible_fact');
  }}
  for(const [part] of pkg.files)if(part.endsWith('.xml')&&part!==mainPart&&!roots.has(part)&&part!=='[Content_Types].xml')gaps.add('unparsed_package_xml_part');
  if(!nodes.some(n=>n.kind==='paragraph'||n.kind==='table'))gaps.add('source_body_empty');
  gaps.add('source_to_preview_mapping_not_established');
  gaps.add('source_visibility_is_markup_only');
  return DocxSourceDocumentSchema.parse({schemaVersion:'docx.v1',sourceSha256,contentFingerprint:pkg.contentFingerprint,nodes,fonts:[...fonts.values()].map(f=>({...f,sources:[...f.sources].sort()})).sort((a,b)=>a.name.localeCompare(b.name)),coverageGaps:[...gaps].sort(),stats:{inputBytes:bytes.length,entries:pkg.files.size,expandedBytes:pkg.expandedBytes,xmlNodes:state.nodes,sourceNodes:nodes.length,textCharacters:state.chars}});
}
export async function verifyDocx(bytes:Uint8Array,budgets?:Partial<DocxBudgets>){const source=await parseDocx(bytes,budgets);return {sha256:source.sourceSha256,size:bytes.length,pageCount:null};}
