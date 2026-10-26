import {
  checkpointSqlite,
  openSqliteDatabase,
  recordSqliteCompatibilityCall,
  sqliteEnabled,
  sqliteHealthCheck,
  sqliteRuntimeStats,
  timeSqliteQuery
} from './sqlite.js';
import {
  deleteSqliteCollectionRecord,
  ensureSqliteSchema,
  findSqliteCollectionRecordByJsonField,
  countSqliteCollectionRecordsByJsonField,
  countSqliteCollectionRecordsByJsonTimeRange,
  countSqliteMemberVitalVipRecords,
  countSqliteMemberSearchRecords,
  countSqliteCollectionRecordsWithoutJsonRelation,
  countSqliteCollectionRecordsWhereJsonFieldMissing,
  deleteSqliteCollectionRecordsByJsonTimeRange,
  deleteSqliteCollectionRecordsBeyondJsonFieldLimit,
  listSqliteCollectionRecordsByJsonFields,
  listSqliteCollectionRecordsByJsonField,
  listSqliteCollectionRecordsByJsonArrayField,
  listSqliteCollectionRecordsByJsonFieldNoCase,
  listSqliteCollectionRecordsByJsonFieldTextContainsNoCase,
  listSqliteCollectionRecordsByJsonFieldMissingOrNotIn,
  listSqliteMemberSearchRecords,
  listSqliteMemberVitalVipRecords,
  listSqliteCollectionRecordsWithoutJsonRelation,
  listSqliteCollectionRecordsByIds,
  listSqliteCollectionRecordsWhereJsonFieldMissing,
  listSqliteCollectionRecordsWhereJsonFieldPresent,
  listSqliteCollectionRecords,
  readSqliteCollectionRecord,
  readSqliteScalar,
  replaceSqliteCollectionRecords,
  runSqliteTransaction,
  sqliteCollectionNames,
  sqliteCollectionRecordCounts,
  sqliteJsonFieldIndexes,
  sqliteScalarKeys,
  upsertSqliteCollectionRecord,
  upsertSqliteScalar,
  SQLITE_BUSINESS_UNIQUE_CONSTRAINTS,
  SQLITE_SCHEMA_VERSION
} from './sqlite-migrate.js';

const STORE_FULL_KEY = 'store_full';
const RUSTPLUS_RELAY_COLLECTIONS_READY_KEY = 'rustplusRelayCollectionsReady';
const RUSTPLUS_RELAY_COLLECTIONS = {
  clients: 'rustplusRelayClients',
  servers: 'rustplusRelayServers',
  chatMessages: 'rustplusRelayChatMessages',
  inviteRecords: 'rustplusRelayInviteRecords',
  steamProfiles: 'rustplusRelaySteamProfiles'
};
const RUSTPLUS_RELAY_COLLECTION_NAMES = new Set(Object.values(RUSTPLUS_RELAY_COLLECTIONS));
const sqliteStorePatchFailuresForTests = new Map();
const sqliteQueryFailuresForTests = new Map();
const BUSINESS_UNIQUE_COLLECTIONS = new Set(
  SQLITE_BUSINESS_UNIQUE_CONSTRAINTS.map((constraint) => constraint.collection)
);

function isRustplusRelayCollection(collection) {
  return RUSTPLUS_RELAY_COLLECTION_NAMES.has(String(collection || ''));
}

function rustplusRelayCollectionsFromStore(store = {}) {
  const relay = store.rustplusRelay || {};
  return Object.fromEntries(Object.entries(RUSTPLUS_RELAY_COLLECTIONS).map(([key, collection]) => [
    collection,
    Array.isArray(relay[key]) ? relay[key] : []
  ]));
}

function rustplusRelayCollectionsReady(value = null) {
  return Boolean(value === true || value?.ready);
}

function mergeRustplusRelayCollections(baseRelay = {}, collections = {}, ready = false) {
  if (!ready) return baseRelay || {};
  return {
    ...(baseRelay || {}),
    clients: collections.rustplusRelayClients || [],
    servers: collections.rustplusRelayServers || [],
    chatMessages: collections.rustplusRelayChatMessages || [],
    inviteRecords: collections.rustplusRelayInviteRecords || [],
    steamProfiles: collections.rustplusRelaySteamProfiles || []
  };
}

