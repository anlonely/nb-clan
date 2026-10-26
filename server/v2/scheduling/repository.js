import { ensureSqliteSchema, readSqliteCollectionRecord, upsertSqliteCollectionRecord,
  readSqliteScalar, upsertSqliteScalar, runSqliteTransaction } from '../../storage/sqlite-migrate.js';
import { IdentityError } from '../identity/errors.js';
export const collections = Object.freeze({ wipes: 'v2Wipes', signups: 'v2Signups', contents: 'v2WipeContents',
  archives: 'v2WipeArchives', events: 'v2SchedulingEvents', outbox: 'v2SchedulingOutbox', receipts: 'v2SchedulingReceipts',
  signupContexts: 'v2SignupContexts', quarantine: 'v2SchedulingQuarantine' });
export function installSchedulingSchema(db) {
  ensureSqliteSchema(db);
  db.exec(`
    CREATE TABLE IF NOT EXISTS v2_scheduling_clock (id INTEGER PRIMARY KEY CHECK(id=1), revision INTEGER NOT NULL);
    INSERT OR IGNORE INTO v2_scheduling_clock(id,revision) VALUES(1,1);
    CREATE UNIQUE INDEX IF NOT EXISTS v2_signup_pair ON json_records
      (json_extract(payload_json,'$.wipeId'),json_extract(payload_json,'$.memberId')) WHERE collection='v2Signups';
    CREATE UNIQUE INDEX IF NOT EXISTS v2_content_version ON json_records
      (json_extract(payload_json,'$.wipeId'),json_extract(payload_json,'$.contentRevision')) WHERE collection='v2WipeContents';
    CREATE UNIQUE INDEX IF NOT EXISTS v2_archive_version ON json_records
      (json_extract(payload_json,'$.wipeId'),json_extract(payload_json,'$.archiveRevision')) WHERE collection='v2WipeArchives';
    CREATE UNIQUE INDEX IF NOT EXISTS v2_operation_key ON json_records
      (json_extract(payload_json,'$.actorAccountId'),json_extract(payload_json,'$.operationId')) WHERE collection='v2SchedulingReceipts';
    CREATE INDEX IF NOT EXISTS v2_signup_wipe ON json_records(json_extract(payload_json,'$.wipeId')) WHERE collection='v2Signups';
    CREATE TRIGGER IF NOT EXISTS v2_roster_member_insert AFTER INSERT ON json_records
      WHEN NEW.collection IN ('members','squadMembers','v2SteamBindings','v2Accounts','v2AccessRestrictions','v2Signups','v2Eligibility','v2EligibilityPolicies','v2Identities')
      BEGIN UPDATE v2_scheduling_clock SET revision=revision+1 WHERE id=1; END;
    CREATE TRIGGER IF NOT EXISTS v2_roster_member_update AFTER UPDATE ON json_records
      WHEN NEW.collection IN ('members','squadMembers','v2SteamBindings','v2Accounts','v2AccessRestrictions','v2Signups','v2Eligibility','v2EligibilityPolicies','v2Identities') AND NEW.payload_json != OLD.payload_json
      BEGIN UPDATE v2_scheduling_clock SET revision=revision+1 WHERE id=1; END;
    CREATE TRIGGER IF NOT EXISTS v2_roster_member_delete AFTER DELETE ON json_records
      WHEN OLD.collection IN ('members','squadMembers','v2SteamBindings','v2Accounts','v2AccessRestrictions','v2Signups','v2Eligibility','v2EligibilityPolicies','v2Identities')
      BEGIN UPDATE v2_scheduling_clock SET revision=revision+1 WHERE id=1; END;
    CREATE TRIGGER IF NOT EXISTS v2_immutable_snapshots BEFORE UPDATE ON json_records
      WHEN OLD.collection IN ('v2WipeContents','v2WipeArchives','v2SchedulingEvents') AND NEW.payload_json != OLD.payload_json
      BEGIN SELECT RAISE(ABORT,'Immutable scheduling record'); END;
    CREATE TRIGGER IF NOT EXISTS v2_preserve_history BEFORE DELETE ON json_records
      WHEN OLD.collection IN ('v2Signups','v2WipeContents','v2WipeArchives','v2SchedulingEvents','v2SchedulingReceipts')
      BEGIN SELECT RAISE(ABORT,'Scheduling history cannot be deleted'); END;
  `);
  upsertSqliteScalar(db, 'v2SchedulingSchemaVersion', 1);

}
export class SchedulingRepository {
  constructor(db) {
    this.db = db;
    if (readSqliteScalar(db, 'v2SchedulingSchemaVersion') !== 1) throw new IdentityError('SCHEDULING_MIGRATION_REQUIRED', 503);
  }
  collection(name) { if (!collections[name]) throw new TypeError('Unknown scheduling collection'); return collections[name]; }
  all(name) { return this.db.prepare('SELECT payload_json FROM json_records WHERE collection=? ORDER BY id').all(this.collection(name)).map(r => JSON.parse(r.payload_json)); }
  get(name, id) { return readSqliteCollectionRecord(this.db, this.collection(name), id); }
  put(name, row) { upsertSqliteCollectionRecord(this.db, this.collection(name), row.id, row); return row; }
  forWipe(name, wipeId) {
    if (name === 'signups') return this.db.prepare("SELECT payload_json FROM json_records INDEXED BY v2_signup_wipe WHERE collection='v2Signups' AND json_extract(payload_json,'$.wipeId')=? ORDER BY id")
      .all(wipeId).map(r => JSON.parse(r.payload_json));
    return this.db.prepare("SELECT payload_json FROM json_records WHERE collection=? AND json_extract(payload_json,'$.wipeId')=? ORDER BY id")
      .all(this.collection(name), wipeId).map(r => JSON.parse(r.payload_json));
  }
  scalar(key) { return key === 'v2RosterRevision' ? this.db.prepare('SELECT revision FROM v2_scheduling_clock WHERE id=1').get().revision : readSqliteScalar(this.db, key); }
  setScalar(key, value) { upsertSqliteScalar(this.db, key, value); }
  transaction(fn) {
    return runSqliteTransaction(this.db, 'v2_scheduling', () => {
      const result = fn(this); if (result?.then) throw new TypeError('Scheduling transaction must be synchronous'); return result;
    });
  }
}
