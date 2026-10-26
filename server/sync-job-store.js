import { normalizeText, nowIso, patchStoreCache, readStore, runStoreWriteTask, updateStore } from './store.js';
import {
  applyCachedLogPatch,
  appendLog,
  createLogEntry,
  logTrimPatch,
  trimmedLogIds
} from './audit-logs.js';
import { sqliteEnabled, sqlitePrimaryMode } from './storage/sqlite.js';
import {
  getSqliteCollection,
  getSqliteRecord,
  getSqliteRecordsByJsonField,
  getSqliteRecordsByJsonFields,
  getSqliteScalar,
  writeSqliteStorePatch
} from './storage/repository.js';
import { replaceCachedRecord } from './storage/store-patch-diff.js';
import {
  mergeRecordsById,
  readSqliteRecordsByIds,
  uniqueNormalizedTexts
} from './sqlite-read-utils.js';
import {
  SYNC_JOB_ACTIVE_STATUSES,
  SYNC_JOB_HISTORY_LIMIT,
  SYNC_JOB_INTERRUPTED_ERROR,
  SYNC_JOB_STALE_ERROR,
  SYNC_JOB_TERMINAL_STATUSES,
  activeSyncStateIsStale,
  createSyncJobInStore,
  ensureSyncJobs,
  findActiveSyncJob,
  isEmptyCompletedSyncJob,
  mergeSyncStateForJob,
  reconcileActiveSyncWork,
  staleSyncJob,
  syncJobShouldCountAsActive,
  syncJobIsActive,
  syncStateLinkedQueuedSerialJob,
  syncJobProgressPatchFromState,
  normalizeSyncJobScope,
  normalizeSyncJobType,
  updateSyncJobInStore
} from './sync-jobs.js';

function activeSyncJobSqliteFilters(input = {}) {
  const filters = {
    status: [...SYNC_JOB_ACTIVE_STATUSES],
    type: normalizeSyncJobType(input.type)
  };
  if (input.scope) filters.scope = normalizeSyncJobScope(input.scope);
  if (input.targetWipeId) filters.targetWipeId = normalizeText(input.targetWipeId, 120);
  if (input.targetVitalWipeId) filters.targetVitalWipeId = normalizeText(input.targetVitalWipeId, 120);
  if (input.targetServerId) filters.targetServerId = normalizeText(input.targetServerId, 120);
  return filters;
}

function syncJobsPartialStore(error, source = '', { includeSyncState = true } = {}) {
  return {
    syncJobs: [],
    syncState: includeSyncState ? {} : {},
    syncJobsPartial: true,
    syncJobsReadError: normalizeText(error?.message || error, 500),
    syncJobsReadSource: normalizeText(source, 120)
  };
}

function syncStatePartialStore(error, source = '') {
  return {
    syncState: {},
    syncStatePartial: true,
    syncStateReadError: normalizeText(error?.message || error, 500),
    syncStateReadSource: normalizeText(source, 120)
  };
}

function syncJobStoreWriteUnavailableError(label, cause) {
  return Object.assign(new Error(`${label}暂不可用，请稍后重试`), {
    status: 503,
    code: 'sqlite_direct_write_unavailable',
    errorKey: 'sqlite_direct_write_unavailable',
    skipApiErrorLog: true,
    cause
  });
}

function syncJobScopedReadUnavailableError(error) {
  return Object.assign(new Error(`sync job scoped read unavailable: ${error?.message || error}`), {
    status: 503,
    code: 'sqlite_scoped_read_unavailable',
    skipApiErrorLog: true,
    cause: error
  });
}

function syncStateReadUnavailableError(error) {
  return Object.assign(new Error('同步状态读取暂不可用，请稍后重试'), {
    status: 503,
    code: 'sqlite_sync_state_read_unavailable',
    errorKey: 'sqlite_sync_state_read_unavailable',
    skipApiErrorLog: true,
    cause: error
  });
}

export async function readSyncStateForWrite() {
  try {
    return await getSqliteScalar('syncState') || {};
  } catch (error) {
    throw syncStateReadUnavailableError(error);
  }
}

async function writeSyncJobStorePatch(input, label = '同步任务记录') {
  try {
    return await writeSqliteStorePatch(input);
  } catch (error) {
    throw syncJobStoreWriteUnavailableError(label, error);
  }
}

