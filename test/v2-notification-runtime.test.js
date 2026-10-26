import test from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { request } from 'node:http';
import { runtimeFixture } from './support/v2-notification-runtime/fixture.js';
import { createNotificationRuntime } from '../server/v2/notification-runtime/index.js';

for (const platform of ['discord', 'kook']) test(`${platform}: real B+C preview, send, authenticated native callback, G04 write and same-card refresh`, async t => {
  const f = await runtimeFixture(t);
  assert.equal(f.runtime.getSystem(f.identity), f.system);
  assert.equal(f.runtime.getScheduling(f.identity), f.scheduling);
  const { preview, delivery } = f.publish(platform);
  assert.equal(delivery.status, 'queued');
  assert.equal(f.transport.getMessages().length, 0);
  assert.equal(f.system.service.repo.get('deliveries', delivery.id).payloadHash, preview.targets[0].payloadHash);
  assert.equal((await f.runtime.tick()).sent, 1);
  const original = f.transport.getMessages()[0];
  const envelope = f.nativeEnvelope(platform, original);
  const ack = await f.post(platform, envelope);
  assert.deepEqual(ack, { status: 200, body: platform === 'discord' ? { type: 5, data: { flags: 64 } } : {} });
  await f.drainCallbacks();
  assert.equal(f.signup().signupRevision, 1);
  assert.equal(f.signup().response, 'attending_on_time');
  assert.equal(f.browserMiddlewareCalls(), 0);
  assert.equal((await f.runtime.tick()).updated, 1);
  const updated = f.transport.getMessages()[0];
  assert.equal(updated.messageId, original.messageId);
  assert.equal(updated.editCount, 1);
  assert.equal(f.transport.getCalls().filter(call => call.operation === 'send').length, 1);
  if (platform === 'discord') {
    assert.deepEqual(updated.payload.allowed_mentions, { parse: [], roles: [], users: [], replied_user: false });
    assert.ok(updated.payload.embeds[0].fields.some(field => field.name.includes('(1)')), JSON.stringify(updated.payload.embeds[0].fields));
  } else {
    assert.ok(!updated.payload.content.includes('(rol)'));
    assert.match(updated.payload.content, /准时.*CN.*EU/u);
  }
  await f.post(platform, envelope); await f.drainCallbacks();
  assert.equal(f.signup().signupRevision, 1);
  assert.equal(f.scheduling.repo.all('outbox').filter(event => event.type === 'signup.changed').length, 1);
  assert.ok(!JSON.stringify(f.runtime.diagnostics()).includes(f.token(original)));
});

test('stored message with response loss remains unknown through lookup/repeated ticks; manual evidence resolves without another send', async t => {
  const f = await runtimeFixture(t, { script: [{ platform: 'kook', operation: 'send', kind: 'response_lost' }] });
  const { delivery } = f.publish('kook');
  assert.equal((await f.runtime.tick()).unknown, 1);
  const message = f.transport.getMessages()[0];
  assert.ok(message);
  assert.equal(f.delivery(delivery.id).status, 'delivery_unknown');
  let current = f.delivery(delivery.id);
  f.system.service.commandDelivery(f.actor(), delivery.id, 'reconcile', { expectedRevision: current.revision,
    decision: 'request_lookup', reason: '核实响应丢失', evidence: null, messageRef: null }, f.operation());
  await f.runtime.tick(); await f.runtime.tick();
  assert.equal(f.delivery(delivery.id).status, 'delivery_unknown');
  assert.equal(f.transport.getCalls().filter(call => call.operation === 'send').length, 1);
  current = f.delivery(delivery.id);
  f.system.service.commandDelivery(f.actor(), delivery.id, 'reconcile', { expectedRevision: current.revision,
    decision: 'confirmed_sent', reason: '本地有状态平台存储核验', evidence: '构造消息已存在并核对目标和编号',
    messageRef: { platform: message.platform, guildId: message.guildId, channelId: message.channelId,
      messageId: message.messageId, messageUrl: null } }, f.operation());
  await f.runtime.tick();
  assert.equal(f.delivery(delivery.id).status, 'sent');
  assert.equal(f.transport.getMessages()[0].messageId, message.messageId);
  assert.equal(f.transport.getCalls().filter(call => call.operation === 'send').length, 1);
});

test('tick coalesces, start is idempotent, and stop aborts an in-flight worker before SQLite closes', async t => {
  const f = await runtimeFixture(t, { script: [{ operation: 'send', kind: 'success', delayMs: 2000 }], runtime: { intervalMs: 10 } });
  const { delivery } = f.publish('discord');
  const one = f.runtime.tick(), two = f.runtime.tick();
  assert.equal(one, two);
  await new Promise(resolve => setImmediate(resolve));
  f.runtime.start(); f.runtime.start();
  assert.equal(f.runtime.diagnostics().timerActive, true);
  await f.runtime.stop();
  await one;
  assert.equal(f.delivery(delivery.id).status, 'delivery_unknown');
  assert.equal(f.runtime.diagnostics().timerActive, false);
  assert.equal(f.runtime.diagnostics().tickActive, false);
  f.closeDatabase();
  await delay(25);
  assert.deepEqual(await f.runtime.tick(), { skipped: true, reason: 'NOTIFICATION_RUNTIME_STOPPED' });
  assert.throws(() => f.runtime.getSystem(f.identity), /NOTIFICATION_RUNTIME_STOPPED/);
  assert.equal(f.transport.getCalls().filter(call => call.operation === 'send').length, 1);
});

