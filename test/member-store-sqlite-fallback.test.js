import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import express from 'express';

test('sqlite-primary member store safe fallbacks avoid full store reads', async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'nb-clan-member-store-fallback-'));
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
    const storeModule = await import('../server/store.js');
    const memberStoreModule = await import('../server/member-store.js');
    const repositoryModule = await import('../server/storage/repository.js');
    const authModule = await import('../server/auth.js');
    await storeModule.ensureStore();

    const queryCount = (status, name) => status.sqlite?.queries?.byName?.[name]?.total || 0;
    const before = await storeModule.storeRuntimeStatus({ sqliteSummary: false });

    repositoryModule.injectSqliteQueryFailureForTests('list_members_discordId', 1);
    const discordMember = await memberStoreModule.readDiscordMemberForUserId('1234567890');

    repositoryModule.injectSqliteQueryFailureForTests('list_members_id', 1);
    const profileSyncStore = await memberStoreModule.readMemberProfileSyncRequestStore({
      memberId: 'member_missing_profile_sync'
    });

    repositoryModule.injectSqliteQueryFailureForTests('scalar_settings', 1);
    const battlemetricsStore = await memberStoreModule.readBattlemetricsSyncRequestStore({
      memberId: 'member_missing_battlemetrics'
    });

    repositoryModule.injectSqliteQueryFailureForTests('list_members_vitalVipType', 1);
    const reminderStore = await memberStoreModule.readMemberDiscordReminderStore();

    repositoryModule.injectSqliteQueryFailureForTests('list_squads_leaderUserId', 1);
    const viewerStore = await memberStoreModule.readViewerMemberSyncCheckStore({
      id: 'user_member_store_viewer',
      username: 'member-store-viewer',
      role: 'leader',
      boundSteamId: ''
    });

    repositoryModule.injectSqliteQueryFailureForTests('scalar_syncState', 1);
    await assert.rejects(
      () => memberStoreModule.readMemberProfileSyncCancelRequested('memberProfiles', 'sync_job_missing'),
      (error) => (
        error.status === 503 &&
        error.code === 'member_profile_sync_cancel_read_unavailable' &&
        /成员资料同步取消状态读取暂不可用/.test(error.message)
      )
    );

    repositoryModule.injectSqliteQueryFailureForTests('list_users', 1);
    const optionsStore = await memberStoreModule.readMemberOptionsRuntimeStore();

    repositoryModule.injectSqliteQueryFailureForTests('list_wechatUsers', 1);
    await assert.rejects(
      () => memberStoreModule.readWechatAdminMembersStore(),
      (error) => (
        error.status === 503 &&
        /微信管理成员读取暂不可用/.test(error.message)
      )
    );

    repositoryModule.injectSqliteQueryFailureForTests('list_members_id', 1);
    const battlemetricsIdRefreshStore = await memberStoreModule.readBattlemetricsIdRefreshRequestStore({
      memberId: 'member_missing_battlemetrics_id_refresh'
    });

    repositoryModule.injectSqliteQueryFailureForTests('list_members', 1);
    const memberListStore = await memberStoreModule.readMemberListRuntimeStore();

    repositoryModule.injectSqliteQueryFailureForTests('list_users', 1);
    await assert.rejects(
      () => memberStoreModule.readMemberRuntimeBaseStore(),
      (error) => (
        error.status === 503 &&
        /成员基础读取暂不可用/.test(error.message)
      )
    );

    repositoryModule.injectSqliteQueryFailureForTests('get_members', 1);
    await assert.rejects(
      () => memberStoreModule.readMemberRefreshRequestStore('member_missing_refresh_request'),
      (error) => (
        error.status === 503 &&
        /成员刷新前置读取暂不可用/.test(error.message)
      )
    );

    repositoryModule.injectSqliteQueryFailureForTests('list_members_steamId', 1);
    await assert.rejects(
      () => memberStoreModule.readMemberQueryRuntimeStore('76561198000000001'),
      (error) => (
        error.status === 503 &&
        /成员查询读取暂不可用/.test(error.message)
      )
    );

    repositoryModule.injectSqliteQueryFailureForTests('get_members', 1);
    await assert.rejects(
      () => memberStoreModule.readMemberDetailRuntimeStore('member_missing_detail'),
      (error) => (
        error.status === 503 &&
        /成员详情读取暂不可用/.test(error.message)
      )
    );

    repositoryModule.injectSqliteQueryFailureForTests('scalar_settings', 1);
    await assert.rejects(
      () => memberStoreModule.readDiscordMembershipAuditStore(),
      (error) => (
        error.status === 503 &&
        /Discord 成员审计读取暂不可用/.test(error.message)
      )
    );

    const after = await storeModule.storeRuntimeStatus({ sqliteSummary: false });

    assert.equal(after.metrics.reads.total, before.metrics.reads.total);
    assert.equal(after.metrics.clones.total, before.metrics.clones.total);
    assert.equal(queryCount(after, 'read_store_full'), queryCount(before, 'read_store_full'));

    assert.equal(discordMember, null);
    assert.equal(profileSyncStore.memberPartial, true);
    assert.equal(profileSyncStore.memberReadSource, 'member_profile_sync_request');
    assert.match(profileSyncStore.memberReadError, /Injected sqlite query failure for list_members_id/);
    assert.deepEqual(profileSyncStore.members, []);
    assert.deepEqual(profileSyncStore.memberProfiles, []);
    assert.deepEqual(profileSyncStore.syncJobs, []);
    assert.deepEqual(profileSyncStore.settings, {});

    assert.equal(battlemetricsStore.memberPartial, true);
    assert.equal(battlemetricsStore.memberReadSource, 'battlemetrics_sync_request');
    assert.deepEqual(battlemetricsStore.members, []);
    assert.deepEqual(battlemetricsStore.wipes, []);
    assert.deepEqual(battlemetricsStore.wipeParticipants, []);

    assert.equal(reminderStore.memberPartial, true);
    assert.equal(reminderStore.memberReadSource, 'member_discord_reminder');
    assert.deepEqual(reminderStore.members, []);
    assert.deepEqual(reminderStore.discordMemberApplications, []);

    assert.equal(viewerStore.memberPartial, true);
    assert.equal(viewerStore.memberReadSource, 'viewer_member_sync_check');
    assert.deepEqual(viewerStore.users.map((user) => user.id), ['user_member_store_viewer']);
    assert.deepEqual(viewerStore.members, []);

    assert.equal(optionsStore.memberPartial, true);
    assert.equal(optionsStore.memberReadSource, 'member_options_runtime');
    assert.deepEqual(optionsStore.squads, []);
    assert.deepEqual(optionsStore.wipeParticipants, []);

    assert.equal(battlemetricsIdRefreshStore.memberPartial, true);
    assert.equal(battlemetricsIdRefreshStore.memberReadSource, 'battlemetrics_id_refresh_request');
    assert.deepEqual(battlemetricsIdRefreshStore.members, []);
    assert.deepEqual(battlemetricsIdRefreshStore.memberProfiles, []);
    assert.deepEqual(battlemetricsIdRefreshStore.permissionRoles, []);

    assert.equal(memberListStore.memberPartial, true);
    assert.equal(memberListStore.memberReadSource, 'member_list_runtime');
    assert.match(memberListStore.memberReadError, /Injected sqlite query failure for list_members/);
    assert.deepEqual(memberListStore.members, []);

    repositoryModule.injectSqliteQueryFailureForTests('list_users', 1);
    const unscopedBattlemetricsIdRefreshStore = await memberStoreModule.readBattlemetricsIdRefreshRequestStore();
    const afterUnscopedBattlemetricsFailure = await storeModule.storeRuntimeStatus({ sqliteSummary: false });
    assert.equal(queryCount(afterUnscopedBattlemetricsFailure, 'read_store_full'), queryCount(after, 'read_store_full'));
    assert.equal(unscopedBattlemetricsIdRefreshStore.memberPartial, true);
    assert.equal(unscopedBattlemetricsIdRefreshStore.memberReadSource, 'battlemetrics_id_refresh_request');
    assert.deepEqual(unscopedBattlemetricsIdRefreshStore.members, []);
    assert.deepEqual(unscopedBattlemetricsIdRefreshStore.settings, {});

    const apiModule = await import('../server/api.js');
    const app = express();
    app.use('/api', apiModule.createApiRouter());
    server = createServer(app);
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const sessionId = await authModule.createSession('user_root');
    const cookie = `nb_session=${encodeURIComponent(sessionId)}`;
    const beforeRouteFailure = await storeModule.storeRuntimeStatus({ sqliteSummary: false });
    repositoryModule.injectSqliteQueryFailureForTests('list_members', 1);
    const response = await fetch(`http://127.0.0.1:${server.address().port}/api/members`, {
      headers: { cookie }
    });
    const payload = await response.json();
    assert.equal(response.status, 503);
    assert.equal(payload.ok, false);
    assert.match(payload.error, /成员列表读取暂不可用/);
    assert.match(payload.error, /Injected sqlite query failure for list_members/);
    const afterRouteFailure = await storeModule.storeRuntimeStatus({ sqliteSummary: false });
    assert.equal(queryCount(afterRouteFailure, 'read_store_full'), queryCount(beforeRouteFailure, 'read_store_full'));

    const beforeWechatAdminMembersRouteFailure = await storeModule.storeRuntimeStatus({ sqliteSummary: false });
    repositoryModule.injectSqliteQueryFailureForTests('list_wechatUsers', 1);
    const wechatAdminMembersResponse = await fetch(`http://127.0.0.1:${server.address().port}/api/wechat/admin/members`, {
      headers: { cookie }
    });
    const wechatAdminMembersPayload = await wechatAdminMembersResponse.json();
    assert.equal(wechatAdminMembersResponse.status, 503);
    assert.equal(wechatAdminMembersPayload.ok, false);
    assert.match(wechatAdminMembersPayload.error, /微信管理成员读取暂不可用/);
    const afterWechatAdminMembersRouteFailure = await storeModule.storeRuntimeStatus({ sqliteSummary: false });
    assert.equal(
      queryCount(afterWechatAdminMembersRouteFailure, 'read_store_full'),
      queryCount(beforeWechatAdminMembersRouteFailure, 'read_store_full')
    );

    const beforeRefreshRouteFailure = await storeModule.storeRuntimeStatus({ sqliteSummary: false });
    repositoryModule.injectSqliteQueryFailureForTests('get_members', 1);
    const refreshResponse = await fetch(`http://127.0.0.1:${server.address().port}/api/members/member_missing_refresh_request/kda/refresh`, {
      method: 'POST',
      headers: { cookie }
    });
    const refreshPayload = await refreshResponse.json();
    assert.equal(refreshResponse.status, 503);
    assert.equal(refreshPayload.ok, false);
    assert.match(refreshPayload.error, /成员刷新前置读取暂不可用/);
    const afterRefreshRouteFailure = await storeModule.storeRuntimeStatus({ sqliteSummary: false });
    assert.equal(queryCount(afterRefreshRouteFailure, 'read_store_full'), queryCount(beforeRefreshRouteFailure, 'read_store_full'));

    const beforeQueryRouteFailure = await storeModule.storeRuntimeStatus({ sqliteSummary: false });
    repositoryModule.injectSqliteQueryFailureForTests('list_members_steamId', 1);
    const queryResponse = await fetch(`http://127.0.0.1:${server.address().port}/api/query`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ steamInput: '76561198000000001' })
    });
    const queryPayload = await queryResponse.json();
    assert.equal(queryResponse.status, 503);
    assert.equal(queryPayload.ok, false);
    assert.equal(Object.hasOwn(queryPayload, 'isMember'), false);
    assert.match(queryPayload.error, /成员查询读取暂不可用/);
    const afterQueryRouteFailure = await storeModule.storeRuntimeStatus({ sqliteSummary: false });
    assert.equal(queryCount(afterQueryRouteFailure, 'read_store_full'), queryCount(beforeQueryRouteFailure, 'read_store_full'));

    const beforeRustKdaRouteFailure = await storeModule.storeRuntimeStatus({ sqliteSummary: false });
    repositoryModule.injectSqliteQueryFailureForTests('list_members_steamId', 1);
    const rustKdaResponse = await fetch(
      `http://127.0.0.1:${server.address().port}/api/rust-kda/official?steamInput=76561198000000001`,
      { headers: { cookie } }
    );
    const rustKdaPayload = await rustKdaResponse.json();
    assert.equal(rustKdaResponse.status, 503);
    assert.equal(rustKdaPayload.ok, false);
    assert.match(rustKdaPayload.error, /成员查询读取暂不可用/);
    const afterRustKdaRouteFailure = await storeModule.storeRuntimeStatus({ sqliteSummary: false });
    assert.equal(queryCount(afterRustKdaRouteFailure, 'read_store_full'), queryCount(beforeRustKdaRouteFailure, 'read_store_full'));

    const beforeProfileRouteFailure = await storeModule.storeRuntimeStatus({ sqliteSummary: false });
    repositoryModule.injectSqliteQueryFailureForTests('get_members', 1);
    const profileResponse = await fetch(`http://127.0.0.1:${server.address().port}/api/members/member_missing_detail/profile`, {
      headers: { cookie }
    });
    const profilePayload = await profileResponse.json();
    assert.equal(profileResponse.status, 503);
    assert.equal(profilePayload.ok, false);
    assert.match(profilePayload.error, /成员详情读取暂不可用/);
    const afterProfileRouteFailure = await storeModule.storeRuntimeStatus({ sqliteSummary: false });
    assert.equal(queryCount(afterProfileRouteFailure, 'read_store_full'), queryCount(beforeProfileRouteFailure, 'read_store_full'));

    const beforeAuditRouteFailure = await storeModule.storeRuntimeStatus({ sqliteSummary: false });
    repositoryModule.injectSqliteQueryFailureForTests('scalar_settings', 1);
    const auditResponse = await fetch(`http://127.0.0.1:${server.address().port}/api/discord/member-audit`, {
      headers: { cookie }
    });
    const auditPayload = await auditResponse.json();
    assert.equal(auditResponse.status, 503);
    assert.equal(auditPayload.ok, false);
    assert.match(auditPayload.error, /Discord 成员审计读取暂不可用/);
    const afterAuditRouteFailure = await storeModule.storeRuntimeStatus({ sqliteSummary: false });
    assert.equal(queryCount(afterAuditRouteFailure, 'read_store_full'), queryCount(beforeAuditRouteFailure, 'read_store_full'));

    const beforeAuditRunFailure = await storeModule.storeRuntimeStatus({ sqliteSummary: false });
    repositoryModule.injectSqliteQueryFailureForTests('scalar_settings', 1);
    const auditRunResponse = await fetch(`http://127.0.0.1:${server.address().port}/api/discord/member-audit/run`, {
      method: 'POST',
      headers: { cookie }
    });
    const auditRunPayload = await auditRunResponse.json();
    assert.equal(auditRunResponse.status, 503);
    assert.equal(auditRunPayload.ok, false);
    assert.match(auditRunPayload.error, /Discord 成员审计读取暂不可用/);
    const afterAuditRunFailure = await storeModule.storeRuntimeStatus({ sqliteSummary: false });
    assert.equal(queryCount(afterAuditRunFailure, 'read_store_full'), queryCount(beforeAuditRunFailure, 'read_store_full'));
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
