import { spawn, execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, writeFile, readdir } from 'node:fs/promises';
import { createHash, randomBytes } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
await mkdir(path.join(root, 'work/v2-scheduling'), { recursive: true });
const runDir = await mkdtemp(path.join(root, 'work/v2-scheduling/run-'));
// No inherited cloud, platform, proxy, production path or credential variables.
const env = {
  PATH: process.env.PATH, LANG: 'en_US.UTF-8', TZ: 'Asia/Shanghai', NODE_ENV: 'production',
  NB_DATA_DIR: path.join(runDir, 'data'), NB_SQLITE_FILE: path.join(runDir, 'data/nb-clan.sqlite'),
  NB_STORAGE_MODE: 'sqlite-primary', NB_V2_IDENTITY_ENABLED: '1', NB_V2_PUBLIC_ORIGIN: 'http://127.0.0.1:1',
  NB_DISABLE_BACKGROUND_JOBS: '1', NB_DISABLE_EXTERNAL_VITAL: '1', NB_DISABLE_EXTERNAL_ATLAS: '1',
  NB_RUSTPLUS_RELAY_CHAT_FLUSH_INTERVAL_MS: '0', NB_ROOT_PASSWORD: randomBytes(32).toString('base64url'),
  NODE_OPTIONS: `--import=${path.join(root, 'test/support/v2-baseline/loopback-only.mjs')}`, G04_RUN_DIR: runDir
};
const stages = [];
async function run(args, log, extraEnv = {}) {
  const startedAt = new Date().toISOString();
  return new Promise(resolve => {
    const child = spawn(process.execPath, args, { cwd: root, env: { ...env, ...extraEnv }, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '', spawnError = null;
    child.stdout.on('data', chunk => output += chunk);
    child.stderr.on('data', chunk => output += chunk);
    child.on('error', error => { spawnError = error.message; output += `${error.stack}\n`; });
    child.on('close', async (code, signal) => {
      await writeFile(path.join(runDir, log), output);
      const stage = { args, startedAt, finishedAt: new Date().toISOString(), code: code ?? 1, signal, log,
        v2IdentityEnabled: (extraEnv.NB_V2_IDENTITY_ENABLED ?? env.NB_V2_IDENTITY_ENABLED) === '1',
        ...(spawnError ? { spawnError } : {}) };
      stages.push(stage); console.log(`${log}: exit ${stage.code}`); resolve(stage);
    });
  });
}
const schedulingTests = (await readdir(path.join(root, 'test'))).filter(name => /^v2-scheduling.*\.test\.js$/.test(name))
  .sort().map(name => `test/${name}`);
if (!schedulingTests.length) throw new Error('G04 scheduling tests are missing');
await run(['--test', ...schedulingTests], 'scheduling-tests.log');
await run(['test/support/v2-scheduling/runtime-check.mjs'], 'runtime.log', {
  NB_DATA_DIR: path.join(runDir, 'runtime-data'), NB_SQLITE_FILE: path.join(runDir, 'runtime-data/nb-clan.sqlite')
});
await run(['--test', 'test/v2-identity.test.js', 'test/v2-identity-http.test.js', 'test/v2-steam-proof.test.js'], 'identity-tests.log');
// These regression tests intentionally exercise the pre-V2 rollout mode. The
// real G04 runtime above separately verifies that legacy cookies are disabled.
await run(['--test', 'test/permissions.test.js', 'test/security-permissions.test.js', 'test/auth-account-sqlite-fallback.test.js',
  'test/permission-role-sqlite-fallback.test.js', 'test/discord-review-sqlite.test.js'], 'legacy-compatibility-tests.log', {
  NB_V2_IDENTITY_ENABLED: '0'
});
await run(['node_modules/vite/bin/vite.js', 'build', '--outDir', path.join(runDir, 'build')], 'build.log');
const buildArtifacts = [];
async function recordBuild(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) await recordBuild(file);
    else if (entry.isFile()) { const bytes = await readFile(file); buildArtifacts.push({ path: path.relative(path.join(runDir, 'build'), file), bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') }); }
  }
}
if (stages.at(-1).code === 0) await recordBuild(path.join(runDir, 'build'));
await writeFile(path.join(runDir, 'build-artifacts.json'), JSON.stringify(buildArtifacts, null, 2));
const hashes = {};
async function hashDirectory(directory) {
  for (const entry of await readdir(path.join(root, directory), { withFileTypes: true })) {
    const file = `${directory}/${entry.name}`;
    if (entry.isDirectory()) await hashDirectory(file);
    else if (entry.isFile()) hashes[file] = createHash('sha256').update(await readFile(path.join(root, file))).digest('hex');
  }
}
await hashDirectory('server/v2/scheduling'); await hashDirectory('test/support/v2-scheduling');
for (const file of [...schedulingTests, 'server/api.js', 'server/v2/identity/service.js',
  'server/v2/identity/repository.js', 'server/v2/identity/permissions.js']) {
  hashes[file] = createHash('sha256').update(await readFile(path.join(root, file))).digest('hex');
}
const artifacts = {};
for (const name of await readdir(runDir)) if (/\.(?:json|log)$/.test(name)) {
  artifacts[name] = createHash('sha256').update(await readFile(path.join(runDir, name))).digest('hex');
}
const manifest = {
  recordedAt: new Date().toISOString(), runDir, cwd: root, node: process.version,
  gitHead: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(),
  passed: stages.every(stage => stage.code === 0), stages, hashes, artifacts,
  environmentKeys: Object.keys(env).sort(), externalCredentials: false,
  network: 'Every child loads the loopback-only Node guard; only 127.0.0.1 ephemeral HTTP is used.',
  backgroundJobs: false, platformMessages: false,
  identityEvidence: 'Root uses the real local password route; member sessions and eligibility are controlled fixtures, not real OAuth.',
  mobileVerification: 'waived by user through coordinator',
  browserVerification: 'No UI changes in G04; HTTP and domain tests do not claim rendered UI acceptance.'
};
await writeFile(path.join(runDir, 'manifest.json'), JSON.stringify(manifest, null, 2));
console.log(JSON.stringify(manifest, null, 2));
process.exitCode = manifest.passed ? 0 : 1;
