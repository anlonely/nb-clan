import { SchedulingRepository } from './repository.js';
import { SchedulingService } from './service.js';

/** Synchronous, idempotent signup cleanup for a confirmed member departure. */
export function clearCurrentSignupsForDepartedMember(identity, memberId) {
  const repository = new SchedulingRepository(identity.repo.db);
  const scheduling = new SchedulingService(repository, identity, { now: identity.now });
  return scheduling.clearCurrentSignupsForDepartedMember(memberId);
}
