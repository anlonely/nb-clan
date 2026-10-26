import test from 'node:test';
import assert from 'node:assert/strict';
import { createFixture } from './support/v2-notifications/fixture.js';
import { tokenHash } from '../server/v2/notifications/shared.js';

const command = 'client.connect eu-medium.vitalrust.com:28014';
const ip = '168.100.161.200';
const otherIp = '216.39.240.89';

async function sentFixture(t) {
  let dnsCalls = 0;
  const f = createFixture({ adminRole: true,
    wipeInput: { serverSnapshot: { name: 'Constructed Vital server', connectCommand: command } },
    options: { resolveConnectIp: async () => { dnsCalls++; return ip; } } });
  t.after(() => f.close());
  f.catalog.setTarget('discord-1', { signupMode: 'member_required' });
  const { service, worker } = f.system;
  const preview = service.createPreview(f.actor(), f.wipe.id, f.input(), f.operation('preview')).current;
  const intent = service.createIntent(f.actor(), f.wipe.id, { previewId: preview.id,
    contentHash: preview.contentHash, expectedContentRevision: preview.contentRevision,
    purpose: preview.purpose, purposeInstance: preview.purposeInstance }, f.operation('publish')).current;
  await worker.runOnce({ workerId: 'copy-reference-fixture', limit: 20 });
  const delivery = service.repo.get('deliveries', intent.deliveryIds[0]);
  assert.equal(delivery.status, 'sent');
  const ref = service.repo.all('messageRefs').find(row => row.deliveryId === delivery.id);
  assert.ok(ref);
  const token = f.transport.messages.get(ref.messageId).payload.actionRefs.find(action => action.action === 'copy_connect').token;
  const actionReference = service.repo.all('actionReferences').find(row => row.tokenHash === tokenHash(token));
  assert.equal(actionReference?.confirmed, true);
  // Apply the worker's normal original-message edit, preserving the first token.
  await worker.runOnce({ workerId: 'copy-reference-fixture', limit: 20 });
  const appliedRef = service.repo.get('messageRefs', ref.id);
  const applied = service.repo.get('messageOperations', appliedRef.lastMessageOperationId);
  assert.equal(applied?.status, 'succeeded');
  assert.equal(applied.snapshot.directConnect, command);
  assert.equal(applied.snapshot.directConnectIp, ip);
  assert.equal(f.transport.messages.size, 1);
  assert.equal(f.transport.calls.filter(call => call.operation === 'send').length, 1);
  const databaseRows = () => ({
    records: f.db.prepare('SELECT collection,id,payload_json FROM json_records ORDER BY collection,id').all(),
    scalars: f.db.prepare('SELECT * FROM json_scalars ORDER BY key').all(),
    schedulingClock: f.db.prepare('SELECT * FROM v2_scheduling_clock').all(),
    notificationClock: f.db.prepare('SELECT * FROM v2_notification_clock').all(),
  });
  const scope = { platform: 'discord', guildId: delivery.target.guildId, channelId: delivery.target.channelId };
  const resolve = (scopePatch = {}, value = token) => {
    const before = databaseRows(), previousDnsCalls = dnsCalls, previousNativeCalls = f.transport.calls.length;
    try { return service.resolveReference(value, { ...scope, ...scopePatch }); }
    finally {
      assert.deepEqual(databaseRows(), before, 'Reference resolution must not change SQLite records or clocks');
      assert.equal(dnsCalls, previousDnsCalls, 'Reference resolution must not make a DNS request');
      assert.equal(f.transport.calls.length, previousNativeCalls, 'Reference resolution must not dispatch platform messages');
    }
  };
  return { f, service, delivery, ref: appliedRef, applied, actionReference, token, scope, resolve };
}

test('a real sent original copy token resolves fresh cached IP and remains read-only', async t => {
  const { f, service, resolve } = await sentFixture(t);
  service.signupConnectIps.set(command, { ip: otherIp, expiresAt: f.clock.now + 300000 });
  const result = resolve();
  assert.equal(result.action, 'copy_connect');
  assert.equal(result.directConnect, command);
  assert.equal(result.directConnectIp, otherIp);
  assert.equal(result.signupMode, 'member_required');
});

test('cold original-token resolution uses only the reference-pinned successful edit', async t => {
  const { service, delivery, ref, applied, resolve } = await sentFixture(t);
  service.signupConnectIps = new Map();
  service.repo.put('messageOperations', { ...applied, id: 'another-unpinned-edit', updatedAt: '2099-01-01T00:00:00Z',
    snapshot: { ...applied.snapshot, directConnectIp: otherIp } });
  service.repo.put('messageOperations', { ...applied, id: 'same-wipe-other-card', deliveryId: 'other-delivery',
    messageRefId: 'other-reference', updatedAt: '2099-01-01T00:00:01Z',
    snapshot: { ...applied.snapshot, directConnectIp: otherIp } });
  assert.equal(resolve().directConnectIp, ip);
  assert.equal(service.repo.get('messageRefs', ref.id).messageId, ref.messageId);
  assert.equal(service.repo.get('deliveries', delivery.id).status, 'sent');
});

test('a cold original reference without an edit pin can use its initial confirmed delivery snapshot', async t => {
  const { service, delivery, ref, resolve } = await sentFixture(t);
  service.signupConnectIps = new Map();
  service.repo.put('deliveries', { ...service.repo.get('deliveries', delivery.id),
    snapshot: { ...delivery.snapshot, directConnect: command, directConnectIp: otherIp } });
  service.repo.put('messageRefs', { ...ref, lastMessageOperationId: null });
  assert.equal(resolve().directConnectIp, otherIp);
});

