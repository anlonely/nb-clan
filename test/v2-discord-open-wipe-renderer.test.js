import assert from 'node:assert/strict';
import test from 'node:test';
import { renderOpenWipeCard, openWipeResponses, openWipeSignupReply } from '../server/v2/discord-open-wipe/renderer.js';
import { OPEN_WIPE_LANGUAGES, text } from '../server/v2/discord-open-wipe/interaction-ui.js';
import { parseOpenWipeInteraction } from '../server/v2/discord-open-wipe/interaction-input.js';

const token = 'a'.repeat(43);
const settings = {
  serverName: 'Vital Rust 2X EU Medium', wipeAt: '2026-10-15T16:00:00Z', timeZone: 'Europe/London',
  adaptiveDisplay: true, notes: 'Bring tools.', directConnect: 'client.connect eu-medium.vitalrust.com:28014',
  resolvedIp: '168.100.161.200',
};
const row = (response, index) => ({ response, discordId: String(1177000000000000000n + BigInt(index)), name: `Member ${index}` });

test('public and private cards expose exactly Accepted, Declined, Late and settings', () => {
  for (const privateView of [false, true]) {
    const card = renderOpenWipeCard({ settings, token, privateView });
    assert.equal(card.components.length, 1);
    const buttons = card.components.flatMap(actionRow => actionRow.components);
    assert.deepEqual(buttons.slice(0, 3).map(button => button.label), ['Accepted', 'Declined', 'Late']);
    assert.equal(buttons[3].label, text('en', 'settings'));
    assert.deepEqual(buttons.map(button => parseOpenWipeInteraction({ type: 3, data: { component_type: 2, custom_id: button.custom_id } }).action),
      ['signup_on_time', 'signup_absent', 'signup_late', 'settings']);
    assert.deepEqual(card.embeds[0].fields.slice(-3).map(field => field.name), ['Accepted · 0', 'Declined · 0', 'Late · 0']);
    assert.equal(card.embeds[0].description, '[**Clan Portal**](https://clan.example.com/app/home)\n\nBring tools.');
    assert.ok(card.embeds[0].fields.some(field => field.value === '`client.connect eu-medium.vitalrust.com:28014`'));
    assert.ok(card.embeds[0].fields.some(field => field.value === '`client.connect 168.100.161.200:28014`'));
  }
});

test('old delayed signups merge into Late without mutating saved responses or losing profile links', () => {
  const responses = ['on_time', 'absent', 'late', 'late_8h', 'late_16h', 'delayed_8h', 'delayed_16h'];
  const signups = responses.map(row), before = structuredClone(signups);
  const groups = renderOpenWipeCard({ settings, token, signups }).embeds[0].fields.slice(-3);
  assert.deepEqual(groups.map(group => group.name), ['Accepted · 1', 'Declined · 1', 'Late · 5']);
  for (const [index, response] of responses.entries()) {
    const group = groups[index < 2 ? index : 2];
    assert.ok(group.value.includes(`[Member ${index}](https://discord.com/users/${signups[index].discordId})`), response);
  }
  assert.deepEqual(signups, before);
  assert.equal(openWipeResponses.signup_late, 'late');
  assert.equal(openWipeResponses.signup_8h, 'late_8h');
  assert.equal(openWipeResponses.signup_16h, 'late_16h');
});

test('six client languages and fallback localize single-sentence confirmations while shared cards stay English', () => {
  for (const locale of [...OPEN_WIPE_LANGUAGES, 'zh-TW', 'en-US', 'de', undefined]) {
    const privateCard = renderOpenWipeCard({ settings, token, privateView: true, locale });
    const labels = ['signupOnTime', 'signupAbsent', 'signupLate', 'settings'].map(key => text(locale, key));
    assert.deepEqual(privateCard.components[0].components.map(button => button.label), labels);
    assert.deepEqual(privateCard.embeds[0].fields.slice(-3).map(field => field.name), labels.slice(0, 3).map(label => `${label} · 0`));
    assert.equal(privateCard.embeds[0].description, '[**Clan Portal**](https://clan.example.com/app/home)\n\nBring tools.');
    const sharedCard = renderOpenWipeCard({ settings, token, locale, publisherLocale: locale });
    assert.deepEqual(sharedCard.components[0].components.slice(0, 3).map(button => button.label), ['Accepted', 'Declined', 'Late']);
    for (const [index, response] of ['on_time', 'absent', 'late', 'late_8h', 'late_16h'].entries()) {
      const reply = openWipeSignupReply({ ...settings, adaptiveDisplay: false }, response, locale);
      assert.ok(reply.content.includes(`${['✅', '❌', '🕒'][Math.min(index, 2)]} ${labels[Math.min(index, 2)]}`));
      assert.ok(reply.content.includes('**Vital Rust 2X EU Medium**'));
      assert.doesNotMatch(reply.content, /[\r\n]|client\.connect|Clan Portal|Wipe time|\{(?:emoji|status|server)\}/);
      assert.deepEqual(reply.embeds, []); assert.deepEqual(reply.components, []);
      assert.deepEqual(reply.allowed_mentions, { parse: [], roles: [], users: [], replied_user: false });
      if (locale === 'de' || locale === undefined) assert.match(reply.content, /^You're currently marked as /);
    }
  }
});

test('crowded merged Late roster preserves counts and stays within Discord embed limits', () => {
  const signups = Array.from({ length: 180 }, (_, index) => ({ ...row(['late', 'late_8h', 'late_16h'][index % 3], index), name: '*'.repeat(80) }));
  const embed = renderOpenWipeCard({ settings: { ...settings, notes: 'n'.repeat(2000) }, token, signups }).embeds[0];
  const late = embed.fields.at(-1);
  assert.equal(late.name, 'Late · 180');
  const shown = late.value.match(/https:\/\/discord\.com\/users\//g).length;
  assert.ok(shown <= 8);
  assert.ok(late.value.endsWith(`+${180 - shown}`));
  assert.ok(embed.fields.every(field => field.value.length <= 1024));
  assert.ok(embed.title.length + embed.description.length + embed.fields.reduce((sum, field) => sum + field.name.length + field.value.length, 0) < 6000);
});
