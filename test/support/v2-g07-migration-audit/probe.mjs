import '../results.mjs';
// Diagnostic probes for the immutable dispatch snapshot, not product acceptance tests.
import '../v2-source-main/offline.mjs';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { writeFile, chmod } from 'node:fs/promises';
import { installIdentitySchema, IdentityRepository } from '../../../server/v2/identity/repository.js';
import { planIdentityMigration, applyIdentityMigration } from '../../../server/v2/identity/migration.js';
import { migrateLegacyGrants, can, grant, CAPABILITIES } from '../../../server/v2/identity/permissions.js';
import { IdentityService } from '../../../server/v2/identity/service.js';
import { canViewWipes, roleCan } from '../../../server/permissions.js';
import { managementSections } from '../../../server/v2/member-space/management-sections.js';
import { fixture } from '../v2-stats/fixture.mjs';
import { StatsService } from '../../../server/v2/stats/service.js';
import { createSourceHost } from '../../../server/v2/management-adapters/source-host/index.js';
import { createStatsProviders } from '../../../server/v2/stats/providers.js';
const all = { type: 'all' };
const actor = grants => ({ id: 'audit', status: 'active', permissionVersion: 1, grants });
const rel = { members: [], squadMembers: [], squads: [], wipes: [] };
export async function probe() {
  const observations = [];
  const note = (id, data) => observations.push({ id, ...data });
  // Built-in operational access survives a legacy module matrix override.
  const user = { id: 'role-member', role: 'member' }, roles = [{ code: 'member', permissions: {} }];
  const mapped = actor(migrateLegacyGrants(user, { permissionRoles: roles }).grants);
  assert.equal(canViewWipes(user), true);
  const memberExport = can(mapped, 'stats.export', { kind: 'wipe', id: 'w' }, rel);
  note('A01-role-only-export', { legacyCanViewWipes: true, legacyModuleKdaView: roleCan('member', roles, 'kda'), v2Export: memberExport, mismatch: !memberExport });
  // An overridden legacy admin module is checked by actual roleCan in requireModuleEdit.
  const adminRoles = [{ code: 'admin', permissions: {} }];
  const oldSync = roleCan('admin', adminRoles, 'sync', 'edit');
  const newSync = can(actor(migrateLegacyGrants({ id: 'a', role: 'admin' }, { permissionRoles: adminRoles }).grants), 'sync.run', { kind: 'sync', id: 'global' }, rel);
  assert.equal(oldSync, false);
  note('A02-admin-override', { legacySyncEdit: oldSync, v2SyncRun: newSync, mismatch: oldSync !== newSync });
  // Fresh persisted SQLite, no real users/data. Simulates an earlier v1 account missing newly mapped caps.
  const db = new DatabaseSync(':memory:');
  try {
    installIdentitySchema(db); const repo = new IdentityRepository(db);
    const store = { users: [{ id: 'persisted', role: 'member', username: 'persisted' }], permissionRoles: [] };
    repo.put('users', store.users[0]);
    const oldPlan = planIdentityMigration(store);
    oldPlan.accounts[0].grants = oldPlan.accounts[0].grants.filter(g => !['stats.export','queries.read'].includes(g.capability));
    oldPlan.accounts[0].grants.push(grant('stats.export', all, { effect: 'deny' }));
    applyIdentityMigration(repo, oldPlan);
    const identity = new IdentityService(repo), before = repo.get('accounts', 'persisted');
    const result = applyIdentityMigration(repo, planIdentityMigration(store));
    const current = identity.actorForAccount('persisted');
    assert.equal(result.replayed, true); assert.deepEqual(repo.get('accounts', 'persisted'), before);
    note('A03-persisted-grants-not-upgraded', { replayed: result.replayed, expectedFreshExportAllow: planIdentityMigration(store).accounts[0].grants.some(g => g.capability === 'stats.export' && g.effect === 'allow'),
      actualExportAllow: current.grants.some(g => g.capability === 'stats.export' && g.effect === 'allow'), queriesRead: current.grants.some(g => g.capability === 'queries.read'), explicitDenyPreserved: current.grants.some(g => g.capability === 'stats.export' && g.effect === 'deny'), permissionVersion: current.permissionVersion, mismatch: !current.grants.some(g => g.capability === 'queries.read') });
  } finally { db.close(); }
  const f = fixture();
  try {
    // Existing real StatsService and identity; no fake permission implementation.
    const original = f.ir.get('accounts', 'g05_account_admin');
    const queryOnly = migrateLegacyGrants({ id: 'inventory', role: 'inventory_only' }, { permissionRoles: [{ code: 'inventory_only', permissions: { inventoryDetails: { view: true, edit: true } } }] }).grants;
    f.ir.put('accounts', { ...original, grants: queryOnly });
    let current = f.admin(); const service = new StatsService(f.identity);
    service.queryAuth(current, { sourceId: 'inventory', steamInput: '76561198000000501' });
    const sections = managementSections(current, f.identity.relations(), current.grants);
    note('A04-inventory-navigation', { backendQueryAuthorized: true, sections, mismatch: !sections.some(s => s.id === 'stats') });
    const statsOnly = migrateLegacyGrants({ id: 'stats', role: 'stats_only' }, { permissionRoles: [{ code: 'stats_only', permissions: { kda: { view: true, edit: false } } }] }).grants;
    f.ir.put('accounts', { ...original, memberId: null, grants: statsOnly });
    f.ir.remove('bindings', 'binding_admin'); current = f.admin();
    assert.equal(can(current, 'stats.export', { kind: 'wipe', id: 'g07_active' }, f.identity.relations()), true);
    let exportError = null; try { service.createJob(current, 'export', { wipeId: 'g07_active', format: 'csv' }, 'audit-export-operation'); } catch (e) { exportError = e.errorCode; }
    note('A05-kda-view-export-missing-wipe-read', { exportGrant: true, wipesRead: can(current, 'wipes.read', { kind: 'wipe', id: 'g07_active' }, f.identity.relations()), actualExportError: exportError, mismatch: exportError === 'RESOURCE_NOT_FOUND' });
    // Explicit deny still wins over implicit self/squad access and all grants.
    const denied = { ...current, memberId: 'g05_alpha', grants: [grant('members.read', all), grant('members.read', { type: 'squads', ids: ['g05_squad'] }, { effect: 'deny' })] };
    assert.equal(can(denied, 'members.read', { kind: 'member', id: 'g05_alpha' }, f.identity.relations()), false);
    assert.equal(can(denied, 'members.read', { kind: 'member', id: 'g05_foreign' }, f.identity.relations()), true);
    note('P01-explicit-deny-scope', { ownSquadDenied: true, foreignUnrelatedAllow: true });
    f.ir.put('accounts', original); f.ir.put('bindings', { id: 'binding_admin', accountId: original.id, memberId: original.memberId, steamId: '76561198000000504', status: 'verified', revision: 1 });
    const host = createSourceHost({ fetchImpl: async () => { throw new Error('no network expected'); }, readSettings: () => ({}), readWipe: () => null, capabilities: {} });
    try {
      const withHost = new StatsService(f.identity, { providers: createStatsProviders(host.readers.stats) });
      const queued = withHost.createJob(f.admin(), 'query', { sourceId: 'member', steamInput: '76561198000000501' }, 'audit-member-source-query');
      await withHost.runJob(queued.jobId); const result = withHost.readJob(f.admin(), queued.jobId);
      const fallback = new StatsService(f.identity), other = fallback.createJob(f.admin(), 'query', { sourceId: 'member', steamInput: '76561198000000501' }, 'audit-member-fallback');
      await fallback.runJob(other.jobId); const local = fallback.readJob(f.admin(), other.jobId); assert.equal(local.status, 'succeeded');
      note('A06-source-host-shadows-member-fallback', { withHost: result.status, reason: result.result?.errorCode, withoutHost: local.status, mismatch: result.status !== 'succeeded' });
    } finally { await host.stop(); }
  } finally { f.db.close(); }
  // Baseline observations are intentionally not asserted to remain broken after root fixes.
  const result = { scope: 'dispatch snapshot diagnostic; mismatches are defects/boundaries, not acceptance success', observations, mismatches: observations.filter(x => x.mismatch).map(x => x.id), sqliteClosed: true, externalRequests: 0 };
  await writeFile(new URL('../../../output/test-results/g07-migration-audit/probe-report.json', import.meta.url), JSON.stringify(result, null, 2) + '\n');
  await chmod(new URL('../../../output/test-results/g07-migration-audit/probe-report.json', import.meta.url), 0o644);
  return result;
}
if (process.argv[1] && new URL(import.meta.url).pathname === process.argv[1]) console.log(JSON.stringify(await probe()));
