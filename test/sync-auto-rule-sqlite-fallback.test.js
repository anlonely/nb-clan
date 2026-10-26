import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import express from 'express';

function uniqueImport(file) {
  return import(`${file}?sync-auto-rule-sqlite-fallback-${Date.now()}-${Math.random().toString(36).slice(2)}`);
}

function queryCount(status, name) {
  return status.sqlite?.queries?.byName?.[name]?.total || 0;
}

test('sqlite-primary sync auto rules fail closed without full store fallback', async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'nb-clan-sync-auto-rule-fallback-'));
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
    const repositoryModule = await import('../server/storage/repository.js');
    await storeModule.ensureStore();

    const app = express();
    app.use('/api', apiModule.createApiRouter());
    server = createServer(app);
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const baseUrl = `http://127.0.0.1:${server.address().port}/api`;
    const sessionId = await authModule.createSession('user_root');
    const cookie = `nb_session=${encodeURIComponent(sessionId)}`;

    const beforeReadFailure = await storeModule.storeRuntimeStatus({ sqliteSummary: false });
    repositoryModule.injectSqliteQueryFailureForTests('list_syncAutoRules', 1);
    const readFailureResponse = await httpFetch(`${baseUrl}/sync/auto-rules`, { headers: { cookie } });
    const readFailurePayload = await readFailureResponse.json();
    const afterReadFailure = await storeModule.storeRuntimeStatus({ sqliteSummary: false });
    assert.equal(readFailureResponse.status, 503, JSON.stringify(readFailurePayload));
    assert.match(readFailurePayload.error, /自动任务规则读取暂不可用/);
    assert.equal(queryCount(afterReadFailure, 'read_store_full'), queryCount(beforeReadFailure, 'read_store_full'));

    const beforeWriteFailure = await storeModule.storeRuntimeStatus({ sqliteSummary: false });
    repositoryModule.injectSqliteStorePatchFailureForTests('sync_auto_rule_add', 1);
    const writeFailureResponse = await httpFetch(`${baseUrl}/sync/auto-rules`, {
      method: 'POST',
      headers: {
        cookie,
        'content-type': 'application/json'
      },
      body: JSON.stringify({
        name: 'Fail closed auto rule',
        type: 'member_profile',
        enabled: true,
        intervalMinutes: 30,
        scope: 'missing_only'
      })
    });
    const writeFailurePayload = await writeFailureResponse.json();
    const afterWriteFailure = await storeModule.storeRuntimeStatus({ sqliteSummary: false });
    assert.equal(writeFailureResponse.status, 503, JSON.stringify(writeFailurePayload));
    assert.match(writeFailurePayload.error, /自动任务规则写入暂不可用/);
    assert.equal(queryCount(afterWriteFailure, 'read_store_full'), queryCount(beforeWriteFailure, 'read_store_full'));

    const persistedRules = await repositoryModule.getSqliteCollection('syncAutoRules', { limit: 0 });
    assert.equal(persistedRules.some((rule) => rule.name === 'Fail closed auto rule'), false);
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

