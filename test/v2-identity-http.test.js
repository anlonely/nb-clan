import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { createServer } from 'node:http';
import express from 'express';
import { installIdentitySchema, IdentityRepository } from '../server/v2/identity/repository.js';
import { planIdentityMigration, applyIdentityMigration } from '../server/v2/identity/migration.js';
import { IdentityService } from '../server/v2/identity/service.js';
import { AuthContexts } from '../server/v2/identity/contexts.js';
import { createIdentityRouter } from '../server/v2/identity/routes.js';
import { IdentityError } from '../server/v2/identity/errors.js';
import { rateLimit, __rateLimitForTests } from '../server/rate-limit.js';
import { createProviders } from '../server/v2/identity/providers.js';
import { legacyIdentityGuard, legacyRegistrationInteraction } from '../server/v2/identity/legacy.js';

const steamId = '76561198000000001';
async function runtime(t, store = { users: [], members: [] }, limiter) {
  const db = new DatabaseSync(':memory:'); installIdentitySchema(db); const repo = new IdentityRepository(db);
  for (const collection of ['users', 'members']) for (const row of store[collection] || []) repo.put(collection, row);
  applyIdentityMigration(repo, planIdentityMigration(store));
  for (const policy of repo.all('policies')) repo.put('policies', { ...policy, enabled: true, guildId: 'guild', allowedRoleIds: ['member'] });
  const state = { exchanges: 0, steamVerifications: 0, roleIds: ['member'], roleError: null, subject: 'subject1', steamId };
  const providers = Object.fromEntries(['discord', 'kook'].map(provider => [provider, {
    configured: () => true,
    authorizationUrl: token => `https://platform.invalid/?state=${token}`,
    async exchange() { state.exchanges++; await state.onExchange?.(provider); return { id: state.subject, provider, displayName: '测试成员' }; },
    async roles(externalId, guildId) { await state.onRoles?.(); if (state.roleError) throw state.roleError; return { externalId, guildId, roleIds: state.roleIds, community: { name: '测试服务器', iconUrl: null, roles: state.roleIds.map(id => ({ id, name: '角色 ' + id })), available: true } }; }
  }]));
  const steam = { authorizationUrl: url => `https://steam.invalid/?return_to=${encodeURIComponent(url)}`,
    async verify(query, returnTo) { state.steamVerifications++; assert.equal(query.returnTo, returnTo);
      await state.onSteamVerify?.();
      if (query.cancel) throw new IdentityError('AUTH_CANCELLED', 400); return state.steamId; } };
  const service = new IdentityService(repo, { providers });
  const contexts = new AuthContexts();
  const app = express(), server = createServer(app);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  app.use('/api/v2', createIdentityRouter({ service, origin, providers, steam, contexts, ...(limiter ? { rateLimit: limiter } : {}) }));
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); db.close(); });
  const jar = new Map();
  const request = async (path, { body, headers = {}, method = body ? 'POST' : 'GET', useJar = true } = {}) => {
    const response = await fetch(path.startsWith('http:') ? path : `${origin}/api/v2${path}`, { redirect: 'manual', method,
      headers: { ...(useJar ? { cookie: [...jar].map(([k, v]) => `${k}=${v}`).join('; ') } : {}), ...(body ? { 'content-type': 'application/json' } : {}), ...headers },
      ...(body ? { body: JSON.stringify(body) } : {}) });
    if (useJar) for (const item of response.headers.getSetCookie()) {
      const [key, value] = item.split(';')[0].split('='); value ? jar.set(key, value) : jar.delete(key);
    }
    return response;
  };
  async function oauth(provider = 'discord', returnTo = '/app/wipes/w1?tab=signup') {
    const start = await request(`/auth/${provider}/start?returnTo=${encodeURIComponent(returnTo)}`);
    assert.equal(start.status, 302);
    const token = new URL(start.headers.get('location')).searchParams.get('state');
    const callback = await request(`/auth/${provider}/callback?code=fixture&state=${token}`, { useJar: false });
    assert.equal(callback.status, 303); assert.equal(callback.headers.getSetCookie().length, 0);
    const finish = await request(callback.headers.get('location'));
    return { start, token, callback, finish };
  }
  async function bind() {
    const info = await (await request('/auth/continue')).json();
    const start = await request('/auth/steam/start', { body: {}, headers: { origin, 'x-csrf-token': info.data.csrfToken } });
    assert.equal(start.status, 200);
    const auth = await start.json(); const returnTo = new URL(auth.data.authorizationUrl).searchParams.get('return_to');
    const callback = await request(`${returnTo}&returnTo=${encodeURIComponent(returnTo)}`);
    return { callback, returnTo };
  }
  async function startSteam(returnPath = '/app/wipes/w1?tab=signup') {
    const start = await request(`/auth/steam/start?returnTo=${encodeURIComponent(returnPath)}`);
    assert.equal(start.status, 302);
    const returnTo = new URL(start.headers.get('location')).searchParams.get('return_to');
    return { returnTo, callbackUrl: `${returnTo}&returnTo=${encodeURIComponent(returnTo)}` };
  }
  return { service, repo, state, jar, origin, request, oauth, bind, startSteam, contexts };
}

