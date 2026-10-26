import { DatabaseSync } from 'node:sqlite';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { digest } from '../../../server/v2/identity/contexts.js';
import { installIdentitySchema, IdentityRepository } from '../../../server/v2/identity/repository.js';
import { planIdentityMigration, applyIdentityMigration } from '../../../server/v2/identity/migration.js';

// Deliberately builds a new candidate DB. This command never mutates its source or accepts credentials.
export async function migrateCopy({ source, output, mode = 'plan', wechatAppId = '' }) {
  if (!['plan', 'apply'].includes(mode)) throw new Error('mode must be plan or apply');
  const sourcePath = path.resolve(source), outputPath = path.resolve(output);
  const bytes = await readFile(sourcePath), sourceHash = digest(bytes);
  const legacy = JSON.parse(bytes);
  if (wechatAppId) { legacy.settings ||= {}; legacy.settings.wechat = { ...legacy.settings.wechat, appId: wechatAppId }; }
  const plan = planIdentityMigration(legacy);
  await mkdir(outputPath, { recursive: true, mode: 0o700 });
  const manifestFile = path.join(outputPath, 'migration.json');
  const report = { mode, sourcePath, sourceHash, counts: Object.fromEntries(Object.entries(plan).map(([key, rows]) => [key, rows.length])),
    conflicts: plan.conflicts, externalAuthentication: 'not_tested', sourceUnchanged: false };
  if (mode === 'apply') {
    const candidate = path.join(outputPath, 'candidate.sqlite');
    // Reserve the target exclusively; never overwrite an existing candidate or production database.
    await writeFile(candidate, '', { flag: 'wx', mode: 0o600 });
    const db = new DatabaseSync(candidate);
    try {
      installIdentitySchema(db); const repo = new IdentityRepository(db);
      repo.transaction(() => {
        for (const [key, records] of Object.entries(legacy)) {
          if (Array.isArray(records)) {
            for (const record of records) {
              if (record && typeof record === 'object' && record.id) {
                // Preserve all old collections, including applications and their audit history.
                const { upsertSqliteCollectionRecord } = migrationPrimitives;
                upsertSqliteCollectionRecord(db, key, record.id, record);
              }
            }
          } else repo.setScalar(key, records);
        }
      });
      report.applied = applyIdentityMigration(repo, plan);
      report.replay = applyIdentityMigration(repo, plan);
      report.integrity = db.prepare('PRAGMA integrity_check').get().integrity_check;
      report.candidate = candidate;
    } finally { db.close(); }
  }
  report.sourceUnchanged = digest(await readFile(sourcePath)) === sourceHash;
  if (!report.sourceUnchanged) throw new Error('Source changed during migration rehearsal');
  await writeFile(manifestFile, JSON.stringify(report, null, 2), { flag: 'wx', mode: 0o600 });
  return report;
}
import * as migrationPrimitives from '../../../server/storage/sqlite-migrate.js';

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const value = key => { const index = args.indexOf(key); return index >= 0 ? args[index + 1] : undefined; };
  if (!value('--source-json') || !value('--output-dir')) throw new Error('Usage: node test/support/v2-identity/migrate.mjs --source-json PATH --output-dir NEW_DIRECTORY [--mode plan|apply] [--wechat-app-id APPID]');
  const report = await migrateCopy({ source: value('--source-json'), output: value('--output-dir'), mode: value('--mode') || 'plan', wechatAppId: value('--wechat-app-id') });
  console.log(JSON.stringify({ mode: report.mode, counts: report.counts, sourceUnchanged: report.sourceUnchanged, candidate: report.candidate || null, integrity: report.integrity || null }));
}
