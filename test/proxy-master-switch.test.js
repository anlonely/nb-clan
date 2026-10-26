import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import http from 'node:http';
import https from 'node:https';
import os from 'node:os';
import path from 'node:path';

test('proxy master switch overrides saved nodes, environment and stale request options', async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'nb-proxy-master-switch-'));
  const environment = {
    NB_DATA_DIR: directory,
    NB_SQLITE_FILE: path.join(directory, 'fixture.sqlite'),
    NB_DISABLE_BACKGROUND_JOBS: '1',
    NB_DISABLE_EXTERNAL_VITAL: '1',
    NB_DISABLE_EXTERNAL_ATLAS: '1',
    NB_PROXY_URL: 'http://global.example:3128',
    NB_BATTLEMETRICS_PROXY_URL: 'http://bm.example:3128',
    NB_KDA_PROXY_URL: 'http://kda.example:3128'
  };
  const previous = Object.fromEntries(Object.keys(environment).map(key => [key, process.env[key]]));
  Object.assign(process.env, environment);
  const denyNetwork = () => assert.fail('proxy switch tests must not access the network');
  t.mock.method(http, 'request', denyNetwork);
  t.mock.method(https, 'request', denyNetwork);
  t.mock.method(globalThis, 'fetch', denyNetwork);
  try {
    const { createProductionNetwork } = await import('../server/v2/production/network.js');
    const { proxySettingForService, systemSettingsPayload } = await import('../server/api.js');
    const { battlemetricsProxyUrl, createBattlemetricsFetch } = await import('../scripts/battlemetrics-player-hours.js');
    const proxy = { enabled: false, nodeId: '0123456789abcdef', url: 'http://saved.example:3128', scope: 'global' };
    const settings = { system: { proxy } }, store = { settings };
    const calls = [];
    const network = createProductionNetwork({ readSettings: () => settings, env: environment,
      fetchImpl: async (url, options) => { calls.push({ url, options }); return new Response('{}'); } });
    try {
      await t.test('disabled production traffic ignores missing nodes, every environment fallback and stale explicit URLs', async () => {
        const before = structuredClone(proxy);
        for (const service of ['global', 'battlemetrics', 'kda', 'discord', 'rustgo']) {
          assert.equal(network.proxyFor(service), '');
          await network.serviceFetch(service, 'https://upstream.example/');
          assert.equal(calls.at(-1).options.agent, undefined);
        }
        await network.proxyFetch('https://upstream.example/', { proxyUrl: 'invalid old proxy', agent: {} });
        assert.equal(calls.at(-1).options.agent, undefined);
        assert.equal('proxyUrl' in calls.at(-1).options, false);
        assert.deepEqual(proxy, before, 'disabling must preserve the configured node and URL');
      });

      await t.test('legacy configuration remains readable with a missing disabled node and has no effective proxy', async () => {
        for (const service of ['battlemetrics', 'kda', 'global']) assert.equal(proxySettingForService(store, service).url, '');
        const payload = await systemSettingsPayload(store, { includeSensitive: true });
        assert.equal(payload.proxy.enabled, false);
        assert.equal(payload.proxy.battlemetricsActive, false);
        assert.equal(payload.proxy.kdaActive, false);
        assert.equal(payload.proxy.source, '');
        assert.equal(payload.proxy.url, 'http://saved.example:3128');
        assert.equal((await systemSettingsPayload(store)).proxy.url, '');
        assert.equal(battlemetricsProxyUrl(store), '');
      });

      await t.test('re-enabling restores saved nodes and disabling again blocks an already captured URL', async () => {
        proxy.enabled = true;
        assert.throws(() => network.proxyFor('kda'), { errorCode: 'PROXY_UNAVAILABLE' });
        assert.throws(() => proxySettingForService(store, 'kda'), /PROXY_NODE_UNAVAILABLE/);
        await writeFile(path.join(directory, 'proxy-nodes.json'), JSON.stringify({ version: 1,
          nodes: [{ id: proxy.nodeId, name: 'Test egress', port: 18001 }] }));
        const captured = network.proxyFor('kda');
        assert.equal(captured, 'http://nb-egress:18001');
        assert.equal(proxySettingForService(store, 'battlemetrics').url, captured);
        await network.serviceFetch('kda', 'https://upstream.example/');
        assert.ok(calls.at(-1).options.agent);
        proxy.enabled = false;
        await network.proxyFetch('https://upstream.example/', { proxyUrl: captured });
        assert.equal(calls.at(-1).options.agent, undefined);
      });

      await t.test('an absent switch keeps previous manual URL, scoped environment and CLI behavior', () => {
        delete proxy.enabled;
        delete proxy.nodeId;
        proxy.scope = 'battlemetrics';
        assert.equal(network.proxyFor('battlemetrics'), proxy.url);
        assert.equal(network.proxyFor('kda'), environment.NB_KDA_PROXY_URL);
        assert.equal(network.proxyFor('discord'), environment.NB_PROXY_URL);
        assert.equal(proxySettingForService(store, 'battlemetrics').url, proxy.url);
        assert.equal(proxySettingForService(store, 'kda').url, environment.NB_KDA_PROXY_URL);
        assert.equal(battlemetricsProxyUrl(store), environment.NB_BATTLEMETRICS_PROXY_URL);
        proxy.enabled = false;
        assert.equal(battlemetricsProxyUrl(store), '');
        assert.equal(battlemetricsProxyUrl({ settings: { proxy } }), '', 'legacy CLI settings must also honor the switch');
        proxy.enabled = true;
        assert.equal(battlemetricsProxyUrl(store), environment.NB_BATTLEMETRICS_PROXY_URL);
      });

      await t.test('CLI pagination rechecks the switch and destroys the previous agent before its next request', async () => {
        const requests = [], agents = [];
        let reads = 0, unavailable = false;
        const bmFetch = createBattlemetricsFetch({
          readSettings: async () => { reads++; return unavailable ? { settingsPartial: true } : store; },
          fetchImpl: async (_url, options) => { requests.push(options); return new Response('{}'); },
          agentFactory: url => {
            if (!url) return undefined;
            const agent = { url, destroyed: false, destroy() { this.destroyed = true; } };
            agents.push(agent); return agent;
          }
        });
        proxy.enabled = true;
        await bmFetch('https://upstream.example/page/1');
        assert.equal(requests.at(-1).agent, agents[0]);
        proxy.enabled = false;
        await bmFetch('https://upstream.example/page/2');
        assert.equal(requests.at(-1).agent, undefined);
        assert.equal(agents[0].destroyed, true);
        proxy.enabled = true;
        await bmFetch('https://upstream.example/page/3');
        assert.equal(requests.at(-1).agent, agents[1]);
        assert.equal(agents[1].url, environment.NB_BATTLEMETRICS_PROXY_URL);
        assert.equal(reads, 3);
        unavailable = true;
        await assert.rejects(bmFetch('https://upstream.example/page/4'), /settings are temporarily unavailable/);
        assert.equal(requests.length, 3);
      });
    } finally { network.stop(); }
  } finally {
    const { closeSqliteDatabasesForTests } = await import('../server/storage/sqlite.js');
    await closeSqliteDatabasesForTests();
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    await rm(directory, { recursive: true, force: true });
  }
});
