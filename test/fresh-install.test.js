import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { setup } from '../scripts/setup.mjs';
import { validateProductionReady } from '../server/v2/production/migrations.js';
import { assertLocalMode } from '../server/local-mode.js';

const hash = bytes => createHash('sha256').update(bytes).digest('hex');
async function fixture(t) {
  const parent = await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()), 'nb-fresh-install-'));
  t.after(() => fs.rm(parent, { recursive: true, force: true }));
  const dataDirectory = path.join(parent, 'data');
  return { dataDirectory, databaseFile: path.join(dataDirectory, 'nb-clan.sqlite'), parent };
}

test('fresh SQLite V2 install creates real root, owner and migration evidence; repeat preserves all bytes', async t => {
  const config = await fixture(t);
  assert.equal((await setup(config)).initialized, true);
  await validateProductionReady(config);
  const files = ['nb-clan.sqlite', 'root-credentials.txt', '.v2-production/owner.json'];
  const before = await Promise.all(files.map(file => fs.readFile(path.join(config.dataDirectory, file))));
  assert.equal((await setup(config)).initialized, false);
  const after = await Promise.all(files.map(file => fs.readFile(path.join(config.dataDirectory, file))));
  assert.deepEqual(after.map(hash), before.map(hash));
  const db = new DatabaseSync(config.databaseFile, { readOnly: true });
  t.after(() => db.close());
  const root = JSON.parse(db.prepare("SELECT payload_json FROM json_records WHERE collection='users' AND id='user_root'").get().payload_json);
  assert.match(root.passwordHash, /^scrypt\$/);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM json_records WHERE collection='v2Accounts'").get().n, 1);
  assert.equal((await fs.stat(config.dataDirectory)).mode & 0o777, 0o700);
  assert.equal((await fs.stat(path.join(config.dataDirectory, 'root-credentials.txt'))).mode & 0o777, 0o600);
});

test('setup refuses existing data, incomplete install and symlinks without rewriting them', async t => {
  const config = await fixture(t);
  await fs.mkdir(config.dataDirectory);
  const sentinel = path.join(config.dataDirectory, 'store.json');
  await fs.writeFile(sentinel, '{"users":[{"id":"existing"}]}');
  const before = await fs.readFile(sentinel);
  await assert.rejects(setup(config), /EXISTING_DATA_REQUIRES_EXPLICIT_MIGRATION/);
  assert.deepEqual(await fs.readFile(sentinel), before);
  assert.deepEqual(await fs.readdir(config.dataDirectory), ['store.json']);
  await fs.writeFile(path.join(config.dataDirectory, '.setup.lock'), '{}');
  await assert.rejects(setup(config), /SETUP_INCOMPLETE_OR_RUNNING/);
  const linked = path.join(config.parent, 'linked');
  await fs.symlink(config.dataDirectory, linked);
  await assert.rejects(setup({ dataDirectory: linked, databaseFile: path.join(linked, 'nb-clan.sqlite') }), /SYMLINK/);
});

test('local mode rejects public binds, proxies and wrong origins', () => {
  const env = { NB_LOCAL_MODE: '1', NB_V2_PUBLIC_ORIGIN: 'http://127.0.0.1:8787' };
  assert.equal(assertLocalMode(env), true);
  assert.equal(assertLocalMode({ ...env, NB_V2_PUBLIC_ORIGIN: 'http://127.0.0.1:5173' }), true);
  for (const override of [{ NB_BIND_HOST: '0.0.0.0' }, { NB_TRUST_PROXY: '1' }, { NB_V2_PUBLIC_ORIGIN: 'http://example.com:8787' }])
    assert.throws(() => assertLocalMode({ ...env, ...override }), /LOCAL_LOOPBACK_REQUIRED/);
});

