// Frozen scope-engine unit contract; real fixed-role behavior has separate domain integration coverage.
import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { installIdentitySchema, IdentityRepository } from '../server/v2/identity/repository.js';
import { FakeScopedIdentityService } from './support/scoped-identity-fake.mjs';
import { can, CAPABILITIES, grant } from '../server/v2/identity/permissions.js';
import { installSchedulingSchema, SchedulingRepository } from '../server/v2/scheduling/repository.js';
import { SchedulingService } from '../server/v2/scheduling/service.js';
import { MemberSpaceService } from '../server/v2/member-space/service.js';
import { MemberSpaceRepository, wipePermissionPredicate, memberPermissionPredicate } from '../server/v2/member-space/repository.js';
import { PlatformMediaRepository, installPlatformMediaSchema } from '../server/v2/platform-media/repository.js';
import { digest } from '../server/v2/platform-media/model.js';

const error = code => e => e.errorCode === code;
export function fixture(t) {
  const db = new DatabaseSync(':memory:'); t.after(() => db.close()); installIdentitySchema(db); installSchedulingSchema(db);
  const ir = new IdentityRepository(db), sr = new SchedulingRepository(db);
  ir.setScalar('v2IdentityMigration', { sourceHash: 'isolated-test' }); sr.setScalar('v2SchedulingMigration', { sourceHash: 'isolated-test' });
  let now = Date.parse('2030-09-08T10:00:00.000Z');
  const identity = new FakeScopedIdentityService(ir, { now: () => now });
  for (const id of ['s1', 's2']) ir.put('squads', { id, name: id, secret: 'hidden team note' });
  for (const [index, squadId] of [[1, 's1'], [2, 's1'], [3, 's2'], [4, null]]) {
    const memberId = `m${index}`, steamId = `7656119800000000${index}`;
    ir.put('members', { id: memberId, displayName: memberId, steamId, memberStatus: 'active', revision: 1,
      specialty: ['建筑'], phone: 'private', wechat: 'secret-wechat', internalNote: 'hidden' });
    ir.put('accounts', { id: `a${index}`, memberId, status: 'active', revision: 1, permissionVersion: 1, roleId: 'member', grants: [] });
    ir.put('bindings', { id: `b${index}`, accountId: `a${index}`, memberId, steamId, status: 'verified', verifiedAt: '2030-01-01T00:00:00Z' });
    if (squadId) ir.put('squadMembers', { id: memberId, memberId, squadId });
  }
  ir.put('accounts', { id: 'admin', memberId: null, status: 'active', revision: 1, permissionVersion: 1, roleId: 'admin', adminAssignedByOwner: true, grants: CAPABILITIES.map(c => grant(c, { type: 'all' })) });
  const scheduling = new SchedulingService(sr, identity, { now: () => now }), service = new MemberSpaceService(identity);
  const actor = id => identity.actorForAccount(id), op = () => ({ operationId: randomUUID() });
  const add = (id, overrides = {}) => {
    const value = { id, title: id, lifecycle: 'scheduled', outcome: null, revision: 2, contentRevision: 1,
      serverProfileId: 'server1', serverSnapshot: { name: 'Local server', secret: 'never return this' },
      timeZone: 'Asia/Shanghai', musterAt: '2030-09-08T12:00:00.000Z', serverScheduledWipeAt: '2030-09-08T11:00:00.000Z',
      signupOpensAt: '2030-09-08T09:00:00.000Z', signupClosesAt: '2030-09-08T13:00:00.000Z', signupWindow: 'open', autoOpenSignup: true,
      audience: { squadIds: ['s1'], memberIds: [], includeUnassigned: false }, ...overrides };
    sr.put('wipes', value); scheduling.content(value, now); return value;
  };
  const signup = (a, wipe, revision = 0, response = 'attending_on_time') => scheduling.saveSignup(actor(a), wipe.id, actor(a).memberId,
    { response, expectedArrivalAt: null, timeZone: wipe.timeZone, expectedSignupRevision: revision, confirmedContentRevision: wipe.contentRevision }, op());
  return { db, ir, sr, identity, scheduling, service, actor, op, add, signup, setNow: iso => now = Date.parse(iso) };
}

