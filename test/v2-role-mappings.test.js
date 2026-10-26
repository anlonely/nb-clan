import './support/owner-environment.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { installIdentitySchema, IdentityRepository } from '../server/v2/identity/repository.js';
import { IdentityService } from '../server/v2/identity/service.js';
import { accountRole, OWNER_STEAM_ID } from '../server/v2/identity/permissions.js';
import { installPlatformAdminSchema, PlatformAdminRepository } from '../server/v2/platform-admin/repository.js';
import { PlatformAdminService } from '../server/v2/platform-admin/service.js';
import { normalizeConfig } from '../server/v2/platform-admin/model.js';

const guildId = 'guild-1';
const role = { id: 'role-1', name: 'RSC·管道工' };
const source = { id: 'rule-1', guildId, roleId: role.id, roleName: role.name };

function fixture(t, provider) {
  const db = new DatabaseSync(':memory:');
  installIdentitySchema(db);
  installPlatformAdminSchema(db);
  t.after(() => db.close());
  const repo = new IdentityRepository(db), platform = new PlatformAdminRepository(db);
  let memberRoles = ['eligible', role.id], metadataAvailable = true, nowMs = Date.parse('2030-09-08T10:00:00Z');
  const identity = new IdentityService(repo, { now: () => nowMs, providers: {
    [provider]: { roles: async (externalId, guildId) => ({ externalId, guildId, roleIds: memberRoles,
      community: { available: metadataAvailable, roles: metadataAvailable && memberRoles.includes(role.id) ? [role] : [] } }) }
  } });
  repo.put('policies', { id: provider, provider, enabled: true, guildId, allowedRoleIds: ['eligible'], matchMode: 'any', policyRevision: 1 });
  repo.put('members', { id: 'member-1', steamId: '76561198000000001', memberStatus: 'active', specialty: ['building'], revision: 1 });
  repo.put('accounts', { id: 'account-1', memberId: 'member-1', status: 'active', roleId: 'member', permissionVersion: 1, revision: 1 });
  repo.put('bindings', { id: 'binding-1', accountId: 'account-1', memberId: 'member-1', steamId: '76561198000000001', status: 'verified', revision: 1 });
  repo.put('identities', { id: 'identity-1', accountId: 'account-1', provider, externalId: 'external-1', revision: 1 });
  repo.put('squads', { id: 'squad-1', name: '后勤一队' });
  repo.put('squads', { id: 'squad-manual', name: '手动小队' });
  platform.put('config', provider, provider, 'owner', 1, { ...normalizeConfig(provider, { enabled: true }), revision: 1,
    roleSpecialtyMappings: [{ ...source, specialty: 'pipe' }],
    roleSquadMappings: [{ ...source, squadId: 'squad-1' }],
    roleSystemMappings: [{ ...source, systemRole: 'admin' }] });
  const login = async () => {
    const evidence = await identity.checkEligibility(provider, 'external-1', { includeCommunity: true });
    return identity.login({ provider, id: 'external-1' }, evidence);
  };
  return { repo, platform, identity, login, setRoles: roles => { memberRoles = roles; }, setMetadata: available => { metadataAvailable = available; }, advance: ms => { nowMs += ms; } };
}

test('role mapping schema defaults to empty, rejects incomplete and duplicate role rules', () => {
  for (const provider of ['kook', 'discord']) {
    const base = normalizeConfig(provider, { enabled: true });
    assert.deepEqual([base.roleSpecialtyMappings, base.roleSquadMappings, base.roleSystemMappings], [[], [], []]);
    assert.throws(() => normalizeConfig(provider, { enabled: true, roleSquadMappings: [{ ...source, squadId: 'squad-1' }, { ...source, id: 'other', squadId: 'squad-1' }] }), /PLATFORM_INPUT_INVALID/);
    assert.throws(() => normalizeConfig(provider, { enabled: true, roleSystemMappings: [{ id: 'bad', roleName: 'role', systemRole: 'owner' }] }), /PLATFORM_INPUT_INVALID/);
    assert.throws(() => normalizeConfig(provider, { enabled: true, roleSpecialtyMappings: [{ ...source, guildId: undefined, specialty: 'pipe' }] }), /PLATFORM_INPUT_INVALID/);
  }
});

