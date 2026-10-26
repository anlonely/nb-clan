import test from 'node:test';
import assert from 'node:assert/strict';
import { buildDiscordAttendanceMessage, renderDiscordTemplate, discordVipSummaryLine,
  discordVitalVipSummaryValue, discordVitalVipUpdatedInteraction, buildDiscordVitalVipReminderMessage } from '../server/api.js';
import { discordExpiryTimestamp } from '../server/v2/notification-platforms/discord-time.js';

const wipe = {
  id: 'wipe-local-time', serverName: 'Atlas US 2X', name: 'Weekly wipe',
  startedAt: '2026-09-27T20:00:00+08:00', nextWipeAt: '2026-10-04T20:00:00+08:00'
};
const start = `<t:${Date.parse(wipe.startedAt) / 1000}:F>`;
const next = `<t:${Date.parse(wipe.nextWipeAt) / 1000}:F>`;
const options = { language: 'en', createdAt: '2026-09-26T12:00:00Z', mentionEveryone: false };

test('legacy Discord system time placeholders become native timestamps without changing literal text', () => {
  const literal = 'Announcement written 2026-09-27 20:00 UTC+8';
  assert.equal(renderDiscordTemplate(`${literal}\n{startedAt} → {nextWipeAt}`, wipe), `${literal}\n${start} → ${next}`);
  assert.equal(renderDiscordTemplate('{startedAt} / {nextWipeAt}', { startedAt: '2026-09-27T20:00', nextWipeAt: 'invalid' }), ' / ');
});

test('legacy custom title times move into the description, preserving both instants', () => {
  const message = buildDiscordAttendanceMessage(wipe, {
    templateTitle: '{serverName} · {startedAt} → {nextWipeAt}',
    templateBody: '{body}\nStart: {startedAt}\nNext: {nextWipeAt}'
  }, options);
  const embed = message.embeds[0];
  assert.equal(embed.title, wipe.serverName);
  assert.ok(embed.description.startsWith(`${wipe.serverName} · ${start} → ${next}\n\n`));
  assert.ok(embed.description.includes(`Start: ${start}\nNext: ${next}`));
  assert.doesNotMatch(embed.title, /<t:|2026-/);
  assert.doesNotMatch(embed.description, /2026-|UTC\+8/);
  assert.equal(embed.timestamp, options.createdAt);
  assert.deepEqual(message.allowed_mentions, { parse: [] });
});

test('a title using attendance date, time and signup-window placeholders is rendered in the description', () => {
  const embed = buildDiscordAttendanceMessage(wipe, {
    templateTitle: 'WIPE {wipeDate} {wipeTime} · {signupWindow}', templateBody: '{body}'
  }, options).embeds[0];
  assert.equal(embed.title, wipe.serverName);
  assert.ok(embed.description.startsWith(`WIPE ${start} <t:${Date.parse(wipe.startedAt) / 1000}:t> · <t:`));
  assert.doesNotMatch(embed.description, /\{(?:wipeDate|wipeTime|signupWindow)\}/);
});

test('ordinary titles, user prose and default attendance timestamps remain intact', () => {
  const literalTitle = 'Atlas · 2026-09-27 20:00';
  const custom = buildDiscordAttendanceMessage(wipe, {
    templateTitle: literalTitle, templateBody: '{body}\nManual note: 2026-09-27 20:00 UTC+8'
  }, options).embeds[0];
  assert.equal(custom.title, literalTitle);
  assert.ok(custom.description.includes('Manual note: 2026-09-27 20:00 UTC+8'));
  const defaultCard = buildDiscordAttendanceMessage(wipe, {}, options).embeds[0];
  assert.equal(defaultCard.title, wipe.serverName);
  assert.ok(defaultCard.description.includes(start));
  assert.ok(defaultCard.description.includes(`<t:${Date.parse(wipe.startedAt) / 1000}:t>`));
});

test('VIP expiry dates represent the first instant after the inclusive UTC+8 business day', () => {
  const expected = `<t:${Date.parse('2099-12-31T16:00:00Z') / 1000}:F>`;
  assert.equal(discordExpiryTimestamp('2099-12-31'), expected);
  assert.equal(discordExpiryTimestamp('2100-01-01T00:00:00+08:00'), expected);
  assert.equal(discordExpiryTimestamp('2028-02-29'), `<t:${Date.parse('2028-02-29T16:00:00Z') / 1000}:F>`);
  for (const invalid of ['2100-02-29', '2099-02-30', '2099-12-31T16:00', '', null, '<t:123:F>']) {
    assert.equal(discordExpiryTimestamp(invalid), '');
  }
});

test('legacy Discord provider summaries localize expiry while preserving the purchase business date', () => {
  const expected = `<t:${Date.parse('2099-12-31T16:00:00Z') / 1000}:F>`;
  for (const provider of ['vital', 'rustinity', 'atlas']) {
    const member = { [`${provider}VipType`]: 'queue_skip', [`${provider}VipPurchasedAt`]: '2099-12-03',
      [`${provider}VipExpiresAt`]: '2099-12-31' };
    const summary = discordVipSummaryLine(provider, member, 'en');
    assert.ok(summary.includes('Purchase 12-03'));
    assert.ok(summary.includes(`Expiry ${expected}`));
    assert.doesNotMatch(summary, /Expiry 12-31/);
  }
});

test('legacy review fields, expiry reminder and update reply use the same expiry instant', () => {
  const member = { vitalVipType: 'queue_skip', vitalVipPurchasedAt: '2099-12-03', vitalVipExpiresAt: '2099-12-31' };
  const expected = `<t:${Date.parse('2099-12-31T16:00:00Z') / 1000}:F>`;
  const summary = discordVitalVipSummaryValue(member, 'en');
  assert.ok(summary.includes('Purchase: 12-03'));
  assert.ok(summary.includes(`Expiry: ${expected}`));
  const reminder = buildDiscordVitalVipReminderMessage(member, 'en');
  assert.ok(reminder.embeds[0].description.includes(expected));
  assert.doesNotMatch(reminder.embeds[0].title, /<t:/);
  assert.deepEqual(reminder.allowed_mentions, { parse: [] });
  const reply = discordVitalVipUpdatedInteraction({ type: 'queue_skip', purchasedAt: '2099-12-03', expiresAt: '2099-12-31' }, 'en');
  assert.ok(reply.data.content.includes('Purchase 12-03'));
  assert.ok(reply.data.content.includes(`Expiry ${expected}`));
  assert.equal(reply.data.flags, 64);
});