test('home chooses time and current member audience across more than the G04 first ID page', t => {
  const f = fixture(t);
  for (let i = 0; i < 31; i++) f.add(`a${String(i).padStart(3, '0')}`, { musterAt: '2030-12-08T12:00:00.000Z' });
  f.add('hidden-earlier', { musterAt: '2030-09-08T10:30:00.000Z', audience: { squadIds: ['s2'], memberIds: [], includeUnassigned: false } });
  f.add('zzz-next', { musterAt: '2030-09-08T11:00:00.000Z' });
  f.add('old-closed', { musterAt: '2030-09-07T11:00:00.000Z', signupClosesAt: '2030-09-07T12:00:00.000Z' });
  f.add('draft', { lifecycle: 'draft', musterAt: '2030-09-08T10:01:00.000Z' });
  f.add('cancelled', { lifecycle: 'cancelled', musterAt: '2030-09-08T10:02:00.000Z' });
  const home = f.service.home(f.actor('a1'));
  assert.equal(home.nextWipe.id, 'zzz-next'); assert.equal(home.nextAction.kind, 'signup');
  assert.deepEqual(home.nextWipe.serverSnapshot, { name: 'Local server' });
  assert.equal(home.nextWipe.counts, undefined); assert.equal(home.nextWipe.audience, undefined);
  assert.equal(home.team.id, 's1'); assert.equal(home.todos.length, 1);
});

test('current active wipe has priority and future active time is not treated as current', t => {
  const f = fixture(t); f.add('tomorrow-active', { lifecycle: 'active', musterAt: '2030-09-09T10:00:00.000Z' });
  f.add('today-next'); assert.equal(f.service.home(f.actor('a1')).nextWipe.id, 'today-next');
  f.add('current', { lifecycle: 'active', musterAt: '2030-09-07T10:00:00.000Z', signupClosesAt: '2030-09-07T11:00:00.000Z' });
  assert.equal(f.service.home(f.actor('a1')).nextWipe.id, 'current');
  assert.equal(f.service.home(f.actor('a1')).nextAction.kind, 'view_wipe');
});

test('direct-member and unassigned audiences work; member admin sees only their own next event', t => {
  const f = fixture(t); f.add('squad-two', { audience: { squadIds: ['s2'], memberIds: [], includeUnassigned: false } });
  f.add('direct', { audience: { squadIds: [], memberIds: ['m1'], includeUnassigned: false } });
  f.add('unassigned', { audience: { squadIds: [], memberIds: [], includeUnassigned: true } });
  f.ir.put('accounts', { ...f.ir.get('accounts', 'a1'), roleId: 'admin', grants: CAPABILITIES.map(c => grant(c, { type: 'all' })) });
  assert.equal(f.service.home(f.actor('a1')).nextWipe.id, 'direct');
  assert.equal(f.service.home(f.actor('a4')).nextWipe.id, 'unassigned');
  assert.equal(f.service.bootstrap(f.actor('a1'), 'csrf').participation.canSignup, true);
  assert.equal(f.service.bootstrap(f.actor('admin'), 'csrf').participation.reasonCode, 'MEMBER_VERIFICATION_REQUIRED');
});

test('member home handles empty, denied, paused and changed schedule states without false counts', t => {
  const f = fixture(t); assert.equal(f.service.home(f.actor('a1')).nextWipe, null);
  const wipe = f.add('w'); f.signup('a1', wipe);
  assert.equal(f.service.home(f.actor('a1')).nextAction.kind, 'edit_signup');
  f.sr.put('wipes', { ...wipe, contentRevision: 2, revision: 3, musterAt: '2030-09-08T13:00:00.000Z' });
  assert.equal(f.service.home(f.actor('a1')).nextAction.kind, 'edit_signup');
  assert.deepEqual(f.service.home(f.actor('a1')).todos, []);
  f.ir.put('members', { ...f.ir.get('members', 'm1'), memberStatus: 'suspended' });
  assert.equal(f.service.home(f.actor('a1')).nextAction.kind, 'view_wipe');
  assert.equal(f.service.home(f.actor('a1')).participation.reasonCode, 'MEMBERSHIP_INACTIVE');
  f.ir.put('accounts', { ...f.ir.get('accounts', 'a1'), grants: [{ capability: 'wipes.read', scope: { type: 'wipes', ids: ['w'] }, effect: 'deny' }] });
  assert.equal(f.service.home(f.actor('a1')).nextWipe, null);
});

