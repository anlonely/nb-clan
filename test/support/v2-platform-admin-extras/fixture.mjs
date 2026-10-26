import { fixture as statsFixture } from '../v2-stats/fixture.mjs';
import { SchedulingService } from '../../../server/v2/scheduling/service.js';
import { MemberAdminService } from '../../../server/v2/member-admin/service.js';
import { installMemberAdminSchema } from '../../../server/v2/member-admin/repository.js';
import { migrateSystemAdmin } from '../../../server/v2/system-admin/repository.js';
import { SystemAdminService } from '../../../server/v2/system-admin/service.js';
import { createSystemIdentityAdapter } from '../../../server/v2/system-admin/identity-adapter.js';
import { legacyFingerprint } from '../../../server/v2/identity/migration.js';
import { installPlatformAdminExtrasSchema, createPlatformAdminExtras } from '../../../server/v2/platform-admin-extras/index.js';
export const catalog = [
  { id: 'vital-eu', serverProfileId: 'profile-eu', vitalServerId: 'vital-101', name: 'EU Monthly', directConnect: 'client.connect eu-monthly.vitalrust.com:28014', vipUrl: 'https://shop.example.invalid/eu' },
  { id: 'vital-us', serverProfileId: 'profile-us', vitalServerId: 'vital-102', name: 'US Monthly', directConnect: 'client.connect 192.0.2.1:28014' }
];
export function fixture(options = {}) {
  const f = statsFixture(options.file || ':memory:', { scopeContract: options.scopeContract === true });
  installMemberAdminSchema(f.db); migrateSystemAdmin(f.db, { apply: true });
  const legacy = { id: 'legacy_admin', username: 'admin', role: 'admin' };
  f.ir.put('users', legacy); f.ir.put('accounts', { ...f.ir.get('accounts', f.admin().id), legacyUserId: legacy.id, legacyFingerprint: legacyFingerprint(legacy, []) });
  f.ir.setScalar('settings', { system: { brand: 'keep-me' }, steam: { apiKey: 'private-not-for-dto' }, vitalServers: { extra: 'preserve', overrides: [] } });
  const wipe = f.sr.get('wipes', 'g07_active'); f.sr.put('wipes', { ...wipe, serverSnapshot: { name: 'Original', directConnect: 'old-address' } });
  for (let i = 0; i < 5; i++) f.put('logs', { id: `log-${i}`, type: 'login', createdAt: '2026-09-08T02:00:00.000Z', metadata: { secret: 'never-return' } });
  f.put('joinApplications', { id: 'own-review', memberId: 'g05_alpha', status: 'pending' });
  f.put('joinApplications', { id: 'other-review', memberId: 'g05_foreign', status: 'pending' });
  f.put('joinApplications', { id: 'missing-status-review', memberId: 'g05_alpha' });
  installPlatformAdminExtrasSchema(f.db, { catalog });
  let queue = Promise.resolve(); const events = [], patches = [];
  const runStoreWriteTask = fn => { const p = queue.then(fn); queue = p.catch(() => {}); return p; };
  const members = new MemberAdminService(f.identity), scheduling = new SchedulingService(f.sr, f.identity);
  const system = new SystemAdminService({ identity: f.identity, identityAdmin: createSystemIdentityAdapter(f.identity), owner: {}, storage: {} });
  const args = { identity: f.identity, members, scheduling, stats: f.service, system, readCatalog: () => catalog,
    runStoreWriteTask, patchCache: async change => { await options.patchCache?.(change); patches.push(change); },
    publishEvents: async values => { await options.publishEvents?.(values); events.push(...values); }, now: () => Date.parse('2026-09-08T04:00:00.000Z'), ...options };
  const extras = createPlatformAdminExtras(args);
  return { ...f, extras, args, members, scheduling, system, patches, events, runStoreWriteTask, close: async () => { await queue; f.db.close(); } };
}
