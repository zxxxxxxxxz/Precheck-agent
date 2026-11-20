import {createHash} from 'node:crypto';
import type {PoolClient} from 'pg';
import {z} from 'zod';
import type {ProcessingPolicySummary} from '@hsbc/contracts/document-processing-access';
import type {DocumentCloudConfig} from './cloud-extraction-config.js';
import {hasGrant} from '../identity/authorization.js';

export const processingPolicyHash=(config:DocumentCloudConfig)=>createHash('sha256').update(JSON.stringify(config.cloud.policy)).digest('hex');
export const policyLive=(config?:DocumentCloudConfig)=>Boolean(config&&Date.parse(config.cloud.policy.expiresAt)>Date.now());
export function processingPolicySummary(config?:DocumentCloudConfig):ProcessingPolicySummary|undefined {
  if(!config?.policyReuse)return;
  const p=config.cloud.policy;
  return {mode:'demo',id:p.id,version:p.version,hash:processingPolicyHash(config),expiresAt:p.expiresAt,available:policyLive(config),dataClass:p.dataClass};
}
export type PolicyPermit={kind:'policy';id:string;policyHash:string;configurationReleaseId:string};
export type DemoPolicyPermit={kind:'demo_policy';policyId:string;policyVersion:string;policyHash:string;configurationReleaseId:string};
type CaseScope={id:string;maker_person_id:string;configuration_release_id?:string|null;current_round_id?:string|null;revision?:number};
const declarationDetails=z.strictObject({policyHash:z.string().regex(/^[a-f0-9]{64}$/),configurationReleaseId:z.string().min(1),
  authVersion:z.number().int().positive(),dataClass:z.literal('public_synthetic'),expiresAt:z.iso.datetime(),reason:z.string().min(1).max(500)});

/** Read historical declarations only; existing jobs retain their original authority. */
export async function currentPolicyDeclaration(db:PoolClient,config:DocumentCloudConfig|undefined,c:CaseScope) {
  const row=(await db.query(`SELECT id,kind,actor_person_id,account_id,details,created_at FROM business.review_events
    WHERE case_id=$1 AND kind IN ('processing_policy_declared','processing_policy_revoked') ORDER BY created_at DESC,id DESC LIMIT 1`,[c.id])).rows[0];
  if(!row)return;
  if(row.kind==='processing_policy_revoked')return {id:row.id,status:'revoked' as const,declaredAt:new Date(row.created_at).toISOString()};
  const parsed=declarationDetails.safeParse(row.details);
  const basic={id:row.id,declaredAt:new Date(row.created_at).toISOString()};
  if(!parsed.success)return {...basic,status:'changed' as const};
  const d=parsed.data;
  if(!policyLive(config)||Date.parse(d.expiresAt)<=Date.now())return {...basic,status:'expired' as const};
  if(!config?.policyReuse||d.policyHash!==processingPolicyHash(config)||d.configurationReleaseId!==c.configuration_release_id||row.actor_person_id!==c.maker_person_id)
    return {...basic,status:'changed' as const};
  const principal=(await db.query(`SELECT 1 FROM business.principals WHERE account_id=$1 AND person_id=$2 AND auth_version=$3
    AND enabled AND NOT must_change AND business_role='BCO'`,[row.account_id,row.actor_person_id,d.authVersion])).rowCount;
  const permitted=principal&&await hasGrant(db,row.actor_person_id,'maker',c.id)&&await hasGrant(db,row.actor_person_id,'case:configure',c.id)&&await hasGrant(db,row.actor_person_id,'case:read',c.id);
  return {...basic,status:permitted?'active' as const:'changed' as const,policyHash:d.policyHash,configurationReleaseId:d.configurationReleaseId};
}

/** The server's Demo policy covers registered test PDF/DOCX documents and static JPEG/PNG images, without a per-case declaration. */
export async function demoPolicyProcessingPermit(db:PoolClient,config:DocumentCloudConfig|undefined,c:CaseScope,document:{id:string;sha256:string;source_format?:string},pinned?:DemoPolicyPermit):Promise<DemoPolicyPermit|undefined> {
  if(!config?.policyReuse||!policyLive(config)||!['pdf','docx','jpg','png'].includes(document.source_format??'')||!c.configuration_release_id)return;
  const policy=config.cloud.policy;
  const permit:DemoPolicyPermit={kind:'demo_policy',policyId:policy.id,policyVersion:policy.version,
    policyHash:processingPolicyHash(config),configurationReleaseId:c.configuration_release_id};
  if(pinned&&(pinned.policyId!==permit.policyId||pinned.policyVersion!==permit.policyVersion||pinned.policyHash!==permit.policyHash||pinned.configurationReleaseId!==permit.configurationReleaseId))return;
  const eligible=(await db.query(`SELECT 1 FROM business.review_config_releases r
    JOIN business.document_versions d ON d.case_id=$2 AND d.id=$3 AND d.sha256=$4 AND d.source_format=$5
    JOIN business.upload_sessions u ON u.id=d.upload_session_id AND u.document_version_id=d.id AND u.case_id=d.case_id AND u.state='registered'
    WHERE r.release_id=$1 AND r.manifest->>'scope'='synthetic'
    AND EXISTS(SELECT 1 FROM jsonb_array_elements(r.manifest->'fields') f WHERE f->'recipe'->>'mode'='cloud_grounded_extract')`,
    [c.configuration_release_id,c.id,document.id,document.sha256,document.source_format])).rowCount;
  return eligible?permit:undefined;
}

/** A pinned policy permission cannot fall back to a static allowlist or an old case approval. */
export async function policyProcessingPermit(db:PoolClient,config:DocumentCloudConfig|undefined,c:CaseScope,document:{id:string;sha256:string;source_format?:string},pinned?:PolicyPermit):Promise<PolicyPermit|undefined> {
  if(!config?.policyReuse||!policyLive(config)||document.source_format!=='pdf')return;
  const declaration=await currentPolicyDeclaration(db,config,c);
  if(declaration?.status!=='active')return;
  if(pinned&&(pinned.id!==declaration.id||pinned.policyHash!==declaration.policyHash||pinned.configurationReleaseId!==declaration.configurationReleaseId))return;
  // Only registered bytes belonging to this case are covered, including later PDFs.
  const registered=(await db.query(`SELECT 1 FROM business.document_versions d JOIN business.upload_sessions u ON u.id=d.upload_session_id
    AND u.document_version_id=d.id AND u.state='registered' WHERE d.id=$1 AND d.case_id=$2 AND d.sha256=$3 AND d.source_format='pdf'`,[document.id,c.id,document.sha256])).rowCount;
  if(!registered)return;
  return {kind:'policy',id:declaration.id,policyHash:declaration.policyHash!,configurationReleaseId:declaration.configurationReleaseId!};
}
