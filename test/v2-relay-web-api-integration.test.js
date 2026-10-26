import './support/owner-environment.mjs';
import './support/v2-source-main/offline.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { IdentityRepository, installIdentitySchema } from '../server/v2/identity/repository.js';
import { IdentityService } from '../server/v2/identity/service.js';
import { OWNER_STEAM_ID } from '../server/v2/identity/permissions.js';
import { createLegacyManagementAuthority } from '../server/v2/management-runtime/legacy-authority.js';
import { RealtimeRepository, installRealtimeSchema } from '../server/v2/realtime/repository.js';
import { RealtimeService } from '../server/v2/realtime/service.js';
import { createProductionRelayIngress } from '../server/v2/production/relay.js';
import { createProductionRustgoWebApi } from '../server/v2/production/rustgo-web-api.js';
import { rustgoSourceId } from '../server/v2/relay-admin/web-api-worker.js';

const clone = value => structuredClone(value);
const iso = value => new Date(value).toISOString();
const deferred = () => { let resolve; return { promise: new Promise(done => { resolve = done; }), resolve }; };
const serverId = 'integration-server';
const playerId = '76561198000000001';

function fixture(t, configOverrides = {}) {
  const db = new DatabaseSync(':memory:'); installIdentitySchema(db); installRealtimeSchema(db);
  const ir = new IdentityRepository(db), repository = new RealtimeRepository(db);
  ir.setScalar('v2IdentityMigration', { isolated: true });
  ir.put('members', { id: 'owner-member', steamId: OWNER_STEAM_ID, membershipStatus: 'active', revision: 1 });
  ir.put('accounts', { id: 'owner', memberId: 'owner-member', roleId: 'admin', status: 'active', permissionVersion: 1, revision: 1 });
  ir.put('bindings', { id: 'owner-binding', accountId: 'owner', memberId: 'owner-member', steamId: OWNER_STEAM_ID, status: 'verified', revision: 1 });
  ir.put('accounts', { id: 'admin', memberId: null, roleId: 'admin', adminAssignedByOwner: true, status: 'active', permissionVersion: 1, revision: 1 });
  ir.put('accounts', { id: 'member', memberId: null, roleId: 'member', status: 'active', permissionVersion: 1, revision: 1 });
  const identity = new IdentityService(ir), authority = createLegacyManagementAuthority(identity);
  const realtime = new RealtimeService(identity, { repository, authorizeLegacyAction: authority.authorizeRealtimeAction, sourceReset: ({ apply }) => apply() });
  const timestamp = Date.now();
  let config = { revision: 1, baseUrl: 'https://integration-rustgo.example.test/api/v1', tenantId: '', apiKey: 'fixture-integration-rustgo-key',
    serverIds: [serverId], infoEnabled: true, chatEnabled: true, updatedAt: iso(timestamp - 120000),
    chatStartAt: iso(timestamp - 120000), serverActivatedAt: { [serverId]: iso(timestamp - 120000) }, ...configOverrides };
  let clan = { state: 'observed', rustServerId: serverId, channel: 'clan', clanId: '12345678901234567', name: 'RSG', motd: '北门集合', maxMemberCount: 100,
    observedAt: iso(timestamp - 1000), staleAfter: iso(timestamp + 60000),
    members: [{ steamId: playerId, name: '队员甲', role: 'leader', online: true, lastSeenAt: null }] };
  let messages = [{ id: 'chat-one', rustServerId: serverId, channel: 'clan', direction: 'inbound', targetVersion: 7,
    message: '北门有人', messageTime: iso(timestamp - 10000), authorSteamId: playerId, authorName: '队员甲' }];
  let running = true, accepting = true, activeOperations = 0, nextBarrier, tail = Promise.resolve();
  let invites = [];
  const calls = { list: 0, clan: 0, invites: 0, chat: 0 }, workers = [];
  const serializeWrite = fn => {
    const barrier = nextBarrier; nextBarrier = null;
    const work = tail.then(async () => { if (barrier) { barrier.entered.resolve(); await barrier.release.promise; } return fn(); });
    tail = work.catch(() => {}); return work;
  };
  const runOperation = async fn => { activeOperations++; try { return await fn(); } finally { activeOperations--; } };
  const ingestRelay = createProductionRelayIngress({ getRepository: () => repository, runOperation, serializeWrite, isAccepting: () => accepting });
  const client = {
    async listServers() { calls.list++; return { items: running ? [{ id: serverId, name: 'Atlas Integration', state: 'running', clanAvailable: true, targetVersion: 7, primaryPairingId: 'pairing-1' }] : [] }; },
    async readClan() { calls.clan++; return clone(clan); },
    async readInvites() { calls.invites++; return { items: clone(invites), hasMore: false }; },
    async readChat() { calls.chat++; return { items: clone(messages), hasMore: false }; }
  };
  const create = () => {
    const worker = createProductionRustgoWebApi({ identity, repository, configuration: { readPrivate: () => clone(config) }, client, ingestRelay, runOperation, serializeWrite });
    workers.push(worker); return worker;
  };
  t.after(async () => { for (const worker of workers) await worker.stop(); accepting = false; await tail; assert.equal(activeOperations, 0); db.close(); });
  const worker = create(), actor = id => identity.actorForAccount(id), scope = () => repository.scopes()[0];
  return { db, ir, repository, realtime, worker, create, calls, actor, scope,
    sourceId: () => rustgoSourceId(config), config: () => clone(config), clan: () => clone(clan), messages: () => clone(messages),
    update(patch) { config = { ...config, revision: config.revision + 1, ...patch }; },
    setClan(patch) { clan = { ...clan, ...patch }; }, setMessages(items) { messages = clone(items); },
    setInvites(items) { invites = clone(items); }, pause() { running = false; },
    holdNextWrite() { const barrier = { entered: deferred(), release: deferred() }; nextBarrier = barrier; return barrier; },
    records() { return db.prepare("SELECT * FROM v2_realtime_records WHERE kind='chat' ORDER BY seq").all(); },
    progress() { return ir.scalar('v2RustgoWebApiProgress'); },
    async command(action) { const current = scope(); return realtime.command(actor('owner'), current.id, action,
      { expectedRevision: current.revision, reason: 'Integration fixture clear/reset' }, randomUUID()); }
  };
}

