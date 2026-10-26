import test from 'node:test';
import assert from 'node:assert/strict';
import { createFixture } from './support/v2-notifications/fixture.js';
import { installNotificationBusinessSchema, installNotificationOpenWipeSchema } from '../server/v2/notifications/index.js';
import { installPlatformAdminSchema, PlatformAdminRepository } from '../server/v2/platform-admin/repository.js';
import { markOpenWipeProof } from '../server/v2/discord-open-wipe/proof.js';
import { createDiscordOpenWipeService, openWipeTargetId } from '../server/v2/discord-open-wipe/service.js';
import { renderOpenWipeCard } from '../server/v2/discord-open-wipe/renderer.js';
import { wipeServerCatalog } from '../server/v2/production/wipe-catalog.js';
import { buildNativePrivateResponseRequest } from '../server/v2/notification-platforms/platforms.js';

const guildId = '1153571748147634236', channelId = '1153572000000000000', ownerId = '1167000000000000000', userId = '1177000000000000000';
const tokenFrom = reply => (reply.data.custom_id || reply.data.components.flatMap(row => row.components || []).find(row => row.custom_id)?.custom_id).split(':')[2];
const buttons = payload => payload.components.flatMap(row => row.components || []);
const buttonToken = (payload, action) => buttons(payload).find(button => button.custom_id?.startsWith(`nbopen:${action}:`)).custom_id.split(':')[2];
const input = { serverId: '19', autoConnect: true, adaptiveDisplay: true, directConnect: '', notes: 'Bring resources.' };
const error = code => value => value.errorCode === code;

function setup(t, options = {}) {
  const f = createFixture({ adminRole: true, now: Date.parse('2026-10-14T12:00:00Z') });
  t.after(async () => { await f.system.worker.stop(); f.close(); });
  installPlatformAdminSchema(f.db); installNotificationBusinessSchema(f.db); installNotificationOpenWipeSchema(f.db);
  const config = { enabled: true, revision: 1, commands: [{ id: 'newwipe', enabled: true, type: 'event_command', slashCommand: 'newwipe' }],
    targets: [{ id: 'personal', enabled: true, guildId, channelId, enabledCommandIds: ['newwipe'], newwipeAllowedUserIds: [ownerId], newwipeAllowAdministrators: false }] };
  const targetId = openWipeTargetId('personal', channelId);
  f.catalog.targets.set(targetId, { ...f.catalog.getTarget('discord-1'), id: targetId, guildId, channelId, configurationRevision: 1 });
  f.catalog.listOptions = kind => ({ items: kind === 'servers' ? wipeServerCatalog({}, new Date(f.clock.now)) : [] });
  let prepared = 0, dnsCalls = 0;
  f.catalog.prepareOptions = async () => { prepared++; };
  const platformService = { identity: f.identity, config: () => config };
  const service = createDiscordOpenWipeService({ notifications: f.system.service, platformService, now: () => f.clock.now,
    runStoreWriteTask: task => Promise.resolve().then(task), resolveIp: async command => { dnsCalls++; return options.resolveIp ? options.resolveIp(command) : '168.100.161.200'; } });
  const repo = new PlatformAdminRepository(f.db);
  let sequence = 0;
  function proof(action, payload = {}, overrides = {}) {
    return markOpenWipeProof({ provider: 'discord', guildId, channelId, externalId: ownerId, discordRoleIds: [], discordPermissions: '0',
      externalDisplayName: 'Unlinked Discord user', locale: 'zh-CN', interactionId: `1188000000000${String(++sequence).padStart(6, '0')}`,
      originEphemeral: ['publish', 'settings', 'server', 'edit_details', 'select_server'].includes(action) && !overrides.originMessageId,
      payload: { kind: 'open_wipe', action, ...payload }, ...overrides });
  }
  const records = kind => repo.list(`open-wipe-${kind}`, 'discord', { limit: 1000 });
  async function draft(values = input) {
    const modal = service.handleVerified(proof('open'));
    assert.equal(modal.type, 4);
    const token = tokenFrom(modal), preview = await service.handleVerified(proof('create_submit', { token, values }));
    return { token, preview };
  }
  async function publish(values = input) {
    const draftResult = await draft(values);
    const response = await service.handleVerified(proof('publish', { token: draftResult.token }, { originEphemeral: true }));
    await f.system.worker.runOnce({ workerId: 'open-wipe-test' });
    const card = records('card')[0], delivery = f.system.service.repo.get('deliveries', card.deliveryId);
    assert.equal(delivery.status, 'sent', JSON.stringify(delivery));
    const ref = f.system.service.repo.forResource('messageRefs', delivery.resource)[0];
    return { ...draftResult, response, card, delivery, ref };
  }
  return { ...f, service, repo, config, proof, draft, publish, records, targetId, prepared: () => prepared, dnsCalls: () => dnsCalls };
}

