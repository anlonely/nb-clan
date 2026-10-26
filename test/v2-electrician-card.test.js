import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeConfig } from '../server/v2/platform-admin/model.js';
import { ELECTRICIAN_COMMAND_ID, electricianDetails, electricianCardDetails, electricianProfilesUrl, electricianPayload, discordElectricianPayload, electricianTargetId } from '../server/v2/platform-admin/electrician-card.js';
import { DEFAULT_CHINA_ELECTRICIANS, DEFAULT_FOREIGN_ELECTRICIANS } from '../shared/electrician-defaults.js';

const command = { id: ELECTRICIAN_COMMAND_ID, name: '电工 ID 卡片', type: 'persistent_card', enabled: true,
  electriciansCn: Array.from({length:6},(_,i)=>`CN Fixture ${i} | https://steamcommunity.com/profiles/${76561198000001000n+BigInt(i)}/`).join('\n'), electriciansForeign: Array.from({length:4},(_,i)=>`EU Fixture ${i} | https://steamcommunity.com/profiles/${76561198000002000n+BigInt(i)}/`).join('\n') };
const target = { id: 'rsg', name: 'RSG', guildId: '8900601550851301', channelId: '6359280321479117',
  electricianChannelId: '1630990274298012', enabled: true, enabledCommandIds: [ELECTRICIAN_COMMAND_ID] };

test('electrician card keeps the guide buttons and public group counts without individual profiles', () => {
  const config = normalizeConfig('kook', { enabled: true,
    targets: [target],
    commands: [command] });
  assert.equal(config.targets[0].electricianChannelId, target.electricianChannelId);
  assert.match(electricianTargetId('rsg'), /^electrician_[a-f0-9]{24}$/);
  const details = electricianCardDetails(config.commands[0], config.targets[0]);
  assert.equal(details.china.length, 6);
  assert.equal(details.foreign.length, 4);
  const expectedUrl = 'https://clan.example.com/guides/electricians.html?guildId=8900601550851301&channelId=1630990274298012';
  assert.equal(details.profilesUrl, expectedUrl);
  assert.equal(details.tutorialUrl, `${expectedUrl}#tutorial`);
  const payload = electricianPayload(target.electricianChannelId, details);
  assert.equal(payload.target_id, target.electricianChannelId);
  const modules = JSON.parse(payload.content)[0].modules;
  assert.equal(modules[1].text.type, 'kmarkdown');
  assert.match(modules[1].text.content, /全部电工/);
  assert.equal(modules[2].type, 'action-group');
  assert.deepEqual(modules[2].elements.map(button => [button.text.content, button.click, button.value]), [
    ['前往添加电工Steam好友', 'link', expectedUrl], ['查看教程', 'link', `${expectedUrl}#tutorial`],
  ]);
  assert.equal(modules.length, 4);
  assert.deepEqual(modules[3].elements, [{ type: 'plain-text', content: '电工名单：CN电工 6 位 · EU电工 4 位' }]);
  assert.doesNotMatch(payload.content, /steamcommunity\.com/);
  assert.doesNotMatch(payload.content, /\(met\)all\(met\)/);
  assert.deepEqual(electricianDetails(command), { china: details.china, foreign: details.foreign });
  for (const invalid of [{ ...target, guildId: 'bad' }, { ...target, electricianChannelId: '' }, { ...target, electricianChannelId: '123456789' }]) {
    assert.equal(electricianCardDetails(command, invalid), null);
  }
});

test('reject malformed or unsafe Steam links before saving', () => {
  for (const bad of ['娜娜 | https://example.com/profiles/76561198302105600/', '娜娜 | https://steamcommunity.com.evil.test/id/name/',
    '娜娜 | https://steamcommunity.com/id/name/?x=1', '娜娜 | https://steamcommunity.com/id/name/\n(x) | https://steamcommunity.com/id/name/']) {
    assert.equal(electricianDetails({ ...command, electriciansCn: bad }), null);
    for (const platform of ['kook', 'discord']) assert.throws(() => normalizeConfig(platform, { enabled: true, targets: [], commands: [{ ...command, electriciansCn: bad }] }), /ELECTRICIAN_LIST_INVALID/);
  }
});

