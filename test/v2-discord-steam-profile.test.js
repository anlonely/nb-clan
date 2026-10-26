import './support/owner-environment.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { renderSteamProfile } from '../server/v2/discord-steam-links/profile.js';
import { buildNativePrivateResponseRequest } from '../server/v2/notification-platforms/platforms.js';

const steamId = '76561198999999001', discordUserId = '200000000000000001', fetchedAt = '2026-10-15T05:00:00Z';
const profile = { status: 'ok', steamId, displayName: 'Known player', fetchedAt, enrichment: {
  steam: { status: 'ok', source: 'Steam', fetchedAt, rustMinutes: 6000, rustStatus: 'ok', profilePublic: true, accountCreatedAt: '2020-01-01T00:00:00Z' },
  bans: { status: 'ok', source: 'Steam', fetchedAt, vacBanned: false, communityBanned: false, numberOfVacBans: 0, numberOfGameBans: 0 },
  battlemetrics: { status: 'ok', source: 'BattleMetrics', fetchedAt, trackedSeconds: 3600, serverId: '456', from: '2026-10-01T00:00:00Z', to: '2026-10-14T00:00:00Z' },
} };
const native = payload => {
  const { flags, ...body } = payload; // callback already sent the ephemeral ACK
  assert.equal(flags, 64);
  return buildNativePrivateResponseRequest({ platform: 'discord', verifiedInteraction: {
    externalId: discordUserId, interactionId: '200000000000000002', channelId: '200000000000000003',
    privateReplyContext: { applicationId: '200000000000000004', interactionToken: 'constructed-test-token' },
  }, payload: body });
};
test('six locales project real Steam and scoped BM fields through production private payload contract', () => {
  for (const locale of ['zh-CN', 'en-US', 'ru', 'tr', 'th', 'ko']) {
    const payload = renderSteamProfile(profile, { locale, discordUserId, linked: true, steamId });
    const body = native(payload).body;
    assert.equal(body.allowed_mentions.parse.length, 0); assert.equal(body.allowed_mentions.users.length, 0);
    assert.equal(body.embeds.length, 1); assert.ok(body.embeds[0].fields.length < 25);
    assert.equal(body.components[0].components[0].url, `https://steamcommunity.com/profiles/${steamId}`);
    const text = JSON.stringify(body);
    assert.doesNotMatch(text, /<@|@everyone|@here/);
    assert.match(text, /BattleMetrics/); assert.match(text, /Steam/); assert.match(text, /456/);
    assert.match(text, /2026-10-01T00:00:00Z/); assert.match(text, /2026-10-14T00:00:00Z/);
    assert.doesNotMatch(text, /Risk Factor|risk_5|Vitality|Modded|Build|First seen/);
    assert.ok(body.embeds[0].fields.every(field => field.value.length <= 1024 && field.name.length <= 256));
    assert.ok(body.embeds[0].title.length <= 256);
  }
});
test('unsupported locale falls back to English and caller input is escaped and bounded', () => {
  assert.deepEqual(renderSteamProfile(profile, { locale: 'xx-unsupported', steamId }), renderSteamProfile(profile, { locale: 'en', steamId }));
  const malicious = structuredClone(profile);
  malicious.displayName = '@everyone <@200000000000000001> [click](https://evil.invalid)\u0000 **'.repeat(500);
  const payload = renderSteamProfile(malicious, { locale: 'en', steamId, discordUserId: 'evil.invalid' });
  const title = payload.embeds[0].title;
  assert.doesNotMatch(title, /@everyone|<@200000000000000001>|\u0000/);
  assert.match(title, /\\\[click\\\]/);
  assert.ok(title.length <= 256); assert.doesNotThrow(() => native(payload));
  assert.equal(payload.embeds[0].fields.some(field => field.name === 'Discord user'), false);
});
test('private, missing, zero and failed fields are explicit, never coerced to zero', () => {
  const hidden = { status: 'private', steamId, displayName: 'Hidden', fetchedAt, enrichment: {
    steam: { status: 'private', fetchedAt, profilePublic: false, rustStatus: 'private', rustMinutes: null },
    bans: { status: 'unavailable', fetchedAt }, battlemetrics: { status: 'unknown' },
  } };
  const payload = renderSteamProfile(hidden, { locale: 'en', steamId });
  const fields = payload.embeds[0].fields;
  assert.match(fields.find(field => field.name === 'Rust total playtime (Steam)').value, /^Private/);
  assert.match(fields.find(field => field.name === 'Steam ban records').value, /^Unavailable/);
  assert.match(fields.find(field => field.name === 'BM tracked server playtime').value, /^No data/);
  assert.doesNotMatch(JSON.stringify(fields), /0 hours|VAC bans: 0|Game bans: 0/);
  hidden.enrichment.steam = { rustStatus: 'ok', rustMinutes: 0 };
  assert.doesNotMatch(JSON.stringify(renderSteamProfile(hidden, { locale: 'en', steamId })), /0 hours/);
  assert.doesNotThrow(() => native(payload));
});
test('profile failure, identity mismatch and invalid identifiers cannot generate a plausible profile card', () => {
  for (const failed of [null, { status: 'unavailable', steamId }, { ...profile, steamId: '76561198000000001' }]) {
    const payload = renderSteamProfile(failed, { locale: 'en', steamId });
    assert.match(payload.content, /could not be checked/); assert.deepEqual(payload.embeds, []);
  }
  assert.match(renderSteamProfile({ status: 'not_found', steamId }, { locale: 'en', steamId }).content, /not found/);
  assert.match(renderSteamProfile(profile, { locale: 'en', steamId: '12345678901234567' }).content, /17-digit/);
});
test('BM partial or unbounded snapshot cannot be relabelled lifetime time', () => {
  for (const change of [{ status: 'partial' }, { from: undefined }, { to: undefined }, { fetchedAt: undefined }, { trackedSeconds: null }]) {
    const value = structuredClone(profile); Object.assign(value.enrichment.battlemetrics, change);
    const field = renderSteamProfile(value, { locale: 'en', steamId }).embeds[0].fields.find(field => field.name === 'BM tracked server playtime');
    assert.doesNotMatch(field.value, /^1 hours/);
  }
});
