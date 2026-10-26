import test from 'node:test';
import assert from 'node:assert/strict';
import { discordTimestamp } from '../server/v2/notification-platforms/discord-time.js';

test('Discord timestamps preserve one instant across explicit timezones and DST offsets', () => {
  const instant = '2026-09-24T21:00:00.000Z';
  const expected = `<t:${Date.parse(instant) / 1000}:F>`;
  for (const value of [instant, '2026-09-25T05:00:00+08:00', '2026-09-24T14:00:00-07:00', new Date(instant), Date.parse(instant)]) {
    assert.equal(discordTimestamp(value), expected);
  }
  assert.notEqual(discordTimestamp('2026-11-01T01:30:00-07:00'), discordTimestamp('2026-11-01T01:30:00-08:00'));
  assert.equal(discordTimestamp(0), '<t:0:F>');
  assert.equal(discordTimestamp(1999, 'R'), '<t:1:R>');
});

test('ambiguous, missing, invalid or injected timestamp inputs produce no timestamp', () => {
  for (const value of [null, undefined, '', false, {}, NaN, Infinity, 8.64e15 + 1, new Date(NaN),
    '2026-09-25', '2026-09-25T05:00', '2026-09-25 05:00 (UTC+8)', '2026-02-30T05:00:00Z',
    '2026-09-25T24:00:00Z', '2026-09-25T05:60:00Z', '2026-09-25T05:00:00+99:00',
    '<t:123:F>', '2026-09-25T05:00:00Z @everyone']) assert.equal(discordTimestamp(value), '', String(value));
  assert.equal(discordTimestamp(0, 'F>@everyone'), '');
});
