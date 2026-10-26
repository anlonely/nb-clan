import { readSqliteCollectionRecord, upsertSqliteCollectionRecord } from '../../storage/sqlite-migrate.js';
import { need } from './model.js';

/** Called explicitly by the host migration, never by a factory/GET. Blob and canonical references share one DB transaction. */
export function installPlatformMediaSchema(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS v2_platform_media (
    owner_key TEXT PRIMARY KEY, app_id TEXT NOT NULL, user_id TEXT NOT NULL,
    revision INTEGER NOT NULL, sha256 TEXT NOT NULL, content_type TEXT NOT NULL,
    width INTEGER NOT NULL, height INTEGER NOT NULL, bytes BLOB NOT NULL CHECK(length(bytes)<=1048576));
    CREATE TABLE IF NOT EXISTS v2_platform_media_receipts (
    id TEXT PRIMARY KEY, account_id TEXT NOT NULL, app_id TEXT NOT NULL, command_hash TEXT NOT NULL, payload TEXT NOT NULL);`);
}
export class PlatformMediaRepository {
  constructor(db) { this.db = db; }
  requireSchema() {
    need(this.db.prepare("SELECT count(*) n FROM sqlite_master WHERE type='table' AND name IN ('v2_platform_media','v2_platform_media_receipts')").get().n === 2, 'MEDIA_MIGRATION_REQUIRED', 503);
  }
  get(collection, id) { return readSqliteCollectionRecord(this.db, collection, id); }
  put(collection, value) { upsertSqliteCollectionRecord(this.db, collection, value.id, value); }
  blob(key) { this.requireSchema(); return this.db.prepare('SELECT * FROM v2_platform_media WHERE owner_key=?').get(key); }
  receipt(id) { this.requireSchema(); const row = this.db.prepare('SELECT * FROM v2_platform_media_receipts WHERE id=?').get(id); return row ? { ...row, value: JSON.parse(row.payload) } : null; }
  writeBlob(key, appId, userId, revision, image) {
    this.db.prepare(`INSERT INTO v2_platform_media VALUES(?,?,?,?,?,?,?,?,?) ON CONFLICT(owner_key) DO UPDATE SET
      revision=excluded.revision,sha256=excluded.sha256,content_type=excluded.content_type,width=excluded.width,height=excluded.height,bytes=excluded.bytes`)
      .run(key, appId, userId, revision, image.sha256, image.contentType, image.width, image.height, image.bytes);
  }
  writeReceipt(id, accountId, appId, commandHash, value) {
    this.db.prepare('INSERT INTO v2_platform_media_receipts VALUES(?,?,?,?,?)').run(id, accountId, appId, commandHash, JSON.stringify(value));
  }
}
