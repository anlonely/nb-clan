import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, sign } from 'node:crypto';
import { createNotificationPlatforms } from '../server/v2/notification-platforms/platforms.js';
import { createNotificationCallbackHandler } from '../server/v2/notification-platforms/callbacks.js';
import { createDiscordVerifier, createKookVerifier } from '../server/v2/notification-platforms/verifiers.js';
import { assertNotificationOrigin } from '../server/v2/notification-platforms/runtime-mode.js';
import { hashPayload } from '../server/v2/notification-platforms/canonical.js';
import { createProductionNotificationTransport } from '../server/v2/production/notification-transport.js';
import { createProductionNotificationOwner } from '../server/v2/production/notifications.js';
import { normalizeConfig } from '../server/v2/platform-admin/model.js';
import { SERVER_CONNECT_COMMAND_ID, serverConnectTargetId } from '../server/v2/platform-admin/server-connect-card.js';
import { ELECTRICIAN_COMMAND_ID, electricianTargetId } from '../server/v2/platform-admin/electrician-card.js';
import { WELCOME_GUIDE_COMMAND_ID, welcomeGuideTargetId } from '../server/v2/platform-admin/welcome-guide-card.js';
import { createFixture } from './support/v2-notifications/fixture.js';

const code = expected => error => error.errorCode === expected;
const response = (body, status = 200, headers = {}) => new Response(body === null ? null : JSON.stringify(body), { status, headers });
const target = platform => ({ id: `${platform}-one`, platform, guildId: 'guild-1', channelId: 'channel-1', enabled: true,
  configurationRevision: 1, runtimeMode: 'production', transportKey: `production:${platform}:one` });
const payload = platform => platform === 'discord' ? { content: 'Local fixture', embeds: [], components: [],
  allowed_mentions: { parse: [], roles: [], users: [], replied_user: false } } : {
  type: 10, target_id: 'channel-1', content: '[{"type":"card","modules":[]}]' };
const args = (platform, overrides = {}) => ({ target: target(platform), payload: payload(platform), payloadHash: hashPayload(payload(platform)),
  context: { attemptId: 'attempt-1', operationKey: 'operation-1', executionEpoch: 1, timeoutMs: 1000, signal: new AbortController().signal }, ...overrides });
const credentials = () => ({ botToken: 'constructed-secret' });

test('production notification targets default Discord to English and preserve KOOK Chinese for every native card slot', async t => {
  const f = createFixture({ adminRole: true }); t.after(() => f.close());
  const ids = [SERVER_CONNECT_COMMAND_ID, ELECTRICIAN_COMMAND_ID, WELCOME_GUIDE_COMMAND_ID];
  const configs = Object.fromEntries(['discord', 'kook'].map(platform => [platform, {
    enabled: true, revision: 1,
    commands: [...ids.map(id => ({ id, type: 'persistent_card', enabled: true })),
      { id: platform === 'discord' ? 'wipe' : 'signup_card', type: platform === 'discord' ? 'event_command' : 'persistent_card', enabled: true }],
    targets: [{ id: platform, guildId: `${platform}-guild`, channelId: `${platform}-general`,
      serverConnectChannelId: `${platform}-connect`, electricianChannelId: `${platform}-electricians`,
      welcomeGuideChannelId: `${platform}-guide`, signupCardChannelId: `${platform}-signup`,
      enabled: true, enabledCommandIds: [...ids, platform === 'discord' ? 'wipe' : 'signup_card'] }],
  }]));
  const owner = createProductionNotificationOwner({ getIdentity: async () => f.identity,
    getPlatformService: () => ({ identity: f.identity, config: platform => configs[platform] }),
    publicOrigin: 'https://nb.example', readCredentials: credentials });
  t.after(() => owner.stop());
  const targets = owner.catalog.listTargets();
  assert.equal(targets.length, 10);
  for (const item of targets) {
    assert.equal(item.languages[0], item.platform === 'discord' ? 'en' : 'zh-CN');
    assert.deepEqual(new Set(item.languages), new Set(['zh-CN', 'en', 'ru', 'tr', 'th', 'ko']));
  }
});

