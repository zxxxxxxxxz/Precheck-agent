import { randomUUID } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import pg from 'pg';
import { z } from 'zod';
import { hashPassword,temporaryPassword } from '@hsbc/server/modules/identity/auth';
import { ACTIONS } from '@hsbc/server/modules/identity/authorization';
import { audit } from '@hsbc/server/modules/audit/events';
import { loadConfig, type AppConfig } from '@hsbc/server/runtime/config';
import { transaction, verifyDatabase } from '@hsbc/server/infrastructure/database/client';

export async function bootstrapAdmin(config:AppConfig,username:string,displayName:string,output:string){
  z.string().regex(/^[a-z0-9][a-z0-9._@-]{2,99}$/).parse(username);z.string().trim().min(1).max(100).parse(displayName);
  const pool=new pg.Pool({connectionString:config.databaseUrl,max:1});
  try{
    await verifyDatabase(pool,config.instanceId);
    const password=temporaryPassword(),hash=await hashPassword(password),accountId=randomUUID(),personId=randomUUID(),expiresAt=new Date(Date.now()+24*60*60_000).toISOString();
    await transaction(pool,async db=>{
      await db.query("SELECT pg_advisory_xact_lock(hashtextextended('p1-admin-bootstrap',0))");
      if((await db.query('SELECT 1 FROM auth.accounts LIMIT 1')).rowCount)throw new Error('bootstrap_already_completed');
      // A technical administrator has no inferred RM/BCO job or implicit case access.
      await db.query('INSERT INTO auth.people(id,display_name,business_role) VALUES($1,$2,NULL)',[personId,displayName]);
      await db.query('INSERT INTO auth.accounts(id,person_id,username,password_hash,password_expires_at) VALUES($1,$2,$3,$4,$5)',[accountId,personId,username,hash,expiresAt]);
      for(const action of ['account:manage','permission:manage','audit:read','system:status'])await db.query('INSERT INTO business.access_grants(id,person_id,action,created_by) VALUES($1,$2,$3,$4)',[randomUUID(),personId,action,accountId]);
      for(const action of ACTIONS)await db.query('INSERT INTO business.grant_authorities(person_id,action) VALUES($1,$2)',[personId,action]);
      await audit(db,{actorId:accountId,action:'account.bootstrap'});
      // Exclusive creation: never overwrite an operator's credential file; failure rolls back the account.
      await writeFile(resolve(output),JSON.stringify({username,temporaryPassword:password,expiresAt,accountId,personId},null,2)+'\n',{mode:0o600,flag:'wx'});
    });
    console.log(JSON.stringify({code:'p1_admin_created',credentialFile:resolve(output),mustChangePassword:true}));
  }finally{await pool.end();}
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){
  const [username,displayName,output,...extra]=process.argv.slice(2);
  if(!username||!displayName||!output||extra.length)throw new Error('Usage: p1-bootstrap.ts USERNAME DISPLAY_NAME PRIVATE_OUTPUT_PATH');
  await bootstrapAdmin(loadConfig(process.env,'migration'),username,displayName,output);
}
