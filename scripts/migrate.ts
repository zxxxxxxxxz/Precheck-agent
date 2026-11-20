import { readFile } from 'node:fs/promises';
import { PostgresSaver } from '@langchain/langgraph-checkpoint-postgres';
import { p0Environment,p0Pool,verifyInstance,logEvent } from '@hsbc/server/experiments/p0/persistence/environment';

export async function migrate() {
  const env=p0Environment();const pool=p0Pool(env.MIGRATION_DATABASE_URL);
  try {
    await verifyInstance(pool,env.P0_INSTANCE_ID);
    for(const file of ['packages/server/src/experiments/p0/auth/migration.sql','packages/server/src/experiments/p0/persistence/migration.sql']) {
      await pool.query(await readFile(file,'utf8'));
    }
    await new PostgresSaver(pool,undefined,{schema:'checkpoint'}).setup();
    logEvent('p0_migration_complete');
  } finally {await pool.end();}
}
if(process.argv[1]?.endsWith('migrate.ts')) await migrate();