export async function ensureSqliteStore(store = null) {
  if (!sqliteEnabled()) return { enabled: false };
  const db = await openSqliteDatabase();
  ensureSqliteSchema(db);
  if (store && !readSqliteScalar(db, STORE_FULL_KEY)) {
    await writeSqliteStoreMirror(store, { reason: 'bootstrap' });
  }
  return { enabled: true, schemaVersion: SQLITE_SCHEMA_VERSION };
}

export async function writeSqliteStoreMirror(store, options = {}) {
  if (!sqliteEnabled()) return { enabled: false, collections: {}, reason: options.reason || '' };
  const db = await openSqliteDatabase();
  ensureSqliteSchema(db);
  recordSqliteCompatibilityCall('syncStoreChangesToSqlite');
  const updatedAt = store?.updatedAt || new Date().toISOString();
  const includeFullStore = options.includeFullStore !== false;
  return runSqliteTransaction(db, options.reason || 'write_store_mirror', (statements) => {
    if (includeFullStore) upsertSqliteScalar(db, STORE_FULL_KEY, store, { statements, updatedAt });
    const collections = {};
    for (const [key, value] of Object.entries(store || {})) {
      if (!Array.isArray(value)) continue;
      collections[key] = replaceSqliteCollectionRecords(db, key, value, { statements, updatedAt });
    }
    for (const [collection, records] of Object.entries(rustplusRelayCollectionsFromStore(store))) {
      collections[collection] = replaceSqliteCollectionRecords(db, collection, records, { statements, updatedAt });
    }
    if (store?.rustplusRelay) {
      upsertSqliteScalar(db, RUSTPLUS_RELAY_COLLECTIONS_READY_KEY, { ready: true, updatedAt }, { statements, updatedAt });
    }
    for (const key of ['settings', 'syncState', 'rustplusRelay']) {
      if (!Object.hasOwn(store || {}, key)) continue;
      upsertSqliteScalar(db, key, store[key], { statements, updatedAt });
    }
    return { enabled: true, collections, fullStore: includeFullStore, reason: options.reason || '' };
  });
}

export async function readStoreFromSqlite() {
  if (!sqliteEnabled()) return null;
  maybeThrowInjectedSqliteQueryFailure('read_store_full');
  const db = await openSqliteDatabase();
  ensureSqliteSchema(db);
  recordSqliteCompatibilityCall('hydrateStoreFromSqlite');
  return timeSqliteQuery('read_store_full', () => {
    const baseStore = readSqliteScalar(db, STORE_FULL_KEY);
    const collections = new Set(sqliteCollectionNames(db));
    for (const [collection, value] of Object.entries(baseStore || {})) {
      if (Array.isArray(value)) collections.add(collection);
    }
    if (!baseStore && !collections.size) return null;
    const store = baseStore || {};
    const rustplusRelayCollections = {};
    for (const collection of [...collections].sort()) {
      const records = listSqliteCollectionRecords(db, collection, { limit: 0 });
      if (isRustplusRelayCollection(collection)) {
        rustplusRelayCollections[collection] = records;
      } else {
        store[collection] = records;
      }
    }
    for (const key of ['settings', 'syncState', 'rustplusRelay']) {
      const value = readSqliteScalar(db, key);
      if (value !== null) store[key] = value;
    }
    const relayCollectionsReady = rustplusRelayCollectionsReady(readSqliteScalar(db, RUSTPLUS_RELAY_COLLECTIONS_READY_KEY));
    store.rustplusRelay = mergeRustplusRelayCollections(store.rustplusRelay, rustplusRelayCollections, relayCollectionsReady);
    return store;
  });
}

export async function readSqliteStoreSlice(collections = []) {
  if (!sqliteEnabled()) return {};
  const db = await openSqliteDatabase();
  ensureSqliteSchema(db);
  recordSqliteCompatibilityCall('readSqliteStoreSlice');
  return timeSqliteQuery('read_store_slice', () => {
    const result = {};
    for (const collection of collections) {
      result[collection] = listSqliteCollectionRecords(db, collection, { limit: 0, offset: 0 });
    }
    return result;
  });
}

