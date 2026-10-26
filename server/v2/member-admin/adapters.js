import { readSqliteCollectionRecord, readSqliteScalar } from '../../storage/sqlite-migrate.js';
/** Production composition helper. Inject the existing store's two functions.
 * SQLite has already committed before the cache changes. Replay re-reads just
 * the affected IDs, so an old receipt can never roll back a newer cache value. */
export function createMemberAdminWriteAdapter({
  runStoreWriteTask,
  patchStoreCache
}) {
  if (typeof runStoreWriteTask !== 'function' || typeof patchStoreCache !== 'function') throw new TypeError('Existing store queue/cache adapters required');
  return (write, {
    identity
  }) => runStoreWriteTask(async () => {
    const result = await write();
    const changes = [...new Map((result.changes || []).map(c => [`${c.collection}:${c.id || 'scalar'}`, c])).values()];
    const current = changes.map(c => ({
      ...c,
      record: c.scalar ? readSqliteScalar(identity.repo.db, c.collection) : readSqliteCollectionRecord(identity.repo.db, c.collection, c.id)
    }));
    await patchStoreCache(store => {
      for (const c of current) {
        if (c.scalar) {
          store[c.collection] = c.record;
          continue;
        }
        store[c.collection] ||= [];
        const index = store[c.collection].findIndex(r => r.id === c.id);
        if (!c.record) {
          if (index >= 0) store[c.collection].splice(index, 1);
        } else if (index >= 0) store[c.collection][index] = c.record;else store[c.collection].push(c.record);
      }
    });
    return result;
  });
}
