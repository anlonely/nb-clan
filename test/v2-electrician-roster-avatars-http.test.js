import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { createServer } from 'node:http';
import { createFixture } from './support/v2-notifications/fixture.js';
import { fixture as statsFixture } from './support/v2-stats/fixture.mjs';
import { PlatformAdminService } from '../server/v2/platform-admin/service.js';
import { createElectricianAvatars } from '../server/v2/platform-admin/electrician-avatars.js';
import { installPlatformAdminSchema } from '../server/v2/platform-admin/repository.js';
import { installMemberAdminSchema } from '../server/v2/member-admin/repository.js';
import { installSyncCenterSchema } from '../server/v2/sync-center/repository.js';
import { installRealtimeSchema } from '../server/v2/realtime/repository.js';
import { createPlatformAdminRouter } from '../server/v2/platform-admin/routes.js';
import { createIdentityRouter } from '../server/v2/identity/routes.js';
import { createManagementRuntime } from '../server/v2/management-runtime/index.js';
import { grant } from '../server/v2/identity/permissions.js';
import { upsertSqliteCollectionRecord } from '../server/storage/sqlite-migrate.js';

const steamId = '76561198000000001';
const avatar = `https://avatars.steamstatic.com/${'a'.repeat(40)}_full.jpg`;
const freshAvatar = `https://avatars.cloudflare.steamstatic.com/${'b'.repeat(40)}_full.jpg`;
const profile = `https://steamcommunity.com/profiles/${steamId}/`;
const vanity = 'https://steamcommunity.com/id/roster-electrician/';
const xml = (id = steamId, image = avatar) => `<profile><steamID64>${id}</steamID64><avatarFull><![CDATA[${image}]]></avatarFull></profile>`;
const manual = (url, name = 'Manual electrician', group = 'CN') => ({ kind: 'manual', group, name, url });

async function setup(t, options = {}) {
  const f = createFixture({ adminRole: true });
  installPlatformAdminSchema(f.db);
  f.identity.repo.put('members', { id: 'admin-member', steamId, memberStatus: 'active', customName: 'Selected member' });
  f.identity.repo.put('members', { id: 'unselected-member', steamId: '76561198000000002', memberStatus: 'active', customName: 'Unselected member' });
  f.identity.repo.put('accounts', { ...f.identity.repo.get('accounts', 'admin'), memberId: 'admin-member' });
  f.identity.repo.put('bindings', { id: 'admin-binding', accountId: 'admin', memberId: 'admin-member', steamId, status: 'verified' });
  f.identity.repo.put('identities', { id: 'discord-admin', accountId: 'admin', provider: 'discord', externalId: 'demo-admin' });
  f.identity.repo.put('policies', { id: 'discord', provider: 'discord', enabled: true, guildId: '1554983512321425488', allowedRoleIds: ['demo-role'], matchMode: 'any', policyRevision: 1 });
  f.identity.providers = { discord: { roles: async externalId => ({ externalId, guildId: '1554983512321425488', roleIds: ['demo-role'] }) } };
  const evidence = await f.identity.checkEligibility('discord', 'demo-admin');
  const session = f.identity.issueSession(f.identity.repo.get('accounts', 'admin'), evidence);
  const calls = [];
  const reader = options.reader || createElectricianAvatars({
    ...options.avatarOptions,
    fetchImpl: options.fetchImpl || (async url => { calls.push(url); return new Response(xml()); })
  });
  const service = new PlatformAdminService({ identity: f.identity, electricianAvatars: reader });
  const saveRoster = (entries, revision = 1) => service.repo.put('electrician-roster', 'shared', 'shared', 'admin', 1, { revision, entries, updatedAt: '2030-09-08T10:00:00Z' });
  saveRoster(options.entries || [manual(profile), manual(vanity, 'Vanity electrician', 'EU')]);
  const app = express(), server = createServer(app);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const auth = createIdentityRouter({ service: f.identity, origin });
  app.use('/api/v2', (req, res, next) => { req.v2Identity = { service: f.identity, authenticate: input => auth.authenticate(input)(req) }; next(); });
  app.use('/api/v2', auth, createPlatformAdminRouter({ getSystem: () => ({ service }) }));
  const headers = { Cookie: `nb_v2_session=${session.token}`, Origin: origin, 'X-CSRF-Token': session.csrfToken };
  const get = async (authenticated = true) => {
    const response = await fetch(`${origin}/api/v2/platform-admin/electricians`, { headers: authenticated ? headers : {} });
    return { status: response.status, body: await response.json(), cache: response.headers.get('cache-control') };
  };
  t.after(async () => { await auth.stopEvents(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); await reader.stop?.(); f.close(); });
  return { ...f, reader, service, saveRoster, calls, get, headers, origin,
    changes: () => f.db.prepare('SELECT total_changes() n').get().n };
}

