import assert from 'node:assert/strict';
import { access, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';

async function exists(file) {
  try {
    await access(file);
    return true;
  } catch {
    return false;
  }
}

test('server data backup snapshots data dir and keeps latest three backups', async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'nb-clan-data-backup-'));
  const backupDir = path.join(dataDir, 'backups', 'server-data');
  try {
    await mkdir(path.join(dataDir, 'uploads', 'avatars'), { recursive: true });
    await writeFile(path.join(dataDir, 'store.json'), '{"ok":true}\n', 'utf8');
    await writeFile(path.join(dataDir, 'nb-clan.sqlite'), 'sqlite-bytes', 'utf8');
    await writeFile(path.join(dataDir, 'store.json.123.tmp'), 'temporary-write', 'utf8');
    await writeFile(path.join(dataDir, 'uploads', 'avatars', 'alpha.txt'), 'avatar', 'utf8');

    for (const name of [
      'nb-clan-data-20260624-010000',
      'nb-clan-data-20260624-020000',
      'nb-clan-data-20260624-030000'
    ]) {
      await mkdir(path.join(backupDir, name), { recursive: true });
      await writeFile(path.join(backupDir, name, 'old.txt'), name, 'utf8');
    }
    const staleTempBackup = path.join(backupDir, 'nb-clan-data-20260624-070000.tmp-crashed');
    await mkdir(staleTempBackup, { recursive: true });
    await writeFile(path.join(staleTempBackup, 'partial.txt'), 'incomplete', 'utf8');

    const { createServerDataBackup } = await import(`../server/data-backup.js?test-${Date.now()}`);
    const backup = await createServerDataBackup({
      dataDir,
      backupDir,
      retention: 3,
      now: new Date('2026-06-24T08:00:00.000Z'),
      sqliteEnabled: () => false
    });

    assert.equal(backup.ok, true);
    assert.equal(path.basename(backup.path), 'nb-clan-data-20260624-080000');
    assert.equal(await readFile(path.join(backup.path, 'store.json'), 'utf8'), '{"ok":true}\n');
    assert.equal(await readFile(path.join(backup.path, 'uploads', 'avatars', 'alpha.txt'), 'utf8'), 'avatar');
    assert.equal(await exists(path.join(backup.path, 'store.json.123.tmp')), false);
    assert.equal(await exists(path.join(backup.path, 'backups')), false);
    assert.equal(await exists(staleTempBackup), false);

    const metadata = JSON.parse(await readFile(path.join(backup.path, 'backup-meta.json'), 'utf8'));
    assert.equal(metadata.createdAt, '2026-06-24T08:00:00.000Z');
    assert.equal(metadata.retention, 3);
    assert.equal((await stat(backupDir)).mode & 0o777, 0o700);
    assert.equal((await stat(backup.path)).mode & 0o777, 0o700);
    assert.equal((await stat(path.join(backup.path, 'store.json'))).mode & 0o777, 0o600);
    assert.equal((await stat(path.join(backup.path, 'backup-meta.json'))).mode & 0o777, 0o600);

    const retained = (await readdir(backupDir))
      .filter((name) => name.startsWith('nb-clan-data-'))
      .sort();
    assert.deepEqual(retained, [
      'nb-clan-data-20260624-020000',
      'nb-clan-data-20260624-030000',
      'nb-clan-data-20260624-080000'
    ]);
    assert.equal(backup.removed.length, 1);
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});

test('server data backup writes a consistent sqlite snapshot instead of live wal files', async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'nb-clan-data-backup-sqlite-'));
  const backupDir = path.join(dataDir, 'backups', 'server-data');
  try {
    const sqliteFile = path.join(dataDir, 'nb-clan.sqlite');
    await writeFile(path.join(dataDir, 'store.json'), '{"mode":"sqlite-primary"}\n', 'utf8');
    await writeFile(sqliteFile, 'live-sqlite-file', 'utf8');
    await writeFile(`${sqliteFile}-wal`, 'live-wal-file', 'utf8');
    await writeFile(`${sqliteFile}-shm`, 'live-shm-file', 'utf8');

    const { createServerDataBackup } = await import(`../server/data-backup.js?sqlite-test-${Date.now()}`);
    const backup = await createServerDataBackup({
      dataDir,
      backupDir,
      retention: 3,
      now: new Date('2026-06-24T09:00:00.000Z'),
      sqliteEnabled: () => true,
      sqliteFile,
      backupSqlite: async (_source, target) => {
        await writeFile(target, 'consistent-sqlite-snapshot', 'utf8');
      }
    });

    assert.equal(await readFile(path.join(backup.path, 'nb-clan.sqlite'), 'utf8'), 'consistent-sqlite-snapshot');
    assert.equal((await stat(path.join(backup.path, 'nb-clan.sqlite'))).mode & 0o777, 0o600);
    assert.equal(await exists(path.join(backup.path, 'nb-clan.sqlite-wal')), false);
    assert.equal(await exists(path.join(backup.path, 'nb-clan.sqlite-shm')), false);
    const metadata = JSON.parse(await readFile(path.join(backup.path, 'backup-meta.json'), 'utf8'));
    assert.equal(metadata.sqlite.method, 'custom');
    assert.equal(metadata.sqlite.target, 'nb-clan.sqlite');
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});

