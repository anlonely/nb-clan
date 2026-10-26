import assert from 'node:assert/strict';
import test from 'node:test';
import { WIPE_SERVER_PRESETS, publicWipeServerPreset } from '../server/api.js';
import {
  atlasCurrentWipeAtFromKeywords,
  atlasServerForPreset,
  parseAtlasA2SInfoResponse,
  parseAtlasServerCatalog
} from '../server/atlas-server-provider.js';

test('Atlas official catalog is matched by stable server alias', () => {
  const catalog = parseAtlasServerCatalog({
    servers: [
      {
        id: 2,
        name: 'Atlas - EU 2X Monthly Large',
        alias: '2xmonthly.atlasrust.uk',
        region: 'EU',
        map_voting: { wipe_timestamp: '2026-08-06T18:00:00.000Z' }
      },
      { id: 99, name: 'invalid', alias: '', map_voting: null }
    ]
  });
  const preset = WIPE_SERVER_PRESETS.find((server) => server.id === 'atlas-eu-2x-monthly');
  const official = atlasServerForPreset(preset, catalog);

  assert.equal(catalog.length, 1);
  assert.equal(official.id, '2');
  assert.equal(official.nextWipeAt, '2026-08-06T18:00:00.000Z');

  assert.equal(atlasServerForPreset(preset, [{ ...official, id: '999' }]), null);
  assert.equal(atlasServerForPreset(preset, [{ ...official, region: 'NA' }]), null);
});

test('Atlas official next Wipe overrides the calendar and stale values fall back safely', () => {
  const preset = WIPE_SERVER_PRESETS.find((server) => server.id === 'atlas-eu-2x-monthly');
  const now = new Date('2026-08-06T08:00:00.000Z');
  const officialPayload = publicWipeServerPreset(preset, [], now, {
    nextWipeAt: '2026-08-06T17:30:00.000Z',
    currentWipeAt: '2026-07-23T15:58:04.000Z',
    observedAt: '2026-08-06T08:00:00.000Z'
  });
  assert.equal(officialPayload.nextWipeAt, '2026-08-06T17:30:00.000Z');
  assert.equal(officialPayload.nextWipeSource, 'atlas_official');
  assert.equal(officialPayload.scheduleNextWipeAt, '2026-08-06T18:00:00.000Z');
  assert.equal(officialPayload.wipeOptions[1].startedAt, '2026-08-06T17:30:00.000Z');
  assert.equal(officialPayload.currentWipeAt, '2026-07-23T15:58:04.000Z');
  assert.equal(officialPayload.currentWipeSource, 'atlas_a2s');
  assert.equal(officialPayload.wipeOptions[0].startedAt, '2026-07-23T15:58:04.000Z');

  const stalePayload = publicWipeServerPreset(preset, [], now, {
    nextWipeAt: '2026-08-01T18:00:00.000Z'
  });
  assert.equal(stalePayload.nextWipeAt, '2026-08-06T18:00:00.000Z');
  assert.equal(stalePayload.nextWipeSource, 'schedule_fallback');
});

test('Atlas rolls over exactly on the scheduled instant even if A2S still reports the old map', () => {
  const preset = WIPE_SERVER_PRESETS.find((server) => server.id === 'atlas-eu-2x-monthly');
  const payload = publicWipeServerPreset(preset, [], new Date('2026-08-06T18:00:00.000Z'), {
    nextWipeAt: '2026-08-06T18:00:00.000Z',
    currentWipeAt: '2026-07-23T15:58:04.000Z',
    observedAt: '2026-08-06T18:00:00.000Z'
  });

  assert.equal(payload.currentWipeAt, '2026-08-06T18:00:00.000Z');
  assert.equal(payload.currentWipeSource, 'schedule_fallback');
  assert.equal(payload.nextWipeAt, '2026-09-03T18:00:00.000Z');
  assert.equal(payload.nextWipeSource, 'schedule_fallback');
  assert.equal(payload.wipeOptions[0].startedAt, '2026-08-06T18:00:00.000Z');
  assert.equal(payload.wipeOptions[1].startedAt, '2026-09-03T18:00:00.000Z');
});

test('Atlas A2S parser extracts the Rust born timestamp used for actual current Wipe', () => {
  const cString = (value) => Buffer.concat([Buffer.from(value, 'utf8'), Buffer.from([0])]);
  const header = Buffer.alloc(4);
  header.writeInt32LE(-1);
  const appId = Buffer.alloc(2);
  appId.writeUInt16LE(252490 & 0xffff);
  const port = Buffer.alloc(2);
  port.writeUInt16LE(28010);
  const packet = Buffer.concat([
    header,
    Buffer.from([0x49, 17]),
    cString('Atlas - EU 2X Monthly'),
    cString('Custom Map'),
    cString('rust'),
    cString('Rust'),
    appId,
    Buffer.from([50, 100, 0, 100, 108, 0, 1]),
    cString('2631'),
    Buffer.from([0xa0]),
    port,
    cString('mp100,born1784822284,gmrust')
  ]);
  const info = parseAtlasA2SInfoResponse(packet);

  assert.equal(info.name, 'Atlas - EU 2X Monthly');
  assert.equal(info.keywords, 'mp100,born1784822284,gmrust');
  assert.equal(
    atlasCurrentWipeAtFromKeywords(info.keywords, new Date('2026-08-06T08:00:00.000Z')),
    '2026-07-23T15:58:04.000Z'
  );
  assert.equal(
    atlasCurrentWipeAtFromKeywords('born1999999999', new Date('2026-08-06T08:00:00.000Z')),
    ''
  );
});


test('Atlas US 2X presets match live NA identities and published September wipe times', () => {
  const catalog = parseAtlasServerCatalog({ servers: [
    { id: 6, name: 'Atlas - US 2X Monthly Large', alias: '2xmonthly.atlasrust.us', region: 'NA', map_voting: { wipe_timestamp: '2026-09-24T21:00:00.000Z' } },
    { id: 33, name: 'Atlas - US 2X Medium', alias: '2xmedium.atlasrust.us', region: 'NA', map_voting: { wipe_timestamp: '2026-10-01T18:00:00.000Z' } },
    { id: 27, name: 'Atlas - US 2X Monthly Solo/Duo/Trio/Quad', alias: '2xmonthlyquad.atlasrust.us', region: 'NA', map_voting: { wipe_timestamp: '2026-09-24T21:00:00.000Z' } }
  ] });
  for (const id of ['atlas-us-2x-monthly', 'atlas-us-2x-medium', 'atlas-us-2x-monthly-quad']) {
    const preset = WIPE_SERVER_PRESETS.find(row => row.id === id);
    assert.ok(preset);
    assert.equal(preset.atlasRegion, 'NA');
    assert.equal(preset.battlemetricsId, undefined);
    assert.equal(atlasServerForPreset(preset, catalog)?.id, preset.atlasId);
    assert.equal(publicWipeServerPreset(preset, [], new Date('2026-09-23T00:00:00Z'), atlasServerForPreset(preset, catalog)).nextWipeSource, 'atlas_official');
  }
});
