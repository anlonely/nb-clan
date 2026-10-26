import './support/results.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { readFile, readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('../', import.meta.url));
test('real MemberAdmin HTTP to the same SyncCenter worker: Discord audit and stale-write fences', { timeout: 100000 }, async () => {
  const child = spawn(process.execPath, ['test/support/v2-departure-audit/run.mjs'], { cwd: root,
    env: { ...process.env, NB_DATA_DIR: '/must-not-use-inherited-data', NB_SQLITE_FILE: '/must-not-use-inherited.sqlite',
      NB_ROOT_PASSWORD: 'must-not-use-inherited-password', NB_DISCORD_BOT_TOKEN: 'must-not-use-inherited-discord-token', HTTPS_PROXY: 'http://127.0.0.1:9' } });
  let output = ''; child.stdout.on('data', d => { output += d; }); child.stderr.on('data', d => { output += d; });
  const code = await new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', resolve); });
  assert.equal(code, 0, output);
  const report = JSON.parse(await readFile(new URL('../output/test-results/g07-departure-audit/runtime-report.json', import.meta.url)));
  for (const name of ['real-G03-CSRF-GET-read-only-one-global-write-owner',
    'MemberAdmin-HTTP-single-worker-idempotency-dedup-canonical-role-names-cache-receipt', 'absent', 'wrong404', 'http401', 'http403', 'timeout',
    'missing-Discord-identity-skipped-no-I/O-no-unlink', 'in-flight-MemberAdmin-HTTP-cancel', 'guild-drift', 'role-config-drift', 'credential-drift',
    'Discord-identity-drift', 'queued-config-drift-fenced-before-network', 'stop-fences-canonical-and-drains-existing-owner']) assert.ok(report.checks.some(c => c.name === name && c.passed), name);
  assert.ok(report.checks.every(c => c.passed));
  assert.ok(report.requests.every(r => r.method === 'GET' && r.credentialMatched));
  for (const key of ['sqliteClosed', 'ownedRunRemoved', 'mainRuntimeStopped', 'mainHttpClosed', 'upstreamClosed']) assert.equal(report.cleanup[key], true, key);
  assert.equal(report.cleanup.integrity, 'ok'); assert.equal(report.cleanup.sourceActiveIO, 0);
  assert.equal(JSON.stringify(report).includes('explicit-isolated-fake-discord-bot-key'), false);
  assert.deepEqual(await readdir(new URL('./support/v2-departure-audit/.runtime/', import.meta.url)), []);
});
