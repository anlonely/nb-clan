import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

test('wechat auto review writes approvals in sqlite-primary mode', async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'nb-clan-wechat-auto-review-sqlite-'));
  const previousEnv = {
    NB_DATA_DIR: process.env.NB_DATA_DIR,
    NB_ROOT_PASSWORD: process.env.NB_ROOT_PASSWORD,
    NB_STORAGE_MODE: process.env.NB_STORAGE_MODE,
    NB_SQLITE_FILE: process.env.NB_SQLITE_FILE,
    NB_WECHAT_AUTO_REVIEW_ENABLED: process.env.NB_WECHAT_AUTO_REVIEW_ENABLED,
    NB_DISABLE_BACKGROUND_JOBS: process.env.NB_DISABLE_BACKGROUND_JOBS
  };
  process.env.NB_DATA_DIR = dataDir;
  process.env.NB_ROOT_PASSWORD = 'RootPass123!';
  process.env.NB_STORAGE_MODE = 'sqlite-primary';
  process.env.NB_SQLITE_FILE = path.join(dataDir, 'nb-clan.sqlite');
  process.env.NB_WECHAT_AUTO_REVIEW_ENABLED = '1';
  process.env.NB_DISABLE_BACKGROUND_JOBS = '1';

  try {
    const { runWechatAutoReviewApprovals } = await import('../server/api.js');
    const { ensureStore, nowIso, readStore, storeRuntimeStatus, updateStore } = await import('../server/store.js');
    await ensureStore();
    await updateStore((store) => {
      const createdAt = nowIso();
      store.members.push({
        id: 'member_sqlite_auto_bind_target',
        steamId: '76561198000007777',
        rawInput: '76561198000007777',
        customName: 'SQLite Auto Bind',
        steamNickname: 'SQLiteAutoBind',
        avatar: '',
        discordId: '',
        wechatId: '',
        wechatUserId: '',
        phone: '',
        notes: '',
        specialty: ['building'],
        specialties: ['building'],
        battlemetricsId: '',
        memberStatus: 'active',
        invitedByUserId: 'user_root',
        createdAt,
        updatedAt: createdAt
      });
      store.wechatUsers.push({
        id: 'wechat_user_sqlite_auto_bind',
        openid: 'openid_sqlite_auto_bind',
        unionid: '',
        nickname: 'SQLite 老队员',
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
      });
      store.wechatUsers.push({
        id: 'wechat_user_sqlite_auto_join',
        openid: 'openid_sqlite_auto_join',
        unionid: '',
        nickname: 'SQLite 新成员',
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
      });
      store.wechatUsers.push({
        id: 'wechat_user_sqlite_auto_claim',
        openid: 'openid_sqlite_auto_claim',
        unionid: '',
        nickname: 'SQLite 统一认领',
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
      });
      store.memberBindRequests.push({
        id: 'member_bind_request_sqlite_auto_pending',
        wechatUserId: 'wechat_user_sqlite_auto_bind',
        targetMemberId: 'member_sqlite_auto_bind_target',
        steamId: '76561198000007777',
        steamNickname: 'SQLiteAutoBind',
        wechatId: '',
        discordId: '',
        inviterText: '',
        note: '',
        status: 'pending',
        adminNote: '',
        reviewNote: '',
        reviewedByUserId: '',
        reviewedAt: '',
        createdAt,
        updatedAt: createdAt
      });
      store.joinApplications.push({
        id: 'join_application_sqlite_auto_pending',
        wechatUserId: 'wechat_user_sqlite_auto_join',
        memberId: '',
        steamInput: '76561198000008888',
        steamId: '76561198000008888',
        steamNickname: 'SQLiteAutoJoin',
        steamAvatar: '',
        reason: 'SQLite 自动入队',
        specialties: ['pvp'],
        specialtiesRaw: ['pvp'],
        status: 'pending',
        adminNote: '',
        reviewNote: '',
        reviewedByUserId: '',
        reviewedAt: '',
        createdAt,
        updatedAt: createdAt
      });
      store.joinApplications.push({
        id: 'join_application_sqlite_auto_claim_pending',
        wechatUserId: 'wechat_user_sqlite_auto_claim',
        memberId: '',
        targetMemberId: 'member_sqlite_auto_bind_target',
        registrationMode: 'claim',
        steamInput: '76561198000007777',
        steamId: '76561198000007777',
        steamNickname: 'SQLiteAutoBind',
        steamAvatar: '',
        notes: 'SQLite 认领必须人工审核',
        reason: 'SQLite 认领必须人工审核',
        specialties: ['building'],
        status: 'pending',
        adminNote: '',
        reviewNote: '',
        reviewedByUserId: '',
        reviewedAt: '',
        createdAt,
        updatedAt: createdAt
      });
    });

    const queryCount = (status, name) => status.sqlite?.queries?.byName?.[name]?.total || 0;
    const statusBeforeAutoReview = await storeRuntimeStatus({ sqliteSummary: false });
    const beforeFullJoinApplications = queryCount(statusBeforeAutoReview, 'list_joinApplications');
    const beforePendingJoinApplications = queryCount(statusBeforeAutoReview, 'list_joinApplications_status');
    const beforeMissingStatusJoinApplications = queryCount(statusBeforeAutoReview, 'list_joinApplications_status_missing');
    const beforeFullMemberBindRequests = queryCount(statusBeforeAutoReview, 'list_memberBindRequests');
    const beforePendingMemberBindRequests = queryCount(statusBeforeAutoReview, 'list_memberBindRequests_status');
    const beforeMissingStatusMemberBindRequests = queryCount(statusBeforeAutoReview, 'list_memberBindRequests_status_missing');
    const result = await runWechatAutoReviewApprovals({ force: true, limit: 10 });
    assert.equal(result.join.approved, 1);
    assert.equal('bind' in result, false);
    assert.deepEqual(result.failures, []);
    const statusAfterAutoReview = await storeRuntimeStatus({ sqliteSummary: false });
    assert.equal(queryCount(statusAfterAutoReview, 'list_joinApplications'), beforeFullJoinApplications);
    assert.equal(queryCount(statusAfterAutoReview, 'list_joinApplications_status') > beforePendingJoinApplications, true);
    assert.equal(queryCount(statusAfterAutoReview, 'list_joinApplications_status_missing') > beforeMissingStatusJoinApplications, true);
    assert.equal(queryCount(statusAfterAutoReview, 'list_memberBindRequests'), beforeFullMemberBindRequests);
    assert.equal(queryCount(statusAfterAutoReview, 'list_memberBindRequests_status'), beforePendingMemberBindRequests);
    assert.equal(queryCount(statusAfterAutoReview, 'list_memberBindRequests_status_missing'), beforeMissingStatusMemberBindRequests);

    const store = await readStore();
    const bindRequest = store.memberBindRequests.find((item) => item.id === 'member_bind_request_sqlite_auto_pending');
    const boundMember = store.members.find((item) => item.id === 'member_sqlite_auto_bind_target');
    const joinApplication = store.joinApplications.find((item) => item.id === 'join_application_sqlite_auto_pending');
    const claimApplication = store.joinApplications.find((item) => item.id === 'join_application_sqlite_auto_claim_pending');
    const joinedMember = store.members.find((item) => item.steamId === '76561198000008888');
    assert.equal(bindRequest.status, 'pending');
    assert.equal(boundMember.wechatUserId || '', '');
    assert.equal(joinApplication.status, 'approved');
    assert.equal(joinApplication.memberId, joinedMember.id);
    assert.equal(claimApplication.status, 'pending');
    assert.equal(store.wechatUsers.find((item) => item.id === 'wechat_user_sqlite_auto_claim').memberId, '');
    assert.equal(store.wechatUsers.find((item) => item.id === 'wechat_user_sqlite_auto_join').memberId, joinedMember.id);
    assert.equal(store.logs.some((item) => item.actorUsername === 'wechat_auto_review'), true);
  } finally {
    const sqliteModule = await import('../server/storage/sqlite.js');
    await sqliteModule.closeSqliteDatabasesForTests();
    for (const [key, value] of Object.entries(previousEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await rm(dataDir, { recursive: true, force: true });
  }
});
