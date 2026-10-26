import '../v2-baseline/loopback-only.mjs';
import assert from 'node:assert/strict';
import { readFile, writeFile, realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import { root, runtimeBase } from './config.mjs';

const file = path.resolve(process.argv[2] || '');
assert.equal(path.basename(file), 'runtime.json');
assert.equal(path.dirname(path.dirname(file)), runtimeBase);
assert.equal(await realpath(file), file);
assert.equal((await stat(file)).mode & 0o777, 0o600);
const runtime = JSON.parse(await readFile(file, 'utf8'));
const url = new URL(runtime.origin);
assert.equal(url.hostname, '127.0.0.1');
assert.equal(url.protocol, 'http:');
const jar = new Map(), checks = [];
async function request(route, { method = 'GET', body, headers = {}, expected = 200 } = {}) {
  const response = await fetch(`${runtime.origin}${route}`, { method, redirect: 'manual',
    headers: { origin: runtime.origin, cookie: [...jar].map(([k, v]) => `${k}=${v}`).join('; '),
      ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...headers },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  for (const line of response.headers.getSetCookie()) {
    const [key, value] = line.split(';', 1)[0].split('=');
    if (value) jar.set(key, value); else jar.delete(key);
  }
  checks.push({ route, method, status: response.status, expected });
  assert.equal(response.status, expected, route);
  return response.headers.get('content-type')?.includes('json') ? response.json() : response.text();
}
await request('/admin'); await request('/app');
await request('/api/v2/auth/password', { method: 'POST', body: { username: runtime.rootLogin.username, password: runtime.rootLogin.password, returnTo: '/admin' } });
const me = await request('/api/v2/auth/me'); assert.equal(me.data.accountId, 'user_root');
await request('/api/v2/bootstrap');
const list = await request('/api/v2/admin/wipes'); assert.ok(list.data.items.length >= 2);
await request('/api/v2/admin/wipe-options?kind=servers');
await request(`/api/v2/wipes/${runtime.wipeIds[0]}/notification-options`);
await request('/__g06/control', { method: 'POST', body: { action: 'inspect' }, expected: 403 });
await request('/__g06/control', { method: 'POST', body: { action: 'inspect' }, headers: {
  'x-g06-control': runtime.control.token, origin: 'http://localhost:1' }, expected: 403 });
const controlHeaders = { 'x-g06-control': runtime.control.token };
const inspect = await request('/__g06/control', { method: 'POST', headers: controlHeaders, body: { action: 'inspect' } });
assert.equal(inspect.integrity, 'ok'); assert.equal(inspect.sendCount, 0);
assert.equal(JSON.stringify(inspect).includes(runtime.control.token), false);
await request(`/@fs/${runtime.runDir}/runtime.json`, { expected: 403 });
await request('/api/integrations/v2/notifications/discord', { method: 'POST', body: {}, expected: 401 });
await request('/__g06/control', { method: 'POST', headers: controlHeaders, body: { action: 'member-login', fixture: 'alpha' } });
const member = await request('/api/v2/auth/me'); assert.equal(member.data.accountId, runtime.memberLogin.fixtures[0].accountId);
await request('/api/v2/bootstrap'); await request(`/api/v2/wipes/${runtime.wipeIds[0]}/my-signup`);
const evidence = { at: new Date().toISOString(), root, origin: runtime.origin, runDir: runtime.runDir,
  checks, passed: checks.length, failed: 0, nativeSends: inspect.sendCount, scope: 'Formal createApiRouter, fresh SQLite, constructed identities; no external platform or browser acceptance' };
await writeFile(path.join(runtime.runDir, 'http-smoke.json'), JSON.stringify(evidence, null, 2), { mode: 0o600 });
console.log(JSON.stringify({ passed: checks.length, failed: 0, origin: runtime.origin, evidence: path.join(runtime.runDir, 'http-smoke.json') }));
