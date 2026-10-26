import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import express from 'express';
import { drainBackgroundTaskQueuesForTests } from '../server/background-task-queue.js';

function uniqueImport(file) {
  return import(`${file}?auth-account-sqlite-fallback-${Date.now()}-${Math.random().toString(36).slice(2)}`);
}

function queryCount(status, name) {
  return status.sqlite?.queries?.byName?.[name]?.total || 0;
}

function writeCount(status, name) {
  return status.sqlite?.writes?.byName?.[name]?.total || 0;
}

test('sqlite-primary auth login fails closed without full store fallback', async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'nb-clan-auth-account-fallback-'));
  const previousEnv = {
    NB_DATA_DIR: process.env.NB_DATA_DIR,
    NB_ROOT_PASSWORD: process.env.NB_ROOT_PASSWORD,
    NB_STORAGE_MODE: process.env.NB_STORAGE_MODE,
    NB_SQLITE_FILE: process.env.NB_SQLITE_FILE,
    NB_DISABLE_BACKGROUND_JOBS: process.env.NB_DISABLE_BACKGROUND_JOBS,
    NB_DISABLE_EXTERNAL_VITAL: process.env.NB_DISABLE_EXTERNAL_VITAL,
    NB_RUSTPLUS_RELAY_CHAT_FLUSH_INTERVAL_MS: process.env.NB_RUSTPLUS_RELAY_CHAT_FLUSH_INTERVAL_MS
  };
  const httpFetch = globalThis.fetch.bind(globalThis);
  process.env.NB_DATA_DIR = dataDir;
  process.env.NB_ROOT_PASSWORD = 'RootPass123!';
  process.env.NB_STORAGE_MODE = 'sqlite-primary';
  process.env.NB_SQLITE_FILE = path.join(dataDir, 'nb-clan.sqlite');
  process.env.NB_DISABLE_BACKGROUND_JOBS = '1';
  process.env.NB_DISABLE_EXTERNAL_VITAL = '1';
  process.env.NB_RUSTPLUS_RELAY_CHAT_FLUSH_INTERVAL_MS = '0';

  let server = null;
  try {
    const storeModule = await uniqueImport('../server/store.js');
    const apiModule = await uniqueImport('../server/api.js');
    const repositoryModule = await import('../server/storage/repository.js');
    await storeModule.ensureStore();

    const app = express();
    app.use('/api', apiModule.createApiRouter());
    server = createServer(app);
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const baseUrl = `http://127.0.0.1:${server.address().port}/api`;

    const beforeFailure = await storeModule.storeRuntimeStatus({ sqliteSummary: false });
    repositoryModule.injectSqliteQueryFailureForTests('list_permissionRoles', 1);
    const response = await httpFetch(`${baseUrl}/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'root', password: 'RootPass123!' })
    });
    const payload = await response.json();
    const afterFailure = await storeModule.storeRuntimeStatus({ sqliteSummary: false });
    assert.equal(response.status, 503, JSON.stringify(payload));
    assert.match(payload.error, /登录账号读取暂不可用/);
    assert.equal(response.headers.get('set-cookie'), null);
    assert.equal(queryCount(afterFailure, 'read_store_full'), queryCount(beforeFailure, 'read_store_full'));

    const beforeSessionCreateFailure = await storeModule.storeRuntimeStatus({ sqliteSummary: false });
    repositoryModule.injectSqliteStorePatchFailureForTests('session_create', 1);
    const sessionCreateFailureResponse = await httpFetch(`${baseUrl}/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'root', password: 'RootPass123!' })
    });
    const sessionCreateFailurePayload = await sessionCreateFailureResponse.json();
    const afterSessionCreateFailure = await storeModule.storeRuntimeStatus({ sqliteSummary: false });
    assert.equal(sessionCreateFailureResponse.status, 503, JSON.stringify(sessionCreateFailurePayload));
    assert.match(sessionCreateFailurePayload.error, /登录会话创建暂不可用/);
    assert.equal(sessionCreateFailureResponse.headers.get('set-cookie'), null);
    assert.equal(queryCount(afterSessionCreateFailure, 'read_store_full'), queryCount(beforeSessionCreateFailure, 'read_store_full'));
    assert.equal(writeCount(afterSessionCreateFailure, 'sqlite_primary_patch'), writeCount(beforeSessionCreateFailure, 'sqlite_primary_patch'));
    assert.equal(afterSessionCreateFailure.sqlite.records.sessions || 0, beforeSessionCreateFailure.sqlite.records.sessions || 0);
  } finally {
    if (server) await new Promise((resolve) => server.close(resolve));
    const sqliteModule = await import('../server/storage/sqlite.js');
    await sqliteModule.closeSqliteDatabasesForTests();
    Object.assign(process.env, previousEnv);
    for (const [key, value] of Object.entries(previousEnv)) {
      if (value === undefined) delete process.env[key];
    }
    await rm(dataDir, { recursive: true, force: true });
  }
});

