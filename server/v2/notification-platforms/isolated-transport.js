import { buildNativeNotificationRequest, buildNativePrivateResponseRequest } from './platforms.js';

const clone = value => structuredClone(value);
const keyFor = (platform, target, messageId) => JSON.stringify([platform, target.guildId, target.channelId, messageId]);
const faultKinds = new Set(['success', 'response_lost', 'rate_limit', 'server_error', 'malformed', 'timeout', 'lookup_unsupported', 'response']);

/**
 * In-memory native-protocol substitute. All state and scenarios are explicit;
 * it does not deduplicate sends or pretend an operation key is a provider nonce.
 * Default lookup supports an exact message id only, never absence by attempt.
 */
export function createIsolatedNotificationTransport({ now = Date.now, script = [] } = {}) {
  if (typeof now !== 'function' || !Array.isArray(script)) throw new TypeError('ISOLATED_FIXTURE_INVALID');
  const messages = new Map(), scenarios = [], calls = [], privateReplies = [];
  let sequence = 0;

  function enqueue(scenario) {
    if (!scenario || !faultKinds.has(scenario.kind) || (scenario.operation && !['send', 'edit', 'delete', 'lookup', 'private'].includes(scenario.operation))
      || (scenario.platform && !['discord', 'kook'].includes(scenario.platform))) throw new TypeError('ISOLATED_SCENARIO_INVALID');
    scenarios.push(clone(scenario));
  }
  script.forEach(enqueue);

  function takeScenario(platform, operation, targetId) {
    const index = scenarios.findIndex(item => (!item.platform || item.platform === platform) && (!item.operation || item.operation === operation)
      && (!item.targetId || item.targetId === targetId));
    return index < 0 ? { kind: 'success' } : scenarios.splice(index, 1)[0];
  }

  function nativeMessage(message) {
    if (message.platform === 'discord') return { id: message.messageId, channel_id: message.channelId, guild_id: message.guildId,
      ...clone(message.payload) };
    return { id: message.messageId, channel_id: message.channelId, type: 10, content: message.payload.content };
  }

  function nativeSuccess(platform, operation, message, headers) {
    if (platform === 'discord') return operation === 'delete'
      ? { status: 204, headers, body: {} }
      : { status: 200, headers, body: nativeMessage(message) };
    return { status: 200, headers, body: { code: 0, message: 'success', data: operation === 'send'
      ? { msg_id: message.messageId, msg_timestamp: message.createdAt, nonce: message.payload.nonce ?? '' }
      : operation === 'lookup' ? nativeMessage(message) : [] } };
  }

  function nativeMissing(platform, headers) {
    // KOOK public docs do not specify a message-specific missing error code.
    // Do not invent one: the adapter must preserve this KOOK response as unknown.
    return { status: 404, headers, body: platform === 'discord' ? { code: 10008, message: 'Unknown Message' }
      : { code: -1, message: 'fixture: message unavailable; native error code unverified', data: [] } };
  }

  function applyOperation({ platform, target, operation, payload, messageRef, context }, headers) {
    if (operation === 'send') {
      sequence += 1;
      const messageId = platform === 'discord' ? String(900000000000000000n + BigInt(sequence)) : `isolated-${String(sequence).padStart(6, '0')}`;
      const message = { platform, guildId: target.guildId, channelId: target.channelId, targetId: target.id, messageId,
        payload: clone(payload), attemptId: context.attemptId, operationKey: context.operationKey,
        createdAt: now(), updatedAt: now(), deleted: false, editCount: 0 };
      messages.set(keyFor(platform, target, messageId), message);
      return nativeSuccess(platform, operation, message, headers);
    }
    const message = messages.get(keyFor(platform, target, messageRef.messageId));
    if (!message || message.deleted) return nativeMissing(platform, headers);
    if (operation === 'edit') { message.payload = clone(payload); message.updatedAt = now(); message.editCount += 1; }
    if (operation === 'delete') { message.deleted = true; message.updatedAt = now(); }
    return nativeSuccess(platform, operation, message, headers);
  }

  async function delay(ms, signal) {
    if (signal?.aborted) throw new Error('ISOLATED_ABORTED');
    await new Promise((resolve, reject) => {
      const done = () => { signal?.removeEventListener('abort', abort); resolve(); };
      const timer = setTimeout(done, ms);
      const abort = () => { clearTimeout(timer); signal?.removeEventListener('abort', abort); reject(new Error('ISOLATED_ABORTED')); };
      signal?.addEventListener('abort', abort, { once: true });
    });
  }

  async function request(args) {
    const { platform, target, operation, messageRef, context } = args;
    if (context.signal.aborted) throw new Error('ISOLATED_ABORTED');
    const wire = buildNativeNotificationRequest(args);
    const scenario = takeScenario(platform, operation, target.id);
    const requestId = `isolated-request-${calls.length + 1}`;
    const headers = { 'x-request-id': requestId };
    calls.push({ platform, targetId: target.id, operation, messageId: messageRef?.messageId ?? null,
      attemptId: context.attemptId, operationKey: context.operationKey, executionEpoch: context.executionEpoch,
      method: wire.method, path: wire.path, scenario: scenario.kind });
    if (scenario.delayMs) await delay(scenario.delayMs, context.signal);
    if (scenario.kind === 'response') return clone(scenario.response);
    if (scenario.kind === 'lookup_unsupported') return { status: 501, headers, body: { message: 'LOOKUP_UNSUPPORTED' } };
    if (scenario.kind === 'rate_limit') {
      const seconds = (scenario.retryAfterMs ?? 1250) / 1000;
      return platform === 'discord'
        ? { status: 429, headers: { ...headers, 'Retry-After': String(seconds) }, body: { message: 'Rate limited', retry_after: seconds, global: false } }
        : { status: 429, headers: { ...headers, 'X-Rate-Limit-Reset': String(seconds) }, body: { code: 429, message: 'Rate limited', data: [] } };
    }
    if (scenario.kind === 'server_error') {
      if (scenario.storeBeforeResponse) applyOperation(args, headers);
      return { status: scenario.status ?? 503, headers, body: { message: 'ISOLATED_SERVER_FAILURE' } };
    }
    if (scenario.kind === 'malformed') {
      if (scenario.storeBeforeResponse) applyOperation(args, headers);
      return { status: 200, headers, body: { malformed: true } };
    }
    if (scenario.kind === 'timeout') {
      if (scenario.storeBeforeResponse) applyOperation(args, headers);
      await delay(context.timeoutMs + 50, context.signal);
      throw new Error('ISOLATED_TIMEOUT');
    }
    const result = applyOperation(args, headers);
    if (scenario.kind === 'response_lost') throw new Error('ISOLATED_RESPONSE_LOST');
    return result;
  }

  async function respondPrivate({ platform, verifiedInteraction, payload, signal }) {
    if (!['discord', 'kook'].includes(platform) || !verifiedInteraction || signal?.aborted) throw new Error('ISOLATED_PRIVATE_INVALID');
    try { buildNativePrivateResponseRequest({ platform, verifiedInteraction, payload }); }
    catch { throw new Error('ISOLATED_PRIVATE_INVALID'); }
    const scenario = takeScenario(platform, 'private', null);
    if (scenario.delayMs) await delay(scenario.delayMs, signal);
    if (['rate_limit', 'server_error', 'malformed', 'timeout'].includes(scenario.kind)) throw new Error('ISOLATED_PRIVATE_FAILURE');
    // The transport fixture keeps private payloads only in memory for callback
    // assertions. inspect() never exports them or privateReplyContext tokens.
    privateReplies.push({ platform, externalId: verifiedInteraction.externalId, interactionId: verifiedInteraction.interactionId, payload: clone(payload) });
    if (scenario.kind === 'response_lost') throw new Error('ISOLATED_RESPONSE_LOST');
  }

  return Object.freeze({
    runtimeMode: 'isolated', request, respondPrivate, enqueue,
    getMessages: () => clone([...messages.values()]),
    getCalls: () => clone(calls),
    getPrivateReplies: () => clone(privateReplies),
    inspect: () => ({ messages: clone([...messages.values()]), calls: clone(calls), privateReplyCount: privateReplies.length, pendingScenarios: scenarios.length }),
    deleteMessage(ref) {
      const message = messages.get(keyFor(ref.platform, ref, ref.messageId));
      if (!message) return false;
      message.deleted = true;
      message.updatedAt = now();
      return true;
    }
  });
}
