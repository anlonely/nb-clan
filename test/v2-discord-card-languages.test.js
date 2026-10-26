import test from 'node:test';
import assert from 'node:assert/strict';
import { discordWelcomeGuideDetails, discordWelcomeGuidePayload } from '../server/v2/platform-admin/welcome-guide-card.js';
import { electricianCardDetails, discordElectricianPayload } from '../server/v2/platform-admin/electrician-card.js';
import { serverConnectDetails, discordServerConnectPayload } from '../server/v2/platform-admin/server-connect-card.js';
import { discordWipeNoticePayload } from '../server/v2/platform-admin/wipe-notice-card.js';
import { rankingLabel, rankingResult, jobResult, mapLines, mapResult, localizeResult } from '../server/v2/platform-admin/results.js';
import { electricianTarget } from '../public/guides/electricians.js';

const languages = ['zh-CN', 'en', 'ru', 'tr', 'th', 'ko'];
const target = { id: 'live-target', guildId: '1554983512321425488', electricianChannelId: '1554985842970468423',
  serverConnectChannelId: '1554985844702584932', welcomeGuideChannelId: '1554985837962207302' };
const signup = { id: 'signup-target', guildId: target.guildId, signupCardChannelId: '1554985845000000001', enabled: true };
const wipe = { id: 'wipe-one', title: '用户自定义月服名称', lifecycle: 'active', signupWindow: 'open',
  serverScheduledWipeAt: '2026-10-01T18:00:00Z', signupClosesAt: '2026-10-02T18:00:00Z',
  serverSnapshot: { name: 'Original 服务器名', connectCommand: 'client.connect rust.example:28015', mapLink: 'https://rustmaps.com/map/42' } };
const configuration = mode => ({ targets: [signup], commands: [{ id: 'wipe', signupMode: mode }] });
const resolved = { china: [{ name: 'User name', url: 'https://steamcommunity.com/profiles/76561198000000001/' }], foreign: [] };
const noMentions = { parse: [], roles: [], users: [], replied_user: false };

function assertNativeLimits(payload) {
  assert.deepEqual(payload.allowed_mentions, noMentions);
  let textLength = 0;
  for (const embed of payload.embeds) {
    assert.ok(embed.title.length <= 256); assert.ok((embed.description || '').length <= 4096);
    textLength += embed.title.length + (embed.description || '').length + (embed.footer?.text || '').length;
    for (const field of embed.fields || []) {
      assert.ok(field.name.length > 0 && field.name.length <= 256);
      assert.ok(field.value.length > 0 && field.value.length <= 1024);
      textLength += field.name.length + field.value.length;
    }
  }
  assert.ok(textLength <= 6000);
  for (const row of payload.components) {
    assert.ok(row.components.length <= 5);
    for (const button of row.components) {
      assert.ok(button.label.length > 0 && button.label.length <= 80);
      assert.equal(button.style, 5); const url = new URL(button.url); assert.equal(url.protocol, 'https:');
      assert.ok(!button.url.includes('undefined')); assert.ok(!button.url.includes('null'));
    }
  }
  assert.ok(!JSON.stringify(payload).includes('{channel}'));
  assert.ok(!JSON.stringify(payload).includes('{count}'));
}

test('all four Discord card templates have complete distinct six-language fixed text, safe links and native limits', () => {
  const titles = Array.from({ length: 4 }, () => new Set());
  for (const language of languages) {
    const welcomeDetails = discordWelcomeGuideDetails(target, language);
    const welcome = discordWelcomeGuidePayload(welcomeDetails, language);
    const electricians = discordElectricianPayload(electricianCardDetails({}, target, 'discord', resolved, language), language);
    const connection = discordServerConnectPayload(serverConnectDetails(wipe, '203.0.113.8'), language);
    const notice = discordWipeNoticePayload(wipe, target, configuration('discord_only'), signup.id, language);
    for (const [index, payload] of [welcome, electricians, connection, notice].entries()) {
      assertNativeLimits(payload); titles[index].add(payload.embeds[0].title);
      assert.doesNotMatch(JSON.stringify(payload), /Rust Siege Group|NB Clan/u);
    }
    assert.ok(welcome.embeds[0].description.startsWith('Clan Portal · '));
    assert.ok(electricians.embeds[0].footer.text.startsWith('Clan Portal · '));
    assert.ok(notice.embeds[0].description.startsWith('Clan Portal · '));
    assert.ok(notice.embeds[0].footer.text.startsWith('Clan Portal · '));
    assert.equal(new URL(welcomeDetails.bindingUrl).searchParams.get('lang'), language === 'zh-CN' ? 'zh-CN' : 'en');
    const page = new URL(welcomeDetails.electricianProfilesUrl);
    assert.equal(page.pathname, '/guides/electricians.html');
    assert.equal(page.searchParams.has('lang'), false, 'card language must not override browser language');
    assert.equal(electricianTarget(page.search), `platform=discord&guildId=${target.guildId}&channelId=${target.electricianChannelId}`);
    assert.equal(welcomeDetails.electricianTutorialUrl, `${welcomeDetails.electricianProfilesUrl}#tutorial`);
    assert.equal(connection.embeds[0].description, `${wipe.title}\n${wipe.serverSnapshot.name}`);
    assert.equal(connection.embeds[0].fields[0].value, '<t:1790877600:F>');
    assert.ok(connection.embeds[0].fields[1].value.includes(wipe.serverSnapshot.connectCommand));
    assert.ok(connection.embeds[0].fields[2].value.includes('client.connect 203.0.113.8:28015'));
    assert.ok(notice.embeds[0].title.endsWith(wipe.title));
    const untitledNotice = discordWipeNoticePayload({ ...wipe, title: '', serverSnapshot: {} }, target, configuration('discord_only'), signup.id, language);
    assert.ok(untitledNotice.embeds[0].title.endsWith('Clan Portal'));
    assert.equal(notice.embeds[0].fields[0].value, wipe.serverSnapshot.name);
    assert.ok(!JSON.stringify(electricians).includes('User name'));
  }
  for (const values of titles) assert.equal(values.size, 6);
});

