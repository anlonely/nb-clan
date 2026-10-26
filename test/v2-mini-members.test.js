import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture } from './support/v2-platform-host/fixture.mjs';
import { createMiniMemberViews } from '../server/v2/management-adapters/platforms/mini-members.js';
import { signupId } from '../server/v2/scheduling/service.js';
import { can } from '../server/v2/identity/permissions.js';
import { upsertSqliteCollectionRecord } from '../server/storage/sqlite-migrate.js';

function setup(t) {
  const f = fixture(); t.after(() => f.close());
  const views = createMiniMemberViews(f), actor = () => f.actor('member');
  return { ...f, views, actor, put(collection, value) { upsertSqliteCollectionRecord(f.db, collection, value.id, value); } };
}

test('mini wipes expose normalized server commands and HTTPS map links from the selected snapshot', t => {
  const f = setup(t), base = f.sr.get('wipes', 'host-wipe');
  const read = snapshot => {
    f.sr.put('wipes', { ...base, serverSnapshot: snapshot });
    return f.views.wipes({ actor: f.actor() }).items.find(row => row.id === base.id);
  };
  for (const source of ['client.connect rust.example.com:28015', 'connect rust.example.com:28015', 'rust.example.com:28015', 'steam://connect/rust.example.com:28015/']) {
    const row = read({ directConnect: source, mapLink: 'https://rustmaps.com/map/example?size=3500' });
    assert.equal(row.connectCommand, 'connect rust.example.com:28015');
    assert.equal(row.mapUrl, 'https://rustmaps.com/map/example?size=3500');
  }
  const fallback = read({ connectCommand: 'connect [::1]:28015', mapLink: 'http://example.com/map', rustMapsLink: 'https://rustmaps.com/map/fallback' });
  assert.equal(fallback.connectCommand, 'connect [::1]:28015');
  assert.equal(fallback.mapUrl, 'https://rustmaps.com/map/fallback');
  for (const source of ['', 'connect host:70000', 'connect host:0', 'connect host:28015;quit', 'connect host:28015\nquit']) {
    const row = read({ directConnect: source, mapLink: 'https://user:password@example.com/map' });
    assert.equal(row.connectCommand, ''); assert.equal(row.mapUrl, '');
  }
});

test('editing wipe server materials reaches the mini program wipe view', t => {
  const f = setup(t), base = f.sr.get('wipes', 'host-wipe');
  const wipe = { ...base, serverScheduledWipeAt: base.musterAt };
  f.sr.put('wipes', wipe);
  f.ir.put('accounts', { ...f.ir.get('accounts', 'admin'), roleId: 'admin', adminAssignedByOwner: true });
  const result = f.scheduling.updateWipe(f.identity.actorForAccount('admin'), wipe.id, {
    expectedRevision: wipe.revision,
    serverSnapshot: { ...wipe.serverSnapshot, connectCommand: 'client.connect rust.example.com:28015', mapLink: 'https://rustmaps.com/map/updated' },
    reason: '更新服务器直连与地图链接',
  }, { operationId: 'mini-materials-update' });
  const row = f.views.wipes({ actor: f.actor() }).items.find(item => item.id === wipe.id);
  assert.equal(result.current.contentRevision, wipe.contentRevision + 1);
  assert.equal(row.connectCommand, 'connect rust.example.com:28015');
  assert.equal(row.mapUrl, 'https://rustmaps.com/map/updated');
});

test('mini wipe and profile use server wipe time instead of legacy muster time', t => {
  const f = setup(t), base = f.sr.get('wipes', 'host-wipe');
  const musterAt = '2026-09-24T20:00:00.000Z', serverScheduledWipeAt = '2026-09-24T21:00:00.000Z';
  f.sr.put('wipes', { ...base, lifecycle: 'active', musterAt, serverScheduledWipeAt });
  f.sr.put('signups', { id: signupId(base.id, 'm002'), wipeId: base.id, memberId: 'm002', response: 'attending_on_time', signupRevision: 1, confirmedContentRevision: base.contentRevision });
  assert.equal(f.views.wipes({ actor: f.actor() }).items.find(row => row.id === base.id).startsAt, serverScheduledWipeAt);
  assert.equal(f.views.home({ actor: f.actor() }).member.currentServers[0].startsAt, serverScheduledWipeAt);
  f.sr.put('wipes', { ...base, lifecycle: 'ended', musterAt, serverScheduledWipeAt });
  assert.equal(f.views.home({ actor: f.actor() }).member.recentWipes[0].startsAt, serverScheduledWipeAt);
  f.sr.put('wipes', { ...base, musterAt, serverScheduledWipeAt: null });
  assert.equal(f.views.wipes({ actor: f.actor() }).items.find(row => row.id === base.id).startsAt, musterAt);
});