const standaloneSteamStore = () => ({ users: [{ id: 'legacy', role: 'member', boundSteamId: steamId }],
  members: [{ id: 'member', steamId, memberStatus: 'active' }] });

test('existing-member Steam alone cannot create login access; verified community onboarding preserves member data', async t => {
  const member = { id: 'existing', steamId, memberStatus: 'active', discordId: 'recorded-discord', customName: '已有成员' };
  const f = await runtime(t, { users: [], members: [member] });
  const before = f.repo.get('members', member.id);
  const rejected = await f.request((await f.startSteam()).callbackUrl);
  assert.match(rejected.headers.get('location'), /error=PLATFORM_LOGIN_REQUIRED/);
  assert.deepEqual(f.repo.get('members', member.id), before);
  assert.equal(f.repo.all('accounts').length, 0); assert.equal(f.repo.all('sessions').length, 0);
  f.state.subject = 'recorded-discord'; await f.oauth(); await f.bind();
  assert.equal((await f.request('/auth/me')).status, 200);
  assert.equal(f.repo.get('members', member.id).customName, before.customName);
  for (const identity of f.repo.all('identities')) f.repo.remove('identities', identity.id);
  f.jar.delete('nb_v2_session');
  const unlinked = await f.request((await f.startSteam()).callbackUrl);
  assert.match(unlinked.headers.get('location'), /error=(IDENTITY_CONFLICT|PLATFORM_LOGIN_REQUIRED)/);
});

test('existing-member Steam compatibility rejects removed, restricted, conflicting and already-owned members', async t => {
  for (const mutate of [
    f => f.repo.remove('members', 'existing'),
    f => f.repo.put('members', { ...f.repo.get('members', 'existing'), memberStatus: 'left' }),
    f => f.repo.put('restrictions', { id: 'denied', memberId: 'existing', startsAt: '2020-01-01T00:00:00Z' }),
    f => f.repo.put('conflicts', { id: 'conflict', status: 'open', refs: ['existing'] }),
    f => f.repo.put('accounts', { id: 'disabled', status: 'disabled', memberId: 'existing' }),
    f => f.repo.put('users', { id: 'disabled', disabled: true, boundSteamId: steamId }),
    f => f.repo.put('bindings', { id: 'revoked', memberId: 'existing', steamId, status: 'revoked' })
  ]) {
    const f = await runtime(t, { users: [], members: [{ id: 'existing', steamId, memberStatus: 'active' }] });
    mutate(f); const before = f.repo.all('accounts');
    const response = await f.request((await f.startSteam()).callbackUrl);
    assert.match(response.headers.get('location'), /\/login\?error=/);
    assert.deepEqual(f.repo.all('accounts'), before); assert.equal(f.repo.all('sessions').length, 0);
  }
});

