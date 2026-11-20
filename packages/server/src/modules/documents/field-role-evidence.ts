import type {ReviewFieldDefinition} from '@hsbc/contracts/review-config';
import type {DocumentPageArtifact} from '@hsbc/contracts/documents';
import type {DocumentRegion} from '@hsbc/contracts/evidence';

export type RoleEvidenceState='supported'|'uncertain'|'unsupported';
type Policy=NonNullable<ReviewFieldDefinition['roleEvidence']>;
const escape=(s:string)=>s.replace(/[.*+?^${}()|[\]\\]/gu,'\\$&').replace(/\s+/gu,'\\s+');
const clean=(s:string)=>s.normalize('NFKC').replace(/\\n/gu,'\n').replace(/<br\s*\/?\s*>/giu,'\n').replace(/<\/?(?:td|th)\b[^>]*>/giu,'\t').replace(/<\/?(?:table|tbody|thead|tr)\b[^>]*>/giu,'\n');
const exact=(a:string,b:string)=>a.normalize('NFKC').replace(/[\s:：]/gu,'').toLowerCase()===b.normalize('NFKC').replace(/[\s:：]/gu,'').toLowerCase();
export function roleLabelKind(text:string,definition:ReviewFieldDefinition):'qualified'|'generic'|undefined {
 const p=definition.roleEvidence;if(!p)return;
 if(p.labels.some(label=>exact(text,label)))return 'qualified';
 if(p.genericLabels.some(label=>exact(text,label)))return 'generic';
}
function labelled(prefix:string,labels:string[],declaration=false){
 return labels.some(label=>new RegExp(`(?:^|[\\n\\t.;。；!?])\\s*["“]?${escape(label)}["”]?\\s*(?:[:：]\\s*|[\\n\\t]\\s*${declaration?'|(?:means|shall mean|is)\\s+|(?:为|為|是|指)\\s*':''})$`,'iu').test(prefix));
}
function heading(line:string,labels:string[]){
 return labels.some(label=>new RegExp(`^(?:(?:signature\\s+of|signed\\s+by|name\\s+of)\\s+)?${escape(label)}(?:\\s*[:：].*)?\\s*$`,'iu').test(line.trim()));
}
function bilingualLabelled(prefix:string,p:Policy){
 const hasHan=(s:string)=>/\p{Script=Han}/u.test(s);
 return p.labels.some(a=>[...p.labels,...p.genericLabels].some(b=>hasHan(a)!==hasHan(b)&&
  new RegExp(`(?:^|[\\n\\t.;。；!?])\\s*${escape(a)}\\s*(?:[/／]\\s*)?${escape(b)}\\s*[:：]\\s*$`,'iu').test(prefix)));
}
/** Only actual headings, never a word mentioned in prose, establish a section. */
export function roleHeadingState(text:string,policy:Policy):RoleEvidenceState {
 const lines=clean(text).split(/[\n\t]/u).map(s=>s.trim()).filter(Boolean);
 for(let i=lines.length-1;i>=0;i--){
  const expected=heading(lines[i]!,policy.headings),other=heading(lines[i]!,policy.otherHeadings);
  if(expected||other)return expected&&!other?'supported':'unsupported';
 }
 return 'uncertain';
}
/** Shared PDF/Word semantics. The caller must first prove this exact quote and
 * occurrence. No display label, model confidence or document-wide name search. */
