export function storeRecordPatchSignature(record = {}) {
  return JSON.stringify(record);
}

export function snapshotStoreCollections(store, collectionNames, signature = storeRecordPatchSignature) {
  return Object.fromEntries(collectionNames.map((collection) => [
    collection,
    new Map((store[collection] || [])
      .filter((item) => item?.id)
      .map((item) => [item.id, signature(item)]))
  ]));
}

export function diffStoreCollections(before, store, collectionNames, signature = storeRecordPatchSignature) {
  const upserts = {};
  const deletes = {};
  for (const collection of collectionNames) {
    const beforeMap = before[collection] || new Map();
    const afterItems = Array.isArray(store[collection]) ? store[collection] : [];
    const afterIds = new Set();
    for (const item of afterItems) {
      if (!item?.id) continue;
      afterIds.add(item.id);
      if (beforeMap.get(item.id) !== signature(item)) {
        upserts[collection] ||= [];
        upserts[collection].push(item);
      }
    }
    for (const id of beforeMap.keys()) {
      if (!afterIds.has(id)) {
        deletes[collection] ||= [];
        deletes[collection].push(id);
      }
    }
  }
  const changed = Object.values(upserts).some((items) => items.length) ||
    Object.values(deletes).some((items) => items.length);
  return { upserts, deletes, changed };
}

export function recordPatchById(beforeRecords = [], afterRecords = []) {
  const afterById = new Map(afterRecords.filter((item) => item?.id).map((item) => [item.id, item]));
  const beforeIds = new Set(beforeRecords.map((item) => item?.id).filter(Boolean));
  return {
    upserts: [...afterById.values()],
    deletes: [...beforeIds].filter((id) => !afterById.has(id))
  };
}

export function collectionFullPatchFromBeforeAfter(beforeRecords = [], afterRecords = []) {
  const collection = 'records';
  const before = snapshotStoreCollections({ [collection]: beforeRecords }, [collection]);
  const { upserts, deletes } = diffStoreCollections(before, { [collection]: afterRecords }, [collection]);
  return {
    upserts: upserts[collection] || [],
    deletes: deletes[collection] || []
  };
}

export function sqliteRecordDeltaById(beforeRecords = [], afterRecords = []) {
  return collectionFullPatchFromBeforeAfter(beforeRecords, afterRecords);
}

export function collectionDeletePatch(beforeRecords = [], afterRecords = []) {
  const beforeIds = new Set((beforeRecords || []).map((item) => item?.id || item?.key).filter(Boolean));
  const afterIds = new Set((afterRecords || []).map((item) => item?.id || item?.key).filter(Boolean));
  return [...beforeIds].filter((id) => !afterIds.has(id));
}

export function replaceCachedRecord(records = [], record = null) {
  if (!record?.id) return records;
  const index = records.findIndex((item) => item.id === record.id);
  if (index >= 0) {
    records[index] = record;
    return records;
  }
  records.push(record);
  return records;
}

export function cloneRecordsForPatch(records = []) {
  return (records || []).map((item) => JSON.parse(JSON.stringify(item)));
}

export function patchCachedScopedRecords(store, collection, beforeRecords = [], afterRecords = []) {
  const beforeIds = new Set(beforeRecords.map((item) => item?.id).filter(Boolean));
  const afterIds = new Set(afterRecords.map((item) => item?.id).filter(Boolean));
  const deleteIds = new Set([...beforeIds].filter((id) => !afterIds.has(id)));
  store[collection] = (store[collection] || []).filter((item) => !deleteIds.has(item.id));
  for (const record of afterRecords) {
    replaceCachedRecord(store[collection], record);
  }
}

function timestampForStorePatchSort(value) {
  const time = Date.parse(value || '');
  return Number.isFinite(time) ? time : 0;
}

export function applyStoreCollectionCachePatch(cachedStore, collectionNames, upserts = {}, deletes = {}) {
  for (const collection of collectionNames) {
    cachedStore[collection] ||= [];
    const deleteIds = new Set(deletes[collection] || []);
    if (deleteIds.size) {
      cachedStore[collection] = cachedStore[collection].filter((item) => !deleteIds.has(item?.id));
    }
    for (const item of upserts[collection] || []) replaceCachedRecord(cachedStore[collection], item);
    if (collection === 'logs') {
      cachedStore.logs = cachedStore.logs
        .toSorted((left, right) => timestampForStorePatchSort(right.createdAt) - timestampForStorePatchSort(left.createdAt))
        .slice(0, 1000);
    } else if (collection === 'syncJobs') {
      cachedStore.syncJobs = cachedStore.syncJobs
        .toSorted((left, right) => timestampForStorePatchSort(right.updatedAt || right.createdAt) - timestampForStorePatchSort(left.updatedAt || left.createdAt))
        .slice(0, 1000);
    }
  }
}
