import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

test('sqlite-primary trace records retry direct writes and suppress generic fallback', async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'nb-clan-trace-records-'));
  const previousEnv = {
    NB_DATA_DIR: process.env.NB_DATA_DIR,
    NB_ROOT_PASSWORD: process.env.NB_ROOT_PASSWORD,
    NB_STORAGE_MODE: process.env.NB_STORAGE_MODE,
    NB_SQLITE_FILE: process.env.NB_SQLITE_FILE,
    NB_TRACE_RECORD_DIRECT_RETRY_ATTEMPTS: process.env.NB_TRACE_RECORD_DIRECT_RETRY_ATTEMPTS,
    NB_TRACE_RECORD_DIRECT_RETRY_DELAY_MS: process.env.NB_TRACE_RECORD_DIRECT_RETRY_DELAY_MS,
    NB_TRACE_RECORD_GENERIC_FALLBACK: process.env.NB_TRACE_RECORD_GENERIC_FALLBACK,
    NB_TRACE_RECORD_GENERIC_FALLBACK_MAX_PER_WINDOW: process.env.NB_TRACE_RECORD_GENERIC_FALLBACK_MAX_PER_WINDOW,
    NB_TRACE_RECORD_GENERIC_FALLBACK_WINDOW_MS: process.env.NB_TRACE_RECORD_GENERIC_FALLBACK_WINDOW_MS
  };
  process.env.NB_DATA_DIR = dataDir;
  process.env.NB_ROOT_PASSWORD = 'RootPass123!';
  process.env.NB_STORAGE_MODE = 'sqlite-primary';
  process.env.NB_SQLITE_FILE = path.join(dataDir, 'nb-clan.sqlite');
  process.env.NB_TRACE_RECORD_DIRECT_RETRY_DELAY_MS = '0';
  process.env.NB_TRACE_RECORD_GENERIC_FALLBACK = '1';
  process.env.NB_TRACE_RECORD_GENERIC_FALLBACK_WINDOW_MS = '60000';

  try {
    const storeModule = await import('../server/store.js');
    const repositoryModule = await import('../server/storage/repository.js');
    const sqliteModule = await import('../server/storage/sqlite.js');
    const operationRunsModule = await import('../server/operation-runs.js');
    const integrationEventsModule = await import('../server/integration-events.js');
    const syncJobStoreModule = await import('../server/sync-job-store.js');
    const runtimeHealthModule = await import('../server/runtime-health.js');
    const traceModule = await import('../server/trace-record-persistence.js');
    await storeModule.ensureStore();
    traceModule.resetTraceRecordPersistenceForTests();
    const writeCount = (status, name) => status.sqlite?.writes?.byName?.[name]?.total || 0;

    process.env.NB_TRACE_RECORD_DIRECT_RETRY_ATTEMPTS = '1';
    process.env.NB_TRACE_RECORD_GENERIC_FALLBACK_MAX_PER_WINDOW = '5';
    repositoryModule.injectSqliteStorePatchFailureForTests('operation_run_create', 1);
    const retriedRun = await operationRunsModule.createOperationRun({
      id: 'operation_run_trace_retry',
      type: 'trace_retry',
      platform: 'system',
      source: 'system',
      status: 'running',
      targetType: 'test',
      targetId: 'trace_retry'
    });
    assert.equal(retriedRun.id, 'operation_run_trace_retry');
    assert.equal((await repositoryModule.getSqliteRecord('operationRuns', retriedRun.id)).status, 'running');
    let snapshot = traceModule.traceRecordPersistenceSnapshot();
    let createStats = snapshot.records.find((item) => item.name === 'operation_run_create');
    assert.equal(createStats.directFailures, 1);
    assert.equal(createStats.directRetryAttempts, 1);
    assert.equal(createStats.directRetrySucceeded, 1);
    assert.equal(createStats.fallbackAttempts, 0);
    assert.equal(snapshot.config.genericFallbackEnabled, false);
    assert.equal(snapshot.config.genericFallbackMaxPerWindow, 0);

    traceModule.resetTraceRecordPersistenceForTests();
    process.env.NB_TRACE_RECORD_DIRECT_RETRY_ATTEMPTS = '0';
    process.env.NB_TRACE_RECORD_GENERIC_FALLBACK_MAX_PER_WINDOW = '5';
    const beforeSuppressedStatus = await storeModule.storeRuntimeStatus({ sqliteSummary: false });
    repositoryModule.injectSqliteStorePatchFailureForTests('operation_run_create', 1);
    const suppressedRun = await operationRunsModule.createOperationRun({
      id: 'operation_run_trace_suppressed',
      type: 'trace_suppressed',
      platform: 'system',
      source: 'system',
      status: 'running',
      targetType: 'test',
      targetId: 'trace_suppressed'
    });
    const afterSuppressedStatus = await storeModule.storeRuntimeStatus({ sqliteSummary: false });
    assert.equal(suppressedRun, null);
    assert.equal(await repositoryModule.getSqliteRecord('operationRuns', 'operation_run_trace_suppressed'), null);
    assert.equal(afterSuppressedStatus.metrics.writes.total, beforeSuppressedStatus.metrics.writes.total);
    assert.equal(writeCount(afterSuppressedStatus, 'sqlite_primary_patch'), writeCount(beforeSuppressedStatus, 'sqlite_primary_patch'));
    snapshot = traceModule.traceRecordPersistenceSnapshot();
    createStats = snapshot.records.find((item) => item.name === 'operation_run_create');
    assert.equal(createStats.directFailures, 1);
    assert.equal(createStats.fallbackAttempts, 0);
    assert.equal(createStats.fallbackSucceeded, 0);
    assert.equal(createStats.fallbackSuppressed, 1);
    assert.equal(snapshot.config.genericFallbackEnabled, false);
    assert.equal(snapshot.config.genericFallbackMaxPerWindow, 0);

    repositoryModule.injectSqliteStorePatchFailureForTests('operation_run_update', 1);
    const beforeUpdateStatus = await storeModule.storeRuntimeStatus({ sqliteSummary: false });
    const updatedRun = await operationRunsModule.updateOperationRun('operation_run_trace_retry', {
      status: 'succeeded',
      errorSummary: 'generic fallback should stay suppressed'
    });
    const afterUpdateStatus = await storeModule.storeRuntimeStatus({ sqliteSummary: false });
    assert.equal(updatedRun, null);
    assert.equal((await repositoryModule.getSqliteRecord('operationRuns', 'operation_run_trace_retry')).status, 'running');
    assert.equal(writeCount(afterUpdateStatus, 'operation_run_update'), writeCount(beforeUpdateStatus, 'operation_run_update'));
    assert.equal(writeCount(afterUpdateStatus, 'sqlite_primary_patch'), writeCount(beforeUpdateStatus, 'sqlite_primary_patch'));

    process.env.NB_TRACE_RECORD_GENERIC_FALLBACK_MAX_PER_WINDOW = '5';
    const firstEvent = await integrationEventsModule.createIntegrationEvent({
      id: 'integration_event_trace_first',
      platform: 'discord',
      eventType: 'interaction',
      dedupeKey: 'discord:trace:fallback',
      sourceId: 'trace_first',
      status: 'processed'
    }, { dedupe: true });
    assert.equal(firstEvent.duplicate, false);
    repositoryModule.injectSqliteStorePatchFailureForTests('integration_event_create', 1);
    const suppressedDuplicateEvent = await integrationEventsModule.createIntegrationEvent({
      id: 'integration_event_trace_duplicate',
      platform: 'discord',
      eventType: 'interaction',
      dedupeKey: 'discord:trace:fallback',
      sourceId: 'trace_duplicate',
      status: 'processed'
    }, { dedupe: true });
    assert.equal(suppressedDuplicateEvent, null);
    assert.equal(await repositoryModule.getSqliteRecord('integrationEvents', 'integration_event_trace_duplicate'), null);
    repositoryModule.injectSqliteStorePatchFailureForTests('integration_event_update', 1);
    const updatedEvent = await integrationEventsModule.updateIntegrationEvent('integration_event_trace_first', {
      status: 'failed',
      errorSummary: 'generic fallback should stay suppressed'
    });
    assert.equal(updatedEvent, null);
    assert.equal(
      (await repositoryModule.getSqliteRecord('integrationEvents', 'integration_event_trace_first')).status,
      'processed'
    );

    const fullStore = await storeModule.readStore();
    const status = await storeModule.storeRuntimeStatus({ sqliteSummary: false });
    const readyz = runtimeHealthModule.buildReadyzPayload({
      status,
      syncStore: fullStore,
      operationStore: fullStore,
      integrationEventStore: fullStore
    }).payload;
    assert.equal(Array.isArray(readyz.operations.tracePersistence.records), true);
    assert.equal(
      readyz.operations.tracePersistence.records.some((item) => (
        item.name === 'operation_run_create' &&
        item.fallbackSucceeded === 0 &&
        item.fallbackSuppressed === 1
      )),
      true
    );
    assert.equal(readyz.operations.summary.level, 'warning');
    assert.equal(readyz.operations.summary.reasons.includes('trace_record_persistence_direct_failure'), true);
    assert.equal(readyz.operations.summary.reasons.includes('trace_record_persistence_fallback_suppressed'), true);

    const beforePartialStatus = await storeModule.storeRuntimeStatus({ sqliteSummary: false });
    const beforeReadStoreFull = beforePartialStatus.sqlite?.queries?.byName?.read_store_full?.total || 0;
    repositoryModule.injectSqliteQueryFailureForTests('list_operationRuns_status', 1);
    repositoryModule.injectSqliteQueryFailureForTests('list_integrationEvents_status', 1);
    repositoryModule.injectSqliteQueryFailureForTests('list_syncJobs_status', 1);
    const partialOperationStore = await operationRunsModule.readOperationRunsHealthStore();
    const partialIntegrationStore = await integrationEventsModule.readIntegrationEventsHealthStore();
    const partialSyncStore = await syncJobStoreModule.readSyncJobsHealthStore();
    assert.equal(partialOperationStore.operationRunsPartial, true);
    assert.match(partialOperationStore.operationRunsReadError, /Injected sqlite query failure/);
    assert.equal(partialIntegrationStore.integrationEventsPartial, true);
    assert.match(partialIntegrationStore.integrationEventsReadError, /Injected sqlite query failure/);
    assert.equal(partialSyncStore.syncJobsPartial, true);
    assert.match(partialSyncStore.syncJobsReadError, /Injected sqlite query failure/);
    repositoryModule.injectSqliteQueryFailureForTests('list_syncJobs_status', 1);
    await assert.rejects(
      () => syncJobStoreModule.readSerialSyncQueueStore(),
      /Injected sqlite query failure/
    );
    const afterPartialStatus = await storeModule.storeRuntimeStatus({ sqliteSummary: false });
    assert.equal(afterPartialStatus.sqlite?.queries?.byName?.read_store_full?.total || 0, beforeReadStoreFull);
    const partialReadyz = runtimeHealthModule.buildReadyzPayload({
      status: afterPartialStatus,
      syncStore: partialSyncStore,
      operationStore: partialOperationStore,
      integrationEventStore: partialIntegrationStore
    }).payload;
    assert.equal(partialReadyz.operations.syncJobs.partial, true);
    assert.match(partialReadyz.operations.syncJobs.readError, /Injected sqlite query failure/);
    assert.equal(partialReadyz.operations.operationRuns.partial, true);
    assert.equal(partialReadyz.operations.integrationEvents.partial, true);
    assert.equal(partialReadyz.operations.summary.reasons.includes('sync_jobs_partial'), true);
    assert.equal(partialReadyz.operations.summary.reasons.includes('operation_runs_partial'), true);
    assert.equal(partialReadyz.operations.summary.reasons.includes('integration_events_partial'), true);
  } finally {
    const sqliteModule = await import('../server/storage/sqlite.js');
    await sqliteModule.closeSqliteDatabasesForTests();
    Object.assign(process.env, previousEnv);
    for (const [key, value] of Object.entries(previousEnv)) {
      if (value === undefined) delete process.env[key];
    }
    await rm(dataDir, { recursive: true, force: true });
  }
});
