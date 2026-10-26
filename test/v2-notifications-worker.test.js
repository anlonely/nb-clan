import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { createFixture, createFixturePlatforms, createFixtureTransport } from './support/v2-notifications/fixture.js';
import { createNotificationWorker } from '../server/v2/notifications/worker.js';
import { createNotificationSystem } from '../server/v2/notifications/index.js';
import { IdentityRepository } from '../server/v2/identity/repository.js';
import { IdentityService } from '../server/v2/identity/service.js';
import { SchedulingRepository } from '../server/v2/scheduling/repository.js';
import { SchedulingService } from '../server/v2/scheduling/service.js';
import { installMemberAdminSchema } from '../server/v2/member-admin/repository.js';
import { MemberAdminService } from '../server/v2/member-admin/service.js';

function fixture(t, options) {
  const f = createFixture({ ...options });
  t.after(async () => { await f.system.worker.stop(); f.close(); });
  return f;
}
function publish(f, overrides = {}) {
  const preview = f.system.service.createPreview(f.actor(), f.wipe.id, f.input(overrides), f.operation('preview')).current;
  const intent = f.system.service.createIntent(f.actor(), f.wipe.id, { previewId: preview.id, contentHash: preview.contentHash,
    expectedContentRevision: preview.contentRevision, purpose: preview.purpose, purposeInstance: preview.purposeInstance }, f.operation('intent')).current;
  return { preview, intent, ids: intent.deliveryIds };
}
const row = (f, id) => f.system.service.repo.get('deliveries', id);
const run = (f, options = {}) => f.system.worker.runOnce({ workerId: 'fixture-worker', ...options });
const refs = (f, id) => f.system.service.repo.all('messageRefs').filter(ref => ref.deliveryId === id);
const sends = f => f.transport.calls.filter(call => call.operation === 'send');
const edits = f => f.transport.calls.filter(call => call.operation === 'edit');
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
function command(f, id, cmd, input = {}) {
  return f.system.service.commandDelivery(f.actor(), id, cmd, { expectedRevision: row(f, id).revision, reason: '隔离测试的明确人工证据', ...input }, f.operation(cmd));
}
function lookup(f, id) {
  return command(f, id, 'reconcile', { decision: 'request_lookup', evidence: null, messageRef: null });
}

test('committed member roster changes refresh existing cards once without sending a second notification', async t => {
  const f = fixture(t);
  installMemberAdminSchema(f.db);
  publish(f); await run(f); await run(f);
  const beforeSends = sends(f).length, beforeEdits = edits(f).length;
  const member = f.identity.repo.all('members')[0];
  const members = new MemberAdminService(f.identity);
  members.edit(f.actor(), member.id, { expectedRevision: member.revision || 1, fields: { customName: '本地更新姓名' } }, randomUUID());
  await run(f);
  assert.equal(sends(f).length, beforeSends);
  assert.ok(edits(f).length > beforeEdits);
  const afterEdits = edits(f).length;
  await run(f);
  assert.equal(edits(f).length, afterEdits);
  assert.equal(f.system.service.repo.scalar('v2NotificationMemberOutbox').seq, 1);
});

test('accepted intent remains queued; every send commits its exact attempt and payload before external I/O', async t => {
  const f = fixture(t), { ids: [id] } = publish(f);
  const delivery = row(f, id);
  assert.equal(delivery.status, 'queued'); assert.equal(sends(f).length, 0);
  f.transport.enqueue('send', (call, driver) => {
    const stored = row(f, id), attempt = f.system.service.repo.get('attempts', call.context.attemptId);
    assert.equal(stored.status, 'sending'); assert.equal(attempt.status, 'requesting');
    assert.equal(attempt.executionEpoch, stored.executionEpoch); assert.equal(attempt.leaseOwner, 'fixture-worker');
    assert.equal(attempt.payloadHash, delivery.payloadHash); assert.equal(f.db.isTransaction, false);
    assert.deepEqual(call.payload, delivery.payload);
    return { outcome: 'sent', messageRef: driver.saveMessage(call.target, call.payload), providerRequestId: null };
  });
  assert.equal((await run(f)).sent, 1);
  assert.equal(row(f, id).status, 'sent'); assert.equal(refs(f, id).length, 1);
  await run(f); await run(f);
  assert.equal(sends(f).length, 1); assert.equal(edits(f).length, 1);
  assert.equal(f.system.service.repo.all('attempts').length, 2);
});

