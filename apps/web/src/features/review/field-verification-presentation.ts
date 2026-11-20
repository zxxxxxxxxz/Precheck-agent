import type {FieldVerification} from '@hsbc/contracts/field-verification';
/** Original excerpts only. A corrected extraction is audit history, not a second file. */
export function verificationOriginals(record:Pick<FieldVerification,'sources'>):FieldVerification['sources'] {
 const originals=new Map<string,FieldVerification['sources'][number]>();
 for(const source of record.sources){
  if(source.kind!=='original')continue;
  const e=source.evidence,key=JSON.stringify([e.documentVersionId,e.parseRevision,e.directoryRevision,source.page,source.quote]);
  const previous=originals.get(key);
  originals.set(key,previous?{...previous,comparisonKey:previous.comparisonKey===null?source.comparisonKey:previous.comparisonKey,highlights:[...new Set([...previous.highlights,...source.highlights])]}:source);
 }
 return [...originals.values()];
}

export function verificationComparison(record:Pick<FieldVerification,'sources'|'scope'>) {
 const originals=verificationOriginals(record),primary=originals.filter(s=>s.comparisonKey!==null);
 const sources=primary.length?primary:originals,documents=new Set(sources.map(s=>s.evidence.documentVersionId)).size;
 return {sources,crossFile:record.scope==='cross_file'||documents>1,missingCounterpart:record.scope==='cross_file'&&documents<2};
}