test('a personal guild publishes an independent English card without creating a scheduling Wipe or website actor', async t => {
  const f = setup(t), before = f.scheduling.repo.all('wipes');
  const modal = f.service.handleVerified(f.proof('open'));
  assert.equal(f.prepared(), 0); assert.equal(f.dnsCalls(), 0);
  assert.equal(buttons(modal.data).find(row => row.type === 3).options.length, 12);
  const result = await f.publish();
  assert.match(result.response.content, /队列/);
  assert.equal(f.prepared(), 1);
  assert.deepEqual(f.scheduling.repo.all('wipes'), before);
  assert.equal(result.delivery.createdByAccountId, null);
  assert.equal(result.delivery.resource.kind, 'discordOpenWipe');
  const sent = f.transport.calls.filter(call => call.operation === 'send');
  assert.equal(sent.length, 1); assert.equal(sent[0].target.guildId, guildId);
  assert.doesNotMatch(sent[0].payload.embeds[0].description, /No website sign-in|Steam|无需登录/);
  assert.deepEqual(sent[0].payload.components[0].components.map(row => row.label), ['Accepted', 'Declined', 'Late', 'Settings']);
  assert.match(sent[0].payload.embeds[0].fields[0].value, /<t:/);
  assert.equal(f.identity.repo.all('identities').some(row => row.externalId === ownerId), false);
  assert.throws(() => f.service.handleVerified({ ...f.proof('open') }), error('PLATFORM_AUTH_INVALID'));
});

test('unconfigured RSG and other guilds and channels cannot admit any public send', async t => {
  const f = setup(t);
  for (const override of [{ guildId: '1554983512321425488' }, { channelId: '1199000000000000000' }, { externalId: userId }])
    assert.throws(() => f.service.handleVerified(f.proof('open', {}, override)));
  await f.system.worker.runOnce({ workerId: 'open-wipe-test' });
  assert.equal(f.records('card').length, 0); assert.equal(f.transport.calls.filter(call => call.operation === 'send').length, 0);
});

test('selecting a server immediately previews its date and address with defaults before any form or public send', async t => {
  const f = setup(t);
  const opened = f.service.handleVerified(f.proof('open'));
  const token = tokenFrom(opened);
  assert.equal(opened.type, 4); assert.equal(opened.data.flags, 32768 | 64);
  assert.equal(buttons(opened.data).filter(row => row.type === 2).length, 0);
  const result = await f.service.handleVerified(f.proof('select_server', { token, values: { serverId: '19' } }));
  assert.match(JSON.stringify(result.components), /<t:1792080000:F>/);
  assert.match(JSON.stringify(result.components), /client.connect eu-medium.vitalrust.com:28014/);
  const draft = f.records('draft')[0];
  assert.equal(draft.settings.adaptiveDisplay, true); assert.equal(draft.settings.autoConnect, true);
  assert.equal(f.records('card').length, 0); assert.equal(f.transport.calls.length, 0);
  const modal = f.service.handleVerified(f.proof('edit_details', { token }));
  assert.equal(modal.type, 9);
  assert.equal(modal.data.components[0].component.value, '2026-10-15 17:00');
  await assert.rejects(f.service.handleVerified(f.proof('select_server', { token, values: { serverId: '16' } },
    { originEphemeral: false, originMessageId: 'copied-public' })), error('MESSAGE_REFERENCE_REQUIRED'));
  await assert.rejects(f.service.handleVerified(f.proof('select_server', { token, values: { serverId: '16' } },
    { externalId: userId })), error('NEWWIPE_PUBLISHER_DENIED'));
  f.config.targets[0].newwipeAllowedUserIds.push(userId);
  await assert.rejects(f.service.handleVerified(f.proof('select_server', { token, values: { serverId: '16' } },
    { externalId: userId })), error('OPEN_WIPE_TOKEN_INVALID'));
});

