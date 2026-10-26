import test from 'node:test';
import assert from 'node:assert/strict';
import { createCipheriv, generateKeyPairSync, randomBytes, sign } from 'node:crypto';
import { deflateSync } from 'node:zlib';
import { createDiscordVerifier, createKookVerifier } from '../server/v2/notification-platforms/verifiers.js';

const START = Date.UTC(2026, 8, 8, 1, 2, 3);
const PUBLIC_REFERENCE = 'public_action_reference_abcdefghijklmnopqrstuvwxyz';
const CONTEXT_TOKEN = 'C'.repeat(43);
const VERIFY_TOKEN = 'isolated-test-verify-token';
const ENCRYPT_KEY = 'isolated-test-encrypt-key';
const reject = (fn, code = 'PLATFORM_AUTH_INVALID', status = 401) =>
  assert.throws(fn, error => error.errorCode === code && error.status === status && error.message === code);

function discordEvent(overrides = {}) {
  return { id: '123456789012345678', application_id: '222222222222222222', type: 3,
    guild_id: '333333333333333333', channel_id: '444444444444444444',
    member: { user: { id: '555555555555555555' }, roles: ['untrusted-role-snapshot'] },
    token: 'isolated-interaction-secret', data: { component_type: 2, custom_id: PUBLIC_REFERENCE }, ...overrides };
}

function discord(options = {}) {
  let current = START;
  const pair = generateKeyPairSync('ed25519');
  const publicKey = pair.publicKey.export({ format: 'der', type: 'spki' }).subarray(-32).toString('hex');
  const verify = createDiscordVerifier({ publicKey, now: () => current, ...options });
  function envelope(event = discordEvent(), { timestamp = String(Math.floor(current / 1000)), raw = null } = {}) {
    const rawBody = raw ?? Buffer.from(JSON.stringify(event));
    return { rawBody, receivedAt: new Date(current).toISOString(), headers: {
      'X-Signature-Timestamp': timestamp,
      'X-Signature-Ed25519': sign(null, Buffer.concat([Buffer.from(timestamp), rawBody]), pair.privateKey).toString('hex')
    } };
  }
  return { verify, envelope, advance: ms => { current += ms; }, publicKey };
}

test('Discord preserves only the signed invoking locale, never substitutes the guild locale', () => {
  for (const locale of ['en-US', 'zh-TW', 'ru', 'tr', 'th', 'ko', undefined, '<@everyone>', 123]) {
    const client = discord();
    const proof = client.verify(client.envelope(discordEvent({locale, guild_locale:'zh-CN'})));
    assert.equal(proof.locale, typeof locale === 'string' && !locale.startsWith('<') ? locale : null);
    assert.ok(Object.isFrozen(proof));
  }
});

function kookEvent(overrides = {}) {
  const { d: dataOverrides, ...rest } = overrides;
  return { s: 0, sn: 1, d: { type: 255, channel_type: 'PERSON',
    target_id: 'top-level-person-target', author_id: 'system-author', content: '[system event]',
    msg_id: 'event-unique-1', msg_timestamp: START, verify_token: VERIFY_TOKEN,
    extra: { type: 'message_btn_click', body: { user_id: 'kook-user-1', value: PUBLIC_REFERENCE,
      target_id: 'kook-channel-1', msg_id: 'clicked-original-card-1' } }, ...dataOverrides }, ...rest };
}

function encrypted(event, keyText = ENCRYPT_KEY) {
  const key = Buffer.alloc(32);
  Buffer.from(keyText).copy(key);
  const iv = randomBytes(16);
  const cipher = createCipheriv('aes-256-cbc', key, iv);
  const ciphertext = Buffer.concat([cipher.update(Buffer.from(JSON.stringify(event))), cipher.final()]);
  return { encrypt: Buffer.concat([iv, Buffer.from(ciphertext.toString('base64'))]).toString('base64') };
}

function kook(options = {}) {
  let current = START;
  const configuration = { verifyToken: VERIFY_TOKEN, compression: 'none', now: () => current, ...options };
  const verify = createKookVerifier(configuration);
  function envelope(event = kookEvent(), { encrypt = Boolean(configuration.encryptKey), compress = configuration.compression === 'deflate' } = {}) {
    const payload = encrypt ? encrypted(event, configuration.encryptKey) : event;
    const bytes = Buffer.from(JSON.stringify(payload));
    return { rawBody: compress ? deflateSync(bytes) : bytes, receivedAt: new Date(current).toISOString(), headers: {} };
  }
  return { verify, envelope, advance: ms => { current += ms; } };
}

