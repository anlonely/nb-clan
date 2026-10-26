import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture } from './support/v2-realtime/fixture.mjs';
import { createLegacyManagementAuthority } from '../server/v2/management-runtime/legacy-authority.js';

test('current fixed role authorizes legacy writes; stored grants and stale actors cannot restore demoted authority', t => {
  const f = fixture(); t.after(() => f.db.close());
  const authority = createLegacyManagementAuthority(f.identity), wipe = { kind: 'wipe', id: 'local' };
  const member = f.actor('alpha'), admin = f.actor('admin');
  assert.equal(authority.authorizeStatsWrite(member, 'stats.import', wipe), false);
  assert.equal(authority.authorizeStatsWrite(admin, 'stats.import', wipe), true);
  assert.equal(authority.authorizeStatsWrite(admin, 'history.visibility', wipe), true);
  assert.equal(authority.authorizeRealtimeAction(admin, 'reset', f.repo.scope('alpha')), true);
  const account = f.ir.get('accounts', admin.id);
  f.ir.put('accounts', { ...account, roleId: 'member', adminAssignedByOwner: false, permissionVersion: account.permissionVersion + 1 });
  for (const actor of [admin, f.actor('admin')]) {
    assert.equal(authority.authorizeStatsWrite(actor, 'stats.import', wipe), false);
    assert.equal(authority.authorizeStatsWrite(actor, 'history.visibility', wipe), false);
    assert.equal(authority.authorizeRealtimeAction(actor, 'reset', f.repo.scope('alpha')), false);
  }
});
