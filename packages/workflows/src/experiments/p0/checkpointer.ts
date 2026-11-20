import pg from 'pg';
import { PostgresSaver } from '@langchain/langgraph-checkpoint-postgres';
import type { RunnableConfig } from '@langchain/core/runnables';
import type { Checkpoint,CheckpointMetadata,ChannelVersions,PendingWrite } from '@langchain/langgraph-checkpoint';
import type { Execution } from '@hsbc/server/experiments/p0/persistence/store';

/** PostgresSaver 1.1.0 opens a transaction for both put and putWrites.
 * Intercept that BEGIN on the SAME connection: lock + epoch check + writes
 * remain one transaction. Claim/handover uses this same advisory-lock key.
 * Do not replace this with a preflight query using another pooled connection.
 */
export function fencedPool(pool:pg.Pool,execution:Execution):pg.Pool {
  return new Proxy(pool,{
    get(target,key) {
      if(key==='connect')return async()=>{
        const client=await target.connect();
        return new Proxy(client,{get(c,k){
          if(k==='query')return async(...args:any[])=>{
            const result=await (c.query as any)(...args);
            if(typeof args[0]==='string'&&args[0].trim().toUpperCase()==='BEGIN') {
              await c.query('SELECT checkpoint.assert_owner($1,$2,$3)',[execution.taskId,execution.owner,execution.epoch]);
            }
            return result;
          };
          const value=Reflect.get(c,k);return typeof value==='function'?value.bind(c):value;
        }});
      };
      const value=Reflect.get(target,key);return typeof value==='function'?value.bind(target):value;
    }
  });
}
export class FencedPostgresSaver extends PostgresSaver {
  constructor(pool:pg.Pool,private execution:Execution) {super(fencedPool(pool,execution),undefined,{schema:'checkpoint'});}
  private check(config:RunnableConfig) {if(config.configurable?.thread_id!==this.execution.taskId)throw new Error('checkpoint_thread_mismatch');}
  override put(config:RunnableConfig,checkpoint:Checkpoint,metadata:CheckpointMetadata,versions:ChannelVersions) {
    this.check(config);return super.put(config,checkpoint,metadata,versions);
  }
  override putWrites(config:RunnableConfig,writes:PendingWrite[],taskId:string,taskPath?:string) {
    this.check(config);return super.putWrites(config,writes,taskId,taskPath);
  }
  override async deleteThread(_threadId:string):Promise<void> {throw new Error('runtime_checkpoint_delete_forbidden');}
}
