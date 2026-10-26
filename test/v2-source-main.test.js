import './support/results.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { readFile, readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('../', import.meta.url));
test('actual main HTTP source chain, immutable windows, canonical fences and drain', { timeout: 100000 }, async () => {
  const child = spawn(process.execPath, ['test/support/v2-source-main/run.mjs'], { cwd: root,
    env: { ...process.env, NB_DATA_DIR: '/must-not-use-inherited-data', NB_SQLITE_FILE: '/must-not-use-inherited.sqlite',
      NB_ROOT_PASSWORD: 'must-not-use-inherited-password', HTTPS_PROXY: 'http://127.0.0.1:9' } });
  let output = ''; child.stdout.on('data', data => { output += data; }); child.stderr.on('data', data => { output += data; });
  const code = await new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', resolve); });
  assert.equal(code, 0, output);
  const report = JSON.parse(await readFile(new URL('../output/test-results/g07-source-main/runtime-report.json', import.meta.url)));
  const required = ['real-G03-password-cookie-CSRF', 'real-HTTP-create-publish-start-confirm-past-server-start',
    'GET-coverage-unknown-no-window-or-canonical-write', 'main-HTTP-identity-real-match-parser-canonical-write',
    'POST-fixed-window-key-replay-active-dedup-pagination-overlap-clipping-open-session-canonical',
    'real-HTTP-stats-query-source-reader-missing-fields-unknown-read-only', 'in-flight-cancel-no-canonical-write',
    'in-flight-real-HTTP-server-config-change-no-canonical-write', 'stop-in-flight-no-write-drained-real-shared-queue',
    'one-existing-global-BM-queue-one-task-per-page-plus-drain-sentinel'];
  assert.deepEqual(report.checks.map(row => row.name), required);
  assert.ok(report.checks.every(row => row.passed));
  assert.equal(report.cleanup.sqliteClosed, true); assert.equal(report.cleanup.ownedRunRemoved, true);
  assert.equal(report.cleanup.mainRuntimeStopped, true); assert.equal(report.cleanup.mainHttpClosed, true);
  assert.equal(report.cleanup.upstreamClosed, true); assert.equal(report.cleanup.sourceActiveIO, 0);
  assert.equal(report.queue.running, false); assert.equal(report.queue.pendingCount, 0);
  assert.equal(report.windows.length, 4);
  assert.equal(report.successReceipt.operationId, `sync-item:${report.windows[0].jobId}:g05_alpha`);
  assert.ok(report.upstreamRequests.every(row => row.credentialMatched));
  assert.equal(JSON.stringify(report).includes('explicit-isolated-fake-battlemetrics-key'), false);
  assert.deepEqual(await readdir(new URL('./support/v2-source-main/.runtime/', import.meta.url)), []);
});
