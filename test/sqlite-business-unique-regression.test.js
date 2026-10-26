import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  closeSqliteDatabasesForTests,
  openSqliteDatabase
} from '../server/storage/sqlite.js';
import {
  ensureSqliteSchema,
  listSqliteCollectionRecords,
  replaceSqliteCollectionRecords,
  runSqliteTransaction,
  SQLITE_BUSINESS_UNIQUE_CONSTRAINTS,
  sqliteJsonFieldIndexes,
  upsertSqliteCollectionRecord
} from '../server/storage/sqlite-migrate.js';
import { writeSqliteStorePatch } from '../server/storage/repository.js';

async function withTempSqlite(name, fn) {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), `nb-clan-${name}-`));
  const sqliteFile = path.join(dataDir, 'nb-clan.sqlite');
  try {
    return await fn(sqliteFile);
  } finally {
    await closeSqliteDatabasesForTests();
    await rm(dataDir, { recursive: true, force: true });
  }
}

function recordsForConstraint(constraint, index, prefix = 'duplicate') {
  const values = Object.fromEntries(constraint.fields.map((field) => [
    field,
    `${prefix}_${index}_${field}`
  ]));
  const first = { id: `${prefix}_${index}_first`, ...values };
  const second = { id: `${prefix}_${index}_second`, ...values };

  if (constraint.rule === 'syncJobs.active.duplicate') {
    first.status = 'queued';
    second.status = 'running';
  } else if (constraint.rule === 'operationRuns.active.dedupeKey.duplicate') {
    first.status = 'queued';
    second.status = 'running';
  } else if (constraint.rule === 'integrationEvents.dedupeKey.original.unique') {
    first.status = 'received';
    second.status = 'processed';
  } else if (constraint.rule === 'integrationMessageRefs.active.message.unique') {
    first.status = 'active';
    second.status = 'active';
  }

  return [first, second];
}

function outOfScopeRecords(constraint, index) {
  const records = recordsForConstraint(constraint, index, 'out_of_scope');
  if (constraint.rule === 'syncJobs.active.duplicate') {
    records[0].status = 'succeeded';
    records[1].status = 'failed';
  } else if (constraint.rule === 'operationRuns.active.dedupeKey.duplicate') {
    records[0].status = 'succeeded';
    records[1].status = 'cancelled';
  } else if (constraint.rule === 'integrationEvents.dedupeKey.original.unique') {
    records[0].status = 'duplicate';
    records[1].status = 'duplicate';
  } else if (constraint.rule === 'integrationMessageRefs.active.message.unique') {
    records[0].status = 'deleted';
    records[1].status = 'missing';
  } else {
    return null;
  }
  return records;
}

function insertRecord(db, collection, record, position = 0) {
  upsertSqliteCollectionRecord(db, collection, record.id, record, {
    position,
    updatedAt: '2026-07-10T00:00:00.000Z'
  });
}

test('every declared business unique key is enforced by a database UNIQUE index', async () => {
  await withTempSqlite('business-unique-enforcement', async (sqliteFile) => {
    const db = await openSqliteDatabase(sqliteFile);
    ensureSqliteSchema(db);
    const coverage = sqliteJsonFieldIndexes(db).businessUniqueConstraints;

    assert.equal(coverage.expected, SQLITE_BUSINESS_UNIQUE_CONSTRAINTS.length);
    assert.equal(coverage.missing.length, 0);
    assert.equal(coverage.constraints.length, SQLITE_BUSINESS_UNIQUE_CONSTRAINTS.length);
    assert.equal(coverage.constraints.every((item) => item.covered && item.unique && item.definitionMatches), true);

    SQLITE_BUSINESS_UNIQUE_CONSTRAINTS.forEach((constraint, index) => {
      const [first, second] = recordsForConstraint(constraint, index);
      insertRecord(db, constraint.collection, first, index * 2);
      assert.throws(
        () => insertRecord(db, constraint.collection, second, index * 2 + 1),
        /UNIQUE constraint failed/,
        constraint.rule
      );

      const outOfScope = outOfScopeRecords(constraint, index);
      if (!outOfScope) return;
      insertRecord(db, constraint.collection, outOfScope[0], index * 2 + 100);
      assert.doesNotThrow(() => {
        insertRecord(db, constraint.collection, outOfScope[1], index * 2 + 101);
      }, constraint.rule);
    });
  });
});

test('business unique index coverage rejects an ordinary index with the expected name', async () => {
  await withTempSqlite('business-unique-index-coverage', async (sqliteFile) => {
    const db = await openSqliteDatabase(sqliteFile);
    ensureSqliteSchema(db);
    const target = sqliteJsonFieldIndexes(db).businessUniqueConstraints.constraints[0];

    db.exec(`DROP INDEX ${target.indexName}`);
    db.exec(`CREATE INDEX ${target.indexName} ON json_records(collection)`);

    const coverage = sqliteJsonFieldIndexes(db).businessUniqueConstraints;
    const missing = coverage.missing.find((item) => item.rule === target.rule);
    assert.ok(missing);
    assert.equal(missing.unique, false);
    assert.equal(missing.covered, false);
  });
});

