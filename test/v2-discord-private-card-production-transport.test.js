import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { createFixture } from './support/v2-notifications/fixture.js';
import { nativeEnvelopes } from './support/v2-notification-platforms/native-envelopes.mjs';
import { createProductionNotificationTransport } from '../server/v2/production/notification-transport.js';
import { buildNativePrivateResponseRequest } from '../server/v2/notification-platforms/platforms.js';
import { createNotificationCallbackHandler } from '../server/v2/notification-platforms/callbacks.js';
import { renderNotification } from '../server/v2/notification-platforms/renderer.js';
import { installNotificationBusinessSchema, installNotificationPlatformCardSchema } from '../server/v2/notifications/index.js';
import { installPlatformAdminSchema } from '../server/v2/platform-admin/repository.js';
import { PlatformAdminService } from '../server/v2/platform-admin/service.js';
import { createPlatformCards } from '../server/v2/platform-admin/cards.js';
import { welcomeGuideTargetId } from '../server/v2/platform-admin/welcome-guide-card.js';

const locales = ['zh-CN', 'en-US', 'ru', 'tr', 'th', 'ko'];
const mentions = { parse: [], roles: [], users: [], replied_user: false };
const database = f => ({
  records: f.db.prepare('SELECT collection,id,payload_json FROM json_records ORDER BY collection,id').all(),
  scalars: f.db.prepare('SELECT * FROM json_scalars ORDER BY key').all(),
  cards: f.db.prepare('SELECT kind,id,payload FROM platform_admin_records ORDER BY kind,id').all()
});

async function signup(t) {
  const f = createFixture({ adminRole: true, renderer: renderNotification,
    wipeInput: { title: 'Vital EU', description: '', serverSnapshot: { name: 'Vital EU',
      connectCommand: 'client.connect eu-medium.vitalrust.com:28014' } },
    options: { resolveConnectIp: async () => '168.100.161.200' } });
  t.after(() => f.close()); installPlatformAdminSchema(f.db);
  f.catalog.setTarget('discord-1', { signupMode: 'discord_only' });
  const service = f.system.service;
  const preview = service.createPreview(f.actor(), f.wipe.id, f.input(), f.operation('preview')).current;
  const intent = service.createIntent(f.actor(), f.wipe.id, { previewId: preview.id,
    contentHash: preview.contentHash, expectedContentRevision: preview.contentRevision,
    purpose: preview.purpose, purposeInstance: preview.purposeInstance }, f.operation('publish')).current;
  await f.system.worker.runOnce({ workerId: 'private-native-view' });
  await f.system.worker.runOnce({ workerId: 'private-native-view' });
  const ref = service.repo.all('messageRefs').find(r => r.deliveryId === intent.deliveryIds[0]);
  return { f, ref, view: proof => service.localizedDiscordView(proof) };
}

async function welcome(t) {
  const f = createFixture({ adminRole: true }); t.after(() => f.close());
  installPlatformAdminSchema(f.db); installNotificationBusinessSchema(f.db); installNotificationPlatformCardSchema(f.db);
  const owner = new PlatformAdminService({ identity: f.identity, now: () => f.clock.now });
  const base = { id: 'welcome-base', guildId: '1554983512321425488', channelId: '200000000000000001',
    welcomeGuideChannelId: '200000000000000005', electricianChannelId: '200000000000000004',
    serverConnectChannelId: '200000000000000003', enabled: true, enabledCommandIds: ['welcome_guide_card'] };
  owner.save(f.actor(), 'discord', { expectedRevision: 0, config: { enabled: true, targets: [base],
    commands: [{ id: 'welcome_guide_card', name: 'Welcome', type: 'persistent_card', enabled: true }] } }, { operationId: randomUUID() });
  const targetId = welcomeGuideTargetId(base.id, 'discord');
  f.catalog.targets.set(targetId, { ...f.catalog.getTarget('discord-1'), id: targetId,
    guildId: base.guildId, channelId: base.welcomeGuideChannelId });
  const cards = createPlatformCards({ identity: f.identity, scheduling: f.scheduling, notifications: f.system.service,
    platformService: owner, runStoreWriteTask: async fn => fn(), now: () => f.clock.now });
  owner.adapters.cards = cards;
  const input = { expectedRevision: 1, cardType: 'welcome_guide', targetId, language: 'en' };
  const preview = (await owner.execute(f.actor(), 'discord', 'card_preview', input, { operationId: randomUUID() })).result.preview;
  const published = await owner.execute(f.actor(), 'discord', 'card_publish', { ...input,
    previewId: preview.id, contentHash: preview.contentHash }, { operationId: randomUUID() });
  await f.system.worker.runOnce({ workerId: 'private-native-guide' });
  const ref = f.system.service.repo.all('messageRefs').find(r => r.deliveryId === published.result.reference);
  return { f, ref, view: proof => cards.localizedView(proof) };
}

