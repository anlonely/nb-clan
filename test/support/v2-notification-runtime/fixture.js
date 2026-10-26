import { DatabaseSync } from 'node:sqlite';
import { generateKeyPairSync, sign, randomUUID } from 'node:crypto';
import { deflateSync } from 'node:zlib';
import { createServer } from 'node:http';
import express from 'express';
import { installIdentitySchema, IdentityRepository } from '../../../server/v2/identity/repository.js';
import { IdentityService } from '../../../server/v2/identity/service.js';
import { applyIdentityMigration, planIdentityMigration } from '../../../server/v2/identity/migration.js';
import { CAPABILITIES, grant } from '../../../server/v2/identity/permissions.js';
import { installSchedulingSchema } from '../../../server/v2/scheduling/repository.js';
import { installNotificationSchema } from '../../../server/v2/notifications/index.js';
import { createDiscordVerifier, createKookVerifier } from '../../../server/v2/notification-platforms/verifiers.js';
import { createIsolatedNotificationTransport } from '../../../server/v2/notification-platforms/isolated-transport.js';
import { createNotificationRuntime } from '../../../server/v2/notification-runtime/index.js';

const GUILD = '100000000000000001', CHANNEL = '300000000000000001', EXTERNAL = '200000000000000001';
const APPLICATION = '400000000000000001', ROLE = '500000000000000001';
const VERIFY_TOKEN = 'constructed-local-webhook-verification-token';

