import test from 'node:test';
import assert from 'node:assert/strict';
import { canonicalJson, hashPayload } from '../server/v2/notification-platforms/canonical.js';
import { createNotificationPlatforms, buildNativeNotificationRequest, buildNativePrivateResponseRequest } from '../server/v2/notification-platforms/platforms.js';
import { createIsolatedNotificationTransport } from '../server/v2/notification-platforms/isolated-transport.js';

const now = () => Date.parse('2026-09-08T00:00:00.000Z');
function target(platform) {
  return { id: `${platform}-one`, platform, guildId: '100000000000000001', channelId: '200000000000000001',
    enabled: true, configurationRevision: 1, languages: ['en'], roleOptions: [], runtimeMode: 'isolated', transportKey: `fixture:${platform}` };
}
function payload(platform) {
  return platform === 'discord' ? { content: '', embeds: [{ title: 'Local wipe', description: 'Constructed data' }], components: [],
    allowed_mentions: { parse: [], roles: [], users: [], replied_user: false } }
    : { type: 10, target_id: target(platform).channelId,
      content: canonicalJson([{ type: 'card', theme: 'secondary', size: 'lg', modules: [{ type: 'header', text: { type: 'plain-text', content: 'Local wipe' } }] }]) };
}
function context(overrides = {}) {
  return { attemptId: 'attempt-1', executionEpoch: 1, operationKey: 'operation:1', timeoutMs: 1000, signal: new AbortController().signal, ...overrides };
}
function args(platform, overrides = {}) {
  const body = payload(platform);
  return { target: target(platform), payload: body, payloadHash: hashPayload(body), context: context(), ...overrides };
}
function lookupArgs(platform, refs = [], overrides = {}) {
  return { target: target(platform), attemptId: 'attempt-1', operationKey: 'operation:1', messageRefs: refs, context: context(), ...overrides };
}
function fixture(script = []) {
  const transport = createIsolatedNotificationTransport({ now, script });
  return { transport, platforms: createNotificationPlatforms({ transport, now }) };
}
function withResponse(response) {
  const calls = [];
  return { calls, runtimeMode: 'isolated', async request(input) { calls.push(input); return structuredClone(response); }, async respondPrivate() {} };
}

test('transport factory requires explicit isolated request and private responder, with no default network client', () => {
  for (const transport of [undefined, {}, { runtimeMode: 'network', request() {}, respondPrivate() {} },
    { runtimeMode: 'isolated', request() {} }, { runtimeMode: 'isolated', respondPrivate() {} }]) {
    assert.throws(() => createNotificationPlatforms({ transport }), error => error.errorCode === 'ISOLATED_TRANSPORT_REQUIRED' && error.status === 503);
  }
  const { transport } = fixture();
  assert.equal(transport.getCalls().length, 0);
});

