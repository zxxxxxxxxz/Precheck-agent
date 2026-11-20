import pg from 'pg';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

// Runtime-only script stays outside esbuild bundles so its import.meta root is
// stable. Every command is launched from the repository root.
const { loadP0Environment, getP0Paths }=await import(pathToFileURL(resolve('infra/dev/p0-native.mjs')).href) as {
  loadP0Environment:()=>Record<string,string>;
  getP0Paths:()=>{instanceName?:string;localDir:string;envFile:string;markerFile:string;postgresDir:string;redisDir:string};
};

export function p0Environment():Record<string,string> {
  if (process.versions.node.split('.')[0] !== '24') throw new Error('node24_required');
  return loadP0Environment();
}
export function p0Paths() { return getP0Paths(); }
export function p0Pool(url:string) { return new pg.Pool({ connectionString:url, max:8, connectionTimeoutMillis:5_000, idleTimeoutMillis:5_000 }); }
export async function verifyInstance(pool:pg.Pool,instanceId:string) {
  const r=await pool.query('SELECT instance_id FROM p0_guard.instance');
  if(r.rows.length!==1||r.rows[0].instance_id!==instanceId)throw new Error('p0_database_identity_mismatch');
}
export function logEvent(code:string, ids:Record<string,string|number|boolean>={}) {
  const allowed=new Set(['taskId','workId','state','durationMs','count','port']);
  console.log(JSON.stringify({code,...Object.fromEntries(Object.entries(ids).filter(([key])=>allowed.has(key)))}));
}
