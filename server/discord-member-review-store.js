import { normalizeText, patchStoreCache, readStore, runStoreWriteTask, updateStore } from './store.js';
import {
  countSqliteRecordsByJsonField,
  countSqliteRecordsWhereJsonFieldMissing,
  getSqliteCollection,
  getSqliteRecord,
  getSqliteRecordsByJsonField,
  getSqliteRecordsWhereJsonFieldMissing,
  getSqliteScalar,
  writeSqliteStorePatch
} from './storage/repository.js';
import {
  applyStoreCollectionCachePatch,
  replaceCachedRecord
} from './storage/store-patch-diff.js';
import { sqliteEnabled, sqlitePrimaryMode } from './storage/sqlite.js';
import {
  mergeRecordsById,
  readSqliteRecordsByIds,
  uniqueNormalizedTexts
} from './sqlite-read-utils.js';
import { hydrateMemberScopedRuntimeStore } from './member-store.js';
import {
  applyCachedLogPatch,
  logTrimPatch,
  trimmedLogIds
} from './audit-logs.js';

const DISCORD_MEMBER_REVIEW_CARD_WRITE_COLLECTIONS = [
  'discordMemberApplications',
  'integrationMessageRefs',
  'operationRuns',
  'logs'
];
const DISCORD_MEMBER_REVIEW_CARD_BACKFILL_STATUSES = ['pending', 'need_more', 'approved', 'rejected'];
const DISCORD_MEMBER_REVIEW_CARD_ACTIVE_STATUSES = new Set(['pending', 'need_more']);
const DISCORD_MEMBER_REVIEW_APPLICATION_STATUSES = ['pending', 'need_more', 'approved', 'rejected', 'cancelled'];
const DISCORD_MEMBER_REVIEW_LEGACY_REVIEW_FIELDS = ['reviewedAt', 'reviewedByUserId', 'reviewNote', 'adminNote'];

function discordMemberReviewPartialStore(error, source = '', extra = {}) {
  return {
    members: [],
    squads: [],
    squadMembers: [],
    discordMemberApplications: [],
    memberProfiles: [],
    integrationMessageRefs: [],
    operationRuns: [],
    logs: [],
    settings: {},
    users: [],
    wipes: [],
    wipeParticipants: [],
    kdaRows: [],
    syncState: {},
    discordMemberReviewPartial: true,
    discordMemberReviewReadError: normalizeText(error?.message || error, 500),
    discordMemberReviewReadSource: normalizeText(source, 120),
    ...extra
  };
}

function discordMemberReviewApplicationStatus(record = {}) {
  const explicitStatus = normalizeText(record?.status, 40);
  if (explicitStatus) return explicitStatus;
  if (record?.reviewedAt || record?.reviewedByUserId || record?.reviewNote || record?.adminNote) return 'closed';
  return 'pending';
}

async function readDiscordReviewMembersBySteamIds(steamIds = []) {
  const normalizedSteamIds = uniqueNormalizedTexts(steamIds, 80);
  if (!normalizedSteamIds.length) return [];
  const chunks = [];
  for (let index = 0; index < normalizedSteamIds.length; index += 500) {
    chunks.push(normalizedSteamIds.slice(index, index + 500));
  }
  const results = await Promise.all(chunks.map((chunk) => (
    getSqliteRecordsByJsonField('members', 'steamId', chunk, { limit: 0 })
  )));
  return mergeRecordsById(...results);
}