test('saved signup remains an edit action after the schedule changes', t => {
  const f = fixture(t), wipe = f.add('changed');
  f.signup('a1', wipe);
  f.sr.put('wipes', { ...wipe, contentRevision: 2, revision: 3, musterAt: '2030-09-08T13:00:00.000Z' });
  const home = f.service.home(f.actor('a1'));
  assert.equal(home.nextAction.kind, 'edit_signup');
  assert.equal(home.nextWipe.mySignup.needsReconfirmation, false);
  assert.deepEqual(home.todos, []);
});

test('SQL wipe scopes match the G03 resolver across mixed audience, grants and explicit denies', t => {
  const f = fixture(t), cases = [
    { squadIds: ['s1'], memberIds: [], includeUnassigned: false },
    { squadIds: ['s1', 's2'], memberIds: [], includeUnassigned: false },
    { squadIds: [], memberIds: ['m1', 'm3'], includeUnassigned: false },
    { squadIds: [], memberIds: ['m2'], includeUnassigned: false },
    { squadIds: [], memberIds: [], includeUnassigned: true },
    { squadIds: [], memberIds: [], includeUnassigned: false }
  ];
  for (let i = 0; i < cases.length; i++) f.add(`w${i}`, { audience: cases[i] });
  const scopes = [{ type: 'all' }, { type: 'self' }, { type: 'squads', ids: ['s1'] }, { type: 'squads', ids: ['s1', 's2'] },
    { type: 'wipes', ids: ['w0', 'w4'] }, { type: 'platformTargets', ids: ['discord'] }];
  let checks = 0;
  for (const memberId of ['m1', 'm4', null]) for (const scope of scopes) for (const denied of [null, ...scopes]) {
    const actor = { id: 'comparison', memberId, status: 'active', grants: [grant('wipes.read', scope),
      ...(denied ? [{ capability: 'wipes.read', effect: 'deny', scope: denied }] : [])] };
    const predicate = wipePermissionPredicate(actor, 'wipes.read');
    const actual = f.db.prepare(`SELECT w.id FROM json_records w WHERE w.collection='v2Wipes' AND ${predicate.text} ORDER BY w.id`).all(...predicate.args).map(r => r.id);
    const expected = f.sr.all('wipes').filter(w => can(actor, 'wipes.read', { kind: 'wipe', id: w.id }, f.identity.relations())).map(w => w.id);
    assert.deepEqual(actual, expected, JSON.stringify({ memberId, scope, denied })); checks++;
  }
  assert.equal(checks, 126);
});

test('profile patch changes only own safe fields, preserves sensitive facts and persists revisions and audit', t => {
  const f = fixture(t), actor = f.actor('a1'), before = f.ir.get('members', 'm1');
  const result = f.service.patchMe(actor, { expectedRevision: 1, displayName: ' 新昵称 ', specialty: [' 狙击 ', '建筑', '建筑'],
    timeZone: 'America/New_York', language: 'en', theme: 'system' }, f.op());
  assert.equal(result.current.profile.revision, 2); assert.equal(result.current.profile.displayName, '新昵称');
  assert.deepEqual(result.current.profile.specialty, ['pvp', 'building']); assert.equal(result.current.profile.theme, 'system');
  assert.equal(f.ir.get('members', 'm1').customName, '新昵称'); assert.equal(f.ir.get('members', 'm1').steamId, before.steamId);
  assert.equal(f.ir.get('members', 'm1').internalNote, before.internalNote); assert.equal(f.ir.get('members', 'm2').revision, 1);
  assert.equal(f.ir.all('audits').at(-1).action, 'member.profile.self_edit');
  const response = JSON.stringify(f.service.me(actor));
  for (const value of ['private', 'secret-wechat', 'hidden', 'externalId']) assert.equal(response.includes(value), false);
});

