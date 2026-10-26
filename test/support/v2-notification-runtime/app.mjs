import '../v2-baseline/loopback-only.mjs';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { access, realpath, writeFile } from 'node:fs/promises';
import { randomBytes, randomUUID, generateKeyPairSync, sign, timingSafeEqual } from 'node:crypto';
import { deflateSync } from 'node:zlib';
import path from 'node:path';
import express from 'express';
import { root, validateEnvironment } from './config.mjs';

validateEnvironment();
const runDir = process.env.G06_RUN_DIR;
assert.equal(await realpath(runDir), runDir);
await assert.rejects(access(process.env.NB_SQLITE_FILE), { code: 'ENOENT' }, 'A fresh SQLite path is required');
const rootPassword = randomBytes(24).toString('base64url');
process.env.NB_ROOT_PASSWORD = rootPassword;
const controlToken = randomBytes(32).toString('base64url');
const store = await import('../../../server/store.js');
const storage = await import('../../../server/storage/sqlite.js');
let apiRouter, vite, server, ready = false, draining = false, shutdownPromise;
const controls = new Set();

async function shutdown() {
  if (shutdownPromise) return shutdownPromise;
  draining = true; ready = false;
  shutdownPromise = (async () => {
    const closing = server ? new Promise(resolve => { server.close(resolve); server.closeIdleConnections(); }) : Promise.resolve();
    // Already admitted fixture controls may still be performing a real HTTP mutation.
    await Promise.allSettled([...controls]);
    await apiRouter?.v2Runtime.stop();
    await vite?.close();
    server?.closeAllConnections(); await closing;
    const { stopBackgroundJobs } = await import('../../../server/api.js');
    stopBackgroundJobs();
    const { drainBackgroundTaskQueues } = await import('../../../server/background-task-queue.js');
    await drainBackgroundTaskQueues({ timeoutMs: 30_000, stopAccepting: true });
    await store.drainStoreWrites();
    await storage.closeSqliteDatabases();
    await writeFile(path.join(runDir, 'shutdown.json'), JSON.stringify({ closed: true, at: new Date().toISOString(),
      notificationRuntime: apiRouter?.v2Runtime.notifications?.diagnostics() }, null, 2), { mode: 0o600 });
  })();
  return shutdownPromise;
}
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => {
  shutdown().then(() => { process.exitCode = 0; }, () => { console.error('G06_RUNTIME_SHUTDOWN_FAILED'); process.exitCode = 1; });
});

