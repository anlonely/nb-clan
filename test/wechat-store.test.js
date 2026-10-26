import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

test('sqlite-primary missing wechat user paths avoid full store fallback', async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'nb-clan-wechat-store-'));
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
    const storeModule = await import('../server/store.js');
    const wechatStoreModule = await import('../server/wechat-store.js');
    const repositoryModule = await import('../server/storage/repository.js');
    await storeModule.ensureStore();
    await storeModule.updateStore((store) => {
      store.settings.wechat ||= {};
      store.settings.wechat.subscriptionTemplates ||= {};
      store.settings.wechat.subscriptionTemplates.wipeOpen = 'tmpl_wipe_open';
      store.members.push({
        id: 'member_wechat_store_decoy',
        steamId: '76561198000009901',
        rawInput: '76561198000009901',
        customName: 'Wechat Store Decoy',
        steamNickname: 'WechatStoreDecoy',
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
        invitedByUserId: 'user_root',
        createdAt: storeModule.nowIso(),
        updatedAt: storeModule.nowIso()
      });
    });

    const queryCount = (status, name) => status.sqlite?.queries?.byName?.[name]?.total || 0;
    const before = await storeModule.storeRuntimeStatus({ sqliteSummary: false });
    const missingUserId = 'wechat_user_missing_for_store_test';

    const missingAuthStore = await wechatStoreModule.readWechatAuthStore('missing_wechat_token_hash');
    const emptyAuthStore = await wechatStoreModule.readWechatAuthStore();
    const notificationStore = await wechatStoreModule.readWechatNotificationSettingsStore(missingUserId);
    const applicationStore = await wechatStoreModule.readWechatApplicationWriteStore(missingUserId, {
      steamIds: ['76561198000009901'],
      includeReviewManagers: false
    });
    const managementStore = await wechatStoreModule.readWechatManagementStore(missingUserId);
    const after = await storeModule.storeRuntimeStatus({ sqliteSummary: false });

    assert.equal(after.metrics.reads.total, before.metrics.reads.total);
    assert.equal(after.metrics.clones.total, before.metrics.clones.total);
    assert.equal(queryCount(after, 'list_members'), queryCount(before, 'list_members'));
    assert.deepEqual(missingAuthStore.wechatSessions, []);
    assert.deepEqual(missingAuthStore.wechatUsers, []);
    assert.deepEqual(emptyAuthStore.wechatSessions, []);
    assert.deepEqual(emptyAuthStore.wechatUsers, []);
    assert.equal(notificationStore.settings.wechat.subscriptionTemplates.wipeOpen, 'tmpl_wipe_open');
    assert.deepEqual(notificationStore.wechatUsers, []);
    assert.deepEqual(applicationStore.wechatUsers, []);
    assert.deepEqual(applicationStore.members, []);
    assert.deepEqual(managementStore.wechatUsers, []);
    assert.deepEqual(managementStore.members, []);

    const beforeFailure = await storeModule.storeRuntimeStatus({ sqliteSummary: false });
    repositoryModule.injectSqliteQueryFailureForTests('find_wechatSessions_tokenHash', 1);
    const authFailureStore = await wechatStoreModule.readWechatAuthStore('token_hash_failure');
    repositoryModule.injectSqliteQueryFailureForTests('scalar_settings', 1);
    const notificationFailureStore = await wechatStoreModule.readWechatNotificationSettingsStore(missingUserId);
    repositoryModule.injectSqliteQueryFailureForTests('get_wechatUsers', 1);
    const signedAuthFailureUser = await wechatStoreModule.readWechatUserByIdForAuth(missingUserId);
    repositoryModule.injectSqliteQueryFailureForTests('get_wechatUsers', 1);
    const accessFailureStore = await wechatStoreModule.readWechatAccessStatusStore(missingUserId);
    repositoryModule.injectSqliteQueryFailureForTests('scalar_settings', 1);
    const applicationFailureStore = await wechatStoreModule.readWechatApplicationWriteStore(missingUserId);
    repositoryModule.injectSqliteQueryFailureForTests('get_wechatUsers', 1);
    const managementFailureStore = await wechatStoreModule.readWechatManagementStore(missingUserId);
    repositoryModule.injectSqliteQueryFailureForTests('list_squads', 1);
    const summaryFailureStore = await wechatStoreModule.readWechatAdminSummaryStore();
    repositoryModule.injectSqliteQueryFailureForTests('list_wechatNotifications_wechatUserId', 1);
    const notificationFailureList = await wechatStoreModule.readWechatNotificationsForUser(missingUserId);
    repositoryModule.injectSqliteQueryFailureForTests('list_wipes_status', 1);
    await assert.rejects(
      () => wechatStoreModule.readWechatWipeRuntimeStore('current'),
      (error) => error?.status === 503 && /微信档期读取暂不可用/.test(error.message)
    );
    const afterFailure = await storeModule.storeRuntimeStatus({ sqliteSummary: false });

    assert.equal(afterFailure.metrics.reads.total, beforeFailure.metrics.reads.total);
    assert.equal(afterFailure.metrics.clones.total, beforeFailure.metrics.clones.total);
    assert.equal(queryCount(afterFailure, 'read_store_full'), queryCount(beforeFailure, 'read_store_full'));
    assert.equal(authFailureStore.wechatPartial, true);
    assert.equal(authFailureStore.wechatReadSource, 'wechat_auth');
    assert.match(authFailureStore.wechatReadError, /Injected sqlite query failure for find_wechatSessions_tokenHash/);
    assert.deepEqual(authFailureStore.wechatSessions, []);
    assert.deepEqual(authFailureStore.wechatUsers, []);
    assert.equal(notificationFailureStore.wechatPartial, true);
    assert.equal(notificationFailureStore.wechatReadSource, 'wechat_notification_settings');
    assert.deepEqual(notificationFailureStore.settings, {});
    assert.equal(signedAuthFailureUser, null);
    assert.equal(accessFailureStore.wechatPartial, true);
    assert.equal(accessFailureStore.wechatReadSource, 'wechat_access_status');
    assert.deepEqual(accessFailureStore.wechatUsers, []);
    assert.equal(applicationFailureStore.wechatPartial, true);
    assert.equal(applicationFailureStore.wechatReadSource, 'wechat_application_write');
    assert.deepEqual(applicationFailureStore.wechatUsers, []);
    assert.equal(managementFailureStore.wechatPartial, true);
    assert.equal(managementFailureStore.wechatReadSource, 'wechat_management');
    assert.deepEqual(managementFailureStore.members, []);
    assert.equal(summaryFailureStore.wechatPartial, true);
    assert.equal(summaryFailureStore.wechatReadSource, 'wechat_admin_summary');
    assert.deepEqual(summaryFailureStore.summaryCounts, { members: 0, squads: 0, export: 0 });
    assert.deepEqual(notificationFailureList, []);
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

