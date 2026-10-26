import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, realpath } from 'node:fs/promises';
import path from 'node:path';
import { root, runtimeBase, optionsFrom, runtimeEnvironment } from './config.mjs';

const options = optionsFrom(process.argv.slice(2));
if (await realpath(process.cwd()) !== await realpath(root)) throw new Error('START_FROM_PROJECT_ROOT');
await mkdir(runtimeBase, { recursive: true, mode: 0o700 });
if (await realpath(runtimeBase) !== runtimeBase) throw new Error('RUNTIME_DIRECTORY_SYMLINK_REJECTED');
const runDir = await mkdtemp(path.join(runtimeBase, 'runtime-'));
const child = spawn(process.execPath, ['test/support/v2-notification-runtime/app.mjs'], {
  cwd: root, env: runtimeEnvironment(runDir, options), stdio: 'inherit'
});
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => child.kill(signal));
child.once('error', () => { console.error('G06_RUNTIME_CHILD_FAILED'); process.exitCode = 1; });
child.once('exit', (code, signal) => { process.exitCode = code ?? (signal ? 1 : 0); });
