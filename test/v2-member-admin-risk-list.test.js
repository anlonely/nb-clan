import './support/owner-environment.mjs';
// Frozen scope-engine unit contract: fixtures explicitly opt into the scoped identity fake.
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { fixture } from './support/v2-member-admin/fixtures.mjs';
import { riskEvidence } from '../server/v2/member-admin/risk.js';

const admin = x => {
  x.ir.put('accounts', { ...x.ir.get('accounts', 'admin'), roleId: 'admin', adminAssignedByOwner: true });
  return x.actor('admin');
};
const owner = x => {
  const steamId = '76561198999999001';
  x.ir.put('members', { ...x.ir.get('members', 'm003'), steamId });
  x.ir.put('accounts', { ...x.ir.get('accounts', 'root'), memberId: 'm003' });
  x.ir.put('bindings', { id: 'binding-root', accountId: 'root', memberId: 'm003', steamId, status: 'verified' });
  return x.actor('root');
};

test('risk list contains only members and evidence matched by enabled rules', t => {
  const x = fixture({scopeContract:true});
  t.after(() => x.db.close());
  const actor = admin(x);
  const page = x.service.risks(actor);
  assert.equal(page.total, 1);
  assert.deepEqual(page.items.map(item => item.member.id), ['m001']);
  assert.ok(page.items[0].alerts.length > 0);
  assert.ok(page.items[0].alerts.every(alert => x.service.rules(actor).rules.some(rule => rule.enabled && rule.id === alert.id)));
  assert.equal(x.service.detail(actor, 'm002').risks.length, 0);
  assert.deepEqual(riskEvidence({ accountSignals: {} }, []), []);
});

test('an enabled unavailable-data rule is paged as a real rule hit', t => {
  const x = fixture({scopeContract:true});
  t.after(() => x.db.close());
  const actor = admin(x);
  const rule = { id: 'inventory-unavailable', name: '库存不可见', type: 'private_inventory', operator: 'unavailable', threshold: 0, enabled: true, squadFilter: '' };
  x.service.saveRules(owner(x), { expectedRevision: 1, rules: [rule], squadFilter: '' }, randomUUID());
  const first = x.service.risks(actor, { limit: 30 });
  assert.equal(first.total, 64);
  assert.equal(first.items.length, 30);
  assert.ok(first.nextCursor);
  assert.ok(first.items.every(item => item.alerts.length === 1 && item.alerts[0].id === rule.id));
  const second = x.service.risks(actor, { limit: 30, cursor: first.nextCursor });
  assert.equal(second.total, 64);
  assert.equal(second.items.length, 30);
  assert.equal(new Set([...first.items, ...second.items].map(item => item.member.id)).size, 60);
  assert.throws(() => x.service.risks(actor, { limit: 30, cursor: first.nextCursor, q: 'changed' }), { errorCode: 'CURSOR_EXPIRED' });
});
