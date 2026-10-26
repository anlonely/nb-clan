import { rosterReadScope } from './read-snapshot.js';
import { createHash, randomUUID } from 'node:crypto';
import { normalizeSpecialties } from '../../../shared/member-preferences.js';
import { IdentityError } from '../identity/errors.js';
import { authorize, can } from '../identity/permissions.js';
import { membershipStatus } from '../identity/migration.js';
import { normalizeTime, validateTimeZone } from './time.js';
import { assertTargetEligibility, refreshTargetEligibility } from './eligibility.js';

const clone = value => structuredClone(value);
const canonical = value => Array.isArray(value) ? value.map(canonical) : value && typeof value === 'object'
  ? Object.fromEntries(Object.keys(value).sort().filter(k => value[k] !== undefined).map(k => [k, canonical(value[k])])) : value;
export const hash = value => createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
export const signupId = (wipeId, memberId) => `signup_${hash([wipeId, memberId])}`;
const need = (condition, code, status = 409, options) => { if (!condition) throw new IdentityError(code, status, options); };
const safeRevision = value => Number.isSafeInteger(value) && value >= 0;
const times = ['musterAt', 'signupOpensAt', 'signupClosesAt', 'serverScheduledWipeAt'];
const editable = ['title', 'description', 'serverProfileId', 'serverSnapshot', 'serverScheduleSource', 'audience', 'timeZone', ...times, 'autoStart', 'autoOpenSignup'];
const responses = [null, 'attending_on_time', 'attending_later', 'not_attending'];
const terminal = ['ended', 'archived', 'cancelled'];
export class SchedulingService {
  constructor(repo, identity, { now = Date.now } = {}) {
    need(repo.db === identity.repo.db, 'SCHEDULING_STORAGE_MISMATCH', 503);
    this.repo = repo; this.identity = identity; this.now = now;
  }
  actor(actor) {
    const current = this.identity.actorForAccount(actor?.id);
    need(current.permissionVersion === actor.permissionVersion, 'PERMISSIONS_CHANGED', 401);
    return current;
  }
  wipe(id) { const w = this.repo.get('wipes', id); need(w, 'RESOURCE_NOT_FOUND', 404); return w; }
  authorize(actor, capability, resource, hidden = false) { authorize(actor, capability, resource, this.identity.relations(), hidden); }
  inAudience(wipe, memberId) {
    const squadIds = this.identity.relations().squadMembers.filter(m => m.memberId === memberId && !m.validTo).map(m => m.squadId);
    return Boolean(wipe.audience.allMembers === true && memberId || wipe.audience.memberIds.includes(memberId) || wipe.audience.squadIds.some(id => squadIds.includes(id)) || wipe.audience.includeUnassigned && !squadIds.length);
  }
  target(memberId, { eligibility = true } = {}) {
    const member = this.identity.repo.get('members', memberId);
    need(member && membershipStatus(member) === 'active', 'MEMBERSHIP_INACTIVE', 403);
    const binding = this.identity.repo.all('bindings').find(b => b.memberId === memberId && b.status === 'verified');
    need(binding, 'MEMBER_VERIFICATION_REQUIRED', 403);
    const account = this.identity.repo.get('accounts', binding.accountId);
    this.identity.accountAccess(account);
    need(account.memberId === memberId, 'IDENTITY_CONFLICT', 409);
    if (eligibility) assertTargetEligibility(this.identity, memberId);
    return member;
  }
  async prepareSignupTarget(actor, id, memberId, { delegate = false } = {}) {
    actor = this.actor(actor); const wipe = this.wipe(id);
    this.accessSignup(actor, wipe, memberId, { delegate, write: true, eligibility: false });
    await refreshTargetEligibility(this.identity, memberId);
  }
  accessSignup(actor, wipe, memberId, { delegate = false, write = false, eligibility = true } = {}) {
    const resource = { kind: 'signup', wipeId: wipe.id, memberId };
    if (write) {
      if (!delegate) { this.identity.assertMemberParticipation(actor); need(actor.memberId === memberId, 'ACCESS_DENIED', 403); }
      this.authorize(actor, delegate ? 'signups.delegate' : 'signups.self_write', resource);
      this.target(memberId, { eligibility });
      need(this.inAudience(wipe, memberId), 'MEMBER_OUTSIDE_AUDIENCE', 403);
    } else this.authorize(actor, 'signups.read', resource, true);
  }
  signup(wipe, memberId) {
    const stored = this.repo.get('signups', signupId(wipe.id, memberId)) || { wipeId: wipe.id, memberId, response: null,
      signupRevision: 0, confirmedContentRevision: null, expectedArrivalAt: null, timeZone: wipe.timeZone };
    const { legacyRaw, legacyOrigin, ...s } = stored;
    const content = s.confirmedContentRevision && this.repo.get('contents', `${wipe.id}:${s.confirmedContentRevision}`);
    return { ...s, needsReconfirmation: false,
      confirmedMusterAt: content?.musterAt || null };
  }
  window(w, now = this.now()) {
    if (!['scheduled', 'active'].includes(w.lifecycle)) return 'closed';
    if (w.signupWindow === 'closed' || !w.signupOpensAt || !w.signupClosesAt || now >= Date.parse(w.signupClosesAt)) return 'closed';
    if (now < Date.parse(w.signupOpensAt)) return 'not_open';
    return w.signupWindow === 'open' || w.autoOpenSignup ? 'open' : 'not_open';
  }
  getWipe(actor, id) {
    actor = this.actor(actor); const w = this.wipe(id); this.authorize(actor, 'wipes.read', { kind: 'wipe', id }, true);
    const { legacyRaw, ...dto } = w;
    const readableSignup = actor.memberId && can(actor, 'signups.read', { kind: 'signup', wipeId: id, memberId: actor.memberId }, this.identity.relations());
    return { ...dto, effectiveSignupWindow: this.window(w), mySignup: readableSignup ? this.signup(w, actor.memberId) : null };
  }
  getSignup(actor, id, memberId = actor.memberId) {
    actor = this.actor(actor); const w = this.wipe(id); this.authorize(actor, 'wipes.read', { kind: 'wipe', id }, true);
    this.accessSignup(actor, w, memberId); return this.signup(w, memberId);
  }
  receipt(actor, operationId, action, wipeId, memberId, input) {
    need(typeof operationId === 'string' && /^[A-Za-z0-9:_-]{1,200}$/.test(operationId), 'IDEMPOTENCY_KEY_REQUIRED', 422);
    const id = hash([actor.id, operationId]), digest = hash({ action, wipeId, memberId, input });
    const existing = this.repo.get('receipts', id);
    if (existing) need(existing.digest === digest, 'IDEMPOTENCY_CONFLICT');
    return { id, digest, existing };
  }
  result(receipt, current, replayed) {
    need(!receipt.expired, 'OPERATION_RECEIPT_EXPIRED', 410, { current });
    return { operationReceipt: receipt.operationReceipt, current, replayed };
  }
  record(actor, action, w, before, after, key, opts, now, memberId = null, extra = {}) {
    const stamp = new Date(now).toISOString(), eventId = `event_${randomUUID()}`;
    const event = { id: eventId, type: memberId ? 'signup.changed' : 'wipe.changed', action, wipeId: w.id, memberId,
      actorAccountId: actor.id, source: opts.source || 'web', reason: extra.reason || null, operationId: opts.operationId,
      before: clone(before), after: clone(after), createdAt: stamp, wipeRevision: w.revision, contentRevision: w.contentRevision };
    this.repo.put('events', event);
    this.repo.put('outbox', { id: eventId, eventId, type: event.type, wipeId: w.id, memberId,
      wipeRevision: w.revision, contentRevision: w.contentRevision, signupRevision: after?.signupRevision || null,
      status: 'pending', createdAt: stamp, payload: { action, invalidateSummary: true,
        invalidateReminders: !memberId, terminal: terminal.includes(w.lifecycle) } });
    const operationReceipt = { operationId: opts.operationId, committedAt: stamp, result: 'committed', action, wipeId: w.id, memberId,
      ...(memberId ? { signupRevision: after.signupRevision, confirmedContentRevision: after.confirmedContentRevision } : { revision: w.revision, contentRevision: w.contentRevision }) };
    return this.repo.put('receipts', { id: key.id, digest: key.digest, operationId: opts.operationId, actorAccountId: actor.id,
      action, wipeId: w.id, memberId, operationReceipt, ...extra });
  }
  saveSignup(actor, id, memberId, input, opts = {}) {
    return this.repo.transaction(() => {
      const now = this.now(); actor = this.actor(actor); const w = this.wipe(id);
      need(input && typeof input === 'object' && !Array.isArray(input), 'INVALID_SIGNUP', 422);
      this.accessSignup(actor, w, memberId, { delegate: opts.delegate, write: true });
      const key = this.receipt(actor, opts.operationId, opts.delegate ? 'signup.delegate' : 'signup.self', id, memberId, input);
      if (key.existing) {
        if (key.existing.overrideClosed) this.authorize(actor, 'signups.override_closed', { kind: 'signup', wipeId: id, memberId });
        return this.result(key.existing, this.signup(w, memberId), true);
      }
      need(['scheduled', 'active'].includes(w.lifecycle), 'WIPE_IMMUTABLE');
      this.ready(w);
      const overrideClosed = this.window(w, now) !== 'open';
      if (overrideClosed) {
        need(opts.delegate, this.window(w, now) === 'not_open' ? 'SIGNUP_NOT_OPEN' : 'SIGNUP_CLOSED');
        this.authorize(actor, 'signups.override_closed', { kind: 'signup', wipeId: id, memberId });
      }
      if (opts.delegate) need(typeof input.reason === 'string' && input.reason.trim().length > 0 && input.reason.length <= 500, 'REASON_REQUIRED', 422);
      need(input && Object.keys(input).every(k => ['response', 'expectedArrivalAt', 'timeZone', 'rawTimeInputs', 'expectedSignupRevision', 'confirmedContentRevision', 'reason'].includes(k)), 'INVALID_SIGNUP', 422);
      need(responses.includes(input.response) && safeRevision(input.expectedSignupRevision) && safeRevision(input.confirmedContentRevision), 'INVALID_SIGNUP', 422);
      const current = this.signup(w, memberId);
      need(input.expectedSignupRevision === current.signupRevision, 'REVISION_CONFLICT', 409, { current });
      validateTimeZone(input.timeZone);
      let arrival = null;
      if (input.response === 'attending_later') {
        arrival = normalizeTime(input.expectedArrivalAt, input.timeZone, input.rawTimeInputs?.expectedArrivalAt);
        need(arrival && Date.parse(arrival) > Date.parse(w.actualStartedAt || w.serverScheduledWipeAt || w.musterAt) && Date.parse(arrival) >= now, 'ARRIVAL_TIME_INVALID', 422);
      } else need(input.expectedArrivalAt == null, 'ARRIVAL_TIME_INVALID', 422);
      const original = this.repo.get('signups', signupId(id, memberId));
      const legacyOrigin = original?.legacyOrigin || (original?.legacyRaw ? { raw: original.legacyRaw, status: original.legacyRawStatus, source: original.legacySource } : undefined);
      const next = { ...(legacyOrigin ? { legacyOrigin } : {}), id: signupId(id, memberId), wipeId: id, memberId, response: input.response, expectedArrivalAt: arrival,
        timeZone: input.timeZone, signupRevision: current.signupRevision + 1, confirmedContentRevision: w.contentRevision,
        actorAccountId: actor.id, source: opts.source || 'web', updatedAt: new Date(now).toISOString() };
      this.repo.put('signups', next);
      const receipt = this.record(actor, opts.delegate ? 'signup.delegate' : 'signup.self', w, original || current, next, key, opts, now, memberId,
        { reason: input.reason || null, overrideClosed, delegate: Boolean(opts.delegate) });
      return this.result(receipt, this.signup(w, memberId), false);
    });
  }
  // Called only after a community role check has confirmed departure. Clear live
  // signup slots while retaining immutable change events and completed wipes.
  clearCurrentSignupsForDepartedMember(memberId) {
    // A savepoint also works inside the identity lock transaction, so both
    // state changes commit or roll back together.
    this.repo.db.exec('SAVEPOINT v2_departed_signup_clear');
    try {
      const now = this.now(), createdAt = new Date(now).toISOString();
      let cleared = 0;
      for (const before of this.repo.all('signups')) {
        if (before.memberId !== memberId || before.response == null) continue;
        const wipe = this.repo.get('wipes', before.wipeId);
        if (!wipe || !['scheduled', 'active'].includes(wipe.lifecycle)) continue;
        const after = { ...before, response: null, expectedArrivalAt: null,
          signupRevision: before.signupRevision + 1, confirmedContentRevision: wipe.contentRevision,
          actorAccountId: 'system:role-sync', source: 'scheduler', updatedAt: createdAt };
        this.repo.put('signups', after);
        const eventId = `event_${randomUUID()}`, action = 'signup.role_removed';
        this.repo.put('events', { id: eventId, type: 'signup.changed', action, wipeId: wipe.id, memberId,
          actorAccountId: 'system:role-sync', source: 'scheduler', reason: '社区角色核验未通过，自动清除当前报名',
          before: clone(before), after: clone(after), createdAt,
          wipeRevision: wipe.revision, contentRevision: wipe.contentRevision });
        this.repo.put('outbox', { id: eventId, eventId, type: 'signup.changed', wipeId: wipe.id, memberId,
          wipeRevision: wipe.revision, contentRevision: wipe.contentRevision, signupRevision: after.signupRevision,
          status: 'pending', createdAt, payload: { action, invalidateSummary: true,
            invalidateReminders: false, terminal: false } });
        cleared++;
      }
      this.repo.db.exec('RELEASE v2_departed_signup_clear');
      return cleared;
    } catch (error) {
      this.repo.db.exec('ROLLBACK TO v2_departed_signup_clear');
      this.repo.db.exec('RELEASE v2_departed_signup_clear');
      throw error;
    }
  }
  normalizeWipe(input, current = {}) {
    need(input && Object.keys(input).every(k => [...editable, 'expectedRevision', 'majorChange', 'reason', 'rawTimeInputs', 'publishImmediately'].includes(k)), 'INVALID_WIPE', 422);
    need(input.publishImmediately === undefined || typeof input.publishImmediately === 'boolean', 'INVALID_WIPE', 422);
    const w = { title: '', description: '', serverProfileId: null, serverSnapshot: null, serverScheduleSource: null,
      audience: { squadIds: [], memberIds: [], includeUnassigned: false }, timeZone: null, autoStart: false, autoOpenSignup: true,
      ...Object.fromEntries(times.map(k => [k, null])), ...current };
    for (const k of editable) if (Object.hasOwn(input, k)) w[k] = clone(input[k]);
    need(typeof w.title === 'string' && w.title.length <= 200 && typeof w.description === 'string' && w.description.length <= 10000, 'INVALID_WIPE', 422);
    need(typeof w.autoStart === 'boolean' && typeof w.autoOpenSignup === 'boolean', 'INVALID_WIPE', 422);
    need(w.serverProfileId === null || typeof w.serverProfileId === 'string' && w.serverProfileId.length <= 160, 'INVALID_SERVER', 422);
    need(w.serverSnapshot === null || typeof w.serverSnapshot === 'object' && !Array.isArray(w.serverSnapshot) && JSON.stringify(w.serverSnapshot).length <= 10000, 'INVALID_SERVER', 422);
    const a = w.audience;
    need(a && Object.keys(a).every(k => ['squadIds','memberIds','includeUnassigned','allMembers'].includes(k)) && Array.isArray(a.squadIds) && Array.isArray(a.memberIds) &&
      a.squadIds.length <= 1000 && a.memberIds.length <= 10000 && [...a.squadIds,...a.memberIds].every(id => typeof id === 'string' && id.length > 0 && id.length <= 160) &&
      typeof a.includeUnassigned === 'boolean' && (a.allMembers === undefined || typeof a.allMembers === 'boolean'), 'INVALID_AUDIENCE', 422);
    w.audience = { ...(a.allMembers !== undefined ? { allMembers: a.allMembers } : {}), squadIds: [...new Set(a.squadIds)].sort(), memberIds: [...new Set(a.memberIds)].sort(), includeUnassigned: a.includeUnassigned };
    need(w.audience.squadIds.every(id => this.identity.repo.get('squads', id)) && w.audience.memberIds.every(id => this.identity.repo.get('members', id)), 'INVALID_AUDIENCE', 422);
    if (w.timeZone) validateTimeZone(w.timeZone);
    for (const k of times) if (Object.hasOwn(input, k)) w[k] = normalizeTime(input[k], w.timeZone, input.rawTimeInputs?.[k]);
    if (times.some(k => w[k])) validateTimeZone(w.timeZone);
    if (w.signupOpensAt && w.signupClosesAt) need(Date.parse(w.signupOpensAt) < Date.parse(w.signupClosesAt), 'SIGNUP_WINDOW_INVALID', 422);
    return w;
  }
  ready(w) {
    const fields = {};
    for (const k of ['serverProfileId','serverSnapshot','musterAt','signupOpensAt','signupClosesAt','timeZone']) if (!w[k]) fields[k] = 'REQUIRED';
    if (!w.audience.allMembers && !w.audience.squadIds.length && !w.audience.memberIds.length && !w.audience.includeUnassigned) fields.audience = 'REQUIRED';
    need(!Object.keys(fields).length, 'WIPE_INCOMPLETE', 422, { fieldErrors: fields });
  }
  content(w, now) {
    this.repo.put('contents', { id: `${w.id}:${w.contentRevision}`, wipeId: w.id, contentRevision: w.contentRevision,
      serverProfileId: w.serverProfileId, serverSnapshot: clone(w.serverSnapshot), musterAt: w.musterAt,
      serverScheduledWipeAt: w.serverScheduledWipeAt, timeZone: w.timeZone, description: w.description, createdAt: new Date(now).toISOString() });
  }
  audiencePermission(actor, capability, w) {
    // Evaluate the prospective audience, not an attacker-supplied resource relationship.
    const relations = this.identity.relations(); relations.wipes = [...relations.wipes.filter(x => x.id !== w.id), w];
    authorize(actor, capability, { kind: 'wipe', id: w.id }, relations);
  }
  immediateSignupInput(input, now, current = {}) {
    if (input?.publishImmediately !== true) return input;
    const signupClosesAt = input.signupClosesAt ?? input.serverScheduledWipeAt ?? current.serverScheduledWipeAt;
    const rawTimeInputs = { ...input.rawTimeInputs };
    delete rawTimeInputs.signupOpensAt;
    if (input.signupClosesAt == null) {
      delete rawTimeInputs.signupClosesAt;
      if (input.rawTimeInputs?.serverScheduledWipeAt) rawTimeInputs.signupClosesAt = input.rawTimeInputs.serverScheduledWipeAt;
    }
    return { ...input, signupOpensAt: new Date(now).toISOString(), signupClosesAt, autoOpenSignup: true, rawTimeInputs };
  }
  publishImmediately(actor, w, now) {
    this.audiencePermission(actor, 'wipes.publish', w);
    this.ready(w);
    need(w.title.trim().length > 0, 'WIPE_INCOMPLETE', 422, { fieldErrors: { title: 'REQUIRED' } });
    need(Date.parse(w.signupClosesAt) > now, 'SIGNUP_WINDOW_INVALID', 422);
    w.lifecycle = 'scheduled'; w.signupWindow = 'open';
  }
  createWipe(actor, input, opts = {}) {
    return this.repo.transaction(() => {
      const now = this.now(); actor = this.actor(actor);
      const key = this.receipt(actor, opts.operationId, 'wipe.create', null, null, input);
      if (key.existing) {
        const w = this.wipe(key.existing.wipeId); this.audiencePermission(actor, 'wipes.create', w);
        if (input.publishImmediately === true) this.audiencePermission(actor, 'wipes.publish', w);
        return this.result(key.existing, w, true);
      }
      const w = { ...this.normalizeWipe(this.immediateSignupInput(input, now)), id: `wipe_${randomUUID()}`, lifecycle: 'draft', outcome: null, revision: 1, contentRevision: 1,
        signupWindow: 'not_open', actualStartedAt: null, phaseEnteredAt: null, serverActualWipeAt: null, serverStartEvidence: null,
        startEvidence: null, endedAt: null, settlementStatus: null, archiveRevision: 0, createdAt: new Date(now).toISOString(), updatedAt: new Date(now).toISOString() };
      this.audiencePermission(actor, 'wipes.create', w);
      if (input.publishImmediately === true) this.publishImmediately(actor, w, now);
      this.repo.put('wipes', w); this.content(w, now);
      const receipt = this.record(actor, 'wipe.create', w, null, w, key, opts, now);
      return this.result(receipt, w, false);
    });
  }
  updateWipe(actor, id, input, opts = {}) {
    return this.repo.transaction(() => {
      const now = this.now(); actor = this.actor(actor); const w = this.wipe(id); this.authorize(actor, 'wipes.edit', { kind: 'wipe', id });
      const key = this.receipt(actor, opts.operationId, 'wipe.edit', id, null, input);
      if (key.existing) {
        if (input.publishImmediately === true) this.audiencePermission(actor, 'wipes.publish', w);
        return this.result(key.existing, w, true);
      }
      need(['draft','scheduled','active'].includes(w.lifecycle), 'WIPE_IMMUTABLE');
      need(input.expectedRevision === w.revision, 'REVISION_CONFLICT', 409, { current: w });
      if (input.publishImmediately === true) need(w.lifecycle === 'draft', 'WIPE_IMMUTABLE');
      const next = this.normalizeWipe(this.immediateSignupInput(input, now, w), w); this.audiencePermission(actor, 'wipes.edit', next);
      if (input.publishImmediately === true) this.publishImmediately(actor, next, now);
      if (w.lifecycle !== 'draft') this.ready(next);
      const major = input.majorChange === true || ['musterAt','serverScheduledWipeAt','serverProfileId','serverSnapshot'].some(k => hash(next[k]) !== hash(w[k]));
      next.revision++; next.contentRevision += Number(major); next.updatedAt = new Date(now).toISOString();
      this.repo.put('wipes', next); if (major) this.content(next, now);
      return this.result(this.record(actor, 'wipe.edit', next, w, next, key, opts, now, null, { reason: input.reason }), next, false);
    });
  }
  transition(actor, id, command, input, opts = {}) {
    const capabilities = { publish: 'publish', start: 'start', end: 'end', cancel: 'edit', archive: 'archive',
      'revise-archive': 'archive', 'close-signup': 'edit', 'reopen-signup': 'edit', 'confirm-start': 'start', 'confirm-server-start': 'start' };
    need(capabilities[command], 'COMMAND_INVALID', 422);
    return this.repo.transaction(() => {
      const now = this.now(), stamp = new Date(now).toISOString(); actor = this.actor(actor); const w = this.wipe(id);
      this.authorize(actor, `wipes.${capabilities[command]}`, { kind: 'wipe', id });
      const key = this.receipt(actor, opts.operationId, `wipe.${command}`, id, null, input);
      if (key.existing) return this.result(key.existing, w, true);
      need(input && input.expectedRevision === w.revision, 'REVISION_CONFLICT', 409, { current: w });
      need(Object.keys(input).every(k => ['expectedRevision','reason','outcome','closesAt','rawTimeInputs','startMode','actualStartedAt',
        'startEvidence','serverActualWipeAt','serverStartEvidence','baseArchiveRevision','completeness','data'].includes(k)), 'INVALID_COMMAND', 422);
      const next = clone(w);
      const reason = () => need(typeof input.reason === 'string' && input.reason.trim().length > 0 && input.reason.length <= 500, 'REASON_REQUIRED', 422);
      const state = (...states) => need(states.includes(w.lifecycle), 'WIPE_IMMUTABLE');
      if (command === 'publish') {
        state('draft'); this.ready(w); next.lifecycle = 'scheduled'; next.signupWindow = w.autoOpenSignup ? 'open' : 'not_open';
      } else if (command === 'start') {
        state('scheduled'); this.ready(w);
        need(input.startMode === undefined || ['scheduled','manual'].includes(input.startMode), 'START_MODE_INVALID', 422);
        if (input.startMode === 'scheduled') need(w.autoStart && now >= Date.parse(w.serverScheduledWipeAt || w.musterAt), 'AUTO_START_NOT_DUE');
        next.lifecycle = 'active'; next.phaseEnteredAt = stamp; next.startMode = input.startMode || 'manual';
        // Entering active, even manually, never asserts actual play or server availability.
      } else if (command === 'end') {
        state('active'); need(['completed','aborted','cancelled'].includes(input.outcome), 'OUTCOME_REQUIRED', 422);
        if (input.outcome !== 'completed') reason();
        next.lifecycle = 'ended'; next.outcome = input.outcome; next.endedAt = stamp; next.signupWindow = 'closed';
        next.settlementStatus = 'pending_data'; next.endReason = input.reason || null;
      } else if (command === 'cancel') {
        state('draft','scheduled'); reason(); next.lifecycle = 'cancelled'; next.outcome = 'cancelled'; next.cancelledAt = stamp;
        next.signupWindow = 'closed'; next.endReason = input.reason; next.archiveRevision = 1;
      } else if (command === 'close-signup') {
        state('scheduled','active'); reason(); next.signupWindow = 'closed';
      } else if (command === 'reopen-signup') {
        state('scheduled','active'); reason();
        const closesAt = normalizeTime(input.closesAt, w.timeZone, input.rawTimeInputs?.closesAt);
        need(closesAt && Date.parse(closesAt) > now && Date.parse(closesAt) > Date.parse(w.signupOpensAt), 'SIGNUP_WINDOW_INVALID', 422);
        next.signupClosesAt = closesAt; next.signupWindow = 'open';
      } else if (command === 'confirm-start' || command === 'confirm-server-start') {
        state('active');
        const field = command === 'confirm-start' ? 'actualStartedAt' : 'serverActualWipeAt';
        const evidence = command === 'confirm-start' ? 'startEvidence' : 'serverStartEvidence';
        need(typeof input[evidence] === 'string' && input[evidence].trim() && input[evidence].length <= 2000, 'START_EVIDENCE_REQUIRED', 422);
        next[field] = normalizeTime(input[field], w.timeZone, input.rawTimeInputs?.[field]);
        need(next[field] && Date.parse(next[field]) <= now, 'ACTUAL_TIME_INVALID', 422); next[evidence] = input[evidence];
      } else if (command === 'archive' || command === 'revise-archive') {
        state(command === 'archive' ? 'ended' : 'archived'); reason();
        if (command === 'revise-archive') need(input.baseArchiveRevision === w.archiveRevision, 'REVISION_CONFLICT');
        need(['complete','partial','missing'].includes(input.completeness), 'COMPLETENESS_REQUIRED', 422);
        need(input.data == null || typeof input.data === 'object' && !Array.isArray(input.data) && JSON.stringify(input.data).length <= 500_000, 'SETTLEMENT_INVALID', 422);
        next.lifecycle = 'archived'; next.archiveRevision = (w.archiveRevision || 0) + 1;
        next.settlementStatus = input.completeness === 'complete' ? 'complete' : 'missing_data'; next.archivedAt ||= stamp;
      }
      next.revision++; next.updatedAt = stamp; this.repo.put('wipes', next);
      if (['archive','revise-archive','cancel'].includes(command)) {
        const prior = w.lifecycle === 'archived' && this.repo.get('archives', `${id}:${w.archiveRevision}`);
        const frozen = prior?.roster || this.roster(actor, next, { full: true });
        this.repo.put('archives', { id: `${id}:${next.archiveRevision || 1}`, wipeId: id, archiveRevision: next.archiveRevision || 1,
          kind: command === 'cancel' ? 'cancellation' : 'settlement', wipe: clone(next), roster: frozen,
          completeness: input.completeness || 'not_applicable', data: clone(input.data || {}), reason: input.reason,
          createdAt: stamp, actorAccountId: actor.id, baseArchiveRevision: prior?.archiveRevision || null });
      }
      return this.result(this.record(actor, `wipe.${command}`, next, w, next, key, opts, now, null, { reason: input.reason }), next, false);
    });
  }
  roster(actor, w, options = {}) {
    return rosterReadScope(this, w).evaluateRoster(actor, w, options);
  }
  evaluateRoster(actor, w, { full = false } = {}) {
    const visible = memberId => full || can(actor, 'signups.read', { kind: 'signup', wipeId: w.id, memberId }, this.identity.relations());
    const allMembers = this.identity.repo.all('members');
    const eligible = allMembers.filter(m => {
      if (!this.inAudience(w, m.id)) return false;
      // A five-minute role cache expiry is not a departure. Confirmed role
      // loss is represented by accountAccess's persistent role lock instead.
      try { this.target(m.id, { eligibility: false }); return true; } catch (e) { if (e instanceof IdentityError) return false; throw e; }
    });
    const rows = eligible.filter(m => visible(m.id)).map(m => ({ memberId: m.id,
      displayName: m.displayName || m.customName || m.steamNickname || '', ...this.signup(w, m.id) }));
    const ids = new Set(eligible.map(m => m.id));
    const excludedResponses = this.repo.forWipe('signups', w.id).filter(s => !ids.has(s.memberId) && visible(s.memberId)).map(s => this.signup(w, s.memberId));
    return { rows, excludedResponses, countScope: full || eligible.every(m => visible(m.id)) ? 'audience' : 'authorized_members',
      rosterRevision: this.repo.scalar('v2RosterRevision') + w.revision, contentRevision: w.contentRevision,
      evaluatedAt: new Date(this.now()).toISOString(), scopeVersion: actor.permissionVersion };
  }
  counts(rows) {
    const count = f => rows.filter(f).length;
    const onTime = count(s => s.response === 'attending_on_time'), later = count(s => s.response === 'attending_later');
    const notAttending = count(s => s.response === 'not_attending'), unanswered = count(s => s.response === null);
    const plannedAttending = onTime + later;
    return { eligibleTotal: rows.length, unanswered, onTime, later, notAttending, responseTotal: onTime + later + notAttending,
      plannedAttending, confirmedAttending: plannedAttending, pendingReconfirmationAttending: 0,
      pendingReconfirmation: 0 };
  }
  summary(actor, id) {
    actor = this.actor(actor); const w = this.getWipe(actor, id);
    const snapshot = this.rosterForRead(actor, w);
    return { wipe: w, mySignup: w.mySignup, counts: this.counts(snapshot.rows), countScope: snapshot.countScope,
      scopeVersion: snapshot.scopeVersion, contentRevision: w.contentRevision, rosterRevision: snapshot.rosterRevision,
      excludedResponses: snapshot.excludedResponses.length, evaluatedAt: snapshot.evaluatedAt };
  }
  rosterForRead(actor, w) {
    const archive = w.lifecycle === 'archived' && this.repo.get('archives', `${w.id}:${w.archiveRevision}`);
    if (!archive?.roster) return this.roster(actor, w);
    const visible = s => can(actor, 'signups.read', { kind: 'signup', wipeId: w.id, memberId: s.memberId }, this.identity.relations());
    return { ...archive.roster, rows: archive.roster.rows.filter(visible), excludedResponses: archive.roster.excludedResponses.filter(visible),
      countScope: archive.roster.rows.every(visible) ? 'archived_audience' : 'authorized_archived_members', scopeVersion: actor.permissionVersion };
  }
  listSignups(actor, id, { limit = 50, cursor = '' } = {}) {
    actor = this.actor(actor); const w = this.wipe(id);
    this.authorize(actor, 'wipes.read', { kind: 'wipe', id }, true);
    const snapshot = this.rosterForRead(actor, w), bound = Math.max(1, Math.min(100, Number(limit) || 50));
    const rows = snapshot.rows.sort((a,b) => a.memberId < b.memberId ? -1 : a.memberId > b.memberId ? 1 : 0).filter(r => !cursor || r.memberId > cursor);
    const relations = this.identity.relations();
    const currentSquads = new Map();
    for (const link of relations.squadMembers) if (!link.validTo && !currentSquads.has(link.memberId)) currentSquads.set(link.memberId, link.squadId);
    const squadNames = new Map(this.identity.repo.all('squads').map(squad => [squad.id, squad.name]));
    const items = rows.slice(0,bound).map(row => {
      const member = this.identity.repo.get('members', row.memberId);
      if (!member || member.deletedAt || !can(actor, 'members.read', { kind: 'member', id: row.memberId }, relations))
        return { ...row, canViewProfile: false };
      return { ...row, canViewProfile: true, steamId: member.steamId || '',
        avatar: member.steamAvatar || member.avatar || member.avatarUrl || '',
        specialty: normalizeSpecialties(member.specialty || member.specialties || []),
        squadName: squadNames.get(currentSquads.get(row.memberId)) || '未分队' };
    });
    return { ...snapshot, rows: undefined, excludedResponses: snapshot.excludedResponses.slice(0,100), items,
      counts: this.counts(snapshot.rows), nextCursor: rows.length > bound ? items.at(-1).memberId : null };
  }
  listWipes(actor, { limit = 20, cursor = '' } = {}) {
    actor = this.actor(actor); const bound = Math.max(1, Math.min(100, Number(limit) || 20));
    const rows = this.repo.all('wipes').filter(w => (!cursor || w.id > cursor) && can(actor, 'wipes.read', { kind: 'wipe', id: w.id }, this.identity.relations()));
    const selected = rows.slice(0,bound);
    return { items: selected.map(w => ({ id: w.id, title: w.title, lifecycle: w.lifecycle, outcome: w.outcome, musterAt: w.musterAt,
      serverScheduledWipeAt: w.serverScheduledWipeAt, serverActualWipeAt: w.serverActualWipeAt, timeZone: w.timeZone,
      revision: w.revision, contentRevision: w.contentRevision, signupWindow: this.window(w),
      mySignup: actor.memberId && can(actor, 'signups.read', { kind: 'signup', wipeId: w.id, memberId: actor.memberId }, this.identity.relations())
        ? this.signup(w, actor.memberId) : null })), nextCursor: rows.length > bound ? selected.at(-1).id : null };
  }
  getOperation(actor, operationId) {
    actor = this.actor(actor); const receipt = this.repo.get('receipts', hash([actor.id, operationId])); need(receipt, 'RESOURCE_NOT_FOUND', 404);
    const w = this.wipe(receipt.wipeId);
    if (receipt.memberId) {
      this.accessSignup(actor, w, receipt.memberId, { delegate: receipt.delegate, write: true });
      if (receipt.overrideClosed) this.authorize(actor, 'signups.override_closed', { kind: 'signup', wipeId: w.id, memberId: receipt.memberId });
    }
    else this.authorize(actor, 'wipes.read', { kind: 'wipe', id: w.id }, true);
    return this.result(receipt, receipt.memberId ? this.signup(w, receipt.memberId) : w, true);
  }
  getArchive(actor, id, revision) {
    actor = this.actor(actor); this.getWipe(actor, id); const row = this.repo.get('archives', `${id}:${revision}`);
    need(row, 'RESOURCE_NOT_FOUND', 404); this.authorize(actor, 'wipes.archive', { kind: 'wipe', id }, true);
    // Raw settlement data may describe every frozen member; partial readers use the projected summary/list instead.
    const records = row.roster ? [...row.roster.rows, ...row.roster.excludedResponses] : this.repo.forWipe('signups', id);
    for (const record of records) this.authorize(actor, 'signups.read', { kind: 'signup', wipeId: id, memberId: record.memberId }, true);
    this.authorize(actor, 'stats.read', { kind: 'wipe', id }, true);
    return row;
  }
  // Internal runtime sweep: published plans enter active at server start even when
  // the optional earlier muster-time start is disabled. This is not play evidence.
  advanceDueWipes() {
    return this.repo.transaction(() => {
      const now = this.now(), stamp = new Date(now).toISOString(), changed = [];
      const actor = { id: 'system:scheduling' };
      for (const w of this.repo.all('wipes')) {
        if (w.lifecycle !== 'scheduled') continue;
        const times = [w.serverScheduledWipeAt || w.musterAt]
          .map(value => Date.parse(value)).filter(Number.isFinite);
        const dueAt = Math.min(...times);
        if (dueAt > now) continue;
        try { this.ready(w); } catch (error) {
          if (error.errorCode === 'WIPE_INCOMPLETE') continue;
          throw error;
        }
        const opts = { operationId: `auto-start:${w.id}:${w.revision}`, source: 'scheduler' };
        const key = this.receipt(actor, opts.operationId, 'wipe.start', w.id, null, { dueAt });
        const next = { ...w, lifecycle: 'active', startMode: 'scheduled',
          phaseEnteredAt: new Date(dueAt).toISOString(), revision: w.revision + 1, updatedAt: stamp };
        this.repo.put('wipes', next);
        this.record(actor, 'wipe.start', next, w, next, key, opts, now);
        changed.push(next.id);
      }
      return changed;
    });
  }
  advanceScheduled(actor) {
    return this.repo.all('wipes').filter(w => w.lifecycle === 'scheduled' && w.autoStart && Date.parse(w.serverScheduledWipeAt || w.musterAt) <= this.now())
      .filter(w => can(actor, 'wipes.start', { kind: 'wipe', id: w.id }, this.identity.relations()))
      .map(w => this.transition(actor, w.id, 'start', { expectedRevision: w.revision, startMode: 'scheduled' },
        { operationId: `auto-start:${w.id}:${w.revision}`, source: 'scheduler' }));
  }
}