for (const platform of ['discord', 'kook']) {
  test(`${platform}: native successful send stores exactly the hash-checked message payload`, async () => {
    const { platforms, transport } = fixture();
    const input = args(platform), before = canonicalJson(input.payload);
    const result = await platforms[platform].send(input);
    assert.equal(result.outcome, 'sent');
    assert.deepEqual(result.messageRef, { platform, guildId: input.target.guildId, channelId: input.target.channelId,
      messageId: transport.getMessages()[0].messageId, messageUrl: null });
    assert.equal(canonicalJson(transport.getMessages()[0].payload), before);
    assert.equal(hashPayload(transport.getMessages()[0].payload), input.payloadHash);
    assert.equal(canonicalJson(input.payload), before);
    assert.equal(result.providerRequestId, 'isolated-request-1');
  });

  test(`${platform}: edited original id is retained, remove does not send a replacement`, async () => {
    const { platforms, transport } = fixture();
    const adapter = platforms[platform], sent = await adapter.send(args(platform));
    const input = args(platform, { messageRef: sent.messageRef });
    const edit = await adapter.edit(input);
    assert.equal(edit.outcome, 'updated');
    assert.equal(transport.getMessages()[0].editCount, 1);
    assert.equal((await adapter.remove({ target: input.target, messageRef: sent.messageRef, context: context() })).outcome, 'updated');
    assert.equal(transport.getMessages().length, 1);
    assert.equal(transport.getMessages()[0].deleted, true);
    assert.deepEqual(transport.getCalls().map(call => call.operation), ['send', 'edit', 'delete']);
  });

  test(`${platform}: explicit 429 returns retryable not_sent with native delay and no stored message`, async () => {
    const { platforms, transport } = fixture([{ kind: 'rate_limit', retryAfterMs: 2375 }]);
    assert.deepEqual(await platforms[platform].send(args(platform)), { outcome: 'not_sent', errorCode: 'PLATFORM_RATE_LIMITED', retryable: true, retryAfterMs: 2375 });
    assert.equal(transport.getMessages().length, 0);
  });

  test(`${platform}: 5xx both before and after storing remain unknown`, async () => {
    for (const storeBeforeResponse of [false, true]) {
      const { platforms, transport } = fixture([{ kind: 'server_error', storeBeforeResponse }]);
      assert.equal((await platforms[platform].send(args(platform))).outcome, 'unknown');
      assert.equal(transport.getMessages().length, Number(storeBeforeResponse));
    }
  });

  test(`${platform}: successful storage with lost response remains unknown and is not silently retried`, async () => {
    const { platforms, transport } = fixture([{ kind: 'response_lost' }]);
    const result = await platforms[platform].send(args(platform));
    assert.deepEqual(result, { outcome: 'unknown', errorCode: 'PLATFORM_TRANSPORT_ERROR', providerRequestId: null });
    assert.equal(transport.getMessages().length, 1);
    assert.equal(transport.getCalls().length, 1);
    assert.equal((await platforms[platform].lookup(lookupArgs(platform))).errorCode, 'LOOKUP_UNSUPPORTED');
    assert.equal(transport.getCalls().length, 1);
  });

  test(`${platform}: a known message id can be found while missing or unsupported lookups never prove not_sent`, async () => {
    const { platforms, transport } = fixture();
    const sent = await platforms[platform].send(args(platform));
    assert.deepEqual(await platforms[platform].lookup(lookupArgs(platform, [sent.messageRef])), { outcome: 'found', messageRef: sent.messageRef });
    transport.enqueue({ operation: 'lookup', kind: 'lookup_unsupported' });
    assert.equal((await platforms[platform].lookup(lookupArgs(platform, [sent.messageRef]))).errorCode, 'LOOKUP_UNSUPPORTED');
    transport.deleteMessage(sent.messageRef);
    assert.equal((await platforms[platform].lookup(lookupArgs(platform, [sent.messageRef]))).outcome, 'unknown');
  });

  test(`${platform}: timeout and caller abort stay unknown even if the fixture stored the request`, async () => {
    const { platforms, transport } = fixture([{ kind: 'timeout', storeBeforeResponse: true }]);
    assert.equal((await platforms[platform].send(args(platform, { context: context({ timeoutMs: 15 }) }))).errorCode, 'PLATFORM_TIMEOUT');
    assert.equal(transport.getMessages().length, 1);
    const controller = new AbortController();
    controller.abort();
    const result = await platforms[platform].send(args(platform, { context: context({ signal: controller.signal }) }));
    assert.equal(result.outcome, 'unknown');
    assert.equal(result.errorCode, 'PLATFORM_ABORTED');
    assert.equal(transport.getCalls().length, 1);
  });

  test(`${platform}: malformed responses after successful storage remain unknown`, async () => {
    const { platforms, transport } = fixture([{ kind: 'malformed', storeBeforeResponse: true }]);
    assert.equal((await platforms[platform].send(args(platform))).outcome, 'unknown');
    assert.equal(transport.getMessages().length, 1);
  });

  test(`${platform}: input and payload hash errors cannot dispatch`, async () => {
    const { platforms, transport } = fixture();
    for (const input of [args(platform, { payloadHash: '0'.repeat(64) }), args(platform, { target: { ...target(platform), runtimeMode: 'production' } }),
      args(platform, { target: { ...target(platform), enabled: false } }), args(platform, { context: context({ timeoutMs: 0 }) })]) {
      assert.equal((await platforms[platform].send(input)).outcome, 'not_sent');
    }
    assert.equal(transport.getCalls().length, 0);
  });

  test(`${platform}: cross-target original references are rejected before edit, delete and lookup`, async () => {
    const { platforms, transport } = fixture();
    const { messageRef } = await platforms[platform].send(args(platform));
    const wrongRef = { ...messageRef, channelId: 'other-channel' };
    assert.equal((await platforms[platform].edit(args(platform, { messageRef: wrongRef }))).outcome, 'not_updated');
    assert.equal((await platforms[platform].remove({ target: target(platform), messageRef: wrongRef, context: context() })).outcome, 'not_updated');
    assert.equal((await platforms[platform].lookup(lookupArgs(platform, [wrongRef]))).errorCode, 'LOOKUP_INPUT_INVALID');
    assert.equal(transport.getCalls().length, 1);
  });

  test(`${platform}: edit never permits active mention payloads`, async () => {
    const { platforms, transport } = fixture();
    const sent = await platforms[platform].send(args(platform));
    const body = payload(platform);
    if (platform === 'discord') { body.content = '@everyone'; body.allowed_mentions.parse = ['everyone']; }
    else body.content = canonicalJson([{ type: 'card', modules: [{ type: 'section', text: { type: 'kmarkdown', content: '(met)all(met)' } }] }]);
    const result = await platforms[platform].edit(args(platform, { messageRef: sent.messageRef, payload: body, payloadHash: hashPayload(body) }));
    assert.equal(result.errorCode, 'EDIT_MENTION_FORBIDDEN');
    assert.equal(transport.getCalls().length, 1);
  });

  test(`${platform}: unknown edits preserve original message and never auto-send`, async () => {
    const { platforms, transport } = fixture();
    const { messageRef } = await platforms[platform].send(args(platform));
    transport.enqueue({ operation: 'edit', kind: 'response_lost' });
    const result = await platforms[platform].edit(args(platform, { messageRef }));
    assert.equal(result.outcome, 'unknown');
    assert.equal(transport.getMessages().length, 1);
    assert.equal(transport.getMessages()[0].editCount, 1);
    transport.enqueue({ operation: 'edit', kind: 'rate_limit' });
    assert.equal((await platforms[platform].edit(args(platform, { messageRef }))).outcome, 'not_updated');
  });
}

