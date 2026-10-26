import assert from 'node:assert/strict';
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

function modeBits(stats) {
  return stats.mode & 0o777;
}

test('store, sqlite, credentials, secrets, and backups use secure modes and repair existing modes', async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'nb-clan-secure-modes-'));
  const sqliteFile = path.join(dataDir, 'nb-clan.sqlite');
  const previousEnv = {
    NB_DATA_DIR: process.env.NB_DATA_DIR,
    NB_SQLITE_FILE: process.env.NB_SQLITE_FILE,
    NB_STORAGE_MODE: process.env.NB_STORAGE_MODE,
    NB_ROOT_PASSWORD: process.env.NB_ROOT_PASSWORD
  };

  process.env.NB_DATA_DIR = dataDir;
  process.env.NB_SQLITE_FILE = sqliteFile;
  process.env.NB_STORAGE_MODE = 'json';
  process.env.NB_ROOT_PASSWORD = 'RootPass123!';

  try {
    const backupLeaf = path.join(dataDir, 'backups', 'legacy', 'nested');
    await mkdir(backupLeaf, { recursive: true });
    await writeFile(path.join(dataDir, 'store.json'), '{}\n', 'utf8');
    await writeFile(path.join(dataDir, 'root-credentials.txt'), 'root-secret\n', 'utf8');
    await writeFile(path.join(dataDir, 'session-secret.txt'), 'short\n', 'utf8');
    await writeFile(sqliteFile, 'legacy-placeholder', 'utf8');
    await writeFile(path.join(backupLeaf, 'snapshot.txt'), 'backup-secret\n', 'utf8');

    await chmod(dataDir, 0o755);
    await chmod(path.join(dataDir, 'backups'), 0o755);
    await chmod(path.join(dataDir, 'backups', 'legacy'), 0o755);
    await chmod(backupLeaf, 0o755);
    for (const file of [
      path.join(dataDir, 'store.json'),
      path.join(dataDir, 'root-credentials.txt'),
      path.join(dataDir, 'session-secret.txt'),
      sqliteFile,
      path.join(backupLeaf, 'snapshot.txt')
    ]) {
      await chmod(file, 0o644);
    }

    const storeModule = await import(`../server/store.js?secure-modes-${Date.now()}`);
    await storeModule.ensureStore();
    const sessionSecret = await storeModule.getSessionSecret();

    assert.equal(modeBits(await stat(dataDir)), 0o700);
    assert.equal(modeBits(await stat(path.join(dataDir, 'store.json'))), 0o600);
    assert.equal(modeBits(await stat(path.join(dataDir, 'root-credentials.txt'))), 0o600);
    assert.equal(modeBits(await stat(path.join(dataDir, 'session-secret.txt'))), 0o600);
    assert.equal(modeBits(await stat(sqliteFile)), 0o600);
    assert.equal(modeBits(await stat(path.join(dataDir, 'backups'))), 0o700);
    assert.equal(modeBits(await stat(backupLeaf)), 0o700);
    assert.equal(modeBits(await stat(path.join(backupLeaf, 'snapshot.txt'))), 0o600);
    assert.equal(sessionSecret.length >= 32, true);
    assert.equal((await readFile(path.join(dataDir, 'session-secret.txt'), 'utf8')).trim(), sessionSecret);

    const runtimeSqlite = path.join(dataDir, 'runtime.sqlite');
    const sqliteModule = await import('../server/storage/sqlite.js');
    const sharedTempMode = modeBits(await stat('/tmp'));
    await assert.rejects(
      () => sqliteModule.ensureSqliteDir(path.join('/tmp', `nb-clan-shared-parent-${process.pid}.sqlite`)),
      /must already be mode 0700/
    );
    assert.equal(modeBits(await stat('/tmp')), sharedTempMode);
    const db = await sqliteModule.openSqliteDatabase(runtimeSqlite);
    db.exec('CREATE TABLE secure_mode_test (id INTEGER PRIMARY KEY); INSERT INTO secure_mode_test DEFAULT VALUES;');
    await sqliteModule.secureSqliteFilePermissions(runtimeSqlite);
    assert.equal(modeBits(await stat(runtimeSqlite)), 0o600);
    assert.equal(modeBits(await stat(`${runtimeSqlite}-wal`)), 0o600);
    assert.equal(modeBits(await stat(`${runtimeSqlite}-shm`)), 0o600);

    const { createServerDataBackup } = await import(`../server/data-backup.js?secure-backup-${Date.now()}`);
    const generatedBackup = await createServerDataBackup({
      dataDir,
      backupDir: path.join(dataDir, 'backups', 'server-data'),
      retention: 1,
      now: new Date('2026-07-10T00:00:00.000Z'),
      sqliteEnabled: () => false
    });
    assert.equal(modeBits(await stat(generatedBackup.path)), 0o700);
    assert.equal(modeBits(await stat(path.join(generatedBackup.path, 'store.json'))), 0o600);
    assert.equal(modeBits(await stat(path.join(generatedBackup.path, 'backup-meta.json'))), 0o600);
  } finally {
    const sqliteModule = await import('../server/storage/sqlite.js');
    await sqliteModule.closeSqliteDatabasesForTests();
    Object.assign(process.env, previousEnv);
    for (const [key, value] of Object.entries(previousEnv)) {
      if (value === undefined) delete process.env[key];
    }
    await rm(dataDir, { recursive: true, force: true });
  }
});
