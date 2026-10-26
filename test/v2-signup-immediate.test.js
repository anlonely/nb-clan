import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { EventEmitter } from 'node:events';
import { createBusinessEventsHub } from '../server/v2/business-events/index.js';
import { randomUUID } from 'node:crypto';
import { installIdentitySchema, IdentityRepository } from '../server/v2/identity/repository.js';
import { IdentityService } from '../server/v2/identity/service.js';
import { grant, can } from '../server/v2/identity/permissions.js';
import { installSchedulingSchema, SchedulingRepository } from '../server/v2/scheduling/repository.js';
import { SchedulingService } from '../server/v2/scheduling/service.js';
import { MemberSpaceRepository, wipePermissionPredicate } from '../server/v2/member-space/repository.js';
import { NotificationService } from '../server/v2/notifications/service.js';
import { createSqliteSyncAuthority } from '../server/v2/sync-center/authority.js';

const hasCode = code => e => e.errorCode === code;
const everyone = { allMembers: true, squadIds: [], memberIds: [], includeUnassigned: true };
function fixture(t) {
  const db = new DatabaseSync(':memory:'); t.after(() => db.close());
  installIdentitySchema(db); installSchedulingSchema(db);
  const ir = new IdentityRepository(db), repo = new SchedulingRepository(db);
  repo.setScalar('v2SchedulingMigration', { sourceHash: 'test' });
  ir.setScalar('v2IdentityMigration', { sourceHash: 'test' });
  let clock = Date.parse('2030-09-08T10:00:00Z');
  const now = () => clock, identity = new IdentityService(ir, { now });
  const scheduling = new SchedulingService(repo, identity, { now });
  ir.put('squads', { id: 'sq1' }); ir.put('squads', { id: 'sq2' });
  function member(id, squadId) {
    ir.put('members', { id, memberStatus: 'active', steamId: `steam-${id}`, displayName: id });
    ir.put('accounts', { id: `a-${id}`, memberId: id, status: 'active', revision: 1, permissionVersion: 1 });
    ir.put('bindings', { id, memberId: id, accountId: `a-${id}`, steamId: `steam-${id}`, status: 'verified' });
    if (squadId) ir.put('squadMembers', { id, memberId: id, squadId });
  }
  member('assigned', 'sq1'); member('unassigned');
  ir.put('accounts', { id: 'admin', roleId: 'admin', adminAssignedByOwner: true, memberId: null, status: 'active', revision: 1, permissionVersion: 1 });
  const actor = id => identity.actorForAccount(id || 'admin'), options = () => ({ operationId: randomUUID() });
  const input = { publishImmediately: true, title: 'Ready signup', serverProfileId: 'server1', serverSnapshot: { name: 'Test server' },
    timeZone: 'Asia/Shanghai', musterAt: '2030-09-08T10:55:00Z', serverScheduledWipeAt: '2030-09-08T11:00:00Z', audience: everyone };
  const signup = () => ({ response: 'attending_on_time', expectedArrivalAt: null, timeZone: 'Asia/Shanghai', expectedSignupRevision: 0, confirmedContentRevision: 1 });
  const snapshot = () => Object.fromEntries(['wipes', 'contents', 'events', 'outbox', 'receipts'].map(k => [k, repo.all(k)]));
  return { db, ir, repo, identity, scheduling, member, actor, options, input, signup, snapshot, now,
    setNow: value => { clock = Date.parse(value); } };
}

