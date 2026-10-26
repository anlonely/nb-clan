import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { ensureSqliteSchema, readSqliteCollectionRecord, upsertSqliteCollectionRecord } from '../server/storage/sqlite-migrate.js';
import { createManagementWrites } from '../server/v2/management-runtime/cache.js';

function fixture(t) {
  const db = new DatabaseSync(':memory:');
  ensureSqliteSchema(db);
  t.after(() => db.close());
  const cache = { kdaRows: [], kdaSnapshots: [] };
  let tail = Promise.resolve(), failCache = false;
  const writes = createManagementWrites({ identity: { repo: { db } },
    runStoreWriteTask: fn => {
      const pending = tail.then(fn);
      tail = pending.catch(() => {});
      return pending;
    },
    patchStoreCache: fn => {
      if (failCache) throw new Error('cache unavailable');
      fn(cache);
    } });
  return { db, cache, writes, setFailCache: value => { failCache = value; } };
}
const row = (revision, kills) => ({ id: 'stat-local', sourceId: 'vital', sourceRevision: revision, kills });

test('older stats receipt replay cannot overwrite newer canonical cache values', async t => {
  const f = fixture(t), old = row(1, 4), latest = row(2, 9);
  await f.writes.stats(() => ({ upserts: [old], replayed: false }));
  await f.writes.stats(() => ({ upserts: [latest], replayed: false }));
  await f.writes.stats(() => ({ upserts: [old], replayed: true }));
  assert.equal(f.cache.kdaRows[0].kills, 9);
  assert.equal(readSqliteCollectionRecord(f.db, 'kdaRows', old.id).kills, 9);
  assert.equal(f.cache.kdaSnapshots.find(r => r.id.endsWith(':1')).kills, 4);
  assert.equal(f.cache.kdaSnapshots.find(r => r.id.endsWith(':2')).kills, 9);
});

test('post-commit cache failure is repaired by replay without rewriting facts', async t => {
  const f = fixture(t), value = row(1, 5);
  f.setFailCache(true);
  await assert.rejects(f.writes.stats(() => ({ upserts: [value], replayed: false })), /cache unavailable/);
  assert.equal(readSqliteCollectionRecord(f.db, 'kdaRows', value.id).kills, 5);
  assert.equal(f.cache.kdaRows.length, 0);
  f.setFailCache(false);
  await f.writes.stats(() => ({ upserts: [value], replayed: true }));
  assert.equal(f.cache.kdaRows[0].kills, 5);
  assert.equal(f.cache.kdaSnapshots.length, 1);
});

test('failed authority transaction does not change cache or persist partial rows', async t => {
  const f = fixture(t);
  await assert.rejects(f.writes.stats(() => {
    upsertSqliteCollectionRecord(f.db, 'kdaRows', 'partial', {id:'partial',kills:99});
    throw new Error('abort authority');
  }), /abort authority/);
  assert.equal(readSqliteCollectionRecord(f.db, 'kdaRows', 'partial'), null);
  assert.equal(f.cache.kdaRows.length, 0);
});
