import { createHash } from 'node:crypto';
import { normalizeTime, validateTimeZone } from './time.js';

const hash = value => createHash('sha256').update(typeof value === 'string' ? value : canonical(value)).digest('hex');
function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(item => canonical(item)).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort()
    .map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
  return JSON.stringify(value);
}
function fail(errorCode, extra = {}) {
  throw Object.assign(new Error(errorCode), { errorCode, status: 409, retryable: false, ...extra });
}
const copy = value => structuredClone(value);
const idValid = value => typeof value === 'string' && value.length > 0 && value.length <= 200;
const safeTime = value => { try { return normalizeTime(value, 'UTC'); } catch { return null; } };
const safeZone = value => { try { return validateTimeZone(value); } catch { return null; } };
const list = (store, key) => {
  const value = store[key] ?? [];
  if (!Array.isArray(value)) fail('MIGRATION_SOURCE_INVALID', { fieldErrors: { [key]: 'Expected an array' } });
  return value;
};
const groupBy = (rows, key) => {
  const groups = new Map();
  for (const row of rows) { const id = key(row); groups.set(id, [...(groups.get(id) || []), row]); }
  return groups;
};

// These two channel meanings are evidenced by the existing source. No generic
// skip/unsure/left/bench mapping is inherited from the old broad normalizer.
export const LEGACY_SKIP_SEMANTICS = Object.freeze({
  discord: 'server/api.js:DISCORD_ATTENDANCE_ACTION_ALIASES.skip',
  wechat: 'server/api.js:legacyWechatAttendanceStatus'
});

