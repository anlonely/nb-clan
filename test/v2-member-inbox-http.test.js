import { authenticatedSession } from './support/authenticated-session.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import express from 'express';
import { fixture } from './support/v2-member-inbox/fixture.mjs';
import { createIdentityRouter } from '../server/v2/identity/routes.js';
import { createMiniProgramAdapter } from '../server/v2/platform-admin/mini-program.js';
import { createMiniProgramRouter } from '../server/v2/platform-admin/routes.js';
import { createMemberInboxRouter } from '../server/v2/member-inbox/index.js';

async function runtime(t) {
  const x = fixture(), app = express(), server = createServer(app);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const identityRouter = createIdentityRouter({ service: x.identity, origin, providers: {} });
  t.after(async () => { await identityRouter.stopEvents(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); x.close(); });
  app.post('/controlled-exchange', express.json(), (req, res) => {
    const id = String(req.body.code).split(':')[0];
    if (!['alice', 'bob'].includes(id) || req.body.appId !== 'app-a') return res.status(401).json({ verified: false });
    res.json({ verified: true, appId: 'app-a', openid: `${id}-app-a-openid` });
  });
  const mini = createMiniProgramAdapter({ identity: x.identity, scheduling: x.scheduling, appId: 'app-a',
    readConfig: () => x.config, now: x.now, adapters: x.adapters.mini,
    exchangeCode: async args => { const r = await fetch(origin + '/controlled-exchange', { method: 'POST',
      headers: { 'content-type': 'application/json' }, body: JSON.stringify(args) }); return r.json(); } });
  app.use('/api/v2', createMiniProgramRouter({ adapter: mini }));
  app.use('/api/v2', (req,res,next) => { req.v2Identity = { service: x.identity,
    authenticate: options => identityRouter.authenticate(options)(req) }; next(); });
  app.use('/api/v2', identityRouter, createMemberInboxRouter({ getService: () => x.service }));
  const cookieSessions = Object.fromEntries(await Promise.all(['alice','bob'].map(async id => [id, await authenticatedSession(x.identity,id)])));
  const request = async (path, { body, method = body ? 'POST' : 'GET', cookie, bearer, key = randomUUID(), headers = {} } = {}) => {
    const s = cookieSessions[cookie];
    const response = await fetch(origin + '/api/v2' + path, { method, headers: {
      'content-type': 'application/json', origin, 'Idempotency-Key': key,
      ...(s ? { cookie: `nb_v2_session=${s.token}`, 'x-csrf-token': s.csrfToken } : {}),
      ...(bearer ? { authorization: `Bearer ${bearer}` } : {}), ...headers }, ...(body ? { body: JSON.stringify(body) } : {}) });
    return { status: response.status, data: await response.json(), headers: response.headers };
  };
  const login = async (id = 'alice') => {
    const r = await request('/mini-program/login', { body: { code: `${id}:${randomUUID()}` } });
    assert.equal(r.status, 200); return r.data.data.token;
  };
  return { ...x, request, login, cookieSessions };
}

