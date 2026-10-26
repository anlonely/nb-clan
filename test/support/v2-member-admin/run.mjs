import { mkdtemp, mkdir } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const parent = path.join(root, 'test/support/v2-member-admin/.runs');
await mkdir(parent, {
  recursive: true
});
const runDir = await mkdtemp(path.join(parent, 'run-'));
const mode = process.argv.includes('--verify') ? 'verify' : 'serve';
const env = {
  PATH: process.env.PATH || '/usr/bin:/bin',
  LANG: 'en_US.UTF-8',
  TZ: 'Asia/Shanghai',
  NODE_ENV: 'production',
  NB_DATA_DIR: path.join(runDir, 'data'),
  NB_SQLITE_FILE: path.join(runDir, 'data/fixture.sqlite'),
  NB_STORAGE_MODE: 'sqlite-primary',
  NB_DISABLE_BACKGROUND_JOBS: '1',
  NB_DISABLE_EXTERNAL_VITAL: '1',
  NB_DISABLE_EXTERNAL_ATLAS: '1',
  NB_V2_IDENTITY_ENABLED: '1',
  NODE_OPTIONS: `--import=${path.join(root, 'test/support/v2-baseline/loopback-only.mjs')}`,
  G07_MEMBERS_RUN: runDir,
  G07_MEMBERS_MODE: mode,
  ...(process.platform === 'darwin' ? {
    __CF_USER_TEXT_ENCODING: `0x${process.getuid().toString(16)}:0x0:0x0`
  } : {})
};
const child = spawn(process.execPath, [path.join(root, 'test/support/v2-member-admin/runtime.mjs')], {
  cwd: root,
  env,
  stdio: 'inherit'
});
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => child.kill(signal));
child.on('exit', code => process.exit(code ?? 1));
