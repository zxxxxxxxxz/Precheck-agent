/** Compare only model configuration; never print values, hashes, paths or parse errors. */
import { readFileSync } from 'node:fs';
import { parseEnv } from 'node:util';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const cloudNames = [
  'P3_EGRESS_POLICY_JSON','AZURE_OPENAI_ENDPOINT','AZURE_OPENAI_DEPLOYMENT','AZURE_OPENAI_API_KEY',
  'P3_MODEL_TIMEOUT_MS','P3_MODEL_MAX_INPUT_TOKENS','P3_MODEL_MAX_OUTPUT_TOKENS','P3_MODEL_REQUESTS_PER_MINUTE',
  'P3_MODEL_DAILY_BUDGET_MICROS','P3_MODEL_CALL_BUDGET_MICROS','P3_MODEL_INPUT_MICROS_PER_MILLION','P3_MODEL_OUTPUT_MICROS_PER_MILLION',
  'P1_NER_BASE_URL','P1_NER_TOKEN','P1_NER_ALLOW_HTTP',
];
const localNames = [
  'P3_LOCAL_INTAKE_TIMEOUT_MS','P3_LOCAL_INTAKE_MAX_INPUT_TOKENS',
  'P3_LOCAL_INTAKE_MAX_OUTPUT_TOKENS','P3_LOCAL_INTAKE_REQUESTS_PER_MINUTE','P3_LOCAL_INTAKE_DAILY_BUDGET_MICROS',
  'P3_LOCAL_INTAKE_CALL_BUDGET_MICROS','P3_LOCAL_INTAKE_INPUT_MICROS_PER_MILLION','P3_LOCAL_INTAKE_OUTPUT_MICROS_PER_MILLION',
  'P1_QWEN_BASE_URL','P1_QWEN_MODEL','P1_QWEN_TOKEN','P1_QWEN_ALLOW_HTTP','P1_QWEN_PROVIDER','P1_QWEN_HOSTED_POLICY_JSON',
];
function projection(contents) {
  const env = parseEnv(contents);
  env.P3_CLOUD_MODE ??= 'off';env.P3_LOCAL_INTAKE_ENABLED ??= 'false';env.P3_LOCAL_INTAKE_VALIDATED ??= 'false';env.P2_FIELD_FILTER_ENABLED ??= 'false';
  env.P3_REVIEW_CONFIG_ENABLED ??= 'false';env.P3_REVIEW_ENABLED ??= 'false';
  env.P3_FORMAL_REVIEW_ENABLED ??= 'false';
  env.P3_DOCUMENT_CLOUD_ENABLED ??= 'false';env.P3_SIGNATURE_VISION_ENABLED ??= 'false';
  env.P3_DOCUMENT_NER_SOURCE_SPANS_ENABLED ??= 'false';
  env.P3_DOCUMENT_CASE_AUTHORIZATION_ENABLED ??= 'false';
  env.P3_DOCUMENT_POLICY_REUSE_ENABLED ??= 'false';
  env.P4_COMPANY_LOOKUP_ENABLED ??= 'false';
  env.P4_CASE_ASSISTANT_ENABLED ??= 'false';
  env.P4_SUBJECT_CONFIRMATION_ENABLED ??= 'false';
  env.P4_DOCUMENT_REGION_OCR_ENABLED ??= 'false';
  env.AZURE_OPENAI_API_KEY ??= env.P3_AZURE_API_KEY;
  // P2 may intentionally use different inference settings on API and Worker.
  // A disabled P3 channel neither consumes nor constrains those settings.
  const flags=['P1_QWEN_PROVIDER','P1_QWEN_HOSTED_POLICY_JSON','P3_DOCUMENT_TRANSLATION_ENABLED','P3_DOCUMENT_TRANSLATION_MODEL_REVISION','P3_REVIEW_ASSIST_ENABLED','P3_REVIEW_ASSIST_MODEL_REVISION','P3_DOCUMENT_POLICY_REUSE_ENABLED','P3_DOCUMENT_CASE_AUTHORIZATION_ENABLED','P3_CLOUD_MODE','P3_LOCAL_INTAKE_ENABLED','P3_LOCAL_INTAKE_VALIDATED','P2_FIELD_FILTER_ENABLED','P3_REVIEW_CONFIG_ENABLED','P3_REVIEW_ENABLED','P3_FORMAL_REVIEW_ENABLED','P3_DOCUMENT_CLOUD_ENABLED','P3_DOCUMENT_NER_SOURCE_SPANS_ENABLED','P3_SIGNATURE_VISION_ENABLED','P4_COMPANY_LOOKUP_ENABLED','P4_CASE_ASSISTANT_ENABLED','P4_SUBJECT_CONFIRMATION_ENABLED','P4_DOCUMENT_REGION_OCR_ENABLED'];
  const assistant=env.P3_CLOUD_MODE==='public_synthetic';
  const capacityNames=['P3_ASSISTANT_MAX_SOURCE_BYTES','P3_ASSISTANT_MAX_PRIVACY_CALLS'];
  if(assistant){env.P3_ASSISTANT_MAX_SOURCE_BYTES??='120000';env.P3_ASSISTANT_MAX_PRIVACY_CALLS??='64';}
  const activeCloud=cloudNames.map(name=>assistant?name.replace(/^P3_MODEL_/,'P3_ASSISTANT_CLOUD_'):name);
  const activeLocal=localNames.map(name=>assistant?name.replace(/^P3_LOCAL_INTAKE_/,'P3_ASSISTANT_LOCAL_'):name);
  const names=[...flags,...(assistant?capacityNames:[]),...(env.P3_CLOUD_MODE!=='off'?activeCloud:[]),...(env.P3_LOCAL_INTAKE_ENABLED==='true'?activeLocal:[]),
    ...(env.P3_FORMAL_REVIEW_ENABLED==='true'?['P3_FORMAL_REVIEW_CONFIG_JSON','P3_FORMAL_REVIEW_TOKEN','P3_FORMAL_REVIEW_NER_TOKEN']:[]),
    ...(env.P4_COMPANY_LOOKUP_ENABLED==='true'?['P4_COMPANY_LOOKUP_POLICY_JSON']:[]),
    ...(env.P4_CASE_ASSISTANT_ENABLED==='true'?['P4_CASE_ASSISTANT_CONFIG_JSON','P4_CASE_ASSISTANT_TOKEN','P4_CASE_ASSISTANT_NER_TOKEN']:[]),
    ...(env.P4_DOCUMENT_REGION_OCR_ENABLED==='true'?['P1_OCR_BASE_URL','P1_OCR_TOKEN','P1_OCR_ALLOW_HTTP']:[]),
    ...(env.P3_SIGNATURE_VISION_ENABLED==='true'?['P3_SIGNATURE_VISION_MODEL_REVISION','P3_SIGNATURE_VISION_CASE_IDS','P3_SIGNATURE_VISION_DOCUMENT_IDS','P1_QWEN_BASE_URL','P1_QWEN_MODEL','P1_QWEN_TOKEN','P1_QWEN_ALLOW_HTTP']:[]),
    ...(env.P3_DOCUMENT_CLOUD_ENABLED==='true'?['P3_DOCUMENT_EGRESS_POLICY_JSON','P3_DOCUMENT_CLOUD_MAX_OUTPUT_TOKENS','P3_DOCUMENT_CLOUD_TIMEOUT_MS','P3_DOCUMENT_CLOUD_V2_REASONING_EFFORT','P3_DOCUMENT_CLOUD_V2_MAX_OUTPUT_TOKENS','P3_DOCUMENT_CLOUD_PRICING_JSON']:[]),
    ...(env.P2_FIELD_FILTER_ENABLED==='true'?['P1_QWEN_BASE_URL','P1_QWEN_MODEL','P1_QWEN_TOKEN','P1_QWEN_ALLOW_HTTP']:[]),
    ...(env.P3_REVIEW_CONFIG_ENABLED==='true'?['P3_OPA_BASE_URL','P3_OPA_TOKEN','P3_OPA_ALLOW_HTTP','P3_OPA_BINARY']:[])];
  return names.map(name => [name,env[name] ?? null]);
}
export function verifyModelEnvironmentParity(apiFile, workerFile) {
  try {
    if (JSON.stringify(projection(readFileSync(apiFile,'utf8'))) !== JSON.stringify(projection(readFileSync(workerFile,'utf8')))) throw new Error();
  } catch { throw new Error('p3_runtime_model_configuration_mismatch'); }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    if (process.argv.length !== 4) throw new Error();
    verifyModelEnvironmentParity(process.argv[2],process.argv[3]);
    process.stdout.write('p3_runtime_model_configuration_matches\n');
  } catch { process.stderr.write('p3_runtime_model_configuration_mismatch\n');process.exitCode=1; }
}
