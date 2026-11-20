import type {ProcessingStatus} from './types.ts';
import {processingFailureText} from './processing-failure.ts';

const blocked:Record<string,string>={
  execution_unknown:'上次识别请求的结果尚未确认，请联系管理员核查后再处理。',
  fresh_parse_required:'请点击上方“重试解析”创建新的识别记录。',
  document_dictionary_references:'请联系管理员修正字段配置或处理服务后，再点击上方“重试解析”。',
  recovery_owner_changed:'请联系原经办人员核查，或在有权限时重新解析。',
  stale_parse_revision:'案件或识别记录已变化，请刷新页面后使用当前版本重新解析。',
  document_cloud_scope_denied:'原处理授权已失效，请联系管理员确认授权后重新解析。',
  recovery_attempts_exhausted:'请联系管理员排查失败原因后再处理。',
};

export function recoveryPresentation(status:ProcessingStatus){
  // Older APIs may still advertise recovery for a deterministically blocked job.
  const reason=(!status.recovery?.available?status.recovery?.reason:undefined)??
    (status.errorCode==='execution_unknown'?'execution_unknown':
      status.errorDiagnostic==='document_dictionary_references'?'document_dictionary_references':undefined);
  return {
    title:reason==='execution_unknown'?'本次解析需要核查':reason==='fresh_parse_required'&&status.errorCode==='execution_unknown'?'原识别记录无法继续使用':processingFailureText(status.errorCode,status.errorDiagnostic),
    description:reason&&blocked[reason]|| (status.allowed_actions.includes('document:parse')?'请确认失败原因后，点击上方“重试解析”创建新的识别记录。':'请联系经办人员或管理员核查失败原因后再处理。'),
  };
}