// Exercise an actual incoming signed HTTP POST, the callback's ephemeral ACK,
// and the production REST projector/client. Only the native fetch is mocked.
for (const [name, setup] of [['signup', signup], ['welcome', welcome]]) {
  test(`production ${name} private card views accept native embeds in all six client languages`, async t => {
    const { f, ref, view } = await setup(t);
    assert.ok(ref?.messageId);
    const original = f.transport.messages.get(ref.messageId).payload;
    const button = original.components.flatMap(row => row.components).find(item => item.custom_id?.startsWith('nblang:'));
    assert.ok(button);
    const requests = []; let credentialReads = 0;
    const transport = createProductionNotificationTransport({
      readCredentials: () => { credentialReads++; return { botToken: 'constructed-test-token' }; },
      fetchImpl: async (url, options) => {
        const pathname = new URL(url).pathname;
        const isPrivate = /^\/api\/v10\/webhooks\/[^/]+\/[^/]+\/messages\/@original$/.test(pathname);
        assert.equal(new URL(url).origin, 'https://discord.com');
        assert.equal(isPrivate || pathname === `/api/v10/channels/${ref.channelId}/messages`, true);
        requests.push({ kind: isPrivate ? 'private' : 'public', method: options.method,
          body: JSON.parse(options.body), authorized: Boolean(options.headers.authorization) });
        return new Response(JSON.stringify({ id: isPrivate ? 'private-reply' : ref.messageId,
          channel_id: ref.channelId, guild_id: ref.guildId, ...(isPrivate ? { flags: 64 } : {}) }), { status: 200 });
      }
    });
    await transport.request({ platform: 'discord', operation: 'send', payload: original,
      target: { id: 'constructed-target', platform: 'discord', guildId: ref.guildId, channelId: ref.channelId,
        runtimeMode: 'production', enabled: true, transportKey: 'production:constructed' },
      context: { timeoutMs: 1000, signal: new AbortController().signal } });
    assert.equal(requests[0].method, 'POST'); assert.deepEqual(requests[0].body, original);
    const before = database(f), publicCalls = f.transport.calls.length;
    const native = nativeEnvelopes({ now: () => f.clock.now }), acks = [], completed = [];
    const handler = createNotificationCallbackHandler({ platform: 'discord', identity: f.identity,
      scheduling: f.scheduling, verify: native.verifiers.discord,
      resolveActionReference: () => assert.fail('language view must not resolve a signup action'),
      publicOrigin: 'https://nb.example', transport, runtimeMode: 'production', now: () => f.clock.now,
      viewDiscordCard: proof => { assert.deepEqual(acks.at(-1), { type: 5, data: { flags: 64 } }); return view(proof); } });
    const server = createServer((req, res) => {
      assert.equal(req.method, 'POST'); const chunks = [];
      req.on('data', chunk => chunks.push(chunk));
      req.on('end', () => {
        const work = handler({ rawBody: Buffer.concat(chunks), headers: req.headers }, { ack: payload => {
          acks.push(payload); res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(payload));
        } });
        completed.push(work); work.catch(() => { if (!res.headersSent) { res.writeHead(500); res.end(); } });
      });
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
    const titles = new Set();
    for (const locale of locales) {
      const event = native.discord(button.custom_id, { locale, guild_locale: locale === 'zh-CN' ? 'en-US' : 'zh-CN',
        guild_id: ref.guildId, channel_id: ref.channelId, message: { id: ref.messageId }, externalId: 'unbound-visitor' });
      const incoming = await fetch(`http://127.0.0.1:${server.address().port}/discord`, {
        method: 'POST', headers: event.headers, body: event.rawBody });
      assert.equal(incoming.status, 200); assert.deepEqual(await incoming.json(), { type: 5, data: { flags: 64 } });
      await completed.at(-1);
      const request = requests.at(-1);
      assert.equal(request.kind, 'private'); assert.equal(request.method, 'PATCH'); assert.equal(request.authorized, false);
      assert.ok(request.body.embeds.length); assert.deepEqual(request.body.allowed_mentions, mentions);
      assert.equal(Object.hasOwn(request.body, 'flags'), false);
      assert.equal(request.body.components.flatMap(row => row.components).some(item => item.custom_id?.startsWith('nblang:')), false);
      titles.add(request.body.embeds[0].description);
    }
    assert.equal(titles.size, 6); assert.equal(credentialReads, 1);
    assert.equal(requests.filter(request => request.kind === 'public').length, 1);
    assert.equal(requests.filter(request => request.kind === 'private').length, 6);
    assert.equal(f.transport.calls.length, publicCalls); assert.deepEqual(database(f), before);
    assert.deepEqual(f.transport.messages.get(ref.messageId).payload, original);
  });
}

test('private native embeds enforce field and total bounds and reject files, unknown keys and mentions before production fetch', async () => {
  const verifiedInteraction = { provider: 'discord', externalId: 'visitor', interactionId: 'interaction', channelId: 'channel',
    privateReplyContext: { applicationId: 'application', interactionToken: 'constructed-private-token' } };
  const base = { content: '', components: [], allowed_mentions: mentions };
  const wire = payload => buildNativePrivateResponseRequest({ platform: 'discord', verifiedInteraction, payload });
  const boundary = { ...base, embeds: [{ title: 't'.repeat(256), description: 'd'.repeat(4096),
    fields: [{ name: 'n'.repeat(256), value: 'v'.repeat(1024), inline: true }],
    footer: { text: 'f'.repeat(368) }, color: 0xffffff, timestamp: '2026-10-07T00:00:00.000Z' }] };
  assert.deepEqual(wire(boundary).body, boundary); // Exactly 6000 embed characters.
  assert.deepEqual(wire({ ...base, embeds: Array.from({ length: 10 }, () => ({ title: 't' })) }).body.embeds.length, 10);
  assert.deepEqual(wire(base).body, base); // Existing text-only private responses remain valid.
  const invalid = [
    { embeds: [{} , ...Array.from({ length: 10 }, () => ({ title: 't' }))] },
    { embeds: [{ title: 't'.repeat(257) }] }, { embeds: [{ description: 'd'.repeat(4097) }] },
    { embeds: [{ fields: Array.from({ length: 26 }, () => ({ name: 'n', value: 'v' })) }] },
    { embeds: [{ fields: [{ name: 'n'.repeat(257), value: 'v' }] }] },
    { embeds: [{ fields: [{ name: 'n', value: 'v'.repeat(1025) }] }] },
    { embeds: [{ fields: [{ name: 'n', value: 'v', inline: 'yes' }] }] },
    { embeds: [{ footer: { text: 'f'.repeat(2049) } }] },
    { embeds: [{ description: 'd'.repeat(3001) }, { description: 'd'.repeat(3000) }] },
    { embeds: [{ color: 0x1000000 }] }, { embeds: [{ timestamp: 'not-a-date' }] },
    { embeds: [{ title: 'control\u0000' }] }, { embeds: [{ title: 42 }] }, { embeds: null },
    { embeds: [{ fields: [{ name: 'n', value: 'v', file: 'secret' }] }] },
    { embeds: [{ footer: { text: 'footer', icon_url: 'https://example.com/image.png' } }] },
    { embeds: [{ image: { url: 'attachment://file.png' } }] }, { embeds: [{ unknown: true }] },
    { attachments: [] }, { files: [] }, { flags: 64 },
    { allowed_mentions: { ...mentions, parse: ['everyone'] } },
    { allowed_mentions: { ...mentions, roles: ['role'] } }, { allowed_mentions: { ...mentions, users: ['user'] } },
    { allowed_mentions: { ...mentions, replied_user: true } }, { allowed_mentions: { ...mentions, unknown: true } }
  ];
  let calls = 0;
  const transport = createProductionNotificationTransport({ readCredentials: () => assert.fail('private webhook uses no bot token'),
    fetchImpl: async () => { calls++; return new Response(JSON.stringify({ id: 'reply', channel_id: 'channel' })); } });
  await transport.respondPrivate({ platform: 'discord', verifiedInteraction, payload: boundary }); assert.equal(calls, 1);
  for (const patch of invalid) {
    const payload = { ...base, ...patch };
    assert.throws(() => wire(payload), error => error.errorCode === 'PRIVATE_RESPONSE_INVALID');
    await assert.rejects(transport.respondPrivate({ platform: 'discord', verifiedInteraction, payload }),
      error => error.errorCode === 'PRIVATE_RESPONSE_INVALID');
  }
  assert.equal(calls, 1);
});
