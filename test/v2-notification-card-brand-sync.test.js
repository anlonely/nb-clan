import test from 'node:test';
import assert from 'node:assert/strict';
import { createFixture } from './support/v2-notifications/fixture.js';
import { renderNotification, listNotificationTemplates } from '../server/v2/notification-platforms/renderer.js';
import { hash } from '../server/v2/notifications/shared.js';

const brand = 'Clan Portal';
const legacyBrand = 'Rust Siege Group';

async function sentFixture(t, platform = 'discord', purpose = 'signup_open', signupMode = 'member_required') {
  let dnsCalls = 0;
  const f = createFixture({ adminRole: true, renderer: renderNotification, templates: listNotificationTemplates(),
    options: { resolveConnectIp: async () => { dnsCalls++; return null; } } });
  t.after(async () => { await f.system.worker.stop(); f.close(); });
  f.catalog.setTarget('discord-1', { signupMode });
  f.scheduling.saveSignup(f.actor('a-m1'), f.wipe.id, 'm1', f.signup(), f.operation('member-signup'));
  const { service, worker } = f.system, repo = service.repo;
  const run = () => worker.runOnce({ workerId: 'brand-fixture', limit: 20 });
  const preview = service.createPreview(f.actor(), f.wipe.id, f.input({ purpose,
    targets: [{ targetId: `${platform}-1`, language: 'en', mentionMode: 'none', roleIds: [] }] }), f.operation('preview')).current;
  const intent = service.createIntent(f.actor(), f.wipe.id, { previewId: preview.id,
    contentHash: preview.contentHash, expectedContentRevision: preview.contentRevision,
    purpose: preview.purpose, purposeInstance: preview.purposeInstance }, f.operation('publish')).current;
  await run(); await run();
  const delivery = repo.get('deliveries', intent.deliveryIds[0]);
  assert.equal(delivery.status, 'sent');
  const ref = repo.all('messageRefs').find(row => row.deliveryId === delivery.id);
  assert.ok(ref);
  const applied = () => {
    const currentRef = repo.get('messageRefs', ref.id);
    return currentRef.lastMessageOperationId ? repo.get('messageOperations', currentRef.lastMessageOperationId) : repo.get('deliveries', delivery.id);
  };
  const age = (name = legacyBrand, { brandedPayload = true } = {}) => {
    const current = applied(), snapshot = { ...current.snapshot };
    delete snapshot.cardBrandName;
    let payload = JSON.parse(JSON.stringify(current.payload).replaceAll(brand, name));
    if (platform === 'kook' && brandedPayload) {
      const cards = JSON.parse(payload.content);
      cards[0].modules.push({ type: 'context', elements: [{ type: 'plain-text', content: name }] });
      payload.content = JSON.stringify(cards);
    }
    const aged = { ...current, snapshot, payload, payloadHash: hash(payload) };
    repo.put(current.id === delivery.id ? 'deliveries' : 'messageOperations', aged);
    repo.put('messageRefs', { ...repo.get('messageRefs', ref.id), payloadHash: aged.payloadHash });
    f.transport.messages.get(ref.messageId).payload = structuredClone(payload);
    return aged;
  };
  const brandOperations = () => repo.all('messageOperations').filter(op => op.reasonCode === 'CARD_BRAND_CHANGED');
  const data = () => ({ wipes: f.scheduling.repo.all('wipes'), archives: f.scheduling.repo.all('archives'),
    signups: f.scheduling.repo.all('signups'), discordSignups: repo.all('discordSignups'),
    intents: repo.all('intents').map(({ revision: _receiptRevision, ...intent }) => intent) });
  return { f, service, repo, run, delivery, ref, applied, age, brandOperations, data, dnsCalls: () => dnsCalls };
}

test('new snapshots carry the current brand without refreshing a newly sent card', async t => {
  for (const platform of ['discord', 'kook']) await t.test(platform, async st => {
    const x = await sentFixture(st, platform);
    assert.equal(x.delivery.snapshot.cardBrandName, brand);
    assert.equal(x.service.refreshCardBrands(), 0);
    await x.run();
    assert.equal(x.brandOperations().length, 0);
    assert.equal(x.f.transport.calls.filter(call => call.operation === 'send').length, 1);
  });
});

