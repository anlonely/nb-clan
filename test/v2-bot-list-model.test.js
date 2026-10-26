import test from 'node:test';
import assert from 'node:assert/strict';
import {botDetailPath, botListPath, botListReturnPath, botSectionPath, canCreateBotConfig} from '../src/v2/bot-admin/list-model.js';

test('Bot section navigation keeps only a valid platform, never a target or list filter', () => {
  for (const section of ['features', 'servers', 'open-signups', 'electricians', 'tools', 'activity']) {
    assert.equal(botSectionPath(section, 'discord'), `/admin/bot/${section}?platform=discord`);
    assert.equal(botSectionPath(section, 'kook'), `/admin/bot/${section}?platform=kook`);
    assert.equal(botSectionPath(section, 'unknown'), `/admin/bot/${section}`);
  }
});

test('returning from a feature preserves the original all-platform search and type', () => {
  const source = new URLSearchParams({search: 'wipe + card', type: 'event_command'});
  const detail = new URL(botDetailPath('features', source, 'discord', {id: 'newwipe'}), 'https://local.invalid');
  assert.equal(detail.pathname, '/admin/bot/features/newwipe');
  assert.equal(detail.searchParams.get('platform'), 'discord');
  assert.equal(botListReturnPath('features', detail.searchParams), botListPath('features', source));
  const selected = new URL(botDetailPath('features', detail.searchParams, 'discord', {id: 'wipe'}), 'https://local.invalid');
  assert.equal(botListReturnPath('features', selected.searchParams), botListPath('features', source));
});

test('server detail keeps independent binding IDs and the filtered return list', () => {
  const source = new URLSearchParams({platform: 'kook', feature: 'wipe', search: 'Community'});
  const first = new URL(botDetailPath('servers', source, 'kook', {id: 'binding-one', guildId: 'same-guild'}), 'https://local.invalid');
  const second = new URL(botDetailPath('servers', source, 'kook', {id: 'binding-two', guildId: 'same-guild'}), 'https://local.invalid');
  assert.equal(first.pathname, second.pathname);
  assert.notEqual(first.searchParams.get('targetId'), second.searchParams.get('targetId'));
  assert.equal(botListReturnPath('servers', second.searchParams), botListPath('servers', source));
  assert.equal(new URL(botListReturnPath('servers', second.searchParams), 'https://local.invalid').searchParams.has('targetId'), false);
});

test('list return routes reject external, nested, or cross-section destinations', () => {
  for (const returnTo of ['https://example.com', '//example.com', '/admin/bot/features/new', '/admin/bot/servers?platform=kook', '/admin/bot/features#target']) {
    assert.equal(botListReturnPath('features', new URLSearchParams({platform: 'discord', search: 'kda', returnTo})), '/admin/bot/features?platform=discord&search=kda');
  }
  assert.equal(botListReturnPath('features', new URLSearchParams({returnTo: '/admin/bot/features?platform=invalid&targetId=production&search=map'})), '/admin/bot/features?search=map');
});

test('new configuration requires explicit configure permission and available capacity', () => {
  for (const data of [undefined, {}, {canConfigure: false}, {canConfigure: 'true'}]) assert.equal(canCreateBotConfig(data, 'features'), false);
  assert.equal(canCreateBotConfig({canConfigure: true, commands: []}, 'features'), true);
  assert.equal(canCreateBotConfig({canConfigure: true, commands: Array(30).fill({})}, 'features'), false);
  assert.equal(canCreateBotConfig({canConfigure: true, targets: Array(30).fill({})}, 'servers'), false);
  assert.equal(canCreateBotConfig({canConfigure: true, targets: Array(29).fill({})}, 'servers'), true);
});
