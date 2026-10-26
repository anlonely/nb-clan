#!/usr/bin/env node
// Every test belongs to one group. `all` runs the same partition as CI.
import { readdir } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
const root = fileURLToPath(new URL('../', import.meta.url));
const groups = ['unit', 'core', 'integration', 'migration', 'browser', 'mini'];
const [group = 'all', ...options] = process.argv.slice(2);
if (!['all', ...groups].includes(group) || options.some(arg => arg !== '--list')) {
  console.error(`Usage: node scripts/test.mjs [all|${groups.join('|')}] [--list]`);
  process.exit(2);
}
const browser = new Set(['v2-managed-exports-concurrency.test.js', 'v2-managed-exports.test.js', 'v2-source-providers.test.js', 'v2-source-providers-binding.test.js',
  'v2-provider-projection.test.js', 'v2-candidate-providers-vip.test.js']);
const suites = Object.fromEntries(groups.map(name => [name, []]));
for (const name of (await readdir(path.join(root, 'test'))).filter(name => name.endsWith('.test.js')).sort()) {
  let owner;
  if (browser.has(name)) owner = 'browser';
  else if (/wechat|mini-/.test(name)) owner = 'mini';
  else if (/migrat|schema|index-upgrade/.test(name)) owner = 'migration';
  else if (/http|runtime|entry|integration|host|worker|api-workflow|graceful|source-main|risk-collector|departure-audit|candidate|production/.test(name)) owner = 'integration';
  else owner = name.startsWith('v2-') ? 'core' : 'unit';
  suites[owner].push(`test/${name}`);
}
suites.core.push('server/v2/identity/access-policy.test.js');
const chosen = group === 'all' ? groups : [group];
for (const name of chosen) {
  const files = suites[name];
  console.log(`${name}: ${files.length} test files`);
  if (options.includes('--list')) { console.log(files.join('\n')); continue; }
  if (name === 'integration') {
    console.log('Building production assets before runtime integration checks');
    const build = spawn(process.execPath, [path.join(root, 'node_modules/vite/bin/vite.js'), 'build'], { cwd: root, stdio: 'inherit', env: { ...process.env } });
    const code = await new Promise((resolve, reject) => { build.once('error', reject); build.once('exit', code => resolve(code ?? 1)); });
    if (code) { process.exitCode = code; break; }
  }
  // The guard blocks non-loopback sockets in the runner and is inherited by test
  // children through Node's preload arguments. Fixtures own their temporary DBs.
  const child = spawn(process.execPath, ['--import', './test/support/v2-baseline/loopback-only.mjs',
    '--test', '--test-timeout=120000', '--test-concurrency=1', ...files], { cwd: root, stdio: 'inherit', env: { ...process.env } });
  const code = await new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', code => resolve(code ?? 1)); });
  if (code) { process.exitCode = code; break; }
}