test('profile same operation replay returns latest current and rejects changed body or stale new revision', t => {
  const f = fixture(t), a = f.actor('a1'), op = f.op(), input = { expectedRevision: 1, displayName: 'first' };
  const first = f.service.patchMe(a, input, op);
  f.service.patchMe(a, { expectedRevision: 2, displayName: 'second' }, f.op());
  const replay = f.service.patchMe(a, input, op);
  assert.equal(replay.replayed, true); assert.deepEqual(replay.operationReceipt, first.operationReceipt);
  assert.equal(replay.current.profile.displayName, 'second'); assert.equal(replay.current.profile.revision, 3);
  assert.throws(() => f.service.patchMe(a, { ...input, displayName: 'different' }, op), error('IDEMPOTENCY_CONFLICT'));
  assert.throws(() => f.service.patchMe(a, input, f.op()), e => e.errorCode === 'REVISION_CONFLICT' && e.current.profile.revision === 3);
  assert.throws(() => f.service.patchMe(a, input), error('IDEMPOTENCY_KEY_REQUIRED'));
});

test('profile rejects identity/role/sensitive fields and invalid preference values atomically', t => {
  const f = fixture(t), actor = f.actor('a1');
  for (const [key, value] of [['memberId', 'm2'], ['steamId', '76561198999999999'], ['roleId', 'admin'], ['grants', []], ['phone', 'x'], ['internalNote', 'x'],
    ['displayName', ''], ['specialty', ['x'.repeat(41)]], ['timeZone', 'Mars/Future'], ['language', 'unsafe'], ['theme', 'unsafe']]) {
    assert.throws(() => f.service.patchMe(actor, { expectedRevision: 1, displayName: 'valid', [key]: value }, f.op()),
      e => e.errorCode === 'INVALID_PROFILE' && Boolean(e.fieldErrors[key]), key);
  }
  assert.equal(f.ir.get('members', 'm1').revision, 1); assert.equal(f.ir.all('audits').length, 0);
});

test('profile transaction rolls back member revision and audit on receipt persistence failure', t => {
  const f = fixture(t); f.db.exec("CREATE TRIGGER reject_member_receipt BEFORE INSERT ON json_records WHEN NEW.collection='v2MemberProfileReceipts' BEGIN SELECT RAISE(ABORT,'test write failure'); END;");
  assert.throws(() => f.service.patchMe(f.actor('a1'), { expectedRevision: 1, displayName: 'not committed' }, f.op()));
  assert.equal(f.ir.get('members', 'm1').displayName, 'm1'); assert.equal(f.ir.all('audits').length, 0);
});

test('explicit profile deny, revoked member and old actor cannot edit or replay', t => {
  const f = fixture(t), actor = f.actor('a1'), op = f.op(), input = { expectedRevision: 1, displayName: 'once' };
  f.service.patchMe(actor, input, op);
  f.ir.put('accounts', { ...f.ir.get('accounts', 'a1'), permissionVersion: 2,
    grants: [{ capability: 'members.basic_edit', effect: 'deny', scope: { type: 'self' } }] });
  assert.throws(() => f.service.patchMe(actor, input, op), error('PERMISSIONS_CHANGED'));
  assert.throws(() => f.service.patchMe(f.actor('a1'), input, op), error('ACCESS_DENIED'));
  f.ir.put('members', { ...f.ir.get('members', 'm1'), memberStatus: 'left' });
  assert.throws(() => f.service.me(actor), error('MEMBERSHIP_INACTIVE'));
});

