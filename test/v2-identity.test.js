import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { installIdentitySchema, IdentityRepository } from '../server/v2/identity/repository.js';
import { planIdentityMigration, applyIdentityMigration } from '../server/v2/identity/migration.js';
import { IdentityService } from '../server/v2/identity/service.js';
import { AuthContexts, safeReturnTo, digest } from '../server/v2/identity/contexts.js';
import { CAPABILITIES, can, grant, migrateLegacyGrants, roleGrants } from '../server/v2/identity/permissions.js';

const steamA = '76561198000000001', steamB = '76561198000000002';
function fixture(t, input = {}) {
  const db = new DatabaseSync(':memory:'); t.after(() => db.close()); installIdentitySchema(db);
  const repo = new IdentityRepository(db);
  const store = { users: [], members: [], permissionRoles: [], squads: [], squadMembers: [], wechatUsers: [], ...input };
  for (const key of ['users', 'members', 'permissionRoles', 'squads', 'squadMembers', 'wechatUsers']) for (const row of store[key]) repo.put(key, row);
  const plan = planIdentityMigration(store); applyIdentityMigration(repo, plan);
  for (const policy of repo.all('policies')) repo.put('policies', { ...policy, enabled: true, guildId: 'guild', allowedRoleIds: ['member-role'] });
  const platform = { roleIds: ['member-role'], failure: null, calls: 0 };
  const providers = Object.fromEntries(['discord', 'kook'].map(provider => [provider, {
    async roles(externalId, guildId) { platform.calls++; if (platform.failure) throw platform.failure;
      return { externalId, guildId, roleIds: platform.roleIds }; }
  }]));
  const notifications = [];
  const service = new IdentityService(repo, { providers, notify: e => notifications.push(e) });
  const profile = { provider: 'discord', id: 'discord-1', displayName: '本地成员' };
  return { db, repo, service, profile, platform, plan, notifications };
}
async function bind(f, steam = steamA) {
  const evidence = await f.service.checkEligibility(f.profile.provider, f.profile.id);
  const login = f.service.login(f.profile, evidence);
  return f.service.bind(f.profile, steam, evidence, login);
}

