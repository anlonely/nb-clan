import { normalizeText, patchStoreCache, readStore, runStoreWriteTask, updateStore } from './store.js';
import {
  getSqliteCollection,
  getSqliteRecord,
  getSqliteRecordsByJsonArrayField,
  getSqliteRecordsByJsonField,
  getSqliteRecordsByJsonFieldTextContainsNoCase,
  getSqliteRecordsByJsonFields,
  getSqliteRecordsWhereJsonFieldMissing,
  getSqliteRecordsWhereJsonFieldPresent,
  getSqliteRecordCounts,
  getSqliteScalar,
  countSqliteRecordsByJsonField,
  countSqliteMemberSearchRecordsForQuery,
  countSqliteMemberVitalVipRecordsForTypes,
  countSqliteRecordsWithoutJsonRelation,
  getSqliteMemberSearchRecords,
  getSqliteMemberVitalVipRecords,
  getSqliteRecordsWithoutJsonRelation,
  writeSqliteStorePatch
} from './storage/repository.js';
import {
  applyStoreCollectionCachePatch,
  diffStoreCollections,
  snapshotStoreCollections
} from './storage/store-patch-diff.js';
import { sqliteEnabled, sqlitePrimaryMode } from './storage/sqlite.js';
import {
  getSqliteRecordsByJsonFieldInChunks,
  mergeRecordsById,
  readSqliteRecordsByIds,
  uniqueNormalizedTexts
} from './sqlite-read-utils.js';
import { readRuntimeSyncJobs } from './sync-job-store.js';
import {
  isAdmin,
  isLeader,
  isSquadLeader,
  squadLeaderIds
} from './permissions.js';
import { memberDisplayName } from './steam.js';

const DISCORD_ID_MAX_LENGTH = 32;

function isWechatSystemId(value) {
  return /^wechat_user_[a-z0-9-]+$/i.test(normalizeText(value, 120));
}

function activeSquads(store) {
  return (store.squads || []).filter((squad) => !squad.archivedAt);
}

function leaderSquads(store, user) {
  return activeSquads(store).filter((squad) => isSquadLeader(user, squad));
}

async function readSquadsByLeaderUserIds(userIds = []) {
  const leaderUserIds = uniqueNormalizedTexts(userIds, 120);
  if (!leaderUserIds.length) return [];
  const [byPrimaryLeader, byLeaderArray] = await Promise.all([
    getSqliteRecordsByJsonField('squads', 'leaderUserId', leaderUserIds, { limit: 0 }),
    getSqliteRecordsByJsonArrayField('squads', 'leaderUserIds', leaderUserIds, { limit: 0 })
  ]);
  return mergeRecordsById(byPrimaryLeader, byLeaderArray);
}

async function readSquadsWithAnyLeaderUserId() {
  const [byPrimaryLeader, byLeaderArray] = await Promise.all([
    getSqliteRecordsWhereJsonFieldPresent('squads', 'leaderUserId', { limit: 0 }),
    getSqliteRecordsWhereJsonFieldPresent('squads', 'leaderUserIds', { limit: 0 })
  ]);
  return mergeRecordsById(byPrimaryLeader, byLeaderArray)
    .filter((squad) => squadLeaderIds(squad).length);
}

function normalizeMemberListVitalVipType(value) {
  const raw = normalizeText(value, 40).toLowerCase();
  if (raw === 'queue' || raw === 'skip' || raw === 'no_queue' || raw === 'queue-skip') return 'queue_skip';
  if (raw === 'vip' || raw === 'priority_queue') return 'priority';
  return ['none', 'priority', 'queue_skip'].includes(raw) ? raw : 'none';
}

export function discordMemberForUserId(store, discordUserId) {
  const normalizedDiscordId = normalizeText(discordUserId, DISCORD_ID_MAX_LENGTH);
  if (!normalizedDiscordId) return null;
  return (store.members || []).find((member) => normalizeText(member.discordId, DISCORD_ID_MAX_LENGTH) === normalizedDiscordId) || null;
}

export function memberRuntimeStoreShell({
  users = [],
  members = [],
  squads = [],
  squadMembers = [],
  wipes = [],
  permissionRoles = [],
  settings = {}
} = {}) {
  return {
    users,
    members,
    squads,
    squadMembers,
    wipes,
    permissionRoles,
    wipeParticipants: [],
    kdaRows: [],
    kdaSnapshots: [],
    memberProfiles: [],
    wipeSettlements: [],
    uploads: [],
    discordMemberApplications: [],
    wechatUsers: [],
    settings,
    syncState: {}
  };
}

function memberPartialStore(error, source, overrides = {}) {
  return {
    memberPartial: true,
    memberReadSource: source,
    memberReadError: normalizeText(error?.message || error, 240),
    ...overrides
  };
}

function memberPartialRuntimeStore(error, source, overrides = {}) {
  return {
    ...memberRuntimeStoreShell(overrides),
    memberPartial: true,
    memberReadSource: source,
    memberReadError: normalizeText(error?.message || error, 240)
  };
}

function memberStoreReadUnavailableError(error, label = '成员数据读取') {
  return Object.assign(new Error(`${label}暂不可用，请稍后重试`), {
    status: 503,
    code: 'member_store_read_unavailable',
    skipApiErrorLog: true,
    cause: error
  });
}

function memberProfileSyncCancelReadUnavailableError(error) {
  return Object.assign(new Error('成员资料同步取消状态读取暂不可用，请稍后重试'), {
    status: 503,
    code: 'member_profile_sync_cancel_read_unavailable',
    errorKey: 'member_profile_sync_cancel_read_unavailable',
    skipApiErrorLog: true,
    cause: error
  });
}

function memberBaseScopedWriteUnavailableError() {
  return Object.assign(new Error('成员基础写入缺少 scoped 范围，已阻止全量成员集合读取'), {
    status: 503,
    code: 'member_base_scoped_write_unavailable',
    skipApiErrorLog: true
  });
}

export async function readDiscordMemberForUserId(discordUserId) {
  const normalizedDiscordId = normalizeText(discordUserId, DISCORD_ID_MAX_LENGTH);
  if (!normalizedDiscordId) return null;
  if (!sqlitePrimaryMode()) {
    return discordMemberForUserId(await readStore(), normalizedDiscordId);
  }
  try {
    const members = await getSqliteRecordsByJsonField('members', 'discordId', [normalizedDiscordId], { limit: 0 });
    return members.find((member) => normalizeText(member.discordId, DISCORD_ID_MAX_LENGTH) === normalizedDiscordId) || null;
  } catch (error) {
    console.warn('[nb-clan] sqlite discord member lookup fallback:', error?.message || error);
    return null;
  }
}

export async function readMemberRuntimeBaseStore() {
  if (!sqlitePrimaryMode()) return readStore();
  try {
    const [
      users,
      members,
      squads,
      squadMembers,
      wipes,
      permissionRoles
    ] = await Promise.all([
      getSqliteCollection('users', { limit: 0 }),
      getSqliteCollection('members', { limit: 0 }),
      getSqliteCollection('squads', { limit: 0 }),
      getSqliteCollection('squadMembers', { limit: 0 }),
      getSqliteCollection('wipes', { limit: 0 }),
      getSqliteCollection('permissionRoles', { limit: 0 })
    ]);
    return {
      users,
      members,
      squads,
      squadMembers,
      wipes,
      permissionRoles,
      wipeParticipants: [],
      kdaRows: [],
      kdaSnapshots: [],
      memberProfiles: [],
      wipeSettlements: [],
      uploads: [],
      discordMemberApplications: [],
      wechatUsers: [],
      settings: {},
      syncState: {}
    };
  } catch (error) {
    console.warn('[nb-clan] sqlite member runtime base fallback:', error?.message || error);
    throw memberStoreReadUnavailableError(error, '成员基础读取');
  }
}

export async function readMemberListRuntimeStore(options = {}) {
  if (!sqlitePrimaryMode()) return readStore();
  try {
    const [
      members,
      squads,
      squadMembers,
      activeWipes,
      closedWipes,
      permissionRoles
    ] = await Promise.all([
      getSqliteCollection('members', { limit: 0 }),
      getSqliteCollection('squads', { limit: 0 }),
      getSqliteCollection('squadMembers', { limit: 0 }),
      getSqliteRecordsByJsonField('wipes', 'status', ['active'], { limit: 0 }),
      getSqliteRecordsByJsonField('wipes', 'status', ['closed'], { limit: 0 }),
      options.includePermissionRoles ? getSqliteCollection('permissionRoles', { limit: 0 }) : Promise.resolve([])
    ]);
    return memberRuntimeStoreShell({
      members,
      squads,
      squadMembers,
      wipes: mergeRecordsById(activeWipes, closedWipes),
      permissionRoles
    });
  } catch (error) {
    console.warn('[nb-clan] sqlite member list runtime fallback:', error?.message || error);
    return memberPartialRuntimeStore(error, 'member_list_runtime');
  }
}

export async function readDiscordMembershipAuditStore() {
  if (!sqlitePrimaryMode()) return readStore();
  try {
    const [
      settings,
      users,
      members,
      squads,
      squadMembers,
      permissionRoles
    ] = await Promise.all([
      getSqliteScalar('settings'),
      getSqliteCollection('users', { limit: 0 }),
      getSqliteCollection('members', { limit: 0 }),
      getSqliteCollection('squads', { limit: 0 }),
      getSqliteCollection('squadMembers', { limit: 0 }),
      getSqliteCollection('permissionRoles', { limit: 0 })
    ]);
    return {
      settings: settings || {},
      users,
      members,
      squads,
      squadMembers,
      permissionRoles,
      wipes: [],
      wipeParticipants: [],
      kdaRows: [],
      kdaSnapshots: [],
      memberProfiles: [],
      discordMemberApplications: [],
      accountAlertDismissals: [],
      syncState: {}
    };
  } catch (error) {
    console.warn('[nb-clan] sqlite discord membership audit fallback:', error?.message || error);
    throw memberStoreReadUnavailableError(error, 'Discord 成员审计读取');
  }
}

