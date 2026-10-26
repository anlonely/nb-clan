import { createId, normalizeText, nowIso, patchStoreCache, readStore, runStoreWriteTask, updateStore } from './store.js';
import {
  getSqliteCollection,
  getSqliteRecord,
  getSqliteRecordsByJsonField,
  getSqliteRecordsByJsonFields,
  writeSqliteStorePatch
} from './storage/repository.js';
import { sqliteEnabled, sqlitePrimaryMode } from './storage/sqlite.js';
import { mergeRecordsById, readSqliteRecordsByIds } from './sqlite-read-utils.js';
import { persistTraceRecordWithFallback } from './trace-record-persistence.js';

const OPERATION_RUN_SUCCEEDED_HISTORY_LIMIT = 200;
const OPERATION_RUN_FAILED_HISTORY_LIMIT = 500;
const OPERATION_RUN_FAILED_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
const OPERATION_RUN_STATUSES = new Set(['queued', 'running', 'succeeded', 'failed', 'skipped', 'cancelled']);
const OPERATION_RUN_ACTIVE_STATUSES = new Set(['queued', 'running']);
const OPERATION_RUN_TERMINAL_STATUSES = new Set(['succeeded', 'failed', 'skipped', 'cancelled']);
const OPERATION_RUN_PLATFORMS = new Set(['discord', 'kook', 'wechat', 'rustplus', 'battlemetrics', 'steam', 'system']);
const OPERATION_RUN_SOURCES = new Set(['manual', 'auto', 'interaction', 'system']);
const OPERATION_RUN_STALE_MS_RAW = Number(process.env.NB_OPERATION_RUN_STALE_MS || 15 * 60 * 1000);

export const OPERATION_RUN_STALE_MS = Number.isFinite(OPERATION_RUN_STALE_MS_RAW)
  ? Math.max(2 * 60 * 1000, OPERATION_RUN_STALE_MS_RAW)
  : 15 * 60 * 1000;
export const OPERATION_RUN_INTERRUPTED_ERROR = '服务重启，未完成的操作已标记失败';
export const OPERATION_RUN_STALE_ERROR = '操作长时间未更新，已自动结束';

function timestampForSort(value) {
  const time = Date.parse(value || '');
  return Number.isFinite(time) ? time : 0;
}

function normalizeOperationRunStatus(value) {
  const status = normalizeText(value, 40);
  return OPERATION_RUN_STATUSES.has(status) ? status : 'queued';
}

function normalizeOperationRunPlatform(value) {
  const platform = normalizeText(value, 40);
  return OPERATION_RUN_PLATFORMS.has(platform) ? platform : 'system';
}

function normalizeOperationRunSource(value) {
  const source = normalizeText(value, 40);
  return OPERATION_RUN_SOURCES.has(source) ? source : 'system';
}

export function operationRunIsActive(status) {
  return OPERATION_RUN_ACTIVE_STATUSES.has(normalizeOperationRunStatus(status));
}

function operationRunIsTerminal(status) {
  return OPERATION_RUN_TERMINAL_STATUSES.has(normalizeOperationRunStatus(status));
}

function operationRunNeedsRetentionCheck(run = {}, previous = null) {
  return operationRunIsTerminal(run?.status) || operationRunIsTerminal(previous?.status);
}

function sanitizeOperationRunMetadata(value, depth = 0) {
  if (value === null || value === undefined) return {};
  if (depth > 2) return {};
  if (Array.isArray(value)) {
    return value.slice(0, 20).map((item) => (
      item && typeof item === 'object'
        ? sanitizeOperationRunMetadata(item, depth + 1)
        : normalizeText(item, 240)
    ));
  }
  if (typeof value !== 'object') return normalizeText(value, 240);
  const blocked = /token|secret|password|openid|unionid|authorization|cookie/i;
  const entries = Object.entries(value).slice(0, 50);
  const result = {};
  for (const [key, item] of entries) {
    const safeKey = normalizeText(key, 80);
    if (!safeKey || blocked.test(safeKey)) continue;
    result[safeKey] = item && typeof item === 'object'
      ? sanitizeOperationRunMetadata(item, depth + 1)
      : normalizeText(item, 500);
  }
  return result;
}