test('Discord renderer defaults and unsupported locales fall back to English; supported regional locales match their language', () => {
  const renderers = [language => discordWelcomeGuidePayload(discordWelcomeGuideDetails(target, language), language),
    language => discordElectricianPayload(electricianCardDetails({}, target, 'discord', resolved, language), language),
    language => discordServerConnectPayload(serverConnectDetails(wipe), language),
    language => discordWipeNoticePayload(wipe, target, configuration('member_required'), signup.id, language)];
  for (const renderer of renderers) {
    assert.deepEqual(renderer(), renderer('en'));
    for (const locale of ['fr', 'de-DE', '', 'bad_locale', null]) assert.deepEqual(renderer(locale), renderer('en'));
    for (const [locale, language] of [['zh-TW', 'zh-CN'], ['ru-RU', 'ru'], ['tr-TR', 'tr'], ['th-TH', 'th'], ['ko-KR', 'ko']]) {
      assert.deepEqual(renderer(locale), renderer(language));
    }
  }
});

test('all wipe modes, terminal states and missing optional destinations retain accurate six-language notices', () => {
  for (const language of languages) {
    const linked = discordWipeNoticePayload(wipe, target, configuration('member_required'), signup.id, language);
    const direct = discordWipeNoticePayload(wipe, target, configuration('discord_only'), signup.id, language);
    assert.notEqual(linked.embeds[0].fields[3].value, direct.embeds[0].fields[3].value);
    for (const lifecycle of ['ended', 'archived', 'cancelled']) {
      const closed = discordWipeNoticePayload({ ...wipe, lifecycle }, { guildId: target.guildId }, configuration('discord_only'), signup.id, language);
      assertNativeLimits(closed); assert.equal(closed.components[0].components.length, 2);
      assert.notEqual(closed.embeds[0].description, direct.embeds[0].description);
      assert.equal(closed.embeds[0].color, 0x95a5a6);
    }
    assert.equal(discordWipeNoticePayload(wipe, target, configuration('discord_only'), 'missing', language), null);
  }
});

test('results localize every fixed metric and status while preserving user values and default Chinese contracts', () => {
  const row = { memberId: 'member-1', displayName: '击杀 Query failed 用户昵称', values: { kills: 42, deaths: 3, kd: 14, sulfur: 1234, privateExtra: 'must not be copied' } };
  assert.equal(rankingLabel(row), '击杀 Query failed 用户昵称 · 42 击杀 · 3 死亡');
  const metricNames = ['kills', 'deaths', 'assists', 'kd', 'kda', 't3Kills', 'rockets', 'sulfur', 'metalOre', 'building', 'onlineSeconds', 'playTimeSeconds'];
  for (const language of languages) {
    for (const selected of metricNames) {
      const result = rankingResult({ items: [row] }, selected, language), label = result.items[0].label;
      assert.ok(label.startsWith(`${row.displayName} · `)); assert.ok(!label.includes('undefined'));
      assert.ok(!JSON.stringify(result).includes('must not be copied'));
      assert.ok(Object.keys(result.items[0].presentation.values).length <= 3);
    }
    for (const state of ['succeeded', 'failed', 'queued', 'running', 'cancelled', 'partial', 'skipped', 'unknown']) {
      const result = jobResult({ id: 'query-id', status: state, result: { errorCode: 'SOURCE_TIMEOUT' } }, language);
      assert.equal(result.state, state); assert.ok(result.items[0].label.length > 0);
      assert.equal(result.errorCode, state === 'failed' ? 'SOURCE_TIMEOUT' : null);
    }
    assert.deepEqual(mapLines(wipe, language), mapLines(wipe));
    assert.deepEqual(mapResult(wipe, language), mapResult(wipe));
    assert.deepEqual(rankingResult({ items: [row] }, 'kills', 'fr'), rankingResult({ items: [row] }, 'kills', 'en'));
  }
});

test('new query receipts can be re-localized without translating names or leaking undisplayed row data', () => {
  const row = { memberId: 'one', displayName: '任务已排队，尚未完成', values: { kills: 12, deaths: 2, sulfur: 350, internal: 'private' } };
  const initial = rankingResult({ items: [row] }, 'sulfur', 'zh-CN');
  for (const language of languages) {
    assert.deepEqual(localizeResult(initial, language), rankingResult({ items: [row] }, 'sulfur', language));
    const queued = jobResult({ id: 'job', status: 'queued' }, 'zh-CN');
    assert.deepEqual(localizeResult(queued, language), jobResult({ id: 'job', status: 'queued' }, language));
  }
  assert.deepEqual(localizeResult({ items: [{ id: 'legacy', label: row.displayName }] }, 'en'), { items: [{ id: 'legacy', label: row.displayName }] });
  assert.ok(!JSON.stringify(initial).includes('private'));
});