test('the existing worker edits a legacy Discord original once and preserves scheduling and signup data', async t => {
  const x = await sentFixture(t);
  x.age();
  const before = x.data(), sends = x.f.transport.calls.filter(call => call.operation === 'send').length;
  assert.equal(before.signups.length, 1);
  await x.run();
  const operations = x.brandOperations();
  assert.equal(operations.length, 1);
  assert.equal(operations[0].messageRefId, x.ref.id);
  assert.equal(operations[0].deliveryId, x.delivery.id);
  assert.equal(operations[0].status, 'succeeded');
  assert.equal(operations[0].snapshot.cardBrandName, brand);
  assert.match(x.f.transport.messages.get(x.ref.messageId).payload.embeds[0].footer.text, /Clan Portal/);
  assert.equal(x.repo.get('messageRefs', x.ref.id).messageId, x.ref.messageId);
  assert.equal(x.repo.get('deliveries', x.delivery.id).status, 'sent');
  assert.deepEqual(x.data(), before);
  await x.run(); await x.run();
  assert.equal(x.brandOperations().length, 1);
  assert.equal(x.f.transport.calls.filter(call => call.operation === 'send').length, sends);
  assert.equal(x.f.transport.messages.size, 1);
});

test('a brand edit preserves committed unlinked Discord attendance and its original profile link', async t => {
  const x = await sentFixture(t, 'discord', 'signup_open', 'discord_only');
  const payload = x.f.transport.messages.get(x.ref.messageId).payload;
  const token = payload.components[0].components.find(button => button.style === 3).custom_id;
  x.service.submitDiscordSignup({ externalId: '1554985841263251538', interactionId: 'brand-discord-signup',
    guildId: x.delivery.target.guildId, channelId: x.delivery.target.channelId,
    actionReference: token, externalDisplayName: 'Constructed Discord attendee' });
  await x.run();
  x.age();
  const before = x.data();
  assert.equal(before.discordSignups.length, 1);
  await x.run(); await x.run();
  assert.equal(x.brandOperations().length, 1);
  assert.equal(x.brandOperations()[0].status, 'succeeded');
  assert.equal(x.brandOperations()[0].snapshot.counts.onTime, 1);
  assert.match(JSON.stringify(x.f.transport.messages.get(x.ref.messageId).payload), /https:\/\/discord.com\/users\/1554985841263251538/);
  assert.deepEqual(x.data(), before);
});

test('legacy branded KOOK signup cards edit the original without DNS while unbranded ones remain untouched', async t => {
  for (const name of ['Rust Siege Group', 'NB Clan', null]) await t.test(String(name), async st => {
    const x = await sentFixture(st, 'kook');
    x.age(name || legacyBrand, { brandedPayload: !!name });
    const before = x.data();
    assert.equal(x.service.refreshCardBrands(), name ? 1 : 0);
    assert.equal(x.dnsCalls(), 0);
    await x.run(); await x.run();
    assert.equal(x.brandOperations().length, name ? 1 : 0);
    if (name) {
      assert.equal(x.brandOperations()[0].status, 'succeeded');
      assert.equal(x.brandOperations()[0].snapshot.cardBrandName, brand);
      assert.equal(JSON.stringify(x.f.transport.messages.get(x.ref.messageId).payload).includes(name), false);
    }
    assert.equal(x.dnsCalls(), 0);
    assert.deepEqual(x.data(), before);
    assert.equal(x.f.transport.messages.size, 1);
    assert.equal(x.f.transport.calls.filter(call => call.operation === 'send').length, 1);
  });
});

test('ended and archived originals receive a single brand edit without changing the frozen history', async t => {
  for (const lifecycle of ['ended', 'archived']) await t.test(lifecycle, async st => {
    const x = await sentFixture(st);
    const transition = (command, values = {}) => {
      const current = x.f.scheduling.repo.get('wipes', x.f.wipe.id);
      x.f.scheduling.transition(x.f.actor(), current.id, command, { expectedRevision: current.revision, ...values }, x.f.operation(command));
    };
    transition('start'); transition('end', { outcome: 'completed' });
    if (lifecycle === 'archived') transition('archive', { reason: 'Local brand fixture', completeness: 'missing' });
    await x.run(); await x.run();
    x.age();
    const before = x.data();
    await x.run(); await x.run();
    assert.equal(x.brandOperations().length, 1);
    assert.equal(x.brandOperations()[0].status, 'succeeded');
    assert.equal(x.brandOperations()[0].snapshot.lifecycle, lifecycle);
    assert.equal(x.repo.get('messageRefs', x.ref.id).messageId, x.ref.messageId);
    assert.deepEqual(x.data(), before);
    if (lifecycle === 'archived') assert.equal(before.archives.length, 1);
  });
});

