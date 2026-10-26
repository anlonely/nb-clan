import { nowIso } from './store.js';
import { publicApiRuntimeMetrics } from './api-runtime-metrics.js';
import { backgroundTaskQueueSnapshot } from './background-task-queue.js';
import { serverDataBackupRuntimeSnapshot } from './data-backup.js';
import { externalProviderHealthSnapshot } from './external-provider-health.js';
import { integrationEventsPayload } from './integration-events.js';
import { operationRunsPayload } from './operation-runs.js';
import {
  syncJobsActiveDuplicateSummary,
  syncJobsPayload
} from './sync-jobs.js';
import { traceRecordPersistenceSnapshot } from './trace-record-persistence.js';

const MIB = 1024 * 1024;
const STORAGE_PRESSURE_THRESHOLDS = {
  walWarningBytes: 128 * MIB,
  walCriticalBytes: 512 * MIB,
  eventLoopP99WarningMs: 1000,
  eventLoopP99CriticalMs: 5000,
  queueWarning: 10,
  queueCritical: 50,
  observationWindowMs: 5 * 60 * 1000
};
const READYZ_OPERATION_THRESHOLDS = {
  queueWarning: 10,
  queueCritical: 50,
  pendingItemsWarning: 100,
  pendingItemsCritical: 500,
  failureRateWarning: 0.2,
  failureRateCritical: 0.5,
  duplicateRateWarning: 0.1
};

function finiteMetric(value) {
  const number = Number(value || 0);
  return Number.isFinite(number) ? number : 0;
}

export function readyzTimingSummary(bucket = {}) {
  return {
    total: finiteMetric(bucket.total),
    slow: finiteMetric(bucket.slow),
    avgMs: finiteMetric(bucket.avgMs),
    maxMs: finiteMetric(bucket.maxMs),
    lastSlowAt: bucket.lastSlowAt || '',
    last: bucket.last || null
  };
}

export function readyzSlowTimingItems(bucket = {}, limit = 8) {
  return Object.entries(bucket.byName || {})
    .map(([name, item]) => ({
      name,
      total: Number(item.total || 0),
      slow: Number(item.slow || 0),
      avgMs: Number(item.avgMs || 0),
      maxMs: Number(item.maxMs || 0),
      lastMs: Number(item.lastMs || 0)
    }))
    .filter((item) => item.slow > 0 || item.maxMs > 0)
    .toSorted((left, right) => right.maxMs - left.maxMs)
    .slice(0, limit);
}

export function readyzTopTimingItems(bucket = {}, limit = 8) {
  return Object.entries(bucket.byName || {})
    .map(([name, item]) => ({
      name,
      total: finiteMetric(item.total),
      slow: finiteMetric(item.slow),
      avgMs: finiteMetric(item.avgMs),
      maxMs: finiteMetric(item.maxMs),
      lastMs: finiteMetric(item.lastMs)
    }))
    .filter((item) => item.total > 0)
    .toSorted((left, right) => (
      right.maxMs - left.maxMs
      || right.slow - left.slow
      || right.total - left.total
      || left.name.localeCompare(right.name)
    ))
    .slice(0, limit);
}

export function readyzPreparedStatementItems(prepares = {}, limit = 8) {
  return Object.entries(prepares.byName || {})
    .map(([name, count]) => ({
      name,
      count: finiteMetric(count)
    }))
    .filter((item) => item.count > 0)
    .toSorted((left, right) => (
      right.count - left.count
      || left.name.localeCompare(right.name)
    ))
    .slice(0, limit);
}

export function readyzTopCallerItems(bucket = {}, limit = 8) {
  return Object.entries(bucket.byCaller || {})
    .map(([caller, item]) => ({
      caller,
      total: finiteMetric(item.total),
      slow: finiteMetric(item.slow),
      avgMs: finiteMetric(item.avgMs),
      maxMs: finiteMetric(item.maxMs),
      lastMs: finiteMetric(item.lastMs),
      lastName: item.lastName || ''
    }))
    .filter((item) => item.total > 0)
    .toSorted((left, right) => (
      right.maxMs - left.maxMs
      || right.slow - left.slow
      || right.total - left.total
      || left.caller.localeCompare(right.caller)
    ))
    .slice(0, limit);
}

