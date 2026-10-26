import test from 'node:test';
import assert from 'node:assert/strict';
import { parseSteamIdentifier, parseSteamLinksInteraction, ownsSteamLinksInteraction, steamLinksCustomId } from '../server/v2/discord-steam-links/interaction-input.js';
import { steamLinksLanguages, steamLinksText, localizeSteamLinksError } from '../server/v2/discord-steam-links/locale.js';
import { steamLinksModal, renderSteamLinksList, steamLinkConfirmation } from '../server/v2/discord-steam-links/renderer.js';

const token = 'A'.repeat(43), id = '76561198000000001', user = '1177000000000000000';
const invalid = error => error.errorCode === 'PLATFORM_PAYLOAD_INVALID';

test('Steam identifiers are trimmed and user-controlled URLs stay within the exact Steam profile whitelist', () => {
  for (const value of [id, `https://steamcommunity.com/profiles/${id}`, `https://steamcommunity.com/profiles/${id}/`])
    assert.equal(parseSteamIdentifier(`  ${value}  `).steamId, id);
  assert.equal(parseSteamIdentifier('https://steamcommunity.com/id/person_1-2/').vanity, 'person_1-2');
  for (const value of [123, '', '1'.repeat(16), '1'.repeat(18), 'https://steamcommunity.com.evil/id/a', 'https://steamcommunity.com@evil/id/a',
    'https://evil@steamcommunity.com/id/a', 'https://steamcommunity.com:443/id/a', 'http://steamcommunity.com/id/a',
    'https://steamcommunity.com/id/a?x=1', 'https://steamcommunity.com/id/a#x', 'https://steamcommunity.com/id/%2e%2e',
    'https://steamcommunity.com/id/../profiles/' + id, 'https://steamcommunity.com/id/a\\b', 'https://steamcommunity.com/groups/test',
    'https://steamcommunity.com/id/a\n/x', '<https://steamcommunity.com/id/a>', 'https://127.0.0.1/id/a'])
    assert.equal(parseSteamIdentifier(value), null, String(value));
});

test('native command parsing admits exactly the four documented actions and strict typed inputs', () => {
  assert.deepEqual(parseSteamLinksInteraction({ type: 2, data: { name: 'setsteam' } }), { kind: 'steam_links', action: 'open' });
  const command = options => ({ type: 2, data: { name: 'view', options } });
  for (const action of ['all', 'nosteam']) assert.equal(parseSteamLinksInteraction(command([{ type: 1, name: action }])).action, `view_${action}`);
  assert.deepEqual(parseSteamLinksInteraction(command([{ type: 1, name: 'user', options: [{ type: 6, name: 'user', value: user }] }])).values, { user });
  assert.deepEqual(parseSteamLinksInteraction(command([{ type: 1, name: 'user', options: [] }])).values, {});
  assert.throws(() => parseSteamLinksInteraction(command([{ type: 1, name: 'user', options: [{ type: 3, name: 'user', value: user }] }])), invalid);
  assert.throws(() => parseSteamLinksInteraction(command([{ type: 1, name: 'all', options: [{ type: 3, name: 'identifier', value: id }] }])), invalid);
  assert.throws(() => parseSteamLinksInteraction(command([{ type: 1, name: 'user', options: [1, 2, 3] }])), invalid);
  assert.throws(() => parseSteamLinksInteraction(command([{ type: 1, name: 'send' }])), invalid);
  assert.equal(ownsSteamLinksInteraction({ type: 3, data: { custom_id: 'nbsteam:bad' } }), true);
  assert.equal(parseSteamLinksInteraction({ type: 2, data: { name: 'newwipe' } }), null);
});

test('components and modals enforce action type, exact token, singleton fields and page bounds', () => {
  const custom = steamLinksCustomId('submit', token);
  const event = { type: 5, data: { custom_id: custom, components: [{ type: 18, component: { type: 4, custom_id: 'identifier', value: ` ${id} ` } }] } };
  assert.equal(parseSteamLinksInteraction(event).values.identifier, id);
  assert.throws(() => parseSteamLinksInteraction({ ...event, type: 3 }), invalid);
  assert.throws(() => parseSteamLinksInteraction({ ...event, data: { ...event.data, components: [...event.data.components, ...event.data.components] } }), invalid);
  for (const action of ['confirm', 'cancel']) assert.equal(parseSteamLinksInteraction({ type: 3,
    data: { custom_id: steamLinksCustomId(action, token), component_type: 2 } }).action, action);
  assert.equal(parseSteamLinksInteraction({ type: 3, data: { custom_id: steamLinksCustomId('page', token, 12), component_type: 2 } }).page, 12);
  assert.throws(() => parseSteamLinksInteraction({ type: 3, data: { custom_id: `nbsteam:page:${token}:5001`, component_type: 2 } }), invalid);
  assert.throws(() => parseSteamLinksInteraction({ type: 3, data: { custom_id: `nbsteam:confirm:${token}:1`, component_type: 2 } }), invalid);
});

test('six languages cover private modal, confirmation, list and errors; unsupported locales fall back to English', () => {
  for (const locale of steamLinksLanguages) {
    const modal = steamLinksModal(token, locale), confirm = steamLinkConfirmation({ token, locale, oldSteamId: id, steamId: '76561198000000002' });
    assert.equal(modal.type, 9); assert.ok(modal.data.title.length <= 45); assert.ok(modal.data.components[0].label.length <= 45);
    assert.equal(confirm.flags, 64); assert.ok(confirm.components[0].components.every(row => row.label.length <= 80));
    assert.notEqual(steamLinksText(locale, 'declaration'), 'declaration');
    assert.notEqual(localizeSteamLinksError(locale, 'STEAM_LINK_SAVE_UNKNOWN'), 'saveUnknown');
  }
  assert.equal(steamLinksText('de', 'saved', { steamId: id }), steamLinksText('en', 'saved', { steamId: id }));
  assert.equal(steamLinksText('zh-TW', 'saved', { steamId: id }), steamLinksText('zh-CN', 'saved', { steamId: id }));
});

test('twenty malicious long display names remain within Discord embed bounds and never emit mentions', () => {
  const rows = Array.from({ length: 20 }, (_, n) => ({ discordId: String(BigInt(user) + BigInt(n)), steamId: id,
    displayName: '<@123>@everyone**[]()'.repeat(100) }));
  const payload = renderSteamLinksList({ rows, mode: 'all', page: 0, token, locale: 'en', fetchedAt: '2026-10-15T12:00:00.000Z' });
  assert.equal(payload.flags, 64); assert.equal(payload.embeds[0].description.split('\n').length, 20);
  assert.ok(payload.embeds[0].description.length <= 4096);
  assert.doesNotMatch(JSON.stringify(payload), /<@|@everyone|@here/);
  assert.deepEqual(payload.allowed_mentions, { parse: [], roles: [], users: [], replied_user: false });
});
