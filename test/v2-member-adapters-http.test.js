import { authenticatedSession } from './support/authenticated-session.mjs';
import './support/owner-environment.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { fixture } from './support/v2-member-adapters/fixture.mjs';
import { createIdentityRouter } from '../server/v2/identity/routes.js';
import { createMemberAdminRouter } from '../server/v2/member-admin/routes.js';
import { createRealtimeRouter } from '../server/v2/realtime/routes.js';
import { createMemberAdapterObservationRouter } from '../server/v2/management-adapters/members/index.js';
import { installPlatformAdminSchema } from '../server/v2/platform-admin/repository.js';
import { PlatformAdminService } from '../server/v2/platform-admin/service.js';
import { createPlatformAdminRouter } from '../server/v2/platform-admin/routes.js';
import { defaultRules } from '../server/v2/member-admin/risk.js';
import { OWNER_STEAM_ID } from '../server/v2/identity/permissions.js';

async function runtime(t, { authorizeRoot = false } = {}) {
  const x = fixture(), app = express(), server = createServer(app);
  let rootEvidence;
  if (authorizeRoot) {
    x.ir.put('members', { ...x.ir.get('members', 'm003'), steamId: OWNER_STEAM_ID });
    x.ir.put('accounts', { ...x.ir.get('accounts', 'root'), memberId: 'm003' });
    x.ir.put('bindings', { id: 'binding-root', accountId: 'root', memberId: 'm003', steamId: OWNER_STEAM_ID, status: 'verified' });
    x.ir.put('identities', { id: 'root-kook', accountId: 'root', provider: 'kook', externalId: 'root-kook', revision: 1 });
    x.ir.put('policies', { id: 'kook', provider: 'kook', enabled: true, guildId: 'fixture-guild', allowedRoleIds: ['eligible'], matchMode: 'any', defaultRoleId: 'member', policyRevision: 1 });
    x.identity.providers = { kook: { roles: async (externalId, guildId) => ({ externalId, guildId, roleIds: ['eligible'] }) } };
    rootEvidence = await x.identity.checkEligibility('kook', 'root-kook');
  }
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  x.origin = `http://127.0.0.1:${server.address().port}`;
  const ir = createIdentityRouter({ service: x.identity, origin: x.origin, providers: {}, contexts: x.contexts });
  installPlatformAdminSchema(x.db);
  const platforms = new PlatformAdminService({ identity: x.identity, adapters: x.bridges.platform, now: x.identity.now });
  app.use('/api/v2', (req, res, next) => { req.v2Identity = { service: x.identity,
    authenticate: options => ir.authenticate(options)(req) }; next(); });
  app.use('/api/v2', ir,
    createMemberAdapterObservationRouter({ getRuntime: () => x.runtime }),
    createMemberAdminRouter({ getService: () => x.service, writeDomain: x.runtime.writeDomain }),
    createPlatformAdminRouter({ getSystem: () => ({ service: platforms }) }),
    createRealtimeRouter({ repository: x.realtime.repo, members: x.realtime.members, now: x.identity.now,
      authorizeLegacyAction: a => a.id === 'admin' }));
  const sessions = {};
  for (const id of ['admin', 'root', 'member', 'viewer']) sessions[id] = await authenticatedSession(x.identity, id);
  x.request = async (path, { actor = 'admin', body, headers = {}, method = body ? 'POST' : 'GET', key = randomUUID() } = {}) => {
    const session = sessions[actor];
    const res = await fetch(x.origin + '/api/v2' + path, { method, headers: {
      ...(session ? { cookie: `nb_v2_session=${session.token}`, 'x-csrf-token': session.csrfToken } : {}),
      origin: x.origin, 'content-type': 'application/json', 'Idempotency-Key': key, ...headers },
      ...(body ? { body: JSON.stringify(body) } : {}) });
    return { status: res.status, body: await res.json(), headers: res.headers };
  };
  t.after(async () => { await ir.stopEvents(); server.closeAllConnections();
    await new Promise(resolve => server.close(resolve)); x.db.close(); });
  return x;
}