export async function getSqliteCollection(collection, options = {}) {
  maybeThrowInjectedSqliteQueryFailure(`list_${collection}`);
  const db = await openSqliteDatabase();
  ensureSqliteSchema(db);
  return timeSqliteQuery(`list_${collection}`, () => listSqliteCollectionRecords(db, collection, options));
}

export async function getSqliteRecord(collection, id) {
  maybeThrowInjectedSqliteQueryFailure(`get_${collection}`);
  const db = await openSqliteDatabase();
  ensureSqliteSchema(db);
  return timeSqliteQuery(`get_${collection}`, () => readSqliteCollectionRecord(db, collection, id));
}

export async function getSqliteRecordsByIds(collection, ids = [], options = {}) {
  maybeThrowInjectedSqliteQueryFailure(`list_${collection}_id`);
  const db = await openSqliteDatabase();
  ensureSqliteSchema(db);
  return timeSqliteQuery(`list_${collection}_id`, () => listSqliteCollectionRecordsByIds(db, collection, ids, options));
}

export async function findSqliteRecordByJsonField(collection, field, value) {
  maybeThrowInjectedSqliteQueryFailure(`find_${collection}_${field}`);
  const db = await openSqliteDatabase();
  ensureSqliteSchema(db);
  return timeSqliteQuery(`find_${collection}_${field}`, () => findSqliteCollectionRecordByJsonField(db, collection, field, value));
}

export async function getSqliteRecordsByJsonField(collection, field, values = [], options = {}) {
  maybeThrowInjectedSqliteQueryFailure(`list_${collection}_${field}`);
  const db = await openSqliteDatabase();
  ensureSqliteSchema(db);
  return timeSqliteQuery(`list_${collection}_${field}`, () => listSqliteCollectionRecordsByJsonField(db, collection, field, values, options));
}

export async function getSqliteRecordsByJsonArrayField(collection, field, values = [], options = {}) {
  const db = await openSqliteDatabase();
  ensureSqliteSchema(db);
  return timeSqliteQuery(`list_${collection}_${field}_array`, () => (
    listSqliteCollectionRecordsByJsonArrayField(db, collection, field, values, options)
  ));
}

export async function getSqliteRecordsByJsonFieldNoCase(collection, field, values = [], options = {}) {
  const db = await openSqliteDatabase();
  ensureSqliteSchema(db);
  return timeSqliteQuery(`list_${collection}_${field}_nocase`, () => (
    listSqliteCollectionRecordsByJsonFieldNoCase(db, collection, field, values, options)
  ));
}

export async function getSqliteRecordsByJsonFieldTextContainsNoCase(collection, field, values = [], options = {}) {
  const db = await openSqliteDatabase();
  ensureSqliteSchema(db);
  return timeSqliteQuery(`list_${collection}_${field}_text_contains`, () => (
    listSqliteCollectionRecordsByJsonFieldTextContainsNoCase(db, collection, field, values, options)
  ));
}

export async function getSqliteRecordsByJsonFieldMissingOrNotIn(collection, field, values = [], options = {}) {
  maybeThrowInjectedSqliteQueryFailure(`list_${collection}_${field}_missing_or_not_in`);
  const db = await openSqliteDatabase();
  ensureSqliteSchema(db);
  return timeSqliteQuery(`list_${collection}_${field}_missing_or_not_in`, () => (
    listSqliteCollectionRecordsByJsonFieldMissingOrNotIn(db, collection, field, values, options)
  ));
}

function sqliteRelationQueryName(prefix, collection, relationCollection, relationField, options = {}) {
  const clean = (value) => String(value || '').replace(/[^A-Za-z0-9_]/g, '');
  const targetCollection = clean(options.relationTargetCollection);
  const targetField = clean(options.relationTargetField);
  const target = targetCollection && targetField ? `_existing_${targetCollection}_${targetField}` : '';
  return `${prefix}_${clean(collection)}_without_${clean(relationCollection)}_${clean(relationField)}${target}`;
}

export async function getSqliteRecordsWithoutJsonRelation(collection, relationCollection, relationField, options = {}) {
  const queryName = sqliteRelationQueryName('list', collection, relationCollection, relationField, options);
  maybeThrowInjectedSqliteQueryFailure(queryName);
  const db = await openSqliteDatabase();
  ensureSqliteSchema(db);
  return timeSqliteQuery(queryName, () => (
    listSqliteCollectionRecordsWithoutJsonRelation(db, collection, relationCollection, relationField, options)
  ));
}

