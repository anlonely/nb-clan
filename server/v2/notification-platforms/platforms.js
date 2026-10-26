import { canonicalJson, hashPayload } from './canonical.js';
import { assertNotificationTransport } from './runtime-mode.js';

const identifier = value => typeof value === 'string' && value.length > 0 && value.length <= 200 && !/[\x00-\x20\x7f/\\?#]/.test(value);
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const knownDiscordRejections = new Set([10003, 10004, 10008, 10015, 50001, 50005, 50013, 50035, 50083]);
const safeCopy = value => JSON.parse(canonicalJson(value));

const privateEmbedText = (value, limit) => typeof value === 'string' && value.length <= limit
  && !/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(value);
const onlyKeys = (value, keys) => object(value) && Object.keys(value).every(key => keys.includes(key));

// Private card views use only these native embed fields. Keep files, external
// media and arbitrary provider properties outside the private response contract.
function validPrivateDiscordEmbeds(embeds) {
  if (embeds === undefined) return true;
  if (!Array.isArray(embeds) || embeds.length > 10) return false;
  let characters = 0;
  for (const embed of embeds) {
    if (!onlyKeys(embed, ['title', 'description', 'color', 'timestamp', 'fields', 'footer'])) return false;
    for (const [key, limit] of [['title', 256], ['description', 4096]]) {
      if (embed[key] !== undefined) {
        if (!privateEmbedText(embed[key], limit)) return false;
        characters += embed[key].length;
      }
    }
    if (embed.color !== undefined && (!Number.isInteger(embed.color) || embed.color < 0 || embed.color > 0xffffff)) return false;
    if (embed.timestamp !== undefined && (typeof embed.timestamp !== 'string' || embed.timestamp.length > 64
      || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(embed.timestamp)
      || !Number.isFinite(Date.parse(embed.timestamp)))) return false;
    if (embed.fields !== undefined) {
      if (!Array.isArray(embed.fields) || embed.fields.length > 25) return false;
      for (const field of embed.fields) {
        if (!onlyKeys(field, ['name', 'value', 'inline']) || !privateEmbedText(field.name, 256) || !field.name.length
          || !privateEmbedText(field.value, 1024) || !field.value.length
          || (field.inline !== undefined && typeof field.inline !== 'boolean')) return false;
        characters += field.name.length + field.value.length;
      }
    }
    if (embed.footer !== undefined) {
      if (!onlyKeys(embed.footer, ['text']) || !privateEmbedText(embed.footer.text, 2048) || !embed.footer.text.length) return false;
      characters += embed.footer.text.length;
    }
    if (characters > 6000) return false;
  }
  return true;
}

function requireValue(condition, errorCode) {
  if (!condition) throw Object.assign(new Error(errorCode), { errorCode, status: 422, retryable: false });
}

export function assertIsolatedTransport(transport) {
  if (transport?.runtimeMode !== 'isolated' || typeof transport.request !== 'function' || typeof transport.respondPrivate !== 'function') {
    throw Object.assign(new Error('ISOLATED_TRANSPORT_REQUIRED'), { errorCode: 'ISOLATED_TRANSPORT_REQUIRED', status: 503, retryable: false });
  }
}

function validateTarget(platform, target, runtimeMode = 'isolated') {
  const direct = target?.kind === 'directMessage';
  const validScope = direct ? platform === 'discord' && target.guildId === null && identifier(target.recipientId) &&
    target.channelType === 1 && Array.isArray(target.recipientIds) && target.recipientIds.length === 1 && target.recipientIds[0] === target.recipientId :
    identifier(target?.guildId);
  requireValue(['isolated', 'production'].includes(runtimeMode) && ['discord', 'kook'].includes(platform) && target && target.platform === platform && target.runtimeMode === runtimeMode && target.enabled === true
    && identifier(target.id) && validScope && identifier(target.channelId) && identifier(target.transportKey), 'TARGET_INVALID');
}

function validateContext(context) {
  requireValue(context && identifier(context.attemptId) && identifier(context.operationKey)
    && Number.isSafeInteger(context.executionEpoch) && context.executionEpoch > 0
    && Number.isSafeInteger(context.timeoutMs) && context.timeoutMs > 0 && context.timeoutMs <= 120_000
    && typeof context.signal?.aborted === 'boolean' && typeof context.signal?.addEventListener === 'function'
    && typeof context.signal?.removeEventListener === 'function', 'DISPATCH_CONTEXT_INVALID');
}

function validateRef(platform, target, ref) {
  requireValue(ref && ref.platform === platform && ref.guildId === target.guildId && ref.channelId === target.channelId
    && identifier(ref.messageId), 'MESSAGE_REFERENCE_INVALID');
}

function validatePayload(platform, target, payload, expectedHash, edit = false) {
  requireValue(object(payload) && typeof expectedHash === 'string' && /^[a-f0-9]{64}$/.test(expectedHash), 'PAYLOAD_INVALID');
  let hash;
  try { hash = hashPayload(payload); } catch { requireValue(false, 'PAYLOAD_INVALID'); }
  requireValue(hash === expectedHash, 'PAYLOAD_HASH_MISMATCH');
  if (platform === 'discord') {
    requireValue(typeof payload.content === 'string' && Array.isArray(payload.embeds) && Array.isArray(payload.components)
      && object(payload.allowed_mentions), 'PAYLOAD_INVALID');
    if (edit) {
      const mentions = payload.allowed_mentions;
      requireValue(Array.isArray(mentions.parse) && mentions.parse.length === 0
        && (!mentions.roles || (Array.isArray(mentions.roles) && mentions.roles.length === 0))
        && (!mentions.users || (Array.isArray(mentions.users) && mentions.users.length === 0))
        && mentions.replied_user !== true && !/<@|@everyone|@here/.test(canonicalJson(payload)), 'EDIT_MENTION_FORBIDDEN');
    }
  } else {
    requireValue(payload.type === 10 && payload.target_id === target.channelId && typeof payload.content === 'string'
      && payload.temp_target_id === undefined, 'PAYLOAD_INVALID');
    let cards;
    try { cards = JSON.parse(payload.content); } catch { requireValue(false, 'PAYLOAD_INVALID'); }
    requireValue(Array.isArray(cards) && cards.length > 0 && cards.every(card => card?.type === 'card'), 'PAYLOAD_INVALID');
    if (edit) requireValue(!/\((?:met|rol)\)/i.test(payload.content), 'EDIT_MENTION_FORBIDDEN');
  }
}

// This is a wire projection, not an HTTP client. The injected transport owns any
// controlled execution. Nothing here obtains credentials or opens a connection.
export function buildNativeNotificationRequest({ platform, target, operation, payload = null, messageRef = null, runtimeMode = 'isolated' }) {
  validateTarget(platform, target, runtimeMode);
  requireValue(['send', 'edit', 'delete', 'lookup'].includes(operation), 'PLATFORM_OPERATION_INVALID');
  if (operation !== 'send') validateRef(platform, target, messageRef);
  if (platform === 'discord') {
    const base = `/api/v10/channels/${encodeURIComponent(target.channelId)}/messages`;
    return {
      method: { send: 'POST', edit: 'PATCH', delete: 'DELETE', lookup: 'GET' }[operation],
      path: operation === 'send' ? base : `${base}/${encodeURIComponent(messageRef.messageId)}`,
      body: ['send', 'edit'].includes(operation) ? safeCopy(payload) : null
    };
  }
  if (operation === 'send') return { method: 'POST', path: '/api/v3/message/create', body: safeCopy(payload) };
  if (operation === 'edit') return { method: 'POST', path: '/api/v3/message/update', body: { msg_id: messageRef.messageId, content: payload.content } };
  if (operation === 'delete') return { method: 'POST', path: '/api/v3/message/delete', body: { msg_id: messageRef.messageId } };
  return { method: 'GET', path: `/api/v3/message/view?msg_id=${encodeURIComponent(messageRef.messageId)}`, body: null };
}

// The returned Discord path contains a bearer interaction token and MUST remain
// in private request memory. Never include it in request diagnostics/evidence.
// The handler already ACKs type 5 with flags 64; PATCH retains that visibility.
export function buildNativePrivateResponseRequest({ platform, verifiedInteraction, payload }) {
  requireValue(['discord', 'kook'].includes(platform) && verifiedInteraction && identifier(verifiedInteraction.externalId)
    && identifier(verifiedInteraction.interactionId) && identifier(verifiedInteraction.channelId)
    && (!verifiedInteraction.provider || verifiedInteraction.provider === platform), 'PRIVATE_RESPONSE_INVALID');
  if (platform === 'discord') {
    const reply = verifiedInteraction.privateReplyContext;
    const mentions = payload?.allowed_mentions;
    requireValue(identifier(reply?.applicationId) && typeof reply.interactionToken === 'string' && reply.interactionToken.length > 0
      && reply.interactionToken.length <= 2000 && !/[\x00-\x20\x7f]/.test(reply.interactionToken)
      && object(payload) && Object.keys(payload).every(key => ['content', 'allowed_mentions', 'components', 'embeds', 'flags'].includes(key))
      && (payload.flags === undefined || payload.flags === 32768 && payload.content === '' && (!payload.embeds || payload.embeds.length === 0))
      && typeof payload.content === 'string' && payload.content.length <= 2000 && Array.isArray(payload.components)
      && validPrivateDiscordEmbeds(payload.embeds)
      && onlyKeys(mentions, ['parse', 'roles', 'users', 'replied_user'])
      && Array.isArray(mentions?.parse) && mentions.parse.length === 0
      && Array.isArray(mentions?.roles) && mentions.roles.length === 0
      && Array.isArray(mentions?.users) && mentions.users.length === 0 && mentions.replied_user === false, 'PRIVATE_RESPONSE_INVALID');
    const body = safeCopy(payload);
    if (body.flags === 32768) { delete body.content; delete body.embeds; }
    return { method: 'PATCH', path: `/api/v10/webhooks/${encodeURIComponent(reply.applicationId)}/${encodeURIComponent(reply.interactionToken)}/messages/@original`,
      body };
  }
  requireValue(payload?.type === 10 && payload.target_id === verifiedInteraction.channelId
    && payload.temp_target_id === verifiedInteraction.externalId && typeof payload.content === 'string', 'PRIVATE_RESPONSE_INVALID');
  let cards;
  try { cards = JSON.parse(payload.content); } catch { requireValue(false, 'PRIVATE_RESPONSE_INVALID'); }
  requireValue(Array.isArray(cards) && cards.length > 0 && cards.every(card => card?.type === 'card'), 'PRIVATE_RESPONSE_INVALID');
  return { method: 'POST', path: '/api/v3/message/create', body: safeCopy(payload) };
}

function responseHeaders(headers) {
  if (!object(headers)) return {};
  return Object.fromEntries(Object.entries(headers).filter(([, value]) => typeof value === 'string').map(([key, value]) => [key.toLowerCase(), value]));
}

function providerRequestId(response) {
  const value = responseHeaders(response?.headers)['x-request-id'];
  // Never carry response bodies, arbitrary error text or credential-bearing headers.
  return typeof value === 'string' && /^[a-zA-Z0-9:_-]{1,128}$/.test(value) ? value : null;
}

function unknown(errorCode, response) { return { outcome: 'unknown', errorCode, providerRequestId: providerRequestId(response) }; }
function notSent(errorCode, retryable = false, retryAfterMs = null) { return { outcome: 'not_sent', errorCode, retryable, retryAfterMs }; }
function notUpdated(result) { return { ...result, outcome: 'not_updated' }; }

function retryDelay(platform, response, now) {
  const headers = responseHeaders(response.headers);
  const values = [headers['retry-after'], platform === 'discord' ? response.body?.retry_after : headers['x-rate-limit-reset']];
  const delays = values.map(value => {
    if (typeof value === 'number' || (typeof value === 'string' && /^\d+(?:\.\d+)?$/.test(value))) {
      const seconds = Number(value);
      return Number.isFinite(seconds) && seconds >= 0 && seconds <= Number.MAX_SAFE_INTEGER / 1000 ? Math.ceil(seconds * 1000) : null;
    }
    if (typeof value === 'string' && /^[A-Za-z]{3}, /.test(value)) {
      const date = Date.parse(value);
      return Number.isFinite(date) ? Math.max(0, date - now()) : null;
    }
    return null;
  }).filter(value => value !== null);
  return delays.length ? Math.max(...delays) : null;
}

function classifyFailure(platform, response, now, editing) {
  if (!response || !Number.isInteger(response.status) || response.status < 100 || response.status > 599) return unknown('PROVIDER_RESPONSE_INVALID', response);
  if (response.status >= 500) return unknown('PROVIDER_SERVER_ERROR', response);
  const body = response.body;
  if (response.status === 429) {
    const rateLimited = object(body) && typeof body.message === 'string'
      && (platform === 'discord' ? (!identifier(body.id) && (body.retry_after === undefined || (typeof body.retry_after === 'number' && body.retry_after >= 0 && Number.isFinite(body.retry_after))))
        : (Number.isInteger(body.code) && body.code !== 0));
    if (!rateLimited) return unknown('PROVIDER_RESPONSE_INVALID', response);
    const result = notSent('PLATFORM_RATE_LIMITED', true, retryDelay(platform, response, now));
    return editing ? notUpdated(result) : result;
  }
  if (platform === 'discord' && object(body) && Number.isInteger(body.code) && typeof body.message === 'string'
    && [400, 401, 403, 404].includes(response.status) && knownDiscordRejections.has(body.code)) {
    if (editing && response.status === 404 && body.code === 10008) return { outcome: 'deleted', errorCode: 'PLATFORM_MESSAGE_DELETED' };
    const result = notSent(`DISCORD_REJECTED_${body.code}`);
    return editing ? notUpdated(result) : result;
  }
  if (response.status < 200 || response.status >= 300) return unknown('PROVIDER_RESPONSE_UNCONFIRMED', response);
  if (platform === 'kook' && (!object(body) || body.code !== 0)) return unknown('KOOK_RESULT_UNCONFIRMED', response);
  return null;
}

function verifiedMessageUrl(platform, raw, target, messageId) {
  // REST message responses ordinarily contain no URL. KOOK has no documented
  // message-link response field/format, so it deliberately stays null.
  if (platform !== 'discord' || target.kind === 'directMessage' || typeof raw !== 'string') return null;
  try {
    const url = new URL(raw);
    return url.protocol === 'https:' && url.hostname === 'discord.com' && !url.port && !url.username && !url.password
      && !url.search && !url.hash && url.pathname === `/channels/${target.guildId}/${target.channelId}/${messageId}` ? raw : null;
  } catch { return null; }
}

function messageReference(platform, target, response, expectedMessageId = null, lookup = false) {
  const data = platform === 'discord' ? response.body : response.body?.data;
  if (!object(data)) return null;
  const messageId = platform === 'discord' || lookup ? data.id : data.msg_id;
  if (!identifier(messageId) || (expectedMessageId !== null && expectedMessageId !== messageId)) return null;
  // Discord and KOOK view return channel_id. KOOK create does not: its msg_id
  // is bound to the validated target_id in this exact successful request.
  if ((platform === 'discord' || lookup) && data.channel_id !== target.channelId) return null;
  if ((data.channel_id !== undefined && data.channel_id !== target.channelId)
    || (data.guild_id !== undefined && data.guild_id !== target.guildId)) return null;
  return { platform, guildId: target.guildId, channelId: target.channelId, messageId,
    messageUrl: verifiedMessageUrl(platform, data.message_url, target, messageId) };
}

async function boundedRequest(transport, args) {
  const controller = new AbortController();
  const abortError = code => Object.assign(new Error(code), { transportCode: code });
  let rejectAbort;
  const aborted = new Promise((_, reject) => { rejectAbort = reject; });
  const stop = code => { controller.abort(); rejectAbort(abortError(code)); };
  const onAbort = () => stop('PLATFORM_ABORTED');
  if (args.context.signal.aborted) throw abortError('PLATFORM_ABORTED');
  args.context.signal.addEventListener('abort', onAbort, { once: true });
  const timer = setTimeout(() => stop('PLATFORM_TIMEOUT'), args.context.timeoutMs);
  try {
    // Both promises stay observed even when a non-cooperative transport resolves
    // late. A timeout is never retroactively promoted to sent.
    return await Promise.race([Promise.resolve().then(() => transport.request({ ...args,
      context: { ...args.context, signal: controller.signal } })), aborted]);
  } finally {
    clearTimeout(timer);
    args.context.signal.removeEventListener('abort', onAbort);
  }
}

export function createNotificationPlatforms({ transport, now = Date.now, runtimeMode = 'isolated' } = {}) {
  assertNotificationTransport(transport, runtimeMode);
  requireValue(typeof now === 'function', 'CLOCK_INVALID');
  function createAdapter(platform) {
    async function dispatch(operation, args = {}) {
      const editing = operation !== 'send';
      let target, payload, messageRef, dispatchContext;
      try {
        assertNotificationTransport(transport, runtimeMode);
        validateTarget(platform, args.target, runtimeMode);
        validateContext(args.context);
        if (editing) validateRef(platform, args.target, args.messageRef);
        if (operation !== 'delete') validatePayload(platform, args.target, args.payload, args.payloadHash, editing);
        target = safeCopy(args.target);
        payload = operation === 'delete' ? null : safeCopy(args.payload);
        messageRef = editing ? safeCopy(args.messageRef) : null;
        dispatchContext = { ...args.context };
      } catch (error) {
        const code = typeof error?.errorCode === 'string' ? error.errorCode : 'PAYLOAD_INVALID';
        return editing ? notUpdated(notSent(code)) : notSent(code);
      }
      let response;
      try { response = await boundedRequest(transport, { platform, target, operation, payload, messageRef, context: dispatchContext }); }
      catch (error) { return unknown(['PLATFORM_ABORTED', 'PLATFORM_TIMEOUT'].includes(error?.transportCode) ? error.transportCode : 'PLATFORM_TRANSPORT_ERROR'); }
      const failure = classifyFailure(platform, response, now, editing);
      if (failure) return failure;
      // A 202 acceptance is not a sent/updated receipt. Match the endpoint's
      // native success status instead of treating every 2xx as completion.
      const expectedStatus = platform === 'discord' && operation === 'delete' ? 204 : 200;
      if (response.status !== expectedStatus) return unknown('PROVIDER_RESPONSE_UNCONFIRMED', response);
      if (operation === 'delete') {
        if (platform === 'discord' ? !(response.body === null || (object(response.body) && Object.keys(response.body).length === 0))
          : !Array.isArray(response.body.data)) return unknown('PROVIDER_RESPONSE_INVALID', response);
        return { outcome: 'updated', providerRequestId: providerRequestId(response) };
      }
      if (operation === 'edit' && platform === 'kook') {
        // KOOK currently returns data: {} for a successful update; its API
        // example still shows data: []. Both carry no message reference.
        if (!Array.isArray(response.body.data) && !(object(response.body.data) && Object.keys(response.body.data).length === 0))
          return unknown('PROVIDER_RESPONSE_INVALID', response);
        return { outcome: 'updated', providerRequestId: providerRequestId(response) };
      }
      const ref = messageReference(platform, target, response, messageRef?.messageId ?? null);
      if (!ref) return unknown('MESSAGE_REFERENCE_UNCONFIRMED', response);
      return operation === 'send' ? { outcome: 'sent', messageRef: ref, providerRequestId: providerRequestId(response) }
        : { outcome: 'updated', providerRequestId: providerRequestId(response) };
    }
    return Object.freeze({
      send: args => dispatch('send', args),
      edit: args => dispatch('edit', args),
      remove: args => dispatch('delete', args),
      async lookup(args = {}) {
        let target, refs, dispatchContext;
        try {
          assertNotificationTransport(transport, runtimeMode);
          validateTarget(platform, args.target, runtimeMode);
          validateContext(args.context);
          requireValue(identifier(args.attemptId) && identifier(args.operationKey) && Array.isArray(args.messageRefs) && args.messageRefs.length <= 20, 'LOOKUP_INPUT_INVALID');
          for (const ref of args.messageRefs) validateRef(platform, args.target, ref);
          target = safeCopy(args.target);
          refs = safeCopy(args.messageRefs);
          dispatchContext = { ...args.context };
        } catch { return { outcome: 'unknown', errorCode: 'LOOKUP_INPUT_INVALID' }; }
        // Neither native API provides reliable absence by our attempt/operation
        // key. A recent-message scan or a deleted id cannot prove never sent.
        if (!refs.length) return { outcome: 'unknown', errorCode: 'LOOKUP_UNSUPPORTED' };
        let errorCode = 'LOOKUP_UNCONFIRMED';
        const startedAt = performance.now();
        for (const sourceRef of refs) {
          const remaining = Math.ceil(dispatchContext.timeoutMs - (performance.now() - startedAt));
          if (remaining <= 0) return { outcome: 'unknown', errorCode: 'PLATFORM_TIMEOUT' };
          let response;
          try {
            response = await boundedRequest(transport, { platform, target, operation: 'lookup', payload: null,
              messageRef: sourceRef, context: { ...dispatchContext, timeoutMs: remaining } });
          } catch (error) {
            return { outcome: 'unknown', errorCode: ['PLATFORM_ABORTED', 'PLATFORM_TIMEOUT'].includes(error?.transportCode) ? error.transportCode : 'PLATFORM_TRANSPORT_ERROR' };
          }
          const failure = classifyFailure(platform, response, now, false);
          if (failure) { errorCode = response?.status === 501 ? 'LOOKUP_UNSUPPORTED' : 'LOOKUP_UNCONFIRMED'; continue; }
          if (response.status !== 200) { errorCode = 'LOOKUP_UNCONFIRMED'; continue; }
          const ref = messageReference(platform, target, response, sourceRef.messageId, true);
          if (ref) return { outcome: 'found', messageRef: ref };
          errorCode = 'MESSAGE_REFERENCE_UNCONFIRMED';
        }
        return { outcome: 'unknown', errorCode };
      }
    });
  }
  return Object.freeze({ discord: createAdapter('discord'), kook: createAdapter('kook') });
}
