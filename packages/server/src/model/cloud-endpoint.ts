/** Cloud model egress uses the OpenAI Responses protocol at one exact HTTPS endpoint pinned by the
 * reviewed egress policy. Any OpenAI-compatible service qualifies; the policy, not a host list, decides. */
const AZURE_OPENAI_HOST = /\.(?:openai\.azure\.com|cognitiveservices\.azure\.com)$/u;

export function isResponsesEndpoint(value: string): boolean {
  let url: URL;
  try { url = new URL(value); } catch { return false; }
  return url.protocol === 'https:' && !url.username && !url.password && !url.search && !url.hash && url.pathname.endsWith('/responses');
}

/** Azure OpenAI keeps its api-key header; other OpenAI-compatible services receive the standard Bearer token. */
export function cloudAuthorizationHeader(endpoint: string, token: string): Record<string, string> {
  return AZURE_OPENAI_HOST.test(new URL(endpoint).hostname) ? {'api-key': token} : {Authorization: `Bearer ${token}`};
}