test('production Web API worker writes canonical SQLite snapshots/chat with current owner visibility and durable deduplication', async t => {
  const f = fixture(t); assert.equal(f.actor('owner').roleId, 'owner');
  await f.worker.tick(); assert.equal(f.worker.status().state, 'ok');
  const scope = f.scope(); assert.equal(scope.source, f.sourceId()); assert.equal(scope.server, `${f.sourceId()}:${serverId}`);
  assert.deepEqual(scope.resource, { kind: 'system', id: 'relay_unassigned' });
  assert.equal(scope.snapshot.clan.name, 'RSG'); assert.equal(scope.snapshot.clan.announcement, '北门集合');
  assert.equal(scope.snapshot.expiresAt, f.clan().staleAfter);
  assert.equal(scope.snapshot.members[0].displayName, '队员甲'); assert.equal(scope.snapshot.members[0].steamId, playerId);
  assert.equal(f.realtime.summary(f.actor('owner'), scope.id).status, 'fresh');
  assert.equal(f.realtime.summary(f.actor('owner'), scope.id).counts.online, 1);
  assert.equal(f.realtime.page(f.actor('owner'), scope.id).items[0].message, '北门有人');
  assert.deepEqual(f.realtime.catalog(f.actor('owner')).items.map(row => row.id), [scope.id]);
  for (const id of ['admin', 'member']) {
    assert.deepEqual(f.realtime.catalog(f.actor(id)), { items: [], sourceStatus: 'unavailable' });
    assert.throws(() => f.realtime.summary(f.actor(id), scope.id), { errorCode: 'ACCESS_DENIED' });
    assert.throws(() => f.realtime.page(f.actor(id), scope.id), { errorCode: 'ACCESS_DENIED' });
  }
  await f.worker.tick(); await f.worker.stop();
  const restarted = f.create(); await restarted.tick();
  assert.equal(f.records().length, 1); assert.equal(f.repository.scopes().length, 1);
  assert.equal(f.db.prepare('SELECT count(*) n FROM v2_realtime_seen').get().n, 1);
  assert.equal(f.progress().sourceId, f.sourceId()); assert.equal(f.progress().servers[serverId].window, null);
  assert.ok(!JSON.stringify([f.scope(), f.records(), f.progress(), restarted.status()]).includes(f.config().apiKey));
});

