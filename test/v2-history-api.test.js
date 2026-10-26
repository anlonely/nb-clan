import { fixtureIdentity, FakeScopedIdentityService } from './support/scoped-identity-fake.mjs';
import { fixtureSessionFactory } from './support/authenticated-session.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { createServer, request as httpRequest } from 'node:http';
import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import express from 'express';
import { installIdentitySchema, IdentityRepository } from '../server/v2/identity/repository.js';
import { IdentityService } from '../server/v2/identity/service.js';
import { createIdentityRouter } from '../server/v2/identity/routes.js';
import { CAPABILITIES, grant } from '../server/v2/identity/permissions.js';
import { installSchedulingSchema, SchedulingRepository } from '../server/v2/scheduling/repository.js';
import { SchedulingService } from '../server/v2/scheduling/service.js';
import { AdminHistoryService, HISTORY_CHANGED_FIELDS } from '../server/v2/admin-history/service.js';
import { createAdminHistoryRouter } from '../server/v2/admin-history/routes.js';

const code = expected => error => error.errorCode === expected;
const sortEvents = rows => rows.sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id));
const ALL = { type: 'all' }, S1 = { type: 'squads', ids: ['s1'] };
function fixture(t, { file = ':memory:', scopeContract = false } = {}) {
  const db = new DatabaseSync(file);
  t.after(() => { try { db.close(); } catch {} });
  installIdentitySchema(db); installSchedulingSchema(db);
  const ir = new IdentityRepository(db), sr = new SchedulingRepository(db);
  ir.setScalar('v2IdentityMigration', { sourceHash: 'g06-history-local' });
  sr.setScalar('v2SchedulingMigration', { sourceHash: 'g06-history-local' });
  const clock = { now: Date.parse('2030-09-08T10:00:00.000Z') };
  const identity = fixtureIdentity(ir, { scopeContract, now: () => clock.now });
  for (const id of ['s1', 's2']) ir.put('squads', { id, name: id });
  for (let index = 1; index <= 3; index++) {
    const id = `private-member-${index}`, steamId = `7656119800000000${index}`;
    ir.put('members', { id, steamId, displayName: `当前成员${index}`, memberStatus: 'active', revision: 1,
      phone: 'sensitive-phone', internalNote: 'sensitive-note' });
    ir.put('accounts', { id: `private-account-${index}`, memberId: id, status: 'active', revision: 1, permissionVersion: 1, grants: [] });
    ir.put('bindings', { id: `binding-${index}`, accountId: `private-account-${index}`, memberId: id, steamId, status: 'verified' });
    ir.put('squadMembers', { id: `sm-${index}`, memberId: id, squadId: index === 3 ? 's2' : 's1' });
  }
  const account = (id, grants) => ir.put('accounts', { id, memberId: null, roleId:id==='admin'?'admin':'member',adminAssignedByOwner:id==='admin',status: 'active', revision: 1, permissionVersion: 1, grants });
  account('admin', CAPABILITIES.map(capability => grant(capability, ALL)));
  account('ops', [grant('wipes.read', ALL), grant('wipes.edit', ALL), grant('signups.read', S1)]);
  account('leader', ['wipes.read', 'signups.delegate', 'signups.read', 'members.read'].map(capability => grant(capability, S1)));
  const scheduling = new SchedulingService(sr, identity, { now: () => clock.now });
  const history = new AdminHistoryService(identity);
  const actor = id => identity.actorForAccount(id);
  const options = source => ({ operationId: `private-operation-${randomUUID()}`, source: source || 'web' });
  const create = (title = '本地档期', squadIds = ['s1']) => {
    const draft = scheduling.createWipe(actor('admin'), { title, description: '公开安排', serverProfileId: 'private-server-id',
      serverSnapshot: { name: 'Local server', secret: 'sensitive-server-token' }, timeZone: 'Asia/Shanghai',
      musterAt: '2030-09-08T12:00:00.000Z', serverScheduledWipeAt: '2030-09-08T11:00:00.000Z',
      signupOpensAt: '2030-09-08T09:00:00.000Z', signupClosesAt: '2030-09-08T13:00:00.000Z', autoStart: true,
      audience: { squadIds, memberIds: [], includeUnassigned: false } }, options()).current;
    return scheduling.transition(actor('admin'), draft.id, 'publish', { expectedRevision: draft.revision }, options()).current;
  };
  const wipe = create();
  const signup = (index, currentWipe = wipe, { revision = 0, response = 'attending_on_time', delegate = false, source = 'web', reason } = {}) => {
    const memberId = `private-member-${index}`;
    return scheduling.saveSignup(actor(delegate ? 'admin' : `private-account-${index}`), currentWipe.id, memberId,
      { response, expectedArrivalAt: response === 'attending_later' ? '2030-09-08T15:00:00.000Z' : null, timeZone: 'Asia/Shanghai',
        expectedSignupRevision: revision, confirmedContentRevision: currentWipe.contentRevision, ...(reason ? { reason } : {}) },
      { ...options(source), delegate });
  };
  const edit = (currentWipe = wipe, patch = {}) => scheduling.updateWipe(actor('admin'), currentWipe.id,
    { expectedRevision: sr.get('wipes', currentWipe.id).revision, title: `本地修改-${randomUUID()}`, ...patch }, options()).current;
  return { db, ir, sr, identity, scheduling, history, actor, options, wipe, create, signup, edit, clock };
}

