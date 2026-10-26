import { fixtures } from '../v2-member-space/fixtures.mjs';
import { IdentityError } from '../../../server/v2/identity/errors.js';
// Explicit isolated-runtime override, never a production policy or background refresh.
export const fixtureEligibilityTtlMs = 60 * 60 * 1000;
export async function refreshFixtureEligibility(identity, { fixture = null } = {}) {
  const selected = fixtures.filter(row => row.accountId && (fixture === null || row.key === fixture));
  if (!selected.length) throw new IdentityError('FIXTURE_INVALID', 422);
  const identities = identity.repo.all('identities');
  const refreshed = [];
  for (const row of selected) {
    for (const mapping of identities.filter(mapping => mapping.accountId === row.accountId && ['discord','kook'].includes(mapping.provider))) {
      const evidence = await identity.checkEligibility(mapping.provider, mapping.externalId);
      refreshed.push({ fixture:row.key,provider:mapping.provider,status:evidence.status,checkedAt:evidence.checkedAt,expiresAt:evidence.expiresAt });
    }
  }
  return { refreshed, count:refreshed.length, eligibilityTtlMs:identity.eligibilityTtl, implementation:'constructed-provider' };
}