test('Discord verifies generated Ed25519 raw timestamp+body and projects only authenticated fields', () => {
  const client = discord();
  const event = discordEvent({ payload: { wipeId: 'untrusted-wipe', contextToken: 'do-not-copy' } });
  const envelope = client.envelope(event);
  envelope.payload = { data: { custom_id: 'second-unverified-body' } };
  const value = client.verify(envelope);
  assert.deepEqual(value, { provider: 'discord', externalId: '555555555555555555',
    interactionId: event.id, guildId: event.guild_id, channelId: event.channel_id,
    actionReference: PUBLIC_REFERENCE, payload: { kind: 'public' }, locale: null,
    privateReplyContext: { applicationId: event.application_id, interactionToken: event.token } });
  assert.equal(Object.keys(value).length, 9);
  assert.ok(Object.isFrozen(value));
  assert.ok(Object.isFrozen(value.payload));
  assert.ok(Object.isFrozen(value.privateReplyContext));
  assert.throws(() => { value.payload.kind = 'confirm'; }, TypeError);
  assert.ok(!JSON.stringify(value.payload).includes('do-not-copy'));
});

test('Discord rejects unchanged signature after raw body whitespace or UTF-8 mutation', () => {
  const client = discord();
  const envelope = client.envelope(discordEvent({ locale: '中文' }));
  reject(() => client.verify({ ...envelope, rawBody: Buffer.concat([envelope.rawBody, Buffer.from(' ')]) }));
  reject(() => client.verify({ ...envelope, rawBody: Buffer.from(envelope.rawBody.toString().replace('中文', '日本語')) }));
});

test('Discord rejects bad signatures, missing/duplicate headers and timestamp mutation', () => {
  const client = discord();
  const envelope = client.envelope();
  reject(() => client.verify({ ...envelope, headers: {} }));
  reject(() => client.verify({ ...envelope, headers: { ...envelope.headers, 'x-signature-timestamp': envelope.headers['X-Signature-Timestamp'] } }));
  reject(() => client.verify({ ...envelope, headers: { ...envelope.headers, 'X-Signature-Timestamp': ' 123' } }));
  reject(() => client.verify({ ...envelope, headers: { ...envelope.headers, 'X-Signature-Timestamp': String(START / 1000 + 1) } }));
  reject(() => client.verify({ ...envelope, headers: { ...envelope.headers, 'X-Signature-Ed25519': '0'.repeat(128) } }));
});

test('Discord accepts case-insensitive headers and checks optional application ID binding', () => {
  const client = discord({ applicationId: '222222222222222222' });
  const envelope = client.envelope();
  envelope.headers = Object.fromEntries(Object.entries(envelope.headers).map(([key, value]) => [key.toLowerCase(), value]));
  assert.equal(client.verify(envelope).provider, 'discord');
  reject(() => client.verify(client.envelope(discordEvent({ application_id: 'other-app' }))));
});

test('Discord freshness uses injected clock, rejects unseen stale and future signed requests', () => {
  const client = discord();
  const stale = client.envelope(undefined, { timestamp: String(START / 1000 - 301) });
  stale.receivedAt = new Date(START - 301_000).toISOString();
  reject(() => client.verify(stale), 'PLATFORM_REQUEST_EXPIRED');
  reject(() => client.verify(client.envelope(undefined, { timestamp: String(START / 1000 + 31) })), 'PLATFORM_REQUEST_EXPIRED');
});

test('Discord exact retry stays eligible for G04 receipt after freshness window; retention is bounded', () => {
  const client = discord();
  const envelope = client.envelope();
  const first = client.verify(envelope);
  client.advance(301_000);
  assert.deepEqual(client.verify(envelope), first);
  client.advance(600_000);
  reject(() => client.verify(envelope), 'PLATFORM_REQUEST_EXPIRED');
});

test('Discord rejects a correctly re-signed changed body with the same interaction ID', () => {
  const client = discord();
  client.verify(client.envelope());
  reject(() => client.verify(client.envelope(discordEvent({ data: { component_type: 2, custom_id: 'different-reference' } }))),
    'PLATFORM_REPLAY_CONFLICT');
});

test('Discord replay capacity fails closed and preserves previous interaction bindings', () => {
  const client = discord({ maxReplayEntries: 2 });
  const first = client.envelope();
  client.verify(first);
  client.verify(client.envelope(discordEvent({ id: 'second-interaction' })));
  reject(() => client.verify(client.envelope(discordEvent({ id: 'third-interaction' }))), 'PLATFORM_REPLAY_CAPACITY', 503);
  assert.equal(client.verify(first).interactionId, '123456789012345678');
});

