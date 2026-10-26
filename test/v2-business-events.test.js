import { authenticatedSession } from './support/authenticated-session.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import http from 'node:http';
import { EventEmitter } from 'node:events';
import { createFixture } from './support/v2-notifications/fixture.js';
import { createIdentityRouter } from '../server/v2/identity/routes.js';
import { createBusinessEventsHub } from '../server/v2/business-events/index.js';

test('domain invalidation waits for reauthorization and exposes no system payload', async t => {
  const f = await setup(t), stream = await f.open('admin');
  await stream.next('reset');
  f.hub.invalidateDomain(f.identity);
  await f.hub.poll();
  assert.deepEqual((await stream.next('reset')).data, { schemaVersion: 1, scopeVersion: 1, reason: 'domain_changed' });
  f.hub.invalidateDomain(f.identity);
  f.identity.repo.put('accounts', { ...f.identity.repo.get('accounts', 'admin'), status: 'disabled' });
  await f.hub.poll();
  await stream.next('authorization-revoked');
  assert.equal(stream.frames.filter(frame => frame.event === 'reset' && frame.data.reason === 'domain_changed').length, 1);
});

test('catalog invalidation sends only an ID-free reset to current global wipe readers', async t => {
  const f = await setup(t), admin = await f.open('admin'), member = await f.open('a-m1');
  await admin.next('reset'); await member.next('reset');
  f.hub.invalidateCatalog(f.identity);
  await f.hub.poll();
  assert.deepEqual((await admin.next('reset')).data, { schemaVersion: 1, scopeVersion: 1, reason: 'domain_changed' });
  await flush();
  assert.equal(member.frames.filter(frame => frame.event === 'reset' && frame.data.reason === 'domain_changed').length, 0);
  f.hub.invalidateCatalog(f.identity);
  f.identity.repo.put('accounts', { ...f.identity.repo.get('accounts', 'admin'), status: 'disabled' });
  await f.hub.poll(); await admin.next('authorization-revoked');
  assert.equal(admin.frames.filter(frame => frame.event === 'reset' && frame.data.reason === 'domain_changed').length, 1);
});

async function setup(t, options = {}) {
  const f = createFixture(), app = express(), server = http.createServer(app);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const identityRouter = createIdentityRouter({ service: f.identity, origin });
  const hub = createBusinessEventsHub({ intervalMs: 60_000,
    ...(options.notifications === false ? {} : { getNotificationSystem: () => f.system }), ...options.hub });
  app.use('/api/v2', identityRouter);
  app.use('/api/v2', (req, res, next) => {
    req.v2Identity = { service: f.identity, authenticate: () => identityRouter.authenticate()(req) };
    next();
  }, hub.router);
  const streams = [];
  t.after(async () => {
    for (const stream of streams) stream.close();
    await hub.stop(); await identityRouter.stopEvents?.();
    server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); f.close();
  });
  async function token(accountId) { return (await authenticatedSession(f.identity, accountId)).token; }
  async function open(accountId, extra = {}) {
    const headers = { ...(accountId ? { Cookie: `nb_v2_session=${await token(accountId)}` } : {}), ...extra };
    return new Promise((resolve, reject) => {
      const request = http.get(`${origin}/api/v2/events`, { headers }, response => {
        let buffer = ''; const frames = [], waiters = []; let ended = false;
        const stream = { response, frames, close: () => { request.destroy(); response.destroy(); },
          next: (type, timeout = 1500) => {
            const found = frames.find(frame => !frame.consumed && frame.event === type);
            if (found) { found.consumed = true; return Promise.resolve(found); }
            if (ended) return Promise.reject(new Error(`stream closed before ${type}`));
            return new Promise((done, fail) => {
              const waiter = { type, done, fail };
              waiter.timer = setTimeout(() => { waiters.splice(waiters.indexOf(waiter), 1); fail(new Error(`timeout ${type}`)); }, timeout);
              waiters.push(waiter);
            });
          },
          ended: () => ended
        };
        response.setEncoding('utf8');
        response.on('data', chunk => {
          buffer += chunk;
          let index;
          while ((index = buffer.indexOf('\n\n')) >= 0) {
            const raw = buffer.slice(0, index); buffer = buffer.slice(index + 2);
            if (!raw.startsWith('id:')) continue;
            const lines = raw.split('\n'), frame = { raw, id: lines.find(line => line.startsWith('id: '))?.slice(4),
              event: lines.find(line => line.startsWith('event: '))?.slice(7), data: JSON.parse(lines.find(line => line.startsWith('data: ')).slice(6)) };
            frames.push(frame);
            const pending = waiters.find(waiter => waiter.type === frame.event);
            if (pending) { clearTimeout(pending.timer); waiters.splice(waiters.indexOf(pending), 1); frame.consumed = true; pending.done(frame); }
          }
        });
        response.on('close', () => { ended = true; for (const waiter of waiters.splice(0)) { clearTimeout(waiter.timer); waiter.fail(new Error('stream closed')); } });
        streams.push(stream); resolve(stream);
      });
      request.on('error', reject);
    });
  }
  return { ...f, hub, open, origin };
}
const flush = () => new Promise(resolve => setImmediate(resolve));
function changeTitle(f, suffix) {
  const wipe = f.scheduling.repo.get('wipes', f.wipe.id);
  return f.scheduling.updateWipe(f.actor(), wipe.id, { expectedRevision: wipe.revision, title: `Changed ${suffix}` }, f.operation());
}
function openSignups(f) {
  const wipe = f.scheduling.repo.get('wipes', f.wipe.id);
  return f.scheduling.transition(f.actor(), wipe.id, 'reopen-signup', { expectedRevision: wipe.revision, reason: 'isolated test', closesAt: wipe.signupClosesAt }, f.operation());
}
async function accepted(f) {
  const preview = (await f.system.service.createPreview(f.actor(), f.wipe.id, f.input({ targets: [
    { targetId: 'discord-1', language: 'zh-CN', mentionMode: 'none', roleIds: [] },
    { targetId: 'kook-1', language: 'zh-CN', mentionMode: 'none', roleIds: [] }
  ] }), f.operation())).current;
  return f.system.service.createIntent(f.actor(), f.wipe.id, {
    previewId: preview.id, contentHash: preview.contentHash, expectedContentRevision: preview.contentRevision,
    purpose: preview.purpose, purposeInstance: preview.purposeInstance
  }, f.operation());
}

