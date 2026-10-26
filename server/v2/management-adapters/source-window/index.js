import { createHash } from 'node:crypto';
import { IdentityError } from '../../identity/errors.js';
import { authorize } from '../../identity/permissions.js';
const need = (value, code, status = 409) => { if (!value) throw new IdentityError(code, status); };
const canonical = value => Array.isArray(value) ? value.map(canonical) : value && typeof value === 'object'
  ? Object.fromEntries(Object.keys(value).sort().map(k => [k, canonical(value[k])])) : value;
const hash = value => createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
const sync = value => { need(!value?.then, 'SOURCE_WINDOW_SYNC_REQUIRED', 503); return value; };
const scopeBase = scope => Object.fromEntries(Object.entries(scope).filter(([key]) => !['sourceContexts','sourceWindowId','sourceWindowIntentId','sourceWindowBinding'].includes(key)));
const stamp = value => typeof value === 'string' && Number.isFinite(Date.parse(value)) ? new Date(value).toISOString() : null;
const jobBinding = job => hash({ actorId: job.actorId, type: job.type, source: job.source, scope: scopeBase(job.scope),
  memberIds: job.items.map(i => i.memberId).sort(), parentJobId: job.parentJobId || null });

/** Explicit boot migration, never invoked by GET, factory construction or job preview. */
export function installSourceWindowSchema(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS v2_source_windows (
    job_id TEXT PRIMARY KEY, intent_id TEXT NOT NULL, parent_job_id TEXT, actor_id TEXT NOT NULL,
    wipe_id TEXT NOT NULL, server_profile_id TEXT NOT NULL, battlemetrics_server_id TEXT NOT NULL,
    from_at TEXT NOT NULL, to_at TEXT NOT NULL, binding TEXT NOT NULL, job_binding TEXT NOT NULL,
    created_at INTEGER NOT NULL, row_hash TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS v2_source_windows_intent ON v2_source_windows(intent_id,job_id);`);
}

/** Metadata adjunct to the existing SyncCenter job, not a scheduler or job store.
 * readSourceConfig is a late-bound host closure; construction does not invoke it. */
export function createSourceWindow({ identity, readSourceConfig, now = Date.now }) {
  const db = identity?.repo?.db;
  need(db && typeof readSourceConfig === 'function', 'SOURCE_WINDOW_HOST_REQUIRED', 503);
  need(db.prepare("SELECT name FROM sqlite_master WHERE name='v2_source_windows'").get(), 'SOURCE_WINDOW_MIGRATION_REQUIRED', 503);
  let capturing = null;
  const loadJob = id => {
    const row = db.prepare("SELECT payload FROM sync_center_records WHERE kind='job' AND id=?").get(id);
    return row && JSON.parse(row.payload);
  };
  function rowFor(id) {
    const row = db.prepare('SELECT * FROM v2_source_windows WHERE job_id=?').get(id);
    need(row, 'SOURCE_WINDOW_REQUIRED', 503);
    const { row_hash, ...data } = row;
    need(row_hash === hash(data), 'SOURCE_WINDOW_TAMPERED');
    return row;
  }
  function bindingCheck(row, job) {
    need(job && job.type === 'battlemetrics_playtime' && job.source === 'battlemetrics' && !job.deleted &&
      job.id === row.job_id && jobBinding(job) === row.job_binding, 'SOURCE_WINDOW_JOB_MISMATCH');
    need(!job.cancelRequested && !['cancelled','expired'].includes(job.status), 'SOURCE_WINDOW_CANCELLED');
    need(job.scope.sourceWindowId === row.job_id || capturing === row.job_id && db.isTransaction, 'SOURCE_WINDOW_JOB_MISMATCH');
  }
  function readWindow({ type, scope = {}, wipe, member, binding } = {}) {
    // No job identity means preview only. Never infer a latest job or manufacture a cutoff.
    if (!scope.sourceWindowId) return null;
    need(type === 'battlemetrics_playtime' && typeof scope.sourceWindowId === 'string', 'SOURCE_WINDOW_JOB_MISMATCH');
    const row = rowFor(scope.sourceWindowId), job = loadJob(row.job_id);
    bindingCheck(row, job);
    need(scope.sourceWindowIntentId === row.intent_id && scope.sourceWindowBinding === row.binding &&
      hash(scopeBase(scope)) === hash(scopeBase(job.scope)), 'SOURCE_WINDOW_JOB_MISMATCH');
    need(wipe?.id === row.wipe_id && wipe.serverProfileId === row.server_profile_id && binding === row.binding, 'SOURCE_WINDOW_CONTEXT_CHANGED');
    if (member) need(job.items.some(i => i.memberId === member.id), 'SOURCE_WINDOW_MEMBER_MISMATCH');
    need(stamp(row.from_at) === row.from_at && stamp(row.to_at) === row.to_at && row.from_at <= row.to_at, 'SOURCE_WINDOW_TAMPERED');
    return { from: row.from_at, to: row.to_at };
  }
  function captureSourceWindow({ actor, job, parent, bind }) {
    need(db.isTransaction && !capturing && typeof bind === 'function', 'SOURCE_WINDOW_TRANSACTION_REQUIRED', 503);
    const current = identity.actorForAccount(actor?.id);
    need(current.permissionVersion === actor.permissionVersion && current.id === job.actorId, 'PERMISSIONS_CHANGED', 401);
    const stored = loadJob(job.id);
    need(stored && job.type === 'battlemetrics_playtime' && job.source === 'battlemetrics' && job.items.length &&
      jobBinding(stored) === jobBinding(job), 'SOURCE_WINDOW_JOB_MISMATCH');
    const clean = scopeBase(job.scope), wipeId = clean.wipeId || (clean.kind === 'current_wipe' ? clean.id : null);
    need(wipeId, 'SOURCE_WINDOW_WIPE_REQUIRED', 422);
    for (const item of job.items) authorize(current, 'sync.run', { kind: 'member', id: item.memberId, wipeId }, identity.relations());
    const config = sync(readSourceConfig({ type: job.type, scope: clean }));
    need(config?.windowBinding && config.serverId && /^\d{1,30}$/.test(config.battlemetricsServerId), 'SOURCE_WINDOW_CONTEXT_REQUIRED', 503);
    need(job.scope.sourceWindowBinding === config.windowBinding, 'SOURCE_WINDOW_CONTEXT_CHANGED');
    let from = stamp(config.from), to = stamp(config.to), intent = job.id;
    need(from, 'SOURCE_WINDOW_START_REQUIRED', 422);
    if (parent) {
      need(job.parentJobId === parent.id && parent.type === job.type && !parent.deleted, 'SOURCE_WINDOW_PARENT_MISMATCH');
      const prior = rowFor(parent.id); bindingCheck(prior, loadJob(parent.id));
      need(prior.binding === config.windowBinding && prior.wipe_id === wipeId && prior.server_profile_id === config.serverId &&
        prior.battlemetrics_server_id === config.battlemetricsServerId && prior.from_at === from, 'SOURCE_WINDOW_CONTEXT_CHANGED');
      need(job.items.every(item => parent.items.some(old => old.memberId === item.memberId)), 'SOURCE_WINDOW_PARENT_MISMATCH');
      from = prior.from_at; to = prior.to_at; intent = prior.intent_id;
    } else {
      const capturedAt = now(); need(Number.isSafeInteger(capturedAt), 'SOURCE_WINDOW_CLOCK_INVALID', 503);
      to = new Date(to ? Math.min(capturedAt, Date.parse(to)) : capturedAt).toISOString();
    }
    need(Date.parse(from) <= Date.parse(to), 'SOURCE_WINDOW_NOT_STARTED', 422);
    const row = { job_id: job.id, intent_id: intent, parent_job_id: parent?.id || null, actor_id: current.id,
      wipe_id: wipeId, server_profile_id: config.serverId, battlemetrics_server_id: config.battlemetricsServerId,
      from_at: from, to_at: to, binding: config.windowBinding, job_binding: jobBinding(job), created_at: job.createdAt };
    // Timestamp is captured once per job, after de-dup, inside the job savepoint.
    db.prepare('INSERT INTO v2_source_windows VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)').run(...Object.values(row), hash(row));
    const scope = { ...clean, sourceWindowId: job.id, sourceWindowIntentId: intent, sourceWindowBinding: row.binding };
    try { capturing = job.id; const bound = sync(bind(scope)); need(bound?.sourceWindowId === job.id, 'SOURCE_WINDOW_JOB_MISMATCH'); return bound; }
    finally { capturing = null; }
  }
  return { readWindow, captureSourceWindow };
}
