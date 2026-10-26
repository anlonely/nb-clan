import { patchStoreCache, readStore, runStoreWriteTask, updateStore } from './store.js';
import { getSqliteCollection, getSqliteRecord, writeSqliteStorePatch } from './storage/repository.js';
import {
  applyStoreCollectionCachePatch,
  diffStoreCollections,
  snapshotStoreCollections
} from './storage/store-patch-diff.js';
import { sqlitePrimaryMode } from './storage/sqlite.js';
import {
  logTrimPatch,
  trimmedLogIds
} from './audit-logs.js';

const USER_ACCOUNT_COLLECTIONS = [
  'users',
  'members',
  'squads',
  'squadMembers',
  'sessions',
  'logs'
];

function userAccountStoreUnavailableError(error, label) {
  return Object.assign(new Error(`${label}暂不可用，请稍后重试`), {
    status: 503,
    code: 'user_account_store_unavailable',
    cause: error
  });
}

function emptyUserAccountRuntimeStore({ users = [], permissionRoles = [] } = {}) {
  return {
    users,
    permissionRoles,
    settings: {},
    members: [],
    squads: [],
    squadMembers: [],
    wipes: [],
    wipeParticipants: [],
    kdaRows: [],
    kdaSnapshots: [],
    memberProfiles: [],
    accountAlertDismissals: [],
    syncState: {}
  };
}

export async function readUserRuntimeStore(userId = '') {
  if (!sqlitePrimaryMode()) return readStore();
  try {
    const [user, permissionRoles] = await Promise.all([
      userId ? getSqliteRecord('users', userId) : Promise.resolve(null),
      getSqliteCollection('permissionRoles', { limit: 0 })
    ]);
    return emptyUserAccountRuntimeStore({
      users: user ? [user] : [],
      permissionRoles
    });
  } catch (error) {
    console.warn('[nb-clan] sqlite user runtime store fallback:', error?.message || error);
    throw userAccountStoreUnavailableError(error, '账号读取');
  }
}

export async function readUsersRuntimeStore() {
  if (!sqlitePrimaryMode()) return readStore();
  try {
    const [users, permissionRoles] = await Promise.all([
      getSqliteCollection('users', { limit: 0 }),
      getSqliteCollection('permissionRoles', { limit: 0 })
    ]);
    return emptyUserAccountRuntimeStore({ users, permissionRoles });
  } catch (error) {
    console.warn('[nb-clan] sqlite users runtime store fallback:', error?.message || error);
    throw userAccountStoreUnavailableError(error, '账号列表读取');
  }
}

export async function updateUserAccountsLogStore(mutator, reason = 'user_account_update') {
  if (!sqlitePrimaryMode()) return updateStore(mutator);
  return runStoreWriteTask(async () => {
    const [users, members, squads, squadMembers, sessions] = await Promise.all([
      getSqliteCollection('users', { limit: 0 }),
      getSqliteCollection('members', { limit: 0 }),
      getSqliteCollection('squads', { limit: 0 }),
      getSqliteCollection('squadMembers', { limit: 0 }),
      getSqliteCollection('sessions', { limit: 0 })
    ]);
    const store = {
      users,
      members,
      squads,
      squadMembers,
      sessions,
      logs: []
    };
    const before = snapshotStoreCollections(store, USER_ACCOUNT_COLLECTIONS);
    const result = await mutator(store);
    const { upserts, deletes, changed } = diffStoreCollections(before, store, USER_ACCOUNT_COLLECTIONS);
    if (!changed) return result;
    const createdLogs = upserts.logs || [];
    const patchResult = await writeSqliteStorePatch({
      reason,
      upserts,
      deletes,
      trims: createdLogs.length ? logTrimPatch() : {}
    });
    const deletedLogIds = trimmedLogIds(patchResult);
    const cacheDeletes = {
      ...deletes,
      ...(deletedLogIds.length ? { logs: [...(deletes.logs || []), ...deletedLogIds] } : {})
    };
    await patchStoreCache((cachedStore) => {
      applyStoreCollectionCachePatch(cachedStore, USER_ACCOUNT_COLLECTIONS, upserts, cacheDeletes);
    });
    return result;
  }).catch((error) => {
    if (error?.status) throw error;
    console.warn('[nb-clan] sqlite user account update fallback:', error?.message || error);
    throw userAccountStoreUnavailableError(error, '账号写入');
  });
}
