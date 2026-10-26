import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import {
  __mooseStatsProviderForTests,
  fetchMoosePeriods,
  fetchMoosePlayerStats,
  mooseCatalog,
  mooseFieldLabelZh,
  mooseServerDetail
} from '../server/moose-stats-provider.js';

const STEAM_ID = '76561198006834730';

function fakePlayerResult(params) {
  return {
    source: 'https://moose.gg/stats',
    server: { ...params.server, active: true },
    period: { id: 'all-time', name: params.period, nameZh: '全部时间', active: true },
    identity: {
      playerName: 'Ignignokt',
      avatar: '',
      playerUrl: `https://steamcommunity.com/profiles/${params.steamId}`,
      steamId: params.steamId
    },
    categories: [],
    matchedCategories: 0
  };
}

afterEach(() => {
  __mooseStatsProviderForTests.reset();
});

test('Moose catalog only exposes the four supported EU 2X servers', () => {
  const catalog = mooseCatalog();
  assert.equal(catalog.count, 4);
  assert.deepEqual(catalog.servers.map((server) => server.id), [
    'eu-mondays',
    'eu-medium',
    'eu-main',
    'eu-monthly'
  ]);
  assert.equal(catalog.servers[0].nameZh, 'Moose 欧服周一服');
  assert.throws(() => mooseServerDetail('us-main-premium'), /仅支持 EU Mondays/);
});

test('Moose field labels use Rust terminology and preserve unknown headers', () => {
  assert.equal(mooseFieldLabelZh('HQM'), '高金');
  assert.equal(mooseFieldLabelZh('High Quality Metal'), '高金');
  assert.equal(mooseFieldLabelZh('Sulfur'), '硫磺');
  assert.equal(mooseFieldLabelZh('Custom Moose Value'), 'Custom Moose Value');
  const fields = __mooseStatsProviderForTests.serializeFields(['Player', 'Kills', 'Kills'], 'pvp');
  assert.deepEqual(fields.map((field) => field.id), ['kills', 'kills-2']);
});

test('Moose player lookup requires server, period, and SteamID', async () => {
  await assert.rejects(
    fetchMoosePlayerStats({ serverId: 'eu-main', steamId: STEAM_ID }),
    /请选择 Moose 档期/
  );
  await assert.rejects(
    fetchMoosePlayerStats({ serverId: 'global', period: 'All Time', steamId: STEAM_ID }),
    /Moose 服务器无效/
  );
  await assert.rejects(
    fetchMoosePlayerStats({ serverId: 'eu-main', period: 'All Time', steamId: '123' }),
    /SteamID64 无效/
  );
});

test('same Moose player request is coalesced and successful results are cached', async () => {
  let calls = 0;
  __mooseStatsProviderForTests.setQueryImplementation(async (params) => {
    calls += 1;
    await new Promise((resolve) => setTimeout(resolve, 20));
    return fakePlayerResult(params);
  });
  const input = { serverId: 'eu-main', period: 'All Time', steamId: STEAM_ID, categoryIds: ['pvp'] };
  const [first, second] = await Promise.all([
    fetchMoosePlayerStats({ ...input, playerName: 'Old Name' }),
    fetchMoosePlayerStats({ ...input, playerName: 'New Name' })
  ]);
  const cached = await fetchMoosePlayerStats(input);
  assert.equal(calls, 1);
  assert.equal(first.identity.steamId, STEAM_ID);
  assert.equal(second.identity.steamId, STEAM_ID);
  assert.equal(cached.cached, true);
});

test('failed Moose player requests are not cached', async () => {
  let calls = 0;
  __mooseStatsProviderForTests.setQueryImplementation(async () => {
    calls += 1;
    throw Object.assign(new Error('upstream failed'), { status: 502 });
  });
  const input = { serverId: 'eu-monthly', period: 'All Time', steamId: STEAM_ID, categoryIds: ['pvp'] };
  await assert.rejects(fetchMoosePlayerStats(input), /upstream failed/);
  await assert.rejects(fetchMoosePlayerStats(input), /upstream failed/);
  assert.equal(calls, 2);
  assert.equal(__mooseStatsProviderForTests.cacheSize(), 0);
});

test('Moose period metadata uses singleflight and cache per server', async () => {
  let calls = 0;
  __mooseStatsProviderForTests.setPeriodQueryImplementation(async (server) => {
    calls += 1;
    await new Promise((resolve) => setTimeout(resolve, 20));
    return {
      source: 'https://moose.gg/stats',
      server,
      periods: [{ id: 'all-time', name: 'All Time', nameZh: '全部时间', active: true }],
      categories: []
    };
  });
  const [first, second] = await Promise.all([
    fetchMoosePeriods('eu-medium'),
    fetchMoosePeriods('eu-medium')
  ]);
  const cached = await fetchMoosePeriods('eu-medium');
  assert.equal(calls, 1);
  assert.equal(first.periods[0].name, 'All Time');
  assert.equal(second.periods[0].name, 'All Time');
  assert.equal(cached.cached, true);
});