test('KOOK signup card keeps its own channel apart from general notifications', () => {
  const config = normalizeConfig('kook', { enabled: true,
    targets: [{ id: 'server', name: '测试服务器', guildId: 'guild', channelId: 'general', signupCardChannelId: 'signup',
      enabled: true, enabledCommandIds: ['signup_card'] }],
    commands: [{ id: 'signup_card', name: '报名卡片', type: 'persistent_card', enabled: true, titleTemplate: '', bodyTemplate: '' }] });
  assert.equal(config.targets[0].channelId, 'general');
  assert.equal(config.targets[0].signupCardChannelId, 'signup');
  assert.deepEqual(config.targets[0].enabledCommandIds, ['signup_card']);
});

test('KOOK server connect card appears only for enabled command with dedicated channel', async t => {
  const f = createFixture({ adminRole: true }); t.after(() => f.close());
  const config = { enabled: true, revision: 1, commands: [{ id: SERVER_CONNECT_COMMAND_ID, type: 'persistent_card', enabled: true }], targets: [{ id: 'server', name: 'RSG', guildId: 'guild', channelId: 'general', serverConnectChannelId: 'connect', enabled: true, enabledCommandIds: [SERVER_CONNECT_COMMAND_ID] }] };
  const owner = createProductionNotificationOwner({ getIdentity: async () => f.identity, getPlatformService: () => ({ identity: f.identity, config: platform => platform === 'kook' ? config : { enabled: false, revision: 1, commands: [], targets: [] } }), publicOrigin: 'https://nb.example', readCredentials: credentials });
  t.after(() => owner.stop());
  assert.equal(owner.catalog.getTarget(serverConnectTargetId('server')).channelId, 'connect');
  config.commands[0].enabled = false;
  assert.equal(owner.catalog.getTarget(serverConnectTargetId('server')), null);
});

test('KOOK electrician card uses its configured channel only while enabled', async t => {
  const f = createFixture({ adminRole: true }); t.after(() => f.close());
  const config = { enabled: true, revision: 1, commands: [{ id: ELECTRICIAN_COMMAND_ID, type: 'persistent_card', enabled: true }],
    targets: [{ id: 'server', name: 'RSG', guildId: 'guild', channelId: 'general', electricianChannelId: 'electrician-channel', enabled: true, enabledCommandIds: [ELECTRICIAN_COMMAND_ID] }] };
  const owner = createProductionNotificationOwner({ getIdentity: async () => f.identity, getPlatformService: () => ({ identity: f.identity, config: platform => platform === 'kook' ? config : { enabled: false, revision: 1, commands: [], targets: [] } }), publicOrigin: 'https://nb.example', readCredentials: credentials });
  t.after(() => owner.stop());
  assert.equal(owner.catalog.getTarget(electricianTargetId('server')).channelId, 'electrician-channel');
  config.commands[0].enabled = false;
  assert.equal(owner.catalog.getTarget(electricianTargetId('server')), null);
});

test('Discord and KOOK electrician catalog slots retain platform identity and exact configured channel', async t => {
  const f = createFixture({ adminRole: true }); t.after(() => f.close());
  const configs = Object.fromEntries(['discord', 'kook'].map(platform => [platform, { enabled: true, revision: 1,
    commands: [{ id: ELECTRICIAN_COMMAND_ID, type: 'persistent_card', enabled: true }],
    targets: [{ id: 'same-server', name: 'RSG', guildId: `${platform}-guild`, channelId: '',
      electricianChannelId: `${platform}-electricians`, enabled: true, enabledCommandIds: [ELECTRICIAN_COMMAND_ID] }] }]));
  const owner = createProductionNotificationOwner({ getIdentity: async () => f.identity,
    getPlatformService: () => ({ identity: f.identity, config: platform => configs[platform] }),
    publicOrigin: 'https://nb.example', readCredentials: credentials });
  t.after(() => owner.stop());
  for (const platform of ['discord', 'kook']) {
    const id = electricianTargetId('same-server', platform), item = owner.catalog.getTarget(id);
    assert.equal(item.platform, platform);
    assert.equal(item.guildId, `${platform}-guild`);
    assert.equal(item.channelId, `${platform}-electricians`);
    assert.equal(item.transportKey, `production:${platform}:${id}`);
  }
  configs.discord.commands[0].enabled = false;
  assert.equal(owner.catalog.getTarget(electricianTargetId('same-server', 'discord')), null);
  assert.ok(owner.catalog.getTarget(electricianTargetId('same-server', 'kook')));
  configs.kook.targets[0].enabledCommandIds = [];
  assert.equal(owner.catalog.getTarget(electricianTargetId('same-server')), null);
});