export function ensureOperationRuns(store) {
  store.operationRuns ||= [];
  const nowMs = Date.now();
  const sorted = store.operationRuns
    .filter((run) => run?.id)
    .toSorted((left, right) => timestampForSort(right.updatedAt || right.createdAt) - timestampForSort(left.updatedAt || left.createdAt));
  const retained = [];
  let succeeded = 0;
  let failed = 0;
  let otherTerminal = 0;
  for (const run of sorted) {
    const status = normalizeOperationRunStatus(run.status);
    if (operationRunIsActive(status)) {
      retained.push(run);
      continue;
    }
    if (status === 'succeeded') {
      if (succeeded < OPERATION_RUN_SUCCEEDED_HISTORY_LIMIT) {
        retained.push(run);
        succeeded += 1;
      }
      continue;
    }
    if (status === 'failed') {
      const ageMs = nowMs - timestampForSort(run.updatedAt || run.finishedAt || run.createdAt);
      if (failed < OPERATION_RUN_FAILED_HISTORY_LIMIT || ageMs <= OPERATION_RUN_FAILED_RETENTION_MS) {
        retained.push(run);
        failed += 1;
      }
      continue;
    }
    if (otherTerminal < OPERATION_RUN_SUCCEEDED_HISTORY_LIMIT) {
      retained.push(run);
      otherTerminal += 1;
    }
  }
  store.operationRuns = retained;
  return store.operationRuns;
}

export function createOperationRunInStore(store, input = {}) {
  const now = nowIso();
  const status = normalizeOperationRunStatus(input.status || 'queued');
  const run = {
    id: normalizeText(input.id, 120) || createId('operation_run'),
    type: normalizeText(input.type, 120) || 'operation',
    platform: normalizeOperationRunPlatform(input.platform),
    source: normalizeOperationRunSource(input.source),
    status,
    targetType: normalizeText(input.targetType, 80),
    targetId: normalizeText(input.targetId, 160),
    dedupeKey: normalizeText(input.dedupeKey, 240),
    providerRequestId: normalizeText(input.providerRequestId, 160),
    messageId: normalizeText(input.messageId, 160),
    channelId: normalizeText(input.channelId, 160),
    attempt: Math.max(1, Number(input.attempt || 1)),
    errorKey: normalizeText(input.errorKey, 120),
    errorSummary: normalizeText(input.errorSummary, 500),
    retryable: Boolean(input.retryable),
    createdBy: normalizeText(input.createdBy, 120),
    startedAt: input.startedAt || (status === 'running' ? now : ''),
    finishedAt: input.finishedAt || (OPERATION_RUN_TERMINAL_STATUSES.has(status) ? now : ''),
    createdAt: input.createdAt || now,
    updatedAt: input.updatedAt || now,
    metadata: sanitizeOperationRunMetadata(input.metadata || {})
  };
  ensureOperationRuns(store).unshift(run);
  ensureOperationRuns(store);
  return run;
}

export function updateOperationRunInStore(store, operationRunId, patch = {}) {
  const id = normalizeText(operationRunId, 120);
  if (!id) return null;
  const runs = ensureOperationRuns(store);
  const index = runs.findIndex((run) => run.id === id);
  if (index < 0) return null;
  const previous = runs[index];
  const status = patch.status ? normalizeOperationRunStatus(patch.status) : normalizeOperationRunStatus(previous.status);
  const updatedAt = patch.updatedAt || nowIso();
  const metadata = patch.metadata
    ? sanitizeOperationRunMetadata({ ...(previous.metadata || {}), ...patch.metadata })
    : (previous.metadata || {});
  const next = {
    ...previous,
    ...patch,
    type: patch.type ? normalizeText(patch.type, 120) : previous.type,
    platform: patch.platform ? normalizeOperationRunPlatform(patch.platform) : previous.platform,
    source: patch.source ? normalizeOperationRunSource(patch.source) : previous.source,
    targetType: patch.targetType ? normalizeText(patch.targetType, 80) : previous.targetType,
    targetId: patch.targetId ? normalizeText(patch.targetId, 160) : previous.targetId,
    dedupeKey: patch.dedupeKey ? normalizeText(patch.dedupeKey, 240) : previous.dedupeKey,
    providerRequestId: patch.providerRequestId ? normalizeText(patch.providerRequestId, 160) : previous.providerRequestId,
    messageId: patch.messageId ? normalizeText(patch.messageId, 160) : previous.messageId,
    channelId: patch.channelId ? normalizeText(patch.channelId, 160) : previous.channelId,
    errorKey: patch.errorKey ? normalizeText(patch.errorKey, 120) : previous.errorKey,
    errorSummary: Object.hasOwn(patch, 'errorSummary') ? normalizeText(patch.errorSummary, 500) : previous.errorSummary,
    status,
    startedAt: patch.startedAt || previous.startedAt || (status === 'running' ? updatedAt : ''),
    finishedAt: OPERATION_RUN_TERMINAL_STATUSES.has(status)
      ? (patch.finishedAt || previous.finishedAt || updatedAt)
      : (patch.finishedAt ?? previous.finishedAt ?? ''),
    updatedAt,
    metadata
  };
  runs[index] = next;
  ensureOperationRuns(store);
  return next;
}

