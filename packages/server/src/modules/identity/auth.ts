import cookie from '@fastify/cookie';
import session, { type SessionStore } from '@fastify/session';
import argon2 from 'argon2';
import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import type { FastifyInstance, FastifyRequest, Session } from 'fastify';
import type { Pool } from 'pg';
import { z } from 'zod';
import { ACTIONS, TECHNICAL_ACTIONS, assertActor, canSignIn, hasGrant, lockPersons, requireGrant } from './authorization.js';
import { AppError } from '../../shared/errors.js';
import { audit } from '../audit/events.js';
import { canCreateCase } from '../cases/authorization.js';
import { transaction } from '../../infrastructure/database/client.js';
import { type Actor } from './types.js';
import { type AppConfig } from '../../runtime/config.js';

export const IDLE_MS=2*60*60_000, ABSOLUTE_MS=8*60*60_000, PRELOGIN_MS=10*60_000;
interface Login extends Actor { startedAt:number; activeAt:number }
interface State { csrf:string; createdAt:number; login?:Login }
declare module 'fastify' { interface Session { p1?:State } }
export const passwordSchema=z.string().min(12).max(200).refine(v=>/[a-zA-Z]/.test(v)&&/[^a-zA-Z]/.test(v),'Use letters and another character type');
export const temporaryPassword=()=>`${randomBytes(20).toString('base64url')}!9a`;
export const hashPassword=(password:string)=>argon2.hash(password,{type:argon2.argon2id,memoryCost:65536,timeCost:3,parallelism:1});
const constantEqual=(a:unknown,b:string)=>typeof a==='string'&&Buffer.byteLength(a)===Buffer.byteLength(b)&&timingSafeEqual(Buffer.from(a),Buffer.from(b));

/** PG owns sessions; tombstones prevent a late request saving a destroyed session. */
export class PgSessions implements SessionStore {
  constructor(private readonly pool:Pool){}
  get(sid:string,cb:(err:any,data?:Session|null)=>void){
    void this.pool.query(`SELECT sess FROM auth.sessions WHERE sid=$1 AND expire>now()
      AND NOT EXISTS(SELECT 1 FROM auth.session_revocations WHERE sid=$1)`,[sid]).then(r=>cb(null,r.rows[0]?.sess??null),e=>cb(e));
  }
  set(sid:string,data:Session,cb:(err?:any)=>void){void this.write(sid,data).then(()=>cb(),cb);}
  destroy(sid:string,cb:(err?:any)=>void){void this.write(sid,null).then(()=>cb(),cb);}
  private async write(sid:string,data:Session|null){
    await transaction(this.pool,async db=>{
      if(data?.p1?.login) await lockPersons(db,[data.p1.login.personId]);
      await db.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[`p1-session:${sid}`]);
      if(!data){
        await db.query('INSERT INTO auth.session_revocations(sid) VALUES($1) ON CONFLICT DO NOTHING',[sid]);
        await db.query('DELETE FROM auth.sessions WHERE sid=$1',[sid]);return;
      }
      if((await db.query('SELECT 1 FROM auth.session_revocations WHERE sid=$1',[sid])).rowCount) throw new AppError(401,'session_revoked');
      const state=data.p1; if(!state)return;
      if(state.login){
        const p=(await db.query('SELECT * FROM business.principals WHERE account_id=$1',[state.login.accountId])).rows[0];
        if(!p?.enabled||p.person_id!==state.login.personId||p.auth_version!==state.login.authVersion||!await canSignIn(db,p.person_id,p.business_role))throw new AppError(401,'session_revoked');
      }
      const expire=state.login?Math.min(state.login.startedAt+ABSOLUTE_MS,state.login.activeAt+IDLE_MS):state.createdAt+PRELOGIN_MS;
      if(expire<=Date.now())throw new AppError(401,'session_expired');
      await db.query(`INSERT INTO auth.sessions(sid,sess,expire) VALUES($1,$2,$3)
        ON CONFLICT(sid) DO UPDATE SET sess=EXCLUDED.sess,expire=EXCLUDED.expire`,[sid,JSON.stringify(data),new Date(expire)]);
    });
  }
}

