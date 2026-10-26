import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { ensureSqliteSchema, upsertSqliteCollectionRecord, upsertSqliteScalar, readSqliteScalar } from '../server/storage/sqlite-migrate.js';
import { planProductionMigration, applyProductionMigration, validateProductionReady, acquireProductionLease } from '../server/v2/production/migrations.js';
const code = expected => e => e.errorCode === expected;
async function fixture() {
  const base = await fs.realpath(os.tmpdir()), dir = await fs.mkdtemp(path.join(base, 'nb-v2-production-test-')); await fs.chmod(dir, 0o700);
  const c = { dataDirectory: dir, databaseFile: path.join(dir, 'nb-clan.sqlite') }, db = new DatabaseSync(c.databaseFile);
  ensureSqliteSchema(db); upsertSqliteScalar(db, 'settings', {});
  // Explicit installation ownership is local fixture state, never an implicit Steam ID.
  upsertSqliteScalar(db, 'v2InstallationOwner', { version: 1, accountId: 'user_root' });
  const root = { id: 'user_root', username: 'root', role: 'admin', passwordHash: 'preserve-existing-hash', status: 'active' };
  upsertSqliteCollectionRecord(db, 'users', root.id, root); db.close(); await fs.chmod(c.databaseFile, 0o600);
  return { c, root, async close() { await fs.rm(dir, { recursive: true, force: true }); } };
}
async function receipt(c) { return { kind: 'isolated-copy', sourcePath: '/never-opened/authorized-source.sqlite', databaseSha256: createHash('sha256').update(await fs.readFile(c.databaseFile)).digest('hex'), observedAt: new Date().toISOString() }; }
test('production complete migration is explicit, exclusive, replay-safe and preserves legacy credentials/new writes', async () => {
  const f = await fixture(); let lease;
  try {
    const setup = new DatabaseSync(f.c.databaseFile);
    for (let i = 0; i < 1001; i++) upsertSqliteCollectionRecord(setup, 'operationRuns', 'run_' + i, { id: 'run_' + i, type: 'old', status: 'succeeded' }); setup.close();
    const before = await fs.readFile(f.c.databaseFile), plan = await planProductionMigration(f.c);
    assert.equal(plan.syncPlan.runs.length, 1001); assert.deepEqual(await fs.readFile(f.c.databaseFile), before);
    await assert.rejects(validateProductionReady(f.c), code('PRODUCTION_MIGRATION_REQUIRED'));
    await assert.rejects(acquireProductionLease(f.c, { mode: 'maintenance' }), code('PRODUCTION_STOP_RECEIPT_REQUIRED'));
    lease = await acquireProductionLease(f.c, { mode: 'maintenance', stopReceipt: await receipt(f.c) });
    await assert.rejects(acquireProductionLease(f.c), code('PRODUCTION_IN_USE'));
    await assert.rejects(applyProductionMigration(f.c, plan, { expectedDigest: plan.digest, operatorId: 'admin', maintenanceLease: lease }), code('PRODUCTION_TRUSTED_OPERATOR_REQUIRED'));
    await assert.rejects(applyProductionMigration(f.c, { ...plan, plannedAt: '2030-01-01T00:00:00.000Z' }, { expectedDigest: plan.digest, operatorId: 'user_root', maintenanceLease: lease }), code('PRODUCTION_PLAN_INVALID'));
    const result = await applyProductionMigration(f.c, plan, { expectedDigest: plan.digest, operatorId: 'user_root', maintenanceLease: lease });
    assert.equal(result.schemaInstalled, true); assert.equal(result.performanceIndexesInstalled, true); assert.equal(result.replayed, false);
    const repeated = await applyProductionMigration(f.c, plan, { expectedDigest: plan.digest, operatorId: 'user_root', maintenanceLease: lease }); assert.equal(repeated.replayed, true);
    await lease.release(); lease = null;
    const ready = await validateProductionReady(f.c); assert.equal(ready.planDigest, plan.digest);
    const db = new DatabaseSync(f.c.databaseFile);
    assert.deepEqual(JSON.parse(db.prepare("SELECT payload_json FROM json_records WHERE collection='users' AND id='user_root'").get().payload_json), f.root);
    assert.equal(readSqliteScalar(db, 'v2CandidateMigration'), null);
    upsertSqliteScalar(db, 'newProductionWrite', { retained: true }); db.close();
    // New writes do not invalidate runtime readiness, but prevent old migration replay.
    await validateProductionReady(f.c);
    const { IdentityRepository } = await import('../server/v2/identity/repository.js');
    const { IdentityService } = await import('../server/v2/identity/service.js');
    const changed = new DatabaseSync(f.c.databaseFile), identity = new IdentityService(new IdentityRepository(changed));
    const actor = identity.actorForAccount('user_root'), account = identity.repo.get('accounts', 'user_root');
    const explicitGrants = account.grants.filter(g => g.capability !== 'notifications.mention_everyone');
    assert.equal(actor.roleId, 'owner');
    assert.throws(() => identity.changeAccount(actor, 'user_root', { expectedRevision: account.revision, grants: explicitGrants }), /PROTECTED_ACCOUNT/); changed.close();
    await validateProductionReady(f.c);
    const preserved = new DatabaseSync(f.c.databaseFile, { readOnly: true });
    assert.deepEqual(new IdentityRepository(preserved).get('accounts', 'user_root').grants, account.grants); preserved.close();
    lease = await acquireProductionLease(f.c, { mode: 'maintenance', stopReceipt: await receipt(f.c) });
    await assert.rejects(applyProductionMigration(f.c, plan, { expectedDigest: plan.digest, operatorId: 'user_root', maintenanceLease: lease }), code('PRODUCTION_PLAN_STALE'));
  } finally { await lease?.release(); await f.close(); }
});
test('production private paths, altered plans and actual permission conflicts fail closed without a ready marker', async () => {
  const f = await fixture(); let lease;
  try {
    await fs.chmod(f.c.databaseFile, 0o644); await assert.rejects(planProductionMigration(f.c), code('PRODUCTION_PRIVATE_PATH_REQUIRED')); await fs.chmod(f.c.databaseFile, 0o600);
    const db = new DatabaseSync(f.c.databaseFile); upsertSqliteCollectionRecord(db, 'users', 'bad-role', { id: 'bad-role', username: 'secondary', role: 'unrecognized' }); db.close();
    const plan = await planProductionMigration(f.c); assert.ok(plan.review.identityConflicts > 0);
    lease = await acquireProductionLease(f.c, { mode: 'maintenance', stopReceipt: await receipt(f.c) });
    await assert.rejects(applyProductionMigration(f.c, plan, { expectedDigest: plan.digest, operatorId: 'user_root', maintenanceLease: lease }), code('PRODUCTION_MIGRATION_REVIEW_REQUIRED'));
    const check = new DatabaseSync(f.c.databaseFile, { readOnly: true }); assert.equal(readSqliteScalar(check, 'v2ProductionMigration'), null); assert.equal(readSqliteScalar(check, 'v2IdentityMigration'), null); check.close();
  } finally { await lease?.release(); await f.close(); }
});
test('known reviews stay open, notification writes are denied, unmapped relay requires explicit preserve policy', async () => {
  const f = await fixture(); let lease;
  try {
    const db = new DatabaseSync(f.c.databaseFile);
    upsertSqliteCollectionRecord(db, 'users', 'admin_secondary', { id: 'admin_secondary', username: 'secondary', role: 'admin' });
    upsertSqliteCollectionRecord(db, 'wechatUsers', 'wx_unlinked', { id: 'wx_unlinked', openid: 'synthetic-unlinked' });
    const history = { servers: [{ key: 'source:server', clientId: 'source', serverId: 'server', snapshot: { capturedAt: '2026-09-20T00:00:00.000Z' } }], chatMessages: [], inviteRecords: [] };
    upsertSqliteScalar(db, 'rustplusRelay', history); db.close();
    const strict = await planProductionMigration(f.c);
    assert.equal(strict.review.identityConflicts, 2); assert.equal(strict.review.identityBlockingConflicts, 0); assert.equal(strict.review.identityDeferredReviews, 2);
    assert.ok(strict.adminExtrasCatalog.length > 0);
    lease = await acquireProductionLease(f.c, { mode: 'maintenance', stopReceipt: await receipt(f.c) });
    await assert.rejects(applyProductionMigration(f.c, strict, { expectedDigest: strict.digest, operatorId: 'user_root', maintenanceLease: lease }), code('PRODUCTION_RELAY_MAPPING_REQUIRED'));
    await lease.release(); lease = null;
    const plan = await planProductionMigration(f.c, { relayHistoryPolicy: 'preserve_unmapped' });
    lease = await acquireProductionLease(f.c, { mode: 'maintenance', stopReceipt: await receipt(f.c) });
    const result = await applyProductionMigration(f.c, plan, { expectedDigest: plan.digest, operatorId: 'user_root', maintenanceLease: lease });
    assert.equal(result.identityConflicts, 2); assert.equal(result.deferredReview.length, 2); assert.equal(result.relayHistory.imported, false); assert.equal(result.relayHistory.deferred, true);
    await lease.release(); lease = null;
    await validateProductionReady(f.c);
    const check = new DatabaseSync(f.c.databaseFile, { readOnly: true });
    const account = JSON.parse(check.prepare("SELECT payload_json FROM json_records WHERE collection='v2Accounts' AND id='admin_secondary'").get().payload_json);
    assert.ok(account.grants.some(g => g.capability === 'notifications.preview'));
    for (const cap of ['send', 'reconcile', 'mention_role', 'mention_everyone']) assert.equal(account.grants.some(g => g.capability === 'notifications.' + cap), false);
    assert.equal(check.prepare("SELECT count(*) n FROM json_records WHERE collection='v2IdentityConflicts' AND json_extract(payload_json,'$.status')='open'").get().n, 2);
    assert.equal(check.prepare("SELECT count(*) n FROM json_records WHERE collection='wechatUsers'").get().n, 1);
    assert.equal(check.prepare("SELECT count(*) n FROM json_records WHERE collection='v2Identities' AND json_extract(payload_json,'$.provider') LIKE 'wechat:%'").get().n, 0);
    assert.deepEqual(readSqliteScalar(check, 'rustplusRelay'), history); assert.equal(check.prepare('SELECT count(*) n FROM v2_realtime_scopes').get().n, 0); check.close();
  } finally { await lease?.release(); await f.close(); }
});
test('only original-plan-proven previous admin notification formula can be narrowed automatically', async () => {
  const { planIdentityMigration, applyIdentityMigration } = await import('../server/v2/identity/migration.js');
  const { installIdentitySchema, IdentityRepository } = await import('../server/v2/identity/repository.js');
  const { planGrantMigration, applyGrantMigration } = await import('../server/v2/identity/grant-migration.js');
  const { CAPABILITIES, grant } = await import('../server/v2/identity/permissions.js');
  const f = await fixture();
  try {
    const db = new DatabaseSync(f.c.databaseFile), user = { id: 'admin_secondary', username: 'secondary', role: 'admin' };
    upsertSqliteCollectionRecord(db, 'users', user.id, user);
    const original = planIdentityMigration({ users: [f.root, user], members: [], permissionRoles: [] }), admin = original.accounts.find(a => a.id === user.id);
    const previous = [...admin.grants.filter(g => g.source === 'legacy_admin'), ...['send', 'reconcile', 'mention_role', 'mention_everyone'].map(cap => grant('notifications.' + cap, { type: 'all' }, { source: 'legacy_admin' }))].sort((a, b) => CAPABILITIES.indexOf(a.capability) - CAPABILITIES.indexOf(b.capability));
    admin.grants = [...previous, ...admin.grants.filter(g => g.source !== 'legacy_admin')];
    installIdentitySchema(db); const repo = new IdentityRepository(db); applyIdentityMigration(repo, original);
    const missing = planGrantMigration(repo); assert.equal(missing.counts.needs_review, 1);
    const plan = planGrantMigration(repo, { identityPlan: original }); assert.equal(plan.counts.update, 1); assert.equal(plan.accounts.find(a => a.accountId === user.id).sourceVersion, 'g07-unreviewed-notification-targets');
    applyGrantMigration(repo, plan, { identityPlan: original, expectedDigest: plan.digest, operatorId: 'user_root' });
    assert.equal(repo.get('accounts', user.id).grants.some(g => g.capability === 'notifications.send'), false);
    assert.equal(repo.get('accounts', 'user_root').grants.some(g => g.capability === 'notifications.send'), true);
    db.close();
  } finally { await f.close(); }
});
test('identity_only removes history and embedded caches, preserving passwords, blocked identities, links, settings and uploads', async () => {
  const f = await fixture(); let lease;
  try {
    const db = new DatabaseSync(f.c.databaseFile);
    const member = { id: 'm1', steamId: '76561198000000001', discordId: 'discord-1', kookId: 'kook-1', kookBoundAt: '2026-01-01T00:00:00Z', wechatUserId: 'wx1', customName: 'synthetic', blacklisted: true, memberStatus: 'blocked', vitalVipType: 'cached', battlemetricsId: 'old-cache', notAttendingHistory: [{ old: true }], discordMembershipLastOkAt: 'old' };
    upsertSqliteCollectionRecord(db, 'members', 'm1', member);
    upsertSqliteCollectionRecord(db, 'wechatUsers', 'wx1', { id: 'wx1', openid: 'wx-openid', memberId: 'm1', status: 'active', lastLoginAt: 'old', subscriptionPreferences: { old: true } });
    upsertSqliteCollectionRecord(db, 'uploads', 'upload1', { id: 'upload1', path: 'keep-user-profile.png' });
    upsertSqliteCollectionRecord(db, 'logs', 'l1', { id: 'l1', old: true });
    upsertSqliteCollectionRecord(db, 'sessions', 's1', { id: 's1', tokenHash: 'expire-old-session' });
    upsertSqliteCollectionRecord(db, 'wipes', 'w1', { id: 'w1', status: 'closed' });
    upsertSqliteScalar(db, 'rustplusRelay', { chatMessages: [{ id: 'old-chat' }] });
    upsertSqliteScalar(db, 'settings', { secretExample: 'keep-operation-credential' });
    db.exec('CREATE TABLE members(id TEXT PRIMARY KEY,steam_id TEXT,display_name TEXT,discord_id TEXT,wechat_user_id TEXT,squad_id TEXT,created_at TEXT,updated_at TEXT,payload_json TEXT NOT NULL,payload_hash TEXT NOT NULL); CREATE TABLE audit_logs(id TEXT, payload_json TEXT); INSERT INTO audit_logs VALUES(\'old\',\'{}\');');
    db.prepare('INSERT INTO members(id,payload_json,payload_hash) VALUES(?,?,?)').run('stale-deleted-member', '{"id":"stale-deleted-member"}', 'old'); db.close();
    const before = await fs.readFile(f.c.databaseFile), plan = await planProductionMigration(f.c, { retentionMode: 'identity_only' });
    assert.deepEqual(await fs.readFile(f.c.databaseFile), before); assert.equal(plan.syncPlan.runs.length, 0); assert.equal(plan.schedulingPlan.wipes.length, 0); assert.equal(plan.relayPlan.unmapped.length, 0);
    assert.equal(plan.retention.keepCollections.find(r => r.collection === 'members').removedFields.vitalVipType, 1);
    lease = await acquireProductionLease(f.c, { mode: 'maintenance', stopReceipt: await receipt(f.c) });
    const result = await applyProductionMigration(f.c, plan, { expectedDigest: plan.digest, operatorId: 'user_root', maintenanceLease: lease });
    assert.equal(result.retention.purgedJsonRecords, 3); assert.equal(result.retention.originalBindingsUnchanged, true);
    await lease.release(); lease = null; await validateProductionReady(f.c);
    const check = new DatabaseSync(f.c.databaseFile, { readOnly: true });
    const kept = JSON.parse(check.prepare("SELECT payload_json FROM json_records WHERE collection='members' AND id='m1'").get().payload_json);
    for (const key of ['steamId','discordId','wechatUserId','kookId','kookBoundAt','blacklisted','memberStatus']) assert.deepEqual(kept[key], member[key]);
    for (const key of ['vitalVipType','battlemetricsId','notAttendingHistory','discordMembershipLastOkAt']) assert.equal(kept[key], undefined);
    assert.equal(check.prepare('SELECT count(*) n FROM members').get().n, 1); assert.equal(check.prepare('SELECT id FROM members').get().id, 'm1');
    assert.equal(check.prepare('SELECT count(*) n FROM audit_logs').get().n, 0);
    assert.equal(check.prepare("SELECT count(*) n FROM json_records WHERE collection IN ('logs','sessions','wipes')").get().n, 0);
    assert.equal(check.prepare("SELECT count(*) n FROM json_records WHERE collection='uploads'").get().n, 1);
    assert.deepEqual(readSqliteScalar(check, 'v2InstallationOwner'), { version: 1, accountId: 'user_root' });
    assert.deepEqual(readSqliteScalar(check, 'settings'), { secretExample: 'keep-operation-credential' }); assert.equal(readSqliteScalar(check, 'rustplusRelay'), null); check.close();
  } finally { await lease?.release(); await f.close(); }
});
