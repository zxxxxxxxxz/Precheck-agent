import 'reflect-metadata';
import { Module } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { FastifyAdapter,type NestFastifyApplication } from '@nestjs/platform-fastify';
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { join, resolve } from 'node:path';
import { importJWK,type CryptoKey } from 'jose';
import { z } from 'zod';
import { p0Environment,p0Paths,p0Pool,verifyInstance,logEvent } from '@hsbc/server/experiments/p0/persistence/environment';
import { P0Store } from '@hsbc/server/experiments/p0/persistence/store';
import { AccessDenied,PgAccessRepository,ServiceAuthorizer } from '@hsbc/server/experiments/p0/auth/access';
import { registerP0Auth,PgAccountRepository,createPgSessionStore } from '@hsbc/server/experiments/p0/auth/session';
import { registerP0A2A } from '@hsbc/server/experiments/p0/protocols/a2a';
import { registerP0MCP } from '@hsbc/server/experiments/p0/protocols/mcp';

class AppModule {}
Module({})(AppModule);
export async function createApi(port=Number(process.env.P0_API_PORT??3000)) {
  const env=p0Environment();const pool=p0Pool(env.DATABASE_URL);await verifyInstance(pool,env.P0_INSTANCE_ID);
  const app=await NestFactory.create<NestFastifyApplication>(AppModule,new FastifyAdapter({logger:false,bodyLimit:128*1024,trustProxy:false}),{logger:false});
  const http=app.getHttpAdapter().getInstance();
  const domainErrors:Record<string,number>={forbidden_person:403,account_revoked:403,delegation_revoked:403,
    task_not_found:404,wait_not_found:404,job_not_found:404,evidence_not_found:404,
    task_closed:409,idempotency_conflict:409,decision_conflict:409,stale_revision:409};
  http.setErrorHandler((error:any,_request:any,reply:any)=>{
    const code=error instanceof AccessDenied?error.code:error instanceof z.ZodError?'invalid_request':
      typeof error?.message==='string'&&Object.hasOwn(domainErrors,error.message)?error.message:'p0_request_failed';
    const status=error instanceof AccessDenied?error.statusCode:error instanceof z.ZodError?422:domainErrors[code]??500;
    reply.code(status).send({error:code});
  });
  http.addHook('onSend',async(_request:any,reply:any)=>{reply.header('cache-control','no-store');});
  const baseUrl=`http://127.0.0.1:${port}`;
  const store=new P0Store(pool);
  const auth=await registerP0Auth(http,{accounts:new PgAccountRepository(pool),store:createPgSessionStore(pool),secret:env.SESSION_SECRET,origin:baseUrl,secure:false});
  const requireP0Case=async(request:any)=>{const user=await auth.requireLogin(request);if(!['maker-person','checker-person'].includes(user.personId))throw new AccessDenied('case_not_assigned');return user;};
  const jwk=JSON.parse(await readFile(join(p0Paths().localDir,'service-public.jwk'),'utf8'));
  if(jwk.kty!=='EC'||jwk.crv!=='P-256')throw new Error('invalid_service_public_key');
  const authorizer=new ServiceAuthorizer({publicKey:await importJWK(jwk,'ES256') as CryptoKey,issuer:'hsbc-p0',audience:'hsbc-p0-internal',repository:new PgAccessRepository(pool,async id=>(await pool.query('SELECT revision FROM business.p0_cases WHERE id=$1',[id])).rows[0]?.revision??null)});
  http.get('/health/ready',async()=>{await pool.query('SELECT 1');return {status:'ready',mode:'p0-synthetic'};});
  http.get('/api/p0/tasks/:id',async(request:any)=>{await requireP0Case(request);const task=await store.task(z.uuid().parse(request.params.id));if(task.case_id!=='p0-case')throw new AccessDenied('scope_denied');return {id:task.id,state:task.state,cancelRequested:task.cancel_requested};});
  http.get('/api/p0/tasks/:id/wait',async(request:any)=>{const user=await requireP0Case(request);const id=z.uuid().parse(request.params.id);const r=await pool.query(`SELECT w.id,w.phase,w.assigned_person FROM business.workflow_waits w JOIN business.agent_tasks t ON t.id=w.task_id WHERE w.task_id=$1 AND t.case_id='p0-case'`,[id]);const wait=r.rows[0];if(!wait||!['maker-person',wait.assigned_person].includes(user.personId))throw new AccessDenied('scope_denied');return wait;});
  http.post('/api/p0/human-tasks/:id/decisions',async(request:any)=>{const user=await auth.checkWrite(request);const body=z.object({idempotencyKey:z.string().min(1).max(128),value:z.enum(['confirm','reject']),reason:z.string().min(1).max(500)}).strict().parse(request.body);return {decisionId:await store.decide({waitId:z.uuid().parse(request.params.id),accountIdentity:{accountId:user.accountId,personId:user.personId,sessionEpoch:user.sessionEpoch},...body})};});
  await registerP0A2A(http,{baseUrl,authorizer,tasks:store});
  await registerP0MCP(http,{authorizer,tools:store});
  await app.listen(port,'127.0.0.1');logEvent('p0_api_ready',{port});
  return {app,pool,close:async()=>{await app.close();await pool.end();}};
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href) {
  const runtime=await createApi();let closing=false;
  for(const signal of ['SIGINT','SIGTERM'] as const)process.on(signal,()=>{if(closing)return;closing=true;void runtime.close().then(()=>process.exit(0));});
}
