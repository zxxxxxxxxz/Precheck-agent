import {processingProblem} from '../documents/processing-attention.ts';
import type {ReviewState} from '@hsbc/contracts/review';
import type {ProcessingStatus} from '../documents/types.ts';
import type {Material} from './types.ts';

export const canStartMaterialProcessing = (material:Material) =>
  ['parked','capability_disabled','failed','canceled','stale'].includes(material.parseStatus);

/** File-list status describes the parse job only, not field quality or review results. */
export function fileParsingLabel(material:Material,processing?:ProcessingStatus,error?:unknown):string {
  if(error)return '解析状态暂不可查询';
  const status=processing?.status??material.parseStatus;
  if(status==='configuration_required')return '待选择审核配置';
  if(status==='capability_disabled')return '待启动解析';
  if(status==='failed')return '解析失败';
  if(['ready','partial','succeeded','completed'].includes(status))return '解析成功';
  if(['pending','queued'].includes(status))return '等待解析';
  if(['running','processing'].includes(status))return '解析中';
  if(status==='canceled')return '解析已取消';
  if(status==='stale')return '待重新解析';
  return '待解析';
}

export function fileProcessingLabel(material:Material,processing?:ProcessingStatus,error?:unknown,parsing?:boolean):string {
  if(error)return '处理状态暂不可查询';
  const status=processing?.status??material.parseStatus,extraction=processing?.presentation?.extraction?.status;
  if(status==='failed')return '文件处理失败';
  if(extraction==='failed')return '字段提取失败';
  if(['pending','queued'].includes(status))return '排队提取';
  if(['running','processing'].includes(status)||['pending','running'].includes(extraction??''))return '正在提取';
  if(status==='configuration_required')return '待选择审核配置';
  const problem=processingProblem(processing??{documentId:material.id,status,history:[],allowed_actions:[],progress:undefined});
  if(problem)return problem;
  if(processing?.presentation?.sourceOnly)return '原文可读 · 待人工核对';
  if(status==='canceled')return '处理已取消';
  if(status==='stale')return '待重新处理';
  if(['ready','partial'].includes(extraction??'')||processing?.presentation?.hasFieldArtifact)return '已处理';
  if(processing?.errorCode==='document_cloud_scope_denied')return '等待识别授权';
  if(processing?.errorCode==='document_cloud_unavailable'||parsing===false)return '识别服务未启用';
  if(processing?.errorCode==='document_cloud_format_unsupported')return '当前配置不支持提取此格式';
  return '待启动提取';
}

/** Unclassified originals remain in the round and must not appear to be missing. */
export function materialIdentification(state:Pick<ReviewState,'materialCount'|'materials'>) {
  const identified=new Set(state.materials.filter(material=>material.operation==='adopt').map(material=>material.documentVersionId)).size;
  const total=state.materialCount??identified;
  return {total,unidentified:Math.max(0,total-identified)};
}
