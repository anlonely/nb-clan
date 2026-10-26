import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { IdentityError } from '../identity/errors.js';
import { authorize, can, memberDTO } from '../identity/permissions.js';
import { SchedulingRepository } from '../scheduling/repository.js';
import { memberPermissionPredicate } from '../member-space/repository.js';

const PROCESS_CURSOR_SECRET = randomBytes(32);
const CURSOR_TTL = 300_000;
const SORT = 'createdAt:desc,id:desc';
const MANAGEMENT = ['wipes.edit', 'wipes.publish', 'wipes.start', 'wipes.end', 'wipes.archive', 'signups.delegate'];
const ACTIONS = new Set(['wipe.create', 'wipe.edit', 'wipe.publish', 'wipe.start', 'wipe.end', 'wipe.cancel',
  'wipe.archive', 'wipe.revise-archive', 'wipe.close-signup', 'wipe.reopen-signup', 'wipe.confirm-start',
  'wipe.confirm-server-start', 'signup.self', 'signup.delegate', 'signup.role_removed']);
const SOURCES = new Set(['web', 'discord', 'kook', 'wechat', 'scheduler']);
export const HISTORY_CHANGED_FIELDS = Object.freeze(['title', 'description', 'serverProfileId', 'serverSnapshot', 'audience',
  'timeZone', 'musterAt', 'serverScheduledWipeAt', 'signupOpensAt', 'signupClosesAt', 'autoStart', 'autoOpenSignup',
  'lifecycle', 'signupWindow', 'startMode', 'phaseEnteredAt', 'actualStartedAt', 'serverActualWipeAt', 'outcome',
  'endedAt', 'settlementStatus', 'archiveRevision', 'response', 'expectedArrivalAt', 'signupRevision', 'confirmedContentRevision']);
const column = path => `json_extract(e.payload_json,'$.${path}')`;
const need = (condition, code, status = 403) => { if (!condition) throw new IdentityError(code, status); };
const text = (value, limit) => typeof value === 'string'
  ? value.replace(/[\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069]/g, '').trim().slice(0, limit) || null : null;
const integer = (value, minimum = 0) => Number.isSafeInteger(value) && value >= minimum ? value : null;
const enumValue = (value, choices) => choices.includes(value) ? value : null;
const timestamp = value => typeof value === 'string' && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(value)
  && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value ? value : null;
const zone = value => {
  if (typeof value !== 'string' || value.length > 100) return null;
  try { new Intl.DateTimeFormat('en', { timeZone: value }); return value; } catch { return null; }
};
const cursorError = () => new IdentityError('CURSOR_EXPIRED', 410);
const cursorKey = secret => createHash('sha256').update('nb-admin-history/1\0').update(secret).digest();
function encodeCursor(value, secret) {
  const iv = randomBytes(12), cipher = createCipheriv('aes-256-gcm', cursorKey(secret), iv);
  const encrypted = Buffer.concat([cipher.update(JSON.stringify(value), 'utf8'), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), encrypted]).toString('base64url');
}
function decodeCursor(token, secret) {
  try {
    if (typeof token !== 'string' || token.length < 40 || token.length > 2400 || !/^[A-Za-z0-9_-]+$/.test(token)) throw cursorError();
    const bytes = Buffer.from(token, 'base64url');
    const decipher = createDecipheriv('aes-256-gcm', cursorKey(secret), bytes.subarray(0, 12));
    decipher.setAuthTag(bytes.subarray(12, 28));
    return JSON.parse(Buffer.concat([decipher.update(bytes.subarray(28)), decipher.final()]).toString('utf8'));
  } catch { throw cursorError(); }
}

/** Read-only projection over G04 immutable events; installs no schema and starts no worker. */
export class AdminHistoryService {
  constructor(identity, { now = identity.now, cursorSecret = PROCESS_CURSOR_SECRET } = {}) {
    this.identity = identity;
    this.repo = new SchedulingRepository(identity.repo.db);
    this.now = now;
    this.cursorSecret = cursorSecret;
    need(identity.repo.scalar('v2IdentityMigration') && this.repo.scalar('v2SchedulingMigration'), 'HISTORY_MIGRATION_REQUIRED', 503);
  }

  label(actor, memberId, relations) {
    if (!memberId || !can(actor, 'members.read', { kind: 'member', id: memberId }, relations))
      return { label: null, labelSource: 'redacted' };
    const member = this.identity.repo.get('members', memberId);
    const label = member && text(memberDTO(member).displayName, 120);
    return { label: label || null, labelSource: label ? 'current' : 'redacted' };
  }

