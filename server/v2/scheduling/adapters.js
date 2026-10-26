import { digest, randomToken } from '../identity/contexts.js';
import { IdentityError, requireValue } from '../identity/errors.js';
import { hash } from './service.js';

const CONFIRMATION_TTL = 300_000;
const responses = new Set(['attending_on_time', 'attending_later', 'not_attending']);
const version = value => Number.isSafeInteger(value) && value > 0;
const identifier = value => typeof value === 'string' && value.length > 0 && value.length <= 160 && !/[\x00-\x20\x7f]/.test(value);
const confirmationUrl = wipeId => `/app/wipes/${encodeURIComponent(wipeId)}?tab=plan#signup`;
const actionResponse = action => action === 'withdraw' ? null : ['join_8h','join_16h'].includes(action) ? 'attending_later' : responses.has(action) ? action : undefined;

// These functions do not send HTTP responses. The V2 router supplies the envelope,
// and its G03 identity middleware remains the only source of Web authentication.
export function createWebAdapter(service) {
  async function authenticate(req, mutation = false) {
    requireValue(typeof req?.v2Identity?.authenticate === 'function', 'AUTH_REQUIRED', 401);
    const { actor } = await req.v2Identity.authenticate(mutation ? { mutation: true } : undefined);
    requireValue(actor?.id, 'AUTH_REQUIRED', 401);
    return actor;
  }
  return Object.freeze({
    async getWipe(req, wipeId) {
      return service.getWipe(await authenticate(req), wipeId);
    },
    async getSignup(req, wipeId, memberId) {
      const actor = await authenticate(req);
      return service.getSignup(actor, wipeId, memberId ?? actor.memberId);
    },
    async saveSignup(req, wipeId, memberId, input = req.body) {
      const actor = await authenticate(req, true);
      const subject = memberId ?? actor.memberId;
      const options = { operationId: req.get('Idempotency-Key'), source: 'web', delegate: subject !== actor.memberId };
      if (service.prepareSignupTarget) await service.prepareSignupTarget(actor, wipeId, subject, options);
      return service.saveSignup(actor, wipeId, subject, input, options);
    }
  });
}

/**
 * verify(envelope) must verify the platform signature over the actual callback
 * body (Discord/KOOK), or validate a server-side mini-program session (WeChat).
 * It returns {provider, externalId, interactionId, payload}; every payload field
 * must come from that authenticated request, never a second unverified body.
 * It must also verify the public card's signature/server reference. Identity
 * lookup below is mapping only. There are deliberately no production senders.
 *
 * submit payload kinds:
 * public: {adapterVersion:2,wipeId,contentRevision,action,timeZone,expectedArrivalAt?}
 * legacy: {adapterVersion:1,wipeId,legacyStatus,legacyToggle?,skipMeansNotAttending?}
 * direct-v2: {adapterVersion:2,wipeId,memberId?,input:{...explicit versions}}
 * confirm: {contextToken,input?:{expectedArrivalAt,timeZone}}
 *
 * A confirmation_required result MUST be delivered only to its authenticated
 * actor (ephemeral message/private view), including the returned bearer token.
 * Persisted contexts preserve retry support across process restarts; tokens are
 * stored only as hashes. Versions belong to the displayed confirmation, never
 * to a fresh read performed during its submission.
 */
