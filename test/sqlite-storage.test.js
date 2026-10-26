import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdir, mkdtemp, readdir, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import test from 'node:test';
import express from 'express';

const execFileAsync = promisify(execFile);

function uniqueImport(file) {
  return import(`${file}?sqlite-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
}

async function waitForSqliteOperationRun(repositoryModule, predicate, label) {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const operationRuns = await repositoryModule.getSqliteCollection('operationRuns', { limit: 0 });
    const match = operationRuns.find(predicate);
    if (match) return match;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`Timed out waiting for sqlite operation run: ${label}`);
}

async function waitForSqliteRecord(repositoryModule, collection, id, predicate, label) {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    const record = await repositoryModule.getSqliteRecord(collection, id);
    if (record && predicate(record)) return record;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`Timed out waiting for sqlite record: ${label}`);
}

async function waitForSqliteCollectionMatch(repositoryModule, collection, predicate, label) {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    const records = await repositoryModule.getSqliteCollection(collection, { limit: 0 });
    const record = records.find(predicate);
    if (record) return record;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`Timed out waiting for sqlite collection match: ${label}`);
}

function queryCount(status, name) {
  return status.sqlite?.queries?.byName?.[name]?.total || 0;
}

test('sqlite-primary mode writes updates to SQLite without rewriting store.json', async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'nb-clan-sqlite-primary-'));
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
    const storeModule = await uniqueImport('../server/store.js');
    const { STORE_FILE, ensureStore, readStore, updateStore, storeRuntimeStatus } = storeModule;
    await ensureStore();
    const beforeStat = await stat(STORE_FILE);

    await updateStore((store) => {
      store.settings.discord.commandHint = '/sqlite-primary';
    });

    const afterStat = await stat(STORE_FILE);
    assert.equal(afterStat.mtimeMs, beforeStat.mtimeMs);

    const freshStoreModule = await uniqueImport('../server/store.js');
    const freshStore = await freshStoreModule.readStore();
    assert.equal(freshStore.settings.discord.commandHint, '/sqlite-primary');

    const status = await storeRuntimeStatus();
    assert.equal(status.mode, 'sqlite-primary');
    assert.equal(status.sqlite.ok, true);
    assert.equal(status.sqlite.records.users, 1);
    assert.equal(status.metrics.sqliteWrites >= 1, true);

    const repositoryModule = await import('../server/storage/repository.js');
    const mirroredStore = await readStore();
    const mirrorResult = await repositoryModule.writeSqliteStoreMirror(mirroredStore, {
      reason: 'sqlite_primary_noop_mirror_test',
      includeFullStore: false
    });
    assert.equal(mirrorResult.collections.users.upserted, 0);
    assert.equal(mirrorResult.collections.users.unchanged, 1);
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

test('sqlite-primary ensureStore fails closed when the canonical SQLite read fails', async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'nb-clan-sqlite-read-fail-closed-'));
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
    const storeModule = await uniqueImport('../server/store.js');
    await storeModule.ensureStore();
    const repositoryModule = await import('../server/storage/repository.js');
    repositoryModule.injectSqliteQueryFailureForTests('read_store_full', 1);
    const freshStoreModule = await uniqueImport('../server/store.js');
    await assert.rejects(
      freshStoreModule.ensureStore(),
      /Injected sqlite query failure for read_store_full/
    );
    assert.equal((await repositoryModule.getSqliteCollection('users', { limit: 0 })).length, 1);
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

test('sqlite-primary updateStore persists generic changes with SQLite patch writes', async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'nb-clan-sqlite-update-store-patch-'));
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
    const storeModule = await uniqueImport('../server/store.js');
    const { STORE_FILE, ensureStore, updateStore, storeRuntimeStatus } = storeModule;
    await ensureStore();
    const createdAt = new Date().toISOString();
    await updateStore((store) => {
      store.members.push({
        id: 'member_sqlite_patch_remove',
        steamId: '76561198001000001',
        rawInput: '76561198001000001',
        customName: '',
        steamNickname: 'Remove Me',
        avatar: '',
        discordId: '',
        wechatId: '',
        wechatUserId: '',
        notes: '',
        specialty: [],
        memberStatus: 'active',
        invitedByUserId: '',
        createdAt,
        updatedAt: createdAt
      });
    });
    const beforeNoopStatus = await storeRuntimeStatus();
    await updateStore(() => {});
    const afterNoopStatus = await storeRuntimeStatus();
    assert.equal(afterNoopStatus.metrics.sqliteWrites, beforeNoopStatus.metrics.sqliteWrites);
    assert.equal(afterNoopStatus.metrics.noOpWrites, beforeNoopStatus.metrics.noOpWrites + 1);
    assert.equal(afterNoopStatus.metrics.writes.last.name, 'write_store_noop');

    const beforeStatus = await storeRuntimeStatus();
    const beforeStat = await stat(STORE_FILE);

    await updateStore((store) => {
      store.settings.discord.commandHint = '/generic-patch';
      store.members = store.members.filter((member) => member.id !== 'member_sqlite_patch_remove');
      store.members.unshift({
        id: 'member_sqlite_patch_add',
        steamId: '76561198001000002',
        rawInput: '76561198001000002',
        customName: '',
        steamNickname: 'Patch Add',
        avatar: '',
        discordId: '',
        wechatId: '',
        wechatUserId: '',
        notes: '',
        specialty: [],
        memberStatus: 'active',
        invitedByUserId: '',
        createdAt,
        updatedAt: createdAt
      });
    });

    const afterStat = await stat(STORE_FILE);
    const afterStatus = await storeRuntimeStatus();
    const repositoryModule = await import('../server/storage/repository.js');
    const addedMember = await repositoryModule.getSqliteRecord('members', 'member_sqlite_patch_add');
    const removedMember = await repositoryModule.getSqliteRecord('members', 'member_sqlite_patch_remove');
    const freshStoreModule = await uniqueImport('../server/store.js');
    const freshStore = await freshStoreModule.readStore();

    assert.equal(afterStat.mtimeMs, beforeStat.mtimeMs);
    assert.equal(addedMember.steamNickname, 'Patch Add');
    assert.equal(removedMember, null);
    assert.equal(freshStore.settings.discord.commandHint, '/generic-patch');
    assert.equal(freshStore.members.some((member) => member.id === 'member_sqlite_patch_add'), true);
    assert.equal(freshStore.members.some((member) => member.id === 'member_sqlite_patch_remove'), false);
    assert.equal(
      afterStatus.sqlite.compatibility.syncStoreChangesToSqlite,
      beforeStatus.sqlite.compatibility.syncStoreChangesToSqlite
    );
    assert.equal(afterStatus.metrics.sqliteWrites, beforeStatus.metrics.sqliteWrites + 1);
    assert.equal(afterStatus.metrics.writes.last.name, 'write_store_sqlite_patch');
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

test('sqlite-primary wechat wipe reminders use direct SQLite patch writes', async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'nb-clan-sqlite-wechat-reminder-'));
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
  process.env.NB_WECHAT_TEMPLATE_WIPE_REMINDER = 'tmpl_sqlite_wipe_reminder';

  try {
    const storeModule = await uniqueImport('../server/store.js');
    const apiModule = await uniqueImport('../server/api.js');
    const authModule = await uniqueImport('../server/auth.js');
    await storeModule.ensureStore();
    const repositoryModule = await import('../server/storage/repository.js');
    const createdAt = '2026-07-08T00:00:00.000Z';
    const reminderNowMs = Date.parse('2026-07-08T12:00:00.000Z');
    const retryWipeId = 'wipe_sqlite_wechat_reminder_retry';
    await repositoryModule.writeSqliteStorePatch({
      reason: 'sqlite_test_wechat_wipe_reminder_seed',
      upserts: {
        members: [{
          id: 'member_sqlite_wechat_reminder',
          steamId: '76561198009999991',
          rawInput: '76561198009999991',
          customName: '',
          steamNickname: 'SQLite Reminder Member',
          avatar: '',
          discordId: '',
          wechatId: 'wechat_user_sqlite_reminder',
          wechatUserId: 'wechat_user_sqlite_reminder',
          notes: '',
          specialty: [],
          memberStatus: 'active',
          invitedByUserId: '',
          createdAt,
          updatedAt: createdAt
        }],
        wechatUsers: [{
          id: 'wechat_user_sqlite_reminder',
          openid: 'openid_sqlite_reminder',
          unionid: '',
          nickname: 'SQLite Reminder',
          avatarUrl: '',
          phone: '',
          wechatId: '',
          discordId: '',
          region: '',
          timeZone: '',
          status: 'approved',
          role: 'member',
          memberId: 'member_sqlite_wechat_reminder',
          subscriptionPreferences: {
            wipeReminder: {
              status: 'accept',
              templateId: 'tmpl_sqlite_wipe_reminder',
              updatedAt: createdAt
            }
          },
          createdAt,
          updatedAt: createdAt,
          lastLoginAt: createdAt
        }],
        wipes: [{
          id: 'wipe_sqlite_wechat_reminder',
          name: 'SQLite Reminder Wipe',
          serverName: 'SQLite Reminder Server',
          status: 'active',
          startedAt: '2026-07-08T13:00:00.000Z',
          closedAt: '',
          signupStatus: 'open',
          signupOpenedAt: createdAt,
          signupClosedAt: '',
          wechatReminderSent: {},
          createdAt,
          updatedAt: createdAt
        }]
      }
    });

    const queryCount = (status, name) => status.sqlite?.queries?.byName?.[name]?.total || 0;
    const writeCount = (status, name) => status.sqlite?.writes?.byName?.[name]?.total || 0;
    const beforeStatus = await storeModule.storeRuntimeStatus();
    const beforeStat = await stat(storeModule.STORE_FILE);
    const beforeReminderWrite = writeCount(beforeStatus, 'wechat_wipe_reminder');
    const beforeFullReads = {
      members: queryCount(beforeStatus, 'list_members'),
      wipes: queryCount(beforeStatus, 'list_wipes'),
      wechatUsers: queryCount(beforeStatus, 'list_wechatUsers')
    };
    const beforeScopedReads = {
      wipeById: queryCount(beforeStatus, 'get_wipes'),
      membersById: queryCount(beforeStatus, 'get_members'),
      membersByStatus: queryCount(beforeStatus, 'list_members_memberStatus'),
      membersMissingStatus: queryCount(beforeStatus, 'list_members_memberStatus_missing'),
      wechatUsersByMember: queryCount(beforeStatus, 'list_wechatUsers_memberId')
    };
    const sentMessages = [];

    const sendResult = await apiModule.triggerWechatWipeReminder('wipe_sqlite_wechat_reminder', 'one_hour_before', {
      nowMs: reminderNowMs,
      sendOne: async (message) => {
        sentMessages.push(message);
        return { ok: true };
      }
    });

    const afterStatus = await storeModule.storeRuntimeStatus();
    const afterStat = await stat(storeModule.STORE_FILE);
    const reminderWipe = await repositoryModule.getSqliteRecord('wipes', 'wipe_sqlite_wechat_reminder');
    const reminderNotifications = await repositoryModule.getSqliteRecordsByJsonField(
      'wechatNotifications',
      'wechatUserId',
      ['wechat_user_sqlite_reminder'],
      { limit: 0 }
    );
    assert.deepEqual(sendResult, { sent: 1, failed: 0 });
    assert.equal(sentMessages.length, 1);
    assert.equal(sentMessages[0].templateKey, 'wipeReminder');
    assert.equal(sentMessages[0].templateId, 'tmpl_sqlite_wipe_reminder');
    assert.match(reminderWipe.wechatReminderSent.one_hour_before, /^\d{4}-\d{2}-\d{2}T/);
    assert.equal(
      reminderNotifications.some((notification) => (
        notification.type === 'wipe_reminder' &&
        notification.applicationId === 'wipe_sqlite_wechat_reminder' &&
        notification.templateKey === 'wipeReminder'
      )),
      true
    );
    assert.equal(afterStat.mtimeMs, beforeStat.mtimeMs);
    assert.equal(afterStatus.metrics.writes.total, beforeStatus.metrics.writes.total);
    assert.equal(afterStatus.metrics.sqliteWrites, beforeStatus.metrics.sqliteWrites);
    assert.equal(writeCount(afterStatus, 'wechat_wipe_reminder'), beforeReminderWrite + 1);
    assert.equal(queryCount(afterStatus, 'list_members'), beforeFullReads.members);
    assert.equal(queryCount(afterStatus, 'list_wipes'), beforeFullReads.wipes);
    assert.equal(queryCount(afterStatus, 'list_wechatUsers'), beforeFullReads.wechatUsers);
    assert.equal(queryCount(afterStatus, 'get_wipes') > beforeScopedReads.wipeById, true);
    assert.equal(queryCount(afterStatus, 'get_members'), beforeScopedReads.membersById);
    assert.equal(queryCount(afterStatus, 'list_members_memberStatus') > beforeScopedReads.membersByStatus, true);
    assert.equal(queryCount(afterStatus, 'list_members_memberStatus_missing') > beforeScopedReads.membersMissingStatus, true);
    assert.equal(queryCount(afterStatus, 'list_wechatUsers_memberId') > beforeScopedReads.wechatUsersByMember, true);

    const beforeRepeatStatus = await storeModule.storeRuntimeStatus();
    sentMessages.length = 0;
    const repeatResult = await apiModule.triggerWechatWipeReminder('wipe_sqlite_wechat_reminder', 'one_hour_before', {
      nowMs: reminderNowMs,
      sendOne: async (message) => {
        sentMessages.push(message);
        return { ok: true };
      }
    });
    const afterRepeatStatus = await storeModule.storeRuntimeStatus();
    assert.deepEqual(repeatResult, { sent: 0, failed: 0 });
    assert.equal(sentMessages.length, 0);
    assert.equal(writeCount(afterRepeatStatus, 'wechat_wipe_reminder'), writeCount(beforeRepeatStatus, 'wechat_wipe_reminder'));
    assert.equal(afterRepeatStatus.metrics.writes.total, beforeRepeatStatus.metrics.writes.total);
    assert.equal(afterRepeatStatus.metrics.sqliteWrites, beforeRepeatStatus.metrics.sqliteWrites);

    await repositoryModule.writeSqliteStorePatch({
      reason: 'sqlite_test_wechat_wipe_reminder_retry_seed',
      upserts: {
        members: [{
          id: 'member_sqlite_wechat_reminder_retry',
          steamId: '76561198009999992',
          rawInput: '76561198009999992',
          steamNickname: 'SQLite Reminder Retry Member',
          memberStatus: 'active',
          createdAt,
          updatedAt: createdAt
        }],
        wechatUsers: [{
          id: 'wechat_user_sqlite_reminder_retry',
          openid: 'openid_sqlite_reminder_retry',
          nickname: 'SQLite Reminder Retry',
          status: 'approved',
          role: 'member',
          memberId: 'member_sqlite_wechat_reminder_retry',
          subscriptionPreferences: {
            wipeReminder: {
              status: 'accept',
              templateId: 'tmpl_sqlite_wipe_reminder',
              updatedAt: createdAt
            }
          },
          createdAt,
          updatedAt: createdAt,
          lastLoginAt: createdAt
        }],
        wipes: [{
          ...reminderWipe,
          id: retryWipeId,
          wechatReminderSent: {},
          wechatReminderDelivery: {},
          updatedAt: createdAt
        }]
      }
    });
    const partialAttemptRecipients = [];
    const partialResult = await apiModule.triggerWechatWipeReminder(retryWipeId, 'one_hour_before', {
      nowMs: reminderNowMs,
      sendOne: async (message) => {
        partialAttemptRecipients.push(message.wechatUserId);
        if (message.wechatUserId === 'wechat_user_sqlite_reminder_retry') {
          throw new Error('temporary reminder provider failure');
        }
        return { ok: true };
      }
    });
    assert.deepEqual(partialResult, { sent: 1, failed: 1 });
    assert.deepEqual(partialAttemptRecipients.sort(), [
      'wechat_user_sqlite_reminder',
      'wechat_user_sqlite_reminder_retry'
    ]);
    let retryNotifications = await repositoryModule.getSqliteRecordsByJsonField(
      'wechatNotifications',
      'wechatUserId',
      ['wechat_user_sqlite_reminder_retry'],
      { limit: 0 }
    );
    assert.equal(retryNotifications.filter((item) => item.type === 'wipe_reminder').length, 1);
    let partialWipe = await repositoryModule.getSqliteRecord('wipes', retryWipeId);
    assert.equal(Boolean(partialWipe.wechatReminderSent?.one_hour_before), false);
    assert.deepEqual(partialWipe.wechatReminderDelivery.one_hour_before.terminalWechatUserIds, ['wechat_user_sqlite_reminder']);

    const retryAttemptRecipients = [];
    const retryResult = await apiModule.triggerWechatWipeReminder(retryWipeId, 'one_hour_before', {
      nowMs: reminderNowMs,
      sendOne: async (message) => {
        retryAttemptRecipients.push(message.wechatUserId);
        return { ok: true };
      }
    });
    assert.deepEqual(retryResult, { sent: 1, failed: 0 });
    assert.deepEqual(retryAttemptRecipients, ['wechat_user_sqlite_reminder_retry']);
    retryNotifications = await repositoryModule.getSqliteRecordsByJsonField(
      'wechatNotifications',
      'wechatUserId',
      ['wechat_user_sqlite_reminder_retry'],
      { limit: 0 }
    );
    assert.equal(retryNotifications.filter((item) => item.type === 'wipe_reminder').length, 1);
    partialWipe = await repositoryModule.getSqliteRecord('wipes', retryWipeId);
    assert.match(partialWipe.wechatReminderSent.one_hour_before, /^\d{4}-\d{2}-\d{2}T/);

    const markerFailureWipeId = 'wipe_sqlite_wechat_reminder_marker_failure';
    await repositoryModule.writeSqliteStorePatch({
      reason: 'sqlite_test_wechat_wipe_reminder_marker_failure_seed',
      upserts: {
        wipes: [{
          ...partialWipe,
          id: markerFailureWipeId,
          wechatReminderSent: {},
          wechatReminderDelivery: {},
          updatedAt: createdAt
        }]
      }
    });
    repositoryModule.injectSqliteStorePatchFailureForTests('wechat_wipe_reminder_delivery', 1);
    let markerFailureSendCount = 0;
    await assert.rejects(
      () => apiModule.triggerWechatWipeReminder(markerFailureWipeId, 'one_hour_before', {
        nowMs: reminderNowMs,
        sendOne: async () => {
          markerFailureSendCount += 1;
          return { ok: true };
        }
      }),
      /Injected sqlite patch failure for wechat_wipe_reminder_delivery/
    );
    assert.equal(markerFailureSendCount, 2);
    const markerRetryResult = await apiModule.triggerWechatWipeReminder(markerFailureWipeId, 'one_hour_before', {
      nowMs: reminderNowMs,
      sendOne: async () => {
        markerFailureSendCount += 1;
        return { ok: true };
      }
    });
    assert.deepEqual(markerRetryResult, { sent: 0, failed: 0 });
    assert.equal(markerFailureSendCount, 2);
    const reconciledMarkerWipe = await repositoryModule.getSqliteRecord('wipes', markerFailureWipeId);
    assert.match(reconciledMarkerWipe.wechatReminderSent.one_hour_before, /^\d{4}-\d{2}-\d{2}T/);
    assert.deepEqual(
      [...reconciledMarkerWipe.wechatReminderDelivery.one_hour_before.deliveredWechatUserIds].sort(),
      ['wechat_user_sqlite_reminder', 'wechat_user_sqlite_reminder_retry']
    );

    const uncertainWipeId = 'wipe_sqlite_wechat_reminder_uncertain';
    await repositoryModule.writeSqliteStorePatch({
      reason: 'sqlite_test_wechat_wipe_reminder_uncertain_seed',
      upserts: {
        wipes: [{
          ...partialWipe,
          id: uncertainWipeId,
          wechatReminderSent: {},
          wechatReminderDelivery: {},
          updatedAt: createdAt
        }]
      }
    });
    repositoryModule.injectSqliteStorePatchFailureForTests('wechat_subscribe_message_ref_result', 1);
    repositoryModule.injectSqliteStorePatchFailureForTests('wechat_wipe_reminder_delivery', 1);
    let uncertainSendCount = 0;
    await assert.rejects(
      () => apiModule.triggerWechatWipeReminder(uncertainWipeId, 'one_hour_before', {
        nowMs: reminderNowMs,
        sendOne: async () => {
          uncertainSendCount += 1;
          return { ok: true };
        }
      }),
      /Injected sqlite patch failure for wechat_wipe_reminder_delivery/
    );
    assert.equal(uncertainSendCount, 2);
    const uncertainRetryResult = await apiModule.triggerWechatWipeReminder(uncertainWipeId, 'one_hour_before', {
      nowMs: reminderNowMs,
      sendOne: async () => {
        uncertainSendCount += 1;
        return { ok: true };
      }
    });
    assert.deepEqual(uncertainRetryResult, { sent: 0, failed: 0 });
    assert.equal(uncertainSendCount, 2);
    const uncertainWipe = await repositoryModule.getSqliteRecord('wipes', uncertainWipeId);
    assert.deepEqual(
      [...uncertainWipe.wechatReminderDelivery.one_hour_before.uncertainWechatUserIds].sort(),
      ['wechat_user_sqlite_reminder', 'wechat_user_sqlite_reminder_retry']
    );
    const uncertainRefs = await repositoryModule.getSqliteRecordsByJsonField(
      'integrationMessageRefs',
      'targetId',
      [uncertainWipeId],
      { limit: 0 }
    );
    assert.equal(uncertainRefs.filter((ref) => ref.status === 'active').length, 2);
    assert.equal(uncertainRefs.every((ref) => ref.metadata.reminderKey === 'one_hour_before'), true);
    assert.equal(uncertainRefs.every((ref) => String(ref.messageId).startsWith('wechat_outbox_')), true);
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

test('sqlite-primary member base scoped write avoids broad member collections', async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'nb-clan-member-base-scoped-write-'));
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
    const storeModule = await uniqueImport('../server/store.js');
    const memberStoreModule = await uniqueImport('../server/member-store.js');
    const repositoryModule = await uniqueImport('../server/storage/repository.js');
    const { ensureStore, updateStore, storeRuntimeStatus } = storeModule;
    await ensureStore();
    const createdAt = new Date().toISOString();
    await updateStore((store) => {
      store.users.push({
        id: 'user_member_base_scoped',
        username: 'member_base_scoped',
        role: 'leader',
        boundSteamId: '76561198001000101',
        steamNickname: 'Scoped Leader',
        createdAt,
        updatedAt: createdAt
      });
      store.members.push({
        id: 'member_base_scoped',
        steamId: '76561198001000101',
        rawInput: '76561198001000101',
        customName: '',
        steamNickname: 'Scoped Old',
        avatar: '',
        discordId: '',
        wechatId: '',
        wechatUserId: '',
        notes: '',
        specialty: [],
        memberStatus: 'active',
        invitedByUserId: 'user_member_base_scoped',
        createdAt,
        updatedAt: createdAt
      });
      store.squads.push({
        id: 'squad_member_base_scoped',
        name: 'Scoped Squad',
        leaderUserId: 'user_member_base_scoped',
        leaderUserIds: ['user_member_base_scoped'],
        notes: '',
        createdBy: 'user_member_base_scoped',
        createdAt,
        updatedAt: createdAt,
        archivedAt: ''
      });
    });

    const beforeStatus = await storeRuntimeStatus({ sqliteSummary: false });
    const beforeBroadReads = {
      users: queryCount(beforeStatus, 'list_users'),
      members: queryCount(beforeStatus, 'list_members'),
      squads: queryCount(beforeStatus, 'list_squads'),
      squadMembers: queryCount(beforeStatus, 'list_squadMembers')
    };
    const beforeScopedReads = {
      usersById: queryCount(beforeStatus, 'list_users_id'),
      membersById: queryCount(beforeStatus, 'list_members_id'),
      squadsById: queryCount(beforeStatus, 'list_squads_id'),
      squadMembersByMemberId: queryCount(beforeStatus, 'list_squadMembers_memberId'),
      squadMembersBySquadId: queryCount(beforeStatus, 'list_squadMembers_squadId')
    };

    await memberStoreModule.updateMemberBaseWriteStore((store) => {
      const member = store.members.find((item) => item.id === 'member_base_scoped');
      assert.ok(member);
      member.steamNickname = 'Scoped Updated';
      member.updatedAt = createdAt;
      store.squadMembers.push({
        id: 'squad_member_base_scoped_relation',
        squadId: 'squad_member_base_scoped',
        memberId: 'member_base_scoped',
        addedByUserId: 'user_member_base_scoped',
        createdAt
      });
    }, 'member_base_scoped_write_test', {
      userIds: ['user_member_base_scoped'],
      memberIds: ['member_base_scoped'],
      squadIds: ['squad_member_base_scoped']
    });

    const afterStatus = await storeRuntimeStatus({ sqliteSummary: false });
    assert.equal(queryCount(afterStatus, 'list_users'), beforeBroadReads.users);
    assert.equal(queryCount(afterStatus, 'list_members'), beforeBroadReads.members);
    assert.equal(queryCount(afterStatus, 'list_squads'), beforeBroadReads.squads);
    assert.equal(queryCount(afterStatus, 'list_squadMembers'), beforeBroadReads.squadMembers);
    assert.equal(queryCount(afterStatus, 'list_users_id') > beforeScopedReads.usersById, true);
    assert.equal(queryCount(afterStatus, 'list_members_id') > beforeScopedReads.membersById, true);
    assert.equal(queryCount(afterStatus, 'list_squads_id') > beforeScopedReads.squadsById, true);
    assert.equal(queryCount(afterStatus, 'list_squadMembers_memberId') > beforeScopedReads.squadMembersByMemberId, true);
    assert.equal(queryCount(afterStatus, 'list_squadMembers_squadId') > beforeScopedReads.squadMembersBySquadId, true);

    const updatedMember = await repositoryModule.getSqliteRecord('members', 'member_base_scoped');
    assert.equal(updatedMember.steamNickname, 'Scoped Updated');
    const scopedRelations = await repositoryModule.getSqliteRecordsByJsonField('squadMembers', 'memberId', ['member_base_scoped'], { limit: 0 });
    assert.equal(scopedRelations.some((relation) => relation.id === 'squad_member_base_scoped_relation'), true);

    const beforeMissingScopeStatus = await storeRuntimeStatus({ sqliteSummary: false });
    await assert.rejects(
      () => memberStoreModule.updateMemberBaseWriteStore(() => {}, 'member_base_missing_scope_test', {
        requireScopedMemberBaseWrite: true
      }),
      (error) => error?.status === 503 && error?.code === 'member_base_scoped_write_unavailable'
    );
    const afterMissingScopeStatus = await storeRuntimeStatus({ sqliteSummary: false });
    assert.equal(queryCount(afterMissingScopeStatus, 'list_users'), queryCount(beforeMissingScopeStatus, 'list_users'));
    assert.equal(queryCount(afterMissingScopeStatus, 'list_members'), queryCount(beforeMissingScopeStatus, 'list_members'));
    assert.equal(queryCount(afterMissingScopeStatus, 'list_squads'), queryCount(beforeMissingScopeStatus, 'list_squads'));
    assert.equal(queryCount(afterMissingScopeStatus, 'list_squadMembers'), queryCount(beforeMissingScopeStatus, 'list_squadMembers'));
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

test('sqlite-primary Discord membership audit uses direct SQLite patch writes', async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'nb-clan-sqlite-discord-audit-'));
  const previousEnv = {
    NB_DATA_DIR: process.env.NB_DATA_DIR,
    NB_ROOT_PASSWORD: process.env.NB_ROOT_PASSWORD,
    NB_STORAGE_MODE: process.env.NB_STORAGE_MODE,
    NB_SQLITE_FILE: process.env.NB_SQLITE_FILE,
    NB_DISABLE_BACKGROUND_JOBS: process.env.NB_DISABLE_BACKGROUND_JOBS,
    NB_DISABLE_EXTERNAL_VITAL: process.env.NB_DISABLE_EXTERNAL_VITAL,
    NB_RUSTPLUS_RELAY_CHAT_FLUSH_INTERVAL_MS: process.env.NB_RUSTPLUS_RELAY_CHAT_FLUSH_INTERVAL_MS,
    NB_DISCORD_API_BASE_URL: process.env.NB_DISCORD_API_BASE_URL
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
  let discordServer = null;
  try {
    const guildId = '123456789012345670';
    const expectedRoleId = '123456789012345673';
    const validDiscordId = '123456789012345681';
    const missingRoleDiscordId = '123456789012345682';
    const notInGuildDiscordId = '123456789012345683';
    const discordMemberRequests = [];
    const discordApp = express();
    discordApp.get('/guilds/:guildId/members/:userId', (req, res) => {
      discordMemberRequests.push({
        guildId: req.params.guildId,
        userId: req.params.userId,
        authorization: req.get('authorization') || ''
      });
      if (req.params.userId === notInGuildDiscordId) {
        res.status(404).json({ message: 'Unknown Member' });
        return;
      }
      res.json({
        user: { id: req.params.userId },
        roles: req.params.userId === validDiscordId ? [expectedRoleId] : ['123456789012345699']
      });
    });
    discordApp.get('/guilds/:guildId/roles', (req, res) => {
      res.json([
        { id: expectedRoleId, name: 'NB Required Role' },
        { id: '123456789012345699', name: 'NB Current Role' }
      ]);
    });
    discordServer = createServer(discordApp);
    await new Promise((resolve) => discordServer.listen(0, '127.0.0.1', resolve));
    process.env.NB_DISCORD_API_BASE_URL = `http://127.0.0.1:${discordServer.address().port}`;

    const storeModule = await uniqueImport('../server/store.js');
    const apiModule = await uniqueImport('../server/api.js');
    const authModule = await uniqueImport('../server/auth.js');
    await storeModule.ensureStore();
    const repositoryModule = await import('../server/storage/repository.js');
    const createdAt = '2026-07-08T00:00:00.000Z';
    await storeModule.updateStore((store) => {
      store.settings.discord ||= {};
      store.settings.discord.botToken = 'discord_bot_token_sqlite_audit_1234567890';
      store.settings.discord.guildId = guildId;
      store.settings.discord.memberRegisterRoleId = expectedRoleId;
      store.settings.discord.memberRegisterSquadName = 'NB';
      store.members.push(
        {
          id: 'member_sqlite_discord_audit_valid',
          steamId: '76561198009999001',
          rawInput: '76561198009999001',
          customName: 'SQLite Audit Valid',
          steamNickname: 'SQLite Audit Valid',
          avatar: '',
          discordId: validDiscordId,
          discordName: 'AuditValid',
          wechatId: '',
          wechatUserId: '',
          notes: '',
          specialty: [],
          memberStatus: 'active',
          invitedByUserId: 'user_root',
          createdAt,
          updatedAt: createdAt
        },
        {
          id: 'member_sqlite_discord_audit_missing_role',
          steamId: '76561198009999002',
          rawInput: '76561198009999002',
          customName: 'SQLite Audit Missing Role',
          steamNickname: 'SQLite Audit Missing Role',
          avatar: '',
          discordId: missingRoleDiscordId,
          discordName: 'AuditMissingRole',
          wechatId: '',
          wechatUserId: '',
          notes: '',
          specialty: [],
          memberStatus: 'active',
          invitedByUserId: 'user_root',
          createdAt,
          updatedAt: createdAt
        },
        {
          id: 'member_sqlite_discord_audit_not_in_guild',
          steamId: '76561198009999003',
          rawInput: '76561198009999003',
          customName: 'SQLite Audit Not In Guild',
          steamNickname: 'SQLite Audit Not In Guild',
          avatar: '',
          discordId: notInGuildDiscordId,
          discordName: 'AuditNotInGuild',
          wechatId: '',
          wechatUserId: '',
          notes: '',
          specialty: [],
          memberStatus: 'active',
          invitedByUserId: 'user_root',
          createdAt,
          updatedAt: createdAt
        },
        {
          id: 'member_sqlite_discord_audit_no_discord',
          steamId: '76561198009999004',
          rawInput: '76561198009999004',
          customName: 'SQLite Audit No Discord',
          steamNickname: 'SQLite Audit No Discord',
          avatar: '',
          discordId: '',
          discordName: '',
          wechatId: '',
          wechatUserId: '',
          notes: '',
          specialty: [],
          memberStatus: 'active',
          invitedByUserId: 'user_root',
          createdAt,
          updatedAt: createdAt
        }
      );
    });

    const app = express();
    app.use('/api', apiModule.createApiRouter());
    server = createServer(app);
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const baseUrl = `http://127.0.0.1:${server.address().port}/api`;
    const sessionId = await authModule.createSession('user_root');
    const cookie = `nb_session=${encodeURIComponent(sessionId)}`;
    const writeCount = (status, name) => status.sqlite?.writes?.byName?.[name]?.total || 0;
    const beforeStatus = await storeModule.storeRuntimeStatus();
    const beforeStat = await stat(storeModule.STORE_FILE);
    const beforeAuditWrites = writeCount(beforeStatus, 'discord_member_audit');

    const response = await httpFetch(`${baseUrl}/discord/member-audit/run`, {
      method: 'POST',
      headers: {
        cookie,
        'content-type': 'application/json'
      },
      body: JSON.stringify({})
    });
    const payload = await response.json();
    assert.equal(response.status, 200, JSON.stringify(payload));
    assert.equal(payload.summary.checked, 3);
    assert.equal(payload.summary.valid, 1);
    assert.equal(payload.summary.notInGuild, 1);
    assert.equal(payload.summary.missingRole, 1);
    assert.equal(payload.summary.failed, 0);
    assert.equal(payload.summary.skipped, 1);
    assert.equal(discordMemberRequests.length, 3);
    assert.equal(discordMemberRequests.every((item) => item.guildId === guildId), true);
    assert.equal(discordMemberRequests.every((item) => item.authorization === 'Bot discord_bot_token_sqlite_audit_1234567890'), true);
    const missingRoleCandidate = payload.candidates.find((item) => item.member.id === 'member_sqlite_discord_audit_missing_role');
    assert.deepEqual(missingRoleCandidate.audit.expectedRoles, [{ id: expectedRoleId, name: 'NB Required Role' }]);
    assert.deepEqual(missingRoleCandidate.audit.actualRoles, [{ id: '123456789012345699', name: 'NB Current Role' }]);

    const afterStatus = await storeModule.storeRuntimeStatus();
    const afterStat = await stat(storeModule.STORE_FILE);
    const validMember = await repositoryModule.getSqliteRecord('members', 'member_sqlite_discord_audit_valid');
    const missingRoleMember = await repositoryModule.getSqliteRecord('members', 'member_sqlite_discord_audit_missing_role');
    const notInGuildMember = await repositoryModule.getSqliteRecord('members', 'member_sqlite_discord_audit_not_in_guild');
    const settings = await repositoryModule.getSqliteScalar('settings');
    const logs = await repositoryModule.getSqliteCollection('logs', { limit: 0 });
    assert.equal(validMember.discordMembershipStatus, 'valid');
    assert.equal(missingRoleMember.discordMembershipStatus, 'missing_role');
    assert.equal(notInGuildMember.discordMembershipStatus, 'not_in_guild');
    assert.deepEqual(missingRoleMember.discordMembershipExpectedRoleNames, ['NB Required Role']);
    assert.deepEqual(missingRoleMember.discordMembershipActualRoleNames, ['NB Current Role']);
    assert.equal(settings.discord.memberAudit.checked, 3);
    assert.equal(settings.discord.memberAudit.flagged, 2);
    assert.equal(logs.some((log) => log.type === 'discord_member_audit' && log.metadata?.checked === 3), true);
    assert.equal(afterStat.mtimeMs, beforeStat.mtimeMs);
    assert.equal(afterStatus.metrics.writes.total, beforeStatus.metrics.writes.total);
    assert.equal(afterStatus.metrics.sqliteWrites, beforeStatus.metrics.sqliteWrites);
    assert.equal(writeCount(afterStatus, 'discord_member_audit'), beforeAuditWrites + 1);
  } finally {
    if (server) await new Promise((resolve) => server.close(resolve));
    if (discordServer) await new Promise((resolve) => discordServer.close(resolve));
    const sqliteModule = await import('../server/storage/sqlite.js');
    await sqliteModule.closeSqliteDatabasesForTests();
    Object.assign(process.env, previousEnv);
    for (const [key, value] of Object.entries(previousEnv)) {
      if (value === undefined) delete process.env[key];
    }
    await rm(dataDir, { recursive: true, force: true });
  }
});

test('sqlite-primary Discord member registration submit uses direct SQLite patch writes', async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'nb-clan-sqlite-discord-member-register-'));
  const previousEnv = {
    NB_DATA_DIR: process.env.NB_DATA_DIR,
    NB_ROOT_PASSWORD: process.env.NB_ROOT_PASSWORD,
    NB_STORAGE_MODE: process.env.NB_STORAGE_MODE,
    NB_SQLITE_FILE: process.env.NB_SQLITE_FILE,
	    NB_DISCORD_API_BASE_URL: process.env.NB_DISCORD_API_BASE_URL,
	    NB_DISABLE_BACKGROUND_JOBS: process.env.NB_DISABLE_BACKGROUND_JOBS,
	    NB_DISABLE_EXTERNAL_VITAL: process.env.NB_DISABLE_EXTERNAL_VITAL,
	    NB_DISCORD_WIPE_ATTENDANCE_REFRESH_DEBOUNCE_MS: process.env.NB_DISCORD_WIPE_ATTENDANCE_REFRESH_DEBOUNCE_MS,
	    NB_RUSTPLUS_RELAY_CHAT_FLUSH_INTERVAL_MS: process.env.NB_RUSTPLUS_RELAY_CHAT_FLUSH_INTERVAL_MS
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

  let server = null;
  let discordServer = null;
  const discordReviewPosts = [];
  const discordKeys = crypto.generateKeyPairSync('ed25519');
  const publicKeyDer = discordKeys.publicKey.export({ type: 'spki', format: 'der' });
  const discordPublicKey = Buffer.from(publicKeyDer).subarray(-32).toString('hex');
  const roleId = '123456789012390001';
  const discordUserId = '123456789012390002';
  const reviewChannelId = '123456789012390003';
  const targetSteamId = '76561198002000001';

  try {
    globalThis.fetch = async (url, options) => {
      const urlText = String(url || '');
      if (urlText.includes(`steamcommunity.com/profiles/${targetSteamId}`)) {
        return {
          ok: true,
          text: async () => [
            '<profile>',
            `<steamID64>${targetSteamId}</steamID64>`,
            '<steamID><![CDATA[SQLite Register Steam]]></steamID>',
            '<avatarFull><![CDATA[https://example.com/sqlite-register-avatar.png]]></avatarFull>',
            '<privacyState>public</privacyState>',
            '</profile>'
          ].join('')
        };
      }
      return originalFetch(url, options);
    };

    const discordApp = express();
    discordApp.use(express.json());
    discordApp.post('/channels/:channelId/messages', (req, res) => {
      const messageId = `sqlite_register_review_${discordReviewPosts.length + 1}`;
      discordReviewPosts.push({
        channelId: req.params.channelId,
        authorization: req.get('authorization') || '',
        body: req.body,
        messageId
      });
      res.json({
        id: messageId,
        channel_id: req.params.channelId
      });
    });
    discordServer = createServer(discordApp);
    await new Promise((resolve) => discordServer.listen(0, '127.0.0.1', resolve));
    process.env.NB_DISCORD_API_BASE_URL = `http://127.0.0.1:${discordServer.address().port}`;

    const storeModule = await uniqueImport('../server/store.js');
    const apiModule = await uniqueImport('../server/api.js');
    const repositoryModule = await import('../server/storage/repository.js');
    const traceModule = await import('../server/trace-record-persistence.js');
    await storeModule.ensureStore();
    traceModule.resetTraceRecordPersistenceForTests();
    const createdAt = '2026-07-08T00:00:00.000Z';
    await storeModule.updateStore((store) => {
      store.settings.discord = {
        ...(store.settings.discord || {}),
        botToken: 'sqlite_discord_register_bot_token',
        publicKey: discordPublicKey,
        guildId: '123456789012390004',
        applicationId: '123456789012390005',
        memberReviewChannelId: reviewChannelId,
        memberRegisterRoleId: roleId,
        memberRegisterSquadName: 'Fallback Squad',
        memberRegisterRoleSquadRules: [{
          id: 'sqlite_register_rule',
          roleId,
          squadId: 'squad_sqlite_discord_register'
        }]
      };
      store.squads.unshift({
        id: 'squad_sqlite_discord_register',
        name: 'NB-EU',
        leaderUserIds: [],
        createdAt,
        updatedAt: createdAt
      });
    });

    const app = express();
    app.use('/api', apiModule.createApiRouter());
    server = createServer(app);
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const baseUrl = `http://127.0.0.1:${server.address().port}/api`;
    const postDiscordInteraction = (body) => {
      const rawBody = JSON.stringify(body);
      const timestamp = String(Math.floor(Date.now() / 1000));
      const signature = crypto
        .sign(null, Buffer.concat([Buffer.from(timestamp), Buffer.from(rawBody)]), discordKeys.privateKey)
        .toString('hex');
      return httpFetch(`${baseUrl}/integrations/discord/interactions`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-signature-ed25519': signature,
          'x-signature-timestamp': timestamp
        },
        body: rawBody
      });
    };
    const queryCount = (status, name) => status.sqlite?.queries?.byName?.[name]?.total || 0;
    const sqliteWriteCount = (status, name) => status.sqlite?.writes?.byName?.[name]?.total || 0;
    const storeWriteCount = (status, name) => status.metrics?.writes?.byName?.[name]?.total || 0;

    repositoryModule.injectSqliteStorePatchFailureForTests('integration_event_create', 2);
    const pingResponse = await postDiscordInteraction({
      type: 1,
      id: 'sqlite_discord_ping_integration_event_failure',
      application_id: '123456789012390005',
      token: 'sqlite_register_ping_token'
    });
    assert.equal(pingResponse.status, 200);
    const pingPayload = await pingResponse.json();
    assert.equal(pingPayload.type, 1);
    const pingTraceRecord = traceModule.traceRecordPersistenceSnapshot().records
      .find((item) => item.name === 'integration_event_create');
    assert.equal(pingTraceRecord?.fallbackSuppressed, 1);
    assert.equal(discordReviewPosts.length, 0);
    traceModule.resetTraceRecordPersistenceForTests();

    const beforeFailureStatus = await storeModule.storeRuntimeStatus({ sqliteSummary: false });
    const beforeFailureReadStoreFull = queryCount(beforeFailureStatus, 'read_store_full');
    repositoryModule.injectSqliteStorePatchFailureForTests('discord_member_application_submit', 1);
    const failedResponse = await postDiscordInteraction({
      type: 5,
      application_id: '123456789012390005',
      token: 'sqlite_register_submit_failure_token',
      locale: 'en-US',
      guild_id: '123456789012390004',
      channel_id: '123456789012390006',
      member: {
        roles: [roleId],
        permissions: '0',
        user: { id: discordUserId, username: 'SQLiteRegisterUser', avatar: 'sqlite_register_avatar' }
      },
      data: {
        custom_id: 'nb_member_register:submit:pvp:none',
        components: [
          { type: 18, component: { type: 4, custom_id: 'steam_input', value: targetSteamId } }
        ]
      }
    });
    assert.equal(failedResponse.status, 200);
    const failedPayload = await failedResponse.json();
    assert.equal(failedPayload.type, 4);
    assert.match(failedPayload.data.content, /Discord 成员申请写入暂不可用/);
    const afterFailureStatus = await storeModule.storeRuntimeStatus({ sqliteSummary: false });
    assert.equal(queryCount(afterFailureStatus, 'read_store_full'), beforeFailureReadStoreFull);
    const failedApplications = await repositoryModule.getSqliteRecordsByJsonField(
      'discordMemberApplications',
      'discordUserId',
      [discordUserId],
      { limit: 0 }
    );
    assert.equal(failedApplications.length, 0);

    const beforeStatus = await storeModule.storeRuntimeStatus({ sqliteSummary: false });
    const beforeStat = await stat(storeModule.STORE_FILE);

    const response = await postDiscordInteraction({
      type: 5,
      application_id: '123456789012390005',
      token: 'sqlite_register_submit_token',
      locale: 'en-US',
      guild_id: '123456789012390004',
      channel_id: '123456789012390006',
      member: {
        roles: [roleId],
        permissions: '0',
        user: { id: discordUserId, username: 'SQLiteRegisterUser', avatar: 'sqlite_register_avatar' }
      },
      data: {
        custom_id: 'nb_member_register:submit:pvp:none',
        components: [
          { type: 18, component: { type: 4, custom_id: 'steam_input', value: targetSteamId } }
        ]
      }
    });
    assert.equal(response.status, 200);
    const payload = await response.json();
    assert.equal(payload.type, 4);
    assert.match(payload.data.content, /Registration completed automatically/);
    await apiModule.drainBackgroundTaskQueuesForTests({ timeoutMs: 5000 });

    const afterStat = await stat(storeModule.STORE_FILE);
    const afterStatus = await storeModule.storeRuntimeStatus({ sqliteSummary: false });
    const applications = await repositoryModule.getSqliteCollection('discordMemberApplications', { limit: 0 });
    const application = applications.find((item) => item.discordUserId === discordUserId);
    const logs = await repositoryModule.getSqliteCollection('logs', { limit: 0 });

    assert.equal(afterStat.mtimeMs, beforeStat.mtimeMs);
    assert.equal(afterStatus.metrics.writes.total, beforeStatus.metrics.writes.total);
    assert.equal(afterStatus.metrics.sqliteWrites, beforeStatus.metrics.sqliteWrites);
    assert.equal(storeWriteCount(afterStatus, 'write_store_sqlite_patch'), storeWriteCount(beforeStatus, 'write_store_sqlite_patch'));
    assert.equal(sqliteWriteCount(afterStatus, 'discord_member_application_submit'), sqliteWriteCount(beforeStatus, 'discord_member_application_submit') + 1);
    assert.equal(sqliteWriteCount(afterStatus, 'discord_member_application_review'), sqliteWriteCount(beforeStatus, 'discord_member_application_review') + 1);
    assert.equal(sqliteWriteCount(afterStatus, 'discord_member_review_card_push_result'), sqliteWriteCount(beforeStatus, 'discord_member_review_card_push_result') + 1);
    assert.equal(queryCount(afterStatus, 'list_members'), queryCount(beforeStatus, 'list_members'));
    assert.equal(queryCount(afterStatus, 'list_members_steamId') > queryCount(beforeStatus, 'list_members_steamId'), true);
    assert.equal(queryCount(afterStatus, 'list_members_discordId') > queryCount(beforeStatus, 'list_members_discordId'), true);
    assert.equal(queryCount(afterStatus, 'list_discordMemberApplications_steamId') > queryCount(beforeStatus, 'list_discordMemberApplications_steamId'), true);
    assert.equal(queryCount(afterStatus, 'list_discordMemberApplications_discordUserId') > queryCount(beforeStatus, 'list_discordMemberApplications_discordUserId'), true);
    assert.equal(Boolean(application), true);
    assert.equal(application.steamId, targetSteamId);
    assert.equal(application.steamNickname, 'SQLite Register Steam');
    assert.equal(application.discordAvatarUrl, `https://cdn.discordapp.com/avatars/${discordUserId}/sqlite_register_avatar.png?size=128`);
    assert.equal(application.squadId, 'squad_sqlite_discord_register');
    assert.equal(application.squadName, 'NB-EU');
    assert.equal(application.status, 'approved');
    assert.equal(Boolean(application.memberId), true);
    assert.equal(application.adminReviewChannelId, reviewChannelId);
    assert.equal(application.adminReviewMessageId, 'sqlite_register_review_1');
    assert.equal(discordReviewPosts.length, 1);
    assert.equal(discordReviewPosts[0].channelId, reviewChannelId);
    assert.equal(discordReviewPosts[0].authorization, 'Bot sqlite_discord_register_bot_token');
    assert.equal(discordReviewPosts[0].body.embeds[0].title, 'Clan Portal Member Registration');
    assert.equal(discordReviewPosts[0].body.embeds[0].fields.find((field) => field.name === 'Steam nickname').value, 'SQLite Register Steam');
    assert.equal(discordReviewPosts[0].body.embeds[0].fields.find((field) => field.name === 'Status').value, 'Approved');
    assert.equal(discordReviewPosts[0].body.components[1].components[0].custom_id, `nb_member_review:remove:${application.id}`);
    assert.equal(discordReviewPosts[0].body.components[1].components[0].disabled, false);
    assert.equal(logs.some((log) => log.type === 'discord_member_application_submit' && log.targetId === application.id), true);
    assert.equal(logs.some((log) => log.type === 'discord_member_application_auto_approve' && log.targetId === application.id), true);
    assert.equal(logs.some((log) => log.type === 'discord_member_review_card_push' && log.targetId === application.id), true);
  } finally {
    if (server) await new Promise((resolve) => server.close(resolve));
    if (discordServer) await new Promise((resolve) => discordServer.close(resolve));
    const sqliteModule = await import('../server/storage/sqlite.js');
    await sqliteModule.closeSqliteDatabasesForTests();
    globalThis.fetch = originalFetch;
    Object.assign(process.env, previousEnv);
    for (const [key, value] of Object.entries(previousEnv)) {
      if (value === undefined) delete process.env[key];
    }
    await rm(dataDir, { recursive: true, force: true });
  }
});

test('sqlite-primary Discord member remove uses direct SQLite patch writes', async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'nb-clan-sqlite-discord-member-remove-'));
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

  let server = null;
  const discordKeys = crypto.generateKeyPairSync('ed25519');
  const publicKeyDer = discordKeys.publicKey.export({ type: 'spki', format: 'der' });
  const discordPublicKey = Buffer.from(publicKeyDer).subarray(-32).toString('hex');
  const managerRoleId = '123456789012391001';
  const actorDiscordId = '123456789012391002';
  const targetDiscordId = '123456789012391003';
  const targetSteamId = '76561198002000002';

  try {
    const storeModule = await uniqueImport('../server/store.js');
    const apiModule = await uniqueImport('../server/api.js');
    const repositoryModule = await import('../server/storage/repository.js');
    await storeModule.ensureStore();
    const createdAt = '2026-07-08T00:00:00.000Z';
    await storeModule.updateStore((store) => {
      store.settings.discord = {
        ...(store.settings.discord || {}),
        publicKey: discordPublicKey,
        memberManageRoleId: managerRoleId
      };
      store.users.push({
        id: 'user_sqlite_discord_remove',
        username: 'sqlite_discord_remove',
        role: 'member',
        boundSteamId: targetSteamId,
        steamNickname: 'SQLite Remove',
        createdAt,
        updatedAt: createdAt
      });
      store.sessions.push({
        id: 'session_sqlite_discord_remove',
        userId: 'user_sqlite_discord_remove',
        createdAt,
        expiresAt: '2099-01-01T00:00:00.000Z'
      });
      store.members.push({
        id: 'member_sqlite_discord_remove',
        steamId: targetSteamId,
        rawInput: targetSteamId,
        customName: 'SQLite Remove',
        steamNickname: 'SQLite Remove Steam',
        avatar: '',
        discordId: targetDiscordId,
        wechatId: '',
        wechatUserId: '',
        notes: '',
        specialty: [],
        memberStatus: 'active',
        invitedByUserId: '',
        createdAt,
        updatedAt: createdAt
      });
      store.squads.push({
        id: 'squad_sqlite_discord_remove',
        name: 'NB-RM',
        leaderUserIds: [],
        createdAt,
        updatedAt: createdAt
      });
      store.squadMembers.push({
        id: 'squad_member_sqlite_discord_remove',
        squadId: 'squad_sqlite_discord_remove',
        memberId: 'member_sqlite_discord_remove',
        createdAt
      });
      store.wipes.push({
        id: 'wipe_sqlite_discord_remove_active',
        name: 'SQLite Remove Active',
        status: 'active',
        wipeMode: 'current',
        wipeLabel: 'Current',
        wipeAt: createdAt,
        createdAt,
        updatedAt: createdAt
      }, {
        id: 'wipe_sqlite_discord_remove_closed',
        name: 'SQLite Remove Closed',
        status: 'closed',
        wipeMode: 'closed',
        wipeLabel: 'Closed',
        wipeAt: '2026-06-01T00:00:00.000Z',
        closedAt: '2026-06-30T00:00:00.000Z',
        createdAt,
        updatedAt: createdAt
      });
      store.wipeParticipants.push({
        id: 'wipe_participant_sqlite_discord_remove_active',
        wipeId: 'wipe_sqlite_discord_remove_active',
        memberId: 'member_sqlite_discord_remove',
        steamId: targetSteamId,
        squadId: 'squad_sqlite_discord_remove',
        status: 'on_time',
        source: 'test',
        createdAt,
        updatedAt: createdAt
      }, {
        id: 'wipe_participant_sqlite_discord_remove_closed',
        wipeId: 'wipe_sqlite_discord_remove_closed',
        memberId: 'member_sqlite_discord_remove',
        steamId: targetSteamId,
        squadId: 'squad_sqlite_discord_remove',
        status: 'on_time',
        source: 'test',
        createdAt,
        updatedAt: createdAt
      });
      store.kdaRows.push({
        id: 'kda_sqlite_discord_remove_active',
        wipeId: 'wipe_sqlite_discord_remove_active',
        memberId: 'member_sqlite_discord_remove',
        steamId: targetSteamId,
        squadId: 'squad_sqlite_discord_remove',
        kills: 3,
        deaths: 1,
        kda: 3,
        source: 'test',
        syncedAt: createdAt
      }, {
        id: 'kda_sqlite_discord_remove_closed',
        wipeId: 'wipe_sqlite_discord_remove_closed',
        memberId: 'member_sqlite_discord_remove',
        steamId: targetSteamId,
        squadId: 'squad_sqlite_discord_remove',
        kills: 9,
        deaths: 2,
        kda: 4.5,
        source: 'test',
        syncedAt: createdAt
      });
      store.kdaSnapshots.push({
        id: 'kda_snapshot_sqlite_discord_remove_active',
        wipeId: 'wipe_sqlite_discord_remove_active',
        memberId: 'member_sqlite_discord_remove',
        steamId: targetSteamId,
        squadId: 'squad_sqlite_discord_remove',
        kills: 3,
        deaths: 1,
        kda: 3,
        createdAt
      }, {
        id: 'kda_snapshot_sqlite_discord_remove_closed',
        wipeId: 'wipe_sqlite_discord_remove_closed',
        memberId: 'member_sqlite_discord_remove',
        steamId: targetSteamId,
        squadId: 'squad_sqlite_discord_remove',
        kills: 9,
        deaths: 2,
        kda: 4.5,
        createdAt
      });
      store.memberProfiles.push({
        id: 'member_profile_sqlite_discord_remove',
        memberId: 'member_sqlite_discord_remove',
        steamId: targetSteamId,
        playTimeMinutes: 120,
        fetchedAt: createdAt
      });
      store.accountAlertDismissals.push({
        id: 'account_alert_sqlite_discord_remove',
        memberId: 'member_sqlite_discord_remove',
        type: 'discord',
        dismissedAt: createdAt
      });
    });

    const app = express();
    app.use('/api', apiModule.createApiRouter());
    server = createServer(app);
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const baseUrl = `http://127.0.0.1:${server.address().port}/api`;
    const postDiscordInteraction = (body) => {
      const rawBody = JSON.stringify(body);
      const timestamp = String(Math.floor(Date.now() / 1000));
      const signature = crypto
        .sign(null, Buffer.concat([Buffer.from(timestamp), Buffer.from(rawBody)]), discordKeys.privateKey)
        .toString('hex');
      return fetch(`${baseUrl}/integrations/discord/interactions`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-signature-ed25519': signature,
          'x-signature-timestamp': timestamp
        },
        body: rawBody
      });
    };
    const queryCount = (status, name) => status.sqlite?.queries?.byName?.[name]?.total || 0;
    const sqliteWriteCount = (status, name) => status.sqlite?.writes?.byName?.[name]?.total || 0;
    const storeWriteCount = (status, name) => status.metrics?.writes?.byName?.[name]?.total || 0;

    const beforeFailureStatus = await storeModule.storeRuntimeStatus({ sqliteSummary: false });
    const beforeFailureReadStoreFull = queryCount(beforeFailureStatus, 'read_store_full');
    repositoryModule.injectSqliteStorePatchFailureForTests('discord_member_remove', 1);
    const failedResponse = await postDiscordInteraction({
      type: 5,
      application_id: '123456789012391004',
      token: 'sqlite_remove_submit_failure_token',
      locale: 'en-US',
      member: {
        roles: [managerRoleId],
        permissions: '0',
        user: { id: actorDiscordId, username: 'SQLiteRemoveAdmin' }
      },
      data: {
        custom_id: 'nb_member_register:remove_submit',
        components: [
          {
            type: 1,
            components: [
              { type: 4, custom_id: 'discord_id_input', value: targetDiscordId }
            ]
          }
        ]
      }
    });
    assert.equal(failedResponse.status, 200);
    const failedPayload = await failedResponse.json();
    assert.equal(failedPayload.type, 4);
    assert.match(failedPayload.data.content, /Discord 成员移除写入暂不可用/);
    const afterFailureStatus = await storeModule.storeRuntimeStatus({ sqliteSummary: false });
    assert.equal(queryCount(afterFailureStatus, 'read_store_full'), beforeFailureReadStoreFull);
    assert.equal((await repositoryModule.getSqliteRecord('members', 'member_sqlite_discord_remove')).discordId, targetDiscordId);

    const beforeStatus = await storeModule.storeRuntimeStatus({ sqliteSummary: false });
    const beforeStat = await stat(storeModule.STORE_FILE);

    const response = await postDiscordInteraction({
      type: 5,
      application_id: '123456789012391004',
      token: 'sqlite_remove_submit_token',
      locale: 'en-US',
      member: {
        roles: [managerRoleId],
        permissions: '0',
        user: { id: actorDiscordId, username: 'SQLiteRemoveAdmin' }
      },
      data: {
        custom_id: 'nb_member_register:remove_submit',
        components: [
          {
            type: 1,
            components: [
              { type: 4, custom_id: 'discord_id_input', value: targetDiscordId }
            ]
          }
        ]
      }
    });
    assert.equal(response.status, 200);
    const payload = await response.json();
    assert.equal(payload.type, 4);
    assert.match(payload.data.content, /Member removed/);

    const afterStat = await stat(storeModule.STORE_FILE);
    const afterStatus = await storeModule.storeRuntimeStatus({ sqliteSummary: false });
    const logs = await repositoryModule.getSqliteCollection('logs', { limit: 0 });
    assert.equal(afterStat.mtimeMs, beforeStat.mtimeMs);
    assert.equal(afterStatus.metrics.writes.total, beforeStatus.metrics.writes.total);
    assert.equal(afterStatus.metrics.sqliteWrites, beforeStatus.metrics.sqliteWrites);
    assert.equal(storeWriteCount(afterStatus, 'write_store_sqlite_patch'), storeWriteCount(beforeStatus, 'write_store_sqlite_patch'));
    assert.equal(sqliteWriteCount(afterStatus, 'discord_member_remove'), sqliteWriteCount(beforeStatus, 'discord_member_remove') + 1);
    assert.equal(queryCount(afterStatus, 'list_members'), queryCount(beforeStatus, 'list_members'));
    assert.equal(queryCount(afterStatus, 'list_members_discordId') > queryCount(beforeStatus, 'list_members_discordId'), true);
    assert.equal(await repositoryModule.getSqliteRecord('members', 'member_sqlite_discord_remove'), null);
    assert.equal(await repositoryModule.getSqliteRecord('squadMembers', 'squad_member_sqlite_discord_remove'), null);
    assert.equal(await repositoryModule.getSqliteRecord('wipeParticipants', 'wipe_participant_sqlite_discord_remove_active'), null);
    assert.equal(await repositoryModule.getSqliteRecord('kdaRows', 'kda_sqlite_discord_remove_active'), null);
    assert.equal(await repositoryModule.getSqliteRecord('kdaSnapshots', 'kda_snapshot_sqlite_discord_remove_active'), null);
    assert.equal(await repositoryModule.getSqliteRecord('memberProfiles', 'member_profile_sqlite_discord_remove'), null);
    assert.equal(await repositoryModule.getSqliteRecord('accountAlertDismissals', 'account_alert_sqlite_discord_remove'), null);
    assert.equal(await repositoryModule.getSqliteRecord('users', 'user_sqlite_discord_remove'), null);
    assert.equal(await repositoryModule.getSqliteRecord('sessions', 'session_sqlite_discord_remove'), null);
    assert.equal((await repositoryModule.getSqliteRecord('wipeParticipants', 'wipe_participant_sqlite_discord_remove_closed')).memberId, 'member_sqlite_discord_remove');
    assert.equal((await repositoryModule.getSqliteRecord('kdaRows', 'kda_sqlite_discord_remove_closed')).kills, 9);
    assert.equal((await repositoryModule.getSqliteRecord('kdaSnapshots', 'kda_snapshot_sqlite_discord_remove_closed')).kills, 9);
    const removeLog = logs.find((log) => log.type === 'discord_member_remove' && log.targetId === 'member_sqlite_discord_remove');
    assert.equal(Boolean(removeLog), true);
    assert.equal(removeLog.metadata.discordUserId, targetDiscordId);
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

test('sqlite-primary Discord VIP update uses direct SQLite patch writes', async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'nb-clan-sqlite-discord-vip-update-'));
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

  let server = null;
  const discordKeys = crypto.generateKeyPairSync('ed25519');
  const publicKeyDer = discordKeys.publicKey.export({ type: 'spki', format: 'der' });
  const discordPublicKey = Buffer.from(publicKeyDer).subarray(-32).toString('hex');
  const discordUserId = '123456789012392002';
  const memberId = 'member_sqlite_discord_vip_update';
  const steamId = '76561198002000003';

  try {
    const storeModule = await uniqueImport('../server/store.js');
    const apiModule = await uniqueImport('../server/api.js');
    const repositoryModule = await import('../server/storage/repository.js');
    await storeModule.ensureStore();
    const createdAt = '2026-07-08T00:00:00.000Z';
    await storeModule.updateStore((store) => {
      store.settings.discord = {
        ...(store.settings.discord || {}),
        publicKey: discordPublicKey
      };
      store.members.push({
        id: memberId,
        steamId,
        rawInput: steamId,
        customName: 'SQLite VIP',
        steamNickname: 'SQLite VIP Steam',
        avatar: '',
        discordId: discordUserId,
        wechatId: '',
        wechatUserId: '',
        notes: '',
        specialty: [],
        memberStatus: 'active',
        invitedByUserId: '',
        atlasVipType: 'none',
        atlasVipPurchasedAt: '',
        atlasVipExpiresAt: '',
        createdAt,
        updatedAt: createdAt
      });
    });

    const app = express();
    app.use('/api', apiModule.createApiRouter());
    server = createServer(app);
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const baseUrl = `http://127.0.0.1:${server.address().port}/api`;
    const postDiscordInteraction = (body) => {
      const rawBody = JSON.stringify(body);
      const timestamp = String(Math.floor(Date.now() / 1000));
      const signature = crypto
        .sign(null, Buffer.concat([Buffer.from(timestamp), Buffer.from(rawBody)]), discordKeys.privateKey)
        .toString('hex');
      return fetch(`${baseUrl}/integrations/discord/interactions`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-signature-ed25519': signature,
          'x-signature-timestamp': timestamp
        },
        body: rawBody
      });
    };
    const sqliteWriteCount = (status, name) => status.sqlite?.writes?.byName?.[name]?.total || 0;
    const storeWriteCount = (status, name) => status.metrics?.writes?.byName?.[name]?.total || 0;
    const currentYear = new Date().getUTCFullYear();
    const purchaseDate = `${currentYear}-09-01`;
    const expiryDate = `${currentYear}-09-29`;

    const beforeFailureStatus = await storeModule.storeRuntimeStatus({ sqliteSummary: false });
    const beforeFailureReadStoreFull = queryCount(beforeFailureStatus, 'read_store_full');
    repositoryModule.injectSqliteStorePatchFailureForTests('discord_vip_update', 1);
    const failedResponse = await postDiscordInteraction({
      type: 5,
      application_id: '123456789012392004',
      token: 'sqlite_vip_submit_failure_token',
      locale: 'zh-CN',
      member: {
        roles: [],
        permissions: '0',
        user: { id: discordUserId, username: 'SQLiteVipUser' }
      },
      data: {
        custom_id: 'nb_vital_vip:submit:atlas:priority',
        components: [
          { type: 18, component: { type: 3, custom_id: 'date_month', values: ['09'] } },
          { type: 18, component: { type: 4, custom_id: 'date_day', value: '1' } }
        ]
      }
    });
    assert.equal(failedResponse.status, 200);
    const failedPayload = await failedResponse.json();
    assert.equal(failedPayload.type, 4);
    assert.match(failedPayload.data.content, /Discord Atlas VIP 写入暂不可用/);
    const afterFailureStatus = await storeModule.storeRuntimeStatus({ sqliteSummary: false });
    assert.equal(queryCount(afterFailureStatus, 'read_store_full'), beforeFailureReadStoreFull);
    const failedMember = await repositoryModule.getSqliteRecord('members', memberId);
    assert.equal(failedMember.atlasVipType, 'none');
    assert.equal(failedMember.atlasVipPurchasedAt, '');

    const beforeStatus = await storeModule.storeRuntimeStatus({ sqliteSummary: false });
    const beforeStat = await stat(storeModule.STORE_FILE);
    const response = await postDiscordInteraction({
      type: 5,
      application_id: '123456789012392004',
      token: 'sqlite_vip_submit_token',
      locale: 'zh-CN',
      member: {
        roles: [],
        permissions: '0',
        user: { id: discordUserId, username: 'SQLiteVipUser' }
      },
      data: {
        custom_id: 'nb_vital_vip:submit:atlas:priority',
        components: [
          { type: 18, component: { type: 3, custom_id: 'date_month', values: ['09'] } },
          { type: 18, component: { type: 4, custom_id: 'date_day', value: '1' } }
        ]
      }
    });
    assert.equal(response.status, 200);
    const payload = await response.json();
    assert.equal(payload.type, 4);
    assert.match(payload.data.content, /已更新 Atlas VIP：优先队列/);
    const afterStat = await stat(storeModule.STORE_FILE);
    const afterStatus = await storeModule.storeRuntimeStatus({ sqliteSummary: false });
    const member = await repositoryModule.getSqliteRecord('members', memberId);
    const logs = await repositoryModule.getSqliteCollection('logs', { limit: 0 });
    assert.equal(afterStat.mtimeMs, beforeStat.mtimeMs);
    assert.equal(afterStatus.metrics.writes.total, beforeStatus.metrics.writes.total);
    assert.equal(afterStatus.metrics.sqliteWrites, beforeStatus.metrics.sqliteWrites);
    assert.equal(storeWriteCount(afterStatus, 'write_store_sqlite_patch'), storeWriteCount(beforeStatus, 'write_store_sqlite_patch'));
    assert.equal(sqliteWriteCount(afterStatus, 'discord_vip_update'), sqliteWriteCount(beforeStatus, 'discord_vip_update') + 1);
    assert.equal(queryCount(afterStatus, 'list_members'), queryCount(beforeStatus, 'list_members'));
    assert.equal(queryCount(afterStatus, 'list_members_discordId') > queryCount(beforeStatus, 'list_members_discordId'), true);
    assert.equal(member.atlasVipType, 'priority');
    assert.equal(member.atlasVipPurchasedAt, purchaseDate);
    assert.equal(member.atlasVipExpiresAt, expiryDate);
    assert.equal(logs.some((log) => log.type === 'discord_atlas_vip_update' && log.targetId === memberId), true);
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

test('sqlite-primary Discord wipe attendance push uses direct SQLite patch writes', async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'nb-clan-sqlite-discord-wipe-attendance-'));
  const previousEnv = {
    NB_DATA_DIR: process.env.NB_DATA_DIR,
    NB_ROOT_PASSWORD: process.env.NB_ROOT_PASSWORD,
    NB_STORAGE_MODE: process.env.NB_STORAGE_MODE,
    NB_SQLITE_FILE: process.env.NB_SQLITE_FILE,
    NB_DISCORD_API_BASE_URL: process.env.NB_DISCORD_API_BASE_URL,
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
	  process.env.NB_DISCORD_WIPE_ATTENDANCE_REFRESH_DEBOUNCE_MS = '0';
	  process.env.NB_RUSTPLUS_RELAY_CHAT_FLUSH_INTERVAL_MS = '0';

	  let server = null;
	  let discordServer = null;
	  let failDiscordPush = false;
	  const discordMessages = [];
	  const discordEdits = [];
	  const guildId = '123456789012392001';
	  const channelId = '123456789012392002';

  try {
    const discordApp = express();
    discordApp.use(express.json());
    discordApp.post('/channels/:channelId/messages', (req, res) => {
      if (failDiscordPush) {
        res.status(500).json({ message: 'mock discord down' });
        return;
      }
      const messageId = `sqlite_wipe_attendance_${discordMessages.length + 1}`;
      discordMessages.push({
        channelId: req.params.channelId,
        authorization: req.get('authorization') || '',
        body: req.body,
        messageId
      });
      res.json({
        id: messageId,
        channel_id: req.params.channelId
	      });
	    });
	    discordApp.patch('/channels/:channelId/messages/:messageId', (req, res) => {
	      discordEdits.push({
	        channelId: req.params.channelId,
	        messageId: req.params.messageId,
	        authorization: req.get('authorization') || '',
	        body: req.body
	      });
	      res.json({
	        id: req.params.messageId,
	        channel_id: req.params.channelId,
	        ...req.body
	      });
	    });
	    discordServer = createServer(discordApp);
	    await new Promise((resolve) => discordServer.listen(0, '127.0.0.1', resolve));
	    process.env.NB_DISCORD_API_BASE_URL = `http://127.0.0.1:${discordServer.address().port}`;

    const storeModule = await uniqueImport('../server/store.js');
    const apiModule = await uniqueImport('../server/api.js');
    const authModule = await uniqueImport('../server/auth.js');
    const repositoryModule = await import('../server/storage/repository.js');
    await storeModule.ensureStore();
    await storeModule.updateStore((store) => {
      store.settings.discord = {
        ...(store.settings.discord || {}),
        botToken: 'sqlite_discord_wipe_attendance_bot_token',
        guildId,
        channelId
      };
    });

    const app = express();
    app.use('/api', apiModule.createApiRouter());
    server = createServer(app);
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const baseUrl = `http://127.0.0.1:${server.address().port}/api`;
    const sessionId = await authModule.createSession('user_root');
    const cookie = `nb_session=${encodeURIComponent(sessionId)}`;
    const sqliteWriteCount = (status, name) => status.sqlite?.writes?.byName?.[name]?.total || 0;
    const storeWriteCount = (status, name) => status.metrics?.writes?.byName?.[name]?.total || 0;
    const beforeStatus = await storeModule.storeRuntimeStatus({ sqliteSummary: false });
    const beforeStat = await stat(storeModule.STORE_FILE);

    repositoryModule.injectSqliteStorePatchFailureForTests('discord_wipe_attendance_auto_create', 1);
    const autoCreateFailureResponse = await httpFetch(`${baseUrl}/wipes/current/discord-attendance`, {
      method: 'POST',
      headers: {
        cookie,
        'content-type': 'application/json'
      },
      body: JSON.stringify({
        name: 'SQLite Discord Attendance',
        serverName: 'SQLite Discord Server',
        mentionEveryone: false,
        language: 'en'
      })
    });
    const autoCreateFailurePayload = await autoCreateFailureResponse.json();
    assert.equal(autoCreateFailureResponse.status, 503, JSON.stringify(autoCreateFailurePayload));
    assert.match(autoCreateFailurePayload.error, /Discord 出勤卡片自动创建暂不可用/);
    const afterAutoCreateFailureStatus = await storeModule.storeRuntimeStatus({ sqliteSummary: false });
    const afterAutoCreateFailureStat = await stat(storeModule.STORE_FILE);
    const autoCreateFailureWipes = await repositoryModule.getSqliteCollection('wipes', { limit: 0 });
    const autoCreateFailureLogs = await repositoryModule.getSqliteCollection('logs', { limit: 0 });
    const autoCreateFailureRuns = await repositoryModule.getSqliteCollection('operationRuns', { limit: 0 });
    assert.equal(discordMessages.length, 0);
    assert.equal(autoCreateFailureWipes.some((item) => item.name === 'SQLite Discord Attendance'), false);
    assert.equal(autoCreateFailureLogs.some((log) => log.type === 'wipe_create'), false);
    assert.equal(autoCreateFailureRuns.some((run) => run.type === 'discord_wipe_attendance_card_push'), false);
    assert.equal(afterAutoCreateFailureStat.mtimeMs, beforeStat.mtimeMs);
    assert.equal(afterAutoCreateFailureStatus.metrics.writes.total, beforeStatus.metrics.writes.total);
    assert.equal(afterAutoCreateFailureStatus.metrics.sqliteWrites, beforeStatus.metrics.sqliteWrites);
    assert.equal(storeWriteCount(afterAutoCreateFailureStatus, 'write_store_sqlite_patch'), storeWriteCount(beforeStatus, 'write_store_sqlite_patch'));
    assert.equal(queryCount(afterAutoCreateFailureStatus, 'read_store_full'), queryCount(beforeStatus, 'read_store_full'));

    const response = await httpFetch(`${baseUrl}/wipes/current/discord-attendance`, {
      method: 'POST',
      headers: {
        cookie,
        'content-type': 'application/json'
      },
      body: JSON.stringify({
        name: 'SQLite Discord Attendance',
        serverName: 'SQLite Discord Server',
        mentionEveryone: false,
        language: 'en'
      })
    });
    const payload = await response.json();
    assert.equal(response.status, 200, JSON.stringify(payload));
    assert.equal(payload.message.id, 'sqlite_wipe_attendance_1');
    assert.equal(discordMessages.length, 1);
    assert.equal(discordMessages[0].channelId, channelId);
    assert.equal(discordMessages[0].authorization, 'Bot sqlite_discord_wipe_attendance_bot_token');
    assert.equal(discordMessages[0].body.allowed_mentions.parse.includes('everyone'), false);

    const afterSuccessStatus = await storeModule.storeRuntimeStatus({ sqliteSummary: false });
    const afterSuccessStat = await stat(storeModule.STORE_FILE);
    const wipes = await repositoryModule.getSqliteCollection('wipes', { limit: 0 });
    const wipe = wipes.find((item) => item.name === 'SQLite Discord Attendance');
    const successSettings = await repositoryModule.getSqliteScalar('settings');
    const successLogs = await repositoryModule.getSqliteCollection('logs', { limit: 0 });
    const successRefs = await repositoryModule.getSqliteCollection('integrationMessageRefs', { limit: 0 });
    const attendanceRef = successRefs.find((ref) => (
      ref.kind === 'wipe_attendance_card' &&
      ref.targetId === wipe?.id &&
      ref.channelId === channelId &&
      ref.messageId === 'sqlite_wipe_attendance_1'
    ));
    assert.equal(afterSuccessStat.mtimeMs, beforeStat.mtimeMs);
    assert.equal(afterSuccessStatus.metrics.writes.total, beforeStatus.metrics.writes.total);
    assert.equal(afterSuccessStatus.metrics.sqliteWrites, beforeStatus.metrics.sqliteWrites);
    assert.equal(storeWriteCount(afterSuccessStatus, 'write_store_sqlite_patch'), storeWriteCount(beforeStatus, 'write_store_sqlite_patch'));
    assert.equal(sqliteWriteCount(afterSuccessStatus, 'discord_wipe_attendance_auto_create'), sqliteWriteCount(beforeStatus, 'discord_wipe_attendance_auto_create') + 1);
    assert.equal(sqliteWriteCount(afterSuccessStatus, 'discord_attendance_push'), sqliteWriteCount(beforeStatus, 'discord_attendance_push') + 1);
    assert.equal(Boolean(wipe), true);
    assert.equal(wipe.status, 'active');
    assert.equal(successSettings.discord.lastMessageId, 'sqlite_wipe_attendance_1');
    assert.equal(successSettings.discord.lastPushError, '');
    assert.equal(successSettings.discord.lastMessageMentionEveryone, false);
    assert.equal(successLogs.some((log) => log.type === 'wipe_create' && log.targetId === wipe.id), true);
    assert.equal(successLogs.some((log) => log.type === 'discord_attendance_push' && log.targetId === wipe.id), true);
    assert.equal(Boolean(attendanceRef), true);
    assert.equal(attendanceRef.platform, 'discord');
	    assert.equal(attendanceRef.targetType, 'wipe');
	    assert.equal(attendanceRef.status, 'active');
	    assert.equal(attendanceRef.metadata.wipeId, wipe.id);
	    const pushSuccessRun = await waitForSqliteOperationRun(repositoryModule, (run) => (
	      run.type === 'discord_wipe_attendance_card_push' &&
	      run.status === 'succeeded' &&
	      run.targetId === wipe.id &&
	      run.messageId === 'sqlite_wipe_attendance_1'
		    ), 'Discord wipe attendance push success run');
		    assert.equal(pushSuccessRun.channelId, channelId);

		    const traceModule = await import('../server/trace-record-persistence.js');
		    traceModule.resetTraceRecordPersistenceForTests();
		    const beforeSuppressedPushMessages = discordMessages.length;
		    const beforeSuppressedPushRefs = (await repositoryModule.getSqliteCollection('integrationMessageRefs', { limit: 0 })).length;
		    repositoryModule.injectSqliteStorePatchFailureForTests('operation_run_create', 2);
		    const suppressedPushResponse = await httpFetch(`${baseUrl}/wipes/current/discord-attendance`, {
		      method: 'POST',
		      headers: {
		        cookie,
		        'content-type': 'application/json'
		      },
		      body: JSON.stringify({
		        mentionEveryone: false,
		        language: 'en'
		      })
		    });
		    const suppressedPushPayload = await suppressedPushResponse.json();
		    assert.equal(suppressedPushResponse.status, 503, JSON.stringify(suppressedPushPayload));
		    assert.equal(suppressedPushPayload.ok, false);
		    assert.match(suppressedPushPayload.error, /操作记录暂时无法写入/);
		    assert.equal(discordMessages.length, beforeSuppressedPushMessages);
		    assert.equal((await repositoryModule.getSqliteCollection('integrationMessageRefs', { limit: 0 })).length, beforeSuppressedPushRefs);
		    assert.equal(
		      traceModule.traceRecordPersistenceSnapshot().records.some((item) => (
		        item.name === 'operation_run_create' &&
		        item.fallbackSuppressed === 1
		      )),
		      true
		    );

		    await repositoryModule.writeSqliteStorePatch({
	      reason: 'sqlite_test_discord_attendance_refresh_seed',
	      upserts: {
	        members: [{
	          id: 'member_sqlite_discord_attendance_refresh',
	          steamId: '76561198001999123',
	          rawInput: '76561198001999123',
	          customName: 'SQLite Discord Attendance Refresh',
	          steamNickname: 'SQLite Discord Attendance Refresh',
	          avatar: '',
	          discordId: '',
	          wechatId: '',
	          wechatUserId: '',
	          notes: '',
	          specialty: ['PVP'],
	          memberStatus: 'active',
	          invitedByUserId: '',
	          createdAt: '2026-07-02T00:00:00.000Z',
	          updatedAt: '2026-07-02T00:00:00.000Z'
	        }]
	      }
	    });
	    const refreshTriggerResponse = await httpFetch(`${baseUrl}/wipes/${wipe.id}/participants`, {
	      method: 'POST',
	      headers: {
	        cookie,
	        'content-type': 'application/json'
	      },
	      body: JSON.stringify({
	        memberIds: ['member_sqlite_discord_attendance_refresh'],
	        status: 'on_time',
	        note: 'trigger Discord attendance refresh'
	      })
	    });
	    const refreshTriggerPayload = await refreshTriggerResponse.json();
	    assert.equal(refreshTriggerResponse.status, 200, JSON.stringify(refreshTriggerPayload));
	    assert.equal(refreshTriggerPayload.added, 1);
	    const refreshRun = await waitForSqliteOperationRun(repositoryModule, (run) => (
	      run.type === 'discord_wipe_attendance_card_refresh' &&
	      run.status === 'succeeded' &&
	      run.targetId === wipe.id &&
	      run.metadata?.reason === 'web_participant_add'
	    ), 'Discord wipe attendance refresh parent run');
	    const updateRun = await waitForSqliteOperationRun(repositoryModule, (run) => (
	      run.type === 'discord_wipe_attendance_card_update' &&
	      run.status === 'succeeded' &&
	      run.targetId === wipe.id &&
	      run.messageId === 'sqlite_wipe_attendance_1'
	    ), 'Discord wipe attendance refresh edit run');
	    const refreshedSettings = await repositoryModule.getSqliteScalar('settings');
	    const refreshedRefs = await repositoryModule.getSqliteCollection('integrationMessageRefs', { limit: 0 });
	    const refreshedAttendanceRef = refreshedRefs.find((ref) => ref.id === attendanceRef.id);
	    assert.equal(discordEdits.length, 1);
	    assert.equal(discordEdits[0].channelId, channelId);
	    assert.equal(discordEdits[0].messageId, 'sqlite_wipe_attendance_1');
	    assert.equal(discordEdits[0].authorization, 'Bot sqlite_discord_wipe_attendance_bot_token');
	    assert.equal(refreshRun.metadata.refreshed, '1');
	    assert.equal(updateRun.channelId, channelId);
	    assert.equal(Boolean(refreshedSettings.discord.lastMessageRefreshAt), true);
	    assert.equal(refreshedSettings.discord.lastMessageRefreshError, '');
	    assert.equal(refreshedAttendanceRef.source, 'discord_wipe_attendance_refresh');
	    assert.equal(refreshedAttendanceRef.metadata.action, 'refresh');

	    await repositoryModule.writeSqliteStorePatch({
	      reason: 'sqlite_test_discord_attendance_refresh_tracking_failure_seed',
	      upserts: {
	        members: [{
	          id: 'member_sqlite_discord_attendance_refresh_tracking_failure',
	          steamId: '76561198001999125',
	          rawInput: '76561198001999125',
	          customName: 'SQLite Discord Attendance Tracking Failure',
	          steamNickname: 'SQLite Discord Attendance Tracking Failure',
	          avatar: '',
	          discordId: '',
	          wechatId: '',
	          wechatUserId: '',
	          notes: '',
	          specialty: ['Electricity'],
	          memberStatus: 'active',
	          invitedByUserId: '',
	          createdAt: '2026-07-02T00:00:00.000Z',
	          updatedAt: '2026-07-02T00:00:00.000Z'
	        }]
	      }
	    });
	    const editCountBeforeTrackingFailure = discordEdits.length;
	    const refreshAtBeforeTrackingFailure = refreshedSettings.discord.lastMessageRefreshAt;
	    repositoryModule.injectSqliteStorePatchFailureForTests('discord_wipe_attendance_refresh', 1);
	    const trackingFailureTriggerResponse = await httpFetch(`${baseUrl}/wipes/${wipe.id}/participants`, {
	      method: 'POST',
	      headers: {
	        cookie,
	        'content-type': 'application/json'
	      },
	      body: JSON.stringify({
	        memberIds: ['member_sqlite_discord_attendance_refresh_tracking_failure'],
	        status: 'on_time',
	        note: 'trigger Discord attendance refresh tracking failure'
	      })
	    });
	    const trackingFailureTriggerPayload = await trackingFailureTriggerResponse.json();
	    assert.equal(trackingFailureTriggerResponse.status, 200, JSON.stringify(trackingFailureTriggerPayload));
	    assert.equal(trackingFailureTriggerPayload.added, 1);
	    const trackingFailureUpdateRun = await waitForSqliteOperationRun(repositoryModule, (run) => (
	      run.type === 'discord_wipe_attendance_card_update' &&
	      run.status === 'failed' &&
	      run.targetId === wipe.id &&
	      run.messageId === 'sqlite_wipe_attendance_1' &&
	      run.metadata?.trackingWriteFailed === 'true'
	    ), 'Discord wipe attendance refresh tracking failure update run');
	    const trackingFailureRefreshRun = await waitForSqliteOperationRun(repositoryModule, (run) => (
	      run.type === 'discord_wipe_attendance_card_refresh' &&
	      run.status === 'failed' &&
	      run.targetId === wipe.id &&
	      run.metadata?.reason === 'web_participant_add' &&
	      run.metadata?.failed === '1' &&
	      Array.isArray(run.metadata?.targets) &&
	      run.metadata.targets.some((target) => target.reason === 'tracking_write_failed')
	    ), 'Discord wipe attendance refresh tracking failure parent run');
	    const trackingFailureSettings = await repositoryModule.getSqliteScalar('settings');
	    const trackingFailureRefs = await repositoryModule.getSqliteCollection('integrationMessageRefs', { limit: 0 });
	    const recoveredTrackingFailureRef = trackingFailureRefs.find((ref) => (
	      ref.kind === 'wipe_attendance_card' &&
	      ref.targetId === wipe.id &&
	      ref.channelId === channelId &&
	      ref.messageId === 'sqlite_wipe_attendance_1'
	    ));
	    assert.equal(discordEdits.length, editCountBeforeTrackingFailure + 1);
	    assert.equal(discordEdits.at(-1).messageId, 'sqlite_wipe_attendance_1');
	    assert.equal(trackingFailureSettings.discord.lastMessageRefreshAt, refreshAtBeforeTrackingFailure);
	    assert.equal(trackingFailureSettings.discord.lastMessageRefreshError, '');
	    assert.equal(trackingFailureUpdateRun.metadata.externalActionSucceeded, 'true');
	    assert.match(trackingFailureUpdateRun.metadata.trackingWriteError, /Injected sqlite patch failure for discord_wipe_attendance_refresh/);
	    assert.equal(trackingFailureUpdateRun.metadata.messageRefRecovered, 'true');
	    assert.equal(trackingFailureUpdateRun.metadata.messageRefWriteFailed, 'false');
	    assert.equal(trackingFailureRefreshRun.metadata.targets[0].messageId, 'sqlite_wipe_attendance_1');
	    assert.equal(Boolean(recoveredTrackingFailureRef), true);
	    assert.equal(recoveredTrackingFailureRef.source, 'discord_wipe_attendance_refresh_recovery');
	    assert.equal(recoveredTrackingFailureRef.metadata.trackingWriteFailed, true);

	    failDiscordPush = true;
    const beforeFailStatus = await storeModule.storeRuntimeStatus({ sqliteSummary: false });
    const beforeFailStat = await stat(storeModule.STORE_FILE);
    const failedResponse = await httpFetch(`${baseUrl}/wipes/current/discord-attendance`, {
      method: 'POST',
      headers: {
        cookie,
        'content-type': 'application/json'
      },
      body: JSON.stringify({
        mentionEveryone: false,
        language: 'en'
      })
    });
    const failedPayload = await failedResponse.json();
    assert.equal(failedResponse.status, 502, JSON.stringify(failedPayload));
    assert.match(failedPayload.error, /Discord push failed/);

    const afterFailStatus = await storeModule.storeRuntimeStatus({ sqliteSummary: false });
    const afterFailStat = await stat(storeModule.STORE_FILE);
    const failedSettings = await repositoryModule.getSqliteScalar('settings');
    const failedLogs = await repositoryModule.getSqliteCollection('logs', { limit: 0 });
    const failedRefs = await repositoryModule.getSqliteCollection('integrationMessageRefs', { limit: 0 });
    assert.equal(afterFailStat.mtimeMs, beforeFailStat.mtimeMs);
    assert.equal(afterFailStatus.metrics.writes.total, beforeFailStatus.metrics.writes.total);
    assert.equal(afterFailStatus.metrics.sqliteWrites, beforeFailStatus.metrics.sqliteWrites);
    assert.equal(storeWriteCount(afterFailStatus, 'write_store_sqlite_patch'), storeWriteCount(beforeFailStatus, 'write_store_sqlite_patch'));
    assert.equal(sqliteWriteCount(afterFailStatus, 'discord_wipe_attendance_auto_create'), sqliteWriteCount(beforeFailStatus, 'discord_wipe_attendance_auto_create'));
    assert.equal(sqliteWriteCount(afterFailStatus, 'discord_attendance_push_failed'), sqliteWriteCount(beforeFailStatus, 'discord_attendance_push_failed') + 1);
	    assert.match(failedSettings.discord.lastPushError, /mock discord down/);
	    assert.equal(failedSettings.discord.lastMessageId, 'sqlite_wipe_attendance_1');
	    assert.equal(failedLogs.some((log) => log.type === 'discord_attendance_push_failed' && log.targetId === wipe.id), true);
	    assert.equal(failedRefs.length, successRefs.length);

	    failDiscordPush = false;
	    repositoryModule.injectSqliteStorePatchFailureForTests('discord_attendance_push', 1);
	    const beforeStatusWriteFailureStatus = await storeModule.storeRuntimeStatus({ sqliteSummary: false });
	    const beforeStatusWriteFailureStat = await stat(storeModule.STORE_FILE);
	    const statusWriteFailureResponse = await httpFetch(`${baseUrl}/wipes/current/discord-attendance`, {
	      method: 'POST',
	      headers: {
	        cookie,
	        'content-type': 'application/json'
	      },
	      body: JSON.stringify({
	        mentionEveryone: false,
	        language: 'en'
	      })
	    });
	    const statusWriteFailurePayload = await statusWriteFailureResponse.json();
	    assert.equal(statusWriteFailureResponse.status, 503, JSON.stringify(statusWriteFailurePayload));
	    assert.match(statusWriteFailurePayload.error, /Discord 出勤卡片状态写入暂不可用/);

	    const afterStatusWriteFailureStatus = await storeModule.storeRuntimeStatus({ sqliteSummary: false });
	    const afterStatusWriteFailureStat = await stat(storeModule.STORE_FILE);
	    const statusWriteFailureSettings = await repositoryModule.getSqliteScalar('settings');
	    const statusWriteFailureRefs = await repositoryModule.getSqliteCollection('integrationMessageRefs', { limit: 0 });
		    const operationRuns = await repositoryModule.getSqliteCollection('operationRuns', { limit: 0 });
		    const failedStatusWriteRun = operationRuns.find((run) => (
		      run.type === 'discord_wipe_attendance_card_push' &&
		      run.status === 'failed' &&
		      run.metadata?.statusWriteFailed
		    ));
		    const recoveredStatusWriteFailureRef = statusWriteFailureRefs.find((ref) => (
		      ref.kind === 'wipe_attendance_card' &&
		      ref.targetId === wipe.id &&
		      ref.channelId === channelId &&
		      ref.messageId === 'sqlite_wipe_attendance_2'
		    ));
		    assert.equal(afterStatusWriteFailureStat.mtimeMs, beforeStatusWriteFailureStat.mtimeMs);
		    assert.equal(afterStatusWriteFailureStatus.metrics.writes.total, beforeStatusWriteFailureStatus.metrics.writes.total);
		    assert.equal(storeWriteCount(afterStatusWriteFailureStatus, 'write_store_sqlite_patch'), storeWriteCount(beforeStatusWriteFailureStatus, 'write_store_sqlite_patch'));
		    assert.equal(statusWriteFailureSettings.discord.lastMessageId, 'sqlite_wipe_attendance_1');
		    assert.equal(statusWriteFailureRefs.length, failedRefs.length + 1);
		    assert.equal(Boolean(recoveredStatusWriteFailureRef), true);
		    assert.equal(recoveredStatusWriteFailureRef.source, 'discord_wipe_attendance_push_recovery');
		    assert.equal(recoveredStatusWriteFailureRef.metadata.statusWriteFailed, true);
		    assert.equal(Boolean(failedStatusWriteRun), true);
		    assert.equal(failedStatusWriteRun.metadata.messageRefRecovered, 'true');

		    const skippedRefreshSeedSettings = {
		      ...statusWriteFailureSettings,
		      discord: {
		        ...(statusWriteFailureSettings.discord || {}),
		        lastMessageId: '',
		        lastMessageRefreshAt: '',
		        lastMessageRefreshError: '',
		        targets: Array.isArray(statusWriteFailureSettings.discord?.targets)
		          ? statusWriteFailureSettings.discord.targets.map((target) => ({
		              ...target,
		              lastMessageId: '',
		              lastMessageRefreshAt: '',
		              lastMessageRefreshError: ''
		            }))
		          : []
		      }
		    };
		    await repositoryModule.writeSqliteStorePatch({
		      reason: 'sqlite_test_discord_attendance_skipped_refresh_seed',
		      scalars: { settings: skippedRefreshSeedSettings },
		      upserts: {
		        members: [{
		          id: 'member_sqlite_discord_attendance_skipped_refresh',
		          steamId: '76561198001999124',
		          rawInput: '76561198001999124',
		          customName: 'SQLite Discord Attendance Skipped Refresh',
		          steamNickname: 'SQLite Discord Attendance Skipped Refresh',
		          avatar: '',
		          discordId: '',
		          wechatId: '',
		          wechatUserId: '',
		          notes: '',
		          specialty: ['Builder'],
		          memberStatus: 'active',
		          invitedByUserId: '',
		          createdAt: '2026-07-02T00:00:00.000Z',
		          updatedAt: '2026-07-02T00:00:00.000Z'
		        }]
		      }
		    });
		    const editCountBeforeSkippedRefresh = discordEdits.length;
		    const skippedRefreshTriggerResponse = await httpFetch(`${baseUrl}/wipes/${wipe.id}/participants`, {
		      method: 'POST',
		      headers: {
		        cookie,
		        'content-type': 'application/json'
		      },
		      body: JSON.stringify({
		        memberIds: ['member_sqlite_discord_attendance_skipped_refresh'],
		        status: 'on_time',
		        note: 'trigger skipped Discord attendance refresh'
		      })
		    });
		    const skippedRefreshTriggerPayload = await skippedRefreshTriggerResponse.json();
		    assert.equal(skippedRefreshTriggerResponse.status, 200, JSON.stringify(skippedRefreshTriggerPayload));
		    assert.equal(skippedRefreshTriggerPayload.added, 1);
		    const skippedRefreshRun = await waitForSqliteOperationRun(repositoryModule, (run) => (
		      run.type === 'discord_wipe_attendance_card_refresh' &&
		      run.status === 'skipped' &&
		      run.targetId === wipe.id &&
		      run.metadata?.reason === 'web_participant_add' &&
		      run.metadata?.skippedReason === 'not_configured'
		    ), 'Discord wipe attendance refresh skipped run');
		    assert.equal(discordEdits.length, editCountBeforeSkippedRefresh);
		    assert.equal(skippedRefreshRun.metadata.skipped, '1');
		    assert.equal(skippedRefreshRun.metadata.targets?.[0]?.reason, 'not_configured');
		  } finally {
    if (server) await new Promise((resolve) => server.close(resolve));
    if (discordServer) await new Promise((resolve) => discordServer.close(resolve));
    const sqliteModule = await import('../server/storage/sqlite.js');
    await sqliteModule.closeSqliteDatabasesForTests();
    Object.assign(process.env, previousEnv);
    for (const [key, value] of Object.entries(previousEnv)) {
      if (value === undefined) delete process.env[key];
    }
    await rm(dataDir, { recursive: true, force: true });
  }
});

test('sqlite-primary Discord member registration card push records integration message refs in settings patch', async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'nb-clan-sqlite-discord-member-card-ref-'));
  const previousEnv = {
    NB_DATA_DIR: process.env.NB_DATA_DIR,
    NB_ROOT_PASSWORD: process.env.NB_ROOT_PASSWORD,
    NB_STORAGE_MODE: process.env.NB_STORAGE_MODE,
    NB_SQLITE_FILE: process.env.NB_SQLITE_FILE,
    NB_DISCORD_API_BASE_URL: process.env.NB_DISCORD_API_BASE_URL,
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
  let discordServer = null;
  const discordMessages = [];
  const guildId = '123456789012393001';
  const memberRegisterChannelId = '123456789012393002';

  try {
    const discordApp = express();
    discordApp.use(express.json());
    discordApp.post('/channels/:channelId/messages', (req, res) => {
      const messageId = `sqlite_member_card_${discordMessages.length + 1}`;
      discordMessages.push({
        channelId: req.params.channelId,
        authorization: req.get('authorization') || '',
        body: req.body,
        messageId
      });
      res.json({
        id: messageId,
        channel_id: req.params.channelId
      });
    });
    discordServer = createServer(discordApp);
    await new Promise((resolve) => discordServer.listen(0, '127.0.0.1', resolve));
    process.env.NB_DISCORD_API_BASE_URL = `http://127.0.0.1:${discordServer.address().port}`;

    const storeModule = await uniqueImport('../server/store.js');
    const apiModule = await uniqueImport('../server/api.js');
    const authModule = await uniqueImport('../server/auth.js');
    const repositoryModule = await import('../server/storage/repository.js');
    await storeModule.ensureStore();
    await storeModule.updateStore((store) => {
      store.settings.discord = {
        ...(store.settings.discord || {}),
        botToken: 'sqlite_discord_member_card_bot_token',
        guildId,
        memberRegisterChannelId,
        memberReviewChannelId: '123456789012393003',
        memberRegisterRoleId: '123456789012393004'
      };
    });

    const app = express();
    app.use('/api', apiModule.createApiRouter());
    server = createServer(app);
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const baseUrl = `http://127.0.0.1:${server.address().port}/api`;
    const sessionId = await authModule.createSession('user_root');
    const cookie = `nb_session=${encodeURIComponent(sessionId)}`;
    const sqliteWriteCount = (status, name) => status.sqlite?.writes?.byName?.[name]?.total || 0;
    const storeWriteCount = (status, name) => status.metrics?.writes?.byName?.[name]?.total || 0;
    const beforeStatus = await storeModule.storeRuntimeStatus({ sqliteSummary: false });
    const beforeStat = await stat(storeModule.STORE_FILE);

    const response = await httpFetch(`${baseUrl}/settings/discord/member-registration-card`, {
      method: 'POST',
      headers: {
        cookie,
        'content-type': 'application/json'
      },
      body: JSON.stringify({ language: 'en' })
    });
    const payload = await response.json();
    assert.equal(response.status, 200, JSON.stringify(payload));
    assert.equal(payload.message.id, 'sqlite_member_card_1');
    assert.equal(discordMessages.length, 1);
    assert.equal(discordMessages[0].channelId, memberRegisterChannelId);
    assert.equal(discordMessages[0].authorization, 'Bot sqlite_discord_member_card_bot_token');

    const afterStatus = await storeModule.storeRuntimeStatus({ sqliteSummary: false });
    const afterStat = await stat(storeModule.STORE_FILE);
    const settings = await repositoryModule.getSqliteScalar('settings');
    const logs = await repositoryModule.getSqliteCollection('logs', { limit: 0 });
    const refs = await repositoryModule.getSqliteCollection('integrationMessageRefs', { limit: 0 });
    const ref = refs.find((item) => (
      item.kind === 'member_registration_card' &&
      item.targetType === 'discord_target' &&
      item.channelId === memberRegisterChannelId &&
      item.messageId === 'sqlite_member_card_1'
    ));
    assert.equal(afterStat.mtimeMs, beforeStat.mtimeMs);
    assert.equal(afterStatus.metrics.writes.total, beforeStatus.metrics.writes.total);
    assert.equal(afterStatus.metrics.sqliteWrites, beforeStatus.metrics.sqliteWrites);
    assert.equal(storeWriteCount(afterStatus, 'write_store_sqlite_patch'), storeWriteCount(beforeStatus, 'write_store_sqlite_patch'));
    assert.equal(sqliteWriteCount(afterStatus, 'discord_member_registration_card_push'), sqliteWriteCount(beforeStatus, 'discord_member_registration_card_push') + 1);
    assert.equal(settings.discord.lastMemberRegisterMessageId, 'sqlite_member_card_1');
    assert.equal(settings.discord.lastMemberRegisterLanguage, 'en');
    assert.equal(logs.some((log) => log.type === 'discord_member_registration_card_push'), true);
    assert.equal(Boolean(ref), true);
    assert.equal(ref.platform, 'discord');
    assert.equal(ref.status, 'active');
    assert.equal(ref.source, 'discord_member_registration_card_push');

    repositoryModule.injectSqliteStorePatchFailureForTests('operation_run_create', 2);
    const suppressedResponse = await httpFetch(`${baseUrl}/settings/discord/member-registration-card`, {
      method: 'POST',
      headers: {
        cookie,
        'content-type': 'application/json'
      },
      body: JSON.stringify({ language: 'en' })
    });
    const suppressedPayload = await suppressedResponse.json();
    assert.equal(suppressedResponse.status, 503, JSON.stringify(suppressedPayload));
    assert.match(suppressedPayload.error, /操作记录暂时无法写入/);
    assert.equal(discordMessages.length, 1);

    const beforeTrackingFailureStatus = await storeModule.storeRuntimeStatus({ sqliteSummary: false });
    const beforeTrackingFailureStat = await stat(storeModule.STORE_FILE);
    repositoryModule.injectSqliteStorePatchFailureForTests('discord_member_registration_card_push', 1);
    const trackingFailureResponse = await httpFetch(`${baseUrl}/settings/discord/member-registration-card`, {
      method: 'POST',
      headers: {
        cookie,
        'content-type': 'application/json'
      },
      body: JSON.stringify({ language: 'zh' })
    });
    const trackingFailurePayload = await trackingFailureResponse.json();
    assert.equal(trackingFailureResponse.status, 503, JSON.stringify(trackingFailurePayload));
    assert.match(trackingFailurePayload.error, /Discord 成员报名卡片状态记录暂不可用/);
    assert.equal(discordMessages.length, 2);
    assert.equal(discordMessages[1].channelId, memberRegisterChannelId);
    assert.equal(discordMessages[1].authorization, 'Bot sqlite_discord_member_card_bot_token');

    const afterTrackingFailureStatus = await storeModule.storeRuntimeStatus({ sqliteSummary: false });
    const afterTrackingFailureStat = await stat(storeModule.STORE_FILE);
    const trackingFailureSettings = await repositoryModule.getSqliteScalar('settings');
    const trackingFailureRefs = await repositoryModule.getSqliteCollection('integrationMessageRefs', { limit: 0 });
    const failedRegistrationRun = await waitForSqliteOperationRun(repositoryModule, (run) => (
      run.type === 'discord_member_registration_card_push' &&
      run.status === 'failed' &&
      run.messageId === 'sqlite_member_card_2' &&
      run.metadata?.trackingWriteFailed === 'true'
    ), 'Discord member registration card tracking failure run');
    const recoveredRegistrationRef = trackingFailureRefs.find((item) => (
      item.kind === 'member_registration_card' &&
      item.targetType === 'discord_target' &&
      item.channelId === memberRegisterChannelId &&
      item.messageId === 'sqlite_member_card_2'
    ));
    assert.equal(afterTrackingFailureStat.mtimeMs, beforeTrackingFailureStat.mtimeMs);
    assert.equal(afterTrackingFailureStatus.metrics.writes.total, beforeTrackingFailureStatus.metrics.writes.total);
    assert.equal(storeWriteCount(afterTrackingFailureStatus, 'write_store_sqlite_patch'), storeWriteCount(beforeTrackingFailureStatus, 'write_store_sqlite_patch'));
    assert.equal(trackingFailureSettings.discord.lastMemberRegisterMessageId, 'sqlite_member_card_1');
    assert.equal(trackingFailureSettings.discord.lastMemberRegisterLanguage, 'en');
    assert.equal(trackingFailureSettings.discord.lastPushError, '');
    assert.equal(failedRegistrationRun.metadata.externalActionSucceeded, 'true');
    assert.match(failedRegistrationRun.metadata.trackingWriteError, /Injected sqlite patch failure for discord_member_registration_card_push/);
    assert.equal(failedRegistrationRun.metadata.messageRefRecovered, 'true');
    assert.equal(failedRegistrationRun.metadata.messageRefWriteFailed, 'false');
    assert.equal(Boolean(recoveredRegistrationRef), true);
    assert.equal(recoveredRegistrationRef.source, 'discord_member_registration_card_push_recovery');
    assert.equal(recoveredRegistrationRef.metadata.trackingWriteFailed, true);
    assert.equal(recoveredRegistrationRef.metadata.language, 'zh');
  } finally {
    if (server) await new Promise((resolve) => server.close(resolve));
    if (discordServer) await new Promise((resolve) => discordServer.close(resolve));
    const sqliteModule = await import('../server/storage/sqlite.js');
    await sqliteModule.closeSqliteDatabasesForTests();
    Object.assign(process.env, previousEnv);
    for (const [key, value] of Object.entries(previousEnv)) {
      if (value === undefined) delete process.env[key];
    }
    await rm(dataDir, { recursive: true, force: true });
  }
});

test('sqlite-primary Discord member ranking card refresh records external-success tracking failures', async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'nb-clan-sqlite-discord-ranking-refresh-ref-'));
  const previousEnv = {
    NB_DATA_DIR: process.env.NB_DATA_DIR,
    NB_ROOT_PASSWORD: process.env.NB_ROOT_PASSWORD,
    NB_STORAGE_MODE: process.env.NB_STORAGE_MODE,
    NB_SQLITE_FILE: process.env.NB_SQLITE_FILE,
    NB_DISCORD_API_BASE_URL: process.env.NB_DISCORD_API_BASE_URL,
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
  let discordServer = null;
  const discordEdits = [];
  const discordMessages = [];
  const guildId = '123456789012393051';
  const memberRankingChannelId = '123456789012393052';
  const discordTargetId = 'default';
  const memberRankingMessageId = 'sqlite_ranking_card_1';
  const createdAt = '2026-07-02T00:00:00.000Z';

  try {
    const discordApp = express();
    discordApp.use(express.json());
    discordApp.patch('/channels/:channelId/messages/:messageId', (req, res) => {
      discordEdits.push({
        channelId: req.params.channelId,
        messageId: req.params.messageId,
        authorization: req.get('authorization') || '',
        body: req.body
      });
      res.json({
        id: req.params.messageId,
        channel_id: req.params.channelId
      });
    });
    discordApp.post('/channels/:channelId/messages', (req, res) => {
      const messageId = `sqlite_ranking_push_${discordMessages.length + 1}`;
      discordMessages.push({
        channelId: req.params.channelId,
        authorization: req.get('authorization') || '',
        body: req.body,
        messageId
      });
      res.json({
        id: messageId,
        channel_id: req.params.channelId
      });
    });
    discordServer = createServer(discordApp);
    await new Promise((resolve) => discordServer.listen(0, '127.0.0.1', resolve));
    process.env.NB_DISCORD_API_BASE_URL = `http://127.0.0.1:${discordServer.address().port}`;

    const storeModule = await uniqueImport('../server/store.js');
    const apiModule = await uniqueImport('../server/api.js');
    const authModule = await uniqueImport('../server/auth.js');
    const repositoryModule = await import('../server/storage/repository.js');
    await storeModule.ensureStore();
    await storeModule.updateStore((store) => {
      store.settings.discord = {
        ...(store.settings.discord || {}),
        botToken: 'sqlite_discord_ranking_refresh_bot_token',
        guildId,
        memberRankingChannelId,
        lastMemberRankingMessageId: memberRankingMessageId,
        lastMemberRankingLanguage: 'en',
        lastMemberRankingMetric: 'kills',
        lastMemberRankingRefreshAt: '2026-07-02T01:00:00.000Z',
        lastMemberRankingRefreshError: ''
      };
      store.wipes = (store.wipes || []).map((wipe) => (
        wipe.status === 'active' ? { ...wipe, status: 'closed' } : wipe
      ));
      store.wipes.unshift({
        id: 'wipe_sqlite_discord_ranking_refresh',
        name: 'SQLite Discord Ranking',
        serverName: 'SQLite Discord Ranking Server',
        status: 'active',
        startedAt: createdAt,
        createdAt,
        updatedAt: createdAt
      });
      store.members ||= [];
      store.members.push({
        id: 'member_sqlite_discord_ranking_refresh',
        steamId: '76561198001999321',
        rawInput: '76561198001999321',
        customName: 'SQLite Ranking Refresh',
        steamNickname: 'SQLite Ranking Refresh',
        avatar: '',
        discordId: '',
        wechatId: '',
        wechatUserId: '',
        notes: '',
        specialty: ['PVP'],
        memberStatus: 'active',
        invitedByUserId: '',
        createdAt,
        updatedAt: createdAt
      });
      store.kdaRows ||= [];
      store.kdaRows.push({
        id: 'kda_sqlite_discord_ranking_refresh',
        wipeId: 'wipe_sqlite_discord_ranking_refresh',
        memberId: 'member_sqlite_discord_ranking_refresh',
        steamId: '76561198001999321',
        kills: 12,
        deaths: 3,
        assists: 1,
        t3Kills: 6,
        rockets: 2,
        sulfur: 12000,
        metalOre: 32000,
        building: 450,
        playTimeMinutes: 240,
        raw: {},
        source: 'manual',
        capturedAt: createdAt,
        syncedAt: createdAt
      });
    });

    const app = express();
    app.use('/api', apiModule.createApiRouter());
    server = createServer(app);
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const baseUrl = `http://127.0.0.1:${server.address().port}/api`;
    const sessionId = await authModule.createSession('user_root');
    const cookie = `nb_session=${encodeURIComponent(sessionId)}`;
    const storeWriteCount = (status, name) => status.metrics?.writes?.byName?.[name]?.total || 0;
    const beforePushTrackingFailureStatus = await storeModule.storeRuntimeStatus({ sqliteSummary: false });
    const beforePushTrackingFailureStat = await stat(storeModule.STORE_FILE);

    repositoryModule.injectSqliteStorePatchFailureForTests('discord_member_ranking_card_push', 1);
    const pushTrackingFailureResponse = await httpFetch(`${baseUrl}/settings/discord/member-ranking-card`, {
      method: 'POST',
      headers: {
        cookie,
        'content-type': 'application/json'
      },
      body: JSON.stringify({ language: 'zh', metric: 'rockets' })
    });
    const pushTrackingFailurePayload = await pushTrackingFailureResponse.json();
    assert.equal(pushTrackingFailureResponse.status, 503, JSON.stringify(pushTrackingFailurePayload));
    assert.match(pushTrackingFailurePayload.error, /Discord 排行卡状态记录暂不可用/);
    assert.equal(discordMessages.length, 1);
    assert.equal(discordMessages[0].channelId, memberRankingChannelId);
    assert.equal(discordMessages[0].authorization, 'Bot sqlite_discord_ranking_refresh_bot_token');
    const afterPushTrackingFailureStatus = await storeModule.storeRuntimeStatus({ sqliteSummary: false });
    const afterPushTrackingFailureStat = await stat(storeModule.STORE_FILE);
    const pushFailureSettings = await repositoryModule.getSqliteScalar('settings');
    const failedPushRun = await waitForSqliteOperationRun(repositoryModule, (run) => (
      run.type === 'discord_member_ranking_card_push' &&
      run.status === 'failed' &&
      run.messageId === 'sqlite_ranking_push_1' &&
      run.metadata?.trackingWriteFailed === 'true'
    ), 'Discord member ranking push tracking failure run');
    const pushFailureRefs = await repositoryModule.getSqliteCollection('integrationMessageRefs', { limit: 0 });
    const recoveredPushRef = pushFailureRefs.find((item) => (
      item.platform === 'discord' &&
      item.kind === 'member_ranking_card' &&
      item.targetType === 'discord_target' &&
      item.targetId === discordTargetId &&
      item.channelId === memberRankingChannelId &&
      item.messageId === 'sqlite_ranking_push_1' &&
      item.source === 'discord_member_ranking_card_push_recovery'
    ));
    assert.equal(afterPushTrackingFailureStat.mtimeMs, beforePushTrackingFailureStat.mtimeMs);
    assert.equal(afterPushTrackingFailureStatus.metrics.writes.total, beforePushTrackingFailureStatus.metrics.writes.total);
    assert.equal(afterPushTrackingFailureStatus.metrics.sqliteWrites, beforePushTrackingFailureStatus.metrics.sqliteWrites);
    assert.equal(storeWriteCount(afterPushTrackingFailureStatus, 'write_store_sqlite_patch'), storeWriteCount(beforePushTrackingFailureStatus, 'write_store_sqlite_patch'));
    assert.equal(pushFailureSettings.discord.lastMemberRankingMessageId, memberRankingMessageId);
    assert.equal(pushFailureSettings.discord.lastMemberRankingLanguage, 'en');
    assert.equal(pushFailureSettings.discord.lastMemberRankingMetric, 'kills');
    assert.equal(failedPushRun.metadata.externalActionSucceeded, 'true');
    assert.match(failedPushRun.metadata.trackingWriteError, /Injected sqlite patch failure for discord_member_ranking_card_push/);
    assert.equal(failedPushRun.metadata.messageRefRecovered, 'true');
    assert.equal(failedPushRun.metadata.messageRefWriteFailed, 'false');
    assert.equal(Boolean(recoveredPushRef), true);
    assert.equal(recoveredPushRef.metadata.trackingWriteFailed, true);
    assert.equal(recoveredPushRef.metadata.metric, 'rockets');
    assert.equal(recoveredPushRef.metadata.language, 'zh');

    const beforeStatus = await storeModule.storeRuntimeStatus({ sqliteSummary: false });
    const beforeStat = await stat(storeModule.STORE_FILE);

    repositoryModule.injectSqliteStorePatchFailureForTests('discord_member_ranking_refresh', 1);
    const response = await httpFetch(`${baseUrl}/settings/discord/member-ranking-card/refresh`, {
      method: 'POST',
      headers: {
        cookie,
        'content-type': 'application/json'
      },
      body: JSON.stringify({})
    });
    const payload = await response.json();
    assert.equal(response.status, 503, JSON.stringify(payload));
    assert.match(payload.error, /Discord 排行卡状态记录暂不可用/);
    assert.equal(discordEdits.length, 1);
    assert.equal(discordEdits[0].channelId, memberRankingChannelId);
    assert.equal(discordEdits[0].messageId, memberRankingMessageId);
    assert.equal(discordEdits[0].authorization, 'Bot sqlite_discord_ranking_refresh_bot_token');

    const afterStatus = await storeModule.storeRuntimeStatus({ sqliteSummary: false });
    const afterStat = await stat(storeModule.STORE_FILE);
    const settings = await repositoryModule.getSqliteScalar('settings');
    const failedRefreshRun = await waitForSqliteOperationRun(repositoryModule, (run) => (
      run.type === 'discord_member_ranking_card_update' &&
      run.status === 'failed' &&
      run.messageId === memberRankingMessageId &&
      run.metadata?.trackingWriteFailed === 'true'
    ), 'Discord member ranking refresh tracking failure run');
    const refs = await repositoryModule.getSqliteCollection('integrationMessageRefs', { limit: 0 });
    const recoveredRef = refs.find((item) => (
      item.platform === 'discord' &&
      item.kind === 'member_ranking_card' &&
      item.targetType === 'discord_target' &&
      item.targetId === discordTargetId &&
      item.channelId === memberRankingChannelId &&
      item.messageId === memberRankingMessageId &&
      item.source === 'discord_member_ranking_card_refresh_recovery'
    ));
    assert.equal(afterStat.mtimeMs, beforeStat.mtimeMs);
    assert.equal(afterStatus.metrics.writes.total, beforeStatus.metrics.writes.total);
    assert.equal(storeWriteCount(afterStatus, 'write_store_sqlite_patch'), storeWriteCount(beforeStatus, 'write_store_sqlite_patch'));
    assert.equal(settings.discord.lastMemberRankingMessageId, memberRankingMessageId);
    assert.equal(settings.discord.lastMemberRankingLanguage, 'en');
    assert.equal(settings.discord.lastMemberRankingRefreshAt, '2026-07-02T01:00:00.000Z');
    assert.equal(settings.discord.lastMemberRankingRefreshError, '');
    assert.equal(failedRefreshRun.platform, 'discord');
    assert.equal(failedRefreshRun.source, 'manual');
    assert.equal(failedRefreshRun.targetType, 'member_ranking_card');
    assert.equal(failedRefreshRun.targetId, discordTargetId);
    assert.equal(failedRefreshRun.channelId, memberRankingChannelId);
    assert.equal(failedRefreshRun.retryable, true);
    assert.match(failedRefreshRun.errorSummary, /Injected sqlite patch failure for discord_member_ranking_refresh/);
    assert.equal(failedRefreshRun.metadata.externalActionSucceeded, 'true');
    assert.match(failedRefreshRun.metadata.trackingWriteError, /Injected sqlite patch failure for discord_member_ranking_refresh/);
    assert.equal(failedRefreshRun.metadata.messageRefRecovered, 'true');
    assert.equal(failedRefreshRun.metadata.messageRefWriteFailed, 'false');
    assert.equal(Boolean(recoveredRef), true);
    assert.equal(recoveredRef.metadata.trackingWriteFailed, true);
    assert.equal(recoveredRef.metadata.language, 'en');
  } finally {
    if (server) await new Promise((resolve) => server.close(resolve));
    if (discordServer) await new Promise((resolve) => discordServer.close(resolve));
    const sqliteModule = await import('../server/storage/sqlite.js');
    await sqliteModule.closeSqliteDatabasesForTests();
    Object.assign(process.env, previousEnv);
    for (const [key, value] of Object.entries(previousEnv)) {
      if (value === undefined) delete process.env[key];
    }
    await rm(dataDir, { recursive: true, force: true });
  }
});

test('sqlite-primary Discord map card push records external-success tracking failures', async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'nb-clan-sqlite-discord-map-card-ref-'));
  const previousEnv = {
    NB_DATA_DIR: process.env.NB_DATA_DIR,
    NB_ROOT_PASSWORD: process.env.NB_ROOT_PASSWORD,
    NB_STORAGE_MODE: process.env.NB_STORAGE_MODE,
    NB_SQLITE_FILE: process.env.NB_SQLITE_FILE,
    NB_DISCORD_API_BASE_URL: process.env.NB_DISCORD_API_BASE_URL,
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
  let discordServer = null;
  const discordMessages = [];
  const guildId = '123456789012393101';
  const mapChannelId = '123456789012393102';
  const wipeId = 'wipe_sqlite_discord_map_card';
  const createdAt = '2026-07-02T00:00:00.000Z';

  try {
    const discordApp = express();
    discordApp.use(express.json());
    discordApp.post('/channels/:channelId/messages', (req, res) => {
      const messageId = `sqlite_map_card_${discordMessages.length + 1}`;
      discordMessages.push({
        channelId: req.params.channelId,
        authorization: req.get('authorization') || '',
        body: req.body,
        messageId
      });
      res.json({
        id: messageId,
        channel_id: req.params.channelId
      });
    });
    discordServer = createServer(discordApp);
    await new Promise((resolve) => discordServer.listen(0, '127.0.0.1', resolve));
    process.env.NB_DISCORD_API_BASE_URL = `http://127.0.0.1:${discordServer.address().port}`;

    const storeModule = await uniqueImport('../server/store.js');
    const apiModule = await uniqueImport('../server/api.js');
    const authModule = await uniqueImport('../server/auth.js');
    const repositoryModule = await import('../server/storage/repository.js');
    await storeModule.ensureStore();
    await storeModule.updateStore((store) => {
      store.settings.discord = {
        ...(store.settings.discord || {}),
        botToken: 'sqlite_discord_map_card_bot_token',
        guildId,
        mapChannelId
      };
      store.wipes = (store.wipes || []).map((wipe) => (
        wipe.status === 'active' ? { ...wipe, status: 'closed' } : wipe
      ));
      store.wipes.unshift({
        id: wipeId,
        name: 'SQLite Discord Map',
        serverName: 'SQLite Discord Map Server',
        status: 'active',
        startedAt: createdAt,
        mapLink: 'https://cdn.example.com/sqlite-discord-map.map',
        rustMapsLink: 'https://rustmaps.com/map/sqlite-discord-map',
        rustMapsImageUrl: '/uploads/map-files/sqlite-discord-map.png',
        createdAt,
        updatedAt: createdAt
      });
      store.uploads ||= [];
      store.uploads.unshift({
        id: 'upload_sqlite_discord_map_card',
        ownerType: 'wipe',
        ownerId: wipeId,
        kind: 'map_image',
        fileName: 'sqlite-discord-map.png',
        originalName: 'sqlite-discord-map.png',
        mimeType: 'image/png',
        size: 68,
        url: '/uploads/map-files/sqlite-discord-map.png',
        createdBy: 'user_root',
        createdAt
      });
    });

    const app = express();
    app.use('/api', apiModule.createApiRouter());
    server = createServer(app);
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const baseUrl = `http://127.0.0.1:${server.address().port}/api`;
    const sessionId = await authModule.createSession('user_root');
    const cookie = `nb_session=${encodeURIComponent(sessionId)}`;
    const sqliteWriteCount = (status, name) => status.sqlite?.writes?.byName?.[name]?.total || 0;
    const storeWriteCount = (status, name) => status.metrics?.writes?.byName?.[name]?.total || 0;
    const beforeStatus = await storeModule.storeRuntimeStatus({ sqliteSummary: false });
    const beforeStat = await stat(storeModule.STORE_FILE);

    const response = await httpFetch(`${baseUrl}/settings/discord/map-card`, {
      method: 'POST',
      headers: {
        cookie,
        'content-type': 'application/json'
      },
      body: JSON.stringify({ language: 'en' })
    });
    const payload = await response.json();
    assert.equal(response.status, 200, JSON.stringify(payload));
    assert.equal(payload.message.id, 'sqlite_map_card_1');
    assert.equal(discordMessages.length, 1);
    assert.equal(discordMessages[0].channelId, mapChannelId);
    assert.equal(discordMessages[0].authorization, 'Bot sqlite_discord_map_card_bot_token');
    assert.equal(discordMessages[0].body.embeds[0].title, '🗺️ Map SQLite Discord Map Server');
    assert.equal(discordMessages[0].body.embeds[0].url, 'https://rustmaps.com/map/sqlite-discord-map');
    assert.match(discordMessages[0].body.embeds[0].image.url, /\/uploads\/map-files\/sqlite-discord-map\.png$/);

    const afterStatus = await storeModule.storeRuntimeStatus({ sqliteSummary: false });
    const afterStat = await stat(storeModule.STORE_FILE);
    const settings = await repositoryModule.getSqliteScalar('settings');
    const logs = await repositoryModule.getSqliteCollection('logs', { limit: 0 });
    const refs = await repositoryModule.getSqliteCollection('integrationMessageRefs', { limit: 0 });
    const ref = refs.find((item) => (
      item.kind === 'map_card' &&
      item.targetType === 'discord_target' &&
      item.channelId === mapChannelId &&
      item.messageId === 'sqlite_map_card_1'
    ));
    const pushSuccessRun = await waitForSqliteOperationRun(repositoryModule, (run) => (
      run.type === 'discord_map_card_push' &&
      run.status === 'succeeded' &&
      run.messageId === 'sqlite_map_card_1'
    ), 'Discord map card push success run');
    assert.equal(afterStat.mtimeMs, beforeStat.mtimeMs);
    assert.equal(afterStatus.metrics.writes.total, beforeStatus.metrics.writes.total);
    assert.equal(afterStatus.metrics.sqliteWrites, beforeStatus.metrics.sqliteWrites);
    assert.equal(storeWriteCount(afterStatus, 'write_store_sqlite_patch'), storeWriteCount(beforeStatus, 'write_store_sqlite_patch'));
    assert.equal(sqliteWriteCount(afterStatus, 'discord_map_card_push'), sqliteWriteCount(beforeStatus, 'discord_map_card_push') + 1);
    assert.equal(settings.discord.lastMapMessageId, 'sqlite_map_card_1');
    assert.equal(settings.discord.lastMapLanguage, 'en');
    assert.equal(settings.discord.lastPushError, '');
    assert.equal(logs.some((log) => log.type === 'discord_map_card_push'), true);
    assert.equal(Boolean(ref), true);
    assert.equal(ref.platform, 'discord');
    assert.equal(ref.status, 'active');
    assert.equal(ref.source, 'discord_map_card_push');
    assert.equal(pushSuccessRun.channelId, mapChannelId);

    repositoryModule.injectSqliteStorePatchFailureForTests('operation_run_create', 2);
    const operationRunUnavailableResponse = await httpFetch(`${baseUrl}/settings/discord/map-card`, {
      method: 'POST',
      headers: {
        cookie,
        'content-type': 'application/json'
      },
      body: JSON.stringify({ language: 'en' })
    });
    const operationRunUnavailablePayload = await operationRunUnavailableResponse.json();
    repositoryModule.injectSqliteStorePatchFailureForTests('operation_run_create', 0);
    assert.equal(operationRunUnavailableResponse.status, 503, JSON.stringify(operationRunUnavailablePayload));
    assert.match(operationRunUnavailablePayload.error, /操作记录暂时无法写入/);
    assert.equal(discordMessages.length, 1);

    const beforeTrackingFailureStatus = await storeModule.storeRuntimeStatus({ sqliteSummary: false });
    const beforeTrackingFailureStat = await stat(storeModule.STORE_FILE);
    repositoryModule.injectSqliteStorePatchFailureForTests('discord_map_card_push', 1);
    const trackingFailureResponse = await httpFetch(`${baseUrl}/settings/discord/map-card`, {
      method: 'POST',
      headers: {
        cookie,
        'content-type': 'application/json'
      },
      body: JSON.stringify({ language: 'zh' })
    });
    const trackingFailurePayload = await trackingFailureResponse.json();
    assert.equal(trackingFailureResponse.status, 503, JSON.stringify(trackingFailurePayload));
    assert.match(trackingFailurePayload.error, /Discord 地图卡片状态记录暂不可用/);
    assert.equal(discordMessages.length, 2);
    assert.equal(discordMessages[1].channelId, mapChannelId);
    assert.equal(discordMessages[1].authorization, 'Bot sqlite_discord_map_card_bot_token');

    const afterTrackingFailureStatus = await storeModule.storeRuntimeStatus({ sqliteSummary: false });
    const afterTrackingFailureStat = await stat(storeModule.STORE_FILE);
    const trackingFailureSettings = await repositoryModule.getSqliteScalar('settings');
    const trackingFailureRefs = await repositoryModule.getSqliteCollection('integrationMessageRefs', { limit: 0 });
    const failedMapRun = await waitForSqliteOperationRun(repositoryModule, (run) => (
      run.type === 'discord_map_card_push' &&
      run.status === 'failed' &&
      run.messageId === 'sqlite_map_card_2' &&
      run.metadata?.trackingWriteFailed === 'true'
    ), 'Discord map card tracking failure run');
    const recoveredMapRef = trackingFailureRefs.find((item) => (
      item.kind === 'map_card' &&
      item.targetType === 'discord_target' &&
      item.channelId === mapChannelId &&
      item.messageId === 'sqlite_map_card_2'
    ));
    assert.equal(afterTrackingFailureStat.mtimeMs, beforeTrackingFailureStat.mtimeMs);
    assert.equal(afterTrackingFailureStatus.metrics.writes.total, beforeTrackingFailureStatus.metrics.writes.total);
    assert.equal(storeWriteCount(afterTrackingFailureStatus, 'write_store_sqlite_patch'), storeWriteCount(beforeTrackingFailureStatus, 'write_store_sqlite_patch'));
    assert.equal(trackingFailureSettings.discord.lastMapMessageId, 'sqlite_map_card_1');
    assert.equal(trackingFailureSettings.discord.lastMapLanguage, 'en');
    assert.equal(trackingFailureSettings.discord.lastPushError, '');
    assert.equal(failedMapRun.metadata.externalActionSucceeded, 'true');
    assert.match(failedMapRun.metadata.trackingWriteError, /Injected sqlite patch failure for discord_map_card_push/);
    assert.equal(failedMapRun.metadata.messageRefRecovered, 'true');
    assert.equal(failedMapRun.metadata.messageRefWriteFailed, 'false');
    assert.equal(Boolean(recoveredMapRef), true);
    assert.equal(recoveredMapRef.source, 'discord_map_card_push_recovery');
    assert.equal(recoveredMapRef.metadata.trackingWriteFailed, true);
    assert.equal(recoveredMapRef.metadata.language, 'zh');
  } finally {
    if (server) await new Promise((resolve) => server.close(resolve));
    if (discordServer) await new Promise((resolve) => discordServer.close(resolve));
    const sqliteModule = await import('../server/storage/sqlite.js');
    await sqliteModule.closeSqliteDatabasesForTests();
    Object.assign(process.env, previousEnv);
    for (const [key, value] of Object.entries(previousEnv)) {
      if (value === undefined) delete process.env[key];
    }
    await rm(dataDir, { recursive: true, force: true });
  }
});

test('sqlite-primary KOOK member ranking card push records integration message refs in settings patch', async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'nb-clan-sqlite-kook-ranking-card-ref-'));
  const previousEnv = {
    NB_DATA_DIR: process.env.NB_DATA_DIR,
    NB_ROOT_PASSWORD: process.env.NB_ROOT_PASSWORD,
    NB_STORAGE_MODE: process.env.NB_STORAGE_MODE,
    NB_SQLITE_FILE: process.env.NB_SQLITE_FILE,
    NB_KOOK_API_BASE_URL: process.env.NB_KOOK_API_BASE_URL,
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
	  let kookServer = null;
	  const kookMessages = [];
	  const kookPosts = [];
	  const kookUpdates = [];
	  const memberRankingChannelId = 'sqlite_kook_ranking_channel';

  try {
    const kookApp = express();
    kookApp.use(express.json());
    kookApp.get('/api/v3/message/list', (req, res) => {
      const targetId = String(req.query.target_id || '');
      res.json({
        code: 0,
        message: '操作成功',
        data: {
          items: kookMessages.filter((message) => !targetId || message.target_id === targetId)
        }
      });
    });
	    kookApp.post('/api/v3/message/create', (req, res) => {
	      const messageId = `sqlite_kook_card_${kookPosts.length + 1}`;
      kookPosts.push({
        authorization: req.get('authorization') || '',
        body: req.body,
        messageId
      });
      kookMessages.push({
        id: messageId,
        msg_id: messageId,
        target_id: req.body?.target_id || '',
        type: req.body?.type,
        content: req.body?.content || '',
        create_at: Date.now()
      });
      res.json({
        code: 0,
        message: '操作成功',
        data: {
          msg_id: messageId,
          msg_timestamp: Date.now()
        }
	      });
	    });
	    kookApp.post('/api/v3/message/update', (req, res) => {
	      const messageId = String(req.body?.msg_id || '');
	      kookUpdates.push({
	        authorization: req.get('authorization') || '',
	        body: req.body,
	        messageId
	      });
	      const existing = kookMessages.find((message) => message.msg_id === messageId);
	      if (existing) {
	        existing.content = req.body?.content || existing.content || '';
	        existing.updated_at = Date.now();
	      }
	      res.json({
	        code: 0,
	        message: '操作成功',
	        data: {
	          msg_id: messageId,
	          msg_timestamp: Date.now()
	        }
	      });
	    });
	    kookServer = createServer(kookApp);
    await new Promise((resolve) => kookServer.listen(0, '127.0.0.1', resolve));
    process.env.NB_KOOK_API_BASE_URL = `http://127.0.0.1:${kookServer.address().port}/api/v3`;

    const storeModule = await uniqueImport('../server/store.js');
    const apiModule = await uniqueImport('../server/api.js');
    const authModule = await uniqueImport('../server/auth.js');
    const repositoryModule = await import('../server/storage/repository.js');
    const traceModule = await import('../server/trace-record-persistence.js');
    await storeModule.ensureStore();
    traceModule.resetTraceRecordPersistenceForTests();
    await storeModule.updateStore((store) => {
      store.settings.kook = {
        ...(store.settings.kook || {}),
        botToken: 'sqlite_kook_member_card_bot_token',
        verifyToken: 'sqlite_kook_verify_token',
        memberRankingChannelId
      };
    });

    const app = express();
    app.use('/api', apiModule.createApiRouter());
    server = createServer(app);
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const baseUrl = `http://127.0.0.1:${server.address().port}/api`;
    const sessionId = await authModule.createSession('user_root');
    const cookie = `nb_session=${encodeURIComponent(sessionId)}`;
    const sqliteWriteCount = (status, name) => status.sqlite?.writes?.byName?.[name]?.total || 0;
    const storeWriteCount = (status, name) => status.metrics?.writes?.byName?.[name]?.total || 0;
    const beforeStatus = await storeModule.storeRuntimeStatus({ sqliteSummary: false });
    const beforeStat = await stat(storeModule.STORE_FILE);

    const response = await httpFetch(`${baseUrl}/settings/kook/member-ranking-card`, {
      method: 'POST',
      headers: {
        cookie,
        'content-type': 'application/json'
      },
      body: JSON.stringify({ language: 'zh', metric: 'sulfur' })
    });
    const payload = await response.json();
    assert.equal(response.status, 200, JSON.stringify(payload));
    assert.equal(payload.message.id, 'sqlite_kook_card_1');
    assert.equal(payload.message.action, 'created');
    assert.equal(kookPosts.length, 1);
    assert.equal(kookPosts[0].authorization, 'Bot sqlite_kook_member_card_bot_token');
    assert.equal(kookPosts[0].body.type, 10);
    assert.equal(kookPosts[0].body.target_id, memberRankingChannelId);

    const afterStatus = await storeModule.storeRuntimeStatus({ sqliteSummary: false });
    const afterStat = await stat(storeModule.STORE_FILE);
    const settings = await repositoryModule.getSqliteScalar('settings');
    const logs = await repositoryModule.getSqliteCollection('logs', { limit: 0 });
    const refs = await repositoryModule.getSqliteCollection('integrationMessageRefs', { limit: 0 });
    const ref = refs.find((item) => (
      item.platform === 'kook' &&
      item.kind === 'member_ranking_card' &&
      item.targetType === 'kook_target' &&
      item.targetId === memberRankingChannelId &&
      item.channelId === memberRankingChannelId &&
      item.messageId === 'sqlite_kook_card_1'
    ));
    assert.equal(afterStat.mtimeMs, beforeStat.mtimeMs);
    assert.equal(afterStatus.metrics.writes.total, beforeStatus.metrics.writes.total);
    assert.equal(afterStatus.metrics.sqliteWrites, beforeStatus.metrics.sqliteWrites);
    assert.equal(storeWriteCount(afterStatus, 'write_store_sqlite_patch'), storeWriteCount(beforeStatus, 'write_store_sqlite_patch'));
    assert.equal(sqliteWriteCount(afterStatus, 'kook_member_ranking_card_push'), sqliteWriteCount(beforeStatus, 'kook_member_ranking_card_push') + 1);
    assert.equal(settings.kook.lastMemberRankingMessageId, 'sqlite_kook_card_1');
    assert.equal(settings.kook.lastMemberRankingLanguage, 'zh');
    assert.equal(settings.kook.lastMemberRankingMetric, 'sulfur');
    assert.equal(logs.some((log) => log.type === 'kook_member_ranking_card_push'), true);
    assert.equal(Boolean(ref), true);
    assert.equal(ref.status, 'active');
	    assert.equal(ref.source, 'kook_member_ranking_card_push');
	    assert.equal(ref.metadata.metric, 'sulfur');
	    assert.equal(ref.metadata.language, 'zh');

	    const beforePushTrackingFailureStatus = await storeModule.storeRuntimeStatus({ sqliteSummary: false });
	    const updatesBeforePushTrackingFailure = kookUpdates.length;
	    repositoryModule.injectSqliteStorePatchFailureForTests('kook_member_ranking_card_push', 1);
	    const pushTrackingFailureResponse = await httpFetch(`${baseUrl}/settings/kook/member-ranking-card`, {
	      method: 'POST',
	      headers: {
	        cookie,
	        'content-type': 'application/json'
	      },
	      body: JSON.stringify({ language: 'en', metric: 'rockets' })
	    });
	    const pushTrackingFailurePayload = await pushTrackingFailureResponse.json();
	    assert.equal(pushTrackingFailureResponse.status, 503, JSON.stringify(pushTrackingFailurePayload));
	    assert.match(pushTrackingFailurePayload.error, /KOOK 排行卡状态记录暂不可用/);
	    assert.equal(kookPosts.length, 1);
	    assert.equal(kookUpdates.length, updatesBeforePushTrackingFailure + 1);
	    assert.equal(kookUpdates[updatesBeforePushTrackingFailure].authorization, 'Bot sqlite_kook_member_card_bot_token');
	    assert.equal(kookUpdates[updatesBeforePushTrackingFailure].body.msg_id, 'sqlite_kook_card_1');
	    const pushTrackingFailureRuns = await repositoryModule.getSqliteCollection('operationRuns', { limit: 0 });
	    const failedPushRun = pushTrackingFailureRuns.find((run) => (
	      run.type === 'kook_member_ranking_card_push' &&
	      run.status === 'failed' &&
	      run.messageId === 'sqlite_kook_card_1' &&
	      run.metadata?.trackingWriteFailed === 'true'
	    ));
	    assert.equal(Boolean(failedPushRun), true);
	    assert.equal(failedPushRun.metadata.externalActionSucceeded, 'true');
	    assert.equal(failedPushRun.metadata.messageRefRecovered, 'true');
	    assert.equal(failedPushRun.metadata.messageRefWriteFailed, 'false');
	    assert.equal(failedPushRun.metadata.action, 'updated');
	    assert.match(failedPushRun.metadata.trackingWriteError, /Injected sqlite patch failure for kook_member_ranking_card_push/);
	    const pushTrackingFailureRefs = await repositoryModule.getSqliteCollection('integrationMessageRefs', { limit: 0 });
	    const recoveredPushRef = pushTrackingFailureRefs.find((item) => (
	      item.platform === 'kook' &&
	      item.kind === 'member_ranking_card' &&
	      item.targetType === 'kook_target' &&
	      item.targetId === memberRankingChannelId &&
	      item.channelId === memberRankingChannelId &&
	      item.messageId === 'sqlite_kook_card_1' &&
	      item.source === 'kook_member_ranking_card_push_recovery'
	    ));
	    assert.equal(Boolean(recoveredPushRef), true);
	    assert.equal(recoveredPushRef.metadata.trackingWriteFailed, true);
	    assert.equal(recoveredPushRef.metadata.metric, 'rockets');
	    assert.equal(recoveredPushRef.metadata.language, 'en');
	    const afterPushTrackingFailureStatus = await storeModule.storeRuntimeStatus({ sqliteSummary: false });
	    assert.equal(afterPushTrackingFailureStatus.metrics.writes.total, beforePushTrackingFailureStatus.metrics.writes.total);
	    assert.equal(afterPushTrackingFailureStatus.metrics.sqliteWrites, beforePushTrackingFailureStatus.metrics.sqliteWrites);
	    assert.equal(storeWriteCount(afterPushTrackingFailureStatus, 'write_store_sqlite_patch'), storeWriteCount(beforePushTrackingFailureStatus, 'write_store_sqlite_patch'));

	    const beforeTrackingFailureStatus = await storeModule.storeRuntimeStatus({ sqliteSummary: false });
	    const updatesBeforeRefreshTrackingFailure = kookUpdates.length;
	    repositoryModule.injectSqliteStorePatchFailureForTests('kook_member_ranking_refresh', 1);
	    const trackingFailureResponse = await httpFetch(`${baseUrl}/settings/kook/member-ranking-card/refresh`, {
	      method: 'POST',
	      headers: {
	        cookie,
	        'content-type': 'application/json'
	      },
	      body: JSON.stringify({})
	    });
	    const trackingFailurePayload = await trackingFailureResponse.json();
	    assert.equal(trackingFailureResponse.status, 503, JSON.stringify(trackingFailurePayload));
	    assert.match(trackingFailurePayload.error, /KOOK 排行卡状态记录暂不可用/);
	    assert.equal(kookPosts.length, 1);
	    assert.equal(kookUpdates.length, updatesBeforeRefreshTrackingFailure + 1);
	    assert.equal(kookUpdates[updatesBeforeRefreshTrackingFailure].authorization, 'Bot sqlite_kook_member_card_bot_token');
	    assert.equal(kookUpdates[updatesBeforeRefreshTrackingFailure].body.msg_id, 'sqlite_kook_card_1');
	    const trackingFailureRuns = await repositoryModule.getSqliteCollection('operationRuns', { limit: 0 });
	    const failedRefreshRun = trackingFailureRuns.find((run) => (
	      run.type === 'kook_member_ranking_card_refresh' &&
	      run.status === 'failed' &&
	      run.messageId === 'sqlite_kook_card_1' &&
	      run.metadata?.trackingWriteFailed === 'true'
	    ));
	    assert.equal(Boolean(failedRefreshRun), true);
	    assert.equal(failedRefreshRun.platform, 'kook');
	    assert.equal(failedRefreshRun.source, 'manual');
	    assert.equal(failedRefreshRun.targetType, 'member_ranking_card');
	    assert.equal(failedRefreshRun.targetId, memberRankingChannelId);
	    assert.equal(failedRefreshRun.channelId, memberRankingChannelId);
	    assert.equal(failedRefreshRun.retryable, true);
	    assert.match(failedRefreshRun.errorSummary, /Injected sqlite patch failure for kook_member_ranking_refresh/);
	    assert.equal(failedRefreshRun.metadata.externalActionSucceeded, 'true');
	    assert.equal(failedRefreshRun.metadata.messageRefRecovered, 'true');
	    assert.equal(failedRefreshRun.metadata.messageRefWriteFailed, 'false');
	    assert.equal(failedRefreshRun.metadata.action, 'updated');
	    assert.match(failedRefreshRun.metadata.trackingWriteError, /Injected sqlite patch failure for kook_member_ranking_refresh/);
	    const trackingFailureRefs = await repositoryModule.getSqliteCollection('integrationMessageRefs', { limit: 0 });
	    const recoveredRefreshRef = trackingFailureRefs.find((item) => (
	      item.platform === 'kook' &&
	      item.kind === 'member_ranking_card' &&
	      item.targetType === 'kook_target' &&
	      item.targetId === memberRankingChannelId &&
	      item.channelId === memberRankingChannelId &&
	      item.messageId === 'sqlite_kook_card_1' &&
	      item.source === 'kook_member_ranking_card_refresh_recovery'
	    ));
	    assert.equal(Boolean(recoveredRefreshRef), true);
	    assert.equal(recoveredRefreshRef.metadata.trackingWriteFailed, true);
	    assert.equal(recoveredRefreshRef.metadata.metric, 'sulfur');
	    assert.equal(recoveredRefreshRef.metadata.language, 'zh');
	    const afterTrackingFailureStatus = await storeModule.storeRuntimeStatus({ sqliteSummary: false });
	    assert.equal(afterTrackingFailureStatus.metrics.writes.total, beforeTrackingFailureStatus.metrics.writes.total);
	    assert.equal(afterTrackingFailureStatus.metrics.sqliteWrites, beforeTrackingFailureStatus.metrics.sqliteWrites);
	    assert.equal(storeWriteCount(afterTrackingFailureStatus, 'write_store_sqlite_patch'), storeWriteCount(beforeTrackingFailureStatus, 'write_store_sqlite_patch'));

	    repositoryModule.injectSqliteStorePatchFailureForTests('integration_event_create', 2);
    const challengeResponse = await httpFetch(`${baseUrl}/integrations/kook/events`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        s: 0,
        d: {
          verify_token: 'sqlite_kook_verify_token',
          channel_type: 'WEBHOOK_CHALLENGE',
          challenge: 'sqlite_kook_challenge_after_event_failure'
        }
      })
    });
    const challengePayload = await challengeResponse.json();
    assert.equal(challengeResponse.status, 200, JSON.stringify(challengePayload));
    assert.equal(challengePayload.challenge, 'sqlite_kook_challenge_after_event_failure');
    let traceRecord = traceModule.traceRecordPersistenceSnapshot().records
      .find((item) => item.name === 'integration_event_create');
    assert.equal(traceRecord?.fallbackSuppressed, 1);

    repositoryModule.injectSqliteStorePatchFailureForTests('integration_event_create', 2);
    const buttonResponse = await httpFetch(`${baseUrl}/integrations/kook/events`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        s: 0,
        d: {
          verify_token: 'sqlite_kook_verify_token',
          extra: {
            type: 'message_btn_click',
            body: {
              value: 'sqlite_kook_unknown_button',
              msg_id: 'sqlite_kook_card_1',
              user_id: 'sqlite_kook_user_1',
              target_id: memberRankingChannelId
            }
          }
        }
      })
    });
    const buttonPayload = await buttonResponse.json();
    assert.equal(buttonResponse.status, 200, JSON.stringify(buttonPayload));
    assert.equal(buttonPayload.ok, true);
    assert.equal(buttonPayload.queued, true);
	    traceRecord = traceModule.traceRecordPersistenceSnapshot().records
	      .find((item) => item.name === 'integration_event_create');
	    assert.equal(traceRecord?.fallbackSuppressed, 2);

	    const postsBeforeButtonTrackingFailure = kookPosts.length;
	    const updatesBeforeButtonTrackingFailure = kookUpdates.length;
	    repositoryModule.injectSqliteStorePatchFailureForTests('kook_member_ranking_button', 1);
	    const trackingFailureMetricButtonValue = 'nb_kook_member_ranking:metric:deaths';
	    const trackingFailureMetricButtonResponse = await httpFetch(`${baseUrl}/integrations/kook/events`, {
	      method: 'POST',
	      headers: { 'content-type': 'application/json' },
	      body: JSON.stringify({
	        s: 0,
	        d: {
	          verify_token: 'sqlite_kook_verify_token',
	          event_id: 'sqlite_kook_metric_button_tracking_failure',
	          extra: {
	            type: 'message_btn_click',
	            body: {
	              value: trackingFailureMetricButtonValue,
	              msg_id: 'sqlite_kook_card_1',
	              user_id: 'sqlite_kook_user_tracking_failure',
	              target_id: memberRankingChannelId
	            }
	          }
	        }
	      })
	    });
	    const trackingFailureMetricButtonPayload = await trackingFailureMetricButtonResponse.json();
	    assert.equal(trackingFailureMetricButtonResponse.status, 200, JSON.stringify(trackingFailureMetricButtonPayload));
	    assert.equal(trackingFailureMetricButtonPayload.ok, true);
	    assert.equal(trackingFailureMetricButtonPayload.queued, true);
	    const failedButtonTrackingEvent = await waitForSqliteCollectionMatch(
	      repositoryModule,
	      'integrationEvents',
	      (event) => (
	        event.platform === 'kook' &&
	        event.status === 'failed' &&
	        event.metadata?.buttonValue === trackingFailureMetricButtonValue &&
	        event.metadata?.trackingWriteFailed === 'true'
	      ),
	      'failed KOOK metric button after local tracking write failure'
	    );
	    assert.match(failedButtonTrackingEvent.errorSummary, /Injected sqlite patch failure for kook_member_ranking_button/);
	    assert.equal(failedButtonTrackingEvent.metadata.externalActionSucceeded, 'true');
	    assert.equal(failedButtonTrackingEvent.metadata.messageRefRecovered, 'true');
	    assert.equal(failedButtonTrackingEvent.metadata.messageRefWriteFailed, 'false');
	    assert.equal(failedButtonTrackingEvent.metadata.metric, 'deaths');
	    assert.equal(kookPosts.length, postsBeforeButtonTrackingFailure);
	    assert.equal(kookUpdates.length, updatesBeforeButtonTrackingFailure + 1);
	    const buttonTrackingFailureRefs = await repositoryModule.getSqliteCollection('integrationMessageRefs', { limit: 0 });
	    const recoveredButtonRef = buttonTrackingFailureRefs.find((item) => (
	      item.platform === 'kook' &&
	      item.kind === 'member_ranking_card' &&
	      item.targetType === 'kook_target' &&
	      item.targetId === memberRankingChannelId &&
	      item.channelId === memberRankingChannelId &&
	      item.messageId === 'sqlite_kook_card_1' &&
	      item.source === 'kook_member_ranking_button_recovery'
	    ));
	    assert.equal(Boolean(recoveredButtonRef), true);
	    assert.equal(recoveredButtonRef.metadata.trackingWriteFailed, true);
	    assert.equal(recoveredButtonRef.metadata.metric, 'deaths');

	    const postsBeforeSuppressedButton = kookPosts.length;
	    const updatesBeforeSuppressedButton = kookUpdates.length;
	    const operationTraceBeforeSuppressedButton = traceModule.traceRecordPersistenceSnapshot().records
	      .find((item) => item.name === 'operation_run_create')?.fallbackSuppressed || 0;
	    repositoryModule.injectSqliteStorePatchFailureForTests('operation_run_create', 2);
	    const metricButtonValue = 'nb_kook_member_ranking:metric:kills';
	    const suppressedMetricButtonResponse = await httpFetch(`${baseUrl}/integrations/kook/events`, {
	      method: 'POST',
	      headers: { 'content-type': 'application/json' },
	      body: JSON.stringify({
	        s: 0,
	        d: {
	          verify_token: 'sqlite_kook_verify_token',
	          event_id: 'sqlite_kook_metric_button_operation_run_failure',
	          extra: {
	            type: 'message_btn_click',
	            body: {
	              value: metricButtonValue,
	              msg_id: 'sqlite_kook_card_1',
	              user_id: 'sqlite_kook_user_2',
	              target_id: memberRankingChannelId
	            }
	          }
	        }
	      })
	    });
	    const suppressedMetricButtonPayload = await suppressedMetricButtonResponse.json();
	    assert.equal(suppressedMetricButtonResponse.status, 200, JSON.stringify(suppressedMetricButtonPayload));
	    assert.equal(suppressedMetricButtonPayload.ok, true);
	    assert.equal(suppressedMetricButtonPayload.queued, true);
	    const failedMetricButtonEvent = await waitForSqliteCollectionMatch(
	      repositoryModule,
	      'integrationEvents',
	      (event) => (
	        event.platform === 'kook' &&
	        event.status === 'failed' &&
	        event.metadata?.buttonValue === metricButtonValue
	      ),
	      'failed KOOK metric button after operation run create failure'
	    );
	    assert.match(failedMetricButtonEvent.errorSummary, /KOOK 卡片操作记录暂时无法写入/);
	    assert.equal(kookPosts.length, postsBeforeSuppressedButton);
	    assert.equal(kookUpdates.length, updatesBeforeSuppressedButton);
	    const operationTraceAfterSuppressedButton = traceModule.traceRecordPersistenceSnapshot().records
	      .find((item) => item.name === 'operation_run_create')?.fallbackSuppressed || 0;
	    assert.equal(operationTraceAfterSuppressedButton, operationTraceBeforeSuppressedButton + 1);

	    repositoryModule.injectSqliteStorePatchFailureForTests('operation_run_create', 2);
	    const suppressedResponse = await httpFetch(`${baseUrl}/settings/kook/member-ranking-card`, {
	      method: 'POST',
      headers: {
        cookie,
        'content-type': 'application/json'
      },
      body: JSON.stringify({ language: 'zh', metric: 'sulfur' })
    });
    const suppressedPayload = await suppressedResponse.json();
    assert.equal(suppressedResponse.status, 503, JSON.stringify(suppressedPayload));
    assert.match(suppressedPayload.error, /操作记录暂时无法写入/);
    assert.equal(kookPosts.length, 1);

    repositoryModule.injectSqliteStorePatchFailureForTests('operation_run_create', 2);
    const suppressedRefreshResponse = await httpFetch(`${baseUrl}/settings/kook/member-ranking-card/refresh`, {
      method: 'POST',
      headers: {
        cookie,
        'content-type': 'application/json'
      },
      body: JSON.stringify({})
    });
    const suppressedRefreshPayload = await suppressedRefreshResponse.json();
    assert.equal(suppressedRefreshResponse.status, 503, JSON.stringify(suppressedRefreshPayload));
    assert.match(suppressedRefreshPayload.error, /操作记录暂时无法写入/);
    assert.equal(kookPosts.length, 1);
  } finally {
    if (server) await new Promise((resolve) => server.close(resolve));
    if (kookServer) await new Promise((resolve) => kookServer.close(resolve));
    const sqliteModule = await import('../server/storage/sqlite.js');
    await sqliteModule.closeSqliteDatabasesForTests();
    Object.assign(process.env, previousEnv);
    for (const [key, value] of Object.entries(previousEnv)) {
      if (value === undefined) delete process.env[key];
    }
    await rm(dataDir, { recursive: true, force: true });
  }
});

test('sqlite-primary wechat admin server update uses settings direct SQLite patch writes', async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'nb-clan-sqlite-wechat-admin-server-'));
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
    const sqliteWriteCount = (status, name) => status.sqlite?.writes?.byName?.[name]?.total || 0;
    const storeWriteCount = (status, name) => status.metrics?.writes?.byName?.[name]?.total || 0;
    const beforeStatus = await storeModule.storeRuntimeStatus({ sqliteSummary: false });
    const beforeStat = await stat(storeModule.STORE_FILE);

    const response = await httpFetch(`${baseUrl}/wechat/admin/servers/23`, {
      method: 'PUT',
      headers: {
        cookie,
        'content-type': 'application/json'
      },
      body: JSON.stringify({
        name: 'SQLite WeChat Managed Server',
        directConnect: 'client.connect sqlite-wechat.example:28015',
        vipUrl: 'https://example.com/sqlite-wechat-vip',
        mapLink: 'https://example.com/sqlite-wechat-map',
        rustMapsLink: 'https://rustmaps.com/map/sqlite-wechat',
        status: 'maintenance',
        notes: 'sqlite wechat server note'
      })
    });
    const payload = await response.json();
    assert.equal(response.status, 200, JSON.stringify(payload));
    assert.equal(payload.server.vitalServerId, '23');
    assert.equal(payload.server.name, 'SQLite WeChat Managed Server');
    assert.equal(payload.server.status, 'maintenance');
    assert.equal(payload.server.directConnect, 'client.connect sqlite-wechat.example:28015');
    assert.equal(payload.servers.find((serverItem) => serverItem.vitalServerId === '23').rustMapsLink, 'https://rustmaps.com/map/sqlite-wechat');

    const afterStatus = await storeModule.storeRuntimeStatus({ sqliteSummary: false });
    const afterStat = await stat(storeModule.STORE_FILE);
    const settings = await repositoryModule.getSqliteScalar('settings');
    const logs = await repositoryModule.getSqliteCollection('logs', { limit: 0 });
    const override = settings.vitalServers.overrides.find((item) => item.vitalServerId === '23');
    assert.equal(afterStat.mtimeMs, beforeStat.mtimeMs);
    assert.equal(afterStatus.metrics.writes.total, beforeStatus.metrics.writes.total);
    assert.equal(afterStatus.metrics.sqliteWrites, beforeStatus.metrics.sqliteWrites);
    assert.equal(storeWriteCount(afterStatus, 'write_store_sqlite_patch'), storeWriteCount(beforeStatus, 'write_store_sqlite_patch'));
    assert.equal(sqliteWriteCount(afterStatus, 'wechat_admin_server_update'), sqliteWriteCount(beforeStatus, 'wechat_admin_server_update') + 1);
    assert.equal(override.name, 'SQLite WeChat Managed Server');
    assert.equal(override.status, 'maintenance');
    assert.equal(override.notes, 'sqlite wechat server note');
    assert.equal(logs.some((log) => (
      log.type === 'wechat_admin_server_update' &&
      log.targetId === '23' &&
      log.metadata?.status === 'maintenance'
    )), true);
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

test('sqlite-primary settings updates patch logs and trim history without rewriting store.json', async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'nb-clan-sqlite-settings-log-patch-'));
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

  let server = null;
  try {
    const storeModule = await uniqueImport('../server/store.js');
    const apiModule = await uniqueImport('../server/api.js');
    const authModule = await uniqueImport('../server/auth.js');
    await storeModule.ensureStore();
    const repositoryModule = await import('../server/storage/repository.js');
    const seededLogs = Array.from({ length: 1002 }, (_, index) => {
      const createdAt = new Date(Date.UTC(2026, 0, 1, 0, 0, index)).toISOString();
      return {
        id: `settings_log_seed_${String(index).padStart(4, '0')}`,
        type: 'settings_seed',
        actorUserId: 'system',
        actorUsername: 'system',
        ip: '127.0.0.1',
        steamId: '',
        targetId: '',
        summary: `settings seed ${index}`,
        metadata: {},
        createdAt
      };
    });
    await repositoryModule.writeSqliteStorePatch({
      reason: 'seed_settings_logs',
      upserts: { logs: seededLogs },
      positions: {
        logs: Object.fromEntries(seededLogs.map((log, index) => [log.id, seededLogs.length - index]))
      }
    });

    const app = express();
    app.use('/api', apiModule.createApiRouter());
    server = createServer(app);
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const baseUrl = `http://127.0.0.1:${server.address().port}/api`;
    const sessionId = await authModule.createSession('user_root');
    const cookie = `nb_session=${encodeURIComponent(sessionId)}`;
    const queryCount = (status, name) => status.sqlite?.queries?.byName?.[name]?.total || 0;
    const writeCount = (status, name) => status.sqlite?.writes?.byName?.[name]?.total || 0;
    const beforeStatus = await storeModule.storeRuntimeStatus({ sqliteSummary: false });
    const beforeStat = await stat(storeModule.STORE_FILE);
    const publicApiToken = 'public_api_token_settings_log_patch_1234567890';
    const response = await globalThis.fetch(`${baseUrl}/settings/public-api`, {
      method: 'PUT',
      headers: {
        cookie,
        'content-type': 'application/json'
      },
      body: JSON.stringify({ token: publicApiToken })
    });
    const payload = await response.json();
    assert.equal(response.status, 200, JSON.stringify(payload));
    assert.equal(payload.ok, true);

    const afterStatus = await storeModule.storeRuntimeStatus({ sqliteSummary: false });
    const afterStat = await stat(storeModule.STORE_FILE);
    const settings = await repositoryModule.getSqliteScalar('settings');
    const logs = await repositoryModule.getSqliteCollection('logs', { limit: 0 });
    assert.equal(afterStat.mtimeMs, beforeStat.mtimeMs);
    assert.equal(afterStatus.metrics.writes.total, beforeStatus.metrics.writes.total);
    assert.equal(afterStatus.metrics.sqliteWrites, beforeStatus.metrics.sqliteWrites);
    assert.equal(
      afterStatus.sqlite.compatibility.syncStoreChangesToSqlite,
      beforeStatus.sqlite.compatibility.syncStoreChangesToSqlite
    );
    assert.equal(queryCount(afterStatus, 'list_logs'), queryCount(beforeStatus, 'list_logs'));
    assert.equal(writeCount(afterStatus, 'public_api_token_update'), writeCount(beforeStatus, 'public_api_token_update') + 1);
    assert.equal(writeCount(afterStatus, 'public_api_token_update_log_trim'), writeCount(beforeStatus, 'public_api_token_update_log_trim'));
    assert.equal(Boolean(settings.publicApi.tokenHash), true);
    assert.equal(Boolean(settings.publicApi.tokenUpdatedAt), true);
    assert.equal(logs.length, 1000);
    assert.equal(logs.some((log) => log.type === 'public_api_token_edit'), true);
    assert.equal(logs.some((log) => log.id === 'settings_log_seed_1001'), true);
    assert.equal(logs.some((log) => log.id === 'settings_log_seed_0000'), false);
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

test('sqlite-primary settings reads degrade without full store fallback', async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'nb-clan-sqlite-service-proxy-settings-'));
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
    const settingsStoreModule = await uniqueImport('../server/settings-store.js');
    const repositoryModule = await import('../server/storage/repository.js');
    await storeModule.ensureStore();

    const beforeStatus = await storeModule.storeRuntimeStatus({ sqliteSummary: false });
    const beforeReadStoreFull = queryCount(beforeStatus, 'read_store_full');
    repositoryModule.injectSqliteQueryFailureForTests('scalar_settings', 1);

    const proxyStore = await settingsStoreModule.readServiceProxyStore();
    assert.equal(proxyStore.serviceProxySettingsPartial, true);
    assert.match(proxyStore.serviceProxySettingsReadError, /Injected sqlite query failure for scalar_settings/);
    assert.deepEqual(proxyStore.settings, {});

    repositoryModule.injectSqliteQueryFailureForTests('scalar_settings', 1);
    const runtimeStore = await settingsStoreModule.readSettingsRuntimeStore();
    assert.equal(runtimeStore.settingsPartial, true);
    assert.equal(runtimeStore.settingsReadSource, 'settings_runtime');
    assert.match(runtimeStore.settingsReadError, /Injected sqlite query failure for scalar_settings/);
    assert.deepEqual(runtimeStore.settings, {});

    repositoryModule.injectSqliteQueryFailureForTests('list_permissionRoles', 1);
    const permissionStore = await settingsStoreModule.readSettingsPermissionRuntimeStore();
    assert.equal(permissionStore.settingsPartial, true);
    assert.equal(permissionStore.settingsReadSource, 'settings_permission');
    assert.match(permissionStore.settingsReadError, /Injected sqlite query failure for list_permissionRoles/);
    assert.deepEqual(permissionStore.permissionRoles, []);
    assert.deepEqual(permissionStore.settings, {});

    const afterStatus = await storeModule.storeRuntimeStatus({ sqliteSummary: false });
    assert.equal(queryCount(afterStatus, 'read_store_full'), beforeReadStoreFull);
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

test('sqlite-primary team logo upload uses direct SQLite patch writes', async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'nb-clan-sqlite-team-logo-upload-'));
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

  let server = null;
  let apiLogoDir = '';
  try {
    const storeModule = await uniqueImport('../server/store.js');
    const apiModule = await uniqueImport('../server/api.js');
    const authModule = await uniqueImport('../server/auth.js');
    await storeModule.ensureStore();
    const repositoryModule = await import('../server/storage/repository.js');
    const apiStoreModule = await import('../server/store.js');
    apiLogoDir = path.join(apiStoreModule.DATA_DIR, 'uploads', 'team-logo');
    await mkdir(apiLogoDir, { recursive: true });
    const oldFilePath = path.join(apiLogoDir, 'old-team-logo.png');
    await writeFile(oldFilePath, Buffer.from('old-logo'));
    const oldUpload = {
      id: 'upload_sqlite_old_team_logo',
      ownerType: 'system',
      ownerId: 'team-logo',
      kind: 'team_logo',
      fileName: 'old-team-logo.png',
      originalName: 'old-team-logo.png',
      mimeType: 'image/png',
      size: 8,
      url: '/uploads/team-logo/old-team-logo.png',
      createdBy: 'user_root',
      createdAt: '2026-01-01T00:00:00.000Z'
    };
    const settings = await repositoryModule.getSqliteScalar('settings') || {};
    settings.system ||= {};
    settings.system.teamLogoUrl = oldUpload.url;
    settings.system.teamLogoUpdatedAt = oldUpload.createdAt;
    await repositoryModule.writeSqliteStorePatch({
      reason: 'seed_team_logo_upload',
      upserts: { uploads: [oldUpload] },
      scalars: { settings }
    });

    const app = express();
    app.use('/api', apiModule.createApiRouter());
    server = createServer(app);
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const baseUrl = `http://127.0.0.1:${server.address().port}/api`;
    const sessionId = await authModule.createSession('user_root');
    const cookie = `nb_session=${encodeURIComponent(sessionId)}`;
    const queryCount = (status, name) => status.sqlite?.queries?.byName?.[name]?.total || 0;
    const writeCount = (status, name) => status.sqlite?.writes?.byName?.[name]?.total || 0;

    const failureBeforeStatus = await storeModule.storeRuntimeStatus({ sqliteSummary: false });
    const failureBeforeStat = await stat(storeModule.STORE_FILE);
    const logoFilesBeforeFailure = new Set(await readdir(apiLogoDir));
    repositoryModule.injectSqliteStorePatchFailureForTests('system_team_logo_upload', 1);
    const failureResponse = await globalThis.fetch(`${baseUrl}/settings/system/team-logo`, {
      method: 'POST',
      headers: {
        cookie,
        'content-type': 'application/json'
      },
      body: JSON.stringify({
        originalName: 'sqlite-team-logo-failure.png',
        mimeType: 'image/png',
        dataUrl: `data:image/png;base64,${Buffer.from('sqlite-failed-logo').toString('base64')}`
      })
    });
    const failurePayload = await failureResponse.json();
    assert.equal(failureResponse.status, 503, JSON.stringify(failurePayload));
    assert.match(failurePayload.error, /战队徽标写入暂不可用/);
    const failureAfterStatus = await storeModule.storeRuntimeStatus({ sqliteSummary: false });
    const failureAfterStat = await stat(storeModule.STORE_FILE);
    const logoFilesAfterFailure = new Set(await readdir(apiLogoDir));
    assert.deepEqual(logoFilesAfterFailure, logoFilesBeforeFailure);
    assert.equal(failureAfterStat.mtimeMs, failureBeforeStat.mtimeMs);
    assert.equal(failureAfterStatus.metrics.reads.total, failureBeforeStatus.metrics.reads.total);
    assert.equal(failureAfterStatus.metrics.clones.total, failureBeforeStatus.metrics.clones.total);
    assert.equal(failureAfterStatus.metrics.writes.total, failureBeforeStatus.metrics.writes.total);
    assert.equal(queryCount(failureAfterStatus, 'read_store_full'), queryCount(failureBeforeStatus, 'read_store_full'));
    const failedSettings = await repositoryModule.getSqliteScalar('settings');
    const failedUploads = await repositoryModule.getSqliteRecordsByJsonField('uploads', 'ownerId', ['team-logo'], { limit: 0 });
    assert.equal(failedSettings.system.teamLogoUrl, oldUpload.url);
    assert.deepEqual(failedUploads.map((upload) => upload.id), [oldUpload.id]);

    const beforeStatus = await storeModule.storeRuntimeStatus({ sqliteSummary: false });
    const beforeStat = await stat(storeModule.STORE_FILE);

    const logoDataUrl = `data:image/png;base64,${Buffer.from('sqlite-new-logo').toString('base64')}`;
    const response = await globalThis.fetch(`${baseUrl}/settings/system/team-logo`, {
      method: 'POST',
      headers: {
        cookie,
        'content-type': 'application/json'
      },
      body: JSON.stringify({
        originalName: 'sqlite-team-logo.png',
        mimeType: 'image/png',
        dataUrl: logoDataUrl
      })
    });
    const payload = await response.json();
    assert.equal(response.status, 200, JSON.stringify(payload));
    assert.equal(payload.ok, true);
    assert.match(payload.system.teamLogoUrl, /^\/uploads\/team-logo\/upload_/);

    const afterStatus = await storeModule.storeRuntimeStatus({ sqliteSummary: false });
    const afterStat = await stat(storeModule.STORE_FILE);
    assert.equal(afterStat.mtimeMs, beforeStat.mtimeMs);
    assert.equal(afterStatus.metrics.writes.total, beforeStatus.metrics.writes.total);
    assert.equal(afterStatus.metrics.sqliteWrites, beforeStatus.metrics.sqliteWrites);
    assert.equal(queryCount(afterStatus, 'list_uploads'), queryCount(beforeStatus, 'list_uploads'));
    assert.equal(queryCount(afterStatus, 'list_uploads_ownerId'), queryCount(beforeStatus, 'list_uploads_ownerId') + 1);
    assert.equal(writeCount(afterStatus, 'system_team_logo_upload'), writeCount(beforeStatus, 'system_team_logo_upload') + 1);
    assert.equal(writeCount(afterStatus, 'system_team_logo_upload_log_trim'), writeCount(beforeStatus, 'system_team_logo_upload_log_trim'));

    const persistedSettings = await repositoryModule.getSqliteScalar('settings');
    const uploads = await repositoryModule.getSqliteRecordsByJsonField('uploads', 'ownerId', ['team-logo'], { limit: 0 });
    assert.equal(persistedSettings.system.teamLogoUrl, payload.system.teamLogoUrl);
    assert.equal(uploads.length, 1);
    assert.equal(uploads[0].originalName, 'sqlite-team-logo.png');
    assert.equal(await repositoryModule.getSqliteRecord('uploads', oldUpload.id), null);
    await assert.rejects(() => stat(oldFilePath), { code: 'ENOENT' });
    const newFilePath = path.join(apiLogoDir, uploads[0].fileName);
    assert.equal((await stat(newFilePath)).size, Buffer.from('sqlite-new-logo').length);
  } finally {
    if (server) await new Promise((resolve) => server.close(resolve));
    const sqliteModule = await import('../server/storage/sqlite.js');
    await sqliteModule.closeSqliteDatabasesForTests();
    if (apiLogoDir && !path.resolve(apiLogoDir).startsWith(path.resolve(dataDir))) {
      await rm(apiLogoDir, { recursive: true, force: true });
    }
    Object.assign(process.env, previousEnv);
    for (const [key, value] of Object.entries(previousEnv)) {
      if (value === undefined) delete process.env[key];
    }
    await rm(dataDir, { recursive: true, force: true });
  }
});

test('sqlite-primary account alert dismissals use direct SQLite patch writes', async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'nb-clan-sqlite-account-alert-dismissals-'));
  const previousEnv = {
    NB_DATA_DIR: process.env.NB_DATA_DIR,
    NB_ROOT_PASSWORD: process.env.NB_ROOT_PASSWORD,
    NB_STORAGE_MODE: process.env.NB_STORAGE_MODE,
    NB_SQLITE_FILE: process.env.NB_SQLITE_FILE,
    NB_DISABLE_BACKGROUND_JOBS: process.env.NB_DISABLE_BACKGROUND_JOBS,
    NB_DISABLE_EXTERNAL_VITAL: process.env.NB_DISABLE_EXTERNAL_VITAL,
    NB_TRACE_RECORD_DIRECT_RETRY_ATTEMPTS: process.env.NB_TRACE_RECORD_DIRECT_RETRY_ATTEMPTS,
    NB_TRACE_RECORD_GENERIC_FALLBACK_MAX_PER_WINDOW: process.env.NB_TRACE_RECORD_GENERIC_FALLBACK_MAX_PER_WINDOW
  };
  const httpFetch = globalThis.fetch.bind(globalThis);
  process.env.NB_DATA_DIR = dataDir;
  process.env.NB_ROOT_PASSWORD = 'RootPass123!';
  process.env.NB_STORAGE_MODE = 'sqlite-primary';
  process.env.NB_SQLITE_FILE = path.join(dataDir, 'nb-clan.sqlite');
  process.env.NB_DISABLE_BACKGROUND_JOBS = '1';
  process.env.NB_DISABLE_EXTERNAL_VITAL = '1';

  let server = null;
  try {
    const storeModule = await uniqueImport('../server/store.js');
    const apiModule = await uniqueImport('../server/api.js');
    const authModule = await uniqueImport('../server/auth.js');
    const repositoryModule = await import('../server/storage/repository.js');
    await storeModule.ensureStore();
    const createdAt = new Date().toISOString();
    await repositoryModule.writeSqliteStorePatch({
      reason: 'sqlite_test_account_alert_member_seed',
      upserts: {
        members: [{
          id: 'member_sqlite_account_alert',
          steamId: '76561198008888881',
          rawInput: '76561198008888881',
          customName: 'SQLite Alert Member',
          steamNickname: 'SQLite Alert Member',
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
        }]
      }
    });

    const app = express();
    app.use('/api', apiModule.createApiRouter());
    server = createServer(app);
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const baseUrl = `http://127.0.0.1:${server.address().port}/api`;
    const sessionId = await authModule.createSession('user_root');
    const cookie = `nb_session=${encodeURIComponent(sessionId)}`;

    const beforeStatus = await storeModule.storeRuntimeStatus();
    const beforeStat = await stat(storeModule.STORE_FILE);
    const writeCount = (status, name) => status.sqlite?.writes?.byName?.[name]?.total || 0;
    const beforeDismissWrite = writeCount(beforeStatus, 'account_alert_dismiss');
    const beforeDismissLogTrimWrite = writeCount(beforeStatus, 'account_alert_dismiss_log_trim');
    const beforeClearWrite = writeCount(beforeStatus, 'account_alert_dismiss_clear');
    const beforeClearLogTrimWrite = writeCount(beforeStatus, 'account_alert_dismiss_clear_log_trim');

    const dismissResponse = await httpFetch(`${baseUrl}/account-alert-dismissals`, {
      method: 'POST',
      headers: {
        cookie,
        'content-type': 'application/json'
      },
      body: JSON.stringify({ id: 'member_sqlite_account_alert:private-inventory' })
    });
    const dismissPayload = await dismissResponse.json();
    assert.equal(dismissResponse.status, 200, JSON.stringify(dismissPayload));
    assert.equal(dismissPayload.dismissals.some((item) => item.id === 'member_sqlite_account_alert:private-inventory'), true);

    const clearResponse = await httpFetch(`${baseUrl}/account-alert-dismissals`, {
      method: 'DELETE',
      headers: { cookie }
    });
    const clearPayload = await clearResponse.json();
    assert.equal(clearResponse.status, 200, JSON.stringify(clearPayload));
    assert.equal(clearPayload.cleared, 1);
    assert.equal(clearPayload.dismissals.length, 0);

    const dismissals = await repositoryModule.getSqliteCollection('accountAlertDismissals', { limit: 0 });
    const logs = await repositoryModule.getSqliteCollection('logs', { limit: 0 });
    const afterStatus = await storeModule.storeRuntimeStatus();
    const afterStat = await stat(storeModule.STORE_FILE);
    assert.equal(dismissals.length, 0);
    assert.equal(logs.some((log) => log.type === 'account_alert_dismiss' && log.targetId === 'member_sqlite_account_alert:private-inventory'), true);
    assert.equal(logs.some((log) => log.type === 'account_alert_dismiss_clear' && log.metadata?.cleared === 1), true);
    assert.equal(afterStat.mtimeMs, beforeStat.mtimeMs);
    assert.equal(afterStatus.metrics.writes.total, beforeStatus.metrics.writes.total);
    assert.equal(afterStatus.metrics.sqliteWrites, beforeStatus.metrics.sqliteWrites);
    assert.equal(writeCount(afterStatus, 'account_alert_dismiss'), beforeDismissWrite + 1);
    assert.equal(writeCount(afterStatus, 'account_alert_dismiss_log_trim'), beforeDismissLogTrimWrite);
    assert.equal(writeCount(afterStatus, 'account_alert_dismiss_clear'), beforeClearWrite + 1);
    assert.equal(writeCount(afterStatus, 'account_alert_dismiss_clear_log_trim'), beforeClearLogTrimWrite);
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

test('readSqliteStoreSlice returns complete collections beyond one thousand records', async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'nb-clan-sqlite-slice-'));
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
    const storeModule = await uniqueImport('../server/store.js');
    await storeModule.ensureStore();
    const repositoryModule = await import('../server/storage/repository.js');
    const createdAt = new Date().toISOString();
    const members = Array.from({ length: 1005 }, (_, index) => ({
      id: `member_slice_${String(index).padStart(4, '0')}`,
      steamId: String(76561198000100000n + BigInt(index)),
      rawInput: String(76561198000100000n + BigInt(index)),
      customName: `Slice Member ${index}`,
      steamNickname: `Slice Member ${index}`,
      avatar: '',
      discordId: '',
      wechatId: '',
      wechatUserId: '',
      notes: '',
      specialty: [],
      memberStatus: 'active',
      invitedByUserId: '',
      createdAt,
      updatedAt: createdAt
    }));

    await repositoryModule.writeSqliteStorePatch({
      reason: 'sqlite_store_slice_complete_test',
      upserts: { members }
    });

    const slice = await repositoryModule.readSqliteStoreSlice(['members']);
    const slicedMembers = (slice.members || []).filter((item) => item.id?.startsWith('member_slice_'));
    assert.equal(slicedMembers.length, 1005);
    assert.equal(Boolean(slicedMembers.find((item) => item.id === 'member_slice_1004')), true);
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

test('sqlite-primary retired mini management rejects bearer before collection reads beyond one thousand records', async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'nb-clan-sqlite-wechat-auth-'));
  const previousEnv = {
    NB_DATA_DIR: process.env.NB_DATA_DIR,
    NB_ROOT_PASSWORD: process.env.NB_ROOT_PASSWORD,
    NB_STORAGE_MODE: process.env.NB_STORAGE_MODE,
    NB_SQLITE_FILE: process.env.NB_SQLITE_FILE,
    NB_WECHAT_DEV_LOGIN: process.env.NB_WECHAT_DEV_LOGIN,
    NB_DISABLE_BACKGROUND_JOBS: process.env.NB_DISABLE_BACKGROUND_JOBS,
    NB_DISABLE_EXTERNAL_VITAL: process.env.NB_DISABLE_EXTERNAL_VITAL,
    NB_RUSTPLUS_RELAY_CHAT_FLUSH_INTERVAL_MS: process.env.NB_RUSTPLUS_RELAY_CHAT_FLUSH_INTERVAL_MS
  };
  const originalFetch = globalThis.fetch;
  const httpFetch = originalFetch.bind(globalThis);
  process.env.NB_DATA_DIR = dataDir;
  process.env.NB_ROOT_PASSWORD = 'RootPass123!';
  process.env.NB_STORAGE_MODE = 'sqlite-primary';
  process.env.NB_SQLITE_FILE = path.join(dataDir, 'nb-clan.sqlite');
  process.env.NB_WECHAT_DEV_LOGIN = '1';
  process.env.NB_DISABLE_BACKGROUND_JOBS = '1';
  process.env.NB_DISABLE_EXTERNAL_VITAL = '1';
  process.env.NB_RUSTPLUS_RELAY_CHAT_FLUSH_INTERVAL_MS = '0';

  let server = null;
  try {
    const storeModule = await uniqueImport('../server/store.js');
    const apiModule = await uniqueImport('../server/api.js');
    const authModule = await uniqueImport('../server/auth.js');
    await storeModule.ensureStore();

    const app = express();
    app.use('/api', apiModule.createApiRouter());
    server = createServer(app);
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const baseUrl = `http://127.0.0.1:${server.address().port}/api`;
    const writeCount = (status, name) => status.sqlite?.writes?.byName?.[name]?.total || 0;

    const loginResponse = await httpFetch(`${baseUrl}/wechat/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        code: 'sqlite-suspended-management-admin',
        profile: { nickname: 'Suspended Admin' }
      })
    });
    assert.equal(loginResponse.status, 200);
    const loginPayload = await loginResponse.json();
    const wechatUserId = loginPayload.wechatUser.id;
    const createdAt = new Date().toISOString();
    const fillerMembers = Array.from({ length: 1004 }, (_, index) => ({
      id: `member_wechat_auth_filler_${String(index).padStart(4, '0')}`,
      steamId: String(76561198000200000n + BigInt(index)),
      rawInput: String(76561198000200000n + BigInt(index)),
      customName: `Wechat Auth Filler ${index}`,
      steamNickname: `Wechat Auth Filler ${index}`,
      avatar: '',
      discordId: '',
      wechatId: '',
      wechatUserId: '',
      notes: '',
      specialty: [],
      memberStatus: 'active',
      invitedByUserId: '',
      createdAt,
      updatedAt: createdAt
    }));

    await storeModule.updateStore((store) => {
      store.members.push(...fillerMembers, {
        id: 'member_wechat_auth_suspended_tail',
        steamId: '76561198000209999',
        rawInput: '76561198000209999',
        customName: 'Suspended Tail Admin',
        steamNickname: 'Suspended Tail Admin',
        avatar: '',
        discordId: '',
        wechatId: wechatUserId,
        wechatUserId,
        notes: '',
        specialty: [],
        memberStatus: 'suspended',
        invitedByUserId: '',
        createdAt,
        updatedAt: createdAt
      });
      const wechatUser = store.wechatUsers.find((item) => item.id === wechatUserId);
      wechatUser.status = 'approved';
      wechatUser.role = 'admin';
      wechatUser.memberId = 'member_wechat_auth_suspended_tail';
      wechatUser.updatedAt = createdAt;
    });

    const queryCount = (status, name) => status.sqlite?.queries?.byName?.[name]?.total || 0;
    const beforeAdminStatus = await storeModule.storeRuntimeStatus({ sqliteSummary: false });
    const beforeListUsers = queryCount(beforeAdminStatus, 'list_users');
    const beforeListMembers = queryCount(beforeAdminStatus, 'list_members');
    const beforeListWechatUsers = queryCount(beforeAdminStatus, 'list_wechatUsers');
    const beforeGetWechatUsers = queryCount(beforeAdminStatus, 'get_wechatUsers');
    const beforeGetMembers = queryCount(beforeAdminStatus, 'get_members');
    const adminResponse = await httpFetch(`${baseUrl}/wechat/admin/members`, {
      headers: { authorization: `Bearer ${loginPayload.sessionToken}` }
    });
    assert.equal(adminResponse.status, 410);
    assert.equal((await adminResponse.json()).errorCode, 'MINI_FEATURE_RETIRED');
    const afterAdminStatus = await storeModule.storeRuntimeStatus({ sqliteSummary: false });
    assert.equal(queryCount(afterAdminStatus, 'list_users'), beforeListUsers);
    assert.equal(queryCount(afterAdminStatus, 'list_members'), beforeListMembers);
    assert.equal(queryCount(afterAdminStatus, 'list_wechatUsers'), beforeListWechatUsers);
    assert.equal(queryCount(afterAdminStatus, 'get_wechatUsers'), beforeGetWechatUsers);
    assert.equal(queryCount(afterAdminStatus, 'get_members'), beforeGetMembers);
  } finally {
    if (server) await new Promise((resolve) => server.close(resolve));
    globalThis.fetch = originalFetch;
    const sqliteModule = await import('../server/storage/sqlite.js');
    await sqliteModule.closeSqliteDatabasesForTests();
    Object.assign(process.env, previousEnv);
    for (const [key, value] of Object.entries(previousEnv)) {
      if (value === undefined) delete process.env[key];
    }
    await rm(dataDir, { recursive: true, force: true });
  }
});

test('sqlite-primary member query and profile use scoped reads without loading all members', async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'nb-clan-sqlite-query-member-'));
  const previousEnv = {
    NB_DATA_DIR: process.env.NB_DATA_DIR,
    NB_ROOT_PASSWORD: process.env.NB_ROOT_PASSWORD,
    NB_STORAGE_MODE: process.env.NB_STORAGE_MODE,
	    NB_SQLITE_FILE: process.env.NB_SQLITE_FILE,
	    NB_DISABLE_BACKGROUND_JOBS: process.env.NB_DISABLE_BACKGROUND_JOBS,
	    NB_DISABLE_EXTERNAL_VITAL: process.env.NB_DISABLE_EXTERNAL_VITAL,
	    NB_RUSTPLUS_RELAY_CHAT_FLUSH_INTERVAL_MS: process.env.NB_RUSTPLUS_RELAY_CHAT_FLUSH_INTERVAL_MS,
	    NB_DISCORD_API_BASE_URL: process.env.NB_DISCORD_API_BASE_URL,
	    NB_DISCORD_WIPE_ATTENDANCE_REFRESH_DEBOUNCE_MS: process.env.NB_DISCORD_WIPE_ATTENDANCE_REFRESH_DEBOUNCE_MS,
	    NB_RUST_KDA_PROVIDER: process.env.NB_RUST_KDA_PROVIDER,
	    NB_RUST_KDA_BASE_URL: process.env.NB_RUST_KDA_BASE_URL
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
		  process.env.NB_DISCORD_WIPE_ATTENDANCE_REFRESH_DEBOUNCE_MS = '0';
		  process.env.NB_RUST_KDA_PROVIDER = 'http';
		  process.env.NB_RUST_KDA_BASE_URL = 'https://rust-kda.anlonely.me';

  let server = null;
  let discordServer = null;
  const discordDirectMessages = [];
  const discordMessageEdits = [];
  const discordFollowups = [];
  const failingDiscordUserId = '123456789012349998';
  const failingWriteDiscordUserId = '123456789012349994';
  try {
    const discordApp = express();
    discordApp.use(express.json());
    discordApp.post('/users/@me/channels', (req, res) => {
      res.json({
        id: `dm_${req.body?.recipient_id || 'unknown'}`,
        type: 1,
        recipients: [{ id: req.body?.recipient_id || '' }]
      });
    });
    discordApp.post('/channels/:channelId/messages', (req, res) => {
      if ([failingDiscordUserId, failingWriteDiscordUserId].some((userId) => req.params.channelId === `dm_${userId}`)) {
        res.status(500).json({ message: 'forced sqlite reminder failure' });
        return;
      }
      discordDirectMessages.push({
        channelId: req.params.channelId,
        authorization: req.get('authorization') || '',
        body: req.body
      });
      res.json({
        id: `direct_sqlite_${discordDirectMessages.length}`,
        channel_id: req.params.channelId
      });
    });
    discordApp.patch('/channels/:channelId/messages/:messageId', (req, res) => {
      discordMessageEdits.push({
        channelId: req.params.channelId,
        messageId: req.params.messageId,
        authorization: req.get('authorization') || '',
        body: req.body
      });
      res.json({
        id: req.params.messageId,
        channel_id: req.params.channelId,
        ...req.body
      });
    });
    discordApp.post('/webhooks/:applicationId/:token', (req, res) => {
      discordFollowups.push({
        applicationId: req.params.applicationId,
        token: req.params.token,
        body: req.body
      });
      res.json({ id: `followup_${discordFollowups.length}` });
    });
    discordServer = createServer(discordApp);
    await new Promise((resolve) => discordServer.listen(0, '127.0.0.1', resolve));
    process.env.NB_DISCORD_API_BASE_URL = `http://127.0.0.1:${discordServer.address().port}`;

    const storeModule = await uniqueImport('../server/store.js');
    const apiModule = await uniqueImport('../server/api.js');
    const authAccountModule = await uniqueImport('../server/auth-account-store.js');
    await storeModule.ensureStore();
    const createdAt = '2026-07-02T00:00:00.000Z';
    const targetSteamId = '76561198001999999';
    const leaderSteamId = '76561198001999998';
	    const autoLeaderSteamId = '76561198001999996';
	    const loginEnsureSteamId = '76561198001999995';
	    const discordUserId = '123456789012349999';
	    const noSteamDiscordUserId = '123456789012349997';
	    const discordKeys = crypto.generateKeyPairSync('ed25519');
    const publicKeyDer = discordKeys.publicKey.export({ type: 'spki', format: 'der' });
    const discordPublicKey = Buffer.from(publicKeyDer).subarray(-32).toString('hex');
    const loginEnsurePasswordHash = await storeModule.hashPassword('LoginEnsurePass123!');
    const fillerMembers = Array.from({ length: 1105 }, (_, index) => ({
      id: `member_sqlite_query_filler_${String(index).padStart(4, '0')}`,
      steamId: String(76561198001000000n + BigInt(index)),
      rawInput: String(76561198001000000n + BigInt(index)),
      customName: `SQLite Query Filler ${index}`,
      steamNickname: `SQLite Query Filler ${index}`,
      avatar: `https://example.com/filler-${index}.png`,
      discordId: '',
      wechatId: '',
      wechatUserId: '',
      notes: '',
      specialty: [],
      memberStatus: 'active',
      invitedByUserId: '',
      createdAt,
      updatedAt: createdAt
    }));

    await storeModule.updateStore((store) => {
      store.settings.discord ||= {};
      store.settings.discord.publicKey = discordPublicKey;
      store.settings.discord.botToken = 'sqlite-discord-reminder-token';
      store.settings.discord.guildId = '123456789012349989';
      store.settings.discord.channelId = '123456789012349990';
      store.settings.discord.lastMessageId = '123456789012349991';
      store.settings.discord.lastMessageLanguage = 'zh';
      store.settings.discord.lastMessageCreatedAt = createdAt;
      store.settings.discord.lastMessageCreatedBy = 'SQLite Query Test';
      store.settings.discord.lastMessageMentionEveryone = false;
      store.users.push({
        id: 'user_sqlite_query_leader',
        username: 'sqlite_query_leader',
        role: 'leader',
        boundSteamId: leaderSteamId,
        steamNickname: 'SQLite Query Leader',
        createdAt,
        updatedAt: createdAt
      }, {
        id: 'user_sqlite_query_auto_leader',
        username: 'sqlite_query_auto_leader',
        role: 'leader',
        boundSteamId: autoLeaderSteamId,
        steamNickname: 'SQLite Query Auto Leader',
        createdAt,
        updatedAt: createdAt
      }, {
        id: 'user_sqlite_login_ensure',
        username: 'sqlite_login_ensure',
        passwordHash: loginEnsurePasswordHash,
        role: 'member',
        boundSteamId: loginEnsureSteamId,
        steamNickname: 'SQLite Login Ensure',
        createdAt,
        updatedAt: createdAt
      });
      store.members.push({
        id: 'member_sqlite_query_invalid_vip',
        steamId: '76561198001999992',
        rawInput: '76561198001999992',
        customName: 'SQLite Query Invalid VIP',
        steamNickname: 'SQLite Query Invalid VIP',
        avatar: '',
        discordId: '',
        wechatId: '',
        wechatUserId: '',
        notes: '',
        specialty: [],
        vitalVipType: 'legacy_invalid_vip',
        memberStatus: 'active',
        invitedByUserId: '',
        createdAt,
        updatedAt: createdAt
      }, {
        id: 'member_sqlite_query_empty_vip',
        steamId: '76561198001999991',
        rawInput: '76561198001999991',
        customName: 'SQLite Query Empty VIP',
        steamNickname: 'SQLite Query Empty VIP',
        avatar: '',
        discordId: '',
        wechatId: '',
        wechatUserId: '',
        notes: '',
        specialty: [],
        vitalVipType: '   ',
        memberStatus: 'active',
        invitedByUserId: '',
        createdAt,
        updatedAt: createdAt
      }, {
        id: 'member_sqlite_query_missing_squad_relation',
        steamId: '76561198001999988',
        rawInput: '76561198001999988',
        customName: 'SQLite Query Missing Squad Relation',
        steamNickname: 'SQLite Query Missing Squad Relation',
        avatar: '',
        discordId: '',
        wechatId: '',
        wechatUserId: '',
        notes: '',
        specialty: [],
        memberStatus: 'active',
        invitedByUserId: '',
        createdAt,
        updatedAt: createdAt
      }, {
        id: 'member_sqlite_query_padded_priority_vip',
        steamId: '76561198001999990',
        rawInput: '76561198001999990',
        customName: 'SQLite Query Padded Priority VIP',
        steamNickname: 'SQLite Query Padded Priority VIP',
        avatar: '',
        discordId: '',
        wechatId: '',
        wechatUserId: '',
        notes: '',
        specialty: [],
        vitalVipType: ' Priority ',
        memberStatus: 'active',
        invitedByUserId: '',
        createdAt,
        updatedAt: createdAt
      }, {
        id: 'member_sqlite_query_padded_queue_skip_vip',
        steamId: '76561198001999989',
        rawInput: '76561198001999989',
        customName: 'SQLite Query Padded Queue Skip VIP',
        steamNickname: 'SQLite Query Padded Queue Skip VIP',
        avatar: '',
        discordId: '',
        wechatId: '',
        wechatUserId: '',
        notes: '',
        specialty: [],
        vitalVipType: ' QUEUE_SKIP ',
        memberStatus: 'active',
        invitedByUserId: '',
        createdAt,
        updatedAt: createdAt
      }, ...fillerMembers, {
        id: 'member_sqlite_query_target',
        steamId: targetSteamId,
        rawInput: targetSteamId,
        customName: 'SQLite Query Target',
        steamNickname: 'SQLite Query Target',
        avatar: 'https://example.com/query-target.png',
        discordId: discordUserId,
        wechatId: '',
        wechatUserId: '',
        notes: '',
        specialty: ['PVP'],
        vitalVipType: 'priority',
        vitalVipPurchasedAt: '2026-07-01',
        vitalVipExpiresAt: '2026-07-29',
        vitalVipReminderExpiresAt: '',
        vitalVipReminderSentAt: '',
        vitalVipReminderError: '',
        memberStatus: 'active',
        invitedByUserId: '',
        createdAt,
        updatedAt: createdAt
	      }, {
	        id: 'member_sqlite_query_pvp_string',
	        steamId: '76561198001999994',
	        rawInput: '76561198001999994',
	        customName: 'SQLite Query PVP String',
	        steamNickname: 'SQLite Query PVP String',
	        avatar: '',
	        discordId: '',
	        wechatId: '',
	        wechatUserId: '',
	        notes: '',
	        specialty: 'PVP,building',
	        memberStatus: 'active',
	        invitedByUserId: '',
	        createdAt,
	        updatedAt: createdAt
	      }, {
	        id: 'member_sqlite_query_pvp_trim',
	        steamId: '76561198001999993',
	        rawInput: '76561198001999993',
	        customName: 'SQLite Query PVP Trim',
	        steamNickname: 'SQLite Query PVP Trim',
	        avatar: '',
	        discordId: '',
	        wechatId: '',
	        wechatUserId: '',
	        notes: '',
	        specialty: [' PVP '],
	        memberStatus: 'active',
	        invitedByUserId: '',
	        createdAt,
	        updatedAt: createdAt
	      }, {
	        id: 'member_sqlite_query_no_steam',
	        steamId: '',
	        rawInput: 'ABC',
	        customName: 'SQLite Query No Steam',
	        steamNickname: '',
	        avatar: '',
	        discordId: noSteamDiscordUserId,
	        wechatId: '',
	        wechatUserId: '',
	        notes: '',
	        specialty: ['electricity'],
	        memberStatus: 'active',
	        invitedByUserId: 'user_sqlite_query_leader',
	        createdAt,
	        updatedAt: createdAt
	      }, {
	        id: 'member_sqlite_query_reminder_failure',
	        steamId: '76561198001999997',
        rawInput: '76561198001999997',
        customName: 'SQLite Reminder Failure',
        steamNickname: 'SQLite Reminder Failure',
        avatar: 'https://example.com/query-reminder-failure.png',
        discordId: failingDiscordUserId,
        wechatId: '',
        wechatUserId: '',
        notes: '',
        specialty: ['Builder'],
        vitalVipType: 'priority',
        vitalVipPurchasedAt: '2026-07-01',
        vitalVipExpiresAt: '2026-07-29',
        vitalVipReminderExpiresAt: '',
        vitalVipReminderSentAt: '',
        vitalVipReminderError: '',
        memberStatus: 'active',
        invitedByUserId: '',
        createdAt,
        updatedAt: createdAt
      }, {
        id: 'member_sqlite_query_leader',
        steamId: leaderSteamId,
        rawInput: leaderSteamId,
        customName: 'SQLite Query Leader Member',
        steamNickname: 'SQLite Query Leader Member',
        avatar: 'https://example.com/query-leader.png',
        discordId: '',
        wechatId: '',
        wechatUserId: '',
        notes: '',
        specialty: ['Leader'],
        memberStatus: 'active',
        invitedByUserId: '',
        createdAt,
        updatedAt: createdAt
      });
      store.squads.push({
        id: 'squad_sqlite_query',
        name: 'SQLite Query Squad',
        leaderUserId: 'user_sqlite_query_leader',
        leaderUserIds: ['user_sqlite_query_leader'],
        notes: '',
        createdBy: 'root',
        createdAt,
        updatedAt: createdAt,
        archivedAt: ''
      });
	      store.squadMembers.push({
	        id: 'squad_member_sqlite_query_target',
	        squadId: 'squad_sqlite_query',
	        memberId: 'member_sqlite_query_target',
	        createdAt,
	        updatedAt: createdAt
	      }, {
	        id: 'squad_member_sqlite_query_no_steam',
	        squadId: 'squad_sqlite_query',
	        memberId: 'member_sqlite_query_no_steam',
	        createdAt,
	        updatedAt: createdAt
	      }, {
		        id: 'squad_member_sqlite_query_leader',
		        squadId: 'squad_sqlite_query',
		        memberId: 'member_sqlite_query_leader',
	        createdAt,
	        updatedAt: createdAt
	      }, {
	        id: 'squad_member_sqlite_query_missing_squad_relation',
	        squadId: 'squad_sqlite_query_missing',
	        memberId: 'member_sqlite_query_missing_squad_relation',
	        createdAt,
	        updatedAt: createdAt
	      }, {
	        id: 'squad_member_sqlite_query_orphan',
	        squadId: 'squad_sqlite_query',
	        memberId: 'member_sqlite_query_missing',
	        createdAt,
	        updatedAt: createdAt
	      });
      store.wipes.unshift({
        id: 'wipe_sqlite_query_current',
        name: 'SQLite Query Current',
        serverName: 'SQLite Query Server',
        status: 'active',
        startedAt: createdAt,
        closedAt: '',
        wipeLabel: 'Current',
        wipeMode: 'current',
        vitalServerId: '16',
        vitalWipeId: 'sqlite-query-wipe',
        battlemetricsId: '1234567',
        kdaUrl: 'https://vitalrust.com/statistics?serverId=16&wipeId=sqlite-query-wipe',
        createdAt,
        updatedAt: createdAt
      });
	      store.wipeParticipants.push({
	        id: 'wipe_participant_sqlite_query_target',
	        wipeId: 'wipe_sqlite_query_current',
	        memberId: 'member_sqlite_query_target',
	        squadId: 'squad_sqlite_query',
	        status: 'on_time',
	        source: 'test',
	        createdAt,
	        updatedAt: createdAt
	      }, {
	        id: 'wipe_participant_sqlite_query_no_steam',
	        wipeId: 'wipe_sqlite_query_current',
	        memberId: 'member_sqlite_query_no_steam',
	        squadId: 'squad_sqlite_query',
	        status: 'on_time',
	        source: 'test',
	        createdAt,
	        updatedAt: createdAt
	      });
	      store.memberProfiles.push({
	        id: 'member_profile_sqlite_query_target',
	        memberId: 'member_sqlite_query_target',
        steamId: targetSteamId,
        playTimeMinutes: 2400,
        playTimeKnown: true,
        profilePublic: true,
        inventoryPublic: true,
        inventoryValue: 88,
	        inventoryCurrency: 'USD',
	        fetchedAt: createdAt
	      }, {
	        id: 'member_profile_sqlite_query_no_steam',
	        memberId: 'member_sqlite_query_no_steam',
	        steamId: '',
	        playTimeMinutes: 180,
	        playTimeKnown: true,
	        profilePublic: false,
	        inventoryPublic: false,
	        inventoryValue: null,
	        inventoryCurrency: 'USD',
	        fetchedAt: createdAt
	      });
	      store.kdaRows.push({
	        id: 'kda_sqlite_query_target_current',
        wipeId: 'wipe_sqlite_query_current',
        memberId: 'member_sqlite_query_target',
        steamId: targetSteamId,
        squadId: 'squad_sqlite_query',
        kills: 12,
        deaths: 4,
        assists: 2,
        kda: 3.5,
        kd: 3,
	        source: 'vital',
	        syncedAt: createdAt
	      }, {
	        id: 'kda_sqlite_query_no_steam_current',
	        wipeId: 'wipe_sqlite_query_current',
	        memberId: 'member_sqlite_query_no_steam',
	        steamId: '',
	        squadId: 'squad_sqlite_query',
	        kills: 7,
	        deaths: 2,
	        assists: 1,
	        kda: 4,
	        kd: 3.5,
	        source: 'manual',
	        syncedAt: createdAt
	      });
	      store.discordMemberApplications.push({
	        id: 'discord_application_sqlite_query_no_steam',
	        discordUserId: noSteamDiscordUserId,
	        discordUsername: 'NoSteamDiscord',
	        displayName: 'No Steam Discord',
	        memberId: 'member_sqlite_query_no_steam',
	        steamId: '',
	        status: 'approved',
	        reviewedByUserId: 'discord:admin',
	        reviewedByName: 'Discord Admin',
	        createdAt,
	        updatedAt: createdAt
	      });
	    });

    const app = express();
    app.use('/api', apiModule.createApiRouter());
	    server = createServer(app);
	    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
	    const baseUrl = `http://127.0.0.1:${server.address().port}/api`;
	    const repositoryModule = await import('../server/storage/repository.js');
	    const queryCount = (status, name) => status.sqlite?.queries?.byName?.[name]?.total || 0;
	    const writeCount = (status, name) => status.sqlite?.writes?.byName?.[name]?.total || 0;
	    const storeWriteCount = (status, name) => status.metrics?.writes?.byName?.[name]?.total || 0;
	    const postDiscordInteraction = (body) => {
      const rawBody = JSON.stringify(body);
      const timestamp = String(Math.floor(Date.now() / 1000));
      const signature = crypto
        .sign(null, Buffer.concat([Buffer.from(timestamp), Buffer.from(rawBody)]), discordKeys.privateKey)
        .toString('hex');
      return httpFetch(`${baseUrl}/integrations/discord/interactions`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-signature-ed25519': signature,
          'x-signature-timestamp': timestamp
        },
        body: rawBody
      });
    };

    const beforeAuthLoginStatus = await storeModule.storeRuntimeStatus({ sqliteSummary: false });
    const beforeAuthLoginReads = {
      users: queryCount(beforeAuthLoginStatus, 'list_users'),
      usersUsernameNoCase: queryCount(beforeAuthLoginStatus, 'list_users_username_nocase'),
      permissionRoles: queryCount(beforeAuthLoginStatus, 'list_permissionRoles'),
      members: queryCount(beforeAuthLoginStatus, 'list_members'),
      squads: queryCount(beforeAuthLoginStatus, 'list_squads'),
      squadMembers: queryCount(beforeAuthLoginStatus, 'list_squadMembers'),
      wipes: queryCount(beforeAuthLoginStatus, 'list_wipes')
    };
    const loginResponse = await httpFetch(`${baseUrl}/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'root', password: 'RootPass123!' })
    });
    assert.equal(loginResponse.status, 200);
    const cookie = loginResponse.headers.get('set-cookie')?.split(';')[0] || '';
    assert.match(cookie, /^nb_session=/);
    const afterAuthLoginStatus = await storeModule.storeRuntimeStatus({ sqliteSummary: false });
    assert.equal(queryCount(afterAuthLoginStatus, 'list_users'), beforeAuthLoginReads.users);
    assert.equal(queryCount(afterAuthLoginStatus, 'list_users_username_nocase'), beforeAuthLoginReads.usersUsernameNoCase + 1);
    assert.equal(queryCount(afterAuthLoginStatus, 'list_permissionRoles'), beforeAuthLoginReads.permissionRoles + 1);
    assert.equal(queryCount(afterAuthLoginStatus, 'list_members'), beforeAuthLoginReads.members);
    assert.equal(queryCount(afterAuthLoginStatus, 'list_squads'), beforeAuthLoginReads.squads);
    assert.equal(queryCount(afterAuthLoginStatus, 'list_squadMembers'), beforeAuthLoginReads.squadMembers);
    assert.equal(queryCount(afterAuthLoginStatus, 'list_wipes'), beforeAuthLoginReads.wipes);

    const beforeEmptyLoginStatus = await storeModule.storeRuntimeStatus({ sqliteSummary: false });
    const emptyLoginStore = await authAccountModule.readAuthLoginRuntimeStore('');
    assert.deepEqual(emptyLoginStore.users, []);
    assert.deepEqual(emptyLoginStore.permissionRoles, []);
    const afterEmptyLoginStatus = await storeModule.storeRuntimeStatus({ sqliteSummary: false });
    assert.equal(queryCount(afterEmptyLoginStatus, 'list_users'), queryCount(beforeEmptyLoginStatus, 'list_users'));
    assert.equal(
      queryCount(afterEmptyLoginStatus, 'list_users_username_nocase'),
      queryCount(beforeEmptyLoginStatus, 'list_users_username_nocase')
    );
    assert.equal(queryCount(afterEmptyLoginStatus, 'list_permissionRoles'), queryCount(beforeEmptyLoginStatus, 'list_permissionRoles'));
    assert.equal(queryCount(afterEmptyLoginStatus, 'list_members'), queryCount(beforeEmptyLoginStatus, 'list_members'));
    assert.equal(queryCount(afterEmptyLoginStatus, 'list_squads'), queryCount(beforeEmptyLoginStatus, 'list_squads'));
    assert.equal(queryCount(afterEmptyLoginStatus, 'list_squadMembers'), queryCount(beforeEmptyLoginStatus, 'list_squadMembers'));

    const warmMemberOptionsResponse = await httpFetch(`${baseUrl}/member-options`, {
      headers: { cookie }
    });
    assert.equal(warmMemberOptionsResponse.status, 200);

    const beforeMemberOptionsStatus = await storeModule.storeRuntimeStatus({ sqliteSummary: false });
    const beforeMemberOptionsReads = {
      wipes: queryCount(beforeMemberOptionsStatus, 'list_wipes'),
      wipesStatus: queryCount(beforeMemberOptionsStatus, 'list_wipes_status'),
      wipeParticipants: queryCount(beforeMemberOptionsStatus, 'list_wipeParticipants'),
      wipeParticipantsWipeId: queryCount(beforeMemberOptionsStatus, 'list_wipeParticipants_wipeId')
    };
    const memberOptionsResponse = await httpFetch(`${baseUrl}/member-options`, {
      headers: { cookie }
    });
    assert.equal(memberOptionsResponse.status, 200);
	    const memberOptionsPayload = await memberOptionsResponse.json();
	    const querySquadOption = memberOptionsPayload.squads.find((squad) => squad.id === 'squad_sqlite_query');
	    assert.equal(querySquadOption.participantCount, 2);
    const afterMemberOptionsStatus = await storeModule.storeRuntimeStatus({ sqliteSummary: false });
    assert.equal(queryCount(afterMemberOptionsStatus, 'list_wipes'), beforeMemberOptionsReads.wipes);
    assert.equal(queryCount(afterMemberOptionsStatus, 'list_wipes_status'), beforeMemberOptionsReads.wipesStatus + 1);
    assert.equal(queryCount(afterMemberOptionsStatus, 'list_wipeParticipants'), beforeMemberOptionsReads.wipeParticipants);
    assert.equal(queryCount(afterMemberOptionsStatus, 'list_wipeParticipants_wipeId'), beforeMemberOptionsReads.wipeParticipantsWipeId + 1);

    const warmWipeListResponse = await httpFetch(`${baseUrl}/wipes`, {
      headers: { cookie }
    });
    assert.equal(warmWipeListResponse.status, 200);

    const beforeWipeListStatus = await storeModule.storeRuntimeStatus({ sqliteSummary: false });
    const beforeWipeListReads = {
      wipes: queryCount(beforeWipeListStatus, 'list_wipes'),
      wipeParticipants: queryCount(beforeWipeListStatus, 'list_wipeParticipants'),
      permissionRoles: queryCount(beforeWipeListStatus, 'list_permissionRoles')
    };
    const wipeListResponse = await httpFetch(`${baseUrl}/wipes`, {
      headers: { cookie }
    });
    assert.equal(wipeListResponse.status, 200);
    const wipeListPayload = await wipeListResponse.json();
    assert.equal(wipeListPayload.ok, true);
    assert.equal(wipeListPayload.wipes.some((wipe) => wipe.id === 'wipe_sqlite_query_current'), true);
    const afterWipeListStatus = await storeModule.storeRuntimeStatus({ sqliteSummary: false });
    assert.equal(queryCount(afterWipeListStatus, 'list_wipes') > beforeWipeListReads.wipes, true);
    assert.equal(queryCount(afterWipeListStatus, 'list_wipeParticipants') > beforeWipeListReads.wipeParticipants, true);
    assert.equal(queryCount(afterWipeListStatus, 'list_permissionRoles'), beforeWipeListReads.permissionRoles);

    const beforePasswordStatus = await storeModule.storeRuntimeStatus({ sqliteSummary: false });
    const beforePasswordStat = await stat(storeModule.STORE_FILE);
    const beforePasswordChangeWrite = writeCount(beforePasswordStatus, 'password_change');
    const beforePasswordChangeLogTrimWrite = writeCount(beforePasswordStatus, 'password_change_log_trim');
    const beforePasswordReads = {
      users: queryCount(beforePasswordStatus, 'list_users'),
      members: queryCount(beforePasswordStatus, 'list_members')
    };
    const passwordResponse = await httpFetch(`${baseUrl}/profile/password`, {
      method: 'POST',
      headers: {
        cookie,
        'content-type': 'application/json'
      },
      body: JSON.stringify({
        currentPassword: 'RootPass123!',
        newPassword: 'RootPass456!'
      })
    });
    assert.equal(passwordResponse.status, 200);
    const afterPasswordStatus = await storeModule.storeRuntimeStatus({ sqliteSummary: false });
    const afterPasswordStat = await stat(storeModule.STORE_FILE);
    assert.equal(afterPasswordStat.mtimeMs, beforePasswordStat.mtimeMs);
    assert.equal(afterPasswordStatus.metrics.writes.total, beforePasswordStatus.metrics.writes.total);
    assert.equal(afterPasswordStatus.metrics.sqliteWrites, beforePasswordStatus.metrics.sqliteWrites);
    assert.equal(queryCount(afterPasswordStatus, 'list_users'), beforePasswordReads.users);
    assert.equal(queryCount(afterPasswordStatus, 'list_members'), beforePasswordReads.members);
    assert.equal(writeCount(afterPasswordStatus, 'password_change'), beforePasswordChangeWrite + 1);
    assert.equal(writeCount(afterPasswordStatus, 'password_change_log_trim'), beforePasswordChangeLogTrimWrite);

	    const beforeRankingPreviewStatus = await storeModule.storeRuntimeStatus({ sqliteSummary: false });
	    const beforeRankingPreviewFullReads = {
	      users: queryCount(beforeRankingPreviewStatus, 'list_users'),
	      members: queryCount(beforeRankingPreviewStatus, 'list_members'),
	      squads: queryCount(beforeRankingPreviewStatus, 'list_squads'),
	      squadMembers: queryCount(beforeRankingPreviewStatus, 'list_squadMembers'),
	      memberProfiles: queryCount(beforeRankingPreviewStatus, 'list_memberProfiles'),
	      wechatUsers: queryCount(beforeRankingPreviewStatus, 'list_wechatUsers'),
	      uploads: queryCount(beforeRankingPreviewStatus, 'list_uploads'),
	      discordMemberApplications: queryCount(beforeRankingPreviewStatus, 'list_discordMemberApplications')
	    };
	    const beforeRankingPreviewScopedReads = {
		      membersById: queryCount(beforeRankingPreviewStatus, 'list_members_id'),
	      membersBySteamId: queryCount(beforeRankingPreviewStatus, 'list_members_steamId'),
		      squadsById: queryCount(beforeRankingPreviewStatus, 'list_squads_id'),
	      squadMembersByMemberId: queryCount(beforeRankingPreviewStatus, 'list_squadMembers_memberId'),
	      memberProfilesByMemberId: queryCount(beforeRankingPreviewStatus, 'list_memberProfiles_memberId'),
	      memberProfilesBySteamId: queryCount(beforeRankingPreviewStatus, 'list_memberProfiles_steamId'),
	      discordMemberApplicationsByUserId: queryCount(beforeRankingPreviewStatus, 'list_discordMemberApplications_discordUserId')
	    };
    const rankingPreviewResponse = await httpFetch(`${baseUrl}/settings/discord/member-ranking-card/preview`, {
      method: 'POST',
      headers: {
        cookie,
        'content-type': 'application/json'
      },
      body: JSON.stringify({ language: 'en' })
    });
	    assert.equal(rankingPreviewResponse.status, 200);
	    const rankingPreviewPayload = await rankingPreviewResponse.json();
	    assert.match(rankingPreviewPayload.preview.embeds[0].title, /Current server member ranking/);
	    const afterRankingPreviewStatus = await storeModule.storeRuntimeStatus({ sqliteSummary: false });
	    assert.equal(queryCount(afterRankingPreviewStatus, 'list_users'), beforeRankingPreviewFullReads.users);
	    assert.equal(queryCount(afterRankingPreviewStatus, 'list_members'), beforeRankingPreviewFullReads.members);
	    assert.equal(queryCount(afterRankingPreviewStatus, 'list_squads'), beforeRankingPreviewFullReads.squads);
	    assert.equal(queryCount(afterRankingPreviewStatus, 'list_squadMembers'), beforeRankingPreviewFullReads.squadMembers);
	    assert.equal(queryCount(afterRankingPreviewStatus, 'list_memberProfiles'), beforeRankingPreviewFullReads.memberProfiles);
	    assert.equal(queryCount(afterRankingPreviewStatus, 'list_wechatUsers'), beforeRankingPreviewFullReads.wechatUsers);
	    assert.equal(queryCount(afterRankingPreviewStatus, 'list_uploads'), beforeRankingPreviewFullReads.uploads);
	    assert.equal(queryCount(afterRankingPreviewStatus, 'list_discordMemberApplications'), beforeRankingPreviewFullReads.discordMemberApplications);
		    assert.equal(queryCount(afterRankingPreviewStatus, 'list_members_id') > beforeRankingPreviewScopedReads.membersById, true);
		    assert.equal(queryCount(afterRankingPreviewStatus, 'list_members_steamId') > beforeRankingPreviewScopedReads.membersBySteamId, true);
		    assert.equal(queryCount(afterRankingPreviewStatus, 'list_squads_id') > beforeRankingPreviewScopedReads.squadsById, true);
	    assert.equal(queryCount(afterRankingPreviewStatus, 'list_squadMembers_memberId') > beforeRankingPreviewScopedReads.squadMembersByMemberId, true);
	    assert.equal(queryCount(afterRankingPreviewStatus, 'list_memberProfiles_memberId') > beforeRankingPreviewScopedReads.memberProfilesByMemberId, true);
	    assert.equal(queryCount(afterRankingPreviewStatus, 'list_memberProfiles_steamId') > beforeRankingPreviewScopedReads.memberProfilesBySteamId, true);
	    assert.equal(
	      queryCount(afterRankingPreviewStatus, 'list_discordMemberApplications_discordUserId') >
	        beforeRankingPreviewScopedReads.discordMemberApplicationsByUserId,
	      true
	    );

	    const beforeMemberEnsureStatus = await storeModule.storeRuntimeStatus();
	    const beforeMemberEnsureStat = await stat(storeModule.STORE_FILE);
	    const beforeMemberEnsureReads = {
	      users: queryCount(beforeMemberEnsureStatus, 'list_users'),
	      members: queryCount(beforeMemberEnsureStatus, 'list_members'),
	      squads: queryCount(beforeMemberEnsureStatus, 'list_squads'),
	      squadMembers: queryCount(beforeMemberEnsureStatus, 'list_squadMembers'),
	      wipes: queryCount(beforeMemberEnsureStatus, 'list_wipes'),
	      wipesStatus: queryCount(beforeMemberEnsureStatus, 'list_wipes_status'),
	      permissionRoles: queryCount(beforeMemberEnsureStatus, 'list_permissionRoles'),
	      usersByRole: queryCount(beforeMemberEnsureStatus, 'list_users_role'),
	      usersById: queryCount(beforeMemberEnsureStatus, 'list_users_id'),
	      squadsByLeaderUserId: queryCount(beforeMemberEnsureStatus, 'list_squads_leaderUserId_present'),
	      squadsByLeaderUserIds: queryCount(beforeMemberEnsureStatus, 'list_squads_leaderUserIds_present'),
	      membersBySteamId: queryCount(beforeMemberEnsureStatus, 'list_members_steamId'),
	      squadMembersByMemberId: queryCount(beforeMemberEnsureStatus, 'list_squadMembers_memberId')
	    };
	    const memberEnsureResponse = await httpFetch(`${baseUrl}/members?limit=1`, {
	      headers: { cookie }
	    });
    assert.equal(memberEnsureResponse.status, 200);
    const memberEnsurePayload = await memberEnsureResponse.json();
    assert.equal(memberEnsurePayload.ok, true);
    const autoLeaderMembers = await repositoryModule.getSqliteRecordsByJsonField('members', 'steamId', [autoLeaderSteamId], { limit: 0 });
    const afterMemberEnsureStatus = await storeModule.storeRuntimeStatus();
    const afterMemberEnsureStat = await stat(storeModule.STORE_FILE);
    assert.equal(autoLeaderMembers.length, 1);
    assert.equal(autoLeaderMembers[0].invitedByUserId, 'user_sqlite_query_auto_leader');
	    assert.equal(afterMemberEnsureStat.mtimeMs, beforeMemberEnsureStat.mtimeMs);
	    assert.equal(afterMemberEnsureStatus.metrics.writes.total, beforeMemberEnsureStatus.metrics.writes.total);
		    assert.equal(afterMemberEnsureStatus.metrics.sqliteWrites, beforeMemberEnsureStatus.metrics.sqliteWrites);
		    assert.equal(queryCount(afterMemberEnsureStatus, 'list_users'), beforeMemberEnsureReads.users);
		    assert.equal(queryCount(afterMemberEnsureStatus, 'list_members'), beforeMemberEnsureReads.members + 1);
		    assert.equal(queryCount(afterMemberEnsureStatus, 'list_squads'), beforeMemberEnsureReads.squads);
		    assert.equal(queryCount(afterMemberEnsureStatus, 'list_squadMembers'), beforeMemberEnsureReads.squadMembers);
		    assert.equal(queryCount(afterMemberEnsureStatus, 'list_wipes'), beforeMemberEnsureReads.wipes);
		    assert.equal(queryCount(afterMemberEnsureStatus, 'list_wipes_status') > beforeMemberEnsureReads.wipesStatus, true);
		    assert.equal(queryCount(afterMemberEnsureStatus, 'list_permissionRoles'), beforeMemberEnsureReads.permissionRoles);
		    assert.equal(queryCount(afterMemberEnsureStatus, 'list_users_role') > beforeMemberEnsureReads.usersByRole, true);
		    assert.equal(queryCount(afterMemberEnsureStatus, 'list_users_id') > beforeMemberEnsureReads.usersById, true);
		    assert.equal(queryCount(afterMemberEnsureStatus, 'list_squads_leaderUserId_present') > beforeMemberEnsureReads.squadsByLeaderUserId, true);
		    assert.equal(queryCount(afterMemberEnsureStatus, 'list_squads_leaderUserIds_present') > beforeMemberEnsureReads.squadsByLeaderUserIds, true);
		    assert.equal(queryCount(afterMemberEnsureStatus, 'list_members_steamId') > beforeMemberEnsureReads.membersBySteamId, true);
	    assert.equal(
	      queryCount(afterMemberEnsureStatus, 'list_squadMembers_memberId') >
	        beforeMemberEnsureReads.squadMembersByMemberId,
	      true
	    );

	    const beforeStableMemberListStatus = afterMemberEnsureStatus;
	    const beforeStableMemberListFullReads = {
	      users: queryCount(beforeStableMemberListStatus, 'list_users'),
	      members: queryCount(beforeStableMemberListStatus, 'list_members'),
	      squads: queryCount(beforeStableMemberListStatus, 'list_squads'),
	      squadMembers: queryCount(beforeStableMemberListStatus, 'list_squadMembers'),
	      wipes: queryCount(beforeStableMemberListStatus, 'list_wipes'),
	      permissionRoles: queryCount(beforeStableMemberListStatus, 'list_permissionRoles')
	    };
	    const beforeStableMemberListScopedReads = {
		      usersByRole: queryCount(beforeStableMemberListStatus, 'list_users_role'),
		      usersById: queryCount(beforeStableMemberListStatus, 'list_users_id'),
		      squadsByLeaderUserId: queryCount(beforeStableMemberListStatus, 'list_squads_leaderUserId_present'),
		      squadsByLeaderUserIds: queryCount(beforeStableMemberListStatus, 'list_squads_leaderUserIds_present'),
		      membersBySteamId: queryCount(beforeStableMemberListStatus, 'list_members_steamId'),
	      squadMembersByMemberId: queryCount(beforeStableMemberListStatus, 'list_squadMembers_memberId'),
	      wipesStatus: queryCount(beforeStableMemberListStatus, 'list_wipes_status'),
	      memberProfilesByMemberId: queryCount(beforeStableMemberListStatus, 'list_memberProfiles_memberId'),
	      kdaRowsByMemberId: queryCount(beforeStableMemberListStatus, 'list_kdaRows_memberId'),
	      wipeParticipantsByMemberId: queryCount(beforeStableMemberListStatus, 'list_wipeParticipants_memberId')
	    };
	    const stableMemberListResponse = await httpFetch(`${baseUrl}/members?limit=1`, {
	      headers: { cookie }
	    });
	    assert.equal(stableMemberListResponse.status, 200);
	    const stableMemberListPayload = await stableMemberListResponse.json();
	    assert.equal(stableMemberListPayload.ok, true);
		    const afterStableMemberListStatus = await storeModule.storeRuntimeStatus();
		    assert.equal(queryCount(afterStableMemberListStatus, 'list_users'), beforeStableMemberListFullReads.users);
		    assert.equal(queryCount(afterStableMemberListStatus, 'list_members'), beforeStableMemberListFullReads.members + 1);
		    assert.equal(queryCount(afterStableMemberListStatus, 'list_squads'), beforeStableMemberListFullReads.squads);
		    assert.equal(queryCount(afterStableMemberListStatus, 'list_squadMembers'), beforeStableMemberListFullReads.squadMembers);
		    assert.equal(queryCount(afterStableMemberListStatus, 'list_wipes'), beforeStableMemberListFullReads.wipes);
		    assert.equal(queryCount(afterStableMemberListStatus, 'list_permissionRoles'), beforeStableMemberListFullReads.permissionRoles);
		    assert.equal(queryCount(afterStableMemberListStatus, 'list_users_role') > beforeStableMemberListScopedReads.usersByRole, true);
		    assert.equal(queryCount(afterStableMemberListStatus, 'list_users_id') > beforeStableMemberListScopedReads.usersById, true);
		    assert.equal(queryCount(afterStableMemberListStatus, 'list_squads_leaderUserId_present') > beforeStableMemberListScopedReads.squadsByLeaderUserId, true);
		    assert.equal(queryCount(afterStableMemberListStatus, 'list_squads_leaderUserIds_present') > beforeStableMemberListScopedReads.squadsByLeaderUserIds, true);
		    assert.equal(queryCount(afterStableMemberListStatus, 'list_members_steamId') > beforeStableMemberListScopedReads.membersBySteamId, true);
	    assert.equal(queryCount(afterStableMemberListStatus, 'list_squadMembers_memberId') > beforeStableMemberListScopedReads.squadMembersByMemberId, true);
	    assert.equal(queryCount(afterStableMemberListStatus, 'list_wipes_status') > beforeStableMemberListScopedReads.wipesStatus, true);
	    assert.equal(queryCount(afterStableMemberListStatus, 'list_memberProfiles_memberId') > beforeStableMemberListScopedReads.memberProfilesByMemberId, true);
	    assert.equal(queryCount(afterStableMemberListStatus, 'list_kdaRows_memberId') > beforeStableMemberListScopedReads.kdaRowsByMemberId, true);
	    assert.equal(queryCount(afterStableMemberListStatus, 'list_wipeParticipants_memberId') > beforeStableMemberListScopedReads.wipeParticipantsByMemberId, true);
	    assert.equal(
	      queryCount(afterMemberEnsureStatus, 'list_members') - beforeMemberEnsureReads.members,
	      queryCount(afterStableMemberListStatus, 'list_members') - beforeStableMemberListFullReads.members
	    );
	    assert.equal(
	      queryCount(afterMemberEnsureStatus, 'list_users') - beforeMemberEnsureReads.users,
	      queryCount(afterStableMemberListStatus, 'list_users') - beforeStableMemberListFullReads.users
	    );

	    const beforeSearchMemberListStatus = afterStableMemberListStatus;
	    const beforeSearchMemberListFullReads = {
	      members: queryCount(beforeSearchMemberListStatus, 'list_members'),
	      squads: queryCount(beforeSearchMemberListStatus, 'list_squads'),
	      squadMembers: queryCount(beforeSearchMemberListStatus, 'list_squadMembers')
	    };
	    const beforeSearchMemberListScopedReads = {
	      membersBySearch: queryCount(beforeSearchMemberListStatus, 'list_members_search'),
	      memberCountBySearch: queryCount(beforeSearchMemberListStatus, 'count_members_search'),
	      squadsById: queryCount(beforeSearchMemberListStatus, 'list_squads_id'),
	      squadMembersByMemberId: queryCount(beforeSearchMemberListStatus, 'list_squadMembers_memberId'),
	      memberProfilesByMemberId: queryCount(beforeSearchMemberListStatus, 'list_memberProfiles_memberId'),
	      kdaRowsByMemberId: queryCount(beforeSearchMemberListStatus, 'list_kdaRows_memberId'),
	      wipeParticipantsByMemberId: queryCount(beforeSearchMemberListStatus, 'list_wipeParticipants_memberId')
	    };
	    const searchMemberListResponse = await httpFetch(`${baseUrl}/members?q=Target&limit=1`, {
	      headers: { cookie }
	    });
	    assert.equal(searchMemberListResponse.status, 200);
	    const searchMemberListPayload = await searchMemberListResponse.json();
	    assert.equal(searchMemberListPayload.ok, true);
	    assert.equal(searchMemberListPayload.total, 1);
	    assert.equal(searchMemberListPayload.members.length, 1);
	    assert.equal(searchMemberListPayload.members[0].id, 'member_sqlite_query_target');
	    assert.equal(searchMemberListPayload.members[0].squadId, 'squad_sqlite_query');
	    const squadNameSearchResponse = await httpFetch(`${baseUrl}/members?q=SQLite%20Query%20Squad&limit=10`, {
	      headers: { cookie }
	    });
	    assert.equal(squadNameSearchResponse.status, 200);
	    const squadNameSearchPayload = await squadNameSearchResponse.json();
	    assert.equal(squadNameSearchPayload.ok, true);
	    assert.equal(squadNameSearchPayload.total, 3);
	    assert.deepEqual(
	      squadNameSearchPayload.members.map((member) => member.id),
	      ['member_sqlite_query_target', 'member_sqlite_query_no_steam', 'member_sqlite_query_leader']
	    );
	    const afterSearchMemberListStatus = await storeModule.storeRuntimeStatus({ sqliteSummary: false });
	    assert.equal(queryCount(afterSearchMemberListStatus, 'list_members'), beforeSearchMemberListFullReads.members);
	    assert.equal(queryCount(afterSearchMemberListStatus, 'list_squads'), beforeSearchMemberListFullReads.squads);
	    assert.equal(queryCount(afterSearchMemberListStatus, 'list_squadMembers'), beforeSearchMemberListFullReads.squadMembers);
	    assert.equal(queryCount(afterSearchMemberListStatus, 'list_members_search') > beforeSearchMemberListScopedReads.membersBySearch, true);
	    assert.equal(queryCount(afterSearchMemberListStatus, 'count_members_search') > beforeSearchMemberListScopedReads.memberCountBySearch, true);
	    assert.equal(queryCount(afterSearchMemberListStatus, 'list_squads_id') > beforeSearchMemberListScopedReads.squadsById, true);
	    assert.equal(
	      queryCount(afterSearchMemberListStatus, 'list_squadMembers_memberId') >
	        beforeSearchMemberListScopedReads.squadMembersByMemberId,
	      true
	    );
	    assert.equal(
	      queryCount(afterSearchMemberListStatus, 'list_memberProfiles_memberId') >
	        beforeSearchMemberListScopedReads.memberProfilesByMemberId,
	      true
	    );
	    assert.equal(queryCount(afterSearchMemberListStatus, 'list_kdaRows_memberId') > beforeSearchMemberListScopedReads.kdaRowsByMemberId, true);
	    assert.equal(
	      queryCount(afterSearchMemberListStatus, 'list_wipeParticipants_memberId') >
	        beforeSearchMemberListScopedReads.wipeParticipantsByMemberId,
	      true
	    );
	    const beforeComplexSearchFilterStatus = await storeModule.storeRuntimeStatus({ sqliteSummary: false });
	    const beforeComplexSearchReads = queryCount(beforeComplexSearchFilterStatus, 'list_members_search');
	    const complexSearchFilterResponse = await httpFetch(`${baseUrl}/members?q=Target&specialty=pvp&limit=1`, {
	      headers: { cookie }
	    });
	    assert.equal(complexSearchFilterResponse.status, 200);
	    const complexSearchFilterPayload = await complexSearchFilterResponse.json();
	    assert.equal(complexSearchFilterPayload.ok, true);
	    assert.equal(complexSearchFilterPayload.total, 1);
	    assert.equal(complexSearchFilterPayload.members[0].id, 'member_sqlite_query_target');
	    const afterComplexSearchFilterStatus = await storeModule.storeRuntimeStatus({ sqliteSummary: false });
	    assert.equal(queryCount(afterComplexSearchFilterStatus, 'list_members_search'), beforeComplexSearchReads);

	    const beforeVipFilteredMemberListStatus = afterComplexSearchFilterStatus;
	    const beforeVipFilteredMemberListFullReads = {
	      members: queryCount(beforeVipFilteredMemberListStatus, 'list_members'),
	      squadMembers: queryCount(beforeVipFilteredMemberListStatus, 'list_squadMembers')
	    };
	    const beforeVipFilteredMemberListScopedReads = {
	      membersByVipType: queryCount(beforeVipFilteredMemberListStatus, 'list_members_vitalVipType_normalized'),
	      memberCountByVipType: queryCount(beforeVipFilteredMemberListStatus, 'count_members_vitalVipType_normalized'),
	      squadsById: queryCount(beforeVipFilteredMemberListStatus, 'list_squads_id'),
	      squadMembersByMemberId: queryCount(beforeVipFilteredMemberListStatus, 'list_squadMembers_memberId'),
	      memberProfilesByMemberId: queryCount(beforeVipFilteredMemberListStatus, 'list_memberProfiles_memberId'),
	      kdaRowsByMemberId: queryCount(beforeVipFilteredMemberListStatus, 'list_kdaRows_memberId'),
	      wipeParticipantsByMemberId: queryCount(beforeVipFilteredMemberListStatus, 'list_wipeParticipants_memberId')
	    };
	    const vipFilteredMemberListResponse = await httpFetch(`${baseUrl}/members?vitalVipType=priority&limit=10`, {
	      headers: { cookie }
	    });
	    assert.equal(vipFilteredMemberListResponse.status, 200);
	    const vipFilteredMemberListPayload = await vipFilteredMemberListResponse.json();
	    assert.equal(vipFilteredMemberListPayload.ok, true);
	    assert.equal(vipFilteredMemberListPayload.total, 3);
	    assert.deepEqual(
	      vipFilteredMemberListPayload.members.map((member) => member.id),
	      [
	        'member_sqlite_query_padded_priority_vip',
	        'member_sqlite_query_target',
	        'member_sqlite_query_reminder_failure'
	      ]
	    );
	    const vipFilteredTargetMember = vipFilteredMemberListPayload.members.find((member) => member.id === 'member_sqlite_query_target');
	    assert.equal(vipFilteredTargetMember.squadId, 'squad_sqlite_query');
	    assert.equal(vipFilteredTargetMember.squadName, 'SQLite Query Squad');
	    const afterVipFilteredMemberListStatus = await storeModule.storeRuntimeStatus();
	    assert.equal(queryCount(afterVipFilteredMemberListStatus, 'list_members'), beforeVipFilteredMemberListFullReads.members);
	    assert.equal(queryCount(afterVipFilteredMemberListStatus, 'list_squadMembers'), beforeVipFilteredMemberListFullReads.squadMembers);
	    assert.equal(
	      queryCount(afterVipFilteredMemberListStatus, 'list_members_vitalVipType_normalized') >
	        beforeVipFilteredMemberListScopedReads.membersByVipType,
	      true
	    );
	    assert.equal(
	      queryCount(afterVipFilteredMemberListStatus, 'count_members_vitalVipType_normalized') >
	        beforeVipFilteredMemberListScopedReads.memberCountByVipType,
	      true
	    );
	    assert.equal(queryCount(afterVipFilteredMemberListStatus, 'list_squads_id') > beforeVipFilteredMemberListScopedReads.squadsById, true);
	    assert.equal(
	      queryCount(afterVipFilteredMemberListStatus, 'list_squadMembers_memberId') >
	        beforeVipFilteredMemberListScopedReads.squadMembersByMemberId,
	      true
	    );
	    assert.equal(
	      queryCount(afterVipFilteredMemberListStatus, 'list_memberProfiles_memberId') >
	        beforeVipFilteredMemberListScopedReads.memberProfilesByMemberId,
	      true
	    );
	    assert.equal(queryCount(afterVipFilteredMemberListStatus, 'list_kdaRows_memberId') > beforeVipFilteredMemberListScopedReads.kdaRowsByMemberId, true);
	    assert.equal(
	      queryCount(afterVipFilteredMemberListStatus, 'list_wipeParticipants_memberId') >
	        beforeVipFilteredMemberListScopedReads.wipeParticipantsByMemberId,
	      true
	    );

	    const normalizeTestVitalVipType = (value) => {
	      const raw = String(value || '').trim().toLowerCase();
	      if (raw === 'queue' || raw === 'skip' || raw === 'no_queue' || raw === 'queue-skip') return 'queue_skip';
	      if (raw === 'vip' || raw === 'priority_queue') return 'priority';
	      return ['none', 'priority', 'queue_skip'].includes(raw) ? raw : 'none';
	    };
	    const expectedVipNoneMemberIds = (await repositoryModule.getSqliteCollection('members', { limit: 0 }))
	      .filter((member) => normalizeTestVitalVipType(member.vitalVipType) === 'none')
	      .map((member) => member.id);
	    const beforeVipNoneFilteredMemberListStatus = await storeModule.storeRuntimeStatus();
	    const beforeVipNoneFilteredMemberListFullReads = {
	      members: queryCount(beforeVipNoneFilteredMemberListStatus, 'list_members'),
	      squadMembers: queryCount(beforeVipNoneFilteredMemberListStatus, 'list_squadMembers')
	    };
	    const beforeVipNoneFilteredMemberListScopedReads = {
	      membersByVipType: queryCount(beforeVipNoneFilteredMemberListStatus, 'list_members_vitalVipType_normalized'),
	      squadMembersByMemberId: queryCount(beforeVipNoneFilteredMemberListStatus, 'list_squadMembers_memberId'),
	      memberProfilesByMemberId: queryCount(beforeVipNoneFilteredMemberListStatus, 'list_memberProfiles_memberId'),
	      kdaRowsByMemberId: queryCount(beforeVipNoneFilteredMemberListStatus, 'list_kdaRows_memberId'),
	      wipeParticipantsByMemberId: queryCount(beforeVipNoneFilteredMemberListStatus, 'list_wipeParticipants_memberId')
	    };
	    const vipNoneFilteredMemberListResponse = await httpFetch(`${baseUrl}/members?vitalVipType=none&limit=10`, {
	      headers: { cookie }
	    });
	    assert.equal(vipNoneFilteredMemberListResponse.status, 200);
	    const vipNoneFilteredMemberListPayload = await vipNoneFilteredMemberListResponse.json();
	    assert.equal(vipNoneFilteredMemberListPayload.ok, true);
	    assert.equal(vipNoneFilteredMemberListPayload.total, expectedVipNoneMemberIds.length);
	    assert.equal(vipNoneFilteredMemberListPayload.offset, 0);
	    assert.equal(vipNoneFilteredMemberListPayload.limit, 10);
	    assert.deepEqual(
	      vipNoneFilteredMemberListPayload.members.map((member) => member.id),
	      expectedVipNoneMemberIds.slice(0, 10)
	    );
	    assert.equal(
	      vipNoneFilteredMemberListPayload.members.some((member) => member.id === 'member_sqlite_query_invalid_vip'),
	      true
	    );
	    assert.equal(
	      vipNoneFilteredMemberListPayload.members.some((member) => member.id === 'member_sqlite_query_empty_vip'),
	      true
	    );
	    assert.equal(
	      vipNoneFilteredMemberListPayload.members.some((member) => member.id === 'member_sqlite_query_padded_priority_vip'),
	      false
	    );
	    assert.equal(
	      vipNoneFilteredMemberListPayload.members.some((member) => member.id === 'member_sqlite_query_padded_queue_skip_vip'),
	      false
	    );
	    assert.equal(vipNoneFilteredMemberListPayload.members.some((member) => member.vitalVipType === 'priority'), false);
	    assert.equal(vipNoneFilteredMemberListPayload.hasMore, true);
	    const vipNoneSecondPageResponse = await httpFetch(`${baseUrl}/members?vitalVipType=none&limit=2&offset=1`, {
	      headers: { cookie }
	    });
	    assert.equal(vipNoneSecondPageResponse.status, 200);
	    const vipNoneSecondPagePayload = await vipNoneSecondPageResponse.json();
	    assert.equal(vipNoneSecondPagePayload.ok, true);
	    assert.equal(vipNoneSecondPagePayload.total, expectedVipNoneMemberIds.length);
	    assert.equal(vipNoneSecondPagePayload.offset, 1);
	    assert.equal(vipNoneSecondPagePayload.limit, 2);
	    assert.deepEqual(
	      vipNoneSecondPagePayload.members.map((member) => member.id),
	      expectedVipNoneMemberIds.slice(1, 3)
	    );
	    assert.equal(vipNoneSecondPagePayload.hasMore, true);
	    const afterVipNoneFilteredMemberListStatus = await storeModule.storeRuntimeStatus();
	    assert.equal(queryCount(afterVipNoneFilteredMemberListStatus, 'list_members'), beforeVipNoneFilteredMemberListFullReads.members);
	    assert.equal(queryCount(afterVipNoneFilteredMemberListStatus, 'list_squadMembers'), beforeVipNoneFilteredMemberListFullReads.squadMembers);
	    assert.equal(
	      queryCount(afterVipNoneFilteredMemberListStatus, 'list_members_vitalVipType_normalized') >
	        beforeVipNoneFilteredMemberListScopedReads.membersByVipType,
	      true
	    );
	    assert.equal(
	      queryCount(afterVipNoneFilteredMemberListStatus, 'list_squadMembers_memberId') >
	        beforeVipNoneFilteredMemberListScopedReads.squadMembersByMemberId,
	      true
	    );
	    assert.equal(
	      queryCount(afterVipNoneFilteredMemberListStatus, 'list_memberProfiles_memberId') >
	        beforeVipNoneFilteredMemberListScopedReads.memberProfilesByMemberId,
	      true
	    );
	    assert.equal(
	      queryCount(afterVipNoneFilteredMemberListStatus, 'list_kdaRows_memberId') >
	        beforeVipNoneFilteredMemberListScopedReads.kdaRowsByMemberId,
	      true
	    );
	    assert.equal(
	      queryCount(afterVipNoneFilteredMemberListStatus, 'list_wipeParticipants_memberId') >
	        beforeVipNoneFilteredMemberListScopedReads.wipeParticipantsByMemberId,
	      true
	    );

	    const beforeComplexVipNoneFilterStatus = await storeModule.storeRuntimeStatus({ sqliteSummary: false });
	    const beforeComplexVipNoneFullReads = {
	      members: queryCount(beforeComplexVipNoneFilterStatus, 'list_members'),
	      squads: queryCount(beforeComplexVipNoneFilterStatus, 'list_squads'),
	      squadMembers: queryCount(beforeComplexVipNoneFilterStatus, 'list_squadMembers')
	    };
	    const beforeComplexVipNoneReads = {
	      membersByVipType: queryCount(beforeComplexVipNoneFilterStatus, 'list_members_vitalVipType_normalized'),
	      squadMembersByMemberId: queryCount(beforeComplexVipNoneFilterStatus, 'list_squadMembers_memberId')
	    };
	    const complexVipNoneFilterResponse = await httpFetch(`${baseUrl}/members?vitalVipType=none&q=Invalid&limit=1`, {
	      headers: { cookie }
	    });
	    assert.equal(complexVipNoneFilterResponse.status, 200);
	    const complexVipNoneFilterPayload = await complexVipNoneFilterResponse.json();
	    assert.equal(complexVipNoneFilterPayload.ok, true);
	    assert.equal(complexVipNoneFilterPayload.total, 1);
	    assert.equal(complexVipNoneFilterPayload.members[0].id, 'member_sqlite_query_invalid_vip');
	    const afterComplexVipNoneFilterStatus = await storeModule.storeRuntimeStatus({ sqliteSummary: false });
	    assert.equal(queryCount(afterComplexVipNoneFilterStatus, 'list_members'), beforeComplexVipNoneFullReads.members);
	    assert.equal(queryCount(afterComplexVipNoneFilterStatus, 'list_squads'), beforeComplexVipNoneFullReads.squads);
	    assert.equal(queryCount(afterComplexVipNoneFilterStatus, 'list_squadMembers'), beforeComplexVipNoneFullReads.squadMembers);
	    assert.equal(
	      queryCount(afterComplexVipNoneFilterStatus, 'list_members_vitalVipType_normalized') >
	        beforeComplexVipNoneReads.membersByVipType,
	      true
	    );
	    assert.equal(
	      queryCount(afterComplexVipNoneFilterStatus, 'list_squadMembers_memberId') >
	        beforeComplexVipNoneReads.squadMembersByMemberId,
	      true
	    );

	    const beforeComplexVipTypeFilterStatus = afterComplexVipNoneFilterStatus;
	    const beforeComplexVipTypeFullReads = {
	      members: queryCount(beforeComplexVipTypeFilterStatus, 'list_members'),
	      squads: queryCount(beforeComplexVipTypeFilterStatus, 'list_squads'),
	      squadMembers: queryCount(beforeComplexVipTypeFilterStatus, 'list_squadMembers')
	    };
	    const beforeComplexVipTypeReads = {
	      membersByVipType: queryCount(beforeComplexVipTypeFilterStatus, 'list_members_vitalVipType_normalized'),
	      squadMembersByMemberId: queryCount(beforeComplexVipTypeFilterStatus, 'list_squadMembers_memberId')
	    };
	    const complexVipPriorityFilterResponse = await httpFetch(`${baseUrl}/members?vitalVipType=priority&q=Padded%20Priority&limit=10`, {
	      headers: { cookie }
	    });
	    assert.equal(complexVipPriorityFilterResponse.status, 200);
	    const complexVipPriorityFilterPayload = await complexVipPriorityFilterResponse.json();
	    assert.equal(complexVipPriorityFilterPayload.ok, true);
	    assert.equal(complexVipPriorityFilterPayload.total, 1);
	    assert.deepEqual(
	      complexVipPriorityFilterPayload.members.map((member) => member.id),
	      ['member_sqlite_query_padded_priority_vip']
	    );
	    assert.equal(complexVipPriorityFilterPayload.hasMore, false);
	    const complexVipQueueFilterResponse = await httpFetch(`${baseUrl}/members?vitalVipType=queue_skip&q=Padded%20Queue&limit=10`, {
	      headers: { cookie }
	    });
	    assert.equal(complexVipQueueFilterResponse.status, 200);
	    const complexVipQueueFilterPayload = await complexVipQueueFilterResponse.json();
	    assert.equal(complexVipQueueFilterPayload.ok, true);
	    assert.equal(complexVipQueueFilterPayload.total, 1);
	    assert.deepEqual(
	      complexVipQueueFilterPayload.members.map((member) => member.id),
	      ['member_sqlite_query_padded_queue_skip_vip']
	    );
	    assert.equal(complexVipQueueFilterPayload.hasMore, false);
	    const afterComplexVipTypeFilterStatus = await storeModule.storeRuntimeStatus({ sqliteSummary: false });
	    assert.equal(queryCount(afterComplexVipTypeFilterStatus, 'list_members'), beforeComplexVipTypeFullReads.members);
	    assert.equal(queryCount(afterComplexVipTypeFilterStatus, 'list_squads'), beforeComplexVipTypeFullReads.squads);
	    assert.equal(queryCount(afterComplexVipTypeFilterStatus, 'list_squadMembers'), beforeComplexVipTypeFullReads.squadMembers);
	    assert.equal(
	      queryCount(afterComplexVipTypeFilterStatus, 'list_members_vitalVipType_normalized') >
	        beforeComplexVipTypeReads.membersByVipType,
	      true
	    );
	    assert.equal(
	      queryCount(afterComplexVipTypeFilterStatus, 'list_squadMembers_memberId') >
	        beforeComplexVipTypeReads.squadMembersByMemberId,
	      true
	    );

	    const allMembersForUnassignedList = await repositoryModule.getSqliteCollection('members', { limit: 0 });
	    const allSquadsForUnassignedList = await repositoryModule.getSqliteCollection('squads', { limit: 0 });
	    const allSquadMembersForUnassignedList = await repositoryModule.getSqliteCollection('squadMembers', { limit: 0 });
	    const validUnassignedSquadIds = new Set(allSquadsForUnassignedList.map((squad) => squad.id));
	    const assignedMemberIdsForUnassignedList = new Set(allSquadMembersForUnassignedList
	      .filter((relation) => validUnassignedSquadIds.has(relation.squadId))
	      .map((relation) => relation.memberId));
	    const expectedUnassignedMemberIds = allMembersForUnassignedList
	      .filter((member) => !assignedMemberIdsForUnassignedList.has(member.id))
	      .map((member) => member.id);
	    const beforeUnassignedMemberListStatus = await storeModule.storeRuntimeStatus({ sqliteSummary: false });
	    const beforeUnassignedMemberListFullReads = {
	      members: queryCount(beforeUnassignedMemberListStatus, 'list_members'),
	      squads: queryCount(beforeUnassignedMemberListStatus, 'list_squads'),
	      squadMembers: queryCount(beforeUnassignedMemberListStatus, 'list_squadMembers')
	    };
	    const beforeUnassignedMemberListScopedReads = {
	      membersWithoutSquad: queryCount(
	        beforeUnassignedMemberListStatus,
	        'list_members_without_squadMembers_memberId_existing_squads_squadId'
	      ),
	      memberCountWithoutSquad: queryCount(
	        beforeUnassignedMemberListStatus,
	        'count_members_without_squadMembers_memberId_existing_squads_squadId'
	      ),
	      squadsById: queryCount(beforeUnassignedMemberListStatus, 'list_squads_id'),
	      squadMembersByMemberId: queryCount(beforeUnassignedMemberListStatus, 'list_squadMembers_memberId'),
	      memberProfilesByMemberId: queryCount(beforeUnassignedMemberListStatus, 'list_memberProfiles_memberId'),
	      kdaRowsByMemberId: queryCount(beforeUnassignedMemberListStatus, 'list_kdaRows_memberId'),
	      wipeParticipantsByMemberId: queryCount(beforeUnassignedMemberListStatus, 'list_wipeParticipants_memberId')
	    };
	    const unassignedMemberListResponse = await httpFetch(`${baseUrl}/members?squadId=__none__&limit=5`, {
	      headers: { cookie }
	    });
	    assert.equal(unassignedMemberListResponse.status, 200);
	    const unassignedMemberListPayload = await unassignedMemberListResponse.json();
	    assert.equal(unassignedMemberListPayload.ok, true);
	    assert.equal(unassignedMemberListPayload.total, expectedUnassignedMemberIds.length);
	    assert.equal(unassignedMemberListPayload.offset, 0);
	    assert.equal(unassignedMemberListPayload.limit, 5);
	    assert.deepEqual(
	      unassignedMemberListPayload.members.map((member) => member.id),
	      expectedUnassignedMemberIds.slice(0, 5)
	    );
	    const missingSquadRelationMember = unassignedMemberListPayload.members.find((member) => (
	      member.id === 'member_sqlite_query_missing_squad_relation'
	    ));
	    assert.equal(Boolean(missingSquadRelationMember), true);
	    assert.equal(missingSquadRelationMember.squadId, '');
	    assert.equal(missingSquadRelationMember.squadName, '');
	    assert.equal(unassignedMemberListPayload.hasMore, true);
	    const unassignedAliasMemberListResponse = await httpFetch(`${baseUrl}/members?squadId=__unassigned&limit=2&offset=1`, {
	      headers: { cookie }
	    });
	    assert.equal(unassignedAliasMemberListResponse.status, 200);
	    const unassignedAliasMemberListPayload = await unassignedAliasMemberListResponse.json();
	    assert.equal(unassignedAliasMemberListPayload.ok, true);
	    assert.equal(unassignedAliasMemberListPayload.total, expectedUnassignedMemberIds.length);
	    assert.equal(unassignedAliasMemberListPayload.offset, 1);
	    assert.equal(unassignedAliasMemberListPayload.limit, 2);
	    assert.deepEqual(
	      unassignedAliasMemberListPayload.members.map((member) => member.id),
	      expectedUnassignedMemberIds.slice(1, 3)
	    );
	    const afterUnassignedMemberListStatus = await storeModule.storeRuntimeStatus({ sqliteSummary: false });
	    assert.equal(queryCount(afterUnassignedMemberListStatus, 'list_members'), beforeUnassignedMemberListFullReads.members);
	    assert.equal(queryCount(afterUnassignedMemberListStatus, 'list_squads'), beforeUnassignedMemberListFullReads.squads);
	    assert.equal(queryCount(afterUnassignedMemberListStatus, 'list_squadMembers'), beforeUnassignedMemberListFullReads.squadMembers);
	    assert.equal(
	      queryCount(afterUnassignedMemberListStatus, 'list_members_without_squadMembers_memberId_existing_squads_squadId') >
	        beforeUnassignedMemberListScopedReads.membersWithoutSquad,
	      true
	    );
	    assert.equal(
	      queryCount(afterUnassignedMemberListStatus, 'count_members_without_squadMembers_memberId_existing_squads_squadId') >
	        beforeUnassignedMemberListScopedReads.memberCountWithoutSquad,
	      true
	    );
	    assert.equal(queryCount(afterUnassignedMemberListStatus, 'list_squads_id') > beforeUnassignedMemberListScopedReads.squadsById, true);
	    assert.equal(
	      queryCount(afterUnassignedMemberListStatus, 'list_squadMembers_memberId') >
	        beforeUnassignedMemberListScopedReads.squadMembersByMemberId,
	      true
	    );
	    assert.equal(
	      queryCount(afterUnassignedMemberListStatus, 'list_memberProfiles_memberId') >
	        beforeUnassignedMemberListScopedReads.memberProfilesByMemberId,
	      true
	    );
	    assert.equal(
	      queryCount(afterUnassignedMemberListStatus, 'list_kdaRows_memberId') >
	        beforeUnassignedMemberListScopedReads.kdaRowsByMemberId,
	      true
	    );
	    assert.equal(
	      queryCount(afterUnassignedMemberListStatus, 'list_wipeParticipants_memberId') >
	        beforeUnassignedMemberListScopedReads.wipeParticipantsByMemberId,
	      true
	    );
	    const beforeComplexUnassignedFilterStatus = await storeModule.storeRuntimeStatus({ sqliteSummary: false });
	    const beforeComplexUnassignedFullReads = {
	      members: queryCount(beforeComplexUnassignedFilterStatus, 'list_members'),
	      squads: queryCount(beforeComplexUnassignedFilterStatus, 'list_squads'),
	      squadMembers: queryCount(beforeComplexUnassignedFilterStatus, 'list_squadMembers')
	    };
	    const beforeComplexUnassignedReads = {
	      membersWithoutSquad: queryCount(
	        beforeComplexUnassignedFilterStatus,
	        'list_members_without_squadMembers_memberId_existing_squads_squadId'
	      ),
	      squadMembersByMemberId: queryCount(beforeComplexUnassignedFilterStatus, 'list_squadMembers_memberId')
	    };
	    const complexUnassignedFilterResponse = await httpFetch(`${baseUrl}/members?squadId=__none__&q=Missing%20Squad&limit=1`, {
	      headers: { cookie }
	    });
	    assert.equal(complexUnassignedFilterResponse.status, 200);
	    const complexUnassignedFilterPayload = await complexUnassignedFilterResponse.json();
	    assert.equal(complexUnassignedFilterPayload.ok, true);
	    assert.equal(complexUnassignedFilterPayload.total, 1);
	    assert.equal(complexUnassignedFilterPayload.members[0].id, 'member_sqlite_query_missing_squad_relation');
	    const afterComplexUnassignedFilterStatus = await storeModule.storeRuntimeStatus({ sqliteSummary: false });
	    assert.equal(queryCount(afterComplexUnassignedFilterStatus, 'list_members'), beforeComplexUnassignedFullReads.members);
	    assert.equal(queryCount(afterComplexUnassignedFilterStatus, 'list_squads'), beforeComplexUnassignedFullReads.squads);
	    assert.equal(queryCount(afterComplexUnassignedFilterStatus, 'list_squadMembers'), beforeComplexUnassignedFullReads.squadMembers);
	    assert.equal(
	      queryCount(afterComplexUnassignedFilterStatus, 'list_members_without_squadMembers_memberId_existing_squads_squadId') >
	        beforeComplexUnassignedReads.membersWithoutSquad,
	      true
	    );
	    assert.equal(
	      queryCount(afterComplexUnassignedFilterStatus, 'list_squadMembers_memberId') >
	        beforeComplexUnassignedReads.squadMembersByMemberId,
	      true
	    );

	    const beforeSpecialtyFilteredMemberListStatus = afterComplexUnassignedFilterStatus;
	    const beforeSpecialtyFilteredMemberListFullReads = {
	      members: queryCount(beforeSpecialtyFilteredMemberListStatus, 'list_members'),
	      squadMembers: queryCount(beforeSpecialtyFilteredMemberListStatus, 'list_squadMembers')
	    };
	    const beforeSpecialtyFilteredMemberListScopedReads = {
	      membersBySpecialty: queryCount(beforeSpecialtyFilteredMemberListStatus, 'list_members_specialty_array'),
	      membersBySpecialtyText: queryCount(beforeSpecialtyFilteredMemberListStatus, 'list_members_specialty_text_contains'),
	      squadsById: queryCount(beforeSpecialtyFilteredMemberListStatus, 'list_squads_id'),
	      squadMembersByMemberId: queryCount(beforeSpecialtyFilteredMemberListStatus, 'list_squadMembers_memberId'),
	      memberProfilesByMemberId: queryCount(beforeSpecialtyFilteredMemberListStatus, 'list_memberProfiles_memberId'),
	      kdaRowsByMemberId: queryCount(beforeSpecialtyFilteredMemberListStatus, 'list_kdaRows_memberId'),
	      wipeParticipantsByMemberId: queryCount(beforeSpecialtyFilteredMemberListStatus, 'list_wipeParticipants_memberId')
	    };
	    const specialtyFilteredMemberListResponse = await httpFetch(`${baseUrl}/members?specialty=pvp&limit=1`, {
	      headers: { cookie }
	    });
	    assert.equal(specialtyFilteredMemberListResponse.status, 200);
	    const specialtyFilteredMemberListPayload = await specialtyFilteredMemberListResponse.json();
	    assert.equal(specialtyFilteredMemberListPayload.ok, true);
	    assert.equal(specialtyFilteredMemberListPayload.total, 3);
	    assert.equal(specialtyFilteredMemberListPayload.members.length, 1);
	    assert.equal(specialtyFilteredMemberListPayload.members[0].id, 'member_sqlite_query_target');
	    assert.equal(specialtyFilteredMemberListPayload.members[0].squadId, 'squad_sqlite_query');
	    assert.equal(specialtyFilteredMemberListPayload.members[0].squadName, 'SQLite Query Squad');
	    assert.equal(specialtyFilteredMemberListPayload.hasMore, true);
	    const afterSpecialtyFilteredMemberListStatus = await storeModule.storeRuntimeStatus();
	    assert.equal(queryCount(afterSpecialtyFilteredMemberListStatus, 'list_members'), beforeSpecialtyFilteredMemberListFullReads.members);
	    assert.equal(queryCount(afterSpecialtyFilteredMemberListStatus, 'list_squadMembers'), beforeSpecialtyFilteredMemberListFullReads.squadMembers);
	    assert.equal(
	      queryCount(afterSpecialtyFilteredMemberListStatus, 'list_members_specialty_array') >
	        beforeSpecialtyFilteredMemberListScopedReads.membersBySpecialty,
	      true
	    );
	    assert.equal(
	      queryCount(afterSpecialtyFilteredMemberListStatus, 'list_members_specialty_text_contains') >
	        beforeSpecialtyFilteredMemberListScopedReads.membersBySpecialtyText,
	      true
	    );
	    const specialtyAliasResponse = await httpFetch(`${baseUrl}/members?specialty=gunner&limit=10`, {
	      headers: { cookie }
	    });
	    assert.equal(specialtyAliasResponse.status, 200);
	    const specialtyAliasPayload = await specialtyAliasResponse.json();
	    assert.equal(specialtyAliasPayload.ok, true);
	    assert.equal(specialtyAliasPayload.total, 3);
	    assert.deepEqual(
	      specialtyAliasPayload.members.map((member) => member.id),
	      ['member_sqlite_query_target', 'member_sqlite_query_pvp_string', 'member_sqlite_query_pvp_trim']
	    );
	    const beforeComplexSpecialtyFilterStatus = await storeModule.storeRuntimeStatus({ sqliteSummary: false });
	    const beforeComplexSpecialtyFullReads = {
	      members: queryCount(beforeComplexSpecialtyFilterStatus, 'list_members'),
	      squads: queryCount(beforeComplexSpecialtyFilterStatus, 'list_squads'),
	      squadMembers: queryCount(beforeComplexSpecialtyFilterStatus, 'list_squadMembers')
	    };
	    const beforeComplexSpecialtyReads = {
	      membersBySpecialty: queryCount(beforeComplexSpecialtyFilterStatus, 'list_members_specialty_array'),
	      membersBySpecialtyText: queryCount(beforeComplexSpecialtyFilterStatus, 'list_members_specialty_text_contains'),
	      squadMembersByMemberId: queryCount(beforeComplexSpecialtyFilterStatus, 'list_squadMembers_memberId')
	    };
	    const complexSpecialtyFilterResponse = await httpFetch(`${baseUrl}/members?specialty=pvp&q=Target&limit=1`, {
	      headers: { cookie }
	    });
	    assert.equal(complexSpecialtyFilterResponse.status, 200);
	    const complexSpecialtyFilterPayload = await complexSpecialtyFilterResponse.json();
	    assert.equal(complexSpecialtyFilterPayload.ok, true);
	    assert.equal(complexSpecialtyFilterPayload.total, 1);
	    assert.equal(complexSpecialtyFilterPayload.members[0].id, 'member_sqlite_query_target');
	    const afterComplexSpecialtyFilterStatus = await storeModule.storeRuntimeStatus({ sqliteSummary: false });
	    assert.equal(queryCount(afterComplexSpecialtyFilterStatus, 'list_members'), beforeComplexSpecialtyFullReads.members);
	    assert.equal(queryCount(afterComplexSpecialtyFilterStatus, 'list_squads'), beforeComplexSpecialtyFullReads.squads);
	    assert.equal(queryCount(afterComplexSpecialtyFilterStatus, 'list_squadMembers'), beforeComplexSpecialtyFullReads.squadMembers);
	    assert.equal(
	      queryCount(afterComplexSpecialtyFilterStatus, 'list_members_specialty_array') >
	        beforeComplexSpecialtyReads.membersBySpecialty,
	      true
	    );
	    assert.equal(
	      queryCount(afterComplexSpecialtyFilterStatus, 'list_members_specialty_text_contains') >
	        beforeComplexSpecialtyReads.membersBySpecialtyText,
	      true
	    );
	    assert.equal(
	      queryCount(afterComplexSpecialtyFilterStatus, 'list_squadMembers_memberId') >
	        beforeComplexSpecialtyReads.squadMembersByMemberId,
	      true
	    );
	    assert.equal(queryCount(afterSpecialtyFilteredMemberListStatus, 'list_squads_id') > beforeSpecialtyFilteredMemberListScopedReads.squadsById, true);
	    assert.equal(
	      queryCount(afterSpecialtyFilteredMemberListStatus, 'list_squadMembers_memberId') >
	        beforeSpecialtyFilteredMemberListScopedReads.squadMembersByMemberId,
	      true
	    );
	    assert.equal(
	      queryCount(afterSpecialtyFilteredMemberListStatus, 'list_memberProfiles_memberId') >
	        beforeSpecialtyFilteredMemberListScopedReads.memberProfilesByMemberId,
	      true
	    );
	    assert.equal(
	      queryCount(afterSpecialtyFilteredMemberListStatus, 'list_kdaRows_memberId') >
	        beforeSpecialtyFilteredMemberListScopedReads.kdaRowsByMemberId,
	      true
	    );
	    assert.equal(
	      queryCount(afterSpecialtyFilteredMemberListStatus, 'list_wipeParticipants_memberId') >
	        beforeSpecialtyFilteredMemberListScopedReads.wipeParticipantsByMemberId,
	      true
	    );

	    const beforeSquadFilteredMemberListStatus = afterComplexSpecialtyFilterStatus;
	    const beforeSquadFilteredMemberListFullReads = {
	      members: queryCount(beforeSquadFilteredMemberListStatus, 'list_members'),
	      squadMembers: queryCount(beforeSquadFilteredMemberListStatus, 'list_squadMembers')
	    };
	    const beforeSquadFilteredMemberListScopedReads = {
	      squadMembersBySquadId: queryCount(beforeSquadFilteredMemberListStatus, 'list_squadMembers_squadId'),
	      membersById: queryCount(beforeSquadFilteredMemberListStatus, 'list_members_id'),
	      squadMembersByMemberId: queryCount(beforeSquadFilteredMemberListStatus, 'list_squadMembers_memberId'),
	      memberProfilesByMemberId: queryCount(beforeSquadFilteredMemberListStatus, 'list_memberProfiles_memberId'),
	      kdaRowsByMemberId: queryCount(beforeSquadFilteredMemberListStatus, 'list_kdaRows_memberId'),
	      wipeParticipantsByMemberId: queryCount(beforeSquadFilteredMemberListStatus, 'list_wipeParticipants_memberId')
	    };
	    const squadFilteredMemberListResponse = await httpFetch(`${baseUrl}/members?squadId=squad_sqlite_query&limit=1`, {
	      headers: { cookie }
	    });
	    assert.equal(squadFilteredMemberListResponse.status, 200);
	    const squadFilteredMemberListPayload = await squadFilteredMemberListResponse.json();
	    assert.equal(squadFilteredMemberListPayload.ok, true);
	    assert.equal(squadFilteredMemberListPayload.total, 3);
	    assert.equal(squadFilteredMemberListPayload.members.length, 1);
	    assert.equal(squadFilteredMemberListPayload.members[0].id, 'member_sqlite_query_target');
	    assert.equal(squadFilteredMemberListPayload.members[0].squadId, 'squad_sqlite_query');
	    assert.equal(squadFilteredMemberListPayload.members[0].squadName, 'SQLite Query Squad');
	    assert.equal(squadFilteredMemberListPayload.members[0].canManage, true);
	    assert.equal(typeof squadFilteredMemberListPayload.members[0].onlineSummary, 'object');
	    assert.equal(typeof squadFilteredMemberListPayload.members[0].accountSignals, 'object');
	    const afterSquadFilteredMemberListStatus = await storeModule.storeRuntimeStatus();
	    assert.equal(queryCount(afterSquadFilteredMemberListStatus, 'list_members'), beforeSquadFilteredMemberListFullReads.members);
	    assert.equal(queryCount(afterSquadFilteredMemberListStatus, 'list_squadMembers'), beforeSquadFilteredMemberListFullReads.squadMembers);
	    assert.equal(
	      queryCount(afterSquadFilteredMemberListStatus, 'list_squadMembers_squadId') >
	        beforeSquadFilteredMemberListScopedReads.squadMembersBySquadId,
	      true
	    );
	    assert.equal(queryCount(afterSquadFilteredMemberListStatus, 'list_members_id') > beforeSquadFilteredMemberListScopedReads.membersById, true);
	    assert.equal(
	      queryCount(afterSquadFilteredMemberListStatus, 'list_squadMembers_memberId') >
	        beforeSquadFilteredMemberListScopedReads.squadMembersByMemberId,
	      true
	    );
	    assert.equal(
	      queryCount(afterSquadFilteredMemberListStatus, 'list_memberProfiles_memberId') >
	        beforeSquadFilteredMemberListScopedReads.memberProfilesByMemberId,
	      true
	    );
	    assert.equal(queryCount(afterSquadFilteredMemberListStatus, 'list_kdaRows_memberId') > beforeSquadFilteredMemberListScopedReads.kdaRowsByMemberId, true);
	    assert.equal(
	      queryCount(afterSquadFilteredMemberListStatus, 'list_wipeParticipants_memberId') >
	        beforeSquadFilteredMemberListScopedReads.wipeParticipantsByMemberId,
	      true
	    );

	    const squadFilteredSecondPageResponse = await httpFetch(`${baseUrl}/members?squadId=squad_sqlite_query&limit=1&offset=1`, {
	      headers: { cookie }
	    });
	    assert.equal(squadFilteredSecondPageResponse.status, 200);
	    const squadFilteredSecondPagePayload = await squadFilteredSecondPageResponse.json();
	    assert.equal(squadFilteredSecondPagePayload.ok, true);
	    assert.equal(squadFilteredSecondPagePayload.total, 3);
	    assert.equal(squadFilteredSecondPagePayload.members.length, 1);
	    assert.equal(squadFilteredSecondPagePayload.members[0].id, 'member_sqlite_query_no_steam');
	    assert.equal(squadFilteredSecondPagePayload.members[0].squadId, 'squad_sqlite_query');

	    const beforeComplexSquadFilterStatus = await storeModule.storeRuntimeStatus({ sqliteSummary: false });
	    const beforeComplexSquadFilterFullReads = {
	      members: queryCount(beforeComplexSquadFilterStatus, 'list_members'),
	      squads: queryCount(beforeComplexSquadFilterStatus, 'list_squads'),
	      squadMembers: queryCount(beforeComplexSquadFilterStatus, 'list_squadMembers')
	    };
	    const beforeComplexSquadFilterScopedReads = {
	      squadMembersBySquadId: queryCount(beforeComplexSquadFilterStatus, 'list_squadMembers_squadId'),
	      membersById: queryCount(beforeComplexSquadFilterStatus, 'list_members_id'),
	      squadMembersByMemberId: queryCount(beforeComplexSquadFilterStatus, 'list_squadMembers_memberId')
	    };
	    const complexSquadFilterResponse = await httpFetch(`${baseUrl}/members?squadId=squad_sqlite_query&q=Target&limit=1`, {
	      headers: { cookie }
	    });
	    assert.equal(complexSquadFilterResponse.status, 200);
	    const complexSquadFilterPayload = await complexSquadFilterResponse.json();
	    assert.equal(complexSquadFilterPayload.ok, true);
	    assert.equal(complexSquadFilterPayload.total, 1);
	    assert.equal(complexSquadFilterPayload.members[0].id, 'member_sqlite_query_target');
	    const squadNameAndSquadFilterResponse = await httpFetch(
	      `${baseUrl}/members?squadId=squad_sqlite_query&q=SQLite%20Query%20Squad&limit=2&offset=1`,
	      { headers: { cookie } }
	    );
	    assert.equal(squadNameAndSquadFilterResponse.status, 200);
	    const squadNameAndSquadFilterPayload = await squadNameAndSquadFilterResponse.json();
	    assert.equal(squadNameAndSquadFilterPayload.ok, true);
	    assert.equal(squadNameAndSquadFilterPayload.total, 3);
	    assert.equal(squadNameAndSquadFilterPayload.offset, 1);
	    assert.equal(squadNameAndSquadFilterPayload.limit, 2);
	    assert.deepEqual(
	      squadNameAndSquadFilterPayload.members.map((member) => member.id),
	      ['member_sqlite_query_no_steam', 'member_sqlite_query_leader']
	    );
	    assert.equal(squadNameAndSquadFilterPayload.hasMore, false);
	    const squadSpecialtyFilterResponse = await httpFetch(`${baseUrl}/members?squadId=squad_sqlite_query&specialty=pvp&limit=10`, {
	      headers: { cookie }
	    });
	    assert.equal(squadSpecialtyFilterResponse.status, 200);
	    const squadSpecialtyFilterPayload = await squadSpecialtyFilterResponse.json();
	    assert.equal(squadSpecialtyFilterPayload.ok, true);
	    assert.equal(squadSpecialtyFilterPayload.total, 1);
	    assert.equal(squadSpecialtyFilterPayload.members[0].id, 'member_sqlite_query_target');
	    const squadVipFilterResponse = await httpFetch(`${baseUrl}/members?squadId=squad_sqlite_query&vitalVipType=priority&limit=10`, {
	      headers: { cookie }
	    });
	    assert.equal(squadVipFilterResponse.status, 200);
	    const squadVipFilterPayload = await squadVipFilterResponse.json();
	    assert.equal(squadVipFilterPayload.ok, true);
	    assert.equal(squadVipFilterPayload.total, 1);
	    assert.equal(squadVipFilterPayload.members[0].id, 'member_sqlite_query_target');
	    const afterComplexSquadFilterStatus = await storeModule.storeRuntimeStatus({ sqliteSummary: false });
	    assert.equal(queryCount(afterComplexSquadFilterStatus, 'list_members'), beforeComplexSquadFilterFullReads.members);
	    assert.equal(queryCount(afterComplexSquadFilterStatus, 'list_squads'), beforeComplexSquadFilterFullReads.squads);
	    assert.equal(queryCount(afterComplexSquadFilterStatus, 'list_squadMembers'), beforeComplexSquadFilterFullReads.squadMembers);
	    assert.equal(
	      queryCount(afterComplexSquadFilterStatus, 'list_squadMembers_squadId') >
	        beforeComplexSquadFilterScopedReads.squadMembersBySquadId,
	      true
	    );
	    assert.equal(queryCount(afterComplexSquadFilterStatus, 'list_members_id') > beforeComplexSquadFilterScopedReads.membersById, true);
	    assert.equal(
	      queryCount(afterComplexSquadFilterStatus, 'list_squadMembers_memberId') >
	        beforeComplexSquadFilterScopedReads.squadMembersByMemberId,
	      true
	    );

		    const previousBackgroundJobs = process.env.NB_DISABLE_BACKGROUND_JOBS;
    const beforeLoginEnsureStatus = await storeModule.storeRuntimeStatus();
    const beforeLoginEnsureStat = await stat(storeModule.STORE_FILE);
    const beforeLoginEnsureFullReads = {
      users: queryCount(beforeLoginEnsureStatus, 'list_users'),
      members: queryCount(beforeLoginEnsureStatus, 'list_members'),
      squads: queryCount(beforeLoginEnsureStatus, 'list_squads'),
      squadMembers: queryCount(beforeLoginEnsureStatus, 'list_squadMembers')
    };
    process.env.NB_DISABLE_BACKGROUND_JOBS = '0';
    try {
      const loginEnsureResponse = await httpFetch(`${baseUrl}/auth/login`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ username: 'sqlite_login_ensure', password: 'LoginEnsurePass123!' })
      });
      assert.equal(loginEnsureResponse.status, 200);
      await apiModule.drainBackgroundTaskQueuesForTests({ timeoutMs: 2000 });
    } finally {
      process.env.NB_DISABLE_BACKGROUND_JOBS = previousBackgroundJobs;
    }
    const loginEnsureMembers = await repositoryModule.getSqliteRecordsByJsonField('members', 'steamId', [loginEnsureSteamId], { limit: 0 });
    const afterLoginEnsureStatus = await storeModule.storeRuntimeStatus();
    const afterLoginEnsureStat = await stat(storeModule.STORE_FILE);
    assert.equal(loginEnsureMembers.length, 1);
    assert.equal(loginEnsureMembers[0].invitedByUserId, 'user_sqlite_login_ensure');
    assert.equal(afterLoginEnsureStat.mtimeMs, beforeLoginEnsureStat.mtimeMs);
    assert.equal(afterLoginEnsureStatus.metrics.writes.total, beforeLoginEnsureStatus.metrics.writes.total);
    assert.equal(afterLoginEnsureStatus.metrics.sqliteWrites, beforeLoginEnsureStatus.metrics.sqliteWrites);
    assert.equal(queryCount(afterLoginEnsureStatus, 'list_users'), beforeLoginEnsureFullReads.users);
    assert.equal(queryCount(afterLoginEnsureStatus, 'list_members'), beforeLoginEnsureFullReads.members);
    assert.equal(queryCount(afterLoginEnsureStatus, 'list_squads'), beforeLoginEnsureFullReads.squads);
    assert.equal(queryCount(afterLoginEnsureStatus, 'list_squadMembers'), beforeLoginEnsureFullReads.squadMembers);

	    const beforeStatus = await storeModule.storeRuntimeStatus({ sqliteSummary: false });
		    const beforeQueryFullReads = {
		      users: queryCount(beforeStatus, 'list_users'),
		      members: queryCount(beforeStatus, 'list_members'),
		      squads: queryCount(beforeStatus, 'list_squads'),
		      squadMembers: queryCount(beforeStatus, 'list_squadMembers'),
		      wipes: queryCount(beforeStatus, 'list_wipes')
		    };
		    const beforeQueryScopedReads = {
			      usersById: queryCount(beforeStatus, 'list_users_id'),
			      membersBySteamId: queryCount(beforeStatus, 'list_members_steamId'),
			      squadsById: queryCount(beforeStatus, 'list_squads_id'),
		      squadMembersByMemberId: queryCount(beforeStatus, 'list_squadMembers_memberId'),
		      wipesStatus: queryCount(beforeStatus, 'list_wipes_status')
		    };

    const queryResponse = await httpFetch(`${baseUrl}/query`, {
      method: 'POST',
      headers: {
        cookie,
        'content-type': 'application/json'
      },
      body: JSON.stringify({ steamInput: targetSteamId, detailed: true })
    });
    assert.equal(queryResponse.status, 200);
    const queryPayload = await queryResponse.json();
    assert.equal(queryPayload.isMember, true);
    assert.equal(queryPayload.member.steamId, targetSteamId);
	    assert.equal(queryPayload.member.profileStats.playTimeMinutes, 2400);
	    assert.equal(queryPayload.member.currentKda.kills, 12);
	    assert.equal(queryPayload.member.currentWipe.squad.leaders[0].steamId, leaderSteamId);
	    assert.equal(queryPayload.member.currentWipe.squad.leaders[0].avatar, 'https://example.com/query-leader.png');

	    const afterQueryStatus = await storeModule.storeRuntimeStatus({ sqliteSummary: false });
	    assert.equal(queryCount(afterQueryStatus, 'list_users'), beforeQueryFullReads.users);
		    assert.equal(queryCount(afterQueryStatus, 'list_members'), beforeQueryFullReads.members);
		    assert.equal(queryCount(afterQueryStatus, 'list_squads'), beforeQueryFullReads.squads);
		    assert.equal(queryCount(afterQueryStatus, 'list_squadMembers'), beforeQueryFullReads.squadMembers);
		    assert.equal(queryCount(afterQueryStatus, 'list_wipes'), beforeQueryFullReads.wipes);
			    assert.equal(queryCount(afterQueryStatus, 'list_users_id') > beforeQueryScopedReads.usersById, true);
			    assert.equal(queryCount(afterQueryStatus, 'list_members_steamId') > beforeQueryScopedReads.membersBySteamId, true);
			    assert.equal(queryCount(afterQueryStatus, 'list_squads_id') > beforeQueryScopedReads.squadsById, true);
		    assert.equal(queryCount(afterQueryStatus, 'list_squadMembers_memberId') > beforeQueryScopedReads.squadMembersByMemberId, true);
		    assert.equal(queryCount(afterQueryStatus, 'list_wipes_status') > beforeQueryScopedReads.wipesStatus, true);
		    assert.equal(queryCount(afterQueryStatus, 'list_memberProfiles_memberId') > queryCount(beforeStatus, 'list_memberProfiles_memberId'), true);
		    assert.equal(queryCount(afterQueryStatus, 'list_kdaRows_memberId') > queryCount(beforeStatus, 'list_kdaRows_memberId'), true);
		    assert.equal(queryCount(afterQueryStatus, 'list_wipeParticipants_memberId') > queryCount(beforeStatus, 'list_wipeParticipants_memberId'), true);

	    const beforeProfileGetMembers = queryCount(afterQueryStatus, 'get_members');
	    const beforeProfileSteamIdReads = queryCount(afterQueryStatus, 'list_members_steamId');
	    const beforeProfileWipesStatusReads = queryCount(afterQueryStatus, 'list_wipes_status');
    const profileResponse = await httpFetch(`${baseUrl}/members/member_sqlite_query_target/profile`, {
      headers: { cookie }
    });
    assert.equal(profileResponse.status, 200);
    const profilePayload = await profileResponse.json();
	    assert.equal(profilePayload.member.id, 'member_sqlite_query_target');
	    assert.equal(profilePayload.member.steamId, targetSteamId);
	    assert.equal(profilePayload.member.currentKda.kills, 12);
	    assert.equal(profilePayload.member.currentWipe.squad.leaders[0].steamId, leaderSteamId);

			    const afterProfileStatus = await storeModule.storeRuntimeStatus({ sqliteSummary: false });
			    assert.equal(queryCount(afterProfileStatus, 'list_members'), beforeQueryFullReads.members);
			    assert.equal(queryCount(afterProfileStatus, 'list_wipes'), beforeQueryFullReads.wipes);
			    assert.equal(queryCount(afterProfileStatus, 'get_members') > beforeProfileGetMembers, true);
			    assert.equal(queryCount(afterProfileStatus, 'list_members_steamId') > beforeProfileSteamIdReads, true);
			    assert.equal(queryCount(afterProfileStatus, 'list_wipes_status') > beforeProfileWipesStatusReads, true);

	    const beforeNoSteamProfileStatus = afterProfileStatus;
	    const beforeNoSteamFullReads = {
	      users: queryCount(beforeNoSteamProfileStatus, 'list_users'),
	      members: queryCount(beforeNoSteamProfileStatus, 'list_members'),
	      squads: queryCount(beforeNoSteamProfileStatus, 'list_squads'),
	      squadMembers: queryCount(beforeNoSteamProfileStatus, 'list_squadMembers'),
	      wipes: queryCount(beforeNoSteamProfileStatus, 'list_wipes'),
	      discordMemberApplications: queryCount(beforeNoSteamProfileStatus, 'list_discordMemberApplications')
	    };
	    const beforeNoSteamScopedReads = {
	      memberGet: queryCount(beforeNoSteamProfileStatus, 'get_members'),
	      wipesStatus: queryCount(beforeNoSteamProfileStatus, 'list_wipes_status'),
	      squadMembersByMemberId: queryCount(beforeNoSteamProfileStatus, 'list_squadMembers_memberId'),
	      squadsById: queryCount(beforeNoSteamProfileStatus, 'list_squads_id'),
	      usersById: queryCount(beforeNoSteamProfileStatus, 'list_users_id'),
	      membersBySteamId: queryCount(beforeNoSteamProfileStatus, 'list_members_steamId'),
	      memberProfilesByMemberId: queryCount(beforeNoSteamProfileStatus, 'list_memberProfiles_memberId'),
	      kdaRowsByMemberId: queryCount(beforeNoSteamProfileStatus, 'list_kdaRows_memberId'),
	      discordApplicationsByMemberId: queryCount(beforeNoSteamProfileStatus, 'list_discordMemberApplications_memberId')
	    };
	    const noSteamProfileResponse = await httpFetch(`${baseUrl}/members/member_sqlite_query_no_steam/profile`, {
	      headers: { cookie }
	    });
	    assert.equal(noSteamProfileResponse.status, 200);
	    const noSteamProfilePayload = await noSteamProfileResponse.json();
	    assert.equal(noSteamProfilePayload.member.id, 'member_sqlite_query_no_steam');
	    assert.equal(noSteamProfilePayload.member.steamId, '');
	    assert.equal(noSteamProfilePayload.member.displayName, 'SQLite Query No Steam');
	    assert.equal(noSteamProfilePayload.member.currentKda.kills, 7);
	    assert.equal(noSteamProfilePayload.member.currentWipe.squad.leaders[0].steamId, leaderSteamId);
	    const afterNoSteamProfileStatus = await storeModule.storeRuntimeStatus({ sqliteSummary: false });
	    assert.equal(queryCount(afterNoSteamProfileStatus, 'list_users'), beforeNoSteamFullReads.users);
	    assert.equal(queryCount(afterNoSteamProfileStatus, 'list_members'), beforeNoSteamFullReads.members);
	    assert.equal(queryCount(afterNoSteamProfileStatus, 'list_squads'), beforeNoSteamFullReads.squads);
	    assert.equal(queryCount(afterNoSteamProfileStatus, 'list_squadMembers'), beforeNoSteamFullReads.squadMembers);
	    assert.equal(queryCount(afterNoSteamProfileStatus, 'list_wipes'), beforeNoSteamFullReads.wipes);
	    assert.equal(queryCount(afterNoSteamProfileStatus, 'list_discordMemberApplications'), beforeNoSteamFullReads.discordMemberApplications);
	    assert.equal(queryCount(afterNoSteamProfileStatus, 'get_members') > beforeNoSteamScopedReads.memberGet, true);
	    assert.equal(queryCount(afterNoSteamProfileStatus, 'list_wipes_status') > beforeNoSteamScopedReads.wipesStatus, true);
	    assert.equal(queryCount(afterNoSteamProfileStatus, 'list_squadMembers_memberId') > beforeNoSteamScopedReads.squadMembersByMemberId, true);
	    assert.equal(queryCount(afterNoSteamProfileStatus, 'list_squads_id') > beforeNoSteamScopedReads.squadsById, true);
	    assert.equal(queryCount(afterNoSteamProfileStatus, 'list_users_id') > beforeNoSteamScopedReads.usersById, true);
	    assert.equal(queryCount(afterNoSteamProfileStatus, 'list_members_steamId') > beforeNoSteamScopedReads.membersBySteamId, true);
	    assert.equal(queryCount(afterNoSteamProfileStatus, 'list_memberProfiles_memberId') > beforeNoSteamScopedReads.memberProfilesByMemberId, true);
	    assert.equal(queryCount(afterNoSteamProfileStatus, 'list_kdaRows_memberId') > beforeNoSteamScopedReads.kdaRowsByMemberId, true);
	    assert.equal(
	      queryCount(afterNoSteamProfileStatus, 'list_discordMemberApplications_memberId') >
	        beforeNoSteamScopedReads.discordApplicationsByMemberId,
	      true
	    );

	    const beforeDiscordIdReads = queryCount(afterNoSteamProfileStatus, 'list_members_discordId');
    const discordInteractionBase = {
      type: 3,
      application_id: '123456789012340001',
      locale: 'zh-CN',
      member: {
        roles: [],
        permissions: '0',
        user: { id: discordUserId, username: 'SQLiteDiscordVip' }
      }
    };
    let vipResponse = await postDiscordInteraction({
      ...discordInteractionBase,
      token: 'sqlite_interaction_vip_open',
      data: { custom_id: 'nb_vital_vip:open' }
    });
    assert.equal(vipResponse.status, 200);
    let vipPayload = await vipResponse.json();
    assert.equal(vipPayload.type, 4);
    assert.match(vipPayload.data.content, /请选择要更新的 VIP 平台/);
    assert.equal(vipPayload.data.components[0].components[0].custom_id, 'nb_vital_vip:provider');

    vipResponse = await postDiscordInteraction({
      ...discordInteractionBase,
      token: 'sqlite_interaction_vip_provider',
      data: { custom_id: 'nb_vital_vip:provider', values: ['rustinity'] }
    });
    assert.equal(vipResponse.status, 200);
    vipPayload = await vipResponse.json();
    assert.equal(vipPayload.type, 4);
    assert.equal(vipPayload.data.components[0].components[0].custom_id, 'nb_vital_vip:type:rustinity');

    vipResponse = await postDiscordInteraction({
      ...discordInteractionBase,
      token: 'sqlite_interaction_vip_type',
      data: { custom_id: 'nb_vital_vip:type:rustinity', values: ['queue_skip'] }
    });
    assert.equal(vipResponse.status, 200);
    vipPayload = await vipResponse.json();
    assert.equal(vipPayload.type, 9);
    assert.equal(vipPayload.data.custom_id, 'nb_vital_vip:submit:rustinity:queue_skip');

	    const afterDiscordVipStatus = await storeModule.storeRuntimeStatus({ sqliteSummary: false });
	    assert.equal(queryCount(afterDiscordVipStatus, 'list_members'), beforeQueryFullReads.members);
	    assert.equal(queryCount(afterDiscordVipStatus, 'list_members_discordId') > beforeDiscordIdReads, true);

    const beforeVipSubmitStatus = await storeModule.storeRuntimeStatus({ sqliteSummary: false });
    const beforeDiscordVipUpdateWrite = writeCount(beforeVipSubmitStatus, 'discord_vip_update');
    const beforeDiscordVipUpdateLogTrimWrite = writeCount(beforeVipSubmitStatus, 'discord_vip_update_log_trim');
    const vipPurchaseYear = String(new Date().getUTCFullYear());
    vipResponse = await postDiscordInteraction({
      type: 5,
      application_id: '123456789012340001',
      token: 'sqlite_interaction_vip_submit',
      locale: 'zh-CN',
      member: {
        roles: [],
        permissions: '0',
        user: { id: discordUserId, username: 'SQLiteDiscordVip' }
      },
      data: {
        custom_id: 'nb_vital_vip:submit:rustinity:queue_skip',
        components: [
          { type: 18, component: { type: 3, custom_id: 'date_month', values: ['08'] } },
          { type: 18, component: { type: 4, custom_id: 'date_day', value: '2' } }
        ]
      }
    });
    assert.equal(vipResponse.status, 200);
    vipPayload = await vipResponse.json();
    assert.equal(vipPayload.type, 4);
    assert.match(vipPayload.data.content, /已更新 Rustinity VIP：免排队/);

	    const updatedMember = await repositoryModule.getSqliteRecord('members', 'member_sqlite_query_target');
    let logs = await repositoryModule.getSqliteCollection('logs', { limit: 0 });
    const afterVipSubmitStatus = await storeModule.storeRuntimeStatus({ sqliteSummary: false });
    assert.equal(updatedMember.rustinityVipType, 'queue_skip');
    assert.equal(updatedMember.rustinityVipPurchasedAt, `${vipPurchaseYear}-08-02`);
    assert.equal(updatedMember.rustinityVipExpiresAt, `${vipPurchaseYear}-08-30`);
    assert.equal(logs.some((log) => log.type === 'discord_rustinity_vip_update' && log.targetId === 'member_sqlite_query_target'), true);
    assert.equal(afterVipSubmitStatus.metrics.writes.total, beforeVipSubmitStatus.metrics.writes.total);
	    assert.equal(afterVipSubmitStatus.metrics.sqliteWrites, beforeVipSubmitStatus.metrics.sqliteWrites);
		    assert.equal(queryCount(afterVipSubmitStatus, 'list_members'), beforeQueryFullReads.members);
	    assert.equal(queryCount(afterVipSubmitStatus, 'list_members_discordId') > queryCount(beforeVipSubmitStatus, 'list_members_discordId'), true);
    assert.equal(writeCount(afterVipSubmitStatus, 'discord_vip_update'), beforeDiscordVipUpdateWrite + 1);
    assert.equal(writeCount(afterVipSubmitStatus, 'discord_vip_update_log_trim'), beforeDiscordVipUpdateLogTrimWrite);

    const beforeDiscordConnectStatus = await storeModule.storeRuntimeStatus({ sqliteSummary: false });
    const beforeDiscordConnectFullReads = {
      wipes: queryCount(beforeDiscordConnectStatus, 'list_wipes'),
      members: queryCount(beforeDiscordConnectStatus, 'list_members'),
      squads: queryCount(beforeDiscordConnectStatus, 'list_squads'),
      squadMembers: queryCount(beforeDiscordConnectStatus, 'list_squadMembers'),
      wipeParticipants: queryCount(beforeDiscordConnectStatus, 'list_wipeParticipants')
    };
    const beforeDiscordConnectWipeGets = queryCount(beforeDiscordConnectStatus, 'get_wipes');
    const connectResponse = await postDiscordInteraction({
      ...discordInteractionBase,
      token: 'sqlite_interaction_wipe_connect',
      data: { custom_id: 'nb_wipe_signup:connect:wipe_sqlite_query_current' }
    });
    assert.equal(connectResponse.status, 200);
    const connectPayload = await connectResponse.json();
    assert.equal(connectPayload.type, 6);
    for (let attempt = 0; attempt < 80; attempt += 1) {
      if (discordFollowups.some((followup) => followup.token === 'sqlite_interaction_wipe_connect')) break;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    const connectFollowup = discordFollowups.find((followup) => followup.token === 'sqlite_interaction_wipe_connect');
    assert.equal(Boolean(connectFollowup), true);
    assert.match(connectFollowup.body.content, /Direct Connect|直连地址/);
    assert.match(connectFollowup.body.content, /client\.connect/);
    const afterDiscordConnectStatus = await storeModule.storeRuntimeStatus({ sqliteSummary: false });
    assert.equal(afterDiscordConnectStatus.metrics.writes.total, beforeDiscordConnectStatus.metrics.writes.total);
    assert.equal(afterDiscordConnectStatus.metrics.sqliteWrites, beforeDiscordConnectStatus.metrics.sqliteWrites);
    assert.equal(queryCount(afterDiscordConnectStatus, 'list_wipes'), beforeDiscordConnectFullReads.wipes);
    assert.equal(queryCount(afterDiscordConnectStatus, 'list_members'), beforeDiscordConnectFullReads.members);
    assert.equal(queryCount(afterDiscordConnectStatus, 'list_squads'), beforeDiscordConnectFullReads.squads);
    assert.equal(queryCount(afterDiscordConnectStatus, 'list_squadMembers'), beforeDiscordConnectFullReads.squadMembers);
    assert.equal(queryCount(afterDiscordConnectStatus, 'list_wipeParticipants'), beforeDiscordConnectFullReads.wipeParticipants);
    assert.equal(queryCount(afterDiscordConnectStatus, 'get_wipes') > beforeDiscordConnectWipeGets, true);

    const beforeDiscordSignupStatus = await storeModule.storeRuntimeStatus({ sqliteSummary: false });
    const beforeDiscordSignupFullReads = {
      wipes: queryCount(beforeDiscordSignupStatus, 'list_wipes'),
      members: queryCount(beforeDiscordSignupStatus, 'list_members'),
      squads: queryCount(beforeDiscordSignupStatus, 'list_squads'),
      squadMembers: queryCount(beforeDiscordSignupStatus, 'list_squadMembers'),
      wipeParticipants: queryCount(beforeDiscordSignupStatus, 'list_wipeParticipants')
    };
	    const beforeDiscordSignupWipeGets = queryCount(beforeDiscordSignupStatus, 'get_wipes');
		    const beforeDiscordSignupMembersById = queryCount(beforeDiscordSignupStatus, 'list_members_id');
	    const beforeDiscordSignupMembersWithSteam = queryCount(beforeDiscordSignupStatus, 'list_members_steamId_present');
		    const beforeDiscordSignupSquadsById = queryCount(beforeDiscordSignupStatus, 'list_squads_id');
    const signupResponse = await postDiscordInteraction({
      ...discordInteractionBase,
      token: 'sqlite_interaction_wipe_signup',
      channel_id: '123456789012349990',
      guild_id: '123456789012349989',
      message: {
        id: '123456789012349991',
        channel_id: '123456789012349990'
      },
      data: { custom_id: 'nb_wipe_signup:join_8h:wipe_sqlite_query_current' }
    });
    assert.equal(signupResponse.status, 200);
    const signupPayload = await signupResponse.json();
    assert.equal(signupPayload.type, 6);
    const signupParticipant = await waitForSqliteRecord(
      repositoryModule,
      'wipeParticipants',
      'wipe_participant_sqlite_query_target',
      (record) => record.status === 'join_8h' && record.source === 'discord' && record.sourceUserId === discordUserId,
      'discord wipe signup participant direct patch'
    );
    assert.equal(signupParticipant.squadId, 'squad_sqlite_query');
    const signupAttendance = await waitForSqliteCollectionMatch(
      repositoryModule,
      'discordAttendanceResponses',
      (record) => record.wipeId === 'wipe_sqlite_query_current' && record.discordUserId === discordUserId && record.status === 'join_8h',
      'discord wipe signup attendance response'
    );
    assert.equal(signupAttendance.displayName, 'SQLite Query Target');
    await waitForSqliteCollectionMatch(
      repositoryModule,
      'logs',
      (log) => log.type === 'discord_wipe_signup' && log.targetId === 'wipe_sqlite_query_current' && log.metadata?.status === 'join_8h',
      'discord wipe signup log'
    );
    for (let attempt = 0; attempt < 80; attempt += 1) {
      if (
        discordMessageEdits.some((edit) => edit.messageId === '123456789012349991') &&
        discordFollowups.some((followup) => followup.token === 'sqlite_interaction_wipe_signup')
      ) {
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    assert.equal(discordMessageEdits.some((edit) => edit.messageId === '123456789012349991'), true);
    assert.equal(discordFollowups.some((followup) => followup.token === 'sqlite_interaction_wipe_signup'), true);
    const afterDiscordSignupStatus = await storeModule.storeRuntimeStatus({ sqliteSummary: false });
    assert.equal(afterDiscordSignupStatus.metrics.writes.total, beforeDiscordSignupStatus.metrics.writes.total);
    assert.equal(afterDiscordSignupStatus.metrics.sqliteWrites, beforeDiscordSignupStatus.metrics.sqliteWrites);
	    assert.equal(queryCount(afterDiscordSignupStatus, 'list_wipes'), beforeDiscordSignupFullReads.wipes);
	    assert.equal(queryCount(afterDiscordSignupStatus, 'list_members'), beforeDiscordSignupFullReads.members);
	    assert.equal(queryCount(afterDiscordSignupStatus, 'list_squads'), beforeDiscordSignupFullReads.squads);
	    assert.equal(queryCount(afterDiscordSignupStatus, 'list_squadMembers'), beforeDiscordSignupFullReads.squadMembers);
	    assert.equal(queryCount(afterDiscordSignupStatus, 'list_wipeParticipants'), beforeDiscordSignupFullReads.wipeParticipants);
	    assert.equal(queryCount(afterDiscordSignupStatus, 'get_wipes') > beforeDiscordSignupWipeGets, true);
		    assert.equal(queryCount(afterDiscordSignupStatus, 'list_members_id') > beforeDiscordSignupMembersById, true);
	    assert.equal(queryCount(afterDiscordSignupStatus, 'list_members_steamId_present') > beforeDiscordSignupMembersWithSteam, true);
		    assert.equal(queryCount(afterDiscordSignupStatus, 'list_squads_id') > beforeDiscordSignupSquadsById, true);
    assert.equal(queryCount(afterDiscordSignupStatus, 'list_members_discordId') > queryCount(beforeDiscordSignupStatus, 'list_members_discordId'), true);
    assert.equal(queryCount(afterDiscordSignupStatus, 'find_members_discordId') > queryCount(beforeDiscordSignupStatus, 'find_members_discordId'), true);
    assert.equal(queryCount(afterDiscordSignupStatus, 'list_squadMembers_memberId') > queryCount(beforeDiscordSignupStatus, 'list_squadMembers_memberId'), true);
    const beforeScopedParticipantReads = queryCount(beforeDiscordSignupStatus, 'list_wipeParticipants_memberId') + queryCount(beforeDiscordSignupStatus, 'list_wipeParticipants_wipeId');
    const afterScopedParticipantReads = queryCount(afterDiscordSignupStatus, 'list_wipeParticipants_memberId') + queryCount(afterDiscordSignupStatus, 'list_wipeParticipants_wipeId');
    assert.equal(afterScopedParticipantReads > beforeScopedParticipantReads, true);

    const beforeDiscordSignupFailureStatus = await storeModule.storeRuntimeStatus({ sqliteSummary: false });
    const beforeDiscordSignupFailureFullReads = queryCount(beforeDiscordSignupFailureStatus, 'read_store_full');
    repositoryModule.injectSqliteStorePatchFailureForTests('discord_wipe_signup', 1);
    const failedSignupResponse = await postDiscordInteraction({
      ...discordInteractionBase,
      token: 'sqlite_interaction_wipe_signup_patch_failure',
      channel_id: '123456789012349990',
      guild_id: '123456789012349989',
      message: {
        id: '123456789012349991',
        channel_id: '123456789012349990'
      },
      data: { custom_id: 'nb_wipe_signup:join_16h:wipe_sqlite_query_current' }
    });
    assert.equal(failedSignupResponse.status, 200);
    const failedSignupPayload = await failedSignupResponse.json();
    assert.equal(failedSignupPayload.type, 6);
    for (let attempt = 0; attempt < 80; attempt += 1) {
      if (discordFollowups.some((followup) => followup.token === 'sqlite_interaction_wipe_signup_patch_failure')) break;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    const failedSignupFollowup = discordFollowups.find((followup) => followup.token === 'sqlite_interaction_wipe_signup_patch_failure');
    assert.equal(Boolean(failedSignupFollowup), true);
    assert.match(failedSignupFollowup.body.content, /Discord 报名写入暂不可用/);
    const afterDiscordSignupFailureStatus = await storeModule.storeRuntimeStatus({ sqliteSummary: false });
    assert.equal(queryCount(afterDiscordSignupFailureStatus, 'read_store_full'), beforeDiscordSignupFailureFullReads);
    const failedSignupParticipant = await repositoryModule.getSqliteRecord('wipeParticipants', 'wipe_participant_sqlite_query_target');
    assert.equal(failedSignupParticipant.status, 'join_8h');

    const beforeDiscordRefreshStatus = await storeModule.storeRuntimeStatus({ sqliteSummary: false });
    const beforeDiscordRefreshListUploads = queryCount(beforeDiscordRefreshStatus, 'list_uploads');
    const beforeDiscordRefreshWipesByStatus = queryCount(beforeDiscordRefreshStatus, 'list_wipes_status');
    const beforeDiscordRefreshParticipantsByWipe = queryCount(beforeDiscordRefreshStatus, 'list_wipeParticipants_wipeId');
	    const beforeDiscordRefreshMembersById = queryCount(beforeDiscordRefreshStatus, 'list_members_id');
    const beforeDiscordRefreshSquadMembersByMember = queryCount(beforeDiscordRefreshStatus, 'list_squadMembers_memberId');
    const beforeDiscordRefreshListSquads = queryCount(beforeDiscordRefreshStatus, 'list_squads');
	    const beforeDiscordRefreshSquadsById = queryCount(beforeDiscordRefreshStatus, 'list_squads_id');
    const beforeDiscordRefreshEditCount = discordMessageEdits.length;
    const refreshResponse = await httpFetch(`${baseUrl}/wipes/wipe_sqlite_query_current/participants/member_sqlite_query_target`, {
      method: 'PUT',
      headers: { cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ status: 'join_16h' })
    });
    assert.equal(refreshResponse.status, 200);
    await new Promise((resolve) => setTimeout(resolve, 25));
    await apiModule.drainBackgroundTaskQueuesForTests({ timeoutMs: 2000 });
    for (let attempt = 0; attempt < 80; attempt += 1) {
      if (discordMessageEdits.length > beforeDiscordRefreshEditCount) break;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    assert.equal(discordMessageEdits.length > beforeDiscordRefreshEditCount, true);
    const refreshedParticipant = await repositoryModule.getSqliteRecord('wipeParticipants', 'wipe_participant_sqlite_query_target');
    assert.equal(refreshedParticipant.status, 'join_16h');
    const afterDiscordRefreshStatus = await storeModule.storeRuntimeStatus({ sqliteSummary: false });
    assert.equal(queryCount(afterDiscordRefreshStatus, 'list_uploads'), beforeDiscordRefreshListUploads);
    assert.equal(queryCount(afterDiscordRefreshStatus, 'list_wipes_status') > beforeDiscordRefreshWipesByStatus, true);
    assert.equal(queryCount(afterDiscordRefreshStatus, 'list_wipeParticipants_wipeId') > beforeDiscordRefreshParticipantsByWipe, true);
	    assert.equal(queryCount(afterDiscordRefreshStatus, 'list_members_id') > beforeDiscordRefreshMembersById, true);
    assert.equal(queryCount(afterDiscordRefreshStatus, 'list_squadMembers_memberId') > beforeDiscordRefreshSquadMembersByMember, true);
    assert.equal(queryCount(afterDiscordRefreshStatus, 'list_squads'), beforeDiscordRefreshListSquads);
	    assert.equal(queryCount(afterDiscordRefreshStatus, 'list_squads_id') > beforeDiscordRefreshSquadsById, true);

    const beforeReminderStatus = await storeModule.storeRuntimeStatus({ sqliteSummary: false });
    const beforeDiscordVipReminderSuccessWrite = writeCount(beforeReminderStatus, 'discord_vital_vip_reminder_success');
    const beforeDiscordVipReminderFailureWrite = writeCount(beforeReminderStatus, 'discord_vital_vip_reminder_failure');
    const beforeDiscordVipReminderLogTrimWrite = writeCount(beforeReminderStatus, 'discord_vital_vip_reminder_log_trim');
    const beforeDiscordVipReminderReads = {
      members: queryCount(beforeReminderStatus, 'list_members'),
      membersByVipType: queryCount(beforeReminderStatus, 'list_members_vitalVipType'),
      discordMemberApplications: queryCount(beforeReminderStatus, 'list_discordMemberApplications'),
      discordMemberApplicationsByUser: queryCount(beforeReminderStatus, 'list_discordMemberApplications_discordUserId')
    };
    const reminderResult = await apiModule.sendDueDiscordVitalVipReminders({
      nowMs: Date.parse('2026-07-27T08:00:00.000Z'),
      silent: true
    });
    assert.equal(reminderResult.sent, 1);
    assert.equal(discordDirectMessages.length, 1);
    assert.equal(discordDirectMessages[0].channelId, `dm_${discordUserId}`);
    assert.equal(discordDirectMessages[0].authorization, 'Bot sqlite-discord-reminder-token');
    assert.equal(discordDirectMessages[0].body.components[0].components[0].custom_id, 'nb_vital_vip:open');
    const remindedMember = await repositoryModule.getSqliteRecord('members', 'member_sqlite_query_target');
    const failedReminderMember = await repositoryModule.getSqliteRecord('members', 'member_sqlite_query_reminder_failure');
    logs = await repositoryModule.getSqliteCollection('logs', { limit: 0 });
    const afterReminderStatus = await storeModule.storeRuntimeStatus({ sqliteSummary: false });
    assert.equal(remindedMember.vitalVipReminderExpiresAt, '2026-07-29');
    assert.equal(Boolean(remindedMember.vitalVipReminderSentAt), true);
    assert.equal(remindedMember.vitalVipReminderError, '');
    assert.match(failedReminderMember.vitalVipReminderError, /forced sqlite reminder failure/);
    assert.equal(logs.some((log) => log.type === 'discord_vital_vip_expiry_reminder' && log.targetId === 'member_sqlite_query_target'), true);
    const reminderSuccessRun = await waitForSqliteOperationRun(repositoryModule, (run) => (
      run.type === 'discord_vital_vip_reminder' &&
      run.status === 'succeeded' &&
      run.targetId === 'member_sqlite_query_target' &&
      run.messageId === 'direct_sqlite_1'
    ), 'Discord VIP reminder success run');
    const reminderFailureRun = await waitForSqliteOperationRun(repositoryModule, (run) => (
      run.type === 'discord_vital_vip_reminder' &&
      run.status === 'failed' &&
      run.targetId === 'member_sqlite_query_reminder_failure' &&
      run.metadata?.externalActionSucceeded === 'false'
    ), 'Discord VIP reminder failure run');
    assert.equal(reminderSuccessRun.channelId, `dm_${discordUserId}`);
    assert.equal(reminderSuccessRun.metadata.externalActionSucceeded, undefined);
    assert.equal(reminderSuccessRun.metadata.expiresAt, '2026-07-29');
    assert.equal(reminderFailureRun.retryable, true);
    assert.match(reminderFailureRun.errorSummary, /forced sqlite reminder failure/);
	    assert.equal(afterReminderStatus.metrics.writes.total, beforeReminderStatus.metrics.writes.total);
	    assert.equal(afterReminderStatus.metrics.sqliteWrites, beforeReminderStatus.metrics.sqliteWrites);
    assert.equal(queryCount(afterReminderStatus, 'list_members'), beforeDiscordVipReminderReads.members);
    assert.equal(queryCount(afterReminderStatus, 'list_discordMemberApplications'), beforeDiscordVipReminderReads.discordMemberApplications);
    assert.equal(queryCount(afterReminderStatus, 'list_members_vitalVipType') > beforeDiscordVipReminderReads.membersByVipType, true);
    assert.equal(
      queryCount(afterReminderStatus, 'list_discordMemberApplications_discordUserId') >
        beforeDiscordVipReminderReads.discordMemberApplicationsByUser,
      true
    );
    assert.equal(writeCount(afterReminderStatus, 'discord_vital_vip_reminder_success'), beforeDiscordVipReminderSuccessWrite + 1);
    assert.equal(writeCount(afterReminderStatus, 'discord_vital_vip_reminder_failure'), beforeDiscordVipReminderFailureWrite + 1);
    assert.equal(writeCount(afterReminderStatus, 'discord_vital_vip_reminder_log_trim'), beforeDiscordVipReminderLogTrimWrite);

    const successWriteFailureMember = {
      id: 'member_sqlite_query_reminder_success_write_failure',
      steamId: '76561198001999889',
      rawInput: '76561198001999889',
      customName: 'SQLite Reminder Success Write Failure',
      steamNickname: 'SQLite Reminder Success Write Failure',
      avatar: 'https://example.com/query-reminder-success-write-failure.png',
      discordId: '123456789012349995',
      wechatId: '',
      wechatUserId: '',
      notes: '',
      specialty: ['PVP'],
      vitalVipType: 'priority',
      vitalVipPurchasedAt: '2026-07-01',
      vitalVipExpiresAt: '2026-07-29',
      vitalVipReminderExpiresAt: '',
      vitalVipReminderSentAt: '',
      vitalVipReminderError: '',
      memberStatus: 'active',
      invitedByUserId: '',
      createdAt,
      updatedAt: createdAt
    };
    await repositoryModule.writeSqliteStorePatch({
      reason: 'sqlite_test_discord_vip_reminder_write_failure_seed',
      upserts: {
        members: [{
          ...failedReminderMember,
          vitalVipReminderExpiresAt: '2026-07-29'
        }, successWriteFailureMember]
      }
    });
    const beforeSuccessWriteFailureMessages = discordDirectMessages.length;
    const beforeSuccessWriteFailureStatus = await storeModule.storeRuntimeStatus({ sqliteSummary: false });
    repositoryModule.injectSqliteStorePatchFailureForTests('discord_vital_vip_reminder_success', 1);
    const successWriteFailureResult = await apiModule.sendDueDiscordVitalVipReminders({
      nowMs: Date.parse('2026-07-27T08:00:00.000Z'),
      silent: true
    });
    const afterSuccessWriteFailureStatus = await storeModule.storeRuntimeStatus({ sqliteSummary: false });
    const successWriteFailureRecord = await repositoryModule.getSqliteRecord('members', successWriteFailureMember.id);
    logs = await repositoryModule.getSqliteCollection('logs', { limit: 0 });
    assert.equal(successWriteFailureResult.sent, 1);
    assert.equal(discordDirectMessages.length, beforeSuccessWriteFailureMessages + 1);
    const successWriteFailureRun = await waitForSqliteOperationRun(repositoryModule, (run) => (
      run.type === 'discord_vital_vip_reminder' &&
      run.status === 'failed' &&
      run.targetId === successWriteFailureMember.id &&
      run.metadata?.externalActionSucceeded === 'true' &&
      run.metadata?.trackingWriteFailed === 'true'
    ), 'Discord VIP reminder success tracking failure run');
	    assert.equal(queryCount(afterSuccessWriteFailureStatus, 'read_store_full'), queryCount(beforeSuccessWriteFailureStatus, 'read_store_full'));
	    assert.equal(afterSuccessWriteFailureStatus.metrics.writes.total, beforeSuccessWriteFailureStatus.metrics.writes.total);
	    assert.equal(afterSuccessWriteFailureStatus.metrics.sqliteWrites, beforeSuccessWriteFailureStatus.metrics.sqliteWrites);
	    assert.equal(storeWriteCount(afterSuccessWriteFailureStatus, 'write_store_sqlite_patch'), storeWriteCount(beforeSuccessWriteFailureStatus, 'write_store_sqlite_patch'));
	    assert.equal(writeCount(afterSuccessWriteFailureStatus, 'discord_vital_vip_reminder_success'), writeCount(beforeSuccessWriteFailureStatus, 'discord_vital_vip_reminder_success'));
	    assert.equal(successWriteFailureRecord.vitalVipReminderExpiresAt, '');
    assert.equal(successWriteFailureRecord.vitalVipReminderSentAt, '');
    assert.equal(successWriteFailureRecord.vitalVipReminderError, '');
    assert.equal(logs.some((log) => log.type === 'discord_vital_vip_expiry_reminder' && log.targetId === successWriteFailureMember.id), false);
    assert.equal(successWriteFailureRun.messageId, `direct_sqlite_${discordDirectMessages.length}`);
    assert.equal(successWriteFailureRun.channelId, `dm_${successWriteFailureMember.discordId}`);
    assert.equal(successWriteFailureRun.retryable, true);
    assert.equal(successWriteFailureRun.metadata.discordUserId, successWriteFailureMember.discordId);
    assert.equal(successWriteFailureRun.metadata.expiresAt, '2026-07-29');
    assert.match(successWriteFailureRun.metadata.trackingWriteError, /Injected sqlite patch failure for discord_vital_vip_reminder_success/);

    const failureWriteFailureMember = {
      id: 'member_sqlite_query_reminder_failure_write_failure',
      steamId: '76561198001999888',
      rawInput: '76561198001999888',
      customName: 'SQLite Reminder Failure Write Failure',
      steamNickname: 'SQLite Reminder Failure Write Failure',
      avatar: 'https://example.com/query-reminder-failure-write-failure.png',
      discordId: failingWriteDiscordUserId,
      wechatId: '',
      wechatUserId: '',
      notes: '',
      specialty: ['Builder'],
      vitalVipType: 'priority',
      vitalVipPurchasedAt: '2026-07-01',
      vitalVipExpiresAt: '2026-07-29',
      vitalVipReminderExpiresAt: '',
      vitalVipReminderSentAt: '',
      vitalVipReminderError: '',
      memberStatus: 'active',
      invitedByUserId: '',
      createdAt,
      updatedAt: createdAt
    };
    await repositoryModule.writeSqliteStorePatch({
      reason: 'sqlite_test_discord_vip_reminder_failure_write_failure_seed',
      upserts: {
        members: [{
          ...successWriteFailureRecord,
          vitalVipReminderExpiresAt: '2026-07-29'
        }, failureWriteFailureMember]
      }
    });
    const beforeFailureWriteFailureMessages = discordDirectMessages.length;
    const beforeFailureWriteFailureStatus = await storeModule.storeRuntimeStatus({ sqliteSummary: false });
    repositoryModule.injectSqliteStorePatchFailureForTests('discord_vital_vip_reminder_failure', 1);
    const failureWriteFailureResult = await apiModule.sendDueDiscordVitalVipReminders({
      nowMs: Date.parse('2026-07-27T08:00:00.000Z'),
      silent: true
    });
    const afterFailureWriteFailureStatus = await storeModule.storeRuntimeStatus({ sqliteSummary: false });
    const failureWriteFailureRecord = await repositoryModule.getSqliteRecord('members', failureWriteFailureMember.id);
    assert.equal(failureWriteFailureResult.sent, 0);
    assert.equal(discordDirectMessages.length, beforeFailureWriteFailureMessages);
	    assert.equal(queryCount(afterFailureWriteFailureStatus, 'read_store_full'), queryCount(beforeFailureWriteFailureStatus, 'read_store_full'));
	    assert.equal(afterFailureWriteFailureStatus.metrics.writes.total, beforeFailureWriteFailureStatus.metrics.writes.total);
	    assert.equal(afterFailureWriteFailureStatus.metrics.sqliteWrites, beforeFailureWriteFailureStatus.metrics.sqliteWrites);
	    assert.equal(storeWriteCount(afterFailureWriteFailureStatus, 'write_store_sqlite_patch'), storeWriteCount(beforeFailureWriteFailureStatus, 'write_store_sqlite_patch'));
	    assert.equal(writeCount(afterFailureWriteFailureStatus, 'discord_vital_vip_reminder_failure'), writeCount(beforeFailureWriteFailureStatus, 'discord_vital_vip_reminder_failure'));
    assert.equal(failureWriteFailureRecord.vitalVipReminderExpiresAt, '');
    assert.equal(failureWriteFailureRecord.vitalVipReminderSentAt, '');
    assert.equal(failureWriteFailureRecord.vitalVipReminderError, '');

    const operationRunUnavailableMember = {
      id: 'member_sqlite_query_reminder_operation_run_unavailable',
      steamId: '76561198001999887',
      rawInput: '76561198001999887',
      customName: 'SQLite Reminder Operation Run Unavailable',
      steamNickname: 'SQLite Reminder Operation Run Unavailable',
      avatar: 'https://example.com/query-reminder-operation-run-unavailable.png',
      discordId: '123456789012349996',
      wechatId: '',
      wechatUserId: '',
      notes: '',
      specialty: ['PVP'],
      vitalVipType: 'priority',
      vitalVipPurchasedAt: '2026-07-01',
      vitalVipExpiresAt: '2026-07-29',
      vitalVipReminderExpiresAt: '',
      vitalVipReminderSentAt: '',
      vitalVipReminderError: '',
      memberStatus: 'active',
      invitedByUserId: '',
      createdAt,
      updatedAt: createdAt
    };
    await repositoryModule.writeSqliteStorePatch({
      reason: 'sqlite_test_discord_vip_reminder_operation_run_unavailable_seed',
      upserts: {
        members: [{
          ...successWriteFailureRecord,
          vitalVipReminderExpiresAt: '2026-07-29'
        }, {
          ...failureWriteFailureRecord,
          vitalVipReminderExpiresAt: '2026-07-29'
        }, operationRunUnavailableMember]
      }
    });
    const beforeOperationRunUnavailableMessages = discordDirectMessages.length;
    const beforeOperationRunUnavailableStatus = await storeModule.storeRuntimeStatus({ sqliteSummary: false });
    repositoryModule.injectSqliteStorePatchFailureForTests('operation_run_create', 2);
    const operationRunUnavailableResult = await apiModule.sendDueDiscordVitalVipReminders({
      nowMs: Date.parse('2026-07-27T08:00:00.000Z'),
      silent: true
    });
    const afterOperationRunUnavailableStatus = await storeModule.storeRuntimeStatus({ sqliteSummary: false });
    const operationRunUnavailableRecord = await repositoryModule.getSqliteRecord('members', operationRunUnavailableMember.id);
    const operationRunUnavailableRuns = await repositoryModule.getSqliteCollection('operationRuns', { limit: 0 });
    assert.equal(operationRunUnavailableResult.sent, 0);
    assert.equal(discordDirectMessages.length, beforeOperationRunUnavailableMessages);
    assert.equal(operationRunUnavailableRecord.vitalVipReminderExpiresAt, '');
    assert.equal(operationRunUnavailableRecord.vitalVipReminderSentAt, '');
    assert.equal(operationRunUnavailableRecord.vitalVipReminderError, '');
    assert.equal(operationRunUnavailableRuns.some((run) => (
      run.type === 'discord_vital_vip_reminder' &&
      run.targetId === operationRunUnavailableMember.id
    )), false);
    assert.equal(queryCount(afterOperationRunUnavailableStatus, 'read_store_full'), queryCount(beforeOperationRunUnavailableStatus, 'read_store_full'));
    assert.equal(afterOperationRunUnavailableStatus.metrics.writes.total, beforeOperationRunUnavailableStatus.metrics.writes.total);
    assert.equal(afterOperationRunUnavailableStatus.metrics.sqliteWrites, beforeOperationRunUnavailableStatus.metrics.sqliteWrites);
    assert.equal(storeWriteCount(afterOperationRunUnavailableStatus, 'write_store_sqlite_patch'), storeWriteCount(beforeOperationRunUnavailableStatus, 'write_store_sqlite_patch'));

	    globalThis.fetch = async (url, options = {}) => {
	      const href = String(url?.href || url || '');
	      if (href === `https://rust-kda.anlonely.me/api/player/${targetSteamId}`) {
	        return new Response(JSON.stringify({
	          name: 'SQLite Query Target Official',
	          avatar: 'https://example.com/query-target-official.png',
	          profileUrl: `https://steamcommunity.com/profiles/${targetSteamId}`,
	          playTimeHours: 99.5
	        }), { status: 200, headers: { 'content-type': 'application/json' } });
	      }
	      if (href === `https://rust-kda.anlonely.me/api/kda/${targetSteamId}`) {
	        return new Response(JSON.stringify({
	          kills: 31,
	          deaths: 10,
	          assists: 2,
	          headshot: 9,
	          bullet_fired: 200,
	          bullet_hit_player: 80,
	          rocket_fired: 6,
	          resources: { sulfurOre: 1800, metalOre: 600 }
	        }), { status: 200, headers: { 'content-type': 'application/json' } });
	      }
	      if (href === `https://steamcommunity.com/profiles/${targetSteamId}?xml=1`) {
	        return new Response([
	          '<profile>',
	          `<steamID64>${targetSteamId}</steamID64>`,
	          '<steamID>SQLite Query Target Official</steamID>',
	          '<privacyState>public</privacyState>',
	          '<visibilityState>3</visibilityState>',
	          '<avatarFull>https://example.com/query-target-official-steam.png</avatarFull>',
	          '</profile>'
	        ].join(''), { status: 200, headers: { 'content-type': 'text/xml' } });
	      }
	      return originalFetch(url, options);
	    };
	    try {
	      const beforeOfficialKdaFailureStatus = await storeModule.storeRuntimeStatus({ sqliteSummary: false });
	      const beforeOfficialKdaFailureStat = await stat(storeModule.STORE_FILE);
	      repositoryModule.injectSqliteStorePatchFailureForTests('official_kda_query_cache', 1);
	      const cacheFailureResponse = await httpFetch(`${baseUrl}/rust-kda/official?steamInput=${targetSteamId}`, {
	        headers: { cookie }
	      });
	      assert.equal(cacheFailureResponse.status, 200);
	      const cacheFailurePayload = await cacheFailureResponse.json();
	      assert.equal(cacheFailurePayload.kda.kills, 31);
	      assert.equal(cacheFailurePayload.kda.rockets, 6);
	      const cacheFailureProfiles = await repositoryModule.getSqliteRecordsByJsonField(
	        'memberProfiles',
	        'memberId',
	        ['member_sqlite_query_target'],
	        { limit: 0 }
	      );
	      const cacheFailureProfile = cacheFailureProfiles.find((profile) => profile.id === 'member_profile_sqlite_query_target');
	      const afterOfficialKdaFailureStatus = await storeModule.storeRuntimeStatus({ sqliteSummary: false });
	      const afterOfficialKdaFailureStat = await stat(storeModule.STORE_FILE);
	      assert.equal(cacheFailureProfile.officialKda, undefined);
	      assert.equal(afterOfficialKdaFailureStat.mtimeMs, beforeOfficialKdaFailureStat.mtimeMs);
	      assert.equal(afterOfficialKdaFailureStatus.metrics.writes.total, beforeOfficialKdaFailureStatus.metrics.writes.total);
	      assert.equal(afterOfficialKdaFailureStatus.metrics.sqliteWrites, beforeOfficialKdaFailureStatus.metrics.sqliteWrites);
	      assert.equal(queryCount(afterOfficialKdaFailureStatus, 'read_store_full'), queryCount(beforeOfficialKdaFailureStatus, 'read_store_full'));
	      assert.equal(writeCount(afterOfficialKdaFailureStatus, 'official_kda_query_cache'), writeCount(beforeOfficialKdaFailureStatus, 'official_kda_query_cache'));

	      const beforeOfficialKdaStatus = await storeModule.storeRuntimeStatus({ sqliteSummary: false });
	      const beforeOfficialKdaStat = await stat(storeModule.STORE_FILE);
	      const officialKdaResponse = await httpFetch(`${baseUrl}/rust-kda/official?steamInput=${targetSteamId}`, {
	        headers: { cookie }
	      });
	      assert.equal(officialKdaResponse.status, 200);
	      const officialKdaPayload = await officialKdaResponse.json();
	      assert.equal(officialKdaPayload.kda.kills, 31);
	      assert.equal(officialKdaPayload.kda.deaths, 10);
	      assert.equal(officialKdaPayload.kda.rockets, 6);
	      const officialKdaProfiles = await repositoryModule.getSqliteRecordsByJsonField(
	        'memberProfiles',
	        'memberId',
	        ['member_sqlite_query_target'],
	        { limit: 0 }
	      );
	      const officialKdaProfile = officialKdaProfiles.find((profile) => profile.id === 'member_profile_sqlite_query_target');
	      const afterOfficialKdaStatus = await storeModule.storeRuntimeStatus({ sqliteSummary: false });
	      const afterOfficialKdaStat = await stat(storeModule.STORE_FILE);
	      assert.equal(officialKdaProfile.officialKda.kills, 31);
	      assert.equal(officialKdaProfile.officialKda.rockets, 6);
	      assert.match(officialKdaProfile.officialKdaFetchedAt, /^\d{4}-\d{2}-\d{2}T/);
	      assert.equal(afterOfficialKdaStat.mtimeMs, beforeOfficialKdaStat.mtimeMs);
	      assert.equal(afterOfficialKdaStatus.metrics.writes.total, beforeOfficialKdaStatus.metrics.writes.total);
	      assert.equal(afterOfficialKdaStatus.metrics.sqliteWrites, beforeOfficialKdaStatus.metrics.sqliteWrites);
	    } finally {
	      globalThis.fetch = originalFetch;
	    }
	  } finally {
    if (server) await new Promise((resolve) => server.close(resolve));
    if (discordServer) await new Promise((resolve) => discordServer.close(resolve));
    globalThis.fetch = originalFetch;
    const sqliteModule = await import('../server/storage/sqlite.js');
    await sqliteModule.closeSqliteDatabasesForTests();
    Object.assign(process.env, previousEnv);
    for (const [key, value] of Object.entries(previousEnv)) {
      if (value === undefined) delete process.env[key];
    }
    await rm(dataDir, { recursive: true, force: true });
  }
});

test('sqlite-primary wechat admin member field updates use direct SQLite patch writes', async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'nb-clan-sqlite-wechat-admin-member-'));
  const previousEnv = {
    NB_DATA_DIR: process.env.NB_DATA_DIR,
    NB_ROOT_PASSWORD: process.env.NB_ROOT_PASSWORD,
    NB_STORAGE_MODE: process.env.NB_STORAGE_MODE,
    NB_SQLITE_FILE: process.env.NB_SQLITE_FILE,
    NB_DISABLE_BACKGROUND_JOBS: process.env.NB_DISABLE_BACKGROUND_JOBS,
    NB_DISABLE_EXTERNAL_VITAL: process.env.NB_DISABLE_EXTERNAL_VITAL,
    NB_RUSTPLUS_RELAY_CHAT_FLUSH_INTERVAL_MS: process.env.NB_RUSTPLUS_RELAY_CHAT_FLUSH_INTERVAL_MS
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

  let server = null;
  try {
    const storeModule = await uniqueImport('../server/store.js');
    const apiModule = await uniqueImport('../server/api.js');
    const authModule = await uniqueImport('../server/auth.js');
    await storeModule.ensureStore();
    const createdAt = '2026-07-02T00:00:00.000Z';
    await storeModule.updateStore((store) => {
      store.members.push({
        id: 'member_sqlite_wechat_admin_update',
        steamId: '76561198002222222',
        rawInput: '76561198002222222',
        customName: 'SQLite Wechat Admin Update',
        steamNickname: 'SQLite Wechat Admin Update',
        avatar: '',
        discordId: '1198660515644330016',
        discordName: 'SQLite Discord User',
        discordAvatarHash: 'avatar_hash_sqlite_wechat_admin',
        discordAvatarUrl: 'https://cdn.discordapp.com/avatar.png',
        wechatId: 'wechat_sqlite_wechat_admin_update',
        wechatUserId: 'wechat_sqlite_wechat_admin_update',
        notes: '',
        specialty: ['pvp'],
        specialties: ['pvp'],
        memberStatus: 'active',
        invitedByUserId: '',
        createdAt,
        updatedAt: createdAt
      }, {
        id: 'member_sqlite_wechat_delete',
        steamId: '76561198003333333',
        rawInput: '76561198003333333',
        customName: 'SQLite Wechat Delete',
        steamNickname: 'SQLite Wechat Delete',
        avatar: '',
        discordId: '',
        discordName: '',
        wechatId: 'wechat_sqlite_wechat_delete',
        wechatUserId: 'wechat_sqlite_wechat_delete',
        notes: '',
        specialty: [],
        specialties: [],
        memberStatus: 'active',
        invitedByUserId: '',
        createdAt,
        updatedAt: createdAt
      });
      store.wechatUsers.push({
        id: 'wechat_sqlite_wechat_admin_update',
        openid: 'openid_sqlite_wechat_admin_update',
        nickname: 'SQLite Linked Wechat',
        avatarUrl: '',
        status: 'approved',
        role: 'member',
        memberId: 'member_sqlite_wechat_admin_update',
        phone: '',
        wechatId: '',
        discordId: '',
        region: '',
        timeZone: '',
        createdAt,
        updatedAt: createdAt,
        lastLoginAt: createdAt
      }, {
        id: 'wechat_sqlite_wechat_delete',
        openid: 'openid_sqlite_wechat_delete',
        nickname: 'SQLite Delete Wechat',
        avatarUrl: '',
        status: 'approved',
        role: 'member',
        memberId: 'member_sqlite_wechat_delete',
        phone: '',
        wechatId: '',
        discordId: '',
        region: '',
        timeZone: '',
        createdAt,
        updatedAt: createdAt,
        lastLoginAt: createdAt
      });
      store.squads.push({
        id: 'squad_sqlite_wechat_old',
        name: 'SQLite Wechat Old Squad',
        description: '',
        leaderUserIds: [],
        createdAt,
        updatedAt: createdAt
      }, {
        id: 'squad_sqlite_wechat_new',
        name: 'SQLite Wechat New Squad',
        description: '',
        leaderUserIds: [],
        createdAt,
        updatedAt: createdAt
      });
      store.squadMembers.push({
        id: 'squad_member_sqlite_wechat_admin_old',
        squadId: 'squad_sqlite_wechat_old',
        memberId: 'member_sqlite_wechat_admin_update',
        addedByUserId: 'root',
        createdAt
      }, {
        id: 'squad_member_sqlite_wechat_delete',
        squadId: 'squad_sqlite_wechat_old',
        memberId: 'member_sqlite_wechat_delete',
        addedByUserId: 'root',
        createdAt
      });
      store.wipes.push({
        id: 'wipe_sqlite_wechat_live',
        name: 'SQLite Wechat Live Wipe',
        serverName: 'SQLite Wechat Live Server',
        status: 'active',
        startedAt: createdAt,
        closedAt: '',
        vitalServerId: 'server_sqlite_wechat_live',
        vitalWipeId: 'vital_wipe_sqlite_wechat_live',
        createdAt,
        updatedAt: createdAt
      }, {
        id: 'wipe_sqlite_wechat_closed',
        name: 'SQLite Wechat Closed Wipe',
        serverName: 'SQLite Wechat Closed Server',
        status: 'closed',
        startedAt: createdAt,
        closedAt: createdAt,
        vitalServerId: 'server_sqlite_wechat_closed',
        vitalWipeId: 'vital_wipe_sqlite_wechat_closed',
        createdAt,
        updatedAt: createdAt
      });
      store.wipeParticipants.push({
        id: 'participant_sqlite_wechat_live',
        wipeId: 'wipe_sqlite_wechat_live',
        memberId: 'member_sqlite_wechat_admin_update',
        squadId: 'squad_sqlite_wechat_old',
        status: 'on_time',
        createdAt,
        updatedAt: createdAt
      }, {
        id: 'participant_sqlite_wechat_closed',
        wipeId: 'wipe_sqlite_wechat_closed',
        memberId: 'member_sqlite_wechat_admin_update',
        squadId: 'squad_sqlite_wechat_old',
        status: 'on_time',
        createdAt,
        updatedAt: createdAt
      }, {
        id: 'participant_sqlite_wechat_delete_live',
        wipeId: 'wipe_sqlite_wechat_live',
        memberId: 'member_sqlite_wechat_delete',
        squadId: 'squad_sqlite_wechat_old',
        status: 'on_time',
        createdAt,
        updatedAt: createdAt
      }, {
        id: 'participant_sqlite_wechat_delete_closed',
        wipeId: 'wipe_sqlite_wechat_closed',
        memberId: 'member_sqlite_wechat_delete',
        squadId: 'squad_sqlite_wechat_old',
        status: 'on_time',
        createdAt,
        updatedAt: createdAt
      });
      store.kdaRows.push({
        id: 'kda_sqlite_wechat_live',
        wipeId: 'wipe_sqlite_wechat_live',
        memberId: 'member_sqlite_wechat_admin_update',
        steamId: '76561198002222222',
        squadId: 'squad_sqlite_wechat_old',
        kills: 3,
        deaths: 1,
        syncedAt: createdAt
      }, {
        id: 'kda_sqlite_wechat_closed',
        wipeId: 'wipe_sqlite_wechat_closed',
        memberId: 'member_sqlite_wechat_admin_update',
        steamId: '76561198002222222',
        squadId: 'squad_sqlite_wechat_old',
        kills: 6,
        deaths: 2,
        syncedAt: createdAt
      }, {
        id: 'kda_sqlite_wechat_delete_live',
        wipeId: 'wipe_sqlite_wechat_live',
        memberId: 'member_sqlite_wechat_delete',
        steamId: '',
        squadId: 'squad_sqlite_wechat_old',
        kills: 7,
        deaths: 3,
        syncedAt: createdAt
      }, {
        id: 'kda_sqlite_wechat_delete_steam_only_live',
        wipeId: 'wipe_sqlite_wechat_live',
        memberId: 'legacy_member_sqlite_wechat_delete',
        steamId: '76561198003333333',
        squadId: 'squad_sqlite_wechat_old',
        kills: 8,
        deaths: 3,
        syncedAt: createdAt
      }, {
        id: 'kda_sqlite_wechat_delete_closed',
        wipeId: 'wipe_sqlite_wechat_closed',
        memberId: 'member_sqlite_wechat_delete',
        steamId: '76561198003333333',
        squadId: 'squad_sqlite_wechat_old',
        kills: 9,
        deaths: 3,
        syncedAt: createdAt
      });
      store.kdaSnapshots.push({
        id: 'kda_snapshot_sqlite_wechat_live',
        wipeId: 'wipe_sqlite_wechat_live',
        memberId: 'member_sqlite_wechat_admin_update',
        steamId: '76561198002222222',
        squadId: 'squad_sqlite_wechat_old',
        kills: 3,
        deaths: 1,
        capturedAt: createdAt
      }, {
        id: 'kda_snapshot_sqlite_wechat_closed',
        wipeId: 'wipe_sqlite_wechat_closed',
        memberId: 'member_sqlite_wechat_admin_update',
        steamId: '76561198002222222',
        squadId: 'squad_sqlite_wechat_old',
        kills: 6,
        deaths: 2,
        capturedAt: createdAt
      }, {
        id: 'kda_snapshot_sqlite_wechat_delete_live',
        wipeId: 'wipe_sqlite_wechat_live',
        memberId: 'member_sqlite_wechat_delete',
        steamId: '76561198003333333',
        squadId: 'squad_sqlite_wechat_old',
        kills: 7,
        deaths: 3,
        capturedAt: createdAt
      }, {
        id: 'kda_snapshot_sqlite_wechat_delete_steam_only_live',
        wipeId: 'wipe_sqlite_wechat_live',
        memberId: 'legacy_member_sqlite_wechat_delete',
        steamId: '76561198003333333',
        squadId: 'squad_sqlite_wechat_old',
        kills: 8,
        deaths: 3,
        capturedAt: createdAt
      }, {
        id: 'kda_snapshot_sqlite_wechat_delete_closed',
        wipeId: 'wipe_sqlite_wechat_closed',
        memberId: 'member_sqlite_wechat_delete',
        steamId: '76561198003333333',
        squadId: 'squad_sqlite_wechat_old',
        kills: 9,
        deaths: 3,
        capturedAt: createdAt
      });
      store.memberProfiles.push({
        id: 'member_profile_sqlite_wechat_delete',
        memberId: 'member_sqlite_wechat_delete',
        steamId: '76561198003333333',
        fetchedAt: createdAt
      });
      store.accountAlertDismissals ||= [];
      store.accountAlertDismissals.push({
        id: 'alert_sqlite_wechat_delete',
        memberId: 'member_sqlite_wechat_delete',
        type: 'private-inventory',
        dismissedAt: createdAt,
        dismissedByUserId: 'user_root'
      });
      store.users.push({
        id: 'user_sqlite_wechat_delete_member',
        username: 'sqlite_delete_member',
        role: 'member',
        boundSteamId: '76561198003333333',
        createdAt,
        updatedAt: createdAt
      }, {
        id: 'user_sqlite_wechat_delete_manager',
        username: 'sqlite_delete_manager',
        role: 'member_manager',
        boundSteamId: '76561198003333333',
        createdAt,
        updatedAt: createdAt
      });
      store.sessions.push({
        id: 'session_sqlite_wechat_delete_member',
        userId: 'user_sqlite_wechat_delete_member',
        tokenHash: 'session_hash_sqlite_wechat_delete_member',
        createdAt,
        expiresAt: new Date(Date.now() + 86_400_000).toISOString()
      }, {
        id: 'session_sqlite_wechat_delete_manager',
        userId: 'user_sqlite_wechat_delete_manager',
        tokenHash: 'session_hash_sqlite_wechat_delete_manager',
        createdAt,
        expiresAt: new Date(Date.now() + 86_400_000).toISOString()
      });
    });

    const app = express();
    app.use('/api', apiModule.createApiRouter());
    server = createServer(app);
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const baseUrl = `http://127.0.0.1:${server.address().port}/api`;
    const sessionId = await authModule.createSession('user_root');
    const cookie = `nb_session=${encodeURIComponent(sessionId)}`;

    const repositoryModule = await import('../server/storage/repository.js');
    const queryCount = (status, name) => status.sqlite?.queries?.byName?.[name]?.total || 0;
    const writeCount = (status, name) => status.sqlite?.writes?.byName?.[name]?.total || 0;
    const beforeSpecialtyFailureStatus = await storeModule.storeRuntimeStatus({ sqliteSummary: false });
    const beforeSpecialtyFailureReadStoreFull = queryCount(beforeSpecialtyFailureStatus, 'read_store_full');
    repositoryModule.injectSqliteStorePatchFailureForTests('wechat_admin_member_specialty_update', 1);
    const failedSpecialtyResponse = await httpFetch(`${baseUrl}/wechat/admin/members/member_sqlite_wechat_admin_update/specialty`, {
      method: 'PUT',
      headers: {
        cookie,
        'content-type': 'application/json'
      },
      body: JSON.stringify({ specialty: 'building' })
    });
    const failedSpecialtyPayload = await failedSpecialtyResponse.json();
    assert.equal(failedSpecialtyResponse.status, 503);
    assert.match(failedSpecialtyPayload.error, /微信管理成员写入暂不可用/);
    const afterSpecialtyFailureStatus = await storeModule.storeRuntimeStatus({ sqliteSummary: false });
    assert.equal(queryCount(afterSpecialtyFailureStatus, 'read_store_full'), beforeSpecialtyFailureReadStoreFull);
    let failedSpecialtyMember = await repositoryModule.getSqliteRecord('members', 'member_sqlite_wechat_admin_update');
    assert.deepEqual(failedSpecialtyMember.specialty, ['pvp']);

    const beforeSpecialtyStatus = await storeModule.storeRuntimeStatus({ sqliteSummary: false });
    const beforeListMembers = queryCount(beforeSpecialtyStatus, 'list_members');
    const beforeSpecialtyWrite = writeCount(beforeSpecialtyStatus, 'wechat_admin_member_specialty_update');
    const beforeSpecialtyLogTrimWrite = writeCount(beforeSpecialtyStatus, 'wechat_admin_member_specialty_update_log_trim');
    const specialtyResponse = await httpFetch(`${baseUrl}/wechat/admin/members/member_sqlite_wechat_admin_update/specialty`, {
      method: 'PUT',
      headers: {
        cookie,
        'content-type': 'application/json'
      },
      body: JSON.stringify({ specialty: 'building' })
    });
    assert.equal(specialtyResponse.status, 200);
    const specialtyPayload = await specialtyResponse.json();
    assert.deepEqual(specialtyPayload.member.specialty, ['building']);
    let updatedMember = await repositoryModule.getSqliteRecord('members', 'member_sqlite_wechat_admin_update');
    let logs = await repositoryModule.getSqliteCollection('logs', { limit: 0 });
    const afterSpecialtyStatus = await storeModule.storeRuntimeStatus({ sqliteSummary: false });
    assert.deepEqual(updatedMember.specialty, ['building']);
    assert.deepEqual(updatedMember.specialties, ['building']);
    assert.equal(logs.some((log) => log.type === 'wechat_admin_member_specialty_update' && log.targetId === 'member_sqlite_wechat_admin_update'), true);
    assert.equal(afterSpecialtyStatus.metrics.writes.total, beforeSpecialtyStatus.metrics.writes.total);
    assert.equal(afterSpecialtyStatus.metrics.sqliteWrites, beforeSpecialtyStatus.metrics.sqliteWrites);
    assert.equal(queryCount(afterSpecialtyStatus, 'list_members'), beforeListMembers);
    assert.equal(writeCount(afterSpecialtyStatus, 'wechat_admin_member_specialty_update'), beforeSpecialtyWrite + 1);
    assert.equal(writeCount(afterSpecialtyStatus, 'wechat_admin_member_specialty_update_log_trim'), beforeSpecialtyLogTrimWrite);

    const beforeStatusStatus = await storeModule.storeRuntimeStatus({ sqliteSummary: false });
    const statusResponse = await httpFetch(`${baseUrl}/wechat/admin/members/member_sqlite_wechat_admin_update/status`, {
      method: 'PUT',
      headers: {
        cookie,
        'content-type': 'application/json'
      },
      body: JSON.stringify({ memberStatus: 'suspended' })
    });
    assert.equal(statusResponse.status, 200);
    const statusPayload = await statusResponse.json();
    assert.equal(statusPayload.member.memberStatus, 'suspended');
    assert.equal(statusPayload.accessStatus.canEnterApp, false);
    assert.equal(statusPayload.accessStatus.status, 'suspended');
    updatedMember = await repositoryModule.getSqliteRecord('members', 'member_sqlite_wechat_admin_update');
    logs = await repositoryModule.getSqliteCollection('logs', { limit: 0 });
    const afterStatusStatus = await storeModule.storeRuntimeStatus({ sqliteSummary: false });
    assert.equal(updatedMember.memberStatus, 'suspended');
    assert.equal(logs.some((log) => log.type === 'wechat_admin_member_status_update' && log.targetId === 'member_sqlite_wechat_admin_update'), true);
    assert.equal(afterStatusStatus.metrics.writes.total, beforeStatusStatus.metrics.writes.total);
    assert.equal(afterStatusStatus.metrics.sqliteWrites, beforeStatusStatus.metrics.sqliteWrites);
    assert.equal(queryCount(afterStatusStatus, 'list_members'), beforeListMembers);

    const beforeSquadStatus = await storeModule.storeRuntimeStatus({ sqliteSummary: false });
    const beforeSquadListMembers = queryCount(beforeSquadStatus, 'list_members');
    const squadResponse = await httpFetch(`${baseUrl}/wechat/admin/members/member_sqlite_wechat_admin_update/squad`, {
      method: 'PUT',
      headers: {
        cookie,
        'content-type': 'application/json'
      },
      body: JSON.stringify({ squadId: 'squad_sqlite_wechat_new' })
    });
    assert.equal(squadResponse.status, 200);
    const squadPayload = await squadResponse.json();
    assert.equal(squadPayload.member.squadName, 'SQLite Wechat New Squad');
    let squadMembers = await repositoryModule.getSqliteCollection('squadMembers', { limit: 0 });
    assert.equal(squadMembers.some((item) => item.id === 'squad_member_sqlite_wechat_admin_old'), false);
    assert.equal(squadMembers.some((item) => item.memberId === 'member_sqlite_wechat_admin_update' && item.squadId === 'squad_sqlite_wechat_new'), true);
    let liveParticipant = await repositoryModule.getSqliteRecord('wipeParticipants', 'participant_sqlite_wechat_live');
    let closedParticipant = await repositoryModule.getSqliteRecord('wipeParticipants', 'participant_sqlite_wechat_closed');
    let liveKda = await repositoryModule.getSqliteRecord('kdaRows', 'kda_sqlite_wechat_live');
    let closedKda = await repositoryModule.getSqliteRecord('kdaRows', 'kda_sqlite_wechat_closed');
    let liveSnapshot = await repositoryModule.getSqliteRecord('kdaSnapshots', 'kda_snapshot_sqlite_wechat_live');
    let closedSnapshot = await repositoryModule.getSqliteRecord('kdaSnapshots', 'kda_snapshot_sqlite_wechat_closed');
    logs = await repositoryModule.getSqliteCollection('logs', { limit: 0 });
    const afterSquadStatus = await storeModule.storeRuntimeStatus({ sqliteSummary: false });
    assert.equal(liveParticipant.squadId, 'squad_sqlite_wechat_new');
    assert.equal(liveKda.squadId, 'squad_sqlite_wechat_new');
    assert.equal(liveSnapshot.squadId, 'squad_sqlite_wechat_new');
    assert.equal(closedParticipant.squadId, 'squad_sqlite_wechat_old');
    assert.equal(closedKda.squadId, 'squad_sqlite_wechat_old');
    assert.equal(closedSnapshot.squadId, 'squad_sqlite_wechat_old');
    assert.equal(logs.some((log) => log.type === 'wechat_admin_member_squad_update' && log.targetId === 'member_sqlite_wechat_admin_update'), true);
    assert.equal(afterSquadStatus.metrics.writes.total, beforeSquadStatus.metrics.writes.total);
    assert.equal(afterSquadStatus.metrics.sqliteWrites, beforeSquadStatus.metrics.sqliteWrites);
    assert.equal(queryCount(afterSquadStatus, 'list_members'), beforeSquadListMembers);

    const beforeClearSquadStatus = await storeModule.storeRuntimeStatus({ sqliteSummary: false });
    const beforeClearSquadListMembers = queryCount(beforeClearSquadStatus, 'list_members');
    const clearSquadResponse = await httpFetch(`${baseUrl}/wechat/admin/members/member_sqlite_wechat_admin_update/squad`, {
      method: 'PUT',
      headers: {
        cookie,
        'content-type': 'application/json'
      },
      body: JSON.stringify({ squadId: '' })
    });
    assert.equal(clearSquadResponse.status, 200);
    const clearSquadPayload = await clearSquadResponse.json();
    assert.equal(clearSquadPayload.member.squad, '未分队');
    squadMembers = await repositoryModule.getSqliteCollection('squadMembers', { limit: 0 });
    assert.equal(squadMembers.some((item) => item.memberId === 'member_sqlite_wechat_admin_update'), false);
    liveParticipant = await repositoryModule.getSqliteRecord('wipeParticipants', 'participant_sqlite_wechat_live');
    closedParticipant = await repositoryModule.getSqliteRecord('wipeParticipants', 'participant_sqlite_wechat_closed');
    liveKda = await repositoryModule.getSqliteRecord('kdaRows', 'kda_sqlite_wechat_live');
    closedKda = await repositoryModule.getSqliteRecord('kdaRows', 'kda_sqlite_wechat_closed');
    liveSnapshot = await repositoryModule.getSqliteRecord('kdaSnapshots', 'kda_snapshot_sqlite_wechat_live');
    closedSnapshot = await repositoryModule.getSqliteRecord('kdaSnapshots', 'kda_snapshot_sqlite_wechat_closed');
    const afterClearSquadStatus = await storeModule.storeRuntimeStatus({ sqliteSummary: false });
    assert.equal(liveParticipant, null);
    assert.equal(liveKda, null);
    assert.equal(liveSnapshot, null);
    assert.equal(closedParticipant.squadId, 'squad_sqlite_wechat_old');
    assert.equal(closedKda.squadId, 'squad_sqlite_wechat_old');
    assert.equal(closedSnapshot.squadId, 'squad_sqlite_wechat_old');
    assert.equal(afterClearSquadStatus.metrics.writes.total, beforeClearSquadStatus.metrics.writes.total);
    assert.equal(afterClearSquadStatus.metrics.sqliteWrites, beforeClearSquadStatus.metrics.sqliteWrites);
    assert.equal(queryCount(afterClearSquadStatus, 'list_members'), beforeClearSquadListMembers);

    const beforeWechatUnbindStatus = await storeModule.storeRuntimeStatus({ sqliteSummary: false });
    const beforeWechatUnbindListMembers = queryCount(beforeWechatUnbindStatus, 'list_members');
    const wechatUnbindResponse = await httpFetch(`${baseUrl}/wechat/admin/members/member_sqlite_wechat_admin_update/wechat-user`, {
      method: 'DELETE',
      headers: { cookie }
    });
    assert.equal(wechatUnbindResponse.status, 200);
    const wechatUnbindPayload = await wechatUnbindResponse.json();
    assert.equal(wechatUnbindPayload.member.wechatBound, false);
    assert.equal(wechatUnbindPayload.wechatUser.status, 'guest');
    updatedMember = await repositoryModule.getSqliteRecord('members', 'member_sqlite_wechat_admin_update');
    let linkedWechatUser = await repositoryModule.getSqliteRecord('wechatUsers', 'wechat_sqlite_wechat_admin_update');
    logs = await repositoryModule.getSqliteCollection('logs', { limit: 0 });
    const afterWechatUnbindStatus = await storeModule.storeRuntimeStatus({ sqliteSummary: false });
    assert.equal(updatedMember.wechatUserId, '');
    assert.equal(updatedMember.wechatId, '');
    assert.equal(linkedWechatUser.memberId, '');
    assert.equal(linkedWechatUser.status, 'guest');
    assert.equal(logs.some((log) => log.type === 'wechat_member_unbind' && log.targetId === 'member_sqlite_wechat_admin_update'), true);
    assert.equal(afterWechatUnbindStatus.metrics.writes.total, beforeWechatUnbindStatus.metrics.writes.total);
    assert.equal(afterWechatUnbindStatus.metrics.sqliteWrites, beforeWechatUnbindStatus.metrics.sqliteWrites);
    assert.equal(queryCount(afterWechatUnbindStatus, 'list_members'), beforeWechatUnbindListMembers);

    const beforeDiscordUnbindStatus = await storeModule.storeRuntimeStatus({ sqliteSummary: false });
    const beforeDiscordUnbindListMembers = queryCount(beforeDiscordUnbindStatus, 'list_members');
    const discordUnbindResponse = await httpFetch(`${baseUrl}/wechat/admin/members/member_sqlite_wechat_admin_update/discord-user`, {
      method: 'DELETE',
      headers: { cookie }
    });
    assert.equal(discordUnbindResponse.status, 200);
    const discordUnbindPayload = await discordUnbindResponse.json();
    assert.equal(discordUnbindPayload.member.discordBound, false);
    updatedMember = await repositoryModule.getSqliteRecord('members', 'member_sqlite_wechat_admin_update');
    logs = await repositoryModule.getSqliteCollection('logs', { limit: 0 });
    const afterDiscordUnbindStatus = await storeModule.storeRuntimeStatus({ sqliteSummary: false });
    assert.equal(updatedMember.discordId, '');
    assert.equal(updatedMember.discordName, '');
    assert.equal(updatedMember.discordAvatarHash, '');
    assert.equal(updatedMember.discordAvatarUrl, '');
    assert.equal(logs.some((log) => log.type === 'discord_member_unbind' && log.targetId === 'member_sqlite_wechat_admin_update'), true);
    assert.equal(afterDiscordUnbindStatus.metrics.writes.total, beforeDiscordUnbindStatus.metrics.writes.total);
    assert.equal(afterDiscordUnbindStatus.metrics.sqliteWrites, beforeDiscordUnbindStatus.metrics.sqliteWrites);
    assert.equal(queryCount(afterDiscordUnbindStatus, 'list_members'), beforeDiscordUnbindListMembers);

    const beforeDeleteFailureStatus = await storeModule.storeRuntimeStatus({ sqliteSummary: false });
    const beforeDeleteFailureReadStoreFull = queryCount(beforeDeleteFailureStatus, 'read_store_full');
    repositoryModule.injectSqliteStorePatchFailureForTests('wechat_admin_member_delete', 1);
    const failedDeleteResponse = await httpFetch(`${baseUrl}/wechat/admin/members/member_sqlite_wechat_delete`, {
      method: 'DELETE',
      headers: { cookie }
    });
    const failedDeletePayload = await failedDeleteResponse.json();
    assert.equal(failedDeleteResponse.status, 503);
    assert.match(failedDeletePayload.error, /微信管理成员删除写入暂不可用/);
    const afterDeleteFailureStatus = await storeModule.storeRuntimeStatus({ sqliteSummary: false });
    assert.equal(queryCount(afterDeleteFailureStatus, 'read_store_full'), beforeDeleteFailureReadStoreFull);
    assert.notEqual(await repositoryModule.getSqliteRecord('members', 'member_sqlite_wechat_delete'), null);
    linkedWechatUser = await repositoryModule.getSqliteRecord('wechatUsers', 'wechat_sqlite_wechat_delete');
    assert.equal(linkedWechatUser.memberId, 'member_sqlite_wechat_delete');
    assert.equal(linkedWechatUser.status, 'approved');
    assert.notEqual(await repositoryModule.getSqliteRecord('kdaRows', 'kda_sqlite_wechat_delete_live'), null);

    const beforeDeleteStatus = await storeModule.storeRuntimeStatus({ sqliteSummary: false });
    const beforeWechatAdminMemberDeleteWrite = writeCount(beforeDeleteStatus, 'wechat_admin_member_delete');
    const beforeWechatAdminMemberDeleteLogTrimWrite = writeCount(beforeDeleteStatus, 'wechat_admin_member_delete_log_trim');
    const deleteResponse = await httpFetch(`${baseUrl}/wechat/admin/members/member_sqlite_wechat_delete`, {
      method: 'DELETE',
      headers: { cookie }
    });
    assert.equal(deleteResponse.status, 200);
    const deletePayload = await deleteResponse.json();
    assert.equal(deletePayload.deleted, true);
    assert.equal(deletePayload.memberId, 'member_sqlite_wechat_delete');
    assert.equal(deletePayload.steamId, '76561198003333333');
    assert.equal(deletePayload.wechatUsers[0].id, 'wechat_sqlite_wechat_delete');
    assert.equal(deletePayload.wechatUsers[0].status, 'guest');
    assert.equal(deletePayload.members.some((member) => member.id === 'member_sqlite_wechat_delete'), false);
    assert.equal(await repositoryModule.getSqliteRecord('members', 'member_sqlite_wechat_delete'), null);
    assert.equal(await repositoryModule.getSqliteRecord('squadMembers', 'squad_member_sqlite_wechat_delete'), null);
    assert.equal(await repositoryModule.getSqliteRecord('wipeParticipants', 'participant_sqlite_wechat_delete_live'), null);
    assert.equal(await repositoryModule.getSqliteRecord('kdaRows', 'kda_sqlite_wechat_delete_live'), null);
    assert.equal(await repositoryModule.getSqliteRecord('kdaRows', 'kda_sqlite_wechat_delete_steam_only_live'), null);
    assert.equal(await repositoryModule.getSqliteRecord('kdaSnapshots', 'kda_snapshot_sqlite_wechat_delete_live'), null);
    assert.equal(await repositoryModule.getSqliteRecord('kdaSnapshots', 'kda_snapshot_sqlite_wechat_delete_steam_only_live'), null);
    assert.equal(await repositoryModule.getSqliteRecord('memberProfiles', 'member_profile_sqlite_wechat_delete'), null);
    assert.equal(await repositoryModule.getSqliteRecord('accountAlertDismissals', 'alert_sqlite_wechat_delete'), null);
    assert.equal(await repositoryModule.getSqliteRecord('users', 'user_sqlite_wechat_delete_member'), null);
    assert.equal(await repositoryModule.getSqliteRecord('sessions', 'session_sqlite_wechat_delete_member'), null);
    assert.equal((await repositoryModule.getSqliteRecord('wipeParticipants', 'participant_sqlite_wechat_delete_closed')).squadId, 'squad_sqlite_wechat_old');
    assert.equal((await repositoryModule.getSqliteRecord('kdaRows', 'kda_sqlite_wechat_delete_closed')).squadId, 'squad_sqlite_wechat_old');
    assert.equal((await repositoryModule.getSqliteRecord('kdaSnapshots', 'kda_snapshot_sqlite_wechat_delete_closed')).squadId, 'squad_sqlite_wechat_old');
    linkedWechatUser = await repositoryModule.getSqliteRecord('wechatUsers', 'wechat_sqlite_wechat_delete');
    assert.equal(linkedWechatUser.memberId, '');
    assert.equal(linkedWechatUser.status, 'guest');
    assert.equal((await repositoryModule.getSqliteRecord('users', 'user_sqlite_wechat_delete_manager')).boundSteamId, '76561198003333333');
    assert.equal((await repositoryModule.getSqliteRecord('sessions', 'session_sqlite_wechat_delete_manager')).userId, 'user_sqlite_wechat_delete_manager');
    logs = await repositoryModule.getSqliteCollection('logs', { limit: 0 });
    const afterDeleteStatus = await storeModule.storeRuntimeStatus({ sqliteSummary: false });
    assert.equal(logs.some((log) => log.type === 'wechat_admin_member_delete' && log.targetId === 'member_sqlite_wechat_delete'), true);
    assert.equal(afterDeleteStatus.metrics.writes.total, beforeDeleteStatus.metrics.writes.total);
    assert.equal(afterDeleteStatus.metrics.sqliteWrites, beforeDeleteStatus.metrics.sqliteWrites);
    assert.equal(writeCount(afterDeleteStatus, 'wechat_admin_member_delete'), beforeWechatAdminMemberDeleteWrite + 1);
    assert.equal(writeCount(afterDeleteStatus, 'wechat_admin_member_delete_log_trim'), beforeWechatAdminMemberDeleteLogTrimWrite);
  } finally {
    if (server) await new Promise((resolve) => server.close(resolve));
    globalThis.fetch = originalFetch;
    const sqliteModule = await import('../server/storage/sqlite.js');
    await sqliteModule.closeSqliteDatabasesForTests();
    Object.assign(process.env, previousEnv);
    for (const [key, value] of Object.entries(previousEnv)) {
      if (value === undefined) delete process.env[key];
    }
    await rm(dataDir, { recursive: true, force: true });
  }
});

test('sqlite-primary web member create uses direct SQLite patch writes', async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'nb-clan-sqlite-web-member-create-'));
  const previousEnv = {
    NB_DATA_DIR: process.env.NB_DATA_DIR,
    NB_ROOT_PASSWORD: process.env.NB_ROOT_PASSWORD,
    NB_STORAGE_MODE: process.env.NB_STORAGE_MODE,
    NB_SQLITE_FILE: process.env.NB_SQLITE_FILE,
    NB_DISABLE_BACKGROUND_JOBS: process.env.NB_DISABLE_BACKGROUND_JOBS,
    NB_DISABLE_EXTERNAL_VITAL: process.env.NB_DISABLE_EXTERNAL_VITAL,
    NB_TRACE_RECORD_DIRECT_RETRY_ATTEMPTS: process.env.NB_TRACE_RECORD_DIRECT_RETRY_ATTEMPTS,
    NB_TRACE_RECORD_GENERIC_FALLBACK_MAX_PER_WINDOW: process.env.NB_TRACE_RECORD_GENERIC_FALLBACK_MAX_PER_WINDOW
  };
  const originalFetch = globalThis.fetch;
  const httpFetch = originalFetch.bind(globalThis);
  process.env.NB_DATA_DIR = dataDir;
  process.env.NB_ROOT_PASSWORD = 'RootPass123!';
  process.env.NB_STORAGE_MODE = 'sqlite-primary';
  process.env.NB_SQLITE_FILE = path.join(dataDir, 'nb-clan.sqlite');
  process.env.NB_DISABLE_BACKGROUND_JOBS = '1';
  process.env.NB_DISABLE_EXTERNAL_VITAL = '1';

  let server = null;
  try {
    const storeModule = await uniqueImport('../server/store.js');
    const apiModule = await uniqueImport('../server/api.js');
    const authModule = await uniqueImport('../server/auth.js');
    await storeModule.ensureStore();
    const createdAt = '2026-07-02T00:00:00.000Z';
    await storeModule.updateStore((store) => {
      store.squads.push({
        id: 'squad_sqlite_web_create',
        name: 'SQLite Web Create Squad',
        leaderUserIds: [],
        createdAt,
        updatedAt: createdAt
      });
    });

    const app = express();
    app.use('/api', apiModule.createApiRouter());
    server = createServer(app);
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const baseUrl = `http://127.0.0.1:${server.address().port}/api`;
    const sessionId = await authModule.createSession('user_root');
    const cookie = `nb_session=${encodeURIComponent(sessionId)}`;
    const newSteamId = '76561198005555551';

    globalThis.fetch = async (url, options = {}) => {
      const href = String(url);
      if (href.startsWith(`https://steamcommunity.com/profiles/${newSteamId}`)) {
        return new Response([
          '<profile>',
          `<steamID64>${newSteamId}</steamID64>`,
          '<steamID>SQLite Web Create</steamID>',
          '<avatarFull>https://example.com/sqlite-web-create.png</avatarFull>',
          '<privacyState>public</privacyState>',
          '</profile>'
        ].join(''), { status: 200, headers: { 'content-type': 'text/xml' } });
      }
      return originalFetch(url, options);
    };

    const repositoryModule = await import('../server/storage/repository.js');
    const queryCount = (status, name) => status.sqlite?.queries?.byName?.[name]?.total || 0;
    const writeCount = (status, name) => status.sqlite?.writes?.byName?.[name]?.total || 0;
    const beforeCreateFailureStatus = await storeModule.storeRuntimeStatus({ sqliteSummary: false });
    const beforeCreateFailureReadStoreFull = queryCount(beforeCreateFailureStatus, 'read_store_full');
    repositoryModule.injectSqliteStorePatchFailureForTests('member_add', 1);
    const failedCreateResponse = await httpFetch(`${baseUrl}/members?response=minimal`, {
      method: 'POST',
      headers: {
        cookie,
        'content-type': 'application/json'
      },
      body: JSON.stringify({
        steamInput: newSteamId,
        customName: 'SQLite Web Create Custom',
        specialty: ['PVP'],
        squadId: 'squad_sqlite_web_create'
      })
    });
    const failedCreatePayload = await failedCreateResponse.json();
    assert.equal(failedCreateResponse.status, 503);
    assert.match(failedCreatePayload.error, /成员创建写入暂不可用/);
    const afterCreateFailureStatus = await storeModule.storeRuntimeStatus({ sqliteSummary: false });
    assert.equal(queryCount(afterCreateFailureStatus, 'read_store_full'), beforeCreateFailureReadStoreFull);
    const failedCreatedMembers = await repositoryModule.getSqliteRecordsByJsonField('members', 'steamId', [newSteamId], { limit: 0 });
    assert.equal(failedCreatedMembers.length, 0);

    const beforeStatus = await storeModule.storeRuntimeStatus({ sqliteSummary: false });
    const beforeStat = await stat(storeModule.STORE_FILE);
	    const beforeReadStoreFull = queryCount(beforeStatus, 'read_store_full');
	    const beforeListMembers = queryCount(beforeStatus, 'list_members');
	    const beforeListSquads = queryCount(beforeStatus, 'list_squads');
	    const beforeSquadsById = queryCount(beforeStatus, 'list_squads_id');
	    const beforeFindMembersSteamId = queryCount(beforeStatus, 'find_members_steamId');
    const beforeMemberAddWrite = writeCount(beforeStatus, 'member_add');
    const beforeMemberAddLogTrimWrite = writeCount(beforeStatus, 'member_add_log_trim');

    const createResponse = await httpFetch(`${baseUrl}/members?response=minimal`, {
      method: 'POST',
      headers: {
        cookie,
        'content-type': 'application/json'
      },
      body: JSON.stringify({
        steamInput: newSteamId,
        customName: 'SQLite Web Create Custom',
        specialty: ['PVP'],
        squadId: 'squad_sqlite_web_create'
      })
    });
    const createPayload = await createResponse.json();
    assert.equal(createResponse.status, 200, JSON.stringify(createPayload));
    assert.equal(createPayload.member.steamId, newSteamId);
    assert.equal(createPayload.member.steamNickname, 'SQLite Web Create');
    assert.equal(createPayload.member.squadId, 'squad_sqlite_web_create');
    assert.equal(createPayload.syncQueued, 0);

    const afterStatus = await storeModule.storeRuntimeStatus({ sqliteSummary: false });
    const afterStat = await stat(storeModule.STORE_FILE);
    assert.equal(afterStat.mtimeMs, beforeStat.mtimeMs);
    assert.equal(afterStatus.metrics.sqliteWrites, beforeStatus.metrics.sqliteWrites);
	    assert.equal(queryCount(afterStatus, 'read_store_full'), beforeReadStoreFull);
	    assert.equal(queryCount(afterStatus, 'list_members'), beforeListMembers);
	    assert.equal(queryCount(afterStatus, 'list_squads'), beforeListSquads);
	    assert.equal(queryCount(afterStatus, 'list_squads_id') > beforeSquadsById, true);
	    assert.equal(queryCount(afterStatus, 'find_members_steamId') > beforeFindMembersSteamId, true);
	    assert.equal(writeCount(afterStatus, 'member_add'), beforeMemberAddWrite + 1);
	    assert.equal(writeCount(afterStatus, 'member_add_log_trim'), beforeMemberAddLogTrimWrite);

	    const beforeEditStatus = afterStatus;
	    const beforeEditStat = await stat(storeModule.STORE_FILE);
	    const beforeEditFullReads = {
	      members: queryCount(beforeEditStatus, 'list_members'),
	      squads: queryCount(beforeEditStatus, 'list_squads'),
	      squadMembers: queryCount(beforeEditStatus, 'list_squadMembers'),
	      wipes: queryCount(beforeEditStatus, 'list_wipes')
	    };
	    const beforeEditScopedReads = {
	      membersBySteamId: queryCount(beforeEditStatus, 'list_members_steamId'),
	      squadsById: queryCount(beforeEditStatus, 'list_squads_id'),
	      squadMembersByMemberId: queryCount(beforeEditStatus, 'list_squadMembers_memberId'),
	      wipesByStatus: queryCount(beforeEditStatus, 'list_wipes_status'),
	      memberProfilesByMemberId: queryCount(beforeEditStatus, 'list_memberProfiles_memberId')
	    };
	    const beforeMemberEditWrite = writeCount(beforeEditStatus, 'member_edit');
	    const editResponse = await httpFetch(`${baseUrl}/members/${createPayload.member.id}?response=member`, {
	      method: 'PUT',
	      headers: {
	        cookie,
	        'content-type': 'application/json'
	      },
	      body: JSON.stringify({
	        steamInput: newSteamId,
	        customName: 'SQLite Web Edited Custom',
	        specialty: ['electricity'],
	        squadId: 'squad_sqlite_web_create'
	      })
	    });
	    const editPayload = await editResponse.json();
	    assert.equal(editResponse.status, 200, JSON.stringify(editPayload));
	    assert.equal(editPayload.member.id, createPayload.member.id);
	    assert.equal(editPayload.member.displayName, 'SQLite Web Edited Custom');
	    assert.equal(editPayload.members, undefined);
	    const afterEditStatus = await storeModule.storeRuntimeStatus({ sqliteSummary: false });
	    const afterEditStat = await stat(storeModule.STORE_FILE);
	    assert.equal(afterEditStat.mtimeMs, beforeEditStat.mtimeMs);
	    assert.equal(afterEditStatus.metrics.sqliteWrites, beforeEditStatus.metrics.sqliteWrites);
	    assert.equal(queryCount(afterEditStatus, 'list_members'), beforeEditFullReads.members);
	    assert.equal(queryCount(afterEditStatus, 'list_squads'), beforeEditFullReads.squads);
	    assert.equal(queryCount(afterEditStatus, 'list_squadMembers'), beforeEditFullReads.squadMembers);
	    assert.equal(queryCount(afterEditStatus, 'list_wipes'), beforeEditFullReads.wipes);
	    assert.equal(queryCount(afterEditStatus, 'list_members_steamId') > beforeEditScopedReads.membersBySteamId, true);
	    assert.equal(queryCount(afterEditStatus, 'list_squads_id') > beforeEditScopedReads.squadsById, true);
	    assert.equal(queryCount(afterEditStatus, 'list_squadMembers_memberId') > beforeEditScopedReads.squadMembersByMemberId, true);
	    assert.equal(queryCount(afterEditStatus, 'list_wipes_status') > beforeEditScopedReads.wipesByStatus, true);
	    assert.equal(queryCount(afterEditStatus, 'list_memberProfiles_memberId') > beforeEditScopedReads.memberProfilesByMemberId, true);
	    assert.equal(writeCount(afterEditStatus, 'member_edit'), beforeMemberEditWrite + 1);

	    const members = await repositoryModule.getSqliteRecordsByJsonField('members', 'steamId', [newSteamId], { limit: 0 });
	    assert.equal(members.length, 1);
	    assert.equal(members[0].customName, 'SQLite Web Edited Custom');
	    assert.deepEqual(members[0].specialty, ['electricity']);
    const squadMembers = await repositoryModule.getSqliteRecordsByJsonField('squadMembers', 'memberId', [members[0].id], { limit: 0 });
    assert.equal(squadMembers.length, 1);
    assert.equal(squadMembers[0].squadId, 'squad_sqlite_web_create');
    const logs = await repositoryModule.getSqliteCollection('logs', { limit: 0 });
    assert.equal(logs.some((log) => log.type === 'member_add' && log.targetId === members[0].id), true);
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

test('sqlite-primary web member bulk create uses direct SQLite patch writes', async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'nb-clan-sqlite-web-member-bulk-create-'));
  const previousEnv = {
    NB_DATA_DIR: process.env.NB_DATA_DIR,
    NB_ROOT_PASSWORD: process.env.NB_ROOT_PASSWORD,
    NB_STORAGE_MODE: process.env.NB_STORAGE_MODE,
    NB_SQLITE_FILE: process.env.NB_SQLITE_FILE,
    NB_DISABLE_BACKGROUND_JOBS: process.env.NB_DISABLE_BACKGROUND_JOBS,
    NB_DISABLE_EXTERNAL_VITAL: process.env.NB_DISABLE_EXTERNAL_VITAL
  };
  const originalFetch = globalThis.fetch;
  const httpFetch = originalFetch.bind(globalThis);
  process.env.NB_DATA_DIR = dataDir;
  process.env.NB_ROOT_PASSWORD = 'RootPass123!';
  process.env.NB_STORAGE_MODE = 'sqlite-primary';
  process.env.NB_SQLITE_FILE = path.join(dataDir, 'nb-clan.sqlite');
  process.env.NB_DISABLE_BACKGROUND_JOBS = '1';
  process.env.NB_DISABLE_EXTERNAL_VITAL = '1';

  let server = null;
  try {
    const storeModule = await uniqueImport('../server/store.js');
    const apiModule = await uniqueImport('../server/api.js');
    const authModule = await uniqueImport('../server/auth.js');
    await storeModule.ensureStore();
    const createdAt = '2026-07-02T00:00:00.000Z';
    const existingSteamId = '76561198005555560';
    const newSteamIdOne = '76561198005555561';
    const newSteamIdTwo = '76561198005555562';
    await storeModule.updateStore((store) => {
      store.squads.push({
        id: 'squad_sqlite_web_bulk_create',
        name: 'SQLite Web Bulk Create Squad',
        leaderUserIds: [],
        createdAt,
        updatedAt: createdAt
      });
      store.members.push({
        id: 'member_sqlite_web_bulk_existing',
        steamId: existingSteamId,
        rawInput: existingSteamId,
        customName: 'SQLite Web Bulk Existing',
        steamNickname: 'SQLite Web Bulk Existing',
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

    const app = express();
    app.use('/api', apiModule.createApiRouter());
    server = createServer(app);
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const baseUrl = `http://127.0.0.1:${server.address().port}/api`;
    const sessionId = await authModule.createSession('user_root');
    const cookie = `nb_session=${encodeURIComponent(sessionId)}`;

    globalThis.fetch = async (url, options = {}) => {
      const href = String(url);
      const match = href.match(/steamcommunity\.com\/profiles\/(7656\d{13})/);
      if (match) {
        const steamId = match[1];
        return new Response([
          '<profile>',
          `<steamID64>${steamId}</steamID64>`,
          `<steamID>SQLite Bulk ${steamId.slice(-2)}</steamID>`,
          `<avatarFull>https://example.com/sqlite-bulk-${steamId.slice(-2)}.png</avatarFull>`,
          '<privacyState>public</privacyState>',
          '</profile>'
        ].join(''), { status: 200, headers: { 'content-type': 'text/xml' } });
      }
      return originalFetch(url, options);
    };

    const repositoryModule = await import('../server/storage/repository.js');
    const queryCount = (status, name) => status.sqlite?.queries?.byName?.[name]?.total || 0;
    const writeCount = (status, name) => status.sqlite?.writes?.byName?.[name]?.total || 0;
    const beforeBulkCreateFailureStatus = await storeModule.storeRuntimeStatus({ sqliteSummary: false });
    const beforeBulkCreateFailureReadStoreFull = queryCount(beforeBulkCreateFailureStatus, 'read_store_full');
    repositoryModule.injectSqliteStorePatchFailureForTests('member_bulk_add', 1);
    const failedBulkResponse = await httpFetch(`${baseUrl}/members/bulk?response=minimal`, {
      method: 'POST',
      headers: {
        cookie,
        'content-type': 'application/json'
      },
      body: JSON.stringify({
        text: [
          newSteamIdOne,
          `https://steamcommunity.com/profiles/${newSteamIdTwo}`,
          existingSteamId
        ].join('\n'),
        squadId: 'squad_sqlite_web_bulk_create',
        specialty: ['pvp', 'laborer']
      })
    });
    const failedBulkPayload = await failedBulkResponse.json();
    assert.equal(failedBulkResponse.status, 503);
    assert.match(failedBulkPayload.error, /成员批量创建写入暂不可用/);
    const afterBulkCreateFailureStatus = await storeModule.storeRuntimeStatus({ sqliteSummary: false });
    assert.equal(queryCount(afterBulkCreateFailureStatus, 'read_store_full'), beforeBulkCreateFailureReadStoreFull);
    const failedBulkMembers = await repositoryModule.getSqliteRecordsByJsonField('members', 'steamId', [newSteamIdOne, newSteamIdTwo], { limit: 0 });
    assert.equal(failedBulkMembers.length, 0);

    const beforeStatus = await storeModule.storeRuntimeStatus({ sqliteSummary: false });
    const beforeStat = await stat(storeModule.STORE_FILE);
	    const beforeReadStoreFull = queryCount(beforeStatus, 'read_store_full');
	    const beforeListMembers = queryCount(beforeStatus, 'list_members');
	    const beforeListSquads = queryCount(beforeStatus, 'list_squads');
	    const beforeMembersBySteam = queryCount(beforeStatus, 'list_members_steamId');
	    const beforeSquadsById = queryCount(beforeStatus, 'list_squads_id');
    const beforeMemberBulkAddWrite = writeCount(beforeStatus, 'member_bulk_add');
    const beforeMemberBulkAddLogTrimWrite = writeCount(beforeStatus, 'member_bulk_add_log_trim');

	    const bulkResponse = await httpFetch(`${baseUrl}/members/bulk?response=minimal`, {
      method: 'POST',
      headers: {
        cookie,
        'content-type': 'application/json'
      },
      body: JSON.stringify({
        text: [
          newSteamIdOne,
          `https://steamcommunity.com/profiles/${newSteamIdTwo}`,
          existingSteamId,
          newSteamIdOne,
          'not-a-steamid'
        ].join('\n'),
        squadId: 'squad_sqlite_web_bulk_create',
        specialty: ['pvp', 'laborer']
      })
    });
    const bulkPayload = await bulkResponse.json();
    assert.equal(bulkResponse.status, 200, JSON.stringify(bulkPayload));
    assert.equal(bulkPayload.imported, 2);
    assert.equal(bulkPayload.skipped, 2);
    assert.equal(bulkPayload.failed, 1);
	    assert.equal(bulkPayload.syncQueued, 0);
	    assert.equal(bulkPayload.members, undefined);
    assert.equal(bulkPayload.results.filter((item) => item.status === 'imported').length, 2);
    assert.equal(bulkPayload.results.filter((item) => item.status === 'skipped').length, 2);
    assert.equal(bulkPayload.results.filter((item) => item.status === 'failed').length, 1);

    const afterStatus = await storeModule.storeRuntimeStatus({ sqliteSummary: false });
    const afterStat = await stat(storeModule.STORE_FILE);
    assert.equal(afterStat.mtimeMs, beforeStat.mtimeMs);
	    assert.equal(afterStatus.metrics.sqliteWrites, beforeStatus.metrics.sqliteWrites);
	    assert.equal(queryCount(afterStatus, 'read_store_full'), beforeReadStoreFull);
	    assert.equal(queryCount(afterStatus, 'list_members') <= beforeListMembers + 1, true);
	    assert.equal(queryCount(afterStatus, 'list_squads'), beforeListSquads);
	    assert.equal(queryCount(afterStatus, 'list_members_steamId') > beforeMembersBySteam, true);
	    assert.equal(queryCount(afterStatus, 'list_squads_id') > beforeSquadsById, true);
    assert.equal(writeCount(afterStatus, 'member_bulk_add'), beforeMemberBulkAddWrite + 1);
    assert.equal(writeCount(afterStatus, 'member_bulk_add_log_trim'), beforeMemberBulkAddLogTrimWrite);

    const createdMembers = await repositoryModule.getSqliteRecordsByJsonField('members', 'steamId', [newSteamIdOne, newSteamIdTwo], { limit: 0 });
    assert.equal(createdMembers.length, 2);
    assert.equal(createdMembers.every((member) => member.invitedByUserId === 'user_root'), true);
    assert.equal(createdMembers.every((member) => JSON.stringify(member.specialty) === JSON.stringify(['pvp'])), true);
    const existingMembers = await repositoryModule.getSqliteRecordsByJsonField('members', 'steamId', [existingSteamId], { limit: 0 });
    assert.equal(existingMembers.length, 1);
    const createdMemberIds = createdMembers.map((member) => member.id);
    const squadMembers = await repositoryModule.getSqliteRecordsByJsonField('squadMembers', 'memberId', createdMemberIds, { limit: 0 });
    assert.equal(squadMembers.length, 2);
    assert.equal(squadMembers.every((item) => item.squadId === 'squad_sqlite_web_bulk_create'), true);
    const logs = await repositoryModule.getSqliteCollection('logs', { limit: 0 });
    const bulkLog = logs.find((log) => log.type === 'member_bulk_add' && log.metadata?.imported === 2);
    assert.equal(Boolean(bulkLog), true);
    assert.equal(bulkLog.metadata.skipped, 2);
    assert.equal(bulkLog.metadata.failed, 1);
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

test('sqlite-primary web wipe create and edit use direct SQLite patch writes', async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'nb-clan-sqlite-web-wipe-write-'));
  const previousEnv = {
    NB_DATA_DIR: process.env.NB_DATA_DIR,
    NB_ROOT_PASSWORD: process.env.NB_ROOT_PASSWORD,
    NB_STORAGE_MODE: process.env.NB_STORAGE_MODE,
    NB_SQLITE_FILE: process.env.NB_SQLITE_FILE,
    NB_DISABLE_BACKGROUND_JOBS: process.env.NB_DISABLE_BACKGROUND_JOBS,
    NB_DISABLE_EXTERNAL_VITAL: process.env.NB_DISABLE_EXTERNAL_VITAL,
    NB_RUSTPLUS_RELAY_CHAT_FLUSH_INTERVAL_MS: process.env.NB_RUSTPLUS_RELAY_CHAT_FLUSH_INTERVAL_MS
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

  let server = null;
  try {
    const storeModule = await uniqueImport('../server/store.js');
    const apiModule = await uniqueImport('../server/api.js');
    const authModule = await uniqueImport('../server/auth.js');
    await storeModule.ensureStore();

    const app = express();
    app.use('/api', apiModule.createApiRouter());
    server = createServer(app);
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const baseUrl = `http://127.0.0.1:${server.address().port}/api`;

    const sessionId = await authModule.createSession('user_root');
    const cookie = `nb_session=${encodeURIComponent(sessionId)}`;
	    const repositoryModule = await import('../server/storage/repository.js');
	    const queryCount = (status, name) => status.sqlite?.queries?.byName?.[name]?.total || 0;
	    const writeCount = (status, name) => status.sqlite?.writes?.byName?.[name]?.total || 0;

    const beforeCreateFailureStatus = await storeModule.storeRuntimeStatus({ sqliteSummary: false });
    const beforeCreateFailureReadStoreFull = queryCount(beforeCreateFailureStatus, 'read_store_full');
    const beforeCreateFailureStat = await stat(storeModule.STORE_FILE);
    const beforeCreateFailureWrite = writeCount(beforeCreateFailureStatus, 'wipe_create');
    repositoryModule.injectSqliteStorePatchFailureForTests('wipe_create', 1);
    const failedCreateResponse = await httpFetch(`${baseUrl}/wipes`, {
      method: 'POST',
      headers: {
        cookie,
        'content-type': 'application/json'
      },
      body: JSON.stringify({
        name: 'SQLite Web Failed Wipe',
        serverName: 'SQLite Failed Server',
        startedAt: '2026-07-08T07:00:00.000Z'
      })
    });
    const failedCreatePayload = await failedCreateResponse.json();
    assert.equal(failedCreateResponse.status, 503, JSON.stringify(failedCreatePayload));
    assert.match(failedCreatePayload.error, /档期创建写入暂不可用/);
    const failedCreateRows = await repositoryModule.getSqliteRecordsByJsonField('wipes', 'serverName', ['SQLite Failed Server'], { limit: 0 });
    const afterCreateFailureStatus = await storeModule.storeRuntimeStatus({ sqliteSummary: false });
    const afterCreateFailureStat = await stat(storeModule.STORE_FILE);
    assert.equal(failedCreateRows.length, 0);
    assert.equal(afterCreateFailureStat.mtimeMs, beforeCreateFailureStat.mtimeMs);
    assert.equal(afterCreateFailureStatus.metrics.writes.total, beforeCreateFailureStatus.metrics.writes.total);
    assert.equal(afterCreateFailureStatus.metrics.sqliteWrites, beforeCreateFailureStatus.metrics.sqliteWrites);
    assert.equal(writeCount(afterCreateFailureStatus, 'wipe_create'), beforeCreateFailureWrite);
    assert.equal(queryCount(afterCreateFailureStatus, 'read_store_full'), beforeCreateFailureReadStoreFull);

	    const beforeCreateStat = await stat(storeModule.STORE_FILE);
	    const beforeCreateStatus = await storeModule.storeRuntimeStatus({ sqliteSummary: false });
	    const beforeCreateFullReads = {
	      users: queryCount(beforeCreateStatus, 'list_users'),
	      members: queryCount(beforeCreateStatus, 'list_members'),
	      squads: queryCount(beforeCreateStatus, 'list_squads'),
	      squadMembers: queryCount(beforeCreateStatus, 'list_squadMembers'),
	      wipes: queryCount(beforeCreateStatus, 'list_wipes'),
	      wipeParticipants: queryCount(beforeCreateStatus, 'list_wipeParticipants')
	    };
	    const beforeCreateWipesByStatus = queryCount(beforeCreateStatus, 'list_wipes_status');
	    const beforeWipeCreateWrite = writeCount(beforeCreateStatus, 'wipe_create');
    const beforeWipeCreateLogTrimWrite = writeCount(beforeCreateStatus, 'wipe_create_log_trim');
    const createResponse = await httpFetch(`${baseUrl}/wipes`, {
      method: 'POST',
      headers: {
        cookie,
        'content-type': 'application/json'
      },
      body: JSON.stringify({
        name: 'SQLite Web Direct Wipe',
        serverName: 'SQLite Direct Server',
        startedAt: '2026-07-08T08:00:00.000Z',
        nextWipeAt: '2026-07-15T08:00:00.000Z',
        timeZone: 'Asia/Shanghai',
        wipeLabel: 'Planned',
        wipeMode: 'next',
        directConnect: 'connect sqlite-direct-create',
        vipUrl: 'https://example.com/vip-create',
        mapLink: 'https://example.com/map-create',
        notes: 'sqlite direct create'
      })
    });
    const createPayload = await createResponse.json();
    assert.equal(createResponse.status, 200, JSON.stringify(createPayload));
    assert.ok(createPayload.wipe?.id);
    assert.equal(createPayload.wipe.name, 'SQLite Web Direct Wipe');
    assert.equal(createPayload.wipe.startedAt, '2026-07-08T08:00:00.000Z');
    assert.equal(createPayload.wipe.startedAtTimeZone, 'Asia/Shanghai');
    assert.equal(createPayload.wipe.nextWipeAt, '2026-07-15T08:00:00.000Z');
    assert.equal(createPayload.wipe.nextWipeAtTimeZone, 'Asia/Shanghai');

    const createdWipeId = createPayload.wipe.id;
    let wipeRecord = await repositoryModule.getSqliteRecord('wipes', createdWipeId);
    assert.equal(wipeRecord.serverName, 'SQLite Direct Server');
    assert.equal(wipeRecord.directConnect, 'connect sqlite-direct-create');
    assert.equal(wipeRecord.createdBy, 'user_root');
    let logs = await repositoryModule.getSqliteCollection('logs', { limit: 0 });
    assert.equal(logs.some((log) => log.type === 'wipe_create' && log.targetId === createdWipeId), true);
    const afterCreateStat = await stat(storeModule.STORE_FILE);
    const afterCreateStatus = await storeModule.storeRuntimeStatus({ sqliteSummary: false });
	    assert.equal(afterCreateStat.mtimeMs, beforeCreateStat.mtimeMs);
	    assert.equal(afterCreateStatus.metrics.writes.total, beforeCreateStatus.metrics.writes.total);
	    assert.equal(afterCreateStatus.metrics.sqliteWrites, beforeCreateStatus.metrics.sqliteWrites);
	    assert.equal(queryCount(afterCreateStatus, 'list_users'), beforeCreateFullReads.users);
	    assert.equal(queryCount(afterCreateStatus, 'list_members'), beforeCreateFullReads.members);
	    assert.equal(queryCount(afterCreateStatus, 'list_squads'), beforeCreateFullReads.squads);
	    assert.equal(queryCount(afterCreateStatus, 'list_squadMembers'), beforeCreateFullReads.squadMembers);
	    assert.equal(queryCount(afterCreateStatus, 'list_wipes'), beforeCreateFullReads.wipes);
	    assert.equal(queryCount(afterCreateStatus, 'list_wipeParticipants'), beforeCreateFullReads.wipeParticipants);
	    assert.equal(queryCount(afterCreateStatus, 'list_wipes_status') > beforeCreateWipesByStatus, true);
	    assert.equal(writeCount(afterCreateStatus, 'wipe_create'), beforeWipeCreateWrite + 1);
    assert.equal(writeCount(afterCreateStatus, 'wipe_create_log_trim'), beforeWipeCreateLogTrimWrite);

    const beforeDuplicateStatus = await storeModule.storeRuntimeStatus({ sqliteSummary: false });
    const duplicateResponse = await httpFetch(`${baseUrl}/wipes`, {
      method: 'POST',
      headers: {
        cookie,
        'content-type': 'application/json'
      },
      body: JSON.stringify({
        serverName: 'SQLite Duplicate Server',
        startedAt: '2026-07-09T08:00:00.000Z'
      })
    });
    const duplicatePayload = await duplicateResponse.json();
    assert.equal(duplicateResponse.status, 409, JSON.stringify(duplicatePayload));
    const afterDuplicateStatus = await storeModule.storeRuntimeStatus({ sqliteSummary: false });
    assert.equal(writeCount(afterDuplicateStatus, 'wipe_create'), writeCount(beforeDuplicateStatus, 'wipe_create'));

    const beforeEditStat = await stat(storeModule.STORE_FILE);
    const beforeEditStatus = await storeModule.storeRuntimeStatus({ sqliteSummary: false });
    const beforeWipeEditWrite = writeCount(beforeEditStatus, 'wipe_edit');
    const beforeWipeEditLogTrimWrite = writeCount(beforeEditStatus, 'wipe_edit_log_trim');
    const editResponse = await httpFetch(`${baseUrl}/wipes/${createdWipeId}`, {
      method: 'PUT',
      headers: {
        cookie,
        'content-type': 'application/json'
      },
      body: JSON.stringify({
        name: 'SQLite Web Direct Wipe Edited',
        serverName: 'SQLite Direct Server Edited',
        startedAt: '2026-07-08T09:00:00.000Z',
        nextWipeAt: '2026-07-15T09:00:00.000Z',
        timeZone: 'Asia/Shanghai',
        wipeLabel: 'Current',
        wipeMode: 'current',
        vitalServerId: '16',
        vitalWipeId: 'wipe_sqlite_direct_remote',
        battlemetricsId: 'bm_sqlite_direct',
        directConnect: 'connect sqlite-direct-edit',
        vipUrl: 'https://example.com/vip-edit',
        mapLink: 'https://example.com/map-edit',
        notes: 'sqlite direct edit'
      })
    });
    const editPayload = await editResponse.json();
    assert.equal(editResponse.status, 200, JSON.stringify(editPayload));
    assert.equal(editPayload.wipe.id, createdWipeId);
    assert.equal(editPayload.wipe.name, 'SQLite Web Direct Wipe Edited');
    assert.equal(editPayload.wipe.serverName, 'SQLite Direct Server Edited');
    assert.equal(editPayload.wipe.vitalServerId, '16');
    assert.equal(editPayload.wipe.vitalWipeId, 'wipe_sqlite_direct_remote');

    wipeRecord = await repositoryModule.getSqliteRecord('wipes', createdWipeId);
    assert.equal(wipeRecord.serverName, 'SQLite Direct Server Edited');
    assert.equal(wipeRecord.battlemetricsId, 'bm_sqlite_direct');
    assert.equal(wipeRecord.directConnect, 'connect sqlite-direct-edit');
    assert.match(wipeRecord.kdaUrl, /vitalServerId=16/);
    assert.match(wipeRecord.kdaUrl, /vitalWipeId=wipe_sqlite_direct_remote/);
    logs = await repositoryModule.getSqliteCollection('logs', { limit: 0 });
    assert.equal(logs.some((log) => log.type === 'wipe_edit' && log.targetId === createdWipeId), true);
    const afterEditStat = await stat(storeModule.STORE_FILE);
    const afterEditStatus = await storeModule.storeRuntimeStatus({ sqliteSummary: false });
    assert.equal(afterEditStat.mtimeMs, beforeEditStat.mtimeMs);
    assert.equal(afterEditStatus.metrics.writes.total, beforeEditStatus.metrics.writes.total);
    assert.equal(afterEditStatus.metrics.sqliteWrites, beforeEditStatus.metrics.sqliteWrites);
    assert.equal(writeCount(afterEditStatus, 'wipe_edit'), beforeWipeEditWrite + 1);
    assert.equal(writeCount(afterEditStatus, 'wipe_edit_log_trim'), beforeWipeEditLogTrimWrite);

    const beforeEditFailureStatus = await storeModule.storeRuntimeStatus({ sqliteSummary: false });
    const beforeEditFailureReadStoreFull = queryCount(beforeEditFailureStatus, 'read_store_full');
    const beforeEditFailureStat = await stat(storeModule.STORE_FILE);
    const beforeEditFailureWrite = writeCount(beforeEditFailureStatus, 'wipe_edit');
    repositoryModule.injectSqliteStorePatchFailureForTests('wipe_edit', 1);
    const failedEditResponse = await httpFetch(`${baseUrl}/wipes/${createdWipeId}`, {
      method: 'PUT',
      headers: {
        cookie,
        'content-type': 'application/json'
      },
      body: JSON.stringify({
        name: 'SQLite Web Failed Wipe Edit',
        serverName: 'SQLite Failed Server Edit',
        startedAt: '2026-07-08T10:00:00.000Z'
      })
    });
    const failedEditPayload = await failedEditResponse.json();
    assert.equal(failedEditResponse.status, 503, JSON.stringify(failedEditPayload));
    assert.match(failedEditPayload.error, /档期编辑写入暂不可用/);
    wipeRecord = await repositoryModule.getSqliteRecord('wipes', createdWipeId);
    const afterEditFailureStatus = await storeModule.storeRuntimeStatus({ sqliteSummary: false });
    const afterEditFailureStat = await stat(storeModule.STORE_FILE);
    assert.equal(wipeRecord.name, 'SQLite Web Direct Wipe Edited');
    assert.equal(wipeRecord.serverName, 'SQLite Direct Server Edited');
    assert.equal(afterEditFailureStat.mtimeMs, beforeEditFailureStat.mtimeMs);
    assert.equal(afterEditFailureStatus.metrics.writes.total, beforeEditFailureStatus.metrics.writes.total);
    assert.equal(afterEditFailureStatus.metrics.sqliteWrites, beforeEditFailureStatus.metrics.sqliteWrites);
    assert.equal(writeCount(afterEditFailureStatus, 'wipe_edit'), beforeEditFailureWrite);
    assert.equal(queryCount(afterEditFailureStatus, 'read_store_full'), beforeEditFailureReadStoreFull);
  } finally {
    if (server) await new Promise((resolve) => server.close(resolve));
    globalThis.fetch = originalFetch;
    const sqliteModule = await import('../server/storage/sqlite.js');
    await sqliteModule.closeSqliteDatabasesForTests();
    Object.assign(process.env, previousEnv);
    for (const [key, value] of Object.entries(previousEnv)) {
      if (value === undefined) delete process.env[key];
    }
    await rm(dataDir, { recursive: true, force: true });
  }
});

test('sqlite-primary web wipe delete uses direct SQLite patch writes', async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'nb-clan-sqlite-web-wipe-delete-'));
  const previousEnv = {
    NB_DATA_DIR: process.env.NB_DATA_DIR,
    NB_ROOT_PASSWORD: process.env.NB_ROOT_PASSWORD,
    NB_STORAGE_MODE: process.env.NB_STORAGE_MODE,
    NB_SQLITE_FILE: process.env.NB_SQLITE_FILE,
    NB_DISABLE_BACKGROUND_JOBS: process.env.NB_DISABLE_BACKGROUND_JOBS,
    NB_DISABLE_EXTERNAL_VITAL: process.env.NB_DISABLE_EXTERNAL_VITAL,
    NB_RUSTPLUS_RELAY_CHAT_FLUSH_INTERVAL_MS: process.env.NB_RUSTPLUS_RELAY_CHAT_FLUSH_INTERVAL_MS
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

  let server = null;
  try {
    const storeModule = await uniqueImport('../server/store.js');
    const apiModule = await uniqueImport('../server/api.js');
    const authModule = await uniqueImport('../server/auth.js');
    await storeModule.ensureStore();
    const createdAt = '2026-07-02T00:00:00.000Z';
    const closedAt = '2026-07-03T00:00:00.000Z';
    await storeModule.updateStore((store) => {
      store.wipes.push({
        id: 'wipe_sqlite_delete_target',
        name: 'SQLite Delete Target Wipe',
        serverName: 'SQLite Delete Server',
        status: 'active',
        startedAt: createdAt,
        closedAt: '',
        createdAt,
        updatedAt: createdAt
      }, {
        id: 'wipe_sqlite_delete_other',
        name: 'SQLite Delete Other Wipe',
        serverName: 'SQLite Delete Server',
        status: 'closed',
        startedAt: createdAt,
        closedAt,
        createdAt,
        updatedAt: closedAt
      });
      store.wipeParticipants.push({
        id: 'participant_sqlite_wipe_delete_target',
        wipeId: 'wipe_sqlite_delete_target',
        memberId: 'member_sqlite_wipe_delete_target',
        steamId: '76561198005555551',
        status: 'on_time',
        createdAt,
        updatedAt: closedAt
      }, {
        id: 'participant_sqlite_wipe_delete_other',
        wipeId: 'wipe_sqlite_delete_other',
        memberId: 'member_sqlite_wipe_delete_other',
        steamId: '76561198005555552',
        status: 'on_time',
        createdAt,
        updatedAt: closedAt
      });
      store.kdaRows.push({
        id: 'kda_sqlite_wipe_delete_target',
        wipeId: 'wipe_sqlite_delete_target',
        memberId: 'member_sqlite_wipe_delete_target',
        steamId: '76561198005555551',
        kills: 12,
        syncedAt: closedAt
      }, {
        id: 'kda_sqlite_wipe_delete_other',
        wipeId: 'wipe_sqlite_delete_other',
        memberId: 'member_sqlite_wipe_delete_other',
        steamId: '76561198005555552',
        kills: 22,
        syncedAt: closedAt
      });
      store.kdaSnapshots.push({
        id: 'kda_snapshot_sqlite_wipe_delete_target',
        wipeId: 'wipe_sqlite_delete_target',
        memberId: 'member_sqlite_wipe_delete_target',
        steamId: '76561198005555551',
        kills: 12,
        capturedAt: closedAt
      }, {
        id: 'kda_snapshot_sqlite_wipe_delete_other',
        wipeId: 'wipe_sqlite_delete_other',
        memberId: 'member_sqlite_wipe_delete_other',
        steamId: '76561198005555552',
        kills: 22,
        capturedAt: closedAt
      });
      store.wipeSettlements.push({
        id: 'settlement_sqlite_wipe_delete_target',
        wipeId: 'wipe_sqlite_delete_target',
        summary: { participantCount: 1 },
        createdAt: closedAt,
        updatedAt: closedAt
      }, {
        id: 'settlement_sqlite_wipe_delete_other',
        wipeId: 'wipe_sqlite_delete_other',
        summary: { participantCount: 1 },
        createdAt: closedAt,
        updatedAt: closedAt
      });
      store.uploads.push({
        id: 'upload_sqlite_wipe_delete_other',
        ownerType: 'wipe',
        ownerId: 'wipe_sqlite_delete_other',
        kind: 'map_image',
        fileName: 'sqlite-wipe-delete-other-map.png',
        originalName: 'other map.png',
        mimeType: 'image/png',
        size: 9,
        url: '/uploads/map-files/sqlite-wipe-delete-other-map.png',
        createdAt
      }, {
        id: 'upload_sqlite_wipe_delete_same_owner_non_wipe',
        ownerType: 'member',
        ownerId: 'wipe_sqlite_delete_target',
        kind: 'team_logo',
        fileName: 'sqlite-wipe-delete-member-logo.png',
        originalName: 'member logo.png',
        mimeType: 'image/png',
        size: 1,
        url: '/uploads/team-logo/sqlite-wipe-delete-member-logo.png',
        createdAt
      });
    });

    const app = express();
    app.use('/api', apiModule.createApiRouter());
    server = createServer(app);
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const baseUrl = `http://127.0.0.1:${server.address().port}/api`;

    const sessionId = await authModule.createSession('user_root');
    const cookie = `nb_session=${encodeURIComponent(sessionId)}`;
    const repositoryModule = await import('../server/storage/repository.js');
    const queryCount = (status, name) => status.sqlite?.queries?.byName?.[name]?.total || 0;
    const writeCount = (status, name) => status.sqlite?.writes?.byName?.[name]?.total || 0;

    const beforeActiveDeleteStatus = await storeModule.storeRuntimeStatus({ sqliteSummary: false });
    const activeDeleteResponse = await httpFetch(`${baseUrl}/wipes/wipe_sqlite_delete_target`, {
      method: 'DELETE',
      headers: { cookie }
    });
    const activeDeletePayload = await activeDeleteResponse.json();
    assert.equal(activeDeleteResponse.status, 409, JSON.stringify(activeDeletePayload));
    const afterActiveDeleteStatus = await storeModule.storeRuntimeStatus({ sqliteSummary: false });
    assert.equal(writeCount(afterActiveDeleteStatus, 'wipe_delete'), writeCount(beforeActiveDeleteStatus, 'wipe_delete'));

    const imageDataUrl = `data:image/png;base64,${Buffer.from('png').toString('base64')}`;
    const screenshotResponse = await httpFetch(`${baseUrl}/wipes/wipe_sqlite_delete_target/screenshots`, {
      method: 'POST',
      headers: {
        cookie,
        'content-type': 'application/json'
      },
      body: JSON.stringify({
        mimeType: 'image/png',
        originalName: 'sqlite-wipe-delete-screenshot.png',
        dataUrl: imageDataUrl
      })
    });
    const screenshotPayload = await screenshotResponse.json();
    assert.equal(screenshotResponse.status, 200, JSON.stringify(screenshotPayload));
    const screenshotUpload = screenshotPayload.wipe.screenshots.find((upload) => upload.originalName === 'sqlite-wipe-delete-screenshot.png');
    assert.ok(screenshotUpload?.id);

    const mapResponse = await httpFetch(`${baseUrl}/wipes/wipe_sqlite_delete_target/map-files`, {
      method: 'POST',
      headers: {
        cookie,
        'content-type': 'application/json'
      },
      body: JSON.stringify({
        kind: 'map_image',
        mimeType: 'image/png',
        originalName: 'sqlite-wipe-delete-map.png',
        dataUrl: imageDataUrl
      })
    });
    const mapPayload = await mapResponse.json();
    assert.equal(mapResponse.status, 200, JSON.stringify(mapPayload));
    const mapUpload = mapPayload.wipe.mapFiles.find((upload) => upload.originalName === 'sqlite-wipe-delete-map.png');
    assert.ok(mapUpload?.id);

    const targetWipeRecord = await repositoryModule.getSqliteRecord('wipes', 'wipe_sqlite_delete_target');
    await repositoryModule.writeSqliteStorePatch({
      reason: 'sqlite_test_close_wipe_delete_target',
      upserts: {
        wipes: [{
          ...targetWipeRecord,
          status: 'closed',
          closedAt,
          updatedAt: closedAt
        }]
      }
    });
    const apiRuntimeStoreModule = await import('../server/store.js');
    const screenshotPath = path.join(apiRuntimeStoreModule.DATA_DIR, 'uploads', 'server-screenshots', path.basename(screenshotUpload.url));
    const mapPath = path.join(apiRuntimeStoreModule.DATA_DIR, 'uploads', 'map-files', path.basename(mapUpload.url));
    assert.equal((await stat(screenshotPath)).isFile(), true);
    assert.equal((await stat(mapPath)).isFile(), true);

    const beforeDeleteFailureStat = await stat(storeModule.STORE_FILE);
    const beforeDeleteFailureStatus = await storeModule.storeRuntimeStatus({ sqliteSummary: false });
    const beforeDeleteFailureReadStoreFull = queryCount(beforeDeleteFailureStatus, 'read_store_full');
    const beforeDeleteFailureWrite = writeCount(beforeDeleteFailureStatus, 'wipe_delete');
    repositoryModule.injectSqliteStorePatchFailureForTests('wipe_delete', 1);
    const failedDeleteResponse = await httpFetch(`${baseUrl}/wipes/wipe_sqlite_delete_target`, {
      method: 'DELETE',
      headers: { cookie }
    });
    const failedDeletePayload = await failedDeleteResponse.json();
    assert.equal(failedDeleteResponse.status, 503, JSON.stringify(failedDeletePayload));
    assert.match(failedDeletePayload.error, /档期删除写入暂不可用/);
    const afterDeleteFailureStat = await stat(storeModule.STORE_FILE);
    const afterDeleteFailureStatus = await storeModule.storeRuntimeStatus({ sqliteSummary: false });
    assert.equal((await repositoryModule.getSqliteRecord('wipes', 'wipe_sqlite_delete_target')).status, 'closed');
    assert.equal((await repositoryModule.getSqliteRecord('wipeParticipants', 'participant_sqlite_wipe_delete_target')).wipeId, 'wipe_sqlite_delete_target');
    assert.equal((await repositoryModule.getSqliteRecord('kdaRows', 'kda_sqlite_wipe_delete_target')).wipeId, 'wipe_sqlite_delete_target');
    assert.equal((await repositoryModule.getSqliteRecord('kdaSnapshots', 'kda_snapshot_sqlite_wipe_delete_target')).wipeId, 'wipe_sqlite_delete_target');
    assert.equal((await repositoryModule.getSqliteRecord('wipeSettlements', 'settlement_sqlite_wipe_delete_target')).wipeId, 'wipe_sqlite_delete_target');
    assert.equal((await repositoryModule.getSqliteRecord('uploads', screenshotUpload.id)).ownerId, 'wipe_sqlite_delete_target');
    assert.equal((await repositoryModule.getSqliteRecord('uploads', mapUpload.id)).ownerId, 'wipe_sqlite_delete_target');
    assert.equal((await stat(screenshotPath)).isFile(), true);
    assert.equal((await stat(mapPath)).isFile(), true);
    assert.equal(afterDeleteFailureStat.mtimeMs, beforeDeleteFailureStat.mtimeMs);
    assert.equal(afterDeleteFailureStatus.metrics.writes.total, beforeDeleteFailureStatus.metrics.writes.total);
    assert.equal(afterDeleteFailureStatus.metrics.sqliteWrites, beforeDeleteFailureStatus.metrics.sqliteWrites);
    assert.equal(writeCount(afterDeleteFailureStatus, 'wipe_delete'), beforeDeleteFailureWrite);
    assert.equal(queryCount(afterDeleteFailureStatus, 'read_store_full'), beforeDeleteFailureReadStoreFull);

    const beforeDeleteStat = await stat(storeModule.STORE_FILE);
    const beforeDeleteStatus = await storeModule.storeRuntimeStatus({ sqliteSummary: false });
    const beforeWipeDeleteWrite = writeCount(beforeDeleteStatus, 'wipe_delete');
    const beforeWipeDeleteLogTrimWrite = writeCount(beforeDeleteStatus, 'wipe_delete_log_trim');
    const deleteResponse = await httpFetch(`${baseUrl}/wipes/wipe_sqlite_delete_target`, {
      method: 'DELETE',
      headers: { cookie }
    });
    const deletePayload = await deleteResponse.json();
    assert.equal(deleteResponse.status, 200, JSON.stringify(deletePayload));
    assert.equal(deletePayload.wipes.some((wipe) => wipe.id === 'wipe_sqlite_delete_target'), false);

    assert.equal(await repositoryModule.getSqliteRecord('wipes', 'wipe_sqlite_delete_target'), null);
    assert.equal(await repositoryModule.getSqliteRecord('wipeParticipants', 'participant_sqlite_wipe_delete_target'), null);
    assert.equal(await repositoryModule.getSqliteRecord('kdaRows', 'kda_sqlite_wipe_delete_target'), null);
    assert.equal(await repositoryModule.getSqliteRecord('kdaSnapshots', 'kda_snapshot_sqlite_wipe_delete_target'), null);
    assert.equal(await repositoryModule.getSqliteRecord('wipeSettlements', 'settlement_sqlite_wipe_delete_target'), null);
    assert.equal(await repositoryModule.getSqliteRecord('uploads', screenshotUpload.id), null);
    assert.equal(await repositoryModule.getSqliteRecord('uploads', mapUpload.id), null);
    assert.equal((await repositoryModule.getSqliteRecord('wipes', 'wipe_sqlite_delete_other')).status, 'closed');
    assert.equal((await repositoryModule.getSqliteRecord('wipeParticipants', 'participant_sqlite_wipe_delete_other')).wipeId, 'wipe_sqlite_delete_other');
    assert.equal((await repositoryModule.getSqliteRecord('kdaRows', 'kda_sqlite_wipe_delete_other')).kills, 22);
    assert.equal((await repositoryModule.getSqliteRecord('kdaSnapshots', 'kda_snapshot_sqlite_wipe_delete_other')).kills, 22);
    assert.equal((await repositoryModule.getSqliteRecord('wipeSettlements', 'settlement_sqlite_wipe_delete_other')).wipeId, 'wipe_sqlite_delete_other');
    assert.equal((await repositoryModule.getSqliteRecord('uploads', 'upload_sqlite_wipe_delete_other')).ownerId, 'wipe_sqlite_delete_other');
    assert.equal((await repositoryModule.getSqliteRecord('uploads', 'upload_sqlite_wipe_delete_same_owner_non_wipe')).ownerType, 'member');
    await assert.rejects(() => stat(screenshotPath), /ENOENT/);
    await assert.rejects(() => stat(mapPath), /ENOENT/);

    const logs = await repositoryModule.getSqliteCollection('logs', { limit: 0 });
    const afterDeleteStat = await stat(storeModule.STORE_FILE);
    const afterDeleteStatus = await storeModule.storeRuntimeStatus({ sqliteSummary: false });
    assert.equal(logs.some((log) => log.type === 'wipe_delete' && log.targetId === 'wipe_sqlite_delete_target'), true);
    assert.equal(afterDeleteStat.mtimeMs, beforeDeleteStat.mtimeMs);
    assert.equal(afterDeleteStatus.metrics.writes.total, beforeDeleteStatus.metrics.writes.total);
    assert.equal(afterDeleteStatus.metrics.sqliteWrites, beforeDeleteStatus.metrics.sqliteWrites);
    assert.equal(writeCount(afterDeleteStatus, 'wipe_delete'), beforeWipeDeleteWrite + 1);
    assert.equal(writeCount(afterDeleteStatus, 'wipe_delete_log_trim'), beforeWipeDeleteLogTrimWrite);
  } finally {
    if (server) await new Promise((resolve) => server.close(resolve));
    globalThis.fetch = originalFetch;
    const sqliteModule = await import('../server/storage/sqlite.js');
    await sqliteModule.closeSqliteDatabasesForTests();
    Object.assign(process.env, previousEnv);
    for (const [key, value] of Object.entries(previousEnv)) {
      if (value === undefined) delete process.env[key];
    }
    await rm(dataDir, { recursive: true, force: true });
  }
});

test('sqlite-primary wipe uploads use direct SQLite patch writes', async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'nb-clan-sqlite-wipe-uploads-'));
  const previousEnv = {
    NB_DATA_DIR: process.env.NB_DATA_DIR,
    NB_ROOT_PASSWORD: process.env.NB_ROOT_PASSWORD,
    NB_STORAGE_MODE: process.env.NB_STORAGE_MODE,
    NB_SQLITE_FILE: process.env.NB_SQLITE_FILE,
    NB_DISABLE_BACKGROUND_JOBS: process.env.NB_DISABLE_BACKGROUND_JOBS,
    NB_DISABLE_EXTERNAL_VITAL: process.env.NB_DISABLE_EXTERNAL_VITAL
  };
  const httpFetch = globalThis.fetch.bind(globalThis);
  process.env.NB_DATA_DIR = dataDir;
  process.env.NB_ROOT_PASSWORD = 'RootPass123!';
  process.env.NB_STORAGE_MODE = 'sqlite-primary';
  process.env.NB_SQLITE_FILE = path.join(dataDir, 'nb-clan.sqlite');
  process.env.NB_DISABLE_BACKGROUND_JOBS = '1';
  process.env.NB_DISABLE_EXTERNAL_VITAL = '1';

  let server = null;
  try {
    const storeModule = await uniqueImport('../server/store.js');
    const apiModule = await uniqueImport('../server/api.js');
    const authModule = await uniqueImport('../server/auth.js');
    await storeModule.ensureStore();
    const createdAt = '2026-07-02T00:00:00.000Z';
    await storeModule.updateStore((store) => {
      store.wipes.unshift({
        id: 'wipe_sqlite_upload_direct',
        name: 'SQLite Upload Direct Wipe',
        serverName: 'SQLite Upload Server',
        status: 'active',
        startedAt: createdAt,
        closedAt: '',
        vitalServerId: '',
        vitalWipeId: '',
        battlemetricsId: '',
        kdaUrl: '',
        rustMapsLink: '',
        rustMapsImageUrl: '/uploads/map-files/sqlite-rustmaps-existing.png',
        rustMapsImageSourceUrl: 'https://content.rustmaps.com/maps/sqlite-upload/icons/map_icons.png',
        rustMapsImageUpdatedAt: createdAt,
        createdAt,
        updatedAt: createdAt
      });
      store.uploads.unshift({
        id: 'upload_sqlite_rustmaps_existing',
        ownerType: 'wipe',
        ownerId: 'wipe_sqlite_upload_direct',
        kind: 'map_image',
        source: 'rustmaps',
        fileName: 'sqlite-rustmaps-existing.png',
        originalName: 'RustMaps full map & icons.png',
        mimeType: 'image/png',
        size: 3,
        url: '/uploads/map-files/sqlite-rustmaps-existing.png',
        externalPageUrl: 'https://rustmaps.com/map/sqlite-upload',
        externalImageUrl: 'https://content.rustmaps.com/maps/sqlite-upload/icons/map_icons.png',
        createdBy: 'user_root',
        createdAt
      });
    });

    const app = express();
    app.use('/api', apiModule.createApiRouter());
    server = createServer(app);
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const baseUrl = `http://127.0.0.1:${server.address().port}/api`;
    const sessionId = await authModule.createSession('user_root');
    const cookie = `nb_session=${encodeURIComponent(sessionId)}`;
    const queryCount = (status, name) => status.sqlite?.queries?.byName?.[name]?.total || 0;
    const writeCount = (status, name) => status.sqlite?.writes?.byName?.[name]?.total || 0;
    const imageDataUrl = `data:image/png;base64,${Buffer.from('png').toString('base64')}`;
    const repositoryModule = await import('../server/storage/repository.js');
    const apiRuntimeStoreModule = await import('../server/store.js');
    const runtimeDataDir = apiRuntimeStoreModule.DATA_DIR;
    const listUploadFiles = async (dir) => {
      try {
        return await readdir(dir);
      } catch (error) {
        if (error?.code === 'ENOENT') return [];
        throw error;
      }
    };

    const beforeRustMapsClearFailureStatus = await storeModule.storeRuntimeStatus({ sqliteSummary: false });
    const beforeRustMapsClearFailureReadStoreFull = queryCount(beforeRustMapsClearFailureStatus, 'read_store_full');
    const beforeRustMapsClearFailureStat = await stat(storeModule.STORE_FILE);
    const beforeRustMapsClearFailureWrite = writeCount(beforeRustMapsClearFailureStatus, 'rustmaps_image_clear');
    repositoryModule.injectSqliteStorePatchFailureForTests('rustmaps_image_clear', 1);
    process.env.NB_DISABLE_BACKGROUND_JOBS = '0';
    const failedRustMapsClearResponse = await httpFetch(`${baseUrl}/wipes/wipe_sqlite_upload_direct`, {
      method: 'PUT',
      headers: {
        cookie,
        'content-type': 'application/json'
      },
      body: JSON.stringify({
        name: 'SQLite Upload Direct Wipe Failed RustMaps Clear',
        serverName: 'SQLite Upload Server',
        startedAt: createdAt
      })
    });
    const failedRustMapsClearPayload = await failedRustMapsClearResponse.json();
    assert.equal(failedRustMapsClearResponse.status, 200, JSON.stringify(failedRustMapsClearPayload));
    await apiModule.drainBackgroundTaskQueuesForTests({ timeoutMs: 2000 });
    process.env.NB_DISABLE_BACKGROUND_JOBS = '1';
    const afterRustMapsClearFailureStatus = await storeModule.storeRuntimeStatus({ sqliteSummary: false });
    const afterRustMapsClearFailureStat = await stat(storeModule.STORE_FILE);
    assert.equal(Boolean(await repositoryModule.getSqliteRecord('uploads', 'upload_sqlite_rustmaps_existing')), true);
    assert.equal(afterRustMapsClearFailureStat.mtimeMs, beforeRustMapsClearFailureStat.mtimeMs);
    assert.equal(afterRustMapsClearFailureStatus.metrics.writes.total, beforeRustMapsClearFailureStatus.metrics.writes.total);
    assert.equal(afterRustMapsClearFailureStatus.metrics.sqliteWrites, beforeRustMapsClearFailureStatus.metrics.sqliteWrites);
    assert.equal(writeCount(afterRustMapsClearFailureStatus, 'rustmaps_image_clear'), beforeRustMapsClearFailureWrite);
    assert.equal(queryCount(afterRustMapsClearFailureStatus, 'read_store_full'), beforeRustMapsClearFailureReadStoreFull);

    const beforeEditStatus = await storeModule.storeRuntimeStatus({ sqliteSummary: false });
    process.env.NB_DISABLE_BACKGROUND_JOBS = '0';
    const editResponse = await httpFetch(`${baseUrl}/wipes/wipe_sqlite_upload_direct`, {
      method: 'PUT',
      headers: {
        cookie,
        'content-type': 'application/json'
      },
      body: JSON.stringify({
        name: 'SQLite Upload Direct Wipe Edited',
        serverName: 'SQLite Upload Server',
        startedAt: createdAt
      })
    });
    const editPayload = await editResponse.json();
    assert.equal(editResponse.status, 200, JSON.stringify(editPayload));
    assert.equal(editPayload.wipe.name, 'SQLite Upload Direct Wipe Edited');
    await apiModule.drainBackgroundTaskQueuesForTests({ timeoutMs: 2000 });
    process.env.NB_DISABLE_BACKGROUND_JOBS = '1';
    assert.equal(await repositoryModule.getSqliteRecord('uploads', 'upload_sqlite_rustmaps_existing'), null);
    const afterEditStatus = await storeModule.storeRuntimeStatus({ sqliteSummary: false });
    assert.equal(queryCount(afterEditStatus, 'list_uploads'), queryCount(beforeEditStatus, 'list_uploads'));
    assert.equal(queryCount(afterEditStatus, 'list_uploads_ownerId') > queryCount(beforeEditStatus, 'list_uploads_ownerId'), true);

    const screenshotUploadDir = path.join(runtimeDataDir, 'uploads', 'server-screenshots');
    const beforeUploadFailureStatus = await storeModule.storeRuntimeStatus({ sqliteSummary: false });
    const beforeUploadFailureReadStoreFull = queryCount(beforeUploadFailureStatus, 'read_store_full');
    const beforeUploadFailureStat = await stat(storeModule.STORE_FILE);
    const beforeUploadFailureWrite = writeCount(beforeUploadFailureStatus, 'wipe_screenshot_upload');
    repositoryModule.injectSqliteStorePatchFailureForTests('wipe_screenshot_upload', 1);
    const failedScreenshotResponse = await httpFetch(`${baseUrl}/wipes/wipe_sqlite_upload_direct/screenshots`, {
      method: 'POST',
      headers: {
        cookie,
        'content-type': 'application/json'
      },
      body: JSON.stringify({
        mimeType: 'image/png',
        originalName: 'sqlite-screenshot-failed.png',
        dataUrl: imageDataUrl
      })
    });
    const failedScreenshotPayload = await failedScreenshotResponse.json();
    assert.equal(failedScreenshotResponse.status, 503, JSON.stringify(failedScreenshotPayload));
    assert.match(failedScreenshotPayload.error, /档期附件写入暂不可用/);
    const failedScreenshotUploads = await repositoryModule.getSqliteCollection('uploads', { limit: 0 });
    const afterUploadFailureStatus = await storeModule.storeRuntimeStatus({ sqliteSummary: false });
    const afterUploadFailureStat = await stat(storeModule.STORE_FILE);
    assert.equal(failedScreenshotUploads.some((upload) => upload.originalName === 'sqlite-screenshot-failed.png'), false);
    assert.deepEqual(await listUploadFiles(screenshotUploadDir), []);
    assert.equal(afterUploadFailureStat.mtimeMs, beforeUploadFailureStat.mtimeMs);
    assert.equal(afterUploadFailureStatus.metrics.writes.total, beforeUploadFailureStatus.metrics.writes.total);
    assert.equal(afterUploadFailureStatus.metrics.sqliteWrites, beforeUploadFailureStatus.metrics.sqliteWrites);
    assert.equal(writeCount(afterUploadFailureStatus, 'wipe_screenshot_upload'), beforeUploadFailureWrite);
    assert.equal(queryCount(afterUploadFailureStatus, 'read_store_full'), beforeUploadFailureReadStoreFull);

    const beforeStatus = await storeModule.storeRuntimeStatus({ sqliteSummary: false });
    const beforeStat = await stat(storeModule.STORE_FILE);
    const beforeReadStoreFull = queryCount(beforeStatus, 'read_store_full');
    const beforeListUploads = queryCount(beforeStatus, 'list_uploads');
    const beforeUploadsByOwnerId = queryCount(beforeStatus, 'list_uploads_ownerId');
    const beforeWipeScreenshotUploadWrite = writeCount(beforeStatus, 'wipe_screenshot_upload');
    const beforeWipeScreenshotUploadLogTrimWrite = writeCount(beforeStatus, 'wipe_screenshot_upload_log_trim');
    const beforeWipeMapUploadWrite = writeCount(beforeStatus, 'wipe_map_upload');
    const beforeWipeMapUploadLogTrimWrite = writeCount(beforeStatus, 'wipe_map_upload_log_trim');
    const beforeWipeScreenshotDeleteWrite = writeCount(beforeStatus, 'wipe_screenshot_delete');
    const beforeWipeScreenshotDeleteLogTrimWrite = writeCount(beforeStatus, 'wipe_screenshot_delete_log_trim');
    const beforeWipeMapDeleteWrite = writeCount(beforeStatus, 'wipe_map_delete');
    const beforeWipeMapDeleteLogTrimWrite = writeCount(beforeStatus, 'wipe_map_delete_log_trim');

    const screenshotResponse = await httpFetch(`${baseUrl}/wipes/wipe_sqlite_upload_direct/screenshots`, {
      method: 'POST',
      headers: {
        cookie,
        'content-type': 'application/json'
      },
      body: JSON.stringify({
        mimeType: 'image/png',
        originalName: 'sqlite-screenshot.png',
        dataUrl: imageDataUrl
      })
    });
    const screenshotPayload = await screenshotResponse.json();
    assert.equal(screenshotResponse.status, 200, JSON.stringify(screenshotPayload));
    const screenshot = screenshotPayload.wipe.screenshots.find((upload) => upload.originalName === 'sqlite-screenshot.png');
    assert.equal(Boolean(screenshot?.id), true);

    const mapResponse = await httpFetch(`${baseUrl}/wipes/wipe_sqlite_upload_direct/map-files`, {
      method: 'POST',
      headers: {
        cookie,
        'content-type': 'application/json'
      },
      body: JSON.stringify({
        kind: 'map_image',
        mimeType: 'image/png',
        originalName: 'sqlite-map.png',
        dataUrl: imageDataUrl
      })
    });
    const mapPayload = await mapResponse.json();
    assert.equal(mapResponse.status, 200, JSON.stringify(mapPayload));
    const mapUpload = mapPayload.wipe.mapFiles.find((upload) => upload.originalName === 'sqlite-map.png');
    assert.equal(Boolean(mapUpload?.id), true);

    const screenshotRecord = await repositoryModule.getSqliteRecord('uploads', screenshot.id);
    const mapRecord = await repositoryModule.getSqliteRecord('uploads', mapUpload.id);
    assert.equal(screenshotRecord.ownerId, 'wipe_sqlite_upload_direct');
    assert.equal(screenshotRecord.kind, 'server_screenshot');
    assert.equal(mapRecord.ownerId, 'wipe_sqlite_upload_direct');
    assert.equal(mapRecord.kind, 'map_image');
    const screenshotPath = path.join(screenshotUploadDir, path.basename(screenshot.url));
    assert.equal((await stat(screenshotPath)).isFile(), true);

    const beforeUploadDeleteFailureStatus = await storeModule.storeRuntimeStatus({ sqliteSummary: false });
    const beforeUploadDeleteFailureReadStoreFull = queryCount(beforeUploadDeleteFailureStatus, 'read_store_full');
    const beforeUploadDeleteFailureStat = await stat(storeModule.STORE_FILE);
    const beforeUploadDeleteFailureWrite = writeCount(beforeUploadDeleteFailureStatus, 'wipe_screenshot_delete');
    repositoryModule.injectSqliteStorePatchFailureForTests('wipe_screenshot_delete', 1);
    const failedDeleteScreenshotResponse = await httpFetch(`${baseUrl}/wipes/wipe_sqlite_upload_direct/screenshots/${screenshot.id}`, {
      method: 'DELETE',
      headers: { cookie }
    });
    const failedDeleteScreenshotPayload = await failedDeleteScreenshotResponse.json();
    assert.equal(failedDeleteScreenshotResponse.status, 503, JSON.stringify(failedDeleteScreenshotPayload));
    assert.match(failedDeleteScreenshotPayload.error, /档期附件删除写入暂不可用/);
    const afterUploadDeleteFailureStatus = await storeModule.storeRuntimeStatus({ sqliteSummary: false });
    const afterUploadDeleteFailureStat = await stat(storeModule.STORE_FILE);
    assert.equal((await repositoryModule.getSqliteRecord('uploads', screenshot.id)).ownerId, 'wipe_sqlite_upload_direct');
    assert.equal((await stat(screenshotPath)).isFile(), true);
    assert.equal(afterUploadDeleteFailureStat.mtimeMs, beforeUploadDeleteFailureStat.mtimeMs);
    assert.equal(afterUploadDeleteFailureStatus.metrics.writes.total, beforeUploadDeleteFailureStatus.metrics.writes.total);
    assert.equal(afterUploadDeleteFailureStatus.metrics.sqliteWrites, beforeUploadDeleteFailureStatus.metrics.sqliteWrites);
    assert.equal(writeCount(afterUploadDeleteFailureStatus, 'wipe_screenshot_delete'), beforeUploadDeleteFailureWrite);
    assert.equal(queryCount(afterUploadDeleteFailureStatus, 'read_store_full'), beforeUploadDeleteFailureReadStoreFull);

    const deleteScreenshotResponse = await httpFetch(`${baseUrl}/wipes/wipe_sqlite_upload_direct/screenshots/${screenshot.id}`, {
      method: 'DELETE',
      headers: { cookie }
    });
    const deleteScreenshotPayload = await deleteScreenshotResponse.json();
    assert.equal(deleteScreenshotResponse.status, 200, JSON.stringify(deleteScreenshotPayload));
    assert.equal(deleteScreenshotPayload.wipe.screenshots.some((upload) => upload.id === screenshot.id), false);

    const deleteMapResponse = await httpFetch(`${baseUrl}/wipes/wipe_sqlite_upload_direct/map-files/${mapUpload.id}`, {
      method: 'DELETE',
      headers: { cookie }
    });
    const deleteMapPayload = await deleteMapResponse.json();
    assert.equal(deleteMapResponse.status, 200, JSON.stringify(deleteMapPayload));
    assert.equal(deleteMapPayload.wipe.mapFiles.some((upload) => upload.id === mapUpload.id), false);

    const afterStatus = await storeModule.storeRuntimeStatus({ sqliteSummary: false });
    const afterStat = await stat(storeModule.STORE_FILE);
    assert.equal(afterStat.mtimeMs, beforeStat.mtimeMs);
    assert.equal(afterStatus.metrics.sqliteWrites, beforeStatus.metrics.sqliteWrites);
    assert.equal(afterStatus.metrics.writes.total, beforeStatus.metrics.writes.total);
    assert.equal(queryCount(afterStatus, 'read_store_full'), beforeReadStoreFull);
    assert.equal(queryCount(afterStatus, 'list_uploads') <= beforeListUploads + 1, true);
    assert.equal(queryCount(afterStatus, 'list_uploads_ownerId') > beforeUploadsByOwnerId, true);
    assert.equal(writeCount(afterStatus, 'wipe_screenshot_upload'), beforeWipeScreenshotUploadWrite + 1);
    assert.equal(writeCount(afterStatus, 'wipe_screenshot_upload_log_trim'), beforeWipeScreenshotUploadLogTrimWrite);
    assert.equal(writeCount(afterStatus, 'wipe_map_upload'), beforeWipeMapUploadWrite + 1);
    assert.equal(writeCount(afterStatus, 'wipe_map_upload_log_trim'), beforeWipeMapUploadLogTrimWrite);
    assert.equal(writeCount(afterStatus, 'wipe_screenshot_delete'), beforeWipeScreenshotDeleteWrite + 1);
    assert.equal(writeCount(afterStatus, 'wipe_screenshot_delete_log_trim'), beforeWipeScreenshotDeleteLogTrimWrite);
    assert.equal(writeCount(afterStatus, 'wipe_map_delete'), beforeWipeMapDeleteWrite + 1);
    assert.equal(writeCount(afterStatus, 'wipe_map_delete_log_trim'), beforeWipeMapDeleteLogTrimWrite);
    assert.equal(await repositoryModule.getSqliteRecord('uploads', screenshot.id), null);
    assert.equal(await repositoryModule.getSqliteRecord('uploads', mapUpload.id), null);
    const logs = await repositoryModule.getSqliteCollection('logs', { limit: 0 });
    assert.equal(logs.some((log) => log.type === 'wipe_screenshot_upload' && log.targetId === 'wipe_sqlite_upload_direct'), true);
    assert.equal(logs.some((log) => log.type === 'wipe_screenshot_delete' && log.targetId === 'wipe_sqlite_upload_direct'), true);
    assert.equal(logs.some((log) => log.type === 'wipe_map_upload' && log.targetId === 'wipe_sqlite_upload_direct'), true);
    assert.equal(logs.some((log) => log.type === 'wipe_map_delete' && log.targetId === 'wipe_sqlite_upload_direct'), true);
    await assert.rejects(
      () => stat(path.join(runtimeDataDir, 'uploads', 'server-screenshots', path.basename(screenshot.url))),
      /ENOENT/
    );
    await assert.rejects(
      () => stat(path.join(runtimeDataDir, 'uploads', 'map-files', path.basename(mapUpload.url))),
      /ENOENT/
    );
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

test('sqlite-primary web member deletes use direct SQLite patch writes', async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'nb-clan-sqlite-web-member-delete-'));
  const previousEnv = {
    NB_DATA_DIR: process.env.NB_DATA_DIR,
    NB_ROOT_PASSWORD: process.env.NB_ROOT_PASSWORD,
    NB_STORAGE_MODE: process.env.NB_STORAGE_MODE,
    NB_SQLITE_FILE: process.env.NB_SQLITE_FILE,
    NB_DISABLE_BACKGROUND_JOBS: process.env.NB_DISABLE_BACKGROUND_JOBS,
    NB_DISABLE_EXTERNAL_VITAL: process.env.NB_DISABLE_EXTERNAL_VITAL,
    NB_RUSTPLUS_RELAY_CHAT_FLUSH_INTERVAL_MS: process.env.NB_RUSTPLUS_RELAY_CHAT_FLUSH_INTERVAL_MS
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

  let server = null;
  try {
    const storeModule = await uniqueImport('../server/store.js');
    const apiModule = await uniqueImport('../server/api.js');
    const authModule = await uniqueImport('../server/auth.js');
    await storeModule.ensureStore();
    const createdAt = '2026-07-02T00:00:00.000Z';
    const closedAt = '2026-07-03T00:00:00.000Z';
    await storeModule.updateStore((store) => {
      store.squads.push({
        id: 'squad_sqlite_web_delete',
        name: 'SQLite Web Delete Squad',
        leaderUserIds: [],
        createdAt,
        updatedAt: createdAt
      });
      store.wipes.push({
        id: 'wipe_sqlite_web_delete_live',
        name: 'SQLite Web Delete Live',
        status: 'active',
        startedAt: createdAt,
        createdAt,
        updatedAt: createdAt
      }, {
        id: 'wipe_sqlite_web_delete_closed',
        name: 'SQLite Web Delete Closed',
        status: 'closed',
        startedAt: createdAt,
        closedAt,
        createdAt,
        updatedAt: closedAt
      });
      store.members.push({
        id: 'member_sqlite_web_bulk_delete_1',
        steamId: '76561198004444441',
        rawInput: '76561198004444441',
        customName: 'SQLite Web Bulk Delete 1',
        steamNickname: 'SQLite Web Bulk Delete 1',
        avatar: '',
        discordId: '',
        wechatId: '',
        notes: '',
        specialty: [],
        memberStatus: 'active',
        invitedByUserId: 'user_root',
        createdAt,
        updatedAt: createdAt
      }, {
        id: 'member_sqlite_web_bulk_delete_2',
        steamId: '76561198004444442',
        rawInput: '76561198004444442',
        customName: 'SQLite Web Bulk Delete 2',
        steamNickname: 'SQLite Web Bulk Delete 2',
        avatar: '',
        discordId: '',
        wechatId: '',
        notes: '',
        specialty: [],
        memberStatus: 'active',
        invitedByUserId: 'user_root',
        createdAt,
        updatedAt: createdAt
      }, {
        id: 'member_sqlite_web_single_delete',
        steamId: '76561198004444443',
        rawInput: '76561198004444443',
        customName: 'SQLite Web Single Delete',
        steamNickname: 'SQLite Web Single Delete',
        avatar: '',
        discordId: '',
        wechatId: '',
        notes: '',
        specialty: [],
        memberStatus: 'active',
        invitedByUserId: 'user_root',
        createdAt,
        updatedAt: createdAt
      });
      store.squadMembers.push({
        id: 'squad_member_sqlite_web_bulk_delete_1',
        squadId: 'squad_sqlite_web_delete',
        memberId: 'member_sqlite_web_bulk_delete_1',
        addedByUserId: 'user_root',
        createdAt
      }, {
        id: 'squad_member_sqlite_web_bulk_delete_2',
        squadId: 'squad_sqlite_web_delete',
        memberId: 'member_sqlite_web_bulk_delete_2',
        addedByUserId: 'user_root',
        createdAt
      }, {
        id: 'squad_member_sqlite_web_single_delete',
        squadId: 'squad_sqlite_web_delete',
        memberId: 'member_sqlite_web_single_delete',
        addedByUserId: 'user_root',
        createdAt
      });
      store.wipeParticipants.push({
        id: 'participant_sqlite_web_bulk_live_1',
        wipeId: 'wipe_sqlite_web_delete_live',
        memberId: 'member_sqlite_web_bulk_delete_1',
        squadId: 'squad_sqlite_web_delete',
        status: 'on_time',
        createdAt,
        updatedAt: createdAt
      }, {
        id: 'participant_sqlite_web_bulk_live_steam_only_1',
        wipeId: 'wipe_sqlite_web_delete_live',
        memberId: 'legacy_sqlite_web_bulk_delete_1',
        steamId: '76561198004444441',
        squadId: 'squad_sqlite_web_delete',
        status: 'on_time',
        createdAt,
        updatedAt: createdAt
      }, {
        id: 'participant_sqlite_web_bulk_closed_1',
        wipeId: 'wipe_sqlite_web_delete_closed',
        memberId: 'member_sqlite_web_bulk_delete_1',
        steamId: '76561198004444441',
        squadId: 'squad_sqlite_web_delete',
        status: 'on_time',
        createdAt,
        updatedAt: closedAt
      });
      store.kdaRows.push({
        id: 'kda_sqlite_web_bulk_live_1',
        wipeId: 'wipe_sqlite_web_delete_live',
        memberId: 'member_sqlite_web_bulk_delete_1',
        steamId: '',
        kills: 3,
        syncedAt: createdAt
      }, {
        id: 'kda_sqlite_web_bulk_live_steam_only_1',
        wipeId: 'wipe_sqlite_web_delete_live',
        memberId: 'legacy_sqlite_web_bulk_delete_1',
        steamId: '76561198004444441',
        kills: 4,
        syncedAt: createdAt
      }, {
        id: 'kda_sqlite_web_bulk_closed_1',
        wipeId: 'wipe_sqlite_web_delete_closed',
        memberId: 'member_sqlite_web_bulk_delete_1',
        steamId: '76561198004444441',
        kills: 8,
        syncedAt: closedAt
      });
      store.kdaSnapshots.push({
        id: 'kda_snapshot_sqlite_web_bulk_live_2',
        wipeId: 'wipe_sqlite_web_delete_live',
        memberId: 'member_sqlite_web_bulk_delete_2',
        steamId: '76561198004444442',
        kills: 5,
        capturedAt: createdAt
      }, {
        id: 'kda_snapshot_sqlite_web_bulk_live_steam_only_2',
        wipeId: 'wipe_sqlite_web_delete_live',
        memberId: 'legacy_sqlite_web_bulk_delete_2',
        steamId: '76561198004444442',
        kills: 6,
        capturedAt: createdAt
      }, {
        id: 'kda_snapshot_sqlite_web_bulk_closed_2',
        wipeId: 'wipe_sqlite_web_delete_closed',
        memberId: 'member_sqlite_web_bulk_delete_2',
        steamId: '76561198004444442',
        kills: 9,
        capturedAt: closedAt
      });
      store.memberProfiles.push({
        id: 'member_profile_sqlite_web_bulk_delete_1',
        memberId: 'member_sqlite_web_bulk_delete_1',
        steamId: '76561198004444441',
        fetchedAt: createdAt
      }, {
        id: 'member_profile_sqlite_web_single_delete',
        memberId: 'member_sqlite_web_single_delete',
        steamId: '76561198004444443',
        fetchedAt: createdAt
      });
      store.accountAlertDismissals ||= [];
      store.accountAlertDismissals.push({
        id: 'alert_sqlite_web_bulk_delete_1',
        memberId: 'member_sqlite_web_bulk_delete_1',
        type: 'private-inventory',
        dismissedAt: createdAt,
        dismissedByUserId: 'user_root'
      });
      store.users.push({
        id: 'user_sqlite_web_bulk_member',
        username: 'sqlite_web_bulk_member',
        role: 'member',
        boundSteamId: '76561198004444441',
        createdAt,
        updatedAt: createdAt
      }, {
        id: 'user_sqlite_web_bulk_manager',
        username: 'sqlite_web_bulk_manager',
        role: 'member_manager',
        boundSteamId: '76561198004444442',
        createdAt,
        updatedAt: createdAt
      });
      store.sessions.push({
        id: 'session_sqlite_web_bulk_member',
        userId: 'user_sqlite_web_bulk_member',
        tokenHash: 'session_hash_sqlite_web_bulk_member',
        createdAt,
        expiresAt: new Date(Date.now() + 86_400_000).toISOString()
      }, {
        id: 'session_sqlite_web_bulk_manager',
        userId: 'user_sqlite_web_bulk_manager',
        tokenHash: 'session_hash_sqlite_web_bulk_manager',
        createdAt,
        expiresAt: new Date(Date.now() + 86_400_000).toISOString()
      });
    });

    const app = express();
    app.use('/api', apiModule.createApiRouter());
    server = createServer(app);
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const baseUrl = `http://127.0.0.1:${server.address().port}/api`;
    const sessionId = await authModule.createSession('user_root');
    const cookie = `nb_session=${encodeURIComponent(sessionId)}`;

    const repositoryModule = await import('../server/storage/repository.js');
	    const queryCount = (status, name) => status.sqlite?.queries?.byName?.[name]?.total || 0;
	    const writeCount = (status, name) => status.sqlite?.writes?.byName?.[name]?.total || 0;
	    const beforeBulkFailureStatus = await storeModule.storeRuntimeStatus({ sqliteSummary: false });
	    const beforeBulkFailureReadStoreFull = queryCount(beforeBulkFailureStatus, 'read_store_full');
	    repositoryModule.injectSqliteStorePatchFailureForTests('member_bulk_delete', 1);
	    const failedBulkDeleteResponse = await httpFetch(`${baseUrl}/members?response=minimal`, {
	      method: 'DELETE',
	      headers: {
	        cookie,
	        'content-type': 'application/json'
	      },
	      body: JSON.stringify({ memberIds: ['member_sqlite_web_bulk_delete_1', 'member_sqlite_web_bulk_delete_2'] })
	    });
	    const failedBulkDeletePayload = await failedBulkDeleteResponse.json();
	    assert.equal(failedBulkDeleteResponse.status, 503);
	    assert.match(failedBulkDeletePayload.error, /成员批量删除写入暂不可用/);
	    const afterBulkFailureStatus = await storeModule.storeRuntimeStatus({ sqliteSummary: false });
	    assert.equal(queryCount(afterBulkFailureStatus, 'read_store_full'), beforeBulkFailureReadStoreFull);
	    assert.notEqual(await repositoryModule.getSqliteRecord('members', 'member_sqlite_web_bulk_delete_1'), null);
	    assert.notEqual(await repositoryModule.getSqliteRecord('members', 'member_sqlite_web_bulk_delete_2'), null);

	    const beforeBulkStatus = await storeModule.storeRuntimeStatus({ sqliteSummary: false });
	    const beforeBulkFullReads = {
	      members: queryCount(beforeBulkStatus, 'list_members'),
	      squads: queryCount(beforeBulkStatus, 'list_squads'),
	      wipes: queryCount(beforeBulkStatus, 'list_wipes'),
	      wipeParticipants: queryCount(beforeBulkStatus, 'list_wipeParticipants'),
	      kdaRows: queryCount(beforeBulkStatus, 'list_kdaRows'),
	      kdaSnapshots: queryCount(beforeBulkStatus, 'list_kdaSnapshots')
	    };
	    const beforeBulkScopedReads = {
	      squadsById: queryCount(beforeBulkStatus, 'list_squads_id'),
	      squadMembersByMember: queryCount(beforeBulkStatus, 'list_squadMembers_memberId'),
	      wipesByStatus: queryCount(beforeBulkStatus, 'list_wipes_status'),
	      participantsByWipeMember: queryCount(beforeBulkStatus, 'list_wipeParticipants_wipeId_memberId'),
	      participantsByWipeSteam: queryCount(beforeBulkStatus, 'list_wipeParticipants_wipeId_steamId'),
	      kdaRowsByWipeMember: queryCount(beforeBulkStatus, 'list_kdaRows_wipeId_memberId'),
	      kdaRowsByWipeSteam: queryCount(beforeBulkStatus, 'list_kdaRows_wipeId_steamId'),
	      kdaSnapshotsByWipeMember: queryCount(beforeBulkStatus, 'list_kdaSnapshots_wipeId_memberId'),
	      kdaSnapshotsByWipeSteam: queryCount(beforeBulkStatus, 'list_kdaSnapshots_wipeId_steamId')
	    };
	    const beforeMemberBulkDeleteWrite = writeCount(beforeBulkStatus, 'member_bulk_delete');
	    const beforeMemberBulkDeleteLogTrimWrite = writeCount(beforeBulkStatus, 'member_bulk_delete_log_trim');
    const bulkResponse = await httpFetch(`${baseUrl}/members?response=minimal`, {
      method: 'DELETE',
      headers: {
        cookie,
        'content-type': 'application/json'
      },
      body: JSON.stringify({ memberIds: ['member_sqlite_web_bulk_delete_1', 'member_sqlite_web_bulk_delete_2'] })
    });
    assert.equal(bulkResponse.status, 200);
    const bulkPayload = await bulkResponse.json();
    assert.equal(bulkPayload.deleted, 2);
    assert.deepEqual(bulkPayload.deletedMemberIds, ['member_sqlite_web_bulk_delete_1', 'member_sqlite_web_bulk_delete_2']);
    assert.equal(await repositoryModule.getSqliteRecord('members', 'member_sqlite_web_bulk_delete_1'), null);
    assert.equal(await repositoryModule.getSqliteRecord('members', 'member_sqlite_web_bulk_delete_2'), null);
    assert.equal(await repositoryModule.getSqliteRecord('squadMembers', 'squad_member_sqlite_web_bulk_delete_1'), null);
    assert.equal(await repositoryModule.getSqliteRecord('squadMembers', 'squad_member_sqlite_web_bulk_delete_2'), null);
    assert.equal(await repositoryModule.getSqliteRecord('wipeParticipants', 'participant_sqlite_web_bulk_live_1'), null);
    assert.equal(await repositoryModule.getSqliteRecord('wipeParticipants', 'participant_sqlite_web_bulk_live_steam_only_1'), null);
    assert.equal(await repositoryModule.getSqliteRecord('kdaRows', 'kda_sqlite_web_bulk_live_1'), null);
    assert.equal(await repositoryModule.getSqliteRecord('kdaRows', 'kda_sqlite_web_bulk_live_steam_only_1'), null);
    assert.equal(await repositoryModule.getSqliteRecord('kdaSnapshots', 'kda_snapshot_sqlite_web_bulk_live_2'), null);
    assert.equal(await repositoryModule.getSqliteRecord('kdaSnapshots', 'kda_snapshot_sqlite_web_bulk_live_steam_only_2'), null);
    assert.equal((await repositoryModule.getSqliteRecord('wipeParticipants', 'participant_sqlite_web_bulk_closed_1')).squadId, 'squad_sqlite_web_delete');
    assert.equal((await repositoryModule.getSqliteRecord('kdaRows', 'kda_sqlite_web_bulk_closed_1')).kills, 8);
    assert.equal((await repositoryModule.getSqliteRecord('kdaSnapshots', 'kda_snapshot_sqlite_web_bulk_closed_2')).kills, 9);
    assert.equal(await repositoryModule.getSqliteRecord('memberProfiles', 'member_profile_sqlite_web_bulk_delete_1'), null);
    assert.equal(await repositoryModule.getSqliteRecord('accountAlertDismissals', 'alert_sqlite_web_bulk_delete_1'), null);
    assert.equal(await repositoryModule.getSqliteRecord('users', 'user_sqlite_web_bulk_member'), null);
    assert.equal(await repositoryModule.getSqliteRecord('sessions', 'session_sqlite_web_bulk_member'), null);
    assert.equal((await repositoryModule.getSqliteRecord('users', 'user_sqlite_web_bulk_manager')).role, 'member_manager');
    assert.equal((await repositoryModule.getSqliteRecord('sessions', 'session_sqlite_web_bulk_manager')).userId, 'user_sqlite_web_bulk_manager');
    let logs = await repositoryModule.getSqliteCollection('logs', { limit: 0 });
    const afterBulkStatus = await storeModule.storeRuntimeStatus({ sqliteSummary: false });
	    assert.equal(logs.some((log) => log.type === 'member_bulk_delete' && log.metadata?.deleted === 2), true);
	    assert.equal(afterBulkStatus.metrics.writes.total, beforeBulkStatus.metrics.writes.total);
	    assert.equal(afterBulkStatus.metrics.sqliteWrites, beforeBulkStatus.metrics.sqliteWrites);
	    assert.equal(queryCount(afterBulkStatus, 'list_members'), beforeBulkFullReads.members);
	    assert.equal(queryCount(afterBulkStatus, 'list_squads'), beforeBulkFullReads.squads);
	    assert.equal(queryCount(afterBulkStatus, 'list_wipes'), beforeBulkFullReads.wipes);
	    assert.equal(queryCount(afterBulkStatus, 'list_wipeParticipants'), beforeBulkFullReads.wipeParticipants);
	    assert.equal(queryCount(afterBulkStatus, 'list_kdaRows'), beforeBulkFullReads.kdaRows);
	    assert.equal(queryCount(afterBulkStatus, 'list_kdaSnapshots'), beforeBulkFullReads.kdaSnapshots);
	    assert.equal(queryCount(afterBulkStatus, 'list_squads_id') > beforeBulkScopedReads.squadsById, true);
	    assert.equal(queryCount(afterBulkStatus, 'list_squadMembers_memberId') > beforeBulkScopedReads.squadMembersByMember, true);
	    assert.equal(queryCount(afterBulkStatus, 'list_wipes_status') > beforeBulkScopedReads.wipesByStatus, true);
	    assert.equal(queryCount(afterBulkStatus, 'list_wipeParticipants_wipeId_memberId') > beforeBulkScopedReads.participantsByWipeMember, true);
	    assert.equal(queryCount(afterBulkStatus, 'list_wipeParticipants_wipeId_steamId') > beforeBulkScopedReads.participantsByWipeSteam, true);
	    assert.equal(queryCount(afterBulkStatus, 'list_kdaRows_wipeId_memberId') > beforeBulkScopedReads.kdaRowsByWipeMember, true);
	    assert.equal(queryCount(afterBulkStatus, 'list_kdaRows_wipeId_steamId') > beforeBulkScopedReads.kdaRowsByWipeSteam, true);
	    assert.equal(queryCount(afterBulkStatus, 'list_kdaSnapshots_wipeId_memberId') > beforeBulkScopedReads.kdaSnapshotsByWipeMember, true);
	    assert.equal(queryCount(afterBulkStatus, 'list_kdaSnapshots_wipeId_steamId') > beforeBulkScopedReads.kdaSnapshotsByWipeSteam, true);
	    assert.equal(writeCount(afterBulkStatus, 'member_bulk_delete'), beforeMemberBulkDeleteWrite + 1);
	    assert.equal(writeCount(afterBulkStatus, 'member_bulk_delete_log_trim'), beforeMemberBulkDeleteLogTrimWrite);

	    const beforeSingleFailureStatus = await storeModule.storeRuntimeStatus({ sqliteSummary: false });
	    const beforeSingleFailureReadStoreFull = queryCount(beforeSingleFailureStatus, 'read_store_full');
	    repositoryModule.injectSqliteStorePatchFailureForTests('member_delete', 1);
	    const failedSingleResponse = await httpFetch(`${baseUrl}/members/member_sqlite_web_single_delete?response=minimal`, {
	      method: 'DELETE',
	      headers: { cookie }
	    });
	    const failedSinglePayload = await failedSingleResponse.json();
	    assert.equal(failedSingleResponse.status, 503);
	    assert.match(failedSinglePayload.error, /成员删除写入暂不可用/);
	    const afterSingleFailureStatus = await storeModule.storeRuntimeStatus({ sqliteSummary: false });
	    assert.equal(queryCount(afterSingleFailureStatus, 'read_store_full'), beforeSingleFailureReadStoreFull);
	    assert.notEqual(await repositoryModule.getSqliteRecord('members', 'member_sqlite_web_single_delete'), null);

	    const beforeSingleStatus = await storeModule.storeRuntimeStatus({ sqliteSummary: false });
	    const beforeSingleFullReads = {
	      squads: queryCount(beforeSingleStatus, 'list_squads'),
	      wipes: queryCount(beforeSingleStatus, 'list_wipes'),
	      wipeParticipants: queryCount(beforeSingleStatus, 'list_wipeParticipants'),
	      kdaRows: queryCount(beforeSingleStatus, 'list_kdaRows'),
	      kdaSnapshots: queryCount(beforeSingleStatus, 'list_kdaSnapshots')
	    };
	    const beforeMemberDeleteWrite = writeCount(beforeSingleStatus, 'member_delete');
	    const beforeMemberDeleteLogTrimWrite = writeCount(beforeSingleStatus, 'member_delete_log_trim');
    const singleResponse = await httpFetch(`${baseUrl}/members/member_sqlite_web_single_delete?response=minimal`, {
      method: 'DELETE',
      headers: { cookie }
    });
    assert.equal(singleResponse.status, 200);
    const singlePayload = await singleResponse.json();
    assert.equal(singlePayload.deleted, 1);
    assert.equal(singlePayload.deletedMemberId, 'member_sqlite_web_single_delete');
    assert.equal(await repositoryModule.getSqliteRecord('members', 'member_sqlite_web_single_delete'), null);
    assert.equal(await repositoryModule.getSqliteRecord('squadMembers', 'squad_member_sqlite_web_single_delete'), null);
    assert.equal(await repositoryModule.getSqliteRecord('memberProfiles', 'member_profile_sqlite_web_single_delete'), null);
    logs = await repositoryModule.getSqliteCollection('logs', { limit: 0 });
    const afterSingleStatus = await storeModule.storeRuntimeStatus({ sqliteSummary: false });
	    assert.equal(logs.some((log) => log.type === 'member_delete' && log.targetId === 'member_sqlite_web_single_delete'), true);
	    assert.equal(afterSingleStatus.metrics.writes.total, beforeSingleStatus.metrics.writes.total);
	    assert.equal(afterSingleStatus.metrics.sqliteWrites, beforeSingleStatus.metrics.sqliteWrites);
	    assert.equal(queryCount(afterSingleStatus, 'list_squads'), beforeSingleFullReads.squads);
	    assert.equal(queryCount(afterSingleStatus, 'list_wipes'), beforeSingleFullReads.wipes);
	    assert.equal(queryCount(afterSingleStatus, 'list_wipeParticipants'), beforeSingleFullReads.wipeParticipants);
	    assert.equal(queryCount(afterSingleStatus, 'list_kdaRows'), beforeSingleFullReads.kdaRows);
	    assert.equal(queryCount(afterSingleStatus, 'list_kdaSnapshots'), beforeSingleFullReads.kdaSnapshots);
	    assert.equal(writeCount(afterSingleStatus, 'member_delete'), beforeMemberDeleteWrite + 1);
    assert.equal(writeCount(afterSingleStatus, 'member_delete_log_trim'), beforeMemberDeleteLogTrimWrite);
  } finally {
    if (server) await new Promise((resolve) => server.close(resolve));
    globalThis.fetch = originalFetch;
    const sqliteModule = await import('../server/storage/sqlite.js');
    await sqliteModule.closeSqliteDatabasesForTests();
    Object.assign(process.env, previousEnv);
    for (const [key, value] of Object.entries(previousEnv)) {
      if (value === undefined) delete process.env[key];
    }
    await rm(dataDir, { recursive: true, force: true });
  }
});

test('sqlite-primary web squad create and edit use direct SQLite patch writes', async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'nb-clan-sqlite-web-squad-write-'));
  const previousEnv = {
    NB_DATA_DIR: process.env.NB_DATA_DIR,
    NB_ROOT_PASSWORD: process.env.NB_ROOT_PASSWORD,
    NB_STORAGE_MODE: process.env.NB_STORAGE_MODE,
    NB_SQLITE_FILE: process.env.NB_SQLITE_FILE,
    NB_DISABLE_BACKGROUND_JOBS: process.env.NB_DISABLE_BACKGROUND_JOBS,
    NB_DISABLE_EXTERNAL_VITAL: process.env.NB_DISABLE_EXTERNAL_VITAL,
    NB_RUSTPLUS_RELAY_CHAT_FLUSH_INTERVAL_MS: process.env.NB_RUSTPLUS_RELAY_CHAT_FLUSH_INTERVAL_MS
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

  let server = null;
  try {
    const storeModule = await uniqueImport('../server/store.js');
    const apiModule = await uniqueImport('../server/api.js');
    const authModule = await uniqueImport('../server/auth.js');
    await storeModule.ensureStore();
    const createdAt = '2026-07-02T00:00:00.000Z';
    const leaderPasswordHash = await storeModule.hashPassword('LeaderPass123!');
    await storeModule.updateStore((store) => {
      store.users.push({
        id: 'user_sqlite_web_squad_leader',
        username: 'sqlite_web_squad_leader',
        role: 'leader',
        passwordHash: leaderPasswordHash,
        boundSteamId: '76561198007777771',
        steamNickname: 'SQLite Web Squad Leader',
        createdAt,
        updatedAt: createdAt
      }, {
        id: 'user_sqlite_web_squad_second',
        username: 'sqlite_web_squad_second',
        role: 'leader',
        boundSteamId: '76561198007777772',
        steamNickname: 'SQLite Web Squad Second',
        createdAt,
        updatedAt: createdAt
      }, {
        id: 'user_sqlite_web_squad_plain_leader',
        username: 'sqlite_web_squad_plain_leader',
        role: 'leader',
        passwordHash: leaderPasswordHash,
        createdAt,
        updatedAt: createdAt
      });
      store.squads.push({
        id: 'squad_sqlite_web_plain_leader_owned',
        name: 'SQLite Plain Leader Squad',
        leaderUserId: 'user_sqlite_web_squad_plain_leader',
        leaderUserIds: ['user_sqlite_web_squad_plain_leader'],
        notes: 'plain leader original',
        createdBy: 'user_root',
        createdAt,
        updatedAt: createdAt,
        archivedAt: ''
      });
    });

    const app = express();
    app.use('/api', apiModule.createApiRouter());
    server = createServer(app);
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const baseUrl = `http://127.0.0.1:${server.address().port}/api`;

    const rootSessionId = await authModule.createSession('user_root');
    const rootCookie = `nb_session=${encodeURIComponent(rootSessionId)}`;

    const repositoryModule = await import('../server/storage/repository.js');
    const queryCount = (status, name) => status.sqlite?.queries?.byName?.[name]?.total || 0;
    const beforeSquadCreateFailureStatus = await storeModule.storeRuntimeStatus({ sqliteSummary: false });
    const beforeSquadCreateFailureReadStoreFull = queryCount(beforeSquadCreateFailureStatus, 'read_store_full');
    repositoryModule.injectSqliteStorePatchFailureForTests('squad_add', 1);
    const failedSquadCreateResponse = await httpFetch(`${baseUrl}/squads`, {
      method: 'POST',
      headers: {
        cookie: rootCookie,
        'content-type': 'application/json'
      },
      body: JSON.stringify({
        name: 'SQLite Web Failed Squad',
        leaderUserId: 'user_sqlite_web_squad_leader',
        notes: 'web failed create'
      })
    });
    const failedSquadCreatePayload = await failedSquadCreateResponse.json();
    assert.equal(failedSquadCreateResponse.status, 503);
    assert.match(failedSquadCreatePayload.error, /队伍写入暂不可用/);
    const afterSquadCreateFailureStatus = await storeModule.storeRuntimeStatus({ sqliteSummary: false });
    assert.equal(queryCount(afterSquadCreateFailureStatus, 'read_store_full'), beforeSquadCreateFailureReadStoreFull);
    const failedSquads = await repositoryModule.getSqliteCollection('squads', { limit: 0 });
    assert.equal(failedSquads.some((squad) => squad.name === 'SQLite Web Failed Squad'), false);

    const beforeCreateStat = await stat(storeModule.STORE_FILE);
    const beforeCreateStatus = await storeModule.storeRuntimeStatus({ sqliteSummary: false });
    const beforeCreateListUsers = queryCount(beforeCreateStatus, 'list_users');
    const beforeCreateListMembers = queryCount(beforeCreateStatus, 'list_members');
    const beforeCreateListSquads = queryCount(beforeCreateStatus, 'list_squads');
    const beforeCreateListWipes = queryCount(beforeCreateStatus, 'list_wipes');
    const beforeCreateListWipeParticipants = queryCount(beforeCreateStatus, 'list_wipeParticipants');
    const beforeCreateUsersById = queryCount(beforeCreateStatus, 'list_users_id');
    const beforeCreateUsersByRole = queryCount(beforeCreateStatus, 'list_users_role');
    const beforeCreateWipesByStatus = queryCount(beforeCreateStatus, 'list_wipes_status');
    const createResponse = await httpFetch(`${baseUrl}/squads`, {
      method: 'POST',
      headers: {
        cookie: rootCookie,
        'content-type': 'application/json'
      },
      body: JSON.stringify({
        name: 'SQLite Web Direct Squad',
        leaderUserId: 'user_sqlite_web_squad_leader',
        notes: 'web direct create'
      })
    });
    assert.equal(createResponse.status, 200);
    const createPayload = await createResponse.json();
    const createdSquad = createPayload.squads.find((squad) => squad.name === 'SQLite Web Direct Squad');
    assert.ok(createdSquad?.id);
    assert.equal(createdSquad.notes, 'web direct create');
    const afterCreateStat = await stat(storeModule.STORE_FILE);
    const afterCreateStatus = await storeModule.storeRuntimeStatus({ sqliteSummary: false });
    assert.equal(afterCreateStat.mtimeMs, beforeCreateStat.mtimeMs);
    assert.equal(afterCreateStatus.metrics.writes.total, beforeCreateStatus.metrics.writes.total);
    assert.equal(afterCreateStatus.metrics.sqliteWrites, beforeCreateStatus.metrics.sqliteWrites);
    assert.equal(queryCount(afterCreateStatus, 'list_users') <= beforeCreateListUsers + 2, true, `list_users ${beforeCreateListUsers}->${queryCount(afterCreateStatus, 'list_users')}`);
    assert.equal(queryCount(afterCreateStatus, 'list_members') <= beforeCreateListMembers + 1, true);
    assert.equal(queryCount(afterCreateStatus, 'list_squads') <= beforeCreateListSquads + 3, true, `list_squads ${beforeCreateListSquads}->${queryCount(afterCreateStatus, 'list_squads')}`);
    assert.equal(queryCount(afterCreateStatus, 'list_wipes'), beforeCreateListWipes);
    assert.equal(queryCount(afterCreateStatus, 'list_wipeParticipants'), beforeCreateListWipeParticipants);
    assert.equal(queryCount(afterCreateStatus, 'list_users_id') > beforeCreateUsersById, true);
    assert.equal(queryCount(afterCreateStatus, 'list_users_role') > beforeCreateUsersByRole, true);
    assert.equal(queryCount(afterCreateStatus, 'list_wipes_status') > beforeCreateWipesByStatus, true);
    let squadRecord = await repositoryModule.getSqliteRecord('squads', createdSquad.id);
    assert.equal(squadRecord.createdBy, 'user_root');
    let leaderMembers = await repositoryModule.getSqliteRecordsByJsonField('members', 'steamId', ['76561198007777771'], { limit: 0 });
    assert.equal(leaderMembers.length, 1);
    let leaderSquadRows = await repositoryModule.getSqliteRecordsByJsonField('squadMembers', 'memberId', [leaderMembers[0].id], { limit: 0 });
    assert.equal(leaderSquadRows.some((item) => item.squadId === createdSquad.id), true);
    let logs = await repositoryModule.getSqliteCollection('logs', { limit: 0 });
    assert.equal(logs.some((log) => log.type === 'squad_add' && log.targetId === createdSquad.id), true);

    const beforeEditFailureStatus = await storeModule.storeRuntimeStatus({ sqliteSummary: false });
    const beforeEditFailureReadStoreFull = queryCount(beforeEditFailureStatus, 'read_store_full');
    repositoryModule.injectSqliteStorePatchFailureForTests('squad_edit', 1);
    const failedEditResponse = await httpFetch(`${baseUrl}/squads/${createdSquad.id}`, {
      method: 'PUT',
      headers: {
        cookie: rootCookie,
        'content-type': 'application/json'
      },
      body: JSON.stringify({
        name: 'SQLite Web Direct Squad Failed Edit',
        notes: 'web failed edit',
        leaderUserId: 'user_sqlite_web_squad_second'
      })
    });
    const failedEditPayload = await failedEditResponse.json();
    assert.equal(failedEditResponse.status, 503);
    assert.match(failedEditPayload.error, /队伍写入暂不可用/);
    const afterEditFailureStatus = await storeModule.storeRuntimeStatus({ sqliteSummary: false });
    assert.equal(queryCount(afterEditFailureStatus, 'read_store_full'), beforeEditFailureReadStoreFull);
    squadRecord = await repositoryModule.getSqliteRecord('squads', createdSquad.id);
    assert.equal(squadRecord.notes, 'web direct create');
    assert.deepEqual(squadRecord.leaderUserIds, ['user_sqlite_web_squad_leader']);

    const beforeEditStat = await stat(storeModule.STORE_FILE);
    const beforeEditStatus = await storeModule.storeRuntimeStatus({ sqliteSummary: false });
    const beforeEditListUsers = queryCount(beforeEditStatus, 'list_users');
    const beforeEditListMembers = queryCount(beforeEditStatus, 'list_members');
    const beforeEditListSquads = queryCount(beforeEditStatus, 'list_squads');
    const beforeEditListWipes = queryCount(beforeEditStatus, 'list_wipes');
    const beforeEditListWipeParticipants = queryCount(beforeEditStatus, 'list_wipeParticipants');
    const beforeEditUsersById = queryCount(beforeEditStatus, 'list_users_id');
    const beforeEditSquadsById = queryCount(beforeEditStatus, 'list_squads_id');
    const beforeEditWipesByStatus = queryCount(beforeEditStatus, 'list_wipes_status');
    const editResponse = await httpFetch(`${baseUrl}/squads/${createdSquad.id}`, {
      method: 'PUT',
      headers: {
        cookie: rootCookie,
        'content-type': 'application/json'
      },
      body: JSON.stringify({
        name: 'SQLite Web Direct Squad Edited',
        notes: 'web direct edit',
        leaderUserId: 'user_sqlite_web_squad_second'
      })
    });
    assert.equal(editResponse.status, 200);
    const editPayload = await editResponse.json();
    const editedSquad = editPayload.squads.find((squad) => squad.id === createdSquad.id);
    assert.equal(editedSquad.name, 'SQLite Web Direct Squad Edited');
    assert.deepEqual(editedSquad.leaderUserIds, ['user_sqlite_web_squad_second']);
    const afterEditStat = await stat(storeModule.STORE_FILE);
    const afterEditStatus = await storeModule.storeRuntimeStatus({ sqliteSummary: false });
    assert.equal(afterEditStat.mtimeMs, beforeEditStat.mtimeMs);
    assert.equal(afterEditStatus.metrics.writes.total, beforeEditStatus.metrics.writes.total);
    assert.equal(afterEditStatus.metrics.sqliteWrites, beforeEditStatus.metrics.sqliteWrites);
    assert.equal(queryCount(afterEditStatus, 'list_users') <= beforeEditListUsers + 2, true);
    assert.equal(queryCount(afterEditStatus, 'list_members'), beforeEditListMembers);
    assert.equal(queryCount(afterEditStatus, 'list_squads') <= beforeEditListSquads + 2, true);
    assert.equal(queryCount(afterEditStatus, 'list_wipes'), beforeEditListWipes);
    assert.equal(queryCount(afterEditStatus, 'list_wipeParticipants'), beforeEditListWipeParticipants);
    assert.equal(queryCount(afterEditStatus, 'list_users_id') > beforeEditUsersById, true);
    assert.equal(queryCount(afterEditStatus, 'list_squads_id') > beforeEditSquadsById, true);
    assert.equal(queryCount(afterEditStatus, 'list_wipes_status') > beforeEditWipesByStatus, true);
    squadRecord = await repositoryModule.getSqliteRecord('squads', createdSquad.id);
    assert.equal(squadRecord.notes, 'web direct edit');
    assert.deepEqual(squadRecord.leaderUserIds, ['user_sqlite_web_squad_second']);
    leaderMembers = await repositoryModule.getSqliteRecordsByJsonField('members', 'steamId', ['76561198007777772'], { limit: 0 });
    assert.equal(leaderMembers.length, 1);
    leaderSquadRows = await repositoryModule.getSqliteRecordsByJsonField('squadMembers', 'memberId', [leaderMembers[0].id], { limit: 0 });
    assert.equal(leaderSquadRows.some((item) => item.squadId === createdSquad.id), true);
    logs = await repositoryModule.getSqliteCollection('logs', { limit: 0 });
    assert.equal(logs.some((log) => log.type === 'squad_edit' && log.targetId === createdSquad.id), true);

    const leaderSessionId = await authModule.createSession('user_sqlite_web_squad_plain_leader');
    const leaderCookie = `nb_session=${encodeURIComponent(leaderSessionId)}`;
    const beforeLeaderEditStat = await stat(storeModule.STORE_FILE);
    const beforeLeaderEditStatus = await storeModule.storeRuntimeStatus({ sqliteSummary: false });
    const beforeLeaderEditListUsers = queryCount(beforeLeaderEditStatus, 'list_users');
    const beforeLeaderEditListSquads = queryCount(beforeLeaderEditStatus, 'list_squads');
    const beforeLeaderEditSquadsById = queryCount(beforeLeaderEditStatus, 'list_squads_id');
    const leaderEditResponse = await httpFetch(`${baseUrl}/squads/squad_sqlite_web_plain_leader_owned`, {
      method: 'PUT',
      headers: {
        cookie: leaderCookie,
        'content-type': 'application/json'
      },
      body: JSON.stringify({
        name: 'SQLite Plain Leader Squad Edited',
        notes: 'plain leader edit',
        leaderUserId: 'user_sqlite_web_squad_second'
      })
    });
    assert.equal(leaderEditResponse.status, 200);
    const leaderEditPayload = await leaderEditResponse.json();
    const plainLeaderSquad = leaderEditPayload.squads.find((squad) => squad.id === 'squad_sqlite_web_plain_leader_owned');
    assert.equal(plainLeaderSquad.name, 'SQLite Plain Leader Squad Edited');
    assert.deepEqual(plainLeaderSquad.leaderUserIds, ['user_sqlite_web_squad_plain_leader']);
    const afterLeaderEditStat = await stat(storeModule.STORE_FILE);
    const afterLeaderEditStatus = await storeModule.storeRuntimeStatus({ sqliteSummary: false });
    assert.equal(afterLeaderEditStat.mtimeMs, beforeLeaderEditStat.mtimeMs);
    assert.equal(afterLeaderEditStatus.metrics.writes.total, beforeLeaderEditStatus.metrics.writes.total);
    assert.equal(afterLeaderEditStatus.metrics.sqliteWrites, beforeLeaderEditStatus.metrics.sqliteWrites);
    assert.equal(queryCount(afterLeaderEditStatus, 'list_users') <= beforeLeaderEditListUsers + 1, true);
    assert.equal(queryCount(afterLeaderEditStatus, 'list_squads') <= beforeLeaderEditListSquads + 2, true);
    assert.equal(queryCount(afterLeaderEditStatus, 'list_squads_id') > beforeLeaderEditSquadsById, true);
    const plainLeaderRecord = await repositoryModule.getSqliteRecord('squads', 'squad_sqlite_web_plain_leader_owned');
    assert.equal(plainLeaderRecord.notes, 'plain leader edit');
    assert.deepEqual(plainLeaderRecord.leaderUserIds, ['user_sqlite_web_squad_plain_leader']);
  } finally {
    if (server) await new Promise((resolve) => server.close(resolve));
    globalThis.fetch = originalFetch;
    const sqliteModule = await import('../server/storage/sqlite.js');
    await sqliteModule.closeSqliteDatabasesForTests();
    Object.assign(process.env, previousEnv);
    for (const [key, value] of Object.entries(previousEnv)) {
      if (value === undefined) delete process.env[key];
    }
    await rm(dataDir, { recursive: true, force: true });
  }
});

test('sqlite-primary squad member writes use direct SQLite patch writes', async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'nb-clan-sqlite-squad-member-write-'));
  const previousEnv = {
    NB_DATA_DIR: process.env.NB_DATA_DIR,
    NB_ROOT_PASSWORD: process.env.NB_ROOT_PASSWORD,
    NB_STORAGE_MODE: process.env.NB_STORAGE_MODE,
    NB_SQLITE_FILE: process.env.NB_SQLITE_FILE,
    NB_DISABLE_BACKGROUND_JOBS: process.env.NB_DISABLE_BACKGROUND_JOBS,
    NB_DISABLE_EXTERNAL_VITAL: process.env.NB_DISABLE_EXTERNAL_VITAL,
    NB_RUSTPLUS_RELAY_CHAT_FLUSH_INTERVAL_MS: process.env.NB_RUSTPLUS_RELAY_CHAT_FLUSH_INTERVAL_MS
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

  let server = null;
  try {
    const storeModule = await uniqueImport('../server/store.js');
    const apiModule = await uniqueImport('../server/api.js');
    const repositoryModule = await import('../server/storage/repository.js');
    await storeModule.ensureStore();
    const createdAt = '2026-07-02T00:00:00.000Z';
    const closedAt = '2026-07-03T00:00:00.000Z';
    await storeModule.updateStore((store) => {
      store.squads.push({
        id: 'squad_sqlite_member_old',
        name: 'SQLite Old Squad',
        leaderUserIds: [],
        createdAt,
        updatedAt: createdAt
      }, {
        id: 'squad_sqlite_member_new',
        name: 'SQLite New Squad',
        leaderUserIds: [],
        createdAt,
        updatedAt: createdAt
      });
      store.wipes.push({
        id: 'wipe_sqlite_squad_member_live',
        name: 'SQLite Squad Member Live',
        status: 'active',
        startedAt: createdAt,
        createdAt,
        updatedAt: createdAt
      }, {
        id: 'wipe_sqlite_squad_member_closed',
        name: 'SQLite Squad Member Closed',
        status: 'closed',
        startedAt: createdAt,
        closedAt,
        createdAt,
        updatedAt: closedAt
      });
      store.members.push({
        id: 'member_sqlite_squad_move',
        steamId: '76561198005555551',
        rawInput: '76561198005555551',
        customName: 'SQLite Squad Move',
        steamNickname: 'SQLite Squad Move',
        specialty: [],
        memberStatus: 'active',
        invitedByUserId: 'user_root',
        createdAt,
        updatedAt: createdAt
      }, {
        id: 'member_sqlite_squad_remove',
        steamId: '76561198005555552',
        rawInput: '76561198005555552',
        customName: 'SQLite Squad Remove',
        steamNickname: 'SQLite Squad Remove',
        specialty: [],
        memberStatus: 'active',
        invitedByUserId: 'user_root',
        createdAt,
        updatedAt: createdAt
      });
      store.squadMembers.push({
        id: 'squad_member_sqlite_squad_move_old',
        squadId: 'squad_sqlite_member_old',
        memberId: 'member_sqlite_squad_move',
        addedByUserId: 'user_root',
        createdAt
      }, {
        id: 'squad_member_sqlite_squad_remove_new',
        squadId: 'squad_sqlite_member_new',
        memberId: 'member_sqlite_squad_remove',
        addedByUserId: 'user_root',
        createdAt
      });
      store.wipeParticipants.push({
        id: 'participant_sqlite_squad_move_live',
        wipeId: 'wipe_sqlite_squad_member_live',
        memberId: 'member_sqlite_squad_move',
        steamId: '76561198005555551',
        squadId: 'squad_sqlite_member_old',
        status: 'on_time',
        createdAt,
        updatedAt: createdAt
      }, {
        id: 'participant_sqlite_squad_move_closed',
        wipeId: 'wipe_sqlite_squad_member_closed',
        memberId: 'member_sqlite_squad_move',
        steamId: '76561198005555551',
        squadId: 'squad_sqlite_member_old',
        status: 'on_time',
        createdAt,
        updatedAt: closedAt
      }, {
        id: 'participant_sqlite_squad_remove_live',
        wipeId: 'wipe_sqlite_squad_member_live',
        memberId: 'member_sqlite_squad_remove',
        steamId: '76561198005555552',
        squadId: 'squad_sqlite_member_new',
        status: 'on_time',
        createdAt,
        updatedAt: createdAt
      }, {
        id: 'participant_sqlite_squad_remove_live_steam_only',
        wipeId: 'wipe_sqlite_squad_member_live',
        memberId: 'legacy_sqlite_squad_remove',
        steamId: '76561198005555552',
        squadId: 'squad_sqlite_member_new',
        status: 'on_time',
        createdAt,
        updatedAt: createdAt
      }, {
        id: 'participant_sqlite_squad_remove_closed',
        wipeId: 'wipe_sqlite_squad_member_closed',
        memberId: 'member_sqlite_squad_remove',
        steamId: '76561198005555552',
        squadId: 'squad_sqlite_member_new',
        status: 'on_time',
        createdAt,
        updatedAt: closedAt
      });
      store.kdaRows.push({
        id: 'kda_sqlite_squad_move_live',
        wipeId: 'wipe_sqlite_squad_member_live',
        memberId: 'member_sqlite_squad_move',
        steamId: '76561198005555551',
        squadId: 'squad_sqlite_member_old',
        kills: 3,
        syncedAt: createdAt
      }, {
        id: 'kda_sqlite_squad_move_closed',
        wipeId: 'wipe_sqlite_squad_member_closed',
        memberId: 'member_sqlite_squad_move',
        steamId: '76561198005555551',
        squadId: 'squad_sqlite_member_old',
        kills: 7,
        syncedAt: closedAt
      }, {
        id: 'kda_sqlite_squad_remove_live',
        wipeId: 'wipe_sqlite_squad_member_live',
        memberId: 'member_sqlite_squad_remove',
        steamId: '',
        squadId: 'squad_sqlite_member_new',
        kills: 4,
        syncedAt: createdAt
      }, {
        id: 'kda_sqlite_squad_remove_live_steam_only',
        wipeId: 'wipe_sqlite_squad_member_live',
        memberId: 'legacy_sqlite_squad_remove',
        steamId: '76561198005555552',
        squadId: 'squad_sqlite_member_new',
        kills: 5,
        syncedAt: createdAt
      }, {
        id: 'kda_sqlite_squad_remove_closed',
        wipeId: 'wipe_sqlite_squad_member_closed',
        memberId: 'member_sqlite_squad_remove',
        steamId: '76561198005555552',
        squadId: 'squad_sqlite_member_new',
        kills: 8,
        syncedAt: closedAt
      });
      store.kdaSnapshots.push({
        id: 'kda_snapshot_sqlite_squad_move_live',
        wipeId: 'wipe_sqlite_squad_member_live',
        memberId: 'member_sqlite_squad_move',
        steamId: '76561198005555551',
        squadId: 'squad_sqlite_member_old',
        kills: 3,
        capturedAt: createdAt
      }, {
        id: 'kda_snapshot_sqlite_squad_move_closed',
        wipeId: 'wipe_sqlite_squad_member_closed',
        memberId: 'member_sqlite_squad_move',
        steamId: '76561198005555551',
        squadId: 'squad_sqlite_member_old',
        kills: 7,
        capturedAt: closedAt
      }, {
        id: 'kda_snapshot_sqlite_squad_remove_live',
        wipeId: 'wipe_sqlite_squad_member_live',
        memberId: 'member_sqlite_squad_remove',
        steamId: '76561198005555552',
        squadId: 'squad_sqlite_member_new',
        kills: 4,
        capturedAt: createdAt
      }, {
        id: 'kda_snapshot_sqlite_squad_remove_live_steam_only',
        wipeId: 'wipe_sqlite_squad_member_live',
        memberId: 'legacy_sqlite_squad_remove',
        steamId: '76561198005555552',
        squadId: 'squad_sqlite_member_new',
        kills: 5,
        capturedAt: createdAt
      }, {
        id: 'kda_snapshot_sqlite_squad_remove_closed',
        wipeId: 'wipe_sqlite_squad_member_closed',
        memberId: 'member_sqlite_squad_remove',
        steamId: '76561198005555552',
        squadId: 'squad_sqlite_member_new',
        kills: 8,
        capturedAt: closedAt
      });
    });

    const app = express();
    app.use('/api', apiModule.createApiRouter());
    server = createServer(app);
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const baseUrl = `http://127.0.0.1:${server.address().port}/api`;

    const loginResponse = await httpFetch(`${baseUrl}/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'root', password: 'RootPass123!' })
    });
    assert.equal(loginResponse.status, 200);
    const cookie = loginResponse.headers.get('set-cookie')?.split(';')[0] || '';
    assert.match(cookie, /^nb_session=/);

    const beforeAddFailureStatus = await storeModule.storeRuntimeStatus({ sqliteSummary: false });
    const beforeAddFailureReadStoreFull = queryCount(beforeAddFailureStatus, 'read_store_full');
    repositoryModule.injectSqliteStorePatchFailureForTests('squad_member_add', 1);
    const failedAddResponse = await httpFetch(`${baseUrl}/squads/squad_sqlite_member_new/members`, {
      method: 'POST',
      headers: {
        cookie,
        'content-type': 'application/json'
      },
      body: JSON.stringify({ memberIds: ['member_sqlite_squad_move'] })
    });
    const failedAddPayload = await failedAddResponse.json();
    assert.equal(failedAddResponse.status, 503);
    assert.match(failedAddPayload.error, /队伍成员写入暂不可用/);
    const afterAddFailureStatus = await storeModule.storeRuntimeStatus({ sqliteSummary: false });
    assert.equal(queryCount(afterAddFailureStatus, 'read_store_full'), beforeAddFailureReadStoreFull);
    let failedMoveSquadMembers = await repositoryModule.getSqliteRecordsByJsonField('squadMembers', 'memberId', ['member_sqlite_squad_move'], { limit: 0 });
    assert.equal(failedMoveSquadMembers.some((item) => item.squadId === 'squad_sqlite_member_new'), false);
    assert.equal(failedMoveSquadMembers.some((item) => item.squadId === 'squad_sqlite_member_old'), true);
    assert.equal((await repositoryModule.getSqliteRecord('wipeParticipants', 'participant_sqlite_squad_move_live')).squadId, 'squad_sqlite_member_old');

    const beforeAddStatus = await storeModule.storeRuntimeStatus({ sqliteSummary: false });
    const beforeAddFullReads = {
      users: queryCount(beforeAddStatus, 'list_users'),
      members: queryCount(beforeAddStatus, 'list_members'),
      squads: queryCount(beforeAddStatus, 'list_squads'),
      squadMembers: queryCount(beforeAddStatus, 'list_squadMembers'),
      wipes: queryCount(beforeAddStatus, 'list_wipes'),
      wipeParticipants: queryCount(beforeAddStatus, 'list_wipeParticipants'),
      kdaRows: queryCount(beforeAddStatus, 'list_kdaRows'),
      kdaSnapshots: queryCount(beforeAddStatus, 'list_kdaSnapshots')
    };
    const beforeAddScopedReads = {
      usersById: queryCount(beforeAddStatus, 'list_users_id'),
      membersById: queryCount(beforeAddStatus, 'list_members_id'),
      squadsById: queryCount(beforeAddStatus, 'list_squads_id'),
      squadMembersByMemberId: queryCount(beforeAddStatus, 'list_squadMembers_memberId'),
      squadMembersBySquadId: queryCount(beforeAddStatus, 'list_squadMembers_squadId'),
      wipesByStatus: queryCount(beforeAddStatus, 'list_wipes_status'),
      wipesMissingStatus: queryCount(beforeAddStatus, 'list_wipes_status_missing'),
      wipeParticipantsByMemberId: queryCount(beforeAddStatus, 'list_wipeParticipants_memberId'),
      wipeParticipantsByWipeId: queryCount(beforeAddStatus, 'list_wipeParticipants_wipeId'),
      kdaRowsByMemberId: queryCount(beforeAddStatus, 'list_kdaRows_memberId'),
      kdaSnapshotsByMemberId: queryCount(beforeAddStatus, 'list_kdaSnapshots_memberId')
    };
    const addResponse = await httpFetch(`${baseUrl}/squads/squad_sqlite_member_new/members`, {
      method: 'POST',
      headers: {
        cookie,
        'content-type': 'application/json'
      },
      body: JSON.stringify({ memberIds: ['member_sqlite_squad_move'] })
    });
    assert.equal(addResponse.status, 200);
    const addPayload = await addResponse.json();
    assert.equal(addPayload.ok, true);
    assert.equal(addPayload.members.some((member) => member.id === 'member_sqlite_squad_move'), true);
    let squadMembers = await repositoryModule.getSqliteRecordsByJsonField('squadMembers', 'memberId', ['member_sqlite_squad_move'], { limit: 0 });
    assert.equal(squadMembers.some((item) => item.id === 'squad_member_sqlite_squad_move_old'), false);
    assert.equal(squadMembers.some((item) => item.squadId === 'squad_sqlite_member_new'), true);
    assert.equal((await repositoryModule.getSqliteRecord('wipeParticipants', 'participant_sqlite_squad_move_live')).squadId, 'squad_sqlite_member_new');
    assert.equal((await repositoryModule.getSqliteRecord('kdaRows', 'kda_sqlite_squad_move_live')).squadId, 'squad_sqlite_member_new');
    assert.equal((await repositoryModule.getSqliteRecord('kdaSnapshots', 'kda_snapshot_sqlite_squad_move_live')).squadId, 'squad_sqlite_member_new');
    assert.equal((await repositoryModule.getSqliteRecord('wipeParticipants', 'participant_sqlite_squad_move_closed')).squadId, 'squad_sqlite_member_old');
    assert.equal((await repositoryModule.getSqliteRecord('kdaRows', 'kda_sqlite_squad_move_closed')).squadId, 'squad_sqlite_member_old');
    assert.equal((await repositoryModule.getSqliteRecord('kdaSnapshots', 'kda_snapshot_sqlite_squad_move_closed')).squadId, 'squad_sqlite_member_old');
    let logs = await repositoryModule.getSqliteCollection('logs', { limit: 0 });
    const afterAddStatus = await storeModule.storeRuntimeStatus({ sqliteSummary: false });
    assert.equal(logs.some((log) => log.type === 'squad_member_add' && log.targetId === 'squad_sqlite_member_new'), true);
    assert.equal(afterAddStatus.metrics.writes.total, beforeAddStatus.metrics.writes.total);
    assert.equal(afterAddStatus.metrics.sqliteWrites, beforeAddStatus.metrics.sqliteWrites);
    assert.equal(queryCount(afterAddStatus, 'list_users'), beforeAddFullReads.users);
    assert.equal(queryCount(afterAddStatus, 'list_members'), beforeAddFullReads.members);
    assert.equal(queryCount(afterAddStatus, 'list_squads'), beforeAddFullReads.squads);
    assert.equal(queryCount(afterAddStatus, 'list_squadMembers'), beforeAddFullReads.squadMembers);
    assert.equal(queryCount(afterAddStatus, 'list_wipes'), beforeAddFullReads.wipes);
    assert.equal(queryCount(afterAddStatus, 'list_wipeParticipants'), beforeAddFullReads.wipeParticipants);
    assert.equal(queryCount(afterAddStatus, 'list_kdaRows'), beforeAddFullReads.kdaRows);
    assert.equal(queryCount(afterAddStatus, 'list_kdaSnapshots'), beforeAddFullReads.kdaSnapshots);
    assert.equal(queryCount(afterAddStatus, 'list_users_id') > beforeAddScopedReads.usersById, true);
    assert.equal(queryCount(afterAddStatus, 'list_members_id') > beforeAddScopedReads.membersById, true);
    assert.equal(queryCount(afterAddStatus, 'list_squads_id') > beforeAddScopedReads.squadsById, true);
    assert.equal(queryCount(afterAddStatus, 'list_squadMembers_memberId') > beforeAddScopedReads.squadMembersByMemberId, true);
    assert.equal(queryCount(afterAddStatus, 'list_squadMembers_squadId') > beforeAddScopedReads.squadMembersBySquadId, true);
    assert.equal(queryCount(afterAddStatus, 'list_wipes_status') > beforeAddScopedReads.wipesByStatus, true);
    assert.equal(queryCount(afterAddStatus, 'list_wipes_status_missing') > beforeAddScopedReads.wipesMissingStatus, true);
    assert.equal(queryCount(afterAddStatus, 'list_wipeParticipants_memberId') > beforeAddScopedReads.wipeParticipantsByMemberId, true);
    assert.equal(queryCount(afterAddStatus, 'list_wipeParticipants_wipeId') > beforeAddScopedReads.wipeParticipantsByWipeId, true);
    assert.equal(queryCount(afterAddStatus, 'list_kdaRows_memberId') > beforeAddScopedReads.kdaRowsByMemberId, true);
    assert.equal(queryCount(afterAddStatus, 'list_kdaSnapshots_memberId') > beforeAddScopedReads.kdaSnapshotsByMemberId, true);

    const beforeRemoveFailureStatus = await storeModule.storeRuntimeStatus({ sqliteSummary: false });
    const beforeRemoveFailureReadStoreFull = queryCount(beforeRemoveFailureStatus, 'read_store_full');
    repositoryModule.injectSqliteStorePatchFailureForTests('squad_member_remove', 1);
    const failedRemoveResponse = await httpFetch(`${baseUrl}/squads/squad_sqlite_member_new/members/member_sqlite_squad_remove`, {
      method: 'DELETE',
      headers: { cookie }
    });
    const failedRemovePayload = await failedRemoveResponse.json();
    assert.equal(failedRemoveResponse.status, 503);
    assert.match(failedRemovePayload.error, /队伍成员写入暂不可用/);
    const afterRemoveFailureStatus = await storeModule.storeRuntimeStatus({ sqliteSummary: false });
    assert.equal(queryCount(afterRemoveFailureStatus, 'read_store_full'), beforeRemoveFailureReadStoreFull);
    let failedRemoveSquadMembers = await repositoryModule.getSqliteRecordsByJsonField('squadMembers', 'memberId', ['member_sqlite_squad_remove'], { limit: 0 });
    assert.equal(failedRemoveSquadMembers.some((item) => item.id === 'squad_member_sqlite_squad_remove_new'), true);
    assert.notEqual(await repositoryModule.getSqliteRecord('wipeParticipants', 'participant_sqlite_squad_remove_live'), null);
    assert.notEqual(await repositoryModule.getSqliteRecord('kdaRows', 'kda_sqlite_squad_remove_live'), null);

    const beforeRemoveStatus = await storeModule.storeRuntimeStatus({ sqliteSummary: false });
    const beforeRemoveFullReads = {
      users: queryCount(beforeRemoveStatus, 'list_users'),
      members: queryCount(beforeRemoveStatus, 'list_members'),
      squads: queryCount(beforeRemoveStatus, 'list_squads'),
      squadMembers: queryCount(beforeRemoveStatus, 'list_squadMembers'),
      wipes: queryCount(beforeRemoveStatus, 'list_wipes'),
      wipeParticipants: queryCount(beforeRemoveStatus, 'list_wipeParticipants'),
      kdaRows: queryCount(beforeRemoveStatus, 'list_kdaRows'),
      kdaSnapshots: queryCount(beforeRemoveStatus, 'list_kdaSnapshots')
    };
    const beforeRemoveScopedReads = {
      usersById: queryCount(beforeRemoveStatus, 'list_users_id'),
      membersById: queryCount(beforeRemoveStatus, 'list_members_id'),
      squadsById: queryCount(beforeRemoveStatus, 'list_squads_id'),
      squadMembersByMemberId: queryCount(beforeRemoveStatus, 'list_squadMembers_memberId'),
      squadMembersBySquadId: queryCount(beforeRemoveStatus, 'list_squadMembers_squadId'),
      wipesByStatus: queryCount(beforeRemoveStatus, 'list_wipes_status'),
      wipesMissingStatus: queryCount(beforeRemoveStatus, 'list_wipes_status_missing'),
      wipeParticipantsByMemberId: queryCount(beforeRemoveStatus, 'list_wipeParticipants_memberId'),
      wipeParticipantsBySteamId: queryCount(beforeRemoveStatus, 'list_wipeParticipants_steamId'),
      wipeParticipantsByWipeId: queryCount(beforeRemoveStatus, 'list_wipeParticipants_wipeId'),
      kdaRowsByMemberId: queryCount(beforeRemoveStatus, 'list_kdaRows_memberId'),
      kdaRowsBySteamId: queryCount(beforeRemoveStatus, 'list_kdaRows_steamId'),
      kdaSnapshotsByMemberId: queryCount(beforeRemoveStatus, 'list_kdaSnapshots_memberId'),
      kdaSnapshotsBySteamId: queryCount(beforeRemoveStatus, 'list_kdaSnapshots_steamId')
    };
    const removeResponse = await httpFetch(`${baseUrl}/squads/squad_sqlite_member_new/members/member_sqlite_squad_remove`, {
      method: 'DELETE',
      headers: { cookie }
    });
    assert.equal(removeResponse.status, 200);
    const removePayload = await removeResponse.json();
    assert.equal(removePayload.ok, true);
    assert.equal(removePayload.members.some((member) => member.id === 'member_sqlite_squad_remove'), false);
    squadMembers = await repositoryModule.getSqliteRecordsByJsonField('squadMembers', 'memberId', ['member_sqlite_squad_remove'], { limit: 0 });
    assert.equal(squadMembers.some((item) => item.id === 'squad_member_sqlite_squad_remove_new'), false);
    assert.equal(await repositoryModule.getSqliteRecord('wipeParticipants', 'participant_sqlite_squad_remove_live'), null);
    assert.equal(await repositoryModule.getSqliteRecord('wipeParticipants', 'participant_sqlite_squad_remove_live_steam_only'), null);
    assert.equal(await repositoryModule.getSqliteRecord('kdaRows', 'kda_sqlite_squad_remove_live'), null);
    assert.equal(await repositoryModule.getSqliteRecord('kdaRows', 'kda_sqlite_squad_remove_live_steam_only'), null);
    assert.equal(await repositoryModule.getSqliteRecord('kdaSnapshots', 'kda_snapshot_sqlite_squad_remove_live'), null);
    assert.equal(await repositoryModule.getSqliteRecord('kdaSnapshots', 'kda_snapshot_sqlite_squad_remove_live_steam_only'), null);
    assert.equal((await repositoryModule.getSqliteRecord('wipeParticipants', 'participant_sqlite_squad_remove_closed')).squadId, 'squad_sqlite_member_new');
    assert.equal((await repositoryModule.getSqliteRecord('kdaRows', 'kda_sqlite_squad_remove_closed')).squadId, 'squad_sqlite_member_new');
    assert.equal((await repositoryModule.getSqliteRecord('kdaSnapshots', 'kda_snapshot_sqlite_squad_remove_closed')).squadId, 'squad_sqlite_member_new');
    logs = await repositoryModule.getSqliteCollection('logs', { limit: 0 });
    const afterRemoveStatus = await storeModule.storeRuntimeStatus({ sqliteSummary: false });
    assert.equal(logs.some((log) => log.type === 'squad_member_remove' && log.targetId === 'squad_sqlite_member_new'), true);
    assert.equal(afterRemoveStatus.metrics.writes.total, beforeRemoveStatus.metrics.writes.total);
    assert.equal(afterRemoveStatus.metrics.sqliteWrites, beforeRemoveStatus.metrics.sqliteWrites);
    assert.equal(queryCount(afterRemoveStatus, 'list_users'), beforeRemoveFullReads.users);
    assert.equal(queryCount(afterRemoveStatus, 'list_members'), beforeRemoveFullReads.members);
    assert.equal(queryCount(afterRemoveStatus, 'list_squads'), beforeRemoveFullReads.squads);
    assert.equal(queryCount(afterRemoveStatus, 'list_squadMembers'), beforeRemoveFullReads.squadMembers);
    assert.equal(queryCount(afterRemoveStatus, 'list_wipes'), beforeRemoveFullReads.wipes);
    assert.equal(queryCount(afterRemoveStatus, 'list_wipeParticipants'), beforeRemoveFullReads.wipeParticipants);
    assert.equal(queryCount(afterRemoveStatus, 'list_kdaRows'), beforeRemoveFullReads.kdaRows);
    assert.equal(queryCount(afterRemoveStatus, 'list_kdaSnapshots'), beforeRemoveFullReads.kdaSnapshots);
    assert.equal(queryCount(afterRemoveStatus, 'list_users_id') > beforeRemoveScopedReads.usersById, true);
    assert.equal(queryCount(afterRemoveStatus, 'list_members_id') > beforeRemoveScopedReads.membersById, true);
    assert.equal(queryCount(afterRemoveStatus, 'list_squads_id') > beforeRemoveScopedReads.squadsById, true);
    assert.equal(queryCount(afterRemoveStatus, 'list_squadMembers_memberId') > beforeRemoveScopedReads.squadMembersByMemberId, true);
    assert.equal(queryCount(afterRemoveStatus, 'list_squadMembers_squadId') > beforeRemoveScopedReads.squadMembersBySquadId, true);
    assert.equal(queryCount(afterRemoveStatus, 'list_wipes_status') > beforeRemoveScopedReads.wipesByStatus, true);
    assert.equal(queryCount(afterRemoveStatus, 'list_wipes_status_missing') > beforeRemoveScopedReads.wipesMissingStatus, true);
    assert.equal(queryCount(afterRemoveStatus, 'list_wipeParticipants_memberId') > beforeRemoveScopedReads.wipeParticipantsByMemberId, true);
    assert.equal(queryCount(afterRemoveStatus, 'list_wipeParticipants_steamId') > beforeRemoveScopedReads.wipeParticipantsBySteamId, true);
    assert.equal(queryCount(afterRemoveStatus, 'list_wipeParticipants_wipeId') > beforeRemoveScopedReads.wipeParticipantsByWipeId, true);
    assert.equal(queryCount(afterRemoveStatus, 'list_kdaRows_memberId') > beforeRemoveScopedReads.kdaRowsByMemberId, true);
    assert.equal(queryCount(afterRemoveStatus, 'list_kdaRows_steamId') > beforeRemoveScopedReads.kdaRowsBySteamId, true);
    assert.equal(queryCount(afterRemoveStatus, 'list_kdaSnapshots_memberId') > beforeRemoveScopedReads.kdaSnapshotsByMemberId, true);
    assert.equal(queryCount(afterRemoveStatus, 'list_kdaSnapshots_steamId') > beforeRemoveScopedReads.kdaSnapshotsBySteamId, true);
  } finally {
    if (server) await new Promise((resolve) => server.close(resolve));
    globalThis.fetch = originalFetch;
    const sqliteModule = await import('../server/storage/sqlite.js');
    await sqliteModule.closeSqliteDatabasesForTests();
    Object.assign(process.env, previousEnv);
    for (const [key, value] of Object.entries(previousEnv)) {
      if (value === undefined) delete process.env[key];
    }
    await rm(dataDir, { recursive: true, force: true });
  }
});

test('sqlite-primary squad member list uses scoped SQLite reads', async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'nb-clan-sqlite-squad-member-read-'));
  const previousEnv = {
    NB_DATA_DIR: process.env.NB_DATA_DIR,
    NB_ROOT_PASSWORD: process.env.NB_ROOT_PASSWORD,
    NB_STORAGE_MODE: process.env.NB_STORAGE_MODE,
    NB_SQLITE_FILE: process.env.NB_SQLITE_FILE,
    NB_DISABLE_BACKGROUND_JOBS: process.env.NB_DISABLE_BACKGROUND_JOBS,
    NB_DISABLE_EXTERNAL_VITAL: process.env.NB_DISABLE_EXTERNAL_VITAL,
    NB_RUSTPLUS_RELAY_CHAT_FLUSH_INTERVAL_MS: process.env.NB_RUSTPLUS_RELAY_CHAT_FLUSH_INTERVAL_MS
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

  let server = null;
  try {
    const storeModule = await uniqueImport('../server/store.js');
    const apiModule = await uniqueImport('../server/api.js');
    const authModule = await uniqueImport('../server/auth.js');
    await storeModule.ensureStore();
	    const createdAt = '2026-07-02T00:00:00.000Z';
	    const closedAt = '2026-07-04T00:00:00.000Z';
	    await storeModule.updateStore((store) => {
	      store.users.push({
	        id: 'user_sqlite_read_leader',
	        username: 'sqlite_read_leader',
	        role: 'leader',
	        boundSteamId: '76561198006666664',
	        steamNickname: 'SQLite Read Leader',
	        createdAt,
	        updatedAt: createdAt
	      });
      store.squads.push({
        id: 'squad_sqlite_read_target',
        name: 'SQLite Read Target',
        leaderUserId: 'user_sqlite_read_leader',
        leaderUserIds: ['user_sqlite_read_leader'],
        createdAt,
        updatedAt: createdAt,
        archivedAt: ''
      }, {
        id: 'squad_sqlite_read_other',
        name: 'SQLite Read Other',
        leaderUserIds: [],
        createdAt,
        updatedAt: createdAt,
        archivedAt: ''
      });
      store.members.push({
        id: 'member_sqlite_read_second',
        steamId: '76561198006666662',
        rawInput: '76561198006666662',
        customName: 'SQLite Read Second',
        steamNickname: 'SQLite Read Second',
        specialty: [],
        memberStatus: 'active',
        invitedByUserId: 'user_root',
        createdAt,
        updatedAt: createdAt
      }, {
        id: 'member_sqlite_read_first',
        steamId: '76561198006666661',
        rawInput: '76561198006666661',
        customName: 'SQLite Read First',
        steamNickname: 'SQLite Read First',
        specialty: [],
        memberStatus: 'active',
        invitedByUserId: 'user_root',
        createdAt,
        updatedAt: createdAt
      }, {
        id: 'member_sqlite_read_other',
        steamId: '76561198006666663',
        rawInput: '76561198006666663',
        customName: 'SQLite Read Other',
        steamNickname: 'SQLite Read Other',
        specialty: [],
        memberStatus: 'active',
        invitedByUserId: 'user_root',
        createdAt,
        updatedAt: createdAt
      });
      store.squadMembers.push({
        id: 'squad_member_sqlite_read_first',
        squadId: 'squad_sqlite_read_target',
        memberId: 'member_sqlite_read_first',
        addedByUserId: 'user_root',
        createdAt
      }, {
        id: 'squad_member_sqlite_read_second',
        squadId: 'squad_sqlite_read_target',
        memberId: 'member_sqlite_read_second',
        addedByUserId: 'user_root',
        createdAt
      }, {
        id: 'squad_member_sqlite_read_other',
        squadId: 'squad_sqlite_read_other',
        memberId: 'member_sqlite_read_other',
        addedByUserId: 'user_root',
        createdAt
      });
      store.wipes.push({
        id: 'wipe_sqlite_read_active',
        name: 'SQLite Read Active',
        status: 'active',
        startedAt: createdAt,
        battlemetricsId: '32032048',
        createdAt,
        updatedAt: createdAt
      }, {
        id: 'wipe_sqlite_read_closed',
        name: 'SQLite Read Closed',
        status: 'closed',
        startedAt: createdAt,
        closedAt,
        battlemetricsId: '32032048',
        createdAt,
        updatedAt: closedAt
      });
      store.wipeParticipants.push({
        id: 'participant_sqlite_read_first_active',
        wipeId: 'wipe_sqlite_read_active',
        memberId: 'member_sqlite_read_first',
        steamId: '76561198006666661',
        squadId: 'squad_sqlite_read_target',
        status: 'on_time',
        createdAt,
        updatedAt: createdAt
      }, {
        id: 'participant_sqlite_read_second_closed',
        wipeId: 'wipe_sqlite_read_closed',
        memberId: 'member_sqlite_read_second',
        steamId: '76561198006666662',
        squadId: 'squad_sqlite_read_target',
        status: 'on_time',
        createdAt,
        updatedAt: closedAt
      });
      store.memberProfiles.push({
        id: 'profile_sqlite_read_first',
        memberId: 'member_sqlite_read_first',
        steamId: '76561198006666661',
        battlemetricsPlayerId: 'bm_read_first',
        battlemetricsServerId: '32032048',
        battlemetricsWipeId: 'wipe_sqlite_read_active',
        battlemetricsServerPlayTimeSeconds: 3600,
        battlemetricsWeeklyPlayTimeSeconds: 3600,
        battlemetricsSyncedAt: createdAt,
        fetchedAt: createdAt
      });
    });

    const app = express();
    app.use('/api', apiModule.createApiRouter());
    server = createServer(app);
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const baseUrl = `http://127.0.0.1:${server.address().port}/api`;
    const rootSessionId = await authModule.createSession('user_root');
    const rootCookie = `nb_session=${encodeURIComponent(rootSessionId)}`;
    const queryCount = (status, name) => status.sqlite?.queries?.byName?.[name]?.total || 0;

    const beforeStat = await stat(storeModule.STORE_FILE);
    const beforeStatus = await storeModule.storeRuntimeStatus({ sqliteSummary: false });
    const response = await httpFetch(`${baseUrl}/squads/squad_sqlite_read_target/members`, {
      headers: { cookie: rootCookie }
    });
    assert.equal(response.status, 200);
    const payload = await response.json();
    assert.equal(payload.ok, true);
    assert.deepEqual(payload.members.map((member) => member.steamId).sort(), [
      '76561198006666661',
      '76561198006666662',
      '76561198006666664'
    ]);
    assert.equal(payload.total, 3);
    assert.equal(payload.squad.memberCount, 3);
    assert.equal(payload.squad.participantCount, 1);
    const leaderMember = payload.members.find((member) => member.steamId === '76561198006666664');
    assert.equal(leaderMember.steamNickname, 'SQLite Read Leader');
    const activeMember = payload.members.find((member) => member.id === 'member_sqlite_read_first');
    assert.equal(activeMember.playStatus, 'playing');
    assert.equal(activeMember.onlineSummary.onlineTimeMinutes, 60);
    const closedMember = payload.members.find((member) => member.id === 'member_sqlite_read_second');
    assert.equal(closedMember.playStatus, 'last_played');
    assert.equal(closedMember.lastPlayedAt, closedAt);

    const afterStat = await stat(storeModule.STORE_FILE);
    const afterStatus = await storeModule.storeRuntimeStatus({ sqliteSummary: false });
    assert.equal(afterStat.mtimeMs, beforeStat.mtimeMs);
	    assert.equal(afterStatus.metrics.reads.total, beforeStatus.metrics.reads.total);
	    assert.equal(afterStatus.metrics.writes.total, beforeStatus.metrics.writes.total);
	    assert.equal(queryCount(afterStatus, 'list_users'), queryCount(beforeStatus, 'list_users'));
	    assert.equal(queryCount(afterStatus, 'list_squads'), queryCount(beforeStatus, 'list_squads'));
	    assert.equal(queryCount(afterStatus, 'list_members'), queryCount(beforeStatus, 'list_members'));
	    assert.equal(queryCount(afterStatus, 'list_squadMembers'), queryCount(beforeStatus, 'list_squadMembers'));
	    assert.equal(queryCount(afterStatus, 'list_permissionRoles'), queryCount(beforeStatus, 'list_permissionRoles'));
    assert.equal(queryCount(afterStatus, 'read_store_full'), queryCount(beforeStatus, 'read_store_full'));
    assert.equal(queryCount(afterStatus, 'list_squadMembers_squadId') > queryCount(beforeStatus, 'list_squadMembers_squadId'), true);
    assert.equal(queryCount(afterStatus, 'list_members_id') > queryCount(beforeStatus, 'list_members_id'), true);
    assert.equal(queryCount(afterStatus, 'list_wipeParticipants_memberId') > queryCount(beforeStatus, 'list_wipeParticipants_memberId'), true);

    const beforeCandidatesStatus = afterStatus;
    const candidatesResponse = await httpFetch(`${baseUrl}/squads/squad_sqlite_read_target/candidates`, {
      headers: { cookie: rootCookie }
    });
    assert.equal(candidatesResponse.status, 200);
    const candidatesPayload = await candidatesResponse.json();
    assert.equal(candidatesPayload.ok, true);
    assert.deepEqual(candidatesPayload.members.map((member) => member.steamId), ['76561198006666663']);
    const afterCandidatesStatus = await storeModule.storeRuntimeStatus({ sqliteSummary: false });
    assert.equal(queryCount(afterCandidatesStatus, 'read_store_full'), queryCount(beforeCandidatesStatus, 'read_store_full'));
    assert.equal(queryCount(afterCandidatesStatus, 'list_users'), queryCount(beforeCandidatesStatus, 'list_users'));
    assert.equal(queryCount(afterCandidatesStatus, 'list_wipes'), queryCount(beforeCandidatesStatus, 'list_wipes'));
    assert.equal(queryCount(afterCandidatesStatus, 'list_wipeParticipants'), queryCount(beforeCandidatesStatus, 'list_wipeParticipants'));
    assert.equal(queryCount(afterCandidatesStatus, 'list_permissionRoles'), queryCount(beforeCandidatesStatus, 'list_permissionRoles'));
    assert.equal(queryCount(afterCandidatesStatus, 'list_members') > queryCount(beforeCandidatesStatus, 'list_members'), true);
    assert.equal(queryCount(afterCandidatesStatus, 'list_squads') > queryCount(beforeCandidatesStatus, 'list_squads'), true);
    assert.equal(queryCount(afterCandidatesStatus, 'list_squadMembers') > queryCount(beforeCandidatesStatus, 'list_squadMembers'), true);
    assert.equal(queryCount(afterCandidatesStatus, 'list_users_id') > queryCount(beforeCandidatesStatus, 'list_users_id'), true);
  } finally {
    if (server) await new Promise((resolve) => server.close(resolve));
    globalThis.fetch = originalFetch;
    const sqliteModule = await import('../server/storage/sqlite.js');
    await sqliteModule.closeSqliteDatabasesForTests();
    Object.assign(process.env, previousEnv);
    for (const [key, value] of Object.entries(previousEnv)) {
      if (value === undefined) delete process.env[key];
    }
    await rm(dataDir, { recursive: true, force: true });
  }
});

test('sqlite-primary wechat admin squad lifecycle uses direct SQLite patch writes', async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'nb-clan-sqlite-wechat-admin-squad-'));
  const previousEnv = {
    NB_DATA_DIR: process.env.NB_DATA_DIR,
    NB_ROOT_PASSWORD: process.env.NB_ROOT_PASSWORD,
    NB_STORAGE_MODE: process.env.NB_STORAGE_MODE,
    NB_SQLITE_FILE: process.env.NB_SQLITE_FILE,
    NB_DISABLE_BACKGROUND_JOBS: process.env.NB_DISABLE_BACKGROUND_JOBS,
    NB_DISABLE_EXTERNAL_VITAL: process.env.NB_DISABLE_EXTERNAL_VITAL,
    NB_RUSTPLUS_RELAY_CHAT_FLUSH_INTERVAL_MS: process.env.NB_RUSTPLUS_RELAY_CHAT_FLUSH_INTERVAL_MS
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

  let server = null;
  try {
    const storeModule = await uniqueImport('../server/store.js');
    const apiModule = await uniqueImport('../server/api.js');
    await storeModule.ensureStore();
    const createdAt = '2026-07-02T00:00:00.000Z';
    const closedAt = '2026-07-03T00:00:00.000Z';
    await storeModule.updateStore((store) => {
      store.users.push({
        id: 'user_sqlite_wechat_squad_leader',
        username: 'sqlite_wechat_squad_leader',
        role: 'leader',
        boundSteamId: '76561198006666661',
        steamNickname: 'SQLite WeChat Leader',
        createdAt,
        updatedAt: createdAt
      });
      store.wipes.push({
        id: 'wipe_sqlite_wechat_squad_live',
        name: 'SQLite WeChat Squad Live',
        status: 'active',
        startedAt: createdAt,
        createdAt,
        updatedAt: createdAt
      }, {
        id: 'wipe_sqlite_wechat_squad_closed',
        name: 'SQLite WeChat Squad Closed',
        status: 'closed',
        startedAt: createdAt,
        closedAt,
        createdAt,
        updatedAt: closedAt
      });
    });

    const app = express();
    app.use('/api', apiModule.createApiRouter());
    server = createServer(app);
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const baseUrl = `http://127.0.0.1:${server.address().port}/api`;

    const loginResponse = await httpFetch(`${baseUrl}/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'root', password: 'RootPass123!' })
    });
    assert.equal(loginResponse.status, 200);
    const cookie = loginResponse.headers.get('set-cookie')?.split(';')[0] || '';
    assert.match(cookie, /^nb_session=/);

    const repositoryModule = await import('../server/storage/repository.js');
    const queryCount = (status, name) => status.sqlite?.queries?.byName?.[name]?.total || 0;
    const beforeCreateFailureStatus = await storeModule.storeRuntimeStatus({ sqliteSummary: false });
    const beforeCreateFailureReadStoreFull = queryCount(beforeCreateFailureStatus, 'read_store_full');
    repositoryModule.injectSqliteStorePatchFailureForTests('wechat_admin_squad_add', 1);
    const failedCreateResponse = await httpFetch(`${baseUrl}/wechat/admin/squads`, {
      method: 'POST',
      headers: {
        cookie,
        'content-type': 'application/json'
      },
      body: JSON.stringify({
        name: 'SQLite WeChat Admin Failed Squad',
        leaderUserId: 'user_sqlite_wechat_squad_leader',
        color: '#2563eb',
        iconUrl: 'https://example.com/sqlite-wechat-squad-failed.png',
        notes: 'SQLite failed create'
      })
    });
    const failedCreatePayload = await failedCreateResponse.json();
    assert.equal(failedCreateResponse.status, 503);
    assert.match(failedCreatePayload.error, /微信管理队伍写入暂不可用/);
    const afterCreateFailureStatus = await storeModule.storeRuntimeStatus({ sqliteSummary: false });
    assert.equal(queryCount(afterCreateFailureStatus, 'read_store_full'), beforeCreateFailureReadStoreFull);
    const failedCreatedSquads = await repositoryModule.getSqliteCollection('squads', { limit: 0 });
    assert.equal(failedCreatedSquads.some((squad) => squad.name === 'SQLite WeChat Admin Failed Squad'), false);

    const beforeCreateStat = await stat(storeModule.STORE_FILE);
    const beforeCreateStatus = await storeModule.storeRuntimeStatus({ sqliteSummary: false });
    const beforeCreateListUsers = queryCount(beforeCreateStatus, 'list_users');
    const beforeCreateListSquads = queryCount(beforeCreateStatus, 'list_squads');
    const beforeCreateListMembers = queryCount(beforeCreateStatus, 'list_members');
    const beforeCreateListWipeParticipants = queryCount(beforeCreateStatus, 'list_wipeParticipants');
    const beforeCreateUsersById = queryCount(beforeCreateStatus, 'list_users_id');
    const createResponse = await httpFetch(`${baseUrl}/wechat/admin/squads`, {
      method: 'POST',
      headers: {
        cookie,
        'content-type': 'application/json'
      },
      body: JSON.stringify({
        name: 'SQLite WeChat Admin Squad',
        leaderUserId: 'user_sqlite_wechat_squad_leader',
        color: '#2563eb',
        iconUrl: 'https://example.com/sqlite-wechat-squad.png',
        notes: 'SQLite direct create'
      })
    });
    assert.equal(createResponse.status, 200);
    const createPayload = await createResponse.json();
    assert.equal(createPayload.squad.name, 'SQLite WeChat Admin Squad');
    assert.equal(createPayload.squad.leaderUserIds.includes('user_sqlite_wechat_squad_leader'), true);
    const createdSquadId = createPayload.squad.id;
    assert.ok(createdSquadId);

    const afterCreateStat = await stat(storeModule.STORE_FILE);
    const afterCreateStatus = await storeModule.storeRuntimeStatus({ sqliteSummary: false });
    assert.equal(afterCreateStat.mtimeMs, beforeCreateStat.mtimeMs);
    assert.equal(afterCreateStatus.metrics.writes.total, beforeCreateStatus.metrics.writes.total);
    assert.equal(afterCreateStatus.metrics.sqliteWrites, beforeCreateStatus.metrics.sqliteWrites);
    assert.equal(queryCount(afterCreateStatus, 'list_users') <= beforeCreateListUsers + 1, true);
    assert.equal(queryCount(afterCreateStatus, 'list_squads') <= beforeCreateListSquads + 1, true);
    assert.equal(queryCount(afterCreateStatus, 'list_members'), beforeCreateListMembers);
    assert.equal(queryCount(afterCreateStatus, 'list_wipeParticipants'), beforeCreateListWipeParticipants);
    assert.equal(queryCount(afterCreateStatus, 'list_users_id') > beforeCreateUsersById, true);
    let createdSquad = await repositoryModule.getSqliteRecord('squads', createdSquadId);
    assert.equal(createdSquad.color, '#2563eb');
    let leaderMembers = await repositoryModule.getSqliteRecordsByJsonField('members', 'steamId', ['76561198006666661'], { limit: 0 });
    assert.equal(leaderMembers.length, 1);
    const leaderMember = leaderMembers[0];
    let leaderSquadMembers = await repositoryModule.getSqliteRecordsByJsonField('squadMembers', 'memberId', [leaderMember.id], { limit: 0 });
    assert.equal(leaderSquadMembers.some((item) => item.squadId === createdSquadId), true);
    let logs = await repositoryModule.getSqliteCollection('logs', { limit: 0 });
    assert.equal(logs.some((log) => log.type === 'wechat_admin_squad_add' && log.targetId === createdSquadId), true);

    const beforeEditFailureStatus = await storeModule.storeRuntimeStatus({ sqliteSummary: false });
    const beforeEditFailureReadStoreFull = queryCount(beforeEditFailureStatus, 'read_store_full');
    repositoryModule.injectSqliteStorePatchFailureForTests('wechat_admin_squad_edit', 1);
    const failedEditResponse = await httpFetch(`${baseUrl}/wechat/admin/squads/${createdSquadId}`, {
      method: 'PUT',
      headers: {
        cookie,
        'content-type': 'application/json'
      },
      body: JSON.stringify({
        name: 'SQLite WeChat Admin Squad Failed Edit',
        color: '#0f766e',
        iconUrl: 'https://example.com/sqlite-wechat-squad-failed-edit.png',
        notes: 'SQLite failed edit'
      })
    });
    const failedEditPayload = await failedEditResponse.json();
    assert.equal(failedEditResponse.status, 503);
    assert.match(failedEditPayload.error, /微信管理队伍写入暂不可用/);
    const afterEditFailureStatus = await storeModule.storeRuntimeStatus({ sqliteSummary: false });
    assert.equal(queryCount(afterEditFailureStatus, 'read_store_full'), beforeEditFailureReadStoreFull);
    createdSquad = await repositoryModule.getSqliteRecord('squads', createdSquadId);
    assert.equal(createdSquad.notes, 'SQLite direct create');
    assert.equal(createdSquad.color, '#2563eb');

    const beforeEditStat = await stat(storeModule.STORE_FILE);
    const beforeEditStatus = await storeModule.storeRuntimeStatus({ sqliteSummary: false });
    const beforeEditListUsers = queryCount(beforeEditStatus, 'list_users');
    const beforeEditListSquads = queryCount(beforeEditStatus, 'list_squads');
    const beforeEditListMembers = queryCount(beforeEditStatus, 'list_members');
    const beforeEditListWipeParticipants = queryCount(beforeEditStatus, 'list_wipeParticipants');
    const beforeEditUsersById = queryCount(beforeEditStatus, 'list_users_id');
    const beforeEditSquadsById = queryCount(beforeEditStatus, 'list_squads_id');
    const editResponse = await httpFetch(`${baseUrl}/wechat/admin/squads/${createdSquadId}`, {
      method: 'PUT',
      headers: {
        cookie,
        'content-type': 'application/json'
      },
      body: JSON.stringify({
        name: 'SQLite WeChat Admin Squad Edited',
        color: '#0f766e',
        iconUrl: 'https://example.com/sqlite-wechat-squad-edited.png',
        notes: 'SQLite direct edit'
      })
    });
    assert.equal(editResponse.status, 200);
    const editPayload = await editResponse.json();
    assert.equal(editPayload.squad.name, 'SQLite WeChat Admin Squad Edited');
    assert.deepEqual(editPayload.squad.leaderUserIds, ['user_sqlite_wechat_squad_leader']);
    const afterEditStat = await stat(storeModule.STORE_FILE);
    const afterEditStatus = await storeModule.storeRuntimeStatus({ sqliteSummary: false });
    assert.equal(afterEditStat.mtimeMs, beforeEditStat.mtimeMs);
    assert.equal(afterEditStatus.metrics.writes.total, beforeEditStatus.metrics.writes.total);
    assert.equal(afterEditStatus.metrics.sqliteWrites, beforeEditStatus.metrics.sqliteWrites);
    assert.equal(queryCount(afterEditStatus, 'list_users') <= beforeEditListUsers + 1, true);
    assert.equal(queryCount(afterEditStatus, 'list_squads') <= beforeEditListSquads + 1, true);
    assert.equal(queryCount(afterEditStatus, 'list_members'), beforeEditListMembers);
    assert.equal(queryCount(afterEditStatus, 'list_wipeParticipants'), beforeEditListWipeParticipants);
    assert.equal(queryCount(afterEditStatus, 'list_users_id') > beforeEditUsersById, true);
    assert.equal(queryCount(afterEditStatus, 'list_squads_id') > beforeEditSquadsById, true);
    createdSquad = await repositoryModule.getSqliteRecord('squads', createdSquadId);
    assert.equal(createdSquad.notes, 'SQLite direct edit');
    logs = await repositoryModule.getSqliteCollection('logs', { limit: 0 });
    assert.equal(logs.some((log) => log.type === 'wechat_admin_squad_edit' && log.targetId === createdSquadId), true);

    await repositoryModule.writeSqliteStorePatch({
      reason: 'seed_wechat_admin_squad_delete_records',
      upserts: {
        wipeParticipants: [{
          id: 'participant_sqlite_wechat_squad_live',
          wipeId: 'wipe_sqlite_wechat_squad_live',
          memberId: leaderMember.id,
          steamId: '76561198006666661',
          squadId: createdSquadId,
          status: 'on_time',
          createdAt,
          updatedAt: createdAt
        }, {
          id: 'participant_sqlite_wechat_squad_live_steam_only',
          wipeId: 'wipe_sqlite_wechat_squad_live',
          memberId: 'legacy_sqlite_wechat_squad_member',
          steamId: '76561198006666661',
          squadId: createdSquadId,
          status: 'on_time',
          createdAt,
          updatedAt: createdAt
        }, {
          id: 'participant_sqlite_wechat_squad_closed',
          wipeId: 'wipe_sqlite_wechat_squad_closed',
          memberId: leaderMember.id,
          steamId: '76561198006666661',
          squadId: createdSquadId,
          status: 'on_time',
          createdAt,
          updatedAt: closedAt
        }],
        kdaRows: [{
          id: 'kda_sqlite_wechat_squad_live',
          wipeId: 'wipe_sqlite_wechat_squad_live',
          memberId: leaderMember.id,
          steamId: '',
          squadId: createdSquadId,
          kills: 4,
          syncedAt: createdAt
        }, {
          id: 'kda_sqlite_wechat_squad_live_steam_only',
          wipeId: 'wipe_sqlite_wechat_squad_live',
          memberId: 'legacy_sqlite_wechat_squad_member',
          steamId: '76561198006666661',
          squadId: createdSquadId,
          kills: 5,
          syncedAt: createdAt
        }, {
          id: 'kda_sqlite_wechat_squad_closed',
          wipeId: 'wipe_sqlite_wechat_squad_closed',
          memberId: leaderMember.id,
          steamId: '76561198006666661',
          squadId: createdSquadId,
          kills: 9,
          syncedAt: closedAt
        }],
        kdaSnapshots: [{
          id: 'kda_snapshot_sqlite_wechat_squad_live',
          wipeId: 'wipe_sqlite_wechat_squad_live',
          memberId: leaderMember.id,
          steamId: '76561198006666661',
          squadId: createdSquadId,
          kills: 4,
          capturedAt: createdAt
        }, {
          id: 'kda_snapshot_sqlite_wechat_squad_live_steam_only',
          wipeId: 'wipe_sqlite_wechat_squad_live',
          memberId: 'legacy_sqlite_wechat_squad_member',
          steamId: '76561198006666661',
          squadId: createdSquadId,
          kills: 5,
          capturedAt: createdAt
        }, {
          id: 'kda_snapshot_sqlite_wechat_squad_closed',
          wipeId: 'wipe_sqlite_wechat_squad_closed',
          memberId: leaderMember.id,
          steamId: '76561198006666661',
          squadId: createdSquadId,
          kills: 9,
          capturedAt: closedAt
        }]
      }
    });

    const beforeDeleteFailureStatus = await storeModule.storeRuntimeStatus({ sqliteSummary: false });
    const beforeDeleteFailureReadStoreFull = queryCount(beforeDeleteFailureStatus, 'read_store_full');
    repositoryModule.injectSqliteStorePatchFailureForTests('wechat_admin_squad_delete', 1);
    const failedDeleteResponse = await httpFetch(`${baseUrl}/wechat/admin/squads/${createdSquadId}`, {
      method: 'DELETE',
      headers: { cookie }
    });
    const failedDeletePayload = await failedDeleteResponse.json();
    assert.equal(failedDeleteResponse.status, 503);
    assert.match(failedDeletePayload.error, /微信管理队伍写入暂不可用/);
    const afterDeleteFailureStatus = await storeModule.storeRuntimeStatus({ sqliteSummary: false });
    assert.equal(queryCount(afterDeleteFailureStatus, 'read_store_full'), beforeDeleteFailureReadStoreFull);
    createdSquad = await repositoryModule.getSqliteRecord('squads', createdSquadId);
    assert.equal(createdSquad.archivedAt || '', '');
    leaderSquadMembers = await repositoryModule.getSqliteRecordsByJsonField('squadMembers', 'memberId', [leaderMember.id], { limit: 0 });
    assert.equal(leaderSquadMembers.some((item) => item.squadId === createdSquadId), true);
    assert.notEqual(await repositoryModule.getSqliteRecord('wipeParticipants', 'participant_sqlite_wechat_squad_live'), null);
    assert.notEqual(await repositoryModule.getSqliteRecord('kdaRows', 'kda_sqlite_wechat_squad_live'), null);

    const beforeDeleteStat = await stat(storeModule.STORE_FILE);
    const beforeDeleteStatus = await storeModule.storeRuntimeStatus({ sqliteSummary: false });
    const beforeDeleteListSquads = queryCount(beforeDeleteStatus, 'list_squads');
    const beforeDeleteListMembers = queryCount(beforeDeleteStatus, 'list_members');
    const beforeDeleteListWipeParticipants = queryCount(beforeDeleteStatus, 'list_wipeParticipants');
    const beforeDeleteSquadsById = queryCount(beforeDeleteStatus, 'list_squads_id');
    const deleteResponse = await httpFetch(`${baseUrl}/wechat/admin/squads/${createdSquadId}`, {
      method: 'DELETE',
      headers: { cookie }
    });
    assert.equal(deleteResponse.status, 200);
    const deletePayload = await deleteResponse.json();
    assert.equal(deletePayload.squads.some((squad) => squad.id === createdSquadId), false);
    const afterDeleteStat = await stat(storeModule.STORE_FILE);
    const afterDeleteStatus = await storeModule.storeRuntimeStatus({ sqliteSummary: false });
    assert.equal(afterDeleteStat.mtimeMs, beforeDeleteStat.mtimeMs);
    assert.equal(afterDeleteStatus.metrics.writes.total, beforeDeleteStatus.metrics.writes.total);
    assert.equal(afterDeleteStatus.metrics.sqliteWrites, beforeDeleteStatus.metrics.sqliteWrites);
    assert.equal(queryCount(afterDeleteStatus, 'list_squads') <= beforeDeleteListSquads + 1, true);
    assert.equal(queryCount(afterDeleteStatus, 'list_members'), beforeDeleteListMembers);
    assert.equal(queryCount(afterDeleteStatus, 'list_wipeParticipants'), beforeDeleteListWipeParticipants);
    assert.equal(queryCount(afterDeleteStatus, 'list_squads_id') > beforeDeleteSquadsById, true);
    createdSquad = await repositoryModule.getSqliteRecord('squads', createdSquadId);
    assert.equal(Boolean(createdSquad.archivedAt), true);
    leaderSquadMembers = await repositoryModule.getSqliteRecordsByJsonField('squadMembers', 'memberId', [leaderMember.id], { limit: 0 });
    assert.equal(leaderSquadMembers.some((item) => item.squadId === createdSquadId), false);
    assert.equal(await repositoryModule.getSqliteRecord('wipeParticipants', 'participant_sqlite_wechat_squad_live'), null);
    assert.equal(await repositoryModule.getSqliteRecord('wipeParticipants', 'participant_sqlite_wechat_squad_live_steam_only'), null);
    assert.equal(await repositoryModule.getSqliteRecord('kdaRows', 'kda_sqlite_wechat_squad_live'), null);
    assert.equal(await repositoryModule.getSqliteRecord('kdaRows', 'kda_sqlite_wechat_squad_live_steam_only'), null);
    assert.equal(await repositoryModule.getSqliteRecord('kdaSnapshots', 'kda_snapshot_sqlite_wechat_squad_live'), null);
    assert.equal(await repositoryModule.getSqliteRecord('kdaSnapshots', 'kda_snapshot_sqlite_wechat_squad_live_steam_only'), null);
    assert.equal((await repositoryModule.getSqliteRecord('wipeParticipants', 'participant_sqlite_wechat_squad_closed')).squadId, createdSquadId);
    assert.equal((await repositoryModule.getSqliteRecord('kdaRows', 'kda_sqlite_wechat_squad_closed')).kills, 9);
    assert.equal((await repositoryModule.getSqliteRecord('kdaSnapshots', 'kda_snapshot_sqlite_wechat_squad_closed')).kills, 9);
    logs = await repositoryModule.getSqliteCollection('logs', { limit: 0 });
    assert.equal(logs.some((log) => log.type === 'wechat_admin_squad_delete' && log.targetId === createdSquadId), true);
  } finally {
    if (server) await new Promise((resolve) => server.close(resolve));
    globalThis.fetch = originalFetch;
    const sqliteModule = await import('../server/storage/sqlite.js');
    await sqliteModule.closeSqliteDatabasesForTests();
    Object.assign(process.env, previousEnv);
    for (const [key, value] of Object.entries(previousEnv)) {
      if (value === undefined) delete process.env[key];
    }
    await rm(dataDir, { recursive: true, force: true });
  }
});

test('sqlite-primary operation runs use direct SQLite patch writes', async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'nb-clan-sqlite-operation-runs-'));
  const previousEnv = {
    NB_DATA_DIR: process.env.NB_DATA_DIR,
    NB_ROOT_PASSWORD: process.env.NB_ROOT_PASSWORD,
    NB_STORAGE_MODE: process.env.NB_STORAGE_MODE,
    NB_SQLITE_FILE: process.env.NB_SQLITE_FILE,
    NB_DISABLE_BACKGROUND_JOBS: process.env.NB_DISABLE_BACKGROUND_JOBS,
    NB_DISABLE_EXTERNAL_VITAL: process.env.NB_DISABLE_EXTERNAL_VITAL,
    NB_RUSTPLUS_RELAY_CHAT_FLUSH_INTERVAL_MS: process.env.NB_RUSTPLUS_RELAY_CHAT_FLUSH_INTERVAL_MS,
    NB_TRACE_RECORD_DIRECT_RETRY_ATTEMPTS: process.env.NB_TRACE_RECORD_DIRECT_RETRY_ATTEMPTS,
    NB_TRACE_RECORD_GENERIC_FALLBACK: process.env.NB_TRACE_RECORD_GENERIC_FALLBACK
  };
  process.env.NB_DATA_DIR = dataDir;
  process.env.NB_ROOT_PASSWORD = 'RootPass123!';
  process.env.NB_STORAGE_MODE = 'sqlite-primary';
  process.env.NB_SQLITE_FILE = path.join(dataDir, 'nb-clan.sqlite');
  process.env.NB_DISABLE_BACKGROUND_JOBS = '1';
  process.env.NB_DISABLE_EXTERNAL_VITAL = '1';
  process.env.NB_RUSTPLUS_RELAY_CHAT_FLUSH_INTERVAL_MS = '0';
  process.env.NB_TRACE_RECORD_DIRECT_RETRY_ATTEMPTS = '0';
  delete process.env.NB_TRACE_RECORD_GENERIC_FALLBACK;

  let server = null;
  try {
    const storeModule = await uniqueImport('../server/store.js');
    const apiModule = await uniqueImport('../server/api.js');
    const authModule = await uniqueImport('../server/auth.js');
    const operationRunsModule = await uniqueImport('../server/operation-runs.js');
    const integrationEventsModule = await uniqueImport('../server/integration-events.js');
    const repositoryModule = await import('../server/storage/repository.js');
    const traceModule = await import('../server/trace-record-persistence.js');
    const httpFetch = globalThis.fetch.bind(globalThis);
    await storeModule.ensureStore();
    traceModule.resetTraceRecordPersistenceForTests();
    const beforeStatus = await storeModule.storeRuntimeStatus();
    const queryCount = (status, name) => status.sqlite?.queries?.byName?.[name]?.total || 0;
    const writeCount = (status, name) => status.sqlite?.writes?.byName?.[name]?.total || 0;
    const beforeListOperationRuns = queryCount(beforeStatus, 'list_operationRuns');
    const beforeGetOperationRuns = queryCount(beforeStatus, 'get_operationRuns');
    const beforeOperationRunsById = queryCount(beforeStatus, 'list_operationRuns_id');
    const beforeOperationRunsByStatus = queryCount(beforeStatus, 'list_operationRuns_status');
    const beforeListIntegrationEvents = queryCount(beforeStatus, 'list_integrationEvents');
    const beforeGetIntegrationEvents = queryCount(beforeStatus, 'get_integrationEvents');
    const beforeIntegrationEventsById = queryCount(beforeStatus, 'list_integrationEvents_id');
    const beforeIntegrationEventsByDedupeKey = queryCount(beforeStatus, 'list_integrationEvents_dedupeKey');
    const beforeIntegrationEventsByPlatformDedupeKey = queryCount(beforeStatus, 'list_integrationEvents_platform_dedupeKey');
    const beforeIntegrationEventsByStatus = queryCount(beforeStatus, 'list_integrationEvents_status');

	    const beforeOperationCreateFailureStatus = await storeModule.storeRuntimeStatus({ sqliteSummary: false });
	    const beforeOperationCreateFailureReadStoreFull = queryCount(beforeOperationCreateFailureStatus, 'read_store_full');
	    repositoryModule.injectSqliteStorePatchFailureForTests('*', 1);
	    const failedRun = await operationRunsModule.createOperationRun({
	      id: 'operation_run_sqlite_default_no_fallback',
	      type: 'sqlite_operation_run_default_no_fallback',
	      platform: 'system',
	      source: 'system',
	      status: 'running',
	      targetType: 'test',
	      targetId: 'sqlite_operation_run_default_no_fallback'
	    });
	    const afterOperationCreateFailureStatus = await storeModule.storeRuntimeStatus({ sqliteSummary: false });
	    assert.equal(failedRun, null);
	    assert.equal(queryCount(afterOperationCreateFailureStatus, 'read_store_full'), beforeOperationCreateFailureReadStoreFull);
	    assert.equal(await repositoryModule.getSqliteRecord('operationRuns', 'operation_run_sqlite_default_no_fallback'), null);
	    let traceSnapshot = traceModule.traceRecordPersistenceSnapshot();
	    assert.equal(traceSnapshot.config.genericFallbackEnabled, false);
	    assert.equal(traceSnapshot.records.some((item) => (
	      item.name === 'operation_run_create' &&
	      item.fallbackAttempts === 0 &&
	      item.fallbackSuppressed === 1
	    )), true);

	    const run = await operationRunsModule.createOperationRun({
	      type: 'sqlite_operation_run_direct_patch',
	      platform: 'discord',
	      source: 'manual',
	      status: 'running',
	      targetType: 'test',
	      targetId: 'sqlite_operation_run_direct_patch'
	    });
	    const afterOperationRunCreateStatus = await storeModule.storeRuntimeStatus({ sqliteSummary: false });
	    assert.equal(queryCount(afterOperationRunCreateStatus, 'list_operationRuns_status'), beforeOperationRunsByStatus);
	    repositoryModule.injectSqliteQueryFailureForTests('get_operationRuns', 1);
	    await operationRunsModule.updateOperationRun(run.id, {
	      status: 'succeeded',
	      metadata: { safe: 'kept' }
	    });
	    const afterOperationRunUpdateStatus = await storeModule.storeRuntimeStatus({ sqliteSummary: false });
	    assert.equal(queryCount(afterOperationRunUpdateStatus, 'list_operationRuns_status'), beforeOperationRunsByStatus);
	    assert.equal(queryCount(afterOperationRunUpdateStatus, 'list_operationRuns_id') > beforeOperationRunsById, true);

	    const beforeOperationUpdateFailureStatus = await storeModule.storeRuntimeStatus({ sqliteSummary: false });
	    const beforeOperationUpdateFailureReadStoreFull = queryCount(beforeOperationUpdateFailureStatus, 'read_store_full');
	    repositoryModule.injectSqliteStorePatchFailureForTests('*', 1);
	    const failedOperationUpdate = await operationRunsModule.updateOperationRun(run.id, {
	      status: 'failed',
	      errorSummary: 'should not generic fallback'
	    });
	    const afterOperationUpdateFailureStatus = await storeModule.storeRuntimeStatus({ sqliteSummary: false });
	    const unchangedOperationAfterPatchFailure = await repositoryModule.getSqliteRecord('operationRuns', run.id);
	    assert.equal(failedOperationUpdate, null);
	    assert.equal(unchangedOperationAfterPatchFailure.status, 'succeeded');
	    assert.equal(queryCount(afterOperationUpdateFailureStatus, 'read_store_full'), beforeOperationUpdateFailureReadStoreFull);
	    traceSnapshot = traceModule.traceRecordPersistenceSnapshot();
	    assert.equal(traceSnapshot.records.some((item) => (
	      item.name === 'operation_run_update' &&
	      item.fallbackAttempts === 0 &&
	      item.fallbackSuppressed === 1
	    )), true);

	    const beforeOperationReadUnavailableStatus = await storeModule.storeRuntimeStatus({ sqliteSummary: false });
	    const beforeOperationReadUnavailableFull = queryCount(beforeOperationReadUnavailableStatus, 'read_store_full');
	    const beforeOperationReadUnavailableList = queryCount(beforeOperationReadUnavailableStatus, 'list_operationRuns');
	    repositoryModule.injectSqliteQueryFailureForTests('get_operationRuns', 1);
	    repositoryModule.injectSqliteQueryFailureForTests('list_operationRuns_id', 1);
	    const skippedOperationUpdate = await operationRunsModule.updateOperationRun(run.id, {
	      status: 'failed',
	      errorSummary: 'should not full fallback'
	    });
	    const afterOperationReadUnavailableStatus = await storeModule.storeRuntimeStatus({ sqliteSummary: false });
	    const unchangedOperationRun = await repositoryModule.getSqliteRecord('operationRuns', run.id);
	    assert.equal(skippedOperationUpdate, null);
	    assert.equal(unchangedOperationRun.status, 'succeeded');
	    assert.equal(queryCount(afterOperationReadUnavailableStatus, 'read_store_full'), beforeOperationReadUnavailableFull);
	    assert.equal(queryCount(afterOperationReadUnavailableStatus, 'list_operationRuns'), beforeOperationReadUnavailableList);

	    const beforeIntegrationCreateFailureStatus = await storeModule.storeRuntimeStatus({ sqliteSummary: false });
	    const beforeIntegrationCreateFailureReadStoreFull = queryCount(beforeIntegrationCreateFailureStatus, 'read_store_full');
	    repositoryModule.injectSqliteStorePatchFailureForTests('*', 1);
	    const failedIntegrationCreate = await integrationEventsModule.createIntegrationEvent({
	      id: 'integration_event_sqlite_default_no_fallback',
	      platform: 'discord',
	      eventType: 'interaction',
	      dedupeKey: 'discord:sqlite-default-no-fallback',
	      sourceId: 'interaction_sqlite_default_no_fallback',
	      status: 'received',
	      operationRunId: run.id
	    }, { dedupe: true });
	    const afterIntegrationCreateFailureStatus = await storeModule.storeRuntimeStatus({ sqliteSummary: false });
	    assert.equal(failedIntegrationCreate, null);
	    assert.equal(queryCount(afterIntegrationCreateFailureStatus, 'read_store_full'), beforeIntegrationCreateFailureReadStoreFull);
	    assert.equal(await repositoryModule.getSqliteRecord('integrationEvents', 'integration_event_sqlite_default_no_fallback'), null);
	    traceSnapshot = traceModule.traceRecordPersistenceSnapshot();
	    assert.equal(traceSnapshot.records.some((item) => (
	      item.name === 'integration_event_create' &&
	      item.fallbackAttempts === 0 &&
	      item.fallbackSuppressed === 1
	    )), true);

	    const integrationEventResult = await integrationEventsModule.createIntegrationEvent({
	      platform: 'discord',
	      eventType: 'interaction',
	      dedupeKey: 'discord:sqlite-direct-patch',
      sourceId: 'interaction_sqlite_direct_patch',
      status: 'received',
      operationRunId: run.id,
      metadata: {
        safe: 'kept',
	        botToken: 'must_not_be_persisted'
	      }
	    }, { dedupe: true });
	    const afterIntegrationEventCreateStatus = await storeModule.storeRuntimeStatus({ sqliteSummary: false });
	    assert.equal(queryCount(afterIntegrationEventCreateStatus, 'list_integrationEvents_status'), beforeIntegrationEventsByStatus);
	    const duplicateIntegrationEventResult = await integrationEventsModule.createIntegrationEvent({
	      platform: 'discord',
	      eventType: 'interaction',
	      dedupeKey: 'discord:sqlite-direct-patch',
      sourceId: 'interaction_sqlite_direct_patch_duplicate',
      status: 'received',
      operationRunId: run.id,
      metadata: {
        safe: 'duplicate',
        authorization: 'must_not_be_persisted'
      }
    }, { dedupe: true });
	    assert.equal(duplicateIntegrationEventResult.duplicate, true);
	    assert.equal(duplicateIntegrationEventResult.event.status, 'duplicate');
	    assert.equal(duplicateIntegrationEventResult.event.metadata.duplicateOf, integrationEventResult.event.id);
	    const afterDuplicateIntegrationEventStatus = await storeModule.storeRuntimeStatus({ sqliteSummary: false });
	    assert.equal(queryCount(afterDuplicateIntegrationEventStatus, 'list_integrationEvents_status'), beforeIntegrationEventsByStatus);
	    const beforeIntegrationUpdateFailureStatus = await storeModule.storeRuntimeStatus({ sqliteSummary: false });
	    const beforeIntegrationUpdateFailureReadStoreFull = queryCount(beforeIntegrationUpdateFailureStatus, 'read_store_full');
	    repositoryModule.injectSqliteStorePatchFailureForTests('*', 1);
	    const failedIntegrationUpdate = await integrationEventsModule.updateIntegrationEvent(integrationEventResult.event.id, {
	      status: 'failed',
	      errorSummary: 'should not generic fallback'
	    });
	    const afterIntegrationUpdateFailureStatus = await storeModule.storeRuntimeStatus({ sqliteSummary: false });
	    const unchangedIntegrationAfterPatchFailure = await repositoryModule.getSqliteRecord('integrationEvents', integrationEventResult.event.id);
	    assert.equal(failedIntegrationUpdate, null);
	    assert.equal(unchangedIntegrationAfterPatchFailure.status, 'received');
	    assert.equal(queryCount(afterIntegrationUpdateFailureStatus, 'read_store_full'), beforeIntegrationUpdateFailureReadStoreFull);
	    traceSnapshot = traceModule.traceRecordPersistenceSnapshot();
	    assert.equal(traceSnapshot.records.some((item) => (
	      item.name === 'integration_event_update' &&
	      item.fallbackAttempts === 0 &&
	      item.fallbackSuppressed === 1
	    )), true);
	    repositoryModule.injectSqliteQueryFailureForTests('get_integrationEvents', 1);
	    await integrationEventsModule.updateIntegrationEvent(integrationEventResult.event.id, {
	      status: 'processed',
	      metadata: {
        processed: 'yes',
        authorization: 'must_not_be_persisted'
      }
    });
	    const afterIntegrationEventUpdateStatus = await storeModule.storeRuntimeStatus({ sqliteSummary: false });
	    assert.equal(queryCount(afterIntegrationEventUpdateStatus, 'list_integrationEvents_id') > beforeIntegrationEventsById, true);

	    const beforeIntegrationReadUnavailableStatus = await storeModule.storeRuntimeStatus({ sqliteSummary: false });
	    const beforeIntegrationReadUnavailableFull = queryCount(beforeIntegrationReadUnavailableStatus, 'read_store_full');
	    const beforeIntegrationReadUnavailableList = queryCount(beforeIntegrationReadUnavailableStatus, 'list_integrationEvents');
	    repositoryModule.injectSqliteQueryFailureForTests('get_integrationEvents', 1);
	    repositoryModule.injectSqliteQueryFailureForTests('list_integrationEvents_id', 1);
	    const skippedIntegrationUpdate = await integrationEventsModule.updateIntegrationEvent(integrationEventResult.event.id, {
	      status: 'failed',
	      errorSummary: 'should not full fallback'
	    });
	    const afterIntegrationReadUnavailableStatus = await storeModule.storeRuntimeStatus({ sqliteSummary: false });
	    const unchangedIntegrationEvent = await repositoryModule.getSqliteRecord('integrationEvents', integrationEventResult.event.id);
	    assert.equal(skippedIntegrationUpdate, null);
	    assert.equal(unchangedIntegrationEvent.status, 'processed');
	    assert.equal(queryCount(afterIntegrationReadUnavailableStatus, 'read_store_full'), beforeIntegrationReadUnavailableFull);
	    assert.equal(queryCount(afterIntegrationReadUnavailableStatus, 'list_integrationEvents'), beforeIntegrationReadUnavailableList);

    const scopedStatus = await storeModule.storeRuntimeStatus();
    assert.equal(queryCount(scopedStatus, 'list_operationRuns'), beforeListOperationRuns);
    assert.equal(queryCount(scopedStatus, 'list_integrationEvents'), beforeListIntegrationEvents);
    assert.equal(queryCount(scopedStatus, 'get_operationRuns') >= beforeGetOperationRuns, true);
    assert.equal(queryCount(scopedStatus, 'get_integrationEvents') >= beforeGetIntegrationEvents, true);
    assert.equal(queryCount(scopedStatus, 'list_operationRuns_id') > beforeOperationRunsById, true);
    assert.equal(queryCount(scopedStatus, 'list_integrationEvents_id') > beforeIntegrationEventsById, true);
    assert.equal(queryCount(scopedStatus, 'list_operationRuns_status'), beforeOperationRunsByStatus);
    assert.equal(queryCount(scopedStatus, 'list_integrationEvents_dedupeKey'), beforeIntegrationEventsByDedupeKey);
    assert.equal(queryCount(scopedStatus, 'list_integrationEvents_platform_dedupeKey') >= beforeIntegrationEventsByPlatformDedupeKey + 2, true);
    assert.equal(queryCount(scopedStatus, 'list_integrationEvents_status'), beforeIntegrationEventsByStatus);
    assert.equal(writeCount(scopedStatus, 'operation_run_create'), writeCount(beforeStatus, 'operation_run_create') + 1);
    assert.equal(writeCount(scopedStatus, 'operation_run_update'), writeCount(beforeStatus, 'operation_run_update') + 1);
    assert.equal(writeCount(scopedStatus, 'operation_run_create_trim'), writeCount(beforeStatus, 'operation_run_create_trim'));
    assert.equal(writeCount(scopedStatus, 'operation_run_update_trim'), writeCount(beforeStatus, 'operation_run_update_trim'));
    assert.equal(writeCount(scopedStatus, 'integration_event_create'), writeCount(beforeStatus, 'integration_event_create') + 2);
    assert.equal(writeCount(scopedStatus, 'integration_event_update'), writeCount(beforeStatus, 'integration_event_update') + 1);
    assert.equal(writeCount(scopedStatus, 'integration_event_create_trim'), writeCount(beforeStatus, 'integration_event_create_trim'));
    assert.equal(writeCount(scopedStatus, 'integration_event_update_trim'), writeCount(beforeStatus, 'integration_event_update_trim'));

    const operationRuns = await repositoryModule.getSqliteCollection('operationRuns', { limit: 20 });
    const persisted = operationRuns.find((item) => item.id === run.id);
    assert.equal(persisted.status, 'succeeded');
    assert.equal(persisted.metadata.safe, 'kept');

    const integrationEvents = await repositoryModule.getSqliteCollection('integrationEvents', { limit: 20 });
    const persistedIntegrationEvent = integrationEvents.find((item) => item.id === integrationEventResult.event.id);
    assert.equal(persistedIntegrationEvent.status, 'processed');
    assert.equal(persistedIntegrationEvent.operationRunId, run.id);
    assert.equal(persistedIntegrationEvent.metadata.safe, 'kept');
    assert.equal(persistedIntegrationEvent.metadata.processed, 'yes');
    assert.equal(JSON.stringify(persistedIntegrationEvent.metadata).includes('must_not_be_persisted'), false);

    const beforeIntegrationReadStatus = await storeModule.storeRuntimeStatus({ sqliteSummary: false });
    const beforeIntegrationReadList = queryCount(beforeIntegrationReadStatus, 'list_integrationEvents');
    const beforeIntegrationReadByStatus = queryCount(beforeIntegrationReadStatus, 'list_integrationEvents_status');
    const integrationEventListStore = await integrationEventsModule.readIntegrationEventsListStore();
    const integrationEventListPayload = integrationEventsModule.integrationEventsPayload(integrationEventListStore, { limit: 5 });
    assert.equal(integrationEventListPayload.recent.some((item) => item.id === integrationEventResult.event.id && item.status === 'processed'), true);
    assert.equal(integrationEventListPayload.duplicates.some((item) => item.id === duplicateIntegrationEventResult.event.id), true);
	    const afterIntegrationReadStatus = await storeModule.storeRuntimeStatus({ sqliteSummary: false });
	    assert.equal(queryCount(afterIntegrationReadStatus, 'list_integrationEvents'), beforeIntegrationReadList);
	    assert.equal(queryCount(afterIntegrationReadStatus, 'list_integrationEvents_status') > beforeIntegrationReadByStatus, true);

    const beforeIntegrationHealthStatus = await storeModule.storeRuntimeStatus({ sqliteSummary: false });
    const beforeIntegrationHealthList = queryCount(beforeIntegrationHealthStatus, 'list_integrationEvents');
    const beforeIntegrationHealthByStatus = queryCount(beforeIntegrationHealthStatus, 'list_integrationEvents_status');
    const integrationEventHealthStore = await integrationEventsModule.readIntegrationEventsHealthStore(8);
    const integrationEventHealthPayload = integrationEventsModule.integrationEventsPayload(integrationEventHealthStore, { limit: 5 });
    assert.equal(integrationEventHealthPayload.recent.some((item) => item.id === integrationEventResult.event.id && item.status === 'processed'), true);
    assert.equal(integrationEventHealthPayload.duplicates.some((item) => item.id === duplicateIntegrationEventResult.event.id), true);
    const afterIntegrationHealthStatus = await storeModule.storeRuntimeStatus({ sqliteSummary: false });
    assert.equal(queryCount(afterIntegrationHealthStatus, 'list_integrationEvents'), beforeIntegrationHealthList);
    assert.equal(queryCount(afterIntegrationHealthStatus, 'list_integrationEvents_status') > beforeIntegrationHealthByStatus, true);

	    const beforeOperationReadStatus = await storeModule.storeRuntimeStatus({ sqliteSummary: false });
	    const beforeOperationReadList = queryCount(beforeOperationReadStatus, 'list_operationRuns');
	    const beforeOperationReadByStatus = queryCount(beforeOperationReadStatus, 'list_operationRuns_status');
	    const operationRunListStore = await operationRunsModule.readOperationRunsListStore();
    const operationRunListPayload = operationRunsModule.operationRunsPayload(operationRunListStore, { limit: 5 });
    assert.equal(operationRunListPayload.recent.some((item) => item.id === run.id && item.status === 'succeeded'), true);
	    const afterOperationReadStatus = await storeModule.storeRuntimeStatus({ sqliteSummary: false });
	    assert.equal(queryCount(afterOperationReadStatus, 'list_operationRuns'), beforeOperationReadList);
	    assert.equal(queryCount(afterOperationReadStatus, 'list_operationRuns_status') > beforeOperationReadByStatus, true);

    const beforeOperationHealthStatus = await storeModule.storeRuntimeStatus({ sqliteSummary: false });
    const beforeOperationHealthList = queryCount(beforeOperationHealthStatus, 'list_operationRuns');
    const beforeOperationHealthByStatus = queryCount(beforeOperationHealthStatus, 'list_operationRuns_status');
    const operationRunHealthStore = await operationRunsModule.readOperationRunsHealthStore(8);
    const operationRunHealthPayload = operationRunsModule.operationRunsPayload(operationRunHealthStore, { limit: 5 });
    assert.equal(operationRunHealthPayload.recent.some((item) => item.id === run.id && item.status === 'succeeded'), true);
    const afterOperationHealthStatus = await storeModule.storeRuntimeStatus({ sqliteSummary: false });
    assert.equal(queryCount(afterOperationHealthStatus, 'list_operationRuns'), beforeOperationHealthList);
    assert.equal(queryCount(afterOperationHealthStatus, 'list_operationRuns_status') > beforeOperationHealthByStatus, true);

    const app = express();
    app.use('/api', apiModule.createApiRouter());
    server = createServer(app);
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const baseUrl = `http://127.0.0.1:${server.address().port}/api`;
    const sessionId = await authModule.createSession('user_root');
    const cookie = `nb_session=${encodeURIComponent(sessionId)}`;
    const beforeOperationRouteStatus = await storeModule.storeRuntimeStatus({ sqliteSummary: false });
    const beforeOperationRouteList = queryCount(beforeOperationRouteStatus, 'list_operationRuns');
    const beforeOperationRouteByStatus = queryCount(beforeOperationRouteStatus, 'list_operationRuns_status');
    const operationRunRouteResponse = await httpFetch(`${baseUrl}/sync/operation-runs/recent?limit=5`, {
      headers: { cookie }
    });
    const operationRunRoutePayload = await operationRunRouteResponse.json();
    assert.equal(operationRunRouteResponse.status, 200, JSON.stringify(operationRunRoutePayload));
    assert.equal(operationRunRoutePayload.recent.some((item) => item.id === run.id && item.status === 'succeeded'), true);
    const afterOperationRouteStatus = await storeModule.storeRuntimeStatus({ sqliteSummary: false });
    assert.equal(queryCount(afterOperationRouteStatus, 'list_operationRuns'), beforeOperationRouteList);
    assert.equal(queryCount(afterOperationRouteStatus, 'list_operationRuns_status') > beforeOperationRouteByStatus, true);

    const operationRetentionSeedRuns = Array.from({ length: 205 }, (_, index) => ({
      id: `operation_run_sqlite_retention_seed_${String(index).padStart(3, '0')}`,
      type: 'sqlite_operation_run_retention_seed',
      platform: 'system',
      source: 'system',
      status: 'succeeded',
      targetType: 'test',
      targetId: 'sqlite_operation_run_retention_seed',
      startedAt: new Date(Date.UTC(2026, 0, 1, 0, 0, index)).toISOString(),
      finishedAt: new Date(Date.UTC(2026, 0, 1, 0, 0, index + 1)).toISOString(),
      createdAt: new Date(Date.UTC(2026, 0, 1, 0, 0, index)).toISOString(),
      updatedAt: new Date(Date.UTC(2026, 0, 1, 0, 0, index + 1)).toISOString(),
      metadata: {}
    }));
    await repositoryModule.writeSqliteStorePatch({
      reason: 'sqlite_operation_run_retention_seed',
      upserts: { operationRuns: operationRetentionSeedRuns }
    });
    const beforeOperationRetentionStatus = await storeModule.storeRuntimeStatus({ sqliteSummary: false });
    const retainedOperationRun = await operationRunsModule.createOperationRun({
      id: 'operation_run_sqlite_retention_new',
      type: 'sqlite_operation_run_retention_new',
      platform: 'system',
      source: 'system',
      status: 'succeeded',
      targetType: 'test',
      targetId: 'sqlite_operation_run_retention_new',
      startedAt: '2030-01-01T00:00:00.000Z',
      finishedAt: '2030-01-01T00:00:01.000Z',
      createdAt: '2030-01-01T00:00:00.000Z',
      updatedAt: '2030-01-01T00:00:01.000Z'
    });
    assert.equal(retainedOperationRun.id, 'operation_run_sqlite_retention_new');
    const afterOperationRetentionStatus = await storeModule.storeRuntimeStatus({ sqliteSummary: false });
    assert.equal(queryCount(afterOperationRetentionStatus, 'list_operationRuns_status'), queryCount(beforeOperationRetentionStatus, 'list_operationRuns_status'));
    const retainedSucceededRuns = await repositoryModule.getSqliteRecordsByJsonField('operationRuns', 'status', ['succeeded'], { limit: 0 });
    assert.equal(retainedSucceededRuns.length, 200);
    assert.equal(retainedSucceededRuns.some((item) => item.id === 'operation_run_sqlite_retention_new'), true);
    assert.equal(retainedSucceededRuns.some((item) => item.id === 'operation_run_sqlite_retention_seed_000'), false);

    const integrationRetentionSeedEvents = Array.from({ length: 1005 }, (_, index) => ({
      id: `integration_event_sqlite_retention_seed_${String(index).padStart(4, '0')}`,
      platform: 'system',
      eventType: 'sqlite_integration_event_retention_seed',
      dedupeKey: `sqlite-integration-retention-seed-${index}`,
      sourceId: `sqlite_integration_retention_seed_${index}`,
      status: 'processed',
      receivedAt: new Date(Date.UTC(2026, 0, 1, 0, 0, index)).toISOString(),
      processedAt: new Date(Date.UTC(2026, 0, 1, 0, 0, index + 1)).toISOString(),
      operationRunId: '',
      errorSummary: '',
      createdAt: new Date(Date.UTC(2026, 0, 1, 0, 0, index)).toISOString(),
      updatedAt: new Date(Date.UTC(2026, 0, 1, 0, 0, index + 1)).toISOString(),
      metadata: {}
    }));
    await repositoryModule.writeSqliteStorePatch({
      reason: 'sqlite_integration_event_retention_seed',
      upserts: { integrationEvents: integrationRetentionSeedEvents }
    });
    const beforeIntegrationRetentionStatus = await storeModule.storeRuntimeStatus({ sqliteSummary: false });
    const retainedIntegrationEvent = await integrationEventsModule.createIntegrationEvent({
      id: 'integration_event_sqlite_retention_new',
      platform: 'system',
      eventType: 'sqlite_integration_event_retention_new',
      dedupeKey: 'sqlite-integration-retention-new',
      sourceId: 'sqlite_integration_retention_new',
      status: 'processed',
      receivedAt: '2030-01-01T00:00:00.000Z',
      processedAt: '2030-01-01T00:00:01.000Z',
      createdAt: '2030-01-01T00:00:00.000Z',
      updatedAt: '2030-01-01T00:00:01.000Z'
    });
    assert.equal(retainedIntegrationEvent.event.id, 'integration_event_sqlite_retention_new');
    const afterIntegrationRetentionStatus = await storeModule.storeRuntimeStatus({ sqliteSummary: false });
    assert.equal(queryCount(afterIntegrationRetentionStatus, 'list_integrationEvents_status'), queryCount(beforeIntegrationRetentionStatus, 'list_integrationEvents_status'));
    const retainedNonFailedEvents = await repositoryModule.getSqliteRecordsByJsonField(
      'integrationEvents',
      'status',
      ['received', 'queued', 'processing', 'processed', 'duplicate', 'skipped'],
      { limit: 0 }
    );
    assert.equal(retainedNonFailedEvents.length, 1000);
    assert.equal(retainedNonFailedEvents.some((item) => item.id === 'integration_event_sqlite_retention_new'), true);
    assert.equal(retainedNonFailedEvents.some((item) => item.id === 'integration_event_sqlite_retention_seed_0000'), false);

    await operationRunsModule.createOperationRun({
      id: 'operation_run_sqlite_stale_active',
      type: 'sqlite_operation_run_stale_active',
      platform: 'kook',
      source: 'auto',
      status: 'running',
      targetType: 'test',
      targetId: 'sqlite_operation_run_stale_active',
      startedAt: '2020-01-01T00:00:00.000Z',
      createdAt: '2020-01-01T00:00:00.000Z',
      updatedAt: '2020-01-01T00:00:00.000Z'
    });
    await operationRunsModule.createOperationRun({
      id: 'operation_run_sqlite_stale_terminal',
      type: 'sqlite_operation_run_stale_terminal',
      platform: 'kook',
      source: 'auto',
	      status: 'succeeded',
	      targetType: 'test',
	      targetId: 'sqlite_operation_run_stale_terminal',
	      startedAt: '2031-01-01T00:00:00.000Z',
	      finishedAt: '2031-01-01T00:00:01.000Z',
	      createdAt: '2031-01-01T00:00:00.000Z',
	      updatedAt: '2031-01-01T00:00:01.000Z'
	    });
    const beforeOperationReconcileStatus = await storeModule.storeRuntimeStatus({ sqliteSummary: false });
    const beforeOperationReconcileList = queryCount(beforeOperationReconcileStatus, 'list_operationRuns');
    const beforeOperationReconcileByStatus = queryCount(beforeOperationReconcileStatus, 'list_operationRuns_status');
    const beforeOperationReconcileGet = queryCount(beforeOperationReconcileStatus, 'get_operationRuns');
    const beforeOperationReconcileUpdate = writeCount(beforeOperationReconcileStatus, 'operation_run_update');
    const reconcileResult = await operationRunsModule.reconcileStaleOperationRuns({
      reason: 'sqlite stale operation run test'
    });
    assert.equal(reconcileResult.updated, 1);
    const staleOperationRun = await repositoryModule.getSqliteRecord('operationRuns', 'operation_run_sqlite_stale_active');
    const terminalOperationRun = await repositoryModule.getSqliteRecord('operationRuns', 'operation_run_sqlite_stale_terminal');
    assert.equal(staleOperationRun.status, 'failed');
    assert.equal(staleOperationRun.errorSummary, 'sqlite stale operation run test');
    assert.equal(terminalOperationRun.status, 'succeeded');
    const afterOperationReconcileStatus = await storeModule.storeRuntimeStatus({ sqliteSummary: false });
    assert.equal(queryCount(afterOperationReconcileStatus, 'list_operationRuns'), beforeOperationReconcileList);
    assert.equal(queryCount(afterOperationReconcileStatus, 'list_operationRuns_status') > beforeOperationReconcileByStatus, true);
    assert.equal(queryCount(afterOperationReconcileStatus, 'get_operationRuns') > beforeOperationReconcileGet, true);
    assert.equal(writeCount(afterOperationReconcileStatus, 'operation_run_update'), beforeOperationReconcileUpdate + 1);

    const afterStatus = await storeModule.storeRuntimeStatus();
    assert.equal(
      afterStatus.sqlite.compatibility.syncStoreChangesToSqlite,
      beforeStatus.sqlite.compatibility.syncStoreChangesToSqlite
    );
    assert.equal(afterStatus.metrics.sqliteWrites, beforeStatus.metrics.sqliteWrites);

    const liteStatus = await storeModule.storeRuntimeStatus({ sqliteSummary: false });
    assert.equal(liteStatus.sqlite.summarySkipped, true);
    assert.deepEqual(liteStatus.sqlite.records, {});
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

test('sqlite-primary message deletion task scans use status index', async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'nb-clan-sqlite-message-deletion-tasks-'));
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
    const storeModule = await uniqueImport('../server/store.js');
    const repositoryModule = await import('../server/storage/repository.js');
    const messageDeletionModule = await uniqueImport('../server/message-deletion-tasks.js');
    await storeModule.ensureStore();
    await repositoryModule.writeSqliteStorePatch({
      reason: 'message_deletion_status_scan_seed',
      upserts: {
        messageDeletionTasks: [
          {
            id: 'message_deletion_due',
            platform: 'discord',
            messageType: 'kda_query',
            applicationId: 'app_1',
            interactionToken: 'token_1',
            deleteAt: '2020-01-01T00:00:00.000Z',
            attempts: 0,
            status: 'pending',
            lastError: '',
            createdAt: '2020-01-01T00:00:00.000Z',
            updatedAt: '2020-01-01T00:00:00.000Z'
          },
          {
            id: 'message_deletion_future',
            platform: 'discord',
            messageType: 'kda_query',
            applicationId: 'app_2',
            interactionToken: 'token_2',
            deleteAt: '2999-01-01T00:00:00.000Z',
            attempts: 0,
            status: 'pending',
            lastError: '',
            createdAt: '2020-01-01T00:00:00.000Z',
            updatedAt: '2020-01-01T00:00:00.000Z'
          },
          {
            id: 'message_deletion_running',
            platform: 'discord',
            messageType: 'kda_query',
            applicationId: 'app_3',
            interactionToken: 'token_3',
            deleteAt: '2020-01-01T00:00:00.000Z',
            attempts: 1,
            status: 'running',
            lastError: '',
            createdAt: '2020-01-01T00:00:00.000Z',
            updatedAt: '2020-01-01T00:00:00.000Z'
          },
          {
            id: 'message_deletion_failed',
            platform: 'discord',
            messageType: 'kda_query',
            applicationId: 'app_4',
            interactionToken: 'token_4',
            deleteAt: '2020-01-01T00:00:00.000Z',
            attempts: 6,
            status: 'failed',
            lastError: 'HTTP 500',
            createdAt: '2020-01-01T00:00:00.000Z',
            updatedAt: '2020-01-01T00:00:00.000Z'
          }
        ]
      }
    });

    const queryCount = (status, name) => status.sqlite?.queries?.byName?.[name]?.total || 0;
    const beforeStatus = await storeModule.storeRuntimeStatus({ sqliteSummary: false });
    const beforeFullList = queryCount(beforeStatus, 'list_messageDeletionTasks');
    const beforeStatusList = queryCount(beforeStatus, 'list_messageDeletionTasks_status');
    const calls = [];
    const runtime = messageDeletionModule.createMessageDeletionTaskRuntime({
      discordApiBaseUrl: 'https://discord.test/api/v10',
      fetchImpl: async (url, options) => {
        calls.push({ url, options });
        return { ok: true, status: 204 };
      },
      sqlitePrimaryModeImpl: () => true,
      now: () => '2026-07-07T00:00:00.000Z'
    });

    try {
      const dueResult = await runtime.runDueMessageDeletionTasks();
      assert.equal(dueResult.enabled, true);
      assert.equal(dueResult.scanned, 2);
      assert.equal(dueResult.due, 1);
      assert.equal(calls.length, 1);
      const runtimeStatus = await runtime.messageDeletionTaskRuntimeStatus();
      assert.equal(runtimeStatus.enabled, true);
      assert.equal(runtimeStatus.total, 4);
      assert.equal(runtimeStatus.pending, 1);
      assert.equal(runtimeStatus.running, 1);
      assert.equal(runtimeStatus.failed, 1);
      assert.equal(runtimeStatus.counts.deleted, 1);
    } finally {
      runtime.clearScheduledMessageDeletionTasksForTests();
    }

    const afterStatus = await storeModule.storeRuntimeStatus({ sqliteSummary: false });
    assert.equal(queryCount(afterStatus, 'list_messageDeletionTasks'), beforeFullList);
    assert.equal(queryCount(afterStatus, 'list_messageDeletionTasks_status') > beforeStatusList, true);
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

test('sqlite-primary sync job create trims history inside the create patch write', async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'nb-clan-sqlite-sync-job-create-trim-'));
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
    const storeModule = await uniqueImport('../server/store.js');
    const syncJobStoreModule = await uniqueImport('../server/sync-job-store.js');
    const repositoryModule = await import('../server/storage/repository.js');
    await storeModule.ensureStore();
    const seedJobs = Array.from({ length: 100 }, (_, index) => {
      const timestamp = new Date(Date.UTC(2026, 0, 1, 0, 0, index)).toISOString();
      return {
        id: `sync_job_trim_seed_${String(index).padStart(4, '0')}`,
        type: 'kda',
        source: 'manual',
        scope: 'kda',
        status: 'completed',
        targetWipeId: 'wipe_sync_job_trim_seed',
        targetServerId: '',
        targetServerName: '',
        totalCount: 1,
        doneCount: 1,
        failedCount: 0,
        skippedCount: 0,
        percent: 100,
        etaSeconds: 0,
        startedAt: timestamp,
        finishedAt: timestamp,
        createdBy: 'user_root',
        errorSummary: '',
        details: {},
        createdAt: timestamp,
        updatedAt: timestamp
      };
    });
    await repositoryModule.writeSqliteStorePatch({
      reason: 'seed_sync_job_create_trim',
      upserts: { syncJobs: seedJobs }
    });

    const queryCount = (status, name) => status.sqlite?.queries?.byName?.[name]?.total || 0;
    const writeCount = (status, name) => status.sqlite?.writes?.byName?.[name]?.total || 0;
    const beforeStatus = await storeModule.storeRuntimeStatus();
    const beforeStat = await stat(storeModule.STORE_FILE);
    const result = await syncJobStoreModule.createSyncJobUnlessActive({
      type: 'kda',
      source: 'manual',
      scope: 'kda',
      status: 'queued',
      targetWipeId: 'wipe_sync_job_trim_new',
      totalCount: 1,
      createdBy: 'user_root'
    }, {
      type: 'kda',
      scope: 'kda',
      targetWipeId: 'wipe_sync_job_trim_new'
    });
    assert.equal(result.reused, false);
    assert.equal(result.job.status, 'queued');

    const oldVitalResult = await syncJobStoreModule.createSyncJobUnlessActive({
      type: 'kda',
      source: 'auto',
      scope: 'kda',
      status: 'queued',
      targetWipeId: 'wipe_sync_job_rollover',
      targetVitalWipeId: 'vital_old',
      targetServerId: '16',
      totalCount: 1
    }, {
      type: 'kda',
      scope: 'kda',
      targetWipeId: 'wipe_sync_job_rollover',
      targetVitalWipeId: 'vital_old',
      targetServerId: '16'
    });
    const newVitalResult = await syncJobStoreModule.createSyncJobUnlessActive({
      type: 'kda',
      source: 'auto',
      scope: 'kda',
      status: 'queued',
      targetWipeId: 'wipe_sync_job_rollover',
      targetVitalWipeId: 'vital_new',
      targetServerId: '16',
      totalCount: 1
    }, {
      type: 'kda',
      scope: 'kda',
      targetWipeId: 'wipe_sync_job_rollover',
      targetVitalWipeId: 'vital_new',
      targetServerId: '16'
    });
    assert.equal(oldVitalResult.reused, false);
    assert.equal(newVitalResult.reused, false);
    assert.notEqual(newVitalResult.job.id, oldVitalResult.job.id);

    const afterStatus = await storeModule.storeRuntimeStatus();
    const afterStat = await stat(storeModule.STORE_FILE);
    const jobs = await repositoryModule.getSqliteCollection('syncJobs', { limit: 0 });
    assert.equal(jobs.length, 100);
    assert.equal(Boolean(await repositoryModule.getSqliteRecord('syncJobs', result.job.id)), true);
    assert.equal(await repositoryModule.getSqliteRecord('syncJobs', 'sync_job_trim_seed_0000'), null);
    assert.equal(writeCount(afterStatus, 'sync_job_create'), writeCount(beforeStatus, 'sync_job_create') + 3);
    assert.equal(writeCount(afterStatus, 'sync_job_create_trim'), writeCount(beforeStatus, 'sync_job_create_trim'));
    assert.equal(afterStat.mtimeMs, beforeStat.mtimeMs);
    assert.equal(afterStatus.metrics.sqliteWrites, beforeStatus.metrics.sqliteWrites);
    assert.equal(
      afterStatus.sqlite.compatibility.syncStoreChangesToSqlite,
      beforeStatus.sqlite.compatibility.syncStoreChangesToSqlite
    );

    const beforeCreateFailureStatus = await storeModule.storeRuntimeStatus();
    const beforeCreateFailureReadStoreFull = queryCount(beforeCreateFailureStatus, 'read_store_full');
    repositoryModule.injectSqliteStorePatchFailureForTests('sync_job_create', 1);
    await assert.rejects(
      () => syncJobStoreModule.createSyncJobUnlessActive({
        type: 'kda',
        source: 'manual',
        scope: 'kda',
        status: 'queued',
        targetWipeId: 'wipe_sync_job_trim_failed',
        totalCount: 1,
        createdBy: 'user_root'
      }, {
        type: 'kda',
        scope: 'kda',
        targetWipeId: 'wipe_sync_job_trim_failed'
      }),
      (error) => {
        assert.equal(error.status, 503);
        assert.equal(error.code, 'sqlite_direct_write_unavailable');
        assert.equal(error.errorKey, 'sqlite_direct_write_unavailable');
        assert.match(error.message, /同步任务创建记录暂不可用/);
        assert.match(error.cause?.message || '', /Injected sqlite patch failure for sync_job_create/);
        return true;
      }
    );
    const failedCreateJobs = await repositoryModule.getSqliteRecordsByJsonField('syncJobs', 'targetWipeId', ['wipe_sync_job_trim_failed'], { limit: 0 });
    const afterCreateFailureStatus = await storeModule.storeRuntimeStatus();
    assert.equal(failedCreateJobs.length, 0);
    assert.equal(queryCount(afterCreateFailureStatus, 'read_store_full'), beforeCreateFailureReadStoreFull);
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

test('sqlite-primary sync job creation checks active jobs by status index', async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'nb-clan-sqlite-sync-job-create-'));
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
    const loginResponse = await httpFetch(`${baseUrl}/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'root', password: 'RootPass123!' })
    });
    assert.equal(loginResponse.status, 200);
    const cookie = loginResponse.headers.get('set-cookie')?.split(';')[0] || '';
    assert.match(cookie, /^nb_session=/);

	    const queryCount = (status, name) => status.sqlite?.queries?.byName?.[name]?.total || 0;
	    const beforeStatus = await storeModule.storeRuntimeStatus();
	    const beforeListSyncJobs = queryCount(beforeStatus, 'list_syncJobs');
	    const beforeSyncJobsByStatus = queryCount(beforeStatus, 'list_syncJobs_status');
	    const beforeSyncJobsByStatusTypeScope = queryCount(beforeStatus, 'list_syncJobs_status_type_scope');
	    const beforeGetSyncJobs = queryCount(beforeStatus, 'get_syncJobs');
		    const beforeListMembers = queryCount(beforeStatus, 'list_members');
		    const beforeListMemberProfiles = queryCount(beforeStatus, 'list_memberProfiles');
			    const beforeMembersById = queryCount(beforeStatus, 'list_members_id');
	    const beforeMemberProfilesByMemberId = queryCount(beforeStatus, 'list_memberProfiles_memberId');
	    const beforeStat = await stat(storeModule.STORE_FILE);

    const syncResponse = await httpFetch(`${baseUrl}/settings/member-profiles/sync`, {
      method: 'POST',
      headers: {
        cookie,
        'content-type': 'application/json'
      },
      body: JSON.stringify({ memberIds: ['missing_member_for_empty_sync_job'] })
    });
    assert.equal(syncResponse.status, 200);
    const syncPayload = await syncResponse.json();
    assert.equal(syncPayload.ok, true);
    assert.equal(syncPayload.job.type, 'member_profile');
    assert.equal(syncPayload.job.status, 'completed');
    assert.equal(syncPayload.job.totalCount, 0);
    assert.equal(syncPayload.queued, false);

    const afterStatus = await storeModule.storeRuntimeStatus();
    const afterStat = await stat(storeModule.STORE_FILE);
    assert.equal(queryCount(afterStatus, 'list_syncJobs'), beforeListSyncJobs);
    assert.equal(queryCount(afterStatus, 'list_syncJobs_status') > beforeSyncJobsByStatus, true);
    assert.equal(queryCount(afterStatus, 'list_syncJobs_status_type_scope') > beforeSyncJobsByStatusTypeScope, true);
    assert.equal(queryCount(afterStatus, 'get_syncJobs') > beforeGetSyncJobs, true);
    assert.equal(queryCount(afterStatus, 'list_members'), beforeListMembers);
    assert.equal(queryCount(afterStatus, 'list_memberProfiles'), beforeListMemberProfiles);
	    assert.equal(queryCount(afterStatus, 'list_members_id'), beforeMembersById + 1);
    assert.equal(queryCount(afterStatus, 'list_memberProfiles_memberId'), beforeMemberProfilesByMemberId + 1);
    assert.equal(afterStat.mtimeMs, beforeStat.mtimeMs);
    assert.equal(afterStatus.metrics.sqliteWrites, beforeStatus.metrics.sqliteWrites);

    const beforeCurrentStatus = await storeModule.storeRuntimeStatus({ sqliteSummary: false });
    const beforeCurrentListSyncJobs = queryCount(beforeCurrentStatus, 'list_syncJobs');
    const beforeCurrentSyncJobsByStatus = queryCount(beforeCurrentStatus, 'list_syncJobs_status');
    const currentResponse = await httpFetch(`${baseUrl}/sync/jobs/current`, {
      headers: { cookie }
    });
    assert.equal(currentResponse.status, 200);
    const currentPayload = await currentResponse.json();
    assert.equal(currentPayload.ok, true);
    assert.deepEqual(currentPayload.jobs, []);
    assert.equal(currentPayload.partial, false);
    assert.equal(currentPayload.readError, '');
    assert.equal(Boolean(currentPayload.updatedAt), true);
    const afterCurrentStatus = await storeModule.storeRuntimeStatus({ sqliteSummary: false });
    assert.equal(queryCount(afterCurrentStatus, 'list_syncJobs'), beforeCurrentListSyncJobs);
    assert.equal(queryCount(afterCurrentStatus, 'list_syncJobs_status') > beforeCurrentSyncJobsByStatus, true);

    const beforeCurrentPartialStatus = await storeModule.storeRuntimeStatus({ sqliteSummary: false });
    const beforeCurrentPartialReadStoreFull = queryCount(beforeCurrentPartialStatus, 'read_store_full');
    repositoryModule.injectSqliteQueryFailureForTests('list_syncJobs_status', 1);
    const currentPartialResponse = await httpFetch(`${baseUrl}/sync/jobs/current`, {
      headers: { cookie }
    });
    assert.equal(currentPartialResponse.status, 200);
    const currentPartialPayload = await currentPartialResponse.json();
    assert.equal(currentPartialPayload.ok, true);
    assert.deepEqual(currentPartialPayload.jobs, []);
    assert.equal(currentPartialPayload.partial, true);
    assert.match(currentPartialPayload.readError, /Injected sqlite query failure for list_syncJobs_status/);
    assert.equal(Boolean(currentPartialPayload.updatedAt), true);
    const afterCurrentPartialStatus = await storeModule.storeRuntimeStatus({ sqliteSummary: false });
    assert.equal(queryCount(afterCurrentPartialStatus, 'read_store_full'), beforeCurrentPartialReadStoreFull);

    const beforeRecentStatus = await storeModule.storeRuntimeStatus({ sqliteSummary: false });
    const beforeRecentListSyncJobs = queryCount(beforeRecentStatus, 'list_syncJobs');
    const beforeRecentSyncJobsByStatus = queryCount(beforeRecentStatus, 'list_syncJobs_status');
    const beforeRecentScalarSyncState = queryCount(beforeRecentStatus, 'scalar_syncState');
    const recentResponse = await httpFetch(`${baseUrl}/sync/jobs/recent?limit=3`, {
      headers: { cookie }
    });
    assert.equal(recentResponse.status, 200);
    const recentPayload = await recentResponse.json();
    assert.equal(recentPayload.ok, true);
    assert.deepEqual(recentPayload.current, []);
    assert.deepEqual(recentPayload.recent, []);
    const afterRecentStatus = await storeModule.storeRuntimeStatus({ sqliteSummary: false });
    assert.equal(queryCount(afterRecentStatus, 'list_syncJobs'), beforeRecentListSyncJobs);
    assert.equal(queryCount(afterRecentStatus, 'list_syncJobs_status') > beforeRecentSyncJobsByStatus, true);
    assert.equal(queryCount(afterRecentStatus, 'scalar_syncState'), beforeRecentScalarSyncState);

    const beforeRecentPartialStatus = await storeModule.storeRuntimeStatus({ sqliteSummary: false });
    const beforeRecentPartialReadStoreFull = queryCount(beforeRecentPartialStatus, 'read_store_full');
    repositoryModule.injectSqliteQueryFailureForTests('list_syncJobs_status', 1);
    const recentPartialResponse = await httpFetch(`${baseUrl}/sync/jobs/recent?limit=3`, {
      headers: { cookie }
    });
    assert.equal(recentPartialResponse.status, 200);
    const recentPartialPayload = await recentPartialResponse.json();
    assert.equal(recentPartialPayload.ok, true);
    assert.deepEqual(recentPartialPayload.current, []);
    assert.deepEqual(recentPartialPayload.recent, []);
    assert.equal(recentPartialPayload.partial, true);
    assert.match(recentPartialPayload.readError, /Injected sqlite query failure for list_syncJobs_status/);
    assert.equal(Boolean(recentPartialPayload.updatedAt), true);
    const afterRecentPartialStatus = await storeModule.storeRuntimeStatus({ sqliteSummary: false });
    assert.equal(queryCount(afterRecentPartialStatus, 'read_store_full'), beforeRecentPartialReadStoreFull);

    const beforeReadyzStatus = await storeModule.storeRuntimeStatus({ sqliteSummary: false });
    const beforeReadyzListSyncJobs = queryCount(beforeReadyzStatus, 'list_syncJobs');
    const beforeReadyzSyncJobsByStatus = queryCount(beforeReadyzStatus, 'list_syncJobs_status');
    const beforeReadyzScalarSyncState = queryCount(beforeReadyzStatus, 'scalar_syncState');
    const readyzResponse = await httpFetch(`${baseUrl}/readyz?detail=full`);
    assert.equal(readyzResponse.status, 200);
    const readyzPayload = await readyzResponse.json();
    assert.equal(readyzPayload.ok, true);
    assert.equal(Array.isArray(readyzPayload.operations.syncJobs.current), true);
    assert.equal(Array.isArray(readyzPayload.operations.syncJobs.recent), true);
    assert.equal(typeof readyzPayload.operations.syncJobs.queueDepth.current, 'number');
    const afterReadyzStatus = await storeModule.storeRuntimeStatus({ sqliteSummary: false });
    assert.equal(queryCount(afterReadyzStatus, 'list_syncJobs'), beforeReadyzListSyncJobs);
    assert.equal(queryCount(afterReadyzStatus, 'list_syncJobs_status') > beforeReadyzSyncJobsByStatus, true);
    assert.equal(queryCount(afterReadyzStatus, 'scalar_syncState'), beforeReadyzScalarSyncState);
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

test('sqlite-primary member profile sync refreshes stale Steam nickname from Steam profile', async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'nb-clan-sqlite-member-profile-steam-name-sync-'));
  const previousEnv = {
    NB_DATA_DIR: process.env.NB_DATA_DIR,
    NB_ROOT_PASSWORD: process.env.NB_ROOT_PASSWORD,
    NB_STORAGE_MODE: process.env.NB_STORAGE_MODE,
    NB_SQLITE_FILE: process.env.NB_SQLITE_FILE,
    NB_DISABLE_BACKGROUND_JOBS: process.env.NB_DISABLE_BACKGROUND_JOBS,
    NB_DISABLE_EXTERNAL_VITAL: process.env.NB_DISABLE_EXTERNAL_VITAL,
    NB_RUST_KDA_PROVIDER: process.env.NB_RUST_KDA_PROVIDER,
    NB_RUST_KDA_BASE_URL: process.env.NB_RUST_KDA_BASE_URL,
    NB_RUSTPLUS_RELAY_CHAT_FLUSH_INTERVAL_MS: process.env.NB_RUSTPLUS_RELAY_CHAT_FLUSH_INTERVAL_MS,
    NB_STEAM_BROADCAST_REQUEST_INTERVAL_MS: process.env.NB_STEAM_BROADCAST_REQUEST_INTERVAL_MS,
    NB_STEAM_WEB_API_KEY: process.env.NB_STEAM_WEB_API_KEY,
    STEAM_WEB_API_KEY: process.env.STEAM_WEB_API_KEY,
    STEAM_API_KEY: process.env.STEAM_API_KEY
  };
  const originalFetch = globalThis.fetch;
  const httpFetch = originalFetch.bind(globalThis);
  let server = null;
  let rustKdaServer = null;
  try {
    const steamId = '76561198000002009';
    const rustKdaRequests = [];
    let rustKdaAvailable = true;
    let steamProfileAvailable = true;
    const rustKdaApp = express();
    rustKdaApp.get('/api/player/:steamId', (req, res) => {
      rustKdaRequests.push(`player:${req.params.steamId}`);
      if (!rustKdaAvailable) {
        res.status(503).json({ error: 'rust kda unavailable' });
        return;
      }
      res.json({
        steamId: req.params.steamId,
        name: 'RustKDA Cached Alias',
        avatarMedium: 'https://example.com/rustkda-cached-alias.jpg',
        profileUrl: `https://steamcommunity.com/profiles/${req.params.steamId}`,
        playTimeMinutes: 360
      });
    });
    rustKdaApp.get('/api/inventory/:steamId', (req, res) => {
      rustKdaRequests.push(`inventory:${req.params.steamId}`);
      if (!rustKdaAvailable) {
        res.status(503).json({ error: 'rust kda unavailable' });
        return;
      }
      res.json({});
    });
    rustKdaApp.get('/api/kda/:steamId', (req, res) => {
      rustKdaRequests.push(`kda:${req.params.steamId}`);
      if (!rustKdaAvailable) {
        res.status(503).json({ error: 'rust kda unavailable' });
        return;
      }
      res.json({});
    });
    rustKdaServer = createServer(rustKdaApp);
    await new Promise((resolve) => rustKdaServer.listen(0, '127.0.0.1', resolve));

    process.env.NB_DATA_DIR = dataDir;
    process.env.NB_ROOT_PASSWORD = 'RootPass123!';
    process.env.NB_STORAGE_MODE = 'sqlite-primary';
    process.env.NB_SQLITE_FILE = path.join(dataDir, 'nb-clan.sqlite');
    process.env.NB_DISABLE_BACKGROUND_JOBS = '1';
    process.env.NB_DISABLE_EXTERNAL_VITAL = '0';
    process.env.NB_RUST_KDA_PROVIDER = 'http';
    process.env.NB_RUST_KDA_BASE_URL = `http://127.0.0.1:${rustKdaServer.address().port}`;
    process.env.NB_RUSTPLUS_RELAY_CHAT_FLUSH_INTERVAL_MS = '0';
    process.env.NB_STEAM_BROADCAST_REQUEST_INTERVAL_MS = '0';
    process.env.NB_STEAM_WEB_API_KEY = '';
    process.env.STEAM_WEB_API_KEY = '';
    process.env.STEAM_API_KEY = '';

    const steamProfileFetches = [];
    globalThis.fetch = async (url, options = {}) => {
      const href = String(url);
      if (href === `https://steamcommunity.com/profiles/${steamId}?xml=1`) {
        steamProfileFetches.push(href);
        if (!steamProfileAvailable) {
          return new Response('Steam profile unavailable', { status: 503, headers: { 'content-type': 'text/plain' } });
        }
        return new Response([
          '<profile>',
          `<steamID64>${steamId}</steamID64>`,
          '<steamID>Steam Sync Current Name</steamID>',
          '<privacyState>public</privacyState>',
          '<visibilityState>3</visibilityState>',
          '<avatarFull>https://example.com/steam-sync-current-name.jpg</avatarFull>',
          '</profile>'
        ].join(''), { status: 200, headers: { 'content-type': 'text/xml' } });
      }
      if (href === `https://steamcommunity.com/broadcast/getbroadcastmpd/?steamid=${steamId}`) {
        return new Response(JSON.stringify({ success: 0 }), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      return originalFetch(url, options);
    };

    const storeModule = await uniqueImport('../server/store.js');
    const apiModule = await uniqueImport('../server/api.js');
    const repositoryModule = await import('../server/storage/repository.js');
    const rateLimitModule = await import('../server/rate-limit.js');
    await storeModule.ensureStore();
    const createdAt = '2026-07-03T00:00:00.000Z';
    const memberId = 'member_sqlite_member_profile_steam_name_sync';
    await storeModule.updateStore((store) => {
      store.members.unshift({
        id: memberId,
        steamId,
        rawInput: steamId,
        customName: '',
        steamNickname: 'Stale Steam Name',
        avatar: '',
        discordId: '',
        wechatId: '',
        wechatUserId: '',
        notes: '',
        specialty: [],
        memberStatus: 'active',
        battlemetricsId: '',
        invitedByUserId: 'user_root',
        createdAt,
        updatedAt: createdAt
      });
    });

    const app = express();
    app.use('/api', apiModule.createApiRouter());
    server = createServer(app);
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const baseUrl = `http://127.0.0.1:${server.address().port}/api`;
    const loginResponse = await httpFetch(`${baseUrl}/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'root', password: 'RootPass123!' })
    });
    assert.equal(loginResponse.status, 200);
    const cookie = loginResponse.headers.get('set-cookie')?.split(';')[0] || '';
    assert.match(cookie, /^nb_session=/);

    rateLimitModule.__rateLimitForTests.reset();
    const syncResponse = await httpFetch(`${baseUrl}/settings/member-profiles/sync`, {
      method: 'POST',
      headers: {
        cookie,
        'content-type': 'application/json'
      },
      body: JSON.stringify({ memberIds: [memberId] })
    });
    const syncPayload = await syncResponse.json();
    assert.equal(syncResponse.status, 200, JSON.stringify(syncPayload));
    assert.equal(syncPayload.ok, true);
    assert.equal(syncPayload.queued, false);
    assert.equal(syncPayload.job.type, 'member_profile');
    const syncJob = await waitForSqliteRecord(
      repositoryModule,
      'syncJobs',
      syncPayload.job.id,
      (record) => record.status === 'completed',
      'member profile Steam nickname sync job completion'
    );
    assert.equal(syncJob.doneCount, 1);
    assert.equal(syncJob.failedCount, 0);

    const refreshedMember = await repositoryModule.getSqliteRecord('members', memberId);
    assert.equal(refreshedMember.steamNickname, 'Steam Sync Current Name');
    const profiles = await repositoryModule.getSqliteRecordsByJsonField('memberProfiles', 'memberId', [memberId], { limit: 0 });
    assert.equal(profiles.length, 1);
    assert.equal(profiles[0].displayName, 'Steam Sync Current Name');
    assert.equal(profiles[0].avatar, 'https://example.com/rustkda-cached-alias.jpg');
    assert.deepEqual(steamProfileFetches, [`https://steamcommunity.com/profiles/${steamId}?xml=1`]);
    assert.deepEqual(rustKdaRequests.sort(), [
      `inventory:${steamId}`,
      `kda:${steamId}`,
      `player:${steamId}`
    ]);

    rustKdaAvailable = false;
    steamProfileAvailable = false;
    const failedExternalRefreshResponse = await httpFetch(`${baseUrl}/members/${memberId}/steam-profile/refresh`, {
      method: 'POST',
      headers: { cookie }
    });
    const failedExternalRefreshPayload = await failedExternalRefreshResponse.json();
    assert.equal(failedExternalRefreshResponse.status, 200, JSON.stringify(failedExternalRefreshPayload));
    const preservedMember = await repositoryModule.getSqliteRecord('members', memberId);
    assert.equal(preservedMember.steamNickname, 'Steam Sync Current Name');
    const preservedProfiles = await repositoryModule.getSqliteRecordsByJsonField('memberProfiles', 'memberId', [memberId], { limit: 0 });
    assert.equal(preservedProfiles.length, 1);
    assert.equal(preservedProfiles[0].displayName, 'Steam Sync Current Name');
    assert.equal(preservedProfiles[0].avatar, 'https://example.com/rustkda-cached-alias.jpg');
    assert.deepEqual(steamProfileFetches, [
      `https://steamcommunity.com/profiles/${steamId}?xml=1`,
      `https://steamcommunity.com/profiles/${steamId}?xml=1`
    ]);
  } finally {
    globalThis.fetch = originalFetch;
    if (server) await new Promise((resolve) => server.close(resolve));
    if (rustKdaServer) await new Promise((resolve) => rustKdaServer.close(resolve));
    const sqliteModule = await import('../server/storage/sqlite.js');
    await sqliteModule.closeSqliteDatabasesForTests();
    Object.assign(process.env, previousEnv);
    for (const [key, value] of Object.entries(previousEnv)) {
      if (value === undefined) delete process.env[key];
    }
    await rm(dataDir, { recursive: true, force: true });
  }
});

test('sqlite-primary sync job delete uses direct SQLite patch writes', async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'nb-clan-sqlite-sync-job-delete-'));
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
    const syncJobStoreModule = await uniqueImport('../server/sync-job-store.js');
    await storeModule.ensureStore();
    const repositoryModule = await import('../server/storage/repository.js');
    await repositoryModule.writeSqliteStorePatch({
      reason: 'sqlite_test_sync_job_delete_seed',
      upserts: {
        syncJobs: [
          {
            id: 'sync_job_sqlite_cancel_test',
            type: 'kda',
            source: 'manual',
            scope: 'kda',
            status: 'running',
            targetWipeId: 'wipe_sqlite_cancel_test',
            targetServerId: '',
            targetServerName: '',
            totalCount: 4,
            doneCount: 1,
            failedCount: 0,
            skippedCount: 0,
            percent: 25,
            etaSeconds: 90,
            startedAt: '2026-07-02T00:00:00.000Z',
            finishedAt: '',
            createdBy: 'user_root',
            errorSummary: '',
            details: {},
            createdAt: '2026-07-02T00:00:00.000Z',
            updatedAt: '2026-07-02T00:00:30.000Z'
          },
          {
            id: 'sync_job_sqlite_delete_test',
            type: 'kda',
            source: 'manual',
            scope: 'kda',
            status: 'completed',
            targetWipeId: 'wipe_sqlite_delete_test',
            targetServerId: '',
            targetServerName: '',
            totalCount: 2,
            doneCount: 2,
            failedCount: 0,
            skippedCount: 0,
            percent: 100,
            etaSeconds: 0,
            startedAt: '2026-07-02T00:00:00.000Z',
            finishedAt: '2026-07-02T00:01:00.000Z',
            createdBy: 'user_root',
            errorSummary: '',
            details: {},
            createdAt: '2026-07-02T00:00:00.000Z',
            updatedAt: '2026-07-02T00:01:00.000Z'
          },
          {
            id: 'sync_job_sqlite_update_test',
            type: 'kda',
            source: 'manual',
            scope: 'kda',
            status: 'running',
            targetWipeId: 'wipe_sqlite_update_test',
            targetServerId: '',
            targetServerName: '',
            totalCount: 2,
            doneCount: 0,
            failedCount: 0,
            skippedCount: 0,
            percent: 0,
            etaSeconds: 120,
            startedAt: '2026-07-02T00:00:00.000Z',
            finishedAt: '',
            createdBy: 'user_root',
            errorSummary: '',
            details: {},
            createdAt: '2026-07-02T00:00:00.000Z',
            updatedAt: '2026-07-02T00:00:00.000Z'
          }
        ]
      }
    });

    const app = express();
    app.use('/api', apiModule.createApiRouter());
    server = createServer(app);
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const baseUrl = `http://127.0.0.1:${server.address().port}/api`;
    const sessionId = await authModule.createSession('user_root');
    const cookie = `nb_session=${encodeURIComponent(sessionId)}`;
    const queryCount = (status, name) => status.sqlite?.queries?.byName?.[name]?.total || 0;
    const writeCount = (status, name) => status.sqlite?.writes?.byName?.[name]?.total || 0;
    const assertSyncJobWriteUnavailable = async (action, reason, messagePattern) => {
      await assert.rejects(
        action,
        (error) => {
          assert.equal(error.status, 503);
          assert.equal(error.code, 'sqlite_direct_write_unavailable');
          assert.equal(error.errorKey, 'sqlite_direct_write_unavailable');
          assert.match(error.message, messagePattern);
          assert.match(error.cause?.message || '', new RegExp(`Injected sqlite patch failure for ${reason}`));
          return true;
        }
      );
    };

    const beforeUnavailableStatus = await storeModule.storeRuntimeStatus();
    const beforeUnavailableListSyncJobs = queryCount(beforeUnavailableStatus, 'list_syncJobs');
    const beforeUnavailableReadStoreFull = queryCount(beforeUnavailableStatus, 'read_store_full');
    repositoryModule.injectSqliteQueryFailureForTests('get_syncJobs', 2);
    repositoryModule.injectSqliteQueryFailureForTests('list_syncJobs_id', 1);
    repositoryModule.injectSqliteQueryFailureForTests('list_syncJobs', 1);
    await assert.rejects(
      () => syncJobStoreModule.readSyncJobById('sync_job_sqlite_update_test'),
      (error) => {
        assert.equal(error.status, 503);
        assert.equal(error.code, 'sqlite_scoped_read_unavailable');
        assert.match(error.message, /sync job scoped read unavailable/);
        return true;
      }
    );
	    const afterUnavailableStatus = await storeModule.storeRuntimeStatus();
	    assert.equal(queryCount(afterUnavailableStatus, 'list_syncJobs'), beforeUnavailableListSyncJobs);
	    assert.equal(queryCount(afterUnavailableStatus, 'read_store_full'), beforeUnavailableReadStoreFull);

	    const beforeListPartialStatus = await storeModule.storeRuntimeStatus();
	    const beforeListPartialReadStoreFull = queryCount(beforeListPartialStatus, 'read_store_full');
	    repositoryModule.injectSqliteQueryFailureForTests('list_syncJobs', 1);
	    const partialSyncJobsStore = await syncJobStoreModule.readSyncJobsListStore();
	    const afterListPartialStatus = await storeModule.storeRuntimeStatus();
	    assert.equal(partialSyncJobsStore.syncJobsPartial, true);
	    assert.equal(partialSyncJobsStore.syncJobsReadSource, 'list');
	    assert.equal(partialSyncJobsStore.syncJobs.length, 0);
	    assert.equal(queryCount(afterListPartialStatus, 'read_store_full'), beforeListPartialReadStoreFull);

	    const beforeUpdateStatus = await storeModule.storeRuntimeStatus();
    const beforeUpdateSyncJobsById = queryCount(beforeUpdateStatus, 'list_syncJobs_id');
    const beforeUpdateReadStoreFull = queryCount(beforeUpdateStatus, 'read_store_full');
    repositoryModule.injectSqliteQueryFailureForTests('get_syncJobs', 1);
    const updatedSyncJob = await syncJobStoreModule.updateSyncJob('sync_job_sqlite_update_test', {
      doneCount: 1,
      percent: 50,
      etaSeconds: 60
    });
    const afterUpdateStatus = await storeModule.storeRuntimeStatus();
    assert.equal(updatedSyncJob.id, 'sync_job_sqlite_update_test');
    assert.equal(updatedSyncJob.doneCount, 1);
    assert.equal(queryCount(afterUpdateStatus, 'list_syncJobs_id') > beforeUpdateSyncJobsById, true);
    assert.equal(queryCount(afterUpdateStatus, 'read_store_full'), beforeUpdateReadStoreFull);

    const beforeUpdatePatchFailureStatus = await storeModule.storeRuntimeStatus();
    const beforeUpdatePatchFailureReadStoreFull = queryCount(beforeUpdatePatchFailureStatus, 'read_store_full');
    const beforeUpdatePatchFailureWrite = writeCount(beforeUpdatePatchFailureStatus, 'sync_job_update');
    repositoryModule.injectSqliteStorePatchFailureForTests('sync_job_update', 1);
    await assertSyncJobWriteUnavailable(
      () => syncJobStoreModule.updateSyncJob('sync_job_sqlite_update_test', {
        failedCount: 1,
        percent: 75
      }),
      'sync_job_update',
      /同步任务状态记录暂不可用/
    );
    const afterUpdatePatchFailureStatus = await storeModule.storeRuntimeStatus();
    const failedUpdateJob = await repositoryModule.getSqliteRecord('syncJobs', 'sync_job_sqlite_update_test');
    assert.equal(failedUpdateJob.doneCount, 1);
    assert.equal(failedUpdateJob.failedCount, 0);
    assert.equal(failedUpdateJob.percent, 50);
    assert.equal(queryCount(afterUpdatePatchFailureStatus, 'read_store_full'), beforeUpdatePatchFailureReadStoreFull);
    assert.equal(writeCount(afterUpdatePatchFailureStatus, 'sync_job_update'), beforeUpdatePatchFailureWrite);

    repositoryModule.injectSqliteStorePatchFailureForTests('sync_job_fail', 1);
    await assertSyncJobWriteUnavailable(
      () => syncJobStoreModule.failSyncJob('sync_job_sqlite_update_test', new Error('sync job fail injection')),
      'sync_job_fail',
      /同步任务失败记录暂不可用/
    );
    const failedFailJob = await repositoryModule.getSqliteRecord('syncJobs', 'sync_job_sqlite_update_test');
    assert.equal(failedFailJob.status, 'running');
    assert.equal(failedFailJob.errorSummary, '');

    const beforeStateWriteStatus = await storeModule.storeRuntimeStatus();
    const beforeStateWriteSyncJobsById = queryCount(beforeStateWriteStatus, 'list_syncJobs_id');
    const beforeStateWriteReadStoreFull = queryCount(beforeStateWriteStatus, 'read_store_full');
    repositoryModule.injectSqliteQueryFailureForTests('get_syncJobs', 1);
    await syncJobStoreModule.writeSyncState('kda', {
      status: 'running',
      source: 'manual',
      requested: 2,
      completed: 1,
      failed: 0,
      skipped: 0,
      percent: 50,
      etaSeconds: 60,
      syncJobId: 'sync_job_sqlite_update_test',
      syncJobType: 'kda',
      syncJobSource: 'manual',
      syncJobScope: 'kda'
    });
    const afterStateWriteStatus = await storeModule.storeRuntimeStatus();
    const stateWriteJob = await repositoryModule.getSqliteRecord('syncJobs', 'sync_job_sqlite_update_test');
    const stateWriteSyncState = await repositoryModule.getSqliteScalar('syncState');
    assert.equal(stateWriteJob.doneCount, 1);
    assert.equal(stateWriteSyncState.kda.status, 'running');
    assert.equal(queryCount(afterStateWriteStatus, 'list_syncJobs_id') > beforeStateWriteSyncJobsById, true);
    assert.equal(queryCount(afterStateWriteStatus, 'read_store_full'), beforeStateWriteReadStoreFull);

    const beforeStatePatchFailureStatus = await storeModule.storeRuntimeStatus();
    const beforeStatePatchFailureReadStoreFull = queryCount(beforeStatePatchFailureStatus, 'read_store_full');
    const beforeStatePatchFailureWrite = writeCount(beforeStatePatchFailureStatus, 'sync_state_write');
    repositoryModule.injectSqliteStorePatchFailureForTests('sync_state_write', 1);
    await assertSyncJobWriteUnavailable(
      () => syncJobStoreModule.writeSyncState('kda', {
        status: 'failed',
        source: 'manual',
        requested: 2,
        completed: 2,
        failed: 1,
        skipped: 0,
        percent: 100,
        etaSeconds: 0,
        syncJobId: 'sync_job_sqlite_update_test',
        syncJobType: 'kda',
        syncJobSource: 'manual',
        syncJobScope: 'kda'
      }),
      'sync_state_write',
      /同步状态记录暂不可用/
    );
    const afterStatePatchFailureStatus = await storeModule.storeRuntimeStatus();
    const failedStateWriteJob = await repositoryModule.getSqliteRecord('syncJobs', 'sync_job_sqlite_update_test');
    const failedStateWriteSyncState = await repositoryModule.getSqliteScalar('syncState');
    assert.equal(failedStateWriteJob.doneCount, 1);
    assert.equal(failedStateWriteSyncState.kda.status, 'running');
    assert.equal(queryCount(afterStatePatchFailureStatus, 'read_store_full'), beforeStatePatchFailureReadStoreFull);
    assert.equal(writeCount(afterStatePatchFailureStatus, 'sync_state_write'), beforeStatePatchFailureWrite);

    const beforeCancelStatus = await storeModule.storeRuntimeStatus();
    const beforeCancelStat = await stat(storeModule.STORE_FILE);
    const beforeCancelListSyncJobs = queryCount(beforeCancelStatus, 'list_syncJobs');
    const beforeCancelSyncJobsById = queryCount(beforeCancelStatus, 'list_syncJobs_id');
    const beforeCancelSyncJobsByStatus = queryCount(beforeCancelStatus, 'list_syncJobs_status');
    const beforeCancelScalarSyncState = queryCount(beforeCancelStatus, 'scalar_syncState');
    const beforeCancelReadStoreFull = queryCount(beforeCancelStatus, 'read_store_full');
    repositoryModule.injectSqliteQueryFailureForTests('get_syncJobs', 1);

    const cancelResponse = await httpFetch(`${baseUrl}/sync/jobs/sync_job_sqlite_cancel_test/cancel`, {
      method: 'POST',
      headers: { cookie }
    });
    assert.equal(cancelResponse.status, 200);
    const cancelPayload = await cancelResponse.json();
    assert.equal(cancelPayload.ok, true);
    assert.equal(cancelPayload.job.status, 'cancelled');

    const afterCancelStatus = await storeModule.storeRuntimeStatus();
    const afterCancelStat = await stat(storeModule.STORE_FILE);
    const cancelledJob = await repositoryModule.getSqliteRecord('syncJobs', 'sync_job_sqlite_cancel_test');
    const cancelSyncState = await repositoryModule.getSqliteScalar('syncState');
    assert.equal(cancelledJob.status, 'cancelled');
    assert.equal(cancelledJob.skippedCount, 3);
    assert.equal(cancelSyncState.kda.status, 'cancelled');
    assert.equal(afterCancelStat.mtimeMs, beforeCancelStat.mtimeMs);
    assert.equal(afterCancelStatus.metrics.writes.total, beforeCancelStatus.metrics.writes.total);
    assert.equal(afterCancelStatus.metrics.sqliteWrites, beforeCancelStatus.metrics.sqliteWrites);
    assert.equal(queryCount(afterCancelStatus, 'list_syncJobs'), beforeCancelListSyncJobs);
    assert.equal(queryCount(afterCancelStatus, 'list_syncJobs_id') > beforeCancelSyncJobsById, true);
    assert.equal(queryCount(afterCancelStatus, 'list_syncJobs_status') > beforeCancelSyncJobsByStatus, true);
    assert.equal(queryCount(afterCancelStatus, 'scalar_syncState'), beforeCancelScalarSyncState + 1);
    assert.equal(queryCount(afterCancelStatus, 'read_store_full'), beforeCancelReadStoreFull);

    const beforeDeleteFailureStatus = await storeModule.storeRuntimeStatus();
    const beforeDeleteFailureReadStoreFull = queryCount(beforeDeleteFailureStatus, 'read_store_full');
    const beforeDeleteFailureWrite = writeCount(beforeDeleteFailureStatus, 'sync_job_delete');
    repositoryModule.injectSqliteStorePatchFailureForTests('sync_job_delete', 1);
    const deleteFailureResponse = await httpFetch(`${baseUrl}/sync/jobs/sync_job_sqlite_delete_test`, {
      method: 'DELETE',
      headers: { cookie }
    });
    assert.equal(deleteFailureResponse.status, 503);
    const deleteFailurePayload = await deleteFailureResponse.json();
    assert.equal(deleteFailurePayload.ok, false);
    assert.match(deleteFailurePayload.error, /同步任务删除记录暂不可用/);
    const stillExistingDeletedJob = await repositoryModule.getSqliteRecord('syncJobs', 'sync_job_sqlite_delete_test');
    const deleteFailureLogs = await repositoryModule.getSqliteCollection('logs', { limit: 0 });
    const afterDeleteFailureStatus = await storeModule.storeRuntimeStatus();
    assert.equal(Boolean(stillExistingDeletedJob), true);
    assert.equal(deleteFailureLogs.some((log) => log.type === 'sync_job_delete' && log.metadata?.syncJobId === 'sync_job_sqlite_delete_test'), false);
    assert.equal(queryCount(afterDeleteFailureStatus, 'read_store_full'), beforeDeleteFailureReadStoreFull);
    assert.equal(writeCount(afterDeleteFailureStatus, 'sync_job_delete'), beforeDeleteFailureWrite);

    const beforeStatus = await storeModule.storeRuntimeStatus();
    const beforeStat = await stat(storeModule.STORE_FILE);
    const beforeListSyncJobs = queryCount(beforeStatus, 'list_syncJobs');
    const beforeSyncJobsByStatus = queryCount(beforeStatus, 'list_syncJobs_status');
    const beforeScalarSyncState = queryCount(beforeStatus, 'scalar_syncState');
    const beforeSyncJobDeleteWrite = writeCount(beforeStatus, 'sync_job_delete');
    const beforeSyncJobDeleteLogTrimWrite = writeCount(beforeStatus, 'sync_job_delete_log_trim');

    const deleteResponse = await httpFetch(`${baseUrl}/sync/jobs/sync_job_sqlite_delete_test`, {
      method: 'DELETE',
      headers: { cookie }
    });
    assert.equal(deleteResponse.status, 200);
    const deletePayload = await deleteResponse.json();
    assert.equal(deletePayload.ok, true);
    assert.equal(deletePayload.deleted, 1);
    assert.equal(deletePayload.recent.some((job) => job.id === 'sync_job_sqlite_delete_test'), false);

    const deletedJob = await repositoryModule.getSqliteRecord('syncJobs', 'sync_job_sqlite_delete_test');
    const logs = await repositoryModule.getSqliteCollection('logs', { limit: 0 });
    const afterStatus = await storeModule.storeRuntimeStatus();
    const afterStat = await stat(storeModule.STORE_FILE);
    assert.equal(deletedJob, null);
    assert.equal(logs.some((log) => log.type === 'sync_job_delete' && log.metadata?.syncJobId === 'sync_job_sqlite_delete_test'), true);
    assert.equal(afterStat.mtimeMs, beforeStat.mtimeMs);
    assert.equal(afterStatus.metrics.writes.total, beforeStatus.metrics.writes.total);
    assert.equal(afterStatus.metrics.sqliteWrites, beforeStatus.metrics.sqliteWrites);
    assert.equal(queryCount(afterStatus, 'list_syncJobs'), beforeListSyncJobs);
    assert.equal(queryCount(afterStatus, 'list_syncJobs_status') > beforeSyncJobsByStatus, true);
    assert.equal(queryCount(afterStatus, 'scalar_syncState'), beforeScalarSyncState);
    assert.equal(writeCount(afterStatus, 'sync_job_delete'), beforeSyncJobDeleteWrite + 1);
    assert.equal(writeCount(afterStatus, 'sync_job_delete_log_trim'), beforeSyncJobDeleteLogTrimWrite);
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

test('sqlite-primary sync stale reconcile uses active status reads', async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'nb-clan-sqlite-sync-stale-reconcile-'));
  const previousEnv = {
    NB_DATA_DIR: process.env.NB_DATA_DIR,
    NB_ROOT_PASSWORD: process.env.NB_ROOT_PASSWORD,
    NB_STORAGE_MODE: process.env.NB_STORAGE_MODE,
    NB_SQLITE_FILE: process.env.NB_SQLITE_FILE,
    NB_DISABLE_BACKGROUND_JOBS: process.env.NB_DISABLE_BACKGROUND_JOBS,
    NB_DISABLE_EXTERNAL_VITAL: process.env.NB_DISABLE_EXTERNAL_VITAL
  };
  process.env.NB_DATA_DIR = dataDir;
  process.env.NB_ROOT_PASSWORD = 'RootPass123!';
  process.env.NB_STORAGE_MODE = 'sqlite-primary';
  process.env.NB_SQLITE_FILE = path.join(dataDir, 'nb-clan.sqlite');
  process.env.NB_DISABLE_BACKGROUND_JOBS = '1';
  process.env.NB_DISABLE_EXTERNAL_VITAL = '1';

  try {
    const storeModule = await uniqueImport('../server/store.js');
    const syncJobStoreModule = await uniqueImport('../server/sync-job-store.js');
    const repositoryModule = await import('../server/storage/repository.js');
    await storeModule.ensureStore();
    const createdAt = '2026-07-08T00:00:00.000Z';
    const nowMs = Date.parse('2026-07-08T01:00:00.000Z');
    await repositoryModule.writeSqliteStorePatch({
      reason: 'sqlite_test_sync_stale_reconcile_seed',
      upserts: {
        syncJobs: [
          {
            id: 'sync_job_sqlite_stale_reconcile',
            type: 'kda',
            source: 'auto',
            scope: 'kda',
            status: 'running',
            targetWipeId: 'wipe_sqlite_stale_reconcile',
            targetServerId: '',
            targetServerName: '',
            totalCount: 5,
            doneCount: 2,
            failedCount: 0,
            skippedCount: 0,
            percent: 40,
            etaSeconds: 120,
            startedAt: createdAt,
            finishedAt: '',
            createdBy: 'system',
            errorSummary: '',
            details: {},
            createdAt,
            updatedAt: createdAt
          },
          {
            id: 'sync_job_sqlite_stale_reconcile_history',
            type: 'kda',
            source: 'manual',
            scope: 'kda',
            status: 'completed',
            targetWipeId: 'wipe_sqlite_stale_reconcile',
            targetServerId: '',
            targetServerName: '',
            totalCount: 1,
            doneCount: 1,
            failedCount: 0,
            skippedCount: 0,
            percent: 100,
            etaSeconds: 0,
            startedAt: createdAt,
            finishedAt: createdAt,
            createdBy: 'user_root',
            errorSummary: '',
            details: {},
            createdAt,
            updatedAt: createdAt
          }
        ]
      },
      scalars: {
        syncState: {
          kda: {
            status: 'running',
            source: 'auto',
            requested: 5,
            completed: 2,
            failed: 0,
            skipped: 0,
            percent: 40,
            etaSeconds: 120,
            startedAt: createdAt,
            syncedAt: '',
            updatedAt: createdAt,
            syncJobId: 'sync_job_sqlite_stale_reconcile',
            syncJobType: 'kda',
            syncJobSource: 'auto',
            syncJobScope: 'kda'
          }
        }
      }
    });

    const beforeStatus = await storeModule.storeRuntimeStatus();
    const beforeStat = await stat(storeModule.STORE_FILE);
    const queryCount = (status, name) => status.sqlite?.queries?.byName?.[name]?.total || 0;
    const writeCount = (status, name) => status.sqlite?.writes?.byName?.[name]?.total || 0;
    const beforeListSyncJobs = queryCount(beforeStatus, 'list_syncJobs');
    const beforeSyncJobsByStatus = queryCount(beforeStatus, 'list_syncJobs_status');
    const beforeStaleReconcileWrite = writeCount(beforeStatus, 'sync_job_stale_reconcile');

    const changed = await syncJobStoreModule.reconcileStaleSyncWork({ nowMs });
    assert.equal(changed, 2);

    const job = await repositoryModule.getSqliteRecord('syncJobs', 'sync_job_sqlite_stale_reconcile');
    const historyJob = await repositoryModule.getSqliteRecord('syncJobs', 'sync_job_sqlite_stale_reconcile_history');
    const syncState = await repositoryModule.getSqliteScalar('syncState');
    const afterStatus = await storeModule.storeRuntimeStatus();
    const afterStat = await stat(storeModule.STORE_FILE);
    assert.equal(job.status, 'failed');
    assert.equal(job.failedCount, 3);
    assert.equal(job.percent, 100);
    assert.equal(historyJob.status, 'completed');
    assert.equal(syncState.kda.status, 'failed');
    assert.equal(syncState.kda.failed, 3);
    assert.equal(afterStat.mtimeMs, beforeStat.mtimeMs);
    assert.equal(afterStatus.metrics.writes.total, beforeStatus.metrics.writes.total);
    assert.equal(afterStatus.metrics.sqliteWrites, beforeStatus.metrics.sqliteWrites);
    assert.equal(queryCount(afterStatus, 'list_syncJobs'), beforeListSyncJobs);
    assert.equal(queryCount(afterStatus, 'list_syncJobs_status') > beforeSyncJobsByStatus, true);
    assert.equal(writeCount(afterStatus, 'sync_job_stale_reconcile'), beforeStaleReconcileWrite + 1);
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

test('sqlite-primary sync startup reconcile uses direct SQLite patch writes', async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'nb-clan-sqlite-sync-startup-reconcile-'));
  const previousEnv = {
    NB_DATA_DIR: process.env.NB_DATA_DIR,
    NB_ROOT_PASSWORD: process.env.NB_ROOT_PASSWORD,
    NB_STORAGE_MODE: process.env.NB_STORAGE_MODE,
    NB_SQLITE_FILE: process.env.NB_SQLITE_FILE,
    NB_DISABLE_BACKGROUND_JOBS: process.env.NB_DISABLE_BACKGROUND_JOBS,
    NB_DISABLE_EXTERNAL_VITAL: process.env.NB_DISABLE_EXTERNAL_VITAL
  };
  process.env.NB_DATA_DIR = dataDir;
  process.env.NB_ROOT_PASSWORD = 'RootPass123!';
  process.env.NB_STORAGE_MODE = 'sqlite-primary';
  process.env.NB_SQLITE_FILE = path.join(dataDir, 'nb-clan.sqlite');
  process.env.NB_DISABLE_BACKGROUND_JOBS = '1';
  process.env.NB_DISABLE_EXTERNAL_VITAL = '1';

  try {
    const storeModule = await uniqueImport('../server/store.js');
    const syncJobStoreModule = await uniqueImport('../server/sync-job-store.js');
    const repositoryModule = await import('../server/storage/repository.js');
    await storeModule.ensureStore();
    const createdAt = new Date().toISOString();
    await repositoryModule.writeSqliteStorePatch({
      reason: 'sqlite_test_sync_startup_reconcile_seed',
      upserts: {
        syncJobs: [{
          id: 'sync_job_sqlite_startup_reconcile',
          type: 'kda',
          source: 'manual',
          scope: 'kda',
          status: 'running',
          targetWipeId: 'wipe_sqlite_startup_reconcile',
          targetServerId: '',
          targetServerName: '',
          totalCount: 3,
          doneCount: 1,
          failedCount: 0,
          skippedCount: 0,
          percent: 33,
          etaSeconds: 60,
          startedAt: createdAt,
          finishedAt: '',
          createdBy: 'user_root',
          errorSummary: '',
          details: {},
          createdAt,
          updatedAt: createdAt
        }]
      },
      scalars: {
        syncState: {
          kda: {
            status: 'running',
            source: 'manual',
            requested: 3,
            completed: 1,
            failed: 0,
            skipped: 0,
            percent: 33,
            etaSeconds: 60,
            startedAt: createdAt,
            syncedAt: '',
            updatedAt: createdAt,
            syncJobId: 'sync_job_sqlite_startup_reconcile',
            syncJobType: 'kda',
            syncJobSource: 'manual',
            syncJobScope: 'kda'
          }
        }
      }
    });

    const beforeStatus = await storeModule.storeRuntimeStatus();
    const beforeStat = await stat(storeModule.STORE_FILE);
    const queryCount = (status, name) => status.sqlite?.queries?.byName?.[name]?.total || 0;
    const beforeListSyncJobs = queryCount(beforeStatus, 'list_syncJobs');
    const beforeSyncJobsByStatus = queryCount(beforeStatus, 'list_syncJobs_status');
    const writeCount = (status, name) => status.sqlite?.writes?.byName?.[name]?.total || 0;
    const beforeStartupReconcileWrite = writeCount(beforeStatus, 'sync_job_startup_reconcile');

    const changed = await syncJobStoreModule.reconcileActiveSyncWorkOnStartup();
    assert.equal(changed, 2);

    const job = await repositoryModule.getSqliteRecord('syncJobs', 'sync_job_sqlite_startup_reconcile');
    const syncState = await repositoryModule.getSqliteScalar('syncState');
    const afterStatus = await storeModule.storeRuntimeStatus();
    const afterStat = await stat(storeModule.STORE_FILE);
    assert.equal(job.status, 'cancelled');
    assert.equal(job.skippedCount, 2);
    assert.equal(job.percent, 100);
    assert.equal(syncState.kda.status, 'cancelled');
    assert.equal(syncState.kda.ignored, 2);
    assert.equal(afterStat.mtimeMs, beforeStat.mtimeMs);
    assert.equal(afterStatus.metrics.writes.total, beforeStatus.metrics.writes.total);
    assert.equal(afterStatus.metrics.sqliteWrites, beforeStatus.metrics.sqliteWrites);
    assert.equal(queryCount(afterStatus, 'list_syncJobs'), beforeListSyncJobs);
    assert.equal(queryCount(afterStatus, 'list_syncJobs_status') > beforeSyncJobsByStatus, true);
    assert.equal(writeCount(afterStatus, 'sync_job_startup_reconcile'), beforeStartupReconcileWrite + 1);
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

test('sqlite-primary sync auto rules append logs without listing log history', async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'nb-clan-sqlite-sync-auto-rules-'));
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
    await storeModule.ensureStore();
    const repositoryModule = await import('../server/storage/repository.js');

    const app = express();
    app.use('/api', apiModule.createApiRouter());
    server = createServer(app);
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const baseUrl = `http://127.0.0.1:${server.address().port}/api`;
    const sessionId = await authModule.createSession('user_root');
    const cookie = `nb_session=${encodeURIComponent(sessionId)}`;
    const queryCount = (status, name) => status.sqlite?.queries?.byName?.[name]?.total || 0;
    const writeCount = (status, name) => status.sqlite?.writes?.byName?.[name]?.total || 0;
    const beforeStatus = await storeModule.storeRuntimeStatus({ sqliteSummary: false });
    const beforeListLogs = queryCount(beforeStatus, 'list_logs');
    const beforeStat = await stat(storeModule.STORE_FILE);

    const createResponse = await httpFetch(`${baseUrl}/sync/auto-rules`, {
      method: 'POST',
      headers: {
        cookie,
        'content-type': 'application/json'
      },
      body: JSON.stringify({
        name: 'SQLite 自动规则',
        type: 'member_profile',
        enabled: false,
        intervalMinutes: 30,
        scope: 'missing_only',
        notes: 'create'
      })
    });
    assert.equal(createResponse.status, 200);
    const createPayload = await createResponse.json();
    assert.equal(createPayload.ok, true);
    const ruleId = createPayload.rules.find((rule) => rule.name === 'SQLite 自动规则')?.id;
    assert.equal(Boolean(ruleId), true);

    const updateResponse = await httpFetch(`${baseUrl}/sync/auto-rules/${ruleId}`, {
      method: 'PUT',
      headers: {
        cookie,
        'content-type': 'application/json'
      },
      body: JSON.stringify({
        name: 'SQLite 自动规则更新',
        type: 'member_profile',
        enabled: true,
        intervalMinutes: 45,
        scope: 'all_members',
        notes: 'update'
      })
    });
    assert.equal(updateResponse.status, 200);
    const updatePayload = await updateResponse.json();
    assert.equal(updatePayload.ok, true);
    const updatedRule = updatePayload.rules.find((rule) => rule.id === ruleId);
    assert.equal(updatedRule.name, 'SQLite 自动规则更新');
    assert.equal(updatedRule.enabled, true);
    assert.equal(updatedRule.intervalMinutes, 45);

    const deleteResponse = await httpFetch(`${baseUrl}/sync/auto-rules/${ruleId}`, {
      method: 'DELETE',
      headers: { cookie }
    });
    assert.equal(deleteResponse.status, 200);
    const deletePayload = await deleteResponse.json();
    assert.equal(deletePayload.ok, true);
    assert.equal(deletePayload.deleted, 1);
    assert.equal(deletePayload.rules.some((rule) => rule.id === ruleId), false);

    const afterMutationStatus = await storeModule.storeRuntimeStatus({ sqliteSummary: false });
    const afterMutationStat = await stat(storeModule.STORE_FILE);
    assert.equal(queryCount(afterMutationStatus, 'list_logs'), beforeListLogs);
    assert.equal(writeCount(afterMutationStatus, 'sync_auto_rule_add'), writeCount(beforeStatus, 'sync_auto_rule_add') + 1);
    assert.equal(writeCount(afterMutationStatus, 'sync_auto_rule_edit'), writeCount(beforeStatus, 'sync_auto_rule_edit') + 1);
    assert.equal(writeCount(afterMutationStatus, 'sync_auto_rule_delete'), writeCount(beforeStatus, 'sync_auto_rule_delete') + 1);
    assert.equal(writeCount(afterMutationStatus, 'sync_auto_rule_add_log_trim'), writeCount(beforeStatus, 'sync_auto_rule_add_log_trim'));
    assert.equal(writeCount(afterMutationStatus, 'sync_auto_rule_edit_log_trim'), writeCount(beforeStatus, 'sync_auto_rule_edit_log_trim'));
    assert.equal(writeCount(afterMutationStatus, 'sync_auto_rule_delete_log_trim'), writeCount(beforeStatus, 'sync_auto_rule_delete_log_trim'));
    assert.equal(afterMutationStat.mtimeMs, beforeStat.mtimeMs);
    assert.equal(afterMutationStatus.metrics.writes.total, beforeStatus.metrics.writes.total);
    assert.equal(afterMutationStatus.metrics.sqliteWrites, beforeStatus.metrics.sqliteWrites);

    const persistedRule = await repositoryModule.getSqliteRecord('syncAutoRules', ruleId);
    const logs = await repositoryModule.getSqliteCollection('logs', { limit: 0 });
    assert.equal(persistedRule, null);
    assert.equal(logs.some((log) => log.type === 'sync_auto_rule_add' && log.targetId === ruleId), true);
    assert.equal(logs.some((log) => log.type === 'sync_auto_rule_edit' && log.targetId === ruleId), true);
    assert.equal(logs.some((log) => log.type === 'sync_auto_rule_delete' && log.targetId === ruleId), true);
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

test('sqlite migrate and verify scripts mirror store.json', async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'nb-clan-sqlite-script-'));
  const previousEnv = {
    NB_DATA_DIR: process.env.NB_DATA_DIR,
    NB_ROOT_PASSWORD: process.env.NB_ROOT_PASSWORD,
    NB_STORAGE_MODE: process.env.NB_STORAGE_MODE,
    NB_SQLITE_FILE: process.env.NB_SQLITE_FILE
  };
  process.env.NB_DATA_DIR = dataDir;
  process.env.NB_ROOT_PASSWORD = 'RootPass123!';
  delete process.env.NB_STORAGE_MODE;
  delete process.env.NB_SQLITE_FILE;

  try {
    const storeModule = await uniqueImport('../server/store.js');
    const { STORE_FILE, ensureStore, updateStore } = storeModule;
    await ensureStore();
    await updateStore((store) => {
      store.members.push({
        id: 'member_sqlite_test',
        steamId: '76561198000000001',
        nickname: 'SQLite Test',
        createdAt: '2026-06-22T00:00:00.000Z',
        updatedAt: '2026-06-22T00:00:00.000Z'
      });
    });

    const sqliteFile = path.join(dataDir, 'nb-clan.sqlite');
    const migrate = await execFileAsync(process.execPath, [
      'scripts/sqlite-migrate-store.js',
      '--source', STORE_FILE,
      '--target', sqliteFile,
      '--mode', 'apply'
    ], { cwd: path.resolve('.') });
    const migratePayload = JSON.parse(migrate.stdout);
    assert.equal(migratePayload.ok, true);
    assert.equal(migratePayload.sqlite.counts.members, 1);

    const verify = await execFileAsync(process.execPath, [
      'scripts/sqlite-verify-store.js',
      '--source', STORE_FILE,
      '--target', sqliteFile
    ], { cwd: path.resolve('.') });
    const verifyPayload = JSON.parse(verify.stdout);
    assert.equal(verifyPayload.ok, true);
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

test('sqlite-primary auth sessions use direct SQLite session records', async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'nb-clan-sqlite-auth-'));
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
	    const storeModule = await uniqueImport('../server/store.js');
	    const authModule = await uniqueImport('../server/auth.js');
	    const repositoryModule = await import('../server/storage/repository.js');
	    await storeModule.ensureStore();
	    await storeModule.updateStore((store) => {
	      store.sessions.push({
	        id: 'sess_sqlite_expired_auth',
	        userId: 'user_root',
	        createdAt: '2020-01-01T00:00:00.000Z',
	        expiresAt: '2020-01-01T01:00:00.000Z'
	      });
	    });
	    const queryCount = (status, name) => status.sqlite?.queries?.byName?.[name]?.total || 0;
	    const writeCount = (status, name) => status.sqlite?.writes?.byName?.[name]?.total || 0;
	    const beforeStatus = await storeModule.storeRuntimeStatus();
	    const beforeListSessions = queryCount(beforeStatus, 'list_sessions');
	    const beforeSessionCreateWrites = writeCount(beforeStatus, 'session_create');
	    const beforeExpiredTrimWrites = writeCount(beforeStatus, 'session_create_expired_trim');
	    assert.equal(beforeStatus.sqlite.records.sessions, 1);

	    const encodedSessionId = await authModule.createSession('user_root');
	    assert.match(encodedSessionId, /^sess_/);
	    let status = await storeModule.storeRuntimeStatus();
	    assert.equal(status.sqlite.records.sessions, 1);
	    assert.equal(queryCount(status, 'list_sessions'), beforeListSessions);
	    assert.equal(writeCount(status, 'session_create'), beforeSessionCreateWrites + 1);
	    assert.equal(writeCount(status, 'session_create_expired_trim'), beforeExpiredTrimWrites);
    assert.equal(
      status.sqlite.compatibility.syncStoreChangesToSqlite,
      beforeStatus.sqlite.compatibility.syncStoreChangesToSqlite
    );
    assert.equal(status.metrics.sqliteWrites, beforeStatus.metrics.sqliteWrites);

    const req = {
      headers: { cookie: `nb_session=${encodeURIComponent(encodedSessionId)}` }
    };
    await new Promise((resolve, reject) => {
      authModule.attachUser(req, {}, (error) => (error ? reject(error) : resolve()));
    });
    assert.equal(req.user.username, 'root');
    assert.equal(req.user.id, 'user_root');

    await authModule.destroySession(req);
    status = await storeModule.storeRuntimeStatus();
    assert.equal(status.sqlite.records.sessions || 0, 0);
    assert.equal(
      status.sqlite.compatibility.syncStoreChangesToSqlite,
      beforeStatus.sqlite.compatibility.syncStoreChangesToSqlite
    );
    assert.equal(status.metrics.sqliteWrites, beforeStatus.metrics.sqliteWrites);

    const beforeCreateFailure = await storeModule.storeRuntimeStatus({ sqliteSummary: false });
    const beforeCreateFailurePatchWrites = writeCount(beforeCreateFailure, 'sqlite_primary_patch');
    const beforeCreateFailureReadStoreFull = queryCount(beforeCreateFailure, 'read_store_full');
    repositoryModule.injectSqliteStorePatchFailureForTests('session_create', 1);
    await assert.rejects(
      () => authModule.createSession('user_root'),
      (error) => error?.status === 503 && error?.code === 'auth_session_create_unavailable' && /登录会话创建暂不可用/.test(error.message)
    );
    let failureStatus = await storeModule.storeRuntimeStatus({ sqliteSummary: false });
    assert.equal(failureStatus.sqlite.records.sessions || 0, 0);
    assert.equal(writeCount(failureStatus, 'sqlite_primary_patch'), beforeCreateFailurePatchWrites);
    assert.equal(queryCount(failureStatus, 'read_store_full'), beforeCreateFailureReadStoreFull);

    const encodedFailureSessionId = await authModule.createSession('user_root');
    const failureSessionId = encodedFailureSessionId.split('.')[0];
    const beforeDestroyFailure = await storeModule.storeRuntimeStatus({ sqliteSummary: false });
    const beforeDestroyFailurePatchWrites = writeCount(beforeDestroyFailure, 'sqlite_primary_patch');
    const beforeDestroyFailureReadStoreFull = queryCount(beforeDestroyFailure, 'read_store_full');
    repositoryModule.injectSqliteStorePatchFailureForTests('session_destroy', 1);
    await assert.rejects(
      () => authModule.destroySession({
        headers: { cookie: `nb_session=${encodeURIComponent(encodedFailureSessionId)}` }
      }),
      (error) => error?.status === 503 && error?.code === 'auth_session_destroy_unavailable' && /登录会话删除暂不可用/.test(error.message)
    );
    failureStatus = await storeModule.storeRuntimeStatus({ sqliteSummary: false });
    assert.equal(Boolean(await repositoryModule.getSqliteRecord('sessions', failureSessionId)), true);
    assert.equal(writeCount(failureStatus, 'sqlite_primary_patch'), beforeDestroyFailurePatchWrites);
    assert.equal(queryCount(failureStatus, 'read_store_full'), beforeDestroyFailureReadStoreFull);

    const beforeAttachSessionFailure = await storeModule.storeRuntimeStatus({ sqliteSummary: false });
    repositoryModule.injectSqliteQueryFailureForTests('get_sessions', 1);
    const attachSessionFailureReq = {
      headers: { cookie: `nb_session=${encodeURIComponent(encodedFailureSessionId)}` }
    };
    const attachSessionFailureError = await new Promise((resolve) => {
      authModule.attachUser(attachSessionFailureReq, {}, (error) => resolve(error || null));
    });
    failureStatus = await storeModule.storeRuntimeStatus({ sqliteSummary: false });
    assert.equal(attachSessionFailureError?.status, 503);
    assert.equal(attachSessionFailureError?.code, 'auth_session_read_unavailable');
    assert.equal(attachSessionFailureReq.user, undefined);
    assert.equal(failureStatus.metrics.reads.total, beforeAttachSessionFailure.metrics.reads.total);
    assert.equal(failureStatus.metrics.clones.total, beforeAttachSessionFailure.metrics.clones.total);
    assert.equal(queryCount(failureStatus, 'read_store_full'), queryCount(beforeAttachSessionFailure, 'read_store_full'));

    const beforeAttachUserFailure = await storeModule.storeRuntimeStatus({ sqliteSummary: false });
    repositoryModule.injectSqliteQueryFailureForTests('get_users', 1);
    const attachUserFailureReq = {
      headers: { cookie: `nb_session=${encodeURIComponent(encodedFailureSessionId)}` }
    };
    const attachUserFailureError = await new Promise((resolve) => {
      authModule.attachUser(attachUserFailureReq, {}, (error) => resolve(error || null));
    });
    failureStatus = await storeModule.storeRuntimeStatus({ sqliteSummary: false });
    assert.equal(attachUserFailureError?.status, 503);
    assert.equal(attachUserFailureError?.code, 'auth_session_read_unavailable');
    assert.equal(attachUserFailureReq.user, undefined);
    assert.equal(failureStatus.metrics.reads.total, beforeAttachUserFailure.metrics.reads.total);
    assert.equal(failureStatus.metrics.clones.total, beforeAttachUserFailure.metrics.clones.total);
    assert.equal(queryCount(failureStatus, 'read_store_full'), queryCount(beforeAttachUserFailure, 'read_store_full'));
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

test('sqlite-primary permission role lifecycle uses direct SQLite patch writes', async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'nb-clan-sqlite-permission-roles-'));
  const previousEnv = {
    NB_DATA_DIR: process.env.NB_DATA_DIR,
    NB_ROOT_PASSWORD: process.env.NB_ROOT_PASSWORD,
    NB_STORAGE_MODE: process.env.NB_STORAGE_MODE,
    NB_SQLITE_FILE: process.env.NB_SQLITE_FILE,
    NB_DISABLE_BACKGROUND_JOBS: process.env.NB_DISABLE_BACKGROUND_JOBS,
    NB_DISABLE_EXTERNAL_VITAL: process.env.NB_DISABLE_EXTERNAL_VITAL
  };
  const originalFetch = globalThis.fetch;
  const httpFetch = originalFetch.bind(globalThis);
  process.env.NB_DATA_DIR = dataDir;
  process.env.NB_ROOT_PASSWORD = 'RootPass123!';
  process.env.NB_STORAGE_MODE = 'sqlite-primary';
  process.env.NB_SQLITE_FILE = path.join(dataDir, 'nb-clan.sqlite');
  process.env.NB_DISABLE_BACKGROUND_JOBS = '1';
  process.env.NB_DISABLE_EXTERNAL_VITAL = '1';

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

    const loginResponse = await httpFetch(`${baseUrl}/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'root', password: 'RootPass123!' })
    });
    assert.equal(loginResponse.status, 200);
    const cookie = loginResponse.headers.get('set-cookie')?.split(';')[0] || '';
    assert.match(cookie, /^nb_session=/);

    const writeCount = (status, name) => status.sqlite?.writes?.byName?.[name]?.total || 0;
    const beforeStatus = await storeModule.storeRuntimeStatus();
    const beforeStat = await stat(storeModule.STORE_FILE);

    const addResponse = await httpFetch(`${baseUrl}/permissions/roles`, {
      method: 'POST',
      headers: {
        cookie,
        'content-type': 'application/json'
      },
      body: JSON.stringify({
        code: 'sqlite_custom_role',
        name: 'SQLite Custom Role',
        permissions: {
          members: { view: true },
          logs: { view: true }
        }
      })
    });
    assert.equal(addResponse.status, 200);
    const addPayload = await addResponse.json();
    assert.equal(addPayload.roles.some((role) => role.code === 'sqlite_custom_role'), true);

    const editResponse = await httpFetch(`${baseUrl}/permissions/roles/sqlite_custom_role`, {
      method: 'PUT',
      headers: {
        cookie,
        'content-type': 'application/json'
      },
      body: JSON.stringify({
        name: 'SQLite Custom Role Edited',
        permissions: {
          members: { view: true, edit: true },
          logs: { view: true }
        }
      })
    });
    assert.equal(editResponse.status, 200);
    const editPayload = await editResponse.json();
    assert.equal(editPayload.roles.find((role) => role.code === 'sqlite_custom_role')?.name, 'SQLite Custom Role Edited');

    const deleteResponse = await httpFetch(`${baseUrl}/permissions/roles/sqlite_custom_role`, {
      method: 'DELETE',
      headers: { cookie }
    });
    assert.equal(deleteResponse.status, 200);
    const deletePayload = await deleteResponse.json();
    assert.equal(deletePayload.roles.some((role) => role.code === 'sqlite_custom_role'), false);

    const roles = await repositoryModule.getSqliteCollection('permissionRoles', { limit: 0 });
    const logs = await repositoryModule.getSqliteCollection('logs', { limit: 0 });
    const afterStatus = await storeModule.storeRuntimeStatus();
    const afterStat = await stat(storeModule.STORE_FILE);
    assert.equal(roles.some((role) => role.code === 'sqlite_custom_role'), false);
    assert.equal(logs.some((log) => log.type === 'permission_role_add' && log.targetId === 'sqlite_custom_role'), true);
    assert.equal(logs.some((log) => log.type === 'permission_role_edit' && log.targetId === 'sqlite_custom_role'), true);
    assert.equal(logs.some((log) => log.type === 'permission_role_delete' && log.targetId === 'sqlite_custom_role'), true);
    assert.equal(afterStat.mtimeMs, beforeStat.mtimeMs);
    assert.equal(afterStatus.metrics.writes.total, beforeStatus.metrics.writes.total);
    assert.equal(afterStatus.metrics.sqliteWrites, beforeStatus.metrics.sqliteWrites);
    assert.equal(writeCount(afterStatus, 'permission_role_add'), writeCount(beforeStatus, 'permission_role_add') + 1);
    assert.equal(writeCount(afterStatus, 'permission_role_edit'), writeCount(beforeStatus, 'permission_role_edit') + 1);
    assert.equal(writeCount(afterStatus, 'permission_role_delete'), writeCount(beforeStatus, 'permission_role_delete') + 1);
    assert.equal(writeCount(afterStatus, 'permission_role_add_log_trim'), writeCount(beforeStatus, 'permission_role_add_log_trim'));
    assert.equal(writeCount(afterStatus, 'permission_role_edit_log_trim'), writeCount(beforeStatus, 'permission_role_edit_log_trim'));
    assert.equal(writeCount(afterStatus, 'permission_role_delete_log_trim'), writeCount(beforeStatus, 'permission_role_delete_log_trim'));
  } finally {
    if (server) await new Promise((resolve) => server.close(resolve));
    const sqliteModule = await import('../server/storage/sqlite.js');
    await sqliteModule.closeSqliteDatabasesForTests();
    globalThis.fetch = originalFetch;
    Object.assign(process.env, previousEnv);
    for (const [key, value] of Object.entries(previousEnv)) {
      if (value === undefined) delete process.env[key];
    }
    await rm(dataDir, { recursive: true, force: true });
  }
});

test('sqlite-primary user account lifecycle uses direct SQLite patch writes', async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'nb-clan-sqlite-user-accounts-'));
  const previousEnv = {
    NB_DATA_DIR: process.env.NB_DATA_DIR,
    NB_ROOT_PASSWORD: process.env.NB_ROOT_PASSWORD,
    NB_STORAGE_MODE: process.env.NB_STORAGE_MODE,
    NB_SQLITE_FILE: process.env.NB_SQLITE_FILE,
    NB_DISABLE_BACKGROUND_JOBS: process.env.NB_DISABLE_BACKGROUND_JOBS,
    NB_DISABLE_EXTERNAL_VITAL: process.env.NB_DISABLE_EXTERNAL_VITAL
  };
  const originalFetch = globalThis.fetch;
  const httpFetch = originalFetch.bind(globalThis);
  process.env.NB_DATA_DIR = dataDir;
  process.env.NB_ROOT_PASSWORD = 'RootPass123!';
  process.env.NB_STORAGE_MODE = 'sqlite-primary';
  process.env.NB_SQLITE_FILE = path.join(dataDir, 'nb-clan.sqlite');
  process.env.NB_DISABLE_BACKGROUND_JOBS = '1';
  process.env.NB_DISABLE_EXTERNAL_VITAL = '1';

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

    const loginResponse = await httpFetch(`${baseUrl}/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'root', password: 'RootPass123!' })
    });
    assert.equal(loginResponse.status, 200);
    const cookie = loginResponse.headers.get('set-cookie')?.split(';')[0] || '';
    assert.match(cookie, /^nb_session=/);

    const createdAt = new Date().toISOString();
    await repositoryModule.writeSqliteStorePatch({
      reason: 'sqlite_test_user_account_orphan_seed',
      upserts: {
        users: [{
          id: 'user_sqlite_orphan_member_account',
          username: 'sqlite_orphan_member_account',
          role: 'member',
          passwordHash: await storeModule.hashPassword('OrphanMemberPass123!'),
          boundSteamId: '76561198007777771',
          steamNickname: 'SQLite Orphan Member',
          createdAt,
          updatedAt: createdAt,
          createdBy: 'sqlite_test'
        }],
        sessions: [{
          id: 'session_sqlite_orphan_member_account',
          userId: 'user_sqlite_orphan_member_account',
          createdAt,
          expiresAt: new Date(Date.now() + 86_400_000).toISOString()
        }]
      }
    });

    const writeCount = (status, name) => status.sqlite?.writes?.byName?.[name]?.total || 0;
    const beforeStatus = await storeModule.storeRuntimeStatus();
    const beforeStat = await stat(storeModule.STORE_FILE);

    const createResponse = await httpFetch(`${baseUrl}/users`, {
      method: 'POST',
      headers: {
        cookie,
        'content-type': 'application/json'
      },
      body: JSON.stringify({
        username: 'sqlite_account_lifecycle',
        password: 'AccountLife123!',
        role: 'member_manager'
      })
    });
    assert.equal(createResponse.status, 200);
    const createPayload = await createResponse.json();
    const createdUser = createPayload.users.find((user) => user.username === 'sqlite_account_lifecycle');
    assert.equal(Boolean(createdUser), true);
    assert.equal(createdUser.role, 'member_manager');

    const editResponse = await httpFetch(`${baseUrl}/users/${createdUser.id}`, {
      method: 'PUT',
      headers: {
        cookie,
        'content-type': 'application/json'
      },
      body: JSON.stringify({ role: 'admin' })
    });
    assert.equal(editResponse.status, 200);
    const editPayload = await editResponse.json();
    assert.equal(editPayload.users.find((user) => user.id === createdUser.id)?.role, 'admin');

    const deleteResponse = await httpFetch(`${baseUrl}/users/${createdUser.id}`, {
      method: 'DELETE',
      headers: { cookie }
    });
    assert.equal(deleteResponse.status, 200);
    const deletePayload = await deleteResponse.json();
    assert.equal(deletePayload.users.some((user) => user.id === createdUser.id), false);

    const cleanupResponse = await httpFetch(`${baseUrl}/users/cleanup-orphan-member-accounts`, {
      method: 'POST',
      headers: { cookie }
    });
    assert.equal(cleanupResponse.status, 200);
    const cleanupPayload = await cleanupResponse.json();
    assert.equal(cleanupPayload.cleanup.deleted, 1);
    assert.equal(cleanupPayload.cleanup.deletedUserIds.includes('user_sqlite_orphan_member_account'), true);

    const profileResponse = await httpFetch(`${baseUrl}/profile`, {
      method: 'PUT',
      headers: {
        cookie,
        'content-type': 'application/json'
      },
      body: JSON.stringify({ boundSteamInput: '' })
    });
    assert.equal(profileResponse.status, 200);

    const users = await repositoryModule.getSqliteCollection('users', { limit: 0 });
    const sessions = await repositoryModule.getSqliteCollection('sessions', { limit: 0 });
    const logs = await repositoryModule.getSqliteCollection('logs', { limit: 0 });
    const afterStatus = await storeModule.storeRuntimeStatus();
    const afterStat = await stat(storeModule.STORE_FILE);

    assert.equal(users.some((user) => user.id === createdUser.id), false);
    assert.equal(users.some((user) => user.id === 'user_sqlite_orphan_member_account'), false);
    assert.equal(sessions.some((session) => session.id === 'session_sqlite_orphan_member_account'), false);
    assert.equal(logs.some((log) => log.type === 'user_add' && log.targetId === createdUser.id), true);
    assert.equal(logs.some((log) => log.type === 'user_edit' && log.targetId === createdUser.id), true);
    assert.equal(logs.some((log) => log.type === 'user_delete' && log.targetId === createdUser.id), true);
    assert.equal(logs.some((log) => log.type === 'user_delete' && log.targetId === 'orphan_member_accounts'), true);
    assert.equal(logs.some((log) => log.type === 'profile_edit' && log.actorUserId === 'user_root'), true);
    assert.equal(afterStat.mtimeMs, beforeStat.mtimeMs);
    assert.equal(afterStatus.metrics.writes.total, beforeStatus.metrics.writes.total);
    assert.equal(afterStatus.metrics.sqliteWrites, beforeStatus.metrics.sqliteWrites);
    assert.equal(writeCount(afterStatus, 'user_add'), writeCount(beforeStatus, 'user_add') + 1);
    assert.equal(writeCount(afterStatus, 'user_edit'), writeCount(beforeStatus, 'user_edit') + 1);
    assert.equal(writeCount(afterStatus, 'user_delete'), writeCount(beforeStatus, 'user_delete') + 1);
    assert.equal(
      writeCount(afterStatus, 'user_cleanup_orphan_member_accounts'),
      writeCount(beforeStatus, 'user_cleanup_orphan_member_accounts') + 1
    );
    assert.equal(writeCount(afterStatus, 'profile_edit'), writeCount(beforeStatus, 'profile_edit') + 1);
    assert.equal(writeCount(afterStatus, 'user_add_log_trim'), writeCount(beforeStatus, 'user_add_log_trim'));
    assert.equal(writeCount(afterStatus, 'user_edit_log_trim'), writeCount(beforeStatus, 'user_edit_log_trim'));
    assert.equal(writeCount(afterStatus, 'user_delete_log_trim'), writeCount(beforeStatus, 'user_delete_log_trim'));
    assert.equal(
      writeCount(afterStatus, 'user_cleanup_orphan_member_accounts_log_trim'),
      writeCount(beforeStatus, 'user_cleanup_orphan_member_accounts_log_trim')
    );
    assert.equal(writeCount(afterStatus, 'profile_edit_log_trim'), writeCount(beforeStatus, 'profile_edit_log_trim'));
  } finally {
    if (server) await new Promise((resolve) => server.close(resolve));
    const sqliteModule = await import('../server/storage/sqlite.js');
    await sqliteModule.closeSqliteDatabasesForTests();
    globalThis.fetch = originalFetch;
    Object.assign(process.env, previousEnv);
    for (const [key, value] of Object.entries(previousEnv)) {
      if (value === undefined) delete process.env[key];
    }
    await rm(dataDir, { recursive: true, force: true });
  }
});

test('sqlite-primary Steam third-party login uses direct SQLite patch writes', async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'nb-clan-sqlite-third-party-login-'));
  const previousEnv = {
    NB_DATA_DIR: process.env.NB_DATA_DIR,
    NB_ROOT_PASSWORD: process.env.NB_ROOT_PASSWORD,
    NB_STORAGE_MODE: process.env.NB_STORAGE_MODE,
    NB_SQLITE_FILE: process.env.NB_SQLITE_FILE,
    NB_DISABLE_BACKGROUND_JOBS: process.env.NB_DISABLE_BACKGROUND_JOBS,
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
  process.env.NB_RUSTPLUS_RELAY_CHAT_FLUSH_INTERVAL_MS = '0';
  process.env.NODE_ENV = 'test';

  let server = null;
  try {
    const storeModule = await uniqueImport('../server/store.js');
    const apiModule = await uniqueImport('../server/api.js');
    await storeModule.ensureStore();
    const createdAt = '2026-07-02T00:00:00.000Z';
    const steamId = '76561198007777777';
    await storeModule.updateStore((store) => {
      store.settings.thirdPartyLogin ||= {};
      store.settings.thirdPartyLogin.steam = { enabled: true };
      store.users.push({
        id: 'user_sqlite_steam_login_username_conflict',
        username: 'Steam_07777777',
        role: 'viewer',
        passwordHash: 'unused',
        boundSteamId: '76561198000000000',
        steamNickname: '',
        createdAt,
        updatedAt: createdAt
      });
      store.members.push({
        id: 'member_sqlite_steam_login',
        steamId,
        rawInput: steamId,
        customName: 'SQLite Steam Login',
        steamNickname: 'Old SQLite Steam Login',
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
          '<steamID><![CDATA[SQLite Steam OAuth]]></steamID>',
          '<avatarFull>https://cdn.example.com/sqlite-steam-oauth.jpg</avatarFull>',
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

    const beforeStatus = await storeModule.storeRuntimeStatus();
    const queryCount = (status, name) => status.sqlite?.queries?.byName?.[name]?.total || 0;
    const writeCount = (status, name) => status.sqlite?.writes?.byName?.[name]?.total || 0;
    const beforeListUsers = queryCount(beforeStatus, 'list_users');
    const beforeBoundUserReads = queryCount(beforeStatus, 'list_users_boundSteamId');
    const beforeUsernameNoCaseReads = queryCount(beforeStatus, 'list_users_username_nocase');
    const beforeSteamLoginWrite = writeCount(beforeStatus, 'steam_login');
    const beforeSteamLoginLogTrimWrite = writeCount(beforeStatus, 'steam_login_log_trim');
    const beforeStat = await stat(storeModule.STORE_FILE);
    const callbackUrl = `${baseUrl}/auth/steam/callback?openid.claimed_id=${encodeURIComponent(`https://steamcommunity.com/openid/id/${steamId}`)}&testVerified=1`;
    const response = await httpFetch(callbackUrl, { redirect: 'manual' });
    assert.equal(response.status, 302);
    assert.match(response.headers.get('set-cookie') || '', /^nb_session=/);

    const afterStatus = await storeModule.storeRuntimeStatus();
    const afterStat = await stat(storeModule.STORE_FILE);
    const repositoryModule = await import('../server/storage/repository.js');
    const users = await repositoryModule.getSqliteRecordsByJsonField('users', 'boundSteamId', [steamId], { limit: 0 });
    const member = await repositoryModule.getSqliteRecord('members', 'member_sqlite_steam_login');
    const logs = await repositoryModule.getSqliteCollection('logs', { limit: 0 });
    const steamUser = users.find((user) => user.createdBy === 'steam_login');
    assert.equal(Boolean(steamUser), true);
    assert.equal(steamUser.username, 'steam_07777777_2');
    assert.equal(steamUser.loginProviders.steam.steamId, steamId);
    assert.equal(steamUser.steamNickname, 'SQLite Steam OAuth');
    assert.equal(member.steamNickname, 'SQLite Steam OAuth');
    assert.equal(member.avatar, 'https://cdn.example.com/sqlite-steam-oauth.jpg');
    assert.equal(logs.some((log) => log.type === 'steam_login_user_create' && log.targetId === steamUser.id), true);
    assert.equal(logs.some((log) => log.type === 'steam_login' && log.targetId === steamUser.id), true);
    assert.equal(afterStat.mtimeMs, beforeStat.mtimeMs);
    assert.equal(afterStatus.metrics.writes.total, beforeStatus.metrics.writes.total);
    assert.equal(afterStatus.metrics.sqliteWrites, beforeStatus.metrics.sqliteWrites);
    assert.equal(queryCount(afterStatus, 'list_users'), beforeListUsers);
    assert.equal(queryCount(afterStatus, 'list_users_boundSteamId'), beforeBoundUserReads + 1);
    assert.equal(queryCount(afterStatus, 'list_users_username_nocase'), beforeUsernameNoCaseReads + 1);
    assert.equal(writeCount(afterStatus, 'steam_login'), beforeSteamLoginWrite + 1);
    assert.equal(writeCount(afterStatus, 'steam_login_log_trim'), beforeSteamLoginLogTrimWrite);
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

test('sqlite-primary started wipe promotion uses direct SQLite patch writes', async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'nb-clan-sqlite-wipe-promote-'));
  const previousEnv = {
    NB_DATA_DIR: process.env.NB_DATA_DIR,
    NB_ROOT_PASSWORD: process.env.NB_ROOT_PASSWORD,
    NB_STORAGE_MODE: process.env.NB_STORAGE_MODE,
    NB_SQLITE_FILE: process.env.NB_SQLITE_FILE,
    NB_DISABLE_BACKGROUND_JOBS: process.env.NB_DISABLE_BACKGROUND_JOBS,
    NB_DISABLE_EXTERNAL_VITAL: process.env.NB_DISABLE_EXTERNAL_VITAL
  };
  const originalFetch = globalThis.fetch;
  const httpFetch = originalFetch.bind(globalThis);
  process.env.NB_DATA_DIR = dataDir;
  process.env.NB_ROOT_PASSWORD = 'RootPass123!';
  process.env.NB_STORAGE_MODE = 'sqlite-primary';
  process.env.NB_SQLITE_FILE = path.join(dataDir, 'nb-clan.sqlite');
  process.env.NB_DISABLE_BACKGROUND_JOBS = '1';
  process.env.NB_DISABLE_EXTERNAL_VITAL = '1';

  let server = null;
  try {
    const storeModule = await uniqueImport('../server/store.js');
    const apiModule = await uniqueImport('../server/api.js');
    await storeModule.ensureStore();
    const createdAt = '2026-06-22T00:00:00.000Z';
    await storeModule.updateStore((store) => {
      store.wipes.unshift({
        id: 'wipe_sqlite_promote',
        name: 'SQLite Promote Wipe',
        serverName: 'SQLite Promote Server',
        status: 'active',
        startedAt: createdAt,
        closedAt: '',
        wipeLabel: 'Next',
        wipeMode: 'next',
        vitalServerId: '',
        vitalWipeId: '',
        battlemetricsId: '',
        kdaUrl: '',
        createdAt,
        updatedAt: createdAt
      });
    });

    const app = express();
    app.use('/api', apiModule.createApiRouter());
    server = createServer(app);
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const baseUrl = `http://127.0.0.1:${server.address().port}/api`;

    const loginResponse = await httpFetch(`${baseUrl}/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'root', password: 'RootPass123!' })
    });
    assert.equal(loginResponse.status, 200);
    const cookie = loginResponse.headers.get('set-cookie')?.split(';')[0] || '';
    assert.match(cookie, /^nb_session=/);

    const beforeStatus = await storeModule.storeRuntimeStatus();
    const writeCount = (status, name) => status.sqlite?.writes?.byName?.[name]?.total || 0;
    const beforeWipeAutoCurrentWrite = writeCount(beforeStatus, 'wipe_auto_current');
    const beforeWipeAutoCurrentLogTrimWrite = writeCount(beforeStatus, 'wipe_auto_current_log_trim');
    const beforeStat = await stat(storeModule.STORE_FILE);
    const wipesResponse = await httpFetch(`${baseUrl}/wipes`, {
      headers: { cookie }
    });
    assert.equal(wipesResponse.status, 200);

    const repositoryModule = await import('../server/storage/repository.js');
    const promotedWipe = await repositoryModule.getSqliteRecord('wipes', 'wipe_sqlite_promote');
    const logs = await repositoryModule.getSqliteCollection('logs', { limit: 0 });
    const afterStatus = await storeModule.storeRuntimeStatus();
    const afterStat = await stat(storeModule.STORE_FILE);
    assert.equal(promotedWipe.wipeMode, 'current');
    assert.equal(promotedWipe.wipeLabel, 'Current');
    assert.equal(logs.some((log) => log.type === 'wipe_auto_current' && log.targetId === 'wipe_sqlite_promote'), true);
    assert.equal(afterStat.mtimeMs, beforeStat.mtimeMs);
    assert.equal(
      afterStatus.sqlite.compatibility.syncStoreChangesToSqlite,
      beforeStatus.sqlite.compatibility.syncStoreChangesToSqlite
    );
    assert.equal(afterStatus.metrics.sqliteWrites, beforeStatus.metrics.sqliteWrites);
    assert.equal(writeCount(afterStatus, 'wipe_auto_current'), beforeWipeAutoCurrentWrite + 1);
    assert.equal(writeCount(afterStatus, 'wipe_auto_current_log_trim'), beforeWipeAutoCurrentLogTrimWrite);
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

test('sqlite-primary started wipe promotion scans indexed active wipes only', async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'nb-clan-sqlite-wipe-promote-status-'));
  const previousEnv = {
    NB_DATA_DIR: process.env.NB_DATA_DIR,
    NB_ROOT_PASSWORD: process.env.NB_ROOT_PASSWORD,
    NB_STORAGE_MODE: process.env.NB_STORAGE_MODE,
    NB_SQLITE_FILE: process.env.NB_SQLITE_FILE,
    NB_DISABLE_BACKGROUND_JOBS: process.env.NB_DISABLE_BACKGROUND_JOBS,
    NB_DISABLE_EXTERNAL_VITAL: process.env.NB_DISABLE_EXTERNAL_VITAL
  };
  process.env.NB_DATA_DIR = dataDir;
  process.env.NB_ROOT_PASSWORD = 'RootPass123!';
  process.env.NB_STORAGE_MODE = 'sqlite-primary';
  process.env.NB_SQLITE_FILE = path.join(dataDir, 'nb-clan.sqlite');
  process.env.NB_DISABLE_BACKGROUND_JOBS = '1';
  process.env.NB_DISABLE_EXTERNAL_VITAL = '1';

  try {
    const storeModule = await uniqueImport('../server/store.js');
    const apiModule = await uniqueImport('../server/api.js');
    const repositoryModule = await import('../server/storage/repository.js');
    await storeModule.ensureStore();
    const createdAt = '2026-06-22T00:00:00.000Z';
    await repositoryModule.writeSqliteStorePatch({
      reason: 'sqlite_test_wipe_promote_status_seed',
      upserts: {
        wipes: [{
          id: 'wipe_sqlite_promote_status_active',
          name: 'SQLite Promote Status Active',
          serverName: 'SQLite Promote Status Server',
          status: 'active',
          startedAt: createdAt,
          closedAt: '',
          wipeLabel: 'Next',
          wipeMode: 'next',
          createdAt,
          updatedAt: createdAt
        }, {
          id: 'wipe_sqlite_promote_status_closed',
          name: 'SQLite Promote Status Closed',
          serverName: 'SQLite Promote Closed Server',
          status: 'closed',
          startedAt: createdAt,
          closedAt: '2026-06-23T00:00:00.000Z',
          wipeLabel: 'Next',
          wipeMode: 'next',
          createdAt,
          updatedAt: createdAt
        }]
      }
    });

    const queryCount = (status, name) => status.sqlite?.queries?.byName?.[name]?.total || 0;
    const writeCount = (status, name) => status.sqlite?.writes?.byName?.[name]?.total || 0;
    const beforeStatus = await storeModule.storeRuntimeStatus();
    const beforeStat = await stat(storeModule.STORE_FILE);
    const beforeListWipes = queryCount(beforeStatus, 'list_wipes');
    const beforeWipesByStatus = queryCount(beforeStatus, 'list_wipes_status');
    const beforeWipeAutoCurrentWrite = writeCount(beforeStatus, 'wipe_auto_current');

    const promoted = await apiModule.promoteStartedWipesToCurrentIfNeeded();

    const promotedWipe = await repositoryModule.getSqliteRecord('wipes', 'wipe_sqlite_promote_status_active');
    const closedWipe = await repositoryModule.getSqliteRecord('wipes', 'wipe_sqlite_promote_status_closed');
    const afterStatus = await storeModule.storeRuntimeStatus();
    const afterStat = await stat(storeModule.STORE_FILE);
    assert.equal(promoted, 1);
    assert.equal(promotedWipe.wipeMode, 'current');
    assert.equal(promotedWipe.wipeLabel, 'Current');
    assert.equal(closedWipe.wipeMode, 'next');
    assert.equal(closedWipe.wipeLabel, 'Next');
    assert.equal(afterStat.mtimeMs, beforeStat.mtimeMs);
    assert.equal(afterStatus.metrics.writes.total, beforeStatus.metrics.writes.total);
    assert.equal(afterStatus.metrics.sqliteWrites, beforeStatus.metrics.sqliteWrites);
    assert.equal(queryCount(afterStatus, 'list_wipes'), beforeListWipes);
    assert.equal(queryCount(afterStatus, 'list_wipes_status') > beforeWipesByStatus, true);
    assert.equal(writeCount(afterStatus, 'wipe_auto_current'), beforeWipeAutoCurrentWrite + 1);

    await repositoryModule.writeSqliteStorePatch({
      reason: 'sqlite_test_wipe_promote_status_failure_seed',
      upserts: {
        wipes: [{
          id: 'wipe_sqlite_promote_status_failure',
          name: 'SQLite Promote Status Failure',
          serverName: 'SQLite Promote Failure Server',
          status: 'active',
          startedAt: createdAt,
          closedAt: '',
          wipeLabel: 'Next',
          wipeMode: 'next',
          createdAt,
          updatedAt: createdAt
        }]
      }
    });
    const beforeFailureStatus = await storeModule.storeRuntimeStatus();
    const beforeFailureReadStoreFull = queryCount(beforeFailureStatus, 'read_store_full');
    repositoryModule.injectSqliteStorePatchFailureForTests('wipe_auto_current', 1);
    const failedPromoted = await apiModule.promoteStartedWipesToCurrentIfNeeded();
    const failedPromotionWipe = await repositoryModule.getSqliteRecord('wipes', 'wipe_sqlite_promote_status_failure');
    const afterFailureStatus = await storeModule.storeRuntimeStatus();
    assert.equal(failedPromoted, 0);
    assert.equal(failedPromotionWipe.wipeMode, 'next');
    assert.equal(failedPromotionWipe.wipeLabel, 'Next');
    assert.equal(queryCount(afterFailureStatus, 'read_store_full'), beforeFailureReadStoreFull);
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

test('sqlite-primary live member wipe startup reconcile uses wipe-scoped KDA reads', async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'nb-clan-sqlite-live-wipe-reconcile-'));
  const previousEnv = {
    NB_DATA_DIR: process.env.NB_DATA_DIR,
    NB_ROOT_PASSWORD: process.env.NB_ROOT_PASSWORD,
    NB_STORAGE_MODE: process.env.NB_STORAGE_MODE,
    NB_SQLITE_FILE: process.env.NB_SQLITE_FILE,
    NB_DISABLE_BACKGROUND_JOBS: process.env.NB_DISABLE_BACKGROUND_JOBS,
    NB_DISABLE_EXTERNAL_VITAL: process.env.NB_DISABLE_EXTERNAL_VITAL
  };
  process.env.NB_DATA_DIR = dataDir;
  process.env.NB_ROOT_PASSWORD = 'RootPass123!';
  process.env.NB_STORAGE_MODE = 'sqlite-primary';
  process.env.NB_SQLITE_FILE = path.join(dataDir, 'nb-clan.sqlite');
  process.env.NB_DISABLE_BACKGROUND_JOBS = '1';
  process.env.NB_DISABLE_EXTERNAL_VITAL = '1';

  try {
    const storeModule = await uniqueImport('../server/store.js');
    const apiModule = await uniqueImport('../server/api.js');
    const repositoryModule = await import('../server/storage/repository.js');
    await storeModule.ensureStore();
    const createdAt = '2026-07-08T00:00:00.000Z';
    await repositoryModule.writeSqliteStorePatch({
      reason: 'sqlite_test_live_member_wipe_startup_seed',
      upserts: {
        members: [{
          id: 'member_sqlite_live_reconcile',
          steamId: '76561198005550001',
          rawInput: '76561198005550001',
          customName: '',
          steamNickname: 'SQLite Live Reconcile',
          avatar: '',
          discordId: '',
          wechatId: '',
          wechatUserId: '',
          notes: '',
          specialty: [],
          memberStatus: 'active',
          invitedByUserId: '',
          createdAt,
          updatedAt: createdAt
        }],
        squads: [{
          id: 'squad_sqlite_live_current',
          name: 'SQLite Live Current',
          leaderUserIds: [],
          notes: '',
          createdAt,
          updatedAt: createdAt
        }, {
          id: 'squad_sqlite_live_old',
          name: 'SQLite Live Old',
          leaderUserIds: [],
          notes: '',
          createdAt,
          updatedAt: createdAt
        }],
        squadMembers: [{
          id: 'squad_member_sqlite_live_reconcile',
          squadId: 'squad_sqlite_live_current',
          memberId: 'member_sqlite_live_reconcile',
          addedByUserId: 'user_root',
          createdAt
        }],
        wipes: [{
          id: 'wipe_sqlite_live_reconcile',
          name: 'SQLite Live Reconcile Wipe',
          serverName: 'SQLite Live Server',
          status: 'active',
          startedAt: createdAt,
          closedAt: '',
          createdAt,
          updatedAt: createdAt
        }, {
          id: 'wipe_sqlite_live_reconcile_closed',
          name: 'SQLite Closed Reconcile Wipe',
          serverName: 'SQLite Closed Server',
          status: 'closed',
          startedAt: createdAt,
          closedAt: '2026-07-08T01:00:00.000Z',
          createdAt,
          updatedAt: createdAt
        }],
        wipeParticipants: [{
          id: 'participant_sqlite_live_reconcile_sync',
          wipeId: 'wipe_sqlite_live_reconcile',
          memberId: 'member_sqlite_live_reconcile',
          steamId: '76561198005550001',
          squadId: 'squad_sqlite_live_old',
          status: 'on_time',
          createdAt,
          updatedAt: createdAt
        }, {
          id: 'participant_sqlite_live_reconcile_orphan',
          wipeId: 'wipe_sqlite_live_reconcile',
          memberId: 'member_sqlite_live_missing',
          steamId: '76561198005559999',
          squadId: 'squad_sqlite_live_old',
          status: 'on_time',
          createdAt,
          updatedAt: createdAt
        }, {
          id: 'participant_sqlite_live_reconcile_closed_orphan',
          wipeId: 'wipe_sqlite_live_reconcile_closed',
          memberId: 'member_sqlite_live_missing',
          steamId: '76561198005559999',
          squadId: 'squad_sqlite_live_old',
          status: 'on_time',
          createdAt,
          updatedAt: createdAt
        }],
        kdaRows: [{
          id: 'kda_sqlite_live_reconcile_sync',
          wipeId: 'wipe_sqlite_live_reconcile',
          memberId: 'member_sqlite_live_reconcile',
          steamId: '76561198005550001',
          squadId: 'squad_sqlite_live_old',
          kills: 8,
          syncedAt: createdAt
        }, {
          id: 'kda_sqlite_live_reconcile_orphan',
          wipeId: 'wipe_sqlite_live_reconcile',
          memberId: 'member_sqlite_live_missing',
          steamId: '76561198005559999',
          squadId: 'squad_sqlite_live_old',
          kills: 9,
          syncedAt: createdAt
        }, {
          id: 'kda_sqlite_live_reconcile_closed_orphan',
          wipeId: 'wipe_sqlite_live_reconcile_closed',
          memberId: 'member_sqlite_live_missing',
          steamId: '76561198005559999',
          squadId: 'squad_sqlite_live_old',
          kills: 10,
          syncedAt: createdAt
        }],
        kdaSnapshots: [{
          id: 'snapshot_sqlite_live_reconcile_sync',
          wipeId: 'wipe_sqlite_live_reconcile',
          memberId: 'member_sqlite_live_reconcile',
          steamId: '76561198005550001',
          squadId: 'squad_sqlite_live_old',
          kills: 8,
          capturedAt: createdAt
        }, {
          id: 'snapshot_sqlite_live_reconcile_orphan',
          wipeId: 'wipe_sqlite_live_reconcile',
          memberId: 'member_sqlite_live_missing',
          steamId: '76561198005559999',
          squadId: 'squad_sqlite_live_old',
          kills: 9,
          capturedAt: createdAt
        }, {
          id: 'snapshot_sqlite_live_reconcile_closed_orphan',
          wipeId: 'wipe_sqlite_live_reconcile_closed',
          memberId: 'member_sqlite_live_missing',
          steamId: '76561198005559999',
          squadId: 'squad_sqlite_live_old',
          kills: 10,
          capturedAt: createdAt
        }]
      }
    });

    const queryCount = (status, name) => status.sqlite?.queries?.byName?.[name]?.total || 0;
    const writeCount = (status, name) => status.sqlite?.writes?.byName?.[name]?.total || 0;
    const beforeStatus = await storeModule.storeRuntimeStatus();
    const beforeStat = await stat(storeModule.STORE_FILE);
	    const beforeFullReads = {
	      members: queryCount(beforeStatus, 'list_members'),
	      squadMembers: queryCount(beforeStatus, 'list_squadMembers'),
	      wipes: queryCount(beforeStatus, 'list_wipes'),
	      wipeParticipants: queryCount(beforeStatus, 'list_wipeParticipants'),
	      kdaRows: queryCount(beforeStatus, 'list_kdaRows'),
	      kdaSnapshots: queryCount(beforeStatus, 'list_kdaSnapshots')
	    };
	    const beforeScopedReads = {
	      membersById: queryCount(beforeStatus, 'list_members_id'),
	      membersBySteamId: queryCount(beforeStatus, 'list_members_steamId'),
	      squadMembersByMemberId: queryCount(beforeStatus, 'list_squadMembers_memberId'),
	      wipesByStatus: queryCount(beforeStatus, 'list_wipes_status'),
	      wipeParticipantsByWipe: queryCount(beforeStatus, 'list_wipeParticipants_wipeId'),
	      kdaRowsByWipe: queryCount(beforeStatus, 'list_kdaRows_wipeId'),
	      kdaSnapshotsByWipe: queryCount(beforeStatus, 'list_kdaSnapshots_wipeId')
    };
    const beforeReconcileWrite = writeCount(beforeStatus, 'live_member_wipe_squad_startup_reconcile');

    const result = await apiModule.reconcileLiveMemberWipeSquadRecordsOnStartup();

    const syncedParticipant = await repositoryModule.getSqliteRecord('wipeParticipants', 'participant_sqlite_live_reconcile_sync');
    const liveOrphanParticipant = await repositoryModule.getSqliteRecord('wipeParticipants', 'participant_sqlite_live_reconcile_orphan');
    const closedOrphanParticipant = await repositoryModule.getSqliteRecord('wipeParticipants', 'participant_sqlite_live_reconcile_closed_orphan');
    const syncedKdaRow = await repositoryModule.getSqliteRecord('kdaRows', 'kda_sqlite_live_reconcile_sync');
    const liveOrphanKdaRow = await repositoryModule.getSqliteRecord('kdaRows', 'kda_sqlite_live_reconcile_orphan');
    const closedOrphanKdaRow = await repositoryModule.getSqliteRecord('kdaRows', 'kda_sqlite_live_reconcile_closed_orphan');
    const syncedSnapshot = await repositoryModule.getSqliteRecord('kdaSnapshots', 'snapshot_sqlite_live_reconcile_sync');
    const liveOrphanSnapshot = await repositoryModule.getSqliteRecord('kdaSnapshots', 'snapshot_sqlite_live_reconcile_orphan');
    const closedOrphanSnapshot = await repositoryModule.getSqliteRecord('kdaSnapshots', 'snapshot_sqlite_live_reconcile_closed_orphan');
    const afterStatus = await storeModule.storeRuntimeStatus();
    const afterStat = await stat(storeModule.STORE_FILE);

    assert.equal(result.synced, 3);
    assert.deepEqual(result.removed, { participants: 1, kdaRows: 1, kdaSnapshots: 1 });
    assert.equal(syncedParticipant.squadId, 'squad_sqlite_live_current');
    assert.equal(syncedKdaRow.squadId, 'squad_sqlite_live_current');
    assert.equal(syncedSnapshot.squadId, 'squad_sqlite_live_current');
    assert.equal(liveOrphanParticipant, null);
    assert.equal(liveOrphanKdaRow, null);
    assert.equal(liveOrphanSnapshot, null);
    assert.equal(closedOrphanParticipant.squadId, 'squad_sqlite_live_old');
    assert.equal(closedOrphanKdaRow.squadId, 'squad_sqlite_live_old');
    assert.equal(closedOrphanSnapshot.squadId, 'squad_sqlite_live_old');
    assert.equal(afterStat.mtimeMs, beforeStat.mtimeMs);
	    assert.equal(afterStatus.metrics.writes.total, beforeStatus.metrics.writes.total);
	    assert.equal(afterStatus.metrics.sqliteWrites, beforeStatus.metrics.sqliteWrites);
	    assert.equal(queryCount(afterStatus, 'list_members'), beforeFullReads.members);
	    assert.equal(queryCount(afterStatus, 'list_squadMembers'), beforeFullReads.squadMembers);
	    assert.equal(queryCount(afterStatus, 'list_wipes'), beforeFullReads.wipes);
	    assert.equal(queryCount(afterStatus, 'list_wipeParticipants'), beforeFullReads.wipeParticipants);
	    assert.equal(queryCount(afterStatus, 'list_kdaRows'), beforeFullReads.kdaRows);
	    assert.equal(queryCount(afterStatus, 'list_kdaSnapshots'), beforeFullReads.kdaSnapshots);
	    assert.equal(queryCount(afterStatus, 'list_members_id') > beforeScopedReads.membersById, true);
	    assert.equal(queryCount(afterStatus, 'list_members_steamId') > beforeScopedReads.membersBySteamId, true);
	    assert.equal(queryCount(afterStatus, 'list_squadMembers_memberId') > beforeScopedReads.squadMembersByMemberId, true);
	    assert.equal(queryCount(afterStatus, 'list_wipes_status') > beforeScopedReads.wipesByStatus, true);
	    assert.equal(queryCount(afterStatus, 'list_wipeParticipants_wipeId') > beforeScopedReads.wipeParticipantsByWipe, true);
    assert.equal(queryCount(afterStatus, 'list_kdaRows_wipeId') > beforeScopedReads.kdaRowsByWipe, true);
    assert.equal(queryCount(afterStatus, 'list_kdaSnapshots_wipeId') > beforeScopedReads.kdaSnapshotsByWipe, true);
    assert.equal(writeCount(afterStatus, 'live_member_wipe_squad_startup_reconcile'), beforeReconcileWrite + 1);
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

test('sqlite-primary BattleMetrics identity sync uses direct SQLite patch writes', async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'nb-clan-sqlite-bm-identity-'));
  const previousEnv = {
    NB_DATA_DIR: process.env.NB_DATA_DIR,
    NB_ROOT_PASSWORD: process.env.NB_ROOT_PASSWORD,
    NB_STORAGE_MODE: process.env.NB_STORAGE_MODE,
    NB_SQLITE_FILE: process.env.NB_SQLITE_FILE,
    NB_DISABLE_BACKGROUND_JOBS: process.env.NB_DISABLE_BACKGROUND_JOBS,
    NB_DISABLE_EXTERNAL_VITAL: process.env.NB_DISABLE_EXTERNAL_VITAL
  };
  const originalFetch = globalThis.fetch;
  const httpFetch = originalFetch.bind(globalThis);
  process.env.NB_DATA_DIR = dataDir;
  process.env.NB_ROOT_PASSWORD = 'RootPass123!';
  process.env.NB_STORAGE_MODE = 'sqlite-primary';
  process.env.NB_SQLITE_FILE = path.join(dataDir, 'nb-clan.sqlite');
  process.env.NB_DISABLE_BACKGROUND_JOBS = '1';
  process.env.NB_DISABLE_EXTERNAL_VITAL = '1';

  let server = null;
  try {
    const storeModule = await uniqueImport('../server/store.js');
    const apiModule = await uniqueImport('../server/api.js');
    await storeModule.ensureStore();
    const createdAt = '2026-06-22T00:00:00.000Z';
    await storeModule.updateStore((store) => {
      store.settings.battlemetrics ||= {};
      store.settings.battlemetrics.apiKey = 'bm_sqlite_identity_key';
      store.members.unshift({
        id: 'member_sqlite_bm_identity',
        steamId: '76561198000002001',
        rawInput: '76561198000002001',
        customName: 'SQLite BM Identity',
        steamNickname: 'SQLite BM Identity',
        avatar: '',
        discordId: '',
        wechatId: '',
        wechatUserId: '',
        notes: '',
        specialty: [],
        memberStatus: 'active',
        battlemetricsId: '',
        invitedByUserId: '',
        createdAt,
        updatedAt: createdAt
      });
      store.members.unshift({
        id: 'member_sqlite_bm_identity_existing_member',
        steamId: '76561198000002011',
        rawInput: '76561198000002011',
        customName: 'SQLite BM Identity Existing Member',
        steamNickname: 'SQLite BM Identity Existing Member',
        avatar: '',
        discordId: '',
        wechatId: '',
        wechatUserId: '',
        notes: '',
        specialty: [],
        memberStatus: 'active',
        battlemetricsId: 'bm_sqlite_identity_existing_member',
        invitedByUserId: '',
        createdAt,
        updatedAt: createdAt
      });
      store.members.unshift({
        id: 'member_sqlite_bm_identity_profile_cached',
        steamId: '76561198000002012',
        rawInput: '76561198000002012',
        customName: 'SQLite BM Identity Profile Cached',
        steamNickname: 'SQLite BM Identity Profile Cached',
        avatar: '',
        discordId: '',
        wechatId: '',
        wechatUserId: '',
        notes: '',
        specialty: [],
        memberStatus: 'active',
        battlemetricsId: '',
        invitedByUserId: '',
        createdAt,
        updatedAt: createdAt
      });
      store.memberProfiles.push({
        id: 'profile_sqlite_bm_identity_cached',
        memberId: 'member_sqlite_bm_identity_profile_cached',
        steamId: '76561198000002012',
        battlemetricsPlayerId: 'bm_sqlite_identity_profile_cached',
        source: 'manual',
        createdAt,
        updatedAt: createdAt
      });
    });

    const app = express();
    app.use('/api', apiModule.createApiRouter());
    server = createServer(app);
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const baseUrl = `http://127.0.0.1:${server.address().port}/api`;

    const loginResponse = await httpFetch(`${baseUrl}/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'root', password: 'RootPass123!' })
    });
    assert.equal(loginResponse.status, 200);
    const cookie = loginResponse.headers.get('set-cookie')?.split(';')[0] || '';
    assert.match(cookie, /^nb_session=/);

    const queryCount = (status, name) => status.sqlite?.queries?.byName?.[name]?.total || 0;
    const memberStoreModule = await import('../server/member-store.js');
    const beforeCandidateStatus = await storeModule.storeRuntimeStatus({ sqliteSummary: false });
    const beforeCandidateListMembers = queryCount(beforeCandidateStatus, 'list_members');
    const beforeCandidateMissingMembers = queryCount(beforeCandidateStatus, 'list_members_battlemetricsId_missing');
    const beforeCandidateListMemberProfiles = queryCount(beforeCandidateStatus, 'list_memberProfiles');
    const beforeCandidateMemberProfilesByMemberId = queryCount(beforeCandidateStatus, 'list_memberProfiles_memberId');
    const beforeCandidateListWipes = queryCount(beforeCandidateStatus, 'list_wipes');
    const beforeCandidateListParticipants = queryCount(beforeCandidateStatus, 'list_wipeParticipants');
    const candidateSnapshot = await memberStoreModule.readBattlemetricsSyncRequestStore({
      battlemetricsIdentityCandidatesOnly: true
    });
    assert.deepEqual(candidateSnapshot.members.map((member) => member.id).sort(), [
      'member_sqlite_bm_identity',
      'member_sqlite_bm_identity_profile_cached'
    ]);
    assert.equal(candidateSnapshot.memberProfiles.length, 1);
    assert.equal(candidateSnapshot.memberProfiles[0].memberId, 'member_sqlite_bm_identity_profile_cached');
    assert.deepEqual(candidateSnapshot.wipes, []);
    assert.deepEqual(candidateSnapshot.wipeParticipants, []);
    const afterCandidateStatus = await storeModule.storeRuntimeStatus({ sqliteSummary: false });
    assert.equal(queryCount(afterCandidateStatus, 'list_members'), beforeCandidateListMembers);
    assert.equal(queryCount(afterCandidateStatus, 'list_members_battlemetricsId_missing') > beforeCandidateMissingMembers, true);
    assert.equal(queryCount(afterCandidateStatus, 'list_memberProfiles'), beforeCandidateListMemberProfiles);
    assert.equal(queryCount(afterCandidateStatus, 'list_memberProfiles_memberId') > beforeCandidateMemberProfilesByMemberId, true);
    assert.equal(queryCount(afterCandidateStatus, 'list_wipes'), beforeCandidateListWipes);
    assert.equal(queryCount(afterCandidateStatus, 'list_wipeParticipants'), beforeCandidateListParticipants);

    const beforeStatus = await storeModule.storeRuntimeStatus();
    const beforeListMembers = queryCount(beforeStatus, 'list_members');
    const beforeListMemberProfiles = queryCount(beforeStatus, 'list_memberProfiles');
    const beforeGetMembers = queryCount(beforeStatus, 'get_members');
    const beforeMembersById = queryCount(beforeStatus, 'list_members_id');
    const beforeMemberProfilesByMemberId = queryCount(beforeStatus, 'list_memberProfiles_memberId');
    const beforeMembersByBattlemetricsIdPresent = queryCount(beforeStatus, 'list_members_battlemetricsId_present');
    const beforeProfilesByBattlemetricsIdPresent = queryCount(beforeStatus, 'list_memberProfiles_battlemetricsPlayerId_present');
    const beforeStat = await stat(storeModule.STORE_FILE);
    const battlemetricsRequests = [];
    globalThis.fetch = async (url, options = {}) => {
      const href = String(url);
      if (!href.startsWith('https://api.battlemetrics.com')) {
        return originalFetch(url, options);
      }
      battlemetricsRequests.push({ href, body: options.body ? JSON.parse(options.body) : null });
      if (href.endsWith('/players/match')) {
        return new Response(JSON.stringify({
          data: [{
            type: 'identifier',
            id: 'sqlite_identity_identifier',
            attributes: { type: 'steamID', identifier: '76561198000002001' },
            relationships: { player: { data: { type: 'player', id: 'bm_sqlite_identity_player' } } }
          }],
          included: [{
            type: 'player',
            id: 'bm_sqlite_identity_player',
            attributes: { name: 'SQLite BM Identity' }
          }]
        }), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      return new Response(JSON.stringify({ errors: [{ title: 'unexpected BattleMetrics URL' }] }), { status: 404, headers: { 'content-type': 'application/json' } });
    };

    const syncResponse = await httpFetch(`${baseUrl}/sync/jobs/battlemetrics-id`, {
      method: 'POST',
      headers: {
        cookie,
        'content-type': 'application/json'
      },
      body: JSON.stringify({ memberIds: ['member_sqlite_bm_identity'] })
    });
    assert.equal(syncResponse.status, 200);
    const syncPayload = await syncResponse.json();
    assert.equal(syncPayload.ok, true);
    assert.equal(syncPayload.job.type, 'battlemetrics_identity');
    const afterRouteStatus = await storeModule.storeRuntimeStatus({ sqliteSummary: false });
    assert.equal(queryCount(afterRouteStatus, 'get_members'), beforeGetMembers);
    assert.equal(queryCount(afterRouteStatus, 'list_members_id') > beforeMembersById, true);

    const repositoryModule = await import('../server/storage/repository.js');
    const syncedMember = await waitForSqliteRecord(
      repositoryModule,
      'members',
      'member_sqlite_bm_identity',
      (record) => record.battlemetricsId === 'bm_sqlite_identity_player',
      'BattleMetrics identity member update'
    );
    assert.equal(syncedMember.battlemetricsId, 'bm_sqlite_identity_player');
    const syncJob = await waitForSqliteRecord(
      repositoryModule,
      'syncJobs',
      syncPayload.job.id,
      (record) => record.status === 'completed',
      'BattleMetrics identity sync job completion'
    );
    assert.equal(syncJob.doneCount, 1);
    assert.equal(syncJob.failedCount, 0);
    assert.equal(syncJob.percent, 100);
    const profiles = await repositoryModule.getSqliteRecordsByJsonField('memberProfiles', 'memberId', ['member_sqlite_bm_identity'], { limit: 0 });
    assert.equal(profiles.length, 1);
    assert.equal(profiles[0].battlemetricsPlayerId, 'bm_sqlite_identity_player');
    assert.equal(profiles[0].source, 'manual');
    assert.equal(profiles[0].battlemetricsMatchConfidence, 'steam-match');
    const syncState = await repositoryModule.getSqliteScalar('syncState');
    assert.equal(syncState.battlemetricsIdentity.status, 'complete');
    assert.equal(syncState.battlemetricsIdentity.updated, 1);
    assert.equal(syncState.battlemetricsIdentity.failed, 0);
    assert.equal(battlemetricsRequests.filter((item) => item.href.endsWith('/players/match')).length, 1);
    assert.deepEqual(battlemetricsRequests[0].body.data.map((item) => item.attributes.identifier), ['76561198000002001']);

    const afterStatus = await storeModule.storeRuntimeStatus();
    const afterStat = await stat(storeModule.STORE_FILE);
    const queryDeltas = Object.fromEntries(Object.entries(afterStatus.sqlite?.queries?.byName || {})
      .map(([name, value]) => [name, Number(value.total || 0) - Number(beforeStatus.sqlite?.queries?.byName?.[name]?.total || 0)])
      .filter(([, delta]) => delta));
    assert.equal(queryCount(afterStatus, 'list_members'), beforeListMembers, JSON.stringify(queryDeltas));
    assert.equal(queryCount(afterStatus, 'list_memberProfiles'), beforeListMemberProfiles, JSON.stringify(queryDeltas));
    assert.equal(queryCount(afterStatus, 'get_members') > beforeGetMembers, true);
    assert.equal(queryCount(afterStatus, 'list_members_id') > beforeMembersById, true);
    assert.equal(queryCount(afterStatus, 'list_memberProfiles_memberId') > beforeMemberProfilesByMemberId, true);
    assert.equal(queryCount(afterStatus, 'list_members_battlemetricsId_present') > beforeMembersByBattlemetricsIdPresent, true);
    assert.equal(queryCount(afterStatus, 'list_memberProfiles_battlemetricsPlayerId_present') > beforeProfilesByBattlemetricsIdPresent, true);
    assert.equal(afterStat.mtimeMs, beforeStat.mtimeMs);
    assert.equal(
      afterStatus.sqlite.compatibility.syncStoreChangesToSqlite,
      beforeStatus.sqlite.compatibility.syncStoreChangesToSqlite
    );
    assert.equal(afterStatus.metrics.sqliteWrites, beforeStatus.metrics.sqliteWrites);
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

test('sqlite-primary member BattleMetrics ID refresh uses direct SQLite patch writes', async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'nb-clan-sqlite-bm-refresh-'));
  const previousEnv = {
    NB_DATA_DIR: process.env.NB_DATA_DIR,
    NB_ROOT_PASSWORD: process.env.NB_ROOT_PASSWORD,
    NB_STORAGE_MODE: process.env.NB_STORAGE_MODE,
    NB_SQLITE_FILE: process.env.NB_SQLITE_FILE,
    NB_DISABLE_BACKGROUND_JOBS: process.env.NB_DISABLE_BACKGROUND_JOBS,
    NB_DISABLE_EXTERNAL_VITAL: process.env.NB_DISABLE_EXTERNAL_VITAL
  };
  const originalFetch = globalThis.fetch;
  const httpFetch = originalFetch.bind(globalThis);
  process.env.NB_DATA_DIR = dataDir;
  process.env.NB_ROOT_PASSWORD = 'RootPass123!';
  process.env.NB_STORAGE_MODE = 'sqlite-primary';
  process.env.NB_SQLITE_FILE = path.join(dataDir, 'nb-clan.sqlite');
  process.env.NB_DISABLE_BACKGROUND_JOBS = '1';
  process.env.NB_DISABLE_EXTERNAL_VITAL = '1';

  let server = null;
  try {
    const storeModule = await uniqueImport('../server/store.js');
    const apiModule = await uniqueImport('../server/api.js');
    const authModule = await uniqueImport('../server/auth.js');
    await storeModule.ensureStore();
    const createdAt = '2026-07-03T00:00:00.000Z';
    await storeModule.updateStore((store) => {
      store.settings.battlemetrics ||= {};
      store.settings.battlemetrics.apiKey = 'bm_sqlite_refresh_key';
      store.squads.push({
        id: 'squad_sqlite_bm_refresh',
        name: 'SQLite BM Squad',
        tag: 'SBM',
        leaderUserId: 'user_sqlite_bm_leader',
        leaderUserIds: ['user_sqlite_bm_leader'],
        archivedAt: '',
        createdAt,
        updatedAt: createdAt
      });
      store.members.unshift({
        id: 'member_sqlite_bm_refresh',
        steamId: '76561198000002005',
        rawInput: '76561198000002005',
        customName: 'SQLite BM Refresh',
        steamNickname: 'SQLite BM Refresh',
        avatar: '',
        discordId: '',
        wechatId: '',
        wechatUserId: '',
        notes: '',
        specialty: [],
        memberStatus: 'active',
        squadId: 'squad_sqlite_bm_refresh',
        battlemetricsId: '',
        invitedByUserId: '',
        createdAt,
        updatedAt: createdAt
      });
      store.members.push({
        id: 'member_sqlite_bm_existing_owner',
        steamId: '76561198000002006',
        rawInput: '76561198000002006',
        customName: 'SQLite BM Existing Owner',
        steamNickname: 'SQLite BM Existing Owner',
        avatar: '',
        discordId: '',
        wechatId: '',
        wechatUserId: '',
        notes: '',
        specialty: [],
        memberStatus: 'active',
        squadId: '',
        battlemetricsId: 'bm_sqlite_existing_owner',
        invitedByUserId: '',
        createdAt,
        updatedAt: createdAt
      });
      store.squadMembers.push({
        id: 'squad_member_sqlite_bm_refresh',
        squadId: 'squad_sqlite_bm_refresh',
        memberId: 'member_sqlite_bm_refresh',
        joinedAt: createdAt
      });
      store.memberProfiles.push({
        id: 'member_profile_sqlite_bm_refresh',
        memberId: 'member_sqlite_bm_refresh',
        steamId: '76561198000002005',
        profileUrl: 'https://steamcommunity.com/profiles/76561198000002005',
        battlemetricsPlayerId: 'old_bm_refresh',
        battlemetricsServerId: 'old_server',
        battlemetricsServerName: 'Old Server',
        battlemetricsWipeId: 'old_wipe',
        battlemetricsTotalPlayTimeSeconds: 3600,
        fetchedAt: createdAt,
        source: 'test'
      });
      store.memberProfiles.push({
        id: 'member_profile_sqlite_bm_existing_owner',
        memberId: 'member_sqlite_bm_existing_owner',
        steamId: '76561198000002006',
        profileUrl: 'https://steamcommunity.com/profiles/76561198000002006',
        battlemetricsPlayerId: 'bm_sqlite_existing_profile_owner',
        fetchedAt: createdAt,
        source: 'test'
      });
    });

    const app = express();
    app.use('/api', apiModule.createApiRouter());
    server = createServer(app);
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const baseUrl = `http://127.0.0.1:${server.address().port}/api`;
    const sessionId = await authModule.createSession('user_root');
    const cookie = `nb_session=${encodeURIComponent(sessionId)}`;

    const beforeStatus = await storeModule.storeRuntimeStatus({ sqliteSummary: false });
    const beforeStat = await stat(storeModule.STORE_FILE);
    const queryCount = (status, name) => status.sqlite?.queries?.byName?.[name]?.total || 0;
    const writeCount = (status, name) => status.sqlite?.writes?.byName?.[name]?.total || 0;
    const beforeReadStoreFull = queryCount(beforeStatus, 'read_store_full');
    const beforeListLogs = queryCount(beforeStatus, 'list_logs');
    const beforeBroadOperationRunStatusReads = queryCount(beforeStatus, 'list_operationRuns_status');
    const beforeTargetOperationRunReads = queryCount(beforeStatus, 'list_operationRuns_targetId_status_type_platform');
    const beforeScopedProfiles = queryCount(beforeStatus, 'list_memberProfiles_memberId');
    const fullReadNames = [
      'list_users',
      'list_members',
      'list_squads',
      'list_squadMembers',
      'list_wipes',
      'list_memberProfiles'
    ];
    const scopedReadNames = [
      'list_members_id',
      'list_squadMembers_memberId',
      'list_squads_id',
      'list_wipes_status',
      'list_members_battlemetricsId_present',
      'list_memberProfiles_battlemetricsPlayerId_present'
    ];
    const beforeFullReads = Object.fromEntries(fullReadNames.map((name) => [name, queryCount(beforeStatus, name)]));
    const beforeScopedReads = Object.fromEntries(scopedReadNames.map((name) => [name, queryCount(beforeStatus, name)]));
    const battlemetricsRequests = [];
    let releaseBattlemetricsMatch = () => {};
    const battlemetricsMatchGate = new Promise((resolve) => {
      releaseBattlemetricsMatch = resolve;
    });
    let holdBattlemetricsMatch = true;
    let battlemetricsMatchPlayerId = 'bm_sqlite_refresh_player';
    let battlemetricsMatchPlayerName = 'SQLite BM Refresh';
    globalThis.fetch = async (url, options = {}) => {
      const href = String(url);
      if (!href.startsWith('https://api.battlemetrics.com')) {
        return originalFetch(url, options);
      }
      battlemetricsRequests.push({ href, body: options.body ? JSON.parse(options.body) : null });
      if (href.endsWith('/players/match')) {
        if (holdBattlemetricsMatch) await battlemetricsMatchGate;
        return new Response(JSON.stringify({
          data: [{
            type: 'identifier',
            id: 'sqlite_refresh_identifier',
            attributes: { type: 'steamID', identifier: '76561198000002005' },
            relationships: { player: { data: { type: 'player', id: battlemetricsMatchPlayerId } } }
          }],
          included: [{
            type: 'player',
            id: battlemetricsMatchPlayerId,
            attributes: { name: battlemetricsMatchPlayerName }
          }]
        }), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      return new Response(JSON.stringify({ errors: [{ title: 'unexpected BattleMetrics URL' }] }), { status: 404, headers: { 'content-type': 'application/json' } });
    };

    const refreshResponse = await httpFetch(`${baseUrl}/members/member_sqlite_bm_refresh/battlemetrics-id/refresh`, {
      method: 'POST',
      headers: {
        cookie,
        'content-type': 'application/json'
      },
      body: JSON.stringify({})
    });
    const refreshPayload = await refreshResponse.json();
    assert.equal(refreshResponse.status, 200, JSON.stringify(refreshPayload));
    assert.equal(refreshPayload.queued, true);
    assert.equal(refreshPayload.operationRun.type, 'battlemetrics_id_refresh');

    const beforeReuseStatus = await storeModule.storeRuntimeStatus({ sqliteSummary: false });
    const reuseResponse = await httpFetch(`${baseUrl}/members/member_sqlite_bm_refresh/battlemetrics-id/refresh`, {
      method: 'POST',
      headers: {
        cookie,
        'content-type': 'application/json'
      },
      body: JSON.stringify({})
    });
    const reusePayload = await reuseResponse.json();
    assert.equal(reuseResponse.status, 200, JSON.stringify(reusePayload));
    assert.equal(reusePayload.reused, true);
    assert.equal(reusePayload.operationRun.id, refreshPayload.operationRun.id);
    const afterReuseStatus = await storeModule.storeRuntimeStatus({ sqliteSummary: false });
    assert.equal(queryCount(afterReuseStatus, 'list_operationRuns_status'), queryCount(beforeReuseStatus, 'list_operationRuns_status'));
    assert.equal(
      queryCount(afterReuseStatus, 'list_operationRuns_targetId_status_type_platform') >
        queryCount(beforeReuseStatus, 'list_operationRuns_targetId_status_type_platform'),
      true
    );
    assert.equal(writeCount(afterReuseStatus, 'operation_run_create'), writeCount(beforeReuseStatus, 'operation_run_create'));

    holdBattlemetricsMatch = false;
    releaseBattlemetricsMatch();
    await apiModule.drainBackgroundTaskQueuesForTests({ timeoutMs: 5000 });

    const afterStatus = await storeModule.storeRuntimeStatus({ sqliteSummary: false });
    const afterStat = await stat(storeModule.STORE_FILE);
    assert.equal(afterStat.mtimeMs, beforeStat.mtimeMs);
    assert.equal(afterStatus.metrics.sqliteWrites, beforeStatus.metrics.sqliteWrites);
    assert.equal(queryCount(afterStatus, 'read_store_full'), beforeReadStoreFull);
    assert.equal(queryCount(afterStatus, 'list_logs'), beforeListLogs);
    assert.equal(queryCount(afterStatus, 'list_operationRuns_status'), beforeBroadOperationRunStatusReads);
    assert.equal(queryCount(afterStatus, 'list_operationRuns_targetId_status_type_platform') > beforeTargetOperationRunReads, true);
    assert.equal(queryCount(afterStatus, 'list_memberProfiles_memberId') > beforeScopedProfiles, true);
    for (const name of fullReadNames) {
      assert.equal(queryCount(afterStatus, name), beforeFullReads[name], `${name} should not be read fully`);
    }
    for (const name of scopedReadNames) {
      assert.equal(queryCount(afterStatus, name) > beforeScopedReads[name], true, `${name} should use scoped reads`);
    }
    assert.equal(writeCount(afterStatus, 'battlemetrics_id_refresh'), writeCount(beforeStatus, 'battlemetrics_id_refresh') + 1);
    assert.equal(writeCount(afterStatus, 'battlemetrics_id_refresh_log_trim'), writeCount(beforeStatus, 'battlemetrics_id_refresh_log_trim'));

    const repositoryModule = await import('../server/storage/repository.js');
    const refreshedMember = await waitForSqliteRecord(
      repositoryModule,
      'members',
      'member_sqlite_bm_refresh',
      (record) => record.battlemetricsId === 'bm_sqlite_refresh_player',
      'BattleMetrics ID refresh member update'
    );
    assert.equal(refreshedMember.battlemetricsId, 'bm_sqlite_refresh_player');
    const profiles = await repositoryModule.getSqliteRecordsByJsonField('memberProfiles', 'memberId', ['member_sqlite_bm_refresh'], { limit: 0 });
    assert.equal(profiles.length, 1);
    assert.equal(profiles[0].battlemetricsPlayerId, 'bm_sqlite_refresh_player');
    assert.equal(profiles[0].source, 'battlemetrics_match');
    assert.equal(profiles[0].battlemetricsMatchConfidence, 'steam-match');
    assert.equal(profiles[0].battlemetricsServerId, '');
    assert.equal(profiles[0].battlemetricsTotalPlayTimeSeconds, 0);
    const logs = await repositoryModule.getSqliteCollection('logs', { limit: 0 });
    assert.equal(logs.some((log) => log.type === 'battlemetrics_id_refresh' && log.targetId === 'member_sqlite_bm_refresh'), true);

    const operationRun = await waitForSqliteRecord(
      repositoryModule,
      'operationRuns',
      refreshPayload.operationRun.id,
      (record) => record.status === 'succeeded',
      'BattleMetrics ID refresh operation run'
    );
    assert.equal(operationRun.metadata.battlemetricsId, 'bm_sqlite_refresh_player');
    assert.equal(battlemetricsRequests.filter((item) => item.href.endsWith('/players/match')).length, 1);
    assert.deepEqual(battlemetricsRequests[0].body.data.map((item) => item.attributes.identifier), ['76561198000002005']);

    battlemetricsMatchPlayerId = 'bm_sqlite_refresh_failed_player';
    battlemetricsMatchPlayerName = 'SQLite BM Failed Refresh';
    const beforeRefreshFailureStatus = await storeModule.storeRuntimeStatus({ sqliteSummary: false });
    const beforeRefreshFailureStat = await stat(storeModule.STORE_FILE);
    const beforeRefreshFailureLogs = await repositoryModule.getSqliteRecordsByJsonField('logs', 'targetId', ['member_sqlite_bm_refresh'], { limit: 0 });
    repositoryModule.injectSqliteStorePatchFailureForTests('battlemetrics_id_refresh', 1);
    const failedRefreshResponse = await httpFetch(`${baseUrl}/members/member_sqlite_bm_refresh/battlemetrics-id/refresh`, {
      method: 'POST',
      headers: {
        cookie,
        'content-type': 'application/json'
      },
      body: JSON.stringify({})
    });
    const failedRefreshPayload = await failedRefreshResponse.json();
    assert.equal(failedRefreshResponse.status, 200, JSON.stringify(failedRefreshPayload));
    assert.equal(failedRefreshPayload.queued, true);
    assert.equal(failedRefreshPayload.operationRun.type, 'battlemetrics_id_refresh');
    await apiModule.drainBackgroundTaskQueuesForTests({ timeoutMs: 5000 });

    const failedRefreshRun = await waitForSqliteRecord(
      repositoryModule,
      'operationRuns',
      failedRefreshPayload.operationRun.id,
      (record) => record.status === 'failed',
      'BattleMetrics ID refresh patch failure operation run'
    );
    assert.equal(failedRefreshRun.errorKey, 'battlemetrics_id_refresh_failed');
    assert.equal(failedRefreshRun.retryable, true);
    assert.match(failedRefreshRun.errorSummary, /BattleMetrics ID 刷新写入暂不可用/);
    const afterRefreshFailureStatus = await storeModule.storeRuntimeStatus({ sqliteSummary: false });
    const afterRefreshFailureStat = await stat(storeModule.STORE_FILE);
    const failedRefreshMember = await repositoryModule.getSqliteRecord('members', 'member_sqlite_bm_refresh');
    const failedRefreshProfiles = await repositoryModule.getSqliteRecordsByJsonField('memberProfiles', 'memberId', ['member_sqlite_bm_refresh'], { limit: 0 });
    const failedRefreshLogs = await repositoryModule.getSqliteRecordsByJsonField('logs', 'targetId', ['member_sqlite_bm_refresh'], { limit: 0 });
    assert.equal(failedRefreshMember.battlemetricsId, 'bm_sqlite_refresh_player');
    assert.equal(failedRefreshProfiles.length, 1);
    assert.equal(failedRefreshProfiles[0].battlemetricsPlayerId, 'bm_sqlite_refresh_player');
    assert.equal(failedRefreshLogs.some((log) => log.type === 'battlemetrics_id_refresh' && log.metadata?.battlemetricsId === 'bm_sqlite_refresh_failed_player'), false);
    assert.equal(
      failedRefreshLogs.filter((log) => log.type === 'battlemetrics_playtime_sync').length,
      beforeRefreshFailureLogs.filter((log) => log.type === 'battlemetrics_playtime_sync').length
    );
    assert.equal(afterRefreshFailureStat.mtimeMs, beforeRefreshFailureStat.mtimeMs);
    assert.equal(afterRefreshFailureStatus.metrics.writes.total, beforeRefreshFailureStatus.metrics.writes.total);
    assert.equal(afterRefreshFailureStatus.metrics.sqliteWrites, beforeRefreshFailureStatus.metrics.sqliteWrites);
    assert.equal(queryCount(afterRefreshFailureStatus, 'read_store_full'), queryCount(beforeRefreshFailureStatus, 'read_store_full'));
    assert.equal(writeCount(afterRefreshFailureStatus, 'battlemetrics_id_refresh'), writeCount(beforeRefreshFailureStatus, 'battlemetrics_id_refresh'));
    assert.equal(battlemetricsRequests.filter((item) => item.href.endsWith('/players/match')).length, 2);

    const traceModule = await import('../server/trace-record-persistence.js');
    traceModule.resetTraceRecordPersistenceForTests();
    process.env.NB_TRACE_RECORD_DIRECT_RETRY_ATTEMPTS = '0';
    process.env.NB_TRACE_RECORD_GENERIC_FALLBACK_MAX_PER_WINDOW = '0';
    repositoryModule.injectSqliteStorePatchFailureForTests('operation_run_create', 1);
    const suppressedRefreshResponse = await httpFetch(`${baseUrl}/members/member_sqlite_bm_refresh/battlemetrics-id/refresh`, {
      method: 'POST',
      headers: {
        cookie,
        'content-type': 'application/json'
      },
      body: JSON.stringify({})
    });
    const suppressedRefreshPayload = await suppressedRefreshResponse.json();
    assert.equal(suppressedRefreshResponse.status, 503, JSON.stringify(suppressedRefreshPayload));
    assert.equal(suppressedRefreshPayload.ok, false);
    assert.match(suppressedRefreshPayload.error, /操作记录暂时无法写入/);
    assert.equal(
      traceModule.traceRecordPersistenceSnapshot().records.some((item) => (
        item.name === 'operation_run_create' &&
        item.fallbackSuppressed === 1
      )),
      true
    );
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

test('sqlite-primary member BattleMetrics ID manual edit uses direct SQLite patch writes', async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'nb-clan-sqlite-bm-edit-'));
  const previousEnv = {
    NB_DATA_DIR: process.env.NB_DATA_DIR,
    NB_ROOT_PASSWORD: process.env.NB_ROOT_PASSWORD,
    NB_STORAGE_MODE: process.env.NB_STORAGE_MODE,
    NB_SQLITE_FILE: process.env.NB_SQLITE_FILE,
    NB_DISABLE_BACKGROUND_JOBS: process.env.NB_DISABLE_BACKGROUND_JOBS,
    NB_DISABLE_EXTERNAL_VITAL: process.env.NB_DISABLE_EXTERNAL_VITAL
  };
  const originalFetch = globalThis.fetch;
  const httpFetch = originalFetch.bind(globalThis);
  process.env.NB_DATA_DIR = dataDir;
  process.env.NB_ROOT_PASSWORD = 'RootPass123!';
  process.env.NB_STORAGE_MODE = 'sqlite-primary';
  process.env.NB_SQLITE_FILE = path.join(dataDir, 'nb-clan.sqlite');
  process.env.NB_DISABLE_BACKGROUND_JOBS = '1';
  process.env.NB_DISABLE_EXTERNAL_VITAL = '1';

  let server = null;
  try {
    const storeModule = await uniqueImport('../server/store.js');
    const apiModule = await uniqueImport('../server/api.js');
    const authModule = await uniqueImport('../server/auth.js');
    await storeModule.ensureStore();
    const createdAt = '2026-07-03T00:00:00.000Z';
    await storeModule.updateStore((store) => {
      store.members.unshift({
        id: 'member_sqlite_bm_edit',
        steamId: '76561198000002006',
        rawInput: '76561198000002006',
        customName: 'SQLite BM Edit',
        steamNickname: 'SQLite BM Edit',
        avatar: '',
        discordId: '',
        wechatId: '',
        wechatUserId: '',
        notes: '',
        specialty: [],
        memberStatus: 'active',
        battlemetricsId: '',
        invitedByUserId: '',
        createdAt,
        updatedAt: createdAt
      });
    });

    const app = express();
    app.use('/api', apiModule.createApiRouter());
    server = createServer(app);
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const baseUrl = `http://127.0.0.1:${server.address().port}/api`;
    const sessionId = await authModule.createSession('user_root');
    const cookie = `nb_session=${encodeURIComponent(sessionId)}`;

    const beforeStatus = await storeModule.storeRuntimeStatus({ sqliteSummary: false });
    const beforeStat = await stat(storeModule.STORE_FILE);
    const queryCount = (status, name) => status.sqlite?.queries?.byName?.[name]?.total || 0;
    const writeCount = (status, name) => status.sqlite?.writes?.byName?.[name]?.total || 0;
    const beforeReadStoreFull = queryCount(beforeStatus, 'read_store_full');
    const beforeGetMembers = queryCount(beforeStatus, 'get_members');
    const beforeListMemberProfiles = queryCount(beforeStatus, 'list_memberProfiles');
    const beforeListLogs = queryCount(beforeStatus, 'list_logs');
    const beforeListWipeParticipants = queryCount(beforeStatus, 'list_wipeParticipants');
    const beforeScopedProfiles = queryCount(beforeStatus, 'list_memberProfiles_memberId');

    const editResponse = await httpFetch(`${baseUrl}/members/member_sqlite_bm_edit/battlemetrics-id`, {
      method: 'PUT',
      headers: {
        cookie,
        'content-type': 'application/json'
      },
      body: JSON.stringify({ battlemetricsId: 'bm_sqlite_manual_edit_player' })
    });
    const editPayload = await editResponse.json();
    assert.equal(editResponse.status, 200, JSON.stringify(editPayload));
    assert.equal(editPayload.member.battlemetricsId, 'bm_sqlite_manual_edit_player');

    await apiModule.drainBackgroundTaskQueuesForTests({ timeoutMs: 5000 });

    const afterStatus = await storeModule.storeRuntimeStatus({ sqliteSummary: false });
    const afterStat = await stat(storeModule.STORE_FILE);
    assert.equal(afterStat.mtimeMs, beforeStat.mtimeMs);
    assert.equal(afterStatus.metrics.sqliteWrites, beforeStatus.metrics.sqliteWrites);
    assert.equal(queryCount(afterStatus, 'read_store_full'), beforeReadStoreFull);
    assert.equal(queryCount(afterStatus, 'get_members') > beforeGetMembers, true);
    assert.equal(queryCount(afterStatus, 'list_memberProfiles'), beforeListMemberProfiles);
    assert.equal(queryCount(afterStatus, 'list_logs'), beforeListLogs);
    assert.equal(queryCount(afterStatus, 'list_wipeParticipants'), beforeListWipeParticipants);
    assert.equal(queryCount(afterStatus, 'list_memberProfiles_memberId') > beforeScopedProfiles, true);
    assert.equal(writeCount(afterStatus, 'battlemetrics_id_edit'), writeCount(beforeStatus, 'battlemetrics_id_edit') + 1);
    assert.equal(writeCount(afterStatus, 'battlemetrics_id_edit_log_trim'), writeCount(beforeStatus, 'battlemetrics_id_edit_log_trim'));

    const repositoryModule = await import('../server/storage/repository.js');
    const editedMember = await repositoryModule.getSqliteRecord('members', 'member_sqlite_bm_edit');
    assert.equal(editedMember.battlemetricsId, 'bm_sqlite_manual_edit_player');
    const profiles = await repositoryModule.getSqliteRecordsByJsonField('memberProfiles', 'memberId', ['member_sqlite_bm_edit'], { limit: 0 });
    assert.equal(profiles.length, 1);
    assert.equal(profiles[0].battlemetricsPlayerId, 'bm_sqlite_manual_edit_player');
    assert.equal(profiles[0].source, 'manual');
    assert.equal(profiles[0].battlemetricsMatchConfidence, 'manual');
    const logs = await repositoryModule.getSqliteCollection('logs', { limit: 0 });
    assert.equal(logs.some((log) => log.type === 'battlemetrics_id_edit' && log.targetId === 'member_sqlite_bm_edit'), true);

    const beforeFailureStatus = await storeModule.storeRuntimeStatus({ sqliteSummary: false });
    const beforeFailureStat = await stat(storeModule.STORE_FILE);
    repositoryModule.injectSqliteStorePatchFailureForTests('battlemetrics_id_edit', 1);
    const failedEditResponse = await httpFetch(`${baseUrl}/members/member_sqlite_bm_edit/battlemetrics-id`, {
      method: 'PUT',
      headers: {
        cookie,
        'content-type': 'application/json'
      },
      body: JSON.stringify({ battlemetricsId: 'bm_sqlite_failed_manual_edit' })
    });
    assert.equal(failedEditResponse.status, 503);
    const failedEditPayload = await failedEditResponse.json();
    assert.equal(failedEditPayload.ok, false);
    assert.match(failedEditPayload.error, /BattleMetrics ID 写入暂不可用/);
    const afterFailureStatus = await storeModule.storeRuntimeStatus({ sqliteSummary: false });
    const afterFailureStat = await stat(storeModule.STORE_FILE);
    const failedEditMember = await repositoryModule.getSqliteRecord('members', 'member_sqlite_bm_edit');
    const failedEditProfiles = await repositoryModule.getSqliteRecordsByJsonField('memberProfiles', 'memberId', ['member_sqlite_bm_edit'], { limit: 0 });
    assert.equal(failedEditMember.battlemetricsId, 'bm_sqlite_manual_edit_player');
    assert.equal(failedEditProfiles.length, 1);
    assert.equal(failedEditProfiles[0].battlemetricsPlayerId, 'bm_sqlite_manual_edit_player');
    assert.equal(afterFailureStat.mtimeMs, beforeFailureStat.mtimeMs);
    assert.equal(afterFailureStatus.metrics.writes.total, beforeFailureStatus.metrics.writes.total);
    assert.equal(afterFailureStatus.metrics.sqliteWrites, beforeFailureStatus.metrics.sqliteWrites);
    assert.equal(queryCount(afterFailureStatus, 'read_store_full'), queryCount(beforeFailureStatus, 'read_store_full'));
    assert.equal(writeCount(afterFailureStatus, 'battlemetrics_id_edit'), writeCount(beforeFailureStatus, 'battlemetrics_id_edit'));
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

test('sqlite-primary BattleMetrics playtime sync persists sync job progress with scoped direct patch writes', async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'nb-clan-sqlite-bm-playtime-'));
  const previousEnv = {
    NB_DATA_DIR: process.env.NB_DATA_DIR,
    NB_ROOT_PASSWORD: process.env.NB_ROOT_PASSWORD,
    NB_STORAGE_MODE: process.env.NB_STORAGE_MODE,
    NB_SQLITE_FILE: process.env.NB_SQLITE_FILE,
    NB_DISABLE_BACKGROUND_JOBS: process.env.NB_DISABLE_BACKGROUND_JOBS,
    NB_DISABLE_EXTERNAL_VITAL: process.env.NB_DISABLE_EXTERNAL_VITAL
  };
  const originalFetch = globalThis.fetch;
  const httpFetch = originalFetch.bind(globalThis);
  process.env.NB_DATA_DIR = dataDir;
  process.env.NB_ROOT_PASSWORD = 'RootPass123!';
  process.env.NB_STORAGE_MODE = 'sqlite-primary';
  process.env.NB_SQLITE_FILE = path.join(dataDir, 'nb-clan.sqlite');
  process.env.NB_DISABLE_BACKGROUND_JOBS = '1';
  process.env.NB_DISABLE_EXTERNAL_VITAL = '1';

  let server = null;
  try {
    const storeModule = await uniqueImport('../server/store.js');
    const apiModule = await uniqueImport('../server/api.js');
    const authModule = await uniqueImport('../server/auth.js');
    await storeModule.ensureStore();
    const createdAt = '2026-07-03T00:00:00.000Z';
    const wipeId = 'wipe_sqlite_bm_playtime';
    await storeModule.updateStore((store) => {
      store.settings.battlemetrics ||= {};
      store.settings.battlemetrics.apiKey = 'bm_sqlite_playtime_key';
      store.wipes.unshift({
        id: wipeId,
        name: 'SQLite BM Playtime Wipe',
        serverName: 'SQLite BM Playtime Server',
        status: 'active',
        wipeMode: 'current',
        battlemetricsId: '36933209',
        startedAt: '2026-07-01T00:00:00.000Z',
        createdAt,
        updatedAt: createdAt
      });
      store.members.unshift({
        id: 'member_sqlite_bm_playtime',
        steamId: '76561198000002002',
        rawInput: '76561198000002002',
        customName: 'SQLite BM Playtime',
        steamNickname: 'SQLite BM Playtime',
        avatar: '',
        discordId: '',
        wechatId: '',
        wechatUserId: '',
        notes: '',
        specialty: [],
        memberStatus: 'active',
        battlemetricsId: '',
        invitedByUserId: '',
        createdAt,
        updatedAt: createdAt
      });
      store.members.unshift({
        id: 'member_sqlite_bm_playtime_not_participant',
        steamId: '76561198000002003',
        rawInput: '76561198000002003',
        customName: 'SQLite BM Playtime Non Participant',
        steamNickname: 'SQLite BM Playtime Non Participant',
        avatar: '',
        discordId: '',
        wechatId: '',
        wechatUserId: '',
        notes: '',
        specialty: [],
        memberStatus: 'active',
        battlemetricsId: '',
        invitedByUserId: '',
        createdAt,
        updatedAt: createdAt
      });
      store.wipeParticipants.push({
        id: 'participant_sqlite_bm_playtime',
        wipeId,
        memberId: 'member_sqlite_bm_playtime',
        status: 'on_time',
        squadId: '',
        note: '',
        source: 'test',
        createdAt,
        updatedAt: createdAt
      });
      store.kdaRows.push({
        id: 'kda_sqlite_bm_playtime',
        wipeId,
        memberId: 'member_sqlite_bm_playtime',
        steamId: '76561198000002002',
        kills: 0,
        deaths: 0,
        kda: 0,
        onlineTimeMinutes: 0,
        source: 'vital',
        syncedAt: createdAt
      });
    });

    const app = express();
    app.use('/api', apiModule.createApiRouter());
    server = createServer(app);
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const baseUrl = `http://127.0.0.1:${server.address().port}/api`;

    const sessionId = await authModule.createSession('user_root');
    const cookie = `nb_session=${encodeURIComponent(sessionId)}`;

    const queryCount = (status, name) => status.sqlite?.queries?.byName?.[name]?.total || 0;
    const memberStoreModule = await import('../server/member-store.js');
    const beforeAutoScopeStatus = await storeModule.storeRuntimeStatus({ sqliteSummary: false });
    const beforeAutoScopeFullMembers = queryCount(beforeAutoScopeStatus, 'list_members');
	    const beforeAutoScopeMembersById = queryCount(beforeAutoScopeStatus, 'list_members_id');
    const beforeAutoScopeFullProfiles = queryCount(beforeAutoScopeStatus, 'list_memberProfiles');
    const beforeAutoScopeProfilesByMember = queryCount(beforeAutoScopeStatus, 'list_memberProfiles_memberId');
    const beforeAutoScopeFullParticipants = queryCount(beforeAutoScopeStatus, 'list_wipeParticipants');
    const beforeAutoScopeParticipantsByWipe = queryCount(beforeAutoScopeStatus, 'list_wipeParticipants_wipeId');
    const beforeAutoScopeFullWipes = queryCount(beforeAutoScopeStatus, 'list_wipes');
    const beforeAutoScopeWipesByStatus = queryCount(beforeAutoScopeStatus, 'list_wipes_status');
    const autoScopeSnapshot = await memberStoreModule.readBattlemetricsSyncRequestStore({ activeBattlemetricsWipeOnly: true });
    assert.deepEqual(autoScopeSnapshot.members.map((member) => member.id), ['member_sqlite_bm_playtime']);
    assert.deepEqual(autoScopeSnapshot.wipeParticipants.map((participant) => participant.memberId), ['member_sqlite_bm_playtime']);
    assert.equal(autoScopeSnapshot.wipes[0]?.id, wipeId);
    const afterAutoScopeStatus = await storeModule.storeRuntimeStatus({ sqliteSummary: false });
    assert.equal(queryCount(afterAutoScopeStatus, 'list_members'), beforeAutoScopeFullMembers);
	    assert.equal(queryCount(afterAutoScopeStatus, 'list_members_id') > beforeAutoScopeMembersById, true);
    assert.equal(queryCount(afterAutoScopeStatus, 'list_memberProfiles'), beforeAutoScopeFullProfiles);
    assert.equal(queryCount(afterAutoScopeStatus, 'list_memberProfiles_memberId') > beforeAutoScopeProfilesByMember, true);
    assert.equal(queryCount(afterAutoScopeStatus, 'list_wipeParticipants'), beforeAutoScopeFullParticipants);
    assert.equal(queryCount(afterAutoScopeStatus, 'list_wipeParticipants_wipeId') > beforeAutoScopeParticipantsByWipe, true);
    assert.equal(queryCount(afterAutoScopeStatus, 'list_wipes'), beforeAutoScopeFullWipes);
    assert.equal(queryCount(afterAutoScopeStatus, 'list_wipes_status') > beforeAutoScopeWipesByStatus, true);

    const beforeWipeScopeStatus = await storeModule.storeRuntimeStatus({ sqliteSummary: false });
    const beforeWipeScopeFullMembers = queryCount(beforeWipeScopeStatus, 'list_members');
	    const beforeWipeScopeMembersById = queryCount(beforeWipeScopeStatus, 'list_members_id');
    const beforeWipeScopeFullProfiles = queryCount(beforeWipeScopeStatus, 'list_memberProfiles');
    const beforeWipeScopeProfilesByMember = queryCount(beforeWipeScopeStatus, 'list_memberProfiles_memberId');
    const beforeWipeScopeFullParticipants = queryCount(beforeWipeScopeStatus, 'list_wipeParticipants');
    const beforeWipeScopeParticipantsByWipe = queryCount(beforeWipeScopeStatus, 'list_wipeParticipants_wipeId');
    const beforeWipeScopeFullWipes = queryCount(beforeWipeScopeStatus, 'list_wipes');
	    const beforeWipeScopeWipesById = queryCount(beforeWipeScopeStatus, 'list_wipes_id');
    const wipeScopeSnapshot = await memberStoreModule.readBattlemetricsSyncRequestStore({
      battlemetricsWipePlaytimeOnly: true,
      requestedWipeId: wipeId
    });
    assert.deepEqual(wipeScopeSnapshot.members.map((member) => member.id), ['member_sqlite_bm_playtime']);
    assert.deepEqual(wipeScopeSnapshot.wipeParticipants.map((participant) => participant.memberId), ['member_sqlite_bm_playtime']);
    assert.equal(wipeScopeSnapshot.wipes[0]?.id, wipeId);
    const afterWipeScopeStatus = await storeModule.storeRuntimeStatus({ sqliteSummary: false });
    assert.equal(queryCount(afterWipeScopeStatus, 'list_members'), beforeWipeScopeFullMembers);
	    assert.equal(queryCount(afterWipeScopeStatus, 'list_members_id') > beforeWipeScopeMembersById, true);
    assert.equal(queryCount(afterWipeScopeStatus, 'list_memberProfiles'), beforeWipeScopeFullProfiles);
    assert.equal(queryCount(afterWipeScopeStatus, 'list_memberProfiles_memberId') > beforeWipeScopeProfilesByMember, true);
    assert.equal(queryCount(afterWipeScopeStatus, 'list_wipeParticipants'), beforeWipeScopeFullParticipants);
	    assert.equal(queryCount(afterWipeScopeStatus, 'list_wipeParticipants_wipeId') > beforeWipeScopeParticipantsByWipe, true);
	    assert.equal(queryCount(afterWipeScopeStatus, 'list_wipes'), beforeWipeScopeFullWipes);
		    assert.equal(queryCount(afterWipeScopeStatus, 'list_wipes_id') > beforeWipeScopeWipesById, true);

    const beforeProfileFallbackScopeStatus = await storeModule.storeRuntimeStatus({ sqliteSummary: false });
    const beforeProfileFallbackFullReads = {
      members: queryCount(beforeProfileFallbackScopeStatus, 'list_members'),
      memberProfiles: queryCount(beforeProfileFallbackScopeStatus, 'list_memberProfiles'),
      wipeParticipants: queryCount(beforeProfileFallbackScopeStatus, 'list_wipeParticipants'),
      wipes: queryCount(beforeProfileFallbackScopeStatus, 'list_wipes')
    };
    const beforeProfileFallbackScopedReads = {
      membersById: queryCount(beforeProfileFallbackScopeStatus, 'list_members_id'),
      profilesByMemberId: queryCount(beforeProfileFallbackScopeStatus, 'list_memberProfiles_memberId'),
      membersByBattlemetricsIdPresent: queryCount(beforeProfileFallbackScopeStatus, 'list_members_battlemetricsId_present'),
      profilesByBattlemetricsIdPresent: queryCount(beforeProfileFallbackScopeStatus, 'list_memberProfiles_battlemetricsPlayerId_present'),
      wipesByStatus: queryCount(beforeProfileFallbackScopeStatus, 'list_wipes_status')
    };
    const profileFallbackScopeSnapshot = await memberStoreModule.readBattlemetricsSyncRequestStore({
      memberIds: ['member_sqlite_bm_playtime'],
      includeWipeParticipants: false,
      includeBattlemetricsOwnerIndex: true,
      requestedWipeId: 'current',
      includeSyncJobs: false
    });
    assert.deepEqual(profileFallbackScopeSnapshot.members.map((member) => member.id), ['member_sqlite_bm_playtime']);
    assert.deepEqual(profileFallbackScopeSnapshot.wipeParticipants, []);
    assert.equal(profileFallbackScopeSnapshot.wipes[0]?.id, wipeId);
    const afterProfileFallbackScopeStatus = await storeModule.storeRuntimeStatus({ sqliteSummary: false });
    assert.equal(queryCount(afterProfileFallbackScopeStatus, 'list_members'), beforeProfileFallbackFullReads.members);
    assert.equal(queryCount(afterProfileFallbackScopeStatus, 'list_memberProfiles'), beforeProfileFallbackFullReads.memberProfiles);
    assert.equal(queryCount(afterProfileFallbackScopeStatus, 'list_wipeParticipants'), beforeProfileFallbackFullReads.wipeParticipants);
    assert.equal(queryCount(afterProfileFallbackScopeStatus, 'list_wipes'), beforeProfileFallbackFullReads.wipes);
    assert.equal(queryCount(afterProfileFallbackScopeStatus, 'list_members_id') > beforeProfileFallbackScopedReads.membersById, true);
    assert.equal(queryCount(afterProfileFallbackScopeStatus, 'list_memberProfiles_memberId') > beforeProfileFallbackScopedReads.profilesByMemberId, true);
    assert.equal(queryCount(afterProfileFallbackScopeStatus, 'list_members_battlemetricsId_present') > beforeProfileFallbackScopedReads.membersByBattlemetricsIdPresent, true);
    assert.equal(queryCount(afterProfileFallbackScopeStatus, 'list_memberProfiles_battlemetricsPlayerId_present') > beforeProfileFallbackScopedReads.profilesByBattlemetricsIdPresent, true);
    assert.equal(queryCount(afterProfileFallbackScopeStatus, 'list_wipes_status') > beforeProfileFallbackScopedReads.wipesByStatus, true);

	    const beforeStatusOnlyStatus = await storeModule.storeRuntimeStatus({ sqliteSummary: false });
    const beforeStatusOnlyFullMembers = queryCount(beforeStatusOnlyStatus, 'list_members');
    const beforeStatusOnlyFullProfiles = queryCount(beforeStatusOnlyStatus, 'list_memberProfiles');
    const beforeStatusOnlyFullParticipants = queryCount(beforeStatusOnlyStatus, 'list_wipeParticipants');
    const beforeStatusOnlyFullWipes = queryCount(beforeStatusOnlyStatus, 'list_wipes');
    const statusOnlySnapshot = await memberStoreModule.readBattlemetricsSyncRequestStore({
      battlemetricsStatusOnly: true
    });
    assert.deepEqual(statusOnlySnapshot.members, []);
    assert.deepEqual(statusOnlySnapshot.memberProfiles, []);
    assert.deepEqual(statusOnlySnapshot.wipes, []);
    assert.deepEqual(statusOnlySnapshot.wipeParticipants, []);
    assert.equal(statusOnlySnapshot.settings.battlemetrics.apiKey, 'bm_sqlite_playtime_key');
    const afterStatusOnlyStatus = await storeModule.storeRuntimeStatus({ sqliteSummary: false });
    assert.equal(queryCount(afterStatusOnlyStatus, 'list_members'), beforeStatusOnlyFullMembers);
    assert.equal(queryCount(afterStatusOnlyStatus, 'list_memberProfiles'), beforeStatusOnlyFullProfiles);
    assert.equal(queryCount(afterStatusOnlyStatus, 'list_wipeParticipants'), beforeStatusOnlyFullParticipants);
    assert.equal(queryCount(afterStatusOnlyStatus, 'list_wipes'), beforeStatusOnlyFullWipes);

    const beforeStatus = await storeModule.storeRuntimeStatus({ sqliteSummary: false });
    const beforeStat = await stat(storeModule.STORE_FILE);
    const beforeFullKdaRows = queryCount(beforeStatus, 'list_kdaRows');
    const beforeScopedKdaRows = queryCount(beforeStatus, 'list_kdaRows_wipeId');
    const beforeListLogs = queryCount(beforeStatus, 'list_logs');
    const startedAt = '2026-07-03T01:00:00.000Z';
    const stoppedAt = '2026-07-03T03:00:00.000Z';
    const battlemetricsRequests = [];
    globalThis.fetch = async (url, options = {}) => {
      const href = String(url);
      if (!href.startsWith('https://api.battlemetrics.com')) {
        return originalFetch(url, options);
      }
      battlemetricsRequests.push({ href, body: options.body ? JSON.parse(options.body) : null });
      if (href.endsWith('/players/match')) {
        return new Response(JSON.stringify({
          data: [{
            type: 'identifier',
            id: 'sqlite_playtime_identifier',
            attributes: { type: 'steamID', identifier: '76561198000002002' },
            relationships: { player: { data: { type: 'player', id: 'bm_sqlite_playtime_player' } } }
          }],
          included: [{
            type: 'player',
            id: 'bm_sqlite_playtime_player',
            attributes: { name: 'SQLite BM Playtime' }
          }]
        }), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      if (href.includes('/players/bm_sqlite_playtime_player/servers/36933209')) {
        return new Response(JSON.stringify({
          data: {
            type: 'playerServer',
            id: 'bm_sqlite_playtime_player-36933209',
            attributes: {
              firstSeen: startedAt,
              lastSeen: stoppedAt,
              timePlayed: 7200,
              online: false
            }
          }
        }), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      if (href.includes('/players/bm_sqlite_playtime_player/relationships/sessions')) {
        return new Response(JSON.stringify({
          data: [{
            type: 'session',
            id: 'sqlite_playtime_session',
            attributes: { start: startedAt, stop: stoppedAt, name: 'SQLite BM Playtime', firstTime: false }
          }],
          links: {}
        }), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      return new Response(JSON.stringify({ errors: [{ title: 'unexpected BattleMetrics URL' }] }), { status: 404, headers: { 'content-type': 'application/json' } });
    };

    const syncResponse = await httpFetch(`${baseUrl}/settings/battlemetrics/sync-playtime`, {
      method: 'POST',
      headers: {
        cookie,
        'content-type': 'application/json'
      },
      body: JSON.stringify({ memberIds: ['member_sqlite_bm_playtime'], wipeId })
    });
    assert.equal(syncResponse.status, 200);
    const syncPayload = await syncResponse.json();
    assert.equal(syncPayload.requested, 1);
    assert.equal(syncPayload.updated, 1);
    assert.equal(syncPayload.job.type, 'battlemetrics_playtime');
    assert.equal(syncPayload.job.status, 'completed');
    assert.equal(syncPayload.job.doneCount, 1);
    assert.equal(syncPayload.job.percent, 100);

    const repositoryModule = await import('../server/storage/repository.js');
    const syncJob = await repositoryModule.getSqliteRecord('syncJobs', syncPayload.job.id);
    assert.equal(syncJob.status, 'completed');
    assert.equal(syncJob.doneCount, 1);
    assert.equal(syncJob.failedCount, 0);
    assert.equal(syncJob.percent, 100);
    const syncState = await repositoryModule.getSqliteScalar('syncState');
    assert.equal(syncState.battlemetrics.status, 'complete');
    assert.equal(syncState.battlemetrics.completed, 1);
    const rows = await repositoryModule.getSqliteRecordsByJsonField('kdaRows', 'wipeId', [wipeId], { limit: 0 });
    const row = rows.find((item) => item.memberId === 'member_sqlite_bm_playtime');
    assert.equal(row.onlineTimeMinutes, 120);
    assert.equal(row.onlineSummary.battlemetricsPlayerId, 'bm_sqlite_playtime_player');
    const profiles = await repositoryModule.getSqliteRecordsByJsonField('memberProfiles', 'memberId', ['member_sqlite_bm_playtime'], { limit: 0 });
    assert.equal(profiles.length, 1);
    assert.equal(profiles[0].battlemetricsPlayerId, 'bm_sqlite_playtime_player');
    assert.equal(battlemetricsRequests.some((item) => item.href.endsWith('/players/match')), true);

    const afterStatus = await storeModule.storeRuntimeStatus({ sqliteSummary: false });
    const afterStat = await stat(storeModule.STORE_FILE);
    assert.equal(afterStat.mtimeMs, beforeStat.mtimeMs);
    assert.equal(afterStatus.metrics.sqliteWrites, beforeStatus.metrics.sqliteWrites);
    assert.equal(queryCount(afterStatus, 'list_kdaRows'), beforeFullKdaRows);
    assert.equal(queryCount(afterStatus, 'list_kdaRows_wipeId') > beforeScopedKdaRows, true);
    assert.equal(queryCount(afterStatus, 'list_logs'), beforeListLogs);

    const beforeAdminBackgroundRequests = battlemetricsRequests.length;
    const adminBackgroundResponse = await httpFetch(`${baseUrl}/wechat/admin/wipes/${wipeId}/sync-playtime?background=1`, {
      method: 'POST',
      headers: {
        cookie,
        'content-type': 'application/json'
      }
    });
    assert.equal(adminBackgroundResponse.status, 200);
    const adminBackgroundPayload = await adminBackgroundResponse.json();
    assert.equal(adminBackgroundPayload.queued, true);
    assert.equal(adminBackgroundPayload.requested, 1);
    assert.equal(adminBackgroundPayload.completed, 0);
    assert.equal(adminBackgroundPayload.job.type, 'battlemetrics_playtime');
    assert.equal(adminBackgroundPayload.job.status, 'queued');
    assert.equal(adminBackgroundPayload.syncState.status, 'queued');
    assert.equal(adminBackgroundPayload.syncState.requested, 1);
    assert.equal(adminBackgroundPayload.participants.length, 1);
    assert.equal(battlemetricsRequests.length, beforeAdminBackgroundRequests);

    const adminBackgroundJob = await repositoryModule.getSqliteRecord('syncJobs', adminBackgroundPayload.job.id);
    assert.equal(adminBackgroundJob.status, 'queued');
    assert.equal(adminBackgroundJob.metadata.runner, 'sync_center');
    assert.equal(adminBackgroundJob.metadata.statusKey, 'battlemetrics');
    const adminBackgroundSyncState = await repositoryModule.getSqliteScalar('syncState');
    assert.equal(adminBackgroundSyncState.battlemetrics.status, 'queued');
    const adminBackgroundLogs = await repositoryModule.getSqliteCollection('logs', { limit: 0 });
    assert.equal(adminBackgroundLogs.some((log) => (
      log.type === 'wechat_admin_playtime_sync' &&
      log.targetId === wipeId &&
      log.metadata?.syncJobId === adminBackgroundPayload.job.id &&
      log.metadata?.queued === true
    )), true);
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

test('sqlite-primary wechat latest KDA query uses scoped direct patch writes', async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'nb-clan-sqlite-wechat-latest-kda-'));
  const previousEnv = {
    NB_DATA_DIR: process.env.NB_DATA_DIR,
    NB_ROOT_PASSWORD: process.env.NB_ROOT_PASSWORD,
    NB_STORAGE_MODE: process.env.NB_STORAGE_MODE,
    NB_SQLITE_FILE: process.env.NB_SQLITE_FILE,
    NB_DISABLE_BACKGROUND_JOBS: process.env.NB_DISABLE_BACKGROUND_JOBS,
    NB_DISABLE_EXTERNAL_VITAL: process.env.NB_DISABLE_EXTERNAL_VITAL
  };
  const originalFetch = globalThis.fetch;
  const httpFetch = originalFetch.bind(globalThis);
  process.env.NB_DATA_DIR = dataDir;
  process.env.NB_ROOT_PASSWORD = 'RootPass123!';
  process.env.NB_STORAGE_MODE = 'sqlite-primary';
  process.env.NB_SQLITE_FILE = path.join(dataDir, 'nb-clan.sqlite');
  process.env.NB_DISABLE_BACKGROUND_JOBS = '1';
  process.env.NB_DISABLE_EXTERNAL_VITAL = '0';

  let server = null;
  try {
    const storeModule = await uniqueImport('../server/store.js');
    const apiModule = await uniqueImport('../server/api.js');
    await storeModule.ensureStore();
    const createdAt = '2026-07-03T00:00:00.000Z';
    const steamId = '76561198000002003';
    const memberId = 'member_sqlite_wechat_latest_kda';
    const wipeId = 'wipe_sqlite_wechat_latest_kda';
    const token = 'sqlite-wechat-latest-kda-token';
    const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
    await storeModule.updateStore((store) => {
      store.wipes.unshift({
        id: wipeId,
        name: 'SQLite WeChat Latest KDA Wipe',
        serverName: 'SQLite Latest Vital Server',
        status: 'active',
        wipeMode: 'current',
        startsAt: '2026-07-01T00:00:00.000Z',
        startedAt: '2026-07-01T00:00:00.000Z',
        vitalServerId: '23',
        vitalWipeId: 'vital-sqlite-latest',
        battlemetricsId: '',
        kdaUrl: '',
        createdAt,
        updatedAt: createdAt
      });
      store.members.unshift({
        id: memberId,
        steamId,
        rawInput: steamId,
        customName: 'SQLite WeChat Latest',
        steamNickname: 'SQLite WeChat Latest',
        avatar: '',
        discordId: '',
        wechatId: 'wechat_sqlite_latest_kda',
        wechatUserId: 'wechat_sqlite_latest_kda',
        notes: '',
        specialty: [],
        memberStatus: 'active',
        battlemetricsId: '',
        invitedByUserId: 'user_root',
        createdAt,
        updatedAt: createdAt
      });
      store.wipeParticipants.push({
        id: 'participant_sqlite_wechat_latest_kda',
        wipeId,
        memberId,
        status: 'on_time',
        squadId: '',
        note: '',
        source: 'test',
        createdAt,
        updatedAt: createdAt
      });
      store.wechatUsers.push({
        id: 'wechat_sqlite_latest_kda',
        openid: 'openid_sqlite_latest_kda',
        unionid: '',
        nickname: 'SQLite WeChat Latest',
        avatar: '',
        status: 'approved',
        role: 'member',
        memberId,
        createdAt,
        updatedAt: createdAt
      });
      store.wechatSessions.push({
        id: 'wechat_session_sqlite_latest_kda',
        tokenHash,
        wechatUserId: 'wechat_sqlite_latest_kda',
        createdAt,
        expiresAt: new Date(Date.now() + 86_400_000).toISOString()
      });
      store.kdaRows.push({
        id: 'kda_sqlite_wechat_latest_other',
        wipeId: 'wipe_sqlite_wechat_latest_other',
        memberId,
        steamId,
        kills: 1,
        deaths: 1,
        kda: 1,
        source: 'vital',
        syncedAt: createdAt
      });
      store.syncJobs.push({
        id: 'sync_job_sqlite_wechat_latest_active',
        type: 'kda',
        status: 'running',
        scope: 'kda',
        requestedCount: 1,
        doneCount: 0,
        failedCount: 0,
        percent: 0,
        createdAt,
        updatedAt: createdAt
      });
    });

    const app = express();
    app.use('/api', apiModule.createApiRouter());
    server = createServer(app);
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const baseUrl = `http://127.0.0.1:${server.address().port}/api`;

    const vitalRequests = [];
    globalThis.fetch = async (url, options = {}) => {
      const href = String(url);
      if (href === 'https://playerstatistics.vitalgamenetwork.com/players/overview') {
        const body = JSON.parse(String(options.body || '{}'));
        vitalRequests.push(body);
        assert.deepEqual(body.playerIds, [steamId]);
        assert.equal(body.serverId, 23);
        assert.equal(body.wipeId, 'vital-sqlite-latest');
        assert.equal(body.includes.includes('combat::kills'), true);
        return new Response(JSON.stringify({
          statusCode: 200,
          data: [{
            context: { userId: steamId, serverId: 23, wipeId: 'vital-sqlite-latest' },
            player: {
              name: 'SQLite Latest Vital',
              avatarMedium: 'https://example.com/sqlite-latest-vital.jpg'
            },
            statistics: {
              combat: { kills: '42', killsT3: '9', deaths: '6' },
              raiding: { rockets: '3', explosivesTimed: '1' },
              farming: { gathered: { 'sulfur.ore': '12000', 'metal.ore': '34000' } },
              building: { buildings: { wall: '8', foundation: '4' } }
            }
          }]
        }), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      throw new Error(`unexpected fetch ${href}`);
    };

    const beforeStatus = await storeModule.storeRuntimeStatus({ sqliteSummary: false });
    const beforeStat = await stat(storeModule.STORE_FILE);
    const queryCount = (status, name) => status.sqlite?.queries?.byName?.[name]?.total || 0;
    const beforeFullKdaRows = queryCount(beforeStatus, 'list_kdaRows');
    const beforeScopedKdaRows = queryCount(beforeStatus, 'list_kdaRows_memberId');
    const beforeListLogs = queryCount(beforeStatus, 'list_logs');
    const beforeSyncJobsByStatus = queryCount(beforeStatus, 'list_syncJobs_status');

    const queryResponse = await httpFetch(`${baseUrl}/wechat/query?q=${steamId}&latest=1`, {
      headers: { authorization: `Bearer ${token}` }
    });
    const queryPayload = await queryResponse.json();
    assert.equal(queryResponse.status, 200, JSON.stringify(queryPayload));
    assert.equal(queryPayload.ok, true);
    assert.equal(queryPayload.latestRefresh.ok, true);
    assert.equal(queryPayload.latestRefresh.realtime.kda.source, 'vital');
    assert.equal(queryPayload.latestRefresh.realtime.kda.imported, 1);
    assert.equal(queryPayload.member.steamId, steamId);

    const afterStatus = await storeModule.storeRuntimeStatus({ sqliteSummary: false });
    const afterStat = await stat(storeModule.STORE_FILE);
    assert.equal(afterStat.mtimeMs, beforeStat.mtimeMs);
    assert.equal(afterStatus.metrics.sqliteWrites, beforeStatus.metrics.sqliteWrites);
    assert.equal(queryCount(afterStatus, 'list_kdaRows'), beforeFullKdaRows);
    assert.equal(queryCount(afterStatus, 'list_kdaRows_memberId') > beforeScopedKdaRows, true);
    assert.equal(queryCount(afterStatus, 'list_logs'), beforeListLogs);
    assert.equal(queryCount(afterStatus, 'list_syncJobs_status'), beforeSyncJobsByStatus);
    assert.equal(vitalRequests.length, 1);

    const repositoryModule = await import('../server/storage/repository.js');
    const rows = await repositoryModule.getSqliteRecordsByJsonField('kdaRows', 'wipeId', [wipeId], { limit: 0 });
    const row = rows.find((item) => item.memberId === memberId);
    assert.equal(row.kills, 42);
    assert.equal(row.deaths, 6);
    assert.equal(row.t3Kills, 9);
    assert.equal(row.rockets, 3);
    assert.equal(row.sulfur, 12000);
    assert.equal(row.metalOre, 34000);
    assert.equal(row.building, 12);
    assert.equal(row.source, 'vital');
    const syncedMember = await repositoryModule.getSqliteRecord('members', memberId);
    assert.equal(syncedMember.steamNickname, 'SQLite WeChat Latest');
    assert.equal(syncedMember.avatar, 'https://example.com/sqlite-latest-vital.jpg');
    const syncState = await repositoryModule.getSqliteScalar('syncState');
    assert.equal(syncState.kda.source, 'vital');
    assert.equal(syncState.kda.imported, 1);
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

test('sqlite-primary member Steam profile refresh trims logs inside direct patch write', async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'nb-clan-sqlite-steam-profile-refresh-'));
  const previousEnv = {
    NB_DATA_DIR: process.env.NB_DATA_DIR,
    NB_ROOT_PASSWORD: process.env.NB_ROOT_PASSWORD,
    NB_STORAGE_MODE: process.env.NB_STORAGE_MODE,
    NB_SQLITE_FILE: process.env.NB_SQLITE_FILE,
    NB_DISABLE_BACKGROUND_JOBS: process.env.NB_DISABLE_BACKGROUND_JOBS,
    NB_DISABLE_EXTERNAL_VITAL: process.env.NB_DISABLE_EXTERNAL_VITAL,
    NB_STEAM_WEB_API_KEY: process.env.NB_STEAM_WEB_API_KEY,
    STEAM_WEB_API_KEY: process.env.STEAM_WEB_API_KEY,
    STEAM_API_KEY: process.env.STEAM_API_KEY,
    NB_STEAM_BROADCAST_REQUEST_INTERVAL_MS: process.env.NB_STEAM_BROADCAST_REQUEST_INTERVAL_MS
  };
  const originalFetch = globalThis.fetch;
  const httpFetch = originalFetch.bind(globalThis);
  process.env.NB_DATA_DIR = dataDir;
  process.env.NB_ROOT_PASSWORD = 'RootPass123!';
  process.env.NB_STORAGE_MODE = 'sqlite-primary';
  process.env.NB_SQLITE_FILE = path.join(dataDir, 'nb-clan.sqlite');
  process.env.NB_DISABLE_BACKGROUND_JOBS = '1';
  process.env.NB_DISABLE_EXTERNAL_VITAL = '1';
  process.env.NB_STEAM_WEB_API_KEY = '';
  process.env.STEAM_WEB_API_KEY = '';
  process.env.STEAM_API_KEY = '';
  process.env.NB_STEAM_BROADCAST_REQUEST_INTERVAL_MS = '0';

  let server = null;
  try {
    const storeModule = await uniqueImport('../server/store.js');
    const apiModule = await uniqueImport('../server/api.js');
    const authModule = await uniqueImport('../server/auth.js');
    await storeModule.ensureStore();
    const createdAt = '2026-07-03T00:00:00.000Z';
    const steamId = '76561198000002007';
    const memberId = 'member_sqlite_steam_profile_refresh';
	    await storeModule.updateStore((store) => {
	      store.members.unshift({
	        id: memberId,
        steamId,
        rawInput: steamId,
        customName: '',
        steamNickname: 'Before Steam Refresh',
        avatar: '',
        discordId: '',
        wechatId: '',
        wechatUserId: '',
        notes: '',
        specialty: [],
        memberStatus: 'active',
        battlemetricsId: '',
        invitedByUserId: 'user_root',
	        createdAt,
	        updatedAt: createdAt
	      });
	      store.squads.push({
	        id: 'squad_sqlite_steam_profile_refresh',
	        name: 'SQLite Steam Refresh Squad',
	        leaderUserId: 'user_root',
	        leaderUserIds: ['user_root'],
	        notes: '',
	        createdBy: 'root',
	        createdAt,
	        updatedAt: createdAt,
	        archivedAt: ''
	      });
	      store.squadMembers.push({
	        id: 'squad_member_sqlite_steam_profile_refresh',
	        squadId: 'squad_sqlite_steam_profile_refresh',
	        memberId,
	        createdAt,
	        updatedAt: createdAt
	      });
	    });

    const app = express();
    app.use('/api', apiModule.createApiRouter());
    server = createServer(app);
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const baseUrl = `http://127.0.0.1:${server.address().port}/api`;
    const sessionId = await authModule.createSession('user_root');
    const cookie = `nb_session=${encodeURIComponent(sessionId)}`;

    const profileFetches = [];
    globalThis.fetch = async (url, options = {}) => {
      const href = String(url);
      if (href === `https://steamcommunity.com/profiles/${steamId}?xml=1`) {
        profileFetches.push(href);
        return new Response([
          '<profile>',
          `<steamID64>${steamId}</steamID64>`,
          '<steamID>SQLite Steam Manual Refresh</steamID>',
          '<privacyState>public</privacyState>',
          '<visibilityState>3</visibilityState>',
          '<avatarFull>https://example.com/sqlite-steam-manual-refresh.jpg</avatarFull>',
          '</profile>'
        ].join(''), { status: 200, headers: { 'content-type': 'text/xml' } });
      }
      if (href === `https://steamcommunity.com/broadcast/getbroadcastmpd/?steamid=${steamId}`) {
        return new Response(JSON.stringify({ success: 0 }), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      return originalFetch(url, options);
    };

    const beforeStatus = await storeModule.storeRuntimeStatus({ sqliteSummary: false });
    const beforeStat = await stat(storeModule.STORE_FILE);
	    const queryCount = (status, name) => status.sqlite?.queries?.byName?.[name]?.total || 0;
	    const writeCount = (status, name) => status.sqlite?.writes?.byName?.[name]?.total || 0;
	    const beforeListLogs = queryCount(beforeStatus, 'list_logs');
	    const beforeFullSquads = queryCount(beforeStatus, 'list_squads');
	    const beforeScopedSquads = queryCount(beforeStatus, 'list_squads_id');
	    const beforeScopedSquadMembers = queryCount(beforeStatus, 'list_squadMembers_memberId');
	    const response = await httpFetch(`${baseUrl}/members/${memberId}/steam-profile/refresh`, {
	      method: 'POST',
	      headers: { cookie }
    });
    const payload = await response.json();
    assert.equal(response.status, 200, JSON.stringify(payload));
    assert.equal(payload.ok, true);

    const afterStatus = await storeModule.storeRuntimeStatus({ sqliteSummary: false });
    const afterStat = await stat(storeModule.STORE_FILE);
    assert.equal(afterStat.mtimeMs, beforeStat.mtimeMs);
	    assert.equal(afterStatus.metrics.sqliteWrites, beforeStatus.metrics.sqliteWrites);
	    assert.equal(queryCount(afterStatus, 'list_logs'), beforeListLogs);
	    assert.equal(queryCount(afterStatus, 'list_squads'), beforeFullSquads);
	    assert.equal(queryCount(afterStatus, 'list_squads_id') > beforeScopedSquads, true);
	    assert.equal(queryCount(afterStatus, 'list_squadMembers_memberId') > beforeScopedSquadMembers, true);
	    assert.equal(writeCount(afterStatus, 'member_steam_profile_refresh'), writeCount(beforeStatus, 'member_steam_profile_refresh') + 1);
    assert.equal(writeCount(afterStatus, 'member_steam_profile_refresh_log_trim'), writeCount(beforeStatus, 'member_steam_profile_refresh_log_trim'));
    assert.deepEqual(profileFetches, [`https://steamcommunity.com/profiles/${steamId}?xml=1`]);

    const repositoryModule = await import('../server/storage/repository.js');
    const refreshedMember = await repositoryModule.getSqliteRecord('members', memberId);
    assert.equal(refreshedMember.steamNickname, 'SQLite Steam Manual Refresh');
    const profiles = await repositoryModule.getSqliteRecordsByJsonField('memberProfiles', 'memberId', [memberId], { limit: 0 });
    assert.equal(profiles.length, 1);
    assert.equal(profiles[0].displayName, 'SQLite Steam Manual Refresh');
    const logs = await repositoryModule.getSqliteRecordsByJsonField('logs', 'targetId', [memberId], { limit: 0 });
    assert.equal(logs.some((log) => log.type === 'member_edit'), true);

    const beforeFailureStatus = await storeModule.storeRuntimeStatus({ sqliteSummary: false });
    const beforeFailureStat = await stat(storeModule.STORE_FILE);
    repositoryModule.injectSqliteStorePatchFailureForTests('member_steam_profile_refresh', 1);
    const failedRefreshResponse = await httpFetch(`${baseUrl}/members/${memberId}/steam-profile/refresh`, {
      method: 'POST',
      headers: { cookie }
    });
    assert.equal(failedRefreshResponse.status, 503);
    const failedRefreshPayload = await failedRefreshResponse.json();
    assert.equal(failedRefreshPayload.ok, false);
    assert.match(failedRefreshPayload.error, /Steam 资料刷新写入暂不可用/);
    const afterFailureStatus = await storeModule.storeRuntimeStatus({ sqliteSummary: false });
    const afterFailureStat = await stat(storeModule.STORE_FILE);
    const failedRefreshMember = await repositoryModule.getSqliteRecord('members', memberId);
    const failedRefreshProfiles = await repositoryModule.getSqliteRecordsByJsonField('memberProfiles', 'memberId', [memberId], { limit: 0 });
    assert.equal(failedRefreshMember.steamNickname, 'SQLite Steam Manual Refresh');
    assert.equal(failedRefreshProfiles.length, 1);
    assert.equal(failedRefreshProfiles[0].displayName, 'SQLite Steam Manual Refresh');
    assert.equal(afterFailureStat.mtimeMs, beforeFailureStat.mtimeMs);
    assert.equal(afterFailureStatus.metrics.writes.total, beforeFailureStatus.metrics.writes.total);
    assert.equal(afterFailureStatus.metrics.sqliteWrites, beforeFailureStatus.metrics.sqliteWrites);
    assert.equal(queryCount(afterFailureStatus, 'read_store_full'), queryCount(beforeFailureStatus, 'read_store_full'));
    assert.equal(writeCount(afterFailureStatus, 'member_steam_profile_refresh'), writeCount(beforeFailureStatus, 'member_steam_profile_refresh'));
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

test('sqlite-primary wechat profile refresh writes member profile without broad KDA reads', async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'nb-clan-sqlite-wechat-profile-refresh-'));
  const previousEnv = {
    NB_DATA_DIR: process.env.NB_DATA_DIR,
    NB_ROOT_PASSWORD: process.env.NB_ROOT_PASSWORD,
    NB_STORAGE_MODE: process.env.NB_STORAGE_MODE,
    NB_SQLITE_FILE: process.env.NB_SQLITE_FILE,
    NB_DISABLE_BACKGROUND_JOBS: process.env.NB_DISABLE_BACKGROUND_JOBS,
    NB_DISABLE_EXTERNAL_VITAL: process.env.NB_DISABLE_EXTERNAL_VITAL,
    NB_STEAM_WEB_API_KEY: process.env.NB_STEAM_WEB_API_KEY,
    STEAM_WEB_API_KEY: process.env.STEAM_WEB_API_KEY,
    STEAM_API_KEY: process.env.STEAM_API_KEY
  };
  const originalFetch = globalThis.fetch;
  const httpFetch = originalFetch.bind(globalThis);
  process.env.NB_DATA_DIR = dataDir;
  process.env.NB_ROOT_PASSWORD = 'RootPass123!';
  process.env.NB_STORAGE_MODE = 'sqlite-primary';
  process.env.NB_SQLITE_FILE = path.join(dataDir, 'nb-clan.sqlite');
  process.env.NB_DISABLE_BACKGROUND_JOBS = '1';
  process.env.NB_DISABLE_EXTERNAL_VITAL = '1';
  process.env.NB_STEAM_WEB_API_KEY = '';
  process.env.STEAM_WEB_API_KEY = '';
  process.env.STEAM_API_KEY = '';

  let server = null;
  try {
    const storeModule = await uniqueImport('../server/store.js');
    const apiModule = await uniqueImport('../server/api.js');
    await storeModule.ensureStore();
    const createdAt = '2026-07-03T00:00:00.000Z';
    const steamId = '76561198000002004';
    const memberId = 'member_sqlite_wechat_profile_refresh';
    const wipeId = 'wipe_sqlite_wechat_profile_refresh';
    const token = 'sqlite-wechat-profile-refresh-token';
    const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
    await storeModule.updateStore((store) => {
      store.wipes.unshift({
        id: wipeId,
        name: 'SQLite WeChat Profile Refresh Wipe',
        serverName: 'SQLite Profile Refresh Server',
        status: 'active',
        wipeMode: 'current',
        startsAt: '2099-07-01T00:00:00.000Z',
        startedAt: '2099-07-01T00:00:00.000Z',
        vitalServerId: '',
        vitalWipeId: '',
        battlemetricsId: '',
        createdAt,
        updatedAt: createdAt
      });
      store.members.unshift({
        id: memberId,
        steamId,
        rawInput: steamId,
        customName: '',
        steamNickname: '',
        avatar: '',
        discordId: '',
        wechatId: 'wechat_sqlite_profile_refresh',
        wechatUserId: 'wechat_sqlite_profile_refresh',
        notes: '',
        specialty: [],
        memberStatus: 'active',
        battlemetricsId: '',
        invitedByUserId: 'user_root',
        createdAt,
        updatedAt: createdAt
      });
      store.wipeParticipants.push({
        id: 'participant_sqlite_wechat_profile_refresh',
        wipeId,
        memberId,
        status: 'on_time',
        squadId: '',
        note: '',
        source: 'test',
        createdAt,
        updatedAt: createdAt
      });
      store.wechatUsers.push({
        id: 'wechat_sqlite_profile_refresh',
        openid: 'openid_sqlite_profile_refresh',
        unionid: '',
        nickname: 'SQLite Profile Refresh',
        avatar: '',
        status: 'approved',
        role: 'member',
        memberId,
        createdAt,
        updatedAt: createdAt
      });
      store.wechatSessions.push({
        id: 'wechat_session_sqlite_profile_refresh',
        tokenHash,
        wechatUserId: 'wechat_sqlite_profile_refresh',
        createdAt,
        expiresAt: new Date(Date.now() + 86_400_000).toISOString()
      });
      store.kdaRows.push({
        id: 'kda_sqlite_wechat_profile_other',
        wipeId: 'wipe_sqlite_wechat_profile_other',
        memberId,
        steamId,
        kills: 1,
        deaths: 1,
        kda: 1,
        source: 'vital',
        syncedAt: createdAt
      });
      store.syncJobs.push({
        id: 'sync_job_sqlite_wechat_profile_active',
        type: 'kda',
        status: 'running',
        scope: 'kda',
        requestedCount: 1,
        doneCount: 0,
        failedCount: 0,
        percent: 0,
        createdAt,
        updatedAt: createdAt
      });
    });

    const app = express();
    app.use('/api', apiModule.createApiRouter());
    server = createServer(app);
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const baseUrl = `http://127.0.0.1:${server.address().port}/api`;

    const profileFetches = [];
    let wechatProfileDisplayName = 'SQLite Refreshed Steam';
    let wechatProfileAvatar = 'https://example.com/sqlite-refreshed-steam.jpg';
    globalThis.fetch = async (url) => {
      const href = String(url);
      if (href === `https://steamcommunity.com/profiles/${steamId}?xml=1`) {
        profileFetches.push(href);
        return new Response([
          '<profile>',
          `<steamID64>${steamId}</steamID64>`,
          `<steamID>${wechatProfileDisplayName}</steamID>`,
          '<privacyState>public</privacyState>',
          '<visibilityState>3</visibilityState>',
          `<avatarFull>${wechatProfileAvatar}</avatarFull>`,
          '</profile>'
        ].join(''), { status: 200, headers: { 'content-type': 'text/xml' } });
      }
      throw new Error(`unexpected fetch ${href}`);
    };

    const beforeStatus = await storeModule.storeRuntimeStatus({ sqliteSummary: false });
    const beforeStat = await stat(storeModule.STORE_FILE);
    const queryCount = (status, name) => status.sqlite?.queries?.byName?.[name]?.total || 0;
    const writeCount = (status, name) => status.sqlite?.writes?.byName?.[name]?.total || 0;
    const beforeFullReads = {
      users: queryCount(beforeStatus, 'list_users'),
      members: queryCount(beforeStatus, 'list_members'),
      squads: queryCount(beforeStatus, 'list_squads'),
      squadMembers: queryCount(beforeStatus, 'list_squadMembers'),
      wipeParticipants: queryCount(beforeStatus, 'list_wipeParticipants'),
      kdaRows: queryCount(beforeStatus, 'list_kdaRows'),
      memberProfiles: queryCount(beforeStatus, 'list_memberProfiles')
    };
    const beforeScopedKdaRows = queryCount(beforeStatus, 'list_kdaRows_memberId');
    const beforeFullLogs = queryCount(beforeStatus, 'list_logs');

    const refreshResponse = await httpFetch(`${baseUrl}/wechat/profile/refresh`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}` }
    });
    const refreshPayload = await refreshResponse.json();
    assert.equal(refreshResponse.status, 200, JSON.stringify(refreshPayload));
    assert.equal(refreshPayload.ok, true);
    assert.equal(refreshPayload.refresh.background, true);
    assert.equal(refreshPayload.refresh.queued, true);
    assert.equal(refreshPayload.refresh.identity.ok, true);
    assert.equal(refreshPayload.refresh.identity.updated, true);
    assert.equal(refreshPayload.refresh.identity.steamNickname, 'SQLite Refreshed Steam');
    assert.equal(refreshPayload.profile.steamNickname, 'SQLite Refreshed Steam');
    await apiModule.drainBackgroundTaskQueuesForTests({ timeoutMs: 5000 });

    const afterStatus = await storeModule.storeRuntimeStatus({ sqliteSummary: false });
    const afterStat = await stat(storeModule.STORE_FILE);
    const queryDeltas = Object.fromEntries(Object.entries(afterStatus.sqlite?.queries?.byName || {})
      .map(([name, value]) => [name, (value.total || 0) - queryCount(beforeStatus, name)])
      .filter(([, delta]) => delta > 0));
    assert.equal(afterStat.mtimeMs, beforeStat.mtimeMs);
    assert.equal(afterStatus.metrics.sqliteWrites, beforeStatus.metrics.sqliteWrites);
    assert.equal(queryCount(afterStatus, 'list_users'), beforeFullReads.users, JSON.stringify(queryDeltas));
    assert.equal(queryCount(afterStatus, 'list_members'), beforeFullReads.members, JSON.stringify(queryDeltas));
    assert.equal(queryCount(afterStatus, 'list_squads'), beforeFullReads.squads, JSON.stringify(queryDeltas));
    assert.equal(queryCount(afterStatus, 'list_squadMembers'), beforeFullReads.squadMembers, JSON.stringify(queryDeltas));
    assert.equal(queryCount(afterStatus, 'list_wipeParticipants'), beforeFullReads.wipeParticipants, JSON.stringify(queryDeltas));
    assert.equal(queryCount(afterStatus, 'list_kdaRows'), beforeFullReads.kdaRows, JSON.stringify(queryDeltas));
    assert.equal(queryCount(afterStatus, 'list_memberProfiles'), beforeFullReads.memberProfiles, JSON.stringify(queryDeltas));
    assert.equal(queryCount(afterStatus, 'list_kdaRows_memberId') > beforeScopedKdaRows, true, JSON.stringify(queryDeltas));
    assert.equal(queryCount(afterStatus, 'list_logs'), beforeFullLogs);
    assert.equal(writeCount(afterStatus, 'wechat_steam_identity_refresh'), writeCount(beforeStatus, 'wechat_steam_identity_refresh') + 1);
    assert.equal(writeCount(afterStatus, 'wechat_profile_refresh'), writeCount(beforeStatus, 'wechat_profile_refresh') + 1);
    assert.equal(writeCount(afterStatus, 'wechat_profile_refresh_log_trim'), writeCount(beforeStatus, 'wechat_profile_refresh_log_trim'));
    assert.deepEqual(profileFetches, [`https://steamcommunity.com/profiles/${steamId}?xml=1`]);

    const repositoryModule = await import('../server/storage/repository.js');
    const refreshedMember = await repositoryModule.getSqliteRecord('members', memberId);
    assert.equal(refreshedMember.steamNickname, 'SQLite Refreshed Steam');
    assert.equal(refreshedMember.avatar, 'https://example.com/sqlite-refreshed-steam.jpg');
    const profiles = await repositoryModule.getSqliteRecordsByJsonField('memberProfiles', 'memberId', [memberId], { limit: 0 });
    assert.equal(profiles.length, 1);
    assert.equal(profiles[0].displayName, 'SQLite Refreshed Steam');
    assert.equal(profiles[0].profilePublic, true);
    const logs = await repositoryModule.getSqliteRecordsByJsonField('logs', 'targetId', [memberId], { limit: 0 });
    assert.equal(logs.filter((log) => log.type === 'wechat_profile_refresh').length, 1);

    wechatProfileDisplayName = 'SQLite Failed WeChat Refresh';
    wechatProfileAvatar = 'https://example.com/sqlite-failed-wechat-refresh.jpg';
    const beforeFailureStatus = await storeModule.storeRuntimeStatus({ sqliteSummary: false });
    const beforeFailureStat = await stat(storeModule.STORE_FILE);
    const beforeFailureMember = await repositoryModule.getSqliteRecord('members', memberId);
    const beforeFailureLogs = await repositoryModule.getSqliteRecordsByJsonField('logs', 'targetId', [memberId], { limit: 0 });
    repositoryModule.injectSqliteStorePatchFailureForTests('wechat_steam_identity_refresh', 1);
    repositoryModule.injectSqliteStorePatchFailureForTests('wechat_profile_refresh', 1);
    const failedRefreshResponse = await httpFetch(`${baseUrl}/wechat/profile/refresh`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}` }
    });
    const failedRefreshPayload = await failedRefreshResponse.json();
    assert.equal(failedRefreshResponse.status, 200, JSON.stringify(failedRefreshPayload));
    assert.equal(failedRefreshPayload.ok, true);
    assert.equal(failedRefreshPayload.refresh.background, true);
    assert.equal(failedRefreshPayload.refresh.queued, true);
    assert.equal(failedRefreshPayload.refresh.identity.ok, false);
    await apiModule.drainBackgroundTaskQueuesForTests({ timeoutMs: 5000 });

    const afterFailureStatus = await storeModule.storeRuntimeStatus({ sqliteSummary: false });
    const afterFailureStat = await stat(storeModule.STORE_FILE);
    const failedRefreshMember = await repositoryModule.getSqliteRecord('members', memberId);
    const failedRefreshProfiles = await repositoryModule.getSqliteRecordsByJsonField('memberProfiles', 'memberId', [memberId], { limit: 0 });
    const failedRefreshLogs = await repositoryModule.getSqliteRecordsByJsonField('logs', 'targetId', [memberId], { limit: 0 });
    assert.equal(failedRefreshMember.steamNickname, 'SQLite Refreshed Steam');
    assert.equal(failedRefreshMember.avatar, 'https://example.com/sqlite-refreshed-steam.jpg');
    assert.equal(failedRefreshMember.updatedAt, beforeFailureMember.updatedAt);
    assert.equal(failedRefreshProfiles.length, 1);
    assert.equal(failedRefreshProfiles[0].displayName, 'SQLite Refreshed Steam');
    assert.equal(failedRefreshProfiles[0].avatar, 'https://example.com/sqlite-refreshed-steam.jpg');
    assert.equal(failedRefreshLogs.length, beforeFailureLogs.length);
    assert.equal(failedRefreshLogs.some((log) => log.type === 'wechat_profile_refresh' && log.metadata?.steamNickname === 'SQLite Failed WeChat Refresh'), false);
    assert.equal(afterFailureStat.mtimeMs, beforeFailureStat.mtimeMs);
    assert.equal(afterFailureStatus.metrics.writes.total, beforeFailureStatus.metrics.writes.total);
    assert.equal(afterFailureStatus.metrics.sqliteWrites, beforeFailureStatus.metrics.sqliteWrites);
    assert.equal(queryCount(afterFailureStatus, 'read_store_full'), queryCount(beforeFailureStatus, 'read_store_full'));
    assert.equal(writeCount(afterFailureStatus, 'wechat_steam_identity_refresh'), writeCount(beforeFailureStatus, 'wechat_steam_identity_refresh'));
    assert.equal(writeCount(afterFailureStatus, 'wechat_profile_refresh'), writeCount(beforeFailureStatus, 'wechat_profile_refresh'));
    assert.deepEqual(profileFetches, [
      `https://steamcommunity.com/profiles/${steamId}?xml=1`,
      `https://steamcommunity.com/profiles/${steamId}?xml=1`,
      `https://steamcommunity.com/profiles/${steamId}?xml=1`
    ]);

    wechatProfileDisplayName = 'SQLite Background Audit Refresh';
    wechatProfileAvatar = 'https://example.com/sqlite-background-audit-refresh.jpg';
    const beforeBackgroundAuditLogs = await repositoryModule.getSqliteRecordsByJsonField('logs', 'targetId', [memberId], { limit: 0 });
    repositoryModule.injectSqliteStorePatchFailureForTests('wechat_steam_identity_refresh', 1);
    const retryResponse = await httpFetch(`${baseUrl}/wechat/profile/refresh`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}` }
    });
    const retryPayload = await retryResponse.json();
    assert.equal(retryResponse.status, 200, JSON.stringify(retryPayload));
    assert.equal(retryPayload.refresh.queued, true);
    assert.equal(retryPayload.refresh.alreadyRunning, false);
    assert.equal(retryPayload.refresh.identity.ok, false);
    await apiModule.drainBackgroundTaskQueuesForTests({ timeoutMs: 5000 });
    const retriedMember = await repositoryModule.getSqliteRecord('members', memberId);
    assert.equal(retriedMember.steamNickname, 'SQLite Background Audit Refresh');
    const backgroundAuditLogs = await repositoryModule.getSqliteRecordsByJsonField('logs', 'targetId', [memberId], { limit: 0 });
    assert.equal(backgroundAuditLogs.length, beforeBackgroundAuditLogs.length + 1);
    assert.equal(
      backgroundAuditLogs.filter((log) => (
        log.type === 'wechat_profile_refresh' &&
        log.metadata?.steamNickname === 'SQLite Background Audit Refresh'
      )).length,
      1
    );
    assert.deepEqual(profileFetches, [
      `https://steamcommunity.com/profiles/${steamId}?xml=1`,
      `https://steamcommunity.com/profiles/${steamId}?xml=1`,
      `https://steamcommunity.com/profiles/${steamId}?xml=1`,
      `https://steamcommunity.com/profiles/${steamId}?xml=1`,
      `https://steamcommunity.com/profiles/${steamId}?xml=1`
    ]);
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

test('sqlite-primary member Hexaytron manual refresh uses direct SQLite patch writes', async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'nb-clan-sqlite-hexaytron-manual-'));
  const previousEnv = {
    NB_DATA_DIR: process.env.NB_DATA_DIR,
    NB_ROOT_PASSWORD: process.env.NB_ROOT_PASSWORD,
    NB_STORAGE_MODE: process.env.NB_STORAGE_MODE,
    NB_SQLITE_FILE: process.env.NB_SQLITE_FILE,
    NB_DISABLE_BACKGROUND_JOBS: process.env.NB_DISABLE_BACKGROUND_JOBS,
    NB_DISABLE_EXTERNAL_VITAL: process.env.NB_DISABLE_EXTERNAL_VITAL,
    NB_DISCORD_API_BASE_URL: process.env.NB_DISCORD_API_BASE_URL,
    NB_DISCORD_SEND_INTERVAL_MS: process.env.NB_DISCORD_SEND_INTERVAL_MS,
    NB_HEXAYTRON_ENABLED: process.env.NB_HEXAYTRON_ENABLED,
    NB_HEXAYTRON_DISCORD_GUILD_ID: process.env.NB_HEXAYTRON_DISCORD_GUILD_ID,
    NB_HEXAYTRON_DISCORD_CHANNEL_ID: process.env.NB_HEXAYTRON_DISCORD_CHANNEL_ID,
    NB_HEXAYTRON_POLL_TIMEOUT_MS: process.env.NB_HEXAYTRON_POLL_TIMEOUT_MS,
    NB_HEXAYTRON_POLL_INTERVAL_MS: process.env.NB_HEXAYTRON_POLL_INTERVAL_MS
  };
  const originalFetch = globalThis.fetch;
  process.env.NB_DATA_DIR = dataDir;
  process.env.NB_ROOT_PASSWORD = 'RootPass123!';
  process.env.NB_STORAGE_MODE = 'sqlite-primary';
  process.env.NB_SQLITE_FILE = path.join(dataDir, 'nb-clan.sqlite');
  process.env.NB_DISABLE_BACKGROUND_JOBS = '1';
  process.env.NB_DISABLE_EXTERNAL_VITAL = '1';
  process.env.NB_DISCORD_SEND_INTERVAL_MS = '0';
  process.env.NB_HEXAYTRON_ENABLED = '1';
  process.env.NB_HEXAYTRON_DISCORD_GUILD_ID = '1153571748147634236';
  process.env.NB_HEXAYTRON_DISCORD_CHANNEL_ID = '1519338458072481936';
  process.env.NB_HEXAYTRON_POLL_TIMEOUT_MS = '1000';
  process.env.NB_HEXAYTRON_POLL_INTERVAL_MS = '10';

  let server = null;
  let discordServer = null;
  try {
    const discordPosts = [];
    const discordApp = express();
    discordApp.use(express.json());
    discordApp.post('/channels/:channelId/messages', (req, res) => {
      discordPosts.push({ channelId: req.params.channelId, body: req.body });
      res.json({
        id: '900000000000010001',
        channel_id: req.params.channelId,
        timestamp: new Date().toISOString()
      });
    });
    discordApp.get('/channels/:channelId/messages', (_req, res) => {
      res.json([{
        id: '900000000000010002',
        channel_id: '1519338458072481936',
        timestamp: new Date().toISOString(),
        author: { id: 'hexaytron_bot', username: 'Hexaytron', bot: true },
        embeds: [{
          title: 'Hexaytron player card',
          url: 'https://www.battlemetrics.com/players/1106296105',
          fields: [
            { name: 'Atlas', value: '341 Hours', inline: true },
            { name: 'Vital', value: '263 Hours', inline: true },
            { name: 'Rustinity', value: '0 Hours', inline: true },
            { name: 'Building', value: '21 Hours', inline: true },
            { name: 'Aimtrain', value: '950 Hours', inline: true },
            { name: 'Official', value: '1,499 Hours', inline: true },
            { name: 'First Seen', value: '2553 Days ago', inline: true },
            { name: 'Rust', value: '5441 Hours', inline: true }
          ]
        }]
      }]);
    });
    discordServer = createServer(discordApp);
    await new Promise((resolve) => discordServer.listen(0, '127.0.0.1', resolve));
    process.env.NB_DISCORD_API_BASE_URL = `http://127.0.0.1:${discordServer.address().port}`;

    const storeModule = await uniqueImport('../server/store.js');
    const apiModule = await uniqueImport('../server/api.js');
    const authModule = await uniqueImport('../server/auth.js');
    await storeModule.ensureStore();
    const createdAt = '2026-07-02T00:00:00.000Z';
    await storeModule.updateStore((store) => {
      store.settings.discord.botToken = 'discord_bot_token_sqlite_hexaytron_manual';
      store.members.push({
        id: 'member_sqlite_hexaytron_manual',
        steamId: '76561198876934017',
        rawInput: '76561198876934017',
        customName: 'SQLite Hex Manual',
        steamNickname: 'SQLite Hex Manual',
        avatar: '',
        battlemetricsId: 'existing_bm_should_remain',
        specialty: [],
        memberStatus: 'active',
        invitedByUserId: 'user_root',
        createdAt,
        updatedAt: createdAt
      });
    });

    const app = express();
    app.use('/api', apiModule.createApiRouter());
    server = createServer(app);
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const baseUrl = `http://127.0.0.1:${server.address().port}/api`;
    const sessionId = await authModule.createSession('user_root');
    const cookie = `nb_session=${encodeURIComponent(sessionId)}`;

    const repositoryModule = await import('../server/storage/repository.js');
    const queryCount = (status, name) => status.sqlite?.queries?.byName?.[name]?.total || 0;
    const writeCount = (status, name) => status.sqlite?.writes?.byName?.[name]?.total || 0;
    const beforeStatus = await storeModule.storeRuntimeStatus();
    const beforeFullRuntimeReads = {
      kdaRows: queryCount(beforeStatus, 'list_kdaRows'),
      wipeParticipants: queryCount(beforeStatus, 'list_wipeParticipants'),
      wipeSettlements: queryCount(beforeStatus, 'list_wipeSettlements')
    };
    const beforeStat = await stat(storeModule.STORE_FILE);
    const response = await originalFetch(`${baseUrl}/members/member_sqlite_hexaytron_manual/hexaytron/refresh`, {
      method: 'POST',
      headers: { cookie }
    });
    assert.equal(response.status, 200);
    const payload = await response.json();
    assert.equal(payload.member.id, 'member_sqlite_hexaytron_manual');
    assert.equal(payload.member.profileStats.hexaytron.battlemetricsId, '1106296105');
    assert.equal(payload.member.battlemetricsId, 'existing_bm_should_remain');
    assert.equal(discordPosts.length, 1);
    assert.equal(discordPosts[0].body.content, '/player identifier:76561198876934017');

    const profileRows = await repositoryModule.getSqliteRecordsByJsonField(
      'memberProfiles',
      'memberId',
      ['member_sqlite_hexaytron_manual'],
      { limit: 0 }
    );
    const memberRecord = await repositoryModule.getSqliteRecord('members', 'member_sqlite_hexaytron_manual');
    const logs = await repositoryModule.getSqliteCollection('logs', { limit: 0 });
    const afterStatus = await storeModule.storeRuntimeStatus();
    const afterStat = await stat(storeModule.STORE_FILE);
    assert.equal(profileRows.length, 1);
    assert.equal(profileRows[0].hexaytron.battlemetricsId, '1106296105');
    assert.equal(memberRecord.battlemetricsId, 'existing_bm_should_remain');
    assert.notEqual(memberRecord.updatedAt, createdAt);
    assert.equal(logs.some((log) => log.type === 'hexaytron_profile_refresh' && log.targetId === 'member_sqlite_hexaytron_manual'), true);
    assert.equal(afterStat.mtimeMs, beforeStat.mtimeMs);
    assert.equal(afterStatus.metrics.writes.total, beforeStatus.metrics.writes.total);
    assert.equal(afterStatus.metrics.sqliteWrites, beforeStatus.metrics.sqliteWrites);
    assert.equal(writeCount(afterStatus, 'hexaytron_profile_refresh'), writeCount(beforeStatus, 'hexaytron_profile_refresh') + 1);
    assert.equal(writeCount(afterStatus, 'hexaytron_profile_refresh_log_trim'), writeCount(beforeStatus, 'hexaytron_profile_refresh_log_trim'));
    assert.equal(queryCount(afterStatus, 'list_kdaRows'), beforeFullRuntimeReads.kdaRows);
    assert.equal(queryCount(afterStatus, 'list_wipeParticipants'), beforeFullRuntimeReads.wipeParticipants);
    assert.equal(queryCount(afterStatus, 'list_wipeSettlements'), beforeFullRuntimeReads.wipeSettlements);

    const beforeFailureStatus = await storeModule.storeRuntimeStatus();
    const beforeFailureStat = await stat(storeModule.STORE_FILE);
    repositoryModule.injectSqliteStorePatchFailureForTests('hexaytron_profile_refresh', 1);
    const failedResponse = await originalFetch(`${baseUrl}/members/member_sqlite_hexaytron_manual/hexaytron/refresh`, {
      method: 'POST',
      headers: { cookie }
    });
    assert.equal(failedResponse.status, 503);
    const failedPayload = await failedResponse.json();
    assert.equal(failedPayload.ok, false);
    assert.match(failedPayload.error, /Hexaytron 资料刷新写入暂不可用/);
    const afterFailureStatus = await storeModule.storeRuntimeStatus();
    const afterFailureStat = await stat(storeModule.STORE_FILE);
    const failedProfileRows = await repositoryModule.getSqliteRecordsByJsonField(
      'memberProfiles',
      'memberId',
      ['member_sqlite_hexaytron_manual'],
      { limit: 0 }
    );
    const failedMemberRecord = await repositoryModule.getSqliteRecord('members', 'member_sqlite_hexaytron_manual');
    assert.equal(failedProfileRows.length, 1);
    assert.equal(failedProfileRows[0].hexaytron.battlemetricsId, '1106296105');
    assert.equal(failedMemberRecord.updatedAt, memberRecord.updatedAt);
    assert.equal(failedMemberRecord.battlemetricsId, 'existing_bm_should_remain');
    assert.equal(afterFailureStat.mtimeMs, beforeFailureStat.mtimeMs);
    assert.equal(afterFailureStatus.metrics.writes.total, beforeFailureStatus.metrics.writes.total);
    assert.equal(afterFailureStatus.metrics.sqliteWrites, beforeFailureStatus.metrics.sqliteWrites);
    assert.equal(queryCount(afterFailureStatus, 'read_store_full'), queryCount(beforeFailureStatus, 'read_store_full'));
    assert.equal(writeCount(afterFailureStatus, 'hexaytron_profile_refresh'), writeCount(beforeFailureStatus, 'hexaytron_profile_refresh'));
  } finally {
    if (server) await new Promise((resolve) => server.close(resolve));
    if (discordServer) await new Promise((resolve) => discordServer.close(resolve));
    globalThis.fetch = originalFetch;
    const sqliteModule = await import('../server/storage/sqlite.js');
    await sqliteModule.closeSqliteDatabasesForTests();
    Object.assign(process.env, previousEnv);
    for (const [key, value] of Object.entries(previousEnv)) {
      if (value === undefined) delete process.env[key];
    }
    await rm(dataDir, { recursive: true, force: true });
  }
});

test('sqlite-primary Hexaytron profile sync uses direct SQLite patch writes', async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'nb-clan-sqlite-hexaytron-'));
  const previousEnv = {
    NB_DATA_DIR: process.env.NB_DATA_DIR,
    NB_ROOT_PASSWORD: process.env.NB_ROOT_PASSWORD,
    NB_STORAGE_MODE: process.env.NB_STORAGE_MODE,
    NB_SQLITE_FILE: process.env.NB_SQLITE_FILE,
    NB_DISABLE_BACKGROUND_JOBS: process.env.NB_DISABLE_BACKGROUND_JOBS,
    NB_DISABLE_EXTERNAL_VITAL: process.env.NB_DISABLE_EXTERNAL_VITAL,
    NB_DISCORD_API_BASE_URL: process.env.NB_DISCORD_API_BASE_URL,
    NB_DISCORD_SEND_INTERVAL_MS: process.env.NB_DISCORD_SEND_INTERVAL_MS,
    NB_HEXAYTRON_ENABLED: process.env.NB_HEXAYTRON_ENABLED,
    NB_HEXAYTRON_DISCORD_GUILD_ID: process.env.NB_HEXAYTRON_DISCORD_GUILD_ID,
    NB_HEXAYTRON_DISCORD_CHANNEL_ID: process.env.NB_HEXAYTRON_DISCORD_CHANNEL_ID,
    NB_HEXAYTRON_POLL_TIMEOUT_MS: process.env.NB_HEXAYTRON_POLL_TIMEOUT_MS,
    NB_HEXAYTRON_POLL_INTERVAL_MS: process.env.NB_HEXAYTRON_POLL_INTERVAL_MS,
    NB_HEXAYTRON_SYNC_INTERVAL_MS: process.env.NB_HEXAYTRON_SYNC_INTERVAL_MS
  };
  const originalFetch = globalThis.fetch;
  const httpFetch = originalFetch.bind(globalThis);
  process.env.NB_DATA_DIR = dataDir;
  process.env.NB_ROOT_PASSWORD = 'RootPass123!';
  process.env.NB_STORAGE_MODE = 'sqlite-primary';
  process.env.NB_SQLITE_FILE = path.join(dataDir, 'nb-clan.sqlite');
  process.env.NB_DISABLE_BACKGROUND_JOBS = '1';
  process.env.NB_DISABLE_EXTERNAL_VITAL = '1';
  process.env.NB_DISCORD_SEND_INTERVAL_MS = '0';
  process.env.NB_HEXAYTRON_ENABLED = '1';
  process.env.NB_HEXAYTRON_DISCORD_GUILD_ID = '1153571748147634236';
  process.env.NB_HEXAYTRON_DISCORD_CHANNEL_ID = '1519338458072481936';
  process.env.NB_HEXAYTRON_POLL_TIMEOUT_MS = '1000';
  process.env.NB_HEXAYTRON_POLL_INTERVAL_MS = '10';
  process.env.NB_HEXAYTRON_SYNC_INTERVAL_MS = '0';

  let server = null;
  let discordServer = null;
  try {
    const discordResponses = new Map();
    const discordPosts = [];
    let nextDiscordMessageId = 990000000000000001n;
    const nextDiscordId = () => {
      const id = String(nextDiscordMessageId);
      nextDiscordMessageId += 1n;
      return id;
    };
    const hexaytronMessageFor = (requestMessageId, command = '') => ({
      id: nextDiscordId(),
      channel_id: '1519338458072481936',
      timestamp: new Date().toISOString(),
      author: { id: 'hexaytron_bot', username: 'Hexaytron', bot: true },
      embeds: [{
        title: 'Hexaytron player card',
        url: 'https://www.battlemetrics.com/players/1106296105',
        fields: [
          { name: 'Atlas', value: '12 Hours', inline: true },
          { name: 'Vital', value: '263 Hours', inline: true },
          { name: 'Rustinity', value: '0 Hours', inline: true },
          { name: 'Building', value: '21 Hours', inline: true },
          { name: 'Aimtrain', value: '950 Hours', inline: true },
          { name: 'Official', value: '1,499 Hours', inline: true },
          { name: 'First Seen', value: '2553 Days ago', inline: true },
          { name: 'Rust', value: '5441 Hours', inline: true }
        ],
        footer: { text: command || requestMessageId }
      }]
    });
    const discordApp = express();
    discordApp.use(express.json());
    discordApp.post('/channels/:channelId/messages', (req, res) => {
      const messageId = nextDiscordId();
      discordPosts.push({
        channelId: req.params.channelId,
        authorization: req.get('authorization') || '',
        body: req.body
      });
      discordResponses.set(messageId, hexaytronMessageFor(messageId, req.body?.content || ''));
      res.json({
        id: messageId,
        channel_id: req.params.channelId,
        timestamp: new Date().toISOString()
      });
    });
    discordApp.get('/channels/:channelId/messages', (req, res) => {
      res.json(discordResponses.has(req.query.after) ? [discordResponses.get(req.query.after)] : []);
    });
    discordServer = createServer(discordApp);
    await new Promise((resolve) => discordServer.listen(0, '127.0.0.1', resolve));
    process.env.NB_DISCORD_API_BASE_URL = `http://127.0.0.1:${discordServer.address().port}`;

    const storeModule = await uniqueImport('../server/store.js');
    const apiModule = await uniqueImport('../server/api.js');
    await storeModule.ensureStore();
    const createdAt = '2026-06-22T00:00:00.000Z';
    await storeModule.updateStore((store) => {
      store.settings.discord ||= {};
      store.settings.discord.botToken = 'discord_bot_token_sqlite_hexaytron';
      store.members.unshift({
        id: 'member_sqlite_hexaytron',
        steamId: '76561198000002002',
        rawInput: '76561198000002002',
        customName: 'SQLite Hexaytron',
        steamNickname: 'SQLite Hexaytron',
        avatar: '',
        discordId: '',
        wechatId: '',
        wechatUserId: '',
        notes: '',
        specialty: [],
        memberStatus: 'active',
        battlemetricsId: 'existing_bm_should_stay',
        invitedByUserId: '',
        createdAt,
        updatedAt: createdAt
      });
    });

    const app = express();
    app.use('/api', apiModule.createApiRouter());
    server = createServer(app);
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const baseUrl = `http://127.0.0.1:${server.address().port}/api`;

    const loginResponse = await httpFetch(`${baseUrl}/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'root', password: 'RootPass123!' })
    });
    assert.equal(loginResponse.status, 200);
    const cookie = loginResponse.headers.get('set-cookie')?.split(';')[0] || '';
    assert.match(cookie, /^nb_session=/);

    const queryCount = (status, name) => status.sqlite?.queries?.byName?.[name]?.total || 0;
    const beforeStatus = await storeModule.storeRuntimeStatus();
    const beforeListMembers = queryCount(beforeStatus, 'list_members');
    const beforeListMemberProfiles = queryCount(beforeStatus, 'list_memberProfiles');
    const beforeGetMembers = queryCount(beforeStatus, 'get_members');
    const beforeMembersById = queryCount(beforeStatus, 'list_members_id');
    const beforeMemberProfilesByMemberId = queryCount(beforeStatus, 'list_memberProfiles_memberId');
    const beforeStat = await stat(storeModule.STORE_FILE);
    const syncResponse = await httpFetch(`${baseUrl}/sync/jobs/hexaytron-profile`, {
      method: 'POST',
      headers: {
        cookie,
        'content-type': 'application/json'
      },
      body: JSON.stringify({ memberIds: ['member_sqlite_hexaytron'] })
    });
    assert.equal(syncResponse.status, 200);
    const syncPayload = await syncResponse.json();
    assert.equal(syncPayload.ok, true);
    assert.equal(syncPayload.job.type, 'hexaytron_profile');
    const afterRouteStatus = await storeModule.storeRuntimeStatus({ sqliteSummary: false });
    assert.equal(queryCount(afterRouteStatus, 'get_members'), beforeGetMembers);
    assert.equal(queryCount(afterRouteStatus, 'list_members_id') > beforeMembersById, true);

    const repositoryModule = await import('../server/storage/repository.js');
    const syncJob = await waitForSqliteRecord(
      repositoryModule,
      'syncJobs',
      syncPayload.job.id,
      (record) => record.status === 'completed',
      'Hexaytron profile sync job completion'
    );
    assert.equal(syncJob.doneCount, 1);
    assert.equal(syncJob.failedCount, 0);
    const syncedMember = await repositoryModule.getSqliteRecord('members', 'member_sqlite_hexaytron');
    assert.equal(syncedMember.battlemetricsId, 'existing_bm_should_stay');
    const profiles = await repositoryModule.getSqliteRecordsByJsonField('memberProfiles', 'memberId', ['member_sqlite_hexaytron'], { limit: 0 });
    assert.equal(profiles.length, 1);
    assert.equal(profiles[0].hexaytron.battlemetricsId, '1106296105');
    assert.equal(profiles[0].hexaytron.servers.find((item) => item.key === 'atlas').hours, 12);
    assert.equal(profiles[0].hexaytron.rustHours, 5441);
    const syncState = await repositoryModule.getSqliteScalar('syncState');
    assert.equal(syncState.hexaytronProfiles.status, 'complete');
    assert.equal(syncState.hexaytronProfiles.updated, 1);
    assert.equal(syncState.hexaytronProfiles.failed, 0);
    assert.equal(discordPosts.length, 1);
    assert.equal(discordPosts[0].authorization, 'Bot discord_bot_token_sqlite_hexaytron');
    assert.equal(discordPosts[0].body.content, '/player identifier:76561198000002002');

    const afterStatus = await storeModule.storeRuntimeStatus();
    const afterStat = await stat(storeModule.STORE_FILE);
    assert.equal(queryCount(afterStatus, 'list_members'), beforeListMembers);
    assert.equal(queryCount(afterStatus, 'list_memberProfiles'), beforeListMemberProfiles);
    assert.equal(queryCount(afterStatus, 'get_members') > beforeGetMembers, true);
    assert.equal(queryCount(afterStatus, 'list_members_id') > beforeMembersById, true);
    assert.equal(queryCount(afterStatus, 'list_memberProfiles_memberId') > beforeMemberProfilesByMemberId, true);
    assert.equal(afterStat.mtimeMs, beforeStat.mtimeMs);
    assert.equal(
      afterStatus.sqlite.compatibility.syncStoreChangesToSqlite,
      beforeStatus.sqlite.compatibility.syncStoreChangesToSqlite
    );
    assert.equal(afterStatus.metrics.sqliteWrites, beforeStatus.metrics.sqliteWrites);
  } finally {
    globalThis.fetch = originalFetch;
    if (server) await new Promise((resolve) => server.close(resolve));
    if (discordServer) await new Promise((resolve) => discordServer.close(resolve));
    const sqliteModule = await import('../server/storage/sqlite.js');
    await sqliteModule.closeSqliteDatabasesForTests();
    Object.assign(process.env, previousEnv);
    for (const [key, value] of Object.entries(previousEnv)) {
      if (value === undefined) delete process.env[key];
    }
    await rm(dataDir, { recursive: true, force: true });
  }
});

test('sqlite-primary kda sync and wipe close use direct SQLite collection writes', async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'nb-clan-sqlite-kda-'));
  const previousEnv = {
    NB_DATA_DIR: process.env.NB_DATA_DIR,
    NB_ROOT_PASSWORD: process.env.NB_ROOT_PASSWORD,
    NB_STORAGE_MODE: process.env.NB_STORAGE_MODE,
    NB_SQLITE_FILE: process.env.NB_SQLITE_FILE,
    NB_DISABLE_EXTERNAL_VITAL: process.env.NB_DISABLE_EXTERNAL_VITAL,
    NB_RUSTPLUS_RELAY_CHAT_FLUSH_INTERVAL_MS: process.env.NB_RUSTPLUS_RELAY_CHAT_FLUSH_INTERVAL_MS
  };
  const originalFetch = globalThis.fetch;
  const httpFetch = originalFetch.bind(globalThis);
  process.env.NB_DATA_DIR = dataDir;
  process.env.NB_ROOT_PASSWORD = 'RootPass123!';
  process.env.NB_STORAGE_MODE = 'sqlite-primary';
  process.env.NB_SQLITE_FILE = path.join(dataDir, 'nb-clan.sqlite');
  process.env.NB_DISABLE_EXTERNAL_VITAL = '1';
  process.env.NB_RUSTPLUS_RELAY_CHAT_FLUSH_INTERVAL_MS = '0';

  let server = null;
  try {
    const storeModule = await uniqueImport('../server/store.js');
    const apiModule = await uniqueImport('../server/api.js');
    const authModule = await uniqueImport('../server/auth.js');
    await storeModule.ensureStore();
    const createdAt = '2026-06-22T00:00:00.000Z';
    await storeModule.updateStore((store) => {
      store.wipes.unshift({
        id: 'wipe_sqlite_kda',
        name: 'SQLite KDA Wipe',
        serverName: 'SQLite KDA Server',
        status: 'active',
        startedAt: createdAt,
        closedAt: '',
        vitalServerId: 'server_sqlite_kda',
        vitalWipeId: 'wipe_sqlite_kda_vital',
        battlemetricsId: '',
        kdaUrl: '',
        createdAt,
        updatedAt: createdAt
      }, {
        id: 'wipe_sqlite_other',
        name: 'SQLite Other Wipe',
        serverName: 'SQLite Other Server',
        status: 'closed',
        startedAt: createdAt,
        closedAt: createdAt,
        vitalServerId: 'server_sqlite_other',
        vitalWipeId: 'wipe_sqlite_other_vital',
        battlemetricsId: '',
        kdaUrl: '',
        kdaMemberScope: 'all_members',
        createdAt,
        updatedAt: createdAt
      });
      store.members.unshift({
        id: 'member_sqlite_other',
        steamId: '76561198000001001',
        rawInput: '76561198000001001',
        customName: '',
        steamNickname: 'SQLite Other Member',
        avatar: '',
        discordId: '',
        wechatId: '',
        wechatUserId: '',
        notes: '',
        specialty: [],
        memberStatus: 'active',
        invitedByUserId: '',
        createdAt,
        updatedAt: createdAt
      });
      store.settings.wechat ||= {};
      store.settings.wechat.subscriptionTemplates = {
        ...(store.settings.wechat.subscriptionTemplates || {}),
        wipeOpen: 'sqlite_tmpl_wipe_open_lifecycle'
      };
      store.wechatUsers.push({
        id: 'wechat_user_sqlite_wipe_lifecycle',
        openid: 'openid_sqlite_wipe_lifecycle',
        unionid: '',
        nickname: 'SQLite Wipe Lifecycle',
        avatarUrl: '',
        phone: '',
        wechatId: '',
        discordId: '',
        region: '',
        timeZone: '',
        status: 'member',
        role: 'member',
        memberId: 'member_sqlite_other',
        subscriptionPreferences: {},
        createdAt,
        updatedAt: createdAt,
        lastLoginAt: createdAt
      });
      store.kdaRows.push({
        id: 'kda_row_sqlite_other',
        wipeId: 'wipe_sqlite_other',
        memberId: 'member_sqlite_other',
        steamId: '76561198000001001',
        kills: 12,
        deaths: 3,
        capturedAt: createdAt,
        syncedAt: createdAt
      });
      store.kdaSnapshots.push({
        id: 'kda_snapshot_sqlite_other_midrange',
        wipeId: 'wipe_sqlite_other',
        memberId: 'member_sqlite_other',
        steamId: '76561198000001001',
        kills: 18,
        deaths: 2,
        capturedAt: '2026-06-22T03:00:00.000Z',
        syncedAt: '2026-06-22T03:00:00.000Z'
      });
      store.wipeParticipants.push({
        id: 'participant_sqlite_import',
        wipeId: 'wipe_sqlite_kda',
        memberId: 'member_sqlite_other',
        squadId: '',
        status: 'on_time',
        createdAt,
        updatedAt: createdAt
      });
    });
    const app = express();
    app.use('/api', apiModule.createApiRouter());
    server = createServer(app);
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const baseUrl = `http://127.0.0.1:${server.address().port}/api`;

    const loginResponse = await httpFetch(`${baseUrl}/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'root', password: 'RootPass123!' })
    });
    assert.equal(loginResponse.status, 200);
    const cookie = loginResponse.headers.get('set-cookie')?.split(';')[0] || '';
    assert.match(cookie, /^nb_session=/);
	    const beforeSyncStatus = await storeModule.storeRuntimeStatus();
	    const queryCount = (status, name) => status.sqlite?.queries?.byName?.[name]?.total || 0;
	    const beforeKdaListSyncJobs = queryCount(beforeSyncStatus, 'list_syncJobs');
	    const beforeKdaSyncJobsByStatus = queryCount(beforeSyncStatus, 'list_syncJobs_status');
	    const beforeKdaGetSyncJobs = queryCount(beforeSyncStatus, 'get_syncJobs');
	    const beforeSyncStoreStat = await stat(storeModule.STORE_FILE);

    const syncResponse = await httpFetch(`${baseUrl}/kda/sync`, {
      method: 'POST',
      headers: {
        cookie,
        'content-type': 'application/json'
      },
      body: JSON.stringify({ wipeId: 'wipe_sqlite_kda' })
    });
    assert.equal(syncResponse.status, 200);
    const syncPayload = await syncResponse.json();
    assert.equal(syncPayload.ok, true);
    assert.equal(syncPayload.requested, 1);
    assert.equal(syncPayload.completed, 1);
    assert.equal(syncPayload.job.status, 'completed');

    const repositoryModule = await import('../server/storage/repository.js');
    const syncState = await repositoryModule.getSqliteScalar('syncState');
    const refreshedWipe = await repositoryModule.getSqliteRecord('wipes', 'wipe_sqlite_kda');
    const logs = await repositoryModule.getSqliteCollection('logs', { limit: 0 });
    const status = await storeModule.storeRuntimeStatus();
    const afterSyncStoreStat = await stat(storeModule.STORE_FILE);
    assert.equal(syncState.kda.status, 'complete');
    assert.equal(syncState.kda.requested, 1);
    assert.match(refreshedWipe.kdaUrl, /vitalServerId=server_sqlite_kda/);
    assert.match(refreshedWipe.kdaUrl, /vitalWipeId=wipe_sqlite_kda_vital/);
    assert.equal(logs.some((log) => log.type === 'wipe_vital_metadata_refresh' && log.targetId === 'wipe_sqlite_kda'), true);
    assert.equal(afterSyncStoreStat.mtimeMs, beforeSyncStoreStat.mtimeMs);
    assert.equal(status.sqlite.records.logs >= (beforeSyncStatus.sqlite.records.logs || 0) + 1, true);
    assert.equal(queryCount(status, 'list_syncJobs'), beforeKdaListSyncJobs);
    assert.equal(queryCount(status, 'list_syncJobs_status') > beforeKdaSyncJobsByStatus, true);
    assert.equal(queryCount(status, 'get_syncJobs') > beforeKdaGetSyncJobs, true);
	    assert.equal(
	      status.sqlite.compatibility.syncStoreChangesToSqlite,
	      beforeSyncStatus.sqlite.compatibility.syncStoreChangesToSqlite
	    );
	    assert.equal(status.metrics.sqliteWrites, beforeSyncStatus.metrics.sqliteWrites);

    const beforeMetadataLookupFailureStatus = await storeModule.storeRuntimeStatus();
    const beforeMetadataLookupFailureReadStoreFull = queryCount(beforeMetadataLookupFailureStatus, 'read_store_full');
    repositoryModule.injectSqliteQueryFailureForTests('get_wipes', 1);
    const lookupFailureChanged = await apiModule.refreshStartedWipeVitalMetadataIfNeeded('wipe_sqlite_kda');
    const afterMetadataLookupFailureStatus = await storeModule.storeRuntimeStatus();
    assert.equal(lookupFailureChanged, false);
    assert.equal(queryCount(afterMetadataLookupFailureStatus, 'read_store_full'), beforeMetadataLookupFailureReadStoreFull);

    const metadataPatchFailureSeed = await repositoryModule.getSqliteRecord('wipes', 'wipe_sqlite_kda');
    await repositoryModule.writeSqliteStorePatch({
      reason: 'sqlite_test_wipe_vital_metadata_patch_failure_seed',
      upserts: {
        wipes: [{
          ...metadataPatchFailureSeed,
          kdaUrl: '',
          updatedAt: createdAt
        }]
      }
    });
    const beforeMetadataPatchFailureStatus = await storeModule.storeRuntimeStatus();
    const beforeMetadataPatchFailureReadStoreFull = queryCount(beforeMetadataPatchFailureStatus, 'read_store_full');
    repositoryModule.injectSqliteStorePatchFailureForTests('wipe_vital_metadata_refresh', 1);
    const patchFailureChanged = await apiModule.refreshStartedWipeVitalMetadataIfNeeded('wipe_sqlite_kda');
    const metadataPatchFailureWipe = await repositoryModule.getSqliteRecord('wipes', 'wipe_sqlite_kda');
    const afterMetadataPatchFailureStatus = await storeModule.storeRuntimeStatus();
    assert.equal(patchFailureChanged, false);
    assert.equal(metadataPatchFailureWipe.kdaUrl, '');
    assert.equal(queryCount(afterMetadataPatchFailureStatus, 'read_store_full'), beforeMetadataPatchFailureReadStoreFull);

	    await repositoryModule.writeSqliteStorePatch({
	      reason: 'sqlite_test_current_wipe_scope_seed',
	      upserts: {
	        squads: [{
	          id: 'squad_sqlite_current_wipe_scope',
	          name: 'SQLite Current Wipe Scope',
	          leaderUserIds: [],
	          archivedAt: '',
	          createdAt,
	          updatedAt: createdAt
	        }],
	        squadMembers: [{
	          id: 'squad_member_sqlite_current_wipe_scope',
	          squadId: 'squad_sqlite_current_wipe_scope',
	          memberId: 'member_sqlite_other',
	          addedByUserId: 'user_root',
	          createdAt
	        }],
	        wipeParticipants: [{
	          id: 'participant_sqlite_import',
	          wipeId: 'wipe_sqlite_kda',
	          memberId: 'member_sqlite_other',
	          squadId: 'squad_sqlite_current_wipe_scope',
	          status: 'on_time',
	          createdAt,
	          updatedAt: createdAt
	        }]
	      }
	    });
	    const beforeCurrentRouteRefreshStatus = await storeModule.storeRuntimeStatus();
	    const beforeCurrentRouteRefreshReadStoreFull = queryCount(beforeCurrentRouteRefreshStatus, 'read_store_full');
	    const beforeCurrentRouteRefreshStat = await stat(storeModule.STORE_FILE);
	    const currentRouteRefreshResponse = await httpFetch(`${baseUrl}/wipes/current`, {
	      headers: { cookie }
	    });
	    assert.equal(currentRouteRefreshResponse.status, 200);
	    const currentRouteRefreshPayload = await currentRouteRefreshResponse.json();
	    assert.equal(currentRouteRefreshPayload.ok, true);
	    assert.equal(currentRouteRefreshPayload.wipe.id, 'wipe_sqlite_kda');
	    assert.match(currentRouteRefreshPayload.wipe.kdaUrl, /vitalWipeId=wipe_sqlite_kda_vital/);
	    const currentRouteRefreshedWipe = await repositoryModule.getSqliteRecord('wipes', 'wipe_sqlite_kda');
	    const afterCurrentRouteRefreshStatus = await storeModule.storeRuntimeStatus();
	    const afterCurrentRouteRefreshStat = await stat(storeModule.STORE_FILE);
	    assert.match(currentRouteRefreshedWipe.kdaUrl, /vitalServerId=server_sqlite_kda/);
	    assert.match(currentRouteRefreshedWipe.kdaUrl, /vitalWipeId=wipe_sqlite_kda_vital/);
	    assert.equal(afterCurrentRouteRefreshStat.mtimeMs, beforeCurrentRouteRefreshStat.mtimeMs);
	    assert.equal(afterCurrentRouteRefreshStatus.metrics.writes.total, beforeCurrentRouteRefreshStatus.metrics.writes.total);
	    assert.equal(afterCurrentRouteRefreshStatus.metrics.sqliteWrites, beforeCurrentRouteRefreshStatus.metrics.sqliteWrites);
	    assert.equal(queryCount(afterCurrentRouteRefreshStatus, 'read_store_full'), beforeCurrentRouteRefreshReadStoreFull);
	    const beforeCurrentWipeStatus = await storeModule.storeRuntimeStatus();
	    const beforeCurrentWipeFullReads = {
	      users: queryCount(beforeCurrentWipeStatus, 'list_users'),
	      members: queryCount(beforeCurrentWipeStatus, 'list_members'),
	      squads: queryCount(beforeCurrentWipeStatus, 'list_squads'),
	      squadMembers: queryCount(beforeCurrentWipeStatus, 'list_squadMembers'),
	      wipes: queryCount(beforeCurrentWipeStatus, 'list_wipes'),
	      wipeParticipants: queryCount(beforeCurrentWipeStatus, 'list_wipeParticipants'),
	      uploads: queryCount(beforeCurrentWipeStatus, 'list_uploads'),
	      wipeSettlements: queryCount(beforeCurrentWipeStatus, 'list_wipeSettlements')
	    };
	    const beforeCurrentWipeScopedReads = {
	      wipesByStatus: queryCount(beforeCurrentWipeStatus, 'list_wipes_status'),
	      membersById: queryCount(beforeCurrentWipeStatus, 'list_members_id'),
	      squadMembersByMemberId: queryCount(beforeCurrentWipeStatus, 'list_squadMembers_memberId'),
	      squadsById: queryCount(beforeCurrentWipeStatus, 'list_squads_id'),
	      wipeParticipantsByWipeId: queryCount(beforeCurrentWipeStatus, 'list_wipeParticipants_wipeId'),
	      uploadsByOwnerId: queryCount(beforeCurrentWipeStatus, 'list_uploads_ownerId'),
	      wipeSettlementsByWipeId: queryCount(beforeCurrentWipeStatus, 'list_wipeSettlements_wipeId')
	    };
	    const beforeCurrentWipeStat = await stat(storeModule.STORE_FILE);
	    const currentWipeResponse = await httpFetch(`${baseUrl}/wipes/current`, {
	      headers: { cookie }
	    });
	    assert.equal(currentWipeResponse.status, 200);
	    const currentWipePayload = await currentWipeResponse.json();
	    assert.equal(currentWipePayload.ok, true);
	    assert.equal(currentWipePayload.wipe.id, 'wipe_sqlite_kda');
	    const afterCurrentWipeStatus = await storeModule.storeRuntimeStatus();
	    const afterCurrentWipeStat = await stat(storeModule.STORE_FILE);
	    assert.equal(afterCurrentWipeStat.mtimeMs, beforeCurrentWipeStat.mtimeMs);
	    assert.equal(afterCurrentWipeStatus.metrics.writes.total, beforeCurrentWipeStatus.metrics.writes.total);
	    assert.equal(afterCurrentWipeStatus.metrics.sqliteWrites, beforeCurrentWipeStatus.metrics.sqliteWrites);
	    assert.equal(queryCount(afterCurrentWipeStatus, 'list_users'), beforeCurrentWipeFullReads.users);
	    assert.equal(queryCount(afterCurrentWipeStatus, 'list_members'), beforeCurrentWipeFullReads.members);
	    assert.equal(queryCount(afterCurrentWipeStatus, 'list_squads'), beforeCurrentWipeFullReads.squads);
	    assert.equal(queryCount(afterCurrentWipeStatus, 'list_squadMembers'), beforeCurrentWipeFullReads.squadMembers);
	    assert.equal(queryCount(afterCurrentWipeStatus, 'list_wipes'), beforeCurrentWipeFullReads.wipes);
	    assert.equal(queryCount(afterCurrentWipeStatus, 'list_wipeParticipants'), beforeCurrentWipeFullReads.wipeParticipants);
	    assert.equal(queryCount(afterCurrentWipeStatus, 'list_uploads'), beforeCurrentWipeFullReads.uploads);
	    assert.equal(queryCount(afterCurrentWipeStatus, 'list_wipeSettlements'), beforeCurrentWipeFullReads.wipeSettlements);
	    assert.equal(queryCount(afterCurrentWipeStatus, 'list_wipes_status') > beforeCurrentWipeScopedReads.wipesByStatus, true);
	    assert.equal(queryCount(afterCurrentWipeStatus, 'list_members_id') > beforeCurrentWipeScopedReads.membersById, true);
	    assert.equal(queryCount(afterCurrentWipeStatus, 'list_squadMembers_memberId') > beforeCurrentWipeScopedReads.squadMembersByMemberId, true);
	    assert.equal(queryCount(afterCurrentWipeStatus, 'list_squads_id') > beforeCurrentWipeScopedReads.squadsById, true);
	    assert.equal(queryCount(afterCurrentWipeStatus, 'list_wipeParticipants_wipeId') > beforeCurrentWipeScopedReads.wipeParticipantsByWipeId, true);
	    assert.equal(queryCount(afterCurrentWipeStatus, 'list_uploads_ownerId') > beforeCurrentWipeScopedReads.uploadsByOwnerId, true);
	    assert.equal(queryCount(afterCurrentWipeStatus, 'list_wipeSettlements_wipeId') > beforeCurrentWipeScopedReads.wipeSettlementsByWipeId, true);

	    const beforeWipeListStatus = await storeModule.storeRuntimeStatus();
	    const beforeWipeListUnusedFullReads = {
	      users: queryCount(beforeWipeListStatus, 'list_users'),
	      members: queryCount(beforeWipeListStatus, 'list_members'),
	      squadMembers: queryCount(beforeWipeListStatus, 'list_squadMembers'),
	      uploads: queryCount(beforeWipeListStatus, 'list_uploads')
	    };
	    const beforeWipeListRequiredReads = {
	      wipes: queryCount(beforeWipeListStatus, 'list_wipes'),
	      wipeParticipants: queryCount(beforeWipeListStatus, 'list_wipeParticipants'),
	      wipeSettlements: queryCount(beforeWipeListStatus, 'list_wipeSettlements'),
	      permissionRoles: queryCount(beforeWipeListStatus, 'list_permissionRoles')
	    };
	    const beforeWipeListStat = await stat(storeModule.STORE_FILE);
	    const wipeListResponse = await httpFetch(`${baseUrl}/wipes`, {
	      headers: { cookie }
	    });
	    assert.equal(wipeListResponse.status, 200);
	    const wipeListPayload = await wipeListResponse.json();
	    assert.equal(wipeListPayload.ok, true);
	    const listedCurrentWipe = wipeListPayload.wipes.find((wipe) => wipe.id === 'wipe_sqlite_kda');
	    assert.equal(Boolean(listedCurrentWipe), true);
	    assert.equal(listedCurrentWipe.status, 'active');
	    assert.equal(typeof listedCurrentWipe.participantCount, 'number');
	    const afterWipeListStatus = await storeModule.storeRuntimeStatus();
	    const afterWipeListStat = await stat(storeModule.STORE_FILE);
	    assert.equal(afterWipeListStat.mtimeMs, beforeWipeListStat.mtimeMs);
	    assert.equal(afterWipeListStatus.metrics.writes.total, beforeWipeListStatus.metrics.writes.total);
	    assert.equal(afterWipeListStatus.metrics.sqliteWrites, beforeWipeListStatus.metrics.sqliteWrites);
	    assert.equal(queryCount(afterWipeListStatus, 'list_users'), beforeWipeListUnusedFullReads.users);
	    assert.equal(queryCount(afterWipeListStatus, 'list_members'), beforeWipeListUnusedFullReads.members);
	    assert.equal(queryCount(afterWipeListStatus, 'list_squadMembers'), beforeWipeListUnusedFullReads.squadMembers);
	    assert.equal(queryCount(afterWipeListStatus, 'list_uploads'), beforeWipeListUnusedFullReads.uploads);
	    assert.equal(queryCount(afterWipeListStatus, 'list_wipes') > beforeWipeListRequiredReads.wipes, true);
	    assert.equal(queryCount(afterWipeListStatus, 'list_wipeParticipants') > beforeWipeListRequiredReads.wipeParticipants, true);
	    assert.equal(queryCount(afterWipeListStatus, 'list_wipeSettlements') > beforeWipeListRequiredReads.wipeSettlements, true);
	    assert.equal(queryCount(afterWipeListStatus, 'list_permissionRoles'), beforeWipeListRequiredReads.permissionRoles);

	    await repositoryModule.writeSqliteStorePatch({
	      reason: 'sqlite_test_wipe_list_custom_role_seed',
	      upserts: {
	        users: [{
	          id: 'user_sqlite_wipe_viewer',
	          username: 'sqlite_wipe_viewer',
	          passwordHash: '',
	          role: 'sqlite_wipe_viewer',
	          steamNickname: 'SQLite Wipe Viewer',
	          boundSteamId: '',
	          createdAt,
	          updatedAt: createdAt
	        }],
	        permissionRoles: [{
	          id: 'sqlite_wipe_viewer',
	          code: 'sqlite_wipe_viewer',
	          name: 'SQLite Wipe Viewer',
	          permissions: {
	            history: { view: true, edit: false },
	            kda: { view: true, edit: false }
	          },
	          createdAt,
	          updatedAt: createdAt
	        }]
	      }
	    });
	    const customWipeViewerSessionId = await authModule.createSession('user_sqlite_wipe_viewer');
	    const customWipeViewerCookie = `nb_session=${encodeURIComponent(customWipeViewerSessionId)}`;
	    const beforeCustomWipeListStatus = await storeModule.storeRuntimeStatus();
	    const beforeCustomWipeListPermissionRoles = queryCount(beforeCustomWipeListStatus, 'list_permissionRoles');
	    const customWipeListResponse = await httpFetch(`${baseUrl}/wipes`, {
	      headers: { cookie: customWipeViewerCookie }
	    });
	    assert.equal(customWipeListResponse.status, 200);
	    const customWipeListPayload = await customWipeListResponse.json();
	    assert.equal(customWipeListPayload.ok, true);
	    assert.equal(customWipeListPayload.wipes.some((wipe) => wipe.id === 'wipe_sqlite_kda'), true);
	    const afterCustomWipeListStatus = await storeModule.storeRuntimeStatus();
	    assert.equal(queryCount(afterCustomWipeListStatus, 'list_permissionRoles') > beforeCustomWipeListPermissionRoles, true);

	    const beforeCustomWipeDetailStatus = await storeModule.storeRuntimeStatus();
	    const beforeCustomWipeDetailPermissionRoles = queryCount(beforeCustomWipeDetailStatus, 'list_permissionRoles');
	    const customWipeDetailResponse = await httpFetch(`${baseUrl}/wipes/wipe_sqlite_other?scope=all`, {
	      headers: { cookie: customWipeViewerCookie }
	    });
	    assert.equal(customWipeDetailResponse.status, 200);
	    const customWipeDetailPayload = await customWipeDetailResponse.json();
	    assert.equal(customWipeDetailPayload.ok, true);
	    assert.equal(customWipeDetailPayload.rows.some((row) => row.memberId === 'member_sqlite_other'), true);
	    const afterCustomWipeDetailStatus = await storeModule.storeRuntimeStatus();
	    assert.equal(queryCount(afterCustomWipeDetailStatus, 'list_permissionRoles') > beforeCustomWipeDetailPermissionRoles, true);

	    const beforeCustomWipeExportStatus = await storeModule.storeRuntimeStatus();
	    const beforeCustomWipeExportPermissionRoles = queryCount(beforeCustomWipeExportStatus, 'list_permissionRoles');
	    const customWipeExportResponse = await httpFetch(`${baseUrl}/wipes/wipe_sqlite_other/export?scope=all&language=en`, {
	      headers: { cookie: customWipeViewerCookie }
	    });
	    assert.equal(customWipeExportResponse.status, 200);
	    const customWipeExportCsv = await customWipeExportResponse.text();
	    assert.match(customWipeExportCsv, /76561198000001001/);
	    assert.match(customWipeExportCsv, /SQLite Other Member/);
	    const afterCustomWipeExportStatus = await storeModule.storeRuntimeStatus();
	    assert.equal(queryCount(afterCustomWipeExportStatus, 'list_permissionRoles') > beforeCustomWipeExportPermissionRoles, true);

        const beforeClosedDetailStatus = await storeModule.storeRuntimeStatus();
        const beforeClosedDetailFullReads = {
          users: queryCount(beforeClosedDetailStatus, 'list_users'),
          members: queryCount(beforeClosedDetailStatus, 'list_members'),
          squads: queryCount(beforeClosedDetailStatus, 'list_squads'),
          squadMembers: queryCount(beforeClosedDetailStatus, 'list_squadMembers'),
          permissionRoles: queryCount(beforeClosedDetailStatus, 'list_permissionRoles')
        };
        const beforeClosedDetailSnapshotsByWipeId = queryCount(beforeClosedDetailStatus, 'list_kdaSnapshots_wipeId');
        const closedDetailResponse = await httpFetch(`${baseUrl}/wipes/wipe_sqlite_other?scope=all`, {
          headers: { cookie }
        });
        assert.equal(closedDetailResponse.status, 200);
        const closedDetailPayload = await closedDetailResponse.json();
        assert.equal(closedDetailPayload.ok, true);
        assert.equal(closedDetailPayload.rows.some((row) => row.memberId === 'member_sqlite_other'), true);
        const afterClosedDetailStatus = await storeModule.storeRuntimeStatus();
        assert.equal(queryCount(afterClosedDetailStatus, 'list_users'), beforeClosedDetailFullReads.users);
        assert.equal(queryCount(afterClosedDetailStatus, 'list_members'), beforeClosedDetailFullReads.members);
        assert.equal(queryCount(afterClosedDetailStatus, 'list_squads'), beforeClosedDetailFullReads.squads);
        assert.equal(queryCount(afterClosedDetailStatus, 'list_squadMembers'), beforeClosedDetailFullReads.squadMembers);
        assert.equal(queryCount(afterClosedDetailStatus, 'list_permissionRoles'), beforeClosedDetailFullReads.permissionRoles);
        assert.equal(queryCount(afterClosedDetailStatus, 'list_kdaSnapshots_wipeId'), beforeClosedDetailSnapshotsByWipeId);

        const beforeClosedRangeStatus = await storeModule.storeRuntimeStatus();
        const beforeClosedRangeFullReads = {
          users: queryCount(beforeClosedRangeStatus, 'list_users'),
          members: queryCount(beforeClosedRangeStatus, 'list_members'),
          squads: queryCount(beforeClosedRangeStatus, 'list_squads'),
          squadMembers: queryCount(beforeClosedRangeStatus, 'list_squadMembers'),
          permissionRoles: queryCount(beforeClosedRangeStatus, 'list_permissionRoles')
        };
        const beforeClosedRangeSnapshotsByWipeId = queryCount(beforeClosedRangeStatus, 'list_kdaSnapshots_wipeId');
        const closedRangeResponse = await httpFetch(`${baseUrl}/wipes/wipe_sqlite_other?scope=all&from=${encodeURIComponent('2026-06-22T02:00:00.000Z')}&to=${encodeURIComponent('2026-06-22T04:00:00.000Z')}`, {
          headers: { cookie }
        });
        assert.equal(closedRangeResponse.status, 200);
        const closedRangePayload = await closedRangeResponse.json();
        assert.equal(closedRangePayload.ok, true);
        assert.equal(closedRangePayload.rows.some((row) => row.memberId === 'member_sqlite_other' && row.kills === 18), true);
        const afterClosedRangeStatus = await storeModule.storeRuntimeStatus();
        assert.equal(queryCount(afterClosedRangeStatus, 'list_users'), beforeClosedRangeFullReads.users);
        assert.equal(queryCount(afterClosedRangeStatus, 'list_members'), beforeClosedRangeFullReads.members);
        assert.equal(queryCount(afterClosedRangeStatus, 'list_squads'), beforeClosedRangeFullReads.squads);
        assert.equal(queryCount(afterClosedRangeStatus, 'list_squadMembers'), beforeClosedRangeFullReads.squadMembers);
        assert.equal(queryCount(afterClosedRangeStatus, 'list_permissionRoles'), beforeClosedRangeFullReads.permissionRoles);
        assert.equal(queryCount(afterClosedRangeStatus, 'list_kdaSnapshots_wipeId'), beforeClosedRangeSnapshotsByWipeId + 1);

	    await repositoryModule.writeSqliteStorePatch({
	      reason: 'test_kda_import_participant',
	      upserts: {
        wipeParticipants: [{
          id: 'participant_sqlite_import',
          wipeId: 'wipe_sqlite_kda',
          memberId: 'member_sqlite_other',
          squadId: '',
          status: 'on_time',
          createdAt,
          updatedAt: createdAt
        }]
      }
    });
    const beforeImportStatus = await storeModule.storeRuntimeStatus();
    const beforeImportStat = await stat(storeModule.STORE_FILE);
    const importMemberBefore = await repositoryModule.getSqliteRecord('members', 'member_sqlite_other');
    const importParticipantsBefore = await repositoryModule.getSqliteCollection('wipeParticipants', { limit: 0 });
    assert.equal(importMemberBefore?.steamId, '76561198000001001');
    assert.equal(importParticipantsBefore.some((participant) => participant.memberId === 'member_sqlite_other'), true);
    const importResponse = await httpFetch(`${baseUrl}/kda/import`, {
      method: 'POST',
      headers: {
        cookie,
        'content-type': 'application/json'
      },
      body: JSON.stringify({
        wipeId: 'wipe_sqlite_kda',
        rows: [
          {
            steamId: '76561198000001001',
            kills: 21,
            deaths: 7,
            assists: 0,
            rockets: 4,
            sulfur: 9000
          }
        ]
      })
    });
    assert.equal(importResponse.status, 200);
    const importPayload = await importResponse.json();
    assert.equal(importPayload.ok, true);
    assert.equal(importPayload.imported, 1, JSON.stringify(importPayload));
    assert.equal(importPayload.ignored, 0, JSON.stringify(importPayload));
    const importedRows = await repositoryModule.getSqliteRecordsByJsonField('kdaRows', 'memberId', ['member_sqlite_other'], { limit: 0 });
    const importedSnapshots = await repositoryModule.getSqliteRecordsByJsonField('kdaSnapshots', 'memberId', ['member_sqlite_other'], { limit: 0 });
    const importLogs = await repositoryModule.getSqliteCollection('logs', { limit: 0 });
    const afterImportStatus = await storeModule.storeRuntimeStatus();
    const afterImportStat = await stat(storeModule.STORE_FILE);
    assert.equal(importedRows.some((row) => row.wipeId === 'wipe_sqlite_kda' && row.source === 'manual_import' && row.kills === 21), true);
    assert.equal(importedSnapshots.some((row) => row.wipeId === 'wipe_sqlite_kda' && row.source === 'manual_import' && row.kills === 21), true);
    assert.equal(importLogs.some((log) => log.type === 'kda_sync' && log.targetId === 'wipe_sqlite_kda'), true);
    assert.equal(afterImportStat.mtimeMs, beforeImportStat.mtimeMs);
    assert.equal(afterImportStatus.metrics.writes.total, beforeImportStatus.metrics.writes.total);
    assert.equal(afterImportStatus.metrics.sqliteWrites, beforeImportStatus.metrics.sqliteWrites);

    await storeModule.updateStore((store) => {
      store.members.push({
        id: 'member_sqlite_detail_refresh',
        steamId: '76561198000001002',
        rawInput: '76561198000001002',
        customName: '',
        steamNickname: 'SQLite Detail Refresh',
        avatar: '',
        discordId: '',
        wechatId: '',
        wechatUserId: '',
        notes: '',
        specialty: [],
        memberStatus: 'active',
        invitedByUserId: '',
        createdAt,
        updatedAt: createdAt
      });
	    });
	    const beforeDetailStatus = await storeModule.storeRuntimeStatus();
	    const beforeDetailFullReads = {
	      users: queryCount(beforeDetailStatus, 'list_users'),
	      members: queryCount(beforeDetailStatus, 'list_members'),
	      squads: queryCount(beforeDetailStatus, 'list_squads'),
	      squadMembers: queryCount(beforeDetailStatus, 'list_squadMembers'),
	      permissionRoles: queryCount(beforeDetailStatus, 'list_permissionRoles'),
	      memberProfiles: queryCount(beforeDetailStatus, 'list_memberProfiles'),
	      uploads: queryCount(beforeDetailStatus, 'list_uploads'),
	      wipeParticipants: queryCount(beforeDetailStatus, 'list_wipeParticipants')
	    };
		    const beforeDetailScopedReads = {
		      memberProfilesByMemberId: queryCount(beforeDetailStatus, 'list_memberProfiles_memberId'),
		      uploadsByOwnerId: queryCount(beforeDetailStatus, 'list_uploads_ownerId'),
	          membersWithSteamId: queryCount(beforeDetailStatus, 'list_members_steamId_present'),
	          wipeParticipantsByWipeId: queryCount(beforeDetailStatus, 'list_wipeParticipants_wipeId'),
	          kdaSnapshotsByWipeId: queryCount(beforeDetailStatus, 'list_kdaSnapshots_wipeId')
		    };
	    const beforeDetailStat = await stat(storeModule.STORE_FILE);
	    const detailResponse = await httpFetch(`${baseUrl}/wipes/wipe_sqlite_kda?scope=all`, {
	      headers: { cookie }
	    });
    assert.equal(detailResponse.status, 200);
    const detailPayload = await detailResponse.json();
    assert.equal(detailPayload.ok, true);
    assert.equal(detailPayload.rows.some((row) => row.memberId === 'member_sqlite_detail_refresh'), true);
    const detailRows = await repositoryModule.getSqliteRecordsByJsonField('kdaRows', 'memberId', ['member_sqlite_detail_refresh'], { limit: 0 });
    const detailSnapshots = await repositoryModule.getSqliteRecordsByJsonField('kdaSnapshots', 'memberId', ['member_sqlite_detail_refresh'], { limit: 0 });
    const detailRefreshedWipe = await repositoryModule.getSqliteRecord('wipes', 'wipe_sqlite_kda');
    const afterDetailStatus = await storeModule.storeRuntimeStatus();
    const afterDetailStat = await stat(storeModule.STORE_FILE);
    assert.equal(detailRows.some((row) => row.wipeId === 'wipe_sqlite_kda' && row.source === 'local_demo'), true);
    assert.equal(detailSnapshots.some((row) => row.wipeId === 'wipe_sqlite_kda' && row.source === 'local_demo'), true);
    assert.equal(detailRefreshedWipe.kdaMemberScope, 'all_members');
	    assert.equal(afterDetailStat.mtimeMs, beforeDetailStat.mtimeMs);
	    assert.equal(afterDetailStatus.metrics.writes.total, beforeDetailStatus.metrics.writes.total);
		    assert.equal(afterDetailStatus.metrics.sqliteWrites, beforeDetailStatus.metrics.sqliteWrites);
		    assert.equal(queryCount(afterDetailStatus, 'list_users'), beforeDetailFullReads.users);
		    assert.equal(queryCount(afterDetailStatus, 'list_members'), beforeDetailFullReads.members);
		    assert.equal(queryCount(afterDetailStatus, 'list_squads'), beforeDetailFullReads.squads);
	    assert.equal(queryCount(afterDetailStatus, 'list_squadMembers'), beforeDetailFullReads.squadMembers);
	    assert.equal(queryCount(afterDetailStatus, 'list_permissionRoles'), beforeDetailFullReads.permissionRoles);
	    assert.equal(queryCount(afterDetailStatus, 'list_memberProfiles'), beforeDetailFullReads.memberProfiles);
	    assert.equal(queryCount(afterDetailStatus, 'list_uploads'), beforeDetailFullReads.uploads);
		    assert.equal(queryCount(afterDetailStatus, 'list_wipeParticipants'), beforeDetailFullReads.wipeParticipants);
		    assert.equal(queryCount(afterDetailStatus, 'list_members_steamId_present') > beforeDetailScopedReads.membersWithSteamId, true);
		    assert.equal(queryCount(afterDetailStatus, 'list_memberProfiles_memberId') > beforeDetailScopedReads.memberProfilesByMemberId, true);
	    assert.equal(queryCount(afterDetailStatus, 'list_uploads_ownerId') > beforeDetailScopedReads.uploadsByOwnerId, true);
	    assert.equal(queryCount(afterDetailStatus, 'list_wipeParticipants_wipeId') > beforeDetailScopedReads.wipeParticipantsByWipeId, true);
        assert.equal(queryCount(afterDetailStatus, 'list_kdaSnapshots_wipeId'), beforeDetailScopedReads.kdaSnapshotsByWipeId + 1);

	    await storeModule.updateStore((store) => {
      store.members.push({
        id: 'member_sqlite_export_refresh',
        steamId: '76561198000001003',
        rawInput: '76561198000001003',
        customName: '',
        steamNickname: 'SQLite Export Refresh',
        avatar: '',
        discordId: '',
        wechatId: '',
        wechatUserId: '',
        notes: '',
        specialty: [],
        memberStatus: 'active',
        invitedByUserId: '',
        createdAt,
        updatedAt: createdAt
      });
	    });
	    const beforeExportStatus = await storeModule.storeRuntimeStatus();
	    const beforeExportFullReads = {
	      users: queryCount(beforeExportStatus, 'list_users'),
	      members: queryCount(beforeExportStatus, 'list_members'),
	      squads: queryCount(beforeExportStatus, 'list_squads'),
	      squadMembers: queryCount(beforeExportStatus, 'list_squadMembers'),
	      permissionRoles: queryCount(beforeExportStatus, 'list_permissionRoles'),
	      wipeParticipants: queryCount(beforeExportStatus, 'list_wipeParticipants'),
	      wipeSettlements: queryCount(beforeExportStatus, 'list_wipeSettlements')
	    };
		    const beforeExportScopedReads = {
	          membersWithSteamId: queryCount(beforeExportStatus, 'list_members_steamId_present'),
		      wipeParticipantsByWipeId: queryCount(beforeExportStatus, 'list_wipeParticipants_wipeId'),
	          wipeSettlementsByWipeId: queryCount(beforeExportStatus, 'list_wipeSettlements_wipeId'),
	          kdaSnapshotsByWipeId: queryCount(beforeExportStatus, 'list_kdaSnapshots_wipeId')
	    };
	    const beforeExportStat = await stat(storeModule.STORE_FILE);
	    const exportResponse = await httpFetch(`${baseUrl}/wipes/wipe_sqlite_kda/export?scope=all&language=en`, {
	      headers: { cookie }
	    });
    assert.equal(exportResponse.status, 200);
    const csv = await exportResponse.text();
    assert.match(csv, /SQLite Export Refresh/);
    const exportRows = await repositoryModule.getSqliteRecordsByJsonField('kdaRows', 'memberId', ['member_sqlite_export_refresh'], { limit: 0 });
    const exportSnapshots = await repositoryModule.getSqliteRecordsByJsonField('kdaSnapshots', 'memberId', ['member_sqlite_export_refresh'], { limit: 0 });
    const afterExportStatus = await storeModule.storeRuntimeStatus();
    const afterExportStat = await stat(storeModule.STORE_FILE);
    assert.equal(exportRows.some((row) => row.wipeId === 'wipe_sqlite_kda' && row.source === 'local_demo'), true);
	    assert.equal(exportSnapshots.some((row) => row.wipeId === 'wipe_sqlite_kda' && row.source === 'local_demo'), true);
	    assert.equal(afterExportStat.mtimeMs, beforeExportStat.mtimeMs);
	    assert.equal(afterExportStatus.metrics.writes.total, beforeExportStatus.metrics.writes.total);
		    assert.equal(afterExportStatus.metrics.sqliteWrites, beforeExportStatus.metrics.sqliteWrites);
		    assert.equal(queryCount(afterExportStatus, 'list_users'), beforeExportFullReads.users);
		    assert.equal(queryCount(afterExportStatus, 'list_members'), beforeExportFullReads.members);
		    assert.equal(queryCount(afterExportStatus, 'list_squads'), beforeExportFullReads.squads);
	    assert.equal(queryCount(afterExportStatus, 'list_squadMembers'), beforeExportFullReads.squadMembers);
	    assert.equal(queryCount(afterExportStatus, 'list_permissionRoles'), beforeExportFullReads.permissionRoles);
		    assert.equal(queryCount(afterExportStatus, 'list_wipeParticipants'), beforeExportFullReads.wipeParticipants);
		    assert.equal(queryCount(afterExportStatus, 'list_wipeSettlements'), beforeExportFullReads.wipeSettlements);
		    assert.equal(queryCount(afterExportStatus, 'list_members_steamId_present') > beforeExportScopedReads.membersWithSteamId, true);
		    assert.equal(queryCount(afterExportStatus, 'list_wipeParticipants_wipeId') > beforeExportScopedReads.wipeParticipantsByWipeId, true);
	    assert.equal(queryCount(afterExportStatus, 'list_wipeSettlements_wipeId') > beforeExportScopedReads.wipeSettlementsByWipeId, true);
        assert.equal(queryCount(afterExportStatus, 'list_kdaSnapshots_wipeId'), beforeExportScopedReads.kdaSnapshotsByWipeId + 1);

	    await storeModule.updateStore((store) => {
      store.members.push({
        id: 'member_sqlite_member_kda_refresh',
        steamId: '76561198000001004',
        rawInput: '76561198000001004',
        customName: '',
        steamNickname: 'SQLite Member KDA Refresh',
        avatar: '',
        discordId: '',
        wechatId: '',
        wechatUserId: '',
        notes: '',
        specialty: [],
        memberStatus: 'active',
        invitedByUserId: '',
        createdAt,
        updatedAt: createdAt
      });
    });
    const beforeMemberRefreshStatus = await storeModule.storeRuntimeStatus();
    const beforeMemberRefreshScopedReads = {
      kdaRowsByWipeId: queryCount(beforeMemberRefreshStatus, 'list_kdaRows_wipeId'),
      kdaSnapshotsByWipeId: queryCount(beforeMemberRefreshStatus, 'list_kdaSnapshots_wipeId'),
      wipeSettlementsByWipeId: queryCount(beforeMemberRefreshStatus, 'list_wipeSettlements_wipeId')
    };
    const beforeMemberRefreshStat = await stat(storeModule.STORE_FILE);
    const memberRefreshResponse = await httpFetch(`${baseUrl}/members/member_sqlite_member_kda_refresh/kda/refresh`, {
      method: 'POST',
      headers: { cookie }
    });
    assert.equal(memberRefreshResponse.status, 200);
    const memberRefreshPayload = await memberRefreshResponse.json();
    assert.equal(memberRefreshPayload.ok, true);
    assert.equal(memberRefreshPayload.kdaRefresh.source, 'local_demo');
    assert.equal(memberRefreshPayload.kdaRefresh.imported, 1);
    assert.equal(memberRefreshPayload.member.id, 'member_sqlite_member_kda_refresh');
    const memberRefreshRows = await repositoryModule.getSqliteRecordsByJsonField('kdaRows', 'memberId', ['member_sqlite_member_kda_refresh'], { limit: 0 });
    const memberRefreshSnapshots = await repositoryModule.getSqliteRecordsByJsonField('kdaSnapshots', 'memberId', ['member_sqlite_member_kda_refresh'], { limit: 0 });
    const afterMemberRefreshStatus = await storeModule.storeRuntimeStatus();
    const afterMemberRefreshStat = await stat(storeModule.STORE_FILE);
    assert.equal(memberRefreshRows.some((row) => row.wipeId === 'wipe_sqlite_kda' && row.source === 'local_demo'), true);
    assert.equal(memberRefreshSnapshots.some((row) => row.wipeId === 'wipe_sqlite_kda' && row.source === 'local_demo'), true);
    assert.equal(afterMemberRefreshStat.mtimeMs, beforeMemberRefreshStat.mtimeMs);
    assert.equal(afterMemberRefreshStatus.metrics.writes.total, beforeMemberRefreshStatus.metrics.writes.total);
    assert.equal(afterMemberRefreshStatus.metrics.sqliteWrites, beforeMemberRefreshStatus.metrics.sqliteWrites);
    assert.equal(queryCount(afterMemberRefreshStatus, 'list_kdaRows_wipeId'), beforeMemberRefreshScopedReads.kdaRowsByWipeId + 1);
    assert.equal(queryCount(afterMemberRefreshStatus, 'list_kdaSnapshots_wipeId'), beforeMemberRefreshScopedReads.kdaSnapshotsByWipeId + 1);
    assert.equal(queryCount(afterMemberRefreshStatus, 'list_wipeSettlements_wipeId'), beforeMemberRefreshScopedReads.wipeSettlementsByWipeId);

    await storeModule.updateStore((store) => {
      store.members.push({
        id: 'member_sqlite_generic_kda_list',
        steamId: '76561198000001008',
        rawInput: '76561198000001008',
        customName: '',
        steamNickname: 'SQLite Generic KDA List',
        avatar: '',
        discordId: '',
        wechatId: '',
        wechatUserId: '',
        notes: '',
        specialty: [],
        memberStatus: 'active',
        invitedByUserId: '',
        createdAt,
        updatedAt: createdAt
      });
    });
    const beforeGenericListStatus = await storeModule.storeRuntimeStatus();
    const beforeGenericListFullReads = {
      users: queryCount(beforeGenericListStatus, 'list_users'),
      members: queryCount(beforeGenericListStatus, 'list_members'),
      squads: queryCount(beforeGenericListStatus, 'list_squads'),
      squadMembers: queryCount(beforeGenericListStatus, 'list_squadMembers'),
      permissionRoles: queryCount(beforeGenericListStatus, 'list_permissionRoles')
    };
	    const beforeGenericListSnapshotsByWipeId = queryCount(beforeGenericListStatus, 'list_kdaSnapshots_wipeId');
	    const beforeGenericListMembersWithSteam = queryCount(beforeGenericListStatus, 'list_members_steamId_present');
	    const beforeGenericListStat = await stat(storeModule.STORE_FILE);
    const genericListResponse = await httpFetch(`${baseUrl}/kda?wipeId=wipe_sqlite_kda&scope=all&sort=kills&order=desc`, {
      headers: { cookie }
    });
    assert.equal(genericListResponse.status, 200);
    const genericListPayload = await genericListResponse.json();
    assert.equal(genericListPayload.ok, true);
    assert.equal(genericListPayload.rows.some((row) => row.memberId === 'member_sqlite_generic_kda_list'), true);
    const genericListRows = await repositoryModule.getSqliteRecordsByJsonField('kdaRows', 'memberId', ['member_sqlite_generic_kda_list'], { limit: 0 });
    const genericListSnapshots = await repositoryModule.getSqliteRecordsByJsonField('kdaSnapshots', 'memberId', ['member_sqlite_generic_kda_list'], { limit: 0 });
    const afterGenericListStatus = await storeModule.storeRuntimeStatus();
    const afterGenericListStat = await stat(storeModule.STORE_FILE);
    assert.equal(genericListRows.some((row) => row.wipeId === 'wipe_sqlite_kda' && row.source === 'local_demo'), true);
    assert.equal(genericListSnapshots.some((row) => row.wipeId === 'wipe_sqlite_kda' && row.source === 'local_demo'), true);
    assert.equal(afterGenericListStat.mtimeMs, beforeGenericListStat.mtimeMs);
    assert.equal(afterGenericListStatus.metrics.writes.total, beforeGenericListStatus.metrics.writes.total);
	    assert.equal(afterGenericListStatus.metrics.sqliteWrites, beforeGenericListStatus.metrics.sqliteWrites);
	    assert.equal(queryCount(afterGenericListStatus, 'list_users'), beforeGenericListFullReads.users);
	    assert.equal(queryCount(afterGenericListStatus, 'list_members'), beforeGenericListFullReads.members);
	    assert.equal(queryCount(afterGenericListStatus, 'list_squads'), beforeGenericListFullReads.squads);
	    assert.equal(queryCount(afterGenericListStatus, 'list_squadMembers'), beforeGenericListFullReads.squadMembers);
	    assert.equal(queryCount(afterGenericListStatus, 'list_permissionRoles'), beforeGenericListFullReads.permissionRoles);
	    assert.equal(queryCount(afterGenericListStatus, 'list_members_steamId_present') > beforeGenericListMembersWithSteam, true);
	    assert.equal(queryCount(afterGenericListStatus, 'list_kdaSnapshots_wipeId'), beforeGenericListSnapshotsByWipeId + 1);

    await storeModule.updateStore((store) => {
      store.members.push({
        id: 'member_sqlite_generic_kda_export',
        steamId: '76561198000001009',
        rawInput: '76561198000001009',
        customName: '',
        steamNickname: 'SQLite Generic KDA Export',
        avatar: '',
        discordId: '',
        wechatId: '',
        wechatUserId: '',
        notes: '',
        specialty: [],
        memberStatus: 'active',
        invitedByUserId: '',
        createdAt,
        updatedAt: createdAt
      });
    });
    const beforeGenericExportStatus = await storeModule.storeRuntimeStatus();
    const beforeGenericExportFullReads = {
      users: queryCount(beforeGenericExportStatus, 'list_users'),
      members: queryCount(beforeGenericExportStatus, 'list_members'),
      squads: queryCount(beforeGenericExportStatus, 'list_squads'),
      squadMembers: queryCount(beforeGenericExportStatus, 'list_squadMembers'),
      permissionRoles: queryCount(beforeGenericExportStatus, 'list_permissionRoles')
    };
	    const beforeGenericExportSnapshotsByWipeId = queryCount(beforeGenericExportStatus, 'list_kdaSnapshots_wipeId');
	    const beforeGenericExportMembersWithSteam = queryCount(beforeGenericExportStatus, 'list_members_steamId_present');
	    const beforeGenericExportStat = await stat(storeModule.STORE_FILE);
    const genericExportResponse = await httpFetch(`${baseUrl}/kda/export?wipeId=wipe_sqlite_kda&scope=all&language=en&format=csv`, {
      headers: { cookie }
    });
    assert.equal(genericExportResponse.status, 200);
    const genericExportCsv = await genericExportResponse.text();
    assert.match(genericExportCsv, /SQLite Generic KDA Export/);
    const genericExportRows = await repositoryModule.getSqliteRecordsByJsonField('kdaRows', 'memberId', ['member_sqlite_generic_kda_export'], { limit: 0 });
    const genericExportSnapshots = await repositoryModule.getSqliteRecordsByJsonField('kdaSnapshots', 'memberId', ['member_sqlite_generic_kda_export'], { limit: 0 });
    const afterGenericExportStatus = await storeModule.storeRuntimeStatus();
    const afterGenericExportStat = await stat(storeModule.STORE_FILE);
    assert.equal(genericExportRows.some((row) => row.wipeId === 'wipe_sqlite_kda' && row.source === 'local_demo'), true);
    assert.equal(genericExportSnapshots.some((row) => row.wipeId === 'wipe_sqlite_kda' && row.source === 'local_demo'), true);
    assert.equal(afterGenericExportStat.mtimeMs, beforeGenericExportStat.mtimeMs);
    assert.equal(afterGenericExportStatus.metrics.writes.total, beforeGenericExportStatus.metrics.writes.total);
	    assert.equal(afterGenericExportStatus.metrics.sqliteWrites, beforeGenericExportStatus.metrics.sqliteWrites);
	    assert.equal(queryCount(afterGenericExportStatus, 'list_users'), beforeGenericExportFullReads.users);
	    assert.equal(queryCount(afterGenericExportStatus, 'list_members'), beforeGenericExportFullReads.members);
	    assert.equal(queryCount(afterGenericExportStatus, 'list_squads'), beforeGenericExportFullReads.squads);
	    assert.equal(queryCount(afterGenericExportStatus, 'list_squadMembers'), beforeGenericExportFullReads.squadMembers);
	    assert.equal(queryCount(afterGenericExportStatus, 'list_permissionRoles'), beforeGenericExportFullReads.permissionRoles);
	    assert.equal(queryCount(afterGenericExportStatus, 'list_members_steamId_present') > beforeGenericExportMembersWithSteam, true);
	    assert.equal(queryCount(afterGenericExportStatus, 'list_kdaSnapshots_wipeId'), beforeGenericExportSnapshotsByWipeId + 1);

    await storeModule.updateStore((store) => {
      store.members.push({
        id: 'member_sqlite_wechat_export_refresh',
        steamId: '76561198000001010',
        rawInput: '76561198000001010',
        customName: '',
        steamNickname: 'SQLite Wechat Export Refresh',
        avatar: '',
        discordId: '',
        wechatId: '',
        wechatUserId: '',
        notes: '',
        specialty: [],
        memberStatus: 'active',
        invitedByUserId: '',
        createdAt,
        updatedAt: createdAt
      });
    });
    const beforeWechatExportStatus = await storeModule.storeRuntimeStatus();
    const beforeWechatExportStat = await stat(storeModule.STORE_FILE);
    const wechatExportResponse = await httpFetch(`${baseUrl}/wechat/admin/export?wipeId=wipe_sqlite_kda&scope=all&language=en&from=${encodeURIComponent('2026-01-01T00:00:00.000Z')}&to=${encodeURIComponent('2026-01-01T02:00:00.000Z')}`, {
      headers: { cookie }
    });
    assert.equal(wechatExportResponse.status, 400);
    const wechatExportPayload = await wechatExportResponse.json();
    assert.equal(wechatExportPayload.ok, false);
    const wechatExportRows = await repositoryModule.getSqliteRecordsByJsonField('kdaRows', 'memberId', ['member_sqlite_wechat_export_refresh'], { limit: 0 });
    const wechatExportSnapshots = await repositoryModule.getSqliteRecordsByJsonField('kdaSnapshots', 'memberId', ['member_sqlite_wechat_export_refresh'], { limit: 0 });
    const afterWechatExportStatus = await storeModule.storeRuntimeStatus();
    const afterWechatExportStat = await stat(storeModule.STORE_FILE);
    assert.equal(wechatExportRows.some((row) => row.wipeId === 'wipe_sqlite_kda' && row.source === 'local_demo'), true);
    assert.equal(wechatExportSnapshots.some((row) => row.wipeId === 'wipe_sqlite_kda' && row.source === 'local_demo'), true);
    assert.equal(afterWechatExportStat.mtimeMs, beforeWechatExportStat.mtimeMs);
    assert.equal(afterWechatExportStatus.metrics.writes.total, beforeWechatExportStatus.metrics.writes.total);
    assert.equal(afterWechatExportStatus.metrics.sqliteWrites, beforeWechatExportStatus.metrics.sqliteWrites);
    assert.equal(
      afterWechatExportStatus.sqlite.compatibility.syncStoreChangesToSqlite,
      beforeWechatExportStatus.sqlite.compatibility.syncStoreChangesToSqlite
    );

    const memberPasswordHash = await storeModule.hashPassword('MemberPass123!');
    await storeModule.updateStore((store) => {
      store.users.push({
        id: 'user_sqlite_self_signup',
        username: 'sqlite_self_signup',
        passwordHash: memberPasswordHash,
        role: 'member',
        boundSteamId: '76561198000001005',
        steamNickname: 'SQLite Self Signup',
        createdAt,
        updatedAt: createdAt
      });
      store.members.push({
        id: 'member_sqlite_self_signup',
        steamId: '76561198000001005',
        rawInput: '76561198000001005',
        customName: '',
        steamNickname: 'SQLite Self Signup',
        avatar: '',
        discordId: '',
        wechatId: '',
        wechatUserId: '',
        notes: '',
        specialty: [],
        memberStatus: 'active',
        invitedByUserId: 'user_sqlite_self_signup',
        createdAt,
        updatedAt: createdAt
      }, {
        id: 'member_sqlite_web_participant',
        steamId: '76561198000001006',
        rawInput: '76561198000001006',
        customName: '',
        steamNickname: 'SQLite Web Participant',
        avatar: '',
        discordId: '',
        wechatId: '',
        wechatUserId: '',
        notes: '',
        specialty: [],
        memberStatus: 'active',
        invitedByUserId: '',
        createdAt,
        updatedAt: createdAt
      }, {
        id: 'member_sqlite_web_participant_fail',
        steamId: '76561198000001011',
        rawInput: '76561198000001011',
        customName: '',
        steamNickname: 'SQLite Web Participant Fail',
        avatar: '',
        discordId: '',
        wechatId: '',
        wechatUserId: '',
        notes: '',
        specialty: [],
        memberStatus: 'active',
        invitedByUserId: '',
        createdAt,
        updatedAt: createdAt
      }, {
        id: 'member_sqlite_wechat_admin_participant',
        steamId: '76561198000001007',
        rawInput: '76561198000001007',
        customName: '',
        steamNickname: 'SQLite Wechat Admin Participant',
        avatar: '',
        discordId: '',
        wechatId: '',
        wechatUserId: '',
        notes: '',
        specialty: [],
        memberStatus: 'active',
        invitedByUserId: '',
        createdAt,
        updatedAt: createdAt
      });
    });
    const memberLoginResponse = await httpFetch(`${baseUrl}/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'sqlite_self_signup', password: 'MemberPass123!' })
    });
	    assert.equal(memberLoginResponse.status, 200);
	    const memberCookie = memberLoginResponse.headers.get('set-cookie')?.split(';')[0] || '';
	    assert.match(memberCookie, /^nb_session=/);

	    const beforeParticipantCandidatesStatus = await storeModule.storeRuntimeStatus();
	    const beforeParticipantCandidatesFullParticipantReads = queryCount(beforeParticipantCandidatesStatus, 'list_wipeParticipants');
	    const beforeParticipantCandidatesByWipeReads = queryCount(beforeParticipantCandidatesStatus, 'list_wipeParticipants_wipeId');
	    const participantCandidatesResponse = await httpFetch(`${baseUrl}/wipes/wipe_sqlite_kda/participant-candidates`, {
	      headers: { cookie }
	    });
	    assert.equal(participantCandidatesResponse.status, 200);
	    const participantCandidatesPayload = await participantCandidatesResponse.json();
	    assert.equal(participantCandidatesPayload.ok, true);
	    assert.equal(participantCandidatesPayload.members.some((member) => member.id === 'member_sqlite_web_participant'), true);
	    const afterParticipantCandidatesStatus = await storeModule.storeRuntimeStatus();
	    assert.equal(queryCount(afterParticipantCandidatesStatus, 'list_wipeParticipants'), beforeParticipantCandidatesFullParticipantReads);
	    assert.equal(queryCount(afterParticipantCandidatesStatus, 'list_wipeParticipants_wipeId') > beforeParticipantCandidatesByWipeReads, true);

		    const beforeSelfSignupStatus = await storeModule.storeRuntimeStatus();
    const beforeSelfSignupFullReads = {
      users: queryCount(beforeSelfSignupStatus, 'list_users'),
      members: queryCount(beforeSelfSignupStatus, 'list_members'),
      squadMembers: queryCount(beforeSelfSignupStatus, 'list_squadMembers'),
      wipes: queryCount(beforeSelfSignupStatus, 'list_wipes'),
      permissionRoles: queryCount(beforeSelfSignupStatus, 'list_permissionRoles'),
      wipeParticipants: queryCount(beforeSelfSignupStatus, 'list_wipeParticipants')
    };
    const beforeSelfSignupMembersBySteam = queryCount(beforeSelfSignupStatus, 'list_members_steamId');
    const beforeSelfSignupMembersWithSteam = queryCount(beforeSelfSignupStatus, 'list_members_steamId_present');
    const beforeSelfSignupParticipantsByWipe = queryCount(beforeSelfSignupStatus, 'list_wipeParticipants_wipeId');
    const beforeSelfSignupSquadMembersByMember = queryCount(beforeSelfSignupStatus, 'list_squadMembers_memberId');
	    const beforeSelfSignupStat = await stat(storeModule.STORE_FILE);
	    const selfSignupResponse = await httpFetch(`${baseUrl}/wipes/wipe_sqlite_kda/my-signup`, {
      method: 'POST',
      headers: {
        cookie: memberCookie,
        'content-type': 'application/json'
      },
      body: JSON.stringify({ status: 'join_16h' })
    });
    assert.equal(selfSignupResponse.status, 200);
    const selfSignupPayload = await selfSignupResponse.json();
    assert.equal(selfSignupPayload.ok, true);
    assert.equal(selfSignupPayload.participants.some((participant) => participant.memberId === 'member_sqlite_self_signup' && participant.status === 'join_16h'), true);
    const selfSignupRows = await repositoryModule.getSqliteRecordsByJsonField('wipeParticipants', 'memberId', ['member_sqlite_self_signup'], { limit: 0 });
    const afterSelfSignupStatus = await storeModule.storeRuntimeStatus();
    const afterSelfSignupStat = await stat(storeModule.STORE_FILE);
    assert.equal(selfSignupRows.some((participant) => participant.wipeId === 'wipe_sqlite_kda' && participant.source === 'web'), true);
	    assert.equal(afterSelfSignupStat.mtimeMs, beforeSelfSignupStat.mtimeMs);
	    assert.equal(afterSelfSignupStatus.metrics.writes.total, beforeSelfSignupStatus.metrics.writes.total);
	    assert.equal(afterSelfSignupStatus.metrics.sqliteWrites, beforeSelfSignupStatus.metrics.sqliteWrites);
		    assert.equal(queryCount(afterSelfSignupStatus, 'list_members'), beforeSelfSignupFullReads.members);
		    assert.equal(queryCount(afterSelfSignupStatus, 'list_squadMembers'), beforeSelfSignupFullReads.squadMembers);
		    assert.equal(queryCount(afterSelfSignupStatus, 'list_wipeParticipants'), beforeSelfSignupFullReads.wipeParticipants);
		    assert.equal(queryCount(afterSelfSignupStatus, 'list_permissionRoles') >= beforeSelfSignupFullReads.permissionRoles + 1, true);
		    assert.equal(queryCount(afterSelfSignupStatus, 'list_members_steamId') > beforeSelfSignupMembersBySteam, true);
		    assert.equal(queryCount(afterSelfSignupStatus, 'list_members_steamId_present') > beforeSelfSignupMembersWithSteam, true);
		    assert.equal(queryCount(afterSelfSignupStatus, 'list_wipeParticipants_wipeId') > beforeSelfSignupParticipantsByWipe, true);
	    assert.equal(queryCount(afterSelfSignupStatus, 'list_squadMembers_memberId') > beforeSelfSignupSquadMembersByMember, true);

	    const beforeParticipantAddStatus = await storeModule.storeRuntimeStatus();
    const beforeParticipantAddFullReads = {
      users: queryCount(beforeParticipantAddStatus, 'list_users'),
      members: queryCount(beforeParticipantAddStatus, 'list_members'),
      squadMembers: queryCount(beforeParticipantAddStatus, 'list_squadMembers'),
      wipes: queryCount(beforeParticipantAddStatus, 'list_wipes'),
      permissionRoles: queryCount(beforeParticipantAddStatus, 'list_permissionRoles'),
      wipeParticipants: queryCount(beforeParticipantAddStatus, 'list_wipeParticipants')
    };
	    const beforeParticipantAddMembersById = queryCount(beforeParticipantAddStatus, 'list_members_id');
    const beforeParticipantAddParticipantsByWipe = queryCount(beforeParticipantAddStatus, 'list_wipeParticipants_wipeId');
    const beforeParticipantAddSquadMembersByMember = queryCount(beforeParticipantAddStatus, 'list_squadMembers_memberId');
	    const beforeParticipantAddStat = await stat(storeModule.STORE_FILE);
	    const participantAddResponse = await httpFetch(`${baseUrl}/wipes/wipe_sqlite_kda/participants`, {
      method: 'POST',
      headers: {
        cookie,
        'content-type': 'application/json'
      },
      body: JSON.stringify({
        memberIds: ['member_sqlite_web_participant'],
        status: 'on_time',
        note: 'SQLite web participant direct add',
        responseLimit: 20,
        responseOffset: 0
      })
    });
    assert.equal(participantAddResponse.status, 200);
    const participantAddPayload = await participantAddResponse.json();
    assert.equal(participantAddPayload.ok, true);
    assert.equal(participantAddPayload.added, 1);
    assert.equal(participantAddPayload.participants.some((participant) => participant.memberId === 'member_sqlite_web_participant'), true);
    const addedParticipantRows = await repositoryModule.getSqliteRecordsByJsonField('wipeParticipants', 'memberId', ['member_sqlite_web_participant'], { limit: 0 });
    const afterParticipantAddStatus = await storeModule.storeRuntimeStatus();
    const afterParticipantAddStat = await stat(storeModule.STORE_FILE);
    assert.equal(addedParticipantRows.some((participant) => participant.wipeId === 'wipe_sqlite_kda' && participant.note === 'SQLite web participant direct add'), true);
	    assert.equal(afterParticipantAddStat.mtimeMs, beforeParticipantAddStat.mtimeMs);
	    assert.equal(afterParticipantAddStatus.metrics.writes.total, beforeParticipantAddStatus.metrics.writes.total);
	    assert.equal(afterParticipantAddStatus.metrics.sqliteWrites, beforeParticipantAddStatus.metrics.sqliteWrites);
		    assert.equal(queryCount(afterParticipantAddStatus, 'list_members'), beforeParticipantAddFullReads.members);
	    assert.equal(queryCount(afterParticipantAddStatus, 'list_squadMembers'), beforeParticipantAddFullReads.squadMembers);
	    assert.equal(queryCount(afterParticipantAddStatus, 'list_wipeParticipants'), beforeParticipantAddFullReads.wipeParticipants);
	    assert.equal(queryCount(afterParticipantAddStatus, 'list_permissionRoles') >= beforeParticipantAddFullReads.permissionRoles + 1, true);
		    assert.equal(queryCount(afterParticipantAddStatus, 'list_members_id') > beforeParticipantAddMembersById, true);
	    assert.equal(queryCount(afterParticipantAddStatus, 'list_wipeParticipants_wipeId') > beforeParticipantAddParticipantsByWipe, true);
	    assert.equal(queryCount(afterParticipantAddStatus, 'list_squadMembers_memberId') > beforeParticipantAddSquadMembersByMember, true);

    const beforeParticipantAddFailureStatus = await storeModule.storeRuntimeStatus({ sqliteSummary: false });
    const beforeParticipantAddFailureReadStoreFull = queryCount(beforeParticipantAddFailureStatus, 'read_store_full');
    const beforeParticipantAddFailureStat = await stat(storeModule.STORE_FILE);
    repositoryModule.injectSqliteStorePatchFailureForTests('web_wipe_participant_add', 1);
    const failedParticipantAddResponse = await httpFetch(`${baseUrl}/wipes/wipe_sqlite_kda/participants`, {
      method: 'POST',
      headers: {
        cookie,
        'content-type': 'application/json'
      },
      body: JSON.stringify({
        memberIds: ['member_sqlite_web_participant_fail'],
        status: 'on_time'
      })
    });
    assert.equal(failedParticipantAddResponse.status, 503);
    const failedParticipantAddPayload = await failedParticipantAddResponse.json();
    assert.equal(failedParticipantAddPayload.ok, false);
    assert.match(failedParticipantAddPayload.error, /Web 当前档参与人员写入暂不可用/);
    const failedParticipantRows = await repositoryModule.getSqliteRecordsByJsonField('wipeParticipants', 'memberId', ['member_sqlite_web_participant_fail'], { limit: 0 });
    const afterParticipantAddFailureStatus = await storeModule.storeRuntimeStatus({ sqliteSummary: false });
    const afterParticipantAddFailureStat = await stat(storeModule.STORE_FILE);
    assert.equal(failedParticipantRows.some((participant) => participant.wipeId === 'wipe_sqlite_kda'), false);
    assert.equal(afterParticipantAddFailureStat.mtimeMs, beforeParticipantAddFailureStat.mtimeMs);
    assert.equal(afterParticipantAddFailureStatus.metrics.writes.total, beforeParticipantAddFailureStatus.metrics.writes.total);
    assert.equal(afterParticipantAddFailureStatus.metrics.sqliteWrites, beforeParticipantAddFailureStatus.metrics.sqliteWrites);
    assert.equal(queryCount(afterParticipantAddFailureStatus, 'read_store_full'), beforeParticipantAddFailureReadStoreFull);

	    const beforeParticipantEditStatus = await storeModule.storeRuntimeStatus();
    const beforeParticipantEditFullReads = {
      users: queryCount(beforeParticipantEditStatus, 'list_users'),
      members: queryCount(beforeParticipantEditStatus, 'list_members'),
      squadMembers: queryCount(beforeParticipantEditStatus, 'list_squadMembers'),
      wipes: queryCount(beforeParticipantEditStatus, 'list_wipes'),
      permissionRoles: queryCount(beforeParticipantEditStatus, 'list_permissionRoles'),
      wipeParticipants: queryCount(beforeParticipantEditStatus, 'list_wipeParticipants')
    };
    const beforeParticipantEditWipeGets = queryCount(beforeParticipantEditStatus, 'get_wipes');
    const beforeParticipantEditMemberGets = queryCount(beforeParticipantEditStatus, 'get_members');
    const beforeParticipantEditParticipantsByMember = queryCount(beforeParticipantEditStatus, 'list_wipeParticipants_memberId');
    const beforeParticipantEditParticipantsByWipe = queryCount(beforeParticipantEditStatus, 'list_wipeParticipants_wipeId');
    const beforeParticipantEditSquadMembersByMember = queryCount(beforeParticipantEditStatus, 'list_squadMembers_memberId');
	    const beforeParticipantEditStat = await stat(storeModule.STORE_FILE);
	    const participantEditResponse = await httpFetch(`${baseUrl}/wipes/wipe_sqlite_kda/participants/member_sqlite_web_participant`, {
      method: 'PUT',
      headers: {
        cookie,
        'content-type': 'application/json'
      },
      body: JSON.stringify({ status: 'not_attending' })
    });
    assert.equal(participantEditResponse.status, 200);
    const editedParticipantRows = await repositoryModule.getSqliteRecordsByJsonField('wipeParticipants', 'memberId', ['member_sqlite_web_participant'], { limit: 0 });
    const editedParticipantMember = await repositoryModule.getSqliteRecord('members', 'member_sqlite_web_participant');
    const afterParticipantEditStatus = await storeModule.storeRuntimeStatus();
    const afterParticipantEditStat = await stat(storeModule.STORE_FILE);
    assert.equal(editedParticipantRows.some((participant) => participant.wipeId === 'wipe_sqlite_kda' && participant.status === 'not_attending'), true);
    assert.equal(editedParticipantMember.lastNotAttendingWipeId, 'wipe_sqlite_kda');
	    assert.equal(afterParticipantEditStat.mtimeMs, beforeParticipantEditStat.mtimeMs);
	    assert.equal(afterParticipantEditStatus.metrics.writes.total, beforeParticipantEditStatus.metrics.writes.total);
	    assert.equal(afterParticipantEditStatus.metrics.sqliteWrites, beforeParticipantEditStatus.metrics.sqliteWrites);
    assert.equal(queryCount(afterParticipantEditStatus, 'list_users'), beforeParticipantEditFullReads.users);
    assert.equal(queryCount(afterParticipantEditStatus, 'list_members'), beforeParticipantEditFullReads.members);
    assert.equal(queryCount(afterParticipantEditStatus, 'list_squadMembers'), beforeParticipantEditFullReads.squadMembers);
    assert.equal(queryCount(afterParticipantEditStatus, 'list_wipes'), beforeParticipantEditFullReads.wipes);
    assert.equal(queryCount(afterParticipantEditStatus, 'list_permissionRoles'), beforeParticipantEditFullReads.permissionRoles + 1);
    assert.equal(queryCount(afterParticipantEditStatus, 'list_wipeParticipants'), beforeParticipantEditFullReads.wipeParticipants);
    assert.equal(queryCount(afterParticipantEditStatus, 'get_wipes') > beforeParticipantEditWipeGets, true);
    assert.equal(queryCount(afterParticipantEditStatus, 'get_members') > beforeParticipantEditMemberGets, true);
    assert.equal(queryCount(afterParticipantEditStatus, 'list_wipeParticipants_memberId') > beforeParticipantEditParticipantsByMember, true);
    assert.equal(queryCount(afterParticipantEditStatus, 'list_wipeParticipants_wipeId') > beforeParticipantEditParticipantsByWipe, true);
    assert.equal(queryCount(afterParticipantEditStatus, 'list_squadMembers_memberId') > beforeParticipantEditSquadMembersByMember, true);

	    const beforeParticipantDeleteStatus = await storeModule.storeRuntimeStatus();
    const beforeParticipantDeleteFullReads = {
      users: queryCount(beforeParticipantDeleteStatus, 'list_users'),
      members: queryCount(beforeParticipantDeleteStatus, 'list_members'),
      squadMembers: queryCount(beforeParticipantDeleteStatus, 'list_squadMembers'),
      wipes: queryCount(beforeParticipantDeleteStatus, 'list_wipes'),
      permissionRoles: queryCount(beforeParticipantDeleteStatus, 'list_permissionRoles'),
      wipeParticipants: queryCount(beforeParticipantDeleteStatus, 'list_wipeParticipants')
    };
    const beforeParticipantDeleteWipeGets = queryCount(beforeParticipantDeleteStatus, 'get_wipes');
	    const beforeParticipantDeleteMembersById = queryCount(beforeParticipantDeleteStatus, 'list_members_id');
    const beforeParticipantDeleteParticipantsByMember = queryCount(beforeParticipantDeleteStatus, 'list_wipeParticipants_memberId');
    const beforeParticipantDeleteParticipantsByWipe = queryCount(beforeParticipantDeleteStatus, 'list_wipeParticipants_wipeId');
    const beforeParticipantDeleteSquadMembersByMember = queryCount(beforeParticipantDeleteStatus, 'list_squadMembers_memberId');
	    const beforeParticipantDeleteStat = await stat(storeModule.STORE_FILE);
	    const participantDeleteResponse = await httpFetch(`${baseUrl}/wipes/wipe_sqlite_kda/participants/member_sqlite_web_participant`, {
      method: 'DELETE',
      headers: { cookie }
    });
    assert.equal(participantDeleteResponse.status, 200);
    const deletedParticipantRows = await repositoryModule.getSqliteRecordsByJsonField('wipeParticipants', 'memberId', ['member_sqlite_web_participant'], { limit: 0 });
    const afterParticipantDeleteStatus = await storeModule.storeRuntimeStatus();
    const afterParticipantDeleteStat = await stat(storeModule.STORE_FILE);
    assert.equal(deletedParticipantRows.some((participant) => participant.wipeId === 'wipe_sqlite_kda'), false);
	    assert.equal(afterParticipantDeleteStat.mtimeMs, beforeParticipantDeleteStat.mtimeMs);
	    assert.equal(afterParticipantDeleteStatus.metrics.writes.total, beforeParticipantDeleteStatus.metrics.writes.total);
	    assert.equal(afterParticipantDeleteStatus.metrics.sqliteWrites, beforeParticipantDeleteStatus.metrics.sqliteWrites);
    assert.equal(queryCount(afterParticipantDeleteStatus, 'list_users'), beforeParticipantDeleteFullReads.users);
    assert.equal(queryCount(afterParticipantDeleteStatus, 'list_members'), beforeParticipantDeleteFullReads.members);
    assert.equal(queryCount(afterParticipantDeleteStatus, 'list_squadMembers'), beforeParticipantDeleteFullReads.squadMembers);
    assert.equal(queryCount(afterParticipantDeleteStatus, 'list_wipes'), beforeParticipantDeleteFullReads.wipes);
    assert.equal(queryCount(afterParticipantDeleteStatus, 'list_permissionRoles'), beforeParticipantDeleteFullReads.permissionRoles + 1);
    assert.equal(queryCount(afterParticipantDeleteStatus, 'list_wipeParticipants'), beforeParticipantDeleteFullReads.wipeParticipants);
    assert.equal(queryCount(afterParticipantDeleteStatus, 'get_wipes') > beforeParticipantDeleteWipeGets, true);
	    assert.equal(queryCount(afterParticipantDeleteStatus, 'list_members_id') > beforeParticipantDeleteMembersById, true);
    assert.equal(queryCount(afterParticipantDeleteStatus, 'list_wipeParticipants_memberId') > beforeParticipantDeleteParticipantsByMember, true);
    assert.equal(queryCount(afterParticipantDeleteStatus, 'list_wipeParticipants_wipeId') > beforeParticipantDeleteParticipantsByWipe, true);
    assert.equal(queryCount(afterParticipantDeleteStatus, 'list_squadMembers_memberId') > beforeParticipantDeleteSquadMembersByMember, true);

    const seededWechatLifecycleLogs = Array.from({ length: 1002 }, (_, index) => ({
      id: `wechat_lifecycle_log_seed_${String(index).padStart(4, '0')}`,
      type: 'wechat_lifecycle_seed',
      actorUserId: 'system',
      actorUsername: 'system',
      ip: '127.0.0.1',
      steamId: '',
      targetId: '',
      summary: `wechat lifecycle seed ${index}`,
      metadata: {},
      createdAt: new Date(Date.UTC(2026, 0, 1, 0, 0, index)).toISOString()
    }));
    await repositoryModule.writeSqliteStorePatch({
      reason: 'sqlite_test_wechat_lifecycle_log_seed',
      upserts: { logs: seededWechatLifecycleLogs }
    });

    const beforeWechatWipeLifecycleFailureStatus = await storeModule.storeRuntimeStatus();
    const beforeWechatWipeLifecycleFailureReadStoreFull = queryCount(beforeWechatWipeLifecycleFailureStatus, 'read_store_full');
    repositoryModule.injectSqliteStorePatchFailureForTests('wechat_admin_wipe_edit', 1);
    const failedWechatWipeEditResponse = await httpFetch(`${baseUrl}/wechat/admin/wipes/current`, {
      method: 'PUT',
      headers: {
        cookie,
        'content-type': 'application/json'
      },
      body: JSON.stringify({
        name: 'SQLite KDA Wipe Failed Edit',
        serverName: 'SQLite KDA Server Failed Edit',
        startedAt: createdAt,
        vitalServerId: 'server_sqlite_kda',
        vitalWipeId: 'wipe_sqlite_kda_vital'
      })
    });
    assert.equal(failedWechatWipeEditResponse.status, 503);
    const failedWechatWipeEditPayload = await failedWechatWipeEditResponse.json();
    assert.equal(failedWechatWipeEditPayload.ok, false);
    assert.match(failedWechatWipeEditPayload.error, /微信管理档期写入暂不可用/);
    const afterWechatWipeLifecycleFailureStatus = await storeModule.storeRuntimeStatus();
    assert.equal(queryCount(afterWechatWipeLifecycleFailureStatus, 'read_store_full'), beforeWechatWipeLifecycleFailureReadStoreFull);
    const failedWechatLifecycleWipe = await repositoryModule.getSqliteRecord('wipes', 'wipe_sqlite_kda');
    assert.notEqual(failedWechatLifecycleWipe.name, 'SQLite KDA Wipe Failed Edit');
    assert.notEqual(failedWechatLifecycleWipe.serverName, 'SQLite KDA Server Failed Edit');

	    const beforeWechatWipeEditStatus = await storeModule.storeRuntimeStatus();
	    const beforeWechatWipeEditFullReads = {
	      users: queryCount(beforeWechatWipeEditStatus, 'list_users'),
	      members: queryCount(beforeWechatWipeEditStatus, 'list_members'),
	      squadMembers: queryCount(beforeWechatWipeEditStatus, 'list_squadMembers'),
	      wechatUsers: queryCount(beforeWechatWipeEditStatus, 'list_wechatUsers'),
	      wipeParticipants: queryCount(beforeWechatWipeEditStatus, 'list_wipeParticipants')
	    };
    const beforeWechatWipeEditListLogs = queryCount(beforeWechatWipeEditStatus, 'list_logs');
	    const beforeWechatWipeEditParticipantsByWipe = queryCount(beforeWechatWipeEditStatus, 'list_wipeParticipants_wipeId');
	    const beforeWechatWipeEditStat = await stat(storeModule.STORE_FILE);
	    const wechatWipeEditResponse = await httpFetch(`${baseUrl}/wechat/admin/wipes/current`, {
      method: 'PUT',
      headers: {
        cookie,
        'content-type': 'application/json'
      },
      body: JSON.stringify({
        name: 'SQLite KDA Wipe Edited',
        serverName: 'SQLite KDA Server Edited',
        startedAt: createdAt,
        vitalServerId: 'server_sqlite_kda',
        vitalWipeId: 'wipe_sqlite_kda_vital',
        directConnect: 'client.connect sqlite.example:28015',
        notes: 'SQLite lifecycle edit'
      })
    });
    assert.equal(wechatWipeEditResponse.status, 200);
    const wechatWipeEditPayload = await wechatWipeEditResponse.json();
	    assert.equal(wechatWipeEditPayload.ok, true);
	    assert.equal(wechatWipeEditPayload.wipe.id, 'wipe_sqlite_kda');
	    assert.equal(wechatWipeEditPayload.wipe.name, 'SQLite KDA Wipe Edited');
	    assert.equal(wechatWipeEditPayload.wipe.directConnect, 'client.connect sqlite.example:28015');
    const afterWechatWipeEditWriteStatus = await storeModule.storeRuntimeStatus({ sqliteSummary: false });
    assert.equal(queryCount(afterWechatWipeEditWriteStatus, 'list_logs'), beforeWechatWipeEditListLogs);
	    let wechatLifecycleWipe = await repositoryModule.getSqliteRecord('wipes', 'wipe_sqlite_kda');
	    let wechatLifecycleLogs = await repositoryModule.getSqliteCollection('logs', { limit: 0 });
	    const afterWechatWipeEditStatus = await storeModule.storeRuntimeStatus();
	    const afterWechatWipeEditStat = await stat(storeModule.STORE_FILE);
	    assert.equal(wechatLifecycleWipe.name, 'SQLite KDA Wipe Edited');
	    assert.equal(wechatLifecycleWipe.serverName, 'SQLite KDA Server Edited');
    assert.equal(wechatLifecycleLogs.length, 1000);
    assert.equal(wechatLifecycleLogs.some((log) => log.id === 'wechat_lifecycle_log_seed_0000'), false);
	    assert.equal(wechatLifecycleLogs.some((log) => log.type === 'wechat_admin_wipe_edit' && log.targetId === 'wipe_sqlite_kda'), true);
    assert.equal(afterWechatWipeEditStat.mtimeMs, beforeWechatWipeEditStat.mtimeMs);
    assert.equal(afterWechatWipeEditStatus.metrics.writes.total, beforeWechatWipeEditStatus.metrics.writes.total);
    assert.equal(afterWechatWipeEditStatus.metrics.sqliteWrites, beforeWechatWipeEditStatus.metrics.sqliteWrites);
    assert.equal(queryCount(afterWechatWipeEditStatus, 'list_users'), beforeWechatWipeEditFullReads.users);
    assert.equal(queryCount(afterWechatWipeEditStatus, 'list_members'), beforeWechatWipeEditFullReads.members);
    assert.equal(queryCount(afterWechatWipeEditStatus, 'list_squadMembers'), beforeWechatWipeEditFullReads.squadMembers);
    assert.equal(queryCount(afterWechatWipeEditStatus, 'list_wechatUsers'), beforeWechatWipeEditFullReads.wechatUsers);
    assert.equal(queryCount(afterWechatWipeEditStatus, 'list_wipeParticipants'), beforeWechatWipeEditFullReads.wipeParticipants);
    assert.equal(queryCount(afterWechatWipeEditStatus, 'list_wipeParticipants_wipeId') > beforeWechatWipeEditParticipantsByWipe, true);

    const beforeWechatWipeCloseSignupStatus = await storeModule.storeRuntimeStatus();
	    const beforeWechatWipeCloseSignupFullReads = {
	      users: queryCount(beforeWechatWipeCloseSignupStatus, 'list_users'),
	      members: queryCount(beforeWechatWipeCloseSignupStatus, 'list_members'),
	      squadMembers: queryCount(beforeWechatWipeCloseSignupStatus, 'list_squadMembers'),
	      wechatUsers: queryCount(beforeWechatWipeCloseSignupStatus, 'list_wechatUsers'),
	      wipeParticipants: queryCount(beforeWechatWipeCloseSignupStatus, 'list_wipeParticipants')
	    };
    const beforeWechatWipeCloseSignupListLogs = queryCount(beforeWechatWipeCloseSignupStatus, 'list_logs');
	    const beforeWechatWipeCloseSignupParticipantsByWipe = queryCount(beforeWechatWipeCloseSignupStatus, 'list_wipeParticipants_wipeId');
	    const beforeWechatWipeCloseSignupStat = await stat(storeModule.STORE_FILE);
	    const wechatWipeCloseSignupResponse = await httpFetch(`${baseUrl}/wechat/admin/wipes/current/close-signup`, {
      method: 'POST',
      headers: { cookie }
    });
    assert.equal(wechatWipeCloseSignupResponse.status, 200);
	    const wechatWipeCloseSignupPayload = await wechatWipeCloseSignupResponse.json();
	    assert.equal(wechatWipeCloseSignupPayload.ok, true);
	    assert.equal(wechatWipeCloseSignupPayload.wipe.signupOpen, false);
    const afterWechatWipeCloseSignupWriteStatus = await storeModule.storeRuntimeStatus({ sqliteSummary: false });
    assert.equal(queryCount(afterWechatWipeCloseSignupWriteStatus, 'list_logs'), beforeWechatWipeCloseSignupListLogs);
	    wechatLifecycleWipe = await repositoryModule.getSqliteRecord('wipes', 'wipe_sqlite_kda');
	    wechatLifecycleLogs = await repositoryModule.getSqliteCollection('logs', { limit: 0 });
    const afterWechatWipeCloseSignupStatus = await storeModule.storeRuntimeStatus();
    const afterWechatWipeCloseSignupStat = await stat(storeModule.STORE_FILE);
    assert.equal(wechatLifecycleWipe.signupStatus, 'closed');
    assert.equal(wechatLifecycleLogs.some((log) => log.type === 'wechat_admin_wipe_signup_close' && log.targetId === 'wipe_sqlite_kda'), true);
    assert.equal(afterWechatWipeCloseSignupStat.mtimeMs, beforeWechatWipeCloseSignupStat.mtimeMs);
    assert.equal(afterWechatWipeCloseSignupStatus.metrics.writes.total, beforeWechatWipeCloseSignupStatus.metrics.writes.total);
    assert.equal(afterWechatWipeCloseSignupStatus.metrics.sqliteWrites, beforeWechatWipeCloseSignupStatus.metrics.sqliteWrites);
    assert.equal(queryCount(afterWechatWipeCloseSignupStatus, 'list_users'), beforeWechatWipeCloseSignupFullReads.users);
    assert.equal(queryCount(afterWechatWipeCloseSignupStatus, 'list_members'), beforeWechatWipeCloseSignupFullReads.members);
    assert.equal(queryCount(afterWechatWipeCloseSignupStatus, 'list_squadMembers'), beforeWechatWipeCloseSignupFullReads.squadMembers);
    assert.equal(queryCount(afterWechatWipeCloseSignupStatus, 'list_wechatUsers'), beforeWechatWipeCloseSignupFullReads.wechatUsers);
    assert.equal(queryCount(afterWechatWipeCloseSignupStatus, 'list_wipeParticipants'), beforeWechatWipeCloseSignupFullReads.wipeParticipants);
    assert.equal(queryCount(afterWechatWipeCloseSignupStatus, 'list_wipeParticipants_wipeId') > beforeWechatWipeCloseSignupParticipantsByWipe, true);

    const beforeWechatWipePublishStatus = await storeModule.storeRuntimeStatus();
	    const beforeWechatWipePublishFullReads = {
	      users: queryCount(beforeWechatWipePublishStatus, 'list_users'),
	      members: queryCount(beforeWechatWipePublishStatus, 'list_members'),
	      squadMembers: queryCount(beforeWechatWipePublishStatus, 'list_squadMembers'),
	      wechatUsers: queryCount(beforeWechatWipePublishStatus, 'list_wechatUsers'),
	      wipeParticipants: queryCount(beforeWechatWipePublishStatus, 'list_wipeParticipants'),
	      wechatNotifications: queryCount(beforeWechatWipePublishStatus, 'list_wechatNotifications'),
	      operationRuns: queryCount(beforeWechatWipePublishStatus, 'list_operationRuns')
	    };
    const beforeWechatWipePublishScopedReads = {
      membersByStatus: queryCount(beforeWechatWipePublishStatus, 'list_members_memberStatus'),
      membersMissingStatus: queryCount(beforeWechatWipePublishStatus, 'list_members_memberStatus_missing'),
      wechatUsersByMember: queryCount(beforeWechatWipePublishStatus, 'list_wechatUsers_memberId'),
      wechatNotificationsByApplication: queryCount(beforeWechatWipePublishStatus, 'list_wechatNotifications_applicationId')
    };
    const beforeWechatWipePublishListLogs = queryCount(beforeWechatWipePublishStatus, 'list_logs');
	    const beforeWechatWipePublishParticipantsByWipe = queryCount(beforeWechatWipePublishStatus, 'list_wipeParticipants_wipeId');
	    const beforeWechatWipePublishStat = await stat(storeModule.STORE_FILE);
	    const wechatWipePublishResponse = await httpFetch(`${baseUrl}/wechat/admin/wipes/current/publish`, {
      method: 'POST',
      headers: { cookie }
    });
    assert.equal(wechatWipePublishResponse.status, 200);
	    const wechatWipePublishPayload = await wechatWipePublishResponse.json();
	    assert.equal(wechatWipePublishPayload.ok, true);
	    assert.equal(wechatWipePublishPayload.wipe.signupOpen, true);
    const afterWechatWipePublishWriteStatus = await storeModule.storeRuntimeStatus({ sqliteSummary: false });
    assert.equal(queryCount(afterWechatWipePublishWriteStatus, 'list_logs'), beforeWechatWipePublishListLogs);
	    wechatLifecycleWipe = await repositoryModule.getSqliteRecord('wipes', 'wipe_sqlite_kda');
    wechatLifecycleLogs = await repositoryModule.getSqliteCollection('logs', { limit: 0 });
    const afterWechatWipePublishStatus = await storeModule.storeRuntimeStatus();
    const afterWechatWipePublishStat = await stat(storeModule.STORE_FILE);
    assert.equal(wechatLifecycleWipe.signupStatus, 'open');
    assert.equal(wechatLifecycleLogs.some((log) => log.type === 'wechat_admin_wipe_publish' && log.targetId === 'wipe_sqlite_kda'), true);
    assert.equal(afterWechatWipePublishStat.mtimeMs, beforeWechatWipePublishStat.mtimeMs);
    assert.equal(afterWechatWipePublishStatus.metrics.writes.total, beforeWechatWipePublishStatus.metrics.writes.total);
    assert.equal(afterWechatWipePublishStatus.metrics.sqliteWrites, beforeWechatWipePublishStatus.metrics.sqliteWrites);
    assert.equal(queryCount(afterWechatWipePublishStatus, 'list_users'), beforeWechatWipePublishFullReads.users);
    assert.equal(queryCount(afterWechatWipePublishStatus, 'list_members'), beforeWechatWipePublishFullReads.members);
    assert.equal(queryCount(afterWechatWipePublishStatus, 'list_squadMembers'), beforeWechatWipePublishFullReads.squadMembers);
    assert.equal(queryCount(afterWechatWipePublishStatus, 'list_wechatUsers'), beforeWechatWipePublishFullReads.wechatUsers);
    assert.equal(queryCount(afterWechatWipePublishStatus, 'list_wipeParticipants'), beforeWechatWipePublishFullReads.wipeParticipants);
    assert.equal(queryCount(afterWechatWipePublishStatus, 'list_wechatNotifications'), beforeWechatWipePublishFullReads.wechatNotifications);
    assert.equal(queryCount(afterWechatWipePublishStatus, 'list_operationRuns'), beforeWechatWipePublishFullReads.operationRuns);
    assert.equal(queryCount(afterWechatWipePublishStatus, 'list_members_memberStatus') > beforeWechatWipePublishScopedReads.membersByStatus, true);
    assert.equal(queryCount(afterWechatWipePublishStatus, 'list_members_memberStatus_missing') > beforeWechatWipePublishScopedReads.membersMissingStatus, true);
    assert.equal(queryCount(afterWechatWipePublishStatus, 'list_wechatUsers_memberId') > beforeWechatWipePublishScopedReads.wechatUsersByMember, true);
    assert.equal(queryCount(afterWechatWipePublishStatus, 'list_wechatNotifications_applicationId') > beforeWechatWipePublishScopedReads.wechatNotificationsByApplication, true);
    assert.equal(queryCount(afterWechatWipePublishStatus, 'list_wipeParticipants_wipeId') > beforeWechatWipePublishParticipantsByWipe, true);

	    const beforeWechatAdminAddStatus = await storeModule.storeRuntimeStatus();
	    const beforeWechatAdminAddFullReads = {
	      users: queryCount(beforeWechatAdminAddStatus, 'list_users'),
	      members: queryCount(beforeWechatAdminAddStatus, 'list_members'),
	      squads: queryCount(beforeWechatAdminAddStatus, 'list_squads'),
	      squadMembers: queryCount(beforeWechatAdminAddStatus, 'list_squadMembers'),
	      wipes: queryCount(beforeWechatAdminAddStatus, 'list_wipes'),
	      permissionRoles: queryCount(beforeWechatAdminAddStatus, 'list_permissionRoles'),
	      wipeParticipants: queryCount(beforeWechatAdminAddStatus, 'list_wipeParticipants')
	    };
	    const beforeWechatAdminAddScopedReads = {
	      wipesByStatus: queryCount(beforeWechatAdminAddStatus, 'list_wipes_status'),
	      membersById: queryCount(beforeWechatAdminAddStatus, 'list_members_id'),
	      membersWithSteamId: queryCount(beforeWechatAdminAddStatus, 'list_members_steamId_present'),
	      squadMembersByMember: queryCount(beforeWechatAdminAddStatus, 'list_squadMembers_memberId'),
	      wipeParticipantsByWipe: queryCount(beforeWechatAdminAddStatus, 'list_wipeParticipants_wipeId'),
	      kdaRowsByWipe: queryCount(beforeWechatAdminAddStatus, 'list_kdaRows_wipeId'),
	      kdaSnapshotsByWipe: queryCount(beforeWechatAdminAddStatus, 'list_kdaSnapshots_wipeId')
	    };
	    const beforeWechatAdminAddStat = await stat(storeModule.STORE_FILE);
	    const wechatAdminAddResponse = await httpFetch(`${baseUrl}/wechat/admin/wipes/current/participants`, {
      method: 'POST',
      headers: {
        cookie,
        'content-type': 'application/json'
      },
      body: JSON.stringify({
        memberIds: ['member_sqlite_wechat_admin_participant'],
        status: 'on_time',
        note: 'SQLite wechat admin direct add'
      })
    });
    assert.equal(wechatAdminAddResponse.status, 200);
    const wechatAdminAddPayload = await wechatAdminAddResponse.json();
    assert.equal(wechatAdminAddPayload.ok, true);
    assert.equal(wechatAdminAddPayload.added, 1);
    assert.equal(wechatAdminAddPayload.participants.some((participant) => (
      participant.memberId === 'member_sqlite_wechat_admin_participant' &&
      participant.status === 'on_time' &&
      participant.source === 'admin' &&
      participant.note === 'SQLite wechat admin direct add'
    )), true);
    let wechatAdminParticipantRows = await repositoryModule.getSqliteRecordsByJsonField('wipeParticipants', 'memberId', ['member_sqlite_wechat_admin_participant'], { limit: 0 });
    let wechatAdminLogs = await repositoryModule.getSqliteCollection('logs', { limit: 0 });
    const afterWechatAdminAddStatus = await storeModule.storeRuntimeStatus();
    const afterWechatAdminAddStat = await stat(storeModule.STORE_FILE);
    assert.equal(wechatAdminParticipantRows.some((participant) => participant.wipeId === 'wipe_sqlite_kda' && participant.note === 'SQLite wechat admin direct add'), true);
	    assert.equal(wechatAdminLogs.some((log) => log.type === 'wechat_admin_wipe_signup_add' && log.targetId === 'wipe_sqlite_kda'), true);
	    assert.equal(afterWechatAdminAddStat.mtimeMs, beforeWechatAdminAddStat.mtimeMs);
	    assert.equal(afterWechatAdminAddStatus.metrics.writes.total, beforeWechatAdminAddStatus.metrics.writes.total);
	    assert.equal(afterWechatAdminAddStatus.metrics.sqliteWrites, beforeWechatAdminAddStatus.metrics.sqliteWrites);
	    assert.equal(queryCount(afterWechatAdminAddStatus, 'list_users'), beforeWechatAdminAddFullReads.users);
	    assert.equal(queryCount(afterWechatAdminAddStatus, 'list_members'), beforeWechatAdminAddFullReads.members);
	    assert.equal(queryCount(afterWechatAdminAddStatus, 'list_squads'), beforeWechatAdminAddFullReads.squads);
	    assert.equal(queryCount(afterWechatAdminAddStatus, 'list_squadMembers'), beforeWechatAdminAddFullReads.squadMembers);
	    assert.equal(queryCount(afterWechatAdminAddStatus, 'list_wipes'), beforeWechatAdminAddFullReads.wipes);
	    assert.equal(queryCount(afterWechatAdminAddStatus, 'list_permissionRoles'), beforeWechatAdminAddFullReads.permissionRoles + 1);
	    assert.equal(queryCount(afterWechatAdminAddStatus, 'list_wipeParticipants'), beforeWechatAdminAddFullReads.wipeParticipants);
	    assert.equal(queryCount(afterWechatAdminAddStatus, 'list_wipes_status') > beforeWechatAdminAddScopedReads.wipesByStatus, true);
	    assert.equal(queryCount(afterWechatAdminAddStatus, 'list_members_id') > beforeWechatAdminAddScopedReads.membersById, true);
	    assert.equal(queryCount(afterWechatAdminAddStatus, 'list_members_steamId_present') > beforeWechatAdminAddScopedReads.membersWithSteamId, true);
	    assert.equal(queryCount(afterWechatAdminAddStatus, 'list_squadMembers_memberId') > beforeWechatAdminAddScopedReads.squadMembersByMember, true);
	    assert.equal(queryCount(afterWechatAdminAddStatus, 'list_wipeParticipants_wipeId') > beforeWechatAdminAddScopedReads.wipeParticipantsByWipe, true);
	    assert.equal(queryCount(afterWechatAdminAddStatus, 'list_kdaRows_wipeId') > beforeWechatAdminAddScopedReads.kdaRowsByWipe, true);
	    assert.equal(queryCount(afterWechatAdminAddStatus, 'list_kdaSnapshots_wipeId') > beforeWechatAdminAddScopedReads.kdaSnapshotsByWipe, true);

	    const beforeWechatAdminEditStatus = await storeModule.storeRuntimeStatus();
    const beforeWechatAdminEditFullReads = {
      users: queryCount(beforeWechatAdminEditStatus, 'list_users'),
      members: queryCount(beforeWechatAdminEditStatus, 'list_members'),
      squads: queryCount(beforeWechatAdminEditStatus, 'list_squads'),
      squadMembers: queryCount(beforeWechatAdminEditStatus, 'list_squadMembers'),
      wipes: queryCount(beforeWechatAdminEditStatus, 'list_wipes'),
      permissionRoles: queryCount(beforeWechatAdminEditStatus, 'list_permissionRoles'),
      wipeParticipants: queryCount(beforeWechatAdminEditStatus, 'list_wipeParticipants')
    };
    const beforeWechatAdminEditWipesByStatus = queryCount(beforeWechatAdminEditStatus, 'list_wipes_status');
    const beforeWechatAdminEditWipeGets = queryCount(beforeWechatAdminEditStatus, 'get_wipes');
	    const beforeWechatAdminEditParticipantsByWipe = queryCount(beforeWechatAdminEditStatus, 'list_wipeParticipants_wipeId');
	    const beforeWechatAdminEditSquadMembersByMember = queryCount(beforeWechatAdminEditStatus, 'list_squadMembers_memberId');
	    const beforeWechatAdminEditMembersWithSteam = queryCount(beforeWechatAdminEditStatus, 'list_members_steamId_present');
	    const beforeWechatAdminEditStat = await stat(storeModule.STORE_FILE);
	    const wechatAdminEditResponse = await httpFetch(`${baseUrl}/wechat/admin/wipes/current/participants/member_sqlite_wechat_admin_participant`, {
      method: 'PUT',
      headers: {
        cookie,
        'content-type': 'application/json'
      },
      body: JSON.stringify({
        status: 'not_attending',
        note: 'SQLite wechat admin direct edit'
      })
    });
    assert.equal(wechatAdminEditResponse.status, 200);
    const wechatAdminEditPayload = await wechatAdminEditResponse.json();
    assert.equal(wechatAdminEditPayload.ok, true);
    wechatAdminParticipantRows = await repositoryModule.getSqliteRecordsByJsonField('wipeParticipants', 'memberId', ['member_sqlite_wechat_admin_participant'], { limit: 0 });
    const wechatAdminEditedMember = await repositoryModule.getSqliteRecord('members', 'member_sqlite_wechat_admin_participant');
    wechatAdminLogs = await repositoryModule.getSqliteCollection('logs', { limit: 0 });
    const afterWechatAdminEditStatus = await storeModule.storeRuntimeStatus();
    const afterWechatAdminEditStat = await stat(storeModule.STORE_FILE);
    assert.equal(wechatAdminParticipantRows.some((participant) => participant.wipeId === 'wipe_sqlite_kda' && participant.status === 'not_attending'), true);
    assert.equal(wechatAdminEditedMember.lastNotAttendingWipeId, 'wipe_sqlite_kda');
    assert.equal(wechatAdminLogs.some((log) => log.type === 'wechat_admin_wipe_signup_edit' && log.targetId === 'wipe_sqlite_kda'), true);
	    assert.equal(afterWechatAdminEditStat.mtimeMs, beforeWechatAdminEditStat.mtimeMs);
	    assert.equal(afterWechatAdminEditStatus.metrics.writes.total, beforeWechatAdminEditStatus.metrics.writes.total);
	    assert.equal(afterWechatAdminEditStatus.metrics.sqliteWrites, beforeWechatAdminEditStatus.metrics.sqliteWrites);
	    assert.equal(queryCount(afterWechatAdminEditStatus, 'list_users'), beforeWechatAdminEditFullReads.users);
	    assert.equal(queryCount(afterWechatAdminEditStatus, 'list_members'), beforeWechatAdminEditFullReads.members);
	    assert.equal(queryCount(afterWechatAdminEditStatus, 'list_squads'), beforeWechatAdminEditFullReads.squads);
    assert.equal(queryCount(afterWechatAdminEditStatus, 'list_squadMembers'), beforeWechatAdminEditFullReads.squadMembers);
    assert.equal(queryCount(afterWechatAdminEditStatus, 'list_wipes'), beforeWechatAdminEditFullReads.wipes);
    assert.equal(queryCount(afterWechatAdminEditStatus, 'list_permissionRoles'), beforeWechatAdminEditFullReads.permissionRoles + 1);
    assert.equal(queryCount(afterWechatAdminEditStatus, 'list_wipeParticipants'), beforeWechatAdminEditFullReads.wipeParticipants);
    assert.equal(queryCount(afterWechatAdminEditStatus, 'get_wipes') > beforeWechatAdminEditWipeGets, true);
    assert.equal(queryCount(afterWechatAdminEditStatus, 'list_wipes_status') > beforeWechatAdminEditWipesByStatus, true);
	    assert.equal(queryCount(afterWechatAdminEditStatus, 'list_wipeParticipants_wipeId') > beforeWechatAdminEditParticipantsByWipe, true);
	    assert.equal(queryCount(afterWechatAdminEditStatus, 'list_squadMembers_memberId') > beforeWechatAdminEditSquadMembersByMember, true);
	    assert.equal(queryCount(afterWechatAdminEditStatus, 'list_members_steamId_present') > beforeWechatAdminEditMembersWithSteam, true);

    const beforeWechatAdminDeleteStatus = await storeModule.storeRuntimeStatus();
    const beforeWechatAdminDeleteFullReads = {
      users: queryCount(beforeWechatAdminDeleteStatus, 'list_users'),
      members: queryCount(beforeWechatAdminDeleteStatus, 'list_members'),
      squads: queryCount(beforeWechatAdminDeleteStatus, 'list_squads'),
      squadMembers: queryCount(beforeWechatAdminDeleteStatus, 'list_squadMembers'),
      wipes: queryCount(beforeWechatAdminDeleteStatus, 'list_wipes'),
      permissionRoles: queryCount(beforeWechatAdminDeleteStatus, 'list_permissionRoles'),
      wipeParticipants: queryCount(beforeWechatAdminDeleteStatus, 'list_wipeParticipants')
    };
    const beforeWechatAdminDeleteWipesByStatus = queryCount(beforeWechatAdminDeleteStatus, 'list_wipes_status');
    const beforeWechatAdminDeleteWipeGets = queryCount(beforeWechatAdminDeleteStatus, 'get_wipes');
	    const beforeWechatAdminDeleteParticipantsByWipe = queryCount(beforeWechatAdminDeleteStatus, 'list_wipeParticipants_wipeId');
	    const beforeWechatAdminDeleteSquadMembersByMember = queryCount(beforeWechatAdminDeleteStatus, 'list_squadMembers_memberId');
	    const beforeWechatAdminDeleteMembersWithSteam = queryCount(beforeWechatAdminDeleteStatus, 'list_members_steamId_present');
	    const beforeWechatAdminDeleteStat = await stat(storeModule.STORE_FILE);
	    const wechatAdminDeleteResponse = await httpFetch(`${baseUrl}/wechat/admin/wipes/current/participants/member_sqlite_wechat_admin_participant`, {
      method: 'DELETE',
      headers: { cookie }
    });
    assert.equal(wechatAdminDeleteResponse.status, 200);
    const wechatAdminDeletePayload = await wechatAdminDeleteResponse.json();
    assert.equal(wechatAdminDeletePayload.ok, true);
    assert.equal(wechatAdminDeletePayload.participants.some((participant) => participant.memberId === 'member_sqlite_wechat_admin_participant'), false);
    wechatAdminParticipantRows = await repositoryModule.getSqliteRecordsByJsonField('wipeParticipants', 'memberId', ['member_sqlite_wechat_admin_participant'], { limit: 0 });
    wechatAdminLogs = await repositoryModule.getSqliteCollection('logs', { limit: 0 });
    const afterWechatAdminDeleteStatus = await storeModule.storeRuntimeStatus();
    const afterWechatAdminDeleteStat = await stat(storeModule.STORE_FILE);
    assert.equal(wechatAdminParticipantRows.some((participant) => participant.wipeId === 'wipe_sqlite_kda'), false);
    assert.equal(wechatAdminLogs.some((log) => log.type === 'wechat_admin_wipe_signup_remove' && log.targetId === 'wipe_sqlite_kda'), true);
	    assert.equal(afterWechatAdminDeleteStat.mtimeMs, beforeWechatAdminDeleteStat.mtimeMs);
	    assert.equal(afterWechatAdminDeleteStatus.metrics.writes.total, beforeWechatAdminDeleteStatus.metrics.writes.total);
	    assert.equal(afterWechatAdminDeleteStatus.metrics.sqliteWrites, beforeWechatAdminDeleteStatus.metrics.sqliteWrites);
	    assert.equal(queryCount(afterWechatAdminDeleteStatus, 'list_users'), beforeWechatAdminDeleteFullReads.users);
	    assert.equal(queryCount(afterWechatAdminDeleteStatus, 'list_members'), beforeWechatAdminDeleteFullReads.members);
	    assert.equal(queryCount(afterWechatAdminDeleteStatus, 'list_squads'), beforeWechatAdminDeleteFullReads.squads);
    assert.equal(queryCount(afterWechatAdminDeleteStatus, 'list_squadMembers'), beforeWechatAdminDeleteFullReads.squadMembers);
    assert.equal(queryCount(afterWechatAdminDeleteStatus, 'list_wipes'), beforeWechatAdminDeleteFullReads.wipes);
    assert.equal(queryCount(afterWechatAdminDeleteStatus, 'list_permissionRoles'), beforeWechatAdminDeleteFullReads.permissionRoles + 1);
    assert.equal(queryCount(afterWechatAdminDeleteStatus, 'list_wipeParticipants'), beforeWechatAdminDeleteFullReads.wipeParticipants);
    assert.equal(queryCount(afterWechatAdminDeleteStatus, 'get_wipes') > beforeWechatAdminDeleteWipeGets, true);
    assert.equal(queryCount(afterWechatAdminDeleteStatus, 'list_wipes_status') > beforeWechatAdminDeleteWipesByStatus, true);
	    assert.equal(queryCount(afterWechatAdminDeleteStatus, 'list_wipeParticipants_wipeId') > beforeWechatAdminDeleteParticipantsByWipe, true);
	    assert.equal(queryCount(afterWechatAdminDeleteStatus, 'list_squadMembers_memberId') > beforeWechatAdminDeleteSquadMembersByMember, true);
	    assert.equal(queryCount(afterWechatAdminDeleteStatus, 'list_members_steamId_present') > beforeWechatAdminDeleteMembersWithSteam, true);

	    const beforeCloseStatus = await storeModule.storeRuntimeStatus();
    const closeResponse = await httpFetch(`${baseUrl}/wipes/wipe_sqlite_kda/close`, {
      method: 'POST',
      headers: { cookie }
    });
    assert.equal(closeResponse.status, 200);
    const closePayload = await closeResponse.json();
    assert.equal(closePayload.ok, true);
    assert.equal(closePayload.wipe.status, 'closed');

    const closedWipe = await repositoryModule.getSqliteRecord('wipes', 'wipe_sqlite_kda');
    const settlements = await repositoryModule.getSqliteRecordsByJsonField('wipeSettlements', 'wipeId', ['wipe_sqlite_kda'], { limit: 0 });
    const cachedStore = await storeModule.readStore();
    const afterCloseStatus = await storeModule.storeRuntimeStatus();
    assert.equal(closedWipe.status, 'closed');
    assert.equal(settlements.length, 1);
    assert.equal(cachedStore.kdaRows.some((row) => row.id === 'kda_row_sqlite_other'), true);
    assert.equal(
      afterCloseStatus.sqlite.compatibility.syncStoreChangesToSqlite,
      beforeCloseStatus.sqlite.compatibility.syncStoreChangesToSqlite
    );
    assert.equal(afterCloseStatus.metrics.sqliteWrites, beforeCloseStatus.metrics.sqliteWrites);
  } finally {
    if (server) await new Promise((resolve) => server.close(resolve));
    globalThis.fetch = originalFetch;
    const sqliteModule = await import('../server/storage/sqlite.js');
    await sqliteModule.closeSqliteDatabasesForTests();
    Object.assign(process.env, previousEnv);
    for (const [key, value] of Object.entries(previousEnv)) {
      if (value === undefined) delete process.env[key];
    }
    await rm(dataDir, { recursive: true, force: true });
  }
});

test('sqlite-primary wechat entry writes use direct SQLite patch writes', async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'nb-clan-sqlite-wechat-'));
  const previousEnv = {
    NB_DATA_DIR: process.env.NB_DATA_DIR,
    NB_ROOT_PASSWORD: process.env.NB_ROOT_PASSWORD,
    NB_STORAGE_MODE: process.env.NB_STORAGE_MODE,
    NB_SQLITE_FILE: process.env.NB_SQLITE_FILE,
    NB_WECHAT_DEV_LOGIN: process.env.NB_WECHAT_DEV_LOGIN,
    NB_DISABLE_BACKGROUND_JOBS: process.env.NB_DISABLE_BACKGROUND_JOBS,
    NB_DISABLE_EXTERNAL_VITAL: process.env.NB_DISABLE_EXTERNAL_VITAL,
    NB_RUST_KDA_PROVIDER: process.env.NB_RUST_KDA_PROVIDER,
    NB_RUST_KDA_BASE_URL: process.env.NB_RUST_KDA_BASE_URL,
    NB_RUSTPLUS_RELAY_CHAT_FLUSH_INTERVAL_MS: process.env.NB_RUSTPLUS_RELAY_CHAT_FLUSH_INTERVAL_MS,
    NB_WECHAT_APPID: process.env.NB_WECHAT_APPID,
    NB_WECHAT_SECRET: process.env.NB_WECHAT_SECRET,
    NB_WECHAT_APP_SECRET: process.env.NB_WECHAT_APP_SECRET,
    NB_WECHAT_API_BASE_URL: process.env.NB_WECHAT_API_BASE_URL,
    NB_WECHAT_TEMPLATE_JOIN_REVIEW_RESULT: process.env.NB_WECHAT_TEMPLATE_JOIN_REVIEW_RESULT,
    NB_WECHAT_TEMPLATE_ADMIN_JOIN_REVIEW: process.env.NB_WECHAT_TEMPLATE_ADMIN_JOIN_REVIEW,
    NB_WECHAT_TEMPLATE_WIPE_SIGNUP_STATUS: process.env.NB_WECHAT_TEMPLATE_WIPE_SIGNUP_STATUS
  };
  const originalFetch = globalThis.fetch;
  const httpFetch = originalFetch.bind(globalThis);
  process.env.NB_DATA_DIR = dataDir;
  process.env.NB_ROOT_PASSWORD = 'RootPass123!';
  process.env.NB_STORAGE_MODE = 'sqlite-primary';
  process.env.NB_SQLITE_FILE = path.join(dataDir, 'nb-clan.sqlite');
  process.env.NB_WECHAT_DEV_LOGIN = '1';
  process.env.NB_DISABLE_BACKGROUND_JOBS = '1';
  process.env.NB_DISABLE_EXTERNAL_VITAL = '1';
  process.env.NB_RUST_KDA_PROVIDER = 'http';
  process.env.NB_RUST_KDA_BASE_URL = 'https://rust-kda.example';
  process.env.NB_RUSTPLUS_RELAY_CHAT_FLUSH_INTERVAL_MS = '0';
  delete process.env.NB_WECHAT_APPID;
  delete process.env.NB_WECHAT_SECRET;
  delete process.env.NB_WECHAT_APP_SECRET;
  delete process.env.NB_WECHAT_API_BASE_URL;
  delete process.env.NB_WECHAT_TEMPLATE_JOIN_REVIEW_RESULT;
  delete process.env.NB_WECHAT_TEMPLATE_ADMIN_JOIN_REVIEW;
  delete process.env.NB_WECHAT_TEMPLATE_WIPE_SIGNUP_STATUS;

  let server = null;
  let apiModule = null;
  let releaseJoinInventory = () => {};
  try {
    const storeModule = await uniqueImport('../server/store.js');
    apiModule = await uniqueImport('../server/api.js');
    const authModule = await uniqueImport('../server/auth.js');
    const wechatStoreModule = await import('../server/wechat-store.js');
    await storeModule.ensureStore();
    const relayToken = 'RustplusRelayToken123!';
    const relayTokenHash = await storeModule.hashPassword(relayToken);
    await storeModule.updateStore((store) => {
      store.settings.wechat ||= {};
      store.settings.wechat.subscriptionTemplates = {
        ...(store.settings.wechat.subscriptionTemplates || {}),
        joinReviewResult: 'sqlite_tmpl_join_review',
        adminJoinReview: 'sqlite_tmpl_admin_join_review',
        wipeSignupStatus: 'sqlite_tmpl_wipe_signup_status'
      };
      store.settings.rustplusRelay ||= {};
      store.settings.rustplusRelay.tokenHash = relayTokenHash;
      store.settings.rustplusRelay.tokenUpdatedAt = new Date().toISOString();
      store.members.unshift({
        id: 'member_sqlite_bind_target',
        steamId: '76561198000000001',
        rawInput: '76561198000000001',
        customName: '',
        steamNickname: 'SQLite Bind Target',
        avatar: '',
        discordId: '',
        wechatId: '',
        wechatUserId: '',
        phone: '',
        notes: '',
        specialty: [],
        specialties: [],
        battlemetricsId: '',
        memberStatus: 'active',
        invitedByUserId: '',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
      });
    });
    const beforeStatus = await storeModule.storeRuntimeStatus();

    const app = express();
    app.use('/api', apiModule.createApiRouter());
    server = createServer(app);
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const baseUrl = `http://127.0.0.1:${server.address().port}/api`;
    const writeCount = (status, name) => status.sqlite?.writes?.byName?.[name]?.total || 0;

    const loginResponse = await httpFetch(`${baseUrl}/wechat/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        code: 'sqlite-wechat-login',
        profile: { nickname: 'Before', avatarUrl: 'https://example.com/a.png' }
      })
    });
    assert.equal(loginResponse.status, 200);
    const loginPayload = await loginResponse.json();
    assert.equal(loginPayload.ok, true);
    assert.ok(loginPayload.sessionToken);

    const beforeProfileStatus = await storeModule.storeRuntimeStatus();
    const beforeProfileListWechatUsers = beforeProfileStatus.sqlite.queries.byName.list_wechatUsers?.total || 0;
    const beforeProfileListMembers = beforeProfileStatus.sqlite.queries.byName.list_members?.total || 0;
    const beforeProfileGetWechatUsers = beforeProfileStatus.sqlite.queries.byName.get_wechatUsers?.total || 0;
    const beforeWechatProfileEditWrite = writeCount(beforeProfileStatus, 'wechat_profile_edit');
    const beforeWechatProfileEditLogTrimWrite = writeCount(beforeProfileStatus, 'wechat_profile_edit_log_trim');
    const profileResponse = await httpFetch(`${baseUrl}/wechat/profile`, {
      method: 'PUT',
      headers: {
        authorization: `Bearer ${loginPayload.sessionToken}`,
        'content-type': 'application/json'
      },
      body: JSON.stringify({
        nickname: 'After',
        phone: '13800000000'
      })
    });
    assert.equal(profileResponse.status, 200);
    const profilePayload = await profileResponse.json();
    assert.equal(profilePayload.ok, true);
    assert.equal(profilePayload.wechatUser.nickname, 'After');
    assert.equal(profilePayload.wechatUser.phone, '13800000000');
    const afterProfileStatus = await storeModule.storeRuntimeStatus();
    assert.equal(afterProfileStatus.sqlite.queries.byName.list_wechatUsers?.total || 0, beforeProfileListWechatUsers);
    assert.equal(afterProfileStatus.sqlite.queries.byName.list_members?.total || 0, beforeProfileListMembers);
    assert.equal((afterProfileStatus.sqlite.queries.byName.get_wechatUsers?.total || 0) > beforeProfileGetWechatUsers, true);
    assert.equal(writeCount(afterProfileStatus, 'wechat_profile_edit'), beforeWechatProfileEditWrite + 1);
    assert.equal(writeCount(afterProfileStatus, 'wechat_profile_edit_log_trim'), beforeWechatProfileEditLogTrimWrite);

    const beforeAvatarStatus = await storeModule.storeRuntimeStatus();
    const beforeAvatarListWechatUsers = beforeAvatarStatus.sqlite.queries.byName.list_wechatUsers?.total || 0;
    const beforeAvatarListUploads = beforeAvatarStatus.sqlite.queries.byName.list_uploads?.total || 0;
    const beforeAvatarOwnerReads = beforeAvatarStatus.sqlite.queries.byName.list_uploads_ownerId?.total || 0;
    const beforeWechatAvatarUploadWrite = writeCount(beforeAvatarStatus, 'wechat_avatar_upload');
    const beforeWechatAvatarUploadLogTrimWrite = writeCount(beforeAvatarStatus, 'wechat_avatar_upload_log_trim');
    const avatarResponse = await httpFetch(`${baseUrl}/wechat/avatar`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${loginPayload.sessionToken}`,
        'content-type': 'application/json'
      },
      body: JSON.stringify({
        mimeType: 'image/png',
        originalName: 'avatar.png',
        dataUrl: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII='
      })
    });
    assert.equal(avatarResponse.status, 200);
    const avatarPayload = await avatarResponse.json();
    assert.equal(avatarPayload.ok, true);
    assert.equal(avatarPayload.upload.kind, 'wechat_avatar');
    assert.match(avatarPayload.wechatUser.avatarUrl, /^\/uploads\/wechat-avatars\/upload_/);
    const afterAvatarStatus = await storeModule.storeRuntimeStatus();
    assert.equal(afterAvatarStatus.sqlite.queries.byName.list_wechatUsers?.total || 0, beforeAvatarListWechatUsers);
    assert.equal(afterAvatarStatus.sqlite.queries.byName.list_uploads?.total || 0, beforeAvatarListUploads);
    assert.equal((afterAvatarStatus.sqlite.queries.byName.list_uploads_ownerId?.total || 0) > beforeAvatarOwnerReads, true);
    assert.equal(writeCount(afterAvatarStatus, 'wechat_avatar_upload'), beforeWechatAvatarUploadWrite + 1);
    assert.equal(writeCount(afterAvatarStatus, 'wechat_avatar_upload_log_trim'), beforeWechatAvatarUploadLogTrimWrite);

    const beforeNotificationSettingsStatus = await storeModule.storeRuntimeStatus();
    const beforeNotificationSettingsListWechatUsers = beforeNotificationSettingsStatus.sqlite.queries.byName.list_wechatUsers?.total || 0;
    const beforeNotificationSettingsGetWechatUsers = beforeNotificationSettingsStatus.sqlite.queries.byName.get_wechatUsers?.total || 0;
    const notificationSettingsResponse = await httpFetch(`${baseUrl}/wechat/notification-settings`, {
      headers: { authorization: `Bearer ${loginPayload.sessionToken}` }
    });
    assert.equal(notificationSettingsResponse.status, 200);
    const notificationSettingsPayload = await notificationSettingsResponse.json();
    assert.equal(notificationSettingsPayload.ok, true);
    assert.equal(notificationSettingsPayload.templates.joinReviewResult, 'sqlite_tmpl_join_review');
    assert.equal('bindReviewResult' in notificationSettingsPayload.templates, false);
    const afterNotificationSettingsStatus = await storeModule.storeRuntimeStatus();
    assert.equal(afterNotificationSettingsStatus.sqlite.queries.byName.list_wechatUsers?.total || 0, beforeNotificationSettingsListWechatUsers);
    assert.equal((afterNotificationSettingsStatus.sqlite.queries.byName.get_wechatUsers?.total || 0) > beforeNotificationSettingsGetWechatUsers, true);

    const beforeNotificationSettingsUpdateStatus = await storeModule.storeRuntimeStatus();
    const beforeNotificationSettingsUpdateListWechatUsers = beforeNotificationSettingsUpdateStatus.sqlite.queries.byName.list_wechatUsers?.total || 0;
    const beforeNotificationSettingsUpdateGetWechatUsers = beforeNotificationSettingsUpdateStatus.sqlite.queries.byName.get_wechatUsers?.total || 0;
    const beforeNotificationSettingsUpdateListWipes = beforeNotificationSettingsUpdateStatus.sqlite.queries.byName.list_wipes?.total || 0;
    const beforeNotificationSettingsUpdateListWipesStatus = beforeNotificationSettingsUpdateStatus.sqlite.queries.byName.list_wipes_status?.total || 0;
    const beforeWechatSubscriptionUpdateWrite = writeCount(beforeNotificationSettingsUpdateStatus, 'wechat_subscription_update');
    const beforeWechatSubscriptionUpdateLogTrimWrite = writeCount(beforeNotificationSettingsUpdateStatus, 'wechat_subscription_update_log_trim');
    const notificationSettingsUpdateResponse = await httpFetch(`${baseUrl}/wechat/notification-settings`, {
      method: 'PUT',
      headers: {
        authorization: `Bearer ${loginPayload.sessionToken}`,
        'content-type': 'application/json'
      },
      body: JSON.stringify({
        subscriptions: {
          joinReviewResult: 'accept',
          wipeSignupStatus: 'accept'
        }
      })
    });
    assert.equal(notificationSettingsUpdateResponse.status, 200);
    const notificationSettingsUpdatePayload = await notificationSettingsUpdateResponse.json();
    assert.equal(notificationSettingsUpdatePayload.ok, true);
    assert.equal(notificationSettingsUpdatePayload.subscriptions.joinReviewResult.status, 'accept');
    const afterNotificationSettingsUpdateStatus = await storeModule.storeRuntimeStatus();
    assert.equal(afterNotificationSettingsUpdateStatus.sqlite.queries.byName.list_wechatUsers?.total || 0, beforeNotificationSettingsUpdateListWechatUsers);
    assert.equal((afterNotificationSettingsUpdateStatus.sqlite.queries.byName.get_wechatUsers?.total || 0) > beforeNotificationSettingsUpdateGetWechatUsers, true);
    assert.equal(afterNotificationSettingsUpdateStatus.sqlite.queries.byName.list_wipes?.total || 0, beforeNotificationSettingsUpdateListWipes);
    assert.equal((afterNotificationSettingsUpdateStatus.sqlite.queries.byName.list_wipes_status?.total || 0) > beforeNotificationSettingsUpdateListWipesStatus, true);
    assert.equal(writeCount(afterNotificationSettingsUpdateStatus, 'wechat_subscription_update'), beforeWechatSubscriptionUpdateWrite + 1);
    assert.equal(writeCount(afterNotificationSettingsUpdateStatus, 'wechat_subscription_update_log_trim'), beforeWechatSubscriptionUpdateLogTrimWrite);

    const repositoryModule = await import('../server/storage/repository.js');
    const adminWechatUserId = 'wechat_user_sqlite_review_admin';
    const adminWechatCreatedAt = new Date().toISOString();
    await repositoryModule.writeSqliteStorePatch({
      reason: 'sqlite_test_wechat_review_admin',
      upserts: {
        wechatUsers: [{
          id: adminWechatUserId,
          openid: 'openid_sqlite_review_admin',
          unionid: '',
          nickname: 'SQLite Review Admin',
          avatarUrl: '',
          phone: '',
          wechatId: '',
          discordId: '',
          region: '',
          timeZone: '',
          status: 'approved',
          role: 'member_manager',
          memberId: '',
          subscriptionPreferences: {
            adminJoinReview: {
              status: 'accept',
              templateId: 'sqlite_tmpl_admin_join_review',
              updatedAt: adminWechatCreatedAt
            }
          },
          createdAt: adminWechatCreatedAt,
          updatedAt: adminWechatCreatedAt,
          lastLoginAt: adminWechatCreatedAt
        }]
      }
    });
    await repositoryModule.writeSqliteStorePatch({
      reason: 'sqlite_test_wechat_notification',
      upserts: {
        wechatNotifications: [{
          id: 'wechat_notification_sqlite_test',
          wechatUserId: loginPayload.wechatUser.id,
          type: 'join_application_review',
          title: '入队申请审核结果',
          body: '测试通知',
          status: 'approved',
          applicationType: 'join',
          applicationId: 'join_application_sqlite_test',
          targetId: 'join_application_sqlite_test',
          adminNote: '',
          templateKey: 'joinReviewResult',
          createdAt: new Date().toISOString(),
          readAt: ''
        }]
      }
    });

    const notificationsResponse = await httpFetch(`${baseUrl}/wechat/notifications`, {
      headers: { authorization: `Bearer ${loginPayload.sessionToken}` }
    });
    assert.equal(notificationsResponse.status, 200);
    const notificationsPayload = await notificationsResponse.json();
    assert.equal(notificationsPayload.ok, true);
    assert.equal(notificationsPayload.notifications.length, 1);
    assert.equal(notificationsPayload.notifications[0].id, 'wechat_notification_sqlite_test');
    assert.equal(notificationsPayload.notifications[0].readAt, '');

    const readNotificationResponse = await httpFetch(`${baseUrl}/wechat/notifications/wechat_notification_sqlite_test/read`, {
      method: 'POST',
      headers: { authorization: `Bearer ${loginPayload.sessionToken}` }
    });
    assert.equal(readNotificationResponse.status, 200);
    const readNotificationPayload = await readNotificationResponse.json();
    assert.equal(readNotificationPayload.ok, true);
    assert.equal(readNotificationPayload.notification.id, 'wechat_notification_sqlite_test');
    assert.match(readNotificationPayload.notification.readAt, /^\d{4}-\d{2}-\d{2}T/);

    // Mini enrollment/review and bearer management are retired even when the
    // V2 host is unavailable. They must stop before touching legacy collections.
    const beforeRetired = await storeModule.storeRuntimeStatus();
    const beforeCollections = {};
    for (const collection of ['members', 'wechatUsers', 'joinApplications', 'memberBindRequests', 'wechatNotifications']) {
      beforeCollections[collection] = await repositoryModule.getSqliteCollection(collection, { limit: 0 });
    }
    const beforeRetiredRequests = await storeModule.storeRuntimeStatus();
    for (const [route, method] of [
      ['/wechat/join-applications', 'POST'], ['/wechat/join-applications/me', 'GET'],
      ['/wechat/join-applications/retired-request', 'PUT'], ['/wechat/admin/join-applications', 'GET'],
      ['/wechat/admin/join-applications/retired-request/review', 'POST'],
      ['/wechat/admin/member-bind-requests', 'GET'], ['/wechat/admin/members', 'GET']
    ]) {
      const response = await httpFetch(baseUrl + route, { method,
        headers: { authorization: `Bearer ${loginPayload.sessionToken}`, 'content-type': 'application/json' },
        ...(['POST', 'PUT'].includes(method) ? { body: JSON.stringify({ steamInput: '76561198000000001', action: 'approve' }) } : {})
      });
      assert.equal(response.status, 410, route);
      assert.equal((await response.json()).errorCode, 'MINI_FEATURE_RETIRED', route);
    }
    const afterRetiredRequests = await storeModule.storeRuntimeStatus();
    assert.deepEqual(afterRetiredRequests.sqlite.writes, beforeRetiredRequests.sqlite.writes);
    for (const collection of Object.keys(beforeCollections)) {
      assert.deepEqual(await repositoryModule.getSqliteCollection(collection, { limit: 0 }), beforeCollections[collection]);
    }
    const staleBindCreatedAt = new Date().toISOString();
    await repositoryModule.writeSqliteStorePatch({
      reason: 'sqlite_test_wechat_stale_bind_steam_context',
      upserts: {
        members: [{
          id: 'member_sqlite_stale_bind_steam',
          steamId: '76561198000000992',
          rawInput: '76561198000000992',
          customName: 'Changed Steam Target',
          steamNickname: '',
          memberStatus: 'active',
          createdAt: staleBindCreatedAt,
          updatedAt: staleBindCreatedAt
        }],
        wechatUsers: [{
          id: 'wechat_user_sqlite_stale_bind',
          openid: 'openid_sqlite_stale_bind',
          status: 'guest',
          role: 'member',
          memberId: '',
          createdAt: staleBindCreatedAt,
          updatedAt: staleBindCreatedAt
        }, {
          id: 'wechat_user_sqlite_current_claim',
          openid: 'openid_sqlite_current_claim',
          status: 'guest',
          role: 'member',
          memberId: '',
          createdAt: staleBindCreatedAt,
          updatedAt: staleBindCreatedAt
        }],
        memberBindRequests: [{
          id: 'member_bind_request_sqlite_stale_steam',
          wechatUserId: 'wechat_user_sqlite_stale_bind',
          targetMemberId: 'member_sqlite_stale_bind_steam',
          steamId: '76561198000000991',
          status: 'pending',
          createdAt: staleBindCreatedAt,
          updatedAt: staleBindCreatedAt
        }],
        joinApplications: [{
          id: 'join_application_sqlite_current_steam',
          wechatUserId: 'wechat_user_sqlite_current_claim',
          targetMemberId: 'member_sqlite_stale_bind_steam',
          steamId: '76561198000000992',
          status: 'pending',
          specialties: ['pvp'],
          createdAt: staleBindCreatedAt,
          updatedAt: staleBindCreatedAt
        }]
      }
    });
    const unifiedReviewStore = await wechatStoreModule.readWechatAdminReviewStore({
      joinApplicationId: 'join_application_sqlite_current_steam'
    });
    assert.equal(
      unifiedReviewStore.joinApplications.some((item) => item.id === 'join_application_sqlite_current_steam'),
      true
    );
    assert.equal('memberBindRequests' in unifiedReviewStore, false);
    const preservedLegacyBindRecord = await repositoryModule.getSqliteRecord(
      'memberBindRequests',
      'member_bind_request_sqlite_stale_steam'
    );
    assert.equal(preservedLegacyBindRecord.steamId, '76561198000000991');
    await repositoryModule.writeSqliteStorePatch({
      reason: 'sqlite_test_wechat_stale_bind_steam_context_cleanup',
      deletes: {
        members: ['member_sqlite_stale_bind_steam'],
        wechatUsers: ['wechat_user_sqlite_stale_bind', 'wechat_user_sqlite_current_claim'],
        memberBindRequests: ['member_bind_request_sqlite_stale_steam'],
        joinApplications: ['join_application_sqlite_current_steam']
      }
    });

    const status = await storeModule.storeRuntimeStatus();
    assert.equal(status.sqlite.records.uploads, 1);
    assert.equal(status.sqlite.jsonFieldIndexes.missing.length, 0);
    assert.equal(status.sqlite.jsonFieldIndexes.present, status.sqlite.jsonFieldIndexes.expected);
    assert.equal(status.sqlite.compatibility.syncStoreChangesToSqlite, beforeStatus.sqlite.compatibility.syncStoreChangesToSqlite);
    assert.equal(status.metrics.sqliteWrites, beforeStatus.metrics.sqliteWrites);
    assert.equal(beforeRetired.metrics.sqliteWrites, beforeStatus.metrics.sqliteWrites);
  } finally {
    releaseJoinInventory();
    await apiModule?.drainBackgroundTaskQueuesForTests({ timeoutMs: 5000 }).catch(() => {});
    if (server) await new Promise((resolve) => server.close(resolve));
    globalThis.fetch = originalFetch;
    const sqliteModule = await import('../server/storage/sqlite.js');
    await sqliteModule.closeSqliteDatabasesForTests();
    Object.assign(process.env, previousEnv);
    for (const [key, value] of Object.entries(previousEnv)) {
      if (value === undefined) delete process.env[key];
    }
    await rm(dataDir, { recursive: true, force: true });
  }
});

test('sqlite-primary Rust+ relay settings/auth use scoped settings reads', async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'nb-clan-sqlite-rustplus-settings-scoped-'));
  const previousEnv = {
    NB_DATA_DIR: process.env.NB_DATA_DIR,
    NB_ROOT_PASSWORD: process.env.NB_ROOT_PASSWORD,
    NB_STORAGE_MODE: process.env.NB_STORAGE_MODE,
    NB_SQLITE_FILE: process.env.NB_SQLITE_FILE,
    NB_DISABLE_BACKGROUND_JOBS: process.env.NB_DISABLE_BACKGROUND_JOBS,
    NB_DISABLE_EXTERNAL_VITAL: process.env.NB_DISABLE_EXTERNAL_VITAL
  };
  process.env.NB_DATA_DIR = dataDir;
  process.env.NB_ROOT_PASSWORD = 'RootPass123!';
  process.env.NB_STORAGE_MODE = 'sqlite-primary';
  process.env.NB_SQLITE_FILE = path.join(dataDir, 'nb-clan.sqlite');
  process.env.NB_DISABLE_BACKGROUND_JOBS = '1';
  process.env.NB_DISABLE_EXTERNAL_VITAL = '1';

  try {
    const storeModule = await uniqueImport('../server/store.js');
    const rustplusRelayModule = await uniqueImport('../server/rustplus-relay.js');
    const repositoryModule = await import('../server/storage/repository.js');
    await storeModule.ensureStore();

    const createdAt = '2026-07-08T00:00:00.000Z';
    await repositoryModule.writeSqliteStorePatch({
      reason: 'sqlite_test_rustplus_settings_scoped_seed',
      scalars: {
        rustplusRelayCollectionsReady: { ready: true, updatedAt: createdAt }
      },
      upserts: {
        rustplusRelayClients: [{
          id: 'rustplus_client_scoped',
          name: 'Scoped Client',
          lastSeenAt: createdAt
        }],
        rustplusRelayServers: [{
          id: 'rustplus_server_scoped',
          key: 'rustplus_client_scoped:server_scoped',
          clientId: 'rustplus_client_scoped',
          serverId: 'server_scoped',
          name: 'Scoped Server',
          lastSeenAt: createdAt
        }],
        rustplusRelayChatMessages: [{
          id: 'rustplus_chat_scoped',
          serverKey: 'rustplus_client_scoped:server_scoped',
          steamId: '76561198000000001',
          displayName: 'Scoped Chat',
          message: 'hello',
          receivedAt: createdAt
        }],
        rustplusRelayInviteRecords: [{
          id: 'rustplus_invite_scoped',
          serverKey: 'rustplus_client_scoped:server_scoped',
          inviteeSteamId: '76561198000000002',
          inviteeName: 'Scoped Invitee',
          invitedAt: createdAt,
          receivedAt: createdAt
        }],
        rustplusRelaySteamProfiles: [{
          id: '76561198000000001',
          steamId: '76561198000000001',
          personaName: 'Scoped Profile',
          fetchedAt: createdAt
        }]
      }
    });

    const broadQueryNames = [
      'list_members',
      'list_squads',
      'list_squadMembers',
      'list_permissionRoles',
      'list_memberProfiles',
      'list_wipes',
      'list_wipeParticipants',
      'list_rustplusRelayClients',
      'list_rustplusRelayServers',
      'list_rustplusRelayChatMessages',
      'list_rustplusRelayInviteRecords',
      'list_rustplusRelaySteamProfiles'
    ];
    const assertBroadReadsUnchanged = (beforeStatus, afterStatus) => {
      for (const name of broadQueryNames) {
        assert.equal(queryCount(afterStatus, name), queryCount(beforeStatus, name), name);
      }
    };
    const writeCount = (status, name) => status.sqlite?.writes?.byName?.[name]?.total || 0;

    const beforeSettingsStatus = await storeModule.storeRuntimeStatus({ sqliteSummary: false });
    const settingsStore = await rustplusRelayModule.readRustplusRelaySettingsRuntimeStore();
    const settingsPayload = rustplusRelayModule.rustplusRelaySettingsPayload(settingsStore);
    const afterSettingsStatus = await storeModule.storeRuntimeStatus({ sqliteSummary: false });
    assert.equal(settingsPayload.enabled, false);
    assert.equal(settingsPayload.clientCount, 1);
    assert.equal(settingsPayload.serverCount, 1);
    assert.equal(settingsPayload.chatCount, 1);
    assert.equal(settingsPayload.inviteRecordCount, 1);
    assert.equal(settingsPayload.steamProfileCount, 1);
    assertBroadReadsUnchanged(beforeSettingsStatus, afterSettingsStatus);
    assert.equal(queryCount(afterSettingsStatus, 'scalar_settings') > queryCount(beforeSettingsStatus, 'scalar_settings'), true);
    assert.equal(queryCount(afterSettingsStatus, 'record_counts') > queryCount(beforeSettingsStatus, 'record_counts'), true);

    const beforeSettingsFailureStatus = await storeModule.storeRuntimeStatus({ sqliteSummary: false });
    repositoryModule.injectSqliteQueryFailureForTests('scalar_settings', 1);
    await assert.rejects(
      () => rustplusRelayModule.readRustplusRelaySettingsRuntimeStore(),
      (error) => error?.status === 503 && /Rust\+配置读取暂不可用/.test(error.message)
    );
    const afterSettingsFailureStatus = await storeModule.storeRuntimeStatus({ sqliteSummary: false });
    assert.equal(afterSettingsFailureStatus.metrics.reads.total, beforeSettingsFailureStatus.metrics.reads.total);
    assert.equal(afterSettingsFailureStatus.metrics.clones.total, beforeSettingsFailureStatus.metrics.clones.total);
    assert.equal(queryCount(afterSettingsFailureStatus, 'read_store_full'), queryCount(beforeSettingsFailureStatus, 'read_store_full'));

    const relayToken = 'sqlite_scoped_relay_token_1234567890';
    const beforeSaveStatus = await storeModule.storeRuntimeStatus({ sqliteSummary: false });
    const savedPayload = await rustplusRelayModule.saveRustplusRelayToken(relayToken);
    const afterSaveStatus = await storeModule.storeRuntimeStatus({ sqliteSummary: false });
    assert.equal(savedPayload.enabled, true);
    assert.equal(savedPayload.clientCount, 1);
    assertBroadReadsUnchanged(beforeSaveStatus, afterSaveStatus);
    assert.equal(writeCount(afterSaveStatus, 'rustplus_relay_token_save'), writeCount(beforeSaveStatus, 'rustplus_relay_token_save') + 1);
    const savedSettings = await repositoryModule.getSqliteScalar('settings');
    assert.equal(savedSettings.rustplusRelay.tokenHash.startsWith('scrypt$'), true);

    const beforeAuthStatus = await storeModule.storeRuntimeStatus({ sqliteSummary: false });
    const authStore = await rustplusRelayModule.readRustplusRelaySettingsRuntimeStore({ includeCounts: false });
    await rustplusRelayModule.validateRustplusRelayToken({
      headers: { authorization: `Bearer ${relayToken}` }
    }, authStore);
    const afterAuthStatus = await storeModule.storeRuntimeStatus({ sqliteSummary: false });
    assertBroadReadsUnchanged(beforeAuthStatus, afterAuthStatus);
    assert.equal(queryCount(afterAuthStatus, 'scalar_settings') > queryCount(beforeAuthStatus, 'scalar_settings'), true);
    assert.equal(queryCount(afterAuthStatus, 'record_counts'), queryCount(beforeAuthStatus, 'record_counts'));
    assert.equal(queryCount(afterAuthStatus, 'scalar_rustplusRelay'), queryCount(beforeAuthStatus, 'scalar_rustplusRelay'));
    assert.equal(queryCount(afterAuthStatus, 'scalar_rustplusRelayCollectionsReady'), queryCount(beforeAuthStatus, 'scalar_rustplusRelayCollectionsReady'));

    const beforeAuthFailureStatus = await storeModule.storeRuntimeStatus({ sqliteSummary: false });
    repositoryModule.injectSqliteQueryFailureForTests('scalar_settings', 1);
    await assert.rejects(
      () => rustplusRelayModule.readRustplusRelaySettingsRuntimeStore({ includeCounts: false }),
      (error) => error?.status === 503 && /Rust\+配置读取暂不可用/.test(error.message)
    );
    const afterAuthFailureStatus = await storeModule.storeRuntimeStatus({ sqliteSummary: false });
    assert.equal(afterAuthFailureStatus.metrics.reads.total, beforeAuthFailureStatus.metrics.reads.total);
    assert.equal(afterAuthFailureStatus.metrics.clones.total, beforeAuthFailureStatus.metrics.clones.total);
    assert.equal(queryCount(afterAuthFailureStatus, 'read_store_full'), queryCount(beforeAuthFailureStatus, 'read_store_full'));

    const beforeClearStatus = await storeModule.storeRuntimeStatus({ sqliteSummary: false });
    const clearedPayload = await rustplusRelayModule.clearRustplusRelayToken();
    const afterClearStatus = await storeModule.storeRuntimeStatus({ sqliteSummary: false });
    assert.equal(clearedPayload.enabled, false);
    assert.equal(clearedPayload.clientCount, 1);
    assertBroadReadsUnchanged(beforeClearStatus, afterClearStatus);
    assert.equal(writeCount(afterClearStatus, 'rustplus_relay_token_clear'), writeCount(beforeClearStatus, 'rustplus_relay_token_clear') + 1);
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

test('sqlite-primary Rust+ relay runtime store uses scoped identity reads without full fallback', async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'nb-clan-sqlite-rustplus-runtime-scoped-'));
  const previousEnv = {
    NB_DATA_DIR: process.env.NB_DATA_DIR,
    NB_ROOT_PASSWORD: process.env.NB_ROOT_PASSWORD,
    NB_STORAGE_MODE: process.env.NB_STORAGE_MODE,
    NB_SQLITE_FILE: process.env.NB_SQLITE_FILE,
    NB_DISABLE_BACKGROUND_JOBS: process.env.NB_DISABLE_BACKGROUND_JOBS,
    NB_DISABLE_EXTERNAL_VITAL: process.env.NB_DISABLE_EXTERNAL_VITAL
  };
  process.env.NB_DATA_DIR = dataDir;
  process.env.NB_ROOT_PASSWORD = 'RootPass123!';
  process.env.NB_STORAGE_MODE = 'sqlite-primary';
  process.env.NB_SQLITE_FILE = path.join(dataDir, 'nb-clan.sqlite');
  process.env.NB_DISABLE_BACKGROUND_JOBS = '1';
  process.env.NB_DISABLE_EXTERNAL_VITAL = '1';

  try {
    const storeModule = await uniqueImport('../server/store.js');
    const rustplusRelayModule = await uniqueImport('../server/rustplus-relay.js');
    const repositoryModule = await import('../server/storage/repository.js');
    await storeModule.ensureStore();

    const createdAt = '2026-07-08T00:00:00.000Z';
    const snapshot = rustplusRelayModule.normalizeRustplusRelayPayload({
      type: 'clan_snapshot',
      clientId: 'rustplus_client_runtime',
      clientName: 'Runtime Client',
      serverId: 'server_runtime',
      serverName: 'Runtime Server',
      clanName: 'Runtime Clan',
      members: [{
        steamId: '76561198000002001',
        displayName: 'Relay Runtime Member',
        online: true,
        lastSeenAt: createdAt
      }, {
        steamId: '76561198000002099',
        displayName: 'Relay Unknown',
        online: false
      }],
      capturedAt: createdAt
    });
    await repositoryModule.writeSqliteStorePatch({
      reason: 'sqlite_test_rustplus_runtime_scoped_seed',
      scalars: {
        rustplusRelayCollectionsReady: { ready: true, updatedAt: createdAt }
      },
      upserts: {
        members: [{
          id: 'member_rustplus_runtime_scoped',
          steamId: '76561198000002001',
          rawInput: '76561198000002001',
          customName: 'Runtime System Name',
          steamNickname: 'Runtime Steam Nick',
          avatar: 'https://avatars.test/runtime.jpg',
          discordId: '',
          wechatId: '',
          wechatUserId: '',
          notes: '',
          specialty: [],
          memberStatus: 'active',
          vitalVipType: 'priority',
          vitalVipPurchasedAt: '2026-07-01',
          vitalVipExpiresAt: '2026-08-01',
          invitedByUserId: '',
          createdAt,
          updatedAt: createdAt
        }, {
          id: 'member_rustplus_runtime_unrelated',
          steamId: '76561198000002999',
          rawInput: '76561198000002999',
          customName: 'Runtime Unrelated',
          steamNickname: 'Runtime Unrelated',
          avatar: '',
          discordId: '',
          wechatId: '',
          wechatUserId: '',
          notes: '',
          specialty: [],
          memberStatus: 'active',
          invitedByUserId: '',
          createdAt,
          updatedAt: createdAt
        }],
        squads: [{
          id: 'squad_rustplus_runtime',
          name: 'Runtime Squad',
          description: '',
          leaderUserId: '',
          leaderUserIds: [],
          archivedAt: '',
          createdAt,
          updatedAt: createdAt
        }, {
          id: 'squad_rustplus_unrelated',
          name: 'Runtime Unrelated Squad',
          description: '',
          leaderUserId: '',
          leaderUserIds: [],
          archivedAt: '',
          createdAt,
          updatedAt: createdAt
        }],
        squadMembers: [{
          id: 'squad_member_rustplus_runtime',
          squadId: 'squad_rustplus_runtime',
          memberId: 'member_rustplus_runtime_scoped',
          createdAt,
          updatedAt: createdAt
        }, {
          id: 'squad_member_rustplus_unrelated',
          squadId: 'squad_rustplus_unrelated',
          memberId: 'member_rustplus_runtime_unrelated',
          createdAt,
          updatedAt: createdAt
        }],
        permissionRoles: [{
          id: 'permission_role_rustplus_unused',
          name: 'Unused Rustplus Role',
          permissions: {},
          createdAt,
          updatedAt: createdAt
        }],
        wipes: [{
          id: 'wipe_rustplus_unused',
          name: 'Unused Rustplus Wipe',
          status: 'active',
          createdAt,
          updatedAt: createdAt
        }],
        wipeParticipants: [{
          id: 'wipe_participant_rustplus_unused',
          wipeId: 'wipe_rustplus_unused',
          memberId: 'member_rustplus_runtime_unrelated',
          status: 'on_time',
          createdAt,
          updatedAt: createdAt
        }],
        rustplusRelayClients: [{
          id: 'rustplus_client_runtime',
          name: 'Runtime Client',
          lastSeenAt: createdAt
        }],
        rustplusRelayServers: [{
          id: 'rustplus_client_runtime:server_runtime',
          key: 'rustplus_client_runtime:server_runtime',
          clientId: 'rustplus_client_runtime',
          clientName: 'Runtime Client',
          serverId: 'server_runtime',
          name: 'Runtime Server',
          lastSeenAt: createdAt,
          lastSnapshotAt: createdAt,
          snapshot
        }],
        rustplusRelayChatMessages: [{
          id: 'rustplus_chat_runtime',
          clientId: 'rustplus_client_runtime',
          clientName: 'Runtime Client',
          serverKey: 'rustplus_client_runtime:server_runtime',
          serverId: 'server_runtime',
          serverName: 'Runtime Server',
          steamId: '76561198000002001',
          displayName: 'Relay Chat Runtime',
          message: 'runtime hello',
          channel: 'clan',
          sentAt: createdAt,
          receivedAt: createdAt
        }],
        rustplusRelayInviteRecords: [{
          id: 'rustplus_invite_runtime',
          clientId: 'rustplus_client_runtime',
          clientName: 'Runtime Client',
          serverKey: 'rustplus_client_runtime:server_runtime',
          serverId: 'server_runtime',
          serverName: 'Runtime Server',
          inviterSteamId: '76561198000002001',
          inviterName: 'Relay Runtime Member',
          inviteeSteamId: '76561198000002099',
          inviteeName: 'Relay Unknown',
          invitedAt: createdAt,
          receivedAt: createdAt,
          status: 'pending'
        }],
        rustplusRelaySteamProfiles: [{
          id: '76561198000002099',
          steamId: '76561198000002099',
          steamNickname: 'Unknown Profile',
          avatar: 'https://avatars.test/unknown.jpg',
          profileUrl: 'https://steamcommunity.com/profiles/76561198000002099',
          fetchedAt: createdAt
        }]
      }
    });

    const beforeStatus = await storeModule.storeRuntimeStatus({ sqliteSummary: false });
    const beforeScopedReads = {
      membersBySteam: queryCount(beforeStatus, 'list_members_steamId'),
      squadMembersByMember: queryCount(beforeStatus, 'list_squadMembers_memberId'),
      squadsById: queryCount(beforeStatus, 'list_squads_id'),
      relayClients: queryCount(beforeStatus, 'list_rustplusRelayClients'),
      relayServers: queryCount(beforeStatus, 'list_rustplusRelayServers'),
      relayChatMessages: queryCount(beforeStatus, 'list_rustplusRelayChatMessages'),
      relayInviteRecords: queryCount(beforeStatus, 'list_rustplusRelayInviteRecords'),
      relaySteamProfiles: queryCount(beforeStatus, 'list_rustplusRelaySteamProfiles')
    };
    const beforeBroadReads = {
      readStoreFull: queryCount(beforeStatus, 'read_store_full'),
      members: queryCount(beforeStatus, 'list_members'),
      squads: queryCount(beforeStatus, 'list_squads'),
      squadMembers: queryCount(beforeStatus, 'list_squadMembers'),
      permissionRoles: queryCount(beforeStatus, 'list_permissionRoles'),
      memberProfiles: queryCount(beforeStatus, 'list_memberProfiles'),
      wipes: queryCount(beforeStatus, 'list_wipes'),
      wipeParticipants: queryCount(beforeStatus, 'list_wipeParticipants')
    };

    const runtimeStore = await rustplusRelayModule.readRustplusRelayRuntimeStore();
    const relay = rustplusRelayModule.publicRustplusRelayState(runtimeStore, {
      clientId: 'rustplus_client_runtime',
      serverKey: 'rustplus_client_runtime:server_runtime'
    });

    const runtimeMember = relay.members.find((member) => member.steamId === '76561198000002001');
    assert.equal(runtimeMember.memberId, 'member_rustplus_runtime_scoped');
    assert.equal(runtimeMember.displayName, 'Runtime System Name');
    assert.equal(runtimeMember.squadId, 'squad_rustplus_runtime');
    assert.equal(runtimeMember.squadName, 'Runtime Squad');
    assert.equal(runtimeMember.vitalVipType, 'priority');
    assert.equal(relay.members.some((member) => member.steamId === '76561198000002999'), false);
    assert.equal(relay.chatMessages[0].memberId, 'member_rustplus_runtime_scoped');
    assert.equal(relay.chatMessages[0].displayName, 'Runtime System Name');
    assert.equal(relay.inviteRecords[0].inviterMemberId, 'member_rustplus_runtime_scoped');
    assert.equal(relay.inviteRecords[0].inviteeDisplayName, 'Unknown Profile');

    const afterStatus = await storeModule.storeRuntimeStatus({ sqliteSummary: false });
    assert.equal(queryCount(afterStatus, 'read_store_full'), beforeBroadReads.readStoreFull);
    assert.equal(queryCount(afterStatus, 'list_members'), beforeBroadReads.members);
    assert.equal(queryCount(afterStatus, 'list_squads'), beforeBroadReads.squads);
    assert.equal(queryCount(afterStatus, 'list_squadMembers'), beforeBroadReads.squadMembers);
    assert.equal(queryCount(afterStatus, 'list_permissionRoles'), beforeBroadReads.permissionRoles);
    assert.equal(queryCount(afterStatus, 'list_memberProfiles'), beforeBroadReads.memberProfiles);
    assert.equal(queryCount(afterStatus, 'list_wipes'), beforeBroadReads.wipes);
    assert.equal(queryCount(afterStatus, 'list_wipeParticipants'), beforeBroadReads.wipeParticipants);
    assert.equal(queryCount(afterStatus, 'list_members_steamId') > beforeScopedReads.membersBySteam, true);
    assert.equal(queryCount(afterStatus, 'list_squadMembers_memberId') > beforeScopedReads.squadMembersByMember, true);
    assert.equal(queryCount(afterStatus, 'list_squads_id') > beforeScopedReads.squadsById, true);
    assert.equal(queryCount(afterStatus, 'list_rustplusRelayClients') > beforeScopedReads.relayClients, true);
    assert.equal(queryCount(afterStatus, 'list_rustplusRelayServers') > beforeScopedReads.relayServers, true);
    assert.equal(queryCount(afterStatus, 'list_rustplusRelayChatMessages') > beforeScopedReads.relayChatMessages, true);
    assert.equal(queryCount(afterStatus, 'list_rustplusRelayInviteRecords') > beforeScopedReads.relayInviteRecords, true);
    assert.equal(queryCount(afterStatus, 'list_rustplusRelaySteamProfiles') > beforeScopedReads.relaySteamProfiles, true);

    const beforeCollectionFailureStatus = await storeModule.storeRuntimeStatus({ sqliteSummary: false });
    repositoryModule.injectSqliteQueryFailureForTests('list_rustplusRelayServers', 1);
    await assert.rejects(
      () => rustplusRelayModule.readRustplusRelayRuntimeStore(),
      (error) => error?.status === 503 && /Rust\+运行数据读取暂不可用/.test(error.message)
    );
    const afterCollectionFailureStatus = await storeModule.storeRuntimeStatus({ sqliteSummary: false });
    assert.equal(afterCollectionFailureStatus.metrics.reads.total, beforeCollectionFailureStatus.metrics.reads.total);
    assert.equal(afterCollectionFailureStatus.metrics.clones.total, beforeCollectionFailureStatus.metrics.clones.total);
    assert.equal(queryCount(afterCollectionFailureStatus, 'read_store_full'), queryCount(beforeCollectionFailureStatus, 'read_store_full'));

    const beforeIdentityFailureStatus = await storeModule.storeRuntimeStatus({ sqliteSummary: false });
    repositoryModule.injectSqliteQueryFailureForTests('list_members_steamId', 1);
    await assert.rejects(
      () => rustplusRelayModule.readRustplusRelayRuntimeStore(),
      (error) => error?.status === 503 && /Rust\+运行数据读取暂不可用/.test(error.message)
    );
    const afterIdentityFailureStatus = await storeModule.storeRuntimeStatus({ sqliteSummary: false });
    assert.equal(afterIdentityFailureStatus.metrics.reads.total, beforeIdentityFailureStatus.metrics.reads.total);
    assert.equal(afterIdentityFailureStatus.metrics.clones.total, beforeIdentityFailureStatus.metrics.clones.total);
    assert.equal(queryCount(afterIdentityFailureStatus, 'read_store_full'), queryCount(beforeIdentityFailureStatus, 'read_store_full'));
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

test('sqlite-primary wechat login update uses scoped identity reads', async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'nb-clan-sqlite-wechat-login-scoped-'));
  const previousEnv = {
    NB_DATA_DIR: process.env.NB_DATA_DIR,
    NB_ROOT_PASSWORD: process.env.NB_ROOT_PASSWORD,
    NB_STORAGE_MODE: process.env.NB_STORAGE_MODE,
    NB_SQLITE_FILE: process.env.NB_SQLITE_FILE,
    NB_WECHAT_DEV_LOGIN: process.env.NB_WECHAT_DEV_LOGIN,
    NB_DISABLE_BACKGROUND_JOBS: process.env.NB_DISABLE_BACKGROUND_JOBS,
    NB_DISABLE_EXTERNAL_VITAL: process.env.NB_DISABLE_EXTERNAL_VITAL,
    NB_TRACE_RECORD_DIRECT_RETRY_ATTEMPTS: process.env.NB_TRACE_RECORD_DIRECT_RETRY_ATTEMPTS
  };
  const originalFetch = globalThis.fetch;
  const httpFetch = originalFetch.bind(globalThis);
  process.env.NB_DATA_DIR = dataDir;
  process.env.NB_ROOT_PASSWORD = 'RootPass123!';
  process.env.NB_STORAGE_MODE = 'sqlite-primary';
  process.env.NB_SQLITE_FILE = path.join(dataDir, 'nb-clan.sqlite');
  process.env.NB_WECHAT_DEV_LOGIN = '1';
  process.env.NB_DISABLE_BACKGROUND_JOBS = '1';
  process.env.NB_DISABLE_EXTERNAL_VITAL = '1';
  process.env.NB_TRACE_RECORD_DIRECT_RETRY_ATTEMPTS = '1';

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

    const firstLoginResponse = await httpFetch(`${baseUrl}/wechat/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        code: 'sqlite-wechat-scoped-login',
        profile: { nickname: 'Scoped Before' }
      })
    });
    assert.equal(firstLoginResponse.status, 200);
    const firstLoginPayload = await firstLoginResponse.json();
    assert.equal(firstLoginPayload.ok, true);

    const createdAt = new Date().toISOString();
    await repositoryModule.writeSqliteStorePatch({
      reason: 'sqlite_test_wechat_unrelated_users',
      upserts: {
        wechatUsers: Array.from({ length: 50 }, (_, index) => ({
          id: `wechat_user_unrelated_${index}`,
          openid: `unrelated_openid_${index}`,
          unionid: '',
          nickname: `Unrelated ${index}`,
          avatarUrl: '',
          phone: '',
          wechatId: '',
          discordId: '',
          region: '',
          timeZone: '',
          status: 'guest',
          role: 'member',
          memberId: '',
          createdAt,
          updatedAt: createdAt,
          lastLoginAt: createdAt
        }))
      }
    });
    const seededLogs = Array.from({ length: 1002 }, (_, index) => ({
      id: `wechat_login_log_seed_${String(index).padStart(4, '0')}`,
      type: 'wechat_login_seed',
      actorUserId: 'system',
      actorUsername: 'system',
      ip: '127.0.0.1',
      steamId: '',
      targetId: '',
      summary: `wechat login seed ${index}`,
      metadata: {},
      createdAt: new Date(Date.UTC(2026, 0, 1, 0, 0, index)).toISOString()
    }));
    await repositoryModule.writeSqliteStorePatch({
      reason: 'sqlite_test_wechat_login_log_seed',
      upserts: { logs: seededLogs },
      positions: {
        logs: Object.fromEntries(seededLogs.map((log, index) => [log.id, seededLogs.length - index]))
      }
    });

    const beforeStatus = await storeModule.storeRuntimeStatus();
    const beforeStat = await stat(storeModule.STORE_FILE);
    const beforeListWechatUsers = beforeStatus.sqlite.queries.byName.list_wechatUsers?.total || 0;
    const beforeFindOpenid = beforeStatus.sqlite.queries.byName.find_wechatUsers_openid?.total || 0;
    const writeCount = (status, name) => status.sqlite?.writes?.byName?.[name]?.total || 0;
    const beforeWechatLoginWrite = writeCount(beforeStatus, 'wechat_login');
    const beforeWechatLoginLogTrimWrite = writeCount(beforeStatus, 'wechat_login_log_trim');

    const secondLoginResponse = await httpFetch(`${baseUrl}/wechat/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        code: 'sqlite-wechat-scoped-login',
        profile: { nickname: 'Scoped After' }
      })
    });
    assert.equal(secondLoginResponse.status, 200);
    const secondLoginPayload = await secondLoginResponse.json();
    assert.equal(secondLoginPayload.ok, true);
    assert.equal(secondLoginPayload.wechatUser.id, firstLoginPayload.wechatUser.id);
    assert.equal(secondLoginPayload.wechatUser.nickname, 'Scoped After');

    const afterStat = await stat(storeModule.STORE_FILE);
    const afterStatus = await storeModule.storeRuntimeStatus();
    const updatedUser = await repositoryModule.getSqliteRecord('wechatUsers', firstLoginPayload.wechatUser.id);
    const logsAfterLogin = await repositoryModule.getSqliteCollection('logs', { limit: 0 });

    assert.equal(afterStat.mtimeMs, beforeStat.mtimeMs);
    assert.equal(afterStatus.metrics.writes.total, beforeStatus.metrics.writes.total);
    assert.equal(afterStatus.metrics.sqliteWrites, beforeStatus.metrics.sqliteWrites);
    assert.equal(afterStatus.sqlite.records.wechatUsers, 51);
    assert.equal(updatedUser.nickname, 'Scoped After');
    assert.equal(afterStatus.sqlite.queries.byName.list_wechatUsers?.total || 0, beforeListWechatUsers);
    assert.equal((afterStatus.sqlite.queries.byName.find_wechatUsers_openid?.total || 0) >= beforeFindOpenid + 2, true);
    assert.equal(writeCount(afterStatus, 'wechat_login'), beforeWechatLoginWrite + 1);
    assert.equal(writeCount(afterStatus, 'wechat_login_log_trim'), beforeWechatLoginLogTrimWrite);
    assert.equal(logsAfterLogin.length, 1000);
    assert.equal(logsAfterLogin.some((log) => log.id === 'wechat_login_log_seed_0000'), false);
    assert.equal(logsAfterLogin.some((log) => log.type === 'wechat_login' && log.targetId === firstLoginPayload.wechatUser.id), true);

    await repositoryModule.writeSqliteStorePatch({
      reason: 'sqlite_test_wechat_refusal_preferences',
      upserts: {
        wechatUsers: [{
          ...updatedUser,
          subscriptionPreferences: {
            wipeOpen: {
              status: 'accept',
              templateId: 'sqlite_tmpl_wipe_open',
              updatedAt: createdAt
            }
          }
        }]
      }
    });
    const beforeRefusalStatus = await storeModule.storeRuntimeStatus();
    const beforeRefusalListWechatUsers = beforeRefusalStatus.sqlite.queries.byName.list_wechatUsers?.total || 0;
    const beforeRefusalGetWechatUsers = beforeRefusalStatus.sqlite.queries.byName.get_wechatUsers?.total || 0;
    const beforeRefusalWechatUsersById = beforeRefusalStatus.sqlite.queries.byName.list_wechatUsers_id?.total || 0;
    const originalConsoleError = console.error;
    let refusalResult = null;
    try {
      console.error = () => {};
      refusalResult = await apiModule.sendWechatSubscribeMessages('sqlite-wechat-refusal-scoped', [{
        openid: 'sqlite_openid_refusal',
        templateId: 'sqlite_tmpl_wipe_open',
        templateKey: 'wipeOpen',
        wechatUserId: firstLoginPayload.wechatUser.id
      }], {
        sendOne: async () => {
          throw Object.assign(new Error('user refuse to accept the msg'), { errcode: 43101 });
        }
      });
    } finally {
      console.error = originalConsoleError;
    }
    assert.equal(refusalResult.sent, 0);
    assert.equal(refusalResult.failed, 1);
    const afterRefusalStatus = await storeModule.storeRuntimeStatus();
    assert.equal(afterRefusalStatus.sqlite.queries.byName.list_wechatUsers?.total || 0, beforeRefusalListWechatUsers);
    assert.equal(afterRefusalStatus.sqlite.queries.byName.get_wechatUsers?.total || 0, beforeRefusalGetWechatUsers);
    assert.equal((afterRefusalStatus.sqlite.queries.byName.list_wechatUsers_id?.total || 0) > beforeRefusalWechatUsersById, true);
    const refusedUser = await repositoryModule.getSqliteRecord('wechatUsers', firstLoginPayload.wechatUser.id);
    assert.equal(refusedUser.subscriptionPreferences.wipeOpen.status, 'unknown');
    const refusedMessageRefs = await repositoryModule.getSqliteRecordsByJsonField('integrationMessageRefs', 'channelId', [firstLoginPayload.wechatUser.id], { limit: 0 });
    const refusedMessageRef = refusedMessageRefs.find((ref) => (
      ref.platform === 'wechat' &&
      ref.kind === 'subscribe_message' &&
      ref.targetType === 'wechat_subscribe_message' &&
      ref.targetId === 'sqlite-wechat-refusal-scoped'
    ));
    assert.equal(Boolean(refusedMessageRef), true);
    assert.equal(refusedMessageRef.status, 'refused');
    assert.equal(refusedMessageRef.source, 'wechat_subscribe_message_push');
    assert.equal(refusedMessageRef.metadata.wechatUserId, firstLoginPayload.wechatUser.id);
    assert.equal(refusedMessageRef.metadata.templateKey, 'wipeOpen');
    assert.equal(JSON.stringify(refusedMessageRef).includes('sqlite_openid_refusal'), false);

    const traceModule = await import('../server/trace-record-persistence.js');
    traceModule.resetTraceRecordPersistenceForTests();
    repositoryModule.injectSqliteStorePatchFailureForTests('operation_run_create', 2);
    let operationRunFailureSendCount = 0;
    const operationRunFailure = await apiModule.sendWechatSubscribeMessages('sqlite-wechat-operation-run-failure', [{
      openid: 'sqlite_openid_operation_run_failure',
      templateId: 'sqlite_tmpl_wipe_open',
      templateKey: 'wipeOpen',
      wechatUserId: firstLoginPayload.wechatUser.id
    }], {
      sendOne: async () => {
        operationRunFailureSendCount += 1;
        return { ok: true };
      }
    });
    assert.deepEqual(operationRunFailure, { sent: 0, failed: 1 });
    assert.equal(operationRunFailureSendCount, 0);
    assert.equal(
      traceModule.traceRecordPersistenceSnapshot().records.some((item) => (
        item.name === 'operation_run_create' &&
        item.fallbackSuppressed === 1
      )),
      true
    );
    const operationRunFailureRefs = await repositoryModule.getSqliteRecordsByJsonField('integrationMessageRefs', 'targetId', ['sqlite-wechat-operation-run-failure'], { limit: 0 });
    assert.equal(operationRunFailureRefs.length, 0);

    repositoryModule.injectSqliteStorePatchFailureForTests('wechat_subscribe_message_ref_active', 1);
    let refActiveFailureSendCount = 0;
    const refActiveFailure = await apiModule.sendWechatSubscribeMessages('sqlite-wechat-ref-active-failure', [{
      openid: 'sqlite_openid_ref_active_failure',
      templateId: 'sqlite_tmpl_wipe_open',
      templateKey: 'wipeOpen',
      wechatUserId: firstLoginPayload.wechatUser.id
    }], {
      sendOne: async () => {
        refActiveFailureSendCount += 1;
        return { ok: true };
      }
    });
    assert.deepEqual(refActiveFailure, { sent: 0, failed: 1 });
    assert.equal(refActiveFailureSendCount, 0);
    const refActiveFailureRuns = await repositoryModule.getSqliteRecordsByJsonField('operationRuns', 'targetId', ['sqlite-wechat-ref-active-failure'], { limit: 0 });
    const refActiveFailureRun = refActiveFailureRuns.find((run) => run.type === 'wechat_subscribe_message_push');
    assert.equal(Boolean(refActiveFailureRun), true);
    assert.equal(refActiveFailureRun.status, 'failed');
    assert.equal(refActiveFailureRun.errorKey, 'wechat_subscribe_message_ref_active_failed');
    assert.match(refActiveFailureRun.errorSummary, /追踪记录创建失败/);
    assert.match(refActiveFailureRun.metadata.refCreateError, /Injected sqlite patch failure/);
    assert.equal(String(refActiveFailureRun.metadata.failed), '1');
    const refActiveFailureRefs = await repositoryModule.getSqliteRecordsByJsonField('integrationMessageRefs', 'targetId', ['sqlite-wechat-ref-active-failure'], { limit: 0 });
    assert.equal(refActiveFailureRefs.length, 0);

    repositoryModule.injectSqliteStorePatchFailureForTests('wechat_subscribe_message_ref_result', 1);
    const refResultFailure = await apiModule.sendWechatSubscribeMessages('sqlite-wechat-ref-result-failure', [{
      openid: 'sqlite_openid_ref_result',
      templateId: 'sqlite_tmpl_wipe_open',
      templateKey: 'wipeOpen',
      wechatUserId: firstLoginPayload.wechatUser.id
    }], {
      sendOne: async () => ({ ok: true })
    });
    assert.equal(refResultFailure.sent, 1);
    assert.equal(refResultFailure.failed, 0);
    const refResultFailureRuns = await repositoryModule.getSqliteRecordsByJsonField('operationRuns', 'targetId', ['sqlite-wechat-ref-result-failure'], { limit: 0 });
    const refResultFailureRun = refResultFailureRuns.find((run) => run.type === 'wechat_subscribe_message_push');
    assert.equal(Boolean(refResultFailureRun), true);
    assert.equal(refResultFailureRun.status, 'failed');
    assert.equal(refResultFailureRun.errorKey, 'wechat_subscribe_message_ref_result_failed');
    assert.match(refResultFailureRun.errorSummary, /状态记录失败/);
    assert.match(refResultFailureRun.metadata.refResultError, /Injected sqlite patch failure/);
    const refResultFailureRefs = await repositoryModule.getSqliteRecordsByJsonField('integrationMessageRefs', 'targetId', ['sqlite-wechat-ref-result-failure'], { limit: 0 });
    assert.equal(refResultFailureRefs.some((ref) => ref.status === 'active'), true);
  } finally {
    if (server) await new Promise((resolve) => server.close(resolve));
    const sqliteModule = await import('../server/storage/sqlite.js');
    await sqliteModule.closeSqliteDatabasesForTests();
    globalThis.fetch = originalFetch;
    Object.assign(process.env, previousEnv);
    for (const [key, value] of Object.entries(previousEnv)) {
      if (value === undefined) delete process.env[key];
    }
    await rm(dataDir, { recursive: true, force: true });
  }
});
