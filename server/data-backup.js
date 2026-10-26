import { promises as fs } from 'node:fs';
import path from 'node:path';
import { Worker } from 'node:worker_threads';
import { DATA_DIR } from './store.js';
import { sqliteEnabled, sqliteFilePath } from './storage/sqlite.js';

const BACKUP_PREFIX = 'nb-clan-data-';
const DEFAULT_BACKUP_INTERVAL_MS = 60 * 60 * 1000;
const DEFAULT_BACKUP_INITIAL_DELAY_MS = 60 * 1000;
const DEFAULT_BACKUP_RETENTION = 3;
const DEFAULT_SQLITE_WORKER_TIMEOUT_MS = 10 * 60 * 1000;

const serverDataBackupRuntime = {
  running: 0,
  attempts: 0,
  succeeded: 0,
  failed: 0,
  lastStatus: 'never',
  lastStartedAt: '',
  lastFinishedAt: '',
  lastSucceededAt: '',
  lastFailedAt: '',
  lastDurationMs: 0,
  lastPath: '',
  lastSqliteMethod: '',
  lastError: ''
};

function timestampForBackup(date = new Date()) {
  return date.toISOString().replace(/[-:]/g, '').replace(/\..+$/, '').replace('T', '-');
}

function normalizePositiveInteger(value, fallback) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.floor(parsed);
}

function defaultBackupDir(dataDir = DATA_DIR) {
  return path.join(dataDir, 'backups', 'server-data');
}

async function pathExists(target) {
  try {
    await fs.access(target);
    return true;
  } catch {
    return false;
  }
}

function isSameOrInside(candidate, parent) {
  const relative = path.relative(parent, candidate);
  return !relative || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function normalizeRuntimeError(error) {
  return String(error?.message || error || '').trim().slice(0, 1000);
}

function recordBackupStarted(startedAtMs) {
  serverDataBackupRuntime.running += 1;
  serverDataBackupRuntime.attempts += 1;
  serverDataBackupRuntime.lastStatus = 'running';
  serverDataBackupRuntime.lastStartedAt = new Date(startedAtMs).toISOString();
}

function recordBackupFinished({ startedAtMs, path: backupPath = '', sqlite = null, error = null }) {
  const finishedAt = new Date();
  serverDataBackupRuntime.running = Math.max(0, serverDataBackupRuntime.running - 1);
  serverDataBackupRuntime.lastFinishedAt = finishedAt.toISOString();
  serverDataBackupRuntime.lastDurationMs = Math.max(0, finishedAt.getTime() - startedAtMs);
  serverDataBackupRuntime.lastPath = backupPath || '';
  serverDataBackupRuntime.lastSqliteMethod = sqlite?.method || '';
  if (error) {
    serverDataBackupRuntime.failed += 1;
    serverDataBackupRuntime.lastStatus = 'failed';
    serverDataBackupRuntime.lastFailedAt = finishedAt.toISOString();
    serverDataBackupRuntime.lastError = normalizeRuntimeError(error);
    return;
  }
  serverDataBackupRuntime.succeeded += 1;
  serverDataBackupRuntime.lastStatus = 'succeeded';
  serverDataBackupRuntime.lastSucceededAt = finishedAt.toISOString();
  serverDataBackupRuntime.lastError = '';
}

export function serverDataBackupRuntimeSnapshot() {
  return { ...serverDataBackupRuntime };
}

function sqliteWorkerError(payload = {}) {
  const error = new Error(payload.message || 'SQLite backup worker failed');
  error.name = payload.name || 'Error';
  if (payload.code) error.code = payload.code;
  if (payload.stack) error.stack = payload.stack;
  return error;
}

function backupSqliteInWorker(source, target, options = {}) {
  const timeoutMs = normalizePositiveInteger(
    options.sqliteWorkerTimeoutMs ?? process.env.NB_DATA_BACKUP_SQLITE_WORKER_TIMEOUT_MS,
    DEFAULT_SQLITE_WORKER_TIMEOUT_MS
  );
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL('./data-backup-worker.js', import.meta.url), {
      workerData: { source, target }
    });
    let settled = false;
    const finish = (callback, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      callback(value);
    };
    const timeout = setTimeout(() => {
      const error = Object.assign(
        new Error(`SQLite backup worker timed out after ${timeoutMs}ms`),
        { code: 'SQLITE_BACKUP_WORKER_TIMEOUT', timeoutMs }
      );
      finish(reject, error);
      void worker.terminate().catch(() => {});
    }, timeoutMs);

    worker.once('message', (message) => {
      if (message?.ok) finish(resolve, message);
      else finish(reject, sqliteWorkerError(message?.error));
    });
    worker.once('error', (error) => finish(reject, error));
    worker.once('exit', (code) => {
      if (!settled) {
        finish(reject, Object.assign(
          new Error(`SQLite backup worker exited before reporting a result (${code})`),
          { code: 'SQLITE_BACKUP_WORKER_EXIT', exitCode: code }
        ));
      }
    });
  });
}