test('Discord PING is signature-verified before returning handshake DTO without a business identity', () => {
  const client = discord();
  const envelope = client.envelope({ type: 1 });
  assert.deepEqual(client.verify(envelope), { provider: 'discord', externalId: null, interactionId: null,
    guildId: null, channelId: null, actionReference: null, privateReplyContext: null, payload: { kind: 'ping' } });
  envelope.headers['X-Signature-Ed25519'] = '0'.repeat(128);
  reject(() => client.verify(envelope));
});

test('Discord rejects unsupported interactions, invalid JSON/UTF-8 and ambiguous authenticated identities', () => {
  const client = discord();
  // Slash commands are supported; a command without a name has invalid data.
  reject(() => client.verify(client.envelope(discordEvent({ type: 2 }))), 'PLATFORM_PAYLOAD_INVALID', 422);
  reject(() => client.verify(client.envelope(discordEvent({ data: { component_type: 3, custom_id: PUBLIC_REFERENCE, values: ['x'] } }))),
    'PLATFORM_EVENT_UNSUPPORTED', 422);
  reject(() => client.verify(client.envelope(undefined, { raw: Buffer.from('{invalid-json') })));
  reject(() => client.verify(client.envelope(undefined, { raw: Buffer.from([0xff, 0xff]) })));
  reject(() => client.verify(client.envelope(discordEvent({ user: { id: 'other-user' } }))));
  reject(() => client.verify(client.envelope(discordEvent({ channel: { id: 'other-channel' } }))));
  reject(() => client.verify(client.envelope(discordEvent({ member: null, user: { id: 'dm-user' } }))));
});

for (const provider of ['discord', 'kook']) {
  test(`${provider} maps actor-private confirmation token and explicit late arrival from authenticated button only`, () => {
    const client = provider === 'discord' ? discord() : kook();
    function event(button, counter) {
      if (provider === 'discord') return discordEvent({ id: `interaction-${counter}`,
        data: { component_type: 2, custom_id: button } });
      const result = kookEvent({ sn: counter, d: { msg_id: `event-${counter}` } });
      result.d.extra.body.value = button;
      return result;
    }
    const confirm = client.verify(client.envelope(event(`nbconfirm:${CONTEXT_TOKEN}`, 1)));
    assert.equal(confirm.actionReference, null);
    assert.deepEqual(confirm.payload, { kind: 'confirm', contextToken: CONTEXT_TOKEN });
    const timestamp = START + 3_600_000;
    const late = client.verify(client.envelope(event(`nblate:${CONTEXT_TOKEN}:${timestamp}`, 2)));
    assert.equal(late.actionReference, null);
    assert.deepEqual(late.payload, { kind: 'confirm', contextToken: CONTEXT_TOKEN,
      input: { expectedArrivalAt: new Date(timestamp).toISOString(), timeZone: 'UTC' } });
    assert.ok(Object.isFrozen(late.payload.input));
    reject(() => client.verify(client.envelope(event('nbconfirm:short', 3))), 'PLATFORM_PAYLOAD_INVALID', 422);
    reject(() => client.verify(client.envelope(event(`nblate:${CONTEXT_TOKEN}:9999999999999999`, 4))), 'PLATFORM_PAYLOAD_INVALID', 422);
    reject(() => client.verify(client.envelope(event(`nblate:${CONTEXT_TOKEN}:NaN`, 5))), 'PLATFORM_PAYLOAD_INVALID', 422);
    reject(() => client.verify(client.envelope(event(JSON.stringify({ wipeId: 'injected' }), 6))), 'PLATFORM_PAYLOAD_INVALID', 422);
  });
}

test('KOOK maps official PERSON button event; event ID differs from clicked card ID and guild stays null', () => {
  const client = kook();
  const event = kookEvent();
  event.d.extra.guild_id = 'unsupported-guild-hint';
  const value = client.verify(client.envelope(event));
  assert.deepEqual(value, { provider: 'kook', externalId: 'kook-user-1', interactionId: 'event-unique-1',
    guildId: null, channelId: 'kook-channel-1', actionReference: PUBLIC_REFERENCE, payload: { kind: 'public' },
    privateReplyContext: { userId: 'kook-user-1', channelId: 'kook-channel-1', messageId: 'clicked-original-card-1' } });
  assert.ok(Object.isFrozen(value));
  assert.ok(!JSON.stringify(value).includes(VERIFY_TOKEN));
  assert.ok(!JSON.stringify(value).includes('top-level-person-target'));
});