test('wire projection uses native Discord verbs and KOOK msg_id/content edit body', () => {
  for (const platform of ['discord', 'kook']) {
    const input = args(platform), messageRef = { platform, guildId: input.target.guildId, channelId: input.target.channelId, messageId: '300000000000000001', messageUrl: null };
    const send = buildNativeNotificationRequest({ platform, ...input, operation: 'send' });
    const edit = buildNativeNotificationRequest({ platform, ...input, messageRef, operation: 'edit' });
    const remove = buildNativeNotificationRequest({ platform, ...input, messageRef, operation: 'delete' });
    const lookup = buildNativeNotificationRequest({ platform, ...input, messageRef, operation: 'lookup' });
    assert.deepEqual(send.body, input.payload);
    assert.equal(send.method, 'POST');
    assert.equal(lookup.method, 'GET');
    if (platform === 'discord') {
      assert.equal(edit.method, 'PATCH'); assert.equal(remove.method, 'DELETE');
      assert.equal(remove.path, `/api/v10/channels/${input.target.channelId}/messages/${messageRef.messageId}`);
    } else {
      assert.deepEqual(edit, { method: 'POST', path: '/api/v3/message/update', body: { msg_id: messageRef.messageId, content: input.payload.content } });
      assert.deepEqual(remove.body, { msg_id: messageRef.messageId });
      assert.equal(lookup.path, `/api/v3/message/view?msg_id=${messageRef.messageId}`);
    }
  }
});

test('Discord success response requires explicit correct channel and rejects wrong message or guild', async () => {
  const input = args('discord');
  for (const body of [{ id: '30001' }, { id: '30001', channel_id: 'wrong' }, { id: '30001', channel_id: input.target.channelId, guild_id: 'wrong' }]) {
    const transport = withResponse({ status: 200, headers: {}, body });
    assert.equal((await createNotificationPlatforms({ transport }).discord.send(input)).outcome, 'unknown');
  }
  const transport = withResponse({ status: 200, headers: {}, body: { id: 'different', channel_id: input.target.channelId } });
  const result = await createNotificationPlatforms({ transport }).discord.edit({ ...input,
    messageRef: { platform: 'discord', guildId: input.target.guildId, channelId: input.target.channelId, messageId: 'expected', messageUrl: null } });
  assert.equal(result.outcome, 'unknown');
});

