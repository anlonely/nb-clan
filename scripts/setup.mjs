import { promises as fs } from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { runtimeConfiguration, commandError } from './runtime-config.mjs';
import { noSymlinks } from '../server/v2/candidate-host/config.js';
import { productionConfig, acquireProductionLease, planProductionMigration, applyProductionMigration, validateProductionReady } from '../server/v2/production/migrations.js';

export async function setup(config) {
  config = productionConfig(config);
  const { dataDirectory, databaseFile } = config;
  await noSymlinks(path.dirname(dataDirectory));
  try { await fs.mkdir(dataDirectory, { mode: 0o700 }); } catch (error) { if (error.code !== 'EEXIST') throw error; }
  await noSymlinks(dataDirectory);
  const entries = await fs.readdir(dataDirectory);
  if (entries.length) {
    if (entries.includes('.setup.lock')) throw new Error('SETUP_INCOMPLETE_OR_RUNNING');
    try { await validateProductionReady(config); }
    catch { throw new Error('EXISTING_DATA_REQUIRES_EXPLICIT_MIGRATION'); }
    return { ok: true, initialized: false, credentialsFile: path.join(dataDirectory, 'root-credentials.txt') };
  }
  if (process.env.NB_ROOT_PASSWORD && (process.env.NB_ROOT_PASSWORD.length < 16 || process.env.NB_ROOT_PASSWORD.length > 128))
    throw new Error('ROOT_PASSWORD_LENGTH_INVALID');
  const stat = await fs.stat(dataDirectory);
  if (stat.uid !== process.getuid()) throw new Error('DATA_DIRECTORY_OWNER_REQUIRED');
  await fs.chmod(dataDirectory, 0o700);
  const lock = path.join(dataDirectory, '.setup.lock');
  await fs.writeFile(lock, JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }), { flag: 'wx', mode: 0o600 });
  // Once initialized, failures deliberately retain the fence and partial data. Never
  // erase an existing database or guess that a crashed writer is safe to replace.
  if ((await fs.readdir(dataDirectory)).some(name => name !== '.setup.lock')) throw new Error('SETUP_DIRECTORY_CHANGED');
  const seed = `import { ensureStore, drainStoreWrites } from ${JSON.stringify(new URL('../server/store.js', import.meta.url).href)};
    import { closeSqliteDatabases } from ${JSON.stringify(new URL('../server/storage/sqlite.js', import.meta.url).href)};
    import { openSqliteDatabase } from ${JSON.stringify(new URL('../server/storage/sqlite.js', import.meta.url).href)};
    import { upsertSqliteScalar } from ${JSON.stringify(new URL('../server/storage/sqlite-migrate.js', import.meta.url).href)};
    await ensureStore(); await drainStoreWrites();
    upsertSqliteScalar(await openSqliteDatabase(), 'v2InstallationOwner', { version: 1, accountId: 'user_root' });
    await closeSqliteDatabases({ checkpointMode: 'TRUNCATE' });`;
  const child = spawn(process.execPath, ['--input-type=module', '-e', seed], {
    env: { PATH: process.env.PATH, NB_DATA_DIR: dataDirectory, NB_SQLITE_FILE: databaseFile,
      NB_STORAGE_MODE: 'sqlite-primary', ...(process.env.NB_ROOT_PASSWORD ? { NB_ROOT_PASSWORD: process.env.NB_ROOT_PASSWORD } : {}) },
    stdio: ['ignore', 'ignore', 'ignore']
  });
  await new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', code => code === 0 ? resolve() : reject(new Error('SETUP_SEED_FAILED')));
  });
  const plan = await planProductionMigration(config);
  const lease = await acquireProductionLease(config, { mode: 'maintenance',
    stopReceipt: { kind: 'process-stop', pids: [child.pid], observedAt: new Date().toISOString() } });
  try { await applyProductionMigration(config, plan, { expectedDigest: plan.digest, operatorId: 'user_root', maintenanceLease: lease }); }
  finally { await lease.release(); }
  await validateProductionReady(config);
  await fs.unlink(lock);
  return { ok: true, initialized: true, credentialsFile: path.join(dataDirectory, 'root-credentials.txt') };
}
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try { console.log(JSON.stringify(await setup(await runtimeConfiguration()))); }
  catch (error) { console.error(JSON.stringify({ ok: false, errorCode: commandError(error) })); process.exitCode = 1; }
}
