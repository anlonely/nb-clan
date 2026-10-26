import { createHash, randomBytes } from 'node:crypto';
import { IdentityError } from '../identity/errors.js';
import { readSqliteCollectionRecord, upsertSqliteCollectionRecord, runSqliteTransaction } from '../../storage/sqlite-migrate.js';

export const need = (value, code, status = 422) => { if (!value) throw new IdentityError(code, status); };
export const canonical = value => Array.isArray(value) ? value.map(canonical) : value && typeof value === 'object' ?
  Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;
export const hash = value => createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');

export function installMemberInboxSchema(db) {
  need(db.prepare("SELECT name FROM sqlite_master WHERE name='json_records'").get(), 'IDENTITY_MIGRATION_REQUIRED', 503);
  return runSqliteTransaction(db, 'member_inbox_schema', () => {
    db.exec(`CREATE TABLE IF NOT EXISTS v2_member_inbox_meta (id INTEGER PRIMARY KEY CHECK(id=1), version INTEGER NOT NULL, cursor_secret TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS v2_member_inbox_receipts (
        account_id TEXT NOT NULL, app_id TEXT NOT NULL, operation_id TEXT NOT NULL,
        subject_hash TEXT NOT NULL, fingerprint TEXT NOT NULL, payload TEXT NOT NULL,
        PRIMARY KEY(account_id,app_id,operation_id));
      CREATE TABLE IF NOT EXISTS v2_member_inbox_audit (
        id INTEGER PRIMARY KEY, account_id TEXT NOT NULL, app_id TEXT NOT NULL,
        subject_hash TEXT NOT NULL, operation_id TEXT NOT NULL, action TEXT NOT NULL,
        resource_id TEXT NOT NULL, revision INTEGER NOT NULL, created_at TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS v2_member_inbox_owner_order ON json_records
        (json_extract(payload_json,'$.wechatUserId'),COALESCE(julianday(json_extract(payload_json,'$.createdAt')),0),id)
        WHERE collection='wechatNotifications';
      CREATE INDEX IF NOT EXISTS v2_member_inbox_wechat_subject ON json_records
        (json_extract(payload_json,'$.appId'),json_extract(payload_json,'$.openid')) WHERE collection='wechatUsers';`);
    db.prepare('INSERT OR IGNORE INTO v2_member_inbox_meta VALUES(1,1,?)').run(randomBytes(32).toString('hex'));
    need(db.prepare('SELECT version FROM v2_member_inbox_meta WHERE id=1').get()?.version === 1, 'INBOX_SCHEMA_VERSION_UNSUPPORTED', 503);
    return { schemaVersion: 1 };
  });
}

export class MemberInboxRepository {
  constructor(db) {
    this.db = db;
    need(db.prepare("SELECT name FROM sqlite_master WHERE name='v2_member_inbox_meta'").get(), 'INBOX_MIGRATION_REQUIRED', 503);
    const meta = db.prepare('SELECT * FROM v2_member_inbox_meta WHERE id=1').get();
    need(meta?.version === 1, 'INBOX_MIGRATION_REQUIRED', 503);
    this.secret = meta.cursor_secret;
  }
  get(collection, id) { return readSqliteCollectionRecord(this.db, collection, id); }
  put(collection, record) { upsertSqliteCollectionRecord(this.db, collection, record.id, record); return record; }
  transaction(fn) { return runSqliteTransaction(this.db, 'member_inbox', () => {
    const value = fn(); need(!value?.then, 'INBOX_SYNC_TRANSACTION_REQUIRED', 503); return value;
  }); }
}
