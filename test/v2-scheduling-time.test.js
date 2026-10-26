import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeTime, resolveLocalTime, validateTimeZone, arrivalAfterHours } from '../server/v2/scheduling/time.js';

const error = (code, inspect = () => {}) => e => {
  assert.equal(e.errorCode, code); assert.equal(e.status, 422); assert.ok(e.fieldErrors); inspect(e); return true;
};

test('scheduling times use explicit UTC/zone and reject normalized invalid calendar input', () => {
  assert.equal(normalizeTime(null, null), null);
  assert.equal(normalizeTime('2026-09-08T20:30:12.12+08:00', 'Asia/Shanghai'), '2026-09-08T12:30:12.120Z');
  assert.equal(resolveLocalTime({ localDateTime: '2026-09-08T20:30', timeZone: 'Asia/Shanghai' }), '2026-09-08T12:30:00.000Z');
  assert.equal(resolveLocalTime({ localDateTime: '2028-02-29T23:59:59.999', timeZone: 'UTC' }), '2028-02-29T23:59:59.999Z');
  for (const localDateTime of ['2026-02-29T12:00', '2026-04-31T12:00', '2026-09-08T24:00',
    '2026-09-08T12:60', '2026-09-08T12:00:60', '2026-9-8T12:00', '2026-09-08', '2026-09-08 12:00', '0000-01-01T00:00']) {
    assert.throws(() => resolveLocalTime({ localDateTime, timeZone: 'UTC' }), error('TIME_INPUT_INVALID'));
  }
  for (const value of ['2026-09-08T12:00', '2026-02-30T12:00Z', 0, {}, new Date()]) {
    assert.throws(() => normalizeTime(value, 'UTC'), error('TIME_INPUT_INVALID'));
  }
  for (const zone of ['+08:00', '', undefined, 'America/Nowhere', ' Asia/Shanghai']) {
    assert.throws(() => validateTimeZone(zone), error('TIME_ZONE_INVALID'));
  }
});

test('spring DST gaps are rejected instead of moved into the next valid hour', () => {
  for (const input of [
    { localDateTime: '2026-03-08T02:30', timeZone: 'America/New_York' },
    { localDateTime: '2026-03-29T02:30', timeZone: 'Europe/Berlin' },
    { localDateTime: '2026-10-04T02:15', timeZone: 'Australia/Lord_Howe' },
    { localDateTime: '2011-12-30T12:00', timeZone: 'Pacific/Apia' }
  ]) assert.throws(() => resolveLocalTime(input), error('TIME_NONEXISTENT'));
});

test('fall DST folds return both candidates and require a matching explicit offset', () => {
  const input = { localDateTime: '2026-11-01T01:30', timeZone: 'America/New_York' };
  assert.throws(() => resolveLocalTime(input), error('TIME_AMBIGUOUS', e => assert.deepEqual(e.candidates, [
    { utc: '2026-11-01T05:30:00.000Z', utcOffset: '-04:00' },
    { utc: '2026-11-01T06:30:00.000Z', utcOffset: '-05:00' }
  ])));
  assert.equal(resolveLocalTime({ ...input, utcOffset: '-04:00' }), '2026-11-01T05:30:00.000Z');
  assert.equal(resolveLocalTime({ ...input, utcOffset: '-05:00' }), '2026-11-01T06:30:00.000Z');
  for (const utcOffset of ['+00:00', '-06:00', '-05:60', '-24:00', '-0500', 0]) {
    assert.throws(() => resolveLocalTime({ ...input, utcOffset }), error('TIME_OFFSET_MISMATCH'));
  }
  assert.throws(() => resolveLocalTime({ localDateTime: '2026-09-08T20:00', timeZone: 'Asia/Shanghai', utcOffset: '+09:00' }), error('TIME_OFFSET_MISMATCH'));
  const halfHour = { localDateTime: '2026-04-05T01:45', timeZone: 'Australia/Lord_Howe' };
  assert.throws(() => resolveLocalTime(halfHour), error('TIME_AMBIGUOUS', e => {
    assert.equal(Date.parse(e.candidates[1].utc) - Date.parse(e.candidates[0].utc), 30 * 60_000);
  }));
});

test('raw local input cannot bypass DST or lie about its zone or submitted UTC', () => {
  const raw = { localDateTime: '2026-11-01T01:30', timeZone: 'America/New_York', utcOffset: '-05:00' };
  assert.equal(normalizeTime('2026-11-01T06:30:00Z', raw.timeZone, raw), '2026-11-01T06:30:00.000Z');
  assert.throws(() => normalizeTime('2026-11-01T05:30:00Z', raw.timeZone, raw), error('TIME_UTC_MISMATCH'));
  assert.throws(() => normalizeTime('2026-11-01T06:30:00Z', 'Asia/Shanghai', raw), error('TIME_ZONE_MISMATCH'));
  assert.throws(() => normalizeTime('2026-11-01T06:30:00Z', raw.timeZone, { ...raw, utcOffset: undefined }), error('TIME_AMBIGUOUS'));
  assert.throws(() => normalizeTime('2026-03-08T07:30:00Z', raw.timeZone,
    { localDateTime: '2026-03-08T02:30' }), error('TIME_NONEXISTENT'));
  assert.throws(() => normalizeTime(null, 'UTC', raw), error('TIME_INPUT_INVALID'));
});

test('arrival shortcuts add elapsed hours across DST and date boundaries', () => {
  const muster = resolveLocalTime({ localDateTime: '2026-03-08T01:30', timeZone: 'America/New_York' });
  assert.equal(arrivalAfterHours(muster, 8), '2026-03-08T14:30:00.000Z');
  assert.equal(arrivalAfterHours('2026-09-08T23:00:00Z', 16), '2026-09-09T15:00:00.000Z');
  for (const hours of [0, -8, '8', NaN, Infinity]) assert.throws(() => arrivalAfterHours(muster, hours), error('ARRIVAL_TIME_INVALID'));
});