test('upstream roster avatar survives relay normalization, SQLite storage and repeated summary reads', async t => {
  const f = fixture(t, { chatEnabled: false });
  const avatar = 'https://avatars.steamstatic.com/fixture-player-avatar_full.jpg';
  f.setClan({ members: f.clan().members.map(member => ({ ...member, avatarUrl: `  ${avatar}  ` })) });
  await f.worker.tick(); assert.equal(f.worker.status().state, 'ok');
  const scope = f.scope();
  assert.equal(f.db.prepare("SELECT json_extract(snapshot,'$.members[0].avatar') avatar FROM v2_realtime_scopes WHERE id=?").get(scope.id).avatar, avatar);
  const upstreamCalls = clone(f.calls);
  assert.equal(f.realtime.summary(f.actor('owner'), scope.id).members[0].avatar, avatar);
  assert.equal(f.realtime.summary(f.actor('owner'), scope.id).members[0].avatar, avatar);
  assert.deepEqual(f.calls, upstreamCalls);
});

test('Web API invitations retain upstream identity, update status and respect source reset', async t => {
  const f = fixture(t, { chatEnabled: false }), base = Date.now() - 60000;
  const invite = { id: 'upstream-invite-1', inviterSteamId: OWNER_STEAM_ID, inviterName: '邀请人',
    inviteeSteamId: playerId, inviteeName: '受邀人', status: 'pending', invitedAt: null,
    firstSeenAt: iso(base), updatedAt: iso(base), lastObservedAt: iso(base), acceptedAt: null };
  f.setInvites([invite]); await f.worker.tick(); assert.equal(f.worker.status().state, 'ok');
  const id = f.scope().id;
  const page = () => f.realtime.page(f.actor('owner'), id, { kind: 'invite' });
  const record = () => f.db.prepare("SELECT * FROM v2_realtime_records WHERE kind='invite'").get();
  assert.equal(page().items.length, 1); assert.equal(page().items[0].status, 'pending');
  assert.equal(page().items[0].firstSeenAt, iso(base)); assert.ok(!page().items[0].sentAt);
  assert.equal(f.realtime.summary(f.actor('owner'), id).invites.length, 0);
  const firstRecord = record(), high = f.repository.high(id);
  await f.worker.tick(); await f.worker.stop();
  const restarted = f.create(); await restarted.tick();
  assert.deepEqual(record(), firstRecord); assert.equal(f.repository.high(id), high);
  // An invitation time/name may arrive later; the upstream identity must stay stable.
  f.setInvites([{ ...invite, invitedAt: iso(base - 1000), inviterName: '补全邀请人', status: 'accepted',
    acceptedAt: iso(base + 10000), updatedAt: iso(base + 10000) }]);
  await restarted.tick(); assert.equal(page().items.length, 1);
  assert.equal(record().id, firstRecord.id); assert.equal(page().items[0].status, 'accepted');
  assert.equal(page().items[0].inviterName, '补全邀请人');
  await f.command('clear-chat'); assert.equal(page().items.length, 1);
  await f.command('reset'); assert.equal(page().items.length, 0);
  f.setInvites([{ ...invite, status: 'accepted', acceptedAt: iso(Date.now() + 100), updatedAt: iso(Date.now() + 100) }]);
  await restarted.tick(); assert.equal(page().items.length, 0);
});