test('all-team directory is a closed member projection, not a full-profile or admin grant', t => {
  const f = setup(t), me = f.ir.get('members', 'm003');
  f.ir.put('members', { ...me, discordId: 'private-discord', phone: 'private-phone', notes: 'private-notes' });
  const result = f.views.directory({ actor: f.actor(), input: {} });
  assert.ok(result.items.some(row => row.id === 'm003'));
  assert.ok(result.squads.some(row => row.id === 's2'));
  assert.ok(!JSON.stringify(result).includes('private-'));
  assert.deepEqual(Object.keys(result.items[0]).sort(), ['avatar', 'id', 'name', 'specialties', 'squads', 'steamId', 'steamNickname'].sort());
  assert.equal(can(f.actor(), 'members.basic_edit', { kind: 'member', id: 'm003' }, f.identity.relations()), false);
  const filtered = f.views.directory({ actor: f.actor(), input: { squadId: 's2', limit: 1 } });
  assert.ok(filtered.items.length <= 1);
  assert.ok(filtered.items.every(row => row.squads.some(s => s.id === 's2')));
});

test('directory excludes inactive members and restricted accounts cannot read it', t => {
  const f = setup(t), member = f.ir.get('members', 'm003');
  f.ir.put('members', { ...member, memberStatus: 'left' });
  assert.ok(!f.views.directory({ actor: f.actor(), input: {} }).items.some(row => row.id === 'm003'));
  f.ir.put('members', member);
  f.ir.put('restrictions', { id: 'mini-deny', accountId: 'member', kind: 'deny_access', startsAt: new Date(f.now() - 1000).toISOString() });
  assert.throws(() => f.views.directory({ actor: f.actor(), input: {} }), { errorCode: 'ACCESS_RESTRICTED' });
});

test('personal servers require own participation; history is the last three ended participating wipes', t => {
  const f = setup(t), base = f.sr.get('wipes', 'host-wipe');
  const add = (id, n, lifecycle, response, extra = {}) => {
    const at = new Date(f.now() - n * 86400000).toISOString();
    f.sr.put('wipes', { ...base, id, title: id, lifecycle, musterAt: at, endedAt: lifecycle === 'ended' ? at : null, ...extra });
    f.sr.put('signups', { id: signupId(id, 'm002'), wipeId: id, memberId: 'm002', response, signupRevision: 1, confirmedContentRevision: 1, updatedAt: new Date(f.now()).toISOString() });
  };
  add('active-mine', 1, 'active', 'attending_on_time');
  add('upcoming-mine', -2, 'scheduled', 'attending_on_time');
  for (let n = 1; n <= 4; n++) add(`ended-${n}`, n, 'ended', n === 2 ? 'attending_later' : 'attending_on_time');
  add('declined', 0, 'ended', 'not_attending');
  add('withdrawn', 0, 'ended', null);
  add('cancelled', 0, 'ended', 'attending_on_time', { outcome: 'cancelled' });
  const result = f.views.home({ actor: f.actor() });
  assert.deepEqual(result.member.currentServers.map(row => row.wipeId), ['active-mine']);
  assert.deepEqual(result.member.recentWipes.map(row => row.id), ['ended-1', 'ended-2', 'ended-3']);
  assert.equal(result.member.rustTotalMinutes, null);
  assert.equal(result.member.wipeMinutes, null);
});

test('Steam profile, official values and platform roles preserve actual source evidence', t => {
  const f = setup(t), m = f.ir.get('members', 'm002');
  f.put('memberProfiles', { id: 'mini-profile', memberId: m.id, steamId: m.steamId, playTimeKnown: true, playTimeMinutes: 1234,
    officialKda: { kills: 4, deaths: 2 }, officialKdaFetchedAt: new Date(f.now()).toISOString() });
  f.ir.put('identities', { id: 'mini-kook', accountId: 'member', provider: 'kook', externalId: 'mini-kook-id', verifiedAt: new Date(f.now()).toISOString() });
  f.ir.put('policies', { id: 'mini-policy', provider: 'kook', guildId: 'mini-guild', enabled: true, policyRevision: 2, allowedRoleIds: ['allowed-but-not-held'] });
  f.ir.put('eligibility', { id: 'mini-evidence', provider: 'kook', externalId: 'mini-kook-id', guildId: 'mini-guild', policyRevision: 2,
    roleIds: ['actually-held'], community: { name: 'Community', roles: [{ id: 'actually-held', name: '成员' }] }, checkedAt: new Date(f.now()).toISOString(), expiresAt: new Date(f.now() - 1).toISOString() });
  const result = f.views.home({ actor: f.actor() });
  assert.equal(result.member.rustTotalMinutes, 1234);
  assert.equal(result.member.official.values.kd, 2);
  assert.equal(result.member.official.values.rockets, null);
  const kook = result.identities.find(row => row.provider === 'kook');
  assert.deepEqual(kook.roles, [{ id: 'actually-held', name: '成员' }]);
  assert.equal(kook.rolesStatus, 'stale');
  assert.ok(!JSON.stringify(result).includes('allowed-but-not-held'));
  assert.equal(result.identities.find(row => row.provider === 'discord').status, 'unlinked');
});

