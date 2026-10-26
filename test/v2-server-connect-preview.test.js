import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createFixture } from './support/v2-notifications/fixture.js';
import { installNotificationBusinessSchema, installNotificationPlatformCardSchema } from '../server/v2/notifications/index.js';
import { installPlatformAdminSchema, PlatformAdminRepository } from '../server/v2/platform-admin/repository.js';
import { PlatformAdminService } from '../server/v2/platform-admin/service.js';
import { createPlatformCards } from '../server/v2/platform-admin/cards.js';
import { SERVER_CONNECT_COMMAND_ID, serverConnectTargetId, normalizeServerConnectOverride } from '../server/v2/platform-admin/server-connect-card.js';

const edited = { name: 'Edited Atlas server', serverScheduledWipeAt: '2030-09-10T05:30:00+08:00', command: 'client.connect atlas.example:28015' };
const operation = () => ({ operationId: randomUUID() });

function setup(t, platform = 'discord', resolveConnectIp = async () => null) {
  const f = createFixture({ adminRole: true });
  t.after(async () => { await f.system.worker.stop(); f.close(); });
  installPlatformAdminSchema(f.db);
  installNotificationBusinessSchema(f.db);
  installNotificationPlatformCardSchema(f.db);
  const platformService = new PlatformAdminService({ identity: f.identity, now: () => f.clock.now });
  platformService.save(f.actor(), platform, { expectedRevision: 0, config: {
    enabled: true,
    targets: [{ id: 'connect-server', name: 'Fixture server', guildId: `fixture-${platform}`, channelId: 'general',
      serverConnectChannelId: 'connect-channel', enabled: true, enabledCommandIds: [SERVER_CONNECT_COMMAND_ID] }],
    commands: [{ id: SERVER_CONNECT_COMMAND_ID, name: 'Server connect', type: 'persistent_card', enabled: true }]
  } }, operation());
  const targetId = serverConnectTargetId('connect-server', platform);
  const language = platform === 'discord' ? 'en' : 'zh-CN';
  f.catalog.targets.set(targetId, { ...f.catalog.getTarget(`${platform}-1`), id: targetId, channelId: 'connect-channel', languages: [language] });
  let tail = Promise.resolve();
  const runStoreWriteTask = fn => { const work = tail.then(fn); tail = work.catch(() => {}); return work; };
  const cards = createPlatformCards({ identity: f.identity, scheduling: f.scheduling, notifications: f.system.service,
    platformService, runStoreWriteTask, resolveConnectIp, now: () => f.clock.now });
  platformService.adapters.cards = cards;
  const wipe = f.scheduling.repo.get('wipes', f.wipe.id);
  f.scheduling.repo.put('wipes', { ...wipe, serverSnapshot: { name: 'Original server', connectCommand: 'connect original.example:28015' } });
  const input = { expectedRevision: 1, cardType: 'server_connect', targetId, wipeId: f.wipe.id, language };
  const execute = (action, fields = {}) => platformService.execute(f.actor(), platform, action, { ...input, ...fields }, operation());
  const preview = async (override = edited) => {
    const result = await execute('card_preview', override === null ? {} : { serverConnectOverride: override });
    assert.equal(result.status, 'succeeded', JSON.stringify(result));
    return result.result.preview;
  };
  const publish = (p, fields = {}) => execute('card_publish', { previewId: p.id, contentHash: p.contentHash, ...fields });
  return { ...f, platformService, execute, preview, publish, input, cardRepo: new PlatformAdminRepository(f.db) };
}

for (const platform of ['kook', 'discord']) test(`${platform} preview pins the resolved IP for the later send`, async t => {
  let resolvedIp = '216.39.240.89';
  const f = setup(t, platform, async command => {
    assert.equal(command, edited.command);
    return resolvedIp;
  });
  const p = await f.preview();
  assert.match(p.body, /client\.connect 216\.39\.240\.89:28015/);
  assert.equal(f.cardRepo.get('card-preview', p.id).input.serverConnectResolvedIp, '216.39.240.89');
  resolvedIp = '216.39.240.90';
  assert.equal((await f.publish(p)).status, 'queued');
  await f.system.worker.runOnce({ workerId: 'connect-ip-worker' });
  const sent = f.transport.calls.find(call => call.operation === 'send');
  assert.match(platform === 'kook' ? sent.payload.content : JSON.stringify(sent.payload.embeds), /```\\nclient\.connect 216\.39\.240\.89:28015\\n```/);
});