test('known non-delivery alone retries with bounded provider delay, and maxAttempts is final', async t => {
  const f = fixture(t, { options: { maxAttempts: 2 } }), { ids: [id] } = publish(f);
  f.transport.enqueue('send', { outcome: 'not_sent', errorCode: 'RATE_LIMITED', retryable: true, retryAfterMs: 5_000 },
    { outcome: 'not_sent', errorCode: 'RATE_LIMITED', retryable: true, retryAfterMs: 5_000 });
  await run(f); assert.equal(row(f, id).status, 'retry_wait'); assert.equal(row(f, id).knownNotSent, true);
  await run(f); assert.equal(sends(f).length, 1);
  f.clock.advance(5_000); await run(f);
  assert.equal(row(f, id).status, 'failed'); assert.equal(row(f, id).attemptCount, 2);
  assert.equal(row(f, id).executionEpoch, 2); assert.equal(row(f, id).nextAttemptAt, null);
  f.clock.advance(60_000); await run(f); assert.equal(sends(f).length, 2);
});

test('partial target results preserve each fact; exceptions and unknown outcomes never resend', async t => {
  const f = fixture(t), { ids } = publish(f, { targets: [
    { targetId: 'discord-1', language: 'zh-CN', mentionMode: 'none', roleIds: [] },
    { targetId: 'kook-1', language: 'en', mentionMode: 'none', roleIds: [] }
  ] });
  f.transport.enqueue('send:kook-1', new Error('isolated private transport error must not be persisted'));
  await run(f);
  assert.deepEqual(ids.map(id => row(f, id).status).sort(), ['delivery_unknown', 'sent']);
  await run(f); await run(f); assert.equal(sends(f).length, 2);
  const serialized = JSON.stringify(f.system.service.repo.all('attempts'));
  assert.equal(serialized.includes('isolated private transport error'), false);
});

test('timeout after provider saves a message persists unknown and ignores eventual success', async t => {
  const f = fixture(t, { options: { requestTimeoutMs: 15 } }), { ids: [id] } = publish(f), held = deferred();
  let reference;
  f.transport.enqueue('send', (call, driver) => { reference = driver.saveMessage(call.target, call.payload); return held.promise; });
  await run(f); assert.equal(row(f, id).status, 'delivery_unknown'); assert.equal(row(f, id).lastErrorCode, 'REQUEST_TIMEOUT');
  assert.equal(f.transport.messages.size, 1); assert.equal(refs(f, id).length, 0);
  held.resolve({ outcome: 'sent', messageRef: reference, providerRequestId: null });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(row(f, id).status, 'delivery_unknown');
  assert.equal(f.system.service.repo.all('attempts')[0].lateEvidence[0].outcome, 'sent');
  await run(f); assert.equal(sends(f).length, 1);
});

test('stop aborts bounded requests, leaves unknown, and stops further claims without a timer', async t => {
  const f = fixture(t), { ids: [id] } = publish(f), started = deferred();
  f.transport.enqueue('send', call => { started.resolve(call); return new Promise(() => {}); });
  const running = run(f); const call = await started.promise;
  await f.system.worker.stop(); await running;
  assert.equal(call.context.signal.aborted, true); assert.equal(row(f, id).status, 'delivery_unknown');
  assert.equal(row(f, id).lastErrorCode, 'REQUEST_ABORTED');
  assert.deepEqual(await run(f), { claimed: 0, sent: 0, failed: 0, unknown: 0, skipped: 0, updated: 0 });
});