test('my team is scope-projected, page-bounded, account-bound and expires after membership change', t => {
  const f = fixture(t), a = f.actor('a1');
  const first = f.service.team(a, { limit: 1 });
  assert.equal(first.team.id, 's1'); assert.equal(first.items.length, 1); assert.ok(first.nextCursor);
  const second = f.service.team(a, { limit: 1, cursor: first.nextCursor });
  assert.deepEqual([...first.items, ...second.items].map(m => m.id), ['m1', 'm2']);
  assert.equal(second.nextCursor, null); assert.equal(first.items[0].steamId, '76561198000000001'); assert.equal(first.team.secret, undefined);
  assert.throws(() => f.service.team(f.actor('a2'), { cursor: first.nextCursor }), error('CURSOR_EXPIRED'));
  assert.throws(() => f.service.team(a, { cursor: 'invalid' }), error('CURSOR_EXPIRED'));
  f.ir.put('squadMembers', { id: 'm2', memberId: 'm2', squadId: 's2' });
  assert.throws(() => f.service.team(a, { cursor: first.nextCursor }), error('CURSOR_EXPIRED'));
  assert.equal(f.service.team(f.actor('a4')).team.id, 's1');
});

test('team directory lists every active team and switches a bounded member roster', t => {
  const f = fixture(t), actor = f.actor('a1');
  const own = f.service.team(actor, { limit: 1 });
  assert.deepEqual(own.teams.map(team => team.id), ['s1', 's2']);
  assert.equal(own.team.id, 's1');
  assert.deepEqual(own.items.map(member => member.id), ['m1']);

  const other = f.service.team(actor, { teamId: 's2' });
  assert.equal(other.team.id, 's2');
  assert.deepEqual(other.items.map(member => member.id), ['m3']);
  assert.equal(other.items[0].team.name, 's2');
  assert.equal(JSON.stringify(other).includes('hidden team note'), false);
  assert.throws(() => f.service.team(actor, { teamId: 's2', cursor: own.nextCursor }), error('CURSOR_EXPIRED'));
  assert.throws(() => f.service.team(actor, { teamId: 'unknown' }), error('RESOURCE_NOT_FOUND'));

  const unassigned = f.service.team(f.actor('a4'));
  assert.equal(unassigned.team.id, 's1');
  f.ir.put('squads', { ...f.ir.get('squads', 's2'), archivedAt: '2030-09-08T10:00:00Z' });
  assert.deepEqual(f.service.team(actor).teams.map(team => team.id), ['s1']);
});

test('team directory deny filters members before pagination', t => {
  const f = fixture(t), actor = { ...f.actor('a1'), grants: [
    grant('members.directory', { type: 'all' }),
    { capability: 'members.directory', effect: 'deny', scope: { type: 'squads', ids: ['s1'] } }
  ] };
  assert.deepEqual(f.service.repo.teamMembers(actor, 's1', '', 1), []);
  assert.deepEqual(f.service.repo.teamMembers(actor, 's2', '', 1).map(member => member.id), ['m3']);
});

test('full profile denies do not grant team directory access', t => {
  const f = fixture(t);
  const actor = { ...f.actor('admin'), grants: [grant('members.read', { type: 'all' }),
    { capability: 'members.read', effect: 'deny', scope: { type: 'squads', ids: ['s1'] } }] };
  const predicate = memberPermissionPredicate(actor, 'members.read', 'm.id');
  const rows = f.db.prepare(`SELECT m.id FROM json_records m WHERE m.collection='members' AND ${predicate.text} ORDER BY m.id`).all(...predicate.args);
  const expected = f.ir.all('members').filter(m => can(actor, 'members.read', { kind: 'member', id: m.id }, f.identity.relations())).map(m => ({ id: m.id }));
  assert.deepEqual(rows.map(r => ({ id: r.id })), expected);
  assert.deepEqual(f.service.repo.teamMembers(actor, 's1', '', 1), []);
});