export async function getSqliteMemberSearchRecords(query, options = {}) {
  maybeThrowInjectedSqliteQueryFailure('list_members_search');
  const db = await openSqliteDatabase();
  ensureSqliteSchema(db);
  return timeSqliteQuery('list_members_search', () => listSqliteMemberSearchRecords(db, query, options));
}

export async function getSqliteMemberVitalVipRecords(vitalVipTypes = [], options = {}) {
  maybeThrowInjectedSqliteQueryFailure('list_members_vitalVipType_normalized');
  const db = await openSqliteDatabase();
  ensureSqliteSchema(db);
  return timeSqliteQuery('list_members_vitalVipType_normalized', () => listSqliteMemberVitalVipRecords(db, vitalVipTypes, options));
}

export async function getSqliteRecordsByJsonFields(collection, filters = {}, options = {}) {
  const entries = Array.isArray(filters) ? filters : Object.entries(filters || {});
  const suffix = entries
    .map((entry) => (Array.isArray(entry) ? entry[0] : entry?.field))
    .map((field) => String(field || '').replace(/[^A-Za-z0-9_]/g, ''))
    .filter(Boolean)
    .join('_') || 'fields';
  maybeThrowInjectedSqliteQueryFailure(`list_${collection}_${suffix}`);
  const db = await openSqliteDatabase();
  ensureSqliteSchema(db);
  return timeSqliteQuery(`list_${collection}_${suffix}`, () => listSqliteCollectionRecordsByJsonFields(db, collection, filters, options));
}

export async function getSqliteRecordsWhereJsonFieldPresent(collection, field, options = {}) {
  const db = await openSqliteDatabase();
  ensureSqliteSchema(db);
  return timeSqliteQuery(`list_${collection}_${field}_present`, () => listSqliteCollectionRecordsWhereJsonFieldPresent(db, collection, field, options));
}

export async function getSqliteRecordsWhereJsonFieldMissing(collection, field, options = {}) {
  const db = await openSqliteDatabase();
  ensureSqliteSchema(db);
  return timeSqliteQuery(`list_${collection}_${field}_missing`, () => listSqliteCollectionRecordsWhereJsonFieldMissing(db, collection, field, options));
}

export async function getSqliteRecordCounts() {
  const db = await openSqliteDatabase();
  ensureSqliteSchema(db);
  return timeSqliteQuery('record_counts', () => sqliteCollectionRecordCounts(db));
}

export async function countSqliteRecordsByJsonTimeRange(collection, field, range = {}) {
  const db = await openSqliteDatabase();
  ensureSqliteSchema(db);
  return timeSqliteQuery(`count_${collection}_${field}_range`, () => countSqliteCollectionRecordsByJsonTimeRange(db, collection, field, range));
}

export async function countSqliteRecordsByJsonField(collection, field, values = []) {
  const db = await openSqliteDatabase();
  ensureSqliteSchema(db);
  return timeSqliteQuery(`count_${collection}_${field}`, () => countSqliteCollectionRecordsByJsonField(db, collection, field, values));
}

export async function countSqliteRecordsWithoutJsonRelation(collection, relationCollection, relationField, options = {}) {
  const queryName = sqliteRelationQueryName('count', collection, relationCollection, relationField, options);
  maybeThrowInjectedSqliteQueryFailure(queryName);
  const db = await openSqliteDatabase();
  ensureSqliteSchema(db);
  return timeSqliteQuery(queryName, () => (
    countSqliteCollectionRecordsWithoutJsonRelation(db, collection, relationCollection, relationField, options)
  ));
}

export async function countSqliteMemberSearchRecordsForQuery(query) {
  maybeThrowInjectedSqliteQueryFailure('count_members_search');
  const db = await openSqliteDatabase();
  ensureSqliteSchema(db);
  return timeSqliteQuery('count_members_search', () => countSqliteMemberSearchRecords(db, query));
}

