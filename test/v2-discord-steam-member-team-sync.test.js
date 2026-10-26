import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { IdentityRepository, installIdentitySchema } from '../server/v2/identity/repository.js';
import { IdentityService } from '../server/v2/identity/service.js';
import { installMemberAdminSchema } from '../server/v2/member-admin/repository.js';
import { MemberAdminService } from '../server/v2/member-admin/service.js';
import { installSchedulingSchema } from '../server/v2/scheduling/repository.js';
import { createDiscordSteamMemberTeamSync } from '../server/v2/discord-steam-links/member-team-sync.js';
import { markSteamLinksProof } from '../server/v2/discord-steam-links/proof.js';

const discordId = '200000000000000001', guildId = '200000000000000010', roleId = '200000000000000020';
const steamA = '76561198000000001', steamB = '76561198000000002';
function fixture(t) {
  const db = new DatabaseSync(':memory:'); t.after(() => db.close());
  installIdentitySchema(db); installMemberAdminSchema(db); installSchedulingSchema(db);
  const repo = new IdentityRepository(db), now = () => Date.UTC(2026, 9, 15, 10);
  const identity = new IdentityService(repo, { now, providers: { discord: {
    async roles(externalId, currentGuildId) { return { externalId, guildId: currentGuildId, roleIds: [roleId] }; }
  } } });
  repo.put('squads', { id: 'cn', name: 'CN', revision: 1 }); repo.put('squads', { id: 'eu', name: 'EU', revision: 1 });
  repo.put('policies', { id: 'discord', provider: 'discord', enabled: true, guildId, allowedRoleIds: [roleId], matchMode: 'any', policyRevision: 1 });
  const sync = createDiscordSteamMemberTeamSync({ identity, now });
  let sequence = 0;
  const input = (overrides = {}) => {
    const currentId = overrides.discordId || discordId;
    return { proof: markSteamLinksProof({ provider: 'discord', payload: { kind: 'steam_links' }, externalId: currentId,
      externalDisplayName: 'Discord 真名', guildId, interactionId: String(200000000000001000n + BigInt(++sequence)), discordRoleIds: [roleId] }),
      link: { guildId, discordId: currentId, steamId: steamA, ownershipVerified: false, ...overrides.link },
      team: { code: 'CN', squadId: 'cn', targetId: 'target', roleIds: [roleId], ...overrides.team } };
  };
  const run = value => repo.transaction(() => sync(value || input()));
  const records = () => JSON.stringify(db.prepare('SELECT * FROM json_records ORDER BY collection,id').all());
  const count = table => db.prepare(`SELECT count(*) n FROM ${table}`).get().n;
  return { db, repo, identity, sync, input, run, records, count };
}
const active = (extra = {}) => ({ id: 'member-own', steamId: '', discordId, memberStatus: 'active', revision: 1, ...extra });