test('KOOK distinct users clicking one card retain distinct event operation IDs', () => {
  const client = kook();
  const second = kookEvent({ sn: 2, d: { msg_id: 'event-unique-2' } });
  second.d.extra.body.user_id = 'kook-user-2';
  const firstResult = client.verify(client.envelope());
  const secondResult = client.verify(client.envelope(second));
  assert.notEqual(firstResult.interactionId, secondResult.interactionId);
  assert.equal(firstResult.privateReplyContext.messageId, secondResult.privateReplyContext.messageId);
});

test('KOOK validates wrong/missing verify token with safe errors before event or challenge dispatch', () => {
  const client = kook();
  reject(() => client.verify(client.envelope(kookEvent({ d: { verify_token: 'incorrect-secret' } }))));
  reject(() => client.verify(client.envelope(kookEvent({ d: { verify_token: null } }))));
  reject(() => client.verify(client.envelope({ s: 0, d: { type: 255, channel_type: 'WEBHOOK_CHALLENGE',
    challenge: 'challenge', verify_token: 'incorrect-secret' } })));
});

test('KOOK default deflate and explicit compress=0 modes both validate original protocol bodies', () => {
  const plain = kook();
  const compressed = kook({ compression: 'deflate' });
  assert.equal(plain.verify(plain.envelope()).provider, 'kook');
  assert.equal(compressed.verify(compressed.envelope()).provider, 'kook');
  const implicitDefault = createKookVerifier({ verifyToken: VERIFY_TOKEN, now: () => START });
  assert.equal(implicitDefault(compressed.envelope()).provider, 'kook');
  reject(() => compressed.verify(plain.envelope()));
  reject(() => plain.verify(compressed.envelope()));
  const wrongEncoding = compressed.envelope();
  wrongEncoding.headers['Content-Encoding'] = 'gzip';
  reject(() => compressed.verify(wrongEncoding));
});

test('KOOK local AES-256-CBC double-Base64 fixture validates and enforces plaintext downgrade rejection', () => {
  const client = kook({ encryptKey: ENCRYPT_KEY });
  const envelope = client.envelope();
  assert.equal(client.verify(envelope).actionReference, PUBLIC_REFERENCE);
  reject(() => client.verify(client.envelope(undefined, { encrypt: false })));
  reject(() => kook().verify(envelope));
  // Identical authenticated plaintext may be re-encrypted with a new random IV on retry.
  assert.equal(client.verify(client.envelope()).interactionId, 'event-unique-1');
});

test('KOOK decrypts encrypted deflated challenge and checks verify token after decryption', () => {
  const client = kook({ encryptKey: ENCRYPT_KEY, compression: 'deflate', requireEncrypted: true });
  const challenge = { s: 0, d: { type: 255, channel_type: 'WEBHOOK_CHALLENGE',
    challenge: 'challenge-roundtrip', verify_token: VERIFY_TOKEN } };
  assert.deepEqual(client.verify(client.envelope(challenge)), { provider: 'kook', externalId: null,
    interactionId: null, guildId: null, channelId: null, actionReference: null, privateReplyContext: null,
    payload: { kind: 'challenge', challenge: 'challenge-roundtrip' } });
  challenge.d.verify_token = 'wrong-decrypted-token';
  reject(() => client.verify(client.envelope(challenge)));
});

test('KOOK decrypt failures and malformed ciphertext do not disclose cryptographic or private input details', () => {
  const client = kook({ encryptKey: ENCRYPT_KEY });
  const event = encrypted(kookEvent());
  const outer = Buffer.from(event.encrypt, 'base64');
  const cipher = Buffer.from(outer.subarray(16).toString(), 'base64');
  cipher[cipher.length - 1] ^= 1;
  const tampered = { encrypt: Buffer.concat([outer.subarray(0, 16), Buffer.from(cipher.toString('base64'))]).toString('base64') };
  const raw = value => ({ rawBody: Buffer.from(JSON.stringify(value)), headers: {}, receivedAt: new Date(START).toISOString() });
  reject(() => client.verify(raw(tampered)));
  reject(() => client.verify(raw({ encrypt: 'not base64' })));
  reject(() => client.verify(raw({ encrypt: Buffer.from('short').toString('base64') })));
  reject(() => client.verify(raw({ ...event, d: kookEvent().d })));
  reject(() => kook({ encryptKey: 'other-isolated-key' }).verify(raw(event)));
});