async function main() {
  await store.ensureStore();
  const legacy = await store.readStore();
  const db = await storage.openSqliteDatabase();
  const { installIdentitySchema, IdentityRepository } = await import('../../../server/v2/identity/repository.js');
  const { applyIdentityMigration, planIdentityMigration } = await import('../../../server/v2/identity/migration.js');
  const { installSchedulingSchema, SchedulingRepository } = await import('../../../server/v2/scheduling/repository.js');
  const { applySchedulingMigration, planSchedulingMigration } = await import('../../../server/v2/scheduling/migration.js');
  const { installNotificationSchema } = await import('../../../server/v2/notifications/index.js');
  installIdentitySchema(db); applyIdentityMigration(new IdentityRepository(db), planIdentityMigration(legacy));
  installSchedulingSchema(db); applySchedulingMigration(new SchedulingRepository(db), planSchedulingMigration(legacy));
  installNotificationSchema(db);

  const app = express(); app.disable('x-powered-by');
  let origin;
  app.use((req, res, next) => {
    res.set({ 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer', 'X-Content-Type-Options': 'nosniff' });
    if (req.socket.remoteAddress !== '127.0.0.1' || req.get('host') !== new URL(origin).host) return res.sendStatus(400);
    if (!ready || draining) return res.status(503).json({ error: { errorCode: 'ISOLATED_RUNTIME_NOT_READY' } });
    // Private run files are never frontend assets, including Vite's @fs endpoint.
    let decoded;
    try { decoded = decodeURIComponent(req.path); } catch { return res.sendStatus(400); }
    if (/(?:^|\/)work(?:\/|$)|(?:^|\/)\.env(?:\.|$)/.test(decoded)) return res.sendStatus(403);
    next();
  });
  server = createServer(app);
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(Number(process.env.G06_PORT), '127.0.0.1', resolve); });
  origin = `http://127.0.0.1:${server.address().port}`;
  process.env.NB_V2_PUBLIC_ORIGIN = origin;

  const { createNotificationRuntime } = await import('../../../server/v2/notification-runtime/index.js');
  const { createIsolatedNotificationTransport } = await import('../../../server/v2/notification-platforms/isolated-transport.js');
  const { createDiscordVerifier, createKookVerifier } = await import('../../../server/v2/notification-platforms/verifiers.js');
  const { createApiRouter } = await import('../../../server/api.js');
  const { MEMBER_GRANTS } = await import('../../../server/v2/identity/permissions.js');
  const guildId = '100000000000000001', channelId = '300000000000000001', roleId = '500000000000000001', applicationId = '400000000000000001';
  const targets = ['discord', 'kook'].map(platform => ({ id: `${platform}-g06-local`, platform, guildId, channelId,
    label: `${platform === 'discord' ? 'Discord' : 'KOOK'} · 本地通知频道`, guildLabel: 'NB Clan 本地构造', channelLabel: '档期通知',
    enabled: true, configurationRevision: 1, languages: ['zh-CN', 'en', 'ru', 'tr', 'th', 'ko'], roleOptions: [{ id: roleId, label: '一队队员' }],
    capabilities: { preview: true, send: true, mentionRoles: true, mentionEveryone: true }, runtimeMode: 'isolated', transportKey: `${platform}-isolated-native` }));
  const fixtures = [{ key: 'alpha', displayName: '阿北', externalId: '200000000000000001', steamId: '76561198000000601' },
    { key: 'beta', displayName: '小林', externalId: '200000000000000002', steamId: '76561198000000602' }];
  let identity;
  const catalog = {
    listTargets: () => structuredClone(targets), getTarget: id => structuredClone(targets.find(t => t.id === id) || null),
    listOptions(kind, { q = '', limit = 50, cursor = null } = {}) {
      const rows = kind === 'servers' ? [{ id: 'g06-local-server', label: 'Rustoria EU Main · 本地构造',
        serverSnapshot: { name: 'Rustoria EU Main · 本地构造', region: 'EU' }, serverScheduleSource: null }]
        : kind === 'squads' ? identity.repo.all('squads').map(s => ({ id: s.id, label: s.name }))
          : fixtures.map(f => ({ id: f.memberId, label: f.displayName, squadIds: ['g06-squad'] }));
      const filtered = rows.filter(row => row.label.includes(q)).sort((a, b) => a.id.localeCompare(b.id));
      const offset = cursor ? Math.max(0, filtered.findIndex(row => row.id === cursor) + 1) : 0;
      const items = filtered.slice(offset, offset + limit);
      return { items, nextCursor: filtered.length > offset + limit ? items.at(-1).id : null };
    }
  };
  const pair = generateKeyPairSync('ed25519'), verifyToken = randomBytes(32).toString('base64url');
  const transport = createIsolatedNotificationTransport();
  const verifiers = {
    discord: createDiscordVerifier({ publicKey: pair.publicKey.export({ format: 'der', type: 'spki' }).subarray(-32).toString('hex'), applicationId }),
    kook: createKookVerifier({ verifyToken })
  };
  apiRouter = createApiRouter({ notificationRuntimeFactory: ({ getIdentity }) => createNotificationRuntime({
    getIdentity, catalog, transport, verifiers, publicOrigin: origin
  }) });
  identity = await apiRouter.v2Runtime.getIdentity();
  // This is the formal router's exact IdentityService, not a second write service.
  for (const platform of ['discord', 'kook']) identity.providers[platform].roles = async (externalId, requestedGuild) => {
    assert.ok(fixtures.some(f => f.externalId === externalId) && requestedGuild === guildId, 'CONSTRUCTED_IDENTITY_REQUIRED');
    return { externalId, guildId: requestedGuild, roleIds: [roleId] };
  };
  identity.repo.transaction(() => {
    identity.repo.put('squads', { id: 'g06-squad', name: '北境一队', description: '晚间开荒队', leaderUserIds: [], revision: 1 });
    for (const policy of identity.repo.all('policies')) identity.repo.put('policies', { ...policy, enabled: true, guildId, allowedRoleIds: [roleId] });
    for (const f of fixtures) {
      f.accountId = `g06-account-${f.key}`; f.memberId = `g06-member-${f.key}`;
      identity.repo.put('members', { id: f.memberId, steamId: f.steamId, displayName: f.displayName, customName: f.displayName,
        memberStatus: 'active', membershipStatus: 'active', specialty: ['建筑'], timeZone: 'Asia/Shanghai', language: 'zh-CN', theme: 'light', revision: 1 });
      identity.repo.put('accounts', { id: f.accountId, memberId: f.memberId, status: 'active', roleId: 'member',
        grants: structuredClone(MEMBER_GRANTS), permissionVersion: 1, revision: 1 });
      identity.repo.put('bindings', { id: `g06-binding-${f.key}`, accountId: f.accountId, memberId: f.memberId, steamId: f.steamId,
        status: 'verified', revision: 1, verifiedAt: new Date().toISOString(), proofSource: 'isolated_constructed_fixture' });
      identity.repo.put('squadMembers', { id: `g06-relation-${f.key}`, memberId: f.memberId, squadId: 'g06-squad', validTo: null });
      for (const provider of ['discord', 'kook']) identity.repo.put('identities', { id: `g06-${provider}-${f.key}`, provider,
        externalId: f.externalId, accountId: f.accountId, revision: 1 });
    }
  });
  for (const f of fixtures) for (const platform of ['discord', 'kook']) await identity.checkEligibility(platform, f.externalId);
  const owner = apiRouter.v2Runtime.notifications, scheduling = owner.getScheduling(identity), system = owner.getSystem(identity);
  const operator = () => identity.actorForAccount('user_root');
  const at = hours => new Date(Date.now() + hours * 3_600_000).toISOString();
  const wipes = [];
  for (const [i, title] of ['周四主服开荒', '周末一队集结'].entries()) {
    const draft = scheduling.createWipe(operator(), { title, description: '集合前进入一队语音，首小时优先落点建家。',
      serverProfileId: 'g06-local-server', serverSnapshot: catalog.listOptions('servers').items[0].serverSnapshot,
      timeZone: 'Asia/Shanghai', audience: { squadIds: ['g06-squad'], memberIds: [], includeUnassigned: false },
      musterAt: at(4 + i * 24), serverScheduledWipeAt: at(3 + i * 24), signupOpensAt: at(-1), signupClosesAt: at(5 + i * 24),
      autoOpenSignup: true }, { operationId: `g06-seed-create-${i}` }).current;
    wipes.push(scheduling.transition(operator(), draft.id, 'publish', { expectedRevision: draft.revision }, { operationId: `g06-seed-publish-${i}` }).current);
  }

  function requireControl(req, res, next) {
    const supplied = Buffer.from(req.get('x-g06-control') || '');
    if (req.get('origin') !== origin || supplied.length !== controlToken.length || !timingSafeEqual(supplied, Buffer.from(controlToken)))
      return res.status(403).json({ error: { errorCode: 'FIXTURE_CONTROL_DENIED' } });
    next();
  }
  async function memberSession(fixture) {
    const evidence = await identity.checkEligibility('discord', fixture.externalId);
    const result = identity.login({ provider: 'discord', id: fixture.externalId, displayName: fixture.displayName }, evidence);
    assert.equal(result.step, 'complete'); return result;
  }
  async function memberRequest(fixture, route, options = {}) {
    const session = await memberSession(fixture);
    try {
      const response = await fetch(`${origin}/api/v2${route}`, { ...options, headers: { origin, 'content-type': 'application/json',
        cookie: `nb_v2_session=${session.token}; nb_v2_csrf=${session.csrfToken}`, 'x-csrf-token': session.csrfToken,
        'idempotency-key': `g06-control:${randomUUID()}` } });
      return { status: response.status, body: await response.json() };
    } finally { identity.logout(session.token); }
  }
  let eventSequence = 0;
  async function nativeCallback(body, fixture) {
    const platform = body.platform;
    assert.ok(['discord', 'kook'].includes(platform));
    const delivery = system.service.repo.get('deliveries', body.deliveryId);
    assert.ok(delivery && delivery.platform === platform, 'DELIVERY_REQUIRED');
    const message = transport.getMessages().find(m => m.operationKey === `notification:${delivery.id}` && !m.deleted);
    assert.ok(message, 'CONSTRUCTED_MESSAGE_REQUIRED');
    const buttons = platform === 'discord' ? message.payload.components.flatMap(row => row.components).filter(b => b.custom_id).map(b => b.custom_id)
      : JSON.parse(message.payload.content).flatMap(card => card.modules).filter(m => m.type === 'action-group').flatMap(m => m.elements).filter(b => b.click === 'return-val').map(b => b.value);
    const action = body.response || 'attending_on_time';
    const value = buttons.find(token => {
      try { return system.references.resolve(token, { platform, guildId: platform === 'kook' ? null : guildId, channelId }).action === action; }
      catch { return false; }
    });
    assert.ok(value, 'CONFIRMED_ACTION_REFERENCE_REQUIRED');
    const eventId = `g06-native-${++eventSequence}-${randomUUID()}`;
    let raw, headers;
    if (platform === 'discord') {
      raw = Buffer.from(JSON.stringify({ id: eventId, application_id: applicationId, type: 3, guild_id: guildId, channel_id: channelId,
        member: { user: { id: fixture.externalId } }, token: randomBytes(24).toString('base64url'), data: { component_type: 2, custom_id: value } }));
      const timestamp = String(Math.floor(Date.now() / 1000));
      headers = { 'content-type': 'application/json', 'x-signature-timestamp': timestamp,
        'x-signature-ed25519': sign(null, Buffer.concat([Buffer.from(timestamp), raw]), pair.privateKey).toString('hex') };
    } else {
      raw = deflateSync(Buffer.from(JSON.stringify({ s: 0, sn: eventSequence, d: { type: 255, channel_type: 'PERSON',
        msg_id: eventId, msg_timestamp: Date.now(), verify_token: verifyToken, target_id: 'ignored-person-target',
        extra: { type: 'message_btn_click', body: { user_id: fixture.externalId, value, target_id: channelId, msg_id: message.messageId } } } })));
      headers = { 'content-type': 'application/json', 'content-encoding': 'deflate' };
    }
    const response = await fetch(`${origin}/api/integrations/v2/notifications/${platform}`, { method: 'POST', headers, body: raw });
    await response.arrayBuffer();
    for (let attempt = 0; owner.diagnostics().callbackJobs && attempt < 100; attempt++) await new Promise(resolve => setTimeout(resolve, 10));
    return { ackStatus: response.status, processing: owner.diagnostics().callbackJobs > 0,
      current: scheduling.getSignup(identity.actorForAccount(fixture.accountId), delivery.wipeId, fixture.memberId) };
  }
  async function control(req, res) {
    const body = req.body || {}, fixture = fixtures.find(f => f.key === body.fixture);
    if (body.action === 'tick') return res.json(await owner.tick());
    if (body.action === 'member-login' && fixture) {
      const result = await memberSession(fixture);
      const opts = { httpOnly: true, sameSite: 'lax', path: '/api/v2', maxAge: 3_600_000 };
      res.cookie('nb_v2_session', result.token, opts); res.cookie('nb_v2_csrf', result.csrfToken, opts);
      return res.json({ returnTo: '/app', fixture: fixture.key });
    }
    if (body.action === 'signup' && fixture) {
      const wipeId = body.wipeId || wipes[0].id, actor = identity.actorForAccount(fixture.accountId);
      const current = scheduling.getSignup(actor, wipeId, fixture.memberId), wipe = scheduling.getWipe(actor, wipeId);
      assert.ok([null, 'attending_on_time', 'attending_later', 'not_attending'].includes(body.response));
      const result = await memberRequest(fixture, `/wipes/${encodeURIComponent(wipeId)}/my-signup`, { method: 'PUT', body: JSON.stringify({
        response: body.response, expectedArrivalAt: body.response === 'attending_later' ? body.expectedArrivalAt : null,
        timeZone: 'Asia/Shanghai', expectedSignupRevision: current.signupRevision, confirmedContentRevision: wipe.contentRevision }) });
      return res.status(result.status).json(result.body);
    }
    if (body.action === 'callback' && fixture) return res.json(await nativeCallback(body, fixture));
    if (body.action === 'fault') {
      assert.ok(['discord', 'kook'].includes(body.platform));
      assert.ok(['response_lost', 'known-failure', 'rate_limit'].includes(body.kind));
      assert.ok(body.kind !== 'known-failure' || body.platform === 'discord', 'KNOWN_REJECTION_SUPPORTED_FOR_DISCORD');
      const scenario = body.kind === 'known-failure' ? { kind: 'response', response: { status: 403, headers: {}, body: { code: 50013, message: 'Constructed missing permissions' } } }
        : { kind: body.kind, ...(body.kind === 'rate_limit' ? { retryAfterMs: 30_000 } : {}) };
      transport.enqueue({ ...scenario, operation: 'send', platform: body.platform });
      return res.json({ queued: true, platform: body.platform, kind: body.kind });
    }
    if (body.action === 'inspect') {
      const refs = transport.getMessages().map(m => ({ platform: m.platform, targetId: m.targetId, guildId: m.guildId, channelId: m.channelId,
        messageId: m.messageId, messageUrl: null, editCount: m.editCount, deleted: m.deleted }));
      return res.json({ runtime: owner.diagnostics(), integrity: db.prepare('PRAGMA integrity_check').get().integrity_check,
        wipes: scheduling.repo.all('wipes').map(w => ({ id: w.id, title: w.title, lifecycle: w.lifecycle, revision: w.revision, contentRevision: w.contentRevision })),
        deliveries: system.service.repo.all('deliveries').map(d => system.service.deliveryDTO(operator(), d)), messageRefs: refs,
        sendCount: transport.getCalls().filter(c => c.operation === 'send').length,
        editCount: transport.getCalls().filter(c => c.operation === 'edit').length, privateReplyCount: transport.getPrivateReplies().length,
        signupCount: scheduling.repo.all('signups').length });
    }
    res.sendStatus(422);
  }
  app.post('/__g06/control', requireControl, express.json({ limit: '8kb' }), (req, res) => {
    const job = control(req, res); controls.add(job);
    job.then(() => controls.delete(job), () => { controls.delete(job); if (!res.headersSent) res.status(422).json({ error: { errorCode: 'ISOLATED_CONTROL_INVALID' } }); });
  });
  app.use('/api', apiRouter);
  app.use('/api', (_req, res) => res.status(404).json({ error: { errorCode: 'RESOURCE_NOT_FOUND' } }));
  if (process.env.G06_FRONTEND_MODE === 'dev') {
    const { createServer: createViteServer } = await import('vite');
    const { default: react } = await import('@vitejs/plugin-react');
    vite = await createViteServer({ root, configFile: false, envFile: false, envDir: false, plugins: [react()], appType: 'spa',
      server: { middlewareMode: true, host: '127.0.0.1', allowedHosts: ['127.0.0.1'], hmr: { server },
        fs: { strict: true, allow: [root], deny: ['.env', '.env.*', '*.{crt,pem}', '**/.git/**', '**/work/**'] } } });
    app.use(vite.middlewares);
  } else {
    const dist = path.join(root, 'dist'); await access(path.join(dist, 'index.html'));
    app.use(express.static(dist)); app.get(/^(?!\/api).*/, (_req, res) => res.sendFile('index.html', { root: dist }));
  }
  app.use((_error, _req, res, _next) => { if (!res.headersSent) res.status(503).json({ error: { errorCode: 'ISOLATED_RUNTIME_FAILURE' } }); });
  ready = true; apiRouter.v2Runtime.start();
  const metadata = { ready: true, createdAt: new Date().toISOString(), origin, runDir, pid: process.pid,
    mode: process.env.G06_FRONTEND_MODE, sqliteFile: process.env.NB_SQLITE_FILE,
    rootLogin: { username: 'root', password: rootPassword, endpoint: '/api/v2/auth/password', page: '/login?returnTo=%2Fadmin' },
    control: { endpoint: '/__g06/control', header: 'x-g06-control', token: controlToken, requiresOrigin: origin,
      actions: ['fault', 'tick', 'member-login', 'signup', 'callback', 'inspect'], knownFailurePlatform: 'discord' },
    memberLogin: { endpoint: '/__g06/control', action: 'member-login', fixtures: fixtures.map(({ key, displayName, memberId, accountId }) => ({ key, displayName, memberId, accountId })) },
    wipeIds: wipes.map(w => w.id), targetIds: targets.map(t => t.id) };
  await writeFile(path.join(runDir, 'runtime.json'), JSON.stringify(metadata, null, 2), { mode: 0o600, flag: 'wx' });
  console.log(JSON.stringify({ ready: true, origin, runDir, metadata: path.join(runDir, 'runtime.json') }));
}
main().catch(async error => {
  console.error(JSON.stringify({ errorCode: typeof error?.code === 'string' ? error.code : 'G06_RUNTIME_START_FAILED' }));
  await shutdown().catch(() => {}); process.exitCode = 1;
});