test('history is real self signup data, chronological, paginated, scoped and has no invented stats', t => {
  const f = fixture(t), a = f.actor('a1'), w1 = f.add('w-first'), w2 = f.add('w-second');
  f.signup('a1', w1); f.setNow('2030-09-08T10:01:00Z'); f.signup('a1', w2); f.signup('a2', w1);
  const first = f.service.history(a, { limit: 1 }); assert.equal(first.items[0].wipe.id, 'w-second'); assert.ok(first.nextCursor);
  const second = f.service.history(a, { limit: 1, cursor: first.nextCursor }); assert.equal(second.items[0].wipe.id, 'w-first');
  assert.equal(second.nextCursor, null); assert.equal(first.items[0].mySignup.memberId, 'm1');
  assert.equal(first.items[0].stats.status, 'pending_sync'); assert.equal(first.items[0].stats.data, null);
  f.ir.put('accounts', { ...f.ir.get('accounts', 'a1'), grants: [{ capability: 'wipes.read', effect: 'deny', scope: { type: 'wipes', ids: ['w-second'] } }] });
  assert.equal(f.service.history(f.actor('a1')).items.length, 1);
  f.ir.put('accounts', { ...f.ir.get('accounts', 'a1'), grants: [{ capability: 'stats.read', effect: 'deny', scope: { type: 'self' } }] });
  assert.throws(() => f.service.history(f.actor('a1')), error('ACCESS_DENIED'));
});

test('member reads neither fetch external data nor enumerate unrelated records in the member-space repository', t => {
  const f = fixture(t); f.add('w');
  f.identity.providers = new Proxy({}, { get() { throw new Error('No external I/O in member reads'); } });
  const repo = f.service.repo;
  assert.equal(repo.all, undefined); assert.equal(repo.db, f.identity.repo.db);
  const actor = f.actor('a1'); f.service.bootstrap(actor, 'csrf'); f.service.home(actor); f.service.me(actor); f.service.team(actor); f.service.history(actor);
  assert.equal(f.ir.all('audits').length, 0); assert.equal(f.sr.all('signups').length, 0);
});

test('missing identity or scheduling migration fails closed', t => {
  const f = fixture(t); f.ir.setScalar('v2IdentityMigration', null);
  assert.throws(() => new MemberSpaceRepository(f.db), error('IDENTITY_MIGRATION_REQUIRED'));
  f.ir.setScalar('v2IdentityMigration', { sourceHash: 'test' }); f.sr.setScalar('v2SchedulingMigration', null);
  assert.throws(() => new MemberSpaceRepository(f.db), error('SCHEDULING_MIGRATION_REQUIRED'));
});

test('G05 integration closes self-signup projection deny through G04 detail, summary, list and member home', t => {
  const f = fixture(t), wipe = f.add('w'); f.signup('a1', wipe);
  f.ir.put('accounts', { ...f.ir.get('accounts', 'a1'), grants: [{ capability: 'signups.read', effect: 'deny', scope: { type: 'wipes', ids: [wipe.id] } }] });
  const actor = f.actor('a1');
  assert.equal(f.scheduling.getWipe(actor, wipe.id).mySignup, null);
  assert.equal(f.scheduling.summary(actor, wipe.id).mySignup, null);
  assert.equal(f.scheduling.summary(actor, wipe.id).counts.eligibleTotal, 0);
  assert.equal(f.scheduling.listWipes(actor).items[0].mySignup, null);
  assert.throws(() => f.scheduling.getSignup(actor, wipe.id), error('RESOURCE_NOT_FOUND'));
  const home = f.service.home(actor); assert.equal(home.nextWipe.mySignup, null); assert.equal(home.nextAction.kind, 'view_wipe');
  assert.equal(home.participation.canSignup, false); assert.deepEqual(home.todos, []);
  assert.deepEqual(f.service.history(actor).items, []);
});


