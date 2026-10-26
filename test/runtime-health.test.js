import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import {
  buildReadyzPayload,
  compactReadyzPayload,
  readyzOperationalRiskSummary,
  readyzPreparedStatementItems,
  readyzReadinessSummary,
  readyzStoragePressure,
  readyzStorageSummary,
  readyzTracePersistenceSummary,
  readyzTopCallerItems,
  readyzTopTimingItems
} from '../server/runtime-health.js';
import {
  persistTraceRecordWithFallback,
  resetTraceRecordPersistenceForTests
} from '../server/trace-record-persistence.js';

function uniqueImport(file) {
  return import(`${file}?runtime-health-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
}

test('readyz helper sorts sqlite timing and prepare hotspots deterministically', () => {
  assert.deepEqual(readyzTopTimingItems({
    byName: {
      small: { total: 8, slow: 0, avgMs: 3, maxMs: 9, lastMs: 4 },
      slow: { total: 2, slow: 1, avgMs: 90, maxMs: 180, lastMs: 120 },
      busy: { total: 15, slow: 0, avgMs: 12, maxMs: 40, lastMs: 12 }
    }
  }, 2), [
    { name: 'slow', total: 2, slow: 1, avgMs: 90, maxMs: 180, lastMs: 120 },
    { name: 'busy', total: 15, slow: 0, avgMs: 12, maxMs: 40, lastMs: 12 }
  ]);

  assert.deepEqual(readyzPreparedStatementItems({
    byName: {
      beta: 2,
      alpha: 3,
      gamma: 3
    }
  }, 2), [
    { name: 'alpha', count: 3 },
    { name: 'gamma', count: 3 }
  ]);

  assert.deepEqual(readyzTopCallerItems({
    byCaller: {
      'slowCaller()': { total: 2, slow: 1, avgMs: 75, maxMs: 150, lastMs: 150, lastName: 'write_store_sqlite_patch' },
      'busyCaller()': { total: 9, slow: 0, avgMs: 8, maxMs: 30, lastMs: 12, lastName: 'read_store' }
    }
  }, 1), [
    {
      caller: 'slowCaller()',
      total: 2,
      slow: 1,
      avgMs: 75,
      maxMs: 150,
      lastMs: 150,
      lastName: 'write_store_sqlite_patch'
    }
  ]);
});

test('readyz operational summary rolls storage, queues, provider circuits, and failure rates into one risk level', () => {
  const ok = readyzOperationalRiskSummary({
    storage: { pressure: { level: 'ok' } },
    syncPayload: { current: [], queueDepth: { current: 0, pendingItems: 0 }, failureRates: {} },
    operationPayload: { failureRates: {} },
    integrationPayload: { failureRates: {} },
    providerHealth: { openCount: 0, halfOpenCount: 0 },
    queueDepth: { total: 0 }
  });
  assert.equal(ok.level, 'ok');
  assert.deepEqual(ok.reasons, []);

  const warning = readyzOperationalRiskSummary({
    storage: { pressure: { level: 'warning' } },
    syncPayload: {
      current: [
        { id: 'sync_a', type: 'kda', scope: 'kda', status: 'running', targetWipeId: 'wipe_1', targetServerId: 'server_1' },
        { id: 'sync_b', type: 'kda', scope: 'kda', status: 'queued', targetWipeId: 'wipe_1', targetServerId: 'server_1' }
      ],
      queueDepth: { current: 2, pendingItems: 120 },
      failureRates: { terminalProblemRate: 0.25 }
    },
    operationPayload: { failureRates: { terminalFailureRate: 0.25, failed: 2 } },
    integrationPayload: { failureRates: { terminalFailureRate: 0.1, duplicateRate: 0.2, failed: 1 } },
    messageDeletionTasks: { partial: true, failed: 2, due: 3 },
    dataBackup: { lastStatus: 'failed', failed: 1 },
    providerHealth: {
      openCount: 1,
      halfOpenCount: 0,
      total: 10,
      failed: 3,
      retryableFailed: 2,
      failureRate: 0.3,
      retryableFailureRate: 0.2,
      failingProviderCount: 2,
      battlemetrics: { rateLimitedUntil: '2026-01-01T00:00:00.000Z' }
    },
    queueDepth: { total: 12 }
  });
  assert.equal(warning.level, 'warning');
  assert.equal(warning.reasons.includes('storage_warning'), true);
  assert.equal(warning.reasons.includes('queue_depth_high'), true);
  assert.equal(warning.reasons.includes('sync_pending_items_high'), true);
  assert.equal(warning.reasons.includes('sync_job_duplicates'), true);
  assert.equal(warning.reasons.includes('external_provider_circuit_open'), true);
  assert.equal(warning.reasons.includes('external_provider_failure_rate_high'), true);
  assert.equal(warning.reasons.includes('external_provider_retryable_failure_rate_high'), true);
  assert.equal(warning.reasons.includes('battlemetrics_rate_limited'), true);
  assert.equal(warning.reasons.includes('operation_failure_rate_high'), true);
  assert.equal(warning.reasons.includes('integration_event_duplicate_rate_high'), true);
  assert.equal(warning.reasons.includes('message_deletion_tasks_partial'), true);
  assert.equal(warning.reasons.includes('message_deletion_tasks_failed'), true);
  assert.equal(warning.reasons.includes('message_deletion_tasks_due'), true);
  assert.equal(warning.reasons.includes('data_backup_failed'), true);
  assert.equal(warning.counts.activeDuplicateJobs, 1);
  assert.equal(warning.counts.providerFailures, 3);
  assert.equal(warning.counts.messageDeletionTasksFailed, 2);
  assert.equal(warning.counts.messageDeletionTasksDue, 3);
  assert.equal(warning.counts.messageDeletionTasksPartial, 1);
  assert.equal(warning.counts.dataBackupFailed, 1);
  assert.equal(warning.rates.providerFailureRate, 0.3);

  const critical = readyzOperationalRiskSummary({
    storage: { pressure: { level: 'critical' } },
    syncPayload: { current: [], queueDepth: { current: 0, pendingItems: 700 }, failureRates: { terminalProblemRate: 0.75 } },
    operationPayload: { failureRates: { terminalFailureRate: 0.5 } },
    integrationPayload: { failureRates: { terminalFailureRate: 0.8 } },
    providerHealth: {
      openCount: 0,
      halfOpenCount: 0,
      total: 20,
      failed: 12,
      retryableFailed: 11,
      failureRate: 0.6,
      retryableFailureRate: 0.55,
      battlemetrics: { blockedUntil: '2026-01-01T00:00:00.000Z' }
    },
    queueDepth: { total: 60 }
  });
  assert.equal(critical.level, 'critical');
  assert.equal(critical.reasons.includes('storage_critical'), true);
  assert.equal(critical.reasons.includes('queue_depth_critical'), true);
  assert.equal(critical.reasons.includes('sync_pending_items_critical'), true);
  assert.equal(critical.reasons.includes('sync_job_problem_rate_critical'), true);
  assert.equal(critical.reasons.includes('external_provider_failure_rate_critical'), true);
  assert.equal(critical.reasons.includes('external_provider_retryable_failure_rate_critical'), true);
  assert.equal(critical.reasons.includes('battlemetrics_blocked'), true);
  assert.equal(critical.readiness.level, 'critical');
  assert.equal(critical.readiness.reasons.includes('storage_critical'), true);
});

test('readyz keeps external failures degraded while local critical pressure blocks readiness', () => {
  const externalOnly = readyzOperationalRiskSummary({
    storage: { pressure: { level: 'ok' } },
    syncPayload: { current: [], queueDepth: { current: 0, pendingItems: 0 }, failureRates: {} },
    operationPayload: { failureRates: {} },
    integrationPayload: { failureRates: {} },
    providerHealth: {
      openCount: 1,
      halfOpenCount: 0,
      total: 10,
      failed: 10,
      retryableFailed: 10,
      failureRate: 1,
      retryableFailureRate: 1
    },
    queueDepth: { total: 0 }
  });
  assert.equal(externalOnly.level, 'warning');
  assert.equal(externalOnly.readiness.level, 'ok');
  assert.equal(externalOnly.reasons.includes('external_provider_failure_rate_critical'), true);

  const externalReadiness = readyzReadinessSummary({
    status: { cacheLoaded: true, sqlite: { enabled: true, ok: true } },
    operationalSummary: externalOnly
  });
  assert.equal(externalReadiness.ok, true);
  assert.equal(externalReadiness.status, 'degraded');
  assert.deepEqual(externalReadiness.reasons, []);

  const localCritical = readyzOperationalRiskSummary({
    storage: { pressure: { level: 'critical' } },
    syncPayload: { current: [], queueDepth: { current: 0, pendingItems: 0 }, failureRates: {} },
    operationPayload: { failureRates: {} },
    integrationPayload: { failureRates: {} },
    providerHealth: {},
    queueDepth: { total: 60 }
  });
  const localReadiness = readyzReadinessSummary({
    status: { cacheLoaded: true, sqlite: { enabled: true, ok: true } },
    operationalSummary: localCritical
  });
  assert.equal(localCritical.level, 'critical');
  assert.equal(localReadiness.ok, false);
  assert.equal(localReadiness.status, 'not_ready');
  assert.equal(localReadiness.reasons.includes('storage_critical'), true);
  assert.equal(localReadiness.reasons.includes('queue_depth_critical'), true);
});

test('readyz trace persistence summary exposes suppressed record writes as health reasons', async () => {
  const previousEnv = {
    NB_TRACE_RECORD_DIRECT_RETRY_DELAY_MS: process.env.NB_TRACE_RECORD_DIRECT_RETRY_DELAY_MS
  };
  process.env.NB_TRACE_RECORD_DIRECT_RETRY_DELAY_MS = '0';
  resetTraceRecordPersistenceForTests();

  try {
    const result = await persistTraceRecordWithFallback({
      name: 'operation_run_update',
      direct: async () => {
        throw new Error('database is locked');
      },
      fallbackValue: null,
      warn: () => {}
    });
    assert.equal(result, null);

    const { payload } = buildReadyzPayload({
      status: { sqlite: { ok: true } }
    });
    assert.equal(payload.operations.tracePersistence.records.length, 1);
    assert.equal(payload.operations.tracePersistence.records[0].fallbackSuppressed, 1);
    assert.equal(payload.operations.summary.level, 'warning');
    assert.equal(payload.operations.summary.reasons.includes('trace_record_persistence_direct_failure'), true);
    assert.equal(payload.operations.summary.reasons.includes('trace_record_persistence_retry_failed'), true);
    assert.equal(payload.operations.summary.reasons.includes('trace_record_persistence_fallback_suppressed'), true);

    const recovered = readyzTracePersistenceSummary({
      records: [
        {
          name: 'integration_event_update',
          directFailures: 1,
          directRetrySucceeded: 1,
          directRetryFailed: 0,
          fallbackFailed: 0,
          fallbackSuppressed: 0
        }
      ]
    });
    assert.equal(recovered.level, 'ok');
    assert.deepEqual(recovered.reasons, []);
    assert.equal(recovered.counts.directFailures, 1);
  } finally {
    resetTraceRecordPersistenceForTests();
    Object.assign(process.env, previousEnv);
    for (const [key, value] of Object.entries(previousEnv)) {
      if (value === undefined) delete process.env[key];
    }
  }
});

test('readyz payload exposes operational summary without replacing detailed diagnostics', () => {
  const { payload } = buildReadyzPayload({
    status: {
      sqlite: { ok: true },
      metrics: {
        queueDepth: 11,
        queuePending: 10,
        queueRunning: 1
      }
    },
    syncStore: {
      syncJobs: [
        { id: 'sync_payload_a', type: 'kda', scope: 'kda', status: 'running', totalCount: 5, doneCount: 1 },
        { id: 'sync_payload_b', type: 'kda', scope: 'kda', status: 'queued', totalCount: 5, doneCount: 0 }
      ]
    },
    operationStore: {
      operationRuns: [
        { id: 'operation_payload_failed', type: 'discord_push', platform: 'discord', status: 'failed', updatedAt: '2026-01-01T00:00:00.000Z' }
      ]
    },
    integrationEventStore: {
      integrationEvents: [
        { id: 'integration_payload_failed', platform: 'kook', status: 'failed', updatedAt: '2026-01-01T00:00:00.000Z' }
      ]
    },
    battlemetricsQueue: {
      pendingCount: 2,
      active: { id: 'battlemetrics_active' },
      limits: { nextAvailableInSeconds: 5 }
    }
  });

  assert.equal(payload.ok, true);
  assert.equal(['warning', 'critical'].includes(payload.operations.summary.level), true);
  assert.equal(payload.operations.summary.reasons.includes('queue_depth_high'), true);
  assert.equal(typeof payload.operations.summary.counts.queueDepth, 'number');
  assert.equal(payload.operations.failedOperations.length, 1);
  assert.equal(payload.operations.failedIntegrationEvents.length, 1);
  assert.equal(payload.operations.summary.counts.failedOperations, 1);
  assert.equal(payload.operations.summary.counts.failedIntegrationEvents, 1);
  assert.equal(Array.isArray(payload.operations.syncJobs.current), true);
  assert.equal(typeof payload.operations.storage.pressure.level, 'string');
  assert.equal(typeof payload.operations.dataBackup.lastDurationMs, 'number');
  assert.equal(payload.ok, payload.readiness.ok);
});

test('readyz payload status follows local readiness and compact output omits diagnostics', () => {
  const externalFailure = buildReadyzPayload({
    status: {
      cacheLoaded: true,
      sqlite: { enabled: true, ok: true },
      metrics: { queueDepth: 0 }
    },
    providerHealth: {
      openCount: 1,
      total: 5,
      failed: 5,
      retryableFailed: 5,
      failureRate: 1,
      retryableFailureRate: 1
    }
  });
  assert.equal(externalFailure.statusCode, 200);
  assert.equal(externalFailure.payload.ok, true);
  assert.equal(externalFailure.payload.readiness.status, 'degraded');
  assert.equal(externalFailure.payload.operations.summary.level, 'warning');

  const compact = compactReadyzPayload(externalFailure.payload);
  assert.equal(compact.ok, true);
  assert.equal(compact.check, 'readiness');
  assert.equal(compact.status, 'degraded');
  assert.equal(compact.store, undefined);
  assert.equal(compact.api, undefined);
  assert.equal(compact.operations.level, 'warning');
  assert.equal(typeof compact.queues.pending, 'number');
  assert.equal(typeof compact.backup.lastDurationMs, 'number');

  const localBacklog = buildReadyzPayload({
    status: {
      cacheLoaded: true,
      sqlite: { enabled: true, ok: true },
      metrics: { queueDepth: 60, queuePending: 60, queueRunning: 0 }
    }
  });
  assert.equal(localBacklog.statusCode, 503);
  assert.equal(localBacklog.payload.ok, false);
  assert.equal(localBacklog.payload.readiness.status, 'not_ready');
  assert.equal(localBacklog.payload.operations.summary.level, 'critical');
});

test('readyz storage pressure classifies WAL, queue, event loop, and sqlite errors', () => {
  const warning = readyzStoragePressure({
    eventLoop: { p99Ms: 1500 },
    metrics: { queueDepth: 12 },
    sqlite: {
      enabled: true,
      ok: true,
      walSizeBytes: 200 * 1024 * 1024,
      queries: { slow: 1 },
      writes: { slow: 0 },
      checkpoint: { busy: 1 }
    }
  });

  assert.equal(warning.level, 'warning');
  assert.equal(warning.reasons.includes('sqlite_wal_large'), true);
  assert.equal(warning.reasons.includes('event_loop_p99_high'), true);
  assert.equal(warning.reasons.includes('store_queue_high'), true);
  assert.equal(warning.reasons.includes('sqlite_slow_queries'), true);
  assert.equal(warning.reasons.includes('sqlite_checkpoint_busy'), true);

  const critical = readyzStoragePressure({
    eventLoop: { p99Ms: 6000 },
    sqlite: {
      enabled: true,
      ok: false,
      walSizeBytes: 600 * 1024 * 1024,
      writes: { slow: 2 },
      checkpoint: { lastError: 'database is locked' },
      lastError: 'database is locked'
    }
  }, 60);

  assert.equal(critical.level, 'critical');
  assert.equal(critical.reasons.includes('sqlite_unhealthy'), true);
  assert.equal(critical.reasons.includes('sqlite_wal_critical'), true);
  assert.equal(critical.reasons.includes('event_loop_p99_critical'), true);
  assert.equal(critical.reasons.includes('store_queue_critical'), true);
  assert.equal(critical.reasons.includes('sqlite_slow_writes'), true);
  assert.equal(critical.reasons.includes('sqlite_checkpoint_error'), true);
  assert.equal(critical.reasons.includes('sqlite_last_error'), true);
});

test('storage pressure recovers after recent incidents while retaining lifetime diagnostics', () => {
  const nowMs = Date.parse('2026-09-26T14:00:00Z');
  const old = '2026-09-26T13:54:59Z', current = '2026-09-26T13:59:59Z';
  const sqlite = { enabled: true, ok: true, queries: { slow: 1, lastSlowAt: old },
    writes: { slow: 2, lastSlowAt: old }, lastError: 'database is locked', lastErrorAt: old,
    checkpoint: { busy: 1, lastError: 'database is locked', ranAt: old } };
  const recovered = readyzStoragePressure({ sqlite }, 0, { nowMs });
  assert.equal(recovered.level, 'ok');
  assert.equal(recovered.slowQueries, 1);
  assert.equal(recovered.slowWrites, 2);
  assert.deepEqual(recovered.reasons, []);
  const diagnostics = readyzStorageSummary({ sqlite });
  assert.equal(diagnostics.sqlite.queries.lastSlowAt, old);
  assert.equal(diagnostics.sqlite.writes.lastSlowAt, old);
  assert.equal(diagnostics.sqlite.lastErrorAt, old);
  const active = readyzStoragePressure({ sqlite: { ...sqlite, queries: { slow: 2, lastSlowAt: current },
    lastErrorAt: current, checkpoint: { busy: 1, ranAt: current } } }, 0, { nowMs });
  assert.deepEqual(active.reasons, ['sqlite_slow_queries', 'sqlite_last_error', 'sqlite_checkpoint_busy']);
  assert.equal(readyzStoragePressure({ sqlite: { ...sqlite, ok: false } }, 0, { nowMs }).level, 'critical');
  assert.equal(readyzStoragePressure({ sqlite }, 60, { nowMs }).level, 'critical');
});

test('readyz storage summary exposes pressure and sqlite diagnostic drilldowns', () => {
  const summary = readyzStorageSummary({
    mode: 'sqlite-primary',
    cacheLoaded: true,
    metrics: {
      queuePending: 2,
      queueRunning: 1,
      reads: {
        total: 3,
        avgMs: 1,
        maxMs: 2,
        byName: {
          read_store: { total: 3, slow: 0, avgMs: 1, maxMs: 2, lastMs: 1 }
        },
        byCaller: {
          'readCaller()': { total: 3, slow: 0, avgMs: 1, maxMs: 2, lastMs: 1, lastName: 'read_store' }
        }
      },
      writes: {
        total: 4,
        avgMs: 2,
        maxMs: 7,
        byName: {
          write_store_sqlite_patch: { total: 4, slow: 0, avgMs: 2, maxMs: 7, lastMs: 6 }
        },
        byCaller: {
          'writeCaller()': { total: 4, slow: 0, avgMs: 2, maxMs: 7, lastMs: 6, lastName: 'write_store_sqlite_patch' }
        }
      },
      clones: {
        total: 5,
        avgMs: 3,
        maxMs: 8,
        byName: {
          clone_store: { total: 5, slow: 0, avgMs: 3, maxMs: 8, lastMs: 7 }
        },
        byCaller: {
          'cloneCaller()': { total: 5, slow: 0, avgMs: 3, maxMs: 8, lastMs: 7, lastName: 'clone_store' }
        }
      },
      sqliteWrites: 4
    },
    sqlite: {
      enabled: true,
      primary: true,
      ok: true,
      opened: true,
      walSizeBytes: 10,
      prepares: {
        total: 5,
        byName: { findMemberBySteamId: 4, healthCheck: 1 }
      },
      queries: {
        total: 2,
        slow: 1,
        avgMs: 20,
        maxMs: 80,
        byName: {
          findMemberBySteamId: { total: 2, slow: 1, avgMs: 20, maxMs: 80, lastMs: 80 }
        }
      },
      writes: {
        total: 1,
        slow: 0,
        avgMs: 30,
        maxMs: 30,
        byName: {
          writeSqliteStorePatch: { total: 1, slow: 0, avgMs: 30, maxMs: 30, lastMs: 30 }
        }
      },
      checkpoint: {
        ok: true,
        mode: 'PASSIVE',
        ranAt: '2026-07-09T00:00:00.000Z',
        busy: 0,
        log: 12,
        checkpointed: 12,
        rowCount: 1
      }
    }
  }, 3);

  assert.equal(summary.pressure.level, 'warning');
  assert.equal(summary.pressure.reasons.includes('sqlite_slow_queries'), true);
  assert.equal(summary.store.topWrites[0].name, 'write_store_sqlite_patch');
  assert.equal(summary.store.topReadCallers[0].caller, 'readCaller()');
  assert.equal(summary.store.topWriteCallers[0].caller, 'writeCaller()');
  assert.equal(summary.store.topCloneCallers[0].caller, 'cloneCaller()');
  assert.equal(summary.sqlite.prepares.total, 5);
  assert.equal(summary.sqlite.checkpoint.mode, 'PASSIVE');
  assert.equal(summary.sqlite.checkpoint.log, 12);
  assert.equal(summary.sqlite.checkpoint.checkpointed, 12);
  assert.deepEqual(summary.sqlite.prepares.top[0], { name: 'findMemberBySteamId', count: 4 });
  assert.deepEqual(summary.sqlite.topQueries[0], {
    name: 'findMemberBySteamId',
    total: 2,
    slow: 1,
    avgMs: 20,
    maxMs: 80,
    lastMs: 80
  });
  assert.deepEqual(summary.sqlite.topWrites[0], {
    name: 'writeSqliteStorePatch',
    total: 1,
    slow: 0,
    avgMs: 30,
    maxMs: 30,
    lastMs: 30
  });
});

test('sqlite checkpoint writes runtime health snapshot', async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'nb-clan-runtime-health-checkpoint-'));
  const previousEnv = {
    NB_DATA_DIR: process.env.NB_DATA_DIR,
    NB_STORAGE_MODE: process.env.NB_STORAGE_MODE,
    NB_SQLITE_FILE: process.env.NB_SQLITE_FILE
  };
  process.env.NB_DATA_DIR = dataDir;
  process.env.NB_STORAGE_MODE = 'sqlite-primary';
  process.env.NB_SQLITE_FILE = path.join(dataDir, 'nb-clan.sqlite');

  let sqliteModule = null;
  try {
    sqliteModule = await import('../server/storage/sqlite.js');
    const repositoryModule = await uniqueImport('../server/storage/repository.js');
    await repositoryModule.ensureSqliteStore();
    const rows = await repositoryModule.checkpointSqlite('PASSIVE');
    assert.equal(Array.isArray(rows), true);

    const stats = await sqliteModule.sqliteRuntimeStats();
    assert.equal(stats.checkpoint.ok, true);
    assert.equal(stats.checkpoint.mode, 'PASSIVE');
    assert.equal(Boolean(stats.checkpoint.ranAt), true);
    assert.equal(typeof stats.checkpoint.busy, 'number');
    assert.equal(typeof stats.checkpoint.log, 'number');
    assert.equal(typeof stats.checkpoint.checkpointed, 'number');

    const summary = readyzStorageSummary({ sqlite: stats }, 0);
    assert.equal(summary.sqlite.checkpoint.mode, 'PASSIVE');
    assert.equal(summary.pressure.reasons.includes('sqlite_checkpoint_error'), false);
  } finally {
    if (sqliteModule) await sqliteModule.closeSqliteDatabasesForTests();
    Object.assign(process.env, previousEnv);
    for (const [key, value] of Object.entries(previousEnv)) {
      if (value === undefined) delete process.env[key];
    }
    await rm(dataDir, { recursive: true, force: true });
  }
});

test('readyz route exposes runtime health payload', async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'nb-clan-readyz-route-'));
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

  let server = null;
  let sqliteModule = null;
  try {
    const storeModule = await uniqueImport('../server/store.js');
    sqliteModule = await import('../server/storage/sqlite.js');
    await storeModule.ensureStore();

    const apiModule = await uniqueImport('../server/api.js');
    const app = express();
    app.use('/api', apiModule.createApiRouter());
    server = createServer(app);
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));

    const port = server.address().port;
    const healthResponse = await fetch(`http://127.0.0.1:${port}/api/healthz`);
    assert.equal(healthResponse.status, 200);
    const healthPayload = await healthResponse.json();
    assert.equal(healthPayload.ok, true);
    assert.equal(healthPayload.service, 'nb-clan-member-system');
    assert.equal(typeof healthPayload.time, 'string');
    assert.equal(healthPayload.check, 'liveness');
    assert.equal(healthPayload.status, 'alive');

    const compactResponse = await fetch(`http://127.0.0.1:${port}/api/readyz`);
    assert.equal(compactResponse.status, 200);
    const compactPayload = await compactResponse.json();
    assert.equal(compactPayload.ok, true);
    assert.equal(compactPayload.check, 'readiness');
    assert.equal(typeof compactPayload.status, 'string');
    assert.equal(compactPayload.store, undefined);
    assert.equal(compactPayload.api, undefined);
    assert.equal(typeof compactPayload.operations.level, 'string');
    assert.equal(typeof compactPayload.queues.pending, 'number');

    const response = await fetch(`http://127.0.0.1:${port}/api/readyz?detail=full`);
    assert.equal(response.status, 200);

    const payload = await response.json();
    assert.equal(payload.ok, true);
    assert.equal(payload.service, 'nb-clan-member-system');
    assert.equal(typeof payload.operations.summary.level, 'string');
    assert.equal(typeof payload.operations.storage.pressure.level, 'string');
    assert.equal(typeof payload.operations.storage.sqlite.checkpoint.mode, 'string');
    assert.equal(Array.isArray(payload.operations.failedOperations), true);
    assert.equal(Array.isArray(payload.operations.failedIntegrationEvents), true);
    assert.equal(typeof payload.operations.providerHealth.failureRate, 'number');
    assert.equal(typeof payload.operations.dataBackup.lastDurationMs, 'number');

    const deniedFullResponse = await fetch(`http://127.0.0.1:${port}/api/readyz?detail=full`, {
      headers: { 'x-forwarded-for': '203.0.113.10' }
    });
    assert.equal(deniedFullResponse.status, 403);
    const deniedFullPayload = await deniedFullResponse.json();
    assert.equal(deniedFullPayload.ok, false);
    assert.equal(deniedFullPayload.error, 'full_diagnostics_loopback_only');
  } finally {
    if (server) await new Promise((resolve) => server.close(resolve));
    if (sqliteModule) await sqliteModule.closeSqliteDatabasesForTests();
    Object.assign(process.env, previousEnv);
    for (const [key, value] of Object.entries(previousEnv)) {
      if (value === undefined) delete process.env[key];
    }
    await rm(dataDir, { recursive: true, force: true });
  }
});