test('shared roster cards do not need a duplicate platform list', () => {
  const sharedCommand = { id: ELECTRICIAN_COMMAND_ID, name: 'Electricians', type: 'persistent_card', enabled: true };
  const resolved = { china: [{ name: 'From shared roster', url: 'https://steamcommunity.com/id/shared-electrician/' }], foreign: [] };
  for (const platform of ['discord', 'kook']) {
    const config = normalizeConfig(platform, { enabled: true, targets: [target], commands: [sharedCommand] });
    assert.deepEqual(electricianCardDetails(config.commands[0], target, platform, resolved).china, resolved.china);
    assert.throws(() => normalizeConfig(platform, { commands: [{ ...sharedCommand, type: 'event_card' }] }), /ELECTRICIAN_LIST_INVALID/);
  }
});

test('Discord electrician links use the configured Discord target and browser language page', () => {
  const discordTarget = { ...target, guildId: '1554983512321425488', electricianChannelId: '1554985842970468423' };
  const config = normalizeConfig('discord', { enabled: true, targets: [discordTarget], commands: [command] });
  const details = electricianCardDetails(config.commands[0], config.targets[0], 'discord');
  const url = new URL(details.profilesUrl);
  assert.equal(url.pathname, '/guides/electricians.html');
  assert.equal(url.search, '?platform=discord&guildId=1554983512321425488&channelId=1554985842970468423');
  assert.equal(details.tutorialUrl, `${details.profilesUrl}#tutorial`);
  const card = discordElectricianPayload(details);
  assert.equal(card.embeds[0].title, '⚡ Electricians’ Steam IDs');
  assert.deepEqual(card.components[0].components.map(button => [button.type, button.style, button.label, button.url]), [
    [2, 5, 'Add Electricians on Steam', details.profilesUrl], [2, 5, 'Friend Tutorial', details.tutorialUrl]
  ]);
  assert.deepEqual(card.allowed_mentions, { parse: [], roles: [], users: [], replied_user: false });
  assert.match(card.embeds[0].footer.text, /Clan Portal/);
  assert.deepEqual(card.embeds[0].fields.map(row=>row.value), ['6 electricians','4 electricians']);
  assert.doesNotMatch(JSON.stringify(card), /steamcommunity\.com/);
  assert.doesNotMatch(JSON.stringify(card), /8900601550851301|1630990274298012|@everyone|\(met\)/);
  assert.notEqual(electricianProfilesUrl({ ...discordTarget, electricianChannelId: '1554985842970468424' }, 'discord'), details.profilesUrl);
});

test('target identities preserve the original KOOK default and exact existing Discord card slot', () => {
  assert.equal(electricianTargetId('rsg'), electricianTargetId('rsg', 'kook'));
  assert.notEqual(electricianTargetId('rsg'), electricianTargetId('rsg', 'discord'));
  assert.equal(electricianTargetId('target_mqgthnqsxw9euy', 'discord'), 'electrician_473cab76112304b892b1cc29');
  for (const platform of ['discord', 'kook']) {
    for (const invalid of [{ ...target, guildId: '' }, { ...target, electricianChannelId: 'invalid' }]) {
      assert.equal(electricianProfilesUrl(invalid, platform), null);
      assert.equal(electricianCardDetails(command, invalid, platform), null);
    }
    assert.equal(electricianCardDetails({ id: ELECTRICIAN_COMMAND_ID, name: 'Electricians', type: 'persistent_card', enabled: true }, target, platform), null);
  }
  assert.equal(electricianProfilesUrl(target, 'bridge'), null);
});

test('a fresh installation has no preconfigured electrician identities', () => {
  assert.equal(DEFAULT_CHINA_ELECTRICIANS, '');
  assert.equal(DEFAULT_FOREIGN_ELECTRICIANS, '');
  assert.equal(electricianDetails({ electriciansCn: '', electriciansForeign: '' }), null);
  const config = normalizeConfig('discord', { enabled: false, targets: [], commands: [] });
  assert.deepEqual(config.commands, []);
  assert.equal(config.enabled, false);
});
