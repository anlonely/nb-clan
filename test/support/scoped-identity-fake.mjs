import { MEMBER_GRANTS } from '../../server/v2/identity/permissions.js';
import { IdentityService } from '../../server/v2/identity/service.js';

// Opt-in unit-test double for the frozen capability/scope engine contract.
// Production fixed roles deliberately ignore account.grants. This double exposes
// synthetic persisted grants so domain tests can exercise deny/squad/target fences.
// HTTP, runtime and identity integration fixtures must use IdentityService.
export class FakeScopedIdentityService extends IdentityService {
  readActorForAccount(accountId) {
    const actor = super.readActorForAccount(accountId);
    return actor && { ...actor, grants: [...structuredClone(MEMBER_GRANTS), ...structuredClone(this.repo.get('accounts', accountId).grants || [])] };
  }
}
export function fixtureIdentity(repo, { scopeContract = false, ...options } = {}) {
  return scopeContract ? new FakeScopedIdentityService(repo, options) : new IdentityService(repo, options);
}
