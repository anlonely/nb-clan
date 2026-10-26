import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { candidateConfig, candidateEnvironment } from '../server/v2/candidate-host/config.js';

const root = fileURLToPath(new URL('../', import.meta.url));
for (const mode of ['client-stream', 'auth-stream', 'members-stream', 'incomplete-action']) test('candidate HTTP drain: ' + mode, { timeout: 20000 }, async () => {
  const parent = path.join(root, 'test/support/v2-candidate-sse-drain/.runtime');
  await fs.mkdir(parent, { recursive: true });
  const config = candidateConfig({ dataDirectory: path.join(parent, 'nb-v2-candidate-' + randomUUID()), port: 0, shutdownGraceMs: 1000 });
  const child = spawn(process.execPath, ['--import', path.join(root, 'test/support/v2-stats/resolve.mjs'), path.join(root, 'test/support/v2-candidate-sse-drain/verify.mjs'), mode, JSON.stringify(config)], {
    cwd: root, env: candidateEnvironment(config, { searchPath: process.env.PATH }), stdio: ['ignore', 'pipe', 'pipe']
  });
  let output = '';
  child.stdout.on('data', chunk => { output += chunk; });
  child.stderr.on('data', chunk => { output += chunk; });
  const timer = setTimeout(() => child.kill('SIGKILL'), 15000);
  try {
    const status = await new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', resolve); });
    assert.equal(status, 0, output);
  } finally { clearTimeout(timer); }
});
