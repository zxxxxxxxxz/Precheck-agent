import type {StatusView} from '../../status.ts';
import type {ProcessingStatus} from './types.ts';

/** Reader toolbar progress only; detailed diagnostics stay with the processing record. */
export function readerProcessingStatus(processing: Pick<ProcessingStatus, 'status' | 'presentation'>, error?: unknown): StatusView {
  if (error) return {label: '状态获取失败', tone: 'error'};
  const {status, presentation} = processing;
  const extraction = presentation?.extraction?.status;
  if (status === 'configuration_required') return {label: '待选择审核配置', tone: 'plain'};
  if (status === 'capability_disabled') return {label: '待启动解析', tone: 'plain'};
  if (status === 'failed') return {label: '提取失败', tone: 'error'};
  if (['pending', 'queued'].includes(status)) return {label: '排队中', tone: 'plain'};
  if (['running', 'processing'].includes(status)) return {label: '提取中', tone: 'plain'};
  if (['canceled', 'stale'].includes(status)) return {label: '待提取', tone: 'plain'};
  if (extraction === 'failed') return {label: '提取失败', tone: 'error'};
  if (['pending', 'queued'].includes(extraction ?? '')) return {label: '排队中', tone: 'plain'};
  if (['running', 'processing'].includes(extraction ?? '')) return {label: '提取中', tone: 'plain'};
  if (presentation?.sourceOnly || ['canceled', 'stale'].includes(extraction ?? '')) return {label: '待提取', tone: 'plain'};
  const completed = (value?: string) => ['ready', 'partial', 'succeeded', 'completed'].includes(value ?? '');
  if (completed(extraction) || (completed(status) && (!presentation || presentation.hasFieldArtifact))) return {label: '已提取', tone: 'plain'};
  return {label: '待提取', tone: 'plain'};
}

/** Both parsing and follow-up extraction hold the same material processing slot. */
export function documentProcessingActive(p?:Pick<ProcessingStatus,'status'|'presentation'>){
  return [p?.status,p?.presentation?.extraction?.status].some(value=>['pending','queued','running','processing'].includes(value??''));
}
export function documentParseAction(p?:Pick<ProcessingStatus,'status'|'parseRevision'|'presentation'>){
  if(documentProcessingActive(p))return '正在解析';
  if(p?.status==='failed')return '重试解析';
  return p?.parseRevision?'重新解析':'解析材料';
}
