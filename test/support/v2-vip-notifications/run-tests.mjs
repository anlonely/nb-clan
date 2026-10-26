import '../results.mjs';
import { spawnSync } from 'node:child_process';
import { existsSync, lstatSync, readdirSync, readlinkSync, realpathSync, symlinkSync, unlinkSync, writeFileSync, chmodSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../../', import.meta.url)), modules = resolve(root, 'node_modules');
const fallback = decodeURIComponent(new URL('../../../node_modules', import.meta.url).pathname);
let linked = false;
try {
  // The existing G06 crash test deliberately strips its child's environment.
  // A temporary dependency link lets that unmodified test use the installed lockfile dependencies.
  if (!existsSync(modules)) {
    if (!existsSync(resolve(fallback, 'express/package.json'))) throw new Error('Installed fixture dependencies are required');
    symlinkSync(realpathSync(fallback), modules); linked = true;
  }
  const names = readdirSync(resolve(root, 'test'));
  const groups = [
    ['test-final.log', names.filter(n => /^v2-vip-notifications.*\.test\.js$/.test(n))],
    ['regressions-final.log', names.filter(n => /^(v2-member-admin|v2-member-adapters|v2-notifications-|v2-notification-platforms-|v2-notification-runtime\.|v2-member-inbox|v2-business-events\.)/.test(n) && n.endsWith('.test.js'))]
  ];
  for (const [log, files] of groups) {
    const args = ['--import', resolve(root, 'test/support/v2-baseline/loopback-only.mjs'), '--test', ...files.sort().map(n => `test/${n}`)];
    const run = spawnSync(process.execPath, args, { cwd: root, encoding: 'utf8', timeout: 60000, maxBuffer: 8 * 1024 * 1024,
      env: { PATH: process.env.PATH, NODE_NO_WARNINGS: '1', NODE_ENV: 'test', NB_DISABLE_BACKGROUND_JOBS: '1' } });
    const output = run.stdout + run.stderr;
    writeFileSync(resolve(root, 'output/test-results/g07-vip-notifications', log), output);
    chmodSync(resolve(root, 'output/test-results/g07-vip-notifications', log), 0o644);
    console.log(JSON.stringify({ log, exit: run.status, files: files.length, summary: output.split('\n').filter(line => /^ℹ (tests|pass|fail|duration)/.test(line)) }));
    if (run.status !== 0) throw new Error(`Verification failed: ${log}`);
  }
} finally {
  if (linked && lstatSync(modules).isSymbolicLink() && readlinkSync(modules) === realpathSync(fallback)) unlinkSync(modules);
}