test('member display projections expose saved public fields and omit credentials and hidden teammates', t => {
  const f = fixture(t);
  f.ir.put('members', { ...f.ir.get('members', 'm1'), steamNickname: 'Steam One', avatar: 'https://example.com/avatar.jpg',
    discordId: 'discord-one', discordName: 'Discord One', kookId: 'kook-one', kookName: 'KOOK One', accessToken: 'private-token' });
  for (const [provider, externalId] of [['discord','discord-one'], ['kook','kook-one']])
    f.ir.put('identities', { id: provider, accountId: 'a1', provider, externalId, verifiedAt: '2030-01-01T00:00:00Z', accessToken: 'private-token' });
  const me = f.service.me(f.actor('a1'));
  assert.deepEqual(me.bindings.platforms.map(p => [p.provider,p.externalId,p.displayName]), [
    ['discord','discord-one','Discord One'], ['kook','kook-one','KOOK One']]);
  const team = f.service.team(f.actor('a1'));
  assert.equal(team.items[0].steamNickname, 'Steam One'); assert.equal(team.items[0].avatar, 'https://example.com/avatar.jpg');
  assert.equal(team.items[0].team.name, 's1'); assert.equal(team.items[0].discordName, 'Discord One');
  assert.equal(team.items[0].kookName, 'KOOK One');
  assert.deepEqual(team.items.map(m => m.id), ['m1','m2']);
  assert.equal(team.items.some(member=>member.id==='m3'),false);
  for (const value of [me,team]) { const text=JSON.stringify(value); assert.ok(!text.includes('private-token')); assert.ok(!text.includes('secret-wechat')); assert.ok(!text.includes('internalNote')); }
  f.ir.put('identities', { id: 'discord', accountId: 'a1', provider: 'discord', externalId: 'different-id' });
  assert.equal(f.service.me(f.actor('a1')).bindings.platforms.find(p => p.provider==='discord').displayName, '');
});

test('team restores cached Steam display fields only for the matching visible member', t => {
  const f = fixture(t), member=f.ir.get('members','m1');
  f.service.repo.put('memberProfiles',{id:'steam-profile',memberId:'m1',steamId:member.steamId,
    displayName:'Cached Steam',avatar:'https://avatars.steamstatic.com/cached.jpg',accessToken:'must-not-leak'});
  let team=f.service.team(f.actor('a1'));
  assert.equal(team.items[0].steamNickname,'Cached Steam');
  assert.equal(team.items[0].avatar,'https://avatars.steamstatic.com/cached.jpg');
  assert.ok(!JSON.stringify(team).includes('must-not-leak'));
  for (const override of [{memberId:'m2'}, {steamId:'76561199503428175'}]) {
    f.service.repo.put('memberProfiles',{id:'steam-profile',memberId:'m1',steamId:member.steamId,
      displayName:'Wrong owner',avatar:'https://example.com/wrong.jpg',...override});
    team=f.service.team(f.actor('a1'));
    assert.equal(team.items[0].steamNickname,'');assert.equal(team.items[0].avatar,'');
  }
});

test('self profile recognizes verified mini-program identity and uses verified platform nickname', t => {
  const f = fixture(t);
  f.ir.put('identities', { id: 'kook', accountId: 'a1', provider: 'kook', externalId: 'kook-one',
    displayName: 'KOOK 本人', verifiedAt: '2030-01-01T00:00:00Z' });
  f.ir.put('identities', { id: 'wechat', accountId: 'a1', provider: 'wechat:wx-app', externalId: 'openid-one',
    verifiedAt: '2030-01-02T00:00:00Z' });
  f.ir.put('wechatUsers', { id: 'wx-one', appId: 'wx-app', openid: 'openid-one', memberId: 'm1', nickname: '微信本人' });
  const platforms = f.service.me(f.actor('a1')).bindings.platforms;
  assert.deepEqual(platforms.map(p => [p.provider, p.displayName]), [
    ['kook', 'KOOK 本人'], ['wechat:wx-app', '微信本人']]);
  assert.equal(platforms[1].externalId, null);
  f.ir.put('identities', { id: 'wechat', accountId: 'a1', provider: 'wechat:wx-app', externalId: 'openid-one' });
  assert.equal(f.service.me(f.actor('a1')).bindings.platforms.some(p => p.provider.startsWith('wechat:')), false);
});