test('KOOK create success uses code zero and msg_id; incompatible shape or target mismatch stays unknown', async () => {
  for (const body of [{ code: 0, data: [] }, { code: 0, data: { id: 'not-create-id' } }, { code: 1, data: { msg_id: 'id' } },
    { code: 0, data: { msg_id: 'id', channel_id: 'other' } }]) {
    const transport = withResponse({ status: 200, headers: {}, body });
    assert.equal((await createNotificationPlatforms({ transport }).kook.send(args('kook'))).outcome, 'unknown');
  }
});

test('KOOK update accepts the live empty-object receipt and the documented empty array', async () => {
  const input=args('kook'), messageRef={platform:'kook',guildId:input.target.guildId,channelId:input.target.channelId,messageId:'expected',messageUrl:null};
  for (const data of [{},[]]) {
    const result=await createNotificationPlatforms({transport:withResponse({status:200,headers:{},body:{code:0,message:'操作成功',data}})}).kook.edit({...input,messageRef});
    assert.equal(result.outcome,'updated');
  }
  for (const data of [null,{msg_id:'different'},'ok']) {
    const result=await createNotificationPlatforms({transport:withResponse({status:200,headers:{},body:{code:0,message:'操作成功',data}})}).kook.edit({...input,messageRef});
    assert.equal(result.outcome,'unknown');
  }
});

test('only returned Discord URL with exact platform/guild/channel/message is retained; no URL is synthesized', async () => {
  const input = args('discord'), goodUrl = `https://discord.com/channels/${input.target.guildId}/${input.target.channelId}/30001`;
  for (const raw of [null, goodUrl, goodUrl.replace('discord.com', 'evil.example'), `${goodUrl}?token=secret`, goodUrl.replace('/30001', '/wrong')]) {
    const body = { id: '30001', channel_id: input.target.channelId, ...(raw ? { message_url: raw } : {}) };
    const result = await createNotificationPlatforms({ transport: withResponse({ status: 200, headers: {}, body }) }).discord.send(input);
    assert.equal(result.messageRef.messageUrl, raw === goodUrl ? goodUrl : null);
  }
});

test('deleted Discord card is explicit while KOOK unspecified 404 is conservatively unknown', async () => {
  for (const platform of ['discord', 'kook']) {
    const { platforms, transport } = fixture();
    const { messageRef } = await platforms[platform].send(args(platform));
    transport.deleteMessage(messageRef);
    assert.equal((await platforms[platform].edit(args(platform, { messageRef }))).outcome, platform === 'discord' ? 'deleted' : 'unknown');
    assert.equal((await platforms[platform].remove({ target: target(platform), messageRef, context: context() })).outcome, platform === 'discord' ? 'deleted' : 'unknown');
    assert.equal(transport.getMessages().length, 1);
  }
});

test('permission rejection is known not sent only for documented Discord API errors', async () => {
  const response = { status: 403, headers: {}, body: { code: 50013, message: 'sensitive provider explanation never exported' } };
  const result = await createNotificationPlatforms({ transport: withResponse(response) }).discord.send(args('discord'));
  assert.deepEqual(result, { outcome: 'not_sent', errorCode: 'DISCORD_REJECTED_50013', retryable: false, retryAfterMs: null });
  for (const body of ['forbidden', { message: 'reverse proxy error' }, { code: 999999, message: 'unknown' }]) {
    assert.equal((await createNotificationPlatforms({ transport: withResponse({ ...response, body }) }).discord.send(args('discord'))).outcome, 'unknown');
  }
});

test('malformed 429, generic 404 and all 5xx never prove non-delivery', async () => {
  for (const platform of ['discord', 'kook']) {
    for (const response of [{ status: 429, headers: {}, body: null }, { status: 404, headers: {}, body: {} },
      { status: 503, headers: {}, body: { code: 10008, message: 'Unknown Message' } }]) {
      assert.equal((await createNotificationPlatforms({ transport: withResponse(response) })[platform].send(args(platform))).outcome, 'unknown');
    }
  }
});

test('Retry-After parsing is case insensitive and prefers the longer native retry interval', async () => {
  const response = { status: 429, headers: { 'RETRY-AFTER': 'Tue, 08 Sep 2026 00:00:04 GMT' }, body: { message: 'rate limited', retry_after: 2.5 } };
  const result = await createNotificationPlatforms({ transport: withResponse(response), now }).discord.send(args('discord'));
  assert.equal(result.retryAfterMs, 4000);
});