export function planSchedulingMigration(legacy, { now = new Date().toISOString() } = {}) {
  if (!legacy || typeof legacy !== 'object' || Array.isArray(legacy)) fail('MIGRATION_SOURCE_INVALID');
  const plannedAt = safeTime(now);
  if (!plannedAt) fail('MIGRATION_TIME_INVALID');
  const out = { wipes: [], signups: [], contentSnapshots: [], archives: [], quarantine: [], sourceHash: hash(legacy) };
  const quarantine = (kind, raw, references = {}) => {
    const record = { kind, legacyRaw: copy(raw), ...references };
    out.quarantine.push({ id: `legacy_${hash(record)}`, ...record, status: 'open', createdAt: plannedAt });
  };
  const wipes = list(legacy, 'wipes'), participants = list(legacy, 'wipeParticipants');
  const settlements = list(legacy, 'wipeSettlements');
  const wipeGroups = groupBy(wipes, wipe => wipe?.id);
  for (const [id, rows] of wipeGroups) {
    const raw = rows[0];
    if (!raw || !idValid(id)) { quarantine('WIPE_ID_INVALID', rows); continue; }
    if (rows.length > 1) { quarantine('WIPE_ID_CONFLICT', rows, { wipeId: id }); continue; }
    if (!['active', 'closed'].includes(raw.status)) { quarantine('WIPE_STATUS_UNKNOWN', raw, { wipeId: id }); continue; }
    const startedAt = safeTime(raw.startedAt);
    const explicitlyPlanned = raw.wipeMode === 'next' || raw.wipeLabel === 'Planned';
    const hasStartEvidence = Boolean(raw.actualStartedAt || raw.serverActualWipeAt || raw.startEvidence || raw.serverStartEvidence);
    const futurePlanned = raw.status === 'active' && explicitlyPlanned && startedAt &&
      Date.parse(startedAt) > Date.parse(plannedAt) && !hasStartEvidence;
    const hasAudience = raw.audience && Array.isArray(raw.audience.squadIds) && Array.isArray(raw.audience.memberIds) &&
      raw.audience.squadIds.every(idValid) && raw.audience.memberIds.every(idValid) && typeof raw.audience.includeUnassigned === 'boolean';
    const audience = hasAudience ? { squadIds: [...new Set(raw.audience.squadIds)], memberIds: [...new Set(raw.audience.memberIds)],
      includeUnassigned: raw.audience.includeUnassigned } : { squadIds: [], memberIds: [], includeUnassigned: false };
    const legacySettlements = settlements.filter(settlement => settlement?.wipeId === id);
    const lifecycle = raw.status === 'closed' ? 'ended' : futurePlanned ? 'scheduled' : 'active';
    const serverSnapshot = {};
    for (const key of ['serverName', 'serverPresetId', 'vitalServerId', 'vitalWipeId', 'battlemetricsId',
      'directConnect', 'vipUrl', 'mapLink', 'rustMapsLink', 'kdaProvider', 'kdaUrl']) {
      if (Object.hasOwn(raw, key)) serverSnapshot[key] = copy(raw[key]);
    }
    const wipe = { id, title: typeof raw.name === 'string' ? raw.name : '', serverProfileId: raw.serverPresetId || null, serverSnapshot,
      description: typeof raw.notes === 'string' ? raw.notes : '', lifecycle, outcome: null, revision: 1, contentRevision: 1, rosterRevision: 1,
      audience, signupWindow: 'closed', signupOpensAt: null, signupClosesAt: null, musterAt: null,
      timeZone: safeZone(raw.startedAtTimeZone || raw.timeZone), serverScheduledWipeAt: futurePlanned ? startedAt : null,
      serverScheduleSource: futurePlanned ? 'legacy_planned_startedAt' : 'legacy_unknown',
      serverActualWipeAt: null, serverStartEvidence: null, phaseEnteredAt: null, actualStartedAt: null,
      startEvidence: null, startMode: 'legacy_unknown', endedAt: lifecycle === 'ended' ? safeTime(raw.closedAt) : null,
      autoStart: false, autoOpenSignup: false, settlementStatus: lifecycle === 'ended' && legacySettlements.length ? 'legacy_review_required' : 'pending_data',
      archiveRevision: 0, createdAt: safeTime(raw.createdAt), updatedAt: safeTime(raw.updatedAt),
      migrationMode: 'legacy_unknown', legacyRaw: copy(raw), legacyModelVersion: 'pre_v2', migratedAt: plannedAt,
      legacyIssues: ['MUSTER_TIME_UNKNOWN', 'SIGNUP_WINDOW_REVIEW_REQUIRED', ...(!hasAudience ? ['AUDIENCE_REVIEW_REQUIRED'] : []),
        ...(!futurePlanned && lifecycle === 'active' ? ['LIFECYCLE_REVIEW_REQUIRED'] : [])] };
    out.wipes.push(wipe);
    out.contentSnapshots.push({ id: `${id}:1`, wipeId: id, contentRevision: 1, serverSnapshot: copy(serverSnapshot),
      musterAt: null, serverScheduledWipeAt: wipe.serverScheduledWipeAt, description: wipe.description,
      timeZone: wipe.timeZone, createdAt: plannedAt, legacy: true, legacyModelVersion: 'pre_v2',
      confirmationStatus: 'legacy_unconfirmed' });
    if (legacySettlements.length) out.archives.push({ id: `${id}:0`, wipeId: id, archiveRevision: 0,
      format: 'legacy', legacy: true, legacyModelVersion: 'pre_v2', sourceWasMutable: true,
      settlementStatus: 'legacy_review_required', legacyRaw: copy(legacySettlements),
      createdAt: plannedAt, contentRevision: null, frozenRoster: null });
  }
  const migratedWipes = new Map(out.wipes.map(wipe => [wipe.id, wipe]));
  const slotGroups = groupBy(participants, row => JSON.stringify([row?.wipeId, row?.memberId]));
  for (const rows of slotGroups.values()) {
    const raw = rows[0];
    if (!raw || !idValid(raw.wipeId) || !idValid(raw.memberId)) { quarantine('SIGNUP_REFERENCE_INVALID', rows); continue; }
    const refs = { wipeId: raw.wipeId, memberId: raw.memberId };
    if (!migratedWipes.has(raw.wipeId)) { quarantine('SIGNUP_WIPE_UNRESOLVED', rows, refs); continue; }
    if (rows.length > 1) { quarantine('SIGNUP_SLOT_CONFLICT', rows, refs); continue; }
    const source = raw.source || raw.platform || raw.channel || null;
    let response, semanticEvidence = null;
    if (['join', 'on_time', 'active'].includes(raw.status)) response = 'attending_on_time';
    else if (['join_8h', 'join_16h', 'late'].includes(raw.status)) response = 'attending_later';
    else if (raw.status === 'not_attending') response = 'not_attending';
    else if (raw.status === 'skip' && Object.hasOwn(LEGACY_SKIP_SEMANTICS, source)) {
      response = 'not_attending'; semanticEvidence = LEGACY_SKIP_SEMANTICS[source];
    } else if (raw.status === null && raw.withdrawnAt) response = null;
    else { quarantine(raw.status === 'skip' ? 'SIGNUP_SKIP_SEMANTICS_UNKNOWN' : 'SIGNUP_STATUS_UNKNOWN', raw, refs); continue; }
    out.signups.push({ id: `signup_${hash(JSON.stringify([raw.wipeId, raw.memberId]))}`, ...refs, response,
      expectedArrivalAt: null, timeZone: safeZone(raw.timeZone), signupRevision: 1, confirmedContentRevision: null,
      actorAccountId: null, source: 'legacy_migration', updatedAt: safeTime(raw.updatedAt),
      legacyRaw: copy(raw), legacyRawStatus: copy(raw.status), legacySource: source,
      legacyOriginalText: raw.originalText ?? raw.label ?? raw.statusText ?? null,
      legacyModelVersion: raw.modelVersion ?? raw.attendanceModel ?? 'pre_v2',
      legacyTimeStatus: response === 'attending_later' ? 'legacy_time_unknown' : 'legacy_unconfirmed',
      semanticEvidence, migratedAt: plannedAt });
  }
  for (const settlement of settlements) {
    if (!settlement || !migratedWipes.has(settlement.wipeId)) quarantine('SETTLEMENT_WIPE_UNRESOLVED', settlement);
  }
  return out;
}