export async function registerAuth(app:FastifyInstance,pool:Pool,config:AppConfig){
  const dummyHash=await hashPassword(temporaryPassword());
  const cookieName=config.mode==='production'?'__Host-p1-session':'p1-session';
  await app.register(cookie);
  await app.register(session,{secret:config.sessionSecret,cookieName,
    cookie:{httpOnly:true,secure:config.mode==='production',sameSite:'lax',path:'/',maxAge:ABSOLUTE_MS},
    rolling:false,saveUninitialized:false,store:new PgSessions(pool)});
  const origin=(request:FastifyRequest)=>{if(request.headers.origin!==config.origin)throw new AppError(403,'invalid_origin');};
  const csrf=(request:FastifyRequest)=>{origin(request);if(!request.session.p1||!constantEqual(request.headers['x-csrf-token'],request.session.p1.csrf))throw new AppError(403,'invalid_csrf');};
  const readIdentity=async(request:FastifyRequest,allowPasswordChange=false)=>{
    const login=request.session.p1?.login,now=Date.now();
    if(!login||now<login.startedAt||now<login.activeAt||now-login.activeAt>=IDLE_MS||now-login.startedAt>=ABSOLUTE_MS){
      if(login)await request.session.destroy();throw new AppError(401,'session_expired');
    }
    const row=(await pool.query(`SELECT a.*,p.display_name,p.business_role,p.version AS person_version,p.enabled AS person_enabled FROM auth.accounts a
      JOIN auth.people p ON p.id=a.person_id WHERE a.id=$1`,[login.accountId])).rows[0];
    if(!row||!row.enabled||!row.person_enabled||row.session_epoch!==login.authVersion||row.person_id!==login.personId||!await canSignIn(pool,row.person_id,row.business_role)||
      (row.must_change&&(!row.password_expires_at||new Date(row.password_expires_at).getTime()<=now))){
      await request.session.destroy();throw new AppError(401,'identity_revoked');
    }
    if(row.must_change&&!allowPasswordChange)throw new AppError(403,'password_change_required');
    return {login,row};
  };
  const requireSession=async(request:FastifyRequest):Promise<Actor>=>({...(await readIdentity(request)).login,
    sessionKey:createHash('sha256').update(request.session.sessionId).digest('hex')});
  const checkWrite=async(request:FastifyRequest)=>{csrf(request);return requireSession(request);};
  const snapshot=async(request:FastifyRequest)=>{
    const {login,row}=await readIdentity(request,true);
    const actions=row.must_change?[]:await transaction(pool,async db=>{
      await assertActor(db,login);
      const grants=(await db.query('SELECT DISTINCT action FROM business.access_grants WHERE person_id=$1 AND NOT revoked AND case_id IS NULL',[login.personId])).rows.map(r=>r.action as string);
      const create=await canCreateCase(db,login);
      return grants.filter(action=>(row.business_role==='BCO'||(TECHNICAL_ACTIONS as readonly string[]).includes(action))&&(action!=='case:create'||create));
    });
    return {authenticated:true,csrf:request.session.p1!.csrf,user:{accountId:row.id,personId:row.person_id,username:row.username,displayName:row.display_name,businessRole:row.business_role,personVersion:row.person_version,mustChangePassword:row.must_change},allowed_actions:actions,
      idleExpiresAt:new Date(login.activeAt+IDLE_MS).toISOString(),absoluteExpiresAt:new Date(login.startedAt+ABSOLUTE_MS).toISOString()};
  };
  app.get('/api/auth/session',async request=>{
    if(request.session.p1?.login)return snapshot(request);
    if(!request.session.p1||Date.now()-request.session.p1.createdAt>=PRELOGIN_MS){
      await request.session.regenerate();request.session.p1={csrf:randomBytes(32).toString('base64url'),createdAt:Date.now()};await request.session.save();
    }
    return {authenticated:false,csrf:request.session.p1.csrf,allowed_actions:[]};
  });
  app.post('/api/auth/login',async request=>{
    csrf(request);
    if(Date.now()-(request.session.p1?.createdAt??0)>=PRELOGIN_MS)throw new AppError(403,'csrf_expired');
    const input=z.object({username:z.string().trim().min(1).max(100),password:z.string().min(1).max(200)}).strict().parse(request.body);
    const keys=[`ip:${request.ip}`,`user:${input.username.toLowerCase()}`].map(v=>createHash('sha256').update(v).digest('hex')).sort();
    const limited=await transaction(pool,async db=>{
      let limited=false;
      for(const key of keys){const r=await db.query(`INSERT INTO auth.login_limits(limit_key,attempts,expires_at) VALUES($1,1,now()+interval '15 minutes')
        ON CONFLICT(limit_key) DO UPDATE SET attempts=CASE WHEN auth.login_limits.expires_at<=now() THEN 1 ELSE auth.login_limits.attempts+1 END,
        expires_at=CASE WHEN auth.login_limits.expires_at<=now() THEN now()+interval '15 minutes' ELSE auth.login_limits.expires_at END RETURNING attempts`,[key]);
        if(r.rows[0].attempts>20)limited=true;}
      return limited;
    });
    if(limited){await audit(pool,{action:'auth.login',result:'rate_limited'});throw new AppError(429,'login_rate_limited');}
    const row=(await pool.query(`SELECT a.*,p.enabled AS person_enabled,p.business_role FROM auth.accounts a JOIN auth.people p ON p.id=a.person_id WHERE username=$1`,[input.username.toLowerCase()])).rows[0];
    const correct=await argon2.verify(row?.password_hash??dummyHash,input.password);
    if(!row?.enabled||!row.person_enabled||!correct||!await canSignIn(pool,row.person_id,row.business_role)||(row.must_change&&(!row.password_expires_at||new Date(row.password_expires_at).getTime()<=Date.now()))){
      await audit(pool,{action:'auth.login',result:'denied'});throw new AppError(401,'invalid_credentials');
    }
    await request.session.regenerate();
    request.session.p1={csrf:randomBytes(32).toString('base64url'),createdAt:Date.now(),login:{accountId:row.id,personId:row.person_id,authVersion:row.session_epoch,startedAt:Date.now(),activeAt:Date.now()}};
    await request.session.save();await audit(pool,{actorId:row.id,action:'auth.login'});return snapshot(request);
  });
  app.post('/api/auth/logout',async(request,reply)=>{
    csrf(request);const {login}=await readIdentity(request,true);await request.session.destroy();
    reply.clearCookie(cookieName,{path:'/'});await audit(pool,{actorId:login.accountId,action:'auth.logout'});return {authenticated:false};
  });
  app.post('/api/auth/password/change',async(request,reply)=>{
    csrf(request);const {login}=await readIdentity(request,true);
    const input=z.object({currentPassword:z.string().min(1).max(200),newPassword:passwordSchema}).strict().parse(request.body);
    if(input.currentPassword===input.newPassword)throw new AppError(422,'password_unchanged');
    const passwordHash=await hashPassword(input.newPassword);
    await transaction(pool,async db=>{
      await lockPersons(db,[login.personId]);const row=(await db.query('SELECT * FROM auth.accounts WHERE id=$1 FOR UPDATE',[login.accountId])).rows[0];
      if(!row?.enabled||row.session_epoch!==login.authVersion)throw new AppError(401,'identity_revoked');
      if(!await argon2.verify(row.password_hash,input.currentPassword))throw new AppError(403,'current_password_invalid');
      await db.query('UPDATE auth.accounts SET password_hash=$2,must_change=false,password_expires_at=NULL WHERE id=$1',[row.id,passwordHash]);
      await audit(db,{actorId:row.id,action:'auth.password_changed'});
    });
    await request.session.destroy();reply.clearCookie(cookieName,{path:'/'});return {authenticated:false,loginRequired:true};
  });
  app.post('/api/auth/session/activity',async request=>{
    csrf(request);const {login}=await readIdentity(request,true);
    if(Date.now()-login.activeAt>=10_000){request.session.p1!.login={...login,activeAt:Date.now()};await request.session.save();}
    return {idleExpiresAt:new Date(request.session.p1!.login!.activeAt+IDLE_MS).toISOString()};
  });
  const cleanup=setInterval(()=>{void transaction(pool,async db=>{
    await db.query('DELETE FROM auth.sessions WHERE sid IN (SELECT sid FROM auth.sessions WHERE expire<now() ORDER BY expire LIMIT 1000)');
    await db.query("DELETE FROM auth.session_revocations WHERE sid IN (SELECT sid FROM auth.session_revocations WHERE revoked_at<now()-interval '9 hours' ORDER BY revoked_at LIMIT 1000)");
    await db.query('DELETE FROM auth.login_limits WHERE limit_key IN (SELECT limit_key FROM auth.login_limits WHERE expires_at<now() ORDER BY expires_at LIMIT 1000)');
  }).catch(()=>undefined);},60_000);cleanup.unref();app.addHook('onClose',async()=>clearInterval(cleanup));
  return {requireSession,checkWrite};
}
export type Auth=Awaited<ReturnType<typeof registerAuth>>;

