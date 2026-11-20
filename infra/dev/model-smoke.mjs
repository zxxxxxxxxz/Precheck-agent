// Run from the repository root: node --env-file=.env.remote infra/dev/model-smoke.mjs
// Synthetic request only; do not print credentials or full model output.
const response = await fetch(`${process.env.QWEN_BASE_URL}/chat/completions`, {
  method: 'POST',
  redirect: 'error',
  signal: AbortSignal.timeout(60_000),
  headers: {
    Authorization: `Bearer ${process.env.QWEN_API_TOKEN}`,
    'Content-Type': 'application/json',
  },
  body: JSON.stringify({
    model: process.env.QWEN_MODEL,
    messages: [{role: 'user', content: 'Reply with exactly: DEV_OK'}],
    chat_template_kwargs: {enable_thinking: false},
    temperature: 0,
    max_tokens: 32,
  }),
});
if (!response.ok) {
  console.log(JSON.stringify({ok: false, status: response.status}));
  process.exitCode = 1;
} else {
  const result = await response.json();
  const ok = result.choices?.[0]?.message?.content?.includes('DEV_OK') === true;
  console.log(JSON.stringify({ok, status: response.status, model: result.model,
    completion_tokens: result.usage?.completion_tokens}));
  if (!ok) process.exitCode = 1;
}