export async function countSqliteMemberVitalVipRecordsForTypes(vitalVipTypes = []) {
  maybeThrowInjectedSqliteQueryFailure('count_members_vitalVipType_normalized');
  const db = await openSqliteDatabase();
  ensureSqliteSchema(db);
  return timeSqliteQuery('count_members_vitalVipType_normalized', () => countSqliteMemberVitalVipRecords(db, vitalVipTypes));
}

export async function countSqliteRecordsWhereJsonFieldMissing(collection, field, options = {}) {
  const db = await openSqliteDatabase();
  ensureSqliteSchema(db);
  return timeSqliteQuery(`count_${collection}_${field}_missing`, () => countSqliteCollectionRecordsWhereJsonFieldMissing(db, collection, field, options));
}

export async function deleteSqliteRecordsByJsonTimeRange(collection, field, range = {}, options = {}) {
  if (!sqliteEnabled()) {
    return { enabled: false, collection, field, deleted: 0, deletedIds: [] };
  }
  const db = await openSqliteDatabase();
  ensureSqliteSchema(db);
  return runSqliteTransaction(db, options.reason || `delete_${collection}_${field}_range`, (statements) => {
    const deletedIds = deleteSqliteCollectionRecordsByJsonTimeRange(db, collection, field, range, { statements });
    return {
      enabled: true,
      collection,
      field,
      deleted: deletedIds.length,
      deletedIds
    };
  });
}

export async function getSqliteScalar(key) {
  maybeThrowInjectedSqliteQueryFailure(`scalar_${key}`);
  const db = await openSqliteDatabase();
  ensureSqliteSchema(db);
  return timeSqliteQuery(`scalar_${key}`, () => readSqliteScalar(db, key));
}

export function injectSqliteQueryFailureForTests(name = '', count = 1) {
  const normalizedName = String(name || '').trim();
  if (!normalizedName) return;
  const normalizedCount = Math.max(0, Math.floor(Number(count) || 0));
  if (!normalizedCount) {
    sqliteQueryFailuresForTests.delete(normalizedName);
    return;
  }
  sqliteQueryFailuresForTests.set(normalizedName, normalizedCount);
}

function maybeThrowInjectedSqliteQueryFailure(name = '') {
  const normalizedName = String(name || '').trim();
  const wildcardRemaining = sqliteQueryFailuresForTests.get('*') || 0;
  const namedRemaining = sqliteQueryFailuresForTests.get(normalizedName) || 0;
  const key = namedRemaining > 0 ? normalizedName : (wildcardRemaining > 0 ? '*' : '');
  if (!key) return;
  const remaining = sqliteQueryFailuresForTests.get(key) || 0;
  if (remaining <= 1) sqliteQueryFailuresForTests.delete(key);
  else sqliteQueryFailuresForTests.set(key, remaining - 1);
  throw Object.assign(new Error(`Injected sqlite query failure for ${normalizedName}`), {
    code: 'NB_TEST_SQLITE_QUERY_FAILURE',
    queryName: normalizedName
  });
}

export function injectSqliteStorePatchFailureForTests(reason = 'store_patch', count = 1) {
  const normalizedReason = String(reason || 'store_patch');
  const normalizedCount = Math.max(0, Math.floor(Number(count) || 0));
  if (!normalizedCount) {
    sqliteStorePatchFailuresForTests.delete(normalizedReason);
    return;
  }
  sqliteStorePatchFailuresForTests.set(normalizedReason, normalizedCount);
}

function maybeThrowInjectedSqliteStorePatchFailure(reason = 'store_patch') {
  const normalizedReason = String(reason || 'store_patch');
  const wildcardRemaining = sqliteStorePatchFailuresForTests.get('*') || 0;
  const reasonRemaining = sqliteStorePatchFailuresForTests.get(normalizedReason) || 0;
  const key = reasonRemaining > 0 ? normalizedReason : (wildcardRemaining > 0 ? '*' : '');
  if (!key) return;
  const remaining = sqliteStorePatchFailuresForTests.get(key) || 0;
  if (remaining <= 1) sqliteStorePatchFailuresForTests.delete(key);
  else sqliteStorePatchFailuresForTests.set(key, remaining - 1);
  throw Object.assign(new Error(`Injected sqlite patch failure for ${normalizedReason}`), {
    code: 'NB_TEST_SQLITE_PATCH_FAILURE',
    reason: normalizedReason
  });
}