test('expired sending lease recovers unknown; old epoch cannot overwrite manually reconciled retry', async t => {
  const f = fixture(t, { options: { leaseMs: 1_000, requestTimeoutMs: 1_000 } }), { ids: [id] } = publish(f), held = deferred(), started = deferred();
  f.transport.enqueue('send', (call, driver) => { started.resolve({ call, ref: driver.saveMessage(call.target, call.payload) }); return held.promise; });
  const running = run(f); const first = await started.promise; f.clock.advance(1_001);
  const worker2 = createNotificationWorker(f.system.service); t.after(() => worker2.stop());
  assert.deepEqual(await worker2.recoverExpired({ workerId: 'restart-owner' }), { unknown: 1, released: 1 });
  assert.equal(row(f, id).status, 'delivery_unknown');
  await command(f, id, 'reconcile', { decision: 'confirmed_not_sent', evidence: '隔离管理员已从平台明确确认未送达', messageRef: null });
  await command(f, id, 'retry');
  await worker2.runOnce({ workerId: 'restart-owner' });
  const sent = row(f, id), actualRef = refs(f, id)[0];
  assert.equal(sent.status, 'sent'); assert.ok(sent.executionEpoch > first.call.context.executionEpoch);
  held.resolve({ outcome: 'sent', messageRef: first.ref, providerRequestId: 'late-isolated-request' }); await running;
  assert.equal(row(f, id).status, 'sent'); assert.equal(row(f, id).executionEpoch, sent.executionEpoch);
  assert.equal(refs(f, id).length, 1); assert.equal(refs(f, id)[0].messageId, actualRef.messageId);
});

test('elapsed reminder is cancelled on restart and content changes invalidate future reminders', async t => {
  const f = fixture(t), { ids: [expired] } = publish(f, { purpose: 'reminder', schedule: {
    dueAt: new Date(f.clock.now + 60_000).toISOString(), expiresAt: new Date(f.clock.now + 120_000).toISOString()
  } });
  f.clock.advance(120_001); const outcome = await run(f);
  assert.equal(outcome.skipped, 1); assert.equal(row(f, expired).status, 'cancelled'); assert.equal(row(f, expired).lastErrorCode, 'REMINDER_EXPIRED');
  const { ids: [stale] } = publish(f, { purpose: 'reminder', purposeInstance: randomUUID(), repeatOfIntentId: row(f, expired).intentId,
    reason: '重新安排隔离提醒', schedule: { dueAt: new Date(f.clock.now + 60_000).toISOString(), expiresAt: new Date(f.clock.now + 120_000).toISOString() } });
  f.scheduling.updateWipe(f.actor(), f.wipe.id, { expectedRevision: f.scheduling.repo.get('wipes', f.wipe.id).revision,
    musterAt: '2030-09-08T12:30:00Z' }, f.operation('reschedule'));
  await run(f); assert.equal(row(f, stale).status, 'cancelled'); assert.equal(row(f, stale).lastErrorCode, 'PREVIEW_STALE');
  f.clock.advance(60_000); await run(f); assert.equal(sends(f).length, 0);
});

test('current target and account permissions are checked before external work', async t => {
  const f = fixture(t), { ids: [id] } = publish(f);
  const account = f.identity.repo.get('accounts', 'admin');
  f.identity.repo.put('accounts', { ...account, roleId: 'member', adminAssignedByOwner: false, permissionVersion: account.permissionVersion + 1,
    grants: account.grants.filter(grant => grant.capability !== 'notifications.send') });
  await run(f); assert.equal(row(f, id).status, 'failed'); assert.equal(row(f, id).knownNotSent, true); assert.equal(sends(f).length, 0);
  f.identity.repo.put('accounts', account);
  await command(f, id, 'retry'); f.catalog.setTarget('discord-1', { enabled: false, configurationRevision: 2 });
  await run(f); assert.equal(sends(f).length, 0); assert.notEqual(row(f, id).status, 'sent');
});