export async function readMemberOptionsRuntimeStore() {
  if (!sqlitePrimaryMode()) return readStore();
  try {
    const [
      users,
      squads,
      squadMembers,
      wipes,
      permissionRoles
    ] = await Promise.all([
      getSqliteCollection('users', { limit: 0 }),
      getSqliteCollection('squads', { limit: 0 }),
      getSqliteCollection('squadMembers', { limit: 0 }),
      getSqliteRecordsByJsonField('wipes', 'status', ['active'], { limit: 0 }),
      getSqliteCollection('permissionRoles', { limit: 0 })
    ]);
    const wipeIds = uniqueNormalizedTexts(wipes.map((wipe) => wipe.id), 120);
    const wipeParticipants = wipeIds.length
      ? await getSqliteRecordsByJsonField('wipeParticipants', 'wipeId', wipeIds, { limit: 0 })
      : [];
    return {
      users,
      members: [],
      squads,
      squadMembers,
      wipes,
      wipeParticipants,
      permissionRoles,
      settings: {},
      syncState: {}
    };
  } catch (error) {
    console.warn('[nb-clan] sqlite member options fallback:', error?.message || error);
    return memberPartialRuntimeStore(error, 'member_options_runtime');
  }
}

export async function hydrateMemberScopedRuntimeStore(store, memberIds = [], options = {}) {
  if (!sqlitePrimaryMode()) return store;
  const ids = uniqueNormalizedTexts(memberIds, 120);
  if (!ids.length) {
    store.memberProfiles = [];
    store.kdaRows = [];
    if (options.includeKdaSnapshots) store.kdaSnapshots = [];
    store.wipeParticipants = [];
    if (options.includeWechatUsers) store.wechatUsers = [];
    if (options.includeDiscordApplications) store.discordMemberApplications = [];
    return store;
  }
  const tasks = {
    memberProfiles: getSqliteRecordsByJsonField('memberProfiles', 'memberId', ids, { limit: 0 }),
    kdaRows: getSqliteRecordsByJsonField('kdaRows', 'memberId', ids, { limit: 0 }),
    squadMembers: getSqliteRecordsByJsonField('squadMembers', 'memberId', ids, { limit: 0 }),
    wipeParticipants: getSqliteRecordsByJsonField('wipeParticipants', 'memberId', ids, { limit: 0 })
  };
  if (options.includeKdaSnapshots) {
    tasks.kdaSnapshots = getSqliteRecordsByJsonField('kdaSnapshots', 'memberId', ids, { limit: 0 });
  }
  if (options.includeWechatUsers) {
    tasks.wechatUsers = getSqliteRecordsByJsonField('wechatUsers', 'memberId', ids, { limit: 0 });
  }
  if (options.includeDiscordApplications) {
    const scopedMembers = (store.members || []).filter((member) => ids.includes(member.id));
    const discordIds = uniqueNormalizedTexts(scopedMembers.map((member) => member.discordId), DISCORD_ID_MAX_LENGTH);
    const steamIds = uniqueNormalizedTexts(scopedMembers.map((member) => member.steamId), 80);
    tasks.discordMemberApplications = Promise.all([
      discordIds.length
        ? getSqliteRecordsByJsonField('discordMemberApplications', 'discordUserId', discordIds, { limit: 0 })
        : Promise.resolve([]),
      ids.length
        ? getSqliteRecordsByJsonField('discordMemberApplications', 'memberId', ids, { limit: 0 })
        : Promise.resolve([]),
      steamIds.length
        ? getSqliteRecordsByJsonField('discordMemberApplications', 'steamId', steamIds, { limit: 0 })
        : Promise.resolve([])
    ]).then((sources) => mergeRecordsById(...sources));
  }
  const results = Object.fromEntries(
    await Promise.all(Object.entries(tasks).map(async ([key, task]) => [key, await task]))
  );
  const {
    memberProfiles = [],
    kdaRows = [],
    squadMembers = [],
    wipeParticipants = [],
    kdaSnapshots = [],
    wechatUsers = [],
    discordMemberApplications = []
  } = results;
  store.memberProfiles = memberProfiles;
  store.kdaRows = kdaRows;
  store.squadMembers = mergeRecordsById(store.squadMembers || [], squadMembers);
  store.wipeParticipants = wipeParticipants;
  if (options.includeKdaSnapshots) store.kdaSnapshots = kdaSnapshots;
  if (options.includeWechatUsers) store.wechatUsers = wechatUsers;
  if (options.includeDiscordApplications) store.discordMemberApplications = discordMemberApplications;
  return store;
}

export async function hydrateMemberListPageRuntimeStore(store, members = [], options = {}) {
  const pageMembers = (Array.isArray(members) ? members : [members]).filter(Boolean);
  const memberIds = uniqueNormalizedTexts(pageMembers.map((member) => member.id), 120);
  await hydrateMemberScopedRuntimeStore(store, memberIds, options);
  const pageSquadIds = new Set(uniqueNormalizedTexts(
    (store.squadMembers || [])
      .filter((relation) => memberIds.includes(normalizeText(relation.memberId, 120)))
      .map((relation) => relation.squadId),
    120
  ));
  const existingSquadIds = new Set(uniqueNormalizedTexts((store.squads || []).map((squad) => squad.id), 120));
  const missingSquadIds = [...pageSquadIds].filter((squadId) => !existingSquadIds.has(squadId));
  if (missingSquadIds.length) {
    const squads = await readSqliteRecordsByIds('squads', missingSquadIds);
    store.squads = mergeRecordsById(store.squads || [], squads);
  }
  const relatedUserIds = new Set(uniqueNormalizedTexts(
    pageMembers
      .map((member) => member.invitedByUserId)
      .filter((value) => !normalizeText(value, 120).startsWith('discord:')),
    120
  ));
  for (const squad of store.squads || []) {
    if (!pageSquadIds.has(normalizeText(squad.id, 120))) continue;
    for (const leaderId of squadLeaderIds(squad)) {
      const normalizedLeaderId = normalizeText(leaderId, 120);
      if (normalizedLeaderId) relatedUserIds.add(normalizedLeaderId);
    }
  }
  const users = relatedUserIds.size ? await readSqliteRecordsByIds('users', [...relatedUserIds]) : [];
  store.users = mergeRecordsById(store.users || [], users);
  return store;
}

export async function hydrateMemberListFilterContextRuntimeStore(store, members = []) {
  if (!sqlitePrimaryMode()) return store;
  const filterMembers = (Array.isArray(members) ? members : [members]).filter(Boolean);
  const memberIds = uniqueNormalizedTexts(filterMembers.map((member) => member.id), 120);
  if (!memberIds.length) {
    store.squadMembers = [];
    return store;
  }
  const squadMembers = await getSqliteRecordsByJsonField('squadMembers', 'memberId', memberIds, { limit: 0 });
  store.squadMembers = mergeRecordsById(store.squadMembers || [], squadMembers);
  const squadIds = uniqueNormalizedTexts((store.squadMembers || [])
    .filter((relation) => memberIds.includes(normalizeText(relation.memberId, 120)))
    .map((relation) => relation.squadId), 120);
  const existingSquadIds = new Set(uniqueNormalizedTexts((store.squads || []).map((squad) => squad.id), 120));
  const missingSquadIds = squadIds.filter((squadId) => !existingSquadIds.has(squadId));
  if (missingSquadIds.length) {
    const squads = await readSqliteRecordsByIds('squads', missingSquadIds);
    store.squads = mergeRecordsById(store.squads || [], squads);
  }
  return store;
}

export async function readMemberListPageRuntimeStore(options = {}) {
  if (!sqlitePrimaryMode()) return null;
  const limit = Math.max(1, Math.min(100, Number(options.limit || 5)));
  const offset = Math.max(0, Number(options.offset || 0));
  try {
    const [
      members,
      counts,
      activeWipes,
      closedWipes,
      permissionRoles
    ] = await Promise.all([
      getSqliteCollection('members', { limit, offset }),
      getSqliteRecordCounts(),
      getSqliteRecordsByJsonField('wipes', 'status', ['active'], { limit: 0 }),
      getSqliteRecordsByJsonField('wipes', 'status', ['closed'], { limit: 0 }),
      options.includePermissionRoles ? getSqliteCollection('permissionRoles', { limit: 0 }) : Promise.resolve([])
    ]);
    const store = memberRuntimeStoreShell({
      members,
      wipes: mergeRecordsById(activeWipes, closedWipes),
      permissionRoles
    });
    await hydrateMemberListPageRuntimeStore(store, members, options);
    return {
      store,
      total: Number(counts.members || 0),
      offset,
      limit
    };
  } catch (error) {
    console.warn('[nb-clan] sqlite member list page fallback:', error?.message || error);
    return null;
  }
}

export async function readMemberListSquadPageRuntimeStore(squadId, options = {}) {
  if (!sqlitePrimaryMode()) return null;
  const normalizedSquadId = normalizeText(squadId, 120);
  if (!normalizedSquadId || normalizedSquadId === '__none__' || normalizedSquadId === '__unassigned') return null;
  const limit = Math.max(1, Math.min(100, Number(options.limit || 5)));
  const offset = Math.max(0, Number(options.offset || 0));
  try {
    const [
      squad,
      squadMembers,
      activeWipes,
      closedWipes,
      permissionRoles
    ] = await Promise.all([
      getSqliteRecord('squads', normalizedSquadId),
      getSqliteRecordsByJsonField('squadMembers', 'squadId', [normalizedSquadId], { limit: 0 }),
      getSqliteRecordsByJsonField('wipes', 'status', ['active'], { limit: 0 }),
      getSqliteRecordsByJsonField('wipes', 'status', ['closed'], { limit: 0 }),
      options.includePermissionRoles ? getSqliteCollection('permissionRoles', { limit: 0 }) : Promise.resolve([])
    ]);
    const baseStore = memberRuntimeStoreShell({
      squads: squad ? [squad] : [],
      wipes: mergeRecordsById(activeWipes, closedWipes),
      permissionRoles
    });
    if (!squad) {
      return {
        store: baseStore,
        total: 0,
        offset,
        limit
      };
    }
    const memberIds = uniqueNormalizedTexts(squadMembers.map((relation) => relation.memberId), 120);
    if (memberIds.length > 1000) return null;
    const members = memberIds.length ? await readSqliteRecordsByIds('members', memberIds) : [];
    const pageMembers = members.slice(offset, offset + limit);
    const pageMemberIds = new Set(uniqueNormalizedTexts(pageMembers.map((member) => member.id), 120));
    const pageSquadMembers = squadMembers.filter((relation) => pageMemberIds.has(normalizeText(relation.memberId, 120)));
    baseStore.members = pageMembers;
    await hydrateMemberListPageRuntimeStore(baseStore, pageMembers, options);
    baseStore.squadMembers = mergeRecordsById(baseStore.squadMembers || [], pageSquadMembers);
    return {
      store: baseStore,
      total: members.length,
      offset,
      limit
    };
  } catch (error) {
    console.warn('[nb-clan] sqlite member list squad page fallback:', error?.message || error);
    return null;
  }
}

