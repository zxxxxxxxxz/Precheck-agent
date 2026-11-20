import {z} from 'zod';
import {ReviewCommandSchema,ReviewEvidenceSchema,type ReviewEvidence} from './review.js';

/** A reviewer-confirmed value for a field the extraction left empty in one file.
 * The value must appear verbatim in the cited passage; the server re-checks it against the pinned parse. */
export const SupplyFieldValueSchema=ReviewCommandSchema.extend({
  documentId:z.uuid(),fieldId:z.string().min(1).max(200),
  value:z.string().trim().min(1).max(2000),quote:z.string().trim().min(1).max(2000),
  evidence:ReviewEvidenceSchema,
  /** Replace the file's extracted values for this field. Without it only an empty field can be filled. */
  replace:z.boolean().optional(),
});
export type SupplyFieldValue=z.infer<typeof SupplyFieldValueSchema>;
export const WithdrawFieldValueSchema=ReviewCommandSchema.extend({documentId:z.uuid(),fieldId:z.string().min(1).max(200)});
export interface SuppliedFieldValue {
  recordId:string;documentId:string;fieldId:string;value:string;quote:string;evidence:ReviewEvidence;page:number;
  parseRevision:string;directoryRevision:number;replace:boolean;origin:'assistant'|'manual';suppliedAt:string;
}
