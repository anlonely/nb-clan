import { IdentityError } from '../identity/errors.js';
import { need, hash, identifier, page } from '../notifications/shared.js';
import { SyncCenterService } from '../sync-center/service.js';
import { sourceDefaults } from '../sync-center/model.js';
import { HexQueryRepository } from './repository.js';
import { configuration, commandPayload, snowflake, sync, parseFreshCard, collectorProjection } from './model.js';
export { installHexQuerySchema } from './repository.js';

/** Optional command consumer. The host drives the ONE original notification worker.
 * This module performs only bounded GET polling and never creates its own sender. */
export function createHexQuery({ identity, notifications, getSyncService, runStoreWriteTask, readConfig,
  readPrincipal, readChannelProof, readMessages, now = identity?.now || Date.now }) {
  const service = notifications?.service;
  need(service?.identity === identity && service.repo.db === identity?.repo?.db && notifications.worker &&
    [getSyncService, runStoreWriteTask, readConfig, readPrincipal, readChannelProof, readMessages, now].every(f => typeof f === 'function'), 'HEX_QUERY_HOST_REQUIRED', 503);
  const core = service.repo, repo = new HexQueryRepository(core), db = core.db;
  let accepting = true, stopping; const live = new Map(), pending = new Set();
  const syncService = () => { const s = sync(getSyncService()); need(s instanceof SyncCenterService && s.identity === identity && s.repo.db === db, 'HEX_SYNC_SERVICE_REQUIRED', 503); return s; };
  const clock = () => { const n = now(); need(Number.isSafeInteger(n) && Number.isFinite(new Date(n).getTime()), 'HEX_CLOCK_INVALID', 503); return n; };
  const config = () => { const c = configuration(sync(readConfig())); need(c.enabled, 'SOURCE_NOT_CONFIGURED', 503); return c; };
  const atomic = fn => runStoreWriteTask(() => core.transaction(fn));
  function principal(job) {
    const p = sync(readPrincipal({ jobId: job.id, memberId: null }));
    need(identifier(p?.accountId) && p.accountId === job.actorId && Number.isSafeInteger(p.permissionVersion) && p.permissionVersion > 0, 'SOURCE_NOT_CONFIGURED', 503);
    const actor = identity.actorForAccount(p.accountId);
    need(actor.status === 'active' && !actor.restricted && actor.permissionVersion === p.permissionVersion, 'HEX_PRINCIPAL_CHANGED', 403);
    return { actor, pin: { accountId: actor.id, permissionVersion: actor.permissionVersion, scopeDigest: identity.scopeDigest(actor) } };
  }
  function subject(memberId) {
    const member = repo.get('members', memberId);
    need(member && !member.deletedAt && !member.deleted && /^7656119\d{10}$/.test(member.steamId || ''), 'HEX_MEMBER_UNAVAILABLE', 409);
    const same = identity.repo.all('members').filter(m => m.steamId === member.steamId);
    need(same.length === 1 && same[0].id === member.id, 'IDENTITY_CONFLICT', 409);
    const accounts = identity.repo.all('accounts').filter(a => a.memberId === member.id);
    const ids = new Set(accounts.map(a => a.id));
    const bindings = identity.repo.all('bindings').filter(b => b.memberId === member.id || ids.has(b.accountId));
    const identities = identity.repo.all('identities').filter(i => ids.has(i.accountId));
    const memberIdentity = Object.fromEntries(['id', 'steamId', 'discordId', 'wechatId', 'wechatUserId', 'memberStatus', 'membershipStatus', 'deletedAt', 'deleted'].map(k => [k, member[k] ?? null]));
    return { member, hash: hash({ member, accounts, bindings, identities }), identityHash: hash({ member: memberIdentity, accounts, bindings, identities }) };
  }
  function target(c, at) {
    const t = sync(service.catalog.getTarget(c.targetId));
    need(t?.enabled === true && t.runtimeMode === 'isolated' && t.platform === 'discord' && t.kind !== 'directMessage' &&
      t.guildId === c.guildId && t.channelId === c.channelId && t.transportKey === c.transportKey &&
      Number.isSafeInteger(t.configurationRevision) && t.configurationRevision > 0 && t.languages?.includes('en'), 'SOURCE_NOT_CONFIGURED', 503);
    const p = sync(readChannelProof({ targetId: t.id, guildId: c.guildId, channelId: c.channelId }));
    const checkedAt = Date.parse(p?.verifiedAt), expiresAt = Date.parse(p?.expiresAt);
    need(p?.verified === true && p.guildId === c.guildId && p.channelId === c.channelId && p.channelType === 0 &&
      p.senderBotId === c.senderBotId && p.transportKey === c.transportKey && p.canSend === true && p.canReadHistory === true &&
      identifier(p.revision) && Number.isFinite(checkedAt) && checkedAt <= at && at - checkedAt <= 300000 &&
      Number.isFinite(expiresAt) && expiresAt > at && expiresAt <= checkedAt + 300000, 'HEX_CHANNEL_UNVERIFIED', 409);
    return { target: structuredClone(t), proofHash: hash({ revision: p.revision, guildId: p.guildId, channelId: p.channelId,
      channelType: p.channelType, senderBotId: p.senderBotId, transportKey: p.transportKey, canSend: p.canSend, canReadHistory: p.canReadHistory }) };
  }
  function sourcePin(s) {
    const source = s.repo.get('source', 'hexaytron') || sourceDefaults('hexaytron');
    need(!source.paused, 'HEX_SOURCE_PAUSED', 409);
    return hash({ revision: source.revision, timeoutMs: source.timeoutMs, maxAttempts: source.maxAttempts, concurrency: source.concurrency,
      minIntervalMs: source.minIntervalMs, reservedManual: source.reservedManual, priority: source.priority });
  }
  function jobCurrent(jobId, memberId) {
    const s = syncService(), job = s.job(jobId), at = clock(), item = job.items?.find(i => i.memberId === memberId);
    need(job.type === 'hexaytron_profile' && job.source === 'hexaytron' && !job.legacy && !job.recoveryRequired &&
      job.status === 'running' && !job.cancelRequested && job.deadlineAt > at && identifier(job.owner) && job.leaseUntil > at &&
      Number.isSafeInteger(job.generation) && job.generation > 0 && item?.status === 'running', 'HEX_SYNC_CLAIM_LOST', 409);
    return { s, job, item, at };
  }
  function rootJob(s, job, memberId) {
    const seen = new Set(); let current = job;
    for (let n = 0; n < 32; n++) {
      need(!seen.has(current.id) && current.type === 'hexaytron_profile' && !current.legacy && current.items.some(i => i.memberId === memberId), 'HEX_JOB_LINEAGE_INVALID', 409);
      seen.add(current.id); if (!current.parentJobId) return current.id;
      current = s.job(current.parentJobId);
    }
    throw new IdentityError('HEX_JOB_LINEAGE_INVALID', 409);
  }
  function capture(input) {
    need(input?.type === 'hexaytron_profile' && identifier(input.memberId) && typeof input.operationId === 'string' && typeof input.heartbeat === 'function', 'HEX_SYNC_REQUEST_REQUIRED', 409);
    const match = input.operationId.match(/^sync-item:([^:]+):(.+)$/);
    need(match && match[2] === input.memberId, 'HEX_SYNC_REQUEST_REQUIRED', 409);
    const current = jobCurrent(match[1], input.memberId), { s, job, at } = current;
    const c = config(), p = principal(job), m = subject(input.memberId), receiver = target(c, at);
    need(hash(input.scope) === hash(job.scope) && hash(input.member) === hash(m.member) && input.steamId === m.member.steamId, 'HEX_SYNC_CONTEXT_CHANGED', 409);
    s.require(p.actor, 'read', job); s.require(p.actor, 'run', job); service.requireTarget(p.actor, 'send', receiver.target.id);
    const sourceHash = sourcePin(s), lineage = rootJob(s, job, input.memberId);
    return { ...current, c, p, m, receiver, sourceHash, rootJobId: lineage, id: hash(['hexQuery', lineage, input.memberId]) };
  }
  function checked(event, { activeRequest = false, actorAccountId = event.principal.accountId, lookup = false } = {}) {
    need(accepting, 'HEX_QUERY_STOPPED', 503);
    const current = jobCurrent(event.jobId, event.memberId), { s, job, at } = current;
    need(job.generation === event.generation && job.owner === event.owner && hash(job.scope) === event.scopeHash &&
      at >= event.createdAt && at < event.deadlineAt, 'HEX_QUERY_CLAIM_CHANGED', 409);
    if (activeRequest) { const request = live.get(event.id); need(request && !request.controller.signal.aborted, 'HEX_QUERY_REQUEST_ENDED', 409); }
    const c = config(), p = principal(job), m = subject(event.memberId), receiver = target(c, at);
    need(hash(c) === event.configHash && sourcePin(s) === event.sourceHash && hash(p.pin) === hash(event.principal) &&
      m.hash === event.subjectHash && hash(receiver.target) === event.targetHash && receiver.proofHash === event.proofHash, 'HEX_QUERY_CONTEXT_CHANGED', 409);
    s.require(p.actor, 'read', job); s.require(p.actor, 'run', job); service.requireTarget(p.actor, 'send', receiver.target.id);
    const actor = identity.actorForAccount(actorAccountId);
    s.require(actor, 'read', job); s.require(actor, 'run', job); service.requireTarget(actor, lookup ? 'reconcile' : 'send', receiver.target.id);
    return { ...current, c, actor, member: m.member, target: receiver.target };
  }
  function eventFor(row) {
    const e = repo.event(row.event?.id);
    need(e && row.resource?.kind === 'hexQuery' && row.resource.id === e.id && row.event.hash === e.hash &&
      row.binding?.eventId === e.id && row.binding?.eventHash === e.hash && row.purpose === 'hex.query' &&
      row.createdByAccountId === e.principal.accountId && row.language === 'en' && hash(row.target) === e.targetHash &&
      row.payloadHash === e.payloadHash && hash(row.payload) === e.payloadHash, 'HEX_QUERY_EVENT_MISMATCH', 503);
    return e;
  }
  service.registerBusinessDomain('hexQuery', {
    executionContext(row, { mode = 'send', actorAccountId = row.createdByAccountId } = {}) {
      need(!['edit', 'delete'].includes(mode), 'HEX_COMMAND_IMMUTABLE', 409);
      const event = eventFor(row);
      return checked(event, { actorAccountId, activeRequest: ['send', 'completion'].includes(mode), lookup: ['lookup', 'lookup_completion'].includes(mode) });
    },
    visible(actor, row) {
      const e = eventFor(row), s = syncService(), job = s.job(e.jobId);
      s.require(actor, 'read', job);
      // The original successful collector increments the member revision. That
      // must not hide history; identity and authorization still remain current.
      need(subject(e.memberId).identityHash === e.subjectIdentityHash, 'RESOURCE_NOT_FOUND', 404);
      return ['preview', 'send', 'reconcile'].some(cap => service.permitted(actor, cap, row.targetId));
    },
    renderEdit() { throw new IdentityError('HEX_COMMAND_IMMUTABLE', 409); },
    validateInboxReference() { throw new IdentityError('HEX_INBOX_UNSUPPORTED', 422); }
  });
  function admit(input, request) {
    const x = capture(input), existing = repo.event(x.id);
    need(!live.has(x.id), 'HEX_QUERY_ALREADY_ACTIVE', 409);
    request.id = x.id; live.set(x.id, request);
    if (existing) {
      checked(existing, { activeRequest: true });
      const state = repo.state(x.id);
      need(state && ['waiting', 'polling'].includes(state.status), 'HEX_QUERY_REPLAY_FENCED', 409);
      return existing;
    }
    need(!repo.hasUnresolved(x.m.member.steamId, x.id), 'HEX_PRIOR_QUERY_UNRESOLVED', 409);
    const rendered = commandPayload(x.m.member.steamId);
    const e = repo.addEvent({ id: x.id, jobId: x.job.id, memberId: input.memberId, rootJobId: x.rootJobId,
      operationId: input.operationId, generation: x.job.generation, owner: x.job.owner, scopeHash: hash(x.job.scope),
      principal: x.p.pin, subjectHash: x.m.hash, subjectIdentityHash: x.m.identityHash, steamId: x.m.member.steamId, configHash: hash(x.c), sourceHash: x.sourceHash,
      guildId: x.c.guildId, channelId: x.c.channelId,
      targetHash: hash(x.receiver.target), proofHash: x.receiver.proofHash, payloadHash: rendered.payloadHash,
      createdAt: x.at, deadlineAt: Math.min(x.job.deadlineAt, x.at + x.c.timeoutMs) });
    const resource = { kind: 'hexQuery', id: e.id };
    const result = service.createBusinessIntent({ resource, unitKey: e.id, purpose: 'hex.query', language: 'en',
      createdByAccountId: e.principal.accountId, target: x.receiver.target, ...rendered,
      snapshot: { contentRevision: 1, rosterRevision: null, jobId: e.jobId, memberId: e.memberId, generation: e.generation },
      event: { id: e.id, hash: e.hash }, binding: { eventId: e.id, eventHash: e.hash } });
    repo.save({ id: e.id, status: 'waiting', intentId: result.intentId, deliveryId: result.deliveryId, polls: 0,
      requestMessageId: null, observedAt: null, message: null, parsed: null, resultHash: null, reason: null });
    core.put('consumedEvents', { id: `hex-query:${e.id}`, resource, wipeId: null, eventHash: e.hash, intentId: result.intentId, consumedAt: new Date(x.at).toISOString() });
    return e;
  }
  function wait(ms, signal) {
    need(!signal.aborted, 'SOURCE_TIMEOUT', 503);
    return new Promise((resolve, reject) => {
      const onAbort = () => { clearTimeout(timer); signal.removeEventListener('abort', onAbort); reject(new IdentityError('SOURCE_TIMEOUT', 503)); };
      const timer = setTimeout(() => { signal.removeEventListener('abort', onAbort); resolve(); }, ms);
      signal.addEventListener('abort', onAbort, { once: true });
    });
  }
  async function poll(event, input, controller) {
    for (;;) {
      need(!controller.signal.aborted, 'SOURCE_TIMEOUT', 503);
      await input.heartbeat();
      const step = await atomic(() => {
        const x = checked(event, { activeRequest: true }), state = repo.state(event.id), d = core.get('deliveries', state.deliveryId);
        need(['waiting', 'polling'].includes(state.status), 'HEX_QUERY_REPLAY_FENCED', 409);
        if (d.status === 'delivery_unknown') throw new IdentityError('HEX_COMMAND_DELIVERY_UNKNOWN', 409);
        need(!['failed', 'cancelled'].includes(d.status), 'HEX_COMMAND_NOT_AVAILABLE', 409);
        if (d.status !== 'sent') return { waitMs: x.c.intervalMs };
        const refs = core.all('messageRefs').filter(r => r.deliveryId === d.id && r.state !== 'deleted');
        need(refs.length === 1 && snowflake(refs[0].messageId) && refs[0].platform === 'discord' &&
          refs[0].guildId === x.c.guildId && refs[0].channelId === x.c.channelId, 'HEX_COMMAND_REFERENCE_REQUIRED', 409);
        need(!state.requestMessageId || state.requestMessageId === refs[0].messageId, 'HEX_COMMAND_REFERENCE_CHANGED', 409);
        state.requestMessageId = refs[0].messageId; state.status = 'polling';
        need(state.polls < Math.ceil(x.c.timeoutMs / x.c.intervalMs), 'SOURCE_TIMEOUT', 503);
        state.polls++; repo.save(state);
        const attempt = core.get('attempts', d.currentAttemptId);
        need(attempt?.kind === 'send' && attempt.resultKind === 'sent' && Number.isFinite(Date.parse(attempt.startedAt)), 'HEX_COMMAND_REFERENCE_REQUIRED', 409);
        return { ...x, state, sentAt: Date.parse(attempt.startedAt), ref: refs[0] };
      });
      if (step.waitMs) { await wait(step.waitMs, controller.signal); continue; }
      const path = `/api/v10/channels/${step.c.channelId}/messages?after=${step.ref.messageId}&limit=${step.c.messageLimit}`;
      const response = await readMessages({ method: 'GET', path, transportKey: step.c.transportKey, signal: controller.signal,
        target: step.target, afterMessageId: step.ref.messageId, limit: step.c.messageLimit });
      need(!controller.signal.aborted, 'SOURCE_TIMEOUT', 503);
      need(response?.status === 200 && Array.isArray(response.body) && response.body.length <= step.c.messageLimit &&
        JSON.stringify(response.body).length <= 100000, 'INVALID_DATA', 409);
      await input.heartbeat();
      const card = await atomic(() => {
        const x = checked(event, { activeRequest: true }), state = repo.state(event.id);
        for (const message of [...response.body].sort((a, b) => String(a.id).localeCompare(String(b.id)))) {
          const parsed = parseFreshCard(message, { config: x.c, steamId: event.steamId, requestMessageId: state.requestMessageId,
            notBefore: step.sentAt, now: x.at });
          if (!parsed) continue;
          state.status = 'observed'; state.observedAt = new Date(x.at).toISOString(); state.message = structuredClone(message);
          state.parsed = parsed; state.resultHash = hash(collectorProjection(parsed, state.observedAt)); repo.save(state);
          return { steamId: event.steamId, message: state.message, observedAt: state.observedAt, query: proof(event, state) };
        }
        return null;
      });
      if (card) return card;
      await wait(step.c.intervalMs, controller.signal);
    }
  }
  function proof(event, state) {
    return { mode: 'active', queryId: event.id, jobId: event.jobId, operationId: event.operationId, generation: event.generation,
      requestMessageId: state.requestMessageId, sourceMessageId: state.message.id, observedAt: state.observedAt,
      configHash: event.configHash, messageHash: hash(state.message), parser: 'original-hexaytron', completeness: 'six_servers_rust_first_seen' };
  }
  async function closeRequest(request, error) {
    if (!request.id) return;
    await atomic(() => {
      const state = repo.state(request.id); if (!state || ['observed', 'unknown', 'timeout', 'closed'].includes(state.status)) return;
      state.status = error?.errorCode === 'HEX_COMMAND_DELIVERY_UNKNOWN' ? 'unknown' : error?.errorCode === 'SOURCE_TIMEOUT' ? 'timeout' : 'closed';
      state.reason = error?.errorCode || 'HEX_QUERY_REQUEST_ENDED'; repo.save(state);
      const d = core.get('deliveries', state.deliveryId);
      if (['queued', 'retry_wait'].includes(d.status) && d.knownNotSent) {
        d.status = 'cancelled'; d.cancelRequested = true; d.nextAttemptAt = null; d.lastErrorCode = 'HEX_QUERY_REQUEST_ENDED'; service.changed(d, 'delivery.hex_cancelled');
      } else if (d.status === 'sending' && !d.cancelRequested) { d.cancelRequested = true; service.changed(d, 'delivery.hex_cancel_requested'); }
    });
  }
  function readHexCard(input, { signal = input?.signal } = {}) {
    need(accepting && signal && typeof signal.addEventListener === 'function' && !signal.aborted, 'SOURCE_NOT_CONFIGURED', 503);
    const request = { controller: new AbortController(), id: null }, abort = () => request.controller.abort();
    signal.addEventListener('abort', abort, { once: true });
    const work = (async () => {
      let error, deadlineTimer;
      try {
        need(typeof input.heartbeat === 'function', 'HEX_SYNC_REQUEST_REQUIRED', 409);
        await input.heartbeat(); // Original worker closure proves its actual lease/generation.
        need(!request.controller.signal.aborted, 'SOURCE_TIMEOUT', 503);
        const event = await atomic(() => admit(input, request));
        deadlineTimer = setTimeout(() => request.controller.abort(), Math.max(1, event.deadlineAt - clock()));
        return await poll(event, input, request.controller);
      } catch (e) { error = e; throw e; }
      finally { clearTimeout(deadlineTimer); request.controller.abort(); signal.removeEventListener('abort', abort);
        try { await closeRequest(request, error); } finally { if (live.get(request.id) === request) live.delete(request.id); } }
    })();
    pending.add(work); work.finally(() => pending.delete(work)).catch(() => {}); return work;
  }
  function wrapAuthority(original) {
    need(original && typeof original.applyResult === 'function' && typeof original.serializeWrite === 'function', 'HEX_AUTHORITY_REQUIRED', 503);
    const bound = new Map();
    return new Proxy(original, { get(target, property) {
      if (property === 'applyResult') return args => {
        if (args.type !== 'hexaytron_profile') return original.applyResult.call(original, args);
        need(db.isTransaction && typeof args.assertCurrent === 'function', 'HEX_QUERY_TRANSACTION_REQUIRED', 503);
        args.assertCurrent();
        const current = jobCurrent(args.operationId?.match(/^sync-item:([^:]+):/)?.[1], args.memberId);
        const id = hash(['hexQuery', rootJob(current.s, current.job, args.memberId), args.memberId]);
        const event = repo.event(id), state = repo.state(id);
        need(event && state?.status === 'observed' && args.operationId === event.operationId && args.generation === event.generation &&
          args.actor?.id === event.principal.accountId && args.actor.permissionVersion === event.principal.permissionVersion &&
          hash(args.scope) === event.scopeHash, 'HEX_OBSERVATION_REQUIRED', 409);
        const x = checked(event);
        const d = core.get('deliveries', state.deliveryId), attempt = core.get('attempts', d.currentAttemptId);
        need(d.status === 'sent' && attempt?.kind === 'send' && attempt.resultKind === 'sent' && Number.isFinite(Date.parse(attempt.startedAt)), 'HEX_COMMAND_REFERENCE_REQUIRED', 409);
        const parsed = parseFreshCard(state.message, { config: x.c, steamId: event.steamId, requestMessageId: state.requestMessageId,
          notBefore: Date.parse(attempt.startedAt), now: x.at });
        need(parsed && hash(collectorProjection(parsed, state.observedAt)) === state.resultHash &&
          hash(args.result?.hexaytron) === state.resultHash && args.result.observedAt === state.observedAt && args.result.steamId === event.steamId,
        'HEX_OBSERVATION_MISMATCH', 409);
        args.assertCurrent();
        // The ORIGINAL writer still owns member/profile persistence, receipt and cache.
        return original.applyResult.call(original, { ...args, result: { ...args.result,
          hexaytron: { ...args.result.hexaytron, query: proof(event, state) } } });
      };
      const value = Reflect.get(target, property, target);
      if (typeof value !== 'function') return value;
      if (!bound.has(property) || bound.get(property).original !== value) bound.set(property, { original: value, fn: value.bind(target) });
      return bound.get(property).fn;
    } });
  }
  function listIntents(actor, jobId, query = {}) {
    actor = service.actor(actor); const s = syncService(), job = s.job(jobId); s.require(actor, 'read', job);
    const allowed = core.all('deliveries').filter(d => d.resource?.kind === 'hexQuery' && repo.event(d.event?.id)?.jobId === jobId && service.isVisibleDelivery(actor, d));
    const result = page(core.all('intents').filter(i => allowed.some(d => d.intentId === i.id)), query);
    return { ...result, items: result.items.map(i => service.intentDTO(actor, i)) };
  }
  function readiness({ actorId, memberIds = [], scope = {} } = {}) {
    // Optional root capability projection; authoritative admission still re-reads
    // the real running job. No client-supplied ready value is ever consumed.
    try {
      need(accepting && identifier(actorId) && Array.isArray(memberIds) && memberIds.length > 0 && memberIds.length <= 500, 'SOURCE_NOT_CONFIGURED', 503);
      const c = config(), p = principal({ id: null, actorId }), receiver = target(c, clock()), s = syncService();
      for (const id of memberIds) subject(id);
      const job = { scope, items: memberIds.map(memberId => ({ memberId })) };
      s.require(p.actor, 'read', job); s.require(p.actor, 'run', job); service.requireTarget(p.actor, 'send', receiver.target.id);
      return { enabled: true, mode: 'active', reason: null };
    } catch (error) {
      if (!(error instanceof IdentityError)) throw error;
      return { enabled: false, mode: 'active', reason: error.errorCode };
    }
  }
  function stop() {
    if (stopping) return stopping; accepting = false;
    for (const request of live.values()) request.controller.abort();
    stopping = (async () => { await Promise.allSettled([...pending]); await notifications.worker.stop(); await atomic(() => {}); })();
    return stopping;
  }
  return { readHexCard, wrapAuthority, readiness, listIntents, stop, get active() { return pending.size; } };
}