test('KOOK exact event retry remains available for receipt; changed event body, sequence, or sequence reuse is rejected', () => {
  const client = kook();
  const envelope = client.envelope();
  const initial = client.verify(envelope);
  client.advance(301_000);
  assert.deepEqual(client.verify(envelope), initial);
  const changed = kookEvent();
  changed.d.extra.body.user_id = 'other-user';
  reject(() => client.verify(client.envelope(changed)), 'PLATFORM_REPLAY_CONFLICT');
  reject(() => client.verify(client.envelope(kookEvent({ sn: 2 }))), 'PLATFORM_REPLAY_CONFLICT');
  reject(() => client.verify(client.envelope(kookEvent({ d: { msg_id: 'same-sequence-new-event' } }))), 'PLATFORM_REPLAY_CONFLICT');
});

test('KOOK new stale/future events and retries beyond bounded replay retention are rejected', () => {
  const client = kook();
  reject(() => client.verify(client.envelope(kookEvent({ d: { msg_timestamp: START - 300_001 } }))), 'PLATFORM_REQUEST_EXPIRED');
  reject(() => client.verify(client.envelope(kookEvent({ d: { msg_timestamp: START + 30_001 } }))), 'PLATFORM_REQUEST_EXPIRED');
  const envelope = client.envelope();
  client.verify(envelope);
  client.advance(900_001);
  reject(() => client.verify(envelope), 'PLATFORM_REQUEST_EXPIRED');
});

test('KOOK only accepts approved PERSON button shape and requires channel, click actor, card ID and sequence', () => {
  const client = kook();
  reject(() => client.verify(client.envelope(kookEvent({ d: { channel_type: 'GROUP' } }))), 'PLATFORM_EVENT_UNSUPPORTED', 422);
  reject(() => client.verify(client.envelope(kookEvent({ d: { type: 10 } }))), 'PLATFORM_EVENT_UNSUPPORTED', 422);
  for (const missing of ['user_id', 'target_id', 'msg_id']) {
    const event = kookEvent();
    event.d.extra.body[missing] = '';
    reject(() => client.verify(client.envelope(event)));
  }
  reject(() => client.verify(client.envelope(kookEvent({ sn: '1' }))));
  reject(() => client.verify(client.envelope(kookEvent({ sn: -1 }))));
  reject(() => client.verify(client.envelope(kookEvent({ d: { msg_id: '' } }))));
});

test('KOOK replay capacity retains both event and sequence bindings without evicting active entries', () => {
  const client = kook({ maxReplayEntries: 2 });
  const first = client.envelope();
  client.verify(first);
  reject(() => client.verify(client.envelope(kookEvent({ sn: 2, d: { msg_id: 'second-event' } }))), 'PLATFORM_REPLAY_CAPACITY', 503);
  assert.equal(client.verify(first).interactionId, 'event-unique-1');
});

test('verifiers reject invalid config, oversized input and bounded deflate expansion', () => {
  reject(() => createDiscordVerifier(), 'PLATFORM_VERIFIER_CONFIG_INVALID', 503);
  reject(() => createKookVerifier(), 'PLATFORM_VERIFIER_CONFIG_INVALID', 503);
  reject(() => createKookVerifier({ verifyToken: VERIFY_TOKEN, requireEncrypted: true }), 'PLATFORM_VERIFIER_CONFIG_INVALID', 503);
  reject(() => createKookVerifier({ verifyToken: VERIFY_TOKEN, encryptKey: 'k'.repeat(33) }), 'PLATFORM_VERIFIER_CONFIG_INVALID', 503);
  reject(() => createKookVerifier({ verifyToken: VERIFY_TOKEN, compression: 'auto' }), 'PLATFORM_VERIFIER_CONFIG_INVALID', 503);
  reject(() => discord({ replayTtlMs: 1 }), 'PLATFORM_VERIFIER_CONFIG_INVALID', 503);
  const discordClient = discord({ maxBodyBytes: 64 });
  reject(() => discordClient.verify(discordClient.envelope()));
  const kookClient = kook({ compression: 'deflate', maxBodyBytes: 512 });
  const large = kookEvent({ d: { content: 'x'.repeat(10_000) } });
  const envelope = kookClient.envelope(large);
  assert.ok(envelope.rawBody.length < 512);
  reject(() => kookClient.verify(envelope));
});
