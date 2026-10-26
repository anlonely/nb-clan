import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { DatabaseSync, backup } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { noSymlinks, need } from '../../server/v2/candidate-host/config.js';
import { productionConfig, acquireProductionLease, validateProductionReady } from '../../server/v2/production/migrations.js';
import { NotificationRepository, installNotificationOpenWipeSchema } from '../../server/v2/notifications/repository.js';

async function readStopReceipt(file) {
  need(typeof file === 'string' && path.isAbsolute(file), 'PRIVATE_STOP_RECEIPT_REQUIRED', 422);
  await noSymlinks(file);
  const stat = await fs.lstat(file);
  need(stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1 && stat.uid === process.getuid()
    && (stat.mode & 0o077) === 0 && stat.size > 0 && stat.size < 8192, 'PRIVATE_STOP_RECEIPT_REQUIRED', 422);
  return JSON.parse(await fs.readFile(file, 'utf8'));
}

/** Explicit additive upgrade for an already migrated production database.
 * The stopped-owner receipt and exclusive maintenance lease come before writes.
 * This command does not save guild configuration or start an application owner.
 */
export async function enableOpenWipeSchema(input, receiptFile) {
  const config = productionConfig(input), stopReceipt = await readStopReceipt(receiptFile);
  const lease = await acquireProductionLease(config, { mode: 'maintenance', stopReceipt });
  let db;
  try {
    await validateProductionReady(config);
    db = new DatabaseSync(config.databaseFile);
    db.exec('PRAGMA busy_timeout=1000; PRAGMA locking_mode=EXCLUSIVE; BEGIN EXCLUSIVE; COMMIT;');
    const repo = new NotificationRepository(db), previousVersion = repo.scalar('v2NotificationOpenWipeSchemaVersion');
    const previousMarker = repo.scalar('v2NotificationOpenWipeMigration');
    const replayed = previousVersion === 1 && previousMarker?.schemaVersion === 1 && previousMarker.resourceKind === 'discordOpenWipe';
    need(replayed || previousVersion === null && previousMarker === null, 'OPEN_WIPE_SCHEMA_STATE_INVALID', 409);
    repo.requireBusinessSchema();

    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const backupFile = path.join(config.dataDirectory, '.v2-production', `before-open-wipe-${stamp}-${randomUUID()}.sqlite`);
    const reserved = await fs.open(backupFile, 'wx', 0o600); await reserved.close();
    await backup(db, backupFile); await fs.chmod(backupFile, 0o600);
    const snapshot = new DatabaseSync(backupFile, { readOnly: true });
    try {
      need(snapshot.prepare('PRAGMA integrity_check').get().integrity_check === 'ok', 'OPEN_WIPE_BACKUP_INVALID', 503);
    } finally { snapshot.close(); }
    const backupStat = await fs.lstat(backupFile);
    need(backupStat.isFile() && backupStat.nlink === 1 && backupStat.uid === process.getuid()
      && (backupStat.mode & 0o077) === 0 && backupStat.size > 0, 'OPEN_WIPE_BACKUP_INVALID', 503);

    if (!replayed) installNotificationOpenWipeSchema(db);
    repo.requireBusinessSchema('discordOpenWipe');
    db.close(); db = null;
    await validateProductionReady(config);
    return { installed: true, replayed, schemaVersion: 1, resourceKind: 'discordOpenWipe', backupFile, backupBytes: backupStat.size };
  } finally {
    // A failed close must retain the maintenance fence instead of admitting a
    // second application owner while this connection might still hold SQLite.
    db?.close();
    await lease.release();
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try { console.log(JSON.stringify(await enableOpenWipeSchema(JSON.parse(process.argv[2]), process.argv[3]))); }
  catch (error) {
    console.error(JSON.stringify({ errorCode: /^[A-Z][A-Z0-9_]+$/.test(error.errorCode || '') ? error.errorCode : 'OPEN_WIPE_SCHEMA_UPGRADE_FAILED' }));
    process.exitCode = 1;
  }
}
