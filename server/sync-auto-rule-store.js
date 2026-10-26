import { patchStoreCache, readStore, runStoreWriteTask, updateStore } from './store.js';
import { getSqliteCollection, writeSqliteStorePatch } from './storage/repository.js';
import { sqliteEnabled, sqlitePrimaryMode } from './storage/sqlite.js';
import {
  applyStoreCollectionCachePatch,
  cloneRecordsForPatch,
  sqliteRecordDeltaById
} from './storage/store-patch-diff.js';
import { LOG_HISTORY_LIMIT, logTrimPatch, trimmedLogIds } from './audit-logs.js';

function syncAutoRuleStoreUnavailableError(error, label) {
  return Object.assign(new Error(`${label}暂不可用，请稍后重试`), {
    status: 503,
    code: 'sync_auto_rule_store_unavailable',
    cause: error
  });
}

function timestampForSort(value) {
  const time = Date.parse(value || '');
  return Number.isFinite(time) ? time : 0;
}

function applyCachedLogPatch(cachedStore, logs = [], deletedIds = []) {
  const upsertLogs = (Array.isArray(logs) ? logs : [logs]).filter((log) => log?.id);
  const deleteLogs = (Array.isArray(deletedIds) ? deletedIds : [deletedIds]).filter(Boolean);
  if (!upsertLogs.length && !deleteLogs.length) return;
  applyStoreCollectionCachePatch(cachedStore, ['logs'], { logs: upsertLogs }, { logs: deleteLogs });
}

export async function readSyncAutoRulesStore() {
  if (!sqliteEnabled()) return readStore();
  try {
    return {
      syncAutoRules: await getSqliteCollection('syncAutoRules', { limit: 1000 })
    };
  } catch (error) {
    console.warn('[nb-clan] sqlite sync auto-rules fallback:', error?.message || error);
    throw syncAutoRuleStoreUnavailableError(error, '自动任务规则读取');
  }
}

export async function updateSyncAutoRulesLogStore(mutator, reason = 'sync_auto_rule_update') {
  if (!sqlitePrimaryMode()) return updateStore(mutator);
  return runStoreWriteTask(async () => {
    const syncAutoRules = await getSqliteCollection('syncAutoRules', { limit: 1000 });
    const beforeSyncAutoRules = cloneRecordsForPatch(syncAutoRules);
    const store = {
      syncAutoRules,
      logs: []
    };
    const result = await mutator(store);
    const createdLogs = (store.logs || [])
      .toSorted((left, right) => timestampForSort(right.createdAt) - timestampForSort(left.createdAt))
      .slice(0, LOG_HISTORY_LIMIT);
    const rulePatch = sqliteRecordDeltaById(beforeSyncAutoRules, store.syncAutoRules || []);
    const upserts = {};
    const deletes = {};
    if (rulePatch.upserts.length) upserts.syncAutoRules = rulePatch.upserts;
    if (rulePatch.deletes.length) deletes.syncAutoRules = rulePatch.deletes;
    if (createdLogs.length) upserts.logs = createdLogs;
    let patchResult = { trimmed: {} };
    if (Object.keys(upserts).length || Object.keys(deletes).length) {
      patchResult = await writeSqliteStorePatch({
        reason,
        upserts,
        deletes,
        trims: createdLogs.length ? logTrimPatch() : {}
      });
    }
    await patchStoreCache((cachedStore) => {
      cachedStore.syncAutoRules = store.syncAutoRules || [];
      applyCachedLogPatch(cachedStore, createdLogs, trimmedLogIds(patchResult));
    });
    return result;
  }).catch((error) => {
    if (error?.status) throw error;
    console.warn('[nb-clan] sqlite sync auto-rules update fallback:', error?.message || error);
    throw syncAutoRuleStoreUnavailableError(error, '自动任务规则写入');
  });
}
