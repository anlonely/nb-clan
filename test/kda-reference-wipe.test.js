import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import express from 'express';

test('planned signup server does not constrain latest closed KDA reference wipe', async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'nb-clan-kda-reference-'));
  process.env.NB_DATA_DIR = dataDir;
  process.env.NB_ROOT_PASSWORD = 'RootPass123!';
  process.env.NB_DISABLE_BACKGROUND_JOBS = '1';
  process.env.NB_DISABLE_EXTERNAL_VITAL = '1';
  process.env.NB_RUST_KDA_BASE_URL = 'https://rust-kda.anlonely.me';
  process.env.NB_RUST_KDA_PROVIDER = 'http';
  process.env.NB_WECHAT_DEV_LOGIN = '1';
  process.env.NODE_ENV = 'production';
  delete process.env.NB_COOKIE_SECURE;

  const { createApiRouter } = await import('../server/api.js');
  const { ensureStore, nowIso, readStore, updateStore } = await import('../server/store.js');
  await ensureStore();

  const app = express();
  app.use('/api', createApiRouter());
  const server = createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const baseUrl = `http://127.0.0.1:${server.address().port}/api`;

  async function request(url, options = {}) {
    const response = await fetch(`${baseUrl}${url}`, {
      method: options.method || 'GET',
      headers: {
        ...(options.body ? { 'Content-Type': 'application/json' } : {}),
        ...(options.cookie ? { Cookie: options.cookie } : {}),
        ...(options.token ? { 'x-nb-wechat-session': options.token } : {})
      },
      body: options.body ? JSON.stringify(options.body) : undefined
    });
    const text = await response.text();
    const payload = response.headers.get('content-type')?.includes('application/json') ? JSON.parse(text) : null;
    return { response, payload, text };
  }

  try {
    let result = await request('/auth/login', {
      method: 'POST',
      body: { username: 'root', password: 'RootPass123!' }
    });
    assert.equal(result.response.status, 200);
    const rootCookie = result.response.headers.get('set-cookie')?.split(';')[0] || '';
    assert.match(rootCookie, /^nb_session=/);

    result = await request('/wechat/login', {
      method: 'POST',
      body: {
        code: 'dev-reference-wipe-member',
        profile: { nickname: 'Reference Wipe Member' }
      }
    });
    assert.equal(result.response.status, 200);
    const wechatToken = result.payload.sessionToken;
    const wechatUserId = result.payload.wechatUser.id;

    await updateStore((store) => {
      const createdAt = nowIso();
      const closedMonthlyAt = '2026-06-05T18:45:00.000Z';
      const closedEuMediumAt = '2026-06-22T18:45:00.000Z';
      const member = {
        id: 'member_reference_wipe_alpha',
        steamId: '76561198000007777',
        rawInput: '76561198000007777',
        customName: 'Reference Alpha',
        steamNickname: 'ReferenceSteam',
        avatar: 'https://example.com/reference-alpha.png',
        discordId: '',
        wechatId: '',
        wechatUserId: wechatUserId,
        notes: '',
        specialty: ['pvp'],
        invitedByUserId: 'user_root',
        createdAt,
        updatedAt: createdAt
      };
      const fallbackMember = {
        id: 'member_reference_wipe_beta',
        steamId: '76561198000008888',
        rawInput: '76561198000008888',
        customName: 'Reference Beta',
        steamNickname: 'ReferenceBetaSteam',
        avatar: 'https://example.com/reference-beta.png',
        discordId: '',
        wechatId: '',
        notes: '',
        specialty: ['farming'],
        invitedByUserId: 'user_root',
        createdAt,
        updatedAt: createdAt
      };
      store.members.push(member, fallbackMember);
      const wechatUser = store.wechatUsers.find((item) => item.id === wechatUserId);
      wechatUser.memberId = member.id;
      wechatUser.status = 'approved';
      wechatUser.updatedAt = createdAt;

      store.squads.push({
        id: 'squad_reference_wipe',
        name: 'Reference Squad',
        leaderUserId: 'user_root',
        leaderUserIds: ['user_root'],
        notes: '',
        createdBy: 'user_root',
        createdAt,
        updatedAt: createdAt,
        archivedAt: ''
      });
      store.squadMembers.push({
        id: 'squad_member_reference_wipe_alpha',
        squadId: 'squad_reference_wipe',
        memberId: member.id,
        addedByUserId: 'user_root',
        createdAt
      });

      store.wipes.unshift(
        {
          id: 'wipe_reference_planned_monthly',
          name: 'Vital Rust 2X EU Monthly 2099-07-01',
          status: 'active',
          serverName: 'Vital Rust 2X EU Monthly',
          startedAt: '2099-07-01T18:45:00.000Z',
          closedAt: '',
          wipeLabel: 'Next',
          wipeMode: 'next',
          vitalServerId: '16',
          vitalWipeId: 'planned-monthly',
          battlemetricsId: '29566604',
          createdBy: 'user_root',
          createdAt,
          updatedAt: createdAt
        },
        {
          id: 'wipe_reference_closed_monthly',
          name: 'Vital Rust 2X EU Monthly 2026-06-05',
          status: 'closed',
          serverName: 'Vital Rust 2X EU Monthly',
          startedAt: '2026-06-05T18:45:00.000Z',
          closedAt: closedMonthlyAt,
          vitalServerId: '16',
          vitalWipeId: 'closed-monthly',
          battlemetricsId: '29566604',
          createdBy: 'user_root',
          createdAt: closedMonthlyAt,
          updatedAt: closedMonthlyAt
        },
        {
          id: 'wipe_reference_closed_eu_medium',
          name: 'Vital Rust 2X EU Medium 2026-06-22',
          status: 'closed',
          serverName: 'Vital Rust 2X EU Medium',
          startedAt: '2026-06-22T18:45:00.000Z',
          closedAt: closedEuMediumAt,
          vitalServerId: '19',
          vitalWipeId: 'closed-eu-medium',
          battlemetricsId: '32032048',
          createdBy: 'user_root',
          createdAt: closedEuMediumAt,
          updatedAt: closedEuMediumAt
        }
      );

      store.wipeParticipants.push(
        {
          id: 'participant_reference_closed_monthly',
          wipeId: 'wipe_reference_closed_monthly',
          memberId: member.id,
          squadId: 'squad_reference_wipe',
          status: 'on_time',
          addedByUserId: 'user_root',
          createdAt: closedMonthlyAt,
          updatedAt: closedMonthlyAt
        },
        {
          id: 'participant_reference_closed_eu_medium',
          wipeId: 'wipe_reference_closed_eu_medium',
          memberId: member.id,
          squadId: 'squad_reference_wipe',
          status: 'on_time',
          addedByUserId: 'user_root',
          createdAt: closedEuMediumAt,
          updatedAt: closedEuMediumAt
        }
      );

      const monthlyRow = {
        id: 'kda_reference_closed_monthly',
        wipeId: 'wipe_reference_closed_monthly',
        memberId: member.id,
        steamId: member.steamId,
        displayName: 'Reference Alpha',
        squadId: 'squad_reference_wipe',
        squadName: 'Reference Squad',
        kills: 7,
        deaths: 7,
        assists: 0,
        t3Kills: 1,
        kda: 1,
        rockets: 1,
        sulfur: 1000,
        metalOre: 2000,
        building: 3,
        playTimeMinutes: 120,
        onlineTimeMinutes: 60,
        source: 'test_monthly_closed',
        syncedAt: closedMonthlyAt,
        createdAt: closedMonthlyAt,
        updatedAt: closedMonthlyAt
      };
      const euMediumRow = {
        id: 'kda_reference_closed_eu_medium',
        wipeId: 'wipe_reference_closed_eu_medium',
        memberId: member.id,
        steamId: member.steamId,
        displayName: 'Reference Alpha',
        squadId: 'squad_reference_wipe',
        squadName: 'Reference Squad',
        kills: 57,
        deaths: 5,
        assists: 8,
        t3Kills: 12,
        kda: 13,
        rockets: 9,
        sulfur: 57000,
        metalOre: 88000,
        building: 42,
        playTimeMinutes: 420,
        onlineTimeMinutes: 330,
        source: 'test_eu_medium_closed',
        syncedAt: closedEuMediumAt,
        createdAt: closedEuMediumAt,
        updatedAt: closedEuMediumAt
      };
      store.kdaRows.push(monthlyRow, euMediumRow);
      store.wipeSettlements.push(
        {
          id: 'settlement_reference_closed_monthly',
          wipeId: 'wipe_reference_closed_monthly',
          generatedAt: closedMonthlyAt,
          generatedByUserId: 'user_root',
          serverSnapshot: store.wipes.find((wipe) => wipe.id === 'wipe_reference_closed_monthly'),
          participantsSnapshot: [{
            id: 'participant_reference_closed_monthly',
            wipeId: 'wipe_reference_closed_monthly',
            memberId: member.id,
            squadId: 'squad_reference_wipe',
            squadName: 'Reference Squad',
            status: 'on_time'
          }],
          squadsSnapshot: [store.squads.find((squad) => squad.id === 'squad_reference_wipe')],
          kdaSnapshot: [monthlyRow],
          summary: {}
        },
        {
          id: 'settlement_reference_closed_eu_medium',
          wipeId: 'wipe_reference_closed_eu_medium',
          generatedAt: closedEuMediumAt,
          generatedByUserId: 'user_root',
          serverSnapshot: store.wipes.find((wipe) => wipe.id === 'wipe_reference_closed_eu_medium'),
          participantsSnapshot: [{
            id: 'participant_reference_closed_eu_medium',
            wipeId: 'wipe_reference_closed_eu_medium',
            memberId: member.id,
            squadId: 'squad_reference_wipe',
            squadName: 'Reference Squad',
            status: 'on_time'
          }],
          squadsSnapshot: [store.squads.find((squad) => squad.id === 'squad_reference_wipe')],
          kdaSnapshot: [euMediumRow],
          summary: {}
        }
      );
    });

    result = await request('/members/member_reference_wipe_alpha/profile', { cookie: rootCookie });
    assert.equal(result.response.status, 200);
    assert.equal(result.payload.member.currentWipe.wipeId, 'wipe_reference_planned_monthly');
    assert.equal(result.payload.member.currentWipe.wipeStatus, 'planned');
    assert.equal(result.payload.member.currentKda.wipeId, 'wipe_reference_closed_eu_medium');
    assert.equal(result.payload.member.currentKda.serverName, 'Vital Rust 2X EU Medium');
    assert.equal(result.payload.member.currentKda.kills, 57);

    result = await request('/wechat/profile', { token: wechatToken });
    assert.equal(result.response.status, 200);
    assert.equal(result.payload.profile.currentWipe.wipeId, 'wipe_reference_planned_monthly');
    assert.equal(result.payload.profile.currentKda.wipeId, 'wipe_reference_closed_eu_medium');
    assert.equal(result.payload.profile.currentKda.serverName, 'Vital Rust 2X EU Medium');

    result = await request('/wechat/rankings?metric=kda', { token: wechatToken });
    assert.equal(result.response.status, 200);
    assert.equal(result.payload.wipe.id, 'wipe_reference_closed_eu_medium');
    assert.equal(result.payload.wipe.serverName, 'Vital Rust 2X EU Medium');
    assert.equal(result.payload.rows[0].steamId, '76561198000007777');
    assert.equal(result.payload.rows[0].value, 13);
    assert.equal(result.payload.myRow.metricRanks.kills.value, 57);

    const realFetch = globalThis.fetch;
    const previousExternalVital = process.env.NB_DISABLE_EXTERNAL_VITAL;
    let fallbackRequestCount = 0;
    process.env.NB_DISABLE_EXTERNAL_VITAL = '0';
    globalThis.fetch = async (url, options = {}) => {
      if (String(url) === 'https://playerstatistics.vitalgamenetwork.com/players/overview') {
        fallbackRequestCount += 1;
        const body = JSON.parse(options.body || '{}');
        assert.deepEqual(body.playerIds, ['76561198000008888']);
        assert.equal(body.serverId, 19);
        assert.equal(body.wipeId, 'closed-eu-medium');
        return new Response(JSON.stringify({
          statusCode: 200,
          data: [{
            context: { userId: '76561198000008888' },
            player: { name: 'Reference Beta' },
            statistics: {
              combat: { kills: '91', killsT3: '13', deaths: '7' },
              raiding: { rockets: '3' },
              farming: { gathered: { 'sulfur.ore': '120000', 'metal.ore': '340000' } },
              building: { buildings: { wall: 4, foundation: 2 } }
            }
          }]
        }), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      return realFetch(url, options);
    };
    try {
      result = await request('/members/member_reference_wipe_beta/profile', { cookie: rootCookie });
      assert.equal(result.response.status, 200);
      assert.equal(result.payload.member.currentKda.wipeId, 'wipe_reference_closed_eu_medium');
      assert.equal(result.payload.member.currentKda.serverName, 'Vital Rust 2X EU Medium');
      assert.equal(result.payload.member.currentKda.kills, 91);
      assert.equal(result.payload.member.currentKda.t3Kills, 13);
      assert.equal(result.payload.member.currentKda.kda, 13);
      assert.equal(result.payload.member.currentKda.sulfur, 120000);
      assert.equal(result.payload.member.currentKda.metalOre, 340000);
      assert.equal(fallbackRequestCount, 1);
      const snapshot = await readStore();
      assert.equal(snapshot.kdaRows.some((row) => row.memberId === 'member_reference_wipe_beta'), false);
    } finally {
      globalThis.fetch = realFetch;
      process.env.NB_DISABLE_EXTERNAL_VITAL = previousExternalVital;
    }
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await rm(dataDir, { recursive: true, force: true });
  }
});