test('sqlite-primary wechat identity lookup uses scoped indexed reads', async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'nb-clan-wechat-identity-'));
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
    const storeModule = await import('../server/store.js');
    const wechatStoreModule = await import('../server/wechat-store.js');
    const repositoryModule = await import('../server/storage/repository.js');
    await storeModule.ensureStore();

    const now = storeModule.nowIso();
    await repositoryModule.writeSqliteStorePatch({
      reason: 'test_wechat_identity_lookup',
      upserts: {
        wechatUsers: [
          {
            id: 'wechat_user_same_identity',
            openid: 'openid_same_identity',
            unionid: 'unionid_same_identity',
            nickname: 'Same Identity',
            status: 'guest',
            role: 'member',
            createdAt: now,
            updatedAt: now
          },
          {
            id: 'wechat_user_openid_identity',
            openid: 'openid_conflict_identity',
            unionid: '',
            nickname: 'Openid Identity',
            status: 'guest',
            role: 'member',
            createdAt: now,
            updatedAt: now
          },
          {
            id: 'wechat_user_unionid_identity',
            openid: '',
            unionid: 'unionid_conflict_identity',
            nickname: 'Unionid Identity',
            status: 'guest',
            role: 'member',
            createdAt: now,
            updatedAt: now
          },
          {
            id: 'wechat_user_unrelated_identity',
            openid: 'openid_unrelated_identity',
            unionid: 'unionid_unrelated_identity',
            nickname: 'Unrelated Identity',
            status: 'guest',
            role: 'member',
            createdAt: now,
            updatedAt: now
          }
        ]
      }
    });

    const queryCount = (status, name) => status.sqlite?.queries?.byName?.[name]?.total || 0;
    const sameBefore = await storeModule.storeRuntimeStatus({ sqliteSummary: false });
    const sameUsers = await wechatStoreModule.readWechatUsersByIdentity({
      openid: 'openid_same_identity',
      unionid: 'unionid_same_identity'
    }, { fullReadOnConflict: true });
    const sameAfter = await storeModule.storeRuntimeStatus({ sqliteSummary: false });

    assert.deepEqual(sameUsers.map((user) => user.id), ['wechat_user_same_identity']);
    assert.equal(queryCount(sameAfter, 'find_wechatUsers_openid'), queryCount(sameBefore, 'find_wechatUsers_openid') + 1);
    assert.equal(queryCount(sameAfter, 'find_wechatUsers_unionid'), queryCount(sameBefore, 'find_wechatUsers_unionid') + 1);
    assert.equal(queryCount(sameAfter, 'list_wechatUsers'), queryCount(sameBefore, 'list_wechatUsers'));

    const conflictBefore = await storeModule.storeRuntimeStatus({ sqliteSummary: false });
    const conflictUsers = await wechatStoreModule.readWechatUsersByIdentity({
      openid: 'openid_conflict_identity',
      unionid: 'unionid_conflict_identity'
    }, { fullReadOnConflict: true });
    const conflictAfter = await storeModule.storeRuntimeStatus({ sqliteSummary: false });
    const conflictIds = new Set(conflictUsers.map((user) => user.id));

    assert.equal(conflictIds.has('wechat_user_openid_identity'), true);
    assert.equal(conflictIds.has('wechat_user_unionid_identity'), true);
    assert.equal(conflictIds.has('wechat_user_unrelated_identity'), true);
    assert.equal(queryCount(conflictAfter, 'find_wechatUsers_openid'), queryCount(conflictBefore, 'find_wechatUsers_openid') + 1);
    assert.equal(queryCount(conflictAfter, 'find_wechatUsers_unionid'), queryCount(conflictBefore, 'find_wechatUsers_unionid') + 1);
    assert.equal(queryCount(conflictAfter, 'list_wechatUsers'), queryCount(conflictBefore, 'list_wechatUsers') + 1);
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

