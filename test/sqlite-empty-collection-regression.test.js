import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  closeSqliteDatabasesForTests,
  openSqliteDatabase
} from '../server/storage/sqlite.js';
import { sqliteCollectionNames } from '../server/storage/sqlite-migrate.js';
import {
  readStoreFromSqlite,
  writeSqliteStoreMirror,
  writeSqliteStorePatch
} from '../server/storage/repository.js';

test('sqlite hydration keeps a mirrored collection empty after its last row is deleted and the database reopens', async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'nb-clan-sqlite-empty-collection-'));
  const sqliteFile = path.join(dataDir, 'nb-clan.sqlite');
  const previousEnv = {
    NB_STORAGE_MODE: process.env.NB_STORAGE_MODE,
    NB_SQLITE_FILE: process.env.NB_SQLITE_FILE
  };
  process.env.NB_STORAGE_MODE = 'sqlite-primary';
  process.env.NB_SQLITE_FILE = sqliteFile;

  try {
    await writeSqliteStoreMirror({
      updatedAt: '2026-07-10T00:00:00.000Z',
      members: [
        { id: 'member_last_row', steamId: '76561198001007001', nickname: 'Last Row' }
      ]
    }, { reason: 'empty_collection_regression_seed' });
    await writeSqliteStorePatch({
      deletes: { members: ['member_last_row'] },
      reason: 'empty_collection_regression_delete'
    });

    await closeSqliteDatabasesForTests();

    const hydrated = await readStoreFromSqlite();
    assert.deepEqual(hydrated.members, []);

    const db = await openSqliteDatabase(sqliteFile);
    assert.equal(sqliteCollectionNames(db).includes('members'), true);
    db.exec('DROP TABLE json_collections');
    await closeSqliteDatabasesForTests();

    const legacyHydrated = await readStoreFromSqlite();
    assert.deepEqual(legacyHydrated.members, []);
    const migratedDb = await openSqliteDatabase(sqliteFile);
    assert.equal(sqliteCollectionNames(migratedDb).includes('members'), true);
  } finally {
    await closeSqliteDatabasesForTests();
    Object.assign(process.env, previousEnv);
    for (const [key, value] of Object.entries(previousEnv)) {
      if (value === undefined) delete process.env[key];
    }
    await rm(dataDir, { recursive: true, force: true });
  }
});
