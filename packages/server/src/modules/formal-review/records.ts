import type {DB} from '../../infrastructure/database/client.js';
import {reviewHash} from '../review/service.js';
import {AppError} from '../../shared/errors.js';
import {formalFindings} from './coverage.js';
import type {FormalCheck,FormalResult} from '@hsbc/contracts/formal-review';
import type {AnalysisEvidence} from '@hsbc/contracts/review-delivery';
export interface FormalInput {checks:FormalCheck[];evidence:AnalysisEvidence[];runHash:string;configHash:string;profileHash:string;protocol:string;promptHash:string;caseRevision:number}
export async function formalRecord(db:DB,runId:string){
 const job=(await db.query('SELECT j.*,s.body,s.body_hash FROM business.formal_review_jobs j JOIN business.formal_review_snapshots s ON s.job_id=j.id WHERE j.run_id=$1 ORDER BY j.created_at DESC,j.id DESC LIMIT 1',[runId])).rows[0];
 if(!job)return null;
 if(reviewHash(job.body)!==job.body_hash||job.input_hash!==job.body_hash||job.body.runHash!==job.snapshot_hash||job.body.profileHash!==job.profile_hash)throw new AppError(409,'formal_integrity_failed');
 const rows=(await db.query('SELECT body,body_hash FROM business.formal_review_results WHERE job_id=$1 ORDER BY check_id',[job.id])).rows;
 if(rows.some(r=>reviewHash(r.body)!==r.body_hash))throw new AppError(409,'formal_integrity_failed');
 const input=job.body as FormalInput,results=rows.map(r=>r.body as FormalResult);
 if(results.some(r=>!input.checks.some(c=>c.id===r.checkId))||new Set(results.map(r=>r.checkId)).size!==results.length)throw new AppError(409,'formal_integrity_failed');
 return {job,input,results,findings:formalFindings(input.checks,results)};
}
