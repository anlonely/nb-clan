import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import express from 'express';

test('member Hexaytron refresh parses Discord card into an independent profile field', async () => {
  const envKeys = [
    'NB_DATA_DIR',
    'NB_ROOT_PASSWORD',
    'NB_DISABLE_BACKGROUND_JOBS',
    'NB_DISCORD_API_BASE_URL',
    'NB_DISCORD_SEND_INTERVAL_MS',
    'NB_HEXAYTRON_ENABLED',
    'NB_HEXAYTRON_DISCORD_GUILD_ID',
    'NB_HEXAYTRON_DISCORD_CHANNEL_ID',
    'NB_HEXAYTRON_POLL_TIMEOUT_MS',
    'NB_HEXAYTRON_POLL_INTERVAL_MS',
    'NB_HEXAYTRON_SYNC_INTERVAL_MS',
    'NODE_ENV'
  ];
  const oldEnv = Object.fromEntries(envKeys.map((key) => [key, process.env[key]]));
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'nb-clan-hexaytron-'));
  let appServer = null;
  let discordServer = null;

  try {
    process.env.NB_DATA_DIR = dataDir;
    process.env.NB_ROOT_PASSWORD = 'RootPass123!';
    process.env.NB_DISABLE_BACKGROUND_JOBS = '1';
    process.env.NB_DISCORD_SEND_INTERVAL_MS = '0';
    process.env.NB_HEXAYTRON_ENABLED = '1';
    process.env.NB_HEXAYTRON_DISCORD_GUILD_ID = '1153571748147634236';
    process.env.NB_HEXAYTRON_DISCORD_CHANNEL_ID = '1519338458072481936';
    process.env.NB_HEXAYTRON_POLL_TIMEOUT_MS = '1000';
    process.env.NB_HEXAYTRON_POLL_INTERVAL_MS = '10';
    process.env.NB_HEXAYTRON_SYNC_INTERVAL_MS = '10';
    process.env.NODE_ENV = 'production';

    const discordPosts = [];
    const discordFetches = [];
    const discordResponses = new Map();
    let nextDiscordMessageId = 900000000000000001n;
    const nextDiscordId = () => {
      const id = String(nextDiscordMessageId);
      nextDiscordMessageId += 1n;
      return id;
    };
    const hexaytronMessageFor = (requestMessageId, command = '') => {
      const steamId = String(command || '').match(/\d{17}/)?.[0] || '';
      const battlemetricsId = steamId === '76561198000000002' ? '2200000002' : '1106296105';
      return {
        id: nextDiscordId(),
        channel_id: '1519338458072481936',
        timestamp: new Date().toISOString(),
        author: { id: 'hexaytron_bot', username: 'Hexaytron', bot: true },
        embeds: [
          {
            title: 'Hexaytron player card',
            url: `https://www.battlemetrics.com/players/${battlemetricsId}`,
            fields: [
              { name: 'Atlas', value: steamId === '76561198000000002' ? '12 Hours' : '341 Hours', inline: true },
              { name: 'Vital', value: '263 Hours', inline: true },
              { name: 'Rustinity', value: '0 Hours', inline: true },
              { name: 'Building', value: '21 Hours', inline: true },
              { name: 'Aimtrain', value: '950 Hours', inline: true },
              { name: 'Official', value: '1,499 Hours', inline: true },
              { name: 'First Seen', value: '2553 Days ago', inline: true },
              { name: 'Rust', value: '5441 Hours', inline: true }
            ]
          }
        ]
      };
    };

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
      discordFetches.push({
        channelId: req.params.channelId,
        authorization: req.get('authorization') || '',
        query: req.query
      });
      res.json(discordResponses.has(req.query.after) ? [discordResponses.get(req.query.after)] : []);
    });
    discordServer = createServer(discordApp);
    await new Promise((resolve) => discordServer.listen(0, '127.0.0.1', resolve));
    process.env.NB_DISCORD_API_BASE_URL = `http://127.0.0.1:${discordServer.address().port}`;

    const apiModule = await import('../server/api.js');
    const storeModule = await import('../server/store.js');
    await storeModule.ensureStore();
    await storeModule.updateStore((store) => {
      const createdAt = storeModule.nowIso();
      store.settings.discord.botToken = 'discord_bot_token_hexaytron_test_123456';
      store.members.push({
        id: 'member_hexaytron_test',
        steamId: '76561198876934017',
        rawInput: '76561198876934017',
        customName: 'Hexaytron Target',
        steamNickname: 'Hex Target',
        avatar: '',
        battlemetricsId: 'existing_bm_should_remain',
        createdAt,
        updatedAt: createdAt
      }, {
        id: 'member_hexaytron_second',
        steamId: '76561198000000002',
        rawInput: '76561198000000002',
        customName: 'Hexaytron Second',
        steamNickname: 'Hex Second',
        avatar: '',
        battlemetricsId: '',
        createdAt,
        updatedAt: createdAt
      });
    });

    const app = express();
    app.use('/api', apiModule.createApiRouter());
    appServer = createServer(app);
    await new Promise((resolve) => appServer.listen(0, '127.0.0.1', resolve));
    const baseUrl = `http://127.0.0.1:${appServer.address().port}/api`;
    let cookie = '';
    async function request(pathname, options = {}) {
      const response = await fetch(`${baseUrl}${pathname}`, {
        method: options.method || 'GET',
        headers: {
          ...(options.body ? { 'content-type': 'application/json' } : {}),
          ...(cookie ? { cookie } : {})
        },
        body: options.body ? JSON.stringify(options.body) : undefined
      });
      const setCookie = response.headers.get('set-cookie');
      if (setCookie) cookie = setCookie.split(';')[0];
      const text = await response.text();
      const payload = response.headers.get('content-type')?.includes('application/json') ? JSON.parse(text) : {};
      return { response, payload, text };
    }

    async function waitForSyncJob(jobId) {
      const deadline = Date.now() + 5000;
      while (Date.now() < deadline) {
        const recent = await request('/sync/jobs/recent?limit=8');
        assert.equal(recent.response.status, 200, recent.text);
        const jobs = [...(recent.payload.current || []), ...(recent.payload.recent || [])];
        const job = jobs.find((item) => item.id === jobId);
        if (job && !['queued', 'running'].includes(job.status)) return job;
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      throw new Error(`Timed out waiting for sync job ${jobId}`);
    }

    let result = await request('/auth/login', {
      method: 'POST',
      body: { username: 'root', password: 'RootPass123!' }
    });
    assert.equal(result.response.status, 200, result.text);

    result = await request('/members/member_hexaytron_test/hexaytron/refresh', { method: 'POST' });
    assert.equal(result.response.status, 200, result.text);
    assert.equal(discordPosts.length, 1);
    assert.equal(discordPosts[0].channelId, '1519338458072481936');
    assert.equal(discordPosts[0].authorization, 'Bot discord_bot_token_hexaytron_test_123456');
    assert.equal(discordPosts[0].body.content, '/player identifier:76561198876934017');
    assert.equal(discordPosts[0].body.allowed_mentions.parse.length, 0);
    assert.equal(discordFetches.length >= 1, true);

    const hexaytron = result.payload.member.profileStats.hexaytron;
    assert.equal(hexaytron.battlemetricsId, '1106296105');
    assert.equal(hexaytron.servers.find((item) => item.key === 'atlas').hours, 341);
    assert.equal(hexaytron.servers.find((item) => item.key === 'rustinity').hours, 0);
    assert.equal(hexaytron.servers.find((item) => item.key === 'official').hours, 1499);
    assert.equal(hexaytron.rustHours, 5441);
    assert.equal(hexaytron.firstSeenDaysAgo, 2553);
    assert.match(hexaytron.sourceMessageUrl, /discord\.com\/channels\/1153571748147634236\/1519338458072481936\/900000000000000002/);

    const store = await storeModule.readStore();
    const member = store.members.find((item) => item.id === 'member_hexaytron_test');
    assert.equal(member.battlemetricsId, 'existing_bm_should_remain');
    const profile = store.memberProfiles.find((item) => item.memberId === 'member_hexaytron_test');
    assert.equal(profile.hexaytron.battlemetricsId, '1106296105');
    assert.equal(profile.hexaytron.servers.length, 6);

    result = await request('/sync/jobs/hexaytron-profile', { method: 'POST' });
    assert.equal(result.response.status, 200, result.text);
    assert.equal(result.payload.job.type, 'hexaytron_profile');
    assert.equal(result.payload.job.totalCount, 2);

    const hexaytronJob = await waitForSyncJob(result.payload.job.id);
    assert.equal(hexaytronJob.status, 'completed');
    assert.equal(hexaytronJob.doneCount, 2);
    assert.equal(hexaytronJob.failedCount, 0);
    assert.equal(discordPosts.length, 3);
    assert.deepEqual(discordPosts.map((post) => post.body.content), [
      '/player identifier:76561198876934017',
      '/player identifier:76561198876934017',
      '/player identifier:76561198000000002'
    ]);

    const finalStore = await storeModule.readStore();
    const firstProfile = finalStore.memberProfiles.find((item) => item.memberId === 'member_hexaytron_test');
    const secondProfile = finalStore.memberProfiles.find((item) => item.memberId === 'member_hexaytron_second');
    assert.equal(firstProfile.hexaytron.battlemetricsId, '1106296105');
    assert.equal(secondProfile.hexaytron.battlemetricsId, '2200000002');
    assert.equal(secondProfile.hexaytron.servers.find((item) => item.key === 'atlas').hours, 12);
  } finally {
    if (appServer) await new Promise((resolve) => appServer.close(resolve));
    if (discordServer) await new Promise((resolve) => discordServer.close(resolve));
    await rm(dataDir, { recursive: true, force: true });
    for (const [key, value] of Object.entries(oldEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});