test('one create opens immediately, uses wipe deadline, persists one atomic receipt and replays after time passes', t => {
  const f = fixture(t), opts = f.options();
  const first = f.scheduling.createWipe(f.actor(), { ...f.input, signupOpensAt: '2040-01-01T00:00:00Z', autoOpenSignup: false }, opts);
  const w = first.current;
  assert.equal(w.lifecycle, 'scheduled'); assert.equal(w.signupWindow, 'open'); assert.equal(w.autoOpenSignup, true);
  assert.equal(w.signupOpensAt, '2030-09-08T10:00:00.000Z');
  assert.equal(w.signupClosesAt, w.serverScheduledWipeAt); assert.equal(f.scheduling.window(w), 'open');
  for (const k of ['wipes', 'contents', 'events', 'outbox', 'receipts']) assert.equal(f.repo.all(k).length, 1);
  f.setNow('2030-09-08T12:00:00Z');
  const retry = f.scheduling.createWipe(f.actor(), { ...f.input, signupOpensAt: '2040-01-01T00:00:00Z', autoOpenSignup: false }, opts);
  assert.equal(retry.replayed, true); assert.deepEqual(retry.operationReceipt, first.operationReceipt); assert.deepEqual(retry.current, w);
  assert.throws(() => f.scheduling.createWipe(f.actor(), { ...f.input, title: 'changed' }, opts), hasCode('IDEMPOTENCY_CONFLICT'));
});

test('runtime catches up server start without changing signup confirmations or asserting actual play', t => {
  const f = fixture(t), w = f.scheduling.createWipe(f.actor(), f.input, f.options()).current;
  f.scheduling.saveSignup(f.actor('a-assigned'), w.id, 'assigned', f.signup(), f.options());
  const future = f.scheduling.createWipe(f.actor(), { ...f.input, serverScheduledWipeAt: '2030-09-09T11:00:00Z' }, f.options()).current;
  const draft = f.scheduling.createWipe(f.actor(), { ...f.input, publishImmediately: false }, f.options()).current;
  const cancelled = f.scheduling.createWipe(f.actor(), f.input, f.options()).current;
  f.scheduling.transition(f.actor(), cancelled.id, 'cancel', { expectedRevision: 1, reason: 'test' }, f.options());
  f.setNow('2030-09-08T10:59:59Z');
  assert.deepEqual(f.scheduling.advanceDueWipes(), []);
  f.setNow('2030-09-08T12:00:00Z');
  assert.deepEqual(f.scheduling.advanceDueWipes(), [w.id]);
  const active = f.scheduling.getWipe(f.actor(), w.id);
  assert.equal(active.lifecycle, 'active'); assert.equal(active.revision, 2);
  assert.equal(active.phaseEnteredAt, w.serverScheduledWipeAt);
  assert.equal(active.effectiveSignupWindow, 'closed'); assert.equal(active.contentRevision, 1);
  assert.equal(active.actualStartedAt, null); assert.equal(active.serverActualWipeAt, null);
  assert.equal(f.scheduling.getSignup(f.actor('a-assigned'), w.id).needsReconfirmation, false);
  assert.equal(f.repo.get('wipes', future.id).lifecycle, 'scheduled');
  assert.equal(f.repo.get('wipes', draft.id).lifecycle, 'draft');
  assert.equal(f.repo.get('wipes', cancelled.id).lifecycle, 'cancelled');
  const event = f.repo.all('events').find(e => e.action === 'wipe.start');
  assert.equal(event.source, 'scheduler'); assert.equal(event.actorAccountId, 'system:scheduling');
  const snapshot = f.snapshot();
  assert.deepEqual(f.scheduling.advanceDueWipes(), []); assert.deepEqual(f.snapshot(), snapshot);
});

test('server schedule takes precedence over earlier muster and a failed due sweep rolls back phase and events', t => {
  const f = fixture(t), w = f.scheduling.createWipe(f.actor(), { ...f.input, autoStart: true }, f.options()).current;
  f.setNow('2030-09-08T10:55:00Z');
  assert.deepEqual(f.scheduling.advanceDueWipes(), []);
  f.setNow('2030-09-08T11:00:00Z');
  const before = f.snapshot();
  f.db.exec("CREATE TRIGGER reject_outbox BEFORE INSERT ON json_records WHEN NEW.collection='v2SchedulingOutbox' BEGIN SELECT RAISE(ABORT,'fixture'); END;");
  assert.throws(() => f.scheduling.advanceDueWipes()); assert.deepEqual(f.snapshot(), before);
  f.db.exec('DROP TRIGGER reject_outbox');
  assert.deepEqual(f.scheduling.advanceDueWipes(), [w.id]);
  const active = f.repo.get('wipes', w.id);
  assert.equal(active.phaseEnteredAt, w.serverScheduledWipeAt); assert.equal(f.scheduling.window(active), 'closed');
});

