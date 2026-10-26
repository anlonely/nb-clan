import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fixture, fullFalse, legacyGates } from './support/v2-grant-migration/fixture.mjs';
import { CAPABILITIES, QUERY_SOURCES, grant, can, validGrant, migrateLegacyGrants } from '../server/v2/identity/permissions.js';
import { planGrantMigration, applyGrantMigration, GRANT_MIGRATION_MARKER } from '../server/v2/identity/grant-migration.js';
import { applyIdentityMigration } from '../server/v2/identity/migration.js';
import { digest } from '../server/v2/identity/contexts.js';
import { installPlatformAdminSchema, PlatformAdminRepository } from '../server/v2/platform-admin/repository.js';
import { installStatsSchema } from '../server/v2/stats/repository.js';
import { StatsService } from '../server/v2/stats/service.js';
import { createExportRenderer } from '../server/v2/stats/exports.js';
import { upsertSqliteCollectionRecord } from '../server/storage/sqlite-migrate.js';
const plan = f => planGrantMigration(f.repo, { identityPlan: f.originalPlan });
const apply = (f, p = plan(f)) => applyGrantMigration(f.repo, p, { identityPlan: f.originalPlan, expectedDigest: p.digest, operatorId: 'isolated-maintenance' });
const dump = f => JSON.stringify(f.db.prepare("SELECT name,sql FROM sqlite_master WHERE type='table' ORDER BY name").all().map(t =>
  [t.name, f.db.prepare(`SELECT * FROM "${t.name.replaceAll('"', '""')}" ORDER BY rowid`).all()]));
const relations = { squadMembers: [], wipes: [] };
const actor = grants => ({ id: 'subject', status: 'active', grants });

test('dry-run is deterministic, read-only, reports full reviewable differences and does not alter original marker', t => {
  const f = fixture(t, {}, { exports: false, officialRead: false }), before = dump(f), n = f.changes();
  const a = plan(f), b = plan(f);
  assert.deepEqual(a, b); assert.equal(a.counts.update, 1); assert.ok(a.accounts[0].added.length);
  assert.ok(a.accounts[0].removed.length); assert.equal(a.accounts[0].before.permissionVersion, 1);
  assert.equal(dump(f), before); assert.equal(f.changes(), n); assert.equal(f.repo.scalar(GRANT_MIGRATION_MARKER), null);
});

test('original identity marker still replays while explicit grants migration repairs persistent actors and sessions', t => {
  const f = fixture(t, { permissionRoles: [fullFalse('member')] });
  const oldMarker = f.repo.scalar('v2IdentityMigration'), identityRows = f.repo.all('identities');
  assert.equal(applyIdentityMigration(f.repo, f.originalPlan).replayed, true);
  const before = f.identity.actorForAccount('member');
  assert.equal(can(before, 'stats.export', { kind: 'wipe', id: 'w' }, relations), false);
  const p = plan(f);
  const session = f.identity.issueSession(f.repo.get('accounts', 'member')); // Issued after planning must also be revoked.
  f.identity.session(session.token);
  installPlatformAdminSchema(f.db);
  const mini = new PlatformAdminRepository(f.db);
  mini.put('mini-session', 'subject-mini', 'wechat', 'member', Date.now(), { accountId: 'member', permissionVersion: 1 });
  mini.put('mini-session', 'other-mini', 'wechat', 'other', Date.now(), { accountId: 'other', permissionVersion: 1 });
  const result = apply(f, p), after = f.identity.actorForAccount('member');
  assert.equal(after.permissionVersion, 2); assert.equal(after.revision, 2);
  assert.equal(can(f.repo.get('accounts', 'member'), 'stats.export', { kind: 'wipe', id: 'w' }, relations), true);
  assert.equal(after.roleId, 'member');
  assert.equal(can(after, 'stats.export', { kind: 'wipe', id: 'w' }, relations), false, 'historical grants are evidence, not current fixed-role authority');
  assert.throws(() => f.identity.session(session.token), /AUTH_REQUIRED/);
  assert.equal(mini.get('mini-session', 'subject-mini'), null); assert.ok(mini.get('mini-session', 'other-mini'));
  assert.equal(result.events.length, 1); assert.equal(result.events[0].reason, 'permissions_changed');
  assert.deepEqual(f.repo.all('identities'), identityRows); assert.deepEqual(f.repo.scalar('v2IdentityMigration'), oldMarker);
  assert.equal(f.repo.all('accounts').length, 1); assert.equal(f.repo.all('audits').filter(a => a.action === 'grants_migrated').length, 1);
});

