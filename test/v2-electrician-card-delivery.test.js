import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createFixture } from './support/v2-notifications/fixture.js';
import { installNotificationBusinessSchema, installNotificationPlatformCardSchema } from '../server/v2/notifications/index.js';
import { installPlatformAdminSchema } from '../server/v2/platform-admin/repository.js';
import { PlatformAdminService } from '../server/v2/platform-admin/service.js';
import { createPlatformCards } from '../server/v2/platform-admin/cards.js';
import { ELECTRICIAN_COMMAND_ID, electricianTargetId } from '../server/v2/platform-admin/electrician-card.js';

function setup(t, platform) {
  const f = createFixture({ adminRole: true });
  t.after(async () => { await f.system.worker.stop(); f.close(); });
  installPlatformAdminSchema(f.db);
  installNotificationBusinessSchema(f.db);
  installNotificationPlatformCardSchema(f.db);
  const platformService = new PlatformAdminService({ identity: f.identity, now: () => f.clock.now });
  platformService.repo.put('electrician-roster', 'shared', 'shared', f.actor().id, f.clock.now, {
    revision: 1, entries: [
      { kind: 'manual', group: 'CN', name: '共享电工', url: 'https://steamcommunity.com/profiles/76561198000000001/' },
      { kind: 'manual', group: 'EU', name: 'Shared electrician', url: 'https://steamcommunity.com/id/shared-electrician/' },
    ] });
  const language = platform === 'discord' ? 'en' : 'zh-CN';
  const guildId = platform === 'discord' ? '1554983512321425488' : '8900601550851301';
  const electricianChannelId = platform === 'discord' ? '1554985842970468423' : '1630990274298012';
  const config = { enabled: true,
    targets: [{ id: 'electrician-server', name: 'RSG', guildId, channelId: '100000000000000000', electricianChannelId,
      enabled: true, enabledCommandIds: [ELECTRICIAN_COMMAND_ID] }],
    commands: [{ id: ELECTRICIAN_COMMAND_ID, name: 'Electricians', type: 'persistent_card', enabled: true,
      electriciansCn: '电工 | https://steamcommunity.com/profiles/76561198000000001/',
      electriciansForeign: 'Electrician | https://steamcommunity.com/id/electrician/' }] };
  platformService.save(f.actor(), platform, { expectedRevision: 0, config }, { operationId: randomUUID() });
  const targetId = electricianTargetId('electrician-server', platform);
  f.catalog.targets.set(targetId, { ...f.catalog.getTarget(`${platform}-1`), id: targetId, guildId,
    channelId: electricianChannelId, languages: [language] });
  let tail = Promise.resolve();
  const runStoreWriteTask = fn => { const work = tail.then(fn); tail = work.catch(() => {}); return work; };
  platformService.adapters.cards = createPlatformCards({ identity: f.identity, scheduling: f.scheduling,
    notifications: f.system.service, platformService, runStoreWriteTask, now: () => f.clock.now });
  const input = { expectedRevision: 1, cardType: 'electrician_ids', targetId, language };
  const execute = (action, fields = {}, operationId = randomUUID()) => platformService.execute(f.actor(), platform, action,
    { ...input, ...fields }, { operationId });
  const preview = async () => {
    const result = await execute('card_preview');
    assert.equal(result.status, 'succeeded', JSON.stringify(result));
    return result.result.preview;
  };
  const urls = payload => platform === 'discord' ? payload.components.flatMap(row => row.components).filter(button => button.style === 5).map(button => button.url)
    : JSON.parse(payload.content)[0].modules.find(module => module.type === 'action-group').elements.map(button => button.value);
  return { ...f, platformService, config, input, execute, preview, urls, guildId, electricianChannelId };
}

