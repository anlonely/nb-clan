import { upsertSqliteCollectionRecord } from '../../storage/sqlite-migrate.js';
import { need } from './model.js';
/** The host supplies its existing global write queue and cache patcher. No fallback bypass. */
export function createStatsWriter({
  db,
  runWrite,
  patchCache
}) {
  need(db && typeof runWrite === 'function' && typeof patchCache === 'function', 'STATS_WRITER_REQUIRED', 503);
  return apply => runWrite(async () => {
    db.exec('SAVEPOINT v2_stats_owner_write');
    let result;
    try {
      result = apply();
      need(!result?.then, 'ASYNC_TRANSACTION_FORBIDDEN', 503);
      if (!result.replayed) for (const row of result.upserts || []) {
        upsertSqliteCollectionRecord(db, 'kdaRows', row.id, row);
        const snapshot = {
          ...row,
          id: `${row.id}:${row.sourceId}:${row.sourceRevision}`,
          capturedAt: row.capturedAt || row.syncedAt
        };
        upsertSqliteCollectionRecord(db, 'kdaSnapshots', snapshot.id, snapshot);
      }
      db.exec('RELEASE v2_stats_owner_write');
    } catch (e) {
      db.exec('ROLLBACK TO v2_stats_owner_write');
      db.exec('RELEASE v2_stats_owner_write');
      throw e;
    }
    // Replays patch again: a post-commit cache failure must not strand an old in-memory row.
    await patchCache(result.upserts || []);
    return result;
  });
}
