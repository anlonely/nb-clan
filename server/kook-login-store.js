import { createId, normalizeText, nowIso, patchStoreCache, readStore, runStoreWriteTask, updateStore } from './store.js';
import { getSqliteScalar, getSqliteCollection, getSqliteRecordsByJsonField, getSqliteRecordsByJsonFieldNoCase, writeSqliteStorePatch } from './storage/repository.js';
import { applyStoreCollectionCachePatch, diffStoreCollections, snapshotStoreCollections } from './storage/store-patch-diff.js';
import { sqlitePrimaryMode } from './storage/sqlite.js';
import { appendLog, logTrimPatch, trimmedLogIds } from './audit-logs.js';

const KOOK_FIELDS = ['kookId', 'kookUserId', 'kookAccountId'];
const error = (key, status = 409) => Object.assign(new Error(key), { errorKey: key, status });
const byKook = (member, id) => KOOK_FIELDS.some((field) => normalizeText(member[field], 80) === id);
const merge = (...groups) => [...new Map(groups.flat().map((item) => [item.id, item])).values()];

async function readBindingStore(kookId, steamId = '') {
  if (!sqlitePrimaryMode()) return readStore();
  const [kookMembers, steamMembers, kookUsers, steamUsers, usernames] = await Promise.all([
    Promise.all(KOOK_FIELDS.map((field) => getSqliteRecordsByJsonField('members', field, [kookId], { limit: 0 }))),
    getSqliteRecordsByJsonField('members', 'steamId', [steamId], { limit: 0 }),
    getSqliteRecordsByJsonField('users', 'kookId', [kookId], { limit: 0 }),
    getSqliteRecordsByJsonField('users', 'boundSteamId', [steamId], { limit: 0 }),
    steamId ? getSqliteRecordsByJsonFieldNoCase('users', 'username',
      Array.from({ length: 999 }, (_, i) => `kook_${kookId.slice(-8)}${i ? `_${i + 1}` : ''}`), { limit: 0 }) : []
  ]);
  return { users: merge(kookUsers, steamUsers, usernames), members: merge(...kookMembers, steamMembers),
    settings: {}, logs: [], squads: [], squadMembers: [], wipes: [], wipeParticipants: [],
    kdaRows: [], kdaSnapshots: [], memberProfiles: [], syncState: {} };
}

export async function readKookLoginBinding(kookId) {
  const id = normalizeText(kookId, 80);
  if (!id) throw error('thirdPartyLoginInvalidCallback', 400);
  const store = await readBindingStore(id);
  const users = store.users.filter((user) => user.kookId === id);
  const members = store.members.filter((member) => byKook(member, id));
  if (users.length > 1 || members.length > 1) throw error('kookBindingConflict');
  const user = users[0];
  const member = members[0];
  if (user?.roleAccessLock || member?.roleAccessLock) throw error('memberDeparted', 403);
  if (!user) return { steamId: member?.steamId || '', verified: false };
  const provider = user.loginProviders?.kook;
  if (!member || member.steamId !== user.boundSteamId || provider?.id !== id ||
      provider?.verifiedSteamId !== user.boundSteamId || !provider?.steamVerifiedAt) {
    throw error('kookBindingConflict');
  }
  return { userId: user.id, steamId: user.boundSteamId, verified: true };
}

// All identity checks and writes run inside the same serialized store write task.
export async function bindKookSteamAccount(req, { profile, steamId, eligibility, steamProfile = {}, passwordHash, upsertLogin }) {
  const id = normalizeText(profile?.id, 80);
  if (!id || !/^7656\d{13}$/.test(steamId) || typeof upsertLogin !== 'function' || !eligibility?.roleIds?.length) {
    throw error('thirdPartyLoginInvalidCallback', 400);
  }
  function apply(store) {
    const ownMembers = store.members.filter((member) => byKook(member, id));
    const steamMembers = store.members.filter((member) => member.steamId === steamId);
    const ownUsers = store.users.filter((user) => user.kookId === id);
    const steamUsers = store.users.filter((user) => user.boundSteamId === steamId);
    if (ownMembers.length > 1 || steamMembers.length > 1 || ownUsers.length > 1 ||
        ownMembers.some((member) => member.steamId !== steamId) ||
        ownUsers.some((user) => user.boundSteamId !== steamId) ||
        steamUsers.some((user) => (user.kookId && user.kookId !== id) ||
          (user.loginProviders?.kook?.id && user.loginProviders.kook.id !== id))) {
      throw error('kookBindingConflict');
    }
    let member = steamMembers[0];
    if (member && KOOK_FIELDS.some((field) => normalizeText(member[field], 80) && normalizeText(member[field], 80) !== id)) {
      throw error('kookBindingConflict');
    }
    const now = nowIso();
    const createdMember = !member;
    if (!member) {
      member = { id: createId('member'), steamId, rawInput: steamId,
        customName: '', steamNickname: steamProfile.nickname || '', avatar: steamProfile.avatar || '',
        discordId: '', wechatId: '', wechatUserId: '', phone: '', notes: '', specialty: [],
        battlemetricsId: '', memberStatus: 'active', createdAt: now, updatedAt: now };
      store.members.push(member);
    }
    member.kookId = id;
    member.kookName = normalizeText(profile.username, 120);
    member.kookBoundAt ||= now;
    const user = upsertLogin(store, req, { provider: 'kook', member,
      identity: { id, kookId: id, username: member.kookName, verifiedSteamId: steamId,
        steamVerifiedAt: now, guildId: eligibility.guildId, roleIds: eligibility.roleIds, roleVerifiedAt: now },
      passwordHash });
    if (ownUsers.length && ownUsers[0].id !== user.id) throw error('kookBindingConflict');
    user.kookId = id;
    if (createdMember) member.invitedByUserId = user.id;
    appendLog(store, req, 'kook_steam_bind', 'KOOK 登录确认 Steam 绑定', {
      targetId: user.id, steamId, metadata: { memberId: member.id, createdMember, guildId: eligibility.guildId, roleIds: eligibility.roleIds }
    });
    return user.id;
  }
  if (!sqlitePrimaryMode()) {
    let userId;
    await updateStore((store) => { userId = apply(store); });
    return userId;
  }
  return runStoreWriteTask(async () => {
    const store = await readBindingStore(id, steamId);
    store.settings = await getSqliteScalar('settings') || {};
    store.permissionRoles = await getSqliteCollection('permissionRoles', { limit: 0 });
    const names = ['users', 'members', 'logs'];
    const before = snapshotStoreCollections(store, names);
    const userId = apply(store);
    const { upserts, deletes } = diffStoreCollections(before, store, names);
    const result = await writeSqliteStorePatch({ reason: 'kook_steam_bind', upserts, deletes, trims: logTrimPatch() });
    const removedLogs = trimmedLogIds(result);
    await patchStoreCache((cached) => applyStoreCollectionCachePatch(cached, names, upserts,
      { ...deletes, ...(removedLogs.length ? { logs: [...(deletes.logs || []), ...removedLogs] } : {}) }));
    return userId;
  });
}