test('ACKed callback remains tracked until eligibility/G04 work settles; stop cannot close underneath it', async t => {
  const f = await runtimeFixture(t);
  f.publish('discord'); await f.runtime.tick();
  const original = f.transport.getMessages()[0];
  let release;
  f.state.wait = new Promise(resolve => { release = resolve; });
  const ack = await f.post('discord', f.nativeEnvelope('discord', original));
  assert.equal(ack.status, 200);
  assert.equal(f.runtime.diagnostics().callbackJobs, 1);
  let stopped = false;
  const stopping = f.runtime.stop().then(() => { stopped = true; });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(stopped, false);
  release(); await stopping;
  assert.equal(f.runtime.diagnostics().callbackJobs, 0);
  assert.equal(f.runtime.diagnostics().lastErrorCode, 'PRIVATE_RESPONSE_UNKNOWN');
  const revision = f.signup().signupRevision;
  assert.equal(revision, 1);
  f.closeDatabase();
  assert.equal((await f.post('discord', f.nativeEnvelope('discord', original))).status, 503);
  await delay(15);
  assert.equal(f.runtime.diagnostics().stopped, true);
});

test('no scheduling actor means no automatic start; configured actor is current and cannot retain revoked start capability', async t => {
  const f = await runtimeFixture(t);
  f.state.now = Date.parse(f.wipe.musterAt);
  await f.runtime.tick();
  assert.equal(f.scheduling.wipe(f.wipe.id).lifecycle, 'scheduled');
  await f.runtime.stop();
  const owner = createNotificationRuntime({ ...f.runtimeInput, scheduledActorAccountId: 'operator' });
  t.after(() => owner.stop());
  const account = f.identity.repo.get('accounts', 'operator');
  f.identity.repo.put('accounts', { ...account, roleId: 'member', adminAssignedByOwner: false, grants: account.grants.filter(g => g.capability !== 'wipes.start') });
  await owner.tick();
  assert.equal(f.scheduling.wipe(f.wipe.id).lifecycle, 'scheduled');
  f.identity.repo.put('accounts', account);
  await owner.tick();
  assert.equal(f.scheduling.wipe(f.wipe.id).lifecycle, 'active');
  await owner.stop();
});

test('rejects unverified and oversized raw callback without reaching G04; setup and missing schema fail closed', async t => {
  const f = await runtimeFixture(t);
  const malformed = await f.post('discord', { headers: { 'content-type': 'application/json' }, rawBody: Buffer.from('{}') });
  assert.equal(malformed.status, 401);
  const oversized = await f.post('kook', { headers: {}, rawBody: Buffer.alloc(262145) });
  assert.equal(oversized.status, 413);
  assert.equal(f.scheduling.repo.all('signups').length, 0);
  assert.throws(() => createNotificationRuntime({ ...f.runtimeInput, transport: null }), /ISOLATED_TRANSPORT_REQUIRED/);
  assert.throws(() => createNotificationRuntime({ ...f.runtimeInput, verifiers: {} }), /NOTIFICATION_SETUP_REQUIRED/);
  assert.throws(() => createNotificationRuntime({ ...f.runtimeInput, publicOrigin: 'https://production.example' }), /ISOLATED_TRANSPORT_REQUIRED/);
  const before = f.db.prepare('SELECT COUNT(*) AS n FROM sqlite_master').get().n;
  f.identity.repo.setScalar('v2NotificationSchemaVersion', null);
  const owner = createNotificationRuntime(f.runtimeInput);
  assert.throws(() => owner.getSystem(f.identity), /NOTIFICATION_SETUP_REQUIRED/);
  assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM sqlite_master').get().n, before);
  await owner.stop();
});

test('stop cancels an unfinished raw request and drains its job before closing SQLite', async t => {
  const f = await runtimeFixture(t);
  let resolveResponse;
  const response = new Promise(resolve => { resolveResponse = resolve; });
  const req = request(`${f.origin}/api/integrations/v2/notifications/kook`, { method: 'POST' }, res => {
    res.resume(); res.once('end', () => resolveResponse(res.statusCode));
  });
  t.after(() => req.destroy());
  req.on('error', () => {});
  req.write('{');
  for (let attempt = 0; f.runtime.diagnostics().callbackJobs === 0; attempt++) {
    assert.ok(attempt < 1000);
    await new Promise(resolve => setImmediate(resolve));
  }
  await f.runtime.stop();
  assert.equal(f.runtime.diagnostics().callbackJobs, 0);
  assert.equal(f.scheduling.repo.all('signups').length, 0);
  f.closeDatabase();
  assert.equal(await response, 503);
});
