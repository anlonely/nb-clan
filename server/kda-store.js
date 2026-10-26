import { normalizeText, patchStoreCache, readStore, runStoreWriteTask, updateStore } from './store.js';
import {
  getSqliteCollection,
  getSqliteRecord,
  getSqliteRecordsByJsonField,
  getSqliteRecordsWhereJsonFieldPresent,
  getSqliteScalar,
  writeSqliteStorePatch
} from './storage/repository.js';
import {
  applyStoreCollectionCachePatch,
  diffStoreCollections,
  snapshotStoreCollections
} from './storage/store-patch-diff.js';
import { sqliteEnabled, sqlitePrimaryMode } from './storage/sqlite.js';
import { readRuntimeSyncJobs } from './sync-job-store.js';
import {
  mergeRecordsById,
  readSqliteRecordsByIds,
  uniqueNormalizedTexts
} from './sqlite-read-utils.js';
import {
  currentWipe,
  isWipeStartedServer,
  kdaSyncUsesAllMembers
} from './wipe-utils.js';

const DISCORD_ID_MAX_LENGTH = 32;

function kdaStoreReadUnavailableError(label, cause) {
  return Object.assign(new Error(`${label}暂不可用，请稍后重试`), {
    status: 503,
    code: 'kda_store_read_unavailable',
    skipApiErrorLog: true,
    cause
  });
}

function timestampForSort(value) {
  const time = Date.parse(value || '');
  return Number.isFinite(time) ? time : 0;
}

function latestClosedWipe(store) {
  return (store.wipes || [])
    .filter((wipe) => wipe.status === 'closed')
    .toSorted((left, right) => {
      const rightTime = timestampForSort(right.closedAt || right.updatedAt || right.startedAt);
      const leftTime = timestampForSort(left.closedAt || left.updatedAt || left.startedAt);
      return rightTime - leftTime;
    })[0] || null;
}

function queryReferenceWipe(store) {
  const active = currentWipe(store);
  if (active && isWipeStartedServer(active)) return active;
  return latestClosedWipe(store) || active || null;
}

function normalizeRuntimeWipeIds(value) {
  return uniqueNormalizedTexts(value, 120).filter((item) => item !== 'current');
}

async function sqliteWipeHasKdaRows(wipeId) {
  const normalizedWipeId = normalizeText(wipeId, 120);
  if (!normalizedWipeId) return false;
  const rows = await getSqliteRecordsByJsonField('kdaRows', 'wipeId', [normalizedWipeId], { limit: 1 });
  return rows.length > 0;
}

async function resolveRuntimeWipeIds(wipes = [], options = {}) {
  const explicitIds = normalizeRuntimeWipeIds(options.wipeIds);
  if (explicitIds.length) return explicitIds;
  const requestedWipeId = normalizeText(options.requestedWipeId || options.wipeId, 120);
  if (requestedWipeId && requestedWipeId !== 'current') return [requestedWipeId];

  const reference = normalizeText(options.reference, 40);
  if (!reference) return [];
  const wipeStore = { wipes };
  if (reference === 'current') return normalizeRuntimeWipeIds(currentWipe(wipeStore)?.id);
  if (reference === 'wechatRanking') {
    const active = currentWipe(wipeStore);
    if (active && isWipeStartedServer(active) && await sqliteWipeHasKdaRows(active.id)) {
      return normalizeRuntimeWipeIds(active.id);
    }
    return normalizeRuntimeWipeIds((latestClosedWipe(wipeStore) || active)?.id);
  }
  return normalizeRuntimeWipeIds(queryReferenceWipe(wipeStore)?.id);
}

async function readKdaRuntimeWipes(options = {}) {
  const explicitIds = normalizeRuntimeWipeIds(options.wipeIds);
  if (explicitIds.length) return readSqliteRecordsByIds('wipes', explicitIds);
  const requestedWipeId = normalizeText(options.requestedWipeId || options.wipeId, 120);
  if (requestedWipeId && requestedWipeId !== 'current') {
    return readSqliteRecordsByIds('wipes', [requestedWipeId]);
  }
  return getSqliteCollection('wipes', { limit: 0 });
}

