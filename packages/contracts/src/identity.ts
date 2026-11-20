import { z } from 'zod';

export const ResourceScopeSchema = z.object({
  caseId: z.string().min(1).max(128),
  revision: z.number().int().positive(),
}).strict();
export type ResourceScope = z.infer<typeof ResourceScopeSchema>;
export const ServiceIdentitySchema = z.object({
  kind: z.literal('service'), serviceId: z.string().min(1),
  delegationId: z.string().min(1), credentialId: z.string().min(1),
}).strict();
export type ServiceIdentity = z.infer<typeof ServiceIdentitySchema>;
export const HumanIdentitySchema = z.object({
  kind: z.literal('human'), accountId: z.string().min(1), personId: z.string().min(1),
  sessionId: z.string().min(1),
}).strict();
export type HumanIdentity = z.infer<typeof HumanIdentitySchema>;
export const IdentityContextSchema = z.discriminatedUnion('kind', [HumanIdentitySchema, ServiceIdentitySchema]);
export type IdentityContext = z.infer<typeof IdentityContextSchema>;

/** Created by the authorization layer from current records, never from request JSON. */
export interface AuthorizedScope extends ResourceScope {
  serviceId: string;
  delegationId: string;
  authorizationVersion: number;
}

/** A standing, administrator-authorized pairing for newly created cases. */
export const ReviewTeamCommandSchema = z.object({
  makerPersonId: z.uuid(), checkerPersonId: z.uuid(), enabled: z.boolean(),
  expectedVersion: z.number().int().nonnegative(), reason: z.string().trim().min(1).max(1000),
}).strict().refine(v => v.makerPersonId !== v.checkerPersonId, {message: '初审与复核必须由不同人员承担'});
export type ReviewTeamCommand = z.infer<typeof ReviewTeamCommandSchema>;
export interface ReviewTeam {
  makerPersonId: string; checkerPersonId: string; makerName: string; checkerName: string;
  enabled: boolean; version: number;
}
