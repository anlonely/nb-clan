import { authenticatedSession } from './support/authenticated-session.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { createServer } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import express from 'express';
import { createIdentityRouter } from '../server/v2/identity/routes.js';
import { createSchedulingRouter } from '../server/v2/scheduling/routes.js';
import { createNotificationRouter, createNotificationSystem } from '../server/v2/notifications/index.js';
import { NotificationRepository } from '../server/v2/notifications/repository.js';
import { createFixture } from './support/v2-notifications/fixture.js';

const selection = targetId => ({ targetId, language: 'zh-CN', mentionMode: 'none', roleIds: [] });
const intentInput = preview => ({ previewId: preview.id, contentHash: preview.contentHash,
  expectedContentRevision: preview.contentRevision, purpose: preview.purpose, purposeInstance: preview.purposeInstance });

async function runtime(t) {
  const directory = mkdtempSync(join(tmpdir(), 'nb-v2-notifications-http-'));
  const filename = join(directory, 'isolated.sqlite');
  const app = express(), server = createServer(app);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.equal(address.address, '127.0.0.1');
  const origin = `http://127.0.0.1:${address.port}`;
  const now = Date.now(), at = offset => new Date(now + offset).toISOString();
  // Existing Scheduling router owns a Date.now clock; keep its real HTTP window open.
  const f = createFixture({ filename, publicOrigin: origin, now, wipeInput: {
    musterAt: at(7_200_000), serverScheduledWipeAt: at(3_600_000),
    signupOpensAt: at(-3_600_000), signupClosesAt: at(10_800_000)
  } });
  let system = f.system;
  const workers = new Set([system.worker]);
  const sessions = Object.fromEntries(await Promise.all(['admin', 'limited', 'a-m1'].map(async id => [id, await authenticatedSession(f.identity, id)])));
  const identityRouter = createIdentityRouter({ service: f.identity, origin, providers: {} });
  app.use('/api/v2', (req, _res, next) => {
    req.v2Identity = { service: f.identity, authenticate: options => identityRouter.authenticate(options)(req) }; next();
  }, identityRouter, createSchedulingRouter(), createNotificationRouter({ getSystem: () => system }));
  t.after(async () => {
    for (const worker of workers) await worker.stop();
    server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
    f.close(); rmSync(directory, { recursive: true, force: true });
  });
  async function request(path, { method = 'GET', body, actor = 'admin', operationId = randomUUID() } = {}) {
    const url = new URL(`/api/v2${path}`, origin);
    // All HTTP traffic is hard fenced to this test's random loopback listener.
    assert.equal(url.hostname, '127.0.0.1'); assert.equal(url.origin, origin);
    const session = sessions[actor];
    const response = await fetch(url, { method, redirect: 'error', headers: {
      cookie: `nb_v2_session=${session.token}`, origin, 'x-csrf-token': session.csrfToken,
      'Idempotency-Key': operationId, ...(body !== undefined ? { 'Content-Type': 'application/json' } : {})
    }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
    const raw = await response.text(), payload = JSON.parse(raw);
    return { status: response.status, headers: response.headers, raw, ...payload };
  }
  async function preview(input = f.input(), operationId = randomUUID(), actor = 'admin') {
    const response = await request(`/wipes/${f.wipe.id}/notification-previews`, { method: 'POST', body: input, operationId, actor });
    assert.equal(response.status, 201, response.raw); return response.data.current;
  }
  async function accept(p, operationId = randomUUID(), actor = 'admin') {
    const response = await request(`/wipes/${f.wipe.id}/publish-intents`, { method: 'POST', body: intentInput(p), operationId, actor });
    assert.equal(response.status, 202, response.raw); return response.data;
  }
  async function readDelivery(id) {
    const response = await request(`/deliveries/${id}`); assert.equal(response.status, 200, response.raw); return response.data.delivery;
  }
  async function reload() {
    await system.worker.stop();
    system = createNotificationSystem({ identity: f.identity, scheduling: f.scheduling, catalog: f.catalog,
      renderer: f.renderer, templates: f.templates, platforms: f.platforms, publicOrigin: origin,
      now: () => f.clock.now, options: { runtimeMode: 'isolated' } });
    workers.add(system.worker);
  }
  return { ...f, filename, origin, request, preview, accept, readDelivery, reload,
    worker: () => system.worker, service: () => system.service };
}

test('real notification HTTP returns 202 only after queued intent, targets and receipt are durable and reloadable', async t => {
  const f = await runtime(t);
  const options = await f.request(`/wipes/${f.wipe.id}/notification-options`);
  assert.equal(options.status, 200); assert.equal(options.data.targets.length, 2);
  const p = await f.preview(f.input({ targets: [selection('discord-1'), selection('kook-1')] }));
  const operationId = randomUUID(), accepted = await f.accept(p, operationId);
  assert.equal(accepted.current.status, 'queued'); assert.equal(accepted.current.counts.queued, 2);
  assert.equal(accepted.current.counts.sent, 0); assert.equal(f.transport.calls.length, 0);
  const observerDb = new DatabaseSync(f.filename);
  try {
    const observer = new NotificationRepository(observerDb);
    assert.equal(observer.all('intents').length, 1); assert.equal(observer.all('deliveries').length, 2);
    assert.equal(observer.all('receipts').find(row => row.operationId === operationId).operationReceipt.resourceId, accepted.current.id);
    assert.ok(observer.all('deliveries').every(row => row.status === 'queued' && row.attemptCount === 0));
  } finally { observerDb.close(); }
  await f.reload();
  const receipt = await f.request(`/notifications/operations/${operationId}`);
  assert.equal(receipt.status, 200); assert.equal(receipt.data.current.id, accepted.current.id);
  assert.deepEqual(receipt.data.operationReceipt, accepted.operationReceipt);
  assert.equal((await f.accept(p, operationId)).replayed, true);
  assert.equal(f.transport.calls.length, 0);
  const detail = await f.request(`/publish-intents/${accepted.current.id}`);
  assert.equal(detail.data.deliveries.length, 2); assert.equal(detail.meta.scopeVersion, f.actor().permissionVersion);
  for (const privateField of ['transportKey', 'actionReferences', 'leaseOwner', 'currentAttemptId', 'fixture-steam-', 'Private member']) {
    assert.equal(detail.raw.includes(privateField), false);
  }
  const result = await f.worker().runOnce({ workerId: 'http-owner', limit: 20 });
  assert.equal(result.sent, 2);
  const sent = await f.request(`/publish-intents/${accepted.current.id}`);
  assert.equal(sent.data.intent.status, 'completed'); assert.ok(sent.data.deliveries.every(row => row.messageRefs.length === 1));
  assert.equal(f.scheduling.repo.all('signups').length, 0);
});

test('real HTTP retry queues only known failures and lookup of unknown delivery never resends', async t => {
  const f = await runtime(t);
  const accepted = await f.accept(await f.preview(f.input({ targets: [selection('discord-1'), selection('kook-1')] })));
  f.transport.enqueue('send:discord-1', { outcome: 'not_sent', errorCode: 'FIXTURE_REJECTED', retryable: false, retryAfterMs: null });
  f.transport.enqueue('send:kook-1', { outcome: 'unknown', errorCode: 'FIXTURE_RESPONSE_LOST', providerRequestId: null });
  await f.worker().runOnce({ workerId: 'http-retry-owner' });
  let detail = (await f.request(`/publish-intents/${accepted.current.id}`)).data;
  const failed = detail.deliveries.find(row => row.targetId === 'discord-1'), unknownId = detail.deliveries.find(row => row.targetId === 'kook-1').id;
  assert.equal(detail.intent.status, 'needs_attention'); assert.equal(failed.status, 'failed');
  const retried = await f.request(`/publish-intents/${accepted.current.id}/retry-failed`, {
    method: 'POST', body: { expectedRevision: detail.intent.revision, reason: '只重试已知未送达' }
  });
  assert.equal(retried.status, 200, retried.raw);
  assert.deepEqual(retried.data.current.queuedIds, [failed.id]); assert.deepEqual(retried.data.current.skippedIds, [unknownId]);
  await f.worker().runOnce({ workerId: 'http-retry-owner' });
  const unknown = await f.readDelivery(unknownId);
  assert.equal(unknown.status, 'delivery_unknown'); assert.equal((await f.readDelivery(failed.id)).status, 'sent');
  const rejected = await f.request(`/deliveries/${unknownId}/commands/retry`, {
    method: 'POST', body: { expectedRevision: unknown.revision, reason: '未知不能直接重试' }
  });
  assert.equal(rejected.status, 409); assert.equal(rejected.error.errorCode, 'DELIVERY_NOT_RETRYABLE');
  const sends = f.transport.calls.filter(call => call.operation === 'send').length;
  const lookup = await f.request(`/deliveries/${unknownId}/commands/reconcile`, { method: 'POST', body: {
    expectedRevision: unknown.revision, decision: 'request_lookup', reason: '请求受控证据查询', evidence: null, messageRef: null
  } });
  assert.equal(lookup.status, 200, lookup.raw); assert.equal(lookup.data.current.status, 'delivery_unknown');
  assert.equal(f.transport.calls.filter(call => call.operation === 'lookup').length, 0);
  f.transport.enqueue('lookup', { outcome: 'not_found', definitive: true, evidence: 'isolated-idempotency-ledger-proves-no-message' });
  await f.worker().runOnce({ workerId: 'http-retry-owner' });
  assert.equal(f.transport.calls.filter(call => call.operation === 'send').length, sends);
  const verified = await f.readDelivery(unknownId);
  assert.equal(verified.status, 'failed'); assert.equal(verified.lastErrorCode, 'NOT_SENT_CONFIRMED');
  const retry = await f.request(`/deliveries/${unknownId}/commands/retry`, {
    method: 'POST', body: { expectedRevision: verified.revision, reason: '已有未发送证据，明确重试' }
  });
  assert.equal(retry.status, 200, retry.raw);
  await f.worker().runOnce({ workerId: 'http-retry-owner' });
  detail = (await f.request(`/publish-intents/${accepted.current.id}`)).data;
  assert.equal(detail.intent.status, 'completed'); assert.equal(detail.intent.counts.sent, 2);
  assert.equal(f.scheduling.repo.all('signups').length, 0);
});

test('manual HTTP reconciliation requires evidence and the original target message reference', async t => {
  const f = await runtime(t), accepted = await f.accept(await f.preview());
  let savedRef;
  f.transport.enqueue('send', (call, driver) => {
    savedRef = driver.saveMessage(call.target, call.payload);
    return { outcome: 'unknown', errorCode: 'FIXTURE_RESPONSE_LOST', providerRequestId: null };
  });
  await f.worker().runOnce({ workerId: 'http-manual-owner' });
  const id = accepted.current.deliveryIds[0], unknown = await f.readDelivery(id);
  assert.equal(unknown.status, 'delivery_unknown');
  const body = { expectedRevision: unknown.revision, decision: 'confirmed_sent', reason: '核对隔离平台记录', evidence: '', messageRef: savedRef };
  const noEvidence = await f.request(`/deliveries/${id}/commands/reconcile`, { method: 'POST', body });
  assert.equal(noEvidence.status, 422); assert.equal(noEvidence.error.errorCode, 'REASON_REQUIRED');
  body.evidence = 'isolated ledger contains this exact message';
  const wrongTarget = await f.request(`/deliveries/${id}/commands/reconcile`, { method: 'POST', body: {
    ...body, messageRef: { ...savedRef, channelId: 'foreign-channel' }
  } });
  assert.equal(wrongTarget.status, 409); assert.equal(wrongTarget.error.errorCode, 'DELIVERY_REFERENCE_REQUIRED');
  const operationId = randomUUID(), confirmed = await f.request(`/deliveries/${id}/commands/reconcile`, { method: 'POST', body, operationId });
  assert.equal(confirmed.status, 200, confirmed.raw); assert.equal(confirmed.data.current.status, 'sent');
  assert.equal(confirmed.data.current.messageRefs[0].messageId, savedRef.messageId);
  assert.equal((await f.request(`/notifications/operations/${operationId}`)).data.current.id, id);
  assert.equal(f.transport.calls.filter(call => call.operation === 'send').length, 1);
  await f.worker().runOnce({ workerId: 'http-manual-owner' });
  assert.equal(f.transport.calls.filter(call => call.operation === 'send').length, 1);
  assert.equal(f.scheduling.repo.all('signups').length, 0);
});

test('member signup HTTP updates only G04 facts while notifications retain preview statistics and refresh original cards', async t => {
  const f = await runtime(t), p = await f.preview(), accepted = await f.accept(p);
  const operationId = randomUUID();
  const signup = await f.request(`/wipes/${f.wipe.id}/my-signup`, { actor: 'a-m1', method: 'PUT', body: f.signup(), operationId });
  assert.equal(signup.status, 200, signup.raw);
  assert.equal(f.scheduling.repo.all('signups').length, 1);
  assert.equal(f.transport.calls.length, 0);
  assert.equal((await f.readDelivery(accepted.current.deliveryIds[0])).status, 'queued');
  assert.equal((await f.request(`/notifications/operations/${operationId}`, { actor: 'a-m1' })).status, 404);
  assert.equal((await f.request(`/operations/${operationId}`, { actor: 'a-m1' })).status, 200);
  await f.worker().runOnce({ workerId: 'http-member-owner' });
  await f.worker().runOnce({ workerId: 'http-member-owner' });
  const calls = f.transport.calls, send = calls.find(call => call.operation === 'send'), edit = calls.filter(call => call.operation === 'edit').at(-1);
  assert.equal(send.payloadHash, p.targets[0].payloadHash);
  assert.equal(send.payload.snapshot.counts.responseTotal, 0);
  assert.equal(edit.payload.snapshot.counts.responseTotal, 1);
  assert.equal(edit.payload.selection.mentionMode, 'none'); assert.deepEqual(edit.payload.selection.roleIds, []);
  assert.equal(calls.filter(call => call.operation === 'send').length, 1);
  const cancellation = await f.request(`/wipes/${f.wipe.id}/commands/cancel`, { method: 'POST', body: {
    expectedRevision: f.scheduling.repo.get('wipes', f.wipe.id).revision, reason: '隔离取消档期'
  } });
  assert.equal(cancellation.status, 200, cancellation.raw);
  await f.worker().runOnce({ workerId: 'http-member-owner' });
  const terminalEdit = f.transport.calls.filter(call => call.operation === 'edit').at(-1);
  assert.ok(terminalEdit.payload.rendered.actions.filter(action => action.action).every(action => action.disabled));
  assert.equal(f.transport.calls.filter(call => call.operation === 'send').length, 1);
  assert.equal((await f.readDelivery(accepted.current.deliveryIds[0])).status, 'sent');
  assert.equal(f.scheduling.repo.all('signups').length, 1);
  const afterCancel = await f.request(`/wipes/${f.wipe.id}/my-signup`, { actor: 'a-m1', method: 'PUT', body: f.signup({ expectedSignupRevision: 1 }) });
  assert.equal(afterCancel.status, 409);
});

test('member custom grants cannot expose notification details, receipts or administration', async t => {
  const f = await runtime(t), accepted = await f.accept(await f.preview(f.input({ targets: [selection('discord-1'), selection('kook-1')] })));
  const all = (await f.request(`/publish-intents/${accepted.current.id}`)).data;
  const before = f.db.prepare("SELECT collection,id,payload_json FROM json_records WHERE collection LIKE 'v2Notification%' ORDER BY collection,id").all();
  for (const route of [`/publish-intents/${accepted.current.id}`, `/deliveries/${all.deliveries[0].id}`, `/notifications/operations/${accepted.operationReceipt.operationId}`, `/wipes/${f.wipe.id}/notification-options`]) {
    const result = await f.request(route, { actor: 'limited' });
    assert.ok([403,404].includes(result.status), route + ': ' + result.status);
    assert.equal(result.raw.includes(all.deliveries[0].id), false);
  }
  assert.deepEqual((await f.request('/admin/wipes', { actor: 'limited' })).data.items, []);
  assert.deepEqual(f.db.prepare("SELECT collection,id,payload_json FROM json_records WHERE collection LIKE 'v2Notification%' ORDER BY collection,id").all(), before);
  const forbidden = await f.request(`/wipes/${f.wipe.id}/notification-previews`, { actor: 'limited', method: 'POST', body: f.input({ targets: [selection('kook-1')] }) });
  assert.equal(forbidden.status, 404);
});

test('failed HTTP acceptance rolls back intent and targets before response, then the same operation can recover', async t => {
  const f = await runtime(t), p = await f.preview(), operationId = randomUUID();
  f.db.exec("CREATE TRIGGER reject_notification_receipt BEFORE INSERT ON json_records WHEN NEW.collection='v2NotificationReceipts' BEGIN SELECT RAISE(ABORT,'isolated storage fault'); END;");
  const failed = await f.request(`/wipes/${f.wipe.id}/publish-intents`, { method: 'POST', body: intentInput(p), operationId });
  assert.equal(failed.status, 503); assert.equal(failed.error.errorCode, 'NOTIFICATION_SETUP_REQUIRED');
  assert.equal(f.service().repo.all('intents').length, 0); assert.equal(f.service().repo.all('deliveries').length, 0);
  assert.equal(f.service().repo.listChanges().items.length, 0); assert.equal(f.transport.calls.length, 0);
  f.db.exec('DROP TRIGGER reject_notification_receipt');
  const recovered = await f.accept(p, operationId);
  assert.equal(recovered.current.status, 'queued'); assert.equal(f.service().repo.all('intents').length, 1);
});

test('committed preview HTTP replay remains readable after target disable while fresh previews and options obey current availability', async t => {
  const f = await runtime(t), operationId = randomUUID(), input = f.input();
  const p = await f.preview(input, operationId);
  f.catalog.setTarget('discord-1', { enabled: false, configurationRevision: 2 });
  const options = await f.request(`/wipes/${f.wipe.id}/notification-options`);
  assert.deepEqual(options.data.targets.map(row => row.id), ['kook-1']);
  const replay = await f.request(`/wipes/${f.wipe.id}/notification-previews`, { method: 'POST', body: input, operationId });
  assert.equal(replay.status, 201, replay.raw); assert.equal(replay.data.replayed, true);
  assert.equal(replay.data.current.id, p.id);
  assert.equal((await f.request(`/notifications/operations/${operationId}`)).data.current.id, p.id);
  const fresh = await f.request(`/wipes/${f.wipe.id}/notification-previews`, { method: 'POST', body: input });
  assert.equal(fresh.status, 422); assert.equal(fresh.error.errorCode, 'TARGET_INVALID');
  assert.equal(f.service().repo.all('previews').length, 1); assert.equal(f.transport.calls.length, 0);
});
