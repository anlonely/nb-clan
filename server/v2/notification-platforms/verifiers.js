import {retainedSlash,retainedDiscordComponent,retainedKookButton} from './native-interactions.js';
import { discordCardViewInput, markCardViewProof } from './card-language-view.js';
import {markCommunityProof} from './community-proof.js';
import { parseOpenWipeInteraction } from '../discord-open-wipe/interaction-input.js';
import { markOpenWipeProof } from '../discord-open-wipe/proof.js';
import { parseSteamLinksInteraction } from '../discord-steam-links/interaction-input.js';
import { markSteamLinksProof } from '../discord-steam-links/proof.js';
import { createDecipheriv, createHash, createPublicKey, timingSafeEqual, verify as verifySignature } from 'node:crypto';
import { inflateSync } from 'node:zlib';
import { IdentityError, requireValue } from '../identity/errors.js';

const PUBLIC_TOKEN = /^[A-Za-z0-9_-]{1,100}$/;
const CONTEXT_TOKEN = '[A-Za-z0-9_-]{43}';
const CONFIRM = new RegExp(`^nbconfirm:(${CONTEXT_TOKEN})$`);
const LATE = new RegExp(`^nblate:(${CONTEXT_TOKEN}):([0-9]{1,16})$`);
const ED25519_SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');
const id = value => typeof value === 'string' && /^[A-Za-z0-9:_-]{1,160}$/.test(value);
const hash = value => createHash('sha256').update(value).digest('hex');
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);

function fail(code = 'PLATFORM_AUTH_INVALID', status = 401) {
  throw new IdentityError(code, status);
}

function deepFreeze(value) {
  if (value && typeof value === 'object') {
    for (const nested of Object.values(value)) deepFreeze(nested);
    Object.freeze(value);
  }
  return value;
}

function json(bytes) {
  try {
    const value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
    if (!object(value)) fail();
    return value;
  } catch { fail(); }
}

function header(headers, name) {
  requireValue(object(headers), 'PLATFORM_AUTH_INVALID', 401);
  const values = Object.entries(headers).filter(([key]) => key.toLowerCase() === name);
  if (values.length > 1 || (values.length && typeof values[0][1] !== 'string')) fail();
  return values.length ? values[0][1] : null;
}

function body(envelope, maxBodyBytes) {
  requireValue(envelope?.rawBody instanceof Uint8Array && envelope.rawBody.byteLength > 0 &&
    envelope.rawBody.byteLength <= maxBodyBytes, 'PLATFORM_AUTH_INVALID', 401);
  // Copy before any parsing. Neither callers nor downstream code can mutate the bytes being authenticated.
  return Buffer.from(envelope.rawBody);
}

function configuredInteger(value, min, max) {
  requireValue(Number.isSafeInteger(value) && value >= min && value <= max,
    'PLATFORM_VERIFIER_CONFIG_INVALID', 503);
  return value;
}

function createReplayGuard({ now, maxAgeMs, futureSkewMs, replayTtlMs, maxReplayEntries }) {
  requireValue(typeof now === 'function', 'PLATFORM_VERIFIER_CONFIG_INVALID', 503);
  configuredInteger(maxAgeMs, 1, 86_400_000);
  configuredInteger(futureSkewMs, 0, 300_000);
  configuredInteger(replayTtlMs, maxAgeMs + futureSkewMs, 172_800_000);
  configuredInteger(maxReplayEntries, 2, 100_000);
  const seen = new Map();
  return (keys, bytesHash, timestamp) => {
    const current = now();
    requireValue(Number.isSafeInteger(current), 'PLATFORM_VERIFIER_CONFIG_INVALID', 503);
    for (const [key, entry] of seen) if (entry.expiresAt <= current) seen.delete(key);
    if (!Number.isSafeInteger(timestamp) || timestamp < 0 || timestamp > current + futureSkewMs)
      fail('PLATFORM_REQUEST_EXPIRED');
    const existing = keys.map(key => seen.get(key)).filter(Boolean);
    if (existing.some(entry => entry.bytesHash !== bytesHash)) fail('PLATFORM_REPLAY_CONFLICT');
    // Exact authenticated retries can still retrieve a committed G04 receipt. This does not
    // authorize a new business command: G04 always checks identity, context and operation digest.
    if (!existing.length && current - timestamp > maxAgeMs) fail('PLATFORM_REQUEST_EXPIRED');
    const missing = keys.filter(key => !seen.has(key));
    // Do not evict live bindings: eviction would permit a changed, re-signed body with the same ID.
    if (seen.size + missing.length > maxReplayEntries) fail('PLATFORM_REPLAY_CAPACITY', 503);
    const expiresAt = existing[0]?.expiresAt ?? current + replayTtlMs;
    for (const key of missing) seen.set(key, { bytesHash, expiresAt });
  };
}

