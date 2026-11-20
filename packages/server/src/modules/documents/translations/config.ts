import { hostedQwenOptions, supportedQwenModel } from '../../../infrastructure/integrations/qwen-hosting.js';
import type { ServiceConfig } from '../../../infrastructure/integrations/http.js';

export interface TranslationConfig { service: ServiceConfig; model: string; modelRevision: string }
/** Hosted replacement requires an explicit, expiring original-data approval. No automatic fallback. */
export function loadTranslationConfig(env: NodeJS.ProcessEnv): TranslationConfig | undefined {
  const flag = env.P3_DOCUMENT_TRANSLATION_ENABLED;
  if (flag === undefined || flag === 'false') return undefined;
  if (flag !== 'true') throw new Error('document_translation_flag_invalid');
  const baseUrl = env.P1_QWEN_BASE_URL, token = env.P1_QWEN_TOKEN, model = env.P1_QWEN_MODEL;
  const modelRevision = env.P3_DOCUMENT_TRANSLATION_MODEL_REVISION;
  if (!baseUrl || !token || !model || !supportedQwenModel(env) || !modelRevision || !/^[a-f0-9]{40,64}$/.test(modelRevision))
    throw new Error('document_translation_configuration_required');
  return { service: { ...hostedQwenOptions(env), baseUrl, token, timeoutMs: 90_000, allowHttp: env.P1_QWEN_ALLOW_HTTP === 'true' }, model, modelRevision };
}
