import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createRustgoWebApiClient, normalizeRustgoConnection } from '../server/v2/relay-admin/web-api-client.js';

test('Web and direct gateway addresses normalize idempotently; unsafe URLs and header material are rejected', () => {
  for (const [url, expected] of [['https://rustgo.test', 'https://rustgo.test/api/v1'], ['https://rustgo.test/api/', 'https://rustgo.test/api/v1'],
    ['https://gateway.test/v1', 'https://gateway.test/v1'], ['http://127.0.0.1:4321/v1', 'http://127.0.0.1:4321/v1']]) {
    const c = normalizeRustgoConnection({ baseUrl: url, apiKey: 'fixture-key' });
    assert.equal(c.baseUrl, expected); assert.deepEqual(normalizeRustgoConnection(c), c);
  }
  for (const baseUrl of ['file:///tmp/token', 'http://remote.test', 'https://user:password@remote.test', 'https://remote.test?key=secret',
    'https://remote.test/#secret', 'https://169.254.169.254/v1', 'https://[fe80::1]/v1', 'https://0.0.0.0/v1']) {
    assert.throws(() => normalizeRustgoConnection({ baseUrl }));
  }
  assert.throws(() => normalizeRustgoConnection({ apiKey: 'secret\r\nInjected: bad' }));
  assert.throws(() => normalizeRustgoConnection({ tenantId: '../tenant' }));
});

test('real HTTP reads forward a secret only as Bearer, project running servers and use the clan history contract', async t => {
  const calls = [], key = 'constructed-key', server = createServer((req, res) => {
    calls.push({ url: req.url, method: req.method, auth: req.headers.authorization, tenant: req.headers['x-tenant-id'] });
    res.setHeader('Content-Type', 'application/json');
    if (req.url === '/v1/dashboard/overview') res.end(JSON.stringify({ servers: [
      { server: { id: 's1', name: 'Running' }, monitoring: { state: 'running', primaryPairingId: 'p1', channels: { clan: 'healthy' }, policy: { targetVersion: 4 } } },
      { server: { id: 's2', name: 'Paused' }, monitoring: { state: 'paused', channels: { clan: 'healthy' } } }
    ] }));
    else if (req.url === '/v1/servers/s1/clan') res.end(JSON.stringify({ state: 'unobserved', members: [] }));
    else res.end(JSON.stringify({ items: [], hasMore: false }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
  const client = createRustgoWebApiClient(), config = { baseUrl: `http://127.0.0.1:${server.address().port}/v1`, apiKey: key, tenantId: '' };
  const listing = await client.listServers(config);
  assert.deepEqual(listing.items, [{ id: 's1', name: 'Running', state: 'running', primaryPairingId: 'p1', clanAvailable: true, targetVersion: 4 }]);
  assert.equal((await client.readClan(config, 's1')).state, 'unobserved');
  await client.readChat(config, 's1', { from: '2026-09-27T00:00:00Z', until: '2026-09-27T00:01:00Z', cursor: 'opaque+/=' });
  const query = new URL(calls[2].url, config.baseUrl).searchParams;
  assert.equal(query.get('channel'), 'clan'); assert.equal(query.get('direction'), 'inbound');
  assert.equal(query.get('cursor'), 'opaque+/='); assert.equal(query.get('limit'), '200');
  await client.readInvites(config, 's1', { until: '2026-09-27T00:01:00Z', cursor: 'invite+/=' });
  const inviteURL = new URL(calls[3].url, config.baseUrl);
  assert.equal(inviteURL.pathname, '/v1/servers/s1/clan/invites');
  assert.equal(inviteURL.searchParams.get('cursor'), 'invite+/=');
  assert.equal(inviteURL.searchParams.get('until'), '2026-09-27T00:01:00Z');
  assert.equal(inviteURL.searchParams.get('limit'), '200');
  assert.ok(calls.every(c => c.method === 'GET' && c.auth === `Bearer ${key}` && c.tenant === undefined && !c.url.includes(key)));
  assert.throws(() => client.readChat(config, '../s1', { from: '', until: '' }));
});

test('responses, network errors, redirects and cancellation never surface upstream private text', async () => {
  const config = { baseUrl: 'https://rustgo.test', apiKey: 'secret-key' };
  for (const [status, expected] of [[401, 'WEB_API_UNAUTHORIZED'], [403, 'WEB_API_FORBIDDEN'], [404, 'WEB_API_NOT_FOUND'], [429, 'WEB_API_RATE_LIMITED'], [500, 'WEB_API_UPSTREAM_ERROR']]) {
    const client = createRustgoWebApiClient({ fetchImpl: async () => new Response('secret-key', { status }) });
    await assert.rejects(client.listServers(config), { errorCode: expected });
  }
  for (const body of ['<html>Login secret-key</html>', '{}', '{"servers":null}']) {
    await assert.rejects(createRustgoWebApiClient({ fetchImpl: async () => new Response(body) }).listServers(config), { errorCode: 'WEB_API_INVALID_RESPONSE' });
  }
  const large = createRustgoWebApiClient({ maxBytes: 10, fetchImpl: async () => new Response('{"servers": []}') });
  await assert.rejects(large.listServers(config), { errorCode: 'WEB_API_RESPONSE_TOO_LARGE' });
  const controller = new AbortController(); controller.abort();
  const client = createRustgoWebApiClient({ fetchImpl: async (_url, options) => { assert.equal(options.redirect, 'error'); options.signal.throwIfAborted(); throw Error('secret-key'); } });
  await assert.rejects(client.listServers(config, { signal: controller.signal }), { errorCode: 'WEB_API_REQUEST_ABORTED' });
  await assert.rejects(client.listServers(config), { errorCode: 'WEB_API_UNREACHABLE' });
});