async function hydrateDiscordReviewMemberRuntimeContext(store, members = []) {
  await hydrateMemberScopedRuntimeStore(store, members.map((member) => member.id));
  const wipeIds = new Set();
  const battlemetricsServerIds = new Set();
  const addWipeId = (value) => {
    const normalized = normalizeText(value, 120);
    if (normalized) wipeIds.add(normalized);
  };
  const addBattlemetricsServerId = (value) => {
    const normalized = normalizeText(value, 80);
    if (normalized) battlemetricsServerIds.add(normalized);
  };
  for (const member of members || []) {
    addWipeId(member.battlemetricsWipeId);
    addBattlemetricsServerId(member.battlemetricsServerId);
  }
  for (const profile of store.memberProfiles || []) {
    addWipeId(profile.wipeId);
    addWipeId(profile.battlemetricsWipeId);
    addBattlemetricsServerId(profile.battlemetricsServerId);
  }
  for (const participant of store.wipeParticipants || []) {
    addWipeId(participant.wipeId);
    addWipeId(participant.battlemetricsWipeId);
    addBattlemetricsServerId(participant.battlemetricsServerId);
    addWipeId(participant.onlineSummary?.wipeId);
    addWipeId(participant.onlineSummary?.battlemetricsWipeId);
    addBattlemetricsServerId(participant.onlineSummary?.battlemetricsServerId);
  }
  for (const row of store.kdaRows || []) {
    addWipeId(row.wipeId);
    addWipeId(row.battlemetricsWipeId);
    addBattlemetricsServerId(row.battlemetricsServerId);
    addWipeId(row.onlineSummary?.wipeId);
    addWipeId(row.onlineSummary?.battlemetricsWipeId);
    addBattlemetricsServerId(row.onlineSummary?.battlemetricsServerId);
  }
  const [wipesById, wipesByBattlemetricsId] = await Promise.all([
    wipeIds.size ? readSqliteRecordsByIds('wipes', [...wipeIds]) : Promise.resolve([]),
    battlemetricsServerIds.size
      ? getSqliteRecordsByJsonField('wipes', 'battlemetricsId', [...battlemetricsServerIds], { limit: 0 })
      : Promise.resolve([])
  ]);
  store.wipes = mergeRecordsById(store.wipes || [], wipesById, wipesByBattlemetricsId);
  return store;
}

function hasScopedValuesOption(value) {
  return Array.isArray(value) || value instanceof Set;
}

async function readDiscordMemberApplicationsByRuntimeScope(options = {}) {
  const applicationIdSource = Object.hasOwn(options, 'applicationIds') ? options.applicationIds : options.ids;
  if (hasScopedValuesOption(applicationIdSource)) {
    const applicationIds = uniqueNormalizedTexts([...applicationIdSource], 120);
    return applicationIds.length ? readSqliteRecordsByIds('discordMemberApplications', applicationIds) : [];
  }
  if (hasScopedValuesOption(options.statuses)) {
    const statuses = uniqueNormalizedTexts([...options.statuses], 40);
    const [statusApplications, legacyApplications] = await Promise.all([
      statuses.length
        ? getSqliteRecordsByJsonField('discordMemberApplications', 'status', statuses, { limit: 0 })
        : Promise.resolve([]),
      statuses.includes('pending') || options.includeLegacyPending
        ? getSqliteRecordsWhereJsonFieldMissing('discordMemberApplications', 'status', { limit: 0 })
        : Promise.resolve([])
    ]);
    return mergeRecordsById(statusApplications, legacyApplications);
  }
  return null;
}

async function readDiscordMemberApplicationStatusCounts() {
  const [statusCounts, legacyPendingCount, legacyClosedCount] = await Promise.all([
    countSqliteRecordsByJsonField('discordMemberApplications', 'status', DISCORD_MEMBER_REVIEW_APPLICATION_STATUSES),
    countSqliteRecordsWhereJsonFieldMissing('discordMemberApplications', 'status', {
      additionalMissingFields: DISCORD_MEMBER_REVIEW_LEGACY_REVIEW_FIELDS
    }),
    countSqliteRecordsWhereJsonFieldMissing('discordMemberApplications', 'status', {
      additionalAnyPresentFields: DISCORD_MEMBER_REVIEW_LEGACY_REVIEW_FIELDS
    })
  ]);
  const counts = Object.fromEntries(DISCORD_MEMBER_REVIEW_APPLICATION_STATUSES.map((status) => [
    status,
    Number(statusCounts?.[status] || 0)
  ]));
  counts.pending = Number(counts.pending || 0) + Number(legacyPendingCount || 0);
  if (legacyClosedCount) counts.closed = Number(legacyClosedCount || 0);
  return counts;
}