function shouldSkipBackupPath(sourcePath, options) {
  const basename = path.basename(sourcePath);
  if (basename.endsWith('.tmp')) return true;
  return options.excludedRoots.some((excludedRoot) => isSameOrInside(sourcePath, excludedRoot));
}

async function copyDirectorySnapshot(sourceDir, targetDir, options) {
  await fs.mkdir(targetDir, { recursive: true, mode: 0o700 });
  await fs.chmod(targetDir, 0o700);
  const entries = await fs.readdir(sourceDir, { withFileTypes: true });
  for (const entry of entries) {
    const sourcePath = path.join(sourceDir, entry.name);
    if (shouldSkipBackupPath(path.resolve(sourcePath), options)) continue;
    const targetPath = path.join(targetDir, entry.name);
    if (entry.isDirectory()) {
      await copyDirectorySnapshot(sourcePath, targetPath, options);
      continue;
    }
    if (!entry.isFile()) continue;
    await fs.copyFile(sourcePath, targetPath);
    await fs.chmod(targetPath, 0o600);
  }
}

async function nextBackupPath(backupDir, createdAt) {
  const baseName = `${BACKUP_PREFIX}${timestampForBackup(createdAt)}`;
  let candidate = path.join(backupDir, baseName);
  let suffix = 1;
  while (await pathExists(candidate)) {
    candidate = path.join(backupDir, `${baseName}-${suffix}`);
    suffix += 1;
  }
  return candidate;
}

async function listServerDataBackups(backupDir) {
  let entries = [];
  try {
    entries = await fs.readdir(backupDir, { withFileTypes: true });
  } catch (error) {
    if (error?.code === 'ENOENT') return [];
    throw error;
  }
  return entries
    .filter((entry) => entry.name.startsWith(BACKUP_PREFIX) && !entry.name.includes('.tmp-'))
    .map((entry) => ({
      name: entry.name,
      path: path.join(backupDir, entry.name),
      directory: entry.isDirectory()
    }))
    .sort((left, right) => right.name.localeCompare(left.name));
}

async function removeIncompleteServerDataBackups(backupDir) {
  let entries = [];
  try {
    entries = await fs.readdir(backupDir, { withFileTypes: true });
  } catch (error) {
    if (error?.code === 'ENOENT') return [];
    throw error;
  }
  const incomplete = entries.filter((entry) => (
    entry.name.startsWith(BACKUP_PREFIX) && entry.name.includes('.tmp-')
  ));
  for (const entry of incomplete) {
    await fs.rm(path.join(backupDir, entry.name), { recursive: entry.isDirectory(), force: true });
  }
  return incomplete.map((entry) => path.join(backupDir, entry.name));
}

export async function pruneServerDataBackups(options = {}) {
  const dataDir = path.resolve(options.dataDir || DATA_DIR);
  const backupDir = path.resolve(options.backupDir || defaultBackupDir(dataDir));
  const retention = normalizePositiveInteger(options.retention ?? process.env.NB_DATA_BACKUP_RETENTION, DEFAULT_BACKUP_RETENTION);
  const backups = await listServerDataBackups(backupDir);
  const staleBackups = backups.slice(retention);
  for (const backup of staleBackups) {
    await fs.rm(backup.path, { recursive: backup.directory, force: true });
  }
  return staleBackups.map((backup) => backup.path);
}

async function backupSqliteForBackup(dataDir, targetDir, options = {}) {
  const sqliteEnabledFn = options.sqliteEnabled || sqliteEnabled;
  if (!sqliteEnabledFn()) return null;
  const source = path.resolve(options.sqliteFile || sqliteFilePath());
  await fs.access(source);
  const relativeTarget = isSameOrInside(source, dataDir)
    ? path.relative(dataDir, source)
    : path.join('sqlite', path.basename(source));
  const target = path.join(targetDir, relativeTarget);
  await fs.mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
  await fs.chmod(path.dirname(target), 0o700);
  if (options.backupSqlite) {
    const startedAtMs = Date.now();
    await options.backupSqlite(source, target);
    await fs.chmod(target, 0o600);
    return {
      source,
      target: relativeTarget,
      method: 'custom',
      durationMs: Math.max(0, Date.now() - startedAtMs)
    };
  }
  await fs.rm(target, { force: true });
  const workerResult = await backupSqliteInWorker(source, target, options);
  await fs.chmod(target, 0o600);
  return {
    source,
    target: relativeTarget,
    method: 'vacuum_into_worker',
    durationMs: Number(workerResult.durationMs || 0),
    integrity: Array.isArray(workerResult.integrity) ? workerResult.integrity : []
  };
}

