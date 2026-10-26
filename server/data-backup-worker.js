import { performance } from 'node:perf_hooks';
import { DatabaseSync } from 'node:sqlite';
import { parentPort, workerData } from 'node:worker_threads';

function sqliteSqlString(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
}

function publicError(error) {
  return {
    name: String(error?.name || 'Error').slice(0, 100),
    message: String(error?.message || error || 'SQLite backup worker failed').slice(0, 1000),
    code: String(error?.code || '').slice(0, 100),
    stack: String(error?.stack || '').slice(0, 4000)
  };
}

if (!parentPort) throw new Error('SQLite backup worker requires a parent port');

const startedAt = performance.now();
let db = null;
let backupDb = null;
try {
  const source = String(workerData?.source || '');
  const target = String(workerData?.target || '');
  if (!source || !target) throw new Error('SQLite backup worker requires source and target paths');
  if (source === target) throw new Error('SQLite backup source and target must differ');

  db = new DatabaseSync(source);
  db.exec('PRAGMA busy_timeout = 5000');
  db.exec(`VACUUM INTO ${sqliteSqlString(target)}`);
  backupDb = new DatabaseSync(target, { readOnly: true });
  const integrity = backupDb.prepare('PRAGMA integrity_check').all().map((row) => String(row.integrity_check || ''));
  if (integrity.length !== 1 || integrity[0] !== 'ok') {
    throw Object.assign(new Error(`SQLite backup integrity check failed: ${integrity.join('; ') || 'no result'}`), {
      code: 'SQLITE_BACKUP_INTEGRITY_FAILED'
    });
  }
  parentPort.postMessage({
    ok: true,
    durationMs: Number((performance.now() - startedAt).toFixed(3)),
    integrity
  });
} catch (error) {
  parentPort.postMessage({
    ok: false,
    durationMs: Number((performance.now() - startedAt).toFixed(3)),
    error: publicError(error)
  });
  process.exitCode = 1;
} finally {
  try {
    backupDb?.close();
  } catch {
    // The worker is exiting; the verification connection cannot be reused.
  }
  try {
    db?.close();
  } catch {
    // The worker is exiting; the source connection cannot be reused.
  }
}
