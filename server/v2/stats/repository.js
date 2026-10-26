import { randomBytes, createHmac, timingSafeEqual } from 'node:crypto';
import { need, hash, normalizeMetricValues } from './model.js';
export function installStatsSchema(db) {
  db.exec(`
CREATE TABLE IF NOT EXISTS v2_stats_meta(key TEXT PRIMARY KEY,value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS v2_stats_archives(wipe_id TEXT NOT NULL,revision INTEGER NOT NULL,source_hash TEXT NOT NULL,payload TEXT NOT NULL,PRIMARY KEY(wipe_id,revision));
CREATE TABLE IF NOT EXISTS v2_stats_archive_rows(wipe_id TEXT NOT NULL,revision INTEGER NOT NULL,id TEXT NOT NULL,member_id TEXT NOT NULL,source_id TEXT NOT NULL,payload_json TEXT NOT NULL,PRIMARY KEY(wipe_id,revision,id));
CREATE INDEX IF NOT EXISTS v2_stats_archive_member ON v2_stats_archive_rows(wipe_id,revision,member_id);
CREATE TRIGGER IF NOT EXISTS v2_stats_archive_no_update BEFORE UPDATE ON v2_stats_archives BEGIN SELECT RAISE(ABORT,'STATS_IMMUTABLE'); END;
CREATE TRIGGER IF NOT EXISTS v2_stats_archive_no_delete BEFORE DELETE ON v2_stats_archives BEGIN SELECT RAISE(ABORT,'STATS_IMMUTABLE'); END;
CREATE TRIGGER IF NOT EXISTS v2_stats_archive_rows_no_update BEFORE UPDATE ON v2_stats_archive_rows BEGIN SELECT RAISE(ABORT,'STATS_IMMUTABLE'); END;
CREATE TRIGGER IF NOT EXISTS v2_stats_archive_rows_no_delete BEFORE DELETE ON v2_stats_archive_rows BEGIN SELECT RAISE(ABORT,'STATS_IMMUTABLE'); END;
CREATE TABLE IF NOT EXISTS v2_stats_visibility(wipe_id TEXT PRIMARY KEY,revision INTEGER NOT NULL,hidden INTEGER NOT NULL,reason TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS v2_stats_operations(account_id TEXT NOT NULL,operation_id TEXT NOT NULL,action TEXT NOT NULL,command_hash TEXT NOT NULL,result TEXT NOT NULL,PRIMARY KEY(account_id,operation_id));
CREATE TABLE IF NOT EXISTS v2_stats_jobs(id TEXT PRIMARY KEY,account_id TEXT NOT NULL,permission_version INTEGER NOT NULL,scope_digest TEXT NOT NULL,kind TEXT NOT NULL,status TEXT NOT NULL,epoch INTEGER NOT NULL,expires_at INTEGER NOT NULL,payload TEXT NOT NULL,result TEXT);
CREATE TABLE IF NOT EXISTS v2_stats_audit(id INTEGER PRIMARY KEY,account_id TEXT NOT NULL,operation_id TEXT NOT NULL,action TEXT NOT NULL,wipe_id TEXT,reason TEXT,created_at TEXT NOT NULL);
`);
  db.prepare('INSERT OR IGNORE INTO v2_stats_meta VALUES(?,?)').run('schema', '1');
  db.prepare('INSERT OR IGNORE INTO v2_stats_meta VALUES(?,?)').run('cursorSecret', randomBytes(32).toString('hex'));
}
export class StatsRepository {
  constructor(db) {
    this.db = db;
    need(db.prepare("SELECT name FROM sqlite_master WHERE name='v2_stats_meta'").get(), 'STATS_MIGRATION_REQUIRED', 503);
    // A connection-local pure function keeps SQL ranking identical to the DTO,
    // including numeric strings, invalid values, capabilities and rounded KD.
    // It installs no persistent schema and reads/writes no external state.
    db.function('nb_stats_metric', { deterministic: true }, (payload, metric) =>
      normalizeMetricValues(JSON.parse(payload)).values[metric] ?? null);
  }
  transaction(fn) {
    this.db.exec('SAVEPOINT v2_stats');
    try {
      const result = fn();
      need(!result?.then, 'ASYNC_TRANSACTION_FORBIDDEN', 503);
      this.db.exec('RELEASE v2_stats');
      return result;
    } catch (e) {
      this.db.exec('ROLLBACK TO v2_stats');
      this.db.exec('RELEASE v2_stats');
      throw e;
    }
  }
  get(collection, id) {
    const r = this.db.prepare('SELECT payload_json FROM json_records WHERE collection=? AND id=?').get(collection, id);
    return r ? JSON.parse(r.payload_json) : null;
  }
  archive(wipeId, revision) {
    const r = this.db.prepare('SELECT payload FROM v2_stats_archives WHERE wipe_id=? AND revision=?').get(wipeId, revision);
    return r ? JSON.parse(r.payload) : null;
  }
  latest(wipeId) {
    return this.db.prepare('SELECT MAX(revision) n FROM v2_stats_archives WHERE wipe_id=?').get(wipeId).n || 0;
  }
  saveArchive(snapshot, rows) {
    this.db.prepare('INSERT INTO v2_stats_archives VALUES(?,?,?,?)').run(snapshot.wipeId, snapshot.revision, hash(snapshot), JSON.stringify(snapshot));
    for (const r of rows) this.db.prepare('INSERT INTO v2_stats_archive_rows VALUES(?,?,?,?,?,?)').run(snapshot.wipeId, snapshot.revision, r.id, r.memberId, r.sourceId, JSON.stringify(r));
  }
  encode(payload) {
    const p = Buffer.from(JSON.stringify(payload)).toString('base64url');
    const secret = this.db.prepare("SELECT value FROM v2_stats_meta WHERE key='cursorSecret'").get().value;
    return p + '.' + createHmac('sha256', secret).update(p).digest('base64url');
  }
  decode(token, context, now) {
    try {
      need(typeof token === 'string' && token.length <= 3000, 'CURSOR_EXPIRED', 410);
      const [p, s] = token.split('.'),
        expected = this.encode(JSON.parse(Buffer.from(p, 'base64url').toString())).split('.')[1];
      need(s?.length === expected.length && timingSafeEqual(Buffer.from(s), Buffer.from(expected)), 'CURSOR_EXPIRED', 410);
      const value = JSON.parse(Buffer.from(p, 'base64url'));
      need(value.context === hash(context) && value.expiresAt > now, 'CURSOR_EXPIRED', 410);
      return value;
    } catch {
      need(false, 'CURSOR_EXPIRED', 410);
    }
  }
  job(id) {
    const row = this.db.prepare('SELECT * FROM v2_stats_jobs WHERE id=?').get(id);
    return row ? {
      ...row,
      payload: JSON.parse(row.payload),
      result: row.result ? JSON.parse(row.result) : null
    } : null;
  }
}