export function readyzStoragePressure(status = {}, storeQueueDepth = 0, { nowMs = Date.now() } = {}) {
  const sqlite = status.sqlite || {};
  const walSizeBytes = finiteMetric(sqlite.walSizeBytes);
  const eventLoopP99Ms = finiteMetric(status.eventLoop?.p99Ms);
  const queueDepth = Math.max(0, finiteMetric(storeQueueDepth || status.metrics?.queueDepth));
  const slowQueries = finiteMetric(sqlite.queries?.slow);
  const slowWrites = finiteMetric(sqlite.writes?.slow);
  const checkpointBusy = finiteMetric(sqlite.checkpoint?.busy);
  const reasons = [];
  let level = 'ok';
  // Lifetime counters remain available for diagnostics; pressure reflects recent events.
  // Older snapshots without timestamps retain their conservative warning behavior.
  const recent = value => !value || !Number.isFinite(Date.parse(value)) ||
    nowMs - Date.parse(value) <= STORAGE_PRESSURE_THRESHOLDS.observationWindowMs;

  const raise = (nextLevel, reason) => {
    if (!reasons.includes(reason)) reasons.push(reason);
    if (nextLevel === 'critical' || level === 'ok') level = nextLevel;
  };

  if (sqlite.enabled && sqlite.ok === false) raise('critical', 'sqlite_unhealthy');
  if (walSizeBytes >= STORAGE_PRESSURE_THRESHOLDS.walCriticalBytes) {
    raise('critical', 'sqlite_wal_critical');
  } else if (walSizeBytes >= STORAGE_PRESSURE_THRESHOLDS.walWarningBytes) {
    raise('warning', 'sqlite_wal_large');
  }
  if (eventLoopP99Ms >= STORAGE_PRESSURE_THRESHOLDS.eventLoopP99CriticalMs) {
    raise('critical', 'event_loop_p99_critical');
  } else if (eventLoopP99Ms >= STORAGE_PRESSURE_THRESHOLDS.eventLoopP99WarningMs) {
    raise('warning', 'event_loop_p99_high');
  }
  if (queueDepth >= STORAGE_PRESSURE_THRESHOLDS.queueCritical) {
    raise('critical', 'store_queue_critical');
  } else if (queueDepth >= STORAGE_PRESSURE_THRESHOLDS.queueWarning) {
    raise('warning', 'store_queue_high');
  }
  if (slowWrites > 0 && recent(sqlite.writes?.lastSlowAt)) raise('warning', 'sqlite_slow_writes');
  if (slowQueries > 0 && recent(sqlite.queries?.lastSlowAt)) raise('warning', 'sqlite_slow_queries');
  if (sqlite.lastError && recent(sqlite.lastErrorAt)) raise('warning', 'sqlite_last_error');
  if (sqlite.checkpoint?.lastError && recent(sqlite.checkpoint.ranAt)) raise('warning', 'sqlite_checkpoint_error');
  if (checkpointBusy > 0 && recent(sqlite.checkpoint.ranAt)) raise('warning', 'sqlite_checkpoint_busy');

  return {
    level,
    reasons,
    walSizeBytes,
    eventLoopP99Ms,
    queueDepth,
    slowQueries,
    slowWrites,
    checkpointBusy,
    thresholds: STORAGE_PRESSURE_THRESHOLDS
  };
}

