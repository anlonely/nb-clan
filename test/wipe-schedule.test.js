import assert from 'node:assert/strict';
import test from 'node:test';
import { WIPE_SERVER_PRESETS } from '../server/api.js';
import { computedWipeTimes } from '../server/wipe-schedule.js';

const serverById = new Map(WIPE_SERVER_PRESETS.map((server) => [server.id, server]));

test('all configured servers have the verified summer 2026 Wipe window', async (t) => {
  const now = new Date('2026-08-06T08:00:00.000Z');
  const expectedByServer = {
    '4': ['2026-08-03T13:00:00.000Z', '2026-08-06T18:00:00.000Z'],
    '16': ['2026-07-30T16:00:00.000Z', '2026-08-06T18:00:00.000Z'],
    '19': ['2026-07-16T16:00:00.000Z', '2026-08-06T18:00:00.000Z'],
    '23': ['2026-07-30T21:00:00.000Z', '2026-08-06T18:00:00.000Z'],
    'atlas-eu-2x-monthly': ['2026-07-02T18:00:00.000Z', '2026-08-06T18:00:00.000Z'],
    'atlas-eu-2x-medium': ['2026-07-30T16:00:00.000Z', '2026-08-06T18:00:00.000Z'],
    'atlas-eu-2x-monthly-quad': ['2026-07-02T18:00:00.000Z', '2026-08-06T18:00:00.000Z'],
    'atlas-us-2x-monthly': ['2026-07-30T21:00:00.000Z', '2026-08-06T18:00:00.000Z'],
    'atlas-us-2x-medium': ['2026-07-30T21:00:00.000Z', '2026-08-06T18:00:00.000Z'],
    'atlas-us-2x-monthly-quad': ['2026-07-30T21:00:00.000Z', '2026-08-06T18:00:00.000Z']
  };

  assert.deepEqual([...serverById.keys()], Object.keys(expectedByServer));
  assert.equal(serverById.get('23').status, 'hidden');
  for (const [serverId, [currentStart, nextStart]] of Object.entries(expectedByServer)) {
    await t.test(serverId, () => {
      assert.deepEqual(computedWipeTimes(serverById.get(serverId), now), { currentStart, nextStart });
    });
  }
});

test('London schedules remain at their advertised local time across DST', () => {
  assert.deepEqual(
    computedWipeTimes(serverById.get('16'), new Date('2026-10-02T00:00:00.000Z')),
    {
      currentStart: '2026-10-01T18:00:00.000Z',
      nextStart: '2026-10-29T17:00:00.000Z'
    }
  );

  assert.deepEqual(
    computedWipeTimes(serverById.get('4'), new Date('2026-10-20T00:00:00.000Z')),
    {
      currentStart: '2026-10-19T13:00:00.000Z',
      nextStart: '2026-10-26T14:00:00.000Z'
    }
  );

  assert.deepEqual(
    computedWipeTimes(serverById.get('19'), new Date('2026-11-06T00:00:00.000Z')),
    {
      currentStart: '2026-11-05T19:00:00.000Z',
      nextStart: '2026-11-19T17:00:00.000Z'
    }
  );
});

test('Vital EU Monthly follows the week before force across the five-Thursday October and London DST change', () => {
  const server = serverById.get('16');
  for (const at of ['2026-10-14T14:00:00.000Z', '2026-10-22T16:00:00.000Z', '2026-10-25T01:00:00.000Z']) {
    assert.deepEqual(computedWipeTimes(server, new Date(at)), {
      currentStart: '2026-10-01T18:00:00.000Z',
      nextStart: '2026-10-29T17:00:00.000Z'
    });
  }
  assert.deepEqual(computedWipeTimes(server, new Date('2026-10-29T17:00:00.000Z')), {
    currentStart: '2026-10-29T17:00:00.000Z',
    nextStart: '2026-11-05T19:00:00.000Z'
  });
  assert.deepEqual(computedWipeTimes(server, new Date('2026-11-05T19:00:00.000Z')), {
    currentStart: '2026-11-05T19:00:00.000Z',
    nextStart: '2026-11-26T17:00:00.000Z'
  });
});

test('monthly week schedules support fifth Thursdays and cross-year boundaries', () => {
  const atlasMedium = serverById.get('atlas-eu-2x-medium');
  assert.deepEqual(
    computedWipeTimes(atlasMedium, new Date('2027-07-20T00:00:00.000Z')),
    {
      currentStart: '2027-07-15T16:00:00.000Z',
      nextStart: '2027-07-29T16:00:00.000Z'
    }
  );
  assert.deepEqual(
    computedWipeTimes(serverById.get('16'), new Date('2026-12-31T23:00:00.000Z')),
    {
      currentStart: '2026-12-31T17:00:00.000Z',
      nextStart: '2027-01-07T19:00:00.000Z'
    }
  );
});

test('the scheduled instant becomes current and unknown schedules fail closed', () => {
  assert.deepEqual(
    computedWipeTimes(serverById.get('16'), new Date('2026-08-06T18:00:00.000Z')),
    {
      currentStart: '2026-08-06T18:00:00.000Z',
      nextStart: '2026-08-27T16:00:00.000Z'
    }
  );
  assert.throws(
    () => computedWipeTimes({ id: 'bad', schedule: 'monthly_typo', wipeHourUtc: 18 }),
    /Unsupported wipe schedule/
  );
  assert.throws(
    () => computedWipeTimes({
      schedule: 'monthly_force',
      wipeTimeZone: 'Europe/London',
      wipeHourLocal: 19,
      wipeHourUtc: 18
    }),
    /cannot mix/
  );
  assert.throws(
    () => computedWipeTimes({
      schedule: 'biweekly_thursday',
      wipeTimeZone: 'Europe/London',
      wipeHourLocal: 17,
      anchorLocalDate: '2026-06-03'
    }),
    /must be a Thursday/
  );
});
