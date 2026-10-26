import { DatabaseSync } from 'node:sqlite';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { performance } from 'node:perf_hooks';

const SQLITE_MODES = new Set(['dual', 'hybrid', 'sqlite-primary', 'sqlite']);
const SQLITE_PRIMARY_MODES = new Set(['sqlite-primary', 'sqlite']);
const DEFAULT_SLOW_QUERY_MS = 50;
const DEFAULT_SLOW_WRITE_MS = 100;
const SECURE_DIRECTORY_MODE = 0o700;
const SECURE_FILE_MODE = 0o600;

process.umask(0o077);

const dbByFile = new Map();
const dbOpenByFile = new Map();
const runtimeStatementCache = new WeakMap();

const metrics = {
  openedAt: '',
  prepares: {
    total: 0,
    byName: {}
  },
  queries: createTimingBucket(),
  writes: createTimingBucket(),
  compatibility: {
    readSqliteStoreSlice: 0,
    hydrateStoreFromSqlite: 0,
    syncStoreChangesToSqlite: 0
  },
  lastError: '',
  lastErrorAt: ''
};
const lastCheckpoint = {
  ok: true,
  mode: '',
  ranAt: '',
  busy: 0,
  log: 0,
  checkpointed: 0,
  rowCount: 0,
  lastError: ''
};

function createTimingBucket() {
  return {
    total: 0,
    slow: 0,
    lastSlowAt: '',
    totalMs: 0,
    maxMs: 0,
    last: null,
    byName: {}
  };
}

function normalizeStorageMode(value = process.env.NB_STORAGE_MODE) {
  const mode = String(value || 'json').trim().toLowerCase();
  return mode || 'json';
}

export function storageMode() {
  return normalizeStorageMode();
}

export function sqliteEnabled(mode = storageMode()) {
  return SQLITE_MODES.has(normalizeStorageMode(mode));
}

export function sqlitePrimaryMode(mode = storageMode()) {
  return SQLITE_PRIMARY_MODES.has(normalizeStorageMode(mode));
}

export function sqliteFilePath() {
  return process.env.NB_SQLITE_FILE || path.join(process.env.NB_DATA_DIR || path.join(process.cwd(), 'data'), 'nb-clan.sqlite');
}

function sqliteSlowQueryMs() {
  const value = Number(process.env.NB_SQLITE_SLOW_QUERY_MS || DEFAULT_SLOW_QUERY_MS);
  return Number.isFinite(value) && value >= 0 ? value : DEFAULT_SLOW_QUERY_MS;
}

function sqliteSlowWriteMs() {
  const value = Number(process.env.NB_SQLITE_SLOW_WRITE_MS || DEFAULT_SLOW_WRITE_MS);
  return Number.isFinite(value) && value >= 0 ? value : DEFAULT_SLOW_WRITE_MS;
}

async function chmodIfExists(file, mode) {
  try {
    await fs.chmod(file, mode);
    return true;
  } catch (error) {
    if (error?.code === 'ENOENT') return false;
    throw error;
  }
}

export async function secureSqliteFilePermissions(file = sqliteFilePath()) {
  const normalizedFile = path.resolve(file);
  await Promise.all([
    chmodIfExists(normalizedFile, SECURE_FILE_MODE),
    chmodIfExists(`${normalizedFile}-wal`, SECURE_FILE_MODE),
    chmodIfExists(`${normalizedFile}-shm`, SECURE_FILE_MODE)
  ]);
}

export async function ensureSqliteDir(file = sqliteFilePath()) {
  const directory = path.dirname(path.resolve(file));
  const dataDirectory = path.resolve(process.env.NB_DATA_DIR || path.join(process.cwd(), 'data'));
  let created = false;
  let directoryStat = null;
  try {
    directoryStat = await fs.stat(directory);
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
    created = true;
  }
  await fs.mkdir(directory, { recursive: true, mode: SECURE_DIRECTORY_MODE });
  const isDataDirectory = directory === dataDirectory || directory.startsWith(`${dataDirectory}${path.sep}`);
  if (directory !== path.parse(directory).root && (created || isDataDirectory)) {
    await fs.chmod(directory, SECURE_DIRECTORY_MODE);
  } else if (!created && !isDataDirectory && ((directoryStat?.mode || 0) & 0o777) !== SECURE_DIRECTORY_MODE) {
    throw new Error(`SQLite directory outside NB_DATA_DIR must already be mode 0700: ${directory}`);
  }
}

