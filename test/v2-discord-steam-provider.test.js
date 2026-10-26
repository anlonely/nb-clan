import './support/owner-environment.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createDiscordSteamProvider } from '../server/v2/production/discord-steam-provider.js';
import { createSteamReaders } from '../server/v2/management-adapters/source-host/steam.js';
import { Response as NodeResponse } from 'node-fetch';
import { createProductionNetwork } from '../server/v2/production/network.js';

const steamId = '76561198999999001', guildId = '1153571748147634236', when = '2026-10-15T05:00:00.000Z';
const summary = { steamId, name: 'A real player', profilePublic: true, playtimeMinutes: 1234, createdAt: '2020-01-01T00:00:00.000Z' };
const response = (data, status = 200) => new Response(JSON.stringify(data), { status });
const member = (n, extra = {}) => ({ user: { id: String(200000000000000000n + BigInt(n)), username: `member ${n}`, ...extra } });
function fixture(options = {}) {
  const calls = [];
  const host = { readers: { stats: {
    async summary(id, options) { calls.push({ type: 'summary', id, signal: options.signal }); return { ...summary, steamId: id }; },
    async resolveVanity(vanity, options) { calls.push({ type: 'vanity', vanity, signal: options.signal }); return steamId; },
  }, async readSteamRisk(id) { return { steamId: id, vacBanned: false, communityBanned: false, numberOfVacBans: 0, numberOfGameBans: 0 }; } } };
  const provider = createDiscordSteamProvider({ getSourceHost: () => host, readCredentials: () => ({ botToken: 'fixture-secret-token' }),
    fetchImpl: async () => response([]), now: () => Date.parse(when), ...options });
  return { provider, host, calls };
}
test('Steam inputs use exact allowlisted identifiers and fixed source readers', async () => {
  const { provider, calls } = fixture();
  for (const input of [steamId, ` ${steamId} `, `https://steamcommunity.com/profiles/${steamId}/`]) {
    const value = await provider.resolveIdentifier(input);
    assert.equal(value.status, 'ok'); assert.equal(value.steamId, steamId);
    assert.equal(value.profile.displayName, summary.name);
  }
  assert.equal((await provider.resolveIdentifier('https://steamcommunity.com/id/A_real-player/')).status, 'ok');
  assert.equal(calls.filter(c => c.type === 'vanity')[0].vanity, 'A_real-player');
  const before = calls.length;
  for (const input of ['12345678901234567', '76561197960265728', '76561202255233024',
    `http://steamcommunity.com/profiles/${steamId}`, `https://steamcommunity.com.evil/profiles/${steamId}`,
    `https://evil@steamcommunity.com/profiles/${steamId}`, `https://steamcommunity.com:443/profiles/${steamId}`,
    'https://steamcommunity.com/id/a?url=https://evil', 'https://steamcommunity.com/id/a#x',
    'https://steamcommunity.com/id/%2e%2e', 'https://steamcommunity.com/id/a/../b', '\\steamcommunity.com\\id\\a'])
    assert.equal((await provider.resolveIdentifier(input)).status, 'invalid', input);
  assert.equal(calls.length, before);
  assert.ok(calls.every(call => call.signal instanceof AbortSignal));
});
test('vanity/account absence, unavailable upstream and private accounts stay distinct', async () => {
  const { provider, host } = fixture();
  host.readers.stats.resolveVanity = async () => { throw Object.assign(new Error('no match'), { errorCode: 'SOURCE_NO_MATCH' }); };
  assert.deepEqual(await provider.resolveIdentifier('https://steamcommunity.com/id/missing'), { status: 'not_found' });
  host.readers.stats.summary = async () => ({ ...summary, profilePublic: false, playtimeMinutes: null });
  const linked = await provider.resolveIdentifier(steamId);
  assert.equal(linked.status, 'ok'); assert.equal(linked.profile.status, 'private');
  const profile = await provider.readProfile(steamId);
  assert.equal(profile.status, 'private'); assert.equal(profile.enrichment.steam.rustStatus, 'private');
  assert.equal(profile.enrichment.steam.rustMinutes, null);
  host.readers.stats.summary = async () => { throw new Error('failed https://secret@private.invalid?key=SECRET'); };
  assert.deepEqual(await provider.resolveIdentifier(steamId), { status: 'unavailable' });
  assert.doesNotMatch(JSON.stringify(await provider.readProfile(steamId)), /SECRET|private\.invalid/);
});
test('existing Steam reader private games, hidden zero and optional failures never become zero hours', async () => {
  let ownedGames = {}, failOwned = false;
  const steam = createSteamReaders({ allowed: () => true, network: { async json(_source, path) {
    if (path.includes('GetPlayerSummaries')) return { response: { players: [{ steamid: steamId, personaname: 'Known', communityvisibilitystate: 3 }] } };
    if (path.includes('GetOwnedGames')) {
      if (failOwned) throw Object.assign(new Error('unavailable'), { errorCode: 'SOURCE_UNAVAILABLE' });
      return ownedGames;
    }
    return { players: [{ SteamId: steamId, VACBanned: false, CommunityBanned: false, NumberOfVACBans: 0, NumberOfGameBans: 0 }] };
  } } });
  const { provider } = fixture({ getSourceHost: () => ({ readers: { stats: steam, readSteamRisk: steam.risk } }) });
  for (const value of [{}, { response: {} }, { response: { games: [] } }, { response: { games: [{ appid: 252490, playtime_forever: 0 }] } }]) {
    ownedGames = value;
    const result = await provider.readProfile(steamId);
    assert.equal(result.status, 'ok'); assert.equal(result.enrichment.steam.rustMinutes, null);
    assert.equal(result.enrichment.steam.rustStatus, 'unknown');
  }
  failOwned = true;
  assert.equal((await provider.readProfile(steamId)).enrichment.steam.rustStatus, 'unknown');
});
test('actual Steam summary and vanity reader accept the full individual ID range and reject neighboring account classes', async () => {
  let vanityId = '76561202255233023';
  const requests = [];
  const steam = createSteamReaders({ allowed: () => true, network: { async json(_source, path, { query }) {
    requests.push({ path, query });
    if (path.includes('GetPlayerSummaries')) return { response: { players: [{ steamid: query.steamids, personaname: 'Boundary', communityvisibilitystate: 3 }] } };
    if (path.includes('ResolveVanityURL')) return { response: { success: 1, steamid: vanityId } };
    return { response: { games: [] } };
  } } });
  for (const id of ['76561197960265729', '76561202255233023']) assert.equal((await steam.summary(id)).steamId, id);
  assert.equal(await steam.resolveVanity('upper_bound'), vanityId);
  const before = requests.length;
  for (const id of ['76561197960265728', '76561202255233024', '12345678901234567', 76561197960265729, null])
    await assert.rejects(() => steam.summary(id), { errorCode: 'INVALID_DATA' });
  assert.equal(requests.length, before);
  vanityId = '76561202255233024';
  await assert.rejects(() => steam.resolveVanity('non_individual'), { errorCode: 'INVALID_DATA' });
});
test('only exact identity-matched complete BattleMetrics snapshots expose scoped time', async () => {
  let stored = { steamId, battlemetricsPlayerId: '123', battlemetricsServerId: '456', battlemetricsWipeId: 'wipe-1',
    battlemetricsServerPlayTimeSeconds: 3600, battlemetricsSyncedAt: when, battlemetricsRangeStartAt: '2026-10-01T00:00:00Z',
    battlemetricsRangeStopAt: '2026-10-15T00:00:00Z', battlemetricsSessionTruncated: false, privateNotes: 'DO_NOT_EXPOSE' };
  const { provider, host } = fixture({ readBattlemetricsProfile: () => stored });
  const real = (await provider.readProfile(steamId)).enrichment.battlemetrics;
  assert.equal(real.status, 'ok'); assert.equal(real.trackedSeconds, 3600); assert.equal(real.serverId, '456');
  assert.equal(real.from, '2026-10-01T00:00:00.000Z'); assert.equal(real.fetchedAt, when);
  assert.doesNotMatch(JSON.stringify(real), /DO_NOT_EXPOSE|privateNotes/);
  for (const replacement of [{ steamId: '76561198000000001' }, { battlemetricsSessionTruncated: true },
    { battlemetricsServerPlayTimeSeconds: null }, { battlemetricsRangeStartAt: undefined },
    { battlemetricsRangeStopAt: '2026-09-01T00:00:00Z' }, { battlemetricsSyncedAt: '2030-01-01T00:00:00Z' }]) {
    const before = stored; stored = { ...stored, ...replacement };
    const unknown = (await provider.readProfile(steamId)).enrichment.battlemetrics;
    assert.equal(unknown.status, 'unknown'); assert.equal(unknown.trackedSeconds, undefined); stored = before;
  }
  host.readers.readSteamRisk = async () => { throw new Error('secret'); };
  const partial = await provider.readProfile(steamId);
  assert.equal(partial.status, 'ok'); assert.equal(partial.enrichment.bans.status, 'unavailable');
  assert.equal(partial.enrichment.bans.numberOfVacBans, undefined);
});
test('complete Discord member pagination uses numeric after cursor and retains bots for service filtering', async () => {
  const calls = [], rows = Array.from({ length: 1000 }, (_, i) => member(i + 1));
  const { provider } = fixture({ fetchImpl: async (url, options) => {
    calls.push({ url, options });
    return response(calls.length === 1 ? rows : [member(1001, { bot: true, global_name: 'robot' })]);
  } });
  const result = await provider.listGuildMembers(guildId);
  assert.equal(result.status, 'ok'); assert.equal(result.complete, true); assert.equal(result.members.length, 1001);
  assert.equal(result.members[1000].bot, true); assert.equal(result.members[1000].displayName, 'robot');
  assert.equal(new URL(calls[1].url).searchParams.get('after'), rows[999].user.id);
  assert.equal(calls[0].options.redirect, 'manual'); assert.equal(calls[0].options.method, 'GET');
  assert.equal(result.fetchedAt, when);
});
test('production network converts actual node-fetch responses for the member list reader', async () => {
  const seen = [];
  const network = createProductionNetwork({ readSettings: () => ({ system: { proxy: { enabled: false } } }), env: {},
    fetchImpl: async (url, options) => { seen.push({ url, options }); return new NodeResponse(JSON.stringify([member(1)]), { status: 200 }); } });
  const { provider } = fixture({ fetchImpl: (url, options) => network.serviceFetch('discord', url, options) });
  const result = await provider.listGuildMembers(guildId);
  assert.equal(result.complete, true); assert.equal(result.members[0].discordId, member(1).user.id);
  assert.equal(seen[0].options.headers.authorization, 'Bot fixture-secret-token');
  assert.equal(seen[0].options.agent, undefined); assert.equal(seen[0].options.redirect, 'error');
  provider.stop(); network.stop();
});
test('member permission failures and partial/page-limit failures never masquerade as an empty complete list', async () => {
  for (const failure of [401, 403, 429, 500]) {
    const { provider } = fixture({ fetchImpl: async () => response({ secret: 'DO_NOT_EXPOSE' }, failure) });
    const result = await provider.listGuildMembers(guildId);
    assert.equal(result.status, 'unavailable'); assert.equal(result.complete, false); assert.equal(result.members, undefined);
    if ([401, 403].includes(failure)) assert.equal(result.reason, 'member_access_denied');
    assert.doesNotMatch(JSON.stringify(result), /DO_NOT_EXPOSE/);
  }
  const full = Array.from({ length: 1000 }, (_, i) => member(i + 1));
  let requests = 0;
  const { provider } = fixture({ fetchImpl: async () => ++requests === 1 ? response(full) : response({}, 403) });
  assert.equal((await provider.listGuildMembers(guildId)).complete, false); assert.equal(requests, 2);
  const limited = fixture({ maxMemberPages: 1, fetchImpl: async () => response(full) }).provider;
  assert.deepEqual(await limited.listGuildMembers(guildId), { status: 'unavailable', complete: false, reason: 'member_page_limit' });
});
test('invalid repeated/out-of-order pages, oversized bodies and credential changes fail closed', async () => {
  for (const payload of [[member(2), member(1)], [member(1), member(1)], [{ user: { id: 'short', username: 'x' } }],
    [member(1, { bot: 'false' })], { members: [] }, [{ user: { ...member(1).user, username: 'x'.repeat(2 * 1024 * 1024) } }]]) {
    const { provider } = fixture({ fetchImpl: async () => response(payload) });
    assert.equal((await provider.listGuildMembers(guildId)).complete, false);
  }
  let token = 'old-token';
  const { provider } = fixture({ readCredentials: () => ({ botToken: token }), fetchImpl: async () => { token = 'new-token'; return response([]); } });
  assert.equal((await provider.listGuildMembers(guildId)).complete, false);
});
test('timeouts, caller cancellation and stop bound non-cooperative upstream requests', async () => {
  let receivedSignal;
  const { provider } = fixture({ timeoutMs: 20, fetchImpl: async (_url, { signal }) => { receivedSignal = signal; return new Promise(() => {}); } });
  const start = Date.now();
  assert.equal((await provider.listGuildMembers(guildId)).reason, 'timeout');
  assert.ok(Date.now() - start < 1000); assert.equal(receivedSignal.aborted, true);
  const aborted = new AbortController(); aborted.abort();
  assert.equal((await provider.readProfile(steamId, { signal: aborted.signal })).status, 'unavailable');
  provider.stop(); assert.equal((await provider.resolveIdentifier(steamId)).status, 'unavailable');
});
