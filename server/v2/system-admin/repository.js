import { randomBytes } from 'node:crypto';
import { readSqliteScalar, upsertSqliteScalar } from '../../storage/sqlite-migrate.js';
import { need, nowIso } from './model.js';

// Explicit install only. No constructor/GET schema changes and no legacy settings rewrites.
export function migrateSystemAdmin(db, { apply = false } = {}) {
  const present = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='v2_system_meta'").get();
  if (!apply) return { required: !present, schemaVersion: 1, actions: present ? [] : ['create system metadata, operations, audit and artifact tables'], legacySettingsCopied: false };
  db.exec(`BEGIN IMMEDIATE;
    CREATE TABLE IF NOT EXISTS v2_system_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS v2_system_operations (id TEXT PRIMARY KEY, actor_id TEXT NOT NULL, action TEXT NOT NULL, target TEXT NOT NULL,
      signature TEXT NOT NULL, state TEXT NOT NULL, result_json TEXT, recovery_json TEXT, created_at TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS v2_system_operation_actor ON v2_system_operations(actor_id, created_at, id);
    CREATE TABLE IF NOT EXISTS v2_system_audits (id TEXT PRIMARY KEY, created_at TEXT NOT NULL, actor_id TEXT NOT NULL, action TEXT NOT NULL,
      target TEXT NOT NULL, operation_id TEXT NOT NULL, result TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS v2_system_audit_cursor ON v2_system_audits(created_at, id);
    CREATE TABLE IF NOT EXISTS v2_system_artifacts (id TEXT PRIMARY KEY, kind TEXT NOT NULL, state TEXT NOT NULL, revision INTEGER NOT NULL,
      metadata_json TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS v2_system_uploads (id TEXT PRIMARY KEY, actor_id TEXT NOT NULL, revision INTEGER NOT NULL,
      brand_revision INTEGER NOT NULL, mime_type TEXT NOT NULL, total_bytes INTEGER NOT NULL, expires_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS v2_system_upload_parts (upload_id TEXT NOT NULL, part INTEGER NOT NULL, bytes BLOB NOT NULL,
      PRIMARY KEY(upload_id,part));
    COMMIT;`);
  db.prepare('INSERT OR IGNORE INTO v2_system_meta VALUES (?,?)').run('schema', '1');
  db.prepare('INSERT OR IGNORE INTO v2_system_meta VALUES (?,?)').run('signatureKey', randomBytes(32).toString('hex'));
  return { required: false, schemaVersion: 1, legacySettingsCopied: false };
}
export class SystemRepository {
  constructor(db) {
    this.db = db;
    need(db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='v2_system_meta'").get(), 'SYSTEM_MIGRATION_REQUIRED', 503);
    need(this.meta('schema') === 1, 'SYSTEM_MIGRATION_REQUIRED', 503);
  }
  meta(key, fallback = 0) { const row = this.db.prepare('SELECT value FROM v2_system_meta WHERE key=?').get(key); return row ? (key === 'signatureKey' ? row.value : JSON.parse(row.value)) : fallback; }
  setMeta(key, value) { this.db.prepare('INSERT INTO v2_system_meta VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(key, JSON.stringify(value)); }
  settings() { return readSqliteScalar(this.db, 'settings') || {}; }
  saveSettings(settings) { upsertSqliteScalar(this.db, 'settings', settings); }
  bump(key) { const v = this.meta(key) + 1; this.setMeta(key, v); return v; }
  transaction(fn) {
    this.db.exec('BEGIN IMMEDIATE');
    try { const result = fn(); need(!result?.then, 'ASYNC_TRANSACTION_FORBIDDEN', 503); this.db.exec('COMMIT'); return result; }
    catch (e) { this.db.exec('ROLLBACK'); throw e; }
  }
  operation(id) {
    const r = this.db.prepare('SELECT * FROM v2_system_operations WHERE id=?').get(id);
    return r && { id: r.id, actorId: r.actor_id, action: r.action, target: r.target, signature: r.signature, state: r.state,
      result: r.result_json && JSON.parse(r.result_json), recovery: r.recovery_json && JSON.parse(r.recovery_json), createdAt: r.created_at };
  }
  saveOperation(o) {
    this.db.prepare(`INSERT INTO v2_system_operations VALUES (?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET state=excluded.state,
      result_json=excluded.result_json,recovery_json=excluded.recovery_json`).run(o.id, o.actorId, o.action, o.target, o.signature, o.state,
      o.result ? JSON.stringify(o.result) : null, o.recovery ? JSON.stringify(o.recovery) : null, o.createdAt || nowIso());
  }
  audit(o, result = 'succeeded') {
    this.db.prepare('INSERT OR IGNORE INTO v2_system_audits VALUES (?,?,?,?,?,?,?)').run(o.id, nowIso(), o.actorId, o.action, o.target, o.id, result);
  }
  artifact(id) { const r = this.db.prepare('SELECT metadata_json FROM v2_system_artifacts WHERE id=?').get(id); return r && JSON.parse(r.metadata_json); }
  putArtifact(r) { this.db.prepare(`INSERT INTO v2_system_artifacts VALUES (?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET state=excluded.state,
    revision=excluded.revision,metadata_json=excluded.metadata_json`).run(r.id, r.kind, r.state, r.revision, JSON.stringify(r)); }
  artifacts(before = '') { return this.db.prepare('SELECT metadata_json FROM v2_system_artifacts WHERE (? = \'\' OR id < ?) ORDER BY id DESC LIMIT 101').all(before, before).map(r => JSON.parse(r.metadata_json)); }
}
