// Explicit synthetic community setup. Uses the production IdentityService's
// eligibility, identity binding, account access and session issuance paths.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

export async function authenticatedSession(identity, accountId, { provider } = {}) {
  const repo = identity.repo;
  let account = repo.get('accounts', accountId);
  assert.ok(account, `Fixture account missing: ${accountId}`);
  const linked = repo.all('identities').find(row => row.accountId === accountId &&
    ['discord', 'kook'].includes(row.provider) && (!provider || row.provider === provider));
  provider ||= linked?.provider || 'discord';
  const externalId = linked?.externalId || `fixture-auth:${accountId}`;
  let policy = repo.all('policies').find(row => row.provider === provider);
  if (!policy?.enabled) {
    policy = { id: policy?.id || provider, provider, enabled: true, guildId: 'fixture-auth-guild',
      allowedRoleIds: ['fixture-auth-member'], matchMode: 'any', defaultRoleId: 'member', policyRevision: (policy?.policyRevision || 0) + 1 };
    repo.put('policies', policy);
  }
  if (!linked) repo.put('identities', { id: `fixture-auth:${provider}:${accountId}`, provider, externalId, accountId, revision: 1 });
  let member = account.memberId && repo.get('members', account.memberId);
  if (!member) {
    const suffix = BigInt(`0x${createHash('sha256').update(accountId).digest('hex').slice(0, 12)}`) % 10000000000n;
    member = { id: `fixture-auth-member:${accountId}`, steamId: `7656119${suffix.toString().padStart(10, '0')}`, memberStatus: 'active', revision: 1 };
    repo.put('members', member);
    account = { ...account, memberId: member.id };
    repo.put('accounts', account);
  }
  const binding = repo.all('bindings').find(row => row.accountId === accountId);
  if (binding?.status !== 'verified') repo.put('bindings', { ...binding, id: binding?.id || `fixture-auth-binding:${accountId}`,
    accountId, memberId: member.id, steamId: member.steamId, status: 'verified', revision: (binding?.revision || 0) + 1,
    proofSource: 'synthetic_fixture_community_verification' });
  identity.providers ||= {};
  if (!identity.providers[provider]?.roles) identity.providers[provider] = {
    ...identity.providers[provider], roles: async (id, guildId) => ({ externalId: id, guildId, roleIds: policy.allowedRoleIds })
  };
  const evidence = await identity.checkEligibility(provider, externalId);
  return identity.issueSession(repo.get('accounts', accountId), evidence);
}

export async function fixtureSessionFactory(identity, accountIds = identity.repo.all('accounts').map(account => account.id)) {
  const evidence = new Map();
  for (const id of accountIds) {
    const issued = await authenticatedSession(identity, id);
    const session = identity.session(issued.token).session;
    evidence.set(id, identity.repo.get('eligibility', session.eligibilityId));
    identity.logout(issued.token);
  }
  return id => {
    assert.ok(evidence.has(id), `Fixture authentication was not prepared: ${id}`);
    return identity.issueSession(identity.repo.get('accounts', id), evidence.get(id));
  };
}