for (const exports of [false, true]) for (const officialRead of [false, true]) {
  test(`original-plan proof accepts exact historical export=${exports} official-read=${officialRead} formula`, t => {
    const role = { id: 'legacy_custom', code: 'legacy_custom', permissions: { kda: { view: true }, officialKda: { edit: true } } };
    const f = fixture(t, { users: [{ id: 'a', role: role.code }], permissionRoles: [role] }, { exports, officialRead });
    assert.equal(plan(f).accounts[0].sourceVersion, `g03-exports-${Number(exports)}-official-read-${Number(officialRead)}`);
    assert.deepEqual(apply(f).changedAccounts, ['a']);
  });
}

test('missing original plan preserves every account and apply writes nothing', t => {
  const f = fixture(t), before = dump(f), n = f.changes();
  const p = planGrantMigration(f.repo);
  assert.equal(p.accounts[0].reasons[0], 'ORIGINAL_IDENTITY_PLAN_REQUIRED');
  const result = applyGrantMigration(f.repo, p, { expectedDigest: p.digest, operatorId: 'operator' });
  assert.equal(result.noWrite, true); assert.equal(dump(f), before); assert.equal(f.changes(), n);
});

test('forged original plan is rejected even when source tags look automatic', t => {
  const f = fixture(t), fake = structuredClone(f.originalPlan), before = dump(f);
  fake.accounts[0].grants.push(grant('system.permissions', { type: 'all' }, { source: 'legacy_compatibility' }));
  assert.throws(() => planGrantMigration(f.repo, { identityPlan: fake }), /EVIDENCE_INVALID/);
  assert.equal(dump(f), before);
});

for (const mode of ['extra-allow', 'deny', 'removed-auto', 'version', 'audit', 'unknown-formula']) {
  test(`explicit or unproven ${mode} is preserved without remapping`, t => {
    const f = fixture(t), a = f.repo.get('accounts', 'member');
    if (mode === 'extra-allow') a.grants.push(grant('system.accounts', { type: 'all' }, { source: 'legacy_effective' }));
    if (mode === 'deny') a.grants.push(grant('stats.export', { type: 'all' }, { effect: 'deny' }));
    if (mode === 'removed-auto') a.grants.shift();
    if (mode === 'version') a.permissionVersion = a.revision = 2;
    if (mode === 'audit') f.repo.put('audits', { id: 'explicit', action: 'permissions_changed', targetAccountId: 'member' });
    if (mode === 'unknown-formula') {
      a.grants.push(grant('system.accounts', { type: 'all' }, { source: 'legacy_effective' }));
      f.originalPlan.accounts[0] = structuredClone(a);
      f.repo.setScalar('v2IdentityMigration', { ...f.repo.scalar('v2IdentityMigration'), planHash: digest(JSON.stringify(f.originalPlan)) });
    }
    f.repo.put('accounts', a);
    const before = dump(f), n = f.changes(), p = plan(f);
    assert.equal(p.counts.needs_review, 1); assert.equal(p.counts.update, 0);
    apply(f, p); assert.equal(dump(f), before); assert.equal(f.changes(), n);
  });
}

for (const change of ['account', 'legacy-user', 'roles', 'squads', 'wipes', 'participants', 'settlements', 'original-marker', 'permission-edit']) {
  test(`observed ${change} drift rejects atomically`, t => {
    const f = fixture(t), p = plan(f);
    if (change === 'account') f.repo.put('accounts', { ...f.repo.get('accounts', 'member'), revision: 2 });
    if (change === 'legacy-user') f.repo.put('users', { ...f.repo.get('users', 'member'), disabled: true });
    if (change === 'roles') f.repo.put('permissionRoles', fullFalse('member'));
    if (change === 'squads') f.repo.put('squads', { id: 's', leaderUserIds: ['member'] });
    if (change === 'wipes') f.repo.put('wipes', { id: 'w', status: 'active' });
    if (change === 'participants') upsertSqliteCollectionRecord(f.db, 'wipeParticipants', 'p', { id: 'p', wipeId: 'w', squadId: 's' });
    if (change === 'settlements') upsertSqliteCollectionRecord(f.db, 'wipeSettlements', 's', { id: 's', wipeId: 'w', participantsSnapshot: [] });
    if (change === 'original-marker') f.repo.setScalar('v2IdentityMigration', { ...f.repo.scalar('v2IdentityMigration'), appliedAt: 'changed' });
    if (change === 'permission-edit') f.repo.put('audits', { id: 'a', action: 'permissions_changed', targetAccountId: 'member' });
    const before = dump(f);
    assert.throws(() => apply(f, p), /PLAN_STALE/); assert.equal(dump(f), before);
  });
}