export function textFieldRoleEvidence(context:string,value:string,definition:ReviewFieldDefinition):RoleEvidenceState {
 const p=definition.roleEvidence;if(!p)return 'unsupported';
 const text=clean(context),needle=clean(value);if(!needle)return 'unsupported';
 // RM template captions are complete affirmative role statements without a
 // colon. Anchor the whole caption so a mention, negation or suffix cannot
 // turn an unrelated company into a guarantee party. PDF/Word share this rule.
 const rmCaption=definition.id==='cgt_field_32'&&p.role==='rm_guarantor'?'RE GUARANTEE GIVEN BY':
  definition.id==='cgt_field_34'&&p.role==='rm_guaranteed_company'?'TO SECURE THE ACCOUNT OF':undefined;
 if(rmCaption&&new RegExp(`^\\s*${escape(rmCaption)}\\s*[:：]?\\s+${escape(needle)}\\s*$`,'iu').test(text))return 'supported';
 if(definition.id==='cgt_field_35'&&p.role==='rm_bank_entity'&&/^(?:HSBC\b|The Hongkong and Shanghai Banking Corporation\b)/iu.test(needle)&&new RegExp(`^\\s*TO\\s*[:：]?\\s+${escape(needle)}\\s*$`,'iu').test(text))return 'supported';
 const positions:number[]=[];
 for(let at=text.indexOf(needle);at>=0;at=text.indexOf(needle,at+needle.length))positions.push(at);
 if(!positions.length)return 'unsupported';
 const states=positions.map(at=>roleAt(text,needle,at,p));
 // Repetition is ambiguous only after some actual role or generic name
 // evidence exists. A repeated printed specimen name alone proves no role.
 return states.length===1?states[0]!:states.some(state=>state!=='unsupported')?'uncertain':'unsupported';
}
function roleAt(text:string,needle:string,at:number,p:Policy):RoleEvidenceState {
 const prefix=text.slice(0,at),suffix=text.slice(at+needle.length);
 const local=prefix.slice(Math.max(prefix.lastIndexOf('\n'),prefix.lastIndexOf('\t'),prefix.lastIndexOf(';'),prefix.lastIndexOf('。'))+1);
 // Explicit negative/other roles must not become positive through a substring.
 if(p.otherHeadings.some(term=>new RegExp(`(?:^|[^\\p{L}])${escape(term)}\\s*[:：]?\\s*$`,'iu').test(local)))return 'unsupported';
 if(roleHeadingState(prefix,p)==='unsupported')return 'unsupported';
 if(labelled(prefix,p.labels)||labelled(prefix,p.declarationTerms,true)||bilingualLabelled(prefix,p))return 'supported';
 if(p.declarationTerms.some(term=>new RegExp(`^\\s*(?:\\(\\s*(?:the\\s+)?["“]?${escape(term)}["”]?\\s*\\)|(?:as|作为|作為)\\s*(?:the\\s+)?${escape(term)}(?:\\b|[，。,:：;；]))`,'iu').test(suffix)))return 'supported';
 // V2 is an explicit configuration opt-in to retain literal, uniquely located
 // model proposals for review. Absence of a label proves neither role nor absence.
 // An opposing heading above still rejects the proposal under both versions.
 if(!labelled(prefix,p.genericLabels))return p.version==='source-role-v2'?'uncertain':'unsupported';
 return roleHeadingState(prefix,p);
}
function box(r:DocumentRegion){
 const points=r.polygons.flat();if(!points.length)return;
 const b={left:Math.min(...points.map(p=>p[0])),right:Math.max(...points.map(p=>p[0])),top:Math.min(...points.map(p=>p[1])),bottom:Math.max(...points.map(p=>p[1]))};
 return b.right>b.left&&b.bottom>b.top?b:undefined;
}
export interface LocatedRoleEvidence {state:RoleEvidenceState;regions:DocumentRegion[]}
export function isRoleAddressee(context:string,value:string,definition:ReviewFieldDefinition){
 return definition.roleEvidence?.role==='lender'&&new RegExp(`^\\s*(?:To|致)\\s*[:：]\\s*${escape(clean(value))}\\s*$`,'iu').test(clean(context));
}
export function isExplicitRoleDeclaration(text:string,value:string,definition:ReviewFieldDefinition){
 const policy=definition.roleEvidence;if(!policy)return false;
 const content=clean(text),at=content.indexOf(clean(value));
 return at>=0&&content.indexOf(clean(value),at+clean(value).length)<0&&
  policy.declarationTerms.some(term=>new RegExp(`(?:^|[\\n.;。；])\\s*["“]?${escape(term)}["”]?\\s*(?:(?:means|shall mean)\\s+|(?:为|為|指)\\s*)$`,'iu').test(content.slice(0,at)));
}
/** A label in another visual column cannot certify a value. Every supporting
 * region is returned so it can be retained as source evidence. */
