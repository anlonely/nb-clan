import { authenticatedSession } from './support/authenticated-session.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { fixture, httpFixture, steam, secrets } from './support/v2-public-query/fixture.mjs';
import { grant } from '../server/v2/identity/permissions.js';
const assertClean = value => { for (const s of secrets) assert.equal(String(value).includes(s), false, s); };
async function setup(t, options) {
  const f = fixture(options);
  f.ir.put('accounts', { ...f.ir.get('accounts', 'query_only'), roleId: 'admin', adminAssignedByOwner: true });
  const http = await httpFixture(f);
  t.after(async () => { await http.close(); f.db.close(); });
  const headers = http.headers('query_only');
  const request = (path, body, patch = {}) => fetch(http.origin + '/api/v2/stats/' + path, {
    headers: { ...headers, ...patch }, ...(body === undefined ? {} : { method: 'POST', body: JSON.stringify(body) }) });
  return { f, http, headers, request };
}
async function job(f, request, path, body, id) {
  const response = await request(path, body, { 'Idempotency-Key': id });
  const data = await response.json(); assert.equal(response.status, 200, JSON.stringify(data));
  await f.service.runJob(data.data.jobId); return data.data.jobId;
}

test('authenticated HTTP source query and JSON/HTML/CSV download return safe bytes; no anonymous, CSRF or cross-account bypass', async t => {
  const { f, http, headers, request } = await setup(t);
  for (const path of ['query-capabilities', 'jobs/unknown']) assert.equal((await fetch(http.origin + '/api/v2/stats/' + path)).status, 401);
  assert.equal((await fetch(http.origin + '/api/v2/stats/queries', { method: 'POST', headers: { Origin: http.origin, 'Content-Type': 'application/json' }, body: JSON.stringify({ sourceId: 'member', steamInput: steam }) })).status, 401);
  for (const patch of [{ 'X-CSRF-Token': 'wrong' }, { Origin: 'http://127.0.0.1:1' }])
    assert.equal((await request('queries', { sourceId: 'member', steamInput: steam }, patch)).status, 403);
  const n = f.changes(), hints = await request('query-capabilities?steamInput=' + steam);
  assert.equal(hints.status, 200); assert.equal(f.changes(), n);
  const capabilityBody = JSON.stringify(await hints.json()); assertClean(capabilityBody); assert.equal(capabilityBody.includes('memberId'), false);
  const queryId = await job(f, request, 'queries', { sourceId: 'member', steamInput: steam }, 'http-public-member');
  const resultResponse = await request('jobs/' + queryId), result = await resultResponse.json();
  assert.equal(resultResponse.headers.get('cache-control'), 'no-store'); assert.equal(result.data.result.displayName, '阿北'); assertClean(JSON.stringify(result));
  for (const format of ['json', 'html', 'csv']) {
    const exportId = await job(f, request, 'exports', { queryJobId: queryId, format, language: 'zh' }, 'http-public-export-' + format);
    const descriptor = await (await request('jobs/' + exportId)).json();
    assert.equal(descriptor.data.status, 'succeeded'); assert.equal(descriptor.data.result.base64, undefined);
    const download = await request(`jobs/${exportId}/file`), bytes = Buffer.from(await download.arrayBuffer());
    assert.equal(download.status, 200); assertClean(bytes.toString());
    assert.equal(createHash('sha256').update(bytes).digest('hex'), descriptor.data.result.sha256);
    assert.match(download.headers.get('content-disposition'), /^attachment;/);
    assert.match(download.headers.get('content-security-policy'), /sandbox/);
    assert.match(bytes.toString(), /阿北/);
    if (format === 'csv') { assert.ok(bytes.toString().includes(steam)); assert.match(bytes.toString(), /字段/); }
    const other = http.headers('inventory_only', 'other-account-operation');
    assert.equal((await fetch(http.origin + `/api/v2/stats/jobs/${exportId}/file`, { headers: other })).status, 404);
    f.db.prepare('UPDATE v2_stats_jobs SET result=? WHERE id=?').run(JSON.stringify({ base64: Buffer.from(secrets.join('|')).toString('base64'), fileName: 'old.json', mime: 'application/json' }), exportId);
    const blocked = await request(`jobs/${exportId}/file`);
    assert.equal(blocked.status, 409); assertClean(await blocked.text());
  }
  f.identity.revokeAccountScope('query_only', 'http-revocation');
  assert.equal((await request('jobs/' + queryId)).status, 401);
  assert.equal((await request('query-capabilities')).status, 401);
});

test('HTTP member cannot gain catalog or player execution from historical custom grants', async t => {
  const { f, http } = await setup(t), headers = http.headers('catalog_only');
  for (const sourceId of ['catalog', 'vital', 'moose']) {
    const response = await fetch(http.origin + '/api/v2/stats/queries', { method: 'POST',
      headers: { ...headers, 'Idempotency-Key': `catalog-denied-${sourceId}` },
      body: JSON.stringify({ sourceId, provider: 'vital', steamInput: steam, serverId: 's', providerWipeId: 'p' }) });
    assert.equal(response.status, 403);
    assert.equal((await response.json()).error.errorCode, 'ACCESS_DENIED');
  }
  assert.equal(f.calls.length, 0);
});

test('HTTP admin demotion denies existing and nonexistent Steam subjects without data leakage', async t => {
  const { f, request } = await setup(t);
  const account = f.ir.get('accounts', 'query_only');
  f.ir.put('accounts', { ...account, roleId: 'member', adminAssignedByOwner: false, permissionVersion: account.permissionVersion + 1 });
  const fresh = await authenticatedSession(f.identity, account.id);
  const patch = { Cookie: `nb_v2_session=${fresh.token}`, 'X-CSRF-Token': fresh.csrfToken };
  for (const steamInput of [steam, '76561198000000999']) {
    const response = await request('queries', { sourceId: 'member', steamInput }, { ...patch, 'Idempotency-Key': 'denied-' + steamInput });
    assert.equal(response.status, 403);
    const body = await response.json(); assert.equal(body.error.errorCode, 'ACCESS_DENIED'); assertClean(JSON.stringify(body));
  }
  assert.equal(f.calls.length, 0);
});