test('real G04 lifecycle, delegated reply, withdrawal and archive revisions project from committed events', t => {
  const f = fixture(t, { scopeContract: true }), admin = f.actor('admin');
  f.signup(1); f.signup(1, f.wipe, { revision: 1, response: null, delegate: true, reason: '成员委托撤回', source: 'discord' });
  f.edit(f.wipe, { musterAt: '2030-09-08T12:30:00.000Z' });
  let w = f.sr.get('wipes', f.wipe.id);
  w = f.scheduling.transition(admin, w.id, 'start', { expectedRevision: w.revision }, f.options()).current;
  w = f.scheduling.transition(admin, w.id, 'end', { expectedRevision: w.revision, outcome: 'aborted', reason: '服务器故障' }, f.options()).current;
  w = f.scheduling.transition(admin, w.id, 'archive', { expectedRevision: w.revision, completeness: 'missing', reason: '缺数据归档' }, f.options()).current;
  f.scheduling.transition(admin, w.id, 'revise-archive', { expectedRevision: w.revision, baseArchiveRevision: 1,
    completeness: 'complete', reason: '补齐数据', data: { privateSettlement: 'sensitive-settlement' } }, f.options());
  const result = f.history.list(admin, w.id);
  assert.equal(result.countScope, 'authorized_events'); assert.equal(result.items.length, 9); assert.equal(result.nextCursor, null);
  assert.deepEqual(result.items.map(e => e.id), sortEvents(f.sr.forWipe('events', w.id)).map(e => e.id));
  const delegated = result.items.find(e => e.action === 'signup.delegate');
  assert.equal(delegated.signup.response, null); assert.equal(delegated.signup.signupRevision, 2);
  assert.equal(delegated.reason, '成员委托撤回'); assert.equal(delegated.state, null);
  assert.deepEqual(delegated.subject, { label: '当前成员1', labelSource: 'current' });
  assert.equal(result.items.find(e => e.action === 'wipe.edit').contentRevision, 2);
  assert.ok(result.items.find(e => e.action === 'wipe.edit').changedFields.includes('musterAt'));
  assert.equal(result.items.find(e => e.action === 'wipe.revise-archive').state.archiveRevision, 2);
  assert.equal(result.items.find(e => e.action === 'wipe.end').state.outcome, 'aborted');
  assert.ok(result.items.every(e => e.occurredAt === '2030-09-08T10:00:00.000Z'));
});