test('modified plan, including recalculated caller digest, cannot bypass recomputation', t => {
  const f = fixture(t), p = plan(f), before = dump(f);
  p.accounts[0].afterGrants.push(grant('system.permissions', { type: 'all' }));
  assert.throws(() => apply(f, p), /PLAN_TAMPERED/);
  const { digest: ignored, ...body } = p;
  const canonical = value => JSON.stringify(value, (_k, x) => x && typeof x === 'object' && !Array.isArray(x)
    ? Object.fromEntries(Object.keys(x).sort().map(k => [k, x[k]])) : x);
  p.digest = digest(canonical(body));
  assert.throws(() => apply(f, p), /PLAN_STALE/); assert.equal(dump(f), before);
});

for (const stage of ['accounts', 'audits', 'marker', 'mini-session']) {
  test(`SQLite failure at ${stage} rolls back grants versions sessions events and marker`, t => {
    const f = fixture(t, { users: [{ id: 'a', role: 'member' }, { id: 'b', role: 'viewer' }] });
    const sessions = ['a', 'b'].map(id => f.identity.issueSession(f.repo.get('accounts', id)));
    installPlatformAdminSchema(f.db);
    new PlatformAdminRepository(f.db).put('mini-session', 'mini', 'wechat', 'a', 1, { accountId: 'a' });
    if (stage === 'accounts') f.db.exec("CREATE TRIGGER injected BEFORE UPDATE ON json_records WHEN NEW.collection='v2Accounts' AND NEW.id='b' BEGIN SELECT RAISE(ABORT,'injected'); END");
    if (stage === 'audits') f.db.exec("CREATE TRIGGER injected BEFORE INSERT ON json_records WHEN NEW.collection='v2IdentityAudits' BEGIN SELECT RAISE(ABORT,'injected'); END");
    if (stage === 'marker') f.db.exec("CREATE TRIGGER injected BEFORE INSERT ON json_scalars BEGIN SELECT RAISE(ABORT,'injected'); END");
    if (stage === 'mini-session') f.db.exec("CREATE TRIGGER injected BEFORE DELETE ON platform_admin_records BEGIN SELECT RAISE(ABORT,'injected'); END");
    const p = plan(f), before = dump(f);
    assert.throws(() => apply(f, p), /injected/); assert.equal(dump(f), before);
    for (const session of sessions) assert.ok(f.identity.session(session.token));
  });
}

test('same-plan replay and fresh dry-run after success write zero rows and never re-publish events', t => {
  const f = fixture(t), p = plan(f); apply(f, p);
  const before = dump(f), n = f.changes();
  const replay = apply(f, p); assert.equal(replay.replayed, true); assert.deepEqual(replay.events, []);
  const fresh = plan(f); assert.equal(fresh.counts.already_current, 1); assert.equal(apply(f, fresh).noWrite, true);
  assert.equal(dump(f), before); assert.equal(f.changes(), n);
  // A later explicit deny cannot be erased by replaying the completed receipt.
  const a = f.repo.get('accounts', 'member'); a.grants.push(grant('queries.run', { type: 'all' }, { effect: 'deny' }));
  f.repo.put('accounts', a); const changed = dump(f);
  apply(f, p); assert.equal(dump(f), changed); assert.equal(plan(f).accounts[0].reasons[0], 'ALREADY_MIGRATED_ACCOUNT_CHANGED');
});

test('unknown roles do not gain auth-only source grants and new accounts are not recreated', t => {
  const f = fixture(t, { users: [{ id: 'unknown', role: 'mistake' }] });
  f.repo.put('accounts', { id: 'new', roleId: 'member', status: 'active', grants: [], revision: 1, permissionVersion: 1 });
  const p = plan(f); assert.equal(p.accounts.find(a => a.accountId === 'new').status, 'not_applicable');
  assert.deepEqual(migrateLegacyGrants({ id: 'unknown', role: 'mistake' }, {}).grants, []);
  assert.equal(apply(f, p).noWrite, true); assert.equal(f.repo.all('accounts').length, 2);
});

