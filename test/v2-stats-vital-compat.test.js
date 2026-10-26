// Frozen scope-engine unit contract: fixtures explicitly opt into the scoped identity fake.
import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture } from './support/v2-stats/fixture.mjs';
import { createStatsProviders } from '../server/v2/stats/providers.js';
import { projectQuery } from '../server/v2/stats/service.js';
import { normalizeRow, hash } from '../server/v2/stats/model.js';
import { migrateStats } from '../server/v2/stats/migration.js';
import { VITAL_STAT_PATHS, vitalBuildingCount, vitalPlayTimeSeconds } from '../server/v2/stats/vital.js';
import { createSourceCollectors } from '../server/v2/management-adapters/sources/collectors.js';
import { exportDocument } from '../server/v2/stats/exports.js';

const steamId = '76561198000000501';
const query = { wipeId: 'g07_active', sourceId: 'vital', metricVersion: 'nb-kda-1' };
const setup = t => { const f = fixture({scopeContract:true}); t.after(() => f.db.close()); return f; };

test('Vital successful empty history remains unavailable while outages and malformed responses fail', async () => {
  const input = { steamInput: steamId, serverId: '16', providerWipeId: 'empty-history' };
  const unavailable = projectQuery(await createStatsProviders({ vital: async () => [] }).vital(input), 'vital', Date.now());
  assert.equal(unavailable.status, 'unavailable');
  assert.equal(unavailable.providerWipeId, 'empty-history');
  assert.deepEqual(unavailable.rows, []);
  assert.deepEqual(unavailable.categories, []);
  const outage = Object.assign(new Error('outage'), { errorCode: 'SOURCE_UNAVAILABLE' });
  await assert.rejects(createStatsProviders({ vital: async () => { throw outage; } }).vital(input), error => error === outage);
  await assert.rejects(createStatsProviders({ vital: async () => ({ error: 'invalid' }) }).vital(input), { errorCode: 'SOURCE_INVALID_DATA' });
});

test('Vital detailed lookup uses legacy leaf paths and preserves numeric strings, zero and absent categories', async () => {
  let request;
  const providers = createStatsProviders({ vital: async input => {
    request = input;
    return [{ context: { userId: steamId }, player: { name: 'AN sample' }, statistics: {
      combat: { kills: '1', killsT3: '0', deaths: '3', deathsT3: '0', headshots: '4',
        shots: '0', hits: '0', heals: '0', wounds: '3', revives: '0', suicides: '0' }
    } }];
  } });
  const raw = await providers.vital({ steamInput: steamId, serverId: '16', providerWipeId: 'historical-wipe' });
  assert.deepEqual(request.includes, [...VITAL_STAT_PATHS, 'combat', 'raiding', 'farming', 'building', 'general', 'pve']);
  assert.equal(request.wipeId, 'historical-wipe');
  assert.ok(request.includes.includes('pve::killsNPC::bradleyapc'));
  const result = projectQuery(raw, 'vital', Date.now());
  assert.equal(result.serverId, '16');
  assert.equal(result.providerWipeId, 'historical-wipe');
  assert.equal(result.rows[0].values.kills, 1);
  assert.equal(result.rows[0].values.t3Kills, 0);
  assert.equal(result.rows[0].values.kd, 0.33);
  for (const key of ['assists', 'kda', 'rockets', 'sulfur', 'metalOre', 'building', 'onlineSeconds', 'playTimeSeconds'])
    assert.equal(result.rows[0].values[key], null, key);
  const field = name => result.categories.flatMap(category => category.fields).find(item => item.name === name);
  assert.deepEqual(field('combat.killsT3'), { id: 'combat.killsT3', name: 'combat.killsT3', value: 0, status: 'observed' });
  assert.equal(field('raiding.rockets').status, 'not_observed');
  assert.equal(field('raiding.rockets').value, null);
  assert.equal(result.categories.find(category => category.id === 'combat').fields.filter(item => item.status === 'observed').length, 11);
  assert.equal(field('combat.revives').value, 0);
});