test('KOOK announcement guide uses the dedicated announcement channel', async t => {
  const f = createFixture({ adminRole: true }); t.after(() => f.close());
  const config = { enabled: true, revision: 1, commands: [{ id: WELCOME_GUIDE_COMMAND_ID, type: 'persistent_card', enabled: true }],
    targets: [{ id: 'server', name: 'RSG', guildId: '8900601550851301', channelId: '6359280321479117', welcomeGuideChannelId: '9822515775347106', enabled: true, enabledCommandIds: [WELCOME_GUIDE_COMMAND_ID] }] };
  const owner = createProductionNotificationOwner({ getIdentity: async () => f.identity, getPlatformService: () => ({ identity: f.identity, config: platform => platform === 'kook' ? config : { enabled: false, revision: 1, commands: [], targets: [] } }), publicOrigin: 'https://nb.example', readCredentials: credentials });
  t.after(() => owner.stop());
  assert.equal(owner.catalog.getTarget(welcomeGuideTargetId('server')).channelId, '9822515775347106');
  config.commands[0].enabled = false;
  assert.equal(owner.catalog.getTarget(welcomeGuideTargetId('server')), null);
});

test('Discord English guide and direct connect use their own configured channels', async t => {
  const f = createFixture({ adminRole: true }); t.after(() => f.close());
  const config = { enabled: true, revision: 1, commands: [
    { id: WELCOME_GUIDE_COMMAND_ID, type: 'persistent_card', enabled: true },
    { id: SERVER_CONNECT_COMMAND_ID, type: 'persistent_card', enabled: true },
  ], targets: [{ id: 'server', name: 'RSG', guildId: '1153571748147634236', channelId: 'general',
    welcomeGuideChannelId: '1482399564274204774', serverConnectChannelId: '1482399564274204775',
    enabled: true, enabledCommandIds: [WELCOME_GUIDE_COMMAND_ID, SERVER_CONNECT_COMMAND_ID] }] };
  const owner = createProductionNotificationOwner({ getIdentity: async () => f.identity,
    getPlatformService: () => ({ identity: f.identity, config: platform => platform === 'discord' ? config : { enabled: false, revision: 1, commands: [], targets: [] } }),
    publicOrigin: 'https://nb.example', readCredentials: credentials });
  t.after(() => owner.stop());
  assert.equal(owner.catalog.getTarget(welcomeGuideTargetId('server', 'discord')).channelId, '1482399564274204774');
  assert.equal(owner.catalog.getTarget(serverConnectTargetId('server', 'discord')).channelId, '1482399564274204775');
  config.commands[0].enabled = false;
  assert.equal(owner.catalog.getTarget(welcomeGuideTargetId('server', 'discord')), null);
  assert.equal(owner.catalog.getTarget(serverConnectTargetId('server', 'discord')).channelId, '1482399564274204775');
});

test('production is explicit; default isolated transport, origins and targets remain fenced', async () => {
  let calls = 0;
  const transport = createProductionNotificationTransport({ readCredentials: credentials, fetchImpl: async () => { calls++; return response({}); } });
  assert.throws(() => createNotificationPlatforms({ transport }), code('ISOLATED_TRANSPORT_REQUIRED'));
  for (const url of ['http://nb.example', 'https://nb.example/path', 'https://user:secret@nb.example', 'https://localhost']) {
    assert.throws(() => assertNotificationOrigin(url, 'production'));
  }
  assertNotificationOrigin('https://nb.example', 'production');
  assert.throws(() => assertNotificationOrigin('https://nb.example'), code('ISOLATED_TRANSPORT_REQUIRED'));
  const platforms = createNotificationPlatforms({ transport, runtimeMode: 'production' });
  const input = args('discord'); input.target.runtimeMode = 'isolated';
  assert.equal((await platforms.discord.send(input)).outcome, 'not_sent');
  assert.equal(calls, 0);
});