async function readScopedSqliteCollection(collection, field, ids, fallbackOptions = { limit: 0 }) {
  return ids.length
    ? getSqliteRecordsByJsonField(collection, field, ids, { limit: 0 })
    : getSqliteCollection(collection, fallbackOptions);
}

async function readScopedSqliteUploadsForWipes(wipeIds = []) {
  const scopedWipeIds = uniqueNormalizedTexts(wipeIds, 120);
  return scopedWipeIds.length
    ? getSqliteRecordsByJsonField('uploads', 'ownerId', scopedWipeIds, { limit: 0 })
    : getSqliteCollection('uploads', { limit: 0 });
}

function shouldIncludeKdaRuntimeSnapshots(options = {}) {
  return Boolean(options.includeKdaSnapshots || options.includeSnapshots || options.timeRange?.requested);
}

async function readScopedSqliteMemberProfilesForKdaScope({
  wipeIds = [],
  wipeParticipants = [],
  kdaRows = [],
  wipeSettlements = [],
  includeAllMemberProfiles = false
} = {}) {
  if (includeAllMemberProfiles) return getSqliteCollection('memberProfiles', { limit: 0 });
  const scopedWipeIds = uniqueNormalizedTexts(wipeIds, 120);
  if (!scopedWipeIds.length) return getSqliteCollection('memberProfiles', { limit: 0 });

  const settlementParticipants = wipeSettlements.flatMap((settlement) => settlement?.participantsSnapshot || []);
  const settlementRows = wipeSettlements.flatMap((settlement) => settlement?.kdaSnapshot || []);
  const memberIds = uniqueNormalizedTexts([
    ...wipeParticipants.map((participant) => participant.memberId),
    ...kdaRows.map((row) => row.memberId),
    ...settlementParticipants.map((participant) => participant.memberId),
    ...settlementRows.map((row) => row.memberId)
  ], 120);
  const steamIds = uniqueNormalizedTexts([
    ...wipeParticipants.map((participant) => participant.member?.steamId || participant.steamId),
    ...kdaRows.map((row) => row.steamId),
    ...settlementParticipants.map((participant) => participant.member?.steamId || participant.steamId),
    ...settlementRows.map((row) => row.steamId)
  ], 80);
  const [profilesByMemberId, profilesBySteamId] = await Promise.all([
    memberIds.length ? getSqliteRecordsByJsonField('memberProfiles', 'memberId', memberIds, { limit: 0 }) : Promise.resolve([]),
    steamIds.length ? getSqliteRecordsByJsonField('memberProfiles', 'steamId', steamIds, { limit: 0 }) : Promise.resolve([])
  ]);
  return mergeRecordsById(profilesByMemberId, profilesBySteamId);
}

function kdaScopeMemberRefs({
  wipeParticipants = [],
  kdaRows = [],
  wipeSettlements = []
} = {}) {
  const settlementParticipants = wipeSettlements.flatMap((settlement) => settlement?.participantsSnapshot || []);
  const settlementRows = wipeSettlements.flatMap((settlement) => settlement?.kdaSnapshot || []);
  return {
    memberIds: uniqueNormalizedTexts([
      ...wipeParticipants.map((participant) => participant.memberId),
      ...kdaRows.map((row) => row.memberId),
      ...settlementParticipants.map((participant) => participant.memberId),
      ...settlementRows.map((row) => row.memberId)
    ], 120),
    steamIds: uniqueNormalizedTexts([
      ...wipeParticipants.map((participant) => participant.member?.steamId || participant.steamId),
      ...kdaRows.map((row) => row.steamId),
      ...settlementParticipants.map((participant) => participant.member?.steamId || participant.steamId),
      ...settlementRows.map((row) => row.steamId)
    ], 80),
    squadIds: uniqueNormalizedTexts([
      ...wipeParticipants.map((participant) => participant.squadId),
      ...kdaRows.map((row) => row.squadId),
      ...settlementParticipants.map((participant) => participant.squadId),
      ...settlementRows.map((row) => row.squadId),
      ...wipeSettlements.flatMap((settlement) => settlement?.squadsSnapshot || []).map((squad) => squad.id)
    ], 120)
  };
}

