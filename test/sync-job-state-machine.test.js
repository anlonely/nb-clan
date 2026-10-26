import assert from 'node:assert/strict';
import test from 'node:test';

import {
  reconcileActiveSyncWork,
  syncJobStatusTransitionAllowed,
  updateSyncJobInStore
} from '../server/sync-jobs.js';

function syncJob(status, id) {
  return {
    id,
    type: 'kda',
    source: 'manual',
    scope: 'kda',
    status,
    totalCount: 5,
    doneCount: 2,
    failedCount: status === 'failed' ? 3 : 0,
    skippedCount: status === 'cancelled' ? 3 : 0,
    percent: 100,
    etaSeconds: 0,
    startedAt: '2026-07-10T00:00:00.000Z',
    finishedAt: '2026-07-10T00:05:00.000Z',
    errorSummary: status === 'failed' ? 'terminal failure' : '',
    details: {},
    metadata: {},
    createdAt: '2026-07-10T00:00:00.000Z',
    updatedAt: '2026-07-10T00:05:00.000Z'
  };
}

test('sync job terminal states reject stale reconcile and late progress patches', () => {
  for (const status of ['completed', 'partial_failed', 'failed', 'cancelled']) {
    const original = syncJob(status, `sync_job_terminal_${status}`);
    const expected = structuredClone(original);
    const store = { syncJobs: [original], syncState: {} };

    assert.equal(syncJobStatusTransitionAllowed(status, 'running'), false);
    assert.equal(syncJobStatusTransitionAllowed(status, status), false);
    assert.equal(syncJobStatusTransitionAllowed(status, status === 'failed' ? 'cancelled' : 'failed'), false);
    assert.strictEqual(updateSyncJobInStore(store, original.id, {
      status: 'running',
      doneCount: 4,
      failedCount: 0,
      skippedCount: 0,
      percent: 80,
      etaSeconds: 30,
      finishedAt: '',
      errorSummary: ''
    }), original);
    assert.strictEqual(updateSyncJobInStore(store, original.id, {
      doneCount: 5,
      percent: 99,
      updatedAt: '2026-07-10T00:06:00.000Z'
    }), original);
    assert.equal(reconcileActiveSyncWork(store, {
      force: true,
      status: 'failed',
      nowMs: Date.parse('2026-07-10T01:00:00.000Z')
    }), 0);
    assert.deepEqual(store.syncJobs[0], expected);
  }
});

test('sync job state transitions preserve the existing active-to-terminal flow', () => {
  assert.equal(syncJobStatusTransitionAllowed('queued', 'running'), true);
  assert.equal(syncJobStatusTransitionAllowed('running', 'completed'), true);
  assert.equal(syncJobStatusTransitionAllowed('running', 'failed'), true);
  assert.equal(syncJobStatusTransitionAllowed('running', 'cancelled'), true);
  assert.equal(syncJobStatusTransitionAllowed('running', 'queued'), false);

  const running = syncJob('running', 'sync_job_active_transition');
  running.finishedAt = '';
  running.percent = 40;
  running.etaSeconds = 60;
  const store = { syncJobs: [running], syncState: {} };
  const completed = updateSyncJobInStore(store, running.id, {
    status: 'completed',
    doneCount: 5,
    percent: 100,
    etaSeconds: 0,
    updatedAt: '2026-07-10T00:05:00.000Z'
  });

  assert.notStrictEqual(completed, running);
  assert.equal(completed.status, 'completed');
  assert.equal(completed.doneCount, 5);
  assert.equal(completed.finishedAt, '2026-07-10T00:05:00.000Z');
});