test('production REST uses fixed endpoints and no redirects/retries; original success/429/unknown classification is retained', async () => {
  const calls = [], replies = [response({ id: 'message-1', channel_id: 'channel-1', guild_id: 'guild-1' }),
    response({ code: 0, data: { msg_id: 'kook-message-1' } }), response({ message: 'Rate limited', retry_after: 2 }, 429),
    response({ message: 'uncertain' }, 503)];
  const transport = createProductionNotificationTransport({ readCredentials: credentials, fetchImpl: async (url, options) => {
    calls.push({ url, options }); return replies.shift();
  } });
  const platforms = createNotificationPlatforms({ transport, runtimeMode: 'production' });
  assert.equal((await platforms.discord.send(args('discord'))).outcome, 'sent');
  assert.equal((await platforms.kook.send(args('kook'))).outcome, 'sent');
  const limited = await platforms.discord.send(args('discord'));
  assert.equal(limited.outcome, 'not_sent'); assert.equal(limited.retryAfterMs, 2000); assert.equal(limited.retryable, true);
  assert.equal((await platforms.kook.send(args('kook'))).outcome, 'unknown');
  assert.deepEqual(calls.map(call => call.url), ['https://discord.com/api/v10/channels/channel-1/messages',
    'https://www.kookapp.cn/api/v3/message/create', 'https://discord.com/api/v10/channels/channel-1/messages',
    'https://www.kookapp.cn/api/v3/message/create']);
  for (const { options } of calls) { assert.equal(options.redirect, 'error'); assert.equal(options.headers.authorization, 'Bot constructed-secret'); }
});

test('production cancellation, lost responses, redirects and excessive bodies remain unknown with sanitized errors', async () => {
  const controller = new AbortController(); let calls = 0;
  const transport = createProductionNotificationTransport({ readCredentials: credentials, maxResponseBytes: 128,
    fetchImpl: async (_url, options) => {
      calls++;
      if (calls === 1) { controller.abort(); throw new Error('secret URL must not escape'); }
      if (calls === 2) throw new Error('https://discord.com/private-secret');
      if (calls === 3) return response({ content: 'x'.repeat(500) });
      return { redirected: true, url: 'https://elsewhere.example', body: null };
    } });
  const platform = createNotificationPlatforms({ transport, runtimeMode: 'production' }).discord;
  const input = args('discord'); input.context.signal = controller.signal;
  const aborted = await platform.send(input);
  assert.equal(aborted.outcome, 'unknown'); assert.equal(aborted.errorCode, 'PLATFORM_ABORTED');
  for (let i = 0; i < 3; i++) {
    const result = await platform.send(args('discord'));
    assert.equal(result.outcome, 'unknown'); assert.ok(!JSON.stringify(result).includes('secret'));
  }
  assert.equal(calls, 4);
  const slow = createProductionNotificationTransport({ readCredentials: credentials, fetchImpl: (_url, options) => new Promise((_resolve, reject) => {
    options.signal.addEventListener('abort', () => reject(new Error('native abort')), { once: true });
  }) });
  const timedInput = args('discord'); timedInput.context.timeoutMs = 5;
  const timed = await createNotificationPlatforms({ transport: slow, runtimeMode: 'production' }).discord.send(timedInput);
  assert.equal(timed.outcome, 'unknown'); assert.equal(timed.errorCode, 'PLATFORM_TIMEOUT');
});