export async function writeSqliteStorePatch({ upserts = {}, deletes = {}, deleteRanges = {}, replaces = {}, scalars = {}, positions = {}, trims = {}, reason = 'store_patch' } = {}) {
  if (!sqliteEnabled()) return { enabled: false, upserted: 0, deleted: 0, deletedRanges: {}, replaced: {}, trimmed: {}, scalars: 0 };
  maybeThrowInjectedSqliteStorePatchFailure(reason);
  const db = await openSqliteDatabase();
  ensureSqliteSchema(db);
  return runSqliteTransaction(db, reason, (statements) => {
    let upserted = 0;
    let deleted = 0;
    let scalarCount = 0;
    const deletedRanges = {};
    const replaced = {};
    const trimmed = {};
    const updatedAt = new Date().toISOString();
    for (const [key, value] of Object.entries(scalars || {})) {
      upsertSqliteScalar(db, key, value, { statements, updatedAt });
      scalarCount += 1;
    }
    for (const [collection, records] of Object.entries(replaces || {})) {
      replaced[collection] = replaceSqliteCollectionRecords(db, collection, Array.isArray(records) ? records : [], { statements, updatedAt });
    }
    for (const [collection, configs] of Object.entries(deleteRanges || {})) {
      const items = Array.isArray(configs) ? configs : [configs];
      for (const config of items) {
        if (!config || typeof config !== 'object') continue;
        const field = config.field || 'updatedAt';
        const deletedIds = deleteSqliteCollectionRecordsByJsonTimeRange(db, collection, field, config, { statements });
        if (!deletedIds.length) continue;
        deletedRanges[collection] ||= [];
        deletedRanges[collection].push(...deletedIds);
        deleted += deletedIds.length;
      }
    }
    const upsertIdsByCollection = new Map(Object.entries(upserts || {}).map(([collection, records]) => [
      collection,
      new Set((Array.isArray(records) ? records : [records])
        .map((item) => item?.id || item?.key)
        .filter(Boolean))
    ]));
    for (const [collection, ids] of Object.entries(deletes || {})) {
      const items = Array.isArray(ids) ? ids : [ids];
      const upsertIds = upsertIdsByCollection.get(collection) || new Set();
      for (const id of items) {
        if (!id || upsertIds.has(id)) continue;
        deleteSqliteCollectionRecord(db, collection, id, { statements });
        deleted += 1;
      }
    }
    const preservedPositions = new Map();
    for (const [collection, records] of Object.entries(upserts || {})) {
      if (!BUSINESS_UNIQUE_COLLECTIONS.has(collection)) continue;
      const items = Array.isArray(records) ? records : [records];
      const collectionPositions = positions?.[collection] || null;
      const preparedIds = new Set();
      for (const item of items) {
        const id = item?.id || item?.key;
        if (!id || preparedIds.has(id)) continue;
        preparedIds.add(id);
        const hasExplicitPosition = collectionPositions && Object.hasOwn(collectionPositions, id);
        if (!hasExplicitPosition) {
          const existing = statements.getCollectionRecord.get(String(collection), String(id));
          if (existing && Number.isFinite(Number(existing.position))) {
            preservedPositions.set(`${collection}\u0000${id}`, Number(existing.position));
          }
        }
        deleteSqliteCollectionRecord(db, collection, id, { statements, updatedAt });
      }
    }
    for (const [collection, records] of Object.entries(upserts || {})) {
      const items = Array.isArray(records) ? records : [records];
      const collectionPositions = positions?.[collection] || null;
      for (const item of items) {
        if (!item) continue;
        const id = item.id || item.key;
        if (!id) continue;
        const patchOptions = { statements, updatedAt };
        if (collectionPositions && Object.hasOwn(collectionPositions, id)) {
          patchOptions.position = collectionPositions[id];
        } else if (preservedPositions.has(`${collection}\u0000${id}`)) {
          patchOptions.position = preservedPositions.get(`${collection}\u0000${id}`);
        }
        upsertSqliteCollectionRecord(db, collection, id, item, patchOptions);
        upserted += 1;
      }
    }
    for (const [collection, ids] of Object.entries(deletes || {})) {
      const items = Array.isArray(ids) ? ids : [ids];
      const upsertIds = upsertIdsByCollection.get(collection) || new Set();
      for (const id of items) {
        if (!id || !upsertIds.has(id)) continue;
        deleteSqliteCollectionRecord(db, collection, id, { statements });
        deleted += 1;
      }
    }
    for (const [collection, config] of Object.entries(trims || {})) {
      const trimConfigs = Array.isArray(config) ? config : [config];
      for (const item of trimConfigs) {
        const trimConfig = item && typeof item === 'object' ? item : { limit: item };
        const field = trimConfig.field || 'updatedAt';
        const limit = Math.max(0, Number.isFinite(Number(trimConfig.limit)) ? Math.floor(Number(trimConfig.limit)) : 0);
        const deletedIds = deleteSqliteCollectionRecordsBeyondJsonFieldLimit(db, collection, field, limit, {
          statements,
          order: trimConfig.order || 'desc',
          filters: trimConfig.filters || {},
          afterOffsetRange: trimConfig.afterOffsetRange || null
        });
        if (deletedIds.length) {
          trimmed[collection] ||= [];
          trimmed[collection].push(...deletedIds);
        }
        deleted += deletedIds.length;
      }
    }
    if (Object.hasOwn(upserts || {}, 'wechatNotifications') || Object.hasOwn(replaces || {}, 'wechatNotifications')) {
      const notifications = listSqliteCollectionRecords(db, 'wechatNotifications', { limit: 0, statements });
      for (const stale of notifications.slice(2000)) {
        const id = stale?.id || stale?.key;
        if (!id) continue;
        deleteSqliteCollectionRecord(db, 'wechatNotifications', id, { statements });
        deleted += 1;
      }
    }
    return { enabled: true, upserted, deleted, deletedRanges, replaced, trimmed, scalars: scalarCount };
  });
}

