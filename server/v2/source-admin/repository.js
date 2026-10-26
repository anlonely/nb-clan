import { randomBytes } from 'node:crypto';
import { readSqliteScalar, upsertSqliteScalar } from '../../storage/sqlite-migrate.js';
import { need } from './model.js';
export function installSourceAdminSchema(db, { apply = false } = {}) {
  const present = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='v2_source_admin_meta'").get();
  if (!apply) return { required: !present, schemaVersion: 1, credentialsCopied: false };
  db.exec('BEGIN IMMEDIATE');
  try {
    db.exec(`CREATE TABLE IF NOT EXISTS v2_source_admin_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS v2_source_admin_operations (id TEXT PRIMARY KEY, actor_id TEXT NOT NULL, action TEXT NOT NULL,
        signature TEXT NOT NULL, result_json TEXT NOT NULL, created_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS v2_source_admin_audits (operation_id TEXT PRIMARY KEY, actor_id TEXT NOT NULL, action TEXT NOT NULL, created_at TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS v2_source_admin_operation_actor ON v2_source_admin_operations(actor_id, created_at, id);`);
    db.prepare('INSERT OR IGNORE INTO v2_source_admin_meta VALUES (?,?)').run('schema', '1');
    db.prepare('INSERT OR IGNORE INTO v2_source_admin_meta VALUES (?,?)').run('signatureKey', randomBytes(32).toString('hex'));
    db.exec('COMMIT');
  } catch (e) { db.exec('ROLLBACK'); throw e; }
  return { required: false, schemaVersion: 1, credentialsCopied: false };
}
export class SourceAdminRepository {
  constructor(db) {
    this.db = db;
    need(!installSourceAdminSchema(db).required, 'SOURCE_ADMIN_MIGRATION_REQUIRED', 503);
    need(db.prepare("SELECT value FROM v2_source_admin_meta WHERE key='schema'").get()?.value === '1', 'SOURCE_ADMIN_MIGRATION_REQUIRED', 503);
    this.signatureKey = db.prepare("SELECT value FROM v2_source_admin_meta WHERE key='signatureKey'").get()?.value;
    need(typeof this.signatureKey === 'string' && /^[0-9a-f]{64}$/.test(this.signatureKey), 'SOURCE_ADMIN_MIGRATION_REQUIRED', 503);
  }
  settings() { return readSqliteScalar(this.db, 'settings') || {}; }
  saveSettings(settings) { upsertSqliteScalar(this.db, 'settings', settings); }
  operation(id) {
    const r = this.db.prepare('SELECT * FROM v2_source_admin_operations WHERE id=?').get(id);
    return r && { id: r.id, actorId: r.actor_id, action: r.action, signature: r.signature, result: JSON.parse(r.result_json) };
  }
  saveOperation(o) {
    const stamp = new Date().toISOString();
    this.db.prepare('INSERT INTO v2_source_admin_operations VALUES (?,?,?,?,?,?)').run(o.id, o.actorId, o.action, o.signature, JSON.stringify(o.result), stamp);
    this.db.prepare('INSERT INTO v2_source_admin_audits VALUES (?,?,?,?)').run(o.id, o.actorId, o.action, stamp);
  }
  transaction(fn) {
    this.db.exec('BEGIN IMMEDIATE');
    try { const result = fn(); need(!result?.then, 'ASYNC_TRANSACTION_FORBIDDEN', 503); this.db.exec('COMMIT'); return result; }
    catch (e) { this.db.exec('ROLLBACK'); throw e; }
  }
}
