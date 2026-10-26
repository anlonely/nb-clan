import '../results.mjs';
import { spawn } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('../../../', import.meta.url));
const env = { PATH: process.env.PATH, LANG: 'en_US.UTF-8', TZ: 'UTC', NODE_ENV: 'test',
  NB_CHROMIUM_MAX_CONCURRENCY: '1', NB_DISABLE_BACKGROUND_JOBS: '1', NB_DISABLE_EXTERNAL_VITAL: '1', NB_DISABLE_EXTERNAL_ATLAS: '1' };
if (process.env.MANAGED_EXPORT_DEPENDENCY_ROOT) env.MANAGED_EXPORT_DEPENDENCY_ROOT = process.env.MANAGED_EXPORT_DEPENDENCY_ROOT;
if (process.env.PUPPETEER_EXECUTABLE_PATH) env.PUPPETEER_EXECUTABLE_PATH = process.env.PUPPETEER_EXECUTABLE_PATH;
const args = ['--import', './test/support/v2-managed-exports/offline.mjs', '--test', '--test-concurrency=1', '--test-reporter=tap',
  'test/v2-managed-exports.test.js', 'test/v2-stats.test.js', 'test/v2-stats-http.test.js', 'test/v2-stats-providers.test.js'];
const dir = new URL('../../../output/test-results/g07-managed-exports/', import.meta.url);
await mkdir(dir, { recursive: true });
const runs = [];
for (const [name, commandArgs, concurrency] of [
  ['tests', args, '1'],
  ['concurrency', [...args.slice(0, 5), 'test/v2-managed-exports-concurrency.test.js'], '2']
]) {
  const child = spawn(process.execPath, commandArgs, { cwd: root, env: { ...env, NB_CHROMIUM_MAX_CONCURRENCY: concurrency }, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  for (const stream of [child.stdout, child.stderr]) stream.on('data', data => { output += data; process.stdout.write(data); });
  const exit = await new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', (code, signal) => resolve({ code, signal })); });
  await writeFile(new URL(`${name}.tap`, dir), output);
  runs.push({ name, args: commandArgs, globalConcurrency: concurrency, ...exit });
  if (exit.code !== 0) { process.exitCode = exit.code ?? 1; break; }
}
await writeFile(new URL('test-run.json', dir), JSON.stringify({ at: new Date().toISOString(), node: process.version,
  runs, environmentKeys: Object.keys(env), realPlatforms: false }, null, 2) + '\n');