test('rankings share only Vital summaries in visible wipes and retain missing metrics', t => {
  const f = setup(t), w = f.sr.get('wipes', 'host-wipe');
  f.sr.put('wipes', { ...w, serverSnapshot: { name: 'Vital test', provider: 'vital' } });
  for (const [memberId, sourceId, kills] of [['m002', 'vital', 2], ['m003', 'vital', 8], ['m001', 'moose', 100]]) {
    f.put('kdaRows', { id: `mini-row-${memberId}`, memberId, sourceId, wipeId: w.id, kills, deaths: 2, syncedAt: new Date(f.now()).toISOString() });
  }
  const result = f.views.rankings({ actor: f.actor(), input: { wipeId: w.id, metric: 'kd' } });
  assert.deepEqual(result.items.map(row => row.memberId), ['m003', 'm002']);
  assert.equal(result.items[0].value, 4);
  assert.equal(result.items[0].values.kda, null);
  assert.equal(result.items[0].values.onlineSeconds, null);
  assert.throws(() => f.views.rankings({ actor: f.actor(), input: { wipeId: 'other-wipe' } }), { errorCode: 'RESOURCE_NOT_FOUND' });
  f.db.prepare('INSERT INTO v2_stats_visibility VALUES(?,?,?,?)').run(w.id, 1, 1, 'hidden');
  assert.throws(() => f.views.rankings({ actor: f.actor(), input: { wipeId: w.id } }), { errorCode: 'RESOURCE_NOT_FOUND' });
});

test('unverified or paused members cannot read member projections', t => {
  const f = setup(t);
  f.ir.put('bindings', { ...f.ir.get('bindings', 'binding-member'), status: 'legacy_unverified' });
  assert.throws(() => f.views.directory({ actor: f.actor(), input: {} }), { errorCode: 'MEMBER_VERIFICATION_REQUIRED' });
});

test('member commands and signup work through the real mini host without management authority', async t => {
  const f = setup(t);
  f.ir.put('accounts', { ...f.ir.get('accounts', 'admin'), roleId: 'admin', adminAssignedByOwner: true });
  f.ir.put('identities', { ...f.ir.get('identities', 'host-wx-member'), verifiedAt: new Date(f.now()).toISOString() });
  f.ir.put('identities', { id: 'mini-proof-kook', accountId: 'member', provider: 'kook', externalId: 'mini-member', verifiedAt: new Date(f.now()).toISOString() });
  f.ir.put('policies', { id: 'mini-policy-kook', provider: 'kook', enabled: true, guildId: 'test-guild', allowedRoleIds: ['test-role'], matchMode: 'any', policyRevision: 1 });
  f.identity.providers = { kook: { roles: async (externalId, guildId) => ({ externalId, guildId, roleIds: ['test-role'] }) } };
  await f.start(); const session = await f.login('member');
  assert.equal((await f.command(session.token, 'member_home')).member.id, 'm002');
  assert.ok((await f.command(session.token, 'member_directory')).squads.some(row => row.id === 's2'));
  const list = await f.command(session.token, 'member_wipes'), wipe = list.items.find(row => row.id === 'host-wipe');
  assert.equal(wipe.mySignup.signupRevision, 0);
  const submit = (response, expectedSignupRevision, operationId) => f.host.mini.submit({ token: session.token, operationId,
    payload: { kind: 'direct-v2', adapterVersion: 2, wipeId: wipe.id, input: { response, expectedSignupRevision, confirmedContentRevision: wipe.contentRevision, timeZone: 'Asia/Shanghai', expectedArrivalAt: null } } });
  const saved = await submit('attending_on_time', 0, 'mini-joined'); assert.equal(saved.current.response, 'attending_on_time');
  const roster = await f.command(session.token, 'member_wipe_participants', { wipeId: wipe.id, limit: 30 });
  assert.equal(roster.wipeId, wipe.id);
  assert.ok(roster.items.some(row => row.memberId === 'm002' && row.isSelf && row.response === 'attending_on_time'));
  assert.ok(roster.counts.onTime >= 1);
  assert.equal((await submit('attending_on_time', 0, 'mini-joined')).replayed, true);
  await assert.rejects(() => submit(null, 0, 'mini-stale'), { status: 409 });
  assert.equal((await submit(null, 1, 'mini-withdrawn')).current.response, null);
  await assert.rejects(() => f.command(session.token, 'wipe_create', {}), { status: 410 });
  await assert.rejects(() => f.command(session.token, 'member_home', { accountId: 'admin' }), { status: 403 });
});