test('Vital building totals use observed block leaves and explicit playtime units never imply online time', async () => {
  assert.equal(vitalBuildingCount({}), null);
  assert.equal(vitalBuildingCount({ building: { buildings: {} } }), null);
  assert.equal(vitalBuildingCount({ building: { buildings: { wall: '0' } } }), 0);
  assert.equal(vitalBuildingCount({ building: { buildings: { wall: '2', 'floor.triangle': '3', missing: null, invalid: 'bad', boolean: true } } }), 5);
  assert.equal(vitalPlayTimeSeconds({ statistics: { general: { playTime: '1200' } } }), null);
  assert.equal(vitalPlayTimeSeconds({ statistics: { playtime: { minutes: '0' } } }), 0);
  assert.equal(vitalPlayTimeSeconds({ player: { playTimeHours: '2.5' } }), 9000);
  const providers = createStatsProviders({ vital: async () => [{ context: { userId: steamId },
    playTimeSeconds: '60', statistics: { combat: { kills: '', deaths: true },
      building: { buildings: { wall: '2', 'floor.triangle': '3' } }, general: { playTime: '1200' } } }] });
  const result = projectQuery(await providers.vital({ steamInput: steamId, serverId: '16', providerWipeId: 'p' }), 'vital', Date.now());
  assert.equal(result.rows[0].values.building, 5);
  assert.equal(result.rows[0].values.kills, null);
  assert.equal(result.rows[0].values.deaths, null);
  assert.equal(result.rows[0].values.playTimeSeconds, 60);
  assert.equal(result.rows[0].values.onlineSeconds, null);
  assert.equal(result.categories.find(category => category.id === 'general').fields[0].value, 1200);
});

test('Vital sync accepts a real farming-only observation without manufacturing combat values', async () => {
  const member = { id: 'm', steamId };
  const wipe = { id: 'w', serverProfileId: 'local-server', revision: 1 };
  const source = { sourceId: 'vital', serverId: 'local-server', providerServerId: '16', providerWipeId: 'p' };
  const { collectors } = createSourceCollectors({ store: {
    get: collection => collection === 'members' ? member : wipe, profile: () => null, statsRow: () => null
  }, readSourceConfig: () => source, readers: { stats: { vital: async () => [{
    context: { userId: steamId }, statistics: { farming: { gathered: { 'sulfur.ore': '0', 'metal.ore': '200' } } }
  }] } } });
  const result = await collectors.kda({ memberId: 'm', operationId: 'op', scope: { wipeId: 'w' } });
  assert.equal(result.outcome, 'success');
  assert.equal(result.data.stats.row.kills, null);
  assert.equal(result.data.stats.row.deaths, null);
  assert.equal(result.data.stats.row.sulfur, 0);
  assert.equal(result.data.stats.row.metalOre, 200);
  assert.equal(result.data.stats.row.categories.find(category => category.id === 'farming').fields.find(field => field.name.endsWith('metal.ore')).value, 200);
});

test('Vital remote wipe catalog retains historical dates, rejects wrong scope and malformed ranges, and deduplicates', async () => {
  const providers = createStatsProviders({ vitalServers: async () => [], vitalWipes: async () => [
    { id: 'archived', gameServerId: 16, startTime: '2026-09-03T19:00Z', endTime: '2026-09-24T19:00Z' },
    { id: 'current', gameServerId: 16, startTime: '2026-10-01T19:10:31Z' },
    { id: 'current', gameServerId: 16, startTime: '2026-09-01T19:00Z' },
    { id: 'previous-active', gameServerId: 16, startTime: '2026-09-24T19:00Z' },
    { id: 'wrong-server', gameServerId: 19, startTime: '2026-09-03T19:00Z', endTime: '2026-09-24T19:00Z' },
    { id: 'bad-range', gameServerId: 16, startTime: '2026-09-24T19:00Z', endTime: '2026-09-03T19:00Z' },
    { id: 'future', gameServerId: 16, startTime: '2099-10-01T19:00Z' }
  ] });
  const result = projectQuery(await providers.catalog({ provider: 'vital', serverId: '16' }), 'catalog', Date.now());
  assert.deepEqual(result.items.map(item => item.id), ['current', 'archived']);
  assert.equal(result.items[0].startTime, '2026-10-01T19:10:31.000Z');
  assert.equal(result.items[0].state, 'current');
  assert.equal(result.items[1].endTime, '2026-09-24T19:00:00.000Z');
  assert.equal(result.items[1].state, 'archived');
});

