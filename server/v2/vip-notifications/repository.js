import { NotificationRepository, installNotificationVipSchema } from '../notifications/repository.js';
import { need, hash } from '../notifications/shared.js';

export function installVipNotificationsSchema(db) {
  installNotificationVipSchema(db);
  const core = new NotificationRepository(db);
  core.transaction(() => {
    db.exec(`CREATE TABLE IF NOT EXISTS v2_vip_notification_meta(id INTEGER PRIMARY KEY CHECK(id=1),version INTEGER NOT NULL);
      INSERT OR IGNORE INTO v2_vip_notification_meta VALUES(1,1);
      CREATE TABLE IF NOT EXISTS v2_vip_notification_scan(id INTEGER PRIMARY KEY CHECK(id=1),payload TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS v2_vip_notification_observations(member_id TEXT NOT NULL,source TEXT NOT NULL,payload TEXT NOT NULL,
        PRIMARY KEY(member_id,source));
      CREATE TABLE IF NOT EXISTS v2_vip_notification_legacy_fences(member_id TEXT NOT NULL,expires_at TEXT NOT NULL,payload TEXT NOT NULL,
        PRIMARY KEY(member_id,expires_at));
      CREATE TABLE IF NOT EXISTS v2_vip_notification_events(id TEXT PRIMARY KEY,member_id TEXT NOT NULL,source TEXT NOT NULL,
        expires_at TEXT NOT NULL,event_hash TEXT NOT NULL,payload TEXT NOT NULL,UNIQUE(member_id,source,expires_at));
      CREATE TRIGGER IF NOT EXISTS v2_vip_notification_events_immutable BEFORE UPDATE ON v2_vip_notification_events
        BEGIN SELECT RAISE(ABORT,'VIP notification event is immutable'); END;
      CREATE TRIGGER IF NOT EXISTS v2_vip_notification_events_preserved BEFORE DELETE ON v2_vip_notification_events
        BEGIN SELECT RAISE(ABORT,'VIP notification event cannot be deleted'); END;`);
    need(db.prepare('SELECT version FROM v2_vip_notification_meta WHERE id=1').get()?.version === 1, 'VIP_NOTIFICATION_SCHEMA_UNSUPPORTED', 503);
  });
}
export class VipNotificationRepository {
  constructor(core) {
    this.core = core; this.db = core.db; core.requireBusinessSchema('vipExpiry');
    for (const name of ['v2_vip_notification_meta', 'v2_vip_notification_scan', 'v2_vip_notification_observations', 'v2_vip_notification_legacy_fences', 'v2_vip_notification_events'])
      need(this.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name), 'VIP_NOTIFICATION_MIGRATION_REQUIRED', 503);
    need(this.db.prepare('SELECT version FROM v2_vip_notification_meta WHERE id=1').get()?.version === 1, 'VIP_NOTIFICATION_MIGRATION_REQUIRED', 503);
    for (const name of ['v2_vip_notification_events_immutable', 'v2_vip_notification_events_preserved'])
      need(this.db.prepare("SELECT 1 FROM sqlite_master WHERE type='trigger' AND name=?").get(name), 'VIP_NOTIFICATION_MIGRATION_REQUIRED', 503);
  }
  get(collection, id) {
    const r = this.db.prepare('SELECT payload_json FROM json_records WHERE collection=? AND id=?').get(collection, id);
    return r ? JSON.parse(r.payload_json) : null;
  }
  scan() { const r = this.db.prepare('SELECT payload FROM v2_vip_notification_scan WHERE id=1').get(); return r ? JSON.parse(r.payload) : null; }
  saveScan(value) { this.db.prepare('INSERT INTO v2_vip_notification_scan VALUES(1,?) ON CONFLICT(id) DO UPDATE SET payload=excluded.payload').run(JSON.stringify(value)); }
  highWater() { return this.db.prepare("SELECT MAX(id) id FROM json_records WHERE collection='members'").get().id || ''; }
  members(after, highWater, limit) {
    return this.db.prepare("SELECT payload_json FROM json_records WHERE collection='members' AND id>? AND id<=? ORDER BY id LIMIT ?")
      .all(after, highWater, limit).map(r => JSON.parse(r.payload_json));
  }
  observe(memberId, source, value) {
    this.db.prepare('INSERT INTO v2_vip_notification_observations VALUES(?,?,?) ON CONFLICT(member_id,source) DO UPDATE SET payload=excluded.payload')
      .run(memberId, source, JSON.stringify(value));
  }
  legacyFence(memberId, vip, persist = false) {
    if (vip.source !== 'vital' || !vip.expiresAt) return false;
    if (this.db.prepare('SELECT 1 FROM v2_vip_notification_legacy_fences WHERE member_id=? AND expires_at=?').get(memberId, vip.expiresAt)) return true;
    const run = this.db.prepare(`SELECT id FROM json_records WHERE collection='operationRuns'
      AND json_extract(payload_json,'$.dedupeKey')=? LIMIT 1`).get(`discord:vital-vip-reminder:${memberId}:${vip.expiresAt}`);
    if (!run && !vip.legacySent) return false;
    if (persist) this.db.prepare('INSERT OR IGNORE INTO v2_vip_notification_legacy_fences VALUES(?,?,?)')
      .run(memberId, vip.expiresAt, JSON.stringify({ reason: vip.legacySent ? 'legacy_sent_marker' : 'legacy_attempt_observed', operationId: run?.id || null }));
    return true;
  }
  event(id) {
    const r = this.db.prepare('SELECT event_hash,payload FROM v2_vip_notification_events WHERE id=?').get(id);
    if (!r) return null;
    const payload = JSON.parse(r.payload); need(hash(payload) === r.event_hash, 'VIP_NOTIFICATION_EVENT_CORRUPT', 503);
    return { ...payload, hash: r.event_hash };
  }
  putEvent(value) {
    const digest = hash(value);
    this.db.prepare('INSERT INTO v2_vip_notification_events VALUES(?,?,?,?,?,?)')
      .run(value.id, value.memberId, value.source, value.vip.expiresAt, digest, JSON.stringify(value));
    return { ...value, hash: digest };
  }
  unit(fn) {
    need(this.db.isTransaction, 'VIP_SCAN_TRANSACTION_REQUIRED', 503);
    this.db.exec('SAVEPOINT vip_notification_unit');
    try { const result = fn(); this.db.exec('RELEASE SAVEPOINT vip_notification_unit'); return result; }
    catch (error) { this.db.exec('ROLLBACK TO SAVEPOINT vip_notification_unit'); this.db.exec('RELEASE SAVEPOINT vip_notification_unit'); throw error; }
  }
}
