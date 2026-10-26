import test from 'node:test';
import assert from 'node:assert/strict';
import { createProductionWipeCatalog, wipeServerCatalog } from '../server/v2/production/wipe-catalog.js';
import { defaultsForServer, normalizeOpenWipeSettings } from '../server/v2/discord-open-wipe/catalog.js';

const now = Date.parse('2026-10-22T08:00:00Z');
const serverId = 'atlas-eu-2x-monthly';
const officialNext = '2026-10-22T16:00:00.000Z';
const official = { id: '2', alias: '2xmonthly.atlasrust.uk', region: 'EU', nextWipeAt: officialNext };
const snapshot = owner => owner.read().find(row => row.id === serverId).serverSnapshot;
const create = options => createProductionWipeCatalog({ now: () => now, env: {},
  readMooseDates: async () => null, readAtlasCatalog: async () => [official], ...options });

test('Atlas official October 23 midnight CST reaches V2 selection through async prepare and the existing provider cache', async () => {
  let requests = 0, release;
  const gate = new Promise(resolve => { release = resolve; });
  const owner = createProductionWipeCatalog({ now: () => now, env: {}, readMooseDates: async () => null,
    fetchImpl: async (url, options) => {
      requests++;
      assert.equal(url, 'https://services.atlasrust.com/api/public/servers');
      assert.ok(options.signal instanceof AbortSignal);
      await gate;
      return { ok: true, json: async () => ({ servers: [{ id: 2, alias: official.alias, region: 'EU',
        name: 'Atlas - EU 2X Monthly Large', map_voting: { wipe_timestamp: officialNext } }] }) };
    } });
  assert.equal(snapshot(owner).nextWipeAt, '2026-11-05T19:00:00.000Z');
  const pending = owner.prepare();
  assert.equal(snapshot(owner).nextWipeSource, 'schedule_fallback');
  release();
  await pending;
  assert.equal(snapshot(owner).nextWipeAt, officialNext);
  assert.equal(snapshot(owner).nextWipeSource, 'atlas_official');
  assert.equal(snapshot(owner).currentWipeAt, '2026-10-01T18:00:00.000Z');
  await owner.prepare();
  assert.equal(requests, 1);

  const catalog = { listOptions: () => ({ items: owner.read() }) };
  const defaults = defaultsForServer(catalog, serverId, { now });
  assert.equal(defaults.wipeAtLocal, '2026-10-22T17:00');
  assert.equal(defaults.utcOffset, '+01:00');
  const settings = normalizeOpenWipeSettings({}, defaults, { now });
  assert.equal(settings.wipeAt, officialNext);
  assert.equal(new Date(Date.parse(settings.wipeAt) + 8 * 3600000).toISOString(), '2026-10-23T00:00:00.000Z');
  assert.equal(requests, 1, 'reading and selecting the prepared catalog must not fetch');
});

test('Atlas dates require the same alias, provider ID and region', async () => {
  for (const changed of [{ alias: '2xmonthly.atlasrust.us' }, { id: '6' }, { region: 'NA' }]) {
    const owner = create({ readAtlasCatalog: async () => [{ ...official, ...changed }] });
    await owner.prepare();
    assert.equal(snapshot(owner).nextWipeSource, 'schedule_fallback');
    assert.equal(snapshot(owner).nextWipeAt, '2026-11-05T19:00:00.000Z');
  }
  const owner = create();
  await owner.prepare();
  for (const id of ['atlas-eu-2x-monthly-quad', 'atlas-eu-2x-medium', 'atlas-us-2x-monthly']) {
    assert.equal(owner.read().find(row => row.id === id).serverSnapshot.nextWipeSource, 'schedule_fallback');
  }
});

test('Atlas dates expire at read time without another request, including the exact scheduled instant', async () => {
  let clock = now, requests = 0;
  const owner = create({ now: () => clock, readAtlasCatalog: async () => { requests++; return [official]; } });
  await owner.prepare();
  clock = Date.parse(officialNext) - 1;
  assert.equal(snapshot(owner).nextWipeSource, 'atlas_official');
  for (const instant of [Date.parse(officialNext), Date.parse(officialNext) + 1, Date.parse('2026-11-06T00:00Z')]) {
    clock = instant;
    const current = snapshot(owner);
    const expected = wipeServerCatalog({}, new Date(clock)).find(row => row.id === serverId).serverSnapshot;
    assert.equal(current.nextWipeSource, 'schedule_fallback');
    assert.equal(current.nextWipeAt, expected.nextWipeAt);
  }
  assert.equal(requests, 1);
});

