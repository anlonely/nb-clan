import '../results.mjs';
import { spawn } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('../../../', import.meta.url)), evidence = new URL('../../../output/test-results/g07-platform-media/', import.meta.url);
await mkdir(evidence, { recursive: true });
const env = { PATH: process.env.PATH, LANG: 'en_US.UTF-8', TZ: 'UTC', NODE_ENV: 'test', NB_DISABLE_BACKGROUND_JOBS: '1',
  NB_DISABLE_EXTERNAL_VITAL: '1', NB_DISABLE_EXTERNAL_ATLAS: '1' };
if (process.env.PLATFORM_MEDIA_DEPENDENCY_ROOT) env.PLATFORM_MEDIA_DEPENDENCY_ROOT = process.env.PLATFORM_MEDIA_DEPENDENCY_ROOT;
const args = ['--import', './test/support/v2-platform-media/offline.mjs', '--test', '--test-concurrency=1', '--test-reporter=tap',
  'test/v2-platform-media.test.js', 'test/v2-platform-media-http.test.js', 'test/v2-identity.test.js', 'test/v2-identity-http.test.js',
  'test/v2-member-space.test.js', 'test/v2-member-space-http.test.js'];
const child = spawn(process.execPath, args, { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] });
let output = '';
for (const stream of [child.stdout, child.stderr]) stream.on('data', data => { output += data; process.stdout.write(data); });
const exit = await new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', (code, signal) => resolve({ code, signal })); });
await writeFile(new URL('tests.tap', evidence), output);
await writeFile(new URL('verification.json', evidence), JSON.stringify({ at: new Date().toISOString(), node: process.version,
  args, environmentKeys: Object.keys(env), ...exit, realPlatformCalls: false, realProviderAuthentication: false }, null, 2) + '\n');
process.exitCode = exit.code ?? 1;