export async function readDiscordMemberApplicationListStore(options = {}) {
  if (!sqlitePrimaryMode()) return readStore();
  const status = normalizeText(options.status, 40);
  const statuses = status && status !== 'all' && DISCORD_MEMBER_REVIEW_APPLICATION_STATUSES.includes(status)
    ? [status]
    : null;
  const includeLegacyPending = status === 'pending';
  try {
    const scopedApplications = await readDiscordMemberApplicationsByRuntimeScope(statuses
      ? { statuses, includeLegacyPending }
      : {});
    const [
      settings,
      applicationCounts
    ] = await Promise.all([
      getSqliteScalar('settings'),
      readDiscordMemberApplicationStatusCounts()
    ]);
    const discordMemberApplications = scopedApplications || await getSqliteCollection('discordMemberApplications', { limit: 0 });
    const memberIds = uniqueNormalizedTexts(discordMemberApplications.map((application) => application.memberId), 120);
    const steamIds = uniqueNormalizedTexts(discordMemberApplications.map((application) => application.steamId), 80);
    const discordIds = uniqueNormalizedTexts(discordMemberApplications.map((application) => application.discordUserId), 32);
    const [membersById, membersBySteamId, membersByDiscordId] = await Promise.all([
      memberIds.length ? readSqliteRecordsByIds('members', memberIds) : Promise.resolve([]),
      readDiscordReviewMembersBySteamIds(steamIds),
      discordIds.length ? getSqliteRecordsByJsonField('members', 'discordId', discordIds, { limit: 0 }) : Promise.resolve([])
    ]);
    const members = mergeRecordsById(membersById, membersBySteamId, membersByDiscordId);
    const store = {
      members,
      squads: [],
      squadMembers: [],
      discordMemberApplications,
      memberProfiles: [],
      integrationMessageRefs: [],
      logs: [],
      settings: settings || {},
      users: [],
      wipes: [],
      wipeParticipants: [],
      kdaRows: [],
      syncState: {},
      summaryApplicationCounts: applicationCounts
    };
    return store;
  } catch (error) {
    console.warn('[nb-clan] sqlite Discord member application list fallback:', error?.message || error);
    return discordMemberReviewPartialStore(error, 'application_list');
  }
}

function discordMemberReviewCardPatchSignature(value) {
  return JSON.stringify(value ?? null);
}

function discordMemberReviewCardCollectionPatch(beforeCollections = {}, store = {}) {
  const upserts = {};
  const deletes = {};
  const positions = {};
  for (const collection of DISCORD_MEMBER_REVIEW_CARD_WRITE_COLLECTIONS) {
    const beforeItems = beforeCollections[collection] || [];
    const afterItems = Array.isArray(store[collection]) ? store[collection] : [];
    const beforeMap = new Map(beforeItems.map((item) => [
      item?.id,
      discordMemberReviewCardPatchSignature(item)
    ]).filter(([id]) => Boolean(id)));
    const afterIds = new Set();
    afterItems.forEach((item, index) => {
      if (!item?.id) return;
      afterIds.add(item.id);
      if (beforeMap.get(item.id) === discordMemberReviewCardPatchSignature(item)) return;
      upserts[collection] ||= [];
      upserts[collection].push(item);
      positions[collection] ||= {};
      positions[collection][item.id] = index;
    });
    for (const id of beforeMap.keys()) {
      if (afterIds.has(id)) continue;
      deletes[collection] ||= [];
      deletes[collection].push(id);
    }
  }
  return { upserts, deletes, positions };
}

function discordMemberReviewCardPatchHasChanges(patch = {}) {
  return ['upserts', 'deletes', 'scalars'].some((key) => (
    Object.values(patch[key] || {}).some((value) => (
      Array.isArray(value) ? value.length > 0 : value !== undefined
    ))
  ));
}