test('ordinary member, cross-squad, explicit deny and retired actor are rejected', t => {
  const f = fixture(t, { scopeContract: true });
  assert.throws(() => f.history.list(f.actor('private-account-1'), f.wipe.id), code('ACCESS_DENIED'));
  const other = f.create('二队档期', ['s2']);
  assert.throws(() => f.history.list(f.actor('leader'), other.id), code('RESOURCE_NOT_FOUND'));
  assert.throws(() => f.history.list(f.actor('admin'), 'missing-wipe'), code('RESOURCE_NOT_FOUND'));
  f.ir.put('accounts', { ...f.ir.get('accounts', 'ops'), grants: [...f.ir.get('accounts', 'ops').grants,
    { capability: 'wipes.edit', scope: ALL, effect: 'deny' }] });
  assert.throws(() => f.history.list(f.actor('ops'), f.wipe.id), code('ACCESS_DENIED'));
  const old = f.actor('admin');
  f.ir.put('accounts', { ...f.ir.get('accounts', 'admin'), permissionVersion: 2 });
  assert.throws(() => f.history.list(old, f.wipe.id), code('PERMISSIONS_CHANGED'));
  f.ir.put('accounts', { ...f.ir.get('accounts', 'admin'), status: 'disabled' });
  assert.throws(() => f.history.list(old, f.wipe.id), code('ACCOUNT_DISABLED'));
});

test('subject scope is filtered before LIMIT and reveals no hidden row counts', t => {
  const f = fixture(t, { scopeContract: true }), mixed = f.create('联合档期', ['s1', 's2']);
  f.signup(1, mixed); f.signup(2, mixed);
  f.clock.now += 1000;
  for (let revision = 0; revision < 12; revision++) f.signup(3, mixed, { revision, response: revision % 2 ? 'not_attending' : 'attending_on_time' });
  const a = f.actor('ops'), expected = sortEvents(f.sr.forWipe('events', mixed.id)).filter(e => e.memberId !== 'private-member-3').map(e => e.id);
  const first = f.history.list(a, mixed.id, { limit: 2 });
  assert.equal(first.items.length, 2); assert.ok(first.nextCursor);
  const second = f.history.list(a, mixed.id, { limit: 2, cursor: first.nextCursor });
  assert.equal(second.items.length, 2); assert.equal(second.nextCursor, null);
  assert.deepEqual([...first.items, ...second.items].map(e => e.id), expected);
  assert.deepEqual(Object.keys(first).sort(), ['countScope', 'items', 'nextCursor', 'wipeId']);
  assert.ok(first.items.filter(e => e.subject).every(e => e.subject.label === null));
});

test('explicit subject deny defeats broad allow, including current membership changes between pages', t => {
  const f = fixture(t, { scopeContract: true }), mixed = f.create('联合档期', ['s1', 's2']);
  f.signup(1, mixed); f.signup(2, mixed); f.signup(3, mixed);
  f.ir.put('accounts', { ...f.ir.get('accounts', 'ops'), grants: [grant('wipes.read', ALL), grant('wipes.edit', ALL), grant('signups.read', ALL),
    { capability: 'signups.read', scope: { type: 'squads', ids: ['s2'] }, effect: 'deny' }] });
  let result = f.history.list(f.actor('ops'), mixed.id);
  assert.equal(result.items.filter(e => e.type === 'signup.changed').length, 2);
  f.ir.put('squadMembers', { id: 'sm-2', memberId: 'private-member-2', squadId: 's2' });
  result = f.history.list(f.actor('ops'), mixed.id);
  assert.equal(result.items.filter(e => e.type === 'signup.changed').length, 1);
});

