import {
  normalizeText,
  nowIso,
  patchStoreCache,
  readStore,
  runStoreWriteTask,
  updateStore
} from './store.js';
import {
  getSqliteCollection,
  getSqliteRecord,
  getSqliteRecordsByJsonField,
  getSqliteRecordsByJsonFieldNoCase,
  writeSqliteStorePatch
} from './storage/repository.js';
import {
  applyStoreCollectionCachePatch,
  diffStoreCollections,
  replaceCachedRecord,
  snapshotStoreCollections
} from './storage/store-patch-diff.js';
import { sqlitePrimaryMode } from './storage/sqlite.js';
import {
  appendLog,
  applyCachedLogPatch,
  createLogEntry,
  logTrimPatch,
  trimmedLogIds
} from './audit-logs.js';

function emptyAuthStore({ users = [], permissionRoles = [] } = {}) {
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

function authLoginRuntimeUnavailableError(error) {
  return Object.assign(new Error('登录账号读取暂不可用，请稍后重试'), {
    status: 503,
    code: 'auth_login_runtime_unavailable',
    cause: error
  });
}

function thirdPartyLoginWriteUnavailableError(error) {
  return Object.assign(new Error('第三方登录写入暂不可用，请稍后重试'), {
    status: 503,
    code: 'third_party_login_write_unavailable',
    errorKey: 'thirdPartyLoginVerifyFailed',
    cause: error
  });
}

function memberForSteamLogin(store, steamId) {
  const normalizedSteamId = normalizeText(steamId, 80);
  if (!normalizedSteamId) return null;
  return (store.members || []).find((member) => member.steamId === normalizedSteamId) || null;
}

function memberForDiscordLogin(store, discordId, discordIdMaxLength = 32) {
  const normalizedDiscordId = normalizeText(discordId, discordIdMaxLength);
  if (!normalizedDiscordId) return null;
  return (store.members || []).find((member) => normalizeText(member.discordId, discordIdMaxLength) === normalizedDiscordId) || null;
}

function mergeRecordsById(...recordGroups) {
  const recordsById = new Map();
  let fallbackIndex = 0;
  for (const group of recordGroups) {
    for (const record of Array.isArray(group) ? group : [group]) {
      if (!record || typeof record !== 'object') continue;
      const id = normalizeText(record.id, 160) || `fallback:${fallbackIndex++}`;
      if (!recordsById.has(id)) recordsById.set(id, record);
    }
  }
  return [...recordsById.values()];
}

function thirdPartyLoginUsernameCandidates(provider, id) {
  const normalizedProvider = normalizeText(provider, 40);
  const suffix = String(id || '').slice(-8) || '';
  if (!normalizedProvider || !suffix) return [];
  const base = `${normalizedProvider}_${suffix}`;
  const candidates = [base];
  for (let index = 2; index < 1000; index += 1) {
    candidates.push(`${base}_${index}`);
  }
  return candidates;
}

function thirdPartyLoginEmptyWriteStore({ users = [], members = [] } = {}) {
  return {
    users,
    members,
    logs: [],
    squads: [],
    squadMembers: [],
    settings: {},
    wipes: [],
    wipeParticipants: [],
    kdaRows: [],
    kdaSnapshots: [],
    memberProfiles: [],
    syncState: {}
  };
}

async function readThirdPartyLoginScopedWriteStore({
  normalizedProvider,
  memberLookup = {},
  identity = {},
  discordIdMaxLength = 32
} = {}) {
  const memberLookupValues = normalizedProvider === 'discord'
    ? [normalizeText(memberLookup.discordId || identity.discordId || identity.id, discordIdMaxLength)].filter(Boolean)
    : [normalizeText(memberLookup.steamId || identity.steamId || identity.id, 80)].filter(Boolean);
  const members = normalizedProvider === 'discord'
    ? await getSqliteRecordsByJsonField('members', 'discordId', memberLookupValues, { limit: 0 })
    : await getSqliteRecordsByJsonField('members', 'steamId', memberLookupValues, { limit: 0 });
  const member = normalizedProvider === 'discord'
    ? memberForDiscordLogin({ members }, memberLookup.discordId || identity.discordId || identity.id, discordIdMaxLength)
    : memberForSteamLogin({ members }, memberLookup.steamId || identity.steamId || identity.id);
  if (!member) return thirdPartyLoginEmptyWriteStore({ members });

  const steamId = normalizeText(member.steamId, 80);
  const boundUsers = steamId
    ? await getSqliteRecordsByJsonField('users', 'boundSteamId', [steamId], { limit: 0 })
    : [];
  const usernameConflictUsers = boundUsers.length
    ? []
    : await getSqliteRecordsByJsonFieldNoCase(
      'users',
      'username',
      thirdPartyLoginUsernameCandidates(normalizedProvider, identity.id || member.steamId),
      { limit: 0 }
    );
  return thirdPartyLoginEmptyWriteStore({
    users: mergeRecordsById(boundUsers, usernameConflictUsers),
    members
  });
}

export async function readAuthLoginRuntimeStore(username = '') {
  if (!sqlitePrimaryMode()) return readStore();
  try {
    const normalizedUsername = normalizeText(username, 32);
    if (!normalizedUsername) return emptyAuthStore();
    const [users, permissionRoles] = await Promise.all([
      getSqliteRecordsByJsonFieldNoCase('users', 'username', [normalizedUsername], { limit: 0 }),
      getSqliteCollection('permissionRoles', { limit: 0 })
    ]);
    return emptyAuthStore({ users, permissionRoles });
  } catch (error) {
    console.warn('[nb-clan] sqlite auth login runtime store fallback:', error?.message || error);
    throw authLoginRuntimeUnavailableError(error);
  }
}

export async function upsertThirdPartyMemberLoginWriteStore(req, {
  provider,
  memberLookup = {},
  identity = {},
  profile = {},
  passwordHash = '',
  discordIdMaxLength = 32,
  upsertLogin
} = {}) {
  const normalizedProvider = normalizeText(provider, 40);
  if (typeof upsertLogin !== 'function') {
    throw Object.assign(new Error('登录账号初始化失败'), { status: 500, errorKey: 'thirdPartyLoginVerifyFailed' });
  }
  const applyLogin = (store) => {
    const member = normalizedProvider === 'discord'
      ? memberForDiscordLogin(store, memberLookup.discordId || identity.discordId || identity.id, discordIdMaxLength)
      : memberForSteamLogin(store, memberLookup.steamId || identity.steamId || identity.id);
    if (!member) {
      throw Object.assign(new Error('未匹配到成员'), { status: 404, errorKey: 'thirdPartyLoginMemberNotFound' });
    }
    return upsertLogin(store, req, {
      provider: normalizedProvider,
      member,
      identity,
      profile,
      passwordHash
    });
  };

  if (!sqlitePrimaryMode()) {
    let loginUserId = '';
    await updateStore((store) => {
      store.settings ||= {};
      store.settings.thirdPartyLogin ||= {};
      store.settings.thirdPartyLogin[normalizedProvider] ||= {};
      loginUserId = applyLogin(store).id;
    });
    return loginUserId;
  }

  try {
    return await runStoreWriteTask(async () => {
      const store = await readThirdPartyLoginScopedWriteStore({
        normalizedProvider,
        memberLookup,
        identity,
        discordIdMaxLength
      });
      const collectionNames = ['users', 'members', 'logs'];
      const before = snapshotStoreCollections(store, collectionNames);
      const user = applyLogin(store);
      const { upserts, deletes } = diffStoreCollections(before, store, collectionNames);
      const patchResult = await writeSqliteStorePatch({
        reason: `${normalizedProvider}_login`,
        upserts,
        deletes,
        trims: logTrimPatch()
      });
      const deletedLogIds = trimmedLogIds(patchResult);
      const cacheDeletes = {
        ...deletes,
        ...(deletedLogIds.length ? { logs: [...(deletes.logs || []), ...deletedLogIds] } : {})
      };
      await patchStoreCache((cachedStore) => {
        applyStoreCollectionCachePatch(cachedStore, collectionNames, upserts, cacheDeletes);
      });
      return user.id;
    });
  } catch (error) {
    if (error?.errorKey) throw error;
    console.warn('[nb-clan] sqlite third-party login write unavailable:', error?.message || error);
    throw thirdPartyLoginWriteUnavailableError(error);
  }
}

export async function updateCurrentUserPasswordStore(req, passwordHash) {
  const userId = normalizeText(req?.user?.id, 120);
  const currentSessionId = normalizeText(req?.sessionId, 120);
  if (!sqlitePrimaryMode()) {
    return updateStore((nextStore) => {
      const index = nextStore.users.findIndex((item) => item.id === userId);
      if (index === -1) throw Object.assign(new Error('账号不存在'), { status: 404 });
      nextStore.users[index] = { ...nextStore.users[index], passwordHash, updatedAt: nowIso() };
      nextStore.sessions = (nextStore.sessions || []).filter((session) => (
        session.userId !== userId || (currentSessionId && session.id === currentSessionId)
      ));
      appendLog(nextStore, req, 'password_change', '修改个人密码');
    });
  }
  return runStoreWriteTask(async () => {
    const [user, sessions] = await Promise.all([
      getSqliteRecord('users', userId),
      getSqliteRecordsByJsonField('sessions', 'userId', [userId], { limit: 0 })
    ]);
    if (!user) throw Object.assign(new Error('账号不存在'), { status: 404 });
    const updatedUser = { ...user, passwordHash, updatedAt: nowIso() };
    const deletedSessionIds = sessions
      .filter((session) => !currentSessionId || session.id !== currentSessionId)
      .map((session) => session.id)
      .filter(Boolean);
    const log = createLogEntry(req, 'password_change', '修改个人密码');
    const patchResult = await writeSqliteStorePatch({
      reason: 'password_change',
      upserts: {
        users: [updatedUser],
        logs: [log]
      },
      deletes: deletedSessionIds.length ? { sessions: deletedSessionIds } : {},
      trims: logTrimPatch()
    });
    await patchStoreCache((store) => {
      store.users ||= [];
      replaceCachedRecord(store.users, updatedUser);
      if (deletedSessionIds.length) {
        const deleted = new Set(deletedSessionIds);
        store.sessions = (store.sessions || []).filter((session) => !deleted.has(session.id));
      }
      applyCachedLogPatch(store, [log], trimmedLogIds(patchResult));
    });
  });
}
