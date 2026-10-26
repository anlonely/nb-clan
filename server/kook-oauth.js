import { bindKookSteamAccount, readKookLoginBinding } from './kook-login-store.js';
import { verifyKookLoginRoles } from './kook-login-eligibility.js';
import { kookSteamAuthorizationUrl, verifyKookSteamIdentity } from './kook-steam-openid.js';
import crypto from 'node:crypto';
import nodeFetch from 'node-fetch';

// https://developer.kookapp.cn/doc/oauth2
// https://developer.kookapp.cn/doc/http/oauth
const COOKIE = 'nb_kook_oauth_state';
const ONBOARDING_COOKIE = 'nb_kook_onboarding';
const COOKIE_PATH = '/api/auth/kook';
const AUTH_TTL_MS = 10 * 60_000;
const HANDOFF_TTL_MS = 60_000;
const MAX_PENDING = 5000;
const digest = (value) => crypto.createHash('sha256').update(value).digest('hex');
const credentials = () => ({
  clientId: String(process.env.NB_KOOK_OAUTH_CLIENT_ID || '').trim(),
  clientSecret: String(process.env.NB_KOOK_OAUTH_CLIENT_SECRET || '').trim(),
  redirectUri: String(process.env.NB_KOOK_OAUTH_REDIRECT_URI || '').trim(),
  loginOrigin: String(process.env.NB_KOOK_OAUTH_LOGIN_ORIGIN || process.env.NB_PUBLIC_BASE_URL || '').trim()
});
function allowedUrl(value) {
  const url = new URL(value);
  if (url.username || url.password || url.hash || url.search ||
      !(url.protocol === 'https:' || (url.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(url.hostname)))) {
    throw new Error('Invalid KOOK OAuth URL');
  }
  return url;
}
function loginOrigin() {
  const config = credentials();
  const url = allowedUrl(config.loginOrigin || allowedUrl(config.redirectUri).origin);
  if (url.pathname !== '/') throw new Error('KOOK login origin must not contain a path');
  return url.origin;
}
export function kookOAuthConfigured() {
  const { clientId, clientSecret, redirectUri } = credentials();
  try {
    const callback = allowedUrl(redirectUri);
    loginOrigin();
    return Boolean(clientId && clientSecret && callback.pathname === '/api/auth/kook/callback');
  } catch { return false; }
}
export function kookOAuthEnabled(store) {
  return Boolean(store.settings?.thirdPartyLogin?.kook?.enabled ?? (process.env.NB_KOOK_OAUTH_ENABLED === '1'));
}
function cookieOptions(req) {
  return { httpOnly: true, sameSite: 'lax', path: COOKIE_PATH,
    secure: process.env.NB_COOKIE_SECURE === '1' || (process.env.NB_COOKIE_SECURE !== '0' &&
      (req.secure || loginOrigin().startsWith('https:'))) };
}
function matchesBrowserState(req, expected) {
  const cookie = String(req.headers.cookie || '').split(';').map((value) => value.trim())
    .find((value) => value.startsWith(`${COOKIE}=`));
  if (!cookie || !expected) return false;
  const actual = cookie.slice(COOKIE.length + 1);
  return /^[a-f0-9]{64}$/.test(actual) && crypto.timingSafeEqual(Buffer.from(actual), Buffer.from(expected));
}
function privateResponse(res) {
  res.set('Cache-Control', 'no-store');
  res.set('Referrer-Policy', 'no-referrer');
}
async function requestJson(url, options = {}) {
  try {
    const response = await nodeFetch(url, { ...options, redirect: 'error', signal: AbortSignal.timeout(15_000) });
    const payload = await response.json();
    if (!response.ok) throw new Error('KOOK request failed');
    return payload;
  } catch {
    // Never include upstream responses, authorization codes or tokens in logs/errors.
    throw Object.assign(new Error('KOOK OAuth verification failed'), { errorKey: 'thirdPartyLoginVerifyFailed' });
  }
}
export function registerKookOAuthRoutes(router, deps) {
  const { rateLimit, readSettingsRuntimeStore, authLanguageFromRequest, signThirdPartyAuthState,
    verifyThirdPartyAuthState, redirectAuthError,
    upsertThirdPartyMemberLogin, hashPassword, generatePassword, createSession, setSessionCookie,
    defaultJsonParser, kookApiRequest } = deps;

  // This app runs one API process. Restarts invalidate unfinished logins safely.
  // Multiple API replicas must use a shared store with atomic consume instead.
  const pending = new Map();
  const handoffs = new Map();
  const onboarding = new Map();
  function expireEntries() {
    const now = Date.now();
    for (const entries of [pending, handoffs, onboarding]) {
      for (const [key, value] of entries) if (value.expiresAt <= now) entries.delete(key);
    }
  }
  function callbackError(req, res, key, language) {
    // Never derive the return destination from callback Host or user input.
    if (!kookOAuthConfigured()) return res.status(503).send('KOOK login is not configured');
    const url = new URL('/', loginOrigin());
    url.search = new URLSearchParams({ login: '1', authError: key, authLang: language });
    res.redirect(303, url.href);
  }
  function handoff(res, stateHash, payload) {
    expireEntries();
    if (handoffs.size >= MAX_PENDING) throw new Error('KOOK login queue full');
    const ticket = crypto.randomBytes(32).toString('base64url');
    handoffs.set(digest(ticket), { ...payload, stateHash, expiresAt: Date.now() + HANDOFF_TTL_MS });
    const destination = new URL('/api/auth/kook/finish', loginOrigin());
    destination.searchParams.set('ticket', ticket);
    res.redirect(303, destination.href);
  }

  function readOnboarding(req) {
    expireEntries();
    const cookie = String(req.headers.cookie || '').split(';').map((value) => value.trim())
      .find((value) => value.startsWith(`${ONBOARDING_COOKIE}=`));
    const value = cookie?.slice(ONBOARDING_COOKIE.length + 1) || '';
    if (!/^[A-Za-z0-9_-]{43}$/.test(value)) return null;
    const key = digest(value);
    const entry = onboarding.get(key);
    return entry ? { key, entry } : null;
  }
  function onboardingUrl(language, errorKey = '') {
    const url = new URL('/', loginOrigin());
    url.search = new URLSearchParams({ login: '1', kookBind: '1', authLang: language,
      ...(errorKey ? { kookBindError: errorKey } : {}) });
    return url.href;
  }
  function loginErrorKey(error) {
    return ['kookRoleRequired', 'kookRoleCheckFailed', 'kookBindingConflict', 'kookSteamVerifyFailed', 'memberDeparted',
      'kookOnboardingExpired'].includes(error?.errorKey)
      ? error.errorKey : 'thirdPartyLoginVerifyFailed';
  }

  router.get('/auth/kook/start', rateLimit({ name: 'kook_login_start', windowMs: 60_000, max: 30 }), async (req, res, next) => {
    try {
      privateResponse(res);
      if (!kookOAuthEnabled(await readSettingsRuntimeStore())) return redirectAuthError(req, res, 'thirdPartyLoginUnavailable');
      if (!kookOAuthConfigured()) return redirectAuthError(req, res, 'kookLoginNotConfigured');
      expireEntries();
      if (pending.size >= MAX_PENDING) return res.status(503).send('Please try signing in again later');
      const { clientId, redirectUri } = credentials();
      const state = await signThirdPartyAuthState({ provider: 'kook', lang: authLanguageFromRequest(req), redirectUri, loginOrigin: loginOrigin() });
      const stateHash = digest(state);
      pending.set(stateHash, { expiresAt: Date.now() + AUTH_TTL_MS });
      res.cookie(COOKIE, stateHash, { ...cookieOptions(req), maxAge: AUTH_TTL_MS });
      const params = new URLSearchParams({ client_id: clientId, redirect_uri: redirectUri,
        response_type: 'code', scope: 'get_user_info', state });
      res.redirect(`https://www.kookapp.cn/app/oauth2/authorize?${params}`);
    } catch (error) { next(error); }
  });

  router.get('/auth/kook/callback', rateLimit({ name: 'kook_login_callback', windowMs: 60_000, max: 30 }), async (req, res) => {
    let language = authLanguageFromRequest(req);
    let stateHash = '';
    let accepted = false;
    privateResponse(res);
    try {
      const rawState = req.query?.state;
      if (typeof rawState !== 'string' || !rawState || rawState.length > 4096) {
        return callbackError(req, res, 'thirdPartyLoginInvalidCallback', language);
      }
      const state = await verifyThirdPartyAuthState(rawState);
      const { clientId, clientSecret, redirectUri } = credentials();
      if (state?.provider !== 'kook' || state.redirectUri !== redirectUri || state.loginOrigin !== loginOrigin()) {
        return callbackError(req, res, 'thirdPartyLoginInvalidCallback', language);
      }
      language = state.lang || language;
      expireEntries();
      stateHash = digest(rawState);
      if (!pending.delete(stateHash)) return callbackError(req, res, 'thirdPartyLoginInvalidCallback', language);
      // Consume before network I/O so callbacks cannot race or replay a code exchange.
      accepted = true;
      const code = req.query?.code;
      if (req.query?.error || typeof code !== 'string' || !code || code.length > 1000) {
        return handoff(res, stateHash, { language, errorKey: 'thirdPartyLoginInvalidCallback' });
      }
      if (!kookOAuthEnabled(await readSettingsRuntimeStore())) {
        return handoff(res, stateHash, { language, errorKey: 'thirdPartyLoginUnavailable' });
      }
      if (!kookOAuthConfigured()) throw new Error('KOOK configuration changed');
      const token = await requestJson('https://www.kookapp.cn/api/oauth2/token', {
        method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ grant_type: 'authorization_code', client_id: clientId,
          client_secret: clientSecret, code, redirect_uri: redirectUri }).toString()
      });
      if (typeof token.access_token !== 'string' || !token.access_token ||
          typeof token.token_type !== 'string' || token.token_type.toLowerCase() !== 'bearer') {
        throw new Error('Invalid token');
      }
      const result = await requestJson('https://www.kookapp.cn/api/v3/user/me', {
        headers: { Authorization: `Bearer ${token.access_token}` }
      });
      const profile = result.data;
      if (result.code !== 0 || typeof profile?.id !== 'string' || !profile.id || profile.id.length > 80 || profile.bot) {
        throw new Error('Invalid user');
      }
      // No account writes or session cookies on the .cn callback origin.
      handoff(res, stateHash, { language, profile: { id: profile.id, username: String(profile.username || '').slice(0, 120) } });
    } catch {
      if (accepted && handoffs.size < MAX_PENDING && kookOAuthConfigured()) {
        handoff(res, stateHash, { language, errorKey: 'thirdPartyLoginVerifyFailed' });
      } else {
        callbackError(req, res, 'thirdPartyLoginVerifyFailed', language);
      }
    }
  });

  router.get('/auth/kook/finish', rateLimit({ name: 'kook_login_finish', windowMs: 60_000, max: 30 }), async (req, res) => {
    let language = authLanguageFromRequest(req);
    privateResponse(res);
    try {
      expireEntries();
      const ticket = req.query?.ticket;
      const key = typeof ticket === 'string' && /^[A-Za-z0-9_-]{43}$/.test(ticket) ? digest(ticket) : '';
      const entry = handoffs.get(key);
      if (!entry || !matchesBrowserState(req, entry.stateHash)) {
        return callbackError(req, res, 'thirdPartyLoginInvalidCallback', language);
      }
      // Consume atomically before asynchronous writes. URL-only ticket theft is insufficient:
      // the originating browser must also present its HttpOnly cookie on the configured site origin.
      handoffs.delete(key);
      res.clearCookie(COOKIE, cookieOptions(req));
      language = entry.language;
      if (entry.errorKey) return callbackError(req, res, entry.errorKey, language);
      if (!kookOAuthConfigured() || !kookOAuthEnabled(await readSettingsRuntimeStore())) {
        return callbackError(req, res, 'thirdPartyLoginUnavailable', language);
      }
      const profile = entry.profile;
      const binding = await readKookLoginBinding(profile.id);
      await verifyKookLoginRoles(await readSettingsRuntimeStore(), profile.id, kookApiRequest);
      if (binding.verified) {
        setSessionCookie(res, await createSession(binding.userId), req);
        return res.redirect(303, `${loginOrigin()}/`);
      }
      expireEntries();
      if (onboarding.size >= MAX_PENDING) throw new Error('KOOK onboarding queue full');
      const previous = readOnboarding(req);
      if (previous) onboarding.delete(previous.key);
      const token = crypto.randomBytes(32).toString('base64url');
      onboarding.set(digest(token), { profile, language,
        csrfToken: crypto.randomBytes(32).toString('base64url'), expiresAt: Date.now() + AUTH_TTL_MS });
      res.cookie(ONBOARDING_COOKIE, token, { ...cookieOptions(req), maxAge: AUTH_TTL_MS });
      res.redirect(303, onboardingUrl(language));
    } catch (error) {
      callbackError(req, res, loginErrorKey(error), language);
    }
  });

  router.get('/auth/kook/onboarding', rateLimit({ name: 'kook_onboarding', windowMs: 60_000, max: 30 }), (req, res) => {
    privateResponse(res);
    const current = readOnboarding(req);
    if (!current) return res.status(401).json({ ok: false, error: 'kookOnboardingExpired' });
    const { entry } = current;
    res.json({ ok: true, username: entry.profile.username,
      csrfToken: entry.csrfToken, expiresAt: new Date(entry.expiresAt).toISOString() });
  });

  router.post('/auth/kook/bind/start', rateLimit({ name: 'kook_bind_start', windowMs: 60_000, max: 12 }), defaultJsonParser, async (req, res) => {
    privateResponse(res);
    const current = readOnboarding(req);
    if (!current) return res.status(401).json({ ok: false, error: 'kookOnboardingExpired' });
    const { entry } = current;
    if (req.get('origin') !== loginOrigin() || req.body?.csrfToken !== entry.csrfToken) {
      return res.status(403).json({ ok: false, error: 'thirdPartyLoginInvalidCallback' });
    }
    if (entry.busy) return res.status(409).json({ ok: false, error: 'kookBindingBusy' });
    entry.busy = true;
    try {
      if (!kookOAuthConfigured() || !kookOAuthEnabled(await readSettingsRuntimeStore())) {
        return res.status(403).json({ ok: false, error: 'thirdPartyLoginUnavailable' });
      }
      if (entry.expiresAt <= Date.now() || onboarding.get(current.key) !== entry) {
        return res.status(401).json({ ok: false, error: 'kookOnboardingExpired' });
      }
      entry.steamState = crypto.randomBytes(32).toString('base64url');
      const callback = new URL('/api/auth/kook/steam/callback', loginOrigin());
      callback.searchParams.set('state', entry.steamState);
      entry.steamReturnTo = callback.href;
      res.json({ ok: true, authorizationUrl: kookSteamAuthorizationUrl(callback.href, loginOrigin()) });
    } catch (error) {
      res.status(503).json({ ok: false, error: loginErrorKey(error) });
    } finally { entry.busy = false; }
  });

  router.get('/auth/kook/steam/callback', rateLimit({ name: 'kook_steam_callback', windowMs: 60_000, max: 20 }), async (req, res) => {
    privateResponse(res);
    const current = readOnboarding(req);
    if (!current) return callbackError(req, res, 'kookOnboardingExpired', authLanguageFromRequest(req));
    const { entry } = current;
    if (entry.busy || !entry.steamState || typeof req.query?.state !== 'string' || req.query.state !== entry.steamState) {
      return res.redirect(303, onboardingUrl(entry.language, 'kookSteamVerifyFailed'));
    }
    // A Steam assertion is bound to this browser and this one consumed attempt.
    entry.steamState = '';
    entry.busy = true;
    try {
      const steamId = await verifyKookSteamIdentity(req.query, entry.steamReturnTo);
      const store = await readSettingsRuntimeStore();
      if (!kookOAuthConfigured() || !kookOAuthEnabled(store)) {
        return callbackError(req, res, 'thirdPartyLoginUnavailable', entry.language);
      }
      const eligibility = await verifyKookLoginRoles(store, entry.profile.id, kookApiRequest);
      if (entry.expiresAt <= Date.now() || onboarding.get(current.key) !== entry) {
        return callbackError(req, res, 'kookOnboardingExpired', entry.language);
      }
      const userId = await bindKookSteamAccount(req, { profile: entry.profile, steamId, eligibility,
        passwordHash: await hashPassword(generatePassword()), upsertLogin: upsertThirdPartyMemberLogin });
      setSessionCookie(res, await createSession(userId), req);
      onboarding.delete(current.key);
      res.clearCookie(ONBOARDING_COOKIE, cookieOptions(req));
      res.redirect(303, `${loginOrigin()}/`);
    } catch (error) {
      res.redirect(303, onboardingUrl(entry.language, loginErrorKey(error)));
    } finally { entry.busy = false; }
  });

}