test('one-time contexts enforce purpose, provider, browser, expiry, capacity and account', () => {
  let now = 100; const contexts = new AuthContexts({ now: () => now, max: 1, ttl: 20 });
  const token = contexts.issue({ browser: 'browser', purpose: 'oauth', provider: 'kook', accountId: 'a' });
  assert.throws(() => contexts.consume(token, { browser: 'other', purpose: 'oauth' }), /AUTH_INVALID_CALLBACK/);
  assert.throws(() => contexts.consume(token, { browser: 'browser', purpose: 'steam' }), /AUTH_INVALID_CALLBACK/);
  assert.throws(() => contexts.consume(token, { browser: 'browser', purpose: 'oauth', provider: 'discord' }), /AUTH_INVALID_CALLBACK/);
  assert.throws(() => contexts.consume(token, { browser: 'browser', purpose: 'oauth', accountId: 'b' }), /AUTH_INVALID_CALLBACK/);
  assert.throws(() => contexts.issue({ browser: 'x', purpose: 'oauth' }), /AUTH_CAPACITY_EXCEEDED/);
  assert.equal(contexts.consume(token, { browser: 'browser', purpose: 'oauth', accountId: 'a' }).accountId, 'a');
  assert.throws(() => contexts.consume(token, { purpose: 'oauth' }), /AUTH_CONTEXT_EXPIRED/);
  const expired = contexts.issue({ browser: 'browser', purpose: 'oauth' }); now = 121;
  assert.throws(() => contexts.read(expired, { purpose: 'oauth' }), /AUTH_CONTEXT_EXPIRED/);
  assert.equal(JSON.stringify([...contexts.entries.values()]).includes('browser"'), false);
});
test('return paths retain original target and reject redirects and encoded traversal', () => {
  assert.equal(safeReturnTo('/app/wipes/a?tab=signup#mine'), '/app/wipes/a?tab=signup#mine');
  assert.equal(safeReturnTo('/admin/members'), '/admin/members');
  for (const path of ['https://evil.example', '//evil.example', '/app/../../outside', '/app/%2e%2e/out', '/app/%252e%252e/x',
    '/app/\\evil', '/app/%0d%0aevil', '/auth/callback', '/app/auth/callback', ['/app/home']]) assert.equal(safeReturnTo(path), '/app/home');
});
test('migration distinguishes manual IDs from verified KOOK evidence and replays safely', t => {
  const f = fixture(t, { users: [{ id: 'admin', role: 'admin', boundSteamId: steamA, kookId: 'k1', loginProviders: {
    kook: { id: 'k1', verifiedSteamId: steamA, steamVerifiedAt: '2026-01-01T00:00:00Z' } } },
  { id: 'manual', role: 'member', boundSteamId: steamB }], members: [
    { id: 'm1', steamId: steamA, kookAccountId: 'k1', memberStatus: 'active' }, { id: 'm2', steamId: steamB, memberStatus: 'active' }] });
  assert.equal(f.repo.all('bindings').find(b => b.accountId === 'admin').status, 'verified');
  assert.equal(f.repo.all('bindings').find(b => b.accountId === 'manual').status, 'legacy_unverified');
  const migratedAdmin = { id:'admin', status:'active', grants:f.repo.get('accounts', 'admin').grants };
  assert.equal(can(migratedAdmin, 'members.read', {kind:'member',id:'m1'}, {}), true);
  assert.equal(can(migratedAdmin, 'queries.run', {kind:'query',id:'official',querySourceId:'official'}, {}), true);
  assert.equal(can(migratedAdmin, 'queries.run', {kind:'query',id:'official'}, {}), false);
  assert.equal(f.repo.get('accounts', 'admin').grants.some(g => g.capability === 'system.permissions'), false);
  const before = JSON.stringify(f.repo.snapshot());
  assert.equal(applyIdentityMigration(f.repo, f.plan).replayed, true);
  assert.equal(JSON.stringify(f.repo.snapshot()), before);
});
test('duplicate old accounts and platform aliases are quarantined without merging', () => {
  const plan = planIdentityMigration({ users: [{ id: 'a', role: 'member', boundSteamId: steamA }, { id: 'b', role: 'admin', boundSteamId: steamA }],
    members: [{ id: 'm', steamId: steamA, kookId: 'one', kookUserId: 'two' }] });
  assert.ok(plan.accounts.every(a => !a.memberId)); assert.equal(plan.bindings.length, 0);
  assert.ok(plan.conflicts.some(c => c.kind === 'DUPLICATE_MEMBER_ACCOUNTS'));
  assert.ok(plan.conflicts.some(c => c.kind === 'PLATFORM_ALIAS_CONFLICT'));
});
test('new account binds once, gets minimum grants, and never trusts supplied permissions', async t => {
  const f = fixture(t); const result = await bind(f);
  const { actor } = f.service.session(result.token);
  assert.equal(actor.roleId, 'member'); assert.equal(f.repo.all('accounts').length, 1);
  assert.equal(f.repo.all('members').length, 1); assert.equal(f.repo.all('bindings')[0].status, 'verified');
  assert.equal(can(actor, 'system.permissions', { kind: 'account', id: actor.id }, f.service.relations()), false);
  f.service.assertMemberParticipation(actor);
  const evidence = await f.service.checkEligibility('discord', f.profile.id);
  assert.equal(f.service.login(f.profile, evidence).step, 'complete'); assert.equal(f.repo.all('members').length, 1);
  assert.equal(f.repo.get('sessions', digest(result.token)).csrfHash, digest(result.csrfToken));
  assert.equal(JSON.stringify(f.repo.snapshot()).includes(result.token), false);
});
test('verified community login retains the platform nickname for self profile', async t => {
  const f = fixture(t);
  f.profile = { provider: 'kook', id: 'kook-one', displayName: 'KOOK 初始昵称' };
  await bind(f);
  assert.equal(f.repo.all('identities')[0].displayName, 'KOOK 初始昵称');
  f.profile.displayName = 'KOOK 新昵称';
  const evidence = await f.service.checkEligibility('kook', f.profile.id);
  assert.equal(f.service.login(f.profile, evidence).step, 'complete');
  assert.equal(f.repo.all('identities')[0].displayName, 'KOOK 新昵称');
});
test('linking a legacy administrator retains history but does not bypass current role assignment', async t => {
  const f = fixture(t, { users: [{ id: 'a', role: 'admin', boundSteamId: steamA }], members: [{ id: 'm', steamId: steamA, memberStatus: 'active' }] });
  const old = f.repo.get('accounts', 'a'); old.grants.push(grant('risks.read', { type: 'all' }, { effect: 'deny' })); f.repo.put('accounts', old);
  const result = await bind(f); const { actor } = f.service.session(result.token);
  assert.equal(actor.id, 'a'); assert.equal(actor.roleId, 'member');
  assert.deepEqual(actor.grants, roleGrants('member'));
  assert.deepEqual(f.repo.get('accounts', 'a').grants, old.grants);
  assert.equal(can(actor, 'risks.read', { kind: 'member', id: 'm' }, f.service.relations()), false);
  f.service.assertMemberParticipation(actor);
});
test('a second community provider binds to the same account after proving the same Steam identity', async t => {
  const f = fixture(t); const first = await bind(f);
  f.profile = { provider: 'kook', id: 'kook-1', displayName: '同一个成员' };
  const second = await bind(f);
  assert.equal(second.accountId, first.accountId); assert.equal(f.repo.all('accounts').length, 1);
  assert.equal(f.repo.all('identities').length, 2); assert.equal(f.repo.all('bindings').length, 1);
});
test('conflicting ownership, legacy aliases and account revision reject without partial writes', async t => {
  const f = fixture(t); const first = await bind(f);
  const snapshot = JSON.stringify(f.repo.all('members'));
  const evidence = await f.service.checkEligibility('discord', f.profile.id);
  assert.throws(() => f.service.bind(f.profile, steamB, evidence, {}), /IDENTITY_CONFLICT/);
  const account = f.repo.get('accounts', first.accountId);
  assert.throws(() => f.service.bind(f.profile, steamA, evidence, { accountId: account.id, expectedRevision: 999 }), /IDENTITY_CONFLICT/);
  assert.equal(JSON.stringify(f.repo.all('members')), snapshot); assert.equal(f.repo.all('bindings').length, 1);
  assert.equal(f.repo.all('conflicts').filter(c => c.kind === 'IDENTITY_CONFLICT').length, 2);
  f.repo.put('members', { id: 'bad', steamId: steamB, memberStatus: 'active', kookId: 'k1', kookUserId: 'k2' });
  assert.throws(() => f.service.aliases('kook', 'k1', steamB), /IDENTITY_CONFLICT/);
});
test('SQLite unique indexes and transactions reject two owners of verified Steam', async t => {
  const f = fixture(t); await bind(f);
  assert.throws(() => f.repo.transaction(() => {
    f.repo.put('audits', { id: 'rolled-back' });
    f.repo.put('bindings', { id: 'bad', steamId: steamA, memberId: 'bad', accountId: 'bad', status: 'verified' });
  }), /UNIQUE/);
  assert.equal(f.repo.get('audits', 'rolled-back'), null);
});
test('no-role and unavailable checks are distinct, retain history, and reject stale policy proofs', async t => {
  const f = fixture(t); await bind(f);
  f.platform.roleIds = [];
  await assert.rejects(() => f.service.checkEligibility('discord', f.profile.id), { errorCode: 'ELIGIBILITY_DENIED', status: 403 });
  f.platform.failure = new Error('timeout secret must not escape');
  await assert.rejects(() => f.service.checkEligibility('discord', f.profile.id), { errorCode: 'ELIGIBILITY_UNAVAILABLE', status: 503 });
  assert.equal(f.repo.all('members')[0].memberStatus, 'active');
  assert.equal(f.repo.all('eligibility')[0].status, 'unknown');
  f.platform.failure = null; f.platform.roleIds = ['member-role'];
  const evidence = await f.service.checkEligibility('discord', f.profile.id);
  const policy = f.repo.all('policies').find(p => p.provider === 'discord');
  f.repo.put('policies', { ...policy, policyRevision: policy.policyRevision + 1 });
  assert.throws(() => f.service.login(f.profile, evidence), /ELIGIBILITY_CHANGED/);
});
test('any/all rules and configured guild are enforced', async t => {
  const f = fixture(t); const policy = f.repo.all('policies').find(p => p.provider === 'discord');
  f.repo.put('policies', { ...policy, matchMode: 'all', allowedRoleIds: ['member-role', 'extra'] });
  await assert.rejects(() => f.service.checkEligibility('discord', 'x'), /ELIGIBILITY_DENIED/);
  f.platform.roleIds.push('extra'); assert.equal((await f.service.checkEligibility('discord', 'x')).guildId, 'guild');
});
test('departed and blacklisted members never reactivate; paused can read self but not participate', async t => {
  for (const status of ['departed', 'blacklist', 'paused']) {
    const f = fixture(t, { users: [{ id: 'a', role: 'member', boundSteamId: steamA }], members: [{ id: 'm', steamId: steamA, memberStatus: status }] });
    if (status === 'paused') {
      const session = await bind(f); const { actor } = f.service.session(session.token);
      assert.throws(() => f.service.assertMemberParticipation(actor), /MEMBERSHIP_INACTIVE/);
    } else await assert.rejects(() => bind(f), /ACCESS_RESTRICTED/);
    assert.equal(f.repo.get('members', 'm').memberStatus, status);
  }
});
test('unknown roles default deny; custom roles obey legacy hard guards; leaders get no unassigned edits', () => {
  assert.deepEqual(migrateLegacyGrants({ role: 'typo' }, {}).grants, []);
  const custom = migrateLegacyGrants({ id: 'c', role: 'custom' }, { permissionRoles: [{ code: 'custom', permissions: { members: { edit: true } } }] });
  assert.equal(custom.grants.some(g => g.capability === 'members.basic_edit'), false);
  const leader = migrateLegacyGrants({ id: 'l', role: 'leader' }, { squads: [{ id: 's1', leaderUserIds: ['l'] }] });
  assert.ok(leader.review.includes('UNASSIGNED_MEMBER_EDIT_REMOVED'));
  const actor = { id: 'l', status: 'active', memberId: 'm1', grants: leader.grants };
  const relations = { squadMembers: [{ memberId: 'm1', squadId: 's1' }, { memberId: 'm2', squadId: 's2' }], wipes: [] };
  assert.equal(can(actor, 'members.basic_edit', { kind: 'member', id: 'm1' }, relations), true);
  assert.equal(can(actor, 'members.basic_edit', { kind: 'member', id: 'm2' }, relations), false);
  assert.equal(can(actor, 'members.basic_edit', { kind: 'member', id: 'unassigned' }, relations), false);
  const kookOnly = migrateLegacyGrants({ id: 'k', role: 'kook_admin' }, { permissionRoles: [{ code: 'kook_admin', permissions: { kookBot: { edit: true }, permissions: { edit: true } } }] });
  const operator = { id: 'k', status: 'active', grants: kookOnly.grants };
  assert.equal(can(operator, 'platforms.configure', { kind: 'platformTarget', id: 'kook' }, relations), true);
  assert.equal(can(operator, 'platforms.configure', { kind: 'platformTarget', id: 'discord' }, relations), false);
  assert.equal(can(operator, 'system.permissions', { kind: 'account', id: 'k' }, relations), false);
});
test('legacy authenticated official queries retain source gates and explicit denies', () => {
  const migrate = permissions => migrateLegacyGrants({ id: 'q', role: 'official_operator' }, {
    permissionRoles: [{ code: 'official_operator', permissions: { officialKda: permissions } }]
  }).grants;
  const resource = { kind: 'query', id: 'official', querySourceId: 'official' };
  const actor = { id: 'q', status: 'active', grants: migrate({ view: true, edit: true }) };
  assert.equal(can(actor, 'queries.run', resource, {}), true);
  assert.equal(can(actor, 'queries.read', resource, {}), true);
  assert.equal(can(actor, 'inventory.query', resource, {}), false);
  const viewer = { ...actor, grants: migrate({ view: true, edit: false }) };
  assert.equal(can(viewer, 'queries.run', resource, {}), true);
  assert.equal(can(viewer, 'queries.read', resource, {}), true);
  assert.equal(can(viewer, 'queries.run', {kind:'query',id:'official'}, {}), false);
  actor.grants.push({ capability: 'queries.read', scope: { type: 'all' }, effect: 'deny' });
  assert.equal(can(actor, 'queries.read', resource, {}), false);
});
test('legacy KDA and history view preserve export while unrelated modules do not gain it', () => {
  for (const module of ['kda', 'history', 'officialKda', 'members']) {
    const { grants } = migrateLegacyGrants({ id: 'reader', role: 'limited_reader' }, {
      permissionRoles: [{ code: 'limited_reader', permissions: { [module]: { view: true, edit: false } } }]
    });
    const actor = { id: 'reader', status: 'active', grants };
    assert.equal(can(actor, 'stats.export', { kind: 'wipe', id: 'w1' }, {}), ['kda', 'history'].includes(module));
    assert.equal(can(actor, 'sync.run', { kind: 'wipe', id: 'w1' }, {}), false);
    actor.grants.push({ capability: 'stats.export', scope: { type: 'all' }, effect: 'deny' });
    assert.equal(can(actor, 'stats.export', { kind: 'wipe', id: 'w1' }, {}), false);
  }
});
test('scope types do not mix; deny overrides allow and DTO strips private fields', async t => {
  const f = fixture(t); const result = await bind(f); const { actor } = f.service.session(result.token);
  f.repo.put('members', { ...f.repo.get('members', actor.memberId), phone: 'private-phone', notes: 'private-note', riskEvidence: 'private' });
  f.repo.put('members', { id: 'other', displayName: 'other', membershipStatus: 'active' });
  assert.equal(f.service.listMembers(actor).length, 1);
  assert.equal(JSON.stringify(f.service.listMembers(actor)).includes('private'), false);
  const scoped = { ...actor, memberId: null, grants: [grant('members.read', { type: 'wipes', ids: ['same'] })] };
  assert.equal(can(scoped, 'members.read', { kind: 'member', id: 'same' }, f.service.relations()), false);
});
test('permission changes, disable, platform events and logout immediately invalidate sessions', async t => {
  const f = fixture(t); const first = await bind(f); const { actor } = f.service.session(first.token);
  const admin = { id: 'admin', status: 'active', roleId: 'owner', grants: roleGrants('owner') };
  assert.throws(() => f.service.changeAccount(admin, actor.id, { expectedRevision: actor.revision, grants: actor.grants }), /FIXED_ROLE_PERMISSIONS/);
  const updated = f.service.changeAccount(admin, actor.id, { expectedRevision: actor.revision, status: 'disabled' });
  assert.equal(updated.permissionVersion, 2); assert.throws(() => f.service.session(first.token), /AUTH_REQUIRED/);
  assert.equal(f.notifications.length, 1);
  f.service.changeAccount(admin, actor.id, { expectedRevision: updated.revision, status: 'active' });
  const evidence = await f.service.checkEligibility('discord', f.profile.id);
  const second = f.service.login(f.profile, evidence);
  f.service.invalidateEligibility('discord', f.profile.id);
  assert.throws(() => f.service.session(second.token), /AUTH_REQUIRED/);
  const third = f.service.login(f.profile, await f.service.checkEligibility('discord', f.profile.id));
  f.service.logout(third.token); assert.throws(() => f.service.session(third.token), /AUTH_REQUIRED/);
});
test('policies reject empty allowlist and privileged defaults, and revoke on policy changes', async t => {
  const f = fixture(t); const session = await bind(f);
  const admin = { id: 'admin', status: 'active', grants: [grant('platforms.configure', { type: 'all' })] };
  const p = f.repo.all('policies').find(x => x.provider === 'discord');
  assert.throws(() => f.service.savePolicy(admin, { ...p, expectedRevision: 1, defaultRoleId: 'admin' }), /INVALID_ELIGIBILITY_POLICY/);
  assert.throws(() => f.service.savePolicy(admin, { ...p, expectedRevision: 1, allowedRoleIds: [] }), /INVALID_ELIGIBILITY_POLICY/);
  f.service.savePolicy(admin, { ...p, expectedRevision: 1, allowedRoleIds: ['new-role'] });
  assert.throws(() => f.service.session(session.token), /AUTH_REQUIRED/);
});

