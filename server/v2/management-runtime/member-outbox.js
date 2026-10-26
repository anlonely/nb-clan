import { IdentityError } from '../identity/errors.js';

const checkpointKey = 'v2ManagementMemberOutbox';
/** At-least-once cache/context/event recovery. It never re-executes a mutation. */
export function createMemberOutboxConsumer({ identity, members, bundle, runWrite, consumeFollowups }) {
  let draining, replaying;
  const position = () => identity.repo.scalar(checkpointKey)?.seq || 0;
  function drain(limit = 50) {
    if (draining) return draining;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new TypeError('Invalid outbox batch');
    draining = (async () => {
      const rows = members.changes(position(), limit);
      for (const row of rows) {
        // Receipts retain scalar flags and exact changes; early outbox versions
        // omitted scalar metadata. Always read the original committed receipt.
        const stored = identity.repo.db.prepare('SELECT payload FROM v2_member_admin_operations WHERE actor_id=? AND operation_id=?')
          .get(row.payload.actorId, row.operationId);
        if (!stored) throw new IdentityError('MEMBER_OUTBOX_RECEIPT_MISSING', 503);
        const receipt = JSON.parse(stored.payload);
        await bundle.writeDomain(() => receipt, { identity });
        await consumeFollowups?.(row.seq);
        await runWrite(() => identity.repo.setScalar(checkpointKey, { seq: Math.max(position(), row.seq) }));
      }
      return { processed: rows.length, seq: position() };
    })().finally(() => { draining = null; });
    return draining;
  }
  function drainAll() {
    if (replaying) return replaying;
    replaying = (async () => {
      let processed = 0;
      for (;;) {
        const batch = await drain();
        processed += batch.processed;
        if (!batch.processed) return { processed, seq: position() };
      }
    })().finally(() => { replaying = null; });
    return replaying;
  }
  return { drain, drainAll, position };
}
