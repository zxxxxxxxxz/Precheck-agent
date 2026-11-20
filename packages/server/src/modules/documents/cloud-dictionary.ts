import {createHash} from 'node:crypto';
import type {ReviewConfigManifest} from '@hsbc/contracts/review-config';
import {combineGuaranteeManifests,createMixedGuaranteeManifest} from '@hsbc/contracts/mixed-guarantee';
import {applyCorporateRmSourceReview,applyCorporateRmPartyReview,applyCorporateArticlesReview,createCorporateGuaranteeManifest} from '@hsbc/contracts/corporate-requirements';
import {createPersonalApprovalGuaranteeManifest,createPersonalGuaranteeManifest} from '@hsbc/contracts/personal-requirements';
import {createMortgageWorkbookManifest} from '@hsbc/contracts/mortgage-requirements';
import {createMortgageReviewConfigManifest} from '@hsbc/contracts/insurance-fields';
import {ModelExecutionError} from '../../model/gateway.js';
import type {DocumentCloudInput} from './cloud-extraction-contract.js';
import type {PrivateIntakeProjection} from '../intake/privacy-projection.js';
import {documentSourceQuotes} from './cloud-extraction-source.js';

export const DOCUMENT_DICTIONARY_PROTOCOL_VERSION='verified-control-aliases-v1';

const fail=():never=>{throw new ModelExecutionError('invalid_output',false,'document_dictionary_references');};
export function documentDictionary(fields:DocumentCloudInput['fields'],taxonomy:DocumentCloudInput['taxonomy']){
  const metadata = {taxonomy: taxonomy.map(item => ({typeRef: item.ref, label: item.definition.label, keywords: item.definition.keywords})),
    fields: fields.map(item => ({fieldRef: item.ref, label: item.definition.label, aliases: item.definition.aliases, type: item.definition.type,
      definition: item.definition.semanticDefinition, objectKind: item.definition.objectKind, objectRole: item.definition.objectRole ?? null, valueKind:item.definition.valueKind,
      ...(item.definition.partyKinds?{partyKinds:item.definition.partyKinds}:{}),
      ...(item.definition.valueMultiplicity?{valueMultiplicity:item.definition.valueMultiplicity}:{}),
      ...(item.definition.requireLabel?{requireLabel:true}:{}),...(item.definition.excludedLabels?{excludedLabels:item.definition.excludedLabels}:{}),
      ...(item.definition.partyNameSection?{partyNameSection:item.definition.partyNameSection}:{}),
      ...(item.definition.roleEvidence?{roleEvidence:item.definition.roleEvidence}:{}),
      taxonomyRefs: item.definition.taxonomyIds!.map(id => taxonomy.find(type => type.definition.id === id)?.ref ?? fail())}))};
  return JSON.stringify(metadata);
}
const definitions=(manifest:ReviewConfigManifest)=>({
  fields:manifest.fields.filter(field=>field.recipe.mode==='cloud_grounded_extract').map((definition,index)=>({ref:`field_${index+1}`,definition})),
  taxonomy:manifest.taxonomy.map((definition,index)=>({ref:`type_${index+1}`,definition})),
});
let registered:ReadonlySet<string>|undefined,codeOwned:ReadonlySet<string>|undefined,manifests:ReviewConfigManifest[]|undefined;
/** Only code-owned public definitions enter this registry. Published/user input
 * never registers itself. Match the entire serialized dictionary, not its name. */
export function registeredDocumentDictionaryHashes():ReadonlySet<string>{
  return registered??=new Set(codeOwnedManifests().map(manifest=>{
    const input=definitions(manifest);
    return createHash('sha256').update(documentDictionary(input.fields,input.taxonomy)).digest('hex');
  }));
}
/** Every text a code-owned dictionary can carry: labels, aliases, definitions, keywords, role headings and the
 * program's own enumerations. Never read from a release. */
function codeOwnedDictionaryTexts():ReadonlySet<string>{
  if(codeOwned)return codeOwned;
  const texts=new Set<string>(),collect=(value:unknown):void=>{
    if(typeof value==='string')texts.add(value);
    else if(Array.isArray(value))value.forEach(collect);
    else if(value&&typeof value==='object')Object.values(value).forEach(collect);
  };
  for(const manifest of codeOwnedManifests()){const input=definitions(manifest);collect(JSON.parse(documentDictionary(input.fields,input.taxonomy)));}
  return codeOwned=texts;
}
/** A dictionary sent with one file holds the fields of that file's material types, in its own numbering and, for Word,
 * its own layout; so it rarely matches a registered dictionary as a whole. It is still public when every key is a
 * program-owned property, every reference is a generated ordinal and every text is one of the code-owned texts. A
 * dictionary with any other text (an edited or customer-written definition) stays private and is redacted as before. */