test('Steam login reuses a verified community binding and keeps stored migration grants unchanged', async t => {
  const f = await runtime(t, standaloneSteamStore());
  await f.oauth(); await f.bind();
  f.jar.delete('nb_v2_session'); f.repo.all('sessions').forEach(row => f.repo.remove('sessions', row.id));
  const before = f.repo.get('accounts', 'legacy');
  const providers = (await (await f.request('/auth/providers')).json()).data.providers;
  assert.deepEqual(providers.find(p => p.provider === 'steam'), { provider: 'steam', enabled: true, configured: true });
  const flow = await f.startSteam();
  const callback = await f.request(flow.callbackUrl);
  assert.equal(callback.headers.get('location'), `${f.origin}/app/wipes/w1?tab=signup`);
  assert.deepEqual(f.repo.get('accounts', 'legacy'), before);
  assert.equal(f.repo.all('accounts').length, 1); assert.equal(f.repo.all('members').length, 1);
  assert.equal(f.repo.all('bindings')[0].status, 'verified');
  assert.equal(f.repo.all('bindings')[0].proofSource, 'discord_steam_openid');
  assert.equal(f.repo.all('sessions')[0].identityProvider, 'discord');
  const me = await f.request('/auth/me'); assert.equal(me.status, 200);
  assert.equal((await me.json()).data.memberId, 'member');
  assert.equal((await f.request(flow.callbackUrl)).status, 410);
  assert.equal(f.state.steamVerifications, 2);
  const csrf = (await (await f.request('/auth/me')).json()).data.csrfToken;
  assert.equal((await f.request('/auth/logout', { body: {}, headers: { origin: f.origin, 'x-csrf-token': csrf } })).status, 200);
});

test('standalone Steam refuses cross-browser or wrong-purpose state and sanitizes the return path', async t => {
  const f = await runtime(t, standaloneSteamStore());
  const flow = await f.startSteam('https://attacker.invalid');
  assert.equal((await f.request(flow.callbackUrl, { useJar: false })).status, 401);
  assert.equal(f.state.steamVerifications, 0);
  const wrong = f.contexts.issue({ browser: f.jar.get('nb_v2_browser'), provider: 'steam', purpose: 'steam' });
  assert.equal((await f.request(`/auth/steam/login-callback?state=${wrong}`)).status, 401);
  const response = await f.request(flow.callbackUrl);
  assert.equal(response.headers.get('location'), `${f.origin}/login?error=PLATFORM_LOGIN_REQUIRED&returnTo=%2Fapp%2Fhome`);
});

test('standalone Steam never creates unknown accounts and cancellation leaves the binding unverified', async t => {
  const f = await runtime(t, standaloneSteamStore());
  const cancelled = await f.request(`${(await f.startSteam()).callbackUrl}&cancel=1`);
  assert.match(cancelled.headers.get('location'), /error=AUTH_CANCELLED/);
  assert.equal(f.repo.all('bindings')[0].status, 'legacy_unverified');
  f.state.steamId = '76561198000000002';
  const unknown = await f.request((await f.startSteam()).callbackUrl);
  assert.match(unknown.headers.get('location'), /error=PLATFORM_LOGIN_REQUIRED/);
  assert.equal(f.repo.all('accounts').length, 1); assert.equal(f.repo.all('members').length, 1);
  assert.equal(f.repo.all('sessions').length, 0);
});

test('standalone Steam preserves linked community eligibility and live revocation', async t => {
  const f = await runtime(t); await f.oauth(); await f.bind();
  f.jar.delete('nb_v2_session'); f.jar.delete('nb_v2_csrf');
  f.state.roleIds = [];
  const denied = await f.request((await f.startSteam()).callbackUrl);
  assert.match(denied.headers.get('location'), /error=ELIGIBILITY_DENIED/);
  assert.equal(f.jar.has('nb_v2_session'), false);
  f.state.roleIds = ['member'];
  const success = await f.request((await f.startSteam()).callbackUrl);
  assert.equal(success.headers.get('location'), `${f.origin}/app/wipes/w1?tab=signup`);
  assert.equal(f.repo.all('sessions').every(s => s.identityProvider === 'discord'), true);
  f.service.invalidateEligibility('discord', f.state.subject);
  assert.equal((await f.request('/auth/me')).status, 401);
});

