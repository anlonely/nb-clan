import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import path from 'node:path';
import { promisify } from 'node:util';
import test from 'node:test';

const execFileAsync = promisify(execFile);

test('serial member profile sync rechecks members that become due after the initial batch', async () => {
  const fixture = path.join(process.cwd(), 'scripts/member-profile-sync-child.mjs');
  await assert.doesNotReject(
    () => execFileAsync(process.execPath, [fixture], { timeout: 30_000 })
  );
});
