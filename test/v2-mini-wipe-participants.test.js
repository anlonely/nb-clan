import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture } from './support/v2-platform-host/fixture.mjs';
import { createMiniWipeParticipants } from '../server/v2/management-adapters/platforms/mini-wipe-participants.js';
import { signupId } from '../server/v2/scheduling/service.js';
import { can } from '../server/v2/identity/permissions.js';

function setup(t, size = 6) {
  const f = fixture(); t.after(() => f.close());
  const ids = Array.from({ length: size }, (_, i) => `m${String(i + 1).padStart(3, '0')}`);
  for (const id of ids) if (!f.ir.all('bindings').some(row => row.memberId === id)) {
    const member = f.ir.get('members', id), accountId = `roster-${id}`;
    f.ir.put('accounts', { id: accountId, memberId: id, status: 'active', permissionVersion: 1 });
    f.ir.put('bindings', { id: `roster-binding-${id}`, memberId: id, accountId, status: 'verified', steamId: member.steamId });
  }
  const wipe = { ...f.sr.get('wipes', 'host-wipe'), audience: { memberIds: ids, squadIds: [], includeUnassigned: false } };
  f.sr.put('wipes', wipe);
  const participants = createMiniWipeParticipants(f);
  const signup = (memberId, response, extra = {}) => f.sr.put('signups', { id: signupId(wipe.id, memberId), wipeId: wipe.id, memberId,
    response, signupRevision: 1, confirmedContentRevision: wipe.contentRevision, timeZone: 'Asia/Shanghai',
    actorAccountId: 'PRIVATE-ACTOR', reason: 'PRIVATE-REASON', legacyRaw: { token: 'PRIVATE-TOKEN' }, ...extra });
  const read = (input = {}) => participants({ actor: f.actor('member'), input: { wipeId: wipe.id, ...input } });
  return { ...f, wipe, signup, read, participants };
}

test('member roster shows other actual respondents, while statistics cover the full eligible audience across pages', t => {
  const f = setup(t);
  f.signup('m001', 'attending_on_time', { confirmedContentRevision: 0 });
  f.signup('m002', 'attending_later', { expectedArrivalAt: '2030-09-08T13:00:00Z' });
  f.signup('m003', 'not_attending'); f.signup('m004', null); f.signup('m005', 'attending_on_time');
  const member = f.ir.get('members', 'm001');
  f.ir.put('members', { ...member, avatar: 'https://images.example.test/avatar.png', phone: 'PRIVATE-PHONE', notes: 'PRIVATE-NOTES' });
  const first = f.read({ limit: 2 }), second = f.read({ limit: 2, cursor: first.nextCursor });
  assert.equal(can(f.actor('member'), 'signups.read', { kind: 'signup', wipeId: f.wipe.id, memberId: 'm001' }, f.identity.relations()), false);
  assert.deepEqual(first.items.map(row => row.memberId), ['m001', 'm002']);
  assert.deepEqual(second.items.map(row => row.memberId), ['m003', 'm005']);
  assert.equal(first.nextCursor, 'm002'); assert.equal(second.nextCursor, null); assert.equal(first.total, 4);
  assert.deepEqual(first.counts, { eligibleTotal: 6, unanswered: 2, onTime: 2, later: 1, notAttending: 1, responseTotal: 4,
    plannedAttending: 3, confirmedAttending: 3, pendingReconfirmationAttending: 0, pendingReconfirmation: 0 });
  assert.deepEqual(second.counts, first.counts); assert.equal(first.countScope, 'audience');
  assert.equal(first.items[0].needsReconfirmation, false); assert.equal(first.items[0].avatar, member.avatar || 'https://images.example.test/avatar.png');
  assert.equal(first.items[1].expectedArrivalAt, '2030-09-08T13:00:00Z'); assert.equal(first.items[1].isSelf, true);
  assert.deepEqual(Object.keys(first.items[0]).sort(), ['memberId', 'name', 'avatar', 'squadName', 'steamId', 'specialties', 'response', 'needsReconfirmation', 'expectedArrivalAt', 'isSelf'].sort());
  assert.equal(first.items[0].steamId, member.steamId); assert.deepEqual(first.items[0].specialties, ['building']);
  assert.ok(!JSON.stringify([first, second]).includes('PRIVATE-'));
});

