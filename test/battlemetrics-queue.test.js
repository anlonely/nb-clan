import assert from 'node:assert/strict';
import test from 'node:test';
import {
  battlemetricsQueueMetaForIdentitySync,
  battlemetricsQueueMetaForSync,
  createBattlemetricsQueueRuntime,
  normalizeBattlemetricsQueueMeta
} from '../server/battlemetrics-queue.js';

function wait(ms = 0) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

test('battlemetrics queue meta keeps manual queries ahead of sync work', () => {
  assert.deepEqual(battlemetricsQueueMetaForSync({ statusKey: 'battlemetricsQuery' }), {
    source: 'manual-query',
    priority: 100,
    operation: 'member_query',
    label: 'Member query realtime refresh'
  });
  assert.deepEqual(battlemetricsQueueMetaForSync({ manual: true }), {
    source: 'manual-sync',
    priority: 60,
    operation: 'manual_sync',
    label: 'Manual online-time sync'
  });
  assert.deepEqual(battlemetricsQueueMetaForIdentitySync(), {
    source: 'system',
    priority: 40,
    operation: 'match_players',
    label: 'Match BattleMetrics player IDs'
  });
  assert.equal(normalizeBattlemetricsQueueMeta({ source: 'hourly-sync' }).priority, 10);
  assert.equal(normalizeBattlemetricsQueueMeta({ source: 'bad', operation: 'custom_op' }).source, 'manual-sync');
});

test('battlemetrics queue prioritizes pending tasks and records completion/failure metrics', async () => {
  let nextId = 0;
  const runtime = createBattlemetricsQueueRuntime({
    minIntervalMs: 0,
    createIdImpl: (prefix) => `${prefix}_${++nextId}`
  });
  const order = [];
  let releaseFirst;
  const firstReleased = new Promise((resolve) => {
    releaseFirst = resolve;
  });

  const first = runtime.enqueue({
    meta: { source: 'hourly-sync', priority: 1, operation: 'first' },
    run: async () => {
      order.push('first-start');
      await firstReleased;
      order.push('first-end');
      return 'first';
    }
  });
  await wait(5);
  const high = runtime.enqueue({
    meta: { source: 'manual-query', operation: 'high' },
    run: async () => {
      order.push('high');
      return 'high';
    }
  });
  const failing = runtime.enqueue({
    meta: { source: 'system', operation: 'failing' },
    run: async () => {
      order.push('failing');
      throw new Error('expected failure');
    }
  });

  const queuedSnapshot = runtime.snapshot();
  assert.equal(queuedSnapshot.running, true);
  assert.equal(queuedSnapshot.active.operation, 'first');
  assert.deepEqual(queuedSnapshot.pending.map((task) => task.operation), ['high', 'failing']);
  assert.equal(queuedSnapshot.pendingBySource.manualQuery, 1);
  assert.equal(queuedSnapshot.pendingBySource.system, 1);

  releaseFirst();
  assert.equal(await first, 'first');
  assert.equal(await high, 'high');
  await assert.rejects(failing, /expected failure/);
  assert.deepEqual(order, ['first-start', 'first-end', 'high', 'failing']);

  const doneSnapshot = runtime.snapshot();
  assert.equal(doneSnapshot.running, false);
  assert.equal(doneSnapshot.pendingCount, 0);
  assert.equal(doneSnapshot.totals.completed, 2);
  assert.equal(doneSnapshot.totals.failed, 1);
  assert.equal(doneSnapshot.lastCompleted.operation, 'high');
  assert.equal(doneSnapshot.lastFailed.operation, 'failing');
  assert.equal(doneSnapshot.lastFailed.error, 'expected failure');
});

test('battlemetrics queue tracks request windows and provider throttling in snapshots', async () => {
  const runtime = createBattlemetricsQueueRuntime({
    minIntervalMs: 0,
    requestsPerMinute: 20,
    autoRequestsPerMinute: 3,
    rateLimitSafetyFactor: 0.5,
    rateLimitHeadroom: 1,
    rateLimitWindowMs: 60_000
  });

  await runtime.waitTurn({ source: 'manual-query' });
  await runtime.waitTurn({ source: 'hourly-sync' });
  let snapshot = runtime.snapshot();
  assert.equal(snapshot.limits.globalUsed, 2);
  assert.equal(snapshot.limits.autoUsed, 1);
  assert.equal(snapshot.limits.autoPerMinute, 3);

  runtime.observeRateLimitHeaders({
    get(name) {
      if (name === 'x-rate-limit-limit') return '10';
      if (name === 'x-rate-limit-remaining') return '0';
      return null;
    }
  });
  snapshot = runtime.snapshot();
  assert.equal(snapshot.limits.globalPerMinute, 5);
  assert.equal(Boolean(snapshot.limits.rateLimitedUntil), true);
  assert.equal(snapshot.limits.nextAvailableInSeconds >= 0, true);

  runtime.markBlocked(1000);
  snapshot = runtime.snapshot();
  assert.equal(Boolean(snapshot.limits.blockedUntil), true);
});