async function readScopedSqliteMembersForKdaScope(scope = {}) {
  const { memberIds, steamIds } = kdaScopeMemberRefs(scope);
  const [membersById, membersBySteamId] = await Promise.all([
    memberIds.length ? readSqliteRecordsByIds('members', memberIds) : Promise.resolve([]),
    steamIds.length ? getSqliteRecordsByJsonField('members', 'steamId', steamIds, { limit: 0 }) : Promise.resolve([])
  ]);
  return mergeRecordsById(membersById, membersBySteamId);
}

async function readScopedSqliteSquadMembersForKdaScope(scope = {}, members = []) {
  const refs = kdaScopeMemberRefs(scope);
  const memberIds = uniqueNormalizedTexts([
    ...refs.memberIds,
    ...(members || []).map((member) => member.id)
  ], 120);
  return memberIds.length
    ? getSqliteRecordsByJsonField('squadMembers', 'memberId', memberIds, { limit: 0 })
    : [];
}

async function readScopedSqliteSquadsForKdaScope(scope = {}, squadMembers = []) {
  const refs = kdaScopeMemberRefs(scope);
  const squadIds = uniqueNormalizedTexts([
    ...refs.squadIds,
    ...(squadMembers || []).map((item) => item.squadId)
  ], 120);
  return squadIds.length ? readSqliteRecordsByIds('squads', squadIds) : [];
}

async function readScopedSqliteDiscordApplicationsForRanking({
  wipeIds = [],
  members = [],
  wipeParticipants = [],
  kdaRows = [],
  wipeSettlements = []
} = {}) {
  const scopedWipeIds = uniqueNormalizedTexts(wipeIds, 120);
  if (!scopedWipeIds.length) return getSqliteCollection('discordMemberApplications', { limit: 0 });

  const settlementParticipants = wipeSettlements.flatMap((settlement) => settlement?.participantsSnapshot || []);
  const settlementRows = wipeSettlements.flatMap((settlement) => settlement?.kdaSnapshot || []);
  const memberIds = new Set(uniqueNormalizedTexts([
    ...wipeParticipants.map((participant) => participant.memberId),
    ...kdaRows.map((row) => row.memberId),
    ...settlementParticipants.map((participant) => participant.memberId),
    ...settlementRows.map((row) => row.memberId)
  ], 120));
  const steamIds = new Set(uniqueNormalizedTexts([
    ...wipeParticipants.map((participant) => participant.member?.steamId || participant.steamId),
    ...kdaRows.map((row) => row.steamId),
    ...settlementParticipants.map((participant) => participant.member?.steamId || participant.steamId),
    ...settlementRows.map((row) => row.steamId)
  ], 80));
  const discordIds = uniqueNormalizedTexts(
    (members || [])
      .filter((member) => memberIds.has(normalizeText(member.id, 120)) || steamIds.has(normalizeText(member.steamId, 80)))
      .map((member) => member.discordId),
    DISCORD_ID_MAX_LENGTH
  );
  return discordIds.length
    ? getSqliteRecordsByJsonField('discordMemberApplications', 'discordUserId', discordIds, { limit: 0 })
    : [];
}

