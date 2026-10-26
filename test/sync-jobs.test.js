import assert from 'node:assert/strict';
import test from 'node:test';
import {
  SYNC_JOB_RUNNER_METADATA_KEY,
  createSyncJobInStore,
  createSyncJobUnlessActiveInStore,
  findActiveSyncJob,
  mergeSyncStateForJob,
  normalizeBattlemetricsReviewCandidates,
  publicSyncJob,
  reconcileActiveSyncWork,
  staleSyncJob,
  syncJobFailureDetails,
  syncJobFailureItem,
  syncJobsActiveDuplicateSummary,
  syncJobsPayload,
  syncJobProgressPatchFromState,
  syncStateEtaSeconds,
  syncStatePercent,
  updateSyncJobInStore
} from '../server/sync-jobs.js';

test('new sync jobs do not inherit skipped counters or linkage from previous runs', () => {
  const startedAt = '2026-07-12T05:00:09.909Z';
  const running = mergeSyncStateForJob({
    status: 'completed',
    requested: 166,
    completed: 40,
    ignored: 126,
    syncJobId: 'sync_job_old',
    syncJobType: 'member_profile',
    syncJobSource: 'manual',
    syncJobScope: 'member_profile',
    startedAt: '2026-07-01T00:00:00.000Z'
  }, {
    status: 'running',
    requested: 40,
    updated: 0,
    failed: 0,
    completed: 0,
    percent: 0,
    startedAt,
    syncJobId: 'sync_job_current',
    syncJobType: 'member_profile',
    syncJobSource: 'auto',
    syncJobScope: 'member_profile'
  }, '2026-07-12T05:00:10.000Z');

  assert.equal(running.ignored, undefined);
  assert.equal(running.syncJobId, 'sync_job_current');
  assert.equal(running.syncJobSource, 'auto');

  const completed = mergeSyncStateForJob(running, {
    status: 'complete',
    requested: 40,
    updated: 40,
    failed: 0,
    completed: 40,
    percent: 100,
    startedAt,
    syncedAt: '2026-07-12T05:35:07.285Z',
    syncJobId: 'sync_job_current',
    syncJobType: 'member_profile',
    syncJobSource: 'auto',
    syncJobScope: 'member_profile'
  }, '2026-07-12T05:35:07.285Z');
  const jobPatch = syncJobProgressPatchFromState('memberProfiles', completed);

  assert.equal(jobPatch.status, 'completed');
  assert.equal(jobPatch.totalCount, 40);
  assert.equal(jobPatch.doneCount, 40);
  assert.equal(jobPatch.failedCount, 0);
  assert.equal(jobPatch.skippedCount, 0);
});

test('an explicit zero skipped count wins over a legacy ignored alias', () => {
  const jobPatch = syncJobProgressPatchFromState('memberProfiles', {
    status: 'complete',
    requested: 40,
    completed: 40,
    failed: 0,
    skipped: 0,
    ignored: 126,
    syncJobType: 'member_profile',
    syncJobSource: 'auto',
    syncJobScope: 'member_profile'
  });
  assert.equal(jobPatch.status, 'completed');
  assert.equal(jobPatch.skippedCount, 0);
});

