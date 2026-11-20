import type {ReviewMaterial, ReviewState} from '@hsbc/contracts/review';

export const materialKey = (material: Pick<ReviewMaterial, 'documentVersionId' | 'logicalDocumentId'>) => JSON.stringify([material.documentVersionId, material.logicalDocumentId]);
export const materialScope=(material:ReviewMaterial)=>({logicalDocumentId:material.logicalDocumentId});
export const materialTarget = (material: ReviewMaterial) => ({logicalDocumentId: material.logicalDocumentId, caseRevision: material.caseRevision});
export const materialDetail = (state: ReviewState, material: ReviewMaterial) => state.materialDetails?.find(detail => materialKey(detail) === materialKey(material) && detail.caseRevision === material.caseRevision);
export function materialRange(state: ReviewState, material: ReviewMaterial): string {
  if (!material.logicalDocumentId) return '整份文件';
  const detail = materialDetail(state, material);
  const peers = state.materials.filter(value => value.documentVersionId === material.documentVersionId && value.logicalDocumentId).sort((a,b) => a.logicalDocumentId!.localeCompare(b.logicalDocumentId!));
  const sourceIndex=state.materialSources?.find(source=>source.documentVersionId===material.documentVersionId)?.scopes.findIndex(scope=>scope.id===material.logicalDocumentId);
  const index=sourceIndex!==undefined&&sourceIndex>=0?sourceIndex+1:peers.findIndex(value=>value.logicalDocumentId===material.logicalDocumentId)+1;
  return `文书范围 ${index}${detail?.pageNumbers.length ? ` · 第 ${detail.pageNumbers.join('、')} 页` : detail?.sourceNodeIds?.length ? ' · 原文结构' : ' · 页码待核对'}`;
}
export function materialLabel(state: ReviewState, material: ReviewMaterial, filename?:string): string {
  return `${filename ?? state.materialSources?.find(value=>value.documentVersionId===material.documentVersionId)?.filename ?? `文件 ${material.documentVersionId.slice(0,8)}`} · ${state.configuration?.taxonomy.find(type => type.id === material.documentTypeId)?.label ?? material.documentTypeId} · ${materialRange(state,material)}`;
}
export const materialUpdateLabels = {current:'已核对当前结果', available:'新提取结果待核对', processing:'新结果尚未就绪', scope_missing:'原文书范围已变化，请更正范围'};
export function adoptedFileCount(materials: ReviewMaterial[]): number {return new Set(materials.filter(material => material.operation === 'adopt').map(material => material.documentVersionId)).size;}
export function fileAdoptionOperation(materials: ReviewMaterial[]): ReviewMaterial['operation'] | undefined {
  return materials.some(material => material.operation === 'adopt') ? 'adopt' : materials.some(material => material.operation === 'reject') ? 'reject' : materials.length ? 'superseded' : undefined;
}
