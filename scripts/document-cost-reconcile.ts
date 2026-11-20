import {readFile} from 'node:fs/promises';
import pg from 'pg';
import {reconcileDocumentCloudCosts} from '@hsbc/server/modules/documents/cloud-cost-reconciliation';

// Read-only by default. Use only the explicitly supplied manifest and database;
// no environment file discovery, model request or broad date-based backfill.
const args=process.argv.slice(2),file=args.find(arg=>arg.startsWith('--manifest='))?.slice(11);
if(!file||args.some(arg=>arg!=='--apply'&&!arg.startsWith('--manifest='))||!process.env.P1_WORKER_DATABASE_URL)throw new Error('document_cost_reconcile_arguments_required');
const pool=new pg.Pool({connectionString:process.env.P1_WORKER_DATABASE_URL,max:1});
try{
  const result=await reconcileDocumentCloudCosts(pool,JSON.parse(await readFile(file,'utf8')),args.includes('--apply'));
  process.stdout.write(JSON.stringify(result,null,2)+'\n');
}catch{
  process.stderr.write('document_cost_reconciliation_failed; credentials and provider data omitted\n');process.exitCode=1;
}finally{await pool.end();}