test('roster pagination never truncates more than one page of actual respondents', t => {
  const f = setup(t, 45);
  for (let n = 1; n <= 45; n++) f.signup(`m${String(n).padStart(3, '0')}`, n % 4 === 0 ? null : 'attending_on_time');
  let cursor = '', ids = [], pages = 0;
  do {
    const result = f.read({ limit: 7, cursor });
    assert.equal(result.counts.eligibleTotal, 45); assert.equal(result.total, 34);
    ids.push(...result.items.map(row => row.memberId)); cursor = result.nextCursor; pages++;
    assert.ok(pages <= 6);
  } while (cursor);
  assert.equal(ids.length, 34); assert.equal(new Set(ids).size, 34); assert.equal(pages, 5);
});

test('CN/EU attendance uses exact active canonical squads across all pages, never region hints or duplicate assignment', t => {
  const f = setup(t, 7);
  f.ir.put('squads', { ...f.ir.get('squads', 's1'), name: ' cn ' });
  f.ir.put('squads', { ...f.ir.get('squads', 's2'), name: 'EU' });
  f.ir.put('squads', { id: 's3', name: 'CN 特别队' });
  f.ir.put('squadMembers', { ...f.ir.get('squadMembers', 'sm2'), squadId: 's2' });
  f.ir.put('squadMembers', { ...f.ir.get('squadMembers', 'sm4'), squadId: 's2' });
  f.ir.put('squadMembers', { ...f.ir.get('squadMembers', 'sm5'), squadId: 's3' });
  f.ir.put('members', { ...f.ir.get('members', 'm005'), region: 'CN', timezone: 'Asia/Shanghai' });
  assert.throws(() => f.ir.put('squadMembers', { id: 'duplicate-current-assignment', memberId: 'm006', squadId: 's2' }), /UNIQUE constraint/);
  f.signup('m001', 'attending_on_time', { confirmedContentRevision: 0 });
  f.signup('m002', 'attending_later'); f.signup('m003', 'not_attending'); f.signup('m004', null);
  f.signup('m005', 'attending_on_time'); f.signup('m006', 'attending_later');
  const first = f.read({ limit: 1 });
  assert.deepEqual(first.regionCounts, { cn: 2, eu: 1, unknown: 1 });
  assert.equal(Object.values(first.regionCounts).reduce((sum, value) => sum + value, 0), first.counts.plannedAttending);
  assert.deepEqual(f.read({ limit: 1, cursor: first.nextCursor }).regionCounts, first.regionCounts);
  const account = f.ir.get('accounts', 'member');
  f.ir.put('accounts', { ...account, grants: [...account.grants, { capability: 'members.directory', scope: { type: 'squads', ids: ['s2'] }, effect: 'deny' }] });
  const current = f.read();
  assert.deepEqual(current.regionCounts, first.regionCounts);
  assert.equal(current.counts.plannedAttending, 4);

});