export async function readMemberListSquadCandidateRuntimeStore(squadId, options = {}) {
  if (!sqlitePrimaryMode()) return null;
  const normalizedSquadId = normalizeText(squadId, 120);
  if (!normalizedSquadId || normalizedSquadId === '__none__' || normalizedSquadId === '__unassigned') return null;
  try {
    const [
      squad,
      squadMembers,
      activeWipes,
      closedWipes,
      permissionRoles
    ] = await Promise.all([
      getSqliteRecord('squads', normalizedSquadId),
      getSqliteRecordsByJsonField('squadMembers', 'squadId', [normalizedSquadId], { limit: 0 }),
      getSqliteRecordsByJsonField('wipes', 'status', ['active'], { limit: 0 }),
      getSqliteRecordsByJsonField('wipes', 'status', ['closed'], { limit: 0 }),
      options.includePermissionRoles ? getSqliteCollection('permissionRoles', { limit: 0 }) : Promise.resolve([])
    ]);
    const baseStore = memberRuntimeStoreShell({
      squads: squad ? [squad] : [],
      wipes: mergeRecordsById(activeWipes, closedWipes),
      permissionRoles
    });
    if (!squad) return baseStore;
    const memberIds = uniqueNormalizedTexts(squadMembers.map((relation) => relation.memberId), 120);
    if (memberIds.length > 1000) return null;
    const members = memberIds.length ? await readSqliteRecordsByIds('members', memberIds) : [];
    const memberIdSet = new Set(uniqueNormalizedTexts(members.map((member) => member.id), 120));
    baseStore.members = members;
    baseStore.squadMembers = squadMembers.filter((relation) => memberIdSet.has(normalizeText(relation.memberId, 120)));
    return baseStore;
  } catch (error) {
    console.warn('[nb-clan] sqlite member list squad candidates fallback:', error?.message || error);
    return null;
  }
}

export async function readMemberListVitalVipPageRuntimeStore(vitalVipType, options = {}) {
  if (!sqlitePrimaryMode()) return null;
  const normalizedVitalVipType = normalizeMemberListVitalVipType(vitalVipType);
  if (!['priority', 'queue_skip'].includes(normalizedVitalVipType)) return null;
  const limit = Math.max(1, Math.min(100, Number(options.limit || 5)));
  const offset = Math.max(0, Number(options.offset || 0));
  try {
    const [
      members,
      counts,
      activeWipes,
      closedWipes,
      permissionRoles
    ] = await Promise.all([
      getSqliteMemberVitalVipRecords([normalizedVitalVipType], { limit, offset }),
      countSqliteMemberVitalVipRecordsForTypes([normalizedVitalVipType]),
      getSqliteRecordsByJsonField('wipes', 'status', ['active'], { limit: 0 }),
      getSqliteRecordsByJsonField('wipes', 'status', ['closed'], { limit: 0 }),
      options.includePermissionRoles ? getSqliteCollection('permissionRoles', { limit: 0 }) : Promise.resolve([])
    ]);
    const store = memberRuntimeStoreShell({
      members,
      wipes: mergeRecordsById(activeWipes, closedWipes),
      permissionRoles
    });
    await hydrateMemberListPageRuntimeStore(store, members, options);
    return {
      store,
      total: Number(counts?.[normalizedVitalVipType] || 0),
      offset,
      limit
    };
  } catch (error) {
    console.warn('[nb-clan] sqlite member list vital vip page fallback:', error?.message || error);
    return null;
  }
}

export async function readMemberListVitalVipNoneCandidateRuntimeStore(options = {}) {
  return readMemberListVitalVipCandidateRuntimeStore('none', options);
}

export async function readMemberListVitalVipCandidateRuntimeStore(vitalVipType, options = {}) {
  if (!sqlitePrimaryMode()) return null;
  const normalizedVitalVipType = normalizeMemberListVitalVipType(vitalVipType);
  try {
    const [
      members,
      activeWipes,
      closedWipes,
      permissionRoles
    ] = await Promise.all([
      getSqliteMemberVitalVipRecords([normalizedVitalVipType], { limit: 0 }),
      getSqliteRecordsByJsonField('wipes', 'status', ['active'], { limit: 0 }),
      getSqliteRecordsByJsonField('wipes', 'status', ['closed'], { limit: 0 }),
      options.includePermissionRoles ? getSqliteCollection('permissionRoles', { limit: 0 }) : Promise.resolve([])
    ]);
    return memberRuntimeStoreShell({
      members,
      wipes: mergeRecordsById(activeWipes, closedWipes),
      permissionRoles
    });
  } catch (error) {
    console.warn('[nb-clan] sqlite member list vital vip candidates fallback:', error?.message || error);
    return null;
  }
}

export async function readMemberListUnassignedPageRuntimeStore(options = {}) {
  if (!sqlitePrimaryMode()) return null;
  const limit = Math.max(1, Math.min(100, Number(options.limit || 5)));
  const offset = Math.max(0, Number(options.offset || 0));
  const relationOptions = {
    relationTargetCollection: 'squads',
    relationTargetField: 'squadId'
  };
  try {
    const [
      members,
      total,
      activeWipes,
      closedWipes,
      permissionRoles
    ] = await Promise.all([
      getSqliteRecordsWithoutJsonRelation('members', 'squadMembers', 'memberId', { ...relationOptions, limit, offset }),
      countSqliteRecordsWithoutJsonRelation('members', 'squadMembers', 'memberId', relationOptions),
      getSqliteRecordsByJsonField('wipes', 'status', ['active'], { limit: 0 }),
      getSqliteRecordsByJsonField('wipes', 'status', ['closed'], { limit: 0 }),
      options.includePermissionRoles ? getSqliteCollection('permissionRoles', { limit: 0 }) : Promise.resolve([])
    ]);
    const store = memberRuntimeStoreShell({
      members,
      wipes: mergeRecordsById(activeWipes, closedWipes),
      permissionRoles
    });
    await hydrateMemberListPageRuntimeStore(store, members, options);
    return {
      store,
      total: Number(total || 0),
      offset,
      limit
    };
  } catch (error) {
    console.warn('[nb-clan] sqlite member list unassigned page fallback:', error?.message || error);
    return null;
  }
}

export async function readMemberListUnassignedCandidateRuntimeStore(options = {}) {
  if (!sqlitePrimaryMode()) return null;
  const relationOptions = {
    relationTargetCollection: 'squads',
    relationTargetField: 'squadId'
  };
  try {
    const [
      members,
      activeWipes,
      closedWipes,
      permissionRoles
    ] = await Promise.all([
      getSqliteRecordsWithoutJsonRelation('members', 'squadMembers', 'memberId', { ...relationOptions, limit: 0 }),
      getSqliteRecordsByJsonField('wipes', 'status', ['active'], { limit: 0 }),
      getSqliteRecordsByJsonField('wipes', 'status', ['closed'], { limit: 0 }),
      options.includePermissionRoles ? getSqliteCollection('permissionRoles', { limit: 0 }) : Promise.resolve([])
    ]);
    return memberRuntimeStoreShell({
      members,
      wipes: mergeRecordsById(activeWipes, closedWipes),
      permissionRoles
    });
  } catch (error) {
    console.warn('[nb-clan] sqlite member list unassigned candidates fallback:', error?.message || error);
    return null;
  }
}

async function hydrateWechatDirectoryRuntimeStore(store, pageMembers = []) {
  const activeSquadsList = activeSquads(store);
  const activeSquadIds = uniqueNormalizedTexts(activeSquadsList.map((squad) => squad.id), 120);
  const leaderUserIds = uniqueNormalizedTexts(
    activeSquadsList.flatMap((squad) => squadLeaderIds(squad)),
    120
  );
  const pageSteamIds = uniqueNormalizedTexts(pageMembers.map((member) => member.steamId), 80);
  const [
    squadMemberCounts,
    unassignedCount,
    leaderUsers,
    boundSteamUsers,
    steamUsers
  ] = await Promise.all([
    activeSquadIds.length
      ? countSqliteRecordsByJsonField('squadMembers', 'squadId', activeSquadIds)
      : Promise.resolve({}),
    countSqliteRecordsWithoutJsonRelation('members', 'squadMembers', 'memberId', {
      relationTargetCollection: 'squads',
      relationTargetField: 'squadId'
    }),
    leaderUserIds.length ? readSqliteRecordsByIds('users', leaderUserIds) : Promise.resolve([]),
    pageSteamIds.length ? getSqliteRecordsByJsonField('users', 'boundSteamId', pageSteamIds, { limit: 0 }) : Promise.resolve([]),
    pageSteamIds.length ? getSqliteRecordsByJsonField('users', 'steamId', pageSteamIds, { limit: 0 }) : Promise.resolve([])
  ]);
  store.squadMemberCounts = squadMemberCounts || {};
  store.hasNoSquad = Number(unassignedCount || 0) > 0;
  store.users = mergeRecordsById(store.users || [], leaderUsers, boundSteamUsers, steamUsers);
  return store;
}