test('team cards show verified platform profiles and protect WeChat avatars in the member directory', t => {
  const f = fixture(t); installPlatformMediaSchema(f.db);
  const media = new PlatformMediaRepository(f.db), avatarUrl = '/api/v2/platform-media/avatar-image?memberId=m1';
  f.ir.put('identities', { id: 'kook', accountId: 'a1', provider: 'kook', externalId: 'kook-one',
    displayName: 'KOOK 本人', avatarUrl: 'https://img.kookapp.cn/avatar.png', verifiedAt: '2030-01-01T00:00:00Z' });
  f.ir.put('identities', { id: 'discord', accountId: 'a1', provider: 'discord', externalId: 'discord-one',
    displayName: 'Discord 本人', avatarUrl: 'https://cdn.discordapp.com/avatar.png', verifiedAt: '2030-01-01T00:00:00Z' });
  f.ir.put('identities', { id: 'wechat', accountId: 'a1', provider: 'wechat:wx-app', externalId: 'openid-one',
    verifiedAt: '2030-01-01T00:00:00Z' });
  f.ir.put('wechatUsers', { id: 'wx-one', appId: 'wx-app', openid: 'openid-one', memberId: 'm1', nickname: '微信本人',
    avatarUploadId: 'v2_avatar_one', avatarRevision: 1, avatarUrl });
  media.put('uploads', { id: 'v2_avatar_one', ownerType: 'wechat_user', ownerId: 'wx-one', appId: 'wx-app',
    storage: 'v2_platform_media', revision: 1, sha256: 'test-image', url: avatarUrl });
  const bytes = Buffer.from('test-image');
  media.writeBlob(digest(['wx-app', 'wx-one']), 'wx-app', 'wx-one', 1,
    { sha256: 'test-image', contentType: 'image/png', width: 1, height: 1, bytes });
  const member = f.service.team(f.actor('a1')).items.find(row => row.id === 'm1');
  assert.deepEqual(Object.fromEntries(['kook', 'discord', 'wechat'].map(key => [key, member.platforms[key].displayName])),
    { kook: 'KOOK 本人', discord: 'Discord 本人', wechat: '微信本人' });
  assert.equal(member.platforms.kook.avatar, 'https://img.kookapp.cn/avatar.png');
  assert.equal(member.platforms.wechat.avatar, '/api/v2/me/team/avatar/m1');
  assert.deepEqual(f.service.teamAvatar(f.actor('a1'), 'm1').bytes, bytes);
  assert.throws(() => f.service.teamAvatar(f.actor('a1'), 'm3'), error('RESOURCE_NOT_FOUND'));
  assert.equal(JSON.stringify(member).includes('openid-one'), false);

  f.ir.put('identities', { id: 'wechat-other', accountId: 'a3', provider: 'wechat:wx-app',
    externalId: 'openid-three', verifiedAt: '2030-01-01T00:00:00Z' });
  f.ir.put('wechatUsers', { id: 'wx-three', appId: 'wx-app', openid: 'openid-three', memberId: 'm3',
    nickname: '跨队成员', avatarUploadId: 'v2_avatar_three', avatarRevision: 1,
    avatarUrl: '/api/v2/platform-media/avatar-image?memberId=m3' });
  media.put('uploads', { id: 'v2_avatar_three', ownerType: 'wechat_user', ownerId: 'wx-three', appId: 'wx-app',
    storage: 'v2_platform_media', revision: 1, sha256: 'other-image',
    url: '/api/v2/platform-media/avatar-image?memberId=m3' });
  const otherBytes = Buffer.from('other-image');
  media.writeBlob(digest(['wx-app', 'wx-three']), 'wx-app', 'wx-three', 1,
    { sha256: 'other-image', contentType: 'image/png', width: 1, height: 1, bytes: otherBytes });
  const otherMember = f.service.team(f.actor('a1'), { teamId: 's2' }).items[0];
  assert.equal(otherMember.platforms.wechat.avatar, '/api/v2/me/team/avatar/m3');
  assert.deepEqual(f.service.teamAvatar(f.actor('a1'), 'm3').bytes, otherBytes);
  assert.equal(JSON.stringify(otherMember).includes('openid-three'), false);
});
