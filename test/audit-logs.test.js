import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  LOG_HISTORY_LIMIT,
  appendLog,
  appendLogDirect,
  createLogEntry,
  requestActorUserId,
  requestActorUsername
} from '../server/audit-logs.js';

test('audit log helpers preserve actor fallback, field shape, and history limit', () => {
  const req = {
    user: { id: 'user_admin', username: 'Admin' },
    socket: { remoteAddress: '127.0.0.1' }
  };
  assert.equal(requestActorUserId(req), 'user_admin');
  assert.equal(requestActorUsername(req), 'Admin');
  assert.equal(requestActorUserId({}, 'system'), 'system');
  assert.equal(requestActorUsername({ wechatUser: { id: 'wx_1', nickname: 'Wechat User' } }), 'Wechat User');

  const store = {
    logs: Array.from({ length: LOG_HISTORY_LIMIT }, (_, index) => ({
      id: `old_${index}`,
      type: 'old',
      createdAt: new Date(Date.now() - index - 1).toISOString()
    }))
  };
  appendLog(store, req, 'member_edit', 'Edited member', {
    steamId: '76561198000000000',
    targetId: 'member_1',
    metadata: { changed: true }
  });
  assert.equal(store.logs.length, LOG_HISTORY_LIMIT);
  assert.equal(store.logs[0].type, 'member_edit');
  assert.equal(store.logs[0].actorUserId, 'user_admin');
  assert.equal(store.logs[0].actorUsername, 'Admin');
  assert.equal(store.logs[0].ip, '127.0.0.1');
  assert.equal(store.logs[0].steamId, '76561198000000000');
  assert.equal(store.logs[0].targetId, 'member_1');
  assert.deepEqual(store.logs[0].metadata, { changed: true });

  const systemLog = createLogEntry(null, 'system_task', 'Ran task');
  assert.equal(systemLog.actorUserId, 'anonymous');
  assert.equal(systemLog.actorUsername, 'anonymous');
  assert.equal(systemLog.ip, 'system');
});

test('appendLogDirect trims sqlite-primary logs without listing the full log collection', async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'nb-clan-audit-log-trim-'));
  const previousEnv = {
    NB_DATA_DIR: process.env.NB_DATA_DIR,
    NB_ROOT_PASSWORD: process.env.NB_ROOT_PASSWORD,
    NB_STORAGE_MODE: process.env.NB_STORAGE_MODE,
    NB_SQLITE_FILE: process.env.NB_SQLITE_FILE
  };
  process.env.NB_DATA_DIR = dataDir;
  process.env.NB_ROOT_PASSWORD = 'RootPass123!';
  process.env.NB_STORAGE_MODE = 'sqlite-primary';
  process.env.NB_SQLITE_FILE = path.join(dataDir, 'nb-clan.sqlite');

  try {
    const storeModule = await import(`../server/store.js?audit-log-trim-${Date.now()}`);
    const repositoryModule = await import('../server/storage/repository.js');
    await storeModule.ensureStore();

    const oldLogs = Array.from({ length: LOG_HISTORY_LIMIT + 5 }, (_, index) => ({
      id: `old_log_${String(index).padStart(4, '0')}`,
      type: 'old',
      actorUserId: 'system',
      actorUsername: 'system',
      ip: 'system',
      summary: `Old log ${index}`,
      metadata: {},
      createdAt: new Date(Date.UTC(2020, 0, 1, 0, 0, index)).toISOString()
    }));
    await repositoryModule.writeSqliteStorePatch({
      reason: 'audit_log_trim_seed',
      upserts: { logs: oldLogs }
    });

    const beforeStatus = await storeModule.storeRuntimeStatus({ sqliteSummary: false });
    const beforeListLogs = beforeStatus.sqlite.queries.byName.list_logs?.total || 0;
    const writeCount = (status, name) => status.sqlite?.writes?.byName?.[name]?.total || 0;
    const beforeAppendLogWrites = writeCount(beforeStatus, 'append_log');
    const beforeAppendLogTrimWrites = writeCount(beforeStatus, 'append_log_trim');
    const beforeStoreWrites = beforeStatus.metrics.writes.total;

    const log = await appendLogDirect(
      { user: { id: 'user_audit', username: 'Audit User' }, socket: { remoteAddress: '127.0.0.1' } },
      'member_edit',
      'Edited member through direct log',
      { targetId: 'member_audit_trim' }
    );

    const afterStatus = await storeModule.storeRuntimeStatus({ sqliteSummary: false });
    assert.equal(afterStatus.sqlite.queries.byName.list_logs?.total || 0, beforeListLogs);
    assert.equal(writeCount(afterStatus, 'append_log'), beforeAppendLogWrites + 1);
    assert.equal(writeCount(afterStatus, 'append_log_trim'), beforeAppendLogTrimWrites);
    assert.equal(afterStatus.metrics.writes.total, beforeStoreWrites);

    const logs = await repositoryModule.getSqliteCollection('logs', { limit: 0 });
    assert.equal(logs.length, LOG_HISTORY_LIMIT);
    assert.equal(logs.some((item) => item.id === log.id && item.type === 'member_edit'), true);
    assert.equal(logs.some((item) => item.id === 'old_log_0000'), false);
  } finally {
    const sqliteModule = await import('../server/storage/sqlite.js');
    await sqliteModule.closeSqliteDatabasesForTests();
    Object.assign(process.env, previousEnv);
    for (const [key, value] of Object.entries(previousEnv)) {
      if (value === undefined) delete process.env[key];
    }
    await rm(dataDir, { recursive: true, force: true });
  }
});