export async function readSyncJobsListStore(options = {}) {
  if (!sqliteEnabled()) return readStore();
  try {
    const includeSyncState = options.includeSyncState !== false;
    const [syncJobs, syncState] = await Promise.all([
      getSqliteCollection('syncJobs', { limit: 1000 }),
      includeSyncState ? getSqliteScalar('syncState') : Promise.resolve({})
    ]);
    return {
      syncJobs,
      syncState: syncState || {}
    };
  } catch (error) {
    console.warn('[nb-clan] sqlite sync jobs fallback:', error?.message || error);
    return syncJobsPartialStore(error, 'list', { includeSyncState: options.includeSyncState !== false });
  }
}

export async function readSyncStatusStore() {
  if (!sqliteEnabled()) return readStore();
  try {
    return {
      syncState: await getSqliteScalar('syncState') || {}
    };
  } catch (error) {
    console.warn('[nb-clan] sqlite sync status partial fallback:', error?.message || error);
    return syncStatePartialStore(error, 'status');
  }
}

export async function readActiveSyncJobsForSqlite() {
  return getSqliteRecordsByJsonField('syncJobs', 'status', [...SYNC_JOB_ACTIVE_STATUSES], { limit: 0 });
}

export async function readRuntimeSyncJobs(options = {}) {
  const mode = options.syncJobs ?? options.includeSyncJobs;
  if (mode === false || mode === 'none') return [];
  if (mode === 'all') return getSqliteCollection('syncJobs', { limit: 0 });
  const syncJobIds = uniqueNormalizedTexts([
    options.syncJobId,
    ...(Array.isArray(options.syncJobIds) ? options.syncJobIds : [options.syncJobIds])
  ], 120);
  const [activeJobs, selectedJobs] = await Promise.all([
    readActiveSyncJobsForSqlite(),
    syncJobIds.length ? readSqliteRecordsByIds('syncJobs', syncJobIds) : Promise.resolve([])
  ]);
  return mergeRecordsById(activeJobs, selectedJobs);
}

export async function readSerialSyncQueueStore() {
  if (!sqlitePrimaryMode()) return readSyncJobsListStore();
  return {
    syncJobs: await readRuntimeSyncJobs(),
    syncState: {}
  };
}

export async function readCurrentSyncJobsStore() {
  if (!sqliteEnabled()) return readStore();
  try {
    return {
      syncJobs: await readActiveSyncJobsForSqlite(),
      syncState: {}
    };
  } catch (error) {
    console.warn('[nb-clan] sqlite current sync jobs partial fallback:', error?.message || error);
    return syncJobsPartialStore(error, 'current', { includeSyncState: false });
  }
}

export async function readRecentSyncJobsStore(limit = 20) {
  if (!sqliteEnabled()) return readStore();
  try {
    const recentLimit = Math.max(
      Math.max(1, Math.min(100, Number(limit) || 20)),
      SYNC_JOB_HISTORY_LIMIT
    );
    const [terminalJobs, activeJobs] = await Promise.all([
      getSqliteRecordsByJsonField('syncJobs', 'status', [...SYNC_JOB_TERMINAL_STATUSES], { limit: recentLimit }),
      readActiveSyncJobsForSqlite()
    ]);
    return {
      syncJobs: mergeRecordsById(terminalJobs, activeJobs),
      syncState: {}
    };
  } catch (error) {
    console.warn('[nb-clan] sqlite recent sync jobs partial fallback:', error?.message || error);
    return syncJobsPartialStore(error, 'recent', { includeSyncState: false });
  }
}

export async function readSyncJobsHealthStore(limit = SYNC_JOB_HISTORY_LIMIT) {
  if (!sqliteEnabled()) return readStore();
  try {
    const requestedLimit = Math.max(1, Math.min(1000, Number(limit) || SYNC_JOB_HISTORY_LIMIT));
    const recentLimit = Math.max(SYNC_JOB_HISTORY_LIMIT, requestedLimit);
    const [terminalJobs, activeJobs] = await Promise.all([
      getSqliteRecordsByJsonField('syncJobs', 'status', [...SYNC_JOB_TERMINAL_STATUSES], { limit: recentLimit }),
      readActiveSyncJobsForSqlite()
    ]);
    return {
      syncJobs: mergeRecordsById(terminalJobs, activeJobs),
      syncState: {}
    };
  } catch (error) {
    console.warn('[nb-clan] sqlite sync jobs health partial fallback:', error?.message || error);
    return syncJobsPartialStore(error, 'health', { includeSyncState: false });
  }
}

export async function readSyncJobStatusStore(options = {}) {
  if (!sqliteEnabled()) return readSyncJobsListStore();
  try {
    const [syncJobs, syncState] = await Promise.all([
      readRuntimeSyncJobs(options),
      getSqliteScalar('syncState')
    ]);
    return {
      syncJobs,
      syncState: syncState || {}
    };
  } catch (error) {
    console.warn('[nb-clan] sqlite sync job status partial fallback:', error?.message || error);
    return syncJobsPartialStore(error, 'job_status');
  }
}