test('sync job model keeps serial queues, stale reconciliation, and public payload semantics stable', () => {
  const oldAt = '2020-01-01T00:00:00.000Z';
  const store = { syncJobs: [], syncState: {} };

  const emptyCompleted = createSyncJobInStore(store, {
    type: 'kda',
    status: 'completed',
    totalCount: 0,
    metadata: { token: 'must_not_leak' }
  });
  assert.equal(emptyCompleted.status, 'completed');
  assert.equal(store.syncJobs.length, 0);

  const running = createSyncJobInStore(store, {
    type: 'battlemetrics_playtime',
    scope: 'battlemetrics',
    source: 'manual',
    status: 'running',
    targetWipeId: 'wipe_a',
    targetServerId: 'server_a',
    totalCount: 3,
    doneCount: 1,
    metadata: {
      runner: SYNC_JOB_RUNNER_METADATA_KEY,
      requestedMemberIds: ['member_a'],
      authorization: 'must_not_leak',
      openid: 'must_not_leak',
      safe: 'kept'
    },
    createdAt: oldAt,
    updatedAt: oldAt
  });
  const queued = createSyncJobInStore(store, {
    type: 'battlemetrics_playtime',
    scope: 'battlemetrics',
    source: 'manual',
    status: 'queued',
    targetWipeId: 'wipe_a',
    targetServerId: 'server_a',
    totalCount: 2,
    metadata: {
      runner: SYNC_JOB_RUNNER_METADATA_KEY
    },
    createdAt: oldAt,
    updatedAt: oldAt
  });
  running.createdAt = oldAt;
  running.updatedAt = oldAt;
  queued.createdAt = oldAt;
  queued.updatedAt = oldAt;

  assert.equal(staleSyncJob(queued, Date.parse('2026-01-01T00:00:00.000Z')), false);
  assert.equal(staleSyncJob(running, Date.parse('2026-01-01T00:00:00.000Z')), true);
  assert.equal(publicSyncJob(running).metadata, undefined);
  assert.equal(JSON.stringify(running.metadata).includes('must_not_leak'), false);
  assert.equal(running.metadata.safe, 'kept');

  const active = findActiveSyncJob(store, {
    type: 'battlemetrics_playtime',
    scope: 'battlemetrics',
    targetWipeId: 'wipe_a',
    targetServerId: 'server_a',
    nowMs: Date.parse(oldAt)
  });
  assert.equal(active.id, queued.id);

  const reused = createSyncJobUnlessActiveInStore(store, {
    type: 'battlemetrics_playtime',
    scope: 'battlemetrics',
    source: 'manual',
    status: 'queued',
    targetWipeId: 'wipe_a',
    targetServerId: 'server_a',
    totalCount: 9,
    metadata: { runner: SYNC_JOB_RUNNER_METADATA_KEY }
  }, {
    type: 'battlemetrics_playtime',
    scope: 'battlemetrics',
    targetWipeId: 'wipe_a',
    targetServerId: 'server_a',
    nowMs: Date.parse(oldAt)
  });
  assert.equal(reused.reused, true);
  assert.equal(reused.job.id, queued.id);
  assert.equal(store.syncJobs.filter((job) => job.type === 'battlemetrics_playtime').length, 2);

  const freshAt = new Date().toISOString();
  running.updatedAt = freshAt;
  queued.updatedAt = freshAt;
  const duplicateSummary = syncJobsActiveDuplicateSummary(store);
  assert.equal(duplicateSummary.duplicateJobCount, 1);
  assert.equal(duplicateSummary.groups[0].jobIds.includes(running.id), true);
  assert.equal(duplicateSummary.groups[0].jobIds.includes(queued.id), true);

  running.updatedAt = oldAt;
  queued.updatedAt = oldAt;
  store.syncState.battlemetrics = {
    status: 'running',
    requested: 3,
    completed: 1,
    failed: 0,
    skipped: 0,
    syncJobId: running.id,
    updatedAt: oldAt
  };
  const changed = reconcileActiveSyncWork(store, {
    nowMs: Date.parse('2026-01-01T00:00:00.000Z'),
    reason: 'stale for test'
  });
  assert.equal(changed, 2);
  assert.equal(store.syncJobs.find((job) => job.id === running.id).status, 'failed');
  assert.equal(store.syncJobs.find((job) => job.id === running.id).failedCount, 2);
  assert.equal(store.syncJobs.find((job) => job.id === queued.id).status, 'queued');
  assert.equal(store.syncState.battlemetrics.status, 'failed');
  assert.equal(store.syncState.battlemetrics.failed, 2);

  updateSyncJobInStore(store, queued.id, {
    status: 'running',
    metadata: { password: 'must_not_leak', safe2: 'kept2' }
  });
  const updatedQueued = store.syncJobs.find((job) => job.id === queued.id);
  assert.equal(updatedQueued.metadata.safe2, 'kept2');
  assert.equal(JSON.stringify(updatedQueued.metadata).includes('must_not_leak'), false);

  const payload = syncJobsPayload(store, { limit: 5 });
  assert.equal(payload.current.some((job) => job.id === queued.id), true);
  assert.equal(payload.recent.some((job) => job.id === running.id && job.status === 'failed'), true);
  assert.equal(payload.queueDepth.current, 1);
  assert.equal(payload.queueDepth.running, 1);
  assert.equal(payload.queueDepth.pendingItems, 2);
  assert.equal(payload.failureRates.total, 2);
  assert.equal(payload.failureRates.failed, 1);
  assert.equal(payload.failureRates.problem, 1);
  assert.equal(payload.failureRates.terminalProblemRate, 1);
  assert.equal(payload.byType.battlemetrics_playtime.current, 1);
  assert.equal(payload.byType.battlemetrics_playtime.failed, 1);
  assert.equal(payload.byScope.battlemetrics.problem, 1);
  assert.equal(payload.byStatus.running.current, 1);
  assert.equal(payload.byStatus.failed.terminal, 1);
});