test('wechat rankings fall back to latest closed wipe when active wipe has no KDA rows yet', async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'nb-clan-wechat-ranking-reference-'));
  process.env.NB_DATA_DIR = dataDir;
  process.env.NB_ROOT_PASSWORD = 'RootPass123!';
  process.env.NB_DISABLE_BACKGROUND_JOBS = '1';
  process.env.NB_DISABLE_EXTERNAL_VITAL = '1';
  process.env.NB_WECHAT_DEV_LOGIN = '1';
  process.env.NODE_ENV = 'production';
  delete process.env.NB_COOKIE_SECURE;

  const { createApiRouter } = await import('../server/api.js');
  const { ensureStore, nowIso, updateStore } = await import('../server/store.js');
  await ensureStore();

  const app = express();
  app.use('/api', createApiRouter());
  const server = createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const baseUrl = `http://127.0.0.1:${server.address().port}/api`;

  async function request(url, options = {}) {
    const response = await fetch(`${baseUrl}${url}`, {
      method: options.method || 'GET',
      headers: {
        ...(options.body ? { 'Content-Type': 'application/json' } : {}),
        ...(options.token ? { 'x-nb-wechat-session': options.token } : {})
      },
      body: options.body ? JSON.stringify(options.body) : undefined
    });
    const text = await response.text();
    const payload = response.headers.get('content-type')?.includes('application/json') ? JSON.parse(text) : null;
    return { response, payload, text };
  }

  try {
    let result = await request('/wechat/login', {
      method: 'POST',
      body: {
        code: 'dev-ranking-fallback-member',
        profile: { nickname: 'Ranking Fallback Member' }
      }
    });
    assert.equal(result.response.status, 200);
    const wechatToken = result.payload.sessionToken;
    const wechatUserId = result.payload.wechatUser.id;

    await updateStore((store) => {
      const createdAt = nowIso();
      const closedAt = '2026-06-20T18:45:00.000Z';
      const member = {
        id: 'member_wechat_ranking_fallback',
        steamId: '76561198000009997',
        rawInput: '76561198000009997',
        customName: 'Ranking Viewer',
        steamNickname: 'RankingViewerSteam',
        avatar: 'https://example.com/ranking-viewer.png',
        discordId: '',
        wechatId: '',
        wechatUserId,
        notes: '',
        specialty: ['pvp'],
        invitedByUserId: 'user_root',
        createdAt,
        updatedAt: createdAt
      };
      const rankingMember = {
        id: 'member_wechat_ranking_archived',
        steamId: '76561198000009998',
        rawInput: '76561198000009998',
        customName: 'Ranking Fallback',
        steamNickname: 'RankingFallbackSteam',
        avatar: 'https://example.com/ranking-fallback.png',
        discordId: '',
        wechatId: '',
        notes: '',
        specialty: ['pvp'],
        invitedByUserId: 'user_root',
        createdAt,
        updatedAt: createdAt
      };
      store.members.push(member, rankingMember);
      const wechatUser = store.wechatUsers.find((item) => item.id === wechatUserId);
      wechatUser.memberId = member.id;
      wechatUser.status = 'approved';
      wechatUser.updatedAt = createdAt;

      store.squads.push({
        id: 'squad_wechat_ranking_fallback',
        name: 'Fallback Squad',
        leaderUserId: 'user_root',
        leaderUserIds: ['user_root'],
        notes: '',
        createdBy: 'user_root',
        createdAt,
        updatedAt: createdAt,
        archivedAt: ''
      });
      store.squadMembers.push({
        id: 'squad_member_wechat_ranking_fallback',
        squadId: 'squad_wechat_ranking_fallback',
        memberId: rankingMember.id,
        addedByUserId: 'user_root',
        createdAt
      });

      store.wipes.unshift(
        {
          id: 'wipe_wechat_active_no_kda',
          name: 'Vital Rust 2X EU Monthly 2026-06-26',
          status: 'active',
          serverName: 'Vital Rust 2X EU Monthly',
          startedAt: '2026-06-26T18:45:00.000Z',
          closedAt: '',
          vitalServerId: '16',
          vitalWipeId: 'active-no-kda',
          battlemetricsId: '29566604',
          createdBy: 'user_root',
          createdAt,
          updatedAt: createdAt
        },
        {
          id: 'wipe_wechat_closed_with_kda',
          name: 'Vital Rust 2X EU Medium 2026-06-20',
          status: 'closed',
          serverName: 'Vital Rust 2X EU Medium',
          startedAt: '2026-06-20T18:45:00.000Z',
          closedAt,
          vitalServerId: '19',
          vitalWipeId: 'closed-with-kda',
          battlemetricsId: '32032048',
          createdBy: 'user_root',
          createdAt: closedAt,
          updatedAt: closedAt
        }
      );

      store.wipeParticipants.push({
        id: 'participant_wechat_closed_with_kda',
        wipeId: 'wipe_wechat_closed_with_kda',
        memberId: rankingMember.id,
        member: { ...rankingMember },
        squadId: 'squad_wechat_ranking_fallback',
        squadName: 'Fallback Squad',
        status: 'on_time',
        addedByUserId: 'user_root',
        createdAt: closedAt,
        updatedAt: closedAt
      });

      store.kdaRows.push({
        id: 'kda_wechat_closed_with_kda',
        wipeId: 'wipe_wechat_closed_with_kda',
        memberId: rankingMember.id,
        steamId: rankingMember.steamId,
        displayName: 'Ranking Fallback',
        member: { ...rankingMember },
        squadId: 'squad_wechat_ranking_fallback',
        squadName: 'Fallback Squad',
        kills: 57,
        deaths: 3,
        assists: 5,
        t3Kills: 9,
        kda: 20.67,
        rockets: 4,
        sulfur: 45000,
        metalOre: 62000,
        building: 12,
        playTimeMinutes: 360,
        onlineTimeMinutes: 240,
        source: 'test_wechat_ranking_fallback',
        syncedAt: closedAt,
        createdAt: closedAt,
        updatedAt: closedAt
      });
      store.wipeSettlements.push({
        id: 'settlement_wechat_closed_with_kda',
        wipeId: 'wipe_wechat_closed_with_kda',
        generatedByUserId: 'user_root',
        generatedAt: closedAt,
        serverSnapshot: store.wipes.find((item) => item.id === 'wipe_wechat_closed_with_kda'),
        participantsSnapshot: [{
          wipeId: 'wipe_wechat_closed_with_kda',
          memberId: rankingMember.id,
          member: { ...rankingMember },
          squadId: 'squad_wechat_ranking_fallback',
          squadName: 'Fallback Squad',
          status: 'on_time'
        }],
        squadsSnapshot: [store.squads.find((item) => item.id === 'squad_wechat_ranking_fallback')],
        kdaSnapshot: [{
          id: 'kda_wechat_closed_with_kda',
          wipeId: 'wipe_wechat_closed_with_kda',
          memberId: rankingMember.id,
          steamId: rankingMember.steamId,
          displayName: 'Ranking Fallback',
          member: { ...rankingMember },
          squadId: 'squad_wechat_ranking_fallback',
          squadName: 'Fallback Squad',
          kills: 57,
          deaths: 3,
          assists: 5,
          t3Kills: 9,
          kda: 20.67,
          rockets: 4,
          sulfur: 45000,
          metalOre: 62000,
          building: 12,
          playTimeMinutes: 360,
          onlineTimeMinutes: 240,
          source: 'test_wechat_ranking_fallback',
          syncedAt: closedAt,
          createdAt: closedAt,
          updatedAt: closedAt
        }],
        summary: {}
      });
      store.members = store.members.filter((item) => item.id !== rankingMember.id);
      store.squadMembers = store.squadMembers.filter((item) => item.memberId !== rankingMember.id);
    });

    result = await request('/wechat/rankings?metric=kda', { token: wechatToken });
    assert.equal(result.response.status, 200);
    assert.equal(result.payload.wipe.id, 'wipe_wechat_closed_with_kda');
    assert.equal(result.payload.wipe.serverName, 'Vital Rust 2X EU Medium');
    assert.equal(result.payload.rows[0].steamId, '76561198000009998');
    assert.equal(result.payload.rows[0].value, 20.67);
    assert.equal(result.payload.rows[0].memberDetail.isCurrentMember, false);
    assert.equal(result.payload.rows[0].memberDetail.memberStatus, 'archived');
    assert.equal(result.payload.rows[0].memberDetail.memberStatusText, '历史成员');
    assert.equal(result.payload.rows[0].memberDetail.membershipLabel, '历史成员');
    assert.equal(result.payload.rows[0].memberDetail.squadName, 'Fallback Squad');
  } finally {
    server.close();
    await rm(dataDir, { recursive: true, force: true });
    delete process.env.NB_DATA_DIR;
    delete process.env.NB_ROOT_PASSWORD;
    delete process.env.NB_DISABLE_BACKGROUND_JOBS;
    delete process.env.NB_DISABLE_EXTERNAL_VITAL;
    delete process.env.NB_RUST_KDA_BASE_URL;
    delete process.env.NB_RUST_KDA_PROVIDER;
    delete process.env.NB_WECHAT_DEV_LOGIN;
    delete process.env.NODE_ENV;
  }
});