test('real G03-authenticated HTTP SSE emits initial/reconnect reset, ignores forged Last-Event-ID and GET does not mutate domain state', async t => {
  const f = await setup(t), anonymous = await f.open(null);
  assert.equal(anonymous.response.statusCode, 401);
  const before = f.db.prepare("SELECT collection,id,payload_json FROM json_records WHERE collection IN ('v2Wipes','v2SchedulingEvents','v2SchedulingOutbox','v2NotificationChanges') ORDER BY collection,id").all();
  const stream = await f.open('admin', { 'Last-Event-ID': '9223372036854775807;scope=somebody-else' });
  assert.equal(stream.response.statusCode, 200); assert.match(stream.response.headers['content-type'], /text\/event-stream/);
  const reset = await stream.next('reset');
  assert.deepEqual(reset.data, { schemaVersion: 1, scopeVersion: 1, reason: 'reconnect' });
  assert.match(reset.id, /^[a-f0-9-]{36}:1$/); assert.equal(reset.raw.includes('922337'), false);
  await f.hub.poll(); await flush(); assert.equal(stream.frames.filter(frame => frame.event === 'invalidate').length, 0);
  assert.deepEqual(f.db.prepare("SELECT collection,id,payload_json FROM json_records WHERE collection IN ('v2Wipes','v2SchedulingEvents','v2SchedulingOutbox','v2NotificationChanges') ORDER BY collection,id").all(), before);
  changeTitle(f, 'one'); await f.hub.poll();
  assert.deepEqual((await stream.next('invalidate')).data.changes, [{ kind: 'wipe', wipeId: f.wipe.id }]);
});

test('G04 updates work without notifications and inaccessible wipe/member signup events disclose no IDs or counts', async t => {
  const f = await setup(t, { notifications: false }); openSignups(f);
  const member = await f.open('a-m1'), foreign = await f.open('a-m3'), admin = await f.open('admin');
  await Promise.all([member, foreign, admin].map(stream => stream.next('reset')));
  f.scheduling.saveSignup(f.actor('a-m2'), f.wipe.id, 'm2', f.signup(), f.operation());
  await f.hub.poll();
  const visible = (await admin.next('invalidate')).data;
  assert.deepEqual(visible.changes, [{ kind: 'signup', wipeId: f.wipe.id }]);
  await flush(); assert.equal(member.frames.filter(frame => frame.event === 'invalidate').length, 0);
  assert.equal(foreign.frames.filter(frame => frame.event === 'invalidate').length, 0);
  f.scheduling.saveSignup(f.actor('a-m1'), f.wipe.id, 'm1', f.signup(), f.operation());
  await f.hub.poll(); assert.deepEqual((await member.next('invalidate')).data.changes, [{ kind: 'signup', wipeId: f.wipe.id }]);
  for (const stream of [member, foreign, admin]) for (const frame of stream.frames)
    for (const forbidden of ['m1', 'm2', 'actorAccountId', 'memberId', 'before', 'payload', 'Private member', 'operationId']) assert.equal(frame.raw.includes(forbidden), false);
});

