import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import express from 'express';

function uniqueImport(file) {
  return import(`${file}?user-account-sqlite-fallback-${Date.now()}-${Math.random().toString(36).slice(2)}`);
}

function queryCount(status, name) {
  return status.sqlite?.queries?.byName?.[name]?.total || 0;
}

test('sqlite-primary user account store fails closed without full store fallback', async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'nb-clan-user-account-fallback-'));
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
    const authModule = await uniqueImport('../server/auth.js');
    const userAccountStoreModule = await uniqueImport('../server/user-account-store.js');
    const repositoryModule = await import('../server/storage/repository.js');
    await storeModule.ensureStore();

    const beforeUserReadFailure = await storeModule.storeRuntimeStatus({ sqliteSummary: false });
    repositoryModule.injectSqliteQueryFailureForTests('get_users', 1);
    await assert.rejects(
      () => userAccountStoreModule.readUserRuntimeStore('user_root'),
      (error) => error?.status === 503 && /账号读取暂不可用/.test(error.message)
    );
    const afterUserReadFailure = await storeModule.storeRuntimeStatus({ sqliteSummary: false });
    assert.equal(queryCount(afterUserReadFailure, 'read_store_full'), queryCount(beforeUserReadFailure, 'read_store_full'));

    const app = express();
    app.use('/api', apiModule.createApiRouter());
    server = createServer(app);
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const baseUrl = `http://127.0.0.1:${server.address().port}/api`;
    const sessionId = await authModule.createSession('user_root');
    const cookie = `nb_session=${encodeURIComponent(sessionId)}`;

    const beforeListFailure = await storeModule.storeRuntimeStatus({ sqliteSummary: false });
    repositoryModule.injectSqliteQueryFailureForTests('list_users', 1);
    const listResponse = await httpFetch(`${baseUrl}/users`, { headers: { cookie } });
    const listPayload = await listResponse.json();
    const afterListFailure = await storeModule.storeRuntimeStatus({ sqliteSummary: false });
    assert.equal(listResponse.status, 503, JSON.stringify(listPayload));
    assert.match(listPayload.error, /账号列表读取暂不可用/);
    assert.equal(queryCount(afterListFailure, 'read_store_full'), queryCount(beforeListFailure, 'read_store_full'));

    const beforeWriteFailure = await storeModule.storeRuntimeStatus({ sqliteSummary: false });
    repositoryModule.injectSqliteStorePatchFailureForTests('user_add', 1);
    const createResponse = await httpFetch(`${baseUrl}/users`, {
      method: 'POST',
      headers: {
        cookie,
        'content-type': 'application/json'
      },
      body: JSON.stringify({
        username: 'sqlite_user_failure',
        password: 'UserFail123!',
        role: 'viewer'
      })
    });
    const createPayload = await createResponse.json();
    const afterWriteFailure = await storeModule.storeRuntimeStatus({ sqliteSummary: false });
    assert.equal(createResponse.status, 503, JSON.stringify(createPayload));
    assert.match(createPayload.error, /账号写入暂不可用/);
    assert.equal(queryCount(afterWriteFailure, 'read_store_full'), queryCount(beforeWriteFailure, 'read_store_full'));

    const users = await repositoryModule.getSqliteCollection('users', { limit: 0 });
    assert.equal(users.some((user) => user.username === 'sqlite_user_failure'), false);
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