test('transport exceptions and untrusted provider errors never leak raw tokens or headers', async () => {
  const secret = 'Bearer secret callback token';
  const transport = { runtimeMode: 'isolated', request: async () => { throw new Error(secret); }, respondPrivate: async () => {} };
  assert.equal(JSON.stringify(await createNotificationPlatforms({ transport }).discord.send(args('discord'))).includes(secret), false);
  const response = withResponse({ status: 503, headers: { 'x-request-id': secret, authorization: secret }, body: { message: secret } });
  const result = await createNotificationPlatforms({ transport: response }).discord.send(args('discord'));
  assert.equal(result.providerRequestId, null);
  assert.equal(JSON.stringify(result).includes(secret), false);
});

test('non-cooperative late transport is observed without promoting timeout or causing unhandled rejection', async () => {
  let complete;
  const pending = new Promise(resolve => { complete = resolve; });
  const transport = { runtimeMode: 'isolated', request: () => pending, respondPrivate: async () => {} };
  const result = await createNotificationPlatforms({ transport }).discord.send(args('discord', { context: context({ timeoutMs: 10 }) }));
  assert.equal(result.errorCode, 'PLATFORM_TIMEOUT');
  complete({ status: 200, headers: {}, body: { id: '30001', channel_id: target('discord').channelId } });
  await Promise.resolve();
  assert.equal(result.outcome, 'unknown');
});

test('fault scenarios are target-scoped and fake sends are deliberately not deduplicated by operation key', async () => {
  const { platforms, transport } = fixture([{ kind: 'rate_limit', targetId: 'kook-one' }]);
  assert.equal((await platforms.discord.send(args('discord'))).outcome, 'sent');
  assert.equal((await platforms.kook.send(args('kook'))).outcome, 'not_sent');
  assert.equal((await platforms.discord.send(args('discord'))).outcome, 'sent');
  assert.equal(transport.getMessages().length, 2);
  assert.notEqual(transport.getMessages()[0].messageId, transport.getMessages()[1].messageId);
});

test('private callback substitute keeps context tokens out of diagnostics and tracks late private response loss', async () => {
  const { transport } = fixture([{ operation: 'private', kind: 'response_lost' }]);
  const input = { platform: 'discord', verifiedInteraction: { externalId: 'actor', interactionId: 'interaction', channelId: 'channel',
    privateReplyContext: { applicationId: 'app', interactionToken: 'secret-provider' } },
    payload: { content: 'private confirmation', allowed_mentions: { parse: [], roles: [], users: [], replied_user: false },
      components: [{ type: 1, components: [{ type: 2, custom_id: 'secret-context', style: 1, label: 'Confirm' }] }] }, signal: new AbortController().signal };
  await assert.rejects(() => transport.respondPrivate(input), /ISOLATED_RESPONSE_LOST/);
  assert.equal(transport.getPrivateReplies().length, 1);
  assert.equal(transport.inspect().privateReplyCount, 1);
  assert.equal(JSON.stringify(transport.inspect()).includes('secret'), false);
});

test('native accepted-only 202 and contradictory rate limits never become sent or not_sent', async () => {
  for (const platform of ['discord', 'kook']) {
    const body = platform === 'discord' ? { id: '30001', channel_id: target(platform).channelId }
      : { code: 0, message: 'success', data: { msg_id: '30001' } };
    const result = await createNotificationPlatforms({ transport: withResponse({ status: 202, headers: {}, body }) })[platform].send(args(platform));
    assert.equal(result.outcome, 'unknown');
    assert.equal((await createNotificationPlatforms({ transport: withResponse({ status: 429, headers: {}, body: { ...body, message: 'contradictory' } }) })[platform].send(args(platform))).outcome, 'unknown');
  }
});

test('native private responder rejects publicly addressed KOOK payload and unsupported Discord attachment fields', async () => {
  const { transport } = fixture();
  for (const platform of ['discord', 'kook']) {
    const verifiedInteraction = { externalId: 'actor', interactionId: 'interaction', channelId: target(platform).channelId,
      privateReplyContext: { applicationId: 'app', interactionToken: 'secret' } };
    await assert.rejects(() => transport.respondPrivate({ platform, verifiedInteraction, payload: platform === 'discord' ? {...payload(platform), attachments: []} : payload(platform) }), /ISOLATED_PRIVATE_INVALID/);
  }
  const verifiedInteraction = { externalId: 'actor', interactionId: 'interaction', channelId: target('kook').channelId };
  await transport.respondPrivate({ platform: 'kook', verifiedInteraction, payload: { ...payload('kook'), temp_target_id: 'actor' } });
  assert.equal(transport.inspect().privateReplyCount, 1);
});

