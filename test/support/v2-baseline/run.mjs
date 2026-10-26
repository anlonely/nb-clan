import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { fixture, cursorFixture } from './fixtures.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const work = path.join(root, 'work/v2-g01');
await mkdir(work, { recursive: true });
const runDir = await mkdtemp(path.join(work, 'run-'));
const env = {
  PATH: process.env.PATH, LANG: 'en_US.UTF-8', TZ: 'Asia/Shanghai', NODE_ENV: 'production',
  NB_DATA_DIR: path.join(runDir, 'data'), NB_SQLITE_FILE: path.join(runDir, 'data/nb-clan.sqlite'),
  NB_STORAGE_MODE: 'sqlite-primary', NB_DISABLE_BACKGROUND_JOBS: '1',
  NB_DISABLE_EXTERNAL_VITAL: '1', NB_DISABLE_EXTERNAL_ATLAS: '1',
  NB_RUSTPLUS_RELAY_CHAT_FLUSH_INTERVAL_MS: '0', NB_ROOT_PASSWORD: 'G01-Isolated-Only-2026!',
  NODE_OPTIONS: `--import=${path.join(root, 'test/support/v2-baseline/loopback-only.mjs')}`,
  G01_RUN_DIR: runDir
};
async function command(name, args, filename, cwd = root, commandEnv = env) {
  const begin = Date.now();
  return new Promise((resolve, reject) => {
    const child = spawn(name, args, { cwd, env: commandEnv, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    child.stdout.on('data', x => { output += x; });
    child.stderr.on('data', x => { output += x; });
    child.on('error', reject);
    child.on('close', async code => {
      await writeFile(path.join(runDir, filename), output);
      resolve({ command: [name, ...args], code, elapsedMs: Date.now() - begin, log: filename });
    });
  });
}
const s1 = fixture(1), s5 = fixture(5);
assert.deepEqual(fixture(1).manifest, s1.manifest);
assert.deepEqual(fixture(5).manifest, s5.manifest);
await writeFile(path.join(runDir, 's1.json'), JSON.stringify(s1.data));
await writeFile(path.join(runDir, 's5.json'), JSON.stringify(s5.data));
const cursor = [];
for (const kind of ['chat', 'audit']) {
  const h = createHash('sha256');
  const { createWriteStream } = await import('node:fs');
  const { once } = await import('node:events');
  const stream = createWriteStream(path.join(runDir, `${kind}-100k.ndjson`));
  let count = 0, bytes = 0;
  for (const row of cursorFixture(kind)) {
    const line = `${JSON.stringify(row)}\n`;
    h.update(line); bytes += Buffer.byteLength(line); count++;
    if (!stream.write(line)) await once(stream, 'drain');
  }
  stream.end(); await once(stream, 'finish');
  cursor.push({ kind, count, bytes, sha256: h.digest('hex'), loadedIntoApp: false });
}
const tests = [
  'permissions', 'wipe-schedule', 'wipe-timezone', 'sync-job-state-machine',
  'member-store-sqlite-fallback', 'operation-runs', 'frontend-concurrency',
  'integration-message-refs'
].map(n => `test/${n}.test.js`);
// Existing tests own their temporary data directories and storage modes.
// Never force a shared SQLite file or a different mode into those test fixtures.
const testEnv = { ...env, NB_DATA_DIR: path.join(runDir, 'test-default'), NB_STORAGE_MODE: 'json' };
delete testEnv.NB_SQLITE_FILE;
const testResult = await command(process.execPath, ['--test', '--test-reporter=tap', '--test-concurrency=1', ...tests], 'tests.tap', root, testEnv);
console.log(JSON.stringify({ tests: testResult.code, runDir }));
const runtime = await command(process.execPath, [path.join(root, 'test/support/v2-baseline/runtime.mjs')], 'runtime.log');
const scriptHashes = {};
for (const name of ['run.mjs', 'runtime.mjs', 'fixtures.mjs', 'loopback-only.mjs']) {
  scriptHashes[name] = createHash('sha256').update(await readFile(path.join(root, 'test/support/v2-baseline', name))).digest('hex');
}
const dependencies = {};
for (const name of ['react', 'react-dom', 'vite', 'express', 'puppeteer-core']) {
  dependencies[name] = JSON.parse(await readFile(path.join(root, 'node_modules', name, 'package.json'))).version;
}
const manifest = {
  recordedAt: new Date().toISOString(), runDir,
  gitHead: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, env, encoding: 'utf8' }).trim(),
  businessDiffSha256: createHash('sha256').update(execFileSync('git', ['diff', 'HEAD', '--', 'src', 'server', 'public', 'package.json', 'package-lock.json', 'vite.config.js'], { cwd: root, env })).digest('hex'),
  scriptHashes, dependencies,
  machine: { platform: os.platform(), release: os.release(), arch: os.arch(), cpu: os.cpus()[0]?.model, logicalCpu: os.cpus().length, ramBytes: os.totalmem(), node: process.version },
  network: { api: 'loopback; no throttling; sequential smoke only', browser: 'loopback; no throttling; external requests aborted', externalCredentials: false },
  fixtures: [s1.manifest, s5.manifest], cursor, tests: testResult, runtime,
  lockSha256: createHash('sha256').update(await readFile(path.join(root, 'package-lock.json'))).digest('hex')
};
await writeFile(path.join(runDir, 'manifest.json'), JSON.stringify(manifest, null, 2));
console.log(JSON.stringify(manifest, null, 2));
process.exitCode = testResult.code || runtime.code || 0;