async function runtimeSmoke(t, { local = true, development = false } = {}) {
  const config = await fixture(t);
  await setup(config);
  const { createServer } = await import('node:net');
  const probe = createServer(); probe.listen(0, '127.0.0.1'); await once(probe, 'listening');
  const port = probe.address().port; await new Promise(resolve => probe.close(resolve));
  const origin = `http://127.0.0.1:${port}`;
  const publicOrigin = local ? development ? 'http://127.0.0.1:5173' : origin : 'https://clan.example.test';
  const envFile = path.join(config.parent, '.env');
  await fs.writeFile(envFile, [
    'NB_STORAGE_MODE=sqlite-primary', 'NB_V2_PRODUCTION_ENABLED=1', 'NB_V2_IDENTITY_ENABLED=1',
    'NB_OWNER_PASSWORD_LOGIN=1', `NB_LOCAL_MODE=${local ? 1 : 0}`, 'NB_BIND_HOST=127.0.0.1', `PORT=${port}`,
    `NB_TRUST_PROXY=${local ? '0' : '127.0.0.1'}`, `NB_V2_PUBLIC_ORIGIN=${publicOrigin}`, `NB_DATA_DIR=${config.dataDirectory}`, 'NB_DISABLE_DATA_BACKUP=1',
    'NB_DISABLE_EXTERNAL_ATLAS=1', 'NB_DISABLE_EXTERNAL_VITAL=1'
  ].join('\n'), { mode: 0o600 });
  const doctor = spawnSync(process.execPath, ['scripts/doctor.mjs'], { cwd: new URL('..', import.meta.url),
    env: { PATH: process.env.PATH, NB_ENV_FILE: envFile }, encoding: 'utf8' });
  assert.equal(doctor.status, 0, doctor.stderr);
  assert.equal(JSON.parse(doctor.stdout).ok, true);
  const child = spawn(process.execPath, ['scripts/start.mjs', ...(development ? ['--dev'] : [])], { cwd: new URL('..', import.meta.url),
    env: { PATH: process.env.PATH, NB_ENV_FILE: envFile }, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  child.stdout.on('data', data => { output += data; }); child.stderr.on('data', data => { output += data; });
  const exited = once(child, 'exit');
  t.after(async () => {
    if (child.exitCode === null) child.kill('SIGTERM');
    await exited;
  });
  const { request: httpRequest } = await import('node:http');
  const request = (url, options = {}) => new Promise((resolve, reject) => {
    const request = httpRequest(url, { method: options.method || 'GET', headers: {
      ...(development ? { host: '127.0.0.1:5173' } : {}),
      ...(!local ? { host: 'clan.example.test', 'x-forwarded-proto': 'https' } : {}), ...options.headers
    } }, response => {
      const chunks = []; response.on('data', chunk => chunks.push(chunk));
      response.on('end', () => {
        const headers = new Headers();
        for (let index = 0; index < response.rawHeaders.length; index += 2) headers.append(response.rawHeaders[index], response.rawHeaders[index + 1]);
        resolve(new Response(Buffer.concat(chunks), { status: response.statusCode, headers }));
      });
    });
    request.on('error', reject); request.end(options.body);
  });
  let health;
  for (let i = 0; i < 200; i++) {
    if (child.exitCode !== null) assert.fail(`startup failed: ${output}`);
    try { health = await request(`${origin}/api/healthz`); if (health.ok) break; } catch {}
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  assert.equal(health?.status, 200, output);
  assert.equal((await request(`${origin}/api/readyz`)).status, 200);
  assert.equal((await (await request(`${origin}/api/workspace-entry`)).json()).defaultWorkspace, 'v2');
  const providers = await (await request(`${origin}/api/v2/auth/providers`)).json();
  assert.ok(providers.data, JSON.stringify(providers));
  assert.equal(providers.data.ownerPasswordLogin, true);
  assert.equal(providers.data.localMode, local);
  if (local) assert.equal(providers.data.providers.every(provider => !provider.enabled), true);
  else assert.equal(providers.data.providers.filter(provider => provider.provider !== 'steam').every(provider => !provider.configured), true);
  const credentials = await fs.readFile(path.join(config.dataDirectory, 'root-credentials.txt'), 'utf8');
  const password = credentials.match(/^password=(.+)$/m)[1];
  const login = (body, requestOrigin = publicOrigin) => request(`${origin}/api/v2/auth/owner-password`, {
    method: 'POST', headers: { origin: requestOrigin, 'content-type': 'application/json' }, body: JSON.stringify(body)
  });
  assert.equal((await login({ username: 'root', password }, 'https://other.example')).status, 403);
  assert.equal((await login({ username: 'root', password: 'incorrect' })).status, 401);
  assert.equal((await login({ username: 'other', password })).status, 401);
  const response = await login({ username: 'root', password });
  assert.equal(response.status, 200);
  const body = await response.json(); assert.equal(body.data.accountId, 'user_root');
  assert.equal(response.headers.getSetCookie().filter(value => value.startsWith('nb_v2_session=')).every(value => value.includes('; Secure')), !local);
  const cookie = response.headers.getSetCookie().map(value => value.split(';')[0]).join('; ');
  const me = await request(`${origin}/api/v2/auth/me`, { headers: { cookie } });
  assert.equal(me.status, 200);
  assert.equal((await me.json()).data.roleId, 'owner');
  if (development) {
    const source = await (await request(`${origin}/api/v2/source-admin/sources/steam`, { headers: { cookie } })).json();
    const mutation = { method: 'POST', headers: { cookie, origin: publicOrigin, 'content-type': 'application/json', 'x-csrf-token': body.data.csrfToken, 'Idempotency-Key': '9f726818-c010-4ac7-884d-cf1cf1cd8801' }, body: JSON.stringify({ input: { expectedRevision: source.data.revision, apiKey: 'synthetic-development-key' } }) };
    assert.equal((await request(`${origin}/api/v2/source-admin/commands/steam.save`, { ...mutation, headers: { ...mutation.headers, origin } })).status, 403);
    const saved = await request(`${origin}/api/v2/source-admin/commands/steam.save`, mutation);
    assert.equal(saved.status, 200, await saved.text());
  }
  if (local) {
    assert.equal((await request(`${origin}/api/v2/auth/discord/start`, { redirect: 'manual' })).status, 403);
    assert.equal((await request(`${origin}/api/integrations/discord/interactions`, { method: 'POST' })).status, 403);
  }
  assert.equal((await request(`${origin}/api/v2/auth/password`, { method: 'POST', headers: { origin: publicOrigin, 'content-type': 'application/json' }, body: JSON.stringify({ username: 'root', password }) })).status, 403);
  child.kill('SIGTERM');
  const [code] = await exited; assert.equal(code, 0, output);
  await assert.rejects(fs.access(path.join(config.dataDirectory, '.v2-production/operation.lock')), { code: 'ENOENT' });
}

test('dotenv startup without third-party credentials serves V2 and authenticates only the installed owner', { timeout: 45000 }, t => runtimeSmoke(t));
test('HTTPS production origin without third-party credentials keeps secure owner cookies', { timeout: 45000 }, t => runtimeSmoke(t, { local: false }));

test('Vite development origin authenticates and writes through the API with exact-origin CSRF', { timeout: 45000 }, t => runtimeSmoke(t, { development: true }));