test('DTO omits private identifiers, source payloads and raw snapshots; labels use current authorized names', t => {
  const f = fixture(t, { scopeContract: true }); f.signup(1);
  f.edit(f.wipe, { reason: `\u0000需核实\n${'说'.repeat(600)}`, description: 'sensitive-description' });
  f.edit(f.wipe, { reason: { privateObject: 'sensitive-reason-object' } });
  f.ir.put('members', { ...f.ir.get('members', 'private-member-1'), displayName: '更名后' });
  const result = f.history.list(f.actor('admin'), f.wipe.id), json = JSON.stringify(result);
  for (const forbidden of ['private-member-', 'private-account-', 'private-operation-', 'private-server-id', 'sensitive-', 'before', 'actorAccountId', 'memberId', 'operationId', 'startEvidence', 'payload_json'])
    assert.equal(json.includes(forbidden), false, forbidden);
  const signup = result.items.find(e => e.type === 'signup.changed');
  assert.deepEqual(signup.actor, { isSelf: false, label: '更名后', labelSource: 'current' });
  assert.deepEqual(signup.subject, { label: '更名后', labelSource: 'current' });
  assert.equal(signup.signup.timeZone, 'Asia/Shanghai');
  const edit = result.items.find(e => e.action === 'wipe.edit' && e.changedFields.includes('description'));
  assert.equal(edit.reason.length, 500); assert.equal(/[\u0000-\u001f]/.test(edit.reason), false);
  assert.ok(edit.changedFields.includes('description'));
  assert.ok(result.items.flatMap(e => e.changedFields).every(field => HISTORY_CHANGED_FIELDS.includes(field)));
  const redacted = f.history.list(f.actor('ops'), f.wipe.id).items.find(e => e.type === 'signup.changed');
  assert.deepEqual(redacted.subject, { label: null, labelSource: 'redacted' });
  assert.deepEqual(redacted.actor, { isSelf: false, label: null, labelSource: 'redacted' });
});

test('initial event watermark excludes inserts on both sides of same-millisecond keyset boundary', t => {
  const f = fixture(t, { scopeContract: true });
  for (let i = 0; i < 10; i++) f.edit();
  const expected = sortEvents(f.sr.forWipe('events', f.wipe.id)).map(e => e.id), a = f.actor('admin');
  let page = f.history.list(a, f.wipe.id, { limit: 3 });
  const found = page.items.map(e => e.id), original = f.sr.forWipe('events', f.wipe.id)[0];
  f.sr.put('events', { ...original, id: 'event_000000000-new-at-old-time' });
  f.sr.put('events', { ...original, id: 'event_zzzzzzzzz-new-at-old-time' });
  f.signup(1); // Changes global rosterRevision, but does not invalidate this snapshot's cursor.
  while (page.nextCursor) {
    page = f.history.list(a, f.wipe.id, { limit: 3, cursor: page.nextCursor });
    found.push(...page.items.map(e => e.id));
  }
  assert.deepEqual(found, expected); assert.equal(new Set(found).size, expected.length);
  const refreshed = f.history.list(a, f.wipe.id, { limit: 50 });
  assert.equal(refreshed.items.length, expected.length + 3);
});

test('cursor tampering, expiry, account/wipe/scope/key changes fail explicitly', t => {
  const f = fixture(t, { scopeContract: true }), other = f.create('另一档');
  f.edit();
  const actor = f.actor('admin'), first = f.history.list(actor, f.wipe.id, { limit: 1 });
  const cursor = first.nextCursor;
  assert.ok(cursor); assert.equal(Buffer.from(cursor, 'base64url').toString('utf8').includes('admin'), false);
  assert.equal(f.history.list(actor, f.wipe.id, { cursor: '' }).items.length, 3);
  for (const invalid of ['bad', cursor.slice(0, 30), `${cursor[0] === 'A' ? 'B' : 'A'}${cursor.slice(1)}`, 'x'.repeat(2500)])
    assert.throws(() => f.history.list(actor, f.wipe.id, { cursor: invalid }), code('CURSOR_EXPIRED'));
  assert.throws(() => f.history.list(f.actor('ops'), f.wipe.id, { cursor }), code('CURSOR_EXPIRED'));
  assert.throws(() => f.history.list(actor, other.id, { cursor }), code('CURSOR_EXPIRED'));
  assert.throws(() => f.history.list(actor, f.wipe.id, { cursor }, { cursorSecret: 'new-session' }), code('CURSOR_EXPIRED'));
  f.ir.put('accounts', { ...f.ir.get('accounts', 'admin'), permissionVersion: 2 });
  assert.throws(() => f.history.list(f.actor('admin'), f.wipe.id, { cursor }), code('CURSOR_EXPIRED'));
  f.ir.put('accounts', { ...f.ir.get('accounts', 'admin'), permissionVersion: 1 });
  f.clock.now += 300_000;
  assert.throws(() => f.history.list(actor, f.wipe.id, { cursor }), code('CURSOR_EXPIRED'));
});

