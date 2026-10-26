import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import http from 'node:http';
import https from 'node:https';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

test('legacy Discord card builders preserve instants for viewer-local timestamps without network calls', async (t) => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'nb-discord-card-timezones-'));
  const environment = {
    NB_DATA_DIR: dataDir,
    NB_ROOT_PASSWORD: 'RootPass123!',
    NB_STORAGE_MODE: 'sqlite-primary',
    NB_SQLITE_FILE: path.join(dataDir, 'nb-clan.sqlite'),
    NB_DISABLE_BACKGROUND_JOBS: '1',
    NB_DISABLE_EXTERNAL_VITAL: '1',
    NB_DISABLE_EXTERNAL_ATLAS: '1',
    TZ: 'UTC'
  };
  const previousEnv = Object.fromEntries(Object.keys(environment).map((key) => [key, process.env[key]]));
  Object.assign(process.env, environment);
  const denyNetwork = () => { throw new Error('Card rendering must not access the network'); };
  t.mock.method(http, 'request', denyNetwork);
  t.mock.method(https, 'request', denyNetwork);
  t.mock.method(globalThis, 'fetch', denyNetwork);

  try {
    const { ensureStore, readStore } = await import('../server/store.js');
    const { buildDiscordMemberRankingMessage, buildDiscordKdaQueryMessage } = await import('../server/api.js');
    const { buildRustplusRelayChatDiscordMessage, buildRustplusRelayDiscordMessage } = await import('../server/rustplus-relay.js');
    await ensureStore();
    const store = await readStore();
    const syncedAt = '2026-06-17T08:04:00+08:00';
    // 08:04 in China is 00:04 UTC, not 08:04 UTC.
    const expectedTime = '<t:1781654640:F>';
    const member = {
      id: 'member_timezones', steamId: '76561198000012349',
      displayName: 'Clock Test', steamNickname: 'Clock Test', status: 'active', specialty: ''
    };
    store.members = [member];
    store.wipes = [{ id: 'wipe_timezones', name: 'Timezone Test', serverName: 'Test Server', status: 'active', startedAt: '2026-06-16T00:00:00Z' }];
    store.kdaRows = [{
      id: 'kda_timezones', wipeId: 'wipe_timezones', memberId: member.id, steamId: member.steamId,
      kills: 42, deaths: 2, assists: 5, t3Kills: 42, rockets: 4,
      sulfur: 42000, metalOre: 12000, building: 300, playTimeMinutes: 360,
      raw: {}, source: 'manual', capturedAt: syncedAt, syncedAt
    }];

    await t.test('ranking freshness uses the same native instant across server timezones and languages', () => {
      for (const timezone of ['UTC', 'Asia/Shanghai', 'America/New_York']) {
        process.env.TZ = timezone;
        for (const language of ['en', 'zh', 'tr']) {
          const embed = buildDiscordMemberRankingMessage(structuredClone(store), { language }).embeds[0];
          assert.equal(embed.fields.length, 1, 'fixture must render a real ranked member');
          assert.ok(embed.description.includes(expectedTime));
          assert.doesNotMatch(embed.description, /06\/17|2026-|UTC\+8/);
          assert.doesNotMatch(embed.footer.text, /<t:|2026-/);
        }
      }
    });

    await t.test('KDA freshness is a native field and deletion keeps its relative countdown', () => {
      const embed = buildDiscordKdaQueryMessage(structuredClone(store), member, 'en', {
        deleteAt: '2026-06-17T00:05:00Z'
      }).embeds[0];
      assert.equal(embed.fields.filter((field) => field.value === expectedTime).length, 1);
      assert.ok(embed.fields.some((field) => field.value.includes('<t:1781654700:R>')));
      assert.doesNotMatch(embed.footer.text, /<t:|2026-|06\/17/);
      assert.doesNotMatch(JSON.stringify(embed.fields), /2026-|06\/17|UTC\+8/);
      const invalidStore = structuredClone(store);
      invalidStore.kdaRows[0].syncedAt = '2026-06-17T08:04:00';
      const invalid = buildDiscordKdaQueryMessage(invalidStore, member, 'en').embeds[0];
      assert.ok(invalid.fields.every((field) => !field.value.includes('<t:')));
    });

    await t.test('individual relay chat uses sent time and falls back to received time', () => {
      const message = { displayName: 'Alpha', message: 'Hello', sentAt: syncedAt };
      const expectedContent = `${expectedTime}\nAlpha：Hello\n--------------------`;
      assert.equal(buildRustplusRelayChatDiscordMessage(message).content, expectedContent);
      const fallback = buildRustplusRelayChatDiscordMessage({ ...message, sentAt: 'invalid', receivedAt: '2026-06-17T00:04:00Z' });
      assert.equal(fallback.content, expectedContent);
      assert.deepEqual(fallback.allowed_mentions, { parse: [] });
    });

    await t.test('relay summary uses native times per line and never interprets ambiguous times', () => {
      const result = buildRustplusRelayDiscordMessage({
        server: { name: 'Test Server' },
        chatMessages: [
          { displayName: 'Alpha', message: 'Hello', sentAt: syncedAt },
          { displayName: 'Beta', message: 'Fallback', sentAt: 'invalid', receivedAt: '2026-06-17T00:05:00Z' },
          { displayName: 'Gamma', message: 'Unknown time', sentAt: '2026-06-17T08:04:00' }
        ]
      });
      assert.equal(result.embeds[0].description, `${expectedTime} **Alpha**: Hello\n<t:1781654700:F> **Beta**: Fallback\n— **Gamma**: Unknown time`);
      assert.deepEqual(result.allowed_mentions, { parse: [] });
    });
  } finally {
    const { closeSqliteDatabasesForTests } = await import('../server/storage/sqlite.js');
    await closeSqliteDatabasesForTests();
    for (const [key, value] of Object.entries(previousEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await rm(dataDir, { recursive: true, force: true });
  }
});