export function codeOwnedDocumentDictionary(text:string):boolean{
  let metadata:unknown;
  try{metadata=JSON.parse(text);}catch{return false;}
  const texts=codeOwnedDictionaryTexts();
  const visit=(value:unknown,key?:string):boolean=>{
    if(value===null||typeof value==='boolean'||typeof value==='number')return true;
    if(typeof value==='string')return (key==='fieldRef'||key==='typeRef'||key==='taxonomyRefs')?/^(?:field|type)_[1-9]\d*$/u.test(value):texts.has(value);
    if(Array.isArray(value))return value.every(item=>visit(item,key));
    if(typeof value==='object')return Object.entries(value as Record<string,unknown>).every(([property,item])=>dictionaryProperties.has(property)&&visit(item,property));
    return false;
  };
  return !!metadata&&typeof metadata==='object'&&!Array.isArray(metadata)&&visit(metadata);
}
function codeOwnedManifests():ReviewConfigManifest[]{
  return manifests??=[createCorporateGuaranteeManifest,createPersonalGuaranteeManifest,
    createMortgageWorkbookManifest,createMortgageReviewConfigManifest,createPersonalApprovalGuaranteeManifest,
    // Mixed releases can preserve the independently published personal approval
    // extension. Derive the entire dictionary from code, never from a release.
    ...([undefined,'source-role-v1','source-role-v2'] as const).map(roleEvidenceVersion=>(id:string)=>combineGuaranteeManifests(id,
      createCorporateGuaranteeManifest(id,{roleEvidenceVersion}),createPersonalApprovalGuaranteeManifest(id))),
    ...([undefined,'source-role-v1','source-role-v2'] as const).map(roleEvidenceVersion=>(id:string)=>createCorporateGuaranteeManifest(id,{roleEvidenceVersion,corporateSectionVersion:'nd2a-sections-v1'})),
    ...([undefined,'source-role-v1','source-role-v2'] as const).map(roleEvidenceVersion=>(id:string)=>createCorporateGuaranteeManifest(id,{roleEvidenceVersion,corporateSectionVersion:'source-fields-v2'})),
    ...([undefined,'source-role-v1','source-role-v2'] as const).map(roleEvidenceVersion=>(id:string)=>createMixedGuaranteeManifest(id,{roleEvidenceVersion,corporateSectionVersion:'source-fields-v2'})),
    ...[createCorporateGuaranteeManifest,createMixedGuaranteeManifest].flatMap(make=>([undefined,'nd2a-sections-v1'] as const).flatMap(corporateSectionVersion=>([undefined,'source-role-v1','source-role-v2'] as const).map(roleEvidenceVersion=>(id:string)=>make(id,{roleEvidenceVersion,corporateSectionVersion,corporateExtractionVersion:'source-fields-v2'})))),
    ...[createCorporateGuaranteeManifest,createMixedGuaranteeManifest].flatMap(make=>([undefined,'nd2a-sections-v1','source-fields-v2'] as const).flatMap(corporateSectionVersion=>([undefined,'source-role-v1','source-role-v2'] as const).map(roleEvidenceVersion=>(id:string)=>make(id,{roleEvidenceVersion,corporateSectionVersion,corporateExtractionVersion:'source-fields-v2',corporateGuaranteeVersion:'bank-amount-v1'})))),
    ...[createCorporateGuaranteeManifest,createMixedGuaranteeManifest].flatMap(make=>([undefined,'nd2a-sections-v1','source-fields-v2'] as const).flatMap(corporateSectionVersion=>([undefined,'source-role-v1','source-role-v2'] as const).map(roleEvidenceVersion=>(id:string)=>make(id,{roleEvidenceVersion,corporateSectionVersion,corporateGuaranteeVersion:'bank-amount-v1'})))),
    (id:string)=>createCorporateGuaranteeManifest(id,{roleEvidenceVersion:'source-role-v1'}),
    (id:string)=>createCorporateGuaranteeManifest(id,{roleEvidenceVersion:'source-role-v2'}),
    (id:string)=>createPersonalGuaranteeManifest(id,{roleEvidenceVersion:'source-role-v1'})].flatMap(create=>{
      const manifest=create('public_dictionary_definition');
      // Register only the exact code-owned articles upgrade of each public
      // dictionary. Never whitelist a published or customer-edited manifest.
      if(!manifest.guaranteeTypes.includes('corporate_guarantee'))return [manifest];
      const articles=applyCorporateArticlesReview(manifest);
      return [manifest,articles,applyCorporateRmPartyReview(manifest),applyCorporateRmPartyReview(articles),applyCorporateRmSourceReview(manifest),applyCorporateRmSourceReview(articles)];
    });
}
/** Metadata may be private, but protocol references must survive intact. */
export function assertDocumentDictionaryReferences(input:DocumentCloudInput,projection:PrivateIntakeProjection){
  let metadata:any;
  try{metadata=JSON.parse(projection.blocks.find(block=>block.id==='dictionary')!.text);}catch{fail();}
  if(!Array.isArray(metadata?.taxonomy)||!Array.isArray(metadata?.fields)||
    metadata.taxonomy.length!==input.taxonomy.length||metadata.fields.length!==input.fields.length)fail();
  if(metadata.taxonomy.some((item:any,index:number)=>item.typeRef!==input.taxonomy[index]!.ref)||
    metadata.fields.some((item:any,index:number)=>item.fieldRef!==input.fields[index]!.ref||
      JSON.stringify(item.taxonomyRefs)!==JSON.stringify(input.fields[index]!.definition.taxonomyIds!.map(id=>input.taxonomy.find(type=>type.definition.id===id)?.ref))))fail();
}
function dictionaryReferenceAliases(input:DocumentCloudInput,projection:PrivateIntakeProjection,metadata?:any){
  if(!metadata)try{metadata=JSON.parse(projection.blocks.find(block=>block.id==='dictionary')!.text);}catch{fail();}
  const replacements=new Map(projection.replacements.map(item=>[item.placeholder,item.original]));
  const aliases=new Map<string,string>();
  const bind=(observed:unknown,expected:string)=>{
    if(observed===expected)return;
    if(typeof observed!=='string'||replacements.get(observed)!==expected||aliases.has(observed)&&aliases.get(observed)!==expected)fail();
    aliases.set(observed as string,expected);
  };
  if(!Array.isArray(metadata?.taxonomy)||!Array.isArray(metadata?.fields)||metadata.taxonomy.length!==input.taxonomy.length||metadata.fields.length!==input.fields.length)fail();
  metadata.taxonomy.forEach((item:any,index:number)=>bind(item.typeRef,input.taxonomy[index]!.ref));
  metadata.fields.forEach((item:any,index:number)=>{
    const field=input.fields[index]!;bind(item.fieldRef,field.ref);
    const refs=field.definition.taxonomyIds!.map(id=>input.taxonomy.find(type=>type.definition.id===id)!.ref);
    if(!Array.isArray(item.taxonomyRefs)||item.taxonomyRefs.length!==refs.length)fail();
    item.taxonomyRefs.forEach((ref:unknown,i:number)=>bind(ref,refs[i]!));
  });
  return aliases;
}

