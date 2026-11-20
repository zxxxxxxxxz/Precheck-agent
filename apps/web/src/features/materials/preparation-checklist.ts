import type {MaterialPreparationItem, ReviewState} from '@hsbc/contracts/review';
import {reviewBankMaterialChecklist} from './bank-material-checklist.ts';
import type {Material} from './types.ts';

export function preparationChecklist(state:ReviewState) {
  const rows = reviewBankMaterialChecklist(state).map(material => {
    const entries = state.materialPreparation?.filter(item => material.materialIds.includes(item.materialId)) ?? [];
    // Receipt is per bank checklist row, independent of business-object coverage.
    // The authorized round projection already excludes removed/other-round files.
    const documentVersionIds = [...new Set((state.materials ?? []).filter(file =>
      !!material.taxonomyId && file.operation === 'adopt' && file.documentTypeId === material.taxonomyId,
    ).map(file => file.documentVersionId))];
    const unresolved = !entries.length || entries.some(entry => entry.requirement === 'unknown');
    const required = entries.some(entry => entry.requirement === 'required');
    const notApplicable = entries.length > 0 && entries.every(entry => entry.requirement === 'not_applicable');
    const status:MaterialPreparationItem['status'] = notApplicable ? 'not_applicable'
      : documentVersionIds.length ? 'provided' : unresolved ? 'pending' : required ? 'missing' : 'optional';
    return {...material, entries, documentVersionIds, unresolved, required, status};
  });
  const required = rows.filter(row => row.required);
  return {rows, required:required.length, provided:required.filter(entry => entry.status === 'provided').length,
    unresolved:rows.filter(row => row.unresolved).length,
    available:state.materialPreparation !== undefined};
}

export function preparationRowStatus(row: ReturnType<typeof preparationChecklist>['rows'][number], round?:number|null, materials:Material[]=[], unidentified=0) {
  if (unidentified>0&&!row.documentVersionIds.length&&row.status!=='not_applicable'&&(row.reference||row.status==='missing'))return '待识别文件核实';
  if (row.reference && !row.documentVersionIds.length && row.status !== 'not_applicable') {
    return '待补';
  }
  return row.status === 'pending' ? '适用条件待确认' : preparationStatus(row, round, materials);
}

export function preparationSummary(summary:ReturnType<typeof preparationChecklist>) {
  if(summary.unresolved)return '必需范围待确认';
  return summary.required ? `${summary.provided} / ${summary.required} 份本轮必需材料已上传` : '本轮无必需材料';
}

export function preparationStatus(entry:Pick<MaterialPreparationItem,'status'|'documentVersionIds'>, round?:number|null,materials:Material[]=[]) {
  const rounds=[...new Set(entry.documentVersionIds.map(id=>materials.find(file=>file.id===id)?.uploadedRoundNumber??round).filter((value):value is number=>!!value))].sort((a,b)=>a-b);
  return {provided:rounds.length ? `第 ${rounds.join('、')} 轮已上传` : round?`第 ${round} 轮已上传`:'已上传', missing:'待补', pending:'待确认',
    optional:'非必需', not_applicable:'本路径不适用'}[entry.status];
}