test('business UNIQUE migration accepts clean existing data and rebuilds missing constraints', async () => {
  await withTempSqlite('business-unique-clean-migration', async (sqliteFile) => {
    let db = await openSqliteDatabase(sqliteFile);
    ensureSqliteSchema(db);
    const initial = sqliteJsonFieldIndexes(db).businessUniqueConstraints;
    for (const constraint of initial.constraints) db.exec(`DROP INDEX ${constraint.indexName}`);
    db.exec(`CREATE INDEX ${initial.constraints[0].indexName} ON json_records(collection)`);

    SQLITE_BUSINESS_UNIQUE_CONSTRAINTS.forEach((constraint, index) => {
      const [record] = recordsForConstraint(constraint, index, 'clean_migration');
      insertRecord(db, constraint.collection, record, index);
    });
    await closeSqliteDatabasesForTests();

    db = await openSqliteDatabase(sqliteFile);
    assert.doesNotThrow(() => ensureSqliteSchema(db));
    const migrated = sqliteJsonFieldIndexes(db).businessUniqueConstraints;
    assert.equal(migrated.missing.length, 0);
    assert.equal(migrated.covered, migrated.expected);
  });
});

test('business UNIQUE migration fails clearly when existing data has duplicates', async () => {
  await withTempSqlite('business-unique-dirty-migration', async (sqliteFile) => {
    let db = await openSqliteDatabase(sqliteFile);
    ensureSqliteSchema(db);
    const target = sqliteJsonFieldIndexes(db).businessUniqueConstraints.constraints
      .find((item) => item.rule === 'members.steamId.unique');
    db.exec(`DROP INDEX ${target.indexName}`);
    db.exec(`CREATE INDEX ${target.indexName} ON json_records(collection)`);
    insertRecord(db, 'members', { id: 'dirty_member_1', steamId: 'duplicate_steam_id' });
    insertRecord(db, 'members', { id: 'dirty_member_2', steamId: 'duplicate_steam_id' });
    await closeSqliteDatabasesForTests();

    db = await openSqliteDatabase(sqliteFile);
    assert.throws(
      () => ensureSqliteSchema(db),
      /SQLite business UNIQUE migration blocked: members\.steamId\.unique.*count=2/
    );
  });
});

test('collection replacement allows clean unique-key reassignment and swaps', async () => {
  await withTempSqlite('business-unique-replace', async (sqliteFile) => {
    const db = await openSqliteDatabase(sqliteFile);
    ensureSqliteSchema(db);
    const replaceMembers = (members, reason) => runSqliteTransaction(db, reason, (statements) => (
      replaceSqliteCollectionRecords(db, 'members', members, { statements })
    ));

    replaceMembers([
      { id: 'member_old_id', steamId: 'steam_reassigned' }
    ], 'business_unique_replace_seed');
    assert.doesNotThrow(() => {
      replaceMembers([
        { id: 'member_new_id', steamId: 'steam_reassigned' }
      ], 'business_unique_replace_reassign');
    });

    replaceMembers([
      { id: 'member_new_id', steamId: 'steam_first' },
      { id: 'member_swap_peer', steamId: 'steam_second' }
    ], 'business_unique_replace_swap_seed');
    assert.doesNotThrow(() => {
      replaceMembers([
        { id: 'member_new_id', steamId: 'steam_second' },
        { id: 'member_swap_peer', steamId: 'steam_first' }
      ], 'business_unique_replace_swap');
    });

    const members = listSqliteCollectionRecords(db, 'members', { limit: 0 });
    assert.deepEqual(members.map((member) => [member.id, member.steamId]), [
      ['member_new_id', 'steam_second'],
      ['member_swap_peer', 'steam_first']
    ]);
  });
});

test('store patch atomically swaps business unique keys and preserves record positions', async () => {
  await withTempSqlite('business-unique-patch-swap', async (sqliteFile) => {
    const previousMode = process.env.NB_STORAGE_MODE;
    const previousFile = process.env.NB_SQLITE_FILE;
    process.env.NB_STORAGE_MODE = 'sqlite-primary';
    process.env.NB_SQLITE_FILE = sqliteFile;
    try {
      const db = await openSqliteDatabase(sqliteFile);
      ensureSqliteSchema(db);
      insertRecord(db, 'members', { id: 'member_patch_first', steamId: 'steam_patch_first' }, 4);
      insertRecord(db, 'members', { id: 'member_patch_second', steamId: 'steam_patch_second' }, 9);

      await assert.doesNotReject(() => writeSqliteStorePatch({
        reason: 'business_unique_patch_swap',
        upserts: {
          members: [
            { id: 'member_patch_first', steamId: 'steam_patch_second' },
            { id: 'member_patch_second', steamId: 'steam_patch_first' }
          ]
        }
      }));

      const members = listSqliteCollectionRecords(db, 'members', { limit: 0 });
      assert.deepEqual(members.map((member) => [member.id, member.steamId]), [
        ['member_patch_first', 'steam_patch_second'],
        ['member_patch_second', 'steam_patch_first']
      ]);
      const positions = db.prepare(`
        SELECT id, position
        FROM json_records
        WHERE collection = 'members'
        ORDER BY position ASC
      `).all().map((row) => ({ ...row }));
      assert.deepEqual(positions, [
        { id: 'member_patch_first', position: 4 },
        { id: 'member_patch_second', position: 9 }
      ]);
    } finally {
      if (previousMode === undefined) delete process.env.NB_STORAGE_MODE;
      else process.env.NB_STORAGE_MODE = previousMode;
      if (previousFile === undefined) delete process.env.NB_SQLITE_FILE;
      else process.env.NB_SQLITE_FILE = previousFile;
    }
  });
});
