import {createRetainedInteractions} from './retained.js';
import {isCommunityProof,assertCommunityProof} from '../../notification-platforms/community-proof.js';
import express from 'express';
import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import { digest } from '../../identity/contexts.js';
import { authorize } from '../../identity/permissions.js';
import { hashPayload } from '../../notification-platforms/canonical.js';
import { IdentityError } from '../../identity/errors.js';
import { createMemberInboxDomainAdapters } from '../../member-inbox/index.js';
import { createPlatformMediaDomainAdapters } from '../../platform-media/index.js';
import { createPlatformMediaRouter } from '../../platform-media/routes.js';
import { createCommunityAvatar } from './community-avatar.js';
import { createMiniProgramAdapter, MINI_DOMAIN_COMMANDS, MINI_RETIRED_COMMANDS } from '../../platform-admin/mini-program.js';
import { createMiniProgramRouter, createPlatformAdminRouter, createWechatLinkRouter, sendError } from '../../platform-admin/routes.js';
import { createLegacyMiniProgramRouter } from '../../platform-admin/legacy-mini.js';
import { createCommunityAdapter } from '../../platform-admin/community.js';
import { createForwardingAdapter, resolveForwardRoute } from '../../platform-admin/forwarding.js';
import { createPlatformCards, createG06MessageGateway } from '../../platform-admin/cards.js';
import { need, identifier, hash as platformHash } from '../../platform-admin/model.js';
import { createPlatformDomainAdapters } from './domains.js';
import { createQueuedMiniSessions, createPlatformSessionInvalidator } from './sessions.js';
import { createPlatformHostLifecycle } from './lifecycle.js';
import { createWechatLinkService } from './wechat-link.js';
export { createPlatformSessionInvalidator } from './sessions.js';

export const DOMAIN_GAPS = Object.freeze({
  avatar: 'PROFILE_MEDIA_OWNER_REQUIRED', avatar_image: 'PROFILE_MEDIA_OWNER_REQUIRED', share_code: 'WECHAT_SHARE_OWNER_REQUIRED',
  notification_settings: 'MEMBER_NOTIFICATION_INBOX_OWNER_REQUIRED', notification_settings_save: 'MEMBER_NOTIFICATION_INBOX_OWNER_REQUIRED',
  notifications: 'MEMBER_NOTIFICATION_INBOX_OWNER_REQUIRED', notification_read: 'MEMBER_NOTIFICATION_INBOX_OWNER_REQUIRED',
  application: 'SELF_APPLICATION_SERVICE_REQUIRED', application_submit: 'SELF_APPLICATION_SERVICE_REQUIRED', application_edit: 'SELF_APPLICATION_SERVICE_REQUIRED',
  summary: 'ADMIN_SUMMARY_SERVICE_REQUIRED', server_save: 'SERVER_CONFIGURATION_SERVICE_REQUIRED'
});

/** Install adapters on ONE injected PlatformAdminService. Do not mount adminRouter
 * alongside management's original platform router; either route to this service
 * with runOperation, or replace that one router. No migrations or timers here. */
