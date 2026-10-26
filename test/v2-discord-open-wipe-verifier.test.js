import assert from 'node:assert/strict';
import test from 'node:test';
import { generateKeyPairSync, sign } from 'node:crypto';
import { createDiscordVerifier } from '../server/v2/notification-platforms/verifiers.js';
import { createNotificationCallbackHandler } from '../server/v2/notification-platforms/callbacks.js';
import { buildNativePrivateResponseRequest } from '../server/v2/notification-platforms/platforms.js';
import { assertOpenWipeProof, isOpenWipeProof } from '../server/v2/discord-open-wipe/proof.js';
import { createServerModal, createServerPickerPayload, createSettingsModal, localizeError, text } from '../server/v2/discord-open-wipe/interaction-ui.js';
import { openWipeCustomId } from '../server/v2/discord-open-wipe/interaction-input.js';

const token = 'b'.repeat(43), now = Date.parse('2026-10-14T10:00:00.000Z');
const guildId = '1153571748147634236', channelId = '1153571748147634237', userId = '1153571748147634238';
const applicationId = '1153571748147634239', messageId = '1153571748147634240', roleId = '1153571748147634241';
const servers = [{ id: 'vital-medium', label: 'Vital EU 2x Medium' }];
const settings = { wipeAtLocal: '2026-10-15T18:00', timeZone: 'Europe/Amsterdam' };

function fixture() {
  const keys = generateKeyPairSync('ed25519');
  const publicKey = keys.publicKey.export({ format: 'der', type: 'spki' }).subarray(-32).toString('hex');
  const verify = createDiscordVerifier({ publicKey, applicationId, now: () => now });
  let sequence = 0n;
  const event = (data = { name: 'newwipe', type: 1 }, type = 2, patch = {}) => ({
    id: String(1153571748147634300n + sequence++), application_id: applicationId, type, guild_id: guildId, channel_id: channelId,
    token: 'test-private-interaction-token', member: { user: { id: userId, username: 'Tester' }, nick: 'AN', roles: [roleId], permissions: '32' },
    locale: 'en-US', guild_locale: 'zh-CN', data, ...(type === 3 ? { message: { id: messageId, flags: 0 } } : {}), ...patch,
  });
  const envelope = body => {
    const rawBody = Buffer.from(JSON.stringify(body)), timestamp = String(now / 1000);
    return { rawBody, headers: { 'x-signature-timestamp': timestamp,
      'x-signature-ed25519': sign(null, Buffer.concat([Buffer.from(timestamp), rawBody]), keys.privateKey).toString('hex') } };
  };
  const button = (action, patch = {}) => event({ component_type: 2, custom_id: openWipeCustomId(action, token) }, 3, patch);
  const select = (values = ['vital-medium'], patch = {}) => event({ component_type: 3,
    custom_id: openWipeCustomId('select_server', token), values }, 3, { message: { id: messageId, flags: 32768 | 64 }, ...patch });
  const modal = (patch = {}) => {
    const ui = createServerModal({ token, servers, defaults: { serverId: 'vital-medium' } });
    const components = ui.data.components.map((row, i) => ({ type: 18, id: i * 2 + 1, component: {
      type: row.component.type, custom_id: row.component.custom_id, id: i * 2 + 2,
      ...(row.component.type === 4 ? { value: row.component.value } : { values: row.component.options.filter(o => o.default).map(o => o.value) }),
    } }));
    return event({ custom_id: ui.data.custom_id, components }, 5, patch);
  };
  return { verify, event, envelope, button, select, modal };
}

