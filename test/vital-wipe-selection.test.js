import assert from 'node:assert/strict';
import test from 'node:test';
import {
  computedWipeTimes,
  normalizeVitalWipes,
  publicVitalServer,
  publicWipeServerPreset,
  selectActiveVitalWipe,
  vitalMetadataPatchForStartedWipe
} from '../server/api.js';

test('Vital Wipe selection requires a local-time match and never binds the previous active Wipe', () => {
  const localWipe = { startedAt: '2026-07-30T16:00:00.000Z' };
  const previousActive = {
    id: 'previous-active',
    startTime: '2026-07-23T15:59:21.000Z'
  };
  const matchingActive = {
    id: 'matching-active',
    startTime: '2026-07-30T15:59:21.000Z'
  };

  assert.equal(
    selectActiveVitalWipe([previousActive, matchingActive], localWipe)?.id,
    'matching-active'
  );
  assert.equal(
    selectActiveVitalWipe([previousActive], localWipe),
    null
  );
  assert.equal(
    selectActiveVitalWipe([previousActive], {
      ...localWipe,
      vitalWipeId: 'manually-selected'
    }),
    null
  );
});

test('Vital Wipe selection advances a started local Wipe to the next remote Wipe without rolling back', () => {
  const localWipe = {
    vitalServerId: '16',
    startedAt: '2026-07-30T16:00:00.000Z',
    vitalWipeId: 'remote-old',
    vitalWipeStartedAt: '2026-07-30T15:59:21.000Z'
  };
  const archivedOld = {
    id: 'remote-old',
    gameServerId: 16,
    startTime: '2026-07-30T15:59:21.000Z',
    endTime: '2026-08-06T18:10:52.000Z'
  };
  const activeCurrent = {
    id: 'remote-current',
    gameServerId: 16,
    startTime: '2026-08-06T18:10:53.000Z'
  };

  assert.equal(
    selectActiveVitalWipe([archivedOld, activeCurrent], localWipe, new Date('2026-08-10T00:00:00.000Z'))?.id,
    'remote-current'
  );
  assert.equal(
    selectActiveVitalWipe([{
      id: 'remote-older',
      gameServerId: 16,
      startTime: '2026-07-23T15:59:21.000Z'
    }], localWipe, new Date('2026-08-10T00:00:00.000Z')),
    null
  );
});

test('Vital Wipe metadata never moves the recorded remote start time backwards', () => {
  const localWipe = {
    status: 'active',
    startedAt: '2026-07-30T16:00:00.000Z',
    vitalServerId: '16',
    vitalWipeId: 'remote-current',
    vitalWipeStartedAt: '2026-07-30T15:59:21.000Z'
  };
  const patch = vitalMetadataPatchForStartedWipe(localWipe, {
    id: 'remote-current',
    startTime: '2026-07-30T15:58:21.000Z'
  });

  assert.equal(Object.hasOwn(patch, 'vitalWipeStartedAt'), false);
});

test('Vital Wipe normalization rejects malformed, future, duplicate, mismatched, and extra active rows', () => {
  const now = new Date('2026-08-06T08:00:00.000Z');
  const rows = normalizeVitalWipes([
    { id: 'future', gameServerId: 16, startTime: '2026-08-06T18:05:00.000Z' },
    { id: 'invalid', gameServerId: 16, startTime: 'not-a-date' },
    { id: 'wrong-server', gameServerId: 19, startTime: '2026-08-01T18:00:00.000Z' },
    { id: 'current', gameServerId: 16, startTime: '2026-07-30T15:59:00.000Z' },
    { id: 'older-active', gameServerId: 16, startTime: '2026-07-23T15:59:00.000Z' },
    { id: 'archived', gameServerId: 16, startTime: '2026-07-02T18:00:00.000Z', endTime: '2026-07-23T15:58:59.000Z' },
    { id: 'archived', gameServerId: 16, startTime: '2026-06-01T18:00:00.000Z', endTime: '2026-06-02T18:00:00.000Z' },
    { id: 'bad-range', gameServerId: 16, startTime: '2026-06-03T18:00:00.000Z', endTime: '2026-06-02T18:00:00.000Z' }
  ], { serverId: '16', now });

  assert.deepEqual(rows.map((row) => row.id), ['current', 'archived']);
  assert.equal(selectActiveVitalWipe(rows, null, now)?.id, 'current');
  assert.equal(selectActiveVitalWipe([
    { id: 'archived-only', startTime: '2026-07-01T18:00:00.000Z', endTime: '2026-07-02T18:00:00.000Z' }
  ], null, now), null);
});