export async function readKdaRuntimeStore(options = {}) {
  if (!sqliteEnabled()) return readStore();
  const scopeMembersToRows = Boolean(sqlitePrimaryMode() && options.scopeMembersToRows);
  try {
    const [
      users,
      baseMembers,
      baseSquads,
      baseSquadMembers,
      wipes,
      basePermissionRoles,
      settings,
      syncState,
      syncJobs
    ] = await Promise.all([
      scopeMembersToRows ? Promise.resolve([]) : getSqliteCollection('users', { limit: 0 }),
      scopeMembersToRows ? Promise.resolve([]) : getSqliteCollection('members', { limit: 0 }),
      scopeMembersToRows ? Promise.resolve([]) : getSqliteCollection('squads', { limit: 0 }),
      scopeMembersToRows ? Promise.resolve([]) : getSqliteCollection('squadMembers', { limit: 0 }),
      readKdaRuntimeWipes(options),
      scopeMembersToRows ? Promise.resolve([]) : getSqliteCollection('permissionRoles', { limit: 0 }),
      getSqliteScalar('settings'),
      getSqliteScalar('syncState'),
      readRuntimeSyncJobs(options)
    ]);
    if (!sqlitePrimaryMode() && !baseMembers.length && !wipes.length) return readStore();
    const scopedWipeIds = await resolveRuntimeWipeIds(wipes, options);
    const includeKdaSnapshots = shouldIncludeKdaRuntimeSnapshots(options);
    const [wipeParticipants, kdaRows, kdaSnapshots, wipeSettlements] = await Promise.all([
      readScopedSqliteCollection('wipeParticipants', 'wipeId', scopedWipeIds, { limit: 0 }),
      readScopedSqliteCollection('kdaRows', 'wipeId', scopedWipeIds, { limit: 0 }),
      includeKdaSnapshots
        ? readScopedSqliteCollection('kdaSnapshots', 'wipeId', scopedWipeIds, { limit: 0 })
        : Promise.resolve([]),
      readScopedSqliteCollection('wipeSettlements', 'wipeId', scopedWipeIds, { limit: 0 })
    ]);
    const scope = { wipeIds: scopedWipeIds, wipeParticipants, kdaRows, wipeSettlements };
    const members = scopeMembersToRows ? await readScopedSqliteMembersForKdaScope(scope) : baseMembers;
    const squadMembers = scopeMembersToRows ? await readScopedSqliteSquadMembersForKdaScope(scope, members) : baseSquadMembers;
    const squads = scopeMembersToRows ? await readScopedSqliteSquadsForKdaScope(scope, squadMembers) : baseSquads;
    const [memberProfiles, uploads] = await Promise.all([
      readScopedSqliteMemberProfilesForKdaScope({
        wipeIds: scopedWipeIds,
        wipeParticipants,
        kdaRows,
        wipeSettlements,
        includeAllMemberProfiles: Boolean(options.includeAllMemberProfiles)
      }),
      readScopedSqliteUploadsForWipes(scopedWipeIds)
    ]);
    return {
      users,
      members,
      squads,
      squadMembers,
      wipes,
      wipeParticipants,
      kdaRows,
      kdaSnapshots,
      memberProfiles,
      permissionRoles: basePermissionRoles,
      uploads,
      wipeSettlements,
      settings: settings || {},
      syncState: syncState || {},
      syncJobs
    };
  } catch (error) {
    console.warn('[nb-clan] sqlite kda runtime store fallback:', error?.message || error);
    if (sqlitePrimaryMode()) throw kdaStoreReadUnavailableError('KDA 数据读取', error);
    return readStore();
  }
}

export async function readKdaWriteStore(options = {}) {
  if (!sqlitePrimaryMode()) return readStore();
  try {
    const includeLogs = options.includeLogs !== false;
    // KDA/BattleMetrics writers can touch any member while their wipe rows are scoped.
    // Load the complete profile collection before diffing so an existing memberId row
    // is updated instead of being re-created with a new id.
    const runtimeOptions = { ...options, includeKdaSnapshots: true, includeAllMemberProfiles: true };
    const [store, logs, syncState] = await Promise.all([
      readKdaRuntimeStore(runtimeOptions),
      includeLogs ? getSqliteCollection('logs', { limit: 1000 }) : Promise.resolve([]),
      getSqliteScalar('syncState')
    ]);
    return {
      ...store,
      logs,
      syncState: syncState || {}
    };
  } catch (error) {
    console.warn('[nb-clan] sqlite kda write store fallback:', error?.message || error);
    if (sqlitePrimaryMode()) throw kdaStoreReadUnavailableError('KDA 写入前置读取', error);
    return readStore();
  }
}

