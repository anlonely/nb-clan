import { randomUUID } from 'node:crypto';
import { resourceFields } from './business.js';

const terminalWipes = new Set(['ended', 'archived', 'cancelled']);
const queueStates = new Set(['queued', 'retry_wait']);
const validDate = value => typeof value === 'string' && Number.isFinite(Date.parse(value));
const due = (value, now) => value == null || validDate(value) && Date.parse(value) <= now;
const iso = value => new Date(value).toISOString();
const safeCode = (value, fallback = 'PLATFORM_RESULT_UNKNOWN') => typeof value === 'string' && /^[A-Z][A-Z0-9_]{0,99}$/.test(value) ? value : fallback;
const safeId = value => typeof value === 'string' && value.length <= 200 && !/[\x00-\x1f\x7f]/.test(value) ? value : null;
const bounded = (value, fallback, max) => Number.isSafeInteger(value) && value > 0 ? Math.min(value, max) : fallback;

/** A finite, explicitly driven worker. Construction never starts a timer or a request. */
export function createNotificationWorker(service) {
  const { repo } = service;
  const active = new Set();
  const controllers = new Set();
  let stopped = false;
  const now = () => Number(service.now());
  const leaseMs = bounded(service.options?.leaseMs, 30_000, 600_000);
  const maxAttempts = bounded(service.options?.maxAttempts, 5, 20);
  const timeoutMs = Math.min(leaseMs, bounded(service.options?.requestTimeoutMs, 30_000, 600_000));
  const changed = (delivery, type) => service.changed(delivery, type);
  const attemptFor = row => row.currentAttemptId && repo.get('attempts', row.currentAttemptId);
  const matches = (row, claim) => row && row.executionEpoch === claim.executionEpoch && row.leaseOwner === claim.leaseOwner &&
    row.currentAttemptId === claim.currentAttemptId && row.status === (claim.kind === 'send' ? 'sending' : 'running');
  const owns = (row, claim) => matches(row, claim) && validDate(row.leaseUntil) && Date.parse(row.leaseUntil) > now();
  const release = row => { row.leaseOwner = null; row.leaseUntil = null; };
  const errorFields = (row, code) => { row.lastErrorCode = safeCode(code); row.lastErrorMessage = null; };
  const nextRetry = (count, requested) => iso(now() + Math.max(1_000, Math.min(Number.isFinite(requested) && requested >= 0 ? requested : 1_000 * 2 ** Math.min(count - 1, 8), 900_000)));
  const touchOperation = (op, delivery, type) => { op.updatedAt = iso(now()); repo.put('messageOperations', op); changed(delivery, type); };
  const recordAttemptResult = (attempt, outcome, code = null) => {
    if (!attempt) return;
    attempt.status = 'completed'; attempt.resultKind = outcome; attempt.errorCode = code ? safeCode(code) : null; attempt.completedAt = iso(now());
    repo.put('attempts', attempt);
  };
  const refFor = op => op.messageRefId && repo.get('messageRefs', op.messageRefId);
  const markRef = (op, state) => {
    const ref = refFor(op);
    if (ref && ref.state !== 'deleted') { ref.state = state; ref.lastMessageOperationId=op.id; ref.updatedAt = iso(now()); repo.put('messageRefs', ref); }
  };
  const enqueueEdits = (delivery, reasonCode) => {
    for (const ref of repo.all('messageRefs').filter(row => row.deliveryId === delivery.id && row.state !== 'deleted')) {
      service.queueMessageOperation(delivery, 'edit', { reasonCode, messageRefId: ref.id });
    }
  };

  function unknownDelivery(delivery, code) {
    delivery.status = 'delivery_unknown'; delivery.knownNotSent = false; delivery.nextAttemptAt = null;
    errorFields(delivery, code); release(delivery); changed(delivery, 'delivery.unknown');
  }
  function unknownOperation(op, delivery, code) {
    op.status = 'unknown'; op.lastErrorCode = safeCode(code); op.nextAttemptAt = null; release(op);
    if (op.kind !== 'lookup') markRef(op, 'update_unknown');
    touchOperation(op, delivery, 'message_operation.unknown');
  }
  function expireClaim(row, kind) {
    const attempt = attemptFor(row);
    if (kind === 'send') unknownDelivery(row, 'WORKER_LEASE_EXPIRED');
    else {
      const delivery = repo.get('deliveries', row.deliveryId);
      if (!delivery) return;
      unknownOperation(row, delivery, 'WORKER_LEASE_EXPIRED');
    }
    recordAttemptResult(attempt, 'unknown', 'WORKER_LEASE_EXPIRED');
  }

  async function recoverExpired({ workerId, limit = 100 } = {}) {
    assertWorker(workerId); const maximum = bounded(limit, 100, 1_000);
    return repo.transaction(() => {
      let unknown = 0, released = 0;
      for (const [collection, kind, status] of [['deliveries', 'send', 'sending'], ['messageOperations', 'operation', 'running']]) {
        for (const row of repo.all(collection)) {
          if (unknown >= maximum) break;
          if (row.status !== status || validDate(row.leaseUntil) && Date.parse(row.leaseUntil) > now()) continue;
          expireClaim(row, kind); unknown++; released++;
        }
      }
      return { unknown, released };
    });
  }

  function consumeOutbox(limit) {
    const events = repo.pendingSchedulingEvents(limit);
    for (const event of events) repo.transaction(() => {
      const eventId = event.eventId || event.id;
      if (repo.get('consumedEvents', eventId)) return;
      const wipe = service.scheduling.repo.get('wipes', event.wipeId);
      for (const delivery of repo.forWipe('deliveries', event.wipeId)) {
        if (event.type === 'wipe.changed' && wipe) {
          const intent = repo.get('intents', delivery.intentId);
          const stale = delivery.snapshot?.contentRevision !== wipe.contentRevision || intent?.wipeRevision !== wipe.revision ||
            (delivery.expiresAt != null && terminalWipes.has(wipe.lifecycle));
          if (stale && queueStates.has(delivery.status)) {
            delivery.status = 'cancelled'; delivery.knownNotSent = true; delivery.nextAttemptAt = null;
            errorFields(delivery, 'PREVIEW_STALE'); changed(delivery, 'delivery.cancelled');
          } else if (stale && delivery.status === 'sending') {
            delivery.cancelRequested = true; changed(delivery, 'delivery.cancel_requested');
          }
        }
        if (['signup.changed', 'wipe.changed'].includes(event.type)) enqueueEdits(delivery, event.type === 'signup.changed' ? 'SIGNUP_CHANGED' : 'WIPE_CHANGED');
      }
      repo.put('consumedEvents', { id: eventId, eventId, type: event.type, wipeId: event.wipeId, consumedAt: iso(now()) });
    });
  }

  function refreshDiscordSignupConfiguration() {
    repo.transaction(() => {
      for (const delivery of repo.all('deliveries')) {
        if (delivery.resource !== undefined || delivery.platform !== 'discord' || delivery.status !== 'sent' || repo.get('intents', delivery.intentId)?.purpose !== 'signup_open') continue;
        let target;
        try { target = service.target(delivery.targetId); } catch { continue; }
        if (!target.enabled || !target.signupMode || target.guildId !== delivery.target.guildId || target.channelId !== delivery.target.channelId) continue;
        for (const ref of repo.forWipe('messageRefs', delivery.wipeId).filter(row => row.deliveryId === delivery.id && row.state === 'active')) {
          if ((ref.configurationRevision || delivery.target.configurationRevision) === target.configurationRevision || ref.requestedConfigurationRevision === target.configurationRevision) continue;
          service.queueMessageOperation(delivery, 'edit', { reasonCode: 'DISCORD_SIGNUP_CONFIGURATION_CHANGED', messageRefId: ref.id });
          // Admit one refresh per saved version. A failed/unknown edit retains
          // its normal reconciliation rules instead of triggering fresh sends.
          repo.put('messageRefs', { ...ref, requestedConfigurationRevision: target.configurationRevision });
        }
      }
    });
  }

  function consumeMemberOutbox(limit) {
    if (!repo.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='v2_member_admin_outbox'").get()) return;
    const key = 'v2NotificationMemberOutbox', after = repo.scalar(key)?.seq || 0;
    const rows = repo.db.prepare('SELECT seq FROM v2_member_admin_outbox WHERE seq>? ORDER BY seq LIMIT ?').all(after, limit);
    if (!rows.length) return;
    repo.transaction(() => {
      // Counts are based on the current authorized roster, including members
      // newly entering an audience. Old delivery snapshots contain no IDs.
      // Refresh existing cards; never create a new delivery/send intent.
      for (const delivery of repo.all('deliveries')) {
        if (delivery.resource !== undefined) continue; // Business resources never receive roster edits.
        if (!terminalWipes.has(service.scheduling.repo.get('wipes', delivery.wipeId)?.lifecycle)) enqueueEdits(delivery, 'MEMBER_ROSTER_CHANGED');
      }
      repo.setScalar(key, { seq: rows.at(-1).seq });
    });
  }

  function assertWorker(workerId) {
    if (!safeId(workerId) || !workerId.trim()) throw new TypeError('workerId is required');
  }
  function prepareAttempt(row, kind, workerId, op = null) {
    row.executionEpoch = (row.executionEpoch || 0) + 1; row.attemptCount = (row.attemptCount || 0) + 1;
    row.leaseOwner = workerId; row.leaseUntil = iso(now() + leaseMs); row.currentAttemptId = `attempt_${randomUUID()}`;
    const attempt = { id: row.currentAttemptId, ...resourceFields(row), kind, deliveryId: op ? op.deliveryId : row.id, messageOperationId: op?.id || null,
      payloadHash: row.payloadHash || null, executionEpoch: row.executionEpoch, leaseOwner: row.leaseOwner, leaseUntil: row.leaseUntil,
      attemptCount: row.attemptCount, operationKey: kind === 'send' ? `notification:${row.id}` : `${kind}:${row.id}`,
      status: 'prepared', resultKind: null, errorCode: null, createdAt: iso(now()), startedAt: null, completedAt: null };
    repo.put('attempts', attempt);
    return { ...structuredClone(row), kind, attempt };
  }

  function claimDelivery(id, workerId) {
    return repo.transaction(() => {
      const delivery = repo.get('deliveries', id);
      if (!delivery || !queueStates.has(delivery.status) || !due(delivery.dueAt, now()) || !due(delivery.nextAttemptAt, now())) return null;
      if ((delivery.status === 'retry_wait' || delivery.attemptCount > 0) && delivery.knownNotSent !== true) {
        unknownDelivery(delivery, 'DELIVERY_NOT_RETRYABLE'); return { skipped: true, unknown: true };
      }
      try {
        if (delivery.expiresAt && (!validDate(delivery.expiresAt) || Date.parse(delivery.expiresAt) <= now())) throw { errorCode: 'REMINDER_EXPIRED' };
        if (delivery.cancelRequested) throw { errorCode: 'DELIVERY_CANCELLED' };
        service.executionContext(delivery, { mode: 'send' });
      } catch (error) {
        if (!error?.errorCode) throw error;
        const code = safeCode(error?.errorCode, 'ACCESS_DENIED');
        delivery.status = ['REMINDER_EXPIRED', 'PREVIEW_STALE', 'DELIVERY_CANCELLED', 'REVIEW_NOTIFICATION_PENDING_SUPERSEDED'].includes(code) ? 'cancelled' : 'failed';
        delivery.knownNotSent = true; delivery.nextAttemptAt = null; errorFields(delivery, code); changed(delivery, 'delivery.skipped');
        return { skipped: true };
      }
      delivery.status = 'sending'; delivery.knownNotSent = false; delivery.nextAttemptAt = null;
      const claim = prepareAttempt(delivery, 'send', workerId); changed(delivery, 'delivery.sending'); return claim;
    });
  }

  function claimOperation(id, workerId) {
    return repo.transaction(() => {
      const op = repo.get('messageOperations', id);
      if (!op || op.status !== 'queued' || !due(op.nextAttemptAt, now())) return null;
      const delivery = repo.get('deliveries', op.deliveryId);
      if (!delivery) { op.status = 'skipped'; op.updatedAt = iso(now()); repo.put('messageOperations', op); return { skipped: true }; }
      // Recheck against the current transaction even when the batch snapshot
      // considered this operation eligible: another worker may have claimed first.
      if (operationBlocked(op, operationBlockers(repo.all('messageOperations')))) return null;
      try {
        service.executionContext(delivery, { mode: op.kind === 'lookup' ? 'lookup' : 'edit', actorAccountId: op.actorAccountId });
        if (op.kind === 'lookup' && delivery.status !== 'delivery_unknown') throw { errorCode: 'DELIVERY_NOT_UNKNOWN' };
        if (op.kind === 'lookup') op.deliveryEpoch = delivery.executionEpoch;
        if (op.kind !== 'lookup') {
          const ref = refFor(op);
          if (!ref || ref.state === 'deleted') throw { errorCode: 'MESSAGE_DELETED' };
          if (op.kind === 'edit') Object.assign(op, service.renderEdit(delivery));
        }
      } catch (error) {
        if (!error?.errorCode) throw error;
        op.status = ['MESSAGE_DELETED', 'DELIVERY_NOT_UNKNOWN'].includes(error?.errorCode) ? 'skipped' : 'failed';
        op.lastErrorCode = safeCode(error?.errorCode, 'ACCESS_DENIED');
        if (op.kind !== 'lookup' && op.status === 'failed') markRef(op, 'update_failed');
        touchOperation(op, delivery, 'message_operation.skipped'); return { skipped: true };
      }
      op.status = 'running'; op.nextAttemptAt = null;
      const claim = prepareAttempt(op, op.kind, workerId, op); touchOperation(op, delivery, 'message_operation.running'); return claim;
    });
  }

  function operationBlockers(operations) {
    const runningRefs = new Set(), unknownEditRefs = new Set(), runningLookups = new Set();
    for (const op of operations) {
      if (op.status === 'running') {
        if (op.messageRefId) runningRefs.add(op.messageRefId);
        if (op.kind === 'lookup') runningLookups.add(op.deliveryId);
      } else if (op.status === 'unknown' && op.kind === 'edit' && op.messageRefId) unknownEditRefs.add(op.messageRefId);
    }
    return { runningRefs, unknownEditRefs, runningLookups };
  }

  function operationBlocked(op, blockers) {
    return Boolean(op.messageRefId && (blockers.runningRefs.has(op.messageRefId) ||
      op.kind === 'edit' && blockers.unknownEditRefs.has(op.messageRefId)) ||
      op.kind === 'lookup' && blockers.runningLookups.has(op.deliveryId));
  }

  function recordLateEvidence(claim, result) {
    // No late result may overwrite a newer lease, delivery, operation or message revision.
    const attempt = repo.get('attempts', claim.currentAttemptId);
    if (!attempt) return;
    const evidence = { receivedAt: iso(now()), outcome: ['sent', 'not_sent', 'updated', 'deleted', 'not_updated', 'found', 'not_found', 'unknown'].includes(result?.outcome) ? result.outcome : 'unknown',
      errorCode: result?.errorCode ? safeCode(result.errorCode) : null, providerRequestId: safeId(result?.providerRequestId) };
    attempt.lateEvidence = [...(attempt.lateEvidence || []), evidence].slice(-5); repo.put('attempts', attempt);
    if (claim.kind === 'edit' && evidence.outcome === 'updated' && !repo.get('messageOperations',claim.id)?.reconciliation) {
      const delivery = repo.get('deliveries', claim.deliveryId);
      const ref = repo.get('messageRefs', claim.messageRefId);
      if (delivery && ref && ref.state !== 'deleted') service.queueMessageOperation(delivery, 'edit', { reasonCode: 'LATE_EDIT_COMPENSATION', messageRefId: ref.id });
    }
  }
  const lateEvidence = (claim, result) => repo.transaction(() => recordLateEvidence(claim, result));

  function applySend(claim, result) {
    return repo.transaction(() => {
      const delivery = repo.get('deliveries', claim.id);
      if (!owns(delivery, claim)) {
        if (matches(delivery, claim)) expireClaim(delivery, 'send');
        recordLateEvidence(claim, result); return 'unknown';
      }
      const attempt = attemptFor(delivery);
      if (delivery.resource !== undefined) {
        try { service.executionContext(delivery, { mode: 'completion', actorAccountId: claim.createdByAccountId }); }
        catch (error) {
          unknownDelivery(delivery, safeCode(error?.errorCode, 'ACCESS_DENIED'));
          recordAttemptResult(attempt, 'unknown', delivery.lastErrorCode); recordLateEvidence(claim, result); return 'unknown';
        }
      }
      if (result?.outcome === 'sent') {
        let ref;
        try {
          ref = service.validateMessageRef(result.messageRef, delivery.target);
        } catch {
          unknownDelivery(delivery, 'MESSAGE_REFERENCE_INVALID'); recordAttemptResult(attempt, 'unknown', 'MESSAGE_REFERENCE_INVALID'); return 'unknown';
        }
        service.recordMessageRef(delivery, ref, delivery.snapshot.contentRevision);
        delivery.status = 'sent'; delivery.knownNotSent = false; delivery.sentAt = iso(now()); delivery.nextAttemptAt = null;
        delivery.lastErrorCode = null; delivery.lastErrorMessage = null; release(delivery); changed(delivery, 'delivery.sent');
        recordAttemptResult(attempt, 'sent'); enqueueEdits(delivery, delivery.cancelRequested ? 'SEND_CANCELLATION_COMPENSATION' : 'SEND_SNAPSHOT_REFRESH'); return 'sent';
      }
      if (result?.outcome === 'not_sent') {
        delivery.knownNotSent = true; errorFields(delivery, result.errorCode); release(delivery);
        const retry = result.retryable === true && delivery.attemptCount < maxAttempts && !delivery.cancelRequested;
        delivery.status = delivery.cancelRequested ? 'cancelled' : retry ? 'retry_wait' : 'failed';
        delivery.nextAttemptAt = retry ? nextRetry(delivery.attemptCount, result.retryAfterMs) : null;
        changed(delivery, 'delivery.not_sent'); recordAttemptResult(attempt, 'not_sent', result.errorCode); return 'failed';
      }
      unknownDelivery(delivery, result?.errorCode); recordAttemptResult(attempt, 'unknown', result?.errorCode); return 'unknown';
    });
  }

  function applyOperation(claim, result) {
    return repo.transaction(() => {
      const op = repo.get('messageOperations', claim.id), delivery = repo.get('deliveries', claim.deliveryId);
      if (!delivery || !owns(op, claim)) {
        if (delivery && matches(op, claim)) expireClaim(op, 'operation');
        recordLateEvidence(claim, result); return 'unknown';
      }
      const attempt = attemptFor(op);
      if (delivery.resource !== undefined) {
        try { service.executionContext(delivery, { mode: op.kind === 'lookup' ? 'lookup_completion' : 'completion', actorAccountId: claim.actorAccountId }); }
        catch (error) {
          unknownOperation(op, delivery, safeCode(error?.errorCode, 'ACCESS_DENIED'));
          recordAttemptResult(attempt, 'unknown', op.lastErrorCode); recordLateEvidence(claim, result); return 'unknown';
        }
      }
      if (op.kind === 'lookup') {
        if (delivery.status !== 'delivery_unknown' || delivery.executionEpoch !== op.deliveryEpoch) {
          op.status = 'skipped'; release(op); touchOperation(op, delivery, 'message_operation.skipped');
          recordAttemptResult(attempt, 'ignored'); return 'skipped';
        }
        if (result?.outcome === 'found') {
          let foundRef;
          try { foundRef = service.validateMessageRef(result.messageRef, delivery.target); }
          catch { result = { outcome: 'unknown', errorCode: 'MESSAGE_REFERENCE_INVALID' }; }
          if (result.outcome === 'found') {
            service.recordMessageRef(delivery, foundRef, delivery.snapshot.contentRevision);
            delivery.status = 'sent'; delivery.sentAt ||= iso(now()); delivery.knownNotSent = false;
            delivery.lastErrorCode = null; delivery.lastErrorMessage = null; op.status = 'succeeded';
            release(op); touchOperation(op, delivery, 'delivery.lookup_found'); recordAttemptResult(attempt, 'found'); enqueueEdits(delivery, 'LOOKUP_FOUND_REFRESH'); return 'updated';
          }
        }
        if (result?.outcome === 'not_found' && result.definitive === true && typeof result.evidence === 'string' && result.evidence.trim()) {
          delivery.status = 'failed'; delivery.knownNotSent = true; errorFields(delivery, 'NOT_SENT_CONFIRMED');
          op.status = 'succeeded'; op.evidence = result.evidence.slice(0, 2_000); release(op);
          touchOperation(op, delivery, 'delivery.lookup_not_sent'); recordAttemptResult(attempt, 'not_found'); return 'updated';
        }
        unknownOperation(op, delivery, result?.errorCode); recordAttemptResult(attempt, 'unknown', result?.errorCode); return 'unknown';
      }
      const ref = refFor(op);
      if (result?.outcome === 'updated' || result?.outcome === 'deleted') {
        if (ref) {
          if (op.kind === 'delete' || result.outcome === 'deleted') {
            ref.state = 'deleted'; ref.updatedAt = iso(now()); repo.put('messageRefs', ref);
          } else if (ref.state !== 'deleted' && ref.contentRevision <= op.snapshot.contentRevision) {
            const current = service.recordMessageRef({ ...delivery, actionReferenceIds: op.actionReferenceIds }, ref, op.snapshot.contentRevision);
            const applied = current || repo.get('messageRefs', ref.id);
            applied.state = 'active'; applied.lastMessageOperationId=op.id; applied.rosterRevision = op.snapshot.rosterRevision; applied.payloadHash = op.payloadHash;
            if (op.snapshot.signupConfigurationRevision) applied.configurationRevision = op.snapshot.signupConfigurationRevision;
            applied.updatedAt = iso(now()); repo.put('messageRefs', applied);
          }
        }
        op.status = 'succeeded'; op.lastErrorCode = result.errorCode ? safeCode(result.errorCode) : null; release(op);
        touchOperation(op, delivery, 'message_operation.succeeded'); recordAttemptResult(attempt, result.outcome, result.errorCode); return 'updated';
      }
      if (result?.outcome === 'not_updated') {
        const retry = result.retryable === true && op.attemptCount < maxAttempts;
        op.status = retry ? 'queued' : 'failed'; op.nextAttemptAt = retry ? nextRetry(op.attemptCount, result.retryAfterMs) : null;
        op.lastErrorCode = safeCode(result.errorCode); release(op); markRef(op, 'update_failed');
        touchOperation(op, delivery, 'message_operation.failed'); recordAttemptResult(attempt, 'not_updated', result.errorCode); return 'failed';
      }
      unknownOperation(op, delivery, result?.errorCode); recordAttemptResult(attempt, 'unknown', result?.errorCode); return 'unknown';
    });
  }

  function dispatch(claim) {
    let target, delivery, messageRef, attempt;
    try {
      repo.transaction(() => {
        const row = repo.get(claim.kind === 'send' ? 'deliveries' : 'messageOperations', claim.id);
        if (!owns(row, claim)) throw { errorCode: 'WORKER_LEASE_EXPIRED' };
        delivery = claim.kind === 'send' ? row : repo.get('deliveries', row.deliveryId);
        ({ target } = service.executionContext(delivery, { mode: claim.kind === 'send' ? 'send' : claim.kind === 'lookup' ? 'lookup' : 'edit', actorAccountId: claim.actorAccountId }));
        if (claim.kind !== 'send' && claim.kind !== 'lookup') messageRef = service.validateMessageRef(refFor(row), target);
        attempt = attemptFor(row); attempt.status = 'requesting'; attempt.startedAt = iso(now()); repo.put('attempts', attempt);
      });
    } catch (error) {
      if (!error?.errorCode) return Promise.reject(error);
      const code = safeCode(error?.errorCode, 'ACCESS_DENIED');
      return Promise.resolve({ outcome: claim.kind === 'send' ? 'not_sent' : claim.kind === 'lookup' ? 'unknown' : 'not_updated',
        errorCode: code, retryable: false, retryAfterMs: null });
    }
    const controller = new AbortController(); controllers.add(controller);
    const context = { attemptId: claim.currentAttemptId, executionEpoch: claim.executionEpoch, operationKey: attempt.operationKey, signal: controller.signal, timeoutMs };
    const adapter = service.platforms?.[target.platform];
    let settled = false, timer, onAbort;
    const request = new Promise(resolve => {
      const finish = value => { if (settled) return; settled = true; clearTimeout(timer); controller.signal.removeEventListener('abort', onAbort); controllers.delete(controller); resolve(value); };
      onAbort = () => finish({ outcome: 'unknown', errorCode: 'REQUEST_ABORTED' });
      controller.signal.addEventListener('abort', onAbort, { once: true });
      timer = setTimeout(() => { finish({ outcome: 'unknown', errorCode: 'REQUEST_TIMEOUT' }); controller.abort(); }, timeoutMs);
      let external;
      try {
        if (!adapter) throw new Error('Missing injected adapter');
        if (claim.kind === 'send') external = adapter.send({ target, payload: claim.payload, payloadHash: claim.payloadHash, context });
        else if (claim.kind === 'edit') external = adapter.edit({ target, messageRef, payload: claim.payload, payloadHash: claim.payloadHash, context });
        else if (claim.kind === 'delete') external = adapter.remove({ target, messageRef, context });
        else {
          const prior = repo.all('attempts').filter(row => row.kind === 'send' && row.deliveryId === delivery.id).sort((a, b) => b.executionEpoch - a.executionEpoch)[0];
          external = adapter.lookup({ target, attemptId: prior?.id || null, operationKey: `notification:${delivery.id}`,
            messageRefs: repo.all('messageRefs').filter(ref => ref.deliveryId === delivery.id).map(ref => service.validateMessageRef(ref, target)), context });
        }
      } catch { finish({ outcome: 'unknown', errorCode: 'PLATFORM_REQUEST_EXCEPTION' }); return; }
      Promise.resolve(external).then(result => {
        if (settled) { try { lateEvidence(claim, result); } catch { /* Storage may already be closed after bounded shutdown. */ } }
        else finish(result);
      }, () => {
        const result = { outcome: 'unknown', errorCode: 'PLATFORM_REQUEST_EXCEPTION' };
        if (settled) { try { lateEvidence(claim, result); } catch { /* The persisted unknown remains authoritative. */ } }
        else finish(result);
      });
    });
    return request;
  }

  async function runBatch({ workerId, limit = 20 } = {}) {
    assertWorker(workerId); const maximum = bounded(limit, 20, 100);
    const counts = { claimed: 0, sent: 0, failed: 0, unknown: 0, skipped: 0, updated: 0 };
    if (stopped) return counts;
    await recoverExpired({ workerId, limit: maximum });
    if (stopped) return counts;
    consumeOutbox(maximum);
    consumeMemberOutbox(maximum);
    refreshDiscordSignupConfiguration();
    for(const domain of Object.values(service.businessDomains||{}))await domain.refresh?.({limit:maximum});
    await service.refreshCardBrands?.();
    await service.refreshSignupConnectIps?.();
    const operations = repo.all('messageOperations'), blockers = operationBlockers(operations);
    const candidates = [
      ...repo.all('deliveries').filter(row => queueStates.has(row.status) && due(row.dueAt, now()) && due(row.nextAttemptAt, now())).map(row => ({ id: row.id, kind: 'send', at: row.nextAttemptAt || row.dueAt || row.createdAt })),
      // Blocked edits/lookups must not consume all batch slots indefinitely and
      // prevent unrelated deliveries from ever reaching their claim check.
      ...operations.filter(row => row.status === 'queued' && due(row.nextAttemptAt, now()) && !operationBlocked(row, blockers)).map(row => ({ id: row.id, kind: 'operation', at: row.nextAttemptAt || row.createdAt })),
    ].sort((a, b) => String(a.at).localeCompare(String(b.at)) || a.id.localeCompare(b.id)).slice(0, maximum);
    for (const candidate of candidates) {
      if (stopped) break;
      const claim = candidate.kind === 'send' ? claimDelivery(candidate.id, workerId) : claimOperation(candidate.id, workerId);
      if (!claim) continue;
      if (claim.skipped) { counts.skipped++; if (claim.unknown) counts.unknown++; continue; }
      counts.claimed++;
      const result = await dispatch(claim);
      const classification = claim.kind === 'send' ? applySend(claim, result) : applyOperation(claim, result);
      counts[classification]++;
    }
    return counts;
  }
  function runOnce(options) {
    const work = runBatch(options); active.add(work);
    work.then(() => active.delete(work), () => active.delete(work)); return work;
  }
  async function stop() {
    stopped = true;
    for (const controller of controllers) controller.abort();
    await Promise.allSettled([...active]);
  }
  return { runOnce, recoverExpired, stop };
}