export function createPlatformAdapter({ provider, identity, service, verify, now = Date.now }) {
  requireValue(provider === 'discord' || provider === 'kook' || /^wechat:[A-Za-z0-9_-]+$/.test(provider),
    'PLATFORM_PROVIDER_INVALID', 422);
  requireValue(typeof verify === 'function', 'PLATFORM_VERIFIER_REQUIRED', 503);
  const source = provider.startsWith('wechat:') ? 'wechat' : provider;
  async function saveSignup(actor, wipeId, memberId, input, options) {
    if (service.prepareSignupTarget) await service.prepareSignupTarget(actor, wipeId, memberId, options);
    return service.saveSignup(actor, wipeId, memberId, input, options);
  }

  async function authenticate(envelope) {
    const verified = await verify(envelope);
    requireValue(verified && verified.provider === provider && identifier(verified.externalId) && identifier(verified.interactionId),
      'PLATFORM_AUTH_INVALID', 401);
    const operationId = `${provider}:${verified.interactionId}`;
    requireValue(/^[A-Za-z0-9:_-]{1,200}$/.test(operationId), 'PLATFORM_AUTH_INVALID', 401);
    const mapping = identity.identity(provider, verified.externalId);
    requireValue(mapping?.accountId, 'IDENTITY_BINDING_REQUIRED', 403);
    // Read current account/restrictions both before and after external I/O.
    identity.actorForAccount(mapping.accountId);
    if (provider === 'discord' || provider === 'kook') await identity.checkEligibility(provider, verified.externalId);
    const current = identity.identity(provider, verified.externalId);
    requireValue(current?.accountId === mapping.accountId, 'IDENTITY_CONFLICT', 409);
    const actor = identity.actorForAccount(current.accountId);
    return { actor, operationId, payload: verified.payload };
  }

  function command(action, payload = {}) {
    const response = actionResponse(action);
    requireValue(response !== undefined, 'SIGNUP_ACTION_INVALID', 422);
    return { response, expectedArrivalAt: response === 'attending_later' ? payload.expectedArrivalAt ?? null : null,
      timeZone: payload.timeZone || 'UTC' };
  }

  async function issueConfirmation(actor, wipeId, action, proposed, detail = {}) {
    const wipe = await service.getWipe(actor, wipeId);
    const current = await service.getSignup(actor, wipeId, actor.memberId);
    const token = randomToken();
    const input = { ...proposed, expectedSignupRevision: current.signupRevision,
      confirmedContentRevision: wipe.contentRevision };
    const context = { id: digest(token), provider, actorAccountId: actor.id, memberId: actor.memberId, wipeId,
      action, input, needsArrivalInput: input.response === 'attending_later' && !input.expectedArrivalAt,
      createdAt: new Date(now()).toISOString(), expiresAt: now() + CONFIRMATION_TTL };
    service.repo.put('signupContexts', context);
    return { status: 'confirmation_required', privacy: 'actor_only', actorAccountId: actor.id,
      confirmationUrl: confirmationUrl(wipeId), confirmation: { contextToken: token, wipe, current,
        action, proposedInput: input, needsArrivalInput: context.needsArrivalInput,
        expiresAt: new Date(context.expiresAt).toISOString(), ...detail } };
  }

  async function confirm(actor, operationId, payload) {
    requireValue(typeof payload.contextToken === 'string' && /^[A-Za-z0-9_-]{43}$/.test(payload.contextToken),
      'SIGNUP_CONFIRMATION_INVALID', 401);
    const context = service.repo.get('signupContexts', digest(payload.contextToken));
    requireValue(context, 'SIGNUP_CONFIRMATION_EXPIRED', 410);
    requireValue(context.provider === provider && context.actorAccountId === actor.id && context.memberId === actor.memberId,
      'SIGNUP_CONFIRMATION_INVALID', 403);
    const submitted = payload.input || {};
    requireValue(submitted && typeof submitted === 'object' && !Array.isArray(submitted) &&
      Object.keys(submitted).every(key => context.needsArrivalInput && ['expectedArrivalAt', 'timeZone'].includes(key)),
    'SIGNUP_CONFIRMATION_INVALID', 422);
    const input = { ...context.input, ...submitted };
    if (context.expiresAt <= now()) {
      // Only an already committed operation may pass the expired-context gate.
      // The shared write service still checks its digest and current permission.
      try { await service.getOperation(actor, operationId); }
      catch (error) {
        if (error.status !== 404) throw error;
        throw new IdentityError('SIGNUP_CONFIRMATION_EXPIRED', 410,
          { confirmationUrl: confirmationUrl(context.wipeId) });
      }
    }
    return saveSignup(actor, context.wipeId, context.memberId, input, { operationId, source, delegate: false });
  }

  async function submit(envelope) {
    const { actor, operationId, payload } = await authenticate(envelope);
    requireValue(payload && typeof payload === 'object' && !Array.isArray(payload), 'PLATFORM_PAYLOAD_INVALID', 422);
    if (payload.kind === 'confirm') return confirm(actor, operationId, payload);
    requireValue(identifier(payload.wipeId), 'WIPE_REQUIRED', 422);
    const requireAdapterVersion = condition => {
      if (!condition) throw new IdentityError('ADAPTER_VERSION_UNSUPPORTED', 409,
        { confirmationUrl: confirmationUrl(payload.wipeId) });
    };
    if (payload.kind === 'direct-v2') {
      requireAdapterVersion(payload.adapterVersion === 2);
      const subject = payload.memberId ?? actor.memberId;
      return saveSignup(actor, payload.wipeId, subject, payload.input,
        { operationId, source, delegate: subject !== actor.memberId });
    }
    // Public/legacy cards can affect the authenticated member only. A privileged
    // actor without a verified member uses an explicit direct-v2 delegate command.
    if (provider === 'kook') requireValue(actor.memberId, 'IDENTITY_BINDING_REQUIRED', 403);
    identity.assertMemberParticipation(actor);
    if (payload.kind === 'legacy') {
      requireAdapterVersion(payload.adapterVersion === undefined || payload.adapterVersion === 1);
      const mapping = { join: 'attending_on_time', join_8h: 'attending_later', join_16h: 'attending_later', late: 'attending_later',
        ...(payload.skipMeansNotAttending === true ? { skip: 'not_attending' } : {}) };
      let action = mapping[payload.legacyStatus];
      if (!action) {
        await service.getWipe(actor, payload.wipeId);
        return { status: 'confirmation_required', privacy: 'actor_only', actorAccountId: actor.id,
          reasonCode: 'LEGACY_ACTION_UNSUPPORTED', confirmationUrl: confirmationUrl(payload.wipeId) };
      }
      if (payload.legacyToggle === true) {
        const current = await service.getSignup(actor, payload.wipeId, actor.memberId);
        const exactOption = action !== 'attending_later' || current.legacyRawStatus === payload.legacyStatus;
        if (current.response === action && exactOption) action = 'withdraw';
      }
      return issueConfirmation(actor, payload.wipeId, action, command(action, { timeZone: payload.timeZone }),
        { legacyRawStatus: payload.legacyStatus, legacyTimeUnknown: ['join_8h', 'join_16h', 'late'].includes(payload.legacyStatus) });
    }
    requireAdapterVersion(payload.kind === 'public' && payload.adapterVersion === 2);
    if (!version(payload.contentRevision)) throw new IdentityError('CONTENT_REVISION_REQUIRED', 422,
      { confirmationUrl: confirmationUrl(payload.wipeId) });
    if (payload.action === 'withdraw')
      return issueConfirmation(actor, payload.wipeId, 'withdraw', command('withdraw', { timeZone: payload.timeZone }));
    let expectedArrivalAt = payload.expectedArrivalAt;
    if (['join_8h','join_16h'].includes(payload.action)) {
      const wipe = await service.getWipe(actor, payload.wipeId);
      const start = Date.parse(wipe.actualStartedAt || wipe.serverScheduledWipeAt || wipe.musterAt || '');
      const hours = payload.action === 'join_8h' ? 8 : 16;
      requireValue(Number.isFinite(start) && start + hours * 3_600_000 > now(), 'ARRIVAL_TIME_INVALID', 422);
      expectedArrivalAt = new Date(start + hours * 3_600_000).toISOString();
    }
    const input = { ...command(payload.action, { ...payload, expectedArrivalAt }), expectedSignupRevision: 0,
      confirmedContentRevision: payload.contentRevision };
    if (input.response === 'attending_later' && !input.expectedArrivalAt)
      return issueConfirmation(actor, payload.wipeId, payload.action, input);
    const directKook = provider === 'kook' && ['attending_on_time', 'not_attending'].includes(payload.action);
    if (directKook) {
      const receipt = service.repo.get('receipts', hash([actor.id, operationId]));
      if (receipt) {
        const priorRevision = receipt.operationReceipt?.signupRevision - 1;
        const priorInput = { ...input, expectedSignupRevision: priorRevision };
        requireValue(Number.isSafeInteger(priorRevision) && priorRevision >= 0 && receipt.digest === hash({
          action: 'signup.self', wipeId: payload.wipeId, memberId: actor.memberId, input: priorInput
        }), 'IDEMPOTENCY_CONFLICT', 409);
        return service.getOperation(actor, operationId);
      }
    }
    try {
      // Keep this attempt before any current-slot gate: a completed interaction
      // must reach the receipt lookup even after another client changes the slot.
      return await saveSignup(actor, payload.wipeId, actor.memberId, input, { operationId, source, delegate: false });
    } catch (error) {
      if (!['REVISION_CONFLICT', 'CONTENT_RECONFIRM_REQUIRED'].includes(error.errorCode)) throw error;
      if (directKook && error.errorCode === 'REVISION_CONFLICT') {
        const current = await service.getSignup(actor, payload.wipeId, actor.memberId);
        if (current.response === input.response) return { status: 'already_current', current };
        try {
          return await saveSignup(actor, payload.wipeId, actor.memberId,
            { ...input, expectedSignupRevision: current.signupRevision }, { operationId, source, delegate: false });
        } catch (retryError) {
          if (!['REVISION_CONFLICT', 'CONTENT_RECONFIRM_REQUIRED'].includes(retryError.errorCode)) throw retryError;
        }
      }
      return issueConfirmation(actor, payload.wipeId, payload.action, input, { reasonCode: error.errorCode });
    }
  }

  return Object.freeze({ submit,
    async getWipe(envelope, wipeId) {
      const { actor } = await authenticate(envelope);
      return service.getWipe(actor, wipeId);
    },
    async getSignup(envelope, wipeId) {
      const { actor } = await authenticate(envelope);
      return service.getSignup(actor, wipeId, actor.memberId);
    }
  });
}