test('sqlite-primary auth login member ensure uses scoped writes without broad reads', async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'nb-clan-auth-login-member-ensure-'));
  const previousEnv = {
    NB_DATA_DIR: process.env.NB_DATA_DIR,
    NB_ROOT_PASSWORD: process.env.NB_ROOT_PASSWORD,
    NB_STORAGE_MODE: process.env.NB_STORAGE_MODE,
    NB_SQLITE_FILE: process.env.NB_SQLITE_FILE,
    NB_DISABLE_BACKGROUND_JOBS: process.env.NB_DISABLE_BACKGROUND_JOBS,
    NB_DISABLE_EXTERNAL_VITAL: process.env.NB_DISABLE_EXTERNAL_VITAL,
    NB_RUSTPLUS_RELAY_CHAT_FLUSH_INTERVAL_MS: process.env.NB_RUSTPLUS_RELAY_CHAT_FLUSH_INTERVAL_MS
  };
  const httpFetch = globalThis.fetch.bind(globalThis);
  process.env.NB_DATA_DIR = dataDir;
  process.env.NB_ROOT_PASSWORD = 'RootPass123!';
  process.env.NB_STORAGE_MODE = 'sqlite-primary';
  process.env.NB_SQLITE_FILE = path.join(dataDir, 'nb-clan.sqlite');
  process.env.NB_DISABLE_BACKGROUND_JOBS = '1';
  process.env.NB_DISABLE_EXTERNAL_VITAL = '1';
  process.env.NB_RUSTPLUS_RELAY_CHAT_FLUSH_INTERVAL_MS = '0';

  let server = null;
  try {
    const storeModule = await uniqueImport('../server/store.js');
    const apiModule = await uniqueImport('../server/api.js');
    const repositoryModule = await import('../server/storage/repository.js');
    await storeModule.ensureStore();

    const createdAt = '2026-07-09T00:00:00.000Z';
    const steamId = '76561198007777777';
    await storeModule.updateStore((store) => {
      const rootUser = store.users.find((user) => user.id === 'user_root');
      rootUser.boundSteamId = steamId;
      rootUser.steamId = steamId;
      rootUser.steamNickname = 'Root Scoped Ensure';
      rootUser.updatedAt = createdAt;
    });

    const app = express();
    app.use('/api', apiModule.createApiRouter());
    server = createServer(app);
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const baseUrl = `http://127.0.0.1:${server.address().port}/api`;

    const beforeLogin = await storeModule.storeRuntimeStatus({ sqliteSummary: false });
    process.env.NB_DISABLE_BACKGROUND_JOBS = '0';
    const response = await httpFetch(`${baseUrl}/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'root', password: 'RootPass123!' })
    });
    const payload = await response.json();
    assert.equal(response.status, 200, JSON.stringify(payload));
    assert.match(response.headers.get('set-cookie') || '', /^nb_session=/);
    await drainBackgroundTaskQueuesForTests();

    const afterLogin = await storeModule.storeRuntimeStatus({ sqliteSummary: false });
    const members = await repositoryModule.getSqliteRecordsByJsonField('members', 'steamId', [steamId], { limit: 0 });
    assert.equal(members.length, 1);
    assert.equal(members[0].invitedByUserId, 'user_root');
    assert.equal(queryCount(afterLogin, 'read_store_full'), queryCount(beforeLogin, 'read_store_full'));
    assert.equal(queryCount(afterLogin, 'list_users'), queryCount(beforeLogin, 'list_users'));
    assert.equal(queryCount(afterLogin, 'list_members'), queryCount(beforeLogin, 'list_members'));
    assert.equal(queryCount(afterLogin, 'list_squads'), queryCount(beforeLogin, 'list_squads'));
    assert.equal(queryCount(afterLogin, 'list_squadMembers'), queryCount(beforeLogin, 'list_squadMembers'));
    assert.equal(queryCount(afterLogin, 'list_users_username_nocase') > queryCount(beforeLogin, 'list_users_username_nocase'), true);
    assert.equal(queryCount(afterLogin, 'list_members_steamId') > queryCount(beforeLogin, 'list_members_steamId'), true);
  } finally {
    process.env.NB_DISABLE_BACKGROUND_JOBS = '1';
    await drainBackgroundTaskQueuesForTests().catch(() => {});
    if (server) await new Promise((resolve) => server.close(resolve));
    const sqliteModule = await import('../server/storage/sqlite.js');
    await sqliteModule.closeSqliteDatabasesForTests();
    Object.assign(process.env, previousEnv);
    for (const [key, value] of Object.entries(previousEnv)) {
      if (value === undefined) delete process.env[key];
    }
    await rm(dataDir, { recursive: true, force: true });
  }
});

test('sqlite-primary third-party Steam login write failures redirect without session or full fallback', async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'nb-clan-third-party-login-fallback-'));
  const previousEnv = {
    NB_DATA_DIR: process.env.NB_DATA_DIR,
    NB_ROOT_PASSWORD: process.env.NB_ROOT_PASSWORD,
    NB_STORAGE_MODE: process.env.NB_STORAGE_MODE,
    NB_SQLITE_FILE: process.env.NB_SQLITE_FILE,
    NB_DISABLE_BACKGROUND_JOBS: process.env.NB_DISABLE_BACKGROUND_JOBS,
    NB_DISABLE_EXTERNAL_VITAL: process.env.NB_DISABLE_EXTERNAL_VITAL,
    NB_RUSTPLUS_RELAY_CHAT_FLUSH_INTERVAL_MS: process.env.NB_RUSTPLUS_RELAY_CHAT_FLUSH_INTERVAL_MS,
    NODE_ENV: process.env.NODE_ENV
  };
  const originalFetch = globalThis.fetch;
  const httpFetch = originalFetch.bind(globalThis);
  process.env.NB_DATA_DIR = dataDir;
  process.env.NB_ROOT_PASSWORD = 'RootPass123!';
  process.env.NB_STORAGE_MODE = 'sqlite-primary';
  process.env.NB_SQLITE_FILE = path.join(dataDir, 'nb-clan.sqlite');
  process.env.NB_DISABLE_BACKGROUND_JOBS = '1';
  process.env.NB_DISABLE_EXTERNAL_VITAL = '1';
  process.env.NB_RUSTPLUS_RELAY_CHAT_FLUSH_INTERVAL_MS = '0';
  process.env.NODE_ENV = 'test';

  let server = null;
  try {
    const storeModule = await uniqueImport('../server/store.js');
    const apiModule = await uniqueImport('../server/api.js');
    const repositoryModule = await import('../server/storage/repository.js');
    await storeModule.ensureStore();

    const createdAt = '2026-07-09T00:00:00.000Z';
    const steamId = '76561198008888888';
    await storeModule.updateStore((store) => {
      store.settings.thirdPartyLogin ||= {};
      store.settings.thirdPartyLogin.steam = { enabled: true };
      store.members.push({
        id: 'member_sqlite_steam_login_failure',
        steamId,
        rawInput: steamId,
        customName: 'SQLite Steam Login Failure',
        steamNickname: 'Old Steam Login Failure',
        avatar: '',
        discordId: '',
        wechatId: '',
        wechatUserId: '',
        notes: '',
        specialty: [],
        memberStatus: 'active',
        invitedByUserId: 'user_root',
        createdAt,
        updatedAt: createdAt
      });
    });

    globalThis.fetch = async (url, options = {}) => {
      const href = String(url);
      if (href === `https://steamcommunity.com/profiles/${steamId}?xml=1`) {
        return new Response([
          '<profile>',
          `<steamID64>${steamId}</steamID64>`,
          '<steamID><![CDATA[SQLite Steam OAuth Failure]]></steamID>',
          '<avatarFull>https://cdn.example.com/sqlite-steam-oauth-failure.jpg</avatarFull>',
          '</profile>'
        ].join(''), { status: 200, headers: { 'content-type': 'text/xml' } });
      }
      return originalFetch(url, options);
    };

    const app = express();
    app.use('/api', apiModule.createApiRouter());
    server = createServer(app);
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const baseUrl = `http://127.0.0.1:${server.address().port}/api`;

    const beforeFailure = await storeModule.storeRuntimeStatus({ sqliteSummary: false });
    repositoryModule.injectSqliteStorePatchFailureForTests('steam_login', 1);
    const callbackUrl = `${baseUrl}/auth/steam/callback?openid.claimed_id=${encodeURIComponent(`https://steamcommunity.com/openid/id/${steamId}`)}&testVerified=1&lang=zh`;
    const response = await httpFetch(callbackUrl, { redirect: 'manual' });

    const afterFailure = await storeModule.storeRuntimeStatus({ sqliteSummary: false });
    const location = response.headers.get('location') || '';
    assert.equal(response.status, 302);
    assert.match(location, /authError=thirdPartyLoginVerifyFailed/);
    assert.match(location, /authLang=zh/);
    assert.equal(response.headers.get('set-cookie'), null);
    assert.equal(queryCount(afterFailure, 'read_store_full'), queryCount(beforeFailure, 'read_store_full'));
    assert.equal(afterFailure.metrics.writes.total, beforeFailure.metrics.writes.total);
    assert.equal(writeCount(afterFailure, 'steam_login'), writeCount(beforeFailure, 'steam_login'));

    const users = await repositoryModule.getSqliteRecordsByJsonField('users', 'boundSteamId', [steamId], { limit: 0 });
    const member = await repositoryModule.getSqliteRecord('members', 'member_sqlite_steam_login_failure');
    const logs = await repositoryModule.getSqliteCollection('logs', { limit: 0 });
    assert.equal(users.some((user) => user.createdBy === 'steam_login'), false);
    assert.equal(member.steamNickname, 'Old Steam Login Failure');
    assert.equal(member.avatar, '');
    assert.equal(logs.some((log) => log.type === 'steam_login' && log.steamId === steamId), false);
    assert.equal(logs.some((log) => log.type === 'steam_login_user_create' && log.steamId === steamId), false);
  } finally {
    globalThis.fetch = originalFetch;
    if (server) await new Promise((resolve) => server.close(resolve));
    const sqliteModule = await import('../server/storage/sqlite.js');
    await sqliteModule.closeSqliteDatabasesForTests();
    Object.assign(process.env, previousEnv);
    for (const [key, value] of Object.entries(previousEnv)) {
      if (value === undefined) delete process.env[key];
    }
    await rm(dataDir, { recursive: true, force: true });
  }
});
