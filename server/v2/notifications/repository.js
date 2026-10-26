import { readSqliteCollectionRecord, upsertSqliteCollectionRecord, readSqliteScalar,
  upsertSqliteScalar, runSqliteTransaction } from '../../storage/sqlite-migrate.js';
import { IdentityError } from '../identity/errors.js';

export const collections = Object.freeze({
  previews: 'v2NotificationPreviews', intents: 'v2NotificationIntents', deliveries: 'v2NotificationDeliveries',
  attempts: 'v2NotificationAttempts', messageRefs: 'v2NotificationMessageRefs',
  messageOperations: 'v2NotificationMessageOperations', receipts: 'v2NotificationReceipts',
  actionReferences: 'v2NotificationActionReferences', consumedEvents: 'v2NotificationConsumedEvents',
  changes: 'v2NotificationChanges', discordSignups: 'v2DiscordWipeSignups', discordSignupReceipts: 'v2DiscordWipeSignupReceipts'
});

const prerequisiteObjects = {
  table: ['json_records', 'json_scalars', 'json_collections', 'v2_scheduling_clock'],
  index: ['v2_identity_provider_external', 'v2_account_member', 'v2_verified_steam', 'v2_verified_account',
    'v2_verified_member', 'v2_policy_provider', 'v2_session_account', 'v2_signup_pair', 'v2_content_version',
    'v2_archive_version', 'v2_operation_key', 'v2_signup_wipe'],
  trigger: ['v2_roster_member_insert', 'v2_roster_member_update', 'v2_roster_member_delete',
    'v2_immutable_snapshots', 'v2_preserve_history']
};
const notificationObjects = {
  table: ['v2_notification_clock'],
  index: ['v2_notification_business_key', 'v2_notification_delivery_target', 'v2_notification_operation_key',
    'v2_notification_reference_token', 'v2_notification_change_cursor', 'v2_notification_wipe'],
  trigger: ['v2_notification_changes_immutable', 'v2_notification_history_preserved']
};
const setupRequired = () => new IdentityError('NOTIFICATION_SETUP_REQUIRED', 503);

function verifyObjects(db, objects) {
  const find = db.prepare('SELECT 1 FROM sqlite_master WHERE type=? AND name=?');
  for (const [type, names] of Object.entries(objects)) for (const name of names) {
    if (!find.get(type, name)) throw setupRequired();
  }
}

function verifyPrerequisites(db) {
  verifyObjects(db, prerequisiteObjects);
  for (const prefix of ['v2Identity', 'v2Scheduling']) {
    if (readSqliteScalar(db, `${prefix}SchemaVersion`) !== 1 || !readSqliteScalar(db, `${prefix}Migration`)) {
      throw setupRequired();
    }
  }
  if (!db.prepare('SELECT revision FROM v2_scheduling_clock WHERE id=1').get()) throw setupRequired();
}