export async function readWechatDirectoryMemberPageRuntimeStore(options = {}) {
  if (!sqlitePrimaryMode()) return null;
  const limit = Math.max(1, Math.min(100, Number(options.limit || 5)));
  const offset = Math.max(0, Number(options.offset || 0));
  const squadId = normalizeText(options.squadId, 120);
  if (!squadId) return null;
  try {
    const [squads, activeWipes, closedWipes] = await Promise.all([
      getSqliteCollection('squads', { limit: 0 }),
      getSqliteRecordsByJsonField('wipes', 'status', ['active'], { limit: 0 }),
      getSqliteRecordsByJsonField('wipes', 'status', ['closed'], { limit: 0 })
    ]);
    const store = memberRuntimeStoreShell({
      squads,
      wipes: mergeRecordsById(activeWipes, closedWipes)
    });
    let members = [];
    if (squadId === '__none__' || squadId === '__unassigned') {
      members = await getSqliteRecordsWithoutJsonRelation('members', 'squadMembers', 'memberId', {
        relationTargetCollection: 'squads',
        relationTargetField: 'squadId',
        limit: 0
      });
    } else {
      const squad = squads.find((item) => normalizeText(item.id, 120) === squadId && !item.archivedAt);
      if (!squad) {
        await hydrateWechatDirectoryRuntimeStore(store, []);
        return { store, total: 0, offset, limit };
      }
      const squadMembers = await getSqliteRecordsByJsonField('squadMembers', 'squadId', [squadId], { limit: 0 });
      const memberIds = uniqueNormalizedTexts(squadMembers.map((relation) => relation.memberId), 120);
      if (memberIds.length > 1000) return null;
      members = memberIds.length ? await readSqliteRecordsByIds('members', memberIds) : [];
      store.squadMembers = squadMembers;
    }
    members.sort((left, right) => memberDisplayName(left).localeCompare(memberDisplayName(right)));
    const total = members.length;
    const pageMembers = members.slice(offset, offset + limit);
    store.members = pageMembers;
    await hydrateMemberListPageRuntimeStore(store, pageMembers, {
      includeWechatUsers: true,
      includeDiscordApplications: true
    });
    await hydrateWechatDirectoryRuntimeStore(store, pageMembers);
    return { store, total, offset, limit };
  } catch (error) {
    console.warn('[nb-clan] sqlite wechat member directory page fallback:', error?.message || error);
    throw memberStoreReadUnavailableError(error, '微信成员目录读取');
  }
}

export async function readMemberListSearchPageRuntimeStore(query, options = {}) {
  if (!sqlitePrimaryMode()) return null;
  const normalizedQuery = normalizeText(query, 120).toLowerCase();
  if (!normalizedQuery) return null;
  const limit = Math.max(1, Math.min(100, Number(options.limit || 5)));
  const offset = Math.max(0, Number(options.offset || 0));
  try {
    const [
      members,
      total,
      activeWipes,
      closedWipes,
      permissionRoles
    ] = await Promise.all([
      getSqliteMemberSearchRecords(normalizedQuery, { limit, offset }),
      countSqliteMemberSearchRecordsForQuery(normalizedQuery),
      getSqliteRecordsByJsonField('wipes', 'status', ['active'], { limit: 0 }),
      getSqliteRecordsByJsonField('wipes', 'status', ['closed'], { limit: 0 }),
      options.includePermissionRoles ? getSqliteCollection('permissionRoles', { limit: 0 }) : Promise.resolve([])
    ]);
    const store = memberRuntimeStoreShell({
      members,
      wipes: mergeRecordsById(activeWipes, closedWipes),
      permissionRoles
    });
    await hydrateMemberListPageRuntimeStore(store, members, options);
    return {
      store,
      total: Number(total || 0),
      offset,
      limit
    };
  } catch (error) {
    console.warn('[nb-clan] sqlite member list search page fallback:', error?.message || error);
    return null;
  }
}

export async function readMemberListSpecialtyCandidateRuntimeStore(specialtyValues = [], options = {}) {
  if (!sqlitePrimaryMode()) return null;
  const values = uniqueNormalizedTexts(specialtyValues, 40);
  if (!values.length) return null;
  try {
    const [
      exactMembers,
      textMembers,
      activeWipes,
      closedWipes,
      permissionRoles
    ] = await Promise.all([
      getSqliteRecordsByJsonArrayField('members', 'specialty', values, { limit: 0 }),
      getSqliteRecordsByJsonFieldTextContainsNoCase('members', 'specialty', values, { limit: 0 }),
      getSqliteRecordsByJsonField('wipes', 'status', ['active'], { limit: 0 }),
      getSqliteRecordsByJsonField('wipes', 'status', ['closed'], { limit: 0 }),
      options.includePermissionRoles ? getSqliteCollection('permissionRoles', { limit: 0 }) : Promise.resolve([])
    ]);
    return memberRuntimeStoreShell({
      members: mergeRecordsById(exactMembers, textMembers),
      wipes: mergeRecordsById(activeWipes, closedWipes),
      permissionRoles
    });
  } catch (error) {
    console.warn('[nb-clan] sqlite member list specialty candidates fallback:', error?.message || error);
    return null;
  }
}

export async function readMemberQueryRuntimeStore(steamId, options = {}) {
  if (!sqlitePrimaryMode()) return readStore();
  const normalizedSteamId = normalizeText(steamId, 80);
  try {
    const [
      targetMembers,
      wipes,
      permissionRoles,
      settings
    ] = await Promise.all([
      normalizedSteamId
        ? getSqliteRecordsByJsonField('members', 'steamId', [normalizedSteamId], { limit: 0 })
        : Promise.resolve([]),
      getSqliteRecordsByJsonField('wipes', 'status', ['active', 'closed'], { limit: 0 }),
      getSqliteCollection('permissionRoles', { limit: 0 }),
      options.includeSettings ? getSqliteScalar('settings') : Promise.resolve({})
    ]);

    const matchingMembers = (targetMembers || []).filter((item) => normalizeText(item.steamId, 80) === normalizedSteamId);
    const store = memberRuntimeStoreShell({
      members: matchingMembers,
      wipes,
      permissionRoles,
      settings: options.includeSettings ? (settings || {}) : {}
    });
    if (!matchingMembers.length) return store;

    const targetMemberIds = uniqueNormalizedTexts(matchingMembers.map((member) => member.id), 120);
    const targetSteamIds = uniqueNormalizedTexts(matchingMembers.map((member) => member.steamId), 80);
    const targetDiscordIds = uniqueNormalizedTexts(matchingMembers.map((member) => member.discordId), DISCORD_ID_MAX_LENGTH);

    const [
      memberProfilesByMemberId,
      memberProfilesBySteamId,
      kdaRowsByMemberId,
      kdaRowsBySteamId,
      kdaSnapshotsByMemberId,
      kdaSnapshotsBySteamId,
      wipeParticipantsByMemberId,
      squadMembersByMemberId,
      wechatUsersByMemberId,
      discordApplicationsByDiscordId,
      discordApplicationsByMemberId,
      discordApplicationsBySteamId
    ] = await Promise.all([
      targetMemberIds.length
        ? getSqliteRecordsByJsonField('memberProfiles', 'memberId', targetMemberIds, { limit: 0 })
        : Promise.resolve([]),
      targetSteamIds.length
        ? getSqliteRecordsByJsonField('memberProfiles', 'steamId', targetSteamIds, { limit: 0 })
        : Promise.resolve([]),
      targetMemberIds.length
        ? getSqliteRecordsByJsonField('kdaRows', 'memberId', targetMemberIds, { limit: 0 })
        : Promise.resolve([]),
      targetSteamIds.length
        ? getSqliteRecordsByJsonField('kdaRows', 'steamId', targetSteamIds, { limit: 0 })
        : Promise.resolve([]),
      options.includeKdaSnapshots && targetMemberIds.length
        ? getSqliteRecordsByJsonField('kdaSnapshots', 'memberId', targetMemberIds, { limit: 0 })
        : Promise.resolve([]),
      options.includeKdaSnapshots && targetSteamIds.length
        ? getSqliteRecordsByJsonField('kdaSnapshots', 'steamId', targetSteamIds, { limit: 0 })
        : Promise.resolve([]),
      targetMemberIds.length
        ? getSqliteRecordsByJsonField('wipeParticipants', 'memberId', targetMemberIds, { limit: 0 })
        : Promise.resolve([]),
      targetMemberIds.length
        ? getSqliteRecordsByJsonField('squadMembers', 'memberId', targetMemberIds, { limit: 0 })
        : Promise.resolve([]),
      options.includeWechatUsers && targetMemberIds.length
        ? getSqliteRecordsByJsonField('wechatUsers', 'memberId', targetMemberIds, { limit: 0 })
        : Promise.resolve([]),
      options.includeDiscordApplications && targetDiscordIds.length
        ? getSqliteRecordsByJsonField('discordMemberApplications', 'discordUserId', targetDiscordIds, { limit: 0 })
        : Promise.resolve([]),
      options.includeDiscordApplications && targetMemberIds.length
        ? getSqliteRecordsByJsonField('discordMemberApplications', 'memberId', targetMemberIds, { limit: 0 })
        : Promise.resolve([]),
      options.includeDiscordApplications && targetSteamIds.length
        ? getSqliteRecordsByJsonField('discordMemberApplications', 'steamId', targetSteamIds, { limit: 0 })
        : Promise.resolve([])
    ]);

    store.memberProfiles = mergeRecordsById(memberProfilesByMemberId, memberProfilesBySteamId);
    store.kdaRows = mergeRecordsById(kdaRowsByMemberId, kdaRowsBySteamId);
    if (options.includeKdaSnapshots) store.kdaSnapshots = mergeRecordsById(kdaSnapshotsByMemberId, kdaSnapshotsBySteamId);
    store.wipeParticipants = mergeRecordsById(wipeParticipantsByMemberId);
    store.squadMembers = mergeRecordsById(squadMembersByMemberId);
    if (options.includeWechatUsers) store.wechatUsers = mergeRecordsById(wechatUsersByMemberId);
    if (options.includeDiscordApplications) {
      store.discordMemberApplications = mergeRecordsById(
        discordApplicationsByDiscordId,
        discordApplicationsByMemberId,
        discordApplicationsBySteamId
      );
    }

    const neededSquadIds = new Set();
    for (const member of matchingMembers) {
      const squadId = normalizeText(member.squadId, 120);
      if (squadId) neededSquadIds.add(squadId);
    }
    for (const squadId of uniqueNormalizedTexts(options.includeSquadIds || [], 120)) {
      neededSquadIds.add(squadId);
    }
    for (const relation of store.squadMembers || []) {
      if (targetMemberIds.includes(normalizeText(relation.memberId, 120)) && relation.squadId) {
        neededSquadIds.add(normalizeText(relation.squadId, 120));
      }
    }
    for (const participant of store.wipeParticipants || []) {
      if (participant.squadId) neededSquadIds.add(normalizeText(participant.squadId, 120));
    }
    for (const row of store.kdaRows || []) {
      if (row.squadId) neededSquadIds.add(normalizeText(row.squadId, 120));
    }

    const relatedMemberIds = new Set(targetMemberIds);
    const leaderUserIds = new Set();
    const leaderUserIdsBySquadId = new Map();
    const squads = await readSqliteRecordsByIds('squads', [...neededSquadIds]);
    store.squads = squads;
    for (const squad of squads || []) {
      const squadId = normalizeText(squad.id, 120);
      if (!neededSquadIds.has(squadId)) continue;
      const normalizedLeaderIds = squadLeaderIds(squad).map((leaderId) => normalizeText(leaderId, 120)).filter(Boolean);
      leaderUserIdsBySquadId.set(squadId, normalizedLeaderIds);
      for (const leaderId of normalizedLeaderIds) leaderUserIds.add(leaderId);
    }

    const inviterUserIds = uniqueNormalizedTexts(
      matchingMembers
        .map((member) => member.invitedByUserId)
        .filter((value) => !normalizeText(value, 120).startsWith('discord:')),
      120
    );
    const users = await readSqliteRecordsByIds('users', [...leaderUserIds, ...inviterUserIds]);
    store.users = users;

    const relatedSteamIds = new Set(targetSteamIds);
    const leaderBoundSteamIdByUserId = new Map();
    for (const user of users || []) {
      const userId = normalizeText(user.id, 120);
      if (!leaderUserIds.has(userId)) continue;
      const boundSteamId = normalizeText(user.boundSteamId || user.steamId, 80);
      if (boundSteamId) {
        leaderBoundSteamIdByUserId.set(userId, boundSteamId);
        relatedSteamIds.add(boundSteamId);
      }
    }

    const fallbackSquadIds = new Set();
    for (const [squadId, leaderIds] of leaderUserIdsBySquadId.entries()) {
      if (leaderIds.some((leaderId) => !leaderBoundSteamIdByUserId.get(leaderId))) {
        fallbackSquadIds.add(squadId);
      }
    }
    if (fallbackSquadIds.size) {
      const fallbackSquadMembers = await getSqliteRecordsByJsonField('squadMembers', 'squadId', [...fallbackSquadIds], { limit: 0 });
      store.squadMembers = mergeRecordsById(store.squadMembers, fallbackSquadMembers);
      for (const relation of fallbackSquadMembers || []) {
        const squadId = normalizeText(relation.squadId, 120);
        if (fallbackSquadIds.has(squadId) && relation.memberId) {
          relatedMemberIds.add(normalizeText(relation.memberId, 120));
        }
      }
    }

    const [relatedMembersById, relatedMembersBySteamId] = await Promise.all([
      readSqliteRecordsByIds('members', [...relatedMemberIds].filter((id) => !targetMemberIds.includes(id))),
      getSqliteRecordsByJsonField('members', 'steamId', [...relatedSteamIds], { limit: 0 })
    ]);
    store.members = mergeRecordsById(matchingMembers, relatedMembersById, relatedMembersBySteamId);
    return store;
  } catch (error) {
    console.warn('[nb-clan] sqlite member query runtime fallback:', error?.message || error);
    throw memberStoreReadUnavailableError(error, '成员查询读取');
  }
}