async function patchSyncJobsCache(upserts = [], deletedIds = []) {
  const deleted = new Set((deletedIds || []).filter(Boolean));
  await patchStoreCache((cachedStore) => {
    cachedStore.syncJobs ||= [];
    if (deleted.size) {
      cachedStore.syncJobs = cachedStore.syncJobs.filter((job) => !deleted.has(job.id));
    }
    for (const job of upserts || []) {
      if (!job?.id || deleted.has(job.id)) continue;
      const index = cachedStore.syncJobs.findIndex((item) => item.id === job.id);
      if (index >= 0) cachedStore.syncJobs[index] = job;
      else cachedStore.syncJobs.unshift(job);
    }
    ensureSyncJobs(cachedStore);
  });
}

async function readSyncJobRecordDirect(id, source = 'sync_job') {
  const normalizedId = normalizeText(id, 120);
  if (!normalizedId) return null;
  try {
    return await getSqliteRecord('syncJobs', normalizedId);
  } catch (error) {
    console.warn(`[nb-clan] sqlite ${source} get fallback:`, error?.message || error);
    try {
      const [job] = await readSqliteRecordsByIds('syncJobs', [normalizedId]);
      return job || null;
    } catch (scopedError) {
      throw syncJobScopedReadUnavailableError(scopedError);
    }
  }
}

async function createSyncJobDirect(input = {}) {
  const store = { syncJobs: [] };
  const job = createSyncJobInStore(store, input);
  if (isEmptyCompletedSyncJob(job)) return job;
  const patchResult = await writeSyncJobStorePatch({
    reason: 'sync_job_create',
    upserts: { syncJobs: [job] },
    trims: {
      syncJobs: {
        field: 'updatedAt',
        limit: SYNC_JOB_HISTORY_LIMIT,
        order: 'desc'
      }
    }
  }, '同步任务创建记录');
  await patchSyncJobsCache([job], patchResult.trimmed?.syncJobs || []);
  return job;
}

export async function createSyncJobUnlessActive(input = {}, activeInput = {}) {
  const createOrReuse = (store) => {
    const activeJob = findActiveSyncJob(store, activeInput);
    if (activeJob) return { job: activeJob, reused: true };
    return { job: createSyncJobInStore(store, input), reused: false };
  };
  if (!sqlitePrimaryMode()) return updateStore(createOrReuse);
  return runStoreWriteTask(async () => {
    const activeCandidates = await getSqliteRecordsByJsonFields('syncJobs', activeSyncJobSqliteFilters(activeInput), { limit: 0 });
    const activeJob = findActiveSyncJob({ syncJobs: activeCandidates }, activeInput);
    if (activeJob) return { job: activeJob, reused: true };
    return { job: await createSyncJobDirect(input), reused: false };
  });
}

export async function updateSyncJob(syncJobId, patch = {}) {
  const id = normalizeText(syncJobId, 120);
  if (!id) return null;
  if (sqlitePrimaryMode()) {
    return runStoreWriteTask(async () => {
      const job = await readSyncJobRecordDirect(id, 'sync job update');
      if (!job) return null;
      const store = { syncJobs: [job] };
      const updatedJob = updateSyncJobInStore(store, id, patch);
      if (!updatedJob) return null;
      if (updatedJob === job) {
        const requestedStatus = normalizeText(patch?.status, 40);
        return !requestedStatus || SYNC_JOB_ACTIVE_STATUSES.has(requestedStatus) ? null : job;
      }
      await writeSyncJobStorePatch({
        reason: 'sync_job_update',
        upserts: { syncJobs: [updatedJob] }
      }, '同步任务状态记录');
      await patchStoreCache((cachedStore) => {
        cachedStore.syncJobs ||= [];
        replaceCachedRecord(cachedStore.syncJobs, updatedJob);
      });
      return updatedJob;
    });
  }
  let updatedJob = null;
  await updateStore((store) => {
    updatedJob = updateSyncJobInStore(store, id, patch);
  });
  return updatedJob;
}

