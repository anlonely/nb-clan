import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { installIdentitySchema, IdentityRepository } from '../server/v2/identity/repository.js';
import { IdentityService } from '../server/v2/identity/service.js';
import { grant } from '../server/v2/identity/permissions.js';
import { installSchedulingSchema, SchedulingRepository } from '../server/v2/scheduling/repository.js';
import { SchedulingService } from '../server/v2/scheduling/service.js';

test('signup roster includes member profile details only for an authorized member reader', t => {
  const db = new DatabaseSync(':memory:');
  t.after(() => db.close());
  installIdentitySchema(db);
  installSchedulingSchema(db);
  const members = new IdentityRepository(db);
  const schedules = new SchedulingRepository(db);
  schedules.setScalar('v2SchedulingMigration', { sourceHash: 'test' });
  const identity = new IdentityService(members, { now: () => Date.parse('2030-09-08T10:00:00Z') });
  const service = new SchedulingService(schedules, identity, { now: () => Date.parse('2030-09-08T10:00:00Z') });
  members.put('squads', { id: 'sq1', name: 'CN' });
  members.put('members', { id: 'm1', memberStatus: 'active', steamId: '76561199886302711',
    displayName: 'AN', avatar: 'https://avatars.steamstatic.com/example.jpg', specialty: ['pipe', 'gunman'] });
  members.put('squadMembers', { id: 'membership1', memberId: 'm1', squadId: 'sq1' });
  members.put('accounts', { id: 'member1', memberId: 'm1', status: 'active', revision: 1, permissionVersion: 1 });
  members.put('bindings', { id: 'binding1', memberId: 'm1', accountId: 'member1', steamId: '76561199886302711', status: 'verified' });
  members.put('accounts', { id: 'admin', roleId: 'admin', adminAssignedByOwner: true,
    status: 'active', revision: 1, permissionVersion: 1 });
  members.put('accounts', { id: 'limited', status: 'active', revision: 1, permissionVersion: 1 });
  const actor = id => identity.actorForAccount(id);
  const wipe = service.createWipe(actor('admin'), {
    title: 'Local wipe', serverProfileId: 'server1', serverSnapshot: { name: 'Server' }, timeZone: 'Asia/Shanghai',
    musterAt: '2030-09-08T12:00:00Z', serverScheduledWipeAt: '2030-09-08T11:00:00Z',
    signupOpensAt: '2030-09-08T09:00:00Z', signupClosesAt: '2030-09-08T13:00:00Z',
    audience: { squadIds: ['sq1'], memberIds: [], includeUnassigned: false }
  }, { operationId: randomUUID() }).current;
  service.transition(actor('admin'), wipe.id, 'publish', { expectedRevision: 1 }, { operationId: randomUUID() });

  const [row] = service.listSignups(actor('admin'), wipe.id).items;
  assert.deepEqual({ displayName: row.displayName, steamId: row.steamId, avatar: row.avatar,
    specialty: row.specialty, squadName: row.squadName, canViewProfile: row.canViewProfile }, {
    displayName: 'AN', steamId: '76561199886302711', avatar: 'https://avatars.steamstatic.com/example.jpg',
    specialty: ['pipe', 'gunman'], squadName: 'CN', canViewProfile: true
  });

  const originalActorForAccount = identity.actorForAccount.bind(identity);
  identity.actorForAccount = id => id === 'limited' ? {
    ...originalActorForAccount(id), grants: ['wipes.read', 'signups.read'].map(capability => grant(capability, { type: 'all' }))
  } : originalActorForAccount(id);
  const [limitedRow] = service.listSignups(actor('limited'), wipe.id).items;
  assert.equal(limitedRow.canViewProfile, false);
  for (const field of ['steamId', 'avatar', 'specialty', 'squadName']) assert.equal(Object.hasOwn(limitedRow, field), false);
});