export async function registerAdministration(app:FastifyInstance,pool:Pool,auth:Auth){
  const reason=z.string().trim().min(1).max(500),id=z.uuid();
  const businessRole=z.literal('BCO').nullable();
  const accountView=(r:any)=>({id:r.id,personId:r.person_id,username:r.username,displayName:r.display_name,businessRole:r.business_role,personVersion:r.person_version,enabled:r.enabled,mustChangePassword:r.must_change,version:r.version});
  app.get('/api/admin/accounts',async request=>transaction(pool,async db=>{
    const actor=await auth.requireSession(request);await requireGrant(db,actor,'account:manage');
    return {items:(await db.query('SELECT a.*,p.display_name,p.business_role,p.version AS person_version FROM auth.accounts a JOIN auth.people p ON p.id=a.person_id ORDER BY a.created_at DESC LIMIT 500')).rows.map(accountView)};
  }));
  app.get('/api/admin/people',async request=>transaction(pool,async db=>{
    const actor=await auth.requireSession(request);await assertActor(db,actor);
    if(!await hasGrant(db,actor.personId,'account:manage')&&!await hasGrant(db,actor.personId,'permission:manage'))throw new AppError(403,'permission_denied');
    return {items:(await db.query('SELECT id,display_name AS "displayName",business_role AS "businessRole",version,enabled FROM auth.people ORDER BY display_name LIMIT 500')).rows};
  }));
  app.post('/api/admin/people/:id/business-role',async request=>{
    const actor=await auth.checkWrite(request),personId=id.parse((request.params as any).id),input=z.object({businessRole,expectedVersion:z.number().int().positive(),reason}).strict().parse(request.body);
    return transaction(pool,async db=>{
      await lockPersons(db,[actor.personId,personId]);await requireGrant(db,actor,'account:manage');
      const person=(await db.query('SELECT * FROM auth.people WHERE id=$1 FOR UPDATE',[personId])).rows[0];
      if(!person)throw new AppError(404,'person_not_found');
      // Historical RM identity is retired. Role editing must not bypass the
      // account creation, reactivation and grant guards through an intermediate role.
      if(person.business_role==='RM')throw new AppError(422,'external_role_account_forbidden');
      if(person.version!==input.expectedVersion)throw new AppError(409,'stale_revision');
      const changed=person.business_role!==input.businessRole;
      const updated=changed?(await db.query('UPDATE auth.people SET business_role=$2 WHERE id=$1 RETURNING *',[personId,input.businessRole])).rows[0]:person;
      if(changed)await audit(db,{actorId:actor.accountId,targetId:personId,action:'person.business_role_changed',details:{previousBusinessRole:person.business_role??'unconfirmed',businessRole:input.businessRole??'unconfirmed',personVersion:updated.version,reason:input.reason}});
      return {person:{id:personId,displayName:updated.display_name,businessRole:updated.business_role,enabled:updated.enabled,version:updated.version},sessionsRevoked:changed};
    });
  });
  app.post('/api/admin/accounts',async request=>{
    const actor=await auth.checkWrite(request),input=z.object({username:z.string().trim().toLowerCase().regex(/^[a-z0-9][a-z0-9._@-]{2,99}$/),displayName:z.string().trim().min(1).max(100),personId:id.optional(),businessRole:businessRole.optional(),reason}).strict().parse(request.body);
    const password=temporaryPassword(),hash=await hashPassword(password),personId=input.personId??randomUUID(),accountId=randomUUID(),expiresAt=new Date(Date.now()+24*60*60_000).toISOString();
    return transaction(pool,async db=>{
      await lockPersons(db,[actor.personId,personId]);await requireGrant(db,actor,'account:manage');
      if(input.personId){
        const person=(await db.query('SELECT business_role FROM auth.people WHERE id=$1 AND enabled',[personId])).rows[0];
        if(!person)throw new AppError(422,'person_not_available');
        if(person.business_role==='RM')throw new AppError(422,'external_role_account_forbidden');
        if(input.businessRole!==undefined&&input.businessRole!==person.business_role)throw new AppError(422,'person_role_change_requires_explicit_action');
      }else await db.query('INSERT INTO auth.people(id,display_name,business_role) VALUES($1,$2,$3)',[personId,input.displayName,input.businessRole??null]);
      if((await db.query('SELECT 1 FROM auth.accounts WHERE username=$1',[input.username])).rowCount)throw new AppError(409,'username_exists');
      const row=(await db.query(`INSERT INTO auth.accounts(id,person_id,username,password_hash,password_expires_at) VALUES($1,$2,$3,$4,$5) RETURNING *`,[accountId,personId,input.username,hash,expiresAt])).rows[0];
      const person=(await db.query('SELECT display_name,business_role,version AS person_version FROM auth.people WHERE id=$1',[personId])).rows[0];
      await audit(db,{actorId:actor.accountId,targetId:accountId,action:'account.created',details:{personId,businessRole:person.business_role??'unconfirmed',reason:input.reason}});
      return {account:accountView({...row,...person}),temporaryPassword:password,expiresAt};
    });
  });
  for(const command of ['disable','enable','reset'] as const)app.post(`/api/admin/accounts/:id/${command}`,async request=>{
    const actor=await auth.checkWrite(request),target=id.parse((request.params as any).id),input=z.object({expectedVersion:z.number().int().positive(),reason}).strict().parse(request.body);
    const password=command==='reset'?temporaryPassword():null,hash=password?await hashPassword(password):null,expiresAt=new Date(Date.now()+24*60*60_000).toISOString();
    return transaction(pool,async db=>{
      const person=(await db.query('SELECT person_id FROM auth.accounts WHERE id=$1',[target])).rows[0]?.person_id;if(!person)throw new AppError(404,'account_not_found');
      await lockPersons(db,[actor.personId,person]);await requireGrant(db,actor,'account:manage');
      const row=(await db.query('SELECT * FROM auth.accounts WHERE id=$1 FOR UPDATE',[target])).rows[0];
      if(row.version!==input.expectedVersion)throw new AppError(409,'stale_revision');
      const targetPerson=(await db.query('SELECT business_role FROM auth.people WHERE id=$1',[person])).rows[0];
      if(command!=='disable'&&targetPerson?.business_role==='RM')throw new AppError(422,'external_role_account_forbidden');
      if(target===actor.accountId&&command==='disable')throw new AppError(409,'cannot_disable_self');
      const updated=command==='reset'?await db.query('UPDATE auth.accounts SET password_hash=$2,must_change=true,password_expires_at=$3 WHERE id=$1 RETURNING *',[target,hash,expiresAt]):await db.query('UPDATE auth.accounts SET enabled=$2 WHERE id=$1 RETURNING *',[target,command==='enable']);
      await audit(db,{actorId:actor.accountId,targetId:target,action:`account.${command}`,details:{reason:input.reason}});
      const personDetails=(await db.query('SELECT display_name,business_role,version AS person_version FROM auth.people WHERE id=$1',[person])).rows[0];
      return {account:accountView({...updated.rows[0],...personDetails}),...(password?{temporaryPassword:password,expiresAt}:{})};
    });
  });
  app.get('/api/admin/access-grants',async request=>transaction(pool,async db=>{
    const actor=await auth.requireSession(request);await requireGrant(db,actor,'permission:manage');
    return {items:(await db.query('SELECT id,person_id AS "personId",action,case_id AS "caseId",created_at AS "createdAt" FROM business.access_grants WHERE NOT revoked ORDER BY created_at DESC LIMIT 1000')).rows};
  }));
  app.post('/api/admin/access-grants',async request=>{
    const actor=await auth.checkWrite(request),input=z.object({personId:id,action:z.enum(ACTIONS),caseId:id.nullable().optional(),reason}).strict().parse(request.body);
    if(input.caseId&&!['case:read','case:assign','case:confirm-scenario','maker','material:upload','evidence:read','document:parse','document:translate','document:classify','document:authorize','report:read','report:generate','report:export','review:analyze','review:formal','case:close','case:configure','case:start','material:adopt','field:correct','finding:decide','checker','checker:read','checker:comment','checker:confirm','checker:correct','maker:submit','consultation:record','exception:decide'].includes(input.action))throw new AppError(422,'invalid_grant_scope');
    return transaction(pool,async db=>{
      await lockPersons(db,[actor.personId,input.personId]);await requireGrant(db,actor,'permission:manage');
      if(!(await db.query('SELECT 1 FROM business.grant_authorities WHERE person_id=$1 AND action=$2 AND (case_id IS NULL OR case_id=$3::uuid)',[actor.personId,input.action,input.caseId??null])).rowCount)throw new AppError(403,'grant_scope_denied');
      const targetPerson=(await db.query('SELECT business_role FROM auth.people WHERE id=$1 AND enabled',[input.personId])).rows[0];
      if(!targetPerson)throw new AppError(422,'person_not_available');
      if(targetPerson.business_role==='RM'||targetPerson.business_role!=='BCO'&&!(TECHNICAL_ACTIONS as readonly string[]).includes(input.action))throw new AppError(422,'business_grant_recipient_invalid');
      if(input.caseId&&!(await db.query('SELECT 1 FROM business.cases WHERE id=$1',[input.caseId])).rowCount)throw new AppError(404,'case_not_found');
      const grantId=randomUUID();const r=await db.query('INSERT INTO business.access_grants(id,person_id,action,case_id,created_by) VALUES($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING RETURNING id',[grantId,input.personId,input.action,input.caseId??null,actor.accountId]);
      if(input.action==='permission:manage'&&input.personId!==actor.personId&&r.rowCount){
        await db.query('DELETE FROM business.grant_authorities WHERE person_id=$1',[input.personId]);
        await db.query('INSERT INTO business.grant_authorities(person_id,action,case_id) SELECT $1,action,case_id FROM business.grant_authorities WHERE person_id=$2',[input.personId,actor.personId]);
      }
      await audit(db,{actorId:actor.accountId,targetId:input.personId,action:'permission.granted',details:{grantAction:input.action,caseId:input.caseId??'global',reason:input.reason}});
      return {id:r.rows[0]?.id??(await db.query('SELECT id FROM business.access_grants WHERE person_id=$1 AND action=$2 AND case_id IS NOT DISTINCT FROM $3::uuid AND NOT revoked',[input.personId,input.action,input.caseId??null])).rows[0].id};
    });
  });
  app.post('/api/admin/access-grants/:id/revoke',async request=>{
    const actor=await auth.checkWrite(request),grantId=id.parse((request.params as any).id),input=z.object({reason}).strict().parse(request.body);
    return transaction(pool,async db=>{
      const grant=(await db.query('SELECT * FROM business.access_grants WHERE id=$1',[grantId])).rows[0];if(!grant)throw new AppError(404,'grant_not_found');
      await lockPersons(db,[actor.personId,grant.person_id]);await requireGrant(db,actor,'permission:manage');
      if(!(await db.query('SELECT 1 FROM business.grant_authorities WHERE person_id=$1 AND action=$2 AND (case_id IS NULL OR case_id=$3::uuid)',[actor.personId,grant.action,grant.case_id])).rowCount)throw new AppError(403,'grant_scope_denied');
      if(grant.person_id===actor.personId&&grant.action==='permission:manage')throw new AppError(409,'cannot_revoke_own_permission_management');
      const changed=await db.query('UPDATE business.access_grants SET revoked=true WHERE id=$1 AND NOT revoked RETURNING id',[grantId]);
      if(changed.rowCount)await db.query('UPDATE auth.accounts SET session_epoch=session_epoch+1 WHERE person_id=$1',[grant.person_id]);
      await audit(db,{actorId:actor.accountId,targetId:grantId,action:'permission.revoked',details:{reason:input.reason}});return {revoked:true};
    });
  });
  app.get('/api/admin/auth-events',async request=>transaction(pool,async db=>{
    const actor=await auth.requireSession(request);await requireGrant(db,actor,'audit:read');
    return {items:(await db.query('SELECT id,action,result,created_at AS "createdAt",actor_id AS "actorId",target_id AS "targetId" FROM business.audit_events ORDER BY created_at DESC LIMIT 300')).rows};
  }));
}