// The caller explicitly runs G03/G04 migration first; this never installs their schemas.
export function installNotificationSchema(db) {
  try { verifyPrerequisites(db); } catch { throw setupRequired(); }
  const version = readSqliteScalar(db, 'v2NotificationSchemaVersion');
  if (version !== null && version !== 1) throw setupRequired();
  const install = () => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS v2_notification_clock (
        id INTEGER PRIMARY KEY CHECK(id=1), cursor INTEGER NOT NULL CHECK(cursor>=0)
      );
      INSERT OR IGNORE INTO v2_notification_clock(id,cursor) VALUES(1,0);
      CREATE UNIQUE INDEX IF NOT EXISTS v2_notification_business_key ON json_records
        (json_extract(payload_json,'$.businessKey')) WHERE collection='v2NotificationIntents';
      CREATE UNIQUE INDEX IF NOT EXISTS v2_notification_delivery_target ON json_records
        (json_extract(payload_json,'$.intentId'),json_extract(payload_json,'$.targetId'),json_extract(payload_json,'$.language'))
        WHERE collection='v2NotificationDeliveries';
      CREATE UNIQUE INDEX IF NOT EXISTS v2_notification_operation_key ON json_records
        (json_extract(payload_json,'$.actorAccountId'),json_extract(payload_json,'$.operationId'))
        WHERE collection='v2NotificationReceipts';
      CREATE UNIQUE INDEX IF NOT EXISTS v2_notification_reference_token ON json_records
        (json_extract(payload_json,'$.tokenHash')) WHERE collection='v2NotificationActionReferences';
      CREATE UNIQUE INDEX IF NOT EXISTS v2_notification_change_cursor ON json_records
        (json_extract(payload_json,'$.cursor')) WHERE collection='v2NotificationChanges';
      CREATE INDEX IF NOT EXISTS v2_notification_wipe ON json_records
        (collection,json_extract(payload_json,'$.wipeId'))
        WHERE collection IN ('v2NotificationPreviews','v2NotificationIntents','v2NotificationDeliveries',
          'v2NotificationAttempts','v2NotificationMessageRefs','v2NotificationMessageOperations',
          'v2NotificationReceipts','v2NotificationActionReferences','v2NotificationConsumedEvents','v2NotificationChanges');
      CREATE TRIGGER IF NOT EXISTS v2_notification_changes_immutable BEFORE UPDATE ON json_records
        WHEN OLD.collection='v2NotificationChanges' AND NEW.payload_json != OLD.payload_json
        BEGIN SELECT RAISE(ABORT,'Notification changes are immutable'); END;
      CREATE TRIGGER IF NOT EXISTS v2_notification_history_preserved BEFORE DELETE ON json_records
        WHEN OLD.collection IN ('v2NotificationIntents','v2NotificationDeliveries','v2NotificationAttempts',
          'v2NotificationMessageRefs','v2NotificationMessageOperations','v2NotificationReceipts',
          'v2NotificationConsumedEvents','v2NotificationChanges')
        BEGIN SELECT RAISE(ABORT,'Notification history cannot be deleted'); END;
    `);
    upsertSqliteScalar(db, 'v2NotificationSchemaVersion', 1);
    if (!readSqliteScalar(db, 'v2NotificationMigration')) upsertSqliteScalar(db, 'v2NotificationMigration', {
      schemaVersion: 1, contractVersion: 'g06-parallel/1', installedAt: new Date().toISOString()
    });
  };
  if (db.isTransaction) install();
  else runSqliteTransaction(db, 'v2_notification_install', install);
}

// Optional additive schema, explicitly installed by the host after the original core.
// Existing G06 rows, marker and indexes are deliberately unchanged.
export function installNotificationBusinessSchema(db) {
  const repo = new NotificationRepository(db);
  const version = readSqliteScalar(db, 'v2NotificationBusinessSchemaVersion');
  if (version !== null && version !== 1) throw setupRequired();
  repo.transaction(() => {
    db.exec(`CREATE INDEX IF NOT EXISTS v2_notification_resource ON json_records
      (collection,json_extract(payload_json,'$.resource.kind'),json_extract(payload_json,'$.resource.id'))
      WHERE collection IN ('v2NotificationIntents','v2NotificationDeliveries','v2NotificationMessageRefs',
        'v2NotificationMessageOperations','v2NotificationAttempts','v2NotificationChanges','v2NotificationConsumedEvents');`);
    upsertSqliteScalar(db, 'v2NotificationBusinessSchemaVersion', 1);
    if (!readSqliteScalar(db, 'v2NotificationBusinessMigration')) upsertSqliteScalar(db, 'v2NotificationBusinessMigration',
      { schemaVersion: 1, resourceKinds: ['memberReview'], installedAt: new Date().toISOString() });
  });
}

// Explicit opt-in: neither the original factory nor the review installer enables VIP resources.
export function installNotificationVipSchema(db) {
  const repo = new NotificationRepository(db); repo.requireBusinessSchema();
  const version = readSqliteScalar(db, 'v2NotificationVipSchemaVersion');
  if (version !== null && version !== 1) throw setupRequired();
  repo.transaction(() => {
    upsertSqliteScalar(db, 'v2NotificationVipSchemaVersion', 1);
    if (!readSqliteScalar(db, 'v2NotificationVipMigration')) upsertSqliteScalar(db, 'v2NotificationVipMigration',
      { schemaVersion: 1, resourceKind: 'vipExpiry', installedAt: new Date().toISOString() });
  });
}

// Hex command delivery is an independent explicit opt-in, without changing old markers.
export function installNotificationHexSchema(db) {
  const repo = new NotificationRepository(db); repo.requireBusinessSchema();
  const version = readSqliteScalar(db, 'v2NotificationHexSchemaVersion');
  if (version !== null && version !== 1) throw setupRequired();
  repo.transaction(() => {
    upsertSqliteScalar(db, 'v2NotificationHexSchemaVersion', 1);
    if (!readSqliteScalar(db, 'v2NotificationHexMigration')) upsertSqliteScalar(db, 'v2NotificationHexMigration',
      { schemaVersion: 1, resourceKind: 'hexQuery', installedAt: new Date().toISOString() });
  });
}

export function installNotificationPlatformCardSchema(db) {
  const repo = new NotificationRepository(db); repo.requireBusinessSchema();
  const version = readSqliteScalar(db, 'v2NotificationPlatformCardSchemaVersion');
  if (version !== null && version !== 1) throw setupRequired();
  repo.transaction(() => {
    upsertSqliteScalar(db, 'v2NotificationPlatformCardSchemaVersion', 1);
    if (!readSqliteScalar(db, 'v2NotificationPlatformCardMigration')) upsertSqliteScalar(db, 'v2NotificationPlatformCardMigration',
      {schemaVersion:1, resourceKind:'platformCard', installedAt:new Date().toISOString()});
  });
}

// Independent opt-in for Discord-only open sign-ups; never a scheduling Wipe.
export function installNotificationOpenWipeSchema(db) {
  const repo = new NotificationRepository(db); repo.requireBusinessSchema();
  const version = readSqliteScalar(db, 'v2NotificationOpenWipeSchemaVersion');
  if (version !== null && version !== 1) throw setupRequired();
  repo.transaction(() => {
    upsertSqliteScalar(db, 'v2NotificationOpenWipeSchemaVersion', 1);
    if (!readSqliteScalar(db, 'v2NotificationOpenWipeMigration')) upsertSqliteScalar(db, 'v2NotificationOpenWipeMigration',
      { schemaVersion: 1, resourceKind: 'discordOpenWipe', installedAt: new Date().toISOString() });
  });
}

export class NotificationRepository {
  constructor(db) {
    this.db = db;
    try {
      verifyPrerequisites(db);
      verifyObjects(db, notificationObjects);
      if (readSqliteScalar(db, 'v2NotificationSchemaVersion') !== 1 || !readSqliteScalar(db, 'v2NotificationMigration')) {
        throw setupRequired();
      }
      const clock = db.prepare('SELECT cursor FROM v2_notification_clock WHERE id=1').get();
      if (!Number.isSafeInteger(clock?.cursor) || clock.cursor < 0) throw setupRequired();
    } catch { throw setupRequired(); }
  }

  collection(name) {
    if (!Object.hasOwn(collections, name)) throw new TypeError('Unknown notification collection');
    return collections[name];
  }
  all(name) {
    return this.db.prepare('SELECT payload_json FROM json_records WHERE collection=? ORDER BY id')
      .all(this.collection(name)).map(row => JSON.parse(row.payload_json));
  }
  pendingSchedulingEvents(limit = 100) {
    if (!Number.isSafeInteger(limit) || limit < 1) throw new TypeError('Invalid outbox batch limit');
    // History is retained. Filter in SQLite before decoding payloads, rather than
    // doing one JavaScript allocation and one consumed-event query per old event.
    return this.db.prepare(`SELECT event.payload_json FROM json_records AS event
      WHERE event.collection='v2SchedulingOutbox' AND NOT EXISTS (
        SELECT 1 FROM json_records AS consumed
        WHERE consumed.collection='v2NotificationConsumedEvents'
          AND consumed.id=COALESCE(NULLIF(json_extract(event.payload_json,'$.eventId'),''),event.id)
      ) ORDER BY json_extract(event.payload_json,'$.createdAt'),event.id LIMIT ?`)
      .all(Math.min(limit, 1_000)).map(row => JSON.parse(row.payload_json));
  }
  get(name, id) { return readSqliteCollectionRecord(this.db, this.collection(name), id); }
  put(name, row) {
    // Persist a real operation revision on every write, including worker changes.
    if(name==='messageOperations')row.revision=(this.get(name,row.id)?.revision||0)+1;
    upsertSqliteCollectionRecord(this.db, this.collection(name), row.id, row);
    return row;
  }
  forWipe(name, wipeId) {
    return this.db.prepare("SELECT payload_json FROM json_records WHERE collection=? AND json_extract(payload_json,'$.wipeId')=? AND json_type(payload_json,'$.resource') IS NULL ORDER BY id")
      .all(this.collection(name), wipeId).map(row => JSON.parse(row.payload_json));
  }
  requireBusinessSchema(kind = 'memberReview') {
    if (readSqliteScalar(this.db, 'v2NotificationBusinessSchemaVersion') !== 1 || !readSqliteScalar(this.db, 'v2NotificationBusinessMigration') ||
      !this.db.prepare("SELECT 1 FROM sqlite_master WHERE type='index' AND name='v2_notification_resource'").get())
      throw new IdentityError('NOTIFICATION_BUSINESS_MIGRATION_REQUIRED', 503);
    if (!['memberReview', 'vipExpiry', 'hexQuery', 'platformCard', 'discordOpenWipe'].includes(kind)) throw new IdentityError('NOTIFICATION_RESOURCE_INVALID', 503);
    if (kind === 'discordOpenWipe' && (readSqliteScalar(this.db, 'v2NotificationOpenWipeSchemaVersion') !== 1 ||
      readSqliteScalar(this.db, 'v2NotificationOpenWipeMigration')?.resourceKind !== 'discordOpenWipe'))
      throw new IdentityError('NOTIFICATION_OPEN_WIPE_MIGRATION_REQUIRED', 503);
    if (kind === 'vipExpiry' && (readSqliteScalar(this.db, 'v2NotificationVipSchemaVersion') !== 1 ||
      readSqliteScalar(this.db, 'v2NotificationVipMigration')?.resourceKind !== 'vipExpiry'))
      throw new IdentityError('NOTIFICATION_VIP_MIGRATION_REQUIRED', 503);
    if (kind === 'platformCard' && (readSqliteScalar(this.db, 'v2NotificationPlatformCardSchemaVersion') !== 1 ||
      readSqliteScalar(this.db, 'v2NotificationPlatformCardMigration')?.resourceKind !== 'platformCard'))
      throw new IdentityError('NOTIFICATION_PLATFORM_CARD_MIGRATION_REQUIRED', 503);
    if (kind === 'hexQuery' && (readSqliteScalar(this.db, 'v2NotificationHexSchemaVersion') !== 1 ||
      readSqliteScalar(this.db, 'v2NotificationHexMigration')?.resourceKind !== 'hexQuery'))
      throw new IdentityError('NOTIFICATION_HEX_MIGRATION_REQUIRED', 503);
  }
  forResource(name, resource) {
    this.requireBusinessSchema(resource?.kind);
    if (!['memberReview', 'vipExpiry', 'hexQuery', 'platformCard', 'discordOpenWipe'].includes(resource?.kind) || typeof resource.id !== 'string' || !resource.id)
      throw new IdentityError('NOTIFICATION_RESOURCE_INVALID', 503);
    return this.db.prepare("SELECT payload_json FROM json_records WHERE collection=? AND json_extract(payload_json,'$.resource.kind')=? AND json_extract(payload_json,'$.resource.id')=? AND json_type(payload_json,'$.wipeId')='null' ORDER BY id")
      .all(this.collection(name), resource.kind, resource.id).map(row => JSON.parse(row.payload_json));
  }
  scalar(key) { return readSqliteScalar(this.db, key); }
  setScalar(key, value) {
    if (typeof key !== 'string' || !key.startsWith('v2Notification')) throw new TypeError('Notification scalar namespace required');
    upsertSqliteScalar(this.db, key, value);
  }
  transaction(fn) {
    const run = () => {
      const result = fn(this);
      if (result?.then) throw new TypeError('Notification transaction must be synchronous; perform network I/O outside it.');
      return result;
    };
    return runSqliteTransaction(this.db, 'v2_notifications', run);
  }

  appendChange({ wipeId, resource, intentId = null, deliveryId = null, targetId = null, type, createdAt }) {
    if (resource !== undefined) {
      this.requireBusinessSchema(resource?.kind);
      if (!['memberReview', 'vipExpiry', 'hexQuery', 'platformCard', 'discordOpenWipe'].includes(resource?.kind) || typeof resource.id !== 'string' || !resource.id || wipeId !== null)
        throw new IdentityError('NOTIFICATION_RESOURCE_INVALID', 503);
    }
    if (resource === undefined && (typeof wipeId !== 'string' || !wipeId) || typeof type !== 'string' || !type ||
        typeof createdAt !== 'string' || !Number.isFinite(Date.parse(createdAt))) {
      throw new TypeError('Notification change requires wipeId, type and createdAt');
    }
    const append = () => {
      const clock = this.db.prepare('UPDATE v2_notification_clock SET cursor=cursor+1 WHERE id=1 AND cursor<? RETURNING cursor')
        .get(Number.MAX_SAFE_INTEGER);
      if (!clock) throw new RangeError('Notification cursor exhausted');
      return this.put('changes', { id: `change:${clock.cursor}`, cursor: clock.cursor,
        wipeId, ...(resource === undefined ? {} : { resource }), intentId, deliveryId, targetId, type, createdAt });
    };
    return this.db.isTransaction ? append() : this.transaction(append);
  }

  // Trusted runtime feed. Its owner must scope each hint before publishing to a browser.
  listChanges({ after = 0, limit = 100 } = {}) {
    const cursor = Number(after), size = Number(limit);
    if (!Number.isSafeInteger(cursor) || cursor < 0 || !Number.isSafeInteger(size) || size < 1) {
      throw new TypeError('Invalid notification change cursor or limit');
    }
    const items = this.db.prepare("SELECT payload_json FROM json_records WHERE collection='v2NotificationChanges' AND json_extract(payload_json,'$.cursor')>? ORDER BY json_extract(payload_json,'$.cursor') LIMIT ?")
      .all(cursor, Math.min(1000, size)).map(row => JSON.parse(row.payload_json));
    return { items, nextCursor: items.at(-1)?.cursor ?? cursor };
  }
}
