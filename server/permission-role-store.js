import { patchStoreCache, readStore, runStoreWriteTask, updateStore } from './store.js';
import { getSqliteCollection, writeSqliteStorePatch } from './storage/repository.js';
import { sqlitePrimaryMode } from './storage/sqlite.js';
import {
  applyCachedLogPatch,
  logTrimPatch,
  trimmedLogIds
} from './audit-logs.js';

function permissionRoleStoreUnavailableError(error, label) {
  return Object.assign(new Error(`${label}暂不可用，请稍后重试`), {
    status: 503,
    code: 'permission_role_store_unavailable',
    cause: error
  });
}

export async function readPermissionCheckStore() {
  if (!sqlitePrimaryMode()) return readStore();
  try {
    return {
      permissionRoles: await getSqliteCollection('permissionRoles', { limit: 1000 })
    };
  } catch (error) {
    console.warn('[nb-clan] sqlite permission check fallback:', error?.message || error);
    throw permissionRoleStoreUnavailableError(error, '权限读取');
  }
}

export async function updatePermissionRolesLogStore(mutator, reason = 'permission_role_update') {
  if (!sqlitePrimaryMode()) return updateStore(mutator);
  return runStoreWriteTask(async () => {
    const permissionRoles = await getSqliteCollection('permissionRoles', { limit: 0 });
    const store = {
      permissionRoles,
      logs: []
    };
    const result = await mutator(store);
    const createdLogs = Array.isArray(store.logs) ? store.logs : [];
    const patchResult = await writeSqliteStorePatch({
      reason,
      replaces: { permissionRoles: store.permissionRoles || [] },
      upserts: createdLogs.length ? { logs: createdLogs } : {},
      trims: createdLogs.length ? logTrimPatch() : {}
    });
    await patchStoreCache((cachedStore) => {
      cachedStore.permissionRoles = store.permissionRoles || [];
      applyCachedLogPatch(cachedStore, createdLogs, trimmedLogIds(patchResult));
    });
    return result;
  }).catch((error) => {
    if (error?.status) throw error;
    console.warn('[nb-clan] sqlite permission role update fallback:', error?.message || error);
    throw permissionRoleStoreUnavailableError(error, '权限角色写入');
  });
}