export async function runtimeFixture(t, options = {}) {
  const db = new DatabaseSync(':memory:');
  const state = { now: Date.parse('2030-09-08T10:00:00.000Z'), wait: null, roles: [ROLE], roleCalls: 0 };
  const now = () => state.now;
  installIdentitySchema(db); installSchedulingSchema(db);
  const providers = Object.fromEntries(['discord', 'kook'].map(provider => [provider, {
    async roles(externalId, guildId) {
      state.roleCalls++;
      if (state.wait) await state.wait;
      return { externalId, guildId, roleIds: state.roles };
    }
  }]));
  const identity = new IdentityService(new IdentityRepository(db), { providers, now });
  applyIdentityMigration(identity.repo, planIdentityMigration({}));
  identity.repo.setScalar('v2SchedulingMigration', { version: 1, fixture: true });
  identity.repo.setScalar('v2RosterRevision', 1);
  for (const policy of identity.repo.all('policies')) identity.repo.put('policies', {
    ...policy, enabled: true, guildId: GUILD, allowedRoleIds: [ROLE]
  });
  const profile = { provider: 'discord', id: EXTERNAL, displayName: '构造测试成员' };
  const eligibility = await identity.checkEligibility('discord', EXTERNAL);
  const bound = identity.bind(profile, '76561198000000001', eligibility, identity.login(profile, eligibility));
  const member = identity.session(bound.token).actor;
  identity.repo.put('identities', { id: 'local-kook-identity', provider: 'kook', externalId: EXTERNAL, accountId: member.id, revision: 1 });
  identity.repo.put('accounts', { id: 'operator', memberId: null, status: 'active', roleId: 'admin', adminAssignedByOwner: true, permissionVersion: 1, revision: 1,
    grants: CAPABILITIES.map(capability => grant(capability, { type: 'all' })) });
  installNotificationSchema(db);
  const targets = ['discord', 'kook'].map(platform => ({ id: `${platform}-local`, platform, guildId: GUILD, channelId: CHANNEL,
    label: `${platform} 本地频道`, guildLabel: '构造服务器', channelLabel: '构造频道', enabled: true, configurationRevision: 1,
    languages: ['zh-CN', 'en', 'ru', 'tr', 'th', 'ko'], roleOptions: [{ id: ROLE, label: '构造队员' }],
    capabilities: { preview: true, send: true, mentionRoles: true, mentionEveryone: true },
    runtimeMode: 'isolated', transportKey: `${platform}-local-transport` }));
  const catalog = { listTargets: () => structuredClone(targets), getTarget: id => structuredClone(targets.find(t => t.id === id) || null),
    listOptions: () => ({ items: [], nextCursor: null }) };
  const transport = createIsolatedNotificationTransport({ now, script: options.script || [] });
  const pair = generateKeyPairSync('ed25519');
  const verifiers = {
    discord: createDiscordVerifier({ publicKey: pair.publicKey.export({ format: 'der', type: 'spki' }).subarray(-32).toString('hex'), applicationId: APPLICATION, now }),
    kook: createKookVerifier({ verifyToken: VERIFY_TOKEN, now })
  };
  const runtimeInput = { getIdentity: async () => identity, catalog, transport, verifiers, publicOrigin: 'http://127.0.0.1:4319', now,
    ...(options.runtime || {}) };
  const runtime = createNotificationRuntime(runtimeInput);
  const scheduling = runtime.getScheduling(identity), system = runtime.getSystem(identity);
  const actor = () => identity.actorForAccount('operator');
  const operation = () => ({ operationId: `runtime-fixture:${randomUUID()}` });
  let wipe = scheduling.createWipe(actor(), { title: 'Runtime 真实接缝', description: '构造数据，仅本地验证',
    serverProfileId: 'local-server', serverSnapshot: { name: '构造服务器' }, timeZone: 'Asia/Shanghai',
    musterAt: '2030-09-08T12:00:00.000Z', signupOpensAt: '2030-09-08T09:00:00.000Z', signupClosesAt: '2030-09-08T13:00:00.000Z',
    autoStart: true, audience: { squadIds: [], memberIds: [member.memberId], includeUnassigned: false } }, operation()).current;
  wipe = scheduling.transition(actor(), wipe.id, 'publish', { expectedRevision: wipe.revision }, operation()).current;

  const app = express();
  let browserMiddlewareCalls = 0;
  app.use('/api', runtime.callbackRouter);
  app.use(express.json());
  app.use((req, res) => { browserMiddlewareCalls++; res.sendStatus(401); });
  const server = createServer(app);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  let databaseClosed = false;
  const closeDatabase = () => { if (!databaseClosed) { db.close(); databaseClosed = true; } };
  t.after(async () => {
    await runtime.stop();
    const close = new Promise(resolve => server.close(resolve)); server.closeAllConnections(); await close;
    closeDatabase();
  });

  function input(platform, overrides = {}) {
    return { expectedContentRevision: wipe.contentRevision, templateId: 'wipe-notification', templateRevision: 1,
      purpose: 'signup_open', purposeInstance: 'primary', repeatOfIntentId: null, reason: null, duplicateRiskAcknowledged: false,
      targets: [{ targetId: `${platform}-local`, language: 'zh-CN', mentionMode: 'roles', roleIds: [ROLE] }],
      audience: structuredClone(wipe.audience), schedule: null, ...overrides };
  }
  function publish(platform, overrides = {}) {
    const preview = system.service.createPreview(actor(), wipe.id, input(platform, overrides), operation()).current;
    const intent = system.service.createIntent(actor(), wipe.id, { previewId: preview.id, contentHash: preview.contentHash,
      expectedContentRevision: preview.contentRevision, purpose: preview.purpose, purposeInstance: preview.purposeInstance }, operation()).current;
    return { preview, intent, delivery: system.service.repo.all('deliveries').find(d => d.intentId === intent.id) };
  }
  function token(message) {
    if (message.platform === 'discord') return message.payload.components[0].components.find(button => button.custom_id).custom_id;
    return JSON.parse(message.payload.content)[0].modules.find(module => module.type === 'action-group').elements.find(button => button.click === 'return-val').value;
  }
  let sequence = 0;
  function nativeEnvelope(platform, message, eventId = `native-event-${++sequence}`) {
    const value = token(message);
    if (platform === 'discord') {
      const rawBody = Buffer.from(JSON.stringify({ id: eventId, application_id: APPLICATION, type: 3,
        guild_id: GUILD, channel_id: CHANNEL, member: { user: { id: EXTERNAL } }, token: 'constructed-private-interaction-token',
        data: { component_type: 2, custom_id: value } }));
      const timestamp = String(Math.floor(now() / 1000));
      return { rawBody, headers: { 'content-type': 'application/json', 'x-signature-timestamp': timestamp,
        'x-signature-ed25519': sign(null, Buffer.concat([Buffer.from(timestamp), rawBody]), pair.privateKey).toString('hex') } };
    }
    return { headers: { 'content-type': 'application/json', 'content-encoding': 'deflate' },
      rawBody: deflateSync(Buffer.from(JSON.stringify({ s: 0, sn: ++sequence, d: {
        type: 255, channel_type: 'PERSON', target_id: 'untrusted-top-level-target', msg_id: eventId, msg_timestamp: now(), verify_token: VERIFY_TOKEN,
        extra: { type: 'message_btn_click', body: { user_id: EXTERNAL, value, target_id: CHANNEL, msg_id: message.messageId } }
      } }))) };
  }
  async function post(platform, envelope) {
    const response = await fetch(`${origin}/api/integrations/v2/notifications/${platform}`, {
      method: 'POST', headers: envelope.headers, body: envelope.rawBody
    });
    return { status: response.status, body: await response.json() };
  }
  async function drainCallbacks() {
    for (let tries = 0; runtime.diagnostics().callbackJobs > 0; tries++) {
      if (tries >= 1000) throw new Error('Callback did not complete');
      await new Promise(resolve => setImmediate(resolve));
    }
  }
  return { db, identity, scheduling, system, runtime, runtimeInput, transport, state, actor, member, wipe, operation, origin,
    input, publish, token, nativeEnvelope, post, drainCallbacks, closeDatabase,
    browserMiddlewareCalls: () => browserMiddlewareCalls,
    signup: () => scheduling.getSignup(identity.actorForAccount(member.id), wipe.id, member.memberId),
    delivery: id => system.service.repo.get('deliveries', id) };
}