test('standalone Steam refuses disabled, removed, restricted, revoked and ambiguous owners without upgrading bindings', async t => {
  for (const mutate of [
    f => f.repo.put('accounts', { ...f.repo.get('accounts', 'legacy'), status: 'disabled' }),
    f => f.repo.remove('members', 'member'),
    f => f.repo.put('restrictions', { id: 'restriction', memberId: 'member', startsAt: '2020-01-01T00:00:00Z' }),
    f => f.repo.put('bindings', { ...f.repo.all('bindings')[0], status: 'revoked' }),
    f => f.repo.put('bindings', { ...f.repo.all('bindings')[0], id: 'duplicate-owner', accountId: 'other' }),
    f => f.repo.put('bindings', { ...f.repo.all('bindings')[0], proofSource: 'legacy_conflict' })
  ]) {
    const f = await runtime(t, standaloneSteamStore()); mutate(f);
    const before = f.repo.all('bindings');
    const response = await f.request((await f.startSteam()).callbackUrl);
    assert.match(response.headers.get('location'), /\/login\?error=/);
    assert.equal(f.repo.all('sessions').length, 0);
    assert.deepEqual(f.repo.all('bindings'), before);
  }
});

test('community-bound Steam respects the disabled setting and context invalidation during verification', async t => {
  const f = await runtime(t, standaloneSteamStore());
  await f.oauth(); await f.bind();
  f.jar.delete('nb_v2_session'); f.repo.all('sessions').forEach(row => f.repo.remove('sessions', row.id));
  f.repo.setScalar('settings', { thirdPartyLogin: { steam: { enabled: false } } });
  assert.equal((await f.request('/auth/steam/start')).status, 503);
  assert.equal((await (await f.request('/auth/providers')).json()).data.providers.find(p => p.provider === 'steam').enabled, false);
  f.repo.setScalar('settings', {});
  f.state.onSteamVerify = () => f.contexts.clear();
  const response = await f.request((await f.startSteam()).callbackUrl);
  assert.match(response.headers.get('location'), /error=AUTH_CONTEXT_EXPIRED/);
  assert.equal(f.repo.all('sessions').length, 0);
  assert.equal(f.repo.all('bindings')[0].status, 'verified');
});

test('standalone Steam rechecks account revisions after community eligibility I/O', async t => {
  const f = await runtime(t); await f.oauth(); await f.bind();
  f.jar.delete('nb_v2_session');
  f.repo.all('sessions').forEach(s => f.repo.remove('sessions', s.id));
  f.state.onRoles = () => {
    const account = f.repo.all('accounts')[0]; f.repo.put('accounts', { ...account, revision: account.revision + 1 });
  };
  const response = await f.request((await f.startSteam()).callbackUrl);
  assert.match(response.headers.get('location'), /error=IDENTITY_CONFLICT/);
  assert.equal(f.repo.all('sessions').length, 0);
});

for (const invalidation of ['provider', 'all']) test(`consumed OAuth callback cannot recreate a handoff after ${invalidation} invalidation`, async t => {
  const f = await runtime(t);
  let release, entered;
  const waiting = new Promise(resolve => { entered = resolve; });
  f.state.onExchange = () => { entered(); return new Promise(resolve => { release = resolve; }); };
  const start = await f.request('/auth/discord/start');
  const token = new URL(start.headers.get('location')).searchParams.get('state');
  const pending = f.request(`/auth/discord/callback?code=x&state=${token}`, { useJar: false });
  await waiting;
  if (invalidation === 'provider') f.contexts.invalidateProvider('discord'); else f.contexts.clear();
  release();
  const response = await pending;
  assert.equal(response.status, 410);
  assert.equal((await response.json()).error.errorCode, 'AUTH_CONTEXT_EXPIRED');
  assert.equal(response.headers.get('location'), null);
  assert.equal(f.contexts.entries.size, 0);
  assert.equal(f.repo.all('accounts').length, 0);
});