test('local Vital catalog recognizes top-level and archive-only history but honors frozen non-Vital scope without writes', t => {
  const f = setup(t);
  f.db.prepare("DELETE FROM json_records WHERE collection='kdaRows'").run();
  const active = f.service.repo.get('v2Wipes', 'g07_active');
  const history = f.service.repo.get('v2Wipes', 'g07_history');
  f.put('v2Wipes', { ...active, vitalServerId: '16' });
  f.service.repo.saveArchive({ wipeId: history.id, revision: 1, sourceId: 'vital' }, [
    normalizeRow({ id: 'old', memberId: 'g05_alpha', sourceId: 'vital', kills: 1, deaths: 3, capturedAt: '2026-09-03' })
  ]);
  const before = f.db.prepare('SELECT total_changes() n').get().n;
  assert.deepEqual(f.service.catalog(f.admin(), { provider: 'vital' }).items.map(item => item.id), [active.id, history.id]);
  assert.equal(f.service.sources(f.admin(), history.id).wipe.supportsVitalStats, true);
  assert.equal(f.db.prepare('SELECT total_changes() n').get().n, before);
  f.put('v2Wipes', { ...history, serverSnapshot: { provider: 'moose', kdaProvider: 'manual' } });
  assert.equal(f.service.sources(f.admin(), history.id).wipe.supportsVitalStats, false);
  assert.deepEqual(f.service.catalog(f.admin(), { provider: 'vital' }).items.map(item => item.id), [active.id]);
});

test('leaderboard competition ranks cross page boundaries, exclude null and include real zero within authorized filters', t => {
  const f = setup(t);
  const rows = f.db.prepare("SELECT payload_json FROM json_records WHERE collection='kdaRows' AND json_extract(payload_json,'$.wipeId')='g07_active' ORDER BY id").all().map(row => JSON.parse(row.payload_json));
  [20, 20, 10, 0, null].forEach((kills, index) => f.put('kdaRows', { ...rows[index], kills }));
  let cursor, items = [];
  do {
    const page = f.service.list(f.admin(), { ...query, sort: 'kills', limit: 1, cursor });
    assert.equal(page.rankingScope, 'authorized_filtered_rows');
    assert.equal(page.rowOffset, items.length);
    items.push(...page.items);
    cursor = page.nextCursor;
  } while (cursor);
  assert.deepEqual(items.map(row => [row.values.kills, row.rank]), [[20, 1], [20, 1], [10, 3], [0, 4], [null, null]]);
  const own = f.service.list(f.member(), { ...query, sort: 'kills' });
  assert.equal(own.items.length, 1);
  assert.equal(own.items[0].rank, own.items[0].values.kills === null ? null : 1);
});

test('numeric-string rankings and explicit unsupported metrics match the exported leaderboard across pages', t => {
  const f = setup(t);
  const rows = f.db.prepare("SELECT payload_json FROM json_records WHERE collection='kdaRows' AND json_extract(payload_json,'$.wipeId')='g07_active' ORDER BY id").all().map(row => JSON.parse(row.payload_json));
  const verifyParity = expected => {
    let cursor, items = [];
    do {
      const page = f.service.list(f.admin(), { ...query, sort: 'kills', limit: 1, cursor });
      items.push(...page.items);
      cursor = page.nextCursor;
    } while (cursor);
    assert.deepEqual(items.map(row => [row.values.kills, row.rank]), expected);
    const result = JSON.parse(exportDocument(f.service.collect(f.admin(), { ...query, sort: 'kills' }), { ranking: 'kills', language: 'en' }).json);
    assert.deepEqual(result.rankings[0].rows.map(row => [row.value, row.rank]), expected);
    assert.deepEqual(result.rankings[0].rows.map(row => row.memberId), items.map(row => row.memberId));
    return items;
  };
  ['9', '100', '20', 0, null].forEach((kills, index) => f.put('kdaRows', { ...rows[index], kills }));
  verifyParity([[100, 1], [20, 2], [9, 3], [0, 4], [null, null]]);
  ['100', '19', 19, 0, null].forEach((kills, index) => f.put('kdaRows', { ...rows[index], kills,
    capabilities: { ...rows[index].capabilities, ...(index === 0 ? { kills: false } : {}) } }));
  const items = verifyParity([[19, 1], [19, 1], [0, 3], [null, null], [null, null]]);
  const unsupported = items.find(row => row.id === rows[0].id);
  assert.equal(unsupported.capabilities.kills, false);
  assert.equal(unsupported.values.kd, null);
  assert.equal(unsupported.values.kda, null);
});

