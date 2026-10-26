import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { fixture } from './support/v2-member-adapters/fixture.mjs';
import { createMemberOutboxConsumer } from '../server/v2/management-runtime/member-outbox.js';

test('durable member replay repairs failed cache from canonical current data without replaying mutations', async t => {
  const f = fixture(); t.after(() => f.db.close());
  const consumer = () => createMemberOutboxConsumer({ identity: f.identity, members: f.service, bundle: f.runtime, runWrite: f.queue });
  f.cacheFailure = true;
  await assert.rejects(f.write(() => f.service.edit(f.actor('admin'), 'm001', { expectedRevision: 1, fields: { customName: 'first' } }, randomUUID())));
  const current = f.ir.get('members', 'm001');
  f.ir.put('members', { ...current, customName: 'newer canonical', revision: current.revision + 1 });
  const clock = f.db.prepare('SELECT revision FROM v2_scheduling_clock').get().revision;
  const first = consumer();
  await assert.rejects(first.drain()); assert.equal(first.position(), 0);
  f.cacheFailure = false;
  assert.equal((await first.drain()).processed, 1);
  assert.equal(f.cache.members.find(m => m.id === 'm001').customName, 'newer canonical');
  assert.equal(f.db.prepare('SELECT revision FROM v2_scheduling_clock').get().revision, clock);
  assert.equal((await consumer().drain()).processed, 0);
  assert.equal(f.db.prepare('SELECT COUNT(*) n FROM v2_member_admin_outbox').get().n, 1);
});

test('startup replay drains beyond one batch and coalesces callers before reporting ready', async t => {
  const f = fixture(); t.after(() => f.db.close());
  for (let i = 0; i < 51; i++) {
    await f.write(() => f.service.edit(f.actor('admin'), 'm001', {
      expectedRevision: f.ir.get('members', 'm001').revision || 1,
      fields: { customName: `revision ${i}` }
    }, randomUUID()));
  }
  const consumer = createMemberOutboxConsumer({ identity: f.identity, members: f.service, bundle: f.runtime, runWrite: f.queue });
  const before = f.db.prepare('SELECT revision FROM v2_scheduling_clock').get().revision;
  const replay = consumer.drainAll();
  assert.equal(consumer.drainAll(), replay);
  assert.equal((await replay).processed, 51);
  assert.equal((await consumer.drain()).processed, 0);
  assert.equal(f.db.prepare('SELECT revision FROM v2_scheduling_clock').get().revision, before);
  assert.equal(f.cache.members.find(m => m.id === 'm001').customName, 'revision 50');
});
