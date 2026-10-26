import { readSqliteCollectionRecord } from '../../storage/sqlite-migrate.js';
import { createMemberAdminWriteAdapter } from '../member-admin/adapters.js';
import { createStatsWriter } from '../stats/writer.js';

/** Compose with the existing global queue. Never populate caches from old receipts. */
export function createManagementWrites({ identity, runStoreWriteTask, patchStoreCache }) {
  if (!identity?.repo?.db || typeof runStoreWriteTask !== 'function' || typeof patchStoreCache !== 'function') {
    throw new TypeError('Identity database and existing store write adapters required');
  }
  const db = identity.repo.db;
  const patchStats = async rows => {
    const keys = new Map();
    for (const row of rows) {
      keys.set(`kdaRows:${row.id}`, { collection: 'kdaRows', id: row.id });
      const id = `${row.id}:${row.sourceId}:${row.sourceRevision}`;
      keys.set(`kdaSnapshots:${id}`, { collection: 'kdaSnapshots', id });
    }
    const current = [...keys.values()].map(key => ({ ...key,
      record: readSqliteCollectionRecord(db, key.collection, key.id) }));
    await patchStoreCache(store => {
      for (const { collection, id, record } of current) {
        store[collection] ||= [];
        const index = store[collection].findIndex(row => row.id === id);
        if (!record) {
          if (index >= 0) store[collection].splice(index, 1);
        } else if (index >= 0) store[collection][index] = record;
        else store[collection].push(record);
      }
    });
  };
  return {
    member: createMemberAdminWriteAdapter({ runStoreWriteTask, patchStoreCache }),
    stats: createStatsWriter({ db, runWrite: runStoreWriteTask, patchCache: patchStats }),
  };
}
