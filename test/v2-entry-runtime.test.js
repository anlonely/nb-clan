import { authenticatedSession } from './support/authenticated-session.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, copyFile, readdir, symlink, rm } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { createServer } from 'node:http';
import express from 'express';
import { installIdentitySchema, IdentityRepository } from '../server/v2/identity/repository.js';
import { applyIdentityMigration, planIdentityMigration } from '../server/v2/identity/migration.js';
import { IdentityService } from '../server/v2/identity/service.js';
import { createIdentityRouter } from '../server/v2/identity/routes.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
test('actual server entry serves deep links beneath a hidden worktree and drains SIGTERM', async t => {
  const area = await mkdtemp(path.join(tmpdir(), 'nb-v2-entry-'));
  const candidate = path.join(area, '.hidden-worktree');
  await mkdir(path.join(candidate, 'server'), { recursive: true });
  await mkdir(path.join(candidate, 'dist'));
  await writeFile(path.join(candidate, 'package.json'), '{"type":"module"}');
  await writeFile(path.join(candidate, 'dist/index.html'), '<!doctype html><title>isolated-entry-marker</title>');
  await symlink(path.join(root, 'node_modules'), path.join(candidate, 'node_modules'));
  // Copy the unmodified entry under the path that previously triggered sendFile's
  // dotfile denial; its actual dependencies remain the real working-tree modules.
  await copyFile(path.join(root, 'server/index.js'), path.join(candidate, 'server/index.js'));
  for (const name of await readdir(path.join(root, 'server'))) if (name !== 'index.js')
    await symlink(path.join(root, 'server', name), path.join(candidate, 'server', name));
  let output = '';
  const child = spawn(process.execPath, ['server/index.js'], { cwd: candidate,
    env: { PATH: process.env.PATH, LANG: 'en_US.UTF-8', TZ: 'Asia/Shanghai', NODE_ENV: 'production',
      PORT: '0', NB_BIND_HOST: '127.0.0.1', NB_DATA_DIR: path.join(area, 'data'), NB_STORAGE_MODE: 'json',
      NB_ROOT_PASSWORD: randomBytes(32).toString('base64url'), NB_DISABLE_BACKGROUND_JOBS: '1',
      NB_DISABLE_DATA_BACKUP: '1', NB_DISABLE_EXTERNAL_VITAL: '1', NB_DISABLE_EXTERNAL_ATLAS: '1',
      NB_RUSTPLUS_RELAY_CHAT_FLUSH_INTERVAL_MS: '0', NB_SHUTDOWN_GRACE_MS: '3000',
      NODE_OPTIONS: `--import=${path.join(root, 'test/support/v2-baseline/loopback-only.mjs')}` },
    stdio: ['ignore', 'pipe', 'pipe'] });
  const exit = new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', (code, signal) => resolve({ code, signal })); });
  child.stdout.on('data', chunk => output += chunk); child.stderr.on('data', chunk => output += chunk);
  t.after(async () => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); await exit; await rm(area, { recursive: true, force: true }); });
  const port = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => { cleanup(); reject(new Error('Isolated entry did not start')); }, 15_000);
    const inspect = () => { const match = output.match(/NB Clan API listening on http:\/\/127\.0\.0\.1:(\d+)/); if (match) { cleanup(); resolve(Number(match[1])); } };
    const cleanup = () => { clearTimeout(timer); child.stdout.off('data', inspect); };
    child.stdout.on('data', inspect); inspect();
    exit.then(() => { cleanup(); reject(new Error('Entry exited before listening')); });
  });
  for (const route of ['/admin/wipes', '/app/wipes/a?tab=plan', '/login?returnTo=%2Fadmin%2Fwipes']) {
    const response = await fetch(`http://127.0.0.1:${port}${route}`);
    assert.equal(response.status, 200, route);
    assert.equal(response.headers.get('cache-control'), 'no-cache');
    assert.equal(response.headers.get('x-frame-options'), 'SAMEORIGIN');
    assert.match(response.headers.get('content-security-policy'), /frame-ancestors 'self'/);
    assert.match(await response.text(), /isolated-entry-marker/);
  }
  const ready = await fetch(`http://127.0.0.1:${port}/api/readyz`);
  assert.equal(ready.status, 200);
  for (const cookie of ['theme=%', 'theme=%E0%A4%A', 'nb_session=%', 'nb_wechat_session=%']) {
    const withCookie = await fetch(`http://127.0.0.1:${port}/api/readyz`, { headers: { cookie } });
    assert.equal(withCookie.status, 200, 'legacy session parsers must not break API routing for malformed cookies');
  }
  child.kill('SIGTERM');
  let deadline;
  const result = await Promise.race([exit, new Promise((_, reject) => { deadline = setTimeout(() => reject(new Error('Shutdown did not drain')), 5000); })]).finally(() => clearTimeout(deadline));
  assert.deepEqual(result, { code: 0, signal: null });
  assert.match(output, /shutdown complete/);
});