test('trusted proof and an existing transaction are required; constructor performs no writes', t => {
  const f = fixture(t), value = f.input(), before = f.records();
  assert.throws(() => f.sync(value), { errorCode: 'STEAM_TEAM_TRANSACTION_REQUIRED' });
  assert.throws(() => f.run({ ...value, proof: structuredClone(value.proof) }), { errorCode: 'PLATFORM_AUTH_INVALID' });
  assert.throws(() => f.run({ ...value, link: { ...value.link, ownershipVerified: true } }), { errorCode: 'STEAM_TEAM_INPUT_INVALID' });
  assert.throws(() => f.run({ ...value, team: { ...value.team, roleIds: ['200000000000000099'] } }), { errorCode: 'STEAM_TEAM_INPUT_INVALID' });
  assert.equal(f.records(), before);
});
test('new Discord subjects get separate blank Steam members, durable history and refresh receipts without accounts', t => {
  const f = fixture(t), clock = f.db.prepare('SELECT revision FROM v2_scheduling_clock').get().revision;
  const first = f.run(), member = f.repo.get('members', first.memberId);
  assert.equal(first.status, 'synced'); assert.equal(first.squadId, 'cn');
  assert.equal(member.steamId, ''); assert.equal(member.discordId, discordId); assert.equal(member.displayName, 'Discord 真名');
  assert.deepEqual(member.discordSteamDeclaration, { guildId, discordId, steamId: steamA, ownershipVerified: false, declaredAt: '2026-10-15T10:00:00.000Z' });
  assert.equal(f.repo.all('accounts').length, 0); assert.equal(f.repo.all('identities').length, 0); assert.equal(f.repo.all('bindings').length, 0);
  assert.ok(f.db.prepare('SELECT revision FROM v2_scheduling_clock').get().revision > clock);
  const beforeCount = f.count('v2_member_admin_outbox'), beforeRevision = member.revision;
  assert.equal(f.run().status, 'unchanged'); assert.equal(f.count('v2_member_admin_outbox'), beforeCount);
  assert.equal(f.repo.get('members', member.id).revision, beforeRevision);
  const second = f.run(f.input({ discordId: '200000000000000002' }));
  assert.notEqual(second.memberId, first.memberId); assert.equal(f.repo.all('members').length, 2);
  assert.ok(f.repo.all('members').every(row => row.steamId === ''));
  const outbox = f.db.prepare('SELECT * FROM v2_member_admin_outbox ORDER BY seq').all();
  for (const row of outbox) {
    const event = JSON.parse(row.payload), receipt = JSON.parse(f.db.prepare('SELECT payload FROM v2_member_admin_operations WHERE actor_id=? AND operation_id=?').get(event.actorId, row.operation_id).payload);
    assert.deepEqual(receipt.events, event.events); assert.ok(receipt.changes.find(change => change.collection === 'members').record.discordSteamDeclaration);
    assert.ok(receipt.events.every(change => change.changeType !== 'member.created'));
  }
});
test('Steam input never selects another website member or alters their canonical identity', t => {
  const f = fixture(t);
  const other = active({ id: 'other-owner', steamId: steamA, discordId: '200000000000000002' }); f.repo.put('members', other);
  const result = f.run();
  assert.notEqual(result.memberId, other.id); assert.deepEqual(f.repo.get('members', other.id), other);
  assert.equal(f.repo.get('members', result.memberId).steamId, '');
  f.repo.put('members', { ...f.repo.get('members', result.memberId), steamId: steamB });
  const before = f.records();
  assert.equal(f.run().status, 'identity_conflict'); assert.equal(f.records(), before);
});
test('verified Discord account linkage resolves members without aliases and rejects ambiguity', t => {
  const f = fixture(t);
  f.repo.put('members', active({ discordId: undefined, steamId: steamA }));
  f.repo.put('accounts', { id: 'account-own', memberId: 'member-own', status: 'active', revision: 1 });
  f.repo.put('identities', { id: 'discord-own', provider: 'discord', externalId: discordId, accountId: 'account-own' });
  f.repo.put('bindings', { id: 'binding-own', accountId: 'account-own', memberId: 'member-own', steamId: steamA, status: 'verified' });
  assert.equal(f.run().memberId, 'member-own'); assert.equal(f.repo.all('members').length, 1);
  f.repo.put('members', active({ id: 'ambiguous', discordId }));
  const before = f.records(); assert.equal(f.run().status, 'identity_conflict'); assert.equal(f.records(), before);
  f.repo.remove('members', 'ambiguous');
  f.repo.put('members', { ...f.repo.get('members', 'member-own'), discordId, discordUserId: '200000000000000003' });
  assert.equal(f.run().status, 'identity_conflict');
});
test('paused, blocked, departed, deleted, restricted members and disabled accounts never revive', t => {
  const f = fixture(t);
  for (const values of [{ memberStatus: 'paused' }, { memberStatus: 'suspended' }, { memberStatus: 'left' },
    { memberStatus: 'blocked' }, { deletedAt: '2026-01-01' }, { deleted: true }, { roleAccessLock: {} }, { status: 'banned' }]) {
    f.repo.put('members', active(values)); const before = f.records();
    assert.equal(f.run().status, 'member_unavailable'); assert.equal(f.records(), before);
  }
  f.repo.put('members', active()); f.repo.put('restrictions', { id: 'deny', memberId: 'member-own', startsAt: '2020-01-01' });
  assert.equal(f.run().status, 'member_unavailable'); f.repo.remove('restrictions', 'deny');
  f.repo.put('accounts', { id: 'disabled', memberId: 'member-own', status: 'disabled' });
  assert.equal(f.run().status, 'member_unavailable');
});
test('manual squad ownership wins while its separate Steam declaration may refresh', t => {
  const f = fixture(t); f.repo.put('members', active());
  const manual = { id: 'manual', memberId: 'member-own', squadId: 'eu', validTo: null, addedByUserId: 'administrator' };
  f.repo.put('squadMembers', manual);
  const result = f.run();
  assert.equal(result.status, 'manual_preserved'); assert.equal(result.squadId, 'eu');
  assert.deepEqual(f.repo.get('squadMembers', 'manual'), manual); assert.equal(f.repo.get('members', 'member-own').steamId, '');
  assert.equal(f.repo.get('members', 'member-own').discordSteamDeclaration.steamId, steamA);
  assert.equal(f.run(f.input({ link: { steamId: steamB } })).status, 'manual_preserved');
  assert.equal(f.repo.get('members', 'member-own').discordSteamDeclaration.steamId, steamB);
});
test('automatic squad transitions record both sides and manual move/detach suppresses later automation', t => {
  const f = fixture(t), initial = f.run(), before = f.repo.all('squadMembers')[0];
  assert.equal(f.run(f.input({ team: { code: 'EU', squadId: 'eu' } })).status, 'synced');
  assert.equal(f.repo.get('squadMembers', before.id), null); assert.equal(f.repo.all('squadMembers').length, 1);
  assert.ok(f.db.prepare("SELECT payload FROM v2_member_admin_history WHERE kind='member'").all().map(row => JSON.parse(row.payload)).some(row => row.fromSquadId === 'cn' && row.toSquadId === 'eu'));
  f.repo.put('accounts', { id: 'admin', memberId: null, status: 'active', roleId: 'admin', adminAssignedByOwner: true, permissionVersion: 1, revision: 1 });
  const admin = new MemberAdminService(f.identity), actor = f.identity.actorForAccount('admin');
  admin.move(actor, initial.memberId, { expectedRevision: f.repo.get('members', initial.memberId).revision, squadId: 'eu' }, 'manual-same-squad');
  assert.equal(f.run().status, 'manual_preserved'); assert.equal(f.repo.all('squadMembers')[0].squadId, 'eu');
  admin.move(actor, initial.memberId, { expectedRevision: f.repo.get('members', initial.memberId).revision, squadId: null }, 'manual-remove-squad');
  assert.equal(f.run().status, 'manual_preserved'); assert.equal(f.repo.all('squadMembers').length, 0);
});
test('existing automatic role assignment can transfer without leaving an OAuth source that can erase it', t => {
  const f = fixture(t);
  f.repo.put('members', active({ roleDerivedSquad: { provider: 'discord', guildId, roleId, squadId: 'eu' } }));
  f.repo.put('squadMembers', { id: 'oauth-auto', memberId: 'member-own', squadId: 'eu', validTo: null });
  assert.equal(f.run().status, 'synced');
  const member = f.repo.get('members', 'member-own');
  assert.equal(member.roleDerivedSquad, null); assert.equal(member.discordSteamTeam.squadId, 'cn');
  assert.equal(member.discordSteamTeam.relationId, f.repo.all('squadMembers')[0].id);
});
test('multiple current relationships and unavailable squads reject without subset writes', t => {
  const f = fixture(t); f.repo.put('members', active());
  // Simulate a legacy/corrupted store that predates the one-current-member index.
  f.db.exec('DROP INDEX uidx_json_records_squadMembers_memberId');
  for (const id of ['a', 'b']) f.repo.put('squadMembers', { id, memberId: 'member-own', squadId: id === 'a' ? 'cn' : 'eu' });
  const before = f.records(); assert.equal(f.run().status, 'identity_conflict'); assert.equal(f.records(), before);
  assert.equal(f.run(f.input({ team: { squadId: 'missing' } })).status, 'squad_unavailable');
  f.repo.put('squads', { id: 'cn', archivedAt: '2026-01-01' }); assert.equal(f.run().status, 'squad_unavailable');
});
test('durable deletion evidence and old link anchors stop recreation of physically removed members', t => {
  const f = fixture(t), first = f.run();
  f.repo.remove('members', first.memberId);
  assert.equal(f.run(f.input({ link: { teamSync: { memberId: first.memberId } } })).status, 'member_unavailable');
  f.repo.put('events', { id: 'deleted', reason: 'member_deleted', provider: 'discord', externalIds: [discordId], memberId: first.memberId });
  assert.equal(f.run().status, 'member_unavailable'); assert.equal(f.repo.all('members').length, 0);
});
test('a failed outbox write rolls back all website changes in the caller savepoint while keeping the bot link', t => {
  const f = fixture(t), before = f.db.prepare('SELECT revision FROM v2_scheduling_clock').get().revision;
  f.db.exec("CREATE TRIGGER fail_sync_outbox BEFORE INSERT ON v2_member_admin_outbox BEGIN SELECT RAISE(ABORT,'fixture failure'); END");
  f.repo.transaction(() => {
    f.repo.setScalar('fixtureBotLink', { steamId: steamA });
    f.db.exec('SAVEPOINT website_subset');
    assert.throws(() => f.sync(f.input()), /fixture failure/);
    f.db.exec('ROLLBACK TO website_subset'); f.db.exec('RELEASE website_subset');
  });
  assert.equal(f.repo.scalar('fixtureBotLink').steamId, steamA); assert.equal(f.repo.all('members').length, 0);
  assert.equal(f.repo.all('squadMembers').length, 0); assert.equal(f.count('v2_member_admin_history'), 0);
  assert.equal(f.count('v2_member_admin_operations'), 0); assert.equal(f.count('v2_member_admin_outbox'), 0);
  assert.equal(f.db.prepare('SELECT revision FROM v2_scheduling_clock').get().revision, before);
});
test('real Discord OAuth plus Steam proof fills the same blank member; self declaration is never proof', async t => {
  const f = fixture(t), synced = f.run(), member = f.repo.get('members', synced.memberId), relation = f.repo.all('squadMembers')[0];
  const profile = { provider: 'discord', id: discordId, displayName: 'OAuth verified name' };
  const evidence = await f.identity.checkEligibility('discord', discordId), context = f.identity.login(profile, evidence);
  assert.equal(context.step, 'steam'); assert.equal(f.repo.all('accounts').length, 0);
  const login = f.identity.bind(profile, steamB, evidence, context);
  const current = f.repo.get('members', member.id);
  assert.equal(f.repo.all('members').length, 1); assert.equal(current.steamId, steamB);
  assert.equal(current.discordSteamDeclaration.steamId, steamA); assert.equal(current.discordSteamDeclaration.ownershipVerified, false);
  assert.equal(current.revision, member.revision + 1); assert.equal(f.repo.all('bindings')[0].steamId, steamB);
  assert.equal(f.identity.session(login.token).actor.memberId, member.id);
  assert.deepEqual(f.repo.get('squadMembers', relation.id), relation);
  assert.equal(f.run().status, 'identity_conflict');
});
test('OpenID proof cannot silently merge a Discord placeholder into a different existing Steam member', async t => {
  const f = fixture(t), synced = f.run();
  f.repo.put('members', { id: 'steam-owner', steamId: steamB, memberStatus: 'active', revision: 1 });
  const profile = { provider: 'discord', id: discordId }, evidence = await f.identity.checkEligibility('discord', discordId);
  const context = f.identity.login(profile, evidence);
  assert.throws(() => f.identity.bind(profile, steamB, evidence, context), { errorCode: 'IDENTITY_CONFLICT' });
  assert.equal(f.repo.get('members', synced.memberId).steamId, ''); assert.equal(f.repo.all('members').length, 2);
  assert.equal(f.repo.all('accounts').length, 0); assert.equal(f.repo.all('bindings').length, 0);
});
