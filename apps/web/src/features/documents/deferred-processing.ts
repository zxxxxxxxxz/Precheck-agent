/** Original-file registration succeeded; automatic extraction awaits a prerequisite. */
export function deferredProcessingMessage(errorCode?: string) {
  const labels: Record<string, string> = {
    document_cloud_scope_denied: '原件已保存，自动识别等待授权，请在材料与版本查看处理授权。',
    document_cloud_unavailable: '原件已保存，识别服务尚未启用，请联系管理员。',
    document_cloud_format_unsupported: '原件已保存，当前格式暂不支持自动识别。',
  };
  return errorCode ? labels[errorCode] : undefined;
}