test('global signup includes assigned, unassigned and future members across reads, member-space, count, notification and sync', t => {
  const f = fixture(t), w = f.scheduling.createWipe(f.actor(), f.input, f.options()).current;
  f.ir.put('squads',{id:'sq1',name:'CN'});f.ir.put('squads',{id:'sq2',name:'EU'});
  f.member('future', 'sq2');
  const space = new MemberSpaceRepository(f.db), notifications = new NotificationService({ identity:f.identity, scheduling: f.scheduling, now: f.now });
  const notificationInput = { expectedContentRevision: 1, templateId: 'wipe-notification', templateRevision: 1, purpose: 'signup_open',
    purposeInstance: 'primary', repeatOfIntentId: null, reason: null, duplicateRiskAcknowledged: false, schedule: null, audience: everyone,
    targets: [{ targetId: 'channel-1', language: 'zh-CN', mentionMode: 'none', roleIds: [] }] };
  assert.deepEqual(notifications.normalizeInput(notificationInput).audience, everyone);
  for (const id of ['assigned', 'unassigned', 'future']) {
    const a = f.actor(`a-${id}`);
    assert.equal(f.scheduling.getWipe(a, w.id).id, w.id);
    assert.equal(f.scheduling.listWipes(a).items[0].id, w.id);
    assert.equal(space.nextWipe(a, f.now()).id, w.id);
    assert.equal(f.scheduling.saveSignup(a, w.id, id, f.signup(), f.options()).current.response, 'attending_on_time');
  }
  assert.equal(f.scheduling.summary(f.actor(), w.id).counts.eligibleTotal, 3);
  assert.equal(f.scheduling.listSignups(f.actor(), w.id).items.length, 3);
  assert.equal(notifications.audienceSnapshot(f.actor(), w, everyone).counts.onTime, 3);
  assert.deepEqual(notifications.teamCounts(notifications.audienceSnapshot(f.actor(),w,everyone).rows),{
    CN:{onTime:1,later:0,notAttending:0},EU:{onTime:1,later:0,notAttending:0}
  });
  assert.equal(notifications.audienceSnapshot(f.actor(), w, { squadIds: ['sq2'], memberIds: [], includeUnassigned: false }).counts.onTime, 1);
  assert.throws(() => notifications.audienceSnapshot(f.actor('a-assigned'), w, everyone), hasCode('NOTIFICATION_AUDIENCE_DENIED'));
  const authority = createSqliteSyncAuthority({ identity: f.identity });
  assert.equal(authority.resolveScope({ actor: f.actor(), scope: { kind: 'current_wipe', id: w.id } }).targets.length, 3);
  assert.equal(authority.resolveScope({ actor: f.actor(), scope: { kind: 'members', memberIds: ['future'], wipeId: w.id } }).targets.length, 1);
  f.setNow(w.signupClosesAt);
  assert.equal(f.scheduling.window(w), 'closed');
  assert.throws(() => f.scheduling.saveSignup(f.actor('a-future'), w.id, 'future', { ...f.signup(), expectedSignupRevision: 1 }, f.options()), hasCode('SIGNUP_CLOSED'));
});

test('global audience keeps inactive and unverified members out of eligible counts and writes', t => {
  const f = fixture(t), w = f.scheduling.createWipe(f.actor(), f.input, f.options()).current;
  f.member('paused', 'sq1'); f.ir.put('members', { ...f.ir.get('members', 'paused'), memberStatus: 'suspended' });
  f.member('unverified'); f.ir.put('bindings', { ...f.ir.get('bindings', 'unverified'), status: 'revoked' });
  assert.equal(f.scheduling.summary(f.actor(), w.id).counts.eligibleTotal, 2);
  for (const [id, code] of [['paused', 'MEMBERSHIP_INACTIVE'], ['unverified', 'MEMBER_VERIFICATION_REQUIRED']]) {
    assert.throws(() => f.scheduling.saveSignup(f.actor(), w.id, id, { ...f.signup(), reason: 'delegated' }, { ...f.options(), delegate: true }), hasCode(code));
  }
});