  project(row, actor, relations) {
    const occurredAt = timestamp(row.createdAt), wipeRevision = integer(row.wipeRevision, 1), contentRevision = integer(row.contentRevision, 1);
    need(occurredAt && wipeRevision && contentRevision, 'HISTORY_DATA_INVALID', 503);
    const account = typeof row.actorAccountId === 'string' && this.identity.repo.get('accounts', row.actorAccountId);
    const item = {
      id: row.id, type: row.type, action: ACTIONS.has(row.action) ? row.action : 'unknown', occurredAt,
      source: SOURCES.has(row.source) ? row.source : 'other', wipeRevision, contentRevision,
      actor: { isSelf: row.actorAccountId === actor.id, ...this.label(actor, account?.memberId, relations) },
      subject: row.type === 'signup.changed' ? this.label(actor, row.memberId, relations) : null,
      reason: row.reasonBytes ? text(Buffer.from(row.reasonBytes).toString('utf8'), 500) : null,
      changedFields: HISTORY_CHANGED_FIELDS.filter((_field, index) => row[`changed${index}`] === 1),
      state: null, signup: null
    };
    if (row.type === 'wipe.changed') item.state = {
      lifecycle: enumValue(row.lifecycle, ['draft', 'scheduled', 'active', 'ended', 'archived', 'cancelled']),
      outcome: enumValue(row.outcome, ['completed', 'aborted', 'cancelled']),
      signupWindow: enumValue(row.signupWindow, ['not_open', 'open', 'closed']),
      startMode: enumValue(row.startMode, ['scheduled', 'manual']), archiveRevision: integer(row.archiveRevision)
    };
    else {
      const signupRevision = integer(row.signupRevision, 1);
      need(signupRevision, 'HISTORY_DATA_INVALID', 503);
      item.signup = { response: enumValue(row.response, ['attending_on_time', 'attending_later', 'not_attending']),
        expectedArrivalAt: timestamp(row.expectedArrivalAt), timeZone: zone(row.timeZone), signupRevision,
        confirmedContentRevision: integer(row.confirmedContentRevision, 1) };
    }
    return item;
  }