export async function openSqliteDatabase(file = sqliteFilePath()) {
  const normalizedFile = path.resolve(file);
  if (dbByFile.has(normalizedFile)) return dbByFile.get(normalizedFile);
  if (dbOpenByFile.has(normalizedFile)) return dbOpenByFile.get(normalizedFile);
  const openPromise = (async () => {
    await ensureSqliteDir(normalizedFile);
    if (dbByFile.has(normalizedFile)) return dbByFile.get(normalizedFile);
    const db = new DatabaseSync(normalizedFile);
    try {
      db.exec('PRAGMA journal_mode = WAL');
      db.exec('PRAGMA synchronous = NORMAL');
      db.exec('PRAGMA foreign_keys = ON');
      await secureSqliteFilePermissions(normalizedFile);
    } catch (error) {
      db.close();
      throw error;
    }
    dbByFile.set(normalizedFile, db);
    metrics.openedAt ||= new Date().toISOString();
    return db;
  })();
  dbOpenByFile.set(normalizedFile, openPromise);
  try {
    return await openPromise;
  } finally {
    if (dbOpenByFile.get(normalizedFile) === openPromise) dbOpenByFile.delete(normalizedFile);
  }
}

export async function closeSqliteDatabases(options = {}) {
  const checkpointMode = String(options.checkpointMode || '').trim().toUpperCase();
  const allowedCheckpointMode = ['PASSIVE', 'FULL', 'RESTART', 'TRUNCATE'].includes(checkpointMode)
    ? checkpointMode
    : '';
  let firstError = null;
  const pendingOpens = await Promise.allSettled([...dbOpenByFile.values()]);
  for (const result of pendingOpens) {
    if (result.status === 'rejected') firstError ||= result.reason;
  }
  for (const db of dbByFile.values()) {
    try {
      if (allowedCheckpointMode) db.exec(`PRAGMA wal_checkpoint(${allowedCheckpointMode})`);
    } catch (error) {
      firstError ||= error;
    }
    try {
      db.close();
    } catch (error) {
      firstError ||= error;
    }
  }
  dbByFile.clear();
  if (firstError && !options.ignoreErrors) throw firstError;
}

export async function closeSqliteDatabasesForTests() {
  await closeSqliteDatabases({ ignoreErrors: true });
}

export function recordSqlitePrepare(name) {
  const key = String(name || 'unknown');
  metrics.prepares.total += 1;
  metrics.prepares.byName[key] = (metrics.prepares.byName[key] || 0) + 1;
}

function cachedRuntimeStatement(db, name, sql) {
  let cache = runtimeStatementCache.get(db);
  if (!cache) {
    cache = new Map();
    runtimeStatementCache.set(db, cache);
  }
  const key = String(name || 'unknown');
  if (!cache.has(key)) {
    recordSqlitePrepare(key);
    cache.set(key, db.prepare(sql));
  }
  return cache.get(key);
}

function recordTiming(bucket, name, elapsedMs, slowMs) {
  const key = String(name || 'unknown');
  bucket.total += 1;
  bucket.totalMs += elapsedMs;
  bucket.maxMs = Math.max(bucket.maxMs, elapsedMs);
  if (elapsedMs >= slowMs) {
    bucket.slow += 1;
    bucket.lastSlowAt = new Date().toISOString();
  }
  bucket.byName[key] ||= {
    total: 0,
    slow: 0,
    totalMs: 0,
    maxMs: 0,
    lastMs: 0
  };
  const item = bucket.byName[key];
  item.total += 1;
  item.totalMs += elapsedMs;
  item.maxMs = Math.max(item.maxMs, elapsedMs);
  item.lastMs = elapsedMs;
  if (elapsedMs >= slowMs) item.slow += 1;
  bucket.last = {
    name: key,
    ms: Number(elapsedMs.toFixed(3)),
    at: new Date().toISOString(),
    slow: elapsedMs >= slowMs
  };
}

function normalizeMetricText(value, maxLength = 240) {
  if (value === null || value === undefined) return '';
  return String(value).trim().slice(0, maxLength);
}

function recordSqliteCheckpoint(mode, rows = [], error = null) {
  const row = Array.isArray(rows) ? (rows[0] || {}) : (rows || {});
  lastCheckpoint.ok = !error;
  lastCheckpoint.mode = normalizeMetricText(mode, 20);
  lastCheckpoint.ranAt = new Date().toISOString();
  lastCheckpoint.busy = Math.max(0, Number(row.busy || 0));
  lastCheckpoint.log = Math.max(0, Number(row.log || 0));
  lastCheckpoint.checkpointed = Math.max(0, Number(row.checkpointed || 0));
  lastCheckpoint.rowCount = Array.isArray(rows) ? rows.length : (row && typeof row === 'object' ? 1 : 0);
  lastCheckpoint.lastError = error ? normalizeMetricText(error.message || error, 500) : '';
}