test('real B persisted changes are scoped to current targets and delivered IDs, including worker state transitions', async t => {
  const f = await setup(t), limited = await f.open('admin'), member = await f.open('a-m1');
  await limited.next('reset'); await member.next('reset');
  await accepted(f); await f.hub.poll();
  const first = (await limited.next('invalidate')).data.changes;
  assert.equal(first.length, 2); assert.equal(first[0].kind, 'notification');
  assert.deepEqual(first.map(item=>f.system.service.repo.get('deliveries',item.deliveryId).targetId).sort(), ['discord-1','kook-1']);
  await f.system.worker.runOnce({ workerId: 'events-test', limit: 10 }); await f.hub.poll();
  assert.deepEqual((await limited.next('invalidate')).data.changes.map(row=>row.deliveryId).sort(), first.map(row=>row.deliveryId).sort());
  await flush(); assert.equal(member.frames.filter(frame => frame.event === 'invalidate').length, 0);
  for (const frame of limited.frames) for (const forbidden of ['kook-1', 'targetId', 'token', 'messageRef', 'payload', 'cursor']) assert.equal(frame.raw.includes(forbidden), false);
});

test('audience removal resets without disclosing the removed wipe, and target configuration changes clear stale scope', async t => {
  const f = await setup(t), member = await f.open('a-m1'), limited = await f.open('admin');
  await member.next('reset'); await limited.next('reset');
  f.catalog.setTarget('discord-1', { enabled: false, configurationRevision: 2 }); await f.hub.poll();
  assert.deepEqual((await limited.next('reset')).data, { schemaVersion: 1, scopeVersion: 1, reason: 'scope_changed' });
  const wipe = f.scheduling.repo.get('wipes', f.wipe.id);
  f.scheduling.updateWipe(f.actor(), wipe.id, { expectedRevision: wipe.revision,
    audience: { squadIds: ['sq2'], memberIds: [], includeUnassigned: false } }, f.operation());
  await f.hub.poll();
  const reset = await member.next('reset'); assert.equal(reset.data.reason, 'scope_changed'); assert.equal(reset.raw.includes(wipe.id), false);
});

test('permission revocation during async authentication is rechecked before any new business hint', async t => {
  const f = await setup(t), stream = await f.open('limited'); await stream.next('reset');
  const original = f.identity.requireFreshEligibility.bind(f.identity); let release;
  f.identity.requireFreshEligibility = () => new Promise(resolve => { release = resolve; });
  changeTitle(f, 'revocation race'); const polling = f.hub.poll();
  const account = f.identity.repo.get('accounts', 'limited');
  f.identity.repo.put('accounts', { ...account, permissionVersion: account.permissionVersion + 1 });
  release(); await polling; f.identity.requireFreshEligibility = original;
  assert.deepEqual((await stream.next('authorization-revoked')).data, { schemaVersion: 1, scopeVersion: 1 });
  assert.equal(stream.frames.filter(frame => frame.event === 'invalidate').length, 0);
});

test('read-only SQLite stream pumps do not migrate, consume outbox, dispatch jobs or require a notification system', async t => {
  const f = await setup(t, { notifications: false }), stream = await f.open('admin'); await stream.next('reset');
  f.db.exec('PRAGMA query_only=ON'); await f.hub.poll(); f.db.exec('PRAGMA query_only=OFF');
  assert.equal(f.hub.diagnostics().connections, 1); assert.equal(f.transport.calls.length, 0);
  assert.equal(f.scheduling.repo.all('outbox').every(row => row.status === 'pending'), true);
});

test('only one timer serves bounded connections, stopping closes all streams and drains in-flight authentication before DB close', async t => {
  const f = await setup(t, { hub: { maxConnections: 2, maxConnectionsPerAccount: 1 } });
  const first = await f.open('admin'); await first.next('reset');
  const excess = await f.open('admin'); assert.equal(excess.response.statusCode, 503);
  const second = await f.open('limited'); await second.next('reset');
  const full = await f.open('a-m1'); assert.equal(full.response.statusCode, 503);
  assert.equal(f.hub.diagnostics().connections, 2); assert.equal(f.hub.diagnostics().timerActive, true);
  let release; f.identity.requireFreshEligibility = () => new Promise(resolve => { const previous = release; release = () => { previous?.(); resolve(); }; });
  const polling = f.hub.poll(), stopping = f.hub.stop();
  assert.equal(f.hub.diagnostics().connections, 0); assert.equal(f.hub.diagnostics().timerActive, false);
  release(); await polling; await stopping;
  assert.equal(f.hub.diagnostics().pending, 0);
  assert.equal((await f.open('admin')).response.statusCode, 503);
});

