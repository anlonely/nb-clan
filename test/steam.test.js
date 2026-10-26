import assert from 'node:assert/strict';
import test from 'node:test';
import { parseSteamBroadcastPayload, parseSteamInput, parseSteamPlayerBansPayload } from '../server/steam.js';

test('parses steamid64 and profile url as canonical string', () => {
  assert.equal(parseSteamInput('76561198000000000').steamId, '76561198000000000');
  assert.equal(parseSteamInput('https://steamcommunity.com/profiles/76561198000000000/').steamId, '76561198000000000');
});

test('converts legacy STEAM_X:Y:Z format', () => {
  assert.equal(parseSteamInput('STEAM_0:1:2').steamId, '76561197960265733');
});

test('converts steam3 account id format', () => {
  assert.equal(parseSteamInput('[U:1:12345]').steamId, '76561197960278073');
});

test('returns useful failure for unsupported input', () => {
  const parsed = parseSteamInput('not-a-steam-id');
  assert.equal(parsed.ok, false);
  assert.match(parsed.message, /无法识别/);
});

test('parses Steam broadcast restriction status', () => {
  const normal = parseSteamBroadcastPayload('76561198000000000', {
    success: 'unavailable',
    retry: 30000,
    broadcastid: 0,
    eresult: 1
  });
  assert.equal(normal.restricted, false);
  assert.equal(normal.success, 'unavailable');
  assert.equal(normal.retryMs, 30000);

  const restricted = parseSteamBroadcastPayload('76561198000000001', {
    success: 'user_restricted',
    retry: 30000,
    broadcastid: 0,
    eresult: 1
  });
  assert.equal(restricted.restricted, true);
  assert.equal(restricted.success, 'user_restricted');
});

test('parses Steam player ban payload', () => {
  const bansBySteamId = parseSteamPlayerBansPayload({
    players: [{
      SteamId: '76561198000000001',
      CommunityBanned: true,
      VACBanned: true,
      NumberOfVACBans: 1,
      DaysSinceLastBan: 1408,
      NumberOfGameBans: 2,
      EconomyBan: 'probation'
    }]
  });
  const ban = bansBySteamId.get('76561198000000001');
  assert.equal(ban.vacBanned, true);
  assert.equal(ban.numberOfVacBans, 1);
  assert.equal(ban.numberOfGameBans, 2);
  assert.equal(ban.daysSinceLastBan, 1408);
  assert.equal(ban.communityBanned, true);
  assert.equal(ban.economyRestricted, true);
});

test('does not treat Steam false strings as active bans', () => {
  const bansBySteamId = parseSteamPlayerBansPayload({
    players: [{
      SteamId: '76561198000000002',
      CommunityBanned: 'false',
      VACBanned: 'false',
      NumberOfVACBans: '0',
      DaysSinceLastBan: '0',
      NumberOfGameBans: '0',
      EconomyBan: 'none'
    }]
  });
  const ban = bansBySteamId.get('76561198000000002');
  assert.equal(ban.vacBanned, false);
  assert.equal(ban.communityBanned, false);
  assert.equal(ban.economyRestricted, false);
});
