import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

function uniqueImport(file) {
  return import(`${file}?wechat-reminder-schedule-sqlite-${Date.now()}-${Math.random().toString(36).slice(2)}`);
}

function queryCount(status, name) {
  return status.sqlite?.queries?.byName?.[name]?.total || 0;
}

test('sqlite-primary wechat wipe reminder scheduler avoids full store fallback on sqlite read failure', async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'nb-clan-wechat-reminder-schedule-'));
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

    await storeModule.updateStore((store) => {
      store.wipes.push({
        id: 'wipe_wechat_reminder_schedule',
        name: 'Wechat Reminder Schedule',
        serverName: 'Wechat Reminder Server',
        status: 'active',
        signupStatus: 'open',
        signupOpenedAt: '2026-07-09T00:00:00.000Z',
        signupCloseAt: '2026-07-09T12:00:00.000Z',
        startedAt: '2026-07-10T00:00:00.000Z',
        createdAt: '2026-07-09T00:00:00.000Z',
        updatedAt: '2026-07-09T00:00:00.000Z'
      });
    });

    const beforeTargetFailure = await storeModule.storeRuntimeStatus({ sqliteSummary: false });
    repositoryModule.injectSqliteQueryFailureForTests('get_wipes', 1);
    const targetScheduled = await apiModule.scheduleWechatWipeReminderTimersFromStore('wipe_wechat_reminder_schedule');
    const afterTargetFailure = await storeModule.storeRuntimeStatus({ sqliteSummary: false });
    assert.equal(targetScheduled, 0);
    assert.equal(queryCount(afterTargetFailure, 'read_store_full'), queryCount(beforeTargetFailure, 'read_store_full'));

    const beforeStartupFailure = await storeModule.storeRuntimeStatus({ sqliteSummary: false });
    repositoryModule.injectSqliteQueryFailureForTests('list_wipes_status', 1);
    const startupScheduled = await apiModule.scheduleWechatWipeReminderTimersFromStore();
    const afterStartupFailure = await storeModule.storeRuntimeStatus({ sqliteSummary: false });
    assert.equal(startupScheduled, 0);
    assert.equal(queryCount(afterStartupFailure, 'read_store_full'), queryCount(beforeStartupFailure, 'read_store_full'));
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