test('a cold reference with a missing or invalid edit pin never falls back to its initial delivery IP', async t => {
  for (const name of ['missing pinned operation', 'failed pinned operation', 'pinned operation belongs to another delivery']) {
    await t.test(name, async subtest => {
      const { service, delivery, ref, applied, resolve } = await sentFixture(subtest);
      service.signupConnectIps = new Map();
      service.repo.put('deliveries', { ...service.repo.get('deliveries', delivery.id),
        snapshot: { ...delivery.snapshot, directConnect: command, directConnectIp: otherIp } });
      if (name === 'missing pinned operation') service.repo.put('messageRefs', { ...ref, lastMessageOperationId: 'missing-operation' });
      else service.repo.put('messageOperations', { ...applied,
        ...(name === 'failed pinned operation' ? { status: 'failed' } : { deliveryId: 'other-delivery' }) });
      assert.equal(resolve().directConnectIp, null);
    });
  }
});

test('cold resolution rejects failed, uncertain, unpinned and differently scoped applied snapshots', async t => {
  for (const [name, patch] of [
    ['failed', { status: 'failed' }], ['running', { status: 'running' }], ['unknown', { status: 'unknown' }],
    ['lookup rather than edit', { kind: 'lookup' }], ['other delivery', { deliveryId: 'other-delivery' }],
    ['other reference', { messageRefId: 'other-reference' }],
    ['other command', { snapshot: { directConnect: 'client.connect old.example.test:28015', directConnectIp: otherIp } }],
    ['invalid IP', { snapshot: { directConnect: command, directConnectIp: '168.100.161.200;quit' } }],
  ]) {
    await t.test(name, async subtest => {
      const { service, applied, resolve } = await sentFixture(subtest);
      service.signupConnectIps = new Map();
      service.repo.put('messageOperations', { ...applied, ...patch });
      assert.equal(resolve().directConnectIp, null);
    });
  }
  await t.test('reference points at another card on the same wipe', async subtest => {
    const { service, ref, applied, resolve } = await sentFixture(subtest);
    service.signupConnectIps = new Map();
    service.repo.put('messageOperations', { ...applied, id: 'foreign-pinned-edit', deliveryId: 'other-delivery', messageRefId: 'other-reference' });
    service.repo.put('messageRefs', { ...ref, lastMessageOperationId: 'foreign-pinned-edit' });
    assert.equal(resolve().directConnectIp, null);
  });
});

test('fresh negative or invalid cache does not resurrect an old applied IP; expired cache can use the exact applied snapshot', async t => {
  for (const value of [null, undefined, '', 'not-an-ip', '2001:db8::1']) {
    await t.test(String(value), async subtest => {
      const { f, service, resolve } = await sentFixture(subtest);
      service.signupConnectIps.set(command, { ip: value, expiresAt: f.clock.now + 300000 });
      assert.equal(resolve().directConnectIp, null);
    });
  }
  await t.test('expired cache', async subtest => {
    const { f, service, resolve } = await sentFixture(subtest);
    service.signupConnectIps.set(command, { ip: otherIp, expiresAt: f.clock.now });
    assert.equal(resolve().directConnectIp, ip);
  });
});

test('old card tokens follow the current canonical command without mixing the former server IP', async t => {
  for (const freshIp of [null, otherIp]) {
    await t.test(freshIp ? 'new command with matching fresh cache' : 'new command without matching IP', async subtest => {
      const { f, service, resolve } = await sentFixture(subtest);
      const current = f.scheduling.repo.get('wipes', f.wipe.id);
      const newCommand = 'client.connect new.example.test:28015';
      f.scheduling.repo.put('wipes', { ...current, serverSnapshot: { ...current.serverSnapshot, directConnect: newCommand } });
      if (freshIp) service.signupConnectIps.set(newCommand, { ip: freshIp, expiresAt: f.clock.now + 300000 });
      const result = resolve();
      assert.equal(result.directConnect, newCommand);
      assert.equal(result.directConnectIp, freshIp);
    });
  }
});

test('existing original-card token, destination and configuration authorization boundaries still reject mismatches', async t => {
  for (const [name, change] of [
    ['wrong guild', x => ({ guildId: 'other-guild' })],
    ['wrong channel', x => ({ channelId: 'other-channel' })],
    ['wrong platform', x => ({ platform: 'kook' })],
    ['disabled target', x => { x.f.catalog.setTarget('discord-1', { enabled: false }); return {}; }],
    ['changed configuration revision', x => { x.f.catalog.setTarget('discord-1', { configurationRevision: 2 }); return {}; }],
    ['changed signup mode', x => { x.f.catalog.setTarget('discord-1', { signupMode: 'discord_only' }); return {}; }],
    ['deleted original message', x => { x.service.repo.put('messageRefs', { ...x.ref, state: 'deleted' }); return {}; }],
    ['unconfirmed action reference', x => {
      x.service.repo.put('actionReferences', { ...x.actionReference, confirmed: false }); return {};
    }],
  ]) {
    await t.test(name, async subtest => {
      const x = await sentFixture(subtest), scopePatch = change(x);
      assert.throws(() => x.resolve(scopePatch), error => error.errorCode === 'RESOURCE_NOT_FOUND');
    });
  }
  await t.test('unknown correctly-shaped token', async subtest => {
    const x = await sentFixture(subtest);
    assert.throws(() => x.resolve({}, 'a'.repeat(43)), error => error.errorCode === 'RESOURCE_NOT_FOUND');
  });
});
