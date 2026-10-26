import { spawn } from 'node:child_process';
import { mkdir, mkdtemp } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
await mkdir(path.join(root, 'test/support/v2-stats/.runtime'), {
  recursive: true
});
const runDir = await mkdtemp(path.join(root, 'test/support/v2-stats/.runtime/run-'));
const env = {
  PATH: process.env.PATH,
  LANG: 'en_US.UTF-8',
  TZ: 'Asia/Shanghai',
  NODE_ENV: 'development',
  NB_DISABLE_BACKGROUND_JOBS: '1',
  NB_DISABLE_EXTERNAL_VITAL: '1',
  NB_DISABLE_EXTERNAL_ATLAS: '1',
  G07_STATS_RUN: runDir,
  ...(process.platform === 'darwin' ? {
    __CF_USER_TEXT_ENCODING: `0x${process.getuid().toString(16)}:0x0:0x0`
  } : {}),
  NODE_OPTIONS: `--import=${root}/test/support/v2-stats/resolve.mjs --import=${root}/test/support/v2-baseline/loopback-only.mjs`
};
const child = spawn(process.execPath, ['test/support/v2-stats/runtime.mjs'], {
  cwd: root,
  env,
  stdio: 'inherit'
});
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => child.kill(sig));
child.on('exit', code => process.exitCode = code || 0);