test('SQL and DTO normalization reject booleans, blanks, invalid and negative values while rounding KD ties', t => {
  const f = setup(t);
  const rows = f.db.prepare("SELECT payload_json FROM json_records WHERE collection='kdaRows' AND json_extract(payload_json,'$.wipeId')='g07_active' ORDER BY id").all().map(row => JSON.parse(row.payload_json));
  [true, ' ', 'bad', -1, '0'].forEach((kills, index) => f.put('kdaRows', { ...rows[index], kills }));
  const invalid = f.service.list(f.admin(), { ...query, sort: 'kills' });
  assert.deepEqual(invalid.items.map(row => [row.values.kills, row.rank]), [[0, 1], [null, null], [null, null], [null, null], [null, null]]);
  assert.equal(normalizeRow({ kills: {}, deaths: 1 }).values.kills, null);
  assert.equal(normalizeRow({ kills: [], deaths: 1 }).values.kills, null);
  assert.equal(normalizeRow({ onlineTimeMinutes: '1e308' }).values.onlineSeconds, null);
  assert.equal(normalizeRow({ kills: 1e308, deaths: 1, assists: 1e308 }).values.kda, null);
  [ ['1', '3'], ['33', '100'], [0, 1], [null, 1], [null, 1] ].forEach(([kills, deaths], index) => f.put('kdaRows', { ...rows[index], kills, deaths }));
  let cursor, kdRows = [];
  do {
    const page = f.service.list(f.admin(), { ...query, sort: 'kd', limit: 1, cursor });
    kdRows.push(...page.items);
    cursor = page.nextCursor;
  } while (cursor);
  assert.deepEqual(kdRows.map(row => [row.values.kd, row.rank]), [[0.33, 1], [0.33, 1], [0, 3], [null, null], [null, null]]);
  const decimal = normalizeRow({ kills: '20.5', deaths: '2' });
  assert.equal(decimal.values.kills, 20.5);
  assert.equal(decimal.values.kd, 10.25);
});

test('historical export metadata uses frozen archive or row context after the current server changes', t => {
  const f = setup(t);
  const history = f.service.repo.get('v2Wipes', 'g07_history');
  f.service.repo.saveArchive({ wipeId: history.id, revision: 1, sourceId: 'vital' }, [
    normalizeRow({ id: 'old-context', memberId: 'g05_alpha', sourceId: 'vital',
      serverId: 'old-server', providerWipeId: 'old-wipe', kills: 1, deaths: 3, capturedAt: '2026-07-30' })
  ]);
  f.put('v2Wipes', { ...history, serverProfileId: 'new-server', serverSnapshot: { provider: 'vital', name: 'Current server', vitalWipeId: 'new-wipe' } });
  const page = f.service.collect(f.admin(), { ...query, wipeId: history.id, revision: 1 });
  assert.equal(page.wipe.serverId, 'old-server');
  assert.equal(page.wipe.providerWipeId, 'old-wipe');
  assert.equal(page.wipe.serverName, '');
  const json = JSON.parse(exportDocument(page, { ranking: 'kills', language: 'en' }).json);
  assert.equal(json.meta.serverId, 'old-server');
  assert.equal(json.meta.providerWipeId, 'old-wipe');
  f.service.repo.saveArchive({ wipeId: history.id, revision: 2, sourceId: 'vital',
    wipe: { serverId: 'frozen-server', serverName: 'Frozen name', providerWipeId: 'frozen-wipe', startedAt: '2026-07-30', closedAt: '2026-08-06' } }, []);
  const frozen = f.service.list(f.admin(), { ...query, wipeId: history.id, revision: 2 });
  assert.equal(frozen.wipe.serverName, 'Frozen name');
  assert.equal(frozen.wipe.serverId, 'frozen-server');
  assert.equal(frozen.wipe.providerWipeId, 'frozen-wipe');
  assert.equal(frozen.wipe.startedAt, '2026-07-30T00:00:00.000Z');
});

