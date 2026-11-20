/** Public diagnostic codes emitted by the isolated page engine. Never expose a
 * raw exception message or accept a prefix match as evidence that it is safe. */
export const DOCUMENT_ENGINE_ERROR_CODES = [
  'p2_document_hash_mismatch',
  'p2_page_out_of_range',
  'p2_page_pixel_budget_exceeded',
  'p2_page_content_budget_exceeded',
  'p2_page_processing_failed',
  'p2_page_worker_entry_missing',
  'p2_page_worker_timeout_invalid',
  'p2_page_worker_boot_failed',
  'p2_page_worker_canceled',
  'p2_page_worker_timeout',
  'p2_page_worker_invalid_result',
  'p2_page_worker_failed',
  'p2_page_worker_exited',
] as const;

export type DocumentEngineErrorCode = typeof DOCUMENT_ENGINE_ERROR_CODES[number];
const safeCodes: ReadonlySet<string> = new Set(DOCUMENT_ENGINE_ERROR_CODES);

/** Extraction changes diagnostics only; it does not classify an error as retryable. */
export function safeDocumentEngineErrorCode(error: unknown): DocumentEngineErrorCode | undefined {
  return error instanceof Error && safeCodes.has(error.message)
    ? error.message as DocumentEngineErrorCode
    : undefined;
}
