import { createServer } from 'node:http';
import { fixture as identityFixture } from '../v2-sync-center/fixture.mjs';
import { installStatsSchema } from '../../../server/v2/stats/repository.js';
import { upsertSqliteCollectionRecord } from '../../../server/storage/sqlite-migrate.js';
import { createBattlemetricsQueueRuntime } from '../../../server/battlemetrics-queue.js';
import { createManagementSourceAdapters, installSourceAdapterSchema } from '../../../server/v2/management-adapters/sources/index.js';
import { SyncCenterService } from '../../../server/v2/sync-center/service.js';
import { createSyncCenterWorker } from '../../../server/v2/sync-center/worker.js';

export async function fixture() {
  const f = identityFixture(); await f.worker.stop();
  const put = (collection, row) => upsertSqliteCollectionRecord(f.db, collection, row.id, row);
  const from = new Date(Date.now() - 3600000).toISOString(), to = new Date().toISOString();
  put('v2Wipes', { ...f.repo.get('schedulingWipes', 'fixture-wipe'), revision: 1, serverProfileId: 'host-server', serverSnapshot: { provider: 'vital', vitalServerId: '1' } });
  installStatsSchema(f.db); installSourceAdapterSchema(f.db);
  const calls = [], behaviors = new Map();
  const upstream = createServer(async (req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1'), chunks = [];
    for await (const c of req) chunks.push(c);
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks)) : null;
    calls.push({ path: url.pathname, method: req.method, body });
    const custom = behaviors.get(url.pathname); if (custom) return custom(req, res, body, url);
    res.setHeader('content-type', 'application/json');
    if (url.pathname === '/players/match') {
      const steamId = body.data[0].attributes.identifier;
      return res.end(JSON.stringify({ data: [{ type: 'identifier', attributes: { type: 'steamID', identifier: steamId }, relationships: { player: { data: { type: 'player', id: '501' } } } }], included: [{ type: 'player', id: '501', attributes: { name: 'HTTP member' } }] }));
    }
    if (url.pathname.endsWith('/relationships/sessions')) return res.end(JSON.stringify({ data: [{ attributes: { start: from, stop: to }, relationships: { server: { data: { id: 'bm-server' } } } }, { attributes: { start: from, stop: to }, relationships: { server: { data: { id: 'bm-server' } } } }] }));
    if (url.pathname === '/steam') return res.end(JSON.stringify({ steamId: url.searchParams.get('steamId'), nickname: 'HTTP nickname', avatar: 'https://cdn.example/avatar.png', profileUrl: `https://steamcommunity.com/profiles/${url.searchParams.get('steamId')}`, profilePublic: true, playtimeMinutes: 0 }));
    if (url.pathname === '/vital') return res.end(JSON.stringify([{ context: { userId: url.searchParams.get('steamId') }, player: { name: 'HTTP vital' }, capturedAt: new Date().toISOString(), statistics: { combat: { kills: 0, deaths: 0 }, raiding: { rockets: 0 } } }]));
    if (url.pathname === '/hex') return res.end(JSON.stringify({ steamId: url.searchParams.get('steamId'), observedAt: to, message: { id: 'card-1', embeds: [{ fields: [{ name: 'Rust', value: '0 hours' }, { name: 'Atlas', value: '21 hours' }] }] } }));
    res.statusCode = 404; res.end('{}');
  });
  await new Promise(r => upstream.listen(0, '127.0.0.1', r));
  const origin = `http://127.0.0.1:${upstream.address().port}`;
  const json = async (path, signal) => { const r = await fetch(origin + path, { signal }); if (!r.ok) throw Object.assign(new Error('upstream secret must not leak'), { status: r.status }); return r.json(); };
  let tail = Promise.resolve(); const cache = new Map();
  const runWrite = fn => { const p = tail.then(fn); tail = p.catch(() => {}); return p; };
  const config = { enabled: true, sourceId: 'vital', serverId: 'host-server', providerServerId: '1', providerWipeId: 'period-1', battlemetricsServerId: 'bm-server', from, to };
  const queue = createBattlemetricsQueueRuntime({ minIntervalMs: 0, requestsPerMinute: 1000 });
  const options = {
    identity: f.identity, now: Date.now, runWrite,
    patchCache: records => { for (const r of records) cache.set(`${r.collection}:${r.id}`, r.record); },
    authorizeStatsWrite: () => true,
    readSourceConfig: () => ({ ...config }), battlemetricsQueue: queue,
    readers: {
      battlemetricsGet: (path, { signal, method, body }) => fetch(origin + path, { signal, method, headers: { 'content-type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) }),
      steamProfile: ({ member, signal }) => json(`/steam?steamId=${member.steamId}`, signal),
      hexaytronMessage: ({ member, signal }) => json(`/hex?steamId=${member.steamId}`, signal),
      stats: { vital: ({ playerIds }, { signal }) => json(`/vital?steamId=${playerIds[0]}`, signal), official: async (steamId, { signal }) => { await json(`/steam?steamId=${steamId}`, signal); return { raw_stats: { kill_player: 0, deaths: 0 }, minutes_played: 0 }; } }
    }
  };
  const adapters = createManagementSourceAdapters(options), service = new SyncCenterService({ db: f.db, identity: f.identity, authority: adapters.authority });
  const worker = createSyncCenterWorker(service, { providers: adapters.providers });
  for (const id of ['battlemetrics', 'steam', 'kda']) await service.saveSource(f.actor(), id, { expectedRevision: 1, minIntervalMs: 0 }, { operationId: `source-${id}-setup` });
  return { ...f, put, config, calls, behaviors, options, adapters, service, worker, queue, cache, origin,
    async close() { await worker.stop(); upstream.closeAllConnections(); await new Promise(r => upstream.close(r)); f.db.close(); }
  };
}
