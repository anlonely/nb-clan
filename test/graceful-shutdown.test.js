import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

function waitForListeningPort(child, output, timeoutMs = 20_000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Server did not start:\n${output.value}`)), timeoutMs);
    const inspect = () => {
      const match = output.value.match(/NB Clan API listening on http:\/\/127\.0\.0\.1:(\d+)/);
      if (!match) return;
      clearTimeout(timer);
      child.stdout.off('data', inspect);
      resolve(Number(match[1]));
    };
    child.stdout.on('data', inspect);
    inspect();
  });
}

function waitForExit(child, timeoutMs = 8_000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Server did not exit after SIGTERM')), timeoutMs);
    child.once('exit', (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal });
    });
  });
}

test('server handles SIGTERM by draining and exiting cleanly', async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'nb-clan-graceful-shutdown-'));
  const output = { value: '' };
  const child = spawn(process.execPath, ['server/index.js'], {
    cwd: path.resolve('.'),
    env: {
      ...process.env,
      PORT: '0',
      NB_BIND_HOST: '127.0.0.1',
      NB_DATA_DIR: dataDir,
      NB_ROOT_PASSWORD: 'RootPass123!',
      NB_STORAGE_MODE: 'json',
      NB_DISABLE_BACKGROUND_JOBS: '1',
      NB_DISABLE_DATA_BACKUP: '1',
      NB_DISABLE_EXTERNAL_VITAL: '1',
      NB_SHUTDOWN_GRACE_MS: '1000'
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (chunk) => { output.value += chunk; });
  child.stderr.on('data', (chunk) => { output.value += chunk; });

  try {
    const port = await waitForListeningPort(child, output);
    const readyResponse = await fetch(`http://127.0.0.1:${port}/api/readyz`);
    const readyPayload = await readyResponse.json();
    assert.equal(readyResponse.status, 200, JSON.stringify(readyPayload));
    assert.equal(readyPayload.ok, true);

    child.kill('SIGTERM');
    const exited = await waitForExit(child);
    assert.deepEqual(exited, { code: 0, signal: null }, output.value);
    assert.match(output.value, /SIGTERM received; draining connections/);
    assert.match(output.value, /shutdown complete/);
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    await rm(dataDir, { recursive: true, force: true });
  }
});