export function readyzStorageSummary(status = {}, storeQueueDepth = 0) {
  const sqlite = status.sqlite || {};
  const storeQueuePending = Math.max(0, Number(status.metrics?.queuePending || 0));
  const storeQueueRunning = Math.max(0, Number(status.metrics?.queueRunning || 0));
  return {
    mode: status.mode || '',
    cacheLoaded: Boolean(status.cacheLoaded),
    queueDepth: storeQueueDepth,
    queue: {
      total: storeQueueDepth,
      pending: storeQueuePending,
      running: storeQueueRunning
    },
    pressure: readyzStoragePressure(status, storeQueueDepth),
    store: {
      reads: readyzTimingSummary(status.metrics?.reads || {}),
      writes: readyzTimingSummary(status.metrics?.writes || {}),
      clones: readyzTimingSummary(status.metrics?.clones || {}),
      topReads: readyzTopTimingItems(status.metrics?.reads || {}),
      topWrites: readyzTopTimingItems(status.metrics?.writes || {}),
      topClones: readyzTopTimingItems(status.metrics?.clones || {}),
      topReadCallers: readyzTopCallerItems(status.metrics?.reads || {}),
      topWriteCallers: readyzTopCallerItems(status.metrics?.writes || {}),
      topCloneCallers: readyzTopCallerItems(status.metrics?.clones || {}),
      noOpWrites: Number(status.metrics?.noOpWrites || 0),
      jsonWrites: Number(status.metrics?.jsonWrites || 0),
      sqliteWrites: Number(status.metrics?.sqliteWrites || 0),
      lastError: status.metrics?.lastError || ''
    },
    sqlite: {
      enabled: Boolean(sqlite.enabled),
      primary: Boolean(sqlite.primary),
      ok: sqlite.ok !== false,
      opened: Boolean(sqlite.opened),
      sizeBytes: Number(sqlite.sizeBytes || 0),
      walSizeBytes: Number(sqlite.walSizeBytes || 0),
      shmSizeBytes: Number(sqlite.shmSizeBytes || 0),
      prepares: {
        total: finiteMetric(sqlite.prepares?.total),
        top: readyzPreparedStatementItems(sqlite.prepares || {})
      },
      queries: readyzTimingSummary(sqlite.queries || {}),
      writes: readyzTimingSummary(sqlite.writes || {}),
      slowQueries: readyzSlowTimingItems(sqlite.queries || {}),
      slowWrites: readyzSlowTimingItems(sqlite.writes || {}),
      topQueries: readyzTopTimingItems(sqlite.queries || {}),
      topWrites: readyzTopTimingItems(sqlite.writes || {}),
      compatibility: sqlite.compatibility || {},
      checkpoint: {
        ok: sqlite.checkpoint?.ok !== false,
        mode: sqlite.checkpoint?.mode || '',
        ranAt: sqlite.checkpoint?.ranAt || '',
        busy: Number(sqlite.checkpoint?.busy || 0),
        log: Number(sqlite.checkpoint?.log || 0),
        checkpointed: Number(sqlite.checkpoint?.checkpointed || 0),
        rowCount: Number(sqlite.checkpoint?.rowCount || 0),
        lastError: sqlite.checkpoint?.lastError || ''
      },
      lastError: sqlite.lastError || '',
      lastErrorAt: sqlite.lastErrorAt || ''
    }
  };
}

function readyzRiskLevelRank(level = 'ok') {
  if (level === 'critical') return 2;
  if (level === 'warning') return 1;
  return 0;
}

function readyzRiskLevelFromRank(rank = 0) {
  if (rank >= 2) return 'critical';
  if (rank >= 1) return 'warning';
  return 'ok';
}

export function readyzTracePersistenceSummary(tracePersistence = {}) {
  const records = Array.isArray(tracePersistence.records) ? tracePersistence.records : [];
  const counts = records.reduce((acc, record) => {
    acc.records += 1;
    acc.directFailures += finiteMetric(record.directFailures);
    acc.directRetryAttempts += finiteMetric(record.directRetryAttempts);
    acc.directRetrySucceeded += finiteMetric(record.directRetrySucceeded);
    acc.directRetryFailed += finiteMetric(record.directRetryFailed);
    acc.fallbackAttempts += finiteMetric(record.fallbackAttempts);
    acc.fallbackSucceeded += finiteMetric(record.fallbackSucceeded);
    acc.fallbackFailed += finiteMetric(record.fallbackFailed);
    acc.fallbackSuppressed += finiteMetric(record.fallbackSuppressed);
    return acc;
  }, {
    records: 0,
    directFailures: 0,
    directRetryAttempts: 0,
    directRetrySucceeded: 0,
    directRetryFailed: 0,
    fallbackAttempts: 0,
    fallbackSucceeded: 0,
    fallbackFailed: 0,
    fallbackSuppressed: 0
  });
  const reasons = [];
  const addReason = (reason) => {
    if (!reasons.includes(reason)) reasons.push(reason);
  };
  if (counts.directFailures > counts.directRetrySucceeded) {
    addReason('trace_record_persistence_direct_failure');
  }
  if (counts.directRetryFailed > 0) {
    addReason('trace_record_persistence_retry_failed');
  }
  if (counts.fallbackFailed > 0) {
    addReason('trace_record_persistence_fallback_failed');
  }
  if (counts.fallbackSuppressed > 0) {
    addReason('trace_record_persistence_fallback_suppressed');
  }
  const failedRecords = records
    .filter((record) => (
      finiteMetric(record.directFailures) > finiteMetric(record.directRetrySucceeded)
      || finiteMetric(record.directRetryFailed) > 0
      || finiteMetric(record.fallbackFailed) > 0
      || finiteMetric(record.fallbackSuppressed) > 0
    ))
    .map((record) => ({
      name: record.name || '',
      directFailures: finiteMetric(record.directFailures),
      directRetryFailed: finiteMetric(record.directRetryFailed),
      fallbackFailed: finiteMetric(record.fallbackFailed),
      fallbackSuppressed: finiteMetric(record.fallbackSuppressed),
      lastDirectError: record.lastDirectError || '',
      lastFallbackError: record.lastFallbackError || '',
      lastAt: record.lastAt || ''
    }))
    .toSorted((left, right) => (
      right.fallbackSuppressed - left.fallbackSuppressed
      || right.fallbackFailed - left.fallbackFailed
      || right.directRetryFailed - left.directRetryFailed
      || right.directFailures - left.directFailures
      || left.name.localeCompare(right.name)
    ))
    .slice(0, 8);
  return {
    level: reasons.length ? 'warning' : 'ok',
    reasons,
    counts,
    failedRecords
  };
}

