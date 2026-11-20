import { createHash, randomUUID } from 'node:crypto';
import pg from 'pg';
import type { AgentTaskPort, AgentTaskRecord, AgentTaskState, ToolPort } from '../protocols/ports.js';
import type { AuthorizedScope } from '@hsbc/contracts/identity';
import { AccessDenied } from '../auth/access.js';

export interface Execution { taskId: string; workId: string; kind: 'workflow' | 'document'; owner: string; epoch: number }
/** Constructed from the authenticated server session, never accepted in the HTTP body. */
export interface DecisionAccountIdentity { accountId: string; personId: string; sessionEpoch: number }
export interface TaskRow { id: string; case_id: string; revision: number; scope: AuthorizedScope; input: string; state: AgentTaskState; cancel_requested: boolean }
export type QueryClient = Pick<pg.PoolClient, 'query'>;
const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');

export async function transaction<T>(pool: pg.Pool, fn: (client: pg.PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try { await client.query('BEGIN'); const result = await fn(client); await client.query('COMMIT'); return result; }
  catch (error) { await client.query('ROLLBACK'); throw error; }
  finally { client.release(); }
}
export async function threadLock(c: QueryClient, taskId: string) {
  await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [taskId]);
}
function record(row: Record<string, any>): AgentTaskRecord {
  return { id: row.id, contextId: row.context_id, caseId: row.case_id, revision: row.revision,
    state: row.state, cancelRequested: row.cancel_requested, updatedAt: new Date(row.updated_at).toISOString(), artifactRefs: row.artifact_refs };
}
async function project(c: QueryClient, id: string) {
  await c.query(`INSERT INTO a2a.task_projection(task_id,state) SELECT id,state FROM business.agent_tasks WHERE id=$1
    ON CONFLICT(task_id) DO UPDATE SET state=EXCLUDED.state,revision=a2a.task_projection.revision+1,updated_at=clock_timestamp()`, [id]);
}
async function enqueue(c: QueryClient, taskId: string, kind: string, key: string) {
  const work = await c.query(`INSERT INTO business.work_items(id,task_id,kind,dedup_key) VALUES($1,$2,$3,$4)
    ON CONFLICT(dedup_key) DO UPDATE SET dedup_key=EXCLUDED.dedup_key RETURNING id`, [randomUUID(), taskId, kind, key]);
  await c.query('INSERT INTO business.outbox(work_id) VALUES($1) ON CONFLICT DO NOTHING', [work.rows[0].id]);
  return work.rows[0].id as string;
}
export class P0Store implements AgentTaskPort, ToolPort {
  constructor(readonly pool: pg.Pool) {}

