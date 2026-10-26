import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { installIdentitySchema, IdentityRepository } from '../server/v2/identity/repository.js';
import { IdentityService } from '../server/v2/identity/service.js';
import { assertTargetEligibility, refreshTargetEligibility } from '../server/v2/scheduling/eligibility.js';

const error = (code, status) => value => value.errorCode === code && value.status === status;
function fixture(t, providers = ['discord']) {
  const db = new DatabaseSync(':memory:'); t.after(() => db.close()); installIdentitySchema(db);
  const repo = new IdentityRepository(db), clock = { now: Date.parse('2030-09-08T10:00:00Z') };
  const states = Object.fromEntries(['discord', 'kook'].map(provider => [provider, { roles: ['member'], calls: 0, unavailable: false }]));
  repo.put('members', { id: 'member', steamId: '76561198000000401', memberStatus: 'active' });
  repo.put('accounts', { id: 'account', memberId: 'member', status: 'active', permissionVersion: 1, revision: 1, grants: [] });
  repo.put('bindings', { id: 'binding', accountId: 'account', memberId: 'member', steamId: '76561198000000401', status: 'verified' });
  for (const provider of providers) repo.put('identities', { id: `identity_${provider}`, accountId: 'account', provider, externalId: `${provider}_subject` });
  for (const provider of ['discord', 'kook']) repo.put('policies', { id: `policy_${provider}`, provider, enabled: true, guildId: 'guild',
    allowedRoleIds: ['member'], matchMode: 'any', defaultRoleId: 'member', policyRevision: 1 });
  const identity = new IdentityService(repo, { now: () => clock.now, providers: Object.fromEntries(['discord', 'kook'].map(provider => [provider, {
    async roles(externalId, guildId) {
      const state = states[provider]; state.calls++;
      if (state.onFetch) await state.onFetch();
      if (state.unavailable) throw new Error('controlled provider outage');
      return { externalId, guildId, roleIds: state.roles };
    }
  }])) });
  const refresh = () => refreshTargetEligibility(identity, 'member');
  const check = () => assertTargetEligibility(identity, 'member');
  return { db, repo, identity, clock, states, refresh, check };
}

test('missing, expired and old-policy eligibility requires refresh; sync gate makes no platform request', async t => {
  const f = fixture(t);
  assert.throws(f.check, error('ELIGIBILITY_UNAVAILABLE', 503)); assert.equal(f.states.discord.calls, 0);
  await f.refresh(); f.check(); assert.equal(f.states.discord.calls, 1);
  await f.refresh(); assert.equal(f.states.discord.calls, 1);
  f.clock.now += 300_000;
  assert.throws(f.check, error('ELIGIBILITY_UNAVAILABLE', 503)); await f.refresh(); assert.equal(f.states.discord.calls, 2);
  const policy = f.repo.get('policies', 'policy_discord'); f.repo.put('policies', { ...policy, policyRevision: 2 });
  assert.throws(f.check, error('ELIGIBILITY_UNAVAILABLE', 503)); await f.refresh(); f.check();
  assert.equal(f.repo.all('eligibility')[0].policyRevision, 2);
});

test('explicit current role rejection denies delegated target eligibility without rewriting member state', async t => {
  const f = fixture(t); await f.refresh(); f.states.discord.roles = [];
  await assert.rejects(() => f.identity.checkEligibility('discord', 'discord_subject'), error('ELIGIBILITY_DENIED', 403));
  assert.throws(f.check, error('ELIGIBILITY_DENIED', 403));
  const calls = f.states.discord.calls; await assert.rejects(f.refresh, error('ELIGIBILITY_DENIED', 403));
  assert.equal(f.states.discord.calls, calls); assert.equal(f.repo.get('members', 'member').memberStatus, 'active');
});

test('unknown source result fails closed but a later explicit retry can refresh it', async t => {
  const f = fixture(t); f.states.discord.unavailable = true;
  await assert.rejects(f.refresh, error('ELIGIBILITY_UNAVAILABLE', 503));
  assert.equal(f.repo.all('eligibility')[0].status, 'unknown'); assert.throws(f.check, error('ELIGIBILITY_UNAVAILABLE', 503));
  f.states.discord.unavailable = false; await f.refresh(); f.check(); assert.equal(f.states.discord.calls, 2);
});

test('any current eligible mapped provider suffices while stale or rejected siblings do not grant access alone', async t => {
  const f = fixture(t, ['discord', 'kook']); f.states.discord.roles = [];
  await f.refresh(); f.check(); assert.equal(f.states.discord.calls, 1); assert.equal(f.states.kook.calls, 1);
  f.states.kook.roles = []; await assert.rejects(() => f.identity.checkEligibility('kook', 'kook_subject'), error('ELIGIBILITY_DENIED', 403));
  assert.throws(f.check, error('ELIGIBILITY_DENIED', 403));
  const policy = f.repo.get('policies', 'policy_kook'); f.repo.put('policies', { ...policy, policyRevision: 2 });
  assert.throws(f.check, error('ELIGIBILITY_UNAVAILABLE', 503));
});

test('disabled or absent policies never reuse old eligible records', async t => {
  const f = fixture(t); await f.refresh();
  const policy = f.repo.get('policies', 'policy_discord'); f.repo.put('policies', { ...policy, enabled: false });
  assert.throws(f.check, error('ELIGIBILITY_UNAVAILABLE', 503)); await assert.rejects(f.refresh, error('ELIGIBILITY_UNAVAILABLE', 503));
  assert.equal(f.states.discord.calls, 1);
  f.repo.remove('policies', 'policy_discord'); assert.throws(f.check, error('ELIGIBILITY_UNAVAILABLE', 503));
});

test('only identities belonging to the target account can supply its eligibility', async t => {
  const f = fixture(t, ['discord', 'kook']);
  f.repo.put('identities', { ...f.repo.get('identities', 'identity_kook'), accountId: 'another_account' });
  await f.identity.checkEligibility('kook', 'kook_subject');
  assert.throws(f.check, error('ELIGIBILITY_UNAVAILABLE', 503)); await f.refresh();
  assert.equal(f.states.discord.calls, 1); f.check();
});

test('target is rechecked after a role query races a restriction or policy change', async t => {
  const f = fixture(t);
  f.states.discord.onFetch = async () => f.repo.put('restrictions', { id: 'deny', memberId: 'member', kind: 'deny_access',
    startsAt: new Date(f.clock.now - 1000).toISOString() });
  await assert.rejects(f.refresh, error('ACCESS_RESTRICTED', 403));
  f.repo.remove('restrictions', 'deny');
  f.clock.now += 300_000;
  f.states.discord.onFetch = async () => f.repo.put('policies', { ...f.repo.get('policies', 'policy_discord'), policyRevision: 2 });
  await assert.rejects(f.refresh, error('ELIGIBILITY_UNAVAILABLE', 503));
});

test('password and approved WeChat-only target paths retain G03 binding and restriction checks', async t => {
  for (const mapped of [[], ['wechat:fixture_app']]) {
    const f = fixture(t, mapped); f.check(); await f.refresh();
    assert.equal(f.states.discord.calls + f.states.kook.calls, 0);
    f.repo.put('restrictions', { id: 'deny', accountId: 'account', kind: 'deny_access', startsAt: new Date(f.clock.now - 1000).toISOString() });
    assert.throws(f.check, error('ACCESS_RESTRICTED', 403));
    f.repo.remove('restrictions', 'deny'); f.repo.put('bindings', { ...f.repo.get('bindings', 'binding'), status: 'revoked' });
    assert.throws(f.check, error('MEMBER_VERIFICATION_REQUIRED', 403));
  }
});