test('management GET fetches missing numeric and vanity avatars after authentication, without writes or fetching unselected members', async t => {
  const f = await setup(t), before = f.changes();
  assert.equal((await f.get(false)).status, 401);
  assert.deepEqual(f.calls, []);
  const result = await f.get();
  assert.equal(result.status, 200); assert.equal(result.cache, 'no-store');
  assert.equal(result.body.data.resolved.china[0].avatar, avatar);
  assert.equal(result.body.data.resolved.foreign[0].avatar, avatar);
  assert.equal(result.body.data.members.find(member => member.id === 'admin-member').avatar, avatar);
  assert.equal(result.body.data.members.find(member => member.id === 'unselected-member').avatar, '');
  assert.deepEqual(f.calls.sort(), [`${profile}?xml=1`, `${vanity}?xml=1`].sort());
  assert.equal(f.changes(), before);
  await f.get(); assert.equal(f.calls.length, 2);
});

test('optional avatar failures, unsafe URLs and fetch timeouts leave the roster usable', async t => {
  for (const kind of ['throw', 'unsafe', 'timeout']) {
    await t.test(kind, async sub => {
      const f = await setup(sub, kind === 'throw' ? { reader: { read: async () => { throw new Error('private provider detail'); } } }
        : { avatarOptions: { timeoutMs: 15, waitMs: 100 }, fetchImpl: kind === 'unsafe'
          ? async () => new Response(xml(steamId, 'https://unsafe.example/private-avatar.jpg'))
          : (_url, { signal }) => new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(new Error('timeout')), { once: true })) });
      const before = f.changes(), result = await f.get();
      assert.equal(result.status, 200);
      assert.ok(Object.values(result.body.data.resolved).flat().every(row => row.avatar === ''));
      assert.equal(f.changes(), before);
      assert.ok(!JSON.stringify(result.body).includes('private provider detail'));
    });
  }
});

test('awaited avatar enrichment follows the current roster revision and never returns removed rows', async t => {
  let enter, release;
  const entered = new Promise(resolve => { enter = resolve; }), gate = new Promise(resolve => { release = resolve; });
  const f = await setup(t, { fetchImpl: async () => { enter(); await gate; return new Response(xml()); } });
  const request = f.get(); await entered;
  f.saveRoster([manual(profile, 'Current renamed electrician')], 2);
  release(); const result = await request;
  assert.equal(result.status, 200); assert.equal(result.body.data.revision, 2);
  assert.equal(result.body.data.resolved.china[0].name, 'Current renamed electrician');
  assert.equal(result.body.data.resolved.china[0].avatar, avatar);
  assert.deepEqual(result.body.data.resolved.foreign, []);
  assert.ok(!JSON.stringify(result.body.data).includes(vanity));
});

