import { createHash } from 'node:crypto';
import { lookup } from 'node:dns/promises';
import { IdentityError } from '../identity/errors.js';
import { PlatformAdminService } from '../platform-admin/service.js';
import { createPinnedMediaFetch, nodePinnedMediaRequest } from '../platform-media/network.js';

const need = (condition, code, status = 503) => { if (!condition) throw new IdentityError(code, status); };
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const appIdentifier = value => typeof value === 'string' && /^[A-Za-z0-9_-]{1,160}$/.test(value);
const secretValue = (identity, env) => identity.repo.scalar('settings')?.wechat?.appSecret || env.NB_WECHAT_SECRET || env.NB_WECHAT_APP_SECRET || '';
const validSecret = secret => typeof secret === 'string' && secret.length > 0 && secret.length <= 256 && !/[\x00-\x20\x7f]/.test(secret);
export const productionWechatSecretStatus = ({ identity, env = process.env }) => ({ appSecret: validSecret(secretValue(identity, env)) });

async function readJson(response) {
  const reader = response.body?.getReader();
  need(reader, 'WECHAT_CODE_EXCHANGE_FAILED', 502);
  const chunks = []; let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read(); if (done) break;
      size += value.byteLength;
      need(size <= 16384, 'WECHAT_CODE_EXCHANGE_FAILED', 502);
      chunks.push(Buffer.from(value));
    }
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
}

/** Pins the configured mini app for this runtime. Credentials are read only at
 * exchange time; enabling the same app is live, replacing/adding its ID needs a
 * restart. This port never accepts development identities or retains session_key. */
export function createProductionWechat({ identity, env = process.env, fetchImpl, timeoutMs = 5000 }) {
  need(identity?.repo?.db && typeof fetchImpl === 'function', 'PRODUCTION_WECHAT_HOST_REQUIRED');
  need(Number.isSafeInteger(timeoutMs) && timeoutMs >= 10 && timeoutMs <= 30000, 'PRODUCTION_WECHAT_TIMEOUT_INVALID');
  const service = new PlatformAdminService({ identity }), initial = service.config('wechat');
  if (!appIdentifier(initial.appId) || !Number.isSafeInteger(initial.revision) || initial.revision < 1) {
    return { miniOptions: undefined, mediaOptions: undefined };
  }
  const appId = initial.appId;
  function credentials() {
    const current = service.config('wechat');
    need(current.appId === appId, 'PRODUCTION_WECHAT_APP_CHANGED');
    need(current.enabled === true && current.revision > 0, 'MINI_PROGRAM_NOT_CONFIGURED');
    const configuredApp = String(env.NB_WECHAT_APPID || '').trim();
    need(!configuredApp || configuredApp === appId, 'PRODUCTION_WECHAT_APP_MISMATCH');
    const secret = secretValue(identity, env);
    need(validSecret(secret), 'PRODUCTION_WECHAT_SECRET_REQUIRED');
    return { secret, revision: current.revision };
  }
  async function exchangeCode({ appId: requestedApp, code, signal, assertCurrent }) {
    need(requestedApp === appId && typeof code === 'string' && code.length > 0 && code.length <= 256 && typeof assertCurrent === 'function', 'MINI_AUTH_INVALID', 401);
    assertCurrent(); const captured = credentials(), fingerprint = hash(captured);
    const controller = new AbortController();
    const abort = () => controller.abort();
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) controller.abort();
    let timer;
    const cancelled = new Promise((_, reject) => {
      controller.signal.addEventListener('abort', () => reject(new IdentityError('WECHAT_CODE_EXCHANGE_CANCELLED', 503)), { once: true });
      if (controller.signal.aborted) reject(new IdentityError('WECHAT_CODE_EXCHANGE_CANCELLED', 503));
      timer = setTimeout(abort, timeoutMs);
    });
    const check = () => {
      assertCurrent(); need(!controller.signal.aborted, 'WECHAT_CODE_EXCHANGE_CANCELLED');
      need(hash(credentials()) === fingerprint, 'PRODUCTION_WECHAT_CREDENTIALS_CHANGED');
    };
    try {
      return await Promise.race([cancelled, (async () => {
        check();
        const url = new URL('https://api.weixin.qq.com/sns/jscode2session');
        url.search = new URLSearchParams({ appid: appId, secret: captured.secret, js_code: code, grant_type: 'authorization_code' }).toString();
        const response = await fetchImpl(url.href, { method: 'GET', redirect: 'error', signal: controller.signal, headers: { Accept: 'application/json' } });
        check(); need(response.ok && !response.redirected, 'WECHAT_CODE_EXCHANGE_FAILED', 502);
        const payload = await readJson(response); check();
        need(payload && typeof payload === 'object' && !Array.isArray(payload), 'WECHAT_CODE_EXCHANGE_FAILED', 502);
        if (payload.errcode) {
          const invalidCode = [40029, 40163].includes(Number(payload.errcode));
          need(false, invalidCode ? 'MINI_AUTH_INVALID' : 'WECHAT_CODE_EXCHANGE_FAILED', invalidCode ? 401 : 502);
        }
        need(typeof payload.openid === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(payload.openid), 'MINI_AUTH_INVALID', 401);
        return { appId, openid: payload.openid, verified: true };
      })()]);
    } catch (error) {
      controller.abort();
      if (error instanceof IdentityError) throw error;
      throw new IdentityError('WECHAT_CODE_EXCHANGE_FAILED', 502);
    } finally { clearTimeout(timer); signal?.removeEventListener('abort', abort); }
  }
  // This is the AppID used by the original environment-configured login. It
  // scopes only unlinked legacy guest profiles, never an identity proof.
  return { miniOptions: { appId, legacyAppId: String(env.NB_WECHAT_APPID || '').trim(), exchangeCode,
    fetchCommunityAvatar: createPinnedMediaFetch({ lookup, request: nodePinnedMediaRequest }) }, mediaOptions: { appId } };
}
