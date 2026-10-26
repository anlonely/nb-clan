import { NotificationRepository, installNotificationHexSchema } from '../notifications/repository.js';
import { need, hash } from '../notifications/shared.js';
export function installHexQuerySchema(db) {
  installNotificationHexSchema(db);
  new NotificationRepository(db).transaction(() => {
    db.exec(`CREATE TABLE IF NOT EXISTS v2_hex_query_schema(version INTEGER PRIMARY KEY);
      INSERT OR IGNORE INTO v2_hex_query_schema VALUES(1);
      CREATE TABLE IF NOT EXISTS v2_hex_query_events(id TEXT PRIMARY KEY,event_hash TEXT NOT NULL,payload TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS v2_hex_query_state(id TEXT PRIMARY KEY,payload TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS v2_hex_query_subject ON v2_hex_query_events
        (json_extract(payload,'$.steamId'),json_extract(payload,'$.guildId'),json_extract(payload,'$.channelId'));
      CREATE TRIGGER IF NOT EXISTS v2_hex_query_events_immutable BEFORE UPDATE ON v2_hex_query_events
        BEGIN SELECT RAISE(ABORT,'Hex query event is immutable'); END;
      CREATE TRIGGER IF NOT EXISTS v2_hex_query_events_preserved BEFORE DELETE ON v2_hex_query_events
        BEGIN SELECT RAISE(ABORT,'Hex query event cannot be deleted'); END;
      CREATE TRIGGER IF NOT EXISTS v2_hex_query_observation_immutable BEFORE UPDATE ON v2_hex_query_state
        WHEN json_extract(OLD.payload,'$.status')='observed' AND NEW.payload<>OLD.payload
        BEGIN SELECT RAISE(ABORT,'Hex query observation is immutable'); END;
      CREATE TRIGGER IF NOT EXISTS v2_hex_query_state_preserved BEFORE DELETE ON v2_hex_query_state
        BEGIN SELECT RAISE(ABORT,'Hex query state cannot be deleted'); END;`);
  });
}
export class HexQueryRepository {
  constructor(core) {
    this.core = core; this.db = core.db; core.requireBusinessSchema('hexQuery');
    for (const name of ['v2_hex_query_schema', 'v2_hex_query_events', 'v2_hex_query_state'])
      need(this.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name), 'HEX_QUERY_MIGRATION_REQUIRED', 503);
    need(this.db.prepare('SELECT version FROM v2_hex_query_schema').all().length === 1 &&
      this.db.prepare('SELECT version FROM v2_hex_query_schema').get().version === 1, 'HEX_QUERY_SCHEMA_UNSUPPORTED', 503);
    for (const name of ['v2_hex_query_events_immutable', 'v2_hex_query_events_preserved', 'v2_hex_query_observation_immutable', 'v2_hex_query_state_preserved'])
      need(this.db.prepare("SELECT 1 FROM sqlite_master WHERE type='trigger' AND name=?").get(name), 'HEX_QUERY_MIGRATION_REQUIRED', 503);
  }
  event(id) {
    const row = this.db.prepare('SELECT event_hash,payload FROM v2_hex_query_events WHERE id=?').get(id);
    if (!row) return null;
    const event = JSON.parse(row.payload); need(hash(event) === row.event_hash, 'HEX_QUERY_EVENT_CORRUPT', 503);
    return { ...event, hash: row.event_hash };
  }
  addEvent(event) {
    this.db.prepare('INSERT INTO v2_hex_query_events VALUES(?,?,?)').run(event.id, hash(event), JSON.stringify(event));
    return this.event(event.id);
  }
  state(id) { const row = this.db.prepare('SELECT payload FROM v2_hex_query_state WHERE id=?').get(id); return row ? JSON.parse(row.payload) : null; }
  save(state) {
    need(this.db.isTransaction, 'HEX_QUERY_TRANSACTION_REQUIRED', 503);
    this.db.prepare('INSERT INTO v2_hex_query_state VALUES(?,?) ON CONFLICT(id) DO UPDATE SET payload=excluded.payload').run(state.id, JSON.stringify(state));
    return state;
  }
  get(collection, id) { const row = this.db.prepare('SELECT payload_json FROM json_records WHERE collection=? AND id=?').get(collection, id); return row ? JSON.parse(row.payload_json) : null; }
  hasUnresolved(steamId, ownId) {
    // A new scheduled job is a new rootJobId. It must not bypass an unresolved
    // older command merely by obtaining another SyncCenter operation ID.
    return Boolean(this.db.prepare(`SELECT e.id FROM v2_hex_query_events e
      JOIN v2_hex_query_state s ON s.id=e.id
      LEFT JOIN json_records d ON d.collection='v2NotificationDeliveries' AND d.id=json_extract(s.payload,'$.deliveryId')
      WHERE e.id<>? AND json_extract(e.payload,'$.steamId')=?
        AND NOT (COALESCE(json_extract(d.payload_json,'$.knownNotSent'),0)=1 AND json_extract(d.payload_json,'$.status') IN ('failed','cancelled'))
        AND NOT (json_extract(s.payload,'$.status')='observed' AND EXISTS (
          SELECT 1 FROM sync_center_records j,json_each(j.payload,'$.items') i
          WHERE j.kind='job' AND j.id=json_extract(e.payload,'$.jobId')
            AND json_extract(i.value,'$.memberId')=json_extract(e.payload,'$.memberId') AND json_extract(i.value,'$.status')='succeeded'))
      LIMIT 1`).get(ownId, steamId));
  }
}