test('G04 outbox checkpoint and merged signup refresh edit every original card without sending', async t => {
  const f = fixture(t), first = publish(f); await run(f); await run(f);
  const second = publish(f, { purposeInstance: randomUUID(), repeatOfIntentId: first.intent.id, reason: '明确再次通知' });
  await run(f); await run(f); const sentIds = [first.ids[0], second.ids[0]], original = sentIds.map(id => refs(f, id)[0].messageId);
  const before = edits(f).length, sourceOutbox = f.scheduling.repo.all('outbox');
  f.scheduling.saveSignup(f.actor('a-m1'), f.wipe.id, 'm1', f.signup(), f.operation('member-reply'));
  f.scheduling.saveSignup(f.actor('a-m2'), f.wipe.id, 'm2', f.signup(), f.operation('member-reply'));
  await run(f); await run(f);
  assert.equal(edits(f).length - before, 2); assert.equal(sends(f).length, 2);
  assert.deepEqual(edits(f).slice(-2).map(call => call.messageRef.messageId).sort(), original.sort());
  for (const call of edits(f).slice(-2)) {
    assert.equal(call.payload.selection.mentionMode, 'none'); assert.equal(call.payload.snapshot.counts.confirmedAttending, 2);
  }
  const checkpoints = f.system.service.repo.all('consumedEvents').length;
  await run(f); assert.equal(f.system.service.repo.all('consumedEvents').length, checkpoints); assert.equal(edits(f).length - before, 2);
  assert.deepEqual(sourceOutbox.map(event => f.scheduling.repo.get('outbox', event.id)), sourceOutbox);
  assert.equal(f.scheduling.repo.all('signups').length, 2);
});

test('deleted original cards never trigger replacement sends after later signup events', async t => {
  const f = fixture(t), { ids: [id] } = publish(f); await run(f); await run(f);
  const ref = refs(f, id)[0]; f.transport.messages.delete(ref.messageId);
  f.scheduling.saveSignup(f.actor('a-m1'), f.wipe.id, 'm1', f.signup(), f.operation('member-reply'));
  await run(f); assert.equal(refs(f, id)[0].state, 'deleted'); assert.equal(row(f, id).status, 'sent');
  const editCount = edits(f).length;
  f.scheduling.saveSignup(f.actor('a-m2'), f.wipe.id, 'm2', f.signup(), f.operation('member-reply'));
  await run(f); await run(f); assert.equal(edits(f).length, editCount); assert.equal(sends(f).length, 1);
});

test('edit and delete attempts are durable and edit unknown preserves successful delivery', async t => {
  const f = fixture(t), { ids: [id] } = publish(f); await run(f);
  f.transport.enqueue('edit', call => {
    const attempt = f.system.service.repo.get('attempts', call.context.attemptId);
    assert.equal(attempt.kind, 'edit'); assert.equal(attempt.status, 'requesting'); assert.equal(f.db.isTransaction, false);
    return { outcome: 'unknown', errorCode: 'RESPONSE_LOST' };
  });
  await run(f); assert.equal(row(f, id).status, 'sent'); assert.equal(refs(f, id)[0].state, 'update_unknown');
  const op = f.system.service.queueMessageOperation(row(f, id), 'delete', { reasonCode: 'ISOLATED_DELETE', messageRefId: refs(f, id)[0].id });
  f.transport.enqueue('delete', call => {
    assert.equal(f.system.service.repo.get('attempts', call.context.attemptId).kind, 'delete'); assert.equal(f.db.isTransaction, false);
    return { outcome: 'updated', providerRequestId: null };
  });
  await run(f); assert.equal(f.system.service.repo.get('messageOperations', op.id).status, 'succeeded');
  assert.equal(refs(f, id)[0].state, 'deleted'); assert.equal(row(f, id).status, 'sent'); assert.equal(sends(f).length, 1);
});

