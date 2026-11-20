import fs from 'node:fs';

const services = [
  ['ocr', 'http://autodl-3090:16006', '/run/secrets/ocr.token'],
  ['ner', 'http://autodl-3090:16008', '/run/secrets/ner.token'],
  ['qwen', 'https://u334749-95be-0bf1cc76.bjb2.seetacloud.com:8443', '/run/secrets/qwen-api.token'],
];
const results = [];
for (const [service, base, tokenFile] of services) {
  const started = Date.now();
  try {
    const token = fs.readFileSync(tokenFile, 'utf8').trim();
    const unauth = await fetch(base + '/health/ready', {signal: AbortSignal.timeout(8000)});
    const ready = await fetch(base + '/health/ready', {headers: {Authorization: `Bearer ${token}`}, signal: AbortSignal.timeout(15000)});
    results.push({service, unauth_status: unauth.status, ready_status: ready.status, ready: ready.ok,
      auth_enforced: [401, 403].includes(unauth.status), elapsed_ms: Date.now() - started});
  } catch (error) {
    results.push({service, ready: false, error: error.name, elapsed_ms: Date.now() - started});
  }
}
console.log(JSON.stringify({at: new Date().toISOString(), results}));
if (results.some(r => !r.ready || !r.auth_enforced)) process.exitCode = 1;

