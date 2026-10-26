import './support/owner-environment.mjs';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import express from 'express';
import WebSocket from 'ws';

process.env.NB_RUSTPLUS_RELAY_CHAT_LIMIT = '2';
process.env.NB_RUSTPLUS_RELAY_CHAT_FLUSH_INTERVAL_MS = '0';
process.env.NB_RUSTPLUS_RELAY_MEMBER_DELTA_WRITE_DEDUPE_MS = '1000';
process.env.NB_RUSTPLUS_RELAY_MEMBER_ONLINE_STALE_MS = String(30 * 60_000);

test('rustplus relay uses dedicated token auth, persists live data, streams SSE, and pushes translated Discord chat', async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'nb-clan-rustplus-relay-'));
  process.env.NB_DATA_DIR = dataDir;
  process.env.NB_ROOT_PASSWORD = 'RootPass123!';
  process.env.NB_DISABLE_BACKGROUND_JOBS = '1';
  process.env.NB_DISCORD_SEND_INTERVAL_MS = '0';
  process.env.NB_DISCORD_MESSAGE_MAX_ATTEMPTS = '3';
  process.env.NODE_ENV = 'production';
  delete process.env.NB_COOKIE_SECURE;

  const discordRequests = [];
  const discordAttempts = [];
  let discordRateLimitedBackupChannel = false;
  const discordApp = express();
  discordApp.use(express.json());
  discordApp.post('/channels/:channelId/messages', (req, res) => {
    const requestRecord = {
      channelId: req.params.channelId,
      authorization: req.get('authorization') || '',
      body: req.body
    };
    discordAttempts.push(requestRecord);
    if (req.params.channelId === '444444444444444444' && !discordRateLimitedBackupChannel) {
      discordRateLimitedBackupChannel = true;
      res.set('retry-after', '0.01');
      res.status(429).json({ message: 'Rate limited', retry_after: 0.01 });
      return;
    }
    discordRequests.push(requestRecord);
    res.json({
      id: `discord_message_${discordRequests.length}`,
      channel_id: req.params.channelId
    });
  });
  const discordServer = createServer(discordApp);
  await new Promise((resolve) => discordServer.listen(0, '127.0.0.1', resolve));
  process.env.NB_DISCORD_API_BASE_URL = `http://127.0.0.1:${discordServer.address().port}`;

  const kookPipeRequests = [];
  const kookApp = express();
  kookApp.use(express.json());
  kookApp.post('/api/v3/message/send-pipemsg', (req, res) => {
    const id = `kook_pipe_${kookPipeRequests.length + 1}`;
    kookPipeRequests.push({
      query: req.query,
      body: req.body
    });
    res.json({
      code: 0,
      message: '操作成功',
      data: {
        msg_id: id,
        msg_timestamp: Date.UTC(2026, 5, 17, 0, 9 + kookPipeRequests.length),
        nonce: ''
      }
    });
  });
  const kookServer = createServer(kookApp);
  await new Promise((resolve) => kookServer.listen(0, '127.0.0.1', resolve));
  process.env.NB_KOOK_API_BASE_URL = `http://127.0.0.1:${kookServer.address().port}/api/v3`;

  const { createApiRouter, forwardRustplusRelayChatToDiscord } = await import('../server/api.js');
  const { installRustplusRelayWebSocket } = await import('../server/rustplus-relay-stream.js');
  const { ensureStore, hashPassword, readStore, updateStore } = await import('../server/store.js');
  const { normalizeRustplusRelayPayload, publicRustplusRelayState, rustplusRelaySettingsPayload } = await import('../server/rustplus-relay.js');
  await ensureStore();

  await updateStore(async (store) => {
    const now = new Date().toISOString();
    store.users.push({
      id: 'user_relay_viewer',
      username: 'relay_viewer',
      role: 'viewer',
      passwordHash: await hashPassword('ViewerPass123!'),
      boundSteamId: '',
      steamNickname: '',
      createdAt: now,
      updatedAt: now,
      createdBy: 'user_root'
    }, {
      id: 'user_clan_info_reader',
      username: 'clan_info_reader',
      role: 'clan_info_reader',
      passwordHash: await hashPassword('InfoPass123!'),
      boundSteamId: '',
      steamNickname: '',
      createdAt: now,
      updatedAt: now,
      createdBy: 'user_root'
    }, {
      id: 'user_clan_chat_reader',
      username: 'clan_chat_reader',
      role: 'clan_chat_reader',
      passwordHash: await hashPassword('ChatPass123!'),
      boundSteamId: '',
      steamNickname: '',
      createdAt: now,
      updatedAt: now,
      createdBy: 'user_root'
    }, {
      id: 'user_clan_chat_operator',
      username: 'clan_chat_operator',
      role: 'clan_chat_operator',
      passwordHash: await hashPassword('OperatorPass123!'),
      boundSteamId: '76561198000000004',
      steamNickname: 'DeltaSteam',
      createdAt: now,
      updatedAt: now,
      createdBy: 'user_root'
    });
    store.permissionRoles.push({
      code: 'clan_info_reader',
      name: 'Clan info reader',
      permissions: {
        rustClanInfo: { view: true },
        rustClanChat: { view: false },
        rustTools: { view: false }
      }
    }, {
      code: 'clan_chat_reader',
      name: 'Clan chat reader',
      permissions: {
        rustClanChat: { view: true },
        rustClanInfo: { view: false },
        rustTools: { view: false }
      }
    }, {
      code: 'clan_chat_operator',
      name: 'Clan chat operator',
      permissions: {
        rustClanChat: { view: true, edit: true },
        rustClanInfo: { view: true },
        rustTools: { view: false }
      }
    });
    store.members.push({
      id: 'member_system_alpha',
      steamId: '76561198000000001',
      rawInput: '76561198000000001',
      customName: 'System Alpha',
      steamNickname: 'AlphaSteam',
      discordId: '666666666666666666',
      discordName: 'AlphaDiscord',
      avatar: 'https://avatars.test/system-alpha.jpg',
      specialty: [],
      invitedByUserId: 'user_root',
      createdAt: now,
      updatedAt: now
    }, {
      id: 'member_system_delta',
      steamId: '76561198000000004',
      rawInput: '76561198000000004',
      customName: 'Delta',
      steamNickname: 'DeltaSteam',
      discordId: '555555555555555555',
      discordName: 'Kristian123 - kris132',
      avatar: '',
      specialty: [],
      battlemetricsId: 'bm_relay_delta',
      invitedByUserId: 'user_root',
      createdAt: now,
      updatedAt: now
    }, {
      id: 'member_system_sobad',
      steamId: '76561198000000007',
      rawInput: '76561198000000007',
      customName: 'So bad',
      steamNickname: 'So bad',
      discordId: '777777777777777777',
      discordName: '',
      avatar: '',
      specialty: [],
      invitedByUserId: 'user_root',
      createdAt: now,
      updatedAt: now
    });
    store.wipes.push({
      id: 'wipe_relay_current',
      name: 'EU Main',
      status: 'active',
      serverName: 'EU Main',
      startedAt: '2026-06-17T00:00:00.000Z',
      closedAt: '',
      battlemetricsId: 'server-eu',
      createdAt: now,
      updatedAt: now
    }, {
      id: 'wipe_relay_old',
      name: 'EU Main Old',
      status: 'closed',
      serverName: 'EU Main',
      startedAt: '2026-06-10T00:00:00.000Z',
      closedAt: '2026-06-11T00:00:00.000Z',
      battlemetricsId: 'server-eu',
      createdAt: now,
      updatedAt: now
    });
    store.memberProfiles.push({
      id: 'member_profile_relay_alpha',
      memberId: 'member_system_alpha',
      steamId: '76561198000000001',
      battlemetricsPlayerId: 'bm_relay_alpha',
      battlemetricsServerId: 'server-eu',
      battlemetricsServerName: 'EU Main',
      battlemetricsWipeId: 'wipe_relay_current',
      battlemetricsWipeName: 'EU Main',
      battlemetricsWipeStatus: 'active',
      battlemetricsLastOnlineAt: '2026-06-17T00:05:00.000Z',
      battlemetricsLastOfflineAt: '2026-06-17T01:20:00.000Z',
      battlemetricsServerPlayTimeSeconds: 75 * 60,
      battlemetricsWeeklyPlayTimeSeconds: 75 * 60,
      battlemetricsSyncedAt: '2026-06-17T01:20:00.000Z'
    }, {
      id: 'member_profile_relay_delta',
      memberId: 'member_system_delta',
      steamId: '76561198000000004',
      battlemetricsPlayerId: 'bm_relay_delta',
      battlemetricsServerId: 'server-eu',
      battlemetricsServerName: 'EU Main',
      battlemetricsWipeId: 'wipe_relay_old',
      battlemetricsWipeName: 'EU Main Old',
      battlemetricsWipeStatus: 'closed',
      battlemetricsLastOnlineAt: '2026-06-10T00:10:00.000Z',
      battlemetricsLastOfflineAt: '2026-06-10T01:49:00.000Z',
      battlemetricsServerPlayTimeSeconds: 99 * 60,
      battlemetricsWeeklyPlayTimeSeconds: 99 * 60,
      battlemetricsSyncedAt: '2026-06-10T01:49:00.000Z'
    });
    store.settings.battlemetrics.apiKey = 'bm_api_key_12345678901234567890';
    store.settings.discord.botToken = 'discord_bot_token_12345678901234567890';
    store.settings.discord.targets = [
      {
        id: 'default',
        name: 'Default channel',
        guildId: '111111111111111111',
        channelId: '222222222222222222',
        memberRegisterChannelId: '',
        memberReviewChannelId: '',
        mapChannelId: '',
        kdaQueryChannelId: '',
        memberRankingChannelId: '',
        memberRegisterRoleId: '',
        memberManageRoleId: '',
        memberRegisterSquadName: '57',
        memberRegisterRoleSquadRules: []
      },
      {
        id: 'backup',
        name: 'Backup channel',
        guildId: '333333333333333333',
        channelId: '444444444444444444',
        memberRegisterChannelId: '',
        memberReviewChannelId: '',
        mapChannelId: '',
        kdaQueryChannelId: '',
        memberRankingChannelId: '',
        memberRegisterRoleId: '',
        memberManageRoleId: '',
        memberRegisterSquadName: '57',
        memberRegisterRoleSquadRules: []
      }
    ];
  });

  const app = express();
  app.use('/api', createApiRouter());
  const server = createServer(app);
  const relayWsServer = installRustplusRelayWebSocket(server, { onRelayPayload: forwardRustplusRelayChatToDiscord });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const baseUrl = `http://127.0.0.1:${server.address().port}/api`;
  const relayWsUrl = `ws://127.0.0.1:${server.address().port}/api/integrations/rustplus/stream`;
  let cookie = '';
  const relaySockets = new Set();

  async function request(url, options = {}) {
    const response = await fetch(`${baseUrl}${url}`, {
      method: options.method || 'GET',
      headers: {
        ...(options.body ? { 'Content-Type': 'application/json' } : {}),
        ...(cookie ? { Cookie: cookie } : {}),
        ...(options.headers || {})
      },
      body: options.body ? JSON.stringify(options.body) : undefined
    });
    const setCookie = response.headers.get('set-cookie');
    if (setCookie) cookie = setCookie.split(';')[0];
    const text = await response.text();
    const payload = response.headers.get('content-type')?.includes('application/json') ? JSON.parse(text) : null;
    return { response, payload, text };
  }

  async function closeHttpServer(target) {
    await new Promise((resolve, reject) => {
      target.close((error) => (error ? reject(error) : resolve()));
    });
  }

  async function closeWebSocketServer(target) {
    for (const client of target.clients) {
      client.terminate();
    }
    await new Promise((resolve, reject) => {
      target.close((error) => (error ? reject(error) : resolve()));
    });
  }

  async function readWsJson(ws, timeoutMs = 1000) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        cleanup();
        reject(new Error('Timed out waiting for WebSocket message'));
      }, timeoutMs);
      timer.unref?.();
      const cleanup = () => {
        clearTimeout(timer);
        ws.off('message', onMessage);
        ws.off('error', onError);
      };
      const onMessage = (data) => {
        cleanup();
        try {
          resolve(JSON.parse(data.toString()));
        } catch (error) {
          reject(error);
        }
      };
      const onError = (error) => {
        cleanup();
        reject(error);
      };
      ws.once('message', onMessage);
      ws.once('error', onError);
    });
  }

  async function openRelayWebSocket(token) {
    const ws = new WebSocket(relayWsUrl, { headers: { Authorization: `Bearer ${token}` } });
    relaySockets.add(ws);
    ws.once('close', () => relaySockets.delete(ws));
    const helloPromise = readWsJson(ws);
    await new Promise((resolve, reject) => {
      ws.once('open', resolve);
      ws.once('error', reject);
    });
    const hello = await helloPromise;
    return { ws, hello };
  }

  async function waitFor(predicate, timeoutMs = 1000) {
    const startedAt = Date.now();
    while (Date.now() - startedAt < timeoutMs) {
      if (predicate()) return;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    assert.equal(predicate(), true);
  }

  async function waitForAsync(predicate, timeoutMs = 1000) {
    const startedAt = Date.now();
    while (Date.now() - startedAt < timeoutMs) {
      if (await predicate()) return;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    assert.equal(await predicate(), true);
  }

  function rustplusForwardRuns(store, chatMessageId, platform) {
    return (store.operationRuns || []).filter((run) => (
      run.type === 'rustplus_relay_chat_forward' &&
        run.platform === platform &&
        run.targetType === 'rustplus_relay_chat_message' &&
        run.targetId === chatMessageId
    ));
  }

  function rustplusForwardRefs(store, chatMessageId, platform) {
    return (store.integrationMessageRefs || []).filter((ref) => (
      ref.platform === platform &&
        ref.kind === 'rustplus_relay_chat_forward' &&
        ref.targetType === 'rustplus_relay_chat_message' &&
        ref.targetId === chatMessageId
    ));
  }

  try {
    let result = await request('/auth/login', { method: 'POST', body: { username: 'root', password: 'RootPass123!' } });
    assert.equal(result.response.status, 200);
    const rootCookie = cookie;

    result = await request('/settings/rustplus-relay');
    assert.equal(result.response.status, 200);
    assert.equal(result.payload.rustplusRelay.enabled, false);
    assert.equal(result.payload.rustplusRelay.endpoint, '/api/integrations/rustplus/relay');
    assert.equal(result.payload.rustplusRelay.streamEndpoint, '/api/integrations/rustplus/stream');

    const relayToken = 'relay_token_12345678901234567890';
    result = await request('/settings/rustplus-relay', { method: 'PUT', body: { token: 'short' } });
    assert.equal(result.response.status, 400);
    result = await request('/settings/rustplus-relay', { method: 'PUT', body: { token: relayToken } });
    assert.equal(result.response.status, 200);
    assert.equal(result.payload.rustplusRelay.enabled, true);

    let store = await readStore();
    assert.ok(store.settings.rustplusRelay.tokenHash.startsWith('scrypt$'));
    assert.notEqual(store.settings.rustplusRelay.tokenHash, relayToken);
    assert.equal(JSON.stringify(store).includes(relayToken), false);

    result = await request('/integrations/rustplus/relay', {
      method: 'POST',
      body: { type: 'clan_snapshot', clientId: 'client-a' }
    });
    assert.equal(result.response.status, 401);

    const normalized = normalizeRustplusRelayPayload({
      type: 'clan_snapshot',
      clientId: 'client-a',
      clientName: 'NB Main',
      server: { id: 'server-eu', name: 'EU Main' },
      clanName: 'NBx57 CLAN',
      clanId: '912',
      memberLimit: 40,
      announcement: '',
      members: [
        { steamId: '76561198000000001', displayName: 'Alpha', online: true, avatar: 'https://avatars.test/alpha.jpg', lastOnlineAt: '2026-06-17T00:00:00.000Z', onlineTimeMinutes: 360 },
        { steamId: '76561198000000002', displayName: 'Bravo', online: false, lastSeen: 1781720269 }
      ],
      invites: [{ steamId: '76561198000000003', displayName: 'Charlie', invitedBy: 'Alpha' }]
    }, { receivedAt: '2026-06-17T00:00:00.000Z' });
    assert.equal(normalized.type, 'clan_snapshot');
    assert.equal(normalized.clan.name, 'NBx57 CLAN');
    assert.equal(normalized.clan.id, '912');
    assert.equal(normalized.clan.memberLimit, 40);
    assert.equal(normalized.summary.onlineCount, 1);
    assert.equal(normalized.members[0].avatar, 'https://avatars.test/alpha.jpg');
    assert.equal(normalized.members[0].onlineTimeMinutes, 360);
    assert.equal(normalized.members[1].lastSeenAt, '2026-06-17T18:17:49.000Z');
    assert.equal(normalized.members[1].lastOnlineAt, '');
    assert.equal(normalized.members[1].lastOfflineAt, '');
    assert.equal(normalized.invites[0].displayName, 'Charlie');

    const rustGoEnvelope = normalizeRustplusRelayPayload({
      type: 'clan_info',
      event: 'clanChanged',
      clientName: 'Desktop',
      server: { id: 'server-eu', name: 'EU Main' },
      clan: {
        clanId: { low: 123, high: 0, unsigned: true },
        name: 'NB',
        announcement: 'Read only notice',
        members: [{ steamId: '76561198000000005', name: 'Echo', online: true, lastSeen: { low: 1781720269, high: 0, unsigned: true } }],
        invites: [{ inviteeSteamId: '76561198000000006', recruiterSteamId: '76561198000000005' }]
      }
    }, { receivedAt: '2026-06-17T00:00:00.000Z' });
    assert.equal(rustGoEnvelope.type, 'clan_snapshot');
    assert.equal(rustGoEnvelope.client.id, 'Desktop');
    assert.equal(rustGoEnvelope.client.name, 'Desktop');
    assert.equal(rustGoEnvelope.server.key, 'Desktop:server-eu');
    assert.equal(rustGoEnvelope.clan.id, '123');
    assert.equal(rustGoEnvelope.clan.announcement, 'Read only notice');
    assert.equal(rustGoEnvelope.members[0].displayName, 'Echo');
    assert.equal(rustGoEnvelope.members[0].lastSeenAt, '2026-06-17T18:17:49.000Z');
    assert.equal(rustGoEnvelope.members[0].lastOnlineAt, '2026-06-17T18:17:49.000Z');
    assert.equal(rustGoEnvelope.members[0].lastOnlineAtSource, 'lastSeen');

    const rustGoChatEnvelope = normalizeRustplusRelayPayload({
      type: 'clan_chat',
      event: 'clanMessage',
      clientName: 'Desktop',
      server: { id: 'server-eu', name: 'EU Main' },
      message: {
        id: 'chat-from-rust-go',
        steamId: '76561198000000005',
        name: 'Echo',
        message: 'hello relay',
        timestamp: '2026-06-17T00:00:01.000Z'
      }
    }, { receivedAt: '2026-06-17T00:00:02.000Z' });
    assert.equal(rustGoChatEnvelope.type, 'clan_chat_message');
    assert.equal(rustGoChatEnvelope.message, 'hello relay');
    assert.equal(rustGoChatEnvelope.displayName, 'Echo');

    const rustGoInviteEnvelope = normalizeRustplusRelayPayload({
      type: 'clan_invite_record',
      event: 'clanInviteRecord',
      clientName: 'Desktop',
      server: { id: 'server-eu', name: 'EU Main' },
      invite: {
        id: 'invite-from-rust-go',
        inviterSteamId: '76561198999999001',
        inviterName: 'AN',
        inviteeSteamId: '76561199553917565',
        inviteeName: 'Elizabeth',
        createdAt: 946656000000,
        invitedAtIso: '2026-06-17T18:17:49.000Z',
        status: 'accepted',
        statusLabel: '已接受 / Accepted'
      }
    }, { receivedAt: '2026-06-17T18:17:50.000Z' });
    assert.equal(rustGoInviteEnvelope.type, 'clan_invite_record');
    assert.equal(rustGoInviteEnvelope.client.id, 'Desktop');
    assert.equal(rustGoInviteEnvelope.server.key, 'Desktop:server-eu');
    assert.equal(rustGoInviteEnvelope.steamId, '76561199553917565');
    assert.equal(rustGoInviteEnvelope.inviterName, 'AN');
    assert.equal(rustGoInviteEnvelope.sentAt, '2026-06-17T18:17:49.000Z');

    const rustGoMemberDeltaEnvelope = normalizeRustplusRelayPayload({
      type: 'relay_event',
      eventId: 'member-delta-wrapper',
      payload: {
        type: 'member_offline',
        clientId: 'Desktop',
        server: { id: 'server-eu', name: 'EU Main' },
        member: { steamId: '76561198000000005', displayName: 'Echo' },
        occurredAt: '2026-06-17T00:00:03.000Z'
      }
    }, { receivedAt: '2026-06-17T00:00:04.000Z' });
    assert.equal(rustGoMemberDeltaEnvelope.type, 'member_offline');
    assert.equal(rustGoMemberDeltaEnvelope.member.steamId, '76561198000000005');
    assert.equal(rustGoMemberDeltaEnvelope.member.online, false);
    assert.equal(rustGoMemberDeltaEnvelope.member.lastOfflineAt, '2026-06-17T00:00:03.000Z');

    const originalFetch = globalThis.fetch;
    const battlemetricsRequests = [];
    globalThis.fetch = async (url, options = {}) => {
      const urlText = String(url);
      if (urlText.startsWith('https://api.battlemetrics.com/')) {
        battlemetricsRequests.push({ url: urlText, options });
        assert.match(urlText, /players\/bm_relay_delta\/relationships\/sessions/);
        return new Response(JSON.stringify({
          data: [{
            type: 'session',
            id: 'session_delta_1',
            attributes: {
              start: '2026-06-17T00:06:00.000Z'
            }
          }],
          links: {}
        }), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      return originalFetch(url, options);
    };

    try {
      result = await request('/integrations/rustplus/relay', {
        method: 'POST',
        headers: { 'X-NB-Relay-Token': relayToken },
        body: {
          type: 'clan_snapshot',
          clientId: 'client-a',
          clientName: 'NB Main',
          server: { id: 'server-eu', name: 'EU Main' },
          capturedAt: '2026-06-17T00:01:00.000Z',
          members: [
            { steamId: '76561198000000001', displayName: 'Alpha', online: true },
            { steamId: '76561198000000002', displayName: 'Bravo', online: false, lastSeen: 1781720269 },
            { steamId: '76561198000000004', displayName: 'Delta', online: true, lastOnlineAt: '2026-06-17T00:07:00.000Z', onlineTimeMinutes: 12 }
          ],
          invites: [{ steamId: '76561198000000003', displayName: 'Charlie', invitedBy: 'Alpha' }]
        }
      });
      assert.equal(result.response.status, 200);
      assert.equal(result.payload.event.type, 'clan_snapshot');
      assert.equal(result.payload.relay, undefined);
      result = await request('/rustplus-relay?scope=all');
      assert.equal(result.response.status, 200);
      const relayStateAfterFallback = result.payload.relay;
      assert.equal(relayStateAfterFallback.members.length, 3);
      const postedSystemMember = relayStateAfterFallback.members.find((member) => member.steamId === '76561198000000001');
      assert.equal(postedSystemMember.lastOnlineAt, '2026-06-17T00:05:00.000Z');
      assert.equal(postedSystemMember.lastOnlineAtSource, 'battlemetrics');
      assert.equal(postedSystemMember.onlineTimeMinutes, 75);
      assert.equal(postedSystemMember.onlineSummary.serverPlayTimeMinutes, 75);
      assert.equal(postedSystemMember.serverOnline.onlineTimeMinutes, 75);
      const postedOfflineMember = relayStateAfterFallback.members.find((member) => member.steamId === '76561198000000002');
      assert.equal(postedOfflineMember.lastSeenAt, '2026-06-17T18:17:49.000Z');
      assert.equal(postedOfflineMember.lastOnlineAt, '');
      assert.equal(postedOfflineMember.lastOfflineAt, '');
      const postedFallbackMember = relayStateAfterFallback.members.find((member) => member.steamId === '76561198000000004');
      assert.equal(postedFallbackMember.lastOnlineAt, '2026-06-17T00:07:00.000Z');
      assert.equal(postedFallbackMember.onlineTimeMinutes, 12);
      assert.equal(battlemetricsRequests.length, 0);
      const deltaAfterFallback = relayStateAfterFallback.members.find((member) => member.steamId === '76561198000000004');
      assert.equal(deltaAfterFallback.lastOnlineAt, '2026-06-17T00:07:00.000Z');
      assert.equal(deltaAfterFallback.onlineTimeMinutes, 12);
      assert.notEqual(deltaAfterFallback.lastOnlineAtSource, 'battlemetrics');
    } finally {
      globalThis.fetch = originalFetch;
    }

    const { ws: relayWs, hello } = await openRelayWebSocket(relayToken);
    assert.equal(hello.type, 'hello');
    assert.equal(hello.ok, true);
    assert.equal(hello.protocolVersion, 1);
    assert.equal(hello.acceptedTypes.includes('member_offline'), true);
    let wsMessagePromise = readWsJson(relayWs);
    relayWs.send(JSON.stringify({ type: 'heartbeat' }));
    const pong = await wsMessagePromise;
    assert.equal(pong.type, 'pong');

    wsMessagePromise = readWsJson(relayWs);
    relayWs.send(JSON.stringify({
      type: 'member_offline',
      eventId: 'offline-alpha-1',
      clientId: 'client-a',
      clientName: 'NB Main',
      serverId: 'server-eu',
      serverName: 'EU Main',
      member: { steamId: '76561198000000001', displayName: 'Alpha' },
      occurredAt: '2026-06-17T00:02:30.000Z'
    }));
    let wsAck = await wsMessagePromise;
    assert.equal(wsAck.type, 'ack');
    assert.equal(wsAck.ok, true);
    assert.equal(wsAck.eventId, 'offline-alpha-1');
    assert.equal(wsAck.relayEvent.type, 'member_offline');
    assert.equal(wsAck.relayEvent.applied, true);
    store = await readStore();
    const alphaAfterOffline = store.rustplusRelay.servers
      .find((serverRecord) => serverRecord.key === 'client-a:server-eu')
      .snapshot.members.find((member) => member.steamId === '76561198000000001');
    assert.equal(alphaAfterOffline.online, false);
    assert.equal(alphaAfterOffline.lastOfflineAt, '2026-06-17T00:02:30.000Z');

    wsMessagePromise = readWsJson(relayWs);
    relayWs.send(JSON.stringify({
      type: 'relay_batch',
      batchId: 'batch-member-delta-1',
      events: [
        {
          type: 'relay_event',
          eventId: 'online-alpha-1',
          payload: {
            type: 'member_online',
            clientId: 'client-a',
            clientName: 'NB Main',
            serverId: 'server-eu',
            serverName: 'EU Main',
            member: { steamId: '76561198000000001', displayName: 'Alpha' },
            occurredAt: '2026-06-17T00:03:00.000Z'
          }
        }
      ]
    }));
    wsAck = await wsMessagePromise;
    assert.equal(wsAck.type, 'batch_ack');
    assert.equal(wsAck.ok, true);
    assert.equal(wsAck.batchId, 'batch-member-delta-1');
    assert.equal(wsAck.results[0].eventId, 'online-alpha-1');
    assert.equal(wsAck.results[0].relayEvent.type, 'member_online');
    store = await readStore();
    const alphaAfterOnline = store.rustplusRelay.servers
      .find((serverRecord) => serverRecord.key === 'client-a:server-eu')
      .snapshot.members.find((member) => member.steamId === '76561198000000001');
    assert.equal(alphaAfterOnline.online, true);
    assert.equal(alphaAfterOnline.lastOnlineAt, '2026-06-17T00:03:00.000Z');
    assert.equal(alphaAfterOnline.lastOfflineAt, '');

    const storeBeforeUnchangedMemberDelta = await readStore();
    const settingsLastReceivedBeforeUnchangedMemberDelta = storeBeforeUnchangedMemberDelta.settings.rustplusRelay.lastReceivedAt;
    const serverLastSeenBeforeUnchangedMemberDelta = storeBeforeUnchangedMemberDelta.rustplusRelay.servers
      .find((serverRecord) => serverRecord.key === 'client-a:server-eu')
      .lastSeenAt;
    await new Promise((resolve) => setTimeout(resolve, 1100));
    wsMessagePromise = readWsJson(relayWs);
    relayWs.send(JSON.stringify({
      type: 'relay_event',
      eventId: 'online-alpha-unchanged',
      payload: {
        type: 'member_online',
        clientId: 'client-a',
        clientName: 'NB Main',
        serverId: 'server-eu',
        serverName: 'EU Main',
        member: { steamId: '76561198000000001', displayName: 'Alpha' },
        occurredAt: '2026-06-17T00:04:30.000Z'
      }
    }));
    wsAck = await wsMessagePromise;
    assert.equal(wsAck.type, 'ack');
    assert.equal(wsAck.ok, true);
    assert.equal(wsAck.relayEvent.type, 'member_online');
    assert.equal(wsAck.relayEvent.skipped, true);
    assert.equal(wsAck.relayEvent.skipReason, 'unchanged_member_delta');
    store = await readStore();
    assert.equal(store.settings.rustplusRelay.lastReceivedAt, settingsLastReceivedBeforeUnchangedMemberDelta);
    const serverAfterUnchangedMemberDelta = store.rustplusRelay.servers
      .find((serverRecord) => serverRecord.key === 'client-a:server-eu');
    assert.equal(serverAfterUnchangedMemberDelta.lastSeenAt, serverLastSeenBeforeUnchangedMemberDelta);
    const alphaAfterUnchangedOnline = serverAfterUnchangedMemberDelta.snapshot.members
      .find((member) => member.steamId === '76561198000000001');
    assert.equal(alphaAfterUnchangedOnline.lastOnlineAt, '2026-06-17T00:03:00.000Z');

    result = await request('/integrations/rustplus/relay', {
      method: 'POST',
      headers: { Authorization: `Bearer ${relayToken}` },
      body: {
        type: 'clan_snapshot',
        clientId: 'client-a',
        clientName: 'NB Main',
        serverId: 'server-eu',
        serverName: 'EU Main',
        capturedAt: '2026-06-17T00:04:40.000Z',
        members: [
          { steamId: '76561198000000001', displayName: 'Alpha', online: false },
          { steamId: '76561198000000002', displayName: 'Bravo', online: false },
          { steamId: '76561198000000004', displayName: 'Delta', online: true }
        ],
        invites: []
      }
    });
    assert.equal(result.response.status, 200);
    assert.equal(result.payload.event.skipped, false);
    store = await readStore();
    const serverAfterReplacementSnapshot = store.rustplusRelay.servers
      .find((serverRecord) => serverRecord.key === 'client-a:server-eu');
    assert.equal(serverAfterReplacementSnapshot.snapshot.members.length, 3);
    assert.equal(serverAfterReplacementSnapshot.snapshot.members.find((member) => member.steamId === '76561198000000001').online, false);
    assert.equal(serverAfterReplacementSnapshot.snapshot.members.find((member) => member.steamId === '76561198000000004').online, true);

    result = await request('/integrations/rustplus/relay', {
      method: 'POST',
      headers: { Authorization: `Bearer ${relayToken}` },
      body: {
        type: 'clan_snapshot',
        clientId: 'client-b',
        clientName: 'NB Backup',
        serverId: 'server-us',
        serverName: 'US Main',
        members: [{ steamId: '76561198000000004', displayName: 'Delta', online: true }]
      }
    });
    assert.equal(result.response.status, 200);

    for (const index of [1, 2, 3]) {
      result = await request('/integrations/rustplus/relay', {
        method: 'POST',
        headers: { Authorization: `Bearer ${relayToken}` },
        body: {
          type: 'clan_chat_message',
          clientId: 'client-a',
          clientName: 'NB Main',
          serverId: 'server-eu',
          serverName: 'EU Main',
          messageId: `chat-${index}`,
          steamId: '76561198000000001',
          displayName: 'Alpha',
          message: `Hello ${index}`,
          translatedMessage: `Hola ${index}`,
          sentAt: `2026-06-17T00:0${index}:00.000Z`
        }
      });
      assert.equal(result.response.status, 200);
    }

    result = await request('/integrations/rustplus/relay', {
      method: 'POST',
      headers: { Authorization: `Bearer ${relayToken}` },
      body: {
        type: 'clan_invite_record',
        clientId: 'client-a',
        clientName: 'NB Main',
        serverId: 'server-eu',
        serverName: 'EU Main',
        invite: {
          id: 'invite-pending',
          inviterSteamId: '76561198999999001',
          inviterName: 'AN',
          inviteeSteamId: '76561199553917565',
          inviteeName: 'Elizabeth',
          invitedAt: '2026-06-17T18:17:49.000Z',
          status: 'pending'
        }
      }
    });
    assert.equal(result.response.status, 200);
    assert.equal(result.payload.event.type, 'clan_invite_record');
    assert.equal(result.payload.event.inserted, true);
    result = await request('/rustplus-relay?scope=all');
    assert.equal(result.response.status, 200);
    assert.equal(result.payload.relay.inviteRecords.length, 1);

    result = await request('/integrations/rustplus/relay', {
      method: 'POST',
      headers: { Authorization: `Bearer ${relayToken}` },
      body: {
        type: 'clan_invite_record',
        clientId: 'client-a',
        clientName: 'NB Main',
        serverId: 'server-eu',
        serverName: 'EU Main',
        invite: {
          id: 'invite-duplicate-time',
          inviterSteamId: '76561198999999001',
          inviterName: 'AN',
          inviteeSteamId: '76561199553917565',
          inviteeName: 'Elizabeth',
          invitedAt: '2026-06-17T18:17:49.000Z',
          acceptedAt: '2026-06-17T18:18:00.000Z',
          status: 'accepted'
        }
      }
    });
    assert.equal(result.response.status, 200);
    assert.equal(result.payload.event.inserted, false);
    result = await request('/rustplus-relay?scope=all');
    assert.equal(result.response.status, 200);
    assert.equal(result.payload.relay.inviteRecords.length, 1);
    assert.equal(result.payload.relay.inviteRecords[0].status, 'accepted');

    store = await readStore();
    assert.equal(store.rustplusRelay.clients.length, 2);
    assert.equal(store.rustplusRelay.servers.length, 2);
    assert.equal(store.rustplusRelay.chatMessages.length, 2);
    assert.equal(store.rustplusRelay.inviteRecords.length, 1);
    assert.equal(store.rustplusRelay.chatMessages.some((message) => message.message === 'Hello 1'), false);
    assert.equal(store.rustplusRelay.chatMessages.some((message) => message.translatedMessage === 'Hola 3'), true);
    assert.equal(rustplusRelaySettingsPayload(store).chatStorageLimitLabel, '5 GB');
    assert.equal(rustplusRelaySettingsPayload(store).inviteRecordCount, 1);

    const mergedRelay = publicRustplusRelayState(store);
    assert.equal(mergedRelay.selected.clientId, '');
    assert.equal(mergedRelay.selected.serverKey, '');
    assert.equal(mergedRelay.members.length, 3);
    assert.equal(mergedRelay.summary.memberCount, 3);
    assert.equal(mergedRelay.summary.chatCount, 2);
    assert.equal(mergedRelay.summary.inviteRecordCount, 1);
    assert.equal(mergedRelay.inviteRecords[0].inviteeName, 'Elizabeth');
    assert.equal(mergedRelay.inviteRecords[0].sentAt, '2026-06-17T18:17:49.000Z');
    const offlineRelayMember = mergedRelay.members.find((member) => member.steamId === '76561198000000002');
    assert.equal(offlineRelayMember.lastSeenAt, '');
    assert.equal(offlineRelayMember.lastOnlineAt, '');
    assert.equal(offlineRelayMember.lastOfflineAt, '');
    const matchedSystemMember = mergedRelay.members.find((member) => member.steamId === '76561198000000001');
    assert.equal(matchedSystemMember.memberId, 'member_system_alpha');
    assert.equal(matchedSystemMember.displayName, 'System Alpha');
    assert.equal(matchedSystemMember.customName, 'System Alpha');
    assert.equal(matchedSystemMember.steamNickname, 'AlphaSteam');
    assert.equal(matchedSystemMember.avatar, 'https://avatars.test/system-alpha.jpg');
    assert.equal(mergedRelay.members.some((member) => member.displayName === 'Delta'), true);
    assert.equal(mergedRelay.clan.count >= 1, true);

    const pagedStore = {
      settings: { rustplusRelay: store.settings.rustplusRelay },
      rustplusRelay: {
        clients: [{ id: 'client-a', name: 'NB Main', createdAt: '', lastSeenAt: '' }],
        servers: [{ key: 'client-a:server-eu', serverId: 'server-eu', name: 'EU Main', clientId: 'client-a', clientName: 'NB Main', snapshot: null }],
        chatMessages: Array.from({ length: 350 }, (_, index) => ({
          id: `paged-${index}`,
          clientId: 'client-a',
          clientName: 'NB Main',
          serverKey: 'client-a:server-eu',
          serverId: 'server-eu',
          serverName: 'EU Main',
          displayName: 'Alpha',
          message: `Paged ${index}`,
          sentAt: new Date(Date.UTC(2026, 5, 17, 0, 0, index)).toISOString(),
          receivedAt: new Date(Date.UTC(2026, 5, 17, 0, 0, index)).toISOString()
        }))
      }
    };
    const firstChatPage = publicRustplusRelayState(pagedStore, { clientId: 'client-a', serverKey: 'client-a:server-eu' });
    assert.equal(firstChatPage.chatMessages.length, 200);
    assert.equal(firstChatPage.chatPage.total, 350);
    assert.equal(firstChatPage.chatPage.hasMore, true);
    assert.equal(firstChatPage.chatPage.nextOffset, 200);
    const secondChatPage = publicRustplusRelayState(pagedStore, { clientId: 'client-a', serverKey: 'client-a:server-eu', chatOffset: 200, chatLimit: 100 });
    assert.equal(secondChatPage.chatMessages.length, 100);
    assert.equal(secondChatPage.chatPage.nextOffset, 300);
    assert.equal(secondChatPage.chatPage.hasMore, true);

    result = await request('/rustplus-relay?clientId=client-a&serverKey=client-a%3Aserver-eu');
    assert.equal(result.response.status, 200);
    assert.equal(result.payload.relay.selected.serverKey, 'client-a:server-eu');
    assert.equal(result.payload.relay.summary.memberCount, 3);
    assert.equal(result.payload.relay.chatMessages.length, 2);
    assert.equal(result.payload.relay.inviteRecords.length, 1);
    const matchedSystemChat = result.payload.relay.chatMessages.find((message) => message.steamId === '76561198000000001');
    assert.equal(matchedSystemChat.memberId, 'member_system_alpha');
    assert.equal(matchedSystemChat.displayName, 'System Alpha');
    assert.equal(matchedSystemChat.customName, 'System Alpha');
    assert.equal(matchedSystemChat.steamNickname, 'AlphaSteam');
    assert.equal(matchedSystemChat.avatar, 'https://avatars.test/system-alpha.jpg');

    result = await request('/rustplus-relay/summary?clientId=client-a&serverKey=client-a%3Aserver-eu');
    assert.equal(result.response.status, 200);
    assert.equal(result.payload.relay.selected.serverKey, 'client-a:server-eu');
    assert.equal(result.payload.relay.summary.memberCount, 3);
    assert.equal(Object.hasOwn(result.payload.relay, 'members'), false);
    assert.equal(Object.hasOwn(result.payload.relay, 'chatMessages'), false);
    assert.equal(Object.hasOwn(result.payload.relay, 'inviteRecords'), false);

    result = await request('/rustplus-relay/members?clientId=client-a&serverKey=client-a%3Aserver-eu&chatLimit=0');
    assert.equal(result.response.status, 200);
    assert.equal(result.payload.relay.members.length, 3);
    assert.equal(Object.hasOwn(result.payload.relay, 'chatMessages'), false);

    result = await request('/rustplus-relay/chats?clientId=client-a&serverKey=client-a%3Aserver-eu&chatLimit=1');
    assert.equal(result.response.status, 200);
    assert.equal(result.payload.relay.chatMessages.length, 1);
    assert.equal(result.payload.relay.chatPage.total, 2);
    assert.equal(Object.hasOwn(result.payload.relay, 'members'), false);

    result = await request('/rustplus-relay/invites?clientId=client-a&serverKey=client-a%3Aserver-eu&includeInviteRecords=1');
    assert.equal(result.response.status, 200);
    assert.equal(result.payload.relay.inviteRecords.length, 1);
    assert.equal(result.payload.relay.inviteRecordsIncluded, true);
    assert.equal(Object.hasOwn(result.payload.relay, 'chatMessages'), false);

    cookie = '';
    result = await request('/auth/login', { method: 'POST', body: { username: 'clan_info_reader', password: 'InfoPass123!' } });
    assert.equal(result.response.status, 200);
    assert.equal(result.payload.user.permissions.rustClanInfo.view, true);
    assert.equal(result.payload.user.permissions.rustClanChat.view, false);
    result = await request('/rustplus-relay?scope=info&clientId=client-a&serverKey=client-a%3Aserver-eu');
    assert.equal(result.response.status, 200);
    assert.equal(result.payload.relay.summary.memberCount, 3);
    assert.equal(result.payload.relay.members.length, 3);
    const scopedSystemMember = result.payload.relay.members.find((member) => member.steamId === '76561198000000001');
    assert.equal(scopedSystemMember.memberId, 'member_system_alpha');
    assert.equal(scopedSystemMember.displayName, 'System Alpha');
    assert.equal(scopedSystemMember.steamNickname, 'AlphaSteam');
    assert.equal(scopedSystemMember.avatar, 'https://avatars.test/system-alpha.jpg');
    assert.equal(scopedSystemMember.onlineTimeMinutes, 75);
    assert.equal(scopedSystemMember.serverOnline.onlineTimeMinutes, 75);
    assert.equal(result.payload.relay.chatMessages.length, 0);
    assert.equal(result.payload.relay.chatPage.total, 0);
    assert.equal(result.payload.relay.inviteRecords.length, 1);
    assert.equal(result.payload.relay.discordTargets.length, 0);
    assert.equal(result.payload.relay.settings.discordForwarding.enabled, false);
    result = await request('/rustplus-relay?scope=chat&clientId=client-a&serverKey=client-a%3Aserver-eu');
    assert.equal(result.response.status, 403);

    cookie = '';
    result = await request('/auth/login', { method: 'POST', body: { username: 'clan_chat_reader', password: 'ChatPass123!' } });
    assert.equal(result.response.status, 200);
    assert.equal(result.payload.user.permissions.rustClanInfo.view, false);
    assert.equal(result.payload.user.permissions.rustClanChat.view, true);
    result = await request('/rustplus-relay?scope=chat&clientId=client-a&serverKey=client-a%3Aserver-eu');
    assert.equal(result.response.status, 200);
    assert.equal(result.payload.relay.summary.memberCount, 0);
    assert.equal(result.payload.relay.members.length, 0);
    assert.equal(result.payload.relay.server.members.length, 0);
    assert.equal(result.payload.relay.invites.length, 0);
    assert.equal(result.payload.relay.inviteRecords.length, 0);
    assert.equal(result.payload.relay.chatMessages.length, 2);
    const scopedSystemChat = result.payload.relay.chatMessages.find((message) => message.steamId === '76561198000000001');
    assert.equal(scopedSystemChat.memberId, 'member_system_alpha');
    assert.equal(scopedSystemChat.displayName, 'System Alpha');
    assert.equal(scopedSystemChat.steamNickname, 'AlphaSteam');
    assert.equal(scopedSystemChat.avatar, 'https://avatars.test/system-alpha.jpg');
    assert.equal(result.payload.relay.discordTargets.length, 0);
    result = await request('/settings/rustplus-relay/discord-forwarding', {
      method: 'PUT',
      body: { enabled: false, routes: [] }
    });
    assert.equal(result.response.status, 403);
    result = await request('/rustplus-relay?scope=info&clientId=client-a&serverKey=client-a%3Aserver-eu');
    assert.equal(result.response.status, 403);

    cookie = rootCookie;

    const sseController = new AbortController();
    const sseResponse = await fetch(`${baseUrl}/rustplus-relay/events`, {
      headers: { Cookie: rootCookie },
      signal: sseController.signal
    });
    assert.equal(sseResponse.status, 200);
    assert.match(sseResponse.headers.get('content-type') || '', /text\/event-stream/);
    const reader = sseResponse.body.getReader();
    let sseText = '';
    for (let index = 0; index < 4 && !sseText.includes('event: relay_state'); index += 1) {
      const chunk = await reader.read();
      sseText += new TextDecoder().decode(chunk.value || new Uint8Array());
    }
    await reader.cancel().catch(() => {});
    sseController.abort();
    assert.match(sseText, /event: relay_state/);

    result = await request('/rustplus-relay/discord', {
      method: 'POST',
      body: { clientId: 'client-a', serverKey: 'client-a:server-eu' }
    });
    assert.equal(result.response.status, 200);
    assert.equal(result.payload.message.id, 'discord_message_1');
    assert.equal(discordRequests.length, 1);
    assert.equal(discordRequests[0].channelId, '222222222222222222');
    assert.match(discordRequests[0].authorization, /^Bot discord_bot_token_/);
    const discordDescription = discordRequests[0].body.embeds[0].description;
    assert.match(discordDescription, /Hola 3/);
    assert.doesNotMatch(discordDescription, /Hello 3/);

    result = await request('/settings/rustplus-relay/discord-forwarding', {
      method: 'PUT',
      body: {
        enabled: true,
        routes: [
          {
            id: 'discord_forward_1',
            enabled: true,
            targetName: 'Target 1',
            guildId: '111111111111111111',
            channelId: '222222222222222222'
          },
          {
            id: 'discord_forward_2',
            enabled: true,
            targetName: 'Target 2',
            guildId: '333333333333333333',
            channelId: '444444444444444444'
          }
        ]
      }
    });
    assert.equal(result.response.status, 200);
    assert.equal(result.payload.rustplusRelay.discordForwarding.enabled, true);
    assert.equal(result.payload.rustplusRelay.discordForwarding.routes.length, 2);
    assert.equal(result.payload.rustplusRelay.discordForwarding.serverKey, '');
    assert.equal(result.payload.rustplusRelay.discordForwarding.channelId, '222222222222222222');

    result = await request('/integrations/rustplus/relay', {
      method: 'POST',
      headers: { Authorization: `Bearer ${relayToken}` },
      body: {
        type: 'clan_chat_message',
        clientId: 'client-a',
        clientName: 'NB Main',
        serverId: 'server-eu',
        serverName: 'EU Main',
        messageId: 'chat-4',
        steamId: '76561198000000001',
        displayName: 'Alpha',
        message: 'Hello 4',
        translatedMessage: 'Hola 4',
        sentAt: '2026-06-17T00:04:00.000Z'
      }
    });
    assert.equal(result.response.status, 200);
    assert.equal(result.payload.event.inserted, true);
    const chat4MessageId = result.payload.event.chatMessageId;
    await waitFor(() => discordRequests.length === 3);
    assert.equal(discordRequests[1].channelId, '222222222222222222');
    assert.equal(discordRequests[1].body.content, '<t:1781654640:F>\nAlpha：Hola 4\n--------------------');
    assert.equal(discordRequests[1].body.embeds, undefined);
    assert.equal(discordRequests[2].channelId, '444444444444444444');
    assert.equal(discordRequests[2].body.content, '<t:1781654640:F>\nAlpha：Hola 4\n--------------------');
    assert.equal(discordRequests[2].body.embeds, undefined);
    assert.equal(discordAttempts.filter((item) => item.channelId === '444444444444444444').length, 2);
    await waitForAsync(async () => {
      const currentStore = await readStore();
      return rustplusForwardRuns(currentStore, chat4MessageId, 'discord').filter((run) => run.status === 'succeeded').length === 2 &&
        rustplusForwardRefs(currentStore, chat4MessageId, 'discord').length === 2;
    });
    store = await readStore();
    const chat4ForwardRuns = rustplusForwardRuns(store, chat4MessageId, 'discord');
    assert.equal(chat4ForwardRuns.length, 2);
    assert.deepEqual(chat4ForwardRuns.map((run) => run.channelId).sort(), ['222222222222222222', '444444444444444444']);
    assert.deepEqual(chat4ForwardRuns.map((run) => run.messageId).sort(), ['discord_message_2', 'discord_message_3']);
    assert.equal(chat4ForwardRuns.every((run) => run.metadata.externalActionSucceeded === 'true'), true);
    assert.equal(chat4ForwardRuns.every((run) => run.metadata.messageRefPersisted === 'true'), true);
    const chat4ForwardRefs = rustplusForwardRefs(store, chat4MessageId, 'discord');
    assert.deepEqual(chat4ForwardRefs.map((ref) => ref.channelId).sort(), ['222222222222222222', '444444444444444444']);
    assert.deepEqual(chat4ForwardRefs.map((ref) => ref.messageId).sort(), ['discord_message_2', 'discord_message_3']);

    result = await request('/integrations/rustplus/relay', {
      method: 'POST',
      headers: { Authorization: `Bearer ${relayToken}` },
      body: {
        type: 'clan_chat_message',
        clientId: 'client-a',
        clientName: 'NB Main',
        serverId: 'server-eu',
        serverName: 'EU Main',
        messageId: 'chat-4',
        steamId: '76561198000000001',
        displayName: 'Alpha',
        message: 'Hello 4',
        translatedMessage: 'Hola 4',
        sentAt: '2026-06-17T00:04:00.000Z'
      }
    });
    assert.equal(result.response.status, 200);
    assert.equal(result.payload.event.inserted, false);
    await new Promise((resolve) => setTimeout(resolve, 60));
    assert.equal(discordRequests.length, 3);

    store = await readStore();
    assert.equal(store.settings.rustplusRelay.discordForwarding.lastForwardError, '');
    assert.equal(store.settings.rustplusRelay.discordForwarding.lastForwardMessageId, '');
    assert.equal(rustplusForwardRuns(store, chat4MessageId, 'discord').length, 2);
    assert.equal(rustplusForwardRefs(store, chat4MessageId, 'discord').length, 2);

    result = await request('/integrations/rustplus/relay', {
      method: 'POST',
      headers: { Authorization: `Bearer ${relayToken}` },
      body: {
        type: 'clan_chat_message',
        clientId: 'client-b',
        clientName: 'NB Backup',
        serverId: 'server-us',
        serverName: 'US Main',
        messageId: 'chat-us-1',
        steamId: '76561198000000004',
        displayName: 'Delta',
        message: 'US hello',
        translatedMessage: 'US hola',
        sentAt: '2026-06-17T00:05:00.000Z'
      }
    });
    assert.equal(result.response.status, 200);
    assert.equal(result.payload.event.inserted, true);
    await waitFor(() => discordRequests.length === 5);
    assert.equal(discordRequests[3].channelId, '222222222222222222');
    assert.equal(discordRequests[3].body.content, '<t:1781654700:F>\nDelta：US hola\n--------------------');
    assert.equal(discordRequests[4].channelId, '444444444444444444');
    assert.equal(discordRequests[4].body.content, '<t:1781654700:F>\nDelta：US hola\n--------------------');

    wsMessagePromise = readWsJson(relayWs);
    relayWs.send(JSON.stringify({
      type: 'relay_event',
      eventId: 'ws-chat-1',
      payload: {
        type: 'clan_chat_message',
        clientId: 'client-a',
        clientName: 'NB Main',
        serverId: 'server-eu',
        serverName: 'EU Main',
        messageId: 'chat-ws-1',
        steamId: '76561198000000001',
        displayName: 'Alpha',
        message: 'Hello WS',
        translatedMessage: 'Hola WS',
        sentAt: '2026-06-17T00:06:00.000Z'
      }
    }));
    wsAck = await wsMessagePromise;
    assert.equal(wsAck.type, 'ack');
    assert.equal(wsAck.ok, true);
    assert.equal(wsAck.eventId, 'ws-chat-1');
    assert.equal(wsAck.relayEvent.type, 'clan_chat_message');
    assert.equal(wsAck.relayEvent.inserted, true);
    await waitFor(() => discordRequests.length === 7);
    assert.equal(discordRequests[5].channelId, '222222222222222222');
    assert.equal(discordRequests[5].body.content, '<t:1781654760:F>\nAlpha：Hola WS\n--------------------');
    assert.equal(discordRequests[6].channelId, '444444444444444444');
    assert.equal(discordRequests[6].body.content, '<t:1781654760:F>\nAlpha：Hola WS\n--------------------');

    result = await request('/integrations/rustplus/relay', {
      method: 'POST',
      headers: { Authorization: `Bearer ${relayToken}` },
      body: {
        type: 'clan_chat_message',
        clientId: 'client-a',
        clientName: 'NB Main',
        serverId: 'server-eu',
        serverName: 'EU Main',
        messageId: 'chat-person-mention-1',
        steamId: '76561198000000001',
        displayName: 'Alpha',
        message: 'Hello @Kristian123 - kris132 @everyone',
        translatedMessage: 'Hola @Kristian123 - kris132 @everyone',
        sentAt: '2026-06-17T00:07:00.000Z'
      }
    });
    assert.equal(result.response.status, 200);
    assert.equal(result.payload.event.inserted, true);
    await waitFor(() => discordRequests.length === 9);
    assert.equal(discordRequests[7].body.content, '<t:1781654820:F>\nAlpha：Hola <@555555555555555555> ＠everyone\n--------------------');
    assert.deepEqual(discordRequests[7].body.allowed_mentions, { parse: [], users: ['555555555555555555'] });
    assert.equal(discordRequests[8].body.content, '<t:1781654820:F>\nAlpha：Hola <@555555555555555555> ＠everyone\n--------------------');
    assert.deepEqual(discordRequests[8].body.allowed_mentions, { parse: [], users: ['555555555555555555'] });

    result = await request('/integrations/rustplus/relay', {
      method: 'POST',
      headers: { Authorization: `Bearer ${relayToken}` },
      body: {
        type: 'clan_chat_message',
        clientId: 'client-a',
        clientName: 'NB Main',
        serverId: 'server-eu',
        serverName: 'EU Main',
        messageId: 'chat-spaced-name-mention-1',
        steamId: '76561198000000001',
        displayName: 'Alpha',
        message: '@sobad and @So bad',
        translatedMessage: '@sobad and @So bad',
        sentAt: '2026-06-17T00:07:30.000Z'
      }
    });
    assert.equal(result.response.status, 200);
    assert.equal(result.payload.event.inserted, true);
    await waitFor(() => discordRequests.length === 11);
    assert.equal(discordRequests[9].body.content, '<t:1781654850:F>\nAlpha：<@777777777777777777> and <@777777777777777777>\n--------------------');
    assert.deepEqual(discordRequests[9].body.allowed_mentions, { parse: [], users: ['777777777777777777'] });
    assert.equal(discordRequests[10].body.content, '<t:1781654850:F>\nAlpha：<@777777777777777777> and <@777777777777777777>\n--------------------');
    assert.deepEqual(discordRequests[10].body.allowed_mentions, { parse: [], users: ['777777777777777777'] });

    result = await request('/integrations/rustplus/relay', {
      method: 'POST',
      headers: { Authorization: `Bearer ${relayToken}` },
      body: {
        type: 'clan_chat_message',
        clientId: 'client-b',
        clientName: 'NB Backup',
        serverId: 'server-us',
        serverName: 'US Main',
        messageId: 'chat-manager-everyone-1',
        steamId: '76561198000000004',
        displayName: 'Delta',
        message: '@everyone check @AlphaDiscord',
        translatedMessage: '@everyone check @AlphaDiscord',
        sentAt: '2026-06-17T00:08:00.000Z'
      }
    });
    assert.equal(result.response.status, 200);
    assert.equal(result.payload.event.inserted, true);
    await waitFor(() => discordRequests.length === 13);
    assert.equal(discordRequests[11].body.content, '<t:1781654880:F>\nDelta：@everyone check <@666666666666666666>\n--------------------');
    assert.deepEqual(discordRequests[11].body.allowed_mentions, { parse: ['everyone'], users: ['666666666666666666'] });
    assert.equal(discordRequests[12].body.content, '<t:1781654880:F>\nDelta：@everyone check <@666666666666666666>\n--------------------');
    assert.deepEqual(discordRequests[12].body.allowed_mentions, { parse: ['everyone'], users: ['666666666666666666'] });

    result = await request('/settings/rustplus-relay/discord-forwarding', {
      method: 'PUT',
      body: {
        enabled: true,
        routes: [
          {
            id: 'kook_forward_1',
            enabled: true,
            platform: 'kook',
            targetName: 'KOOK GameChat',
            kookAccessToken: 'kook_pipe_access_token_123456',
            kookChannelId: '6956640645000001',
            kookTemplateId: 'tpl_game_chat'
          }
        ]
      }
    });
    assert.equal(result.response.status, 200);
    assert.equal(result.payload.rustplusRelay.discordForwarding.routes.length, 1);
    assert.equal(result.payload.rustplusRelay.discordForwarding.routes[0].platform, 'kook');
    assert.equal(result.payload.rustplusRelay.discordForwarding.routes[0].kookAccessToken, '');
    assert.equal(result.payload.rustplusRelay.discordForwarding.routes[0].kookAccessTokenConfigured, true);
    store = await readStore();
    assert.equal(store.settings.rustplusRelay.discordForwarding.routes[0].kookAccessToken, 'kook_pipe_access_token_123456');

    result = await request('/settings/rustplus-relay/discord-forwarding', {
      method: 'PUT',
      body: {
        enabled: true,
        routes: [
          {
            id: 'kook_forward_1',
            enabled: true,
            platform: 'kook',
            targetName: 'KOOK GameChat',
            kookAccessTokenConfigured: true,
            kookChannelId: '6956640645000001',
            kookTemplateId: 'tpl_game_chat_updated'
          }
        ]
      }
    });
    assert.equal(result.response.status, 200);
    store = await readStore();
    assert.equal(store.settings.rustplusRelay.discordForwarding.routes[0].kookAccessToken, 'kook_pipe_access_token_123456');
    assert.equal(store.settings.rustplusRelay.discordForwarding.routes[0].kookTemplateId, 'tpl_game_chat_updated');

    result = await request('/integrations/rustplus/relay', {
      method: 'POST',
      headers: { Authorization: `Bearer ${relayToken}` },
      body: {
        type: 'clan_chat_message',
        clientId: 'client-a',
        clientName: 'NB Main',
        serverId: 'server-eu',
        serverName: 'EU Main',
        messageId: 'chat-kook-1',
        steamId: '76561198000000001',
        displayName: 'Alpha',
        message: 'Hello KOOK',
        translatedMessage: '你好 KOOK',
        sentAt: '2026-06-17T00:09:00.000Z'
      }
    });
    assert.equal(result.response.status, 200);
    assert.equal(result.payload.event.inserted, true);
    const kookChatMessageId = result.payload.event.chatMessageId;
    await waitFor(() => kookPipeRequests.length === 1);
    assert.equal(kookPipeRequests[0].query.access_token, 'kook_pipe_access_token_123456');
    assert.equal(kookPipeRequests[0].query.target_id, '6956640645000001');
    assert.equal(kookPipeRequests[0].query.template_id, 'tpl_game_chat_updated');
    assert.equal(kookPipeRequests[0].body.player, 'Alpha');
    assert.equal(kookPipeRequests[0].body.steamId, '76561198000000001');
    assert.equal(kookPipeRequests[0].body.message, '你好 KOOK');
    assert.equal(kookPipeRequests[0].body.server, 'EU Main');
    await waitForAsync(async () => {
      const currentStore = await readStore();
      return rustplusForwardRuns(currentStore, kookChatMessageId, 'kook').some((run) => (
        run.status === 'succeeded' &&
          run.channelId === '6956640645000001' &&
          run.messageId === 'kook_pipe_1'
      )) &&
        rustplusForwardRefs(currentStore, kookChatMessageId, 'kook').some((ref) => (
          ref.channelId === '6956640645000001' &&
            ref.messageId === 'kook_pipe_1'
        ));
    });
    store = await readStore();
    const kookForwardRuns = rustplusForwardRuns(store, kookChatMessageId, 'kook');
    assert.equal(kookForwardRuns.length, 1);
    assert.equal(kookForwardRuns[0].metadata.externalActionSucceeded, 'true');
    assert.equal(kookForwardRuns[0].metadata.messageRefPersisted, 'true');
    const kookForwardRefs = rustplusForwardRefs(store, kookChatMessageId, 'kook');
    assert.equal(kookForwardRefs.length, 1);
    assert.equal(kookForwardRefs[0].messageId, 'kook_pipe_1');
    assert.equal((store.operationRuns || []).some((run) => (
      run.type === 'kook_pipe_push' &&
        run.platform === 'kook' &&
        run.status === 'succeeded' &&
        run.messageId === 'kook_pipe_1'
    )), true);

    result = await request('/integrations/rustplus/relay', {
      method: 'POST',
      headers: { Authorization: `Bearer ${relayToken}` },
      body: {
        type: 'clan_chat_message',
        clientId: 'client-a',
        clientName: 'NB Main',
        serverId: 'server-eu',
        serverName: 'EU Main',
        messageId: 'chat-kook-1',
        steamId: '76561198000000001',
        displayName: 'Alpha',
        message: 'Hello KOOK',
        translatedMessage: '你好 KOOK',
        sentAt: '2026-06-17T00:09:00.000Z'
      }
    });
    assert.equal(result.response.status, 200);
    assert.equal(result.payload.event.skipped, true);
    assert.equal(result.payload.event.inserted, false);
    assert.equal(result.payload.event.skipReason, 'duplicate_chat_message');
    assert.equal(kookPipeRequests.length, 1);
    store = await readStore();
    assert.equal(rustplusForwardRuns(store, kookChatMessageId, 'kook').length, 1);
    assert.equal(rustplusForwardRefs(store, kookChatMessageId, 'kook').length, 1);

    const repeatedSnapshotPayload = {
      type: 'clan_snapshot',
      clientId: 'client-perf',
      clientName: 'NB Perf',
      serverId: 'server-perf',
      serverName: 'Perf Main',
      members: [
        { steamId: '76561198000009991', displayName: 'Perf Alpha', online: true },
        { steamId: '76561198000009992', displayName: 'Perf Bravo', online: false }
      ],
      invites: []
    };
    result = await request('/integrations/rustplus/relay', {
      method: 'POST',
      headers: { Authorization: `Bearer ${relayToken}` },
      body: repeatedSnapshotPayload
    });
    assert.equal(result.response.status, 200);
    assert.equal(result.payload.event.skipped, false);
    result = await request('/integrations/rustplus/relay', {
      method: 'POST',
      headers: { Authorization: `Bearer ${relayToken}` },
      body: {
        ...repeatedSnapshotPayload,
        capturedAt: '2026-06-17T00:09:10.000Z'
      }
    });
    assert.equal(result.response.status, 200);
    assert.equal(result.payload.event.skipped, true);
    assert.equal(result.payload.event.skipReason, 'unchanged_snapshot');
    assert.equal(result.payload.event.touched, undefined);

    result = await request('/integrations/rustplus/relay', {
      method: 'POST',
      headers: { Authorization: `Bearer ${relayToken}` },
      body: {
        ...repeatedSnapshotPayload,
        capturedAt: '2026-06-17T00:09:20.000Z',
        members: [
          { steamId: '76561198000009991', displayName: 'Perf Alpha', online: false },
          { steamId: '76561198000009992', displayName: 'Perf Bravo', online: false }
        ]
      }
    });
    assert.equal(result.response.status, 200);
    assert.equal(result.payload.event.skipped, false);

    const concurrentSnapshotPayload = {
      type: 'clan_snapshot',
      clientId: 'client-concurrent',
      clientName: 'NB Concurrent',
      serverId: 'server-concurrent',
      serverName: 'Concurrent Main',
      capturedAt: '2026-06-17T00:09:25.000Z',
      members: [{ steamId: '76561198000008881', displayName: 'Concurrent Alpha', online: true }],
      invites: []
    };
    const concurrentSnapshots = await Promise.all([
      request('/integrations/rustplus/relay', {
        method: 'POST',
        headers: { Authorization: `Bearer ${relayToken}` },
        body: concurrentSnapshotPayload
      }),
      request('/integrations/rustplus/relay', {
        method: 'POST',
        headers: { Authorization: `Bearer ${relayToken}` },
        body: concurrentSnapshotPayload
      })
    ]);
    assert.deepEqual(
      concurrentSnapshots.map((item) => item.payload.event.skipped).sort(),
      [false, true]
    );
    assert.equal(
      concurrentSnapshots.find((item) => item.payload.event.skipped)?.payload.event.skipReason,
      'unchanged_snapshot'
    );

    result = await request('/integrations/rustplus/relay', {
      method: 'POST',
      headers: { Authorization: `Bearer ${relayToken}` },
      body: {
        type: 'clan_chat_message',
        clientId: 'client-perf',
        clientName: 'NB Perf',
        serverId: 'server-perf',
        serverName: 'Perf Main',
        messageId: 'oversized-chat',
        steamId: '76561198000009991',
        displayName: 'Perf Alpha',
        message: 'x'.repeat(300_000),
        sentAt: '2026-06-17T00:09:30.000Z'
      }
    });
    assert.equal(result.response.status, 413);
    assert.match(result.payload.error, /payload exceeds|entity too large/i);

    const noTimeInvitePayload = {
      type: 'clan_invite_record',
      clientId: 'client-perf',
      clientName: 'NB Perf',
      serverId: 'server-perf',
      serverName: 'Perf Main',
      invite: {
        inviterSteamId: '76561198000009991',
        inviterName: 'Perf Alpha',
        inviteeSteamId: '76561198000009993',
        inviteeName: 'Perf Charlie',
        status: 'pending'
      }
    };
    result = await request('/integrations/rustplus/relay', {
      method: 'POST',
      headers: { Authorization: `Bearer ${relayToken}` },
      body: noTimeInvitePayload
    });
    assert.equal(result.response.status, 200);
    assert.equal(result.payload.event.inserted, true);
    result = await request('/integrations/rustplus/relay', {
      method: 'POST',
      headers: { Authorization: `Bearer ${relayToken}` },
      body: noTimeInvitePayload
    });
    assert.equal(result.response.status, 200);
    assert.equal(result.payload.event.skipped, true);
    assert.equal(result.payload.event.inserted, false);
    assert.equal(result.payload.event.skipReason, 'duplicate_invite_record');

    result = await request('/rustplus-relay/chats', { method: 'DELETE' });
    assert.equal(result.response.status, 200);
    assert.equal(result.payload.relay.chatMessages.length, 0);
    assert.equal(result.payload.relay.chatPage.total, 0);
    store = await readStore();
    assert.equal(store.rustplusRelay.chatMessages.length, 0);

    result = await request('/rustplus-relay', { method: 'DELETE' });
    assert.equal(result.response.status, 200);
    assert.equal(result.payload.relay.clients.length, 0);
    assert.equal(result.payload.relay.servers.length, 0);
    assert.equal(result.payload.relay.members.length, 0);
    assert.equal(result.payload.relay.summary.memberCount, 0);
    store = await readStore();
    assert.equal(store.rustplusRelay.clients.length, 0);
    assert.equal(store.rustplusRelay.servers.length, 0);
    assert.equal(store.rustplusRelay.chatMessages.length, 0);
    assert.equal(store.rustplusRelay.inviteRecords.length, 0);
    assert.equal(store.settings.rustplusRelay.tokenHash.startsWith('scrypt$'), true);

    result = await request('/settings/rustplus-relay', { method: 'DELETE' });
    assert.equal(result.response.status, 200);
    assert.equal(result.payload.rustplusRelay.enabled, false);
    assert.equal(result.payload.rustplusRelay.tokenUpdatedAt, '');
    store = await readStore();
    assert.equal(store.settings.rustplusRelay.tokenHash, '');
    assert.equal(store.settings.rustplusRelay.tokenUpdatedAt, '');

    cookie = '';
    result = await request('/auth/login', { method: 'POST', body: { username: 'relay_viewer', password: 'ViewerPass123!' } });
    assert.equal(result.response.status, 200);
    result = await request('/rustplus-relay?clientId=client-a&serverKey=client-a%3Aserver-eu');
    assert.equal(result.response.status, 200);
    result = await request('/settings/rustplus-relay', { method: 'DELETE' });
    assert.equal(result.response.status, 403);
  } finally {
    for (const ws of relaySockets) {
      ws.terminate();
    }
    await closeWebSocketServer(relayWsServer).catch(() => {});
    await closeHttpServer(server).catch(() => {});
    await closeHttpServer(discordServer).catch(() => {});
    await closeHttpServer(kookServer).catch(() => {});
    await rm(dataDir, { recursive: true, force: true });
    delete process.env.NB_DISCORD_SEND_INTERVAL_MS;
    delete process.env.NB_DISCORD_MESSAGE_MAX_ATTEMPTS;
    delete process.env.NB_KOOK_API_BASE_URL;
  }
});

test('rustplus relay refreshes unchanged calibration snapshot freshness', async () => {
  const { ingestRustplusRelayPayload } = await import('../server/rustplus-relay.js');
  const { readStore } = await import('../server/store.js');
  const suffix = String(Date.now());
  const clientId = `client-calibration-${suffix}`;
  const serverId = `server-calibration-${suffix}`;
  const firstCapturedAt = '2026-06-17T00:00:00.000Z';
  const payload = {
    type: 'clan_snapshot',
    clientId,
    clientName: 'NB Calibration',
    serverId,
    serverName: 'Calibration Main',
    capturedAt: firstCapturedAt,
    members: [{ steamId: '76561198000007771', displayName: 'Calibration Alpha', online: true }],
    invites: []
  };

  let result = await ingestRustplusRelayPayload(payload);
  assert.equal(result.event.skipped, undefined);
  let store = await readStore();
  let server = store.rustplusRelay.servers.find((serverRecord) => serverRecord.key === `${clientId}:${serverId}`);
  assert.equal(server.lastSnapshotAt, firstCapturedAt);

  result = await ingestRustplusRelayPayload({
    ...payload,
    capturedAt: '2026-06-17T00:40:00.000Z'
  });
  assert.equal(result.event.skipped, true);
  assert.equal(result.event.skipReason, 'unchanged_snapshot');
  assert.equal(result.event.touched, true);
  store = await readStore();
  server = store.rustplusRelay.servers.find((serverRecord) => serverRecord.key === `${clientId}:${serverId}`);
  assert.ok(Date.parse(server.lastSnapshotAt) > Date.parse(firstCapturedAt));
  const member = result.relay.members.find((item) => item.steamId === '76561198000007771');
  assert.equal(member.online, true);
  assert.equal(member.presenceExpired, false);
});

test('rustplus relay matches clan invite and member identities by SteamID', async () => {
  const { normalizeRustplusRelayPayload, publicRustplusRelayState } = await import('../server/rustplus-relay.js');
  const receivedAt = '2026-06-18T08:00:00.000Z';
  const snapshot = normalizeRustplusRelayPayload({
    type: 'clan_snapshot',
    clientId: 'client-a',
    clientName: 'NB Main',
    serverId: 'server-eu',
    serverName: 'EU Main',
    clanId: '57',
    clanName: 'NBx57 CLAN',
    members: [
      { steamId: '76561198391326329', displayName: '76561198391326329', online: false },
      { steamId: '76561198999999001', displayName: '76561198999999001', online: true },
      { steamId: '76561198000000022', displayName: 'Barass', online: false }
    ]
  }, { receivedAt });
  const inviteRecord = normalizeRustplusRelayPayload({
    type: 'clan_invite_record',
    clientId: 'client-a',
    clientName: 'NB Main',
    serverId: 'server-eu',
    serverName: 'EU Main',
    invite: {
      id: 'invite-object-inviter',
      invitedBy: { steamId: '76561198999999001', name: 'Relay AN' },
      invitee: { steamId: '76561198391326329', name: 'Relay Massacre' },
      invitedAt: '2026-06-18T07:59:00.000Z',
      status: 'pending'
    }
  }, { receivedAt });
  assert.notEqual(inviteRecord.invitedBy, '[object Object]');
  const legacyBadTimeInviteRecord = {
    ...inviteRecord,
    sentAt: '+031968-05-02T16:00:00.000Z',
    acceptedAt: '2026-06-18T08:00:00.000Z'
  };

  const store = {
    members: [
      {
        id: 'member_massacre',
        steamId: '76561198391326329',
        customName: '76561198391326329',
        steamNickname: 'MassacRe™',
        avatar: 'https://avatars.test/massacre.jpg',
        vitalVipType: 'queue_skip',
        vitalVipPurchasedAt: '2026-06-01',
        vitalVipExpiresAt: '2026-06-29'
      },
      {
        id: 'member_an',
        steamId: '76561198999999001',
        customName: '',
        steamNickname: 'AN',
        avatar: 'https://avatars.test/an.jpg',
        vitalVipType: 'priority',
        vitalVipPurchasedAt: '2026-06-02',
        vitalVipExpiresAt: '2026-06-30'
      }
    ],
    squads: [{ id: 'squad_57', name: '57', archivedAt: '' }],
    squadMembers: [
      { memberId: 'member_massacre', squadId: 'squad_57' },
      { memberId: 'member_an', squadId: 'squad_57' }
    ],
    settings: { rustplusRelay: {} },
    rustplusRelay: {
      clients: [{ id: snapshot.client.id, name: snapshot.client.name, createdAt: receivedAt, lastSeenAt: receivedAt }],
      servers: [{
        key: snapshot.server.key,
        serverId: snapshot.server.id,
        name: snapshot.server.name,
        clientId: snapshot.client.id,
        clientName: snapshot.client.name,
        createdAt: receivedAt,
        lastSeenAt: receivedAt,
        lastSnapshotAt: receivedAt,
        snapshot
      }],
      chatMessages: [],
      inviteRecords: [legacyBadTimeInviteRecord]
    }
  };

  const relay = publicRustplusRelayState(store);
  const invite = relay.inviteRecords[0];
  assert.equal(invite.inviterMemberId, 'member_an');
  assert.equal(invite.inviterDisplayName, 'AN');
  assert.equal(invite.inviterAvatar, 'https://avatars.test/an.jpg');
  assert.equal(invite.inviteeMemberId, 'member_massacre');
  assert.equal(invite.inviteeDisplayName, 'MassacRe™');
  assert.equal(invite.inviteeAvatar, 'https://avatars.test/massacre.jpg');
  assert.equal(String(invite.invitedBy).includes('[object Object]'), false);
  assert.equal(invite.sentAt, '2026-06-18T08:00:00.000Z');

  const massacre = relay.members.find((member) => member.steamId === '76561198391326329');
  assert.equal(massacre.displayName, 'MassacRe™');
  assert.equal(massacre.memberId, 'member_massacre');
  assert.equal(massacre.avatar, 'https://avatars.test/massacre.jpg');
  assert.equal(massacre.vitalVipType, 'queue_skip');
  assert.equal(massacre.vitalVipExpiresAt, '2026-06-29');
  const inviter = relay.members.find((member) => member.steamId === '76561198999999001');
  assert.equal(inviter.displayName, 'AN');
  assert.equal(inviter.memberId, 'member_an');
  assert.equal(inviter.vitalVipType, 'priority');
  assert.equal(inviter.vitalVipExpiresAt, '2026-06-30');
});

test('rustplus public state marks unknown clan members and backfills Steam profile cache', async () => {
  const {
    normalizeRustplusRelayPayload,
    publicRustplusRelayState,
    refreshRustplusRelaySteamProfilesInStore
  } = await import('../server/rustplus-relay.js');
  const steamId = '76561198103393083';
  const missingSteamId = '76561198103393084';
  const receivedAt = '2026-06-18T09:00:00.000Z';
  const snapshot = normalizeRustplusRelayPayload({
    type: 'clan_snapshot',
    clientId: 'client-profile',
    clientName: 'NB Profile',
    serverId: 'server-profile',
    serverName: 'Profile Server',
    clanName: 'NBx57 CLAN',
    members: [
      { steamId, displayName: steamId, online: false },
      { steamId: missingSteamId, displayName: missingSteamId, online: false }
    ]
  }, { receivedAt });
  const store = {
    members: [],
    squads: [],
    squadMembers: [],
    settings: { rustplusRelay: {} },
    rustplusRelay: {
      clients: [{ id: snapshot.client.id, name: snapshot.client.name, createdAt: receivedAt, lastSeenAt: receivedAt }],
      servers: [{
        key: snapshot.server.key,
        serverId: snapshot.server.id,
        name: snapshot.server.name,
        clientId: snapshot.client.id,
        clientName: snapshot.client.name,
        createdAt: receivedAt,
        lastSeenAt: receivedAt,
        lastSnapshotAt: receivedAt,
        snapshot
      }],
      chatMessages: [],
      inviteRecords: [],
      steamProfiles: []
    }
  };

  let relay = publicRustplusRelayState(store);
  let unknownMember = relay.members.find((member) => member.steamId === steamId);
  assert.equal(unknownMember.memberId, '');
  assert.equal(unknownMember.unauthorizedMember, true);
  assert.equal(unknownMember.displayName, steamId);

  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, options = {}) => {
    const urlText = String(url);
    if (urlText === `https://steamcommunity.com/profiles/${missingSteamId}?xml=1`) {
      return new Response('', { status: 503, headers: { 'content-type': 'text/plain' } });
    }
    return originalFetch(url, options);
  };
  try {
    const backfill = await refreshRustplusRelaySteamProfilesInStore(store, [missingSteamId]);
    assert.equal(backfill.fetched, 0);
    assert.equal(backfill.updated, 1);
  } finally {
    globalThis.fetch = originalFetch;
  }
  const failedProfile = store.rustplusRelay.steamProfiles.find((profile) => profile.steamId === missingSteamId);
  assert.equal(failedProfile.fetchedAt, '');
  assert.ok(failedProfile.failedAt);
  assert.equal(failedProfile.lastError, 'Steam profile fetch returned no data');

  globalThis.fetch = async (url, options = {}) => {
    const urlText = String(url);
    if (urlText === `https://steamcommunity.com/profiles/${steamId}?xml=1`) {
      return new Response([
        '<profile>',
        `<steamID64>${steamId}</steamID64>`,
        '<steamID><![CDATA[NB Stranger]]></steamID>',
        '<avatarFull><![CDATA[https://avatars.steamstatic.com/nb-stranger-full.jpg]]></avatarFull>',
        '<privacyState>public</privacyState>',
        '</profile>'
      ].join(''), { status: 200, headers: { 'content-type': 'application/xml' } });
    }
    return originalFetch(url, options);
  };
  try {
    const backfill = await refreshRustplusRelaySteamProfilesInStore(store, [steamId]);
    assert.equal(backfill.fetched, 1);
    assert.equal(backfill.updated, 1);
  } finally {
    globalThis.fetch = originalFetch;
  }

  relay = publicRustplusRelayState(store);
  unknownMember = relay.members.find((member) => member.steamId === steamId);
  assert.equal(unknownMember.memberId, '');
  assert.equal(unknownMember.unauthorizedMember, true);
  assert.equal(unknownMember.steamNickname, 'NB Stranger');
  assert.equal(unknownMember.displayName, 'NB Stranger');
  assert.equal(unknownMember.avatar, 'https://avatars.steamstatic.com/nb-stranger-full.jpg');
  assert.equal(unknownMember.profileUrl, `https://steamcommunity.com/profiles/${steamId}`);
});

test('rustplus public state ignores stale duplicate server snapshots', async () => {
  const { publicRustplusRelayState } = await import('../server/rustplus-relay.js');
  const oldSnapshotAt = '2026-06-17T22:57:55.982Z';
  const latestSnapshotAt = '2026-06-18T08:38:23.945Z';
  const store = {
    members: [],
    squads: [],
    squadMembers: [],
    settings: { rustplusRelay: {} },
    rustplusRelay: {
      clients: [{ id: 'rust-go', name: 'rust-go', createdAt: oldSnapshotAt, lastSeenAt: latestSnapshotAt }],
      servers: [
        {
          key: 'rust-go:server-new',
          serverId: 'server-new',
          name: 'Vital Rust - EU Medium | 2x | Vanilla+ | No BP Wipes',
          clientId: 'rust-go',
          clientName: 'rust-go',
          lastSnapshotAt: latestSnapshotAt,
          snapshot: {
            capturedAt: latestSnapshotAt,
            clan: { id: '57', name: 'NBx57 CLAN', memberLimit: 40, announcement: '' },
            members: [{ steamId: '76561198000000001', displayName: 'Active Member', online: true }],
            invites: [],
            summary: { memberCount: 1, onlineCount: 1, offlineCount: 0, inviteCount: 0 }
          }
        },
        {
          key: 'rust-go:server-old',
          serverId: 'server-old',
          name: 'Vital Rust - EU Medium | 2x | Vanilla+ | No BP Wipes',
          clientId: 'rust-go',
          clientName: 'rust-go',
          lastSnapshotAt: oldSnapshotAt,
          snapshot: {
            capturedAt: oldSnapshotAt,
            clan: { id: '57', name: 'NBx57 CLAN', memberLimit: 40, announcement: '' },
            members: [{ steamId: '76561199409276299', displayName: 'gon', online: false }],
            invites: [],
            summary: { memberCount: 1, onlineCount: 0, offlineCount: 1, inviteCount: 0 }
          }
        }
      ],
      chatMessages: [],
      inviteRecords: []
    }
  };

  const relay = publicRustplusRelayState(store);
  assert.equal(relay.servers.length, 1);
  assert.equal(relay.servers[0].key, 'rust-go:server-new');
  assert.equal(relay.members.some((member) => member.steamId === '76561199409276299'), false);
  assert.equal(relay.members.some((member) => member.displayName === 'Active Member'), true);
  assert.equal(relay.summary.memberCount, 1);
});

test('rustplus public state ignores stale duplicate snapshots from older clients in the merged view', async () => {
  const { publicRustplusRelayState } = await import('../server/rustplus-relay.js');
  const oldSnapshotAt = '2026-06-18T08:00:00.000Z';
  const latestSnapshotAt = '2026-06-18T08:10:00.000Z';
  const store = {
    members: [],
    squads: [],
    squadMembers: [],
    settings: { rustplusRelay: {} },
    rustplusRelay: {
      clients: [
        { id: 'client-old', name: 'Old client', createdAt: oldSnapshotAt, lastSeenAt: oldSnapshotAt },
        { id: 'client-new', name: 'New client', createdAt: latestSnapshotAt, lastSeenAt: latestSnapshotAt }
      ],
      servers: [
        {
          key: 'client-old:server-eu',
          serverId: 'server-eu',
          name: 'Vital Rust - EU Medium | 2x',
          clientId: 'client-old',
          clientName: 'Old client',
          lastSnapshotAt: oldSnapshotAt,
          snapshot: {
            capturedAt: oldSnapshotAt,
            clan: { id: '57', name: 'NBx57 CLAN', memberLimit: 40, announcement: '' },
            members: [{ steamId: '76561198000000090', displayName: 'Stale Online', online: true }],
            invites: [],
            summary: { memberCount: 1, onlineCount: 1, offlineCount: 0, inviteCount: 0 }
          }
        },
        {
          key: 'client-new:server-eu',
          serverId: 'server-eu',
          name: 'Vital Rust - EU Medium | 2x',
          clientId: 'client-new',
          clientName: 'New client',
          lastSnapshotAt: latestSnapshotAt,
          snapshot: {
            capturedAt: latestSnapshotAt,
            clan: { id: '57', name: 'NBx57 CLAN', memberLimit: 40, announcement: '' },
            members: [],
            invites: [],
            summary: { memberCount: 0, onlineCount: 0, offlineCount: 0, inviteCount: 0 }
          }
        }
      ],
      chatMessages: [],
      inviteRecords: []
    }
  };

  const mergedRelay = publicRustplusRelayState(store);
  assert.equal(mergedRelay.clients.length, 2);
  assert.equal(mergedRelay.servers.length, 1);
  assert.equal(mergedRelay.servers[0].key, 'client-new:server-eu');
  assert.equal(mergedRelay.members.length, 0);
  assert.equal(mergedRelay.summary.onlineCount, 0);

  const oldClientRelay = publicRustplusRelayState(store, { clientId: 'client-old' });
  assert.equal(oldClientRelay.servers.length, 1);
  assert.equal(oldClientRelay.members.length, 1);
  assert.equal(oldClientRelay.members[0].displayName, 'Stale Online');
});

test('rustplus public state uses the latest member presence snapshot when merging servers', async () => {
  const { publicRustplusRelayState } = await import('../server/rustplus-relay.js');
  const steamId = '76561198000000077';
  const oldSnapshotAt = '2026-06-18T08:00:00.000Z';
  const latestSnapshotAt = '2026-06-18T08:05:00.000Z';
  const store = {
    members: [],
    squads: [],
    squadMembers: [],
    settings: { rustplusRelay: {} },
    rustplusRelay: {
      clients: [{ id: 'rust-go', name: 'rust-go', createdAt: oldSnapshotAt, lastSeenAt: latestSnapshotAt }],
      servers: [
        {
          key: 'rust-go:server-a',
          serverId: 'server-a',
          name: 'Server A',
          clientId: 'rust-go',
          clientName: 'rust-go',
          lastSnapshotAt: oldSnapshotAt,
          snapshot: {
            capturedAt: oldSnapshotAt,
            clan: { id: '57', name: 'NBx57 CLAN', memberLimit: 40, announcement: '' },
            members: [{ steamId, displayName: 'Presence Member', online: true, lastSeenAt: oldSnapshotAt }],
            invites: [],
            summary: { memberCount: 1, onlineCount: 1, offlineCount: 0, inviteCount: 0 }
          }
        },
        {
          key: 'rust-go:server-b',
          serverId: 'server-b',
          name: 'Server B',
          clientId: 'rust-go',
          clientName: 'rust-go',
          lastSnapshotAt: latestSnapshotAt,
          snapshot: {
            capturedAt: latestSnapshotAt,
            clan: { id: '57', name: 'NBx57 CLAN', memberLimit: 40, announcement: '' },
            members: [{ steamId, displayName: 'Presence Member', online: false, lastSeenAt: latestSnapshotAt, lastOfflineAt: latestSnapshotAt }],
            invites: [],
            summary: { memberCount: 1, onlineCount: 0, offlineCount: 1, inviteCount: 0 }
          }
        }
      ],
      chatMessages: [],
      inviteRecords: []
    }
  };

  const relay = publicRustplusRelayState(store);
  const member = relay.members.find((item) => item.steamId === steamId);
  assert.equal(member.online, false);
  assert.equal(member.lastSeenAt, latestSnapshotAt);
  assert.equal(member.lastOfflineAt, latestSnapshotAt);
  assert.equal(relay.summary.onlineCount, 0);
  assert.equal(relay.summary.offlineCount, 1);
});

test('rustplus public state expires stale online members from old relay snapshots', async () => {
  const { publicRustplusRelayState } = await import('../server/rustplus-relay.js');
  const originalDateNow = Date.now;
  const snapshotAt = '2026-06-18T08:00:00.000Z';
  Date.now = () => Date.parse('2026-06-18T08:31:00.000Z');
  try {
    const store = {
      members: [],
      squads: [],
      squadMembers: [],
      settings: { rustplusRelay: {} },
      rustplusRelay: {
        clients: [{ id: 'rust-go', name: 'rust-go', createdAt: snapshotAt, lastSeenAt: snapshotAt }],
        servers: [
          {
            key: 'rust-go:server-a',
            serverId: 'server-a',
            name: 'Server A',
            clientId: 'rust-go',
            clientName: 'rust-go',
            lastSeenAt: snapshotAt,
            lastSnapshotAt: snapshotAt,
            snapshot: {
              capturedAt: snapshotAt,
              clan: { id: '57', name: 'NBx57 CLAN', memberLimit: 40, announcement: '' },
              members: [{ steamId: '76561198000000078', displayName: 'Stale Online', online: true }],
              invites: [],
              summary: { memberCount: 1, onlineCount: 1, offlineCount: 0, inviteCount: 0 }
            }
          }
        ],
        chatMessages: [],
        inviteRecords: []
      }
    };

    const relay = publicRustplusRelayState(store);
    assert.equal(relay.members.length, 1);
    assert.equal(relay.members[0].online, false);
    assert.equal(relay.members[0].presenceExpired, true);
    assert.equal(relay.members[0].lastOfflineAt, '');
    assert.equal(relay.summary.onlineCount, 0);
    assert.equal(relay.summary.offlineCount, 1);
  } finally {
    Date.now = originalDateNow;
  }
});

test('rustplus public state lets explicit offline presence win same-time online conflicts', async () => {
  const { publicRustplusRelayState } = await import('../server/rustplus-relay.js');
  const steamId = '76561198000000079';
  const snapshotAt = '2026-06-18T08:00:00.000Z';
  const store = {
    members: [],
    squads: [],
    squadMembers: [],
    settings: { rustplusRelay: {} },
    rustplusRelay: {
      clients: [{ id: 'rust-go', name: 'rust-go', createdAt: snapshotAt, lastSeenAt: snapshotAt }],
      servers: [
        {
          key: 'rust-go:server-online',
          serverId: 'server-online',
          name: 'Server Online',
          clientId: 'rust-go',
          clientName: 'rust-go',
          lastSnapshotAt: snapshotAt,
          snapshot: {
            capturedAt: snapshotAt,
            clan: { id: '57', name: 'NBx57 CLAN', memberLimit: 40, announcement: '' },
            members: [{ steamId, displayName: 'Conflict Member', online: true, lastOnlineAt: snapshotAt }],
            invites: [],
            summary: { memberCount: 1, onlineCount: 1, offlineCount: 0, inviteCount: 0 }
          }
        },
        {
          key: 'rust-go:server-offline',
          serverId: 'server-offline',
          name: 'Server Offline',
          clientId: 'rust-go',
          clientName: 'rust-go',
          lastSnapshotAt: snapshotAt,
          snapshot: {
            capturedAt: snapshotAt,
            clan: { id: '57', name: 'NBx57 CLAN', memberLimit: 40, announcement: '' },
            members: [{ steamId, displayName: 'Conflict Member', online: false, lastOfflineAt: snapshotAt }],
            invites: [],
            summary: { memberCount: 1, onlineCount: 0, offlineCount: 1, inviteCount: 0 }
          }
        }
      ],
      chatMessages: [],
      inviteRecords: []
    }
  };

  const relay = publicRustplusRelayState(store);
  assert.equal(relay.members.length, 1);
  assert.equal(relay.members[0].online, false);
  assert.equal(relay.members[0].lastOfflineAt, snapshotAt);
  assert.equal(relay.summary.onlineCount, 0);
  assert.equal(relay.summary.offlineCount, 1);
});

test('rustplus public state folds legacy object client snapshots into client name filters', async () => {
  const { publicRustplusRelayState } = await import('../server/rustplus-relay.js');
  const snapshotAt = '2026-06-18T08:38:23.945Z';
  const store = {
    members: [],
    squads: [],
    squadMembers: [],
    settings: { rustplusRelay: {} },
    rustplusRelay: {
      clients: [
        { id: 'rust-go', name: 'rust-go', createdAt: snapshotAt, lastSeenAt: snapshotAt },
        { id: '[object_Object]', name: 'rust-go', createdAt: snapshotAt, lastSeenAt: snapshotAt }
      ],
      servers: [
        {
          key: '[object_Object]:server_1781718758098',
          serverId: 'server_1781718758098',
          name: 'Vital Rust - EU Medium',
          clientId: '[object_Object]',
          clientName: 'rust-go',
          lastSeenAt: snapshotAt,
          lastSnapshotAt: snapshotAt,
          snapshot: {
            capturedAt: snapshotAt,
            clan: { id: '[object Object]', name: 'NBx57 CLAN', memberLimit: 40, announcement: '' },
            members: [{
              steamId: '76561198963668559',
              displayName: 'Duffy',
              online: true,
              lastSeenAt: '2026-06-18T08:38:18.767Z',
              lastOfflineAt: '',
              onlineTimeMinutes: null
            }],
            invites: [],
            summary: { memberCount: 1, onlineCount: 1, offlineCount: 0, inviteCount: 0 }
          }
        }
      ],
      chatMessages: [],
      inviteRecords: []
    }
  };

  const relay = publicRustplusRelayState(store, { clientId: 'rust-go' });
  assert.equal(relay.clients.length, 1);
  assert.equal(relay.clients[0].id, 'rust-go');
  assert.equal(relay.servers.length, 1);
  assert.equal(relay.servers[0].clientId, 'rust-go');
  assert.equal(relay.members.length, 1);
  assert.equal(relay.members[0].steamId, '76561198963668559');
  assert.equal(relay.members[0].clientId, 'rust-go');
  assert.equal(relay.members[0].lastSeenAt, '2026-06-18T08:38:18.767Z');
  assert.equal(relay.members[0].lastOnlineAt, '2026-06-18T08:38:18.767Z');
});
