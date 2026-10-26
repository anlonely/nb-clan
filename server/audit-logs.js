import { createId, normalizeText, nowIso, patchStoreCache, readStore, updateStore } from './store.js';
import { getSqliteCollection, trimSqliteCollectionByJsonFieldLimit, writeSqliteStorePatch } from './storage/repository.js';
import { applyStoreCollectionCachePatch } from './storage/store-patch-diff.js';
import { sqliteEnabled, sqlitePrimaryMode } from './storage/sqlite.js';
import { queueBackgroundTask } from './background-task-queue.js';
import { getIp } from './request-context.js';

export const LOG_HISTORY_LIMIT = 1000;

function logListUnavailableError(error) {
  return Object.assign(new Error('日志读取暂不可用，请稍后重试'), {
    status: 503,
    code: 'log_list_unavailable',
    cause: error
  });
}

export function logTrimPatch() {
  return {
    logs: {
      field: 'createdAt',
      limit: LOG_HISTORY_LIMIT,
      order: 'desc'
    }
  };
}

export function trimmedLogIds(patchResult = null) {
  return patchResult?.trimmed?.logs || [];
}

export function requestActorUserId(req, fallback = 'anonymous') {
  return normalizeText(req?.user?.id, 120)
    || normalizeText(req?.wechatManagementUser?.id, 120)
    || normalizeText(req?.wechatUser?.id, 120)
    || normalizeText(fallback, 120)
    || 'anonymous';
}

export function requestActorUsername(req, fallback = 'anonymous') {
  return normalizeText(req?.user?.username, 120)
    || normalizeText(req?.wechatManagementUser?.username, 120)
    || normalizeText(req?.wechatUser?.nickname, 120)
    || normalizeText(req?.wechatUser?.id, 120)
    || normalizeText(fallback, 120)
    || 'anonymous';
}

export function appendLog(store, req, type, summary, options = {}) {
  const actorUserId = normalizeText(options.actorUserId, 120) || requestActorUserId(req);
  const actorUsername = normalizeText(options.actorUsername, 120) || requestActorUsername(req);
  store.logs ||= [];
  store.logs.unshift({
    id: createId('log'),
    type,
    actorUserId,
    actorUsername,
    ip: req ? getIp(req) : (options.ip || 'system'),
    steamId: options.steamId || '',
    targetId: options.targetId || '',
    summary,
    metadata: options.metadata || {},
    createdAt: nowIso()
  });
  store.logs = store.logs.slice(0, LOG_HISTORY_LIMIT);
}

export function createLogEntry(req, type, summary, options = {}) {
  const store = { logs: [] };
  appendLog(store, req, type, summary, options);
  return store.logs[0];
}

export async function readLogListStore() {
  if (!sqliteEnabled()) return readStore();
  try {
    return {
      logs: await getSqliteCollection('logs', { limit: LOG_HISTORY_LIMIT })
    };
  } catch (error) {
    console.warn('[nb-clan] sqlite log list fallback:', error?.message || error);
    throw logListUnavailableError(error);
  }
}

export async function trimSqliteLogsAfterDirectWrite(reason = 'logs_trim') {
  try {
    return await trimSqliteCollectionByJsonFieldLimit('logs', 'createdAt', LOG_HISTORY_LIMIT, { reason });
  } catch (error) {
    console.warn('[nb-clan] sqlite log trim skipped:', error?.message || error);
    return { deletedIds: [] };
  }
}

export function applyCachedLogPatch(cachedStore, logs = [], deletedIds = []) {
  const upsertLogs = (Array.isArray(logs) ? logs : [logs]).filter((log) => log?.id);
  const deleteLogs = (Array.isArray(deletedIds) ? deletedIds : [deletedIds]).filter(Boolean);
  if (!upsertLogs.length && !deleteLogs.length) return;
  applyStoreCollectionCachePatch(cachedStore, ['logs'], { logs: upsertLogs }, { logs: deleteLogs });
}

export async function appendLogDirect(req, type, summary, options = {}) {
  if (!sqlitePrimaryMode()) {
    return updateStore((store) => appendLog(store, req, type, summary, options));
  }
  const log = createLogEntry(req, type, summary, options);
  let patchResult = null;
  try {
    patchResult = await writeSqliteStorePatch({
      reason: 'append_log',
      upserts: { logs: [log] },
      trims: logTrimPatch()
    });
  } catch (error) {
    console.warn('[nb-clan] sqlite append log skipped:', error?.message || error);
    return null;
  }
  try {
    await patchStoreCache((store) => {
      applyCachedLogPatch(store, [log], trimmedLogIds(patchResult));
    });
  } catch (error) {
    console.warn('[nb-clan] sqlite append log cache patch skipped:', error?.message || error);
  }
  return log;
}

export async function appendAuthAccessLog(req, type, summary, options = {}) {
  if (sqlitePrimaryMode() || process.env.NB_DISABLE_BACKGROUND_JOBS === '1') {
    await appendLogDirect(req, type, summary, options);
    return;
  }
  queueBackgroundTask(`auth-access-log:${type}:${Date.now()}`, () => (
    appendLogDirect(req, type, summary, options)
  ), 0);
}