test('the single Late action replaces an old delayed response without duplicating the participant', async t => {
  const f = setup(t), { card, ref } = await f.publish();
  const overrides = { externalId: userId, originMessageId: ref.messageId };
  await f.service.handleVerified(f.proof('signup_8h', { token: card.publicToken }, overrides));
  const result = await f.service.handleVerified(f.proof('signup_late', { token: card.publicToken }, overrides));
  assert.equal(f.records('signup').length, 1); assert.equal(f.records('signup')[0].response, 'late');
  assert.equal(f.records('signup')[0].revision, 2);
  assert.equal(result.content, '你在 **Vital Rust 2X EU Medium** 的报名状态为 🕒 迟到。');
  assert.deepEqual(result.embeds, []); assert.deepEqual(result.components, []);
  assert.doesNotMatch(JSON.stringify(result), /晚 8|晚 16|Steam|无需登录/);
  await f.system.worker.runOnce({ workerId: 'open-wipe-test' });
  assert.match(JSON.stringify(f.transport.messages.get(ref.messageId).payload.embeds), /Late · 1/);
});

test('an unlinked participant signs up idempotently with a clickable Discord profile and changes their response', async t => {
  const f = setup(t), { card, ref } = await f.publish();
  const action = f.proof('signup_on_time', { token: card.publicToken }, { externalId: userId, discordPermissions: '0', originMessageId: ref.messageId });
  const result = await f.service.handleVerified(action);
  assert.equal(result.content, '你在 **Vital Rust 2X EU Medium** 的报名状态为 ✅ 参加。');
  assert.deepEqual(result.embeds, []); assert.deepEqual(result.components, []);
  await f.service.handleVerified(action);
  assert.equal(f.records('signup').length, 1); assert.equal(f.records('signup')[0].revision, 1);
  await f.service.handleVerified(f.proof('signup_8h', { token: card.publicToken }, { externalId: userId, originMessageId: ref.messageId }));
  assert.equal(f.records('signup')[0].response, 'late_8h'); assert.equal(f.records('signup')[0].revision, 2);
  await f.system.worker.runOnce({ workerId: 'open-wipe-test' });
  assert.equal(f.transport.calls.filter(call => call.operation === 'send').length, 1);
  assert.ok(f.transport.calls.filter(call => call.operation === 'edit').every(call => call.messageRef.messageId === ref.messageId));
  assert.match(JSON.stringify(f.transport.messages.get(ref.messageId).payload.embeds), new RegExp(`https://discord.com/users/${userId}`));
  assert.equal(f.identity.repo.all('accounts').some(row => row.id === userId), false);
});

test('public tokens require the exact original message and private tokens require the same actor and an ephemeral source', async t => {
  const f = setup(t), { card, ref } = await f.publish();
  await assert.rejects(f.service.handleVerified(f.proof('signup_on_time', { token: card.publicToken }, { externalId: userId, originMessageId: 'copied-message' })), error('MESSAGE_REFERENCE_REQUIRED'));
  await assert.rejects(f.service.handleVerified(f.proof('signup_on_time', { token: card.publicToken }, { externalId: userId, originMessageId: ref.messageId, originEphemeral: true })), error('MESSAGE_REFERENCE_REQUIRED'));
  const view = await f.service.handleVerified(f.proof('language', { token: card.publicToken }, { externalId: userId, originMessageId: ref.messageId, locale: 'ru' }));
  const token = buttonToken(view, 'signup_on_time');
  await assert.rejects(f.service.handleVerified(f.proof('signup_on_time', { token }, { externalId: ownerId, originMessageId: 'private', originEphemeral: true })), error('OPEN_WIPE_TOKEN_INVALID'));
  await assert.rejects(f.service.handleVerified(f.proof('signup_on_time', { token }, { externalId: userId, originMessageId: ref.messageId })), error('MESSAGE_REFERENCE_REQUIRED'));
  await f.service.handleVerified(f.proof('signup_16h', { token }, { externalId: userId, originMessageId: 'private', originEphemeral: true }));
  assert.equal(f.records('signup')[0].response, 'late_16h');
});