const planCollections = Object.freeze({ wipes: 'wipes', signups: 'signups', contentSnapshots: 'contents',
  archives: 'archives', quarantine: 'quarantine' });

export function applySchedulingMigration(repo, plan) {
  if (!plan || !/^[a-f0-9]{64}$/.test(plan.sourceHash || '')) fail('MIGRATION_PLAN_INVALID');
  for (const key of Object.keys(planCollections)) if (!Array.isArray(plan[key])) fail('MIGRATION_PLAN_INVALID');
  return repo.transaction(() => {
    const existing = repo.scalar('v2SchedulingMigration');
    if (existing) {
      if (existing.sourceHash !== plan.sourceHash) fail('MIGRATION_SOURCE_CONFLICT');
      return { ...existing, replayed: true };
    }
    // Preflight every target before writing any row. This also supports an
    // interrupted, exactly matching import without replacing unknown changes.
    for (const [key, collection] of Object.entries(planCollections)) {
      const desired = new Map();
      for (const row of plan[key]) {
        if (!row || typeof row.id !== 'string' || !row.id || row.id.length > 512 || desired.has(row.id)) fail('MIGRATION_PLAN_INVALID');
        desired.set(row.id, row);
      }
      for (const current of repo.all(collection)) {
        if (!desired.has(current.id) || canonical(current) !== canonical(desired.get(current.id))) {
          fail('MIGRATION_TARGET_CONFLICT', { collection, recordId: current.id });
        }
      }
    }
    for (const collection of ['receipts', 'events', 'outbox']) {
      if (repo.all(collection).length) fail('MIGRATION_TARGET_CONFLICT', { collection });
    }
    for (const [key, collection] of Object.entries(planCollections)) {
      for (const row of plan[key]) if (!repo.get(collection, row.id)) repo.put(collection, row);
    }
    const manifest = { version: 1, status: 'completed', sourceHash: plan.sourceHash, planHash: hash(plan),
      appliedAt: new Date().toISOString(), counts: Object.fromEntries(Object.keys(planCollections).map(key => [key, plan[key].length])) };
    repo.setScalar('v2SchedulingMigration', manifest);
    return { ...manifest, replayed: false };
  });
}
