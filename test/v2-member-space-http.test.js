import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import express from 'express';
import { installIdentitySchema, IdentityRepository } from '../server/v2/identity/repository.js';
import { planIdentityMigration, applyIdentityMigration } from '../server/v2/identity/migration.js';
import { IdentityService } from '../server/v2/identity/service.js';
import { createIdentityRouter } from '../server/v2/identity/routes.js';
import { installSchedulingSchema, SchedulingRepository } from '../server/v2/scheduling/repository.js';
import { SchedulingService } from '../server/v2/scheduling/service.js';
import { createSchedulingRouter } from '../server/v2/scheduling/routes.js';
import { createMemberSpaceRouter } from '../server/v2/member-space/routes.js';
import { PlatformMediaRepository, installPlatformMediaSchema } from '../server/v2/platform-media/repository.js';
import { digest } from '../server/v2/platform-media/model.js';

async function runtime(t) {
  const directory = await mkdtemp(join(tmpdir(), 'nb-v2-member-http-')), file = join(directory, 'isolated.sqlite');
  const db = new DatabaseSync(file); installIdentitySchema(db); installSchedulingSchema(db);
  const repo = new IdentityRepository(db), sr = new SchedulingRepository(db);
  applyIdentityMigration(repo, planIdentityMigration({ users: [], members: [] }));
  sr.setScalar('v2SchedulingMigration', { sourceHash: 'isolated-g05-http' });
  for (const policy of repo.all('policies')) repo.put('policies', { ...policy, enabled: true, guildId: 'isolated', allowedRoleIds: ['member'] });
  const state = { subject: 'local-subject-1', steamId: '76561198000000001', roles: ['member'], externalCalls: 0 };
  const providers = Object.fromEntries(['discord', 'kook'].map(provider => [provider, {
    configured: () => true, authorizationUrl: token => `https://platform.invalid/?state=${token}`,
    exchange: async () => ({ provider, id: state.subject, displayName: '本地测试成员' }),
    roles: async (externalId, guildId) => { state.externalCalls++; return { externalId, guildId, roleIds: state.roles }; }
  }]));
  const steam = { authorizationUrl: returnTo => `https://steam.invalid/?return_to=${encodeURIComponent(returnTo)}`, verify: async () => state.steamId };
  const identity = new IdentityService(repo, { providers }), scheduling = new SchedulingService(sr, identity);
  const app = express(), server = createServer(app);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`, identityRouter = createIdentityRouter({ service: identity, origin, providers, steam });
  app.use('/api/v2', (req, _res, next) => { req.v2Identity = { service: identity, authenticate: options => identityRouter.authenticate(options)(req) }; next(); });
  app.use('/api/v2', identityRouter, createSchedulingRouter(), createMemberSpaceRouter());
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); db.close(); await rm(directory, { recursive: true, force: true }); });
  const jar = new Map();
  const request = async (path, { body, headers = {}, method = body ? 'POST' : 'GET', useJar = true } = {}) => {
    const response = await fetch(path.startsWith('http:') ? path : `${origin}/api/v2${path}`, { redirect: 'manual', method,
      headers: { ...(useJar ? { cookie: [...jar].map(([k, v]) => `${k}=${v}`).join('; ') } : {}),
        ...(body ? { 'content-type': 'application/json' } : {}), ...headers }, ...(body ? { body: JSON.stringify(body) } : {}) });
    if (useJar) for (const item of response.headers.getSetCookie()) {
      const [key, value] = item.split(';')[0].split('='); value ? jar.set(key, value) : jar.delete(key);
    }
    return response;
  };
  const json = async (path, options) => { const response = await request(path, options); return { status: response.status, body: await response.json(), response }; };
  async function oauth(returnTo = '/app/wipes/local-wipe?from=announcement') {
    const start = await request(`/auth/discord/start?returnTo=${encodeURIComponent(returnTo)}`);
    assert.equal(start.status, 302);
    const token = new URL(start.headers.get('location')).searchParams.get('state');
    const callback = await request(`/auth/discord/callback?code=controlled&state=${token}`, { useJar: false });
    return request(callback.headers.get('location'));
  }
  async function login() {
    await oauth();
    if (!jar.has('nb_v2_session')) {
      const info = await json('/auth/continue');
      const start = await json('/auth/steam/start', { body: {}, headers: { origin, 'x-csrf-token': info.body.data.csrfToken } });
      const returnTo = new URL(start.body.data.authorizationUrl).searchParams.get('return_to');
      assert.equal((await request(returnTo)).status, 303);
    }
    return (await json('/bootstrap')).body;
  }
  async function setupMember() {
    const boot = await login(), memberId = boot.data.memberId;
    repo.put('squads', { id: 's1', name: '本地一队', internalNote: 'private squad' });
    repo.put('squadMembers', { id: `sm-${memberId}`, memberId, squadId: 's1' });
    await oauth();
    const now = Date.now();
    const wipe = { id: 'local-wipe', title: '真实本地开荒', lifecycle: 'scheduled', revision: 2, contentRevision: 1,
      timeZone: 'Asia/Shanghai', serverProfileId: 'local', serverSnapshot: { name: 'Local server', secret: 'hidden' },
      musterAt: new Date(now + 3600_000).toISOString(), serverScheduledWipeAt: new Date(now + 3600_000).toISOString(),
      signupOpensAt: new Date(now - 3600_000).toISOString(), signupClosesAt: new Date(now + 7200_000).toISOString(),
      signupWindow: 'open', audience: { squadIds: ['s1'], memberIds: [], includeUnassigned: false } };
    sr.put('wipes', wipe); scheduling.content(wipe, now);
    return { memberId, accountId: boot.data.accountId, wipe, bootstrap: (await json('/bootstrap')).body };
  }
  return { db, file, repo, sr, identity, state, request, json, jar, origin, login, oauth, setupMember };
}

test('real G03 cookie login/Steam onboarding restores deep link and exposes two small member bootstrap/home requests', async t => {
  const f = await runtime(t);
  assert.equal((await f.request('/bootstrap')).status, 401);
  const finish = await f.oauth(); assert.equal(new URL(finish.headers.get('location')).pathname, '/auth/continue');
  assert.equal((await f.request('/me/home')).status, 401);
  const info = await f.json('/auth/continue'); assert.equal(info.body.data.returnTo, '/app/wipes/local-wipe?from=announcement');
  const start = await f.json('/auth/steam/start', { body: {}, headers: { origin: f.origin, 'x-csrf-token': info.body.data.csrfToken } });
  const callback = await f.request(new URL(start.body.data.authorizationUrl).searchParams.get('return_to'));
  assert.equal(callback.headers.get('location'), `${f.origin}/app/wipes/local-wipe?from=announcement`);
  assert.ok(callback.headers.getSetCookie().find(cookie => cookie.startsWith('nb_v2_session=')).includes('HttpOnly'));
  const calls = f.state.externalCalls, bootstrap = await f.json('/bootstrap'), home = await f.json('/me/home');
  assert.equal(bootstrap.status, 200); assert.equal(home.status, 200); assert.equal(bootstrap.body.data.csrfToken, f.jar.get('nb_v2_csrf'));
  assert.equal(bootstrap.body.data.participation.canSignup, true); assert.equal(home.body.data.nextWipe, null);
  assert.equal(bootstrap.response.headers.get('cache-control'), 'no-store'); assert.ok(bootstrap.body.meta.scopeVersion);
  assert.ok(JSON.stringify(bootstrap.body).length < 6000); assert.ok(JSON.stringify(home.body).length < 2500);
  assert.equal(f.state.externalCalls, calls); // Fresh eligibility is reused; no BM/KDA/Steam request is a read prerequisite.
});

test('team WeChat avatar uses the member session and same-team scope', async t => {
  const f = await runtime(t), { memberId, accountId } = await f.setupMember();
  installPlatformMediaSchema(f.db);
  const media = new PlatformMediaRepository(f.db), avatarUrl = `/api/v2/platform-media/avatar-image?memberId=${encodeURIComponent(memberId)}`;
  f.repo.put('identities', { id: 'wechat-test', accountId, provider: 'wechat:wx-app', externalId: 'openid-one',
    verifiedAt: new Date().toISOString() });
  f.repo.put('wechatUsers', { id: 'wx-user', appId: 'wx-app', openid: 'openid-one', memberId,
    nickname: '微信成员', avatarUploadId: 'v2_avatar_test', avatarRevision: 1, avatarUrl });
  media.put('uploads', { id: 'v2_avatar_test', ownerType: 'wechat_user', ownerId: 'wx-user', appId: 'wx-app',
    storage: 'v2_platform_media', revision: 1, sha256: 'avatar-test', url: avatarUrl });
  const bytes = Buffer.from('avatar-test');
  media.writeBlob(digest(['wx-app', 'wx-user']), 'wx-app', 'wx-user', 1,
    { sha256: 'avatar-test', contentType: 'image/png', width: 1, height: 1, bytes });
  const path = `/me/team/avatar/${encodeURIComponent(memberId)}`;
  assert.equal((await f.request(path, { useJar: false })).status, 401);
  const response = await f.request(path);
  assert.equal(response.status, 200); assert.equal(response.headers.get('content-type'), 'image/png');
  assert.deepEqual(Buffer.from(await response.arrayBuffer()), bytes);
  assert.equal((await f.request('/me/team/avatar/member-outside')).status, 404);
});

test('profile PATCH uses G03 exact origin/CSRF, optimistic revision and durable SQLite operation receipts', async t => {
  const f = await runtime(t), { memberId, bootstrap } = await f.setupMember();
  const body = { expectedRevision: 1, displayName: '修改后的本人', specialty: ['建筑'], timeZone: 'Asia/Tokyo', language: 'en', theme: 'light' };
  const headers = { origin: f.origin, 'x-csrf-token': bootstrap.data.csrfToken, 'Idempotency-Key': randomUUID() };
  assert.equal((await f.request('/me', { method: 'PATCH', body, headers: { ...headers, origin: 'http://attacker.invalid' } })).status, 403);
  assert.equal((await f.request('/me', { method: 'PATCH', body, headers: { ...headers, 'x-csrf-token': 'invalid' } })).status, 403);
  const first = await f.json('/me', { method: 'PATCH', body, headers }); assert.equal(first.status, 200);
  assert.equal(first.body.data.current.profile.revision, 2); assert.equal(first.body.data.current.profile.displayName, body.displayName);
  const replay = await f.json('/me', { method: 'PATCH', body, headers }); assert.equal(replay.body.data.replayed, true);
  const conflict = await f.json('/me', { method: 'PATCH', body: { ...body, displayName: 'changed body' }, headers });
  assert.equal(conflict.status, 409); assert.equal(conflict.body.error.errorCode, 'IDEMPOTENCY_CONFLICT');
  const separateConnection = new DatabaseSync(f.file, { readOnly: true });
  try {
    const stored = JSON.parse(separateConnection.prepare("SELECT payload_json FROM json_records WHERE collection='members' AND id=?").get(memberId).payload_json);
    assert.equal(stored.displayName, body.displayName); assert.equal(stored.timeZone, body.timeZone);
    assert.equal(separateConnection.prepare("SELECT COUNT(*) AS count FROM json_records WHERE collection='v2MemberProfileReceipts'").get().count, 1);
  } finally { separateConnection.close(); }
});

test('same SQLite G04 signup immediately updates home, history, summary and subsequent modification', async t => {
  const f = await runtime(t), { bootstrap, wipe } = await f.setupMember(), csrf = bootstrap.data.csrfToken;
  const signup = { response: 'attending_on_time', expectedArrivalAt: null, timeZone: wipe.timeZone, expectedSignupRevision: 0, confirmedContentRevision: 1 };
  const opts = body => ({ method: 'PUT', body, headers: { origin: f.origin, 'x-csrf-token': csrf, 'Idempotency-Key': randomUUID() } });
  assert.equal((await f.json('/me/home')).body.data.nextAction.kind, 'signup');
  const saved = await f.json(`/wipes/${wipe.id}/my-signup`, opts(signup)); assert.equal(saved.status, 200);
  const home = await f.json('/me/home'); assert.equal(home.body.data.nextAction.kind, 'edit_signup'); assert.equal(home.body.data.nextWipe.mySignup.signupRevision, 1);
  const summary = await f.json(`/wipes/${wipe.id}/summary`); assert.equal(summary.body.data.counts.confirmedAttending, 1); assert.equal(summary.body.data.countScope, 'audience');
  const modified = await f.json(`/wipes/${wipe.id}/my-signup`, opts({ ...signup, expectedSignupRevision: 1, response: 'not_attending' })); assert.equal(modified.status, 200);
  const history = await f.json('/me/history'); assert.equal(history.body.data.items[0].mySignup.response, 'not_attending'); assert.equal(history.body.data.items[0].stats.data, null);
  assert.equal((await f.json('/me/team')).body.data.team.name, '本地一队');
});

test('member responses reject arbitrary subject overrides and never serialize other members sensitive fields', async t => {
  const f = await runtime(t), { bootstrap, memberId } = await f.setupMember();
  f.repo.put('members', { id: 'unrelated', displayName: 'other', memberStatus: 'active', steamId: '76561198999999001', phone: 'secret phone', internalNote: 'secret-note' });
  const self = await f.json('/me?memberId=unrelated'); assert.equal(self.body.data.profile.id, memberId);
  const patch = await f.json('/me', { method: 'PATCH', body: { expectedRevision: 1, displayName: 'valid', memberId: 'unrelated', steamId: '76561198999999001' },
    headers: { origin: f.origin, 'x-csrf-token': bootstrap.data.csrfToken, 'Idempotency-Key': randomUUID() } });
  assert.equal(patch.status, 422); assert.equal(patch.body.error.fieldErrors.memberId, 'FIELD_NOT_EDITABLE');
  const team = await f.json('/me/team?teamId=unrelated'); assert.equal(team.status, 404);
  assert.equal(JSON.stringify(team.body).includes('unrelated'), false); assert.equal(JSON.stringify(team.body).includes('secret'), false);
});

test('account revocation prevents protected read/write including operation replay', async t => {
  const f = await runtime(t), { bootstrap, accountId } = await f.setupMember();
  const request = { method: 'PATCH', body: { expectedRevision: 1, displayName: 'before revoke' },
    headers: { origin: f.origin, 'x-csrf-token': bootstrap.data.csrfToken, 'Idempotency-Key': randomUUID() } };
  assert.equal((await f.request('/me', request)).status, 200);
  f.repo.put('accounts', { ...f.repo.get('accounts', accountId), status: 'disabled', permissionVersion: 2 });
  assert.ok([401, 403].includes((await f.request('/me/home')).status));
  assert.ok([401, 403].includes((await f.request('/me', request)).status));
  assert.ok([401, 403].includes((await f.request('/me/team')).status));
});

test('different account gets independent self profile while the first account remains scoped to itself', async t => {
  const f = await runtime(t), first = await f.setupMember();
  const firstCookie = [...f.jar].map(([k, v]) => `${k}=${v}`).join('; ');
  f.jar.clear(); f.state.subject = 'local-subject-2'; f.state.steamId = '76561198000000002';
  const second = await f.login();
  assert.notEqual(second.data.accountId, first.accountId); assert.notEqual(second.data.memberId, first.memberId);
  assert.equal((await f.json('/me')).body.data.profile.id, second.data.memberId);
  assert.equal((await f.json('/me/team')).body.data.team.id, 's1');
  const prior = await f.json('/me', { useJar: false, headers: { cookie: firstCookie } }); assert.equal(prior.body.data.profile.id, first.memberId);
});

test('member API fails closed if scheduling schema or migration is absent', async t => {
  const f = await runtime(t);
  // Remove the marker before the first member-service construction, after the explicit identity migration.
  f.sr.setScalar('v2SchedulingMigration', null);
  const bootstrap = await f.login(); assert.equal(bootstrap.error.errorCode, 'SCHEDULING_MIGRATION_REQUIRED');
  const missing = await f.json('/me/home'); assert.equal(missing.status, 503); assert.equal(missing.body.error.errorCode, 'SCHEDULING_MIGRATION_REQUIRED');
});

test('expired real G03 session is rejected by every member endpoint', async t => {
  const f = await runtime(t), { bootstrap } = await f.setupMember();
  for (const session of f.repo.all('sessions')) f.repo.put('sessions', { ...session, expiresAt: '2000-01-01T00:00:00.000Z' });
  for (const path of ['/bootstrap', '/me', '/me/home', '/me/team', '/me/history']) assert.equal((await f.request(path)).status, 401, path);
  const write = await f.request('/me', { method: 'PATCH', body: { expectedRevision: 1, displayName: 'too late' },
    headers: { origin: f.origin, 'x-csrf-token': bootstrap.data.csrfToken, 'Idempotency-Key': randomUUID() } });
  assert.equal(write.status, 401);
});

test('light auth SSE emits bounded ready without members, then immediate revoked event and EOF', async t => {
  const f = await runtime(t), { accountId, bootstrap } = await f.setupMember();
  const cookie = [...f.jar].map(([key, value]) => `${key}=${value}`).join('; ');
  const response = await fetch(`${f.origin}/api/v2/auth/events`, { headers: { cookie }, signal: AbortSignal.timeout(2500) });
  assert.equal(response.status, 200); assert.match(response.headers.get('content-type'), /text\/event-stream/);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  const reader = response.body.getReader(), decoder = new TextDecoder();
  const first = decoder.decode((await reader.read()).value);
  assert.match(first, /^event: ready\ndata: /); assert.equal(first.includes('members'), false); assert.ok(first.length < 160);
  assert.equal(JSON.parse(first.split('data: ')[1].trim()).scopeVersion, bootstrap.meta.scopeVersion);
  assert.equal(f.identity.listeners.size, 1);
  f.identity.revokeAccountScope(accountId, 'g05_test_permission_changed');
  let ending = '';
  while (true) { const chunk = await reader.read(); if (chunk.done) break; ending += decoder.decode(chunk.value); }
  assert.match(ending, /event: authorization-revoked/); assert.match(ending, /"clearClientCache":true/);
  assert.match(ending, /g05_test_permission_changed/); assert.equal(ending.includes('members'), false);
  assert.equal(f.identity.listeners.size, 0);
  assert.equal((await f.request('/auth/events')).status, 401);
});

test('profile router invokes the host write coordinator for the real transaction and replay', async t => {
  const f = await runtime(t), { bootstrap } = await f.setupMember();
  // A separate mounted instance exercises the exact host hook without importing the global production store.
  const app = express(), server = createServer(app), calls = [];
  app.use(express.json());
  app.use('/api/v2', (req, _res, next) => {
    req.v2Identity = { service: f.identity, authenticate: async () => ({ actor: f.identity.actorForAccount(bootstrap.data.accountId) }),
      writeMember: async fn => { calls.push('queue'); const result = fn(); calls.push(['cache', result.current.profile.id]); return result; } }; next();
  }, createMemberSpaceRouter());
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  const operationId = randomUUID(), body = { expectedRevision: 1, displayName: 'coordinated write' };
  for (let i = 0; i < 2; i++) {
    const result = await fetch(`http://127.0.0.1:${server.address().port}/api/v2/me`, { method: 'PATCH',
      headers: { 'content-type': 'application/json', 'Idempotency-Key': operationId }, body: JSON.stringify(body) });
    assert.equal(result.status, 200); assert.equal((await result.json()).data.replayed, Boolean(i));
  }
  assert.deepEqual(calls, ['queue', ['cache', bootstrap.data.memberId], 'queue', ['cache', bootstrap.data.memberId]]);
});
