#!/usr/bin/env node
/** Read-only public surface smoke. Never logs cookies, bodies, credentials or signs in. */
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';

export async function smoke(origin, fetcher = fetch) {
  const parsed = new URL(origin);
  if (parsed.username || parsed.password || parsed.search || parsed.hash || parsed.pathname !== '/') throw new Error('Use a clean origin');
  if (parsed.protocol !== 'https:' && !(parsed.protocol === 'http:' && ['127.0.0.1', 'localhost'].includes(parsed.hostname))) throw new Error('HTTPS or local loopback origin required');
  const results = [];
  const checks = [
    ['/', [200], 'text/html'],
    ['/api/health/ready', [200], 'application/json'],
    ['/api/cases', [401], 'application/json'],
    ['/api/workbench', [401], 'application/json'],
    ['/api/admin/accounts', [401], 'application/json'],
    ['/api/p0', [404]], ['/api/p0/session', [404]],
    ['/internal', [404]], ['/internal/a2a', [404]], ['/api/internal/agentcards', [404]],
    ['/.well-known/agent-card.json', [404]], ['/agentcards', [404]],
  ];
  for (const [path, statuses, type] of checks) {
    let response;
    try { response = await fetcher(new URL(path, parsed), { redirect: 'manual', signal: AbortSignal.timeout(10000) }); }
    catch { throw new Error(`Smoke network failure: ${path}`); }
    const passed = statuses.includes(response.status) && (!type || response.headers.get('content-type')?.includes(type));
    await response.body?.cancel();
    results.push({ path, status: response.status, passed });
  }
  if (results.some(result => !result.passed)) throw new Error('Public surface smoke failed: ' + results.filter(result => !result.passed).map(result => `${result.path}=${result.status}`).join(', '));
  return { ok: true, checks: results, authentication_scope: 'unauthenticated-only', upload_and_model_calls: false };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    if (process.argv.length !== 4 || process.argv[2] !== '--origin') throw new Error('Usage: p1-smoke.mjs --origin https://hsbc.mse.pub');
    console.log(JSON.stringify(await smoke(process.argv[3])));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
