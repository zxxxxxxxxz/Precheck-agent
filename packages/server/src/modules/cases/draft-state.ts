import {emptyCaseDetails, type CaseDetails, type CaseDraft, type CaseDraftFields, type DraftSource} from '@hsbc/contracts/draft';
import type { Actor } from '../identity/types.js';
import type { DB } from '../../infrastructure/database/client.js';
import { AppError } from '../../shared/errors.js';
import { requireCaseCreator } from './authorization.js';
export interface DraftRow {
  details?: CaseDetails;
  guarantee_types?: CaseDraft['guaranteeTypes'];
  id: string; owner_person_id: string; revision: number; fields: CaseDraftFields;
  field_states: CaseDraft['fieldStates']; field_sources:CaseDraft['fieldSources']; source: DraftSource;
  status: 'open' | 'created' | 'discarded'; created_case_id: string | null;
  created_at: Date | string; updated_at: Date | string;
}

export async function authorizeDraft(db: DB, actor: Actor, id: string, lock = true): Promise<DraftRow> {
  await requireCaseCreator(db, actor);
  const result = await db.query(`SELECT * FROM business.case_drafts WHERE id=$1 AND owner_person_id=$2 ${lock ? 'FOR UPDATE' : ''}`, [id, actor.personId]);
  if (!result.rowCount) throw new AppError(404, 'draft_not_found');
  return result.rows[0];
}

export function assertOpenDraft(draft: DraftRow, revision: number) {
  if (draft.status !== 'open') throw new AppError(409, 'draft_closed');
  if (draft.revision !== revision) throw new AppError(409, 'stale_draft_revision');
}

export function draftView(row: DraftRow): CaseDraft {
  const iso = (date: Date | string) => new Date(date).toISOString();
  return { id: row.id, ownerPersonId: row.owner_person_id, revision: row.revision,
    fields: row.fields, guaranteeTypes: row.guarantee_types ?? [], details: {...emptyCaseDetails(), ...row.details}, fieldStates: row.field_states, fieldSources:row.field_sources??{}, source: row.source, status: row.status,
    createdCaseId: row.created_case_id, createdAt: iso(row.created_at), updatedAt: iso(row.updated_at) };
}
