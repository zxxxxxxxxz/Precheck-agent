import { importSPKI, jwtVerify } from 'jose';
import { z } from 'zod';
import type { Pool } from 'pg';
import { AppError } from '../../shared/errors.js';
import { authorizeCase } from '../../modules/cases/authorization.js';
import { transaction } from '../../infrastructure/database/client.js';
import type { Actor } from '../../modules/identity/types.js';
import type { DocumentActor } from '../../modules/documents/service.js';
import type { DocumentRuntimeConfig } from '../../modules/documents/config.js';
import { documentToolSchemas, type DocumentToolName } from './document-schemas.js';

type DocumentToolIdentity = { serviceId: string; delegationId: string };
type DocumentToolInput = z.infer<(typeof documentToolSchemas)[DocumentToolName]>;

/** Authentication and delegation reads retain their original independent transactions. */
export async function createDocumentToolAuthorization(documents: { pool: Pool }, config: NonNullable<DocumentRuntimeConfig['mcp']>) {
  const key=await importSPKI(config.publicKey.replace(/\\n/g,'\n'),'ES256');
  const authenticate=async(header:string|undefined)=>{
    if(!header?.startsWith('Bearer '))throw new AppError(401,'service_authentication_required');
    try{
      const {payload}=await jwtVerify(header.slice(7),key,{issuer:config.issuer,audience:config.audience,algorithms:['ES256'],requiredClaims:['sub','iat','exp','jti'],maxTokenAge:'5m'});
      if(typeof payload.delegationId!=='string'||!z.uuid().safeParse(payload.delegationId).success||payload.exp!-payload.iat!>300)throw new Error();
      return {serviceId:payload.sub!,delegationId:payload.delegationId};
    }catch{throw new AppError(401,'invalid_service_credential');}
  };

  return {
    authenticate,
    delegatedActions: async (identity: DocumentToolIdentity) => await transaction(documents.pool,async db=>{
        const d=(await db.query('SELECT * FROM business.lock_document_delegation($1)',[identity.delegationId])).rows[0];
        if(!d||d.revoked||d.service_id!==identity.serviceId||d.expires_at.getTime()<=Date.now()||!d.actions.length)throw new AppError(403,'scope_denied');
        const actor:Actor={accountId:d.account_id,personId:d.person_id,authVersion:d.auth_version};
        const c=await authorizeCase(db,actor,d.case_id,'case:read',false);
        if(c.revision!==d.case_revision)throw new AppError(409,'stale_revision');
        return d.actions as string[];
      }),
    authorize: async (identity: DocumentToolIdentity, name: DocumentToolName, input: DocumentToolInput) => await transaction(documents.pool,async db=>{
              const d=(await db.query('SELECT * FROM business.document_tool_delegations WHERE id=$1',[identity.delegationId])).rows[0];
              if(!d||d.revoked||d.service_id!==identity.serviceId||d.expires_at.getTime()<=Date.now()||!d.actions.includes(name)||d.case_id!==input.caseId||d.case_revision!==input.revision)throw new AppError(403,'scope_denied');
              const actor:DocumentActor={accountId:d.account_id,personId:d.person_id,authVersion:d.auth_version,documentAuthority:{id:d.id,serviceId:identity.serviceId,action:name,caseRevision:input.revision}};
              const c=await authorizeCase(db,actor,d.case_id,name==='parse_document'||name==='extract_fields'?'document:parse':'evidence:read',false);
              if(c.revision!==input.revision||('expectedRevision' in input&&input.expectedRevision!==input.revision))throw new AppError(409,'stale_revision');
              const ids='documentId' in input?[input.documentId]:'beforeDocumentId' in input?[input.beforeDocumentId,input.afterDocumentId]:[];
              if(name==='get_tool_job'){
                const job=(await db.query('SELECT * FROM business.document_jobs WHERE id=$1',[(input as any).jobId])).rows[0];
                if(!job||job.case_id!==d.case_id||job.person_id!==d.person_id)throw new AppError(403,'scope_denied');
                ids.push(job.document_version_id);
                if(job.kind==='compare_document_versions')ids.push(job.input.beforeDocumentId,job.input.afterDocumentId);
                if(!d.actions.includes(job.kind))throw new AppError(403,'scope_denied');
              }
              if(ids.some(id=>!d.document_ids.includes(id)))throw new AppError(403,'scope_denied');
              return {actor,documentIds:ids};
            }),
  };
}
