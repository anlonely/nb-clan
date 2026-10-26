import './support/owner-environment.mjs';
import './support/v2-source-main/offline.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { normalizeRustplusRelayPayload } from '../server/rustplus-relay.js';
import { IdentityRepository, installIdentitySchema } from '../server/v2/identity/repository.js';
import { IdentityService } from '../server/v2/identity/service.js';
import { OWNER_STEAM_ID } from '../server/v2/identity/permissions.js';
import { RealtimeRepository, installRealtimeSchema } from '../server/v2/realtime/repository.js';
import { RealtimeService } from '../server/v2/realtime/service.js';
import { createProductionRelayIngress } from '../server/v2/production/relay.js';

const inviteeSteamId = '76561198000000001', inviterSteamId = '76561198000000002';
const common = { type: 'clan_invite_record', clientId: 'web-api-fixture', serverId: 'server-1' };

function fixture(t) {
  const db = new DatabaseSync(':memory:'); installIdentitySchema(db); installRealtimeSchema(db);
  const ir = new IdentityRepository(db), repo = new RealtimeRepository(db), start = Date.now() - 600000;
  const at = offset => new Date(start + offset).toISOString(); let clock = start + 10000;
  ir.setScalar('v2IdentityMigration', { isolated: true });
  ir.put('members', { id: 'owner-member', steamId: OWNER_STEAM_ID, membershipStatus: 'active', revision: 1 });
  ir.put('accounts', { id: 'owner', memberId: 'owner-member', roleId: 'admin', status: 'active', permissionVersion: 1, revision: 1 });
  ir.put('bindings', { id: 'owner-binding', accountId: 'owner', memberId: 'owner-member', steamId: OWNER_STEAM_ID, status: 'verified', revision: 1 });
  const identity = new IdentityService(ir), service = new RealtimeService(identity, { repository: repo, now: () => clock,
    authorizeLegacyAction: actor => actor.roleId === 'owner', sourceReset: ({ apply }) => apply() });
  const ingress = createProductionRelayIngress({ getRepository: () => repo, isAccepting: () => true,
    runOperation: fn => fn(), serializeWrite: fn => fn(), now: () => clock });
  const record = changes => ({ webApiInviteId: 'stable-upstream-invite', inviteeSteamId, inviterSteamId,
    inviteeName: '受邀队员', inviterName: '邀请队员', status: 'pending', sentAt: at(0), firstSeenAt: at(1000), occurredAt: at(2000), ...changes });
  const scope = () => repo.scopes()[0], actor = () => identity.actorForAccount('owner');
  t.after(() => db.close());
  return { db, repo, service, at, record, scope, actor,
    advance(ms) { clock += ms; },
    ingest(invite) { return ingress({ ...common, invite }, { assertCredentialsCurrent() {} }); },
    rows() { return db.prepare("SELECT * FROM v2_realtime_records WHERE kind='invite' ORDER BY seq").all(); },
    page() { return service.page(actor(), scope().id, { kind: 'invite' }); },
    async reset() { const current = scope(); return service.command(actor(), current.id, 'reset',
      { expectedRevision: current.revision, reason: 'Invitation reset fixture' }, randomUUID()); }
  };
}

test('Web API stable invitation identity is opt-in and leaves the legacy ID and clock contract unchanged', () => {
  const invite = { id: 'upstream-invite-a', inviteeSteamId, inviterSteamId, sentAt: '2026-09-20T10:00:00.000Z', status: 'pending' };
  const normalize = body => normalizeRustplusRelayPayload({ type: 'clan_invite_record', clientId: 'legacy-client', serverId: 'legacy-server', invite: body },
    { receivedAt: '2026-09-20T10:00:01.000Z' });
  const legacy = normalize(invite);
  assert.equal(legacy.id, 'invite_bd619ebc54f7f1ee0f04444aef74c4aa');
  assert.equal(normalize({ ...invite, id: 'different-external-id', occurredAt: '2026-09-20T10:00:10Z' }).id, legacy.id);
  assert.equal(legacy.occurredAt, undefined); assert.equal(legacy.resetCutoffAt, undefined); assert.equal(legacy.firstSeenAt, undefined);
  const web = normalize({ ...invite, webApiInviteId: 'stable-upstream-id', firstSeenAt: '2026-09-20T10:00:05Z', occurredAt: '2026-09-20T10:00:10Z' });
  assert.notEqual(web.id, legacy.id); assert.equal(web.externalId, 'stable-upstream-id');
  assert.equal(web.id, normalize({ ...invite, webApiInviteId: 'stable-upstream-id', inviterSteamId: '', inviterName: '补充姓名',
    sentAt: '2026-09-20T09:59:00Z', status: 'accepted', acceptedAt: '2026-09-20T10:02:00Z' }).id);
  assert.equal(web.occurredAt, '2026-09-20T10:00:10.000Z'); assert.equal(web.resetCutoffAt, invite.sentAt);
  assert.notEqual(web.id, normalize({ ...invite, webApiInviteId: 'another-upstream-id' }).id);
});