test('missing, invalid and already elapsed Atlas dates preserve the calendar fallback', async () => {
  for (const nextWipeAt of [undefined, '', 'bad', '2026-10-22T17:00', '2026-11-31T16:00:00Z',
    '2026-10-22T08:00:00Z', '2026-10-21T16:00:00Z']) {
    const owner = create({ readAtlasCatalog: async () => [{ ...official, nextWipeAt }] });
    await owner.prepare();
    assert.equal(snapshot(owner).nextWipeSource, 'schedule_fallback', String(nextWipeAt));
    assert.equal(snapshot(owner).nextWipeAt, '2026-11-05T19:00:00.000Z');
  }
});

test('Atlas refresh failures and malformed catalogs keep server selection usable', async () => {
  let result = [official];
  const owner = create({ readAtlasCatalog: async () => {
    if (result instanceof Error) throw result;
    return result;
  } });
  await owner.prepare();
  assert.equal(snapshot(owner).nextWipeSource, 'atlas_official');
  for (result of [new Error('upstream timeout'), null, {}, []]) {
    await assert.doesNotReject(owner.prepare());
    assert.equal(snapshot(owner).nextWipeSource, 'schedule_fallback');
    assert.equal(owner.read().length, wipeServerCatalog({}, new Date(now)).length);
  }
});

test('disabling external Atlas suppresses requests and stops using any prepared official date', async () => {
  const env = { NB_DISABLE_EXTERNAL_ATLAS: '1' };
  let requests = 0, mooseRequests = 0;
  const owner = create({ env, readAtlasCatalog: async () => { requests++; return [official]; },
    readMooseDates: async () => { mooseRequests++; return null; } });
  await owner.prepare();
  assert.equal(requests, 0);
  assert.equal(mooseRequests, 4);
  assert.equal(snapshot(owner).nextWipeSource, 'schedule_fallback');
  env.NB_DISABLE_EXTERNAL_ATLAS = '0';
  await owner.prepare();
  assert.equal(snapshot(owner).nextWipeSource, 'atlas_official');
  env.NB_DISABLE_EXTERNAL_ATLAS = '1';
  assert.equal(snapshot(owner).nextWipeSource, 'schedule_fallback');
  await owner.prepare();
  assert.equal(requests, 1);
});

test('the shared owner preserves Moose observations and dynamically reads Vital overrides', async () => {
  let settings = {}, moose = { serverName: 'Rusty Moose |EU Main|', nextWipeAt: '2026-10-22T14:00:00.000Z',
    nextWipeSource: 'moose_official_schedule', currentWipeAt: '2026-10-15T14:02:00.000Z', currentWipeSource: 'moose_a2s' };
  const owner = create({ readSettings: () => settings,
    readMooseDates: async id => id === 'eu-main' ? moose : null });
  await owner.prepare();
  const rows = owner.read();
  const baseline = wipeServerCatalog({}, new Date(now));
  assert.deepEqual(rows.filter(row => row.serverSnapshot.provider === 'vital'),
    baseline.filter(row => row.serverSnapshot.provider === 'vital'));
  const main = rows.find(row => row.id === 'moose-eu-main');
  assert.equal(main.label, moose.serverName);
  assert.equal(main.serverSnapshot.name, moose.serverName);
  assert.equal(main.serverSnapshot.nextWipeAt, moose.nextWipeAt);
  assert.equal(main.serverSnapshot.currentWipeSource, 'moose_a2s');
  assert.equal(main.serverSnapshot.connectCommand, 'client.connect main.eu.moose.gg:28010');
  settings = { vitalServers: { overrides: [{ vitalServerId: '19', name: 'Configured Medium',
    directConnect: 'client.connect configured.example:28015' }, { vitalServerId: '16', status: 'hidden' }] } };
  assert.equal(owner.read().find(row => row.id === '19').label, 'Configured Medium');
  assert.equal(owner.read().find(row => row.id === '19').serverSnapshot.connectCommand,
    'client.connect configured.example:28015');
  assert.equal(owner.read().some(row => row.id === '16'), false);
  moose = null;
  await owner.prepare();
  assert.deepEqual(owner.read().find(row => row.id === 'moose-eu-main'), baseline.find(row => row.id === 'moose-eu-main'));
});
