import { randomBytes } from 'node:crypto';
import { readSqliteScalar, upsertSqliteScalar } from '../../storage/sqlite-migrate.js';
import { need, signature } from './model.js';
export function installRelayAdminSchema(db, { apply = false } = {}) {
  const present = db.prepare("SELECT count(*) n FROM sqlite_master WHERE type='table' AND name IN ('v2_relay_admin_meta','v2_relay_admin_operations','v2_relay_admin_audits')").get().n === 3;
  if (!apply) return { required: !present, schemaVersion: 1, credentialsCopied: false };
  db.exec('BEGIN IMMEDIATE');
  try {
    db.exec(`CREATE TABLE IF NOT EXISTS v2_relay_admin_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS v2_relay_admin_operations (id TEXT PRIMARY KEY, actor_id TEXT NOT NULL, permission_version INTEGER NOT NULL,
        action TEXT NOT NULL, signature TEXT NOT NULL, result_json TEXT NOT NULL, created_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS v2_relay_admin_audits (operation_id TEXT PRIMARY KEY, actor_id TEXT NOT NULL,
        permission_version INTEGER NOT NULL, action TEXT NOT NULL, created_at TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS v2_relay_admin_actor ON v2_relay_admin_operations(actor_id, created_at, id);`);
    const put = db.prepare('INSERT OR IGNORE INTO v2_relay_admin_meta VALUES (?,?)');
    put.run('schema', '1'); put.run('signatureKey', randomBytes(32).toString('hex')); put.run('revisionCounter', '0');
    db.exec('COMMIT');
  } catch (error) { db.exec('ROLLBACK'); throw error; }
  return { required: false, schemaVersion: 1, credentialsCopied: false };
}
export class RelayAdminRepository {
  constructor(db) {
    this.db = db; need(!installRelayAdminSchema(db).required, 'RELAY_ADMIN_MIGRATION_REQUIRED', 503);
    this.signatureKey = this.meta('signatureKey');
    const counter = this.meta('revisionCounter');
    need(this.meta('schema') === '1' && /^[a-f0-9]{64}$/.test(this.signatureKey) && Number.isSafeInteger(Number(counter)) && Number(counter) >= 0 && String(Number(counter)) === counter, 'RELAY_ADMIN_MIGRATION_REQUIRED', 503);
  }
  meta(key) { return this.db.prepare('SELECT value FROM v2_relay_admin_meta WHERE key=?').get(key)?.value; }
  settings() { const raw = readSqliteScalar(this.db, 'settings') || {}; need(raw && !Array.isArray(raw) && typeof raw === 'object', 'RELAY_ADMIN_INVALID_SETTINGS', 503); return raw; }
  saveSettings(settings) { upsertSqliteScalar(this.db, 'settings', settings); }
  revision(settings) { const c = settings.rustplusRelay || {}; return signature(this.signatureKey, { counter: this.meta('revisionCounter'), tokenHash: c.tokenHash ?? '', tokenUpdatedAt: c.tokenUpdatedAt ?? '' }); }
  advanceRevision() { const n = Number(this.meta('revisionCounter')); need(Number.isSafeInteger(n) && n >= 0 && n < Number.MAX_SAFE_INTEGER, 'RELAY_ADMIN_INVALID_SETTINGS', 503); this.db.prepare("UPDATE v2_relay_admin_meta SET value=? WHERE key='revisionCounter'").run(String(n + 1)); }
  operation(id) { const r = this.db.prepare('SELECT * FROM v2_relay_admin_operations WHERE id=?').get(id); return r && { id: r.id, actorId: r.actor_id, permissionVersion: r.permission_version, action: r.action, signature: r.signature, result: JSON.parse(r.result_json) }; }
  saveOperation(o, now) {
    this.db.prepare('INSERT INTO v2_relay_admin_operations VALUES (?,?,?,?,?,?,?)').run(o.id, o.actorId, o.permissionVersion, o.action, o.signature, JSON.stringify(o.result), now);
    this.db.prepare('INSERT INTO v2_relay_admin_audits VALUES (?,?,?,?,?)').run(o.id, o.actorId, o.permissionVersion, o.action, now);
  }
  transaction(fn) { this.db.exec('BEGIN IMMEDIATE'); try { const r = fn(); need(!r?.then, 'ASYNC_TRANSACTION_FORBIDDEN', 503); this.db.exec('COMMIT'); return r; } catch (error) { this.db.exec('ROLLBACK'); throw error; } }
}