  async assertScope(c: QueryClient, scope: AuthorizedScope) {
    const r = await c.query('SELECT revision FROM business.p0_cases WHERE id=$1 FOR SHARE', [scope.caseId]);
    if (r.rows[0]?.revision !== scope.revision) throw new Error('stale_revision');
    // Authorization is checked by transport before every access. Recheck its
    // authoritative version inside the write transaction as well.
    const d = await c.query(`SELECT 1 FROM business.delegations d JOIN business.service_principals s ON s.id=d.service_id
      WHERE d.id=$1 AND d.service_id=$2 AND d.case_id=$3 AND d.revision=$4 AND d.authorization_version=$5
      AND NOT d.revoked AND d.expires_at>clock_timestamp() AND s.enabled FOR SHARE OF d,s`,
      [scope.delegationId, scope.serviceId, scope.caseId, scope.revision, scope.authorizationVersion]);
    if (!d.rowCount) throw new Error('delegation_revoked');
  }
  async seedCase(id = 'p0-case', revision = 1) {
    await this.pool.query('INSERT INTO business.p0_cases(id,revision) VALUES($1,$2) ON CONFLICT(id) DO NOTHING', [id,revision]);
  }
  async submit(input: { messageId: string; scope: AuthorizedScope; input: string }) {
    return transaction(this.pool, async c => {
      await this.assertScope(c,input.scope);
      const hash=digest({input:input.input,scope:input.scope});
      const id=randomUUID();
      const inserted = await c.query(`INSERT INTO business.agent_tasks(id,message_id,context_id,case_id,revision,scope,input,input_hash)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT(case_id,revision,message_id) DO NOTHING RETURNING *`,
        [id,input.messageId,randomUUID(),input.scope.caseId,input.scope.revision,input.scope,input.input,hash]);
      const row=inserted.rows[0] ?? (await c.query('SELECT * FROM business.agent_tasks WHERE case_id=$1 AND revision=$2 AND message_id=$3', [input.scope.caseId,input.scope.revision,input.messageId])).rows[0];
      if(row.input_hash!==hash) throw new Error('idempotency_conflict');
      await c.query('INSERT INTO business.thread_owners(task_id) VALUES($1) ON CONFLICT DO NOTHING',[row.id]);
      await enqueue(c,row.id,'workflow',`start:${row.id}`); await project(c,row.id); return record(row);
    });
  }
  async get(id: string, scope: AuthorizedScope) {
    return transaction(this.pool,async c=>{ await this.assertScope(c,scope);
      const r=await c.query('SELECT * FROM business.agent_tasks WHERE id=$1 AND case_id=$2 AND revision=$3',[id,scope.caseId,scope.revision]);
      return r.rows[0]?record(r.rows[0]):null;
    });
  }
  async requestCancel(id: string, scope: AuthorizedScope) {
    return transaction(this.pool,async c=>{await threadLock(c,id); await this.assertScope(c,scope);
      const r=await c.query(`UPDATE business.agent_tasks SET cancel_requested=true,updated_at=clock_timestamp()
        WHERE id=$1 AND case_id=$2 AND revision=$3 AND state NOT IN ('completed','failed','canceled') RETURNING *`,[id,scope.caseId,scope.revision]);
      if(!r.rows[0]) {const current=await c.query('SELECT * FROM business.agent_tasks WHERE id=$1 AND case_id=$2 AND revision=$3',[id,scope.caseId,scope.revision]); return current.rows[0]?record(current.rows[0]):null;}
      await enqueue(c,id,'workflow',`cancel:${id}`); return record(r.rows[0]);
    });
  }
  async pendingWork() {
    return (await this.pool.query(`SELECT w.id,w.task_id,w.kind FROM business.work_items w
      LEFT JOIN business.thread_owners o ON o.task_id=w.task_id
      WHERE w.next_attempt_at<=clock_timestamp() AND (w.state='pending' OR (w.state='running' AND (o.lease_until IS NULL OR o.lease_until<clock_timestamp())))
      ORDER BY w.created_at LIMIT 100`)).rows as {id:string;task_id:string;kind:'workflow'|'document'}[];
  }
  async reconcileInvalidTasks() {
    // Waiting has no active job. Scope changes therefore need a PG scan, not
    // just validation when a (possibly never arriving) human event resumes it.
    const rows=(await this.pool.query(`SELECT t.id FROM business.agent_tasks t
      LEFT JOIN business.p0_cases c ON c.id=t.case_id
      LEFT JOIN business.delegations d ON d.id=t.scope->>'delegationId'
      LEFT JOIN business.service_principals s ON s.id=d.service_id
      WHERE t.state NOT IN ('completed','failed','canceled') AND (t.cancel_requested
        OR c.revision IS DISTINCT FROM t.revision OR d.id IS NULL OR d.revoked
        OR d.expires_at<=clock_timestamp() OR NOT s.enabled
        OR d.authorization_version IS DISTINCT FROM (t.scope->>'authorizationVersion')::integer)
      LIMIT 100`)).rows;
    for(const row of rows)await transaction(this.pool,c=>enqueue(c,row.id,'workflow',`invalidate:${row.id}`));
  }
  async dispatched(workId:string) {await this.pool.query('UPDATE business.outbox SET deliveries=deliveries+1,last_dispatched_at=clock_timestamp() WHERE work_id=$1',[workId]);}
  async claim(taskId:string, workId:string, owner=randomUUID(), leaseMs=30_000, expectedKind?:string):Promise<Execution|null> {
    return transaction(this.pool,async c=>{await threadLock(c,taskId);
      const work=(await c.query('SELECT * FROM business.work_items WHERE id=$1 FOR UPDATE',[workId])).rows[0];
      if(work&&(work.task_id!==taskId||(expectedKind!==undefined&&work.kind!==expectedKind)))throw new Error('work_item_mismatch');
      if(!work||!['pending','running'].includes(work.state))return null;
      const active=await c.query('SELECT 1 FROM business.thread_owners WHERE task_id=$1 AND lease_until>clock_timestamp()',[taskId]);
      if(active.rowCount)return null;
      if(work.attempts>=3) {
        await c.query("UPDATE business.work_items SET state='failed' WHERE id=$1",[workId]);
        await c.query("UPDATE business.agent_tasks SET state='failed',updated_at=clock_timestamp() WHERE id=$1 AND state NOT IN ('completed','failed','canceled')",[taskId]);
        await c.query("UPDATE business.workflow_waits SET phase='closed' WHERE task_id=$1",[taskId]);
        await c.query("UPDATE business.tool_jobs SET state='failed',result=$2 WHERE task_id=$1 AND state='submitted'",[taskId,{error:'retry_budget_exhausted',synthetic:true}]);
        await project(c,taskId);await c.query('INSERT INTO business.recovery_events(task_id,code) VALUES($1,$2)',[taskId,'retry_budget_exhausted']);return null;
      }
      const r=await c.query(`UPDATE business.thread_owners SET owner=$2,epoch=epoch+1,lease_until=clock_timestamp()+($3*interval '1 millisecond')
        WHERE task_id=$1 AND (lease_until IS NULL OR lease_until<clock_timestamp()) RETURNING epoch`,[taskId,owner,leaseMs]);
      if(!r.rowCount) return null;
      await c.query("UPDATE business.work_items SET state='running',attempts=attempts+1,next_attempt_at=clock_timestamp()+interval '1 second' WHERE id=$1",[workId]);
      return {taskId:work.task_id,workId:work.id,kind:work.kind,owner,epoch:Number(r.rows[0].epoch)};
    });
  }
  async owned<T>(e:Execution,fn:(c:pg.PoolClient)=>Promise<T>):Promise<T> {
    return transaction(this.pool,async c=>{await c.query('SELECT checkpoint.assert_owner($1,$2,$3)',[e.taskId,e.owner,e.epoch]);
      const row=(await c.query('SELECT scope FROM business.agent_tasks WHERE id=$1',[e.taskId])).rows[0];
      await this.assertScope(c,row.scope); return fn(c);
    });
  }
  async renew(e:Execution) {await this.owned(e,c=>c.query("UPDATE business.thread_owners SET lease_until=clock_timestamp()+interval '30 seconds' WHERE task_id=$1",[e.taskId]));}
  async release(e:Execution) {await this.pool.query('UPDATE business.thread_owners SET owner=NULL,lease_until=NULL WHERE task_id=$1 AND owner=$2 AND epoch=$3',[e.taskId,e.owner,e.epoch]);}
  async task(id:string):Promise<TaskRow> {const r=await this.pool.query('SELECT * FROM business.agent_tasks WHERE id=$1',[id]); if(!r.rows[0]) throw new Error('task_not_found');return r.rows[0];}
  async working(e:Execution) {await this.owned(e,async c=>{await c.query("UPDATE business.agent_tasks SET state='working',updated_at=clock_timestamp() WHERE id=$1",[e.taskId]);await project(c,e.taskId);});}
  async prepareWait(e:Execution) {
    return this.owned(e,async c=>{
      const r=await c.query(`INSERT INTO business.workflow_waits(task_id,id) VALUES($1,$2)
        ON CONFLICT(task_id) DO UPDATE SET task_id=EXCLUDED.task_id RETURNING id`,[e.taskId,randomUUID()]); return r.rows[0].id as string;
    });
  }
  async arm(e:Execution,workId:string,interruptId:string) {
    await this.owned(e,async c=>{
      await c.query("UPDATE business.workflow_waits SET phase='armed',interrupt_id=$2 WHERE task_id=$1",[e.taskId,interruptId]);
      await c.query("UPDATE business.agent_tasks SET state='input-required',updated_at=clock_timestamp() WHERE id=$1",[e.taskId]);
      await c.query("UPDATE business.work_items SET state='waiting' WHERE id=$1",[workId]);
      await project(c,e.taskId);
      const inbox=await c.query('SELECT id FROM business.inbox WHERE task_id=$1 AND NOT accepted',[e.taskId]);
      for(const event of inbox.rows) await enqueue(c,e.taskId,'workflow',`resume:${event.id}`);
    });
  }
  async decide(input:{waitId:string;accountIdentity:DecisionAccountIdentity;idempotencyKey:string;value:'confirm'|'reject';reason:string}) {
    return transaction(this.pool,async c=>{
      const initial=(await c.query('SELECT task_id FROM business.workflow_waits WHERE id=$1',[input.waitId])).rows[0];
      if(!initial)throw new Error('wait_not_found');
      await threadLock(c,initial.task_id);
      // Human decisions run with the API identity. The Worker must never gain
      // auth schema access. This lock serializes the decision with disable,
      // person remapping and session-epoch changes through the same commit.
      const identity=input.accountIdentity;
      if(!identity||!Number.isSafeInteger(identity.sessionEpoch))throw new AccessDenied('account_identity_required');
      const account=(await c.query('SELECT person_id,enabled,session_epoch FROM auth.accounts WHERE id=$1 AND synthetic=true FOR SHARE',[identity.accountId])).rows[0];
      if(!account?.enabled||account.person_id!==identity.personId||account.session_epoch!==identity.sessionEpoch)throw new AccessDenied('account_revoked');
      const personId=identity.personId;
      const wait=(await c.query('SELECT * FROM business.workflow_waits WHERE id=$1',[input.waitId])).rows[0];
      if(!wait || personId!==wait.assigned_person || personId==='maker-person') throw new AccessDenied('forbidden_person');
      const task=(await c.query('SELECT * FROM business.agent_tasks WHERE id=$1',[wait.task_id])).rows[0];await this.assertScope(c,task.scope);
      const old=(await c.query('SELECT * FROM business.human_decisions WHERE wait_id=$1',[input.waitId])).rows[0];
      if(old) {if(old.idempotency_key!==input.idempotencyKey||old.actor_person!==personId||old.value!==input.value||old.reason!==input.reason)throw new Error('decision_conflict');return old.id as string;}
      if(task.cancel_requested||['completed','failed','canceled'].includes(task.state)) throw new Error('task_closed');
      const id=randomUUID();await c.query('INSERT INTO business.human_decisions(id,wait_id,actor_person,idempotency_key,value,reason) VALUES($1,$2,$3,$4,$5,$6)',[id,input.waitId,personId,input.idempotencyKey,input.value,input.reason]);
      await c.query('INSERT INTO business.inbox(id,task_id) VALUES($1,$2)',[id,wait.task_id]);
      if(wait.phase==='armed')await enqueue(c,wait.task_id,'workflow',`resume:${id}`);return id;
    });
  }
  async pendingDecision(taskId:string) {
    const r=await this.pool.query(`SELECT d.id,d.value FROM business.inbox i JOIN business.human_decisions d ON d.id=i.id WHERE i.task_id=$1 AND NOT i.accepted`,[taskId]);return r.rows[0] as {id:string;value:string}|undefined;
  }
  async effect(e:Execution,decisionId:string) {
    await this.owned(e,async c=>{
      const d=(await c.query(`SELECT d.value FROM business.human_decisions d JOIN business.workflow_waits w ON w.id=d.wait_id WHERE d.id=$1 AND w.task_id=$2`,[decisionId,e.taskId])).rows[0];if(!d)throw new Error('invalid_decision');
      await c.query('INSERT INTO business.p0_effects(task_id,decision_id,value) VALUES($1,$2,$3) ON CONFLICT(task_id) DO NOTHING',[e.taskId,decisionId,d.value]);
    });
  }
  async finish(e:Execution,workId:string) {
    await this.owned(e,async c=>{
      await c.query("UPDATE business.agent_tasks SET state='completed',artifact_refs=$2,updated_at=clock_timestamp() WHERE id=$1",[e.taskId,JSON.stringify([`p0-effect:${e.taskId}`])]);
      await c.query('UPDATE business.inbox SET accepted=true WHERE task_id=$1',[e.taskId]);
      await c.query("UPDATE business.workflow_waits SET phase='closed' WHERE task_id=$1",[e.taskId]);
      await c.query("UPDATE business.tool_jobs SET state='failed',result=$2 WHERE task_id=$1 AND state='submitted'",[e.taskId,{error:'parent_task_completed',synthetic:true}]);
      await c.query("UPDATE business.work_items SET state='completed' WHERE task_id=$1 AND kind='workflow'",[e.taskId]);await project(c,e.taskId);
    });
  }
  async stopIfInvalid(e:Execution,workId:string):Promise<boolean> {
    return transaction(this.pool,async c=>{await threadLock(c,e.taskId);
      const row=(await c.query(`SELECT t.*,c.revision AS current_revision,o.owner,o.epoch FROM business.agent_tasks t JOIN business.p0_cases c ON c.id=t.case_id JOIN business.thread_owners o ON o.task_id=t.id WHERE t.id=$1`,[e.taskId])).rows[0];
      if(row.owner!==e.owner||Number(row.epoch)!==e.epoch)throw new Error('stale_execution');
      let revoked=false;try {await this.assertScope(c,row.scope);}catch {revoked=true;}
      if(row.cancel_requested||row.revision!==row.current_revision||revoked||['completed','failed','canceled'].includes(row.state)) {
        if(!['completed','failed','canceled'].includes(row.state)) {
          await c.query('UPDATE business.agent_tasks SET state=$2,updated_at=clock_timestamp() WHERE id=$1',[e.taskId,row.cancel_requested?'canceled':'failed']);
          await c.query('INSERT INTO business.recovery_events(task_id,code) VALUES($1,$2)',[e.taskId,row.cancel_requested?'cancel_acknowledged':'scope_invalidated']);await project(c,e.taskId);
        }
        await c.query("UPDATE business.workflow_waits SET phase='closed' WHERE task_id=$1",[e.taskId]);
        await c.query("UPDATE business.tool_jobs SET state=$2,result=$3 WHERE task_id=$1 AND state='submitted'",[e.taskId,row.cancel_requested?'canceled':'failed',{error:'parent_task_closed',synthetic:true}]);
        await c.query("UPDATE business.work_items SET state='completed' WHERE task_id=$1",[e.taskId]);return true;
      }return false;
    });
  }
  async call(name:string,input:any,scope:AuthorizedScope):Promise<Record<string,unknown>> {
    return transaction(this.pool,async c=>{
      await threadLock(c,input.taskId);await this.assertScope(c,scope);const task=await c.query('SELECT state,cancel_requested FROM business.agent_tasks WHERE id=$1 AND case_id=$2 AND revision=$3',[input.taskId,scope.caseId,scope.revision]);if(!task.rowCount)throw new Error('task_not_found');
      if(name==='get_evidence') {if(input.evidenceRef!=='synthetic:evidence:1')throw new Error('evidence_not_found');return {evidenceRef:input.evidenceRef,source:'synthetic',page:1,text:'USD 300,000,000',localizationStatus:'block_only'};}
      if(name==='parse_document') {if(task.rows[0].cancel_requested||['completed','failed','canceled'].includes(task.rows[0].state))throw new Error('task_closed');const id=randomUUID();const r=await c.query(`INSERT INTO business.tool_jobs(id,task_id,case_id,revision,document_version_id,idempotency_key)
        VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(task_id,idempotency_key) DO UPDATE SET idempotency_key=EXCLUDED.idempotency_key RETURNING *`,[id,input.taskId,scope.caseId,scope.revision,input.documentVersionId,input.idempotencyKey]);if(r.rows[0].document_version_id!==input.documentVersionId)throw new Error('idempotency_conflict');await enqueue(c,input.taskId,'document',`tool:${r.rows[0].id}`);return {jobId:r.rows[0].id,state:r.rows[0].state,synthetic:true};}
      if(name==='get_tool_job') {const permission=await c.query("SELECT 1 FROM business.delegations WHERE id=$1 AND 'parse_document'=ANY(actions)",[scope.delegationId]);if(!permission.rowCount)throw new Error('origin_tool_forbidden');const r=await c.query('SELECT id,state,result FROM business.tool_jobs WHERE id=$1 AND task_id=$2 AND case_id=$3 AND revision=$4',[input.jobId,input.taskId,scope.caseId,scope.revision]);if(!r.rows[0])throw new Error('job_not_found');return r.rows[0];}
      throw new Error('tool_not_enabled');
    });
  }
  async runDocument(e:Execution,workId:string) {await this.owned(e,async c=>{
    await c.query(`UPDATE business.tool_jobs SET state='completed',result='{"synthetic":true,"evidenceRefs":["synthetic:evidence:1"]}' WHERE task_id=$1 AND state='submitted'`,[e.taskId]);
    await c.query("UPDATE business.work_items SET state='completed' WHERE id=$1",[workId]);
  });}
}