test('sqlite-primary wechat wipe reminder trigger avoids full store fallback on sqlite failure', async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'nb-clan-wechat-reminder-trigger-'));
  const previousEnv = {
    NB_DATA_DIR: process.env.NB_DATA_DIR,
    NB_ROOT_PASSWORD: process.env.NB_ROOT_PASSWORD,
    NB_STORAGE_MODE: process.env.NB_STORAGE_MODE,
    NB_SQLITE_FILE: process.env.NB_SQLITE_FILE,
    NB_DISABLE_BACKGROUND_JOBS: process.env.NB_DISABLE_BACKGROUND_JOBS,
    NB_DISABLE_EXTERNAL_VITAL: process.env.NB_DISABLE_EXTERNAL_VITAL,
    NB_RUSTPLUS_RELAY_CHAT_FLUSH_INTERVAL_MS: process.env.NB_RUSTPLUS_RELAY_CHAT_FLUSH_INTERVAL_MS,
    NB_WECHAT_TEMPLATE_WIPE_REMINDER: process.env.NB_WECHAT_TEMPLATE_WIPE_REMINDER
  };
  process.env.NB_DATA_DIR = dataDir;
  process.env.NB_ROOT_PASSWORD = 'RootPass123!';
  process.env.NB_STORAGE_MODE = 'sqlite-primary';
  process.env.NB_SQLITE_FILE = path.join(dataDir, 'nb-clan.sqlite');
  process.env.NB_DISABLE_BACKGROUND_JOBS = '1';
  process.env.NB_DISABLE_EXTERNAL_VITAL = '1';
  process.env.NB_RUSTPLUS_RELAY_CHAT_FLUSH_INTERVAL_MS = '0';
  process.env.NB_WECHAT_TEMPLATE_WIPE_REMINDER = 'tmpl_trigger_failure';

  try {
    const storeModule = await uniqueImport('../server/store.js');
    const apiModule = await uniqueImport('../server/api.js');
    const repositoryModule = await import('../server/storage/repository.js');
    await storeModule.ensureStore();

    const createdAt = '2026-07-09T00:00:00.000Z';
    const reminderNowMs = Date.parse('2026-07-10T11:00:00.000Z');
    await repositoryModule.writeSqliteStorePatch({
      reason: 'sqlite_test_wechat_wipe_reminder_trigger_seed',
      upserts: {
        members: [{
          id: 'member_wechat_reminder_trigger',
          steamId: '76561198008888881',
          rawInput: '76561198008888881',
          steamNickname: 'Wechat Reminder Trigger',
          wechatId: 'wechat_user_reminder_trigger',
          wechatUserId: 'wechat_user_reminder_trigger',
          memberStatus: 'active',
          specialty: [],
          createdAt,
          updatedAt: createdAt
        }],
        wechatUsers: [{
          id: 'wechat_user_reminder_trigger',
          openid: 'openid_reminder_trigger',
          status: 'approved',
          role: 'member',
          memberId: 'member_wechat_reminder_trigger',
          subscriptionPreferences: {
            wipeReminder: {
              status: 'accept',
              templateId: 'tmpl_trigger_failure',
              updatedAt: createdAt
            }
          },
          createdAt,
          updatedAt: createdAt,
          lastLoginAt: createdAt
        }],
        wipes: [{
          id: 'wipe_wechat_reminder_trigger',
          name: 'Wechat Reminder Trigger',
          serverName: 'Wechat Reminder Trigger Server',
          status: 'active',
          signupStatus: 'open',
          signupOpenedAt: createdAt,
          startedAt: '2026-07-10T12:00:00.000Z',
          wechatReminderSent: {},
          createdAt,
          updatedAt: createdAt
        }]
      }
    });

    const sentMessages = [];
    const sendOptions = {
      nowMs: reminderNowMs,
      sendOne: async (message) => {
        sentMessages.push(message);
        return { ok: true };
      }
    };

    const beforeReadFailure = await storeModule.storeRuntimeStatus({ sqliteSummary: false });
    repositoryModule.injectSqliteQueryFailureForTests('get_wipes', 1);
    await assert.rejects(
      () => apiModule.triggerWechatWipeReminder('wipe_wechat_reminder_trigger', 'one_hour_before', sendOptions),
      (error) => error?.status === 503
    );
    const afterReadFailure = await storeModule.storeRuntimeStatus({ sqliteSummary: false });
    assert.equal(sentMessages.length, 0);
    assert.equal(queryCount(afterReadFailure, 'read_store_full'), queryCount(beforeReadFailure, 'read_store_full'));
    assert.equal(afterReadFailure.metrics.writes.total, beforeReadFailure.metrics.writes.total);

    const beforePatchFailure = await storeModule.storeRuntimeStatus({ sqliteSummary: false });
    repositoryModule.injectSqliteStorePatchFailureForTests('wechat_wipe_reminder', 1);
    await assert.rejects(
      () => apiModule.triggerWechatWipeReminder('wipe_wechat_reminder_trigger', 'one_hour_before', sendOptions),
      (error) => error?.status === 503
    );
    const afterPatchFailure = await storeModule.storeRuntimeStatus({ sqliteSummary: false });
    assert.equal(sentMessages.length, 0);
    assert.equal(queryCount(afterPatchFailure, 'read_store_full'), queryCount(beforePatchFailure, 'read_store_full'));
    assert.equal(afterPatchFailure.metrics.writes.total, beforePatchFailure.metrics.writes.total);

    const persistedWipe = await repositoryModule.getSqliteRecord('wipes', 'wipe_wechat_reminder_trigger');
    assert.equal(Boolean(persistedWipe.wechatReminderSent?.one_hour_before), false);
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
