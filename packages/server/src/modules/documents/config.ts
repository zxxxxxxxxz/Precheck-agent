import { hostedQwenOptions, supportedQwenModel } from '../../infrastructure/integrations/qwen-hosting.js';
import type { ServiceConfig } from '../../infrastructure/integrations/http.js';
import { DOCUMENT_PAGE_LIMIT } from '@hsbc/contracts/document-limits';
import { loadDocumentCloudConfig, type DocumentCloudConfig } from './cloud-extraction-config.js';
import { loadTranslationConfig, type TranslationConfig } from './translations/config.js';

export interface DocumentRuntimeConfig {
  /** Formal entrypoints always require a published review release. Only isolated P2 fixtures opt out. */
  requireReviewConfiguration?: boolean;
  enabled: boolean;
  automatic: boolean;
  reader: boolean;
  directory: boolean;
  search: boolean;
  comparison: boolean;
  maxPages: number;
  maxPageBytes: number;
  leaseSeconds: number;
  docx?: boolean;
  docxPreview?: boolean;
  mockValidation?: boolean;
  ocr?: ServiceConfig;
  ner?: ServiceConfig;
  fieldFilter?: { service: ServiceConfig; model: string };
  cloudExtraction?: DocumentCloudConfig;
  translation?: TranslationConfig;
  /** Bounded private crop OCR; applies only to newly requested explicit v2 parses. */
  regionOcr?: boolean;
  signatureVision?: {service:ServiceConfig;model:string;modelRevision:string;caseIds:string[];documentIds:string[]};
  mcp?: { publicKey: string; issuer: string; audience: string };
}

/** Flags are explicit and fail closed. No remote environment is loaded here. */
export function loadDocumentRuntimeConfig(env: NodeJS.ProcessEnv = process.env): DocumentRuntimeConfig {
  const flag = (name: string) => {
    if (env[name] !== undefined && !['true', 'false'].includes(env[name]!)) throw new Error(`invalid_flag:${name}`);
    return env[name] === 'true';
  };
  const service = (name: string, timeoutMs: number): ServiceConfig | undefined => {
    const baseUrl = env[`P1_${name}_BASE_URL`], token = env[`P1_${name}_TOKEN`];
    if (!baseUrl && !token) return undefined;
    if (!baseUrl || !token) throw new Error(`incomplete_service:${name}`);
    return { ...(name==='QWEN'?hostedQwenOptions(env):{}), baseUrl, token, timeoutMs, allowHttp: env[`P1_${name}_ALLOW_HTTP`] === 'true' };
  };
  const enabled = flag('P2_DOCUMENT_ENABLED');
  const docx=flag('P2_DOCX_ENABLED'),docxPreview=flag('P2_DOCX_PREVIEW_ENABLED'),mockValidation=flag('P2_MOCK_VALIDATION_ENABLED');
  if(docxPreview&&!docx)throw new Error('docx_preview_dependency_required');
  const automatic = env.P2_AUTOMATIC_PREPARSE === undefined || flag('P2_AUTOMATIC_PREPARSE');
  const capability = (name:string) => env[name] === undefined ? enabled : flag(name);
  const reader=capability('P2_READER_ENABLED'),directory=capability('P2_DIRECTORY_ENABLED'),search=capability('P2_SEARCH_ENABLED'),comparison=capability('P2_COMPARISON_ENABLED');
  if((directory||search||comparison)&&!reader)throw new Error('p2_reader_dependency_required');
  const mcpEnabled = flag('P2_MCP_ENABLED');
  const filterEnabled=flag('P2_FIELD_FILTER_ENABLED');
  const filterService=filterEnabled?service('QWEN',120_000):undefined;
  const cloudExtraction=loadDocumentCloudConfig(env);
  const translation=loadTranslationConfig(env);
  if(translation&&(!enabled||!reader))throw new Error('document_translation_dependencies_required');
  const regionOcr=flag('P4_DOCUMENT_REGION_OCR_ENABLED'),ocr=service('OCR',180_000);
  if(cloudExtraction&&(!enabled||!reader))throw new Error('document_cloud_dependencies_required');
  if(regionOcr&&(!enabled||!reader||!cloudExtraction||!ocr))throw new Error('document_region_ocr_dependencies_required');
  if(filterEnabled&&(!enabled||!reader||!filterService||!supportedQwenModel(env)))throw new Error('p2_field_filter_configuration_required');
  if (mcpEnabled && (!(enabled||reader) || !env.P2_MCP_PUBLIC_KEY || !env.P2_MCP_ISSUER || !env.P2_MCP_AUDIENCE)) throw new Error('p2_mcp_configuration_required');
  const visionEnabled=flag('P3_SIGNATURE_VISION_ENABLED');
  let signatureVision:DocumentRuntimeConfig['signatureVision'];
  if(visionEnabled){
    const configured=service('QWEN',180_000),model=env.P1_QWEN_MODEL,modelRevision=env.P3_SIGNATURE_VISION_MODEL_REVISION;
    const ids=(name:string)=>{const raw=env[name]?.split(',').map(v=>v.trim()).filter(Boolean)??[];if(!raw.length||raw.some(v=>!/^\w{8}-\w{4}-\w{4}-\w{4}-\w{12}$/.test(v)))throw new Error('signature_vision_scope_required');return [...new Set(raw)];};
    if(!enabled||!reader||!configured||model!=='Qwen/Qwen3.5-9B'||!modelRevision||!/^[a-f0-9]{40,64}$/.test(modelRevision))throw new Error('signature_vision_configuration_required');
    signatureVision={service:configured,model,modelRevision,caseIds:ids('P3_SIGNATURE_VISION_CASE_IDS'),documentIds:ids('P3_SIGNATURE_VISION_DOCUMENT_IDS')};
  }
  return {
    requireReviewConfiguration: true,
    enabled, automatic: enabled && automatic,reader,directory,search,comparison,
    maxPages: DOCUMENT_PAGE_LIMIT, maxPageBytes: 20 * 1024 * 1024, leaseSeconds: 300,
    docx,docxPreview,mockValidation,...(signatureVision?{signatureVision}:{}),
    ocr, regionOcr, ner: service('NER', 60_000),
    ...(filterEnabled?{fieldFilter:{service:filterService!,model:env.P1_QWEN_MODEL!}}:{}),
    ...(cloudExtraction?{cloudExtraction}:{}),
    ...(translation?{translation}:{}),
    ...(mcpEnabled ? { mcp: { publicKey: env.P2_MCP_PUBLIC_KEY!, issuer: env.P2_MCP_ISSUER!, audience: env.P2_MCP_AUDIENCE! } } : {}),
  };
}