test('admin override uses real root-only userCanWithStore and keeps role-only wipe lifecycle', () => {
  const old = legacyGates();
  for (const edit of [false, true]) {
    const custom = fullFalse('admin'); custom.permissions.sync = { view: true, edit };
    const user = { id: 'admin', role: 'admin' }, store = { permissionRoles: [custom], squads: [] };
    const a = actor(migrateLegacyGrants(user, store).grants);
    assert.equal(old.userCanWithStore(store, user, 'sync', 'edit'), edit);
    assert.equal(can(a, 'sync.run', { kind: 'wipe', id: 'w' }, relations), edit);
    assert.equal(can(a, 'sync.manage', { kind: 'wipe', id: 'w' }, relations), edit);
    assert.equal(can(a, 'sync.read', { kind: 'wipe', id: 'w' }, relations), true);
    assert.equal(can(a, 'system.accounts', { kind: 'account', id: 'a' }, relations), false);
    assert.equal(can(a, 'system.permissions', { kind: 'account', id: 'a' }, relations), false);
    assert.equal(can(a, 'wipes.create', { kind: 'wipe', id: 'w' }, relations), true);
    assert.equal(can(a, 'platforms.configure', { kind: 'platformTarget', id: 'kook' }, relations), false);
    const root = actor(migrateLegacyGrants({ id: 'user_root', role: 'admin' }, store).grants);
    assert.equal(old.userCanWithStore(store, { id: 'user_root', role: 'admin' }, 'sync', 'edit'), true);
    assert.equal(can(root, 'system.permissions', { kind: 'account', id: 'a' }, relations), true);
  }
});

for (const role of ['member', 'viewer', 'leader']) test(`real legacy wipe/export gates survive all-false ${role} matrix`, t => {
  const f = fixture(t, { users: [{ id: role, role }], permissionRoles: [fullFalse(role)],
    squads: [{ id: 'ours', leaderUserIds: [role] }], wipes: [{ id: 'active', status: 'active' }, { id: 'past', status: 'closed' }, { id: 'other', status: 'closed' }],
    wipeParticipants: [{ id: 'p', wipeId: 'past', squadId: 'ours' }] });
  const old = legacyGates(), user = f.store.users[0];
  assert.equal(old.canViewWipesInStore(f.store, user), true);
  apply(f); const a = f.repo.get('accounts', role);
  const current = f.identity.actorForAccount(role);
  assert.equal(current.roleId, 'member');
  assert.equal(can(current, 'stats.export', { kind: 'wipe', id: 'past' }, relations), false);
  for (const w of f.store.wipes) assert.equal(can(a, 'wipes.read', { kind: 'wipe', id: w.id }, relations), old.canViewWipeRecord(f.store, w, user));
  if (role === 'leader') {
    const r = { squadMembers: [{ memberId: 'ours-member', squadId: 'ours' }, { memberId: 'foreign', squadId: 'foreign' }], wipes: [] };
    assert.equal(can(a, 'stats.export', { kind: 'member', id: 'ours-member', wipeId: 'past' }, r), true);
    assert.equal(can(a, 'stats.export', { kind: 'member', id: 'foreign', wipeId: 'past' }, r), false);
    assert.equal(can(a, 'members.basic_edit', { kind: 'member', id: 'unassigned' }, r), false);
  } else assert.equal(can(a, 'stats.export', { kind: 'wipe', id: 'past' }, relations), true);
});

test('historical custom grants remain migration evidence while actual owner can execute CSV export', async t => {
  const role = { id: 'stats_only', code: 'stats_only', permissions: { kda: { view: true } } };
  const f = fixture(t, { users: [{ id: 'user_root', username: 'root', role: 'admin' }, { id: 'custom', role: role.code }], permissionRoles: [role] });
  f.repo.setScalar('v2InstallationOwner', { version: 1, accountId: 'user_root' });
  installStatsSchema(f.db);
  upsertSqliteCollectionRecord(f.db, 'v2Wipes', 'w', { id: 'w', title: '可导出档期', lifecycle: 'active', serverSnapshot: { provider: 'vital' }, audience: { squadIds: [], memberIds: [], includeUnassigned: true } });
  const service = new StatsService(f.identity, { renderExport: createExportRenderer() }), body = { wipeId: 'w', sourceId: 'vital', metricVersion: 'nb-kda-1', format: 'csv', language: 'zh' };
  assert.throws(() => service.createJob(f.identity.actorForAccount('custom'), 'export', body, 'old-export-operation'), /RESOURCE_NOT_FOUND/);
  apply(f);
  assert.equal(can(f.repo.get('accounts', 'custom'), 'stats.export', { kind: 'wipe', id: 'w' }, relations), true);
  assert.throws(() => service.createJob(f.identity.actorForAccount('custom'), 'export', body, 'custom-export-operation'), /RESOURCE_NOT_FOUND/);
  const owner = f.identity.actorForAccount('user_root');
  assert.equal(owner.roleId, 'owner');
  assert.deepEqual(service.catalog(owner).items.map(w => w.id), ['w']);
  const job = service.createJob(owner, 'export', body, 'new-export-operation');
  assert.equal(job.status, 'queued');
  await service.runJob(job.jobId);
  const out = service.readJob(owner, job.jobId);
  assert.equal(out.status, 'succeeded', JSON.stringify(out.result));
  const bytes = Buffer.from(out.result.base64, 'base64');
  assert.equal(digest(bytes.toString('utf8')), out.result.sha256);
  assert.match(bytes.toString('utf8'), /可导出档期/);
  f.repo.setScalar('v2InstallationOwner', null);
  assert.throws(() => service.createJob(f.identity.actorForAccount('user_root'), 'export', body, 'denied-export-operation'), /RESOURCE_NOT_FOUND/);
});

