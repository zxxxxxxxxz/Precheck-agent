import {z} from 'zod';
import type {AnalysisEvidence} from './review-delivery.js';

/** A document category, never a published rule or a required material. */
export const SUPPLEMENTAL_MATERIAL_ID='case_supplemental';
export const SUPPLEMENTAL_MATERIAL_LABEL='其他／补充材料';
export const supplementalTaxonomy={id:SUPPLEMENTAL_MATERIAL_ID,label:SUPPLEMENTAL_MATERIAL_LABEL,keywords:[SUPPLEMENTAL_MATERIAL_LABEL]};
export const SupplementCommandSchema=z.strictObject({
  expectedRevision:z.number().int().positive(),roundId:z.uuid().optional(),idempotencyKey:z.uuid(),
  request:z.string().trim().min(1).max(2000),
  documentIds:z.array(z.uuid()).min(1).max(6).refine(ids=>new Set(ids).size===ids.length),
});
const citation=z.strictObject({evidenceId:z.string().min(1).max(200),quote:z.string().min(1).max(1000)});
export const SupplementOutputSchema=z.strictObject({
  reply:z.string().min(1).max(2000),
  fields:z.array(z.strictObject({label:z.string().min(1).max(100),documentId:z.uuid(),status:z.enum(['found','not_found','uncertain']),value:z.string().max(4000),citations:z.array(citation).max(20)})).max(30),
  checks:z.array(z.strictObject({label:z.string().min(1).max(200),outcome:z.enum(['consistent','different','insufficient']),reason:z.string().min(1).max(2000),citations:z.array(citation).max(30)})).max(20),
  questions:z.array(z.string().min(1).max(500)).max(5),limitations:z.array(z.string().min(1).max(500)).max(20),
});
export type SupplementOutput=z.infer<typeof SupplementOutputSchema>;
export interface SupplementDocument {id:string;filename:string;supplemental:boolean;available:boolean}
export interface SupplementJob {
  id:string;request:string;documentIds:string[];state:'pending'|'running'|'ready'|'failed'|'unknown';
  validity:'current'|'stale';createdAt:string;errorCode:string|null;output:SupplementOutput|null;
  evidence:AnalysisEvidence[];simulated:boolean;
}
export interface SupplementState {available:boolean;canRequest:boolean;documents:SupplementDocument[];items:SupplementJob[]}