export async function failSyncJob(syncJobId, error) {
  if (!syncJobId) return;
  const errorSummary = normalizeText(error?.message || error || '同步失败', 240);
  if (sqlitePrimaryMode()) {
    await runStoreWriteTask(async () => {
      const job = await readSyncJobRecordDirect(syncJobId, 'sync job fail');
      if (!job) return;
      const store = { syncJobs: [job] };
      const updatedJob = updateSyncJobInStore(store, syncJobId, {
        status: 'failed',
        percent: 100,
        etaSeconds: 0,
        errorSummary
      });
      if (!updatedJob) return;
      if (updatedJob === job) return;
      await writeSyncJobStorePatch({
        reason: 'sync_job_fail',
        upserts: { syncJobs: [updatedJob] }
      }, '同步任务失败记录');
      await patchStoreCache((cachedStore) => {
        cachedStore.syncJobs ||= [];
        replaceCachedRecord(cachedStore.syncJobs, updatedJob);
      });
    });
    return;
  }
  await updateStore((store) => {
    updateSyncJobInStore(store, syncJobId, {
      status: 'failed',
      percent: 100,
      etaSeconds: 0,
      errorSummary
    });
  });
}

export async function readSyncJobById(syncJobId) {
  const id = normalizeText(syncJobId, 120);
  if (!id) return null;
  if (sqliteEnabled()) {
    try {
      return await readSyncJobRecordDirect(id, 'sync job read');
    } catch (error) {
      console.warn('[nb-clan] sqlite sync job scoped read unavailable:', error?.message || error);
      if (sqlitePrimaryMode()) throw error;
      return null;
    }
  }
  const store = await readSyncJobsListStore();
  return (store.syncJobs || []).find((job) => job.id === id) || null;
}

export async function syncJobCancelRequested(syncJobId) {
  const id = normalizeText(syncJobId, 120);
  if (!id) return false;
  const job = await readSyncJobById(id);
  return normalizeText(job?.status, 40) === 'cancelled';
}

export async function writeSyncState(kind, patch) {
  if (sqlitePrimaryMode()) {
    await runStoreWriteTask(async () => {
      const key = normalizeText(kind, 80);
      if (!key) return;
      const previousSyncState = await readSyncStateForWrite();
      const previous = previousSyncState[key] || {};
      const syncJobId = normalizeText(patch?.syncJobId, 120);
      const nextState = mergeSyncStateForJob(previous, patch);
      const nextSyncState = {
        ...previousSyncState,
        [key]: nextState
      };
      let updatedJob = null;
      if (syncJobId) {
        const job = await readSyncJobRecordDirect(syncJobId, 'sync state linked job');
        if (job) {
          const store = { syncJobs: [job] };
          const candidate = updateSyncJobInStore(store, syncJobId, syncJobProgressPatchFromState(key, nextState));
          if (candidate !== job) updatedJob = candidate;
        }
      }
      await writeSyncJobStorePatch({
        reason: 'sync_state_write',
        scalars: { syncState: nextSyncState },
        ...(updatedJob ? { upserts: { syncJobs: [updatedJob] } } : {})
      }, '同步状态记录');
      await patchStoreCache((store) => {
        store.syncState ||= {};
        store.syncState[key] = nextState;
        if (updatedJob) {
          store.syncJobs ||= [];
          replaceCachedRecord(store.syncJobs, updatedJob);
        }
      });
    });
    return;
  }
  await updateStore((store) => {
    store.syncState ||= {};
    const previous = store.syncState[kind] || {};
    const syncJobId = normalizeText(patch?.syncJobId, 120);
    const nextState = mergeSyncStateForJob(previous, patch);
    store.syncState[kind] = nextState;
    if (syncJobId) {
      updateSyncJobInStore(store, syncJobId, syncJobProgressPatchFromState(kind, nextState));
    }
  });
}

export async function reconcileStaleSyncWork({ reason = SYNC_JOB_STALE_ERROR, nowMs = Date.now(), status = 'failed' } = {}) {
  const options = { force: false, reason, nowMs, status };
  if (!sqlitePrimaryMode()) {
    return updateStore((store) => reconcileActiveSyncWork(store, options));
  }

  return runStoreWriteTask(async () => {
    const [syncJobs, syncState] = await Promise.all([
      readActiveSyncJobsForSqlite(),
      readSyncStateForWrite()
    ]);
    const jobsById = new Map((syncJobs || []).map((job) => [normalizeText(job.id, 120), job]).filter(([id]) => Boolean(id)));
    const staleJobIds = new Set((syncJobs || [])
      .filter((job) => staleSyncJob(job, nowMs))
      .map((job) => normalizeText(job.id, 120))
      .filter(Boolean));
    const staleStateKeys = Object.entries(syncState || {})
      .filter(([, state]) => state && typeof state === 'object')
      .filter(([, state]) => !syncStateLinkedQueuedSerialJob(state, jobsById))
      .filter(([, state]) => activeSyncStateIsStale(state, nowMs, false))
      .map(([key]) => key);
    if (!staleJobIds.size && !staleStateKeys.length) return 0;

    const store = { syncJobs: syncJobs || [], syncState: syncState || {} };
    const changed = reconcileActiveSyncWork(store, options);
    if (!changed) return 0;

    const updatedJobs = (store.syncJobs || []).filter((job) => staleJobIds.has(normalizeText(job.id, 120)));
    await writeSyncJobStorePatch({
      reason: 'sync_job_stale_reconcile',
      ...(updatedJobs.length ? { upserts: { syncJobs: updatedJobs } } : {}),
      scalars: { syncState: store.syncState || {} }
    }, '同步任务过期记录');
    await patchStoreCache((cachedStore) => {
      cachedStore.syncJobs ||= [];
      for (const job of updatedJobs) replaceCachedRecord(cachedStore.syncJobs, job);
      cachedStore.syncState = store.syncState || {};
    });
    return changed;
  });
}

