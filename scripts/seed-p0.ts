import { randomBytes } from 'node:crypto';
import { readFile,writeFile,mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { generateKeyPair,exportJWK } from 'jose';
import argon2 from 'argon2';
import { p0Environment,p0Paths,p0Pool,verifyInstance,logEvent } from '@hsbc/server/experiments/p0/persistence/environment';

export async function seedP0() {
  const env=p0Environment();const pool=p0Pool(env.MIGRATION_DATABASE_URL);
  const localDir=p0Paths().localDir;
  try {
    await verifyInstance(pool,env.P0_INSTANCE_ID);
    await mkdir(localDir,{recursive:true,mode:0o700});
    let credentials:{username:string;password:string}[];
    try {credentials=JSON.parse(await readFile(join(localDir,'demo-credentials.json'),'utf8'));}
    catch {credentials=['maker','checker','maker-alias'].map(username=>({username,password:randomBytes(24).toString('base64url')}));await writeFile(join(localDir,'demo-credentials.json'),JSON.stringify(credentials),{mode:0o600});}
    for(const user of credentials) await pool.query(`INSERT INTO auth.accounts(id,person_id,username,password_hash) VALUES($1,$2,$3,$4) ON CONFLICT(id) DO NOTHING`,[user.username,user.username.startsWith('maker')?'maker-person':'checker-person',user.username,await argon2.hash(user.password)]);
    await pool.query("INSERT INTO business.p0_cases(id,revision) VALUES('p0-case',1) ON CONFLICT DO NOTHING");
    await pool.query("INSERT INTO business.service_principals(id) VALUES('p0-worker') ON CONFLICT DO NOTHING");
    await pool.query(`INSERT INTO business.delegations(id,service_id,case_id,revision,actions,expires_at) VALUES('p0-delegation','p0-worker','p0-case',1,$1,clock_timestamp()+interval '1 day') ON CONFLICT(id) DO UPDATE SET expires_at=EXCLUDED.expires_at WHERE business.delegations.expires_at<=clock_timestamp() AND NOT business.delegations.revoked`,[['a2a:discover','a2a:send','a2a:get','a2a:cancel','mcp:connect','get_evidence','parse_document','get_tool_job']]);
    try {await readFile(join(localDir,'service-private.jwk'));}
    catch {const keys=await generateKeyPair('ES256',{extractable:true});await writeFile(join(localDir,'service-private.jwk'),JSON.stringify(await exportJWK(keys.privateKey)),{mode:0o600});await writeFile(join(localDir,'service-public.jwk'),JSON.stringify(await exportJWK(keys.publicKey)),{mode:0o600});}
    logEvent('p0_synthetic_seed_complete');
  }finally{await pool.end();}
}
if(process.argv[1]?.endsWith('seed-p0.ts'))await seedP0();