test('permission changes during avatar waits filter hidden members and deny revoked platform access', async t => {
  for (const revokePlatform of [false, true]) {
    await t.test(revokePlatform ? 'platform scope revoked' : 'member scope revoked', async sub => {
      let enter, release;
      const entered = new Promise(resolve => { enter = resolve; }), gate = new Promise(resolve => { release = resolve; });
      const f = await setup(sub, { entries: [{ kind: 'member', group: 'CN', memberId: 'admin-member' }],
        fetchImpl: async () => { enter(); await gate; return new Response(xml()); } });
      const request = f.get(); await entered;
      const original = f.identity.actorForAccount.bind(f.identity);
      f.identity.actorForAccount = id => ({ ...original(id), grants: [
        grant('platforms.read', revokePlatform ? { type: 'platformTargets', ids: ['kook'] } : { type: 'all' }),
        { capability: 'members.read', scope: { type: 'all' }, effect: 'deny' }
      ] });
      release(); const result = await request;
      if (revokePlatform) { assert.equal(result.status, 403); assert.equal(result.body.error.errorCode, 'ACCESS_DENIED'); }
      else {
        assert.equal(result.status, 200); assert.deepEqual(result.body.data.entries, []);
        assert.deepEqual(result.body.data.resolved, { china: [], foreign: [] }); assert.deepEqual(result.body.data.members, []);
        assert.equal(result.body.data.hasRestrictedSources, true); assert.equal(result.body.data.canConfigure, false);
        assert.ok(!JSON.stringify(result.body.data).includes(steamId));
      }
    });
  }
});

test('fresh local cached avatars take precedence and synchronous saves keep revision and retry contracts', async t => {
  let enter, release;
  const entered = new Promise(resolve => { enter = resolve; }), gate = new Promise(resolve => { release = resolve; });
  const f = await setup(t, { fetchImpl: async () => { enter(); await gate; return new Response(xml()); } });
  const request = f.get(); await entered;
  upsertSqliteCollectionRecord(f.db, 'memberProfiles', 'current-profile', { id: 'current-profile', memberId: 'admin-member', steamId, avatar: freshAvatar });
  const input = { expectedRevision: 1, entries: [manual(profile)] }, postHeaders = { ...f.headers, 'Content-Type': 'application/json', 'Idempotency-Key': 'avatar-independent-save' };
  const post = async (headers = postHeaders) => {
    const response = await fetch(`${f.origin}/api/v2/platform-admin/electricians`, { method: 'POST', headers, body: JSON.stringify(input) });
    return { status: response.status, body: await response.json() };
  };
  // The GET's provider request is still pending; saving uses no avatar wait.
  const saved = await post(); assert.equal(saved.status, 200); assert.equal(saved.body.data.revision, 2);
  assert.equal(saved.body.data.current.resolved.china[0].avatar, freshAvatar);
  assert.equal((await post()).body.data.revision, 2);
  assert.equal((await post({ ...postHeaders, 'Idempotency-Key': 'new-save' })).body.error.errorCode, 'REVISION_CONFLICT');
  release(); const result = await request;
  assert.equal(result.status, 200); assert.equal(result.body.data.revision, 2);
  assert.equal(result.body.data.resolved.china[0].avatar, freshAvatar);
  assert.equal(result.body.data.members.find(member => member.id === 'admin-member').avatar, freshAvatar);
});

test('management runtime passes its existing bounded avatar reader to the administration service', async t => {
  const f = statsFixture();
  installMemberAdminSchema(f.db); installSyncCenterSchema(f.db); installRealtimeSchema(f.db); installPlatformAdminSchema(f.db);
  let calls = 0, checking = true;
  const runtime = createManagementRuntime({ getIdentity: () => f.identity,
    runStoreWriteTask: fn => { if(checking)throw new Error('Avatar GET must not write');return fn(); }, patchStoreCache: () => { throw new Error('Avatar GET must not patch'); },
    electricianAvatarOptions: { fetchImpl: async () => { calls++; return new Response(xml()); } } });
  t.after(async () => { checking=false;await runtime.stop(); f.db.close(); });
  const service = runtime.getSystem(f.identity).platforms.service;
  service.repo.put('electrician-roster', 'shared', 'shared', 'fixture-admin', 1, { revision: 1, entries: [manual(vanity)] });
  const before = f.db.prepare('SELECT total_changes() n').get().n;
  const detail = await service.electricianRosterDetailWithAvatars(f.identity.actorForAccount('g05_account_admin'));
  assert.equal(detail.resolved.china[0].avatar, avatar); assert.equal(calls, 1);
  assert.equal(f.db.prepare('SELECT total_changes() n').get().n, before);
});