test('sqlite-primary wechat management store uses scoped member and user lookups', async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'nb-clan-wechat-management-'));
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
    const storeModule = await import('../server/store.js');
    const wechatStoreModule = await import('../server/wechat-store.js');
    const repositoryModule = await import('../server/storage/repository.js');
    await storeModule.ensureStore();

    const now = storeModule.nowIso();
    await repositoryModule.writeSqliteStorePatch({
      reason: 'test_wechat_management_lookup',
      upserts: {
        members: [
          {
            id: 'member_wechat_management',
            steamId: '76561198000009111',
            rawInput: '76561198000009111',
            customName: 'Wechat Management Member',
            steamNickname: 'WechatManagementMember',
            memberStatus: 'active',
            invitedByUserId: 'user_root',
            createdAt: now,
            updatedAt: now
          }
        ],
        wechatUsers: [
          {
            id: 'wechat_user_management',
            openid: 'openid_management',
            unionid: 'unionid_management',
            nickname: 'Wechat Management',
            status: 'member',
            role: 'leader',
            memberId: 'member_wechat_management',
            createdAt: now,
            updatedAt: now
          }
        ],
        users: [
          {
            id: 'user_wechat_management_bound',
            username: 'wechat-bound',
            role: 'member',
            boundSteamId: '76561198000009111',
            steamId: '',
            createdAt: now,
            updatedAt: now
          },
          {
            id: 'user_wechat_management_steam',
            username: 'wechat-steam',
            role: 'member',
            boundSteamId: '',
            steamId: '76561198000009111',
            createdAt: now,
            updatedAt: now
          }
        ]
      }
    });

    const queryCount = (status, name) => status.sqlite?.queries?.byName?.[name]?.total || 0;
    const before = await storeModule.storeRuntimeStatus({ sqliteSummary: false });
    const managementStore = await wechatStoreModule.readWechatManagementStore('wechat_user_management');
    const after = await storeModule.storeRuntimeStatus({ sqliteSummary: false });
    const userIds = new Set(managementStore.users.map((user) => user.id));

    assert.equal(managementStore.wechatUsers[0]?.id, 'wechat_user_management');
    assert.equal(managementStore.members[0]?.id, 'member_wechat_management');
    assert.equal(userIds.has('user_wechat_management_bound'), true);
    assert.equal(userIds.has('user_wechat_management_steam'), true);
    assert.equal(queryCount(after, 'get_wechatUsers'), queryCount(before, 'get_wechatUsers') + 1);
    assert.equal(queryCount(after, 'get_members'), queryCount(before, 'get_members') + 1);
    assert.equal(queryCount(after, 'list_users_boundSteamId'), queryCount(before, 'list_users_boundSteamId') + 1);
    assert.equal(queryCount(after, 'list_users_steamId'), queryCount(before, 'list_users_steamId') + 1);
    assert.equal(queryCount(after, 'list_users'), queryCount(before, 'list_users'));
    assert.equal(queryCount(after, 'list_members'), queryCount(before, 'list_members'));
    assert.equal(queryCount(after, 'list_wechatUsers'), queryCount(before, 'list_wechatUsers'));
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