test('KDA jobs for different Vital Wipes are queued independently', () => {
  const store = { syncJobs: [], syncState: {} };
  const oldVitalJob = createSyncJobInStore(store, {
    type: 'kda',
    scope: 'kda',
    status: 'queued',
    targetWipeId: 'wipe_a',
    targetVitalWipeId: 'vital_old',
    targetServerId: '16',
    totalCount: 2
  });
  const newVitalJob = createSyncJobUnlessActiveInStore(store, {
    type: 'kda',
    scope: 'kda',
    status: 'queued',
    targetWipeId: 'wipe_a',
    targetVitalWipeId: 'vital_new',
    targetServerId: '16',
    totalCount: 2
  }, {
    type: 'kda',
    scope: 'kda',
    targetWipeId: 'wipe_a',
    targetVitalWipeId: 'vital_new',
    targetServerId: '16'
  });

  assert.equal(newVitalJob.reused, false);
  assert.notEqual(newVitalJob.job.id, oldVitalJob.id);
  assert.equal(publicSyncJob(newVitalJob.job).targetVitalWipeId, 'vital_new');
  assert.equal(findActiveSyncJob(store, {
    type: 'kda',
    scope: 'kda',
    targetWipeId: 'wipe_a',
    targetVitalWipeId: 'vital_old',
    targetServerId: '16'
  })?.id, oldVitalJob.id);
});

test('sync job progress and failure helpers are reusable outside api router', () => {
  assert.equal(syncStatePercent(1, 4), 25);
  assert.equal(syncStatePercent(0, 0), 100);
  assert.equal(syncStatePercent(9, 4), 100);
  assert.equal(syncStateEtaSeconds('', 0, 10, 12), 12);
  assert.equal(syncStateEtaSeconds('', 10, 10, 12), 0);

  const candidates = normalizeBattlemetricsReviewCandidates([
    { id: 'bm_1', name: 'Candidate One', alias: 'alias-one', confidence: 'name', timePlayed: 12, online: true },
    { battlemetricsId: 'bm_1', displayName: 'Duplicate' },
    { playerId: 'bm_2', displayName: 'Candidate Two', serverTimePlayedSeconds: 30 },
    { id: '', displayName: 'Missing id' }
  ]);
  assert.deepEqual(candidates.map((candidate) => candidate.battlemetricsId), ['bm_1', 'bm_2']);
  assert.equal(candidates[0].displayName, 'Candidate One');
  assert.equal(candidates[0].serverTimePlayedSeconds, 12);
  assert.equal(candidates[0].online, true);

  const failure = syncJobFailureItem({ id: 'member_1', steamId: '76561198000001234', steamNickname: 'Steam Name' }, 'failed', {
    battlemetricsCandidates: candidates,
    occurredAt: '2026-01-01T00:00:00.000Z'
  });
  assert.equal(failure.displayName, 'Steam Name');
  assert.equal(failure.message, 'failed');
  assert.equal(failure.battlemetricsCandidates.length, 2);

  const details = syncJobFailureDetails([
    ...Array.from({ length: 82 }, (_, index) => ({
      memberId: `member_${index}`,
      steamId: `7656119800000${String(index).padStart(4, '0')}`,
      displayName: `Member ${index}`,
      message: `failure ${index}`,
      battlemetricsCandidates: index === 81 ? candidates : [],
      occurredAt: `2026-01-01T00:00:${String(index % 60).padStart(2, '0')}.000Z`
    }))
  ]);
  assert.equal(details.failedItems.length, 80);
  assert.equal(details.failedItems[0].memberId, 'member_2');
  assert.equal(details.failedItems.at(-1).memberId, 'member_81');
  assert.equal(details.failedItems.at(-1).battlemetricsCandidates.length, 2);
});