// These are program-owned JSON property names, never configurable labels,
// definitions, role values or document text. PDF and Word share this vocabulary.
const dictionaryProperties=new Set(['taxonomy','fields','typeRef','fieldRef','taxonomyRefs','label','keywords','aliases','type','definition',
  'objectKind','objectRole','valueKind','partyKinds','valueMultiplicity','requireLabel','excludedLabels','partyNameSection','roleEvidence',
  'version','role','labels','genericLabels','headings','otherHeadings','declarationTerms','sourceCoverageIncomplete']);
/** Called only after the full original/redacted byte alignment is verified.
 * Interpret keys in a local copy at the same object position. A placeholder
 * appearing as a private value or in source text never acquires this meaning. */
function dictionaryPropertyAliases(original:string,redacted:string,replacements:ReadonlyMap<string,string>){
  let before:unknown,after:unknown;
  try{before=JSON.parse(original);after=JSON.parse(redacted);}catch{fail();}
  const aliases=new Map<string,string>();
  const visit=(expected:unknown,observed:unknown):unknown=>{
    if(Array.isArray(expected)){
      if(!Array.isArray(observed)||observed.length!==expected.length)return fail();
      return expected.map((value,index)=>visit(value,observed[index]));
    }
    if(expected!==null&&typeof expected==='object'){
      if(observed===null||typeof observed!=='object'||Array.isArray(observed))return fail();
      const entries=Object.entries(expected),actual=Object.entries(observed);
      if(entries.length!==actual.length)return fail();
      return Object.fromEntries(entries.map(([key,value],index)=>{
        const [observedKey,observedValue]=actual[index]!;
        if(!dictionaryProperties.has(key))return fail();
        if(observedKey!==key){
          // Legacy masking can replace individual letters inside a program key,
          // with the alias's canonical case. Verify every fragment against this
          // exact key using the same occurrence alignment as the full dictionary.
          try{documentSourceQuotes(key,observedKey,replacements);}catch{return fail();}
          if(aliases.has(observedKey)&&aliases.get(observedKey)!==key)return fail();
          aliases.set(observedKey,key);
        }
        return [key,visit(value,observedValue)];
      }));
    }
    // Only keys are interpreted. Redacted scalar values remain opaque.
    return observed;
  };
  return {metadata:visit(before,after),aliases};
}
function restoreControlReferences<T>(raw:T,aliases:ReadonlyMap<string,string>,fieldsOnly=false):T{
  const result=structuredClone(raw) as any;
  if(!Array.isArray(result?.fields)||(fieldsOnly?result.materials!==undefined:!Array.isArray(result?.materials)))fail();
  for(const item of result.materials??[])if(aliases.has(item.typeRef))item.typeRef=aliases.get(item.typeRef);
  for(const item of result.fields)if(aliases.has(item.fieldRef))item.fieldRef=aliases.get(item.fieldRef);
  return result as T;
}

