import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  closeSqliteDatabasesForTests,
  openSqliteDatabase
} from '../server/storage/sqlite.js';

test('concurrent first SQLite opens share one connection and reopen cleanly after close', async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'nb-clan-sqlite-concurrent-open-'));
  const sqliteFile = path.join(dataDir, 'nb-clan.sqlite');
  try {
    const databases = await Promise.all(
      Array.from({ length: 20 }, () => openSqliteDatabase(sqliteFile))
    );
    assert.equal(new Set(databases).size, 1);
    databases[0].exec('CREATE TABLE concurrent_open_probe (id TEXT PRIMARY KEY)');
    await closeSqliteDatabasesForTests();

    const reopened = await openSqliteDatabase(sqliteFile);
    assert.notEqual(reopened, databases[0]);
    assert.equal(reopened.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'concurrent_open_probe'").get().name, 'concurrent_open_probe');
  } finally {
    await closeSqliteDatabasesForTests();
    await rm(dataDir, { recursive: true, force: true });
  }
});
