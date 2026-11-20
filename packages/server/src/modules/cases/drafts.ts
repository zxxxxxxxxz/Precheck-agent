import {editableDraftValues, draftValue, setDraftValue} from './draft-values.js';
import { authorizeDraft, assertOpenDraft, draftView, type DraftRow } from './draft-state.js';
import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import { z } from 'zod';
import { ApplyDraftSuggestionSchema, CaseDraftFieldsSchema, DraftCommandSchema, SaveCaseDraftSchema,
  emptyCaseDraftFields, type CaseDraft, type CaseDraftFields, type DraftField, type IntakeField, type DraftFieldState, type DraftSource } from '@hsbc/contracts/draft';
import type { Auth } from '../identity/auth.js';
import { AppError } from '../../shared/errors.js';
import { audit } from '../audit/events.js';
import { idempotent } from '../../infrastructure/database/idempotency.js';
import { requireCaseCreator } from './authorization.js';
import { transaction, type DB } from '../../infrastructure/database/client.js';
import { type Actor } from '../identity/types.js';
export type CandidateResolver = (db: DB, actor: Actor, draft: DraftRow, turnId: string, candidateId: string) => Promise<{field: IntakeField; value: unknown; sourceRefs?:string[]}>;
export async function registerCaseDrafts(app: FastifyInstance, pool: Pool, auth: Auth, resolveCandidate: CandidateResolver,
  cancelTurns: (db: DB, draftId: string) => Promise<void>, cancelAttachments: (db: DB, draftId: string) => Promise<void>) {
  const pathId = (request: any) => z.uuid().parse(request.params.id);
  app.get('/api/case-drafts', async request => transaction(pool, async db => {
    const actor = await auth.requireSession(request); await requireCaseCreator(db, actor);
    const query = z.object({ before: z.iso.datetime().optional(), status: z.enum(['open','created','discarded']).optional() }).strict().parse(request.query);
    const rows = (await db.query(`SELECT * FROM business.case_drafts WHERE owner_person_id=$1
      AND ($2::text IS NULL OR status=$2) AND ($3::timestamptz IS NULL OR updated_at<$3)
      ORDER BY updated_at DESC,id DESC LIMIT 100`, [actor.personId, query.status ?? null, query.before ?? null])).rows;
    return { items: rows.map(draftView), nextBefore: rows.length === 100 ? draftView(rows[99]).updatedAt : null };
  }));
  app.post('/api/case-drafts', async request => {
    const actor = await auth.checkWrite(request);
    const input = z.object({idempotencyKey: z.string().min(1).max(128)}).strict().parse(request.body);
    return transaction(pool, async db => {
      await requireCaseCreator(db, actor);
      const receipt = await idempotent(db, actor, 'draft.create', input.idempotencyKey, input, async () => {
        const id = randomUUID();
        await db.query(`INSERT INTO business.case_drafts(id,owner_person_id,fields,field_states,field_sources) VALUES($1,$2,$3,$4,'{"scenario":{"kind":"system_default"}}')`,
          [id, actor.personId, JSON.stringify(emptyCaseDraftFields()), JSON.stringify({scenario:'manual',title:'empty',reference:'empty',background:'empty'})]);
        await audit(db, {actorId:actor.accountId,targetId:id,action:'draft.created'});
        return {id};
      });
      return draftView(await authorizeDraft(db, actor, receipt.id));
    });
  });
  app.get('/api/case-drafts/:id', async request => transaction(pool, async db => draftView(await authorizeDraft(db, await auth.requireSession(request), pathId(request), false))));
  app.post('/api/case-drafts/:id/save', async request => {
    const actor = await auth.checkWrite(request), id = pathId(request), input = SaveCaseDraftSchema.parse(request.body);
    return transaction(pool, async db => {
      const draft = await authorizeDraft(db, actor, id);
      await idempotent(db, actor, `draft.save:${id}`, input.idempotencyKey, input, async () => {
        assertOpenDraft(draft, input.expectedRevision);
        await cancelTurns(db, id);
        const states = {...draft.field_states},sources={...draft.field_sources};
        for (const field of Object.keys(input.fields) as DraftField[]) if (input.fields[field] !== draft.fields[field] || input.touchedFields?.includes(field)) {
          states[field] = input.fields[field] ? 'manual' : 'empty';
          sources[field]={kind:'manual',personId:actor.personId,accountId:actor.accountId};
        }
        const before = editableDraftValues(draft);
        const after = {...before, details: {...before.details, ...input.details}, guaranteeTypes: input.guaranteeTypes ?? before.guaranteeTypes};
        for (const field of [...Object.keys(after.details), 'guaranteeTypes'] as IntakeField[]) {
          if (JSON.stringify(draftValue(before, field)) !== JSON.stringify(draftValue(after, field)) || input.touchedFields?.includes(field)) {
            states[field] = 'manual'; sources[field] = {kind: 'manual', personId: actor.personId, accountId: actor.accountId};
          }
        }
        await db.query(`UPDATE business.case_drafts SET fields=$2,field_states=$3,source=$4,field_sources=$5,details=$6,guarantee_types=$7,revision=revision+1,updated_at=now() WHERE id=$1`,
          [id, JSON.stringify(input.fields), JSON.stringify(states), JSON.stringify(input.source),JSON.stringify(sources),JSON.stringify(after.details),JSON.stringify(after.guaranteeTypes)]);
        await audit(db, {actorId:actor.accountId,targetId:id,action:'draft.saved',details:{revision:draft.revision+1}});
        return {id};
      });
      return draftView(await authorizeDraft(db, actor, id));
    });
  });
  app.post('/api/case-drafts/:id/apply', async request => {
    const actor = await auth.checkWrite(request), id = pathId(request), input = ApplyDraftSuggestionSchema.parse(request.body);
    return transaction(pool, async db => {
      const draft = await authorizeDraft(db, actor, id);
      await idempotent(db, actor, `draft.apply:${id}`, input.idempotencyKey, input, async () => {
        assertOpenDraft(draft, input.expectedRevision);
        const values = editableDraftValues(draft), states = {...draft.field_states},sources={...draft.field_sources}, used = new Set<IntakeField>();
        for (const candidateId of input.candidateIds) {
          const candidate = await resolveCandidate(db, actor, draft, input.turnId, candidateId);
          if (used.has(candidate.field)) throw new AppError(422, 'duplicate_suggestion_field');
          used.add(candidate.field);
          setDraftValue(values, candidate.field, candidate.value); states[candidate.field] = 'accepted';
          sources[candidate.field]={kind:'suggestion',turnId:input.turnId,candidateId,personId:actor.personId,accountId:actor.accountId,...(candidate.sourceRefs?.length?{sourceRefs:candidate.sourceRefs}:{})};
        }
        CaseDraftFieldsSchema.parse(values.fields);
        await cancelTurns(db, id);
        await db.query('UPDATE business.case_drafts SET fields=$2,field_states=$3,field_sources=$4,details=$5,guarantee_types=$6,revision=revision+1,updated_at=now() WHERE id=$1', [id, JSON.stringify(values.fields), JSON.stringify(states),JSON.stringify(sources),JSON.stringify(values.details),JSON.stringify(values.guaranteeTypes)]);
        await db.query('UPDATE business.intake_turns SET result_revision=$2 WHERE id=$1 AND protocol_version=2',[input.turnId,draft.revision+1]);
        await audit(db, {actorId:actor.accountId,targetId:id,action:'draft.suggestions_applied',details:{revision:draft.revision+1,turnId:input.turnId,count:used.size}});
        return {id};
      });
      return draftView(await authorizeDraft(db, actor, id));
    });
  });
  app.post('/api/case-drafts/:id/discard', async request => {
    const actor = await auth.checkWrite(request), id = pathId(request), input = DraftCommandSchema.parse(request.body);
    return transaction(pool, async db => {
      const draft = await authorizeDraft(db, actor, id);
      await idempotent(db, actor, `draft.discard:${id}`, input.idempotencyKey, input, async () => {
        assertOpenDraft(draft, input.expectedRevision);
        await db.query("UPDATE business.case_drafts SET status='discarded',revision=revision+1,updated_at=now() WHERE id=$1", [id]);
        await cancelTurns(db, id);
        await cancelAttachments(db,id);
        await audit(db, {actorId:actor.accountId,targetId:id,action:'draft.discarded'});
        return {id};
      });
      return draftView(await authorizeDraft(db, actor, id));
    });
  });
}
