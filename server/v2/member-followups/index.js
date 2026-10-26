import { createHash } from 'node:crypto';
import { IdentityError } from '../identity/errors.js';
import { authorize } from '../identity/permissions.js';
import { legacyBlocked } from '../identity/migration.js';
import { statusOf } from '../member-admin/model.js';
import { SyncCenterService } from '../sync-center/service.js';
import { createSyncCenterWorker } from '../sync-center/worker.js';

export const FOLLOWUP_TYPES = Object.freeze(['steam_profile_backfill', 'member_profile', 'battlemetrics_identity', 'battlemetrics_playtime', 'kda']);
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const need = (ok, code, status = 503) => { if (!ok) throw new IdentityError(code, status); };
const synchronous = value => { need(!value?.then, 'FOLLOWUP_SYNCHRONOUS_READER_REQUIRED'); return value; };
const id = value => typeof value === 'string' && value.length > 0 && value.length <= 180 && !/[\x00-\x1f]/.test(value);
const marker = Symbol.for('nb-clan.member-followups.worker');
const operationPrefix = 'member-followups:';

/** Explicit same-DB installer; stores only consumption progress and canonical job bindings. */
export function installMemberFollowupsSchema(db) {
  need(!db.isTransaction, 'FOLLOWUP_INSTALL_OUTSIDE_TRANSACTION_REQUIRED');
  db.exec(`CREATE TABLE IF NOT EXISTS v2_member_followup_events(
    seq INTEGER PRIMARY KEY, event_hash TEXT NOT NULL, plan TEXT NOT NULL, results TEXT NOT NULL, completed INTEGER NOT NULL DEFAULT 0);
    CREATE TABLE IF NOT EXISTS v2_member_followup_jobs(
    job_id TEXT PRIMARY KEY, seq INTEGER NOT NULL, unit_key TEXT NOT NULL, binding TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS v2_member_followup_schema(version INTEGER PRIMARY KEY);
    INSERT OR IGNORE INTO v2_member_followup_schema VALUES(1);`);
}

