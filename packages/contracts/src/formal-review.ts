import {z} from 'zod';
import type {AnalysisEvidence} from './review-delivery.js';
export const FormalCommandSchema=z.strictObject({expectedRevision:z.number().int().positive(),idempotencyKey:z.string().min(8).max(200)});
export const FormalStartSchema=FormalCommandSchema.extend({runId:z.uuid()});
export const FormalAnswerSchema=z.strictObject({checkRef:z.string().min(1),outcome:z.enum(['no_issue','issue','insufficient','manual']),reason:z.string().min(1).max(3000),citations:z.array(z.strictObject({sourceRef:z.string().min(1),quote:z.string().min(1).max(3000)})).max(60)});
export const FormalOutputSchema=z.strictObject({checks:z.array(FormalAnswerSchema).min(1).max(8)});
export type FormalAnswer=z.infer<typeof FormalAnswerSchema>;
export interface FormalCheck {id:string;ruleId:string;objectId:string;objectLabel:string;label:string;requirement:string;sourceReferences:string[];method:'program'|'cloud_and_human'|'business_confirmation';programOutcome:string;evidenceIds:string[];gaps:string[];confirmedInputs:unknown;sourceDirectionConfirmed:boolean}
export interface FormalResult {id:string;checkId:string;outcome:FormalAnswer['outcome'];reason:string;citations:Array<{evidenceId:string;quote:string}>}
export type FormalStatus='pending'|'running'|'completed'|'failed'|'unknown'|'canceled'|'stale';
export interface FormalJob {id:string;roundId:string;runId:string;state:FormalStatus;createdAt:string;errorCode:string|null;checks:FormalCheck[];results:FormalResult[];evidence:AnalysisEvidence[];completed:number;total:number;allowedActions:string[];simulated:boolean;reason:string|null}
export interface FormalState {caseId:string;revision:number;roundId:string|null;runId:string|null;enabled:boolean;readOnly:boolean;blockers:string[];allowedActions:string[];jobs:FormalJob[]}