export async function readMemberDetailRuntimeStore(memberId, options = {}) {
  if (!sqlitePrimaryMode()) return readStore();
  const normalizedMemberId = normalizeText(memberId, 120);
  try {
    const member = normalizedMemberId ? await getSqliteRecord('members', normalizedMemberId) : null;
    if (!member) return memberRuntimeStoreShell();
    const memberSteamId = normalizeText(member.steamId, 80);
    if (memberSteamId) {
      return await readMemberQueryRuntimeStore(memberSteamId, {
        includeWechatUsers: true,
        includeDiscordApplications: true,
        includeKdaSnapshots: Boolean(options.includeKdaSnapshots),
        includeSquadIds: options.includeSquadIds || []
      });
    }

    const [
      wipes,
      squadMembersByMemberId,
      permissionRoles
    ] = await Promise.all([
      getSqliteRecordsByJsonField('wipes', 'status', ['active', 'closed'], { limit: 0 }),
      getSqliteRecordsByJsonField('squadMembers', 'memberId', [member.id], { limit: 0 }),
      getSqliteCollection('permissionRoles', { limit: 0 })
    ]);
    const store = memberRuntimeStoreShell({
      members: [member],
      squadMembers: mergeRecordsById(squadMembersByMemberId),
      wipes,
      permissionRoles
    });
    await hydrateMemberScopedRuntimeStore(store, [member.id], {
      includeWechatUsers: true,
      includeDiscordApplications: true,
      includeKdaSnapshots: Boolean(options.includeKdaSnapshots)
    });

    const neededSquadIds = new Set(uniqueNormalizedTexts([
      member.squadId,
      ...(options.includeSquadIds || [])
    ], 120));
    for (const relation of store.squadMembers || []) {
      if (relation.memberId === member.id && relation.squadId) neededSquadIds.add(normalizeText(relation.squadId, 120));
    }
    for (const participant of store.wipeParticipants || []) {
      if (participant.squadId) neededSquadIds.add(normalizeText(participant.squadId, 120));
    }
    for (const row of store.kdaRows || []) {
      if (row.squadId) neededSquadIds.add(normalizeText(row.squadId, 120));
    }
    if (options.includeKdaSnapshots) {
      for (const snapshot of store.kdaSnapshots || []) {
        if (snapshot.squadId) neededSquadIds.add(normalizeText(snapshot.squadId, 120));
      }
    }

    store.squads = await readSqliteRecordsByIds('squads', [...neededSquadIds]);

    const leaderUserIds = new Set();
    for (const squad of store.squads || []) {
      for (const leaderId of squadLeaderIds(squad)) {
        const normalizedLeaderId = normalizeText(leaderId, 120);
        if (normalizedLeaderId) leaderUserIds.add(normalizedLeaderId);
      }
    }
    const inviterUserIds = uniqueNormalizedTexts(
      [member.invitedByUserId].filter((value) => !normalizeText(value, 120).startsWith('discord:')),
      120
    );
    store.users = await readSqliteRecordsByIds('users', [...leaderUserIds, ...inviterUserIds]);

    const leaderSteamIds = uniqueNormalizedTexts(
      (store.users || [])
        .filter((user) => leaderUserIds.has(normalizeText(user.id, 120)))
        .map((user) => user.boundSteamId || user.steamId),
      80
    );
    const leaderMembers = leaderSteamIds.length
      ? await getSqliteRecordsByJsonField('members', 'steamId', leaderSteamIds, { limit: 0 })
      : [];
    store.members = mergeRecordsById([member], leaderMembers);
    return store;
  } catch (error) {
    console.warn('[nb-clan] sqlite member detail runtime fallback:', error?.message || error);
    throw memberStoreReadUnavailableError(error, '成员详情读取');
  }
}

export async function readMemberProfileRefreshWriteStore(memberId, options = {}) {
  const normalizedMemberId = normalizeText(memberId, 120);
  const member = normalizedMemberId ? await getSqliteRecord('members', normalizedMemberId) : null;
  if (!member) return memberRuntimeStoreShell();
  const memberSteamId = normalizeText(member.steamId, 80);
  const includeManagementContext = options.includeManagementContext !== false;
  const [
    squadMembers,
    permissionRoles,
    memberProfilesByMember,
    memberProfilesBySteam,
    settings
  ] = await Promise.all([
    includeManagementContext ? getSqliteRecordsByJsonField('squadMembers', 'memberId', [member.id], { limit: 0 }) : Promise.resolve([]),
    includeManagementContext ? getSqliteCollection('permissionRoles', { limit: 0 }) : Promise.resolve([]),
    getSqliteRecordsByJsonField('memberProfiles', 'memberId', [member.id], { limit: 0 }),
    memberSteamId ? getSqliteRecordsByJsonField('memberProfiles', 'steamId', [memberSteamId], { limit: 0 }) : Promise.resolve([]),
    options.includeSettings ? getSqliteScalar('settings') : Promise.resolve({})
  ]);
  const squadIds = includeManagementContext
    ? uniqueNormalizedTexts([
      member.squadId,
      ...(squadMembers || []).map((relation) => relation.squadId)
    ], 120)
    : [];
  const squads = includeManagementContext ? await readSqliteRecordsByIds('squads', squadIds) : [];
  const store = memberRuntimeStoreShell({
    members: [member],
    squads,
    squadMembers,
    permissionRoles,
    settings: options.includeSettings ? (settings || {}) : {}
  });
  store.memberProfiles = mergeRecordsById(memberProfilesByMember, memberProfilesBySteam);
  return store;
}

export async function readMemberRefreshRequestStore(memberId, options = {}) {
  if (!sqlitePrimaryMode()) return readStore();
  try {
    return await readMemberProfileRefreshWriteStore(memberId, options);
  } catch (error) {
    console.warn('[nb-clan] sqlite member refresh request fallback:', error?.message || error);
    throw memberStoreReadUnavailableError(error, '成员刷新前置读取');
  }
}

export async function readMemberProfileSyncRequestStore({ includeSettings = false, ...options } = {}) {
  if (!sqlitePrimaryMode()) return readStore();
  try {
    const memberIds = uniqueNormalizedTexts([
      options.memberId,
      ...(Array.isArray(options.memberIds) ? options.memberIds : [options.memberIds]),
      ...(Array.isArray(options.requestedMemberIds) ? options.requestedMemberIds : [options.requestedMemberIds])
    ], 120);
    const hasMemberScope = Object.hasOwn(options, 'memberId') ||
      Object.hasOwn(options, 'memberIds') ||
      Object.hasOwn(options, 'requestedMemberIds');
    const membersPromise = hasMemberScope
      ? (memberIds.length ? readSqliteRecordsByIds('members', memberIds) : Promise.resolve([]))
      : getSqliteCollection('members', { limit: 0 });
    const memberProfilesPromise = hasMemberScope
      ? (memberIds.length ? getSqliteRecordsByJsonField('memberProfiles', 'memberId', memberIds, { limit: 0 }) : Promise.resolve([]))
      : getSqliteCollection('memberProfiles', { limit: 0 });
    const [
      members,
      memberProfiles,
      syncJobs,
      syncState,
      settings
    ] = await Promise.all([
      membersPromise,
      memberProfilesPromise,
      readRuntimeSyncJobs(options),
      getSqliteScalar('syncState'),
      includeSettings ? getSqliteScalar('settings') : Promise.resolve({})
    ]);
    return {
      members,
      memberProfiles,
      syncJobs,
      syncState: syncState || {},
      settings: settings || {}
    };
  } catch (error) {
    console.warn('[nb-clan] sqlite member profile sync request fallback:', error?.message || error);
    return memberPartialStore(error, 'member_profile_sync_request', {
      members: [],
      memberProfiles: [],
      syncJobs: [],
      syncState: {},
      settings: {}
    });
  }
}

