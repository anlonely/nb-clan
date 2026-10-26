import { authenticatedSession } from './support/authenticated-session.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { createServer } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { fixture } from './support/v2-platform-host/fixture.mjs';
import { createIdentityRouter } from '../server/v2/identity/routes.js';

async function setup(t, options = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'nb-g07-platform-host-')), filename = join(directory, 'isolated.sqlite');
  const f = fixture({ filename, ...options }), app = express(), server = createServer(app);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const auth = createIdentityRouter({ service: f.identity, origin, providers: {} });
  // The two mini entrypoints are mounted BEFORE the browser-cookie surface.
  app.use('/api/v2', f.host.miniRouter);
  app.use('/api', f.host.legacyRouter);
  app.use('/api/v2', (req, res, next) => {
    req.v2Identity = { service: f.identity, authenticate: options => auth.authenticate(options)(req) }; next();
  }, auth, f.host.adminRouter);
  app.use((req, res) => res.status(404).json({ error: 'unmounted' }));
  t.after(async () => { await f.host.stop(); await auth.stopEvents(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); await f.close(); rmSync(directory, { recursive: true, force: true }); });
  await f.start();
  const browser = await authenticatedSession(f.identity, 'admin');
  const request = async (path, { method = 'GET', input, token, cookie, csrf = true, requestOrigin = origin, operationId = randomUUID(), headers = {} } = {}) => {
    const url = new URL(path, origin); assert.equal(url.origin, origin); assert.equal(url.hostname, '127.0.0.1');
    const response = await fetch(url, { method, redirect: 'error', headers: {
      ...(input !== undefined ? { 'Content-Type': 'application/json' } : {}), ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(cookie ? { Cookie: `nb_v2_session=${cookie.token}`, ...(csrf ? { 'X-CSRF-Token': cookie.csrfToken } : {}) } : {}),
      ...(requestOrigin ? { Origin: requestOrigin } : {}), ...(operationId ? { 'Idempotency-Key': operationId } : {}), ...headers
    }, ...(input === undefined ? {} : { body: JSON.stringify(input) }) });
    return { status: response.status, body: await response.json(), cache: response.headers.get('cache-control') };
  };
  const mini = (command, input = {}, extra = {}) => request(`/api/v2/mini-program/commands/${command}`, { method: 'POST', input, ...extra });
  return { ...f, request, mini, browser, filename };
}

test('real SQLite + cookie/Bearer/CSRF: unique service, mount order and save does not send', async t => {
  const f = await setup(t);
  assert.equal(f.host.service, f.platformService);
  assert.equal((await f.request('/api/v2/platform-admin/wechat')).status, 401);
  const input = { expectedRevision: 1, config: { enabled: false } }, path = '/api/v2/platform-admin/discord/config';
  assert.equal((await f.request(path, { method: 'POST', input, cookie: f.browser, csrf: false })).status, 403);
  assert.equal((await f.request(path, { method: 'POST', input, cookie: f.browser, requestOrigin: 'https://evil.invalid' })).status, 403);
  const saved = await f.request(path, { method: 'POST', input, cookie: f.browser });
  assert.equal(saved.status, 200); assert.equal(saved.body.data.revision, 2); assert.equal(saved.cache, 'no-store');
  assert.deepEqual(f.externalCalls, []); assert.equal(f.transport.getCalls().length, 0);
  const observer = new DatabaseSync(f.filename); t.after(() => observer.close());
  assert.equal(JSON.parse(observer.prepare("SELECT payload FROM platform_admin_records WHERE kind='config' AND id='discord'").get().payload).enabled, false);
  assert.equal((await f.mini('me', {}, { cookie: f.browser })).status, 401);
  const session = await f.login();
  assert.equal((await f.mini('me', {}, { token: session.token, csrf: false, requestOrigin: null })).status, 200);
  assert.equal((await f.request('/api/v2/platform-admin/wechat', { token: session.token })).status, 401);
});

