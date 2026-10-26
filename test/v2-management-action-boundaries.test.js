import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { fixture as relayFixture } from './support/v2-realtime/fixture.mjs';
import { fixture as memberFixture } from './support/v2-member-admin/fixtures.mjs';
import { RealtimeService } from '../server/v2/realtime/service.js';
import { MemberAdminService } from '../server/v2/member-admin/service.js';
import { createLegacyManagementAuthority } from '../server/v2/management-runtime/legacy-authority.js';
import { legacyFingerprint } from '../server/v2/identity/migration.js';

test('legacy relay editor cannot elevate a member; current assigned admin can clear and demotion revokes access', async t => {
  const f = relayFixture(); t.after(() => f.db.close());
  const account = f.ir.get('accounts', 'g05_account_alpha');
  const user = { id: 'relay_editor', username: 'relay_editor', role: 'relay_editor' };
  f.ir.put('users', user);
  f.ir.put('permissionRoles', { id: 'relay_editor', code: 'relay_editor', name: 'Relay editor', permissions: { rustClanChat: { view: true, edit: true } } });
  f.ir.put('accounts', { ...account, legacyUserId: user.id, legacyFingerprint: legacyFingerprint(user, f.ir.all('permissionRoles')) });
  const service = new RealtimeService(f.identity, { ...f.options, authorizeLegacyAction: createLegacyManagementAuthority(f.identity).authorizeRealtimeAction });
  const input = { expectedRevision: f.repo.scope('alpha').revision, reason: '清理本队聊天' };
  await assert.rejects(service.command(f.actor('alpha'), 'alpha', 'clear-chat', input, randomUUID()), e => e.errorCode === 'ACCESS_DENIED');
  const admin = f.actor('admin');
  assert.equal((await service.command(admin, 'alpha', 'clear-chat', input, randomUUID())).localHistoryCleared, true);
  const saved = f.ir.get('accounts', admin.id);
  f.ir.put('accounts', { ...saved, roleId: 'member', adminAssignedByOwner: false, permissionVersion: saved.permissionVersion + 1 });
  await assert.rejects(service.command(f.actor('admin'), 'alpha', 'clear-chat', { ...input, expectedRevision: f.repo.scope('alpha').revision }, randomUUID()), e => e.errorCode === 'ACCESS_DENIED');
});

test('member sync cancellation preserves the submitted revision and never substitutes a current version', async t => {
  const f = memberFixture();
  t.after(() => f.db.close());
  const seen = [];
  const service = new MemberAdminService(f.identity, { sync: { cancel: async input => { seen.push(input); return { status: 'cancelled' }; } } });
  const input = { kind: 'steam', memberIds: ['m001'], jobId: 'job-current', expectedRevision: 3 };
  await service.sync(f.actor('admin'), input, randomUUID(), 'cancel');
  assert.equal(seen[0].expectedRevision, 3);
  await service.sync(f.actor('admin'), { ...input, expectedRevision: undefined }, randomUUID(), 'cancel');
  assert.equal(seen[1].expectedRevision, undefined);
});