for (const provider of ['discord', 'kook']) test(`${provider} HTTP login → onboarding → shared Steam → original URL → authenticated API`, async t => {
  const f = await runtime(t); await f.oauth(provider);
  assert.equal(f.jar.has('nb_v2_session'), false);
  assert.equal((await f.request('/members')).status, 401);
  const info = await (await f.request('/auth/continue')).json(); assert.equal(info.data.step, 'steam');
  assert.equal(info.data.community.name, '测试服务器');
  assert.deepEqual(info.data.community.roles, [{ id: 'member', name: '角色 member' }]);
  f.state.roleIds = ['member', 'extra'];
  assert.equal((await f.request('/auth/eligibility/retry', { body: {}, headers: { origin: f.origin, 'x-csrf-token': info.data.csrfToken } })).status, 200);
  assert.deepEqual((await (await f.request('/auth/continue')).json()).data.community.roles.map(r => r.id), ['member', 'extra']);
  assert.equal((await f.request('/auth/steam/start', { body: {}, headers: { origin: f.origin } })).status, 403);
  const { callback, returnTo } = await f.bind();
  assert.equal(callback.headers.get('location'), `${f.origin}/app/wipes/w1?tab=signup`);
  assert.equal(f.repo.all('accounts').length, 1);
  const me = await f.request('/auth/me'); assert.equal(me.status, 200); assert.equal(me.headers.get('cache-control'), 'no-store');
  const payload = await me.json(); assert.equal(payload.data.memberId, f.repo.all('members')[0].id);
  assert.equal((await f.request(`${returnTo}&returnTo=${encodeURIComponent(returnTo)}`)).status, 410);
  await f.oauth(provider); assert.equal(f.repo.all('members').length, 1);
  const csrf = (await (await f.request('/auth/me')).json()).data.csrfToken;
  assert.equal((await f.request('/auth/logout', { body: {}, headers: { origin: f.origin, 'x-csrf-token': csrf } })).status, 200);
  assert.equal((await f.request('/auth/me')).status, 401);
});
test('OAuth cancellation, replay, cross-browser ticket and purpose confusion are refused', async t => {
  const f = await runtime(t); const flow = await f.oauth();
  assert.equal((await f.request(`/auth/discord/callback?code=x&state=${flow.token}`)).status, 410);
  const start = await f.request('/auth/kook/start'); const state = new URL(start.headers.get('location')).searchParams.get('state');
  const cancelled = await f.request(`/auth/kook/callback?error=access_denied&state=${state}`, { useJar: false });
  assert.equal((await f.request(cancelled.headers.get('location'), { useJar: false })).status, 401);
  const finish = await f.request(cancelled.headers.get('location'));
  assert.equal(new URL(finish.headers.get('location')).searchParams.get('error'), 'AUTH_CANCELLED');
  assert.equal(f.repo.all('members').length, 0);
});

test('KOOK rate limit survives the OAuth handoff and shows its retry delay', async t => {
  const f = await runtime(t);
  f.state.roleError = new IdentityError('KOOK_RATE_LIMITED', 503, { retryAfterSeconds: 14 });
  const flow = await f.oauth('kook');
  assert.equal(new URL(flow.finish.headers.get('location')).searchParams.get('error'), 'KOOK_RATE_LIMITED');
  const response = await f.request('/auth/continue');
  assert.equal(response.status, 200);
  const data = (await response.json()).data;
  assert.equal(data.errorCode, 'KOOK_RATE_LIMITED');
  assert.equal(data.retryAfterSeconds, 14);
  assert.deepEqual(data.allowedActions, ['retry', 'cancel']);
  const retry = await f.request('/auth/eligibility/retry', { body: {},
    headers: { origin: f.origin, 'x-csrf-token': data.csrfToken } });
  assert.equal(retry.status, 503);
  assert.equal(retry.headers.get('retry-after'), '14');
  assert.equal((await retry.json()).error.errorCode, 'KOOK_RATE_LIMITED');
  assert.equal(f.repo.all('members').length, 0);
});