export function readyzOperationalRiskSummary({
  storage = {},
  syncPayload = {},
  operationPayload = {},
  integrationPayload = {},
  providerHealth = {},
  tracePersistence = {},
  dataBackup = {},
  messageDeletionTasks = {},
  queueDepth = {}
} = {}) {
  const reasons = [];
  let rank = 0;
  const readinessReasons = [];
  let readinessRank = 0;
  const raise = (level, reason, { affectsReadiness = false } = {}) => {
    if (!reasons.includes(reason)) reasons.push(reason);
    rank = Math.max(rank, readyzRiskLevelRank(level));
    if (affectsReadiness) {
      if (!readinessReasons.includes(reason)) readinessReasons.push(reason);
      readinessRank = Math.max(readinessRank, readyzRiskLevelRank(level));
    }
  };
  const degrade = (reason) => raise('warning', reason);
  const storageLevel = storage.pressure?.level || 'ok';
  if (storageLevel !== 'ok') {
    raise(storageLevel, `storage_${storageLevel}`, {
      affectsReadiness: storageLevel === 'critical'
    });
  }
  const totalQueueDepth = finiteMetric(queueDepth.total);
  if (totalQueueDepth >= READYZ_OPERATION_THRESHOLDS.queueCritical) {
    raise('critical', 'queue_depth_critical', { affectsReadiness: true });
  } else if (totalQueueDepth >= READYZ_OPERATION_THRESHOLDS.queueWarning) {
    raise('warning', 'queue_depth_high');
  }
  const pendingItems = finiteMetric(syncPayload.queueDepth?.pendingItems);
  if (pendingItems >= READYZ_OPERATION_THRESHOLDS.pendingItemsCritical) {
    raise('critical', 'sync_pending_items_critical', { affectsReadiness: true });
  } else if (pendingItems >= READYZ_OPERATION_THRESHOLDS.pendingItemsWarning) {
    raise('warning', 'sync_pending_items_high');
  }
  if (finiteMetric(syncJobsActiveDuplicateSummary({ syncJobs: syncPayload.current || [] }).duplicateJobCount) > 0) {
    raise('warning', 'sync_job_duplicates');
  }
  if (finiteMetric(providerHealth.openCount) > 0) raise('warning', 'external_provider_circuit_open');
  if (finiteMetric(providerHealth.halfOpenCount) > 0) raise('warning', 'external_provider_half_open');
  if (providerHealth.battlemetrics?.blockedUntil) raise('warning', 'battlemetrics_blocked');
  if (providerHealth.battlemetrics?.rateLimitedUntil) raise('warning', 'battlemetrics_rate_limited');
  if (syncPayload.partial) raise('warning', 'sync_jobs_partial');
  if (operationPayload.partial) raise('warning', 'operation_runs_partial');
  if (integrationPayload.partial) raise('warning', 'integration_events_partial');
  if (messageDeletionTasks.partial) raise('warning', 'message_deletion_tasks_partial');
  if (finiteMetric(messageDeletionTasks.failed) > 0) raise('warning', 'message_deletion_tasks_failed');
  if (finiteMetric(messageDeletionTasks.due) > 0) raise('warning', 'message_deletion_tasks_due');
  if (dataBackup.lastStatus === 'failed') raise('warning', 'data_backup_failed');
  const tracePersistenceSummary = readyzTracePersistenceSummary(tracePersistence);
  if (tracePersistenceSummary.level !== 'ok') {
    for (const reason of tracePersistenceSummary.reasons) {
      raise(tracePersistenceSummary.level, reason);
    }
  }

  const providerFailureRate = finiteMetric(providerHealth.failureRate);
  if (providerFailureRate >= READYZ_OPERATION_THRESHOLDS.failureRateCritical) {
    degrade('external_provider_failure_rate_critical');
  } else if (providerFailureRate >= READYZ_OPERATION_THRESHOLDS.failureRateWarning) {
    degrade('external_provider_failure_rate_high');
  }
  const providerRetryableFailureRate = finiteMetric(providerHealth.retryableFailureRate);
  if (providerRetryableFailureRate >= READYZ_OPERATION_THRESHOLDS.failureRateCritical) {
    degrade('external_provider_retryable_failure_rate_critical');
  } else if (providerRetryableFailureRate >= READYZ_OPERATION_THRESHOLDS.failureRateWarning) {
    degrade('external_provider_retryable_failure_rate_high');
  }
  const syncProblemRate = finiteMetric(syncPayload.failureRates?.terminalProblemRate || syncPayload.failureRates?.problemRate);
  if (syncProblemRate >= READYZ_OPERATION_THRESHOLDS.failureRateCritical) {
    degrade('sync_job_problem_rate_critical');
  } else if (syncProblemRate >= READYZ_OPERATION_THRESHOLDS.failureRateWarning) {
    degrade('sync_job_problem_rate_high');
  }
  const operationFailureRate = finiteMetric(operationPayload.failureRates?.terminalFailureRate || operationPayload.failureRates?.failureRate);
  if (operationFailureRate >= READYZ_OPERATION_THRESHOLDS.failureRateCritical) {
    degrade('operation_failure_rate_critical');
  } else if (operationFailureRate >= READYZ_OPERATION_THRESHOLDS.failureRateWarning) {
    degrade('operation_failure_rate_high');
  }
  const integrationFailureRate = finiteMetric(integrationPayload.failureRates?.terminalFailureRate || integrationPayload.failureRates?.failureRate);
  if (integrationFailureRate >= READYZ_OPERATION_THRESHOLDS.failureRateCritical) {
    degrade('integration_event_failure_rate_critical');
  } else if (integrationFailureRate >= READYZ_OPERATION_THRESHOLDS.failureRateWarning) {
    degrade('integration_event_failure_rate_high');
  }
  const integrationDuplicateRate = finiteMetric(integrationPayload.failureRates?.duplicateRate);
  if (integrationDuplicateRate >= READYZ_OPERATION_THRESHOLDS.duplicateRateWarning) {
    raise('warning', 'integration_event_duplicate_rate_high');
  }
  return {
    level: readyzRiskLevelFromRank(rank),
    reasons,
    counts: {
      queueDepth: totalQueueDepth,
      syncCurrent: finiteMetric(syncPayload.queueDepth?.current || syncPayload.current?.length),
      syncPendingItems: pendingItems,
      activeDuplicateJobs: finiteMetric(syncJobsActiveDuplicateSummary({ syncJobs: syncPayload.current || [] }).duplicateJobCount),
      openProviderCircuits: finiteMetric(providerHealth.openCount),
      halfOpenProviderCircuits: finiteMetric(providerHealth.halfOpenCount),
      providerRequests: finiteMetric(providerHealth.total),
      providerFailures: finiteMetric(providerHealth.failed),
      providerRetryableFailures: finiteMetric(providerHealth.retryableFailed),
      failingProviders: finiteMetric(providerHealth.failingProviderCount),
      failedOperations: finiteMetric(operationPayload.failureRates?.failed),
      failedIntegrationEvents: finiteMetric(integrationPayload.failureRates?.failed),
      messageDeletionTasksFailed: finiteMetric(messageDeletionTasks.failed),
      messageDeletionTasksDue: finiteMetric(messageDeletionTasks.due),
      messageDeletionTasksPartial: Number(Boolean(messageDeletionTasks.partial)),
      dataBackupFailed: finiteMetric(dataBackup.failed),
      syncJobsPartial: Number(Boolean(syncPayload.partial)),
      operationRunsPartial: Number(Boolean(operationPayload.partial)),
      integrationEventsPartial: Number(Boolean(integrationPayload.partial))
    },
    rates: {
      syncProblemRate,
      operationFailureRate,
      integrationFailureRate,
      integrationDuplicateRate,
      providerFailureRate,
      providerRetryableFailureRate
    },
    readiness: {
      level: readyzRiskLevelFromRank(readinessRank),
      reasons: readinessReasons
    },
    thresholds: READYZ_OPERATION_THRESHOLDS
  };
}