test('stored capability denies cannot redefine fixed roster authority; departed members leave every count', async t => {
  for (const capability of ['signups.read', 'signups.roster', 'members.directory', 'members.read']) await t.test(capability, t => {
    const f = setup(t), link = f.ir.get('squadMembers', 'sm3');
    f.ir.put('squadMembers', { ...link, squadId: 's2' });
    f.signup('m002', 'attending_on_time'); f.signup('m003', 'not_attending');
    const account = f.ir.get('accounts', 'member');
    f.ir.put('accounts', { ...account, grants: [...account.grants, { capability, scope: { type: 'squads', ids: ['s2'] }, effect: 'deny' }] });
    const fixed = f.read();
    assert.deepEqual(fixed.items.map(row => row.memberId), ['m002', 'm003']);
    assert.equal(fixed.counts.eligibleTotal, 6); assert.equal(fixed.counts.notAttending, 1);
    f.ir.put('members', { ...f.ir.get('members', 'm003'), memberStatus: 'left', membershipStatus: 'departed' });
    const result = f.read();
    assert.deepEqual(result.items.map(row => row.memberId), ['m002']);
    assert.equal(result.counts.eligibleTotal, 5); assert.equal(result.counts.notAttending, 0); assert.equal(result.total, 1);
  });
});

test('current eligibility, visible lifecycle and verified self identity remain required', t => {
  const f = setup(t);
  f.signup('m003', 'attending_on_time');
  f.ir.put('members', { ...f.ir.get('members', 'm003'), memberStatus: 'left', membershipStatus: 'departed' });
  assert.equal(f.read().counts.eligibleTotal, 5); assert.equal(f.read().total, 0);
  assert.throws(() => f.read({ wipeId: 'other-wipe' }), { errorCode: 'RESOURCE_NOT_FOUND' });
  f.sr.put('wipes', { ...f.wipe, lifecycle: 'archived' });
  assert.throws(() => f.read(), { errorCode: 'RESOURCE_NOT_FOUND' });
  f.sr.put('wipes', f.wipe);
  f.ir.put('bindings', { ...f.ir.get('bindings', 'binding-member'), status: 'legacy_unverified' });
  assert.throws(() => f.read(), { errorCode: 'MEMBER_VERIFICATION_REQUIRED' });
});

test('stored wipe-scoped grants cannot remove current fixed-role roster visibility', async t => {
  for (const capability of ['members.directory', 'members.read']) await t.test(capability, t => {
    const f = setup(t); f.signup('m002', 'attending_on_time'); f.signup('m003', 'not_attending');
    const account = f.ir.get('accounts', 'member');
    f.ir.put('accounts', { ...account, grants: [...account.grants, { capability, scope: { type: 'wipes', ids: [f.wipe.id] }, effect: 'deny' }] });
    const result = f.read();
    assert.deepEqual(result.items.map(row => row.memberId), ['m002', 'm003']);
    assert.equal(result.total, 2); assert.equal(result.counts.eligibleTotal, 6); assert.equal(result.counts.responseTotal, 2);
  });
});

test('caller fields cannot choose another actor, bypass scope or inject private projection fields', t => {
  const f = setup(t);
  for (const input of [{ accountId: 'admin' }, { limit: 101 }, { limit: 0 }, { cursor: {} }, { includePrivate: true }])
    assert.throws(() => f.read(input), { errorCode: 'MINI_PARTICIPANTS_INPUT_INVALID' });
});

test('real mini command exposes only the closed roster while ordinary scheduling reads remain self-scoped', async t => {
  const f = setup(t); f.signup('m001', 'attending_on_time');
  f.ir.put('accounts', { ...f.ir.get('accounts', 'admin'), roleId: 'admin', adminAssignedByOwner: true });
  f.ir.put('identities', { ...f.ir.get('identities', 'host-wx-member'), verifiedAt: new Date(f.now()).toISOString() });
  await f.start(); const login = await f.login('member');
  const result = await f.command(login.token, 'member_wipe_participants', { wipeId: f.wipe.id, limit: 30, cursor: '' });
  assert.deepEqual(result.items.map(row => row.memberId), ['m001']);
  assert.deepEqual(f.scheduling.listSignups(f.actor('member'), f.wipe.id).items.map(row => row.memberId), ['m002']);
  await assert.rejects(() => f.command(login.token, 'member_wipe_participants', { wipeId: f.wipe.id, accountId: 'admin' }), { errorCode: 'CLIENT_ACTOR_FORBIDDEN' });
});