function action(value) {
  requireValue(typeof value === 'string' && value.length <= 100, 'PLATFORM_PAYLOAD_INVALID', 422);
  let match = CONFIRM.exec(value);
  if (match) return { actionReference: null, payload: { kind: 'confirm', contextToken: match[1] } };
  match = LATE.exec(value);
  if (match) {
    const timestamp = Number(match[2]);
    requireValue(Number.isSafeInteger(timestamp) && timestamp > 0 && timestamp <= 8_640_000_000_000_000,
      'PLATFORM_PAYLOAD_INVALID', 422);
    return { actionReference: null, payload: { kind: 'confirm', contextToken: match[1],
      input: { expectedArrivalAt: new Date(timestamp).toISOString(), timeZone: 'UTC' } } };
  }
  requireValue(PUBLIC_TOKEN.test(value), 'PLATFORM_PAYLOAD_INVALID', 422);
  return { actionReference: value, payload: { kind: 'public' } };
}

function slashPayload(data) {
  requireValue(object(data), 'PLATFORM_EVENT_UNSUPPORTED',422);
  if(!['kda','ranking','map'].includes(data.name))return retainedSlash(data);
  const fields = {steam_input:'steamInput',player:'steamInput',steamid:'steamInput',source:'sourceId',wipe:'wipeId',server:'serverId',provider_wipe:'providerWipeId',metric:'sort'};
  requireValue(data.options === undefined || Array.isArray(data.options) && data.options.length <= 7, 'PLATFORM_PAYLOAD_INVALID', 422);
  const payload={kind:'community',command:data.name};
  for (const option of data.options || []) {
    const key=fields[option?.name];
    requireValue(key && option.type===3 && typeof option.value==='string' && option.value.length>0 && option.value.length<=160 && !/[\x00-\x1f\x7f]/.test(option.value) && !Object.hasOwn(payload,key), 'PLATFORM_PAYLOAD_INVALID',422);
    payload[key]=option.value;
  }
  requireValue(data.name==='kda'?payload.steamInput:payload.wipeId, 'PLATFORM_PAYLOAD_INVALID',422);
  return payload;
}

function dto(provider, values) {
  return deepFreeze({ provider, externalId: null, interactionId: null, guildId: null, channelId: null,
    actionReference: null, privateReplyContext: null, payload: null, ...values });
}

/**
 * Discord Interactions HTTP signature: Ed25519(timestamp header + untouched request bytes).
 * Keys are explicitly supplied 32-byte public keys encoded as 64 hex characters.
 * The local freshness and bounded replay policy is additional application policy, not a
 * Discord-documented signature TTL. No environment, HTTP, identity or DB access occurs here.
 */