test('one member unlink submission revokes all target login sessions and preserves other members', async t => {
  for (const provider of ['wechat', 'discord', 'kook']) {
    const x = await runtime(t, { authorizeRoot: true }), member = x.ir.get('members', 'm002');
    const externalId = `${provider}-member`;
    x.ir.put('members', { ...member, ...(provider === 'wechat' ? { wechatUserId: 'wx-unlink', wechatId: 'wx-unlink' } : { [`${provider}Id`]: externalId }) });
    if (provider === 'wechat') x.ir.put('wechatUsers', { id: 'wx-unlink', memberId: member.id, appId: 'app-unlink', openid: externalId, status: 'approved', revision: 1 });
    x.ir.put('identities', { id: 'unlink-identity', accountId: 'member', provider: provider === 'wechat' ? 'wechat:app-unlink' : provider, externalId, revision: 1 });
    const secondSession = await authenticatedSession(x.identity, 'member');
    const unrelatedSession = await authenticatedSession(x.identity, 'other');
    const observation = await x.request(`/member-adapters/members/m002/unlink-observation?provider=${provider}`, { actor: 'root' });
    assert.equal(observation.status, 200, `${provider}: ${JSON.stringify(observation.body)}`);
    const key = randomUUID(), path = '/member-admin/members/m002/unlink';
    const body = { ...observation.body.data, provider };
    const result = await x.request(path, { actor: 'root', body, key });
    assert.equal(result.status, 200, provider);
    assert.equal(result.body.data.revoked, true, provider);
    assert.equal((await x.request('/member-admin/members/m002', { actor: 'member' })).status, 401, provider);
    assert.throws(() => x.identity.session(secondSession.token), e => e.errorCode === 'AUTH_REQUIRED', provider);
    assert.ok(x.identity.session(unrelatedSession.token), provider);
    assert.equal(x.ir.get('identities', 'unlink-identity'), null, provider);
    assert.equal(x.ir.get('bindings', 'binding-member').status, 'verified', provider);
    assert.equal((await x.request(path, { actor: 'root', body, key })).body.data.replayed, true, provider);
  }
});