test('a draft button cannot be copied into a public message even by its owner', async t => {
  const f = setup(t), { token } = await f.draft();
  await assert.rejects(f.service.handleVerified(f.proof('publish', { token }, { originMessageId: 'copied-public', originEphemeral: false })), error('MESSAGE_REFERENCE_REQUIRED'));
  for (const action of ['settings', 'server', 'edit_details'])
    assert.throws(() => f.service.handleVerified(f.proof(action, { token }, { originMessageId: 'copied-public', originEphemeral: false })), error('MESSAGE_REFERENCE_REQUIRED'));
  assert.equal(f.records('card').length, 0);
});

test('published settings preserve the same message and signup roster and reject stale concurrent editors', async t => {
  const f = setup(t), { card, ref } = await f.publish();
  await f.service.handleVerified(f.proof('signup_on_time', { token: card.publicToken }, { externalId: userId, originMessageId: ref.messageId }));
  const first = f.service.handleVerified(f.proof('settings', { token: card.publicToken }, { originMessageId: ref.messageId }));
  const second = f.service.handleVerified(f.proof('settings', { token: card.publicToken }, { originMessageId: ref.messageId }));
  const details = f.service.handleVerified(f.proof('edit_details', { token: tokenFrom(first) }, { originEphemeral: true }));
  assert.equal(details.type, 9);
  assert.equal(details.data.components[0].component.value, card.settings.wipeAtLocal.replace('T', ' '));
  const values = { wipeAtLocal: card.settings.wipeAtLocal, timeZone: card.settings.timeZone, directConnect: card.settings.directConnect,
    notes: 'New announcement', autoConnect: true, adaptiveDisplay: true };
  const result = await f.service.handleVerified(f.proof('settings_submit', { token: tokenFrom(first), values }));
  assert.match(result.content, /队列/);
  await assert.rejects(f.service.handleVerified(f.proof('settings_submit', { token: tokenFrom(second), values })), error('REVISION_CONFLICT'));
  await f.system.worker.runOnce({ workerId: 'open-wipe-test' });
  assert.equal(f.records('signup').length, 1); assert.equal(f.records('card')[0].revision, 2);
  assert.equal(f.transport.calls.filter(call => call.operation === 'send').length, 1);
  const applied = f.transport.messages.get(ref.messageId).payload;
  assert.match(applied.embeds[0].description, /New announcement/);
  assert.match(JSON.stringify(applied), new RegExp(userId));
});

test('DNS is resolved after publication and only updates the original message once', async t => {
  const f = setup(t), { ref } = await f.publish();
  assert.equal(f.dnsCalls(), 0);
  f.clock.advance(6000); await f.system.worker.runOnce({ workerId: 'open-wipe-test' });
  f.clock.advance(6000); await f.system.worker.runOnce({ workerId: 'open-wipe-test' });
  assert.equal(f.dnsCalls(), 1);
  assert.match(JSON.stringify(f.transport.messages.get(ref.messageId).payload), /client.connect 168\.100\.161\.200:28014/);
  const calls = f.transport.calls.length;
  f.clock.advance(6000); await f.system.worker.runOnce({ workerId: 'open-wipe-test' });
  assert.equal(f.dnsCalls(), 1); assert.equal(f.transport.calls.length, calls);
});

test('a missing automatic date remains an editable unpublished preview', async t => {
  const f = setup(t);
  const { token, preview } = await f.draft({ ...input, serverId: 'moose-eu-main' });
  assert.equal(buttons(preview).some(button => button.custom_id?.startsWith('nbopen:publish:')), false);
  assert.equal(f.records('draft')[0].settings.wipeAt, null);
  await assert.rejects(f.service.handleVerified(f.proof('publish', { token })), error('OPEN_WIPE_TIME_REQUIRED'));
  const modal = f.service.handleVerified(f.proof('settings', { token }, { originEphemeral: true }));
  const updated = await f.service.handleVerified(f.proof('settings_submit', { token: tokenFrom(modal), values: {
    wipeAtLocal: '2026-10-15T14:00', timeZone: 'UTC', notes: '', directConnect: '', autoConnect: false, adaptiveDisplay: true } }));
  assert.ok(buttons(updated).some(button => button.custom_id?.startsWith('nbopen:publish:')));
});

