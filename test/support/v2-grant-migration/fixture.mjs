import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import * as legacy from '../../../server/permissions.js';
import { installIdentitySchema, IdentityRepository } from '../../../server/v2/identity/repository.js';
import { planIdentityMigration, applyIdentityMigration } from '../../../server/v2/identity/migration.js';
import { IdentityService } from '../../../server/v2/identity/service.js';
import { migrateLegacyGrants as oldGrants } from './historical-permissions.mjs';
import { upsertSqliteCollectionRecord } from '../../../server/storage/sqlite-migrate.js';
export const fullFalse = code => ({ id: code, code, permissions: Object.fromEntries(legacy.PERMISSION_MODULES.map(m => [m.id, { view: false, edit: false }])) });
export function fixture(t, input = {}, { exports = true, officialRead = true, file = ':memory:' } = {}) {
  const db = new DatabaseSync(file); t?.after(() => db.close()); installIdentitySchema(db);
  const repo = new IdentityRepository(db);
  const store = { users: [{ id: 'member', role: 'member' }], members: [], permissionRoles: [], squads: [],
    wipes: [], wipeParticipants: [], wipeSettlements: [], ...input };
  // The real repository reads policy rows by ID; use that order in the original
  // synthetic migration evidence too, so unrelated fingerprint drift is absent.
  store.permissionRoles = [...store.permissionRoles].sort((a, b) => a.id.localeCompare(b.id));
  for (const [collection, records] of Object.entries(store)) for (const row of records)
    upsertSqliteCollectionRecord(db, collection, row.id, row);
  // Preserve the exact full original plan which applyIdentityMigration hashes.
  const originalPlan = planIdentityMigration(store, '2026-09-01T00:00:00.000Z');
  for (const account of originalPlan.accounts) account.grants = oldGrants(store.users.find(u => u.id === account.id), store).grants
    .filter(g => (exports || g.capability !== 'stats.export' || g.source !== 'legacy_compatibility') &&
      (officialRead || g.capability !== 'queries.read' || g.source !== 'legacy_effective'));
  applyIdentityMigration(repo, originalPlan);
  return { db, repo, store, originalPlan, identity: new IdentityService(repo, { providers: {} }),
    changes: () => db.prepare('SELECT total_changes() n').get().n };
}

// Execute the real legacy functions rather than the unused userCan admin bypass.
export function legacyGates() {
  const source = readFileSync(new URL('../../../server/api.js', import.meta.url), 'utf8');
  const load = (name, dependencies) => {
    const start = source.indexOf(`function ${name}(`), end = source.indexOf('\n}\n', start) + 2;
    if (start < 0 || end < start) throw new Error(`Legacy gate missing: ${name}`);
    return new Function(...Object.keys(dependencies), `return (${source.slice(start, end)});`)(...Object.values(dependencies));
  };
  const isRootUser = load('isRootUser', {}), permissionRolesForStore = load('permissionRolesForStore', legacy);
  const userCanWithStore = load('userCanWithStore', { ...legacy, isRootUser, permissionRolesForStore });
  const canViewModuleInStore = load('canViewModuleInStore', { userCanWithStore });
  const canViewOperationalData = load('canViewOperationalData', { ...legacy, canViewModuleInStore });
  const activeSquads = store => store.squads.filter(s => !s.archivedAt);
  const leaderSquads = (store, user) => activeSquads(store).filter(s => legacy.isSquadLeader(user, s));
  const canViewWipeRecord = load('canViewWipeRecord', { ...legacy, canViewOperationalData, leaderSquads });
  const canViewWipesInStore = load('canViewWipesInStore', { ...legacy, activeSquads, canViewModuleInStore });
  const readonlyViewerCanWrite = load('readonlyViewerCanWrite', {});
  return { source, userCanWithStore, canViewOperationalData, canViewWipeRecord, canViewWipesInStore, readonlyViewerCanWrite };
}