export function pdfFieldRoleEvidence(page:DocumentPageArtifact,value:string,context:string,definition:ReviewFieldDefinition):LocatedRoleEvidence {
 const p=definition.roleEvidence;if(!p)return {state:'unsupported',regions:[]};
 const regions=page.regions.filter(r=>page.canonicalRegionIds.includes(r.region_id)&&r.raw_text&&r.processing_status==='ready'&&box(r));
 const occurrences=regions.filter(r=>r.raw_text!.includes(value)&&(context.includes(r.raw_text!)||r.raw_text!.includes(context)));
 const results:LocatedRoleEvidence[]=[];
 // A bare addressee is not a lending role. It may be corroborated only by an
 // exact, explicit definition of that same name on the cited source page.
 const declarations=isRoleAddressee(context,value,definition)?regions.filter(r=>isExplicitRoleDeclaration(r.raw_text!,value,definition)):[];
 for(const r of occurrences){
  const b=box(r)!,state=textFieldRoleEvidence(r.raw_text!,value,definition);
  const owners=(r.kind==='table'||r.raw_text!.split('\n').length>2)?[]:regions.flatMap(owner=>{
   if(owner===r||owner.kind!=='text')return[];
   const o=box(owner)!,h=Math.max(o.bottom-o.top,b.bottom-b.top);
   if(o.bottom>b.top+h*.3||b.top-o.bottom>h*12||Math.abs(o.left-b.left)>h*3)return[];
   const state=roleHeadingState(owner.raw_text!,p);
   return state!=='uncertain'?[{owner,state,top:o.top}]:[];
  }).sort((a,c)=>c.top-a.top);
  // A qualified label cannot override an explicit opposing owner nearby.
  if(owners[0]?.state==='unsupported'||roleHeadingState(r.raw_text!.slice(0,r.raw_text!.indexOf(value)),p)==='unsupported')continue;
  const ownerEvidence=owners[0]?[owners[0].owner]:[];
  if(state==='supported'){results.push({state,regions:[r,...ownerEvidence]});continue;}
  if(declarations.length){results.push({state:'supported',regions:[r,...ownerEvidence,...declarations]});continue;}
  if(state==='uncertain'&&p.version==='source-role-v2'){results.push({state,regions:[r,...ownerEvidence]});continue;}
  if(state==='unsupported'&&roleHeadingState(r.raw_text!.slice(0,r.raw_text!.indexOf(value)),p)==='unsupported')continue;
  // Never borrow an external heading for a multi-cell table or prose block.
  if(r.kind==='table'||r.raw_text!.split('\n').length>2){if(state==='uncertain')results.push({state,regions:[r]});continue;}
  const adjacent=regions.filter(label=>{
   if(label===r||label.kind!=='text')return false;
   const l=box(label)!,h=Math.max(l.bottom-l.top,b.bottom-b.top);
   return b.left>=l.right-h*.25&&b.left-l.right<h*8&&Math.abs(b.top+b.bottom-l.top-l.bottom)<=h*1.2||
    l.bottom<=b.top+h*.2&&b.top-l.bottom<h*2&&Math.abs(l.left-b.left)<h*2;
  });
  const qualified=adjacent.filter(label=>p.labels.some(term=>exact(label.raw_text!,term)));
  if(qualified.length){results.push({state:'supported',regions:[r,...ownerEvidence,...qualified]});continue;}
  const generic=adjacent.filter(label=>p.genericLabels.some(term=>exact(label.raw_text!,term)));
  const hasGeneric=generic.length>0||labelled(clean(r.raw_text!).split(clean(value))[0]!,p.genericLabels);
  if(!hasGeneric)continue;
  results.push({state:owners[0]?.state??'uncertain',regions:[r,...generic,...(owners[0]?[owners[0].owner]:[])]});
 }
 const supported=results.filter(r=>r.state==='supported');
 if(supported.length)return {state:'supported',regions:[...new Map(supported.flatMap(r=>r.regions).map(r=>[r.region_id,r])).values()]};
 return results.find(r=>r.state==='uncertain')??{state:'unsupported',regions:[]};
}