for (const platform of ['discord', 'kook']) test(`${platform} previews, sends and refreshes the exact electrician card without replay duplication`, async t => {
  const f = setup(t, platform), preview = await f.preview();
  const expectedUrl = `https://clan.example.com/guides/electricians.html?${platform === 'discord' ? 'platform=discord&' : ''}guildId=${f.guildId}&channelId=${f.electricianChannelId}`;
  assert.ok(preview.body.includes(expectedUrl));
  assert.match(preview.title, platform === 'discord' ? /Electricians/ : /电工/);
  const fields = { previewId: preview.id, contentHash: preview.contentHash }, operationId = randomUUID();
  const queued = await f.execute('card_publish', fields, operationId);
  assert.equal(queued.status, 'queued', JSON.stringify(queued));
  assert.equal(f.transport.calls.length, 0);
  await f.system.worker.runOnce({ workerId: 'electricians-publish' });
  const delivery = f.system.service.repo.get('deliveries', queued.result.reference);
  assert.equal(delivery.status, 'sent', JSON.stringify(delivery));
  const sent = f.transport.calls.find(call => call.operation === 'send');
  assert.equal(sent.target.platform, platform);
  assert.equal(sent.target.channelId, f.electricianChannelId);
  assert.deepEqual(f.urls(sent.payload), [expectedUrl, `${expectedUrl}#tutorial`]);
  const originalRef = f.system.service.repo.all('messageRefs').find(ref => ref.deliveryId === delivery.id);
  assert.ok(originalRef?.messageId);
  assert.equal((await f.execute('card_publish', fields, operationId)).status, 'succeeded');
  await f.system.worker.runOnce({ workerId: 'electricians-replay' });
  assert.equal(f.transport.calls.filter(call => call.operation === 'send').length, 1);
  const refreshed = await f.preview();
  const update = await f.execute('card_refresh', { previewId: refreshed.id, contentHash: refreshed.contentHash });
  assert.equal(update.status, 'queued', JSON.stringify(update));
  await f.system.worker.runOnce({ workerId: 'electricians-refresh' });
  const edit = f.transport.calls.find(call => call.operation === 'edit');
  assert.equal(edit.messageRef.messageId, originalRef.messageId);
  assert.equal(edit.messageRef.platform, platform);
  assert.equal(edit.messageRef.channelId, f.electricianChannelId);
  assert.deepEqual(f.urls(edit.payload), [expectedUrl, `${expectedUrl}#tutorial`]);
  assert.equal(f.transport.calls.filter(call => call.operation === 'send').length, 1);
});

test('unknown Discord card delivery prevents a new operation from creating a duplicate', async t => {
  const f = setup(t, 'discord'), preview = await f.preview();
  f.transport.enqueue('send', { outcome: 'unknown', errorCode: 'PLATFORM_TIMEOUT' });
  const fields = { previewId: preview.id, contentHash: preview.contentHash };
  const queued = await f.execute('card_publish', fields);
  await f.system.worker.runOnce({ workerId: 'electricians-unknown' });
  assert.equal(f.system.service.repo.get('deliveries', queued.result.reference).status, 'delivery_unknown');
  const retry = await f.execute('card_publish', fields);
  assert.equal(retry.status, 'failed');
  assert.equal(retry.errorCode, 'CARD_DELIVERY_PENDING');
  await f.system.worker.runOnce({ workerId: 'electricians-no-duplicate' });
  assert.equal(f.transport.calls.filter(call => call.operation === 'send').length, 1);
});

test('Discord electrician preview rejects a KOOK target identity and supports Chinese', async t => {
  const f = setup(t, 'discord');
  assert.equal((await f.execute('card_preview', { targetId: electricianTargetId('electrician-server') })).errorCode, 'TARGET_NOT_CONFIGURED');
  const chinese = await f.execute('card_preview', { language: 'zh-CN' });
  assert.equal(chinese.status, 'succeeded');
  assert.match(chinese.result.preview.title, /电工/);
  assert.equal(f.transport.calls.length, 0);
});

test('changed shared sources invalidate an old preview without sending a card', async t => {
  const f = setup(t, 'discord'), preview = await f.preview();
  const roster = f.platformService.repo.get('electrician-roster', 'shared');
  f.platformService.repo.put('electrician-roster', 'shared', 'shared', f.actor().id, f.clock.now,
    { ...roster, revision: roster.revision + 1, entries: [...roster.entries,
      { kind: 'manual', group: 'CN', name: 'New shared electrician', url: 'https://steamcommunity.com/id/new-electrician/' }] });
  const result = await f.execute('card_publish', { previewId: preview.id, contentHash: preview.contentHash });
  assert.equal(result.status, 'failed');
  assert.equal(result.errorCode, 'PREVIEW_STALE');
  assert.equal(f.transport.calls.length, 0);
});

test('member-based roster changes invalidate a preview even without a roster revision change', async t => {
  const f = setup(t, 'discord');
  f.identity.repo.put('members', { id: 'selected-electrician', customName: 'Selected electrician', steamId: '76561198000000991', memberStatus: 'active', specialty: ['electricity'] });
  f.platformService.repo.put('electrician-roster', 'shared', 'shared', f.actor().id, f.clock.now,
    { revision: 2, entries: [{ kind: 'specialty', group: 'CN', specialty: 'electricity', squadId: '' }] });
  const preview = await f.preview();
  f.identity.repo.put('members', { ...f.identity.repo.get('members', 'selected-electrician'), customName: 'Changed electrician' });
  const result = await f.execute('card_publish', { previewId: preview.id, contentHash: preview.contentHash });
  assert.equal(result.errorCode, 'PREVIEW_STALE');
  assert.equal(f.transport.calls.length, 0);
});

test('Discord card cannot publish its stale embedded list when the shared source is missing', async t => {
  const f = setup(t, 'discord');
  f.platformService.repo.db.prepare('DELETE FROM platform_admin_records WHERE kind=? AND id=?').run('electrician-roster', 'shared');
  const result = await f.execute('card_preview');
  assert.equal(result.status, 'failed');
  assert.equal(result.errorCode, 'ELECTRICIAN_LIST_INVALID');
  assert.equal(f.transport.calls.length, 0);
});