export async function readBattlemetricsSyncRequestStore(options = {}) {
  if (!sqlitePrimaryMode()) return readStore();
  try {
    if (options.battlemetricsStatusOnly) {
      const [
        settings,
        syncJobs,
        syncState
      ] = await Promise.all([
        getSqliteScalar('settings'),
        readRuntimeSyncJobs(options),
        getSqliteScalar('syncState')
      ]);
      return {
        members: [],
        memberProfiles: [],
        wipes: [],
        wipeParticipants: [],
        settings: settings || {},
        syncJobs,
        syncState: syncState || {}
      };
    }
    if (options.activeBattlemetricsWipeOnly) {
      const [
        activeWipes,
        settings,
        syncJobs,
        syncState
      ] = await Promise.all([
        getSqliteRecordsByJsonField('wipes', 'status', ['active'], { limit: 0 }),
        getSqliteScalar('settings'),
        readRuntimeSyncJobs(options),
        getSqliteScalar('syncState')
      ]);
      const activeWipe = activeWipes.find((wipe) => normalizeText(wipe.status, 40) === 'active') || null;
      const wipeParticipants = activeWipe?.id
        ? await getSqliteRecordsByJsonField('wipeParticipants', 'wipeId', [activeWipe.id], { limit: 0 })
        : [];
      const participantMemberIds = uniqueNormalizedTexts(wipeParticipants.map((participant) => participant.memberId), 120);
      const [members, memberProfiles] = await Promise.all([
        participantMemberIds.length ? readSqliteRecordsByIds('members', participantMemberIds) : Promise.resolve([]),
        participantMemberIds.length ? getSqliteRecordsByJsonField('memberProfiles', 'memberId', participantMemberIds, { limit: 0 }) : Promise.resolve([])
      ]);
      return {
        members,
        memberProfiles,
        wipes: activeWipes,
        wipeParticipants,
        settings: settings || {},
        syncJobs,
        syncState: syncState || {}
      };
    }
    if (options.battlemetricsIdentityCandidatesOnly) {
      const [
        membersMissingBattlemetricsId,
        settings,
        syncJobs,
        syncState
      ] = await Promise.all([
        getSqliteRecordsWhereJsonFieldMissing('members', 'battlemetricsId', { limit: 0 }),
        getSqliteScalar('settings'),
        readRuntimeSyncJobs(options),
        getSqliteScalar('syncState')
      ]);
      const memberIds = uniqueNormalizedTexts(membersMissingBattlemetricsId.map((member) => member.id), 120);
      const memberProfiles = memberIds.length
        ? await getSqliteRecordsByJsonFieldInChunks('memberProfiles', 'memberId', memberIds)
        : [];
      return {
        members: membersMissingBattlemetricsId,
        memberProfiles,
        wipes: [],
        wipeParticipants: [],
        settings: settings || {},
        syncJobs,
        syncState: syncState || {}
      };
    }
    if (options.battlemetricsWipePlaytimeOnly) {
      const requestedWipeId = normalizeText(options.requestedWipeId || options.wipeId, 120);
      const [
        wipes,
        settings,
        syncJobs,
        syncState
      ] = await Promise.all([
        requestedWipeId && requestedWipeId !== 'current'
          ? readSqliteRecordsByIds('wipes', [requestedWipeId])
          : getSqliteRecordsByJsonField('wipes', 'status', ['active'], { limit: 0 }),
        getSqliteScalar('settings'),
        readRuntimeSyncJobs(options),
        getSqliteScalar('syncState')
      ]);
      const targetWipe = requestedWipeId && requestedWipeId !== 'current'
        ? (wipes.find((wipe) => wipe.id === requestedWipeId) || null)
        : (wipes.find((wipe) => normalizeText(wipe.status, 40) === 'active') || null);
      const wipeParticipants = targetWipe?.id
        ? await getSqliteRecordsByJsonField('wipeParticipants', 'wipeId', [targetWipe.id], { limit: 0 })
        : [];
      const memberIds = uniqueNormalizedTexts(wipeParticipants.map((participant) => participant.memberId), 120);
      const [members, memberProfiles] = await Promise.all([
        memberIds.length ? readSqliteRecordsByIds('members', memberIds) : Promise.resolve([]),
        memberIds.length ? getSqliteRecordsByJsonFieldInChunks('memberProfiles', 'memberId', memberIds) : Promise.resolve([])
      ]);
      return {
        members,
        memberProfiles,
        wipes,
        wipeParticipants,
        settings: settings || {},
        syncJobs,
        syncState: syncState || {}
      };
    }
    const memberIds = uniqueNormalizedTexts([
      options.memberId,
      ...(Array.isArray(options.memberIds) ? options.memberIds : [options.memberIds]),
      ...(Array.isArray(options.requestedMemberIds) ? options.requestedMemberIds : [options.requestedMemberIds])
    ], 120);
    const hasMemberScope = Object.hasOwn(options, 'memberId') ||
      Object.hasOwn(options, 'memberIds') ||
      Object.hasOwn(options, 'requestedMemberIds');
    const wipeParticipantMemberIds = uniqueNormalizedTexts([
      ...(Array.isArray(options.wipeParticipantMemberIds) ? options.wipeParticipantMemberIds : [options.wipeParticipantMemberIds]),
      ...(options.includeWipeParticipantsForMembers === true ? memberIds : [])
    ], 120);
	    const wipeParticipantWipeIds = uniqueNormalizedTexts([
	      options.wipeId,
	      options.requestedWipeId,
	      ...(Array.isArray(options.wipeIds) ? options.wipeIds : [options.wipeIds])
	    ], 120).filter((id) => id !== 'current');
	    const requestedWipeId = normalizeText(options.requestedWipeId || options.wipeId, 120);
	    const includeWipeParticipants = options.includeWipeParticipants !== false;
	    const includeBattlemetricsOwnerIndex = Boolean(options.includeBattlemetricsOwnerIndex);
	    const membersPromise = hasMemberScope
	      ? (memberIds.length ? readSqliteRecordsByIds('members', memberIds) : Promise.resolve([]))
	      : getSqliteCollection('members', { limit: 0 });
    const memberProfilesPromise = hasMemberScope
      ? (memberIds.length ? getSqliteRecordsByJsonField('memberProfiles', 'memberId', memberIds, { limit: 0 }) : Promise.resolve([]))
      : getSqliteCollection('memberProfiles', { limit: 0 });
    const battlemetricsOwnerMembersPromise = includeBattlemetricsOwnerIndex && memberIds.length
      ? getSqliteRecordsWhereJsonFieldPresent('members', 'battlemetricsId', { limit: 0 })
      : Promise.resolve([]);
    const battlemetricsOwnerProfilesPromise = includeBattlemetricsOwnerIndex && memberIds.length
      ? getSqliteRecordsWhereJsonFieldPresent('memberProfiles', 'battlemetricsPlayerId', { limit: 0 })
      : Promise.resolve([]);
	    const wipeParticipantsPromise = !includeWipeParticipants
	      ? Promise.resolve([])
	      : (wipeParticipantMemberIds.length
	          ? getSqliteRecordsByJsonField('wipeParticipants', 'memberId', wipeParticipantMemberIds, { limit: 0 })
	          : (wipeParticipantWipeIds.length
	              ? getSqliteRecordsByJsonField('wipeParticipants', 'wipeId', wipeParticipantWipeIds, { limit: 0 })
	              : getSqliteCollection('wipeParticipants', { limit: 0 })));
	    const wipesPromise = requestedWipeId && requestedWipeId !== 'current'
	      ? readSqliteRecordsByIds('wipes', [requestedWipeId])
	      : (hasMemberScope || requestedWipeId === 'current'
	          ? getSqliteRecordsByJsonField('wipes', 'status', ['active', 'planned', 'closed'], { limit: 0 })
	          : getSqliteCollection('wipes', { limit: 0 }));
	    const [
	      members,
	      memberProfiles,
	      wipes,
      wipeParticipants,
      settings,
      syncJobs,
      syncState,
      battlemetricsOwnerMembers,
      battlemetricsOwnerProfiles
	    ] = await Promise.all([
	      membersPromise,
	      memberProfilesPromise,
	      wipesPromise,
	      wipeParticipantsPromise,
	      getSqliteScalar('settings'),
      readRuntimeSyncJobs(options),
      getSqliteScalar('syncState'),
      battlemetricsOwnerMembersPromise,
      battlemetricsOwnerProfilesPromise
    ]);
    return {
      members: mergeRecordsById(members, battlemetricsOwnerMembers),
      memberProfiles: mergeRecordsById(memberProfiles, battlemetricsOwnerProfiles),
      wipes,
      wipeParticipants,
      settings: settings || {},
      syncJobs,
      syncState: syncState || {}
    };
  } catch (error) {
    console.warn('[nb-clan] sqlite battlemetrics sync request fallback:', error?.message || error);
    return memberPartialStore(error, 'battlemetrics_sync_request', {
      members: [],
      memberProfiles: [],
      wipes: [],
      wipeParticipants: [],
      settings: {},
      syncJobs: [],
      syncState: {}
    });
  }
}

export async function readMemberDiscordReminderStore() {
  if (!sqlitePrimaryMode()) return readStore();
  try {
    const [members, settings] = await Promise.all([
      getSqliteRecordsByJsonField('members', 'vitalVipType', ['queue_skip', 'priority'], { limit: 0 }),
      getSqliteScalar('settings')
    ]);
    const discordIds = uniqueNormalizedTexts(members.map((member) => member.discordId), DISCORD_ID_MAX_LENGTH);
    const discordMemberApplications = discordIds.length
      ? await getSqliteRecordsByJsonField('discordMemberApplications', 'discordUserId', discordIds, { limit: 0 })
      : [];
    return {
      members,
      discordMemberApplications,
      settings: settings || {}
    };
  } catch (error) {
    console.warn('[nb-clan] sqlite member Discord reminder fallback:', error?.message || error);
    return memberPartialStore(error, 'member_discord_reminder', {
      members: [],
      discordMemberApplications: [],
      settings: {}
    });
  }
}

