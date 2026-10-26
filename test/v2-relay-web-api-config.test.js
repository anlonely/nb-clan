import './support/owner-environment.mjs';
import './support/v2-source-main/offline.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import express from 'express';
import { fixture } from './support/v2-relay-admin/fixture.mjs';
import { createRustgoWebApiConfig } from '../server/v2/relay-admin/web-api-config.js';
import { createRelayAdmin, createRelayAdminRouter } from '../server/v2/relay-admin/index.js';
import { createIdentityRouter } from '../server/v2/identity/routes.js';
import { createSystemPasswordProofAdapter } from '../server/v2/system-admin/password-proof.js';
import { runStoreWriteTask } from '../server/store.js';

const keyA = 'fixture-rustgo-api-key-alpha', keyB = 'fixture-rustgo-api-key-bravo';
const serverId = 'fixture-server-1';
const input = (extra = {}) => ({ expectedRevision: 0, baseUrl: 'https://rustgo.example.test', tenantId: '',
  apiKey: keyA, serverIds: [serverId], infoEnabled: true, chatEnabled: false, ...extra });
const error = errorCode => ({ errorCode });
const deferred = () => { let resolve; return { promise: new Promise(r => { resolve = r; }), resolve }; };

async function setup(t, options = {}) {
  const f = await fixture(); f.repo.put('accounts', { ...f.repo.get('accounts', 'root'), adminAssignedByOwner: true });
  const api = createRustgoWebApiConfig({ identity: f.identity, ...options }); api.start();
  t.after(async () => { await api.stop(); await f.close(); });
  const save = (changes = {}, id = randomUUID(), actor = 'root') => Promise.resolve().then(() =>
    api.save(f.actor(actor), input({ expectedRevision: api.readPrivate().revision, ...changes }), id));
  return { ...f, api, save };
}

test('Web API reads are write-free and expose status without credentials; owner/admin gates apply', async t => {
  const f = await setup(t, { readStatus: () => ({ state: 'idle' }) });
  const before = f.db.prepare('SELECT total_changes() n').get().n;
  assert.deepEqual(f.api.read(f.actor('root')), { revision: 0, baseUrl: '', tenantId: '', apiKeyConfigured: false,
    serverIds: [], infoEnabled: false, chatEnabled: false, lastOperationId: null, canWrite: true, status: { state: 'idle' } });
  f.api.read(f.actor('root'));
  assert.equal(f.db.prepare('SELECT total_changes() n').get().n, before);
  for (const actor of ['viewer', 'api_edit', 'tools_edit', 'native_api']) {
    assert.throws(() => f.api.read(f.actor(actor)), error('ACCESS_DENIED'));
    await assert.rejects(f.save({}, randomUUID(), actor), error('ACCESS_DENIED'));
  }
  const admin = f.repo.get('accounts', 'admin'); f.repo.put('accounts', { ...admin, adminAssignedByOwner: true });
  assert.equal(f.api.read(f.actor('admin')).canWrite, true);
  const settings = f.repo.scalar('settings'); await f.save();
  assert.deepEqual(f.repo.scalar('settings'), settings);
  assert.equal(f.api.readPrivate().apiKey, keyA);
  assert.equal(f.api.read(f.actor('root')).apiKeyConfigured, true);
  assert.equal(f.counters().patches, 0);
});

test('configuration, HMAC receipts and audits commit atomically and durable replays never expose or rotate secrets', async t => {
  const f = await setup(t), id = randomUUID(), submitted = input();
  const saved = await f.api.save(f.actor('root'), submitted, id);
  const privateSaved = f.api.readPrivate();
  assert.equal(saved.lastOperationId, id); assert.equal(saved.revision, 1);
  assert.equal(saved.action, 'web-api-save'); assert.equal(saved.state, 'succeeded');
  const replay = await f.api.save(f.actor('root'), submitted, id.toUpperCase());
  assert.equal(replay.replayed, true); assert.deepEqual(f.api.readPrivate(), privateSaved);
  await assert.rejects(f.save({ apiKey: keyB }, id), error('OPERATION_CONFLICT'));
  const operations = f.db.prepare('SELECT * FROM v2_relay_admin_operations').all();
  const audits = f.db.prepare('SELECT * FROM v2_relay_admin_audits').all();
  assert.equal(operations.length, 1); assert.equal(audits.length, 1);
  const exposed = JSON.stringify([saved, replay, operations, audits, f.api.read(f.actor('root')), f.api.getOperation(f.actor('root'), id)]);
  assert.ok(!exposed.includes(keyA)); assert.ok(!exposed.includes(keyB));
  assert.ok(!exposed.includes(f.service.repo.signatureKey));
  const next = createRustgoWebApiConfig({ identity: f.identity }); next.start(); t.after(() => next.stop());
  assert.equal((await next.save(f.actor('root'), submitted, id)).replayed, true);
  assert.equal(next.getOperation(f.actor('root'), id).lastOperationId, id);
});

