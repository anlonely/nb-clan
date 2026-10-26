import './support/results.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { readFile, readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('../', import.meta.url));
test('real MemberAdmin HTTP to the same SyncCenter worker: complete risk collection, partial preservation and stale-write fences', { timeout: 100000 }, async () => {
  const child = spawn(process.execPath, ['test/support/v2-risk-collector/run.mjs'], { cwd: root,
    env: { ...process.env, NB_DATA_DIR: '/must-not-use-inherited-data', NB_SQLITE_FILE: '/must-not-use-inherited.sqlite',
      NB_ROOT_PASSWORD: 'must-not-use-inherited-password', NB_DISCORD_BOT_TOKEN: 'must-not-use-inherited-discord-token', HTTPS_PROXY: 'http://127.0.0.1:9' } });
  let output = ''; child.stdout.on('data', d => { output += d; }); child.stderr.on('data', d => { output += d; });
  const code = await new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', resolve); });
  assert.equal(code, 0, output);
  const report = JSON.parse(await readFile(new URL('../output/test-results/g07-risk-collector/runtime-report.json', import.meta.url)));
  for (const name of ['real-HTTP-G03-CSRF-MemberAdmin-single-worker-canonical-risk-DTO-cache-queue', 'partial-failure-keeps-old-risk-values-times-and-accountSignals-sync', 'explicit-private-preserves-risk-never-zero', 'missing-fields-preserve-values-not-false-zero', 'all-required-sources-failed-is-unknown-not-complete', 'explicit-known-false-and-zero-replace-old-risk', 'Steam-429-persists-existing-source-cooldown', 'disabled-rules-skip-bans-KDA-BM-prices-quality-only-required', 'missing-source-key-retains-observed-values', 'cancel-via-MemberAdmin-HTTP-no-write', 'Steam-identity-drift', 'BM-identity-drift', 'risk-rule-config-drift', 'Steam-credentials-drift', 'profile-revision-drift', 'squad-membership-drift', 'current-wipe-server-drift', 'task-scope-drift', 'legacy-profile-Steam-mismatch-never-relabel-risk', 'queued-config-drift-rejected-before-network', 'stop-drains-host-and-shared-BM-queue-without-write']) assert.ok(report.checks.some(c => c.name === name && c.passed), name);
  assert.ok(report.checks.every(c => c.passed));
  assert.ok(report.requests.every(r => r.method === 'GET' && r.credentialMatched));
  for (const key of ['sqliteClosed', 'ownedRunRemoved', 'mainRuntimeStopped', 'mainHttpClosed', 'upstreamClosed']) assert.equal(report.cleanup[key], true, key);
  assert.equal(report.firstCanonical.riskScan.quality, 'complete');
  assert.equal(report.privateEvidence.currentVisibility, 'private');
  assert.equal(report.privateEvidence.previousValue, 5);
  assert.ok(report.privateEvidence.currentRiskDto.alerts.some(r => r.type === 'inventory_value'));
  assert.equal(report.cleanup.integrity, 'ok'); assert.equal(report.cleanup.sourceActiveIO, 0);
  assert.equal(JSON.stringify(report).includes('explicit-isolated-fake-risk-source-key'), false);
  assert.deepEqual(await readdir(new URL('./support/v2-risk-collector/.runtime/', import.meta.url)), []);
});
