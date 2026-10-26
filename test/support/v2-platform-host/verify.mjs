import '../results.mjs';
import { spawn } from 'node:child_process';
import { readdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('../../../', import.meta.url));
const output = new URL('../../../output/test-results/g07-platform-host/', import.meta.url);
const env = { PATH: process.env.PATH || '/usr/bin:/bin', LANG: 'en_US.UTF-8', TZ: 'Asia/Shanghai', NODE_ENV: 'test',
  NB_DISABLE_BACKGROUND_JOBS: '1', NB_DISABLE_EXTERNAL_VITAL: '1', NB_DISABLE_EXTERNAL_ATLAS: '1',
  NB_RUSTPLUS_RELAY_CHAT_FLUSH_INTERVAL_MS: '0', NODE_OPTIONS: `--import=${root}test/support/v2-baseline/loopback-only.mjs` };
const own = (await readdir(new URL('../../../test/', import.meta.url))).filter(name => /^v2-platform-host.*\.test\.js$/.test(name)).sort().map(name => `test/${name}`);
const regression = ['identity', 'identity-http', 'scheduling', 'scheduling-adapters', 'scheduling-eligibility', 'member-space',
  'member-space-http', 'sync-center', 'stats', 'stats-http', 'notification-platforms-transport', 'notification-platforms-native-callbacks',
  'platform-admin', 'platform-admin-http', 'platform-admin-community', 'platform-admin-migration'].map(name => `test/v2-${name}.test.js`);
async function run(files, name) {
  const args = ['--test', '--test-reporter=tap', '--test-timeout=30000', ...files];
  const child = spawn(process.execPath, args, { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] });
  let text = ''; child.stdout.on('data', chunk => { text += chunk; }); child.stderr.on('data', chunk => { text += chunk; });
  const exitCode = await new Promise((resolve, reject) => { child.on('error', reject); child.on('exit', resolve); });
  await writeFile(new URL(name, output), text);
  const result = { command: [process.execPath, ...args], exitCode, tests: Number(/# tests (\d+)/.exec(text)?.[1]),
    pass: Number(/# pass (\d+)/.exec(text)?.[1]), fail: Number(/# fail (\d+)/.exec(text)?.[1]) };
  console.log(JSON.stringify({ name, ...result }));
  if (exitCode !== 0) throw new Error(`Verification failed: ${name}`);
  return result;
}
const tests = await run(own, 'tests.tap'), regressions = await run(regression, 'regression.tap');
await writeFile(new URL('verification.json', output), JSON.stringify({ at: new Date().toISOString(), node: process.version,
  platform: process.platform, arch: process.arch, loopbackGuard: 'test/support/v2-baseline/loopback-only.mjs', environmentKeys: Object.keys(env),
  productionCredentials: false, automaticForwarding: false, newHttpServersClosed: true, sharedDbLeftOpenByHost: true,
  tests, regressions, evidenceLevel: 'isolated SQLite/HTTP/native-transport protocol; no live WeChat/Discord/KOOK authentication or production claims' }, null, 2) + '\n');