test('live squad reassignment and removal of leadership invalidate scope and remove old grants', async t => {
  const f = fixture(t, { users: [{ id: 'leader', role: 'leader', boundSteamId: steamA }],
    members: [{ id: 'm1', steamId: steamA, memberStatus: 'active' }],
    squads: [{ id: 's1', leaderUserIds: ['leader'] }], squadMembers: [{ id: 'link', memberId: 'm1', squadId: 's1' }] });
  const first = await bind(f);
  f.repo.put('squadMembers', { id: 'link', memberId: 'm1', squadId: 's2' });
  assert.throws(() => f.service.session(first.token), /PERMISSIONS_CHANGED/);
  assert.equal(f.notifications.at(-1).reason, 'membership_scope_changed');
  const second = f.service.login(f.profile, await f.service.checkEligibility('discord', f.profile.id));
  f.repo.put('squads', { id: 's1', leaderUserIds: [] });
  assert.throws(() => f.service.session(second.token), /PERMISSIONS_CHANGED/);
  const third = f.service.login(f.profile, await f.service.checkEligibility('discord', f.profile.id));
  assert.equal(can(f.service.session(third.token).actor, 'members.basic_edit', { kind: 'member', id: 'm1' }, f.service.relations()), false);
});
test('legacy status changes and timed access restrictions revoke access without altering membership history', async t => {
  const f = fixture(t); const session = await bind(f); const { actor } = f.service.session(session.token);
  const admin = { id: 'admin', status: 'active', grants: [grant('system.accounts', { type: 'all' })] };
  f.service.saveRestriction(admin, { memberId: actor.memberId, kind: 'deny_access', reason: 'fixture restriction',
    startsAt: '2026-01-01T00:00:00Z', expectedRevision: 0 });
  assert.throws(() => f.service.session(session.token), /AUTH_REQUIRED/);
  await assert.rejects(() => bind(f), /ACCESS_RESTRICTED/);
  assert.equal(f.repo.get('members', actor.memberId).memberStatus, 'active');
  const separate = fixture(t); const signedIn = await bind(separate);
  const member = separate.repo.all('members')[0]; separate.repo.put('members', { ...member, memberStatus: 'blocked' });
  assert.throws(() => separate.service.session(signedIn.token), /PERMISSIONS_CHANGED/);
});
test('eligibility TTL rechecks on expiry and policy changes without deleting an ineligible member', async t => {
  const f = fixture(t); const login = await bind(f); const { session } = f.service.session(login.token);
  const calls = f.platform.calls;
  await f.service.requireFreshEligibility(session); assert.equal(f.platform.calls, calls);
  const evidence = f.repo.get('eligibility', session.eligibilityId);
  f.repo.put('eligibility', { ...evidence, expiresAt: '2026-01-01T00:00:00Z' });
  f.platform.roleIds = [];
  await assert.rejects(() => f.service.requireFreshEligibility(session), /ELIGIBILITY_DENIED/);
  assert.equal(f.repo.all('members')[0].memberStatus, 'active');
});
test('WeChat mappings preserve appId namespace and require unambiguous account ownership', () => {
  const data = { settings: { wechat: { appId: 'mini-one' } }, users: [{ id: 'a', role: 'member', boundSteamId: steamA }],
    members: [{ id: 'm', steamId: steamA, memberStatus: 'active' }], wechatUsers: [{ id: 'wx', openid: 'subject', memberId: 'm' }] };
  assert.equal(planIdentityMigration(data).identities[0].provider, 'wechat:mini-one');
  assert.equal(planIdentityMigration({ ...data, settings: {} }).identities.length, 0);
  assert.ok(planIdentityMigration({ ...data, settings: {} }).conflicts.some(c => c.kind === 'WECHAT_LINK_REVIEW'));
  const duplicates = planIdentityMigration({ ...data, wechatUsers: [...data.wechatUsers, { id: 'wx2', openid: 'subject', memberId: 'different' }] });
  assert.equal(duplicates.identities.length, 0);
  assert.equal(duplicates.conflicts.filter(c => c.kind === 'WECHAT_DUPLICATE_IDENTITY').length, 1);
});
test('revoked Steam bindings cannot be silently restored or replaced through onboarding', async t => {
  const f = fixture(t); await bind(f);
  const binding = f.repo.all('bindings')[0]; f.repo.put('bindings', { ...binding, status: 'revoked', revision: binding.revision + 1 });
  const evidence = await f.service.checkEligibility('discord', f.profile.id);
  const login = f.service.login(f.profile, evidence); assert.equal(login.step, 'steam');
  assert.throws(() => f.service.bind(f.profile, steamA, evidence, login), /IDENTITY_CONFLICT/);
  assert.throws(() => f.service.bind(f.profile, steamB, evidence, login), /IDENTITY_CONFLICT/);
  assert.equal(f.repo.all('bindings').length, 1); assert.equal(f.repo.all('bindings')[0].status, 'revoked');
});
test('disabling an account revokes sessions and binding cannot reset its status or grants', async t => {
  const f = fixture(t); const signedIn = await bind(f); const { actor } = f.service.session(signedIn.token);
  const admin = { id: 'admin', status: 'active', grants: [grant('system.accounts', { type: 'all' })] };
  f.service.changeAccount(admin, actor.id, { status: 'disabled', expectedRevision: actor.revision });
  assert.throws(() => f.service.session(signedIn.token), /AUTH_REQUIRED/);
  await assert.rejects(() => bind(f), /ACCOUNT_DISABLED/);
  assert.deepEqual(f.repo.get('accounts', actor.id).grants, actor.grants);
  assert.equal(f.repo.get('accounts', actor.id).status, 'disabled');
});
test('a legacy member Steam edit or deleted member cannot reuse an earlier verified binding', async t => {
  const f = fixture(t); const signedIn = await bind(f); const member = f.repo.all('members')[0];
  f.repo.put('members', { ...member, steamId: steamB });
  assert.throws(() => f.service.session(signedIn.token), /PERMISSIONS_CHANGED/);
  const proof = await f.service.checkEligibility('discord', f.profile.id);
  assert.throws(() => f.service.login(f.profile, proof), /IDENTITY_CONFLICT/);
  f.repo.remove('members', member.id);
  assert.throws(() => f.service.login(f.profile, proof), /IDENTITY_CONFLICT/);
});