export function createPlatformHost({ identity, scheduling, memberSpace, members, memberBundle, stats, sync,
  platformService, runStoreWriteTask, patchStoreCache, replayMemberOutbox, assertInvalidationReady,
  wechat, community: communityOptions = {}, forwarding: forwardingOptions, g06,
  notifications, system, inbox, media, adminExtras, executeStatsJob, now = identity?.now || Date.now, timeoutMs = 10000 }) {
  need(identity?.repo?.db && typeof runStoreWriteTask === 'function' && typeof patchStoreCache === 'function', 'PLATFORM_HOST_DEPENDENCIES_REQUIRED', 503);
  for (const service of [scheduling, memberSpace, members, stats, sync, platformService])
    need(service?.identity === identity && service.repo?.db === identity.repo.db, 'PLATFORM_HOST_IDENTITY_MISMATCH', 503);
  for (const service of [notifications, system].filter(Boolean)) need(service.identity === identity, 'PLATFORM_HOST_IDENTITY_MISMATCH', 503);
  need(memberBundle?.identity === identity && memberBundle.lifecycle?.identity === identity && typeof memberBundle.writeDomain === 'function', 'MEMBER_HOST_REQUIRED', 503);
  need(typeof assertInvalidationReady === 'function', 'PLATFORM_INVALIDATOR_BINDING_REQUIRED', 503);
  const lifecycle = createPlatformHostLifecycle({ timeoutMs, replayMemberOutbox: async () => {
    need(assertInvalidationReady() === true, 'PLATFORM_INVALIDATOR_BINDING_REQUIRED', 503);
    need(typeof replayMemberOutbox === 'function', 'PLATFORM_OUTBOX_DRAIN_REQUIRED', 503);
    await replayMemberOutbox();
    need(assertInvalidationReady() === true, 'PLATFORM_INVALIDATOR_BINDING_REQUIRED', 503);
  } });
  const invalidator = createPlatformSessionInvalidator({ identity });
  const domains = createPlatformDomainAdapters({ identity, scheduling, memberSpace, members, memberBundle, stats, sync,
    runStoreWriteTask, patchStoreCache, executeStatsJob, notifications, system });
  if (inbox) {
    need(inbox.appId === wechat?.appId, 'INBOX_APP_MISMATCH', 503);
    domains.mini.notifications = createMemberInboxDomainAdapters({ service: inbox, identity }).mini.notifications;
  }
  if (media) Object.assign(domains.mini.profile, createPlatformMediaDomainAdapters(media).profile);

  if (adminExtras) {
    need(adminExtras.service?.identity === identity, 'PLATFORM_HOST_IDENTITY_MISMATCH', 503);
    for (const [namespace, methods] of Object.entries(adminExtras.miniAdapters)) Object.assign(domains.mini[namespace] ||= {}, methods);
  }
  const miniScope = new AsyncLocalStorage();
  const scopedScheduling = Object.create(scheduling);
  // External eligibility is refreshed BEFORE entering the store queue. The base
  // G04 adapter's second prepare is a synchronous current-authority check only.
  scopedScheduling.prepareSignupTarget = (actor, id, memberId, options) => {
    miniScope.getStore()();
    scheduling.accessSignup(scheduling.actor(actor), scheduling.wipe(id), memberId, { ...options, write: true });
  };
  const miniConfig = () => wechat?.readConfig?.() || { enabled: false };
  const appId = wechat?.appId || 'unconfigured';
  const raw = createMiniProgramAdapter({ identity, scheduling: scopedScheduling, appId, readConfig: miniConfig,
    exchangeCode: wechat?.exchangeCode, adapters: domains.mini, now });
  const auth = (envelope, options) => { lifecycle.assertReady(); return raw.authenticate(envelope, options); };
  const wechatLink = createWechatLinkService({ identity, appId, legacyAppId: wechat?.legacyAppId, authenticate: auth, runStoreWriteTask, patchStoreCache, lifecycle, readConfig: miniConfig, now, sessionTtlMs: wechat?.sessionTtlMs });
  const sessionFence = envelope => {
    const initial = auth(envelope), digest = identity.scopeDigest(initial.actor);
    return () => {
      const current = auth(envelope);
      need(identity.scopeDigest(current.actor) === digest, 'PERMISSIONS_CHANGED', 401);
      return current.actor;
    };
  };
  const session = createQueuedMiniSessions({ identity, appId, exchangeCode: wechat?.exchangeCode, readConfig: miniConfig, raw,
    lifecycle, invalidator, runStoreWriteTask, now, sessionTtlMs: wechat?.sessionTtlMs });
  const communityAvatar = createCommunityAvatar({ identity, memberSpace, authenticate: auth, fetchImage: wechat?.fetchCommunityAvatar, now });
  const mini = {
    authenticate: auth,
    wechatLink,
    communityAvatar,
    capabilities: () => ({ ...raw.capabilities(), host: lifecycle.diagnostics().state,
      websiteOAuth: { state: wechat?.exchangeCode && miniConfig().enabled && lifecycle.diagnostics().state === 'ready' ? 'available' : 'unavailable', method: 'kook_website_confirmation' },
      login: { state: wechat?.exchangeCode && miniConfig().enabled && lifecycle.diagnostics().state === 'ready' ? 'adapter_ready' : 'unavailable',
        realAuthentication: 'unverified', evidenceLevel: wechat?.evidenceLevel === 'isolated' ? 'isolated' : 'not_asserted' },
      commands: Object.entries(MINI_DOMAIN_COMMANDS).map(([id, [domain, method]]) => ({ id,
        available: Boolean(domains.mini[domain]?.[method]), reasonCode: domains.mini[domain]?.[method] ? null : (DOMAIN_GAPS[id] || 'PLATFORM_ADAPTER_UNAVAILABLE') })) }),
    ...session,
    wipe: (envelope, id) => lifecycle.track(async () => { const assertCurrent = sessionFence(envelope); need(id !== 'current', 'EXPLICIT_WIPE_REQUIRED', 409); const r = await raw.wipe(envelope, id); assertCurrent(); return r; }),
    submit: envelope => lifecycle.track(async () => {
      const assertCurrent = sessionFence(envelope), actor = assertCurrent(), payload = envelope.payload;
      need(payload && !Object.hasOwn(payload, 'actor') && !Object.hasOwn(payload, 'accountId'), 'CLIENT_ACTOR_FORBIDDEN', 403);
      need(!payload.memberId || payload.memberId === actor.memberId, 'MINI_SELF_SIGNUP_ONLY', 403);
      let wipeId = payload.wipeId;
      if (payload.kind === 'confirm') {
        const token = payload.contextToken;
        need(typeof token === 'string' && /^[A-Za-z0-9_-]{43}$/.test(token), 'SIGNUP_CONFIRMATION_INVALID', 401);
        const context = scheduling.repo.get('signupContexts', digest(token));
        need(context?.actorAccountId === actor.id && context.provider === `wechat:${appId}`, 'SIGNUP_CONFIRMATION_INVALID', 403);
        wipeId = context.wipeId;
      }
      need(wipeId && wipeId !== 'current', 'EXPLICIT_WIPE_REQUIRED', 409);
      await scheduling.prepareSignupTarget(actor, wipeId, actor.memberId, { delegate: false });
      return runStoreWriteTask(() => miniScope.run(assertCurrent, async () => {
        assertCurrent(); const result = await raw.submit(envelope); assertCurrent(); return result;
      }));
    }),
    command: (envelope, command, input) => lifecycle.track(async () => {
      need(!MINI_RETIRED_COMMANDS.has(command), 'MINI_MANAGEMENT_RETIRED', 410);
      const assertCurrent = sessionFence(envelope), actor = assertCurrent();
      need(input && typeof input === 'object' && !Array.isArray(input), 'PLATFORM_INPUT_INVALID', 422);
      need(!Object.hasOwn(input, 'actor') && !Object.hasOwn(input, 'accountId'), 'CLIENT_ACTOR_FORBIDDEN', 403);
      need(Object.hasOwn(MINI_DOMAIN_COMMANDS, command), 'MINI_COMMAND_UNSUPPORTED', 404);
      const [domain, method] = MINI_DOMAIN_COMMANDS[command], fn = domains.mini[domain]?.[method];
      need(typeof fn === 'function', DOMAIN_GAPS[command] || 'PLATFORM_ADAPTER_UNAVAILABLE', 503);
      identifier(envelope.operationId);
      // The frozen mini factory guesses an account resource for collection
      // requests. Dispatch to the domain's own scoped service instead: SQL scope
      // before pagination, signup resources, query source and current-wipe scope.
      const cleaned = Object.fromEntries(Object.entries(input).filter(([, value]) => value !== undefined));
      need(cleaned.wipeId !== 'current', 'EXPLICIT_WIPE_REQUIRED', 409);
      const subject = () => {
        const current = auth(envelope);
        return { verified: true, appId: current.session.appId, externalId: current.session.externalId, accountId: current.actor.id };
      };
      const result = await fn({ actor, input: cleaned, operationId: envelope.operationId, assertCurrent, subject, source: 'wechat' });
      assertCurrent(); return result;
    })
  };
  // Ensure login returns the host's actual command/external evidence state.
  const login = mini.login;
  mini.login = async input => { const result = await login(input); return { ...result, profile: wechatLink.profile({ token: result.token }), capabilities: mini.capabilities() }; };

  let messages;
  if (g06?.platforms && typeof g06.targets === 'function') {
    const gateway = createG06MessageGateway(g06);
    messages = Object.fromEntries(['publish', 'edit', 'reconcile'].map(method => [method, args => lifecycle.io(async context => {
      if (method === 'reconcile') {
        const key = args.operationId?.startsWith('forward:') && args.operationId.slice(8);
        const record = key && platformService.repo.get('forward', key);
        need(record, 'RESOURCE_NOT_FOUND', 404);
        const route = resolveForwardRoute(platformService.config('bridge'), record, key);
        const target = g06.targets().filter(t => t.enabled !== false && t.platform === record.to && t.channelId === record.destination && t.guildId === route[`${record.to}GuildId`]);
        need(target.length === 1, 'PLATFORM_TARGET_SCOPE_MISMATCH', 403);
        return gateway.reconcile({ ...context, record });
      }
      const targets = g06.targets().filter(target => target.enabled !== false && target.platform === args.platform && target.channelId === args.channelId);
      need(targets.length === 1 && (!args.guildId || args.guildId === targets[0].guildId) && (!args.targetId || args.targetId === targets[0].id), 'PLATFORM_TARGET_SCOPE_MISMATCH', 403);
      need(typeof g06.platforms[args.platform]?.[method === 'publish' ? 'send' : 'edit'] === 'function', 'PLATFORM_ADAPTER_UNAVAILABLE', 503);
      return gateway[method](context);
    }, args)]));
  }
  const forwarding = createForwardingAdapter({ db: identity.repo.db, now, timeoutMs, messages,
    source: forwardingOptions?.source ? Object.fromEntries(['read', 'reset'].filter(key => typeof forwardingOptions.source[key] === 'function')
      .map(key => [key, args => lifecycle.io(a => forwardingOptions.source[key](a), args)])) : undefined,
    translate: forwardingOptions?.translate ? args => lifecycle.io(forwardingOptions.translate, args) : undefined });
  const cards = createPlatformCards({ identity, scheduling, stats, messages, notifications, platformService, runStoreWriteTask, now });
  const adapters = { ...domains.platform,
    cards: { preview: cards.preview, ...(notifications ? { publish: cards.publish, refresh: cards.refresh, receipt: cards.receipt } : {}) },
    ...(messages ? { forwarding: Object.fromEntries([...(forwardingOptions?.source?.read ? ['run'] : []), ...(forwardingOptions?.source?.reset ? ['reset'] : []), 'reconcile']
      .map(method => [method, args => lifecycle.track(() => {
        const bindings = new Map();
        const assertCurrent = () => {
          const actor = args.assertCurrent();
          let routes;
          if (method === 'reconcile') {
            need(Object.keys(args.input).every(key => ['recordId', 'expectedRevision'].includes(key)), 'FORWARD_RECONCILE_INPUT_INVALID', 422);
            identifier(args.input.recordId);
            const record = platformService.repo.get('forward', args.input.recordId);
            need(record, 'RESOURCE_NOT_FOUND', 404);
            routes = [resolveForwardRoute(platformService.config('bridge'), record, args.input.recordId)];
            const destination = g06.targets().filter(t => t.enabled !== false && t.platform === record.to && t.channelId === record.destination && t.guildId === routes[0][`${record.to}GuildId`]);
            need(destination.length === 1, 'PLATFORM_TARGET_SCOPE_MISMATCH', 403);
            authorize(identity.actorForAccount(actor?.id || args.actor.id), 'notifications.reconcile', { kind: 'platformTarget', id: destination[0].id }, identity.relations());
          } else routes = args.config.routes.filter(r => r.enabled && (!args.input.routeId || r.id === args.input.routeId));
          for (const route of routes) for (const platform of ['discord', 'kook']) {
            const targets = g06.targets().filter(t => t.enabled !== false && t.platform === platform && t.channelId === route[`${platform}ChannelId`]);
            need(targets.length === 1 && targets[0].guildId === route[`${platform}GuildId`], 'PLATFORM_TARGET_SCOPE_MISMATCH', 403);
            const key = `${route.id}:${platform}`, signature = hashPayload(targets[0]);
            need(!bindings.has(key) || bindings.get(key) === signature, 'PLATFORM_TARGET_CHANGED', 409);
            bindings.set(key, signature);
          }
          return actor;
        };
        assertCurrent(); return forwarding[method]({ ...args, assertCurrent });
      })])) } : {}) };

  // Replace owned namespaces (no stale sender survives missing G06 authority).
  // Root's vault, identity policy and platform verification remain their owners.
  for (const key of ['members', 'scheduling', 'stats', 'sync', 'queries', 'cards', 'forwarding']) {
    if (adapters[key]) platformService.adapters[key] = adapters[key];
    else delete platformService.adapters[key];
  }
  // execute() may return an operation receipt before dispatching its adapter.
  // Protect that fast path and the receipt endpoint with the same saved-record scope.
  const reconcileAccess = (actor, recordId) => {
    lifecycle.assertReady(); platformService.actor(actor, 'bridge', true); identifier(recordId);
    const record = platformService.repo.get('forward', recordId);
    need(record, 'RESOURCE_NOT_FOUND', 404);
    const route = resolveForwardRoute(platformService.config('bridge'), record, recordId);
    for (const platform of ['discord', 'kook']) {
      const targets = g06?.targets?.().filter(t => t.enabled !== false && t.platform === platform && t.channelId === route[`${platform}ChannelId`] && t.guildId === route[`${platform}GuildId`]) || [];
      need(targets.length === 1, 'PLATFORM_TARGET_SCOPE_MISMATCH', 403);
      if (platform === record.to) authorize(identity.actorForAccount(actor.id), 'notifications.reconcile', { kind: 'platformTarget', id: targets[0].id }, identity.relations());
    }
  };
  const executePlatform = platformService.execute.bind(platformService), readPlatformReceipt = platformService.receipt.bind(platformService);
  platformService.execute = (actor, platform, action, input, options) => {
    if (action === 'forward_reconcile') reconcileAccess(actor, input.recordId);
    return executePlatform(actor, platform, action, input, options);
  };
  platformService.receipt = (actor, operationId) => {
    const operation = platformService.repo.get('operation', operationId);
    if (operation?.action === 'forward_reconcile') {
      need(operation.actorId === actor.id, 'RESOURCE_NOT_FOUND', 404);
      const linked = platformService.repo.get('forward-reconcile', platformHash([actor.id, operationId]));
      reconcileAccess(actor, linked?.recordId || operation.result?.reference);
    }
    return readPlatformReceipt(actor, operationId);
  };
  const retained=createRetainedInteractions({identity,notifications,cards,scheduling,updateVip:domains.community.members.updateVip,runStoreWriteTask,now});
  const community = {};
  for (const platform of ['discord', 'kook']) {
    const option = communityOptions[platform], context = new AsyncLocalStorage(), scopedIdentity = Object.create(identity);
    scopedIdentity.actorForAccount = id => { context.getStore().assertCurrent(); return identity.actorForAccount(id); };
    scopedIdentity.checkEligibility = async (...args) => {
      context.getStore().assertCurrent(); const result = await identity.checkEligibility(...args); context.getStore().assertCurrent(); return result;
    };
    const adapter = createCommunityAdapter({ platform, identity: scopedIdentity, now,
      readConfig: () => platformService.config(platform),
      verify: async envelope => {
        const state = context.getStore();
        const proof = isCommunityProof(envelope) ? assertCommunityProof(envelope,platform) : await lifecycle.io(args => { need(typeof option?.verify==='function','PLATFORM_ADAPTER_UNAVAILABLE',503); return option.verify(envelope,args); }, { assertCurrent: state.assertCurrent });
        need(proof?.payload && !Object.hasOwn(proof.payload, 'actor') && !Object.hasOwn(proof.payload, 'accountId'), 'CLIENT_ACTOR_FORBIDDEN', 403);
        const mapping = identity.identity(platform, proof.externalId);
        if (mapping) { state.accountId = mapping.accountId; state.version = identity.actorForAccount(mapping.accountId).permissionVersion; }
        return proof;
      },
      queries: adapters.queries, stats: adapters.stats, scheduling: adapters.scheduling, interactions:retained,
      members: { updateVip: args => domains.community.members.updateVip({ ...args,
        input: Object.fromEntries(Object.entries(args.input).filter(([key]) => key !== 'command')) }) } });
    community[platform] = { handle: envelope => lifecycle.track(() => {
      const generation = invalidator.capture(), state = {};
      state.assertCurrent = () => { lifecycle.assertReady(); invalidator.assertCurrent(generation);
        if (state.accountId) need(identity.actorForAccount(state.accountId).permissionVersion === state.version, 'PERMISSIONS_CHANGED', 401); };
      return context.run(state, async () => { const result = await adapter.handle(envelope); state.assertCurrent(); return result; });
    }) };
  }
  for (const platform of ['discord','kook']) community[platform].handleVerified = proof => { assertCommunityProof(proof,platform); return community[platform].handle(proof); };
  const miniRouter = createMiniProgramRouter({ adapter: mini });
  const wechatLinkRouter = createWechatLinkRouter({ service: wechatLink, identity });
  const mediaRouter = media ? createPlatformMediaRouter({ owner: media, authenticate: mini.authenticate }) : null;
  const legacyRouter = express.Router();
  if (media) legacyRouter.use(createPlatformMediaRouter({ owner: media, authenticate: mini.authenticate, legacy: true }));
  // Old mutating GETs cannot enqueue query/export work without a caller key.
  legacyRouter.use('/wechat', (req, res, next) => {
    if (req.method === 'GET' && ['/query', '/admin/export'].includes(req.path) && !req.get('Idempotency-Key'))
      return res.status(409).json({ ok: false, errorCode: 'CLIENT_UPGRADE_REQUIRED' });
    next();
  });
  legacyRouter.use(createLegacyMiniProgramRouter({ adapter: { ...mini,
    command: (envelope, command, input) => mini.command(envelope, command, command === 'export' ? { ...input, kind: 'members' } : input) } }));
  const adminRouter = createPlatformAdminRouter({ getSystem: () => ({ service: platformService, runOperation: lifecycle.track }) });
  // Parse failures belong to these public API surfaces, never an HTML traceback.
  const parseError = (error, req, res, next) => sendError(res, new IdentityError('PLATFORM_INPUT_INVALID', error.status === 413 ? 413 : 422), randomUUID());
  miniRouter.use('/mini-program', parseError);
  legacyRouter.use('/wechat', (error, req, res, next) => res.status(error.status === 413 ? 413 : 422).json({ ok: false, errorCode: 'PLATFORM_INPUT_INVALID' }));
  return { viewDiscordCard: proof => lifecycle.track(() => cards.localizedView(proof)), service: platformService, adapters, mini, miniRouter, mediaRouter, legacyRouter, adminRouter, wechatLinkRouter, community,
    invalidatePlatformSessions: event => invalidator.invalidate(event),
    runOperation: lifecycle.track, start: lifecycle.start, stop: () => lifecycle.stop(() => Promise.all([forwarding.stop(), communityAvatar.stop()])),
    diagnostics: lifecycle.diagnostics, domains };
}
