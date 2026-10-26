// Frozen scope-engine unit contract: fixtures explicitly opt into the scoped identity fake.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createStatsProviders } from '../server/v2/stats/providers.js';
import { projectQuery } from '../server/v2/stats/service.js';

test('vanity resolution receives cancellation and aborted queries never reach the data provider', async () => {
  const controller = new AbortController();
  let resolved, dataCalls = 0;
  const entered = new Promise(resolve => { resolved = resolve; });
  const providers = createStatsProviders({
    resolveVanity: (_name, { signal }) => new Promise((resolve, reject) => {
      assert.equal(signal, controller.signal);
      signal.addEventListener('abort', () => reject(new Error('cancelled')), { once: true });
      resolved();
    }),
    official: () => { dataCalls++; return {}; }
  });
  const job = providers.official({ steamInput: 'https://steamcommunity.com/id/example' }, { signal: controller.signal });
  await entered;
  controller.abort();
  await assert.rejects(job, /cancelled/);
  await assert.rejects(providers.official({ steamInput: 'https://steamcommunity.com/id/example' }, { signal: controller.signal }));
  assert.equal(dataCalls, 0);
});
test('official source no-match is an empty result while an outage still fails', async () => {
  const noMatch = Object.assign(new Error('no published stats'), { errorCode: 'SOURCE_NO_MATCH' });
  const unavailable = Object.assign(new Error('source unavailable'), { errorCode: 'SOURCE_UNAVAILABLE' });
  const empty = createStatsProviders({ official: async () => { throw noMatch; } });
  assert.deepEqual(await empty.official({ steamInput: '76561198000000501' }), {
    steamId: '76561198000000501', status: 'unavailable', rows: [], fields: []
  });
  const broken = createStatsProviders({ official: async () => { throw unavailable; } });
  await assert.rejects(broken.official({ steamInput: '76561198000000501' }), error => error === unavailable);
});
test('official Steam identity fields are projected to a safe, bounded card',async()=>{
  const providers=createStatsProviders({official:async()=>({raw_stats:{kill_player:3},minutes_played:90,
    steamProfile:{name:'Rust player',avatar:'https://avatars.steamstatic.com/example.jpg',createdAt:'2020-01-01T00:00:00.000Z'}})});
  const raw=await providers.official({steamInput:'76561198000000501'});
  const result=projectQuery(raw,'official',Date.now());
  assert.equal(result.displayName,'Rust player');assert.equal(result.steamProfile.avatar,'https://avatars.steamstatic.com/example.jpg');
  assert.equal(result.steamProfile.createdAt,'2020-01-01T00:00:00.000Z');
  assert.equal(result.rows[0].values.steamTotalSeconds,5400);
  const unsafe=projectQuery({...raw,steamProfile:{avatar:'https://example.com/avatar',createdAt:'invalid'}},'official',Date.now());
  assert.deepEqual(unsafe.steamProfile,{avatar:'',createdAt:null});
});
import { createStatsWriter } from '../server/v2/stats/writer.js';
import { fixture } from './support/v2-stats/fixture.mjs';
const input = {
    steamInput: '76561198000000501',
    serverId: '123',
    providerWipeId: 'period',
    categoryIds: ['pvp']
  },
  options = {
    signal: new AbortController().signal
  };
test('legacy provider payloads normalize official/Vital/Moose and private inventory without member writes', async () => {
  const p = createStatsProviders({
    official: async () => ({
      raw_stats: {
        kill_player: 7,
        deaths: 0
      },
      summary: {
        kdRatio: 999
      },
      minutes_played: 3
    }),
    vital: async () => [{
      context: {
        userId: input.steamInput
      },
      statistics: {
        combat: {
          kills: 12,
          deaths: 2
        },
        farming: {
          gathered: {
            'sulfur.ore': 300
          }
        }
      }
    }],
    moose: async () => ({
      matchedCategories: 1,
      categories: [{
        category: {
          name: 'PVP'
        },
        fields: [{
          id: 'kills',
          label: 'Kills'
        }],
        selectedMatch: {
          values: {
            kills: 12
          }
        }
      }]
    }),
    inventory: async () => ({
      inventoryAvailable: false,
      dlcOwnershipAvailable: false,
      skins: [],
      dlcs: [{
        name: 'Unknown DLC',
        owned: null,
        price: {
          final: 5
        }
      }]
    })
  });
  const official = await p.official(input, options);
  assert.equal(official.rows[0].kills, 7);
  assert.equal(official.rows[0].assists, null);
  const vital = await p.vital(input, options);
  assert.equal(vital.rows[0].sulfur, 300);
  assert.equal(vital.rows[0].assists, null);
  assert.equal((await p.moose(input, options)).fields[0].value, 12);
  const inventory = await p.inventory(input, options);
  assert.equal(inventory.status, 'private');
  assert.equal(inventory.inventory.items[0].quantity, null);
});
test('shared write queue transaction, legacy snapshot and retry after cache failure', async t => {
  const f = fixture({scopeContract:true});
  t.after(() => f.db.close());
  let patches = 0;
  f.service.writeCurrent = createStatsWriter({
    db: f.db,
    runWrite: async fn => fn(),
    patchCache: async () => {
      if (++patches === 1) throw new Error('injected cache failure');
    }
  });
  const preview = f.service.importPreview(f.admin(), {
      wipeId: 'g07_active',
      rows: [{
        steamId: input.steamInput,
        kills: 8
      }]
    }),
    body = {
      wipeId: 'g07_active',
      ...preview
    };
  await assert.rejects(f.service.import(f.admin(), body, 'cache-retry'), /cache failure/);
  const replay = await f.service.import(f.admin(), body, 'cache-retry');
  assert.equal(replay.replayed, true);
  assert.equal(patches, 2);
  assert.equal(f.db.prepare("SELECT COUNT(*) n FROM json_records WHERE collection='kdaSnapshots'").get().n, 1);
});