function callback(f, handleOpenWipe, override = {}) {
  const acks = [], replies = [], wireBodies = [], events = [];
  const noIdentity = new Proxy({}, { get() { assert.fail('Open sign-up must not resolve a website account'); } });
  const transport = { runtimeMode: 'isolated', request() { assert.fail('Callback must not send a public card directly'); },
    async respondPrivate(args) {
      events.push('reply');
      const wire = buildNativePrivateResponseRequest(args);
      assert.equal(wire.method, 'PATCH'); assert.match(wire.path, /\/messages\/@original$/);
      replies.push(args); wireBodies.push(wire.body);
    } };
  const handler = createNotificationCallbackHandler({ platform: 'discord', identity: noIdentity, scheduling: noIdentity,
    verify: f.verify, publicOrigin: 'http://127.0.0.1:4316', resolveActionReference() { assert.fail('Unrelated signup references must not be read'); },
    transport, handleOpenWipe: async proof => { events.push('handle'); assertOpenWipeProof(proof); return handleOpenWipe(proof); },
    now: () => now, ...override });
  return { acks, replies, wireBodies, events, run: native => handler(f.envelope(native), { ack(payload) { events.push('ack'); acks.push(payload); } }) };
}

test('real signed native interactions carry immutable Discord role, permission, locale and exact message facts', () => {
  const f = fixture();
  const native = f.button('settings', { locale: 'ko', guild_locale: 'ru', message: { id: messageId, flags: 64 },
    member: { user: { id: userId, username: 'Tester' }, nick: 'AN\x00', roles: [roleId, roleId], permissions: '32' },
    discordRoleIds: ['1153571748147634999'], discordPermissions: '8', originMessageId: '1153571748147634998' });
  const proof = f.verify(f.envelope(native));
  assert.equal(isOpenWipeProof(proof), true); assert.equal(assertOpenWipeProof(proof), proof);
  assert.equal(proof.externalId, userId); assert.equal(proof.externalDisplayName, 'AN');
  assert.deepEqual(proof.discordRoleIds, [roleId]); assert.equal(proof.discordPermissions, '32');
  assert.equal(proof.locale, 'ko'); assert.equal(proof.originMessageId, messageId); assert.equal(proof.originEphemeral, true);
  assert.ok(Object.isFrozen(proof) && Object.isFrozen(proof.discordRoleIds) && Object.isFrozen(proof.payload));
  for (const clone of [{ ...proof }, structuredClone(proof)]) assert.throws(() => assertOpenWipeProof(clone), error => error.errorCode === 'PLATFORM_AUTH_INVALID');
  const publicProof = f.verify(f.envelope(f.button('language'))); assert.equal(publicProof.originEphemeral, false);
  const slashProof = f.verify(f.envelope(f.event())); assert.equal(slashProof.originMessageId, null);
});

test('signature tampering, replay mutation, wrong application and forged authority fields are rejected', () => {
  const f = fixture(), native = f.event(), wire = f.envelope(native);
  const changed = { ...native, member: { ...native.member, permissions: '8' } };
  assert.throws(() => f.verify({ ...wire, rawBody: Buffer.from(JSON.stringify(changed)) }), error => error.errorCode === 'PLATFORM_AUTH_INVALID');
  f.verify(wire); f.verify(wire);
  assert.throws(() => f.verify(f.envelope(changed)), error => error.errorCode === 'PLATFORM_REPLAY_CONFLICT');
  assert.throws(() => f.verify(f.envelope(f.event(undefined, 2, { application_id: '1153571748147634999' }))), error => error.errorCode === 'PLATFORM_AUTH_INVALID');
  for (const patch of [
    { member: { user: { id: userId }, permissions: '32' } },
    { member: { user: { id: userId }, roles: [123], permissions: '32' } },
    { member: { user: { id: userId }, roles: [roleId], permissions: 32 } },
    { member: { user: { id: userId }, roles: [roleId], permissions: '18446744073709551616' } },
    { member: { user: { id: userId, bot: true }, roles: [roleId], permissions: '32' } },
    { guild_id: null },
    { message: { id: 'wrong-message', flags: 0 } },
  ]) assert.throws(() => f.verify(f.envelope(f.button('settings', patch))), error => error.errorCode === 'PLATFORM_AUTH_INVALID');
});

test('malformed modal values cannot inject website identity or authority', () => {
  const f = fixture(), native = f.modal();
  const proof = f.verify(f.envelope(native));
  assert.equal(proof.payload.action, 'create_submit'); assert.equal(proof.payload.values.serverId, 'vital-medium');
  for (const name of ['actor', 'accountId', 'roles', 'permissions', '__proto__']) {
    const bad = f.modal(); bad.data.components[0].component.custom_id = name;
    assert.throws(() => f.verify(f.envelope(bad)), error => error.errorCode === 'PLATFORM_PAYLOAD_INVALID');
  }
});