test('active queued, running and uncertain edits block brand admission without overwriting their operation', async t => {
  for (const status of ['queued', 'running', 'unknown', 'result_unknown']) await t.test(status, async st => {
    const x = await sentFixture(st); x.age();
    const operation = { id: `blocked-${status}`, wipeId: x.delivery.wipeId, deliveryId: x.delivery.id,
      intentId: x.delivery.intentId, messageRefId: x.ref.id, kind: 'edit', status, snapshot: null };
    x.repo.put('messageOperations', operation);
    assert.equal(x.service.refreshCardBrands(), 0);
    assert.deepEqual(x.repo.get('messageOperations', operation.id), operation);
    assert.equal(x.brandOperations().length, 0);
  });
});

test('a final failure for the current brand is not automatically requeued, including a pre-render failure', async t => {
  for (const rendered of [false, true]) await t.test(rendered ? 'rendered failure' : 'pre-render failure', async st => {
    const x = await sentFixture(st); x.age();
    x.repo.put('messageOperations', { id: 'failed-brand', wipeId: x.delivery.wipeId, deliveryId: x.delivery.id,
      intentId: x.delivery.intentId, messageRefId: x.ref.id, kind: 'edit', status: 'failed',
      requestedCardBrandName: rendered ? undefined : brand, snapshot: rendered ? { cardBrandName: brand } : null });
    assert.equal(x.service.refreshCardBrands(), 0);
    assert.equal(x.service.refreshCardBrands(), 0);
    assert.equal(x.brandOperations().length, 0);
  });
  await t.test('real terminal platform failure', async st => {
    const x = await sentFixture(st); x.age();
    x.f.transport.enqueue('edit', { outcome: 'not_updated', errorCode: 'ACCESS_DENIED', retryable: false });
    await x.run();
    assert.equal(x.brandOperations()[0].status, 'failed');
    assert.equal(x.repo.get('messageRefs', x.ref.id).state, 'update_failed');
    await x.run(); await x.run();
    assert.equal(x.brandOperations().length, 1);
  });
});

test('an unknown native edit remains pending reconciliation and a missing original is never recreated', async t => {
  for (const outcome of ['unknown', 'deleted']) await t.test(outcome, async st => {
    const x = await sentFixture(st); x.age();
    if (outcome === 'unknown') x.f.transport.enqueue('edit', { outcome: 'unknown', errorCode: 'PLATFORM_RESULT_UNKNOWN' });
    else x.f.transport.messages.delete(x.ref.messageId);
    const previousEdits = x.f.transport.calls.filter(call => call.operation === 'edit').length;
    await x.run(); await x.run(); await x.run();
    assert.equal(x.brandOperations().length, 1);
    assert.equal(x.brandOperations()[0].status, outcome === 'unknown' ? 'unknown' : 'succeeded');
    assert.equal(x.repo.get('messageRefs', x.ref.id).state, outcome === 'unknown' ? 'update_unknown' : 'deleted');
    assert.equal(x.f.transport.calls.filter(call => call.operation === 'edit').length, previousEdits + 1);
    assert.equal(x.f.transport.calls.filter(call => call.operation === 'send').length, 1);
    assert.equal(x.f.transport.messages.size, outcome === 'unknown' ? 1 : 0);
  });
});

test('a valid applied pin takes precedence over an unpinned same-timestamp or future edit on this or another card', async t => {
  const x = await sentFixture(t); x.age();
  await x.run();
  const pinned = x.applied();
  assert.equal(pinned.snapshot.cardBrandName, brand);
  for (const [id, changes] of [
    ['unpinned-same-time', {}], ['unpinned-future', { updatedAt: '2099-01-01T00:00:00.000Z' }],
    ['another-card', { messageRefId: 'other-ref', updatedAt: '2099-01-01T00:00:00.000Z' }],
    ['another-delivery', { deliveryId: 'other-delivery', updatedAt: '2099-01-01T00:00:00.000Z' }]
  ]) x.repo.put('messageOperations', { ...pinned, id, reasonCode: 'TEST_UNPINNED',
    snapshot: { ...pinned.snapshot, cardBrandName: legacyBrand }, ...changes });
  assert.equal(x.service.refreshCardBrands(), 0);
  assert.equal(x.brandOperations().length, 1);
});

