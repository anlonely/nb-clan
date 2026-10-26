import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import express from 'express';
import nodeFetch from 'node-fetch';
import { providerConfiguration } from '../server/v2/identity/providers.js';

const main = 'https://nb.example', secondary = 'https://callback.example';
const configuration = {
  NB_V2_PRODUCTION_ENABLED: '1', NB_V2_PUBLIC_ORIGIN: main,
  NB_DISCORD_OAUTH_REDIRECT_URI: main + '/api/auth/discord/callback',
  NB_KOOK_OAUTH_REDIRECT_URI: secondary + '/api/auth/kook/callback'
};

test('OAuth configuration prefers explicit V2 callback but preserves existing exact legacy callback and fixed origins', () => {
  const selected = providerConfiguration(configuration);
  assert.equal(selected.discord.redirectUri, configuration.NB_DISCORD_OAUTH_REDIRECT_URI);
  assert.equal(selected.kook.redirectUri, configuration.NB_KOOK_OAUTH_REDIRECT_URI);
  const explicit = secondary + '/api/v2/auth/kook/callback';
  assert.equal(providerConfiguration({ ...configuration, NB_V2_KOOK_OAUTH_REDIRECT_URI: explicit }).kook.redirectUri, explicit);
  for (const value of ['https://elsewhere.example/api/auth/kook/callback', secondary + '/api/auth/discord/callback',
    secondary + '/api/auth/kook/callback?returnTo=evil', secondary + '/api/auth/kook/callback#fragment',
    'https://user:secret@callback.example/api/auth/kook/callback', 'http://callback.example/api/auth/kook/callback']) {
    assert.throws(() => providerConfiguration({ ...configuration, NB_V2_KOOK_OAUTH_REDIRECT_URI: value }), error => error.errorCode === 'LOGIN_NOT_CONFIGURED');
  }
});

test('real API legacy callback alias shares V2 single-use provider state and main-domain browser handoff without legacy writes', async t => {
  const directory = await mkdtemp(path.join(tmpdir(), 'nb-v2-oauth-alias-')), saved = { ...process.env };
  Object.assign(process.env, { ...configuration, NB_V2_IDENTITY_ENABLED: '1', NB_DATA_DIR: directory,
    NB_STORAGE_MODE: 'sqlite-primary', NB_SQLITE_FILE: path.join(directory, 'nb-clan.sqlite'),
    NB_ROOT_PASSWORD: 'Constructed-local-auth-only', NB_DISABLE_BACKGROUND_JOBS: '1', NB_DISABLE_DATA_BACKUP: '1',
    NB_DISABLE_EXTERNAL_VITAL: '1', NB_DISABLE_EXTERNAL_ATLAS: '1', NB_RUSTPLUS_RELAY_CHAT_FLUSH_INTERVAL_MS: '0',
    NB_DISCORD_OAUTH_CLIENT_ID: 'constructed-client', NB_DISCORD_OAUTH_CLIENT_SECRET: 'constructed-secret',
    NB_KOOK_OAUTH_CLIENT_ID: 'constructed-client', NB_KOOK_OAUTH_CLIENT_SECRET: 'constructed-secret' });
  delete process.env.NB_V2_DISCORD_OAUTH_REDIRECT_URI; delete process.env.NB_V2_KOOK_OAUTH_REDIRECT_URI;
  const store = await import('../server/store.js'), storage = await import('../server/storage/sqlite.js');
  await store.ensureStore(); const legacy = structuredClone(await store.readStore()), db = await storage.openSqliteDatabase();
  const { installIdentitySchema, IdentityRepository } = await import('../server/v2/identity/repository.js');
  const { planIdentityMigration, applyIdentityMigration } = await import('../server/v2/identity/migration.js');
  installIdentitySchema(db); const repo = new IdentityRepository(db); applyIdentityMigration(repo, planIdentityMigration(legacy));
  for (const policy of repo.all('policies')) repo.put('policies', { ...policy, enabled: true, guildId: 'constructed-guild', allowedRoleIds: ['constructed-role'] });
  const accountsBefore = structuredClone(repo.all('accounts')), sessionsBefore = structuredClone(repo.all('sessions'));
  const { createApiRouter, stopBackgroundJobs } = await import('../server/api.js');
  const api = createApiRouter(), app = express(); app.set('trust proxy', 'loopback'); app.use('/api', api);
  const server = createServer(app); await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const local = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => {
    server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); stopBackgroundJobs();
    await api.v2Runtime.stop(); await store.drainStoreWrites(); await storage.closeSqliteDatabases();
    for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key]; Object.assign(process.env, saved);
    await rm(directory, { recursive: true, force: true });
  });
  const request = (url, { host = 'nb.example', cookie } = {}) => nodeFetch(local + url, { redirect: 'manual',
    headers: { host, 'x-forwarded-proto': 'https', ...(cookie ? { cookie } : {}) } });
  for (const provider of ['discord', 'kook']) {
    const start = await request(`/api/v2/auth/${provider}/start?returnTo=%2Fapp%2Fhome`);
    assert.equal(start.status, 302, await start.clone().text());
    const authorization = new URL(start.headers.get('location')), state = authorization.searchParams.get('state');
    assert.equal(authorization.searchParams.get('redirect_uri'), configuration[`NB_${provider.toUpperCase()}_OAUTH_REDIRECT_URI`]);
    const browserCookie = (start.headers.raw()['set-cookie'] || []).map(value => value.split(';')[0]).join('; ');
    const callback = `/api/auth/${provider}/callback?error=access_denied&state=${state}`;
    assert.equal((await request(callback, { host: 'unconfigured.example' })).status, 400);
    assert.equal((await request(callback.replace('/api/auth/', '/api/v2/auth/'))).status, 400);
    const other = provider === 'discord' ? 'kook' : 'discord';
    assert.equal((await request(callback.replace(`/auth/${provider}/`, `/auth/${other}/`))).status, 401);
    // The existing secondary proxy strips cookies and rewrites Host to nb.example.
    const completed = await request(callback);
    assert.equal(completed.status, 303); assert.deepEqual(completed.headers.raw()['set-cookie'] || [], []);
    const finish = new URL(completed.headers.get('location'));
    assert.equal(finish.origin, main); assert.equal(finish.pathname, `/api/v2/auth/${provider}/finish`);
    assert.equal((await request(callback)).status, 410);
    assert.equal((await request(finish.pathname + finish.search)).status, 401);
    const resumed = await request(finish.pathname + finish.search, { cookie: browserCookie });
    assert.equal(resumed.status, 303); assert.match(resumed.headers.get('location'), /AUTH_CANCELLED/);
    assert.equal((await request(finish.pathname + finish.search, { cookie: browserCookie })).status, 410);
  }
  assert.deepEqual(repo.all('accounts'), accountsBefore); assert.deepEqual(repo.all('sessions'), sessionsBefore);
  assert.deepEqual((await store.readStore()).users, legacy.users);
});