test('fixed member directory exposes public roster while full member reads stay self scoped', async t => {
  const f = await setup(t), session = await f.login('leader');
  const r = await f.mini('members', { limit: 100 }, { token: session.token });
  assert.equal(r.status, 200); assert.equal(r.body.data.items.length, 1);
  assert.equal(r.body.data.items[0].id, 'm001');
  const directory = await f.mini('member_directory', { limit: 100 }, { token: session.token });
  assert.equal(directory.status, 200); assert.equal(directory.body.data.items.length, 66);
  assert.equal(directory.body.data.items.some(member => 'phone' in member || 'notes' in member), false);
  const own = await f.mini('squad_members', { squadId: 's1' }, { token: session.token });
  assert.equal(own.status, 200);
  assert.equal((await f.mini('squad_members', { squadId: 's2' }, { token: session.token })).status, 403);
  assert.equal((await f.mini('map', { wipeId: 'other-wipe' }, { token: session.token })).status, 404);
  const candidates = await f.mini('participant_candidates', { wipeId: 'host-wipe' }, { token: session.token });
  assert.equal(candidates.status, 410); assert.equal(candidates.body.error.errorCode, 'MINI_MANAGEMENT_RETIRED');
  assert.equal((await f.mini('member_specialty', { memberId: 'm036', expectedRevision: 1, specialty: ['pvp'] }, { token: session.token })).status, 410);
});

test('legacy + native profile edit uses same member-space receipt and repairs canonical cache', async t => {
  const f = await setup(t), session = await f.login(), operationId = randomUUID();
  const input = { expectedRevision: 1, displayName: '隔离资料编辑', timeZone: 'Asia/Shanghai' };
  const r = await f.request('/api/wechat/profile', { method: 'PUT', input, operationId, headers: { 'x-nb-wechat-session': session.token } });
  assert.equal(r.status, 200, JSON.stringify(r));
  const repeat = await f.mini('profile_save', input, { token: session.token, operationId });
  assert.equal(repeat.status, 200); assert.equal(repeat.body.data.replayed, true);
  assert.equal(f.ir.get('members', 'm002').revision, 2); assert.equal(f.cache.members.find(m => m.id === 'm002').customName, input.displayName);
  assert.equal((await f.mini('profile_save', { ...input, displayName: '冲突' }, { token: session.token })).status, 409);
  assert.equal((await f.mini('profile_save', { ...input, actor: { id: 'admin' } }, { token: session.token })).status, 403);
  assert.equal((await f.mini('me', { accountId: 'admin' }, { token: session.token })).status, 403);
});

test('retired legacy management rejects all revisions and unknown routes never fall through', async t => {
  const f = await setup(t), session = await f.login('admin'), headers = { 'x-nb-wechat-session': session.token };
  const before = f.ir.get('members', 'm003');
  for (const input of [{ status: 'suspended' }, { expectedRevision: 1, status: 'suspended', reason: 'retired request' }]) {
    const result = await f.request('/api/wechat/admin/members/m003/status', { method: 'PUT', input, headers });
    assert.equal(result.status, 410); assert.equal(result.body.errorCode, 'MINI_MANAGEMENT_RETIRED');
  }
  assert.deepEqual(f.ir.get('members', 'm003'), before);
  assert.equal((await f.request('/api/wechat/admin/member-bind-requests', { headers })).status, 410);
  assert.equal((await f.request('/api/wechat/query', { headers, operationId: null })).status, 409);
  assert.equal((await f.request('/api/wechat/wipes/current', { headers })).status, 409);
});

