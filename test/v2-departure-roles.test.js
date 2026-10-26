// Frozen scope-engine unit contract: fixtures explicitly opt into the scoped identity fake.
import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture } from './support/v2-member-admin/fixtures.mjs';

test('departure candidates follow current Discord and KOOK admission roles only', async t => {
  const x = fixture({scopeContract:true});
  t.after(() => x.db.close());
  x.ir.put('accounts', { ...x.ir.get('accounts', 'admin'), roleId: 'admin', adminAssignedByOwner: true });
  const actor = x.actor('admin');
  for (const provider of ['discord', 'kook']) {
    x.ir.put('policies', { id: `policy_${provider}`, provider, enabled: true,
      guildId: `${provider}_guild`, allowedRoleIds: [`${provider}_admission`], matchMode: 'any', policyRevision: 1 });
  }
  for (const [provider, accountId, externalId] of [
    ['discord', 'leader', 'discord_one'], ['kook', 'leader', 'kook_one'],
    ['discord', 'member', 'discord_two'], ['kook', 'member', 'kook_two']
  ]) x.ir.put('identities', { id: `${provider}_${accountId}`, provider, accountId, externalId, revision: 1 });
  x.identity.providers = {
    discord: { admissionRoles: async () => ['discord_admission'], roles: async (externalId, guildId) => {
      if (externalId === 'discord_two') throw Object.assign(new Error('unavailable'), { errorCode: 'ELIGIBILITY_UNAVAILABLE' });
      return { externalId, guildId, roleIds: ['other'] };
    } },
    kook: { admissionRoles: async () => ['kook_admission'], roles: async (externalId, guildId) => ({ externalId, guildId,
      roleIds: externalId === 'kook_one' ? ['kook_admission'] : ['other'] }) }
  };
  x.ir.put('members', { ...x.ir.get('members', 'm003'), memberStatus: 'left' });
  x.ir.put('members', { ...x.ir.get('members', 'm004'), discordMembershipStatus: 'missing_role' });
  const scan = await x.service.scanDeparture(actor);
  assert.equal(scan.checkedBindings, 4);
  assert.equal(scan.flagged, 2);
  assert.equal(scan.failed, 1);
  const candidates = x.service.members(actor, { departure: '1' });
  assert.deepEqual(candidates.items.map(m => m.id), ['m001', 'm002']);
  assert.deepEqual(candidates.items.map(m => m.platformAudits.filter(a => ['missing_role', 'not_in_guild'].includes(a.status)).map(a => a.provider)), [['discord'], ['kook']]);
  assert.equal(x.service.members(x.actor('viewer'), { departure: '1' }).total, 0);
  assert.equal((await x.service.scanDeparture(x.actor('viewer'))).checkedBindings, 0);

  // A missing configured role is a policy error, not evidence that everyone left.
  x.identity.providers.kook.admissionRoles = async () => ['other'];
  await x.service.scanDeparture(actor);
  assert.deepEqual(x.service.members(actor, { departure: '1' }).items.map(m => m.id), ['m001']);
  assert.equal(x.service.repo.get('v2CommunityRoleAudits', 'm002:kook').status, 'check_failed');
  x.identity.providers.kook.admissionRoles = async () => ['kook_admission'];
  await x.service.scanDeparture(actor);
  x.identity.providers.kook.roles = async (externalId, guildId) => {
    if (externalId === 'kook_two') throw Object.assign(new Error('absent'), { errorCode: 'ELIGIBILITY_DENIED' });
    return { externalId, guildId, roleIds: ['kook_admission'] };
  };
  await x.service.scanDeparture(actor);
  assert.equal(x.service.repo.get('v2CommunityRoleAudits', 'm002:kook').status, 'not_in_guild');

  // A role-policy edit and an identity replacement invalidate old observations immediately.
  x.ir.put('policies', { ...x.ir.get('policies', 'policy_discord'), policyRevision: 2 });
  assert.deepEqual(x.service.members(actor, { departure: '1' }).items.map(m => m.id), ['m002']);
  x.ir.put('identities', { ...x.ir.get('identities', 'kook_member'), externalId: 'kook_new', revision: 2 });
  assert.equal(x.service.members(actor, { departure: '1' }).total, 0);
});

test('departure scan continues across batches without expiring its own cursor', async t => {
  const x = fixture({scopeContract:true});
  t.after(() => x.db.close());
  x.ir.put('accounts', { ...x.ir.get('accounts', 'admin'), roleId: 'admin', adminAssignedByOwner: true });
  x.ir.put('policies', { id: 'policy_discord', provider: 'discord', enabled: true,
    guildId: 'guild', allowedRoleIds: ['admission'], matchMode: 'any', policyRevision: 1 });
  for (let n = 1; n <= 6; n++) {
    const accountId = n === 1 ? 'leader' : n === 2 ? 'member' : `scan_${n}`;
    if (n > 2) x.ir.put('accounts', { id: accountId, memberId: `m00${n}`, status: 'active', revision: 1,
      permissionVersion: 1, grants: [] });
    x.ir.put('identities', { id: `scan_identity_${n}`, accountId, provider: 'discord',
      externalId: `discord_${n}`, revision: 1 });
  }
  x.identity.providers = { discord: {
    admissionRoles: async () => ['admission'],
    roles: async (externalId, guildId) => ({ externalId, guildId, roleIds: [] })
  } };
  const actor = x.actor('admin'), beforeRevision = x.service.repo.revision();
  const first = await x.service.scanDeparture(actor);
  assert.equal(first.scannedMembers, 4);
  assert.ok(first.nextCursor);
  assert.equal(x.service.repo.revision(), beforeRevision);
  const second = await x.service.scanDeparture(actor, { cursor: first.nextCursor });
  assert.equal(second.scannedMembers, 2);
  assert.equal(second.nextCursor, null);
  assert.equal(x.service.members(actor, { departure: '1' }).total, 6);
});
