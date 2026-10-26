import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { isSensitivePath, isPublicPath, scanFiles, scanText } from '../scripts/check-public-release.mjs';

const releaseTool = fileURLToPath(new URL('../scripts/release-public.mjs', import.meta.url));
test('release allowlist excludes state at any depth and retains env examples', () => {
  for (const file of ['server/.runtime/owner.json', 'src/.baseline-old/session.json', 'server/credentials/key.json', 'public/secrets/client.json', 'server/browser-profile-1/cookies.json', 'server/storageState.json', 'server/state.db-wal', 'server/state.sqlite-shm', 'test/root-credentials.txt', '.env.production', '.release-artifacts/report.json']) {
    assert.equal(isSensitivePath(file), true, file);
    assert.equal(isPublicPath(file), false, file);
  }
  assert.equal(isPublicPath('.env.example'), true);
  assert.equal(isPublicPath('src/v2/main.jsx'), true);
  assert.equal(isPublicPath('docs/v2-evidence/private.json'), false);
  assert.equal(isPublicPath('scripts/unreviewed-deploy.sh'), false);
  assert.equal(isPublicPath('dist/assets/app.js'), false);
  assert.equal(isPublicPath('dist/assets/app.js', true), true);
});

test('secret findings contain only locations and rule names', () => {
  const token = 'ghp_' + 'aB9x'.repeat(10);
  const findings = scanText('server/config.js', `const token = '${token}';`);
  assert.deepEqual(findings, [{ path: 'server/config.js', line: 1, rule: 'provider-token' }]);
  assert.equal(JSON.stringify(findings).includes(token), false);
  assert.equal(scanText('.env.example', 'API_KEY="your-api-key-here"').length, 0);
});

test('public export reads current files, refuses symlinks, and excludes history and unknown files', async t => {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'nb-release-test-'));
  t.after(() => fs.rm(temporary, { recursive: true, force: true }));
  const root = path.join(temporary, 'repository');
  await fs.mkdir(path.join(root, 'server'), { recursive: true });
  const git = (...args) => {
    const result = spawnSync('git', args, { cwd: root, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
  };
  git('init', '-q');
  await fs.writeFile(path.join(root, 'server/index.js'), 'old tracked content');
  git('add', 'server/index.js');
  await fs.writeFile(path.join(root, 'server/index.js'), 'current worktree content');
  await fs.writeFile(path.join(root, 'server/new.js'), 'new public source');
  await fs.writeFile(path.join(root, 'private-deployment.txt'), 'unknown file');
  await fs.writeFile(path.join(root, '.env'), 'private fixture');
  await fs.writeFile(path.join(root, '.env.example'), 'API_KEY=');
  await fs.mkdir(path.join(root, 'server/.runtime'));
  await fs.writeFile(path.join(root, 'server/.runtime/session.json'), 'private runtime');
  const output = path.join(temporary, 'public');
  const result = spawnSync(process.execPath, [releaseTool, '--root', root, '--output', output], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(await fs.readFile(path.join(output, 'server/index.js'), 'utf8'), 'current worktree content');
  assert.equal(await fs.readFile(path.join(output, 'server/new.js'), 'utf8'), 'new public source');
  for (const name of ['.git', '.env', 'private-deployment.txt', 'server/.runtime/session.json']) {
    await assert.rejects(fs.access(path.join(output, name)), { code: 'ENOENT' });
  }
  await fs.symlink(path.join(root, '.env'), path.join(root, 'server/leak.js'));
  const scan = await scanFiles(root, ['server/leak.js']);
  assert.deepEqual(scan.findings, [{ path: 'server/leak.js', line: 1, rule: 'symlink' }]);
  const denied = spawnSync(process.execPath, [releaseTool, '--root', root, '--output', path.join(temporary, 'denied')], { encoding: 'utf8' });
  assert.equal(denied.status, 1);
  await assert.rejects(fs.access(path.join(temporary, 'denied')), { code: 'ENOENT' });
});