export async function readBattlemetricsIdRefreshRequestStore(options = {}) {
  if (!sqlitePrimaryMode()) return readStore();
  const requestOptions = typeof options === 'string' ? { memberId: options } : (options || {});
  const memberIds = uniqueNormalizedTexts([
    requestOptions.memberId,
    ...(Array.isArray(requestOptions.memberIds) ? requestOptions.memberIds : [requestOptions.memberIds])
  ], 120);
  try {
    if (memberIds.length) {
      const requestedWipeId = normalizeText(requestOptions.requestedWipeId || requestOptions.wipeId, 120);
      const wipesPromise = requestedWipeId && requestedWipeId !== 'current'
        ? readSqliteRecordsByIds('wipes', [requestedWipeId])
        : getSqliteRecordsByJsonField('wipes', 'status', ['active', 'planned', 'closed'], { limit: 0 });
      const [
        members,
        memberProfiles,
        battlemetricsOwnerMembers,
        battlemetricsOwnerProfiles,
        squadMembers,
        permissionRoles,
        wipes,
        settings
      ] = await Promise.all([
        readSqliteRecordsByIds('members', memberIds),
        getSqliteRecordsByJsonField('memberProfiles', 'memberId', memberIds, { limit: 0 }),
        getSqliteRecordsWhereJsonFieldPresent('members', 'battlemetricsId', { limit: 0 }),
        getSqliteRecordsWhereJsonFieldPresent('memberProfiles', 'battlemetricsPlayerId', { limit: 0 }),
        getSqliteRecordsByJsonField('squadMembers', 'memberId', memberIds, { limit: 0 }),
        getSqliteCollection('permissionRoles', { limit: 0 }),
        wipesPromise,
        getSqliteScalar('settings')
      ]);
      const squadIds = uniqueNormalizedTexts([
        ...members.map((member) => member.squadId),
        ...squadMembers.map((relation) => relation.squadId)
      ], 120);
      const squads = await readSqliteRecordsByIds('squads', squadIds);
      const store = memberRuntimeStoreShell({
        members: mergeRecordsById(members, battlemetricsOwnerMembers),
        squads,
        squadMembers,
        wipes,
        permissionRoles,
        settings: settings || {}
      });
      store.memberProfiles = mergeRecordsById(memberProfiles, battlemetricsOwnerProfiles);
      return store;
    }

    const [store, settings, memberProfiles] = await Promise.all([
      readMemberRuntimeBaseStore(),
      getSqliteScalar('settings'),
      getSqliteCollection('memberProfiles', { limit: 0 })
    ]);
    store.settings = settings || {};
    store.memberProfiles = memberProfiles;
    return store;
  } catch (error) {
    console.warn('[nb-clan] sqlite battlemetrics id refresh request fallback:', error?.message || error);
    return memberPartialRuntimeStore(error, 'battlemetrics_id_refresh_request', {
      settings: {}
    });
  }
}

export async function readViewerMemberSyncCheckStore(user, options = {}) {
  if (!sqlitePrimaryMode()) return readStore();
  if (!user) return memberRuntimeStoreShell();
  try {
    const scopedSquadIds = uniqueNormalizedTexts(options.squadIds || options.squadId, 120);
    if (isAdmin(user)) {
      const [roleLeaderUsers, squads] = await Promise.all([
        options.includeRoleLeaders === false
          ? Promise.resolve([])
          : getSqliteRecordsByJsonField('users', 'role', ['leader'], { limit: 0 }),
        scopedSquadIds.length
          ? readSqliteRecordsByIds('squads', scopedSquadIds)
          : readSquadsWithAnyLeaderUserId()
      ]);
      const activeLeaderIds = new Set(activeSquads({ squads }).flatMap((squad) => squadLeaderIds(squad)));
      const squadLeaderUsers = activeLeaderIds.size ? await readSqliteRecordsByIds('users', [...activeLeaderIds]) : [];
      const users = mergeRecordsById(roleLeaderUsers, squadLeaderUsers);
      const syncUsers = (users || []).filter((candidate) => isLeader(candidate) || activeLeaderIds.has(candidate.id));
      const steamIds = uniqueNormalizedTexts(syncUsers.map((candidate) => candidate.boundSteamId), 80);
      const members = steamIds.length
        ? await getSqliteRecordsByJsonField('members', 'steamId', steamIds, { limit: 0 })
        : [];
      const memberIds = uniqueNormalizedTexts(members.map((member) => member.id), 120);
      const squadMembers = memberIds.length
        ? await getSqliteRecordsByJsonField('squadMembers', 'memberId', memberIds, { limit: 0 })
        : [];
      return memberRuntimeStoreShell({
        users,
        members,
        squads,
        squadMembers
      });
    }

    const squads = scopedSquadIds.length
      ? await readSqliteRecordsByIds('squads', scopedSquadIds)
      : await readSquadsByLeaderUserIds([user.id]);
    if (!isLeader(user) && !leaderSquads({ squads }, user).length) {
      if (options.includeSelfMember) {
        const boundSteamId = normalizeText(user.boundSteamId, 80);
        const members = boundSteamId
          ? await getSqliteRecordsByJsonField('members', 'steamId', [boundSteamId], { limit: 0 })
          : [];
        return memberRuntimeStoreShell({ users: [user], members, squads });
      }
      return memberRuntimeStoreShell({ users: [user], squads });
    }
    const boundSteamId = normalizeText(user.boundSteamId, 80);
    const members = boundSteamId
      ? await getSqliteRecordsByJsonField('members', 'steamId', [boundSteamId], { limit: 0 })
      : [];
    const memberIds = uniqueNormalizedTexts(members.map((member) => member.id), 120);
    const squadMembers = memberIds.length
      ? await getSqliteRecordsByJsonField('squadMembers', 'memberId', memberIds, { limit: 0 })
      : [];
    return memberRuntimeStoreShell({
      users: [user],
      members,
      squads,
      squadMembers
    });
  } catch (error) {
    console.warn('[nb-clan] sqlite viewer member sync check fallback:', error?.message || error);
    return memberPartialRuntimeStore(error, 'viewer_member_sync_check', {
      users: isAdmin(user) ? [] : [user]
    });
  }
}

async function readMemberBaseWriteRuntimeStore(options = {}) {
  const optionUsers = mergeRecordsById(options.users || [], options.user || []);
  const optionMembers = mergeRecordsById(options.members || [], options.member || []);
  const optionSquads = mergeRecordsById(options.squads || [], options.squad || []);
  const optionSquadMembers = mergeRecordsById(options.squadMembers || [], options.squadMember || []);
  const rawUserIds = [
    ...(Array.isArray(options.userIds) ? options.userIds : [options.userIds]),
    options.userId,
    ...optionUsers.map((user) => user?.id)
  ];
  const scopedUserIds = new Set(uniqueNormalizedTexts(rawUserIds, 120));
  const scopedSquadIds = uniqueNormalizedTexts([
    ...(Array.isArray(options.squadIds) ? options.squadIds : [options.squadIds]),
    options.squadId,
    ...optionSquads.map((squad) => squad?.id)
  ], 120);
  const rawMemberIds = [
    ...(Array.isArray(options.memberIds) ? options.memberIds : [options.memberIds]),
    options.memberId,
    ...optionMembers.map((member) => member?.id),
    ...optionSquadMembers.map((relation) => relation?.memberId)
  ];
  const scopedMemberIds = new Set(uniqueNormalizedTexts(rawMemberIds, 120));
  const isScoped = scopedUserIds.size ||
    scopedSquadIds.length ||
    scopedMemberIds.size ||
    optionSquadMembers.length ||
    options.includeLeaderSquadsForUsers ||
    options.includeRoleLeaders === true;
  if (!isScoped) {
    if (options.requireScopedMemberBaseWrite) throw memberBaseScopedWriteUnavailableError();
    const [
      users,
      members,
      squads,
      squadMembers
    ] = await Promise.all([
      getSqliteCollection('users', { limit: 0 }),
      getSqliteCollection('members', { limit: 0 }),
      getSqliteCollection('squads', { limit: 0 }),
      getSqliteCollection('squadMembers', { limit: 0 })
    ]);
    return memberRuntimeStoreShell({ users, members, squads, squadMembers });
  }

  const optionSquadIds = new Set(uniqueNormalizedTexts(optionSquads.map((squad) => squad.id), 120));
  const missingSquadIds = scopedSquadIds.filter((id) => !optionSquadIds.has(id));
  const [squadsById, leaderSquadsForUsers, roleLeaderUsers] = await Promise.all([
    missingSquadIds.length ? readSqliteRecordsByIds('squads', missingSquadIds) : Promise.resolve([]),
    options.includeLeaderSquadsForUsers && scopedUserIds.size
      ? readSquadsByLeaderUserIds([...scopedUserIds])
      : Promise.resolve([]),
    options.includeRoleLeaders === true
      ? getSqliteRecordsByJsonField('users', 'role', ['leader'], { limit: 0 })
      : Promise.resolve([])
  ]);
  const squads = mergeRecordsById(optionSquads, squadsById, leaderSquadsForUsers);
  for (const squad of activeSquads({ squads })) {
    for (const leaderId of squadLeaderIds(squad)) {
      const normalizedLeaderId = normalizeText(leaderId, 120);
      if (normalizedLeaderId) scopedUserIds.add(normalizedLeaderId);
    }
  }

  const optionUserIds = new Set(uniqueNormalizedTexts(optionUsers.map((user) => user.id), 120));
  const missingUserIds = [...scopedUserIds].filter((id) => !optionUserIds.has(id));
  const usersById = missingUserIds.length ? await readSqliteRecordsByIds('users', missingUserIds) : [];
  const users = mergeRecordsById(optionUsers, usersById, roleLeaderUsers);
  const steamIds = uniqueNormalizedTexts(users.map((user) => user.boundSteamId || user.steamId), 80);
  const optionMemberIds = new Set(uniqueNormalizedTexts(optionMembers.map((member) => member.id), 120));
  const optionMemberSteamIds = new Set(uniqueNormalizedTexts(optionMembers.map((member) => member.steamId), 80));
  const missingSteamIds = steamIds.filter((steamId) => !optionMemberSteamIds.has(steamId));
  const missingMemberIds = [...scopedMemberIds].filter((id) => !optionMemberIds.has(id));
  const [membersBySteamId, membersById, squadMembersBySquadId] = await Promise.all([
    missingSteamIds.length ? getSqliteRecordsByJsonField('members', 'steamId', missingSteamIds, { limit: 0 }) : Promise.resolve([]),
    missingMemberIds.length ? readSqliteRecordsByIds('members', missingMemberIds) : Promise.resolve([]),
    missingSquadIds.length ? getSqliteRecordsByJsonField('squadMembers', 'squadId', missingSquadIds, { limit: 0 }) : Promise.resolve([])
  ]);

  const memberIds = new Set(uniqueNormalizedTexts([
    ...optionMembers.map((member) => member.id),
    ...membersBySteamId.map((member) => member.id),
    ...membersById.map((member) => member.id),
    ...optionSquadMembers.map((relation) => relation.memberId),
    ...squadMembersBySquadId.map((relation) => relation.memberId)
  ], 120));
  const optionSquadMemberMemberIds = new Set(uniqueNormalizedTexts(optionSquadMembers.map((relation) => relation.memberId), 120));
  const missingSquadMemberMemberIds = [...memberIds].filter((id) => !optionSquadMemberMemberIds.has(id));
  const missingMemberIdsFromRelations = [...memberIds].filter((id) => !optionMemberIds.has(id));
  const [squadMembersByMemberId, membersBySquadMemberId] = await Promise.all([
    missingSquadMemberMemberIds.length
      ? getSqliteRecordsByJsonField('squadMembers', 'memberId', missingSquadMemberMemberIds, { limit: 0 })
      : Promise.resolve([]),
    missingMemberIdsFromRelations.length ? readSqliteRecordsByIds('members', missingMemberIdsFromRelations) : Promise.resolve([])
  ]);

  return memberRuntimeStoreShell({
    users,
    members: mergeRecordsById(optionMembers, membersBySteamId, membersById, membersBySquadMemberId),
    squads,
    squadMembers: mergeRecordsById(optionSquadMembers, squadMembersBySquadId, squadMembersByMemberId)
  });
}