export async function trimSqliteCollectionByJsonFieldLimit(collection, field, limit, options = {}) {
  if (!sqliteEnabled()) {
    return { enabled: false, collection, field, limit: 0, deleted: 0, deletedIds: [] };
  }
  const normalizedLimit = Math.max(0, Number.isFinite(Number(limit)) ? Math.floor(Number(limit)) : 0);
  const db = await openSqliteDatabase();
  ensureSqliteSchema(db);
  return runSqliteTransaction(db, options.reason || `trim_${collection}_${field}`, (statements) => {
    const deletedIds = deleteSqliteCollectionRecordsBeyondJsonFieldLimit(db, collection, field, normalizedLimit, {
      statements,
      order: options.order || 'desc'
    });
    return {
      enabled: true,
      collection,
      field,
      limit: normalizedLimit,
      deleted: deletedIds.length,
      deletedIds
    };
  });
}

export async function sqliteStoreSummary() {
  if (!sqliteEnabled()) return { enabled: false };
  const db = await openSqliteDatabase();
  ensureSqliteSchema(db);
  const counts = timeSqliteQuery('record_counts', () => sqliteCollectionRecordCounts(db));
  const scalarKeys = timeSqliteQuery('scalar_keys', () => sqliteScalarKeys(db));
  return {
    enabled: true,
    schemaVersion: SQLITE_SCHEMA_VERSION,
    counts,
    scalarKeys,
    jsonFieldIndexes: sqliteJsonFieldIndexes(db)
  };
}

export async function sqliteRepositoryStatus(options = {}) {
  const includeSummary = options.includeSummary !== false;
  const [health, runtime, summary] = await Promise.all([
    sqliteHealthCheck().catch((error) => ({ ok: false, error: error?.message || String(error) })),
    sqliteRuntimeStats(),
    includeSummary
      ? sqliteStoreSummary().catch((error) => ({ enabled: sqliteEnabled(), error: error?.message || String(error) }))
      : Promise.resolve({ enabled: sqliteEnabled(), schemaVersion: SQLITE_SCHEMA_VERSION })
  ]);
  return {
    ...runtime,
    ok: health.ok,
    health,
    schemaVersion: summary.schemaVersion || SQLITE_SCHEMA_VERSION,
    summarySkipped: !includeSummary,
    records: summary.counts || {},
    scalarKeys: summary.scalarKeys || [],
    jsonFieldIndexes: summary.jsonFieldIndexes || { expected: 0, present: 0, missing: [] }
  };
}

export { checkpointSqlite };
