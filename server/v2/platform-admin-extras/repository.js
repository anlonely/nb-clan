import { readSqliteScalar, upsertSqliteScalar, runSqliteTransaction } from '../../storage/sqlite-migrate.js';
import { need, hash, catalogEntries, sync } from './model.js';
export const readSettings = db => readSqliteScalar(db, 'settings') || {};
export const vitalState = db => readSettings(db).vitalServers || { overrides: [] };
// Explicit boot migration only; constructors and GET requests never install schema.
export function installPlatformAdminExtrasSchema(db, { catalog }) {
  const baseHash = hash(catalogEntries(catalog));
  runSqliteTransaction(db, 'admin_extras_install', () => {
    db.exec(`CREATE TABLE IF NOT EXISTS v2_platform_admin_extras_meta (id INTEGER PRIMARY KEY CHECK(id=1), revision INTEGER NOT NULL, source_hash TEXT NOT NULL, base_hash TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS v2_platform_admin_extras_operations (actor_id TEXT NOT NULL, operation_id TEXT NOT NULL, fingerprint TEXT NOT NULL, revision INTEGER NOT NULL UNIQUE,
        receipt TEXT NOT NULL, cache_done INTEGER NOT NULL DEFAULT 0, event_done INTEGER NOT NULL DEFAULT 0, PRIMARY KEY(actor_id,operation_id));
      CREATE TABLE IF NOT EXISTS v2_platform_admin_extras_audits (revision INTEGER PRIMARY KEY, actor_id TEXT NOT NULL, operation_id TEXT NOT NULL, server_profile_id TEXT NOT NULL, vital_server_id TEXT NOT NULL,
        changed_fields TEXT NOT NULL, before_hash TEXT NOT NULL, after_hash TEXT NOT NULL, created_at TEXT NOT NULL);`);
    db.prepare('INSERT OR IGNORE INTO v2_platform_admin_extras_meta VALUES(1,0,?,?)').run(hash(vitalState(db)), baseHash);
  });
}
export class ExtrasRepository {
  constructor(db) {
    this.db = db;
    need(db.prepare("SELECT name FROM sqlite_master WHERE name='v2_platform_admin_extras_meta'").get(), 'ADMIN_EXTRAS_MIGRATION_REQUIRED', 503);
    need(this.meta(), 'ADMIN_EXTRAS_MIGRATION_REQUIRED', 503);
  }
  meta() { return this.db.prepare('SELECT revision, source_hash sourceHash, base_hash baseHash FROM v2_platform_admin_extras_meta WHERE id=1').get(); }
  transaction(fn) { return runSqliteTransaction(this.db, 'admin_extras_write', () => sync(fn())); }
  operation(actorId, id) { return this.db.prepare('SELECT * FROM v2_platform_admin_extras_operations WHERE actor_id=? AND operation_id=?').get(actorId, id); }
  settings() { return readSettings(this.db); }
  saveSettings(value) { upsertSqliteScalar(this.db, 'settings', value); }
  pending() { return this.db.prepare('SELECT * FROM v2_platform_admin_extras_operations WHERE cache_done=0 OR event_done=0 ORDER BY revision LIMIT 100').all(); }
}