test('EU Monthly converts the 19:00 London force wipe and management offers current plus next', () => {
  const server = {
    id: '16',
    name: 'Vital Rust 2X EU Monthly',
    vitalServerId: '16',
    battlemetricsId: '29566604',
    schedule: 'monthly_force_with_intermediate',
    wipeTimeZone: 'Europe/London',
    wipeHourLocal: 19,
    wipeMinuteLocal: 0,
    intermediateWipeHourLocal: 17,
    intermediateWipeMinuteLocal: 0,
    intermediateWeeksBeforeForce: [1]
  };
  const now = new Date('2026-08-06T08:00:00.000Z');
  const times = computedWipeTimes(server, now);

  assert.equal(times.nextStart, '2026-08-06T18:00:00.000Z');

  const remoteWipes = [
    {
      id: 'remote-current',
      startTime: '2026-07-30T15:59:00.000Z'
    },
    {
      id: 'remote-archived',
      startTime: '2026-07-24T15:59:00.000Z',
      endTime: '2026-07-30T15:58:59.000Z'
    }
  ];
  const payload = publicWipeServerPreset(server, remoteWipes, now);

  assert.deepEqual(payload.wipeOptions.map((option) => option.type), ['current', 'next']);
  assert.equal(payload.wipeOptions[0].vitalWipeId, 'remote-current');
  assert.equal(payload.wipeOptions[1].startedAt, '2026-08-06T18:00:00.000Z');
  assert.equal(payload.wipeOptions[1].vitalWipeId, '');
  assert.equal(payload.nextWipeAt, '2026-08-06T18:00:00.000Z');

  const lookupPayload = publicVitalServer(server, remoteWipes, now);
  assert.deepEqual(lookupPayload.wipeOptions.map((option) => option.type), ['all', 'current', 'archived']);
  assert.equal(lookupPayload.wipeOptions[1].vitalWipeId, 'remote-current');
  assert.equal(lookupPayload.wipeOptions[2].vitalWipeId, 'remote-archived');

  const offlinePayload = publicWipeServerPreset(server, [], now);
  assert.deepEqual(offlinePayload.wipeOptions.map((option) => option.type), ['current', 'next']);
  assert.equal(offlinePayload.wipeOptions[1].startedAt, '2026-08-06T18:00:00.000Z');

  const atScheduledStart = publicWipeServerPreset(
    server,
    remoteWipes,
    new Date('2026-08-06T18:00:00.000Z')
  );
  assert.equal(atScheduledStart.wipeOptions[0].startedAt, '2026-08-06T18:00:00.000Z');
  assert.equal(atScheduledStart.wipeOptions[0].vitalWipeId, '');
  assert.equal(atScheduledStart.wipeOptions[1].startedAt, '2026-08-27T16:00:00.000Z');

  const afterRemoteActivation = publicWipeServerPreset(server, [{
    id: 'remote-new-current',
    startTime: '2026-08-06T18:10:53.000Z'
  }], new Date('2026-08-10T00:00:00.000Z'));
  assert.equal(afterRemoteActivation.wipeOptions[0].startedAt, '2026-08-06T18:00:00.000Z');
  assert.equal(afterRemoteActivation.wipeOptions[0].vitalWipeId, 'remote-new-current');
  assert.equal(afterRemoteActivation.currentWipeAt, '2026-08-06T18:10:53.000Z');

  const malformedRemotePayload = publicWipeServerPreset(server, [
    { id: 'future-current', startTime: '2026-08-06T18:05:00.000Z' },
    { id: 'archived-only', startTime: '2026-07-02T18:00:00.000Z', endTime: '2026-07-03T18:00:00.000Z' }
  ], now);
  assert.equal(malformedRemotePayload.wipeOptions[0].startedAt, '2026-07-30T16:00:00.000Z');
  assert.equal(malformedRemotePayload.wipeOptions[0].vitalWipeId, '');
  assert.equal(Date.parse(malformedRemotePayload.currentWipeAt) <= now.getTime(), true);
  assert.equal(Date.parse(malformedRemotePayload.nextWipeAt) > now.getTime(), true);
});