export async function readDiscordMemberReviewCardBackfillStore(options = {}) {
  if (!sqliteEnabled()) return readStore();
  const scopedIds = options.ids instanceof Set
    ? [...options.ids].map((item) => normalizeText(item, 120)).filter(Boolean)
    : (Array.isArray(options.ids) ? options.ids.map((item) => normalizeText(item, 120)).filter(Boolean) : []);
  try {
    if (scopedIds.length) {
      const [settings, discordMemberApplications] = await Promise.all([
        getSqliteScalar('settings'),
        readSqliteRecordsByIds('discordMemberApplications', scopedIds)
      ]);
      const steamIds = [...new Set(discordMemberApplications.map((application) => normalizeText(application.steamId, 80)).filter(Boolean))];
      const members = steamIds.length
        ? await getSqliteRecordsByJsonField('members', 'steamId', steamIds, { limit: 0 })
        : [];
      return {
        settings: settings || {},
        discordMemberApplications,
        members
      };
    }
    const [settings, statusApplications, legacyApplications] = await Promise.all([
      getSqliteScalar('settings'),
      getSqliteRecordsByJsonField('discordMemberApplications', 'status', DISCORD_MEMBER_REVIEW_CARD_BACKFILL_STATUSES, { limit: 0 }),
      getSqliteRecordsWhereJsonFieldMissing('discordMemberApplications', 'status', { limit: 0 })
    ]);
    const discordMemberApplications = mergeRecordsById(statusApplications, legacyApplications);
    const activeSteamIds = discordMemberApplications
      .filter((application) => DISCORD_MEMBER_REVIEW_CARD_ACTIVE_STATUSES.has(discordMemberReviewApplicationStatus(application)))
      .map((application) => application.steamId);
    const members = await readDiscordReviewMembersBySteamIds(activeSteamIds);
    return {
      settings: settings || {},
      discordMemberApplications,
      members
    };
  } catch (error) {
    console.warn('[nb-clan] sqlite discord review card backfill fallback:', error?.message || error);
    return discordMemberReviewPartialStore(error, 'card_backfill');
  }
}

export async function readDiscordMemberReviewCardSyncStore(applicationId = '') {
  if (!sqliteEnabled()) return readStore();
  const normalizedApplicationId = normalizeText(applicationId, 120);
  try {
    const [settings, application, integrationMessageRefs, logs] = await Promise.all([
      getSqliteScalar('settings'),
      normalizedApplicationId ? getSqliteRecord('discordMemberApplications', normalizedApplicationId) : null,
      normalizedApplicationId
        ? getSqliteRecordsByJsonField('integrationMessageRefs', 'targetId', [normalizedApplicationId], { limit: 0 })
        : [],
      normalizedApplicationId
        ? getSqliteRecordsByJsonField('logs', 'targetId', [normalizedApplicationId], { limit: 0 })
        : []
    ]);
    const memberId = normalizeText(application?.memberId, 120);
    const steamId = normalizeText(application?.steamId, 80);
    const discordId = normalizeText(application?.discordUserId, 32);
    const [membersById, membersBySteamId, membersByDiscordId] = await Promise.all([
      memberId ? readSqliteRecordsByIds('members', [memberId]) : Promise.resolve([]),
      steamId ? getSqliteRecordsByJsonField('members', 'steamId', [steamId], { limit: 0 }) : Promise.resolve([]),
      discordId ? getSqliteRecordsByJsonField('members', 'discordId', [discordId], { limit: 0 }) : Promise.resolve([])
    ]);
    const members = mergeRecordsById(membersById, membersBySteamId, membersByDiscordId);
    return {
      settings: settings || {},
      discordMemberApplications: application ? [application] : [],
      members,
      integrationMessageRefs,
      logs,
      syncState: {}
    };
  } catch (error) {
    console.warn('[nb-clan] sqlite discord review card sync fallback:', error?.message || error);
    return discordMemberReviewPartialStore(error, 'card_sync');
  }
}