test('manual lookup has a durable attempt and unsupported/not-definitive absence remains unknown', async t => {
  const f = fixture(t), { ids: [id] } = publish(f);
  f.transport.enqueue('send', { outcome: 'unknown', errorCode: 'RESPONSE_LOST', providerRequestId: null });
  await run(f); await lookup(f, id);
  f.transport.enqueue('lookup', call => {
    const attempt = f.system.service.repo.get('attempts', call.context.attemptId);
    assert.equal(attempt.kind, 'lookup'); assert.equal(attempt.status, 'requesting'); assert.equal(f.db.isTransaction, false);
    assert.equal(call.attemptId, f.system.service.repo.all('attempts').find(row => row.kind === 'send').id);
    return { outcome: 'not_found', definitive: false, evidence: '仅扫描最近记录，没有可靠不投递证明' };
  });
  await run(f); assert.equal(row(f, id).status, 'delivery_unknown');
  await lookup(f, id); await run(f); assert.equal(row(f, id).status, 'delivery_unknown'); assert.equal(sends(f).length, 1);
});

test('definitive lookup absence allows explicit retry; found attaches confirmed message without sending', async t => {
  const f = fixture(t), { ids: [id] } = publish(f);
  f.transport.enqueue('send', { outcome: 'unknown', errorCode: 'RESPONSE_LOST', providerRequestId: null });
  await run(f); await lookup(f, id);
  f.transport.enqueue('lookup', { outcome: 'not_found', definitive: true, evidence: '隔离平台投递索引已明确证明本操作未投递' });
  await run(f); assert.equal(row(f, id).status, 'failed'); assert.equal(row(f, id).lastErrorCode, 'NOT_SENT_CONFIRMED');
  await command(f, id, 'retry');
  f.transport.enqueue('send', (call, driver) => { driver.saveMessage(call.target, call.payload); return { outcome: 'unknown', errorCode: 'RESPONSE_LOST', providerRequestId: null }; });
  await run(f); await lookup(f, id);
  const ref = [...f.transport.messages.values()][0].messageRef;
  f.transport.enqueue('lookup', { outcome: 'found', messageRef: ref }); await run(f);
  assert.equal(row(f, id).status, 'sent'); assert.equal(refs(f, id)[0].messageId, ref.messageId); assert.equal(sends(f).length, 2);
});

test('old lookup cannot override manual evidence and an explicitly retried execution epoch', async t => {
  const f = fixture(t), { ids: [id] } = publish(f), held = deferred(), started = deferred();
  f.transport.enqueue('send', { outcome: 'unknown', errorCode: 'RESPONSE_LOST', providerRequestId: null });
  await run(f); await lookup(f, id);
  f.transport.enqueue('lookup', () => { started.resolve(); return held.promise; });
  const running = run(f); await started.promise;
  await command(f, id, 'reconcile', { decision: 'confirmed_not_sent', evidence: '人工平台审计明确证明未投递', messageRef: null });
  const after = row(f, id);
  held.resolve({ outcome: 'found', messageRef: f.transport.messageRef(f.catalog.getTarget('discord-1')) }); await running;
  assert.equal(row(f, id).status, 'failed'); assert.equal(row(f, id).executionEpoch, after.executionEpoch);
  assert.equal(refs(f, id).length, 0); assert.equal(sends(f).length, 1);
});