test('signed server selections retain their exact selected value and ephemeral origin', () => {
  const f = fixture(), native = f.select(['19'], { locale: 'th', originEphemeral: false,
    payload: { values: { serverId: 'injected' } }, serverId: 'injected' });
  const wire = f.envelope(native), proof = f.verify(wire);
  assert.deepEqual(proof.payload, { kind: 'open_wipe', action: 'select_server', token, values: { serverId: '19' } });
  assert.equal(proof.locale, 'th'); assert.equal(proof.originMessageId, messageId); assert.equal(proof.originEphemeral, true);
  assert.ok(Object.isFrozen(proof.payload.values));
  const changed = { ...native, data: { ...native.data, values: ['vital-medium'] } };
  assert.throws(() => f.verify({ ...wire, rawBody: Buffer.from(JSON.stringify(changed)) }), error => error.errorCode === 'PLATFORM_AUTH_INVALID');
  assert.throws(() => f.verify(f.envelope(changed)), error => error.errorCode === 'PLATFORM_REPLAY_CONFLICT');
  const publicProof = f.verify(f.envelope(f.select(['vital-medium'], { message: { id: messageId, flags: 0 }, originEphemeral: true })));
  assert.equal(publicProof.originEphemeral, false);
});

test('signed server selections reject malformed values and incorrect component shapes before ACK', async () => {
  const f = fixture();
  for (const values of [null, [], ['19', '20'], [19], [null], [{}], [''], [' '], ['19\n'], ['x'.repeat(101)], ['服务器'], ['a/b']]) {
    const c = callback(f, () => assert.fail('Invalid selection must not reach the handler'));
    await assert.rejects(c.run(f.select(values)), error => error.errorCode === 'PLATFORM_PAYLOAD_INVALID');
    assert.equal(c.acks.length, 0); assert.equal(c.replies.length, 0);
  }
  for (const change of [
    native => { delete native.data.values; },
    native => { native.data.component_type = 2; },
    native => { native.type = 5; },
    native => { native.data.custom_id = openWipeCustomId('settings', token); native.data.component_type = 2; },
  ]) {
    const native = f.select(); change(native);
    assert.throws(() => f.verify(f.envelope(native)), error => error.errorCode === 'PLATFORM_PAYLOAD_INVALID');
  }
});

test('open, settings and server actions return a private Components V2 panel as the initial ACK without legacy fields', async () => {
  for (const action of ['open', 'settings', 'server']) for (const flags of [32768, 32768 | 64]) {
    const f = fixture();
    const panel = createServerPickerPayload({ token, servers, locale: 'ru' });
    assert.equal(panel.flags, 32768);
    const c = callback(f, proof => { assert.equal(proof.locale, 'ru'); return { type: 4, data: { ...panel, flags } }; });
    await c.run(action === 'open' ? f.event(undefined, 2, { locale: 'ru' }) : f.button(action, { locale: 'ru' }));
    assert.deepEqual(c.acks, [{ type: 4, data: { flags: 32768 | 64,
      allowed_mentions: panel.allowed_mentions, components: panel.components } }]);
    assert.equal(Object.hasOwn(c.acks[0].data, 'content'), false); assert.equal(Object.hasOwn(c.acks[0].data, 'embeds'), false);
    assert.deepEqual(c.events, ['handle', 'ack']); assert.equal(c.replies.length, 0);
  }
});

test('edit details opens the settings modal as the initial ACK without defer or OAuth', async () => {
  const f = fixture(), modal = createSettingsModal({ token, settings, locale: 'ru' });
  const c = callback(f, proof => { assert.equal(proof.payload.action, 'edit_details'); assert.equal(proof.locale, 'ru'); return modal; });
  await c.run(f.button('edit_details', { locale: 'ru', message: { id: messageId, flags: 64 } }));
  assert.deepEqual(c.acks, [modal]); assert.deepEqual(c.events, ['handle', 'ack']); assert.equal(c.replies.length, 0);
});