test('G04 mini signup and legacy cancel preserve explicit revision/confirmation rules', async t => {
  const f = await setup(t), session = await f.login();
  const input = { kind: 'direct-v2', adapterVersion: 2, wipeId: 'host-wipe', input: {
    response: 'attending_on_time', expectedSignupRevision: 0, confirmedContentRevision: 1, timeZone: 'Asia/Shanghai' } };
  const saved = await f.request('/api/v2/mini-program/signup', { method: 'POST', token: session.token, input });
  assert.equal(saved.status, 200, JSON.stringify(saved));
  const observed = f.scheduling.getSignup(f.actor('member'), 'host-wipe', 'm002');
  assert.equal(observed.response, 'attending_on_time');
  const legacy = await f.request('/api/wechat/wipes/host-wipe/signup', { method: 'POST', input: { status: 'cancel' }, headers: { 'x-nb-wechat-session': session.token } });
  assert.equal(legacy.status, 409); assert.equal(legacy.body.errorCode, 'SIGNUP_CONFIRMATION_REQUIRED');
  assert.equal(f.scheduling.getSignup(f.actor('member'), 'host-wipe', 'm002').response, 'attending_on_time');
  const old = await f.request('/api/wechat/wipes/host-wipe/signup', { method: 'POST', input: { status: 'late' }, headers: { 'x-nb-wechat-session': session.token } });
  assert.equal(old.status, 409); assert.equal(f.sr.all('signupContexts').length, 1);
  const wrongTarget = await f.request('/api/v2/mini-program/signup', { method: 'POST', token: session.token, input: { ...input, memberId: 'm001' } });
  assert.equal(wrongTarget.status, 403);
  await f.runStoreWriteTask(() => f.platformService.save(f.actor('admin'), 'wechat', { expectedRevision: 1, config: { minClientVersion: 2 } }, { operationId: 'upgrade-client-policy' }));
  const rejected = await f.request('/api/wechat/wipes/host-wipe/signup', { method: 'POST', input: { status: 'join' }, headers: { 'x-nb-wechat-session': session.token } });
  assert.equal(rejected.status, 409); assert.equal(rejected.body.errorCode, 'ADAPTER_VERSION_UNSUPPORTED');
});

test('mini sync management is retired before enqueueing or cancelling shared jobs', async t => {
  const f = await setup(t), session = await f.login('admin'), before = f.queueLog.length;
  for (const input of [{ type: 'kda', wipeId: 'host-wipe' }, { action: 'cancel', jobId: 'unknown', expectedRevision: 1 }, { action: 'status', jobId: 'unknown' }]) {
    const result = await f.mini('sync', input, { token: session.token });
    assert.equal(result.status, 410); assert.equal(result.body.error.errorCode, 'MINI_MANAGEMENT_RETIRED');
  }
  const list = await f.request('/api/wechat/admin/wipes/host-wipe/sync-jobs', { headers: { 'x-nb-wechat-session': session.token } });
  assert.equal(list.status, 410); assert.equal(list.body.errorCode, 'MINI_MANAGEMENT_RETIRED');
  assert.equal(f.queueLog.length, before); assert.equal(f.sync.list(f.actor('admin')).items.length, 0);
});

test('explicit domain gaps and missing exchange stay unavailable with no fallback records', async t => {
  const f = await setup(t, { external: false });
  const caps = await f.request('/api/v2/mini-program/capabilities');
  assert.equal(caps.body.data.login.state, 'unavailable'); assert.equal(caps.body.data.websiteOAuth.state, 'unavailable');
  assert.equal((await f.request('/api/v2/mini-program/login', { method: 'POST', input: { code: 'no-external-authority' } })).status, 503);
  const enabled = caps.body.data.commands.filter(c => !c.available).map(c => c.id);
  assert.equal(caps.body.data.commands.some(row => row.id === 'application_submit'), false); assert.ok(enabled.includes('notification_read'));
  assert.equal((await f.mini('application_submit')).status, 410);
  assert.equal(f.db.prepare("SELECT count(*) n FROM platform_admin_records WHERE kind='mini-session'").get().n, 0);
});

test('browser explicit platform action reaches shared forwarding owner and does not auto-run after config save', async t => {
  const f = await setup(t);
  f.sourcePages.set('discord:200000000000000001', { verified: true, items: [{ id: 'http-source', channelId: '200000000000000001', content: '隔离 HTTP 转发' }], nextCursor: 'http-cursor' });
  assert.equal(f.transport.getCalls().length, 0);
  const result = await f.request('/api/v2/platform-admin/bridge/actions/forward_run', { method: 'POST', cookie: f.browser,
    input: { expectedRevision: 1 }, operationId: 'http-explicit-forward' });
  assert.equal(result.status, 200); assert.equal(result.body.data.status, 'succeeded', JSON.stringify(result));
  assert.equal(result.body.data.result.counts.succeeded, 1); assert.equal(f.transport.getCalls().length, 1);
  const repeat = await f.request('/api/v2/platform-admin/bridge/actions/forward_run', { method: 'POST', cookie: f.browser,
    input: { expectedRevision: 1 }, operationId: 'http-explicit-forward' });
  assert.equal(repeat.body.data.replayed, true); assert.equal(f.transport.getCalls().length, 1);
});