test('sqlite-primary wechat wipe signup all-member KDA store uses scoped member reads', async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'nb-clan-wechat-signup-kda-'));
  const previousEnv = {
    NB_DATA_DIR: process.env.NB_DATA_DIR,
    NB_ROOT_PASSWORD: process.env.NB_ROOT_PASSWORD,
    NB_STORAGE_MODE: process.env.NB_STORAGE_MODE,
    NB_SQLITE_FILE: process.env.NB_SQLITE_FILE,
    NB_DISABLE_EXTERNAL_VITAL: process.env.NB_DISABLE_EXTERNAL_VITAL
  };
  process.env.NB_DATA_DIR = dataDir;
  process.env.NB_ROOT_PASSWORD = 'RootPass123!';
  process.env.NB_STORAGE_MODE = 'sqlite-primary';
  process.env.NB_SQLITE_FILE = path.join(dataDir, 'nb-clan.sqlite');
  process.env.NB_DISABLE_EXTERNAL_VITAL = '1';

  try {
    const storeModule = await import('../server/store.js');
    const wechatStoreModule = await import('../server/wechat-store.js');
    const repositoryModule = await import('../server/storage/repository.js');
    await storeModule.ensureStore();

    const now = storeModule.nowIso();
    await repositoryModule.writeSqliteStorePatch({
      reason: 'test_wechat_signup_all_member_kda_scope',
      upserts: {
        wipes: [{
          id: 'wipe_wechat_signup_all_member_kda',
          name: 'Wechat Signup All Member KDA',
          serverName: 'Wechat Signup Server',
          status: 'active',
          signupStatus: 'open',
          startedAt: '2026-07-02T00:00:00.000Z',
          signupOpenedAt: '2026-07-02T00:00:00.000Z',
          kdaMemberScope: 'all_members',
          createdAt: now,
          updatedAt: now
        }],
        members: [{
          id: 'member_wechat_signup_current_no_steam',
          steamId: '',
          rawInput: '',
          customName: 'Wechat Signup Current',
          steamNickname: '',
          memberStatus: 'active',
          createdAt: now,
          updatedAt: now
        }, {
          id: 'member_wechat_signup_participant_no_steam',
          steamId: '',
          rawInput: '',
          customName: 'Wechat Signup Participant',
          steamNickname: '',
          memberStatus: 'active',
          createdAt: now,
          updatedAt: now
        }, {
          id: 'member_wechat_signup_steam',
          steamId: '76561198000009221',
          rawInput: '76561198000009221',
          customName: 'Wechat Signup Steam',
          steamNickname: 'WechatSignupSteam',
          memberStatus: 'active',
          createdAt: now,
          updatedAt: now
        }, {
          id: 'member_wechat_signup_unrelated_no_steam',
          steamId: '',
          rawInput: '',
          customName: 'Wechat Signup Unrelated',
          steamNickname: '',
          memberStatus: 'active',
          createdAt: now,
          updatedAt: now
        }],
        wechatUsers: [{
          id: 'wechat_user_signup_all_member_kda',
          openid: 'openid_signup_all_member_kda',
          unionid: '',
          nickname: 'Wechat Signup Current',
          status: 'member',
          role: 'member',
          memberId: 'member_wechat_signup_current_no_steam',
          createdAt: now,
          updatedAt: now
        }],
        wipeParticipants: [{
          id: 'participant_wechat_signup_all_member_kda',
          wipeId: 'wipe_wechat_signup_all_member_kda',
          memberId: 'member_wechat_signup_participant_no_steam',
          status: 'on_time',
          source: 'admin',
          createdAt: now,
          updatedAt: now
        }]
      }
    });

    const queryCount = (status, name) => status.sqlite?.queries?.byName?.[name]?.total || 0;
    const before = await storeModule.storeRuntimeStatus({ sqliteSummary: false });
    const signupStore = await wechatStoreModule.readWechatWipeSignupWriteStore(
      'wechat_user_signup_all_member_kda',
      'current'
    );
    const after = await storeModule.storeRuntimeStatus({ sqliteSummary: false });
    const memberIds = new Set(signupStore.members.map((member) => member.id));

    assert.equal(queryCount(after, 'list_members'), queryCount(before, 'list_members'));
    assert.equal(queryCount(after, 'list_members_steamId_present'), queryCount(before, 'list_members_steamId_present') + 1);
    assert.equal(queryCount(after, 'list_members_id') > queryCount(before, 'list_members_id'), true);
    assert.equal(memberIds.has('member_wechat_signup_current_no_steam'), true);
    assert.equal(memberIds.has('member_wechat_signup_participant_no_steam'), true);
    assert.equal(memberIds.has('member_wechat_signup_steam'), true);
    assert.equal(memberIds.has('member_wechat_signup_unrelated_no_steam'), false);
    assert.equal(signupStore.wipeParticipants.length, 1);
    assert.equal(signupStore.kdaRows.length, 0);
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