export async function updateDiscordMemberReviewCardResultStore(applicationId, mutator, reason = 'discord_member_review_card_result') {
  if (!sqlitePrimaryMode()) return updateStore(mutator);
  return runStoreWriteTask(async () => {
    const normalizedApplicationId = normalizeText(applicationId, 120);
    let settings = null;
    let application = null;
    let integrationMessageRefs = [];
    let operationRuns = [];
    try {
      [settings, application, integrationMessageRefs, operationRuns] = await Promise.all([
        getSqliteScalar('settings'),
        normalizedApplicationId ? getSqliteRecord('discordMemberApplications', normalizedApplicationId) : null,
        normalizedApplicationId
          ? getSqliteRecordsByJsonField('integrationMessageRefs', 'targetId', [normalizedApplicationId], { limit: 0 })
          : [],
        normalizedApplicationId
          ? getSqliteRecordsByJsonField('operationRuns', 'targetId', [normalizedApplicationId], { limit: 0 })
          : []
      ]);
    } catch (error) {
      console.warn('[nb-clan] sqlite discord review card write fallback:', error?.message || error);
      throw Object.assign(new Error(`discord member review card scoped write unavailable: ${error?.message || error}`), {
        code: 'sqlite_scoped_write_unavailable',
        cause: error
      });
    }
    const store = {
      settings: settings || {},
      discordMemberApplications: application ? [application] : [],
      integrationMessageRefs,
      operationRuns,
      logs: []
    };
    const beforeSettingsSignature = discordMemberReviewCardPatchSignature(store.settings);
    const beforeCollections = Object.fromEntries(DISCORD_MEMBER_REVIEW_CARD_WRITE_COLLECTIONS.map((collection) => [
      collection,
      Array.isArray(store[collection]) ? store[collection].map((item) => ({ ...item })) : []
    ]));
    const result = await mutator(store);
    const collectionPatch = discordMemberReviewCardCollectionPatch(beforeCollections, store);
    const scalars = {};
    if (beforeSettingsSignature !== discordMemberReviewCardPatchSignature(store.settings || {})) {
      scalars.settings = store.settings || {};
    }
    const patch = {
      ...collectionPatch,
      scalars
    };
    const shouldTrimLogs = Boolean(collectionPatch.upserts.logs?.length || collectionPatch.deletes.logs?.length);
    let patchResult = null;
    if (discordMemberReviewCardPatchHasChanges(patch)) {
      patchResult = await writeSqliteStorePatch({
        reason,
        ...patch,
        trims: shouldTrimLogs ? logTrimPatch() : {}
      });
    }
    await patchStoreCache((cachedStore) => {
      cachedStore.settings = store.settings || {};
      cachedStore.discordMemberApplications ||= [];
      const applicationDeletes = new Set(collectionPatch.deletes.discordMemberApplications || []);
      if (applicationDeletes.size) {
        cachedStore.discordMemberApplications = cachedStore.discordMemberApplications
          .filter((item) => !applicationDeletes.has(item?.id));
      }
      for (const item of collectionPatch.upserts.discordMemberApplications || []) {
        replaceCachedRecord(cachedStore.discordMemberApplications, item);
      }
      applyStoreCollectionCachePatch(cachedStore, ['integrationMessageRefs'], {
        integrationMessageRefs: collectionPatch.upserts.integrationMessageRefs || []
      }, {
        integrationMessageRefs: collectionPatch.deletes.integrationMessageRefs || []
      });
      applyStoreCollectionCachePatch(cachedStore, ['operationRuns'], {
        operationRuns: collectionPatch.upserts.operationRuns || []
      }, {
        operationRuns: collectionPatch.deletes.operationRuns || []
      });
      applyCachedLogPatch(cachedStore, collectionPatch.upserts.logs || [], [
        ...(collectionPatch.deletes.logs || []),
        ...trimmedLogIds(patchResult)
      ]);
    });
    return result;
  });
}