export async function updateMemberBaseWriteStore(mutator, reason = 'member_base_write', options = {}) {
  if (!sqlitePrimaryMode()) return updateStore(mutator);
  return runStoreWriteTask(async () => {
    const store = await readMemberBaseWriteRuntimeStore(options);
    const collectionNames = ['members', 'squads', 'squadMembers'];
    const before = snapshotStoreCollections(store, collectionNames);
    const result = await mutator(store);
    const { upserts, deletes, changed } = diffStoreCollections(before, store, collectionNames);
    if (!changed) return result;
    await writeSqliteStorePatch({ reason, upserts, deletes });
    await patchStoreCache((cachedStore) => {
      applyStoreCollectionCachePatch(cachedStore, collectionNames, upserts, deletes);
    });
    return result;
  });
}

export function memberProfileSyncCancelRequested(store, statusKey = 'memberProfiles', syncJobId = '') {
  const state = store.syncState?.[statusKey] || {};
  if (state.status !== 'cancelled') return false;
  return !syncJobId || !state.syncJobId || state.syncJobId === syncJobId;
}

export async function readMemberProfileSyncCancelRequested(statusKey = 'memberProfiles', syncJobId = '') {
  try {
    if (sqliteEnabled()) {
      return memberProfileSyncCancelRequested({
        syncState: await getSqliteScalar('syncState') || {}
      }, statusKey, syncJobId);
    }
    const store = await readStore();
    return memberProfileSyncCancelRequested(store, statusKey, syncJobId);
  } catch (error) {
    console.warn('[nb-clan] member profile cancel status unavailable:', error?.message || error);
    throw memberProfileSyncCancelReadUnavailableError(error);
  }
}

export async function readWechatAdminMembersStore() {
  if (!sqlitePrimaryMode()) return readStore();
  try {
    const [
      users,
      members,
      squads,
      squadMembers,
      wipes,
      wechatUsers,
      permissionRoles
    ] = await Promise.all([
      getSqliteCollection('users', { limit: 0 }),
      getSqliteCollection('members', { limit: 0 }),
      getSqliteCollection('squads', { limit: 0 }),
      getSqliteCollection('squadMembers', { limit: 0 }),
      getSqliteCollection('wipes', { limit: 0 }),
      getSqliteCollection('wechatUsers', { limit: 0 }),
      getSqliteCollection('permissionRoles', { limit: 0 })
    ]);
    return {
      users,
      members,
      squads,
      squadMembers,
      wipes,
      wechatUsers,
      permissionRoles,
      wipeParticipants: [],
      kdaRows: [],
      kdaSnapshots: [],
      memberProfiles: [],
      wipeSettlements: [],
      uploads: [],
      discordMemberApplications: [],
      settings: {},
      syncState: {}
    };
  } catch (error) {
    console.warn('[nb-clan] sqlite wechat admin members read failed:', error?.message || error);
    throw memberStoreReadUnavailableError(error, '微信管理成员读取');
  }
}

export async function readMemberDeleteRuntimeStore(targetMembers = [], options = {}) {
  const members = (Array.isArray(targetMembers) ? targetMembers : [targetMembers]).filter(Boolean);
  const memberIds = uniqueNormalizedTexts(members.map((member) => member.id), 120);
  const steamIds = uniqueNormalizedTexts(members.map((member) => member.steamId), 80);
  const linkedWechatIds = options.includeWechatUsers
    ? uniqueNormalizedTexts(members.flatMap((member) => [
      normalizeText(member.wechatUserId, 160),
      isWechatSystemId(member.wechatId) ? normalizeText(member.wechatId, 160) : ''
    ]), 160)
    : [];
  const [
    users,
    sessions,
    squadMembers,
    wipes,
    permissionRoles,
    memberProfiles,
    accountAlertDismissals,
    wechatUsersByMemberId,
    wechatUsersById
  ] = await Promise.all([
    steamIds.length ? getSqliteRecordsByJsonField('users', 'boundSteamId', steamIds, { limit: 0 }) : Promise.resolve([]),
    Promise.resolve([]),
    memberIds.length ? getSqliteRecordsByJsonField('squadMembers', 'memberId', memberIds, { limit: 0 }) : Promise.resolve([]),
    getSqliteRecordsByJsonField('wipes', 'status', ['active', 'planned'], { limit: 0 }),
    getSqliteCollection('permissionRoles', { limit: 0 }),
    memberIds.length ? getSqliteRecordsByJsonField('memberProfiles', 'memberId', memberIds, { limit: 0 }) : Promise.resolve([]),
    memberIds.length ? getSqliteRecordsByJsonField('accountAlertDismissals', 'memberId', memberIds, { limit: 0 }) : Promise.resolve([]),
    options.includeWechatUsers && memberIds.length ? getSqliteRecordsByJsonField('wechatUsers', 'memberId', memberIds, { limit: 0 }) : Promise.resolve([]),
    linkedWechatIds.length ? readSqliteRecordsByIds('wechatUsers', linkedWechatIds) : Promise.resolve([])
  ]);
  const liveWipeIds = uniqueNormalizedTexts(wipes.map((wipe) => wipe.id), 120);
  const [
    squads,
    wipeParticipantsByMemberId,
    wipeParticipantsBySteamId,
    kdaRowsByMemberId,
    kdaRowsBySteamId,
    kdaSnapshotsByMemberId,
    kdaSnapshotsBySteamId
  ] = await Promise.all([
    readSqliteRecordsByIds('squads', uniqueNormalizedTexts([
      ...members.map((member) => member.squadId),
      ...squadMembers.map((relation) => relation.squadId)
    ], 120)),
    liveWipeIds.length && memberIds.length
      ? getSqliteRecordsByJsonFields('wipeParticipants', [
        { field: 'wipeId', values: liveWipeIds },
        { field: 'memberId', values: memberIds }
      ], { limit: 0 })
      : Promise.resolve([]),
    liveWipeIds.length && steamIds.length
      ? getSqliteRecordsByJsonFields('wipeParticipants', [
        { field: 'wipeId', values: liveWipeIds },
        { field: 'steamId', values: steamIds }
      ], { limit: 0 })
      : Promise.resolve([]),
    liveWipeIds.length && memberIds.length
      ? getSqliteRecordsByJsonFields('kdaRows', [
        { field: 'wipeId', values: liveWipeIds },
        { field: 'memberId', values: memberIds }
      ], { limit: 0 })
      : Promise.resolve([]),
    liveWipeIds.length && steamIds.length
      ? getSqliteRecordsByJsonFields('kdaRows', [
        { field: 'wipeId', values: liveWipeIds },
        { field: 'steamId', values: steamIds }
      ], { limit: 0 })
      : Promise.resolve([]),
    liveWipeIds.length && memberIds.length
      ? getSqliteRecordsByJsonFields('kdaSnapshots', [
        { field: 'wipeId', values: liveWipeIds },
        { field: 'memberId', values: memberIds }
      ], { limit: 0 })
      : Promise.resolve([]),
    liveWipeIds.length && steamIds.length
      ? getSqliteRecordsByJsonFields('kdaSnapshots', [
        { field: 'wipeId', values: liveWipeIds },
        { field: 'steamId', values: steamIds }
      ], { limit: 0 })
      : Promise.resolve([])
  ]);
  const userIds = uniqueNormalizedTexts(users.map((user) => user.id), 120);
  const userSessions = userIds.length
    ? await getSqliteRecordsByJsonField('sessions', 'userId', userIds, { limit: 0 })
    : sessions;
  return {
    members,
    users,
    sessions: userSessions,
    squads,
    squadMembers,
    wipes,
    permissionRoles,
    wipeParticipants: mergeRecordsById(wipeParticipantsByMemberId, wipeParticipantsBySteamId),
    kdaRows: mergeRecordsById(kdaRowsByMemberId, kdaRowsBySteamId),
    kdaSnapshots: mergeRecordsById(kdaSnapshotsByMemberId, kdaSnapshotsBySteamId),
    memberProfiles,
    accountAlertDismissals,
    wechatUsers: mergeRecordsById(wechatUsersByMemberId, wechatUsersById),
    settings: {},
    syncState: {}
  };
}

export async function readWechatAdminMemberDeleteRuntimeStore(member) {
  return readMemberDeleteRuntimeStore([member], { includeWechatUsers: true });
}
