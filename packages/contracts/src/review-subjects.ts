import {z} from 'zod';
import {ReviewCommandSchema} from './review.js';

export const SUBJECT_ROLES=['corporate_guarantee','personal_guarantee'] as const;
export type SubjectRole=typeof SUBJECT_ROLES[number];
export const SUBJECT_ROLE_LABELS:Record<SubjectRole,string>={corporate_guarantee:'公司担保人',personal_guarantee:'个人担保人'};
/** The reviewer's own decision on who the subjects of this round are. Each subject may carry several writings of its name. */
export const ConfirmSubjectsSchema=ReviewCommandSchema.extend({
  subjects:z.array(z.strictObject({
    role:z.enum(SUBJECT_ROLES),label:z.string().trim().min(1).max(300),
    names:z.array(z.string().trim().min(1).max(300)).min(1).max(20),
  })).max(40),
});
export type ConfirmSubjects=z.infer<typeof ConfirmSubjectsSchema>;
export interface ConfirmedSubject {id:string;role:SubjectRole;label:string;names:string[]}
/** One writing of a name found in the round's files. `suggested` marks names read from the guarantee itself. */
export interface SubjectCandidate {role:SubjectRole;name:string;suggested:boolean;sources:Array<{documentId:string;filename:string;fieldLabel:string}>;
  /** Another writing of the same company that this one is offered under: the same complete English name, with no
   * conflicting Chinese name ("EXAMPLE LIMITED" beside "EXAMPLE LIMITED 示例有限公司"). Only a starting choice; the reviewer
   * confirms or separates them. */
  sameAs?:string}
export interface SubjectConfirmationState {
  /** False when the round is read-only or the configuration has no guarantor subjects. */
  editable:boolean;roles:SubjectRole[];
  confirmed:{confirmedAt:string;subjects:ConfirmedSubject[]}|null;
  candidates:SubjectCandidate[];
  /** Case revision the candidates were read at; a confirmation is sent against it. */
  revision?:number;
  /** Uploads, parses, translations or checks of this round still running. Subjects can be confirmed once none is left,
   * because confirming changes the case and would void work that is still running. */
  inProgress?:Array<{kind:string;filename:string|null}>;
}
/** The current round's unfinished work only; polled while a confirmation waits. */
export interface SubjectWorkState {revision:number;inProgress:Array<{kind:string;filename:string|null}>}