export function readyzReadinessSummary({ status = {}, operationalSummary = {} } = {}) {
  const reasons = [];
  const addReason = (reason) => {
    if (reason && !reasons.includes(reason)) reasons.push(reason);
  };
  if (status.cacheLoaded === false && !status.sqlite?.enabled) addReason('store_cache_not_loaded');
  if (status.sqlite?.ok === false) addReason('sqlite_unhealthy');
  for (const reason of operationalSummary.readiness?.reasons || []) addReason(reason);
  if (operationalSummary.level === 'critical' && operationalSummary.readiness?.level !== 'critical') {
    addReason('operations_critical');
  }
  const ok = reasons.length === 0;
  return {
    ok,
    status: ok ? (operationalSummary.level === 'warning' ? 'degraded' : 'ready') : 'not_ready',
    reasons,
    operationsLevel: operationalSummary.level || 'ok',
    externalDependenciesAffectReadiness: false
  };
}

export function buildReadyzPayload({
  status = {},
  messageDeletionTasks = {},
  syncStore = {},
  operationStore = {},
  integrationEventStore = {},
  battlemetricsQueue = {},
  providerHealth: providerHealthOverride = null
} = {}) {
  const syncPayload = syncJobsPayload(syncStore, { limit: 8 });
  const operationPayload = operationRunsPayload(operationStore, { limit: 8 });
  const integrationPayload = integrationEventsPayload(integrationEventStore, { limit: 8 });
  const tracePersistence = traceRecordPersistenceSnapshot();
  const providerHealth = providerHealthOverride || externalProviderHealthSnapshot({
    battlemetrics: {
      blockedUntil: battlemetricsQueue.limits?.blockedUntil || '',
      rateLimitedUntil: battlemetricsQueue.limits?.rateLimitedUntil || '',
      nextAvailableAt: battlemetricsQueue.limits?.nextAvailableAt || '',
      nextAvailableInSeconds: battlemetricsQueue.limits?.nextAvailableInSeconds || 0
    }
  });
  const backgroundQueue = backgroundTaskQueueSnapshot();
  const dataBackup = serverDataBackupRuntimeSnapshot();
  const storeQueueDepth = Math.max(0, Number(status.metrics?.queueDepth || 0));
  const storeQueuePending = Math.max(0, Number(status.metrics?.queuePending || 0));
  const storeQueueRunning = Math.max(0, Number(status.metrics?.queueRunning || 0));
  const syncJobQueueDepth = Math.max(0, Number(syncPayload.queueDepth?.current || syncPayload.current?.length || 0));
  const queueDepth = {
    total: storeQueueDepth + backgroundQueue.totalPending + backgroundQueue.totalRunning + syncJobQueueDepth + Number(battlemetricsQueue.pendingCount || 0) + Number(Boolean(battlemetricsQueue.active)),
    store: storeQueueDepth,
    storePending: storeQueuePending,
    storeRunning: storeQueueRunning,
    syncJobs: syncPayload.queueDepth,
    background: backgroundQueue,
    battlemetrics: {
      pending: Number(battlemetricsQueue.pendingCount || 0),
      running: Boolean(battlemetricsQueue.active)
    }
  };
  const storageSummary = readyzStorageSummary(status, storeQueueDepth);
  const summary = readyzOperationalRiskSummary({
    storage: storageSummary,
    syncPayload,
    operationPayload,
    integrationPayload,
    providerHealth,
    tracePersistence,
    dataBackup,
    messageDeletionTasks,
    queueDepth
  });
  const readiness = readyzReadinessSummary({ status, operationalSummary: summary });
  const ok = readiness.ok;
  return {
    statusCode: ok ? 200 : 503,
    payload: {
      ok,
      ready: ok,
      check: 'readiness',
      status: readiness.status,
      service: 'nb-clan-member-system',
      time: nowIso(),
      readiness,
      store: status,
      api: publicApiRuntimeMetrics(),
      operations: {
        activeJobs: syncPayload.current,
        activeDuplicateJobs: syncJobsActiveDuplicateSummary(syncStore),
        failedOperations: operationPayload.failed,
        failedIntegrationEvents: integrationPayload.failed,
        syncJobs: {
          current: syncPayload.current,
          recent: syncPayload.recent,
          byType: syncPayload.byType,
          byScope: syncPayload.byScope,
          byStatus: syncPayload.byStatus,
          failureRates: syncPayload.failureRates,
          queueDepth: syncPayload.queueDepth,
          duplicates: syncJobsActiveDuplicateSummary(syncStore),
          partial: syncPayload.partial,
          readError: syncPayload.readError,
          updatedAt: syncPayload.updatedAt
        },
        operationRuns: {
          current: operationPayload.current,
          recent: operationPayload.recent,
          byPlatform: operationPayload.byPlatform,
          failureRates: operationPayload.failureRates,
          partial: operationPayload.partial,
          readError: operationPayload.readError,
          updatedAt: operationPayload.updatedAt
        },
        integrationEvents: {
          failed: integrationPayload.failed,
          duplicates: integrationPayload.duplicates,
          recent: integrationPayload.recent,
          byPlatform: integrationPayload.byPlatform,
          failureRates: integrationPayload.failureRates,
          partial: integrationPayload.partial,
          readError: integrationPayload.readError,
          updatedAt: integrationPayload.updatedAt
        },
        failureRates: {
          syncJobs: syncPayload.failureRates,
          operationRuns: operationPayload.failureRates,
          integrationEvents: integrationPayload.failureRates,
          updatedAt: nowIso()
        },
        tracePersistence,
        summary,
        providerHealth,
        queueDepth,
        storage: storageSummary,
        dataBackup
      },
      messageDeletionTasks
    }
  };
}