export async function updateKdaWriteStore(mutator, reason = 'kda_write', readOptions = {}) {
  if (!sqlitePrimaryMode()) return updateStore(mutator);
  return runStoreWriteTask(async () => {
    const store = await readKdaWriteStore(readOptions);
    const collectionNames = [
      'members',
      'memberProfiles',
      'wipes',
      'kdaRows',
      'kdaSnapshots',
      'wipeSettlements',
      ...(readOptions.includeLogs === false ? [] : ['logs']),
      ...(readOptions.syncJobs === false || readOptions.syncJobs === 'none' ? [] : ['syncJobs'])
    ];
    const before = snapshotStoreCollections(store, collectionNames);
    const result = await mutator(store);
    const { upserts, deletes } = diffStoreCollections(before, store, collectionNames);
    await writeSqliteStorePatch({
      reason,
      upserts,
      deletes,
      scalars: {
        settings: store.settings || {},
        syncState: store.syncState || {}
      }
    });
    await patchStoreCache((cachedStore) => {
      applyStoreCollectionCachePatch(cachedStore, collectionNames, upserts, deletes);
      cachedStore.settings = store.settings || {};
      cachedStore.syncState = store.syncState || {};
    });
    return result;
  });
}

export async function readGeneratedKdaRowsWriteStore(wipeId, options = {}) {
  const normalizedWipeId = normalizeText(wipeId, 120);
  const includeSettlementCollections = Boolean(options.refreshSettlement);
  const [
    wipe,
    wipeParticipants,
    kdaRows,
    kdaSnapshots,
    wipeSettlements,
    squads,
    squadMembers
  ] = await Promise.all([
    normalizedWipeId ? getSqliteRecord('wipes', normalizedWipeId) : Promise.resolve(null),
    normalizedWipeId ? getSqliteRecordsByJsonField('wipeParticipants', 'wipeId', [normalizedWipeId], { limit: 0 }) : Promise.resolve([]),
    normalizedWipeId ? getSqliteRecordsByJsonField('kdaRows', 'wipeId', [normalizedWipeId], { limit: 0 }) : Promise.resolve([]),
    normalizedWipeId ? getSqliteRecordsByJsonField('kdaSnapshots', 'wipeId', [normalizedWipeId], { limit: 0 }) : Promise.resolve([]),
    includeSettlementCollections && normalizedWipeId ? getSqliteRecordsByJsonField('wipeSettlements', 'wipeId', [normalizedWipeId], { limit: 0 }) : Promise.resolve([]),
    includeSettlementCollections ? getSqliteCollection('squads', { limit: 0 }) : Promise.resolve([]),
    includeSettlementCollections ? getSqliteCollection('squadMembers', { limit: 0 }) : Promise.resolve([])
  ]);
  const participantMemberIds = uniqueNormalizedTexts(wipeParticipants.map((participant) => participant.memberId), 120);
  const usesAllMemberKdaSource = kdaSyncUsesAllMembers({ wipes: wipe ? [wipe] : [] }, wipe);
  const participantMembers = (!usesAllMemberKdaSource || includeSettlementCollections) && participantMemberIds.length
    ? await readSqliteRecordsByIds('members', participantMemberIds)
    : [];
  const members = usesAllMemberKdaSource
    ? mergeRecordsById(
        await getSqliteRecordsWhereJsonFieldPresent('members', 'steamId', { limit: 0 }),
        participantMembers
      )
    : participantMembers;
  return {
    users: [],
    members,
    squads,
    squadMembers,
    wipes: wipe ? [wipe] : [],
    wipeParticipants,
    kdaRows,
    kdaSnapshots,
    memberProfiles: [],
    permissionRoles: [],
    uploads: [],
    wipeSettlements,
    settings: {},
    syncState: {},
    syncJobs: []
  };
}