test('sqlite-primary sync auto rule runs record per-rule failed and skipped operation runs', async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'nb-clan-sync-auto-rule-run-records-'));
  const previousEnv = {
    NB_DATA_DIR: process.env.NB_DATA_DIR,
    NB_ROOT_PASSWORD: process.env.NB_ROOT_PASSWORD,
    NB_STORAGE_MODE: process.env.NB_STORAGE_MODE,
    NB_SQLITE_FILE: process.env.NB_SQLITE_FILE,
    NB_DISABLE_BACKGROUND_JOBS: process.env.NB_DISABLE_BACKGROUND_JOBS,
    NB_DISABLE_EXTERNAL_VITAL: process.env.NB_DISABLE_EXTERNAL_VITAL,
    NB_RUSTPLUS_RELAY_CHAT_FLUSH_INTERVAL_MS: process.env.NB_RUSTPLUS_RELAY_CHAT_FLUSH_INTERVAL_MS
  };
  process.env.NB_DATA_DIR = dataDir;
  process.env.NB_ROOT_PASSWORD = 'RootPass123!';
  process.env.NB_STORAGE_MODE = 'sqlite-primary';
  process.env.NB_SQLITE_FILE = path.join(dataDir, 'nb-clan.sqlite');
  process.env.NB_DISABLE_BACKGROUND_JOBS = '1';
  process.env.NB_DISABLE_EXTERNAL_VITAL = '1';
  process.env.NB_RUSTPLUS_RELAY_CHAT_FLUSH_INTERVAL_MS = '0';

  try {
    const storeModule = await uniqueImport('../server/store.js');
    const apiModule = await uniqueImport('../server/api.js');
    const repositoryModule = await import('../server/storage/repository.js');
    await storeModule.ensureStore();

    const oldAt = '2026-01-01T00:00:00.000Z';
    await repositoryModule.writeSqliteStorePatch({
      reason: 'sync_auto_rule_run_record_seed',
      replaces: {
        members: [{
          id: 'member_auto_rule_profile_failure',
          steamId: '76561198132131410',
          steamNickname: 'Auto Rule Target',
          squads: [],
          createdAt: oldAt,
          updatedAt: oldAt
        }],
        memberProfiles: [],
        syncJobs: [],
        operationRuns: [],
        syncAutoRules: [
          {
            id: 'sync_auto_rule_profile_failure',
            name: 'Profile failure rule',
            type: 'member_profile',
            enabled: true,
            intervalMinutes: 5,
            scope: 'all_members',
            lastRunAt: '',
            createdAt: oldAt,
            updatedAt: oldAt
          },
          {
            id: 'sync_auto_rule_legacy_unknown',
            name: 'Legacy unknown rule',
            type: 'legacy_unknown',
            enabled: true,
            intervalMinutes: 5,
            scope: 'custom',
            lastRunAt: '',
            createdAt: oldAt,
            updatedAt: oldAt
          }
        ]
      }
    });

    repositoryModule.injectSqliteStorePatchFailureForTests('sync_job_create', 1);
    const result = await apiModule.runDueSyncAutoRulesForTests();
    assert.equal(result.due, 2);
    assert.equal(result.results.some((item) => item.ruleId === 'sync_auto_rule_profile_failure' && item.status === 'failed'), true);
    assert.equal(result.results.some((item) => item.ruleId === 'sync_auto_rule_legacy_unknown' && item.status === 'skipped'), true);

    const operationRuns = await repositoryModule.getSqliteCollection('operationRuns', { limit: 0 });
    const profileRun = operationRuns.find((run) => run.targetId === 'sync_auto_rule_profile_failure');
    const legacyRun = operationRuns.find((run) => run.targetId === 'sync_auto_rule_legacy_unknown');
    assert.equal(profileRun?.type, 'sync_auto_rule_run');
    assert.equal(profileRun.status, 'failed');
    assert.equal(profileRun.errorKey, 'sync_auto_rule_run_failed');
    assert.match(profileRun.errorSummary, /同步任务创建记录暂不可用|Injected sqlite patch failure/);
    assert.equal(profileRun.metadata.ruleType, 'member_profile');
    assert.equal(profileRun.metadata.failed, 'true');
    assert.equal(legacyRun?.type, 'sync_auto_rule_run');
    assert.equal(legacyRun.status, 'skipped');
    assert.equal(legacyRun.metadata.skipReason, 'unsupported_rule_type');
    assert.equal(JSON.stringify(operationRuns).includes('RootPass123!'), false);

    const persistedRules = await repositoryModule.getSqliteCollection('syncAutoRules', { limit: 0 });
    assert.equal(persistedRules.every((rule) => Date.parse(rule.lastRunAt) > Date.parse(oldAt)), true);
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