test('historical squad filters use frozen affiliation after current membership changes', t => {
  const f = setup(t);
  const row = normalizeRow({ id: 'frozen', memberId: 'g05_alpha', squadId: 'historic-squad', squadName: 'Historical team',
    sourceId: 'vital', kills: 5, deaths: 0, capturedAt: '2026-09-03' });
  f.service.repo.saveArchive({ wipeId: 'g07_history', revision: 1, sourceId: 'vital' }, [row]);
  const result = f.service.list(f.admin(), { ...query, wipeId: 'g07_history', revision: 1, squadId: 'historic-squad' });
  assert.equal(result.items.length, 1);
  assert.equal(result.items[0].squadName, 'Historical team');
  assert.equal(f.service.list(f.admin(), { ...query, wipeId: 'g07_history', revision: 1, squadId: 'g05_squad' }).items.length, 0);
});

test('Vital categories survive ingestion and legacy archival while untrusted properties do not', t => {
  const f = setup(t);
  f.service.authorizeWrite = () => true;
  const old = JSON.parse(f.db.prepare("SELECT payload_json FROM json_records WHERE collection='kdaRows' AND json_extract(payload_json,'$.wipeId')='g07_active' AND json_extract(payload_json,'$.memberId')='g05_alpha'").get().payload_json);
  f.service.ingest(f.admin(), { wipeId: 'g07_active', sourceId: 'vital', serverId: 'local-server-1', providerWipeId: 'p', expectedRevision: 1,
    expectedRows: { g05_alpha: hash(old) }, rows: [{ memberId: 'g05_alpha', sourceRevision: 4, capturedAt: new Date().toISOString(), kills: 1, deaths: 3,
      categories: [{ id: 'combat', private: 'discard', fields: [{ id: 'combat.kills', name: 'combat.kills', value: '1', private: 'discard' }] }] }] }, 'vital-ingest');
  const result = f.service.list(f.admin(), query).items.find(row => row.memberId === 'g05_alpha');
  assert.equal(result.categories[0].fields[0].value, 1);
  assert.equal(JSON.stringify(result).includes('discard'), false);
  f.put('wipeSettlements', { id: 'old-settlement', wipeId: 'g07_history', generatedAt: '2026-09-24',
    participantsSnapshot: [{ memberId: 'g05_alpha', squadId: 'old-team', squadName: 'Old team' }],
    kdaSnapshot: [{ id: 'old-stat', memberId: 'g05_alpha', source: 'vital', kills: 1, deaths: 3, raw: { statistics: { combat: { kills: '1' } } } }] });
  migrateStats(f.db, { dryRun: false });
  const frozen = f.service.list(f.admin(), { ...query, wipeId: 'g07_history', revision: 1, squadId: 'old-team' }).items[0];
  assert.equal(frozen.squadName, 'Old team');
  assert.equal(frozen.categories[0].fields.find(field => field.name === 'combat.kills').value, 1);
});

test('export rankings allow the shared seven leaderboard ids and reject unknown ones', t => {
  const f = setup(t);
  for (const ranking of ['all', 'online_minutes', 'onlineSeconds', 'building'])
    assert.ok(f.service.createJob(f.admin(), 'export', { ...query, format: 'json', ranking }, `export-${ranking}`).jobId);
  assert.throws(() => f.service.createJob(f.admin(), 'export', { ...query, format: 'json', ranking: 'invented' }, 'bad-ranking'), { errorCode: 'INVALID_RANKING' });
});
