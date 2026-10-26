import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';

test('domain transaction rejection does not report a broken SQLite database', async t => {
  const previousMode = process.env.NB_STORAGE_MODE;
  process.env.NB_STORAGE_MODE = 'json';
  t.after(() => previousMode === undefined ? delete process.env.NB_STORAGE_MODE : process.env.NB_STORAGE_MODE = previousMode);
  const sqlite = await import('../server/storage/sqlite.js?health-domain-test');
  const rejection = Object.assign(new Error('ELIGIBILITY_CHANGED'), { errorCode: 'ELIGIBILITY_CHANGED', status: 403 });
  assert.throws(() => sqlite.timeSqliteWrite('identity', () => { throw rejection; }), e => e === rejection);
  assert.equal((await sqlite.sqliteRuntimeStats()).lastError, '');
  const db = new DatabaseSync(':memory:');
  t.after(() => db.close());
  assert.throws(() => sqlite.timeSqliteWrite('native-error', () => db.exec('SELECT * FROM absent_table')), { code: 'ERR_SQLITE_ERROR' });
  const failed = await sqlite.sqliteRuntimeStats();
  assert.match(failed.lastError, /absent_table/);
  assert.ok(Number.isFinite(Date.parse(failed.lastErrorAt)));
  sqlite.timeSqliteQuery('healthy-read', () => db.prepare('SELECT 1').get());
  assert.equal((await sqlite.sqliteRuntimeStats()).lastErrorAt, failed.lastErrorAt);
  db.exec("CREATE TABLE corrupt_records(payload_json TEXT); INSERT INTO corrupt_records VALUES ('{')");
  assert.throws(() => sqlite.timeSqliteQuery('corrupt-payload', () => JSON.parse(
    db.prepare('SELECT payload_json FROM corrupt_records').get().payload_json
  )), SyntaxError);
  const corrupt = await sqlite.sqliteRuntimeStats();
  assert.ok(corrupt.lastError);
  assert.notEqual(corrupt.lastError, failed.lastError);
  assert.ok(Number.isFinite(Date.parse(corrupt.lastErrorAt)));
});

test('slow event timestamp survives later fast queries for bounded health warnings', async t => {
  const saved = { mode: process.env.NB_STORAGE_MODE, slow: process.env.NB_SQLITE_SLOW_QUERY_MS };
  process.env.NB_STORAGE_MODE = 'json';
  process.env.NB_SQLITE_SLOW_QUERY_MS = '0';
  t.after(() => {
    for (const [key, value] of [['NB_STORAGE_MODE', saved.mode], ['NB_SQLITE_SLOW_QUERY_MS', saved.slow]]) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  });
  const sqlite = await import('../server/storage/sqlite.js?health-slow-test');
  sqlite.timeSqliteQuery('startup-read', () => 1);
  const slow = (await sqlite.sqliteRuntimeStats()).queries;
  assert.equal(slow.slow, 1);
  assert.ok(Number.isFinite(Date.parse(slow.lastSlowAt)));
  process.env.NB_SQLITE_SLOW_QUERY_MS = '100000';
  sqlite.timeSqliteQuery('fast-read', () => 1);
  const after = (await sqlite.sqliteRuntimeStats()).queries;
  assert.equal(after.slow, 1);
  assert.equal(after.lastSlowAt, slow.lastSlowAt);
  assert.equal(after.last.slow, false);
});
