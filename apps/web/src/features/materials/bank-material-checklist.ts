import type {ReviewState} from '@hsbc/contracts/review';

interface BankMaterialRow {
  id: string;
  label: string;
  englishLabel: string;
  condition: string;
  /** Exact row of the bank workbook's 材料清单 sheet, not a derived review rule. */
  row: number;
}
export interface BankMaterial extends BankMaterialRow {objectRole: string; source: string}
const risk = '参考风控审批结果';
const personalRisk = '参考风控审批结果，若需，此业务类型下必需';
const catalogue: Record<string, {source: string; rows: readonly BankMaterialRow[]}> = {
  corporate_guarantee: {source: 'SRC-CGT', rows: [
    {id: 'cgt_guarantee', englishLabel: 'Guarantee', label: '保证书(公司)', condition: risk, row: 4},
    {id: 'cgt_resolution', englishLabel: 'Director / Shareholder Resolution', label: '公司担保的董事会决议/股东会决议', condition: '需与保证书配套提交', row: 5},
    {id: 'cgt_rm', englishLabel: 'Cross-border guarantees · RM certification', label: '环球客户经理证明', condition: '如为合资格司法管辖区的境外担保，则必需', row: 6},
    {id: 'cgt_legal', englishLabel: 'Legal opinion', label: '法律意见书', condition: '如非合资格司法管辖区的境外担保，则必需', row: 7},
    {id: 'cgt_articles', englishLabel: 'Memorandum / Articles of Association', label: '公司章程', condition: '需与保证书配套提交', row: 8},
    {id: 'cgt_incorporation', englishLabel: 'Certificate of Incorporation', label: '公司注册证明书', condition: '需与保证书配套提交', row: 9},
    {id: 'cgt_annual', englishLabel: 'Annual Return', label: '周年申报表', condition: '非必需', row: 10},
    {id: 'cgt_change', englishLabel: 'Notice of Change', label: '更改公司秘书及董事通知书', condition: '非必需', row: 11},
  ]},
  personal_guarantee: {source: 'SRC-PG', rows: [
    {id: 'pg_guarantee', englishLabel: 'Personal Guarantee', label: '保证书(个人)', condition: personalRisk, row: 4},
    {id: 'pg_note', englishLabel: 'Promissory Note', label: '本票', condition: personalRisk, row: 5},
    {id: 'pg_authorization', englishLabel: 'Authorization to Complete Promissory Notes', label: '授权书', condition: personalRisk, row: 6},
    {id: 'pg_legal', englishLabel: 'Legal opinion', label: '法律意见书', condition: personalRisk, row: 7},
    {id: 'pg_identity', englishLabel: 'Guarantor Identification', label: '担保人身份证明文件（如护照，通行证，身份证等）', condition: personalRisk, row: 8},
  ]},
  // D4:D6 is merged in the workbook: its condition applies to all three rows.
  mortgage: {source: 'SRC-MTG', rows: [
    {id: 'mortgage', englishLabel: 'Real Estate Mortgage Agreement', label: '房地产抵押协议', condition: risk, row: 4},
    {id: 'insurance', englishLabel: 'Insurance', label: '保险', condition: risk, row: 5},
    {id: 'valuation', englishLabel: 'Valuation', label: '评估', condition: risk, row: 6},
  ]},
  account_charge: {source: 'SRC-AR', rows: [
    {id: 'bank_ar_pledge', englishLabel: 'Accounts Receivable Pledge Agreement', label: '应收账款质押协议', condition: risk, row: 4},
  ]},
  sblc: {source: 'SRC-SBLC', rows: [
    {id: 'bank_sblc', englishLabel: 'Standby Letter of Credit', label: '新备用信用证', condition: risk, row: 4},
    {id: 'bank_sblc_amendment', englishLabel: 'Standby Letter of Credit Amendment', label: '备用信用证修改函', condition: risk, row: 5},
  ]},
};

/** Preparation display only. Never filters or changes the bound review manifest. */
export function bankMaterialChecklist(types: readonly string[] = []): BankMaterial[] {
  return [...new Set(types)].flatMap(objectRole => {
    const entry = catalogue[objectRole];
    return entry?.rows.map(row => ({...row, objectRole, source: `${entry.source}/材料清单!C${row.row}:D${row.row}`})) ?? [];
  });
}

interface ReviewChecklistMaterial {
  id: string;
  label: string;
  englishLabel: string;
  condition: string;
  objectRole: string;
  taxonomyId?: string;
  materialIds: string[];
  reference?: boolean;
}

export function reviewBankMaterialChecklist(state: ReviewState): ReviewChecklistMaterial[] {
  if (!state.configuration) return [];
  const types = state.guaranteeTypes ?? state.availableConfigurations.find(item => item.releaseId === state.configurationReleaseId)?.guaranteeTypes
    ?? [...new Set(state.configuration.materials.flatMap(item => item.objectRole ? [item.objectRole] : []))];
  // These comparison sources are outside the bank's dedicated material sheets.
  // Use only explicit configuration mappings, and show a shared taxonomy once.
  const references: ReviewChecklistMaterial[] = [];
  for (const material of state.configuration.materials) {
    if (!['cgt_facility', 'pg_facility', 'shared_facility', 'facility_letter'].includes(material.taxonomyId)) continue;
    const existing = references.find(row => row.taxonomyId === material.taxonomyId);
    if (existing) { existing.materialIds.push(material.id); continue; }
    references.push({id: material.id, label: '授信函', englishLabel: 'Facility Offer Letter',
      condition: '用于跨文件核对', objectRole: 'common',
      taxonomyId: material.taxonomyId, materialIds: [material.id], reference: true});
  }
  return [...references, ...bankMaterialChecklist(types).map(row => {
    // Only an explicit manifest mapping may attach recognition counts to a bank row.
    const material = state.configuration!.materials.find(item => item.id === row.id && (!item.objectRole || item.objectRole === row.objectRole));
    return {...row, taxonomyId: material?.taxonomyId, materialIds: [row.id]};
  })];
}