test('unknown sends do not cause another publication or automatic retry', async t => {
  const f = setup(t);
  const { token } = await f.draft();
  f.transport.enqueue('send', { outcome: 'unknown', errorCode: 'TEST_SEND_UNKNOWN' });
  await f.service.handleVerified(f.proof('publish', { token }));
  await f.system.worker.runOnce({ workerId: 'open-wipe-test' });
  f.clock.advance(6000);
  const response = await f.service.handleVerified(f.proof('publish', { token }));
  assert.match(response.content, /未知/); assert.doesNotMatch(response.content, /队列|TEST_SEND_UNKNOWN/);
  await f.system.worker.runOnce({ workerId: 'open-wipe-test' });
  assert.equal(f.transport.calls.filter(call => call.operation === 'send').length, 1);
  assert.equal(f.system.service.repo.get('deliveries', f.records('card')[0].deliveryId).status, 'delivery_unknown');
});

test('unknown edits block settings and stop automatic DNS and message operations until reconciliation', async t => {
  const f = setup(t), { card, ref } = await f.publish();
  f.transport.enqueue('edit', { outcome: 'unknown', errorCode: 'TEST_EDIT_UNKNOWN' });
  await f.system.worker.runOnce({ workerId: 'open-wipe-test' });
  const count = f.transport.calls.length;
  f.clock.advance(6000); await f.system.worker.runOnce({ workerId: 'open-wipe-test' });
  assert.equal(f.transport.calls.length, count); assert.equal(f.dnsCalls(), 0);
  assert.throws(() => f.service.handleVerified(f.proof('settings', { token: card.publicToken }, { originMessageId: ref.messageId })), error('CARD_EDIT_RECONCILIATION_REQUIRED'));
  assert.equal(f.transport.calls.filter(call => call.operation === 'send').length, 1);
});

test('changing the server loads its next wipe date and keeps the existing published card', async t => {
  const f = setup(t), { card, ref } = await f.publish();
  const modal = f.service.handleVerified(f.proof('server', { token: card.publicToken }, { originMessageId: ref.messageId }));
  assert.equal(buttons(modal.data).find(row => row.type === 3).options.find(row => row.value === '19').default, true);
  const token = tokenFrom(modal);
  const preview = await f.service.handleVerified(f.proof('select_server', { token, values: { serverId: '16' } }, { originEphemeral: true }));
  const edited = f.records('draft').find(row => row.token === token);
  assert.equal(edited.settings.wipeAt, '2026-10-29T17:00:00.000Z');
  assert.equal(edited.settings.directConnect, 'client.connect eu-monthly.vitalrust.com:28014');
  assert.ok(buttons(preview).some(row => row.custom_id.startsWith('nbopen:publish:')));
  await f.service.handleVerified(f.proof('publish', { token }, { originEphemeral: true }));
  await f.system.worker.runOnce({ workerId: 'open-wipe-test' });
  assert.equal(f.records('card').length, 1);
  assert.match(f.transport.messages.get(ref.messageId).payload.embeds[0].title, /Monthly/);
  assert.equal(f.transport.calls.filter(call => call.operation === 'send').length, 1);
});