test('Cookie and Bearer both resolve same canonical own inbox while keeping transport authentication separate', async t => {
  const x = await runtime(t), token = await x.login(); x.putNotification('alice-note'); x.putNotification('bob-note','bob-app-a');
  const web = await x.request('/member-inbox/notifications', { cookie: 'alice' });
  const mini = await x.request('/mini-program/commands/notifications', { bearer: token, body: {} });
  assert.equal(web.status, 200); assert.equal(mini.status, 200);
  assert.deepEqual(web.data.data.notifications, mini.data.data.notifications);
  assert.equal(web.data.data.total, 1); assert.equal(web.headers.get('cache-control'), 'no-store');
  assert.equal((await x.request('/member-inbox/notifications', { bearer: token })).status, 401);
  assert.equal((await x.request('/mini-program/commands/notifications', { cookie: 'alice', body: {} })).status, 401);
});
test('Cookie preference mutation validates origin/CSRF and replay returns current with no scheduling side effect', async t => {
  const x = await runtime(t), settings = (await x.request('/member-inbox/settings', { cookie: 'alice' })).data.data;
  const body = { expectedRevision: settings.preferencesRevision, expectedConfigRevision: settings.configRevision, subscriptions: { wipeOpen: 'accept' } };
  const req = { cookie: 'alice', method: 'PUT', body, key: randomUUID() };
  assert.equal((await x.request('/member-inbox/settings', { ...req, headers: { origin: 'http://foreign.invalid' } })).status, 403);
  assert.equal((await x.request('/member-inbox/settings', { ...req, headers: { 'x-csrf-token': 'wrong' } })).status, 403);
  const first = await x.request('/member-inbox/settings', req); assert.equal(first.status, 200);
  assert.equal(first.data.data.current.subscriptions.wipeOpen.platformVerified, false);
  assert.equal((await x.request('/member-inbox/settings', req)).data.data.replayed, true);
  assert.equal(x.db.prepare("SELECT count(*) n FROM json_records WHERE collection IN ('wechatNotifications','operationRuns')").get().n, 0);
});
test('Bearer four-domain success with readAt/version/receipt and strict non-owner 404', async t => {
  const x = await runtime(t), token = await x.login(); x.putNotification('own'); x.putNotification('other','bob-app-a');
  const settings = await x.request('/mini-program/commands/notification_settings', { bearer: token, body: {} });
  assert.equal(settings.status, 200);
  const s = settings.data.data;
  const saved = await x.request('/mini-program/commands/notification_settings_save', { bearer: token,
    body: { expectedRevision: s.preferencesRevision, expectedConfigRevision: s.configRevision, subscriptions: { wipeOpen: 'accept' } } });
  assert.equal(saved.status, 200);
  const input = { bearer: token, body: { notificationId: 'own', expectedRevision: 1 }, key: randomUUID() };
  const read = await x.request('/mini-program/commands/notification_read', input);
  assert.equal(read.status, 200); assert.equal(read.data.data.current.revision, 2);
  assert.equal((await x.request('/mini-program/commands/notification_read', input)).data.data.replayed, true);
  const denied = await x.request('/mini-program/commands/notification_read', { bearer: token, body: { notificationId: 'other', expectedRevision: 1 } });
  assert.equal(denied.status, 404); assert.equal(JSON.stringify(denied.data).includes('bob'), false);
});
test('HTTP injected subject/config values reject; revoked Bearer and Cookie sessions cannot write', async t => {
  const x = await runtime(t), token = await x.login(); x.putNotification('own');
  for (const field of ['appId','wechatUserId','openid','accountId','actor']) {
    const r = await x.request('/mini-program/commands/notifications', { bearer: token, body: { [field]: 'forged' } });
    assert.ok([403,422].includes(r.status));
  }
  x.repo.put('accounts', { ...x.repo.get('accounts','alice'), permissionVersion: 2 });
  assert.equal((await x.request('/mini-program/commands/notification_read', { bearer: token, body: { notificationId:'own',expectedRevision:1 } })).status, 401);
  assert.equal((await x.request('/member-inbox/notifications/own/read', { cookie:'alice', body:{expectedRevision:1} })).status, 401);
  assert.equal(x.service.repo.get('wechatNotifications','own').readAt, '');
});
test('HTTP failed cache response preserves same-key recovery and original canonical readAt', async t => {
  const x = await runtime(t); x.putNotification('own'); x.cacheFailure = true;
  // request runtime returns a shallow copy; use the service cache callback owner.
  const original = x.service.patchStoreCache; let failed = true;
  x.service.patchStoreCache = fn => { if (failed) throw new Error('controlled cache failure'); return original(fn); };
  const request = { cookie: 'alice', body: { expectedRevision: 1 }, key: randomUUID() };
  assert.equal((await x.request('/member-inbox/notifications/own/read',request)).status, 503);
  const saved = x.service.repo.get('wechatNotifications','own').readAt;
  failed = false;
  const replay = await x.request('/member-inbox/notifications/own/read',request);
  assert.equal(replay.status, 200); assert.equal(replay.data.data.replayed,true); assert.equal(replay.data.data.current.readAt,saved);
});
