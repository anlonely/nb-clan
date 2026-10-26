import express from 'express';
import { randomUUID } from 'node:crypto';
import { AuthContexts, randomToken, digest, constantEqual, safeReturnTo } from './contexts.js';
import { IdentityError, requireValue } from './errors.js';
import { authorize, can, memberDTO } from './permissions.js';
import { steamProvider } from './providers.js';

const cookies = { browser: 'nb_v2_browser', onboarding: 'nb_v2_onboarding', onboardCsrf: 'nb_v2_onboard_csrf', session: 'nb_v2_session', csrf: 'nb_v2_csrf' };
function cookie(req, name) {
  const matches = String(req.headers.cookie || '').split(';').map(part => part.trim()).filter(part => part.startsWith(`${name}=`));
  const value = matches.length === 1 ? matches[0].slice(name.length + 1) : '';
  return /^[A-Za-z0-9_-]{43}$/.test(value) ? value : '';
}

export function createIdentityRouter({ service, origin, providers, contexts = new AuthContexts(), steam = steamProvider,
  authenticatePassword, passwordProof, localMode = false, writeIdentity = fn => fn(), rateLimit = () => (_req, _res, next) => next() }) {
  const router = express.Router();
  const eventStreams = new Set(), eventJobs = new Set();
  let eventsStopped = false;
  const options = { httpOnly: true, secure: origin.startsWith('https:'), sameSite: 'lax', path: '/api/v2' };
  const setCookie = (res, name, value, maxAge = 600_000) => res.cookie(cookies[name], value, { ...options, maxAge });
  const json = (req, res, data, scopeVersion = null) => res.json({ data,
    meta: { schemaVersion: 1, requestId: req.v2RequestId, serverTime: new Date(service.now()).toISOString(), scopeVersion } });
  const wrap = fn => (req, res, next) => Promise.resolve().then(() => fn(req, res)).catch(next);
  const browser = req => cookie(req, cookies.browser);
  const readOnboard = req => {
    requireValue(browser(req), 'AUTH_CONTEXT_EXPIRED', 410);
    const token = cookie(req, cookies.onboarding);
    return { token, entry: contexts.read(token, { browser: browser(req), purpose: 'onboarding' }) };
  };
  const requireOrigin = req => requireValue(req.get('origin') === origin, 'CSRF_INVALID', 403);
  const onboardMutation = req => {
    requireOrigin(req);
    const current = readOnboard(req);
    requireValue(constantEqual(digest(req.get('x-csrf-token')), current.entry.csrfHash), 'CSRF_INVALID', 403);
    return current;
  };
  const sessionState = req => service.session(cookie(req, cookies.session));
  const sessionMutation = async req => {
    requireOrigin(req);
    const state = sessionState(req);
    requireValue(constantEqual(digest(req.get('x-csrf-token')), state.session.csrfHash), 'CSRF_INVALID');
    await service.requireFreshEligibility(state.session);
    return sessionState(req); // Recheck permission/restriction changes during network I/O.
  };
  const authenticated = async req => {
    const state = sessionState(req);
    // No protected read is served on stale platform eligibility.
    await service.requireFreshEligibility(state.session);
    return sessionState(req);
  };
  function finishSession(res, result, onboardingToken) {
    if (onboardingToken) contexts.revoke(onboardingToken);
    res.clearCookie(cookies.onboarding, options); res.clearCookie(cookies.onboardCsrf, options);
    setCookie(res, 'session', result.token, 43_200_000); setCookie(res, 'csrf', result.csrfToken, 43_200_000);
  }
  async function advance(req, res, current) {
    const { entry, token } = current;
    const known = service.knownAccount(entry.profile);
    requireValue(!known?.roleAccessLock, 'MEMBER_DEPARTED');
    const evidence = await service.checkEligibility(entry.provider, entry.profile.id, { includeCommunity: true });
    contexts.read(token, { browser: browser(req), purpose: 'onboarding' });
    entry.community = evidence.community || null;
    requireValue(!entry.accountId || !known || entry.accountId === known.id, 'IDENTITY_CONFLICT', 409);
    let result;
    try { result = await writeIdentity(() => service.login(entry.profile, evidence)); }
    catch (error) {
      if (error.errorCode === 'IDENTITY_CONFLICT') service.recordConflict(entry.provider, entry.profile.id, entry.accountId);
      throw error;
    }
    requireValue(!entry.accountId || !result.accountId || entry.accountId === result.accountId, 'IDENTITY_CONFLICT', 409);
    if (result.step === 'complete') finishSession(res, result, token);
    else Object.assign(entry, { accountId: result.accountId || entry.accountId,
      expectedRevision: result.expectedRevision ?? entry.expectedRevision, step: 'steam' });
    return result;
  }
  router.use((req, res, next) => {
    req.v2RequestId = randomUUID();
    res.set({ 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer', 'X-Content-Type-Options': 'nosniff' });
    next();
  });
  router.use((req, _res, next) => {
    // An old callback path may enter this same router through the host alias.
    // Require the selected provider's exact configured origin and path before
    // consuming state; only the later main-origin finish can set session cookies.
    const callback = /^\/auth\/(discord|kook)\/callback$/.exec(req.path);
    if (callback) {
      const expected = new URL(providers[callback[1]].redirectUri || `${origin}/api/v2/auth/${callback[1]}/callback`);
      // The existing secondary-domain reverse proxy deliberately rewrites Host
      // to the main origin. Both are fixed trusted configuration, not forwarded input.
      if (![origin, expected.origin].includes(`${req.protocol}://${req.get('host')}`) ||
          req.originalUrl.split('?')[0] !== expected.pathname) return next(new IdentityError('AUTH_ORIGIN_INVALID', 400));
      return next();
    }
    if (`${req.protocol}://${req.get('host')}` !== origin) return next(new IdentityError('AUTH_ORIGIN_INVALID', 400));
    next();
  });
  const authLimitResponse = (req, res, retryAfterSeconds) => {
    if (req.method === 'GET' && /^\/(?:steam\/login-callback|steam\/callback|(?:steam|discord|kook)\/start|(?:discord|kook)\/(?:callback|finish))$/.test(req.path))
      return res.redirect(303, `${origin}/login?error=AUTH_RATE_LIMITED&retryAfter=${retryAfterSeconds}&returnTo=${encodeURIComponent(safeReturnTo(req.query.returnTo))}`);
    return res.status(429).json({ error: {
      errorCode: 'AUTH_RATE_LIMITED', messageKey: 'AUTH_RATE_LIMITED', retryable: true, retryAfterSeconds
    } });
  };
  const ipAuthLimit = rateLimit({ name: 'v2_auth_ip', windowMs: 60_000, max: 600, onLimit: authLimitResponse });
  const guestAuthLimit = rateLimit({ name: 'v2_auth_guest', windowMs: 60_000, max: 240, onLimit: authLimitResponse });
  const browserAuthLimit = rateLimit({ name: 'v2_auth_browser', windowMs: 60_000, max: 60,
    key: req => digest(browser(req)), onLimit: authLimitResponse });
  router.use('/auth', ipAuthLimit, (req, res, next) =>
    (browser(req) ? browserAuthLimit : guestAuthLimit)(req, res, next));
  router.use(express.json({ limit: '32kb' }));
  router.get('/auth/providers', wrap(async (req, res) => json(req, res, {
    ownerPasswordLogin: Boolean(service.ownerPasswordLogin), localMode,
    providers: [{ provider: 'steam', enabled: !localMode && service.steamLoginEnabled(), configured: !localMode },
      ...['discord', 'kook'].map(provider => ({ provider, enabled: !localMode && Boolean(service.repo.all('policies').find(p => p.provider === provider)?.enabled),
        configured: providers[provider].configured() }))], wechat: { enabled: false, status: 'pending_external_acceptance' }
  })));
  router.get('/auth/:provider/start', wrap(async (req, res) => {
    const { provider } = req.params;
    requireValue(['steam', 'discord', 'kook'].includes(provider), 'LOGIN_UNAVAILABLE', 404);
    if (provider === 'steam') requireValue(service.steamLoginEnabled(), 'LOGIN_UNAVAILABLE', 503);
    else service.policy(provider);
    const binding = browser(req) || randomToken();
    let account = null;
    if (cookie(req, cookies.session)) {
      try { account = sessionState(req).actor; }
      catch (error) {
        if (!(error instanceof IdentityError) || error.status !== 401) throw error;
        res.clearCookie(cookies.session, options); res.clearCookie(cookies.csrf, options);
      }
    }
    const state = contexts.issue({ browser: binding, provider, purpose: provider === 'steam' ? 'steam-login' : 'oauth', returnTo: safeReturnTo(req.query.returnTo),
      accountId: account?.id || null, expectedRevision: account?.revision || null });
    setCookie(res, 'browser', binding);
    res.redirect(302, provider === 'steam'
      ? steam.authorizationUrl(`${origin}/api/v2/auth/steam/login-callback?state=${encodeURIComponent(state)}`, origin)
      : providers[provider].authorizationUrl(state));
  }));
  router.get('/auth/steam/login-callback', wrap(async (req, res) => {
    requireValue(browser(req), 'AUTH_INVALID_CALLBACK', 401);
    const entry = contexts.consume(req.query.state, { browser: browser(req), provider: 'steam', purpose: 'steam-login' });
    const generation = contexts.capture('steam');
    try {
      const steamId = await steam.verify(req.query, `${origin}/api/v2/auth/steam/login-callback?state=${encodeURIComponent(req.query.state)}`);
      const candidate = service.steamLoginAccount(steamId, entry);
      const providerGenerations = candidate.identities.map(i => [i.provider, contexts.capture(i.provider)]);
      const evidence = await service.steamLoginEvidence(candidate);
      const result = await writeIdentity(() => {
        contexts.assertCurrent(generation, 'steam');
        for (const [provider, current] of providerGenerations) contexts.assertCurrent(current, provider);
        requireValue(entry.expiresAt > contexts.now(), 'AUTH_CONTEXT_EXPIRED', 410);
        return service.completeSteamLogin(steamId, candidate, evidence, entry);
      });
      finishSession(res, result, cookie(req, cookies.onboarding));
      res.redirect(303, `${origin}${entry.returnTo}`);
    } catch (error) {
      const code = error instanceof IdentityError ? error.errorCode : 'AUTH_INVALID_CALLBACK';
      res.redirect(303, `${origin}/login?error=${encodeURIComponent(code)}&returnTo=${encodeURIComponent(entry.returnTo)}`);
    }
  }));
  router.get('/auth/:provider/callback', (req, _res, next) => req.params.provider === 'steam' ? next('route') : next(), wrap(async (req, res) => {
    const { provider } = req.params;
    requireValue(['discord', 'kook'].includes(provider) && typeof req.query.state === 'string' && req.query.state.length < 1000, 'AUTH_INVALID_CALLBACK', 401);
    const entry = contexts.consume(req.query.state, { provider, purpose: 'oauth' });
    const contextGeneration = contexts.capture(provider);
    let profile, errorCode, errorRetryAfterSeconds;
    if (req.query.error) errorCode = req.query.error === 'access_denied' ? 'AUTH_CANCELLED' : 'AUTH_INVALID_CALLBACK';
    else {
      requireValue(typeof req.query.code === 'string' && req.query.code.length > 0 && req.query.code.length <= 1000, 'AUTH_INVALID_CALLBACK', 401);
      try { profile = await providers[provider].exchange(req.query.code); }
      catch (error) { errorCode = error.errorCode || 'AUTH_INVALID_CALLBACK'; errorRetryAfterSeconds = error.retryAfterSeconds; }
    }
    // OAuth callback may be on KOOK's allowlisted secondary domain. No account writes or cookies here.
    contexts.assertCurrent(contextGeneration, provider);
    const ticket = contexts.issue({ ...entry, browserHash: entry.browserBindingHash, purpose: 'handoff', profile, errorCode,
      errorRetryAfterSeconds }, 60_000);
    res.redirect(303, `${origin}/api/v2/auth/${provider}/finish?ticket=${encodeURIComponent(ticket)}`);
  }));
  router.get('/auth/:provider/finish', wrap(async (req, res) => {
    requireValue(browser(req), 'AUTH_INVALID_CALLBACK', 401);
    const entry = contexts.consume(req.query.ticket, { browser: browser(req), purpose: 'handoff', provider: req.params.provider });
    if (entry.errorCode) return res.redirect(303, `${origin}/login?error=${encodeURIComponent(entry.errorCode)}${entry.errorRetryAfterSeconds ? `&retryAfter=${entry.errorRetryAfterSeconds}` : ''}&returnTo=${encodeURIComponent(entry.returnTo)}`);
    const previous = cookie(req, cookies.onboarding); if (previous) contexts.revoke(previous);
    const csrf = randomToken();
    const token = contexts.issue({ provider: entry.provider, browser: browser(req), purpose: 'onboarding', profile: entry.profile,
      accountId: entry.accountId, expectedRevision: entry.expectedRevision, returnTo: entry.returnTo, csrfHash: digest(csrf), step: 'eligibility' });
    setCookie(res, 'onboarding', token); setCookie(res, 'onboardCsrf', csrf);
    // This response sets the cookie, so the continuation is looked up directly for this one request.
    const current = { token, entry: contexts.read(token, { browser: browser(req), purpose: 'onboarding' }) };
    try {
      const result = await advance(req, res, current);
      res.redirect(303, result.step === 'complete' ? `${origin}${entry.returnTo}` : `${origin}/auth/continue?returnTo=${encodeURIComponent(entry.returnTo)}`);
    } catch (error) {
      current.entry.errorCode = error.errorCode || 'AUTH_INVALID_CALLBACK';
      current.entry.errorRetryAfterSeconds = error.retryAfterSeconds || null;
      res.redirect(303, `${origin}/auth/continue?error=${current.entry.errorCode}&returnTo=${encodeURIComponent(entry.returnTo)}`);
    }
  }));
  router.get('/auth/continue', wrap(async (req, res) => {
    const { entry } = readOnboard(req);
    json(req, res, { step: entry.step, provider: entry.provider, displayName: entry.profile.displayName,
      community: entry.community || null,
      expiresAt: new Date(entry.expiresAt).toISOString(), returnTo: entry.returnTo,
      errorCode: entry.errorCode || null, retryAfterSeconds: entry.errorRetryAfterSeconds || null,
      csrfToken: cookie(req, cookies.onboardCsrf),
      allowedActions: entry.step === 'steam' ? ['steam', 'retry', 'cancel'] : ['retry', 'cancel'] });
  }));
  router.post('/auth/eligibility/retry', wrap(async (req, res) => {
    const current = onboardMutation(req);
    const result = await advance(req, res, current);
    current.entry.errorCode = null;
    current.entry.errorRetryAfterSeconds = null;
    json(req, res, { step: result.step, returnTo: current.entry.returnTo });
  }));
  router.post('/auth/cancel', wrap(async (req, res) => {
    const { token } = onboardMutation(req); contexts.revoke(token);
    res.clearCookie(cookies.onboarding, options); res.clearCookie(cookies.onboardCsrf, options);
    json(req, res, { cancelled: true });
  }));
  router.post('/auth/steam/start', wrap(async (req, res) => {
    const { token, entry } = onboardMutation(req);
    requireValue(entry.step === 'steam', 'ELIGIBILITY_DENIED');
    if (entry.steamAttempt) contexts.entries.delete(entry.steamAttempt);
    const state = contexts.issue({ browser: browser(req), purpose: 'steam', provider: entry.provider, onboardingHash: digest(token) });
    entry.steamAttempt = digest(state);
    entry.steamReturnTo = `${origin}/api/v2/auth/steam/callback?state=${encodeURIComponent(state)}`;
    json(req, res, { authorizationUrl: steam.authorizationUrl(entry.steamReturnTo, origin) });
  }));
  // Registered after generic callback: generic route explicitly excludes steam via next('route') below.
  router.get('/auth/steam/callback', wrap(async (req, res) => {
    const { token, entry } = readOnboard(req);
    const attempt = contexts.consume(req.query.state, { browser: browser(req), purpose: 'steam', provider: entry.provider });
    requireValue(attempt.onboardingHash === digest(token), 'AUTH_INVALID_CALLBACK', 401);
    try {
      const steamId = await steam.verify(req.query, entry.steamReturnTo);
      const evidence = await service.checkEligibility(entry.provider, entry.profile.id, { includeCommunity: true });
      contexts.read(token, { browser: browser(req), purpose: 'onboarding' });
      const result = await writeIdentity(() => {
        contexts.read(token, { browser: browser(req), purpose: 'onboarding' });
        return service.bind(entry.profile, steamId, evidence, entry);
      });
      finishSession(res, result, token);
      res.redirect(303, `${origin}${entry.returnTo}`);
    } catch (error) {
      entry.errorCode = error.errorCode || 'AUTH_INVALID_CALLBACK';
      entry.errorRetryAfterSeconds = error.retryAfterSeconds || null;
      res.redirect(303, `${origin}/auth/continue?error=${entry.errorCode}&returnTo=${encodeURIComponent(entry.returnTo)}`);
    }
  }));
  router.post('/auth/owner-password', rateLimit({ name: 'v2_owner_password', windowMs: 60_000, max: 12 }), wrap(async (req, res) => {
    requireOrigin(req);
    requireValue(service.ownerPasswordLogin && passwordProof, 'OWNER_PASSWORD_LOGIN_DISABLED', 403);
    requireValue(req.body?.username === 'root', 'AUTH_INVALID_CREDENTIALS', 401);
    const proof = await passwordProof.authenticate(req.body.username, req.body.password);
    const result = await writeIdentity(() => service.repo.transaction(() => {
      const account = passwordProof.consume(proof);
      requireValue(account.id === 'user_root' && service.actorForAccount(account.id).roleId === 'owner', 'AUTH_INVALID_CREDENTIALS', 401);
      return service.issueSession(account, { provider: 'owner_password' });
    }));
    finishSession(res, result);
    json(req, res, { accountId: result.accountId, csrfToken: result.csrfToken });
  }));
  router.post('/auth/password', rateLimit({ name: 'v2_password', windowMs: 60_000, max: 12 }), wrap(async (req, res) => {
    requireOrigin(req);
    throw new IdentityError('PLATFORM_LOGIN_REQUIRED', 403);
  }));
  router.post('/auth/close-account', wrap(async (req, res) => {
    const { actor } = await sessionMutation(req);
    requireValue(req.body?.confirmation === 'LEAVE', 'CONFIRMATION_REQUIRED', 422);
    const result = await writeIdentity(() => service.closeAccount(actor));
    res.clearCookie(cookies.session, options); res.clearCookie(cookies.csrf, options);
    json(req, res, result);
  }));
  router.get('/auth/me', wrap(async (req, res) => {
    const { actor } = await authenticated(req);
    json(req, res, { accountId: actor.id, memberId: actor.memberId, roleId: actor.roleId, grants: actor.grants,
      membershipStatus: actor.memberStatus || null, csrfToken: cookie(req, cookies.csrf) }, actor.permissionVersion);
  }));
  router.post('/auth/logout', wrap(async (req, res) => {
    requireOrigin(req);
    const session = service.repo.get('sessions', digest(cookie(req, cookies.session)));
    if (session) requireValue(digest(req.get('x-csrf-token')) === session.csrfHash, 'CSRF_INVALID');
    service.logout(cookie(req, cookies.session));
    res.clearCookie(cookies.session, options); res.clearCookie(cookies.csrf, options);
    json(req, res, { loggedOut: true, clearClientCache: true });
  }));
  router.get('/members', wrap(async (req, res) => {
    const { actor } = await authenticated(req);
    const members = service.listMembers(actor, req.query.q);
    const offset = Math.max(0, Number.parseInt(req.query.offset, 10) || 0);
    const limit = Math.min(100, Math.max(1, Number.parseInt(req.query.limit, 10) || 50));
    json(req, res, { members: members.slice(offset, offset + limit), total: members.length }, actor.permissionVersion);
  }));
  router.get('/members/export', wrap(async (req, res) => {
    const { actor } = await authenticated(req);
    // Member export has the same scope and field projection as search/list.
    json(req, res, { members: service.listMembers(actor, req.query.q) }, actor.permissionVersion);
  }));
  const identityEvents = includeMembers => (req, res, next) => {
    // The initial authorization can outlive a disconnected socket. Track it
    // before yielding so shutdown cannot close SQLite while it refreshes roles.
    const handshake = (async () => {
    const { actor } = await authenticated(req);
    if (res.destroyed || res.writableEnded) return;
    requireValue(!eventsStopped, 'IDENTITY_UNAVAILABLE', 503);
    res.status(200).set({ 'Content-Type': 'text/event-stream', 'Connection': 'keep-alive', 'X-Accel-Buffering': 'no' });
    res.flushHeaders();
    const send = (event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    if (includeMembers) send('members', { members: service.listMembers(actor), scopeVersion: actor.permissionVersion });
    else send('ready', { scopeVersion: actor.permissionVersion });
    const unsubscribe = service.subscribe(event => {
      if (event.accountId === actor.id && !res.writableEnded) {
        send('authorization-revoked', { reason: event.reason, clearClientCache: true }); res.end();
      }
    });
    let timer;
    const close = () => { clearTimeout(timer); unsubscribe(); eventStreams.delete(close); if (!res.writableEnded) res.end(); };
    eventStreams.add(close);
    const schedule = () => {
      if (res.writableEnded || eventsStopped) return;
      const session = service.repo.get('sessions', digest(cookie(req, cookies.session)));
      const eligibility = session?.eligibilityId && service.repo.get('eligibility', session.eligibilityId);
      const delay = eligibility ? Math.min(30_000, Math.max(1, Date.parse(eligibility.expiresAt) - service.now())) : 30_000;
      timer = setTimeout(() => {
        const job = (async () => {
          try { await authenticated(req); if (!res.writableEnded && !eventsStopped) send('heartbeat', { scopeVersion: actor.permissionVersion }); }
          catch { if (!res.writableEnded) { send('authorization-revoked', { clearClientCache: true }); res.end(); } }
          finally { schedule(); }
        })();
        eventJobs.add(job);
        job.finally(() => eventJobs.delete(job)).catch(() => {});
      }, delay);
      timer.unref();
    };
    schedule();
    res.on('close', close);
    })();
    eventJobs.add(handshake);
    handshake.then(() => eventJobs.delete(handshake), error => { eventJobs.delete(handshake); next(error); });
  };
  router.get('/auth/events', identityEvents(false));
  router.get('/members/events', identityEvents(true));
  router.get('/members/:id', wrap(async (req, res) => {
    const { actor } = await authenticated(req);
    authorize(actor, 'members.read', { kind: 'member', id: req.params.id }, service.relations(), true);
    const member = service.repo.get('members', req.params.id);
    requireValue(member, 'RESOURCE_NOT_FOUND', 404);
    json(req, res, memberDTO(member), actor.permissionVersion);
  }));
  router.get('/identity/conflicts', wrap(async (req, res) => {
    const { actor } = await authenticated(req);
    authorize(actor, 'system.permissions', { kind: 'account', id: actor.id }, service.relations());
    json(req, res, { conflicts: service.repo.all('conflicts') }, actor.permissionVersion);
  }));
  router.get('/identity/legacy-discord-applications', wrap(async (req, res) => {
    const { actor } = await authenticated(req);
    authorize(actor, 'system.accounts', { kind: 'account', id: actor.id }, service.relations());
    const applications = service.repo.all('applications').map(a => ({ id: a.id, status: a.status, memberId: a.memberId || null,
      displayName: a.displayName || a.discordUsername || '', steamId: a.steamId || '', createdAt: a.createdAt || null,
      reviewedAt: a.reviewedAt || null, historicalPending: ['pending', 'need_more'].includes(a.status) }));
    json(req, res, { mode: 'legacy_readonly', applications }, actor.permissionVersion);
  }));
  router.put('/identity/accounts/:id', wrap(async (req, res) => {
    const { actor } = await sessionMutation(req);
    const result = service.changeAccount(actor, req.params.id, req.body);
    json(req, res, { accountId: result.id, revision: result.revision, permissionVersion: result.permissionVersion });
  }));
  router.put('/identity/restrictions', wrap(async (req, res) => {
    const { actor } = await sessionMutation(req);
    json(req, res, service.saveRestriction(actor, req.body), actor.permissionVersion);
  }));
  router.get('/identity/policies', wrap(async (req, res) => {
    const { actor } = await authenticated(req);
    const policies = service.repo.all('policies').filter(p => can(actor, 'platforms.configure', { kind: 'platformTarget', id: p.provider }, service.relations()));
    requireValue(policies.length, 'ACCESS_DENIED');
    json(req, res, { policies }, actor.permissionVersion);
  }));
  router.put('/identity/policies', wrap(async (req, res) => {
    const { actor } = await sessionMutation(req);
    json(req, res, service.savePolicy(actor, req.body), actor.permissionVersion);
  }));
  router.get('/identity/events', wrap(async (req, res) => {
    const { actor } = await authenticated(req);
    // JSON event polling for the G03 foundation; immediate server invalidation is independent of clients.
    json(req, res, { events: service.repo.all('events').filter(e => e.accountId === actor.id) }, actor.permissionVersion);
  }));
  router.use((error, req, res, _next) => {
    const known = error instanceof IdentityError;
    if (known && error.retryAfterSeconds) res.set('Retry-After', String(error.retryAfterSeconds));
    res.status(known ? error.status : 503).json({ error: { errorCode: known ? error.errorCode : 'IDENTITY_UNAVAILABLE',
      messageKey: known ? error.errorCode : 'IDENTITY_UNAVAILABLE', fieldErrors: {}, requestId: req.v2RequestId,
      operationId: null, retryable: known ? error.retryable : true, current: null,
      ...(known && error.retryAfterSeconds ? { retryAfterSeconds: error.retryAfterSeconds } : {}) } });
  });
  router.authenticate = ({ mutation = false } = {}) => mutation ? sessionMutation : authenticated;
  router.stopEvents = async () => {
    eventsStopped = true;
    for (const close of [...eventStreams]) close();
    await Promise.allSettled([...eventJobs]);
  };
  return router;
}
