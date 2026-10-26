import '../results.mjs';
import { writeFileSync, mkdirSync, chmodSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { fixture, fullFalse, legacyGates } from './fixture.mjs';
import { planGrantMigration, applyGrantMigration } from '../../../server/v2/identity/grant-migration.js';
import { can, grant, QUERY_SOURCES } from '../../../server/v2/identity/permissions.js';
import { StatsService } from '../../../server/v2/stats/service.js';
import { installStatsSchema } from '../../../server/v2/stats/repository.js';
import { createExportRenderer } from '../../../server/v2/stats/exports.js';
import { upsertSqliteCollectionRecord } from '../../../server/storage/sqlite-migrate.js';
const output = resolve(process.argv[2] || 'output/test-results/g07-grant-migration');
mkdirSync(output, { recursive: true });
const role = { id: 'stats_only', code: 'stats_only', permissions: { kda: { view: true } } };
const f = fixture(null, { users: [{ id: 'admin', role: 'admin' }, { id: 'member', role: 'member' },
  { id: 'viewer', role: 'viewer' }, { id: 'custom', role: 'stats_only' }, { id: 'explicit', role: 'member' }],
  permissionRoles: [fullFalse('admin'), fullFalse('member'), fullFalse('viewer'), role],
  wipes: [{ id: 'sample-wipe', status: 'active' }] }, { exports: false, officialRead: false });
try {
  const explicit = f.repo.get('accounts', 'explicit');
  explicit.grants.push(grant('stats.export', { type: 'all' }, { effect: 'deny' })); f.repo.put('accounts', explicit);
  installStatsSchema(f.db);
  upsertSqliteCollectionRecord(f.db, 'v2Wipes', 'sample-wipe', { id: 'sample-wipe', title: '隔离补迁移导出验证', lifecycle: 'active',
    audience: { squadIds: [], memberIds: [], includeUnassigned: true } });
  const stats = new StatsService(f.identity, { renderExport: createExportRenderer() });
  const body = { wipeId: 'sample-wipe', sourceId: 'vital', metricVersion: 'nb-kda-1', format: 'csv', language: 'zh' };
  let beforeExport;
  try { stats.createJob(f.identity.actorForAccount('custom'), 'export', body, 'old-export-proof'); }
  catch (error) { beforeExport = { code: error.errorCode, status: error.status }; }
  const noEvidence = planGrantMigration(f.repo), n = f.changes();
  const p = planGrantMigration(f.repo, { identityPlan: f.originalPlan });
  const dryRunWrites = f.changes() - n;
  const session = f.identity.issueSession(f.repo.get('accounts', 'member'));
  const applyOptions = { identityPlan: f.originalPlan, expectedDigest: p.digest, operatorId: 'isolated-proof' };
  const result = applyGrantMigration(f.repo, p, applyOptions);
  let oldSession;
  try { f.identity.session(session.token); oldSession = 'unexpected_valid'; } catch (error) { oldSession = error.errorCode; }
  const after = f.identity.actorForAccount('custom'), job = stats.createJob(after, 'export', body, 'new-export-proof');
  await stats.runJob(job.jobId); const exported = stats.readJob(after, job.jobId);
  if (exported.status !== 'succeeded') throw new Error(JSON.stringify(exported));
  writeFileSync(join(output, 'isolated-export.csv'), Buffer.from(exported.result.base64, 'base64'));
  const beforeReplay = f.changes(), replay = applyGrantMigration(f.repo, p, applyOptions);
  const old = legacyGates(), rel = f.identity.relations();
  const matrix = f.store.users.map(user => {
    const a = f.identity.actorForAccount(user.id);
    return { accountId: user.id, role: user.role, permissionVersion: a.permissionVersion,
      oldSyncRun: old.userCanWithStore(f.store, user, 'sync', 'edit'),
      newSyncRun: can(a, 'sync.run', { kind: 'wipe', id: 'sample-wipe' }, rel),
      oldExportGate: old.canViewWipesInStore(f.store, user) && old.canViewWipeRecord(f.store, f.store.wipes[0], user),
      newExportGate: can(a, 'wipes.read', { kind: 'wipe', id: 'sample-wipe' }, rel) && can(a, 'stats.export', { kind: 'wipe', id: 'sample-wipe' }, rel),
      querySources: Object.fromEntries(QUERY_SOURCES.map(source => [source, Object.fromEntries((source === 'inventory' ? ['inventory.read', 'inventory.query'] : ['queries.read', 'queries.run'])
        .map(cap => [cap, can(a, cap, { kind: 'query', id: source, querySourceId: source }, rel)]))])) };
  });
  const report = { environment: 'isolated-memory-sqlite-no-network', version: p.version, dryRunWrites,
    withoutOriginalPlan: noEvidence.counts, withOriginalPlan: p.counts, originalPlanHash: f.repo.scalar('v2IdentityMigration').planHash,
    applied: result.changedAccounts, oldSession, replay: { replayed: replay.replayed, writes: f.changes() - beforeReplay, events: replay.events.length },
    export: { before: beforeExport, after: { status: exported.status, file: 'isolated-export.csv', sha256: exported.result.sha256,
      evidenceLevel: 'actual StatsService createJob/runJob/readJob and CSV bytes; no HTTP or browser download' } },
    unresolved: p.accounts.filter(a => a.status === 'needs_review').map(a => ({ accountId: a.accountId, reasons: a.reasons })), matrix };
  for (const [name, value] of [['probe-report.json', report], ['sample-dry-run.json', p], ['sample-original-plan.json', f.originalPlan]])
    writeFileSync(join(output, name), JSON.stringify(value, null, 2) + '\n');
  // All four artifacts contain synthetic fixture data and are patch-delivered.
  for (const name of ['isolated-export.csv', 'probe-report.json', 'sample-dry-run.json', 'sample-original-plan.json']) chmodSync(join(output, name), 0o644);
  process.stdout.write(JSON.stringify({ dryRunWrites, changedAccounts: result.changedAccounts, replayWrites: report.replay.writes,
    exportStatus: exported.status, needsReview: p.counts.needs_review }) + '\n');
} finally { f.db.close(); }
