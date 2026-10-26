import test from 'node:test';
import assert from 'node:assert/strict';
import { createFixture } from './support/v2-notifications/fixture.js';

test('notification outbox polls only unconsumed events after a large retained history', async t => {
  const f = createFixture({ adminRole: true });
  t.after(async () => { await f.system.worker.stop(); f.close(); });
  const repo = f.system.service.repo;
  const run = () => f.system.worker.runOnce({ workerId: 'runtime-check', limit: 2 });
  await run();
  repo.transaction(() => {
    for (let i = 0; i < 2_000; i++) {
      const id = `history-${i}`;
      f.scheduling.repo.put('outbox', { id, eventId: id, type: 'signup.changed', wipeId: f.wipe.id,
        createdAt: '2025-01-01T00:00:00.000Z' });
      repo.put('consumedEvents', { id, eventId: id, consumedAt: '2025-01-01T00:00:00.000Z' });
    }
    for (const [id, eventId, createdAt] of [
      ['pending-a', 'event-a', '2030-01-03T00:00:00.000Z'],
      ['pending-b', 'event-b', '2030-01-01T00:00:00.000Z'],
      ['pending-c', null, '2030-01-02T00:00:00.000Z']
    ]) f.scheduling.repo.put('outbox', { id, eventId, type: 'signup.changed', wipeId: f.wipe.id, createdAt });
  });
  const get = repo.get.bind(repo);
  let consumedReads = 0;
  repo.get = (name, id) => { if (name === 'consumedEvents') consumedReads++; return get(name, id); };
  await run();
  assert.ok(consumedReads <= 2, `A two-event batch made ${consumedReads} per-event history lookups`);
  assert.ok(get('consumedEvents', 'event-b'));
  assert.ok(get('consumedEvents', 'pending-c'));
  assert.equal(get('consumedEvents', 'event-a'), null);
  consumedReads = 0;
  await run();
  assert.ok(get('consumedEvents', 'event-a'));
  assert.ok(consumedReads <= 1);
  consumedReads = 0;
  await run();
  assert.equal(consumedReads, 0);
  assert.equal(f.transport.calls.length, 0);
});

for (const blocker of ['unknown_edit', 'running_edit', 'running_lookup']) {
  test(`${blocker} operations do not starve unrelated queued notifications`, async t => {
    const f = createFixture({ adminRole: true });
    t.after(async () => { await f.system.worker.stop(); f.close(); });
    const service = f.system.service, repo = service.repo;
    const preview = service.createPreview(f.actor(), f.wipe.id, f.input(), f.operation('preview')).current;
    const intent = service.createIntent(f.actor(), f.wipe.id, {
      previewId: preview.id, contentHash: preview.contentHash, expectedContentRevision: preview.contentRevision,
      purpose: preview.purpose, purposeInstance: preview.purposeInstance
    }, f.operation('intent')).current;
    const delivery = repo.get('deliveries', intent.deliveryIds[0]);
    const kind = blocker === 'running_lookup' ? 'lookup' : 'edit';
    repo.put('deliveries', { ...delivery, id: 'previous', intentId: 'previous-intent', status: 'delivery_unknown' });
    for (let i = 0; i < 20; i++) repo.put('messageOperations', {
      id: `blocked-${i}`, deliveryId: 'previous', messageRefId: kind === 'edit' ? 'previous-ref' : null,
      kind, status: 'queued', createdAt: '2020-01-01T00:00:00.000Z'
    });
    repo.put('messageOperations', {
      id: 'blocker', deliveryId: 'previous', messageRefId: kind === 'edit' ? 'previous-ref' : null, kind,
      status: blocker === 'unknown_edit' ? 'unknown' : 'running',
      leaseUntil: new Date(f.clock.now + 60_000).toISOString(), createdAt: '2020-01-01T00:00:00.000Z'
    });
    const result = await f.system.worker.runOnce({ workerId: 'fairness-check', limit: 20 });
    assert.equal(result.sent, 1);
    assert.equal(repo.get('deliveries', delivery.id).status, 'sent');
    assert.equal(f.transport.calls.filter(call => call.operation === 'send').length, 1);
    assert.equal(f.transport.calls.filter(call => ['edit', 'lookup'].includes(call.operation)).length, 0);
    assert.equal(repo.get('messageOperations', 'blocked-0').status, 'queued');
  });
}
