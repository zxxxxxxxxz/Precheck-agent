import {reviewProjectionJoins,reviewStatusSql,caseReviewProjections} from './review-status.js';
import type {CaseReviewProjection} from '@hsbc/contracts/case-review-status';
import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import { z } from 'zod';
import type { Auth } from '../identity/auth.js';
import { assertActor } from '../identity/authorization.js';
import { transaction, type DB } from '../../infrastructure/database/client.js';
import { type Actor } from '../identity/types.js';

export interface WorkbenchSnapshot {
  statusCounts?:Record<string,number>;
  periodDays: 7 | 30;
  counts: { accessibleCases: number; myCases: number; awaitingAssignment: number; registeredMaterials: number };
  materialTrend: { date: string; count: number }[];
  workItems: (Partial<CaseReviewProjection>&{
    caseId: string; caseNumber: string | null; title: string; reference: string | null; status: 'assignment_required' | 'collecting_materials';
    materialCount: number; allowed_actions: string[]; updatedAt: string;
  })[];
  recentActivity: {
    id: string; caseId: string; caseTitle: string; action: 'case.created' | 'case.assigned' | 'material:register';
    actorName: string | null; createdAt: string;
  }[];
}

/** Call inside a transaction so the actor lock also covers the authorized projection. */
export async function readWorkbench(db: DB, actor: Actor, periodDays: 7 | 30, now = new Date()): Promise<WorkbenchSnapshot> {
  const principal=await assertActor(db, actor);
  // One statement gives counts, rows and activity the same snapshot. Never aggregate the capped /cases response.
  const result = await db.query<{ snapshot: WorkbenchSnapshot }>(`
    WITH grants AS MATERIALIZED (
      SELECT action, case_id FROM business.access_grants WHERE person_id=$1 AND NOT revoked
    ), visible AS MATERIALIZED (
      SELECT c.*,${reviewStatusSql()} AS pre_review_status,
        $4::boolean AND c.closed_at IS NULL AND EXISTS(SELECT 1 FROM grants g WHERE g.action='case:assign' AND (g.case_id IS NULL OR g.case_id=c.id)) AS can_assign,
        $4::boolean AND c.closed_at IS NULL AND (NOT c.review_rounds_enabled OR q.state='draft' AND NOT coalesce(r.state IN ('pending','running') AND r.validity='current',false)) AND c.maker_person_id=$1
          AND EXISTS(SELECT 1 FROM grants g WHERE g.action='maker' AND (g.case_id IS NULL OR g.case_id=c.id))
          AND EXISTS(SELECT 1 FROM grants g WHERE g.action='material:upload' AND (g.case_id IS NULL OR g.case_id=c.id)) AS can_upload,
        EXISTS(SELECT 1 FROM grants g WHERE g.action='evidence:read' AND (g.case_id IS NULL OR g.case_id=c.id)) AS can_read_evidence
      FROM business.cases c ${reviewProjectionJoins()}
      WHERE $4::boolean AND EXISTS(SELECT 1 FROM grants g WHERE g.action='case:read' AND (g.case_id IS NULL OR g.case_id=c.id))
    ), materials AS MATERIALIZED (
      SELECT d.id,d.case_id,d.created_at FROM business.document_versions d JOIN visible c ON c.id=d.case_id
    ), dates AS (
      SELECT ($3::timestamptz AT TIME ZONE 'Asia/Singapore')::date AS today
    ), trend AS (
      SELECT to_char(day,'YYYY-MM-DD') AS date, count(d.id)::integer AS count
      FROM dates CROSS JOIN LATERAL generate_series(today-($2::integer-1),today,interval '1 day') AS day
      LEFT JOIN materials d ON d.created_at >= (day::date::timestamp AT TIME ZONE 'Asia/Singapore')
        AND d.created_at < ((day::date+1)::timestamp AT TIME ZONE 'Asia/Singapore')
      GROUP BY day ORDER BY day
    ), next_cases AS (
      SELECT c.*,(SELECT count(*)::integer FROM materials d WHERE d.case_id=c.id) AS material_count
      FROM visible c WHERE (c.maker_person_id IS NULL AND c.can_assign) OR c.maker_person_id=$1 OR c.can_upload
      ORDER BY (c.maker_person_id IS NULL AND c.can_assign) DESC,c.updated_at DESC,c.id LIMIT 6
    ), case_activity AS (
      SELECT e.id,c.id AS case_id,coalesce(c.case_number,nullif(c.title,''),nullif(c.reference,''),c.id::text) AS case_title,e.action,e.actor_id,e.created_at
      FROM business.audit_events e JOIN visible c ON e.target_id=c.id::text
      WHERE e.action IN ('case.created','case.assigned') AND e.result='success'
      UNION ALL
      SELECT e.id,c.id,coalesce(c.case_number,nullif(c.title,''),nullif(c.reference,''),c.id::text),e.action,e.actor_id,e.created_at
      FROM business.audit_events e JOIN materials d ON e.target_id=d.id::text JOIN visible c ON c.id=d.case_id
      WHERE e.action='material:register' AND e.result='success'
    ), activity AS (
      SELECT e.*,p.display_name AS actor_name FROM case_activity e
      LEFT JOIN auth.accounts a ON a.id=e.actor_id LEFT JOIN auth.people p ON p.id=a.person_id
      ORDER BY e.created_at DESC,e.id LIMIT 8
    )
    SELECT json_build_object(
      'periodDays',$2::integer,
      'statusCounts',coalesce((SELECT json_object_agg(pre_review_status,total) FROM (SELECT pre_review_status,count(*)::integer AS total FROM visible GROUP BY pre_review_status) counts),'{}'::json),
      'counts',json_build_object(
        'accessibleCases',(SELECT count(*)::integer FROM visible),
        'myCases',(SELECT count(*)::integer FROM visible WHERE maker_person_id=$1),
        'awaitingAssignment',(SELECT count(*)::integer FROM visible WHERE maker_person_id IS NULL AND can_assign),
        'registeredMaterials',(SELECT count(*)::integer FROM materials)),
      'materialTrend',(SELECT json_agg(trend ORDER BY date) FROM trend),
      'workItems',coalesce((SELECT json_agg(json_build_object(
        'caseId',id,'caseNumber',case_number,'title',title,'reference',reference,'status',status,'materialCount',material_count,
        'allowed_actions',array_remove(ARRAY['case:read',CASE WHEN can_assign THEN 'case:assign' END,
          CASE WHEN can_upload THEN 'material:upload' END,CASE WHEN can_read_evidence THEN 'evidence:read' END],NULL),
        'updatedAt',updated_at) ORDER BY (maker_person_id IS NULL AND can_assign) DESC,updated_at DESC,id) FROM next_cases),'[]'::json),
      'recentActivity',coalesce((SELECT json_agg(json_build_object(
        'id',id,'caseId',case_id,'caseTitle',case_title,'action',action,'actorName',actor_name,'createdAt',created_at)
        ORDER BY created_at DESC,id) FROM activity),'[]'::json)
    ) AS snapshot`, [actor.personId, periodDays, now,principal.business_role==='BCO']);
  const snapshot=result.rows[0]!.snapshot,projections=await caseReviewProjections(db,snapshot.workItems.map(item=>item.caseId));
  return {...snapshot,workItems:snapshot.workItems.map(item=>({...item,...projections.get(item.caseId)}))};
}

export async function registerWorkbench(app: FastifyInstance, pool: Pool, auth: Auth) {
  app.get('/api/workbench', async request => {
    const actor = await auth.requireSession(request);
    const query = z.object({ days: z.enum(['7', '30']).default('30') }).strict().parse(request.query);
    return transaction(pool, db => readWorkbench(db, actor, query.days === '7' ? 7 : 30));
  });
}
