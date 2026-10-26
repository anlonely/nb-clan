import { fixtureSessionFactory } from '../authenticated-session.mjs';
import express from 'express';
import assert from 'node:assert/strict';
import { AsyncLocalStorage } from 'node:async_hooks';
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { fixture as base } from '../v2-member-admin/fixtures.mjs';
import { SchedulingService } from '../../../server/v2/scheduling/service.js';
import { createNotificationSystem, installNotificationSchema, createNotificationRouter, installNotificationBusinessSchema } from '../../../server/v2/notifications/index.js';
import { createNotificationPlatforms, buildNativeNotificationRequest } from '../../../server/v2/notification-platforms/platforms.js';
import { createVipNotifications, installVipNotificationsSchema } from '../../../server/v2/vip-notifications/index.js';
import { createMemberManagementAdapters, createMemberContextInvalidator } from '../../../server/v2/management-adapters/members/index.js';
import { MemberAdminService } from '../../../server/v2/member-admin/service.js';
import { AuthContexts } from '../../../server/v2/identity/contexts.js';
import { createIdentityRouter } from '../../../server/v2/identity/routes.js';
import { createMemberAdminRouter } from '../../../server/v2/member-admin/routes.js';

// All identities, VIP facts, channels and roles here are constructed fixtures.
// Provider requests use real HTTP, constrained to this owned loopback server.
export async function fixture({ filename = ':memory:', migrate = true, options = {} } = {}) {
  const f = base(filename); let at = f.now(), tail = Promise.resolve(), queueCalls = 0, sequence = 0;
  f.now = f.identity.now = () => at; f.advance = ms => { at += ms; };
  const inside = new AsyncLocalStorage(); f.cache = {};
  f.queue = fn => { assert.ok(!inside.getStore(), 'nested original write queue'); queueCalls++;
    const work = tail.then(() => inside.run(true, fn)); tail = work.catch(() => {}); return work; };
  f.queueCalls = () => queueCalls;
  f.bundle = createMemberManagementAdapters({ identity: f.identity, runStoreWriteTask: f.queue,
    patchStoreCache: fn => { assert.ok(inside.getStore()); fn(f.cache); }, isTrustedRoot: actor => actor.id === 'root',
    contexts: createMemberContextInvalidator({ authContexts: new AuthContexts({ now: f.now }), invalidatePlatformSessions() {} }) });
  f.members = new MemberAdminService(f.identity, f.bundle.adapters);
  installNotificationSchema(f.db); installNotificationBusinessSchema(f.db); if (migrate) installVipNotificationsSchema(f.db);
  f.externalId = '300000000000000001'; f.channelId = '200000000000000001'; f.botId = '400000000000000001';
  f.ir.put('members', { ...f.ir.get('members', 'm001'), discordId: f.externalId });
  f.ir.put('identities', { id: 'constructed-discord', provider: 'discord', externalId: f.externalId, accountId: 'leader', revision: 1 });
  f.ir.put('policies', { id: 'constructed-discord-policy', provider: 'discord', enabled: true, policyRevision: 1,
    guildId: '100000000000000001', allowedRoleIds: ['member-role'], matchMode: 'any' });
  f.policy = { enabled: true, revision: 'vip-policy-1', legacySchedulerDisabled: true };
  f.pin = { accountId: 'admin', permissionVersion: 1 };
  f.configs = Object.fromEntries(['vital', 'rustinity', 'atlas'].map(source => [source, { source, enabled: true,
    revision: 'source-1', templateRevision: 1, transportKey: 'isolated-discord', botUserId: f.botId }]));
  f.channel = { id: f.channelId, type: 1, recipients: [{ id: f.externalId }] };
  f.roles = ['member-role']; f.calls = []; f.proofCalls = []; f.messages = new Map(); f.fault = null;
  const app = express(), server = createServer(app);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); f.origin = `http://127.0.0.1:${server.address().port}`;
  app.use((req, res, next) => req.get('host') === new URL(f.origin).host && req.socket.remoteAddress === '127.0.0.1' ? next() : res.sendStatus(403));
  app.get('/__proof/channels/:id', (req, res) => { assert.equal(f.db.isTransaction, false); f.proofCalls.push(req.path); res.json(f.channel); });
  app.get('/__proof/guilds/:guild/members/:id', (req, res) => { assert.equal(f.db.isTransaction, false); f.proofCalls.push(req.path);
    res.json({ externalId: req.params.id, guildId: req.params.guild, roleIds: f.roles }); });
  f.identity.providers = { discord: { roles: async (id, guild) => (await fetch(`${f.origin}/__proof/guilds/${guild}/members/${id}`, { redirect: 'error' })).json() } };
  f.refreshProofs = async () => {
    await f.identity.checkEligibility('discord', f.externalId);
    const channel = await (await fetch(`${f.origin}/__proof/channels/${f.channelId}`, { redirect: 'error' })).json();
    f.proof = { verified: true, botUserId: f.botId, transportKey: 'isolated-discord', targetId: 'vip-dm-m001',
      configurationRevision: 1, revision: 'dm-proof-1', verifiedAt: new Date(at).toISOString(), expiresAt: new Date(at + 300000).toISOString(),
      languages: ['zh-CN', 'en', 'ru', 'tr', 'th', 'ko'], channel };
  };
  app.use('/__native', express.json());
  app.use('/__native', async (req, res) => {
    const operation = req.get('x-fixture-operation'), attempt = f.notifications.service.repo.get('attempts', req.get('x-fixture-attempt'));
    assert.equal(attempt.status, 'requesting'); assert.equal(f.db.isTransaction, false);
    assert.ok(!req.path.includes('/users/')); assert.match(req.path, /^\/api\/v10\/channels\/\d+\/messages/);
    f.calls.push({ operation, path: req.path, method: req.method, body: req.body, attemptId: attempt.id });
    if (f.fault) { const fault = f.fault; f.fault = null; if (await fault({ req, res, attempt })) return; }
    const id = operation === 'send' ? String(900000000000000000n + BigInt(++sequence)) : req.path.split('/messages/')[1];
    const old = f.messages.get(id);
    if (operation === 'lookup' && !old) return res.status(404).json({ code: 10008, message: 'Unknown Message' });
    if (operation !== 'lookup') f.messages.set(id, { id, payload: req.body, revision: (old?.revision || 0) + 1 });
    res.json({ id, channel_id: f.channelId }); // A native DM message has no guild_id.
  });
  const transport = { runtimeMode: 'isolated', respondPrivate: async () => { throw new Error('No callback in VIP reminders'); }, request: async args => {
    const native = buildNativeNotificationRequest(args), url = new URL('/__native' + native.path, f.origin); assert.equal(url.origin, f.origin);
    const response = await fetch(url, { method: native.method, signal: args.context.signal, redirect: 'error',
      headers: { 'Content-Type': 'application/json', 'x-fixture-operation': args.operation, 'x-fixture-attempt': args.context.attemptId },
      ...(native.body === null ? {} : { body: JSON.stringify(native.body) }) });
    return { status: response.status, headers: {}, body: await response.json() };
  } };
  f.notifications = createNotificationSystem({ identity: f.identity, scheduling: new SchedulingService(f.sr, f.identity, { now: f.now }),
    catalog: { getTarget: () => null, listTargets: () => [], listOptions: () => ({ items: [], nextCursor: null }) },
    renderer: () => { throw new Error('VIP must not enter wipe renderer'); }, templates: [],
    platforms: createNotificationPlatforms({ transport, now: f.now }), publicOrigin: f.origin, now: f.now,
    options: { leaseMs: 1000, requestTimeoutMs: 500, ...options } });
  f.createDomain = () => createVipNotifications({ identity: f.identity, notifications: f.notifications, readPolicy: () => f.policy,
    readPrincipal: () => f.pin, readSourceConfig: ({ source }) => f.configs[source], readDmTarget: () => f.proof, runStoreWriteTask: f.queue, now: f.now });
  if (migrate) f.vip = f.createDomain();
  const identities = createIdentityRouter({ service: f.identity, origin: f.origin, providers: {} });
  app.use('/api/v2', (req, res, next) => { req.v2Identity = { service: f.identity, authenticate: opts => identities.authenticate(opts)(req) }; next(); });
  app.use('/api/v2', identities, createMemberAdminRouter({ getService: () => f.members, writeDomain: f.bundle.writeDomain }), express.json(),
    createNotificationRouter({ getSystem: () => f.notifications }));
  // Authenticate the two browser actors against existing synthetic members so
  // authentication setup does not add rows to the bounded VIP scan inventory.
  for (const [id,memberId] of [['admin','m064'],['viewer','m065']]) f.ir.put('accounts',{...f.ir.get('accounts',id),memberId});
  const fixtureSession = await fixtureSessionFactory(f.identity, ['admin','viewer']);
  f.headers = (id = 'admin') => { const session = fixtureSession(id); return {
    Cookie: `nb_v2_session=${session.token}`, Origin: f.origin, 'Content-Type': 'application/json', 'X-CSRF-Token': session.csrfToken,
    'Idempotency-Key': randomUUID() }; };
  f.request = async (path, { method = 'GET', input, headers = f.headers() } = {}) => {
    const response = await fetch(new URL('/api/v2' + path, f.origin), { method, redirect: 'error', headers,
      ...(input === undefined ? {} : { body: JSON.stringify(input) }) });
    return { status: response.status, body: await response.json() };
  };
  f.setVip = async (source = 'vital', expiresAt = '2030-09-08', type = source === 'rustinity' ? 'queue_skip' : 'priority') => {
    if (source === 'rustinity') { const member=f.ir.get('members','m001'); f.ir.put('members',{...member,rustinityVipType:type,rustinityVipPurchasedAt:'2030-08-11',rustinityVipExpiresAt:expiresAt}); return member; }
    const r = await f.request('/member-admin/members/m001', { method: 'PATCH', input: {
      expectedRevision: f.ir.get('members', 'm001').revision,
      fields: { [`${source}VipType`]: type, [`${source}VipPurchasedAt`]: '2030-08-11', [`${source}VipExpiresAt`]: expiresAt } } });
    assert.equal(r.status, 200, JSON.stringify(r)); return r.body.data;
  };
  f.scan = async (limit = 20) => { let r; do { r = await f.vip.tick({ limit }); } while (!r.completed); return r; };
  f.run = () => f.notifications.worker.runOnce({ workerId: 'isolated-vip-worker', limit: 100 });
  f.drain = async () => { for (let i = 0; i < 10; i++) if (!(await f.run()).claimed) break; };
  f.deliveries = () => f.notifications.service.repo.all('deliveries');
  f.observations = () => f.db.prepare('SELECT member_id,source,payload FROM v2_vip_notification_observations').all().map(r => ({ memberId: r.member_id, source: r.source, ...JSON.parse(r.payload) }));
  f.close = async () => { await f.vip?.stop(); await f.notifications.worker.stop(); await identities.stopEvents(); await tail;
    server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); f.db.close(); };
  await f.refreshProofs(); return f;
}
