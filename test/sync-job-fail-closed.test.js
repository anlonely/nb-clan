import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

function staleSyncJob(id) {
  const createdAt = '2026-07-10T00:00:00.000Z';
  return {
    id,
    type: 'kda',
    source: 'manual',
    scope: 'kda',
    status: 'running',
    targetWipeId: 'wipe_sync_state_fail_closed',
    targetServerId: '',
    targetServerName: '',
    totalCount: 5,
    doneCount: 1,
    failedCount: 0,
    skippedCount: 0,
    percent: 20,
    etaSeconds: 120,
    startedAt: createdAt,
    finishedAt: '',
    createdBy: 'user_root',
    errorSummary: '',
    details: {},
    metadata: {},
    createdAt,
    updatedAt: createdAt
  };
}

function assertSyncStateReadUnavailable(error) {
  return error?.status === 503 &&
    error?.code === 'sqlite_sync_state_read_unavailable' &&
    /同步状态读取暂不可用/.test(error.message) &&
    /Injected sqlite query failure for scalar_syncState/.test(error.cause?.message || '');
}

test('sqlite-primary sync state writes fail closed and terminal jobs survive queued interleavings', async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'nb-clan-sync-job-fail-closed-'));
  const previousEnv = {
    NB_DATA_DIR: process.env.NB_DATA_DIR,
    NB_ROOT_PASSWORD: process.env.NB_ROOT_PASSWORD,
    NB_STORAGE_MODE: process.env.NB_STORAGE_MODE,
    NB_SQLITE_FILE: process.env.NB_SQLITE_FILE,
    NB_DISABLE_BACKGROUND_JOBS: process.env.NB_DISABLE_BACKGROUND_JOBS,
    NB_DISABLE_EXTERNAL_VITAL: process.env.NB_DISABLE_EXTERNAL_VITAL,
    NB_RUSTPLUS_RELAY_CHAT_FLUSH_INTERVAL_MS: process.env.NB_RUSTPLUS_RELAY_CHAT_FLUSH_INTERVAL_MS
  };
  process.env.NB_DATA_DIR = dataDir;
  process.env.NB_ROOT_PASSWORD = 'RootPass123!';
  process.env.NB_STORAGE_MODE = 'sqlite-primary';
  process.env.NB_SQLITE_FILE = path.join(dataDir, 'nb-clan.sqlite');
  process.env.NB_DISABLE_BACKGROUND_JOBS = '1';
  process.env.NB_DISABLE_EXTERNAL_VITAL = '1';
  process.env.NB_RUSTPLUS_RELAY_CHAT_FLUSH_INTERVAL_MS = '0';

  try {
    const storeModule = await import('../server/store.js');
    const memberStoreModule = await import('../server/member-store.js');
    const repositoryModule = await import('../server/storage/repository.js');
    const syncJobStoreModule = await import('../server/sync-job-store.js');
    await storeModule.ensureStore();

    const staleJob = staleSyncJob('sync_job_scalar_failure');
    const originalSyncState = {
      kda: {
        status: 'running',
        requested: 5,
        completed: 1,
        failed: 0,
        percent: 20,
        startedAt: staleJob.startedAt,
        updatedAt: staleJob.updatedAt
      },
      untouched: {
        status: 'completed',
        marker: 'must_survive'
      }
    };
    await repositoryModule.writeSqliteStorePatch({
      reason: 'sync_job_fail_closed_seed',
      upserts: { syncJobs: [staleJob] },
      scalars: { syncState: originalSyncState }
    });

    repositoryModule.injectSqliteQueryFailureForTests('scalar_syncState', 1);
    await assert.rejects(
      () => syncJobStoreModule.writeSyncState('kda', { status: 'running', completed: 2 }),
      assertSyncStateReadUnavailable
    );
    assert.deepEqual(await repositoryModule.getSqliteScalar('syncState'), originalSyncState);

    repositoryModule.injectSqliteQueryFailureForTests('scalar_syncState', 1);
    await assert.rejects(
      () => syncJobStoreModule.reconcileStaleSyncWork({ nowMs: Date.parse('2026-07-10T01:00:00.000Z') }),
      assertSyncStateReadUnavailable
    );
    assert.deepEqual(await repositoryModule.getSqliteScalar('syncState'), originalSyncState);
    assert.equal((await repositoryModule.getSqliteRecord('syncJobs', staleJob.id)).status, 'running');

    repositoryModule.injectSqliteQueryFailureForTests('scalar_syncState', 1);
    await assert.rejects(
      () => syncJobStoreModule.reconcileActiveSyncWorkOnStartup(),
      assertSyncStateReadUnavailable
    );
    assert.deepEqual(await repositoryModule.getSqliteScalar('syncState'), originalSyncState);
    assert.equal((await repositoryModule.getSqliteRecord('syncJobs', staleJob.id)).status, 'running');

    repositoryModule.injectSqliteQueryFailureForTests('scalar_syncState', 1);
    await assert.rejects(
      () => memberStoreModule.readMemberProfileSyncCancelRequested('memberProfiles', staleJob.id),
      (error) => error?.status === 503 &&
        error?.code === 'member_profile_sync_cancel_read_unavailable' &&
        /成员资料同步取消状态读取暂不可用/.test(error.message) &&
        /Injected sqlite query failure for scalar_syncState/.test(error.cause?.message || '')
    );

    const memberProfileJob = {
      ...staleSyncJob('sync_job_member_profile_fresh'),
      type: 'member_profile',
      scope: 'member_profile',
      totalCount: 40,
      doneCount: 0,
      percent: 0,
      startedAt: '2026-07-12T05:00:09.909Z',
      createdAt: '2026-07-12T05:00:09.881Z',
      updatedAt: '2026-07-12T05:00:09.909Z'
    };
    await repositoryModule.writeSqliteStorePatch({
      reason: 'sync_job_cross_run_counter_seed',
      upserts: { syncJobs: [memberProfileJob] },
      scalars: {
        syncState: {
          ...originalSyncState,
          memberProfiles: {
            status: 'complete',
            requested: 166,
            updated: 40,
            failed: 0,
            completed: 40,
            ignored: 126,
            syncJobId: 'sync_job_member_profile_old',
            syncJobType: 'member_profile',
            syncJobSource: 'manual',
            syncJobScope: 'member_profile',
            startedAt: '2026-07-01T00:00:00.000Z'
          }
        }
      }
    });
    await syncJobStoreModule.writeSyncState('memberProfiles', {
      status: 'running',
      requested: 40,
      updated: 0,
      failed: 0,
      completed: 0,
      skipped: 0,
      percent: 0,
      startedAt: memberProfileJob.startedAt,
      syncJobId: memberProfileJob.id,
      syncJobType: 'member_profile',
      syncJobSource: 'auto',
      syncJobScope: 'member_profile'
    });
    const freshState = (await repositoryModule.getSqliteScalar('syncState')).memberProfiles;
    const freshJob = await repositoryModule.getSqliteRecord('syncJobs', memberProfileJob.id);
    assert.equal(freshState.ignored, undefined);
    assert.equal(freshState.skipped, 0);
    assert.equal(freshState.syncJobId, memberProfileJob.id);
    assert.equal(freshState.syncJobSource, 'auto');
    assert.equal(freshJob.status, 'running');
    assert.equal(freshJob.skippedCount, 0);

    await syncJobStoreModule.writeSyncState('memberProfiles', {
      status: 'complete',
      requested: 40,
      updated: 40,
      failed: 0,
      completed: 40,
      skipped: 0,
      percent: 100,
      startedAt: memberProfileJob.startedAt,
      syncedAt: '2026-07-12T05:35:07.285Z',
      syncJobId: memberProfileJob.id,
      syncJobType: 'member_profile',
      syncJobSource: 'auto',
      syncJobScope: 'member_profile'
    });
    const completedProfileJob = await repositoryModule.getSqliteRecord('syncJobs', memberProfileJob.id);
    assert.equal(completedProfileJob.status, 'completed');
    assert.equal(completedProfileJob.doneCount, 40);
    assert.equal(completedProfileJob.failedCount, 0);
    assert.equal(completedProfileJob.skippedCount, 0);

    await repositoryModule.writeSqliteStorePatch({
      reason: 'sync_job_fail_closed_interleaving_reset',
      deletes: { syncJobs: [staleJob.id, memberProfileJob.id] },
      scalars: { syncState: {} }
    });

    const terminalPatches = {
      completed: { doneCount: 5, failedCount: 0, skippedCount: 0, errorSummary: '' },
      failed: { doneCount: 2, failedCount: 3, skippedCount: 0, errorSummary: 'terminal failure' },
      cancelled: { doneCount: 2, failedCount: 0, skippedCount: 3, errorSummary: 'terminal cancellation' }
    };
    for (const [status, counts] of Object.entries(terminalPatches)) {
      const job = staleSyncJob(`sync_job_interleaving_${status}`);
      await repositoryModule.writeSqliteStorePatch({
        reason: `sync_job_interleaving_${status}_seed`,
        upserts: { syncJobs: [job] }
      });
      const finishedAt = `2026-07-10T00:10:0${Object.keys(terminalPatches).indexOf(status)}.000Z`;
      const terminalWrite = syncJobStoreModule.updateSyncJob(job.id, {
        status,
        ...counts,
        percent: 100,
        etaSeconds: 0,
        finishedAt,
        updatedAt: finishedAt
      });
      const staleReconcile = syncJobStoreModule.reconcileStaleSyncWork({
        nowMs: Date.parse('2026-07-10T01:00:00.000Z')
      });
      const lateProgress = syncJobStoreModule.updateSyncJob(job.id, {
        status: 'running',
        doneCount: 4,
        failedCount: 0,
        skippedCount: 0,
        percent: 80,
        etaSeconds: 30,
        finishedAt: '',
        errorSummary: '',
        updatedAt: '2026-07-10T00:20:00.000Z'
      });
      const [, , lateProgressResult] = await Promise.all([terminalWrite, staleReconcile, lateProgress]);

      const persisted = await repositoryModule.getSqliteRecord('syncJobs', job.id);
      assert.equal(lateProgressResult, null);
      assert.equal(persisted.status, status);
      assert.equal(persisted.doneCount, counts.doneCount);
      assert.equal(persisted.failedCount, counts.failedCount);
      assert.equal(persisted.skippedCount, counts.skippedCount);
      assert.equal(persisted.percent, 100);
      assert.equal(persisted.etaSeconds, 0);
      assert.equal(persisted.finishedAt, finishedAt);
      assert.equal(persisted.errorSummary, counts.errorSummary);
    }
  } finally {
    const sqliteModule = await import('../server/storage/sqlite.js');
    await sqliteModule.closeSqliteDatabasesForTests();
    for (const [key, value] of Object.entries(previousEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await rm(dataDir, { recursive: true, force: true });
  }
});