function operationRunRetentionTrimConfigs(nowMs = Date.now()) {
  const failedCutoff = new Date(nowMs - OPERATION_RUN_FAILED_RETENTION_MS).toISOString();
  return [
    {
      field: 'updatedAt',
      limit: OPERATION_RUN_SUCCEEDED_HISTORY_LIMIT,
      order: 'desc',
      filters: { status: 'succeeded' }
    },
    {
      field: 'updatedAt',
      limit: OPERATION_RUN_FAILED_HISTORY_LIMIT,
      order: 'desc',
      filters: { status: 'failed' },
      afterOffsetRange: { field: 'updatedAt', to: failedCutoff }
    },
    {
      field: 'updatedAt',
      limit: OPERATION_RUN_SUCCEEDED_HISTORY_LIMIT,
      order: 'desc',
      filters: { status: ['skipped', 'cancelled'] }
    }
  ];
}

async function patchOperationRunsCache(upserts = [], deleteIds = []) {
  try {
    await patchStoreCache((store) => {
      store.operationRuns ||= [];
      const deleteSet = new Set(deleteIds || []);
      if (deleteSet.size) {
        store.operationRuns = store.operationRuns.filter((run) => !deleteSet.has(run?.id));
      }
      for (const run of upserts || []) {
        if (!run?.id) continue;
        if (deleteSet.has(run.id)) continue;
        const index = store.operationRuns.findIndex((item) => item.id === run.id);
        if (index >= 0) store.operationRuns[index] = run;
        else store.operationRuns.unshift(run);
      }
      ensureOperationRuns(store);
    });
  } catch (error) {
    console.warn('[nb-clan] sqlite operation run cache patch failed:', error?.message || error);
  }
}

async function createOperationRunDirect(input = {}) {
  const operationStore = { operationRuns: [] };
  const run = createOperationRunInStore(operationStore, input);
  const trims = operationRunNeedsRetentionCheck(run)
    ? operationRunRetentionTrimConfigs()
    : [];
  const patchResult = await writeSqliteStorePatch({
    reason: 'operation_run_create',
    upserts: { operationRuns: [run] },
    trims: trims.length ? { operationRuns: trims } : {}
  });
  const deleteIds = patchResult.trimmed?.operationRuns || [];
  await patchOperationRunsCache([run], deleteIds);
  return run;
}

function scopedOperationRunReadUnavailable(error) {
  return Object.assign(new Error(`operation run scoped read unavailable: ${error?.message || error}`), {
    code: 'sqlite_scoped_read_unavailable',
    cause: error
  });
}

async function readOperationRunByIdDirect(id) {
  try {
    return await getSqliteRecord('operationRuns', id);
  } catch (error) {
    console.warn('[nb-clan] sqlite operation run get fallback:', error?.message || error);
    try {
      const [run] = await readSqliteRecordsByIds('operationRuns', [id]);
      return run || null;
    } catch (scopedError) {
      throw scopedOperationRunReadUnavailable(scopedError);
    }
  }
}

async function updateOperationRunDirect(operationRunId, patch = {}) {
  const id = normalizeText(operationRunId, 120);
  if (!id) return null;
  const previous = await readOperationRunByIdDirect(id);
  if (!previous) return null;
  const operationStore = { operationRuns: [previous] };
  const run = updateOperationRunInStore(operationStore, id, patch);
  if (!run) return null;
  const trims = operationRunNeedsRetentionCheck(run, previous)
    ? operationRunRetentionTrimConfigs()
    : [];
  const patchResult = await writeSqliteStorePatch({
    reason: 'operation_run_update',
    upserts: { operationRuns: [run] },
    trims: trims.length ? { operationRuns: trims } : {}
  });
  const deleteIds = patchResult.trimmed?.operationRuns || [];
  await patchOperationRunsCache(run ? [run] : [], deleteIds);
  return run;
}

export async function createOperationRun(input = {}) {
  if (sqlitePrimaryMode()) {
    return persistTraceRecordWithFallback({
      name: 'operation_run_create',
      direct: () => runStoreWriteTask(() => createOperationRunDirect(input)),
      fallbackValue: null
    });
  }
  let run = null;
  await updateStore((store) => {
    run = createOperationRunInStore(store, input);
  });
  return run;
}

