import { createServer } from 'node:http';
import { fixture as baseFixture } from '../v2-sync-center/fixture.mjs';
import { createBattlemetricsQueueRuntime } from '../../../server/battlemetrics-queue.js';
import { installStatsSchema } from '../../../server/v2/stats/repository.js';
import { createSourceHost } from '../../../server/v2/management-adapters/source-host/index.js';
import { createManagementSourceAdapters, installSourceAdapterSchema } from '../../../server/v2/management-adapters/sources/index.js';
import { readBattlemetricsSessions } from '../../../server/v2/management-adapters/sources/battlemetrics.js';
import { installSourceWindowSchema, createSourceWindow } from '../../../server/v2/management-adapters/source-window/index.js';
import { SyncCenterService } from '../../../server/v2/sync-center/service.js';
import { createSyncCenterWorker } from '../../../server/v2/sync-center/worker.js';
export const scope = { kind: 'members', memberIds: ['g05_alpha'], wipeId: 'fixture-wipe' };
export async function fixture(options = {}) {
  let clock = Math.floor(Date.now() / 1000) * 1000; const now = () => clock;
  const base = baseFixture({ filename: options.filename || ':memory:', now }); await base.worker.stop();
  installStatsSchema(base.db); installSourceAdapterSchema(base.db); installSourceWindowSchema(base.db);
  base.repo.setScalar('settings', { battlemetrics: { apiKey: 'fixture-bm-key-window-secret' }, system: { proxy: {} } });
  const start = new Date(clock - 3600000).toISOString();
  base.repo.put('schedulingWipes', { ...base.repo.get('schedulingWipes','fixture-wipe'), revision: 1,
    serverProfileId: 'fixture-server', serverActualWipeAt: start, serverSnapshot: { battlemetricsId: '501' } });
  for (const [index, member] of base.repo.all('members').entries()) base.repo.put('members', { ...member, battlemetricsId: String(601 + index) });
  const calls = [], behavior = { handler: null };
  const upstream = createServer(async (req, res) => {
    calls.push({ url: req.url, method: req.method });
    res.setHeader('content-type', 'application/json');
    if (behavior.handler) return behavior.handler(req, res);
    res.end(JSON.stringify({ data: [{ attributes: { start, stop: null }, relationships: { server: { data: { id: '501' } } } }] }));
  });
  await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${upstream.address().port}`;
  let tail = Promise.resolve(); const cache = new Map();
  const runWrite = fn => { const p = tail.then(fn); tail = p.catch(() => {}); return p; };
  const queue = createBattlemetricsQueueRuntime({ minIntervalMs: 0, requestsPerMinute: 1000 });
  let host, windows; const instances = [];
  function create(identity = base.identity) {
    windows = createSourceWindow({ identity, now, readSourceConfig: input => host.readSourceConfig(input) });
    host = createSourceHost({ readSettings: () => identity.repo.scalar('settings'), readWipe: id => identity.repo.get('schedulingWipes', id),
      readWindow: windows.readWindow, sharedBattlemetricsQueue: queue, fetchImpl: fetch, capabilities: { battlemetrics: true },
      origins: { battlemetrics: origin }, allowLoopbackForTests: true });
    const sources = createManagementSourceAdapters({ identity, now, runWrite, patchCache: rows => { for (const row of rows) cache.set(row.id, row.record); },
      authorizeStatsWrite: () => true, ...host, captureSourceWindow: windows.captureSourceWindow,
      // Keep the real bounded HTTP reader/parser; only its observation clock follows the controlled test clock.
      readers: { ...host.readers, battlemetricsSessions: async input => ({ ...await readBattlemetricsSessions(input), observedAt: new Date(now()).toISOString() }) } });
    const service = new SyncCenterService({ db: identity.repo.db, identity, authority: sources.authority, now });
    const worker = createSyncCenterWorker(service, { providers: sources.providers, workerId: 'source-window-fixture' });
    const value = { sources, service, worker, host, windows }; instances.push(value); return value;
  }
  const composed = create();
  await composed.service.saveSource(base.actor(), 'battlemetrics', { expectedRevision: 1, minIntervalMs: 0, maxAttempts: 1 }, { operationId: 'window-source-settings' });
  return { ...base, ...composed, create, queue, cache, calls, behavior, origin, start, now,
    advance: ms => { clock += ms; }, runWrite,
    rows: () => base.db.prepare('SELECT * FROM v2_source_windows ORDER BY created_at,job_id').all(),
    config: s => host.readSourceConfig({ type: 'battlemetrics_playtime', scope: s, member: base.repo.get('members','g05_alpha') }),
    async closeNetwork() { upstream.closeAllConnections(); await new Promise(r => upstream.close(r)); },
    async close() { for (const instance of instances) { await instance.worker.stop(); await instance.host.stop(); } await tail; upstream.closeAllConnections(); await new Promise(r => upstream.close(r)); base.db.close(); }
  };
}
