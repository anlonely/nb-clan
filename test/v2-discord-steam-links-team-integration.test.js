import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, sign } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { installIdentitySchema, IdentityRepository } from '../server/v2/identity/repository.js';
import { IdentityService } from '../server/v2/identity/service.js';
import { installMemberAdminSchema } from '../server/v2/member-admin/repository.js';
import { MemberAdminService } from '../server/v2/member-admin/service.js';
import { installSchedulingSchema } from '../server/v2/scheduling/repository.js';
import { installPlatformAdminSchema } from '../server/v2/platform-admin/repository.js';
import { createDiscordVerifier } from '../server/v2/notification-platforms/verifiers.js';
import { createDiscordSteamMemberTeamSync } from '../server/v2/discord-steam-links/member-team-sync.js';
import { createDiscordSteamLinksService } from '../server/v2/discord-steam-links/service.js';
import { DiscordSteamLinksRepository } from '../server/v2/discord-steam-links/repository.js';

const guildId = '200000000000000001', channelId = '200000000000000002', discordId = '200000000000000003';
const applicationId = '200000000000000004', messageId = '200000000000000005';
const cnRole = '200000000000000006', euRole = '200000000000000007';
const steamA = '76561198000000001', steamB = '76561198000000002';

function fixture(t) {
  const db = new DatabaseSync(':memory:'); t.after(() => db.close());
  installIdentitySchema(db); installMemberAdminSchema(db); installSchedulingSchema(db); installPlatformAdminSchema(db);
  const repo = new IdentityRepository(db), links = new DiscordSteamLinksRepository(db);
  const now = () => Date.UTC(2026, 9, 15, 12), identity = new IdentityService(repo, { now });
  for (const code of ['CN', 'EU']) repo.put('squads', { id: `squad-${code.toLowerCase()}`, name: code, revision: 1 });
  const config = { enabled: true, commands: ['setsteam', 'view'].map(id => ({ id, enabled: true, type: 'slash_command', slashCommand: id,
    ...(id === 'setsteam' ? { autoMatchTeamByRole: true } : {}) })),
  targets: [{ id: 'test-target', enabled: true, guildId, channelId, enabledCommandIds: ['setsteam', 'view'],
    steamTeamCnRoleIds: [cnRole], steamTeamEuRoleIds: [euRole], steamTeamCnSquadId: 'squad-cn', steamTeamEuSquadId: 'squad-eu' }] };
  const profile = steamId => ({ status: 'ok', steamId, displayName: 'Steam fixture', fetchedAt: new Date(now()).toISOString() });
  const service = createDiscordSteamLinksService({ db, now, readConfig: () => config,
    syncMemberTeam: createDiscordSteamMemberTeamSync({ identity, now }), runStoreWriteTask: task => Promise.resolve().then(task),
    provider: { resolveIdentifier: async steamId => ({ status: 'ok', steamId, profile: profile(steamId) }),
      readProfile: async steamId => profile(steamId), listGuildMembers: async () => ({ status: 'ok', complete: true,
        members: [{ discordId, displayName: '@everyone Test Member', bot: false }], fetchedAt: new Date(now()).toISOString() }) } });
  const keys = generateKeyPairSync('ed25519');
  const publicKey = keys.publicKey.export({ format: 'der', type: 'spki' }).subarray(-32).toString('hex');
  const verify = createDiscordVerifier({ publicKey, applicationId, now });
  let sequence = 200000000000001000n;
  function envelope(data, type = 2, roles = [cnRole], patch = {}) {
    const event = { id: String(sequence++), application_id: applicationId, type, guild_id: guildId, channel_id: channelId,
      member: { user: { id: discordId, username: 'Signed Discord user' }, nick: 'Verified Discord name', roles, permissions: '32' },
      token: 'constructed-private-test-token', locale: 'en-US', data, ...patch };
    const rawBody = Buffer.from(JSON.stringify(event)), timestamp = String(now() / 1000);
    return { rawBody, headers: { 'x-signature-timestamp': timestamp,
      'x-signature-ed25519': sign(null, Buffer.concat([Buffer.from(timestamp), rawBody]), keys.privateKey).toString('hex') } };
  }
  async function request(data, type = 2, roles = [cnRole], patch = {}) {
    const wire = envelope(data, type, roles, patch), proof = verify(wire), result = await service.handleVerified(proof);
    if (result.components?.some(row => row.components?.some(component => /^nbsteam:(?:confirm|cancel|page):/.test(component.custom_id || ''))))
      service.bindPrivateMessage(proof, result, messageId);
    return { proof, result, wire };
  }
  async function submit(steamId = steamA, roles = [cnRole]) {
    const opened = await request({ name: 'setsteam', type: 1 }, 2, roles);
    return request({ custom_id: opened.result.data.custom_id, components: [
      { type: 1, components: [{ type: 4, custom_id: 'identifier', value: steamId }] },
    ] }, 5, roles);
  }
  function button(result, action, roles) {
    const control = result.components.flatMap(row => row.components).find(row => row.custom_id?.startsWith(`nbsteam:${action}:`));
    return request({ component_type: 2, custom_id: control.custom_id }, 3, roles, { message: { id: messageId, flags: 64 } });
  }
  function admin() {
    if (!repo.get('accounts', 'fixture-admin')) repo.put('accounts', { id: 'fixture-admin', memberId: null, status: 'active', roleId: 'admin',
      adminAssignedByOwner: true, permissionVersion: 1, revision: 1 });
    return { service: new MemberAdminService(identity), actor: identity.actorForAccount('fixture-admin') };
  }
  const websiteSnapshot = () => ({ records: db.prepare('SELECT * FROM json_records ORDER BY collection,id').all(),
    meta: db.prepare('SELECT * FROM v2_member_admin_meta').all(), history: db.prepare('SELECT * FROM v2_member_admin_history ORDER BY seq').all(),
    operations: db.prepare('SELECT * FROM v2_member_admin_operations ORDER BY actor_id,operation_id').all(),
    outbox: db.prepare('SELECT * FROM v2_member_admin_outbox ORDER BY seq').all() });
  return { db, repo, links, identity, service, config, verify, request, submit, button, admin, websiteSnapshot,
    link: () => links.getLink(guildId, discordId), member: () => repo.all('members').find(row => row.discordId === discordId),
    relations: () => repo.all('squadMembers').filter(row => !row.validTo) };
}