export async function updateOperationRun(operationRunId, patch = {}) {
  if (sqlitePrimaryMode()) {
    return persistTraceRecordWithFallback({
      name: 'operation_run_update',
      direct: () => runStoreWriteTask(() => updateOperationRunDirect(operationRunId, patch)),
      fallbackValue: null
    });
  }
  let run = null;
  await updateStore((store) => {
    run = updateOperationRunInStore(store, operationRunId, patch);
  });
  return run;
}

export function publicOperationRun(run = {}) {
  return {
    id: run.id || '',
    type: normalizeText(run.type, 120),
    platform: normalizeOperationRunPlatform(run.platform),
    source: normalizeOperationRunSource(run.source),
    status: normalizeOperationRunStatus(run.status),
    targetType: run.targetType || '',
    targetId: run.targetId || '',
    dedupeKey: run.dedupeKey || '',
    providerRequestId: run.providerRequestId || '',
    messageId: run.messageId || '',
    channelId: run.channelId || '',
    attempt: Math.max(1, Number(run.attempt || 1)),
    errorKey: run.errorKey || '',
    errorSummary: run.errorSummary || '',
    retryable: Boolean(run.retryable),
    createdBy: run.createdBy || '',
    startedAt: run.startedAt || '',
    finishedAt: run.finishedAt || '',
    createdAt: run.createdAt || '',
    updatedAt: run.updatedAt || '',
    metadata: sanitizeOperationRunMetadata(run.metadata || {})
  };
}

function operationRunPlatformSummary(runs = []) {
  const summary = {};
  for (const run of runs) {
    const platform = normalizeOperationRunPlatform(run.platform);
    summary[platform] ||= {
      total: 0,
      current: 0,
      failed: 0,
      succeeded: 0,
      skipped: 0,
      cancelled: 0,
      latestAt: ''
    };
    const item = summary[platform];
    const status = normalizeOperationRunStatus(run.status);
    item.total += 1;
    if (operationRunIsActive(status)) item.current += 1;
    else if (status === 'failed') item.failed += 1;
    else if (status === 'succeeded') item.succeeded += 1;
    else if (status === 'skipped') item.skipped += 1;
    else if (status === 'cancelled') item.cancelled += 1;
    const latestAt = run.updatedAt || run.finishedAt || run.startedAt || run.createdAt || '';
    if (timestampForSort(latestAt) > timestampForSort(item.latestAt)) item.latestAt = latestAt;
  }
  for (const item of Object.values(summary)) {
    item.failureRate = item.total ? Number((item.failed / item.total).toFixed(4)) : 0;
    const terminal = item.failed + item.succeeded + item.skipped + item.cancelled;
    item.terminalFailureRate = terminal ? Number((item.failed / terminal).toFixed(4)) : 0;
  }
  return summary;
}

function operationRunFailureRates(runs = []) {
  const byPlatform = operationRunPlatformSummary(runs);
  const totals = Object.values(byPlatform).reduce((acc, item) => {
    acc.total += Number(item.total || 0);
    acc.current += Number(item.current || 0);
    acc.failed += Number(item.failed || 0);
    acc.succeeded += Number(item.succeeded || 0);
    acc.skipped += Number(item.skipped || 0);
    acc.cancelled += Number(item.cancelled || 0);
    return acc;
  }, {
    total: 0,
    current: 0,
    failed: 0,
    succeeded: 0,
    skipped: 0,
    cancelled: 0
  });
  const terminal = totals.failed + totals.succeeded + totals.skipped + totals.cancelled;
  return {
    ...totals,
    terminal,
    failureRate: totals.total ? Number((totals.failed / totals.total).toFixed(4)) : 0,
    terminalFailureRate: terminal ? Number((totals.failed / terminal).toFixed(4)) : 0,
    byPlatform
  };
}

export function operationRunsPayload(store, { limit = 20 } = {}) {
  const runs = ensureOperationRuns(store)
    .slice()
    .map(publicOperationRun)
    .toSorted((left, right) => timestampForSort(right.updatedAt || right.createdAt) - timestampForSort(left.updatedAt || left.createdAt));
  const max = Math.max(1, Math.min(100, Number(limit) || 20));
  const failureRates = operationRunFailureRates(runs);
  const partial = Boolean(store.operationRunsPartial);
  const readError = normalizeText(store.operationRunsReadError, 500);
  return {
    current: runs.filter((run) => operationRunIsActive(run.status)),
    failed: runs.filter((run) => run.status === 'failed').slice(0, max),
    recent: runs.slice(0, max),
    byPlatform: failureRates.byPlatform,
    failureRates,
    partial,
    readError,
    updatedAt: nowIso()
  };
}