test('shared-IP login requests have separate browser budgets and a retry response', async t => {
  __rateLimitForTests.reset();
  t.after(() => __rateLimitForTests.reset());
  const f = await runtime(t, { users: [], members: [] }, rateLimit);
  const path = '/auth/providers', cookieA = `nb_v2_browser=${'A'.repeat(43)}`;
  for (let index = 0; index < 60; index++) assert.equal((await f.request(path, { headers: { cookie: cookieA } })).status, 200);
  const limited = await f.request(path, { headers: { cookie: cookieA } });
  assert.equal(limited.status, 429);
  assert.equal((await limited.json()).error.errorCode, 'AUTH_RATE_LIMITED');
  assert(Number(limited.headers.get('retry-after')) > 0);
  const start = await f.request('/auth/kook/start', { headers: { cookie: cookieA } });
  assert.equal(start.status, 303);
  assert.equal(new URL(start.headers.get('location')).searchParams.get('error'), 'AUTH_RATE_LIMITED');
  assert.equal((await f.request(path, { headers: { cookie: `nb_v2_browser=${'B'.repeat(43)}` } })).status, 200);
});

test('racing OAuth callbacks exchange a code once; expired context and forged mutation origin cannot bind', async t => {
  const f = await runtime(t);
  const start = await f.request('/auth/discord/start'); const token = new URL(start.headers.get('location')).searchParams.get('state');
  const results = await Promise.all([1, 2].map(() => f.request(`/auth/discord/callback?code=x&state=${token}`, { useJar: false })));
  assert.deepEqual(results.map(r => r.status).sort(), [303, 410]); assert.equal(f.state.exchanges, 1);
  await f.request(results.find(r => r.status === 303).headers.get('location'));
  const info = (await (await f.request('/auth/continue')).json()).data;
  assert.equal((await f.request('/auth/steam/start', { body: {}, headers: { origin: 'https://attacker.invalid', 'x-csrf-token': info.csrfToken } })).status, 403);
  for (const entry of f.contexts.entries.values()) entry.expiresAt = 0;
  assert.equal((await f.request('/auth/continue')).status, 410); assert.equal(f.repo.all('members').length, 0);
});