export function restoreLegacyDictionaryReferences<T>(raw:T,input:DocumentCloudInput,projection:PrivateIntakeProjection):T{
  return restoreControlReferences(raw,dictionaryReferenceAliases(input,projection));
}
/** Fresh requests keep every redacted byte and source binding intact. Only
 * generated control positions may map to generated ordinals. The model never
 * receives private originals from labels, definitions, evidence or page text.
 */
export function documentDictionaryProtocol(input:DocumentCloudInput,projection:PrivateIntakeProjection,fieldsOnly=false){
  if(input.taxonomy.some((t,i)=>t.ref!==`type_${i+1}`)||
    input.fields.some(f=>!/^field_[1-9]\d*$/u.test(f.ref))||new Set(input.fields.map(f=>f.ref)).size!==input.fields.length||
    input.blocks.filter(b=>b.id==='dictionary').length!==1||projection.blocks.filter(b=>b.id==='dictionary').length!==1||
    projection.sourceManifestHash!==createHash('sha256').update(JSON.stringify(input.blocks)).digest('hex'))fail();
  // The original controls must agree with the independently constructed input.
  assertDocumentDictionaryReferences(input,{...projection,blocks:input.blocks});
  const original=input.blocks.find(b=>b.id==='dictionary')!.text,redacted=projection.blocks.find(b=>b.id==='dictionary')!.text;
  const replacements=new Map(projection.replacements.map(r=>[r.placeholder,r.original]));
  if(replacements.size!==projection.replacements.length)fail();
  try{documentSourceQuotes(original,redacted,replacements);}catch{fail();}
  const properties=dictionaryPropertyAliases(original,redacted,replacements);
  const aliases=dictionaryReferenceAliases(input,projection,properties.metadata);
  if([...aliases].some(([alias,ref])=>!/^\[\[P_[A-Z]+_[a-f0-9]{20}\]\]$/u.test(alias)||!/^(?:type|field)_[1-9]\d*$/u.test(ref)))fail();
  const controls=aliases.size?'\nVerified dictionary control aliases: '+JSON.stringify([...aliases].map(([alias,reference])=>({alias,reference})))+
    '. These aliases apply ONLY to dictionary taxonomy.typeRef, fields.fieldRef and fields.taxonomyRefs. Use the corresponding canonical reference in materials.typeRef and fields.fieldRef. Preserve all placeholders in document quotations, values, contexts and evidence; never apply this map to document text.':'';
  const instructions=controls+(properties.aliases.size?'\nVerified dictionary property aliases: '+JSON.stringify([...properties.aliases].map(([alias,property])=>({alias,property})))+
    '. These aliases apply ONLY to JSON property names inside the reference dictionary. Read those keys as the listed program-owned properties. Return canonical output keys required by the schema. Never apply this map to string values, labels, definitions, quotations, evidence or document source text; preserve their placeholders verbatim.':'');
  return {instructions:fieldsOnly?instructions.replace('materials.typeRef and fields.fieldRef','fields.fieldRef'):instructions,restoreOutput:<T>(raw:T)=>restoreControlReferences(raw,aliases,fieldsOnly)};
}
