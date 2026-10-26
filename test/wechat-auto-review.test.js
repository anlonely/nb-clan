import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

test('wechat auto review only processes unified member registration applications', async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'nb-clan-wechat-auto-review-'));
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
  process.env.NB_WECHAT_AUTO_REVIEW_ENABLED = '1';
  process.env.NB_DISABLE_BACKGROUND_JOBS = '1';
  delete process.env.NB_STORAGE_MODE;
  delete process.env.NB_SQLITE_FILE;

  try {
    const { runWechatAutoReviewApprovals } = await import('../server/api.js');
    const { ensureStore, nowIso, readStore, updateStore } = await import('../server/store.js');
    await ensureStore();

    await updateStore((store) => {
      const createdAt = nowIso();
      store.members.push({
        id: 'member_auto_bind_target',
        steamId: '76561198000004444',
        rawInput: '76561198000004444',
        customName: 'Auto Bind Target',
        steamNickname: 'AutoBindSteam',
        avatar: '',
        discordId: '',
        wechatId: '',
        wechatUserId: '',
        phone: '',
        notes: '',
        specialty: ['pvp'],
        specialties: ['pvp'],
        battlemetricsId: '',
        memberStatus: 'active',
        invitedByUserId: 'user_root',
        createdAt,
        updatedAt: createdAt
      });
      store.wechatUsers.push({
        id: 'wechat_user_auto_bind',
        openid: 'openid_auto_bind',
        unionid: '',
        nickname: '老队员绑定',
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
        id: 'wechat_user_auto_join',
        openid: 'openid_auto_join',
        unionid: '',
        nickname: '新成员入队',
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
        id: 'wechat_user_need_more',
        openid: 'openid_need_more',
        unionid: '',
        nickname: '补充资料',
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
        id: 'wechat_user_auto_claim',
        openid: 'openid_auto_claim',
        unionid: '',
        nickname: '统一注册认领',
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
        id: 'member_bind_request_auto_pending',
        wechatUserId: 'wechat_user_auto_bind',
        targetMemberId: 'member_auto_bind_target',
        steamId: '76561198000004444',
        steamNickname: 'AutoBindSteam',
        wechatId: '',
        discordId: '',
        inviterText: '',
        note: '自动同意老队员绑定',
        status: 'pending',
        adminNote: '',
        reviewNote: '',
        reviewedByUserId: '',
        reviewedAt: '',
        createdAt,
        updatedAt: createdAt
      });
      store.joinApplications.push({
        id: 'join_application_auto_pending',
        wechatUserId: 'wechat_user_auto_join',
        memberId: '',
        steamInput: '76561198000005555',
        steamId: '76561198000005555',
        steamNickname: 'AutoJoinSteam',
        steamAvatar: '',
        wechatId: '',
        discordId: '',
        region: '',
        timezone: '',
        timeZone: '',
        inviterText: 'Auto',
        reason: '自动同意入队',
        specialties: ['pvp', 'building'],
        specialtiesRaw: ['pvp', 'building'],
        status: 'pending',
        adminNote: '',
        reviewNote: '',
        reviewedByUserId: '',
        reviewedAt: '',
        createdAt,
        updatedAt: createdAt
      });
      store.joinApplications.push({
        id: 'join_application_need_more',
        wechatUserId: 'wechat_user_need_more',
        memberId: '',
        steamInput: '76561198000006666',
        steamId: '76561198000006666',
        steamNickname: 'NeedMoreSteam',
        steamAvatar: '',
        reason: '需要补充资料',
        specialties: ['pvp'],
        status: 'need_more',
        adminNote: '先补充说明',
        reviewNote: '先补充说明',
        reviewedByUserId: 'user_root',
        reviewedAt: createdAt,
        createdAt,
        updatedAt: createdAt
      });
      store.joinApplications.push({
        id: 'join_application_auto_claim_pending',
        wechatUserId: 'wechat_user_auto_claim',
        memberId: '',
        targetMemberId: 'member_auto_bind_target',
        registrationMode: 'claim',
        steamInput: '76561198000004444',
        steamId: '76561198000004444',
        steamNickname: 'AutoBindSteam',
        steamAvatar: '',
        notes: '认领已有成员必须人工审核',
        reason: '认领已有成员必须人工审核',
        specialties: ['pvp'],
        status: 'pending',
        adminNote: '',
        reviewNote: '',
        reviewedByUserId: '',
        reviewedAt: '',
        createdAt,
        updatedAt: createdAt
      });
    });

    const result = await runWechatAutoReviewApprovals({ force: true, limit: 10 });
    assert.equal(result.join.checked, 1);
    assert.equal(result.join.approved, 1);
    assert.equal('bind' in result, false);
    assert.deepEqual(result.failures, []);

    const store = await readStore();
    const boundMember = store.members.find((item) => item.id === 'member_auto_bind_target');
    const boundWechatUser = store.wechatUsers.find((item) => item.id === 'wechat_user_auto_bind');
    assert.equal(boundMember.wechatUserId || '', '');
    assert.equal(boundMember.wechatId || '', '');
    assert.equal(boundWechatUser.status, 'guest');
    assert.equal(boundWechatUser.memberId, '');
    assert.equal(store.memberBindRequests.find((item) => item.id === 'member_bind_request_auto_pending').status, 'pending');
    assert.equal(store.joinApplications.find((item) => item.id === 'join_application_auto_claim_pending').status, 'pending');
    assert.equal(store.wechatUsers.find((item) => item.id === 'wechat_user_auto_claim').memberId, '');

    const joinedMember = store.members.find((item) => item.steamId === '76561198000005555');
    const joinedWechatUser = store.wechatUsers.find((item) => item.id === 'wechat_user_auto_join');
    const joinedApplication = store.joinApplications.find((item) => item.id === 'join_application_auto_pending');
    assert.ok(joinedMember);
    assert.equal(joinedMember.wechatUserId, 'wechat_user_auto_join');
    assert.deepEqual(joinedMember.specialties, ['pvp', 'building']);
    assert.equal(joinedWechatUser.status, 'approved');
    assert.equal(joinedWechatUser.memberId, joinedMember.id);
    assert.equal(joinedApplication.status, 'approved');
    assert.equal(joinedApplication.memberId, joinedMember.id);

    const needMoreApplication = store.joinApplications.find((item) => item.id === 'join_application_need_more');
    assert.equal(needMoreApplication.status, 'need_more');
    assert.equal(needMoreApplication.memberId, '');
    assert.equal(store.wechatUsers.find((item) => item.id === 'wechat_user_need_more').memberId, '');

    const autoLogs = store.logs.filter((item) => item.metadata?.source === 'wechat_auto_review');
    assert.equal(autoLogs.some((item) => item.type === 'join_application_approve'), true);
    assert.equal(autoLogs.some((item) => item.type === 'member_bind_request_approve'), false);
    assert.equal(autoLogs.every((item) => item.actorUsername === 'wechat_auto_review'), true);
  } finally {
    for (const [key, value] of Object.entries(previousEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await rm(dataDir, { recursive: true, force: true });
  }
});
