import test from 'node:test';
import assert from 'node:assert/strict';
import { createSourceHost } from '../server/v2/management-adapters/source-host/index.js';
import { createSourceConfiguration } from '../server/v2/management-adapters/source-host/config.js';

test('inventory uses the host-resolved proxy node and fences a node change', async () => {
  const settings = { system: { proxy: { nodeId: '0123456789abcdef', scope: 'global', url: '' } } };
  let proxy = 'http://nb-egress:18001';
  const calls = [], services = [];
  const host = createSourceHost({
    readSettings: () => settings, readWipe: () => null,
    readProxyUrl: service => { services.push(service); return proxy; },
    fetchImpl: () => assert.fail('a selected node must not fall back to direct access'),
    proxyFetch: async (_url, options) => {
      calls.push(options.proxyUrl);
      return new Response(JSON.stringify({ success: 1, assets: [], descriptions: [] }));
    },
    capabilities: { inventory: true, memberRisk: true }
  });
  try {
    const config = host.readSourceConfig({ type: 'member_profile', member: { id: 'm', steamId: '76561198000000501' } });
    const read = () => host.readers.stats.inventory('76561198000000501', { inventoryOnly: true, expectedCredentialsHash: config.credentialBindings.community });
    assert.equal((await read()).inventoryComplete, true);
    assert.deepEqual(calls, ['http://nb-egress:18001']);
    assert.ok(services.includes('kda'));
    proxy = 'http://nb-egress:18002';
    await assert.rejects(read(), e => e.errorCode === 'CREDENTIALS_CHANGED');
    assert.equal(calls.length, 1);
  } finally { await host.stop(); }
});

test('an unresolved selected node fails closed while KOOK remains direct', () => {
  const config = createSourceConfiguration({ readSettings: () => ({ system: { proxy: { nodeId: '0123456789abcdef', scope: 'global' } } }), readWipe: () => null });
  assert.throws(() => config.credentials('community'), e => e.errorCode === 'PROXY_UNAVAILABLE');
  assert.equal(config.credentials('kook').proxyUrl, '');
});

test('an empty resolved selected node never silently falls back to direct HTTP', async () => {
  const host = createSourceHost({
    readSettings: () => ({ system: { proxy: { nodeId: '0123456789abcdef', scope: 'global' } } }),
    readWipe: () => null, readProxyUrl: () => '', capabilities: { inventory: true },
    fetchImpl: () => assert.fail('empty selected proxy must not make a direct request')
  });
  try {
    await assert.rejects(host.readers.stats.inventory('76561198000000501', { inventoryOnly: true }), { errorCode: 'PROXY_UNAVAILABLE' });
  } finally { await host.stop(); }
});

test('manual URL and environment proxy precedence remains available without node resolver', () => {
  const settings = { system: { proxy: { url: 'http://manual.example:3128', scope: 'battlemetrics' } } };
  const config = createSourceConfiguration({ readSettings: () => settings, readWipe: () => null,
    readCredentials: () => ({ kdaProxyUrl: 'http://kda.example:3128', proxyUrl: 'http://global.example:3128' }) });
  assert.equal(config.credentials('community').proxyUrl, 'http://kda.example:3128');
  assert.equal(config.credentials('battlemetrics').proxyUrl, 'http://manual.example:3128');
  assert.equal(config.credentials('discord').proxyUrl, 'http://global.example:3128');
});

test('master switch skips disabled node resolution and every injected proxy credential', () => {
  const settings = { system: { proxy: { enabled: false, nodeId: '0123456789abcdef', scope: 'global' } } };
  const options = { readSettings: () => settings, readWipe: () => null,
    readCredentials: () => ({ steamApiKey: 'steam-key', battlemetricsApiKey: 'bm-key', discordBotToken: 'discord-token',
      proxyUrl: 'invalid', kdaProxyUrl: 'invalid', battlemetricsProxyUrl: 'invalid', discordProxyUrl: 'invalid' }) };
  for (const readProxyUrl of [undefined, () => assert.fail('disabled proxy must not resolve an inactive node')]) {
    const config = createSourceConfiguration({ ...options, readProxyUrl });
    for (const source of ['steam', 'community', 'store', 'battlemetrics', 'discord', 'vital', 'kook']) {
      assert.equal(config.credentials(source).proxyUrl, '');
    }
    assert.equal(config.credentials('steam').key, 'steam-key');
    assert.equal(config.credentials('battlemetrics').key, 'bm-key');
    assert.equal(config.credentials('discord').key, 'discord-token');
  }
  const config = createSourceConfiguration({ ...options, readProxyUrl: () => 'http://saved.example:3128' });
  settings.system.proxy.enabled = true;
  assert.equal(config.credentials('community').proxyUrl, 'http://saved.example:3128');
});

test('inventory becomes direct while disabled and rejects a stale credential binding after re-enable', async () => {
  const settings = { system: { proxy: { enabled: false, nodeId: '0123456789abcdef', scope: 'global' } } };
  const calls = [];
  const host = createSourceHost({
    readSettings: () => settings, readWipe: () => null,
    readProxyUrl: () => 'http://saved.example:3128',
    readCredentials: () => ({ proxyUrl: 'http://injected.example:3128' }),
    capabilities: { inventory: true, memberRisk: true },
    fetchImpl: async (_url, options) => { calls.push(options); return new Response(JSON.stringify({ success: 1, assets: [], descriptions: [] })); },
    proxyFetch: () => assert.fail('disabled or stale-bound inventory must not use a proxy')
  });
  try {
    const config = host.readSourceConfig({ type: 'member_profile', member: { id: 'm', steamId: '76561198000000501' } });
    const read = () => host.readers.stats.inventory('76561198000000501', { inventoryOnly: true, expectedCredentialsHash: config.credentialBindings.community });
    assert.equal((await read()).inventoryComplete, true);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].proxyUrl, undefined);
    settings.system.proxy.enabled = true;
    await assert.rejects(read(), { errorCode: 'CREDENTIALS_CHANGED' });
    assert.equal(calls.length, 1);
  } finally { await host.stop(); }
});
