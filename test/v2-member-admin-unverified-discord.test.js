import './support/owner-environment.mjs';
// Frozen scope-engine unit contract: fixtures explicitly opt into the scoped identity fake.
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { fixture } from './support/v2-member-admin/fixtures.mjs';
import { MemberAdminService } from '../server/v2/member-admin/service.js';
import { IdentityMemberLifecycle } from '../server/v2/management-adapters/members/lifecycle.js';

function setup(t) {
  const f = fixture({scopeContract:true}); t.after(() => f.db.close());
  f.ir.put('accounts', { ...f.ir.get('accounts', 'admin'), roleId: 'admin', adminAssignedByOwner: true });
  for (const [id, steamId] of [['discord-new', ''], ['discord-other', undefined]]) f.ir.put('members', {
    id, steamId, displayName: id, discordId: id === 'discord-new' ? '100000000000000001' : '100000000000000002',
    memberStatus: 'active', membershipStatus: 'active', revision: 1,
    discordSteamDeclaration: { steamId: '76561198999999001', ownershipVerified: false },
  });
  return f;
}
test('blank canonical Steam IDs never share risk profiles and declaration stays distinct', t => {
  const f = setup(t), s = f.service;
  s.repo.put('memberProfiles', { id: 'other-profile', memberId: 'discord-other', steamId: '', accountSignals: { gameBans: 4 } });
  assert.equal(s.riskProfile(f.ir.get('members', 'discord-new')), undefined);
  const member = s.detail(f.actor('admin'), 'discord-new');
  assert.equal(member.steamId, ''); assert.equal(member.declaredSteamId, '76561198999999001');
  assert.equal(member.identity.steamBinding, 'legacy_unverified');
  assert.equal(s.members(f.actor('admin'), { q: '76561198999999001' }).items.some(row => row.id === member.id), true);
});
test('deleting a blank Steam member preserves other blank profiles, users and receipts', t => {
  const f = setup(t), a = f.actor('admin');
  f.ir.put('users', { id: 'unrelated-empty-steam', boundSteamId: '', discordId: '100000000000000099', username: 'keep' });
  const lifecycle = new IdentityMemberLifecycle({ identity: f.identity, contexts: { assertReady: () => true, invalidate() {} } });
  const s = new MemberAdminService(f.identity, { deleteIdentity: args => lifecycle.deleteInTransaction(args) });
  for (const memberId of ['discord-new', 'discord-other']) s.repo.put('memberProfiles', { id: memberId + '-profile', memberId, steamId: '' });
  const otherOperation = randomUUID();
  s.edit(a, 'discord-other', { expectedRevision: 1, fields: { customName: 'Keep this profile' } }, otherOperation);
  const before = f.db.prepare('SELECT payload FROM v2_member_admin_operations WHERE operation_id=?').get(otherOperation).payload;
  s.deleteMembers(a, { targets: [{ id: 'discord-new', expectedRevision: 1 }] }, randomUUID());
  assert.equal(f.ir.get('members', 'discord-new'), null);
  assert.equal(s.repo.get('memberProfiles', 'discord-new-profile'), null);
  assert.ok(s.repo.get('memberProfiles', 'discord-other-profile'));
  assert.equal(f.ir.get('users', 'unrelated-empty-steam').username, 'keep');
  assert.equal(f.db.prepare('SELECT payload FROM v2_member_admin_operations WHERE operation_id=?').get(otherOperation).payload, before);
  s.deleteMembers(a, { targets: [{ id: 'discord-other', expectedRevision: 2 }] }, randomUUID());
  assert.equal(f.ir.get('users', 'unrelated-empty-steam').username, 'keep');
});
test('manual team changes clear the automatic Discord assignment even for the same team', t => {
  const f = setup(t), s = f.service, member = f.ir.get('members', 'discord-new');
  f.ir.put('members', { ...member, discordSteamTeam: { squadId: 's1', relationId: 'new-relation' } });
  f.ir.put('squadMembers', { id: 'new-relation', memberId: member.id, squadId: 's1', validTo: null });
  s.move(f.actor('admin'), member.id, { expectedRevision: 1, squadId: 's1' }, randomUUID());
  assert.equal(f.ir.get('members', member.id).discordSteamTeam, null);
});
