// Launch the entire V2 entry with a fresh DB, real G03 sessions, controlled
// adapters, and loopback-only I/O. No .env or production runtime is imported.
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
await mkdir(path.join(root, 'test/support/v2-public-query/.runtime'), { recursive: true });
const run = await mkdtemp(path.join(root, 'test/support/v2-public-query/.runtime/run-'));
const env = { PATH: process.env.PATH, LANG: 'en_US.UTF-8', TZ: 'Asia/Shanghai', NODE_ENV: 'development',
  NB_DISABLE_BACKGROUND_JOBS: '1', NB_DISABLE_EXTERNAL_VITAL: '1', NB_DISABLE_EXTERNAL_ATLAS: '1',
  G07_PUBLIC_QUERY_RUN: run, ...(process.platform === 'darwin' ? { __CF_USER_TEXT_ENCODING: `0x${process.getuid().toString(16)}:0x0:0x0` } : {}),
  NODE_OPTIONS: `--import=${root}/test/support/v2-stats/resolve.mjs --import=${root}/test/support/v2-baseline/loopback-only.mjs` };
const child = spawn(process.execPath, ['test/support/v2-public-query/browser-runtime.mjs'], { cwd: root, env, stdio: 'inherit' });
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => child.kill(signal));
child.on('exit', code => { process.exitCode = code || 0; });
