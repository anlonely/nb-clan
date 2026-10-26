import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { fixture } from './support/v2-member-admin/fixtures.mjs';
import { fixture as syncFixture } from './support/v2-sync-center/fixture.mjs';
import { SchedulingService } from '../server/v2/scheduling/service.js';
import { legacyFingerprint } from '../server/v2/identity/migration.js';
import { IdentityService } from '../server/v2/identity/service.js';
import { FakeScopedIdentityService } from './support/scoped-identity-fake.mjs';

const denied = fn => assert.throws(fn, error => [403, 404].includes(error.status));

test('real fixed roles govern member and scheduling reads, with installation owner and explicit admin revocation', t => {
  const f = fixture(); t.after(() => f.db.close());
  assert.ok(f.identity instanceof IdentityService);
  assert.equal(f.identity instanceof FakeScopedIdentityService, false);
  f.ir.put('users', { id: 'user_root', username: 'root', role: 'admin' });
  f.ir.put('accounts', { id: 'user_root', legacyUserId: 'user_root', legacyFingerprint: legacyFingerprint(f.ir.get('users', 'user_root'), f.ir.all('permissionRoles')), status: 'active', roleId: 'admin', permissionVersion: 1, grants: [] });
  f.ir.setScalar('v2InstallationOwner', { version: 1, accountId: 'user_root' });
  assert.equal(f.actor('user_root').roleId, 'owner');
  assert.equal(f.actor('admin').roleId, 'admin');
  for (const id of ['leader', 'member']) {
    assert.equal(f.actor(id).roleId, 'member');
    denied(() => f.service.detail(f.actor(id), 'm036'));
  }
  assert.equal(f.service.detail(f.actor('admin'), 'm036').id, 'm036');
  assert.equal(f.service.detail(f.actor('user_root'), 'm036').id, 'm036');
  const scheduling = new SchedulingService(f.sr, f.identity, { now: f.now });
  const input = { title: 'Role matrix fixture', serverProfileId: 'fixture', serverSnapshot: { name: 'fixture' },
    timeZone: 'Asia/Shanghai', musterAt: '2030-09-08T12:00:00Z', signupOpensAt: '2030-09-08T09:00:00Z',
    signupClosesAt: '2030-09-08T13:00:00Z', audience: { squadIds: ['s1'], memberIds: [], includeUnassigned: false } };
  for (const id of ['leader', 'member']) denied(() => scheduling.createWipe(f.actor(id), input, { operationId: randomUUID() }));
  const wipe = scheduling.createWipe(f.actor('admin'), input, { operationId: randomUUID() }).current;
  assert.ok(wipe.id);
  const admin = f.ir.get('accounts', 'admin');
  f.ir.put('accounts', { ...admin, adminAssignedByOwner: false, roleId: 'member', permissionVersion: admin.permissionVersion + 1 });
  assert.equal(f.actor('admin').roleId, 'member');
  denied(() => f.service.detail(f.actor('admin'), 'm036'));
  denied(() => scheduling.createWipe(f.actor('admin'), input, { operationId: randomUUID() }));
});

test('real sync service allows owner-assigned admin, rejects legacy leader grants and observes revocation', async t => {
  const f = syncFixture(); t.after(() => f.close());
  assert.equal(f.identity instanceof FakeScopedIdentityService, false);
  const input = { type: 'kda', scope: { kind: 'members', memberIds: ['g05_alpha'] } };
  for (const key of ['leader', 'alpha']) await assert.rejects(f.service.request(f.actor(key), input, { operationId: randomUUID() }), { status: 403 });
  const { job } = await f.service.request(f.actor(), input, { operationId: randomUUID() });
  assert.equal(f.service.detail(f.actor(), job.id).id, job.id);
  const admin = f.repo.get('accounts', 'g05_account_admin');
  f.repo.put('accounts', { ...admin, adminAssignedByOwner: false, roleId: 'member', permissionVersion: admin.permissionVersion + 1 });
  denied(() => f.service.detail(f.actor(), job.id));
});