test('missing, failed or foreign edit pins never fall back to the old first-send payload', async t => {
  for (const mode of ['missing', 'failed', 'other-delivery', 'other-reference']) await t.test(mode, async st => {
    const x = await sentFixture(st); x.age();
    const op = { id: 'invalid-pin', wipeId: x.delivery.wipeId, deliveryId: x.delivery.id,
      intentId: x.delivery.intentId, messageRefId: x.ref.id, kind: 'edit', status: 'succeeded',
      snapshot: { cardBrandName: legacyBrand }, payload: x.applied().payload };
    if (mode === 'failed') op.status = 'failed';
    if (mode === 'other-delivery') op.deliveryId = 'other-delivery';
    if (mode === 'other-reference') op.messageRefId = 'other-reference';
    if (mode !== 'missing') x.repo.put('messageOperations', op);
    x.repo.put('messageRefs', { ...x.repo.get('messageRefs', x.ref.id), lastMessageOperationId: op.id });
    assert.equal(x.service.refreshCardBrands(), 0);
    assert.equal(x.brandOperations().length, 0);
  });
});

test('brand refresh stays scoped to current enabled exact targets, active original references and signup intents', async t => {
  for (const [name, change] of [
    ['disabled target', x => x.f.catalog.setTarget('discord-1', { enabled: false })],
    ['disabled signup configuration', x => x.f.catalog.setTarget('discord-1', { signupConfigurationEnabled: false })],
    ['different guild', x => x.f.catalog.setTarget('discord-1', { guildId: 'other-guild' })],
    ['different channel', x => x.f.catalog.setTarget('discord-1', { channelId: 'other-channel' })],
    ['different platform', x => x.f.catalog.setTarget('discord-1', { platform: 'kook' })],
    ['foreign reference guild', x => x.repo.put('messageRefs', { ...x.ref, guildId: 'other-guild' })],
    ['foreign reference channel', x => x.repo.put('messageRefs', { ...x.ref, channelId: 'other-channel' })],
    ['foreign reference target', x => x.repo.put('messageRefs', { ...x.ref, targetId: 'other-target' })],
    ['foreign reference intent', x => x.repo.put('messageRefs', { ...x.ref, intentId: 'other-intent' })],
    ['deleted reference', x => x.repo.put('messageRefs', { ...x.ref, state: 'deleted' })],
    ['delivery is not sent', x => x.repo.put('deliveries', { ...x.delivery, status: 'delivery_unknown' })],
    ['business resource', x => x.repo.put('deliveries', { ...x.delivery, resource: { kind: 'platformCard', id: 'other-card' }, wipeId: null })],
    ['intent belongs to another wipe', x => x.repo.put('intents', { ...x.repo.get('intents', x.delivery.intentId), wipeId: 'other-wipe' })],
    ['intent is a business resource', x => x.repo.put('intents', { ...x.repo.get('intents', x.delivery.intentId), resource: { kind: 'platformCard', id: 'other-card' } })],
    ['creator lost current authority', x => {
      const actor = x.f.identity.repo.get('accounts', 'admin');
      x.f.identity.repo.put('accounts', { ...actor, status: 'disabled' });
    }],
  ]) await t.test(name, async st => {
    const x = await sentFixture(st); x.age(); change(x);
    assert.equal(x.service.refreshCardBrands(), 0);
    assert.equal(x.brandOperations().length, 0);
    assert.equal(x.f.transport.calls.filter(call => call.operation === 'send').length, 1);
  });
  await t.test('non-signup purpose', async st => {
    const x = await sentFixture(st, 'discord', 'reminder'); x.age();
    assert.equal(x.service.refreshCardBrands(), 0);
  });
});

test('each confirmed active original reference is queued explicitly; foreign references and operations stay separate', async t => {
  const x = await sentFixture(t); x.age();
  const original = x.repo.get('deliveries', x.delivery.id), snapshot = { ...original.snapshot };
  delete snapshot.cardBrandName;
  x.repo.put('deliveries', { ...original, snapshot });
  const second = { ...x.ref, id: 'second-original', messageId: 'second-native-message', lastMessageOperationId: null };
  x.repo.put('messageRefs', second);
  x.repo.put('messageRefs', { ...x.ref, id: 'foreign-reference', guildId: 'other-guild' });
  x.repo.put('messageOperations', { id: 'other-delivery-pending', wipeId: x.delivery.wipeId,
    deliveryId: 'other-delivery', messageRefId: 'other-ref', kind: 'edit', status: 'unknown' });
  assert.equal(x.service.refreshCardBrands(), 2);
  assert.deepEqual(x.brandOperations().map(op => op.messageRefId).sort(), [x.ref.id, second.id].sort());
  assert.equal(x.service.refreshCardBrands(), 0);
  assert.equal(x.brandOperations().length, 2);
});