for (const platform of ['discord', 'kook']) test(`${platform} sends the edited preview snapshot without changing the wipe`, async t => {
  const f = setup(t, platform), before = f.scheduling.repo.get('wipes', f.wipe.id);
  const p = await f.preview();
  assert.match(p.body, /Edited Atlas server/);
  const time = platform === 'discord' ? `<t:${Date.parse(edited.serverScheduledWipeAt) / 1000}:F>` : '2030-09-10 05:30';
  assert.ok(p.body.includes(time));
  const saved = f.cardRepo.get('card-preview', p.id);
  assert.equal(saved.input.serverConnectOverride.serverScheduledWipeAt, '2030-09-09T21:30:00.000Z');
  const published = await f.publish(p);
  assert.equal(published.status, 'queued', JSON.stringify(published));
  await f.system.worker.runOnce({ workerId: 'connect-preview-worker' });
  const delivery = f.system.service.repo.get('deliveries', published.result.reference);
  assert.equal(delivery.status, 'sent', JSON.stringify(delivery));
  const sent = f.transport.calls.find(call => call.operation === 'send');
  assert.equal(sent.target.channelId, 'connect-channel');
  const content = platform === 'discord' ? JSON.stringify(sent.payload.embeds) : sent.payload.content;
  assert.match(content, /Edited Atlas server/);
  assert.ok(content.includes(time));
  assert.match(content, /client\.connect atlas\.example:28015/);
  assert.deepEqual(f.scheduling.repo.get('wipes', f.wipe.id), before);
});

test('server connect previews bind wipe revision and exact publish scope', async t => {
  const f = setup(t), p = await f.preview();
  for (const fields of [{ targetId: 'another-target' }, { wipeId: 'another-wipe' }, { cardType: 'map' }, { contentHash: 'different' }]) {
    const result = await f.publish(p, fields);
    assert.equal(result.status, 'failed');
    assert.equal(result.errorCode, 'PREVIEW_STALE');
  }
  assert.equal((await f.publish(p, { serverConnectOverride: { ...edited, command: 'connect other.example:28015' } })).errorCode, 'SERVER_CONNECT_INPUT_INVALID');
  const wipe = f.scheduling.repo.get('wipes', f.wipe.id);
  f.scheduling.repo.put('wipes', { ...wipe, revision: wipe.revision + 1 });
  assert.equal((await f.publish(p)).errorCode, 'PREVIEW_STALE');
  assert.equal(f.system.service.repo.all('deliveries').length, 0);
  assert.equal(f.transport.calls.length, 0);
});

for (const change of ['permissions', 'configuration', 'channel']) test(`queued edited cards recheck ${change} before dispatch`, async t => {
  const f = setup(t), published = await f.publish(await f.preview());
  assert.equal(published.status, 'queued');
  if (change === 'permissions') {
    const actor = f.identity.repo.get('accounts', 'admin');
    f.identity.repo.put('accounts', { ...actor, permissionVersion: actor.permissionVersion + 1 });
  } else if (change === 'configuration') {
    const config = f.platformService.config('discord');
    f.cardRepo.put('config', 'discord', 'discord', 'admin', f.clock.now, { ...config, revision: config.revision + 1 });
  } else f.catalog.targets.set(f.input.targetId, { ...f.catalog.getTarget(f.input.targetId), channelId: 'changed-channel' });
  await f.system.worker.runOnce({ workerId: 'connect-preview-worker' });
  assert.equal(f.transport.calls.length, 0);
  const delivery = f.system.service.repo.get('deliveries', published.result.reference);
  assert.ok(['failed', 'cancelled'].includes(delivery.status), delivery.status);
  assert.equal(delivery.lastErrorCode, change === 'permissions' ? 'PERMISSIONS_CHANGED' : 'PREVIEW_STALE');
});

test('expired edited previews cannot publish', async t => {
  const f = setup(t), p = await f.preview();
  f.clock.advance(600_001);
  assert.equal((await f.publish(p)).errorCode, 'PREVIEW_EXPIRED');
  assert.equal(f.system.service.repo.all('deliveries').length, 0);
  assert.equal(f.transport.calls.length, 0);
});

test('queued edited cards recheck wipe revision before dispatch', async t => {
  const f = setup(t), published = await f.publish(await f.preview());
  assert.equal(published.status, 'queued');
  const wipe = f.scheduling.repo.get('wipes', f.wipe.id);
  f.scheduling.repo.put('wipes', { ...wipe, contentRevision: wipe.contentRevision + 1 });
  await f.system.worker.runOnce({ workerId: 'connect-preview-worker' });
  assert.equal(f.transport.calls.length, 0);
  assert.equal(f.system.service.repo.get('deliveries', published.result.reference).lastErrorCode, 'PREVIEW_STALE');
});

