import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import {
  access,
  appendFile,
  mkdtemp,
  readFile,
  rm,
  stat
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';

const execFileAsync = promisify(execFile);

function modeBits(stats) {
  return stats.mode & 0o777;
}

async function exists(file) {
  try {
    await access(file);
    return true;
  } catch {
    return false;
  }
}

async function sha256File(file) {
  return crypto.createHash('sha256').update(await readFile(file)).digest('hex');
}

async function runBackupCommand(args) {
  try {
    const result = await execFileAsync(process.execPath, ['scripts/sqlite-backup.js', ...args], {
      cwd: path.resolve('.'),
      maxBuffer: 10 * 1024 * 1024
    });
    return { code: 0, stdout: result.stdout, stderr: result.stderr };
  } catch (error) {
    return {
      code: Number(error.code || 1),
      stdout: String(error.stdout || ''),
      stderr: String(error.stderr || '')
    };
  }
}

test('sqlite backup creates and verifies a standalone atomic snapshot from a live WAL database', async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'nb-clan-sqlite-backup-command-'));
  const source = path.join(dataDir, 'live.sqlite');
  const backupDir = path.join(dataDir, 'backups');
  const target = path.join(backupDir, 'snapshot.sqlite');
  const sourceDb = new DatabaseSync(source);

  try {
    sourceDb.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA wal_autocheckpoint = 0;
      CREATE TABLE records (id INTEGER PRIMARY KEY, value TEXT NOT NULL);
      BEGIN;
      ${Array.from({ length: 100 }, (_, index) => `INSERT INTO records(value) VALUES ('value-${index}');`).join('\n')}
      COMMIT;
    `);
    assert.equal(await exists(`${source}-wal`), true);

    const created = await runBackupCommand(['--sqlite', source, '--target', target]);
    assert.equal(created.code, 0, created.stderr || created.stdout);
    const payload = JSON.parse(created.stdout);
    assert.equal(payload.ok, true);
    assert.equal(payload.verification.readable, true);
    assert.equal(payload.verification.integrity, 'ok');
    assert.equal(payload.pagesCopied > 0, true);

    assert.equal(await exists(target), true);
    assert.equal(await exists(`${target}-wal`), false);
    assert.equal(await exists(`${target}-shm`), false);
    assert.equal(await exists(`${target}.sha256`), true);
    assert.equal(await exists(`${target}.manifest.json`), true);
    assert.equal(modeBits(await stat(backupDir)), 0o700);
    assert.equal(modeBits(await stat(target)), 0o600);
    assert.equal(modeBits(await stat(`${target}.sha256`)), 0o600);
    assert.equal(modeBits(await stat(`${target}.manifest.json`)), 0o600);

    const restored = new DatabaseSync(target, { readOnly: true });
    try {
      assert.equal(restored.prepare('SELECT COUNT(*) AS count FROM records').get().count, 100);
      assert.equal(restored.prepare('PRAGMA journal_mode').get().journal_mode, 'delete');
      assert.equal(restored.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
    } finally {
      restored.close();
    }

    const checksum = (await readFile(`${target}.sha256`, 'utf8')).trim().split(/\s+/)[0];
    assert.equal(checksum, await sha256File(target));
    const verified = await runBackupCommand(['--verify', target]);
    assert.equal(verified.code, 0, verified.stderr || verified.stdout);
    assert.equal(JSON.parse(verified.stdout).verification.integrity, 'ok');

    const beforeCollisionHash = await sha256File(target);
    const collision = await runBackupCommand(['--sqlite', source, '--target', target]);
    assert.notEqual(collision.code, 0);
    assert.match(collision.stderr, /refusing to overwrite/i);
    assert.equal(await sha256File(target), beforeCollisionHash);

    await appendFile(target, 'tampered');
    const corrupted = await runBackupCommand(['--verify', target]);
    assert.notEqual(corrupted.code, 0);
    assert.match(corrupted.stderr, /checksum mismatch/i);

    const sharedTarget = path.join('/tmp', `nb-clan-insecure-backup-parent-${process.pid}.sqlite`);
    const sharedTempMode = modeBits(await stat('/tmp'));
    const insecureParent = await runBackupCommand(['--sqlite', source, '--target', sharedTarget]);
    assert.notEqual(insecureParent.code, 0);
    assert.match(insecureParent.stderr, /must already be mode 0700/i);
    assert.equal(modeBits(await stat('/tmp')), sharedTempMode);
    assert.equal(await exists(sharedTarget), false);

    const missingTarget = path.join(backupDir, 'missing-source.sqlite');
    const missing = await runBackupCommand([
      '--sqlite',
      path.join(dataDir, 'does-not-exist.sqlite'),
      '--target',
      missingTarget
    ]);
    assert.notEqual(missing.code, 0);
    assert.equal(await exists(missingTarget), false);
    assert.equal(await exists(`${missingTarget}.sha256`), false);
    assert.equal(await exists(`${missingTarget}.manifest.json`), false);
  } finally {
    sourceDb.close();
    await rm(dataDir, { recursive: true, force: true });
  }
});