test('blank key retains stored secret, target changes require a new key, and explicit clearing requires disabled switches', async t => {
  const f = await setup(t); await f.save();
  await f.save({ apiKey: '   ', chatEnabled: true }); assert.equal(f.api.readPrivate().apiKey, keyA);
  await assert.rejects(f.save({ baseUrl: 'https://other-rustgo.example.test', apiKey: '' }), error('WEB_API_NEW_KEY_REQUIRED'));
  await assert.rejects(f.save({ tenantId: 'different-tenant', apiKey: undefined }), error('WEB_API_NEW_KEY_REQUIRED'));
  await f.save({ baseUrl: 'https://other-rustgo.example.test', apiKey: keyB }); assert.equal(f.api.readPrivate().apiKey, keyB);
  await assert.rejects(f.save({ apiKey: '', clearApiKey: true }), error('WEB_API_DISABLE_BEFORE_CLEAR'));
  await f.save({ apiKey: '', clearApiKey: true, infoEnabled: false, chatEnabled: false });
  assert.equal(f.api.readPrivate().apiKey, ''); assert.equal(f.api.read(f.actor('root')).apiKeyConfigured, false);
});

test('independent switches require a connection and safe selected IDs only when enabled', async t => {
  const f = await setup(t);
  await f.save({ baseUrl: '', tenantId: '', apiKey: '', serverIds: [], infoEnabled: false });
  for (const changes of [{ apiKey: '' }, { serverIds: [] }, { serverIds: ['../private'] }, { serverIds: ['x/y'] },
    { serverIds: ['x'.repeat(129)] }, { serverIds: Array.from({ length: 21 }, (_, i) => 's' + i) }, { infoEnabled: 'true' }, { unknown: true }]) {
    await assert.rejects(f.save(changes));
  }
  await f.save({ infoEnabled: false, chatEnabled: true, serverIds: [serverId, serverId] });
  assert.equal(f.api.readPrivate().infoEnabled, false); assert.equal(f.api.readPrivate().chatEnabled, true);
  assert.deepEqual(f.api.readPrivate().serverIds, [serverId]);
});

test('activation timestamps preserve existing streams and fence newly enabled chat, new servers and changed sources', async t => {
  const f = await setup(t); await f.save({ chatEnabled: true });
  const first = f.api.readPrivate(); assert.ok(Number.isFinite(Date.parse(first.chatStartAt)));
  assert.equal(first.serverActivatedAt[serverId], first.updatedAt);
  await f.save({ chatEnabled: true, serverIds: [serverId, 'fixture-server-2'] });
  const selected = f.api.readPrivate();
  assert.equal(selected.chatStartAt, first.chatStartAt); assert.equal(selected.serverActivatedAt[serverId], first.serverActivatedAt[serverId]);
  assert.equal(selected.serverActivatedAt['fixture-server-2'], selected.updatedAt);
  await f.save({ chatEnabled: false }); await f.save({ chatEnabled: true });
  const enabled = f.api.readPrivate(); assert.equal(enabled.chatStartAt, enabled.updatedAt);
  assert.deepEqual(Object.keys(enabled.serverActivatedAt), [serverId]);
  await f.save({ baseUrl: 'https://another-rustgo.example.test', apiKey: keyB, chatEnabled: true });
  const changed = f.api.readPrivate(); assert.equal(changed.chatStartAt, changed.updatedAt); assert.equal(changed.serverActivatedAt[serverId], changed.updatedAt);
  const publicText = JSON.stringify(f.api.read(f.actor('root')));
  assert.ok(!publicText.includes('serverActivatedAt')); assert.ok(!publicText.includes('chatStartAt'));
});

test('revision conflict and audit failure leave canonical configuration unchanged', async t => {
  const f = await setup(t), submitted = input();
  const results = await Promise.allSettled([f.api.save(f.actor('root'), submitted, randomUUID()),
    f.api.save(f.actor('root'), { ...submitted, apiKey: keyB }, randomUUID())]);
  assert.equal(results.filter(r => r.status === 'fulfilled').length, 1);
  assert.equal(results.find(r => r.status === 'rejected').reason.errorCode, 'REVISION_CONFLICT');
  const before = f.api.readPrivate();
  f.db.exec("CREATE TEMP TRIGGER web_api_fail BEFORE INSERT ON v2_relay_admin_audits BEGIN SELECT RAISE(ABORT,'fixture-rustgo-api-key-alpha'); END");
  await assert.rejects(f.save({ apiKey: keyB }), e => e.errorCode === 'RELAY_ADMIN_UNAVAILABLE' && !String(e).includes(keyA));
  assert.deepEqual(f.api.readPrivate(), before);
  assert.equal(f.db.prepare('SELECT count(*) n FROM v2_relay_admin_operations').get().n, 1);
});