test('private production responses use verified native targets and preserve unknown outcomes', async () => {
  const calls = [];
  const transport = createProductionNotificationTransport({ readCredentials: credentials, fetchImpl: async (url, options) => {
    calls.push({ url, options });
    return url.startsWith('https://discord.com') ? response({ id: 'reply-1', channel_id: 'channel-1' })
      : response({ code: 0, data: { msg_id: 'reply-2' } });
  } });
  const verified = { externalId: 'user-1', interactionId: 'interaction-1', channelId: 'channel-1',
    privateReplyContext: { applicationId: 'app-1', interactionToken: 'constructed-private-token' } };
  const { content, components, allowed_mentions } = payload('discord');
  await transport.respondPrivate({ platform: 'discord', verifiedInteraction: verified, payload: { content, components, allowed_mentions } });
  await transport.respondPrivate({ platform: 'kook', verifiedInteraction: verified,
    payload: { ...payload('kook'), temp_target_id: 'user-1' } });
  assert.equal(calls[0].url, 'https://discord.com/api/v10/webhooks/app-1/constructed-private-token/messages/@original');
  assert.equal(calls[0].options.headers.authorization, undefined);
  assert.equal(calls[1].url, 'https://www.kookapp.cn/api/v3/message/create');
  assert.equal(JSON.parse(calls[1].options.body).temp_target_id, 'user-1');
});

test('production callbacks reuse Ed25519 and KOOK token verification without any external send', async () => {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519'), now = () => Date.parse('2026-09-20T12:00:00Z');
  const transport = { runtimeMode: 'production', request() { assert.fail('no native send'); }, respondPrivate() { assert.fail('no private send'); } };
  const common = { identity: {}, scheduling: {}, resolveActionReference() {}, publicOrigin: 'https://nb.example', transport, runtimeMode: 'production', now };
  const discord = createNotificationCallbackHandler({ ...common, platform: 'discord', verify: createDiscordVerifier({
    publicKey: publicKey.export({ format: 'der', type: 'spki' }).subarray(-32).toString('hex'), applicationId: 'app-1', now }) });
  const rawBody = Buffer.from('{"type":1,"application_id":"app-1"}'), timestamp = String(now() / 1000);
  const headers = { 'x-signature-timestamp': timestamp, 'x-signature-ed25519': sign(null, Buffer.concat([Buffer.from(timestamp), rawBody]), privateKey).toString('hex') };
  let ack;
  await discord({ rawBody, headers }, { ack: value => { ack = value; } }); assert.deepEqual(ack, { type: 1 });
  await assert.rejects(discord({ rawBody, headers: { ...headers, 'x-signature-ed25519': '0'.repeat(128) } }, { ack() { assert.fail(); } }), code('PLATFORM_AUTH_INVALID'));
  const kook = createNotificationCallbackHandler({ ...common, platform: 'kook', verify: createKookVerifier({ verifyToken: 'constructed-token', compression: 'none', now }) });
  await kook({ rawBody: Buffer.from(JSON.stringify({ s: 0, d: { channel_type: 'WEBHOOK_CHALLENGE', type: 255, challenge: 'challenge', verify_token: 'constructed-token' } })), headers: {} },
    { ack: value => { ack = value; } }); assert.deepEqual(ack, { challenge: 'challenge' });
});

