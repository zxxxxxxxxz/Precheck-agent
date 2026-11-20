/** Quick actions edit the shared composer; only submitting it sends a request. */
export const promptDrafts: Record<string, {text: string; mode: 'chat' | 'legal_opinion'}> = {
  file: {text: '这份文件写了什么？指出与已提取字段不一致的地方', mode: 'chat'},
  explain: {text: '解释当前选中字段的结论和依据', mode: 'chat'},
  wrong: {text: '这项判断不对：', mode: 'chat'},
  summary: {text: '总结本轮结果：有差异、待确认和已采用的口径', mode: 'chat'},
  legal: {text: '整理法律意见书的假设、生效前提和底线问题', mode: 'legal_opinion'},
  rules: {text: '整理本次对话形成的口径', mode: 'chat'},
};