test('late expired edit stays blocked until explicit reconciliation, then refreshes latest content', async t => {
  const f = fixture(t, { options: { leaseMs: 1_000 } }), { ids: [id] } = publish(f), held = deferred(), started = deferred();
  await run(f);
  f.transport.enqueue('edit', call => { started.resolve(call); return held.promise; });
  const running = run(f); const oldCall = await started.promise; f.clock.advance(1_001);
  const worker2 = createNotificationWorker(f.system.service); t.after(() => worker2.stop());
  assert.equal((await worker2.recoverExpired({ workerId: 'second-owner' })).unknown, 1);
  const update = musterAt => f.scheduling.updateWipe(f.actor(), f.wipe.id, {
    expectedRevision: f.scheduling.repo.get('wipes', f.wipe.id).revision, musterAt
  }, f.operation('reschedule'));
  update('2030-09-08T12:30:00Z');
  const originalRevision = refs(f, id)[0].contentRevision, editCount = edits(f).length;
  await worker2.runOnce({ workerId: 'second-owner' });
  assert.equal(refs(f, id)[0].contentRevision, originalRevision);
  assert.equal(refs(f, id)[0].state, 'update_unknown');
  assert.equal(edits(f).length, editCount);
  held.resolve({ outcome: 'updated', providerRequestId: null }); await running;
  const attempt = f.system.service.repo.get('attempts', oldCall.context.attemptId);
  assert.equal(attempt.lateEvidence.at(-1).outcome, 'updated');
  await worker2.runOnce({ workerId: 'second-owner' });
  assert.equal(edits(f).length, editCount, 'late success is evidence, not permission for an automatic overwrite');
  const op = f.system.service.getDelivery(f.actor(), id).messageOperations.find(op => op.status === 'unknown');
  f.system.service.reconcileEditOperation(f.actor(), op.id, {
    expectedRevision: op.revision, expectedExecutionEpoch: op.executionEpoch,
    expectedStateFingerprint: op.stateFingerprint, messageRefId: op.reference.id,
    expectedReferenceFingerprint: op.referenceFingerprint, expectedPayloadHash: op.payloadHash,
    decision: 'confirmed_updated', reason: '本地核实原消息', evidence: '隔离平台的原消息内容已与此编辑快照核对一致。',
    cancelQueuedEdits: op.queuedEdits.map(row => ({ id: row.id, stateFingerprint: row.stateFingerprint }))
  }, f.operation('reconcile-edit'));
  update('2030-09-08T12:45:00Z');
  await worker2.runOnce({ workerId: 'second-owner' });
  const currentRevision = refs(f, id)[0].contentRevision;
  assert.ok(currentRevision > oldCall.payload.snapshot.contentRevision);
  assert.equal(edits(f).at(-1).payload.snapshot.contentRevision, currentRevision);
  assert.equal(f.transport.messages.get(refs(f, id)[0].messageId).payload.snapshot.contentRevision, currentRevision);
  assert.equal(sends(f).length, 1);
});

test('cancel during send preserves actual delivery and refreshes closed card without pretending withdrawal', async t => {
  const f = fixture(t), { ids: [id] } = publish(f), held = deferred(), started = deferred();
  f.transport.enqueue('send', (call, driver) => { started.resolve({ call, ref: driver.saveMessage(call.target, call.payload) }); return held.promise; });
  const running = run(f), first = await started.promise;
  await command(f, id, 'cancel'); assert.equal(row(f, id).status, 'sending'); assert.equal(row(f, id).cancelRequested, true);
  f.scheduling.transition(f.actor(), f.wipe.id, 'cancel', { expectedRevision: f.scheduling.repo.get('wipes', f.wipe.id).revision, reason: '隔离取消' }, f.operation('cancel-wipe'));
  held.resolve({ outcome: 'sent', messageRef: first.ref, providerRequestId: null }); await running; await run(f);
  assert.equal(row(f, id).status, 'sent'); assert.equal(sends(f).length, 1);
  assert.equal(edits(f).at(-1).payload.snapshot.lifecycle, 'cancelled');
  assert.ok(edits(f).at(-1).payload.rendered.actions.filter(action => action.action).every(action => action.disabled));
});