export function createDiscordVerifier({ publicKey, applicationId = null, now = Date.now,
  maxAgeMs = 300_000, futureSkewMs = 30_000, replayTtlMs = 900_000,
  maxReplayEntries = 10_000, maxBodyBytes = 262_144 } = {}) {
  requireValue(typeof publicKey === 'string' && /^[a-fA-F0-9]{64}$/.test(publicKey),
    'PLATFORM_VERIFIER_CONFIG_INVALID', 503);
  requireValue(applicationId === null || id(applicationId), 'PLATFORM_VERIFIER_CONFIG_INVALID', 503);
  configuredInteger(maxBodyBytes, 64, 1_048_576);
  const key = createPublicKey({ key: Buffer.concat([ED25519_SPKI_PREFIX, Buffer.from(publicKey, 'hex')]),
    format: 'der', type: 'spki' });
  const replay = createReplayGuard({ now, maxAgeMs, futureSkewMs, replayTtlMs, maxReplayEntries });
  return function verifyDiscord(envelope) {
    const raw = body(envelope, maxBodyBytes);
    const signature = header(envelope.headers, 'x-signature-ed25519');
    const timestamp = header(envelope.headers, 'x-signature-timestamp');
    if (!/^[a-fA-F0-9]{128}$/.test(signature ?? '') || !/^[0-9]{1,12}$/.test(timestamp ?? '')) fail();
    let valid = false;
    try { valid = verifySignature(null, Buffer.concat([Buffer.from(timestamp, 'ascii'), raw]), key, Buffer.from(signature, 'hex')); }
    catch { fail(); }
    if (!valid) fail();
    const event = json(raw);
    if (applicationId !== null && event.application_id !== applicationId) fail();
    const fingerprint = hash(raw);
    if (event.type === 1) {
      replay([`ping:${fingerprint}`], fingerprint, Number(timestamp) * 1000);
      return dto('discord', { interactionId: id(event.id) ? event.id : null, payload: { kind: 'ping' } });
    }
    const cardView = discordCardViewInput(event);
    const openWipe = parseOpenWipeInteraction(event);
    const steamLinks = parseSteamLinksInteraction(event);
    const community = cardView || openWipe || steamLinks ? null : event.type === 2 ? slashPayload(event.data) : retainedDiscordComponent(event);
    requireValue(openWipe || steamLinks || community || event.type === 3 && object(event.data) && event.data.component_type === 2,
      'PLATFORM_EVENT_UNSUPPORTED', 422);
    const externalId = event.member?.user?.id ?? event.user?.id;
    const channelId = event.channel_id ?? event.channel?.id;
    const guildId = event.guild_id ?? null;
    if (!id(event.id) || !id(externalId) || !id(channelId) || !id(event.application_id) ||
      (guildId !== null && !id(guildId)) || typeof event.token !== 'string' ||
      !/^[\x21-\x7e]{1,2048}$/.test(event.token)) fail();
    if (event.member?.user?.id && event.user?.id && event.member.user.id !== event.user.id) fail();
    if (event.channel_id && event.channel?.id && event.channel_id !== event.channel.id) fail();
    if (guildId !== null && !event.member?.user?.id) fail();
    if (openWipe || steamLinks) {
      requireValue(guildId && Array.isArray(event.member?.roles) && event.member.roles.length <= 250 &&
        event.member.roles.every(role => typeof role === 'string' && /^\d{17,20}$/.test(role)) &&
        typeof event.member.permissions === 'string' && /^\d{1,20}$/.test(event.member.permissions) &&
        BigInt(event.member.permissions) <= 18446744073709551615n && event.member.user.bot !== true,
      'PLATFORM_AUTH_INVALID', 401);
      if (event.type === 3) requireValue(typeof event.message?.id === 'string' && /^\d{17,20}$/.test(event.message.id), 'PLATFORM_AUTH_INVALID', 401);
    }
    if (steamLinks) requireValue([event.id, externalId, guildId, channelId, event.application_id]
      .every(value => typeof value === 'string' && /^\d{17,20}$/.test(value)), 'PLATFORM_AUTH_INVALID', 401);
    const mapped = steamLinks ? { actionReference: null, payload: steamLinks } : openWipe ? { actionReference: null, payload: openWipe } : cardView ? { actionReference: null, payload: cardView } : community ? {actionReference:null,payload:community} : action(event.data.custom_id);
    replay([`event:${event.id}`], fingerprint, Number(timestamp) * 1000);
    const displayName = event.member?.nick || event.member?.user?.global_name || event.user?.global_name || event.member?.user?.username || event.user?.username;
    const proof = dto('discord', { externalId, interactionId: event.id, guildId, channelId, ...mapped,
      ...(typeof displayName === 'string' ? { externalDisplayName: displayName.replace(/[\x00-\x1f\x7f]/g, '').slice(0, 80) } : {}),
      locale: typeof event.locale === 'string' && event.locale.length <= 32 && /^[a-z]{2,3}(?:-[a-z0-9]{2,8})*$/i.test(event.locale) ? event.locale : null,
      ...(cardView ? { originMessageId: event.message.id } : {}),
      ...(openWipe || steamLinks ? { discordRoleIds: [...new Set(event.member.roles)], discordPermissions: event.member.permissions,
        originMessageId: event.message?.id || null, originEphemeral: Boolean((event.message?.flags || 0) & 64) } : {}),
      ...(community ? {verified:true} : {}), privateReplyContext: { applicationId: event.application_id, interactionToken: event.token } });
    return steamLinks ? markSteamLinksProof(proof) : openWipe ? markOpenWipeProof(proof) : cardView ? markCardViewProof(proof) : community ? markCommunityProof(proof) : proof;
  };
}

function base64(value) {
  if (typeof value !== 'string' || !value.length || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) fail();
  const bytes = Buffer.from(value, 'base64');
  if (bytes.toString('base64') !== value) fail();
  return bytes;
}

function decryptKook(encrypt, key, maxBodyBytes) {
  try {
    const outer = base64(encrypt);
    if (outer.length <= 16) fail();
    const ciphertext = base64(new TextDecoder('utf-8', { fatal: true }).decode(outer.subarray(16)));
    if (!ciphertext.length || ciphertext.length % 16 !== 0 || ciphertext.length > maxBodyBytes) fail();
    const decipher = createDecipheriv('aes-256-cbc', key, outer.subarray(0, 16));
    const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
    if (plaintext.length > maxBodyBytes) fail();
    return plaintext;
  } catch { fail(); }
}

/**
 * KOOK authenticates its Webhook with d.verify_token, optionally inside AES-256-CBC.
 * This is NOT an HMAC or a digital signature. CBC is not authenticated encryption.
 * Default wire compression follows KOOK's deflate default. compression:'none' requires
 * an explicitly configured compress=0 callback. Setting encryptKey requires encryption
 * by default; requireEncrypted:true rejects plaintext downgrade. HTTPS and server secret
 * protection remain essential.
 */
