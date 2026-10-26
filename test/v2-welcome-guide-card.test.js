import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeConfig } from '../server/v2/platform-admin/model.js';
import { WELCOME_GUIDE_COMMAND_ID, welcomeGuideDetails, welcomeGuidePayload, welcomeGuideTargetId, discordWelcomeGuideDetails, discordWelcomeGuidePayload } from '../server/v2/platform-admin/welcome-guide-card.js';
import { electricianTarget } from '../public/guides/electricians.js';

test('announcement guide keeps its own channel and renders separated instructions and links', () => {
  const target = { id: 'default', name: 'RSG', guildId: '8900601550851301', channelId: '6359280321479117',
    welcomeGuideChannelId: '9822515775347106', electricianChannelId: '1630990274298012', serverConnectChannelId: '1519025655672112',
    enabled: true, enabledCommandIds: [WELCOME_GUIDE_COMMAND_ID] };
  const config = normalizeConfig('kook', { enabled: true, targets: [target],
    commands: [{ id: WELCOME_GUIDE_COMMAND_ID, name: '开荒须知卡片', type: 'persistent_card', enabled: true }] });
  assert.equal(config.targets[0].welcomeGuideChannelId, '9822515775347106');
  assert.match(welcomeGuideTargetId('default'), /^welcome_guide_[a-f0-9]{24}$/);
  const details = welcomeGuideDetails(target);
  assert.equal(details.bindingUrl, 'https://clan.example.com/login?returnTo=%2Fapp%2Fme');
  assert.equal(details.tutorialUrl, 'https://clan.example.com/guides/kook-steam-binding.html?v=binding-hq-2');
  assert.equal(details.electricianProfilesUrl, 'https://clan.example.com/guides/electricians.html?guildId=8900601550851301&channelId=1630990274298012');
  assert.equal(details.electricianTutorialUrl, `${details.electricianProfilesUrl}#tutorial`);
  const payload = welcomeGuidePayload(target.welcomeGuideChannelId, details);
  assert.equal(payload.target_id, '9822515775347106');
  const card = JSON.parse(payload.content)[0];
  assert.deepEqual(card.modules[1].elements, [{ type: 'plain-text', content: 'Clan Portal · 开荒须知' }]);
  assert.doesNotMatch(payload.content, /Rust Siege Group|NB Clan/u);
  assert.ok(card.modules.length <= 50);
  const headings = card.modules.filter(module => module.type === 'header').map(module => module.text.content);
  assert.deepEqual(headings.slice(1), ['⚡ 第一件事：绑定 KOOK & Steam', '⚡ 第二件事：加电工 ID', '⚡ 第三件事：服务器 IP 和地图', '❌ 开荒注意']);
  const bindingIndex = card.modules.findIndex(module => module.text?.content === '前往战队网站，使用 **KOOK 登录**，再按页面提示完成 **Steam 验证**。');
  assert.equal(card.modules[bindingIndex + 1]?.text?.content, '⚠️登录Steam账号需要加速Steam商店或者开启VPN');
  assert.deepEqual(card.modules[bindingIndex + 2]?.elements?.map(button => button.text.content), ['前往网页绑定', '查看教程']);
  const groups = card.modules.filter(module => module.type === 'action-group');
  assert.deepEqual(groups[1].elements.map(button => button.text.content), ['前往添加电工Steam好友', '查看教程']);
  assert.ok(card.modules.some(module => module.text?.content === '点击前往添加电工Steam好友按钮，根据教程添加全部电工Steam好友。'));
  assert.doesNotMatch(payload.content, /查看 #电工ID/);
  assert.ok(groups.every(group => group.elements.length <= 4));
  const buttons = groups.flatMap(module => module.elements);
  assert.deepEqual(buttons.map(button => button.value), [details.bindingUrl, details.tutorialUrl, details.electricianProfilesUrl, details.electricianTutorialUrl, details.serverUrl]);
  assert.ok(buttons.every(button => button.click === 'link'));
  assert.ok(card.modules.some(module => module.text?.content === '• 禁止收主家的床\n• 禁止拍床在出入口上下楼位置\n• 不要随便清队友包\n• 抄家炮楼没成型前不要进去'));
  assert.doesNotMatch(payload.content, /\(met\)all\(met\)|@everyone|@全体成员/);
  assert.equal(welcomeGuideDetails({ ...target, electricianChannelId: 'https://evil.example' }), null);
});

test('Discord announcement guide links to Discord registration and configured channels in English', () => {
  const target = { guildId: '1153571748147634236', electricianChannelId: '1482399564274204774', serverConnectChannelId: '1482399564274204775' };
  assert.notEqual(welcomeGuideTargetId('default', 'discord'), welcomeGuideTargetId('default'));
  const details = discordWelcomeGuideDetails(target);
  const payload = discordWelcomeGuidePayload(details);
  assert.equal(details.bindingUrl, 'https://clan.example.com/login?lang=en&returnTo=%2Fapp%2Fme');
  assert.equal(details.serverUrl, 'https://discord.com/channels/1153571748147634236/1482399564274204775');
  const profiles = new URL(details.electricianProfilesUrl);
  assert.equal(profiles.pathname, '/guides/electricians.html');
  assert.equal(electricianTarget(profiles.search), 'platform=discord&guildId=1153571748147634236&channelId=1482399564274204774');
  assert.equal(details.electricianTutorialUrl, `${details.electricianProfilesUrl}#tutorial`);
  const otherTarget = { ...target, guildId: '1554983512321425488', electricianChannelId: '1554985842970468423' };
  const otherProfiles = new URL(discordWelcomeGuideDetails(otherTarget).electricianProfilesUrl);
  assert.equal(otherProfiles.searchParams.get('guildId'), otherTarget.guildId);
  assert.equal(otherProfiles.searchParams.get('channelId'), otherTarget.electricianChannelId);
  assert.match(payload.embeds[0].title, /Before the Wipe/u);
  assert.deepEqual(payload.components.flatMap(row => row.components).map(button => button.url), [details.bindingUrl, details.tutorialUrl, details.electricianProfilesUrl, details.electricianTutorialUrl, details.serverUrl]);
  assert.deepEqual(payload.allowed_mentions, { parse: [], roles: [], users: [], replied_user: false });
  assert.doesNotMatch(JSON.stringify(payload), /KOOK|kookapp|@everyone/u);
  assert.equal(discordWelcomeGuideDetails({ ...target, serverConnectChannelId: 'https://evil.example' }), null);
});
