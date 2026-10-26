import assert from 'node:assert/strict';
import test from 'node:test';
import { generateKeyPairSync, sign } from 'node:crypto';
import { createDiscordVerifier } from '../server/v2/notification-platforms/verifiers.js';
import { createNotificationCallbackHandler } from '../server/v2/notification-platforms/callbacks.js';
import { buildNativePrivateResponseRequest } from '../server/v2/notification-platforms/platforms.js';
import { assertSteamLinksProof } from '../server/v2/discord-steam-links/proof.js';
import { steamLinksCustomId } from '../server/v2/discord-steam-links/interaction-input.js';

const now = Date.parse('2026-10-15T10:00:00Z'), token = 'a'.repeat(43);
const guildId = '100000000000000001', channelId = '100000000000000002';
const userId = '100000000000000003', applicationId = '100000000000000004', messageId = '100000000000000005';
function fixture(handleSteamLinks) {
  const keys = generateKeyPairSync('ed25519');
  const publicKey = keys.publicKey.export({ format: 'der', type: 'spki' }).subarray(-32).toString('hex');
  const verify = createDiscordVerifier({ publicKey, applicationId, now: () => now });
  let sequence = 100000000000000100n;
  const event = (data = { name: 'setsteam', type: 1 }, type = 2, patch = {}) => ({
    id: String(sequence++), application_id: applicationId, type, guild_id: guildId, channel_id: channelId,
    member: { user: { id: userId, username: 'Tester' }, roles: [], permissions: '32' },
    token: 'private-fixture-token', locale: 'en-US', data, ...patch,
  });
  const envelope = value => {
    const rawBody = Buffer.from(JSON.stringify(value)), timestamp = String(now / 1000);
    return { rawBody, headers: { 'x-signature-timestamp': timestamp,
      'x-signature-ed25519': sign(null, Buffer.concat([Buffer.from(timestamp), rawBody]), keys.privateKey).toString('hex') } };
  };
  const events = [], acks = [], replies = [];
  const forbidden = new Proxy({}, { get() { assert.fail('Manual links cannot read website identity or signup state'); } });
  const handler = createNotificationCallbackHandler({ platform: 'discord', verify, identity: forbidden, scheduling: forbidden,
    publicOrigin: 'http://127.0.0.1:4316', resolveActionReference() { assert.fail('No signup reference lookup'); },
    handleCommunity() { assert.fail('No website-bound community handler'); },
    handleSteamLinks: async proof => { events.push('handle'); assertSteamLinksProof(proof); return handleSteamLinks(proof); },
    transport: { runtimeMode: 'isolated', request() { assert.fail('No public message'); },
      async respondPrivate(input) { events.push('reply'); const wire = buildNativePrivateResponseRequest(input);
        assert.equal(wire.method, 'PATCH'); assert.match(wire.path, /\/messages\/@original$/); replies.push(wire.body); } },
    now: () => now });
  return { verify, event, envelope, events, acks, replies,
    run: value => handler(envelope(value), { ack(payload) { events.push('ack'); acks.push(payload); } }) };
}

test('Steam-link verifier preserves only signed guild, actor, roles and client language', () => {
  const f = fixture(), event = f.event(undefined, 2, { locale: 'ko', discordPermissions: '8',
    member: { user: { id: userId }, roles: ['100000000000000006'], permissions: '0' } });
  const proof = f.verify(f.envelope(event));
  assert.equal(assertSteamLinksProof(proof), proof);
  assert.equal(proof.discordPermissions, '0'); assert.equal(proof.locale, 'ko');
  assert.deepEqual(proof.discordRoleIds, ['100000000000000006']);
  assert.ok(Object.isFrozen(proof) && Object.isFrozen(proof.payload));
  assert.throws(() => assertSteamLinksProof(structuredClone(proof)), /PLATFORM_AUTH_INVALID/);
  for (const patch of [{ guild_id: null }, { channel_id: 'fake' },
    { member: { user: { id: userId, bot: true }, roles: [], permissions: '8' } },
    { member: { user: { id: userId }, roles: [], permissions: '18446744073709551616' } }]) {
    assert.throws(() => f.verify(f.envelope(f.event(undefined, 2, patch))), /PLATFORM_AUTH_INVALID/);
  }
  const wire = f.envelope(event);
  assert.throws(() => f.verify({ ...wire, rawBody: Buffer.from(JSON.stringify({ ...event, locale: 'ru' })) }), /PLATFORM_AUTH_INVALID/);
});