export async function readDiscordMemberApplicationRuntimeStore(options = {}) {
  if (!sqlitePrimaryMode()) return readStore();
  const normalizedApplicationId = normalizeText(options.applicationId, 120);
  try {
    if (normalizedApplicationId) {
      const [application, integrationMessageRefs, logs, settings] = await Promise.all([
        getSqliteRecord('discordMemberApplications', normalizedApplicationId),
        getSqliteRecordsByJsonField('integrationMessageRefs', 'targetId', [normalizedApplicationId], { limit: 0 }),
        getSqliteRecordsByJsonField('logs', 'targetId', [normalizedApplicationId], { limit: 0 }),
        getSqliteScalar('settings')
      ]);
      const memberId = normalizeText(application?.memberId, 120);
      const steamId = normalizeText(application?.steamId, 80);
      const [membersById, membersBySteamId] = await Promise.all([
        memberId ? readSqliteRecordsByIds('members', [memberId]) : Promise.resolve([]),
        steamId ? getSqliteRecordsByJsonField('members', 'steamId', [steamId], { limit: 0 }) : Promise.resolve([])
      ]);
      const members = mergeRecordsById(membersById, membersBySteamId);
      const store = {
        members,
        squads: [],
        squadMembers: [],
        discordMemberApplications: application ? [application] : [],
        memberProfiles: [],
        integrationMessageRefs,
        logs,
        settings: settings || {},
        users: [],
        wipes: [],
        wipeParticipants: [],
        kdaRows: [],
        syncState: {}
      };
      return hydrateDiscordReviewMemberRuntimeContext(store, members);
    }
    const scopedApplications = await readDiscordMemberApplicationsByRuntimeScope(options);
    if (scopedApplications) {
      const memberIds = uniqueNormalizedTexts(scopedApplications.map((application) => application.memberId), 120);
      const steamIds = uniqueNormalizedTexts(scopedApplications.map((application) => application.steamId), 80);
      const discordIds = uniqueNormalizedTexts(scopedApplications.map((application) => application.discordUserId), 32);
      const [settings, membersById, membersBySteamId, membersByDiscordId] = await Promise.all([
        getSqliteScalar('settings'),
        memberIds.length ? readSqliteRecordsByIds('members', memberIds) : Promise.resolve([]),
        readDiscordReviewMembersBySteamIds(steamIds),
        discordIds.length ? getSqliteRecordsByJsonField('members', 'discordId', discordIds, { limit: 0 }) : Promise.resolve([])
      ]);
      const members = mergeRecordsById(membersById, membersBySteamId, membersByDiscordId);
      const store = {
        members,
        squads: [],
        squadMembers: [],
        discordMemberApplications: scopedApplications,
        memberProfiles: [],
        integrationMessageRefs: [],
        logs: [],
        settings: settings || {},
        users: [],
        wipes: [],
        wipeParticipants: [],
        kdaRows: [],
        syncState: {}
      };
      return hydrateDiscordReviewMemberRuntimeContext(store, members);
    }
    const [
      members,
      squads,
      squadMembers,
      discordMemberApplications,
      memberProfiles,
      integrationMessageRefs,
      settings
    ] = await Promise.all([
      getSqliteCollection('members', { limit: 0 }),
      getSqliteCollection('squads', { limit: 0 }),
      getSqliteCollection('squadMembers', { limit: 0 }),
      getSqliteCollection('discordMemberApplications', { limit: 0 }),
      getSqliteCollection('memberProfiles', { limit: 0 }),
      getSqliteCollection('integrationMessageRefs', { limit: 1000 }),
      getSqliteScalar('settings')
    ]);
    return {
      members,
      squads,
      squadMembers,
      discordMemberApplications,
      memberProfiles,
      integrationMessageRefs,
      logs: [],
      settings: settings || {},
      users: [],
      wipes: [],
      wipeParticipants: [],
      kdaRows: [],
      syncState: {}
    };
  } catch (error) {
    console.warn('[nb-clan] sqlite Discord member application fallback:', error?.message || error);
    return discordMemberReviewPartialStore(error, 'application_runtime');
  }
}
