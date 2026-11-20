import type {DirectoryResponse, FieldsResponse, LogicalDocument} from './types.ts';

export function documentMaterialScope(response:FieldsResponse|undefined,directoryRevision?:string|number,directory?:readonly LogicalDocument[]) {
  const applicability=response?.applicability;
  if(response && (directoryRevision!==undefined && String(directoryRevision)!==String(response.directoryRevision) || applicability && String(applicability.directoryRevision)!==String(response.directoryRevision)))
    return {status:'stale' as const,taxonomyId:null};
  if(applicability?.materialScope)return applicability.materialScope;
  // Older servers still return a union of page classifications. Do not display
  // that union while API and Web are being upgraded together.
  if(directory){
    const entries=directory.filter(entry=>!entry.id.startsWith('source-document:'));
    const ids=[...new Set(entries.flatMap(entry=>entry.labelId?[entry.labelId]:[]))];
    if(ids.length>1)return {status:'ambiguous' as const,taxonomyId:null};
    if(ids.length===1&&entries.every(entry=>entry.labelId&&!['unknown','conflict'].includes(entry.status)))return {status:'resolved' as const,taxonomyId:ids[0]};
    return {status:'unknown' as const,taxonomyId:null};
  }
  return undefined;
}

/** Retain logical IDs, page/region ownership and DOCX evidence when confirming
 * one material type for the entire file. The service owns revision/invalidation. */
export function assignDocumentMaterialType(value:DirectoryResponse,taxonomyId:string):LogicalDocument[] {
  const type=value.taxonomy.find(entry=>entry.id===taxonomyId);
  if(!type||!value.directory.length)throw new Error('请选择当前文件的材料类型');
  return value.directory.map(entry=>({...entry,labelId:type.id,label:type.label,status:'confirmed',source:'manual'}));
}