test('production owner shares original identity/scheduling and sends an existing queued intent only through its worker', async t => {
  const f = createFixture({ adminRole: true }); t.after(() => f.close());
  const config = Object.fromEntries(['discord', 'kook'].map(platform => [platform, { enabled: true, revision: 1,
    commands: platform === 'kook' ? [{ id: 'signup_card', type: 'persistent_card', enabled: true }] : [],
    targets: f.catalog.listTargets().filter(item => item.platform === platform).map(item => ({ ...item, name: item.label,
      ...(platform === 'kook' ? { enabledCommandIds: ['signup_card'], signupCardChannelId: 'signup-channel' } : {}) })) }]));
  let sends = 0;
  const owner = createProductionNotificationOwner({ getIdentity: async () => f.identity, getPlatformService: () => ({
    identity: f.identity, config: id => config[id],
    guildCatalog: platform => ({ items: [{ id: `fixture-${platform}`, label: `${platform} 服务器` }] }),
    channelCatalogs: platform => [{ guildId: `fixture-${platform}`, items: [{ id: `fixture-${platform}-channel`, label: '当前WIPE聊天' },
      { id: 'signup-channel', label: '报名频道' }] }]
  }),
    publicOrigin: 'https://nb.example', readCredentials: credentials, now: () => f.clock.now, fetchImpl: async (url, options) => {
      sends++; const channel = decodeURIComponent(new URL(url).pathname.split('/')[4]);
      return response({ id: 'existing-message-1', channel_id: channel });
    } });
  t.after(() => owner.stop());
  const system = owner.getSystem(f.identity);
  assert.equal(system.service.identity, f.identity); assert.equal(system.service.scheduling, owner.getScheduling(f.identity));
  assert.equal(owner.diagnostics().runtimeMode, 'production'); assert.equal(sends, 0);
  const options = system.service.getOptions(f.actor(), f.wipe.id);
  assert.ok(options.targets.every(item => item.runtimeMode === 'production'));
  const kookDefault = options.targets.find(item => item.id === 'kook-1');
  const kook = options.targets.find(item => item.platform === 'kook' && item.label.endsWith('· 报名卡片'));
  assert.equal(kookDefault.channelLabel, '当前WIPE聊天');
  assert.equal(kook.guildLabel, 'kook 服务器'); assert.equal(kook.channelLabel, '报名频道');
  assert.equal(kook.channelId, 'signup-channel'); assert.equal(kook.capabilities.mentionEveryone, true);
  const kookPreview = system.service.createPreview(f.actor(), f.wipe.id, f.input({
    targets: [{ targetId: kook.id, language: 'zh-CN', mentionMode: 'everyone', roleIds: [] }]
  }), f.operation()).current;
  assert.equal(kookPreview.targets[0].selection.mentionMode, 'everyone');
  const kookPayload = system.service.repo.get('previews', kookPreview.id).targets[0].payload;
  assert.match(kookPayload.content, /\(met\)all\(met\)/u);
  assert.deepEqual(kookPreview.targets[0].rendered.actions.map(action => action.label), ['准时到场', '晚点到场', '不参加', '查看并管理报名']);
  assert.equal(sends, 0);
  const preview = system.service.createPreview(f.actor(), f.wipe.id, f.input(), f.operation()).current;
  system.service.createIntent(f.actor(), f.wipe.id, { previewId: preview.id, contentHash: preview.contentHash,
    expectedContentRevision: preview.contentRevision, purpose: preview.purpose, purposeInstance: preview.purposeInstance }, f.operation());
  await system.worker.runOnce({ workerId: 'production-fixture', limit: 1 });
  assert.equal(sends, 1); assert.equal(system.service.repo.all('deliveries')[0].status, 'sent');
  const selected = owner.catalog.getTarget('discord-1'); config.discord.revision++;
  assert.notEqual(selected.configurationRevision, owner.catalog.getTarget('discord-1').configurationRevision);
  await assert.rejects(owner.start(), code('PLATFORM_VERIFIER_CONFIG_INVALID'));
  assert.equal(owner.diagnostics().timerActive, false); assert.equal(sends, 1);
});

test('Discord signup card has a dedicated canonical target inside the main server configuration',async t=>{
 const f=createFixture({adminRole:true});t.after(()=>f.close());
 const config={enabled:true,revision:1,commands:[{id:'wipe',type:'event_command',slashCommand:'wipe-react',signupMode:'discord_only',enabled:true}],targets:[{id:'server',guildId:'guild',channelId:'announcements',signupCardChannelId:'signup',enabled:true,enabledCommandIds:['wipe']}]};
 const owner=createProductionNotificationOwner({getIdentity:async()=>f.identity,getPlatformService:()=>({identity:f.identity,config:platform=>platform==='discord'?config:{enabled:false,targets:[],commands:[]}}),publicOrigin:'https://nb.example',readCredentials:credentials});t.after(()=>owner.stop());
 const signup=owner.catalog.listTargets().find(target=>target.id.startsWith('signup_card_'));
 assert.equal(signup.platform,'discord');assert.equal(signup.channelId,'signup');
 assert.equal(signup.signupMode,'discord_only');
 assert.equal(owner.catalog.getTarget('server').channelId,'announcements');
 config.commands[0].enabled=false;assert.equal(owner.catalog.getTarget(signup.id),null);
});