test('draft final save publishes atomically, while plain create and existing scoped records stay compatible', t => {
  const f = fixture(t);
  const draft = f.scheduling.createWipe(f.actor(), { title: 'Draft' }, f.options()).current;
  assert.equal(draft.lifecycle, 'draft');
  const command = { ...f.input, expectedRevision: draft.revision }, opts = f.options();
  const first = f.scheduling.updateWipe(f.actor(), draft.id, command, opts);
  assert.equal(first.current.lifecycle, 'scheduled'); assert.equal(first.current.revision, 2);
  assert.equal(f.scheduling.window(first.current), 'open');
  f.setNow('2030-09-08T10:10:00Z');
  assert.equal(f.scheduling.updateWipe(f.actor(), draft.id, command, opts).replayed, true);
  const scoped = f.scheduling.createWipe(f.actor(), { ...f.input, audience: { squadIds: ['sq1'], memberIds: [], includeUnassigned: false } }, f.options()).current;
  assert.equal(Object.hasOwn(scoped.audience, 'allMembers'), false);
  assert.throws(() => f.scheduling.getWipe(f.actor('a-unassigned'), scoped.id), hasCode('RESOURCE_NOT_FOUND'));
  const deniedActor = { ...f.actor(), grants: [...f.actor().grants, { ...grant('wipes.read', { type: 'squads', ids: ['sq2'] }), effect: 'deny' }] };
  const predicate = wipePermissionPredicate(deniedActor, 'wipes.read');
  assert.ok(f.db.prepare(`SELECT 1 FROM json_records w WHERE w.collection='v2Wipes' AND w.id=? AND ${predicate.text}`).get(scoped.id, ...predicate.args));
  const notifications = new NotificationService({ scheduling: f.scheduling, now: f.now });
  assert.throws(() => notifications.audienceSnapshot(f.actor(), scoped, everyone), hasCode('NOTIFICATION_AUDIENCE_DENIED'));
});

test('incomplete, invalid cutoff and injected persistence failure leave no partial create or draft update', t => {
  const f = fixture(t), before = f.snapshot();
  for (const change of [{ serverSnapshot: null }, { title: ' ' }, { signupClosesAt: '2030-09-08T10:00:00Z' }, { allMembers: true }]) {
    assert.throws(() => f.scheduling.createWipe(f.actor(), { ...f.input, ...change }, f.options()));
    assert.deepEqual(f.snapshot(), before);
  }
  const draft = f.scheduling.createWipe(f.actor(), { title: 'Incomplete' }, f.options()).current, beforeUpdate = f.snapshot();
  assert.throws(() => f.scheduling.updateWipe(f.actor(), draft.id, { publishImmediately: true, expectedRevision: 1 }, f.options()));
  assert.deepEqual(f.snapshot(), beforeUpdate);
  f.db.exec("CREATE TRIGGER reject_outbox BEFORE INSERT ON json_records WHEN NEW.collection='v2SchedulingOutbox' BEGIN SELECT RAISE(ABORT,'fixture'); END;");
  assert.throws(() => f.scheduling.createWipe(f.actor(), f.input, f.options()));
  assert.deepEqual(f.snapshot(), beforeUpdate);
  assert.throws(() => f.scheduling.updateWipe(f.actor(), draft.id, { ...f.input, expectedRevision: 1 }, f.options()));
  assert.deepEqual(f.snapshot(), beforeUpdate);
});