test('queue and replay revalidate current permissions and the authenticated session', async t => {
  for (const mode of ['permission', 'session', 'stop']) {
    const gate = deferred(), entered = deferred();
    const f = await setup(t, { runStoreWriteTask: async fn => { entered.resolve(); await gate.promise; return fn(); } });
    const actor = f.actor('root'), id = randomUUID();
    const writing = f.api.save(actor, input(), id, mode === 'session' ? { authenticate: async () => { throw Object.assign(Error(keyA), { errorCode: 'SESSION_EXPIRED', status: 401 }); } } : {});
    const rejected = assert.rejects(writing, e => ['AUTH_CHANGED', 'SESSION_EXPIRED', 'RELAY_ADMIN_STOPPED'].includes(e.errorCode));
    await entered.promise;
    assert.throws(() => f.api.getOperation(actor, id), error('OPERATION_IN_PROGRESS'));
    assert.throws(() => f.api.save(actor, input(), id), error('OPERATION_IN_PROGRESS'));
    if (mode === 'permission') { const account = f.repo.get('accounts', 'root'); f.repo.put('accounts', { ...account, permissionVersion: account.permissionVersion + 1 }); }
    const stopping = mode === 'stop' ? f.api.stop() : null;
    gate.resolve(); await rejected; await stopping; assert.equal(f.api.readPrivate().revision, 0);
  }
  const f = await setup(t), id = randomUUID(), actor = f.actor('root'); await f.api.save(actor, input(), id);
  const account = f.repo.get('accounts', 'root'); f.repo.put('accounts', { ...account, permissionVersion: account.permissionVersion + 1 });
  assert.throws(() => f.api.save(actor, input(), id), error('AUTH_CHANGED'));
  assert.throws(() => f.api.getOperation(actor, id), error('AUTH_CHANGED'));
});

test('discovery reuses stored key without writing and limits concurrency, redacts failures and rechecks access', async t => {
  const gate = deferred(), entered = deferred(); let calls = 0, mode = 'ok', seen;
  const f = await setup(t, { discoverServers: async config => {
    seen = config; calls++; entered.resolve(); await gate.promise;
    if (mode === 'error') throw Error('remote echoed ' + config.apiKey);
    return { items: [{ id: serverId, name: 'Running Rust server', state: 'running' }], checkedAt: new Date().toISOString() };
  } });
  await f.save(); const before = f.db.prepare('SELECT total_changes() n').get().n;
  const connection = { baseUrl: 'https://rustgo.example.test', tenantId: '' }, actor = f.actor('root');
  const one = f.api.servers(actor, connection), two = f.api.servers(actor, connection); await entered.promise;
  assert.throws(() => f.api.servers(actor, connection), error('RELAY_ADMIN_BUSY'));
  gate.resolve(); const results = await Promise.all([one, two]);
  assert.equal(calls, 2); assert.equal(seen.apiKey, keyA); assert.equal(results[0].items.length, 1);
  assert.equal(f.db.prepare('SELECT total_changes() n').get().n, before);
  mode = 'error'; await assert.rejects(f.api.servers(actor, connection), e => e.errorCode === 'RELAY_ADMIN_UNAVAILABLE' && !String(e).includes(keyA));
  await assert.rejects(f.api.servers(actor, connection, { authenticate: async () => ({ actor: { ...actor, permissionVersion: actor.permissionVersion + 1 } }) }), error('AUTH_CHANGED'));
  assert.equal(calls, 3);
});

test('discovery does not return data after permissions change while upstream is running', async t => {
  const gate = deferred(), entered = deferred();
  const f = await setup(t, { discoverServers: async () => { entered.resolve(); await gate.promise; return { items: [{ id: serverId }] }; } });
  const request = f.api.servers(f.actor('root'), { baseUrl: 'https://rustgo.example.test', apiKey: keyA });
  const rejected = assert.rejects(request, error('AUTH_CHANGED')); await entered.promise;
  const account = f.repo.get('accounts', 'root'); f.repo.put('accounts', { ...account, permissionVersion: account.permissionVersion + 1 });
  gate.resolve(); await rejected;
});

