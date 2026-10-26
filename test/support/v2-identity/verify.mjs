import { spawn, execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, writeFile, readdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
await mkdir(path.join(root, 'work/v2-g03'), { recursive: true });
const runDir = await mkdtemp(path.join(root, 'work/v2-g03/run-'));
const env = { PATH: process.env.PATH, LANG: 'en_US.UTF-8', TZ: 'Asia/Shanghai', NODE_ENV: 'production',
  NB_DATA_DIR: path.join(runDir, 'data'), NB_SQLITE_FILE: path.join(runDir, 'data/nb-clan.sqlite'),
  NB_STORAGE_MODE: 'sqlite-primary', NB_DISABLE_BACKGROUND_JOBS: '1', NB_DISABLE_EXTERNAL_VITAL: '1', NB_DISABLE_EXTERNAL_ATLAS: '1',
  NB_RUSTPLUS_RELAY_CHAT_FLUSH_INTERVAL_MS: '0', NB_ROOT_PASSWORD: 'G03-Isolated-Only-2026!',
  NODE_OPTIONS: `--import=${path.join(root, 'test/support/v2-baseline/loopback-only.mjs')}`, G03_RUN_DIR: runDir };
async function run(args, log, extra = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, { cwd: root, env: { ...env, ...extra }, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = ''; child.stdout.on('data', x => output += x); child.stderr.on('data', x => output += x); child.on('error', reject);
    child.on('close', async code => { await writeFile(path.join(runDir, log), output); console.log(`${log}: exit ${code}`); resolve({ args, code, log }); });
  });
}
const tests = await run(['--test', 'test/v2-identity.test.js', 'test/v2-identity-http.test.js', 'test/v2-steam-proof.test.js',
  'test/permissions.test.js', 'test/security-permissions.test.js', 'test/auth-account-sqlite-fallback.test.js',
  'test/permission-role-sqlite-fallback.test.js', 'test/discord-review-sqlite.test.js'], 'tests.log');
const runtime = await run(['test/support/v2-identity/runtime-check.mjs'], 'runtime.log', { NB_V2_IDENTITY_ENABLED: '1' });
const hashes = {};
for (const directory of ['server/v2/identity', 'test/support/v2-identity']) for (const name of await readdir(path.join(root, directory))) {
  const file = `${directory}/${name}`; hashes[file] = createHash('sha256').update(await readFile(path.join(root, file))).digest('hex');
}
for (const file of ['server/api.js', 'server/permissions.js', 'server/kook-steam-openid.js', 'server/discord-member-application-routes.js',
  'test/v2-identity.test.js', 'test/v2-identity-http.test.js', 'test/v2-steam-proof.test.js', 'test/permissions.test.js']) {
  hashes[file] = createHash('sha256').update(await readFile(path.join(root, file))).digest('hex');
}
const manifest = { recordedAt: new Date().toISOString(), runDir, node: process.version,
  gitHead: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(), tests, runtime, hashes,
  externalCredentials: false, network: 'loopback only; baseline network guard loaded in every child', mobileVerification: 'waived by user through coordinator' };
await writeFile(path.join(runDir, 'manifest.json'), JSON.stringify(manifest, null, 2));
console.log(JSON.stringify(manifest, null, 2)); process.exitCode = tests.code || runtime.code || 0;