test('a real sender process crash leaves requesting attempt on disk; reopened SQLite never blindly resends', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'v2-notification-worker-crash-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const filename = join(directory, 'worker.sqlite'), providerFile = join(directory, 'isolated-provider.json');
  const fixtureURL = new URL('./support/v2-notifications/fixture.js', import.meta.url).href;
  const script = `import { createFixture } from ${JSON.stringify(fixtureURL)};
    import { writeFileSync } from 'node:fs';
    const f = createFixture({filename: process.argv[1], options: { leaseMs: 1000 } });
    const p = f.system.service.createPreview(f.actor(), f.wipe.id, f.input(), f.operation()).current;
    const i = f.system.service.createIntent(f.actor(), f.wipe.id, {previewId:p.id, contentHash:p.contentHash,
      expectedContentRevision:p.contentRevision, purpose:p.purpose, purposeInstance:p.purposeInstance}, f.operation()).current;
    f.transport.enqueue('send', (call, driver) => {
      const messageRef = driver.saveMessage(call.target, call.payload);
      writeFileSync(process.argv[2], JSON.stringify({target:call.target,payload:call.payload,messageRef}), {mode:0o600});
      console.log(JSON.stringify({deliveryId:i.deliveryIds[0], attemptId:call.context.attemptId})); process.exit(23);
    });
    await f.system.worker.runOnce({ workerId: 'crashing-owner' });`;
  const child = spawnSync(process.execPath, ['--import', new URL('./support/v2-baseline/loopback-only.mjs', import.meta.url).href, '--input-type=module', '-e', script, filename, providerFile], {
    encoding: 'utf8', timeout: 10_000, env: { PATH: dirname(process.execPath), NODE_NO_WARNINGS: '1', NODE_ENV: 'test', NB_DISABLE_BACKGROUND_JOBS: '1' }
  });
  assert.equal(child.status, 23, child.stderr); const state = JSON.parse(child.stdout.trim());
  const f = fixture(t), db = new DatabaseSync(filename), now = () => f.clock.now + 1_001;
  const identity = new IdentityService(new IdentityRepository(db), { now });
  const scheduling = new SchedulingService(new SchedulingRepository(db), identity, { now });
  const transport = createFixtureTransport();
  const providerSaved = JSON.parse(readFileSync(providerFile, 'utf8'));
  transport.saveMessage(providerSaved.target, providerSaved.payload, providerSaved.messageRef);
  const system = createNotificationSystem({ identity, scheduling, catalog: f.catalog, renderer: f.renderer, templates: f.templates,
    platforms: createFixturePlatforms(transport), publicOrigin: 'http://127.0.0.1:4319', now, options: { runtimeMode: 'isolated', leaseMs: 1_000 } });
  t.after(async () => { await system.worker.stop(); db.close(); });
  assert.equal(system.service.repo.get('deliveries', state.deliveryId).status, 'sending');
  assert.equal(system.service.repo.get('attempts', state.attemptId).status, 'requesting');
  assert.equal((await system.worker.recoverExpired({ workerId: 'reopened-owner' })).unknown, 1);
  await system.worker.runOnce({ workerId: 'reopened-owner' }); await system.worker.runOnce({ workerId: 'reopened-owner' });
  assert.equal(system.service.repo.get('deliveries', state.deliveryId).status, 'delivery_unknown');
  assert.equal(transport.calls.length, 0); assert.equal(transport.messages.size, 1);
});

test('completion storage failure rolls back reference and result, leaving a recoverable sending attempt', async t => {
  const f = fixture(t, { options: { leaseMs: 1_000 } }), { ids: [id] } = publish(f);
  f.transport.enqueue('send', (call, driver) => {
    f.db.exec("CREATE TRIGGER fixture_reject_ref BEFORE INSERT ON json_records WHEN NEW.collection='v2NotificationMessageRefs' BEGIN SELECT RAISE(ABORT,'injected-reference-failure'); END;");
    return { outcome: 'sent', messageRef: driver.saveMessage(call.target, call.payload), providerRequestId: null };
  });
  await assert.rejects(run(f), /injected-reference-failure/);
  assert.equal(row(f, id).status, 'sending'); assert.equal(refs(f, id).length, 0);
  assert.equal(f.system.service.repo.all('attempts')[0].status, 'requesting');
  f.db.exec('DROP TRIGGER fixture_reject_ref'); f.clock.advance(1_001);
  await f.system.worker.recoverExpired({ workerId: 'recovery-owner' }); await run(f);
  assert.equal(row(f, id).status, 'delivery_unknown'); assert.equal(sends(f).length, 1);
});
