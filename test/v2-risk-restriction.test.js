import assert from 'node:assert/strict';
import test from 'node:test';
import { createRiskReader } from '../server/v2/management-adapters/source-host/risk-reader.js';

const steamId = '76561198000000501';

async function readRestriction(success) {
  const network = {
    tracked: fn => fn(new AbortController().signal),
    json: (source, path) => {
      if (source === 'steam' && path.includes('GetPlayerSummaries')) return { response: { players: [{ steamid: steamId, personaname: 'Member', communityvisibilitystate: 3 }] } };
      if (source === 'community' && path === '/broadcast/getbroadcastmpd/') return { success, retry: 30000, broadcastid: 0, eresult: 1 };
      throw new Error(`Unexpected source: ${source} ${path}`);
    }
  };
  const reader = createRiskReader({ network, steam: {}, inventory: () => {} });
  return reader({ member: { steamId }, config: { required: ['accountRestricted'], requiredSources: ['restriction'],
    riskCapabilities: { steam: true, steamRisk: true }, credentialBindings: {} } });
}

test('broadcast unavailable preserves the response without claiming an account restriction result', async () => {
  const result = await readRestriction('unavailable');
  assert.equal(result.restriction.status, 'partial');
  assert.equal(result.restriction.error, 'SOURCE_MISSING_FIELDS');
  assert.equal(result.restriction.fields.accountRestrictionStatus, 'unavailable');
  assert.equal(result.restriction.fields.accountRestricted, undefined);
});

test('explicit broadcast restriction states remain observed', async () => {
  for (const [success, restricted] of [['ready', false], ['user_restricted', true]]) {
    const result = await readRestriction(success);
    assert.equal(result.restriction.status, 'observed');
    assert.equal(result.restriction.fields.accountRestricted, restricted);
  }
});

test('Steam zero playtime remains unknown because a user may hide hours separately', async () => {
  const network = {
    tracked: fn => fn(new AbortController().signal),
    json: (source, path) => {
      if (source === 'steam' && path.includes('GetPlayerSummaries')) return { response: { players: [{ steamid: steamId, personaname: 'Member', communityvisibilitystate: 3 }] } };
      if (source === 'steam' && path.includes('GetOwnedGames')) return { response: { games: [{ appid: 252490, playtime_forever: 0 }] } };
      throw new Error(`Unexpected source: ${source} ${path}`);
    }
  };
  const reader = createRiskReader({ network, steam: {}, inventory: () => {} });
  const result = await reader({ member: { steamId }, config: { required: ['playTimeMinutes', 'playTimeKnown', 'playTimeVisibility'], requiredSources: ['playtime'],
    riskCapabilities: { steam: true }, credentialBindings: {} } });
  assert.equal(result.playtime.status, 'partial');
  assert.deepEqual(result.playtime.fields, { playTimeKnown: false, playTimeVisibility: 'unknown' });
});