test('private wire projects Discord original-response PATCH without flags and KOOK temporary create', () => {
  const verifiedInteraction = { externalId: 'actor', interactionId: 'interaction', channelId: 'channel',
    privateReplyContext: { applicationId: 'app', interactionToken: 'private-fixture-token' } };
  const discordPayload = { content: 'processing', allowed_mentions: { parse: [], roles: [], users: [], replied_user: false }, components: [] };
  const wire = buildNativePrivateResponseRequest({ platform: 'discord', verifiedInteraction, payload: discordPayload });
  assert.equal(wire.method, 'PATCH');
  assert.equal(wire.path, '/api/v10/webhooks/app/private-fixture-token/messages/@original');
  assert.equal(Object.hasOwn(wire.body, 'flags'), false);
  for (const flags of [0, 64]) assert.throws(() => buildNativePrivateResponseRequest({ platform: 'discord', verifiedInteraction, payload: { ...discordPayload, flags } }), /PRIVATE_RESPONSE_INVALID/);
  const kookPayload = { ...payload('kook'), target_id: 'channel', temp_target_id: 'actor' };
  assert.deepEqual(buildNativePrivateResponseRequest({ platform: 'kook', verifiedInteraction, payload: kookPayload }),
    { method: 'POST', path: '/api/v3/message/create', body: kookPayload });
});

test('remove requires explicit native completion status; KOOK 202 is unknown', async () => {
  for (const platform of ['discord', 'kook']) {
    const messageRef = { platform, guildId: target(platform).guildId, channelId: target(platform).channelId, messageId: '30001', messageUrl: null };
    const response = { status: 202, headers: {}, body: platform === 'discord' ? {} : { code: 0, message: 'accepted', data: [] } };
    const result = await createNotificationPlatforms({ transport: withResponse(response) })[platform].remove({ target: target(platform), messageRef, context: context() });
    assert.equal(result.outcome, 'unknown');
  }
});

test('mutating isolated runtime or request inputs after validation cannot change dispatch ownership', async () => {
  const response = { status: 200, headers: {}, body: { id: '30001', channel_id: target('discord').channelId } };
  const transport = withResponse(response), adapter = createNotificationPlatforms({ transport }).discord;
  const input = args('discord');
  const promise = adapter.send(input);
  input.target.channelId = 'changed'; input.context.operationKey = 'changed'; input.payload.embeds[0].title = 'changed';
  assert.equal((await promise).outcome, 'sent');
  assert.equal(transport.calls[0].context.operationKey, 'operation:1');
  assert.equal(transport.calls[0].target.channelId, target('discord').channelId);
  assert.equal(transport.calls[0].payload.embeds[0].title, 'Local wipe');
  transport.runtimeMode = 'production';
  assert.equal((await adapter.send(args('discord'))).errorCode, 'ISOLATED_TRANSPORT_REQUIRED');
  assert.equal(transport.calls.length, 1);
});

test('every adapter operation rejects non-native 202 and 206 despite valid-looking response bodies', async () => {
  for (const platform of ['discord', 'kook']) {
    const messageRef = { platform, guildId: target(platform).guildId, channelId: target(platform).channelId, messageId: '30001', messageUrl: null };
    for (const status of [202, 206]) {
      for (const operation of ['send', 'edit', 'remove', 'lookup']) {
        const body = platform === 'discord' ? operation === 'remove' ? {} : { id: '30001', channel_id: target(platform).channelId }
          : { code: 0, message: 'success', data: operation === 'send' ? { msg_id: '30001' }
            : operation === 'lookup' ? { id: '30001', channel_id: target(platform).channelId } : [] };
        const adapter = createNotificationPlatforms({ transport: withResponse({ status, headers: {}, body }) })[platform];
        const input = operation === 'lookup' ? lookupArgs(platform, [messageRef]) : args(platform, { messageRef });
        assert.equal((await adapter[operation](input)).outcome, 'unknown', `${platform}/${operation}/${status}`);
      }
    }
  }
});