for (const provider of ['kook', 'discord']) test(`${provider} verified role ID updates specialties, squad and system role; lost role clears derived values`, async t => {
  const f = fixture(t, provider);
  const old = f.identity.issueSession(f.repo.get('accounts', 'account-1'));
  let result = await f.login();
  assert.equal(result.step, 'complete');
  assert.deepEqual(f.repo.get('members', 'member-1').specialty, ['building', 'pipe']);
  assert.deepEqual(f.repo.all('squadMembers').filter(row => !row.validTo).map(row => row.squadId), ['squad-1']);
  assert.equal(f.identity.session(result.token).actor.roleId, 'admin');
  assert.throws(() => f.identity.session(old.token), /PERMISSIONS_CHANGED/);

  f.setMetadata(false);
  await f.login();
  assert.equal(f.identity.actorForAccount('account-1').roleId, 'admin');
  assert.equal(f.repo.all('squadMembers').filter(row => !row.validTo).length, 1);

  f.setMetadata(true);
  f.setRoles(['eligible']);
  result = await f.login();
  assert.equal(f.identity.session(result.token).actor.roleId, 'member');
  assert.deepEqual(f.repo.get('members', 'member-1').specialty, ['building']);
  assert.equal(f.repo.all('squadMembers').filter(row => !row.validTo).length, 0);

  f.repo.put('squadMembers', { id: 'manual', memberId: 'member-1', squadId: 'squad-manual', validTo: null });
  f.setRoles(['eligible', role.id]);
  await f.login();
  assert.deepEqual(f.repo.all('squadMembers').filter(row => !row.validTo).map(row => row.squadId), ['squad-manual']);
  assert.equal(f.repo.get('members', 'member-1').roleDerivedSquad, null);
});

test('multiple roles on one platform use the highest mapped system role regardless of rule order', async t => {
  const f = fixture(t, 'kook');
  const config = f.platform.get('config', 'kook');
  f.platform.put('config', 'kook', 'kook', 'owner', 2, { ...config, revision: 2,
    roleSystemMappings: [{ id: 'member-rule', guildId, roleId: 'member-role', roleName: '成员', systemRole: 'member' },
      ...config.roleSystemMappings] });
  f.setRoles(['eligible', 'member-role', role.id]);
  await f.login();
  assert.equal(f.identity.actorForAccount('account-1').roleId, 'admin');
  f.setRoles(['eligible', 'member-role']);
  await f.login();
  assert.equal(f.identity.actorForAccount('account-1').roleId, 'member');
});

test('KOOK and Discord mappings share the highest role, then fall back when its source is removed', async t => {
  const f = fixture(t, 'kook');
  let discordRoles = ['eligible', 'discord-member'];
  f.identity.providers.discord = { roles: async (externalId, guildId) => ({ externalId, guildId, roleIds: discordRoles }) };
  f.repo.put('policies', { id: 'discord', provider: 'discord', enabled: true, guildId,
    allowedRoleIds: ['eligible'], matchMode: 'any', policyRevision: 1 });
  f.repo.put('identities', { id: 'discord-identity', accountId: 'account-1', provider: 'discord',
    externalId: 'discord-external', revision: 1 });
  const discordRules = [
    { id: 'discord-member-rule', guildId, roleId: 'discord-member', roleName: '成员', systemRole: 'member' },
    { id: 'discord-admin-rule', guildId, roleId: 'discord-admin', roleName: '管理员', systemRole: 'admin' }
  ];
  f.platform.put('config', 'discord', 'discord', 'owner', 1, { ...normalizeConfig('discord', { enabled: true }),
    revision: 1, roleSystemMappings: discordRules });
  const loginDiscord = async () => {
    const evidence = await f.identity.checkEligibility('discord', 'discord-external', { includeCommunity: true });
    return f.identity.login({ provider: 'discord', id: 'discord-external' }, evidence);
  };

  const account = f.repo.get('accounts', 'account-1');
  f.repo.put('accounts', { ...account, roleId: 'admin', roleDerivedSystemRole: {
    provider: 'kook', guildId, roleId: role.id, systemRole: 'admin'
  } });
  assert.equal(f.identity.actorForAccount('account-1').roleId, 'admin');
  await loginDiscord();
  assert.equal(f.identity.actorForAccount('account-1').roleId, 'admin');
  assert.equal(f.repo.get('accounts', 'account-1').roleDerivedSystemRoles.length, 2);

  f.setRoles(['eligible']);
  await f.login();
  assert.equal(f.identity.actorForAccount('account-1').roleId, 'member');

  discordRoles = ['eligible', 'discord-admin'];
  await loginDiscord();
  const adminSession = await f.login();
  assert.equal(f.identity.session(adminSession.token).actor.roleId, 'admin');
  const config = f.platform.get('config', 'kook');
  f.platform.put('config', 'kook', 'kook', 'owner', 2, { ...config, revision: 2, roleSystemMappings: [] });
  assert.equal(accountRole(f.repo, f.repo.get('accounts', 'account-1')), 'admin');
  f.repo.remove('identities', 'discord-identity');
  assert.equal(accountRole(f.repo, f.repo.get('accounts', 'account-1')), 'member');
  assert.throws(() => f.identity.session(adminSession.token), /PERMISSIONS_CHANGED/);
});

