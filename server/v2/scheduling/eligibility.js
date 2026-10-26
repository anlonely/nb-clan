import { IdentityError } from '../identity/errors.js';

const supported = new Set(['discord', 'kook']);
const refreshErrors = new Set(['ELIGIBILITY_DENIED', 'ELIGIBILITY_UNAVAILABLE', 'ELIGIBILITY_CHANGED', 'LOGIN_UNAVAILABLE']);

function targetEvidence(identity, memberId) {
  const binding = identity.repo.all('bindings').find(row => row.memberId === memberId && row.status === 'verified');
  const account = binding && identity.repo.get('accounts', binding.accountId);
  if (!account || account.memberId !== memberId) throw new IdentityError('MEMBER_VERIFICATION_REQUIRED', 403);
  // Eligibility never grants access over a current account/member restriction.
  identity.accountAccess(account);
  const identities = identity.repo.all('identities').filter(row => row.accountId === account.id && supported.has(row.provider));
  const policies = identity.repo.all('policies'), evidence = identity.repo.all('eligibility'), now = identity.now();
  return identities.map(mapping => {
    const policy = policies.find(row => row.provider === mapping.provider);
    const enabled = policy?.enabled === true && Boolean(policy.guildId) && Array.isArray(policy.allowedRoleIds) && policy.allowedRoleIds.length > 0;
    const current = enabled && evidence.filter(row => row.provider === mapping.provider && row.externalId === mapping.externalId && row.policyId === policy.id)
      .sort((a, b) => (Date.parse(b.checkedAt) || 0) - (Date.parse(a.checkedAt) || 0) || String(a.id).localeCompare(String(b.id)))[0];
    const fresh = current && current.policyRevision === policy.policyRevision && current.guildId === policy.guildId &&
      Number.isFinite(Date.parse(current.checkedAt)) && Date.parse(current.checkedAt) <= now && Date.parse(current.expiresAt) > now;
    const status = fresh && ['eligible', 'ineligible'].includes(current.status) ? current.status : 'unavailable';
    return { provider: mapping.provider, externalId: mapping.externalId, status, canRefresh: Boolean(enabled) };
  });
}

/** Synchronous, network-free gate for a transaction and for scoped counting. */
export function assertTargetEligibility(identity, memberId) {
  const states = targetEvidence(identity, memberId);
  // Password management and approved WeChat-only identities retain the G03
  // active member / verified Steam / restriction rules enforced by the caller.
  if (!states.length || states.some(state => state.status === 'eligible')) return;
  if (states.every(state => state.status === 'ineligible')) throw new IdentityError('ELIGIBILITY_DENIED', 403);
  throw new IdentityError('ELIGIBILITY_UNAVAILABLE', 503);
}

/** Refresh stale/missing/unknown evidence before starting the signup transaction. */
export async function refreshTargetEligibility(identity, memberId) {
  const states = targetEvidence(identity, memberId);
  if (!states.length || states.some(state => state.status === 'eligible')) return assertTargetEligibility(identity, memberId);
  const pending = states.filter(state => state.status === 'unavailable' && state.canRefresh);
  const unique = [...new Map(pending.map(state => [`${state.provider}:${state.externalId}`, state])).values()];
  const results = await Promise.allSettled(unique.map(state => identity.checkEligibility(state.provider, state.externalId)));
  for (const result of results) if (result.status === 'rejected' && !refreshErrors.has(result.reason?.errorCode)) throw result.reason;
  // Re-read mappings, policy versions, restrictions and cache after external I/O.
  return assertTargetEligibility(identity, memberId);
}
