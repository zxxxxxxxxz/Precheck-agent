import {processingProblem} from './processing-attention.ts';
import type {ProcessingStatus} from './types.ts';
import type {SourceDocumentResponse} from '../../sourceDocument.ts';
const active=(status?:string)=>['pending','queued','running','processing'].includes(status??'');
export function extractionDeferredReason(code?:string|null) {
  if(code==='document_cloud_scope_denied')return '此材料尚未获准自动提取，请联系管理员核对处理授权';
  if(code==='document_cloud_unavailable')return '自动提取服务尚未启用，请联系管理员';
  if(code==='document_cloud_format_unsupported')return '当前审核配置不支持 Word 自动提取，请选择支持 Word 的已发布配置';
  return null;
}
export function docxReadingNotice(p?:ProcessingStatus) {
  if(!p?.presentation?.sourceOnly)return null;
  if(active(p.status))return '正在读取 Word 原件并准备预览，自动字段提取尚未开始。';
  if(!p.presentation.sourceAvailable||['failed','canceled','stale'].includes(p.status))return null;
  const extraction=p.presentation.extraction;
  if(['pending','queued'].includes(extraction?.status??''))return 'Word 原文已可阅读，等待提取字段。';
  if(active(extraction?.status))return 'Word 原文已可阅读，正在提取字段。';
  if(extraction?.status==='failed')return extraction.errorCode==='execution_unknown'
    ?'Word 原文已可阅读，未能确认字段提取结果。请联系管理员核查处理记录。'
    :'Word 原文已可阅读，字段提取失败。请查看处理记录后重试。';
  if(extraction?.errorCode==='document_cloud_scope_denied')return 'Word 原文已可阅读，自动提取未启动：缺少处理授权。请联系管理员核对处理授权，授权后可点击“重新解析”。';
  const reason=extractionDeferredReason(extraction?.errorCode);
  return reason?`Word 原文已可阅读。${reason}；处理条件满足后可点击“重新解析”。`:'Word 原文已可阅读，当前识别记录尚无自动提取结果。请按原文核对字段。';
}
export function previewReason(preview:SourceDocumentResponse['preview'],processing=false) {
  if(preview&&['ready','partial','succeeded'].includes(preview.status)&&preview.pageCount)return preview.status==='partial'?'页面预览部分可用':'页面预览可用';
  if(active(preview?.status)||processing&&!preview)return '页面预览仍在处理';
  if(preview?.errorCode==='docx_preview_disabled'||preview?.coverageGaps?.includes('docx_preview_disabled'))return '当前环境未启用 Word 页面预览';
  if(preview?.errorCode==='docx_runtime_unconfigured'||preview?.coverageGaps?.includes('docx_runtime_unconfigured'))return '页面转换服务尚未配置';
  if(preview?.status==='failed')return '页面转换失败';
  if(!preview)return '此解析记录没有页面预览';
  return '页面预览不可用，原因记录不足';
}
export function processingView(format:string|undefined|null,p?:ProcessingStatus) {
  if(!p)return {read:'读取状态待查询',preview:'预览状态待查询',extraction:'提取状态待查询'};
  if(p.status==='capability_disabled'&&['document_cloud_scope_denied','document_cloud_unavailable','document_cloud_format_unsupported'].includes(p.errorCode??''))return {
    read:'原件已保存 · 自动处理未开始',preview:'页面预览尚未生成',
    extraction:p.errorCode==='document_cloud_scope_denied'?'等待识别授权 · 请联系管理员':p.errorCode==='document_cloud_unavailable'?'识别服务未启用 · 请联系管理员':'当前配置暂不支持此格式的自动提取',
  };
  const meta=p.presentation,working=active(p.status);
  const read=format==='docx'?(meta?.sourceAvailable?'Word 文字结构可读':working?'正在读取文字结构':p.status==='failed'?'文字读取未完成':meta?'文字结构尚未就绪':'历史服务未提供读取记录'):
    p.progress?.completedPages?'已生成原件页面':working?'正在读取原件':p.status==='failed'?'原件处理失败':'尚未生成原件页面';
  const preview=format==='docx'?meta?previewReason(meta.preview?{...meta.preview,id:null,manifest:null,coverageGaps:[]}:null,working):'预览记录待查询':p.progress?.completedPages?'原件页面可查看':'原件页面尚未就绪';
  const state=meta?.extraction?.status;
  const extraction=state==='failed'?'字段提取失败':active(state)?'字段提取中':meta?.sourceOnly?extractionDeferredReason(meta.extraction?.errorCode)??'此识别记录只读取文字结构 · 未执行自动提取':processingProblem(p)?processingProblem(p)!:['ready','partial'].includes(state??'')?'字段处理完成':p.status==='failed'?'提取未完成 · 原件处理失败':working?'字段提取等待原文处理':meta?.hasFieldArtifact?'已有字段记录':meta?'字段提取未开始':'提取记录待查询';
  return {read,preview,extraction};
}
