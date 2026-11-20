import { z } from 'zod';
import { DOCUMENT_PAGE_LIMIT } from '@hsbc/contracts/document-limits';

const scope={caseId:z.uuid(),revision:z.number().int().positive()};
const file={documentId:z.uuid(),parseRevision:z.uuid()};
const write={expectedRevision:z.number().int().positive(),idempotencyKey:z.string().min(8).max(200),reason:z.string().min(1).max(500)};
export const documentToolSchemas={
  parse_document:z.strictObject({...scope,documentId:z.uuid(),...write}),
  extract_fields:z.strictObject({...scope,...file,...write}),
  search_evidence:z.strictObject({...scope,...file,query:z.string().min(1).max(2000),filter:z.strictObject({logicalDocumentId:z.string().min(1).max(200).optional(),pageNumbers:z.array(z.number().int().positive()).max(DOCUMENT_PAGE_LIMIT).optional()}).optional()}),
  get_evidence:z.strictObject({...scope,...file,pageNumber:z.number().int().positive().optional(),anchorId:z.string().min(1).max(200).optional(),sourceNodeId:z.string().min(1).max(200).optional()}).refine(value=>value.sourceNodeId?value.pageNumber===undefined&&value.anchorId===undefined:value.pageNumber!==undefined&&value.anchorId!==undefined),
  compare_document_versions:z.strictObject({...scope,expectedRevision:z.number().int().positive(),idempotencyKey:z.string().min(8).max(200),beforeDocumentId:z.uuid(),afterDocumentId:z.uuid(),beforeParseRevision:z.uuid(),afterParseRevision:z.uuid()}),
  get_tool_job:z.strictObject({...scope,jobId:z.uuid()}),
};
export type DocumentToolName=keyof typeof documentToolSchemas;
