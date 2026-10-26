import '../results.mjs';
// Execute the already delivered real-HTTP departure harness with only output/runtime paths redirected.
// Do not overwrite the previous goal's report or baseline artifacts.
import { readFile, writeFile, unlink } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { randomUUID, createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
const root = fileURLToPath(new URL('../../../', import.meta.url));
const original = await readFile(new URL('../v2-departure-audit/run.mjs', import.meta.url), 'utf8');
const redirected = original.replace('test/support/v2-departure-audit/.runtime', 'test/support/v2-risk-collector/.runtime-departure')
  .replace('output/test-results/g07-departure-audit/runtime-report.json', 'output/test-results/g07-risk-collector/departure-regression.json');
assert.notEqual(original, redirected);
const entry = new URL(`.departure-check-${randomUUID()}.mjs`, import.meta.url);
await writeFile(entry, redirected);
try {
  const child = spawn(process.execPath, [fileURLToPath(entry)], { cwd: root, stdio: 'inherit' });
  const code = await new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', resolve); });
  assert.equal(code, 0);
  const path = new URL('../../../output/test-results/g07-risk-collector/departure-regression.json', import.meta.url);
  const report = JSON.parse(await readFile(path));
  report.harness = { originalSha256: createHash('sha256').update(original).digest('hex'), changes: 'only owned runtime/output paths', oldGoalArtifactModified: false };
  await writeFile(path, `${JSON.stringify(report, null, 2)}\n`);
} finally { await unlink(entry); }