test('overrides are limited to server connect previews and validated as one safe command', async t => {
  const f = setup(t);
  const suppliedIp = await f.execute('card_preview', { serverConnectResolvedIp: '216.39.240.89' });
  assert.equal(suppliedIp.status, 'failed');
  assert.equal(suppliedIp.errorCode, 'SERVER_CONNECT_INPUT_INVALID');
  for (const override of [null, [], { ...edited, targetId: 'another-channel' }, { ...edited, name: '' },
    { ...edited, name: 'x'.repeat(181) }, { ...edited, serverScheduledWipeAt: '2030-09-10T05:30' },
    { ...edited, serverScheduledWipeAt: '2030-02-30T05:30:00Z' },
    ...['connect host:28015;quit', 'connect host:28015\nquit', 'connect host:28015\u0000', 'connect host',
      'connect host:65536', 'connect @everyone:28015', 'connect (met)all(met):28015', 'connect `host`:28015',
      'quit', 'connect 999.1.1.1:28015', 'connect host:28015 password'].map(command => ({ ...edited, command }))]) {
    const result = await f.execute('card_preview', { serverConnectOverride: override });
    assert.equal(result.status, 'failed');
    assert.equal(result.errorCode, 'SERVER_CONNECT_INPUT_INVALID', JSON.stringify(override));
  }
  const result = await f.execute('card_preview', { cardType: 'map', serverConnectOverride: edited });
  assert.equal(result.errorCode, 'SERVER_CONNECT_INPUT_INVALID');
  assert.equal(f.transport.calls.length, 0);
  assert.equal(normalizeServerConnectOverride({ ...edited, command: 'connect [2001:db8::1]:28015' }).command, 'connect [2001:db8::1]:28015');
});

test('different native details have different hashes and old previews without overrides still work', async t => {
  const f = setup(t), first = await f.preview({ ...edited, name: '@Atlas' }), second = await f.preview({ ...edited, name: '＠Atlas' });
  assert.equal(first.body, second.body);
  assert.notEqual(first.contentHash, second.contentHash);
  const original = await f.preview(null);
  assert.match(original.body, /Original server/);
  assert.equal((await f.publish(original)).status, 'queued');
});

for (const platform of ['kook', 'discord']) for (const phase of ['queued', 'running'])
test(`${platform} refresh joins an identical ${phase} update and keeps its original message`, async t => {
  const f = setup(t, platform), p = await f.preview();
  const sent = await f.publish(p);
  await f.system.worker.runOnce({ workerId: 'initial-connect' });
  const delivery = f.system.service.repo.get('deliveries', sent.result.reference);
  const messageId = f.system.service.resourceRows('messageRefs', delivery)[0].messageId;
  const refresh = await f.execute('card_refresh', { previewId: p.id, contentHash: p.contentHash });
  assert.equal(refresh.status, 'queued');
  let finish, started;
  const ready = new Promise(resolve => { started = resolve; });
  const held = new Promise(resolve => { finish = resolve; });
  let worker;
  if (phase === 'running') {
    f.transport.enqueue('edit', async () => { started(); await held; return { outcome: 'updated' }; });
    worker = f.system.worker.runOnce({ workerId: 'held-connect-edit' });
    await ready;
  }
  const before = f.system.service.repo.all('messageOperations').length;
  const next = await f.preview(), request = operation();
  const joined = await f.platformService.execute(f.actor(), platform, 'card_refresh', {
    ...f.input, previewId: next.id, contentHash: next.contentHash
  }, request);
  assert.equal(joined.status, phase, JSON.stringify(joined));
  assert.equal(joined.result.reference, refresh.result.reference);
  assert.equal(f.system.service.repo.all('messageOperations').length, before);
  assert.equal(f.platformService.receipt(f.actor(), request.operationId).status, phase);
  if (worker) { finish(); await worker; }
  else await f.system.worker.runOnce({ workerId: 'complete-connect-edit' });
  assert.equal(f.platformService.receipt(f.actor(), request.operationId).status, 'succeeded');
  assert.equal(f.system.service.resourceRows('messageRefs', delivery)[0].messageId, messageId);
  assert.equal(f.transport.calls.filter(call => call.operation === 'send').length, 1);
});

test('a pending different update or an uncertain result cannot be joined or resent', async t => {
  const f = setup(t, 'kook'), p = await f.preview();
  await f.publish(p);
  await f.system.worker.runOnce({ workerId: 'initial-connect' });
  const refresh = await f.execute('card_refresh', { previewId: p.id, contentHash: p.contentHash });
  const different = await f.preview({ ...edited, command: 'client.connect another.example:28015' });
  assert.equal((await f.execute('card_refresh', { previewId: different.id, contentHash: different.contentHash })).errorCode, 'CARD_UPDATE_PENDING');
  assert.equal((await f.publish(p)).errorCode, 'CARD_UPDATE_PENDING');
  f.transport.enqueue('edit', { outcome: 'unknown', errorCode: 'KOOK_RESULT_UNCONFIRMED' });
  await f.system.worker.runOnce({ workerId: 'uncertain-connect-edit' });
  assert.equal(f.system.service.repo.get('messageOperations', refresh.result.reference).status, 'unknown');
  const same = await f.preview();
  assert.equal((await f.execute('card_refresh', { previewId: same.id, contentHash: same.contentHash })).errorCode, 'CARD_UPDATE_PENDING');
  assert.equal(f.transport.calls.filter(call => call.operation === 'send').length, 1);
});
