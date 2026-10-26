import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { readFile, writeFile, mkdir, realpath } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { installIdentitySchema, IdentityRepository } from '../../../server/v2/identity/repository.js';
import { planIdentityMigration, applyIdentityMigration } from '../../../server/v2/identity/migration.js';
import { installSchedulingSchema, SchedulingRepository } from '../../../server/v2/scheduling/repository.js';
import { planSchedulingMigration, applySchedulingMigration } from '../../../server/v2/scheduling/migration.js';
import { upsertSqliteCollectionRecord, upsertSqliteScalar } from '../../../server/storage/sqlite-migrate.js';

const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const within = (base, target) => target !== base && !path.relative(base, target).startsWith('..') && !path.isAbsolute(path.relative(base, target));

// Offline rehearsal only. There is no in-place mode, network client, platform
// credential or service startup. Every output is exclusively created here.
export async function migrateSchedulingCopy({ source, output, mode = 'plan', now }) {
  if (!['plan', 'apply'].includes(mode)) throw new Error('mode must be plan or apply');
  if (!source || !output) throw new Error('Explicit source and new output directory are required');
  const sourcePath = await realpath(path.resolve(source));
  const outputPath = path.resolve(output);
  if (!within(root, outputPath)) throw new Error('Output must be inside this independent worktree');
  const bytes = await readFile(sourcePath), sourceHash = hash(bytes), legacy = JSON.parse(bytes);
  if (!legacy || typeof legacy !== 'object' || Array.isArray(legacy) || Object.keys(legacy).some(key => key.startsWith('v2'))) {
    throw new Error('Source must be a legacy JSON store without V2 collections');
  }
  const plan = planSchedulingMigration(legacy, { now });
  const identityPlan = mode === 'apply' ? planIdentityMigration(legacy, now) : null;
  // Resolve a pre-existing parent to reject symlink escapes before creating.
  const outputParent = await realpath(path.dirname(outputPath));
  if (outputParent !== root && !within(root, outputParent)) throw new Error('Output parent escapes this worktree');
  await mkdir(outputPath, { mode: 0o700 });
  const report = { mode, sourcePath, sourceHash, schedulingSourceHash: plan.sourceHash,
    counts: Object.fromEntries(['wipes', 'signups', 'contentSnapshots', 'archives', 'quarantine'].map(key => [key, plan[key].length])),
    quarantine: plan.quarantine.map(({ id, kind, wipeId, memberId }) => ({ id, kind, wipeId, memberId })),
    externalPlatforms: 'not_tested', network: 'none', sourceUnchanged: false };
  if (mode === 'apply') {
    const candidate = path.join(outputPath, 'candidate.sqlite');
    await writeFile(candidate, '', { flag: 'wx', mode: 0o600 });
    const db = new DatabaseSync(candidate);
    try {
      installIdentitySchema(db); installSchedulingSchema(db);
      const identityRepo = new IdentityRepository(db), schedulingRepo = new SchedulingRepository(db);
      identityRepo.transaction(() => {
        for (const [collection, records] of Object.entries(legacy)) {
          if (Array.isArray(records)) {
            for (const row of records) if (row && typeof row === 'object' && row.id) upsertSqliteCollectionRecord(db, collection, row.id, row);
          } else upsertSqliteScalar(db, collection, records);
        }
      });
      report.identity = applyIdentityMigration(identityRepo, identityPlan);
      report.scheduling = applySchedulingMigration(schedulingRepo, plan);
      report.replay = applySchedulingMigration(schedulingRepo, plan);
      report.integrity = db.prepare('PRAGMA integrity_check').get().integrity_check;
      report.candidate = candidate;
    } finally { db.close(); }
  }
  report.sourceUnchanged = hash(await readFile(sourcePath)) === sourceHash;
  if (!report.sourceUnchanged) throw new Error('Source changed during migration rehearsal');
  await writeFile(path.join(outputPath, 'migration.json'), JSON.stringify(report, null, 2), { flag: 'wx', mode: 0o600 });
  return report;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const value = key => { const index = args.indexOf(key); return index < 0 ? undefined : args[index + 1]; };
  if (!value('--source-json') || !value('--output-dir')) throw new Error('Usage: node test/support/v2-scheduling/migrate.mjs --source-json PATH --output-dir NEW_DIRECTORY [--mode plan|apply] [--now UTC]');
  const report = await migrateSchedulingCopy({ source: value('--source-json'), output: value('--output-dir'), mode: value('--mode') || 'plan', now: value('--now') });
  console.log(JSON.stringify({ mode: report.mode, counts: report.counts, sourceUnchanged: report.sourceUnchanged,
    candidate: report.candidate ?? null, integrity: report.integrity ?? null }));
}
