import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, realpath } from 'node:fs/promises';
import path from 'node:path';
import { root, optionsFrom, runtimeEnvironment } from './config.mjs';

const options = optionsFrom(process.argv.slice(2));
if (await realpath(process.cwd()) !== await realpath(root)) throw new Error(`Start from the G05 worktree: ${root}`);
const base = path.join(root, 'work/g05');
await mkdir(base, { recursive: true, mode: 0o700 });
if (await realpath(base) !== base) throw new Error('Runtime data directory must not be a symlink');
const runDir = await mkdtemp(path.join(base, 'runtime-'));
const child = spawn(process.execPath, ['test/support/v2-member-space/runtime.mjs'], {
  cwd: root, env: runtimeEnvironment(runDir, options), stdio: 'inherit'
});
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => child.kill(signal));
child.once('error', error => { console.error(error); process.exitCode = 1; });
child.once('exit', (code, signal) => { process.exitCode = code ?? (signal ? 1 : 0); });