export async function createServerDataBackup(options = {}) {
  const dataDir = path.resolve(options.dataDir || DATA_DIR);
  const backupDir = path.resolve(options.backupDir || defaultBackupDir(dataDir));
  const retention = normalizePositiveInteger(options.retention ?? process.env.NB_DATA_BACKUP_RETENTION, DEFAULT_BACKUP_RETENTION);
  const createdAt = options.now instanceof Date ? options.now : new Date();
  const activeSqliteFile = path.resolve(options.sqliteFile || sqliteFilePath());
  const excludedRoots = [
    path.resolve(dataDir, 'backups'),
    activeSqliteFile,
    `${activeSqliteFile}-wal`,
    `${activeSqliteFile}-shm`,
    ...(options.excludedRoots || []).map((item) => path.resolve(item))
  ];
  if (isSameOrInside(backupDir, dataDir)) {
    excludedRoots.push(backupDir);
  }

  const startedAtMs = Date.now();
  recordBackupStarted(startedAtMs);
  let targetDir = '';
  let tempDir = '';
  let sqlite = null;
  try {
    await fs.mkdir(backupDir, { recursive: true, mode: 0o700 });
    await fs.chmod(backupDir, 0o700);
    await removeIncompleteServerDataBackups(backupDir);
    targetDir = await nextBackupPath(backupDir, createdAt);
    tempDir = `${targetDir}.tmp-${process.pid}-${Date.now()}`;
    await copyDirectorySnapshot(dataDir, tempDir, { excludedRoots });
    sqlite = await backupSqliteForBackup(dataDir, tempDir, options);
    const metadata = {
      createdAt: createdAt.toISOString(),
      dataDir,
      backupDir,
      retention,
      sqlite
    };
    const metadataPath = path.join(tempDir, 'backup-meta.json');
    await fs.writeFile(metadataPath, `${JSON.stringify(metadata, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
    await fs.chmod(metadataPath, 0o600);
    await fs.rename(tempDir, targetDir);
    const removed = await pruneServerDataBackups({ dataDir, backupDir, retention });
    const durationMs = Math.max(0, Date.now() - startedAtMs);
    const result = {
      ok: true,
      path: targetDir,
      createdAt: createdAt.toISOString(),
      retention,
      removed,
      sqlite,
      durationMs
    };
    recordBackupFinished({ startedAtMs, path: targetDir, sqlite });
    return result;
  } catch (error) {
    if (tempDir) await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
    recordBackupFinished({ startedAtMs, path: targetDir, sqlite, error });
    throw error;
  }
}

export function startServerDataBackupSchedule(options = {}) {
  if (process.env.NB_DISABLE_DATA_BACKUP === '1' || process.env.NB_DISABLE_BACKGROUND_JOBS === '1') return null;
  const intervalMs = normalizePositiveInteger(options.intervalMs ?? process.env.NB_DATA_BACKUP_INTERVAL_MS, DEFAULT_BACKUP_INTERVAL_MS);
  const initialDelayMs = normalizePositiveInteger(options.initialDelayMs ?? process.env.NB_DATA_BACKUP_INITIAL_DELAY_MS, DEFAULT_BACKUP_INITIAL_DELAY_MS);
  if (!intervalMs) return null;

  let stopped = false;
  let currentRun = null;
  const runBackup = async () => {
    if (stopped) return null;
    if (currentRun) return currentRun;
    const task = (async () => {
      try {
        const backup = await createServerDataBackup(options);
        console.log(`[nb-clan] server data backup created: ${backup.path}`);
        if (backup.removed.length) {
          console.log(`[nb-clan] server data backup pruned: ${backup.removed.length}`);
        }
        return backup;
      } catch (error) {
        console.error('[nb-clan] server data backup failed:', error?.message || error);
        return null;
      }
    })();
    currentRun = task;
    try {
      return await task;
    } finally {
      if (currentRun === task) currentRun = null;
    }
  };

  const initialTimer = setTimeout(runBackup, initialDelayMs);
  initialTimer.unref?.();
  const intervalTimer = setInterval(runBackup, intervalMs);
  intervalTimer.unref?.();

  return {
    runNow: runBackup,
    stop() {
      stopped = true;
      clearTimeout(initialTimer);
      clearInterval(intervalTimer);
    },
    async drain() {
      stopped = true;
      clearTimeout(initialTimer);
      clearInterval(intervalTimer);
      if (currentRun) await currentRun;
    }
  };
}