  /** Optional cursorSecret is server-only material, never a CSRF or other browser-known token. */
  list(inputActor, wipeId, query = {}, { cursorSecret = this.cursorSecret } = {}) {
    const db = this.repo.db;
    // A read savepoint keeps watermark, permission relations and rows in one SQLite snapshot.
    db.exec('SAVEPOINT v2_admin_history_read');
    try {
      const actor = this.identity.actorForAccount(inputActor?.id);
      need(actor.permissionVersion === inputActor.permissionVersion, 'PERMISSIONS_CHANGED', 401);
      const wipe = this.repo.get('wipes', wipeId), relations = this.identity.relations(), resource = { kind: 'wipe', id: wipeId };
      need(wipe, 'RESOURCE_NOT_FOUND', 404);
      authorize(actor, 'wipes.read', resource, relations, true);
      need(MANAGEMENT.some(capability => can(actor, capability, resource, relations)), 'ACCESS_DENIED');
      need(query && typeof query === 'object' && !Array.isArray(query) && Object.keys(query).every(key => ['limit', 'cursor'].includes(key)), 'INVALID_HISTORY_QUERY', 422);
      need(query.limit === undefined || typeof query.limit === 'string' && /^\d{1,4}$/.test(query.limit)
        || Number.isSafeInteger(query.limit), 'INVALID_HISTORY_QUERY', 422);
      const limit = query.limit === undefined ? 20 : Math.min(50, Math.max(1, Number(query.limit)));
      const now = this.now(), scopeDigest = this.identity.scopeDigest(actor);
      let cursor;
      if (query.cursor !== undefined && query.cursor !== '') {
        cursor = decodeCursor(query.cursor, cursorSecret);
        const valid = cursor?.schema === 1 && cursor.route === 'admin-history' && cursor.sort === SORT && cursor.filter === 'committed-scheduling-events'
          && cursor.accountId === actor.id && cursor.scopeVersion === actor.permissionVersion && cursor.scopeDigest === scopeDigest && cursor.wipeId === wipeId
          && Number.isSafeInteger(cursor.expiresAt) && cursor.expiresAt > now && cursor.expiresAt <= now + CURSOR_TTL
          && integer(cursor.snapshot?.rowid, 1) && typeof cursor.snapshot.id === 'string' && cursor.snapshot.id.length <= 200
          && typeof cursor.snapshot.hash === 'string' && /^[a-f0-9]{64}$/.test(cursor.snapshot.hash)
          && timestamp(cursor.after?.createdAt) && typeof cursor.after.id === 'string' && cursor.after.id.length <= 200;
        if (!valid) throw cursorError();
        // A restored/rebuilt database or VACUUM must not silently reuse another rowid boundary.
        const anchor = db.prepare("SELECT rowid,hash FROM json_records WHERE collection='v2SchedulingEvents' AND id=? AND json_extract(payload_json,'$.wipeId')=?")
          .get(cursor.snapshot.id, wipeId);
        if (!anchor || anchor.rowid !== cursor.snapshot.rowid || anchor.hash !== cursor.snapshot.hash) throw cursorError();
      } else {
        const snapshot = db.prepare("SELECT rowid,id,hash FROM json_records WHERE collection='v2SchedulingEvents' AND json_extract(payload_json,'$.wipeId')=? ORDER BY rowid DESC LIMIT 1").get(wipeId);
        if (!snapshot) { db.exec('RELEASE v2_admin_history_read'); return { wipeId, items: [], nextCursor: null, countScope: 'authorized_events' }; }
        cursor = { schema: 1, route: 'admin-history', sort: SORT, filter: 'committed-scheduling-events',
          accountId: actor.id, scopeVersion: actor.permissionVersion, scopeDigest, wipeId, expiresAt: now + CURSOR_TTL, snapshot, after: null };
      }
      const permission = memberPermissionPredicate(actor, 'signups.read', column('memberId'), column('wipeId'));
      const fields = ['type', 'action', 'source', 'actorAccountId', 'memberId', 'createdAt', 'wipeRevision', 'contentRevision']
        .map(field => `${column(field)} AS ${field}`);
      // A BLOB preserves embedded NUL for sanitizing in JS; node:sqlite text reads truncate at NUL.
      // Non-string reasons are never serialized into the public projection. Bound bytes before decoding.
      fields.push(`CASE WHEN json_type(e.payload_json,'$.reason')='text' THEN substr(CAST(${column('reason')} AS BLOB),1,4096) ELSE NULL END AS reasonBytes`);
      for (const field of ['lifecycle', 'outcome', 'signupWindow', 'startMode', 'archiveRevision', 'response', 'expectedArrivalAt', 'timeZone', 'signupRevision', 'confirmedContentRevision'])
        fields.push(`${column(`after.${field}`)} AS ${field}`);
      HISTORY_CHANGED_FIELDS.forEach((field, index) => fields.push(`(${column(`before.${field}`)} IS NOT ${column(`after.${field}`)}) AS changed${index}`));
      const tail = cursor.after;
      const rows = db.prepare(`SELECT e.id,${fields.join(',')} FROM json_records e
        WHERE e.collection='v2SchedulingEvents' AND ${column('wipeId')}=? AND e.rowid<=?
        AND ((${column('type')}='wipe.changed' AND ${column('memberId')} IS NULL)
          OR (${column('type')}='signup.changed' AND json_type(e.payload_json,'$.memberId')='text' AND ${permission.text}))
        ${tail ? `AND (${column('createdAt')}<? OR (${column('createdAt')}=? AND e.id<?))` : ''}
        ORDER BY ${column('createdAt')} DESC,e.id DESC LIMIT ?`)
        .all(wipeId, cursor.snapshot.rowid, ...permission.args, ...(tail ? [tail.createdAt, tail.createdAt, tail.id] : []), limit + 1);
      const selected = rows.slice(0, limit);
      for (const row of selected) if (row.type === 'signup.changed')
        need(can(actor, 'signups.read', { kind: 'signup', wipeId, memberId: row.memberId }, relations), 'HISTORY_SCOPE_MISMATCH', 503);
      const items = selected.map(row => this.project(row, actor, relations));
      const last = selected.at(-1);
      const nextCursor = rows.length > limit && last ? encodeCursor({ ...cursor, after: { createdAt: last.createdAt, id: last.id } }, cursorSecret) : null;
      db.exec('RELEASE v2_admin_history_read');
      return { wipeId, items, nextCursor, countScope: 'authorized_events' };
    } catch (error) {
      db.exec('ROLLBACK TO v2_admin_history_read'); db.exec('RELEASE v2_admin_history_read');
      throw error;
    }
  }
}