test('server data backup uses the worker VACUUM INTO path for a live sqlite database', async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'nb-clan-data-backup-worker-'));
  const backupDir = path.join(dataDir, 'backups', 'server-data');
  const sqliteFile = path.join(dataDir, 'nb-clan.sqlite');
  let sourceDb = null;
  let backupDb = null;
  try {
    await writeFile(path.join(dataDir, 'store.json'), '{"mode":"sqlite-primary"}\n', 'utf8');
    sourceDb = new DatabaseSync(sqliteFile);
    sourceDb.exec('PRAGMA journal_mode = WAL');
    sourceDb.exec('CREATE TABLE backup_probe (id TEXT PRIMARY KEY, value TEXT NOT NULL)');
    sourceDb.prepare('INSERT INTO backup_probe (id, value) VALUES (?, ?)').run('probe_1', 'from-live-sqlite');

    const backupModule = await import('../server/data-backup.js');
    const before = backupModule.serverDataBackupRuntimeSnapshot();
    const backup = await backupModule.createServerDataBackup({
      dataDir,
      backupDir,
      retention: 3,
      now: new Date('2026-06-24T10:00:00.000Z'),
      sqliteEnabled: () => true,
      sqliteFile,
      sqliteWorkerTimeoutMs: 5000
    });

    const backupFile = path.join(backup.path, 'nb-clan.sqlite');
    backupDb = new DatabaseSync(backupFile, { readOnly: true });
    const backupRow = backupDb.prepare('SELECT id, value FROM backup_probe').get();
    assert.equal(backupRow.id, 'probe_1');
    assert.equal(backupRow.value, 'from-live-sqlite');
    assert.equal(await exists(`${backupFile}-wal`), false);
    assert.equal(await exists(`${backupFile}-shm`), false);

    const metadata = JSON.parse(await readFile(path.join(backup.path, 'backup-meta.json'), 'utf8'));
    assert.equal(metadata.sqlite.method, 'vacuum_into_worker');
    assert.equal(metadata.sqlite.target, 'nb-clan.sqlite');
    assert.deepEqual(metadata.sqlite.integrity, ['ok']);
    assert.equal(typeof metadata.sqlite.durationMs, 'number');
    assert.equal(backup.sqlite.method, 'vacuum_into_worker');
    assert.deepEqual(backup.sqlite.integrity, ['ok']);
    assert.equal(typeof backup.durationMs, 'number');

    const after = backupModule.serverDataBackupRuntimeSnapshot();
    assert.equal(after.attempts, before.attempts + 1);
    assert.equal(after.succeeded, before.succeeded + 1);
    assert.equal(after.failed, before.failed);
    assert.equal(after.running, 0);
    assert.equal(after.lastPath, backup.path);
    assert.equal(after.lastError, '');
    assert.equal(typeof after.lastDurationMs, 'number');
  } finally {
    backupDb?.close();
    sourceDb?.close();
    await rm(dataDir, { recursive: true, force: true });
  }
});

test('server data backup records failures and elapsed time in runtime health', async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'nb-clan-data-backup-health-'));
  const backupDir = path.join(dataDir, 'backups', 'server-data');
  try {
    const sqliteFile = path.join(dataDir, 'nb-clan.sqlite');
    await writeFile(sqliteFile, 'not-used-by-custom-backup', 'utf8');
    const backupModule = await import('../server/data-backup.js');
    const before = backupModule.serverDataBackupRuntimeSnapshot();

    await assert.rejects(
      () => backupModule.createServerDataBackup({
        dataDir,
        backupDir,
        sqliteEnabled: () => true,
        sqliteFile,
        backupSqlite: async () => {
          throw new Error('injected sqlite backup failure');
        }
      }),
      /injected sqlite backup failure/
    );

    const after = backupModule.serverDataBackupRuntimeSnapshot();
    assert.equal(after.attempts, before.attempts + 1);
    assert.equal(after.failed, before.failed + 1);
    assert.equal(after.succeeded, before.succeeded);
    assert.equal(after.running, 0);
    assert.match(after.lastError, /injected sqlite backup failure/);
    assert.equal(typeof after.lastDurationMs, 'number');
    assert.equal(Boolean(after.lastFailedAt), true);
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});

test('server data backup schedule drain waits for the active snapshot and prevents new runs', async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'nb-clan-data-backup-drain-'));
  const backupDir = path.join(dataDir, 'backups', 'server-data');
  const sqliteFile = path.join(dataDir, 'nb-clan.sqlite');
  const started = Promise.withResolvers();
  const release = Promise.withResolvers();
  try {
    await writeFile(sqliteFile, 'sqlite-source', 'utf8');
    const { startServerDataBackupSchedule } = await import('../server/data-backup.js');
    const schedule = startServerDataBackupSchedule({
      dataDir,
      backupDir,
      sqliteFile,
      sqliteEnabled: () => true,
      initialDelayMs: 60_000,
      intervalMs: 60_000,
      backupSqlite: async (_source, target) => {
        started.resolve();
        await release.promise;
        await writeFile(target, 'consistent-snapshot', 'utf8');
      }
    });
    assert.ok(schedule);
    const run = schedule.runNow();
    await started.promise;

    let drained = false;
    const drain = schedule.drain().then(() => { drained = true; });
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(drained, false);
    release.resolve();
    const backup = await run;
    await drain;

    assert.equal(backup.ok, true);
    assert.equal(await readFile(path.join(backup.path, 'nb-clan.sqlite'), 'utf8'), 'consistent-snapshot');
    assert.equal(await schedule.runNow(), null);
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});
