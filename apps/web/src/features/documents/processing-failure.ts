export function processingFailureText(code?:string,diagnostic?:string){
  if(diagnostic==='azure_rate_limited')return '识别服务限制了请求频率，本次解析未完成。';
  if(diagnostic==='document_dictionary_references')return '字段配置中的编号未通过校验，材料解析已停止。';
  if(diagnostic==='privacy_mask_mapping')return '材料隐私保护校验未完成，解析已停止。';
  const messages:Record<string,string>={
    daily_budget_exhausted:'今日处理额度不足，本次解析未完成。',
    request_budget_exhausted:'本次处理超过单次额度，需要检查处理配置。',
    input_budget_exhausted:'本次待处理内容超过限制，需要检查材料处理配置。',
    call_budget_exhausted:'本次解析已达到调用次数上限，需要检查失败原因。',
    budget_exhausted:'处理额度受限，需要先核对具体限制。',
    rate_limited:'请求频率受限，本轮自动重试已结束。',
    qwen_busy:'材料识别服务繁忙，本轮等待已结束。',
    ocr_busy:'文字识别服务繁忙，本轮等待已结束。',
    invalid_output:'识别结果未通过校验，材料解析未完成。',
    document_processing_failed:'材料处理未完成，需要检查失败原因。',
    execution_unknown:'上次解析未完成，现有处理记录需要核查。',
  };
  return messages[code??'']??'材料解析未完成，请检查失败原因后再处理。';
}