test('appendLogDirect skips sqlite-primary log write failures without full store fallback', async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'nb-clan-audit-log-fail-'));
  const previousEnv = {
    NB_DATA_DIR: process.env.NB_DATA_DIR,
    NB_ROOT_PASSWORD: process.env.NB_ROOT_PASSWORD,
    NB_STORAGE_MODE: process.env.NB_STORAGE_MODE,
    NB_SQLITE_FILE: process.env.NB_SQLITE_FILE
  };
  process.env.NB_DATA_DIR = dataDir;
  process.env.NB_ROOT_PASSWORD = 'RootPass123!';
  process.env.NB_STORAGE_MODE = 'sqlite-primary';
  process.env.NB_SQLITE_FILE = path.join(dataDir, 'nb-clan.sqlite');

  try {
    const storeModule = await import(`../server/store.js?audit-log-fail-${Date.now()}`);
    const repositoryModule = await import('../server/storage/repository.js');
    await storeModule.ensureStore();

    const beforeStatus = await storeModule.storeRuntimeStatus({ sqliteSummary: false });
    const beforeFullReads = beforeStatus.sqlite.queries.byName.read_store_full?.total || 0;
    const beforeStoreWrites = beforeStatus.metrics.writes.total;
    const beforeAppendWrites = beforeStatus.sqlite.writes.byName.append_log?.total || 0;

    repositoryModule.injectSqliteStorePatchFailureForTests('append_log', 1);
    const log = await appendLogDirect(
      { user: { id: 'user_audit', username: 'Audit User' }, socket: { remoteAddress: '127.0.0.1' } },
      'member_edit',
      'Edited member through failed direct log',
      { targetId: 'member_audit_log_failure' }
    );

    const afterStatus = await storeModule.storeRuntimeStatus({ sqliteSummary: false });
    assert.equal(log, null);
    assert.equal(afterStatus.sqlite.queries.byName.read_store_full?.total || 0, beforeFullReads);
    assert.equal(afterStatus.metrics.writes.total, beforeStoreWrites);
    assert.equal(afterStatus.sqlite.writes.byName.append_log?.total || 0, beforeAppendWrites);

    const logs = await repositoryModule.getSqliteCollection('logs', { limit: 0 });
    assert.equal(logs.some((item) => item.targetId === 'member_audit_log_failure'), false);
  } finally {
    const sqliteModule = await import('../server/storage/sqlite.js');
    await sqliteModule.closeSqliteDatabasesForTests();
    Object.assign(process.env, previousEnv);
    for (const [key, value] of Object.entries(previousEnv)) {
      if (value === undefined) delete process.env[key];
    }
    await rm(dataDir, { recursive: true, force: true });
  }
});
