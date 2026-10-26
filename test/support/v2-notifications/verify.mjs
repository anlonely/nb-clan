import '../results.mjs';
import { spawnSync } from 'node:child_process';
import { readdirSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const output = join(root, 'output/test-results/g06-b');
mkdirSync(output, { recursive: true });
const guard = join(root, 'test/support/v2-baseline/loopback-only.mjs');
const env = { PATH: dirname(process.execPath), NODE_ENV: 'test', NB_DISABLE_BACKGROUND_JOBS: '1', TZ: 'UTC', TMPDIR: '/tmp' };
const sets = [
  ['notifications.tap', /^v2-notifications-.*\.test\.js$/],
  ['identity-scheduling-regressions.tap', /^v2-(identity(?:-http)?|scheduling(?:-[^.]+)?)\.test\.js$/],
];
const results = [];
for (const [file, pattern] of sets) {
  const tests = readdirSync(join(root, 'test')).filter(name => pattern.test(name)).sort().map(name => `test/${name}`);
  const args = ['--import', guard, '--test', '--test-reporter=tap', ...tests];
  const result = spawnSync(process.execPath, args, { cwd: root, env, encoding: 'utf8', timeout: 120000, maxBuffer: 20 * 1024 * 1024 });
  const raw = result.stdout + (result.stderr ? `\n${result.stderr}` : '');
  writeFileSync(join(output, file), raw);
  const summary = { file, exitCode: result.status, tests: Number(raw.match(/^# tests (\d+)$/m)?.[1] || 0),
    passed: Number(raw.match(/^# pass (\d+)$/m)?.[1] || 0), failed: Number(raw.match(/^# fail (\d+)$/m)?.[1] || 0), files: tests };
  results.push(summary);
  console.log(JSON.stringify(summary));
  if (result.status !== 0) { process.exitCode = 1; break; }
}
writeFileSync(join(output, 'verification.json'), JSON.stringify({
  schemaVersion: 1, nodeVersion: process.version, platform: process.platform, architecture: process.arch,
  environmentKeys: Object.keys(env), loopbackGuard: 'test/support/v2-baseline/loopback-only.mjs',
  database: 'new temporary SQLite only; no real .env or credentials',
  transport: 'injected deterministic C adapter substitute, no external platform network',
  browser: 'not run by B; no UI changes', createApiRouter: 'not integrated by B; root integration required', results,
}, null, 2) + '\n');