export function compactReadyzPayload(payload = {}) {
  const readiness = payload.readiness || {
    ok: payload.ok !== false,
    status: payload.ok === false ? 'not_ready' : 'ready',
    reasons: []
  };
  const operations = payload.operations || {};
  const summary = operations.summary || { level: 'ok', reasons: [] };
  const queueDepth = operations.queueDepth || {};
  const background = queueDepth.background || {};
  const syncJobs = queueDepth.syncJobs || {};
  const battlemetrics = queueDepth.battlemetrics || {};
  const dataBackup = operations.dataBackup || {};
  return {
    ok: payload.ok !== false,
    ready: payload.ready === undefined ? payload.ok !== false : payload.ready !== false,
    check: 'readiness',
    status: readiness.status || (payload.ok === false ? 'not_ready' : 'ready'),
    service: payload.service || 'nb-clan-member-system',
    time: payload.time || nowIso(),
    reasons: Array.isArray(readiness.reasons) ? readiness.reasons : [],
    operations: {
      level: summary.level || 'ok',
      reasons: Array.isArray(summary.reasons) ? summary.reasons : []
    },
    queues: {
      total: finiteMetric(queueDepth.total),
      pending: finiteMetric(queueDepth.storePending)
        + finiteMetric(background.totalPending)
        + finiteMetric(syncJobs.pendingItems)
        + finiteMetric(battlemetrics.pending),
      running: finiteMetric(queueDepth.storeRunning)
        + finiteMetric(background.totalRunning)
        + finiteMetric(syncJobs.running)
        + Number(Boolean(battlemetrics.running))
    },
    backup: {
      running: finiteMetric(dataBackup.running),
      lastStatus: dataBackup.lastStatus || 'never',
      lastSucceededAt: dataBackup.lastSucceededAt || '',
      lastFailedAt: dataBackup.lastFailedAt || '',
      lastDurationMs: finiteMetric(dataBackup.lastDurationMs)
    }
  };
}