test('canonical clear and source reset survive overlapping Web API reads and worker restart', async t => {
  const f = fixture(t); await f.worker.tick();
  const cleared = await f.command('clear-chat'); assert.equal(cleared.localHistoryCleared, true);
  assert.equal(f.records().length, 0); assert.equal(f.scope().epoch, 2);
  await f.worker.tick(); assert.equal(f.records().length, 0);
  assert.equal(f.realtime.summary(f.actor('owner'), f.scope().id).status, 'fresh');
  const reset = await f.command('reset'); assert.equal(reset.sourceReset, true);
  assert.equal(f.scope().epoch, 3); assert.equal(f.scope().snapshot, null);
  await f.worker.stop(); const restarted = f.create(); await restarted.tick();
  assert.equal(f.records().length, 0); assert.equal(f.scope().snapshot, null);
  assert.equal(f.realtime.summary(f.actor('owner'), f.scope().id).status, 'unavailable');
  assert.equal(f.db.prepare('SELECT count(*) n FROM v2_realtime_seen').get().n, 1);
});

test('production invalidation immediately marks retained roster stale when information stops or upstream becomes unavailable', async t => {
  for (const mode of ['information-disabled', 'all-disabled', 'paused', 'expired']) await t.test(mode, async t => {
    const f = fixture(t); await f.worker.tick();
    const high = f.repository.high(f.scope().id), reads = f.calls.clan;
    if (mode === 'information-disabled') f.update({ infoEnabled: false });
    if (mode === 'all-disabled') f.update({ infoEnabled: false, chatEnabled: false });
    if (mode === 'paused') f.pause();
    if (mode === 'expired') f.setClan({ staleAfter: iso(Date.now() - 1) });
    await f.worker.tick();
    const scope = f.scope(), summary = f.realtime.summary(f.actor('owner'), scope.id);
    assert.equal(summary.status, 'stale'); assert.equal(summary.counts.online, null); assert.equal(summary.members[0].online, null);
    assert.equal(summary.members[0].observedOnline, true); assert.ok(Date.parse(scope.snapshot.expiresAt) <= Date.now());
    assert.ok(f.repository.high(scope.id) > high); assert.equal(f.progress().servers[serverId].infoActive, false);
    if (mode !== 'expired') assert.equal(f.calls.clan, reads);
    if (mode === 'all-disabled') assert.equal(f.worker.status().state, 'disabled');
  });
});

test('a configuration revision changed while canonical ingest waits in its write queue discards the old import', async t => {
  const f = fixture(t, { chatEnabled: false }), barrier = f.holdNextWrite();
  const tick = f.worker.tick(); await barrier.entered.promise;
  f.update({ infoEnabled: false }); barrier.release.resolve(); await tick;
  assert.equal(f.repository.scopes().length, 0); assert.equal(f.records().length, 0);
  assert.equal(f.progress(), null);
  await f.worker.tick(); assert.equal(f.worker.status().state, 'disabled'); assert.equal(f.repository.scopes().length, 0);
});

test('an already admitted chat event cannot adopt the new epoch when owner clear/reset runs before its queued write', async t => {
  for (const action of ['clear-chat', 'reset']) await t.test(action, async t => {
    const f = fixture(t, { infoEnabled: false }); await f.worker.tick();
    const first = f.messages()[0]; f.setMessages([{ ...first, id: 'queued-old-event', message: '排队旧消息' }]);
    const barrier = f.holdNextWrite(), tick = f.worker.tick(); await barrier.entered.promise;
    const result = await f.command(action); assert.equal(result.epoch, 2);
    barrier.release.resolve(); await tick;
    assert.equal(f.records().length, 0);
    assert.equal(f.worker.status().servers[0].errorCode, 'WEB_API_SYNC_FAILED');
    assert.equal(f.db.prepare("SELECT count(*) n FROM v2_realtime_seen WHERE id='queued-old-event'").get().n, 0);
  });
});