export async function readMemberKdaSyncRequestStore(memberId = '', steamId = '') {
  if (!sqlitePrimaryMode()) return readKdaRuntimeStore({ reference: 'wechatRanking' });
  const normalizedMemberId = normalizeText(memberId, 120);
  const normalizedSteamId = normalizeText(steamId, 80);
  try {
    const [wipes, memberById, membersBySteamId, wipeParticipants] = await Promise.all([
      getSqliteRecordsByJsonField('wipes', 'status', ['active', 'closed'], { limit: 0 }),
      normalizedMemberId ? readSqliteRecordsByIds('members', [normalizedMemberId]) : Promise.resolve([]),
      normalizedSteamId ? getSqliteRecordsByJsonField('members', 'steamId', [normalizedSteamId], { limit: 0 }) : Promise.resolve([]),
      normalizedMemberId ? getSqliteRecordsByJsonField('wipeParticipants', 'memberId', [normalizedMemberId], { limit: 0 }) : Promise.resolve([])
    ]);
    return {
      users: [],
      members: mergeRecordsById(memberById, membersBySteamId),
      squads: [],
      squadMembers: [],
      wipes,
      wipeParticipants,
      kdaRows: [],
      kdaSnapshots: [],
      memberProfiles: [],
      permissionRoles: [],
      uploads: [],
      wipeSettlements: [],
      settings: {},
      syncState: {},
      syncJobs: []
    };
  } catch (error) {
    console.warn('[nb-clan] sqlite member kda sync request fallback:', error?.message || error);
    if (sqlitePrimaryMode()) throw kdaStoreReadUnavailableError('成员 KDA 同步前置读取', error);
    return readKdaRuntimeStore({ reference: 'wechatRanking' });
  }
}

export async function readMemberRankingRuntimeStore(options = {}) {
  if (!sqliteEnabled()) return readStore();
  const scopeMembersToRows = Boolean(options.scopeMembersToRows);
  try {
    const [
      baseMembers,
      baseSquads,
      baseSquadMembers,
      wipes,
      settings
    ] = await Promise.all([
      scopeMembersToRows ? Promise.resolve([]) : getSqliteCollection('members', { limit: 0 }),
      scopeMembersToRows ? Promise.resolve([]) : getSqliteCollection('squads', { limit: 0 }),
      scopeMembersToRows ? Promise.resolve([]) : getSqliteCollection('squadMembers', { limit: 0 }),
      getSqliteCollection('wipes', { limit: 0 }),
      getSqliteScalar('settings')
    ]);
    if (!sqlitePrimaryMode() && !scopeMembersToRows && !baseMembers.length && !wipes.length) return readStore();
    const scopedWipeIds = await resolveRuntimeWipeIds(wipes, options);
    const readWipeScopedCollection = (collection) => (
      scopedWipeIds.length
        ? getSqliteRecordsByJsonField(collection, 'wipeId', scopedWipeIds, { limit: 0 })
        : (scopeMembersToRows ? Promise.resolve([]) : getSqliteCollection(collection, { limit: 0 }))
    );
    const [wipeParticipants, kdaRows, wipeSettlements] = await Promise.all([
      readWipeScopedCollection('wipeParticipants'),
      readWipeScopedCollection('kdaRows'),
      readWipeScopedCollection('wipeSettlements')
    ]);
    const scope = { wipeIds: scopedWipeIds, wipeParticipants, kdaRows, wipeSettlements };
    const members = scopeMembersToRows ? await readScopedSqliteMembersForKdaScope(scope) : baseMembers;
    const squadMembers = scopeMembersToRows ? await readScopedSqliteSquadMembersForKdaScope(scope, members) : baseSquadMembers;
    const squads = scopeMembersToRows ? await readScopedSqliteSquadsForKdaScope(scope, squadMembers) : baseSquads;
    const [memberProfiles, discordMemberApplications] = await Promise.all([
      scopeMembersToRows && !scopedWipeIds.length
        ? Promise.resolve([])
        : readScopedSqliteMemberProfilesForKdaScope(scope),
      scopeMembersToRows && !scopedWipeIds.length
        ? Promise.resolve([])
        : readScopedSqliteDiscordApplicationsForRanking({ ...scope, members })
    ]);
    return {
      users: [],
      members,
      squads,
      squadMembers,
      wipes,
      wipeParticipants,
      kdaRows,
      memberProfiles,
      wechatUsers: [],
      discordMemberApplications,
      uploads: [],
      wipeSettlements,
      settings: settings || {},
      syncState: {}
    };
  } catch (error) {
    console.warn('[nb-clan] sqlite member ranking runtime store fallback:', error?.message || error);
    if (sqlitePrimaryMode()) throw kdaStoreReadUnavailableError('成员排名读取', error);
    return readStore();
  }
}