test('querySources only accepts enumerated sources for the four query capabilities and denies always win', () => {
  for (const cap of CAPABILITIES) {
    const g = grant(cap, { type: 'querySources', ids: ['official'] });
    assert.equal(validGrant(g), ['queries.read', 'queries.run', 'inventory.read', 'inventory.query'].includes(cap));
  }
  for (const ids of [[], ['catalog'], ['all'], ['OFFICIAL'], [null]]) assert.equal(validGrant(grant('queries.run', { type: 'querySources', ids })), false);
  const a = actor([grant('queries.run', { type: 'querySources', ids: ['official'] })]);
  for (const kind of ['member', 'query']) {
    assert.equal(can(a, 'queries.run', { kind, id: 'm' }, relations), false);
    assert.equal(can(a, 'queries.run', { kind, id: 'm', querySourceId: 'official' }, relations), true);
    assert.equal(can(a, 'queries.run', { kind, id: 'm', querySourceId: 'moose' }, relations), false);
  }
  a.grants.push(grant('queries.run', { type: 'all' }, { effect: 'deny' }));
  assert.equal(can(a, 'queries.run', { kind: 'member', id: 'm', querySourceId: 'official' }, relations), false);
  const b = actor([grant('queries.run', { type: 'all' }), grant('queries.run', { type: 'querySources', ids: ['vital'] }, { effect: 'deny' })]);
  assert.equal(can(b, 'queries.run', { kind: 'member', id: 'm', querySourceId: 'vital' }, relations), false);
  assert.equal(can(b, 'queries.run', { kind: 'member', id: 'm', querySourceId: 'official' }, relations), true);
});

for (const role of ['admin', 'member_manager', 'leader', 'member', 'viewer', 'custom']) for (const officialView of [false, true]) {
  test(`source gates ${role} official-view=${officialView} for known and unknown members`, () => {
    const old = legacyGates(), custom = fullFalse(role); custom.permissions.officialKda.view = officialView;
    const user = { id: role, role }, store = { permissionRoles: [custom], squads: [] }, a = actor(migrateLegacyGrants(user, store).grants);
    for (const source of QUERY_SOURCES) {
      const readable = source === 'official' || source === 'inventory' || source === 'member' || source === 'vital' ||
        old.userCanWithStore(store, user, 'officialKda', 'view');
      const caps = source === 'inventory' ? ['inventory.read', 'inventory.query'] : ['queries.read', 'queries.run'];
      for (const kind of ['member', 'query']) for (const cap of caps)
        assert.equal(can(a, cap, { kind, id: 'same-id', querySourceId: source }, relations),
          readable && (cap.endsWith('.read') || role !== 'viewer' || !['vital', 'moose'].includes(source)), `${source}/${kind}/${cap}`);
    }
    assert.equal(old.readonlyViewerCanWrite({ method: 'POST', path: '/rust/vital/kda-query' }), false);
    assert.equal(old.readonlyViewerCanWrite({ method: 'GET', path: '/rust/official-kda' }), true);
  });
}

