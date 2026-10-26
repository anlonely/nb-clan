import test from 'node:test';
import { setUiLocale } from '../src/v2/i18n.js';
import { setDisplayTimeZone } from '../src/v2/display-preferences.js';
// Explicit fixture preferences keep assertions independent of the test machine.
setUiLocale('zh');
setDisplayTimeZone('Asia/Shanghai');
import assert from 'node:assert/strict';
import { time, localInput, arrivalTime } from '../src/v2/format.js';
import { safeAuthReturnTo } from '../src/v2/auth-flow.js';
import { parseMemberLocation } from '../src/v2/router.js';
import { safeReturnTo } from '../server/v2/identity/contexts.js';
import { arrivalAfterHours } from '../server/v2/scheduling/time.js';

const timeError = code => error => {
  assert.equal(error.errorCode, code);
  assert.equal(error.status, 422);
  return true;
};
const displayParts = value => value.match(/\d+/g);

test('member display and datetime inputs round trip in Shanghai, New York and Kathmandu', () => {
  const utc = '2026-09-08T18:45:00.000Z';
  for (const [zone, local, dateParts] of [
    ['Asia/Shanghai', '2026-09-09T02:45', ['2026', '09', '09', '02', '45']],
    ['America/New_York', '2026-09-08T14:45', ['2026', '09', '08', '14', '45']],
    ['Asia/Kathmandu', '2026-09-09T00:30', ['2026', '09', '09', '00', '30']]
  ]) {
    assert.equal(localInput(utc, zone), local, zone);
    assert.equal(arrivalTime(local, zone), utc, zone);
    assert.deepEqual(displayParts(time(utc, zone)), dateParts, zone);
    assert.deepEqual(displayParts(time(utc, zone, true)), dateParts.slice(1), zone);
  }
  assert.equal(localInput(utc), '2026-09-09T02:45');
});

test('missing times stay unconfirmed while invalid arrival input yields actionable errors', () => {
  for (const missing of [undefined, null, '']) {
    assert.equal(time(missing), '待确认');
    assert.equal(localInput(missing), '');
  }
  assert.equal(time('not-a-date'), '待确认');
  assert.throws(() => arrivalTime('2026-02-30T12:00', 'Asia/Shanghai'), timeError('TIME_INPUT_INVALID'));
  assert.throws(() => arrivalTime('2026-09-08T12:00', 'America/Nowhere'), timeError('TIME_ZONE_INVALID'));
  assert.throws(() => arrivalTime('2026-09-08T12:00', 'Asia/Shanghai', '+09:00'), timeError('TIME_OFFSET_MISMATCH'));
});

test('member arrival input never silently moves a New York DST gap into a valid hour', () => {
  for (const offset of [undefined, '-05:00', '-04:00']) {
    assert.throws(() => arrivalTime('2026-03-08T02:30', 'America/New_York', offset), timeError('TIME_NONEXISTENT'));
  }
  assert.equal(localInput('2026-03-08T06:30:00.000Z', 'America/New_York'), '2026-03-08T01:30');
  assert.equal(localInput('2026-03-08T07:30:00.000Z', 'America/New_York'), '2026-03-08T03:30');
});

test('member arrival input requires a deliberate offset for both occurrences of a DST fold', () => {
  const local = '2026-11-01T01:30', zone = 'America/New_York';
  const candidates = [
    { utc: '2026-11-01T05:30:00.000Z', utcOffset: '-04:00' },
    { utc: '2026-11-01T06:30:00.000Z', utcOffset: '-05:00' }
  ];
  assert.throws(() => arrivalTime(local, zone), error => {
    timeError('TIME_AMBIGUOUS')(error);
    assert.deepEqual(error.candidates, candidates);
    return true;
  });
  for (const { utc, utcOffset } of candidates) {
    assert.equal(arrivalTime(local, zone, utcOffset), utc);
    assert.equal(localInput(utc, zone), local);
    assert.equal(arrivalTime(localInput(utc, zone), zone, utcOffset), utc);
    assert.deepEqual(displayParts(time(utc, zone)), ['2026', '11', '01', '01', '30']);
  }
  assert.equal(Date.parse(candidates[1].utc) - Date.parse(candidates[0].utc), 3_600_000);
  assert.throws(() => arrivalTime(local, zone, '-06:00'), timeError('TIME_OFFSET_MISMATCH'));
});

test('elapsed +8 and +16 hour arrivals survive member display and editing across midnight and DST', () => {
  for (const [zone, musterLocal, expected] of [
    ['Asia/Shanghai', '2026-09-08T23:00', [
      [8, '2026-09-08T23:00:00.000Z', '2026-09-09T07:00'],
      [16, '2026-09-09T07:00:00.000Z', '2026-09-09T15:00']
    ]],
    ['Asia/Kathmandu', '2026-09-08T23:30', [
      [8, '2026-09-09T01:45:00.000Z', '2026-09-09T07:30'],
      [16, '2026-09-09T09:45:00.000Z', '2026-09-09T15:30']
    ]],
    ['America/New_York', '2026-03-07T23:30', [
      [8, '2026-03-08T12:30:00.000Z', '2026-03-08T08:30'],
      [16, '2026-03-08T20:30:00.000Z', '2026-03-08T16:30']
    ]],
    ['America/New_York', '2026-10-31T23:30', [
      [8, '2026-11-01T11:30:00.000Z', '2026-11-01T06:30'],
      [16, '2026-11-01T19:30:00.000Z', '2026-11-01T14:30']
    ]]
  ]) {
    const muster = arrivalTime(musterLocal, zone);
    for (const [hours, expectedUtc, expectedLocal] of expected) {
      const arrival = arrivalAfterHours(muster, hours);
      assert.equal(arrival, expectedUtc, `${zone} +${hours}`);
      assert.equal(Date.parse(arrival) - Date.parse(muster), hours * 3_600_000);
      assert.equal(localInput(arrival, zone), expectedLocal);
      assert.equal(arrivalTime(localInput(arrival, zone), zone), arrival);
      assert.deepEqual(displayParts(time(arrival, zone)), expectedLocal.match(/\d+/g));
    }
  }
});