test('selecting a server defers an update only for the signed private setup panel', async () => {
  const f = fixture(); let release, handledProof;
  const barrier = new Promise(resolve => { release = resolve; });
  const panel = createServerPickerPayload({ token, servers, settings: { serverId: 'vital-medium', ...settings }, locale: 'zh-CN' });
  const c = callback(f, async proof => { handledProof = proof; await barrier; return panel; });
  const pending = c.run(f.select(['vital-medium'], { locale: 'zh-CN' }));
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(c.acks, [{ type: 6 }]); assert.deepEqual(c.events, ['ack', 'handle']); assert.equal(c.replies.length, 0);
  release(); await pending;
  assert.deepEqual(c.events, ['ack', 'handle', 'reply']); assert.equal(c.replies[0].verifiedInteraction, handledProof);
  assert.equal(handledProof.originMessageId, messageId); assert.equal(handledProof.originEphemeral, true);
  assert.deepEqual(c.replies[0].payload.components, panel.components); assert.deepEqual(c.replies[0].payload.embeds, panel.embeds);
  assert.equal(c.replies[0].payload.flags, 32768); assert.equal(c.acks.length, 1);
  assert.deepEqual(c.wireBodies, [{ flags: 32768, components: panel.components, allowed_mentions: panel.allowed_mentions }]);
  assert.equal(Object.hasOwn(c.wireBodies[0], 'content'), false); assert.equal(Object.hasOwn(c.wireBodies[0], 'embeds'), false);
});

test('private server selection failures update the V2 panel with a localized text display', async () => {
  for (const locale of ['zh-TW', 'en-US', 'ru', 'tr', 'th', 'ko', 'de']) {
    const f = fixture(), c = callback(f, () => {
      throw Object.assign(new Error('private internal error'), { errorCode: 'OPEN_WIPE_SERVER_INVALID' });
    });
    await c.run(f.select(['vital-medium'], { locale }));
    assert.deepEqual(c.acks, [{ type: 6 }]); assert.deepEqual(c.events, ['ack', 'handle', 'reply']);
    assert.equal(c.replies[0].payload.content, ''); assert.deepEqual(c.replies[0].payload.embeds, []);
    assert.deepEqual(c.wireBodies, [{ flags: 32768,
      components: [{ type: 10, content: localizeError(locale, 'OPEN_WIPE_SERVER_INVALID') }],
      allowed_mentions: { parse: [], roles: [], users: [], replied_user: false } }]);
    assert.equal(Object.hasOwn(c.wireBodies[0], 'content'), false); assert.equal(Object.hasOwn(c.wireBodies[0], 'embeds'), false);
  }
});

test('private response transport permits only the V2 flag and refuses legacy content or injected flags', () => {
  const f = fixture(), verifiedInteraction = f.verify(f.envelope(f.select()));
  const payload = createServerPickerPayload({ token, servers, locale: 'en-US' });
  const build = value => buildNativePrivateResponseRequest({ platform: 'discord', verifiedInteraction, payload: value });
  const original = structuredClone(payload), wire = build(payload);
  assert.deepEqual(payload, original);
  assert.equal(wire.body.flags, 32768); assert.equal(Object.hasOwn(wire.body, 'content'), false); assert.equal(Object.hasOwn(wire.body, 'embeds'), false);
  for (const flags of [0, 4, 64, 4096, 32768 | 64, 32768 | 4, null, '32768'])
    assert.throws(() => build({ ...payload, flags }), error => error.errorCode === 'PRIVATE_RESPONSE_INVALID');
  for (const patch of [{ content: 'Visible legacy content' }, { embeds: [{ title: 'Visible legacy embed' }] },
    { content: 'Legacy text', embeds: [{ title: 'Legacy embed' }] }, { username: 'Injected author' }, { ephemeral: true }])
    assert.throws(() => build({ ...payload, ...patch }), error => error.errorCode === 'PRIVATE_RESPONSE_INVALID');
});