/** No environment, timer, external I/O, actor synthesis or second task queue. */
export function createMemberFollowups({ identity, syncService: service, readPolicy, readPrincipal, readSourceConfig }) {
  const db = identity?.repo?.db;
  need(service instanceof SyncCenterService && service.identity === identity && service.repo.db === db, 'FOLLOWUP_IDENTITY_MISMATCH');
  need(db.prepare("SELECT 1 FROM sqlite_master WHERE name='v2_member_followup_schema'").get(), 'FOLLOWUP_MIGRATION_REQUIRED');
  need(db.prepare('SELECT 1 FROM v2_member_followup_schema WHERE version=1').get(), 'FOLLOWUP_MIGRATION_REQUIRED');
  need(typeof readPolicy === 'function' && typeof readPrincipal === 'function' && typeof readSourceConfig === 'function', 'FOLLOWUP_READERS_REQUIRED');
  let accepting = true, worker = null, stopPromise;
  const pending = new Map(), providerPending = new Set();
  const record = (collection, key) => {
    const row = db.prepare('SELECT payload_json FROM json_records WHERE collection=? AND id=?').get(collection, key);
    return row ? JSON.parse(row.payload_json) : null;
  };
  const eventRecord = seq => {
    const row = db.prepare('SELECT * FROM v2_member_admin_outbox WHERE seq=?').get(seq);
    need(row, 'FOLLOWUP_EVENT_NOT_FOUND', 404);
    const envelope = JSON.parse(row.payload);
    const stored = db.prepare('SELECT payload FROM v2_member_admin_operations WHERE actor_id=? AND operation_id=?').get(envelope.actorId, row.operation_id);
    need(stored, 'FOLLOWUP_RECEIPT_MISSING');
    const receipt = JSON.parse(stored.payload);
    need(receipt.operationId === row.operation_id && Array.isArray(receipt.events) && Array.isArray(receipt.changes) &&
      hash(receipt.events) === hash(envelope.events), 'FOLLOWUP_RECEIPT_MISMATCH');
    const candidates = new Map();
    for (const event of receipt.events) {
      if (!['member.created', 'member.review', 'review.changed'].includes(event.changeType)) continue;
      need(Array.isArray(event.memberIds) && event.memberIds.length <= 500, 'FOLLOWUP_EVENT_INVALID');
      for (const memberId of event.memberIds) {
        need(id(memberId), 'FOLLOWUP_EVENT_INVALID');
        const snapshot = receipt.changes.find(c => c.collection === 'members' && c.id === memberId && !c.deleted)?.record;
        if (event.changeType === 'member.created') {
          need(snapshot && snapshot.id === memberId, 'FOLLOWUP_RECEIPT_MISMATCH');
          candidates.set(memberId, { memberId, steamHash: hash(snapshot.steamId), reviewId: null });
        } else if (receipt.data?.status === 'approved' && receipt.data.memberId === memberId) {
          const application = receipt.changes.find(c => c.collection === 'joinApplications' && c.id === receipt.data.id && !c.deleted)?.record;
          need(snapshot && application?.status === 'approved' && application.memberId === memberId, 'FOLLOWUP_RECEIPT_MISMATCH');
          candidates.set(memberId, { memberId, steamHash: hash(snapshot.steamId), reviewId: application.id });
        }
      }
    }
    need(candidates.size <= 500, 'FOLLOWUP_EVENT_INVALID');
    return { hash: hash([row.operation_id, row.payload, stored.payload]), candidates: [...candidates.values()] };
  };
  function policy() {
    const value = synchronous(readPolicy());
    need(value && typeof value.enabled === 'boolean' && id(value.revision) && value.tasks && typeof value.tasks === 'object', 'FOLLOWUP_POLICY_INVALID');
    const tasks = {};
    for (const type of FOLLOWUP_TYPES) {
      const task = value.tasks[type];
      if (!task) { tasks[type] = { enabled: false, ready: false, identity: '', wipeId: null }; continue; }
      need(typeof task.enabled === 'boolean' && typeof task.ready === 'boolean' && (!task.ready || id(task.identity)) &&
        (!task.wipeId || id(task.wipeId)), 'FOLLOWUP_POLICY_INVALID');
      tasks[type] = { enabled: task.enabled, ready: task.ready, identity: task.identity || '', wipeId: task.wipeId || null };
    }
    return { enabled: value.enabled, revision: value.revision, tasks };
  }
  function principal() {
    const pin = synchronous(readPrincipal());
    need(pin && id(pin.accountId) && Number.isSafeInteger(pin.permissionVersion) && pin.permissionVersion > 0, 'FOLLOWUP_PRINCIPAL_REQUIRED');
    const actor = identity.actorForAccount(pin.accountId);
    need(actor?.status === 'active' && !actor.restricted && actor.permissionVersion === pin.permissionVersion, 'FOLLOWUP_PRINCIPAL_REVOKED', 403);
    return { actor, pin: { accountId: actor.id, permissionVersion: actor.permissionVersion, scopeDigest: identity.scopeDigest(actor) } };
  }
  function memberContext(unit) {
    const member = record('members', unit.memberId);
    need(member && !member.deletedAt && !member.deleted && !member.blocked && !legacyBlocked(member) && statusOf(member) === 'active', 'FOLLOWUP_MEMBER_INACTIVE', 409);
    need(/^7656119\d{10}$/.test(member.steamId) && hash(member.steamId) === unit.steamHash, 'FOLLOWUP_MEMBER_IDENTITY_CHANGED', 409);
    const duplicate = db.prepare("SELECT id FROM json_records WHERE collection='members' AND json_extract(payload_json,'$.steamId')=? LIMIT 2").all(member.steamId);
    need(duplicate.length === 1 && duplicate[0].id === member.id, 'FOLLOWUP_MEMBER_IDENTITY_CHANGED', 409);
    if (unit.reviewId) {
      const application = record('joinApplications', unit.reviewId);
      need(application?.status === 'approved' && application.memberId === member.id && application.steamId === member.steamId, 'FOLLOWUP_REVIEW_CHANGED', 409);
    }
    if (unit.scope.wipeId) {
      const wipe = record('v2Wipes', unit.scope.wipeId);
      need(wipe && ['active', 'ended', 'archived'].includes(wipe.lifecycle) &&
        (['ended', 'archived'].includes(wipe.lifecycle) || wipe.serverActualWipeAt || wipe.actualStartedAt), 'FOLLOWUP_WIPE_NOT_STARTED', 409);
      if (unit.type === 'kda') {
        const signup = db.prepare("SELECT 1 FROM json_records WHERE collection='v2Signups' AND json_extract(payload_json,'$.memberId')=? AND json_extract(payload_json,'$.wipeId')=? AND json_extract(payload_json,'$.response') IN ('attending_on_time','attending_later') LIMIT 1").get(member.id, wipe.id);
        need(signup || record('wipes', wipe.id)?.kdaMemberScope === 'all_members', 'FOLLOWUP_NOT_KDA_PARTICIPANT', 409);
      }
    }
    return member;
  }
  function authorizeUnit(actor, unit, executionScope) {
    const resource = { kind: 'member', id: unit.memberId, ...(unit.scope.wipeId ? { wipeId: unit.scope.wipeId } : {}) };
    for (const capability of ['members.read', 'sync.read', 'sync.run', unit.type === 'member_profile' ? 'risks.manage' : 'members.basic_edit'])
      authorize(actor, capability, resource, identity.relations());
    // Same request admission: canonical type/scope validation, target resolution,
    // target limit, wipe audience and sync.run checks. insert also applies its
    // active scope dedupe, queue limit, deadline and captureScope admission.
    const resolved = executionScope
      ? synchronous(service.authority.resolveScope({ actor, type: unit.type, scope: executionScope, limit: 2 }))
      : service.resolve(actor, unit.type, unit.scope);
    need(resolved.targets.length === 1 && resolved.targets[0].memberId === unit.memberId, 'FOLLOWUP_SCOPE_MISMATCH', 403);
  }
  function assertBinding(binding, executionScope) {
    const current = principal(), p = policy();
    need(hash(current.pin) === hash(binding.principal), 'FOLLOWUP_PRINCIPAL_CHANGED', 403);
    need(p.enabled && hash([p.revision, p.tasks[binding.unit.type]]) === binding.unit.policyHash, 'FOLLOWUP_CONFIGURATION_CHANGED', 409);
    const member = memberContext(binding.unit);
    if (executionScope) need(hash(executionScope) === binding.scopeHash, 'FOLLOWUP_JOB_BINDING_REQUIRED');
    const config = synchronous(readSourceConfig({ type: binding.unit.type, scope: executionScope || binding.unit.scope, member }));
    const source = binding.unit.type === 'kda' ? 'vital' : binding.unit.type.startsWith('battlemetrics_') ? 'battlemetrics' : 'steam';
    need(config?.enabled === true && config.sourceId === source, 'FOLLOWUP_SOURCE_NOT_CONFIGURED', 409);
    authorizeUnit(current.actor, binding.unit, executionScope);
    return current.actor;
  }
  const progress = seq => {
    const row = db.prepare('SELECT * FROM v2_member_followup_events WHERE seq=?').get(seq);
    return row ? { ...row, plan: JSON.parse(row.plan), results: JSON.parse(row.results) } : null;
  };
  const output = row => ({ seq: row.seq, completed: Boolean(row.completed), results: row.results });
  function prepare(seq) {
    const event = eventRecord(seq), old = progress(seq);
    if (old) { need(old.event_hash === event.hash, 'FOLLOWUP_EVENT_CHANGED', 409); return old; }
    const p = policy();
    // No authority is needed to record an explicit disabled/no-relevant-event skip.
    const pin = p.enabled && event.candidates.length ? principal().pin : null;
    const units = event.candidates.flatMap(candidate => FOLLOWUP_TYPES.map(type => {
      const config = p.tasks[type], scope = { kind: 'members', memberIds: [candidate.memberId],
        ...(['battlemetrics_playtime', 'kda'].includes(type) && config.wipeId ? { wipeId: config.wipeId } : {}) };
      return { ...candidate, type, scope, key: hash([candidate.memberId, type]), policyHash: hash([p.revision, config]),
        skipReason: !p.enabled ? 'BACKGROUND_DISABLED' : !config.enabled ? 'SOURCE_DISABLED' : !config.ready ? 'SOURCE_NOT_CONFIGURED' :
          ['battlemetrics_playtime', 'kda'].includes(type) && !config.wipeId ? 'WIPE_NOT_CONFIGURED' : null };
    }));
    const plan = { principal: pin, units };
    db.prepare('INSERT INTO v2_member_followup_events VALUES(?,?,?,?,?)').run(seq, event.hash, JSON.stringify(plan), '[]', units.length ? 0 : 1);
    return progress(seq);
  }
  function submitUnit(seq, key) {
    const row = progress(seq); need(row && eventRecord(seq).hash === row.event_hash, 'FOLLOWUP_EVENT_CHANGED', 409);
    if (row.results.some(r => r.key === key)) return;
    const unit = row.plan.units.find(u => u.key === key); need(unit, 'FOLLOWUP_EVENT_INVALID');
    let actor, result = { key, memberId: unit.memberId, type: unit.type };
    if (unit.skipReason) result = { ...result, outcome: 'skipped', reason: unit.skipReason };
    else {
      try { actor = assertBinding({ principal: row.plan.principal, unit }); }
      catch (error) {
        if (![403, 404, 409].includes(error.status)) throw error;
        result = { ...result, outcome: 'skipped', reason: error.errorCode || 'ACCESS_DENIED' };
      }
      if (actor) {
        const operationId = operationPrefix + hash([seq, key]);
        const accepted = service.insert(actor, { type: unit.type, scope: unit.scope }, { trigger: 'auto', operationId });
        const job = service.job(accepted.job.id);
        if (!accepted.deduplicated) db.prepare('INSERT INTO v2_member_followup_jobs VALUES(?,?,?,?)').run(job.id, seq, key,
          JSON.stringify({ principal: row.plan.principal, unit, scopeHash: hash(job.scope), operationId }));
        result = { ...result, outcome: accepted.deduplicated ? 'covered_by_existing_job' : 'submitted', jobId: job.id };
      }
    }
    row.results.push(result);
    db.prepare('UPDATE v2_member_followup_events SET results=?,completed=? WHERE seq=?').run(JSON.stringify(row.results),
      row.results.length === row.plan.units.length ? 1 : 0, seq);
  }
  function consume(seq) {
    need(accepting, 'FOLLOWUP_STOPPED'); need(worker, 'FOLLOWUP_GUARDS_REQUIRED');
    need(Number.isSafeInteger(seq) && seq > 0, 'FOLLOWUP_EVENT_INVALID', 422);
    if (pending.has(seq)) return pending.get(seq);
    const task = (async () => {
      need(!db.isTransaction, 'FOLLOWUP_OUTSIDE_MEMBER_TRANSACTION_REQUIRED');
      const row = await service.atomic(() => prepare(seq));
      for (const unit of row.plan.units) await service.atomic(() => submitUnit(seq, unit.key));
      return output(progress(seq));
    })().finally(() => pending.delete(seq));
    pending.set(seq, task); return task;
  }
  function jobBinding(request) {
    const match = /^sync-item:([^:]+):(.+)$/.exec(request.operationId || '');
    if (!match) return null;
    const job = service.repo.get('job', match[1]);
    if (!job) return null;
    const stored = db.prepare('SELECT binding FROM v2_member_followup_jobs WHERE job_id=?').get(job.id);
    if (!stored && !(job.trigger === 'auto' && job.operationId?.startsWith(operationPrefix))) return null;
    need(stored && job.trigger === 'auto' && job.type === request.type && match[2] === request.memberId, 'FOLLOWUP_JOB_BINDING_REQUIRED');
    const binding = JSON.parse(stored.binding);
    need(binding.unit.memberId === request.memberId && binding.unit.type === request.type &&
      binding.operationId === job.operationId && binding.scopeHash === hash(job.scope) && binding.scopeHash === hash(request.scope) &&
      job.actorId === binding.principal.accountId && job.items.length === 1 && job.items[0].memberId === request.memberId,
    'FOLLOWUP_JOB_BINDING_REQUIRED');
    return binding;
  }
  function startWorker({ providers = {}, ...options } = {}) {
    need(accepting && !worker && !service[marker] && typeof service.authority.applyResult === 'function', 'FOLLOWUP_WORKER_INSTALL_REQUIRED');
    const original = service.authority.applyResult;
    const wrapped = Object.fromEntries(Object.entries(providers).map(([type, provider]) => [type, async request => {
      const binding = jobBinding({ ...request, type });
      if (!binding) return provider(request); // No change to manual/other-owner tasks.
      try { assertBinding(binding, request.scope); }
      catch { return { outcome: 'skipped', reason: 'NO_APPLICABLE_DATA' }; }
      const task = Promise.resolve().then(() => provider(request)); providerPending.add(task);
      try {
        const result = await task;
        try { assertBinding(binding, request.scope); } catch { return { outcome: 'skipped', reason: 'NO_APPLICABLE_DATA' }; }
        return result;
      }
      finally { providerPending.delete(task); }
    }]));
    service.authority.applyResult = request => {
      const binding = jobBinding(request); if (binding) assertBinding(binding, request.scope);
      return original.call(service.authority, request);
    };
    try { worker = createSyncCenterWorker(service, { ...options, providers: wrapped }); service[marker] = true; }
    catch (error) { service.authority.applyResult = original; throw error; }
    return worker;
  }
  function stop() {
    if (stopPromise) return stopPromise;
    accepting = false;
    stopPromise = (async () => {
      await Promise.allSettled([...pending.values()]);
      await worker?.stop(); await Promise.allSettled([...providerPending]);
    })();
    return stopPromise;
  }
  return { consume, startWorker, stop, progress: seq => { const row = progress(seq); return row ? output(row) : null; } };
}