test('signed native setsteam creates a Discord-only website member and the CN relationship visible in both website and Discord views', async t => {
  const f = fixture(t), saved = await f.submit();
  assert.equal(saved.result.flags, 64); assert.match(saved.result.content, /Steam link saved/);
  const member = f.member(); assert.ok(member); assert.equal(member.steamId, '');
  assert.equal(member.discordId, saved.proof.externalId); assert.equal(member.displayName, 'Verified Discord name');
  assert.equal(member.discordSteamDeclaration.steamId, steamA); assert.equal(member.discordSteamDeclaration.ownershipVerified, false);
  assert.equal(f.link().teamSync.memberId, member.id); assert.equal(f.link().teamSync.status, 'synced');
  assert.deepEqual(f.relations().map(row => [row.memberId, row.squadId]), [[member.id, 'squad-cn']]);
  for (const collection of ['accounts', 'identities', 'bindings', 'sessions']) assert.equal(f.repo.all(collection).length, 0);
  const afterSave = f.websiteSnapshot(), revision = f.link().revision;
  const same = await f.submit(); assert.equal(f.link().revision, revision); assert.deepEqual(f.websiteSnapshot(), afterSave);
  const botRows = f.db.prepare('SELECT * FROM platform_admin_records ORDER BY kind,id').all();
  for (const operation of [saved, same]) await f.service.handleVerified(f.verify(operation.wire));
  assert.deepEqual(f.websiteSnapshot(), afterSave); assert.deepEqual(f.db.prepare('SELECT * FROM platform_admin_records ORDER BY kind,id').all(), botRows);
  const admin = f.admin(), detail = admin.service.detail(admin.actor, member.id);
  assert.equal(detail.squadId, 'squad-cn'); assert.equal(detail.squadName, 'CN'); assert.equal(detail.steamId, '');
  const viewed = await f.request({ name: 'view', options: [{ type: 1, name: 'user', options: [{ type: 6, name: 'user', value: discordId }] }] });
  const listed = await f.request({ name: 'view', options: [{ type: 1, name: 'all' }] });
  assert.match(JSON.stringify(viewed.result), /Recorded Discord team: CN/); assert.match(JSON.stringify(listed.result), /CN · Synced/);
  for (const payload of [saved.result, viewed.result, listed.result]) {
    const text = JSON.stringify(payload); assert.ok(!text.includes(member.id)); assert.doesNotMatch(text, /squad-cn|<@|@everyone/);
    assert.equal(payload.flags, 64); assert.deepEqual(payload.allowed_mentions.parse, []);
  }
});

test('native role changes move the same website member, while replacement preview and cancel cannot change the site', async t => {
  const f = fixture(t); await f.submit(); const memberId = f.member().id;
  await f.submit(steamA, [euRole]); assert.equal(f.member().id, memberId); assert.equal(f.repo.all('members').length, 1);
  assert.equal(f.relations()[0].squadId, 'squad-eu'); assert.equal(f.link().teamAssignment.code, 'EU');
  const afterMove = f.websiteSnapshot();
  for (const roles of [[], [cnRole, euRole]]) {
    await f.submit(steamA, roles); assert.deepEqual(f.websiteSnapshot(), afterMove); assert.equal(f.relations()[0].squadId, 'squad-eu');
  }
  const preview = await f.submit(steamB, [cnRole]); assert.deepEqual(f.websiteSnapshot(), afterMove); assert.equal(f.link().steamId, steamA);
  await f.button(preview.result, 'cancel', [cnRole]); assert.deepEqual(f.websiteSnapshot(), afterMove);
  const next = await f.submit(steamB, [euRole]); await f.button(next.result, 'confirm', [cnRole]);
  assert.equal(f.link().steamId, steamB); assert.equal(f.link().teamAssignment.code, 'CN'); assert.equal(f.member().id, memberId);
  assert.equal(f.member().steamId, ''); assert.equal(f.member().discordSteamDeclaration.steamId, steamB);
  assert.deepEqual(f.relations().map(row => row.squadId), ['squad-cn']);
  const history = f.db.prepare("SELECT payload FROM v2_member_admin_history WHERE kind='member'").all().map(row => JSON.parse(row.payload));
  assert.ok(history.some(row => row.fromSquadId === 'squad-cn' && row.toSquadId === 'squad-eu'));
  assert.ok(history.some(row => row.fromSquadId === 'squad-eu' && row.toSquadId === 'squad-cn'));
});