test('a server selection from a public origin receives a private error without an update ACK', async () => {
  const f = fixture();
  const c = callback(f, proof => {
    assert.equal(proof.originEphemeral, false);
    throw Object.assign(new Error('private internal error'), { errorCode: 'MESSAGE_REFERENCE_REQUIRED' });
  });
  await c.run(f.select(['vital-medium'], { locale: 'ko', message: { id: messageId, flags: 0 }, originEphemeral: true }));
  assert.deepEqual(c.acks, [{ type: 5, data: { flags: 64 } }]); assert.deepEqual(c.events, ['ack', 'handle', 'reply']);
  assert.equal(c.replies[0].payload.content, localizeError('ko', 'MESSAGE_REFERENCE_REQUIRED'));
  assert.deepEqual(c.replies[0].payload.components, []); assert.deepEqual(c.replies[0].payload.embeds, []);
  assert.equal(c.replies[0].verifiedInteraction.originEphemeral, false);
});

test('modal submit and publish defer privately before work and retain the original verified object for transport', async () => {
  for (const action of ['create_submit', 'publish', 'signup_on_time', 'language']) {
    const f = fixture(); let release, handledProof;
    const barrier = new Promise(resolve => { release = resolve; });
    const c = callback(f, async proof => { handledProof = proof; await barrier; return { content: text(proof.locale, 'queued') }; });
    const pending = c.run(action === 'create_submit' ? f.modal() : f.button(action));
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(c.acks, [{ type: 5, data: { flags: 64 } }]); assert.deepEqual(c.events, ['ack', 'handle']); assert.equal(c.replies.length, 0);
    release(); await pending;
    assert.deepEqual(c.events, ['ack', 'handle', 'reply']); assert.equal(c.replies[0].verifiedInteraction, handledProof);
    assert.deepEqual(c.replies[0].payload.allowed_mentions, { parse: [], roles: [], users: [], replied_user: false });
    assert.equal(c.replies[0].payload.flags, undefined); assert.equal(c.acks.length, 1);
  }
});

test('six client locales and English fallback receive actionable errors for modal and deferred paths', async () => {
  for (const locale of ['zh-TW', 'en-US', 'ru', 'tr', 'th', 'ko', 'de', undefined]) for (const immediate of [true, false]) {
    const f = fixture();
    const c = callback(f, () => { throw Object.assign(new Error('private internal error'), { errorCode: 'TIME_ZONE_INVALID' }); });
    await c.run(immediate ? f.event(undefined, 2, { locale, guild_locale: 'ko' }) : f.button('publish', { locale, guild_locale: 'ko' }));
    const payload = immediate ? c.acks[0].data : c.replies[0].payload;
    assert.equal(payload.content, localizeError(locale, 'TIME_ZONE_INVALID')); assert.ok(!payload.content.includes('TIME_ZONE_INVALID'));
    assert.deepEqual(payload.allowed_mentions.parse, []);
    assert.equal(c.acks.length, 1); assert.equal(c.acks[0].type, immediate ? 4 : 5); assert.equal(c.acks[0].data.flags, 64);
  }
});

test('unmarked or cloned proofs fail before ACK and cannot reach the open-wipe handler', async () => {
  const f = fixture(), native = f.event(), real = f.verify(f.envelope(native));
  let called = false;
  const c = callback(f, () => { called = true; }, { verify: () => structuredClone(real) });
  await assert.rejects(c.run(native), error => error.errorCode === 'PLATFORM_AUTH_INVALID');
  assert.equal(called, false); assert.equal(c.acks.length, 0); assert.equal(c.replies.length, 0);
});

test('a private response transport failure does not send a second interaction ACK', async () => {
  const f = fixture();
  const c = callback(f, () => ({ content: 'Saved', components: [] }), { transport: { runtimeMode: 'isolated', request() {}, respondPrivate() { throw new Error('network'); } } });
  await assert.rejects(c.run(f.button('signup_on_time')), error => error.errorCode === 'PRIVATE_RESPONSE_UNKNOWN');
  assert.deepEqual(c.acks, [{ type: 5, data: { flags: 64 } }]);
});