function recordSqliteError(error) {
  // Domain validation can reject a transaction without the database failing.
  // Unknown errors (including malformed persisted JSON) remain diagnostic failures.
  const code = String(error?.code || '');
  if (!code && typeof error?.errorCode === 'string' && error.status >= 400 && error.status < 500) return;
  metrics.lastError = error?.message || String(error);
  metrics.lastErrorAt = new Date().toISOString();
}

export function timeSqliteQuery(name, fn) {
  const start = performance.now();
  try {
    return fn();
  } catch (error) {
    recordSqliteError(error);
    throw error;
  } finally {
    recordTiming(metrics.queries, name, performance.now() - start, sqliteSlowQueryMs());
  }
}

export function timeSqliteWrite(name, fn) {
  const start = performance.now();
  try {
    return fn();
  } catch (error) {
    recordSqliteError(error);
    throw error;
  } finally {
    recordTiming(metrics.writes, name, performance.now() - start, sqliteSlowWriteMs());
  }
}

export function recordSqliteCompatibilityCall(name) {
  const key = String(name || 'unknown');
  metrics.compatibility[key] = (metrics.compatibility[key] || 0) + 1;
}

function publicTimingBucket(bucket) {
  const byName = {};
  for (const [name, value] of Object.entries(bucket.byName)) {
    byName[name] = {
      total: value.total,
      slow: value.slow,
      avgMs: value.total ? Number((value.totalMs / value.total).toFixed(3)) : 0,
      maxMs: Number(value.maxMs.toFixed(3)),
      lastMs: Number(value.lastMs.toFixed(3))
    };
  }
  return {
    total: bucket.total,
    slow: bucket.slow,
    lastSlowAt: bucket.lastSlowAt,
    avgMs: bucket.total ? Number((bucket.totalMs / bucket.total).toFixed(3)) : 0,
    maxMs: Number(bucket.maxMs.toFixed(3)),
    last: bucket.last,
    byName
  };
}

async function fileSize(file) {
  try {
    const stat = await fs.stat(file);
    return stat.size;
  } catch {
    return 0;
  }
}

export async function sqliteRuntimeStats() {
  const file = sqliteFilePath();
  return {
    mode: storageMode(),
    enabled: sqliteEnabled(),
    primary: sqlitePrimaryMode(),
    file,
    opened: dbByFile.has(path.resolve(file)),
    openedAt: metrics.openedAt,
    ok: sqliteEnabled() ? await sqliteHealthCheck().then((item) => item.ok).catch(() => false) : true,
    sizeBytes: await fileSize(file),
    walSizeBytes: await fileSize(`${file}-wal`),
    shmSizeBytes: await fileSize(`${file}-shm`),
    prepares: {
      total: metrics.prepares.total,
      byName: { ...metrics.prepares.byName }
    },
    queries: publicTimingBucket(metrics.queries),
    writes: publicTimingBucket(metrics.writes),
    compatibility: { ...metrics.compatibility },
    checkpoint: { ...lastCheckpoint },
    lastError: metrics.lastError,
    lastErrorAt: metrics.lastErrorAt
  };
}

export async function sqliteHealthCheck() {
  if (!sqliteEnabled()) {
    return { ok: true, mode: storageMode(), enabled: false };
  }
  const db = await openSqliteDatabase();
  const result = timeSqliteQuery('health_check', () => (
    cachedRuntimeStatement(db, 'healthCheck', 'SELECT 1 AS ok').get()
  ));
  return { ok: result?.ok === 1, mode: storageMode(), enabled: true };
}

export async function checkpointSqlite(mode = 'PASSIVE') {
  const normalizedMode = String(mode || 'PASSIVE').toUpperCase();
  const allowedMode = ['PASSIVE', 'FULL', 'RESTART', 'TRUNCATE'].includes(normalizedMode) ? normalizedMode : 'PASSIVE';
  const db = await openSqliteDatabase();
  try {
    const rows = timeSqliteWrite(`wal_checkpoint_${allowedMode.toLowerCase()}`, () => (
      cachedRuntimeStatement(
        db,
        `walCheckpoint${allowedMode}`,
        `PRAGMA wal_checkpoint(${allowedMode})`
      ).all()
    ));
    recordSqliteCheckpoint(allowedMode, rows);
    return rows;
  } catch (error) {
    recordSqliteCheckpoint(allowedMode, [], error);
    throw error;
  }
}