export function finishOperationRun(operationRun, patch = {}) {
  if (!operationRun?.id) return Promise.resolve(null);
  return updateOperationRun(operationRun.id, patch).catch(() => null);
}

export function createdOperationRunsSince(store = {}, countBefore = 0) {
  return (store.operationRuns || []).slice(0, Math.max(0, (store.operationRuns || []).length - countBefore));
}

function operationRunsPartialStore(error, source = '') {
  return {
    operationRuns: [],
    operationRunsPartial: true,
    operationRunsReadError: normalizeText(error?.message || error, 500),
    operationRunsReadSource: normalizeText(source, 120)
  };
}

export async function readOperationRunsListStore() {
  if (!sqliteEnabled()) return readStore();
  try {
    return {
      operationRuns: await getSqliteRecordsByJsonField('operationRuns', 'status', [...OPERATION_RUN_STATUSES], { limit: 0 })
    };
  } catch (error) {
    console.warn('[nb-clan] sqlite operation runs partial fallback:', error?.message || error);
    return operationRunsPartialStore(error, 'list');
  }
}

export async function readOperationRunsHealthStore(limit = 100) {
  if (!sqliteEnabled()) return readStore();
  try {
    const max = Math.max(8, Math.min(100, Number(limit) || 100));
    const [recentRuns, activeRuns, failedRuns] = await Promise.all([
      getSqliteRecordsByJsonField('operationRuns', 'status', [...OPERATION_RUN_STATUSES], { limit: max }),
      getSqliteRecordsByJsonField('operationRuns', 'status', [...OPERATION_RUN_ACTIVE_STATUSES], { limit: 0 }),
      getSqliteRecordsByJsonField('operationRuns', 'status', ['failed'], { limit: max })
    ]);
    return {
      operationRuns: mergeRecordsById(recentRuns, activeRuns, failedRuns)
    };
  } catch (error) {
    console.warn('[nb-clan] sqlite operation runs health partial fallback:', error?.message || error);
    return operationRunsPartialStore(error, 'health');
  }
}

export async function readActiveOperationRunsStore() {
  if (!sqliteEnabled()) return readOperationRunsListStore();
  try {
    return {
      operationRuns: await getSqliteRecordsByJsonField('operationRuns', 'status', [...OPERATION_RUN_ACTIVE_STATUSES], { limit: 0 })
    };
  } catch (error) {
    console.warn('[nb-clan] sqlite active operation runs partial fallback:', error?.message || error);
    return operationRunsPartialStore(error, 'active');
  }
}

export async function readActiveOperationRunsByTargetStore({ type = '', targetId = '', platform = '' } = {}) {
  const normalizedType = normalizeText(type, 120);
  const normalizedTargetId = normalizeText(targetId, 160);
  const normalizedPlatform = normalizeOperationRunPlatform(platform);
  if (!sqliteEnabled() || !normalizedType || !normalizedTargetId) return readActiveOperationRunsStore();
  try {
    return {
      operationRuns: await getSqliteRecordsByJsonFields('operationRuns', {
        targetId: [normalizedTargetId],
        status: [...OPERATION_RUN_ACTIVE_STATUSES],
        type: [normalizedType],
        ...(platform ? { platform: [normalizedPlatform] } : {})
      }, { limit: 0 })
    };
  } catch (error) {
    console.warn('[nb-clan] sqlite targeted active operation runs partial fallback:', error?.message || error);
    return operationRunsPartialStore(error, 'targeted_active');
  }
}

export async function reconcileStaleOperationRuns({ force = false, reason = OPERATION_RUN_STALE_ERROR } = {}) {
  const store = await readActiveOperationRunsStore();
  const nowMs = Date.now();
  const cutoffMs = nowMs - OPERATION_RUN_STALE_MS;
  const staleRuns = ensureOperationRuns(store).filter((run) => {
    if (!operationRunIsActive(run.status)) return false;
    if (force) return true;
    const updatedMs = timestampForSort(run.updatedAt || run.startedAt || run.createdAt);
    return !updatedMs || updatedMs < cutoffMs;
  });
  if (!staleRuns.length) return { updated: 0 };
  const updatedAt = nowIso();
  let updated = 0;
  for (const run of staleRuns) {
    const next = await updateOperationRun(run.id, {
      status: 'failed',
      errorKey: force ? 'operation_interrupted' : 'operation_stale',
      errorSummary: reason,
      retryable: Boolean(run.retryable || ['discord', 'kook', 'wechat', 'battlemetrics', 'steam'].includes(run.platform)),
      finishedAt: updatedAt,
      updatedAt,
      metadata: { staleReconciledAt: updatedAt }
    });
    if (next) updated += 1;
  }
  return { updated };
}