test('browser and G03 login return guards preserve the same valid deep link query and fragment', () => {
  for (const target of [
    '/app/wipes/wipe-1?tab=plan#signup',
    '/app/wipes/wipe-1?tab=team&cursor=last%3Aid#members',
    '/app/history?wipe=wipe-1&cursor=20#current',
    '/app/wipes/%E5%BC%80%E8%8D%92?tab=team#members',
    '/admin/members?tab=active#list'
  ]) {
    assert.equal(safeAuthReturnTo(target), target);
    assert.equal(safeAuthReturnTo(target), safeReturnTo(target));
    const login = parseMemberLocation(`/login?returnTo=${encodeURIComponent(target)}`);
    assert.equal(safeAuthReturnTo(login.searchParams.get('returnTo')), target);
  }
});

test('browser and G03 login return guards agree on rejecting malformed or redirecting targets', () => {
  for (const target of [
    undefined, null, {}, ['/app/home'], '', 'app/home', 'https://evil.example/app/home',
    '//evil.example/app/home', 'javascript:alert(1)', '/app/../../admin/members',
    '/app/%2e%2e/admin/members', '/app/%5cevil', '/app/%252fevil',
    '/app/wipes/%', '/app/wipes/%E0%A4%A', '/app/home?x=%0d%0aevil',
    '/auth/callback', '/app/auth/continue', '/app/home#callback', `/app/${'a'.repeat(2048)}`
  ]) {
    assert.equal(safeAuthReturnTo(target), '/app/home');
    assert.equal(safeAuthReturnTo(target), safeReturnTo(target));
  }
});

test('member route parsing keeps a signup fragment out of the selected tab and cursor', () => {
  const route = parseMemberLocation('/app/wipes/wipe-1?tab=plan&cursor=last%3Aid#signup');
  assert.equal(route.pathname, '/app/wipes/wipe-1');
  assert.equal(route.wipeId, 'wipe-1');
  assert.equal(route.searchParams.get('tab'), 'plan');
  assert.equal(route.searchParams.get('cursor'), 'last:id');
  assert.equal(route.hash, '#signup');
  const nested = parseMemberLocation('/app/wipes/wipe-1?tab=team&cursor=a%23b#members?tab=stats');
  assert.equal(nested.searchParams.get('tab'), 'team');
  assert.equal(nested.searchParams.get('cursor'), 'a#b');
  assert.equal(nested.hash, '#members?tab=stats');
});

test('member route parsing decodes a complete wipe ID once and leaves other local routes unmatched as details', () => {
  assert.equal(parseMemberLocation('/app/wipes/%E5%BC%80%E8%8D%92-1#signup').wipeId, '开荒-1');
  assert.equal(parseMemberLocation('/app/wipes/%F0%9F%94%A5-1').wipeId, '🔥-1');
  assert.equal(parseMemberLocation('/app/wipes/wipe%3A1?tab=team').wipeId, 'wipe:1');
  for (const path of ['/', '/login', '/auth/continue', '/help', '/app/wipes', '/app/wipes/wipe-1/extra']) {
    const route = parseMemberLocation(path);
    assert.equal(route.pathname, path);
    assert.equal(Object.hasOwn(route, 'wipeId'), false);
  }
});

test('invalid local paths cannot throw, become another route through decoding, or escape the origin', () => {
  for (const path of [
    undefined, null, {}, [], '', 'app/home', '?tab=team', '#signup',
    'https://member.invalid/app/home', 'https://evil.example/app/home',
    '//evil.example/app/home', '///evil.example/app/home', '/\\evil.example/app/home',
    '/app/../admin/members', '/app/%2e%2e/admin/members', '/app/./home',
    '/app/wipes/%', '/app/wipes/%2', '/app/wipes/%GG', '/app/wipes/%E0%A4%A',
    '/app/wipes/%ED%A0%80', '/app/wipes/%2fsecret', '/app/wipes/%5csecret',
    '/app/wipes/%252Fsecret', '/app/wipes/%23secret', '/app/wipes/%3Fsecret',
    '/app/wipes/%00', '/app/wipes/%0a', '/app/home\n', '/app/home\t',
    '/app/wipes/\ud800', '/app/wipes/\udc00'
  ]) {
    let route;
    assert.doesNotThrow(() => { route = parseMemberLocation(path); });
    assert.equal(route.pathname, '', String(path));
    assert.equal(route.searchParams.toString(), '');
    assert.equal(route.hash, '');
    assert.equal(Object.hasOwn(route, 'wipeId'), false);
  }
});

test('query parsing tolerates literal malformed percentages without decoding them as path IDs', () => {
  const route = parseMemberLocation('/app/wipes/wipe-1?cursor=100%&tab=team#signup');
  assert.equal(route.pathname, '/app/wipes/wipe-1');
  assert.equal(route.wipeId, 'wipe-1');
  assert.equal(route.searchParams.get('cursor'), '100%');
  assert.equal(route.searchParams.get('tab'), 'team');
  assert.equal(route.hash, '#signup');
  const first = parseMemberLocation('/app/home');
  first.searchParams.set('tab', 'team');
  assert.equal(parseMemberLocation('/app/home').searchParams.toString(), '');
});