test('atomic publication requires publish grant and neither self nor squad management gains global control', t => {
  const f = fixture(t), before = f.snapshot();
  assert.throws(() => f.scheduling.createWipe(f.actor('a-assigned'), f.input, f.options()), hasCode('ACCESS_DENIED'));
  const admin = f.actor(), noPublish = { ...admin, grants: admin.grants.filter(g => g.capability !== 'wipes.publish') };
  const original = f.identity.actorForAccount.bind(f.identity);
  f.identity.actorForAccount = id => id === 'admin' ? noPublish : original(id);
  assert.throws(() => f.scheduling.createWipe(noPublish, f.input, f.options()), hasCode('ACCESS_DENIED'));
  assert.deepEqual(f.snapshot(), before);
  f.identity.actorForAccount = original;
  const w = f.scheduling.createWipe(admin, f.input, f.options()).current;
  const resource = { kind: 'wipe', id: w.id }, relations = f.identity.relations();
  for (const scope of [{ type: 'squads', ids: ['sq1'] }, { type: 'self' }]) {
    const a = { ...f.actor('a-assigned'), grants: ['wipes.create', 'wipes.edit', 'wipes.publish'].map(cap => grant(cap, scope)) };
    assert.equal(can(a, 'wipes.read', resource, relations), true);
    for (const cap of ['wipes.create', 'wipes.edit', 'wipes.publish']) {
      assert.equal(can(a, cap, resource, relations), false);
      const p = wipePermissionPredicate(a, cap);
      assert.equal(f.db.prepare(`SELECT 1 FROM json_records w WHERE w.collection='v2Wipes' AND w.id=? AND ${p.text}`).get(w.id, ...p.args), undefined);
    }
  }
  const denied = { ...admin, grants: [...admin.grants, { ...grant('wipes.publish', { type: 'squads', ids: ['sq2'] }), effect: 'deny' }] };
  assert.equal(can(denied, 'wipes.publish', resource, relations), false);
  const p = wipePermissionPredicate(denied, 'wipes.publish');
  assert.equal(f.db.prepare(`SELECT 1 FROM json_records w WHERE w.collection='v2Wipes' AND w.id=? AND ${p.text}`).get(w.id, ...p.args), undefined);
});


test('SSE creation invalidates data without clearing identity; audience removal and account revocation still clear access', async t => {
  const f = fixture(t), hub = createBusinessEventsHub({ intervalMs: 60_000 });
  t.after(() => hub.stop());
  async function stream(accountId) {
    const frames = [], res = new EventEmitter();
    Object.assign(res, { destroyed: false, writableEnded: false, writableLength: 0 });
    res.status = res.set = () => res; res.flushHeaders = () => {};
    res.write = frame => { frames.push(frame); return true; };
    res.end = () => { res.writableEnded = true; };
    const req = { method: 'GET', url: '/events', headers: {}, get: () => undefined,
      v2Identity: { service: f.identity, authenticate: async () => ({ actor: f.actor(accountId) }) } };
    hub.router(req, res, () => {});
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(frames.length, 1); assert.match(frames[0], /"reason":"initial"/);
    return { frames, res };
  }
  const admin = await stream('admin'), member = await stream('a-assigned');
  const w = f.scheduling.createWipe(f.actor(), f.input, f.options()).current;
  await hub.poll();
  for (const current of [admin, member]) {
    assert.equal(current.frames.length, 2); assert.match(current.frames[1], /event: invalidate/);
    assert.ok(current.frames[1].includes(w.id)); assert.equal(current.res.writableEnded, false);
    assert.equal(current.frames.some(frame => frame.includes('scope_changed')), false);
  }
  f.scheduling.updateWipe(f.actor(), w.id, { expectedRevision: w.revision,
    audience: { squadIds: ['sq2'], memberIds: [], includeUnassigned: false } }, f.options());
  await hub.poll();
  assert.match(member.frames.at(-1), /"reason":"scope_changed"/);
  assert.equal(member.frames.at(-1).includes(w.id), false); assert.equal(member.res.writableEnded, true);
  assert.match(admin.frames.at(-1), /event: invalidate/); assert.equal(admin.res.writableEnded, false);
  f.ir.put('accounts', { ...f.ir.get('accounts', 'admin'), status: 'disabled' });
  await hub.poll();
  assert.match(admin.frames.at(-1), /event: authorization-revoked/); assert.equal(admin.res.writableEnded, true);
  await hub.stop();
});