export function createKookVerifier({ verifyToken, encryptKey = null, requireEncrypted = encryptKey !== null,
  compression = 'deflate', now = Date.now,
  maxAgeMs = 300_000, futureSkewMs = 30_000, replayTtlMs = 900_000,
  maxReplayEntries = 10_000, maxBodyBytes = 262_144 } = {}) {
  requireValue(typeof verifyToken === 'string' && verifyToken.length > 0 && Buffer.byteLength(verifyToken) <= 1024,
    'PLATFORM_VERIFIER_CONFIG_INVALID', 503);
  requireValue(compression === 'deflate' || compression === 'none', 'PLATFORM_VERIFIER_CONFIG_INVALID', 503);
  requireValue(encryptKey === null || (typeof encryptKey === 'string' && Buffer.byteLength(encryptKey) > 0 &&
    Buffer.byteLength(encryptKey) <= 32), 'PLATFORM_VERIFIER_CONFIG_INVALID', 503);
  requireValue(typeof requireEncrypted === 'boolean' && (!requireEncrypted || encryptKey !== null),
    'PLATFORM_VERIFIER_CONFIG_INVALID', 503);
  configuredInteger(maxBodyBytes, 64, 1_048_576);
  const secretDigest = hash(Buffer.from(verifyToken));
  const key = encryptKey === null ? null : Buffer.alloc(32);
  if (key) Buffer.from(encryptKey, 'utf8').copy(key);
  const replay = createReplayGuard({ now, maxAgeMs, futureSkewMs, replayTtlMs, maxReplayEntries });
  return function verifyKook(envelope) {
    const raw = body(envelope, maxBodyBytes);
    const encoding = header(envelope.headers, 'content-encoding');
    if (encoding !== null && encoding.toLowerCase() !== (compression === 'deflate' ? 'deflate' : 'identity')) fail();
    let decoded;
    try { decoded = compression === 'deflate' ? inflateSync(raw, { maxOutputLength: maxBodyBytes }) : raw; }
    catch { fail(); }
    let event = json(decoded);
    if (Object.hasOwn(event, 'encrypt')) {
      if (key === null) fail();
      if (Object.keys(event).length !== 1 || typeof event.encrypt !== 'string') fail();
      decoded = decryptKook(event.encrypt, key, maxBodyBytes);
      event = json(decoded);
    } else if (requireEncrypted) fail();
    const data = event.d;
    if (event.s !== 0 || !object(data) || typeof data.verify_token !== 'string' ||
      !timingSafeEqual(Buffer.from(hash(Buffer.from(data.verify_token)), 'hex'), Buffer.from(secretDigest, 'hex'))) fail();
    if (data.type === 255 && data.channel_type === 'WEBHOOK_CHALLENGE') {
      requireValue(typeof data.challenge === 'string' && data.challenge.length > 0 && data.challenge.length <= 2048,
        'PLATFORM_PAYLOAD_INVALID', 422);
      // KOOK's documented Challenge has no event ID, sn, or timestamp. It is authenticated
      // using the configured token/encryption and cannot mutate scheduling state.
      return dto('kook', { payload: { kind: 'challenge', challenge: data.challenge } });
    }
    requireValue(data.type === 255 && data.channel_type === 'PERSON' &&
      data.extra?.type === 'message_btn_click' && object(data.extra.body),
      'PLATFORM_EVENT_UNSUPPORTED', 422);
    const clicked = data.extra.body;
    if (!id(data.msg_id) || !id(clicked.user_id) || !id(clicked.target_id) || !id(clicked.msg_id) ||
      !Number.isSafeInteger(event.sn) || event.sn < 0) fail();
    // In the official PERSON button event, d.target_id is not a guild ID. The approved
    // addendum-01 requires the resolver to bind this channel to its stored reference.
    const guildId = null;
    const community=retainedKookButton(clicked);
    const mapped = community?{actionReference:null,payload:community}:action(clicked.value);
    // Bind both KOOK's unique sequence and event ID to exact decoded event bytes.
    // Re-encryption/compression of identical authenticated data remains a valid retry.
    replay([`event:${data.msg_id}`, `sn:${event.sn}`], hash(decoded), data.msg_timestamp);
    const proof=dto('kook', { ...(community?{verified:true}:{}), externalId: clicked.user_id, interactionId: data.msg_id, guildId,
      channelId: clicked.target_id, ...mapped,
      privateReplyContext: { userId: clicked.user_id, channelId: clicked.target_id, messageId: clicked.msg_id } });
    return community?markCommunityProof(proof):proof;
  };
}