test('expired eligibility recheck removes mapped admin access when the platform role is gone', async t => {
  const f = fixture(t, 'kook');
  const result = await f.login();
  f.setRoles(['eligible']);
  f.setMetadata(false);
  f.advance(300_001);
  await f.identity.requireFreshEligibility(f.identity.session(result.token).session);
  assert.equal(f.identity.actorForAccount('account-1').roleId, 'member');
  assert.equal(f.repo.all('squadMembers').filter(row => !row.validTo).length, 1);
  assert.deepEqual(f.repo.get('members', 'member-1').specialty, ['building', 'pipe']);
  assert.throws(() => f.identity.session(result.token), /PERMISSIONS_CHANGED/);
});

test('system role mapping is owner-only and removing it revokes effective admin access immediately', async t => {
  const f = fixture(t, 'kook');
  f.repo.put('members', { id: 'owner-member', steamId: OWNER_STEAM_ID, memberStatus: 'active', revision: 1 });
  f.repo.put('accounts', { id: 'owner', memberId: 'owner-member', status: 'active', roleId: 'member', permissionVersion: 1, revision: 1 });
  f.repo.put('bindings', { id: 'owner-binding', accountId: 'owner', memberId: 'owner-member', steamId: OWNER_STEAM_ID, status: 'verified', revision: 1 });
  f.repo.put('members', { id: 'admin-member', steamId: '76561198000000002', memberStatus: 'active', revision: 1 });
  f.repo.put('accounts', { id: 'admin', memberId: 'admin-member', status: 'active', roleId: 'admin', adminAssignedByOwner: true, permissionVersion: 1, revision: 1 });
  f.repo.put('bindings', { id: 'admin-binding', accountId: 'admin', memberId: 'admin-member', steamId: '76561198000000002', status: 'verified', revision: 1 });
  const service = new PlatformAdminService({ identity: f.identity });
  const config = service.config('kook');
  const request = rules => ({ expectedRevision: config.revision, config: { enabled: true, roleSystemMappings: rules } });
  assert.throws(() => service.save(f.identity.actorForAccount('admin'), 'kook', request([]), { operationId: randomUUID() }), /ROOT_REQUIRED/);
  const result = await f.login();
  assert.equal(accountRole(f.repo, f.repo.get('accounts', 'account-1')), 'admin');
  service.save(f.identity.actorForAccount('admin'), 'kook', { expectedRevision: 1, config: { enabled: true } }, { operationId: randomUUID() });
  assert.equal(service.config('kook').roleSystemMappings.length, 1);
  service.save(f.identity.actorForAccount('owner'), 'kook', { expectedRevision: 2, config: { enabled: true, roleSystemMappings: [] } }, { operationId: randomUUID() });
  assert.equal(accountRole(f.repo, f.repo.get('accounts', 'account-1')), 'member');
  assert.throws(() => f.identity.session(result.token), /PERMISSIONS_CHANGED/);
});