test('a corrected catalog date does not rewrite a published card or its signup roster', async t => {
  const f = setup(t), currentCatalog = f.catalog.listOptions;
  const previousDate = '2026-10-22T16:00:00.000Z';
  f.catalog.listOptions = kind => ({ items: currentCatalog(kind).items.map(row => row.id === '16'
    ? { ...row, serverSnapshot: { ...row.serverSnapshot, nextWipeAt: previousDate } } : row) });
  const { card, ref } = await f.publish({ ...input, serverId: '16' });
  assert.equal(card.settings.wipeAt, previousDate);
  await f.service.handleVerified(f.proof('signup_late', { token: card.publicToken }, { externalId: userId, originMessageId: ref.messageId }));
  f.catalog.listOptions = currentCatalog;
  assert.equal(currentCatalog('servers').items.find(row => row.id === '16').serverSnapshot.nextWipeAt, '2026-10-29T17:00:00.000Z');
  f.clock.advance(6000);
  await f.system.worker.runOnce({ workerId: 'open-wipe-test' });
  const settings = f.service.handleVerified(f.proof('settings', { token: card.publicToken }, { originMessageId: ref.messageId }));
  const token = tokenFrom(settings);
  await f.service.handleVerified(f.proof('select_server', { token, values: { serverId: '16' } }, { originEphemeral: true }));
  assert.equal(f.records('draft').find(row => row.token === token).settings.wipeAt, previousDate);
  assert.equal(f.records('card')[0].settings.wipeAt, previousDate);
  assert.equal(f.records('card').length, 1);
  assert.equal(f.records('signup').length, 1);
  assert.equal(f.records('signup')[0].response, 'late');
  assert.equal(f.transport.calls.filter(call => call.operation === 'send').length, 1);
  assert.ok(f.transport.calls.filter(call => call.operation === 'edit').every(call => call.messageRef.messageId === ref.messageId));
  assert.match(JSON.stringify(f.transport.messages.get(ref.messageId).payload), new RegExp(userId));
});

test('publisher permission is rechecked on form submission and immediately before queued delivery', async t => {
  const f = setup(t), { token } = await f.draft();
  f.config.targets[0].newwipeAllowedUserIds = [];
  await assert.rejects(f.service.handleVerified(f.proof('publish', { token })), error('NEWWIPE_PUBLISHER_DENIED'));
  f.config.targets[0].newwipeAllowedUserIds = [ownerId];
  await f.service.handleVerified(f.proof('publish', { token }));
  f.config.targets[0].enabled = false;
  await f.system.worker.runOnce({ workerId: 'open-wipe-test' });
  assert.equal(f.transport.calls.filter(call => call.operation === 'send').length, 0);
  assert.equal(f.system.service.repo.get('deliveries', f.records('card')[0].deliveryId).status, 'failed');
});

test('renderer uses six private languages, safe profile names and bounded fields', () => {
  const settings = { serverName: 'EU Medium', wipeAt: '2026-10-15T16:00:00Z', timeZone: 'Europe/London', adaptiveDisplay: true, notes: '', directConnect: '' };
  for (const locale of ['en-US', 'zh-CN', 'ru', 'tr', 'th', 'ko', 'de']) {
    const payload = renderOpenWipeCard({ settings, token: 'x'.repeat(43), privateView: true, locale,
      signups: Array.from({ length: 100 }, (_, index) => ({ discordId: String(1177000000000000000n + BigInt(index)), name: '*'.repeat(80), response: 'on_time' })) });
    assert.ok(payload.embeds[0].fields.every(field => field.value.length <= 1024));
    assert.deepEqual(payload.allowed_mentions, { parse: [], roles: [], users: [], replied_user: false });
    assert.equal(payload.components[0].components.length, 4);
    if (locale === 'de') assert.equal(payload.components[0].components[0].label, 'Accepted');
  }
});

test('maximum settings and merged legacy crowded rosters remain deliverable within native embed limits', () => {
  const payload = renderOpenWipeCard({ settings: { serverName: 's'.repeat(180), wipeAt: '2026-10-15T16:00:00Z',
    timeZone: 'Europe/London', adaptiveDisplay: true, notes: 'n'.repeat(2000), directConnect: `client.connect ${'x'.repeat(63)}.${'x'.repeat(63)}.${'x'.repeat(63)}.example:28014`, resolvedIp: '168.100.161.200' },
    token: 'x'.repeat(43), privateView: true, locale: 'ru', signups: Array.from({ length: 100 }, (_, index) => ({
      discordId: String(1177000000000000000n + BigInt(index)), name: '*'.repeat(80), response: ['on_time', 'late_8h', 'late_16h', 'absent'][index % 4] })) });
  assert.doesNotThrow(() => buildNativePrivateResponseRequest({ platform: 'discord', payload, verifiedInteraction: {
    provider: 'discord', externalId: userId, interactionId: '1188000000000000000', channelId,
    privateReplyContext: { applicationId: '1199000000000000000', interactionToken: 'fixture-only-token' } } }));
});