export async function reconcileActiveSyncWorkOnStartup() {
  const options = { force: true, reason: SYNC_JOB_INTERRUPTED_ERROR, status: 'cancelled' };
  if (!sqlitePrimaryMode()) {
    return updateStore((store) => {
      reconcileActiveSyncWork(store, options);
    });
  }

  return runStoreWriteTask(async () => {
    const nowMs = Date.now();
    const [syncJobs, syncState] = await Promise.all([
      readActiveSyncJobsForSqlite(),
      readSyncStateForWrite()
    ]);
    const activeJobs = syncJobs || [];
    const activeStateKeys = Object.entries(syncState || {})
      .filter(([, state]) => activeSyncStateIsStale(state, nowMs, true))
      .map(([key]) => key);
    if (!activeJobs.length && !activeStateKeys.length) return 0;

    const store = { syncJobs: syncJobs || [], syncState: syncState || {} };
    const changed = reconcileActiveSyncWork(store, { ...options, nowMs });
    if (!changed) return 0;

    const activeJobIds = new Set(activeJobs.map((job) => job.id).filter(Boolean));
    const updatedJobs = (store.syncJobs || []).filter((job) => activeJobIds.has(job.id));
    await writeSyncJobStorePatch({
      reason: 'sync_job_startup_reconcile',
      ...(updatedJobs.length ? { upserts: { syncJobs: updatedJobs } } : {}),
      scalars: { syncState: store.syncState || {} }
    }, '同步任务启动恢复记录');
    await patchStoreCache((cachedStore) => {
      cachedStore.syncJobs ||= [];
      for (const job of updatedJobs) replaceCachedRecord(cachedStore.syncJobs, job);
      cachedStore.syncState = store.syncState || {};
    });
    return changed;
  });
}

export async function deleteSyncJobById(req, syncJobId) {
  const id = normalizeText(syncJobId, 120);
  if (!id) return { deleted: 0, active: false, invalid: true };
  if (!sqlitePrimaryMode()) {
    let deleted = 0;
    let active = false;
    await updateStore((store) => {
      reconcileActiveSyncWork(store);
      const jobs = ensureSyncJobs(store);
      const index = jobs.findIndex((job) => job.id === id);
      if (index < 0) return;
      if (syncJobShouldCountAsActive(jobs[index])) {
        active = true;
        return;
      }
      jobs.splice(index, 1);
      deleted = 1;
      appendLog(store, req, 'sync_job_delete', `删除同步任务 ${id}`, { metadata: { syncJobId: id } });
    });
    return { deleted, active };
  }

  const existingJob = await readSyncJobRecordDirect(id, 'sync job delete precheck');
  if (!existingJob) return { deleted: 0, active: false };
  if (syncJobShouldCountAsActive(existingJob)) return { deleted: 0, active: true };
  if (syncJobIsActive(existingJob.status)) {
    await reconcileStaleSyncWork();
  }
  return runStoreWriteTask(async () => {
    const job = await readSyncJobRecordDirect(id, 'sync job delete');
    if (!job) return { deleted: 0, active: false };
    if (syncJobShouldCountAsActive(job)) return { deleted: 0, active: true };
    const log = createLogEntry(req, 'sync_job_delete', `删除同步任务 ${id}`, { metadata: { syncJobId: id } });
    const patchResult = await writeSyncJobStorePatch({
      reason: 'sync_job_delete',
      deletes: { syncJobs: [id] },
      upserts: { logs: [log] },
      trims: logTrimPatch()
    }, '同步任务删除记录');
    await patchStoreCache((cachedStore) => {
      cachedStore.syncJobs = (cachedStore.syncJobs || []).filter((item) => item.id !== id);
      applyCachedLogPatch(cachedStore, [log], trimmedLogIds(patchResult));
    });
    return { deleted: 1, active: false };
  });
}