test('unknown invitation time stays unknown while first observation is retained and supplies the reset boundary', async t => {
  const f = fixture(t), invite = f.record({ sentAt: null });
  const normalized = normalizeRustplusRelayPayload({ ...common, invite });
  assert.equal(normalized.sentAt, ''); assert.equal(normalized.firstSeenAt, f.at(1000)); assert.equal(normalized.resetCutoffAt, f.at(1000));
  await f.ingest(invite);
  const item = f.page().items[0]; assert.equal(item.sentAt, ''); assert.equal(item.firstSeenAt, f.at(1000));
  assert.equal(item.occurredAt, f.at(2000)); assert.equal(item.resetCutoffAt, undefined);
  for (const changes of [{ webApiInviteId: '' }, { webApiInviteId: 'bad/id' }, { webApiInviteId: 'x'.repeat(121) }, { sentAt: null, firstSeenAt: null }])
    assert.throws(() => normalizeRustplusRelayPayload({ ...common, invite: f.record(changes) }), { status: 400 });
});

test('one SQLite invitation survives missing-field backfill and pending-to-accepted updates without duplicate events on poll', async t => {
  const f = fixture(t), first = f.record({ sentAt: null, inviterSteamId: '', inviterName: '' });
  await f.ingest(first); const initial = f.rows()[0], high = f.repo.high(f.scope().id), revision = f.scope().revision;
  f.advance(1000);
  const repeat = await f.ingest({ ...first, occurredAt: f.at(4000) });
  assert.equal(repeat.event.skipped, true); assert.equal(f.repo.high(f.scope().id), high); assert.equal(f.scope().revision, revision);
  assert.equal(f.rows()[0].received, initial.received);
  await f.ingest(f.record({ occurredAt: f.at(5000) }));
  assert.equal(f.rows().length, 1); assert.equal(f.rows()[0].id, initial.id); assert.equal(f.rows()[0].seq, initial.seq);
  assert.equal(f.page().items[0].sentAt, f.at(0)); assert.equal(f.page().items[0].inviterSteamId, inviterSteamId);
  await f.ingest(f.record({ status: 'accepted', acceptedAt: f.at(6000), occurredAt: f.at(7000) }));
  assert.equal(f.rows().length, 1); assert.equal(f.page().items[0].status, 'accepted'); assert.equal(f.page().counts.accepted, 1);
  const acceptedHigh = f.repo.high(f.scope().id); f.advance(1000);
  assert.equal((await f.ingest(f.record({ status: 'accepted', acceptedAt: f.at(6000), occurredAt: f.at(8000) }))).event.skipped, true);
  assert.equal(f.repo.high(f.scope().id), acceptedHigh);
  assert.equal((await f.ingest(f.record({ occurredAt: f.at(5000) }))).event.skipped, true);
  assert.equal((await f.ingest(f.record({ occurredAt: f.at(9000) }))).event.skipped, true);
  assert.equal(f.page().items[0].status, 'accepted');
});

test('source reset blocks old invitation history even when observation or acceptance timestamps advance', async t => {
  for (const knownInvitationTime of [true, false]) await t.test(`sentAt known=${knownInvitationTime}`, async t => {
    const f = fixture(t), old = f.record({ sentAt: knownInvitationTime ? f.at(0) : null });
    await f.ingest(old); await f.reset(); assert.equal(f.rows().length, 0);
    f.advance(20000);
    const replay = await f.ingest({ ...old, status: 'accepted', acceptedAt: f.at(20000), occurredAt: f.at(25000) });
    assert.equal(replay.event.skipped, true); assert.equal(replay.event.reason, 'before_reset'); assert.equal(f.rows().length, 0);
    await f.ingest(f.record({ webApiInviteId: 'new-after-reset', sentAt: knownInvitationTime ? f.at(21000) : null,
      firstSeenAt: f.at(22000), occurredAt: f.at(25000) }));
    assert.equal(f.rows().length, 1);
  });
});

test('legacy invitation acceptance ordering remains intact and repeated delivery only changes no business state', async t => {
  const f = fixture(t); const { webApiInviteId, firstSeenAt, occurredAt, ...legacy } = f.record();
  await f.ingest(legacy); f.advance(1000);
  assert.equal((await f.ingest(legacy)).event.skipped, true);
  await f.ingest({ ...legacy, status: 'accepted', acceptedAt: f.at(6000) });
  assert.equal((await f.ingest(legacy)).event.skipped, true);
  assert.equal(f.rows().length, 1); assert.equal(f.page().items[0].status, 'accepted');
});