test('retired review HTTP stays unavailable for every caller and never mutates applications', async t => {
  const x = await runtime(t), before = x.service.repo.all('joinApplications');
  for (const actor of ['anonymous', 'admin', 'viewer']) {
    const result = await x.request('/member-admin/reviews/review1', { actor, body: { expectedRevision: 1, status: 'approved' } });
    assert.equal(result.status, 410);
  }
  assert.deepEqual(x.service.repo.all('joinApplications'), before);
});
test('retired platform review stays unavailable; fingerprinted unlink uses MemberAdminService and revokes sessions', async t => {
  const x = await runtime(t);
  const review = await x.request('/platform-admin/wechat/actions/review', { body: { expectedRevision: 0,
    expectedApplicationRevision: 1, provider: 'wechat', applicationId: 'review1', status: 'approved' } });
  assert.equal(review.status, 404);
  x.ir.put('members', { ...x.ir.get('members', 'm002'), discordId: 'discord-member' });
  x.ir.put('identities', { id: 'discord-member', accountId: 'member', provider: 'discord', externalId: 'discord-member', revision: 1 });
  const observation = await x.request('/member-adapters/members/m002/unlink-observation?provider=discord');
  assert.equal(observation.status, 200);
  assert.deepEqual(Object.keys(observation.body.data).sort(), ['expectedIdentityFingerprint', 'expectedRevision', 'memberId', 'provider']);
  const key = randomUUID(), body = { expectedRevision: 0, expectedMemberRevision: 1,
    expectedIdentityFingerprint: observation.body.data.expectedIdentityFingerprint, memberId: 'm002', provider: 'discord', reason: '隔离解绑' };
  const result = await x.request('/platform-admin/discord/actions/unbind', { body, key });
  assert.equal(result.body.data.status, 'succeeded');
  assert.equal((await x.request('/platform-admin/discord/actions/unbind', { body, key })).body.data.replayed, true);
  assert.equal((await x.request('/member-admin/members/m002', { actor: 'member' })).status, 401);
});
test('HTTP observation shares unlink capability checks, and missing/changed identity fingerprint never writes', async t => {
  const x = await runtime(t);
  assert.equal((await x.request('/member-adapters/members/m002/unlink-observation?provider=discord', { actor: 'viewer' })).status, 403);
  x.ir.put('members', { ...x.ir.get('members', 'm002'), discordId: 'discord-member' });
  x.ir.put('identities', { id: 'di', provider: 'discord', accountId: 'member', externalId: 'discord-member', revision: 1 });
  const observation = await x.request('/member-adapters/members/m002/unlink-observation?provider=discord');
  x.ir.put('identities', { ...x.ir.get('identities', 'di'), revision: 2 });
  const args = { expectedRevision: 0, expectedMemberRevision: 1, memberId: 'm002', provider: 'discord', reason: '隔离解绑' };
  const missing = await x.request('/platform-admin/discord/actions/unbind', { body: args });
  assert.equal(missing.body.data.errorCode, 'IDENTITY_OBSERVATION_REQUIRED');
  const changed = await x.request('/platform-admin/discord/actions/unbind', { body: { ...args, expectedIdentityFingerprint: observation.body.data.expectedIdentityFingerprint } });
  assert.equal(changed.body.data.errorCode, 'IDENTITY_OBSERVATION_CHANGED');
  assert.equal(x.ir.get('identities', 'di').revision, 2); assert.equal(x.ir.get('members', 'm002').revision, 1);
});
test('HTTP risk settings persist only for trusted root and preserve private response boundary', async t => {
  const x = await runtime(t, { authorizeRoot: true }), body = { expectedRevision: 1, rules: defaultRules(), squadFilter: '' };
  assert.equal((await x.request('/member-admin/risk-rules', { body })).status, 403);
  assert.equal((await x.request('/member-admin/risk-rules', { body, actor: 'root' })).status, 200);
  assert.equal(x.ir.scalar('settings').accountRisk.revision, 2);
});
test('HTTP realtime import/replay and stale observation use real scope revision; no duplicate Steam member', async t => {
  const x = await runtime(t), path = '/realtime/scope-one/commands/import-member';
  const body = { steamId: '76561198999999888', squadId: 's1', expectedRevision: 7 }, key = randomUUID();
  const r = await x.request(path, { body, key }); assert.equal(r.status, 200); assert.equal(r.body.data.current.revision, 1);
  assert.equal((await x.request(path, { body, key })).body.data.replayed, true);
  assert.equal((await x.request(path, { body })).body.error.errorCode, 'MEMBER_EXISTS');
  x.advance(120001);
  assert.equal((await x.request(path, { body })).body.error.errorCode, 'REALTIME_OBSERVATION_EXPIRED');
});
test('HTTP sync bridge creates audit jobs and rejects expanded status scope', async t => {
  const x = await runtime(t), body = { kind: 'steam', memberIds: ['m001'] };
  const r = await x.request('/member-admin/sync/request', { body }); assert.equal(r.status, 200);
  const jobId = r.body.data.job.id;
  const state = await x.request('/member-admin/sync/status', { body: { ...body, jobId } });
  assert.equal(state.body.data.status, 'queued');
  assert.equal((await x.request('/member-admin/sync/status', { body: { ...body, memberIds: ['m001', 'm002'], jobId } })).status, 403);
  const audit = await x.request('/member-admin/sync/request', {body:{kind:'discordMembershipAudit',memberIds:['m001']}});
  assert.equal(audit.status,200);
  assert.equal(audit.body.data.job.type,'discord_membership_audit');
  assert.equal(audit.body.data.job.status,'queued');
});
