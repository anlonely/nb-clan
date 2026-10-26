import { authorize } from '../../identity/permissions.js';
import { requireValue as need, hash } from '../../member-admin/repository.js';

export const MEMBER_SYNC_TYPES = Object.freeze({ memberProfiles: 'member_profile', discordMembershipAudit: 'discord_membership_audit', steam: 'steam_profile_backfill',
  battlemetrics: 'battlemetrics_identity', kda: 'kda' });

export function createMemberSyncAdapter({ identity, syncService }) {
  need(syncService?.identity === identity && syncService.repo.db === identity.repo.db, 'SYNC_IDENTITY_MISMATCH', 503);
  const validate = args => {
    const { actor, scope, db, kind } = args;
    need(db === identity.repo.db, 'SYNC_IDENTITY_MISMATCH', 503);
    const a = identity.actorForAccount(actor.id);
    need(a.permissionVersion === actor.permissionVersion && scope?.accountId === a.id &&
      scope.permissionVersion === a.permissionVersion, 'PERMISSIONS_CHANGED', 401);
    need(Object.hasOwn(MEMBER_SYNC_TYPES, kind), 'SYNC_KIND_UNSUPPORTED', 422);
    need(Array.isArray(scope.memberIds) && scope.memberIds.length > 0 && scope.memberIds.length <= 200 &&
      new Set(scope.memberIds).size === scope.memberIds.length, 'INVALID_TARGETS', 422);
    for (const id of scope.memberIds) {
      need(identity.repo.get('members', id), 'RESOURCE_NOT_FOUND', 404);
      for (const cap of ['members.read', 'sync.run', kind === 'discordMembershipAudit' ? 'members.change_status' : kind === 'memberProfiles' ? 'risks.manage' : 'members.basic_edit']) {
        authorize(a, cap, { kind: 'member', id }, identity.relations());
      }
    }
    return a;
  };
  const checkJob = (args, actor) => {
    // Public detail projection supplies authoritative scope and at most 50
    // objects; scope.memberIds is the frozen explicit member list.
    const job = syncService.detail(actor, args.jobId);
    need(job.type === MEMBER_SYNC_TYPES[args.kind] && job.scope.kind === 'members' &&
      hash([...job.scope.memberIds].sort()) === hash([...args.scope.memberIds].sort()), 'SYNC_SCOPE_MISMATCH', 403);
    return job;
  };
  return {
    request(args) {
      const actor = validate(args);
      // SyncCenterService owns its queue. Never wrap this call in member write.
      return syncService.request(actor, { type: MEMBER_SYNC_TYPES[args.kind],
        scope: { kind: 'members', memberIds: [...args.scope.memberIds].sort() } }, { operationId: args.operationId });
    },
    status(args) { return checkJob(args, validate(args)); },
    cancel(args) {
      const actor = validate(args);
      checkJob(args, actor);
      need(Number.isSafeInteger(args.expectedRevision) && args.expectedRevision > 0,
        'SYNC_EXPECTED_REVISION_REQUIRED', 422);
      return syncService.action(actor, args.jobId, 'cancel', { expectedRevision: args.expectedRevision },
        { operationId: args.operationId });
    }
  };
}
