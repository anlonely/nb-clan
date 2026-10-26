import crypto from 'node:crypto';
import { requestCookie } from './request-cookie.js';
import { createId, getSessionSecret, nowIso, patchStoreCache, readStore, runStoreWriteTask, updateStore } from './store.js';
import { getSqliteRecord, writeSqliteStorePatch } from './storage/repository.js';
import { sqlitePrimaryMode } from './storage/sqlite.js';

const COOKIE_NAME = 'nb_session';
const SESSION_TTL_MS = 1000 * 60 * 60 * 12;

function sign(value, secret) {
  return crypto.createHmac('sha256', secret).update(value).digest('base64url');
}

async function encodeSessionId(sessionId) {
  const secret = await getSessionSecret();
  return `${sessionId}.${sign(sessionId, secret)}`;
}

async function decodeSessionCookie(cookieValue) {
  const match = /^([A-Za-z0-9_-]{1,128})\.([A-Za-z0-9_-]{43})$/.exec(String(cookieValue || ''));
  if (!match) return '';
  const [, sessionId, signature] = match;
  const secret = await getSessionSecret();
  const expected = sign(sessionId, secret);
  if (signature.length !== expected.length) return '';
  const ok = crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected));
  return ok ? sessionId : '';
}

function secureCookieEnabled(req) {
  if (process.env.NB_COOKIE_SECURE === '1') return true;
  if (process.env.NB_COOKIE_SECURE === '0') return false;
  return Boolean(req?.secure);
}

export function setSessionCookie(res, encodedSessionId, req = null) {
  res.cookie(COOKIE_NAME, encodedSessionId, {
    httpOnly: true,
    sameSite: 'lax',
    secure: secureCookieEnabled(req),
    maxAge: SESSION_TTL_MS,
    path: '/'
  });
}

export function clearSessionCookie(res) {
  res.clearCookie(COOKIE_NAME, { path: '/' });
}

function authSessionUnavailableError(label, code, cause) {
  return Object.assign(new Error(`${label}暂不可用，请稍后重试`), {
    status: 503,
    code,
    errorKey: 'thirdPartyLoginVerifyFailed',
    skipApiErrorLog: true,
    cause
  });
}

export async function createSession(userId) {
  const createdAt = Date.now();
  const session = {
    id: createId('sess'),
    userId,
    createdAt: new Date(createdAt).toISOString(),
    expiresAt: new Date(createdAt + SESSION_TTL_MS).toISOString()
  };
  if (sqlitePrimaryMode()) {
    try {
      await runStoreWriteTask(async () => {
        const patchResult = await writeSqliteStorePatch({
          reason: 'session_create',
          upserts: { sessions: [session] },
          deleteRanges: {
            sessions: {
              field: 'expiresAt',
              to: new Date(createdAt).toISOString(),
              toInclusive: true
            }
          }
        });
        const expiredIds = patchResult?.deletedRanges?.sessions || [];
        await patchStoreCache((store) => {
          store.sessions ||= [];
          const expired = new Set(expiredIds);
          store.sessions = store.sessions.filter((item) => !expired.has(item.id) && item.id !== session.id);
          store.sessions.push(session);
        });
      });
      return encodeSessionId(session.id);
    } catch (error) {
      console.warn('[nb-clan] sqlite session create failed:', error?.message || error);
      throw authSessionUnavailableError('登录会话创建', 'auth_session_create_unavailable', error);
    }
  }
  await updateStore((store) => {
    const now = Date.now();
    store.sessions = store.sessions.filter((item) => new Date(item.expiresAt).getTime() > now);
    store.sessions.push(session);
  });
  return encodeSessionId(session.id);
}

export async function destroySession(req) {
  const sessionId = await decodeSessionCookie(requestCookie(req, COOKIE_NAME));
  if (!sessionId) return;
  if (sqlitePrimaryMode()) {
    try {
      await runStoreWriteTask(async () => {
        await writeSqliteStorePatch({
          reason: 'session_destroy',
          deletes: { sessions: [sessionId] }
        });
        await patchStoreCache((store) => {
          store.sessions ||= [];
          store.sessions = store.sessions.filter((session) => session.id !== sessionId);
        });
      });
      return;
    } catch (error) {
      console.warn('[nb-clan] sqlite session destroy failed:', error?.message || error);
      throw authSessionUnavailableError('登录会话删除', 'auth_session_destroy_unavailable', error);
    }
  }
  await updateStore((store) => {
    store.sessions = store.sessions.filter((session) => session.id !== sessionId);
  });
}

export function publicUser(user) {
  if (!user) return null;
  return {
    id: user.id,
    username: user.username,
    role: user.role,
    boundSteamId: user.boundSteamId || '',
    steamNickname: user.steamNickname || '',
    kook: user.loginProviders?.kook ? {
      id: user.loginProviders.kook.id || '',
      username: user.loginProviders.kook.username || '',
      linkedAt: user.loginProviders.kook.linkedAt || '',
      steamVerified: Boolean(user.loginProviders.kook.steamVerifiedAt && user.loginProviders.kook.verifiedSteamId === user.boundSteamId)
    } : null
  };
}

export async function attachUser(req, _res, next) {
  try {
    const sessionId = await decodeSessionCookie(requestCookie(req, COOKIE_NAME));
    if (!sessionId) return next();

    if (sqlitePrimaryMode()) {
      try {
        const session = await getSqliteRecord('sessions', sessionId);
        if (!session || new Date(session.expiresAt).getTime() <= Date.now()) return next();
        const user = await getSqliteRecord('users', session.userId);
        if (!user || user.disabled || user.status === 'disabled' || user.roleAccessLock) return next();

        req.user = user;
        req.sessionId = sessionId;
        req.requestTime = nowIso();
        next();
        return;
      } catch (error) {
        console.warn('[nb-clan] sqlite attach user failed:', error?.message || error);
        throw authSessionUnavailableError('登录会话读取', 'auth_session_read_unavailable', error);
      }
    }

    const store = await readStore();
    const session = store.sessions.find((item) => item.id === sessionId);
    if (!session || new Date(session.expiresAt).getTime() <= Date.now()) return next();
    const user = store.users.find((item) => item.id === session.userId);
    if (!user || user.disabled || user.status === 'disabled' || user.roleAccessLock) return next();

    req.user = user;
    req.sessionId = sessionId;
    req.requestTime = nowIso();
    next();
  } catch (error) {
    next(error);
  }
}

export function requireAuth(req, res, next) {
  if (!req.user) {
    res.status(401).json({ ok: false, error: '请先登录' });
    return;
  }
  next();
}

export function requireAdmin(req, res, next) {
  if (!req.user) {
    res.status(401).json({ ok: false, error: '请先登录' });
    return;
  }
  if (req.user.role !== 'admin') {
    res.status(403).json({ ok: false, error: '需要管理员权限' });
    return;
  }
  next();
}