test('/setsteam opens a modal in its initial response without reading a website account', async () => {
  const f = fixture(() => ({ type: 9, data: { title: 'Link Steam', custom_id: steamLinksCustomId('submit', token),
    components: [{ type: 1, components: [{ type: 4, style: 1, custom_id: 'identifier', label: 'SteamID64' }] }] } }));
  await f.run(f.event());
  assert.equal(f.acks[0].type, 9); assert.equal(f.replies.length, 0);
  assert.deepEqual(f.events, ['handle', 'ack']);
});

test('all Steam view subcommands ACK privately before asynchronous reads and prohibit mentions', async () => {
  for (const name of ['user', 'all', 'nosteam']) {
    const f = fixture(proof => {
      assert.equal(proof.payload.action, `view_${name}`);
      assert.equal(f.events[0], 'ack');
      return { content: 'Private profile or list', flags: 0, allowed_mentions: { parse: ['everyone'] } };
    });
    await f.run(f.event({ name: 'view', options: [{ type: 1, name }] }));
    assert.deepEqual(f.acks, [{ type: 5, data: { flags: 64 } }]);
    assert.deepEqual(f.replies[0].allowed_mentions, { parse: [], roles: [], users: [], replied_user: false });
    assert.deepEqual(f.events, ['ack', 'handle', 'reply']);
  }
});

test('pagination updates only a signed ephemeral origin; a public origin receives a new private reply', async () => {
  for (const flags of [0, 64]) {
    const f = fixture(() => ({ content: 'Page two', components: [] }));
    await f.run(f.event({ component_type: 2, custom_id: steamLinksCustomId('page', token, 1) }, 3,
      { message: { id: messageId, flags }, originEphemeral: flags === 0 }));
    assert.deepEqual(f.acks, flags === 64 ? [{ type: 6 }] : [{ type: 5, data: { flags: 64 } }]);
  }
});

test('Steam errors are localized and cannot leak upstream error details or leave stale controls', async () => {
  const f = fixture(() => { throw Object.assign(new Error('secret-upstream-token'), { errorCode: 'UNRECOGNIZED' }); });
  await f.run(f.event({ name: 'view', options: [{ type: 1, name: 'all' }] }, 2, { locale: 'zh-CN' }));
  assert.match(f.replies[0].content, /[\u4e00-\u9fff]/);
  assert.doesNotMatch(JSON.stringify(f.replies), /secret-upstream-token|UNRECOGNIZED/);
  assert.deepEqual(f.replies[0].components, []); assert.deepEqual(f.replies[0].embeds, []);
});

test('malformed user options and forged modal field names fail before acknowledgment', async () => {
  const f = fixture(() => assert.fail('Malformed payload reached service'));
  for (const data of [{ name: 'view', options: [{ type: 1, name: 'user', options: [{ type: 3, name: 'user', value: userId }] }] },
    { name: 'view', options: [{ type: 1, name: 'all', options: [{ type: 3, name: 'identifier', value: 'anything' }] }] }]) {
    await assert.rejects(f.run(f.event(data)), /PLATFORM_PAYLOAD_INVALID/);
  }
  await assert.rejects(f.run(f.event({ custom_id: steamLinksCustomId('submit', token), components: [
    { type: 1, components: [{ type: 4, custom_id: 'accountId', value: userId }] }] }, 5)), /PLATFORM_PAYLOAD_INVALID/);
  assert.equal(f.acks.length, 0);
});