test('real website manual move and removal take precedence over subsequent signed Discord role matches', async t => {
  const f = fixture(t); await f.submit(); const admin = f.admin(), memberId = f.member().id;
  admin.service.move(admin.actor, memberId, { expectedRevision: f.member().revision, squadId: 'squad-eu' }, 'integration-manual-eu');
  const afterMove = f.websiteSnapshot(), preserved = await f.submit(steamA, [cnRole]);
  assert.deepEqual(f.websiteSnapshot(), afterMove); assert.equal(f.relations()[0].squadId, 'squad-eu');
  assert.equal(f.link().teamSync.status, 'manual_preserved'); assert.match(JSON.stringify(preserved.result), /Manual website team kept/);
  admin.service.move(admin.actor, memberId, { expectedRevision: f.member().revision, squadId: null }, 'integration-manual-detach');
  const afterDetach = f.websiteSnapshot(); await f.submit(steamA, [euRole]);
  assert.deepEqual(f.websiteSnapshot(), afterDetach); assert.equal(f.relations().length, 0);
  assert.equal(f.link().teamSync.status, 'manual_preserved'); assert.equal(f.link().teamSync.memberId, memberId);
  assert.equal(admin.service.detail(admin.actor, memberId).squadId, null);
});

test('a real website outbox failure rolls back its member, relation, history and receipt while preserving the Steam save', async t => {
  const f = fixture(t), before = f.websiteSnapshot();
  f.db.exec("CREATE TRIGGER fail_team_outbox BEFORE INSERT ON v2_member_admin_outbox BEGIN SELECT RAISE(ABORT,'private fixture failure'); END");
  const saved = await f.submit(); assert.equal(f.link().steamId, steamA); assert.equal(f.link().teamSync.status, 'failed');
  assert.match(saved.result.content, /Steam link saved/); assert.match(JSON.stringify(saved.result), /Website sync failed/);
  assert.doesNotMatch(JSON.stringify(saved.result), /private fixture failure/); assert.deepEqual(f.websiteSnapshot(), before);
  const viewed = await f.request({ name: 'view', options: [{ type: 1, name: 'user', options: [{ type: 6, name: 'user', value: discordId }] }] });
  assert.match(JSON.stringify(viewed.result), /Website sync failed/); assert.equal(f.repo.all('members').length, 0);
  f.db.exec('DROP TRIGGER fail_team_outbox'); await f.submit();
  assert.equal(f.link().teamSync.status, 'synced'); assert.equal(f.repo.all('members').length, 1); assert.equal(f.relations().length, 1);
  assert.equal(f.db.prepare('SELECT count(*) n FROM v2_member_admin_outbox').get().n, 1);
});

test('a declared Steam ID belonging to another member cannot select or mutate that website identity', async t => {
  const f = fixture(t), otherMember = { id: 'other-verified-member', discordId: '200000000000000099', steamId: steamA,
    displayName: 'Existing verified owner', memberStatus: 'active', membershipStatus: 'active', revision: 1 };
  f.repo.put('members', otherMember);
  f.repo.put('accounts', { id: 'other-account', memberId: otherMember.id, status: 'active', roleId: 'member', revision: 1 });
  f.repo.put('identities', { id: 'other-discord', provider: 'discord', externalId: otherMember.discordId, accountId: 'other-account' });
  f.repo.put('bindings', { id: 'other-steam-proof', memberId: otherMember.id, accountId: 'other-account', steamId: steamA, status: 'verified' });
  const accounts = f.repo.all('accounts'), identities = f.repo.all('identities'), bindings = f.repo.all('bindings');
  await f.submit(); assert.notEqual(f.member().id, otherMember.id); assert.equal(f.member().steamId, '');
  assert.deepEqual(f.repo.get('members', otherMember.id), otherMember); assert.equal(f.link().teamSync.memberId, f.member().id);
  assert.deepEqual(f.repo.all('accounts'), accounts); assert.deepEqual(f.repo.all('identities'), identities); assert.deepEqual(f.repo.all('bindings'), bindings);
  assert.deepEqual(f.relations().map(row => row.memberId), [f.member().id]);
});
