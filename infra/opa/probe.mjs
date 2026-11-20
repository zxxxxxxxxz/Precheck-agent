// Synthetic HTTP acceptance checks. Never print credentials or response bodies.
import fs from 'node:fs';
import assert from 'node:assert/strict';

const expected = JSON.parse(fs.readFileSync(process.env.OPA_EXPECTED_FILE || '/expected.json', 'utf8'));
const base = process.env.OPA_BASE_URL || 'http://opa:8181';
const queryToken = process.env.OPA_QUERY_TOKEN;
const probeToken = process.env.OPA_PROBE_TOKEN;
assert(queryToken?.length >= 32 && probeToken?.length >= 32 && queryToken !== probeToken,
  'Two distinct tokens of at least 32 characters are required');

async function request(path, {token = queryToken, method = 'POST', body} = {}) {
  const headers = {'Content-Type': 'application/json'};
  if (token) headers.Authorization = `Bearer ${token}`;
  const response = await fetch(`${base}/${path}`, {
    method, headers, body: method === 'GET' ? undefined : JSON.stringify(body ?? {input: {}}),
    signal: AbortSignal.timeout(5000),
  });
  let document;
  try { document = await response.json(); } catch { document = null; }
  return {status: response.status, document};
}

for (let i = 0; ; i++) {
  try {
    const response = await request('health', {token: probeToken, method: 'GET'});
    assert.equal(response.status, 200);
    break;
  } catch {
    if (i >= 29) throw new Error('OPA did not become healthy within the readiness deadline');
    await new Promise(resolve => setTimeout(resolve, 1000));
  }
}

const loaded = await request('v1/data/hsbc/health/loaded', {token: probeToken});
assert.equal(loaded.status, 200, 'Probe identity must read loaded metadata');
assert.equal(loaded.document?.result?.engine_version, expected.opa_version, 'OPA version differs');
const expectedBundles = Object.fromEntries(expected.releases.map(release =>
  [`hsbc/releases/${release.release_id}`, release.release_id]));
assert.deepEqual(loaded.document?.result?.bundles, expectedBundles, 'Actual loaded bundle revisions differ');

let probes = 0;
for (const release of expected.releases) {
  for (const probe of release.probes) {
    const response = await request(release.decision_path, {body: {input: probe.input}});
    assert.equal(response.status, 200, `Probe HTTP failure: ${release.release_id}/${probe.name}`);
    if (probe.undefined) {
      assert(!Object.hasOwn(response.document ?? {}, 'result'), 'Unknown schema must be undefined');
    } else {
      // JSON objects are unordered; deep comparison must not depend on OPA key order.
      assert.deepEqual(response.document?.result, probe.result,
        `Probe result mismatch: ${release.release_id}/${probe.name}`);
    }
    probes++;
  }
}

const sample = expected.releases[0]?.decision_path || 'v1/data/hsbc/releases/unknown/decision';
const forbidden = [
  [sample, {token: null}],
  [sample, {token: 'invalid'}],
  [sample, {method: 'PUT'}],
  [`${sample}?explain=full`, {}],
  ['v1/data/hsbc/releases/unknown/decision', {}],
  ['v1/data', {}],
  ['v1/query', {body: {query: 'opa.runtime()'}}],
  ['v1/policies', {method: 'GET'}],
  ['v1/policies/forbidden', {method: 'PUT'}],
  ['v1/data/forbidden', {method: 'PUT'}],
  ['v1/data/forbidden', {token: probeToken, method: 'PUT'}],
  ['v1/data/hsbc/health/loaded', {}],
];
for (const [path, options] of forbidden) {
  const response = await request(path, options);
  assert([401, 403].includes(response.status), `Unauthorized operation was not rejected: ${options.method || 'POST'} ${path}`);
}
console.log(JSON.stringify({ok: true, releases: expected.releases.map(r => r.release_id),
  probes, authorization_denials: forbidden.length}));