test('identity event shutdown waits for an in-flight eligibility read before SQLite can close', async t => {
  const db = new DatabaseSync(':memory:'); installIdentitySchema(db);
  const repo = new IdentityRepository(db); applyIdentityMigration(repo, planIdentityMigration({}));
  for (const policy of repo.all('policies')) repo.put('policies', { ...policy, enabled: true, guildId: 'local-guild', allowedRoleIds: ['local-role'] });
  const account = { id: 'local-admin', memberId: null, status: 'active', revision: 1, permissionVersion: 1, grants: [] };
  repo.put('accounts', account);
  let release, started, calls = 0;
  const gate = new Promise(resolve => { release = resolve; }), refreshStarted = new Promise(resolve => { started = resolve; });
  const providers = { discord: { async roles(externalId, guildId) {
    if (++calls > 1) { started(); await gate; }
    return { externalId, guildId, roleIds: ['local-role'] };
  } } };
  const identity = new IdentityService(repo, { providers });
  const session = await authenticatedSession(identity, account.id);
  const eligibility = repo.all('eligibility')[0];
  const app = express(), server = createServer(app);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const router = createIdentityRouter({ service: identity, origin, providers });
  app.use('/api/v2', router);
  t.after(async () => { release(); await router.stopEvents(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); db.close(); });
  repo.put('eligibility', { ...repo.get('eligibility', eligibility.id), expiresAt: new Date(Date.now() + 100).toISOString() });
  const response = await fetch(`${origin}/api/v2/auth/events`, { headers: { cookie: `nb_v2_session=${session.token}` } });
  assert.equal(response.status, 200); const reader = response.body.getReader();
  assert.match(new TextDecoder().decode((await reader.read()).value), /event: ready/);
  let deadline;
  await Promise.race([refreshStarted, new Promise((_, reject) => { deadline = setTimeout(() => reject(new Error('Eligibility timer never started')), 2000); })]).finally(() => clearTimeout(deadline));
  let stopped = false; const drain = router.stopEvents().then(() => { stopped = true; });
  await new Promise(resolve => setTimeout(resolve, 20)); assert.equal(stopped, false);
  release(); await drain; assert.equal(stopped, true);
  assert.equal(db.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
  await reader.cancel();
});

test('disconnected initial identity stream authorization remains tracked until eligibility settles', async t => {
  const db = new DatabaseSync(':memory:'); installIdentitySchema(db);
  const repo = new IdentityRepository(db); applyIdentityMigration(repo, planIdentityMigration({}));
  for (const policy of repo.all('policies')) repo.put('policies', { ...policy, enabled: true, guildId: 'local-guild', allowedRoleIds: ['local-role'] });
  const account = { id: 'initial-handshake-account', memberId: null, status: 'active', revision: 1, permissionVersion: 1, grants: [] };
  repo.put('accounts', account);
  let release, started, calls = 0;
  const gate = new Promise(resolve => { release = resolve; }), refreshStarted = new Promise(resolve => { started = resolve; });
  const providers = { discord: { async roles(externalId, guildId) {
    if (++calls > 1) { started(); await gate; }
    return { externalId, guildId, roleIds: ['local-role'] };
  } } };
  const identity = new IdentityService(repo, { providers });
  const session = await authenticatedSession(identity, account.id);
  const eligibility = repo.all('eligibility')[0];
  repo.put('eligibility', { ...repo.get('eligibility', eligibility.id), expiresAt: new Date(0).toISOString() });
  const app = express(), server = createServer(app);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const router = createIdentityRouter({ service: identity, origin, providers }); app.use('/api/v2', router);
  t.after(async () => { release(); await router.stopEvents(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); db.close(); });
  const controller = new AbortController();
  const response = fetch(`${origin}/api/v2/auth/events`, { signal: controller.signal, headers: { cookie: `nb_v2_session=${session.token}` } }).catch(error => error);
  let deadline;
  await Promise.race([refreshStarted, new Promise((_, reject) => { deadline = setTimeout(() => reject(new Error('Initial role refresh never started')), 2000); })]).finally(() => clearTimeout(deadline));
  controller.abort(); await response;
  let stopped = false; const drain = router.stopEvents().then(() => { stopped = true; });
  await new Promise(resolve => setTimeout(resolve, 20)); assert.equal(stopped, false);
  release(); await drain; assert.equal(stopped, true);
  assert.equal(db.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
});
