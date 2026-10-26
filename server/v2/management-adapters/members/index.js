import { authorize } from '../../identity/permissions.js';
import { AsyncLocalStorage } from 'node:async_hooks';
import { readSqliteScalar, upsertSqliteScalar } from '../../../storage/sqlite-migrate.js';
import { createMemberAdminWriteAdapter } from '../../member-admin/adapters.js';
import { requireValue as need } from '../../member-admin/repository.js';
import { IdentityMemberLifecycle } from './lifecycle.js';
import { createMemberSyncAdapter } from './sync.js';
export { createMemberContextInvalidator } from './contexts.js';
export { createMemberAdapterObservationRouter } from './routes.js';
export { createMemberServiceBridges, createRealtimeMemberAdapter } from './services.js';
export { IdentityMemberLifecycle, createMemberSyncAdapter };

export function createMemberManagementAdapters({ identity, contexts,
  isTrustedRoot: trustedRoot, syncService, publishDomainEvent = () => {},
  runStoreWriteTask, patchStoreCache }) {
  need(identity?.repo?.db && typeof trustedRoot === 'function', 'MEMBER_HOST_REQUIRED', 503);
  const db = identity.repo.db;
  const observations = new AsyncLocalStorage();
  const lifecycle = new IdentityMemberLifecycle({ identity, contexts });
  const isTrustedRoot = actor => {
    const current = identity.actorForAccount(actor.id);
    return current.permissionVersion === actor.permissionVersion && trustedRoot(current) === true;
  };
  const adapters = {
    deleteIdentity: args => lifecycle.deleteInTransaction(args),
    unlinkIdentity: args => lifecycle.unlinkInTransaction({ ...args,
      expectedIdentityFingerprint: args.expectedIdentityFingerprint ?? observations.getStore() }),
    isTrustedRoot,
    saveRiskSettings({ db: target, settings, tx, actor }) {
      need(target === db && db.isTransaction && tx.actor.id === actor.id, 'IDENTITY_SAME_TRANSACTION_REQUIRED', 503);
      const a = identity.actorForAccount(actor.id);
      need(a.permissionVersion === actor.permissionVersion, 'PERMISSIONS_CHANGED', 401);
      for (const cap of ['risks.manage', 'system.permissions']) authorize(a, cap, { kind: 'account', id: '__collection__' }, identity.relations());
      need(isTrustedRoot(a), 'TRUSTED_ROOT_REQUIRED', 403);
      const old = readSqliteScalar(db, 'settings') || {};
      need(settings.revision === (old.accountRisk?.revision || 1) + 1, 'REVISION_CONFLICT', 409);
      const next = { ...old, accountRisk: settings };
      upsertSqliteScalar(db, 'settings', next);
      tx.changes.push({ collection: 'settings', scalar: true });
      return settings;
    },
    ...(syncService ? { sync: createMemberSyncAdapter({ identity, syncService }) } : {})
  };
  // Keep this synchronous: unfinished contexts are cleared before any cache
  // await or another queued mutation can bind them after an unlink commit.
  function invalidate(result) {
    for (const change of result.changes || []) if (change.collection === 'v2IdentityEvents') {
      const event = identity.repo.get('events', change.id);
      if (['member_identity_unlinked', 'member_deleted'].includes(event?.reason)) contexts.invalidate(event);
    }
  }
  async function afterCommit(result) {
    need(!db.isTransaction, 'IDENTITY_COMMIT_REQUIRED', 503);
    invalidate(result);
    const events = (result.changes || []).filter(c => c.collection === 'v2IdentityEvents')
      .map(c => identity.repo.get('events', c.id)).filter(Boolean);
    identity.publish(events);
    for (const event of result.events || []) await publishDomainEvent({ ...event, operationId: result.operationId });
  }
  // This is the queue-owning writer; pass it directly to the member router and
  // service bridges. Do not wrap it in management writes.member again.
  const baseWrite = createMemberAdminWriteAdapter({ runStoreWriteTask, patchStoreCache });
  async function writeDomain(write, context = {}) {
    need(!context.identity || context.identity === identity, 'MEMBER_RUNTIME_IDENTITY_MISMATCH', 503);
    let committed = false, result;
    try {
      result = await baseWrite(() => {
        const value = observations.run(context.expectedIdentityFingerprint, write);
        need(!value?.then && !db.isTransaction, 'MEMBER_SYNCHRONOUS_WRITE_REQUIRED', 503);
        committed = true;
        invalidate(value);
        return value;
      }, { ...context, identity });
    } catch (error) {
      if (!committed) error.definitelyNotApplied = true;
      throw error;
    }
    await afterCommit(result);
    return result;
  }
  // Existing member outbox remains the durable source. Root owns checkpoint;
  // replay only after commit, persist checkpoint after this resolves.
  async function replayOutbox(row) {
    return afterCommit({ operationId: row.operationId, changes: row.payload.changes, events: row.payload.events });
  }
  return { identity, adapters, lifecycle, writeDomain, afterCommit, replayOutbox };
}