test('backpressure closes immediately without retaining an unbounded queue', async () => {
  const f = createFixture(), hub = createBusinessEventsHub({ intervalMs: 60_000 });
  const res = new EventEmitter(); res.destroyed = false; res.writableEnded = false; res.writableLength = 0;
  res.status = () => res; res.set = () => res; res.flushHeaders = () => {}; let frames = 0;
  res.write = () => { frames++; return false; }; res.end = () => { res.writableEnded = true; };
  const req = { method: 'GET', url: '/events', headers: {}, get: () => undefined,
    v2Identity: { service: f.identity, authenticate: async () => ({ actor: f.actor() }) } };
  hub.router(req, res, () => {});
  await flush(); assert.equal(frames, 1); assert.equal(res.writableEnded, true);
  assert.equal(hub.diagnostics().backpressureClosed, 1); assert.equal(hub.diagnostics().connections, 0);
  await hub.stop(); f.close();
});

test('missing migration marker returns setup-required without GET repairing or advancing schema', async t => {
  const f = await setup(t);
  f.db.prepare("DELETE FROM json_scalars WHERE key='v2SchedulingMigration'").run();
  const stream = await f.open('admin'); assert.equal(stream.response.statusCode, 503);
  assert.equal(f.identity.repo.scalar('v2SchedulingMigration'), null);
  assert.equal(f.hub.diagnostics().connections, 0); assert.equal(f.hub.diagnostics().timerActive, false);
});

test('scheduling feed advances monotonically in bounded batches and does not replay existing history', async t => {
  const f = await setup(t, { notifications: false }), stream = await f.open('admin'); await stream.next('reset');
  for (let index = 0; index < 205; index++) changeTitle(f, `batch-${index}`);
  for (let batch = 0; batch < 3; batch++) {
    await f.hub.poll(); assert.deepEqual((await stream.next('invalidate')).data.changes, [{ kind: 'wipe', wipeId: f.wipe.id }]);
  }
  await f.hub.poll(); await flush(); assert.equal(stream.frames.filter(frame => frame.event === 'invalidate').length, 3);
  const reconnect = await f.open('admin', { 'Last-Event-ID': stream.frames.at(-1).id });
  assert.equal((await reconnect.next('reset')).data.reason, 'reconnect');
  await f.hub.poll(); await flush(); assert.equal(reconnect.frames.filter(frame => frame.event === 'invalidate').length, 0);
});

test('notification feed rejects an allowed-target event whose current delivery belongs to another target', async t => {
  const f = await setup(t), stream = await f.open('admin'); await stream.next('reset');
  const intent = await accepted(f); await f.hub.poll(); await stream.next('invalidate');
  const hidden = f.system.service.repo.all('deliveries').find(delivery => delivery.targetId === 'kook-1');
  const framesBeforeForgedEvent = stream.frames.length;
  f.system.service.repo.appendChange({ wipeId: f.wipe.id, intentId: intent.current.id, deliveryId: hidden.id,
    targetId: 'discord-1', type: 'delivery.changed', createdAt: new Date(f.clock.now).toISOString() });
  await f.hub.poll(); await flush(); assert.equal(stream.frames.filter(frame => frame.event === 'invalidate').length, 1);
  assert.equal(stream.frames.slice(framesBeforeForgedEvent).some(frame => frame.raw.includes(hidden.id)), false);
});

test('timed-out authentication retains a bounded pending slot so reconnects cannot accumulate hanging work', async t => {
  const f = await setup(t, { hub: { intervalMs: 20, authorizationTimeoutMs: 20, maxConnections: 1, maxConnectionsPerAccount: 1 } });
  const original = f.identity.requireFreshEligibility.bind(f.identity); let release;
  f.identity.requireFreshEligibility = () => new Promise(resolve => { release = resolve; });
  try {
    const timedOut = await f.open('admin'); assert.equal(timedOut.response.statusCode, 503);
    assert.equal(f.hub.diagnostics().connections, 0); assert.equal(f.hub.diagnostics().pending, 1);
    assert.equal((await f.open('limited')).response.statusCode, 503);
    assert.equal(f.hub.diagnostics().pending, 1);
  } finally { f.identity.requireFreshEligibility = original; release?.(); }
  await flush(); assert.equal(f.hub.diagnostics().pending, 0);
});