test('expired or revoked session cookies do not prevent restarting login or clearing local session', async t => {
  const f = await runtime(t); await f.oauth(); await f.bind();
  f.service.invalidateEligibility('discord', f.state.subject);
  assert.equal(f.jar.has('nb_v2_session'), true);
  const flow = await f.oauth(); assert.equal(flow.finish.status, 303);
  f.service.invalidateEligibility('discord', f.state.subject);
  const logout = await f.request('/auth/logout', { body: {}, headers: { origin: f.origin } });
  assert.equal(logout.status, 200); assert.equal(f.jar.has('nb_v2_session'), false);
});
test('role failures keep retry context and never create members or sessions', async t => {
  const f = await runtime(t); f.state.roleIds = [];
  const flow = await f.oauth(); assert.match(flow.finish.headers.get('location'), /ELIGIBILITY_DENIED/);
  const info = (await (await f.request('/auth/continue')).json()).data;
  assert.equal(info.step, 'eligibility'); assert.equal(f.repo.all('members').length, 0);
  f.state.roleError = new Error('timeout');
  const headers = { origin: f.origin, 'x-csrf-token': info.csrfToken };
  assert.equal((await f.request('/auth/eligibility/retry', { body: {}, headers })).status, 503);
  f.state.roleError = null; f.state.roleIds = ['member'];
  const retry = await f.request('/auth/eligibility/retry', { body: {}, headers }); assert.equal(retry.status, 200);
  assert.equal((await retry.json()).data.step, 'steam');
});
test('list, search, detail, export and event stream share scope and safe member projection', async t => {
  const f = await runtime(t); await f.oauth(); await f.bind();
  f.repo.put('members', { id: 'foreign', displayName: '别的小队', phone: 'secret-phone', notes: 'secret-note', membershipStatus: 'active' });
  for (const route of ['/members', '/members/export']) {
    const payload = await (await f.request(route)).json(); assert.equal(payload.data.members.length, 1);
    assert.equal(JSON.stringify(payload).includes('secret'), false);
  }
  assert.equal((await f.request('/members/foreign')).status, 404);
  assert.equal((await (await f.request('/members?q=别的')).json()).data.total, 0);
  const response = await f.request('/members/events'); const reader = response.body.getReader();
  const first = new TextDecoder().decode((await reader.read()).value);
  assert.match(first, /event: members/); assert.equal(first.includes('foreign'), false);
  f.service.invalidateEligibility('discord', f.state.subject);
  const next = new TextDecoder().decode((await reader.read()).value); assert.match(next, /authorization-revoked/);
  await reader.cancel();
  assert.equal((await f.request('/members')).status, 401);
});
test('real provider adapters encode OAuth requests, authenticate profiles and query configured guild roles', async () => {
  for (const provider of ['discord', 'kook']) {
    const calls = [];
    const config = { discord: { clientId: 'client', clientSecret: 'secret', redirectUri: 'https://local.test/api/v2/auth/discord/callback' },
      kook: { clientId: 'client', clientSecret: 'secret', redirectUri: 'https://local.test/api/v2/auth/kook/callback' } };
    const adapters = createProviders(config, { settings: async () => ({ settings: { [provider]: { botToken: 'bot' } } }), fetch: async (url, options) => {
      calls.push({ url, options });
      let payload;
      if (url.includes('/token')) payload = { access_token: 'transient', token_type: 'Bearer' };
      else if (url.includes('/@me') || url.includes('/user/me')) payload = provider === 'discord' ? { id: 'subject', username: 'local' } : { code: 0, data: { id: 'subject', username: 'local' } };
      else payload = provider === 'discord' ? { user: { id: 'subject' }, roles: ['role'] } : { code: 0, data: { id: 'subject', roles: [123] } };
      return { ok: true, json: async () => payload };
    } });
    assert.equal((await adapters[provider].exchange('code')).id, 'subject');
    assert.equal((await adapters[provider].roles('subject', 'configured-guild')).guildId, 'configured-guild');
    assert.equal(calls[0].options.headers['content-type'], 'application/x-www-form-urlencoded');
    assert.equal(calls[2].options.headers.authorization, 'Bot bot');
    assert.match(calls[2].url, /configured-guild/);
  }
});
test('legacy registration guards stop new cards, old modal/review writes, retaining read-only listing', () => {
  const old = process.env.NB_DISCORD_REGISTRATION_MODE; process.env.NB_DISCORD_REGISTRATION_MODE = 'legacy_readonly';
  try {
    for (const path of ['/third-party/admin/discord-member-applications/a/review', '/settings/discord/member-registration-card']) {
      let status; const res = { status(code) { status = code; return this; }, json(payload) { assert.equal(payload.mode, 'legacy_readonly'); } };
      legacyIdentityGuard({ path, method: 'POST' }, res, () => assert.fail('must stop write')); assert.equal(status, 410);
    }
    assert.equal(legacyRegistrationInteraction('nb_member_register:submit:pvp'), true);
    assert.equal(legacyRegistrationInteraction('nb_member_review:approve:id'), true);
    let next = false;
    legacyIdentityGuard({ path: '/third-party/admin/discord-member-applications', method: 'GET' }, {}, () => { next = true; });
    assert.equal(next, true);
  } finally { if (old === undefined) delete process.env.NB_DISCORD_REGISTRATION_MODE; else process.env.NB_DISCORD_REGISTRATION_MODE = old; }
});