test('CLI defaults to genuinely read-only DB access and refuses stale/implicit apply', t => {
  const dir = mkdtempSync(join(tmpdir(), 'g07-grants-')); t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = join(dir, 'fixture.sqlite'), f = fixture(null, {}, { file }); f.db.close();
  const evidence = join(dir, 'original-plan.json'); writeFileSync(evidence, JSON.stringify(f.originalPlan));
  const before = readFileSync(file), cli = 'test/support/v2-grant-migration/cli.mjs';
  const out = JSON.parse(execFileSync(process.execPath, [cli, '--db', file, '--identity-plan', evidence], { encoding: 'utf8' }));
  assert.equal(out.counts.update, 1); assert.deepEqual(readFileSync(file), before);
  assert.notEqual(spawnSync(process.execPath, [cli, '--db', file, '--mode', 'apply']).status, 0);
  assert.deepEqual(readFileSync(file), before);
});

test('fixed-role changeAccount rejects custom grants and preserves historical explicit deny evidence', t => {
  const f = fixture(t, { users: [{ id: 'user_root', username: 'root', role: 'admin' }, { id: 'member', role: 'member' }] });
  f.repo.setScalar('v2InstallationOwner', { version: 1, accountId: 'user_root' });
  const owner = f.identity.actorForAccount('user_root'), old = f.repo.get('accounts', 'member'), beforeEdit = dump(f);
  assert.equal(owner.roleId, 'owner');
  assert.throws(() => f.identity.changeAccount(owner, old.id, { expectedRevision: 1,
    grants: [...old.grants, grant('stats.export', { type: 'all' }, { effect: 'deny' })] }), /FIXED_ROLE_PERMISSIONS/);
  assert.equal(dump(f), beforeEdit);
  // A historical explicit edit still belongs to the migration's preserved evidence.
  f.repo.put('accounts', { ...old, grants: [...old.grants, grant('stats.export', { type: 'all' }, { effect: 'deny' })] });
  f.repo.put('audits', { id: 'historical-explicit-edit', action: 'permissions_changed', targetAccountId: 'member' });
  const before = dump(f), p = plan(f);
  assert.equal(p.accounts.find(row => row.accountId === 'member').reasons[0], 'EXPLICIT_PERMISSION_EDIT_RECORDED');
  apply(f, p); assert.equal(dump(f), before);
  const self = { ...actor([]), memberId: 'm' };
  assert.equal(can(self, 'stats.read', { kind: 'member', id: 'm' }, relations), true);
  self.grants.push(grant('stats.read', { type: 'self' }, { effect: 'deny' }));
  assert.equal(can(self, 'stats.read', { kind: 'member', id: 'm' }, relations), false);
});

test('unproven historical admin grants require review without minting current authority or losing unrelated sessions', t => {
  const f = fixture(t, { users: [{ id: 'admin', role: 'admin' }, { id: 'member', role: 'member' }], permissionRoles: [fullFalse('admin')] });
  const member = f.repo.get('accounts', 'member'); member.grants.push(grant('stats.read', { type: 'self' }, { effect: 'deny' }));
  f.repo.put('accounts', member);
  const session = f.identity.issueSession(member);
  assert.equal(can(f.repo.get('accounts', 'admin'), 'sync.run', { kind: 'wipe', id: 'w' }, relations), true);
  assert.equal(can(f.identity.actorForAccount('admin'), 'sync.run', { kind: 'wipe', id: 'w' }, relations), false);
  const before = dump(f), p = plan(f);
  assert.equal(p.counts.update, 0); assert.equal(p.counts.needs_review, 2);
  assert.deepEqual(p.accounts.find(row => row.accountId === 'admin').reasons, ['UNKNOWN_HISTORICAL_GRANT_FORMULA']);
  assert.equal(apply(f, p).noWrite, true); assert.equal(dump(f), before);
  const after = f.identity.actorForAccount('admin');
  assert.equal(can(after, 'sync.run', { kind: 'wipe', id: 'w' }, relations), false);
  assert.equal(can(after, 'system.permissions', { kind: 'account', id: 'admin' }, relations), false);
  assert.ok(f.identity.session(session.token)); assert.deepEqual(f.repo.get('accounts', 'member'), member);
});

test('caller outer transaction can roll back a successful inner migration including its returned event records', t => {
  const f = fixture(t), p = plan(f), before = dump(f);
  assert.throws(() => f.repo.transaction(() => { const result = apply(f, p); assert.equal(result.events.length, 1); throw new Error('outer-failure'); }), /outer-failure/);
  assert.equal(dump(f), before);
});

test('an unknown marker version rejects without overwriting a future migration', t => {
  const f = fixture(t); f.repo.setScalar(GRANT_MIGRATION_MARKER, { version: 'future' }); const before = dump(f);
  assert.throws(() => plan(f), /VERSION_CONFLICT/); assert.equal(dump(f), before);
});
