import '../v2-baseline/loopback-only.mjs';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { access, appendFile, readFile, writeFile, realpath } from 'node:fs/promises';
import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import path from 'node:path';
import express from 'express';
import { root, validateRuntimeEnvironment } from './config.mjs';
import { saveBrowserEvidence } from './evidence.mjs';
import { fixtures, seedIdentities, controlledProviders } from './fixtures.mjs';
import { installIdentitySchema, IdentityRepository } from '../../../server/v2/identity/repository.js';
import { planIdentityMigration, applyIdentityMigration } from '../../../server/v2/identity/migration.js';
import { IdentityService } from '../../../server/v2/identity/service.js';
import { createIdentityRouter } from '../../../server/v2/identity/routes.js';
import { IdentityError } from '../../../server/v2/identity/errors.js';
import { installSchedulingSchema, SchedulingRepository } from '../../../server/v2/scheduling/repository.js';
import { planSchedulingMigration, applySchedulingMigration } from '../../../server/v2/scheduling/migration.js';
import { createSchedulingRouter } from '../../../server/v2/scheduling/routes.js';
import { openSqliteDatabase, closeSqliteDatabases } from '../../../server/storage/sqlite.js';

validateRuntimeEnvironment();
const runDir = process.env.G05_RUN_DIR;
assert.equal(await realpath(runDir), runDir);
await assert.rejects(access(process.env.NB_SQLITE_FILE), { code: 'ENOENT' }, 'Each runtime must start with a fresh SQLite database');
const { createMemberSpaceRouter } = await import('../../../server/v2/member-space/routes.js');
const db = await openSqliteDatabase();
installIdentitySchema(db); const identityRepo = new IdentityRepository(db);
const identityMigration = applyIdentityMigration(identityRepo, planIdentityMigration({}));
installSchedulingSchema(db); const schedulingRepo = new SchedulingRepository(db);
const schedulingMigration = applySchedulingMigration(schedulingRepo, planSchedulingMigration({}));
seedIdentities(identityRepo);
const app = express(), server = createServer(app);
let vite;
await new Promise((resolve, reject) => { server.once('error', reject); server.listen(Number(process.env.G05_PORT), '127.0.0.1', resolve); });
const origin = `http://127.0.0.1:${server.address().port}`;
process.env.NB_V2_PUBLIC_ORIGIN = origin;
const controlToken = randomBytes(32).toString('base64url');
const controlled = controlledProviders(origin), steamTickets = new Map();
const identity = new IdentityService(identityRepo, { providers: controlled.providers });
const escape = value => String(value).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
function html(title, body) {
  return `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>${escape(title)}</title><style>body{margin:60px auto;max-width:860px;padding:30px;background:#0e1216;color:#e8edf2;font:16px system-ui}a{display:block;padding:18px;margin:10px 0;background:#1a232b;color:#b3ef74;border:1px solid #35434c;border-radius:8px;text-decoration:none}small,p{color:#aab7c3;line-height:1.8}</style><h1>${escape(title)}</h1><p>仅用于 G05 本地验收。平台身份、角色和 Steam 所有权均为构造数据，未连接真实外部平台。</p>${body}</html>`;
}
const steam = {
  authorizationUrl(returnTo) {
    const token = randomBytes(24).toString('base64url'); steamTickets.set(token, { returnTo, expiresAt: Date.now() + 60_000 });
    return `${origin}/api/v2/__fixtures/steam?ticket=${token}`;
  },
  async verify(query, returnTo) {
    const proof = steamTickets.get(query.fixtureProof); steamTickets.delete(query.fixtureProof);
    if (!proof?.steamId || proof.returnTo !== returnTo || proof.expiresAt < Date.now()) throw new IdentityError('AUTH_INVALID_CALLBACK', 401);
    return proof.steamId;
  }
};
const identityRouter = createIdentityRouter({ service: identity, origin, providers: controlled.providers, steam });
const traces = [], faults = [];
let ready = false, fixtureData;
app.disable('x-powered-by');
app.use((req, res, next) => {
  if (req.socket.remoteAddress !== '127.0.0.1' || req.get('host') !== new URL(origin).host) return res.status(400).json({ error: { errorCode: 'ISOLATED_ORIGIN_REQUIRED' } });
  res.set({ 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer', 'X-Content-Type-Options': 'nosniff' });
  next();
});
// This one fixture-only route accepts screenshot payloads. All other fixture bodies remain capped at 8kb.
app.post('/api/v2/__fixtures/evidence', requireControl, express.json({ limit: '3mb' }), async (req, res, next) => {
  try { const saved = await saveBrowserEvidence(runDir, req.body); res.status(saved.replayed ? 200 : 201).json(saved); }
  catch (error) { next(error); }
});
app.use('/api/v2/__fixtures', express.json({ limit: '8kb' }));
app.get('/api/v2/__fixtures/health', (_req, res) => res.status(ready ? 200 : 503).json({ ready, isolated: true, origin, pid: process.pid,
  identitySchema: identityRepo.scalar('v2IdentitySchemaVersion'), schedulingSchema: schedulingRepo.scalar('v2SchedulingSchemaVersion'),
  identityMigration: Boolean(identityRepo.scalar('v2IdentityMigration')), schedulingMigration: Boolean(schedulingRepo.scalar('v2SchedulingMigration')) }));
app.get('/api/v2/__fixtures/manifest', (_req, res) => res.json({ fixtures, ...fixtureData, externalAuthentication: 'constructed local adapters' }));
app.get('/api/v2/__fixtures/oauth/:provider', (req, res) => {
  if (!controlled.providers[req.params.provider] || typeof req.query.state !== 'string') return res.sendStatus(400);
  res.type('html').send(html('选择构造平台账号', fixtures.map(f => `<a data-fixture="${f.key}" href="${origin}/api/v2/__fixtures/oauth/${req.params.provider}/select?${escape(new URLSearchParams({ state: req.query.state, fixture: f.key }))}">${escape(f.displayName)} · ${f.key}<br><small>${f.key === 'new' ? '首次登录，需要绑定 Steam' : f.key === 'denied' ? '平台资格不足' : `已绑定成员 / ${f.roleId}`}</small></a>`).join('')));
});
app.get('/api/v2/__fixtures/oauth/:provider/select', (req, res, next) => {
  try {
    if (typeof req.query.state !== 'string' || req.query.state.length > 1000) return res.sendStatus(400);
    const code = controlled.ticket(req.params.provider, req.query.fixture);
    res.cookie('g05_fixture_actor', req.query.fixture, { httpOnly: true, sameSite: 'strict', path: '/api/v2/__fixtures', maxAge: 600_000 });
    res.redirect(303, `${origin}/api/v2/auth/${req.params.provider}/callback?${new URLSearchParams({ state: req.query.state, code })}`);
  } catch (error) { next(error); }
});
app.get('/api/v2/__fixtures/steam', (req, res) => {
  const ticket = steamTickets.get(req.query.ticket);
  if (!ticket || ticket.expiresAt < Date.now()) return res.status(410).send('构造 Steam 上下文已过期，请返回重试。');
  const selected = String(req.headers.cookie || '').split(';').map(s => s.trim()).find(s => s.startsWith('g05_fixture_actor='))?.split('=')[1];
  const fixture = fixtures.find(f => f.key === selected);
  if (!fixture) return res.sendStatus(400);
  res.type('html').send(html('构造 Steam 身份确认', `<p>当前构造身份：${escape(fixture.displayName)}，Steam：${fixture.steamId}</p><a data-fixture-steam="${fixture.key}" href="${origin}/api/v2/__fixtures/steam/confirm?${escape(new URLSearchParams({ ticket: req.query.ticket, fixture: fixture.key }))}">确认此构造 Steam 身份并返回</a>`));
});
app.get('/api/v2/__fixtures/steam/confirm', (req, res) => {
  const ticket = steamTickets.get(req.query.ticket); steamTickets.delete(req.query.ticket);
  const fixture = fixtures.find(f => f.key === req.query.fixture);
  if (!ticket || ticket.expiresAt < Date.now() || !fixture) return res.sendStatus(410);
  const proof = randomBytes(24).toString('base64url'); steamTickets.set(proof, { ...ticket, steamId: fixture.steamId });
  const target = new URL(ticket.returnTo); target.searchParams.set('fixtureProof', proof); res.redirect(303, target.href);
});
function requireControl(req, res, next) {
  const supplied = Buffer.from(req.get('x-g05-control') || '');
  if (req.get('origin') !== origin || supplied.length !== controlToken.length || !timingSafeEqual(supplied, Buffer.from(controlToken))) return res.status(403).json({ error: { errorCode: 'FIXTURE_CONTROL_DENIED' } });
  next();
}
app.post('/api/v2/__fixtures/control', requireControl, async (req, res, next) => {
  try {
    const body = req.body || {}, fixture = fixtures.find(f => f.key === body.fixture);
    if (body.action === 'fault') {
      if (!['GET', 'PUT', 'PATCH'].includes(body.method) || !/^\/api\/v2\/(?:member(?:-space)?(?:\/|$)|bootstrap$|me(?:\/|$)|home(?:\/|$)|wipes\/|operations\/)/.test(body.path) ||
        !['delay', 'disconnect-before', 'disconnect-after', 'unavailable'].includes(body.mode)) return res.sendStatus(422);
      const fault = { id: randomUUID(), method: body.method, path: body.path, mode: body.mode, accountId: fixture?.accountId || null, delayMs: Math.min(30_000, Math.max(1, Number(body.delayMs) || 1500)) };
      faults.push(fault); return res.json({ queued: fault });
    }
    if (body.action === 'clear-faults') { faults.length = 0; return res.json({ cleared: true }); }
    if (body.action === 'revoke' && fixture?.accountId) { identity.revokeAccountScope(fixture.accountId, 'g05_controlled_revocation'); return res.json({ revoked: fixture.accountId }); }
    if (body.action === 'eligibility' && fixture && ['eligible', 'denied', 'unavailable'].includes(body.status)) {
      controlled.denied.delete(fixture.key); controlled.unavailable.delete(fixture.key);
      if (body.status === 'denied') controlled.denied.add(fixture.key);
      if (body.status === 'unavailable') controlled.unavailable.add(fixture.key);
      for (const e of identityRepo.all('eligibility').filter(e => e.externalId.endsWith(`_${fixture.key}`))) identityRepo.put('eligibility', { ...e, expiresAt: new Date(0).toISOString() });
      return res.json({ fixture: fixture.key, status: body.status });
    }
    if (body.action === 'reschedule') {
      const id = body.wipeId || fixtureData.nextWipeId;
      const current = schedulingRepo.get('wipes', id); if (!current) return res.sendStatus(404);
      const admin = await fixtureClient('admin');
      const result = await api(admin, `/wipes/${id}`, { method: 'PATCH', body: { expectedRevision: current.revision,
        musterAt: new Date(Date.parse(current.musterAt) + Math.min(240, Math.max(1, Number(body.minutes) || 30)) * 60_000).toISOString() }, operationId: randomUUID() });
      return res.status(result.status).json(result.payload);
    }
    if (body.action === 'signup' && fixture?.accountId) {
      const client = await fixtureClient(fixture.key), wipeId = body.wipeId || fixtureData.nextWipeId;
      const wipe = await api(client, `/wipes/${wipeId}`), signup = await api(client, `/wipes/${wipeId}/my-signup`);
      if (wipe.status !== 200 || signup.status !== 200) return res.status(wipe.status !== 200 ? wipe.status : signup.status).json(wipe.status !== 200 ? wipe.payload : signup.payload);
      const result = await api(client, `/wipes/${wipeId}/my-signup`, { method: 'PUT', body: { response: body.response || 'not_attending', expectedArrivalAt: null,
        timeZone: 'Asia/Shanghai', expectedSignupRevision: signup.payload.data.signupRevision, confirmedContentRevision: wipe.payload.data.contentRevision }, operationId: randomUUID() });
      return res.status(result.status).json(result.payload);
    }
    if (body.action === 'inspect') return res.json({ traces, faults, integrity: db.prepare('PRAGMA integrity_check').get().integrity_check,
      signups: schedulingRepo.all('signups'), receipts: schedulingRepo.all('receipts').map(r => r.operationReceipt), events: identityRepo.all('events') });
    res.sendStatus(422);
  } catch (error) { next(error); }
});
app.use('/api/v2', (req, res, next) => {
  const fullPath = `/api/v2${req.path}`;
  let accountId;
  try {
    const session = String(req.headers.cookie || '').split(';').map(s => s.trim()).find(s => s.startsWith('nb_v2_session='))?.slice('nb_v2_session='.length);
    if (session) accountId = identity.session(session).actor.id;
  } catch {}
  const index = faults.findIndex(f => f.path === fullPath && f.method === req.method && (!f.accountId || f.accountId === accountId));
  const fault = index >= 0 ? faults.splice(index, 1)[0] : null;
  if (fault?.mode === 'disconnect-before') return req.socket.destroy();
  if (fault?.mode === 'unavailable') return res.status(503).json({ error: { errorCode: 'MEMBER_SPACE_UNAVAILABLE', retryable: true } });
  const originalJson = res.json.bind(res);
  res.json = payload => {
    if (/\/(?:my-signup|operations)(?:\/|$)/.test(fullPath)) {
      const record = { at: new Date().toISOString(), path: fullPath, method: req.method, operationId: req.get('Idempotency-Key') || null,
        body: req.body || null, status: res.statusCode, errorCode: payload?.error?.errorCode || null, fault: fault?.mode || null };
      traces.push(record); appendFile(path.join(runDir, 'http.jsonl'), `${JSON.stringify(record)}\n`).catch(() => {});
    }
    if (fault?.mode === 'disconnect-after') { req.socket.destroy(); return res; }
    if (fault?.mode === 'delay') { setTimeout(() => { if (!res.destroyed) originalJson(payload); }, fault.delayMs).unref(); return res; }
    return originalJson(payload);
  };
  req.v2Identity = { service: identity, authenticate: options => identityRouter.authenticate(options)(req) };
  next();
});
app.use('/api/v2', identityRouter, createSchedulingRouter(), createMemberSpaceRouter());
app.use('/api', (_req, res) => res.status(404).json({ error: { errorCode: 'ISOLATED_ROUTE_NOT_FOUND' } }));
app.use((error, _req, res, _next) => res.status(error.status || 500).json({ error: { errorCode: error.errorCode || 'ISOLATED_RUNTIME_ERROR' } }));
if (process.env.G05_FRONTEND_MODE === 'dev') {
  const { createServer: createViteServer } = await import('vite');
  const { default: react } = await import('@vitejs/plugin-react');
  vite = await createViteServer({ root, configFile: false, envFile: false, envDir: false, plugins: [react()], appType: 'spa',
    server: { middlewareMode: true, hmr: { server }, host: '127.0.0.1', allowedHosts: ['127.0.0.1'], fs: { strict: true, allow: [root] } } });
  app.use(vite.middlewares);
} else {
  const dist = path.join(root, 'dist'); await access(path.join(dist, 'index.html'));
  app.use(express.static(dist)); app.use((_req, res) => res.sendFile('index.html', { root: dist }));
}
async function raw(client, url, options = {}) {
  const response = await fetch(url, { redirect: 'manual', ...options, headers: { origin,
    cookie: [...client.jar].map(([k,v]) => `${k}=${v}`).join('; '), ...options.headers } });
  for (const line of response.headers.getSetCookie()) { const [k,v] = line.split(';')[0].split('='); v ? client.jar.set(k,v) : client.jar.delete(k); }
  const payload = response.headers.get('content-type')?.includes('json') ? await response.json() : await response.text();
  return { status: response.status, location: response.headers.get('location'), payload };
}
async function fixtureClient(key) {
  const client = { jar: new Map() };
  const start = await raw(client, `${origin}/api/v2/auth/discord/start?returnTo=/member`);
  const state = new URL(start.location).searchParams.get('state');
  let reply = await raw(client, `${origin}/api/v2/__fixtures/oauth/discord/select?${new URLSearchParams({ state, fixture: key })}`);
  for (let i = 0; i < 4 && reply.location?.startsWith(`${origin}/api/v2/auth/`); i++) reply = await raw(client, reply.location);
  const me = await raw(client, `${origin}/api/v2/auth/me`);
  assert.equal(me.status, 200, JSON.stringify(me)); client.csrf = me.payload.data.csrfToken; return client;
}
async function api(client, route, { method = 'GET', body, operationId } = {}) {
  return raw(client, `${origin}/api/v2${route}`, { method, headers: { 'content-type': 'application/json', 'x-csrf-token': client.csrf,
    ...(operationId ? { 'Idempotency-Key': operationId } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
}
async function seedScheduling() {
  const admin = await fixtureClient('admin');
  for (const f of fixtures.filter(f => f.accountId)) await identity.checkEligibility('discord', `discord_g05_${f.key}`);
  const now = Date.now(), at = hours => new Date(now + hours * 3_600_000).toISOString();
  const ownAudience = { squadIds: ['g05_squad'], memberIds: [], includeUnassigned: true };
  const records = [];
  for (let i = 0; i < 3; i++) {
    let reply = await api(admin, '/wipes', { method: 'POST', operationId: randomUUID(), body: {
      title: ['周四主服开荒', '周末集结', '下周长档'][i], description: '集合前进入一队语音。优先落点建家，首小时保持队伍沟通。',
      serverProfileId: 'g05_local_server', serverSnapshot: { id: 'g05_local_server', name: 'Rustoria EU Main · 本地构造', address: '127.0.0.1', region: 'EU' },
      audience: ownAudience, timeZone: 'Asia/Shanghai', autoOpenSignup: true, signupOpensAt: at(-1), signupClosesAt: at(22),
      musterAt: at(24 + i * 24), serverScheduledWipeAt: at(24.5 + i * 24), serverScheduleSource: 'manual', autoStart: false
    } });
    assert.equal(reply.status, 201, JSON.stringify(reply)); let wipe = reply.payload.data.current;
    reply = await api(admin, `/wipes/${wipe.id}/commands/publish`, { method: 'POST', operationId: randomUUID(), body: { expectedRevision: wipe.revision } });
    assert.equal(reply.status, 200, JSON.stringify(reply)); records.push(reply.payload.data.current);
  }
  records.sort((a,b) => a.id.localeCompare(b.id));
  const target = records.at(-1);
  const adjusted = await api(admin, `/wipes/${target.id}`, { method: 'PATCH', operationId: randomUUID(), body: {
    expectedRevision: target.revision, title: '今晚北境一队 · 主服开荒', musterAt: at(4), serverScheduledWipeAt: at(4.5), signupClosesAt: at(3.5)
  } });
  assert.equal(adjusted.status, 200, JSON.stringify(adjusted));
  const foreign = await api(admin, '/wipes', { method: 'POST', operationId: randomUUID(), body: {
    title: '二队专属开荒（不可见）', description: '受众隔离构造场次', serverProfileId: 'g05_local_server', serverSnapshot: { name: '二队服务器' },
    audience: { squadIds: ['g05_foreign_squad'], memberIds: [], includeUnassigned: false }, timeZone: 'Asia/Shanghai', autoOpenSignup: true,
    signupOpensAt: at(-1), signupClosesAt: at(1), musterAt: at(2), serverScheduledWipeAt: at(2.5), serverScheduleSource: 'manual', autoStart: false
  } });
  assert.equal(foreign.status, 201, JSON.stringify(foreign)); const foreignWipe = foreign.payload.data.current;
  assert.equal((await api(admin, `/wipes/${foreignWipe.id}/commands/publish`, { method: 'POST', operationId: randomUUID(), body: { expectedRevision: foreignWipe.revision } })).status, 200);
  const beta = await fixtureClient('beta'), latest = adjusted.payload.data.current;
  const signup = await api(beta, `/wipes/${latest.id}/my-signup`, { method: 'PUT', operationId: randomUUID(), body: {
    response: 'attending_on_time', expectedArrivalAt: null, timeZone: 'Asia/Shanghai', expectedSignupRevision: 0, confirmedContentRevision: latest.contentRevision
  } });
  assert.equal(signup.status, 200, JSON.stringify(signup));
  return { nextWipeId: latest.id, firstOwnIdCursorWipeId: records[0].id, ownWipeIds: records.map(w => w.id), foreignWipeId: foreignWipe.id };
}
fixtureData = await seedScheduling(); ready = true;
const metadata = { ready, createdAt: new Date().toISOString(), cwd: root, runDir, pid: process.pid, origin, sqliteFile: process.env.NB_SQLITE_FILE,
  mode: process.env.G05_FRONTEND_MODE, controlToken, fixtures, ...fixtureData, identityMigration, schedulingMigration,
  environmentKeys: Object.keys(process.env).sort(), backgroundJobs: false, realPlatformDelivery: false,
  externalAuthentication: 'Controlled local OAuth, eligibility and Steam adapters; real callbacks, V2 sessions, CSRF, member routes and SQLite business writes.',
  routerWiring: ['createIdentityRouter', 'createSchedulingRouter', 'createMemberSpaceRouter'],
  limitation: 'Direct exported business routers with controlled identity adapters; no legacy createApiRouter startup or external-provider acceptance is claimed.',
  networkGuard: 'Existing G01 Node loopback-only guard; defense in depth, not an OS-wide sandbox.' };
await writeFile(path.join(runDir, 'runtime.json'), JSON.stringify(metadata, null, 2), { mode: 0o600 });
await writeFile(path.join(root, 'work/g05/runtime-latest.json'), JSON.stringify({ runDir, origin, pid: process.pid, metadata: path.join(runDir, 'runtime.json') }, null, 2), { mode: 0o600 });
console.log(JSON.stringify({ ready: true, origin, runDir, metadata: path.join(runDir, 'runtime.json'), nextWipeId: fixtureData.nextWipeId }));
let closing = false;
async function close(signal) {
  if (closing) return; closing = true; ready = false;
  await vite?.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
  await closeSqliteDatabases({ checkpointMode: 'TRUNCATE' });
  await writeFile(path.join(runDir, 'shutdown.json'), JSON.stringify({ at: new Date().toISOString(), signal, closed: true }));
}
for (const signal of ['SIGINT','SIGTERM']) process.once(signal, () => close(signal).then(() => process.exit(0)));