async function setupHttp(t) {
  const f = await fixture(), app = express(), server = createServer(app);
  const account = { ...f.repo.get('accounts', 'root'), adminAssignedByOwner: true, memberId: 'web-api-http-member' };
  f.repo.put('accounts', account);
  f.repo.put('members', { id: account.memberId, steamId: '76561198999999001', membershipStatus: 'active', revision: 1 });
  f.repo.put('bindings', { id: 'web-api-http-binding', accountId: account.id, memberId: account.memberId, steamId: '76561198999999001', status: 'verified', revision: 1 });
  f.repo.put('identities', { id: 'web-api-http-kook', accountId: account.id, provider: 'kook', externalId: 'web-api-http-kook' });
  f.repo.put('policies', { id: 'web-api-http-kook-policy', provider: 'kook', enabled: true, guildId: 'web-api-http-guild', allowedRoleIds: ['member'], matchMode: 'any', policyRevision: 1 });
  const evidence = { id: 'web-api-http-evidence', provider: 'kook', externalId: 'web-api-http-kook', guildId: 'web-api-http-guild', status: 'eligible', policyRevision: 1,
    checkedAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 3600000).toISOString() };
  f.repo.put('eligibility', evidence);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const auth = createIdentityRouter({ service: f.identity, contexts: f.contexts, origin, providers: {},
    passwordProof: createSystemPasswordProofAdapter(f.identity), writeIdentity: runStoreWriteTask });
  let discoveries = 0;
  const service = createRelayAdmin({ identity: f.identity, invalidateRelayAuthCache: f.invalidateRelayAuthCache, patchStoreCache: f.patchStoreCache,
    webApiOptions: { discoverServers: async () => { discoveries++; return { items: [{ id: serverId, name: 'Running Rust server', state: 'running' }] }; } } }); service.start();
  app.use('/api/v2', (req, res, next) => { req.v2Identity = { service: f.identity, authenticate: opts => auth.authenticate(opts)(req) }; auth(req, res, next); });
  app.use('/api/v2', createRelayAdminRouter({ service }));
  t.after(async () => { await auth.stopEvents(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); await service.stop(); await f.close(); });
  const session = f.identity.issueSession(account, evidence);
  const request = async (path = '', { method = 'GET', input: bodyInput, raw, csrf = true, requestOrigin = origin, authenticated = true, id = randomUUID() } = {}) => {
    const res = await fetch(origin + '/api/v2/relay-admin/web-api' + path, { method,
      headers: { ...(authenticated ? { Cookie: `nb_v2_session=${session.token}` } : {}),
        ...(method === 'POST' ? { 'Content-Type': 'application/json', 'Idempotency-Key': id, Origin: requestOrigin,
          ...(csrf ? { 'X-CSRF-Token': session.csrfToken } : {}) } : {}) },
      ...(method === 'POST' ? { body: raw ?? JSON.stringify({ input: bodyInput }) } : {}) });
    return { status: res.status, headers: res.headers, body: await res.json() };
  };
  return { ...f, service, request, discoveries: () => discoveries };
}

test('Web API HTTP endpoints enforce cookie/Origin/CSRF, safe request sizes and secret-free idempotent receipts', async t => {
  const f = await setupHttp(t);
  assert.equal((await f.request('', { authenticated: false })).status, 401);
  const read = await f.request(); assert.equal(read.status, 200); assert.equal(read.headers.get('cache-control'), 'no-store');
  assert.equal(read.body.meta.schemaVersion, 1);
  for (const path of ['/servers', '/config']) {
    const submitted = path === '/config' ? input() : { baseUrl: input().baseUrl, apiKey: keyA };
    for (const opts of [{ csrf: false }, { requestOrigin: 'https://untrusted.example.test' }])
      assert.equal((await f.request(path, { method: 'POST', input: submitted, ...opts })).status, 403);
  }
  assert.equal(f.discoveries(), 0); assert.equal(f.service.webApi.readPrivate().revision, 0);
  for (const raw of ['{"input":', JSON.stringify({ input: { ...input(), extra: keyA } }), JSON.stringify({ input: { ...input(), apiKey: 'x'.repeat(17000) } })]) {
    const res = await f.request('/config', { method: 'POST', raw }); assert.ok(res.status >= 400); assert.ok(!JSON.stringify(res).includes(keyA));
  }
  const id = randomUUID(), saved = await f.request('/config', { method: 'POST', input: input(), id });
  assert.equal(saved.status, 200); assert.equal(saved.body.data.lastOperationId, id);
  assert.equal((await f.request('/config', { method: 'POST', input: input(), id })).body.data.replayed, true);
  const receipt = await f.request('/operations/' + id); assert.equal(receipt.status, 200); assert.equal(receipt.body.data.state, 'succeeded');
  assert.ok(!JSON.stringify([saved, receipt, await f.request()]).includes(keyA));
  assert.equal((await f.request('/servers', { method: 'POST', input: { baseUrl: input().baseUrl } })).body.data.items.length, 1);
  assert.equal(f.discoveries(), 1);
  assert.equal(f.db.prepare('SELECT count(*) n FROM v2_relay_admin_audits').get().n, 1);
});
