import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { need, noSymlinks } from '../../server/v2/candidate-host/config.js';
import { productionConfig, planProductionMigration, applyProductionMigration, acquireProductionLease, validateProductionReady } from '../../server/v2/production/migrations.js';
async function readPrivateJSON(file) {
  await noSymlinks(file); const s = await fs.stat(file);
  need(s.isFile() && s.uid === process.getuid() && (s.mode & 0o077) === 0 && s.size <= 20 * 1024 * 1024, 'PRODUCTION_PRIVATE_INPUT_REQUIRED', 422);
  return JSON.parse(await fs.readFile(file, 'utf8'));
}
export async function run(action, input, args = []) {
  const config = productionConfig(input);
  if (action === 'plan') {
    const options = args[0] ? await readPrivateJSON(args[0]) : {};
    const plan = await planProductionMigration(config, options);
    const file = path.join(config.dataDirectory, '.v2-production', `plan-${plan.digest}.json`);
    await fs.writeFile(file, JSON.stringify(plan), { mode: 0o600, flag: 'wx' });
    console.log(JSON.stringify({ digest: plan.digest, review: plan.review, identityAlreadyApplied: plan.identityAlreadyApplied, planFile: file })); return;
  }
  if (action === 'ready') { console.log(JSON.stringify(await validateProductionReady(config))); return; }
  need(action === 'apply', 'PRODUCTION_ACTION_INVALID', 422);
  const [expectedDigest, operatorId, receiptFile] = args;
  need(/^[a-f0-9]{64}$/.test(expectedDigest || '') && operatorId === 'user_root' && receiptFile, 'PRODUCTION_APPLY_ARGUMENTS_REQUIRED', 422);
  const plan = await readPrivateJSON(path.join(config.dataDirectory, '.v2-production', `plan-${expectedDigest}.json`));
  const stopReceipt = await readPrivateJSON(receiptFile), lease = await acquireProductionLease(config, { mode: 'maintenance', stopReceipt });
  try { console.log(JSON.stringify(await applyProductionMigration(config, plan, { expectedDigest, operatorId, maintenanceLease: lease }))); }
  finally { await lease.release(); }
}
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try { await run(process.argv[2], JSON.parse(process.argv[3]), process.argv.slice(4)); }
  catch (e) { console.error(JSON.stringify({ errorCode: /^[A-Z][A-Z0-9_]+$/.test(e.errorCode || '') ? e.errorCode : 'PRODUCTION_MIGRATION_COMMAND_FAILED' })); process.exitCode = 1; }
}