test('read-only service uses no database mutations, bounds queries and returns safe empty pages', t => {
  const f = fixture(t, { scopeContract: true }); for (let i = 0; i < 60; i++) f.edit();
  const before = f.db.prepare('SELECT total_changes() AS n').get().n;
  f.db.exec('PRAGMA query_only=ON');
  assert.equal(f.history.list(f.actor('admin'), f.wipe.id).items.length, 20);
  assert.equal(f.history.list(f.actor('admin'), f.wipe.id, { limit: '999' }).items.length, 50);
  for (const query of [{ limit: '1;DROP TABLE json_records' }, { limit: ['20'] }, { cursor: ['a'] }, { memberId: 'private-member-3' }])
    assert.throws(() => f.history.list(f.actor('admin'), f.wipe.id, query), error => ['INVALID_HISTORY_QUERY', 'CURSOR_EXPIRED'].includes(error.errorCode));
  assert.equal(f.db.prepare('SELECT total_changes() AS n').get().n, before);
  assert.equal(f.db.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
  f.db.exec('PRAGMA query_only=OFF');
  f.sr.put('wipes', { ...f.wipe, id: 'no-committed-events' });
  assert.deepEqual(f.history.list(f.actor('admin'), 'no-committed-events'),
    { wipeId: 'no-committed-events', items: [], nextCursor: null, countScope: 'authorized_events' });
});

test('SQLite close/reopen preserves data while a new process explicitly expires its old cursor', async t => {
  const base = path.resolve('work/v2-orchestration/g06-history'); await mkdir(base, { recursive: true });
  const directory = await mkdtemp(path.join(base, 'restart-')), file = path.join(directory, 'isolated.sqlite');
  t.after(() => rm(directory, { recursive: true, force: true }));
  const f = fixture(t, { file }); for (let i = 0; i < 5; i++) f.edit();
  const first = f.history.list(f.actor('admin'), f.wipe.id, { limit: 2 });
  const expected = sortEvents(f.sr.forWipe('events', f.wipe.id)).map(e => e.id);
  f.db.close();
  const script = `import {DatabaseSync} from 'node:sqlite';
    import {IdentityRepository} from './server/v2/identity/repository.js';
    import {IdentityService} from './server/v2/identity/service.js';
    import {AdminHistoryService} from './server/v2/admin-history/service.js';
    const db=new DatabaseSync(${JSON.stringify(file)}),repo=new IdentityRepository(db);
    const identity=new IdentityService(repo,{now:()=>${f.clock.now}}),history=new AdminHistoryService(identity);
    let errorCode;
    try { history.list(identity.actorForAccount('admin'),${JSON.stringify(f.wipe.id)},
      {limit:50,cursor:${JSON.stringify(first.nextCursor)}}); } catch(error) { errorCode=error.errorCode; }
    const result=history.list(identity.actorForAccount('admin'),${JSON.stringify(f.wipe.id)},{limit:50});
    process.stdout.write(JSON.stringify({errorCode,ids:result.items.map(e=>e.id)}));db.close();`;
  const child = await promisify(execFile)(process.execPath, ['--input-type=module', '-e', script],
    { cwd: process.cwd(), env: { PATH: process.env.PATH, TZ: 'UTC' }, timeout: 15_000 });
  assert.deepEqual(JSON.parse(child.stdout), { errorCode: 'CURSOR_EXPIRED', ids: expected });
});

async function httpRuntime(t) {
  const f = fixture(t), app = express(), server = createServer(app);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const fixtureSession = await fixtureSessionFactory(f.identity);
  const identityRouter = createIdentityRouter({ service: f.identity, origin, providers: {},
    authenticatePassword: async (username, password) => username === 'admin' && password === 'isolated-password' ? 'admin' : null });
  app.use('/api/v2', (req, _res, next) => {
    req.v2Identity = { service: f.identity, authenticate: options => identityRouter.authenticate(options)(req) }; next();
  });
  app.use('/api/v2', identityRouter, createAdminHistoryRouter());
  app.use((_req, res) => res.status(404).json({ error: { errorCode: 'NOT_FOUND' } }));
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  let cookie = '';
  const request = async (route, { method = 'GET', body, authenticated = true, headers = {} } = {}) => {
    const response = await fetch(`${origin}/api/v2${route}`, { method, redirect: 'manual', headers: {
      ...(authenticated && cookie ? { cookie } : {}), ...(body ? { 'content-type': 'application/json' } : {}), ...headers },
    ...(body ? { body: JSON.stringify(body) } : {}) });
    return { response, status: response.status, body: await response.json() };
  };
  const login = await request('/auth/password', { method: 'POST', body: { username: 'admin', password: 'isolated-password' }, headers: { origin } });
  assert.equal(login.status, 403); cookie = `nb_v2_session=${fixtureSession('admin').token}`;
  return { ...f, origin, request, setActor(id) { const session = fixtureSession(id); cookie = `nb_v2_session=${session.token}`; } };
}

test('real HTTP G03 cookie auth, same-origin gate, no-store envelope and GET-only history', async t => {
  const f = await httpRuntime(t), route = `/wipes/${f.wipe.id}/history`;
  f.signup(1);
  const result = await f.request(route);
  assert.equal(result.status, 200); assert.equal(result.response.headers.get('cache-control'), 'no-store');
  assert.equal(result.body.meta.scopeVersion, 1); assert.ok(result.body.meta.requestId); assert.equal(result.body.data.items.length, 3);
  const emptyCursor = await f.request(`${route}?cursor=`);
  assert.equal(emptyCursor.status, 200); assert.deepEqual(emptyCursor.body.data.items, result.body.data.items);
  assert.equal((await f.request(route, { authenticated: false })).status, 401);
  const wrongHostStatus = await new Promise((resolve, reject) => {
    const request = httpRequest(`${f.origin}/api/v2${route}`, { headers: { host: 'wrong.invalid' } }, response => {
      response.resume(); response.on('end', () => resolve(response.statusCode));
    }); request.on('error', reject); request.end();
  });
  assert.equal(wrongHostStatus, 400);
  assert.equal((await f.request(route, { method: 'POST', body: {}, headers: { origin: f.origin } })).status, 404);
  f.setActor('private-account-1');
  assert.equal((await f.request(route)).body.error.errorCode, 'ACCESS_DENIED');
  const other = f.create('二队', ['s2']); f.setActor('leader');
  assert.equal((await f.request(`/wipes/${other.id}/history`)).body.error.errorCode, 'RESOURCE_NOT_FOUND');
});

test('real HTTP with fresh persisted session performs no writes and revoked session fails closed', async t => {
  const f = await httpRuntime(t); for (let i = 0; i < 5; i++) f.edit();
  const before = f.db.prepare('SELECT total_changes() AS n').get().n;
  f.db.exec('PRAGMA query_only=ON');
  const first = await f.request(`/wipes/${f.wipe.id}/history?limit=2`);
  assert.equal(first.status, 200); assert.ok(first.body.data.nextCursor);
  const next = await f.request(`/wipes/${f.wipe.id}/history?limit=2&cursor=${first.body.data.nextCursor}`);
  assert.equal(next.status, 200); assert.equal(f.db.prepare('SELECT total_changes() AS n').get().n, before);
  f.db.exec('PRAGMA query_only=OFF');
  f.identity.revokeAccountScope('admin', 'local-test-revocation');
  const after = f.db.prepare('SELECT total_changes() AS n').get().n;
  f.db.exec('PRAGMA query_only=ON');
  const denied = await f.request(`/wipes/${f.wipe.id}/history?cursor=${first.body.data.nextCursor}`);
  assert.equal(denied.status, 401); assert.equal(f.db.prepare('SELECT total_changes() AS n').get().n, after);
  f.db.exec('PRAGMA query_only=OFF');
});
